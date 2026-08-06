import { describe, expect, it } from "vitest";
import {
  agentModelSelection,
  agentRunModelId,
  AGENT_RUN_AUTO_MODEL_PREFIX,
  AUTO_MODEL_ID,
} from "../lib/agent-model-selection";

describe("agent Auto model selections", () => {
  it("encodes the Auto preference for the Clovy API run boundary", () => {
    expect(agentRunModelId(AUTO_MODEL_ID, 20)).toBe(`${AGENT_RUN_AUTO_MODEL_PREFIX}20`);
    expect(agentRunModelId(AUTO_MODEL_ID, 50)).toBe(`${AGENT_RUN_AUTO_MODEL_PREFIX}50`);
    expect(agentRunModelId(AUTO_MODEL_ID, 100)).toBe(`${AGENT_RUN_AUTO_MODEL_PREFIX}100`);
    expect(agentRunModelId("fast", 20)).toBe("fast");
  });

  it("decodes persisted Auto preferences without exposing the tagged model in the picker", () => {
    expect(agentModelSelection(`${AGENT_RUN_AUTO_MODEL_PREFIX}20`)).toEqual({
      modelId: AUTO_MODEL_ID,
      costQuality: 20,
    });
    expect(agentModelSelection(`${AGENT_RUN_AUTO_MODEL_PREFIX}50`)).toEqual({
      modelId: AUTO_MODEL_ID,
      costQuality: 50,
    });
    expect(agentModelSelection(`${AGENT_RUN_AUTO_MODEL_PREFIX}100`)).toEqual({
      modelId: AUTO_MODEL_ID,
      costQuality: 100,
    });
  });

  it("falls back safely for malformed preferences and preserves concrete models", () => {
    expect(agentModelSelection(`${AGENT_RUN_AUTO_MODEL_PREFIX}101`)).toEqual({
      modelId: AUTO_MODEL_ID,
    });
    expect(agentModelSelection(`${AGENT_RUN_AUTO_MODEL_PREFIX}wat`)).toEqual({
      modelId: AUTO_MODEL_ID,
    });
    expect(agentModelSelection("fast")).toEqual({ modelId: "fast" });
  });
});
