export const AUTO_MODEL_ID = "open-software/auto";

// Rust decodes this tagged model at the Clovy API boundary and forwards the
// selected Auto cost-to-quality value with the request. Keeping it in the
// run model also makes a session's preference survive navigation, retries,
// and app restarts without changing the public runtime protocol.
export const AGENT_RUN_AUTO_MODEL_PREFIX = "__june_auto_generation__:";

export type AgentModelSelection = {
  modelId: string;
  costQuality?: number;
};

export function agentRunModelId(modelId: string, costQuality?: number): string {
  if (modelId !== AUTO_MODEL_ID || costQuality === undefined || !Number.isFinite(costQuality)) {
    return modelId;
  }
  const normalized = Math.max(0, Math.min(100, Math.round(costQuality)));
  return `${AGENT_RUN_AUTO_MODEL_PREFIX}${normalized}`;
}

export function agentModelSelection(modelId: string): AgentModelSelection {
  if (!modelId.startsWith(AGENT_RUN_AUTO_MODEL_PREFIX)) return { modelId };
  const encoded = modelId.slice(AGENT_RUN_AUTO_MODEL_PREFIX.length);
  if (!/^\d{1,3}$/.test(encoded)) return { modelId: AUTO_MODEL_ID };
  const parsed = Number(encoded);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) return { modelId: AUTO_MODEL_ID };
  return { modelId: AUTO_MODEL_ID, costQuality: parsed };
}
