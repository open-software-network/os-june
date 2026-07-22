import type {
  RecordingSourceTelemetryDto,
  RecordingStatusDto,
  RecordingTelemetryDto,
  SourceStatusDto,
} from "./tauri";

/** Merge the narrow native stream into the command snapshot that owns stable
 * recording metadata. An idle sample means the native session disappeared. */
export function mergeRecordingTelemetry(
  current: RecordingStatusDto,
  telemetry: RecordingTelemetryDto,
): RecordingStatusDto | undefined {
  if (current.sessionId !== telemetry.sessionId) {
    return current;
  }
  if (telemetry.state === "idle") {
    return undefined;
  }
  return {
    ...current,
    state: telemetry.state,
    elapsedMs: telemetry.elapsedMs,
    level: telemetry.level,
    silenceWarning: telemetry.silenceWarning,
    sources: mergeSourceTelemetry(current.sources, telemetry.sources),
    warnings: telemetry.warnings,
  };
}

function mergeSourceTelemetry(
  current: SourceStatusDto[] | undefined,
  telemetry: RecordingSourceTelemetryDto[],
) {
  if (telemetry.length === 0) {
    return current;
  }
  return telemetry.map((source) => {
    const existing = current?.find((candidate) => candidate.source === source.source);
    return {
      ...existing,
      ...source,
      bytesWritten: existing?.bytesWritten ?? 0,
      pathFinalized: existing?.pathFinalized ?? false,
    };
  });
}
