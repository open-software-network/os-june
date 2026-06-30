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
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="Built with Tauri" src="https://img.shields.io/badge/desktop-Tauri-orange">
</p>

<p align="center">
  <a href="https://opensoftware.co/june">opensoftware.co/june</a>
</p>

June is an open source desktop app for turning spoken work into useful work. It
records reliable local audio, generates editable meeting notes, pastes cleaned
dictation into any app, and runs a local agent that can help with files,
research, drafts, and routines.

The product is designed around a simple privacy contract: your app state,
recordings, transcripts, files, sessions, and agent memory live on your machine
by default. When June needs model inference, requests go through June API, a
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
| Model choice       | Lets users choose transcription, dictation cleanup, title, and note-generation models from the June API model catalog.                                    |

## Repository overview

June ships the full desktop product and the backend that powers metered AI calls:

```text
src/          React and TypeScript frontend
src-tauri/   Tauri v2 Rust desktop backend and native helpers
june-api/  Confidential backend for transcription, generation, models, and billing
docs/        Product, release, backend, and architecture notes
specs/       Feature specs, plans, contracts, and validation notes
```

The desktop app never stores OpenAI, Venice, or OS Accounts App API keys. Those
belong only in June API. The client authenticates the signed-in user through
OS Accounts, sends requests to June API, and June API handles provider calls
and OS Accounts metering.

## Platform support

| Platform    | Status                                                                                                                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS 14.0+ | Primary target. Meeting notes, dictation, system audio on macOS 14.2+, local agent runtime, signed DMG releases, and auto-updates.                                                                                                           |
| Windows     | Supported for the app shell, OS Accounts sign-in, microphone recording, notes, folders, settings, and the bundled agent runtime. Global dictation paste, macOS system audio, and the macOS Seatbelt write-jail are not available on Windows. |

See [docs/release-macos.md](docs/release-macos.md) and
[docs/release-windows.md](docs/release-windows.md) for release procedures.

## Quick start

Clone the repo, copy both env examples, add at least one provider key, and run
the desktop app:

```sh
cp .env.example .env
cp june-api/.env.example june-api/.env
# Edit june-api/.env and set JUNE__UPSTREAMS__VENICE__API_KEY.
pnpm install
pnpm tauri:dev
```

`pnpm tauri:dev` starts Vite and a local June API when their ports are free.
If `127.0.0.1:1421` or `127.0.0.1:8080` is already listening, the script
reuses the existing service. Set `VITE_PORT` or `JUNE_API_PORT` to choose a
different port.

Replay first-run onboarding without wiping all app data:

```sh
pnpm tauri:dev --replay-onboarding
```

## Configuration

The example env files default to open source local mode:

- no OS Accounts login
- no billing or credit charges
- no provider keys in the desktop env
- June API accepts the local bearer token shared by `.env` and
  `june-api/.env`

Provider keys belong only in `june-api/.env`. For the default local setup,
set `JUNE__UPSTREAMS__VENICE__API_KEY` to a Venice API key. Add
`JUNE__UPSTREAMS__OPENAI__API_KEY` only if you want to use OpenAI
transcription models.

Copy the env files:

```sh
cp .env.example .env
cp june-api/.env.example june-api/.env
```

Use the root `.env` for desktop runtime configuration:

- `JUNE_API_URL`
- `OS_JUNE_LOCAL_DEV`
- `OS_JUNE_LOCAL_DEV_BEARER_TOKEN`
- `OS_JUNE_LOCAL_DEV_USER_ID`
- initial model defaults such as `VENICE_TRANSCRIPTION_MODEL` and
  `VENICE_GENERATION_MODEL`
- optional `OS_NOTETAKER_TRANSCRIPTION_LANGUAGE`

Use `june-api/.env` for server-side secrets and local auth:

- `JUNE__LOCAL_DEV__ENABLED`
- `JUNE__LOCAL_DEV__BEARER_TOKEN`
- `JUNE__UPSTREAMS__VENICE__API_KEY`
- `JUNE__UPSTREAMS__OPENAI__API_KEY`
- optional `JUNE__ISSUE_REPORTS__OS_PLATFORM_API_KEY` for filing in-app
  issue reports into the fixed June os-platform project
- optional provider base URLs such as `JUNE__UPSTREAMS__VENICE__BASE_URL`

The local bearer token must match in both env files. It is not an OS Accounts
token. It is just the shared secret used by the local desktop app and local
June API. The June API env example binds local mode to `127.0.0.1`; if you
bind it to a network interface, replace the default local bearer token in both
env files first. If you change the local dev user id, keep
`OS_JUNE_LOCAL_DEV_USER_ID` in the root `.env` aligned with
`JUNE__LOCAL_DEV__USER_ID` in `june-api/.env`.

