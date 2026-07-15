# Faster meeting transcriptions design

**Status:** Approved on 2026-07-15 after JUN-334 review; independent plan-audit corrections incorporated

**Target:** Reduce the time from pressing Done until the first saved transcript
turn appears and until transcription completes. Note generation latency is not
part of this change.

**Tracking issue:** JUN-334, "Reduce meeting transcription latency and ship a
measured improvement"

## JUN-334 alignment

JUN-334 asks for an end-to-end trace, a representative measured baseline, a
focused improvement with before/after evidence, stable progress or partial
output during long work, and regression coverage.

Its initial technical triage was written without access to the June desktop
source and does not apply to this repository. June has no Centaur
`workflows/muesli_meeting_ingest.py` workflow or meeting-upload ingestion path.
Pressing Done finalizes and validates local WAVs, the desktop detects and
prepares source turns, June API transcribes them, successful turns are persisted
incrementally, and note generation starts only after transcription finishes.
June also does not perform an unconditional final full-audio accuracy
transcription. Complete-source ASR is a failure-only fallback. The analogous
duplicate work in the real path is eager complete-source normalization before
ordinary turns have had a chance to succeed.

JUN-66, completed by commit `0d769d59`, added the note-processing progress UI.
The current UI retains a stable Preparing audio, Transcribing audio, or
Generating notes indicator and renders persisted source turns during
transcription. That satisfies JUN-334's progress requirement but did not reduce
latency. This change preserves and verifies that behavior rather than replacing
the UI again.

The requester narrowed the implementation target to Done-to-first-saved-turn
and Done-to-transcription-complete. The PR still characterizes the final-note
stage boundary for JUN-334, but optimizing note generation remains out of
scope.

## Problem

The microphone-plus-system meeting path has a local preparation wall between
turn detection and the first transcription request. In
`process_saved_source_audio`, June currently:

1. detects and coalesces every turn;
2. normalizes each complete source recording for a recovery fallback;
3. extracts and normalizes every ordinary turn; and only then
4. starts the bounded transcription scheduler.

The complete-source normalized copy is used only when every ordinary turn for
that source fails. Preparing it for every successful meeting performs a full
decode, downmix, peak scan, resample, and rewrite of each source before the
first provider request. Preparing all ordinary turns before scheduling also
prevents local audio work from overlapping network transcription.

This is the remainder of an earlier performance fix in commit `4ec3ef5a`.
That change reduced complete-source normalization from once per turn to once
per source and replaced prefix decoding with direct WAV seeking. The current
helper comment already states that the complete-source file exists only for
fallback, but the caller still prepares it eagerly.

The repository has no checked-in production latency samples, so this design
does not yet call either source the dominant end-to-end bottleneck. It targets
two code-proven sources of avoidable work, subject to the measurement gate
below:

- complete-source preparation on the successful path; and
- serial preparation of every turn before the first request.

## Audited Done-to-output path

1. `App.tsx` clears the recorder UI, marks the owning note Transcribing, and
   calls the native `finish_recording` command.
2. `commands.rs` finalizes source WAVs, validates and checksums each source,
   persists artifacts and checkpoints, and enqueues a per-note processing
   ticket.
3. A queued recording waits for earlier work on the same note. After acquiring
   the ticket, the default microphone-plus-system path enters
   `process_saved_source_audio`; microphone-only uses the separate
   `process_saved_audio` path.
4. The dual-source path filters silent sources, performs CPU-bound turn
   detection and echo rejection, prepares turn WAVs, then starts at most two
   transcription jobs. The microphone-only path normalizes the complete source
   and transcribes provider-safe chunks serially.
5. Each service-managed request uploads buffered audio to June API, which
   authorizes OS Accounts metering, calls the speech provider, settles the
   charge, and returns. The default non-OpenAI path then performs a cleanup
   inference before the turn is complete.
6. Each successful dual-source turn is persisted immediately. The selected
   note is polled once per second and `NoteEditor` renders persisted turns while
   Transcribing remains active.
7. After all ordinary jobs, permitted fallbacks, failure persistence, and
   coverage checks finish, the note enters Generating. June API performs the
   buffered note-generation request, the desktop persists the result, and the
   note becomes Ready.

Provider inference, OS Accounts round trips, cleanup, generation, queue wait,
and local DSP can all contribute to wall time. The pre-change benchmark is
therefore required before describing local preparation as dominant.

## Success criteria

For a microphone-plus-system meeting with at least one successfully
transcribed ordinary turn:

- production checkpoints report Done-to-first-provider-request,
  Done-to-first-persisted-turn, and Done-to-transcription-complete;
