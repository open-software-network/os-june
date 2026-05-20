# Tasks: Audio Source Modes for Notes

**Input**: Design documents from `/specs/002-system-audio-source-mode/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/
**Tests**: Required by the user request to keep the feature reliable; write behavior tests before implementation where practical.
**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare shared code and configuration for source-aware recording.

- [x] T001 Verify ignored generated artifacts and native helper outputs in `.gitignore`
- [x] T002 [P] Add source-mode TypeScript DTOs and command wrappers in `src/lib/tauri.ts`
- [x] T003 [P] Add source-mode Rust DTOs and enums in `src-tauri/src/domain/types.rs`
- [x] T004 Add macOS system-audio usage text and helper build path planning in `src-tauri/Info.plist`, `src-tauri/tauri.conf.json`, and `src-tauri/build.rs`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared persistence, capture abstractions, and processing support required by all stories.

**CRITICAL**: No user story work begins until this phase is complete.

- [x] T005 [P] Add Rust repository tests for source-mode session persistence in `src-tauri/tests/source_modes.rs`
- [x] T006 [P] Add Rust processing tests for labeled transcript generation and valid-source filtering in `src-tauri/tests/source_processing.rs`
- [x] T007 Add SQLite migration for source mode, source artifacts, source checkpoints, and source-labeled transcripts in `src-tauri/migrations/002_source_modes.sql`
- [x] T008 Extend repository methods for source sessions, artifacts, checkpoints, recoveries, and transcripts in `src-tauri/src/db/repositories.rs`
- [x] T009 Add source-aware audio validation aggregation helpers in `src-tauri/src/audio/validation.rs`
- [x] T010 Add source-aware processing helpers for labeled transcripts, generation input, and retry in `src-tauri/src/domain/processing.rs`
- [x] T011 Run the foundational Rust tests and confirm the new tests fail before implementation, then pass after T007-T010

---

## Phase 3: User Story 1 - Choose the Recording Source Before Capture (Priority: P1)

**Goal**: User can select `Microphone only` or `Microphone + system audio`, see readiness, and be blocked before capture if required permissions are unavailable.

**Independent Test**: Switch modes before recording and verify readiness appears; simulate denied/unavailable source and verify recording does not start.

### Tests for User Story 1

- [x] T012 [P] [US1] Add frontend tests for source mode selection, disabled mode changes while active, and readiness messages in `src/test/recorder-source-mode.test.tsx`
- [x] T013 [P] [US1] Add Rust command tests for readiness and blocked starts in `src-tauri/tests/source_readiness.rs`

### Implementation for User Story 1

- [x] T014 [US1] Implement `check_recording_source_readiness` and source-mode start request handling in `src-tauri/src/commands.rs`
- [x] T015 [US1] Add macOS system-audio readiness module and unsupported fallback behavior in `src-tauri/src/audio/system_macos.rs`
- [x] T016 [US1] Wire Tauri command registration for readiness and source-mode recording in `src-tauri/src/lib.rs`
- [x] T017 [US1] Add source mode UI state and readiness flow in `src/app/App.tsx` and `src/app/state/app-state.ts`
- [x] T018 [US1] Add source mode segmented control and readiness/error display in `src/components/recorder/RecorderBar.tsx` and `src/components/note-editor/NoteEditor.tsx`
- [x] T019 [US1] Run US1 frontend and Rust tests, then mark the story complete only after they pass

---

## Phase 4: User Story 2 - Capture Notes from Microphone and System Audio (Priority: P1)

**Goal**: User records in dual-source mode, local artifacts are created per source, validation happens per source, transcripts are labeled, and generated notes append.

**Independent Test**: Record with audible mic and system audio, click Done, and verify two local artifacts, labeled transcript sections, and appended generated content.

### Tests for User Story 2

- [x] T020 [P] [US2] Add Rust capture lifecycle tests for dual-source status, pause/resume, finalization, and validation aggregation in `src-tauri/tests/source_capture.rs`
- [x] T021 [P] [US2] Add frontend tests for per-source active indicators and source warnings in `src/test/recorder-source-status.test.tsx`

### Implementation for User Story 2

- [x] T022 [US2] Refactor microphone capture into a source-aware active session in `src-tauri/src/audio/capture.rs`
- [x] T023 [US2] Add macOS helper source, build script, and process manager for system audio capture in `src-tauri/native/mac-system-audio-recorder/main.swift`, `src-tauri/build.rs`, and `src-tauri/src/audio/system_macos.rs`
- [x] T024 [US2] Implement dual-source start, pause, resume, status, finish, validation, and partial-source warnings in `src-tauri/src/audio/capture.rs` and `src-tauri/src/commands.rs`
- [x] T025 [US2] Persist source artifacts and source-labeled transcripts from finished recordings in `src-tauri/src/db/repositories.rs` and `src-tauri/src/domain/processing.rs`
- [x] T026 [US2] Render per-source levels, bytes, silence warnings, source labels, and labeled transcript content in `src/components/recorder/RecorderBar.tsx`, `src/components/recorder/Waveform.tsx`, and `src/components/note-editor/NoteEditor.tsx`
- [x] T027 [US2] Run US2 frontend and Rust tests, then mark the story complete only after they pass

---

## Phase 5: User Story 3 - Recover and Retry Multi-Source Recordings (Priority: P2)

**Goal**: Interrupted dual-source recordings preserve recoverable source artifacts and retry uses saved source artifacts without re-recording.

**Independent Test**: Start dual-source recording, force quit after bytes are written, reopen, validate recoverable sources, and retry failed processing from saved artifacts.

### Tests for User Story 3

- [x] T028 [P] [US3] Add Rust recovery tests for source-aware partial/finalized artifacts in `src-tauri/tests/source_recovery.rs`
- [x] T029 [P] [US3] Add frontend recovery banner tests for source-aware recoveries in `src/test/recovery-source-mode.test.tsx`

### Implementation for User Story 3

- [x] T030 [US3] Extend recovery scanning and discard/validate actions for source artifacts in `src-tauri/src/audio/recovery.rs` and `src-tauri/src/commands.rs`
- [x] T031 [US3] Extend retry processing to reuse valid source artifacts and persisted source mode in `src-tauri/src/domain/processing.rs`
- [x] T032 [US3] Render source-aware recovery information and retry warnings in `src/components/recorder/RecoveryBanner.tsx` and `src/components/note-editor/NoteEditor.tsx`
- [x] T033 [US3] Run US3 frontend and Rust tests, then mark the story complete only after they pass

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: End-to-end verification, docs, and app readiness.

- [x] T034 Update manual validation docs and quickstart references for source mode testing in `specs/002-system-audio-source-mode/quickstart.md` and `README.md`
- [x] T035 Run full frontend tests with `pnpm test`
- [x] T036 Run full Rust tests with `pnpm test:rust`
- [x] T037 Run TypeScript build/lint with `pnpm run lint`
- [x] T038 Run Tauri build with `pnpm tauri:build`
- [x] T039 Run `git diff --check` and final spec alignment review against `specs/002-system-audio-source-mode/spec.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories.
- **US1 and US2 (P1)**: Depend on Foundational. Implement US1 first because readiness and mode selection are required before dual-source capture.
- **US3 (P2)**: Depends on source artifact lifecycle from US2.
- **Polish**: Depends on selected user stories being complete.

### User Story Dependencies

- **US1**: No dependency on other user stories after Foundational.
- **US2**: Depends on US1 command and UI source-mode contract.
- **US3**: Depends on US2 source artifacts and source-labeled processing.

### Parallel Opportunities

- T002 and T003 can be done in parallel.
- T005 and T006 can be done in parallel.
- T012 and T013 can be done in parallel.
- T020 and T021 can be done in parallel.
- T028 and T029 can be done in parallel.

## Implementation Strategy

1. Complete Setup and Foundational tasks.
2. Complete US1 so source selection and permission blocking are testable.
3. Complete US2 so dual-source recording and labeled generation are testable.
4. Complete US3 so recovery and retry are source-aware.
5. Run all verification commands before reporting readiness for user testing.
