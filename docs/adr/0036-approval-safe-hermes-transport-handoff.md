# ADR 0036: Approval-safe Hermes transport handoff

Date: 2026-07-16
Status: accepted

## Context

ADR 0025 made Hermes approvals identity-addressed, targeted, bounded, and
fail-closed. A separate race remained when June remounted an active session.
Closing the old WebSocket client returns before Hermes finishes its asynchronous
transport cleanup. A replacement `session.resume` can therefore rebind the live
session first. The old disconnect cleanup then no longer owns that session and
does not drain an approval callback captured by the old transport.

This is unsafe in both directions. A pre-handoff approval can arrive on the new
client and look actionable even though it belongs to the old transport, while
discarding every approval received before the resume response can lose a
genuinely new request emitted by the replacement transport.

## Decision

June extends the sealed compatibility patch to `june-approval-v2`. ADR 0025's
targeted protocol remains binding, including the rule that June never sends
`all: true`.

- Each registered gateway approval callback is wrapped in one notifier
  generation. Entering the wrapper increments an in-flight count; a deactivated
  generation rejects later calls and can be awaited until every call that
  already entered has returned.
- A live `session.resume` that changes transports first rebinds the session to
  the replacement transport, then atomically deactivates the old notifier,
  installs the replacement notifier, removes every old queued approval, and
  writes fail-closed tombstones for every primary and reconnect-alias request id.
- The handoff waits for already-entered old notifier calls to finish before it
  signals the retired approval threads and before `session.resume` returns.
  Captured old callbacks that have not entered reject before queue arbitration,
  receive a fail-closed tombstone, and cannot join a fresh replacement-generation
  entry through logical-request deduplication.
- Retired visible requests emit targeted `approval.expire` events with reason
  `transport_handoff`.
- The live resume result includes additive
  `retired_approval_request_ids: string[]`. The list is sorted for deterministic
  handling and includes primary ids plus reconnect aliases. June can stage
  approval frames until the response, retire ids named by this field, and keep a
  staged request whose id is absent because it came from the new notifier
  generation.
- A same-transport resume does not replace the notifier or retire pending
  approvals. The response still carries an empty
  `retired_approval_request_ids` list.
- If a newly appended content-bearing assistant row has committed while its
  ID-less `message.complete` is still pending the same transport decision, the
  resume result also carries
  `pending_message_complete: { assistant_ordinal: number }`. The ordinal is
  zero-based across content-bearing assistant rows in the response's own
  `messages`; blank reasoning and tool-call-only rows do not consume one.
  Resume either snapshots this marker and swaps first, or completion clears it
  only after the selected transport accepts the exact completion frame. The
  marker is optional: June uses only this server proof to align staged
  transcript frames; identical text alone remains ambiguous and is kept.
- Transport selection, the exact `message.complete` write, and its Boolean
  outcome serialize on the history lock. A rejected old-transport write retains
  the exact payload and any available ordinal proof. Live resume swaps the
  transport, snapshots the proof, and retries that payload on the replacement
  before returning. A rejected replacement keeps it for a later resume; a
  successful write clears it exactly once. An unproven completion still retries
  without adding ordinal authority. No later Agent run can clear or replace a
  retained completion: user submissions retry it before starting, goal
  continuations defer, and process notifications requeue. A deferred goal is
  released only after the current transport's resume response write succeeds.
  Every live resume arms or retargets this transport-owned barrier in the same
  history-lock transaction as its swap and snapshot, preserving the order of
  the old completion, the resume snapshot, and the next `message.start` even
  when the original emitter succeeds immediately after that snapshot.
- Disconnect unregister also deactivates and waits for its notifier generation,
  preserving the same fail-closed boundary outside resume handoffs. Disconnect
  cleanup and live resume share the resume lock, and cleanup rechecks transport
  ownership before detaching so a stale disconnect snapshot cannot clobber the
  replacement transport or its notifier.
- The patcher and Rust bridge verify the new post-patch source hashes. The
  upstream Hermes pin remains unchanged.

## Consequences

- A successful live resume response is a server-confirmed approval handoff
  barrier, not an inference from the timing of client-side `close()`.
- Old approvals cannot become actionable on the replacement route. New
  approvals racing just before the response are retained by request identity.
- A completed assistant row cannot appear once from the resume history and once
  from a staged ID-less completion when the server supplies the overlap proof;
  ambiguous cases deliberately retain live text instead of risking data loss.
- A completion rejected by a closed transport remains deliverable across one or
  more replacement transports; successful emitter-first and resume-retry paths
  cannot both emit it.
- Resume can wait briefly for an approval event write that already entered the
  old callback. This favors a provable fail-closed boundary over returning while
  old callback work is still in flight.
- The response field is additive to the pinned embedded runtime contract. No
  June API deployment is required.

## Alternatives considered

- **Send `approval.respond` with `all: true` before resume.** Rejected because it
  violates ADR 0025 and can resolve distinct legitimate approvals together.
- **Wait only for the old client close promise.** Rejected because WebSocket
  server cleanup is asynchronous and can lose ownership after the live session
  is rebound.
- **Discard every approval received before the resume response.** Rejected
  because the replacement notifier can legitimately emit a new approval before
  the response is written.
- **Add only a client-side timing delay.** Rejected because timing does not prove
  callback retirement and behaves differently under load.

## 2026-07-16 addendum: live snapshot ownership

The expanded ownership contract advances the sealed compatibility patch to
`june-approval-v3`, ensuring installs stamped with an earlier patch set are
rebuilt before the new hashes are verified.

`session.activate` also swaps transport while returning a live session
snapshot. It participates in the same acknowledgement barrier as
`session.resume`: activation atomically retargets the barrier to its transport,
and only the current snapshot transport's successful response write releases
Agent run continuations. A live-payload caller that attempts to replace a
different transport while a snapshot acknowledgement is pending must either
participate in that protocol or fail closed. This prevents a racing activation
from stranding the prior resume barrier and rejecting all later prompts.
Activation, resume, and disconnect serialize ownership changes under the same
lock. Barrier authority is a distinct in-memory token for each live snapshot,
not transport identity alone, so an older response on the same socket cannot
release a newer snapshot's Agent run continuations.
`session.resume`, `session.activate`, and `prompt.submit` enter one
receive-ordered ownership lane. A prompt cannot change transport by itself; a
replacement client must complete resume or activation first so stream,
snapshot, and approval-notifier ownership move together. Disconnect cleanup
and idle reaping use the same ownership lock and recheck the exact session
before detaching or finalizing it.
