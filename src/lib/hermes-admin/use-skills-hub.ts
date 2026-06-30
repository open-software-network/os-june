/**
 * The data hook behind June's native Skills Hub browser (spec 06). It owns the
 * search / inspect / install lifecycle for one {@link HermesAdminTarget}, driving
 * the SAME foundation primitives every admin surface shares:
 *
 * - {@link HermesAdminClient} `skills.hubSearch()` / `skills.hubInstall()` /
 *   `pollAction()` for I/O — never a raw `fetch`;
 * - {@link AdminStateCache} as the invalidation bus: a successful install marks
 *   `skills` (and `hubSearch` + `toolsets`) stale so the Installed Skills page
 *   refreshes itself, and raises the durable "applies next session" notification;
 * - {@link GatewayLifecycle} for the honest apply-timing banner (a hub install is
 *   `next-session`, never "applied now").
 *
 * Install is a BACKGROUND action: `hubInstall` returns an action handle, which
 * the controller polls to a terminal state, surfacing live progress and (on
 * failure) the safe error inline. On success the cache invalidation refreshes the
 * Installed Skills inventory. This is the same pattern the gateway-restart driver
 * uses, reused here so a hub install behaves identically to every other
 * backgrounded admin action.
 *
 * It is split from the React component so the search / install / progress /
 * failure behavior is unit-testable against the fake Hermes server with no
 * rendering. Profile targeting is explicit: the controller is built from ONE
 * target's engine, so an install can only ever hit the runtime that target names.
 *
 * NOTE: the per-skill SECURITY REVIEW gate (spec 07) is intentionally NOT
 * implemented here. The controller exposes a `requireConfirm` install hook the
 * security flow slots into; today it is used only for the direct-URL confirmation
 * the spec's test plan calls for. Scope here is browse / search / inspect /
 * install mechanics.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { hermesBridgeStatus, type HermesBridgeStatus } from "../tauri";
import { AdminStateCache, type AdminNotification } from "./cache";
import { createHermesAdminClient, type HermesAdminClient } from "./client";
import { HermesAdminError } from "./errors";
import { createRustAdminFetch } from "./rust-transport";
import {
  GatewayLifecycle,
  type GatewayLifecycleSnapshot,
} from "./gateway-lifecycle";
import type { HermesActionStatus, HermesHubSkillResult } from "./schemas";
import {
  adminTargetForMode,
  type HermesAdminMode,
  type HermesAdminTarget,
} from "./target";

/** The wired-up foundation primitives one Skills Hub page operates on, all bound
 * to the SAME target. Production builds this from a bridge connection (see
 * {@link useSkillsHubEngine}); tests build it from the fake-server harness. */
export type SkillsHubEngine = {
  target: HermesAdminTarget;
  client: HermesAdminClient;
  cache: AdminStateCache;
  lifecycle: GatewayLifecycle;
};

/** Search availability/loading status, distinct so the UI can render the right
 * surface: a missing runtime ("unavailable") is NOT an error and NOT empty, and
 * an "idle" page (no search run yet) is distinct from an empty result set. */
export type HubSearchStatus =
  | "unavailable" // no live Hermes runtime in the requested mode
  | "idle" // no search run yet
  | "searching" // a search is in flight
  | "ready" // results loaded (possibly empty)
  | "error"; // the search failed; a retry is offered

/** Per-skill install progress. `idle` is the default; `installing` carries live
 * progress; `done` / `failed` are terminal until the next install attempt. */
export type HubInstallPhase = "idle" | "installing" | "done" | "failed";

/** The live install state for one identifier. */
export type HubInstallState = {
  identifier: string;
  phase: HubInstallPhase;
  /** 0-100 progress while installing, when Hermes reports it. */
  progress?: number;
  /** A safe status/log message from the action, when present. */
  message?: string;
  /** A safe error message when `phase === "failed"`. */
  error?: string;
};

/** The outcome a {@link HubInstallRequest.confirm} hook resolves to. A bare
 * boolean is still accepted (true proceeds, false declines); a richer object
 * lets the spec-07 security review say "proceed, and send force" after the user
 * confirmed an override. `force` is NEVER assumed: it is sent only when the
 * decision explicitly sets it true. */
