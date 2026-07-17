# Managed Hermes trust remediation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Authenticate the complete GitHub-capable Hermes execution closure,
close the macOS hard-link bypass, reseal canonical overlays without reinstall,
bound full-tree verification cost, serialize all preparation, and recover
Windows atomic replacement failures without losing the trusted destination.

**Architecture:** Schema 2 separates one normalized base-tree digest from exact
app-owned overlay hashes. A shared preparation lock applies canonical overlay
bytes and performs one steady-state full verification immediately before
execution. Managed Unix uses a pinned uv bootstrap, in-tree CPython, and locked
dependencies; Windows GitHub eligibility is compile-time disabled until its
managed installer reaches the same posture.

**Tech stack:** Rust stable, Tokio, Tauri v2, macOS Seatbelt SBPL,
PowerShell/bourne-shell bundlers, SHA-256, Win32 `ReplaceFileW`.

## Global constraints

- Preserve the original Task 4 contract and every earlier regression.
- No Task 5 broker wiring.
- Use strict RED/GREEN TDD for production behavior.
- Use `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0` for Cargo test/check/clippy.
- Integrity exclusions are exact files only; every excluded file is separately
  authenticated against embedded bytes.
- Unsupported installer platforms and every ambiguous recovery state fail
  closed.
- Do not push.

---

### Task 1: Deny hard links in the macOS jail

**Files:**
- Modify: `src-tauri/src/hermes_bridge.rs`

**Interfaces:**
- Consumes: `build_sandbox_profile`, `prepare_sandbox`,
  `sandbox_write_roots_with_tmpdir`.
- Produces: a profile containing global `(deny file-link)` and protected paths
  containing the runtime, external integrity record, and resource root.

- [x] **Step 1: Write failing tests**

Add a static profile assertion and extend
`sandbox_generated_profile_is_enforced_by_the_kernel` to seed a loader and
external seal, run `ln <source> <HERMES_HOME alias>` inside `sandbox-exec`, then
attempt overwrite and assert both sources remain unchanged.

- [x] **Step 2: Run RED**

```bash
CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml sandbox_ -- --nocapture
```

Expected: hard-link assertions fail because the current profile has no
`file-link` deny and the kernel permits the alias creation.

- [x] **Step 3: Implement the minimal profile change**

Emit `(deny file-link)` immediately after `(allow default)` with no matching
allow. Add `managed_hermes_integrity_path(app)` to the protected path vector.

- [x] **Step 4: Run GREEN**

Run the Task 1 RED command. Expected: all non-ignored sandbox tests pass and
the two kernel `ln` probes are denied.

### Task 2: Authenticate the managed interpreter and locked dependencies

**Files:**
- Modify: `src-tauri/src/hermes_bridge.rs`
- Modify: `scripts/bundle-hermes-runtime.sh`
- Modify: `scripts/bundle-hermes-runtime-windows.ps1`

**Interfaces:**
- Produces: `HermesCommandResolution { command, python_command, source }`,
  in-tree managed launcher/interpreter helpers, and a platform-selected pinned
  uv artifact tuple `(url, sha256, archive_dir)`.
- Consumes: official uv 0.11.15 `sha256.sum`, Hermes source pin and `uv.lock`.

- [x] **Step 1: Write failing closure tests**

Add tests that a managed runtime with an absolute external Python symlink or an
escaping relative symlink cannot be sealed/current, that internal interpreter
and stdlib tampering invalidates the record, and that bundled/managed command
resolution supplies the internal Python path used by MCP registrations.

Add source assertions that these strings are absent from privileged installers
and bundlers: `uv pip install -e .[all]`, `pip install --upgrade`, and the Unix
fallback log text.

- [x] **Step 2: Run RED**

```bash
CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml github_plugin -- --nocapture
```

Expected: missing `python_command`/pinned-bootstrap helpers and escaping
symlink acceptance fail.

- [x] **Step 3: Implement the authenticated closure**

Pin uv 0.11.15 artifact URL/SHA tuples for supported OS/architectures only.
The Unix script downloads and verifies that archive, installs CPython 3.11
under `hermes-runtime/python/current`, and runs only:

```text
uv sync --extra all --locked --python <in-tree-python>
```

Create an in-tree launcher that invokes `python -m hermes_cli.main`; route all
June MCPs through `python_command`. Reject any symlink/reparse whose fully
resolved target escapes the runtime. Remove unlocked fallbacks from both
bundlers. Make Windows managed GitHub eligibility compile-time false.

- [x] **Step 4: Run GREEN**

Run the Task 2 RED command plus:

```bash
bash -n scripts/bundle-hermes-runtime.sh
```

Expected: closure tests pass and the shell bundler parses.

### Task 3: Add schema 2 overlay-aware integrity and bounded hashing

**Files:**
- Modify: `src-tauri/src/hermes_bridge.rs`

**Interfaces:**
- Produces: schema-2 record with `base_tree_sha256` and exact overlay hashes,
  `managed_runtime_base_tree_digest`, cheap metadata availability, and a
  dependency-injected digest counter seam.
- Consumes: exact embedded GitHub plugin and `sitecustomize.py` bytes.

