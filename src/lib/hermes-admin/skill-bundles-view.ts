/**
 * Pure, render-free view + validation logic for the Skill Bundles manager
 * (admin surfaces spec 11). A Hermes skill bundle is a YAML alias under
 * `~/.hermes/skill-bundles/<slug>.yaml` that loads several skills under one
 * slash command (`/backend-dev`). Bundles dispatch the same way across CLI,
 * TUI, dashboard chat, and gateways, so getting the slug + member rules right
 * once here makes them correct everywhere.
 *
 * Nothing in this module talks to Hermes or the bridge. Given a raw bundle and
 * the installed-skill list it decides exactly what the user sees: the safe
 * slash-command slug, the resolved/missing status of each member, whether the
 * slug collides with an installed skill (the bundle wins, with a warning), and
 * the slash-command preview. Kept separate from the data hook and the React
 * component so every rule is unit-testable with no network and no rendering.
 *
 * Copy is sentence case with no em/en-dashes, per June conventions.
 */

import type { HermesSkillInfo } from "./schemas";

/** The on-disk shape June reads/writes for one bundle. Mirrors the bridge's
 * `SkillBundle` payload. `slug` is the file stem (and the slash command);
 * `skills` is the ordered list of member skill identifiers; `instructions` is
 * the optional extra prompt text Hermes prepends when the bundle is invoked. */
export type SkillBundle = {
  /** Safe slash-command slug, also the YAML file stem. */
  slug: string;
  /** Human display name. Falls back to the slug when absent. */
  name?: string;
  /** One-line description of what the bundle is for. */
  description?: string;
  /** Ordered member skill identifiers. May reference skills that are not
   * installed; those are surfaced as warnings, never errors. */
  skills: string[];
  /** Optional instruction text prepended at invocation. */
  instructions?: string;
};

/** A bundle as the manager renders it: the stored fields plus the derived
 * resolved/missing member status, the slash-command preview, and the
 * skill-name collision flag. */
export type ResolvedSkillBundle = {
  bundle: SkillBundle;
  /** The slash command this bundle answers to, e.g. `/backend-dev`. */
  slashCommand: string;
  /** Each member with its resolved/missing status, in bundle order. */
  members: ResolvedBundleMember[];
  /** True when one or more members are not installed. Hermes skips missing
   * skills at invocation, so this is a warning, not an error. */
  hasMissing: boolean;
  /** True when an installed skill shares this bundle's slug. The bundle wins at
   * dispatch, so the manager warns about the shadowed skill. */
  collidesWithSkill: boolean;
};

/** One member of a bundle, resolved against the installed-skill list. */
export type ResolvedBundleMember = {
  /** The identifier as stored in the bundle. */
  identifier: string;
  /** The matching installed skill, when one exists. */
  skill?: HermesSkillInfo;
  /** True when no installed skill matches (a warning row). */
  missing: boolean;
};

/** A validation problem with a draft bundle, classified so the UI can block on
 * errors but still allow saving past warnings. */
export type BundleValidationIssue = {
  severity: "error" | "warning";
  /** Which field the issue is about, for inline placement. */
  field: "slug" | "skills";
  message: string;
};

/** The outcome of validating a draft bundle. `canSave` is false only when an
 * error is present; warnings (missing skills, slug collision) do not block. */
export type BundleValidation = {
  canSave: boolean;
  issues: BundleValidationIssue[];
};

/** Max length of a bundle slug, matching the bridge's arg-safe slug rule
 * (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, so 64 chars total). */
export const BUNDLE_SLUG_MAX_LENGTH = 64;

/**
 * Normalizes free text into a safe slash-command slug: lowercased, spaces and
 * runs of disallowed characters collapsed to single hyphens, leading/trailing
 * separators trimmed, and capped at {@link BUNDLE_SLUG_MAX_LENGTH}. The result
 * always satisfies {@link isSafeBundleSlug} or is the empty string (when the
 * input had no usable characters). This is what makes "Backend Dev!" become
 * `backend-dev` and guarantees the value can never arrive at the bridge as a
 * traversal or a stray flag.
 */
export function normalizeBundleSlug(input: string): string {
  const lowered = input.trim().toLowerCase();
  // Replace any run of characters outside the allowed set with a single hyphen.
  const collapsed = lowered.replace(/[^a-z0-9._-]+/g, "-");
  // Collapse any run of separators (mixed `.`, `-`, `_`) into a single hyphen so
  // a traversal-shaped input like `a/../b` does not leave a `..` in the slug,
  // then trim separators from the ends so the slug starts and ends on an
  // alphanumeric-friendly boundary.
  const trimmed = collapsed
    .replace(/[-._]{2,}/g, "-")
    .replace(/^[-._]+/, "")
    .replace(/[-._]+$/, "");
  return trimmed.slice(0, BUNDLE_SLUG_MAX_LENGTH);
}

/** True when a slug is already a safe slash-command slug: a leading
 * alphanumeric, then `[a-z0-9._-]`, max 64. Mirrors the Rust validator so the
 * two never disagree about what the bridge will accept. */
export function isSafeBundleSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug);
}

/** The slash command for a slug, e.g. `backend-dev` -> `/backend-dev`. */
export function bundleSlashCommand(slug: string): string {
  return `/${slug}`;
}

/** A bundle's display name: the stored name when present, else the slug. */
export function bundleDisplayName(bundle: SkillBundle): string {
  const name = bundle.name?.trim();
  return name && name.length > 0 ? name : bundle.slug;
}

/** Lowercased identity for comparing skill identifiers/slugs, tolerating the
 * `namespace/skill` and `tap:skill` forms Hermes uses by matching on the last
 * path segment too. */
function skillIdentity(value: string): string {
  return value.trim().toLowerCase();
}

