import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HoverTip } from "../components/ui/HoverTip";

describe("HoverTip", () => {
  it("programmatically links the anchor to the tooltip", () => {
    render(
      <HoverTip tip="Private model with zero data retention." tabIndex={0}>
        Private mode
      </HoverTip>,
    );

    const anchor = screen.getByText("Private mode");
    fireEvent.focus(anchor);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Private model with zero data retention.");
    expect(anchor).toHaveAttribute("aria-describedby", tooltip.id);
  });

  it("preserves existing described-by references", () => {
    render(
      <>
        <span id="existing-help">Existing help</span>
        <HoverTip tip="Extra tooltip help." tabIndex={0} aria-describedby="existing-help">
          Unrestricted
        </HoverTip>
      </>,
    );

    const anchor = screen.getByText("Unrestricted");
    fireEvent.focus(anchor);

    const tooltip = screen.getByRole("tooltip");
    expect(anchor.getAttribute("aria-describedby")?.split(" ")).toEqual([
      "existing-help",
      tooltip.id,
    ]);
  });

  it("caps width to the passed value and reveals a positioned tip after the measure pass", () => {
    render(
      <HoverTip tip="Copied" compact width={104} tabIndex={0}>
        Copy
      </HoverTip>,
    );

    fireEvent.focus(screen.getByText("Copy"));

    const tooltip = screen.getByRole("tooltip");
    // width is a cap, not a fixed size, and the measure pass reveals the tip
    // rather than leaving it hidden.
    expect(tooltip.style.maxWidth).toBe("104px");
    expect(tooltip.style.width).toBe("");
    expect(tooltip).toHaveAttribute("data-state", "open");
    expect(tooltip.style.left).not.toBe("");
  });

  it("fades out on blur, then unmounts once the exit timer elapses", () => {
    vi.useFakeTimers();
    try {
      render(
        <HoverTip tip="Copied" compact tabIndex={0}>
          Copy
        </HoverTip>,
      );

      const anchor = screen.getByText("Copy");
      fireEvent.focus(anchor);
      expect(screen.getByRole("tooltip")).toHaveAttribute("data-state", "open");

      fireEvent.blur(anchor);
      // Still mounted, now fading out.
      expect(screen.getByRole("tooltip")).toHaveAttribute("data-state", "closing");

      act(() => {
        vi.runAllTimers();
      });
      expect(screen.queryByRole("tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets keyboard users tab from an interactive anchor into the portaled tip", () => {
    render(
      <HoverTip
        tip={
          <div>
            Details
            <button type="button">Show more</button>
          </div>
        }
        interactive
      >
        <button type="button">Change model</button>
      </HoverTip>,
    );

    const anchorButton = screen.getByRole("button", { name: "Change model" });
    fireEvent.focus(anchorButton);
    const tooltip = screen.getByRole("tooltip");

    fireEvent.keyDown(anchorButton, { key: "Tab" });

    expect(screen.getByRole("button", { name: "Show more" })).toHaveFocus();
    expect(tooltip).toHaveAttribute("data-state", "open");
  });

  it("remeasures interactive tips when portaled content resizes", () => {
    window.innerHeight = 240;
    window.innerWidth = 1000;
    let tooltipHeight = 40;
    let resizeCallback: ResizeObserverCallback | undefined;
    const originalResizeObserver = globalThis.ResizeObserver;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("role") === "tooltip") {
          return {
            top: 0,
            left: 0,
            right: 120,
            bottom: tooltipHeight,
            width: 120,
            height: tooltipHeight,
          } as DOMRect;
        }
        return { top: 100, left: 100, right: 132, bottom: 116, width: 32, height: 16 } as DOMRect;
      });
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const cancelRafSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    try {
      render(
        <HoverTip
          tip={
            <div>
              Description
              <button type="button">Show more</button>
            </div>
          }
          interactive
        >
          <button type="button">Change model</button>
        </HoverTip>,
      );

      fireEvent.focus(screen.getByRole("button", { name: "Change model" }));
      const tooltip = screen.getByRole("tooltip");
      expect(tooltip.style.top).toBe("122px");

      tooltipHeight = 180;
      act(() => {
        resizeCallback?.([], {} as ResizeObserver);
      });

      expect(tooltip.style.top).toBe("52px");
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
      rectSpy.mockRestore();
      rafSpy.mockRestore();
      cancelRafSpy.mockRestore();
    }
  });

  it("keeps a compact tip below the anchor near the viewport bottom when it fits", () => {
    // jsdom has no layout, so feed the geometry the measure pass reads: a short
    // anchor low in a tall-enough viewport, and a one-line tip that fits below.
    window.innerHeight = 800;
    window.innerWidth = 1000;
    const rectFor = (el: Element): DOMRect => {
      if (el instanceof HTMLElement && el.getAttribute("role") === "tooltip") {
        // Compact one-line tip: ~24px tall.
        return { top: 0, left: 0, right: 120, bottom: 24, width: 120, height: 24 } as DOMRect;
      }
      // Anchor sits 40px above the viewport floor — plenty for a 24px tip plus
      // the gap and margin, so the tip should stay below.
      return { top: 744, left: 100, right: 132, bottom: 760, width: 32, height: 16 } as DOMRect;
    };
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return rectFor(this);
      });
    try {
      render(
        <HoverTip tip="Copy message" compact width={104} tabIndex={0}>
          Copy
        </HoverTip>,
      );
      fireEvent.focus(screen.getByText("Copy"));
      expect(screen.getByRole("tooltip")).toHaveAttribute("data-side", "bottom");
    } finally {
      spy.mockRestore();
    }
  });

  it("tightens to the widest visual line, not the widest inline fragment", () => {
    window.innerHeight = 800;
    window.innerWidth = 1000;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("role") === "tooltip") {
          return { top: 0, left: 0, right: 216, bottom: 40, width: 216, height: 40 } as DOMRect;
        }
        return { top: 100, left: 100, right: 132, bottom: 116, width: 32, height: 16 } as DOMRect;
      });
    const fragment = (left: number, right: number, top: number, bottom: number) =>
      ({ left, right, top, bottom, width: right - left, height: bottom - top }) as DOMRect;
    // First visual line split into two inline fragments (plain text + inline
    // markup) spanning 10..160; second line a single 90px fragment. The widest
    // single fragment is 90px, but the widest LINE is 150px — the box must be
    // sized from the line, or one-line content would be forced to re-wrap.
    const rangeSpy = vi
      .spyOn(Range.prototype, "getClientRects")
      .mockReturnValue([
        fragment(10, 100, 0, 16),
        fragment(100, 160, 0, 16),
        fragment(10, 100, 16, 32),
      ] as unknown as DOMRectList);
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((el: Element, pseudo?: string | null) =>
        (el as HTMLElement).getAttribute?.("role") === "tooltip"
          ? ({
              paddingLeft: "6px",
              paddingRight: "6px",
              borderLeftWidth: "1px",
              borderRightWidth: "1px",
            } as CSSStyleDeclaration)
          : realGetComputedStyle(el, pseudo),
      );
    try {
      render(
        <HoverTip tip="Two-line tip with inline markup" width={216} tabIndex={0}>
          Info
        </HoverTip>,
      );
      fireEvent.focus(screen.getByText("Info"));
      // ceil(150 line span + 12 padding + 2 borders) — not 90 + 14.
      expect(screen.getByRole("tooltip").style.width).toBe("164px");
    } finally {
      rectSpy.mockRestore();
      rangeSpy.mockRestore();
      styleSpy.mockRestore();
    }
  });

  it("does not flip sides when the anchor is re-entered while the tip is open", () => {
    vi.useFakeTimers();
    // Anchor pinned so close to the viewport floor that the tip opens above it;
    // a re-hover must not teleport the visible card back below.
    window.innerHeight = 800;
    window.innerWidth = 1000;
    const rectFor = (el: Element): DOMRect => {
      if (el instanceof HTMLElement && el.getAttribute("role") === "tooltip") {
        return { top: 0, left: 0, right: 120, bottom: 200, width: 120, height: 200 } as DOMRect;
      }
      // Only 20px of room below — a 200px tip can't fit, so it flips to top.
      return { top: 764, left: 100, right: 132, bottom: 780, width: 32, height: 16 } as DOMRect;
    };
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return rectFor(this);
      });
    try {
      render(
        <HoverTip tip="A tall explainer that flips above the anchor." tabIndex={0}>
          Info
        </HoverTip>,
      );
      const anchor = screen.getByText("Info");
      fireEvent.focus(anchor);
      expect(screen.getByRole("tooltip")).toHaveAttribute("data-side", "top");

      // Fade out, then re-enter while still mounted — the side must hold.
      fireEvent.blur(anchor);
      fireEvent.focus(anchor);
      expect(screen.getByRole("tooltip")).toHaveAttribute("data-side", "top");
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps its side when the tip content changes while mounted", () => {
    // A content swap while open (e.g. "Copy message" → "Copied") re-runs the
    // measure pass with the new height; the visible card must keep the side it
    // committed to even when the new content would no longer fit there.
    window.innerHeight = 800;
    window.innerWidth = 1000;
    const rectFor = (el: HTMLElement): DOMRect => {
      if (el.getAttribute("role") === "tooltip") {
        const height = el.textContent?.includes("much longer") ? 200 : 24;
        return { top: 0, left: 0, right: 120, bottom: height, width: 120, height } as DOMRect;
      }
      // 40px below the anchor: the 24px tip fits there, the 200px one cannot.
      return { top: 744, left: 100, right: 132, bottom: 760, width: 32, height: 16 } as DOMRect;
    };
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return rectFor(this);
      });
    try {
      const { rerender } = render(
        <HoverTip tip="Copied" compact width={104} tabIndex={0}>
          Copy
        </HoverTip>,
      );
      fireEvent.focus(screen.getByText("Copy"));
      expect(screen.getByRole("tooltip")).toHaveAttribute("data-side", "bottom");

      rerender(
        <HoverTip tip="A much longer label swapped in while open" compact width={104} tabIndex={0}>
          Copy
        </HoverTip>,
      );
      expect(screen.getByRole("tooltip")).toHaveAttribute("data-side", "bottom");
    } finally {
      spy.mockRestore();
    }
  });

  it("cancels the exit when the anchor is re-entered mid-fade", () => {
    vi.useFakeTimers();
    try {
      render(
        <HoverTip tip="Copied" compact tabIndex={0}>
          Copy
        </HoverTip>,
      );

      const anchor = screen.getByText("Copy");
      fireEvent.focus(anchor);
      fireEvent.blur(anchor);
      expect(screen.getByRole("tooltip")).toHaveAttribute("data-state", "closing");

      fireEvent.focus(anchor);
      // Re-entry clears the close timer and re-asserts the open state.
      expect(screen.getByRole("tooltip")).toHaveAttribute("data-state", "open");

      act(() => {
        vi.runAllTimers();
      });
      // The stale close timer must not tear down the re-opened tip.
      expect(screen.getByRole("tooltip")).toHaveAttribute("data-state", "open");
    } finally {
      vi.useRealTimers();
    }
  });
});
