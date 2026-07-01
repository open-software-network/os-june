import type { VeniceModelDto } from "./tauri";

// June's default image model. Mirrors DEFAULT_IMAGE_MODEL in the Rust providers
// module (src-tauri/src/providers/mod.rs) — keep the two in sync.
export const DEFAULT_IMAGE_MODEL = "venice-sd35";

// Curated Venice image models for the settings picker. Image models are not
// part of the text/ASR model catalog the backend serves, so the picker uses
// this local snapshot instead of fetching. Image generation IS metered: the
// backend charges a flat per-image credit price keyed by model id
// (`image_pricing` in june-config) and rejects any model without one
// (`model_not_priced`). Keep these ids in sync with that map — a model listed
// here but unpriced there fails at generation time.
export const IMAGE_MODELS: VeniceModelDto[] = [
  {
    provider: "venice",
    id: "venice-sd35",
    name: "Venice SD3.5",
    modelType: "image",
    description: "Venice's default Stable Diffusion 3.5 image model.",
    traits: ["default"],
    capabilities: [],
  },
  {
    provider: "venice",
    id: "flux-2-pro",
    name: "FLUX 2 Pro",
    modelType: "image",
    description: "High-detail FLUX model for photorealistic results.",
    traits: [],
    capabilities: [],
  },
  {
    provider: "venice",
    id: "qwen-image",
    name: "Qwen Image",
    modelType: "image",
    description: "Strong text rendering and prompt adherence.",
    traits: [],
    capabilities: [],
  },
  {
    provider: "venice",
    id: "chroma",
    name: "Chroma",
    modelType: "image",
    description: "Versatile general-purpose image model.",
    traits: [],
    capabilities: [],
  },
];
