/**
 * Recreates the native overlay scrollbar's show-while-scrolling behavior for
 * the custom webkit scrollbars on detail views (see the --thumb-alpha rules
 * in app.css). Scrollbar parts ignore CSS transitions, so the fade is driven
 * by stepping the --thumb-alpha custom property each frame. The helper also
 * toggles data-scrollbar-active so WebKit repaints the scrollbar part when the
 * pointer is over content rather than directly over the scrollbar gutter.
 */

/** Thumb opacity while scrolling, in color-mix percent of muted-foreground. */
const VISIBLE_ALPHA = 30;
/** Fade-in duration — quick, so the thumb tracks the first scroll tick. */
const SHOW_MS = 100;
/** Fade-out duration — a softer dissolve, like the native overlay. */
const HIDE_MS = 450;
/** How long after the last scroll event the thumb starts fading out. */
const IDLE_MS = 800;

/**
 * Fade `el`'s scrollbar thumb in on scroll or pointer activity and back out
 * after a beat of idleness. Returns a cleanup function.
 */
export function attachScrollThumbFade(el: HTMLElement): () => void {
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

  const show = () => {
    animateTo(VISIBLE_ALPHA, SHOW_MS);
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => animateTo(0, HIDE_MS), IDLE_MS);
  };

  const hide = () => {
    window.clearTimeout(idleTimer);
    animateTo(0, HIDE_MS);
  };

  const activityOptions = { passive: true, capture: true };

  el.addEventListener("scroll", show, { passive: true });
  el.addEventListener("wheel", show, activityOptions);
  el.addEventListener("touchmove", show, activityOptions);
  el.addEventListener("pointerenter", show, { passive: true });
  el.addEventListener("pointermove", show, activityOptions);
  el.addEventListener("mouseenter", show, { passive: true });
  el.addEventListener("mousemove", show, activityOptions);
  el.addEventListener("pointerleave", hide, { passive: true });
  el.addEventListener("mouseleave", hide, { passive: true });
  el.addEventListener("focusin", show);
  el.addEventListener("focusout", hide);
  return () => {
    el.removeEventListener("scroll", show);
    el.removeEventListener("wheel", show, activityOptions);
    el.removeEventListener("touchmove", show, activityOptions);
    el.removeEventListener("pointerenter", show);
    el.removeEventListener("pointermove", show, activityOptions);
    el.removeEventListener("mouseenter", show);
    el.removeEventListener("mousemove", show, activityOptions);
    el.removeEventListener("pointerleave", hide);
    el.removeEventListener("mouseleave", hide);
    el.removeEventListener("focusin", show);
    el.removeEventListener("focusout", hide);
    window.clearTimeout(idleTimer);
    if (frame) cancelAnimationFrame(frame);
    el.style.removeProperty("--thumb-alpha");
    delete el.dataset.scrollbarActive;
  };
}
