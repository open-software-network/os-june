---
status: accepted
date: 2026-07-27
---

# June-owned plugin capabilities are host tools, not MCP servers

## Context

The plugin implementation plans (documents, spreadsheets, browser use,
computer use, Notion, Microsoft 365, private connectors) were written against
the embedded Hermes runtime and describe each capability as a June-managed
`june_*` MCP server, following the pattern of the Hermes-era Python bridges.

ADR-0038 replaced that runtime with a June-owned harness, and the migration
deliberately filters June-managed Python bridges instead of importing them
(`src-tauri/src/agent_runtime/migration.rs`). Their functionality already runs
as native host tools dispatched directly in the trusted Rust host
(`src-tauri/src/agent_runtime/tools.rs`): context search, web search and
fetch, memory, files, shell, skills, routines, Notion actions, computer use.
The MCP machinery kept by ADR-0039 exists for user-supplied external servers,
which reach the loop through the `mcp_` dispatch prefix and host-owned policy.

The open question was whether future June-owned plugin capabilities should
return to the MCP-server shape their plans describe.

## Decision

June-owned plugin capabilities are implemented as host tools inside the agent
loop, never as June-managed MCP servers.

- A new capability adds tools to the host dispatch table in
  `agent_runtime/tools.rs`, named per `spec/mcp-tool-naming.md` (`verb_object`,
  named by the owning PRD before code is written).
- Safety machinery attaches where it already lives: approvals, safety-mode
  gating, output bounds, and the Seatbelt write-jail are host-tool properties;
  no policy bridging through the MCP layer.
- Engines that parse untrusted input (document and spreadsheet engines) do not
  run in the main process. They follow the ADR-0028 pattern: a host-tool
  front-end in the loop and a sandboxed, brokered child process for the risky
  engine. The process boundary, not MCP, is the isolation mechanism.
- The ADR-0039 MCP path remains reserved for genuinely external servers the
  user connects. June ships no MCP server of its own.

The plugin implementation plans remain valid for scope and product behavior
but their `june_*` MCP-server integration shape is superseded by this
decision.

## Consequences

- No subprocess lifecycle, packaging, signing, protocol versioning, or
  health-checking for capabilities June owns end to end; that overhead was the
  motivation for removing the embedded runtime and would return with each
  June-managed MCP server.
- Host tools are testable in the existing Rust test suites and get the safety
  policy for free.
- June-only reach: an in-loop tool cannot be reused by third-party MCP
  clients. Accepted; no such reuse is planned, and a standard surface could be
  added later without changing the internal shape.
- Risky-parser isolation costs a brokered helper per engine (as computer use
  already pays), rather than being a side effect of an MCP process boundary.

## Alternatives considered

- June-managed MCP servers per the original plans. Rejected: reintroduces the
  ownership and packaging costs ADR-0038 removed, for no interoperability
  gain when both ends are June.
- In-process engines without a broker. Rejected for untrusted-input parsers;
  loses the isolation the original plans placed behind the artifact broker.
