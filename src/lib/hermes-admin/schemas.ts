/**
 * Defensive parsers for the Hermes dashboard admin REST shapes June consumes:
 * Skills, Toolsets, MCP servers, MCP catalog, background action status, env
 * writes, and gateway status. Same contract as `parseSessionUsage`: unknown in,
 * a normalized object out, every non-essential field optional and left
 * `undefined` when absent or malformed, NEVER throwing on junk. Unknown wire
 * fields are preserved under `raw` so a debug dump keeps anything we did not
 * model (the spec's "do not discard fields that may matter").
 *
 * These are permissive enough for upstream additions (new fields are ignored,
 * not rejected) but strict enough to catch a breaking change: a list endpoint
 * that stops returning an array, or an item that loses its name, degrades
 * visibly to empty rather than crashing a page. The contract fixtures in spec 24
 * lock these mappings.
 */

import {
  asRecord,
  finiteNumber,
  nonEmptyString,
  pickNumber,
  pickString,
} from "../hermes-control-plane/parse";
import type { ApplicationTiming } from "./application-timing";

/** A boolean read from an arbitrary wire value, or undefined when absent. Only
 * a real boolean counts: a string `"true"` is NOT coerced, so a malformed
 * enabled flag degrades to undefined instead of silently reading as enabled. */
function pickBool(
  containers: Array<Record<string, unknown> | undefined>,
  keys: string[],
): boolean | undefined {
  for (const container of containers) {
    if (!container) continue;
    for (const key of keys) {
      const value = container[key];
      if (typeof value === "boolean") return value;
    }
  }
  return undefined;
}

/** A string array (non-empty entries only), or undefined. */
function pickStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    const str = nonEmptyString(entry);
    if (str) out.push(str);
  }
  return out.length > 0 ? out : undefined;
}

// ----------------------------------------------------------------------------
// Skills (`GET /api/skills`, `PUT /api/skills/toggle`)
// ----------------------------------------------------------------------------

/** Where a skill came from. `bundled` ships with Hermes, `hub` was installed
 * from the Skills Hub, `external` loads from a `skills.external_dirs` path
 * (read-only in June), `unknown` when the wire did not say. */
export type HermesSkillSource = "bundled" | "hub" | "external" | "unknown";

export type HermesSkillInfo = {
  name: string;
  description?: string;
  enabled: boolean;
  source: HermesSkillSource;
  /** True when June cannot write this skill (loaded from an external dir). */
  readOnly?: boolean;
  /** The skill's version string, when reported. */
  version?: string;
  raw: unknown;
};

function parseSkillSource(value: unknown): HermesSkillSource {
  const str = nonEmptyString(value)?.toLowerCase();
  if (str === "bundled" || str === "builtin" || str === "official") {
    return "bundled";
  }
  if (str === "hub" || str === "installed") return "hub";
  if (str === "external" || str === "external_dir") return "external";
  return "unknown";
}

export function parseSkill(raw: unknown): HermesSkillInfo | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const name = pickString([record], ["name", "id", "skill", "slug"]);
  if (!name) return undefined;
  const source = parseSkillSource(
    record.source ?? record.origin ?? record.kind,
  );
  return {
    name,
    description: pickString([record], ["description", "summary", "desc"]),
    enabled: pickBool([record], ["enabled", "active", "is_enabled"]) ?? false,
    source,
    readOnly:
      pickBool([record], ["read_only", "readOnly", "readonly"]) ??
      (source === "external" ? true : undefined),
    version: pickString([record], ["version", "ver"]),
    raw,
  };
}

/** Hermes returns either a bare array or `{ skills: [...] }`; tolerate both. */
export function parseSkillList(raw: unknown): HermesSkillInfo[] {
  const items = listFrom(raw, ["skills", "items", "data"]);
  return items
    .map(parseSkill)
    .filter((skill): skill is HermesSkillInfo => skill !== undefined);
}

// ----------------------------------------------------------------------------
// Toolsets (`GET /api/tools/toolsets`)
// ----------------------------------------------------------------------------

export type HermesToolsetRequirement = {
  /** What the requirement is about, e.g. an env var name or a binary. */
  label: string;
  satisfied?: boolean;
};

