# Manual Validation: Tauri Notes MVP

Use this checklist after automated tests and local build checks pass.

## Automated and Local Build Verification

Verified on 2026-05-19:

- [x] `pnpm format`
- [x] `pnpm lint`
- [x] `pnpm test`
- [x] `pnpm test:ui`
- [x] `pnpm build`
- [x] `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
- [x] `cargo test --manifest-path src-tauri/Cargo.toml`
- [x] `pnpm tauri:build`
- [x] `git diff --check`
- [x] Built bundle `Info.plist` contains `NSMicrophoneUsageDescription`.
- [x] Local bundle signing inspected: current local build is ad-hoc signed; distribution signing must be re-verified with a signing identity before release.

Manual-only because they require real microphone input, macOS privacy prompts, forced app termination, provider/network manipulation, or sustained interactive performance observation:

- Signed distribution entitlement verification.
- 20 consecutive spoken recording runs.
- Silent input recording.
- Provider failure and retry from saved audio.
- Interrupted recording recovery after force quit.
- 500-note responsiveness smoke check.
- Long transcript scrolling with a real 10,000-character transcript.

## Recording Reliability

- [ ] Run 20 consecutive microphone recordings of at least 30 seconds each with audible speech.
- [ ] Confirm every run creates a readable local WAV file.
- [ ] Confirm every run records non-zero file size, duration, checksum, RMS/peak signal, and validation metadata.
- [ ] Confirm the UI clearly shows recording, pause, validation, transcription, generation, ready, and failed states.

## Silent Input

- [ ] Mute or disconnect microphone input.
- [ ] Record for at least 10 seconds.
- [ ] Confirm the UI warns that microphone input appears silent.
- [ ] Confirm Done does not generate a note from unusable audio.

## Network/Provider Failure Retry

- [ ] Record valid audio.
- [ ] Force provider failure or disable network before processing.
- [ ] Confirm audio finalization and validation succeed locally.
- [ ] Confirm retry uses saved audio and does not require another recording.

## Interrupted Recording Recovery

- [ ] Start recording and confirm bytes are being written.
- [ ] Force quit before Done.
- [ ] Reopen the app.
- [ ] Confirm a recoverable recording is surfaced with validate and discard actions.

## Notes, Folders, and Editing

- [ ] Create at least two folders.
- [ ] Create multiple notes and assign notes to folders.
- [ ] Confirm All Notes keeps every note in reverse chronological order.
- [ ] Confirm folder views show assigned notes only.
- [ ] Edit title and body, restart, and confirm edits persisted.
- [ ] Open a transcript of at least 10,000 characters and confirm scrolling remains responsive.

## Scale Smoke

- [ ] Seed or create 500 local notes.
- [ ] Confirm sidebar, All Notes, folder selection, and note editor remain responsive.
