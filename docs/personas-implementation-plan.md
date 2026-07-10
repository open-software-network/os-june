# Personas implementation plan

Status: ready for implementation after the real-recording quality gate in
[ADR-0016](adr/0016-local-persona-recognition.md). This plan implements the
accepted behavior in [personas-design.md](personas-design.md); it does not
replace that PRD.

## Required gates

Production recognition must not start until the existing spike passes on real
June `system.wav` recordings from different recording sessions. The operator
must listen to every generated cluster, label the same person consistently
across recordings, and mark mixed clusters. A passing report must show:

- every evaluation recording contributes at least one labeled cluster;
- no mixed or fragmented identity cluster;
- an embedding for every labeled cluster;
- complete separation between observed genuine and impostor scores.

After a pass, append the real result to ADR-0016: runtime and model versions,
asset hashes and licenses, observed score ranges, initial suggest and auto
thresholds, supported platforms, and packaging evidence. A failed gate means
the recognition shape or runtime is reconsidered before production code.

Two product decisions remain user-owned:

1. Permission to analyze saved June recordings locally. The spike never
   uploads audio or embeddings, but private recordings are not opened without
   explicit permission.
2. Whether automatic post-note dossier updates may spend credits on the
   configured agent model. No implementation may introduce silent metered work
   until that behavior is confirmed.

## Delivery order

The PRD phases remain dependency gates, not scope cuts:

1. Identity: local diarization, the Voiceprint registry, tagging, recognition,
   corrections, and note Participants.
2. Memory: dossiers, Commitments, People, roster context, and `june_context`
   persona tools.
3. Preparation: manual and meeting-detection-triggered prep briefs.

Each phase gets its own deterministic tests and native walkthrough before the
next phase begins. Old notes remain unchanged throughout.

## Phase 1: Identity

### Runtime and packaging

Absorb the validated parts of the spike into a production `personas` module;
do not invoke the throwaway binary from the app. The module owns:

- loading the pinned segmentation and embedding assets from read-only Tauri
  resources;
- platform-specific native runtime loading and startup diagnostics;
- resampling, diarization, cluster embedding, and similarity scoring;
- per-lane confidence thresholds and the first-cross-meeting suggestion rule;
- zero outbound serialization of audio, Voiceprints, or raw embeddings.

The model assets and native libraries follow the Hermes bundle discipline:
pinned URLs and SHA-256 values, license and attribution files in the bundle,
smoke coverage, universal macOS packaging, Windows loading coverage, and an
installer-size check.

### Processing seam

Persona recognition composes with the saved-audio pipeline in
`src-tauri/src/domain/processing.rs`:

1. validate sources and detect energy-based turns;
2. apply existing echo trimming;
3. diarize the saved source WAVs and intersect cluster spans with the detected
   turns;
4. subdivide a detected turn when more than one cluster speaks inside it;
5. match cluster embeddings against the local Voiceprint registry;
6. extract and transcribe the resulting attributed turns;
7. persist transcript attribution and Participants before note generation;
8. generate the note from Persona names or stable anonymous labels, retaining
   the Source as secondary provenance.

Recognition never changes energy detection. A recognition runtime failure
falls back to the existing Source-labeled transcript and records a visible,
retryable warning; it must not invent anonymous clusters without diarization.
Live transcript preview remains Source-only because recognition is
post-processing.

### Local schema

Add an idempotent SQLite migration for these local-only records:

- `personas`: stable id, name, relationship, dossier prose, self marker,
  archive timestamp, created and updated timestamps;
- `persona_voiceprints`: Persona id, Source lane, model id, embedding blob,
  positive or negative kind, provenance, and timestamps;
- `persona_clusters`: recording session, note, Source, stable anonymous label,
  model id, embedding blob, diarized spans, and timestamps;
- `transcript_persona_attributions`: transcript row, cluster, attribution
  state, optional Persona id, frozen name, confidence, and timestamps;
- `note_participants`: note and Persona ids, provenance, first confirmed
  appearance, and timestamps.

Attribution states are `anonymous`, `suggested`, `tagged`, `confirmed`,
`automatic`, and `frozen`. A suggested row keeps its anonymous display label
until confirmation. A frozen row preserves a deleted Persona's historical name
without keeping the Persona, dossier, Commitments, or Voiceprints alive.

