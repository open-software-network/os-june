# ADR 0019: Kernel-authenticated broker for interactive GitHub reads

Date: 2026-07-17
Status: accepted

## Context

June's first GitHub agent-read implementation used a dedicated bearer in the
shared Hermes config to authorize a stdio MCP server against an on-device Rust
route. The GitHub operation surface itself was fixed and read-only, but the
bearer was visible to the Hermes parent and readable by sibling subprocesses.
The pinned runtime has no per-server sandbox or opaque host-managed secret, so
the configured MCP server could not be made the actual capability boundary.

GitHub reads are interactive-only. Terminal subprocesses, sibling MCP servers,
the launchd gateway, and scheduled routines must not gain the capability merely
because they share a runtime home or descend from Hermes.

## Decision

June will expose the fixed `june_github` read toolset through a bundled
first-party Hermes backend extension and a Rust-owned Unix-domain **GitHub read
broker**.

The broker authorizes the exact interactive dashboard pid and runtime
generation using kernel peer credentials (`LOCAL_PEERPID` on macOS), consumes a
single connection admission, and serves bounded typed requests over that
persistent connection. The socket path is non-secret; no bearer, provider
credential, repository allowlist, or arbitrary route enters Hermes config or
the extension.

The extension is loaded only from June's verified pinned-runtime overlay.
`june_github` is explicitly selected only for an eligible interactive runtime,
is omitted when the user selects `no_mcp`, and is never included in cron or
routine toolsets. Platforms without an implemented and tested peer-process
identity primitive fail closed.

The old `/v1/github/read` bearer route and `june_github` MCP registration are
removed rather than retained as compatibility fallbacks.

The complete protocol, lifecycle, integrity, and verification contract lives
in [GitHub agent-read capability isolation design](../superpowers/specs/2026-07-17-github-agent-read-capability-isolation-design.md).

## Consequences

- Separate Hermes descendants cannot acquire GitHub read authority by reading
  shared config, environment, or files.
- The on-device Rust `GitHubReadService` remains the sole operation,
  repository, permission, revocation, provider, and response-policy boundary.
- The design is macOS-first and loses stock MCP portability in exchange for an
  enforceable interactive-only boundary.
- The bundled extension, broker framing, peer-pid behavior, and immutable
  extension origin become release and Hermes-pin compatibility gates.
- A user-enabled backend extension running in the same Hermes process remains
  same-trust code. The pinned runtime cannot isolate in-process extensions;
  June must document that limit or adopt an upstream process-isolation feature
  before claiming protection from hostile user extensions.
- No June API change or deployment is required.

## Alternatives considered

- **Keep the bearer in config or environment.** Rejected because Hermes and
  sibling processes can read it.
- **Move the bearer to a file, inherited descriptor, or nested sandbox.**
  Rejected because the parent receives or can read the authority, and inherited
  sandbox restrictions cannot be selectively relaxed.
- **Scrub config after launch.** Rejected because runtime discovery and
  reconnect reread shared config and introduce races.
- **Authorize only by loopback or socket path.** Rejected because another
  same-user process can connect.
- **Use a signed helper.** Rejected because code identity does not prove the
  authorized launch instance.
- **Disable GitHub agent reads.** Safe but rejects the approved product
  capability when the kernel can enforce a narrower boundary.

## 2026-07-17 addendum: Managed runtime admission

The verified extension requires the managed runtime that loads it to be part of
the same authenticated closure. Two implementation choices are therefore part
of this decision rather than incidental installer details.

First, the pinned upstream source does not ship the dashboard assets required
at runtime. June builds them only inside private staging with a checksum-pinned
Node.js archive and the source's pinned npm lockfile. It invokes the verified
Node program directly for dependency installation and the fixed TypeScript and
Vite entrypoints, disables lifecycle scripts, validates native package locks
and generated asset containment, and removes Node, `node_modules`, caches, and
build inputs before sealing. Trusting an ambient Node or npm installation was
rejected because it would place unauthenticated executable input inside the
runtime closure that receives broker authority.

Second, schema-2 admission is sticky for the app process. Once June admits a
managed runtime, or observes a valid schema-2 integrity record, a later stop,
failed repair, missing record, or legacy record cannot reopen fallback to an
unverified runtime. That can make recovery require a clean repair instead of a
transparent fallback, but it prevents a stop or partial repair from becoming a
downgrade path after stronger trust has been established.

The detailed contracts and verification evidence are indexed under the GitHub
agent-read capability isolation documents in [docs/index.md](../index.md).

## 2026-07-17 addendum: Hermes-writable code exclusion and stop ordering

Peer-pid admission cannot distinguish June's verified extension from other
Python code imported into the admitted dashboard process. Review found that
`$HERMES_HOME/plugins` is writable by the sandboxed Hermes runtime and that
Hermes has multiple user-plugin loaders, including lazy model and memory
provider paths.
Treating those files as "user-enabled" was therefore insufficient: Hermes
could persist and enable code itself, then have it execute inside a later
broker-authorized pid.

GitHub broker eligibility now requires an engaged macOS sandbox. The sandbox
denies both reads and writes beneath `$HERMES_HOME/plugins`, while the verified
`june_github` extension continues to load from the sealed runtime overlay.
Unrestricted sessions, the sandbox escape hatch, sandbox startup failures, and
unsupported platforms fail closed for GitHub agent reads. User plugins remain
available to unrestricted Hermes sessions, but those sessions receive no
GitHub broker authority. Any future host-approved in-process extension remains
same-trust code and must be included in the authenticated runtime closure or
isolated upstream before it can coexist with this capability.

Review also found that a start already waiting for the start-sequence lock
could capture stop epochs only after a successful stop and then create a new
authorized runtime. A start now captures its lifecycle epoch before waiting for
that lock, revalidates after acquiring it, and revalidates again under the
process-map lock before registration. A stop therefore cancels every launch
attempt already invoked when the stop linearizes.

## 2026-07-17 addendum: Process-identity lifetime

Peer pid authenticates the connecting process, but a numeric pid can be reused
after that process exits. Because the verified extension opens its one broker
connection lazily, an authorized dashboard could exit before consuming its
admission. Relying on a later bridge status or stop operation to notice that
exit left a stale-admission interval in which a reused pid could satisfy the
peer-pid comparison.

Admission now registers a macOS `EVFILT_PROC` exit monitor before it becomes
active. The kqueue filter is bound to the spawned process identity rather than
only its numeric pid. Registration fails closed if the process has already
exited, and the broker revokes the admission as soon as that exact process
exits, whether or not the extension connected and without waiting for another
bridge operation. An internal `EVFILT_USER` wakeup stops and joins the dedicated
monitor thread when the broker is explicitly revoked or dropped.

Eagerly opening the extension socket was rejected as the sole fix because a
successful client `connect` only queues the socket; it does not prove the broker
has consumed admission before the process can exit. Polling process existence
was also rejected because it cannot distinguish a reused pid from the original
spawned process.
