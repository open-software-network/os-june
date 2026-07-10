import { describe, expect, it, vi } from "vitest";
import { selectPopoverHorizontalStyle } from "../components/ui/Select";

describe("selectPopoverHorizontalStyle", () => {
  it("keeps the popover aligned with its trigger when there is room", () => {
    const style = selectPopoverHorizontalStyle({ left: 400, width: 128 } as DOMRect);

    expect(style).toMatchObject({ left: 400, width: 260, minWidth: 260, maxWidth: 260 });
  });

  it("shifts a wide popover left to keep it inside a narrow window", () => {
    vi.stubGlobal("innerWidth", 560);

    try {
      const style = selectPopoverHorizontalStyle({ left: 400, width: 128 } as DOMRect);

      expect(style).toMatchObject({ left: 288, width: 260, minWidth: 260, maxWidth: 260 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a compact color picker aligned with its trigger in a narrow window", () => {
    vi.stubGlobal("innerWidth", 560);

    try {
      const style = selectPopoverHorizontalStyle({ left: 400, width: 128 } as DOMRect, 128);

      expect(style).toMatchObject({ left: 400, width: 128, minWidth: 128, maxWidth: 128 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never returns negative dimensions when the viewport is smaller than its insets", () => {
    vi.stubGlobal("innerWidth", 20);

    try {
      const style = selectPopoverHorizontalStyle({ left: 0, width: 128 } as DOMRect);

      expect(style).toMatchObject({ left: 12, width: 0, minWidth: 0, maxWidth: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
