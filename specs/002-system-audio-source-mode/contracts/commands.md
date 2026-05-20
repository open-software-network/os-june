# Command Contracts: Audio Source Modes for Notes

The frontend communicates with the Rust backend through Tauri commands only. The backend remains authoritative for permission readiness, source start, file lifecycle, validation, transcription, generation, recovery, and retry.

## Shared Types

```ts
type RecordingSourceMode = "microphone_only" | "microphone_plus_system";
type RecordingSource = "microphone" | "system";

type ProcessingStatus =
  | "draft"
  | "recording"
  | "validating"
  | "transcribing"
  | "generating"
  | "ready"
  | "failed"
  | "recoverable";

type RecordingState =
  | "idle"
  | "permission_denied"
  | "starting"
  | "recording"
  | "paused"
  | "finalizing"
  | "validating"
  | "partially_valid"
  | "invalid"
  | "ready"
  | "failed"
  | "recoverable";

type SourceState =
  | "pending"
  | "permission_denied"
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

type AppError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};
```

## Permission Commands

### `check_recording_source_readiness`

Checks permissions and source availability for the selected mode. This command is called when the user changes mode and again by `start_recording`.

**Request**:

```ts
type CheckRecordingSourceReadinessRequest = {
  sourceMode: RecordingSourceMode;
};
```

**Response**:

```ts
type SourceReadinessDto = {
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
    | "open_microphone_settings"
    | "open_system_audio_settings"
    | "upgrade_macos"
    | "restart_app";
  message?: string;
};

type RecordingSourceReadinessDto = {
  sourceMode: RecordingSourceMode;
  ready: boolean;
  checkedAt: string;
  sources: SourceReadinessDto[];
};
```

**Errors**:

- `readiness_check_failed`

## Recording Commands

### `start_recording`

Rechecks readiness, creates a source-mode recording session, starts all required sources, verifies source write evidence, and returns recording state only after startup is complete.

**Request**:

```ts
type StartRecordingRequest = {
  noteId: string;
  sourceMode: RecordingSourceMode;
};
```

**Response**: `RecordingSessionDto`

**Errors**:

- `note_not_found`
- `recording_already_active`
- `microphone_permission_denied`
- `microphone_unavailable`
- `system_audio_permission_denied`
- `system_audio_unavailable`
- `system_audio_unsupported`
- `source_start_failed`
- `source_write_evidence_missing`
- `storage_write_failed`

### `pause_recording`

Pauses every active source in the selected mode.

**Request**:

```ts
type PauseRecordingRequest = {
  sessionId: string;
};
```

**Response**: `RecordingSessionDto`

**Errors**:

- `recording_not_found`
- `source_pause_failed`

### `resume_recording`

Resumes every paused source in the selected mode.

**Request**:

```ts
type ResumeRecordingRequest = {
  sessionId: string;
};
```

**Response**: `RecordingSessionDto`

**Errors**:

- `recording_not_found`
- `source_resume_failed`

### `get_recording_status`

Returns elapsed time, session state, and per-source write and level evidence.

**Request**:

```ts
type GetRecordingStatusRequest = {
  sessionId: string;
};
```

**Response**:

```ts
type RecordingStatusDto = {
  sessionId: string;
  sourceMode: RecordingSourceMode;
  state: RecordingState;
  elapsedMs: number;
  sources: SourceStatusDto[];
  warnings: SourceWarningDto[];
};
```

### `finish_recording`

Finalizes every active source artifact, validates each artifact independently, and starts processing only when at least one selected source validates.

**Request**:

```ts
type FinishRecordingRequest = {
  sessionId: string;
};
```

**Response**:

```ts
type FinishRecordingResponse = {
  note: NoteDto;
  recording: RecordingSessionDto;
  validations: SourceValidationDto[];
  processingStarted: boolean;
  warnings: SourceWarningDto[];
};
```

**Errors**:

- `recording_not_found`
- `audio_finalization_failed`
- `no_valid_source_audio`
- `storage_write_failed`

## Processing Commands

### `retry_processing`

Retries transcription and/or generation from saved valid source artifacts and persisted source mode.

**Request**:

```ts
type RetryProcessingRequest = {
  noteId: string;
  sessionId?: string;
  step?: "transcription" | "generation" | "all";
};
```

**Response**: `NoteDto`

**Errors**:

- `note_not_found`
- `recording_not_found`
- `source_artifact_missing`
- `no_valid_source_audio`
- `provider_not_configured`
- `transcription_failed`
- `generation_failed`

### `recover_recording`

Attempts to validate or discard an interrupted source-mode recording after startup scan.

**Request**:

```ts
type RecoverRecordingRequest = {
  sessionId: string;
  action: "validate" | "discard";
};
```

**Response**:

```ts
type RecoverRecordingResponse = {
  note: NoteDto;
  recording: RecordingSessionDto;
  recoverableSources: RecoverableSourceDto[];
  validations?: SourceValidationDto[];
  processingStarted: boolean;
};
```

## DTOs

```ts
type RecordingSessionDto = {
  id: string;
  noteId: string;
  sourceMode: RecordingSourceMode;
  state: RecordingState;
  startedAt: string;
  endedAt?: string;
  elapsedMs: number;
  sources: SourceStatusDto[];
  warnings: SourceWarningDto[];
  lastError?: string;
};

type SourceStatusDto = {
  source: RecordingSource;
  state: SourceState;
  elapsedMs: number;
  bytesWritten: number;
  level: AudioLevelDto;
  silenceWarning: boolean;
  pathFinalized: boolean;
  lastError?: string;
};

type SourceValidationDto = {
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

type SourceWarningDto = {
  source: RecordingSource;
  code: string;
  message: string;
};

type TranscriptDto = {
  id: string;
  text: string;
  sourceMode?: RecordingSourceMode;
  source?: RecordingSource;
  language?: string;
  status: "pending" | "running" | "succeeded" | "failed";
  lastError?: string;
};

type NoteDto = NoteListItemDto & {
  generatedContent?: string;
  editedContent?: string;
  transcript?: TranscriptDto;
  sourceTranscripts?: TranscriptDto[];
  recording?: RecordingSessionDto;
  audioSources?: AudioSourceArtifactDto[];
  activeTab?: "notes" | "transcription";
  lastError?: string;
};

type AudioSourceArtifactDto = {
  id: string;
  source: RecordingSource;
  format: "wav";
  durationMs: number;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
};

type RecoverableSourceDto = {
  source: RecordingSource;
  partialPathPresent: boolean;
  finalPathPresent: boolean;
  bytesFound: number;
  lastError?: string;
};
```

## Event Contract

```ts
type BackendEvent =
  | {
      type: "recording-level";
      sessionId: string;
      source: RecordingSource;
      level: AudioLevelDto;
      elapsedMs: number;
      bytesWritten: number;
      silenceWarning: boolean;
    }
  | {
      type: "recording-state";
      sessionId: string;
      sourceMode: RecordingSourceMode;
      state: RecordingState;
      sources: SourceStatusDto[];
      message?: string;
    }
  | { type: "note-updated"; note: NoteDto }
  | {
      type: "processing-state";
      noteId: string;
      sessionId?: string;
      status: ProcessingStatus;
      message?: string;
    };
```

Events are advisory. Commands and persisted state remain authoritative after reload.
