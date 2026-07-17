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

## Third security review remediation

Follow-up commit base: `2405ef5a`

### Third review RED evidence

- `python_isolation_scrubs_import_controls_and_sets_safe_defaults` failed because attacker-controlled `PYTHONPATH` survived the process environment.
- The first `python_isolation_prefixes_hermes_and_mcp_entrypoints_exactly` compile failed because there was no authenticated Python invocation abstraction; Hermes still executed a console launcher and MCP YAML started at the script path.
- The target-environment check exposed that Linux uv selection did not distinguish glibc from musl.
- The managed installer source still contained PATH-resolved `curl`, checksum utilities, `tar`, and optional `npm`, so a poisoned bootstrap PATH could influence the sealed runtime.
- User-local and PATH fallback variants existed in the source enum but no longer participated in general start resolution.

### Third review fixes

- Added one `PythonInvocation` for dashboard, developer TUI, and every first-party MCP. Hermes now executes `<resolved-python> -I -S -B -c <fixed-bootstrap> ...`; the bootstrap removes the dashboard bearer before authenticated site initialization, restores it afterward, and runs `hermes_cli.main` through `runpy`. All 11 rendered registrations covering the ten distinct standard-library-only June MCP scripts execute `<resolved-python> -I -S -B <script> ...` without site initialization.
- Scrubbed `PYTHONPATH`, `PYTHONHOME`, `PYTHONUSERBASE`, startup/inspection/warning/breakpoint/platform/executable controls, `__PYVENV_LAUNCHER__`, and inherited safe-mode variables. Process and TUI launchers re-establish `PYTHONDONTWRITEBYTECODE=1`, `PYTHONNOUSERSITE=1`, and `PYTHONSAFEPATH=1`.
- Added a real disposable-venv poison test. External `sitecustomize.py`, a shadow `hermes_cli`, a version-correct user-site `.pth`, invalid `PYTHONHOME`, and attacker `PYTHONUSERBASE` never influence startup; fake Hermes and all ten embedded MCP modules still import successfully. An authenticated in-venv `.pth` startup hook does run for Hermes but proves the dashboard bearer is absent until site initialization completes.
- Moved Unix archive trust into Rust. Both pinned HTTPS downloads disable redirects, use connect/overall timeouts, enforce declared and streamed caps, hash while streaming, remove partial/mismatched files, and create archives mode 0600. Direct minimal `flate2`/`tar` declarations reuse already-locked versions.
- Validation completes before extraction and rejects absolute, parent/dot/ambiguous/backslash/non-UTF-8 paths; duplicate and case-colliding normalized names; file-ancestor collisions; every symlink, hardlink, device, FIFO, and unsupported header; unexpected top-level roots; excessive entry counts; and excessive expanded size. Extraction is private, followed by a no-link/type/canonical-containment walk.
- The shell receives only the private staged source and verified absolute uv executable. It starts with `env_clear`, `PATH=/usr/bin:/bin`, performs only `uv sync --extra all --locked`, contains no downloader, checksum utility, archive tool, npm/npx, or unlocked dependency fallback, and fails if the pinned source lacks dashboard assets. The old runtime remains until the staged runtime is complete.
- uv selection now includes target environment: macOS requires an empty env, Linux requires GNU, and musl/unknown tuples fail closed.
- Restored user-local and concrete PATH fallback for fresh/legacy managed-install unavailability. Fallback uses isolated Python and is always GitHub-ineligible. Any schema-2 seal, unreadable integrity state, or previously admitted managed process prohibits downgrade. Resolution happens before MCP/config/SOUL generation, so a fallback render uses its interpreter and omits GitHub from config, toolsets, and identity text.
- Schema-2 integrity records are written through 0600 temporary/final files under a 0700 parent.

The ten distinct MCP scripts exercised are `june_context_mcp.py`, `june_web_mcp.py`, `june_image_mcp.py`, `june_video_mcp.py`, `june_recorder_mcp.py`, `june_github_mcp.py`, `june_gmail_mcp.py`, `june_gmail_actions_mcp.py`, `june_gcal_mcp.py`, and `june_gcal_actions_mcp.py`. Per-routine connector-auto servers reuse one of the authenticated action-script invocations.

The pinned console entry point is `hermes_cli.main:main`. Against the existing pinned v2026.6.19 runtime, the console script and `python -m hermes_cli.main` produced identical version output, exit status, stdout, and stderr for the checked success and argparse-error cases.

### Third review GREEN evidence

- `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml hermes_bridge::tests::github_plugin_tests -- --nocapture`
  - 30 passed, 0 failed.
