/**
 * The data hook behind June's native MCP servers page (spec 14). It owns the
 * load / add / test / enable / remove lifecycle for one {@link HermesAdminTarget},
 * driving the SAME foundation primitives every admin surface shares:
 *
 * - {@link HermesAdminClient} `mcp.listServers()` / `addServer()` / `testServer()`
 *   / `setEnabled()` / `removeServer()` for I/O — never a raw `fetch`;
 * - {@link AdminStateCache} as the source of truth for the server list and the
 *   durable notifications, and as the invalidation bus a restart / profile
 *   switch refreshes through;
 * - {@link GatewayLifecycle} for the honest apply-timing banner. MCP mutations
 *   are `gateway-restart`, so adding / enabling / removing a server marks the
 *   banner "restart required", never "applied now".
 *
 * It is split from the React component so the optimistic enable / rollback, the
 * test-result handling, and the "don't persist test-only secrets" rule are
 * unit-testable against the fake Hermes server with no rendering.
 *
 * Profile targeting is explicit: the controller is built from ONE target's
 * engine, so a write can only ever hit the runtime that target names. A null
 * engine renders the "Hermes not running" empty state rather than guessing a
 * runtime. Production wires the client through the Rust proxy
 * ({@link createRustAdminFetch}); a webview fetch would CORS-fail.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { hermesBridgeStatus, type HermesBridgeStatus } from "../tauri";
import { AdminStateCache, type AdminNotification } from "./cache";
import { createHermesAdminClient, type HermesAdminClient } from "./client";
import type { HermesAddMcpServerPayload } from "./client";
import { HermesAdminError } from "./errors";
import { createRustAdminFetch } from "./rust-transport";
import {
  GatewayLifecycle,
  type GatewayLifecycleSnapshot,
} from "./gateway-lifecycle";
import type { HermesMcpServerInfo, HermesMcpTestResult } from "./schemas";
import {
  adminTargetForMode,
  type HermesAdminMode,
  type HermesAdminTarget,
} from "./target";

/** The wired-up foundation primitives one MCP servers page operates on, all
 * bound to the SAME target. Production builds this from a bridge connection (see
 * {@link useMcpServersEngine}); tests build it from the fake-server harness. */
export type McpServersEngine = {
  target: HermesAdminTarget;
  client: HermesAdminClient;
  cache: AdminStateCache;
  lifecycle: GatewayLifecycle;
};

/** Loading/availability status of the page. A missing runtime ("unavailable")
 * is NOT an error and NOT empty. */
export type McpServersStatus = "unavailable" | "loading" | "ready" | "error";

/** The result of a test probe, kept per-server so a row can show its discovered
 * tools or its connection error inline. `pending` while the probe is in flight. */
export type McpTestState = {
  pending: boolean;
  /** The probe result once it lands; undefined while pending or before a test. */
  result?: HermesMcpTestResult;
  /** A transport-level error (the request itself failed), distinct from a probe
   * that connected and reported `ok: false`. */
  error?: string;
};

/** Everything the MCP servers component renders, plus the actions it invokes. */
export type McpServersState = {
  status: McpServersStatus;
  servers: HermesMcpServerInfo[];
  mode?: HermesAdminMode;
  profile?: string;
  /** Server names with a setEnabled toggle in flight (optimistic). */
  pending: ReadonlySet<string>;
  /** Per-server test state, keyed by server name. */
  tests: ReadonlyMap<string, McpTestState>;
  /** True while an add-server request is in flight. */
  adding: boolean;
  /** The user-safe message when `status === "error"`, or an action failed. */
  error?: string;
  retryable: boolean;
  lifecycle: GatewayLifecycleSnapshot;
  notifications: readonly AdminNotification[];
  refresh: () => void;
  /** Enables/disables a server: optimistic flip, real call, then refresh; on
   * failure the optimistic flip is rolled back. */
  setEnabled: (name: string, enabled: boolean) => void;
  /** Probes a server. Stores the discovered tools / error in `tests[name]`. Does
   * NOT persist anything (it is a probe). Resolves with the test state. */
  test: (name: string) => Promise<McpTestState>;
  /** Adds a server from a validated payload. Resolves true on success. The
   * payload's env / header secrets are sent but never logged. */
  add: (payload: HermesAddMcpServerPayload) => Promise<boolean>;
  /** Removes a server. Resolves true on success. */
  remove: (name: string) => Promise<boolean>;
  dismissNotification: (id: string) => void;
};

/**
 * The framework-free controller the hook wraps. Holds the mutable load / action
 * state for one engine and notifies a single subscriber (the hook) on change.
 * Extracted so the optimistic / rollback / test rules can be tested without
 * React.
 */
export class McpServersController {
  private readonly engine: McpServersEngine;
  private servers: HermesMcpServerInfo[] = [];
  private status: McpServersStatus = "loading";
  private error?: string;
  private retryable = false;
  private readonly pending = new Set<string>();
  private readonly tests = new Map<string, McpTestState>();
  private adding = false;
  private notifications: readonly AdminNotification[] = [];
  private lifecycleSnapshot: GatewayLifecycleSnapshot;
  private listeners = new Set<() => void>();
  private disposed = false;
  private loadSeq = 0;
  private unsubscribers: Array<() => void> = [];
  private snapshot: McpServersState;

