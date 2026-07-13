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
different port. Set `JUNE_DEV_SKIP_LOCAL_API=1` to skip the local June API
entirely and leave the port probe alone; the staging and ephemeral targets
below already do this.

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

## Running against hosted June API

Two ways to run the desktop app against a June API in a real TEE instead of
the local one: the shared staging deployment, or a disposable Phala CVM built
from your working tree.

### Staging

```sh
make dev-staging
```

The target runs `pnpm tauri:dev` with five overrides:

- `JUNE_API_URL=https://june-api-staging.opensoftware.co`
- `OS_JUNE_LOCAL_DEV=0`
- `OS_ACCOUNTS_URL=https://os-accounts-portal-staging.up.railway.app`
- `OS_ACCOUNTS_API_URL=https://os-accounts-api-staging.up.railway.app`
- `JUNE_DEV_SKIP_LOCAL_API=1`

Process env beats `.env`, so these win even when `.env` selects local mode.
The target does not set `OS_ACCOUNTS_CLIENT_ID`: put the staging client id
(`ocl_...`) in `.env` or export it in the shell, or login fails with
`os_accounts_unconfigured`. You also need an OS Accounts staging account with
credits, because staging meters every request. Set
`OS_JUNE_DEV_PLAINTEXT_TOKEN_STORE=1` in a debug build to avoid a Keychain
prompt on every run.

Auth is a real Login with Open Software against staging OS Accounts. The
local-dev bearer token does not work: staging June API boots with
`JUNE__LOCAL_DEV__ENABLED` unset, so it verifies OS Accounts JWTs and charges
credits. Staging stays JWT-only on purpose. Every June API image soaks there
before it is promoted to production, so it has to exercise the same auth and
metering path production runs.

`https://june-api-staging.opensoftware.co` is served by a `dstack-ingress`
container inside the staging CVM. It terminates TLS on 443 and proxies to
`june-api:8080` over the internal compose network; the app publishes no
external port of its own.

Phala sealed envs are full-replacement on `phala envs update`: every variable
must be re-supplied on each update, including the ingress ones. Seal new
variables BEFORE deploying a compose that references them; containers boot
against whatever is already sealed, so the reverse order boots the ingress
without its Cloudflare credentials. Read the comments in
`june-api/deploy/docker-compose.staging.yml` before touching them.

### Ephemeral Phala CVM

Deploy the june-api in your working tree to a disposable Phala CVM, use it,
delete it. Backed by `scripts/ephemeral-june-api.sh`.

```sh
make ephemeral-api            # deploy, health-check, print the URL; leaves it up
make dev-with-ephemeral-api   # deploy, run the app against it, delete on exit
make ephemeral-api-down       # delete the CVM recorded in the state file
```

`ephemeral-api` builds june-api for `linux/amd64`, pushes it to `ttl.sh`,
deploys a `tdx.small` CVM, and polls `/healthz` for up to 10 minutes. On
timeout it exits non-zero and leaves the CVM up and billing, so tear it down
by hand. `dev-with-ephemeral-api` deploys a fresh CVM, runs `pnpm tauri:dev`
against it, and always deletes it on exit, whether you quit cleanly, hit
Ctrl-C, close the terminal, or the run fails after the CVM came up. A hard
kill or power loss can still skip cleanup; `make ephemeral-api-down` recovers
from the state file, so run it if a session ended abnormally. That is the
invariant worth remembering: only `dev-with-ephemeral-api` cleans up after
itself. `ephemeral-api` leaves the CVM running until `ephemeral-api-down`.

Prerequisites: Docker running, the `phala` CLI installed and authenticated
(`phala auth login`), and a `june-api/.env` holding the upstream provider
keys. The script also needs `jq`, `curl`, `openssl`, `perl`, and `uuidgen`. It
copies `JUNE__UPSTREAMS__VENICE__API_KEY` and `JUNE__UPSTREAMS__OPENAI__API_KEY`
from `june-api/.env` verbatim; a key that is missing there stays missing, and
June API drops the models whose provider it cannot reach.

Cost: `tdx.small` bills $0.058/hr from creation until you delete the CVM. The
image is pushed to `ttl.sh` with a `4h` tag. Tags there expire; the CVM keeps
running past expiry, but it can no longer re-pull its image, so a restart
after that point is fatal. Treat an ephemeral CVM as dead once its tag
expires.

Security: the ttl.sh image is briefly public and carries no secrets. Secrets
ride Phala sealed env and are injected at boot inside the CVM, and the deploy
passes `--no-public-logs --no-public-sysinfo`. Auth is local-dev mode with a
random bearer token minted per run, never printed, and gone when the VM is
deleted. Local-dev mode replaces JWT verification and disables OS Accounts
metering, so no OS Accounts App API key ever reaches an ephemeral CVM. There
is no issue-report key either, so issue reports stay in the CVM logs.

The CVM name, URL, bearer token, image ref, git sha, and creation time land in
`.ephemeral-june-api.json` (mode 600, gitignored). It is written before the
deploy starts, because a deploy that dies halfway can still leave a billing
CVM behind and the state file is the only record of its name. `ephemeral-api`
refuses to run while that file exists. To point a manual session at a CVM left
up by `ephemeral-api`:

```sh
export JUNE_API_URL="$(jq -r .url .ephemeral-june-api.json)"
export OS_JUNE_LOCAL_DEV=1
export OS_JUNE_LOCAL_DEV_BEARER_TOKEN="$(jq -r .token .ephemeral-june-api.json)"
export JUNE_DEV_SKIP_LOCAL_API=1
```

Ephemeral CVMs get no `dstack-ingress` and no custom domain. The dstack
gateway's own HTTPS endpoint for the published port is the only way in.

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