- the synthetic benchmark reports the corresponding post-finalization handoff
  intervals without presenting them as actual capture-finalization timings;
- the first provider request can begin before all later turns are prepared;
- the first successful turn is persisted as soon as its existing cleanup step
  finishes;
- no complete-source fallback normalization runs for a source that already has
  a valid ordinary or cached turn;
- provider transcription concurrency remains bounded at two;
- transcript order, source attribution, context, retries, persistence, billing,
  and generation inputs retain their current behavior; and
- the change requires no June API deployment.

The first persisted turn is the native availability boundary. The selected
note is reconciled by a one-second frontend poll, so visible output follows
persistence by 0 to 1 second plus database, IPC, reducer, and render time. The
PR reports persisted and visible behavior separately and does not label the
database timestamp as exact UI-visible latency.

For a source whose ordinary turns all fail, fallback behavior remains
available and its complete-source audio is normalized exactly once, immediately
before the fallback request.

## Constraints

The implementation must preserve these existing decisions and safeguards:

- Final transcription uses finalized, validated saved audio. Live preview text
  remains ephemeral and is never promoted to the final transcript.
- Microphone and system sources remain separate.
- The transcription provider limit stays at two. Commit `bf4e5022` deliberately
  reduced it from four while adding retry resilience.
- A source touched by echo trimming must never fall back to its raw complete
  source, because that would restore remote speech that was deliberately
  removed from the microphone lane.
- Cached turn bounds must still match before their transcript is reused.
- Partial turn persistence continues before note generation, and final
  candidates remain chronological.
- The current processing-stage indicator and rendering of partial persisted
  source turns remain intact.
- Existing `/v1` request, response, metering, and provider-routing contracts do
  not change.
- Per-note processing remains serialized so generation sees the previous
  recording's completed note content.
- Temporary audio stays inside the session-scoped directory and is removed only
  after preparation, transcription, and any fallback work have ended.

## Options considered

### 1. Lazy fallback normalization only

Keep the current prepare-all-then-transcribe flow, but retain the raw source
path and normalize it only when fallback is selected.

This is small and low risk. It removes one full-source pass per source on the
successful path, but it still waits for every ordinary turn to be extracted and
normalized before starting the first request. It does not fully address the
first-saved-turn target.

### 2. Lazy fallback plus bounded preparation pipeline

Represent ordinary turns as inexpensive preparation descriptors, prepare them
in order on one blocking producer, and feed completed jobs into the existing
bounded transcription scheduler. Start transcription when the first prepared
job is available while later turns continue preparing. Normalize
complete-source audio only if fallback is selected.

This is the selected approach, subject to the pre-change measurement gate. It
can improve both targeted intervals without raising provider concurrency or
changing a server contract.

### 3. New batch transcription API

Add an additive `/v1/notes/transcribe-batch` endpoint to collapse repeated OS
Accounts authorize and settlement round trips.

This may improve total completion time further, but it requires a June API
deployment and new partial-failure, idempotency, pricing, and hold semantics. A
batch response also does not naturally improve the time to the first persisted
turn. It is deferred until production stage timings justify the larger change.

## Pre-change measurement gate

After the implementation plan and independent codebase audit, but before any
production-path refactor, add the benchmark-only harness described below and
run it unchanged against production baseline commit `06f4925e`.

Benchmark both processing paths:

- microphone-plus-system is the primary case and exercises real turn
  detection, extraction, normalization, incremental persistence, and fallback
  metadata;
- microphone-only is the control case because it uses a separate serial chunk
  pipeline and will not benefit from this design.

Proceed with the selected production change only when the five-minute
baseline's existing `turn_wav_extraction.durationMs` median consumes at least
20 percent of median handoff-to-first-provider-request. That stage is the
current synchronous cache lookup, extraction, ordinary-turn normalization,
and eager fallback-normalization wall. Do not substitute detection-checkpoint
to request-arrival time: that interval also includes unrelated checkpoint I/O,
request setup, authentication, and socket work. If the primary preparation
wall misses the threshold, stop and revise the design around the measured
bottleneck. If the microphone-only control is slower, report it explicitly and
create a scoped follow-up rather than implying this PR improves every meeting
mode.

After implementation, the five-minute median handoff-to-first-committed-turn
must improve by at least 20 percent and median
handoff-to-transcription-complete must improve by at least 10 percent. The
microphone-only control must not regress by more than 5 percent. First-request
latency remains a reported diagnostic rather than a substitute for either user
outcome. Exact structural tests must also show zero complete-source fallback
preparation on the successful path. Do not weaken these thresholds after
seeing the results.

## Detailed design

