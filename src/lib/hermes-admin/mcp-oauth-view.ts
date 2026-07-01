/**
 * Pure, render-free view logic for the MCP OAuth login + token-status flow
 * (spec 17): classifying an OAuth-authenticated HTTP MCP server's sign-in state,
 * the sentence-case labels for each state, detecting the "provider needs a
 * pre-registered client id / secret" case, and a hard guard that nothing from
 * the (untrusted) CLI login output is ever shown without redaction.
 *
 * Kept separate from the React component and the data hook so the state
 * classification and the secret-hygiene rules are unit-testable without
 * rendering and without a Tauri runtime.
 *
 * Two hard rules this module owns, both load-bearing for the spec's
 * "token values are never displayed or logged":
 * - we model token PRESENCE only (connected / needs sign-in / expired), never a
 *   token value. There is no field here that could hold one.
 * - the CLI login bridge returns a free-text message and an authorization URL;
 *   {@link safeOauthMessage} runs them through the shared redactor before they
 *   reach the UI, so a server that prints `Bearer <token>` or a `?token=` in its
 *   output can never leak it onto the screen.
 *
 * Copy is sentence case, no em/en-dashes, per June conventions.
 */

import { redactBodyPreview, redactUrl } from "./redact";
import type { HermesMcpAuthStatus, HermesMcpServerInfo } from "./schemas";

// ---------------------------------------------------------------------------
// OAuth applicability
// ---------------------------------------------------------------------------

/** True when a server authenticates through an OAuth browser sign-in, so the
 * OAuth status + actions apply to it. A `bearer`/`none` HTTP server or a stdio
 * server is excluded: it has no browser sign-in to run. We treat an
 * `http-oauth` transport as authoritative, and also any server that reports a
 * real auth STATUS other than "not-required" (a server Hermes flagged as
 * needing a login), so the flow still appears if upstream labels the transport
 * plain `http` but reports an oauth-shaped auth status. */
export function usesOauth(server: HermesMcpServerInfo): boolean {
  if (server.transport === "http-oauth") return true;
  if (server.transport === "stdio") return false;
  return (
    server.auth === "authenticated" ||
    server.auth === "unauthenticated" ||
    server.auth === "expired"
  );
}

// ---------------------------------------------------------------------------
// OAuth status classification
// ---------------------------------------------------------------------------

/** The OAuth sign-in state June surfaces per server, covering every case the
 * spec calls out:
 * - `connected`: a usable token is present;
 * - `needs-sign-in`: no token yet (never authenticated);
 * - `expired`: a token existed but refresh failed / it lapsed, re-auth needed;
 * - `signing-in`: a browser authorization is in flight (June handed it off);
 * - `needs-client-credentials`: the provider does not support dynamic client
 *   registration, so it needs a pre-registered client id / secret before a
 *   sign-in can even start;
 * - `unknown`: Hermes did not report a usable status. */
export type McpOauthStatus =
  | "connected"
  | "needs-sign-in"
  | "expired"
  | "signing-in"
  | "needs-client-credentials"
  | "unknown";

/** A sentence-case label + one-line blurb + tone + which action (if any) the
 * row should offer, for one OAuth state. Tone drives styling only. */
export type McpOauthStatusMeta = {
  state: McpOauthStatus;
  label: string;
  blurb: string;
  tone: "ok" | "attention" | "neutral";
  /** The sign-in action to offer, or "none" when no action applies (connected,
   * or already signing in). `sign-in` for a first login, `re-auth` to refresh an
   * expired/failed token, `configure` when client credentials are missing. */
  action: "none" | "sign-in" | "re-auth" | "configure";
  /** The button label for {@link action}, when there is one. */
  actionLabel?: string;
};

const STATE_META: Readonly<Record<McpOauthStatus, McpOauthStatusMeta>> =
  Object.freeze({
    connected: {
      state: "connected",
      label: "Signed in",
      blurb: "A valid token is stored. Tools load after the gateway restarts.",
      tone: "ok",
      action: "re-auth",
      actionLabel: "Sign in again",
    },
    "needs-sign-in": {
      state: "needs-sign-in",
      label: "Sign in to finish",
      blurb:
        "This server needs you to sign in through your browser before its tools work.",
      tone: "attention",
      action: "sign-in",
      actionLabel: "Sign in",
    },
    expired: {
      state: "expired",
      label: "Sign in expired",
      blurb:
        "The stored token expired or could not refresh. Sign in again to restore access.",
      tone: "attention",
      action: "re-auth",
      actionLabel: "Sign in again",
    },
    "signing-in": {
      state: "signing-in",
      label: "Waiting for browser",
      blurb:
        "Finish the sign-in in your browser. June is waiting for it to complete.",
      tone: "neutral",
      action: "none",
    },
    "needs-client-credentials": {
      state: "needs-client-credentials",
      label: "Needs client setup",
      blurb:
        "This provider does not register clients automatically. Add a client id and secret before signing in.",
      tone: "attention",
      action: "configure",
      actionLabel: "Add client details",
    },
    unknown: {
      state: "unknown",
      label: "Sign-in status unknown",
      blurb: "Hermes did not report this server's sign-in status.",
      tone: "neutral",
      action: "sign-in",
      actionLabel: "Sign in",
    },
  });

/** The display metadata for an OAuth state. */
export function oauthStatusMeta(state: McpOauthStatus): McpOauthStatusMeta {
  return STATE_META[state];
}

/** Maps a parsed auth status to a base OAuth state (before the live signing-in
 * overlay and the client-credentials check are layered on). */
