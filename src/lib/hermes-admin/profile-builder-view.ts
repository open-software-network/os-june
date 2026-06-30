/**
 * The pure, framework-free core of June's guided Profile Builder (spec 20). It
 * owns the wizard's data model, per-step validation, back/next gating, the
 * model tool-calling gate, the "what will change" plan with risk labels, and the
 * `ProfileCreate` payload it builds for the admin client. None of this touches
 * React or Tauri, so the whole flow is unit-testable without a DOM.
 *
 * The builder talks to Hermes through the existing admin REST surface only:
 * `POST /api/profiles` (create), `PUT /api/profiles/{name}/soul` (custom SOUL),
 * `POST /api/profiles/active` + `/open-terminal` (test session). It reuses the
 * already-landed data sources for its step inputs (the model catalog, installed
 * skills, the Skills Hub, MCP servers and the MCP catalog) rather than inventing
 * its own. Profile creation is a documented endpoint, so June never copies
 * directories by hand — no Tauri bridge command is added.
 *
 * June identity rule: a profile may SPECIALIZE June, but the agent still
 * identifies as June. The builder only treats a profile as a distinct named
 * agent when the user explicitly opts into the "specialized role" identity AND
 * provides their own SOUL — otherwise the default June identity is preserved.
 */

import type { HermesCreateProfilePayload } from "./client";
import type {
  HermesMcpCatalogEntry,
  HermesMcpServerInfo,
  HermesProfileSummary,
  HermesSkillInfo,
} from "./schemas";

/** The model shape the builder needs from the catalog. A subset of
 * `VeniceModelDto` so this module stays decoupled from the Tauri DTO; the
 * component maps the DTO down to this. */
export type ProfileBuilderModel = {
  provider: string;
  id: string;
  name: string;
  /** Capability strings from the catalog, used to gate tool-calling. */
  capabilities: string[];
};

/** The ordered wizard steps. */
export const PROFILE_BUILDER_STEPS = [
  "identity",
  "model",
  "toolsets",
  "skills",
  "mcps",
  "review",
] as const;

export type ProfileBuilderStep = (typeof PROFILE_BUILDER_STEPS)[number];

/** Per-step title + one-line helper, sentence case, no dashes. */
export const STEP_META: Readonly<
  Record<ProfileBuilderStep, { title: string; hint: string }>
> = Object.freeze({
  identity: {
    title: "Identity",
    hint: "Name the profile and decide if it specializes June or is a new agent.",
  },
  model: {
    title: "Model",
    hint: "Pick the generation model. It must support tool calling.",
  },
  toolsets: {
    title: "Toolsets",
    hint: "Choose the sandbox policy for this profile.",
  },
  skills: {
    title: "Skills",
    hint: "Keep bundled skills and add optional skills from the hub.",
  },
  mcps: {
    title: "MCP servers",
    hint: "Attach MCP servers this profile can use.",
  },
  review: {
    title: "Review",
    hint: "Confirm what will be created, then create the profile.",
  },
});

/** Whether the profile keeps June's default identity or becomes a distinct
 * specialized role. The default preserves June's identity even when skills/MCPs
 * are added. */
export type ProfileIdentityKind = "june-default" | "specialized";

/** How the profile treats local subprocesses, stdio MCP servers, scripts, and
 * external directories. June's safe default is sandboxed. */
export type ProfileSandboxPolicy = "sandboxed" | "unrestricted";

/** The mutable wizard state. */
export type ProfileBuilderForm = {
  /** Profile name/slug. The slug is derived from this. */
  name: string;
  description: string;
  /** Optional custom SOUL/instructions. Empty keeps the inherited identity. */
  soul: string;
  identity: ProfileIdentityKind;
  /** Provider id of the chosen model, empty until picked. */
  provider: string;
  /** Model id of the chosen model, empty until picked. */
  model: string;
  sandbox: ProfileSandboxPolicy;
  /** Keep June's bundled skills (clones them from default). */
  keepBundledSkills: boolean;
  /** Bundled skill names to keep when `keepBundledSkills` is true and the user
   * narrowed the set. Empty means "keep all". */
  keepSkills: string[];
  /** Optional hub skill identifiers to install at create time. */
  hubSkills: string[];
  /** Existing MCP server names to attach. */
  mcpServers: string[];
  /** MCP catalog install names to install at create time. */
  mcpCatalogInstalls: string[];
};

