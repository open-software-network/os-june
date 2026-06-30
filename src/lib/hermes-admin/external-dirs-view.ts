/**
 * Pure, render-free view logic for the External skill directories manager
 * (spec 10). It joins three inputs into the rows the UI renders, and owns the
 * add/remove list math, so the "path expansion display", "missing/unreadable/
 * writable labels", and "duplicate-skill shadowing explanation" acceptance
 * criteria are all unit-testable without rendering and without a network:
 *
 * 1. the raw `skills.external_dirs` list read from `GET /api/config`
 *    ({@link readExternalDirs});
 * 2. the per-dir filesystem status from June's read-only
 *    `hermes_inspect_external_dirs` command ({@link ExternalDirStatus});
 * 3. the installed local (per-profile) skills from `GET /api/skills`, used to
 *    explain which external skills a same-named local skill shadows.
 *
 * Nothing here talks to Hermes or Tauri; it only reshapes already-fetched data.
 * Copy is sentence case, no em/en-dashes, per June conventions.
 */

import type { ExternalDirStatus } from "../tauri";
import type { HermesSkillInfo } from "./schemas";
import type { HermesAdminMode } from "./target";

/** The advisory above the list, accurate to the runtime being viewed. In the
 * sandboxed runtime the Seatbelt write-jail blocks the agent from editing any
 * external dir (they are never in the write grant), so the message is
 * reassuring; only Full (unrestricted) sessions run without the jail and can
 * edit a folder that is writable on disk. */
export function sharedDirWarning(mode: HermesAdminMode): string {
  if (mode === "unrestricted") {
    return "External directories are shared skill sources loaded alongside your installed skills. Full mode runs without the sandbox, so the agent can edit any folder that is writable on disk. Make shared or team folders read-only in your OS to prevent agent edits.";
  }
  return "External directories are shared skill sources loaded alongside your installed skills. The sandboxed runtime blocks writes, so the agent never edits these files. They are editable only in Full (unrestricted) sessions.";
}

/** A presence label for a directory, derived from its filesystem status. The UI
 * maps each to an icon + tone; missing is explicitly non-fatal. */
export type ExternalDirPresence =
  | "ok" // exists, is a directory, readable
  | "missing" // does not exist (non-fatal)
  | "not-a-directory" // exists but is a file, not a directory
  | "unreadable" // exists but June could not list it
  | "unresolved"; // a `${VAR}` in the path had no value

/** A writability label, kept distinct from a raw boolean so "not detectable"
 * (`unknown`) is never conflated with "read only" (`false`). */
export type ExternalDirWritability = "writable" | "read-only" | "unknown";

/** One row in the external directories list: the raw + resolved paths, the
 * filesystem status distilled into labels, the discovered-skill count, the
 * names a local skill shadows, and June's read-only treatment. */
export type ExternalDirRow = {
  /** The path exactly as configured (the identity used for remove). */
  rawPath: string;
  /** The expanded path, or undefined when a variable could not be resolved. */
  resolvedPath?: string;
  /** True when the resolved path differs from the raw one (so the UI only shows
   * the resolved line when it adds information). */
  expanded: boolean;
  /** The name of an unresolved environment variable in the path, when any. */
  unresolvedVar?: string;
  presence: ExternalDirPresence;
  writability: ExternalDirWritability;
  /** The number of discovered skills, or undefined when missing/unreadable. */
  skillCount?: number;
  /** Discovered skill names in this directory. */
  skillNames: string[];
  /** The discovered skill names that a same-named LOCAL skill shadows. A local
   * skill of the same name takes precedence, so these external skills are not
   * loaded. Empty when nothing is shadowed. */
  shadowedByLocal: string[];
  /** True: June always treats external-directory skills as read-only. Kept as a
   * field (not a constant) so the row carries its own policy for rendering. */
  readOnlyInJune: boolean;
};

/** Builds the rows for the list by joining the configured raw paths with their
 * filesystem status and the local skill names. Order follows the configured
 * list. A configured path with no matching status still renders (status simply
 * reads as missing/unknown) so a stale/failed inspect never drops a row. */
export function buildExternalDirRows(
  rawDirs: readonly string[],
  statuses: readonly ExternalDirStatus[],
  localSkills: readonly HermesSkillInfo[],
): ExternalDirRow[] {
  const statusByRaw = new Map<string, ExternalDirStatus>();
  for (const status of statuses) statusByRaw.set(status.rawPath, status);
  // Local skills that are NOT themselves external take precedence over external
  // skills of the same name; build that name set once.
  const localNames = localSkillNameSet(localSkills);

  return rawDirs.map((rawPath) => {
    const trimmed = rawPath.trim();
    const status = statusByRaw.get(trimmed) ?? statusByRaw.get(rawPath);
    return buildRow(trimmed, status, localNames);
  });
}

function buildRow(
  rawPath: string,
  status: ExternalDirStatus | undefined,
  localNames: ReadonlySet<string>,
): ExternalDirRow {
  const resolvedPath = status?.resolvedPath ?? undefined;
  const skillNames = status?.skillNames ?? [];
  const shadowedByLocal = skillNames.filter((name) => localNames.has(name));
  return {
    rawPath,
    resolvedPath,
    expanded: Boolean(resolvedPath && resolvedPath !== rawPath),
    unresolvedVar: status?.unresolvedVar ?? undefined,
    presence: presenceOf(status),
    writability: writabilityOf(status),
    skillCount: status?.skillCount ?? undefined,
    skillNames,
    shadowedByLocal,
    // External-directory skills are read-only in June by policy, always.
    readOnlyInJune: true,
  };
}