  constructor(engine: McpServersEngine) {
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
    // An mcpServers invalidation from ANY path (a gateway restart's post-refresh,
    // a profile switch, a catalog install on another surface) refreshes the list.
    this.unsubscribers.push(
      engine.cache.subscribe("mcpServers", () => {
        if (this.engine.cache.isStale("mcpServers")) {
          void this.load();
        }
      }),
    );
  }

  getSnapshot(): McpServersState {
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

  /** Loads the server list. Seeds from cache first so a refresh does not blank
   * the page, then reconciles from the network and stores the result back. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    const cached = this.engine.cache.get<HermesMcpServerInfo[]>("mcpServers");
    if (cached) {
      this.servers = cached;
      this.status = "ready";
      this.recompute();
    } else {
      this.status = "loading";
      this.recompute();
    }

    try {
      const servers = await this.engine.client.mcp.listServers();
      if (this.disposed || seq !== this.loadSeq) return;
      this.engine.cache.set("mcpServers", servers);
      this.servers = servers;
      this.status = "ready";
      this.error = undefined;
      this.retryable = false;
      this.recompute();
    } catch (error) {
      if (this.disposed || seq !== this.loadSeq) return;
      const adminError = HermesAdminError.from("GET /api/mcp/servers", error);
      this.error = adminError.safeMessage;
      this.retryable = adminError.retryable;
      this.status = this.servers.length > 0 ? "ready" : "error";
      this.recompute();
    }
  }

  /**
   * Enables/disables a server. Optimistically flips the row, calls the client,
   * and on success applies the cache invalidation + durable notification and
   * advances the lifecycle banner to "restart required", then refreshes. On
   * failure the optimistic flip is rolled back so the toggle never lies.
   */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const current = this.servers.find((server) => server.name === name);
    if (!current || current.enabled === enabled) return;

    this.pending.add(name);
    this.error = undefined;
    this.applyOptimistic(name, enabled);
    this.recompute();

    try {
      const outcome = await this.engine.client.mcp.setEnabled(name, enabled);
      if (this.disposed) return;
      this.engine.cache.afterMutation(outcome.mutation, name);
      this.engine.lifecycle.noteMutation(outcome.mutation);
      this.pending.delete(name);
      await this.load();
    } catch (error) {
      if (this.disposed) return;
      this.applyOptimistic(name, current.enabled);
      this.pending.delete(name);
      const adminError = HermesAdminError.from(
        `PUT /api/mcp/servers/${name}/enabled`,
        error,
      );
      this.error = adminError.safeMessage;
      this.recompute();
    }
  }

  /**
   * Probes a server's connection. Stores the discovered tools / resources /
   * prompts or a clear error in `tests[name]`. A test is a PROBE: it persists
   * nothing, so a test-only draft's secrets never round-trip into state here (the
   * add flow is the only place a payload is sent). On a successful probe the
   * cache rule still invalidates the server list (mcp.test) so a freshly-tested
   * server reflects its new status.
   */
  async test(name: string): Promise<McpTestState> {
    this.setTest(name, { pending: true });
    this.error = undefined;
    this.recompute();
    try {
      const outcome = await this.engine.client.mcp.testServer(name);
      if (this.disposed) return this.tests.get(name) ?? { pending: false };
      const state: McpTestState = { pending: false, result: outcome.result };
      this.setTest(name, state);
      // A test is immediate (it changes nothing durable), but the rule refreshes
      // the server list so the row's last-test status updates.
      this.engine.cache.afterMutation(outcome.mutation, name);
      await this.load();
      return state;
    } catch (error) {
      if (this.disposed) return this.tests.get(name) ?? { pending: false };
      const adminError = HermesAdminError.from(
        `POST /api/mcp/servers/${name}/test`,
        error,
      );
      const state: McpTestState = {
        pending: false,
        error: adminError.safeMessage,
      };
      this.setTest(name, state);
      this.recompute();
      return state;
    }
  }

  /**
   * Adds a server from a validated payload. The payload carries env / header
   * secrets in its body; they are sent to Hermes but never logged. On success
   * the cache invalidates, the lifecycle banner advances to "restart required",
   * and the list refreshes. Returns false (and surfaces a safe error) on failure.
   */
  async add(payload: HermesAddMcpServerPayload): Promise<boolean> {
    this.adding = true;
    this.error = undefined;
    this.recompute();
    try {
      const outcome = await this.engine.client.mcp.addServer(payload);
      if (this.disposed) return true;
      this.engine.cache.afterMutation(outcome.mutation, payload.name);
      this.engine.lifecycle.noteMutation(outcome.mutation);
      this.adding = false;
      await this.load();
      return true;
    } catch (error) {
      if (this.disposed) return false;
      const adminError = HermesAdminError.from("POST /api/mcp/servers", error);
      this.adding = false;
      this.error = adminError.safeMessage;
      this.recompute();
      return false;
    }
  }

