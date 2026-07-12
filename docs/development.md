# Local development

Day-to-day development reference for the desktop app and a local June API.
Configuration details (every env var, pricing, custom models, connected mode)
live in [configuration.md](configuration.md); when the two disagree, the env
example files win.

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

Before launch, the script checks that the desktop and local June API select
the same auth mode. It stops with an actionable error when only one side uses
local mode. When both sides use real OS Accounts, it prints the exact loopback
callback URI that the development OAuth client must allowlist.

Replay first-run onboarding without wiping all app data:

```sh
pnpm tauri:dev --replay-onboarding
```

You can also run June API directly:

```sh
(cd june-api && cargo run -- serve)
```

Restart `pnpm tauri:dev` after changing the root `.env`. The running Tauri
process does not reload client configuration.

The example env files default to open source local mode: no OS Accounts login,
no billing or credit charges, and no provider keys in the desktop env. June
API accepts the local bearer token shared by `.env` and `june-api/.env`. That
token must match in both files; it is not an OS Accounts token, just the
shared secret between the local desktop app and the local June API. The June
API env example binds local mode to `127.0.0.1`; if you bind it to a network
interface, replace the default local bearer token in both env files first.

Provider keys and the OS Accounts App API key belong only in `june-api/.env`,
never in the root desktop `.env`. Add `JUNE__UPSTREAMS__OPENAI__API_KEY` only
if you want to use OpenAI transcription models.

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
`NSAudioCaptureUsageDescription` in
[src-tauri/Info.plist](../src-tauri/Info.plist). If local permission state gets
stuck during development, reset it with:

```sh
tccutil reset Microphone co.opensoftware.june
```

## Verification commands

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm test:rust
pnpm test:june-api
pnpm build
pnpm tauri:build
```

`make verify` mirrors CI.

Useful validation docs:

- [specs/001-tauri-note-mvp/manual-validation.md](../specs/001-tauri-note-mvp/manual-validation.md)
- [specs/002-system-audio-source-mode/quickstart.md](../specs/002-system-audio-source-mode/quickstart.md)
- [specs/003-conversation-turns/quickstart.md](../specs/003-conversation-turns/quickstart.md)

## Releases

Production desktop releases are cut from GitHub Actions. macOS produces signed
and notarized DMGs with Tauri updater artifacts. Windows produces signed NSIS
installers and merges Windows updater metadata into the shared release. Start
with:

- [release-macos.md](release-macos.md)
- [release-windows.md](release-windows.md)
- [reproducible-builds.md](reproducible-builds.md)

Bumping the bundled Hermes runtime follows its own gate. Work through
[hermes-upgrade-checklist.md](hermes-upgrade-checklist.md) (start a new pin
note from [hermes-upstream-template.md](hermes-upstream-template.md)), then run
`pnpm hermes:upgrade-check` to confirm the compatibility matrix, the pin note,
and the checklist all name the same version.
