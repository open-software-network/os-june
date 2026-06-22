import type { PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";

type SidebarResizePreview = "collapsed" | "expanded" | "opening";

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
  const startX = event.clientX;
  const startWidth = currentWidth;
  let latestWidth = currentWidth;
  let collapsed = currentWidth === 0;
  let opening = false;
  let snapTweening = false;

  function setPreview(preview: SidebarResizePreview) {
    shell?.setAttribute("data-sidebar-preview", preview);
  }

  setPreview(collapsed ? "collapsed" : "expanded");

  // While dragging in the resizable range the panel tracks the cursor with no
  // transition (snappy). But the snap between the min width and fully-closed is
  // a discrete jump: animate that crossing so collapsing/reopening via drag
  // tweens smoothly. We animate ONE value — --sidebar-w-current (a registered
  // <length>, see tokens.css) — and let every element that reads it (the grid
  // columns, the card gutter, the resize handle, the tab strip, the floating
  // composer) ride that single clock. Animating each of them with its own
  // transition instead let them drift apart a frame at a time, which flashed the
  // tab strip during a held drag. The transient data-sidebar-preview attribute
  // keeps fixed agent UI on the collapsed/expanded rules before React's
  // committed sidebar state catches up on pointer-up.
  function setSnapTransition(animate: boolean) {
    const timing = "var(--t-med) var(--ease-out)";
    if (shell)
      shell.style.transition = animate
        ? `--sidebar-w-current ${timing}`
        : "none";
  }

  function beginSnapTransition() {
    setSnapTransition(true);
    // If the pointer is held far past the collapsed edge, the previous snap can
    // finish and remove transitions before the user drags back. Flush the
    // transition styles before changing preview/width so the first reopening
    // frame interpolates from the current width instead of jumping.
    void (shell ?? handle).offsetWidth;
  }

  // Snap tweens end on the shell's own --sidebar-w-current transition (the
  // card's margin tween bubbles through here too — hence the target check).
  // While one is in flight, pointermoves retarget it instead of switching back
  // to transition-less tracking: killing it mid-flight teleports the sidebar
  // from the interpolated width to the cursor in a single frame.
  function onSnapTweenEnd(endEvent: TransitionEvent) {
    if (
      endEvent.target !== shell ||
      endEvent.propertyName !== "--sidebar-w-current"
    )
      return;
    snapTweening = false;
    setSnapTransition(false);
  }
  shell?.addEventListener("transitionend", onSnapTweenEnd);

  function applyWidth(width: number) {
    // The single source of truth: the grid columns, the card's collapse gutter,
    // the resize handle, the tab strip and the floating composer all derive
    // their position from this one value in CSS (via max(width, gutter) calcs),
    // so setting it here moves them all together — tweened when a transition is
    // armed, instant otherwise.
    shell?.style.setProperty("--sidebar-w-current", `${width}px`);
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
        opening = false;
        beginSnapTransition();
        snapTweening = true;
        setPreview("collapsed");
        applyWidth(0);
      }
      return;
    }

    const nextWidth = Math.min(maxWidth(), Math.max(minWidth, rawWidth));
    if (collapsed) {
      // Re-opening from collapsed: animate the 0 to min snap.
      collapsed = false;
      opening = true;
      beginSnapTransition();
      snapTweening = true;
      setPreview("opening");
      applyWidth(nextWidth);
      return;
    }
    // Live resize within range: snap-follow the cursor. While a snap tween is
    // still in flight, keep it and retarget toward the cursor; transitionend
    // hands back transition-less tracking.
    if (nextWidth !== latestWidth) {
      setPreview(opening ? "opening" : "expanded");
      if (!snapTweening) setSnapTransition(false);
      applyWidth(nextWidth);
    }
  }

  function onPointerUp() {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    shell?.removeEventListener("transitionend", onSnapTweenEnd);
    // Hand control back to React-driven styling. Drop the inline snap transition
    // and commit synchronously so the collapsed/expanded state (which pins
    // --sidebar-w-current to its final value) lands in the DOM in the same
    // frame, then drop the transient preview attribute.
    shell?.style.removeProperty("transition");
    commit(() => onEnd(latestWidth));
    shell?.removeAttribute("data-sidebar-preview");
  }

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp, { once: true });
}
