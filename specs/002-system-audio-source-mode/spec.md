# Feature Specification: Audio Source Modes for Notes

**Feature Branch**: `002-system-audio-source-mode`
**Created**: 2026-05-19
**Status**: Draft
**Input**: User description: "Add a recording source mode control so notes can listen to microphone only or microphone plus system audio. This is a late MVP scope change inspired by the legacy macOS system-audio capture path. Realtime transcription is not required. The app must verify required permissions when the mode changes or when recording starts, and the implementation should be as reliable and failure-proof as possible."

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Choose the Recording Source Before Capture (Priority: P1)

A user can decide whether a note should record only their microphone or both microphone and system audio before starting capture. The app makes the selected mode visible and verifies that the permissions required for that mode are available before capture starts.

**Why this priority**: The user must be able to intentionally capture meeting or system-source audio without accidentally changing the reliable microphone-only path that already works.

**Independent Test**: Can be tested by switching between "Microphone only" and "Microphone + system audio" before recording, denying one required permission, and verifying that recording does not start until the required permission path is resolved.

**Acceptance Scenarios**:

1. **Given** a draft note is open and no recording is active, **When** the user selects "Microphone only", **Then** the app verifies microphone readiness and keeps system-audio capture disabled.
2. **Given** a draft note is open and no recording is active, **When** the user selects "Microphone + system audio", **Then** the app verifies both microphone readiness and system-audio readiness before recording can begin.
3. **Given** a required permission for the selected mode is denied or unavailable, **When** the user tries to start recording, **Then** the app blocks capture, leaves the note editable, and shows a clear recovery action.
4. **Given** recording has started in a selected mode, **When** the user interacts with the mode control, **Then** the app prevents changing modes until the current recording is finished or discarded.

---

### User Story 2 - Capture Notes from Microphone and System Audio (Priority: P1)

A user can record a note while a meeting, video, or other system source is playing, and the generated note uses both the user's microphone and system audio after local capture completes.

**Why this priority**: The main value of this feature is capturing information from meetings or other system sources while preserving the batch, saved-audio reliability model.

**Independent Test**: Can be tested by playing audible system audio, speaking through the microphone, recording in "Microphone + system audio", selecting Done, and verifying that local audio artifacts, transcript text, and generated notes reflect both sources.

**Acceptance Scenarios**:

1. **Given** both required permissions are available and system audio is playing, **When** the user records in "Microphone + system audio", **Then** the app captures local audio evidence for both microphone and system sources.
2. **Given** the user pauses and resumes while recording in "Microphone + system audio", **When** capture finishes, **Then** pause and resume apply consistently to both sources.
3. **Given** capture finishes successfully, **When** the app transcribes the recording, **Then** transcript text is source-labeled so the user can distinguish microphone content from system-audio content.
4. **Given** transcription succeeds for at least one usable source, **When** note generation runs, **Then** the generated note uses the available labeled transcript and does not discard prior note content.

---

### User Story 3 - Recover and Retry Multi-Source Recordings (Priority: P2)

A user does not lose recoverable audio if the app closes, capture fails, or provider processing fails during a microphone-plus-system recording.

**Why this priority**: Adding a second audio source increases failure modes. The feature must preserve the existing reliability principle that saved audio is more important than provider speed.

**Independent Test**: Can be tested by starting a microphone-plus-system recording, force-quitting after bytes are written, reopening the app, and verifying that recoverable source artifacts are surfaced with validate, discard, and retry paths.

**Acceptance Scenarios**:

1. **Given** the app closes during a microphone-plus-system recording, **When** it restarts, **Then** it surfaces recoverable state for each source that wrote audio bytes.
2. **Given** one source validates and another source is silent or invalid, **When** the user finishes recording, **Then** the app preserves both source results, warns about the failed source, and can still process any valid source.
3. **Given** transcription or note generation fails after audio validation, **When** the user retries, **Then** retry uses saved audio artifacts without requiring a new recording.

### Edge Cases