export type HermesToolsetInfo = {
  name: string;
  description?: string;
  enabled: boolean;
  /** Tool names this toolset exposes, when listed. */
  tools?: string[];
  /** Unmet/met prerequisites (env vars, binaries) when reported. */
  requirements?: HermesToolsetRequirement[];
  raw: unknown;
};

function parseRequirement(raw: unknown): HermesToolsetRequirement | undefined {
  const str = nonEmptyString(raw);
  if (str) return { label: str };
  const record = asRecord(raw);
  if (!record) return undefined;
  const label = pickString([record], ["label", "name", "key", "env"]);
  if (!label) return undefined;
  return {
    label,
    satisfied: pickBool([record], ["satisfied", "met", "ok", "present"]),
  };
}

function parseRequirements(
  value: unknown,
): HermesToolsetRequirement[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: HermesToolsetRequirement[] = [];
  for (const entry of value) {
    const requirement = parseRequirement(entry);
    if (requirement) out.push(requirement);
  }
  return out.length > 0 ? out : undefined;
}

export function parseToolset(raw: unknown): HermesToolsetInfo | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const name = pickString([record], ["name", "id", "toolset", "slug"]);
  if (!name) return undefined;
  return {
    name,
    description: pickString([record], ["description", "summary", "desc"]),
    enabled: pickBool([record], ["enabled", "active", "is_enabled"]) ?? false,
    tools: pickStringArray(record.tools ?? record.tool_names),
    requirements: parseRequirements(
      record.requirements ?? record.requires ?? record.prerequisites,
    ),
    raw,
  };
}

export function parseToolsetList(raw: unknown): HermesToolsetInfo[] {
  const items = listFrom(raw, ["toolsets", "items", "data"]);
  return items
    .map(parseToolset)
    .filter((toolset): toolset is HermesToolsetInfo => toolset !== undefined);
}

// ----------------------------------------------------------------------------
// MCP servers (`GET /api/mcp/servers`, add/test/enable/remove)
// ----------------------------------------------------------------------------

/** Transport of an MCP server. `stdio` spawns a local subprocess (sandbox/full
 * mode matters), `http` is a remote HTTP server, `http-oauth` an HTTP server
 * behind an OAuth login. */
export type HermesMcpTransport = "stdio" | "http" | "http-oauth" | "unknown";

/** OAuth/auth state of an MCP server, when it has one. */
export type HermesMcpAuthStatus =
  | "authenticated"
  | "unauthenticated"
  | "expired"
  | "not-required"
  | "unknown";

export type HermesMcpToolInfo = {
  name: string;
  description?: string;
  /** Whether this tool is currently exposed (after include/exclude filters). */
  enabled?: boolean;
};

export type HermesMcpServerInfo = {
  name: string;
  enabled: boolean;
  transport: HermesMcpTransport;
  /** stdio command, when transport is stdio. */
  command?: string;
  /** HTTP server URL, when transport is http(-oauth). */
  url?: string;
  auth: HermesMcpAuthStatus;
  /** Last connection/test result, when known. */
  status?: "connected" | "error" | "untested" | "unknown";
  /** Human-readable status/error detail. Already safe (no secrets). */
  statusMessage?: string;
  tools?: HermesMcpToolInfo[];
  /** Tool include/exclude filters as configured. */
  includeTools?: string[];
  excludeTools?: string[];
  raw: unknown;
};

function parseMcpTransport(
  record: Record<string, unknown>,
): HermesMcpTransport {
  const explicit = nonEmptyString(
    record.transport ?? record.type ?? record.kind,
  )?.toLowerCase();
  if (explicit === "stdio") return "stdio";
  if (explicit === "http-oauth" || explicit === "oauth") return "http-oauth";
  if (explicit === "http" || explicit === "sse" || explicit === "streamable") {
    return "http";
  }
  // Infer from shape when the wire did not label it.
  if (nonEmptyString(record.command)) return "stdio";
  if (nonEmptyString(record.url)) {
    return record.oauth || record.auth ? "http-oauth" : "http";
  }
  return "unknown";
}

