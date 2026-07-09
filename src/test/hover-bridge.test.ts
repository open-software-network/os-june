import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHoverBridgeTracker,
  type HoverBridgeRect,
  pointInRect,
  rectFromElement,
} from "../components/ui/hoverBridge";

// A trigger row on the left and its card to the right, with a wide gap between
// them — the canonical "safe triangle" layout the tracker guards.
const TRIGGER: HoverBridgeRect = { top: 100, bottom: 120, left: 0, right: 100 };
const FLOATING: HoverBridgeRect = { top: 80, bottom: 200, left: 200, right: 400 };
// Pointer leaving the row's right edge, mid-height.
const EXIT = { x: 100, y: 110 };

afterEach(() => {
  vi.useRealTimers();
});

describe("pointInRect", () => {
  it("treats the edges as inside and honours padding", () => {
    expect(pointInRect({ x: 0, y: 100 }, TRIGGER)).toBe(true);
    expect(pointInRect({ x: 100, y: 120 }, TRIGGER)).toBe(true);
    expect(pointInRect({ x: 105, y: 110 }, TRIGGER)).toBe(false);
    expect(pointInRect({ x: 105, y: 110 }, TRIGGER, 6)).toBe(true);
  });
});

describe("rectFromElement", () => {
  it("copies the four edges off getBoundingClientRect", () => {
    const element = {
      getBoundingClientRect: () => ({ top: 1, right: 2, bottom: 3, left: 4 }),
    } as unknown as Element;
    expect(rectFromElement(element)).toEqual({ top: 1, right: 2, bottom: 3, left: 4 });
  });
});

describe("createHoverBridgeTracker", () => {
  it("is inactive until begin and inactive again after stop", () => {
    const tracker = createHoverBridgeTracker();
    expect(tracker.isActive()).toBe(false);
    tracker.begin(EXIT, TRIGGER, FLOATING, "right");
    expect(tracker.isActive()).toBe(true);
    tracker.stop();
    expect(tracker.isActive()).toBe(false);
  });

  it("holds the bridge for a point inside the wedge that closes on the card", () => {
    const tracker = createHoverBridgeTracker();
    tracker.begin(EXIT, TRIGGER, FLOATING, "right");
    // Halfway to the card, still within the fanning wedge.
    expect(tracker.update({ x: 150, y: 110 })).toBe(true);
    expect(tracker.isActive()).toBe(true);
  });

  it("drops the bridge for a point outside the wedge", () => {
    const tracker = createHoverBridgeTracker();
    tracker.begin(EXIT, TRIGGER, FLOATING, "right");
    // Well above the wedge's upper edge at that x.
    expect(tracker.update({ x: 150, y: 40 })).toBe(false);
    expect(tracker.isActive()).toBe(false);
  });

  it("holds the bridge when the pointer lands back on the card", () => {
    const tracker = createHoverBridgeTracker();
    tracker.begin(EXIT, TRIGGER, FLOATING, "right");
    expect(tracker.update({ x: 300, y: 150 })).toBe(true);
    expect(tracker.isActive()).toBe(true);
  });

  it("fires onExpire with the last point when the pointer stalls in the wedge", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const tracker = createHoverBridgeTracker({ stallMs: 200, onExpire });
    tracker.begin(EXIT, TRIGGER, FLOATING, "right");
    // No further movement: the stall clock runs out and hands hover back.
    vi.advanceTimersByTime(200);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire).toHaveBeenCalledWith(EXIT);
    expect(tracker.isActive()).toBe(false);
  });

  it("restarts the stall clock while the pointer keeps closing on the card", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const tracker = createHoverBridgeTracker({ stallMs: 200, onExpire });
    tracker.begin(EXIT, TRIGGER, FLOATING, "right");
    vi.advanceTimersByTime(150);
    // Progress toward the card re-arms the clock, so the original expiry is cancelled.
    expect(tracker.update({ x: 160, y: 110 })).toBe(true);
    vi.advanceTimersByTime(150);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending stall expiry on stop", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const tracker = createHoverBridgeTracker({ stallMs: 200, onExpire });
    tracker.begin(EXIT, TRIGGER, FLOATING, "right");
    tracker.stop();
    vi.advanceTimersByTime(500);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
