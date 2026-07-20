# ADR 0027: June-owned project memory store

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

## Addendum: 2026-07-17 - global native-memory denial

JUN-337 closes the three honest-runtime residuals left by the original
decision. When Memory is off, June writes `memory` into Hermes'
`agent.disabled_toolsets`; when Memory is on, June removes only that entry and
preserves every other disabled toolset. The pinned scheduler layers the global
disabled list over every cron job's stored `enabled_toolsets`, and the model
tool resolver subtracts disabled toolsets after resolving enabled toolsets.
The deny therefore wins over a pre-existing routine override without rewriting
each stored job.

The pinned desktop/TUI gateway loaded `agent` config but did not pass
`disabled_toolsets` into its main or background `AIAgent` construction. June's
sealed compatibility patch now passes it through both paths (preview agents
inherit the background arguments), so interactive and background desktop
sessions enforce the same global deny as cron and the classic CLI.
The patch also resolves that deny inside the central `AIAgent` constructor and
turns on its existing `skip_memory` lifecycle gate. Memory off therefore blocks
native `MEMORY.md` and `USER.md` prompt injection as well as external provider
initialization, prefetch, and turn sync for every current and future agent
construction path, not only calls to the native memory tools.

Finally, the Memory toggle mutates the shared Hermes `config.yaml` directly and
atomically before attempting live-runtime restart. Cron reloads that file for
each run, so the policy takes effect even when no bridge connection exists and
only the launchd routine gateway remains. Missing config is created with the
deny; corrupt config is preserved beside the replacement for diagnosis and is
replaced with a valid fail-closed policy. Normal spawn-time config rendering
reapplies the persisted setting, so later spawns self-heal the policy.

`config.yaml` remains jointly owned with the pinned Hermes runtime. June and
Hermes therefore coordinate every atomic YAML replacement with the same
cross-process advisory lock. Hermes' central writer re-reads the current file
under that lock and makes the current `memory` deny membership win over a stale
in-memory snapshot before saving, while retaining the writer's unrelated
changes. This closes the last-writer-wins window without moving ownership of
the rest of the config into June. The pinned Telegram gateway's separate
DM-topic persistence path is routed through the same central writer so it
cannot bypass the protocol during gateway startup.

Atomic replacement follows an existing `config.yaml` symlink to its canonical
target. Both the Rust and patched Python writers preserve the target's
permissions, including macOS ACLs and Windows security metadata. Newly created
configs and corrupt backups are owner-only on Unix because they can contain
provider, on-device provider proxy, and connector credentials. On macOS, the
Seatbelt profile grants a symlink's resolved target and atomic-temp prefix
without widening the target directory.

The earlier cron default allowlist filter, routine composition filter,
June-owned memory-store write gate, and SOUL guidance remain in place as
defense in depth. This addendum closes the native and external Hermes memory
lifecycle in the honest runtime; it does not change the original consequence
that an unrestricted agent can read files available to the user's process
directly.
