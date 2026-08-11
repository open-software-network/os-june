import { describe, expect, it } from "vitest";
import {
  LOCAL_GENERATION_OPTION_ID_PREFIX,
  localGenerationOptionId,
  rawLocalGenerationModelId,
} from "../lib/local-generation";

describe("local generation model identity", () => {
  it("writes Clovy-canonical option ids", () => {
    expect(LOCAL_GENERATION_OPTION_ID_PREFIX).toBe("__clovy_local_generation__:");
    expect(localGenerationOptionId("llama3.1:8b")).toBe("__clovy_local_generation__:llama3.1%3A8b");
  });

  it("reads canonical and legacy option ids", () => {
    expect(rawLocalGenerationModelId("__clovy_local_generation__:llama3.1%3A8b")).toBe(
      "llama3.1:8b",
    );
    expect(rawLocalGenerationModelId("__june_local_generation__:llama3.1%3A8b")).toBe(
      "llama3.1:8b",
    );
  });
});
