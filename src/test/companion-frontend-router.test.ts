import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  queueCompanionFrontendRequest,
  takeCompanionFrontendRequests,
} from "../lib/companion-frontend-router";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/tauri", () => ({
  companionCancelFrontendRequest: mocks.cancel,
}));

describe("companion frontend queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.cancel.mockClear();
    takeCompanionFrontendRequests();
  });

  afterEach(() => {
    takeCompanionFrontendRequests();
    vi.useRealTimers();
  });

  it("cancels Rust activity when an unconsumed request expires", async () => {
    queueCompanionFrontendRequest({
      operationId: "operation-expired",
      intent: { type: "agentCancel", data: { storedSessionId: "stored-session" } },
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocks.cancel).toHaveBeenCalledWith("operation-expired");
  });

  it("does not cancel a request after a consumer takes it", async () => {
    const request = {
      operationId: "operation-consumed",
      intent: { type: "agentCancel" as const, data: { storedSessionId: "stored-session" } },
    };
    queueCompanionFrontendRequest(request);
    expect(takeCompanionFrontendRequests()).toEqual([request]);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});
