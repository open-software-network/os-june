# Data Model: Audio Source Modes for Notes

This feature extends the existing local SQLite model from `001-tauri-note-mvp`. Existing folder, note, provider, and editable note semantics remain unchanged.

## RecordingSourceMode

Capture scope selected for one recording session.

| Value                    | User Label                  | Meaning                                                 |
| ------------------------ | --------------------------- | ------------------------------------------------------- |
| `microphone_only`        | `Microphone only`           | Capture only the microphone source                      |
| `microphone_plus_system` | `Microphone + system audio` | Capture microphone and system audio as separate sources |

**Validation**:

- New recording sessions default to `microphone_only`.
- Source mode cannot change after a recording session starts.
- Retry and recovery use the mode persisted on the session.

## RecordingSource

One concrete audio source inside a recording session.

| Value        | Required In Mode         | Meaning                                        |
| ------------ | ------------------------ | ---------------------------------------------- |
| `microphone` | Both modes               | User microphone input                          |
| `system`     | `microphone_plus_system` | Audio produced by apps or the operating system |

## RecordingSession

Existing capture lifecycle record extended for source modes.

| Field                 | Type        | Required | Notes                                                            |
| --------------------- | ----------- | -------- | ---------------------------------------------------------------- |
| `id`                  | UUID string | Yes      | Stable local id                                                  |
| `note_id`             | UUID string | Yes      | References `Note`                                                |
| `source_mode`         | enum        | Yes      | `microphone_only` or `microphone_plus_system`                    |
| `status`              | enum        | Yes      | Existing statuses plus source-aware recovery and failure details |
| `started_at`          | timestamp   | Yes      | Set before source startup begins                                 |
| `ended_at`            | timestamp   | No       | Set after Done or recovery finalization                          |
| `expected_elapsed_ms` | integer     | Yes      | Active recording time excluding pauses                           |
| `permission_summary`  | JSON        | No       | Last readiness result for required sources                       |
| `last_error`          | text        | No       | Session-level failure summary                                    |

**Relationships**:

- Belongs to one `Note`.
- Has one or more `SourceArtifact`.
- Has many `SourceCheckpoint`.

**State transitions**:

- `created` -> `starting`
- `starting` -> `recording` only after every required source starts and writes evidence
- `starting` -> `failed` or `recoverable` if startup fails
- `recording` -> `paused` -> `recording`
- `recording` or `paused` -> `finalizing` -> `validating`
- `validating` -> `valid`, `partially_valid`, or `invalid`
- Active states -> `recoverable` on restart when any source wrote bytes

## SourceArtifact

Local file metadata for one source in a recording session.

| Field                  | Type        | Required | Notes                                                                                                                 |
| ---------------------- | ----------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `id`                   | UUID string | Yes      | Stable local id                                                                                                       |
| `note_id`              | UUID string | Yes      | References `Note`                                                                                                     |
| `recording_session_id` | UUID string | Yes      | References `RecordingSession`                                                                                         |
| `source`               | enum        | Yes      | `microphone` or `system`                                                                                              |
| `status`               | enum        | Yes      | `pending`, `recording`, `paused`, `finalizing`, `finalized`, `valid`, `invalid`, `recoverable`, `discarded`, `failed` |
| `partial_path`         | string      | No       | App-local `.partial` path while recording                                                                             |
| `path`                 | string      | No       | Finalized app-local WAV path                                                                                          |
| `format`               | string      | Yes      | MVP default `wav`                                                                                                     |
| `expected_duration_ms` | integer     | Yes      | Active elapsed time for this source                                                                                   |
| `duration_ms`          | integer     | No       | Parsed from readable audio                                                                                            |
| `size_bytes`           | integer     | No       | Captured from filesystem                                                                                              |
| `checksum`             | string      | No       | Integrity marker for finalized audio                                                                                  |
| `peak_amplitude`       | float       | No       | Validation summary                                                                                                    |
| `rms_amplitude`        | float       | No       | Validation summary                                                                                                    |
| `silent_window_ms`     | integer     | No       | Longest near-silent span                                                                                              |
| `last_error`           | text        | No       | Source-specific failure details                                                                                       |
| `created_at`           | timestamp   | Yes      | Creation time                                                                                                         |
| `updated_at`           | timestamp   | Yes      | Last state change                                                                                                     |

**Validation**:

- Exactly one `microphone` artifact exists for every session.
- Exactly one `system` artifact exists when `source_mode` is `microphone_plus_system`.
- `(recording_session_id, source)` is unique.
- A source cannot be marked `valid` unless file existence, non-zero size, readable audio, duration tolerance, and signal checks pass.

## SourceValidationResult

Result of validating a source artifact independently.

