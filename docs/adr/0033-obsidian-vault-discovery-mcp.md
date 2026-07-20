---
status: accepted
date: 2026-07-21
---

# ADR 0033: Obsidian vault discovery uses a June-owned MCP server

## Context

The unreleased Obsidian plugin initially projected the selected vault from
June-owned `obsidian.json` into Hermes's `.env` and process environment as
`OBSIDIAN_VAULT_PATH`. The pinned upstream Obsidian skill read that ambient
variable and otherwise guessed a default location.

That contract made a privacy-sensitive path ambient process state, required
editing another runtime-owned file, and meant connect, change, and disconnect
needed a Hermes restart. It also distributed vault configuration interpretation
across June, Hermes, and a skill.

## Decision

June permanently registers an interactive built-in MCP server named
`june_obsidian`. Its initial `get_obsidian_vault` tool calls a token-protected
loopback route. Rust reads and validates `obsidian.json` at request time, so it
remains the sole source of truth.

The response is explicit:

- disconnected: `connected: false`, `available: false`, `vault: null`;
- connected and available: the canonical vault name and absolute path;
- connected but unavailable: `connected: true`, `available: false`, and only
  the vault name.

The MCP adapter neither parses `obsidian.json` nor validates vault paths. It
receives a dedicated `JUNE_OBSIDIAN_PROXY_TOKEN`, separate from provider,
memory, recorder, connector, and computer-use credentials.

The server remains registered while disconnected, and it is included in
interactive toolsets. It is intentionally excluded from ambient routine and
cron toolsets. June ships a distinct `june-obsidian` skill which directs the
runtime to query discovery before each Obsidian task, handle disconnected and
unavailable responses, use generic filesystem tools within the returned vault,
and not infer write permission from a disclosed path. June disables the pinned
upstream `obsidian` skill by its stable skill identity so its environment
variable and guessed-path instructions cannot remain active.

June removes the environment projection, lock file, dotenv quoting, TUI export,
process environment injection, and runtime-apply command. Settings now only
validate and persist or delete the selected vault, then refresh UI state.

## Consequences

- A live Hermes process observes a connect, vault change, or disconnect on its
  next tool call without a restart.
- The macOS Seatbelt behavior is unchanged: sandboxed Hermes may read the vault
  but receives no vault write-root grant; unrestricted sessions remain subject
  to host permissions. This is not an equivalent read-only guarantee on
  platforms without that sandbox.
- Disconnect removes future discovery. It cannot remove an absolute path
  already returned to model context or revoke generic filesystem access from an
  unrestricted process. It is not immediate access revocation.
- Absolute paths remain a transitional, intentional tool-result disclosure.
  They must not appear in tool descriptions, logs, telemetry, or unavailable
  and disconnected responses.
- Future work may replace generic filesystem access with June-brokered,
  vault-relative read and separately authorized write tools. That work is out
  of scope here.

## Alternatives considered

- **Keep `OBSIDIAN_VAULT_PATH` for compatibility.** Rejected: the integration
  has not shipped, and two contracts would create a conflicting skill path.
- **Let the MCP script read `obsidian.json`.** Rejected: it duplicates Rust
  validation and leaks configuration ownership across the sandbox boundary.
- **Register the server only while connected.** Rejected: stable registration
  lets a running runtime discover current state without a restart.