function parseMcpAuth(record: Record<string, unknown>): HermesMcpAuthStatus {
  const status = nonEmptyString(
    record.auth_status ?? record.authStatus ?? record.oauth_status,
  )?.toLowerCase();
  if (status === "authenticated" || status === "authorized") {
    return "authenticated";
  }
  if (status === "expired") return "expired";
  if (
    status === "unauthenticated" ||
    status === "unauthorized" ||
    status === "missing"
  ) {
    return "unauthenticated";
  }
  const authed = pickBool([record], ["authenticated", "authorized"]);
  if (authed === true) return "authenticated";
  if (authed === false) return "unauthenticated";
  return "unknown";
}

function parseMcpStatus(
  record: Record<string, unknown>,
): HermesMcpServerInfo["status"] {
  const status = nonEmptyString(record.status ?? record.health)?.toLowerCase();
  if (status === "connected" || status === "ok" || status === "ready") {
    return "connected";
  }
  if (status === "error" || status === "failed" || status === "unhealthy") {
    return "error";
  }
  if (status === "untested" || status === "unknown" || status === "pending") {
    return status === "untested" ? "untested" : "unknown";
  }
  return undefined;
}

function parseMcpTool(raw: unknown): HermesMcpToolInfo | undefined {
  const str = nonEmptyString(raw);
  if (str) return { name: str };
  const record = asRecord(raw);
  if (!record) return undefined;
  const name = pickString([record], ["name", "id", "tool"]);
  if (!name) return undefined;
  return {
    name,
    description: pickString([record], ["description", "summary", "desc"]),
    enabled: pickBool([record], ["enabled", "active", "included"]),
  };
}

function parseMcpTools(value: unknown): HermesMcpToolInfo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: HermesMcpToolInfo[] = [];
  for (const entry of value) {
    const tool = parseMcpTool(entry);
    if (tool) out.push(tool);
  }
  return out.length > 0 ? out : undefined;
}

export function parseMcpServer(raw: unknown): HermesMcpServerInfo | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const name = pickString([record], ["name", "id", "server", "slug"]);
  if (!name) return undefined;
  const filters = asRecord(record.tool_filters ?? record.filters) ?? record;
  return {
    name,
    enabled: pickBool([record], ["enabled", "active", "is_enabled"]) ?? false,
    transport: parseMcpTransport(record),
    command: pickString([record], ["command", "cmd"]),
    url: pickString([record], ["url", "endpoint", "address"]),
    auth: parseMcpAuth(record),
    status: parseMcpStatus(record),
    statusMessage: pickString(
      [record],
      ["status_message", "statusMessage", "message", "detail", "error"],
    ),
    tools: parseMcpTools(record.tools),
    includeTools: pickStringArray(
      filters.include ?? filters.include_tools ?? record.include_tools,
    ),
    excludeTools: pickStringArray(
      filters.exclude ?? filters.exclude_tools ?? record.exclude_tools,
    ),
    raw,
  };
}

export function parseMcpServerList(raw: unknown): HermesMcpServerInfo[] {
  const items = listFrom(raw, ["servers", "mcp_servers", "items", "data"]);
  return items
    .map(parseMcpServer)
    .filter((server): server is HermesMcpServerInfo => server !== undefined);
}

/** Result of `POST /api/mcp/servers/{name}/test`. The detail is a safe message;
 * any tool list is the inventory the test discovered. */
export type HermesMcpTestResult = {
  name: string;
  ok: boolean;
  message?: string;
  tools?: HermesMcpToolInfo[];
  raw: unknown;
};

export function parseMcpTestResult(
  name: string,
  raw: unknown,
): HermesMcpTestResult {
  const record = asRecord(raw);
  const ok =
    pickBool([record], ["ok", "success", "connected", "healthy"]) ?? false;
  return {
    name,
    ok,
    message: pickString(
      [record],
      ["message", "detail", "error", "status_message"],
    ),
    tools: parseMcpTools(record?.tools),
    raw,
  };
}

// ----------------------------------------------------------------------------
// MCP catalog (`GET /api/mcp/catalog`, `POST /api/mcp/catalog/install`)
// ----------------------------------------------------------------------------