/** The last path segment of a skill identifier (`team/backend` -> `backend`),
 * used so a bundle member written as a bare name still matches a namespaced
 * installed skill. */
function skillLeaf(value: string): string {
  const parts = skillIdentity(value)
    .split(/[/:]/)
    .filter((part) => part.length > 0);
  return parts.at(-1) ?? skillIdentity(value);
}

/** Finds the installed skill that satisfies a bundle member identifier, matching
 * on the full identity first, then the trailing leaf segment. */
function matchInstalledSkill(
  identifier: string,
  skills: readonly HermesSkillInfo[],
): HermesSkillInfo | undefined {
  const wanted = skillIdentity(identifier);
  const exact = skills.find((skill) => skillIdentity(skill.name) === wanted);
  if (exact) return exact;
  const leaf = skillLeaf(identifier);
  return skills.find((skill) => skillLeaf(skill.name) === leaf);
}

/**
 * Resolves a stored bundle against the installed-skill list: derives the
 * slash command, marks each member resolved/missing, and flags whether the
 * slug shadows an installed skill (bundle wins at dispatch). Pure projection;
 * the manager renders directly off this.
 */
export function resolveBundle(
  bundle: SkillBundle,
  skills: readonly HermesSkillInfo[],
): ResolvedSkillBundle {
  const members: ResolvedBundleMember[] = bundle.skills.map((identifier) => {
    const skill = matchInstalledSkill(identifier, skills);
    return { identifier, skill, missing: !skill };
  });
  const hasMissing = members.some((member) => member.missing);
  const collidesWithSkill = skills.some(
    (skill) => skillIdentity(skill.name) === skillIdentity(bundle.slug),
  );
  return {
    bundle,
    slashCommand: bundleSlashCommand(bundle.slug),
    members,
    hasMissing,
    collidesWithSkill,
  };
}

/** Splits a free-text skills field (newline or comma separated) into a clean,
 * de-duplicated, order-preserving list of identifiers. */
export function parseBundleSkillsInput(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of input.split(/[\n,]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = skillIdentity(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Validates a draft bundle for the create/edit form. Errors block saving; the
 * caller can save past warnings.
 *
 * - slug: must normalize to a safe slash-command slug (error if empty/invalid);
 *   colliding with an existing bundle slug is an error; colliding with an
 *   installed skill is a WARNING (the bundle wins at dispatch);
 * - skills: must be non-empty (error); members that are not installed are
 *   WARNINGS because Hermes skips missing skills at invocation.
 *
 * `existingSlugs` is the set of OTHER bundle slugs (excluding the one being
 * edited) so renaming onto a taken slug is caught.
 */
export function validateBundleDraft(
  draft: SkillBundle,
  options: {
    skills: readonly HermesSkillInfo[];
    existingSlugs: readonly string[];
  },
): BundleValidation {
  const issues: BundleValidationIssue[] = [];
  const slug = draft.slug.trim();

  if (!slug) {
    issues.push({
      severity: "error",
      field: "slug",
      message: "Enter a name. It becomes the slash command for this bundle.",
    });
  } else if (!isSafeBundleSlug(slug)) {
    issues.push({
      severity: "error",
      field: "slug",
      message:
        "The slash command can use lowercase letters, numbers, dots, hyphens, and underscores only.",
    });
  } else if (
    options.existingSlugs.some(
      (existing) => skillIdentity(existing) === skillIdentity(slug),
    )
  ) {
    issues.push({
      severity: "error",
      field: "slug",
      message: `A bundle named /${slug} already exists. Choose a different name.`,
    });
  } else if (
    options.skills.some(
      (skill) => skillIdentity(skill.name) === skillIdentity(slug),
    )
  ) {
    issues.push({
      severity: "warning",
      field: "slug",
      message: `A skill named /${slug} is installed. The bundle takes precedence and will run instead.`,
    });
  }

  if (draft.skills.length === 0) {
    issues.push({
      severity: "error",
      field: "skills",
      message: "Add at least one skill to the bundle.",
    });
  } else {
    const missing = draft.skills.filter(
      (identifier) => !matchInstalledSkill(identifier, options.skills),
    );
    if (missing.length > 0) {
      issues.push({
        severity: "warning",
        field: "skills",
        message:
          missing.length === 1
            ? `${missing[0]} is not installed. Hermes will skip it when the bundle runs.`
            : `${missing.length} skills are not installed. Hermes will skip them when the bundle runs.`,
      });
    }
  }

  return {
    canSave: !issues.some((issue) => issue.severity === "error"),
    issues,
  };
}

/** Builds the prompt that "start chat with this bundle" submits: the bundle's
 * slash command, so the chat dispatches the bundle exactly as typing it would.
 * Hermes resolves the bundle, loads its (installed) members, and applies the
 * instruction text. */
export function bundleChatPrompt(bundle: SkillBundle): string {
  return bundleSlashCommand(bundle.slug);
}

/** A duplicate of a bundle with a fresh, non-colliding slug (`<slug>-copy`,
 * then `-copy-2`, ...), used by the "Duplicate" action. The name gets a
 * " (copy)" suffix so the two are distinguishable in the list. */
export function duplicateBundle(
  bundle: SkillBundle,
  existingSlugs: readonly string[],
): SkillBundle {
  const taken = new Set(existingSlugs.map((slug) => skillIdentity(slug)));
  const base = normalizeBundleSlug(`${bundle.slug}-copy`) || "bundle-copy";
  let candidate = base;
  let counter = 2;
  while (taken.has(skillIdentity(candidate))) {
    const suffix = `-${counter}`;
    candidate = `${base.slice(0, BUNDLE_SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
    counter += 1;
  }
  return {
    ...bundle,
    slug: candidate,
    name: `${bundleDisplayName(bundle)} (copy)`,
  };
}
