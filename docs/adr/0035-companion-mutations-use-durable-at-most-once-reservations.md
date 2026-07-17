---
status: accepted
date: 2026-07-17
---

# Companion mutations use durable at-most-once reservations

## Context

A stable mobile operation id is not enough to prevent duplicate side effects.
If Desktop submits a mutation and crashes before saving the response, a retry
can submit the same agent message, recording control, settings change, or note
edit again. An in-memory in-flight lock closes only the concurrent-request
window and is lost with the process.

There is no generic transaction shared by SQLite, the frontend, recording
state, and Hermes. Desktop therefore cannot always reconstruct whether an
interrupted cross-boundary mutation completed.

## Decision

- The companion saves a mutation's stable operation id to Keychain before it
  sends the encrypted request. A Keychain failure blocks the mutation.
- Desktop durably reserves every mutating operation id in SQLite before it
  crosses a side-effect boundary.
- A completed response atomically replaces the reservation. Ordinary retries
  return that saved response.
- If Desktop crashes after reservation but before completion, the reservation
  remains as a retryable outcome-unknown response. The same operation id is not
  dispatched again. The user must inspect June on the Mac before changing and
  submitting a new request.
- Reservations and completed responses share the existing seven-day and
  1,024-entry-per-device retention bounds. Revocation deletes both.
- OS Accounts sign-out stops new companion work and waits for the active relay
  operation barrier before it revokes account-scoped local authorization.

## Consequences

The protocol chooses at-most-once mutation dispatch over automatic recovery
when an operation's outcome cannot be proven after a crash. A rare interrupted
operation can remain unresolved instead of being transparently retried, but a
reconnect cannot silently duplicate an agent run or another side effect.

Read-only requests may still be repeated. Retryable failures that are known not
to be final are not saved as completed results; a mutation reservation remains
until a definitive result replaces it or retention expires.

Persisting only final responses, relying on an in-memory lock, and replaying
all ambiguous failures were rejected because each leaves a crash window for a
duplicate side effect.
