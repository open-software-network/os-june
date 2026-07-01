import { describe, expect, it } from "vitest";
import { preferredVisionFallbackModel } from "../lib/suggested-models";
import type { VeniceModelDto } from "../lib/tauri";

const model = (
  id: string,
  name: string,
  capabilities: string[],
): VeniceModelDto => ({
  provider: "venice",
  id,
  name,
  modelType: "text",
  traits: [],
  capabilities,
});

const VISION_TOOLS = ["supportsFunctionCalling", "supportsVision"];
// The catalog sorts by display name, so the alphabetically-first vision model
// ("Claude Fable 5") is what a naive `[0]` fallback would pick — the JUN-165
// bug. These fixtures put Fable first to prove the preference overrides order.
const fable = model("claude-fable-5", "Claude Fable 5", VISION_TOOLS);
const kimi = model("kimi-k2-6", "Kimi K2.6", VISION_TOOLS); // suggested pick
const glm52 = model("zai-org-glm-5-2", "GLM 5.2", ["supportsFunctionCalling"]);

describe("preferredVisionFallbackModel", () => {
  it("prefers the suggested vision model (Kimi) over the first vision model", () => {
    const chosen = preferredVisionFallbackModel([fable, kimi, glm52]);
    expect(chosen?.id).toBe("kimi-k2-6");
  });

  it("never returns a non-vision model, even a suggested one (GLM 5.2)", () => {
    // GLM 5.2 is the first suggested id but is non-vision; it must be skipped.
    const chosen = preferredVisionFallbackModel([glm52, fable]);
    expect(chosen?.id).toBe("claude-fable-5");
  });

  it("falls back to the first eligible model when none are suggested", () => {
    const qwen = model("qwen3-5-9b", "Qwen 3.5 9B", VISION_TOOLS);
    const chosen = preferredVisionFallbackModel([fable, qwen]);
    expect(chosen?.id).toBe("claude-fable-5");
  });

  it("requires tool support: a vision model without tools is not eligible", () => {
    // A vision model that can't run tools would brick the agent, so the
    // suggested Kimi entry here (vision only, no tools) must be skipped.
    const kimiNoTools = model("kimi-k2-6", "Kimi K2.6", ["supportsVision"]);
    const chosen = preferredVisionFallbackModel([kimiNoTools, fable]);
    expect(chosen?.id).toBe("claude-fable-5");
  });

  it("returns undefined when no model can read images", () => {
    const glm51 = model("zai-org-glm-5-1", "GLM 5.1", [
      "supportsFunctionCalling",
    ]);
    expect(preferredVisionFallbackModel([glm52, glm51])).toBeUndefined();
    expect(preferredVisionFallbackModel([])).toBeUndefined();
  });
});
