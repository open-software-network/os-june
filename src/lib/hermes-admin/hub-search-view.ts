/**
 * Pure, render-free view logic for the Skills Hub browser (spec 06): friendly
 * source labels, trust-level badges + advisory copy, direct-URL detection, the
 * client-side source filter, and the searchable haystack. Kept separate from the
 * React component and the data hook so "browse / search / inspect" behavior is
 * unit-testable without rendering and without a network: given parsed
 * {@link HermesHubSkillResult}s and a filter, this decides exactly what the user
 * sees.
 *
 * The user never has to understand Hermes' raw source identifiers. This module
 * maps each upstream source to a friendly label; the exact install identifier
 * stays available for the advanced/details surface. Copy is sentence case, no
 * em/en-dashes, per June conventions.
 */

import type { HermesHubSkillResult, HermesHubTrustLevel } from "./schemas";

/** The friendly source groups June filters by. `official` are Hermes' optional
 * skills, `skills-sh` is the skills.sh registry, `well-known` a well-known skill
 * endpoint, `github` a GitHub path/tap, `url` a direct single-file SKILL.md, and
 * `other` anything upstream returns that does not map cleanly. */
export type HubSourceKind =
  | "official"
  | "skills-sh"
  | "well-known"
  | "github"
  | "url"
  | "other";

/** A friendly label + blurb for a source kind, so the UI never shows a raw
 * source identifier and a user can tell a curated source from a direct URL. */
export type HubSourceMeta = {
  kind: HubSourceKind;
  /** Short pill label, sentence case. */
  label: string;
  /** One-line explanation for a tooltip / secondary line. */
  blurb: string;
};

const SOURCE_META: Readonly<Record<HubSourceKind, HubSourceMeta>> =
  Object.freeze({
    official: {
      kind: "official",
      label: "Official",
      blurb: "An optional skill maintained alongside Hermes.",
    },
    "skills-sh": {
      kind: "skills-sh",
      label: "skills.sh",
      blurb: "Published to the skills.sh registry.",
    },
    "well-known": {
      kind: "well-known",
      label: "Well known",
      blurb: "Served from a well-known skill endpoint.",
    },
    github: {
      kind: "github",
      label: "GitHub",
      blurb: "Installed from a GitHub path or tap.",
    },
    url: {
      kind: "url",
      label: "Direct URL",
      blurb: "A single SKILL.md file installed straight from a URL.",
    },
    other: {
      kind: "other",
      label: "Other",
      blurb: "Source reported by Hermes.",
    },
  });

/** The display metadata for a source kind. */
export function sourceKindMeta(kind: HubSourceKind): HubSourceMeta {
  return SOURCE_META[kind];
}

/** Maps a hub result's raw source/identifier to a friendly source kind. Reads
 * the explicit `source` first, then infers from the identifier shape (a URL, a
 * `github:`/`gh:` ref, a `skills.sh/...` ref) so a result with a terse source
 * still groups sensibly. */
export function sourceKindFor(result: HermesHubSkillResult): HubSourceKind {
  const source = result.source?.toLowerCase().trim();
  if (source) {
    if (source === "official" || source === "builtin" || source === "bundled") {
      return "official";
    }
    if (
      source === "skills.sh" ||
      source === "skills-sh" ||
      source === "skillssh"
    ) {
      return "skills-sh";
    }
    if (
      source === "well-known" ||
      source === "well_known" ||
      source === "wellknown"
    ) {
      return "well-known";
    }
    if (source === "github" || source === "gh" || source === "tap") {
      return "github";
    }
    if (source === "url" || source === "direct" || source === "direct-url") {
      return "url";
    }
  }
  // Infer from the identifier when the source is absent or unrecognized.
  const id = result.identifier.toLowerCase();
  if (isDirectUrlInstall(result)) return "url";
  if (
    id.startsWith("github:") ||
    id.startsWith("gh:") ||
    id.includes("github.com")
  ) {
    return "github";
  }
  if (id.startsWith("skills.sh/") || id.includes("skills.sh"))
    return "skills-sh";
  return "other";
}

/** True when installing this result fetches a single-file SKILL.md straight from
 * a URL. These are the lowest-trust installs and the UI requires an explicit
 * confirmation before installing one. */
export function isDirectUrlInstall(result: HermesHubSkillResult): boolean {
  if (result.source?.toLowerCase().trim() === "url") return true;
  const id = result.identifier.trim();
  return /^https?:\/\//i.test(id);
}

/** A trust badge's display metadata. */
export type HubTrustMeta = {
  level: HermesHubTrustLevel;
  /** Short pill label, sentence case. */
  label: string;
  /** Tone the UI styles the badge with. */
  tone: "trusted" | "neutral" | "caution";
  /** One-line advisory for the detail surface. */
  advisory: string;
};

const TRUST_META: Readonly<Record<HermesHubTrustLevel, HubTrustMeta>> =
  Object.freeze({
    official: {
      level: "official",
      label: "Official",
      tone: "trusted",
      advisory: "Maintained alongside Hermes.",
    },
    verified: {
      level: "verified",
      label: "Verified",
      tone: "trusted",
      advisory: "From a verified source.",
    },
    community: {
      level: "community",
      label: "Community",
      tone: "caution",
      advisory:
        "From a community source. Review what it does before you install it.",
    },
    unknown: {
      level: "unknown",
      label: "Unverified",
      tone: "neutral",
      advisory:
        "Hermes did not report a trust level. Review before installing.",
    },
  });

/** The display metadata for a trust level. */
export function trustMeta(level: HermesHubTrustLevel): HubTrustMeta {
  return TRUST_META[level];
}

/** Builds the lowercased haystack a hub result is searched against locally:
 * name, description, identifier, friendly + raw source, category, tags, version,
 * and author. Centralized so the local filter is exhaustive and testable. (The
 * server-side `q` is the primary search; this refines the returned set.) */
export function hubSearchHaystack(result: HermesHubSkillResult): string {
  const parts: Array<string | undefined> = [
    result.name,
    result.description,
    result.identifier,
    result.source,
    sourceKindMeta(sourceKindFor(result)).label,
    result.category,
    result.version,
    result.author,
    ...(result.tags ?? []),
  ];
  return parts
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
}

export type HubFilter = {
  /** Free-text query refining the server-returned set, case-insensitive. */
  query?: string;
  /** When set, only results in this source kind pass. */
  sourceKind?: HubSourceKind;
};

/** Applies the source + local-text filter to the server-returned results,
 * preserving order. An empty result with a non-empty filter is the
 * "no matching skills" empty state, distinct from "no results from the hub". */
export function filterHubResults(
  results: readonly HermesHubSkillResult[],
  filter: HubFilter,
): HermesHubSkillResult[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  const sourceKind = filter.sourceKind;
  return results.filter((result) => {
    if (sourceKind && sourceKindFor(result) !== sourceKind) return false;
    if (query && !hubSearchHaystack(result).includes(query)) return false;
    return true;
  });
}

/** The distinct source kinds present in a result set, in a stable display order
 * (official first, direct URL last) so the filter row never reorders as results
 * change and never offers an empty source. */
export function sourceKindsOf(
  results: readonly HermesHubSkillResult[],
): HubSourceKind[] {
  const order: HubSourceKind[] = [
    "official",
    "skills-sh",
    "well-known",
    "github",
    "url",
    "other",
  ];
  const present = new Set<HubSourceKind>();
  for (const result of results) present.add(sourceKindFor(result));
  return order.filter((kind) => present.has(kind));
}
