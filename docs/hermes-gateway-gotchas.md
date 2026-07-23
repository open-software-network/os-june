# June ↔ Hermes gateway — integration gotchas

Hard-won facts about talking to the embedded Hermes runtime. Companion to
[hermes-architecture.md](hermes-architecture.md) (the layer map); this page is
the list of things that LOOK like they should work and do not, mostly learned
stabilizing the MCP surfaces (JUN-137, PR #610). Everything here is specific to
the pinned runtime version — re-verify on a pin bump
([hermes-upgrade-checklist.md](hermes-upgrade-checklist.md)).

## Lifecycle

**Restart the runtime through June's bridge, never through Hermes' own API.**
`POST /api/gateway/restart` exists upstream, but it spawns `hermes gateway
restart`, which kills the very process serving the request: the action poll
dies mid-flight, and the replacement gateway is a child of the dying dashboard,
not of June — outside June's supervision. June owns the process, so a restart
is `stop_hermes_bridge` + `start_hermes_bridge` (see the MCP page's
`restartRuntime`).

**Every spawn mints new credentials.** The gateway port, the session token, and
the provider-proxy port/token all change on respawn. Anything that captured
them — every `hermes-admin` client, cache, lifecycle — is dead after a restart.
Rebuild the whole admin engine from a fresh `hermesBridgeStatus()`; do not try
to "reconnect" existing clients.

**Dev machines: the gateway keep-alives.** Hermes installs an
`ai.hermes.gateway` LaunchAgent; a plain `kill` respawns the gateway. Stop it
with `launchctl bootout gui/$UID/ai.hermes.gateway`. June re-registers it on
next launch.

## Config

**`config.yaml` has two writers — June must merge, never overwrite.** June
renders its per-spawn keys (proxy routing, `june_context` / `june_web`) and the
jailed dashboard persists admin changes into the same file. See
[ADR 0009](adr/0009-hermes-config-shared-ownership-merge.md); the enforcement
point is `merge_hermes_config`. Corollary: adding a key to
`render_hermes_config` claims per-spawn ownership of it.

**Config writes are whole-tree replaces.** `PUT /api/config` takes
`{ config: <tree> }` and `save_config` replaces the file; a `{ path, value }`
body 422s and there is no `DELETE /api/config`. Every June-side write is
therefore read-modify-write of the full tree, and a multi-leaf change must
batch into ONE put (`config.applyWritesAtSegments`) or a mid-sequence failure
leaves config half-mutated.

**Mutating admin requests serialize with Memory policy writes.** June holds the
bridge start/config guard for the full dashboard round-trip so a whole-tree
Hermes write cannot race spawn rendering or a direct Memory-policy edit. One
request is bounded by `HERMES_API_REQUEST_TIMEOUT` (45 seconds), but the mutex
is FIFO, so a Memory toggle can also wait behind earlier queued mutations.
Review that user-visible aggregate delay before increasing the request budget
or adding another long-running mutating admin call.

**Secrets are write-only.** Server listings strip `env` and `headers` values;
June can never read them back. "Edit" therefore only covers non-secret
connection fields; changing a secret is delete-and-re-add.

**Live-session model changes use `config.set`, not `command.dispatch`.** In the
pinned runtime, `/model` is implemented by the TUI client and is not a gateway
quick/plugin/skill command. Sending it through `command.dispatch` returns 4018
(`not a quick/plugin/skill command`) and changes nothing. The working WebSocket
request is `config.set` with the runtime `session_id`, `key: "model"`,
`value: "<model> --session"`, and `confirm_expensive_model: true`. Keep
`--session`: without it, Hermes can persist the selection as its process-wide
default and affect unrelated sessions.

**Model `config.set` is idle-only.** Hermes returns 4009 while that session is
running because changing Hermes' model, provider, endpoint, and client in
place would race with the active agent run. A picker change during that run is
therefore June state only. On the next Send, apply its captured choice
immediately before `prompt.submit`. `message.complete` can precede true idle,
and automatic goal continuations are still part of the same agent run, so retry
only 4009 until that run releases the busy guard. If idle `config.set` fails,
keep the prompt and choice recoverable instead of silently sending with the
previous model. Serialize this mutation through accepted `prompt.submit` by
stored session id: AgentWorkspace and Note Chat can dispatch the same session
from separate gateway clients.

**Internal model ids carry provider provenance.** June stores reserved aliases
for concrete remote, Auto, and local choices in Hermes. Advertise every alias
Hermes may validate from the Bridge's `/v1/models` response, decide the route
before stripping its prefix in the on-device provider proxy, and decode it before forwarding
to June API or a local endpoint. Never infer a new session's provider from raw
model-id equality: local and remote catalogs can expose the same id.

## MCP OAuth

**`hermes mcp login` requires a TTY.** The whole OAuth flow gates on
`sys.stdin.isatty()`; `HERMES_NONINTERACTIVE` is not read on that path, and
there is no print-the-URL fallback before the gate. June wraps the CLI in
`/usr/bin/script -q /dev/null` on macOS so it sees a real PTY, runs its own
browser flow, and captures the localhost callback itself. (No Windows story
yet.)

**The login CLI exits 0 on failure.** `cmd_mcp_login` prints "Authentication
failed: ..." and returns success. Classify from output markers first
(`mcp_login_succeeded`); require the explicit "Authenticated" line for
success.

**Consent-screen identity comes from config.** The OAuth client registers with
`mcp_servers.<name>.oauth.client_name` (default "Hermes Agent"). June writes
`"June"` before every sign-in (never overwriting a custom name); a re-login
wipes tokens AND cached client registration, so the rename applies
retroactively. `logo_uri` is NOT forwarded by the pinned runtime — a consent
icon needs an upstream change plus a publicly hosted image.

**Auth status is not reported for every transport.** The server listing often
carries no token state (`auth_status` absent, transport labeled plain `http`
even for OAuth servers). June derives "signed in" from fresher signals: a
completed login this session, or a successful test probe (which needed the
cached token to connect). Detection of "this server is OAuth at all" also
falls back to the config's `oauth` marker and OAuth-shaped probe errors.

## Events

**MCP approvals are identity-addressed, not FIFO.** The pinned runtime carries
June's checksum-gated `june-approval-memory-v14` patch. MCP elicitation preserves the
SDK request id and emits an opaque stable `request_id` on `approval.request`.
While unanswered, the same logical request retried after an MCP transport
reconnect joins the existing entry; separate requests on one transport remain
separate even when their prompt text matches.
Send that exact id back with `approval.respond`; never use `all: true` and never
assume the first visible card is the queue head. Timeout and disconnect emit
`approval.expire` and must render as a retired, non-actionable request. A
missing or malformed id fails closed. See ADR 0025.

**A gateway drop retires pre-drop approvals.** The patched runtime drains them
fail closed as soon as the WebSocket transport detaches. AgentWorkspace mirrors that boundary locally
before `session.resume`, then replaces the session event listener with the new
runtime id. A delayed replay is diagnostic noise, not a reason to reopen the
card.

**The control plane fails loudly on unknown event types — by design.** A new
raw type renders as the red "event June does not support yet" banner until it
gets a branch in `classifyHermesEvent` (`hermes-control-plane/event-classifier.ts`)
and a member in the `JuneHermesEvent` union. That is the fix path; do not
suppress the banner.

**Reasoning arrives two ways.** Streaming models emit `reasoning.delta` /
`thinking.delta` chunks (append). Whole-block reasoning models emit
`reasoning.available` / `thinking.available` once with the FULL text —
classified with `full: true`, and consumers REPLACE the thought instead of
appending so a post-delta replay cannot duplicate it.

## Upstream (via june-api)

**Hermes owns agent-chat retries.** June pins `agent.api_max_retries: 3` in
the per-spawn config. In the pinned Hermes runtime the provider loop is
`while retry_count < max_retries` and only increments after a failed attempt, so
`3` is three total provider attempts (with the runtime's jittered waits between
them). Do not trust generic Hermes docs that count this as four attempts; match
the pinned runtime loop. The desktop forwards each attempt once, and June API
makes one upstream call for each request. Do not add another retry at either
layer without moving ownership deliberately: shipped clients would multiply the
new retry count by Hermes' attempts.

**One bad tool schema can brick every chat request.** The AI upstream rejects a
tool parameter schema carrying both `type` and a sibling `allOf` (valid JSON
Schema draft-07; Todoist's MCP emits it) with "Conflict in schema definitions
for key 'type'" — a 400 on EVERY request while that server is connected, which
june-api used to rebrand as a bare 502. june-api now strips `allOf` beside
`type` before forwarding (`sanitize_tool_schemas` in
`june-api/crates/providers/src/venice.rs`) and logs a capped preview of the
upstream error body.

**Debugging trick: replay the request dumps.** Hermes writes failing agent
requests to `$HERMES_HOME/sessions/request_dump_*.json` — the exact body,
tools included. Replaying them against the upstream with tool-subset bisection
is how the schema conflict above was isolated to one tool in minutes.
