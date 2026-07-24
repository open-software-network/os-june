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
   `ensureHermesBridgeSession` persists the mapping. An explicit request to use
   Computer use also carries `enabled_toolsets: ["june_computer_use"]`.
   Hermes validates that this list only subtracts from the process allowlist,
   waits for that local MCP server instead of every configured server, and
   builds the first agent snapshot with no unrelated tool schemas. Each
   `prompt.submit` repeats the agent run's requested scope, so a later ordinary
   agent run restores June's normal tool surface without rebuilding the agent
   or MCP clients. Because the optional compute-host frame cannot carry this
   per-run restriction, a session that uses the scope stays on its inline
   executor thereafter; this keeps history, steering, and interruption bound to
   one live agent. The broad slash-command child is also left lazy for scoped
   sessions until a slash command is actually dispatched. Named profiles retain
   their independent tool policy and do not accept the default profile's narrow
   scope.
4. If the session has a queued model choice, June applies it to the idle live
   session with `config.set` before submitting anything. A failed switch blocks
   the send and leaves the choice queued.
5. Images are attached by asking Rust to validate and snapshot the source into
   a session-scoped workspace directory, then passing that local path through
   `image.attach`. Image bytes never cross the JS bridge or Hermes WebSocket on
   this path. `image.attach_bytes` remains an additive fallback for callers
   without a gateway-local path; neither path stores bytes in state, traces, or
   artifacts.
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
- **Provider-proxy request bodies are route-specific.** Web search/fetch bodies
  pass through unchanged from the loopback socket into June API under the
  route's byte cap. Routes that inspect or rewrite JSON keep a bounded buffer at
  that consumer only: chat selects and normalizes the model route; image/video
  inject settings and expand source references; browser, Computer use, memory,
  recorder, and connector routes dispatch locally from parsed arguments. Native
  path attachment snapshots separately keep composer image bytes out of the
  JavaScript/Tauri/Hermes transport before any provider request exists.
- **Model capabilities come from the live Venice catalog, never traits** — see
  [ADR-0007](adr/0007-model-capability-source-of-truth.md). The model catalog is
  Rust-side (`src-tauri/src/providers/mod.rs`, backed by June API's Venice
  catalog).
- **The control plane is the sole reader of raw Hermes frames.** Every
  consumer (`agent-chat-runtime`, `hermes-trace-buffer`, `hermes-session-steer`)
  works from classified `JuneHermesEvent`s, never from raw frames. Every
  normalized event carries `receivedAt`; first-party local kinds (`steering`)
  are minted by June and never come out of `classifyHermesEvent`.
- **Lifecycle reconciliation uses one shared polling cycle.**
  `hermes-active-session-snapshots.ts` requests `session.active_list` once per
  active runtime mode every 500 ms cycle and distributes the same result to run
  settlement and the mounted workspace. Runtime modes schedule independently
  so a stalled mode cannot throttle a healthy one. Complete persisted history
  is fetched for a working session only after a bounded streak of unreachable
  polls, consecutive reachable snapshots that omit it, or an unexpected stream
  disconnect; the current bridge has no message-revision or delta contract.
  The same existing `session.active_list` traffic is also the Gateway
  heartbeat: three consecutive request timeouts invalidate every open client
  for that runtime mode, converting a silently stalled OPEN socket into the
  established unexpected-close and reconnect path without adding another
  periodic request. When that polling is dormant because the mode has no
  working sessions, a new submit first sends one read-only
  `session.active_list` preflight with a three-second liveness deadline. A
  timeout force-disconnects the mode and retries only that safe preflight once
  on the fresh connection. The submit's real requests, including
  `session.create` and `prompt.submit`, are sent once with their ordinary
  deadlines.
- **Artifact discovery is indexed outside the render hot path.**
  `artifact-index.ts` seeds one flat file index from the Bridge snapshot,
  coalesces concurrent refreshes, and preserves June-owned writes that land
  while an older snapshot is in flight. Imports and generated media update the
  index directly; file-producing tool completions request a reconcile; a
  15-second mounted-session reconcile catches files added, removed, or renamed
  outside June. Transcript and reasoning deltas only query the index. File-path
  and filename aliases are compiled once per index change into a multi-pattern
  matcher, so assigning files to conversation turns does not compare every turn
  with every file.
- **Browser approvals are event-led.** The browser-approval change event
  refreshes pending approvals promptly. Snapshot reads are limited to initial
  subscription, listener reattachment, and focus, visibility, or online
  recovery. Rejected listener registrations retry with capped exponential
  backoff and emit a diagnostic after repeated failures. While agent work is
  active, a 30-second safety snapshot recovers a missed backend event without
  restoring the old permanent five-second idle poll.
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
