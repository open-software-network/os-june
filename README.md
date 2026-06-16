# June

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/os-june-dark.svg">
    <img src="public/os-june-light.svg" alt="June" width="122" height="36">
  </picture>
</p>

<p align="center">
  A private desktop AI assistant for meeting notes, dictation, and agent work.
</p>

<p align="center">
  <a href="https://trust.phala.com/app/15f8d2fd586da8b99c6082b3c2cba64127ceeb8c">
    <img alt="Phala Trust Center - TEE verified" src="https://img.shields.io/badge/Phala%20Trust%20Center-TEE%20verified-success">
  </a>
  <img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue">
  <img alt="Built with Tauri" src="https://img.shields.io/badge/desktop-Tauri-orange">
</p>

June is an open source desktop app for turning spoken work into useful work. It
records reliable local audio, generates editable meeting notes, pastes cleaned
dictation into any app, and runs a local agent that can help with files,
research, drafts, and routines.

The product is designed around a simple privacy contract: your app state,
recordings, transcripts, files, sessions, and agent memory live on your machine
by default. When June needs model inference, requests go through Scribe API, a
TEE-attested backend that keeps provider keys server-side and routes private
model calls through Venice by default.

## What June does

| Area               | What it does                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meeting notes      | Records microphone or microphone plus system audio, validates saved audio, transcribes it, and generates editable notes from the transcript.              |
| Conversation turns | Splits dual-source recordings into ordered `Microphone` and `System` turns, so the transcript reads like a conversation without speaker diarization.      |
| Dictation          | Records a push-to-talk or toggle shortcut, cleans up the transcript, pastes it into the previously focused app, and restores the clipboard when possible. |
| Agent sessions     | Runs a local Hermes-based agent runtime for research, drafts, file work, and routines with approval gates before sensitive actions.                       |
| Projects           | Groups meeting notes and agent sessions around the work they belong to.                                                                                   |
| Model choice       | Lets users choose transcription, dictation cleanup, title, and note-generation models from the Scribe API model catalog.                                  |

## Repository overview

June ships the full desktop product and the backend that powers metered AI calls:

```text
src/          React and TypeScript frontend
src-tauri/   Tauri v2 Rust desktop backend and native helpers
scribe-api/  Confidential backend for transcription, generation, models, and billing
docs/        Product, release, backend, and architecture notes
specs/       Feature specs, plans, contracts, and validation notes
```

The desktop app never stores OpenAI, Venice, or OS Accounts App API keys. Those
belong only in Scribe API. The client authenticates the signed-in user through
OS Accounts, sends requests to Scribe API, and Scribe API handles provider calls
and OS Accounts metering.

## Platform support

| Platform    | Status                                                                                                                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS 14.0+ | Primary target. Meeting notes, dictation, system audio on macOS 14.2+, local agent runtime, signed DMG releases, and auto-updates.                                                                                                           |
| Windows     | Supported for the app shell, OS Accounts sign-in, microphone recording, notes, folders, settings, and the bundled agent runtime. Global dictation paste, macOS system audio, and the macOS Seatbelt write-jail are not available on Windows. |

See [docs/release-macos.md](docs/release-macos.md) and
[docs/release-windows.md](docs/release-windows.md) for release procedures.

## Quick start

Install dependencies and run the desktop app:

```sh
pnpm install
pnpm tauri:dev
```

`pnpm tauri:dev` starts Vite and a local Scribe API when their ports are free.
If `127.0.0.1:1421` or `127.0.0.1:8080` is already listening, the script
reuses the existing service. Set `VITE_PORT` or `SCRIBE_API_PORT` to choose a
different port.

Replay first-run onboarding without wiping all app data:

```sh
pnpm tauri:dev --replay-onboarding
```

## Configuration

Copy the desktop env file:

```sh
cp .env.example .env
```

Use the root `.env` for desktop runtime configuration only:

- `SCRIBE_API_URL`
- `OS_ACCOUNTS_URL`
- `OS_ACCOUNTS_API_URL`
- `OS_ACCOUNTS_CLIENT_ID`
- initial model defaults such as `VENICE_TRANSCRIPTION_MODEL` and
  `VENICE_GENERATION_MODEL`
- optional `OS_NOTETAKER_TRANSCRIPTION_LANGUAGE`

Do not put provider keys or OS Accounts App API keys in the root desktop `.env`.

