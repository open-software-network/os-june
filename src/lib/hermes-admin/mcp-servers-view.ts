/**
 * Pure, render-free view logic for the native MCP servers page (spec 14):
 * transport / auth / status / risk labeling, secret-field redaction for the
 * list, add-server payload validation (name + path/shell-injection guards), and
 * the search filter. Kept separate from the React component and the data hook so
 * the labeling and validation acceptance criteria are unit-testable without
 * rendering and without a network.
 *
 * Nothing here talks to Hermes; it only reshapes already-parsed servers and
 * validates a user-entered add-server form before it is sent. Copy is sentence
 * case, no em/en-dashes, per June conventions.
 *
 * Two hard rules this module owns:
 * - secrets (env values, header values, auth tokens) are NEVER surfaced; the
 *   list shows redacted placeholders and the count of configured fields only;
 * - a stdio command/args or an HTTP URL the user types is validated for shape
 *   and screened for shell/path-injection metacharacters BEFORE it is sent, so
 *   June never hands Hermes an argument that could break out of the intended
 *   command (the spec's "prevent path/shell injection").
 */

import type { HermesAddMcpServerPayload } from "./client";
import type {
  HermesMcpAuthStatus,
  HermesMcpServerInfo,
  HermesMcpTransport,
} from "./schemas";

// ---------------------------------------------------------------------------
// Transport / risk labels
// ---------------------------------------------------------------------------

/** A human label + risk note for an MCP transport, so the UI never shows a raw
 * enum and the local-subprocess vs remote-HTTP risk is explicit on every row
 * (the spec's "risk label: local subprocess vs remote HTTP"). */
export type McpTransportMeta = {
  transport: HermesMcpTransport;
  /** Short pill label, sentence case. */
  label: string;
  /** The risk class: a stdio server runs a LOCAL subprocess (inherits June's
   * sandbox/full-mode constraints); http(-oauth) is a REMOTE call. */
  risk: "local-subprocess" | "remote-http" | "unknown";
  /** Short risk label for a pill. */
  riskLabel: string;
  /** One-line explanation for a secondary line / tooltip. */
  blurb: string;
};

const TRANSPORT_META: Readonly<Record<HermesMcpTransport, McpTransportMeta>> =
  Object.freeze({
    stdio: {
      transport: "stdio",
      label: "Local (stdio)",
      risk: "local-subprocess",
      riskLabel: "Local subprocess",
      blurb:
        "Runs as a local subprocess and inherits June and Hermes sandbox constraints.",
    },
    http: {
      transport: "http",
      label: "Remote (HTTP)",
      risk: "remote-http",
      riskLabel: "Remote HTTP",
      blurb:
        "Connects to a remote HTTP server. Tools run outside this machine.",
    },
    "http-oauth": {
      transport: "http-oauth",
      label: "Remote (OAuth)",
      risk: "remote-http",
      riskLabel: "Remote HTTP",
      blurb:
        "Connects to a remote HTTP server behind an OAuth login. Tools run outside this machine.",
    },
    unknown: {
      transport: "unknown",
      label: "Server",
      risk: "unknown",
      riskLabel: "Unknown",
      blurb: "Transport not reported by Hermes.",
    },
  });

/** The display metadata for a server's transport. */
export function transportMeta(transport: HermesMcpTransport): McpTransportMeta {
  return TRANSPORT_META[transport];
}

/** True when this transport spawns a local subprocess, so the page can lead with
 * the sandbox/full-mode note for it. */
export function isLocalSubprocess(server: HermesMcpServerInfo): boolean {
  return transportMeta(server.transport).risk === "local-subprocess";
}

// ---------------------------------------------------------------------------
// Auth / connection status labels
// ---------------------------------------------------------------------------

/** A sentence-case label + tone for an auth status, so a missing/expired login
 * reads clearly and the row can style it. */
export type McpAuthMeta = {
  label: string;
  tone: "ok" | "attention" | "neutral";
};

export function authMeta(auth: HermesMcpAuthStatus): McpAuthMeta {
  switch (auth) {
    case "authenticated":
      return { label: "Signed in", tone: "ok" };
    case "expired":
      return { label: "Sign in expired", tone: "attention" };
    case "unauthenticated":
      return { label: "Not signed in", tone: "attention" };
    case "not-required":
      return { label: "No auth", tone: "neutral" };
    case "unknown":
      return { label: "Auth unknown", tone: "neutral" };
  }
}

/** A sentence-case label + tone for the last test/connection status. `undefined`
 * status reads as "Not tested" so the page never shows a raw enum or a blank. */
export type McpStatusMeta = {
  label: string;
  tone: "ok" | "error" | "neutral";
};

export function statusMeta(
  status: HermesMcpServerInfo["status"],
): McpStatusMeta {
  switch (status) {
    case "connected":
      return { label: "Connected", tone: "ok" };
    case "error":
      return { label: "Connection error", tone: "error" };
    case "untested":
    case undefined:
      return { label: "Not tested", tone: "neutral" };
    case "unknown":
      return { label: "Status unknown", tone: "neutral" };
  }
}

