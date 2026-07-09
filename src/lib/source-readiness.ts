import type { RecordingSourceReadinessDto } from "./tauri";

/**
 * A microphone-only readiness check never assesses system audio: it skips the
 * capture helper's permission preflight, so its system source reports whether
 * this Mac is *capable* rather than whether the permission was granted. Keep
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
