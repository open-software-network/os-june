# Private connectors: local mode threat model

**Status:** source of truth for connector privacy copy. Every user-facing
privacy claim about connectors must be traceable to a line on this page; if a
claim is not supported here, the claim is wrong, not the page. Scope is **local
mode** (the only connector mode that ships in Phases 1-2). Away mode (the
Phase 3 TEE relay) will publish its own, larger threat model when it ships.

## What local mode is

You authorize Google on your Mac. The refresh token Google mints is stored in
your Mac's Keychain. Every Gmail and Calendar API call June makes originates
from your device, using that token, and goes straight to Google. June's
backend (June API) is not involved in connector calls.

## What OpenSoftware can and cannot see

**Cannot see, by architecture:**

- Your Google refresh or access tokens. They are in your Keychain, protected by
  Keychain access control and June's code-signing identity, and never
  transmitted to OpenSoftware. We hold no credential that can read your mail,
  so there is nothing to hand over under a subpoena and nothing to steal in a
  breach of our servers.
- The content of your mail or calendar as it flows through a connector call.
  Connector requests go device -> Google, not through June API.

**Can see, and you should know it:**

- **Model inference is a separate path.** When a routine runs, its prompt (which
  can include mail or calendar content the routine chose to read) goes to
  whichever model provider you selected. By default that is June API, which runs
  in a TEE (Phala) so its own operators cannot read prompt data, but it is still
  a network call off your device. If you select a local model, inference stays
  on-device too. The "OpenSoftware is not in the connector data path" claim
  covers token custody and provider API calls. It does not cover inference, and
  the copy never implies it does.
- **Billing metadata.** Metered model calls settle against OS Accounts, so the
  usual coarse billing records exist (that a metered call happened, its action
  slug, credits charged). No mail content is in them. June's only product
  telemetry remains opt-in, coarse-bucketed P3A aggregates; connectors add no
  per-user app telemetry.

## Trust surface for local mode

Local mode adds exactly these things to what you already trust by running June:

1. **Google.** You are granting June's OAuth client access to the scopes you
   approve. Google sees the same API calls any mail client would.
2. **Your device's Keychain and June's code signature.** Token secrecy rests on
   macOS Keychain access control and June being correctly signed. A local
   attacker with your unlocked machine and your login keychain can reach the
   tokens, the same as for any app's Keychain items.
3. **The embedded agent.** June's agent can call the connector tools you enable.
   The protections below bound what it can do without you.

## Agent-facing protections

- The agent cannot read the token store while June's sandbox is engaged. The
  profile denies both direct reads of Keychain database paths and Mach lookup
  of the `securityd` services used by Keychain APIs. Tokens live in the
  unsandboxed Rust host, and MCP tool servers hold only a scoped loopback token,
  never a Google token. Signed rc builds verify this with both the `security`
  CLI and a direct `SecItemCopyMatching` probe before release.
- Connector tool descriptions mark email and calendar content as untrusted
  input, because a hostile email can carry instructions (prompt injection).
- Mutating actions (send, draft, label changes, event changes, invite
  responses) are gated by **trust mode**. Plain and read-only routines cannot
  call mutating tools. A routine that enables actions starts in approval: the
  action parks in June's own approval surface, shows the exact recipients or
  object and change, and waits for you. Autonomous execution must be earned
  (three successful approval-mode runs) and is granted per tool.

## Interactive-session isolation

The pinned runtime auto-includes globally enabled MCP servers unless June pins
the interactive toolset. June does pin it: normal chat receives the base read
and action servers, whose mutations always park for approval, but never receives
the per-routine `june_*_auto_*` servers that carry autonomy grants. Cron jobs use
their own per-job `enabled_toolsets`, so this exclusion does not weaken a grant
the user intentionally gave a routine. See
[ADR-0016](adr/0016-private-connectors-local-mode.md).

## Revocation