export type HermesMcpCatalogEntry = {
  id: string;
  name: string;
  description?: string;
  transport: HermesMcpTransport;
  /** True when this catalog entry is already installed as a server. */
  installed?: boolean;
  /** True when the entry requires an OAuth login after install. */
  requiresOauth?: boolean;
  /** Whether the entry runs a local subprocess (sandbox/full-mode relevant). */
  requiresSubprocess?: boolean;
  raw: unknown;
};

export function parseMcpCatalogEntry(
  raw: unknown,
): HermesMcpCatalogEntry | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const id = pickString([record], ["id", "slug", "name", "key"]);
  if (!id) return undefined;
  const transport = parseMcpTransport(record);
  return {
    id,
    name: pickString([record], ["name", "title", "label"]) ?? id,
    description: pickString([record], ["description", "summary", "desc"]),
    transport,
    installed: pickBool([record], ["installed", "is_installed", "present"]),
    requiresOauth:
      pickBool([record], ["requires_oauth", "requiresOauth", "oauth"]) ??
      (transport === "http-oauth" ? true : undefined),
    requiresSubprocess:
      pickBool(
        [record],
        ["requires_subprocess", "requiresSubprocess", "local"],
      ) ?? (transport === "stdio" ? true : undefined),
    raw,
  };
}

export function parseMcpCatalog(raw: unknown): HermesMcpCatalogEntry[] {
  const items = listFrom(raw, ["catalog", "entries", "items", "data"]);
  return items
    .map(parseMcpCatalogEntry)
    .filter((entry): entry is HermesMcpCatalogEntry => entry !== undefined);
}

// ----------------------------------------------------------------------------
// Skills Hub search (`GET /api/skills/hub/search`)
// ----------------------------------------------------------------------------

export type HermesHubSkillResult = {
  /** Stable install identifier (the value to pass to hubInstall). */
  identifier: string;
  name: string;
  description?: string;
  source?: string;
  installed?: boolean;
  raw: unknown;
};

export function parseHubSkillResult(
  raw: unknown,
): HermesHubSkillResult | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const identifier = pickString(
    [record],
    ["identifier", "id", "slug", "name", "ref"],
  );
  if (!identifier) return undefined;
  return {
    identifier,
    name: pickString([record], ["name", "title", "label"]) ?? identifier,
    description: pickString([record], ["description", "summary", "desc"]),
    source: pickString([record], ["source", "origin", "tap"]),
    installed: pickBool([record], ["installed", "is_installed"]),
    raw,
  };
}

export function parseHubSearch(raw: unknown): HermesHubSkillResult[] {
  const items = listFrom(raw, ["results", "skills", "items", "data"]);
  return items
    .map(parseHubSkillResult)
    .filter((result): result is HermesHubSkillResult => result !== undefined);
}

// ----------------------------------------------------------------------------
// Background actions (`POST` endpoints that return an action name/id;
// `GET /api/actions/{name}/status`)
// ----------------------------------------------------------------------------

/** Lifecycle state of a backgrounded admin action (hub install, gateway
 * restart, ...). `unknown` when the wire state is unrecognized — callers keep
 * polling rather than assuming success. */
export type HermesActionState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "unknown";

export type HermesActionStatus = {
  /** The action name/id to poll on `/api/actions/{name}/status`. */
  action: string;
  state: HermesActionState;
  /** True once the action reached a terminal state (succeeded or failed). */
  done: boolean;
  /** 0-100 progress, when reported. */
  progress?: number;
  /** Safe human message; redacted of any secret-shaped content upstream. */
  message?: string;
  /** Safe error message when `state === "failed"`. */
  error?: string;
  raw: unknown;
};

function parseActionState(value: unknown): HermesActionState {
  const str = nonEmptyString(value)?.toLowerCase();
  if (str === "queued" || str === "pending" || str === "scheduled") {
    return "queued";
  }
  if (str === "running" || str === "in_progress" || str === "active") {
    return "running";
  }
  if (
    str === "succeeded" ||
    str === "success" ||
    str === "completed" ||
    str === "done"
  ) {
    return "succeeded";
  }
  if (
    str === "failed" ||
    str === "error" ||
    str === "cancelled" ||
    str === "canceled"
  ) {
    return "failed";
  }
  return "unknown";
}

