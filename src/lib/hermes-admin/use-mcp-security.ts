/**
 * The data hook behind June's global MCP exposure-policy setting (spec 19). It
 * owns the read / set / refresh lifecycle of the single `mcp.exposure_policy`
 * config value for one {@link HermesAdminTarget}, driving the shared admin
 * foundation primitives:
 *
 * - {@link HermesAdminClient} `config.get()` to read the configured policy and
 *   `config.set()` to write the chosen one through Hermes' REST surface (so the
 *   jailed dashboard owns the config.yaml write — no June-side EPERM);
 * - {@link AdminStateCache} for the durable "applies next session" notification
 *   and the `configTree` invalidation bus;
 * - {@link GatewayLifecycle} for the honest apply-timing banner (a config write
 *   is `next-session`, never "applied now").
 *
 * This surface is the ONLY mutating part of feature 19 — the per-server/entry
 * security labels and risk warnings are pure render logic the existing MCP pages
 * already own. Split from the React component so the read/write behavior is
 * unit-testable against the fake Hermes server. Profile targeting is explicit:
 * the controller is built from ONE target's engine, so a write can only ever hit
 * the runtime that target names.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { hermesBridgeStatus, type HermesBridgeStatus } from "../tauri";
import { AdminStateCache, type AdminNotification } from "./cache";
import { createHermesAdminClient, type HermesAdminClient } from "./client";
import { HermesAdminError } from "./errors";
import {
  GatewayLifecycle,
  type GatewayLifecycleSnapshot,
} from "./gateway-lifecycle";
import { createRustAdminFetch } from "./rust-transport";
import {
  DEFAULT_MCP_EXPOSURE_POLICY,
  MCP_EXPOSURE_POLICY_CONFIG_PATH,
  readExposurePolicy,
  type McpExposurePolicy,
} from "./mcp-security-view";
import {
  adminTargetForMode,
  type HermesAdminMode,
  type HermesAdminTarget,
} from "./target";

/** The wired-up foundation primitives this surface operates on, all bound to the
 * SAME target. Production builds this from a bridge connection; tests build it
 * from the fake-server harness. */
export type McpSecurityEngine = {
  target: HermesAdminTarget;
  client: HermesAdminClient;
  cache: AdminStateCache;
  lifecycle: GatewayLifecycle;
};

/** Loading/availability status of the setting. A missing runtime
 * ("unavailable") is NOT an error. */
export type McpSecurityStatus = "unavailable" | "loading" | "ready" | "error";

/** Everything the MCP security setting component renders, plus the actions it
 * invokes. A pure projection of the controller's internal state. */
export type McpSecurityState = {
  status: McpSecurityStatus;
  /** The configured global exposure policy (conservative default until read). */
  policy: McpExposurePolicy;
  mode?: HermesAdminMode;
  profile?: string;
  /** True while the policy write is in flight. */
  busy: boolean;
  /** The user-safe message when `status === "error"`, or a write failed. */
  error?: string;
  /** True when the failing load is worth retrying (network/5xx/timeout). */
  retryable: boolean;
  lifecycle: GatewayLifecycleSnapshot;
  notifications: readonly AdminNotification[];
  refresh: () => void;
  /** Writes the chosen policy through Hermes' REST config mutation. */
  setPolicy: (policy: McpExposurePolicy) => void;
  dismissNotification: (id: string) => void;
};

/**
 * The framework-free controller the hook wraps. Holds the mutable load/write
 * state for one engine and notifies a single subscriber (the hook) on change.
 */
export class McpSecurityController {
  private readonly engine: McpSecurityEngine;
  private policy: McpExposurePolicy = DEFAULT_MCP_EXPOSURE_POLICY;
  private loaded = false;
  private status: McpSecurityStatus = "loading";
  private error?: string;
  private retryable = false;
  private busy = false;
  private notifications: readonly AdminNotification[];
  private lifecycleSnapshot: GatewayLifecycleSnapshot;
  private listeners = new Set<() => void>();
  private disposed = false;
  private loadSeq = 0;
  private unsubscribers: Array<() => void> = [];
  private snapshot: McpSecurityState;

