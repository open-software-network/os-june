import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { RECORDING_TELEMETRY_EVENT, type RecordingTelemetryDto } from "../lib/tauri";
import { mergeRecordingTelemetry, sameRecordingSemantics } from "../lib/recording-telemetry";
import type { UseRecordingTelemetryDependencies } from "./use-recording-telemetry-types";

export function useRecordingTelemetry(dependencies: UseRecordingTelemetryDependencies) {
  const { dispatch, recordingTelemetryStore, recordingStatusRef } = dependencies;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let aborted = false;
    void listen<RecordingTelemetryDto>(RECORDING_TELEMETRY_EVENT, (event) => {
      const current = recordingStatusRef.current;
      if (!current || event.payload.sessionId !== current.sessionId) {
        return;
      }
      const next = mergeRecordingTelemetry(current, event.payload);
      recordingStatusRef.current = next;
      recordingTelemetryStore.setStatus(next);
      if (next && !sameRecordingSemantics(current, next)) {
        dispatch({ type: "recordingStatusChanged", status: next });
      } else if (!next) {
        dispatch({ type: "recordingSessionLost", sessionId: event.payload.sessionId });
      }
    }).then((cleanup) => {
      if (aborted) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, [dispatch, recordingStatusRef, recordingTelemetryStore]);
}
