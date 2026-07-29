import { describe, expect, it } from "vitest";
import {
  companionModelOptions,
  companionSessionModelSelection,
  companionStoredModelId,
} from "../lib/companion-models";
import type { VeniceModelDto } from "../lib/tauri";

function model(id: string, overrides: Partial<VeniceModelDto> = {}): VeniceModelDto {
  return {
    provider: "venice",
    id,
    name: id,
    modelType: "text",
    privacy: "private",
    traits: ["private"],
    capabilities: ["supportsFunctionCalling"],
    priceUnit: "tokens",
    priceDescription: "",
    inputCreditsPerMillionTokens: 850,
    outputCreditsPerMillionTokens: 4660,
    ...overrides,
  };
}

describe("companion model projection", () => {
  it("returns Auto plus only live, agent-capable desktop suggestions in curated order", () => {
    const options = companionModelOptions([
      model("kimi-k2-6", { name: "Kimi K2.6" }),
      model("uncurated-model"),
      model("kimi-k3", {
        name: "Kimi K3",
        privacy: "anonymized",
        traits: ["anonymous"],
      }),
      model("zai-org-glm-5-2", { name: "GLM 5.2" }),
      model("zai-org-glm-5-1", {
        name: "GLM 5.1",
        capabilities: [],
      }),
    ]);

    expect(options.map((option) => option.id)).toEqual([
      "open-software/auto",
      "zai-org-glm-5-2",
      "kimi-k3",
      "kimi-k2-6",
    ]);
    expect(options[0]).toMatchObject({
      name: "Auto",
      routing: "automatic",
    });
    expect(options[2]).toMatchObject({
      privacy: "anonymous",
      privacyLabel: "Anonymous mode",
    });
    expect(options[3]).toMatchObject({
      privacy: "private",
      privacyLabel: "Private mode",
      priceLabel: "$0.85 input / $4.66 output per 1M tokens",
    });
  });

  it("projects staged Auto preferences and names historical concrete models", () => {
    expect(
      companionSessionModelSelection("session-1", "__june_auto_generation__:20", [], 100),
    ).toEqual({
      storedSessionId: "session-1",
      modelId: "open-software/auto",
      modelName: "Auto",
      costQuality: 20,
    });
    expect(
      companionSessionModelSelection(
        "session-2",
        "retired-model",
        [model("retired-model", { name: "Retired model" })],
        100,
      ),
    ).toEqual({
      storedSessionId: "session-2",
      modelId: "retired-model",
      modelName: "Retired model",
    });
    expect(companionStoredModelId("open-software/auto", 49.6)).toBe("__june_auto_generation__:50");
  });
});
