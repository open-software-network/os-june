# Hermes agent runtime — architecture

How June embeds and drives the Hermes agent runtime as its chat/agent brain.
For *why* it is embedded and sandboxed, see
[ADR-0006](adr/0006-embed-hermes-sandboxed-runtime.md). For the code-level
contract of the typed event seam, `src/lib/hermes-control-plane/README.md` is
the best entry point. For bumping the pinned runtime, see
[hermes-upgrade-checklist.md](hermes-upgrade-checklist.md). For the sharp
edges of the integration (restart discipline, the config.yaml contract, MCP
OAuth, event types), see
[hermes-gateway-gotchas.md](hermes-gateway-gotchas.md).

## Layers

June wraps Hermes in four layers, cleanly separated:

- **Bridge** (`src-tauri/src/hermes_bridge.rs`, Rust) — spawns Hermes child
  processes under a macOS Seatbelt sandbox, injects the `SOUL.md` identity, runs
  a shared on-device provider proxy (identity stripping / retention enforcement
  before any inference leaves the device), bundles two Python MCP servers
  (`june_context` = search the user's notes/dictation plus `get_meeting_note`
  fetch-by-id for **note references** (`@note:<id>`, see
  [ADR-0010](adr/0010-note-references-in-agent-chat.md)), `june_web` = web via
  a token-gated loopback proxy), and exposes ~50 Tauri commands.
- **Gateway** (`src/lib/hermes-gateway.ts`) — `HermesGatewayClient`: pure
  JSON-RPC-over-WebSocket transport (connect coalescing, request/response
  correlation, timeouts, `4009` "session busy").
- **Control plane** (`src/lib/hermes-control-plane/`) — the typed seam.
  `classifyHermesEvent` is a **total** function: every raw frame maps to exactly
  one `JuneHermesEvent`, and unknown frames become a visible `unsupported` event
  rather than vanishing. `methods.ts` builds typed outbound RPC; `compatibility/
  matrix.ts` pins `PINNED_HERMES_VERSION` and gates features.
- **Adapter** (`src/lib/hermes-adapter.ts`) — session-list normalization (titles,
  scheduled-run detection, subagent filtering), distinct from the live-event
  control plane.

`src/components/agent/AgentWorkspace.tsx` is the React surface that wires these
together (composer, transcript, session list, model switching, attachments,
approval/clarify/sudo/secret UIs). `src/lib/agent-chat-runtime.ts` turns
classified events into `AgentChatTurn` / `AgentChatPart[]` for rendering.

## Submit flow

1. Composer text → `AgentWorkspace.submit`.
2. `ensureHermesGateway(unrestricted?)` picks/creates a `HermesGatewayClient`
   from `gatewaysRef` — **one gateway per write-mode**.
