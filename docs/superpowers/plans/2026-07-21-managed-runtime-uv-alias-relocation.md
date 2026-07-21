# Managed Runtime uv Alias Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the redundant broken `uv` CPython alias from a newly installed managed runtime so June can seal and start the runtime after staging relocation.

**Architecture:** Strengthen the embedded Unix installer at the point where the
pinned `uv` command has created both its versioned CPython directory and its
convenience alias. The installer accepts exactly one top-level CPython 3.11
alias whose target is the selected versioned directory, removes that redundant
alias, and only then moves the real interpreter to `python/current`. Exercise
the production installer script with a fake verified `uv` executable so the
tests prove the actual relocation sequence rather than a parallel helper.

**Tech Stack:** Rust 2021 test harness, embedded Bash installer, `std::fs`,
existing `tempfile` fixtures, Cargo test, Make verification gate.

## Global Constraints

- Do not add GitHub write actions, permissions, API routes, secrets, or dependencies.
- Keep checksum verification, archive validation, critical-path validation, plugin-overlay verification, and the complete runtime tree digest fail closed.
- Remove only a top-level `cpython-3.11-<platform>` symlink whose absolute target names the corresponding versioned `cpython-3.11.<patch>-<platform>` entry in the same private Python directory.
- A mismatched candidate alias must make the installer exit unsuccessfully and
  remain on disk so the Rust caller returns the existing
  `hermes_runtime_install_failed` error.
- Run the fix only on the existing non-Windows managed-runtime installation path.
- Preserve the existing uncommitted POSIX PAX global-header extraction fix in `src-tauri/src/hermes_bridge.rs`.

---

### Task 1: Clean the relocated uv CPython alias

**Files:**
- Modify: `src-tauri/src/hermes_bridge.rs:9980-10160`
- Test: `src-tauri/src/hermes_bridge.rs:18500-18630`
- Update: `docs/qa/agent-e2e-qa-runs/2026-07-17-github-agent-reads.md`

**Interfaces:**
- Consumes: `python_install`, the one versioned CPython 3.11 directory selected
  by `MANAGED_HERMES_INSTALL_SCRIPT` inside its private staging root.
- Produces: an installer tree with the validated redundant alias removed and
  the real interpreter at `runtime_dir/python/current`; any missing, duplicate,
  or mismatched alias exits before either entry is moved or deleted.

- [ ] **Step 1: Write the failing installer regression tests**

Add this Unix-only fixture and tests in the existing managed-runtime test
module. The fake `uv` executable creates the real pinned installer layout, and
the tests execute `MANAGED_HERMES_INSTALL_SCRIPT` through the production
`managed_installer_command` function.

```rust
#[cfg(unix)]
fn run_managed_installer_alias_fixture(
    root: &Path,
    mismatched_alias_target: Option<&Path>,
) -> std::process::ExitStatus {
    use std::os::unix::fs::PermissionsExt;

    let runtime = root.join("runtime");
    let install = runtime.join("hermes-agent");
    let hermes_home = root.join("hermes-home");
    let uv = root.join("verified-uv");
    let patch = root.join("patch.py");
    fs::create_dir_all(install.join("hermes_cli/web_dist")).expect("web dist");
    fs::write(install.join("hermes_cli/web_dist/index.html"), "<script src=\"/app.js\"></script>")
        .expect("dashboard index");
    fs::write(&patch, "# fixture patch\n").expect("patch fixture");
    fs::write(
        &uv,
        r#"#!/bin/bash
set -euo pipefail
if [ "${1:-}" = "python" ] && [ "${2:-}" = "install" ]; then
  root="${UV_PYTHON_INSTALL_DIR:?}"
  actual="$root/cpython-3.11.15-macos-aarch64-none"
  /bin/mkdir -p "$actual/bin" "$actual/lib/python3.11/site-packages"
  printf '#!/bin/sh\nexit 0\n' > "$actual/bin/python3.11"
  /bin/chmod 755 "$actual/bin/python3.11"
  target="${JUNE_TEST_UV_ALIAS_TARGET:-$actual}"
  /bin/ln -s "$target" "$root/cpython-3.11-macos-aarch64-none"
  exit 0
fi
if [ "${1:-}" = "sync" ]; then
  /bin/mkdir -p "$UV_PROJECT_ENVIRONMENT/lib/python3.11/site-packages"
  /bin/mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"
  exit 0
fi
exit 64
"#,
    )
    .expect("uv fixture");
    let mut permissions = fs::metadata(&uv).expect("uv metadata").permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&uv, permissions).expect("executable uv fixture");

    let mut command = managed_installer_command(&runtime, &install, &hermes_home, &uv, &patch);
    if let Some(target) = mismatched_alias_target {
        command.env("JUNE_TEST_UV_ALIAS_TARGET", target);
    }
    command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("run managed installer fixture")
}

#[cfg(unix)]
#[test]
fn managed_installer_removes_verified_uv_python_alias_before_relocation() {
    let temp = tempfile::tempdir().expect("temp runtime");
    let status = run_managed_installer_alias_fixture(temp.path(), None);
    let python = temp.path().join("runtime/python");

    assert!(status.success());
    assert!(python.join("current/bin/python3.11").is_file());
    assert!(fs::symlink_metadata(python.join("cpython-3.11-macos-aarch64-none")).is_err());
}

#[cfg(unix)]
#[test]
fn managed_installer_rejects_mismatched_uv_python_alias_without_deleting_it() {
    let temp = tempfile::tempdir().expect("temp runtime");
    let unrelated = temp
        .path()
        .join("outside/cpython-3.11.15-macos-aarch64-none");
    let status = run_managed_installer_alias_fixture(temp.path(), Some(&unrelated));
    let alias = temp
        .path()
        .join("runtime/python/cpython-3.11-macos-aarch64-none");

    assert!(!status.success());
    assert!(fs::symlink_metadata(&alias).is_ok());
    assert!(!temp.path().join("runtime/python/current").exists());
}
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked managed_installer_ -- --nocapture
```

