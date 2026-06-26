/**
 * Pure, render-free view logic for the skill lifecycle actions (spec 08):
 * update / audit / uninstall / reset / restore. It owns the ONE decision every
 * lifecycle surface depends on and which the spec makes load-bearing: given a
 * skill's source/provenance, WHICH lifecycle actions are valid, and for an
 * invalid one, WHY it is disabled. The UI never silently hides an action — a
 * disabled action carries the honest reason — and never offers an action that
 * would overwrite local edits without saying so.
 *
 * The source classes the spec calls out:
 * - bundled: cannot be uninstalled like a hub skill; can be reset/restored to
 *   its shipped baseline when the runtime supports it;
 * - official optional: behaves like a hub skill once installed from the official
 *   source (uninstall / update / audit);
 * - hub-installed community: uninstall / update / audit;
 * - local custom: delete only, behind a strong confirmation;
 * - external directory: read-only, delete disabled by default.
 *
 * Nothing here talks to Hermes; it only reshapes already-parsed inventory data.
 * Copy is sentence case, no em/en-dashes, per June conventions. No value is ever
 * logged here.
 */

import type { HermesSkillInfo, HermesSkillSource } from "./schemas";

/** The lifecycle actions a skill row / detail surface can offer. Kept as a
 * closed set so the view and the controller agree on exactly what exists. */
export type SkillLifecycleAction =
  | "check" // re-check this skill against the hub for an available update
  | "update" // pull the latest version of an installed hub/official skill
  | "audit" // re-scan an installed hub/official skill's contents
  | "uninstall" // remove a hub/official-installed skill
  | "delete" // remove a local custom skill (strong confirmation)
  | "reset" // reset a bundled skill's manifest to its shipped baseline
  | "restore"; // restore a bundled skill from upstream, when supported

/** June's lifecycle classification of a skill, finer-grained than the raw
 * inventory {@link HermesSkillSource}. The inventory does not distinguish an
 * "official optional" hub skill from a "community" one or a "local custom" skill
 * from a generic unknown, so we read provenance hints off the raw payload to
 * refine it. The class drives which actions are valid. */
export type SkillLifecycleClass =
  | "bundled"
  | "official-optional"
  | "community"
  | "local"
  | "external"
  | "unknown";

/** One lifecycle action's availability for a skill: whether it is allowed, and
 * when it is not, the user-facing reason (never blank, so a disabled control
 * always explains itself). `destructive` flags an action that removes a skill,
 * so the UI can require a stronger confirmation. `divergenceWarning` is set when
 * the action could overwrite local edits, so the surface warns before running
 * it rather than silently clobbering a user's changes. */
export type SkillActionAvailability = {
  action: SkillLifecycleAction;
  available: boolean;
  /** Why the action is unavailable, when it is. Sentence case, no dashes. */
  reason?: string;
  /** True for an action that removes the skill (uninstall / delete). */
  destructive?: boolean;
  /** A note shown before running an action that may overwrite local edits. */
  divergenceWarning?: string;
};

/** The full lifecycle policy for one skill: its class, the install identifier to
 * pass to hub actions (when it has one), whether local edits have diverged, and
 * the availability of every action. */
export type SkillLifecyclePolicy = {
  source: HermesSkillSource;
  lifecycleClass: SkillLifecycleClass;
  /** The hub identifier to pass to update/audit/uninstall, when the skill came
   * from the hub/official source and reports one. Undefined for a skill with no
   * hub provenance (a bundled or local skill). */
  hubIdentifier?: string;
  /** True when Hermes reports an update is available upstream. */
  updateAvailable: boolean;
  /** True when local edits have diverged from the installed/baseline version, so
   * an update/reset would overwrite them. */
  locallyModified: boolean;
  /** Availability of every action, keyed by action for direct lookup. */
  actions: Readonly<Record<SkillLifecycleAction, SkillActionAvailability>>;
};

