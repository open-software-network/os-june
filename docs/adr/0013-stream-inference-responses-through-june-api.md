# ADR 0013: Stream inference responses through June API instead of buffering

Date: 2026-07-08
Status: accepted

## Context

June API sits inside a TEE behind an nginx-based ingress (dstack-ingress) and
Phala's gateway. Until this change, every inference response was fully
buffered server-side: the agent chat proxy (`/v1/chat/completions`) read the
entire upstream Venice body — even when the client had sent `stream: true` —
and note generation (`/v1/notes/generate`) returned one JSON envelope after
the upstream call completed. While an upstream inference ran, June API emitted
zero response bytes.

An idle response is exactly what reverse-proxy read timeouts kill. Long
prompts reliably failed with nginx's `504 Gateway Time-out` before June API
ever answered; the embedded Hermes runtime retried three times into the same
wall (JUN-225). Raising proxy timeouts was rejected as the primary fix: the
dstack-ingress image exposes no read-timeout knob in our compose file today,
the outer Phala gateway's limits are not ours to configure, and any fixed
ceiling just moves the cliff — a longer prompt still falls off it.

Buffering was not accidental. Metered billing settles from the upstream
`usage` block (ADR-less but documented in docs/june-api-prd.md: authorize →
upstream → charge), and the buffered body was where usage got parsed. The
groundwork for streaming metering already existed — `stream_options.
include_usage` was injected into streamed requests so the final SSE frame
carries usage — but no code path actually streamed.

## Decision

Keep response bytes flowing for every long-running inference call, and settle
charges after the stream ends.

- **Agent chat (`stream: true`)**: June API forwards upstream SSE bytes as
  they arrive. The provider pump accumulates the body on the side and
  resolves token usage from the final SSE frame once the upstream ends; the
  service settles the charge then (same idempotency key scheme as the
  buffered path). While the upstream is silent (long prompt evaluation), June
  API emits SSE comment heartbeats (`: keep-alive`) so neither proxy hop sees
  an idle response. Buffered (`stream` absent/false) behavior is unchanged.
- **Note generation**: `POST /v1/notes/generate` gains an opt-in
  `"stream": true` request field. The response becomes `text/event-stream`:
  comment heartbeats while generation runs, then a single terminal event
  (`event: result` carrying the exact buffered JSON envelope, or
  `event: error` carrying `{status, body}` of the exact buffered error).
  Old clients never send the flag; old backends ignore the unknown field and
  answer buffered, so the desktop client branches on the response content
  type. Wire contracts stay backward compatible in both directions.
- **Billing on interrupted streams** (deliberate product calls): if the
  client disconnects mid-stream, the provider keeps draining the upstream to
  capture the usage frame and the charge settles normally — matching buffered
  semantics, where a disconnect after send still charges. If a stream ends
  without a usage frame, the charge settles at the flat authorize estimate
  (clamped to the hold cap) with a loud error log: content was delivered and
  June does not silently absorb upstream cost, per the pricing policy in the
  June API PRD.

## Consequences

- Long-prompt chat and long-transcript note generation no longer depend on
  any proxy timeout being larger than inference time; first bytes flow within
  seconds regardless of prompt size.
- A streamed response can no longer change its HTTP status after failure
  mid-stream: agent chat clients see a truncated SSE body, and the generate
  endpoint reports errors inside the `event: error` payload with the status
  embedded. Clients must map that embedded status exactly as they map a
  buffered non-2xx response.
- The route-level tower timeout (600s) now bounds only the handler future
  (time to response headers); the streamed body is bounded by the upstream
  client's 600s total timeout instead.
- The client-facing chunk channel is unbounded so the provider can always
  drain the upstream to its usage frame at upstream speed — settlement must
  never be hostage to a slow reader. Worst-case memory equals the full
  response body, the same profile buffering had.
- Settlement for a streamed response happens in a spawned task after bytes
  were delivered. June API is stateless (no durable pending-charge ledger —
  the same property the buffered path has for a crash between upstream
  completion and charge), so a process death mid-stream loses that charge;
  the hold expiring protects the user, June absorbs the upstream cost. A
  durable settlement ledger is a deliberate non-goal here.
- Other buffered inference paths (`/v1/transcribe`, `/v1/dictate`,
  `/v1/generate` legacy shape, image generation) remain exposed to proxy
  read timeouts if their upstream calls run long. They keep working today
  (audio calls are chunk-bounded, image budgets fit); if one starts timing
  out, extend it with the same opt-in SSE envelope rather than a timeout
  bump.
