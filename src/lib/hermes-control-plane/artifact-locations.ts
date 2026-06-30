import { asRecord, nonEmptyString } from "./parse";
import { isSensitiveKey } from "./sanitize";

// Known singular payload keys that hold a file path or url. Mirrors the field
// names the artifact timeline understands (snake_case + camelCase).
const SINGULAR_LOCATION_KEYS = [
  "path",
  "file_path",
  "filePath",
  "filename",
  "file",
  "target_path",
  "targetPath",
  "url",
  "uri",
] as const;

// Singular keys whose names do not guarantee a filesystem meaning. Accept their
// values only when they look like paths/urls, so queue/channel names do not mint
// phantom artifacts.
const PATH_SHAPED_LOCATION_KEYS = ["destination", "dest"] as const;

// Known array payload keys holding multiple paths.
const ARRAY_LOCATION_KEYS = [
  "paths",
  "file_paths",
  "filePaths",
  "files",
] as const;

/**
 * Pull artifact navigation locations out of an opaque Hermes tool payload.
 * This is intentionally a tiny allowlist, never prose parsing: it may preserve
 * signed URL query strings, so callers should only use the result for artifact
 * open targets, not trace/debug previews.
 */
export function artifactLocationsFromPayload(payload: unknown): string[] {
  const record = asRecord(payload);
  if (!record) return [];

  const out: string[] = [];
  const push = (value: unknown) => {
    const str = nonEmptyString(value);
    const location = str ? stripUrlUserinfo(str) : undefined;
    if (location && !out.includes(location)) out.push(location);
  };

  for (const key of SINGULAR_LOCATION_KEYS) push(record[key]);

  for (const key of PATH_SHAPED_LOCATION_KEYS) {
    const value = record[key];
    if (typeof value === "string" && looksLikeLocation(value)) push(value);
  }

  for (const key of ARRAY_LOCATION_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) for (const item of value) push(item);
  }

  return out;
}

export function artifactNavigationLocationsFromPayload(
  payload: unknown,
): string[] {
  const record = asRecord(payload);
  if (!record) return [];

  const out: string[] = [];
  const push = (value: unknown, key?: string) => {
    const str = nonEmptyString(value);
    const location = str ? stripUrlUserinfo(str) : undefined;
    if (!location) return;
    if (isArtifactUrlLocation(location)) {
      if (!shouldPreserveRawArtifactUrl(location)) return;
    } else if (
      !shouldPreserveRawFilesystemLocation(location, isUrlLocationKey(key))
    ) {
      return;
    }
    if (!out.includes(location)) out.push(location);
  };

  for (const key of SINGULAR_LOCATION_KEYS) push(record[key], key);

  for (const key of PATH_SHAPED_LOCATION_KEYS) {
    const value = record[key];
    if (typeof value === "string" && looksLikeLocation(value)) {
      push(value, key);
    }
  }

  for (const key of ARRAY_LOCATION_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) for (const item of value) push(item);
  }

  return out;
}

function stripUrlUserinfo(value: string): string {
  if (!isArtifactUrlLocation(value)) return value;
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return value;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
}

/** Whether a string carries a filesystem-path or URL shape. */
function looksLikeLocation(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isArtifactUrlLocation(trimmed)) return true;
  return trimmed.includes("/") || trimmed.includes("\\");
}

export function isArtifactUrlLocation(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function looksLikeFilesystemPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~/") ||
    /^[a-z]:[\\/]/i.test(trimmed)
  );
}

function shouldPreserveRawArtifactUrl(value: string): boolean {
  const likelyArtifactUrl = isLikelyArtifactUrl(value);
  if (hasSensitiveUrlPathToken(value)) return false;
  if (hasSensitiveUrlParam(value)) return likelyArtifactUrl;
  return true;
}

function hasSensitiveUrlParam(value: string): boolean {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (isSensitiveUrlParamKey(key)) return true;
    }
    const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    const hashQueryIndex = hash.indexOf("?");
    const hashQuery =
      hashQueryIndex !== -1
        ? hash.slice(hashQueryIndex + 1)
        : hash.startsWith("?")
          ? hash.slice(1)
          : hash.includes("=")
            ? hash
            : "";
    return hasSensitiveQueryParam(hashQuery);
  } catch {
    return false;
  }
}

function isSensitiveUrlParamKey(key: string): boolean {
  return (
    isSensitiveKey(key) ||
    /^key$/i.test(key) ||
    /^(?:code|jwt|session|sid|sig|signature)$/i.test(key)
  );
}

function isLikelyArtifactUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return isLikelyArtifactPathname(url.pathname);
  } catch {
    return false;
  }
}

