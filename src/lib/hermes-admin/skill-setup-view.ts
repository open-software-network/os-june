/**
 * Pure, render-free view logic for the skill setup panel (spec 09): combine a
 * skill's declared setup requirements (`required_environment_variables` and
 * `metadata.hermes.config`) with the current configured state (which env keys
 * are set, what each config value currently is) into ready-to-render rows and a
 * single setup-status badge.
 *
 * SECRET SAFETY: this module never holds, derives, or returns a secret VALUE.
 * For an env requirement it carries only the name, the prompt/help, and whether
 * a value is CONFIGURED (a boolean) plus an optional masked preview the
 * dashboard already redacted. Non-secret config values are not sensitive and are
 * shown, but a credential-shaped config value is still masked defensively via
 * the shared redactor before display. Nothing here logs.
 *
 * Nothing talks to Hermes; it reshapes already-parsed data. Copy is sentence
 * case, no em/en-dashes, per June conventions.
 */

import type {
  HermesEnvVar,
  HermesSkillConfigRequirement,
  HermesSkillEnvRequirement,
  HermesSkillSetupRequirements,
} from "./schemas";
import { isSensitiveKey, sanitizePayload } from "./redact";

/** The setup status of a skill, mapped to the spec's badge vocabulary. */
export type SkillSetupStatus =
  | "ready" // all required setup is satisfied (or none is declared)
  | "missing-api-key" // a required env var (secret) is not configured
  | "missing-config" // a required non-secret config value is not set
  | "optional-skipped"; // only optional setup remains unconfigured

/** A skill setup status plus its human-facing label and a longer description,
 * so a badge and an empty/help line read from one source. */
export type SkillSetupBadge = {
  status: SkillSetupStatus;
  /** Short pill label, sentence case (matches the spec's badge copy). */
  label: string;
  /** Tone hint for styling: `ready` is positive, `optional-skipped` is neutral,
   * the two `missing-*` are attention-needing. */
  tone: "ready" | "attention" | "neutral";
};

/** One env (secret) setup row: the requirement plus whether a value is
 * currently configured. NEVER carries the secret value. */
export type SkillEnvSetupRow = {
  requirement: HermesSkillEnvRequirement;
  /** True when Hermes reports a value is configured for this key. */
  configured: boolean;
  /** A masked, non-secret preview the dashboard included (e.g. `sk-...abcd`),
   * when present. Never the full value. */
  preview?: string;
};

/** One config (non-secret) setup row: the requirement plus the current value
 * (display-safe; credential-shaped values are masked). */
export type SkillConfigSetupRow = {
  requirement: HermesSkillConfigRequirement;
  /** The current value as stored, or undefined when unset (using the default).
   * Display-safe: a credential-shaped value is masked. */
  current?: string;
  /** True when `current` is a masked placeholder (e.g. `[redacted]`) rather than
   * the real stored value, so the editor must NOT seed its draft from it (saving
   * the placeholder back would overwrite the real Hermes value with `[redacted]`). */
  redacted: boolean;
  /** True when the current value differs from the declared default (so the UI
   * can show "modified" vs "default"). */
  modified: boolean;
};

/** Everything the setup panel renders for one skill: the rows and the badge. */
export type SkillSetupModel = {
  env: SkillEnvSetupRow[];
  config: SkillConfigSetupRow[];
  badge: SkillSetupBadge;
  /** True when the skill declares any setup at all. When false the panel shows a
   * "no setup needed" note rather than empty tables. */
  hasAnySetup: boolean;
};

const BADGE_LABEL: Readonly<Record<SkillSetupStatus, string>> = Object.freeze({
  ready: "Ready",
  "missing-api-key": "Missing API key",
  "missing-config": "Missing config",
  "optional-skipped": "Optional setup skipped",
});

const BADGE_TONE: Readonly<Record<SkillSetupStatus, SkillSetupBadge["tone"]>> =
  Object.freeze({
    ready: "ready",
    "missing-api-key": "attention",
    "missing-config": "attention",
    "optional-skipped": "neutral",
  });

/** The badge metadata for a status. */
export function setupBadge(status: SkillSetupStatus): SkillSetupBadge {
  return { status, label: BADGE_LABEL[status], tone: BADGE_TONE[status] };
}

/** Builds the lookup of which env keys are configured + their masked preview,
 * from a `GET /api/env` listing. Defensive: an absent listing means nothing is
 * configured. Never reads a value. */
export function envConfiguredIndex(
  vars: readonly HermesEnvVar[] | undefined,
): Map<string, { configured: boolean; preview?: string }> {
  const index = new Map<string, { configured: boolean; preview?: string }>();
  for (const entry of vars ?? []) {
    index.set(entry.key, {
      configured: entry.hasValue === true,
      preview: entry.preview,
    });
  }
  return index;
}