- [x] **Step 1: Write failing integrity/cost tests**

Add an old-overlay/new-app-overlay resolver test that seals the old exact
overlay identity, changes expected overlay bytes through an injected overlay,
resolves successfully with zero installer calls, and leaves a current record.
Add digest counters asserting zero calls for auto availability, one for a
current explicit preparation, and at most two for tamper repair. Preserve the
existing tampered-loader reinstall test.

- [x] **Step 2: Run RED**

Run the focused `github_plugin` Cargo test. Expected: whole-tree schema 1 forces
install or performs multiple digest calls.

- [x] **Step 3: Implement exact normalized hashing**

Exclude only the three exact canonical overlay paths from the base digest.
Validate their bytes/types separately. Apply overlay before verification; when
only overlay hashes change, atomically update the record without installer.
Move the single steady digest to final preparation immediately before spawn.
Make auto availability parse only record/pin metadata and check plain paths.

- [x] **Step 4: Run GREEN**

Run the focused `github_plugin` tests. Expected: overlay, repair, tamper, and
digest-budget tests pass.

### Task 4: Share preparation locking with the developer TUI

**Files:**
- Modify: `src-tauri/src/hermes_bridge.rs`

**Interfaces:**
- Consumes: `HermesBridge.start_lock`.
- Produces: both dashboard and `open_hermes_tui_debug` hold that same lock over
  resolution, overlay/install/verification, and spawn/launcher creation.

- [x] **Step 1: Write a failing deterministic concurrency test**

Use barriers/oneshots around a preparation seam. Start one preparation, wait
until it enters, start a second, assert the second has not entered, release the
first, and assert entry order `[1, 2]` with maximum active count 1.

- [x] **Step 2: Run RED**

Run the focused `github_plugin` tests. Expected: independent TUI-style
preparations overlap or the shared-lock helper is missing.

- [x] **Step 3: Thread the shared lock**

Add `State<'_, HermesBridge>` to the TUI command and acquire `start_lock` before
resolution. Reuse a small dependency-injected locked preparation helper for the
test; do not add a second lock.

- [x] **Step 4: Run GREEN**

Run the focused tests. Expected: maximum active preparation count is 1.

### Task 5: Recover Windows replacement failures

**Files:**
- Modify: `src-tauri/src/hermes_bridge.rs`

**Interfaces:**
- Produces: `replace_file_with_windows_backup` and a test seam returning Win32
  error codes/partial filesystem states.
- Consumes: `ReplaceFileW(destination, replacement, backup, 0, null, null)`.

- [x] **Step 1: Write failing recovery tests**

Model 1175/1176 with original names retained, 1177 with destination moved to
backup, and a restoration failure. Assert destination recovery for 1177 and
backup preservation whenever recovery is ambiguous or fails.

- [x] **Step 2: Run RED**

Run focused `github_plugin` tests. Expected: no backup is supplied, unsupported
flag remains, and modeled 1177 loses the destination.

- [x] **Step 3: Implement fail-closed recovery**

Use zero flags and a UUID same-directory backup. Delete backup only after
success. On 1177 restore backup with a no-replace rename; on any restoration
failure return an error that names the preserved backup. Ensure caller temp
cleanup never touches the backup.

- [x] **Step 4: Run GREEN**

Run focused tests. Expected: every documented partial state preserves or
restores the trusted bytes.

### Task 6: Report and verification

**Files:**
- Modify: `.superpowers/sdd/capability-isolation-task-4-report.md`

- [x] **Step 1: Append evidence**

Record RED failures, schema migration behavior, official uv checksum source
and supported tuples, Windows fail-closed eligibility, native-test limitations,
digest budgets, kernel probes, and residual same-user verify-to-exec race.

- [x] **Step 2: Run focused and exact earlier gates**

```bash
CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml github_plugin -- --nocapture
CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml sandbox_ -- --nocapture
rustc --edition=2021 --test src-tauri/hermes_manifest.rs -o /tmp/june-hermes-manifest-tests
/tmp/june-hermes-manifest-tests --nocapture
python3 -m unittest src-tauri/src/hermes/test_june_github_plugin.py -v
bash -n scripts/bundle-hermes-runtime.sh
```

Expected: all tests pass; only the documented Keychain qualification probe is
ignored.

- [x] **Step 3: Run compile/lint/smoke gates**

```bash
CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo check --manifest-path src-tauri/Cargo.toml
CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests --no-deps -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
pnpm exec biome check scripts/hermes-smoke.ts
pnpm test:hermes-smoke
git diff --check
```

Expected: all available gates pass. Record `pwsh` and native Windows absence
without claiming native Windows verification.

- [x] **Step 4: Commit separately**

```bash
git add src-tauri/src/hermes_bridge.rs scripts/bundle-hermes-runtime.sh scripts/bundle-hermes-runtime-windows.ps1 .superpowers/sdd/capability-isolation-task-4-report.md docs/superpowers/plans/2026-07-17-managed-hermes-trust-remediation.md
git commit -m "fix: close managed Hermes trust gaps"
```

Expected: remediation is separate from Task 4's earlier commits and is not
pushed.
