/**
 * The data hook behind June's MCP diagnostics surface (spec 18). It does NOT own
 * a second load lifecycle: it reuses the spec-14 {@link McpServersController}
 * (one engine, one client, one cache, one lifecycle) for the server list and the
 * per-server test probes, and layers the diagnostics derivation on top:
 *
 * - {@link diagnoseServer} per server (policy resolution, issues, freshness);
 * - {@link summarizeHealth} for the global counts;
 * - "Run all tests" that fans the existing per-server `test` action across every
 *   server sequentially, so each row's discovered-tools and last-test status
 *   update through the same path a single test does;
 * - {@link explainMissingTool} for the reason-chain lookup.
 *
 * Reusing the servers controller means a restart on another surface, a profile
 * switch, or a test from the servers page all reflect here through the SAME
 * cache invalidation bus. Profile targeting stays explicit (the engine is built
 * from one target). This surface never mutates a server beyond running tests.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hermesBridgeStatus, type HermesBridgeStatus } from "../tauri";
import type { GatewayLifecycleSnapshot } from "./gateway-lifecycle";
import type { HermesAdminMode } from "./target";
import {
  buildDiagnosticBundle,
  diagnoseServer,
  explainMissingTool,
  summarizeHealth,
  type McpDiagnosticBundle,
  type McpHealthSummary,
  type MissingToolReason,
  type ServerDiagnostics,
} from "./mcp-diagnostics-view";
import type { HermesMcpServerInfo, HermesMcpTestResult } from "./schemas";
import {
  useMcpServersController,
  useMcpServersEngine,
  type McpServersEngine,
  type McpServersState,
} from "./use-mcp-servers";

/** True when the gateway has a pending restart, so the shown tool inventory is
 * stale until the gateway rebuilds it. */
export function restartPendingFromLifecycle(
  snapshot: GatewayLifecycleSnapshot,
): boolean {
  return (
    snapshot.state === "gateway-restart-required" ||
    snapshot.state === "active-session-should-restart" ||
    snapshot.state === "restart-in-progress"
  );
}

/** Everything the diagnostics component renders, plus the actions it invokes. */
export type McpDiagnosticsState = {
  status: McpServersState["status"];
  mode?: McpServersState["mode"];
  profile?: string;
  error?: string;
  retryable: boolean;
  lifecycle: GatewayLifecycleSnapshot;
  notifications: McpServersState["notifications"];
  /** Whether the inventory is stale pending a gateway restart. */
  restartPending: boolean;
  /** Per-server diagnostics, in list order. */
  servers: ServerDiagnostics[];
  /** The global health summary. */
  summary: McpHealthSummary;
  /** Server names with a test in flight. */
  testing: ReadonlySet<string>;
  /** True while "Run all tests" is iterating. */
  runningAll: boolean;
  /** The current missing-tool query and its resolved reason, when a query is
   * entered. */
  toolQuery: string;
  toolReason?: MissingToolReason;
  refresh: () => void;
  /** Tests one server (delegates to the servers controller). */
  test: (name: string) => void;
  /** Runs every server's test sequentially. */
  runAllTests: () => Promise<void>;
  /** Sets the missing-tool query (empty clears the result). */
  setToolQuery: (query: string) => void;
  /** Builds the sanitized export bundle for the current state. */
  buildBundle: (now?: Date) => McpDiagnosticBundle;
  dismissNotification: (id: string) => void;
};

/** The frozen state shown when there is no runtime to talk to. */
const UNAVAILABLE_STATE: McpDiagnosticsState = Object.freeze({
  status: "unavailable",
  retryable: false,
  lifecycle: {
    state: "clean",
    label: "Up to date",
    detail: "No pending changes.",
    canRestart: false,
  },
  notifications: [],
  restartPending: false,
  servers: [],
  summary: {
    total: 0,
    enabled: 0,
    disabled: 0,
    failing: 0,
    authNeeded: 0,
    restartPending: false,
  },
  testing: new Set<string>(),
  runningAll: false,
  toolQuery: "",
  refresh: () => {},
  test: () => {},
  runAllTests: () => Promise.resolve(),
  setToolQuery: () => {},
  buildBundle: () => ({
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(),
    profile: "default",
    mode: "sandboxed",
    summary: {
      total: 0,
      enabled: 0,
      disabled: 0,
      failing: 0,
      authNeeded: 0,
      restartPending: false,
    },
    notes: [],
    servers: [],
  }),
  dismissNotification: () => {},
}) as McpDiagnosticsState;

