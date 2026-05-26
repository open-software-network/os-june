# OS Notetaker

macOS-first Tauri MVP for local notes, reliable local audio recording, saved audio validation, batch transcription, and generated notes.

## Development

```sh
pnpm install
pnpm tauri:dev
```

Real transcription and note generation require an OpenAI API key in the shell that launches Tauri:

```sh
export OPENAI_API_KEY="..."
pnpm tauri:dev
```

For local development, the Rust backend also loads `.env` from the repository root:

```sh
cp .env.example .env
# edit OPENAI_API_KEY in .env
pnpm tauri:dev
```

Restart `pnpm tauri:dev` after changing `.env`; the running Tauri process does not reload provider configuration.

Without `OPENAI_API_KEY`, the app stays in local mock mode for offline recording and recovery verification. To force mock mode even when a key is present:

```sh
OS_NOTETAKER_PROVIDER=mock pnpm tauri:dev
```

Optional model overrides:

```sh
export OS_NOTETAKER_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
export OS_NOTETAKER_GENERATION_MODEL=gpt-5.2
```

The app data directory is resolved by Tauri at runtime. In development, inspect the platform app data path for:

- `notes.sqlite3`
- `recordings/{note_id}/{session_id}.wav`
- `recordings/{note_id}/{session_id}/microphone.wav`
- `recordings/{note_id}/{session_id}/system.wav` when `Microphone + system audio` is selected

## Dictation

Dictation is paste-only: it does not create notes or store transcript records. Choose a dictation shortcut and an activation mode in Dictation settings. Push-to-talk records while the shortcut is held and stops when it is released. Toggle starts or stops dictation each time the shortcut is pressed. OS Scribe transcribes the temporary m4a recording through the same Rust transcription provider used by note recording. On success, the helper temporarily places the transcript on the clipboard, activates the last focused external app, posts Cmd+V, and restores the previous clipboard when possible.

Dictation requires real transcription. If `OPENAI_API_KEY` is not visible to the Tauri process, dictation reports a configuration error instead of pasting the local mock transcript used by offline note-recording tests. During development, put the key in `.env` or export it in the shell before running `pnpm tauri:dev`.

The default shortcut is bare `Fn`/Globe and the default activation mode is `Push-to-talk`. If macOS opens emoji, input-source, or system dictation UI when pressing Fn, set System Settings > Keyboard > "Press Fn key to" or "Press Globe key to" to `Do Nothing`. The Dictation settings page can switch back to `Fn+Space` or save another shortcut with Cmd, Ctrl, Opt, or Shift plus one supported non-modifier key. Push-to-talk for custom shortcuts depends on macOS exposing both key-down and key-up events for that shortcut.

Manual validation:

1. Launch with `OPENAI_API_KEY` configured.
2. Grant microphone and Accessibility permissions.
3. Focus a text field in TextEdit, VS Code, or a browser.
4. In Dictation settings, choose `Fn / Globe` and `Push-to-talk`.
5. Hold Fn/Globe to start dictation.
6. Speak a short sentence.
7. Release Fn/Globe to stop, transcribe, and paste.
8. Switch activation mode to `Toggle`.
9. Press Fn/Globe once to start dictation, then press it again to stop.
10. Confirm the HUD transitions through listening, transcribing, pasting, and success.
11. Confirm the transcript appears in the original focused text field.
12. Select a microphone in Dictation settings, restart, and confirm the selection persists.

## macOS Audio Permission Debugging

The macOS bundle includes:

- `NSMicrophoneUsageDescription` in `src-tauri/Info.plist`
- `NSAudioCaptureUsageDescription` in `src-tauri/Info.plist`
- `com.apple.security.device.audio-input` in `src-tauri/Entitlements.plist`

The `Microphone only` mode is the default. The `Microphone + system audio` mode uses a small macOS helper built by `src-tauri/build.rs` into `.tauri-helper/` during `pnpm tauri:dev`, `pnpm test:rust`, or `pnpm tauri:build`. Generated helper binaries are ignored by git and kept outside `src-tauri` so Tauri dev does not restart on its own generated files.

Dictation uses a separate macOS helper built into `.tauri-helper/OS Scribe Dictation Helper.app`. It needs microphone permission for capture and Accessibility permission to post the paste shortcut into the previously focused app.

Local `pnpm tauri:build` output is ad-hoc signed unless a signing identity is configured. Before distribution, verify the signed bundle embeds the expected entitlements:

```sh
codesign -dvvv --entitlements :- "src-tauri/target/release/bundle/macos/OS Notetaker.app"
```

If permission is denied during local testing, reset it from macOS Privacy & Security settings or with:

```sh
tccutil reset Microphone network.opensoftware.os-notetaker
```

System-audio permission is checked when selecting `Microphone + system audio` and immediately before recording starts. If macOS blocks it, open Privacy & Security and allow audio capture for OS Notetaker or the OS Notetaker Audio Capture helper, then restart the app.

## Verification

```sh
pnpm lint
pnpm test
pnpm test:rust
pnpm build
pnpm tauri:build
```

Manual recording reliability checks are tracked in `specs/001-tauri-note-mvp/manual-validation.md`.
Source-mode validation scenarios are tracked in `specs/002-system-audio-source-mode/quickstart.md`.
