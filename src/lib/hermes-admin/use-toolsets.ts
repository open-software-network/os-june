/**
 * The data hook behind June's native Toolsets inventory page (spec 04). It owns
 * the load / refresh lifecycle for one {@link HermesAdminTarget}, driving the
 * SAME foundation primitives every admin surface shares:
 *
 * - {@link HermesAdminClient} `toolsets.list()` and `skills.list()` for I/O —
 *   never a raw `fetch`. Skills are loaded alongside toolsets so the page can
 *   explain WHY a skill is visible / hidden / missing setup against the live
 *   toolset availability (spec 04's "integrate with Skills" criterion).
 * - {@link AdminStateCache} as the source of truth, and as the invalidation bus
 *   an MCP install / gateway restart / profile switch refreshes through (a
 *   gateway restart invalidates `toolsets`, so MCP-backed tools appear here after
 *   a restart without the page reinventing the rule).
 * - {@link GatewayLifecycle} for the honest apply-timing banner.
 *
 * This is a READ surface: spec 04 is about explaining capability and missing
 * setup, not mutating it. There is no toggle here (skill/MCP mutations live on
 * their own pages); the page reflects whatever the runtime reports and never
 * invents state.
 *
 * Profile targeting is explicit: the controller is built from ONE target's
 * engine, so the data can only ever come from the runtime that target names —
 * never "whichever connection is first". A null engine renders the "Hermes not
 * running" empty state rather than guessing a runtime.
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
import type { HermesSkillInfo, HermesToolsetInfo } from "./schemas";
import {
  adminTargetForMode,
  type HermesAdminMode,
  type HermesAdminTarget,
} from "./target";

/** The wired-up foundation primitives one Toolsets page operates on, all bound
 * to the SAME target. Production builds this from a bridge connection (see
 * {@link useToolsetsEngine}); tests build it from the fake-server harness. */
export type ToolsetsEngine = {
  target: HermesAdminTarget;
  client: HermesAdminClient;
  cache: AdminStateCache;
  lifecycle: GatewayLifecycle;
};

/** Loading/availability status, distinct so the UI can render the right
 * surface: a missing runtime ("offline") is NOT an error and NOT empty. */
export type ToolsetsStatus = "unavailable" | "loading" | "ready" | "error";

/** Everything the Toolsets component renders, plus the actions it invokes. A
 * pure projection of the controller's internal state. */
export type ToolsetsState = {
  status: ToolsetsStatus;
  /** The toolsets as last loaded. Empty while loading or unavailable. */
  toolsets: HermesToolsetInfo[];
  /** The skills as last loaded, used to explain skill activation against the
   * toolset inventory. Empty when skills could not be loaded (the toolsets list
   * still renders; the per-skill explanations are simply omitted). */
  skills: HermesSkillInfo[];
  /** The target's mode, so the page can show June's sandbox/full-mode context. */
  mode?: HermesAdminMode;
  /** The profile this page is bound to, surfaced for explicit targeting. */
  profile?: string;
  /** Epoch ms of the last successful toolsets load, for the "last refreshed"
   * line. Undefined until the first successful load. */
  lastRefreshedAt?: number;
  /** The user-safe message when `status === "error"`, or a refresh failed. */
  error?: string;
  /** True when the failing load is worth retrying (network/5xx/timeout). */
  retryable: boolean;
  /** The gateway lifecycle banner snapshot (apply-timing / restart state). */
  lifecycle: GatewayLifecycleSnapshot;
  /** Durable admin notifications, newest last. */
  notifications: readonly AdminNotification[];
  /** Reloads the toolsets (and skills) from Hermes. */
  refresh: () => void;
  /** Dismisses a durable notification by id. */
  dismissNotification: (id: string) => void;
};

/**
 * The framework-free controller the hook wraps. Holds the mutable load state for
 * one engine and notifies a single subscriber (the hook) on change. Extracted so
 * the load/refresh rules can be tested without React.
 */
export class ToolsetsController {
  private readonly engine: ToolsetsEngine;
  private toolsets: HermesToolsetInfo[] = [];
  private skills: HermesSkillInfo[] = [];
  private status: ToolsetsStatus = "loading";
  private error?: string;
  private retryable = false;
  private lastRefreshedAt?: number;
  private notifications: readonly AdminNotification[] = [];
  private lifecycleSnapshot: GatewayLifecycleSnapshot;
  private listeners = new Set<() => void>();
  private disposed = false;
  /** Bumped on every load request so a stale resolve cannot overwrite newer
   * state. */
  private loadSeq = 0;
  private unsubscribers: Array<() => void> = [];
  private snapshot: ToolsetsState;

  constructor(engine: ToolsetsEngine) {
    this.engine = engine;
    this.lifecycleSnapshot = engine.lifecycle.getSnapshot();
    this.notifications = engine.cache.getNotifications();
    this.snapshot = this.buildSnapshot();

    // Re-render on durable notifications and on lifecycle transitions.
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
    // A toolsets invalidation from ANY path (an MCP add/test/install, a gateway
    // restart's post-refresh, a profile switch) refreshes the list so the page
    // stays correct after events it did not originate — this is how MCP-backed
    // tools appear here after a restart without this page knowing the rule.
    this.unsubscribers.push(
      engine.cache.subscribe("toolsets", () => {
        if (this.engine.cache.isStale("toolsets")) {
          void this.load();
        }
      }),
    );
    // Skills change next-session; refresh the explanation inputs when they do.
    this.unsubscribers.push(
      engine.cache.subscribe("skills", () => {
        if (this.engine.cache.isStale("skills")) {
          void this.loadSkills();
        }
      }),
    );
  }

