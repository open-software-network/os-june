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
const URL_REDACTION_VALUE = "redacted";
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;
const BEARER_PATTERN = /\bbearer\s+[^\s"'<>]+/gi;
const SENSITIVE_ASSIGNMENT_KEY_PATTERN =
  "(?:key|[A-Za-z0-9_-]*(?:(?:token|secret|password|passphrase|credential|authorization|value|pin|otp)|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]*)";
const SENSITIVE_DOUBLE_QUOTED_ASSIGNMENT_PATTERN = new RegExp(
  `(^|[?#&\\s,;({\\[])(["']?)(${SENSITIVE_ASSIGNMENT_KEY_PATTERN})\\2(\\s*[:=]\\s*)"((?:\\\\.|[^"\\\\\\r\\n])*)"`,
  "gi",
);
const SENSITIVE_SINGLE_QUOTED_ASSIGNMENT_PATTERN = new RegExp(
  `(^|[?#&\\s,;({\\[])(["']?)(${SENSITIVE_ASSIGNMENT_KEY_PATTERN})\\2(\\s*[:=]\\s*)'((?:\\\\.|[^'\\\\\\r\\n])*)'`,
  "gi",
);
const SENSITIVE_ESCAPED_DOUBLE_QUOTED_ASSIGNMENT_PATTERN = new RegExp(
  `(^|[?#&\\s,;({\\[])(\\\\")(${SENSITIVE_ASSIGNMENT_KEY_PATTERN})(\\\\")(\\s*:\\s*)(\\\\")((?:(?!\\\\").)*)(\\\\")`,
  "gi",
);
const SENSITIVE_TEXT_ASSIGNMENT_PATTERN = new RegExp(
  `(^|[?#&\\s,;({\\[])(["']?)(${SENSITIVE_ASSIGNMENT_KEY_PATTERN})\\2(\\s*[:=]\\s*)(?:(?:bearer|basic)\\s+)?([^\\s"'<>),;&]+)`,
  "gi",
);
const SENSITIVE_RELATIVE_CALLBACK_CODE_PATTERN =
  /((?:^|[\s"'(])(?:[A-Z]+\s+)?(?:\.{0,2}\/)[^\s"'<>]*?(?:auth|oauth|callback)[^\s"'<>]*?[?&#]code=)([^&#\s"'<>),;]+)/gi;
const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const KNOWN_SECRET_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g;
const NAMED_SECRET_FRAGMENT_PATTERN =
  /\b[A-Za-z0-9_-]*(?:token|secret|credential|password|api[_-]?key)[A-Za-z0-9_-]*\b/gi;
const OPAQUE_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;
const RELATIVE_PATH_CANDIDATE_PATTERN =
  /(^|[\s"'(=:])((?:[A-Z]+\s+)?(?:#\/|\.{0,2}\/)[^\s"'<>),;&]+)/g;
const SENSITIVE_URL_PATH_SEGMENT_PATTERN =
  /^(?:auth|authorize|callback|callbacks|credential|credentials|download|downloads|file|files|invite|invites|login|oauth|password|passwords|private|reset|secret|secrets|share|shares|signed|token|tokens)$/i;
const SENSITIVE_URL_HOST_FRAGMENT_PATTERN =
  /(?:^|[.-])(?:auth|download|downloads|file|files|private|reset|secret|share|signed|token)(?:[.-]|$)/i;

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

function isSensitiveUrlQueryKey(key: string): boolean {
  return (
    isSensitiveKey(key) ||
    /^key$/i.test(key) ||
    /^(?:jwt|session|sid|sig|signature)$/i.test(key)
  );
}

function isSensitiveUrlContextQueryKey(key: string): boolean {
  return /^code$/i.test(key);
}

/**
 * Redacts secret-shaped fragments inside otherwise human-readable text. Use this
 * for fields that are intentionally surfaced as strings, such as error
 * messages, where structural key-based redaction cannot help.
 */
export function sanitizeText(value: string): string {
  return redactTokenFragments(value.replace(URL_PATTERN, sanitizeUrlMatch));
}

function redactSensitiveAssignments(value: string): string {
  return value
    .replace(
      SENSITIVE_RELATIVE_CALLBACK_CODE_PATTERN,
      (_match, prefix: string) => `${prefix}${REDACTED}`,
    )
    .replace(
      SENSITIVE_ESCAPED_DOUBLE_QUOTED_ASSIGNMENT_PATTERN,
      (
        match: string,
        prefix: string,
        keyOpenQuote: string,
        key: string,
        keyCloseQuote: string,
        separator: string,
        valueOpenQuote: string,
        _value: string,
        valueCloseQuote: string,
      ) => {
        if (!isSensitiveAssignmentKey(key)) return match;
        return `${prefix}${keyOpenQuote}${key}${keyCloseQuote}${separator}${valueOpenQuote}${REDACTED}${valueCloseQuote}`;
      },
    )
    .replace(
      SENSITIVE_DOUBLE_QUOTED_ASSIGNMENT_PATTERN,
      (
        match: string,
        prefix: string,
        keyQuote: string,
        key: string,
        separator: string,
      ) => {
        if (!isSensitiveAssignmentKey(key)) return match;
        return `${prefix}${keyQuote}${key}${keyQuote}${separator}"${REDACTED}"`;
      },
    )
    .replace(
      SENSITIVE_SINGLE_QUOTED_ASSIGNMENT_PATTERN,
      (
        match: string,
        prefix: string,
        keyQuote: string,
        key: string,
        separator: string,
      ) => {
        if (!isSensitiveAssignmentKey(key)) return match;
        return `${prefix}${keyQuote}${key}${keyQuote}${separator}'${REDACTED}'`;
      },
    )
    .replace(
      SENSITIVE_TEXT_ASSIGNMENT_PATTERN,
      (
        match: string,
        prefix: string,
        keyQuote: string,
        key: string,
        separator: string,
        _value: string,
      ) => {
        if (!isSensitiveAssignmentKey(key)) return match;
        return `${prefix}${keyQuote}${key}${keyQuote}${separator}${REDACTED}`;
      },
    );
}

function isSensitiveAssignmentKey(key: string): boolean {
  return isSensitiveKey(key) || /^key$/i.test(key);
}

type RedactTokenOptions = {
  minOpaqueTokenLength?: number;
  preservePathSegments?: boolean;
};

function redactTokenFragments(
  value: string,
  options: RedactTokenOptions = { preservePathSegments: true },
): string {
  return redactSensitiveRelativePathTokens(redactSensitiveAssignments(value))
    .replace(BEARER_PATTERN, (match) =>
      match.replace(/\s+\S+$/u, " [redacted]"),
    )
    .replace(JWT_PATTERN, REDACTED)
    .replace(KNOWN_SECRET_PATTERN, REDACTED)
    .replace(NAMED_SECRET_FRAGMENT_PATTERN, (match, offset, source) =>
      redactNamedSecretFragment(match, offset, source),
    )
    .replace(OPAQUE_TOKEN_PATTERN, (match, offset, source) =>
      redactLongOpaqueToken(match, offset, source, options),
    );
}

function redactSensitiveRelativePathTokens(value: string): string {
  return value.replace(
    RELATIVE_PATH_CANDIDATE_PATTERN,
    (_match, prefix: string, candidate: string) => {
      let path = candidate;
      let suffix = "";
      while (/[),.;!?]$/u.test(path)) {
        suffix = `${path.at(-1) ?? ""}${suffix}`;
        path = path.slice(0, -1);
      }
      return `${prefix}${redactSensitiveRelativePath(path, prefix === ":" || prefix === "=")}${suffix}`;
    },
  );
}

function redactNamedSecretFragment(
  match: string,
  offset: number,
  source: string,
): string {
  const before = offset > 0 ? source.at(offset - 1) : undefined;
  const after = source.at(offset + match.length);
  if (
    before === "/" ||
    before === "\\" ||
    after === "/" ||
    after === "\\" ||
    after === "."
  ) {
    return match;
  }
  return match.length >= 16 && /[0-9_-]/u.test(match) ? REDACTED : match;
}

function redactSensitiveRelativePath(
  candidate: string,
  hasRouteLabelPrefix = false,
): string {
  const methodMatch = /^([A-Z]+\s+)(.+)$/u.exec(candidate);
  const methodPrefix = methodMatch?.[1] ?? "";
  let path = methodMatch?.[2] ?? candidate;
  let routePrefix = "";
  if (path.startsWith("#/")) {
    routePrefix = "#";
    path = path.slice(1);
  }
  const suffixStart = firstPathSuffixIndex(path);
  const pathname = suffixStart === -1 ? path : path.slice(0, suffixStart);
  const suffix = suffixStart === -1 ? "" : path.slice(suffixStart);
  const segments = pathname.split("/");
  const meaningful = segments.filter(
    (segment) => segment && segment !== "." && segment !== "..",
  );
  const sensitivePosition = meaningful.findIndex((segment) =>
    isSensitivePathSegment(segment),
  );

  if (sensitivePosition === -1) return candidate;
  const hasRouteContext = Boolean(
    methodPrefix || routePrefix || hasRouteLabelPrefix,
  );
  if (
    !hasRouteContext &&
    sensitivePosition === 0 &&
    /^private$/i.test(meaningful[0] ?? "")
  ) {
    return candidate;
  }
  // Avoid treating arbitrary filesystem paths as URLs. For unlabeled paths,
  // only root-sensitive routes get path-segment redaction; nested callback
  // routes still get sensitive query/hash params scrubbed below.
  if (!hasRouteContext && sensitivePosition > 0) {
    const redactedSuffix = redactSensitiveContextParams(suffix);
    return redactedSuffix === suffix
      ? candidate
      : `${methodPrefix}${routePrefix}${pathname}${redactedSuffix}`;
  }

  let seenSensitiveSegment = false;
  const redacted = segments.map((segment) => {
    if (isSensitivePathSegment(segment)) {
      seenSensitiveSegment = true;
      return segment;
    }
    if (seenSensitiveSegment && isSensitiveRouteSecretSegment(segment)) {
      return REDACTED;
    }
    return segment;
  });
  return `${methodPrefix}${routePrefix}${redacted.join("/")}${redactSensitiveContextParams(suffix)}`;
}

function firstPathSuffixIndex(path: string): number {
  const query = path.indexOf("?");
  const hash = path.indexOf("#");
  if (query === -1) return hash;
  if (hash === -1) return query;
  return Math.min(query, hash);
}

function isOpaquePathToken(segment: string, minLength: number): boolean {
  return segment.length >= minLength && /^[A-Za-z0-9_-]+$/u.test(segment);
}

function isSensitiveRouteSecretSegment(segment: string): boolean {
  const normalized = safeDecodeURIComponent(segment);
  return (
    normalized.length >= 4 &&
    (/^[A-Za-z0-9_-]+$/u.test(normalized) ||
      /^[A-Za-z0-9+/]+={0,2}$/u.test(normalized))
  );
}

function redactSensitiveContextParams(value: string): string {
  return value.replace(
    /([?&#])([^=&#\s]+)=([^&#\s]*)/g,
    (match, prefix: string, key: string) => {
      if (isSensitiveUrlQueryKey(key) || isSensitiveUrlContextQueryKey(key)) {
        return `${prefix}${key}=${REDACTED}`;
      }
      return match;
    },
  );
}

function redactLongOpaqueToken(
  match: string,
  offset: number,
  source: string,
  options: RedactTokenOptions,
): string {
  if (match.length < (options.minOpaqueTokenLength ?? 40)) return match;
  const before = offset > 0 ? source.at(offset - 1) : undefined;
  const after = source.at(offset + match.length);
  if (
    options.preservePathSegments &&
    (before === "/" ||
      before === "\\" ||
      after === "/" ||
      after === "\\")
  ) {
    return match;
  }
  return REDACTED;
}

function sanitize(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;

  const type = typeof value;
  if (type === "string") {
    return sanitizeString(value as string);
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
  if (looksLikeStandalonePathOrUrl(trimmed)) return false;
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

function sanitizeString(value: string): string {
  const trimmed = value.trim();
  if (looksLikeStandalonePathOrUrl(trimmed) && looksLikeUrl(trimmed)) {
    const sanitizedUrl = sanitizeUrl(value);
    if (sanitizedUrl !== undefined) return sanitizedUrl;
  }
  if (isLikelySecretValue(value)) return REDACTED;
  if (looksLikeStandalonePathOrUrl(trimmed)) return sanitizeText(value);
  return sanitizeText(value);
}

function sanitizeUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!looksLikeUrl(trimmed)) return undefined;

  try {
    const url = new URL(trimmed);
    let changed = false;

    if (url.username) {
      url.username = URL_REDACTION_VALUE;
      changed = true;
    }
    if (url.password) {
      url.password = URL_REDACTION_VALUE;
      changed = true;
    }

    const sensitiveUrlContext =
      hasSensitiveUrlPathContext(url) || hasSensitiveUrlHashPathContext(url);
    if (redactSensitiveUrlParams(url.searchParams, sensitiveUrlContext)) {
      changed = true;
    }
    if (sanitizeUrlFragment(url, sensitiveUrlContext)) changed = true;
    if (sanitizeUrlRoutePathTokens(url)) changed = true;

    return redactTokenFragments(changed ? sanitizedUrlString(url) : value, {
      minOpaqueTokenLength: sensitiveUrlContext ? 32 : undefined,
      preservePathSegments: !(
        changed || sensitiveUrlContext
      ),
    });
  } catch {
    return undefined;
  }
}

function sanitizedUrlString(url: URL): string {
  return url.toString().replace(/%5Bredacted%5D/gi, REDACTED);
}

function redactSensitiveUrlParams(
  params: URLSearchParams,
  sensitiveUrlContext: boolean,
): boolean {
  let changed = false;
  for (const key of Array.from(params.keys())) {
    if (
      isSensitiveUrlQueryKey(key) ||
      (sensitiveUrlContext && isSensitiveUrlContextQueryKey(key))
    ) {
      params.set(key, REDACTED);
      changed = true;
    }
  }
  return changed;
}

function sanitizeUrlFragment(url: URL, sensitiveUrlContext: boolean): boolean {
  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (!fragment || !fragment.includes("=")) return false;

  const queryStart = fragment.indexOf("?");
  const fragmentPath = queryStart === -1 ? "" : fragment.slice(0, queryStart);
  const paramText =
    queryStart === -1 ? fragment : fragment.slice(queryStart + 1);
  if (!paramText.includes("=")) return false;

  const fragmentSensitiveContext =
    sensitiveUrlContext || hasSensitivePathSegments(fragmentPath);
  const params = new URLSearchParams(paramText);
  if (!redactSensitiveUrlParams(params, fragmentSensitiveContext)) {
    return false;
  }

  const prefix = queryStart === -1 ? "" : `${fragmentPath}?`;
  url.hash = `${prefix}${params.toString()}`;
  return true;
}

function sanitizeUrlRoutePathTokens(url: URL): boolean {
  let changed = false;
  const pathname = redactSensitivePathRouteTokens(url.pathname);
  if (pathname !== url.pathname) {
    url.pathname = pathname;
    changed = true;
  }

  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (fragment) {
    const suffixStart = firstPathSuffixIndex(fragment);
    const fragmentPath =
      suffixStart === -1 ? fragment : fragment.slice(0, suffixStart);
    const suffix = suffixStart === -1 ? "" : fragment.slice(suffixStart);
    const redactedPath = redactSensitivePathRouteTokens(fragmentPath);
    if (redactedPath !== fragmentPath) {
      url.hash = `${redactedPath}${suffix}`;
      changed = true;
    }
  }

  return changed;
}

function redactSensitivePathRouteTokens(pathname: string): string {
  const segments = pathname.split("/");
  let seenSensitiveSegment = false;
  const redacted = segments.map((segment) => {
    if (isSensitivePathSegment(segment)) {
      seenSensitiveSegment = true;
      return segment;
    }
    if (seenSensitiveSegment && isSensitiveRouteSecretSegment(segment)) {
      return REDACTED;
    }
    return segment;
  });
  return redacted.join("/");
}

function hasSensitiveUrlPathContext(url: URL): boolean {
  if (SENSITIVE_URL_HOST_FRAGMENT_PATTERN.test(url.hostname)) return true;
  return hasSensitivePathSegments(url.pathname);
}

function hasSensitiveUrlHashPathContext(url: URL): boolean {
  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (!fragment) return false;
  const suffixStart = firstPathSuffixIndex(fragment);
  const fragmentPath =
    suffixStart === -1 ? fragment : fragment.slice(0, suffixStart);
  return hasSensitivePathSegments(fragmentPath);
}

function hasSensitivePathSegments(path: string): boolean {
  return path
    .split("/")
    .some((segment) => isSensitivePathSegment(segment));
}

function isSensitivePathSegment(segment: string): boolean {
  const normalized = safeDecodeURIComponent(segment);
  if (SENSITIVE_URL_PATH_SEGMENT_PATTERN.test(normalized)) return true;
  const parts = normalized.split(/[-_]+/).filter(Boolean);
  return (
    parts.length > 0 &&
    parts.every((part) => SENSITIVE_URL_PATH_SEGMENT_PATTERN.test(part))
  );
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizeUrlMatch(match: string): string {
  let url = match;
  let suffix = "";
  while (/[),.;!?]$/u.test(url)) {
    suffix = `${url.at(-1) ?? ""}${suffix}`;
    url = url.slice(0, -1);
  }
  return `${sanitizeUrl(url) ?? url}${suffix}`;
}

/** Whether a string is clearly a filesystem path or URL rather than an opaque
 * token: it has a `/` or `\` separator, a `scheme://` prefix, a `~/` home
 * prefix, or a Windows drive (`C:\`). Used only to exempt such values from the
 * value-shape secret backstop. */
function looksLikeStandalonePathOrUrl(value: string): boolean {
  return value.length > 0 && !/\s/.test(value) && looksLikePathOrUrl(value);
}

function looksLikePathOrUrl(value: string): boolean {
  if (looksLikeUrl(value)) return true;
  if (value.startsWith("~/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return value.includes("/") || value.includes("\\");
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}
