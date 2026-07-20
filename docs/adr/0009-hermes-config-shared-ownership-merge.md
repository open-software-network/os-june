# ADR 0009: config.yaml is shared with the Hermes dashboard; June merges, never overwrites

Date: 2026-07-03
Status: accepted

## Context

June writes `$HERMES_HOME/config.yaml` at every runtime spawn (`sync_hermes_config`
in `src-tauri/src/hermes_bridge.rs`): the model routing block must point at the
provider proxy whose port and token change per spawn, and June registers its
built-in MCP servers (`june_context`, `june_web`) whose script paths and
credentials also change per spawn.

The same file has a second writer: Hermes' jailed dashboard persists every admin
change through `save_config` — user-added MCP servers, per-server tool filters,
OAuth client names, skill config. June's admin surfaces (the MCP servers page,
tool filtering, skill config) deliberately route their writes through that
dashboard (`PUT /api/config`) so the jailed runtime owns the file write and June
never needs write access into the jail.

Until JUN-137, June's spawn path did `fs::write(config.yaml, <rendered template>)`
— a wholesale replace containing only June's keys. Every spawn silently deleted
everything the dashboard had persisted. The failure was invisible: the app
worked, the user's MCP servers just vanished on the next restart, with nothing
in any log.

## Decision

`config.yaml` is jointly owned, and June's spawn path **deep-merges** its
rendered keys over the existing file instead of replacing it:

- mappings merge recursively; June's leaves win on conflict;
- June's per-spawn keys therefore always refresh: `model.*` (proxy base URL,
  token), `agent`, `display`, `platform_toolsets`, `skills.external_dirs`,
  `mcp_servers.june_context`, `mcp_servers.june_web`;
- every key June does not render survives untouched: user `mcp_servers.*`
  entries with their `oauth` and `tools` blocks, `skills.config`, and anything
  a future Hermes adds;
- a missing or unparsable existing file falls back to the rendered template
  (the pre-JUN-137 behavior).

The merge is implemented with `serde_yaml` in `merge_hermes_config` /
`deep_merge_yaml` and covered by tests that seed a dashboard-persisted server
and assert it survives a respawn while the proxy token refreshes.

## Consequences

- Dashboard-persisted admin state survives June restarts, runtime restarts, and
  app updates. This is what makes June's admin surfaces trustworthy at all:
  without it, every write they make has spawn-length lifetime.
- June must never render a key it does not own. Adding a key to
  `render_hermes_config` claims per-spawn ownership of it — the dashboard's
  value for that key will be clobbered on every spawn. Review any addition
  against this ADR.
- YAML comments and key order in `config.yaml` are not preserved (both writers
  rewrite the file mechanically; Hermes' own `save_config` behaves the same).
- Corrupt YAML degrades to June's template rather than a failed spawn — the
  runtime always comes up, at the cost of dropping unreadable user config.

## Alternatives considered

- **June owns the whole file; dashboard writes elsewhere.** Rejected: the
  dashboard's write target is upstream Hermes behavior (`save_config`), and the
  runtime reads exactly this file. Redirecting it means patching the pinned
  runtime, which June does not do.
- **June writes a separate include file.** Rejected: the pinned Hermes config
  loader has no include mechanism.
- **June re-applies its keys through `PUT /api/config` after spawn.** Rejected:
  the proxy credentials must be in place *before* the gateway starts (the model
  block is read at process start), and the API is not up yet at that point.

## Addendum: cross-process Memory policy coordination (2026-07-17)

JUN-337 introduces a June-owned policy inside the otherwise shared `agent`
mapping: membership of `memory` in `agent.disabled_toolsets`. The desktop must
be able to change that policy even when no bridge process is live, while a
Hermes dashboard or CLI process may later save an older in-memory config
snapshot.

June and the pinned Hermes runtime now take the same OS advisory lock around
each atomic `config.yaml` replacement. While holding that lock, Hermes' sealed
central YAML writer re-reads the file and copies only the current Memory deny
membership into its pending snapshot before saving. The pending writer's other
changes survive, and June's direct mutation preserves every unrelated YAML
field. The lock is released by the OS if either process exits unexpectedly.

This protocol does not transfer ownership of the rest of `config.yaml` to June
or generally merge arbitrary stale dashboard snapshots. It is deliberately
narrow: it serializes replacements and makes June's current Memory deny policy
win across the process boundary. The pinned Telegram gateway's DM-topic writer,
which previously replaced the file independently, is transformed to use the
same central YAML writer. The desktop/TUI JSON-RPC `config.set` writer is routed
through it as well and refreshes its cache from the reconciled file.

Both writers resolve a symlinked config to its canonical target and create the
replacement beside that target. June's Rust writer and Hermes' patched Python
writer preserve POSIX modes and macOS ACLs; on Windows they use `ReplaceFileW`
so the destination security descriptor survives the replacement.