export type HubInstallDecision =
  | boolean
  | { proceed: boolean; force?: boolean };

/** Options for an install request. The `confirm` hook is where the spec-07
 * security review plugs in: install is declined if it resolves to a falsy
 * decision, and `force` is sent only when the decision explicitly asks for it. */
export type HubInstallRequest = {
  /** Asked before installing; resolve a {@link HubInstallDecision}. The security
   * review flow returns `{ proceed, force }`; a simple confirmation can return a
   * bare boolean. */
  confirm?: (
    result: HermesHubSkillResult,
  ) => HubInstallDecision | Promise<HubInstallDecision>;
};

/** Normalizes a {@link HubInstallDecision} to `{ proceed, force }`. A bare
 * boolean never forces. */
function normalizeDecision(decision: HubInstallDecision): {
  proceed: boolean;
  force: boolean;
} {
  if (typeof decision === "boolean") return { proceed: decision, force: false };
  return { proceed: decision.proceed, force: decision.force === true };
}

/** Everything the Skills Hub component renders, plus the actions it invokes. A
 * pure projection of the controller's internal state. */
export type SkillsHubState = {
  status: HubSearchStatus;
  /** The current query the controller searched (echoed for the input). */
  query: string;
  /** The raw upstream source filter passed to Hermes, if any. */
  source?: string;
  /** The results from the last successful search. */
  results: HermesHubSkillResult[];
  /** The target's mode, so the page can show June's sandbox/full-mode context. */
  mode?: HermesAdminMode;
  /** The profile this page is bound to, surfaced for explicit targeting. */
  profile?: string;
  /** The user-safe message when `status === "error"`. */
  error?: string;
  /** True when the failing search is worth retrying (network/5xx/timeout). */
  retryable: boolean;
  /** Per-identifier install state, for progress + inline failure. */
  installs: ReadonlyMap<string, HubInstallState>;
  /** The gateway lifecycle banner snapshot (apply-timing). */
  lifecycle: GatewayLifecycleSnapshot;
  /** Durable admin notifications ("Installed X. New sessions can use it."). */
  notifications: readonly AdminNotification[];
  /** Runs a hub search. An empty/whitespace query lists everything. */
  search: (query: string, source?: string) => void;
  /** Re-runs the last search. */
  refresh: () => void;
  /** Installs a skill by identifier (a background action): polls to completion,
   * surfaces progress, and on success refreshes the installed inventory. */
  install: (result: HermesHubSkillResult, request?: HubInstallRequest) => void;
  /** Clears a terminal (done/failed) install state for an identifier. */
  clearInstall: (identifier: string) => void;
  /** Dismisses a durable notification by id. */
  dismissNotification: (id: string) => void;
};

/** Test-only knobs for the install poll loop, so suites drive a backgrounded
 * install without real timers. Production constructs the controller with no
 * options and the poll uses real timers. */
