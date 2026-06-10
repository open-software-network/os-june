import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachScrollThumbFade } from "../lib/scroll-thumb-fade";

/** Manually driven rAF so each frame's timestamp is under test control. */
function stubRaf() {
  let pending: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    pending.push(cb);
    return pending.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    pending = [];
  });
  return (timestamp: number) => {
    const cbs = pending;
    pending = [];
    for (const cb of cbs) cb(timestamp);
    return pending.length > 0;
  };
}

describe("attachScrollThumbFade", () => {
  let el: HTMLElement;
  let frame: (timestamp: number) => boolean;
  let detach: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    frame = stubRaf();
    el = document.createElement("div");
    detach = undefined;
  });

  afterEach(() => {
    detach?.();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const alpha = () => Number(el.style.getPropertyValue("--thumb-alpha"));

  it("fades the thumb in on scroll and back out after the idle delay", () => {
    detach = attachScrollThumbFade(el);

    el.dispatchEvent(new Event("scroll"));
    frame(50); // halfway through the 100ms fade-in
    expect(alpha()).toBeGreaterThan(0);
    expect(alpha()).toBeLessThan(30);
    while (frame(200)); // run the animation to rest
    expect(alpha()).toBe(30);

    vi.advanceTimersByTime(800); // idle delay elapses → fade-out starts
    frame(400);
    while (frame(2000));
    expect(alpha()).toBe(0);
  });

  it("keeps the thumb visible while scrolling continues", () => {
    detach = attachScrollThumbFade(el);

    el.dispatchEvent(new Event("scroll"));
    while (frame(200));
    expect(alpha()).toBe(30);

    vi.advanceTimersByTime(500); // more scrolling before the idle delay ends
    el.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(500); // old timer would have fired by now
    expect(alpha()).toBe(30);

    vi.advanceTimersByTime(300); // full idle delay after the second scroll
    while (frame(5000));
    expect(alpha()).toBe(0);
  });

  it("cleans up the listener, timers, and property on detach", () => {
    const cleanup = attachScrollThumbFade(el);

    el.dispatchEvent(new Event("scroll"));
    while (frame(200));
    expect(alpha()).toBe(30);

    cleanup();
    expect(el.style.getPropertyValue("--thumb-alpha")).toBe("");

    el.dispatchEvent(new Event("scroll")); // detached — no longer reacts
    expect(el.style.getPropertyValue("--thumb-alpha")).toBe("");
  });
});