### Turn descriptors and prepared jobs

Split the current `TurnTranscriptionJob` construction into two phases:

- A lightweight descriptor owns the source metadata, raw source path, turn
  bounds, output paths, fallback eligibility flags, silence metadata, and turn
  index. Building descriptors must not decode or rewrite audio.
- A prepared job owns the normalized ordinary-turn path consumed by
  `transcribe_one_turn_job`, plus the unchanged metadata needed for operation
  IDs, persistence, failure reporting, and fallback decisions.

Cached turns bypass preparation exactly as they do now. The raw complete-source
path stays metadata; it is not converted into the ordinary job's `audio_path`.
Per-source fallback metadata is derived from the complete descriptor list
before streaming begins. It must not depend on collecting only the prepared
jobs that happen to arrive through the channel.

### Bounded preparation and transcription

Run one ordered audio-preparation producer with `tokio::task::spawn_blocking` so
extraction and normalization do not occupy the async executor's core workers.

Preparation must preserve descriptor order and use bounded backpressure. The
prepared-job channel has capacity two, matching the existing transcription
concurrency. The transcription consumer starts as soon as the first job is
prepared and continues to enforce no more than two active provider requests.

The single producer continues preparing later turns while earlier provider
calls are in flight. It must close its output when all descriptors are prepared
or send a terminal preparation error. The consumer must not treat channel
closure as successful completion until it has joined all in-flight
transcription work.

The existing scheduler currently derives request context at job-spawn time from
completed inputs. This design preserves that behavior. Correcting the separate
same-source-lane specification gap is out of scope because changing scheduling
and context semantics in the same performance PR would make regressions harder
to attribute.

### Partial persistence and ordering

Each completed turn still goes through the existing result sink before the
scheduler admits replacement work. A successful turn therefore remains saved
as soon as its transcription and cleanup complete.

Completion order may differ from chronological order, as it already can. The
final outcome continues to sort candidates and failures by turn index and start
time before coverage calculation and note generation.

No generated note content is produced until the complete transcription outcome
passes the existing coverage and visible-failure checks.

### Lazy complete-source fallback

After all ordinary prepared jobs have completed, evaluate fallback separately
for each source using both fresh and cached valid candidates.

If a source already has a non-empty valid candidate, skip fallback without
opening or normalizing its complete-source WAV.

If no valid candidate exists:

1. apply the existing fallback eligibility checks;
2. reject fallback when all jobs already cover the complete source;
3. reject fallback when any job for the source was echo-trimmed;
4. normalize the raw complete-source WAV once on a blocking worker; and
5. submit the resulting job through the existing transcription and persistence
   path with the existing source-level operation ID.

Fallbacks remain rare recovery work. They continue to run after the ordinary
scheduler rather than competing with ordinary turns for its two provider
slots.

### Error handling

An ordinary-turn preparation error is a pipeline error, not a provider speech
failure. The producer sends the first error and stops preparing new work. The
consumer joins already-started jobs, persists any completed results through the
normal sink, then returns the preparation error. It must not proceed to
complete-source fallback or note generation after a terminal preparation
error.

The producer returns a preparation report on success and failure. The caller
persists that report and flushes any captured first-event telemetry before it
propagates a terminal error. Error draining never creates replacement launch
permits, and receiver closure counts as success only after every scheduled
descriptor has been received.

Provider errors retain the current per-turn failure and retry behavior. They do
not stop preparation of later turns. If every ordinary provider result for a
source is unusable, the lazy fallback rules apply.

A fallback normalization error follows the current full-source preparation
failure behavior: processing fails rather than silently discarding a source.

No detached producer, blocking task, channel sender, or provider job may
outlive the session temp directory. Cleanup runs only after all owned work is
joined, including error paths.

### Observability

Retain the existing `turn_detection`, `turn_wav_extraction`, per-request,
per-persistence, generation, and processing checkpoints.

Move the `finish_recording` timing origin to the command's first statement,
before repository lookup and `finish_capture`, then carry that native Done
origin through `finish_recording_session`, queue wait, and the spawned
processing task. Other recovery or retry entry points may omit the origin; the
normal Done path must always provide it.

Add or extend structured checkpoints for:

- audio validation completion, including Done-to-validation-complete;
- acquisition of the per-note processing ticket, including Done-to-dequeue;
- completion of ordinary-turn preparation;
- the first actual transcriber invocation, recorded immediately before calling
  the `TurnTranscriber`, not when a scheduler slot is assigned;
- the first successful transcript-row persistence;
- `transcription_complete`, after ordinary jobs, permitted fallbacks, failure
  persistence, and coverage decisions, but before the note enters Generating;
  and
