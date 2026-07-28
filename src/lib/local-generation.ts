import type {
  LocalGenerationSettingsDto,
  LocalTranscriptionSettingsDto,
  VeniceModelDto,
} from "./tauri";

// Bring-your-own local text generation. The model catalog is derived
// client-side from provider settings, so the user's configured local endpoint
// is surfaced as a synthetic catalog option. These helpers are shared between
// the settings surface and the agent composer, so they live outside
// AppSettings.

export const LOCAL_GENERATION_OPTION_ID_PREFIX = "__june_local_generation__:";
export const LOCAL_TRANSCRIPTION_OPTION_ID_PREFIX = "__june_local_transcription__:";

function taggedLocalOptionId(prefix: string, modelId: string) {
  return `${prefix}${encodeURIComponent(modelId.trim())}`;
}

function rawLocalModelId(prefix: string, optionId: string): string | null {
  if (!optionId.startsWith(prefix)) return null;
  try {
    const decoded = decodeURIComponent(optionId.slice(prefix.length)).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

type LocalCatalogRowInput = {
  optionId: string;
  modelId: string;
  modelType: string;
  loopback: boolean;
};

function localCatalogRow({
  optionId,
  modelId,
  modelType,
  loopback,
}: LocalCatalogRowInput): VeniceModelDto {
  const kind = modelType === "asr" ? "transcription" : "text";
  return {
    provider: "local",
    id: optionId,
    name: `Local: ${modelId}`,
    modelType,
    description: loopback
      ? `OpenAI-compatible local ${kind} model.`
      : `OpenAI-compatible ${kind} model on a remote endpoint.`,
    privacy: loopback ? "local" : "external",
    pricing: { display: "Local" },
    traits: ["local"],
    capabilities: [],
    priceUnit: "local",
    priceDescription: "Local",
  };
}

export function localGenerationOptionId(modelId: string) {
  return taggedLocalOptionId(LOCAL_GENERATION_OPTION_ID_PREFIX, modelId);
}

export function rawLocalGenerationModelId(optionId: string): string | null {
  return rawLocalModelId(LOCAL_GENERATION_OPTION_ID_PREFIX, optionId);
}

export function localTranscriptionOptionId(modelId: string) {
  return taggedLocalOptionId(LOCAL_TRANSCRIPTION_OPTION_ID_PREFIX, modelId);
}

export function rawLocalTranscriptionModelId(optionId: string): string | null {
  return rawLocalModelId(LOCAL_TRANSCRIPTION_OPTION_ID_PREFIX, optionId);
}

export function unavailableLocalGenerationOption(optionId: string): VeniceModelDto | null {
  const modelId = rawLocalGenerationModelId(optionId);
  if (!modelId) return null;
  return {
    ...localCatalogRow({
      optionId,
      modelId,
      modelType: "text",
      loopback: false,
    }),
    description: "This local model is no longer configured.",
  };
}

/** True when the endpoint resolves to this machine: localhost, any
 * *.localhost name, the 127.0.0.0/8 loopback block, or the IPv6 [::1]
 * literal. Invalid input is treated as non-loopback (returns false) so the
 * caller shows the "leaves your device" warning rather than a false
 * reassurance. */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // URL.hostname keeps the brackets on IPv6 literals ("[::1]").
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  if (bare === "::1") return true;
  const octets = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (octets) {
    const parts = octets.slice(1).map(Number);
    if (parts.every((part) => part <= 255) && parts[0] === 127) return true;
  }
  return false;
}

/** Prepends the user's configured local endpoint as a synthetic catalog
 * option when a model id is set. Capabilities are left empty: a local model's
 * tool support can't be verified from here, so it must not be advertised as
 * tool-capable (see modelSupportsTools, which special-cases the local
 * provider instead). Privacy is only claimed as "local" for a loopback
 * endpoint; a remote endpoint is marked "external" since prompts leave the
 * device. */
export function withLocalGenerationOption(
  models: VeniceModelDto[],
  localGeneration: LocalGenerationSettingsDto,
): VeniceModelDto[] {
  const modelId = localGeneration.modelId.trim();
  if (!modelId) return models;
  const loopback = isLoopbackUrl(localGeneration.baseUrl);
  const localModel = localCatalogRow({
    optionId: localGenerationOptionId(modelId),
    modelId,
    modelType: "text",
    loopback,
  });
  return [localModel, ...models];
}

export function withLocalTranscriptionOption(
  models: VeniceModelDto[],
  localTranscription: LocalTranscriptionSettingsDto,
): VeniceModelDto[] {
  const modelId = localTranscription.modelId.trim();
  if (!modelId) return models;
  const loopback = isLoopbackUrl(localTranscription.baseUrl);
  const localModel = localCatalogRow({
    optionId: localTranscriptionOptionId(modelId),
    modelId,
    modelType: "asr",
    loopback,
  });
  return [localModel, ...models];
}

export function transcriptionPickerValueForMode({
  localTranscriptionEnabled,
  localModelId,
  showingPartitionModels,
  effectiveTranscriptionModel,
}: {
  localTranscriptionEnabled: boolean;
  localModelId: string;
  showingPartitionModels: boolean;
  effectiveTranscriptionModel: string;
}): string {
  if (!showingPartitionModels && localTranscriptionEnabled && localModelId.trim()) {
    return localTranscriptionOptionId(localModelId);
  }
  return effectiveTranscriptionModel;
}
