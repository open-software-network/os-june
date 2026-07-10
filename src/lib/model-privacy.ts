import type { ProviderModelMode, VeniceModelDto } from "./tauri";

export type ModelPrivacyMode = "e2ee" | "private" | "anonymous";

export type ModelPrivacyBadge = {
  mode: ModelPrivacyMode;
  label: string;
  description: string;
};

export type ModelPrivacyFlags = {
  e2ee: boolean;
  private: boolean;
  anonymous: boolean;
  uncensored: boolean;
};

export const PROVIDER_MODEL_SETTINGS_CHANGED_EVENT = "june:provider-model-settings-changed";

export type ProviderModelSettingsChangedDetail = {
  mode: ProviderModelMode;
  modelId: string;
};

export function dispatchProviderModelSettingsChanged(detail: ProviderModelSettingsChangedDetail) {
  window.dispatchEvent(
    new CustomEvent<ProviderModelSettingsChangedDetail>(PROVIDER_MODEL_SETTINGS_CHANGED_EVENT, {
      detail,
    }),
  );
}

export const E2EE_MODEL_DESCRIPTION =
  "Private model with end-to-end encryption. Your prompt is encrypted on your device and only decrypted inside a hardware-secured enclave (TEE); the response is encrypted before it leaves the enclave. No prompt data is ever readable by the model provider or its infrastructure.";
export const PRIVATE_MODEL_DESCRIPTION =
  "Private model with zero data retention. No prompt data is stored, shared with a third party, or trained on.";
export const ANONYMOUS_MODEL_DESCRIPTION =
  "The model provider may retain prompts, though they're anonymized. Your identity is stripped before anything leaves June. For sensitive content, pick a Private or E2EE model.";

type ModelPrivacySignals = Pick<VeniceModelDto, "privacy" | "traits"> &
  Partial<Pick<VeniceModelDto, "capabilities">>;

/** The agent drives everything through tool calls, so a text model without
 * function calling bricks June — prompts run but no file, shell, or memory
 * tool ever executes. Venice's E2EE models are the common case: encrypted
 * inference can't expose tools. The capability name comes from Venice's
 * catalog (`supportsFunctionCalling`); match defensively on the normalized
 * name so a rename to snake_case or "tool calling" keeps working. */
export function modelSupportsTools(
  model: Partial<Pick<VeniceModelDto, "capabilities" | "provider">>,
) {
  // A bring-your-own local endpoint can't be probed for function-calling
  // support from the catalog, and hard-blocking it would make the feature
  // unusable. Tool support is unverifiable and depends on the user's own
  // model, so we treat local as capable and surface a non-blocking caveat in
  // the picker instead of disabling selection.
  if (model.provider === "local") return true;
  return (model.capabilities ?? []).some((capability) => {
    const normalized = capability.toLowerCase().replace(/[^a-z]/g, "");
    return normalized.includes("functioncalling") || normalized.includes("toolcalling");
  });
}

export function modelAvailableForMode(
  mode: ProviderModelMode,
  model: Partial<Pick<VeniceModelDto, "capabilities" | "provider">>,
) {
  if (mode === "generation" && model.provider && !modelSupportsTools(model)) {
    return false;
  }
  return true;
}

/** Whether the model can read image input (vision). Mirrors
 * `modelSupportsTools`: key off the authoritative capability flag on
 * `capabilities` only, never `traits`. Venice's backend emits a capability
 * string only when its boolean is true (`collect_capability_names` in
 * june-api), so `capabilities` reliably lists genuine vision support. `traits`
 * is descriptive/marketing text (e.g. "multimodal") that conflates image
 * OUTPUT with image INPUT — matching it would let the image-attach fallback
 * switch to a model that can't actually read the image. The capability name
 * comes from Venice's catalog (`supportsVision`); match defensively on the
 * normalized name so a rename to snake_case keeps working. */
export function modelSupportsImageInput(model: Partial<Pick<VeniceModelDto, "capabilities">>) {
  return (model.capabilities ?? []).some((capability) => {
    const normalized = capability.toLowerCase().replace(/[^a-z]/g, "");
    return normalized.includes("supportsvision");
  });
}

// Strongest claim wins: E2EE models are also private, but "encrypted into the
// enclave" is the property worth surfacing.
export function modelPrivacyBadge(
  model: ModelPrivacySignals,
  flags = modelPrivacyFlags(model),
): ModelPrivacyBadge | undefined {
  if (flags.e2ee) {
    return {
      mode: "e2ee",
      label: "E2EE",
      description: E2EE_MODEL_DESCRIPTION,
    };
  }
  if (flags.private) {
    return {
      mode: "private",
      label: "Private mode",
      description: PRIVATE_MODEL_DESCRIPTION,
    };
  }
  if (flags.anonymous) {
    return {
      mode: "anonymous",
      label: "Anonymous mode",
      description: ANONYMOUS_MODEL_DESCRIPTION,
    };
  }
  return undefined;
}

/** What the catalog's "Private" filter keeps: zero-retention or stronger.
 * E2EE models are also private, so they pass; anonymized models (prompts may
 * be retained) do not. A loopback local model never leaves the machine —
 * stronger than any zero-retention claim — so it passes too (a non-loopback
 * custom endpoint reports "external" and makes no claim). */
export function modelIsPrivate(model: ModelPrivacySignals) {
  if ((model.privacy ?? "").toLowerCase() === "local") return true;
  const flags = modelPrivacyFlags(model);
  return flags.e2ee || flags.private;
}

export function modelPrivacyFlags(model: ModelPrivacySignals): ModelPrivacyFlags {
  const privacy = (model.privacy ?? "").toLowerCase();
  const traits = model.traits.map((trait) => trait.toLowerCase());
  const capabilities = (model.capabilities ?? []).map((capability) => capability.toLowerCase());
  return {
    e2ee:
      privacy === "e2ee" ||
      traits.some((trait) => trait === "e2ee") ||
      capabilities.some((capability) => capability === "e2ee"),
    private: privacy === "private" || traits.some((trait) => trait === "private"),
    anonymous:
      privacy.includes("anonymous") ||
      privacy.includes("anonymized") ||
      traits.some((trait) => trait.includes("anonymous") || trait.includes("anonymized")),
    uncensored: traits.some((trait) => trait.includes("uncensored")),
  };
}