export type SkillsHubControllerOptions = {
  /** Poll interval forwarded to `pollAction`. */
  pollIntervalMs?: number;
  /** Overall poll timeout forwarded to `pollAction`. */
  pollTimeoutMs?: number;
  /** Injectable sleep for the poll loop (tests pass an instant resolver). */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The framework-free controller the hook wraps. Holds the mutable search /
 * install state for one engine and notifies a single subscriber (the hook) on
 * change. Extracted so the install/poll/refresh rules can be tested without
 * React; the hook is a thin binding over it.
 */
export class SkillsHubController {
  private readonly engine: SkillsHubEngine;
  private readonly pollOptions: SkillsHubControllerOptions;
  private results: HermesHubSkillResult[] = [];
  private status: HubSearchStatus = "idle";
  private query = "";
  private source?: string;
  private error?: string;
  private retryable = false;
  private readonly installs = new Map<string, HubInstallState>();
  private notifications: readonly AdminNotification[] = [];
  private lifecycleSnapshot: GatewayLifecycleSnapshot;
  private listeners = new Set<() => void>();
  private disposed = false;
  /** Bumped on every search request so a stale resolve cannot overwrite newer
   * results (the same guard pattern the installed-skills controller uses). */
  private searchSeq = 0;
  /** AbortControllers per in-flight install poll, so dispose cancels them. */
  private readonly installAborts = new Map<string, AbortController>();
  private unsubscribers: Array<() => void> = [];
  private snapshot: SkillsHubState;

  constructor(
    engine: SkillsHubEngine,
    options: SkillsHubControllerOptions = {},
  ) {
    this.engine = engine;
    this.pollOptions = options;
    this.lifecycleSnapshot = engine.lifecycle.getSnapshot();
    this.notifications = engine.cache.getNotifications();
    this.snapshot = this.buildSnapshot();

    this.unsubscribers.push(
      engine.cache.subscribeNotifications((next) => {
        this.notifications = next;
        this.recompute();
      }),
    );
    this.unsubscribers.push(
      engine.lifecycle.subscribe((next) => {
        this.lifecycleSnapshot = next;
        this.recompute();
      }),
    );
  }

  /** The current immutable snapshot the hook hands to React. */
  getSnapshot(): SkillsHubState {
    return this.snapshot;
  }

  /** Subscribes to state changes. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Tears down subscriptions, aborts in-flight install polls, and blocks
   * further state writes. Idempotent. */
  dispose(): void {
    this.disposed = true;
    this.searchSeq += 1; // invalidate any in-flight search
    for (const controller of this.installAborts.values()) controller.abort();
    this.installAborts.clear();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.listeners.clear();
  }

  /** Runs a hub search. An empty/whitespace query lists everything Hermes
   * returns for the (optional) source. */
  async search(query: string, source?: string): Promise<void> {
    const seq = ++this.searchSeq;
    this.query = query;
    this.source = source?.trim() || undefined;
    this.status = "searching";
    this.error = undefined;
    this.recompute();

    try {
      const results = await this.engine.client.skills.hubSearch(
        query.trim(),
        this.source,
      );
      if (this.disposed || seq !== this.searchSeq) return;
      this.engine.cache.set("hubSearch", results);
      this.results = results;
      this.status = "ready";
      this.error = undefined;
      this.retryable = false;
      this.recompute();
    } catch (error) {
      if (this.disposed || seq !== this.searchSeq) return;
      const adminError = HermesAdminError.from(
        "GET /api/skills/hub/search",
        error,
      );
      this.error = adminError.safeMessage;
      this.retryable = adminError.retryable;
      this.status = "error";
      this.recompute();
    }
  }

  /** Re-runs the last search (same query + source). */
  refresh(): void {
    void this.search(this.query, this.source);
  }

  /**
   * Installs a skill by identifier. This is a BACKGROUND action: it calls
   * `hubInstall`, then polls the returned action to a terminal state, surfacing
   * live progress. On success it applies the cache invalidation + the durable
   * "applies next session" notification and advances the lifecycle banner (so the
   * Installed Skills page refreshes itself), and marks the result installed
   * locally. On failure the safe error is surfaced inline. Never throws.
   *
   * If the install completes synchronously (no action handle), it is treated as
   * an immediate success.
   */
  async install(
    result: HermesHubSkillResult,
    request: HubInstallRequest = {},
  ): Promise<void> {
    const { identifier } = result;
    // Never re-enter an install that is already running for this identifier.
    if (this.installs.get(identifier)?.phase === "installing") return;

    // `force` is false unless the confirmation explicitly returns it (the
    // security review's override path). It can never default to true.
    let force = false;
    if (request.confirm) {
      const decision = normalizeDecision(await request.confirm(result));
      if (this.disposed) return;
      if (!decision.proceed) {
        // A declined confirmation is a no-op: leave the row idle, no error.
        this.setInstall(identifier, { phase: "idle" });
        return;
      }
      force = decision.force;
    }

    this.setInstall(identifier, { phase: "installing", progress: undefined });

    try {
      const outcome = await this.engine.client.skills.hubInstall(
        identifier,
        force ? { force: true } : undefined,
      );
      if (this.disposed) return;
      const action = outcome.action;

      let status: HermesActionStatus | undefined = outcome.result;
      if (action && !(status?.done ?? false)) {
        const abort = new AbortController();
        this.installAborts.set(identifier, abort);
        try {
          status = await this.engine.client.pollAction(action, {
            signal: abort.signal,
            intervalMs: this.pollOptions.pollIntervalMs,
            timeoutMs: this.pollOptions.pollTimeoutMs,
            sleep: this.pollOptions.sleep,
            onStatus: (latest) =>
              this.setInstall(identifier, {
                phase: "installing",
                progress: latest.progress,
                message: latest.message,
              }),
          });
        } finally {
          this.installAborts.delete(identifier);
        }
        if (this.disposed) return;
      }

      if (status && status.state === "failed") {
        // Reconcile the failure into the cache (raises an error notification)
        // and surface it inline on the row.
        this.engine.cache.afterAction(
          "skill.hubInstall",
          friendlyName(result),
          status,
        );
        this.setInstall(identifier, {
          phase: "failed",
          error: status.error ?? `Could not install ${friendlyName(result)}.`,
        });
        return;
      }

      // Success (backgrounded-then-done, or synchronous). Invalidate the
      // installed inventory + hub search + toolsets, raise the durable
      // "applies next session" notification, and advance the shared banner.
      this.engine.cache.afterMutation("skill.hubInstall", friendlyName(result));
      this.engine.lifecycle.noteMutation(outcome.mutation);
      this.markInstalledLocally(identifier);
      this.setInstall(identifier, {
        phase: "done",
        progress: 100,
        message: status?.message,
      });
    } catch (error) {
      if (this.disposed) return;
      const adminError = HermesAdminError.from(
        "POST /api/skills/hub/install",
        error,
      );
      // A poll timeout on an install almost always means the source is slow or
      // rate-limited (commonly GitHub's 60/hr unauthenticated cap), not that
      // Hermes is down. The sandboxed runtime can't read your gh-keyring login
      // (keychain reads are blocked) and the spawn env is scrubbed, so the fix
      // is an explicit GITHUB_TOKEN configured in June — not `gh auth login`.
      const message =
        adminError.kind === "timeout"
          ? "Install timed out. The skill source may be slow or rate-limited. GitHub-hosted skills need a GITHUB_TOKEN configured in June's settings (Team skill taps) to lift the 60/hr limit, then try again."
          : adminError.safeMessage;
      this.setInstall(identifier, {
        phase: "failed",
        error: message,
      });
    }
  }

  /** Clears a terminal install state so the row returns to its default action. */
  clearInstall(identifier: string): void {
    if (this.installs.delete(identifier)) this.recompute();
  }

  /** Dismisses a durable notification. */
  dismissNotification(id: string): void {
    this.engine.cache.dismissNotification(id);
  }

  /** Flips the local `installed` flag on a result so the card reflects the new
   * state immediately, without waiting for a re-search. */
  private markInstalledLocally(identifier: string): void {
    this.results = this.results.map((result) =>
      result.identifier === identifier
        ? { ...result, installed: true, updateAvailable: false }
        : result,
    );
  }

  private setInstall(
    identifier: string,
    next: Omit<HubInstallState, "identifier">,
  ): void {
    this.installs.set(identifier, { identifier, ...next });
    this.recompute();
  }

  private buildSnapshot(): SkillsHubState {
    return {
      status: this.status,
      query: this.query,
      source: this.source,
      results: this.results,
      mode: this.engine.target.mode,
      profile: this.engine.target.profile,
      error: this.error,
      retryable: this.retryable,
      installs: new Map(this.installs),
      lifecycle: this.lifecycleSnapshot,
      notifications: this.notifications,
      search: this.searchAction,
      refresh: this.refreshAction,
      install: this.installAction,
      clearInstall: this.clearInstallAction,
      dismissNotification: this.dismissNotificationAction,
    };
  }

  private recompute(): void {
    if (this.disposed) return;
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) listener();
  }

  // Stable action identities so the snapshot's callbacks don't churn referential
  // equality on every recompute.
  private readonly searchAction = (query: string, source?: string): void => {
    void this.search(query, source);
  };
  private readonly refreshAction = (): void => {
    this.refresh();
  };
  private readonly installAction = (
    result: HermesHubSkillResult,
    request?: HubInstallRequest,
  ): void => {
    void this.install(result, request);
  };
  private readonly clearInstallAction = (identifier: string): void => {
    this.clearInstall(identifier);
  };
  private readonly dismissNotificationAction = (id: string): void => {
    this.dismissNotification(id);
  };
}

