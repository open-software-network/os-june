# Tool Guard agent model proxy flow

June integrates Tool Guard in the desktop provider proxy, not in Hermes. Hermes
continues to use its upstream image unchanged and points its OpenAI-compatible
model config at June's local `/v1/chat/completions` proxy.

## Request path

1. Hermes sends a chat-completions request to June's local provider proxy.
2. The proxy inspects outgoing `role: "tool"` messages before forwarding the
   request to scribe.
3. Each tool result is sent to scribe `/v1/tool-guard/results` with an absolute
   future `deadlineMs`. scribe forwards the detection-only request to OS-Guard.
4. If OS-Guard returns findings or advisories, June emits a local review event
   and waits for the user decision.
5. June applies the approved redaction operations locally and stores only the
   placeholder-to-original mapping in memory.
6. The redacted request is forwarded to scribe for model inference.

## Response path

1. June forces the upstream model request to `stream: false` so the response can
   be inspected before Hermes sees tool calls.
2. The proxy buffers the successful model response and scans
   `choices[].message.tool_calls`.
3. Each proposed tool call's `function.arguments` payload is sent to scribe
   `/v1/tool-guard/calls`.
4. Findings or advisories trigger the same local review event. Approved
   redactions are applied to `function.arguments` before the response is
   returned to Hermes.
5. If Hermes requested streaming, June converts the guarded buffered completion
   into a minimal SSE response. Otherwise it returns guarded JSON.
6. Final assistant text is rehydrated from the local in-memory mappings before
   it is returned to Hermes.

## Failure behavior

Tool Guard fails closed. If analysis, review, redaction, rehydration, or the UI
decision path is unavailable, the provider proxy returns an OpenAI-shaped `403`
with `tool_guard_blocked`. It does not forward raw tool results or raw proposed
tool-call arguments after a guard failure.

## OS Guard policy blocks

Agent chat normally reaches the model through Scribe API
`/v1/chat/completions`, which routes to OS Guard. When OS Guard returns a
Scribe envelope with `403` and either `error_code: 4031` or
`message: "policy_blocked"`, the desktop provider proxy pauses the Hermes turn
and emits `agent-policy-block-decision-request` to the main window.

The user can reject or continue:

- Reject returns a valid empty assistant completion to Hermes. June keeps the
  blocked prompt card visible and marks that session read-only.
- Continue retries the same OpenAI-compatible body through Scribe API
  `/v1/chat/completions/direct`, which routes agent chat directly to Venice.
  The desktop proxy remembers a fingerprint for the live conversation so later
  calls in that same session stay on the direct route.

Only agent chat has this direct fallback. Note generation and dictation cleanup
continue to route through OS Guard.

## Data handling

scribe and OS-Guard receive the tool-call arguments or tool results for
detection. They return findings, advisories, and redaction operations. June
performs redaction and final text rehydration locally, so the original
placeholder mappings stay in the desktop process and are not sent back to the
model provider.

## Local OS Guard block testing

Configure local Scribe with OS Guard as the guarded chat upstream and Venice as
the direct upstream:

```sh
SCRIBE__UPSTREAMS__OSGUARD__BASE_URL=http://<osguard-host>:<port>/v1
SCRIBE__UPSTREAMS__OSGUARD__API_KEY=local-test-token
SCRIBE__UPSTREAMS__VENICE__API_KEY=<venice-api-key>
```

Use the current OS Guard endpoint from staging config or the team runbook. Do
not commit shared staging IP addresses to this file.

Then start the desktop app with the local Scribe API and trigger an agent prompt
that OS Guard blocks. The expected UI behavior is:

1. June shows a `Prompt blocked` card instead of the raw `policy_blocked`
   error.
2. `Reject` leaves the card marked rejected and disables the composer for that
   session.
3. `Continue` retries through `/v1/chat/completions/direct`, shows the direct
   Venice session warning, and keeps later model calls in that live session on
   the direct route.
