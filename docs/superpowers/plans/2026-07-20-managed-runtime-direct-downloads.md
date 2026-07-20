# Managed Runtime Direct Downloads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore managed Hermes installation without weakening June's fixed-URL, no-redirect archive trust boundary.

**Architecture:** Point the pinned Hermes and uv artifacts at their official direct, checksum-matching HTTPS endpoints. Validate the HTTP status as an explicit `2xx` before reading any body so redirects and other non-success responses cannot fall through to checksum validation.

**Tech Stack:** Rust, reqwest/rustls, SHA-256 archive verification, Tauri, Cargo tests.

## Global Constraints

- Keep redirects disabled and ambient proxies bypassed.
- Keep the Hermes commit, uv version, Node version, and every existing checksum unchanged.
- Keep declared and streamed size caps, SHA-256 verification, archive validation, private staging, and fail-closed admission unchanged.
- Do not add dependencies or modify `Cargo.lock`.
- Do not change GitHub connector capabilities or add GitHub write actions.

---

### Task 1: Repair managed runtime artifact downloads

**Files:**
- Modify: `src-tauri/src/hermes_bridge.rs:98-105`
- Modify: `src-tauri/src/hermes_bridge.rs:9248-9295`
- Test: `src-tauri/src/hermes_bridge.rs:18299-18440`

**Interfaces:**
- Consumes: `HERMES_AGENT_INSTALL_COMMIT`, `MANAGED_UV_VERSION`, `AppError`, `reqwest::StatusCode`, `VerifiedArchiveDownload`.
- Produces: direct `HERMES_SOURCE_TARBALL_URL` and `MANAGED_UV_RELEASE_BASE_URL` constants; `require_managed_archive_success(status: reqwest::StatusCode) -> Result<(), AppError>`.

- [ ] **Step 1: Add the failing direct-endpoint regression**

Add this focused test beside the existing managed archive tests:

```rust
#[test]
fn managed_archive_urls_are_fixed_direct_https_endpoints() {
    assert_eq!(
        HERMES_SOURCE_TARBALL_URL,
        "https://codeload.github.com/NousResearch/hermes-agent/tar.gz/2bd1977d8fad185c9b4be47884f7e87f1add0ce3"
    );
    assert_eq!(
        MANAGED_UV_RELEASE_BASE_URL,
        "https://releases.astral.sh/github/uv/releases/download/0.11.15"
    );
    assert!(HERMES_SOURCE_TARBALL_URL.starts_with("https://"));
    assert!(MANAGED_UV_RELEASE_BASE_URL.starts_with("https://"));
}
```

- [ ] **Step 2: Run the endpoint test and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked managed_archive_urls_are_fixed_direct_https_endpoints -- --nocapture
```

Expected: FAIL because both current constants use redirecting `github.com` URLs.

- [ ] **Step 3: Pin the two direct artifact endpoints**

Replace only the URL constants:

```rust
const HERMES_SOURCE_TARBALL_URL: &str =
    "https://codeload.github.com/NousResearch/hermes-agent/tar.gz/2bd1977d8fad185c9b4be47884f7e87f1add0ce3";
const HERMES_SOURCE_TARBALL_SHA256: &str =
    "7a9bd367066183898831c2760f269368ab54b458a1d1b51d14ef1f484dd490cc";
const MANAGED_UV_VERSION: &str = "0.11.15";
const MANAGED_UV_RELEASE_BASE_URL: &str =
    "https://releases.astral.sh/github/uv/releases/download/0.11.15";
```

Do not change either checksum or any Node artifact constant.

- [ ] **Step 4: Run the endpoint test and verify GREEN**

Run the Step 2 command again.

Expected: PASS with one matching test and no failures.

- [ ] **Step 5: Add the failing response-status regression**

Add this test beside the endpoint test:

```rust
#[test]
fn managed_archive_status_requires_explicit_success() {
    for status in [
        reqwest::StatusCode::OK,
        reqwest::StatusCode::PARTIAL_CONTENT,
    ] {
        require_managed_archive_success(status).expect("2xx archive response");
    }

    for status in [
        reqwest::StatusCode::FOUND,
        reqwest::StatusCode::TEMPORARY_REDIRECT,
        reqwest::StatusCode::BAD_REQUEST,
        reqwest::StatusCode::INTERNAL_SERVER_ERROR,
    ] {
        let error = require_managed_archive_success(status)
            .expect_err("non-success archive response");
        assert_eq!(error.code, "hermes_runtime_install_failed");
        assert!(error.message.contains(&status.as_u16().to_string()));
        assert!(!error.message.contains("body"));
    }
}
```

- [ ] **Step 6: Run the status test and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked managed_archive_status_requires_explicit_success -- --nocapture
```

Expected: compilation FAIL because `require_managed_archive_success` does not exist.

- [ ] **Step 7: Require explicit `2xx` before reading the response**

Add the helper immediately before `download_verified_managed_archive`:

```rust
#[cfg(not(target_os = "windows"))]
fn require_managed_archive_success(status: reqwest::StatusCode) -> Result<(), AppError> {
    if status.is_success() {
        return Ok(());
    }
    Err(AppError::new(
        "hermes_runtime_install_failed",
        format!(
            "Managed runtime archive request returned HTTP {}.",
            status.as_u16()
        ),
    ))
}
```

Replace the current request chain with:

```rust
let mut response = client
    .get(url)
    .send()
    .await
    .map_err(|error| AppError::new("hermes_runtime_install_failed", error.to_string()))?;
require_managed_archive_success(response.status())?;
```

Leave content-length, streamed-size, and digest validation unchanged.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked managed_archive -- --nocapture
```

Expected: all matching managed archive tests PASS, including endpoint, response-status, cap, checksum, extraction, proxy, and trust-boundary regressions.

- [ ] **Step 9: Run Rust quality gates**

Run:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
```

Expected: both commands exit `0` with no formatting diff or clippy warning.

- [ ] **Step 10: Run the full repository gate**

Run:

```bash
make verify
```

Expected: frontend check/typecheck/tests and both Rust workspace format/clippy/test gates exit `0`.

- [ ] **Step 11: Commit the repair for independent review**

```bash
git add src-tauri/src/hermes_bridge.rs
git commit -m "Fix managed runtime direct downloads"
```

Expected: the local branch contains the repair commit and is ready for the task and final review passes. Do not push before those reviews finish.

## Post-review controller gate

After the task review and final whole-change review are clean:

1. Re-run `make verify` from the reviewed commit.
2. Start only the local worktree app with `pnpm tauri:dev`.
3. Start a new agent session and verify:
   - the managed runtime downloads and installs from the direct endpoints;
   - no `Managed runtime archive checksum mismatch.` banner appears;
   - the session opens with the managed runtime;
   - GitHub repository, issue, and pull-request read tools remain available;
   - the production June app is never opened.
4. Push `codex/github-connector-phase-0` to update the existing PR; do not create a new PR.