- Real Python startup poison harness: 1 passed, 0 failed; all ten MCP imports plus Hermes succeeded and no poison/bearer sentinel was created.
- Unsafe archive matrix and valid extraction/postvalidation: 1 passed, 0 failed. Stream cap/hash/cleanup/0600 matrix: 1 passed, 0 failed.
- Fallback policy, fallback config regeneration, and all-rendered-MCP isolation regressions passed.
- `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml sandbox_ -- --nocapture` with host permission: 9 passed, 0 failed, 1 ignored.
- Standalone Rust manifest: 3 passed, 0 failed. Python plugin contract with host socket permission: 11 passed, 0 failed.
- `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: passed.
- Cargo release-age policy: passed with 0 new crate versions versus HEAD. Rust formatting, Unix bundler shell syntax, scoped Biome, and `git diff --check` passed.
- The pinned Hermes smoke passed the exact 16-tool loader gate and every selected dashboard/session phase twice. Both runs then encountered the same post-pass `ENOTEMPTY` temporary-home cleanup race; no functional phase failed.

### Qualification and residual notes

- A fresh full schema-2 managed install was not attempted on this host: the data volume had about 1.0 GiB free and reported 100% capacity, with no cached pinned source/uv archives. Downloading CPython and all locked Hermes extras risked exhausting disk. Deterministic local tests cover streaming, archive trust, staged command construction, isolation, sealing, steady-state preparation, and no-reinstall schema-2 behavior; live artifact installation/restart qualification remains Task 8.
- Windows GitHub exposure remains compile-time fail-closed. The Unix Rust-owned bootstrap is target-gated; native Windows bootstrap equivalence remains a later qualification item.
- The existing narrow same-user verify-to-exec race remains. The final full-tree check is immediately before spawn, and ordinary sandboxed Hermes cannot write or link the protected runtime/seal, but only an OS primitive binding measurement to execution could eliminate that interval completely.

## Fourth security review remediation

Follow-up commit base: `723fc92c`

### Fourth review RED evidence

- The archive tests initially failed to compile after the path-backed verified archive was replaced in the test contract by immutable authenticated bytes. With the old HTTP builder restored, the behavioral proxy fixture reached the hostile proxy and returned `proxy` instead of the origin body.
- Node tuple, locked-build-input, command, asset, and clean-install fixtures initially failed to compile because no pinned Node selector or Rust-owned dashboard preparation path existed.
- The final clean-install audit caught that official Node Unix archives contain `bin/npm`, `bin/npx`, and `bin/corepack` symlinks while the strict shared archive policy rejected all links. The Node-specific ignored-link regression first failed to compile because no safe extractor policy existed.
- The production-path regression found `verify_runtime_immediately_before_spawn` re-entering managed resolution, causing a second steady-state tree digest after the shared locked preparation.
- Independent final review also found that merely deleting that second resolution left the only digest far before spawn, process-map state reopened fallback after stop, and a false byte-local plugin result was ignored. Late final-admission order, sticky lifetime state, and plugin-tamper regressions now cover those boundaries.
- The fallback fixture failed to compile before an actual shebang resolver existed; the old fallback could fabricate ambient `python3`. The schema matrix proved malformed `{}` metadata was still admitted as legacy fallback.
- The loader fixture proved `LD_PRELOAD` remained on the real bearer-bearing dashboard command. Older launcher assertions then failed until they were updated to the empty-environment Terminal contract.
- Cleanup-failure injection now proves a failed builder cleanup returns before an integrity seal or runtime publication can exist.

### Fourth review fixes

- Verified archives now own checksum-authenticated bounded `Arc<[u8]>` bytes. Validation and extraction create independent readers over those same immutable bytes and independently run the same entry-state gate. Raw UTF-8 paths reject absolute paths, backslashes, repeated separators, internal or terminal dot components, parent components, and file trailing separators before `Path` normalization. The existing link, duplicate, case-collision, file-ancestor, count, expanded-size, top-level, type, and post-extraction containment constraints apply on both passes.
- Official Node Unix archives' three convenience launcher symlinks are handled by a Node-only policy: both archive passes require the exact `bin/npm`, `bin/npx`, or `bin/corepack` path and exact pinned target, then ignore rather than extract the entry. Wrong paths/targets and every source/uv or other Node link fail closed.
- The archive client uses redirects disabled, fixed timeouts, and `.no_proxy()`. Its behavioral origin/proxy fixture passed on a host that permits loopback sockets; sandbox runs retain the direct source assertion when loopback bind is denied.
- Fresh managed Unix installs download one of four official checksum-pinned Node 24.18.0 archives, validate the exact Hermes source workspace and lockfile-v3 inputs, and require registry URL plus integrity for TypeScript, Vite, and all supported esbuild, Rolldown, Tailwind Oxide, and lightningcss native packages. Rust invokes the verified absolute Node executable for npm's JavaScript CLI, TypeScript, and Vite with an empty environment, staging-only npm state, the exact npm registry, strict TLS, disabled ambient proxy/config/update/audit/fund/script controls, and no shell, PATH-resolved npm, lifecycle script, or `.bin` shim.
- The generated `web_dist` must be a plain regular-file tree with a nonempty UTF-8 index and a contained, present local asset graph. External, protocol-relative, query/fragment-ambiguous, percent-encoded, dot, repeated-separator, escaping, missing, and linked references fail closed. Node, `node_modules`, and npm bootstrap state must be removed and assets revalidated before sealing or publication.
- Current schema-2 dashboard and TUI starts use cheap command prediction for config/sandbox preparation, then one shared full-tree final admission immediately before spawn. Fresh install/legacy repair may necessarily hash earlier to decide a permitted fallback. The subsequent exact embedded GitHub-plugin byte check is byte-local and now aborts the spawn if an eligible managed/bundled plugin changed. The real steady path therefore performs one full digest, while cheap availability performs none.
- User-local/PATH fallback derives the canonical absolute Python interpreter from the selected executable's bounded shebang and symlink chain, including narrowly admitted `/usr/bin/env python*` launchers resolved through the selected PATH. It rejects loops, nonregular or nonexecutable endpoints, malformed/relative/shell shebangs, and never emits a fabricated bare `python3`.
- Record admission parses `schema` before typed deserialization. Only a missing record and explicit legacy schema 1 may use the pre-admission fallback. Malformed JSON, missing/nonnumeric schema, 0, unknown/future schemas, and all current schema-2 integrity failures fail closed.
- Managed admission sets a sticky app-lifetime guard. Stopping every managed process cannot reopen legacy/missing-record fallback before the app exits.
- Bearer-bearing direct children remove every explicit or inherited `LD_*` and `DYLD_*` key in addition to Python startup controls. The generated TUI launcher enters `/usr/bin/env -i` and restores only quoted fixed Hermes/Python values plus June-captured `HOME`, `PATH`, and `TMPDIR`, so Terminal cannot reintroduce loader hooks.

### Pinned Node checksum source

The source of record is the official Node.js 24.18.0 release directory and its signed checksum manifest at `https://nodejs.org/download/release/v24.18.0/`.

