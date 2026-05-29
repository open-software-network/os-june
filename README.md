# OS Scribe

macOS-first Tauri MVP for local notes, reliable local audio recording, saved audio validation, batch transcription, and generated notes.

[![Phala Trust Center — TEE verified](https://img.shields.io/badge/Phala%20Trust%20Center-TEE%20verified-success)](https://trust.phala.com/app/15f8d2fd586da8b99c6082b3c2cba64127ceeb8c)

## Privacy

The `scribe-api` backend runs in an Intel TDX confidential VM on Phala Cloud. Because the running image is attested, neither Phala (the platform) nor Open Software (us) can quietly change it to read your audio, transcripts, or logs at runtime without that change being visible in the verification chain below:

- **Source** — this repository. The exact commit running in production is stamped into the image's OCI `org.opencontainers.image.revision` label.
- **Image** — built by [`build-scribe-api.yml`](.github/workflows/build-scribe-api.yml) and published to [`ghcr.io/open-software-network/scribe-api`](https://github.com/open-software-network/os-scribe/pkgs/container/scribe-api) as a plain single-arch image whose content digest is directly pullable. dstack cannot verify digest-pinned refs, so deploys pin an immutable per-commit tag (`:<sha>`); the digest each commit deploys is recorded in-repo as a signed `deploy/<env>/<sha>` git tag.
- **Attestation** — the [Phala Trust Center report](https://trust.phala.com/app/15f8d2fd586da8b99c6082b3c2cba64127ceeb8c) is third-party-verifiable proof that the image digest above is what's actually running inside a real Intel TDX confidential VM.

Together these bind the running image to a public commit: you can confirm the attested digest is the one our CI built and recorded for that commit. (Bit-for-bit *rebuild-from-source* reproducibility — so you can regenerate the digest yourself instead of trusting our CI — is in progress.)

Audio still leaves the TEE when forwarded to OpenAI or Venice for transcription, under those providers' own privacy policies. This chain verifies the **code** running in the confidential VM, not what upstream providers do with audio. End-to-end private STT is a separate workstream.

## Development

```sh
pnpm install
pnpm tauri:dev
```

The desktop app talks to Scribe API for transcription, dictation cleanup,
model listing, and note generation. Provider API keys belong only in the
Scribe API server env; never put OpenAI, Venice, or OS Accounts App API keys in
the root desktop `.env`.

```sh
cp .env.example .env
# edit SCRIBE_API_URL and OS Accounts client settings when needed
```

Run the local Scribe API separately when pointing the desktop app at
`http://127.0.0.1:8080`:

```sh
cp scribe-api/.env.example scribe-api/.env
# fill SCRIBE__OS_ACCOUNTS__APP_API_KEY, SCRIBE__UPSTREAMS__OPENAI__API_KEY,
# and SCRIBE__UPSTREAMS__VENICE__API_KEY in scribe-api/.env
(cd scribe-api && cargo run -- serve)
```

Restart `pnpm tauri:dev` after changing the root `.env`; the running Tauri
process does not reload client configuration.

Optional initial model defaults:

```sh
export VENICE_TRANSCRIPTION_MODEL=nvidia/parakeet-tdt-0.6b-v3
export VENICE_GENERATION_MODEL=zai-org-glm-5
export VENICE_TITLE_SUGGESTION_MODEL=nvidia-nemotron-3-nano-30b-a3b
```

The Settings tab can load available Venice models and save separate selections for transcription/dictation and note generation. Saved selections are stored in the app config directory and take effect for new provider requests.

The app data directory is resolved by Tauri at runtime. In development, inspect the platform app data path for:

- `notes.sqlite3`
- `recordings/{note_id}/{session_id}.wav`
- `recordings/{note_id}/{session_id}/microphone.wav`
- `recordings/{note_id}/{session_id}/system.wav` when `Microphone + system audio` is selected

## Dictation

Dictation is paste-only: it does not create notes or store transcript records. Choose a dictation shortcut and an activation mode in Settings. Push-to-talk records while the shortcut is held and stops when it is released. Toggle starts or stops dictation each time the shortcut is pressed. OS Scribe transcribes the temporary m4a recording through the same Rust transcription provider used by note recording. On success, the helper temporarily places the transcript on the clipboard, activates the last focused external app, posts Cmd+V, and restores the previous clipboard when possible.

Dictation requires a reachable Scribe API and a signed-in OS Accounts user.
The selected transcription and cleanup models are executed server-side through
Scribe API, so missing provider keys surface in the Scribe API logs rather than
the desktop process.

The default shortcut is bare `Fn`/Globe and the default activation mode is `Push-to-talk`. If macOS opens emoji, input-source, or system dictation UI when pressing Fn, set System Settings > Keyboard > "Press Fn key to" or "Press Globe key to" to `Do Nothing`. Settings records the shortcut you press, including bare `Fn`/Globe, `Fn+Space`, or another shortcut with Cmd, Ctrl, Opt, Shift, or Fn plus one supported non-modifier key. Push-to-talk for custom shortcuts depends on macOS exposing both key-down and key-up events for that shortcut.

Manual validation:

1. Launch Scribe API with OS Accounts, OpenAI, and Venice env configured.
2. Grant microphone and Accessibility permissions.
3. Focus a text field in TextEdit, VS Code, or a browser.
4. In Settings, press Change, record `Fn`/Globe, and choose `Push-to-talk`.
5. Hold Fn/Globe to start dictation.
6. Speak a short sentence.
7. Release Fn/Globe to stop, transcribe, and paste.
8. Switch activation mode to `Toggle`.
9. Press Fn/Globe once to start dictation, then press it again to stop.
10. Confirm the HUD transitions through listening, transcribing, pasting, and success.
11. Confirm the transcript appears in the original focused text field.
12. Select a microphone in Settings, restart, and confirm the selection persists.

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
tccutil reset Microphone co.opensoftware.scribe
```

System-audio permission is checked when selecting `Microphone + system audio` and immediately before recording starts. If macOS blocks it, open Privacy & Security and allow audio capture for OS Scribe or the OS Scribe Audio Capture helper, then restart the app.

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
