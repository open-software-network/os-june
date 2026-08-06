# PRD: Linear plugin

- **Mode:** CEO
- **Rank:** 8 of 10
- **Score:** 69/100
- **Date:** 2026-07-28
- **Status:** Accepted for the official hosted MCP integration

## Thesis

Linear is the cleanest bridge from meeting decisions to product execution.
Clovy should prepare reviews from projects and issues, then draft the concrete
issues, updates, and comments a team needs after the meeting.

It ranks below GitHub because the audience is narrower and much of the value
composes with GitHub, but it has a well-defined GraphQL/OAuth surface and a
high-value action loop.

## Customer and problem

Product and engineering teams discuss work in meetings, then manually recreate
decisions in Linear. Issues lack the rationale in the note; notes lack the live
delivery state in Linear. Status reporting becomes repeated synthesis.

## Product promise

Connect a Linear workspace and let Clovy use Linear's official hosted MCP tools
to turn meeting outcomes into reviewed work. The workspace and exact proposed
change remain visible before an approval-required tool runs.

## V1 experience

- Connect one workspace with workspace-wide read and write access.
- Discover the complete valid tool inventory from Linear's official hosted MCP
  server for each agent run.
- Run tools directly when `readOnlyHint` is explicitly true and
  `destructiveHint` is false or absent.
- Require approval for write, destructive, ambiguous, malformed, or missing
  `readOnlyHint` annotations.
- Link Clovy notes to Linear objects and refresh status on demand.

## Scope

### V1

- Expose every valid tool published by Linear's official hosted MCP server.
- Keep OAuth connect, refresh-token rotation, reconnect, revoke, and disconnect
  in Clovy.
- Keep MCP transport, credential isolation, timeouts, output bounds, and
  approval enforcement in Clovy.
- Planning brief, standup, issue drafting, and weekly project-status skills.

### Later

- Customers, customer requests, releases, SLA, documents, agent sessions,
  webhook routines, and autonomous triage.

## Non-goals

- Replacing Linear's planning UI.
- Bulk reprioritization, deletion, archive, workspace administration, or team
  configuration.
- Full workspace indexing.
- Autonomous issue mutation at launch.

## Privacy and trust

Use Linear OAuth with refresh-token rotation and store token material in the
Keychain. Rust sends the current access token only to
`https://mcp.linear.app/mcp`; the model and TypeScript runtime never receive
it. Access is workspace-wide, not selected-team scoped. Linear content and MCP
metadata are untrusted. Only tools with an explicit `readOnlyHint: true` and a
false or absent `destructiveHint` may run directly; everything ambiguous or
mutating requires approval.

## Business model

Local reads and approved writes are Hobby. Recurring status routines and
cross-plugin GitHub/Slack workflows are Pro.

## Success measures

| Metric | Target |
| --- | ---: |
| Successful workspace connections | 90% |
| Weekly connected users running a planning/status brief | 35% |
| Draft issues approved | 60% |
| Created issues needing team/project correction | under 2% |
| Unapproved ambiguous or mutating calls | 0 successful |

## Risks and gates

- OAuth flow and refresh-token rotation changed in 2026; implementation must
  follow current provider behavior.
- Webhooks require public HTTPS and therefore away mode.
- Hosted tool inventory and annotations can change; discovery and approval
  handling must fail safely.
- Model-generated priority/assignee choices can look authoritative when they
  are suggestions.

## Decision requested

Approve workspace-wide hosted MCP access with Clovy-owned connection lifecycle
and conservative approval policy; pair the product launch with GitHub
composition but do not block either plugin on the other.

## Sources

- [Linear OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)
- [Linear MCP server](https://linear.app/docs/mcp)
- [Linear webhooks](https://linear.app/developers/webhooks)
- [Linear developer platform](https://linear.app/developers)
