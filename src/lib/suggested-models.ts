import type { ProviderModelMode, VeniceModelDto } from "./tauri";

export type SuggestedModel = {
  id: string;
  /** One-line "why we recommend it", rendered under the model's meta row. */
  reason: string;
};

/**
 * Curated picks for the model picker's "Suggested" tab — the handful of
 * models we actually recommend, weighed on benchmark performance, price,
 * tool use, and privacy (June's agent needs tool calling, and June's pitch
 * is zero-retention privacy, so every pick here is a "private" catalog model
 * that supports tools).
 *
 * Curation snapshot (June 2026), from the live Venice catalog plus public
 * benchmarks (SWE-bench agentic coding, Artificial Analysis intelligence
 * index):
 * - Kimi K2.6: leads the open-weights intelligence rankings, built for long
 *   agentic tool runs, 256K context, $0.85/$4.66 — June's default.
 * - GLM 5.1: latest GLM flagship, top-tier agentic coding and tool use among
 *   open models, 200K context, $1.75/$5.50 per 1M tokens.
 * - GLM 4.7: Venice's own catalog default and "function calling default" —
 *   near-flagship quality at a fraction of the price, $0.55/$2.65.
 * - Parakeet: fast, accurate everyday dictation at the lowest price tier.
 * - Whisper Large v3: best multilingual accuracy at the same low price.
 *
 * The default text model (DEFAULT_GENERATION_MODEL in the Rust providers
 * module, mirrored by the frontend and scribe-api defaults) is the first
 * generation pick here; keep them in sync when this changes.
 *
 * Ids are matched against the live catalog at render time, so a delisted
 * model silently drops out instead of rendering a dead row.
 */
export const SUGGESTED_MODELS: Record<ProviderModelMode, SuggestedModel[]> = {
  generation: [
    {
      id: "kimi-k2-6",
      reason:
        "Best overall: leads independent intelligence rankings and excels at long tool-driven tasks, with zero data retention.",
    },
    {
      id: "zai-org-glm-5-1",
      reason:
        "Best GLM pick: latest GLM flagship, with top-tier agentic coding and tool use among open models and zero data retention.",
    },
    {
      id: "zai-org-glm-4.7",
      reason:
        "Best value: near-flagship quality at a fraction of the price, and Venice's own default for tool calling, with zero data retention.",
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
      reason:
        "Best multilingual accuracy at the same low price, with zero data retention.",
    },
  ],
};

/** The curated picks that are actually present in the live catalog, in
 * curated order, with their recommendation reasons attached. */
export function suggestedModelsForMode(
  mode: ProviderModelMode,
  options: VeniceModelDto[],
): Array<{ model: VeniceModelDto; reason: string }> {
  return SUGGESTED_MODELS[mode].flatMap((suggested) => {
    const model = options.find((option) => option.id === suggested.id);
    return model ? [{ model, reason: suggested.reason }] : [];
  });
}
