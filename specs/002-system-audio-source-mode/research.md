# Research: Audio Source Modes for Notes

## Decision: Keep Transcription and Generation Batch-Only

The feature will not introduce realtime captions, live transcript streaming, or a meetings object. Capture writes local audio first, validates local artifacts, then runs transcription and note generation.

**Rationale**: The current MVP reliability model depends on saved audio being the source of truth. Batch processing keeps failure recovery clear: provider failures can be retried from saved artifacts, and interrupted capture can be recovered or discarded intentionally.

**Alternatives considered**:

- Reuse the legacy realtime dual-stream meeting pipeline. Rejected because it reintroduces meetings, live streaming complexity, and failure modes outside the current notes MVP.
- Mix microphone and system audio into one stream before transcription. Rejected because source failures and transcript provenance would be harder to diagnose.

## Decision: Store Microphone and System Audio as Separate Source Artifacts

`Microphone + system audio` sessions will create distinct local source artifacts for microphone and system audio. Each source has its own path, partial file, status, byte count, levels, validation result, transcript, and error details.

**Rationale**: Separate artifacts allow independent validation, partial success, source-labeled transcription, source-specific warnings, and recovery when only one source survives an interruption.

**Alternatives considered**:

- One mixed WAV file. Rejected because it hides whether the microphone or system source failed.
- Only store a mixed file plus debug metadata. Rejected because retry and source-labeled transcript quality would be worse.

## Decision: Preserve the Existing Microphone Path as the Default

`Microphone only` remains the default for new notes and should continue using the current Rust-managed microphone capture flow.

**Rationale**: Microphone reliability is already the top MVP priority. The new system-audio work should not destabilize the known path.

**Alternatives considered**:

- Replace all capture with a new combined native recorder. Rejected because it expands the blast radius for a late MVP scope change.

## Decision: Add macOS System Audio Through a Backend-Owned Native Bridge

System audio capture will be implemented behind a Rust backend source abstraction. The backend may manage a small macOS native helper or bridge under `src-tauri/native/mac-system-audio-recorder/`, inspired by the legacy helper, but the frontend will never call it directly.

**Rationale**: System audio capture is platform-specific and permission-sensitive. Keeping it behind the Tauri backend preserves scoped frontend capabilities and allows the backend to enforce atomic start, cleanup, logging, recovery, and artifact validation.

**Alternatives considered**:

- Frontend/browser audio APIs. Rejected because they cannot reliably capture system audio in the Tauri webview.
- Port the full legacy Electron bridge. Rejected because it brings unnecessary process/socket/realtime behavior.
- Make the native helper the owner of both microphone and system audio. Rejected for the first implementation because it risks regressing microphone-only capture.

## Decision: Use Explicit Permission Readiness Before Mode Selection and Start

The app will check readiness when the user selects a mode and again immediately before recording starts. A previous successful readiness result is advisory only.

**Rationale**: macOS permissions can change outside the app. The start command must be authoritative and must block capture if any required source is not ready.

**Alternatives considered**:

- Check only at start. Rejected because users need early feedback when choosing `Microphone + system audio`.
- Cache permission readiness for the whole session. Rejected because stale permission state can cause failed or misleading recording starts.

## Decision: Treat Multi-Source Start as Atomic From the User's Perspective

When `Microphone + system audio` starts, the backend must start all required sources and verify write evidence. If any required source cannot start or write evidence, the backend stops every started source, preserves recoverable artifacts, and reports a source-specific error.

**Rationale**: The UI must not claim that a note is recording in a dual-source mode when only one required source actually started.

**Alternatives considered**:

- Start microphone even if system audio fails. Rejected for the initial start path because it contradicts the user-selected mode. Partial processing is allowed only after a recording attempt has produced finalized or recoverable source artifacts.

## Decision: Process Any Valid Source After Finalization

After Done or recovery validation, if at least one selected source validates, transcription and generation may continue from valid sources with warnings for failed or silent sources. If no source validates, generation is blocked.

**Rationale**: This preserves user value when one source fails while still avoiding invented content for missing sources.

**Alternatives considered**:

- Require all selected sources to validate. Rejected because it would discard useful captured speech from the other source.
- Generate from invalid or silent sources. Rejected because it weakens reliability and creates misleading notes.

## Decision: Source-Labeled Transcript Sections Are Sufficient

Transcription output will preserve source labels such as `Microphone` and `System audio`. Perfect chronological interleaving is not required for this feature.

**Rationale**: Source labels satisfy the user need to distinguish speakers or media/system content while keeping the batch implementation tractable.

**Alternatives considered**:

- Full timestamp interleaving across sources. Deferred because it requires tighter clock alignment and is not required by the spec.

## Decision: Recovery Scans Work Per Source

Startup recovery will inspect source artifacts and checkpoints independently. Recoverable state should include which sources have partial files, finalized files, bytes, duration, validation results, and errors.

**Rationale**: Dual-source recording can fail asymmetrically. Per-source recovery prevents one broken artifact from hiding usable audio in the other artifact.

**Alternatives considered**:

- Session-level recovery only. Rejected because it is too coarse for dual-source troubleshooting.

## Decision: Keep UI Notes-First With a Compact Source Mode Control

The recording source mode control belongs near the recorder controls in the note editor. It is disabled during active, paused, finalizing, validating, transcribing, and generating states.

**Rationale**: The feature is part of note recording, not a separate meeting product. Keeping it close to the recorder makes the selected mode visible without adding a new surface.

**Alternatives considered**:

- A dedicated meeting mode page. Rejected by MVP scope.
- A global settings-only source selector. Rejected because the selected mode must be visible at the moment a recording starts.
