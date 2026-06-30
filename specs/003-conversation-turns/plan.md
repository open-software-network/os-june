# Implementation Plan: Conversation Turns for Dual-Source Notes

**Branch**: `003-conversation-turns` | **Date**: 2026-05-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/003-conversation-turns/spec.md`

## Summary

Add post-recording turn detection for dual-source notes. The backend analyzes finalized microphone and system WAV artifacts, detects source-specific active intervals, extracts turn WAV segments, transcribes each segment, persists timing metadata, assembles the generation transcript in chronological turn order, and renders the Transcription tab as ordered `Microphone` / `System` interventions. After validation, transcription and generation continue in the background so the UI can leave the recording state while the note reports processing progress. User-written manual notes captured during recording are supplied to generation as user-authored context and preserved in the editable note.

## Technical Context

**Language/Version**: Rust stable with Tauri v2 backend; TypeScript with React and Vite frontend; Swift helper for macOS system-audio capture.  
**Primary Dependencies**: Existing Tauri v2, React, TypeScript, SQLite via `sqlx`, WAV parsing via `hound`, microphone capture via `cpal`, macOS system-audio helper, provider adapters via `reqwest`.  
**Storage**: Existing local SQLite database with additive transcript timing columns: `start_ms`, `end_ms`, and `turn_index`. Source audio artifacts remain file-backed. Temporary turn WAV segments are created during processing and can be recomputed from saved source artifacts.  
**Testing**: Rust tests for turn detection and ordered transcript assembly; frontend tests for ordered source turn display; existing `pnpm test`, `pnpm test:rust`, `pnpm run lint`, and build verification.  
**Target Platform**: macOS-first Tauri desktop app.  
**Constraints**: No realtime captions; no speaker diarization; no meeting object; saved local audio remains the source of truth for retry; generation must use only valid transcripts.

## Project Structure

```text
src/
├── components/note-editor/
├── lib/
└── styles/

src-tauri/
├── native/mac-system-audio-recorder/
├── src/audio/
├── src/db/
├── src/domain/
└── tests/

specs/003-conversation-turns/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── commands.md
│   └── ui.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

## Design Decisions

- Turn detection runs after local audio finalization and validation, before provider transcription.
- Each source uses RMS windows, a dynamic noise floor, minimum active duration, minimum turn duration, silence hysteresis, and gap merging.
- Microphone detection uses stricter thresholds and longer silence windows to avoid room-noise false positives.
- System detection uses lower thresholds and shorter silence windows for cleaner playback signals.
- A microphone turn is dropped as speaker bleed (echo) when concurrent system turns cover most of it and the system track is clearly louder over the overlap, so a remote participant's voice played through the speakers is not misattributed to the microphone.
- System audio must preserve wall-clock gaps so its timestamps can be compared with microphone timestamps.
- Failed turn transcriptions are skipped for generation, while valid turn transcripts continue to be used.
- Adjacent same-source turns are coalesced before transcription when the timeline indicates one continuing intervention.
- Later turn transcription receives recent valid transcript context through provider prompt support where available.
- Consecutive same-source transcript fragments are coalesced before persistence so the UI and generation use the same cleaned turn list.
- OpenAI transcription receives an optional `language` parameter from local configuration when `OS_NOTETAKER_TRANSCRIPTION_LANGUAGE` is set to a valid ISO-639-1 code.
- After successful validation, `finish_recording` returns a note in `transcribing` state and launches processing on a backend task; the frontend polls selected notes while they are `transcribing` or `generating`.
- Dual-source turn transcription is scheduled as source-specific lanes: microphone turns stay sequential with microphone context, system turns stay sequential with system context, and both lanes run concurrently before final chronological assembly.
- Manual note text stored in `edited_content` before generation is passed to the generation provider as `Manual notes` context together with the transcript.
- `set_generated_note` continues appending generated content below existing edited content so manual notes remain visible and editable.

## Verification Strategy

1. Unit test source activity detection with synthetic WAV files.
2. Unit test ordered transcript assembly from out-of-order source inputs.
3. Verify frontend renders source turn rows with labels and optional time ranges.
4. Run Rust, frontend, lint, and build checks.
5. Manually test a dual-source recording with alternating microphone and system speech.
6. Manually test that Done returns promptly to the editor while the note transitions through processing states.
7. Manually test writing notes during recording and confirm the generated note integrates transcript and manual notes without deleting user-written text.
