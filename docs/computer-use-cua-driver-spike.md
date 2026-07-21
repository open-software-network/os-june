# Computer use cua-driver sandbox spike (JUN-288)

A timeboxed spike answering one phase-2 question for **Computer use** (see
[browser-computer-use-prd.md](browser-computer-use-prd.md) "Computer use (phase
2)" and [ADR-0017](adr/0017-browser-use-via-june-extension.md)): when June
bundles a pinned, signed **cua-driver** as an app resource, do the driver's
private-interface lookups work under the app's Seatbelt profile, or must the
Rust broker run it outside the write jail, as the **dictation helper**
effectively is? This note records the answer, the evidence, and the recommended
spawn topology. It is a findings note, not a build.

## Answer

Run the driver outside the write jail - as the recommended topology, not
because Seatbelt was shown to make in-jail operation impossible. What the
experiments show: under June's `(allow default)` profile, a public-API probe
confirms the window-server and accessibility connection mechanism the driver's
private SPIs ride on is reachable in-jail, and the driver daemon itself starts
in-jail once its socket and home are relocated into write roots, stopping only
at its own TCC permissions gate. The private calls themselves
(`SLEventPostToPid`, AX mutation, ScreenCaptureKit capture) were not exercised
- they sit behind TCC grants only a human can set - so the full in-jail action
path remains unverified pending that end-to-end run. On the default paths,
without relocation, the daemon's state writes (`~/Library/Caches/cua-driver/`,
`~/.cua-driver/`) are denied by the write jail. The recommendation therefore
rests on identity and lifecycle, not on a hard denial: cua-driver's own design
is that `cua-driver mcp` is a thin client proxying to a `CuaDriver.app` daemon
launched through LaunchServices "so TCC grants attach to the bundle", and an
in-jail daemon would run under an unresolved TCC identity while June tracks
driver-internal paths across versions. The recommended topology matches the
dictation-helper precedent: the Rust broker owns a June-bundled,
separately-signed driver daemon that runs outside the jail with its own stable
code identity, and the in-jail runtime's stdio client proxies to it over a
June-controlled socket, reached through a June wrapper command because the
pinned runtime passes no socket argument and the driver has no socket env
(jailed `connect()` to the daemon verified). Version pinning is a bundled app
resource plus a binary-path override pointing at the wrapper; the upstream
network installer never runs because nothing in June's spawn path invokes it.

One constraint falls straight out of that verified jailed `connect()`, and it
gates the phase-2 design: because the jail does not govern socket connects, the
agent runtime can reach the privileged daemon's socket directly, so June's
approval boundary cannot live at the runtime's tool-dispatch layer. It has to be
a broker-owned, approval-enforcing transport between the runtime and the daemon,
per ADR 0017's broker-choke-point principle. See "The approval boundary cannot be
the tool-dispatch layer" below.

## What the driver is (provenance and pin)

The pinned Hermes runtime (`HERMES_AGENT_INSTALL_COMMIT`
`2bd1977d8fad185c9b4be47884f7e87f1add0ce3`, tag v2026.6.19) drives computer use
through the upstream `cua-driver` from `trycua/cua`. The Hermes backend pins the
driver at `0.5.0` by default (`PINNED_CUA_DRIVER_VERSION` in
`tools/computer_use/cua_backend.py`, overridable via `HERMES_CUA_DRIVER_VERSION`).

Provenance of the artifact read and inspected for this spike (fetched directly,
not through any installer):

- Hermes source tarball:
  `https://github.com/NousResearch/hermes-agent/archive/2bd1977d8fad185c9b4be47884f7e87f1add0ce3.tar.gz`,
  sha256 `7a9bd367066183898831c2760f269368ab54b458a1d1b51d14ef1f484dd490cc`
  (matches `HERMES_SOURCE_TARBALL_SHA256`).
- Driver release artifact:
  `https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.5.0/cua-driver-rs-0.5.0-darwin-universal.tar.gz`,
  sha256 `dc9ad275b712ab6893d88dec4399c0294b12714730c4fdba47109eef004fbbc7`.
  Tag `cua-driver-rs-v0.5.0` confirmed present on the release repo.

