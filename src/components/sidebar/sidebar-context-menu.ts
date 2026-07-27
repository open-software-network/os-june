export type SidebarContextMenuAnchor = Pick<DOMRect, "top" | "bottom" | "right">;

type MenuSize = {
  width: number;
  height: number;
};

type ViewportSize = {
  width: number;
  height: number;
};

const VIEWPORT_INSET = 8;
const ANCHOR_GAP = 4;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
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
): { right: number; top: number } {
  const maximumRight = Math.max(VIEWPORT_INSET, viewport.width - menu.width - VIEWPORT_INSET);
  const right = clamp(viewport.width - anchor.right, VIEWPORT_INSET, maximumRight);
  const maximumTop = Math.max(VIEWPORT_INSET, viewport.height - menu.height - VIEWPORT_INSET);
  const belowTop = anchor.bottom + ANCHOR_GAP;
  const aboveTop = anchor.top - ANCHOR_GAP - menu.height;

  if (belowTop <= maximumTop) return { right, top: belowTop };
  if (aboveTop >= VIEWPORT_INSET) return { right, top: aboveTop };
  return { right, top: clamp(belowTop, VIEWPORT_INSET, maximumTop) };
}
