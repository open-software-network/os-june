# Quickstart: Audio Source Modes for Notes

This quickstart describes the expected build, run, and manual verification path once implementation begins. It is a planning artifact; `/speckit-tasks` should turn these scenarios into implementation tasks.

## Prerequisites

- macOS development machine.
- Rust stable installed.
- Node.js and pnpm installed.
- Xcode command line tools installed.
- Microphone available and not blocked by macOS privacy settings.
- Audible system audio source for manual dual-source testing, such as a browser video or meeting playback.
- Provider credentials configured through local environment variables when testing real transcription/generation.

## Planned Commands

```sh
pnpm install
pnpm tauri:dev
pnpm test
pnpm test:rust
pnpm test:ui
pnpm tauri:build
```

## macOS Permission Debug Path

1. Confirm `src-tauri/Info.plist` includes `NSMicrophoneUsageDescription`.
2. Confirm `src-tauri/Entitlements.plist` includes the microphone entitlement required by signed or sandboxed builds.
3. Confirm the planned system-audio bridge has the permission metadata, signing behavior, and runtime checks required by the selected macOS capture API.
4. Run the dev app with `pnpm tauri:dev`.
5. Select `Microphone only` and verify microphone readiness.
6. Select `Microphone + system audio` and verify microphone plus system-audio readiness.
7. If permission is denied, verify Start is blocked and the UI names the failing source.
8. During development, reset microphone permission with macOS Privacy & Security settings or `tccutil reset Microphone <bundle-id>` when appropriate. System-audio permissions should be reset and inspected through the relevant macOS Privacy & Security pane for the target macOS version.

## Manual Scenario: Microphone-Only Regression

1. Open the app.
2. Create a note.
3. Keep source mode set to `Microphone only`.
4. Record at least 30 seconds of speech.
5. Verify elapsed time, waveform movement, bytes-written evidence, Pause, Resume, and Done.
6. Click Done.
7. Verify local validation, transcription, generation, and editable note output.

Expected result: existing microphone-only behavior remains reliable and saves a readable microphone audio artifact.

## Manual Scenario: Permission Blocking

1. Deny microphone permission or system-audio permission from macOS settings.
2. Select the source mode requiring the denied permission.
3. Attempt to start recording.

Expected result: the app does not enter recording state, does not create misleading active UI, and shows a source-specific recovery message.

## Manual Scenario: Microphone Plus System Audio

1. Start audible system audio.
2. Create a note.
3. Select `Microphone + system audio`.
4. Verify both sources show ready state.
5. Start recording and speak while system audio continues.
6. Verify per-source activity and local-write evidence.
7. Pause and resume.
8. Click Done.
9. Verify both source artifacts finalize and validate independently.
10. Verify the Transcription tab has source-labeled text.
11. Verify generated note content uses valid source transcripts and appends to any existing note content.

Expected result: saved readable local artifacts for both sources, source-labeled transcript, generated note, and persisted metadata.

## Manual Scenario: One Silent or Failed Source

1. Select `Microphone + system audio`.
2. Make one source silent while the other contains audible content.
3. Record and click Done.

Expected result: validation marks the silent or failed source clearly, generation proceeds only from the valid source, and the UI shows a source-specific warning.

## Manual Scenario: No Valid Source

1. Select either mode.
2. Record only silence or force both source artifacts to fail validation.
3. Click Done.

Expected result: the app does not generate a note and preserves recoverable artifact state for retry or discard when bytes exist.

## Manual Scenario: Interrupted Dual-Source Recovery

1. Select `Microphone + system audio`.
2. Start recording while microphone and system audio are audible.
3. Wait until both sources show bytes-written evidence.
4. Force quit the app before clicking Done.
5. Reopen the app.

Expected result: recovery surfaces source-aware state, showing which sources have partial or finalized bytes and allowing validate or discard.

## Manual Scenario: Provider Failure Retry

1. Record a valid dual-source note.
2. Disable network or configure a provider failure before processing.
3. Verify local validation still succeeds.
4. Restore provider configuration.
5. Retry processing.

Expected result: retry uses saved source artifacts and the persisted recording source mode without requiring a new recording.
