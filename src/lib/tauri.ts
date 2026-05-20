import { invoke } from "@tauri-apps/api/core";

export type ProcessingStatus =
  | "draft"
  | "recording"
  | "validating"
  | "transcribing"
  | "generating"
  | "ready"
  | "failed"
  | "recoverable";

export type FolderDto = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type NoteListItemDto = {
  id: string;
  title: string;
  preview: string;
  processingStatus: ProcessingStatus;
  folderIds: string[];
  createdAt: string;
  updatedAt: string;
  durationMs?: number;
};

export type TranscriptDto = {
  id: string;
  text: string;
  sourceMode?: RecordingSourceMode;
  source?: RecordingSource;
  language?: string;
  status: "pending" | "running" | "succeeded" | "failed";
  lastError?: string;
};

export type AudioLevelDto = {
  peak: number;
  rms: number;
  recentPeaks: number[];
};

export type RecordingState =
  | "idle"
  | "permissionDenied"
  | "starting"
  | "recording"
  | "paused"
  | "finalizing"
  | "validating"
  | "partiallyValid"
  | "invalid"
  | "ready"
  | "failed"
  | "recoverable";

export type RecordingSourceMode = "microphoneOnly" | "microphonePlusSystem";
export type RecordingSource = "microphone" | "system";

export type SourceState =
  | "pending"
  | "permissionDenied"
  | "unavailable"
  | "starting"
  | "recording"
  | "paused"
  | "finalizing"
  | "finalized"
  | "valid"
  | "invalid"
  | "recoverable"
  | "failed";

export type SourceStatusDto = {
  source: RecordingSource;
  state: SourceState;
  elapsedMs: number;
  bytesWritten: number;
  level: AudioLevelDto;
  silenceWarning: boolean;
  pathFinalized: boolean;
  lastError?: string;
};

export type SourceWarningDto = {
  source: RecordingSource;
  code: string;
  message: string;
};

export type RecordingStatusDto = {
  sessionId: string;
  sourceMode?: RecordingSourceMode;
  state: RecordingState;
  elapsedMs: number;
  level: AudioLevelDto;
  silenceWarning: boolean;
  bytesWritten: number;
  sources?: SourceStatusDto[];
  warnings?: SourceWarningDto[];
};

export type RecordingSessionDto = {
  id: string;
  noteId: string;
  sourceMode?: RecordingSourceMode;
  state: RecordingState;
  startedAt: string;
  elapsedMs: number;
  deviceLabel?: string;
  level: AudioLevelDto;
  sources?: SourceStatusDto[];
  warnings?: SourceWarningDto[];
};

export type AudioArtifactDto = {
  id: string;
  source?: RecordingSource;
  format: "wav";
  durationMs: number;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
};

export type NoteDto = NoteListItemDto & {
  generatedContent?: string;
  editedContent?: string;
  transcript?: TranscriptDto;
  sourceTranscripts?: TranscriptDto[];
  recording?: RecordingSessionDto;
  audio?: AudioArtifactDto;
  audioSources?: AudioArtifactDto[];
  activeTab?: "notes" | "transcription";
  lastError?: string;
};

export type RecoverableRecordingDto = {
  sessionId: string;
  noteId: string;
  sourceMode?: RecordingSourceMode;
  startedAt: string;
  partialPathPresent: boolean;
  finalPathPresent: boolean;
  bytesFound: number;
  sources?: RecoverableSourceDto[];
};

export type RecoverableSourceDto = {
  source: RecordingSource;
  partialPathPresent: boolean;
  finalPathPresent: boolean;
  bytesFound: number;
  lastError?: string;
};

export type BootstrapResponse = {
  folders: FolderDto[];
  notes: NoteListItemDto[];
  activeRecoveries: RecoverableRecordingDto[];
  providerConfigured: boolean;
};

export type AudioValidationDto = {
  fileExists: boolean;
  nonZeroSize: boolean;
  readableAudio: boolean;
  expectedDurationMs: number;
  actualDurationMs: number;
  durationWithinTolerance: boolean;
  nonSilentSignal: boolean;
  peakAmplitude: number;
  rmsAmplitude: number;
  warnings: string[];
};

