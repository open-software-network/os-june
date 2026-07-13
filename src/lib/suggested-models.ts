import { modelSupportsImageInput, modelSupportsTools } from "./model-privacy";
import type { ProviderModelMode, VeniceModelDto } from "./tauri";

export type SuggestedModel = {
  id: string;
  /** Picker-only label. The persisted provider model id is unchanged. */
  label?: string;
  /** Auto-router preference selected with this suggestion (0-100). */
  costQuality?: number;
  /** One-line "when to choose it" guidance shown in the suggested model card. */
  reason: string;
};

// Auto owns the visible text suggestions, but image attachment recovery still
// needs a concrete vision-capable model. Keep that operational fallback
// independent from picker curation.
const PREFERRED_VISION_FALLBACK_IDS = ["kimi-k2-6"];

/**
 * Curated picks for the model picker's "Suggested" tab — the handful of
 * models we actually recommend, weighed on benchmark performance, price,
 * tool use, and privacy (June's agent needs tool calling, and June's pitch
 * is zero-retention privacy, so every text pick here is a "private" catalog
 * model that supports tools).
 *
 * Text suggestions are the three useful ways to run Auto. Auto selects the
 * best currently available private model for each request; these presets tune
 * that routing decision without making people understand the provider catalog.
 * - Parakeet: fast, accurate everyday dictation at the lowest price tier.
 * - Whisper Large v3: best multilingual accuracy at the same low price.
 *
 * The default text model (DEFAULT_GENERATION_MODEL in the Rust providers
 * module, mirrored by the frontend and june-api defaults) is the first
 * generation pick here; keep them in sync when this changes.
 *
 * Ids are matched against the live catalog at render time, so a delisted
 * model silently drops out instead of rendering a dead row.
 */
export const SUGGESTED_MODELS: Record<ProviderModelMode, SuggestedModel[]> = {
  generation: [
    {
      id: "open-software/auto",
      label: "Auto · Higher Quality",
      costQuality: 100,
      reason: "Best for complex questions and important work where response quality matters most.",
    },
    {
      id: "open-software/auto",
      label: "Auto · Balanced",
      costQuality: 50,
      reason: "Best for everyday work when you want a strong balance of quality and cost.",
    },
    {
      id: "open-software/auto",
      label: "Auto · Lower Cost",
      costQuality: 20,
      reason: "Best for quick or routine tasks when keeping usage costs down matters most.",
    },
  ],
  transcription: [
    {
      id: "nvidia/parakeet-tdt-0.6b-v3",
      reason:
        "Fast and accurate for everyday dictation and meetings, zero data retention, lowest price tier.",
    },
    {
      id: "openai/whisper-large-v3",
      reason: "Best multilingual accuracy at the same low price, with zero data retention.",
    },
  ],
  // Image models come from the curated local list in lib/image-models.ts, not
  // a fetched catalog; these picks are the shortlist the picker surfaces above
  // "All models". The default (DEFAULT_IMAGE_MODEL, venice-sd35) stays first so
  // it is always visible without expanding.
  image: [
    {
      id: "venice-sd35",
      reason:
        "Default pick: Venice's Stable Diffusion 3.5 model, a private all-rounder for everyday images.",
    },
    {
      id: "z-image-turbo",
      reason: "Fastest pick: quick, low-cost generations with zero data retention.",
    },
    {
      id: "qwen-image",
      reason: "Quality pick: strong text rendering and prompt adherence for detailed images.",
    },
    {
      id: "lustify-v8",
      reason: "Uncensored pick: the least restricted image model, with zero data retention.",
    },
  ],
  // Video is a small curated local list (lib/video-models.ts); all three
  // private-tier models are suggested so they show without expanding "All
  // models". The default (DEFAULT_VIDEO_MODEL, wan-2.2-a14b) stays first.
  video: [
    {
      id: "wan-2.2-a14b-text-to-video",
      reason: "Default pick: fast 5 second 720p clips, the lowest-cost option.",
    },
    {
      id: "grok-imagine-text-to-video-private",
      reason: "Photorealistic pick: lifelike clips with audio, zero data retention.",
    },
    {
      id: "ltx-2-19b-full-text-to-video",
      reason: "Quality pick: higher-detail open-source model with audio.",
    },
  ],
};

/**
 * The model June switches to when the user attaches an image while a
 * non-vision model is active. The switch must land on a model that can both
 * read images AND run tools — a vision model without function calling would
 * brick the agent the same way the model picker guards against — so we filter
 * on both capabilities. Among the eligible models we prefer a concrete
 * vision pick (currently Kimi K2.6), so the one-tap fix
 * lands on a sensible default instead of the alphabetically-first vision model
 * (which is otherwise arbitrary — the catalog sorts by display name). If no
 * preferred model is eligible we fall back to the first eligible catalog model.
 * A retired preference is ignored because it is resolved against the live catalog.
 */
export function preferredVisionFallbackModel(models: VeniceModelDto[]): VeniceModelDto | undefined {
  const eligible = models.filter(
    (model) => modelSupportsImageInput(model) && modelSupportsTools(model),
  );
  const suggested = PREFERRED_VISION_FALLBACK_IDS.map((id) =>
    eligible.find((model) => model.id === id),
  ).find((model): model is VeniceModelDto => model !== undefined);
  return suggested ?? eligible[0];
}

/** The curated picks that are actually present in the live catalog, in
 * curated order. Picker-only labels and guidance replace the generic catalog
 * name and description without changing the persisted model id. */
export function suggestedModelsForMode(
  mode: ProviderModelMode,
  options: VeniceModelDto[],
): Array<{
  key: string;
  model: VeniceModelDto;
  reason: string;
  costQuality?: number;
}> {
  return SUGGESTED_MODELS[mode].flatMap((suggested, index) => {
    const model = options.find((option) => option.id === suggested.id);
    if (!model) return [];
    return [
      {
        key: `${suggested.id}:${suggested.costQuality ?? index}`,
        model: {
          ...model,
          ...(suggested.label ? { name: suggested.label, description: suggested.reason } : {}),
        },
        reason: suggested.reason,
        costQuality: suggested.costQuality,
      },
    ];
  });
}