- macOS aarch64: `e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1`
- macOS x86_64: `dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080`
- Linux aarch64 glibc: `6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508`
- Linux x86_64 glibc: `783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8`

Every other OS, architecture, or libc tuple fails closed. The Hermes source remains the exact commit archive `2bd1977d8fad185c9b4be47884f7e87f1add0ce3`, SHA-256 `7a9bd367066183898831c2760f269368ab54b458a1d1b51d14ef1f484dd490cc`. The official PyPI wheel for the same pinned release was inspected and contains no `hermes_cli/web_dist`, so it cannot replace the trusted source build.

### Fourth review GREEN evidence

- Strict focused RED/GREEN filters passed for immutable archives and repeated constraints (3), Node tuple/input/link policy and command isolation (4), asset graph and cleanup failure (2), clean managed install (1), one-digest shared final admission plus real production-path order/source guards (1), fallback interpreter (1), schema admission and sticky lifetime policy (2), loader environment (1), plugin-tamper fail-close (1), and TUI launcher regressions (3).
- `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml github_plugin -- --nocapture`: 45 passed, 0 failed after the Node-link, sticky-admission, and plugin-tamper regressions were added.
- Native `sandbox_` qualification with host permission: 9 passed, 0 failed, 1 ignored (the existing unlocked-login-Keychain release-candidate probe).
- Standalone Rust manifest parser: 3 passed, 0 failed. Python plugin contract with host Unix-socket permission: 11 passed, 0 failed.
- `CARGO_INCREMENTAL=0 cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `CARGO_INCREMENTAL=0 cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: passed.
- The pinned v2026.6.19 Hermes smoke passed the exact 16-tool loader gate and every selected dashboard/session phase; the credential-dependent model phase remained skipped. The final rerun then hit the documented post-pass `ENOTEMPTY` temporary-home cleanup race and exited 1 after reporting all selected phases passed.
- Rust formatting, Unix bundler shell syntax, scoped Biome, and `git diff --check` passed.
- `python3 scripts/check-cargo-release-age.py --base HEAD` passed with all 8 current manifests locked and 0 new crate versions. The default `origin/main` comparison cannot complete because that base references the already-absent `src-tauri/native/windows-dictation-helper/Cargo.lock`; this change modifies no Cargo manifest or lockfile.

### Qualification and residual notes

- Local fixtures exercise the production archive policies and dashboard-preparation helpers, validate assets, remove all builder material, seal schema 2, resolve the authenticated Python launcher with one digest, and prove no second installer call. They do not launch a packaged dashboard from official downloads and do not mutate user app data.
- A live artifact download, npm install/build, packaged-app restart, and dashboard render remains Task 8. It is deliberately not claimed here and was not attempted as part of this Task 4 remediation.
- Windows GitHub exposure remains compile-time fail-closed. Native Windows parity is outside this Unix managed-install remediation.
- The narrow same-user verify-to-exec race remains as previously documented. This change removes the duplicate steady-state digest without claiming that a userspace byte check can bind measurement atomically to `exec`.
