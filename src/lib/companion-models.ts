import { agentModelSelection, agentRunModelId, AUTO_MODEL_ID } from "./agent-model-selection";
import { modelAvailableForMode, modelPrivacyBadge } from "./model-privacy";
import { pricingLabel } from "./model-pricing";
import { suggestedModelsForMode } from "./suggested-models";
import type { CompanionModelOption, CompanionSessionModelSelection, VeniceModelDto } from "./tauri";

const AUTO_MODEL: CompanionModelOption = {
  id: AUTO_MODEL_ID,
  name: "Auto",
  provider: "",
  description: "Chooses the best available model for each request.",
  routing: "automatic",
};

export function companionModelOptions(models: VeniceModelDto[]): CompanionModelOption[] {
  const available = models.filter((model) => modelAvailableForMode("generation", model));
  const curated = suggestedModelsForMode("generation", available).flatMap(
    ({ model, reason }): CompanionModelOption[] => {
      const id = model.id.trim();
      if (!id || utf8Length(id) > 256) return [];
      const privacy = modelPrivacyBadge(model);
      const price = pricingLabel(model);
      return [
        {
          id,
          name: boundedText(model.name.trim() || id, 256),
          provider: boundedText(model.provider.trim(), 64),
          description: boundedText(reason, 512),
          routing: "remote",
          ...(privacy
            ? {
                privacy:
                  privacy.mode === "e2ee"
                    ? ("endToEndEncrypted" as const)
                    : (privacy.mode as "private" | "anonymous"),
                privacyLabel: boundedText(privacy.label, 128),
              }
            : {}),
          ...(price ? { priceLabel: boundedText(price, 128) } : {}),
        },
      ];
    },
  );
  return [AUTO_MODEL, ...curated];
}

export function companionSessionModelSelection(
  storedSessionId: string,
  storedModel: string,
  models: VeniceModelDto[],
  defaultCostQuality: number,
): CompanionSessionModelSelection {
  const decoded = agentModelSelection(storedModel);
  const modelId =
    decoded.modelId === "auto" || !decoded.modelId.trim() ? AUTO_MODEL_ID : decoded.modelId;
  const modelName =
    modelId === AUTO_MODEL_ID
      ? "Auto"
      : (models.find((model) => model.id === modelId)?.name.trim() ?? "") || modelId;
  return {
    storedSessionId,
    modelId,
    modelName: boundedText(modelName, 256),
    ...(modelId === AUTO_MODEL_ID
      ? { costQuality: decoded.costQuality ?? normalizeCostQuality(defaultCostQuality) }
      : {}),
  };
}

export function companionStoredModelId(modelId: string, defaultCostQuality: number) {
  return modelId === AUTO_MODEL_ID
    ? agentRunModelId(AUTO_MODEL_ID, normalizeCostQuality(defaultCostQuality))
    : modelId;
}

function normalizeCostQuality(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function boundedText(value: string, maxBytes: number) {
  if (utf8Length(value) <= maxBytes) return value;
  const suffix = "...";
  const pieces: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Length(character);
    if (bytes + characterBytes + suffix.length > maxBytes) break;
    pieces.push(character);
    bytes += characterBytes;
  }
  return `${pieces.join("").trimEnd()}${suffix}`;
}

function utf8Length(value: string) {
  return new TextEncoder().encode(value).byteLength;
}
