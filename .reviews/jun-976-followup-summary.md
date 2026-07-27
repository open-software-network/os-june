# JUN-976 followup summary

## Finding 1

Corrected the P3A implementation plan so `agent.sessions` is recorded only
after successful `create_agent_session` completion. The plan now explicitly
excludes `start_agent_run`, which runs for every user turn.

## Finding 2

Added a dated append-only addendum to ADR-0040 that supersedes the
June-managed MCP-server integration portions of ADR-0017, ADR-0028, and
ADR-0034 while preserving their product scope. ADR-0028's brokered-helper
isolation pattern also remains binding. Added matching dated notes to the end
of each earlier ADR and annotated their entries in `docs/index.md`.

The ADR-0040 addendum cites the current Rust host-tool dispatch for
`computer_use` and `get_obsidian_vault` as the implemented shape.

## Finding 3

Added the standard stale-integration banner to all 14 named implementation
plans: Asana, Azure Boards, Box, Canva, ClickUp, Dropbox, GitHub, GitLab,
Google Workspace, HubSpot, Linear, Pipedrive, Salesforce, and Slack.

No plans were skipped. Each plan still prescribes a `june_*` server or
otherwise explicitly describes the retired MCP-server shape.

## Validation

`pnpm check` exited 0. Biome reported existing warnings but no errors.
