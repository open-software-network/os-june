/**
 * Pure, render-free view logic for the Toolsets inventory page (spec 04):
 * deriving each toolset's status (active / inactive / configured / missing
 * setup), its sandbox/unrestricted implications, the search filter, and the
 * skill-requirement explanations that tell a user why a skill is active, hidden,
 * or not yet useful. Kept separate from the React component and the data hook so
 * the "explain capability honestly" acceptance criteria are unit-testable
 * without rendering and without a network.
 *
 * The guiding rule from the spec: DO NOT invent state. Where Hermes does not
 * report a requirement, an allowance, or an activation reason, this returns an
 * explicit `unknown` rather than guessing. Copy is sentence case, no
 * em/en-dashes, per June conventions.
 */

import type { HermesSkillInfo } from "./schemas";
import type {
  HermesToolsetInfo,
  HermesToolsetModeAllowance,
  HermesToolsetRequirement,
} from "./schemas";

// ----------------------------------------------------------------------------
// Toolset status
// ----------------------------------------------------------------------------

/** The derived state a user reads on a toolset row.
 * - `active`: enabled and all known prerequisites satisfied.
 * - `inactive`: prerequisites are fine, but the toolset is turned off.
 * - `missing-setup`: a prerequisite is unmet (an env var / binary), so the
 *   toolset cannot work until it is configured, regardless of enabled.
 * - `unknown`: Hermes reported neither an enabled flag we can trust nor any
 *   requirement metadata, so June will not assert a state. */
export type ToolsetStatus = "active" | "inactive" | "missing-setup" | "unknown";

export type ToolsetStatusView = {
  status: ToolsetStatus;
  /** Sentence-case label for the status pill. */
  label: string;
  /** Tone the UI maps to a color treatment. */
  tone: "positive" | "neutral" | "attention" | "unknown";
};

/** Whether any reported requirement is explicitly unmet. A requirement with no
 * `satisfied` flag is treated as not-yet-known (it does not, by itself, mark the
 * toolset as missing setup) so June does not over-claim a broken state. */
export function hasUnmetRequirement(toolset: HermesToolsetInfo): boolean {
  return (toolset.requirements ?? []).some(
    (requirement) => requirement.satisfied === false,
  );
}

/** The unmet requirements only (the ones a user must act on). */
export function unmetRequirements(
  toolset: HermesToolsetInfo,
): HermesToolsetRequirement[] {
  return (toolset.requirements ?? []).filter(
    (requirement) => requirement.satisfied === false,
  );
}

/** Derives the user-facing status from the parsed toolset. Honest by
 * construction: an unmet requirement wins (missing setup); an explicit
 * `configured: false` with no requirement detail also reads as missing setup;
 * otherwise enabled→active / disabled→inactive. When the wire gave us nothing to
 * go on, the status is `unknown`. */
export function toolsetStatus(toolset: HermesToolsetInfo): ToolsetStatusView {
  if (hasUnmetRequirement(toolset) || toolset.configured === false) {
    return {
      status: "missing-setup",
      label: "Missing setup",
      tone: "attention",
    };
  }
  if (toolset.enabled) {
    return { status: "active", label: "Active", tone: "positive" };
  }
  // A disabled toolset whose requirements are met (or unknown) is simply off.
  return { status: "inactive", label: "Inactive", tone: "neutral" };
}

// ----------------------------------------------------------------------------
// Sandbox / unrestricted implications
// ----------------------------------------------------------------------------

export type ToolsetModeView = {
  /** Short pill label, sentence case. */
  label: string;
  /** Longer tooltip / secondary line. */
  detail: string;
  /** True when June could not determine the allowance (unknown, not guessed). */
  unknown: boolean;
};

/** Turns a toolset's reported mode allowance into display copy. When neither
 * flag is reported the result is explicitly unknown rather than a default of
 * "both", honoring the spec's "do not invent state". */