/** Reads the action NAME/ID a mutating endpoint returns so the caller can poll
 * it. Returns undefined when the response carries no action handle (a
 * synchronous mutation). */
export function parseActionHandle(raw: unknown): string | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  return pickString(
    [record, asRecord(record.action)],
    ["action", "action_name", "actionName", "action_id", "id", "name"],
  );
}

export function parseActionStatus(
  action: string,
  raw: unknown,
): HermesActionStatus {
  const record = asRecord(raw);
  // A bare `{ done: true }` or `{ status: "..." }` are both tolerated.
  const explicitDone = pickBool([record], ["done", "finished", "complete"]);
  const state = parseActionState(
    record?.state ?? record?.status ?? (explicitDone ? "succeeded" : undefined),
  );
  const done = explicitDone ?? (state === "succeeded" || state === "failed");
  return {
    action,
    state,
    done,
    progress: clampProgress(
      pickNumber([record], ["progress", "percent", "pct"]),
    ),
    message: pickString([record], ["message", "detail", "status_message"]),
    error:
      state === "failed"
        ? pickString([record], ["error", "error_message", "message", "detail"])
        : pickString([record], ["error", "error_message"]),
    raw,
  };
}

function clampProgress(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.max(0, Math.min(100, value));
}

// ----------------------------------------------------------------------------
// Gateway status (`GET /api/status` / `POST /api/gateway/restart`)
// ----------------------------------------------------------------------------

export type HermesGatewayStatus = {
  /** Whether the messaging gateway (cron/Slack/etc.) is currently running. */
  gatewayRunning?: boolean;
  /** Hermes version string the runtime reports, when present. */
  version?: string;
  /** An action handle when a lifecycle call backgrounded the work. */
  action?: string;
  raw: unknown;
};

export function parseGatewayStatus(raw: unknown): HermesGatewayStatus {
  const record = asRecord(raw);
  return {
    gatewayRunning: pickBool(
      [record],
      ["gateway_running", "gatewayRunning", "running"],
    ),
    version: pickString([record], ["version", "hermes_version"]),
    action: parseActionHandle(raw),
    raw,
  };
}

// ----------------------------------------------------------------------------
// Env (`GET /api/env`, `PUT /api/env`, `DELETE /api/env`, `POST /api/env/reveal`)
// ----------------------------------------------------------------------------

/** One configured env var as listed by `GET /api/env`. The dashboard does NOT
 * return the value in the listing (only presence/metadata); the real value is
 * fetched on demand via reveal. `hasValue` records whether a value is set. */
export type HermesEnvVar = {
  key: string;
  /** True when a value is configured for this key (the listing reports presence,
   * not the value itself). */
  hasValue?: boolean;
  /** A non-secret masked preview the dashboard may include (e.g. `sk-...abcd`).
   * Never the full value. */
  preview?: string;
  raw: unknown;
};

/** Result of `GET /api/env`: the configured env vars for a profile, plus the
 * untouched payload. The dashboard returns an opaque/untyped object, so this is
 * parsed permissively from whatever shape it carries (an array, a `vars`/`env`
 * map, or a plain key->value/meta map). */
export type HermesEnvListing = {
  vars: HermesEnvVar[];
  raw: unknown;
};

function parseEnvVar(key: string, value: unknown): HermesEnvVar {
  // The entry may be a bare value, or a metadata object.
  const record = asRecord(value);
  if (!record) {
    return {
      key,
      hasValue: value !== null && value !== undefined && value !== "",
      raw: value,
    };
  }
  return {
    key: pickString([record], ["key", "name"]) ?? key,
    hasValue:
      pickBool([record], ["has_value", "hasValue", "set", "present"]) ??
      // A masked preview implies a value is set.
      (nonEmptyString(record.preview ?? record.masked) ? true : undefined),
    preview: pickString([record], ["preview", "masked", "hint"]),
    raw: value,
  };
}

/** Parses `GET /api/env` defensively. Tolerates a bare array of entries, an
 * object wrapping the list under `vars`/`env`/`variables`, or a plain
 * key->value/meta map (the common FastAPI dict shape). Never returns a value. */
