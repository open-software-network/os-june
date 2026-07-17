# GitHub agent-read capability isolation design

Date: 2026-07-17  
Status: approved

## Context

The read-only GitHub implementation in
[GitHub agent reads design](2026-07-16-github-agent-reads-design.md) established
the right provider-side boundary: Rust owns the credential, resolves opaque
repository ids against the current selected-repository snapshot, calls only 16
fixed GitHub operations, bounds every response, treats repository data as
untrusted, and revalidates authorization before returning content.

Its first Hermes transport did not establish the intended process boundary. A
dedicated bearer token was written into the shared Hermes `config.yaml` so a
stdlib MCP subprocess could call the on-device `/v1/github/read` route. The
pinned Hermes runtime resolves MCP environment values in the parent process,
the Seatbelt profile permits broad reads, and all child processes inherit that
profile. A sibling MCP server or terminal subprocess could therefore read the
shared config and use the bearer directly. Repository selection and read-only
operation checks still limited the damage, but `june_github` tool exposure was
not the authority boundary it claimed to be.

The pinned runtime has no per-MCP sandbox, opaque secret reference, pre-opened
file-descriptor transport, Unix-domain MCP transport, or host-controlled MCP
spawn hook. Moving the bearer to an environment variable, token file, nested
sandbox, or post-start config scrub would only relocate the same authority.

This design supersedes only the Hermes transport and capability-isolation
sections of the earlier design. The GitHub App permissions, typed operations,
repository authorization, response bounds, content guards, revocation rules,
and on-device GitHub provider traffic remain unchanged.

## Goals

- Expose the 16 approved GitHub read operations only to eligible interactive
  June runtimes.
- Put no GitHub bearer, access token, refresh token, repository allowlist, or
  arbitrary provider route in Hermes config, environment, arguments, files, or
  child-process input.
- Reject terminal subprocesses, sibling and user MCP subprocesses, the
  launchd gateway, and scheduled routines even when they know the broker path.
- Keep the existing Rust `GitHubReadService` as the sole operation,
  repository, permission, revocation, provider, and response-policy boundary.
- Preserve `no_mcp` as the user's global opt-out for this first GitHub slice,
  despite changing the implementation from MCP to an in-process toolset.
- Fail closed on platforms where June has not implemented and tested a strong
  kernel peer-process identity primitive.

## Non-goals

- No GitHub mutations or additional GitHub permissions.
- No scheduled-routine GitHub access.
- No generic local RPC or arbitrary GitHub HTTP proxy.
- No attempt to isolate mutually hostile extensions running inside the same
  Hermes process. The pinned runtime has no in-process plugin isolation.
- No June API endpoint or deployment.

## Decision

June replaces the bearer-authenticated loopback route and stdio MCP with two
first-party components:

1. a Rust-owned **GitHub read broker** listening on a private Unix-domain
   socket; and
2. a bundled Hermes backend extension that registers the fixed
   `june_github` toolset and forwards typed requests over that socket.

The kernel-authenticated connection, not a string secret, is the capability.
The broker admits exactly the dashboard process June just spawned for an
eligible interactive runtime. Knowledge of the socket path grants nothing.

### Broker lifecycle and peer authentication

For each eligible runtime mode, June starts one broker before spawning the
Hermes dashboard and passes only its non-secret, per-start socket path through
`JUNE_GITHUB_BROKER_SOCKET`. The path is not written to `config.yaml` and the
socket is created with mode `0600` beneath app-owned runtime storage.

After `Command::spawn` returns, June registers the exact dashboard pid with a
monotonic runtime generation. The broker accepts one persistent connection for
that `(pid, generation)` admission and consumes the admission when it succeeds.
The extension may retry connection for a short bounded startup window to cover
the interval between process spawn and pid registration. An unregistered peer
is rejected; it cannot reserve or consume another process's admission.

On macOS, the broker reads `LOCAL_PEERPID` from the accepted socket and compares
it with the current admission. It does not trust a pid supplied in JSON or an
environment variable. A terminal command or MCP process has a different kernel
peer pid and is rejected even though it is a descendant of the authorized
dashboard.