/** A human label for a result, used in notifications. */
function friendlyName(result: HermesHubSkillResult): string {
  return result.name || result.identifier;
}

/**
 * Binds a {@link SkillsHubController} to React for one engine. A null engine
 * yields the "unavailable" state without constructing a controller.
 */
export function useSkillsHubController(
  engine: SkillsHubEngine | null,
): SkillsHubState {
  const controller = useMemo(
    () => (engine ? new SkillsHubController(engine) : null),
    [engine],
  );

  const [snapshot, setSnapshot] = useState<SkillsHubState>(() =>
    controller ? controller.getSnapshot() : UNAVAILABLE_STATE,
  );

  useEffect(() => {
    if (!controller) {
      setSnapshot(UNAVAILABLE_STATE);
      return;
    }
    setSnapshot(controller.getSnapshot());
    const unsubscribe = controller.subscribe(() => {
      setSnapshot(controller.getSnapshot());
    });
    // Prime the snapshot to a ready (empty) state on mount. The hub is
    // search-only: Hermes returns nothing for an empty query, so this just
    // settles the status off "loading" and the view shows the search prompt.
    void controller.search("");
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  return snapshot;
}

/** The frozen state shown when there is no runtime to talk to. */
const UNAVAILABLE_STATE: SkillsHubState = Object.freeze({
  status: "unavailable",
  query: "",
  results: [],
  retryable: false,
  installs: new Map<string, HubInstallState>(),
  lifecycle: {
    state: "clean",
    label: "Up to date",
    detail: "No pending changes.",
    canRestart: false,
  },
  notifications: [],
  search: () => {},
  refresh: () => {},
  install: () => {},
  clearInstall: () => {},
  dismissNotification: () => {},
}) as SkillsHubState;

/**
 * Production helper: derives the {@link SkillsHubEngine} from a live bridge
 * status for a chosen mode, returning null when that mode is not running. Built
 * with `useMemo` keyed on the selected connection's identity so a status refresh
 * that does not change the connection does not rebuild the client/cache. Profile
 * selection is explicit via {@link adminTargetForMode}.
 */
export function useSkillsHubEngine(
  bridge: HermesBridgeStatus | undefined,
  mode: HermesAdminMode,
  profile?: string,
): SkillsHubEngine | null {
  const target = useMemo(
    () => (bridge ? adminTargetForMode(bridge, mode, profile) : undefined),
    [bridge, mode, profile],
  );
  const identity = target
    ? `${target.mode}:${target.profile}:${target.baseUrl}:${target.token}`
    : null;

  return useMemo(() => {
    if (!target) return null;
    // Production routes admin I/O through Rust (`hermes_admin_request`) rather
    // than a webview fetch the cross-origin dashboard would CORS-fail. Bound to
    // this target's mode so Rust targets the chosen runtime, never the first.
    const client = createHermesAdminClient(target, {
      fetch: createRustAdminFetch(target.mode),
    });
    const cache = new AdminStateCache(target);
    const lifecycle = new GatewayLifecycle(client, cache);
    return { target, client, cache, lifecycle };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by identity
  }, [identity]);
}

/**
 * The all-in-one production hook: fetch bridge status once, derive the engine for
 * the given mode, and run the controller. The page calls THIS; tests prefer
 * {@link useSkillsHubController} with a harness engine so they need no Tauri mock.
 */
export function useSkillsHub(
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
): SkillsHubState {
  const [bridge, setBridge] = useState<HermesBridgeStatus>();
  const [bridgeError, setBridgeError] = useState<string>();
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    hermesBridgeStatus()
      .then((status) => {
        if (!cancelled) {
          setBridge(status);
          loaded.current = true;
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBridgeError(
            error instanceof Error ? error.message : String(error),
          );
          loaded.current = true;
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const engine = useSkillsHubEngine(bridge, mode, profile);
  const state = useSkillsHubController(engine);

  if (engine === null && bridgeError) {
    return { ...state, status: "error", error: bridgeError, retryable: true };
  }
  return state;
}
