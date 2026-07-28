export type SidebarContextMenuAnchor = Pick<DOMRect, "top" | "bottom" | "right">;

type MenuSize = {
  width: number;
  height: number;
};

type ViewportSize = {
  width: number;
  height: number;
};

export type SidebarContextMenuGeometry = {
  viewportInset: number;
  anchorGap: number;
};

type CssCustomPropertyReader = Pick<CSSStyleDeclaration, "getPropertyValue">;

function cssPixelValue(styles: CssCustomPropertyReader, property: string): number {
  const value = Number.parseFloat(styles.getPropertyValue(property));
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function sidebarContextMenuGeometryFromStyles(
  styles: CssCustomPropertyReader,
): SidebarContextMenuGeometry {
  return {
    viewportInset: cssPixelValue(styles, "--sp-3"),
    anchorGap: cssPixelValue(styles, "--sp-1"),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function sidebarContextMenuAnchorIsVisible(
  anchor: Pick<DOMRect, "top" | "bottom" | "left" | "right">,
  viewport: ViewportSize,
  clippingBoundaries: readonly Pick<DOMRect, "top" | "bottom" | "left" | "right">[] = [],
): boolean {
  // Layout-free environments report an all-zero rectangle. Keep the menu
  // usable there; a real sidebar action button always has measurable bounds.
  if (anchor.top === 0 && anchor.bottom === 0 && anchor.left === 0 && anchor.right === 0) {
    return true;
  }
  const insideViewport =
    anchor.bottom > 0 &&
    anchor.top < viewport.height &&
    anchor.right > 0 &&
    anchor.left < viewport.width;
  if (!insideViewport) return false;

  return clippingBoundaries.every(
    (boundary) =>
      (boundary.top === 0 &&
        boundary.bottom === 0 &&
        boundary.left === 0 &&
        boundary.right === 0) ||
      (anchor.top >= boundary.top &&
        anchor.bottom <= boundary.bottom &&
        anchor.left >= boundary.left &&
        anchor.right <= boundary.right),
  );
}

/**
 * Align a sidebar context menu to its trigger while keeping the full menu in
 * the viewport. Menus prefer opening below the trigger, then flip above when
 * the lower edge would be clipped.
 */
export function positionSidebarContextMenu(
  anchor: SidebarContextMenuAnchor,
  menu: MenuSize,
  viewport: ViewportSize,
  geometry: SidebarContextMenuGeometry,
): { right: number; top: number } {
  const { viewportInset, anchorGap } = geometry;
  const maximumRight = Math.max(viewportInset, viewport.width - menu.width - viewportInset);
  const right = clamp(viewport.width - anchor.right, viewportInset, maximumRight);
  const maximumTop = Math.max(viewportInset, viewport.height - menu.height - viewportInset);
  const belowTop = anchor.bottom + anchorGap;
  const aboveTop = anchor.top - anchorGap - menu.height;

  if (belowTop <= maximumTop) return { right, top: belowTop };
  if (aboveTop >= viewportInset) return { right, top: aboveTop };
  return { right, top: clamp(belowTop, viewportInset, maximumTop) };
}
