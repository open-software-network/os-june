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