Disconnecting an account deletes its tokens from the Keychain immediately.
"Also revoke June's access with Google" additionally calls Google's revoke
endpoint so the grant is dead server-side. Both paths are in Settings ->
Connectors.

## GitHub local mode and interactive reads

GitHub adds App device authorization, selected-repository discovery, and a
fixed read-only repository, issue, pull-request, comment, commit, check-run,
and commit-status surface beside the existing Google connector. It stays
within the same local-mode custody boundary. GitHub write actions are not part
of this slice. The Google analysis above remains unchanged.

### Assets and metadata

- The GitHub device-flow user access token and rotating refresh token are bearer
  assets. June stores them in the dedicated GitHub Keychain service, keyed by
  the stable GitHub user ID. They never enter SQLite, Tauri payloads, logs,
  telemetry, or an MCP process.
- SQLite stores the non-secret discovery cache: the connected user's identity,
  stable installation and repository IDs, granted permissions, installation
  status, and selected-repository metadata. This metadata can still disclose
  account and private-repository names to someone who can read the local app
  database, so it is not treated as public evidence.
- June retains an avatar URL only when it is HTTPS on
  `avatars.githubusercontent.com`; every other avatar origin is discarded
  before data reaches the webview.
- Debug builds can explicitly opt into plaintext token fixtures with
  `OS_JUNE_DEV_PLAINTEXT_TOKEN_STORE=1`. The GitHub fixture and its atomic
  temporary files may contain real local tokens and must never be shared or
  committed. Release builds do not use this override.

### Defenses and traffic boundary

- Keychain is the default token store. The unsandboxed Rust host owns token
  custody and provider calls. While the Hermes sandbox is engaged, its profile
  denies Keychain database reads, Keychain Services IPC, and reads of both the
  GitHub plaintext fixture and its narrowly matched temporary files, so a
  sandboxed embedded agent cannot obtain the GitHub tokens. Unrestricted
  sessions and sessions started with `JUNE_HERMES_DISABLE_SANDBOX` do not apply
  this profile and are outside this defense.
- Device denial, expiry, or cancellation creates no connection row or token
  entry. If cancellation or attempt replacement races with a Keychain or SQLite
  side effect, the serialized completion and compensation boundary removes the
  partial new custody and state or restores the prior connection before the
  attempt returns.
- Device flow, token refresh, user lookup, installation discovery, and
  selected-repository discovery travel directly from the desktop app to GitHub.
  June API receives no GitHub credential or repository data.
- Interactive GitHub tools connect to a Rust-owned Unix-domain broker. The
  broker authorizes the exact dashboard pid and runtime generation using macOS
  kernel peer credentials, admits one persistent connection, and accepts only
  the fixed bounded read operations. Admission also registers a macOS process
  exit monitor before it becomes active, so an already-exited child fails
  closed and even an unconsumed admission is revoked on that exact process's
  exit before its numeric pid can be reused. The socket path is non-secret and
  carries no bearer, credential, repository allowlist, or general provider
  route.
- Terminal children, sibling MCP servers, the launchd gateway, scheduled jobs,
  and sessions using `no_mcp` receive no GitHub read authority. Separate
  processes cannot pass the peer-pid check merely by learning the socket path.
- GitHub reads are macOS-first and require June's sandbox to be engaged. The
  sandbox denies the Hermes-writable `$HERMES_HOME/plugins` tree so code Hermes
  persists cannot later run inside the broker-authorized dashboard pid.
  Unrestricted sessions, sandbox-disabled or sandbox-failed starts, and other
  platforms fail closed. A host-approved extension deliberately loaded in the
  same process would still be same-trust code; peer-pid admission cannot isolate
  two extensions inside one pid.
- Repository content is untrusted model input. When an online model is
  selected, bounded GitHub tool results can enter that provider's inference
  context. On-device provider calls and Keychain custody do not imply that
  inference remains on-device.

The broker decision and its fail-closed runtime boundary are recorded in
[ADR-0033](adr/0033-kernel-authenticated-github-read-broker.md). No June API
change or deployment is required.