- existing generation/processing completion, with Done-relative duration for
  final-note stage characterization.

Record both stage-relative duration and `doneToDurationMs` where useful. A
first-event checkpoint is written once even when two requests race. Details may
contain durations, counts, source, and turn index, but never transcript text,
audio bytes, titles, or note content.

Preparation reporting separates active DSP time from backpressured producer
wall time. `activePreparationDurationMs` sums time inside the synchronous
preparer. `producerWallDurationMs` includes capacity-two channel backpressure,
and `doneToPreparationCompleteMs` records when the producer actually finishes.
Do not compare backpressured producer wall time with the baseline's synchronous
`turn_wav_extraction.durationMs` as though their semantics were identical.

All new latency checkpoints are diagnostic and best-effort. Their write
failures are logged and never fail processing. The microphone-only path records
its own one-row success/failure counts and explicitly flushes first-event,
transcription-complete, generation, and processing-complete telemetry on each
terminal path rather than borrowing dual-source-only variables.

Apply the corresponding Done-origin metrics to the microphone-only control so
the benchmark compares the two real processing paths. The benchmark's loopback
server timestamp is the authority for actual request arrival; the production
checkpoint remains useful for installed-app diagnostics.

The first-persistence checkpoint is marked after the successful upsert and
measures native data availability. Frontend
visibility is reported as that timestamp plus the current 0-to-1-second poll
window and observed query/render time, not as an invented exact timestamp.

## Test design

Deterministic unit tests use synthetic WAVs, fake preparers, fake transcribers,
barriers, and exact operation counters. The non-gating benchmark uses the real
WAV and database path with a loopback fake June API. Neither path depends on a
real microphone, external provider, OS Accounts, credits, or internet access.

### Required deterministic tests

1. **Successful path skips complete-source work**
   - Multiple ordinary turns across microphone and system sources succeed.
   - The complete-source preparer call list is empty.
   - The baseline behavior would call it once per distinct source.

2. **First request starts before all preparation finishes**
   - The preparer releases the first turn and blocks a later turn.
   - The fake transcriber must start while later preparation remains blocked.
   - Releasing the barrier lets the pipeline finish normally.

3. **Provider concurrency remains bounded**
   - Barrier-controlled fake transcribers record active and maximum-active
     counts.
   - Exactly two jobs may start before the barrier is released, never three.

4. **Fallback is lazy and once per source**
   - All ordinary microphone turns fail while a system turn succeeds.
   - Only the microphone complete source is prepared, exactly once.
   - The fallback job uses the source-level operation ID and replaces visible
     failures on success as it does today.

5. **Two failed sources prepare independently**
   - Both sources require fallback.
   - Each raw complete source is prepared once, never once per turn.

6. **Echo-trimmed source never prepares fallback**
   - All remaining turns fail after microphone echo trimming.
   - Complete-source preparation and fallback transcription both remain zero.

7. **Cached success suppresses fallback**
   - Fresh ordinary jobs fail, but a bounds-matched cached candidate is valid.
   - No complete-source preparation occurs for that source.

8. **Preparation errors are joined and surfaced**
   - A later preparation fails while an earlier fake provider call is active.
   - In-flight work is joined, the terminal error is returned, fallback and
     generation are not started, and temp cleanup is safe.

9. **Final results remain deterministic**
   - Provider completions are deliberately reversed.
   - Persisted partials may arrive in completion order, but final candidates,
     failures, coverage input, and generated transcript input remain
     chronological and source-correct.

10. **Ordinary transcription quality inputs are invariant**
    - Baseline and pipelined preparation use the same turn bounds,
      `write_turn_wav`, and `normalize_wav_for_transcription` path.
    - Normalized sample streams or their deterministic hashes, operation IDs,
      request metadata, fake provider outputs, and final candidates are
      equivalent for ordinary successful turns.

11. **Done-origin checkpoints are monotonic and single-shot**
    - Two racing first requests or persistence events create one first-event
      checkpoint each.
    - Validation, dequeue, first request, first persistence, transcription
      completion, and processing completion durations are nondecreasing from
      the same Done origin.

12. **Existing progress and partial rendering remain visible**
    - A frontend fake-timer test advances the selected-note poll with a
      `transcribing` note containing a newly persisted source turn.
    - The stage indicator remains visible and the partial turn renders before
      the note becomes ready.

### Performance proof

The committed tests prove causal work reduction and overlap:

- successful-path frames decoded solely to prepare complete-source fallback
  audio fall from the sum of source durations to zero; and
- the first provider call starts before all ordinary-turn preparation ends.