3. `gateway.request("session.create")` returns **both** a `stored_session_id`
   (June's persistent id) and a `session_id` (the live runtime id);
   `ensureHermesBridgeSession` persists the mapping.
4. If the session has a queued model choice, June applies it to the idle live
   session with `config.set` before submitting anything. A failed switch blocks
   the send and leaves the choice queued.
5. Images are attached via `image.attach_bytes` (bytes read at attach time,
   never stored on state/trace/artifacts).
6. `gateway.request("prompt.submit")` (ack-style) → live `event` frames →
   `classifyHermesEvent` → `agent-chat-runtime` builds turns → React renders.

## Key concepts

- **Two runtimes keyed by write-mode.** `gatewaysRef: Map<boolean, client>`;
  `sandboxed` (default) vs `unrestricted` (per-session opt-in). Follow-ups route
  to the runtime matching the session's original mode, so one unrestricted
  session cannot un-sandbox others.
- **Stored vs runtime session id.** The UI keys everything on the persistent
  **stored** id; RPCs target the live **runtime** id. Sessions render
  optimistically before the first message persists, with rollback/migrate paths.
  Conflating the two attaches traces/artifacts to the wrong session — always say
  which id you mean (see CONTEXT.md).
- **Admin traffic goes server-side.** All admin/dashboard calls (skills, MCP,
  toolsets, env, cron) route through the Rust `hermes_admin_request` proxy — the
  webview is cross-origin to the Hermes dashboard and must never hold its token.
- **A model choice applies to the next user message, never the active agent
  run.** The picker records the latest session-local choice immediately,
  including while June is responding. Send snapshots one choice before any
  asynchronous preparation. The active agent run, including tool and goal
  continuations, keeps the model it started with. Before the next agent run,
  June waits for true idle and sends `config.set` with the live runtime session
  id, `key: "model"`, and `value: "<model> --session"`, then `prompt.submit`
  under one stored-session dispatch lock shared with Note Chat. The `--session`
  flag prevents Hermes from changing its process-wide default. The gateway ack
  is the source of truth; if Hermes rejects the mutation, June does not submit
  the prompt and keeps both the choice and message recoverable. See
  [ADR-0018](adr/0018-session-model-changes-apply-at-agent-run-boundaries.md).
- **Hermes model ids preserve route provenance.** Concrete remote, Auto, and
  local choices use reserved internal ids while stored in Hermes. The Bridge's
  `/v1/models` response advertises those aliases, and the on-device provider proxy
  decodes them before forwarding. This keeps a local model and remote model with
  the same raw id unambiguous and prevents a settings change from rerouting an
  active agent run.
- **Model capabilities come from the live Venice catalog, never traits** — see
  [ADR-0007](adr/0007-model-capability-source-of-truth.md). The model catalog is
  Rust-side (`src-tauri/src/providers/mod.rs`, backed by June API's Venice
  catalog).
- **The control plane is the sole reader of raw Hermes frames.** Every
  consumer (`agent-chat-runtime`, `hermes-trace-buffer`, `hermes-session-steer`)
  works from classified `JuneHermesEvent`s, never from raw frames. Every
  normalized event carries `receivedAt`; first-party local kinds (`steering`)
  are minted by June and never come out of `classifyHermesEvent`.
- **Lifecycle reconciliation uses one shared snapshot cycle.**
  `hermes-active-session-snapshots.ts` requests `session.active_list` once per
  active runtime mode every cycle and distributes the same result to run
  settlement and the mounted workspace. The gateway event stream remains the
  primary message path. Complete persisted history is fetched for a working
  session only after consecutive missing lifecycle heartbeats or an unexpected
  stream disconnect; the current bridge has no message-revision or delta
  contract.
- **Browser approvals are event-led.** The browser-approval change event
  refreshes pending approvals promptly. Snapshot reads are limited to initial
  subscription, listener reattachment, and focus, visibility, or online
  recovery rather than a permanent timer.
- **Identity override.** June rewrites the runtime's persona at prompt-build time
  via an injected `SOUL.md`; June presents as June, never as Hermes.

## Slash commands

Builtin composer slash commands are **`/model`**, **`/file`**, and
**`/image`** — the last gated off behind `IMAGE_GENERATION_ENABLED`
(`src/lib/agent-composer-slash-commands.ts`) — plus **skill** slash commands
(`skill-slash-commands.ts`). In an existing session, `/model` queues the same
next-message choice as the picker; it does not mutate the active agent run.
Choosing Model from the slash menu stages `/model`; pressing Enter opens a
searchable catalog with suggested models pinned above the remaining models and
an optional Private-only filter. Typing `/model <name>` selects a matching
model directly.

## Key Tauri commands

`start/stop_hermes_bridge`, `ensure_hermes_bridge_gateway`,
`hermes_bridge_status`, `hermes_bridge_sessions` / `_session_messages` /
`ensure_hermes_bridge_session`, `hermes_admin_request`, `hermes_bridge_skills` /
`toolsets` / `messaging_platforms`, `hermes_bridge_cron_jobs` (+CRUD),
`import_hermes_bridge_file(_bytes)`, `hermes_bridge_file_preview` / `_text`,
`hermes_mcp_oauth_login`, `list_venice_models` / `set_venice_model`,
`open_hermes_tui_debug`.
