/**
 * Pure, render-free view logic for the MCP diagnostics + tool inventory surface
 * (spec 18): per-server diagnostics derivation, the global health summary, the
 * missing-tool REASON CHAIN, and the SANITIZED diagnostic bundle exported for
 * support. Kept separate from the React component and the data hook so the
 * reason generation, the include/exclude resolution, and the redaction of the
 * export are unit-testable without rendering and without a network.
 *
 * This surface READS MCP server data; it never mutates a server. It reuses the
 * spec-14 view helpers (transport / auth / status labels, secret redaction) and
 * the spec-16/17 filtering / OAuth helpers rather than reinventing them, and
 * derives the diagnostics layer on top.
 *
 * Three hard rules this module owns:
 * - Every reason June emits is CONCRETE and ACTIONABLE ("... is not available
 *   because tool filtering excludes delete_workspace. Remove it from the exclude
 *   list."), never a generic "something went wrong".
 * - The panel DISTINGUISHES test-time discovery (what a `/test` probe found) from
 *   runtime registration (the `mcp_<server>_<tool>` names the gateway exposes).
 *   v2026.6.19 has no REST endpoint that lists runtime-registered tools, so June
 *   labels registration as DERIVED and says so.
 * - The exported bundle is run through the shared structural redactor so no env
 *   value, header value, token, or bearer string can leave the machine.
 *
 * Copy is sentence case, no em/en-dashes, per June conventions.
 */

import { redactForLog } from "./redact";
import type {
  HermesMcpServerInfo,
  HermesMcpTestResult,
  HermesMcpToolInfo,
} from "./schemas";
import { oauthStateFor, type McpOauthStatus } from "./mcp-oauth-view";

// ---------------------------------------------------------------------------
// Tool prefixing — Hermes registers MCP tools as `mcp_<server>_<tool>`.
// ---------------------------------------------------------------------------

/** The prefix Hermes adds when it registers an MCP server's tool with the agent.
 * A server-native tool `delete_workspace` on server `linear` is registered as
 * `mcp_linear_delete_workspace`. This is the one place that mapping lives. */
export function registeredToolName(server: string, tool: string): string {
  return `mcp_${server}_${tool}`;
}

/** Strips the `mcp_<server>_` prefix from a registered name back to the
 * server-native tool name, or returns the input unchanged when it does not match
 * this server's prefix (so a bare native name is tolerated). */
export function nativeToolName(server: string, registered: string): string {
  const prefix = `mcp_${server}_`;
  return registered.startsWith(prefix)
    ? registered.slice(prefix.length)
    : registered;
}

// ---------------------------------------------------------------------------
// Include/exclude resolution — which native tools are allowed.
// ---------------------------------------------------------------------------

/** Why a single native tool is or is not in the allowed set, after filters. */
export type ToolAllowReason =
  | "allowed"
  | "excluded"
  | "not-in-include"
  | "server-flagged-off";

/** One native tool's resolution against a server's include/exclude policy and
 * its own reported `enabled` flag. */
export type ResolvedTool = {
  /** The server-native tool name (e.g. `delete_workspace`). */
  name: string;
  /** The registered name the agent sees (e.g. `mcp_linear_delete_workspace`). */
  registered: string;
  description?: string;
  /** True when this tool is exposed to the agent after all filters. */
  allowed: boolean;
  reason: ToolAllowReason;
};

/** The resolved include/exclude policy for a server: the effective allowed
 * native tools, the ones filtered out, and the raw policy lists for display. */
export type ResolvedToolPolicy = {
  /** True when an explicit include list is configured (allowlist mode). When
   * present, only listed tools are allowed; everything else is `not-in-include`. */
  hasInclude: boolean;
  include: string[];
  exclude: string[];
  /** Every known native tool, resolved. */
  tools: ResolvedTool[];
  /** The allowed native tool names, in input order. */
  allowed: string[];
  /** The filtered-out native tool names, in input order. */
  filtered: string[];
};