/** The fresh form a new wizard starts from. June default identity, sandboxed,
 * bundled skills kept — the safe, June-correct starting point. */
export function emptyProfileForm(): ProfileBuilderForm {
  return {
    name: "",
    description: "",
    soul: "",
    identity: "june-default",
    provider: "",
    model: "",
    sandbox: "sandboxed",
    keepBundledSkills: true,
    keepSkills: [],
    hubSkills: [],
    mcpServers: [],
    mcpCatalogInstalls: [],
  };
}

// ---------------------------------------------------------------------------
// Slug + name validation
// ---------------------------------------------------------------------------

/** Derives a safe profile slug from a free-text name: lowercased, non
 * `[a-z0-9_-]` collapsed to single hyphens, trimmed of leading/trailing
 * hyphens. Returns "" for input that has no usable characters. The slug is what
 * a Tauri/CLI path would use, so it is deliberately conservative — no spaces, no
 * shell metacharacters, no path separators. */
export function slugifyProfileName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Reserved profile names June must never let a user create or collide with. */
const RESERVED_PROFILE_SLUGS: ReadonlySet<string> = new Set([
  "default",
  "active",
  "sessions",
]);

/** Validates the profile name/slug against emptiness, the slug charset,
 * reserved names, and collision with an existing profile. Returns an error
 * string or undefined when valid. */
export function validateProfileName(
  name: string,
  existing: readonly HermesProfileSummary[],
): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Enter a profile name.";
  const slug = slugifyProfileName(trimmed);
  if (slug.length === 0) {
    return "Use letters or numbers in the profile name.";
  }
  if (slug.length > 64) return "Keep the profile name under 64 characters.";
  if (RESERVED_PROFILE_SLUGS.has(slug)) {
    return `"${slug}" is reserved. Choose another name.`;
  }
  const clash = existing.some(
    (profile) => slugifyProfileName(profile.name) === slug,
  );
  if (clash) return `A profile named "${slug}" already exists.`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Model tool-calling gate
// ---------------------------------------------------------------------------

/** True when the model exposes function/tool calling. June drives everything
 * through tool calls, so a model without it bricks an agent profile. Matches the
 * normalized capability name defensively (snake_case, "tool calling", etc.),
 * mirroring `modelSupportsTools` in `model-privacy`. */
export function modelSupportsToolCalling(model: ProfileBuilderModel): boolean {
  return model.capabilities.some((capability) => {
    const normalized = capability.toLowerCase().replace(/[^a-z]/g, "");
    return (
      normalized.includes("functioncalling") ||
      normalized.includes("toolcalling")
    );
  });
}

/** The selected model's tool-calling verdict, or undefined when nothing is
 * selected yet. */
export function selectedModelToolSupport(
  form: ProfileBuilderForm,
  models: readonly ProfileBuilderModel[],
): { model: ProfileBuilderModel; supportsTools: boolean } | undefined {
  if (!form.model) return undefined;
  const model = models.find(
    (candidate) =>
      candidate.id === form.model && candidate.provider === form.provider,
  );
  if (!model) return undefined;
  return { model, supportsTools: modelSupportsToolCalling(model) };
}

// ---------------------------------------------------------------------------
// Per-step validation
// ---------------------------------------------------------------------------

/** Inputs validation needs from the rest of the app (the existing profiles to
 * dedupe against, the model catalog to gate tool calling). */
export type ProfileBuilderContext = {
  existingProfiles: readonly HermesProfileSummary[];
  models: readonly ProfileBuilderModel[];
};

/** The validation result for one step: an optional blocking error (prevents
 * advancing) and optional non-blocking warnings (shown but do not gate). */
export type StepValidation = {
  /** Set when the step cannot be left for the next step. */
  error?: string;
  /** Advisory messages that do not block advancing. */
  warnings: string[];
};

/** Validates a single step. Only the identity and model steps can block: a name
 * must be valid and a tool-calling model must be chosen before an agent profile
 * is created. The remaining steps always permit advancing (their choices are
 * optional), surfacing advisories instead. */
