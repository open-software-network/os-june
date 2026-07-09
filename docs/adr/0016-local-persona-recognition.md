# Local persona recognition over diarized saved audio

June recognizes who spoke in a meeting by diarizing the saved audio locally and
matching voice embeddings against an on-device Voiceprint registry — on both
lanes (system and microphone), in post-processing only. This supersedes the
scope line in [ADR-0005](0005-source-separated-audio-capture.md) that put
speaker identity within a source out of scope; the one-WAV-per-source
architecture and the turn model it established stand unchanged.

## Status

proposed — design accepted (see [docs/personas-design.md](../personas-design.md)),
implementation not started

## Context

Personas (tag a voice once → auto-recognize in future meetings → dossiers →
prep briefs) require knowing who spoke. ADR-0005 deliberately excluded
within-source speaker identity: the system lane arrives pre-mixed, and turns
are energy-detected, never diarized. The personas design needs identity on
both lanes — the mic lane is "the user + possible guests," not only the user.

Forces:

- **Privacy is architectural.** Voiceprints are biometric identifiers of third
  parties who never opted into June. Sending audio to a diarization-capable
  provider would put biometrics in flight and undercut June's core claim.
- **Turns are load-bearing.** ADR-0005 made turns the sole cross-source
  reconciliation point; anything assigning identity must compose with them,
  not replace them.
- **June is saved-audio-first.** The note is built from saved WAVs in a batch
  pass; nothing requires identity live during recording.

## Decision

- **Diarization and embedding run locally**, on saved audio, inside the
  existing post-recording pipeline — a bundled, pinned model (same
  bundle-and-pin discipline as the Hermes runtime). Persona recognition sends
  no audio, Voiceprints, or embeddings off-device. Existing note transcription
  still sends turn audio to June API; this decision adds no new audio-derived
  outbound payload.
- **Recognition annotates turns; detection is untouched.** Turn detection
  stays energy-based. Diarized, matched speech assigns personas to turns (or
  subdivides a turn's attribution) strictly after detection.
- **Both lanes.** System lane (remote voices) and microphone lane (user +
  in-room guests). The user's own voiceprint is a first-class registry entry.
  Phasing: the System source plus the user's own Microphone Voiceprint first;
  in-room guest diarization gated on the first phase's quality read (far-field
  audio is a different quality regime and is judged separately).
- **Post-processing only.** Live "who is speaking" labels are explicitly
  deferred; they are an upgrade, not a foundation.
- **The Voiceprint registry is local-only and user-owned**: multiple Voiceprints per
  persona, negative examples from corrections, excluded from any future
  sync/backup unless end-to-end encrypted; delete offers real erasure.

## Considered options

- **Provider-side diarization** (a diarization-capable ASR upstream) —
  rejected: ships third-party biometric signal off-device, adds a provider
  contract June API must carry forever, and adds a new recognition-derived
  biometric payload. Existing note-transcription audio flow is unchanged.
- **No diarization — manual tagging only** — rejected: without automatic
  recognition the tag-once promise dies; per-meeting re-tagging is exactly the
  friction personas exist to remove.
- **Live (streaming) recognition as the foundation** — rejected: June is
  saved-audio-first; batch diarization on saved WAVs is the mature, easy
  regime, and every downstream consumer (transcript naming, dossiers, briefs)
  reads persisted notes, not the live stream.
- **Remote-lane only** — rejected as an end state (kept as phase one): the
  mic-lane "user + guests" case is real; but its far-field quality regime is
  judged separately before guest diarization ships.