Do not put provider keys or OS Accounts App API keys in the root desktop `.env`.

To expose your own models, edit [june-api/config.toml](june-api/config.toml)
and add or change `[pricing."<model-id>"]` entries. Each priced model needs a
provider, model type, display name, unit, and positive pricing rate. Then set
the matching provider key and optional base URL in `june-api/.env`, and update
the root `.env` default model ids if you want June to select those models on
first launch.

To run with OS Accounts and billing instead of local mode, set these flags off:

```sh
OS_JUNE_LOCAL_DEV=0
JUNE__LOCAL_DEV__ENABLED=false
```

Then fill the connected deployment settings:

- `JUNE__OS_ACCOUNTS__API_URL`
- `JUNE__OS_ACCOUNTS__APP_API_KEY`
- `OS_ACCOUNTS_URL`
- `OS_ACCOUNTS_API_URL`
- `OS_ACCOUNTS_CLIENT_ID`
- provider keys for every provider exposed in the pricing table

You can also run June API directly:

```sh
(cd june-api && cargo run -- serve)
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

## Agent skills

The agent loads skills from its managed `skills` folder and, when the folder
exists, from `~/.agents/skills` in your home directory (the same location the
`skills` CLI installs into). Drop a skill folder there and every agent session
picks it up the next time it starts. Home-folder skills load read-only: the
macOS write-jail grants writes only under June's own data directory, so the
agent can use these skills but cannot modify them.

## Privacy and verification

The production `june-api` backend runs in an Intel TDX confidential VM on
Phala Cloud. The running image is attested, so Phala and Open Software cannot
quietly change the backend that handles audio, transcripts, prompts, and logs
without that change appearing in the verification chain.

The chain has three public anchors:

1. **Source:** this repository. The production image records the source commit
   in its OCI `org.opencontainers.image.revision` label.
2. **Image:** [`build-june-api.yml`](.github/workflows/build-june-api.yml)
   builds and publishes
   [`ghcr.io/open-software-network/june-api`](https://github.com/open-software-network/os-june/pkgs/container/june-api).
   Deploys pin immutable per-commit tags, and each deployed digest is recorded
   as a signed `deploy/<env>/<sha>` git tag.
3. **Attestation:** the
   [Phala Trust Center report](https://trust.phala.com/app/15f8d2fd586da8b99c6082b3c2cba64127ceeb8c)
   proves the expected image is running inside an Intel TDX confidential VM.

Every deployment also serves a self-contained walkthrough at
[`/verify`](https://june-api.opensoftware.co/verify). It reports the exact
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
tccutil reset Microphone co.opensoftware.june
```

## Development commands

```sh
pnpm lint
pnpm test
pnpm test:rust
pnpm test:june-api
pnpm build
pnpm tauri:build
```

Useful validation docs:

- [specs/001-tauri-note-mvp/manual-validation.md](specs/001-tauri-note-mvp/manual-validation.md)
- [specs/002-system-audio-source-mode/quickstart.md](specs/002-system-audio-source-mode/quickstart.md)
- [specs/003-conversation-turns/quickstart.md](specs/003-conversation-turns/quickstart.md)

Architecture and product notes:

- [docs/adr/0001-auto-updates-via-tauri-updater.md](docs/adr/0001-auto-updates-via-tauri-updater.md)
- [docs/adr/0002-live-transcript-preview-strategy.md](docs/adr/0002-live-transcript-preview-strategy.md)

## Release notes

Production desktop releases are cut from GitHub Actions. macOS produces signed
and notarized DMGs with Tauri updater artifacts. Windows produces signed NSIS
installers and merges Windows updater metadata into the shared release.

Start with:

- [docs/release-macos.md](docs/release-macos.md)
- [docs/release-windows.md](docs/release-windows.md)
- [docs/reproducible-builds.md](docs/reproducible-builds.md)

Bumping the bundled Hermes runtime follows its own gate. Work through
[docs/hermes-upgrade-checklist.md](docs/hermes-upgrade-checklist.md) (start a new
pin note from [docs/hermes-upstream-template.md](docs/hermes-upstream-template.md)),
then run `pnpm hermes:upgrade-check` to confirm the compatibility matrix, the
pin note, and the checklist all name the same version.

## License

June is licensed under the MIT License. See [LICENSE](LICENSE).

Bundled third-party runtime notices are tracked in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