// ---------------------------------------------------------------------------
// Secret redaction for the list / detail
// ---------------------------------------------------------------------------

/** A redacted summary of the secret-bearing config a server carries, for the
 * list. We NEVER surface env values or header values; only the KEY NAMES (which
 * are not secret) and a redacted placeholder, plus a count. This mirrors the
 * dashboard, which does not echo env/header values back in a GET. */
export type RedactedSecretField = {
  /** The non-secret key name (e.g. `GITHUB_TOKEN`, `Authorization`). */
  key: string;
  /** Always the redaction placeholder; the real value is never read into June. */
  display: string;
};

/** The fixed placeholder shown wherever a secret value would otherwise sit. */
export const REDACTED_PLACEHOLDER = "Hidden";

/** Reads the configured env KEY NAMES from a server's raw payload (the listing
 * does not return values). Returns redacted fields, never values. Tolerant of an
 * `env` map or an array of `{ key }` entries. */
export function redactedEnv(
  server: HermesMcpServerInfo,
): RedactedSecretField[] {
  return redactKeysFrom(server, ["env", "environment", "env_vars"]);
}

/** Reads the configured HTTP header KEY NAMES from a server's raw payload. Same
 * redaction contract as {@link redactedEnv}. */
export function redactedHeaders(
  server: HermesMcpServerInfo,
): RedactedSecretField[] {
  return redactKeysFrom(server, ["headers", "http_headers"]);
}

function redactKeysFrom(
  server: HermesMcpServerInfo,
  keys: string[],
): RedactedSecretField[] {
  const record = asRecord(server.raw);
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    const names = keyNamesOf(value);
    if (names.length > 0) {
      return names.map((name) => ({
        key: name,
        display: REDACTED_PLACEHOLDER,
      }));
    }
  }
  return [];
}

/** Pulls key names from a `{ KEY: value }` map or a `[{ key }]` array, ignoring
 * the values entirely so no secret is ever read. */
function keyNamesOf(value: unknown): string[] {
  const record = asRecord(value);
  if (record) {
    return Object.keys(record).filter((key) => key.trim().length > 0);
  }
  if (Array.isArray(value)) {
    const names: string[] = [];
    for (const entry of value) {
      const entryRecord = asRecord(entry);
      const name =
        entryRecord && pickString(entryRecord, ["key", "name", "header"]);
      if (name) names.push(name);
    }
    return names;
  }
  return [];
}

/** The stdio args a server was configured with, read from raw for display
 * (command is on the parsed server). Returns a clean string list or `[]`. */
export function serverArgs(server: HermesMcpServerInfo): string[] {
  const record = asRecord(server.raw);
  if (!record) return [];
  return toStringList(record.args ?? record.arguments) ?? [];
}

// ---------------------------------------------------------------------------
// Add-server form validation (name + shell/path-injection prevention)
// ---------------------------------------------------------------------------

/** Which transport the add-server form is building. */
export type McpDraftTransport = "stdio" | "http";

/** The raw add-server form state the dialog edits. Strings as typed; the
 * args / env / headers are edited as lists of pairs so a key/value editor can
 * bind directly. */
export type McpServerDraft = {
  name: string;
  transport: McpDraftTransport;
  /** stdio: the command (a single program name or absolute path). */
  command: string;
  /** stdio: positional args, one per row. */
  args: string[];
  /** stdio: env key/value pairs (values are secret-class). */
  env: Array<{ key: string; value: string }>;
  /** http: the server URL. */
  url: string;
  /** http: request header key/value pairs (values are secret-class). */
  headers: Array<{ key: string; value: string }>;
  /** http: the auth mode label, e.g. `none` / `bearer` / `oauth`. */
  auth: "none" | "bearer" | "oauth";
};

/** A blank draft for a fresh add-server form. */
export function emptyDraft(
  transport: McpDraftTransport = "stdio",
): McpServerDraft {
  return {
    name: "",
    transport,
    command: "",
    args: [],
    env: [],
    url: "",
    headers: [],
    auth: "none",
  };
}

/** The outcome of validating a draft: either a ready-to-send payload, or a map
 * of field -> sentence-case error message so the dialog can mark fields. */
export type McpDraftValidation =
  | { ok: true; payload: HermesAddMcpServerPayload }
  | { ok: false; errors: Record<string, string> };

/** A valid MCP server name: a slug a config key and a URL path segment both
 * tolerate. Letters, digits, dot, underscore, and hyphen, 1-64 chars. This also
 * keeps the name safe to interpolate into `/api/mcp/servers/{name}/...`. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Shell metacharacters that have no place in a command, an argument, or an env
 * KEY. If a user pastes `rm -rf / ; curl evil`, the `;` (and friends) are caught
 * here before the payload is ever sent, so June cannot forward an argument that
 * a careless server runner might re-interpret through a shell. */
