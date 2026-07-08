import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useScrollFade } from "../lib/use-scroll-fade";

/** Build a detached element with fake scroll metrics and a ref pointing at it,
 * mirroring how the fade components measure a real scroll viewport. */
function scroller(metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  const el = document.createElement("div");
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    clientHeight: { configurable: true, value: metrics.clientHeight },
    scrollTop: { configurable: true, writable: true, value: metrics.scrollTop },
  });
  document.body.appendChild(el);
  return { el, ref: { current: el as HTMLElement } };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useScrollFade", () => {
  it("shows no fades when the content fits", () => {
    const { ref } = scroller({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 });
    const { result } = renderHook(() => useScrollFade(ref));
    act(() => result.current.update());
    expect(result.current.top).toBe(false);
    expect(result.current.bottom).toBe(false);
    expect(result.current.props["data-fade-top"]).toBeUndefined();
    expect(result.current.props["data-fade-bottom"]).toBeUndefined();
  });

  it("shows both fades when scrolled to the middle", () => {
    const { el, ref } = scroller({ scrollHeight: 300, clientHeight: 100, scrollTop: 100 });
    const { result } = renderHook(() => useScrollFade(ref));
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.top).toBe(true);
    expect(result.current.bottom).toBe(true);
    expect(result.current.props["data-fade-top"]).toBe("true");
    expect(result.current.props["data-fade-bottom"]).toBe("true");
  });

  it("shows only the bottom fade at the top of the scroll", () => {
    const { ref } = scroller({ scrollHeight: 300, clientHeight: 100, scrollTop: 0 });
    const { result } = renderHook(() => useScrollFade(ref));
    act(() => result.current.update());
    expect(result.current.top).toBe(false);
    expect(result.current.bottom).toBe(true);
  });

  it("shows only the top fade at the bottom of the scroll", () => {
    const { ref } = scroller({ scrollHeight: 300, clientHeight: 100, scrollTop: 200 });
    const { result } = renderHook(() => useScrollFade(ref));
    act(() => result.current.update());
    expect(result.current.top).toBe(true);
    expect(result.current.bottom).toBe(false);
  });
});