The artifact is a universal `CuaDriver.app` bundle:

- `codesign` identity `com.trycua.driver`, authority "Developer ID Application:
  Cua AI, Inc. (YCK386LBJ7)", hardened runtime, both `x86_64` and `arm64`.
- `LSUIElement` true (background agent), `LSMinimumSystemVersion` 13.0, no TCC
  usage strings in the Info.plist (Accessibility and screen recording do not
  require them).
- `otool -L` links `ApplicationServices`, `CoreGraphics`, `ScreenCaptureKit`,
  `CoreMedia`, `CoreVideo`, `IOSurface`, `Metal`, `AppKit`.
- The private interfaces are resolved at runtime, not statically linked. Strings
  in the binary include `SLEventPostToPid` and `_SLPSGetFrontProcess` from
  `/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight`, plus
  `CGEventPostToPid` ("delivered to the target pid ... No focus steal") and the
  accessibility calls `AXUIElementPerformAction` and
  `AXUIElementSetAttributeValue`. Capture is through ScreenCaptureKit. These are
  the background-control primitives ADR-0017 relies on (events posted to the
  target process, no cursor, focus, or Space theft).

## How the runtime launches the driver

`tools/computer_use/cua_backend.py` is the default backend. It speaks MCP over
stdio to a child process it spawns itself:

- Command: `HERMES_CUA_DRIVER_CMD` (default `cua-driver`), resolved with
  `shutil.which`, which also accepts an absolute path.
- Args: `["mcp"]` (stdio MCP transport). Backend selection is
  `HERMES_COMPUTER_USE_BACKEND` (default `cua`).
- The stdio child is launched through the Python MCP SDK's `stdio_client`, so it
  is a descendant of the runtime process and inherits whatever spawn context the
  runtime has, including the Seatbelt profile.

At the pin, the backend has no attach-to-a-running-driver transport: it always
spawns `cua-driver mcp` as a stdio child. That matters for topology (below): the
runtime, not June's broker, owns the stdio client process.

But the driver's own design splits work across two processes. Per the binary's
`--help` and strings, `cua-driver mcp` on macOS is a thin client that
auto-launches and proxies to a persistent `CuaDriver.app` daemon (the proxy path
is "the path you actually run"), and the daemon is what holds recording state,
element-index caches, and the privileged system connections. The relevant
subcommands and knobs:

