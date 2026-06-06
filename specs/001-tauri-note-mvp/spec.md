# Feature Specification: Tauri Notes MVP

**Feature Branch**: `001-tauri-note-mvp`  
**Created**: 2026-05-19  
**Status**: Draft  
**Input**: User description: "Define the MVP for a simpler macOS OS Notetaker app built with Tauri. Scope is notes only: folders, all notes, note creation, microphone-only recording, reliable saved audio, batch transcription after recording, AI-generated note output, and transcript review. Exclude meetings, realtime transcription, system audio, billing, calendar, chat, auth, and sharing."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Capture a Reliable Voice Note (Priority: P1)

A user opens the desktop app, creates a new note, records from the microphone, sees clear evidence that audio is being captured, stops recording, and receives an AI-generated note plus the full transcript.

**Why this priority**: This is the MVP's core value. If microphone capture is not trustworthy, the rest of the app is not useful.

**Independent Test**: Can be tested by recording a 60-second spoken note, stopping it, and verifying that the app saved a playable audio file, generated a transcript, and created a note from that transcript.

**Acceptance Scenarios**:

1. **Given** the user has granted microphone access and is on the new note screen, **When** they start recording and speak, **Then** the recording UI shows elapsed time, active waveform movement, and a non-idle recording state.
2. **Given** the user has been recording for at least 10 seconds, **When** they select Done, **Then** the app finalizes the audio file, validates that it contains usable audio, transcribes it, and generates note content without requiring the user to copy/paste the transcript.
3. **Given** the microphone is muted, disconnected, or producing no meaningful signal, **When** the user records, **Then** the app warns that audio capture appears silent before allowing them to generate a note.
4. **Given** transcription or AI note generation fails after audio was saved, **When** the user views the note, **Then** the saved audio and recording metadata remain available for retry.

---

### User Story 2 - Organize Notes by Folder (Priority: P2)

A user can use a simple sidebar to browse all notes, create folders, and view notes associated with each folder.

**Why this priority**: The app needs enough structure to remain useful after more than a few notes, while avoiding the complexity of the legacy workspace, spaces, meeting, chat, and account model.

**Independent Test**: Can be tested by creating two folders, creating multiple notes, assigning notes to folders, and verifying that All Notes and folder views show the correct lists.

**Acceptance Scenarios**:

1. **Given** the app has no notes, **When** the user opens it, **Then** the sidebar shows "OS Notetaker", "+ New Folder", and "All Notes", while the main area shows an empty state and a prominent create-note action.
2. **Given** the user has existing notes, **When** they select All Notes, **Then** the main area lists previous notes in reverse chronological order.
3. **Given** the user creates a folder, **When** they assign a note to that folder, **Then** that note appears in the folder view and remains visible in All Notes.
4. **Given** a folder is empty, **When** the user opens it, **Then** the main area communicates that no notes are in that folder yet and offers a clear path to create or assign a note.

---

### User Story 3 - Review and Edit Generated Notes (Priority: P3)

A user can inspect the generated note and the transcript in the same note view, switch between "Notes" and "Transcription", edit the note title/content, and keep the transcript as source context.

**Why this priority**: AI output will not always be perfect. The MVP must let users trust, inspect, and correct their notes.

**Independent Test**: Can be tested by opening a generated note, switching tabs, editing the title and note body, closing/reopening the app, and verifying the changes persisted.

**Acceptance Scenarios**:

1. **Given** a generated note exists, **When** the user opens it, **Then** the note title, generated note content, and tab switcher for "Notes" and "Transcription" are visible.
2. **Given** the user switches to Transcription, **When** the transcript exists, **Then** the app displays the transcript exactly as returned by transcription, with readable scrolling.
3. **Given** the user edits the title or note content, **When** the app autosaves, **Then** the edits persist locally and are visible after restart.
4. **Given** no transcription exists because processing failed, **When** the user opens Transcription, **Then** the app explains the failure and offers retry if the audio file is available.

---

### User Story 4 - Recover from Interrupted Recording (Priority: P4)

A user does not lose a recording if the app is closed, crashes, or loses network connectivity after audio capture started.

**Why this priority**: Reliability is the main differentiator for the simplified MVP. Audio capture must be treated as more important than live transcription speed.

