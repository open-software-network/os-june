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

- A **dictation take** has one opaque, bounded `takeId`, minted by the native
  helper when recording starts. macOS and Windows include it in
  `listening_started`, `finalizing_transcript`, `recording_ready`, and
  `recording_discarded`.
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
- Every terminal helper command carries the `takeId`. A helper that processed
  a discard remembers that ID for its process lifetime and silently rejects
  later text for it. Tagged text and discard commands cannot affect a
  different active or pending take. Missing IDs remain accepted for
  compatibility with an older app or helper. A replacement helper with no
  active take keeps ADR-0014's clipboard recovery behavior for work that
  survived a helper crash.

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
