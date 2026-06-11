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

export const PROVIDER_MODEL_SETTINGS_CHANGED_EVENT =
  "scribe:provider-model-settings-changed";

export type ProviderModelSettingsChangedDetail = {
  mode: ProviderModelMode;
  modelId: string;
};

export function dispatchProviderModelSettingsChanged(
  detail: ProviderModelSettingsChangedDetail,
) {
  window.dispatchEvent(
    new CustomEvent<ProviderModelSettingsChangedDetail>(
      PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
      { detail },
    ),
  );
}

export const E2EE_MODEL_DESCRIPTION =
  "Private model with end-to-end encryption. Your prompt is encrypted on your Mac and only decrypted inside a hardware-secured enclave (TEE); the response is encrypted before it leaves the enclave. No prompt data is ever readable by the model provider or its infrastructure.";
export const PRIVATE_MODEL_DESCRIPTION =
  "Private model with zero data retention. No prompt data is stored, shared with a third party, or trained on.";
export const ANONYMOUS_MODEL_DESCRIPTION =
  "The model provider may retain prompts, though they're anonymized — your identity is stripped before anything leaves June. For sensitive content, pick a Private or E2EE model.";

type ModelPrivacySignals = Pick<VeniceModelDto, "privacy" | "traits"> &
  Partial<Pick<VeniceModelDto, "capabilities">>;

/** The agent drives everything through tool calls, so a text model without
 * function calling bricks June — prompts run but no file, shell, or memory
 * tool ever executes. Venice's E2EE models are the common case: encrypted
 * inference can't expose tools. The capability name comes from Venice's
 * catalog (`supportsFunctionCalling`); match defensively on the normalized
 * name so a rename to snake_case or "tool calling" keeps working. */
export function modelSupportsTools(
  model: Partial<Pick<VeniceModelDto, "capabilities">>,
) {
  return (model.capabilities ?? []).some((capability) => {
    const normalized = capability.toLowerCase().replace(/[^a-z]/g, "");
    return (
      normalized.includes("functioncalling") ||
      normalized.includes("toolcalling")
    );
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

export function modelPrivacyFlags(
  model: ModelPrivacySignals,
): ModelPrivacyFlags {
  const privacy = (model.privacy ?? "").toLowerCase();
  const traits = model.traits.map((trait) => trait.toLowerCase());
  const capabilities = (model.capabilities ?? []).map((capability) =>
    capability.toLowerCase(),
  );
  return {
    e2ee:
      privacy === "e2ee" ||
      traits.some((trait) => trait === "e2ee") ||
      capabilities.some((capability) => capability === "e2ee"),
    private:
      privacy === "private" || traits.some((trait) => trait === "private"),
    anonymous:
      privacy.includes("anonymous") ||
      privacy.includes("anonymized") ||
      traits.some(
        (trait) => trait.includes("anonymous") || trait.includes("anonymized"),
      ),
    uncensored: traits.some((trait) => trait.includes("uncensored")),
  };
}
