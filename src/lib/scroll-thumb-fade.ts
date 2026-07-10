/**
 * Recreates the native overlay scrollbar's show-while-scrolling behavior for
 * the custom webkit scrollbars on detail views (see the --thumb-alpha rules
 * in app.css). Scrollbar parts ignore CSS transitions, so the fade is driven
 * by stepping the --thumb-alpha custom property each frame, and the paint is
 * gated on data-scrollbar-active so WebKit reliably repaints the part.
 */

/** Thumb opacity while scrolling, in color-mix percent of muted-foreground. */
const VISIBLE_ALPHA = 30;
/** Fade-in duration — quick, so the thumb tracks the first scroll tick. */
const SHOW_MS = 100;
/** Fade-out duration — quick, so the thumb gets out of the way. */
const HIDE_MS = 200;
/** How long after the last scroll event the thumb starts fading out. */
const IDLE_MS = 400;

export type ScrollThumbFadeOptions = {
  /** Fade-out duration; defaults to the shared 200ms dissolve. */
  hideMs?: number;
  /** Idle delay before the fade-out starts; defaults to 400ms. */
  idleMs?: number;
};

/**
 * Fade `el`'s scrollbar thumb in on scroll or pointer activity and back out
 * after a beat of idleness. Returns a cleanup function. Callers with special
 * pacing needs can override the fade-out timings.
 */
export function attachScrollThumbFade(
  el: HTMLElement,
  { hideMs = HIDE_MS, idleMs = IDLE_MS }: ScrollThumbFadeOptions = {},
): () => void {
  let alpha = 0;
  let target = 0;
  let rate = 0; // alpha units per ms
  let frame = 0;
  let idleTimer = 0;
  let lastTick = 0;

  const step = (now: number) => {
    frame = 0;
    const elapsed = Math.max(now - lastTick, 1);
    lastTick = now;
    alpha =
      target > alpha
        ? Math.min(target, alpha + rate * elapsed)
        : Math.max(target, alpha - rate * elapsed);
    el.style.setProperty("--thumb-alpha", alpha.toFixed(1));
    if (alpha !== target) {
      frame = requestAnimationFrame(step);
      return;
    }

    if (target === 0) delete el.dataset.scrollbarActive;
  };

  const animateTo = (next: number, durationMs: number) => {
    target = next;
    rate = VISIBLE_ALPHA / durationMs;
    if (target > 0) el.dataset.scrollbarActive = "true";
    if (!frame && alpha !== target) {
      lastTick = performance.now();
      frame = requestAnimationFrame(step);
    }
  };

  // While the pointer rests over the scroller the thumb holds steady —
  // arming the idle fade-out under a hovering pointer would blink the thumb
  // in and out on every stray hand movement. The idle timer only runs for
  // non-hover activity (keyboard-driven scrolls, focus moves).
  let hovering = false;

  const show = () => {
    animateTo(VISIBLE_ALPHA, SHOW_MS);
    window.clearTimeout(idleTimer);
    if (!hovering) {
      idleTimer = window.setTimeout(() => animateTo(0, hideMs), idleMs);
    }
  };

  const hide = () => {
    window.clearTimeout(idleTimer);
    animateTo(0, hideMs);
  };

  const enter = () => {
    hovering = true;
    show();
  };

  const leave = () => {
    hovering = false;
    hide();
  };

  const activityOptions = { passive: true, capture: true };

  el.addEventListener("scroll", show, { passive: true });
  el.addEventListener("wheel", show, activityOptions);
  el.addEventListener("touchmove", show, activityOptions);
  el.addEventListener("pointerenter", enter, { passive: true });
  el.addEventListener("mouseenter", enter, { passive: true });
  el.addEventListener("pointerleave", leave, { passive: true });
  el.addEventListener("mouseleave", leave, { passive: true });
  el.addEventListener("focusin", show);
  el.addEventListener("focusout", hide);
  return () => {
    el.removeEventListener("scroll", show);
    el.removeEventListener("wheel", show, activityOptions);
    el.removeEventListener("touchmove", show, activityOptions);
    el.removeEventListener("pointerenter", enter);
    el.removeEventListener("mouseenter", enter);
    el.removeEventListener("pointerleave", leave);
    el.removeEventListener("mouseleave", leave);
    el.removeEventListener("focusin", show);
    el.removeEventListener("focusout", hide);
    window.clearTimeout(idleTimer);
    if (frame) cancelAnimationFrame(frame);
    el.style.removeProperty("--thumb-alpha");
    delete el.dataset.scrollbarActive;
  };
}
