import type * as React from "react";
import type { RecordingTelemetryStore } from "../lib/recording-telemetry-store";
import type { RecordingStatusDto } from "../lib/tauri";
import type { NotesAction } from "./state/app-state";

export type UseRecordingTelemetryDependencies = {
  dispatch: React.Dispatch<NotesAction>;
  recordingTelemetryStore: RecordingTelemetryStore;
  recordingStatusRef: React.MutableRefObject<RecordingStatusDto | undefined>;
};
