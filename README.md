<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/os-june-dark.svg">
    <img src="public/os-june-light.svg" alt="June" width="140" height="41">
  </picture>
</p>

<h3 align="center">Private AI on your Mac</h3>

<p align="center">
  June brings chat, voice dictation, meeting notes, and a local agent into a single
  private workspace. Local by default, routed through privacy-preserving AI, and
  open source so the privacy claims can be checked instead of believed.
</p>

<p align="center">
  <a href="https://opensoftware.co/download/mac">
    <img alt="Download for macOS" src="https://img.shields.io/badge/download-macOS%2014%2B-c25a33">
  </a>
  <a href="https://github.com/open-software-network/os-june-releases/releases/latest">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/open-software-network/os-june-releases?label=release">
  </a>
  <a href="https://trust.phala.com/app/6514acb0e08dc4825e2b6e22a46f0ed0ff455b54">
    <img alt="Phala Trust Center - TEE verified" src="https://img.shields.io/badge/Phala%20Trust%20Center-TEE%20verified-success">
  </a>
  <a href="LICENSE">
    <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue">
  </a>
</p>

<p align="center">
  <a href="https://opensoftware.co/june">Website</a> ·
  <a href="https://opensoftware.co/june/changelog">Changelog</a> ·
  <a href="https://june-api.opensoftware.co/verify">Verify</a> ·
  <a href="https://t.me/osjune">Telegram</a> ·
  <a href="https://x.com/OpenSoftwareCo">X</a>
</p>

![A 30 second tour of June: dictation, a detected meeting turning into live transcription, and an agent analyzing a spreadsheet](.github/assets/june-demo.gif)


## Why June

Most AI apps ask you to hand over your most sensitive data and trust them with
it. Every prompt, file, and meeting reveals something about you, and a cloud
agent with that reach is a remote company's window into your work.

June is built the other way around. The app and the agent run on your Mac.
Notes, recordings, transcripts, files, sessions, and agent memory stay on your
machine by default. When June needs model inference, the request goes through
June API, an open source, TEE-attested service that keeps provider keys
server-side and routes to private models with zero data retention by default.
You do not have to take any of this on faith: the entire product is MIT
licensed, and the exact code serving production is cryptographically
verifiable.

## What June does

- **Chat.** Ask questions, do research, brainstorm, and build plans without
  the conversation training someone else's model.
- **Dictation.** Hold a key, talk, release. June turns your voice into clean,
  polished writing and pastes it into whatever app you were using, with
  push-to-talk and hands-free modes and selectable writing styles.
- **Meeting notes.** June detects supported meetings and offers to take notes,
  without a bot joining the call. It records microphone or microphone plus
  system audio, orders the transcript into conversation turns, and generates
  editable notes. Saved audio is kept so failed steps can be retried without
  recording again.
- **Agent.** A local agent, built on the open source Hermes framework, that
  helps with files, research, drafts, and scheduled routines. Sessions are
  sandboxed by default and risky actions wait for your approval. Extend it
  with skills, toolsets, and MCP servers.
- **Image generation.** Create images from a prompt, through the same private
  routing as everything else.
- **Your choice of models.** Pick generation, transcription, and dictation
  models from the live catalog, each labeled with its privacy tier. Bring your
  own Venice API key if you prefer.

<table>
  <tr>
    <td width="33%">
      <img src=".github/assets/june-meeting-notes.jpg" alt="A meeting note in June with a live transcription preview while recording">
    </td>
    <td width="33%">
      <img src=".github/assets/june-agent-analysis.jpg" alt="A June agent session in private mode, reporting its analysis of a spreadsheet">
    </td>
    <td width="33%">
      <img src=".github/assets/june-model-picker.jpg" alt="The June model picker, with each model labeled with pricing, context window, and its privacy tier">
    </td>
  </tr>
  <tr>
    <td align="center">Meeting notes with live transcription, no bot in the call</td>
    <td align="center">The agent working through a spreadsheet in private mode</td>
    <td align="center">Every model labeled with its privacy tier</td>
  </tr>
</table>

## How June keeps it private

1. **Local by default.** App state, recordings, transcripts, and agent memory
   live on your machine. The agent runs locally inside a macOS write-jail
   unless you opt a session out.
2. **Private models.** Model calls default to private Venice models with zero
   data retention: nothing stored, no training. Anonymized third-party models
   are opt-in, and those providers may retain what they receive under their
   own policies.
