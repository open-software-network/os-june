/**
 * The data hook behind June's native installed Skills page (spec 03). It owns
 * the load / toggle / refresh lifecycle for one {@link HermesAdminTarget},
 * driving the SAME foundation primitives every admin surface shares:
 *
 * - {@link HermesAdminClient} `skills.list()` / `skills.toggle()` for I/O — never
 *   a raw `fetch`;
 * - {@link AdminStateCache} as the source of truth for the skills list and for
 *   the durable "applies next session" notification, and as the invalidation
 *   bus a hub install / restart / profile switch triggers a refresh through;
 * - {@link GatewayLifecycle} for the honest apply-timing banner (a skill toggle
 *   is `next-session`, never "applied now").
 *
 * It is split from the React component so the toggle success / failure /
 * rollback behavior is unit-testable against the fake Hermes server with no
 * rendering: a test builds the engine from `makeAdminHarness` and exercises
 * {@link useInstalledSkillsController} via `renderHook`, or drives the underlying
 * {@link InstalledSkillsController} logic directly.
 *
 * Profile targeting is explicit: the controller is built from ONE target's
 * engine, so a toggle can only ever hit the runtime that target names — never
 * "whichever connection is first". A null engine renders the "Hermes not
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
import type { HermesSkillInfo } from "./schemas";
import {
  adminTargetForMode,
  type HermesAdminMode,
  type HermesAdminTarget,
} from "./target";

/** The wired-up foundation primitives one installed-Skills page operates on,
 * all bound to the SAME target. Production builds this from a bridge connection
 * (see {@link useInstalledSkillsEngine}); tests build it from the fake-server
 * harness. */
export type InstalledSkillsEngine = {
  target: HermesAdminTarget;
  client: HermesAdminClient;
  cache: AdminStateCache;
  lifecycle: GatewayLifecycle;
};

/** Loading/availability status of the page, distinct so the UI can render the
 * right surface: a missing runtime ("offline") is NOT an error and NOT empty. */
export type InstalledSkillsStatus =
  | "unavailable" // no live Hermes runtime in the requested mode
  | "loading" // first load in flight, nothing to show yet
  | "ready" // skills loaded (possibly an empty list)
  | "error"; // the load failed; a retry is offered

/** Everything the installed Skills component renders, plus the actions it
 * invokes. A pure projection of the controller's internal state. */
export type InstalledSkillsState = {
  status: InstalledSkillsStatus;
  /** The skills as last loaded, with optimistic toggle state applied. Empty
   * array while loading or unavailable. */
  skills: HermesSkillInfo[];
  /** The target's mode, so the page can show June's sandbox/full-mode context. */
  mode?: HermesAdminMode;
  /** The profile this page is bound to, surfaced for explicit targeting. */
  profile?: string;
  /** Skill names with a toggle in flight (optimistic). */
  pending: ReadonlySet<string>;
  /** The user-safe message when `status === "error"`, or a toggle failed. */
  error?: string;
  /** True when the failing load is worth retrying (network/5xx/timeout). */
  retryable: boolean;
  /** The gateway lifecycle banner snapshot (apply-timing / restart state). */
  lifecycle: GatewayLifecycleSnapshot;
  /** Durable admin notifications (e.g. "Skill updated. New sessions can use
   * it."), newest last. */
  notifications: readonly AdminNotification[];
  /** Reloads the skills list from Hermes. */
  refresh: () => void;
  /** Enables/disables a skill: optimistic flip, real toggle, then refresh; on
   * failure the optimistic flip is rolled back and the error surfaced. */
  toggle: (name: string, enabled: boolean) => void;
  /** Dismisses a durable notification by id. */
  dismissNotification: (id: string) => void;
};

/**
 * The framework-free controller the hook wraps. Holds the mutable load/toggle
 * state for one engine and notifies a single subscriber (the hook) on change.
 * Extracted so the optimistic/rollback rules can be tested without React; the
 * hook is a thin `useSyncExternalStore`-style binding over it.
 */
