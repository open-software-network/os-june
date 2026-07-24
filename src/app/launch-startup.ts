import { invoke } from "@tauri-apps/api/core";
import { initializeExperimentalFlags } from "../lib/experimental-flags";
import { prefetchRemainingWorkspacesAfterPaint } from "./workspace-lazy";

export const START_AFTER_FIRST_PAINT_COMMAND = "start_after_first_paint";

/**
 * Starts optional launch work only after React has had a rendering
 * opportunity. Two animation frames make the boundary explicit: React mounts
 * before the first callback, the browser paints, then the second callback
 * starts work without making any of it a first-frame prerequisite.
 */
export function scheduleLaunchWorkAfterFirstPaint() {
  let cancelled = false;
  let secondFrame: number | undefined;
  const firstFrame = window.requestAnimationFrame(() => {
    if (cancelled) return;
    secondFrame = window.requestAnimationFrame(() => {
      if (cancelled) return;
      void initializeExperimentalFlags();
      void invoke(START_AFTER_FIRST_PAINT_COMMAND).catch(() => undefined);
      prefetchRemainingWorkspacesAfterPaint();
    });
  });

  return () => {
    cancelled = true;
    window.cancelAnimationFrame(firstFrame);
    if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
  };
}
