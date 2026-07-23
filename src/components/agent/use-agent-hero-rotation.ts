import { useEffect } from "react";
import {
  AGENT_SHORTCUTS,
  HERO_CHIP_SWAP_MS,
  HERO_ROTATE_MS,
  HERO_SHORTCUT_COUNT,
} from "./agent-workspace-config";
import type { useAgentHeroRotationDependencies } from "./use-agent-hero-rotation-types";

export function useAgentHeroRotation(dependencies: useAgentHeroRotationDependencies) {
  const { draftRef, heroChipsHoverRef, heroMode, setHeroChipPhase, setHeroDeckStart } =
    dependencies;

  useEffect(() => {
    if (!heroMode) return;
    // matchMedia is feature-checked for jsdom, which doesn't implement it.
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    let swapTimeout: number | undefined;
    const interval = window.setInterval(() => {
      if (document.hidden || heroChipsHoverRef.current) return;
      if (draftRef.current.trim()) return;
      setHeroChipPhase("out");
      swapTimeout = window.setTimeout(() => {
        setHeroDeckStart((start) => (start + HERO_SHORTCUT_COUNT) % AGENT_SHORTCUTS.length);
        // Two frames so the incoming chips paint hidden (phase still "out")
        // before the fade-in transition has a start state to run from.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => setHeroChipPhase("in"));
        });
      }, HERO_CHIP_SWAP_MS);
    }, HERO_ROTATE_MS);
    return () => {
      window.clearInterval(interval);
      if (swapTimeout !== undefined) window.clearTimeout(swapTimeout);
    };
  }, [heroMode]);
}