/**
 * Resolves a server's include/exclude policy over the tools it is known to
 * expose. The known set is the union of the server's reported tools and any
 * extra names supplied (e.g. discovered by a test probe), so a tool the user
 * asks about that was discovered but not in the stored list still resolves.
 *
 * Resolution order, matching Hermes' filter semantics:
 * 1. an explicit `exclude` always wins (a tool on the exclude list is filtered);
 * 2. an explicit `include` list is an allowlist (a tool NOT on it is filtered);
 * 3. a tool the server itself reports `enabled: false` is filtered;
 * 4. otherwise the tool is allowed.
 */
export function resolveToolPolicy(
  server: HermesMcpServerInfo,
  extraToolNames: readonly string[] = [],
): ResolvedToolPolicy {
  const include = server.includeTools ?? [];
  const exclude = server.excludeTools ?? [];
  const hasInclude = include.length > 0;
  const includeSet = new Set(include);
  const excludeSet = new Set(exclude);

  const reportedTools = server.tools ?? [];
  const byName = new Map<string, HermesMcpToolInfo>();
  for (const tool of reportedTools) {
    if (!byName.has(tool.name)) byName.set(tool.name, tool);
  }
  // Preserve order: reported tools first, then any extra discovered names.
  const order: string[] = [];
  const seen = new Set<string>();
  for (const tool of reportedTools) {
    if (!seen.has(tool.name)) {
      seen.add(tool.name);
      order.push(tool.name);
    }
  }
  for (const name of extraToolNames) {
    if (!seen.has(name)) {
      seen.add(name);
      order.push(name);
    }
  }

  const tools: ResolvedTool[] = order.map((name) => {
    const info = byName.get(name);
    let reason: ToolAllowReason;
    if (excludeSet.has(name)) {
      reason = "excluded";
    } else if (hasInclude && !includeSet.has(name)) {
      reason = "not-in-include";
    } else if (info?.enabled === false) {
      reason = "server-flagged-off";
    } else {
      reason = "allowed";
    }
    return {
      name,
      registered: registeredToolName(server.name, name),
      description: info?.description,
      allowed: reason === "allowed",
      reason,
    };
  });

  return {
    hasInclude,
    include,
    exclude,
    tools,
    allowed: tools.filter((tool) => tool.allowed).map((tool) => tool.name),
    filtered: tools.filter((tool) => !tool.allowed).map((tool) => tool.name),
  };
}

// ---------------------------------------------------------------------------
// Per-server diagnostics
// ---------------------------------------------------------------------------

/** A single problem June found with a server, in priority order, each with a
 * concrete fix. The UI styles by tone and may surface `fix` as the next step. */
export type ServerDiagnosticIssue = {
  /** Stable key for the issue category, for styling / testing. */
  code:
    | "disabled"
    | "auth-missing"
    | "auth-expired"
    | "connection-error"
    | "untested"
    | "filter-excludes-all"
    | "no-tools";
  tone: "error" | "attention" | "neutral";
  /** Sentence-case summary of the problem. */
  message: string;
  /** Sentence-case actionable next step. */
  fix: string;
};

/** Whether the tool inventory shown for a server is fresh or stale relative to a
 * pending gateway restart. After an MCP change the gateway must restart before
 * its tool inventory is rebuilt, so what June shows is the LAST-KNOWN inventory
 * until then. */
export type InventoryFreshness = "fresh" | "restart-pending" | "never-tested";