**Independent Test**: Can be tested by starting a recording, force-quitting the app after audio is being written, reopening it, and verifying the app surfaces a recoverable draft or saved audio artifact.

**Acceptance Scenarios**:

1. **Given** the app closes while recording, **When** it restarts, **Then** it detects the last recording session and shows whether audio can be recovered or discarded.
2. **Given** audio was saved but transcription was not completed, **When** the app restarts, **Then** the note remains in a processing/retry state rather than disappearing.
3. **Given** network access is unavailable after recording, **When** the user selects Done, **Then** audio finalization succeeds locally and transcription/generation can be retried later.

### Edge Cases

- Microphone permission is denied, revoked, or not yet requested.
- The selected microphone is disconnected during recording.
- The microphone is active but produces sustained silence or near-silence.
- Recording starts but no bytes are written to disk within the expected startup window.
- Recording duration and saved audio duration disagree beyond a small tolerance.
- The audio file is too short to transcribe reliably.
- Transcription returns empty text or text in a different language from the spoken audio.
- AI note generation succeeds but returns content that is empty, malformed, or unrelated to the transcript.
- The user creates many notes, long transcripts, or large audio files.
- The app is closed during recording, transcription, or note generation.
- Local disk write fails or available storage is insufficient.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The app MUST provide a single primary desktop window with a persistent left sidebar and a main content area.
- **FR-002**: The sidebar MUST include the app name, "+ New Folder", "All Notes", and the user's folders.
- **FR-003**: The All Notes view MUST list existing notes in reverse chronological order with enough identifying information for selection.
- **FR-004**: The app MUST provide a prominent new-note action from the notes list/empty state.
- **FR-005**: A new note screen MUST show a placeholder title, a "Notes | Transcription" switcher, note content area, recording controls, and a microphone activity visualization.
- **FR-006**: The MVP MUST support microphone-only recording. System audio, meeting capture, live captions, and realtime transcription are out of scope.
- **FR-007**: The app MUST request microphone permission before recording and explain how to recover when permission is denied.
- **FR-008**: The app MUST display real-time recording evidence while recording, including elapsed time, active/paused state, and a visual audio-level indicator that responds to microphone input.
- **FR-009**: The app MUST persist audio locally before attempting transcription or note generation.
- **FR-010**: The app MUST run recording sanity checks before transcription: non-zero file size, minimum duration, detectable audio signal above a silence threshold, and successful readable-file validation.
- **FR-011**: The app MUST warn the user and avoid generating a note when sanity checks indicate unusable audio.
- **FR-012**: The app MUST support Pause and Resume without losing previously recorded audio.
- **FR-013**: The Done action MUST finalize the recording, validate the saved audio, submit it for transcription, and generate note content from the resulting transcript.
- **FR-014**: The generated note MUST be produced in the same language as the source audio unless the user later provides explicit formatting or language instructions.
- **FR-015**: The generated note MUST use only the transcript and optional user-provided note context; it MUST NOT invent decisions, tasks, or facts not supported by the transcript.
- **FR-016**: The note view MUST let the user switch between generated Notes and the raw Transcription.
- **FR-017**: The user MUST be able to edit note title and generated note content after generation.
- **FR-018**: The app MUST autosave note edits, folder changes, recording metadata, transcript text, and processing status locally.
- **FR-019**: The app MUST preserve saved audio when transcription or AI generation fails, allowing retry without re-recording.
- **FR-020**: The app MUST keep a processing status for each note: draft, recording, validating, transcribing, generating, ready, failed, or recoverable.
- **FR-021**: The app MUST recover or surface incomplete recording sessions on restart when audio data was written before interruption.
- **FR-022**: Folder assignment MUST be local, reversible, and must not remove the note from All Notes.
- **FR-023**: The app MUST provide clear failure messages for microphone, file-write, transcription, and generation failures.
- **FR-024**: The app MUST avoid showing legacy meeting, calendar, billing, chat, sharing, authentication, workspace, or system-audio controls in the MVP.
- **FR-025**: The app MUST store user data locally by default for the MVP.

### Reliability Requirements