export function parseEnvListing(raw: unknown): HermesEnvListing {
  // Array form: [{ key, ... }, ...].
  if (Array.isArray(raw)) {
    const vars = raw
      .map((entry) => {
        const record = asRecord(entry);
        const key = record && pickString([record], ["key", "name"]);
        return key ? parseEnvVar(key, entry) : undefined;
      })
      .filter((v): v is HermesEnvVar => v !== undefined);
    return { vars, raw };
  }
  const record = asRecord(raw);
  if (!record) return { vars: [], raw };
  // Wrapped form: { vars: {...} | [...] } / { env: ... } / { variables: ... }.
  const inner =
    record.vars ?? record.env ?? record.variables ?? record.values ?? record;
  if (Array.isArray(inner)) {
    return parseEnvListing(inner);
  }
  const innerRecord = asRecord(inner) ?? record;
  const vars = Object.entries(innerRecord).map(([key, value]) =>
    parseEnvVar(key, value),
  );
  return { vars, raw };
}

/** Result of `POST /api/env/reveal`: the plaintext value for a key. This DOES
 * carry the secret (that is the point of reveal); the caller renders it into a
 * one-time field and the transport never logs the call. */
export type HermesEnvRevealResult = {
  key: string;
  /** The revealed plaintext value, or undefined when the key is unset. SECRET. */
  value?: string;
  raw: unknown;
};

/** Parses `POST /api/env/reveal`. The dashboard returns an opaque object; read
 * the value from common field names, tolerating a bare string body. */
export function parseEnvRevealResult(
  key: string,
  raw: unknown,
): HermesEnvRevealResult {
  if (typeof raw === "string") {
    return { key, value: raw.length > 0 ? raw : undefined, raw };
  }
  const record = asRecord(raw);
  return {
    key: pickString([record], ["key", "name"]) ?? key,
    value: pickString([record], ["value", "val", "plaintext", "secret"]),
    raw,
  };
}

/** Result of an env mutation. NOTE: this NEVER carries the value back — only
 * whether the write landed and whether a gateway restart is needed to apply it.
 * The value is write-only from June's side and must not round-trip into state. */
export type HermesEnvWriteResult = {
  key: string;
  ok: boolean;
  /** When the write applies, per Hermes (defaults to gateway-restart for env). */
  appliesAt: ApplicationTiming;
  /** Safe message, no value echoed. */
  message?: string;
  raw: unknown;
};

export function parseEnvWriteResult(
  key: string,
  raw: unknown,
): HermesEnvWriteResult {
  const record = asRecord(raw);
  const ok =
    pickBool([record], ["ok", "success", "saved", "updated"]) ??
    // A 2xx with an empty/opaque body still means the write landed.
    true;
  const timing = nonEmptyString(
    record?.applies_at ?? record?.appliesAt ?? record?.timing,
  )?.toLowerCase();
  const appliesAt: ApplicationTiming =
    timing === "immediate"
      ? "immediate"
      : timing === "next-session" || timing === "next_session"
        ? "next-session"
        : "gateway-restart";
  return {
    key,
    ok,
    appliesAt,
    message: pickString([record], ["message", "detail", "status_message"]),
    raw,
  };
}

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

/** Extracts an array from a response that is either a bare array or an object
 * wrapping the array under one of `keys`. Anything else yields `[]` so a list
 * parser never throws and a broken/empty response renders as no items. */
function listFrom(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  const record = asRecord(raw);
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** Reads a simple `{ ok, name, enabled }` mutation ack, the shape the existing
 * skill/toolset toggle Tauri commands resolve to. Tolerant of a bare 2xx. */
export type HermesToggleResult = {
  ok: boolean;
  name: string;
  enabled: boolean;
};

export function parseToggleResult(
  name: string,
  enabled: boolean,
  raw: unknown,
): HermesToggleResult {
  const record = asRecord(raw);
  return {
    ok: pickBool([record], ["ok", "success"]) ?? true,
    name: pickString([record], ["name", "id"]) ?? name,
    enabled: pickBool([record], ["enabled", "active"]) ?? enabled,
  };
}
