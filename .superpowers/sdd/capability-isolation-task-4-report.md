# Task 4 capability-isolation report

## Outcome

Implemented deterministic overlay and verification for the app-owned `june_github` Hermes extension across bundled macOS and Windows runtimes and the managed fallback. Unsupported or user-local runtime sources fail closed. The macOS sandbox no longer grants write access to the managed runtime, and isolated Hermes processes suppress Python bytecode writes.

Base HEAD: `65453e9667612d2151fa763f85d32c0a15d2158a`

## RED evidence

- `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml github_plugin -- --nocapture`
  - Failed to compile because the embedded resource constants, overlay helper, source-verification helper, and narrowed sandbox-write-root signature did not exist.
- `pnpm test:hermes-smoke`
  - The new smoke seam copied the resource itself, so its real-loader registry phase already found the exact 16-tool extension during RED. A later pre-existing model-setting phase failed because the default `~/.hermes` command was stale Hermes `v2026.6.5`. Final verification therefore explicitly used June's managed pinned `v2026.6.19` runtime.

## Implementation

- Added the signed plugin resource mapping and build-time standard-library validation of the exact canonical 16-name `provides_tools` set.
- Added deterministic two-file overlays and byte/hash verification to the macOS and Windows runtime bundlers. The macOS self-test uses the pinned Hermes plugin loader and registry.
- Embedded both canonical files in Rust, atomically replaced and read back the managed overlay on every successful managed-runtime resolution, verified bundled runtime bytes, and returned `false` without resolving paths for environment, user-local, or PATH fallbacks.
- Removed the managed runtime from macOS sandbox write roots, set `PYTHONDONTWRITEBYTECODE=1`, and extended the real kernel sandbox probe to prove Python can import the extension while runtime and extension writes are denied.
- Extended the Hermes smoke gate to overlay the resource and assert exactly 16 tools in exactly one `june_github` toolset through pinned Hermes' real `discover_plugins(force=True)` path.

## GREEN evidence

- `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml github_plugin -- --nocapture`
  - 4 passed, 0 failed.
- `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml sandbox_ -- --nocapture`
  - 9 passed, 0 failed, 1 ignored (the existing unlocked-login-Keychain release-candidate qualification test).
- `python3 -m unittest src-tauri/src/hermes/test_june_github_plugin.py -v`
  - 11 passed, 0 failed. This required host execution because the Unix-socket fixtures cannot bind inside the Codex sandbox.
- `bash -n scripts/bundle-hermes-runtime.sh`
  - Passed.
- `JUNE_HERMES_COMMAND='/Users/sarascahya/Library/Application Support/co.opensoftware.june-dev/hermes-runtime/hermes-agent/venv/bin/hermes' pnpm test:hermes-smoke`
  - Passed against pinned Hermes `v2026.6.19`, including exactly 16 `june_github` tools under one toolset and all selected dashboard protocol phases.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
  - Passed.
- `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests --no-deps -- -D warnings`
  - Passed.
- `pnpm exec biome check scripts/hermes-smoke.ts`
  - Passed.
- `git diff --check`
  - Passed.

## Notes and concerns

- `pwsh` is not installed on this host, so the optional PowerShell parser gate was unavailable. The Windows bundler change is intentionally limited to the requested deterministic two-file replacement and SHA-256 comparisons; Windows toolset exposure remains out of scope until the named-pipe peer-pid broker exists.
- A repository-wide `pnpm check` reported 616 existing warnings outside Task 4. Its sole error was formatting in the changed smoke script; that file was formatted and its scoped Biome check passes.
- The smoke model-prompt phase remains opt-in because no provider credential was supplied. All selected smoke phases passed.
- Generated Python bytecode caches and the diagnostic from the intentionally stale-runtime smoke attempt were removed before staging.

## Security review remediation

Follow-up commit base: `843fad703bb5c2d25cc9ef7dc8ca1ee6bc72009a`

### Review RED evidence

- The expanded `github_plugin` regressions failed compilation with 15 expected missing symbols for the integrity record, full-tree seal, resolver migration seam, protected TMPDIR validator, and atomic Windows replacement seam.
- `rustc --edition=2021 --test src-tauri/hermes_manifest.rs` failed because the strict shared manifest parser did not exist.
- After the first parser implementation, `rejects_duplicate_top_level_provides_tools_blocks` failed because a later inline `provides_tools: [attacker]` override was still accepted.
- `system_tmpdir_must_belong_to_the_runtime_user` failed compilation before the owner-validation seam existed.

