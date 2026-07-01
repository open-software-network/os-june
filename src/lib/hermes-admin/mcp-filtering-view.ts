/**
 * Pure, render-free view logic for the per-server MCP tool selection + filtering
 * surface (spec 16): the tool POLICY draft model (include/allowlist vs
 * exclude/blocklist, resource/prompt utility toggles, optional
 * supports_parallel_tool_calls, optional timeout/connect_timeout), the
 * include-over-exclude PRECEDENCE explanation, the "server exposes / June will
 * expose / blocked-destructive" COMPARE counts, and the scoped config BLOCK the
 * write persists at `mcp_servers.<name>.tools`.
 *
 * Kept separate from the React component and the data hook so the precedence
 * display, the compare math, and the block builder are unit-testable without
 * rendering and without a network.
 *
 * This module reuses, never reinvents:
 * - {@link resolveToolPolicy} (spec 18 diagnostics) for the include/exclude
 *   resolution and the per-tool reason, so "which tools are exposed" is computed
 *   one way everywhere;
 * - {@link isDestructiveToolName} (spec 19 security) for the destructive-tool
 *   highlight, so "Blocked/destructive: N" matches the risk surface.
 *
 * Two hard rules this module owns:
 * - INCLUDE WINS over exclude. When an include (allowlist) is present, the
 *   exclude list is shown as having no effect, so the user never thinks an
 *   excluded tool matters while an allowlist is active.
 * - The persisted block is SCOPED to `mcp_servers.<name>.tools`. The write must
 *   preserve every unrelated server field and unrelated config; the dotted path
 *   here is the one source of truth for that scope.
 *
 * Copy is sentence case, no em/en-dashes, per June conventions.
 */

import {
  registeredToolName,
  resolveToolPolicy,
  type ResolvedToolPolicy,
} from "./mcp-diagnostics-view";
import { isDestructiveToolName } from "./mcp-security-view";
import type {
  HermesMcpServerInfo,
  HermesMcpTestResult,
  HermesMcpToolInfo,
} from "./schemas";

// ---------------------------------------------------------------------------
// Config path — the one scoped location the policy is written to.
// ---------------------------------------------------------------------------

/** The dotted config path, as segments, the per-server tool policy lives at in a
 * profile's `config.yaml`: `mcp_servers.<name>.tools`. The one source of truth
 * for the scope, so a write touches ONLY this block and leaves every unrelated
 * server field (command, url, env, headers) and unrelated config untouched. */
export function toolsConfigPath(serverName: string): string[] {
  return ["mcp_servers", serverName, "tools"];
}

/** The dotted string form, for the REST `config.setValue` call. */
export function toolsConfigPathString(serverName: string): string {
  return toolsConfigPath(serverName).join(".");
}

// ---------------------------------------------------------------------------
// Filter mode + draft model.
// ---------------------------------------------------------------------------

/** Which filtering mode the user is editing.
 * - `allowlist`: an `include` list. Only listed tools are exposed (deny by
 *   default). The recommended mode for sensitive servers.
 * - `blocklist`: an `exclude` list. Every tool is exposed except listed ones.
 * - `none`: no include/exclude filter; every tool the server exposes is allowed
 *   (subject to the server's own enabled flags). */
export type ToolFilterMode = "allowlist" | "blocklist" | "none";

/** A tri-state utility toggle. `default` leaves the key unset so Hermes applies
 * its own default (and only registers the utility tools when the server reports
 * the capability); `on`/`off` force it. Kept tri-state so June never invents an
 * `on`/`off` where upstream is silent. */
export type UtilityToggle = "default" | "on" | "off";

/** The editable tool policy for one server. A pure value object the dialog binds
 * to and the controller persists; no React, no IO. */
export type ToolPolicyDraft = {
  mode: ToolFilterMode;
  /** The allowlist (used when `mode === "allowlist"`). Native tool names. */
  include: string[];
  /** The blocklist (used when `mode === "blocklist"`). Native tool names. */
  exclude: string[];
  /** Resource utility tools (read/list resources) on/off/default. */
  resources: UtilityToggle;
  /** Prompt utility tools on/off/default. */
  prompts: UtilityToggle;
  /** Parallel tool calls. `undefined` leaves the key unset (the common case);
   * a boolean forces it. Only surfaced when upstream exposes the flag. */
  supportsParallelToolCalls?: boolean;
  /** Request timeout in seconds, or undefined to leave unset. */
  timeoutSeconds?: number;
  /** Connect timeout in seconds, or undefined to leave unset. */
  connectTimeoutSeconds?: number;
};

