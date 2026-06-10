/**
 * Recreates the native overlay scrollbar's show-while-scrolling behavior for
 * the custom webkit scrollbars on breadcrumb views (see the --thumb-alpha
 * rules in app.css). Scrollbar parts ignore CSS transitions, so the fade is
 * driven by stepping the --thumb-alpha custom property each frame — engines
 * repaint the thumb on custom-property changes.
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
    if (alpha !== target) frame = requestAnimationFrame(step);
  };

  const animateTo = (next: number, durationMs: number) => {
    target = next;
    rate = VISIBLE_ALPHA / durationMs;
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

  el.addEventListener("scroll", show, { passive: true });
  el.addEventListener("pointerenter", show, { passive: true });
  el.addEventListener("pointermove", show, { passive: true });
  el.addEventListener("pointerleave", hide, { passive: true });
  el.addEventListener("focusin", show);
  el.addEventListener("focusout", hide);
  return () => {
    el.removeEventListener("scroll", show);
    el.removeEventListener("pointerenter", show);
    el.removeEventListener("pointermove", show);
    el.removeEventListener("pointerleave", hide);
    el.removeEventListener("focusin", show);
    el.removeEventListener("focusout", hide);
    window.clearTimeout(idleTimer);
    if (frame) cancelAnimationFrame(frame);
    el.style.removeProperty("--thumb-alpha");
  };
}
