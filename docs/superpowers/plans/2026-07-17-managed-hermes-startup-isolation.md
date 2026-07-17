# Managed Hermes startup isolation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hermes and all first-party MCPs execute through isolated Python, move archive trust into Rust, and restore downgrade-resistant general-runtime fallback.

**Architecture:** A shared `PythonInvocation` owns the exact `-I -B` prefix for Hermes and MCP rendering. Rust performs capped, checksum-pinned download and pure-Rust archive validation/extraction before an environment-cleared locked installer runs. Final managed admission either returns the authenticated invocation, selects and rerenders a GitHub-ineligible pre-launch fallback, or fails closed for integrity/downgrade conditions.

**Tech Stack:** Rust 1.80, Tokio, reqwest/rustls, SHA-256, already-locked `flate2` 1.1.9 and `tar` 0.4.46, Tauri command spawning, Python 3.11 isolated mode.

---

## File map

- Modify `src-tauri/src/hermes_bridge.rs`: invocation, environment, fallback, bootstrap, archive validation, seal modes, and regressions.
- Modify `src-tauri/Cargo.toml`: direct minimal-feature declarations for already-locked archive crates.
- Modify `scripts/check-cargo-release-age.py` only if its unchanged lockfile check identifies a real policy issue; otherwise leave it untouched.
- Modify `.superpowers/sdd/capability-isolation-task-4-report.md`: append third-review RED/GREEN and qualification evidence.

### Task 1: Isolated Python invocation for Hermes and ten MCP scripts

**Interfaces:**

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
struct PythonInvocation {
    program: String,
    prefix_args: Vec<String>, // exactly ["-I", "-B"]
}

impl PythonInvocation {
    fn isolated(program: impl Into<String>) -> Self;
    fn hermes_args(&self, args: &[&str]) -> Vec<String>;
    fn script_args(&self, script: &Path, args: &[String]) -> Vec<String>;
}
```

The exact ten scripts from current registration call sites are context, web,
image, video, recorder, GitHub, Gmail read, Gmail actions, Calendar read, and
Calendar actions. Connector-auto instances reuse the authenticated Calendar or
Gmail action script invocation and do not add an eleventh script.

- [ ] Write renderer tests asserting every MCP entry places `-I`, then `-B`, then the script path in YAML args and that dashboard/TUI command construction places `-I -B -m hermes_cli.main` before Hermes arguments.
- [ ] Run `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml python_isolation -- --nocapture`; verify RED because configs contain only the script and Hermes launches the console script.
- [ ] Add `PythonInvocation`; replace `HermesCommandResolution.command/python_command` with the isolated invocation plus source; thread it through all ten MCP config types and renderers; invoke the authenticated Python directly for dashboard and TUI.
- [ ] Extend `ISOLATED_HERMES_ENV_VARS` with `PYTHONPATH`, `PYTHONHOME`, `PYTHONUSERBASE`, `PYTHONSTARTUP`, `PYTHONINSPECT`, `PYTHONWARNINGS`, `PYTHONBREAKPOINT`, `PYTHONPLATLIBDIR`, `PYTHONEXECUTABLE`, `__PYVENV_LAUNCHER__`, `PYTHONNOUSERSITE`, and `PYTHONSAFEPATH`; re-set the three safe values to `1` in process and TUI environments.
- [ ] Build a real temporary venv poison test. Install a fixture `hermes_cli.main`, create external `sitecustomize.py`/shadow modules, a version-correct user-site `.pth`, invalid `PYTHONHOME`, attacker `PYTHONUSERBASE`, and a startup hook that attempts to copy a bearer sentinel. Execute Hermes plus all ten embedded MCP modules with the production invocation and assert required imports work while no poison sentinel exists.
- [ ] Re-run the focused test and all existing config/TUI tests; verify GREEN.

### Task 2: Target-environment-qualified uv artifacts

**Interface:**

```rust
fn managed_uv_artifact_for(
    target_os: &str,
    target_arch: &str,
    target_env: &str,
) -> Option<ManagedUvArtifact>;
```

- [ ] Add RED cases for `("linux", "x86_64", "musl")`, unknown env, and a GNU/empty-env mismatch; keep explicit macOS empty-env and Linux GNU positive cases.
- [ ] Run the focused `managed_uv_bootstrap` test and verify signature/expectation failure.
- [ ] Add `target_env` to the selector and current-target helper; allow only macOS `""` and Linux `"gnu"` tuples.
- [ ] Re-run and verify GREEN.

### Task 3: Rust-owned verified archive download and extraction

**Dependencies:**

```toml
flate2 = { version = "1.1.9", default-features = false, features = ["rust_backend"] }
tar = { version = "0.4.46", default-features = false }
```

Both versions already exist in `src-tauri/Cargo.lock`; do not run `cargo add`
or broaden features. Run the repository Cargo release-age policy after editing.

**Interfaces:**

```rust
struct ManagedArchiveSpec {
    label: &'static str,
    url: &'static str,
    sha256: &'static str,
    max_bytes: usize,
    expected_root: String,
}

