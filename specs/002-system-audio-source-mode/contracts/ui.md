# UI Contract: Audio Source Modes for Notes

The app remains a notes-first desktop utility with the same sidebar, notes list, editor, tabs, and bottom recorder layout from the MVP.

## Recording Source Control

Required control:

- A compact segmented control with exactly two labels: `Microphone only` and `Microphone + system audio`.
- Default selection for a new note is `Microphone only`.
- The selected mode is visible before the user starts recording.

Behavior:

- Changing the selected mode triggers `check_recording_source_readiness`.
- The control is disabled while a recording is active, paused, finalizing, validating, transcribing, or generating.
- If readiness fails, the selected mode can remain visible, but Start is blocked and the recovery message identifies the failing source.
- The control must not create a meetings page, meeting object, workspace switcher, calendar surface, or realtime transcript panel.

## Permission and Readiness UI

`Microphone only` readiness:

- Shows microphone availability and permission issues.
- Does not mention system audio unless the user selects the dual-source mode.

`Microphone + system audio` readiness:

- Shows readiness for both microphone and system audio.
- If one source is denied, unavailable, or unsupported, Start is blocked.
- Recovery actions identify the relevant macOS Privacy & Security area where practical.

Start behavior:

- Start performs a fresh backend readiness check.
- If readiness changed since mode selection, the UI updates to the latest authoritative failure and does not enter recording state.

## Active Recorder UI

`Microphone only`:

- Preserves the existing recorder layout, elapsed time, waveform, Pause, Resume, Done, silence warning, and validation states.

`Microphone + system audio`:

- Shows a shared elapsed timer and compact per-source evidence for `Microphone` and `System audio`.
- Each source shows activity/level evidence, paused state, and bytes-written or equivalent local-write evidence.
- Source warnings name the affected source.
- Pause and Resume apply to both sources from the user's perspective.

Mode changes:

- The source mode control remains visible but disabled during the active lifecycle.
- The disabled state should be obvious without hiding the selected mode.

## Done, Validation, and Processing UI

Done:

- Shows finalizing per source before validation.
- Shows validation per source before transcription begins.

Partial validity:

- If one source validates and another fails or is silent, the note can continue to transcription/generation from the valid source.
- The UI shows a warning for the failed source and keeps the warning visible in the Transcription tab or note status area.

No valid source:

- The app does not generate a note.
- The user sees validate/retry/discard options when recoverable audio exists.

Provider failure:

- Saved source artifacts remain available.
- Retry uses saved artifacts and the persisted source mode.

## Transcription Tab

The Transcription tab shows the exact labeled transcript used for note generation.

Required display behavior:

- `Microphone` and `System audio` sections are visible for dual-source recordings when transcripts or failures exist.
- Source-specific transcription failures are shown next to the affected source.
- If only one source produced valid transcript text, the tab makes clear which source was used.

## Notes Tab

Generated content appends to existing note content for additional recordings in the same note.

Required display behavior:

- Existing user-edited content remains visible.
- New generated content is appended in a readable section.
- The UI does not replace earlier generated or edited content when a later recording finishes.

## Recovery Banner

Startup recovery surfaces source-aware recoverable recordings.

Required display behavior:

- Shows the session source mode.
- Shows which sources have partial or finalized bytes.
- Offers validate and discard actions.
- Source failures are named directly.

## Visual Direction

- Preserve the current polished macOS, Liquid Glass-inspired Tauri treatment.
- Keep the new source control visually quiet and functional.
- Avoid marketing-like layout changes.
- Avoid adding large panels that reduce the note editor's usable space.
- Source activity indicators must remain legible when glass/translucency effects are active.