The accepted connection is single-use for admission and persistent for tool
calls. A dropped connection fails closed until that runtime is restarted; it
does not reopen an admission that a stale or recycled pid could claim. June
revokes the generation and closes the broker when spawn fails, the dashboard
exits, its mode is stopped or restarted, eligibility changes, or the app shuts
down.

The launchd gateway is a separate process. June does not pass it the socket
path or register its pid. Cron toolsets and every unrestricted-routine override
continue to omit `june_github`, so routines fail at both the tool-exposure and
kernel-admission boundaries.

Linux may be added later with tested `SO_PEERCRED`; Windows requires an
equivalent named-pipe client-process check. Until then, GitHub agent reads are
not registered on those platforms. There is no bearer or tokenless-TCP
fallback.

### Fixed framed protocol

The broker protocol is deliberately smaller than HTTP and MCP:

- one 4-byte big-endian length followed by one JSON value per frame;
- request cap: 64 KiB, enforced before deserialization;
- response cap: 256 KiB, enforced after Rust finalization and before writing;
- request value: the existing tagged `GitHubReadRequest` operation union only;
- response value: the existing fixed GitHub read outcome envelope only;
- no URL, method, host, headers, bearer, provider credential, repository name,
  installation id, or arbitrary API path;
- one in-flight request per connection and a fixed 35-second deadline; and
- no request or response bodies in diagnostics.

Malformed frames, unknown operations, bounds violations, authorization
changes, and provider failures return stable sanitized outcomes. They never
fall through to another provider proxy route.

### Bundled `june_github` toolset

June ships a first-party backend extension named `june_github` in the pinned
Hermes runtime. Its manifest declares exactly the 16 approved tools. Its
`register(ctx)` function uses the pinned `PluginContext.register_tool` API with
`toolset="june_github"`, the existing schemas, and handlers that serialize only
the corresponding `GitHubReadRequest` variant.

The extension registers definitions without authority. It lazily establishes
the broker connection on first use, with the bounded startup retry described
above, and then serializes calls over the one persistent connection. It has no
Keychain access, GitHub credential, provider URL, repository allowlist, or
general network capability.

The extension is part of June's signed, pinned runtime overlay, not an
agent-writable `$HERMES_HOME/plugins` installation. Both macOS and Windows
bundlers apply the same deterministic source overlay before the app bundle is
sealed. The managed-runtime fallback copies from a signed app resource,
verifies the expected digest immediately before spawn, and never trusts a
pre-existing file at that destination. The runtime source tree is removed from
the Seatbelt write roots after compatibility tests prove Python runs with
`PYTHONDONTWRITEBYTECODE=1`; otherwise GitHub reads remain disabled for that
runtime source instead of loading an agent-writable privileged extension.

The previous `june_github` MCP stanza is pruned during config reconciliation,
and `/v1/github/read` is removed. Keeping either bearer path as a compatibility
fallback would preserve the capability leak this design removes.

### Eligibility and tool exposure

The existing eligibility gate remains authoritative: valid GitHub App config,
a connected connection, usable Keychain custody, at least one selected
repository on an unsuspended installation, and all six required read
permissions.

When eligible on a supported platform, June appends `june_github` only to the
interactive dashboard's explicit `HERMES_TUI_TOOLSETS`. A selection containing
literal `no_mcp` omits both the toolset and GitHub instructions from June's
SOUL. The name is not added to `platform_toolsets.cron`, a job's
`enabled_toolsets`, the unrestricted routine list, or the launchd gateway
environment.

Eligibility controls tool exposure and broker creation; every call still goes
through `GitHubReadService`, which reloads and revalidates current local state.
Disconnect, reconnect, installation refresh, repository-selection change,
permission change, suspension, and terminal credential failure stop or
reconcile the live runtime exactly as in the earlier design.

### Trust boundary and residual risk

The broker isolates separate processes. It blocks terminal commands, user and
sibling MCP servers, the gateway, and routines because their kernel peer pid
differs from the admitted dashboard pid.

A user-enabled Hermes backend extension runs inside that admitted dashboard
process. The pinned runtime cannot distinguish it from June's extension: it may
inspect Python state or reuse the live broker connection. Such extensions are
therefore same-trust native runtime extensions, not isolated content. June must
not claim protection from a hostile in-process Hermes extension. Absolute
isolation from those extensions requires an upstream process-isolation feature
or disabling them in June; that is outside this slice.

### Review convergence amendment

