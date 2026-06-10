import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { parseDictationHelperEvent } from "../../lib/dictation-events";
import { dictationHelperCommand } from "../../lib/tauri";

export type PermissionStatuses = {
  /** AVCaptureDevice vocabulary: "granted" | "denied" | "restricted" | "undetermined". */
  microphone?: string;
  /** AXIsProcessTrusted, surfaced as "granted" | "missing". */
  accessibility?: string;
};

export function isMicrophoneGranted(statuses: PermissionStatuses) {
  return statuses.microphone === "granted";
}

export function isMicrophoneDenied(statuses: PermissionStatuses) {
  return (
    statuses.microphone === "denied" || statuses.microphone === "restricted"
  );
}

export function isAccessibilityGranted(statuses: PermissionStatuses) {
  return statuses.accessibility === "granted";
}

/**
 * Live mic + accessibility permission state for the onboarding wizard.
 *
 * The dictation helper is the authoritative source for both (the Rust cpal
 * readiness probe doesn't reflect TCC denial), so this listens for its
 * `permission_status` events and, while `active`, polls
 * `get_permission_status` so a toggle flipped in System Settings shows up
 * within a beat of the user returning — onboarding stays on the permissions
 * screen the whole time, so the usual focus-refresh in App.tsx isn't
 * running yet.
 */
export function usePermissionStatuses(active: boolean): PermissionStatuses {
  const [statuses, setStatuses] = useState<PermissionStatuses>({});

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("dictation-event", (event) => {
      const helperEvent = parseDictationHelperEvent(event.payload);
      if (!helperEvent) return;
      if (
        helperEvent.type !== "permission_status" &&
        helperEvent.type !== "dictation_diagnostics"
      ) {
        return;
      }
      const microphone = helperEvent.payload?.microphone;
      const accessibility = helperEvent.payload?.accessibility;
      setStatuses((prev) => ({
        microphone:
          typeof microphone === "string" ? microphone : prev.microphone,
        accessibility:
          typeof accessibility === "string"
            ? accessibility
            : prev.accessibility,
      }));
    }).then((cleanup) => {
      if (aborted) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    function poll() {
      void dictationHelperCommand({ type: "get_permission_status" }).catch(
        () => undefined,
      );
    }
    poll();
    const interval = window.setInterval(poll, 1500);
    window.addEventListener("focus", poll);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", poll);
    };
  }, [active]);

  return statuses;
}
