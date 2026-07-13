import { describe, expect, it, vi } from "vitest";
import { HermesGatewayError } from "../lib/hermes-gateway";
import { applySessionModelWhenIdle } from "../lib/hermes-next-prompt-model";

describe("next-prompt model application", () => {
  it("waits through the post-completion busy window", async () => {
    const apply = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new HermesGatewayError("session busy", 4009))
      .mockRejectedValueOnce(new HermesGatewayError("session busy", 4009))
      .mockResolvedValue({ ok: true });
    const wait = vi.fn(async () => undefined);

    await expect(applySessionModelWhenIdle(apply, { wait })).resolves.toEqual({ ok: true });

    expect(apply).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[50], [100]]);
  });

  it("does not retry a real model-switch failure", async () => {
    const failure = new HermesGatewayError("unknown model", 5001);
    const apply = vi.fn<() => Promise<unknown>>().mockRejectedValue(failure);
    const wait = vi.fn(async () => undefined);

    await expect(applySessionModelWhenIdle(apply, { wait })).rejects.toBe(failure);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("stops retrying after the idle-wait budget", async () => {
    const failure = new HermesGatewayError("session busy", 4009);
    const apply = vi.fn<() => Promise<unknown>>().mockRejectedValue(failure);
    const wait = vi.fn(async () => undefined);

    await expect(applySessionModelWhenIdle(apply, { timeoutMs: 75, wait })).rejects.toBe(failure);
    expect(wait.mock.calls).toEqual([[50], [25]]);
    expect(apply).toHaveBeenCalledTimes(3);
  });
});