| Field                       | Type         | Required | Notes                                    |
| --------------------------- | ------------ | -------- | ---------------------------------------- |
| `source_artifact_id`        | UUID string  | Yes      | References `SourceArtifact`              |
| `file_exists`               | boolean      | Yes      | Final or recoverable path exists         |
| `non_zero_size`             | boolean      | Yes      | File has bytes                           |
| `readable_audio`            | boolean      | Yes      | WAV parser can read metadata and samples |
| `expected_duration_ms`      | integer      | Yes      | From session elapsed time                |
| `actual_duration_ms`        | integer      | No       | From decoded audio                       |
| `duration_within_tolerance` | boolean      | Yes      | Uses existing tolerance policy           |
| `non_silent_signal`         | boolean      | Yes      | Signal exceeds configured floor          |
| `peak_amplitude`            | float        | No       | Source peak                              |
| `rms_amplitude`             | float        | No       | Source RMS                               |
| `warnings`                  | string array | Yes      | Non-fatal issues                         |
| `error`                     | string       | No       | Fatal validation issue                   |

**Validation**:

- Fatal validation for one source does not erase other source results.
- Generation is allowed only when at least one source has a successful validation result.

## SourceCheckpoint

Append-only lifecycle event for a session or specific source.

| Field                  | Type        | Required | Notes                                                                                                                                                             |
| ---------------------- | ----------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | UUID string | Yes      | Stable local id                                                                                                                                                   |
| `recording_session_id` | UUID string | Yes      | References `RecordingSession`                                                                                                                                     |
| `source_artifact_id`   | UUID string | No       | Present for source-specific events                                                                                                                                |
| `source`               | enum        | No       | `microphone` or `system`                                                                                                                                          |
| `kind`                 | enum        | Yes      | `permission_check`, `start`, `write_evidence`, `pause`, `resume`, `done`, `finalize`, `validation`, `transcription`, `generation`, `recovery`, `retry`, `failure` |
| `created_at`           | timestamp   | Yes      | Event time                                                                                                                                                        |
| `details`              | JSON        | No       | Structured diagnostic details                                                                                                                                     |

## Transcript

Existing transcript record extended for source labels.

| Field                  | Type        | Required | Notes                                                                    |
| ---------------------- | ----------- | -------- | ------------------------------------------------------------------------ |
| `id`                   | UUID string | Yes      | Stable local id                                                          |
| `note_id`              | UUID string | Yes      | References `Note`                                                        |
| `recording_session_id` | UUID string | Yes      | References `RecordingSession`                                            |
| `source_artifact_id`   | UUID string | No       | Present for source-specific transcript rows                              |
| `source`               | enum        | No       | `microphone` or `system`; omitted only for a combined display transcript |
| `text`                 | text        | Yes      | Source transcript text or combined labeled transcript                    |
| `provider`             | string      | Yes      | `mock`, `openai`, or configured provider key                             |
| `status`               | enum        | Yes      | `pending`, `running`, `succeeded`, `failed`                              |
| `retry_count`          | integer     | Yes      | Starts at zero                                                           |
| `last_error`           | text        | No       | Failure details                                                          |
| `created_at`           | timestamp   | Yes      | First attempt time                                                       |
| `updated_at`           | timestamp   | Yes      | Last status change                                                       |

**Validation**:

- Successful source transcript text must not be blank.
- The displayed transcript for multi-source recordings must preserve source labels.
- Provider failure for one source must not delete successful transcripts for another source.

## GenerationResult

Existing generation result extended to record source coverage.

| Field             | Type | Required | Notes                                                  |
| ----------------- | ---- | -------- | ------------------------------------------------------ |
| `source_mode`     | enum | Yes      | Mode used for source context                           |
| `source_coverage` | JSON | Yes      | Which sources were used, skipped, invalid, or failed   |
| `content`         | text | No       | Generated note content to append to existing note body |

**Validation**:

- Generation uses only valid source transcripts and existing user note context.
- New generated content appends to existing visible note content.
- Missing or failed sources are represented as warnings, not invented content.

## PermissionReadiness

Transient backend response persisted as checkpoints and optionally summarized on the session.

| Field         | Type             | Required    | Notes                                          |
| ------------- | ---------------- | ----------- | ---------------------------------------------- |
| `source_mode` | enum             | Yes         | Requested mode                                 |
| `ready`       | boolean          | Yes         | True only when all required source checks pass |
| `microphone`  | source readiness | Yes         | Permission, device, and recovery hint          |
| `system`      | source readiness | Conditional | Required for `microphone_plus_system`          |
| `checked_at`  | timestamp        | Yes         | Advisory timestamp only                        |

**Validation**:

- Readiness is rechecked immediately before `start_recording`.
- A stale readiness result cannot authorize recording.