export function validateStep(
  step: ProfileBuilderStep,
  form: ProfileBuilderForm,
  context: ProfileBuilderContext,
): StepValidation {
  const warnings: string[] = [];
  switch (step) {
    case "identity": {
      const error = validateProfileName(form.name, context.existingProfiles);
      if (!error && form.identity === "specialized" && !form.soul.trim()) {
        warnings.push(
          "A specialized role with no instructions still behaves like June. Add a SOUL to change its behavior.",
        );
      }
      return { error, warnings };
    }
    case "model": {
      if (!form.model) {
        return { error: "Choose a generation model.", warnings };
      }
      const support = selectedModelToolSupport(form, context.models);
      if (support && !support.supportsTools) {
        // The hard gate: an agent profile cannot be created on a model that
        // cannot call tools.
        return {
          error:
            "This model does not support tool calling, so the agent could not run any tools. Choose a model that supports tool calling.",
          warnings,
        };
      }
      if (!support) {
        warnings.push(
          "Tool-calling support for this model could not be confirmed. Verify it before relying on tools.",
        );
      }
      return { error: undefined, warnings };
    }
    case "toolsets": {
      if (form.sandbox === "unrestricted") {
        warnings.push(
          "Full mode lets this profile run local subprocesses and scripts without the sandbox. Use it only for trusted work.",
        );
      }
      return { error: undefined, warnings };
    }
    case "skills":
      return { error: undefined, warnings };
    case "mcps": {
      if (form.sandbox === "sandboxed" && form.mcpCatalogInstalls.length > 0) {
        warnings.push(
          "Some MCP servers run local subprocesses. In sandboxed mode they stay jailed. Switch to Full mode only if a server needs broader access.",
        );
      }
      return { error: undefined, warnings };
    }
    case "review":
      // Review re-runs the gating steps so a late edit cannot slip a bad model
      // or name through.
      return {
        error:
          validateStep("identity", form, context).error ??
          validateStep("model", form, context).error,
        warnings,
      };
  }
}

/** True when the wizard may advance from `step`. */
export function canAdvance(
  step: ProfileBuilderStep,
  form: ProfileBuilderForm,
  context: ProfileBuilderContext,
): boolean {
  return validateStep(step, form, context).error === undefined;
}

/** True when the whole form is valid enough to create (the two gating steps
 * pass). Drives the Create button on the review step. */
export function canCreateProfile(
  form: ProfileBuilderForm,
  context: ProfileBuilderContext,
): boolean {
  return (
    canAdvance("identity", form, context) && canAdvance("model", form, context)
  );
}

// ---------------------------------------------------------------------------
// Step navigation
// ---------------------------------------------------------------------------

export function stepIndex(step: ProfileBuilderStep): number {
  return PROFILE_BUILDER_STEPS.indexOf(step);
}

export function nextStep(step: ProfileBuilderStep): ProfileBuilderStep {
  const index = stepIndex(step);
  return PROFILE_BUILDER_STEPS[
    Math.min(index + 1, PROFILE_BUILDER_STEPS.length - 1)
  ];
}

export function previousStep(step: ProfileBuilderStep): ProfileBuilderStep {
  const index = stepIndex(step);
  return PROFILE_BUILDER_STEPS[Math.max(index - 1, 0)];
}

// ---------------------------------------------------------------------------
// Create plan (the review step's "what will change" with risk labels)
// ---------------------------------------------------------------------------

/** How risky a planned change is. `info` is benign, `caution` writes config or
 * secrets, `danger` weakens the sandbox or runs external code. */
export type ChangeRisk = "info" | "caution" | "danger";

/** One planned file/config change, shown on the review step. */
export type PlannedChange = {
  /** The on-disk file or config surface that changes, e.g.
   * `~/.hermes/profiles/<slug>/config.yaml`. Slug-substituted, no secrets. */
  target: string;
  /** What changes there, in plain language. */
  detail: string;
  risk: ChangeRisk;
};

/** Builds the review step's plan: exactly what files/config June will create or
 * change, each with a risk label. The targets are descriptive (June does not
 * literally write these files itself — Hermes does via the create endpoint), but
 * they make the blast radius explicit, satisfying the spec's "show exactly what
 * will be created or changed". */
