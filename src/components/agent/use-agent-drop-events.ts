import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import type { TauriFileDropPayload } from "./agent-session-continuity";
import type { ImageSafeModeConsentEventPayload } from "./agent-workspace-models";
import type { UseAgentDropEventsDependencies } from "./use-agent-drop-events-types";

export function useAgentDropEvents(dependencies: UseAgentDropEventsDependencies) {
  const { handleAgentImageSafeModeConsentEvent, importDroppedFilePaths } = dependencies;

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const installFileDropListener = async (eventName: string) => {
      const unlisten = await listen<TauriFileDropPayload>(eventName, (event) => {
        const paths = event.payload?.paths ?? [];
        if (paths.length) {
          void importDroppedFilePaths(paths);
        }
      });
      if (disposed) {
        unlisten();
        return;
      }
      unlisteners.push(unlisten);
    };
    const installImageSafeModeConsentListener = async () => {
      const unlisten = await listen<ImageSafeModeConsentEventPayload>(
        "image-safe-mode-consent",
        (event) => {
          void handleAgentImageSafeModeConsentEvent(event.payload);
        },
      );
      if (disposed) {
        unlisten();
        return;
      }
      unlisteners.push(unlisten);
    };
    void installFileDropListener("tauri://drag-drop");
    void installFileDropListener("tauri://file-drop");
    void installImageSafeModeConsentListener();
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);
}