### Review fixes

- Replaced the writable `runtime.json` pin check with a versioned full-tree SHA-256 seal stored at the app-data root, outside the old `hermes-runtime` sandbox write grant. The seal covers sorted relative paths, directory entries, regular-file lengths and bytes, and symlink targets.
- A legacy, missing, malformed, or mismatched seal forces complete removal of the old runtime without following symlink/reparse points, followed by a checksum-pinned clean reinstall. A seal is written atomically only after the canonical plugin overlay and `sitecustomize.py` are installed.
- Cached resolution recomputes the full digest and validates plain critical runtime, launcher, loader, registry, venv, and plugin path components. Launcher/loader changes, stale bytecode, extra files, temp residue, or critical symlink/reparse points therefore trigger reinstall or fail closed.
- The real managed resolver branch now has a regression proving cached loader tampering invokes reinstall before returning a command. Managed and bundled extension verification is repeated immediately before dashboard and TUI spawn.
- Managed plugin synchronization removes and recreates the complete `june_github` directory and verifies its entries are exactly `plugin.yaml` and `__init__.py` with embedded bytes.
- macOS accepts inherited `TMPDIR` only when its canonical path has the system per-user `/private/var/folders/<bucket>/<user>/T` shape, has the same uid as the Hermes home, and is disjoint from managed runtime and signed resource paths.
- The build parser is shared with standalone tests and accepts exactly one canonical, top-level, two-space-indented `provides_tools` list. Duplicate, inline override, indented, and ambiguous nested forms fail the build.
- Windows replace-existing now calls `ReplaceFileW` through a documented standard-library FFI boundary; an injected failure regression proves the old destination and replacement remain intact. The Windows bundler now fails removal errors, uses `LiteralPath`, and proves the final directory has exactly the two canonical entries and matching SHA-256 values.

### Review GREEN evidence

- `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml github_plugin -- --nocapture`
  - 12 passed, 0 failed.
- `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml sandbox_ -- --nocapture`
  - 9 passed, 0 failed, 1 ignored (the existing unlocked-login-Keychain release-candidate qualification test).
- `rustc --edition=2021 --test src-tauri/hermes_manifest.rs -o /tmp/june-hermes-manifest-tests && /tmp/june-hermes-manifest-tests --nocapture`
  - 3 passed, 0 failed.
- `python3 -m unittest src-tauri/src/hermes/test_june_github_plugin.py -v`
  - 11 passed, 0 failed.
- `bash -n scripts/bundle-hermes-runtime.sh`
  - Passed.
- `JUNE_HERMES_COMMAND='/Users/sarascahya/Library/Application Support/co.opensoftware.june-dev/hermes-runtime/hermes-agent/venv/bin/hermes' pnpm test:hermes-smoke`
  - Passed against pinned Hermes `v2026.6.19`, including exactly 16 tools under one `june_github` toolset and all selected dashboard phases.
- `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo check --manifest-path src-tauri/Cargo.toml`
  - Passed.
- `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests --no-deps -- -D warnings`
  - Passed.
- Rust formatting, scoped smoke-script Biome, shell syntax, and diff checks passed.

### Residual and operational notes

- Existing managed installs intentionally reinstall once because they have no trusted external seal. This migration needs the same network access and installation time as a fresh managed runtime setup.
- Full-tree verification reads the managed runtime before resolution and again immediately before spawn. This is the cost of authenticating the launcher, loader, dependencies, and bytecode without trusting the previously writable tree.
- A hostile same-user process can still race filesystem mutation between the final userspace verification and `exec`. Closing that narrow residual requires an OS primitive that binds measurement to execution; the ordinary sandboxed agent cannot perform the race because the managed tree and seal are outside its write grants.
- This macOS host cannot execute `ReplaceFileW`, and `pwsh` remains unavailable for the optional PowerShell parser gate. The platform-neutral failure-preservation and Windows bundler source regressions pass; Windows execution still requires CI validation.
