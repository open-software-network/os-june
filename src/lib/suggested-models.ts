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
 * - GLM 5: state-of-the-art agentic coding among open models (~78%
 *   SWE-bench), strong tool use, $1/$3.20 per 1M tokens — June's default.
 * - Kimi K2.6: leads the open-weights intelligence rankings, built for long
 *   agentic tool runs, 256K context, $0.85/$4.66.
 * - GLM 4.7: Venice's own catalog default and "function calling default" —
 *   near-flagship quality at roughly half GLM 5's price, $0.55/$2.65.
 * - Parakeet: fast, accurate everyday dictation at the lowest price tier.
 * - Whisper Large v3: best multilingual accuracy at the same low price.
 *
 * Ids are matched against the live catalog at render time, so a delisted
 * model silently drops out instead of rendering a dead row.
 */
export const SUGGESTED_MODELS: Record<ProviderModelMode, SuggestedModel[]> = {
  generation: [
    {
      id: "zai-org-glm-5",
      reason:
        "Best overall: top-tier agentic coding and tool use among open models, with zero data retention.",
    },
    {
      id: "kimi-k2-6",
      reason:
        "Most capable open-weights model: leads independent intelligence rankings and excels at long tool-driven tasks, with zero data retention.",
    },
    {
      id: "zai-org-glm-4.7",
      reason:
        "Best value: near-flagship quality at about half the price, and Venice's own default for tool calling, with zero data retention.",
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