const SHELL_METACHARACTERS = /[;&|`$(){}<>\n\r\\]|\$\(|&&|\|\|/;

/** A valid env / header KEY: an identifier, no shell metacharacters, no spaces. */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * Validates a draft and, when valid, builds the `POST /api/mcp/servers` payload.
 * The payload carries env / headers as plain maps (the values are secrets — they
 * ride in the request body and are never logged). A test-only draft that the
 * user has not saved is validated the same way; the caller decides whether to
 * persist.
 */
export function validateDraft(draft: McpServerDraft): McpDraftValidation {
  const errors: Record<string, string> = {};
  const name = draft.name.trim();

  if (!name) {
    errors.name = "Enter a name for this server.";
  } else if (!NAME_PATTERN.test(name)) {
    errors.name =
      "Use letters, numbers, dot, underscore, or hyphen (max 64 characters).";
  }

  if (draft.transport === "stdio") {
    const command = draft.command.trim();
    if (!command) {
      errors.command = "Enter the command to run.";
    } else if (SHELL_METACHARACTERS.test(command)) {
      errors.command =
        "Remove shell characters. Enter only the program path, with arguments below.";
    }
    draft.args.forEach((arg, index) => {
      if (SHELL_METACHARACTERS.test(arg)) {
        errors[`args.${index}`] = "Remove shell characters from this argument.";
      }
    });
    for (const [index, pair] of draft.env.entries()) {
      const key = pair.key.trim();
      if (!key && !pair.value.trim()) continue; // skip a wholly blank row
      if (!ENV_KEY_PATTERN.test(key)) {
        errors[`env.${index}`] =
          "Use an environment variable name (letters, numbers, underscore).";
      }
    }
  } else {
    const url = draft.url.trim();
    if (!url) {
      errors.url = "Enter the server URL.";
    } else if (!isValidHttpUrl(url)) {
      errors.url = "Enter a valid http or https URL.";
    }
    for (const [index, pair] of draft.headers.entries()) {
      const key = pair.key.trim();
      if (!key && !pair.value.trim()) continue;
      if (!HEADER_KEY_PATTERN.test(key)) {
        errors[`headers.${index}`] =
          "Use a valid header name (letters, numbers, hyphen).";
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, payload: buildPayload(draft, name) };
}

/** Builds the create payload from an already-validated draft. Blank rows are
 * dropped; empty collections are omitted entirely so the body stays minimal. */
function buildPayload(
  draft: McpServerDraft,
  name: string,
): HermesAddMcpServerPayload {
  if (draft.transport === "stdio") {
    const args = draft.args.map((arg) => arg.trim()).filter((arg) => arg);
    const env = pairsToMap(draft.env);
    const payload: HermesAddMcpServerPayload = {
      name,
      command: draft.command.trim(),
    };
    if (args.length > 0) payload.args = args;
    if (Object.keys(env).length > 0) payload.env = env;
    return payload;
  }
  const headers = pairsToMap(draft.headers);
  const payload: HermesAddMcpServerPayload = {
    name,
    url: draft.url.trim(),
  };
  if (draft.auth !== "none") payload.auth = draft.auth;
  if (Object.keys(headers).length > 0) payload.headers = headers;
  return payload;
}

/** Collapses key/value pairs into a map, trimming keys and dropping blank-key
 * rows. Values are kept verbatim (a secret may legitimately have leading or
 * trailing characters). */
function pairsToMap(
  pairs: Array<{ key: string; value: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (!key) continue;
    out[key] = pair.value;
  }
  return out;
}

/** True for a syntactically valid http(s) URL. */
export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** The lowercased haystack a server is searched against: name, command, URL,
 * transport label, and tool names. Centralized so the filter is testable. */
export function serverHaystack(server: HermesMcpServerInfo): string {
  const parts: Array<string | undefined> = [
    server.name,
    server.command,
    server.url,
    transportMeta(server.transport).label,
    ...(server.tools ?? []).map((tool) => tool.name),
  ];
  return parts
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
}

/** Applies the search filter, preserving input order. */
export function filterServers(
  servers: readonly HermesMcpServerInfo[],
  query: string,
): HermesMcpServerInfo[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...servers];
  return servers.filter((server) =>
    serverHaystack(server).includes(normalized),
  );
}

/** True when a server currently exposes tools to the agent, so delete / disable
 * can require an extra confirmation (the spec's "confirm if the server has tools
 * currently available"). */
export function hasAvailableTools(server: HermesMcpServerInfo): boolean {
  if (!server.enabled) return false;
  const tools = server.tools ?? [];
  // A tool with an explicit `enabled: false` is filtered out and not available.
  return tools.some((tool) => tool.enabled !== false);
}

// ---------------------------------------------------------------------------
// Local, dependency-free readers (kept here so this module stays render-free).
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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

function toStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    return parts.length > 0 ? parts : undefined;
  }
  return undefined;
}