export class InstalledSkillsController {
  private readonly engine: InstalledSkillsEngine;
  private skills: HermesSkillInfo[] = [];
  private status: InstalledSkillsStatus = "loading";
  private error?: string;
  private retryable = false;
  private readonly pending = new Set<string>();
  private notifications: readonly AdminNotification[] = [];
  private lifecycleSnapshot: GatewayLifecycleSnapshot;
  private listeners = new Set<() => void>();
  private disposed = false;
  /** Bumped on every load request so a stale resolve cannot overwrite newer
   * state (the equivalent of SessionUsagePanel's requestSeq guard). */
  private loadSeq = 0;
  private unsubscribers: Array<() => void> = [];
  private snapshot: InstalledSkillsState;

  constructor(engine: InstalledSkillsEngine) {
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
    // A skills invalidation from ANY path (hub install/uninstall/update, a
    // gateway restart's post-refresh, a profile switch) refreshes the list so
    // the page stays correct after events it did not originate.
    this.unsubscribers.push(
      engine.cache.subscribe("skills", () => {
        if (this.engine.cache.isStale("skills")) {
          void this.load();
        }
      }),
    );
  }

  /** The current immutable snapshot the hook hands to React. */
  getSnapshot(): InstalledSkillsState {
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

  /** Loads the skills list. Seeds from any cached value first so a refresh does
   * not blank the page. Stores the result back into the cache so other surfaces
   * and the invalidation bus stay coherent. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    const cached = this.engine.cache.get<HermesSkillInfo[]>("skills");
    if (cached) {
      // Show cached rows immediately; the network refresh reconciles below.
      this.skills = cached;
      this.status = "ready";
      this.recompute();
    } else {
      this.status = "loading";
      this.recompute();
    }

    try {
      const skills = await this.engine.client.skills.list();
      if (this.disposed || seq !== this.loadSeq) return;
      this.engine.cache.set("skills", skills);
      this.skills = skills;
      this.status = "ready";
      this.error = undefined;
      this.retryable = false;
      this.recompute();
    } catch (error) {
      if (this.disposed || seq !== this.loadSeq) return;
      const adminError = HermesAdminError.from("GET /api/skills", error);
      // If we already have rows (a refresh failed), keep showing them and
      // surface the error inline rather than throwing the page into an error
      // state — the data on screen is still the last good data.
      this.error = adminError.safeMessage;
      this.retryable = adminError.retryable;
      this.status = this.skills.length > 0 ? "ready" : "error";
      this.recompute();
    }
  }

  /**
   * Toggles a skill enabled/disabled. Optimistically flips the row, calls the
   * client, and on success applies the cache invalidation + durable
   * notification and advances the lifecycle banner, then refreshes from Hermes.
   * On failure the optimistic flip is rolled back so the toggle never lies, and
   * the safe error is surfaced.
   */
  async toggle(name: string, enabled: boolean): Promise<void> {
    const current = this.skills.find((skill) => skill.name === name);
    if (!current) return;
    // External skills are read-only in June; never attempt a write.
    if (current.readOnly) {
      this.error =
        "This skill loads from an external directory and is read-only in June.";
      this.recompute();
      return;
    }
    const previousEnabled = current.enabled;
    if (previousEnabled === enabled) return;

    this.pending.add(name);
    this.error = undefined;
    this.applyOptimistic(name, enabled);
    this.recompute();

    try {
      const outcome = await this.engine.client.skills.toggle(name, enabled);
      if (this.disposed) return;
      // Invalidate + raise the durable "applies next session" notification, and
      // advance the shared lifecycle banner via the same timing map every page
      // uses. afterMutation marks "skills" stale; we refresh explicitly below
      // (the controller owns the client) so we do not double-refresh from the
      // subscription while a load is already running.
      this.engine.cache.afterMutation(outcome.mutation, name);
      this.engine.lifecycle.noteMutation(outcome.mutation);
      this.pending.delete(name);
      await this.load();
    } catch (error) {
      if (this.disposed) return;
      // Roll the optimistic flip back; the row reflects the real (unchanged)
      // state, so a failed toggle never leaves the switch in the wrong place.
      this.applyOptimistic(name, previousEnabled);
      this.pending.delete(name);
      const adminError = HermesAdminError.from("PUT /api/skills/toggle", error);
      this.error = adminError.safeMessage;
      this.recompute();
    }
  }

  /** Dismisses a durable notification. */
  dismissNotification(id: string): void {
    this.engine.cache.dismissNotification(id);
  }

  private applyOptimistic(name: string, enabled: boolean): void {
    this.skills = this.skills.map((skill) =>
      skill.name === name ? { ...skill, enabled } : skill,
    );
  }

  private buildSnapshot(): InstalledSkillsState {
    return {
      status: this.status,
      skills: this.skills,
      mode: this.engine.target.mode,
      profile: this.engine.target.profile,
      pending: new Set(this.pending),
      error: this.error,
      retryable: this.retryable,
      lifecycle: this.lifecycleSnapshot,
      notifications: this.notifications,
      refresh: this.refresh,
      toggle: this.toggleAction,
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
  private readonly toggleAction = (name: string, enabled: boolean): void => {
    void this.toggle(name, enabled);
  };
  private readonly dismissNotificationAction = (id: string): void => {
    this.dismissNotification(id);
  };
}

/**
 * Binds an {@link InstalledSkillsController} to React for one engine. A null
 * engine yields the "unavailable" state (no runtime to target) without
 * constructing a controller. The controller loads once on mount and tears down
 * on unmount.
 */
export function useInstalledSkillsController(
  engine: InstalledSkillsEngine | null,
): InstalledSkillsState {
  const controller = useMemo(
    () => (engine ? new InstalledSkillsController(engine) : null),
    [engine],
  );

  const [snapshot, setSnapshot] = useState<InstalledSkillsState>(() =>
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
const UNAVAILABLE_STATE: InstalledSkillsState = Object.freeze({
  status: "unavailable",
  skills: [],
  pending: new Set<string>(),
  retryable: false,
  lifecycle: {
    state: "clean",
    label: "Up to date",
    detail: "No pending changes.",
    canRestart: false,
  },
  notifications: [],
  refresh: () => {},
  toggle: () => {},
  dismissNotification: () => {},
}) as InstalledSkillsState;

/**
 * Production helper: derives the {@link InstalledSkillsEngine} from a live bridge
 * status for a chosen mode, returning null when that mode is not running. Built
 * with `useMemo` keyed on the selected connection's identity so a status refresh
 * that does not change the connection does not rebuild the client/cache (which
 * would drop the loaded list and notifications). Profile selection is explicit
 * via {@link adminTargetForMode} — there is no first-connection fallback.
 */
export function useInstalledSkillsEngine(
  bridge: HermesBridgeStatus | undefined,
  mode: HermesAdminMode,
  profile?: string,
): InstalledSkillsEngine | null {
  const target = useMemo(
    () => (bridge ? adminTargetForMode(bridge, mode, profile) : undefined),
    [bridge, mode, profile],
  );
  // Re-key only on the stable identity of the target, not the object, so a
  // bridge poll that returns the same connection keeps the same engine.
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
 * {@link useInstalledSkillsController} with a harness engine so they need no
 * Tauri mock.
 */
export function useInstalledSkills(
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
): InstalledSkillsState {
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

  const engine = useInstalledSkillsEngine(bridge, mode, profile);
  const state = useInstalledSkillsController(engine);

  // Surface a bridge-status failure as the page error rather than a silent
  // "unavailable", so the user can tell "Hermes is off" from "I couldn't ask".
  if (engine === null && bridgeError) {
    return { ...state, status: "error", error: bridgeError, retryable: true };
  }
  return state;
}
