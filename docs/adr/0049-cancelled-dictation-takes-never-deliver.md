---
status: accepted
date: 2026-07-27
---

# Cancelled dictation takes never deliver

## Context

The dictation helper finalizes audio and emits `recording_ready` before Rust
starts the metered dictation transcription and cleanup work. A discard can
arrive just after that event. Resetting only the helper and HUD leaves the
spawned Rust task alive, so it can still finish metered work, persist history,
and send `paste_text` after the user cancelled.

A process-wide cancelled flag is not sufficient. The helper can accept a new
dictation while an older request is unwinding, and a late result from the old
request must not cancel or deliver into the new take.

## Decision

- A **dictation take** has one opaque, bounded `takeId`. Rust mints it before
  writing a start command so pending and active helper events share the same
  identity; a helper paired with an older coordinator mints a fallback.
  macOS and Windows include it in `listening_started`,
  `audio_level`, `finalizing_transcript`, `recording_ready`,
  `recording_discarded`, `final_transcript`, `paste_target`,
  `paste_completed`, and take-owned errors. Rust-generated take outcomes carry
  the same ID.
- Rust creates one cancellation token for that take at `listening_started` and
  atomically grants its first `recording_ready` event the sole processing
  claim. Duplicate ready events cannot start another metered request. Rust
  passes the claimed token into the spawned task.
- `discard_recording`, helper-originated discard, and intentional helper
  shutdown cancel the current token. Starting a replacement take also cancels
  any older current token. A terminal token remains correlated until the next
  take starts, so a queued or duplicate ready event cannot recreate authority.
- Metered dictation transcription and cleanup, authentication, and dictionary
  reads race the cancellation signal. A low-speech history insert remains
  inside an uncommitted SQLite transaction until the take wins its terminal
  delivery claim; cancellation rolls the transaction back. If cancellation
  wins, June drops the pending future, removes temporary audio, and performs no
  later history, telemetry, helper command, or text delivery for that take.
- Cancellation and terminal delivery share one atomic claim. Only a pending
  processing take can transition to cancelled or delivering, so a completion
  observed after cancellation cannot regain delivery authority. The claim is
  the point of no return: a later discard can still make the helper reject
  text, but it does not retroactively cancel local side effects already
  authorized by a delivery claim that won first.
- Start-time authentication cancellation and all interactive helper controls
  share one generation lock. June validates the authentication result, writes
  its discard, resets the matching shortcut activation, and emits the
  correlated sign-in event while holding that lock; focusing the main window
  happens after release. Start, stop, discard, and toggle controls snapshot
  their target take, update shortcut state, advance the generation, and write
  the helper command under the same lock. Take-owned helper lifecycle events
  hold that lock through correlation, controller changes, and frontend
  emission. A stale signed-out result, delayed terminal-control write, or old
  helper outcome therefore cannot enqueue a discard, stop, or lifecycle reset
  behind a newer start. Because a helper can reject a pending start without
  advancing the command generation, signed-out cleanup also proves that its
  exact pending or confirmed take is still owned. It retires only that start
  and emits a correlated event; an already rejected start cannot clear a
  previously confirmed recording. An event suppressed to preserve that
  recording does not consume the visible-prompt dedupe window. Malformed
  `recording_ready` cleanup shares the same ordering lock. When an older
  helper's untagged outcome loses to a replacement start, June cancels the
  prior token without sending a take-blind discard that could stop the
  replacement.
- Every terminal helper command carries the `takeId`. A helper that processed
  a discard remembers that ID for its process lifetime and silently rejects
  later text for it. Tagged text, stop, and discard commands cannot affect a
  different active or pending take. Rust tracks requested starts separately
  from helper-confirmed ownership: `listening_started` promotes a pending ID,
  including when an older helper omits that ID from its acknowledgement. Rust
  mints a legacy fallback only when no pending ID exists. A correlated start
  rejection rolls the pending ID back without losing control of the prior
  recording. A terminal command for an older visible take is still sent for
  the helper to authorize, but it cannot reset the pending replacement's
  keyboard state.
- The Dictation HUD ignores every tagged take-owned lifecycle event from an
  older take, not only discard. Rust rejects mismatched tagged events before
  generic controller, microphone-duck, indicator, or window handling. A
  matching prior-take terminal event may finish confirmed ownership while
  preserving a pending replacement; an asynchronous paste completion cannot
  hide that replacement after it starts. New helpers explain untagged terminal
  events with a reason; events with neither a take ID nor a reason retain the
  older-helper reset behavior. A reasoned, untagged idle event does not cancel
  crash-recovery work still owned by Rust. Missing IDs remain accepted while
  paired with an older app or helper. Once a helper emits a tagged lifecycle
  event, an untagged take-owned outcome cannot terminate the tagged active
  take; an untagged global error remains observable without changing that
  take's HUD or controller. A replacement helper with no active take keeps
  ADR-0014's clipboard recovery behavior for work that survived a helper
  crash.
- Native recorder callbacks carry a recording-instance identity in addition to
  the take ID. macOS selected-device teardown, level, failure, and speech
  analysis callbacks may run after discard has started another recorder; only
  callbacks from the still-current recorder may mutate controller state or
  emit a take-owned event.

## Consequences

Cancel is now terminal across the frontend, Rust coordinator, and native
helper instead of being only a HUD reset. A user can begin another dictation
without an older task inheriting its paste target or lifecycle.

Dropping an in-flight HTTP future is the strongest cancellation available at
the desktop boundary. It prevents June from starting later metered cleanup and
local side effects, but it cannot revoke settlement that June API already
spawned or committed before cancellation was observed. That detached
settlement may finish after the desktop has cancelled the take.

The helper protocol change is additive. Older counterparts omit or ignore
`takeId` and continue through the single-active-take compatibility path.
This supersedes only ADR-0014's earlier consequence that `paste_text` carries
no state guard; its pinned-target and helper-crash recovery decisions remain
unchanged.

Using only a task abort handle was rejected because it does not correlate
helper commands or protect a replacement take. Guarding only in the helper was
rejected because dictation transcription, cleanup, history, and telemetry
would still run. A global generation flag was rejected because it cannot
safely represent an old cancelled task and a new active take at the same time.
