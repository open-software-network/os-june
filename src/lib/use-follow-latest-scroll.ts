import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";

export const FOLLOW_LATEST_BOTTOM_THRESHOLD_PX = 48;

const PROGRAMMATIC_SCROLL_TIMEOUT_MS = 800;

type ScrollMetrics = Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">;

type UseFollowLatestScrollOptions = {
  scrollRef: RefObject<HTMLElement | null>;
  active: boolean;
  contentKey: string;
  scopeKey: string;
  followOnActivate: boolean;
};

export function isNearScrollBottom(
  scroller: ScrollMetrics,
  threshold = FOLLOW_LATEST_BOTTOM_THRESHOLD_PX,
) {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= threshold;
}

export function useFollowLatestScroll({
  scrollRef,
  active,
  contentKey,
  scopeKey,
  followOnActivate,
}: UseFollowLatestScrollOptions) {
  const shouldFollowRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimeoutRef = useRef<number>();
  const userScrollFrameRef = useRef<number>();
  const previousActiveRef = useRef(false);
  const previousContentKeyRef = useRef(contentKey);
  const previousScopeKeyRef = useRef(scopeKey);

  const clearProgrammaticScroll = useCallback(() => {
    programmaticScrollRef.current = false;
    if (programmaticScrollTimeoutRef.current !== undefined) {
      window.clearTimeout(programmaticScrollTimeoutRef.current);
      programmaticScrollTimeoutRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const scroller = scrollRef.current;
    if (!scroller) return;

    const updateStickiness = () => {
      const previousScrollTop = lastScrollTopRef.current;
      lastScrollTopRef.current = scroller.scrollTop;
      if (programmaticScrollRef.current) {
        if (scroller.scrollTop < previousScrollTop) {
          clearProgrammaticScroll();
          shouldFollowRef.current = isNearScrollBottom(scroller);
          return;
        }
        shouldFollowRef.current = true;
        if (isNearScrollBottom(scroller)) clearProgrammaticScroll();
        return;
      }
      shouldFollowRef.current = isNearScrollBottom(scroller);
    };

    const updateFromUserScroll = () => {
      clearProgrammaticScroll();
      if (userScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(userScrollFrameRef.current);
      }
      if (typeof window.requestAnimationFrame !== "function") {
        updateStickiness();
        return;
      }
      userScrollFrameRef.current = window.requestAnimationFrame(() => {
        userScrollFrameRef.current = undefined;
        updateStickiness();
      });
    };

    updateStickiness();
    scroller.addEventListener("scroll", updateStickiness, { passive: true });
    scroller.addEventListener("wheel", updateFromUserScroll, { passive: true });
    scroller.addEventListener("touchmove", updateFromUserScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", updateStickiness);
      scroller.removeEventListener("wheel", updateFromUserScroll);
      scroller.removeEventListener("touchmove", updateFromUserScroll);
      if (userScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(userScrollFrameRef.current);
        userScrollFrameRef.current = undefined;
      }
      clearProgrammaticScroll();
    };
  }, [active, clearProgrammaticScroll, scrollRef]);

  useEffect(() => {
    const scroller = scrollRef.current;
    const scopeChanged = previousScopeKeyRef.current !== scopeKey;
    const justActivated = active && !previousActiveRef.current;
    const contentChanged = !scopeChanged && previousContentKeyRef.current !== contentKey;

    previousActiveRef.current = active;
    previousContentKeyRef.current = contentKey;
    previousScopeKeyRef.current = scopeKey;

    if (scopeChanged) {
      shouldFollowRef.current = scroller ? isNearScrollBottom(scroller) : true;
    }
    const mustLandOnLatest = followOnActivate && (justActivated || scopeChanged);
    if (mustLandOnLatest) shouldFollowRef.current = true;
    if (!active || (!contentChanged && !mustLandOnLatest) || !shouldFollowRef.current) return;
    if (!scroller || typeof scroller.scrollTo !== "function") return;

    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      clearProgrammaticScroll();
    } else {
      lastScrollTopRef.current = scroller.scrollTop;
      programmaticScrollRef.current = true;
      if (programmaticScrollTimeoutRef.current !== undefined) {
        window.clearTimeout(programmaticScrollTimeoutRef.current);
      }
      programmaticScrollTimeoutRef.current = window.setTimeout(() => {
        programmaticScrollRef.current = false;
        shouldFollowRef.current = isNearScrollBottom(scroller);
        programmaticScrollTimeoutRef.current = undefined;
      }, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
    }

    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: reduceMotion ? "auto" : "smooth",
    });
    shouldFollowRef.current = true;
  }, [active, clearProgrammaticScroll, contentKey, followOnActivate, scopeKey, scrollRef]);
}
