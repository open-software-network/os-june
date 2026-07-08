# ADR 0013: Agent recorder tool via frontend event

Date: 2026-07-07
Status: accepted

## Context

June's agent could search notes and use web or image tools, but it had no way
to start or stop a meeting recording when the user explicitly asked it to do so
(JUN-193). The native shell already exposes recording commands for the UI, and
the frontend owns the visible recorder state: creating a note, showing the
recorder bar, showing sidebar or floating recorder presence, and cleaning up a
fresh note if recording startup fails.

Starting capture directly from Rust would bypass that frontend state. The
recording could be active without the user seeing the recorder bar or the note
that owns the session, and the direct path would duplicate self-healing logic
that already exists in the UI.

## Decision

June ships a fourth built-in MCP server, `june_recorder`, for agent recording
control. Its tools call the existing loopback provider proxy with a bearer token
from `JUNE_RECORDER_PROXY_TOKEN`.

For start and stop actions, the proxy does not start or finish capture itself.
It creates a request id, emits `june://agent-recorder-request` to the main
webview, and waits up to 15 seconds for the frontend to resolve the request via
`resolve_agent_recorder_request`. The frontend services the event through the
same note creation, visible recording, stop, and processing paths used by the
normal UI.

`recording_status` is read directly from Rust-side active capture state because
it does not mutate recording state or affect visibility.

## Alternatives

- Start capture directly in Rust. Rejected because it could create an invisible
  recording, duplicate frontend-owned state transitions, and skip the tested
  cleanup path for a freshly created note.
- Leave the agent without a recording tool. Rejected because JUN-193 requires
  the agent to handle explicit user requests to start and stop recording.

## Consequences

- Agent-initiated recordings are visible in the same recorder bar and recorder
  presence surfaces as user-initiated recordings.
- The main webview must be alive and able to answer the event for start or stop
  actions to succeed.
- Start and stop actions can fail with a structured timeout after 15 seconds if
  the frontend does not acknowledge the request.
- The tool remains local. Starting or stopping a recording does not authorize,
  charge, or call June API.
