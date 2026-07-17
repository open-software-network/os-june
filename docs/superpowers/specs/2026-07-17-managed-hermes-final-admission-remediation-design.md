# Managed Hermes final admission remediation design

**Date:** 2026-07-17

**Scope:** Fourth security-review remediation for Task 4 GitHub capability
isolation. Task 5 broker wiring and Task 8 live qualification remain out of
scope.

## Goal

Make a fresh managed Unix install capable of starting the dashboard without
trusting an ambient Node installation, close remaining archive and admission
races, keep each dashboard and TUI start to one full managed-runtime digest,
and fail closed for every unrecognized integrity or fallback shape.

## Dashboard asset supply chain

The exact Hermes v0.17.0 source archive does not contain
`hermes_cli/web_dist`. No official standalone dashboard asset exists for the
v2026.6.19 GitHub release. The official PyPI 0.17.0 wheel was also checked by
its published SHA-256
`f11dcc1b168d2db626ef8b2175301741a86b5247c5ffaff4b0f0e24018d1b190`;
it contains no `hermes_cli/web_dist/` entries. June therefore must build the
dashboard, but only inside the already-private managed-runtime staging tree.

Node.js 24.18.0 LTS is pinned by exact immutable release URL and SHA-256 from
the official
`https://nodejs.org/download/release/v24.18.0/SHASUMS256.txt` manifest. The
supported managed Unix tuples are:

| Rust tuple | Node archive | SHA-256 |
| --- | --- | --- |
| `macos-aarch64-` | `node-v24.18.0-darwin-arm64.tar.gz` | `e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1` |
| `macos-x86_64-` | `node-v24.18.0-darwin-x64.tar.gz` | `dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080` |
| `linux-aarch64-gnu` | `node-v24.18.0-linux-arm64.tar.gz` | `6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508` |
| `linux-x86_64-gnu` | `node-v24.18.0-linux-x64.tar.gz` | `783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8` |

Musl, unknown libc, and unlisted tuples fail closed. Rust downloads, verifies,
validates, and extracts the selected Node archive using the same pure-Rust
archive boundary as the Hermes and uv archives. The three exact official Node
launcher symlinks (`bin/npm`, `bin/npx`, and `bin/corepack`) are admitted only
when both path and target match the pinned layout, and are ignored rather than
extracted; every other link remains forbidden.

Rust invokes npm as:

```text
<verified-node>/bin/node <verified-node>/lib/node_modules/npm/bin/npm-cli.js
  ci --ignore-scripts --no-audit --no-fund
```

It never executes npm's shebang, `npm run`, a package lifecycle script, or an
ambient executable. The command uses `env_clear`, an absolute program, a
minimal `PATH` rooted at the extracted Node `bin`, an isolated staging `HOME`,
cache, and empty user/global config files, the exact npm registry, strict TLS,
and explicit proxy, script, audit, fund, update-notifier, progress, and color
controls. The checksum-pinned Hermes root `package-lock.json` is the only
dependency resolution input.

Before npm runs, June parses the pinned root and web package manifests and the
lockfile. It requires the expected npm workspace, lockfile version, exact web
build script, and every supported tuple's locked esbuild, Rolldown, Tailwind
Oxide, and lightningcss native package with registry URL and integrity. The
build script is evidence only;
June does not execute it. After `npm ci`, Rust verifies the TypeScript and Vite
JavaScript entrypoints are regular files and invokes each directly with the
verified Node program from the `web` working directory. This reproduces
`tsc -b` followed by `vite build` without a shell or lifecycle hook. Any tuple
whose locked native packages cannot execute with scripts disabled fails
closed.

The generated `hermes_cli/web_dist` must be a no-link tree of regular files and
directories. `index.html` must be a nonempty regular UTF-8 file. Every local
`src` and `href` reference must lexically resolve to a regular file inside
`web_dist`; absolute URLs, protocol-relative URLs, backslashes, percent-encoded
separators, empty/repeated components, `.` and `..` are rejected. Referenced
CSS local URLs receive the same containment check. Before sealing, June removes
the extracted Node tree, `node_modules`, npm home/cache/config, and build
temporaries. Local fixtures independently exercise the production archive
extractors (including the official Node launcher-link policy), real asset
preparation and cleanup, seal, launcher resolution, and second preparation.
They do not claim to launch a packaged dashboard from official downloads. Live
official-archive qualification stays assigned to Task 8 after disk cleanup.

## Immutable archive admission

A bounded download produces `VerifiedArchive`, whose authenticated bytes are
owned immutably in memory after the SHA-256 comparison. Validation and
extraction each receive cursors over those same bytes; neither reopens a path.
Both passes independently enforce entry type, count, expanded-size, raw path,
top-level, duplicate/case-collision, and file-ancestor constraints. A shared
entry validator prevents the two readers from drifting.