Final adversarial review showed that `$HERMES_HOME/plugins` could not be treated
as an external user trust decision because it is agent-writable, and Hermes has
multiple user-plugin import paths outside the main plugin manager. June therefore
takes the disabling option above for every broker-bearing runtime: GitHub reads
require the macOS sandbox, and that sandbox denies reads and writes beneath the
user plugin tree. The verified extension still loads from the sealed runtime
overlay. Unrestricted, sandbox-disabled, sandbox-failed, and unsupported
runtimes receive no broker authority. Host-approved code deliberately added to
the admitted process would still be same-trust and must not be described as
isolated by peer pid.

The final lifecycle contract also starts before the serialized preparation
lock. Each start captures stop epochs before it can queue on that lock, checks
them again after acquiring the lock, and checks them under the process-map lock
at registration. A successful stop therefore invalidates every already-invoked
start, including one waiting behind another start.

The broker also binds admission to the spawned process lifetime, not only its
numeric pid. Before admission becomes active, June registers a macOS
`EVFILT_PROC` exit monitor for that child. Registration failure rejects
admission, and exit revokes even an unconsumed admission without waiting for a
later status, start, or stop call. This closes pid reuse after a dashboard exits
before the verified extension opens its persistent connection.

Repository content remains untrusted input to the selected model. The selected
online model may receive bounded tool results in its inference context, as the
earlier design already states.

## Verification

The migration is complete only when automated tests demonstrate all of these:

- rendered and merged `config.yaml` contains no GitHub token, broker token, or
  `mcp_servers.june_github` stanza;
- the exact registered dashboard pid succeeds, while a same-user child, an
  unregistered process, a consumed second connection, a revoked generation,
  and a generation mismatch fail;
- an already-exited dashboard cannot be authorized, and dashboard exit revokes
  an unconsumed admission without bridge polling before any later pid reuse;
- request and response framing enforces 64 KiB and 256 KiB before content can
  cross the boundary;
- malformed and unknown operations return the fixed sanitized protocol;
- the bundled extension exposes exactly the approved 16 names and schemas and
  sends only typed requests;
- repeated tool calls reuse one persistent connection and no token-like fixture
  appears in config, environment, output, or errors;
- the real pinned runtime loads the extension only from the verified overlay,
  exposes it only when explicitly selected for an eligible interactive
  dashboard, and omits it for `no_mcp`, cron, and routine overrides;
- a sandbox write probe cannot modify the privileged extension source; and
- all existing revocation, selected-repository, permission, content-guard,
  pagination, finalization, and transport tests remain green.

Live QA must start June locally, open an eligible interactive session, and read
the selected staging repository's metadata, one file, one issue surface, and
one pull-request surface. It must also verify that disconnect or deselection
removes the tool after reconciliation and that `no_mcp` provides neither the
tool nor GitHub-specific instructions.

## Alternatives rejected

- **Environment, `.env`, or shared config bearer.** Hermes resolves values in
  the parent and sibling processes can read the same state.
- **Token file or inherited file descriptor.** The broad-read parent or an
  inherited descendant can acquire it; parent sandbox restrictions cannot be
  relaxed for only one child.
- **Delete or scrub config after startup.** Lazy discovery and reconnect reread
  config, leaving races and breaking repeated calls.
- **Nested Seatbelt profile.** Restrictions compose and cannot hide a secret
  the parent already received.
- **Tokenless loopback TCP or socket-path-only authorization.** Every same-user
  process could call it.
- **Signed helper identity.** The agent can execute the same signed helper;
  signature proves code identity, not the authorized launch instance.
- **Keep the stock MCP transport.** The pinned runtime lacks a host-controlled,
  peer-authenticated private transport, so its process boundary cannot enforce
  this capability.

## Consequences

- The GitHub credential and repository policy remain in Rust and on-device.
- Shared Hermes configuration contains no reusable GitHub authority.
- GitHub reads initially ship only where peer-process authentication and plugin
  integrity are tested, beginning with macOS.
- This deliberately deviates from ADR 0016's app-proxied MCP pattern for a
  capability whose interactive-only authority cannot be expressed safely by
  the pinned runtime.
- The extension and framing protocol become pinned-runtime compatibility gates.
- No GitHub account, Keychain item, or database migration is required.
