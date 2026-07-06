import type { VeniceModelDto } from "./tauri";

// June's default video model. Mirrors DEFAULT_VIDEO_MODEL in the Rust providers
// module (src-tauri/src/providers/mod.rs). Keep the two in sync.
export const DEFAULT_VIDEO_MODEL = "seedance-2-0-fast-text-to-video";

// Curated Venice video models for the settings picker. This first cut only
// includes models valid for the fixed 5s/720p fast-path default.
export const VIDEO_MODELS: VeniceModelDto[] = [
  {
    provider: "venice",
    id: "seedance-2-0-fast-text-to-video",
    name: "Seedance 2.0 Fast",
    modelType: "video",
    description: "Default text-to-video model for fast 5 second 720p clips.",
    traits: ["default"],
    capabilities: [],
  },
  {
    provider: "venice",
    id: "wan-2.2-a14b-text-to-video",
    name: "WAN 2.2 A14B",
    modelType: "video",
    description: "Text-to-video model with strong prompt adherence at 5 seconds and 720p.",
    traits: [],
    capabilities: [],
  },
];