Anonymous labels are assigned once per recording session and persisted. They
must not depend on current filtering, row order, or the number of transcript
rows rendered.

Voiceprint and cluster embeddings are biometric data. They stay in the June
database, are excluded from sync or backup unless end-to-end encrypted, and
are erased by Persona deletion. No log, event, checkpoint, analytics payload,
MCP result, or June API request may contain them.

### Desktop contracts

Extend `TranscriptDto` with optional attribution and `NoteDto` with
Participants. Absence means a legacy Source-only note.

```text
PersonaAttribution
  anonymous: cluster id + stable anonymous label
  suggested: cluster id + stable anonymous label + candidate Persona
  tagged | confirmed | automatic: cluster id + Persona
  frozen: stable historical name
```

Local Tauri commands return authoritative updated records:

- `tag_speaker_cluster`
- `confirm_persona_suggestion`
- `reject_persona_attribution`
- `list_personas`
- `get_persona`
- `update_persona`
- `archive_persona`
- `restore_persona`
- `delete_persona`
- `scrub_deleted_persona_from_notes`

Tagging and confirmation update every transcript row for the cluster and the
note's Participants in one transaction. Rejection records a negative
Voiceprint and returns the cluster to anonymous; it does not cascade through
lower-ranked candidates automatically.

The first match of a Persona outside the recording in which they were tagged
is always `suggested`. Only a confirmed cross-meeting match makes later
high-confidence matches eligible for `automatic`.

### Finished-note UI

All released Persona workflows live inside the June desktop app. The
gitignored spike report, generated cluster WAVs, temporary labeling page, and
labels JSON are evaluation artifacts only; none is a production interaction
surface or a runtime dependency.

The Transcription tab renders attribution without losing Source provenance:

- legacy: `System` or `Microphone`;
- anonymous: `Speaker N`, Source and time, plus `Tag this voice?`;
- suggested: `Speaker N`, Source and time, plus `Is this Name?`;
- automatic: Persona name, Source and time, `Auto`, plus `Not Name`;
- tagged or confirmed: Persona name with Source and time;
- frozen: the historical name with Source and time.

Every diarized cluster appears in conversation order. A local in-app audio
preview lets the user hear that cluster without opening Finder or a browser;
the preview reads June's saved audio and never uploads it. The same row opens
the native tag dialog, where the user selects an existing Persona or creates
one with a name and optional relationship. Reassign, confirm, reject, and
`Not Name` corrections all happen on that row and update the full cluster.

The tag affordance appears on the first visible turn for a cluster; selecting
any other turn for that cluster opens the same cluster action. Tagging searches
active Personas and offers an explicit create action. Exact duplicate names
are allowed because relationship text disambiguates humans.

Participants appear as compact chips ordered by first confirmed appearance.
Opening a chip navigates to that Persona. Transcript copy includes identity,
Source, and time so exported text does not lose provenance.

The user's own Voiceprint is a first-class registry entry but is not a normal
People lifecycle row: it cannot be archived or deleted while recognition is
enabled. Before Phase 1.5, non-matching microphone speech keeps the
`Microphone` label rather than claiming an in-room guest cluster.

## Phase 2: Memory

### People surface

Add `People` as a primary sidebar and tab destination with page title `People
June knows`. It is user content, not a Settings preference. The surface uses a
list/detail layout consistent with Projects:

- search and active/archived filters;
- name, relationship, Voiceprint count, and last seen in the list;
- editable identity, relationship, dossier, and Commitments in detail;
- source-note links for Commitments and meeting history;
- rename, archive, restore, and delete actions.

Every supported Persona field, Voiceprint summary, correction entry point,
Commitment mutation, and lifecycle action is reachable from June. Production
does not expose or require generated HTML, JSON files, a terminal command, or
another app for Persona management.

Archived Personas are hidden from recognition, the roster, and tag search by
default. Delete erases forward-looking Persona data and atomically freezes the
current name in past transcript rows. A separate destructive confirmation can
then scrub those frozen rows back to their stable anonymous labels.

Persona mutation emits a local invalidation event. Open note tabs reload their
Participants and transcript attribution so a rename or delete never leaves a
stale cached name.

