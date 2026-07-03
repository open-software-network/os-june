# June

June is a Tauri desktop app that records meetings/dictation, transcribes
the audio, turns the transcript into structured notes, and hosts an AI agent
you can chat with over those notes. It depends on the **OS Accounts**
identity-and-credits platform for sign-in and for billing metered AI usage,
and embeds the **Hermes** runtime as its agent brain.

This document is a glossary, not a spec. Terms are canonical; the `_Avoid_`
lines are binding. Implementation, endpoints, and code shape live under
[docs/](docs/index.md).

## Language

### Platform

**June (the app)**:
The user-facing Tauri desktop product — the macOS `.app` users install. The
binary on disk is named `os-june`, the Cargo package is `os-june`, the
bundle identifier is `co.opensoftware.june`.
_Avoid_: notetaker, OS Notetaker (legacy names — fully removed from code as of
the bundle rename; don't reintroduce).

**June API**:
The confidential backend service that holds the App API key and the upstream
AI provider keys, runs `authorize`→`charge` against OS Accounts on behalf of
the June app, and proxies the metered AI calls (transcription, generation,
agent chat, web). Lives in the same repo as June under its own Cargo
workspace; ships as a separate container image to GHCR and runs in a TEE.
Cargo crates use the `june-*` prefix; the binary is `june`.
_Avoid_: backend, proxy, AI proxy (use **June API**).

**OS Accounts**:
The Open Software identity-and-credits platform. Source of truth for *who the
user is* and *how many credits they have*. June and June API both depend on
it; it never depends on them.
_Avoid_: accounts, the identity service, the auth service.

**Upstream provider**:
A third-party AI service June API calls on the user's behalf — currently
**OpenAI** (transcription only) and **Venice** (transcription, generation,
agent chat, web). Upstream provider API keys live only in June API's
environment, never in June. In code, each upstream sits behind a domain trait
(`Transcriber`, `Generator`, `AgentChatCompleter`, ...) defined in
`june-domain` and implemented in `june-providers`.
_Avoid_: AI provider, model provider, vendor, "the LLM".

### Notes

**Note**:
The central June artifact — a persistent, user-editable markdown document,
listed in the sidebar and optionally organized into folders. Created blank or
filled by **note generation**, and owns any manual notes the user types. A
**recording session** is note-backed: the recording attaches to a note, never
the reverse, and a note need not have a recording at all.
_Avoid_: meeting (June has no meeting entity), document, summary.

### Audio & recording

**Recording session**:
One note-backed capture lifecycle (a UUID) that owns its source mode,
artifacts, elapsed time, and status; the unit of recovery and retry.
_Avoid_: meeting object (June deliberately has no separate "meeting" entity).

**Source mode**:
The capture scope chosen before recording starts: `MicrophoneOnly` or
`MicrophonePlusSystem` (meeting mode).
_Avoid_: recording type.

**Source**:
A single audio lane — `Microphone` or `System` — each captured to its own
file and transcribed independently.
_Avoid_: channel (that is the WAV interleave sense), track.

**Turn**:
A detected active interval on one source (`source`, `start_ms`, `end_ms`,
`turn_index`) used to order the transcript as a back-and-forth conversation.
Detection is energy-based (RMS windows + noise floor), never diarization.
_Avoid_: segment (that is a live-preview chunk), utterance, speaker (no
speaker identity is inferred).

**Coalescing**:
Merging adjacent same-source turns before transcription when the gap is short
and no other source intervenes. Distinct from `merge_close_turns` (intra-turn
gap fill).
_Avoid_: merging (unqualified).

**Normalization**:
Preparing a source WAV for transcription: downmix to mono, resample to 16 kHz,
apply bounded gain toward a target peak.
_Avoid_: conversion, resampling (that is one step of it).

**Live transcript preview**:
Optional, ephemeral chunked transcription shown while recording. Revisable,
never written to `transcripts`, never the note's source of truth (see
[ADR-0002](docs/adr/0002-live-transcript-preview-strategy.md)).
_Avoid_: realtime transcription, live captions, streaming.

