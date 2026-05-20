# Implementation Plan: Audio Source Modes for Notes

**Branch**: `002-system-audio-source-mode` | **Date**: 2026-05-19 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-system-audio-source-mode/spec.md`

**Note**: This plan stops at Phase 2 planning. Implementation begins only after `/speckit-tasks` generates `tasks.md` and the user approves moving forward.

## Summary

Extend the existing notes-only Tauri MVP with a recording source mode control for `Microphone only` and `Microphone + system audio`. The implementation will preserve the current microphone-only path as the default and add macOS-first system audio capture as a separate source with separate local artifacts, permission readiness, lifecycle checkpoints, validation results, transcripts, warnings, recovery, and retry behavior. Transcription and generation remain batch-only after local capture is finalized and validated.

## Technical Context

**Language/Version**: Rust stable with Tauri v2 backend; TypeScript with React and Vite frontend; Swift or Rust macOS native bridge code for system audio capture where direct Rust support is insufficient. Rust minimum remains `>=1.77.2`.
**Primary Dependencies**: Existing Tauri v2, React, TypeScript, `@tauri-apps/api`, SQLite via `sqlx`, microphone capture via `cpal`, WAV validation via `hound`, checksums via `sha2`, provider adapters via `reqwest`. New native macOS system-audio capture should use Apple-supported system audio capture APIs and be owned by the Rust backend as a managed source, not called directly by the webview.
**Storage**: Existing local SQLite database plus migrations for recording source mode, source artifacts, source validations, source checkpoints, and source-labeled transcripts. Audio files remain app-local and move from one artifact per session to source-specific paths such as `recordings/{note_id}/{session_id}/microphone.wav` and `recordings/{note_id}/{session_id}/system.wav`, with `.partial` files during capture.
**Testing**: Existing `pnpm test`, `pnpm test:rust`, and `pnpm test:ui`; new Rust tests for source-mode state, source artifact validation, recovery, and retry; frontend tests for mode selection, permission blocking, per-source status, append behavior, and disabled mode switching while active; manual macOS validation for permissions and real system audio.
**Target Platform**: macOS-first Tauri desktop app. `Microphone only` remains the reliable default path. `Microphone + system audio` is supported only when the host macOS version, app signing state, permissions, and capture bridge are ready.
**Project Type**: Desktop app with local Rust backend and React webview frontend.
**Performance Goals**: Recorder UI remains responsive while rendering per-source levels; microphone-only reliability from the MVP is preserved; dual-source capture writes local evidence for both sources in at least 9 of 10 manual recordings with audible input; validation finishes before provider processing begins; notes list remains responsive with 500 local notes.
**Constraints**: Batch-only; no realtime transcript stream; no meeting object; no legacy workspace/auth/billing/calendar/chat/sharing surfaces; permissions are checked when selecting a mode and immediately before recording starts; multi-source start is atomic from the user's perspective; provider failures must not delete saved audio; one valid source may proceed with warnings for the failed source.
**Scale/Scope**: Single local user, one primary window, two recording source modes, two audio sources maximum per recording session, local-only persistence.

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

The project constitution currently contains placeholder principles only and defines no enforceable gates. This plan uses the feature specification as the controlling project guidance.

Pre-design gate status: PASS, with no active constitution constraints.

## Project Structure

### Documentation (this feature)

```text
specs/002-system-audio-source-mode/
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

### Source Code (repository root)

```text
package.json
pnpm-lock.yaml
vite.config.ts
tsconfig.json

src/
├── app/
│   ├── App.tsx
│   └── state/
├── components/
│   ├── note-editor/
│   ├── notes-list/
│   ├── recorder/
│   └── sidebar/
├── lib/
└── styles/

src-tauri/
├── Cargo.toml
├── Entitlements.plist
├── Info.plist
├── capabilities/
├── migrations/
├── src/
│   ├── audio/
│   │   ├── capture.rs
│   │   ├── recovery.rs
│   │   ├── validation.rs
│   │   ├── waveform.rs
│   │   └── system_macos.rs
│   ├── commands.rs
│   ├── db/
│   ├── domain/
│   └── providers/
├── native/
│   └── mac-system-audio-recorder/
└── tests/
```

**Structure Decision**: Keep the existing Tauri v2 layout. The frontend adds source-mode UI and per-source recorder state under `src/components/recorder/` and `src/app/state/`. The Rust backend remains authoritative for permissions, session state, audio lifecycle, validation, recovery, and provider calls. Any macOS system-audio helper or bridge is owned by `src-tauri` and exposed to the frontend only through typed Tauri commands.

## Phase 0: Research Decisions

See [research.md](./research.md). All planning unknowns are resolved there.

## Phase 1: Design Artifacts

See [data-model.md](./data-model.md), [contracts/commands.md](./contracts/commands.md), [contracts/ui.md](./contracts/ui.md), and [quickstart.md](./quickstart.md).

## Post-Design Constitution Check

The constitution remains placeholder-only and imposes no additional gates.

Post-design gate status: PASS.

## Complexity Tracking

No constitution violations are present.
