---
status: accepted
date: 2026-07-24
---

# Keep routines and MCP in the June-owned agent runtime

## Context

ADR-0038 deliberately removed routines and custom MCP servers from the first
Hermes replacement cutover. Existing June users already rely on both. Removing
them would lose scheduled work, connected tools, and the controls users set for
those tools. It would also make imported conversations behave differently from
new conversations.

Restoring the old Hermes gateway, Python MCP bridges, or a dual-runtime flag
would recreate the ownership, packaging, and lifecycle costs the replacement is
meant to remove.

## Decision

June owns both capabilities in the replacement runtime.

- Routines are stored in June's SQLite database with durable schedules,
  single-flight run claims, session and run links, enabled state, finite-repeat
  progress, model and safety policy, and last and next run state.
- The scheduler invokes the same Agents SDK runtime and metered June model
  route as an attended session. Approval-required tools pause through the same
  persisted interruption protocol.
- Custom MCP definitions and nonsecret policy are stored in SQLite. Environment
  values and HTTP headers are stored only in the operating system keychain.
- Rust discovers and invokes MCP tools directly over stdio or Streamable HTTP.
  The TypeScript runtime receives only typed tool descriptors and opaque
  results. It never receives connector tokens or MCP credentials.
- Sandboxed local MCP processes use the macOS Seatbelt workspace policy.
  Sandboxed local MCP processes are unavailable on Windows until June has a
  kernel isolation boundary. Remote MCP credentials require HTTPS, except for
  loopback HTTP.
- Unknown custom MCP tools require approval by default. Per-server allowlists,
  blocklists, per-tool approvals, output bounds, timeouts, and safety-mode
  availability remain host-owned policy.
- Gmail, Calendar, GitHub, Linear, and Notion remain native connectors. Their
  credentials stay in the existing keychain stores, their scopes and selected
  teams are revalidated for every call, and mutations use the SDK approval
  interruption exactly once.
- A versioned one-time migration imports routines and custom MCP definitions
  from the retained Hermes home. It is idempotent and transactional, filters
  June-managed Python bridges, moves custom MCP secrets into keychain, and
  leaves the legacy home untouched as recovery data.
- Imported script, no-agent, or machine-tool routines are disabled and marked
  for review instead of silently running with changed semantics. Path-backed
  scripts are copied into June-owned recovery storage. June never executes
  them outside the current safety-controlled tool path.

This decision supersedes the routines and MCP removal described in ADR-0038.
The rest of ADR-0038 remains in force.

## Consequences

- The replacement can ship without Hermes or bundled Python while preserving
  the core scheduled and connected-tool experience.
- MCP and routine state survive app restarts and ordinary runtime crashes.
- A broken custom MCP server does not remove healthy servers or first-party
  tools from a run.
- Existing scripts that cannot be represented safely require explicit user
  review. This is safer than executing them with broader access or pretending
  that only their prompt was preserved.
- June now owns the routine scheduler, MCP protocol compatibility, migration,
  and their release tests.