/**
 * Binds the diagnostics derivation to the shared servers controller for one
 * engine. A null engine yields the "unavailable" state. The component calls
 * {@link useMcpDiagnostics}; tests call this with a harness-built engine so they
 * need no Tauri mock.
 */
export function useMcpDiagnosticsController(
  engine: McpServersEngine | null,
): McpDiagnosticsState {
  const servers = useMcpServersController(engine);
  const [runningAll, setRunningAll] = useState(false);
  const [toolQuery, setToolQueryState] = useState("");

  const restartPending = restartPendingFromLifecycle(servers.lifecycle);

  // The last successful test result per server, read out of the servers
  // controller's per-server test state, so discovered tools feed diagnostics.
  const testResults = useMemo(() => {
    const map = new Map<string, HermesMcpTestResult>();
    for (const [name, state] of servers.tests) {
      if (state.result) map.set(name, state.result);
    }
    return map;
  }, [servers.tests]);

  const diagnostics = useMemo(
    () =>
      servers.servers.map((server) =>
        diagnoseServer(server, {
          testResult: testResults.get(server.name),
          restartPending,
        }),
      ),
    [servers.servers, testResults, restartPending],
  );

  const summary = useMemo(
    () => summarizeHealth(servers.servers, restartPending),
    [servers.servers, restartPending],
  );

  const testing = useMemo(() => {
    const set = new Set<string>();
    for (const [name, state] of servers.tests) {
      if (state.pending) set.add(name);
    }
    return set;
  }, [servers.tests]);

  const toolReason = useMemo<MissingToolReason | undefined>(() => {
    if (!toolQuery.trim()) return undefined;
    return explainMissingTool(servers.servers, toolQuery, { testResults });
  }, [servers.servers, toolQuery, testResults]);

  const runAllTests = useCallback(async () => {
    setRunningAll(true);
    try {
      for (const server of servers.servers) {
        await servers.test(server.name);
      }
    } finally {
      setRunningAll(false);
    }
  }, [servers]);

  const buildBundle = useCallback(
    (now?: Date) =>
      buildDiagnosticBundle(servers.servers, {
        profile: servers.profile ?? "default",
        mode: servers.mode ?? "sandboxed",
        restartPending,
        testResults,
        now,
      }),
    [
      servers.servers,
      servers.profile,
      servers.mode,
      restartPending,
      testResults,
    ],
  );

  const setToolQuery = useCallback((query: string) => {
    setToolQueryState(query);
  }, []);

  if (!engine) return UNAVAILABLE_STATE;

  return {
    status: servers.status,
    mode: servers.mode,
    profile: servers.profile,
    error: servers.error,
    retryable: servers.retryable,
    lifecycle: servers.lifecycle,
    notifications: servers.notifications,
    restartPending,
    servers: diagnostics,
    summary,
    testing,
    runningAll,
    toolQuery,
    toolReason,
    refresh: servers.refresh,
    test: (name: string) => void servers.test(name),
    runAllTests,
    setToolQuery,
    buildBundle,
    dismissNotification: servers.dismissNotification,
  };
}

/**
 * The all-in-one production hook: fetch bridge status once, derive the engine
 * for the given mode/profile (explicit targeting, no first-connection
 * fallback), and run the diagnostics controller. The page calls THIS; tests
 * prefer {@link useMcpDiagnosticsController} with a harness engine.
 */
export function useMcpDiagnostics(
  mode: HermesAdminMode = "sandboxed",
  profile?: string,
): McpDiagnosticsState {
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
  const state = useMcpDiagnosticsController(engine);

  if (engine === null && bridgeError) {
    return { ...state, status: "error", error: bridgeError, retryable: true };
  }
  return state;
}

/** A convenience export so callers can build their own diagnostics from a bare
 * server list without the controller (e.g. a snapshot in another surface). */
export function diagnoseServers(
  servers: readonly HermesMcpServerInfo[],
  options: {
    restartPending?: boolean;
    testResults?: Map<string, HermesMcpTestResult>;
  } = {},
): ServerDiagnostics[] {
  return servers.map((server) =>
    diagnoseServer(server, {
      testResult: options.testResults?.get(server.name),
      restartPending: options.restartPending,
    }),
  );
}
