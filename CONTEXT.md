# June

June (formerly OS Scribe) is a Tauri desktop app that records meetings/dictation, transcribes
the audio, and turns the transcript into structured notes. It depends on the
**OS Accounts** identity-and-credits platform for sign-in and for billing
metered AI usage.

## Language

**Scribe (the app)**:
The user-facing Tauri desktop product — the macOS `.app` users install. The
binary on disk is named `os-scribe`, the Cargo package is `os-scribe`, the
bundle identifier is `co.opensoftware.scribe`.
_Avoid_: notetaker, OS Notetaker (legacy names — fully removed from code as of
the bundle rename; don't reintroduce).

**Scribe API**:
The confidential backend service that holds the App API key and the upstream
AI provider keys, runs `authorize`→`charge` against OS Accounts on behalf of
the Scribe app, and proxies the metered AI calls (transcription, generation).
Lives in the same repo as Scribe under its own Cargo workspace; ships as a
separate container image to GHCR. Cargo crates use the `scribe-*` prefix; the
binary is `scribe`.
_Avoid_: backend, proxy, AI proxy (use **Scribe API**).

**OS Accounts**:
The Open Software identity-and-credits platform. Source of truth for *who the
user is* and *how many credits they have*. Scribe and Scribe API both depend on
it; it never depends on them.
_Avoid_: accounts, the identity service, the auth service.

**Upstream provider**:
A third-party AI service Scribe API calls on the user's behalf — currently
**OpenAI** (transcription) and **Venice** (transcription + generation).
Upstream provider API keys live only in Scribe API's environment, never in
Scribe. In code, each upstream sits behind a domain trait (`Transcriber`,
`Generator`) defined in `scribe-domain` and implemented in `scribe-providers`.
_Avoid_: AI provider, model provider, vendor.

**Dictation**:
A latency-critical Scribe mode where the user pushes-to-talk, speaks a short
phrase, releases, and expects cleaned-up text inserted into the foreground
app within a few hundred milliseconds. Distinct from **note transcription**
(long-form, recorded session, async). Dictation goes through Scribe API in
v1, so the binary holds no upstream provider key, but the request shape and
charge timing are tuned for low latency (a dictation ADR may capture this
if/when written).
_Avoid_: speech-to-text (too generic; covers both dictation and note
transcription).

**Note transcription**:
Scribe records a full meeting or capture session, then transcribes the saved
audio file as a single batch operation and runs **note generation** on the
transcript. Higher tolerance for latency than dictation; cost typically
dominates dictation by 100×+ per call (minutes of audio vs single phrases).
_Avoid_: transcription (ambiguous between dictation transcribe and note
transcribe — say which).

**Note generation**:
The step that turns a note transcription (plus any manual notes) into a
structured markdown note, currently via a Venice chat-completion call. Always
follows a successful note transcription; not used in dictation.
_Avoid_: notes generation, AI summarisation.

**Credit price** (per upstream model):
The number of OS Accounts credits Scribe charges per unit of consumed work
(audio seconds for transcription, tokens for generation) for a given upstream
model. Stored as a typed lookup in `scribe-config` keyed by `model_id`. An
upstream model with no credit price configured is rejected at the
`/transcribe` or `/generate` boundary before any work runs — there is no
"default rate".
_Avoid_: rate, tariff, cost (cost is the *upstream's* dollar cost to Scribe;
credit price is what the user pays in credits).

## Flagged ambiguities

- Term **"proxy"** is overloaded. In conversation it usually means
  Scribe API (the thing in front of OpenAI / Venice), not a network proxy in
  the HTTP-CONNECT sense. Prefer **Scribe API**.
- Term **"transcribe"** is overloaded between **dictation** (short, latency-
  critical) and **note transcription** (long, batch). Always qualify which.
- Term **"credits"** always means OS Accounts credits (integers, `$1 = 1000
  credits`). Never use it for upstream provider cost (which is dollars).

## Example dialogue

> **Dev:** "Can I add a Whisper model to the picker?"
>
> **PM:** "Sure — but make sure it has a **credit price** in `scribe-config`
> before you list it, otherwise **Scribe API** will reject `/v1/transcribe`
> requests for that **upstream model**. The picker shouldn't show models the
> server can't price."
>
> **Dev:** "Got it. And the credit price covers both **dictation** and **note
> transcription**, right?"
>
> **PM:** "Yes — same per-second rate for the same model regardless of which
> surface called it. The OS Accounts **action slug** differs
> (`dictate_transcribe` vs `note_transcribe`) so we can split the bills in the
> dashboard, but the price-per-second comes from the same config entry."

<!--
  This document is a glossary, not a spec.
  Implementation details, endpoints, env vars, and code shape live in
  ./docs/os-accounts-backend.md and the future scribe-api crates.
-->
