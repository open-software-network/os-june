# ADR 0026: June-owned project memory store

Date: 2026-07-14
Status: accepted

## Context

JUN-256 requires per-project instructions, project-scoped agent memory, an
inspectable "what June remembers" screen, and delete/disable controls where
deletion is permanent and verifiable.

The embedded Hermes runtime ships its own `memory` toolset backed by a flat
`<hermes_home>/memories/` directory. That store is global per runtime: it
cannot be scoped to a June project (a folder), June cannot verify deletion
(the runtime owns the files and its curation behavior), and June-side
inspect/edit UI would race the runtime's own writes. June's projects are
folders in June's SQLite database — an entity the runtime knows nothing
about.

Sessions in June share one Hermes home and one SOUL.md, so per-project
instructions cannot ride the global SOUL splice either; and the sandboxed
runtime mode's Seatbelt write-jail only permits writes under the Hermes home,
so an MCP server cannot write June's database directly from a sandboxed
session.

## Decision

Memory is a June-owned store in June's SQLite database (`memories` table),
scoped by an optional `folder_id` (NULL = global), with a
`memory_tombstones` table written transactionally on every hard delete —
future-proofing so any later multi-device sync could propagate deletions
(no sync feature exists; nothing reads tombstones today).

The agent reads and writes it through the `june_context` MCP server:

- Reads (`list_memories`) query the database directly, like every other
  june_context tool, applying the disable rules.
- Writes (`save_memory`, `forget_memory`) call the loopback provider proxy
  with a dedicated bearer token (the ADR-0013 recorder pattern); the Rust
  handlers enforce the disable rules, validation, and tombstoning with the
  same code as the Tauri commands. This keeps writes working inside the
  sandbox without weakening the Seatbelt profile and keeps enforcement in one
  place.

Project scope is threaded by injection, not inference: when a session filed
in a project submits a prompt, June prepends a delimited project-context
block (project id, name, instructions) the first time and again whenever the
filing or instructions change. The agent passes that project id to the memory
tools. A SOUL stanza (present only while memory is globally enabled)
instructs June to save durable facts and honor "forget" requests.

Disable controls fail closed: a corrupt global settings file reads as
disabled, and disablement is enforced at the write boundary (Tauri commands
and proxy handlers), not in UI affordances. Deleting a project hard-deletes
and tombstones its memories in the same transaction.

The runtime's native `memory` toolset is left in place but unadvertised while
memory is enabled; the SOUL stanza directs June to the june_context tools.
When memory is globally disabled, June drops the native `memory` toolset from
every toolset list it composes: the cron routine allowlist
(`platform_toolsets.cron`, re-rendered and the routine gateway restarted on
the toggle) and the explicit per-job `enabled_toolsets` June writes when a
routine is created or its trust/unrestricted mode is edited. So a routine
cannot be *granted* the native store behind the off switch. Two residuals are
honest-runtime, not adversarial (see the closing consequence): a routine
whose explicit `enabled_toolsets` were stored *before* the toggle keeps them
until re-saved, and an interactive session relies on the omitted SOUL stanza.
Fully retroactive enforcement (rewriting every stored routine's toolsets, or a
Hermes-level global toolset denylist) is a tracked follow-up.

## Alternatives

- Ride the Hermes native memory toolset and partition `memories/` per
  project. Rejected: the toolset cannot be steered per session, deletion is
  not verifiable, and June-side editing would race the runtime.
- Per-project Hermes profiles (one isolated runtime per project). Rejected:
  the profile-isolation direction was built and deliberately reverted
  (PR #673); it multiplies runtime state and spawn cost for a scoping
  problem a scoped store solves.
- Direct SQLite writes from the MCP script. Rejected: denied by the sandbox
  write-jail in the default runtime mode, and it would duplicate write-side
  enforcement in Python against the database the jail exists to protect.

## Consequences

- "What June remembers" is a plain database view; delete is a hard DELETE the
  UI can verify, and every delete leaves a tombstone (unread today; kept so a
  later multi-device sync could honor deletions).
- Memory entries and project instructions are inert data at rest; they enter
  model context only via the injected block and tool results.
- The project-context block spends prompt tokens on the first submit of each
  project session and after instruction edits.
- An unrestricted-mode agent can technically still read the database file
  directly; disable rules are honest-runtime guarantees, not adversarial
  ones — consistent with june_context's existing read access.
- The memory proxy token is delivered through the rendered Hermes config's
  MCP env map, the same channel as the recorder and connector tokens. Within
  the local trust domain the tokens separate route classes, not adversarial
  processes; changing that delivery model is a cross-cutting decision for all
  proxy tokens, out of this ADR's scope.