const ALL_ACTIONS: readonly SkillLifecycleAction[] = [
  "check",
  "update",
  "audit",
  "uninstall",
  "delete",
  "reset",
  "restore",
];

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Refines the raw inventory source into a finer lifecycle class. The inventory
 * collapses "official" into `bundled` (see `parseSkillSource`), so an installed
 * official-optional skill arrives as `hub` with an official-looking source hint
 * on its raw payload; a `bundled` skill that is actually a removable official
 * optional is detected the same way. A `hub` skill with no special hint is
 * `community`; an `external` skill is `external`; an explicit local/custom hint
 * (or a writable skill with no hub provenance) is `local`. */
export function skillLifecycleClass(
  skill: HermesSkillInfo,
): SkillLifecycleClass {
  if (skill.readOnly || skill.source === "external") return "external";

  const provenance = readProvenance(skill);

  if (skill.source === "hub") {
    return provenance === "official" ? "official-optional" : "community";
  }
  if (skill.source === "bundled") {
    // A bundled-classified skill that upstream marks installed from the official
    // OPTIONAL source is removable via the hub lifecycle; a truly built-in
    // skill stays `bundled` (reset/restore only).
    if (provenance === "official" && hubIdentifierOf(skill)) {
      return "official-optional";
    }
    return "bundled";
  }
  if (skill.source === "unknown") {
    // A writable unknown-source skill with a local/custom hint is local; with a
    // hub identifier it is community; otherwise genuinely unknown.
    if (provenance === "local") return "local";
    if (hubIdentifierOf(skill)) return "community";
    return "unknown";
  }
  return "unknown";
}

/** A provenance hint read off the raw payload, used only to refine the class.
 * `official` / `community` / `local` when a recognizable hint is present,
 * otherwise undefined. */
type SkillProvenance = "official" | "community" | "local" | undefined;

function readProvenance(skill: HermesSkillInfo): SkillProvenance {
  const record = asRecord(skill.raw);
  if (!record) return undefined;
  const hint = pickString(record, [
    "provenance",
    "install_source",
    "installSource",
    "hub_source",
    "hubSource",
    "origin_source",
    "channel",
    "tap",
  ])?.toLowerCase();
  if (!hint) {
    // A boolean `official`/`builtin` flag, or a `custom`/`local` flag.
    if (pickBool(record, ["official", "is_official"]) === true)
      return "official";
    if (
      pickBool(record, ["custom", "is_custom", "local", "is_local"]) === true
    ) {
      return "local";
    }
    return undefined;
  }
  if (
    hint === "official" ||
    hint === "builtin" ||
    hint === "built-in" ||
    hint === "nous" ||
    hint === "hermes"
  ) {
    return "official";
  }
  if (hint === "local" || hint === "custom" || hint === "user") return "local";
  return "community";
}

/** The hub install identifier for a skill, read off the raw payload when the
 * skill was installed from the hub/official source. Falls back to the skill name
 * only when an explicit identifier-shaped field is present, never blindly, so a
 * bundled/local skill does not get a bogus identifier. Returns undefined when no
 * hub provenance is reported. */
export function hubIdentifierOf(skill: HermesSkillInfo): string | undefined {
  const record = asRecord(skill.raw);
  if (!record) return undefined;
  return pickString(record, [
    "identifier",
    "install_identifier",
    "installIdentifier",
    "hub_identifier",
    "hubIdentifier",
    "ref",
    "slug",
  ]);
}

/** True when the inventory reports local edits have diverged from the installed
 * or shipped baseline (so an update/reset would overwrite them). Read
 * defensively from a few flag shapes; defaults to false (never assume a skill is
 * dirty without a signal). */
export function isLocallyModified(skill: HermesSkillInfo): boolean {
  const record = asRecord(skill.raw);
  if (!record) return false;
  return (
    pickBool(record, [
      "locally_modified",
      "locallyModified",
      "modified",
      "dirty",
      "has_local_changes",
      "hasLocalChanges",
      "diverged",
    ]) === true
  );
}

