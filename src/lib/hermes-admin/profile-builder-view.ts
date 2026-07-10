/**
 * The pure, framework-free core of June's guided Profile Builder (spec 20). It
 * owns the wizard's data model, per-step validation, back/next gating, the
 * model tool-calling gate, the "what will change" plan with risk labels, and the
 * `ProfileCreate` payload it builds for the admin client. None of this touches
 * React or Tauri, so the whole flow is unit-testable without a DOM.
 *
 * The builder talks to Hermes through the existing admin REST surface only:
 * `POST /api/profiles` (create) and `POST /api/profiles/active` when the new
 * profile should become active. It reuses the already-landed data sources for
 * its step inputs (the model catalog, installed skills, the Skills Hub, and
 * configured MCP servers) rather than inventing its own. Profile creation is a
 * documented endpoint, so June never copies directories by hand.
 *
 * June presentation rule: every profile presents as June. A profile can choose
 * its own models, skills, and MCP servers, but it never changes what the agent
 * says it is.
 */

import type { HermesCreateProfilePayload } from "./client";
import { isInternalMcpServerName, userManagedMcpServers } from "./mcp-servers-view";
import type { HermesMcpServerInfo, HermesProfileSummary, HermesSkillInfo } from "./schemas";

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

export type ProfileModelSlot = "voice" | "image" | "video";

export type ProfileBuilderModelCatalog = {
  generation: readonly ProfileBuilderModel[];
  transcription: readonly ProfileBuilderModel[];
  image: readonly ProfileBuilderModel[];
  video: readonly ProfileBuilderModel[];
};

/** The ordered wizard steps. */
export const PROFILE_BUILDER_STEPS = ["identity", "model", "skills", "mcps", "review"] as const;

export type ProfileBuilderStep = (typeof PROFILE_BUILDER_STEPS)[number];

