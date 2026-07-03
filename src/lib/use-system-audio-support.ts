import { useEffect, useSyncExternalStore } from "react";
import type { RecordingSourceReadinessDto } from "./tauri";

export type SystemAudioSupport = "unknown" | "supported" | "unsupported";

// The remembered answer lives at module scope (the same external-store shape
// as billing-demo) so it survives component remounts: a NoteEditor or
// AppSettings instance mounted after a mic-only preflight overwrote the app's
// sourceReadiness must still know the host supports system audio, or
// navigation would hide the only way to turn it back on. Host capability
// cannot change mid-session, so the value is never reset; "unsupported" is
// exactly as sticky as "supported".
let remembered: SystemAudioSupport | null = null;
const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): SystemAudioSupport | null {
  return remembered;
}

function remember(next: SystemAudioSupport) {
  if (remembered === next) return;
  remembered = next;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Test-only: clears the module-scoped memory so vitest cases stay independent.
 * Production code never resets it (host capability is fixed for the session).
 */
export function resetSystemAudioSupportForTests() {
  remembered = null;
}

/**
 * Whether the host has a working system-audio backend, remembered across
 * readiness checks that do not cover the system source and across component
 * remounts.
 *
 * Readiness DTOs only include a system entry when the check was made for
 * sourceMode microphonePlusSystem; a microphoneOnly preflight (stored after
 * the user turns system audio off) carries no system source at all. Backend
 * capability is a property of the host, not of the last-checked mode or of
 * any one component instance, so this hook keeps the answer from the most
 * recent readiness result that did include the system source instead of
 * letting a mic-only check or a remount erase it:
 *
 * - "unknown" until any readiness result has covered the system source
 * - "supported" / "unsupported" from the most recent result that covered it
 */
export function useSystemAudioSupport(
  sourceReadiness: RecordingSourceReadinessDto | undefined,
): SystemAudioSupport {
  const systemSource = sourceReadiness?.sources.find((source) => source.source === "system");
  const latest: SystemAudioSupport | null =
    systemSource == null
      ? null
      : systemSource.permissionState === "unsupported"
        ? "unsupported"
        : "supported";
  const stored = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (latest != null) {
      remember(latest);
    }
  }, [latest]);
  // `latest` wins for the instance whose readiness covers the system source
  // right now, so a fresh answer never waits on the effect above; the store
  // covers instances whose readiness lacks the system entry.
  return latest ?? stored ?? "unknown";
}