**System audio helper**:
The out-of-process macOS `.app` (`june-system-audio-recorder`) that captures
system audio via CoreAudio process taps and reports over a `status.json` file
(see [ADR-0004](docs/adr/0004-out-of-process-system-audio-helper.md)).
_Avoid_: system driver, in-process capture.

**Dictation helper**:
The native macOS helper (`mac-dictation-helper`) that owns push-to-talk
**dictation** capture and text insertion into the foreground app, and is the
authoritative source for microphone + accessibility permission state.
_Avoid_: dictation app, keyboard helper.

### Agent runtime (Hermes)

**Hermes**:
The embedded upstream (Nous Research) agent runtime June bundles, pinned to a
commit and SHA-verified. June drives it as the chat/agent brain but presents
as June, never as Hermes (an injected `SOUL.md` asserts the identity).
_Avoid_: the model, the LLM, the agent (unqualified).

**Bridge**:
The Rust layer (`src-tauri/src/hermes_bridge.rs`) that spawns, sandboxes, and
proxies to Hermes child processes and exposes them as Tauri commands.
_Avoid_: server, daemon.

**Gateway**:
The Hermes JSON-RPC-over-WebSocket endpoint and its client
(`HermesGatewayClient`) — pure transport (connect coalescing, req/resp
correlation, timeouts).
_Avoid_: control plane, API.

**Control plane**:
The typed seam (`src/lib/hermes-control-plane/`) that turns raw Hermes frames
into the total `JuneHermesEvent` union and typed outbound methods. The union
also carries locally minted first-party events (see **Steer**) that the
classifier never emits.
_Avoid_: gateway, adapter.

**Runtime mode**:
The write-access mode of a spawned Hermes process: `sandboxed` (a Seatbelt
write-jail, default) or `unrestricted`. Opt-in is per session; June keeps one
gateway per mode so an unrestricted session can't un-sandbox others.
_Avoid_: permission, profile.

**Stored session id** vs **runtime session id**:
The persistent id June keys all UI and history on, versus the live process's
per-resume id. `session.create` returns both; conflating them attaches
traces/artifacts to the wrong identity.
_Avoid_: "the session id" (always say which).

**Composer**:
The ProseMirror chat input with slash commands and attachment chips.
_Avoid_: textbox.

**Slash command**:
A `/name arg` handled client-side before submit — builtin `/model`, `/file`,
and `/image` (the last gated off behind `IMAGE_GENERATION_ENABLED`), plus
skill slash commands.
_Avoid_: gateway command.

**Steer**:
A user instruction delivered into a still-running agent session without
interrupting it. A steer is first-party and local to June — never a Hermes
wire frame. A steer the run never consumed is resent as an ordinary follow-up
when the run completes cleanly, and dropped when the run fails or is
cancelled.
_Avoid_: interrupt/stop (a steer never halts the run), follow-up (that is the
fallback delivery, not the steer), mid-run message.

**Model capability**:
An authoritative boolean flag from the live Venice catalog `capabilities`
(`supportsFunctionCalling` → tools, `supportsVision` → image input), never
inferred from marketing `traits` (see
[ADR-0007](docs/adr/0007-model-capability-source-of-truth.md)).
_Avoid_: trait (`traits` is a separate, non-authoritative Venice field).

**Attachment**:
A file or image imported into the Hermes workspace and referenced by path;
images additionally get a structured `image.attach_bytes`.
_Avoid_: upload (unqualified).

**Note reference**:
A plain-text token — `@note:<id>`, optionally followed by the quoted note
title — that points the agent at one specific note. Inserted as a composer
chip via `@`, seeded by "Ask June" on a note, or pasted from "Copy note
reference"; the agent resolves it on demand through `june_context`'s
`get_meeting_note` tool (see
[ADR-0010](docs/adr/0010-note-references-in-agent-chat.md)).
_Avoid_: note link (no URL or deep link is involved), note mention (the chip
is UI; the reference is the token).