export function buildCreatePlan(form: ProfileBuilderForm): PlannedChange[] {
  const slug = slugifyProfileName(form.name) || "<profile>";
  const root = `~/.hermes/profiles/${slug}`;
  const changes: PlannedChange[] = [];

  changes.push({
    target: `${root}/`,
    detail:
      "New isolated profile directory (its own config, env, memory, sessions, and state).",
    risk: "info",
  });

  changes.push({
    target: `${root}/config.yaml`,
    detail:
      form.identity === "specialized"
        ? `Specialized June profile "${slug}" with model ${form.model || "(unset)"}.`
        : `June profile "${slug}" (keeps June's identity) with model ${form.model || "(unset)"}.`,
    risk: "info",
  });

  if (form.soul.trim()) {
    changes.push({
      target: `${root}/SOUL.md`,
      detail: "Custom instructions you wrote for this profile.",
      risk: "caution",
    });
  }

  if (form.keepBundledSkills) {
    changes.push({
      target: `${root}/skills/`,
      detail:
        form.keepSkills.length > 0
          ? `Copies ${form.keepSkills.length} bundled skill(s) from the default profile.`
          : "Copies June's bundled skills from the default profile.",
      risk: "info",
    });
  } else {
    changes.push({
      target: `${root}/skills/`,
      detail: "Starts with no skills (bundled skills are not copied).",
      risk: "info",
    });
  }

  if (form.hubSkills.length > 0) {
    changes.push({
      target: `${root}/skills/`,
      detail: `Installs ${form.hubSkills.length} optional hub skill(s). Hub skills run their own scripts.`,
      risk: "caution",
    });
  }

  if (form.mcpServers.length > 0 || form.mcpCatalogInstalls.length > 0) {
    const total = form.mcpServers.length + form.mcpCatalogInstalls.length;
    changes.push({
      target: `${root}/config.yaml (mcp)`,
      detail: `Attaches ${total} MCP server(s). MCP servers may run local subprocesses and need a gateway restart to expose their tools.`,
      risk: "caution",
    });
  }

  if (form.sandbox === "unrestricted") {
    changes.push({
      target: `${root}/config.yaml (sandbox)`,
      detail:
        "Runs this profile in Full mode: local subprocesses, scripts, and external directories are not sandboxed.",
      risk: "danger",
    });
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

/** Maps the wizard form to the `ProfileCreate` body. The slug is used as the
 * profile name (the create endpoint scopes everything by this id). The SOUL is
 * NOT in this body — it is written by a follow-up `setSoul` call so an empty
 * SOUL never overwrites the inherited June identity. */
export function buildCreatePayload(
  form: ProfileBuilderForm,
): HermesCreateProfilePayload {
  const slug = slugifyProfileName(form.name);
  const payload: HermesCreateProfilePayload = {
    name: slug,
    // June identity is preserved by seeding from the default profile unless the
    // user starts from scratch. clone_from_default brings June's SOUL + bundled
    // skills along, which is what keeps a "specialized June" still identifying
    // as June.
    clone_from_default: form.keepBundledSkills,
    no_skills: !form.keepBundledSkills,
  };
  if (form.description.trim()) payload.description = form.description.trim();
  if (form.provider) payload.provider = form.provider;
  if (form.model) payload.model = form.model;
  if (form.keepBundledSkills && form.keepSkills.length > 0) {
    payload.keep_skills = [...form.keepSkills];
  }
  if (form.hubSkills.length > 0) payload.hub_skills = [...form.hubSkills];
  const mcpServers = [
    ...form.mcpServers.map((name) => ({ name })),
    ...form.mcpCatalogInstalls.map((name) => ({ name })),
  ];
  if (mcpServers.length > 0) payload.mcp_servers = mcpServers;
  return payload;
}

// ---------------------------------------------------------------------------
// Selectable inputs (thin projections of the reused data sources)
// ---------------------------------------------------------------------------

/** The bundled skills a profile can keep — only `bundled` source skills are
 * offered, since hub/external skills are handled separately. */
export function bundledSkillOptions(
  skills: readonly HermesSkillInfo[],
): HermesSkillInfo[] {
  return skills.filter((skill) => skill.source === "bundled");
}

/** The MCP servers that can be attached — every server in the inventory by
 * name. */
export function attachableMcpServers(
  servers: readonly HermesMcpServerInfo[],
): HermesMcpServerInfo[] {
  return [...servers];
}

/** The catalog entries that can be installed during create (not already
 * installed). */
export function installableCatalogEntries(
  catalog: readonly HermesMcpCatalogEntry[],
): HermesMcpCatalogEntry[] {
  return catalog.filter((entry) => !entry.installed);
}
