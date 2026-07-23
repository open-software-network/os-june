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
// Deliberately kept to three, all Venice `private` (not-logged) tier — a fast
// default, a photorealistic option, and a higher-detail option — rather than
// the full compatible catalog. Three hard constraints govern any entry; a model
// that breaks the first two fails at generation time, not here:
//   1. It must be priced in june-api's `video_pricing` map (ADR 0015): that map
//      doubles as the allowlist, and an unlisted model is rejected
//      `model_not_priced`. Keep these ids in sync with that map AND with
//      `KNOWN_VIDEO_MODELS` in src-tauri/src/providers/mod.rs.
//   2. It must accept the fixed fast-path shape June injects (5s / 720p / 16:9;
//      see JUNE_VIDEO_DEFAULT_* in the retired bridge). Each id below is a
//      text-to-video Venice model that lists all three in its catalog
//      constraints; a model missing any would 400 at queue on the fast path.
//   3. Venice `private` privacy tier, to match June's privacy stance (several
//      compatible models are `anonymized` — logged, de-identified — and are
//      deliberately excluded).
export const VIDEO_MODELS: VeniceModelDto[] = [
  videoModel({
    id: "wan-2.2-a14b-text-to-video",
    name: "Wan 2.2 A14B",
    description: "Default text-to-video model for fast 5 second 720p clips.",
    privacy: "private",
    traits: ["default", "fastest"],
  }),
  videoModel({
    id: "grok-imagine-text-to-video-private",
    name: "Grok Imagine",
    description: "Photorealistic clips with audio.",
    privacy: "private",
  }),
  videoModel({
    id: "ltx-2-19b-full-text-to-video",
    name: "LTX Video 2.0 19B",
    description: "Higher-detail open-source model with audio.",
    privacy: "private",
    traits: ["highest_quality"],
  }),
];
