---
status: accepted
date: 2026-07-27
---

# Cancelled dictation takes never deliver

## Context

The dictation helper finalizes audio and emits `recording_ready` before Rust
starts the metered transcription and cleanup work. A discard can arrive just
after that event. Resetting only the helper and HUD leaves the spawned Rust
task alive, so it can still finish metered work, persist history, and send
`paste_text` after the user cancelled.

A process-wide cancelled flag is not sufficient. The helper can accept a new
dictation while an older request is unwinding, and a late result from the old
request must not cancel or deliver into the new take.

## Decision

- A **dictation take** has one opaque, bounded `takeId`, minted by the native
  helper when recording starts. macOS and Windows include it in
  `listening_started`, `finalizing_transcript`, `recording_ready`, and
  `recording_discarded`.
- Rust creates one cancellation token for that take at `listening_started` and
  passes the same token into the task spawned for `recording_ready`.
- `discard_recording`, helper-originated discard, and intentional helper
  shutdown cancel the current token. Starting a replacement take also cancels
  any older current token. A terminal token remains correlated until the next
  take starts, so a queued or duplicate ready event cannot recreate authority.
- Metered transcription and cleanup, authentication, dictionary reads, and the
  awaited low-speech history write race the cancellation signal. If
  cancellation wins, June drops the pending future, removes temporary audio,
  and performs no later history, telemetry, helper command, or text delivery
  for that take.
- Cancellation and terminal delivery share one atomic claim. Only a pending
  take can transition to cancelled or delivering, so a completion observed
  after cancellation cannot regain delivery authority.
- Every terminal helper command carries the `takeId`. A helper that processed
  a discard silently rejects later text for that ID and rejects text that
  names a different active take. Missing IDs remain accepted for compatibility
  with an older app or helper. A replacement helper with no active take keeps
  ADR-0014's clipboard recovery behavior for work that survived a helper
  crash.

## Consequences

Cancel is now terminal across the frontend, Rust coordinator, and native
helper instead of being only a HUD reset. A user can begin another dictation
without an older task inheriting its paste target or lifecycle.

Dropping an in-flight HTTP future is the strongest cancellation available at
the desktop boundary. It prevents June from starting later metered cleanup and
local side effects, but it cannot revoke a charge that June API had already
settled before the cancellation was observed.

The helper protocol change is additive. Older counterparts omit or ignore
`takeId` and continue through the single-active-take compatibility path.

Using only a task abort handle was rejected because it does not correlate
helper commands or protect a replacement take. Guarding only in the helper was
rejected because transcription, cleanup, history, and telemetry would still
run. A global generation flag was rejected because it cannot safely represent
an old cancelled task and a new active take at the same time.
