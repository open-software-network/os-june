# PRD: Personas — June knows who you meet

Status: design accepted (grill session 2026-07-09). Governing ADR:
[0016-local-persona-recognition.md](adr/0016-local-persona-recognition.md).
Canonical vocabulary: CONTEXT.md § Personas — terms there are binding for all
naming in this feature (Persona, Voiceprint, Voiceprint registry, Persona
recognition, Tagging, Dossier, Commitment, Participant, Roster, Prep brief,
Archive).

## One-liner

Tag a voice once, and June recognizes that person in every future meeting,
remembers what they said across meetings, and briefs you before you meet them
again.

## Problem

Every meeting today is amnesiac. The transcript says "System said X" — not
"Jun said X." Nothing carries over between meetings: what James committed to,
what your boss asked for, what's still open. The user is the only memory
between meetings, and June does nothing to prepare them.

## Goals

1. **Tag once, recognized forever.** Naming a speaker in one finished note is
   the only ceremony; future meetings auto-name that person.
2. **Per-person memory.** June accumulates a dossier per persona from every
   meeting they appear in.
3. **Preparation.** Before an expected meeting, June writes a prep brief:
   last time, open commitments, suggested asks shaped by relationship.
4. **Local-owned memory.** Voiceprints and recognition stay on-device. Dossiers
   have a local source of truth; when the user asks June's agent about a person,
   the relevant dossier context may be sent to the user's configured agent model
   just like note context in an ordinary chat.

## Non-goals

- **No Meeting entity.** The note stays the meeting record; participants are
  persona links on notes. Revisit only if a real force appears (e.g.
  calendar-only meetings with no recording).
- **No live recognition.** "Jun is speaking" labels during recording are a
  later upgrade, not part of this PRD.
- **No calendar integration** in this PRD (later upgrade; see Preparation).
- **No backwards compatibility.** New meetings only; old notes are never
  retro-processed.
- **No CRM.** Exactly one structured dossier type (Commitment); everything
  else is prose. A second structured type is the named failure mode.
- **No consent theater.** No third-party notification popups; see Privacy.

## Core concept

