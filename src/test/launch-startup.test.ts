import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  scheduleLaunchWorkAfterFirstPaint,
  START_AFTER_FIRST_PAINT_COMMAND,
} from "../app/launch-startup";

const mocks = vi.hoisted(() => ({
  initializeExperimentalFlags: vi.fn().mockResolvedValue(undefined),
  invoke: vi.fn().mockResolvedValue(undefined),
  prefetchRemainingWorkspacesAfterPaint: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("../lib/experimental-flags", () => ({
  initializeExperimentalFlags: mocks.initializeExperimentalFlags,
}));

vi.mock("../app/workspace-lazy", () => ({
  prefetchRemainingWorkspacesAfterPaint: mocks.prefetchRemainingWorkspacesAfterPaint,
}));

describe("launch startup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps optional startup work behind the first paint boundary", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });

    scheduleLaunchWorkAfterFirstPaint();

    expect(mocks.initializeExperimentalFlags).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.prefetchRemainingWorkspacesAfterPaint).not.toHaveBeenCalled();

    frames.shift()?.(0);

    expect(mocks.initializeExperimentalFlags).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.prefetchRemainingWorkspacesAfterPaint).not.toHaveBeenCalled();

    frames.shift()?.(16);

    expect(mocks.initializeExperimentalFlags).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(START_AFTER_FIRST_PAINT_COMMAND);
    expect(mocks.prefetchRemainingWorkspacesAfterPaint).toHaveBeenCalledOnce();
  });

  it("can cancel before the post-paint frame runs", () => {
    const frames: FrameRequestCallback[] = [];
    const cancelAnimationFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });

    const cancel = scheduleLaunchWorkAfterFirstPaint();
    frames.shift()?.(0);
    cancel();
    frames.shift()?.(16);

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(mocks.initializeExperimentalFlags).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.prefetchRemainingWorkspacesAfterPaint).not.toHaveBeenCalled();
  });
});