/** Reads a tri-state utility toggle out of an existing `tools` config block, so
 * editing an already-configured server starts from its real value rather than a
 * guessed default. */
function readUtilityToggle(
  block: Record<string, unknown> | undefined,
  keys: string[],
): UtilityToggle {
  if (!block) return "default";
  for (const key of keys) {
    const value = block[key];
    if (value === true) return "on";
    if (value === false) return "off";
  }
  return "default";
}

function readBoolean(
  block: Record<string, unknown> | undefined,
  keys: string[],
): boolean | undefined {
  if (!block) return undefined;
  for (const key of keys) {
    const value = block[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function readSeconds(
  block: Record<string, unknown> | undefined,
  keys: string[],
): number | undefined {
  if (!block) return undefined;
  for (const key of keys) {
    const value = block[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reads the existing `mcp_servers.<name>.tools` block out of a server's raw
 * payload, tolerating a top-level `tools` config object distinct from the
 * discovered tool LIST. Returns undefined when no policy block is present. */
function readToolsBlock(
  server: HermesMcpServerInfo,
): Record<string, unknown> | undefined {
  const record = asRecord(server.raw);
  if (!record) return undefined;
  // The discovered tool inventory is an ARRAY under `tools`; the policy block is
  // an OBJECT. Prefer an explicit `tool_filters`/`filters` object, then a
  // `tools` value only when it is an object (not the discovered array).
  return (
    asRecord(record.tool_filters) ??
    asRecord(record.filters) ??
    asRecord(record.tools)
  );
}

/**
 * Derives the initial editable draft for a server from its stored include/
 * exclude policy and its `tools` config block. The mode is inferred: an existing
 * include list means `allowlist`; an exclude list (with no include) means
 * `blocklist`; neither means `none`. This is the starting point the dialog binds
 * to; the user can switch mode freely.
 */
export function draftFromServer(server: HermesMcpServerInfo): ToolPolicyDraft {
  const include = server.includeTools ?? [];
  const exclude = server.excludeTools ?? [];
  const block = readToolsBlock(server);
  const mode: ToolFilterMode =
    include.length > 0
      ? "allowlist"
      : exclude.length > 0
        ? "blocklist"
        : "none";
  return {
    mode,
    include: [...include],
    exclude: [...exclude],
    resources: readUtilityToggle(block, [
      "resources",
      "resource",
      "resource_tools",
    ]),
    prompts: readUtilityToggle(block, ["prompts", "prompt", "prompt_tools"]),
    supportsParallelToolCalls: readBoolean(block, [
      "supports_parallel_tool_calls",
      "supportsParallelToolCalls",
      "parallel_tool_calls",
    ]),
    timeoutSeconds: readSeconds(block, ["timeout", "timeout_seconds"]),
    connectTimeoutSeconds: readSeconds(block, [
      "connect_timeout",
      "connect_timeout_seconds",
    ]),
  };
}

// ---------------------------------------------------------------------------
// Persisted block builder.
// ---------------------------------------------------------------------------

/** The shape written to `mcp_servers.<name>.tools`. Only the keys the user
 * actually set are emitted, so the block stays minimal and a default toggle does
 * not pin a value Hermes would otherwise choose. */
export type ToolPolicyBlock = {
  include?: string[];
  exclude?: string[];
  resources?: boolean;
  prompts?: boolean;
  supports_parallel_tool_calls?: boolean;
  timeout?: number;
  connect_timeout?: number;
};

/** Normalizes a name list: trims, drops blanks, dedupes, preserves order. */
function cleanNames(names: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Builds the scoped `tools` config block from a draft. INCLUDE WINS: in
 * `allowlist` mode only the include list is written (any exclude is dropped,
 * because an exclude has no effect when an include is present). In `blocklist`
 * mode only the exclude list is written. In `none` mode neither is written.
 * Utility toggles emit a key only when forced on/off (a `default` leaves it
 * unset); timeouts emit only when set.
 */
export function buildToolPolicyBlock(draft: ToolPolicyDraft): ToolPolicyBlock {
  const block: ToolPolicyBlock = {};
  if (draft.mode === "allowlist") {
    block.include = cleanNames(draft.include);
  } else if (draft.mode === "blocklist") {
    block.exclude = cleanNames(draft.exclude);
  }
  if (draft.resources !== "default") block.resources = draft.resources === "on";
  if (draft.prompts !== "default") block.prompts = draft.prompts === "on";
  if (draft.supportsParallelToolCalls !== undefined) {
    block.supports_parallel_tool_calls = draft.supportsParallelToolCalls;
  }
  if (draft.timeoutSeconds !== undefined) block.timeout = draft.timeoutSeconds;
  if (draft.connectTimeoutSeconds !== undefined) {
    block.connect_timeout = draft.connectTimeoutSeconds;
  }
  return block;
}

/** Applies a draft's filter lists onto a server so the diagnostics resolver can
 * be reused to preview the effect WITHOUT a save. Honors include-over-exclude:
 * an allowlist draft drops the exclude, a blocklist draft drops the include. */
function serverWithDraftFilters(
  server: HermesMcpServerInfo,
  draft: ToolPolicyDraft,
): HermesMcpServerInfo {
  if (draft.mode === "allowlist") {
    return {
      ...server,
      includeTools: cleanNames(draft.include),
      excludeTools: [],
    };
  }
  if (draft.mode === "blocklist") {
    return {
      ...server,
      includeTools: [],
      excludeTools: cleanNames(draft.exclude),
    };
  }
  return { ...server, includeTools: [], excludeTools: [] };
}

// ---------------------------------------------------------------------------
// Precedence explanation.
// ---------------------------------------------------------------------------

/** A sentence-case explanation of the active precedence, so the UI never lets a
 * user believe an excluded tool matters while an allowlist is present. */
export type PrecedenceNote = {
  /** Stable code for styling / testing. */
  code: "allowlist-wins" | "blocklist-active" | "no-filter";
  /** The headline sentence. */
  message: string;
  /** True when an exclude list is present but INERT (allowlist active), so the
   * UI can grey it out and explain it has no effect. */
  excludeInert: boolean;
};

/** Explains the precedence for a draft. When an allowlist is active AND an
 * exclude list was also entered, the note flags the exclude as inert. */
export function precedenceNote(draft: ToolPolicyDraft): PrecedenceNote {
  if (draft.mode === "allowlist") {
    const hasExclude = cleanNames(draft.exclude).length > 0;
    return {
      code: "allowlist-wins",
      message:
        "Allowlist mode. Only the tools you list are exposed. Include wins, so any blocklist is ignored while an allowlist is set.",
      excludeInert: hasExclude,
    };
  }
  if (draft.mode === "blocklist") {
    return {
      code: "blocklist-active",
      message:
        "Blocklist mode. Every tool is exposed except the ones you list. Switch to an allowlist to expose only chosen tools.",
      excludeInert: false,
    };
  }
  return {
    code: "no-filter",
    message:
      "No filter. Every tool this server exposes is available to the agent. Use an allowlist to limit it to chosen tools.",
    excludeInert: false,
  };
}

// ---------------------------------------------------------------------------
// Discovered tools (test-time) + compare counts.
// ---------------------------------------------------------------------------

/** The tools June knows a server exposes, with where they came from. Test-time
 * discovery (a `/test` probe) is preferred over the stored list; either way the
 * source is labelled so the UI can say "from the last test". */
export type DiscoveredTools = {
  tools: HermesMcpToolInfo[];
  /** True when the list came from a real test probe rather than the stored
   * inventory. */
  fromTest: boolean;
  /** True when no tools are known at all (never tested, none stored). */
  empty: boolean;
};

/** Resolves the discovered tool list for a server, preferring a successful test
 * probe's inventory over the stored one (test-time discovery). */
export function discoveredToolsFor(
  server: HermesMcpServerInfo,
  testResult?: HermesMcpTestResult,
): DiscoveredTools {
  const fromTest = Boolean(testResult && testResult.ok);
  const tools = fromTest ? (testResult?.tools ?? []) : (server.tools ?? []);
  return { tools, fromTest, empty: tools.length === 0 };
}

/** One tool as shown in the compare/selection list: its native name, whether the
 * DRAFT would expose it, the resolution reason, and whether it looks
 * destructive (so the UI can highlight it for review). */
export type ToolPreview = {
  name: string;
  registered: string;
  description?: string;
  /** True when the draft policy would expose this tool to the agent. */
  allowed: boolean;
  /** Why it is or is not exposed, from the shared resolver. */
  reason: ResolvedToolPolicy["tools"][number]["reason"];
  /** True when the tool name reads as destructive (delete/drop/wipe/...). */
  destructive: boolean;
};

/** The "Server exposes / June will expose / Blocked/destructive" comparison for
 * a draft, plus the per-tool preview rows the selection list renders. */
export type ToolComparison = {
  /** Total tools the server exposes (discovered). */
  exposed: number;
  /** Tools the draft would expose to the agent after filtering. */
  willExpose: number;
  /** Tools the draft would filter OUT (exposed minus willExpose). */
  filtered: number;
  /** Tools whose names look destructive, among ALL exposed tools. */
  destructiveTotal: number;
  /** Destructive-looking tools that the draft BLOCKS (filtered out). The spec's
   * "Blocked/destructive: K" counts the destructive tools June keeps away from
   * the agent. */
  destructiveBlocked: number;
  /** Destructive-looking tools that the draft would still EXPOSE, so the UI can
   * warn the user they are allowing a destructive tool. */
  destructiveExposed: number;
  /** True when the discovered list came from a test probe. */
  fromTest: boolean;
  /** True when no tools are known at all (never tested, none stored). */
  empty: boolean;
  /** Per-tool preview rows, in discovered order. */
  tools: ToolPreview[];
};

/**
 * Computes the compare counts + per-tool preview for a draft against a server's
 * discovered tools. Reuses {@link resolveToolPolicy} for the allowed/filtered
 * resolution (so the math matches diagnostics) and {@link isDestructiveToolName}
 * for the destructive highlight (so it matches the security surface). Pure: a
 * preview, no write.
 */
export function compareToolPolicy(
  server: HermesMcpServerInfo,
  draft: ToolPolicyDraft,
  testResult?: HermesMcpTestResult,
): ToolComparison {
  const discovered = discoveredToolsFor(server, testResult);
  const draftServer = serverWithDraftFilters(server, draft);
  const policy = resolveToolPolicy(
    draftServer,
    discovered.tools.map((tool) => tool.name),
  );
  const descByName = new Map<string, string | undefined>();
  for (const tool of discovered.tools) {
    if (!descByName.has(tool.name)) descByName.set(tool.name, tool.description);
  }

  const tools: ToolPreview[] = policy.tools.map((tool) => ({
    name: tool.name,
    registered: registeredToolName(server.name, tool.name),
    description: tool.description ?? descByName.get(tool.name),
    allowed: tool.allowed,
    reason: tool.reason,
    destructive: isDestructiveToolName(tool.name),
  }));

  const exposed = tools.length;
  const willExpose = tools.filter((tool) => tool.allowed).length;
  const destructiveTotal = tools.filter((tool) => tool.destructive).length;
  const destructiveBlocked = tools.filter(
    (tool) => tool.destructive && !tool.allowed,
  ).length;
  const destructiveExposed = tools.filter(
    (tool) => tool.destructive && tool.allowed,
  ).length;

  return {
    exposed,
    willExpose,
    filtered: exposed - willExpose,
    destructiveTotal,
    destructiveBlocked,
    destructiveExposed,
    fromTest: discovered.fromTest,
    empty: discovered.empty,
    tools,
  };
}

// ---------------------------------------------------------------------------
// Allowlist recommendation.
// ---------------------------------------------------------------------------

/** True when June should nudge the user toward an allowlist for this draft: the
 * server exposes destructive-looking tools and the current draft is not already
 * an allowlist (deny-by-default is the safer posture for sensitive servers). */
export function shouldRecommendAllowlist(comparison: ToolComparison): boolean {
  return comparison.destructiveExposed > 0;
}