function stateFromAuth(auth: HermesMcpAuthStatus): McpOauthStatus {
  switch (auth) {
    case "authenticated":
      return "connected";
    case "expired":
      return "expired";
    case "unauthenticated":
      return "needs-sign-in";
    case "not-required":
    case "unknown":
      return "unknown";
  }
}

/**
 * Classifies a server's OAuth state. `signingIn` (a login in flight, tracked by
 * the hook) wins over everything so the row shows the waiting state. Otherwise,
 * a provider that needs pre-registered client credentials but has none yet reads
 * as `needs-client-credentials` (the sign-in cannot start without them) UNLESS a
 * token is already present (connected) — a connected server does not need its
 * credentials re-entered. The remaining cases map straight from the auth status.
 */
export function oauthStateFor(
  server: HermesMcpServerInfo,
  signingIn = false,
): McpOauthStatus {
  if (signingIn) return "signing-in";
  const base = stateFromAuth(server.auth);
  if (base === "connected") return "connected";
  if (needsClientCredentials(server)) return "needs-client-credentials";
  return base;
}

// ---------------------------------------------------------------------------
// Client-credential (no dynamic registration) detection
// ---------------------------------------------------------------------------

/** The non-secret client-credential KEY names a server's config carries, for the
 * "client details" form. We read whether a client id / secret is CONFIGURED, and
 * the client id is a non-secret identifier we may show; the client SECRET is
 * never read into June (write-only), so this records presence only. */
export type McpOauthClientConfig = {
  /** True when the provider requires a pre-registered client (no dynamic
   * registration), so a client id (and usually secret) must be supplied. */
  required: boolean;
  /** Whether a client id is already configured. */
  hasClientId: boolean;
  /** Whether a client secret is already configured. */
  hasClientSecret: boolean;
};

/** Reads the OAuth client-credential configuration a server declares. Tolerates
 * the documented `oauth` config block (`{ client_id, client_secret,
 * dynamic_registration }`) plus a top-level form, reading only presence /
 * non-secret flags, never a secret value. */
export function oauthClientConfig(
  server: HermesMcpServerInfo,
): McpOauthClientConfig {
  const record = asRecord(server.raw);
  const oauth = asRecord(record?.oauth) ?? asRecord(record?.oauth_config);
  // `dynamic_registration: false` (or `dynamic_client_registration: false`)
  // means the provider will NOT register a client for us, so credentials are
  // required. An explicit `requires_client_credentials: true` says so directly.
  const dynamic =
    pickBool(oauth, ["dynamic_registration", "dynamic_client_registration"]) ??
    pickBool(record, [
      "oauth_dynamic_registration",
      "dynamic_client_registration",
    ]);
  const explicitRequired = pickBool(oauth, [
    "requires_client_credentials",
    "requires_client_id",
    "manual_client",
  ]);
  const hasClientId =
    presentString(oauth, ["client_id", "clientId"]) ||
    presentString(record, ["oauth_client_id", "client_id"]);
  const hasClientSecret =
    // The listing should not echo a secret value; treat any non-empty marker
    // (a boolean presence flag, a masked preview, or a value) as "configured".
    presentString(oauth, ["client_secret", "clientSecret"]) ||
    presentString(record, ["oauth_client_secret"]) ||
    (pickBool(oauth, ["has_client_secret", "client_secret_set"]) ?? false);
  const required = explicitRequired ?? (dynamic === false ? true : false);
  return { required, hasClientId, hasClientSecret };
}

/** True when a server needs client credentials that are not yet fully supplied,
 * so the sign-in must be preceded by a client-setup step. A provider that
 * requires a client id but has none configured qualifies. */
export function needsClientCredentials(server: HermesMcpServerInfo): boolean {
  const config = oauthClientConfig(server);
  if (!config.required) return false;
  return !config.hasClientId;
}

// ---------------------------------------------------------------------------
// Login-output redaction guard
// ---------------------------------------------------------------------------

/** A sentence-case fallback when a login produced no safe message of its own. */
export const OAUTH_GENERIC_MESSAGE = "Sign-in finished.";

/**
 * Redacts a free-text message produced by the OAuth login bridge before it is
 * shown. The CLI prints arbitrary text and may echo a `Bearer <token>` or a
 * `?token=` fragment; this runs the SAME body-preview redactor every admin error
 * uses so nothing secret-shaped reaches the screen. Returns `undefined` for an
 * empty/whitespace message so the caller can fall back to a generic line.
 */
export function safeOauthMessage(
  message: string | undefined,
): string | undefined {
  if (!message) return undefined;
  const redacted = redactBodyPreview(message).trim();
  return redacted.length > 0 ? redacted : undefined;
}

/** True for a syntactically valid http(s) authorization URL. The login bridge
 * extracts the auth URL and opens it in the OS browser; June also surfaces it so
 * the user can open it manually if the browser did not launch. The URL itself is
 * not a secret, but it is run through {@link redactUrl} before display so a
 * provider that puts a `token=` on the query cannot leak it. */
export function safeAuthorizationUrl(
  url: string | undefined,
): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!isHttpUrl(trimmed)) return undefined;
  return redactUrl(trimmed);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Local, dependency-free readers
// ---------------------------------------------------------------------------

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

/** True when any of `keys` holds a non-empty string OR a `true` boolean presence
 * flag. Reads presence only, never the value itself. */
function presentString(
  record: Record<string, unknown> | undefined,
  keys: string[],
): boolean {
  if (!record) return false;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return true;
    if (value === true) return true;
  }
  return false;
}