/** Everything the diagnostics panel renders for one server. */
export type ServerDiagnostics = {
  server: HermesMcpServerInfo;
  /** The resolved include/exclude policy + allowed tools. */
  policy: ResolvedToolPolicy;
  /** Server-native tools discovered by the last test probe (test-time
   * discovery), distinct from what the gateway registered at runtime. */
  discoveredTools: HermesMcpToolInfo[];
  /** True when the discovered list came from a real probe (vs the stored list). */
  discoveredFromTest: boolean;
  /** The `mcp_<server>_<tool>` names June DERIVES would be registered, given the
   * allowed tools. Labelled derived because v2026.6.19 exposes no runtime
   * registry endpoint. */
  derivedRegisteredTools: string[];
  /** The OAuth/token state, when this server uses OAuth. */
  oauthState?: McpOauthStatus;
  /** Whether resource/prompt utility tools are available, when the server
   * reports the capability. `undefined` when upstream is silent. */
  resourcesAvailable?: boolean;
  promptsAvailable?: boolean;
  /** Configured timeout values (seconds), when reported. */
  timeoutSeconds?: number;
  connectTimeoutSeconds?: number;
  /** Env / header KEY names the server is missing a value for, when the wire
   * reports a missing-config signal. Never a value. */
  missingEnv: string[];
  missingHeaders: string[];
  /** Whether the shown inventory is fresh, pending a restart, or never tested. */
  freshness: InventoryFreshness;
  /** The problems found, highest-priority first. Empty when the server is
   * healthy. */
  issues: ServerDiagnosticIssue[];
};

/**
 * Derives the full diagnostics for one server. `testResult` is the last probe
 * the user ran (test-time discovery); `restartPending` says the gateway has a
 * pending restart so the inventory is stale. Pure: reads only the parsed server
 * and the optional probe.
 */
export function diagnoseServer(
  server: HermesMcpServerInfo,
  options: {
    testResult?: HermesMcpTestResult;
    restartPending?: boolean;
  } = {},
): ServerDiagnostics {
  const { testResult, restartPending = false } = options;
  const discoveredFromTest = Boolean(testResult && testResult.ok);
  const discoveredTools = discoveredFromTest
    ? (testResult?.tools ?? [])
    : (server.tools ?? []);

  const policy = resolveToolPolicy(
    server,
    discoveredTools.map((tool) => tool.name),
  );

  const oauthState = serverUsesOauth(server)
    ? oauthStateFor(server)
    : undefined;

  // A server only registers tools when it is enabled, signed in (if it uses
  // OAuth), and not in a failed connection. Otherwise NOTHING registers, so the
  // derived registered names are empty even if filters would have allowed some.
  const canRegister =
    server.enabled &&
    oauthState !== "needs-sign-in" &&
    oauthState !== "expired" &&
    oauthState !== "unknown" &&
    server.status !== "error";
  const derivedRegisteredTools = canRegister
    ? policy.allowed.map((name) => registeredToolName(server.name, name))
    : [];
  const record = asRecord(server.raw);
  const utilities = readUtilityAvailability(record);
  const timeouts = readTimeouts(record);
  const missing = readMissingConfig(record);

  const freshness: InventoryFreshness = restartPending
    ? "restart-pending"
    : server.status === undefined || server.status === "untested"
      ? "never-tested"
      : "fresh";

  const issues = collectIssues(server, policy, oauthState);

  return {
    server,
    policy,
    discoveredTools,
    discoveredFromTest,
    derivedRegisteredTools,
    oauthState,
    resourcesAvailable: utilities.resources,
    promptsAvailable: utilities.prompts,
    timeoutSeconds: timeouts.timeout,
    connectTimeoutSeconds: timeouts.connect,
    missingEnv: missing.env,
    missingHeaders: missing.headers,
    freshness,
    issues,
  };
}

/** Builds the prioritized issue list for a server. Disabled is the headline
 * problem (nothing else matters until it is enabled); then auth, then a
 * connection failure, then a filter that hides everything, then "no tools". */