  /**
   * Removes a server. On success the cache invalidates, the banner advances to
   * "restart required", and the list refreshes. Returns false (and surfaces a
   * safe error) on failure.
   */
  async remove(name: string): Promise<boolean> {
    this.pending.add(name);
    this.error = undefined;
    this.recompute();
    try {
      const outcome = await this.engine.client.mcp.removeServer(name);
      if (this.disposed) return true;
      this.engine.cache.afterMutation(outcome.mutation, name);
      this.engine.lifecycle.noteMutation(outcome.mutation);
      this.pending.delete(name);
      this.tests.delete(name);
      await this.load();
      return true;
    } catch (error) {
      if (this.disposed) return false;
      this.pending.delete(name);
      const adminError = HermesAdminError.from(
        `DELETE /api/mcp/servers/${name}`,
        error,
      );
      this.error = adminError.safeMessage;
      this.recompute();
      return false;
    }
  }

  dismissNotification(id: string): void {
    this.engine.cache.dismissNotification(id);
  }

  private applyOptimistic(name: string, enabled: boolean): void {
    this.servers = this.servers.map((server) =>
      server.name === name ? { ...server, enabled } : server,
    );
  }

  private setTest(name: string, state: McpTestState): void {
    this.tests.set(name, state);
  }

  private buildSnapshot(): McpServersState {
    return {
      status: this.status,
      servers: this.servers,
      mode: this.engine.target.mode,
      profile: this.engine.target.profile,
      pending: new Set(this.pending),
      tests: new Map(this.tests),
      adding: this.adding,
      error: this.error,
      retryable: this.retryable,
      lifecycle: this.lifecycleSnapshot,
      notifications: this.notifications,
      refresh: this.refresh,
      setEnabled: this.setEnabledAction,
      test: this.testAction,
      add: this.addAction,
      remove: this.removeAction,
      dismissNotification: this.dismissNotificationAction,
    };
  }

  private recompute(): void {
    if (this.disposed) return;
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) listener();
  }

  // Stable action identities so the snapshot callbacks don't churn equality.
  private readonly refresh = (): void => {
    void this.load();
  };
  private readonly setEnabledAction = (
    name: string,
    enabled: boolean,
  ): void => {
    void this.setEnabled(name, enabled);
  };
  private readonly testAction = (name: string): Promise<McpTestState> =>
    this.test(name);
  private readonly addAction = (
    payload: HermesAddMcpServerPayload,
  ): Promise<boolean> => this.add(payload);
  private readonly removeAction = (name: string): Promise<boolean> =>
    this.remove(name);
  private readonly dismissNotificationAction = (id: string): void => {
    this.dismissNotification(id);
  };
}

/**
 * Binds an {@link McpServersController} to React for one engine. A null engine
 * yields the "unavailable" state without constructing a controller. The
 * controller loads once on mount and tears down on unmount.
 */
export function useMcpServersController(
  engine: McpServersEngine | null,
): McpServersState {
  const controller = useMemo(
    () => (engine ? new McpServersController(engine) : null),
    [engine],
  );

  const [snapshot, setSnapshot] = useState<McpServersState>(() =>
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
const UNAVAILABLE_STATE: McpServersState = Object.freeze({
  status: "unavailable",
  servers: [],
  pending: new Set<string>(),
  tests: new Map<string, McpTestState>(),
  adding: false,
  retryable: false,
  lifecycle: {
    state: "clean",
    label: "Up to date",
    detail: "No pending changes.",
    canRestart: false,
  },
  notifications: [],
  refresh: () => {},
  setEnabled: () => {},
  test: () => Promise.resolve({ pending: false }),
  add: () => Promise.resolve(false),
  remove: () => Promise.resolve(false),
  dismissNotification: () => {},
}) as McpServersState;

/**
 * Production helper: derives the {@link McpServersEngine} from a live bridge
 * status for a chosen mode, returning null when that mode is not running. Built
 * with `useMemo` keyed on the selected connection's identity so a status refresh
 * that does not change the connection does not rebuild the client/cache. Profile
 * selection is explicit via {@link adminTargetForMode} — there is no
 * first-connection fallback. The client routes through the Rust proxy.
 */
export function useMcpServersEngine(
  bridge: HermesBridgeStatus | undefined,
  mode: HermesAdminMode,
  profile?: string,
): McpServersEngine | null {
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
    // first connection. Tests build the engine from the harness and keep the
    // injected node fetch, so this branch is production-only.
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
 * {@link useMcpServersController} with a harness engine so they need no Tauri
 * mock.
 */
export function useMcpServers(
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
): McpServersState {
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

  const engine = useMcpServersEngine(bridge, mode, profile);
  const state = useMcpServersController(engine);

  if (engine === null && bridgeError) {
    return { ...state, status: "error", error: bridgeError, retryable: true };
  }
  return state;
}
