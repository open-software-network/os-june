/**
 * Redaction used before any raw payload is allowed into a normalized event or a
 * log line. The control plane carries opaque payloads on `unsupported` (for
 * debugging) and `error` (for context) events; both run through here first so a
 * secret/token a future Hermes event happens to include never leaks into June's
 * state, traces, or console. Downstream trace/debug tooling (feature 15) imports
 * this too — there is one redactor, not several.
 */

/** Keys whose values are masked wherever they appear in a payload. Matched
 * case-insensitively against each object key. Covers the obvious secret-bearing
 * names; widen here (one place) if Hermes introduces a new sensitive field. */
const SENSITIVE_KEY_PATTERN =
  /(token|api[_-]?key|secret|password|passphrase|private[_-]?key|credential|authorization|value|pin|otp)/i;

const REDACTED = "[redacted]";

/** Cap on how deep we recurse, so a cyclic or pathologically nested payload
 * can't hang or blow the stack. Beyond this, the subtree is dropped. */
const MAX_DEPTH = 8;

/**
 * Returns a structural copy of `value` with any sensitive field masked. Strings
 * matching {@link isLikelySecretValue} are also masked even under a benign key,
 * so a bearer token assigned to `headers` is still caught. Never mutates the
 * input; never throws.
 */
export function sanitizePayload(value: unknown): unknown {
  return sanitize(value, 0, new WeakSet());
}

/** Whether a key name should have its value masked. Exported so debug tooling
 * can highlight the same fields it redacts. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function sanitize(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;

  const type = typeof value;
  if (type === "string") {
    return isLikelySecretValue(value as string) ? REDACTED : value;
  }
  if (type === "number" || type === "boolean" || type === "bigint") {
    return value;
  }
  // Functions/symbols never belong in a wire payload; drop them.
  if (type !== "object") return undefined;

  if (depth >= MAX_DEPTH) return undefined;
  // `seen` tracks only the ACTIVE ancestor chain, not every object ever visited:
  // add before recursing into this node's children and remove after. A node
  // reachable by two SIBLING paths is not a cycle (its first occurrence has
  // already been popped by the time the second is reached), so it is rendered
  // in full both times instead of being silently dropped as "[circular]".
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((item) => sanitize(item, depth + 1, seen));
  } else {
    const obj: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (isSensitiveKey(key)) {
        obj[key] = REDACTED;
        continue;
      }
      obj[key] = sanitize(entry, depth + 1, seen);
    }
    out = obj;
  }

  seen.delete(value as object);
  return out;
}

/** Heuristic for a value that looks like a credential even under an innocent
 * key: long, single-token, high-entropy-ish strings, or the common bearer
 * prefix. Conservative on purpose.
 *
 * This is only the VALUE-shape backstop for benign keys — anything under a
 * sensitive key (see {@link isSensitiveKey}) is masked by the caller regardless
 * of shape, so a secret that happens to contain a slash is still redacted there.
 * Here we deliberately exempt strings that are clearly a filesystem path or URL:
 * a normal long workspace path or link is single-token and >31 chars, but it is
 * a location, not a credential, and downstream features (the artifact timeline)
 * read these back out — masking them would surface `[redacted]` instead of the
 * real file. Genuine opaque tokens (long, separator-free alphanumeric / JWT /
 * base64url) and the bearer prefix are still caught. */
function isLikelySecretValue(value: string): boolean {
  const trimmed = value.trim();
  if (/^bearer\s+\S+/i.test(trimmed)) return true;
  // A path or url is a location, not a credential: never mask it on shape alone.
  if (looksLikePathOrUrl(trimmed)) return false;
  // A long, unbroken token (no whitespace) is almost never user-facing copy.
  if (
    trimmed.length >= 32 &&
    !/\s/.test(trimmed) &&
    /[A-Za-z0-9]/.test(trimmed)
  ) {
    return true;
  }
  return false;
}

/** Whether a string is clearly a filesystem path or URL rather than an opaque
 * token: it has a `/` or `\` separator, a `scheme://` prefix, a `~/` home
 * prefix, or a Windows drive (`C:\`). Used only to exempt such values from the
 * value-shape secret backstop. */
function looksLikePathOrUrl(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
  if (value.startsWith("~/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return value.includes("/") || value.includes("\\");
}