function collectIssues(
  server: HermesMcpServerInfo,
  policy: ResolvedToolPolicy,
  oauthState: McpOauthStatus | undefined,
): ServerDiagnosticIssue[] {
  const issues: ServerDiagnosticIssue[] = [];

  if (!server.enabled) {
    issues.push({
      code: "disabled",
      tone: "attention",
      message: `${server.name} is disabled, so none of its tools are registered.`,
      fix: "Enable the server, then restart the Hermes gateway.",
    });
    // A disabled server is the root cause; do not pile on downstream noise.
    return issues;
  }

  if (oauthState === "needs-sign-in" || oauthState === "unknown") {
    issues.push({
      code: "auth-missing",
      tone: "attention",
      message: `${server.name} is not signed in, so its tools cannot load.`,
      fix: "Sign in to the server, then restart the Hermes gateway.",
    });
  } else if (oauthState === "expired") {
    issues.push({
      code: "auth-expired",
      tone: "attention",
      message: `The sign-in for ${server.name} expired, so its tools cannot load.`,
      fix: "Sign in again, then restart the Hermes gateway.",
    });
  }

  if (server.status === "error") {
    issues.push({
      code: "connection-error",
      tone: "error",
      message:
        server.statusMessage ?? `${server.name} failed its last connection.`,
      fix: "Fix the connection, then test the server again.",
    });
  } else if (server.status === undefined || server.status === "untested") {
    issues.push({
      code: "untested",
      tone: "neutral",
      message: `${server.name} has not been tested, so its tools are unconfirmed.`,
      fix: "Run a test to confirm the server connects and lists its tools.",
    });
  }

  const knownToolCount = policy.tools.length;
  if (knownToolCount > 0 && policy.allowed.length === 0) {
    issues.push({
      code: "filter-excludes-all",
      tone: "attention",
      message: `Tool filtering hides every tool on ${server.name}, so it registers nothing.`,
      fix: policy.hasInclude
        ? "Add at least one tool to the include list, or clear it."
        : "Remove tools from the exclude list.",
    });
  } else if (knownToolCount === 0 && server.status === "connected") {
    issues.push({
      code: "no-tools",
      tone: "neutral",
      message: `${server.name} connected but reported no tools.`,
      fix: "Check the server exposes tools, or update it.",
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Missing-tool reason chain
// ---------------------------------------------------------------------------

/** The outcome of asking "why isn't this tool available?". `available` means it
 * is exposed; otherwise `reason` is a concrete, actionable explanation. */
export type MissingToolReason = {
  /** The registered name asked about (e.g. `mcp_linear_delete_workspace`). */
  query: string;
  /** The server this resolved to, when one matched. */
  server?: string;
  /** The native tool name, when parseable. */
  tool?: string;
  available: boolean;
  /** A concrete, actionable sentence. Empty when `available` is true. */
  reason: string;
};

/**
 * Explains why a tool is or is not available to the agent, producing the spec's
 * reason chain. Accepts either a registered name (`mcp_linear_delete_workspace`)
 * or, when `serverName` is given, a bare native name. Walks the same causes
 * `diagnoseServer` does, most-fundamental first:
 *
 * 1. no such server configured;
 * 2. the server is disabled (enable + restart);
 * 3. the server is not signed in / expired (sign in + restart);
 * 4. the server failed its connection (fix connection + test);
 * 5. tool filtering excludes it / it is not in the include list;
 * 6. the server does not expose a tool by that name;
 * 7. otherwise it IS available.
 */
export function explainMissingTool(
  servers: readonly HermesMcpServerInfo[],
  query: string,
  options: {
    serverName?: string;
    testResults?: Map<string, HermesMcpTestResult>;
  } = {},
): MissingToolReason {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      query,
      available: false,
      reason: "Enter a tool name to diagnose.",
    };
  }

  const resolved = resolveQueryTarget(servers, trimmed, options.serverName);
  if (!resolved.server) {
    return {
      query: trimmed,
      tool: resolved.tool,
      available: false,
      reason: resolved.serverName
        ? `No MCP server named ${resolved.serverName} is configured. Add it first.`
        : `${trimmed} does not match any configured MCP server. Tool names look like mcp_<server>_<tool>.`,
    };
  }

  const server = resolved.server;
  const tool = resolved.tool ?? trimmed;
  const registered = registeredToolName(server.name, tool);
  const oauthState = serverUsesOauth(server)
    ? oauthStateFor(server)
    : undefined;

  if (!server.enabled) {
    return {
      query: trimmed,
      server: server.name,
      tool,
      available: false,
      reason: `${registered} is not registered because the ${server.name} server is disabled. Enable it and restart the gateway.`,
    };
  }

  if (oauthState === "needs-sign-in" || oauthState === "unknown") {
    return {
      query: trimmed,
      server: server.name,
      tool,
      available: false,
      reason: `${registered} is not available because ${server.name} is not signed in. Sign in and restart the gateway.`,
    };
  }
  if (oauthState === "expired") {
    return {
      query: trimmed,
      server: server.name,
      tool,
      available: false,
      reason: `${registered} is not available because the ${server.name} sign-in expired. Sign in again and restart the gateway.`,
    };
  }

  if (server.status === "error") {
    return {
      query: trimmed,
      server: server.name,
      tool,
      available: false,
      reason: `${registered} is not available because ${server.name} failed its last connection. Fix the connection and test the server again.`,
    };
  }

  const testResult = options.testResults?.get(server.name);
  const discovered =
    testResult && testResult.ok ? (testResult.tools ?? []) : undefined;
  const policy = resolveToolPolicy(
    server,
    (discovered ?? []).map((entry) => entry.name),
  );
  const resolvedTool = policy.tools.find((entry) => entry.name === tool);

  if (resolvedTool) {
    if (resolvedTool.allowed) {
      return {
        query: trimmed,
        server: server.name,
        tool,
        available: true,
        reason: "",
      };
    }
    if (resolvedTool.reason === "excluded") {
      return {
        query: trimmed,
        server: server.name,
        tool,
        available: false,
        reason: `${registered} is not available because tool filtering excludes ${tool}. Remove it from the exclude list and restart the gateway.`,
      };
    }
    if (resolvedTool.reason === "not-in-include") {
      return {
        query: trimmed,
        server: server.name,
        tool,
        available: false,
        reason: `${registered} is not available because the include list for ${server.name} does not list ${tool}. Add it to the include list and restart the gateway.`,
      };
    }
    // server-flagged-off
    return {
      query: trimmed,
      server: server.name,
      tool,
      available: false,
      reason: `${registered} is not available because ${server.name} reports ${tool} as turned off.`,
    };
  }

  // The server connected/known but does not expose a tool by this name.
  const known = policy.tools.length > 0;
  return {
    query: trimmed,
    server: server.name,
    tool,
    available: false,
    reason: known
      ? `${registered} is not available because ${server.name} does not expose a tool named ${tool}. Test the server to see its current tools.`
      : `${registered} cannot be confirmed because ${server.name} has not reported its tools yet. Test the server first.`,
  };
}

/** Resolves a query to a server + native tool. Prefers an explicit
 * `serverName`; otherwise matches a `mcp_<server>_<tool>` registered name by
 * finding the configured server whose name prefixes the query. */
function resolveQueryTarget(
  servers: readonly HermesMcpServerInfo[],
  query: string,
  serverName?: string,
): { server?: HermesMcpServerInfo; serverName?: string; tool?: string } {
  if (serverName) {
    const server = servers.find((entry) => entry.name === serverName);
    return { server, serverName, tool: nativeToolName(serverName, query) };
  }
  if (query.startsWith("mcp_")) {
    // Match the longest server name that prefixes the remainder, so a server
    // named `linear` matches `mcp_linear_delete_workspace`.
    const rest = query.slice("mcp_".length);
    let best: HermesMcpServerInfo | undefined;
    for (const server of servers) {
      if (rest === server.name || rest.startsWith(`${server.name}_`)) {
        if (!best || server.name.length > best.name.length) best = server;
      }
    }
    if (best) {
      return {
        server: best,
        serverName: best.name,
        tool: rest.slice(best.name.length + 1),
      };
    }
    return { serverName: rest.split("_")[0] };
  }
  // A bare name with no server context: ambiguous. Try an exact native match
  // against any single server that exposes it.
  const matches = servers.filter((server) =>
    (server.tools ?? []).some((tool) => tool.name === query),
  );
  if (matches.length === 1) {
    return { server: matches[0], serverName: matches[0].name, tool: query };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Global health summary
// ---------------------------------------------------------------------------

/** Aggregate health counts across every configured server, for the global
 * diagnostics header (the spec's "summary counts"). */
export type McpHealthSummary = {
  total: number;
  enabled: number;
  disabled: number;
  /** Servers whose last connection failed. */
  failing: number;
  /** Servers that use OAuth and are not signed in / expired. */
  authNeeded: number;
  /** True when the gateway has a pending restart (the inventory is stale). */
  restartPending: boolean;
};

/** Computes the global health summary. `restartPending` is supplied by the
 * caller from the gateway lifecycle state. */
export function summarizeHealth(
  servers: readonly HermesMcpServerInfo[],
  restartPending: boolean,
): McpHealthSummary {
  let enabled = 0;
  let disabled = 0;
  let failing = 0;
  let authNeeded = 0;
  for (const server of servers) {
    if (server.enabled) enabled += 1;
    else disabled += 1;
    if (server.enabled && server.status === "error") failing += 1;
    if (server.enabled && serverUsesOauth(server)) {
      const state = oauthStateFor(server);
      if (
        state === "needs-sign-in" ||
        state === "expired" ||
        state === "unknown"
      ) {
        authNeeded += 1;
      }
    }
  }
  return {
    total: servers.length,
    enabled,
    disabled,
    failing,
    authNeeded,
    restartPending,
  };
}

// ---------------------------------------------------------------------------
// Sanitized diagnostic bundle export
// ---------------------------------------------------------------------------

/** The version stamp of the bundle schema, so a support engineer can tell what
 * shape they are reading. */
export const MCP_DIAGNOSTIC_BUNDLE_VERSION = 1;

/** One server's entry in the exported bundle. Carries NO secret value: env /
 * header KEY names only, plus derived diagnostics. */
export type McpDiagnosticBundleServer = {
  name: string;
  enabled: boolean;
  transport: HermesMcpServerInfo["transport"];
  status?: HermesMcpServerInfo["status"];
  statusMessage?: string;
  auth: HermesMcpServerInfo["auth"];
  /** Env KEY names only (never values). */
  envKeys: string[];
  /** Header KEY names only (never values). */
  headerKeys: string[];
  includeTools: string[];
  excludeTools: string[];
  discoveredTools: string[];
  discoveredFromTest: boolean;
  allowedTools: string[];
  filteredTools: string[];
  derivedRegisteredTools: string[];
  timeoutSeconds?: number;
  connectTimeoutSeconds?: number;
  missingEnv: string[];
  missingHeaders: string[];
  issues: Array<{ code: string; message: string; fix: string }>;
};

/** The full sanitized bundle a user exports for support. */
export type McpDiagnosticBundle = {
  schemaVersion: number;
  generatedAt: string;
  profile: string;
  mode: string;
  summary: McpHealthSummary;
  /** A clear statement of what is measured vs derived, so support does not
   * misread runtime registration. */
  notes: string[];
  servers: McpDiagnosticBundleServer[];
};

/**
 * Builds a SANITIZED diagnostic bundle for support. Every server is reduced to
 * non-secret facts (key NAMES, never values), and the whole structure is run
 * through the shared structural redactor as a backstop so a secret-shaped value
 * that slipped into a status message or a raw field is masked before export.
 */
export function buildDiagnosticBundle(
  servers: readonly HermesMcpServerInfo[],
  options: {
    profile: string;
    mode: string;
    restartPending: boolean;
    testResults?: Map<string, HermesMcpTestResult>;
    now?: Date;
  },
): McpDiagnosticBundle {
  const {
    profile,
    mode,
    restartPending,
    testResults,
    now = new Date(),
  } = options;
  const summary = summarizeHealth(servers, restartPending);
  const serverEntries = servers.map((server) => {
    const diagnostics = diagnoseServer(server, {
      testResult: testResults?.get(server.name),
      restartPending,
    });
    return {
      name: server.name,
      enabled: server.enabled,
      transport: server.transport,
      status: server.status,
      statusMessage: scrubFreeText(server.statusMessage),
      auth: server.auth,
      envKeys: configKeyNames(server, ["env", "environment", "env_vars"]),
      headerKeys: configKeyNames(server, ["headers", "http_headers"]),
      includeTools: diagnostics.policy.include,
      excludeTools: diagnostics.policy.exclude,
      discoveredTools: diagnostics.discoveredTools.map((tool) => tool.name),
      discoveredFromTest: diagnostics.discoveredFromTest,
      allowedTools: diagnostics.policy.allowed,
      filteredTools: diagnostics.policy.filtered,
      derivedRegisteredTools: diagnostics.derivedRegisteredTools,
      timeoutSeconds: diagnostics.timeoutSeconds,
      connectTimeoutSeconds: diagnostics.connectTimeoutSeconds,
      missingEnv: diagnostics.missingEnv,
      missingHeaders: diagnostics.missingHeaders,
      issues: diagnostics.issues.map((issue) => ({
        code: issue.code,
        // The connection-error message echoes the server's status message,
        // which may carry a secret-shaped token in free text; scrub it.
        message: scrubFreeText(issue.message) ?? issue.message,
        fix: issue.fix,
      })),
    } satisfies McpDiagnosticBundleServer;
  });

  const bundle: McpDiagnosticBundle = {
    schemaVersion: MCP_DIAGNOSTIC_BUNDLE_VERSION,
    generatedAt: now.toISOString(),
    profile,
    mode,
    summary,
    notes: [
      "Tool values, env values, and header values are never included.",
      "Discovered tools come from a test probe (test-time discovery).",
      "Registered tool names are derived from the allowed tools; this Hermes version exposes no runtime registry to read.",
    ],
    servers: serverEntries,
  };

  // Backstop: structurally redact the whole bundle so anything secret-shaped
  // that leaked into a status message or a derived field is masked on export.
  return redactForLog(bundle) as McpDiagnosticBundle;
}

/** Serializes the bundle to a pretty JSON string for download. */
export function serializeDiagnosticBundle(bundle: McpDiagnosticBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/** A stable, filesystem-safe filename for a downloaded bundle. */
export function diagnosticBundleFilename(
  profile: string,
  now: Date = new Date(),
): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const safeProfile = profile.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `mcp-diagnostics-${safeProfile}-${stamp}.json`;
}

// ---------------------------------------------------------------------------
// Local, dependency-free readers
// ---------------------------------------------------------------------------

/** Mirror of `mcp-oauth-view`'s applicability without importing its private
 * helper: a server uses OAuth when its transport is `http-oauth` or it reports a
 * real (non `not-required`) auth status. */
function serverUsesOauth(server: HermesMcpServerInfo): boolean {
  if (server.transport === "http-oauth") return true;
  if (server.transport === "stdio") return false;
  return (
    server.auth === "authenticated" ||
    server.auth === "unauthenticated" ||
    server.auth === "expired"
  );
}

/** Reads whether the server exposes resource/prompt utility capabilities. Reads
 * a few documented shapes (`capabilities.resources`, `resources: true`, a
 * `utilities` block); leaves each undefined when upstream is silent so the UI
 * marks it unknown rather than guessing. */
function readUtilityAvailability(record: Record<string, unknown> | undefined): {
  resources?: boolean;
  prompts?: boolean;
} {
  if (!record) return {};
  const caps =
    asRecord(record.capabilities) ??
    asRecord(record.utilities) ??
    asRecord(record.features);
  const resources =
    pickBool(caps, ["resources", "resource"]) ??
    pickBool(record, ["resources", "supports_resources", "has_resources"]);
  const prompts =
    pickBool(caps, ["prompts", "prompt"]) ??
    pickBool(record, ["prompts", "supports_prompts", "has_prompts"]);
  return { resources, prompts };
}

/** Reads configured timeout values (seconds). Tolerates top-level or nested
 * timeout fields. Returns undefined for an absent / non-numeric value. */
function readTimeouts(record: Record<string, unknown> | undefined): {
  timeout?: number;
  connect?: number;
} {
  if (!record) return {};
  const nested = asRecord(record.timeouts) ?? asRecord(record.timeout_config);
  const timeout =
    pickNumber(nested, ["timeout", "timeout_seconds", "request"]) ??
    pickNumber(record, ["timeout", "timeout_seconds", "timeoutSeconds"]);
  const connect =
    pickNumber(nested, ["connect", "connect_timeout", "connect_seconds"]) ??
    pickNumber(record, [
      "connect_timeout",
      "connect_timeout_seconds",
      "connectTimeout",
    ]);
  return { timeout, connect };
}

/** Reads env / header KEY names a server reports as MISSING a value (a missing
 * config signal). Tolerates a `missing_env` array, a `missing.env` block, or a
 * `{ KEY: { configured: false } }` map. Reads KEY NAMES only. */
function readMissingConfig(record: Record<string, unknown> | undefined): {
  env: string[];
  headers: string[];
} {
  if (!record) return { env: [], headers: [] };
  const missing = asRecord(record.missing);
  const env = stringList(
    record.missing_env ?? record.missingEnv ?? missing?.env,
  );
  const headers = stringList(
    record.missing_headers ?? record.missingHeaders ?? missing?.headers,
  );
  return { env, headers };
}

/** Reads the KEY NAMES from a server's `env`/`headers` config (never values),
 * tolerating a `{ KEY: value }` map or an array of `{ key }` entries. */
function configKeyNames(server: HermesMcpServerInfo, keys: string[]): string[] {
  const record = asRecord(server.raw);
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    const names = keyNamesOf(value);
    if (names.length > 0) return names;
  }
  return [];
}

function keyNamesOf(value: unknown): string[] {
  const record = asRecord(value);
  if (record) {
    return Object.keys(record).filter((key) => key.trim().length > 0);
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const entry of value) {
      const entryRecord = asRecord(entry);
      const name =
        entryRecord && pickString(entryRecord, ["key", "name", "header"]);
      if (name) out.push(name);
    }
    return out;
  }
  return [];
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      out.push(entry.trim());
    } else {
      const record = asRecord(entry);
      const name = record && pickString(record, ["key", "name"]);
      if (name) out.push(name);
    }
  }
  return out;
}

/** Masks credential-shaped tokens embedded in a free-text message before it
 * leaves the machine in the export bundle. The shared structural redactor masks
 * secret-keyed and credential-shaped VALUES, but a token printed inline in a
 * status message ("Auth failed with token sk0123...") rides in prose, so this
 * catches a long, separator-free, alphanumeric run (a token shape) that is not a
 * path/URL. Returns undefined for an empty/undefined input. */
function scrubFreeText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\S+/g, (token) => {
    if (token.includes("/") || token.includes("\\") || token.includes("://")) {
      return token;
    }
    const isLongCredential =
      token.length >= 20 &&
      /[A-Za-z0-9_-]/.test(token) &&
      /^[A-Za-z0-9_-]+$/.test(token);
    return isLongCredential ? "[redacted]" : token;
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pickBool(
  record: Record<string, unknown> | undefined,
  keys: string[],
): boolean | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function pickNumber(
  record: Record<string, unknown> | undefined,
  keys: string[],
): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}
