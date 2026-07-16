# ADR 0025: Targeted Hermes approval protocol

Date: 2026-07-16
Status: accepted

## Context

Hermes routes MCP elicitation consent through the same approval surface as
dangerous commands. In the pinned `v2026.6.19` runtime, that path discarded the
MCP SDK request id, appended every request to a per-session FIFO queue, emitted
`approval.request` without a stable identity, and resolved `approval.respond`
against the queue head. MCP reconnect retries could therefore create several
indistinguishable unresolved approvals for one logical elicitation.

June amplified the symptom when an idless frame was delivered more than once:
its compatibility fallback included the receive timestamp, so each delivery
became a new permission card. Filtering duplicate cards in React would not drain
the upstream queue and could let a click resolve a different request from the
one shown.

The protocol is a load-bearing integration boundary. It must distinguish
legitimate concurrent approvals, target the exact request the user answered,
and retire unverifiable requests without granting permission.

## Decision

June applies the sealed `june-approval-v1` compatibility patch to the exact
pinned Hermes source before building or installing the runtime.

- MCP elicitation preserves the SDK `RequestContext.request_id` as upstream identity.
  Missing, blank, boolean, or otherwise malformed identities decline without
  showing an actionable request.
- Hermes derives an opaque request id from the MCP surface, current tool call,
  and upstream request id. While a request is unanswered, a retry with the same
  tool-call/prompt identity after an MCP transport reconnect joins the existing
  queue entry. Separate requests delivered on the same transport remain
  distinct, including concurrent requests with matching prompt text. Retry
  aliases are bounded and receive the one targeted decision without emitting
  more cards.
- Existing command and code approvals derive their opaque identity from the
  gateway's turn/tool-call context, preserving those non-MCP flows while making
  their resolution targeted too. Missing context fails closed.
- `approval.respond` accepts `request_id` and resolves only that queue entry.
  June never sends `all: true`.
- The per-session queue is bounded at 32 unresolved entries and each logical
  entry accepts at most 16 reconnect aliases. Completed request tombstones are
  bounded at 128 per session and 256 sessions so a late exact replay reuses the
  prior decision without growing memory forever.
- Timeout, notification failure, queue overflow, malformed input, and gateway
  disconnect fail closed. Timeout and disconnect emit a targeted
  `approval.expire`; June retires the matching card and does not send a response.
- June treats approval resolution and expiration as sticky. A delayed duplicate
  cannot reopen a request. On an unexpected gateway close, the pre-drop card is
  retired locally before the stored session is resumed.
- The patcher verifies exact upstream and post-patch SHA-256 values for
  `tools/approval.py`, `tools/mcp_tool.py`, and `tui_gateway/server.py`. Source
  drift fails the build or managed install. Both macOS and Windows bundlers run
  the same patch and protocol smoke, stamp `PATCHSET`, and the bridge verifies
  managed runtime checksums before launch.
- Production runtime resolution accepts only the sealed bundled runtime or a
  verified June-managed install. Installation or checksum failure stops launch;
  June does not fall back to an unpatched user-local or `PATH` runtime. The
  explicit `JUNE_HERMES_COMMAND` development override remains available.
- The Hermes pin remains `v2026.6.19` at commit
  `2bd1977d8fad185c9b4be47884f7e87f1add0ce3`. The patch set is a separate
  provenance dimension and does not masquerade as an upstream pin.

## Consequences

- One logical MCP elicitation has one actionable card and one targeted decision,
  even when delivery or connection retries occur.
- A disconnected or timed-out card becomes a visible expired receipt. Retrying
  the tool requires a new upstream request; June never silently approves stale
  work.
- Non-MCP command/code approvals keep working with derived stable identities;
  clarify, sudo, and secret protocols keep their existing identities and
  response methods. Legacy external callers that omit `request_id` retain FIFO
  behavior inside Hermes, but June always sends a targeted id.
- Every Hermes pin bump must re-evaluate whether upstream now provides the same
  stable identity and targeted response contract. The local patch must be
  removed, rebased with new sealed hashes, or replaced by a verified upstream
  implementation before release.
- This is desktop runtime behavior only. No June API deployment is required.

## Alternatives considered

- **Deduplicate only in React.** Rejected because hidden upstream queue entries
  would remain unresolved and a visible card could answer the wrong FIFO entry.
- **Resolve every queued approval together.** Rejected because distinct
  legitimate requests can coexist and must receive independent decisions.
- **Keep FIFO resolution and add only a display id.** Rejected because the id
  would not control which blocked request resumes.
- **Upgrade Hermes immediately.** Rejected because a pin bump is broader than
  this fix and no verified upstream release was shown to provide the required
  protocol. The sealed patch keeps the current audited pin and is removed when
  an upstream implementation passes the full upgrade checklist.