export function toolsetMode(
  modes: HermesToolsetModeAllowance | undefined,
): ToolsetModeView {
  if (
    !modes ||
    (modes.sandboxed === undefined && modes.unrestricted === undefined)
  ) {
    return {
      label: "Mode unknown",
      detail:
        "Hermes did not report which runtime mode this toolset is allowed in.",
      unknown: true,
    };
  }
  const sandboxed = modes.sandboxed === true;
  const unrestricted = modes.unrestricted === true;
  if (sandboxed && unrestricted) {
    return {
      label: "Sandboxed and Full mode",
      detail: "Available in both the sandboxed and the Full mode runtime.",
      unknown: false,
    };
  }
  if (unrestricted && !sandboxed) {
    return {
      label: "Full mode only",
      detail:
        "Available only in the Full mode runtime. The sandboxed runtime does not allow it.",
      unknown: false,
    };
  }
  if (sandboxed && !unrestricted) {
    return {
      label: "Sandboxed only",
      detail: "Available only in the sandboxed runtime.",
      unknown: false,
    };
  }
  // Both reported as false — explicitly not allowed in either.
  return {
    label: "Not allowed in either mode",
    detail:
      "Hermes reports this toolset is not allowed in the current runtimes.",
    unknown: false,
  };
}

// ----------------------------------------------------------------------------
// Search / filter
// ----------------------------------------------------------------------------

/** A human label for a toolset: its reported label, else its name. */
export function toolsetLabel(toolset: HermesToolsetInfo): string {
  return toolset.label ?? toolset.name;
}

/** Builds the lowercased haystack a toolset is searched against: name, label,
 * description, tool names, and requirement labels. */
export function toolsetHaystack(toolset: HermesToolsetInfo): string {
  const parts: Array<string | undefined> = [
    toolset.name,
    toolset.label,
    toolset.description,
    ...(toolset.tools ?? []),
    ...(toolset.requirements ?? []).map((requirement) => requirement.label),
  ];
  return parts
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
}

/** Applies the free-text filter, preserving input order. */
export function filterToolsets(
  toolsets: readonly HermesToolsetInfo[],
  query: string,
): HermesToolsetInfo[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...toolsets];
  return toolsets.filter((toolset) =>
    toolsetHaystack(toolset).includes(needle),
  );
}

// ----------------------------------------------------------------------------
// Skill requirement explanations
// ----------------------------------------------------------------------------

/** The toolset/tool dependencies a skill declares, read from its raw payload.
 * Each list is undefined when the skill does not declare that field, so the
 * explanation never claims a dependency the skill did not state. */
export type SkillRequirements = {
  requiresToolsets?: string[];
  fallbackForToolsets?: string[];
  requiresTools?: string[];
  fallbackForTools?: string[];
};

/** Reads a skill's requires/fallback declarations from its raw payload,
 * tolerating snake_case and camelCase and an optional nested `activation`
 * object. Returns undefined when the skill declares none of them. */
export function skillRequirements(
  skill: HermesSkillInfo,
): SkillRequirements | undefined {
  const record = asRecord(skill.raw);
  if (!record) return undefined;
  const activation = asRecord(record.activation) ?? record;
  const requiresToolsets = toStringList(
    record.requires_toolsets ??
      record.requiresToolsets ??
      activation.requires_toolsets ??
      activation.requires,
  );
  const fallbackForToolsets = toStringList(
    record.fallback_for_toolsets ??
      record.fallbackForToolsets ??
      activation.fallback_for_toolsets ??
      activation.fallback,
  );
  const requiresTools = toStringList(
    record.requires_tools ?? record.requiresTools ?? activation.requires_tools,
  );
  const fallbackForTools = toStringList(
    record.fallback_for_tools ??
      record.fallbackForTools ??
      activation.fallback_for_tools,
  );
  if (
    !requiresToolsets &&
    !fallbackForToolsets &&
    !requiresTools &&
    !fallbackForTools
  ) {
    return undefined;
  }
  return {
    requiresToolsets,
    fallbackForToolsets,
    requiresTools,
    fallbackForTools,
  };
}

/** How a skill's visibility relates to toolset availability. */
export type SkillActivationStatus =
  | "visible" // required dependency available
  | "hidden" // a fallback dependency is available, so this skill is suppressed
  | "missing-setup" // a required dependency is unavailable
  | "unknown"; // the skill declares no requirement metadata

export type SkillExplanation = {
  status: SkillActivationStatus;
  /** A single sentence explaining the status, matching the spec's examples. */
  message: string;
};

/** A toolset is "available" for the purpose of skill activation when it is
 * present, enabled, and has no unmet requirement. A toolset June has never heard
 * of is not available. */
export function availableToolsetNames(
  toolsets: readonly HermesToolsetInfo[],
): Set<string> {
  const names = new Set<string>();
  for (const toolset of toolsets) {
    if (toolset.enabled && !hasUnmetRequirement(toolset)) {
      names.add(toolset.name);
    }
  }
  return names;
}

