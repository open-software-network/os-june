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
