# Tasks: Tauri Notes MVP

**Input**: Design documents from `/specs/001-tauri-note-mvp/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included because the spec defines mandatory independent tests and recording reliability is the core MVP risk. Test tasks come before the implementation tasks they validate.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Initialize the Tauri/React/Rust project skeleton and shared development entrypoints.

- [x] T001 Create root TypeScript/Vite/Tauri project files in package.json, tsconfig.json, vite.config.ts, index.html, and src-tauri/Cargo.toml
- [x] T002 Create Tauri app configuration, scoped main-window capability, macOS microphone metadata, and entitlements in src-tauri/tauri.conf.json, src-tauri/capabilities/main.json, and src-tauri/Entitlements.plist
- [x] T003 [P] Create frontend source skeleton in src/main.tsx, src/app/App.tsx, src/styles/app.css, and src/lib/tauri.ts
- [x] T004 [P] Create Rust module skeleton in src-tauri/src/main.rs, src-tauri/src/lib.rs, src-tauri/src/commands.rs, src-tauri/src/app_paths.rs, src-tauri/src/db/mod.rs, src-tauri/src/domain/mod.rs, src-tauri/src/audio/mod.rs, and src-tauri/src/providers/mod.rs
- [x] T005 Create repository ignore and README development entrypoints in .gitignore and README.md

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared data, command, error, and persistence foundations that all stories depend on.

**Critical**: No user story implementation starts until this phase is complete.

- [x] T006 [P] Add backend DTOs and structured error types matching contracts/commands.md in src-tauri/src/domain/types.rs
- [x] T007 [P] Add frontend DTO types and command wrappers matching contracts/commands.md in src/lib/tauri.ts
- [x] T008 Add SQLite schema and migration runner for notes, folders, recording sessions, checkpoints, audio artifacts, transcripts, and generation results in src-tauri/migrations/001_init.sql and src-tauri/src/db/migrations.rs
- [x] T009 Add repository functions for folders, notes, recording sessions, checkpoints, audio artifacts, transcripts, and generation results in src-tauri/src/db/repositories.rs
- [x] T010 Add app path resolution and app-local data directory creation for SQLite and recordings in src-tauri/src/app_paths.rs
- [x] T011 Add bootstrap_app command with database initialization, migrations, initial notes/folders load, and recovery scan hook in src-tauri/src/commands.rs and src-tauri/src/lib.rs
- [x] T012 [P] Add Rust storage tests for migrations, note creation, folder assignment, and reverse chronological listing in src-tauri/tests/storage.rs
- [x] T013 [P] Add frontend state reducer tests for bootstrap, selection, autosave updates, and recording status transitions in src/test/app-state.test.ts

**Checkpoint**: Foundation ready; user story implementation can begin.

---

## Phase 3: User Story 1 - Capture a Reliable Voice Note (Priority: P1) MVP

**Goal**: User can create a note, record microphone audio, see active recording evidence, finish recording, validate saved audio, transcribe it, and generate note content.

**Independent Test**: Record a 60-second spoken note, stop it, and verify saved readable audio, transcript, and generated note content.

### Tests for User Story 1

- [x] T014 [P] [US1] Add audio validation tests for readable WAV, zero-byte file, duration mismatch, too-short audio, and silence detection in src-tauri/tests/recording_validation.rs
- [x] T015 [P] [US1] Add provider pipeline tests for mock transcription, empty transcript failure, generated-note constraints, and retryable provider failure in src-tauri/tests/processing.rs
- [x] T016 [P] [US1] Add frontend recorder component tests for elapsed state, waveform levels, pause/resume, Done, suppressed live silence prompts, and failed validation in src/test/recorder.test.tsx

### Implementation for User Story 1

- [x] T017 [US1] Implement audio validation for file existence, non-zero size, readable WAV, duration tolerance, RMS/peak signal, silence windows, and checksum in src-tauri/src/audio/validation.rs
- [x] T018 [US1] Implement microphone-only WAV capture with pause/resume, elapsed time, bytes written, level samples, and checkpoint writes in src-tauri/src/audio/capture.rs
- [x] T019 [US1] Implement recording commands get_microphone_permission_state, start_recording, pause_recording, resume_recording, get_recording_status, and finish_recording in src-tauri/src/commands.rs
- [x] T020 [US1] Implement mock-first transcription and generation providers with optional environment-backed real provider seams in src-tauri/src/providers/transcription.rs, src-tauri/src/providers/generation.rs, and src-tauri/src/providers/mock.rs
- [x] T021 [US1] Implement processing orchestration that validates audio before transcription/generation, persists statuses, preserves audio on failure, and emits note updates in src-tauri/src/domain/processing.rs
- [x] T022 [US1] Implement frontend app shell, note creation flow, editor shell, recording controls, waveform visualization, and status rendering in src/app/App.tsx, src/components/note-editor/NoteEditor.tsx, src/components/recorder/RecorderBar.tsx, and src/components/recorder/Waveform.tsx
- [x] T023 [US1] Apply Liquid Glass-inspired macOS polish with accessible fallback surfaces for sidebar, editor, and recorder controls in src/styles/app.css

**Checkpoint**: User Story 1 is functional and independently testable.

---

## Phase 4: User Story 2 - Organize Notes by Folder (Priority: P2)

**Goal**: User can browse All Notes, create folders, assign notes to folders, and view folder-filtered notes.

**Independent Test**: Create two folders, create multiple notes, assign notes, and verify All Notes plus folder views.

### Tests for User Story 2

- [x] T024 [P] [US2] Add folder repository and command tests for create_folder, assign_note_to_folder, remove_note_from_folder, duplicate names, and All Notes visibility in src-tauri/tests/folders.rs
- [x] T025 [P] [US2] Add frontend sidebar and note-list tests for empty states, All Notes ordering, folder filtering, and assignment controls in src/test/folders.test.tsx

### Implementation for User Story 2

- [x] T026 [US2] Implement folder commands create_folder, list_folders, assign_note_to_folder, and remove_note_from_folder in src-tauri/src/commands.rs
- [x] T027 [US2] Implement sidebar, note list, empty states, folder creation, folder filtering, and folder assignment UI in src/components/sidebar/Sidebar.tsx, src/components/notes-list/NotesList.tsx, and src/components/note-editor/FolderPicker.tsx
- [x] T028 [US2] Ensure local folder changes autosave and update All Notes/folder views without legacy workspace, auth, meeting, calendar, billing, chat, sharing, or system-audio controls in src/app/App.tsx

**Checkpoint**: User Stories 1 and 2 work independently.

---

## Phase 5: User Story 3 - Review and Edit Generated Notes (Priority: P3)

**Goal**: User can inspect generated notes and raw transcript, switch tabs, edit title/body, and persist edits.

**Independent Test**: Open a generated note, switch tabs, edit title/body, restart, and verify persistence.

### Tests for User Story 3

- [x] T029 [P] [US3] Add backend note update tests for title, edited content, active tab, transcript retrieval, and failed-transcript retry state in src-tauri/tests/notes.rs
- [x] T030 [P] [US3] Add frontend editor tests for Notes/Transcription tabs, scrollable long transcript, autosave, and retry affordance in src/test/note-editor.test.tsx

### Implementation for User Story 3

- [x] T031 [US3] Implement get_note, update_note, list_notes pagination/cursor behavior, and retry_processing command support in src-tauri/src/commands.rs
- [x] T032 [US3] Implement editable title/body autosave, Notes/Transcription tabs, long transcript scrolling, failed transcript messaging, and retry actions in src/components/note-editor/NoteEditor.tsx
- [x] T033 [US3] Preserve raw transcript as source context after user edits and keep generated/edited content semantics clear in src-tauri/src/db/repositories.rs and src/app/App.tsx

**Checkpoint**: User Stories 1, 2, and 3 work independently.

---

## Phase 6: User Story 4 - Recover from Interrupted Recording (Priority: P4)

**Goal**: User does not lose recoverable audio if the app closes, crashes, or loses network after recording starts.

**Independent Test**: Start recording, force quit after audio bytes are written, reopen, and verify recoverable audio is surfaced.

### Tests for User Story 4

- [x] T034 [P] [US4] Add recovery tests for active session scan, partial/final file reconciliation, recoverable status, discard action, and retryable saved audio in src-tauri/tests/recovery.rs
- [x] T035 [P] [US4] Add frontend recovery tests for startup recoverable banner, validate/discard actions, and processing retry after network failure in src/test/recovery.test.tsx

### Implementation for User Story 4

- [x] T036 [US4] Implement recovery scanner for interrupted recording, validating, transcribing, generating, failed, and recoverable states in src-tauri/src/audio/recovery.rs
- [x] T037 [US4] Implement recover_recording command and retry behavior from saved audio/transcript in src-tauri/src/commands.rs and src-tauri/src/domain/processing.rs
- [x] T038 [US4] Implement startup recoverable recording UI with validate/discard/retry actions in src/app/App.tsx and src/components/recorder/RecoveryBanner.tsx

**Checkpoint**: All MVP user stories work independently.

---

## Phase 7: Polish & Cross-Cutting Validation

**Purpose**: Verify the complete MVP against reliability, macOS, and documentation requirements.

- [x] T039 [P] Add npm scripts and documentation for dev, build, Rust tests, UI tests, quickstart scenarios, microphone permission debugging, and Tauri app data paths in package.json and README.md
- [x] T040 [P] Add manual validation checklist for 20 recording runs, silent input, network failure retry, 500-note responsiveness, long transcript scrolling, and interrupted recording recovery in specs/001-tauri-note-mvp/manual-validation.md
- [x] T041 Run formatting, linting, Rust tests, TypeScript tests, Tauri build checks, and fix any failures across the repository
- [x] T042 Run the quickstart scenarios that can be automated or locally verified, document any manual-only items, and confirm tasks/spec/plan remain aligned in specs/001-tauri-note-mvp/tasks.md

---

## Dependencies & Execution Order

### Phase Dependencies

- Setup (Phase 1): no dependencies.
- Foundational (Phase 2): depends on Setup and blocks every user story.
- User Story 1 (Phase 3): depends on Foundational and is the MVP slice.
- User Story 2 (Phase 4): depends on Foundational and integrates with notes from US1.
- User Story 3 (Phase 5): depends on Foundational and the note/transcript data from US1.
- User Story 4 (Phase 6): depends on Foundational and recording state from US1.
- Polish (Phase 7): depends on all targeted stories.

### User Story Dependencies

- US1 can start after Foundation and has no dependency on other stories.
- US2 can start after Foundation but must preserve US1 note visibility.
- US3 can start after Foundation but requires US1 transcript/generation data to fully verify.
- US4 can start after US1 recording state exists.

### Within Each User Story

- Tests first, then implementation.
- Models and repositories before commands.
- Backend commands before frontend command integration.
- Recording validation before provider processing.
- Core behavior before visual polish.
- Mark each completed task as `[X]` in this file immediately after completion.

## Parallel Opportunities

- T003 and T004 can run in parallel after T001/T002 path decisions.
- T006, T007, T012, and T013 affect different files and can run in parallel after setup.
- US1 tests T014, T015, and T016 can be written in parallel.
- US2 tests T024 and T025 can be written in parallel.
- US3 tests T029 and T030 can be written in parallel.
- US4 tests T034 and T035 can be written in parallel.
- Polish docs T039 and T040 can run in parallel after implementation stabilizes.

## Parallel Example: User Story 1

```bash
# Backend validation and provider tests can be developed independently:
cargo test --test recording_validation
cargo test --test processing

# Frontend recorder tests can run separately:
pnpm test -- src/test/recorder.test.tsx
```

## Implementation Strategy

1. Deliver the MVP slice first: Setup, Foundation, then US1 recording through generated note.
2. Add folders (US2) without expanding scope into workspaces or accounts.
3. Add editing and transcript review (US3) on top of persisted notes/transcripts.
4. Add interrupted recording recovery (US4) as reliability hardening.
5. Finish with full verification and manual validation documentation.

## Completion Evidence

Verified on 2026-05-19:

- `pnpm format`
- `pnpm lint`
- `pnpm test`
- `pnpm test:ui`
- `pnpm build`
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `pnpm tauri:build`
- `git diff --check`

The automated quickstart path is covered by the commands above. Manual-only scenarios are documented in `manual-validation.md` because they require real microphone input, macOS privacy prompts, forced app termination, provider/network manipulation, or sustained interactive performance observation.