async fn download_verified_archive(spec: &ManagedArchiveSpec, path: &Path) -> Result<(), AppError>;
fn validate_and_extract_archive(spec: &ManagedArchiveSpec, archive: &Path, dest: &Path) -> Result<PathBuf, AppError>;
```

- [ ] Write in-memory/local tar.gz fixtures for valid layout and each RED attack: absolute path, parent traversal, dot/empty/backslash component, duplicate, case collision, file-parent collision, symlink, hardlink, block/character device, FIFO, unknown type, and unexpected/multiple top levels.
- [ ] Add an injected local-response download test for declared and streamed size overflow, redirect/non-success, checksum mismatch, and successful 0600 output.
- [ ] Run `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path src-tauri/Cargo.toml managed_archive -- --nocapture`; verify RED because Rust has no archive trust boundary.
- [ ] Declare the locked minimal dependencies. Implement capped streaming reqwest download with fixed no-redirect/timeouts and Rust SHA-256. Implement two-pass pure-Rust validation/extraction, rejecting every non-directory/non-regular header and normalized collision before unpacking.
- [ ] Walk the extracted tree using `symlink_metadata`, reject links/reparse points, enforce canonical containment and required source/uv paths, and make staging directories mode 0700.
- [ ] Run the Cargo release-age check, focused archive tests, and `cargo tree -i tar/flate2 -e features`; verify GREEN without lockfile change or feature broadening.

### Task 4: Remove ambient bootstrap executables

**Installer contract:** Rust passes `JUNE_VERIFIED_HERMES_SOURCE_DIR` and
`JUNE_VERIFIED_UV` to `/bin/bash`; the shell never downloads, hashes, or
extracts an archive.

- [ ] Add a RED source test forbidding `curl`, `shasum`, `sha256sum`, tar invocation, `npm`, `npx`, and `command -v` in `MANAGED_HERMES_INSTALL_SCRIPT`; add a command-construction test requiring `env_clear`, explicit safe variables, and `PATH=/usr/bin:/bin`.
- [ ] Add a poisoned-PATH fixture with fake curl/tar/checksum/npm executables that write sentinels. Exercise verified local archives and the installer-command seam; assert no sentinel and stable sealed output.
- [ ] Run focused bootstrap tests and verify RED on current shell calls.
- [ ] Prepare archives in Rust before deleting/rebuilding the runtime. Rewrite the shell to move the verified source, invoke only the verified absolute uv binary for Python install and `uv sync --extra all --locked`, skip npm, and fail if pinned dashboard assets are absent.
- [ ] Ensure bootstrap staging cleanup runs on success and every error without deleting the only known-good existing runtime before verified inputs are ready.
- [ ] Re-run focused tests and `bash -n scripts/bundle-hermes-runtime.sh`; verify GREEN.

### Task 5: Downgrade-resistant pre-launch fallback and config regeneration

**Interfaces:**

```rust
enum ManagedAdmissionFailureKind { Unavailable, IntegrityViolation }