A **Persona** is a person June knows. One persona = one human = one dossier,
however many hats the relationship holds ("peer at Alongside; also client
contact at Acme"). Three layers:

| Layer | Holds | Source |
|---|---|---|
| Identity | name, voiceprints (several per persona + negative examples) | user tags a speaker cluster in a finished note |
| Relationship | who they are to the user, plain language, multiple hats | user tells June; June's agent interprets, no role taxonomy |
| Memory | dossier: prose + structured Commitments | June's agent extracts after each meeting they appear in |

The flywheel: **Recognize → Accumulate → Prepare.** More meetings → more voice
samples and richer dossiers → better recognition and sharper briefs.

## Functional specification

### 1. Recognition (post-processing, saved audio)

Runs inside the existing post-recording pipeline, after turn detection.
Turn detection itself is untouched (energy-based, never diarization);
recognition assigns identity to turns afterwards. Per ADR-0016:

1. Diarize **both lanes** (system = remote voices; microphone = user +
   possible in-room guests) → anonymous speaker clusters.
2. Embed each cluster; match against the local Voiceprint registry.
3. Apply **confidence bands**:
   - **Auto band** (high): turn is auto-named, with visible provenance (subtle
     "auto" marker) and one-click correction ("not Jun").
   - **Suggest band** (ambiguous): suggestion chip on the note ("Is this
     Jun?"); turns stay "Speaker N" until confirmed.
   - **Anonymous** (low): "Speaker N" plus a "Tag this voice?" affordance.
4. **First-match rule:** the first cross-meeting recognition of any persona is
   always a suggestion, never silent — one confirmation per person calibrates
   the system, then auto applies.
5. Corrections feed back: "not X" stores a negative example against that
   voiceprint.

The user's own voiceprint is a first-class registry entry (implicitly
enrolled — June has abundant samples of the user's voice) and is what
separates "you" from guests on the mic lane. The mic lane is never assumed to
be only the user.

**Tagging = enrollment.** Naming an anonymous cluster stores its embedding as
that persona's voiceprint. No separate enrollment ceremony, ever.

### 2. Participants

Confirmed recognitions and manual tags link personas to the note as its
**participant list**. All downstream features key off participants:
"meetings with James" = query notes by participant; dossier updates iterate a
note's participants; prep looks up recent notes by participant.

### 3. Accumulation (dossiers)

After note generation, a June agent pass updates the dossier of each participant:

- Dossier = **prose maintained by June's agent** + exactly one structured type:
  **Commitment** (who owes whom, what, due, status: open → done/dropped,
  source note).
- Commitments are proposed by June's agent, visible in the dossier, deletable, and show
  their source note. No per-item confirmation nag.
- **Trust gate:** only auto-band or user-confirmed speech feeds the dossier.
  Suggest-band speech never enters persona memory until confirmed — a
  poisoned dossier compounds into future briefs; a mislabeled transcript
  doesn't.
- A periodic consolidation pass keeps prose from bloating; consolidation must
  never drop open Commitments (they're structured precisely so consolidation
  can't lose them).

### 4. June agent integration

- **Roster injected:** the standing context for June's agent carries a compact index —
  name + one-line relationship per persona. A few hundred tokens; makes
  name-dropping ("what's James up to?") resolvable. Consequence accepted: no
  dormant personas; everyone June knows is visible to every chat.
- **Everything else via an internal `june_*` MCP server** grouping persona
  tools with meeting-context tools: dossier get/update, commitments query,
  find-meetings-with(persona), note lookup. Full dossiers are fetched on
  demand, never injected wholesale.
- Chat over people works through these tools: "what does James owe me?",
  "when did I last talk to the Acme folks?"

### 5. Preparation

- **Triggers:** manual ("prep me for my 1:1 with James") and meeting-app
  detection. Detection guesses attendees from recurring patterns (same app,
  same time slot, same participants as last time) plus the roster. Calendar
  is a later upgrade, adopted only after briefs prove they change behavior.
- **The brief is a note June's agent writes** — reviewable, editable,
  dismissible. Not a popup, not a meeting entity. Content: who's expected,
  last time (discussed/decided), open commitments both directions, suggested
  asks shaped by relationship ("as James's manager, you wanted status on…").
- Detection-triggered briefs have seconds of lead time: format for instant
  reading.

### 6. Persona management ("People June knows")

One surface listing every persona: identity, relationship, dossier (editable),
commitments, voiceprint count, last seen. Lifecycle:

- **Rename** — propagates everywhere; past notes reference the persona, not a
  text copy.
- **Archive** — "won't attend future meetings": excluded from recognition and
  the roster; dossier and history kept. For people who left.
- **Delete** — severs everything forward-looking (voiceprints, dossier,
  commitments, roster). Past notes keep the name as frozen text by default;
  an explicit second step offers scrubbing past notes back to "Speaker N"
  (true erasure).

## Architecture

```
┌────────────────────────────────────────────────────┐
│ on-device recognition + local memory source of truth│
│                                                      │
│  saved meeting audio (both lanes)                    │
│        │ diarize (bundled, pinned model)             │
│        ▼                                             │
│  speaker clusters ──embed──► VOICEPRINT REGISTRY     │
│                               (voiceprints ↔ persona,│
│                                negative examples)    │
│        │ confidence-banded matches                   │
│        ▼                                             │
│  speaker-resolved transcript + note participants     │
│        │                                             │
│        ▼                                             │
│  JUNE AGENT ◄── june_* MCP ──► PERSONA STORE         │
│   • dossier update         (identity, relationship,  │
│   • prep brief              dossier prose,           │
│   • chat over people        commitments)             │
│        │ selected note/dossier context             │
└────────┼───────────────────────────────────────────┘
         ▼
  configured agent model (may be remote)
```

- Diarization + embedding model: bundled and pinned like the Hermes runtime
  (same bundle-and-pin + smoke-gate discipline). Candidate stacks evaluated in
  the Phase 1 spike: pyannote-family via ONNX (`pyannote-rs`, `speakrs`,
  `sherpa-onnx`); runtime choice (native ONNX + CoreML vs pure-Rust) is a
  spike output, not a PRD decision.
- Persona store: local DB rows (identity, relationship, commitments) + a prose
  dossier document per persona.
- Registry: multiple voiceprints per persona, negative examples, per-lane
  thresholds (far-field mic audio is a different quality regime than call
  audio and is tuned separately).

## Privacy (binding commitments)

Personas are the user's private memory aid — same category as their own notes.
They organize what the user already lawfully records; no new capture. Three
commitments, written down as product constraints:

1. Voiceprints, recognition audio, and recognition embeddings never leave the
   device. Dossiers are stored only on-device, but selected dossier context may
   be sent to the configured agent model when June's agent uses persona tools
   to answer the user's request.
2. Voiceprints and dossiers are excluded from any future sync/backup unless
   end-to-end encrypted.
3. Delete-with-scrub is real erasure.

No third-party notification or consent popups. Recording-consent law concerns
the recording itself, which June already does; personas do not change that
analysis.

## Phasing

| Phase | Ships | Proves | Gate |
|---|---|---|---|
| **1 — Identity** | diarize + tag + registry + auto-name on the System source; user's own Voiceprint on the Microphone source; participants on notes | recognition quality on real call audio; tag-once promise | **spike first**: run candidate diarizers on real saved `system.wav` recordings; if match quality disappoints, everything above changes shape |
| **1.5 — In-room guests** | guest diarization on the mic lane (far-field regime) | in-room quality, judged separately from call audio | Phase 1 quality read |
| **2 — Memory** | dossier updates post-meeting; Commitments; "People June knows"; roster + `june_*` MCP tools | dossiers accurate and useful, not noise | Phase 1 shipped |
| **3 — Preparation** | prep briefs (manual + detection-triggered); relationship-aware asks | briefs change how the user enters meetings | Phase 2 shipped |
| later | live labels during recording; calendar integration | — | — |

### Phase 1 acceptance criteria

- In a finished note, an anonymous speaker cluster can be tagged with a name;
  tagging creates the persona and stores the voiceprint.
- In the *next* recording where that person speaks on the System source, their turns
  are suggested (first match) then auto-named (subsequent), per the bands.
- Auto-named turns show provenance and support one-click correction; a
  correction stores a negative example.
- Notes carry a participant list from confirmed recognitions + manual tags.
- Zero recognition-derived audio, Voiceprints, or embeddings leave the device.
  Existing note-transcription audio uploads remain unchanged; no new June API
  endpoint or audio-derived outbound payload is added.
- Old notes are untouched.

### Phase 2 acceptance criteria

- After a meeting with confirmed participants, each participant's dossier
  gains an update the user can read, edit, and delete; commitments appear as
  structured open items with source-note links.
- Suggest-band (unconfirmed) speech never appears in any dossier.
- "What does James owe me?" answered in chat via the commitments query tool.
- Rename/archive/delete behave per Persona management above.

### Phase 3 acceptance criteria

- "Prep me for my 1:1 with James" produces a brief note citing last meeting,
  open commitments in both directions, and relationship-shaped asks.
- Starting a detected meeting app offers a brief from recurring-pattern
  attendee guesses; wrong guesses are correctable in the brief.

## Risks

1. **Match quality on compressed call audio** — the Phase 1 spike exists to
   answer this before any UI is built. Kill criterion: if candidates
   frequently mismatch across meetings on real recordings, stop and rescope.
2. **Dossier noise** — mitigations: trust gate, visible provenance,
   consolidation rules, user editability. Phase 2 proves it or it doesn't ship
   to Phase 3.
3. **Wrong-name trust damage** — mitigations: bands, first-match rule,
   provenance, one-click correction with negative examples.
4. **Model bundle size/packaging** (~30–40 MB weights + runtime) — follows the
   Hermes bundling precedent; runtime choice decided in the spike.

## Implementation notes for the next implementer

- Read CONTEXT.md § Personas and ADR-0016 before naming anything; the _Avoid_
  lists are binding.
- Recognition composes with the existing turn model (ADR-0005 stands):
  detect turns → diarize → match → annotate. Do not touch turn detection.
- The June API needs **no changes** — everything is local. Do not add
  endpoints.
- Repo spec rules apply to all UI (sentence case, design tokens, central
  icons, control sizes — see spec/index.md).
- Start with the Phase 1 spike as a throwaway binary; its output (crate +
  runtime choice, threshold ballparks, quality verdict) unblocks everything
  else.