/** Masks a non-secret config value for display IF it looks like a credential or
 * sits under a sensitive-looking key, so a user who pasted a secret into a
 * "config" field does not see it echoed back in plaintext. Uses the one shared
 * redactor (`sanitizePayload`), which masks credential-shaped strings. */
function safeConfigDisplay(
  key: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (isSensitiveKey(key)) return "[redacted]";
  const masked = sanitizePayload(value);
  return typeof masked === "string" ? masked : "[redacted]";
}

/**
 * Combines a skill's declared requirements with the live env/config state into a
 * render-ready model and a setup-status badge.
 *
 * Badge precedence (most severe first):
 * 1. a REQUIRED env var is not configured       -> "missing-api-key"
 * 2. a REQUIRED config value is unset            -> "missing-config"
 * 3. only OPTIONAL setup remains unconfigured    -> "optional-skipped"
 * 4. everything required is satisfied            -> "ready"
 *
 * `envConfigured` maps an env key to its configured/preview state; `configValues`
 * maps a config key to its current stored value (display string), undefined when
 * unset.
 */
export function buildSkillSetupModel(
  requirements: HermesSkillSetupRequirements,
  envConfigured: Map<string, { configured: boolean; preview?: string }>,
  configValues: Map<string, string | undefined>,
): SkillSetupModel {
  const env: SkillEnvSetupRow[] = requirements.env.map((requirement) => {
    const state = envConfigured.get(requirement.name);
    return {
      requirement,
      configured: state?.configured ?? false,
      preview: state?.preview,
    };
  });

  const config: SkillConfigSetupRow[] = requirements.config.map(
    (requirement) => {
      const raw = configValues.get(requirement.key);
      const display = safeConfigDisplay(requirement.key, raw);
      return {
        requirement,
        current: display,
        // Masked if the display-safe value differs from the raw stored value.
        redacted: raw !== undefined && display !== raw,
        modified:
          raw !== undefined && raw.length > 0 && raw !== requirement.default,
      };
    },
  );

  const hasAnySetup = env.length > 0 || config.length > 0;

  const missingRequiredEnv = env.some(
    (row) => row.requirement.required && !row.configured,
  );
  const missingRequiredConfig = config.some(
    (row) =>
      row.requirement.required &&
      (row.current === undefined || row.current.length === 0),
  );
  const missingOptional =
    env.some((row) => !row.requirement.required && !row.configured) ||
    config.some(
      (row) =>
        !row.requirement.required &&
        (row.current === undefined || row.current.length === 0),
    );

  const status: SkillSetupStatus = missingRequiredEnv
    ? "missing-api-key"
    : missingRequiredConfig
      ? "missing-config"
      : missingOptional
        ? "optional-skipped"
        : "ready";

  return { env, config, badge: setupBadge(status), hasAnySetup };
}

/** The dotted config path for a skill's config key: `skills.config.<skill>.<key>`.
 * The single place this layout is encoded, so a read and a write always agree. */
export function skillConfigPath(skill: string, key: string): string {
  return `skills.config.${skill}.${key}`;
}

/** The dotted path SEGMENTS for reading a skill's config out of the config tree,
 * matching {@link skillConfigPath}. */
export function skillConfigPathSegments(skill: string, key: string): string[] {
  return ["skills", "config", skill, key];
}

/** A basic validation result for a config value the user is about to write. */
export type ConfigValidation = { ok: true } | { ok: false; message: string };

/** Validates a config value before a write. Required fields may not be blank;
 * a value that names a path (the key hints at a path/dir/file) must look like a
 * path, not empty. Kept deliberately light: Hermes is the source of truth, June
 * only catches the obvious mistakes early. */
export function validateConfigValue(
  requirement: HermesSkillConfigRequirement,
  value: string,
): ConfigValidation {
  const trimmed = value.trim();
  if (requirement.required && trimmed.length === 0) {
    return { ok: false, message: "This setting is required." };
  }
  if (looksLikePathKey(requirement.key) && trimmed.length > 0) {
    // A path setting should not contain a newline or a null byte; otherwise we
    // accept it (Hermes validates existence on its side).
    if (/[\n\r ]/.test(trimmed)) {
      return { ok: false, message: "A path cannot contain line breaks." };
    }
  }
  return { ok: true };
}

/** Whether a config key names a filesystem path (so the field hints at a path
 * and gets light path validation). */
function looksLikePathKey(key: string): boolean {
  return /(^|_)(path|dir|directory|file|folder|location)s?($|_)/i.test(key);
}
