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

/** Compare only the recording facts broad app state is responsible for.
 * Elapsed time and levels belong to the narrow telemetry store; lifecycle,
 * Source health, and actionable warnings still publish through the reducer. */
export function sameRecordingSemantics(current: RecordingStatusDto, next: RecordingStatusDto) {
  return (
    current.sessionId === next.sessionId &&
    current.state === next.state &&
    current.silenceWarning === next.silenceWarning &&
    sameSourceSemantics(current.sources, next.sources) &&
    sameWarnings(current.warnings, next.warnings)
  );
}

function sameSourceSemantics(
  current: SourceStatusDto[] | undefined,
  next: SourceStatusDto[] | undefined,
) {
  if (current === next) return true;
  if ((current?.length ?? 0) !== (next?.length ?? 0)) return false;
  return (current ?? []).every((source, index) => {
    const candidate = next?.[index];
    return (
      source.source === candidate?.source &&
      source.state === candidate.state &&
      source.silenceWarning === candidate.silenceWarning
    );
  });
}

function sameWarnings(
  current: RecordingStatusDto["warnings"],
  next: RecordingStatusDto["warnings"],
) {
  if (current === next) return true;
  if ((current?.length ?? 0) !== (next?.length ?? 0)) return false;
  return (current ?? []).every((warning, index) => {
    const candidate = next?.[index];
    return (
      warning.source === candidate?.source &&
      warning.code === candidate.code &&
      warning.message === candidate.message
    );
  });
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