- **RR-001**: Recording MUST NOT be considered successful until an audio file has been finalized and verified as readable.
- **RR-002**: The app MUST record session checkpoints at start, pause, resume, done, validation, transcription, generation, and completion.
- **RR-003**: The app MUST compare expected elapsed recording time with actual saved audio duration and flag mismatches above tolerance.
- **RR-004**: The app MUST detect sustained silence during active recording and make that state visible to the user before Done.
- **RR-005**: The app MUST support retrying transcription/generation from saved audio without requiring a new recording.
- **RR-006**: The app MUST make it visually obvious when it is listening, paused, validating, transcribing, generating, failed, or ready.

### UX Requirements

- **UX-001**: The interface MUST be simpler than the legacy app and preserve the provided structure: left sidebar, large main canvas, note list or note editor, and bottom recording controls.
- **UX-002**: The visual design SHOULD feel fluid and native to macOS: fast transitions, immediate control feedback, polished spacing, and no page-like web chrome.
- **UX-003**: The recording visualization SHOULD sit near the bottom center of the note screen and respond smoothly to microphone input.
- **UX-004**: The Pause and Done controls MUST remain reachable while recording.
- **UX-005**: The Transcription view MUST be scrollable for long transcripts.
- **UX-006**: The app MUST handle empty states without explanatory marketing copy or onboarding screens.

### Platform Constraints for Planning

- **PC-001**: The MVP is planned as a Tauri desktop app targeting macOS first.
- **PC-002**: macOS microphone permission, app entitlements/signing, and distribution constraints must be treated as first-class planning concerns.
- **PC-003**: Tauri frontend-to-backend permissions must be explicitly scoped; the frontend should not receive broader file or shell access than required for notes, audio capture status, and local storage.
- **PC-004**: The implementation plan must include a repeatable build/run/debug entrypoint for macOS and a way to inspect microphone permission and recording failures.

### Key Entities *(include if feature involves data)*

- **Folder**: A local organizational container with id, name, creation date, update date, and a list of assigned notes.
- **Note**: A user-created record with id, title, generated content, optional user edits, folder assignments, created/updated timestamps, processing status, and links to transcript/audio metadata.
- **Recording Session**: A capture lifecycle record with id, note id, start/end timestamps, pause intervals, status, device label if available, audio-level samples or summary statistics, file path, file size, duration, and validation results.
- **Audio Artifact**: A finalized local audio file with path, format, duration, size, checksum or integrity marker, and creation timestamp.
- **Transcript**: Text produced from the saved audio, with language if detected, provider metadata, processing status, and retry history.
- **Generation Result**: AI-generated note content, prompt version, source transcript id, status, and error details when applicable.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 20 consecutive manual recordings of at least 30 seconds each with audible speech, the app saves a readable audio file every time.
- **SC-002**: For a valid 60-second recording, the user can complete capture, validation, transcription, and note generation without manually copying transcript text.
- **SC-003**: When the microphone is muted or silent for 10 seconds during active recording, the app visibly warns the user before Done.
- **SC-004**: When network access is disabled after recording, the audio remains saved locally and the note can be retried after network access returns.
- **SC-005**: The notes list, folder selection, and note editor remain responsive with at least 500 local notes.
- **SC-006**: A long transcript of at least 10,000 characters can be opened and scrolled without blocking note editing.
- **SC-007**: A user can create a folder, create a voice note, generate the note, assign it to the folder, restart the app, and find the same note in both the folder and All Notes.
- **SC-008**: At least 90% of first-time test users can identify whether the app is recording, paused, processing, or ready without reading documentation.
- **SC-009**: In failure scenarios for permission denied, silent audio, transcription failure, and generation failure, the app shows a clear next step and preserves recoverable data.

## Assumptions

- The MVP targets a single local user on one Mac; accounts, sync, collaboration, sharing, and cloud note storage are out of scope.
- The user provides any required AI/transcription credentials through local development configuration or a later settings surface; credential UX is not part of this spec unless required for MVP operation.
- Batch transcription after recording is acceptable; realtime captions and incremental transcript display are intentionally excluded.
- Audio is captured only from the microphone; system audio and meeting audio are excluded from the original MVP scope.
- The removed legacy reference app should not be reintroduced; the new implementation should not preserve its workspace/auth/billing/calendar/meeting complexity.
- Note generation may use a remote AI/transcription service, so the app must gracefully separate local capture success from network-dependent processing.
- The MVP can use local storage only; import/export, search, tags, reminders, and advanced folder nesting are out of scope unless added later.