/** Per-step title + one-line helper, sentence case, no dashes. */
export const STEP_META: Readonly<Record<ProfileBuilderStep, { title: string; hint: string }>> =
  Object.freeze({
    identity: {
      title: "Basics",
      hint: "Name the profile and describe what it is for.",
    },
    model: {
      title: "Model",
      hint: "Pick the generation model. It must support tool calling.",
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

/** The mutable wizard state. */
export type ProfileBuilderForm = {
  /** Profile name/slug. The slug is derived from this. */
  name: string;
  description: string;
  /** Provider id of the chosen model, empty until picked. */
  provider: string;
  /** Model id of the chosen model, empty until picked. */
  model: string;
  /** Explicit per-profile transcription model override. Empty keeps June's default. */
  voiceModel: string;
  /** Provider for the explicit transcription override. Empty keeps June's default. */
  voiceProvider: string;
  /** Explicit per-profile image model override. Empty keeps June's default. */
  imageModel: string;
  /** Explicit per-profile video model override. Empty keeps June's default. */
  videoModel: string;
  /** Bundled skill names to keep from June's default. Empty means "keep all";
   * a non-empty subset narrows which bundled skills the profile keeps. */
  keepSkills: string[];
  /** Optional hub skill identifiers to install at create time. */
  hubSkills: string[];
  /** Existing MCP server names to attach. */
  mcpServers: string[];
};

/** The fresh form a new wizard starts from. June's default profile and bundled
 * skills are kept as the safe starting point. */
export function emptyProfileForm(): ProfileBuilderForm {
  return {
    name: "",
    description: "",
    provider: "",
    model: "",
    voiceModel: "",
    voiceProvider: "",
    imageModel: "",
    videoModel: "",
    keepSkills: [],
    hubSkills: [],
    mcpServers: [],
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
const RESERVED_PROFILE_SLUGS: ReadonlySet<string> = new Set(["default", "active", "sessions"]);

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
  const clash = existing.some((profile) => slugifyProfileName(profile.name) === slug);
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
    return normalized.includes("functioncalling") || normalized.includes("toolcalling");
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
    (candidate) => candidate.id === form.model && candidate.provider === form.provider,
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

/** Validates a single step. Only the first and model steps can block: a name
 * must be valid and a tool-calling model must be chosen before an agent profile
 * is created. The remaining steps always permit advancing because their choices
 * are optional. */
export function validateStep(
  step: ProfileBuilderStep,
  form: ProfileBuilderForm,
  context: ProfileBuilderContext,
): StepValidation {
  const warnings: string[] = [];
  switch (step) {
    case "identity": {
      const error = validateProfileName(form.name, context.existingProfiles);
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
    case "skills":
      return { error: undefined, warnings };
    case "mcps":
      return { error: undefined, warnings };
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
  return canAdvance("identity", form, context) && canAdvance("model", form, context);
}

// ---------------------------------------------------------------------------
// Step navigation
// ---------------------------------------------------------------------------

export function stepIndex(
  step: ProfileBuilderStep,
  steps: readonly ProfileBuilderStep[] = PROFILE_BUILDER_STEPS,
): number {
  return steps.indexOf(step);
}

export function nextStep(
  step: ProfileBuilderStep,
  steps: readonly ProfileBuilderStep[] = PROFILE_BUILDER_STEPS,
): ProfileBuilderStep {
  const index = stepIndex(step, steps);
  return steps[Math.min(index + 1, steps.length - 1)];
}

export function previousStep(
  step: ProfileBuilderStep,
  steps: readonly ProfileBuilderStep[] = PROFILE_BUILDER_STEPS,
): ProfileBuilderStep {
  const index = stepIndex(step, steps);
  return steps[Math.max(index - 1, 0)];
}

/** The steps to show. The MCP step is skipped when there are no attachable
 * (user-managed) MCP servers to pick from, since an empty step adds nothing. */
export function visibleSteps(hasAttachableMcpServers: boolean): readonly ProfileBuilderStep[] {
  return hasAttachableMcpServers
    ? PROFILE_BUILDER_STEPS
    : PROFILE_BUILDER_STEPS.filter((step) => step !== "mcps");
}

// ---------------------------------------------------------------------------
// Create plan (the review step's "what will change" with risk labels)
// ---------------------------------------------------------------------------

/** How risky a planned change is. `info` is benign, `caution` writes config,
 * secrets, or installs external code. */
export type ChangeRisk = "info" | "caution";

/** One planned file/config change, shown on the review step. */
export type PlannedChange = {
  /** The on-disk file or config surface that changes, e.g.
   * `~/.hermes/profiles/<slug>/config.yaml`. Slug-substituted, no secrets. */
  target: string;
  /** What changes there, in plain language. */
  detail: string;
  risk: ChangeRisk;
};

export type ProfileModelOverrides = {
  transcriptionProvider?: string;
  transcriptionModel?: string;
  imageModel?: string;
  videoModel?: string;
};

export function buildProfileModelOverrides(form: ProfileBuilderForm): ProfileModelOverrides | null {
  const overrides: ProfileModelOverrides = {};
  if (form.voiceModel) {
    overrides.transcriptionProvider = form.voiceProvider || "venice";
    overrides.transcriptionModel = form.voiceModel;
  }
  if (form.imageModel) {
    overrides.imageModel = form.imageModel;
  }
  if (form.videoModel) {
    overrides.videoModel = form.videoModel;
  }
  return Object.keys(overrides).length > 0 ? overrides : null;
}

export function resetProfileModelSlot(
  form: ProfileBuilderForm,
  slot: ProfileModelSlot,
): ProfileBuilderForm {
  if (slot === "voice") return { ...form, voiceProvider: "", voiceModel: "" };
  if (slot === "image") return { ...form, imageModel: "" };
  return { ...form, videoModel: "" };
}

export function selectedProfileModelOverride(
  form: ProfileBuilderForm,
  slot: ProfileModelSlot,
  catalog: readonly ProfileBuilderModel[],
): ProfileBuilderModel | undefined {
  const id =
    slot === "voice" ? form.voiceModel : slot === "image" ? form.imageModel : form.videoModel;
  const provider = slot === "voice" ? form.voiceProvider : undefined;
  if (!id) return undefined;
  return catalog.find(
    (model) => model.id === id && (slot !== "voice" || !provider || model.provider === provider),
  );
}

/** Builds the review step's plan: exactly what files/config June will create or
 * change, each with a risk label. The targets are descriptive (June does not
 * literally write these files itself — Hermes does via the create endpoint), but
 * they make the blast radius explicit, satisfying the spec's "show exactly what
 * will be created or changed". */
export function buildCreatePlan(
  form: ProfileBuilderForm,
  catalogs?: Partial<ProfileBuilderModelCatalog>,
): PlannedChange[] {
  const slug = slugifyProfileName(form.name) || "<profile>";
  const root = `~/.hermes/profiles/${slug}`;
  const changes: PlannedChange[] = [];

  changes.push({
    target: `${root}/`,
    detail: "New isolated profile directory (its own config, env, memory, sessions, and state).",
    risk: "info",
  });

  changes.push({
    target: `${root}/config.yaml`,
    detail: `June profile "${slug}" with model ${form.model || "(unset)"}.`,
    risk: "info",
  });

  const voiceOverride = selectedProfileModelOverride(form, "voice", catalogs?.transcription ?? []);
  if (form.voiceModel) {
    changes.push({
      target: "June profile model overrides",
      detail: `Voice model: ${voiceOverride?.name ?? form.voiceModel}.`,
      risk: "caution",
    });
  }

  const imageOverride = selectedProfileModelOverride(form, "image", catalogs?.image ?? []);
  if (form.imageModel) {
    changes.push({
      target: "June profile model overrides",
      detail: `Image model: ${imageOverride?.name ?? form.imageModel}.`,
      risk: "caution",
    });
  }

  const videoOverride = selectedProfileModelOverride(form, "video", catalogs?.video ?? []);
  if (form.videoModel) {
    changes.push({
      target: "June profile model overrides",
      detail: `Video model: ${videoOverride?.name ?? form.videoModel}.`,
      risk: "caution",
    });
  }

  changes.push({
    target: `${root}/skills/`,
    detail:
      form.keepSkills.length > 0
        ? `Copies ${form.keepSkills.length} bundled skill(s) from the default profile.`
        : "Copies June's bundled skills from the default profile.",
    risk: "info",
  });

  if (form.hubSkills.length > 0) {
    changes.push({
      target: `${root}/skills/`,
      detail: `Installs ${form.hubSkills.length} optional hub skill(s). Hub skills run their own scripts.`,
      risk: "caution",
    });
  }

  if (form.mcpServers.length > 0) {
    const total = form.mcpServers.filter((name) => !isInternalMcpServerName(name)).length;
    if (total > 0) {
      changes.push({
        target: `${root}/config.yaml (mcp)`,
        detail: `Attaches ${total} MCP server(s). MCP servers may run local subprocesses and need a gateway restart to expose their tools.`,
        risk: "caution",
      });
    }
  }

  changes.push({
    target: `${root}/config.yaml (mcp)`,
    detail: "June's built-in tools are always included.",
    risk: "info",
  });

  return changes;
}

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

/** Maps the wizard form to the `ProfileCreate` body. The slug is used as the
 * profile name because the create endpoint scopes everything by this id. */
export function buildCreatePayload(form: ProfileBuilderForm): HermesCreateProfilePayload {
  const slug = slugifyProfileName(form.name);
  const payload: HermesCreateProfilePayload = {
    name: slug,
    // Every profile clones June's default so it inherits June's SOUL and bundled
    // skills. Hermes rejects no_skills alongside a clone, so skills are only ever
    // narrowed via keep_skills, never dropped wholesale.
    clone_from_default: true,
  };
  if (form.description.trim()) payload.description = form.description.trim();
  if (form.provider) payload.provider = form.provider;
  if (form.model) payload.model = form.model;
  if (form.keepSkills.length > 0) {
    payload.keep_skills = [...form.keepSkills];
  }
  if (form.hubSkills.length > 0) payload.hub_skills = [...form.hubSkills];
  const mcpServers = form.mcpServers
    .filter((name) => !isInternalMcpServerName(name))
    .map((name) => ({ name }));
  if (mcpServers.length > 0) payload.mcp_servers = mcpServers;
  return payload;
}

// ---------------------------------------------------------------------------
// Selectable inputs (thin projections of the reused data sources)
// ---------------------------------------------------------------------------

/** The bundled skills a profile can keep — only `bundled` source skills are
 * offered, since hub/external skills are handled separately. */
export function bundledSkillOptions(skills: readonly HermesSkillInfo[]): HermesSkillInfo[] {
  return skills.filter((skill) => skill.source === "bundled");
}

/** The MCP servers that can be attached, excluding June-owned internal tools. */
export function attachableMcpServers(
  servers: readonly HermesMcpServerInfo[],
): HermesMcpServerInfo[] {
  return userManagedMcpServers(servers);
}
