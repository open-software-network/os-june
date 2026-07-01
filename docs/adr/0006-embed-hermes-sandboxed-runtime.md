---
status: accepted
date: 2026-07-01
---

# Embed the pinned Hermes runtime as sandboxed child processes

June's agent/chat brain is the upstream **Hermes** runtime (Nous Research),
**embedded** and driven rather than reimplemented. `src-tauri/src/hermes_bridge.rs`
spawns Hermes as **child processes under a macOS Seatbelt write-jail**, pinned to
a specific commit and **SHA-verified** on download, and talks to it over
**JSON-RPC on a WebSocket gateway**. June overrides the runtime's persona at
prompt-build time with an injected `SOUL.md` and presents to users as June,
never as Hermes.

## Why

- Reuse a capable, maintained agent runtime (sessions, tools, MCP, scheduling)
  instead of building and maintaining a bespoke chat engine.
- The **sandbox** contains what the agent can write on the user's device; the
  default runtime mode is `sandboxed`, and `unrestricted` is an explicit
  per-session opt-in (`JUNE_HERMES_DISABLE_SANDBOX` is a dev escape hatch only).
- **Pinning + verification** make the dependency reproducible and tamper-evident.

## Trade-off

- The entire subsystem depends on **Hermes' wire protocol**. Every pin bump can
  silently break a feature June relies on, so a **compatibility matrix**
  (`src/lib/hermes-control-plane/compatibility/matrix.ts`,
  `PINNED_HERMES_VERSION`) plus the **upgrade checklist**
  ([docs/hermes-upgrade-checklist.md](../hermes-upgrade-checklist.md)) gate every
  bump behind fixture replay + a live smoke test before the matrix flips a
  feature back to `supported`.

## Consequences

- June keeps **two runtimes keyed by write-mode** (one gateway per mode) so an
  unrestricted session can't un-sandbox other sessions' follow-ups.
- All admin/dashboard traffic (skills, MCP, toolsets, env) must route through the
  Rust **`hermes_admin_request`** proxy — the webview is cross-origin to the
  Hermes dashboard and must never hold the dashboard token.
- Event handling is a **total classifier** (`classifyHermesEvent` always returns
  one `JuneHermesEvent`; unknown frames surface as `unsupported`, never vanish),
  so a runtime upgrade that adds events is visible rather than silently dropped.
- See [docs/hermes-architecture.md](../hermes-architecture.md) for the full
  bridge / gateway / control-plane layering.