/** The tool names exposed by every available toolset, for `requires_tools` /
 * `fallback_for_tools` resolution. */
export function availableToolNames(
  toolsets: readonly HermesToolsetInfo[],
): Set<string> {
  const names = new Set<string>();
  for (const toolset of toolsets) {
    if (!toolset.enabled || hasUnmetRequirement(toolset)) continue;
    for (const tool of toolset.tools ?? []) names.add(tool);
  }
  return names;
}

function firstPresent(
  needed: string[] | undefined,
  available: Set<string>,
): string | undefined {
  return needed?.find((name) => available.has(name));
}

function firstMissing(
  needed: string[] | undefined,
  available: Set<string>,
): string | undefined {
  return needed?.find((name) => !available.has(name));
}

/**
 * Explains why a skill is active, hidden, or not yet useful, given the toolset
 * inventory. Built ONLY from declared metadata: a skill with no requires/fallback
 * declarations returns `unknown` (never a fabricated reason). The precedence
 * mirrors how Hermes gates skills:
 *
 * 1. If a required toolset/tool is unavailable, the skill is `missing-setup`.
 * 2. Else if the skill is a fallback for an available toolset/tool, it is
 *    `hidden` (a better capability is already present).
 * 3. Else (its required dependency is available, and no fallback target is), it
 *    is `visible`.
 */
export function explainSkill(
  skill: HermesSkillInfo,
  toolsets: readonly HermesToolsetInfo[],
): SkillExplanation {
  const requirements = skillRequirements(skill);
  if (!requirements) {
    return {
      status: "unknown",
      message: "Hermes did not report requirement metadata for this skill.",
    };
  }
  const toolsetsAvailable = availableToolsetNames(toolsets);
  const toolsAvailable = availableToolNames(toolsets);

  // 1. A required dependency that is unavailable blocks the skill.
  const missingToolset = firstMissing(
    requirements.requiresToolsets,
    toolsetsAvailable,
  );
  if (missingToolset) {
    return {
      status: "missing-setup",
      message: `Not useful until the ${missingToolset} toolset is available.`,
    };
  }
  const missingTool = firstMissing(requirements.requiresTools, toolsAvailable);
  if (missingTool) {
    return {
      status: "missing-setup",
      message: `Not useful until the ${missingTool} tool is available.`,
    };
  }

  // 2. A fallback skill is hidden when its better alternative is available.
  const supersedingToolset = firstPresent(
    requirements.fallbackForToolsets,
    toolsetsAvailable,
  );
  if (supersedingToolset) {
    return {
      status: "hidden",
      message: `Hidden because ${supersedingToolset} is available and this is a fallback skill.`,
    };
  }
  const supersedingTool = firstPresent(
    requirements.fallbackForTools,
    toolsAvailable,
  );
  if (supersedingTool) {
    return {
      status: "hidden",
      message: `Hidden because ${supersedingTool} is available and this is a fallback skill.`,
    };
  }

  // 3. A required dependency is satisfied → visible.
  const presentToolset = firstPresent(
    requirements.requiresToolsets,
    toolsetsAvailable,
  );
  if (presentToolset) {
    return {
      status: "visible",
      message: `Visible because the ${presentToolset} toolset is available.`,
    };
  }
  const presentTool = firstPresent(requirements.requiresTools, toolsAvailable);
  if (presentTool) {
    return {
      status: "visible",
      message: `Visible because the ${presentTool} tool is available.`,
    };
  }

  // The skill declared only a fallback, and no fallback target is available, so
  // it stands in as the active capability.
  return {
    status: "visible",
    message: "Visible because no higher-priority capability is available.",
  };
}

// ----------------------------------------------------------------------------
// Last refreshed
// ----------------------------------------------------------------------------

/** A relative "last refreshed" label from an epoch-ms timestamp. Coarse on
 * purpose (the inventory does not change second to second). `now` is injectable
 * for tests. */
export function lastRefreshedLabel(
  at: number | undefined,
  now: number = Date.now(),
): string {
  if (at === undefined) return "Not refreshed yet";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "Refreshed just now";
  if (seconds < 60) return `Refreshed ${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `Refreshed ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  const hours = Math.round(minutes / 60);
  return `Refreshed ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}

// ----------------------------------------------------------------------------
// Local, dependency-free readers (mirrors the defensive style of schemas.ts).
// ----------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