Commit an ignored command-layer benchmark that passes a synthetic
`FinishedRecording` into `finish_recording_session` with an isolated SQLite
database and deterministic 48 kHz stereo WAVs. The microphone and system
fixtures contain alternating speech-like regions and silence so real
validation, queueing, turn detection, extraction, normalization, scheduling,
persistence, coverage, and cleanup paths execute.

Generate fixtures outside the timed region. This benchmark begins at the
post-finalization command handoff and therefore excludes real capture-helper
shutdown and WAV finalization. Label its results accordingly. The new
production checkpoints begin at actual `finish_recording` command entry and
cover those earlier stages; do not merge the two origins in PR evidence.

Run a loopback fake June API with a fixed 100 ms transcription delay, 25 ms
cleanup delay, and immediate generation response for
`/v1/notes/transcribe`, `/v1/dictate/cleanup`, and `/v1/notes/generate`. Only
the remote service is fake; WAV work and persistence are real. The fake server
records when the first transcription request arrives. A concurrent SQLite
observer records the monotonic instant when a successful transcript row first
becomes queryable after commit; the row's `created_at` is not used because it
is assigned before the upsert completes. A baseline-compatible test-only hook
records acquisition of the processing ticket. The first generate request is
the unambiguous boundary that transcription has completed.

Apply the benchmark-only harness unchanged to a temporary worktree at baseline
commit `06f4925e`. Run one warm-up and five measured release iterations with
one test thread, then run the same harness on the feature branch. Use generated
1-, 5-, and 10-minute cases for microphone-plus-system and a five-minute
microphone-only control. Report medians for:

- post-finalization handoff to validation completion and processing-ticket
  acquisition;
- turn detection and ordinary preparation wall;
- active preparation time and backpressured producer wall time after the
  refactor, reported with their distinct semantics;
- handoff to first fake-provider request arrival;
- handoff to first successful transcript persistence;
- handoff to transcription completion;
- handoff to ready under the fixed fake generation response, clearly labeled
  as orchestration characterization rather than production model latency; and
- microphone-only control timings.

Use the five-minute microphone-plus-system case for the pre-change and
post-change thresholds. The 1- and 10-minute cases demonstrate scaling rather
than acting as additional gates.

The benchmark belongs in PR evidence, not a timing-sensitive CI assertion.
Filesystem cache state, runner load, and debug builds make fixed millisecond
gates unreliable.

## Rollout and compatibility

This is a desktop-only internal scheduling change. It adds no dependency,
database migration, API field, endpoint, provider behavior, or billing change.
It does not need a June API deployment.

The existing processing checkpoints and deterministic tests provide rollback
signals. If pipelining exposes unexpected file or lifecycle behavior, the
producer/consumer stage can be reverted while retaining the independent lazy
fallback improvement.

No ADR is required. The change is an internal, reversible optimization that
implements the existing saved-audio, source-separated, bounded-concurrency
architecture without selecting a new long-lived boundary or wire contract.

## Out of scope

- Optimizing note generation latency or progressive generated content. The PR
  still characterizes the final-note stage boundary for JUN-334.
- Promoting live-preview text to final transcript data.
- Raising transcription concurrency above two.
- Changing per-turn transcript cleanup or model selection.
- Adding a batch transcription API or changing metering settlement.
- Fixing same-source sequential-lane scheduling and context semantics.
- Reworking microphone-only recordings to persist one row per 30-second chunk;
  that path remains a measured control and possible follow-up.
- Reducing finalization, source validation, checksum, or queue-wait time.
- Replacing the frontend's one-second reconciliation poll with push events.
- Correcting unrelated audio-pipeline documentation drift about the current
  provider chunk duration.

## Acceptance criteria

- All required deterministic tests pass.
- Existing native tests remain green.
- The unchanged release benchmark captures baseline `06f4925e` before the
  production refactor and satisfies the documented go/no-go thresholds.
- The PR reports production Done-origin checkpoints, benchmark handoff-origin
  intervals, the UI polling bound, and final-note stage characterization
  without conflating them.
- No successful ordinary path prepares a complete-source fallback WAV.
- Ordinary normalized audio inputs, request metadata, and transcript candidates
  remain equivalent under deterministic tests.
- Fallback, echo trimming, cache reuse, retries, partial persistence, coverage,
  ordering, and temp cleanup remain correct under tests.
- Existing progress and partial-output UI behavior remains covered; no frontend
  production component or June API contract changes.
- The PR description includes the root cause, benchmark evidence, visual-test
  status, backend-deploy status, JUN-334 traceability, out-of-scope items, and
  follow-ups.
