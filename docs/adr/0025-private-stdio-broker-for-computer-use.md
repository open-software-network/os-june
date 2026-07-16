# Computer use runs through a private stdio driver broker

## Status

Accepted - 2026-07-15, JUN-278 / JUN-288 / JUN-293 / JUN-296.

## Context

June needs to operate a selected Mac app in the background while keeping the
user's real pointer, keyboard focus, and active Space available. The pinned
`cua-driver-rs` implementation provides the required background capture and
input paths, but its complete MCP surface also includes process launch,
termination, configuration, recording, replay, and update tools. Giving that
surface or its daemon socket directly to Hermes would let the runtime bypass
June's grant, sensitive-target policy, per-action approval cards, and emergency
stop.

The driver is also the process that macOS evaluates for Accessibility and
Screen Recording. A loose command-line binary or an upstream daemon identity
would make TCC attribution dependent on the terminal, development tool, or a
separately installed app. The shipped identity must instead be stable across
June updates and must be exercised as part of the signed release.

The obvious alternatives were:

1. Enable Hermes' upstream `computer_use` toolset and configure its driver
   socket. This is the shortest integration, but policy and approval would no
   longer be an app-owned structural boundary.
2. Expose the complete pinned driver as a June MCP server and rely on the model
   to call only approved tools. This reduces glue code but retains dangerous
   tools and makes approval prompt-level policy.
3. Install or update the driver at runtime. This follows the upstream setup,
   but adds an unpinned network installer and a second app identity outside the
   June release chain.
4. Bundle the driver and put a narrow Rust broker between it and Hermes. This
   costs a maintained adapter, but gives June one enforceable choke point.

## Decision

June uses option 4.

### Signed helper and provenance

- Release tooling compiles June's `june-computer-use-driver` binary against
  the exact `trycua/cua` Git commit in `src-tauri/cua-driver-pin.json`. It never
  downloads or exposes the upstream driver executable, installer, CLI, daemon,
  updater, or complete MCP registry.
- The June-owned helper links only the pinned macOS implementation and
  publishes an explicit allowlist of capture and input tools. Its source,
  `Cargo.toml`, and `Cargo.lock` are fingerprinted into the bundle stamp so a
  stale build cannot be reused after June changes the trust boundary.
- Universal release preparation compiles the arm64 and x86_64 Rust targets and
  merges them into `June Computer Use Driver.app`, with bundle identifier
  `co.opensoftware.june.computer-use-driver`.
- The nested app is signed with June's release identity before Tauri signs the
  outer app. Development builds use an ad-hoc signature.
- The source commit pin, SPDX SBOM, and upstream MIT notice ship inside the
  helper.
- Accessibility and Screen Recording attach to this helper identity. A live
  signed release fixture must prove both grants, capture, background input,
  unchanged frontmost app, and unchanged real pointer before an RC or stable
  macOS release can publish.

### Private driver transport

- Rust is the only production component allowed to launch the helper. It
  starts `june-computer-use-driver mcp` as a private stdio child and supplies a
  fresh 256-bit initialization capability that never reaches Hermes.
- The helper also verifies its direct parent. A development helper accepts only
  this checkout's `target/**/os-june`; a packaged helper accepts only the main
  executable in the containing `June.app`, after validating both app
  signatures, their fixed identifiers, and the same non-ad-hoc signing team.
  Copying the helper under a lookalike app is therefore not sufficient.
- No socket path, driver command, driver environment override, or direct
  driver toolset reaches Hermes.
- Proxy, driver override, updater, telemetry, and inherited CUA environment
  variables are removed before launch. The upstream network update path stays
  disabled.
- The public agent surface is one app-owned MCP server,
  `june_computer_use`, which forwards to an authenticated loopback route with a
  dedicated random token. Provider, recorder, and connector tokens cannot open
  that route.
- Hermes' upstream `browser` and `computer_use` toolsets stay disabled. The
  app-owned MCP server is enabled only when the June grant, Pro or Max plan,
  remote rollout decision, pinned helper, both TCC grants, and a vision-capable
  model are ready.
- The loopback capability is injected only into the visible chat dashboard,
  never the routine gateway. Each submitted visible turn also opens a unique
  in-process attended-run lease; terminal events, Stop, unmount, and revocation
  close it. Naming the MCP server in a routine cannot make it usable.
- Computer use is absent from routine toolsets. V1 is attended and macOS-only.

### Emergency rollout control

- June API serves the backward-compatible public
  `GET /v1/computer-use/rollout` decision. Operators can disable Computer use
  globally, for exact June/macOS versions, or for a trailing-wildcard version
  prefix without shipping another desktop build.
- The desktop sends its real app and macOS versions, caches successful
  decisions for five minutes, preserves a received disable through an outage,
  and fails closed briefly if no decision can be fetched.
- A transition from ready to disabled uses the same native stop path. Direct
  permission requests and direct broker actions recheck the decision, so the
  UI is not the enforcement boundary.

### Broker policy and approval binding

- The broker exposes only capture, app listing/selection, wait, and the narrow
  click, drag, scroll, text, key, and value operations June supports.
- Every operation that can change app state parks in Rust for a separate
  expiring `Allow once` or `Deny` decision. V1 has no approve-all, allow-always,
  or autonomous path.
- An approval is bound to a stable action id, exact process/window/app tuple,
  action summary, capture generation, and relevant capture reference.
- Immediately before execution, the broker lists windows again and privately
  recaptures the target. Element actions require the same accessibility role
  and label at the same numbered index. Coordinate and unscoped key actions
  require the same screenshot digest. Changed targets fail closed and must be
  captured again.
- June, terminals, security/privacy settings, keychains, password managers,
  credential and one-time-code fields, payment fields, destructive shell text,
  clipboard shortcuts, and destructive/system shortcuts are blocked in Rust.
- Stop, grant revocation, permission loss, shutdown, or driver failure kills
  the child, denies all parked actions, invalidates the current target, and
  removes task captures.
- App identity is bound by PID, window id, bundle identifier, and executable
  path. Sensitive-field detection considers the complete capped accessibility
  metadata, and text/value operations require an editable role.

## Consequences

- June maintains a small adapter for the pinned driver's schemas. A checked-in
  contract fixture and release handshake make schema drift a hard failure when
  the pin changes.
- Background behavior is safer than a direct runtime integration, but a driver
  or macOS update still requires a signed live test on the supported OS matrix.
- The helper is a new signed trust boundary and a new TCC identity. Support
  must distinguish the June grant from the two macOS grants.
- Capture data follows the selected model route. It is never telemetry. The
  local approval copy is private to the user, bounded to the latest capture,
  and removed on stop or shutdown.
- A release runner needs an interactive login and pre-granted TCC access for
  the stable helper identity. GitHub-hosted runners can verify packaging and
  schemas but cannot replace the live release gate.
- The signed app has one hidden release self-test mode. It is not a general
  proxy: it accepts only the bundled helper and only the two disposable fixture
  bundle identifiers. This lets the real signed June parent exercise TCC and
  background input without adding a production bypass.
