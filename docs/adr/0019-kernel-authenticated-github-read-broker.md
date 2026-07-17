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
