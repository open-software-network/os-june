/**
 * The data hook behind June's native MCP catalog browser (spec 15). It owns the
 * browse / inspect / install lifecycle for one {@link HermesAdminTarget}, driving
 * the SAME foundation primitives every admin surface shares:
 *
 * - {@link HermesAdminClient} `mcp.catalog()` / `mcp.installCatalogEntry()` /
 *   `pollAction()` for I/O — never a raw `fetch`;
 * - {@link AdminStateCache} as the invalidation bus: a successful install marks
 *   `mcpServers` + `mcpCatalog` + `toolsets` stale (so the MCP servers page and
 *   the catalog itself refresh), and raises the durable "restart required"
 *   notification;
 * - {@link GatewayLifecycle} for the honest apply-timing banner (a catalog
 *   install is `gateway-restart`, never "applied now").
 *
 * Install is a BACKGROUND action: `installCatalogEntry` returns an action handle,
 * which the controller polls to a terminal state, surfacing live progress and (on
 * failure) the safe error inline. The same pattern the Skills Hub browser uses,
 * reused here so a catalog install behaves identically to every other backgrounded
 * admin action.
 *
 * Secrets: the env values an install collects ride in the install payload's body
 * and are never logged (the client/transport own that). This controller only ever
 * passes the already-built payload through; it never reads a value back.
 *
 * OAuth / third-party entries: install still runs (it adds the server), but the
 * sign-in itself is a separate flow (feature 17). The controller surfaces the
 * handoff via the install result's `needsAuthHandoff` flag so the UI can route the
 * user there rather than pretending install is complete.
 *
 * It is split from the React component so the browse / install / progress /
 * failure behavior is unit-testable against the fake Hermes server with no
 * rendering. Profile targeting is explicit: the controller is built from ONE
 * target's engine, so an install can only ever hit the runtime that target names.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { hermesBridgeStatus, type HermesBridgeStatus } from "../tauri";
import { AdminStateCache, type AdminNotification } from "./cache";
import {
  createHermesAdminClient,
  type HermesAdminClient,
  type HermesInstallCatalogPayload,
} from "./client";
import { HermesAdminError } from "./errors";
import { createRustAdminFetch } from "./rust-transport";
import {
  GatewayLifecycle,
  type GatewayLifecycleSnapshot,
} from "./gateway-lifecycle";
import type { HermesActionStatus, HermesMcpCatalogEntry } from "./schemas";
import { needsAuthHandoff } from "./mcp-catalog-view";
import {
  adminTargetForMode,
  type HermesAdminMode,
  type HermesAdminTarget,
} from "./target";

/** The wired-up foundation primitives one MCP catalog page operates on, all
 * bound to the SAME target. Production builds this from a bridge connection (see
 * {@link useMcpCatalogEngine}); tests build it from the fake-server harness. */
export type McpCatalogEngine = {
  target: HermesAdminTarget;
  client: HermesAdminClient;
  cache: AdminStateCache;
  lifecycle: GatewayLifecycle;
};

/** Loading/availability status of the page. A missing runtime ("unavailable") is
 * NOT an error and NOT empty. */
export type McpCatalogStatus = "unavailable" | "loading" | "ready" | "error";

/** Per-entry install progress. `idle` is the default; `installing` carries live
 * progress; `done` / `failed` are terminal until the next install attempt. */
export type McpInstallPhase = "idle" | "installing" | "done" | "failed";

/** The live install state for one catalog entry (keyed by install name). */
export type McpCatalogInstallState = {
  installName: string;
  phase: McpInstallPhase;
  /** 0-100 progress while installing, when Hermes reports it. */
  progress?: number;
  /** A safe status/log message from the action, when present. */
  message?: string;
  /** A safe error message when `phase === "failed"`. */
  error?: string;
  /** True when this entry needs an OAuth / third-party sign-in after install, so
   * the UI can route the user into that flow rather than declaring it done. */
  needsAuthHandoff?: boolean;
};

/** Everything the MCP catalog component renders, plus the actions it invokes. */
export type McpCatalogState = {
  status: McpCatalogStatus;
  entries: HermesMcpCatalogEntry[];
  mode?: HermesAdminMode;
  profile?: string;
  /** The user-safe message when `status === "error"`. */
  error?: string;
  retryable: boolean;
  /** Per-entry install state, keyed by install name. */
  installs: ReadonlyMap<string, McpCatalogInstallState>;
  lifecycle: GatewayLifecycleSnapshot;
  notifications: readonly AdminNotification[];
  refresh: () => void;
  /** Installs a catalog entry from an already-validated payload (a background
   * action): polls to completion, surfaces progress, and on success refreshes
   * the MCP servers inventory + the catalog. */
  install: (
    entry: HermesMcpCatalogEntry,
    payload: HermesInstallCatalogPayload,
  ) => void;
  /** Clears a terminal (done/failed) install state for an entry. */
  clearInstall: (installName: string) => void;
  dismissNotification: (id: string) => void;
};

