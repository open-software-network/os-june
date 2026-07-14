# Implementation plan: Browser use plugin

- **Mode:** CTO
- **Date:** 2026-07-13
- **Status:** Accepted workstream; implementation active
- **PRD:** [browser-use-prd.md](browser-use-prd.md)
- **Decision:** [ADR-0017](../adr/0017-browser-use-via-june-extension.md)

## Technical objective

Expose one app-owned `june_browser` MCP contract through a Rust policy broker
with two transports: the user's explicitly bounded browser for attended tasks,
and a fresh public-web-only profile for sandboxed routines.

This plan is a portfolio summary. The detailed tool, transport, policy,
distribution, and test decisions remain canonical in
[browser-computer-use-prd.md](../browser-computer-use-prd.md) and the JUN-286
through JUN-299 implementation Issues.

## Architecture

```text
Hermes -> june_browser MCP -> authenticated loopback -> Rust browser broker
                                                    |-> native shim -> MV3 extension -> task tabs
                                                    `-> headless system Chromium -> ephemeral profile
```

The broker owns the stored grant, session leases, URL policy, task-tab scope,
reference expiry, consequential-action classification, approval journal,
artifact references, and teardown. The extension and headless driver execute
commands but do not decide policy.

## MCP contract

- Session: `start_session`, `close_session`.
- Navigation: `navigate`, `back`.
- Perception: `snapshot`, `screenshot`.
- Interaction: `click`, `fill`, `press`.
- Tabs: `list_tabs`, `open_tab`, `switch_tab`, `close_tab`,
  `accept_shared_tab`.

Interactive references expire after navigation or relevant page mutation. A
fresh snapshot follows every action. Large screenshots and snapshots return
workspace file references rather than native-messaging payloads.

## Attended transport

- TypeScript MV3 extension with a pinned id and protocol version.
- Per-tab debugger control only for June-created task tabs and explicitly
  shared tabs.
- Signed native-messaging shim inside the app bundle; authenticated local
  socket to the broker.
- Browser-owned debugging banner plus June tab grouping as visible indicators.
- Extension detaches and clears state on broker/native-host loss.

## Routine transport

- Detect Chrome, Edge, Brave, then Chromium.
- Launch headless with a fresh temp profile per run.
- Resolve, validate, and pin public destinations; reject private, loopback,
  link-local, non-HTTP, and rebinding targets, including after redirects.
- Hard-block consequential actions because no user is present to approve.
- Require an explicit per-routine opt-in.

## Action safety

- Park consequential actions before execution with a stable action id.
- Allow "approve all on this site for this task" only for an exact normalized
  origin and only in broker memory.
- Never automate password, one-time code, or payment fields.
- Retried turns resume a parked action and do not replay completed work.
- Revoke in order: refuse commands, detach tabs, invalidate credentials and
  approvals, stop sessions, delete ephemeral profiles.

## Delivery map

| Slice | Issue | Exit |
| --- | --- | --- |
| Grant and MCP skeleton | JUN-286 | Disabled/enabled contract and broker lease |
| Extension pairing | JUN-287 | Versioned native-messaging round trip |
| Managed read browser | JUN-289 | Navigate, snapshot, screenshot under URL policy |
| In-chat request | JUN-290 | Grant request card and safe turn retry |
| Attended read browser | JUN-291 | Task tabs only |
| Distribution | JUN-292 | Store listing and reproducible zip |
| Managed interactions | JUN-294 | Reference actions and redirect policy |
| Shared tab | JUN-295 | Explicit handoff and revoke |
| Attended approvals | JUN-297 | Parked consequential actions |
| Routine opt-in | JUN-298 | Anonymous per-routine lease |
| Plugin tile | JUN-299 | Guided connect and disconnect |

## Verification

- Rust policy tests for grants, exact-origin allows, action classes,
  idempotency, URL resolution, redirects, and revoke ordering.
- Cross-language protocol fixtures for framing, version mismatch, reconnect,
  and file-reference payloads.
- Extension integration tests against hostile fixture pages and navigation
  races.
- MCP schema fixtures plus pinned-runtime live smoke.
- Live macOS walkthrough: install, pair, create task tab, share one tab, approve
  an action, deny an action, human takeover, stop, disconnect, and crash the
  broker while attached.
- Security test that unrelated tabs, local network targets, and sensitive
  fields stay unreachable.

## Rollout

Dogfood with unpacked builds, then rc through the Chrome Web Store, then stable
after store/update compatibility and two weeks of action approval telemetry.
Keep one remote kill switch for the attended transport and one for the managed
transport. Do not log URLs, page text, screenshots, or field values.

## Open gate

Public release depends on publisher verification and store approval. The
implementation direction itself requires no new ADR unless the work departs
from ADR-0017.
