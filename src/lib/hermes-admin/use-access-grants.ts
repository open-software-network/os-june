/**
 * The data hook behind the "Always allowed commands" half of the Access grants
 * settings page (JUN-206). It owns the load / revoke / refresh lifecycle for
 * one {@link HermesAdminTarget}, driving the shared admin foundation
 * primitives, mirroring `use-external-dirs`:
 *
 * - {@link HermesAdminClient} `config.get()` for the persisted
 *   `command_allowlist` (the runtime's durable "Always approve" answers) and
 *   `config.setValue()` to write the pruned list through Hermes' REST surface
 *   (so the jailed dashboard owns the config.yaml write — no June-side EPERM);
 * - {@link AdminStateCache} for the durable "applies next session" notification
 *   and the `configTree` invalidation bus;
 * - {@link GatewayLifecycle} for the honest apply-timing banner (a config write
 *   is `next-session`, never "applied now": a running session already loaded
 *   the allowlist into memory).
 *
 * Split from the React component so revoke behavior is unit-testable against
 * the fake Hermes server, no rendering. Profile targeting is explicit: the
 * controller is built from ONE target's engine, so a revoke can only ever hit
 * the runtime that target names.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { hermesBridgeStatus, type HermesBridgeStatus } from "../tauri";
import { AdminStateCache, type AdminNotification } from "./cache";
import { createHermesAdminClient, type HermesAdminClient } from "./client";
import { HermesAdminError } from "./errors";
import { GatewayLifecycle, type GatewayLifecycleSnapshot } from "./gateway-lifecycle";
import { createRustAdminFetch } from "./rust-transport";
import { COMMAND_ALLOWLIST_CONFIG_PATH, readCommandAllowlist } from "./schemas";
import { adminTargetForMode, type HermesAdminMode, type HermesAdminTarget } from "./target";
import { removeAllowedCommand } from "./access-grants-view";

/** The dotted config path string the allowlist is written to. */
const COMMAND_ALLOWLIST_PATH = COMMAND_ALLOWLIST_CONFIG_PATH.join(".");

/** The wired-up foundation primitives this surface operates on, all bound to
 * the SAME target. Production builds this from a bridge connection; tests build
 * it from the fake-server harness. */
export type AccessGrantsEngine = {
  target: HermesAdminTarget;
  client: HermesAdminClient;
  cache: AdminStateCache;
  lifecycle: GatewayLifecycle;
};

/** Loading/availability status of the allowlist. A missing runtime
 * ("unavailable") is NOT an error and NOT empty: June's local grant records
 * still render without it. */
export type AccessGrantsStatus = "unavailable" | "loading" | "ready" | "error";

/** Everything the allowlist half of the page renders, plus the actions it
 * invokes. A pure projection of the controller's internal state. */
export type AccessGrantsState = {
  status: AccessGrantsStatus;
  /** The configured allowlist patterns, in declared order. */
  patterns: string[];
  mode?: HermesAdminMode;
  profile?: string;
  /** True while a revoke write is in flight. */
  busy: boolean;
  /** The user-safe message when `status === "error"`, or a write failed. */
  error?: string;
  /** True when the failing load is worth retrying (network/5xx/timeout). */
  retryable: boolean;
  lifecycle: GatewayLifecycleSnapshot;
  notifications: readonly AdminNotification[];
  refresh: () => void;
  /** Revokes one allowlist pattern and writes the pruned list. */
  revoke: (pattern: string) => void;
  dismissNotification: (id: string) => void;
};

/**
 * The framework-free controller the hook wraps. Holds the mutable load/write
 * state for one engine and notifies subscribers on change.
 */
export class AccessGrantsController {
  private readonly engine: AccessGrantsEngine;
  private patterns: string[] = [];
  private status: AccessGrantsStatus = "loading";
  private error?: string;
  private retryable = false;
  private busy = false;
  private notifications: readonly AdminNotification[];
  private lifecycleSnapshot: GatewayLifecycleSnapshot;
  private listeners = new Set<() => void>();
  private disposed = false;
  private loadSeq = 0;
  private unsubscribers: Array<() => void> = [];
  private snapshot: AccessGrantsState;

  constructor(engine: AccessGrantsEngine) {
    this.engine = engine;
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
    // A configTree invalidation from ANY path (a config write elsewhere, a
    // profile switch) reloads the list so the page stays correct.
    this.unsubscribers.push(
      engine.cache.subscribe("configTree", () => {
        if (this.engine.cache.isStale("configTree")) {
          void this.load();
        }
      }),
    );
  }

  getSnapshot(): AccessGrantsState {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.loadSeq += 1;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.listeners.clear();
  }

