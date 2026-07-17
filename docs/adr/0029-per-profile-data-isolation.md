# ADR 0029: Profiles isolate user data; profile is the first data-partition key

Date: 2026-07-09
Status: accepted

## Context

ADR 0028 made a profile switch retarget the *agent runtime* (which Hermes
profile new sessions run under, plus per-profile voice/image model overrides).
But every piece of *user data* June stores still lives in one app-global
SQLite database (`<app_data>/notes.sqlite3`) with **no partition key at all**:
meeting notes, dictation history, projects/folders, and the local
agent-task mirror are shared across every profile. Switching profiles changes
who the agent is, not what data you see. Users expect profiles to behave like
**browser profiles** — switching to a profile shows only that profile's
notes, chats, dictation, and projects.

Two ownership regimes complicate this:

1. **June-DB-owned data** — notes, dictation, folders/projects, the
   `agent_tasks` mirror. June owns the rows, so scoping is an additive column.
2. **Hermes-owned chat sessions** — the real conversation lives in Hermes's
   own store inside the Hermes home; June only talks to it over REST and has
   no column to add. June already stamps `profile` on `session.create`
   (ADR 0028) but has never had a profile-aware *read*: the chat list calls
   `GET /api/sessions`, which carries no profile field, and the profile-aware
   `GET /api/profiles/sessions` returns only live/recent sessions, not the
   full paginated history the list needs.

There is no existing account/workspace partition to compose with: OS Accounts
is identity/OAuth only and partitions no stored data. So `profile` becomes the
first data-partition dimension June has ever had.

## Decision

Introduce `profile` as the data-partition key, defaulting to `"default"` so
all existing data belongs to the default profile with zero backfill.

**June-DB-owned data (migration 018).** Add `profile TEXT NOT NULL DEFAULT
'default'` to `notes`, `dictation_history`, and `folders` (satellite tables
inherit scope through their `ON DELETE CASCADE` FK to `notes`). Every write
stamps the active profile; every list read filters `WHERE profile = ?`. The
active profile is resolved Rust-side from the sticky `active_profile` file via
the existing `active_profile_for_hermes_home` accessor and threaded through the
repository layer (which today takes no profile argument). Projects/folders are
scoped too — profiles fully partition organization, not just content.

**Hermes-owned chat sessions.** Add a June-side map
`session_profiles(session_id TEXT PRIMARY KEY, profile TEXT NOT NULL,
assigned_at ...)`, mirroring the existing `session_folders` side table (which
is likewise keyed directly on the Hermes session id, with no local sessions
table to reference). June stamps it at session-create time — but only when the
active profile is **confirmed** (not during the `active-hermes-profile`
unconfirmed window) and the provisional `pending:new-session:` id has
reconciled to the real stored session id. The chat list LEFT JOINs against the
map and filters by the active profile; a session with no mapping row resolves
to `default`.

**Profile deletion prompts the user.** Deleting a profile that owns data opens
a dialog reporting the counts (notes · chats · dictation · projects) and
offering: **Move to default** (re-tag its rows `profile = 'default'`) or
**Delete permanently** (remove them, behind a hard confirm), or Cancel. There
is no silent fixed policy; the user chooses per deletion. (June still refuses
to delete the *active* profile without switching first — ADR 0028.)

## Consequences

- **First partition dimension.** Nothing else partitions data, so there are no
  composite-key concerns today; a future per-account dimension would compose
  on top (`(account, profile)`), not replace this.
- **Backfill is free.** `DEFAULT 'default'` covers every existing row;
  unmapped pre-existing chat sessions surface under `default`, which is correct
  since they predate profiles.
- **The session map is June's, not Hermes's, source of truth**, so sessions
  Hermes creates outside June's `session.create` path (cron/scheduled runs,
  delegated sub-agent sessions) get no mapping row and fall to `default`.
  Those are already filtered out of the main chat list, so the gap is
  contained; scoping scheduled-run history per profile is deferred.
- **Confirmation-window discipline.** Stamping `session_profiles` only when the
  active profile is confirmed avoids mislabeling data written during a
  transient active-profile read failure (which keeps the last-known name).
- **Reversibility cost.** Once data is partitioned, un-partitioning means
  merging profiles by hand, and the delete dialog's "Delete permanently" branch
  is the one genuinely destructive, irreversible surface — hence the hard
  confirm and the counts shown before the choice.

## Rejected alternatives

- **A separate SQLite file per profile.** Cleanest isolation on paper, but it
  multiplies migration/backup/versioning surface, breaks any cross-profile or
  global view, and forces a data move on every profile switch. An additive
  column is reversible and keeps one schema.
- **Reuse `GET /api/profiles/sessions` for the chat list.** It only returns
  live/recent sessions, not the full history the list paginates, so it cannot
  back the history view. The June-side map is self-contained and matches the
  `session_folders` precedent.
- **A Hermes `/api/sessions?profile=` server-side filter.** Would catch all
  creation paths for free, but the pinned build's `/api/sessions` contract does
  not document a profile filter, and depending on an unverified contract is
  fragile. Revisit if a future pin confirms it.
- **Gateway-per-profile.** Already rejected in ADR 0028 for memory/spawn cost
  and the one-gateway-per-mode sandbox invariant.
