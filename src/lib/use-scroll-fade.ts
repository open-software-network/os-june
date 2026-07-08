import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

/** Data attributes the scroll-fade CSS primitives (`.scroll-fade` /
 * `.scroll-fade-mask`) key off. Spread onto whichever element the fade paints
 * on — the scroller itself for the mask flavor, or the non-scrolling wrapper
 * for the contained-overlay flavor. Present only on the edges that hide
 * content, so a fade never shows when everything fits. */
export type ScrollFadeProps = {
  "data-fade-top"?: "true";
  "data-fade-bottom"?: "true";
};

export type ScrollFade = {
  top: boolean;
  bottom: boolean;
  /** Force a re-measure — call from effects that change the scroller's content
   * or size without firing a scroll (filtering a list, opening a panel). */
  update: () => void;
  props: ScrollFadeProps;
};

/**
 * Position-aware scroll edge fades. Measures a scroll container and reports
 * whether content is hidden above (`top`) or below (`bottom`) the viewport, so
 * the shared `.scroll-fade` / `.scroll-fade-mask` CSS can melt the clipped edge.
 *
 * The returned `props` carry `data-fade-top` / `data-fade-bottom`; spread them
 * onto the element the fade paints on. The hook owns the scroll listener (its
 * single source — consumers do NOT wire an `onScroll` handler) and a
 * `ResizeObserver` on the element plus its content child, re-pointed when that
 * child swaps via a `childList` `MutationObserver`, to catch content growth. All
 * listeners re-wire whenever `ref.current` changes, so conditionally mounted or
 * swapped scrollers stay covered. Consumers only spread `props` / pass the
 * `ref`; call `update()` only for data-driven changes that neither scroll nor
 * resize the element (e.g. filtering a list, opening a panel).
 */
export function useScrollFade(ref: RefObject<HTMLElement | null>): ScrollFade {
  const [fade, setFade] = useState({ top: false, bottom: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const canScroll = el.scrollHeight - el.clientHeight > 1;
    const atTop = el.scrollTop <= 1;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    setFade((prev) => {
      const top = canScroll && !atTop;
      const bottom = canScroll && !atBottom;
      // Bail when nothing changed so a scroll inside a stable region never
      // churns a re-render.
      return prev.top === top && prev.bottom === bottom ? prev : { top, bottom };
    });
  }, [ref]);

  // Re-wire whenever the observed element changes identity. Runs every render
  // but guards on element identity, so it only does work on mount, unmount, and
  // an actual swap (e.g. a panel that flips between two scrollers).
  const observedRef = useRef<HTMLElement | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === observedRef.current) return;
    teardownRef.current?.();
    observedRef.current = el;
    if (!el) {
      teardownRef.current = null;
      return;
    }
    const frame = requestAnimationFrame(update);
    el.addEventListener("scroll", update, { passive: true });
    let observer: ResizeObserver | undefined;
    let observedChild: Element | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update);
      observer.observe(el);
      observedChild = el.firstElementChild;
      if (observedChild) observer.observe(observedChild);
    }
    // Re-point the ResizeObserver when the scroller swaps its content child
    // (e.g. an empty/loading body replaced by the real list). Watch only direct
    // children — not the subtree — to stay cheap for large lists.
    let mutationObserver: MutationObserver | undefined;
    if (typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(() => {
        const nextChild = el.firstElementChild;
        if (nextChild === observedChild) return;
        if (observer) {
          if (observedChild) observer.unobserve(observedChild);
          if (nextChild) observer.observe(nextChild);
        }
        observedChild = nextChild;
        update();
      });
      mutationObserver.observe(el, { childList: true });
    }
    teardownRef.current = () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", update);
      observer?.disconnect();
      mutationObserver?.disconnect();
    };
  });

  useEffect(
    () => () => {
      teardownRef.current?.();
      teardownRef.current = null;
      observedRef.current = null;
    },
    [],
  );

  return {
    top: fade.top,
    bottom: fade.bottom,
    update,
    props: {
      "data-fade-top": fade.top ? "true" : undefined,
      "data-fade-bottom": fade.bottom ? "true" : undefined,
    },
  };
}
