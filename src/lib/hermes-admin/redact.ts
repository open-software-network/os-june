/**
 * Redaction for the Hermes admin client. Admin surfaces handle the most
 * secret-dense data in June: API keys, OAuth/bearer tokens, MCP `env` maps, and
 * MCP request `headers`. NOTHING here may ever reach a log line, an error
 * object, or a debug dump without first passing through this module.
 *
 * There is ONE structural redactor in the app — `sanitizePayload` in
 * `../hermes-control-plane/sanitize.ts` (masks sensitive keys and
 * credential-shaped values, recursively, without mutating the input). This
 * module reuses it rather than reimplementing the masking, and adds the two
 * admin-specific shapes that structural masking alone does not cover:
 *
 * - the dashboard auth TOKEN is carried in a request header and in the `ws`/
 *   query string, so a logged URL can leak it; {@link redactUrl} strips it.
 * - a short body PREVIEW kept on {@link HermesAdminError} for debugging is raw
 *   text, not a parsed object; {@link redactBodyPreview} runs the token and
 *   bearer scrubbers over the string form.
 */

import { sanitizePayload } from "../hermes-control-plane/sanitize";

export {
  sanitizePayload,
  isSensitiveKey,
} from "../hermes-control-plane/sanitize";

const REDACTED = "[redacted]";

/** Query parameter names that carry the dashboard auth token (or any secret)
 * in a URL. Hermes puts the session token on the websocket URL as `?token=`;
 * an admin request URL should never carry one, but we scrub defensively so a
 * future endpoint that does cannot leak it through a logged URL. */
const SENSITIVE_QUERY_KEYS =
  /^(token|api[_-]?key|secret|access[_-]?token|key)$/i;

/**
 * Returns `url` with any sensitive query-parameter VALUE replaced by
 * `[redacted]`, preserving the rest of the URL for debugging. Falls back to a
 * string scrub if the input is not a parseable URL (e.g. a relative path), so
 * a malformed URL still cannot leak a `token=` value. Never throws.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.test(key)) {
        parsed.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? parsed.toString() : url;
  } catch {
    return scrubTokenQuery(url);
  }
}

/** Regex scrub of `key=value` pairs in an arbitrary string (a relative URL, a
 * log line). The structural URL parser is preferred; this is the fallback for
 * inputs `new URL()` rejects. */
function scrubTokenQuery(value: string): string {
  return value.replace(
    /\b(token|api[_-]?key|secret|access[_-]?token|key)=([^&\s]+)/gi,
    (_match, key: string) => `${key}=${REDACTED}`,
  );
}

/**
 * Redacts a raw response-body string kept for debugging on
 * {@link HermesAdminError.rawBodyPreview}. The body may be JSON (an error
 * envelope that echoes the submitted secret) or plain text. We parse-and-
 * sanitize when it is JSON so sensitive keys are masked structurally, and
 * always run the bearer/token string scrub so a secret embedded in free text
 * is caught too. Never throws; returns a best-effort redacted string.
 */
export function redactBodyPreview(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return trimmed;
  let working = body;
  // If the body is JSON, mask sensitive keys/values structurally first, then
  // re-stringify so the preview stays JSON-shaped.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      working = JSON.stringify(sanitizePayload(JSON.parse(trimmed)));
    } catch {
      // Not valid JSON despite the leading brace — fall through to the string
      // scrub below on the original text.
    }
  }
  return scrubBearerAndTokens(working);
}

/** Sensitive-key vocabulary for the raw-string scrub, mirroring `sanitize.ts`'s
 * key matcher. Used to mask JSON-style `"key": "value"` pairs in a body that
 * could not be parsed (so the structural sanitizer never ran on it). */
const SENSITIVE_KEY_WORDS =
  "token|api[_-]?key|secret|password|passphrase|private[_-]?key|credential|authorization|value|pin|otp";

/** Masks, in a free-text string, every channel a secret could ride on a
 * MALFORMED-JSON body — the path where the structural `sanitizePayload` never
 * ran. This is the backstop the error body preview relies on, and it must reach
 * parity with the success (parsed) path:
 *
 * 1. `token=`/`key=` query fragments;
 * 2. `Bearer <token>` headers;
 * 3. JSON-style `"<sensitiveKey>": "<value>"` pairs (mask by KEY NAME), and
 * 4. JSON-style `"<anyKey>": "<value>"` whose VALUE looks like a credential
 *    (mask by VALUE SHAPE, regardless of key), mirroring `isLikelySecretValue`
 *    in the canonical sanitizer: a long (>=32-char), separator-free,
 *    alphanumeric run that is not a path/URL. This catches a secret-shaped
 *    value under a benign key, e.g. `{"custom_field":"AKIA...44chars"`. */
function scrubBearerAndTokens(value: string): string {
  const sensitiveKeyPair = new RegExp(
    `("(?:${SENSITIVE_KEY_WORDS})"\\s*:\\s*)"[^"]*"`,
    "gi",
  );
  // Any `"key": "value"` pair, so we can inspect the value's shape.
  const anyStringPair = /("[^"]*"\s*:\s*)"([^"]*)"/g;
  return scrubTokenQuery(value)
    .replace(
      sensitiveKeyPair,
      (_match, prefix: string) => `${prefix}"${REDACTED}"`,
    )
    .replace(anyStringPair, (match, prefix: string, inner: string) =>
      isCredentialShapedValue(inner) ? `${prefix}"${REDACTED}"` : match,
    )
    .replace(/\bbearer\s+\S+/gi, `Bearer ${REDACTED}`);
}

/** Value-shape secret heuristic for the raw-string path, mirroring
 * `isLikelySecretValue` in `../hermes-control-plane/sanitize.ts`: a long,
 * separator-free, alphanumeric run is almost never user-facing copy. A path or
 * URL (has a `/`, `\`, `scheme://`, or `~/`) is a location, not a credential, so
 * it is exempt — masking it would surface `[redacted]` instead of a real file
 * path in a debug preview. */
function isCredentialShapedValue(value: string): boolean {
  if (value.includes("/") || value.includes("\\")) return false;
  return value.length >= 32 && !/\s/.test(value) && /[A-Za-z0-9]/.test(value);
}

/**
 * Produces a structurally-redacted, log-safe copy of an arbitrary value (a
 * request payload, a parsed response). Thin wrapper over {@link sanitizePayload}
 * named for intent at admin call sites: "this is about to be logged, scrub it".
 */
export function redactForLog(value: unknown): unknown {
  return sanitizePayload(value);
}