  /** Loads the persisted allowlist from the runtime's config tree. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    if (this.patterns.length === 0) {
      this.status = "loading";
      this.recompute();
    }

    try {
      const config = await this.engine.client.config.get();
      if (this.disposed || seq !== this.loadSeq) return;

      this.patterns = readCommandAllowlist(config.config);
      this.engine.cache.set("configTree", config.config);
      this.status = "ready";
      this.error = undefined;
      this.retryable = false;
      this.recompute();
    } catch (error) {
      if (this.disposed || seq !== this.loadSeq) return;
      const adminError = HermesAdminError.from("GET /api/config", error);
      this.error = adminError.safeMessage;
      this.retryable = adminError.retryable;
      this.status = this.patterns.length > 0 ? "ready" : "error";
      this.recompute();
    }
  }

  /** Revokes one pattern: prunes the list and read-merge-writes it through
   * `config.setValue`. New sessions no longer auto-allow matching commands; a
   * matching request will prompt for approval again. */
  async revoke(pattern: string): Promise<void> {
    const next = removeAllowedCommand(this.patterns, pattern);
    // A no-op revoke (pattern not present) writes nothing.
    if (next.length === this.patterns.length) return;
    if (this.busy) return;
    this.busy = true;
    this.error = undefined;
    this.recompute();
    try {
      const outcome = await this.engine.client.config.setValue(COMMAND_ALLOWLIST_PATH, next);
      if (this.disposed) return;
      this.engine.cache.afterMutation(outcome.mutation, "always allowed commands");
      this.engine.lifecycle.noteMutation(outcome.mutation);
      this.busy = false;
      await this.load();
    } catch (error) {
      if (this.disposed) return;
      this.busy = false;
      const adminError = HermesAdminError.from("PUT /api/config", error);
      this.error = adminError.safeMessage;
      this.recompute();
    }
  }

  dismissNotification(id: string): void {
    this.engine.cache.dismissNotification(id);
  }

  private buildSnapshot(): AccessGrantsState {
    return {
      status: this.status,
      patterns: this.patterns,
      mode: this.engine.target.mode,
      profile: this.engine.target.profile,
      busy: this.busy,
      error: this.error,
      retryable: this.retryable,
      lifecycle: this.lifecycleSnapshot,
      notifications: this.notifications,
      refresh: this.refreshAction,
      revoke: this.revokeAction,
      dismissNotification: this.dismissNotificationAction,
    };
  }

  private recompute(): void {
    if (this.disposed) return;
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) listener();
  }

  private readonly refreshAction = (): void => {
    void this.load();
  };
  private readonly revokeAction = (pattern: string): void => {
    void this.revoke(pattern);
  };
  private readonly dismissNotificationAction = (id: string): void => {
    this.dismissNotification(id);
  };
}

/** Binds an {@link AccessGrantsController} to React for one engine. A null
 * engine yields the "unavailable" state. */
export function useAccessGrantsController(engine: AccessGrantsEngine | null): AccessGrantsState {
  const controller = useMemo(() => (engine ? new AccessGrantsController(engine) : null), [engine]);

  const [snapshot, setSnapshot] = useState<AccessGrantsState>(() =>
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
const UNAVAILABLE_STATE: AccessGrantsState = Object.freeze({
  status: "unavailable",
  patterns: [],
  busy: false,
  retryable: false,
  lifecycle: {
    state: "clean",
    label: "Up to date",
    detail: "No pending changes.",
    canRestart: false,
  },
  notifications: [],
  refresh: () => {},
  revoke: () => {},
  dismissNotification: () => {},
}) as AccessGrantsState;

/**
 * Production helper: derives the {@link AccessGrantsEngine} from a live bridge
 * status for a chosen mode, returning null when that mode is not running.
 * Profile selection is explicit via {@link adminTargetForMode}.
 */
export function useAccessGrantsEngine(
  bridge: HermesBridgeStatus | undefined,
  mode: HermesAdminMode,
  profile?: string,
): AccessGrantsEngine | null {
  const target = useMemo(
    () => (bridge ? adminTargetForMode(bridge, mode, profile) : undefined),
    [bridge, mode, profile],
  );
  const identity = target
    ? `${target.mode}:${target.profile}:${target.baseUrl}:${target.token}`
    : null;

  return useMemo(() => {
    if (!target) return null;
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
 * for the given mode, and run the controller.
 */
export function useAccessGrants(
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
): AccessGrantsState {
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
          setBridgeError(error instanceof Error ? error.message : String(error));
          loaded.current = true;
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const engine = useAccessGrantsEngine(bridge, mode, profile);
  const state = useAccessGrantsController(engine);

  if (engine === null && bridgeError) {
    return { ...state, status: "error", error: bridgeError, retryable: true };
  }
  return state;
}