**Skill / Toolset / MCP server**:
A Skill is a bundled/installed capability pack; a Toolset is a togglable tool
group; an MCP server is an external tool provider (June ships `june_context`
and `june_web`).
_Avoid_: using "tool" for all three.

**Admin surface**:
A June-native management view for the embedded Hermes runtime — skills hub,
MCP servers and diagnostics, toolsets, integrations health, and similar —
rendered with June's own UI and driven through the Hermes admin request
channel, never by exposing Hermes's own web UI.
_Avoid_: admin panel, Hermes UI (June presents as June).

### AI work & billing

**Dictation**:
A latency-critical June mode where the user pushes-to-talk, speaks a short
phrase, releases, and expects cleaned-up text inserted into the foreground
app within a few hundred milliseconds. Distinct from **note transcription**.
Goes through June API in v1, so the binary holds no upstream provider key.
_Avoid_: speech-to-text (too generic — covers both dictation and note
transcription).

**Note transcription**:
June records a full meeting or capture session, then transcribes the saved
audio as a single batch operation and runs **note generation** on the
transcript. Higher latency tolerance than dictation; cost typically dominates
dictation by 100×+ per call.
_Avoid_: transcription (ambiguous between dictation and note transcribe — say
which).

**Note generation**:
The step that turns a note transcription (plus any manual notes) into a
structured markdown note, currently via a Venice chat-completion call. Always
follows a successful note transcription; not used in dictation.
_Avoid_: notes generation, AI summarisation.

**Image generation**:
Producing a new image from a text **prompt** (text-to-image), via Venice. The
user reaches it two ways: an explicit `/image` command (a fast, no-model shot),
or the assistant calling it as a tool mid-conversation. Distinct from **image
editing**. See [ADR 0008](docs/adr/0008-image-generation-and-editing-tools.md).
_Avoid_: rendering, drawing (say **image generation**).

