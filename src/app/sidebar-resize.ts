import type { PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";

type SidebarResizePreview = "collapsed" | "expanded";

type SidebarResizeConfig = {
  collapseWidth: number;
  minWidth: number;
  maxWidth: () => number;
  onStart: () => void;
  onEnd: (width: number) => void;
  commit?: (fn: () => void) => void;
};

export function handleSidebarResizeStart(
  event: ReactPointerEvent<HTMLDivElement>,
  currentWidth: number,
  {
    collapseWidth,
    minWidth,
    maxWidth,
    onStart,
    onEnd,
    commit = flushSync,
  }: SidebarResizeConfig,
) {
  if (event.button !== 0) return;
  event.preventDefault();
  onStart();
  const handle = event.currentTarget;
  const shell = handle.closest(".app-shell") as HTMLElement | null;
  const mainPanel = shell?.querySelector(".main-panel") as HTMLElement | null;
  const startX = event.clientX;
  const startWidth = currentWidth;
  let latestWidth = currentWidth;
  let collapsed = currentWidth === 0;

  function setPreview(preview: SidebarResizePreview) {
    shell?.setAttribute("data-sidebar-preview", preview);
  }

  setPreview(collapsed ? "collapsed" : "expanded");

  // While dragging in the resizable range the panel tracks the cursor with no
  // transition (snappy). But the snap between the min width and fully-closed
  // is a discrete jump: animate that crossing so collapsing/reopening via drag
  // tweens smoothly. The transient data-sidebar-preview attribute keeps fixed
  // agent UI on the same collapsed/expanded rules as the grid before React's
  // committed sidebar state catches up on pointer-up.
  function setSnapTransition(animate: boolean) {
    const timing = "var(--t-med) var(--ease-out)";
    if (shell)
      shell.style.transition = animate
        ? `grid-template-columns ${timing}`
        : "none";
    handle.style.transition = animate ? `left ${timing}` : "none";
    if (mainPanel)
      mainPanel.style.transition = animate ? `margin ${timing}` : "none";
  }

  function applyWidth(width: number) {
    shell?.style.setProperty("--sidebar-w-current", `${width}px`);
    // Expanded the card hugs grid column 2 (the sidebar supplies the gutter);
    // collapsed it must carry its own left gutter. Drive it here so it tweens
    // with the collapse rather than jumping when React commits on pointer-up.
    // `--main-gutter` keeps the resize bar tracking the card's left edge (so it
    // rides the white, not the gray) since the bar is positioned off it too.
    if (mainPanel)
      mainPanel.style.marginLeft = width === 0 ? "var(--sp-3)" : "0px";
    shell?.style.setProperty(
      "--main-gutter",
      width === 0 ? "var(--sp-3)" : "0px",
    );
    latestWidth = width;
  }

  function onPointerMove(moveEvent: PointerEvent) {
    const rawWidth = startWidth + moveEvent.clientX - startX;

    if (rawWidth <= collapseWidth) {
      // Below the threshold: collapse to 0. Only kick the smooth transition on
      // the crossing, because reasserting it on every pointermove cancels the
      // in-flight tween.
      if (!collapsed) {
        collapsed = true;
        setPreview("collapsed");
        setSnapTransition(true);
        applyWidth(0);
      }
      return;
    }

    const nextWidth = Math.min(maxWidth(), Math.max(minWidth, rawWidth));
    if (collapsed) {
      // Re-opening from collapsed: animate the 0 to min snap.
      collapsed = false;
      setPreview("expanded");
      setSnapTransition(true);
      applyWidth(nextWidth);
      return;
    }
    // Live resize within range: snap-follow the cursor, but don't re-assert
    // `none` (which would cancel an in-flight open tween) unless the width
    // actually moves.
    if (nextWidth !== latestWidth) {
      setPreview("expanded");
      setSnapTransition(false);
      applyWidth(nextWidth);
    }
  }

  function onPointerUp() {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    // Hand control back to React-driven styling. Commit synchronously so the
    // collapsed/expanded class (and its matching left margin) is in the DOM
    // before we drop the inline margin. Otherwise removing it would briefly
    // expose the expanded margin and flash a jump.
    shell?.style.removeProperty("transition");
    handle.style.removeProperty("transition");
    mainPanel?.style.removeProperty("transition");
    commit(() => onEnd(latestWidth));
    mainPanel?.style.removeProperty("margin-left");
    shell?.style.removeProperty("--main-gutter");
    shell?.removeAttribute("data-sidebar-preview");
  }

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp, { once: true });
}
