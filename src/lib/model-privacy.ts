import type { ProviderModelMode, VeniceModelDto } from "./tauri";

export type ModelPrivacyMode = "private" | "anonymous";

export type ModelPrivacyBadge = {
  mode: ModelPrivacyMode;
  label: string;
  description: string;
};

export type ModelPrivacyFlags = {
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

export const PRIVATE_MODEL_DESCRIPTION =
  "You're using a model that is private and anonymous.";
export const ANONYMOUS_MODEL_DESCRIPTION =
  "You're using a model that is anonymizing your prompts but may still train on your data.";

export function modelPrivacyBadge(
  model: Pick<VeniceModelDto, "privacy" | "traits">,
  flags = modelPrivacyFlags(model),
): ModelPrivacyBadge | undefined {
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
  model: Pick<VeniceModelDto, "privacy" | "traits">,
): ModelPrivacyFlags {
  const privacy = (model.privacy ?? "").toLowerCase();
  const traits = model.traits.map((trait) => trait.toLowerCase());
  return {
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