**Image editing**:
Producing a new image by transforming an *existing* image plus an instruction
(image-to-image / inpaint), via Venice's separate edit models. Always references
a prior image (a generated one, by filename); never starts from a blank canvas.
Distinct from **image generation**.
_Avoid_: img2img (jargon), regenerate (that's a fresh **image generation**).

**Credit price** (per upstream model):
The number of OS Accounts credits June charges per unit of consumed work
(audio seconds for transcription, tokens for generation) for a given upstream
model. Stored as a typed lookup keyed by `model_id`; the live Venice catalog
extends the built-in fallback each boot. An upstream model with no credit
price is rejected at the boundary before any work runs — there is no "default
rate".
_Avoid_: rate, tariff, cost (cost is the *upstream's* dollar cost to June;
credit price is what the user pays in credits).

**Hold** / **authorize**:
The pre-flight wallet reservation (`POST /authorize` to OS Accounts) that
returns an **Action token** and an optional `cap_credits`, sized by a flat
estimate. Expires by TTL if never charged.
_Avoid_: pre-charge, lock.

**Charge** / **settle**:
Debiting the wallet (`POST /charge`) for usage already incurred, keyed by a
deterministic **idempotency key** and clamped to the Hold's cap. Metering
settles only *after* the upstream call succeeds, so a retry can't double-charge.
_Avoid_: bill, deduction.

**Action token**:
The opaque token returned by authorize and consumed by charge, binding a
single operation to its cap.
_Avoid_: access token (that is the user's JWT).

**Action slug**:
The metered-operation id (e.g. `note_transcribe`, `dictate_transcribe`,
`agent_chat`, `web_search`) that scopes idempotency keys and Hold TTLs and
splits the bill in the dashboard.
_Avoid_: operation, endpoint.

**Plan**:
The OS Accounts subscription level carried in the account snapshot
(`subscription.plan`, e.g. `max`). Gates features and sizes the recurring
**credit grant**; the **FundingGate** keys off subscription state.
_Avoid_: tier, subscription (that is the whole object, not the level).

**Credit grant**:
Credits deposited into the wallet by OS Accounts when a plan starts, renews,
or upgrades. Arrives asynchronously after the plan change itself resolves, so
"plan flipped" and "credits arrived" are two separate moments — June polls
the account snapshot until the grant lands rather than assuming credits are
present the instant the plan changes.
_Avoid_: top-up (a user-initiated purchase), refill.

### Desktop shell & updates

**Release channel**:
The updater track: `stable` or `rc` (shipped in PR #529; see
[ADR-0003](docs/adr/0003-release-candidate-channel-and-promotion.md)).
_Avoid_: beta.

**Update manifest** (`latest.json`):
The signed JSON on the public releases repo listing per-platform artifacts and
their Ed25519 signatures; the RC variant is `latest-rc.json`.
_Avoid_: appcast.

**Releases repo**:
The separate public repo `open-software-network/os-june-releases` that hosts
signed artifacts + the update manifest (the source repo is private; the
updater's unauthenticated GET would 404 against it — see
[ADR-0001](docs/adr/0001-auto-updates-via-tauri-updater.md)).
_Avoid_: "GitHub release" (unqualified).

**Provider settings / Model mode**:
The persisted choice of which model handles each `ModelMode`
(`Transcription`, `Generation`, ...), stored in `provider-settings.json`.
Venice is the default; OpenAI is used only for specific ASR models.
_Avoid_: model config (unqualified).

**Account snapshot** (`AccountStatus`):
The user + credit balance + subscription state fetched from OS Accounts and
surfaced to the UI.
_Avoid_: profile, balance (unqualified).

**AccountGate** / **FundingGate**:
The sign-in wall (`AccountGate`) versus the credits-exhausted / upgrade wall
(`FundingGate`, keyed off `subscription.subscribed`).
_Avoid_: paywall (unqualified — say which gate).

**Agent HUD**:
The floating agent overlay window, toggled from the menu bar and separate
from the main window.
_Avoid_: pet (legacy name — survives only in an old storage key), overlay
(unqualified), floating window.

**Permission**:
A macOS TCC grant June needs — microphone, accessibility, or screen/system
audio recording. System-audio permission is probe-driven (there is no
query-only macOS API); the dictation helper is the authoritative source for
mic + accessibility state.
_Avoid_: entitlement (that is the code-signing sense).

## Flagged ambiguities

- **"proxy"** usually means **June API** (the thing in front of OpenAI /
  Venice), not a network proxy in the HTTP-CONNECT sense. Prefer **June API**.
  (June also runs a separate on-device **provider proxy** for identity
  stripping — qualify when you mean that.)
- **"transcribe"** is overloaded between **dictation** (short, latency-
  critical) and **note transcription** (long, batch). Always qualify which.
- **"credits"** always means OS Accounts credits (integers, `$1 = 1000
  credits`). Never use it for upstream provider cost (which is dollars).
- **"the session id"** is ambiguous — say **stored** (persistent, UI-facing) or
  **runtime** (live process) session id.
- **"the model"** never means Hermes — Hermes is the runtime; the model is the
  Venice-served LLM the runtime calls.
- **"channel"** is overloaded: a **Source** lane (mic/system), a **release
  channel** (stable/rc), or a WAV interleave channel. Qualify.

## Example dialogue

> **Dev:** "Can I add a Whisper model to the picker?"
>
> **PM:** "Sure, but make sure it has a **credit price** before you list it,
> otherwise **June API** rejects transcribe requests for that **upstream
> model**. The picker shouldn't show models the server can't price."
>
> **Dev:** "Got it. And the credit price covers both **dictation** and **note
> transcription**, right?"
>
> **PM:** "Yes, same per-second rate for the same model regardless of which
> surface called it. The **action slug** differs (`dictate_transcribe` vs
> `note_transcribe`) so we can split the bills, but the price comes from the
> same entry."
