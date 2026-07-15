---
status: accepted
date: 2026-07-15
---

# Durable note transcription jobs keyed by saved-audio source spans

Note transcription uses a durable, versioned job ledger derived from finalized
source WAVs. The user-visible `transcripts` table remains the current output
projection; it is not the workflow queue.

## Context

The saved-audio pipeline previously used transcript rows as both results and a
retry cache. A cached row was identified by recording session, Source, and
`turn_index`, then accepted when its approximate bounds matched a newly
detected Turn. This left several failure modes:

- adding or removing an earlier Turn shifted later indexes and could leave
  obsolete successful rows visible after retry;
- model, dictionary, chunk-policy, and pipeline changes could silently reuse
  text produced by different inputs;
- microphone-only notes used a separate insert-only path and could duplicate
  results on retry;
- a crash lost the in-memory work queue, even though the source WAV survived;
- checkpoint telemetry was written in the critical path and could reject a
  valid provider result before or after its transcript was committed;
- provider requests from two Turns on one Source could overlap, making context
  depend on unrelated completion order.

ADR-0005 already makes the finalized per-Source WAV the durability commit and
retry source of truth. ADR-0002 already makes live transcript preview
provisional and non-authoritative. This decision preserves both constraints.

## Decision

Persist one **note transcription job** for each planned authoritative Source
span. A job is identified by a stable `span_id` derived from recording session,
Source, job kind, and exact start/end bounds. `turn_index` remains presentation
order, never cache identity.

Each job stores an input fingerprint covering:

- the source artifact checksum;
- Source, job kind, and exact time bounds;
- transcription provider and configured language/dictionary revision;
- chunk policy; and
- an explicit note-transcription pipeline version.

Unchanged fingerprints may reuse succeeded output. Changed fingerprints reset
the job to pending and produce a different provider operation ID. Transient
retries of one unchanged job keep the same operation ID.

At the start of every processing pass, June transactionally reconciles the
complete planned Turn set with the ledger. Obsolete jobs are superseded and
obsolete transcript rows are removed from the current projection. A retry that
detects fewer or shifted Turns therefore cannot leak text from an older plan.

Workers claim pending jobs atomically. Job success and transcript upsert commit
in one SQLite transaction. A successful full-Source fallback replaces that
Source's partial rows in the same transaction; a failed replacement preserves
the prior rows. Provider and persistence checkpoint telemetry is best-effort
after the authoritative transaction.

Microphone-only and dual-Source recordings use the same Source-aware pipeline.
A microphone-only recording is represented as an authoritative full-Source
Turn rather than using the legacy insert-only transcript path.

Scheduling permits at most one provider request per Source and two requests
globally. Later Turns on a Source receive deterministic context from completed
earlier Turns on that Source. Preparation may continue ahead through a bounded
producer, but it cannot create same-Source provider overlap.

On process restart, jobs left `running` return to `pending`. June continues to
use its explicit recording-recovery surface rather than silently spending
credits at application launch; retry resumes the reconciled jobs from saved
audio.

Live preview may share Source/time coordinates with authoritative Turns, but
its text is never written to `transcripts` or used for note generation. The UI
may retain provisional preview text after Stop until overlapping authoritative
rows arrive, then replaces it by recording session, Source, and time overlap.

## Consequences

- Retry becomes deterministic and restart-safe without storing temporary Turn
  WAVs; they remain reproducible from finalized source artifacts.
- Cached text is invalidated deliberately when any output-affecting input
  changes.
- Partial source fallback cannot erase usable transcript rows unless the
  replacement transcript commits successfully.
- A small amount of local workflow state and migration complexity is added.
- The current projection does not preserve historical transcription attempts;
  checkpoints retain diagnostics while the ledger retains attempt count and
  the latest error.
- Automatic background resume and durable note-generation scheduling remain
  separate decisions. This ADR makes transcription resumable without changing
  launch-time billing behavior.