- `serve` / `stop` / `status`: explicit daemon lifecycle.
- `mcp --socket <path>` (also the daemon side): override the daemon Unix-domain
  socket path used by the proxy. CLI flag only - the driver reads no socket env
  var (none in `cli.rs` at the tag, none in the binary's env string table), and
  the pinned backend spawns the client with fixed args `["mcp"]`, so a custom
  socket cannot be injected through env alone. June needs a wrapper command
  (see topology step 3).
- `mcp --no-daemon-relaunch` (`CUA_DRIVER_RS_MCP_NO_RELAUNCH=1`): stay
  in-process; the daemon is bypassed entirely.
- `CUA_DRIVER_RS_MCP_FORCE_PROXY=1`: always proxy to a daemon. With a daemon
  already listening on the target socket the client proxies straight to it; with
  none it fails fast ("FORCE_PROXY=1 but no daemon listening on ...") instead of
  auto-launching or falling back in-process.
- Proxy-vs-in-process precedence, verified in `should_use_daemon_proxy`
  (`cli.rs` at tag `cua-driver-rs-v0.5.0`): `--no-daemon-relaunch` /
  `NO_RELAUNCH` is checked first and forces in-process; `FORCE_PROXY` is checked
  second. Setting both selects in-process execution, so the two must never be
  combined. With neither set, the client proxies only when its resolved
  executable path contains the hardcoded string `/CuaDriver.app/Contents/MacOS/`
  (`bundle.rs`); a bare or renamed binary silently runs in-process (the
  dangerous fallback), and a passing detection with no daemon listening
  auto-launches by app name via `open -n -g -a CuaDriver`.
- `CUA_DRIVER_RS_HOME`: relocate `~/.cua-driver`.
- `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`, `CUA_DRIVER_RS_UPDATE_CHECK=0`: disable
  the driver's telemetry (posts to a third-party analytics host) and its GitHub
  update check.
- `permissions grant`: "Launch CuaDriver via LaunchServices so the permission
  dialog attributes to com.trycua.driver (not your terminal), wait for the
  grant, then confirm the driver's own status." `permissions status` is
  read-only and answers via the running daemon so the result carries the
  bundle identity, or `unknown` when no daemon is running.

## Version pinning and keeping the installer from running

Confirmed. June bundles `CuaDriver.app` 0.5.0 as an app resource and points the
runtime at the bundled inner executable with `HERMES_CUA_DRIVER_CMD` (absolute
path) plus `HERMES_CUA_DRIVER_VERSION=0.5.0`. With that set,
`cua_driver_binary_available()` (which is `shutil.which(HERMES_CUA_DRIVER_CMD)`)
returns the bundled path and `check_computer_use_requirements()` returns true, so
the runtime never reaches an install path.

There is no network fetch on the runtime path. When the driver is missing, the
backend only raises a hint string; it does not install. The upstream network
installer (`/bin/bash -c "$(curl -fsSL .../libs/cua-driver/scripts/install.sh)"`,
which delegates to a Rust installer that downloads a release into
`~/.local/bin` and `~/.cua-driver`) is reachable only through the Hermes CLI:
`hermes tools` (the interactive toolset-enable wizard),
`hermes computer-use install`, and `hermes update`
(`_run_cua_driver_installer` in `hermes_cli/tools_config.py`). June never invokes
those. June enables toolsets by writing config.yaml directly (`sync_hermes_config`
/ `render_hermes_config`), not through the wizard. The driver binary itself also
has an `update --apply` subcommand that runs "the canonical installer"; June
must never call it, and should set `CUA_DRIVER_RS_UPDATE_CHECK=0` so the driver
does not even phone home to check.

One gap worth flagging: the Hermes-layer `HERMES_CUA_DRIVER_VERSION` pin does not
flow into the upstream installer (the installer keys on `CUA_DRIVER_RS_VERSION`
and otherwise pulls latest). This is another reason June must bundle a fixed
artifact rather than lean on any install step to honor the pin.

## Does it work under the write jail

June wraps sandboxed spawns in `/usr/bin/sandbox-exec -f <profile>`, where the
profile from `build_sandbox_profile()` is `(allow default)` plus a
`(deny file-write*)` write jail re-granting only `sandbox_write_roots()`
(HERMES_HOME, the managed runtime dir, `/private/tmp`, `/private/var/tmp`,
`$TMPDIR`) plus a secret-read denylist. The profile does not deny mach lookups
or any window-server or accessibility interface.

### The connection mechanism is reachable in-jail (public-API probe)

A small Swift probe was compiled and run bare, then under a faithful replica of
the generated profile (same shape and write roots as `build_sandbox_profile()`,
validated by the kernel via `sandbox-exec`). The probe calls only public APIs:
`CGMainDisplayID` and `CGDisplayPixelsWide/High` (needs a window-server
connection), `CGWindowListCopyWindowInfo` (needs a window-server connection),
and the prompt-free TCC status calls `AXIsProcessTrusted` and
`CGPreflightScreenCaptureAccess`. It does not resolve or invoke the private
SPIs themselves (`SLEventPostToPid`, `_SLPSGetFrontProcess`), perform an AX
mutation, capture via ScreenCaptureKit, or run the driver's action path.

Bare and jailed produced identical output:

```
DISPLAY did=24 3008x1612
WINDOWLIST count=40
AX_TRUSTED=false
SCREEN_PREFLIGHT=false
PROBE_DONE
```

Two conclusions, stated at the strength the evidence supports. First, the write
jail does not block the window-server or accessibility connection mechanism the
driver's private SPIs ride on; the connection paths work in-jail. Whether the
private calls themselves behave identically in-jail was not exercised and
remains unverified until the TCC-blocked end-to-end run (see Blocked). Second,
Seatbelt and TCC are orthogonal at the status level: the jail neither grants
nor removes an Accessibility or screen-recording grant, and a fresh unbundled
binary starts with neither (hence the `false` values), which is exactly why the
driver needs a stable, separately-signed code identity plus a human grant.

### The write jail blocks the driver's default-path state

Under the same profile, writes inside a write root succeed and the driver's
default runtime paths are denied:

```
# inside HERMES_HOME (a write root)
WROTE_HERMES_HOME_OK

# ~/Library/Caches/cua-driver/ (the daemon's default socket + pid dir)
mkdir: /Users/<user>/Library/Caches/cua-driver: Operation not permitted
DENIED_CACHE

# ~/.cua-driver/config.json (the driver's default config home)
mkdir: /Users/<user>/.cua-driver: Operation not permitted
DENIED_DOTHOME
```

Strings in the driver confirm these are load-bearing on the default paths: the
daemon binds a single-instance Unix-domain socket at
`~/Library/Caches/cua-driver/cua-driver.sock` with a `cua-driver.pid` lock, and
persists configuration to `~/.cua-driver/config.json` (plus `.telemetry_id`,
`.installation_recorded`, and an update-check cache under `~/.cua-driver-rs/`).
So a driver launched as a child of the in-jail runtime with no relocation
cannot create its state and will not come up. Both paths are relocatable
(`--socket`, `CUA_DRIVER_RS_HOME`), which the next experiment exercises.

### With full relocation the daemon starts in-jail, up to the TCC gate

To test whether the denials above are actually unavoidable, the bundled binary
was started under the same profile replica with everything relocated into write
roots: `CUA_DRIVER_RS_HOME=<HERMES_HOME subdir>`,
`serve --socket /private/tmp/june-cua-spike.sock` (a June write root),
`CUA_DRIVER_RS_TELEMETRY_ENABLED=0`, `CUA_DRIVER_RS_UPDATE_CHECK=0`.

Result: the daemon starts inside the jail. It bound the relocated socket
(`Cua Driver daemon listening on /private/tmp/june-cua-spike.sock`), left the
default `~/Library/Caches/cua-driver/` untouched, answered
`status --socket` with "daemon is running", and produced zero Sandbox-log
violations (`log show --predicate 'sender == "Sandbox"'`). It then blocked at
its own startup permissions gate, waiting for Accessibility and Screen
Recording grants ("cua-driver needs your permission before `serve` can start
... still waiting on: Accessibility, Screen Recording"); the gate is skippable
with `CUA_DRIVER_RS_PERMISSIONS_GATE=0`, but proceeding past it without grants
was out of the spike's scope. No capture or action was attempted.

Two practical constraints surfaced. The socket path must fit the Unix-domain
`SUN_LEN` limit (about 104 bytes): a deep scratch path failed with
`bind ...: path must be shorter than SUN_LEN`, so June must pick a short
socket path. And an invocation without the relocation env writes
`~/.cua-driver/.telemetry_id` on the spot (observed from an unjailed client
run), so every June-owned invocation - client and daemon - needs the
relocation and disable env applied consistently.

Net: in-jail operation is not hard-blocked at the process-start level; it is
possible with full relocation. The case for out-of-jail is made on other
grounds in the topology section.

## Recommended spawn topology

The broker spawns a June-bundled, separately-signed driver bundle directly,
dictation-helper style, and keeps it out of the write jail; the in-jail runtime
talks to it as a proxy client. This is a recommendation, not a necessity - the
relocation experiment shows an in-jail daemon can start - and it is preferred
because it matches the existing out-of-jail precedents (the dictation helper,
the launchd-spawned Hermes gateway process), gives the daemon a stable bundle
identity for TCC attribution instead of an unresolved in-jail identity, puts
daemon lifecycle in the broker's hands independent of per-session runtime
spawns, and avoids June tracking driver-internal state paths across driver
versions. Concretely:

1. Bundle `CuaDriver.app` 0.5.0 as an app resource and re-sign it under June's
   Developer ID and a June bundle id (for example `co.opensoftware.june.cua-driver`),
   exactly as `build.rs` builds and `sign_helper_app()` signs the dictation
   helper (`co.opensoftware.june.dictation-helper`). This gives the daemon a
   stable, auditable designated requirement, expected to make its Accessibility
   and screen recording grants survive app updates and attribute to a
   June-controlled identity rather than the runtime or a third-party signature;
   verifying that grants actually persist across two June-signed driver
   versions is an open question below.
2. The Rust broker (the unsandboxed host, the same layer that already spawns the
   dictation helper via `spawn_helper()` and the Hermes gateway process via
   `build_hermes_gateway_start_command`, both deliberately outside the Seatbelt
   wrapper) starts the driver daemon directly, for example
   `cua-driver serve --socket <june-controlled path>`, or through LaunchServices.
   Because the daemon is a child of the broker (launchd), not of the
   `sandbox-exec` runtime, it runs outside the write jail with full access to
   its own state dirs, and holds the privileged window-server, accessibility, and
   screen-capture connections under its own bundle identity.

   Env-hygiene invariant, both paths: every June-originated driver invocation -
   this broker-started daemon exactly like the jailed client below - starts
   from a cleared `CUA_DRIVER_RS_*` namespace and sets only the approved
   variables (`CUA_DRIVER_RS_HOME=<June-controlled path>`,
   `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`, `CUA_DRIVER_RS_UPDATE_CHECK=0`, plus
   the client-side proxy vars in step 3). Inherited values must never reach
   the privileged process: they could re-enable telemetry or update checks,
   redirect driver state, or skip its permissions gate, and future upstream
   additions to the namespace inherit the same protection. The JUN-293 build
   should carry regression tests that preload hostile `CUA_DRIVER_RS_*` values
   before constructing BOTH the daemon command and the client wrapper env and
   prove they are stripped.

   The same hygiene applies one level up, to the runtime's own backend
   selector. `HERMES_COMPUTER_USE_BACKEND` chooses which computer-use backend
   the runtime loads (`cua` is the default). June must set it explicitly for
   computer-use-enabled spawns rather than inherit whatever is in the
   environment, in `apply_isolated_hermes_env()` alongside the other `HERMES_*`
   variables, so an inherited value cannot select a different backend and route
   around the wrapper and proxy invariant entirely. An external review round
   reported that a `noop` backend exists at the pin which reports actions as
   successful without contacting the driver at all; whether or not that specific
   backend exists, pinning the selector rather than inheriting it is the correct
   default, and JUN-293 should confirm the available backends at the pin and
   include the selector in the hostile-preload coverage.
3. The in-jail runtime keeps spawning its stdio client as upstream does, but
   `HERMES_CUA_DRIVER_CMD` points at a small June-bundled wrapper, not at the
   driver binary directly. The wrapper is needed because the pinned backend
   passes fixed args `["mcp"]` and the socket is a CLI-only flag: the wrapper
   execs the bundled driver with `mcp --socket <June-controlled path>` appended,
   and pins the driver env itself (`CUA_DRIVER_RS_HOME=<write-root path>`,
   `CUA_DRIVER_RS_MCP_FORCE_PROXY=1`, `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`,
   `CUA_DRIVER_RS_UPDATE_CHECK=0`) so the recipe does not depend on Hermes
   passing anything through. `FORCE_PROXY` is the load-bearing guard here:
   without it a re-signed or renamed bundle fails the hardcoded
   `/CuaDriver.app/Contents/MacOS/` detection and the client silently runs the
   privileged work in-process inside the jail; with it, the client proxies to
   the broker's pre-started daemon and hard-fails if the daemon is absent
   (surfacing a broker bug instead of degrading). `CUA_DRIVER_RS_MCP_NO_RELAUNCH`
   must not be set: the driver checks it before `FORCE_PROXY`, so combining them
   selects in-process execution. "Must not be set" has to be enforced, not
   assumed - an inherited `CUA_DRIVER_RS_MCP_NO_RELAUNCH=1` from the user's
   environment would silently defeat the guard, so the wrapper explicitly
   unsets it (and the whole `CUA_DRIVER_RS_*` namespace it does not
   deliberately set) before exec, `apply_isolated_hermes_env()` strips it from
   the runtime spawn env, and the JUN-293 build should carry a regression test
   that starts with the variable pre-set and proves the client still proxies.
   Because the broker pre-starts the daemon, the
   client's auto-launch path never runs. The jailed client does no privileged
   work; it relays to the daemon. (A jailed client's `connect()` was verified
   against a broker-started daemon: `status --socket` answered "daemon is
   running" from inside the profile replica, both for a socket inside a write
   root and for one outside the write roots - the write jail governs file
   writes, not unix-socket connects, under this profile shape.)
4. Injection point: extend `apply_isolated_hermes_env()` (and the isolated-env
   allowlist) to set `HERMES_CUA_DRIVER_CMD=<wrapper path>` and
   `HERMES_CUA_DRIVER_VERSION` for computer-use-enabled spawns, and add a
   `computer_use` block to `render_hermes_config()`. The driver-specific env
   lives in the wrapper (step 3), not in the Hermes spawn env.

This keeps the agent runtime itself under the write jail. The one privileged
process (the daemon) is out of the jail by construction, with a bounded,
auditable trust surface, which is the same trade already accepted for the
dictation helper and the Hermes gateway process.

### The approval boundary cannot be the tool-dispatch layer (gates JUN-293)

The topology above hands the agent runtime a working connection to the
privileged daemon's socket, and this spike verified that the write jail does
not govern unix-socket `connect()`. June's action approvals, however, are
planned at the runtime's `computer_use` tool-dispatch layer (approval cards).
Those two facts do not compose: an approval gate that sits at the tool-dispatch
layer holds only while the runtime routes its privileged work through that
layer, and the runtime is the model-controlled process. That is precisely the
arrangement ADR 0017 rules out - "policy decisions are made in Rust at the
broker choke point, never by prompting the model" (the connectors precedent).

So the enforcement point must be structural, and it must sit between the
runtime and the daemon:

- JUN-293 must not treat the runtime's tool dispatch as the approval boundary.
  The broker owns the boundary: the runtime reaches the daemon only through a
  broker-owned, approval-enforcing transport, and the real daemon socket is not
  independently reachable from the jailed runtime.
- Making it unreachable needs an actual mechanism. Socket placement is not one:
  the jail's file-write rules do not stop a connect, as verified above. The
  candidates are a sandbox rule that denies the runtime the connect, a socket in
  a namespace the jailed process cannot name, or broker-mediated descriptor
  passing so the runtime never holds the daemon endpoint at all. Determining
  which of these actually holds under the app's profile is an open question that
  gates the JUN-293 design, not an implementation detail.
- The daemon's own socket authentication model at the pin (does it authenticate
  or validate its peer at all, and if it does, where would that credential live
  such that the jailed runtime cannot read it?) must be established and recorded
  before the topology is relied on. This spike did not establish it. An external
  review round reported the pinned daemon accepts unauthenticated requests on
  that socket; that report is unverified here and is exactly what JUN-293 must
  confirm at the pin, because the answer decides whether socket-level trust can
  carry any weight or none.
- Regression coverage to carry: a client running under the runtime's own sandbox
  profile cannot get a mutating action executed by the daemon except through the
  broker's approval-enforcing path.

This does not change the recommended out-of-jail topology, which stands on
identity, lifecycle, and precedent. It constrains how the runtime is allowed to
reach it.

### Alternative if the daemon is ever kept in-jail

The relocation experiment shows this is viable at the start level with no
profile widening at all: `--socket <short write-root path>` plus
`CUA_DRIVER_RS_HOME=<write-root path>` (and the telemetry and update-check
disables) let the daemon come up entirely inside the existing write roots -
no new grants needed. What this path leaves unresolved: the TCC identity of a
jailed daemon spawned under the runtime (a bare executable under
`sandbox-exec`, no bundle of its own, so grants would attach to whatever
responsible-process identity macOS assigns), whether the private SPI calls and
capture behave in-jail past the permissions gate (unverified, TCC-blocked),
the `SUN_LEN` limit on the socket path, and the burden of tracking every
driver-internal write path across driver versions. Those are the reasons the
out-of-jail daemon is preferred, not a Seatbelt denial.

## TCC (Accessibility and screen recording)

TCC, not Seatbelt, is the real gate on computer use: the probe shows the jail
does not change TCC status, and the in-jail daemon stops at the driver's own
permissions gate, not at a sandbox denial. The driver needs two grants: Accessibility (for AX posting and the private
SkyLight event SPIs) and screen recording (for ScreenCaptureKit capture). These
attach to the daemon's bundle identity, which is why the separately-signed
bundle matters. Onboarding follows the dictation-helper pattern the PRD already
names: a bundle-scoped, prompting grant with polled re-checks. The driver's own
`permissions grant` (LaunchServices launch so the dialog attributes to the
bundle) and `permissions status` (read-only, daemon-attributed, `unknown` when no
daemon) map directly onto that flow.

## Blocked

- End-to-end capture and click against a scratch target was not exercised.
  Driving the daemon requires live Accessibility and screen-recording grants for
  the driver bundle, which can only be granted by a human in System Settings (or
  via `cua-driver permissions grant`, which opens a GUI dialog). Per the spike's
  safety rules, no TCC database edit or bypass was attempted. The mechanism was
  verified up to that boundary: the window-server and accessibility connection
  paths work in-jail, and TCC status is readable without prompting. Human steps
  to unblock a future end-to-end run: launch the June-signed driver bundle, then
  in System Settings under Privacy and Security enable the bundle under
  Accessibility and under Screen Recording (or run `cua-driver permissions grant`
  and approve the dialog), then re-check with `cua-driver permissions status`.

## Open questions for phase-2 planning

- Socket reachability from inside the jail: answered for the control path. A
  jailed `status --socket` client connected to a broker-started daemon and got
  "daemon is running", with the socket both inside and outside the write roots;
  keep the path under the `SUN_LEN` limit. Still open: exercising the actual
  `mcp` proxy stream end to end through the wrapper, and settling whether
  residual client-side writes (the telemetry id was observed written on a plain
  invocation) are fully covered by the wrapper's `CUA_DRIVER_RS_HOME` plus the
  disable env.
- Daemon lifecycle and reuse: one daemon per machine (single-instance socket) or
  one per session, and how the broker supervises it (start, health, stop on
  revoke), including whether `serve` or a LaunchServices launch is the cleaner
  owner. The runtime's mode split (sandboxed vs unrestricted, one gateway per
  mode) suggests computer use should also be a distinct, consent-gated spawn.
- Re-signing and notarization: whether re-signing the third-party bundle under
  June's identity (changing its designated requirement) is enough for stable TCC,
  and how the release self-test the PRD calls for starts the bundled daemon and
  probes `permissions status` and a capture on a macOS bump.
- Provider vision path: the toolset hard-requires a vision-capable model; wire
  the availability gate and the switch-model notice to the same capability source
  as the rest of the app.
- Approval surface: route the toolset's mutating actions
  (`click`, `type`, `scroll`, `drag`, `key`, `set_value`, `focus_app`) through
  June's existing tool-approval infra as chat approval cards, since the backend
  defaults to allow when no CLI approval callback is wired.
- Pin hygiene: the Hermes `HERMES_CUA_DRIVER_VERSION` does not drive the upstream
  installer, so the pin lives entirely in the bundled artifact; fold a driver
  sha256 check into the bundling step and the Hermes upgrade checklist.
