/**
 * Pure, render-free view logic for the installed Skills page (spec 03):
 * source/category labeling, conditional-activation extraction, and the
 * search + category filter. Kept separate from the React component and the
 * data hook so the "find a skill quickly" acceptance criterion is unit-testable
 * without rendering and without a network — given a list of {@link HermesSkillInfo}
 * and a query/category, this decides exactly what the user sees.
 *
 * Nothing here talks to Hermes; it only reshapes already-parsed skills. Copy is
 * sentence case, no em/en-dashes, per June conventions.
 */

import type { HermesSkillInfo, HermesSkillSource } from "./schemas";

/** A human label + short blurb for each skill source, so the UI never shows a
 * raw enum and a user can tell a bundled skill from an external one at a glance.
 * `external` is the only source June treats as read-only by default. */
export type SkillSourceMeta = {
  source: HermesSkillSource;
  /** Short pill label, sentence case. */
  label: string;
  /** One-line explanation for a tooltip / secondary line. */
  blurb: string;
};

const SOURCE_META: Readonly<Record<HermesSkillSource, SkillSourceMeta>> =
  Object.freeze({
    bundled: {
      source: "bundled",
      label: "Bundled",
      blurb: "Ships with Hermes.",
    },
    hub: {
      source: "hub",
      label: "Hub",
      blurb: "Installed from the Skills Hub.",
    },
    external: {
      source: "external",
      label: "External",
      blurb:
        "Loaded from an external directory. May be shared with other tools and read-only in June.",
    },
    unknown: {
      source: "unknown",
      label: "Skill",
      blurb: "Source not reported by Hermes.",
    },
  });

/** The display metadata for a skill's source. */
export function sourceMeta(source: HermesSkillSource): SkillSourceMeta {
  return SOURCE_META[source];
}

/** A platform-restriction note read from the skill's raw payload when upstream
 * reports one, e.g. `{ platforms: ["macos"] }` or `os: "linux"`. Returned as a
 * ready-to-render list of OS labels, or undefined when none is reported. June
 * does not invent restrictions — only what Hermes sends is shown. */
export function platformRestrictions(
  skill: HermesSkillInfo,
): string[] | undefined {
  const record = asRecord(skill.raw);
  if (!record) return undefined;
  const raw =
    record.platforms ??
    record.platform ??
    record.os ??
    record.supported_platforms ??
    record.requires_platform;
  const list = toStringList(raw);
  return list && list.length > 0 ? list : undefined;
}

/** Conditional-activation metadata: the toolsets a skill requires and the ones
 * it falls back to, when Hermes reports them. Drives the "requires / fallback
 * toolsets" line. Absent fields stay undefined so the row only shows what is
 * real. */
export type SkillActivation = {
  requires?: string[];
  fallback?: string[];
};

/** Extracts conditional-activation toolset metadata from a skill's raw payload,
 * tolerating a few shapes (`requires_toolsets`, `activation.requires`, ...).
 * Returns undefined when neither requires nor fallback is present. */
export function skillActivation(
  skill: HermesSkillInfo,
): SkillActivation | undefined {
  const record = asRecord(skill.raw);
  if (!record) return undefined;
  const activation = asRecord(record.activation) ?? record;
  const requires = toStringList(
    activation.requires ??
      activation.requires_toolsets ??
      activation.required_toolsets ??
      record.requires_toolsets,
  );
  const fallback = toStringList(
    activation.fallback ??
      activation.fallback_toolsets ??
      record.fallback_toolsets,
  );
  if (!requires && !fallback) return undefined;
  return {
    requires: requires && requires.length > 0 ? requires : undefined,
    fallback: fallback && fallback.length > 0 ? fallback : undefined,
  };
}

/** The tags reported for a skill, used for search and (optionally) display.
 * Read defensively from the raw payload. */
export function skillTags(skill: HermesSkillInfo): string[] | undefined {
  const record = asRecord(skill.raw);
  if (!record) return undefined;
  const list = toStringList(record.tags ?? record.keywords ?? record.labels);
  return list && list.length > 0 ? list : undefined;
}

/** The on-disk path a skill loads from, when reported. Shown for external/local
 * skills and searchable. */
export function skillPath(skill: HermesSkillInfo): string | undefined {
  const record = asRecord(skill.raw);
  if (!record) return undefined;
  return pickString(record, ["path", "dir", "directory", "location"]);
}

/** A skill's category for grouping/filtering, when reported. Falls back to its
 * source label so every skill lands in exactly one group. */
export function skillCategory(skill: HermesSkillInfo): string {
  const record = asRecord(skill.raw);
  const category = record
    ? pickString(record, ["category", "group", "collection"])
    : undefined;
  return category ?? sourceMeta(skill.source).label;
}

/** The distinct categories present in a list, sorted for a stable filter row.
 * Always derived from the data so the filter never offers an empty category. */
export function categoriesOf(skills: readonly HermesSkillInfo[]): string[] {
  const seen = new Set<string>();
  for (const skill of skills) seen.add(skillCategory(skill));
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Builds the lowercased haystack a skill is searched against: name,
 * description, category, tags, source, version, and path. Centralized so the
 * search criterion ("by name, description, category, tags, source, and path")
 * is exhaustive and testable. */
export function searchHaystack(skill: HermesSkillInfo): string {
  const parts: Array<string | undefined> = [
    skill.name,
    skill.description,
    skillCategory(skill),
    sourceMeta(skill.source).label,
    skill.source,
    skill.version,
    skillPath(skill),
    ...(skillTags(skill) ?? []),
    ...(skillActivation(skill)?.requires ?? []),
    ...(skillActivation(skill)?.fallback ?? []),
  ];
  return parts
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
}

export type SkillFilter = {
  /** Free-text query; matched case-insensitively against the haystack. */
  query?: string;
  /** When set, only skills in this category pass. */
  category?: string;
};

/** Applies the search + category filter, preserving input order. The result is
 * what the page renders; an empty result with a non-empty filter is the
 * "no matching skills" empty state, distinct from "no skills installed". */
export function filterSkills(
  skills: readonly HermesSkillInfo[],
  filter: SkillFilter,
): HermesSkillInfo[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  const category = filter.category;
  return skills.filter((skill) => {
    if (category && skillCategory(skill) !== category) return false;
    if (query && !searchHaystack(skill).includes(query)) return false;
    return true;
  });
}

// ----------------------------------------------------------------------------
// Local, dependency-free readers (kept here so this module stays render-free and
// independently testable; mirrors the defensive style of `schemas.ts`).
// ----------------------------------------------------------------------------

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

/** Normalizes a string | string[] | comma-list into a clean string array. */
function toStringList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const parts = value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return parts.length > 0 ? parts : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    return parts.length > 0 ? parts : undefined;
  }
  return undefined;
}