/** The set of local (non-external) skill names, lowercased for case-insensitive
 * shadowing comparison. External skills are excluded: an external skill cannot
 * shadow another external skill in June's precedence model. */
function localSkillNameSet(
  localSkills: readonly HermesSkillInfo[],
): ReadonlySet<string> {
  const set = new Set<string>();
  for (const skill of localSkills) {
    if (skill.source === "external") continue;
    set.add(skill.name);
  }
  return set;
}

function presenceOf(
  status: ExternalDirStatus | undefined,
): ExternalDirPresence {
  if (!status) return "missing";
  if (status.unresolvedVar) return "unresolved";
  if (!status.exists) return "missing";
  if (!status.isDir) return "not-a-directory";
  if (!status.readable) return "unreadable";
  return "ok";
}

function writabilityOf(
  status: ExternalDirStatus | undefined,
): ExternalDirWritability {
  if (!status || status.writable === null || status.writable === undefined) {
    return "unknown";
  }
  return status.writable ? "writable" : "read-only";
}

/** A human label + tone for a presence, so the UI never renders a raw enum.
 * `missing` is intentionally an "info" tone, not an error: a missing external
 * dir is non-fatal. */
export type PresenceMeta = {
  label: string;
  tone: "ok" | "info" | "warning";
};

export function presenceMeta(presence: ExternalDirPresence): PresenceMeta {
  switch (presence) {
    case "ok":
      return { label: "Found", tone: "ok" };
    case "missing":
      return { label: "Missing", tone: "info" };
    case "not-a-directory":
      return { label: "Not a folder", tone: "warning" };
    case "unreadable":
      return { label: "Unreadable", tone: "warning" };
    case "unresolved":
      return { label: "Unresolved path", tone: "warning" };
  }
}

/** A human label + tone for a writability state, relative to the runtime being
 * viewed. `writable` reports a filesystem probe by June's own process; it is an
 * active WARNING only in Full mode (no sandbox), because under the sandbox the
 * write-jail blocks the agent regardless, so there it is merely informational. */
export type WritabilityMeta = {
  label: string;
  tone: "ok" | "warning" | "muted";
};

export function writabilityMeta(
  writability: ExternalDirWritability,
  mode: HermesAdminMode,
): WritabilityMeta {
  switch (writability) {
    case "writable":
      return mode === "unrestricted"
        ? { label: "Editable by the agent", tone: "warning" }
        : { label: "Writable on disk", tone: "muted" };
    case "read-only":
      return { label: "Read only on disk", tone: "ok" };
    case "unknown":
      return { label: "Write access unknown", tone: "muted" };
  }
}

/** A one-line explanation of duplicate-skill shadowing for a row, or undefined
 * when nothing in the directory is shadowed. Names a few of the shadowed skills
 * so the user can tell which are affected. */
export function shadowingExplanation(row: ExternalDirRow): string | undefined {
  const shadowed = row.shadowedByLocal;
  if (shadowed.length === 0) return undefined;
  const names = shadowed.slice(0, 3).join(", ");
  const more = shadowed.length > 3 ? ` and ${shadowed.length - 3} more` : "";
  const subject =
    shadowed.length === 1 ? "A local skill" : "Local skills of the same name";
  const verb = shadowed.length === 1 ? "shadows" : "shadow";
  return `${subject} ${verb} ${names}${more} from this directory. Local skills take precedence, so these are not loaded.`;
}

// ----------------------------------------------------------------------------
// Add / remove list math (a config write read-merges, so the new list is built
// here, validated and deduplicated, before it is sent through PUT /api/config).
// ----------------------------------------------------------------------------

/** The outcome of validating a path the user typed/picked before adding it. */
export type AddDirValidation =
  | { ok: true; value: string }
  | { ok: false; reason: string };

/** Validates a candidate external directory path against the existing list:
 * non-empty after trim, and not already configured (case-sensitive on the raw
 * string, since the same path written two ways is still two config entries).
 * Resolution/existence is NOT required here: a path may legitimately be added
 * before it exists (it is created later, or lives on a not-yet-mounted volume),
 * and missing dirs are non-fatal. */
export function validateNewDir(
  candidate: string,
  existing: readonly string[],
): AddDirValidation {
  const value = candidate.trim();
  if (!value) {
    return { ok: false, reason: "Enter a directory path." };
  }
  if (existing.some((dir) => dir.trim() === value)) {
    return { ok: false, reason: "That directory is already in the list." };
  }
  return { ok: true, value };
}

/** Appends a validated directory to the list, preserving order. Returns a NEW
 * array (the caller writes it through `config.setValue`). Does not mutate. */
export function addDir(existing: readonly string[], value: string): string[] {
  return [...existing, value];
}

/** Removes a directory from the list by its raw configured path, preserving the
 * order of the rest. Returns a NEW array. A path not present is a no-op (the
 * same array contents), so a double-remove can't throw. */
export function removeDir(
  existing: readonly string[],
  rawPath: string,
): string[] {
  return existing.filter((dir) => dir !== rawPath);
}