Expected: the verified-alias test fails because the alias remains after the
installer succeeds, and the mismatched-alias test fails because the current
installer accepts the alias and relocates the source directory. These are the required RED
results; unrelated fixture errors must be corrected before implementation.

- [ ] **Step 3: Validate and remove only the verified alias before relocation**

In `MANAGED_HERMES_INSTALL_SCRIPT`, insert this block between the non-empty
`python_install` check and `/bin/mv "$python_install" ...`:

```bash
python_alias=""
while IFS= read -r candidate; do
  candidate_target="$(/usr/bin/readlink "$candidate")"
  if [ "$candidate_target" != "$python_install" ] || [ -n "$python_alias" ]; then
    echo "uv created an unexpected managed Python alias." >&2
    exit 1
  fi
  python_alias="$candidate"
done < <(/usr/bin/find "$runtime_dir/python" -mindepth 1 -maxdepth 1 -type l -name 'cpython-3.11-*' -print)
if [ -z "$python_alias" ]; then
  echo "uv did not create the expected managed Python alias." >&2
  exit 1
fi
/bin/rm "$python_alias"
/bin/mv "$python_install" "$runtime_dir/python/current"
```

- [ ] **Step 4: Run the focused tests to verify GREEN**

Run:

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked managed_installer_ -- --nocapture
```

Expected: both installer tests pass. The first proves the exact `uv` alias is
removed before `python/current` is created; the second proves a mismatched
alias fails without deletion or relocation.

- [ ] **Step 5: Run the managed-runtime regression slice**

Run:

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked managed_runtime -- --nocapture
```

Expected: all managed-runtime tests pass, including the existing archive extraction, overlay verification, critical-path, digest, installation resolution, and direct-download coverage.

- [ ] **Step 6: Run formatting, lint, and diff checks**

Run each command independently:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
```

```bash
CARGO_INCREMENTAL=0 cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --no-default-features -- -D warnings
```

```bash
git diff --check
```

Expected: each command exits 0 with no warning promoted to an error.

- [ ] **Step 7: Run the full repository verification gate**

Run:

```bash
make verify
```

Expected: frontend formatting, typecheck, Vitest, Tauri Rust format/clippy/tests, and June API format/clippy/tests all pass under the documented repository exceptions.

- [ ] **Step 8: Restart and perform live worktree QA**

Launch only the worktree app with local June API settings plus the documented public GitHub App configuration:

```bash
OS_JUNE_LOCAL_DEV=1 \
OS_JUNE_LOCAL_DEV_BEARER_TOKEN=local-dev-token \
OS_JUNE_LOCAL_DEV_USER_ID=usr_local_dev \
JUNE__SERVER__HOST=127.0.0.1 \
JUNE__LOCAL_DEV__ENABLED=true \
JUNE__LOCAL_DEV__BEARER_TOKEN=local-dev-token \
JUNE__LOCAL_DEV__USER_ID=usr_local_dev \
GITHUB_APP_CLIENT_ID=Iv23lihKGi1yIb8QZm9L \
GITHUB_APP_SLUG=june-staging \
node scripts/tauri-dev.mjs
```

In **Settings → Connectors → GitHub**, confirm the existing connection is visible. Start a sandboxed session and ask June to list the connected repositories, read one issue, and read one pull request. Expected: the runtime installs or repairs successfully, no OS error 2 toast appears, and only read tools are available.

Confirm that the worktree app-data directory contains both
`hermes-runtime/runtime.json` and `hermes-runtime-integrity-v1.json`, and that
`find -L <runtime>/python -type l -print` reports no broken CPython alias.

Append the date, worktree commit, commands, and pass/fail evidence to `docs/qa/agent-e2e-qa-runs/2026-07-17-github-agent-reads.md`. Do not record tokens, device codes, provider payloads, or repository content.

- [ ] **Step 9: Commit the implementation**

Stage only the managed-runtime code, its existing POSIX PAX extraction fix, and QA evidence:

```bash
git add src-tauri/src/hermes_bridge.rs docs/qa/agent-e2e-qa-runs/2026-07-17-github-agent-reads.md
git commit -m "Fix managed runtime relocation links"
```

Expected: one implementation commit; no generated runtime, local database, `.env`, token, or application-support file is staged.
