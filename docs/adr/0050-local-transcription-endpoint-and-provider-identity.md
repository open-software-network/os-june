---
status: accepted
date: 2026-07-28
---

# Local transcription endpoint and provider identity

June can post speech-to-text audio directly to a user-supplied
OpenAI-compatible STT server, bypassing June API entirely. This records the
routing decision and the durable-identity encoding that makes it safe.

## Context

Users run their own ASR (typically a Whisper-style model behind an
OpenAI-compatible server) and want June to use it instead of Venice ASR.
The local generation endpoint already exists for chat completions; STT needs
the equivalent, but transcription has a durable job ledger (ADR-0026) whose
fingerprint is the cache identity, so any local-route identity must integrate
with that ledger rather than ride alongside it.

Three STT surfaces share one route: saved-audio note transcription, live
transcript preview, and dictation. Whichever route the user selects must
apply to all three, or the live preview would not match the authoritative
transcript and dictation would diverge from note transcription.

The remote Venice/OpenAI ASR path is metered through June API: it takes a
wallet Hold, settles a Charge, and requires an OS Accounts session. A local
endpoint the user owns and runs has nothing to bill, so the billing gate is
not meaningful on that route.

## Decision

User-supplied OpenAI-compatible STT is a global-only `local_transcription`
block in `provider-settings.json`, mirroring the existing `local_generation`
block: a `base_url`, a `model_id`, and an optional `api_key`. It is configured
through the Settings UI and never read from `.env`.

The route is decided at exactly two wire functions:
`transcribe_saved_audio` (saved-audio note transcription and live preview
share this entry) and `dictate_transcribe`. Both dispatch on the request's
plan-provider identity, not on a re-read of live settings, so a durable job
keeps its route even if the user later flips the route back to June API.
All three STT surfaces (saved-audio note transcription, live transcript
preview, dictation) route through the same wire functions, so one toggle
moves all three.

Local endpoint identity is encoded **into the existing `plan.provider`
string** as `local:<16 hex of sha256(base_url + "\n" + model_id)>`, not as a
new fingerprint field and not via a domain-tag bump. The bare `local` slug
names the route choice on the settings row; the prefixed form is the durable
identity written into job plans. `is_local_transcription_provider` accepts
both, so the wire functions can recognize the prefixed form a durable plan
carries.

### Rejected alternative 1: bump the fingerprint domain tag

Bump `b"june-note-transcription-input-v1\0"` to `v2` and include the local
endpoint identity there. Rejected because changing the domain tag changes
every existing fingerprint, forcing re-transcription and re-billing of every
user's entire note history. The new identity should only invalidate cache for
notes actually transcribed on the local route, which is exactly what writing
it into `plan.provider` does: only those rows get a new provider value.

### Rejected alternative 2: add a dedicated fingerprint field

Add an `endpoint_identity` field to `note_transcription_input_fingerprint`.
Rejected for the same mass-re-billing reason: adding any field to the hash
changes every existing fingerprint, not just local-route ones. The structured
`plan.provider` value isolates the invalidation to local-route jobs.

## Consequences

- `plan.provider` is now a structured value, not a fixed slug. Anything
  reading it must treat `local:` as a prefix and dispatch on
  `is_local_transcription_provider`; anything that compared it for equality
  to `"venice"` or `"openai"` must use the route helper instead.
  `validate_note_transcription_plan` only requires the field to be non-empty,
  so encoding the local identity needed no schema change.
- The local route bypasses June API entirely. No Hold is taken and no credits
  are charged for note transcription, live preview, or dictation on the local
  route. Live preview therefore works signed out on the local route. This is
  a deliberate relaxation of the JUN-375 billing gate recorded in the
  [ADR-0002 addendum](0002-live-transcript-preview-strategy.md), valid only
  because the local route has nothing to bill; the June API preview path
  still requires configuration and sign-in as before.
- Cleanup (note generation on a local-STT transcript) routes through local
  chat completions when local generation is also configured; remote cleanup
  is refused for a local-STT note so a local transcript never leaves the
  device for a follow-up cleanup call. Note generation as a whole is
  independent: if local generation is not configured, generation runs
  remotely and the transcript is uploaded to June API as before. A failed
  or empty local cleanup preserves the raw transcript.
- The fingerprint still does not include the *remote* model id: switching
  between two Venice ASR models reuses cache. This change does not alter
  that behavior. The asymmetry is intentional: local identity must
  invalidate when the user points at a different local server or model, but
  remote ASR model id is intentionally not part of the current fingerprint,
  and changing the remote cache key now would re-bill existing users. See
  the [ADR-0026 addendum](0026-durable-note-transcription-jobs.md).
- A durable job carries its planned `local:<hash>` identity even if the user
  later repoints the endpoint. Dispatch verifies the durable identity
  against the current endpoint settings and rejects a job whose identity no
  longer matches (`local_transcription_endpoint_changed`) rather than
  persisting endpoint B's output under endpoint A's hash. The bare `local`
  slug used by live preview and dictation has no durable identity and simply
  uses the current endpoint.
