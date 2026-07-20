import type { VeniceModelDto } from "./tauri";

// June's default image model. Mirrors DEFAULT_IMAGE_MODEL in the Rust providers
// module (src-tauri/src/providers/mod.rs) — keep the two in sync.
export const DEFAULT_IMAGE_MODEL = "venice-sd35";

type ImageModelDefinition = Omit<
  VeniceModelDto,
  "provider" | "modelType" | "capabilities" | "traits"
> &
  Pick<VeniceModelDto, "privacy"> &
  Partial<Pick<VeniceModelDto, "capabilities" | "traits">>;

function imageModel({
  traits = [],
  capabilities = [],
  ...model
}: ImageModelDefinition): VeniceModelDto {
  return {
    provider: "venice",
    modelType: "image",
    capabilities,
    traits,
    ...model,
  };
}

// Curated Venice image models for the settings picker. Image models are not
// part of the text/ASR model catalog the backend serves, so the picker uses
// this local snapshot instead of fetching. Image generation IS metered: the
// backend charges a flat per-image credit price keyed by model id
// (`image_pricing` in june-config) and rejects any model without one
// (`model_not_priced`). Keep these ids in sync with that map — a model listed
// here but unpriced there fails at generation time.
export const IMAGE_MODELS: VeniceModelDto[] = [
  imageModel({
    id: "venice-sd35",
    name: "Venice SD3.5",
    description: "Venice's default Stable Diffusion 3.5 image model.",
    privacy: "private",
    traits: ["eliza-default"],
  }),
  imageModel({
    id: "grok-imagine-image-quality",
    name: "Grok Imagine High Quality",
    privacy: "private",
  }),
  imageModel({
    id: "krea-2-turbo",
    name: "Krea 2 Turbo",
    privacy: "private",
  }),
  imageModel({
    id: "flux-2-pro",
    name: "FLUX 2 Pro",
    description: "High-detail FLUX model for photorealistic results.",
    privacy: "anonymized",
  }),
  imageModel({
    id: "flux-2-max",
    name: "FLUX 2 Max",
    privacy: "anonymized",
  }),
  imageModel({
    id: "gpt-image-2",
    name: "GPT Image 2",
    privacy: "anonymized",
  }),
  imageModel({
    id: "gpt-image-1-5",
    name: "GPT Image 1.5",
    privacy: "anonymized",
  }),
  imageModel({
    id: "hunyuan-image-v3",
    name: "Hunyuan Image 3.0",
    privacy: "private",
  }),
  imageModel({
    id: "ideogram-v4",
    name: "Ideogram V4",
    privacy: "anonymized",
  }),
  imageModel({
    id: "imagineart-1.5-pro",
    name: "ImagineArt 1.5 Pro",
    privacy: "anonymized",
  }),
  imageModel({
    id: "krea-v2-large",
    name: "Krea v2 Large",
    privacy: "anonymized",
  }),
  imageModel({
    id: "krea-v2-medium",
    name: "Krea v2 Medium",
    privacy: "anonymized",
  }),
  imageModel({
    id: "luma-uni-1",
    name: "Luma Uni-1",
    privacy: "anonymized",
  }),
  imageModel({
    id: "luma-uni-1-max",
    name: "Luma Uni-1 Max",
    privacy: "anonymized",
  }),
  imageModel({
    id: "nano-banana-2",
    name: "Nano Banana 2",
    privacy: "anonymized",
  }),
  imageModel({
    id: "nano-banana-pro",
    name: "Nano Banana Pro",
    privacy: "anonymized",
  }),
  imageModel({
    id: "nano-banana-2-lite",
    name: "Nano Banana 2 Lite",
    privacy: "anonymized",
  }),
  imageModel({
    id: "recraft-v4",
    name: "Recraft V4",
    privacy: "anonymized",
  }),
  imageModel({
    id: "recraft-v4-pro",
    name: "Recraft V4 Pro",
    privacy: "anonymized",
  }),
  imageModel({
    id: "seedream-v4",
    name: "Seedream V4.5",
    privacy: "anonymized",
  }),
  imageModel({
    id: "seedream-v5-lite",
    name: "Seedream V5 Lite",
    privacy: "anonymized",
  }),
  imageModel({
    id: "qwen-image-2",
    name: "Qwen Image 2",
    privacy: "anonymized",
  }),
  imageModel({
    id: "qwen-image-2-pro",
    name: "Qwen Image 2 Pro",
    privacy: "anonymized",
  }),
  imageModel({
    id: "wan-2-7-text-to-image",
    name: "Wan 2.7",
    privacy: "anonymized",
  }),
  imageModel({
    id: "wan-2-7-pro-text-to-image",
    name: "Wan 2.7 Pro",
    privacy: "anonymized",
  }),
  imageModel({
    id: "grok-imagine-image",
    name: "Grok Imagine",
    privacy: "private",
  }),
  imageModel({
    id: "lustify-sdxl",
    name: "Lustify SDXL",
    privacy: "private",
  }),
  imageModel({
    id: "lustify-v7",
    name: "Lustify v7",
    privacy: "private",
    traits: ["most_uncensored"],
  }),
  imageModel({
    id: "lustify-v8",
    name: "Lustify v8",
    privacy: "private",
    traits: ["most_uncensored"],
  }),
  imageModel({
    id: "qwen-image",
    name: "Qwen Image",
    description: "Strong text rendering and prompt adherence.",
    privacy: "anonymized",
    traits: ["highest_quality"],
  }),
  imageModel({
    id: "wai-Illustrious",
    name: "Anime (WAI)",
    privacy: "private",
  }),
  imageModel({
    id: "z-image-turbo",
    name: "Z-Image Turbo",
    privacy: "private",
    traits: ["default", "fastest"],
  }),
  imageModel({
    id: "chroma",
    name: "Chroma",
    description: "Versatile general-purpose image model.",
    privacy: "private",
  }),
  imageModel({
    id: "bria-bg-remover",
    name: "Background Remover",
    privacy: "anonymized",
  }),
];

export function imageModelCatalog(): VeniceModelDto[] {
  return IMAGE_MODELS;
}