/** Test-only knobs for the install poll loop, so suites drive a backgrounded
 * install without real timers. Production constructs the controller with no
 * options and the poll uses real timers. */
export type McpCatalogControllerOptions = {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The framework-free controller the hook wraps. Holds the mutable load / install
 * state for one engine and notifies a single subscriber (the hook) on change.
 * Extracted so the install/poll/refresh rules can be tested without React.
 */
export class McpCatalogController {
  private readonly engine: McpCatalogEngine;
  private readonly pollOptions: McpCatalogControllerOptions;
  private entries: HermesMcpCatalogEntry[] = [];
  private status: McpCatalogStatus = "loading";
  private error?: string;
  private retryable = false;
  private readonly installs = new Map<string, McpCatalogInstallState>();
  private notifications: readonly AdminNotification[] = [];
  private lifecycleSnapshot: GatewayLifecycleSnapshot;
  private listeners = new Set<() => void>();
  private disposed = false;
  private loadSeq = 0;
  private readonly installAborts = new Map<string, AbortController>();
  private unsubscribers: Array<() => void> = [];
  private snapshot: McpCatalogState;

  constructor(
    engine: McpCatalogEngine,
    options: McpCatalogControllerOptions = {},
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
    // A mcpCatalog invalidation from ANY path (a gateway restart, a profile
    // switch, an install on another surface) refreshes the catalog.
    this.unsubscribers.push(
      engine.cache.subscribe("mcpCatalog", () => {
        if (this.engine.cache.isStale("mcpCatalog")) {
          void this.load();
        }
      }),
    );
  }

  getSnapshot(): McpCatalogState {
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
    for (const controller of this.installAborts.values()) controller.abort();
    this.installAborts.clear();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.listeners.clear();
  }

  /** Loads the catalog. Seeds from cache first so a refresh does not blank the
   * page, then reconciles from the network and stores the result back. */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    const cached = this.engine.cache.get<HermesMcpCatalogEntry[]>("mcpCatalog");
    if (cached) {
      this.entries = cached;
      this.status = "ready";
      this.recompute();
    } else {
      this.status = "loading";
      this.recompute();
    }

    try {
      const entries = await this.engine.client.mcp.catalog();
      if (this.disposed || seq !== this.loadSeq) return;
      this.engine.cache.set("mcpCatalog", entries);
      this.entries = entries;
      this.status = "ready";
      this.error = undefined;
      this.retryable = false;
      this.recompute();
    } catch (error) {
      if (this.disposed || seq !== this.loadSeq) return;
      const adminError = HermesAdminError.from("GET /api/mcp/catalog", error);
      this.error = adminError.safeMessage;
      this.retryable = adminError.retryable;
      this.status = this.entries.length > 0 ? "ready" : "error";
      this.recompute();
    }
  }

  refresh(): void {
    void this.load();
  }

  /**
   * Installs a catalog entry from an already-validated payload. This is a
   * BACKGROUND action: it calls `installCatalogEntry`, then polls the returned
   * action to a terminal state, surfacing live progress. On success it applies
   * the cache invalidation (mcpServers + mcpCatalog + toolsets) + the durable
   * "restart required" notification and advances the lifecycle banner (so the MCP
   * servers page refreshes itself), then refreshes the catalog. On failure the
   * safe error is surfaced inline. Never throws.
   *
   * For an OAuth / third-party entry, the install adds the server but the sign-in
   * is a separate flow; the done state carries `needsAuthHandoff` so the UI routes
   * the user there rather than declaring the integration complete.
   */
  async install(
    entry: HermesMcpCatalogEntry,
    payload: HermesInstallCatalogPayload,
  ): Promise<void> {
    const { installName } = entry;
    // Never re-enter an install that is already running for this entry.
    if (this.installs.get(installName)?.phase === "installing") return;

    this.setInstall(installName, { phase: "installing", progress: undefined });

    try {
      const outcome = await this.engine.client.mcp.installCatalogEntry(payload);
      if (this.disposed) return;
      const action = outcome.action;

      let status: HermesActionStatus | undefined = outcome.result;
      if (action && !(status?.done ?? false)) {
        const abort = new AbortController();
        this.installAborts.set(installName, abort);
        try {
          status = await this.engine.client.pollAction(action, {
            signal: abort.signal,
            intervalMs: this.pollOptions.pollIntervalMs,
            timeoutMs: this.pollOptions.pollTimeoutMs,
            sleep: this.pollOptions.sleep,
            onStatus: (latest) =>
              this.setInstall(installName, {
                phase: "installing",
                progress: latest.progress,
                message: latest.message,
              }),
          });
        } finally {
          this.installAborts.delete(installName);
        }
        if (this.disposed) return;
      }

      if (status && status.state === "failed") {
        // Reconcile the failure into the cache (raises an error notification) and
        // surface it inline on the entry.
        this.engine.cache.afterAction(
          "mcp.installCatalog",
          friendlyName(entry),
          status,
        );
        this.setInstall(installName, {
          phase: "failed",
          error: status.error ?? `Could not install ${friendlyName(entry)}.`,
        });
        return;
      }

      // Success (backgrounded-then-done, or synchronous). Invalidate the MCP
      // servers inventory + catalog + toolsets, raise the durable "restart
      // required" notification, and advance the shared banner.
      this.engine.cache.afterMutation(
        "mcp.installCatalog",
        friendlyName(entry),
      );
      this.engine.lifecycle.noteMutation(outcome.mutation);
      this.markInstalledLocally(installName, payload);
      this.setInstall(installName, {
        phase: "done",
        progress: 100,
        message: status?.message,
        needsAuthHandoff: needsAuthHandoff(entry),
      });
    } catch (error) {
      if (this.disposed) return;
      const adminError = HermesAdminError.from(
        "POST /api/mcp/catalog/install",
        error,
      );
      this.setInstall(installName, {
        phase: "failed",
        error: adminError.safeMessage,
      });
    }
  }

  /** Clears a terminal install state so the entry returns to its default action. */
  clearInstall(installName: string): void {
    if (this.installs.delete(installName)) this.recompute();
  }

  dismissNotification(id: string): void {
    this.engine.cache.dismissNotification(id);
  }

  /** Flips the local `installed`/`enabled` flag on an entry so the card reflects
   * the new state immediately, without waiting for a re-load. */
  private markInstalledLocally(
    installName: string,
    payload: HermesInstallCatalogPayload,
  ): void {
    const enabled = payload.enable !== false;
    this.entries = this.entries.map((entry) =>
      entry.installName === installName
        ? { ...entry, installed: true, enabled }
        : entry,
    );
  }

  private setInstall(
    installName: string,
    next: Omit<McpCatalogInstallState, "installName">,
  ): void {
    this.installs.set(installName, { installName, ...next });
    this.recompute();
  }

  private buildSnapshot(): McpCatalogState {
    return {
      status: this.status,
      entries: this.entries,
      mode: this.engine.target.mode,
      profile: this.engine.target.profile,
      error: this.error,
      retryable: this.retryable,
      installs: new Map(this.installs),
      lifecycle: this.lifecycleSnapshot,
      notifications: this.notifications,
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

  // Stable action identities so the snapshot's callbacks don't churn equality.
  private readonly refreshAction = (): void => {
    this.refresh();
  };
  private readonly installAction = (
    entry: HermesMcpCatalogEntry,
    payload: HermesInstallCatalogPayload,
  ): void => {
    void this.install(entry, payload);
  };
  private readonly clearInstallAction = (installName: string): void => {
    this.clearInstall(installName);
  };
  private readonly dismissNotificationAction = (id: string): void => {
    this.dismissNotification(id);
  };
}

/** A human label for an entry, used in notifications. */
function friendlyName(entry: HermesMcpCatalogEntry): string {
  return entry.name || entry.installName;
}

/**
 * Binds a {@link McpCatalogController} to React for one engine. A null engine
 * yields the "unavailable" state without constructing a controller. The
 * controller loads once on mount and tears down on unmount.
 */
export function useMcpCatalogController(
  engine: McpCatalogEngine | null,
): McpCatalogState {
  const controller = useMemo(
    () => (engine ? new McpCatalogController(engine) : null),
    [engine],
  );

  const [snapshot, setSnapshot] = useState<McpCatalogState>(() =>
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
const UNAVAILABLE_STATE: McpCatalogState = Object.freeze({
  status: "unavailable",
  entries: [],
  retryable: false,
  installs: new Map<string, McpCatalogInstallState>(),
  lifecycle: {
    state: "clean",
    label: "Up to date",
    detail: "No pending changes.",
    canRestart: false,
  },
  notifications: [],
  refresh: () => {},
  install: () => {},
  clearInstall: () => {},
  dismissNotification: () => {},
}) as McpCatalogState;

/**
 * Production helper: derives the {@link McpCatalogEngine} from a live bridge
 * status for a chosen mode, returning null when that mode is not running. Built
 * with `useMemo` keyed on the selected connection's identity. Profile selection
 * is explicit via {@link adminTargetForMode}. The client routes through the Rust
 * proxy.
 */
export function useMcpCatalogEngine(
  bridge: HermesBridgeStatus | undefined,
  mode: HermesAdminMode,
  profile?: string,
): McpCatalogEngine | null {
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
 * {@link useMcpCatalogController} with a harness engine so they need no Tauri mock.
 */
export function useMcpCatalog(
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
): McpCatalogState {
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

  const engine = useMcpCatalogEngine(bridge, mode, profile);
  const state = useMcpCatalogController(engine);

  if (engine === null && bridgeError) {
    return { ...state, status: "error", error: bridgeError, retryable: true };
  }
  return state;
}