  /** The current immutable snapshot the hook hands to React. */
  getSnapshot(): ToolsetsState {
    return this.snapshot;
  }

  /** Subscribes to state changes. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Tears down cache/lifecycle subscriptions and blocks further state writes.
   * Idempotent. */
  dispose(): void {
    this.disposed = true;
    this.loadSeq += 1; // invalidate any in-flight load
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.listeners.clear();
  }

  /** Loads the toolsets list (and, best-effort, the skills used to explain
   * activation). Seeds from any cached value first so a refresh does not blank
   * the page. Stores results back into the cache so other surfaces and the
   * invalidation bus stay coherent. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    const cached = this.engine.cache.get<HermesToolsetInfo[]>("toolsets");
    if (cached) {
      this.toolsets = cached;
      this.status = "ready";
      this.recompute();
    } else {
      this.status = "loading";
      this.recompute();
    }

    try {
      const toolsets = await this.engine.client.toolsets.list();
      if (this.disposed || seq !== this.loadSeq) return;
      this.engine.cache.set("toolsets", toolsets);
      this.toolsets = toolsets;
      this.status = "ready";
      this.error = undefined;
      this.retryable = false;
      this.lastRefreshedAt = Date.now();
      this.recompute();
    } catch (error) {
      if (this.disposed || seq !== this.loadSeq) return;
      const adminError = HermesAdminError.from(
        "GET /api/tools/toolsets",
        error,
      );
      this.error = adminError.safeMessage;
      this.retryable = adminError.retryable;
      // Keep showing the last good data on a failed refresh; only fall to the
      // error surface when there is nothing on screen.
      this.status = this.toolsets.length > 0 ? "ready" : "error";
      this.recompute();
    }

    // Skills are an enrichment for the explanations, not the page's reason to
    // exist — load them independently so a skills failure never blanks the
    // toolsets list.
    await this.loadSkills();
  }

  /** Best-effort load of the skills used for activation explanations. A failure
   * leaves the existing skills in place and is swallowed (the toolset rows still
   * render). */
  private async loadSkills(): Promise<void> {
    const cached = this.engine.cache.get<HermesSkillInfo[]>("skills");
    if (cached) {
      this.skills = cached;
      this.recompute();
    }
    try {
      const skills = await this.engine.client.skills.list();
      if (this.disposed) return;
      this.engine.cache.set("skills", skills);
      this.skills = skills;
      this.recompute();
    } catch {
      // Leave skills as-is; explanations degrade to "no metadata" gracefully.
    }
  }

  /** Dismisses a durable notification. */
  dismissNotification(id: string): void {
    this.engine.cache.dismissNotification(id);
  }

  private buildSnapshot(): ToolsetsState {
    return {
      status: this.status,
      toolsets: this.toolsets,
      skills: this.skills,
      mode: this.engine.target.mode,
      profile: this.engine.target.profile,
      lastRefreshedAt: this.lastRefreshedAt,
      error: this.error,
      retryable: this.retryable,
      lifecycle: this.lifecycleSnapshot,
      notifications: this.notifications,
      refresh: this.refresh,
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
  private readonly refresh = (): void => {
    void this.load();
  };
  private readonly dismissNotificationAction = (id: string): void => {
    this.dismissNotification(id);
  };
}

/**
 * Binds a {@link ToolsetsController} to React for one engine. A null engine
 * yields the "unavailable" state (no runtime to target) without constructing a
 * controller. The controller loads once on mount and tears down on unmount.
 */
export function useToolsetsController(
  engine: ToolsetsEngine | null,
): ToolsetsState {
  const controller = useMemo(
    () => (engine ? new ToolsetsController(engine) : null),
    [engine],
  );

  const [snapshot, setSnapshot] = useState<ToolsetsState>(() =>
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
    void controller.load();
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  return snapshot;
}

/** The frozen state shown when there is no runtime to talk to. */
const UNAVAILABLE_STATE: ToolsetsState = Object.freeze({
  status: "unavailable",
  toolsets: [],
  skills: [],
  retryable: false,
  lifecycle: {
    state: "clean",
    label: "Up to date",
    detail: "No pending changes.",
    canRestart: false,
  },
  notifications: [],
  refresh: () => {},
  dismissNotification: () => {},
}) as ToolsetsState;

/**
 * Production helper: derives the {@link ToolsetsEngine} from a live bridge status
 * for a chosen mode, returning null when that mode is not running. Built with
 * `useMemo` keyed on the selected connection's identity so a status refresh that
 * does not change the connection does not rebuild the client/cache. Profile
 * selection is explicit via {@link adminTargetForMode} — there is no
 * first-connection fallback.
 */
export function useToolsetsEngine(
  bridge: HermesBridgeStatus | undefined,
  mode: HermesAdminMode,
  profile?: string,
): ToolsetsEngine | null {
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
    // than a webview fetch the cross-origin dashboard would 401. The fetch is
    // bound to this target's mode so Rust targets the chosen runtime, never the
    // first connection. Tests build the engine from the fake-server harness and
    // keep the injected node fetch, so this branch is production-only.
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
 * The all-in-one production hook: fetch bridge status once, derive the engine
 * for the given mode, and run the controller. The page calls THIS; tests prefer
 * {@link useToolsetsController} with a harness engine so they need no Tauri mock.
 */
export function useToolsets(
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
): ToolsetsState {
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

  const engine = useToolsetsEngine(bridge, mode, profile);
  const state = useToolsetsController(engine);

  // Surface a bridge-status failure as the page error rather than a silent
  // "unavailable", so the user can tell "Hermes is off" from "I couldn't ask".
  if (engine === null && bridgeError) {
    return { ...state, status: "error", error: bridgeError, retryable: true };
  }
  return state;
}
