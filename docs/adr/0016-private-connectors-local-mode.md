# Private connectors (local mode): token custody, app-proxied MCP, trust modes

## Status

proposed - implements Phases 1-2 of
[private-connectors-prd.md](../private-connectors-prd.md) and
[private-connectors-implementation-plan.md](../private-connectors-implementation-plan.md).
Local mode only. Away-mode relay (Phase 3) and Slack/Notion/Linear (Phase 4)
are deliberately out of scope and will supersede parts of this ADR with their
own records.

## Context

June is adding Google connectors (Gmail + Calendar) so routines can act on the
user's real mail and calendar. The product promise is "private by
architecture, not policy": OpenSoftware must hold no credential that can read a
user's mail, even under compulsion. That promise is only true if three things
hold, and this ADR records how each is enforced in code, because each has a
tempting shortcut that breaks the promise.

The embedded Hermes runtime already ships a `google-workspace` skill upstream,
but it is unusable for this product: it requires the user to stand up their own
Google Cloud project, it stores the OAuth token as plaintext JSON inside the
agent's own working directory, it requests a broad scope superset in one
consent, and it drives Google through shell commands, which June's sandboxed
routines strip and which give no per-tool gate. We build a first-party path
instead.

Three runtime facts about the pinned Hermes (v0.17.0, commit `2bd1977d`) shape
the design and are load-bearing:

1. **Each MCP server is its own toolset** (`mcp-<server>`, with the raw server
   name as an alias). A routine's `enabled_toolsets` therefore decides, per
   server, whether the model can see those tools at all.
2. **Regular MCP tool calls bypass Hermes's approval layer entirely.** Only
   shell/exec/secret guards and server-initiated elicitation raise
   `approval.request`. Cron sessions never raise an interactive approval. So
   Hermes cannot be the enforcement point for "this send needs your OK."
3. **The MCP server process is shared across all sessions and receives no
   per-session identity** (no env, `clientInfo`, or `_meta` carries the session
   or job id). A `tools/call` cannot be attributed to a routine at the MCP
   boundary.

## Decision

### 1. Tokens live only in the Keychain; the agent can never read them

OAuth uses Google's native-app flow: PKCE (S256), a loopback redirect on an
ephemeral `127.0.0.1` port, and the real Google consent screen in the user's
default browser (never a webview). The refresh token is minted to the device
and stored via `keyring` v3 in a dedicated Keychain service
(`co.opensoftware.june.google`, `-dev` in debug), one item per account keyed by
email, holding a `Zeroize`/`ZeroizeOnDrop` token blob. This reuses the exact
plumbing proven by OS Accounts sign-in (`os_accounts.rs`).

Only a non-secret index (email, granted scopes, status) lives in the app DB, so
accounts can be enumerated without touching the Keychain. The Keychain is
already denied to the agent by the Seatbelt profile (`Library/Keychains`); the
dev plaintext fallback file, when enabled, is added to the sandbox deny-read set
and the secret-filename denylist.

### 2. Connector API calls originate on-device and never transit June API

The MCP servers (`june_gmail*`, `june_gcal*`) are stdlib-only Python scripts
that hold **no** OAuth token. They call the app's existing on-device loopback
proxy (the "provider proxy" in `hermes_bridge.rs`) with a **dedicated connector
token**, scoped by route, mirroring the `june_recorder` token-isolation
precedent rather than reusing the general model token. The proxy's connector
routes resolve the real access token from the Keychain in Rust and call Google's
REST API **directly**. June API (the TEE backend) is not in the connector data
path. This is the concrete meaning of "OpenSoftware's servers hold no key to
your mail."

Model inference for a routine still follows the user's provider selection (June
API by default, or a local model). The "not in the data path" claim covers
token custody and provider calls, never inference; the copy says so.

### 3. Trust modes are enforced in the Rust proxy, not by prompting the model

Every routine carries a trust mode: `read_only` (default is `approval`) ->
`approval` -> `autonomous`, tracked in an app-side `routine_trust` table (the
source of truth, not the Hermes job record).

- **read_only**: the routine's `enabled_toolsets` include only the read servers
  (`june_gmail`, `june_gcal`). The mutating servers are simply absent, so the
  model cannot call them. Enforced by Hermes toolset resolution.
- **approval**: the routine also gets the action servers
  (`june_gmail_actions`, `june_gcal_actions`). Every mutating route in the proxy
  parks the call in an app-side pending-approval registry, emits a Tauri event,
  and blocks until the user approves or denies in June's own UI (batched;
  600 s timeout -> denied). This is where the enforcement lives, precisely
  because Hermes will not gate these calls itself.
- **autonomous**: unlocked only after the routine has run correctly under
  approval at least three times ("earned autonomy"). A grant mints a per-routine
  token bound to `(job_id, allowed_tools, account)`; the proxy executes those
  specific tools without parking, and parks everything else.

Trust modes are kept visually and structurally separate from the existing
Sandboxed/Unrestricted runtime mode: trust governs outward actions, the sandbox
governs local system access.

### 4. Event triggers via an app-side polling daemon

A Rust daemon polls Gmail `history.list` deltas and upcoming calendar events
while the Mac is awake (backing off when idle, pausing on low battery), and
fires subscribed routines through the existing bridge run-now action. Event
routines are created paused with a distant one-shot schedule; the daemon is what
actually triggers them, so no cron string encodes an event. Cursors persist per
account.

## Consequences

- **The headline privacy claim is enforceable and true in local mode.** A
  compromise of OpenSoftware infrastructure yields no token that can read mail;
  the tokens are on the device, and connector traffic never reaches the backend.
- **Known limitation of this Hermes pin (documented, bounded, followup):**
  interactive chat sessions receive every globally-enabled MCP server by
  default. So a tool the user granted a routine for autonomous use is also
  reachable without parking in interactive chat for the same account. It is
  bounded to tools the user explicitly granted, and to the connected account.
  The clean fix is upstream per-session toolset selection (absent in v0.17.0) or
  rendering the CLI/TUI toolset allowlist without the action servers; tracked as
  a followup. The away-mode threat-model page states this plainly.
- **Applying connector config requires a runtime restart.** `config.yaml` is
  only rendered on runtime start, so connect/disconnect/grant changes restart
  the mode-scoped Hermes runtime, exactly as the model switch and MCP admin
  changes already do. No hot reload.
- **Scopes are requested incrementally.** Read scopes first; `gmail.send` is
  requested only when a user enables an autonomous send routine. This protects
  consent conversion and eases Google's restricted-scope (CASA) review, which is
  the program's external critical path and independent of this ADR.
- **We deviate from the plan's "new crate" language.** `src-tauri` is a single
  crate, not a workspace; connectors are a module (`src-tauri/src/connectors/`),
  matching the house pattern. No behavior change; recorded here so the
  discrepancy with the plan doc is not mistaken for an omission.