/** True when Hermes reports an upstream update is available for this skill. */
export function hasUpdateAvailable(skill: HermesSkillInfo): boolean {
  const record = asRecord(skill.raw);
  if (!record) return false;
  return (
    pickBool(record, [
      "update_available",
      "updateAvailable",
      "has_update",
      "outdated",
    ]) === true
  );
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Standing reasons, kept in one place so the disabled-action copy matches the
 * spec wording and June's no-dashes / sentence-case rules. */
const REASON = Object.freeze({
  notHub:
    "This skill was not installed from the Skills Hub, so it has no upstream version to update or audit.",
  externalReadOnly:
    "This skill loads from an external directory. June treats it as read-only, so it cannot be removed or changed here.",
  bundledNotRemovable:
    "This skill ships with Hermes and cannot be uninstalled. Reset it to its shipped version instead.",
  noLocalDelete:
    "Only locally created skills can be deleted. Use uninstall for hub skills or reset for bundled skills.",
  resetBundledOnly: "Only bundled skills can be reset to a shipped baseline.",
  restoreBundledOnly: "Only bundled skills can be restored from upstream.",
  notInstalled: "This skill is not installed, so there is nothing to remove.",
  unknownSource:
    "June could not determine where this skill came from, so lifecycle actions are unavailable. Manage it in Hermes.",
});

/** Divergence warnings, shown before an action that could overwrite local edits. */
const DIVERGENCE = Object.freeze({
  update:
    "This skill has local edits. Updating it replaces them with the upstream version. Save a copy first if you want to keep your changes.",
  reset:
    "This skill has local edits. Resetting it restores the shipped version and discards your changes.",
});

/** Builds the full lifecycle policy for a skill: its class, hub identifier,
 * divergence state, and every action's availability with an honest reason. This
 * is the single source of truth the row/detail UI and the controller both read,
 * so a disabled action and a refused action can never disagree. */
export function skillLifecyclePolicy(
  skill: HermesSkillInfo,
): SkillLifecyclePolicy {
  const lifecycleClass = skillLifecycleClass(skill);
  const hubIdentifier =
    lifecycleClass === "community" || lifecycleClass === "official-optional"
      ? (hubIdentifierOf(skill) ?? skill.name)
      : hubIdentifierOf(skill);
  const updateAvailable = hasUpdateAvailable(skill);
  const locallyModified = isLocallyModified(skill);

  const isHubManaged =
    lifecycleClass === "community" || lifecycleClass === "official-optional";

  const actions = {} as Record<SkillLifecycleAction, SkillActionAvailability>;
  for (const action of ALL_ACTIONS) {
    actions[action] = availabilityFor(action, {
      lifecycleClass,
      isHubManaged,
      locallyModified,
    });
  }

  return {
    source: skill.source,
    lifecycleClass,
    hubIdentifier,
    updateAvailable,
    locallyModified,
    actions: Object.freeze(actions),
  };
}

/** Decides one action's availability for a class. Centralized so the matrix is
 * exhaustive and testable. */
function availabilityFor(
  action: SkillLifecycleAction,
  ctx: {
    lifecycleClass: SkillLifecycleClass;
    isHubManaged: boolean;
    locallyModified: boolean;
  },
): SkillActionAvailability {
  const { lifecycleClass, isHubManaged, locallyModified } = ctx;
  const base: SkillActionAvailability = { action, available: false };

  switch (action) {
    case "check":
    case "update":
    case "audit": {
      if (isHubManaged) {
        const out: SkillActionAvailability = { ...base, available: true };
        if (action === "update" && locallyModified) {
          out.divergenceWarning = DIVERGENCE.update;
        }
        return out;
      }
      return {
        ...base,
        reason:
          lifecycleClass === "external"
            ? REASON.externalReadOnly
            : lifecycleClass === "unknown"
              ? REASON.unknownSource
              : REASON.notHub,
      };
    }
    case "uninstall": {
      if (isHubManaged) return { ...base, available: true, destructive: true };
      return {
        ...base,
        reason:
          lifecycleClass === "bundled"
            ? REASON.bundledNotRemovable
            : lifecycleClass === "external"
              ? REASON.externalReadOnly
              : lifecycleClass === "local"
                ? REASON.noLocalDelete
                : REASON.notInstalled,
      };
    }
    case "delete": {
      if (lifecycleClass === "local") {
        return { ...base, available: true, destructive: true };
      }
      return {
        ...base,
        reason:
          lifecycleClass === "external"
            ? REASON.externalReadOnly
            : REASON.noLocalDelete,
      };
    }
    case "reset": {
      if (lifecycleClass === "bundled") {
        const out: SkillActionAvailability = { ...base, available: true };
        if (locallyModified) out.divergenceWarning = DIVERGENCE.reset;
        return out;
      }
      return { ...base, reason: REASON.resetBundledOnly };
    }
    case "restore": {
      if (lifecycleClass === "bundled") {
        return { ...base, available: true };
      }
      return { ...base, reason: REASON.restoreBundledOnly };
    }
  }
}

/** The lifecycle actions that are AVAILABLE for a policy, in display order. Lets
 * a row render only valid actions inline while the detail surface can still list
 * the disabled ones with their reasons. */
export function availableActions(
  policy: SkillLifecyclePolicy,
): SkillActionAvailability[] {
  return ALL_ACTIONS.map((action) => policy.actions[action]).filter(
    (a) => a.available,
  );
}

/** A short, sentence-case label for a lifecycle action, for buttons. */
export function lifecycleActionLabel(action: SkillLifecycleAction): string {
  switch (action) {
    case "check":
      return "Check for updates";
    case "update":
      return "Update";
    case "audit":
      return "Audit";
    case "uninstall":
      return "Uninstall";
    case "delete":
      return "Delete";
    case "reset":
      return "Reset to shipped version";
    case "restore":
      return "Restore from upstream";
  }
}

/** The slug a skill name must match before it can ride the reset CLI as a
 * discrete argument. Mirrors the Rust `is_safe_skill_name` rule (and the MCP
 * server-name pattern): a leading alphanumeric then `[A-Za-z0-9._-]`, max 64.
 * Defense in depth — the Tauri command re-validates — but rejecting unsafe names
 * here keeps a bad name from ever leaving the webview. */
const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** True when `name` is safe to pass to the reset CLI as a discrete argument. */
export function isSafeSkillName(name: string): boolean {
  return SAFE_SKILL_NAME.test(name);
}

/** A human label + blurb for a lifecycle class, for the provenance line. */
export function lifecycleClassMeta(lifecycleClass: SkillLifecycleClass): {
  label: string;
  blurb: string;
} {
  switch (lifecycleClass) {
    case "bundled":
      return {
        label: "Bundled",
        blurb:
          "Ships with Hermes. Reset or restore, but cannot be uninstalled.",
      };
    case "official-optional":
      return {
        label: "Official",
        blurb:
          "Installed from the official source. Update, audit, or uninstall.",
      };
    case "community":
      return {
        label: "Community",
        blurb:
          "Installed from the Skills Hub. Update, audit, or uninstall it any time.",
      };
    case "local":
      return {
        label: "Local",
        blurb: "Created on this machine. Delete it when you no longer need it.",
      };
    case "external":
      return {
        label: "External",
        blurb:
          "Loaded from an external directory. Read-only in June; manage it on disk.",
      };
    case "unknown":
      return {
        label: "Skill",
        blurb: "Source not reported by Hermes. Manage it in Hermes.",
      };
  }
}

// ---------------------------------------------------------------------------
// Local, dependency-free readers (mirrors installed-skills-view's style).
// ---------------------------------------------------------------------------

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

function pickBool(
  record: Record<string, unknown>,
  keys: string[],
): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}
