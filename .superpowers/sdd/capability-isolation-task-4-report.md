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

## Second security review remediation

Follow-up commit base: `c4222657645f2d80d51d8847cbe0f63be59890fc`

### Second review RED evidence

- The new sandbox profile regression failed because the generated SBPL did not contain a global `(deny file-link)` rule.
- The external-closure regression failed because the integrity walk authenticated only Python symlink text and accepted an absolute interpreter target outside the managed runtime.
- The pinned-bootstrap/in-tree-command regression initially failed compilation because `managed_uv_artifact_for` and `managed_runtime_commands` did not exist.
- The privileged-installer source regression found the Unix editable-install fallback and the Windows ordinary-resolution fallback.
- The first Windows recovery test compile exposed a lifetime mismatch in the generic restore seam before the closure boundary was made explicit.
- The first Python plugin contract run failed because the Codex sandbox denies Unix-socket fixture binding. The unchanged test was rerun with host permission and passed 11 of 11.

### Second review fixes

- The macOS Seatbelt profile now globally denies `file-link` and never re-grants it. The protected set includes the managed runtime, its external integrity record, and signed resources. The real kernel regression hard-links both a managed loader and the external seal into writable `HERMES_HOME`, attempts overwrite, and proves both sources retain their trusted bytes.
- Managed integrity records now use schema 2. The normalized base digest excludes only the exact GitHub manifest, GitHub source, and discovered in-tree `sitecustomize.py` paths. Those three plain files are authenticated separately against exact app-owned bytes; the plugin directory must still contain exactly two canonical entries.
- A valid base record with old overlay identities is canonicalized and atomically resealed on first resolution without installer or network access. Schema 1 forces a clean reinstall because it did not authenticate the external interpreter closure.
- Auto-start availability now checks only record pin metadata and plain launcher/interpreter metadata. Full hashing runs on a blocking worker only during the final locked preparation before dashboard or TUI execution. Instrumented regressions prove one digest for steady state or overlay-only reseal and exactly two for base-tree tamper repair.
- Dashboard starts and developer TUI launches use the same `HermesBridge.start_lock`. A deterministic two-caller regression proves the second preparation cannot enter until the first releases the shared lock.
- Managed Unix bootstrap selects only checksum-pinned uv 0.11.15 release archives, installs CPython 3.11 under `hermes-runtime/python/current`, performs only `uv sync --extra all --locked`, removes venv executable shims, and launches Hermes plus every June MCP through the authenticated in-tree interpreter. Any symlink/reparse target resolving outside the runtime invalidates the closure.
- Ordinary dependency-resolution fallbacks were removed from both bundlers. Windows GitHub registration is compile-time disabled until its general managed installer has an equivalent locked, in-tree closure.
- Windows replacement now calls `ReplaceFileW(destination, replacement, backup, 0, null, null)` with a unique same-directory backup. Modeled errors 1175/1176 preserve original names; error 1177 restores a displaced destination; failed recovery preserves and reports the trusted backup.

### Pinned uv checksum source

The source of record is the official uv 0.11.15 `sha256.sum` release asset:
`https://github.com/astral-sh/uv/releases/download/0.11.15/sha256.sum`.

- macOS aarch64: `7e5b336108f8576eda1939920ca0a805b4a9a3c3d3eb2f6140e38b7092fbe4f3`
- macOS x86_64: `42bca7cc879d117ed7139a0e26de8cab0b6f033ad439a32144f324d1f8580d8c`
- Linux aarch64 glibc: `21a7dd1a03ea17ac0366887455dab15d215b31dba0870dcd65d3714e22f46c81`
- Linux x86_64 glibc: `b03e572f010bea94a4a52d42671ba72981e12894f71576181a1d26ff68546da7`

Every other OS/architecture tuple fails closed instead of selecting an unverified bootstrap artifact.

### Second review GREEN evidence

- `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml github_plugin -- --nocapture`
  - 23 passed, 0 failed. This includes overlay-only schema-2 reseal, one/two digest budgets, cheap auto availability, absolute and relative interpreter escapes, locked-bootstrap source checks, shared-lock serialization, Windows fail-close, and all replacement recovery states.
- `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml sandbox_ -- --nocapture`
  - 9 passed, 0 failed, 1 ignored (the existing unlocked-login-Keychain release-candidate qualification probe). The native kernel hard-link probes passed.
- `rustc --edition=2021 --test src-tauri/hermes_manifest.rs -o /tmp/june-hermes-manifest-tests && /tmp/june-hermes-manifest-tests --nocapture`
  - 3 passed, 0 failed.
- `python3 -m unittest src-tauri/src/hermes/test_june_github_plugin.py -v`
  - 11 passed, 0 failed with host permission for Unix-socket fixtures.
- `bash -n scripts/bundle-hermes-runtime.sh`
  - Passed.
- `JUNE_HERMES_COMMAND='<existing pinned v2026.6.19 managed command>' pnpm test:hermes-smoke`
  - Passed the exact 16-tool plugin-loader gate and every selected dashboard phase; the credential-dependent model phase remained skipped.
- `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo check --manifest-path src-tauri/Cargo.toml`
  - Passed.
- `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo clippy --manifest-path src-tauri/Cargo.toml --lib --tests --no-deps -- -D warnings`
  - Passed.
- Rust formatting, scoped smoke-script Biome, shell syntax, and `git diff --check` passed.

### Second review residual and qualification notes

- This host has no newly installed in-tree managed runtime; only the prior pinned v2026.6.19 venv runtime is present, and the volume had about 1.4 GiB free during verification. The live smoke therefore qualifies the unchanged pinned Hermes/plugin contract, while schema-1 clean migration, in-tree path selection, locked bootstrap source, closure tamper, and digest behavior are covered by deterministic Rust regressions. No user app-data runtime was destructively replaced for this repository test.
- This macOS host cannot execute `ReplaceFileW`, and `pwsh` remains unavailable. Platform-neutral failure-state tests cover errors 1175, 1176, 1177, and restoration failure; native Windows execution remains a CI qualification item. Windows GitHub exposure is fail-closed regardless.
- A hostile same-user process can still race mutation into the narrow interval between final userspace verification and `exec`. Closing that residual requires an OS primitive binding measurement to execution. The ordinary sandboxed agent cannot create the hard-link alias or write the protected runtime/seal paths.