3. **Minimal retention.** Open Software's services store account, login, and
   billing records. Prompts, audio, transcripts, and files are not among them.
4. **Verifiable, not promised.** June API runs in an Intel TDX confidential VM
   on Phala Cloud, and its trust chain has three public anchors:
   - **Source:** this repository. The production image records its source
     commit in the OCI `org.opencontainers.image.revision` label.
   - **Image:** [`build-june-api.yml`](.github/workflows/build-june-api.yml)
     publishes [`ghcr.io/open-software-network/june-api`](https://github.com/open-software-network/os-june/pkgs/container/june-api);
     deploys pin immutable per-commit tags recorded as signed `deploy/<env>/<sha>` git tags.
   - **Attestation:** the [Phala Trust Center report](https://trust.phala.com/app/6514acb0e08dc4825e2b6e22a46f0ed0ff455b54)
     proves that image is what actually runs inside the TEE.

   Every deployment serves a self-contained walkthrough at
   [`/verify`](https://june-api.opensoftware.co/verify). The chain proves the
   code running in the confidential VM, not what upstream model providers do
   with what they receive, which is why zero-retention routing is the default.

## Download

June runs on macOS 14 or later, Apple Silicon and Intel. Releases are signed,
notarized, and auto-updating, with `stable` and `rc` channels switchable
in-app. It is free to start.

- [Download for macOS](https://opensoftware.co/download/mac)
- [All releases and changelog source](https://github.com/open-software-network/os-june-releases)

If you use Homebrew, this is the recommended way to install:

```sh
brew install --cask open-software-network/tap/june
```

Windows builds cover the app shell, sign-in, microphone recording, notes, and
the bundled agent runtime, but not global dictation paste, system audio
capture, or the macOS sandbox. macOS is the primary target.

## Repository layout

This repo contains the full product: the desktop app and the service that
powers its metered AI calls.

```text
src/         React and TypeScript frontend
src-tauri/   Tauri v2 Rust desktop backend and native helpers
june-api/    June API: models, transcription, generation, and billing
docs/        Architecture notes, ADRs, subsystem guides, and runbooks
spec/        Enforceable coding rules
specs/       Feature specs, plans, and validation notes
```

The desktop app never holds provider or OS Accounts App API keys; those live
only in June API. Start with [docs/index.md](docs/index.md) for the full doc
map, [CONTEXT.md](CONTEXT.md) for the domain glossary, and
[AGENTS.md](AGENTS.md) for the contributor guide.

## Build from source

You need Node.js with pnpm 9 and a Rust toolchain.

```sh
git clone https://github.com/open-software-network/os-june
cd os-june
cp .env.example .env
cp june-api/.env.example june-api/.env
# Edit june-api/.env and set JUNE__UPSTREAMS__VENICE__API_KEY.
pnpm install
pnpm tauri:dev
```

The example env files default to open source local mode: no OS Accounts login,
no billing, and a local June API authenticated by a shared bearer token.
Provider keys belong only in `june-api/.env`, never in the root desktop
`.env`. A Venice API key is enough for transcription, generation, and
dictation cleanup.

See [docs/development.md](docs/development.md) for the day-to-day development
guide (ports, onboarding replay, local data, permissions, agent skills, and
test commands) and [docs/configuration.md](docs/configuration.md) for the full
configuration reference, including exposing your own models and running
against OS Accounts.

## Contributing

June ships near-daily releases and development happens in the open.

```sh
pnpm check         # lint and format (Biome)
pnpm typecheck
pnpm test          # frontend (Vitest)
pnpm test:rust     # desktop Rust
pnpm test:june-api # June API
```

`make verify` mirrors CI. Start with [CONTRIBUTING.md](CONTRIBUTING.md), then
[AGENTS.md](AGENTS.md) for the full contributor guide; the enforceable UI
rules live in [spec/](spec/index.md). Report bugs through GitHub issues, and
report security vulnerabilities privately per [SECURITY.md](SECURITY.md).

- Community: [t.me/osjune](https://t.me/osjune)
- Updates: [@OpenSoftwareCo](https://x.com/OpenSoftwareCo) and the
  [changelog](https://opensoftware.co/june/changelog)

## License

June is MIT licensed. See [LICENSE](LICENSE). Bundled third-party runtime
notices are tracked in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
