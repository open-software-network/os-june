# Agent context search host-tool contract

This document owns the in-loop host-tool contract for searching the user's
Clovy notes, transcripts, and dictations. It applies to attended agent sessions
and unattended routines.

## Current catalog contract

| Tool | Input | Result | Availability |
| --- | --- | --- | --- |
| `search_june` | `query` (required string) | Bounded matches from the current data partition's notes, transcripts, and dictation history | Attended sessions and routines with `context_engine`, `memory`, or `session_search` enabled |

The current attended and routine catalogs retain `search_june` as a legacy
execution identifier because tool catalogs are persisted in resumable runs. A
rollback build recognizes only that identifier, so renaming it would strand a
run created by Clovy and then resumed after downgrade. The descriptor and all
user-facing copy call the product Clovy. Search remains scoped to the current
data partition and returns the existing bounded, sanitized result shape. The
presentation boundary renders this identifier as **Search Clovy notes** in the
activity transcript and usage panel.

## Legacy dispatch compatibility

`search_june` remains the rollback-readable execution name during the bridge
window. It is a persisted input and rollback output under ADR-0055, not a
current product or assistant identity. A future rename requires an
upgrade-run-downgrade-resume migration that keeps old binaries able to execute
newly persisted run catalogs.
