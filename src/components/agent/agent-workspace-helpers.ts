import type {
  HermesFilesystemEntry,
  HermesMessagingPlatformInfo,
  HermesSkillInfo,
  HermesToolsetInfo,
} from "../../lib/tauri";

export function safeText(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function capabilityMatches(
  item: HermesSkillInfo | HermesToolsetInfo | HermesMessagingPlatformInfo,
  query: string,
) {
  if (!query) return true;
  const values = [
    "name" in item ? item.name : "",
    "label" in item ? item.label : "",
    "description" in item ? item.description : "",
    "category" in item ? item.category : "",
    "provider" in item ? item.provider : "",
    "state" in item ? item.state : "",
  ];
  if ("tools" in item && Array.isArray(item.tools)) {
    values.push(...item.tools);
  }
  return values.some((value) => safeText(value).toLowerCase().includes(query));
}

export function filterFilesystemEntries(
  entries: HermesFilesystemEntry[],
  query: string,
): HermesFilesystemEntry[] {
  if (!query) return entries;
  return entries.flatMap((entry) => {
    const children = filterFilesystemEntries(entry.children ?? [], query);
    if (includesQuery(entry.name, query) || includesQuery(entry.path, query) || children.length) {
      return [{ ...entry, children }];
    }
    return [];
  });
}

export function includesQuery(value: unknown, query: string) {
  return safeText(value).toLowerCase().includes(query);
}

export function compactPath(path: string) {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

/** Whether a snapshot entry carries an absolute path we can reveal in Finder
 * (posix "/…" or a Windows drive/UNC path). Reveal is hidden otherwise. */
export function isAbsolutePath(path: string | undefined | null): path is string {
  if (!path) return false;
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

export function formatBytes(value: number | null | undefined) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

export function relativeDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
