# Troubleshooting

Failures that look like a bug in the repo and are not. Read this before
"fixing" a red gate, and add to it when a false alarm costs you an hour.

The rule of thumb: **a check that fails locally and passes in CI is usually
your machine, and a check that passes locally and fails in CI is usually you.**
Both halves matter; neither is an excuse to skip the failure.

## Frontend tests

### 3 storage tests fail locally: `font-scale`, `referral-nudge`

Symptom: `src/test/font-scale.test.ts` and `src/test/referral-nudge.test.ts`
fail (3 tests, storage related) on your machine while `main` is green in CI.

Cause: **Node 26 ships an experimental web-storage implementation and it
shadows jsdom's `localStorage`.** The tests mock jsdom's; Node's real one wins.
Nothing in the repo is broken.

Fix:

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm test
```

Check with `node --version`. CI pins an older Node, which is why it does not
see this. Do not "fix" the tests: you would be breaking them for CI to satisfy
your local Node.

### Vitest exits non-zero with zero real failures

`hud-meeting.test.ts` can produce teardown noise that sets a non-zero exit code
even when nothing failed. **Judge vitest by the failure count, not the exit
code.** Read the `Tests  N failed | M passed` line.

### `localsInner` crash in composer / ProseMirror tests

A `@tiptap/pm` duplicate-instance flake that shows up under machine load (for
example while other builds are running). Re-run the file on its own before
believing it:

```bash
pnpm vitest run src/test/agent-workspace.test.tsx -t "<the test name>"
```

If it passes in isolation, it is the flake, not a regression.

## Rust

### `cargo test --lib` says everything passes, CI still fails

`cargo test --lib` runs **only** the unit tests inside the crate. The
integration suites in `src-tauri/tests/*.rs` are separate test binaries; they
are CI-gated and invisible to `--lib`. Run `pnpm test:rust` (or `make
tauri-test`) before believing a Rust change is green.

### Narrow gates pass, `make verify` fails

`make verify` is the CI-parity gate and adds `cargo clippy --all-targets`,
which the narrower targets skip. Clippy failures are hard errors in CI. A
delegate reporting "all green" from `cargo test` + `pnpm test` has **not** run
what CI runs.

Always finish with:

```bash
make verify
```

### Sandbox / permission test failures in a restricted runner

A couple of macOS tests exercise the real Seatbelt sandbox and need a writable
temp dir and permission to spawn `sandbox-exec`. Inside a restricted agent
sandbox they fail for environmental reasons. `TMPDIR=/private/tmp` helps; if
they still fail, re-run them outside the restricted runner rather than
weakening the test.

### Swift link failure: `__swift_FORCE_LOAD_$_swiftCompatibility*` undefined

Crates that bridge Swift (e.g. `apple-metal` behind the computer-use driver)
derive their Swift library search path from `xcode-select -p` assuming full
Xcode's `Toolchains/XcodeDefault.xctoolchain` layout. When `xcode-select`
points at CommandLineTools that path does not exist, the Swift compatibility
archives never link, and `make tauri-test` / `make signoff-rust-macos` die at
link time. Fix per invocation, never by reconfiguring `xcode-select`:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer make signoff-rust-macos
```

### Clippy fails on code you did not touch after merging main

Before diagnosing your branch, check whether main itself is red: the macOS
clippy/tests job runs **post-merge** on main, so a PR that passed its gates
can still land dead code or lint failures that every branch inherits at the
next merge.

```bash
gh run list --branch main --workflow desktop.yml --limit 3
```

If main is red with the same error, fix it forward in your branch (your merge
then heals main) and say so in the PR; PR #744 inherited exactly this from a
gateway-lifecycle refactor's dead code.

### Release build fails at `beforeBundleCommand`, or bundles a stale helper

`--target universal-apple-darwin` is a pseudo-triple: cargo compiles each real
triple separately and **never** populates `target/universal-apple-darwin/`
with `[[bin]]` outputs (only the lipo'd main binary lands there). A bundle
hook that copies a helper binary must lipo the two real-triple outputs itself
and assert both architectures - falling through to bare `target/release/`
silently bundles a stale single-arch binary on runners with persistent target
dirs. `scripts/bundle-nm-shim.sh` is the reference implementation.

## pnpm

### pnpm refuses to run: "modules purge" / non-TTY

Some pnpm operations (notably a workspace build after a lockfile change) prompt
when they want to purge `node_modules`, and the prompt cannot be answered in a
non-TTY context (agents, CI-like shells). Prefix with `CI=true`:

```bash
CI=true pnpm extension:build
```

### The install hook blocks you

New package installs must go through Socket Firewall (`sfw`), enforced by a
PreToolUse hook. Use `sfw pnpm install ...`, and see
[spec/package-install-security.md](spec/package-install-security.md). The
7-day `minimumReleaseAge` cooldown may resolve an older version than you
expect; that is deliberate.

## Git and signing

### Commit fails: "agent refused operation" / push or fetch fails auth

1Password's SSH agent is locked or not running. It handles both commit signing
and SSH remotes, so the same lock breaks commits, pushes, and `git fetch`
(which can also surface as a review runner failing to resolve `origin/main`).

Unlock 1Password. If you must proceed without it, use a **per-invocation**
override and say so:

```bash
git -c commit.gpgsign=false commit -m "..."
```

Never reconfigure global git or ssh to work around it.

### A review runner aborts with "worktree changed"

The review harnesses read the tree read-only. If you commit while one is
running, it aborts. Let reviews finish before mutating the worktree.

## Shell wrappers

### A background gate "completed" but actually failed

Two wrapper shapes silently discard a command's exit code: piping the output
(`long-gate.sh | tail -5` reports the pipe's status) and following with any
command (`long-gate.sh; echo "exit: $?"` makes the wrapper itself exit 0).
Both burned a cycle each on PR #744 by reporting a failed signoff gate as
complete. Make the notification text the verdict instead:

```bash
long-gate.sh > gate.log 2>&1 && echo GATE_OK || echo GATE_FAILED
```
