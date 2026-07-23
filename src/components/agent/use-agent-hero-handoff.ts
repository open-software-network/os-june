import { useLayoutEffect } from "react";
import type { UseAgentHeroHandoffDependencies } from "./use-agent-hero-handoff-types";

export function useAgentHeroHandoff(dependencies: UseAgentHeroHandoffDependencies) {
  const {
    composerBoxRef,
    heroExitRectRef,
    heroExitViaThreadRef,
    heroMode,
    listRef,
    prevHeroModeRef,
  } = dependencies;

  useLayoutEffect(() => {
    const wasHero = prevHeroModeRef.current;
    prevHeroModeRef.current = heroMode;
    const box = composerBoxRef.current;
    if (!box) return;
    if (heroMode) {
      heroExitRectRef.current = box.getBoundingClientRect();
      // Clear any stale intent while the hero is up so a sidebar dismissal
      // can't inherit a glide armed by an earlier (failed) submit.
      heroExitViaThreadRef.current = false;
      return;
    }
    const prev = heroExitRectRef.current;
    heroExitRectRef.current = null;
    if (!wasHero || !prev) return;
    // Only glide when the hero handed over to a fresh thread. Leaving the hero
    // because the user opened an existing chat should swap in place.
    const viaThread = heroExitViaThreadRef.current;
    heroExitViaThreadRef.current = false;
    if (!viaThread) return;
    if (
      typeof box.animate !== "function" ||
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    ) {
      return;
    }
    // The timeline's rise-and-fade belongs to this same handoff, so it runs
    // here rather than as a CSS mount animation — as CSS it replayed on every
    // timeline mount, nudging the conversation upward when merely opening an
    // existing chat from the hero (or returning from another view).
    listRef.current?.animate(
      [
        { opacity: 0, transform: "translateY(10px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      // Backwards fill so a slow frame can't paint the timeline at rest
      // before the first animation frame applies (the CSS original filled
      // backwards for the same reason).
      {
        duration: 280,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)", // --ease-out
        fill: "backwards",
      },
    );
    const next = box.getBoundingClientRect();
    const dx = prev.left - next.left;
    const dy = prev.top - next.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    box.animate(
      [
        {
          transform: `translate(${dx}px, ${dy}px)`,
          width: `${prev.width}px`,
          height: `${prev.height}px`,
        },
        {
          transform: "translate(0, 0)",
          width: `${next.width}px`,
          height: `${next.height}px`,
        },
      ],
      { duration: 360, easing: "cubic-bezier(0.32, 0.72, 0, 1)" }, // --ease-spring
    );
  });
}
