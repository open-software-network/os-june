---
status: accepted
date: 2026-07-28
supersedes: 0041 (remote approvals only)
---

# Companion Computer use approvals are one-shot desktop interruptions

## Context

June Companion currently cannot approve agent tools. That limit kept the
original companion allowlist away from June's machine-touching authority, but
it also means a Computer use task started from the phone stops at an approval
card that can only be answered on the Mac.

Computer use already has two relevant boundaries:

1. The June-owned agent harness creates a durable approval interruption for
   every `computer_use` host-tool invocation.
2. The Rust Computer use broker enforces grant, plan, rollout, model, attended
   run, target identity, stale-capture, sensitive-field, blocked-app, and
   blocked-action policy. Its local first-app authorization normally becomes a
   task-scoped app grant.

The phone must not turn either boundary into a standing remote-control grant.
It must also not receive a generic agent, Tauri, helper, shell, filesystem, or
browser-broker executor.

## Threat model

The assets added to the companion trust boundary are the pending approval's
identity, action description, target app or URL, stored agent session, and the
authority to resume one parked tool invocation.

Relevant attackers and failures are:

- a malicious relay that replays, delays, reorders, substitutes, or observes
  messages;
- a linked but stale or compromised companion that guesses request ids,
  answers a request from another session, races another linked device, or
  retries an old approval;
- a model that supplies misleading or oversized arguments;
- a phone that disconnects after the prompt appears;
- a local and remote user answering the same prompt concurrently;
- a desktop policy or target that changes after the phone approves;
- an older companion that does not understand the additive capability.

Noise authentication, frame sequence checks, expiring frames, and durable
operation ids already reject relay replay and reordering. They do not by
themselves bind a decision to the durable agent interruption or stop a new
operation id from answering an old request. The desktop therefore needs a
second, short-lived registry keyed by the exact interruption.

## Decision

### One remotely approvable object

V1 remotely approves only approval interruptions for the existing
`computer_use` host tool. Browser broker approvals, connector approvals,
secrets, clarification, shell, files, recordings, routines, and every other
agent tool stay desktop-local. Browser use is studied because it shares the
experimental enablement flag, but its separate consequential-action broker is
not adapted or widened by this change.

The companion contract adds the explicit `computerUseApprove` capability. It
adds:

- a pending-request event with the stable SDK interruption/tool-call id,
  stored session id, action class, bounded description, optional target app,
  optional target URL, issue time, and expiry;
- an approve-or-deny request that repeats the request id and stored session id;
- status events for approved, denied, executing, succeeded, failed, expired,
  and cancelled outcomes.

The request id is the SDK's stable tool-call identity. The encrypted response
also carries the phone's ordinary unique operation id and monotonic Noise
sequence. Desktop accepts a decision only while the registry contains that
exact request id in that exact stored session and its 60-second deadline has
not passed. The first accepted local or remote decision wins. Wrong-session,
unknown, expired, duplicate, and replayed decisions fail closed.

### One-shot authority

A remote approval arms one permit for the matching `computer_use` tool call.
The host dispatch consumes it using the same stored session id and tool-call
id. The permit cannot authorize another call, another session, another target,
or a later retry.

When that permit reaches the Computer use broker, it replaces only the local
first-app prompt for that invocation. It never writes the broker's
task-scoped app-authorization set. A later Computer use invocation therefore
needs its own SDK interruption and its own phone or desktop decision.

A desktop-local approval keeps today's behavior, including the task-scoped app
grant. This preserves the existing local Computer use experience while making
remote authority strictly narrower.

### Desktop policy remains the ceiling

Approval resumes the existing host tool. It does not call the driver, Tauri,
or the helper directly. The Rust broker still rechecks every native
eligibility gate and target invariant at execution time. Anything it
auto-denies remains denied after a phone approval. Stop, grant revocation,
permission loss, rollout disable, task completion, target change, and shutdown
still cancel or refuse the action.

The durable desktop interruption stays visible while pending. A phone
resolution is persisted as a desktop receipt naming the linked-device source.
The local user can deny first, use the normal Stop control after execution
starts, or disable remote approvals. Resolution is serialized so a local and
remote race cannot resume the same interruption twice.

### Opt-in, availability, and fallback

Remote approval is off by default in Linked devices settings. Desktop emits and
accepts remote approval traffic only when:

- the Companion runtime is enabled;
- experimental Browser/Computer use is effectively enabled;
- the linked device is active and uses `computerUseApprove`;
- the desktop remote-approval toggle is on.

If no eligible phone answers before 60 seconds, Desktop denies the
interruption. The same durable card is visible on Desktop from the beginning,
so the local user can decide before that deadline. If remote routing was never
enabled for the request, existing desktop-only approval behavior is unchanged.
Disabling the toggle retires unconsumed remote permits and leaves Rust policy
and Stop authoritative.

The relay never queues control ciphertext. Multiple linked devices may see the
same request, but only the first valid decision can resolve it; status events
retire the prompt on the others.

### Bounded and truthful visibility

The phone receives only E2EE application data. The relay still sees routing
metadata and ciphertext size, never the request or decision.

V1 bounds the request id and stored session id at 128 bytes, action at 64
bytes, description at 2 KiB, app name at 256 bytes, and URL at 2 KiB. Desktop
derives the description and target from the existing typed tool invocation and
current verified Computer use target. It does not accept display copy supplied
by the phone or relay. A request that cannot produce a bounded valid
description stays desktop-local.

Audit logs record request id, session id, decision source, and lifecycle status
for every remotely surfaced approval. They do not record the action
description, target, URL, typed text, capture, or other content.

## Consequences

- Phone approval can resume one Computer use action without creating standing
  remote authority.
- A phone approval may still end in a Rust policy denial or stale-target
  failure. That is expected and visible in the execution status.
- A remote prompt adds a 60-second fail-closed deadline. Users who want a
  longer desktop-only decision path keep the toggle off.
- The companion protocol gains additive enum variants. Older clients remain
  usable because events are emitted only after the new opt-in; they must update
  before opting into this capability.
- Browser consequential approvals remain a separate follow-up. Reusing this
  capability for them requires a new decision that binds the browser broker's
  origin, tab, element, and action identity rather than treating a URL as
  sufficient authority.

## Alternatives considered

- **Give the phone the existing task-scoped app grant.** Rejected because one
  remote tap would authorize later actions that were not shown on the phone.
- **Expose the Computer use broker or driver to the companion.** Rejected
  because it bypasses the agent interruption, desktop policy ceiling, and
  existing execution lifecycle.
- **Approve every agent tool remotely.** Rejected because the request is
  specifically Computer use and the other tools have different authority and
  visibility requirements.
- **Persist remote permits across restart or reconnect.** Rejected because the
  relay has no offline control queue and a restarted execution context cannot
  prove that the displayed target is still current.
- **Let the relay carry a display label or approval decision in plaintext.**
  Rejected because a hostile relay could mislabel the action the user is
  authorizing.
