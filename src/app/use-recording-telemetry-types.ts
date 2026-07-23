import type * as React from "react";
import type { RecordingStatusDto } from "../lib/tauri";
import type { NotesAction } from "./state/app-state";

export type UseRecordingTelemetryDependencies = {
  dispatch: React.Dispatch<NotesAction>;
  recordingStatusRef: React.MutableRefObject<RecordingStatusDto | undefined>;
};
