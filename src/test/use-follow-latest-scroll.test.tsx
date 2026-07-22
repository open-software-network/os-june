import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FOLLOW_LATEST_BOTTOM_THRESHOLD_PX,
  isNearScrollBottom,
  useFollowLatestScroll,
} from "../lib/use-follow-latest-scroll";

type HookProps = {
  active: boolean;
  contentKey: string;
  scopeKey: string;
  followOnActivate: boolean;
};

const originalMatchMedia = window.matchMedia;

function createScroller(initialScrollTop = 600) {
  let currentScrollTop = initialScrollTop;
  let currentScrollHeight = 1000;
  const element = document.createElement("div");
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => currentScrollHeight },
    clientHeight: { configurable: true, get: () => 400 },
    scrollTop: {
      configurable: true,
      get: () => currentScrollTop,
      set: (value: number) => {
        currentScrollTop = value;
      },
    },
  });
  const scrollTo = vi.fn<(options: ScrollToOptions) => void>();
  Object.defineProperty(element, "scrollTo", { configurable: true, value: scrollTo });
  document.body.append(element);
  const ref = { current: element as HTMLElement };
  return {
    element,
    ref,
    scrollTo,
    setScrollHeight(value: number) {
      currentScrollHeight = value;
    },
    setScrollTop(value: number) {
      currentScrollTop = value;
    },
  };
}

function renderFollowLatest(
  scroller: ReturnType<typeof createScroller>,
  initialProps: HookProps,
) {
  return renderHook(
    (props: HookProps) =>
      useFollowLatestScroll({
        scrollRef: scroller.ref,
        ...props,
      }),
    { initialProps },
  );
}

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
  vi.clearAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("isNearScrollBottom", () => {
  it("treats a distance of 49 pixels as outside the live edge", () => {
    expect(
      isNearScrollBottom({
        scrollHeight: 1000,
        clientHeight: 400,
        scrollTop: 551,
      }),
    ).toBe(false);
  });

  it("includes a distance of 48 pixels in the live edge", () => {
    expect(FOLLOW_LATEST_BOTTOM_THRESHOLD_PX).toBe(48);
    expect(
      isNearScrollBottom({
        scrollHeight: 1000,
        clientHeight: 400,
        scrollTop: 552,
      }),
    ).toBe(true);
  });
});

describe("useFollowLatestScroll", () => {
  const activeProps: HookProps = {
    active: true,
    contentKey: "content-1",
    scopeKey: "note-1",
    followOnActivate: false,
  };

  it("scrolls smoothly when content changes at the live edge", () => {
    const scroller = createScroller();
    const { rerender } = renderFollowLatest(scroller, activeProps);

    rerender({ ...activeProps, contentKey: "content-2" });

    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
  });

  it("pauses when the reader scrolls upward", () => {
    const scroller = createScroller();
    const { rerender } = renderFollowLatest(scroller, activeProps);

    scroller.setScrollTop(100);
    fireEvent.scroll(scroller.element);
    rerender({ ...activeProps, contentKey: "content-2" });

    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });

  it("resumes after the reader returns to the live edge", () => {
    const scroller = createScroller();
    const { rerender } = renderFollowLatest(scroller, activeProps);

    scroller.setScrollTop(100);
    fireEvent.scroll(scroller.element);
    rerender({ ...activeProps, contentKey: "content-2" });
    scroller.setScrollTop(600);
    fireEvent.scroll(scroller.element);
    rerender({ ...activeProps, contentKey: "content-3" });

    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
  });

  it("lands on latest when activated for an active recording", () => {
    const scroller = createScroller(100);
    const inactiveProps = { ...activeProps, active: false, followOnActivate: true };
    const { rerender } = renderFollowLatest(scroller, inactiveProps);

    rerender({ ...inactiveProps, active: true });

    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
  });

  it("does not move a historical transcript when activated away from the live edge", () => {
    const scroller = createScroller(100);
    const inactiveProps = { ...activeProps, active: false };
    const { rerender } = renderFollowLatest(scroller, inactiveProps);

    rerender({ ...inactiveProps, active: true });

    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });

  it("keeps following through intermediate programmatic downward scroll events", () => {
    const scroller = createScroller();
    const { rerender } = renderFollowLatest(scroller, activeProps);

    scroller.setScrollHeight(1200);
    rerender({ ...activeProps, contentKey: "content-2" });
    scroller.setScrollTop(700);
    fireEvent.scroll(scroller.element);
    rerender({ ...activeProps, contentKey: "content-3" });

    expect(scroller.scrollTo).toHaveBeenCalledTimes(2);
  });

  it("lets wheel input interrupt an in-flight programmatic glide", () => {
    const scroller = createScroller();
    const { rerender } = renderFollowLatest(scroller, activeProps);

    scroller.setScrollHeight(1200);
    rerender({ ...activeProps, contentKey: "content-2" });
    scroller.scrollTo.mockClear();
    fireEvent.wheel(scroller.element);
    scroller.setScrollTop(100);
    fireEvent.scroll(scroller.element);
    rerender({ ...activeProps, contentKey: "content-3" });

    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });

  it("uses instant scrolling when reduced motion is preferred", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as MediaQueryList,
    );
    const scroller = createScroller();
    const { rerender } = renderFollowLatest(scroller, activeProps);

    rerender({ ...activeProps, contentKey: "content-2" });

    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
  });
});