async fn admit_runtime_for_spawn(
    app: &AppHandle,
    bridge: &HermesBridge,
    predicted: HermesCommandResolution,
) -> Result<HermesCommandResolution, AppError>;

fn fallback_hermes_resolution_with<F>(user_local: F) -> HermesCommandResolution
where
    F: FnOnce() -> Option<PathBuf>;
```

- [ ] Write RED tests for fresh-install failure -> user-local fallback, no user-local -> PATH fallback, exact source classification, isolated fallback interpreter, and `github_toolset_supported_for_runtime == false` for EnvOverride/UserLocal/PATH.
- [ ] Write RED tests proving valid schema-2 tamper/install failure and an already-admitted managed process both return errors instead of fallback.
- [ ] Add a rendered-config regression: start with a managed GitHub entry, apply fallback regeneration, and assert every MCP command/args use fallback Python while GitHub server/toolset and SOUL claim are absent.
- [ ] Run focused fallback tests and verify RED because final admission returns only a boolean and no fallback is selected.
- [ ] Restore user-local/PATH discovery, classify managed failures without losing the pre-install reason, record source in `HermesProcess`, and return final resolution. Permit fallback only for unavailable fresh/migration installs with no admitted managed process.
- [ ] Extract one runtime-config synchronization helper. On final source change, rerun all ten MCP sync/render operations, config merge, interactive toolset derivation, and SOUL generation before spawn. Apply the same admission rules to TUI under the shared lock.
- [ ] Re-run focused tests and verify GREEN.

### Task 6: Private schema-2 seal and local restart integration

- [ ] Add Unix RED tests asserting integrity temp/final file mode 0600 and its private directory mode 0700.
- [ ] Add a disposable local integration that builds a minimal valid runtime from checked local archive fixtures, launches the fixture `hermes_cli.main` with the production isolated invocation, imports all ten MCP modules, seals schema 2, then prepares again with installer count unchanged.
- [ ] Run focused tests and verify RED for modes/integration seam.
- [ ] Apply Unix modes at create time with `OpenOptionsExt::mode`, sync/replace without widening permissions, and enforce private directory permissions before record creation.
- [ ] Complete the local fixture using only local checked bytes; if an exact full installer emulation would test the fixture rather than production, limit it to the real archive/extraction/admission/invocation path and document live artifact qualification for Task 8.
- [ ] Re-run and verify GREEN.

### Task 7: Report, full gates, and separate commit

- [ ] Append exact RED/GREEN evidence, entrypoint parity, ten-script inventory, archive validation matrix, dependency-policy result, fallback rules, poison results, seal modes, local/live qualification, Windows fail-close, and residual verify-to-exec race to `.superpowers/sdd/capability-isolation-task-4-report.md`.
- [ ] Run focused gates with `CARGO_INCREMENTAL=0 CARGO_PROFILE_TEST_DEBUG=0`: `github_plugin`, `python_isolation`, `managed_archive`, `fallback`, and `sandbox_` (host permission for kernel probes).
- [ ] Run manifest and Python plugin gates: standalone Rust manifest 3/3 and `python3 -m unittest src-tauri/src/hermes/test_june_github_plugin.py -v` 11/11 (host socket permission).
- [ ] Run pinned `pnpm test:hermes-smoke`, `cargo check`, clippy `-D warnings`, Rust fmt, shell syntax, scoped Biome, Cargo release-age policy, and `git diff --check`.
- [ ] Review the staged diff against every Critical/Important/Minor requirement and preserve prior schema-2 behavior.
- [ ] Commit only the third remediation and report in a new local commit named `fix: isolate managed Hermes startup`; do not push.