  constructor(engine: McpSecurityEngine) {
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
    this.unsubscribers.push(
      engine.cache.subscribe("configTree", () => {
        if (this.engine.cache.isStale("configTree")) {
          void this.load();
        }
      }),
    );
  }

  getSnapshot(): McpSecurityState {
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

  /** Reads the config tree and extracts the exposure policy. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    if (!this.loaded) {
      this.status = "loading";
      this.recompute();
    }
    try {
      const config = await this.engine.client.config.get();
      if (this.disposed || seq !== this.loadSeq) return;
      this.engine.cache.set("configTree", config.config);
      this.policy = readExposurePolicy(config.config);
      this.loaded = true;
      this.status = "ready";
      this.error = undefined;
      this.retryable = false;
      this.recompute();
    } catch (error) {
      if (this.disposed || seq !== this.loadSeq) return;
      const adminError = HermesAdminError.from("GET /api/config", error);
      this.error = adminError.safeMessage;
      this.retryable = adminError.retryable;
      // Keep the last-known policy visible if we have one; otherwise mark error.
      this.status = this.loaded ? "ready" : "error";
      this.recompute();
    }
  }

  /** Writes the chosen policy through Hermes' REST config mutation. On success
   * applies the cache invalidation + durable notification and advances the
   * lifecycle banner, then reloads. On failure surfaces the safe error; the
   * on-screen policy is unchanged (the write did not land). */
  async setPolicy(next: McpExposurePolicy): Promise<void> {
    if (this.busy || next === this.policy) return;
    this.busy = true;
    this.error = undefined;
    this.recompute();
    try {
      const outcome = await this.engine.client.config.set(
        MCP_EXPOSURE_POLICY_CONFIG_PATH,
        next,
      );
      if (this.disposed) return;
      this.engine.cache.afterMutation(outcome.mutation, "MCP exposure policy");
      this.engine.lifecycle.noteMutation(outcome.mutation);
      this.busy = false;
      // Reflect the chosen value immediately; the reload confirms it landed.
      this.policy = next;
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

  private buildSnapshot(): McpSecurityState {
    return {
      status: this.status,
      policy: this.policy,
      mode: this.engine.target.mode,
      profile: this.engine.target.profile,
      busy: this.busy,
      error: this.error,
      retryable: this.retryable,
      lifecycle: this.lifecycleSnapshot,
      notifications: this.notifications,
      refresh: this.refresh,
      setPolicy: this.setPolicyAction,
      dismissNotification: this.dismissNotificationAction,
    };
  }

  private recompute(): void {
    if (this.disposed) return;
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) listener();
  }

  private readonly refresh = (): void => {
    void this.load();
  };
  private readonly setPolicyAction = (policy: McpExposurePolicy): void => {
    void this.setPolicy(policy);
  };
  private readonly dismissNotificationAction = (id: string): void => {
    this.dismissNotification(id);
  };
}

/** Binds an {@link McpSecurityController} to React for one engine. A null engine
 * yields the "unavailable" state. */
export function useMcpSecurityController(
  engine: McpSecurityEngine | null,
): McpSecurityState {
  const controller = useMemo(
    () => (engine ? new McpSecurityController(engine) : null),
    [engine],
  );

  const [snapshot, setSnapshot] = useState<McpSecurityState>(() =>
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
const UNAVAILABLE_STATE: McpSecurityState = Object.freeze({
  status: "unavailable",
  policy: DEFAULT_MCP_EXPOSURE_POLICY,
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
  setPolicy: () => {},
  dismissNotification: () => {},
}) as McpSecurityState;

/**
 * Production helper: derives the {@link McpSecurityEngine} from a live bridge
 * status for a chosen mode, returning null when that mode is not running.
 * Profile selection is explicit via {@link adminTargetForMode}.
 */
export function useMcpSecurityEngine(
  bridge: HermesBridgeStatus | undefined,
  mode: HermesAdminMode,
  profile?: string,
): McpSecurityEngine | null {
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
export function useMcpSecurity(
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
): McpSecurityState {
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

  const engine = useMcpSecurityEngine(bridge, mode, profile);
  const state = useMcpSecurityController(engine);

  if (engine === null && bridgeError) {
    return { ...state, status: "error", error: bridgeError, retryable: true };
  }
  return state;
}
