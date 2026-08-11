# Agent context search host-tool contract

This document owns the in-loop host-tool contract for searching the user's
Clovy notes, transcripts, and dictations. It applies to attended agent sessions
and unattended routines.

## Current catalog contract

| Tool | Input | Result | Availability |
| --- | --- | --- | --- |
| `search_clovy` | `query` (required string) | Bounded matches from the active data partition's notes, transcripts, and dictation history | Attended sessions and routines with `context_engine`, `memory`, or `session_search` enabled |

The current attended and routine catalogs expose only `search_clovy`. New
prompts, runs, policies, and documentation must not emit the former tool name.
Search remains scoped to the current data partition and returns the existing bounded,
sanitized result shape.

## Legacy dispatch compatibility

`search_june` is a read-only input alias for tool calls already persisted by a
released session or routine. The Rust dispatcher and routine-policy gate accept
that exact alias so replay and resume do not fail, but no current catalog
advertises it and no new run writes it. This alias is a persisted-input bridge
under ADR-0055, not a current product or tool identity.
