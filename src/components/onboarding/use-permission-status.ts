import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseDictationHelperEvent } from "../../lib/dictation-events";
import {
  checkRecordingSourceReadiness,
  dictationHelperCommand,
} from "../../lib/tauri";

export type PermissionStatuses = {
  /** AVCaptureDevice vocabulary: "granted" | "denied" | "restricted" | "undetermined". */
  microphone?: string;
  /** AXIsProcessTrusted, surfaced as "granted" | "missing". */
  accessibility?: string;
  /** True after the helper has emitted at least one permission snapshot. */
  checked: boolean;
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
export type SystemAudioStatus =
  | "unknown"
  | "probing"
  | "granted"
  | "denied"
  | "unsupported";

/**
 * System-audio permission state for the onboarding wizard.
 *
 * There is no query-only macOS API for the system-audio TCC entry, so the
 * only way to learn the state is to run the capture-helper preflight
 * (checkRecordingSourceReadiness) — on a fresh install that probe is also
 * what surfaces the native "record system audio" prompt. Running it here,
 * on the permissions screen, is the point: the user just read why we're
 * asking, instead of getting hit with the dialog after onboarding ends.
 */
export function useSystemAudioStatus(active: boolean): {
  status: SystemAudioStatus;
  probe: () => void;
} {
  const demoEnabled = browserOnboardingDemoEnabled();
  const [status, setStatus] = useState<SystemAudioStatus>(
    demoEnabled ? "granted" : "unknown",
  );
  const statusRef = useRef(status);
  statusRef.current = status;
  const inflightRef = useRef(false);

  const probe = useCallback(() => {
    if (demoEnabled) return;
    if (inflightRef.current) return;
    inflightRef.current = true;
    // Only the first probe shows the pending row; re-probes after a denial
    // keep the settled state until the new verdict lands, so the System
    // Settings hint doesn't flicker away on every window focus.
    setStatus((prev) => (prev === "unknown" ? "probing" : prev));
    checkRecordingSourceReadiness("microphonePlusSystem")
      .then((readiness) => {
        const system = readiness.sources.find(
          (source) => source.source === "system",
        );
        if (!system || system.permissionState === "unsupported") {
          setStatus("unsupported");
        } else if (system.permissionState === "granted") {
          setStatus("granted");
        } else if (
          system.permissionState === "denied" ||
          system.permissionState === "restricted"
        ) {
          setStatus("denied");
        } else {
          setStatus(system.ready ? "granted" : "unknown");
        }
      })
      .catch(() => {
        // IPC failure, not a TCC verdict; back to unknown so the row's
        // Allow button can retry.
        setStatus((prev) => (prev === "probing" ? "unknown" : prev));
      })
      .finally(() => {
        inflightRef.current = false;
      });
  }, [demoEnabled]);

  useEffect(() => {
    if (!active || statusRef.current !== "unknown") return;
    probe();
  }, [active, probe]);

  // A denial is recoverable in System Settings; re-probe when the user
  // comes back to the window. TCC is determined by then, so this never
  // re-prompts — it just notices a flipped toggle.
  useEffect(() => {
    if (!active) return;
    function onFocus() {
      if (statusRef.current === "denied") probe();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, probe]);

  return { status, probe };
}

export function usePermissionStatuses(active: boolean): PermissionStatuses {
  const demoEnabled = browserOnboardingDemoEnabled();
  const [statuses, setStatuses] = useState<PermissionStatuses>({
    checked: demoEnabled,
    microphone: demoEnabled ? "granted" : undefined,
    accessibility: demoEnabled ? "granted" : undefined,
  });

  useEffect(() => {
    if (demoEnabled) return;
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
        checked: true,
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
  }, [demoEnabled]);

  useEffect(() => {
    if (demoEnabled) return;
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
  }, [active, demoEnabled]);

  return statuses;
}

function browserOnboardingDemoEnabled() {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  return (
    new URLSearchParams(window.location.search).get("juneDemoAccount") === "1"
  );
}
