import { asRecord, nonEmptyString } from "./parse";

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