To run Scribe API yourself:

```sh
cp scribe-api/.env.example scribe-api/.env
# Fill SCRIBE__OS_ACCOUNTS__APP_API_KEY, SCRIBE__UPSTREAMS__OPENAI__API_KEY,
# and SCRIBE__UPSTREAMS__VENICE__API_KEY in scribe-api/.env.
(cd scribe-api && cargo run -- serve)
```

Restart `pnpm tauri:dev` after changing the root `.env`. The running Tauri
process does not reload client configuration.

## Local data

The app data directory is resolved by Tauri at runtime. In development, inspect
the platform app data path for:

- `notes.sqlite3`
- `recordings/{note_id}/{session_id}.wav`
- `recordings/{note_id}/{session_id}/microphone.wav`
- `recordings/{note_id}/{session_id}/system.wav` when `Microphone + system audio`
  is selected

Saved audio is the source of truth for retry. If transcription or generation
fails after capture, June keeps the audio and processing metadata so work can be
retried without recording again.

## Privacy and verification

The production `scribe-api` backend runs in an Intel TDX confidential VM on
Phala Cloud. The running image is attested, so Phala and Open Software cannot
quietly change the backend that handles audio, transcripts, prompts, and logs
without that change appearing in the verification chain.

The chain has three public anchors:

1. **Source:** this repository. The production image records the source commit
   in its OCI `org.opencontainers.image.revision` label.
2. **Image:** [`build-scribe-api.yml`](.github/workflows/build-scribe-api.yml)
   builds and publishes
   [`ghcr.io/open-software-network/scribe-api`](https://github.com/open-software-network/os-scribe/pkgs/container/scribe-api).
   Deploys pin immutable per-commit tags, and each deployed digest is recorded
   as a signed `deploy/<env>/<sha>` git tag.
3. **Attestation:** the
   [Phala Trust Center report](https://trust.phala.com/app/15f8d2fd586da8b99c6082b3c2cba64127ceeb8c)
   proves the expected image is running inside an Intel TDX confidential VM.

Every deployment also serves a self-contained walkthrough at
[`/verify`](https://scribe-api.opensoftware.co/verify). It reports the exact
commit and image running in the TEE and explains how to check each link.

Everything leaving the TEE for model inference goes through Venice. By default,
June uses Venice private models with zero data retention and no training. If a
user selects an anonymized model that is not run by Venice, the request is still
routed and anonymized by Venice, but the underlying model provider may retain
data under its own policy. This verification chain proves the backend code
running in the confidential VM, not upstream provider behavior.

## Permissions

June asks for permissions only where the feature needs them:

- **Microphone:** required for meeting notes and dictation.
- **Accessibility:** required for dictation paste into the previously focused
  app.
- **Screen and system audio recording:** required when using
  `Microphone + system audio` on macOS.
- **File access:** requested by agent workflows when a task needs a specific
  scope.

The macOS bundle includes `NSMicrophoneUsageDescription` and
`NSAudioCaptureUsageDescription` in [src-tauri/Info.plist](src-tauri/Info.plist).
If local permission state gets stuck during development, reset it with:

```sh
tccutil reset Microphone co.opensoftware.scribe
```

## Development commands

```sh
pnpm lint
pnpm test
pnpm test:rust
pnpm test:scribe-api
pnpm build
pnpm tauri:build
```

Useful validation docs:

- [specs/001-tauri-note-mvp/manual-validation.md](specs/001-tauri-note-mvp/manual-validation.md)
- [specs/002-system-audio-source-mode/quickstart.md](specs/002-system-audio-source-mode/quickstart.md)
- [specs/003-conversation-turns/quickstart.md](specs/003-conversation-turns/quickstart.md)

Architecture and product notes:

- [docs/adr/0002-live-transcript-preview-strategy.md](docs/adr/0002-live-transcript-preview-strategy.md)

## Release notes

Production desktop releases are cut from GitHub Actions. macOS produces signed
and notarized DMGs with Tauri updater artifacts. Windows produces signed NSIS
installers and merges Windows updater metadata into the shared release.

Start with:

- [docs/release-macos.md](docs/release-macos.md)
- [docs/release-windows.md](docs/release-windows.md)
- [docs/reproducible-builds.md](docs/reproducible-builds.md)

## License

June is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

Bundled third-party runtime notices are tracked in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
