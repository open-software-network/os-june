import type { RecordingSourceReadinessDto } from "./tauri";

export type SystemAudioAvailability =
  /** The readiness probe has not answered yet. */
  | "unknown"
  /** This device cannot capture system audio at all. */
  | "unsupported"
  /** The user declined the platform grant. */
  | "denied"
  /** The platform grant/status is usable, but capture cannot start now. */
  | "unavailable"
  | "usable";

/**
 * The single question every system-audio surface asks. `permissionState` is the
 * platform grant/status and `ready` is whether this device can actually capture;
 * neither answers on its own, and a granted source can still be uncapturable.
 * Offering the user a control June cannot honor is the bug this collapses.
 */
export function systemAudioAvailability(
  readiness: RecordingSourceReadinessDto | undefined,
): SystemAudioAvailability {
  if (!readiness) return "unknown";
  const system = readiness.sources.find((source) => source.source === "system");
  if (!system || system.permissionState === "unsupported") return "unsupported";
  if (system.permissionState === "denied" || system.permissionState === "restricted") {
    return "denied";
  }
  if (!system.ready) return "unavailable";
  return "usable";
}

/**
 * A microphone-only readiness check never assesses system audio: it skips the
 * system-audio preflight, so its system source reports whether this device is
 * *capable* rather than whether the platform grant/status was established. Keep
 * the source last assessed by a microphone-plus-system check instead of
 * overwriting it with that weaker signal.
 */
export function mergeSourceReadiness(
  previous: RecordingSourceReadinessDto | undefined,
  next: RecordingSourceReadinessDto,
): RecordingSourceReadinessDto {
  if (next.sourceMode === "microphonePlusSystem") return next;
  const assessed = previous?.sources.find((source) => source.source === "system");
  if (!assessed) return next;
  return {
    ...next,
    sources: next.sources.map((source) =>
      source.source === "system" ? { ...assessed, required: source.required } : source,
    ),
  };
}
