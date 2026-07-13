# Quickstart: Tauri Notes MVP

This quickstart describes the expected build/run/debug path once implementation begins. It is intentionally a plan artifact; commands may be finalized by `/speckit-tasks` and implementation.

## Prerequisites

- macOS development machine.
- Rust stable installed.
- Node.js and pnpm installed.
- Xcode command line tools installed.
- Microphone available and not blocked by macOS privacy settings.
- Optional provider credentials configured through local development environment variables when testing real transcription/generation.

## Planned Commands

```sh
pnpm install
pnpm tauri dev
pnpm test
pnpm test:rust
pnpm test:ui
pnpm tauri:build
```

Implementation should add scripts with these names or document any final equivalents in `README.md`.

## macOS Permission Debug Path

1. Confirm `src-tauri/tauri.conf.json` includes a microphone usage description for the app bundle.
2. Confirm `src-tauri/Entitlements.plist` includes the audio input entitlement needed by signed/sandboxed builds.
3. Run the dev app from `pnpm tauri:dev`.
4. Start a recording from a draft note and verify macOS prompts for microphone access if permission has not been granted.
5. If permission is denied, verify the UI shows a recovery hint.
6. For local reset during development, use macOS Privacy & Security settings or `tccutil reset Microphone <bundle-id>` when appropriate.

## Manual Scenario: Reliable Voice Note

1. Open the app.
2. Create a note from the list or empty state.
3. Start microphone recording.
4. Speak for at least 60 seconds.
5. Verify elapsed time, active state, and waveform movement.
6. Click Done.
7. Verify the app shows finalizing, validating, transcribing, generating, then ready.
8. Verify the note contains generated content and the Transcription tab contains raw transcript.
9. Verify a finalized audio artifact exists in app-local storage and has non-zero size.

Expected result: saved readable audio, transcript, generated note, and persisted metadata.

## Manual Scenario: Silent Input

1. Create a note.
2. Mute or disconnect microphone input if possible.
3. Record for at least 10 seconds.
4. Select Done and verify validation explains that the audio is unusable.
5. Click Done.

Expected result: validation fails or warns before provider processing, and the app does not generate a note from unusable audio.

## Manual Scenario: Provider Failure Retry

1. Record a valid spoken note.
2. Disable network before clicking Done, or configure a mock provider failure.
3. Click Done.
4. Verify audio finalization and validation still succeed locally.
5. Verify note status becomes failed with retry available.
6. Restore network/provider.
7. Retry processing.

Expected result: retry uses saved audio without requiring a new recording.

## Manual Scenario: Interrupted Recording Recovery

1. Start recording and speak until bytes are being written.
2. Force quit the app before clicking Done.
3. Reopen the app.
4. Verify the startup recovery scan surfaces a recoverable recording or note.
5. Choose validate if audio bytes are available.

Expected result: recoverable audio is preserved and can be validated or discarded intentionally.

## Manual Scenario: Folders and Editing

1. Create two folders.
2. Create multiple notes.
3. Assign notes to folders.
4. Verify All Notes shows every note in reverse chronological order.
5. Verify each folder shows assigned notes only.
6. Edit a generated note title and body.
7. Restart the app.

Expected result: folder assignments, edits, transcript, and processing states persist locally.
