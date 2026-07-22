import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrailingMicrobatch } from "../lib/trailing-microbatch";

describe("createTrailingMicrobatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes a burst once at the trailing edge", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const batch = createTrailingMicrobatch(publish, 50);

    batch.schedule();
    batch.schedule();
    vi.advanceTimersByTime(49);
    expect(publish).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("flushes pending work immediately without a later duplicate", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const batch = createTrailingMicrobatch(publish, 50);

    batch.schedule();
    batch.flush();
    expect(publish).toHaveBeenCalledOnce();

    vi.runAllTimers();
    expect(publish).toHaveBeenCalledOnce();
  });

  it("cancels pending work", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const batch = createTrailingMicrobatch(publish, 50);

    batch.schedule();
    batch.cancel();
    vi.runAllTimers();

    expect(publish).not.toHaveBeenCalled();
  });
});
