---
status: accepted
date: 2026-07-28
---

# Use Linear's official hosted MCP as the agent capability source

## Context

June originally implemented a native Linear agent surface with fixed GraphQL
operations and a June-enforced selected-team grant. Linear now operates an
official Streamable HTTP MCP server at `https://mcp.linear.app/mcp` and supports
existing Linear OAuth access tokens as bearer credentials.

Keeping the native tools alongside the hosted server would give June two
different Linear capability catalogs, approval paths, and drift surfaces.
Creating a second OAuth connection for MCP would also duplicate token custody
and make Settings connection state ambiguous.

The hosted server publishes tool annotations, but that metadata is controlled
by the upstream server and may be missing, contradictory, or change between
runs. June still owns the approval boundary.

## Decision

- Linear's official hosted MCP inventory replaces June's native Linear agent
  tools. The native GraphQL OAuth, refresh, identity, revoke, and account
  persistence code remains as the connection layer, but native Linear tools are
  never advertised or dispatched.
- `connector_accounts` and the existing Linear Keychain entry are the only
  connection authority. June synthesizes an internal `builtin:linear` MCP
  definition for a healthy connected account. It does not create a
  user-editable `agent_mcp_servers` row or a second OAuth grant.
- Rust obtains a current connector access token immediately before MCP
  discovery or dispatch and attaches it only to the fixed HTTPS origin. The
  token is never written to SQLite or exposed to the TypeScript runtime.
- June exposes every valid tool returned by the hosted server instead of
  maintaining a Linear-specific allowlist or translating arguments and
  results.
- A tool may run without approval only when its annotations explicitly set
  `readOnlyHint` to true and do not set `destructiveHint` to true. Missing,
  false, or conflicting hints require approval.
- Discovery may refresh once after an HTTP 401 because no tool side effect has
  started. June never automatically retries `tools/call` after a 401, timeout,
  transport failure, protocol failure, or incomplete response.
- Connect, reconnect, and disconnect remain June-owned Settings actions. They
  request workspace-wide read and write scopes, show no selected-team picker,
  do not call the retired connector runtime-apply command, and invalidate any
  in-memory Linear MCP session when credentials change.
- Migrations 46 and 47 retain the prerelease
  `linear_mcp_connection` table only as compatibility data. Runtime
  connectivity never reads it. The migration runner shifts the exact
  prerelease version 45 and 46 identities around the released calendar
  migration without accepting near-matches.

This decision is a targeted exception to ADR-0039's statement that Linear
remains a native connector. ADR-0039's host-owned MCP transport, credential
isolation, persistent-session, and no-mutation-retry decisions remain in force.
This ADR also supersedes the agent-tool and selected-team design in the
original Linear implementation plan.

## Consequences

- Linear controls its tool names, schemas, descriptions, and inventory. A new
  valid hosted tool becomes available on a later agent run without a June
  release.
- The Linear OAuth grant is workspace-wide. Settings must not imply that June
  enforces selected-team access.
- A hosted-server discovery failure removes Linear tools from that run while
  leaving other tools and MCP servers available.
- Disconnect removes local token custody and the account index, retires the
  hosted MCP session, and makes all Linear tools unavailable. Provider revoke
  remains best-effort.
- Upstream annotation mistakes cannot silently broaden mutation authority:
  ambiguous metadata fails closed to approval.
- The dormant native GraphQL operation code may be removed separately after
  the hosted integration has stable release evidence.