export type SourceValidationDto = {
  source: RecordingSource;
  fileExists: boolean;
  nonZeroSize: boolean;
  readableAudio: boolean;
  expectedDurationMs: number;
  actualDurationMs?: number;
  durationWithinTolerance: boolean;
  nonSilentSignal: boolean;
  peakAmplitude?: number;
  rmsAmplitude?: number;
  warnings: string[];
  error?: string;
};

export type FinishRecordingResponse = {
  note: NoteDto;
  recording: RecordingSessionDto;
  validation: AudioValidationDto;
  validations?: SourceValidationDto[];
  processingStarted: boolean;
  warnings?: SourceWarningDto[];
};

export type ListNotesResponse = {
  items: NoteListItemDto[];
  nextCursor?: string;
};

export type SourceReadinessDto = {
  source: RecordingSource;
  required: boolean;
  ready: boolean;
  permissionState:
    | "unknown"
    | "granted"
    | "denied"
    | "restricted"
    | "unsupported";
  deviceAvailable: boolean;
  captureAvailable: boolean;
  recoveryAction?:
    | "openMicrophoneSettings"
    | "openSystemAudioSettings"
    | "upgradeMacos"
    | "restartApp";
  message?: string;
};

export type RecordingSourceReadinessDto = {
  sourceMode: RecordingSourceMode;
  ready: boolean;
  checkedAt?: string;
  sources: SourceReadinessDto[];
};

export async function bootstrapApp() {
  return invoke<BootstrapResponse>("bootstrap_app");
}

export async function createNote(folderId?: string) {
  return invoke<NoteDto>("create_note", { request: { folderId } });
}

export async function createFolder(name: string) {
  return invoke<FolderDto>("create_folder", { request: { name } });
}

export async function listFolders() {
  return invoke<FolderDto[]>("list_folders");
}

export async function assignNoteToFolder(noteId: string, folderId: string) {
  return invoke<NoteDto>("assign_note_to_folder", {
    request: { noteId, folderId },
  });
}

export async function removeNoteFromFolder(noteId: string, folderId: string) {
  return invoke<NoteDto>("remove_note_from_folder", {
    request: { noteId, folderId },
  });
}

export async function listNotes(folderId?: string) {
  return invoke<ListNotesResponse>("list_notes", { request: { folderId } });
}

export async function getNote(noteId: string) {
  return invoke<NoteDto>("get_note", { request: { noteId } });
}

export async function updateNote(input: {
  noteId: string;
  title?: string;
  editedContent?: string;
  activeTab?: "notes" | "transcription";
}) {
  return invoke<NoteDto>("update_note", { request: input });
}

export async function deleteNote(noteId: string) {
  return invoke<void>("delete_note", { request: { noteId } });
}

export async function checkRecordingSourceReadiness(
  sourceMode: RecordingSourceMode,
) {
  return invoke<RecordingSourceReadinessDto>(
    "check_recording_source_readiness",
    {
      request: { sourceMode },
    },
  );
}

export async function startRecording(
  noteId: string,
  sourceMode: RecordingSourceMode = "microphoneOnly",
) {
  return invoke<RecordingSessionDto>("start_recording", {
    request: { noteId, sourceMode },
  });
}

export async function pauseRecording(sessionId: string) {
  return invoke<RecordingStatusDto>("pause_recording", {
    request: { sessionId },
  });
}

export async function resumeRecording(sessionId: string) {
  return invoke<RecordingStatusDto>("resume_recording", {
    request: { sessionId },
  });
}

export async function getRecordingStatus(sessionId: string) {
  return invoke<RecordingStatusDto>("get_recording_status", {
    request: { sessionId },
  });
}

export async function finishRecording(sessionId: string) {
  return invoke<FinishRecordingResponse>("finish_recording", {
    request: { sessionId },
  });
}

export async function retryProcessing(noteId: string) {
  return invoke<NoteDto>("retry_processing", {
    request: { noteId, step: "all" },
  });
}

export async function recoverRecording(
  sessionId: string,
  action: "validate" | "discard",
) {
  return invoke<NoteDto>("recover_recording", {
    request: { sessionId, action },
  });
}
