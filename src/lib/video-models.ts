import type { VeniceModelDto } from "./tauri";

// June's default video model. Mirrors DEFAULT_VIDEO_MODEL in the Rust providers
// module (src-tauri/src/providers/mod.rs). Keep the two in sync.
export const DEFAULT_VIDEO_MODEL = "wan-2.2-a14b-text-to-video";

type VideoModelDefinition = Omit<
  VeniceModelDto,
  "provider" | "modelType" | "capabilities" | "traits"
> &
  Pick<VeniceModelDto, "privacy"> &
  Partial<Pick<VeniceModelDto, "capabilities" | "traits">>;

function videoModel({
  traits = [],
  capabilities = [],
  ...model
}: VideoModelDefinition): VeniceModelDto {
  return {
    provider: "venice",
    modelType: "video",
    capabilities,
    traits,
    ...model,
  };
}

// Curated Venice text-to-video models for the settings picker. Video models are
// not part of the text/ASR catalog the backend serves, so the picker uses this
// local snapshot instead of fetching (same pattern as IMAGE_MODELS).
//
// Two hard constraints govern this list — a model that breaks either fails at
// generation time, not here:
//   1. It must be priced in june-api's `video_pricing` map (ADR 0013): that map
//      doubles as the allowlist, and an unlisted model is rejected
//      `model_not_priced`. Keep these ids in sync with that map AND with
//      `KNOWN_VIDEO_MODELS` in src-tauri/src/providers/mod.rs.
//   2. It must accept the fixed fast-path shape June injects (5s / 720p / 16:9;
//      see JUNE_VIDEO_DEFAULT_* in hermes_bridge.rs). Every id below is a
//      text-to-video Venice model that lists all three in its catalog
//      constraints; a model missing any would 400 at queue on the fast path.
export const VIDEO_MODELS: VeniceModelDto[] = [
  videoModel({
    id: "wan-2.2-a14b-text-to-video",
    name: "Wan 2.2 A14B",
    description: "Default text-to-video model for fast 5 second 720p clips.",
    privacy: "private",
    traits: ["default", "fastest"],
  }),
  videoModel({
    id: "wan-2-7-text-to-video",
    name: "Wan 2.7",
    description: "Newer Wan generation with higher detail.",
    privacy: "anonymized",
    traits: ["highest_quality"],
  }),
  videoModel({
    id: "wan-2.6-text-to-video",
    name: "Wan 2.6",
    privacy: "anonymized",
  }),
  videoModel({
    id: "wan-2.5-preview-text-to-video",
    name: "Wan 2.5 Preview",
    privacy: "anonymized",
  }),
  videoModel({
    id: "grok-imagine-text-to-video-private",
    name: "Grok Imagine",
    description: "Photorealistic clips with audio.",
    privacy: "private",
  }),
  videoModel({
    id: "ltx-2-19b-distilled-text-to-video",
    name: "LTX Video 2.0 19B Distilled",
    description: "Faster LTX variant for quick iterations.",
    privacy: "private",
    traits: ["fastest"],
  }),
  videoModel({
    id: "ltx-2-19b-full-text-to-video",
    name: "LTX Video 2.0 19B",
    privacy: "private",
  }),
  videoModel({
    id: "longcat-text-to-video",
    name: "Longcat Full Quality",
    privacy: "private",
  }),
  videoModel({
    id: "longcat-distilled-text-to-video",
    name: "Longcat Distilled",
    privacy: "private",
    traits: ["fastest"],
  }),
  videoModel({
    id: "vidu-q3-text-to-video",
    name: "Vidu Q3",
    description: "Cinematic clips with audio.",
    privacy: "anonymized",
  }),
  videoModel({
    id: "pixverse-v5.6-text-to-video",
    name: "PixVerse v5.6",
    privacy: "anonymized",
  }),
  videoModel({
    id: "pixverse-c1-text-to-video",
    name: "PixVerse C1",
    privacy: "anonymized",
  }),
  videoModel({
    id: "happyhorse-1-1-text-to-video",
    name: "HappyHorse 1.1",
    privacy: "anonymized",
  }),
  videoModel({
    id: "happyhorse-1-0-text-to-video",
    name: "HappyHorse 1.0",
    privacy: "anonymized",
  }),
  videoModel({
    id: "wan-2-7-uncensored-text-to-video",
    name: "Wan 2.7 Uncensored",
    privacy: "anonymized",
    traits: ["most_uncensored"],
  }),
];