- Microphone permission is granted but system-audio permission is denied.
- System-audio permission is granted but microphone permission is denied.
- System-audio capture is unavailable because the macOS version or app signing state does not support it.
- The user selects microphone-plus-system mode when no audible system source is playing.
- Microphone input is silent but system audio contains usable signal.
- System audio is silent but microphone input contains usable signal.
- One source starts successfully but stops writing bytes before Done.
- Pause or Resume succeeds for one source and fails for the other.
- Expected elapsed duration and saved audio duration disagree for one source but not the other.
- The app exits while one source has finalized audio and the other source only has partial audio.
- Provider transcription succeeds for one source and fails for the other.
- The user records multiple times into the same note; new generated content must append rather than replace previous note content.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The note editor MUST expose a clear recording source control before recording starts with exactly these user-facing choices: "Microphone only" and "Microphone + system audio".
- **FR-002**: "Microphone only" MUST remain the default source mode for new notes and must preserve the current microphone-only behavior.
- **FR-003**: The app MUST prevent source mode changes while a recording is active, paused, finalizing, validating, transcribing, or generating.
- **FR-004**: The app MUST persist the selected source mode with the recording session so recovery and retry use the same mode that started the recording.
- **FR-005**: Before starting "Microphone only" recording, the app MUST verify microphone permission and microphone device availability.
- **FR-006**: Before starting "Microphone + system audio" recording, the app MUST verify microphone permission, microphone device availability, system-audio permission readiness, and system-audio capture availability.
- **FR-007**: When a required permission is denied or unavailable, the app MUST NOT start capture, MUST NOT mark the note as recording, and MUST show a source-specific recovery message.
- **FR-008**: When a required permission can be fixed through macOS settings, the app MUST provide a recovery action or instruction that identifies the relevant permission area.
- **FR-009**: "Microphone + system audio" recording MUST capture microphone audio and system audio as distinct local source artifacts rather than mixing them into a single unlabeled stream.
- **FR-010**: The app MUST show recording evidence for every active source in the selected mode, including elapsed time, source activity, paused state, and bytes-written or equivalent local-write evidence.
- **FR-011**: Pause and Resume MUST apply to every active source in the selected mode; if one source cannot pause or resume, the app MUST stop the recording safely and preserve any recoverable audio.
- **FR-012**: The Done action MUST finalize every active source artifact before transcription or note generation begins.
- **FR-013**: The app MUST validate every finalized source artifact independently using local checks for file existence, non-zero size, readable audio, duration consistency, and non-silent signal.
- **FR-014**: If at least one selected source validates successfully, the app MAY continue transcription and note generation from valid sources while warning about invalid or silent sources.
- **FR-015**: If no selected source validates successfully, the app MUST NOT generate a note and MUST preserve recoverable source artifacts for retry or discard.
- **FR-016**: Transcription output MUST preserve source labels for microphone and system audio.
- **FR-017**: Generated notes MUST be based only on valid source transcripts and any existing user note context; they MUST NOT invent information for missing or failed sources.
- **FR-018**: When a new recording is added to an existing note, generated content MUST append to the existing visible note content instead of replacing it.
- **FR-019**: The raw Transcription tab MUST show the labeled source transcript used for generation and must make source failures visible when applicable.
- **FR-020**: Recovery scanning MUST detect partial and finalized artifacts per source and surface enough information for the user to validate, retry, or discard recoverable audio intentionally.
- **FR-021**: Retry processing MUST reuse saved source artifacts and the recording source mode without requiring the user to re-record.
- **FR-022**: The feature MUST remain batch-only for this scope: no realtime captions, no live transcript stream, and no separate meeting object are required.
- **FR-023**: The UI MUST remain notes-first and MUST NOT reintroduce legacy workspaces, auth, billing, calendar, chat, sharing, or a dedicated meetings product surface.
- **FR-024**: This specification supersedes the previous MVP assumption that system audio is out of scope only for the new "Microphone + system audio" source mode.

### Permission and Reliability Requirements

- **PR-001**: Permission checks MUST run when the user selects a source mode and again immediately before recording starts.
- **PR-002**: A stale successful permission check MUST NOT be treated as sufficient if the user starts recording later after permissions may have changed.
- **PR-003**: Starting a multi-source recording MUST be atomic from the user's perspective: either all required sources start and write evidence, or the app stops all started sources and reports the failure.
- **PR-004**: The app MUST record source-specific lifecycle checkpoints for start, pause, resume, done, validation, transcription, generation, failure, retry, and recovery.
- **PR-005**: The app MUST preserve source artifacts and validation metadata even when provider transcription or note generation fails.
- **PR-006**: The app MUST make it obvious which source failed when a permission, capture, validation, transcription, or generation error occurs.

### Key Entities _(include if feature involves data)_

- **Recording Source Mode**: The selected capture scope for a recording session. Valid values are microphone-only and microphone-plus-system-audio.
- **Source Artifact**: A local audio artifact associated with a specific source, including source label, path, format, duration, size, checksum or integrity marker, validation status, and error details.
- **Source Validation Result**: The result of validating one source artifact independently, including readability, duration consistency, signal evidence, and warnings.
- **Labeled Transcript**: Transcript text grouped or annotated by source so generated notes can distinguish microphone speech from system audio.
- **Recording Session**: The note-backed capture lifecycle that owns the selected source mode, source artifacts, checkpoints, processing status, retry state, and recovery state.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: In 20 consecutive microphone-only recordings of at least 30 seconds each, the app preserves the existing behavior and saves a readable microphone audio file every time.
- **SC-002**: In 10 consecutive microphone-plus-system recordings with audible microphone input and audible system audio, the app saves readable local artifacts for both sources at least 9 times.
- **SC-003**: When microphone permission or system-audio permission is denied, 100% of attempted recordings in the affected mode are blocked before capture starts and show a source-specific recovery message.
- **SC-004**: When one source is silent and the other source contains usable audio, the app generates a note from the valid source and shows a warning for the silent source.
- **SC-005**: When both selected sources are unusable, the app generates no note and preserves enough local state for retry or discard.
- **SC-006**: A user can record twice into the same note using any supported source mode and see the second generated result appended to the previous note content.
- **SC-007**: A force quit during microphone-plus-system capture surfaces recoverable source artifacts on restart whenever audio bytes were written before the interruption.
- **SC-008**: At least 90% of test users can identify the selected source mode and whether microphone and system audio are actively being captured without reading documentation.

## Assumptions

- This is a late MVP scope change that extends note recording source options while preserving the simpler notes-only product shape.
- Realtime transcription and live captions are intentionally excluded for this feature; all transcription and generation happen after local capture is finalized and validated.
- "System audio" means audio produced by applications or the operating system on the user's Mac, such as meeting participants, browser video, or media playback.
- System-audio capture is macOS-first and may require a minimum macOS version and correct app signing or permission metadata before it can work reliably.
- The implementation may reuse ideas from the legacy native macOS helper, but the new app should keep the current local storage, validation, retry, and recovery model.
- Source-labeled transcripts are sufficient for this feature; perfect chronological interleaving between microphone and system audio is not required.
- The existing local provider configuration remains the transcription and note generation path unless a later feature changes provider settings.