Raw tar names are checked before `Path::components`, because that API erases
ambiguous syntax. Splitting the UTF-8 header bytes on `/` must yield only
nonempty components other than `.` and `..`; leading and repeated `/`, file
trailing `/`, and every backslash are rejected. One terminal separator is
admitted only for a directory header, as emitted by the official archives. A
mutation regression replaces or edits any
diagnostic archive pathname between validation and extraction and proves that
only the already-authenticated immutable bytes are extracted.

The archive reqwest client uses rustls, redirect denial, fixed HTTPS URLs,
bounds/timeouts, and `.no_proxy()` so ambient proxy variables cannot redirect
artifact traffic. A loopback behavioral test sets a poisoned proxy and proves
the client connects directly.

## One-digest final admission

For a current schema-2 runtime, command prediction and cheap availability read
only paths plus admitted record metadata. They do not hash the runtime.
Dashboard and TUI then use one shared final-admission helper under
`HermesBridge.start_lock`, after config/soul or sandbox preparation and before
spawn. That helper applies the canonical overlay, repairs when needed,
computes exactly one full base-tree digest for a current steady runtime, and
returns the admitted resolution. A fresh or legacy repair may necessarily
install and hash before config prediction so a permitted fallback can rerender
without GitHub. No later plugin check calls managed preparation again; the
byte-local pre-spawn check aborts if an eligible GitHub plugin changed.

The shared final-admission helper has an injected digest-counter test for the
dashboard and TUI cases, while a production-source order regression requires
both real start paths to call that helper after their preparation and before
spawn/launch. A separate source guard keeps the later byte-local plugin check
free of managed preparation. Together with the resolver's one-digest and cheap
availability tests, this enforces one steady digest and zero for availability
without requiring a mock Tauri `AppHandle` to execute a native spawn. Repair
may consume one digest before deciding to reinstall and one after the
replacement, but no steady path computes two.

## Fallback interpreter and schema policy

Fallback resolution starts from the selected user-local or PATH Hermes
executable. It follows a bounded symlink chain, rejects loops and non-regular or
non-executable endpoints, reads a bounded shebang, and resolves the shebang's
actual Python interpreter to an absolute executable. Pipx-style symlinks and
absolute Python shebangs are supported. A narrowly parsed `/usr/bin/env`
shebang resolves its Python name through the same explicit PATH lookup and then
stores the absolute result. Relative, malformed, shell, multi-command, missing,
and non-Python shebangs fail. No fallback returns the literal ambient command
`python3`.

Fixtures cover a direct console script, a pipx-style symlink chain, a controlled
`env python3` shebang, interpreter symlinks, missing execute bits, malformed
shebangs, and loops. Fallback remains categorically GitHub-ineligible and all
first-party configuration is regenerated with the resolved interpreter.

Fallback admission distinguishes integrity states explicitly:

- a missing record and the one admitted legacy schema 1 may fall back before
  any managed process is admitted;
- current schema 2 follows normal verification and never falls back after an
  integrity or critical-path failure;
- malformed JSON, missing or nonnumeric schema, schema 0, unknown/future
  schemas, and tampered records fail closed.

Managed admission is sticky in `HermesBridge` for the entire app lifetime.
Stopping or draining every runtime process does not reopen missing-record or
legacy fallback after any managed admission in that app process.

## Loader environment boundary

Before any bearer-bearing Hermes child starts, June removes `LD_PRELOAD`,
`LD_LIBRARY_PATH`, `LD_AUDIT`, and every inherited `DYLD_*` key in addition to
the existing Python startup controls. The dashboard command applies the scrub
directly. The generated TUI launcher enters an explicit empty environment and
adds back only its fixed runtime values, so Terminal cannot reintroduce loader
hooks. MCP children inherit the already-scrubbed Hermes environment. The
environment-cleared installer commands use the same policy.

Behavioral subprocess tests seed loader-hook sentinels and prove neither the
dashboard child nor the generated TUI invocation observes them.

## Documentation and verification

The previous startup design and plan are corrected to the implemented Python
contract: Hermes uses
`<python> -I -S -B -c <fixed bootstrap> ...`; the bootstrap temporarily removes
the dashboard bearer, calls authenticated `site.main()`, restores the bearer,
and runs `hermes_cli.main` with `runpy`. The 11 rendered first-party MCP
registrations cover ten distinct standard-library-only script files; earned
autonomy registrations reuse an authenticated action script.

Strict RED/GREEN covers every behavior above. Existing security, archive,
sandbox, manifest, plugin, source-assertion, formatting, clippy, and smoke gates
remain required. The implementation and report update are one separate commit
after this design checkpoint.
