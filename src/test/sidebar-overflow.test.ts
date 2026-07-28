import { describe, expect, it } from "vitest";
import {
  positionSidebarContextMenu,
  sidebarContextMenuAnchorIsVisible,
  sidebarContextMenuGeometryFromStyles,
} from "../components/sidebar/sidebar-context-menu";
describe("sidebar overflow containment", () => {
  const menuGeometry = { viewportInset: 8, anchorGap: 4 };

  it("keeps a menu below its trigger when it fits", () => {
    expect(
      positionSidebarContextMenu(
        { top: 100, bottom: 128, right: 232 },
        { width: 156, height: 180 },
        { width: 800, height: 600 },
        menuGeometry,
      ),
    ).toEqual({ right: 568, top: 132 });
  });

  it("flips a menu above a trigger near the viewport floor", () => {
    expect(
      positionSidebarContextMenu(
        { top: 548, bottom: 576, right: 232 },
        { width: 156, height: 220 },
        { width: 800, height: 600 },
        menuGeometry,
      ),
    ).toEqual({ right: 568, top: 324 });
  });

  it("re-clamps an open menu when the viewport contracts", () => {
    const menu = { width: 156, height: 220 };

    expect(
      positionSidebarContextMenu(
        { top: 548, bottom: 576, right: 792 },
        menu,
        {
          width: 900,
          height: 620,
        },
        menuGeometry,
      ),
    ).toEqual({ right: 108, top: 324 });
    expect(
      positionSidebarContextMenu(
        { top: 348, bottom: 376, right: 232 },
        menu,
        {
          width: 640,
          height: 420,
        },
        menuGeometry,
      ),
    ).toEqual({ right: 408, top: 124 });
  });

  it("reads context-menu geometry from shared spacing tokens", () => {
    const values = new Map([
      ["--sp-3", "8px"],
      ["--sp-1", "4px"],
    ]);

    expect(
      sidebarContextMenuGeometryFromStyles({
        getPropertyValue: (property) => values.get(property) ?? "",
      }),
    ).toEqual(menuGeometry);
  });

  it("detects when scrolling moves a menu trigger outside the viewport", () => {
    const viewport = { width: 900, height: 620 };

    expect(
      sidebarContextMenuAnchorIsVisible({ top: 550, bottom: 572, left: 206, right: 228 }, viewport),
    ).toBe(true);
    expect(
      sidebarContextMenuAnchorIsVisible({ top: -40, bottom: -18, left: 206, right: 228 }, viewport),
    ).toBe(false);
  });

  it("detects when a scrollport clips a trigger that remains in the viewport", () => {
    const viewport = { width: 900, height: 620 };
    const scrollport = { top: 200, bottom: 500, left: 8, right: 232 };

    expect(
      sidebarContextMenuAnchorIsVisible(
        { top: 300, bottom: 322, left: 206, right: 228 },
        viewport,
        [scrollport],
      ),
    ).toBe(true);
    expect(
      sidebarContextMenuAnchorIsVisible(
        { top: 150, bottom: 172, left: 206, right: 228 },
        viewport,
        [scrollport],
      ),
    ).toBe(false);
    expect(
      sidebarContextMenuAnchorIsVisible(
        { top: 190, bottom: 212, left: 206, right: 228 },
        viewport,
        [scrollport],
      ),
    ).toBe(false);
  });
});
