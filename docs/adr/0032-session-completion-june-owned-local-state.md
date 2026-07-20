# ADR 0032: Session completion is June-owned local state

Date: 2026-07-15
Status: accepted

## Context

Agent sessions live in the embedded, pinned Hermes runtime, not in June. June
talks to Hermes over its REST surface (`/api/sessions`): it can list sessions
(with an `archived` read-filter), PATCH a session's title, and DELETE a session.
Hermes owns an `archived` flag, but June has no write path that sets it — June
only reads it to keep archived sessions out of the sidebar. Hermes exposes no
"completed" concept, and its session model is an implementation detail June must
not fork or extend (the runtime is pinned by source tarball + checksum).

JUN-203 asks for the ability to mark a session "complete" — similar to
archiving, but with the completion state preserved so users can track finished
work over time, and kept distinguishable from archived sessions.

Three options existed:

1. Push a status into Hermes (e.g. via the session PATCH). Rejected: Hermes has
   no such field, June cannot change the pinned runtime, and it would couple a
   product feature to an implementation detail we deliberately hide.
2. Store completion in the frontend (localStorage), like the per-session sandbox
   mode and model-override preferences. Workable, but completion is durable,
   UI-facing state the product wants to track "over time"; localStorage is
   cleared with app data and carries no server-side timestamp.
3. Store completion in June's own SQLite DB, keyed by the stored Hermes session
   id — exactly how `session_folders` already records which project a session
   belongs to (also keyed on the Hermes session id, with no local sessions
   table to reference).

## Decision

Session completion is **June-owned local state**, persisted in June's SQLite DB
in a `completed_sessions(session_id PRIMARY KEY, completed_at)` table, keyed by
the **stored** Hermes session id. It is set and cleared only by June, entirely
independent of Hermes' `archived` flag. A Tauri command pair
(`list_completed_sessions`, `set_session_completed`) exposes it; the frontend
files completed sessions under a dedicated, collapsible "Completed" section
instead of the active list.

This mirrors the `session_folders` stack (migration → repository →
command → `tauri.ts` binding → sidebar wiring) rather than inventing a new
persistence pattern.

## Consequences

- Completion survives app restarts and localStorage clears, and carries a
  timestamp, so "track completed work over time" is well-founded.
- Completion and Hermes' archive are orthogonal: a session can be archived by
  Hermes and/or completed by June without either overwriting the other. The
  sidebar treats completed sessions as a distinct group from the (Hermes-driven)
  archive filter.
- No June API / backend change and no Hermes change: this is desktop-local only,
  so no backend deploy is required and the pinned-runtime boundary is respected.
- If Hermes ever gains a first-class completion concept, this table becomes the
  migration source; superseding this ADR (not rewriting it) is the path.
