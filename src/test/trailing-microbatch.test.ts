import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLeadingTrailingMicrobatch,
  createTrailingMicrobatch,
} from "../lib/trailing-microbatch";

afterEach(() => {
  vi.useRealTimers();
});

describe("createTrailingMicrobatch", () => {
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

describe("createLeadingTrailingMicrobatch", () => {
  it("publishes the first update immediately and coalesces the rest of the burst", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const batch = createLeadingTrailingMicrobatch(publish, 50);

    batch.schedule();
    batch.schedule();
    batch.schedule();

    expect(publish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    expect(publish).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(50);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("starts a new burst with an immediate publication after going quiet", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const batch = createLeadingTrailingMicrobatch(publish, 50);

    batch.schedule();
    vi.advanceTimersByTime(50);
    batch.schedule();

    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("publishes a pending trailing update before teardown without a duplicate", () => {
    vi.useFakeTimers();
    let latest = "leading";
    const published: string[] = [];
    const batch = createLeadingTrailingMicrobatch(() => published.push(latest), 50);

    batch.schedule();
    latest = "pending at teardown";
    batch.schedule();
    batch.flushPending();
    batch.flushPending();
    vi.runAllTimers();

    expect(published).toEqual(["leading", "pending at teardown"]);
  });
});