### Commitments and dossier jobs

Add:

- `persona_commitments`: Persona, counterparty direction, text, optional due
  value, `open | done | dropped`, source note, and timestamps;
- `persona_dossier_jobs`: generation result and Persona ids, status, attempt
  count, error, and timestamps, with a unique idempotency key.

After a generated note is durably ready, enqueue one dossier job per trusted
Participant. `suggested` speech is excluded. Retry uses the same idempotency
key and must not duplicate prose or Commitments.

If automatic metered updates are approved, the app runs the job through the
configured agent model and surfaces billing or retry failures without changing
the completed note. If they are not approved, the same jobs remain pending
until the user explicitly requests an update. The transcript and relevant
existing dossier are the only model context; Voiceprints and embeddings are
never included.

### Agent integration

Extend the existing `june_context` MCP server rather than adding a competing
Persona server. Read tools may continue using read-only SQLite. Mutations cross
a dedicated token-scoped loopback adapter owned by the Tauri process because
the sandboxed Python MCP must not gain write access to the notes database.

Tools evolve additively:

- list and search the roster;
- get and update a dossier;
- list, create, update, and close Commitments;
- find notes with a Persona;
- fetch a note with resolved Persona attribution;
- create a prep brief request.

Hermes standing context receives only the active roster: Persona name plus one
relationship line. Full dossiers are fetched on demand. The shared `SOUL.md`
rewrite is atomic and refreshes after Persona changes without restarting or
cross-contaminating the sandboxed and unrestricted runtimes.

## Phase 3: Preparation

### Manual prep

`Prep me for my 1:1 with Name` resolves the Persona through the roster and
creates a normal editable note. The agent fetches recent notes, dossier prose,
and open Commitments through `june_context`, then writes:

- expected people;
- what was discussed and decided last time;
- open Commitments in both directions;
- relationship-shaped suggested asks;
- source-note references.

The brief is a note, not a popup and not a separate meeting entity.

### Detection-triggered prep

Extend the existing meeting detector with a stable detection episode id and
bundle id while retaining its friendly app label. Persist the detected app on
recording sessions and learn recurring patterns from app, local weekday/time
bucket, and confirmed Participants.

When a new detection episode has a sufficiently strong recurring match, offer
the expected people before recording. Generation begins only after the user
accepts, avoiding speculative metered work. A wrong guess is editable before
the brief is created. Calendar integration remains out of scope.

## Verification matrix

### Recognition and privacy

- Real-recording report passes and every cluster is human-audited.
- Same-person first cross-meeting match suggests; confirmation enables a later
  automatic match.
- Impostor and negative examples do not auto-name.
- Mixed, fragmented, silent, corrupt, and unsupported-runtime inputs degrade
  safely.
- Both Source lanes preserve turn detection and echo-trim invariants.
- No recognition-derived audio or embedding appears in network requests,
  events, logs, checkpoints, analytics, MCP output, or crash artifacts.
- Delete erases Persona, Voiceprints, clusters, dossier, Commitments, and
  roster membership; optional scrub replaces frozen names in past notes.

### Desktop behavior

- Every attribution band, correction, tag, and Participant action is covered
  in Rust repository/command tests and frontend interaction tests.
- The Transcription tab can preview each cluster and complete create, assign,
  reassign, confirm, and reject flows without leaving June.
- Legacy and live-preview transcripts remain Source-only.
- People covers empty, active, archived, edit, restore, delete, scrub, loading,
  error, dark-theme, narrow-window, and keyboard flows.
- Rename and delete invalidate every open note and tab projection.

### Agent and preparation

- Unconfirmed suggestions never enter dossiers.
- Dossier retries are idempotent and note completion is never rolled back by a
  dossier failure.
- Roster injection is compact and excludes archived Personas.
- Every `june_context` write validates the loopback token and arguments.
- Manual prep cites source notes and Commitments.
- Detection guesses use stable episodes, suppress duplicate offers, and never
  generate a metered brief before acceptance.

Run narrow Rust and frontend tests while iterating, then `make verify`, a native
agent-driven walkthrough with video evidence, the repository review battery,
and `make local-ci` on the final pushed commit.