function hasSensitiveUrlPathToken(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      hasSensitiveRoutePathToken(url.pathname, true) ||
      hasSensitiveRoutePathToken(hashPathname(url.hash), true)
    );
  } catch {
    return false;
  }
}

function shouldPreserveRawFilesystemLocation(
  value: string,
  useUrlRouteGate: boolean,
): boolean {
  if (!looksLikeFilesystemPath(value)) return false;
  if (hasSensitiveRoutePathToken(locationPathname(value), useUrlRouteGate)) {
    return false;
  }
  if (!hasSensitiveRelativeLocationParam(value)) return true;
  return isLikelyArtifactPathname(locationPathname(value));
}

function hasSensitiveRelativeLocationParam(value: string): boolean {
  const queryIndex = value.indexOf("?");
  if (queryIndex !== -1) {
    const hashAfterQuery = value.indexOf("#", queryIndex);
    const query =
      hashAfterQuery === -1
        ? value.slice(queryIndex + 1)
        : value.slice(queryIndex + 1, hashAfterQuery);
    if (hasSensitiveQueryParam(query)) return true;
  }

  const hashIndex = value.indexOf("#");
  if (hashIndex === -1) return false;
  const hash = value.slice(hashIndex + 1);
  const hashQueryIndex = hash.indexOf("?");
  const hashQuery =
    hashQueryIndex !== -1
      ? hash.slice(hashQueryIndex + 1)
      : hash.includes("=")
        ? hash
        : "";
  return hasSensitiveQueryParam(hashQuery);
}

function hasSensitiveQueryParam(query: string): boolean {
  if (!query) return false;
  for (const key of new URLSearchParams(query).keys()) {
    if (isSensitiveUrlParamKey(key)) return true;
  }
  return false;
}

function locationPathname(value: string): string {
  const queryIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  const suffixIndex =
    queryIndex === -1
      ? hashIndex
      : hashIndex === -1
        ? queryIndex
        : Math.min(queryIndex, hashIndex);
  return suffixIndex === -1 ? value : value.slice(0, suffixIndex);
}

function isLikelyArtifactPathname(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  if (
    /(?:^|\/)(?:auth|authorize|callback|login|oauth|reset|token)(?:\/|$)/.test(
      lower,
    )
  ) {
    return false;
  }
  const parts = lower.split("/").filter(Boolean);
  const basename = parts[parts.length - 1] ?? "";
  if (/\.[a-z0-9]{1,12}$/.test(basename)) return true;
  return parts.some((part) =>
    /^(?:artifact|artifacts|attachment|attachments|download|downloads|export|exports|file|files|image|images)$/.test(
      part,
    ),
  );
}

function isUrlLocationKey(key: string | undefined): boolean {
  return key === "url" || key === "uri";
}

function hasSensitiveRoutePathToken(
  pathname: string,
  includeArtifactRoutePrefixes: boolean,
): boolean {
  if (!pathname) return false;
  const parts = pathname.split("/").filter(Boolean);
  const sensitiveIndex = parts.findIndex((part) =>
    isSensitiveRawRouteSegment(part, includeArtifactRoutePrefixes),
  );
  if (sensitiveIndex === -1) return false;
  return parts
    .slice(sensitiveIndex + 1)
    .some((part) => isRouteSecretSegment(part));
}

function hashPathname(hash: string): string {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!fragment) return "";
  const queryIndex = fragment.indexOf("?");
  if (queryIndex !== -1) return fragment.slice(0, queryIndex);
  return fragment.includes("=") ? "" : fragment;
}

function isSensitiveRawRouteSegment(
  segment: string,
  includeArtifactRoutePrefixes: boolean,
): boolean {
  const normalized = safeDecodeURIComponent(segment).toLowerCase();
  const routePattern = includeArtifactRoutePrefixes
    ? /(?:^|[-_])(?:auth|authorize|callback|callbacks|credential|credentials|download|downloads|file|files|invite|invites|login|oauth|password|passwords|private|reset|secret|secrets|share|shares|signed|token|tokens)(?:[-_]|$)/
    : /(?:^|[-_])(?:auth|authorize|callback|callbacks|credential|credentials|invite|invites|login|oauth|password|passwords|reset|secret|secrets|share|shares|signed|token|tokens)(?:[-_]|$)/;
  return routePattern.test(normalized);
}

function isRouteSecretSegment(segment: string): boolean {
  const normalized = safeDecodeURIComponent(segment);
  if (/^\d+$/u.test(normalized)) return false;
  if (
    /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}$/u.test(
      normalized,
    )
  ) {
    return true;
  }
  return (
    normalized.length >= 4 &&
    ((/^[A-Za-z0-9_-]+$/u.test(normalized) &&
      /[A-Za-z0-9]/u.test(normalized)) ||
      /^[A-Za-z0-9+/]+={0,2}$/u.test(normalized))
  );
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
