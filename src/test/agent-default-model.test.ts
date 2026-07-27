import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistAgentDefaultModel,
  resetAgentDefaultModelPersistenceForTests,
} from "../lib/agent-default-model";

describe("agent default model persistence", () => {
  beforeEach(resetAgentDefaultModelPersistenceForTests);

  it("persists rapid choices in selection order even when the first write is slow", async () => {
    let resolveFirst: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const writer = vi
      .fn<(modelId: string) => Promise<void>>()
      .mockImplementationOnce(() => firstWrite)
      .mockResolvedValueOnce();

    const first = persistAgentDefaultModel("fast", writer);
    const second = persistAgentDefaultModel("open-software/auto", writer);
    await vi.waitFor(() => expect(writer).toHaveBeenCalledTimes(1));
    expect(writer).toHaveBeenNthCalledWith(1, "fast");

    resolveFirst?.();
    await Promise.all([first, second]);
    expect(writer).toHaveBeenNthCalledWith(2, "open-software/auto");
  });

  it("continues with the latest choice after an earlier write fails", async () => {
    const writer = vi
      .fn<(modelId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("first failed"))
      .mockResolvedValueOnce();
    const first = persistAgentDefaultModel("fast", writer);
    const second = persistAgentDefaultModel("open-software/auto", writer);

    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBeUndefined();
    expect(writer).toHaveBeenNthCalledWith(2, "open-software/auto");
  });
});
