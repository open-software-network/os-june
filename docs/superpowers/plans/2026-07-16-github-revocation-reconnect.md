# GitHub revocation reconnect implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live GitHub authorization-revocation response delete unusable custody, persist `reconnect_required`, and update the open settings view immediately.

**Architecture:** Extend the existing exact refresh-error allowlist for the live HTTP 200 `incorrect_client_credentials` response, leaving the definitive 200/400 status boundary intact. Keep terminal state mutation in the GitHub service, and make the Tauri refresh boundary emit the existing connector event on both success and `github_reconnect_required` without hiding the original result.

**Tech Stack:** Rust, Tokio, reqwest, sqlx/SQLite, Tauri events, existing loopback scripted-server tests

## Global Constraints

- Approved design: [`docs/superpowers/specs/2026-07-16-github-revocation-reconnect-design.md`](../specs/2026-07-16-github-revocation-reconnect-design.md).
- Treat exact `incorrect_client_credentials` as terminal only on HTTP 200 or 400.
- Redirects, 401, 429, 5xx, malformed responses, and unknown error codes remain transient and sanitized.
- Never log or return a token, device code, provider response body, or Keychain value.
- A terminal result deletes the unusable Keychain entry and persists `reconnect_required`; installation and repository metadata remain non-secret recovery state.
- Reuse `june://connectors-changed`; add no frontend fetch, DTO, status, copy, package, permission, database migration, June API route, or GitHub write.
- Complete and live-verify this plan before implementing GitHub agent reads.

---

### Task 1: Classify the live revoked-grant response

**Files:**

- Modify: `src-tauri/src/connectors/github_auth.rs`

**Interfaces:**

- Consumes: `GitHubAuthClient::refresh_tokens(client_id, refresh_token)`
- Produces: `RefreshOutcome::InvalidGrant` for exact `incorrect_client_credentials` on definitive HTTP 200/400 responses
- Preserves: `github_refresh_failed` for every unsafe status, malformed response, and unknown error

- [ ] **Step 1: Add the failing protocol regression**

Extend `bad_refresh_token_is_definitive_but_other_failures_are_sanitized` with the live response on both definitive statuses:

```rust
for status in [200, 400] {
    let (base_url, server) = scripted_server(vec![(
        ResponseFixture::json(
            status,
            r#"{"error":"incorrect_client_credentials"}"#,
        ),
        RequestExpectations {
            refresh_token: Some("revoked-live-refresh"),
            ..RequestExpectations::default()
        },
    )])
    .await;
    let client = GitHubAuthClient::for_test(&base_url).expect("test client");

    assert!(matches!(
        client
            .refresh_tokens("Iv23example", "revoked-live-refresh")
            .await
            .expect("live revocation must be definitive"),
        RefreshOutcome::InvalidGrant
    ));
    server.await.expect("server task");
}
```

Extend the unsafe-status loop so the same exact body remains transient on
redirect, unauthorized, rate-limit, and upstream-failure responses:

```rust
for status in [302, 401, 429, 500] {
    let (base_url, server) = scripted_server(vec![(
        ResponseFixture::json(
            status,
            r#"{"error":"incorrect_client_credentials"}"#,
        ),
        RequestExpectations::default(),
    )])
    .await;
    let client = GitHubAuthClient::for_test(&base_url).expect("test client");
    let error = client
        .refresh_tokens("Iv23example", "revoked-live-refresh")
        .await
        .expect_err("unsafe status must remain transient");

    assert_eq!(error.code, "github_refresh_failed");
    assert!(!error.message.contains("incorrect_client_credentials"));
    server.await.expect("server task");
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_auth::tests::bad_refresh_token_is_definitive_but_other_failures_are_sanitized
```

Expected: the HTTP 200/400 live-response assertions fail with
`github_refresh_failed`; the unsafe-status assertions already pass.

- [ ] **Step 3: Add the exact error to the existing allowlist**

Replace `is_invalid_refresh` with:

```rust
fn is_invalid_refresh(error: &str) -> bool {
    matches!(
        error,
        "bad_refresh_token"
            | "invalid_grant"
            | "expired_token"
            | "revoked_token"
            | "incorrect_client_credentials"
    )
}
```

Do not change `can_invalidate_refresh`; its complete implementation remains:

```rust
fn can_invalidate_refresh(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::OK | reqwest::StatusCode::BAD_REQUEST
    )
}
```

- [ ] **Step 4: Run the focused protocol suite and verify GREEN**

Run:

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_auth::tests
```

Expected: all GitHub auth tests pass; unsafe statuses still return only the
sanitized `github_refresh_failed` error.

- [ ] **Step 5: Commit the protocol correction**

```bash
git add src-tauri/src/connectors/github_auth.rs
git commit -m "fix: classify revoked GitHub grants"
```

---

### Task 2: Synchronize terminal refresh state with the settings view

**Files:**

- Modify: `src-tauri/src/connectors/github.rs`
- Modify: `src-tauri/src/connectors/github_commands.rs`

**Interfaces:**

- Consumes: `github::installations_refresh(client, vault, repositories, config) -> Result<GitHubConnection, AppError>`
- Produces: `github_refresh_changes_connector_state(&Result<GitHubConnection, AppError>) -> bool`
- Preserves: the original success or error returned by `github_installations_refresh`
- Emits: existing `june://connectors-changed` only for success or `github_reconnect_required`

- [ ] **Step 1: Add the failing end-to-end service regression**

Add this test beside the existing refresh tests in `github.rs`:

```rust
#[tokio::test]
async fn live_revocation_deletes_custody_and_marks_reconnect_without_rediscovery() {
    let repositories = test_repositories().await;
    seed_snapshot(
        &repositories,
        "123",
        "connected",
        None,
        Some(r#"{"pull":true}"#),
    )
    .await;
    let vault = InMemoryGitHubTokenVault::default();
    vault
        .insert(stored_tokens(
            "123",
            "access-revoked",
            "refresh-revoked",
            now_unix() + 3_600,
        ))
        .await;
    let (base_url, server) = scripted_server(vec![
        unauthorized_fixture("access-revoked"),
        (
            ResponseFixture::json(
                200,
                r#"{"error":"incorrect_client_credentials"}"#,
            ),
            RequestExpectations {
                client_id: Some("Iv23example"),
                refresh_token: Some("refresh-revoked"),
                grant_type: Some("refresh_token"),
                ..RequestExpectations::default()
            },
        ),
    ])
    .await;
    let client = GitHubAuthClient::for_test(&base_url).expect("test client");

    let error = installations_refresh(&client, &vault, &repositories, &config())
        .await
        .expect_err("revoked authorization must require reconnect");

    assert_eq!(error.code, "github_reconnect_required");
    assert!(vault.token("123").await.is_none());
    let snapshot = repositories.github_snapshot().await.unwrap().unwrap();
    assert_eq!(snapshot.connection.status, "reconnect_required");
    assert_eq!(snapshot.repositories.len(), 1);
    let captures = server.await.expect("server task");
    assert_eq!(captures.len(), 2, "must not retry discovery after terminal refresh");
}
```

- [ ] **Step 2: Add the failing event-decision tests**

In `github_commands.rs`, add the pure decision tests:

```rust
#[test]
fn refresh_event_is_emitted_only_when_connector_state_can_change() {
    let connected = GitHubConnection {
        github_user_id: "123".into(),
        login: "octocat".into(),
        avatar_url: None,
        status: GitHubConnectionStatus::Connected,
        installations: Vec::new(),
    };
    assert!(super::github_refresh_changes_connector_state(&Ok(connected)));
    assert!(super::github_refresh_changes_connector_state(&Err(AppError::new(
        "github_reconnect_required",
        "GitHub access expired. Reconnect it in settings.",
    ))));
    assert!(!super::github_refresh_changes_connector_state(&Err(AppError::new(
        "github_refresh_failed",
        "Could not refresh GitHub access.",
    ))));
}
```

Add `AppError` to the test module imports.

- [ ] **Step 3: Run both tests and verify RED**

Run:

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked live_revocation_deletes_custody_and_marks_reconnect_without_rediscovery
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked refresh_event_is_emitted_only_when_connector_state_can_change
```

Expected: the service test fails until Task 1 is present; the command test
fails to compile because `github_refresh_changes_connector_state` does not
exist.

- [ ] **Step 4: Make the command event decision explicit**

Add this private helper above the Tauri commands:

```rust
fn github_refresh_changes_connector_state(
    result: &Result<GitHubConnection, AppError>,
) -> bool {
    result.is_ok()
        || result
            .as_ref()
            .is_err_and(|error| error.code == "github_reconnect_required")
}
```

Replace the body after repository construction in
`github_installations_refresh` with:

```rust
let result = github::installations_refresh(&client, &vault, &repositories, &config).await;
if github_refresh_changes_connector_state(&result) {
    super::emit_connectors_changed(&app);
}
result
```

This must not use `?` before the event decision. Event delivery remains
best-effort through the existing helper and never replaces `result`.

- [ ] **Step 5: Run the focused GitHub service and command suites**

Run:

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github::tests
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_commands::tests
```

Expected: all tests pass; the terminal service path deletes custody, retains
non-secret repository metadata, persists reconnect state, and performs no
second discovery.

- [ ] **Step 6: Run Rust formatting and lint gates**

Run:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
CARGO_INCREMENTAL=0 cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
git diff --check
```

Expected: every command exits 0 with no new warning.

- [ ] **Step 7: Commit terminal-state synchronization**

```bash
git add src-tauri/src/connectors/github.rs src-tauri/src/connectors/github_commands.rs
git commit -m "fix: synchronize GitHub revocation state"
```

## Live prerequisite verification

After both tasks and before the agent-read plan:

1. Run June with the staging GitHub App and the existing revoked authorization.
2. Click **Refresh** once.
3. Verify the row changes immediately to **Reconnect required**.
4. Verify the GitHub Keychain item is absent while the non-secret installation
   and selected-repository rows remain for recovery.
5. Complete device authorization again and verify **Connected** returns with
   only `open-software-network/test-repo`.
6. Record only status, timestamps, and row counts; never record a token or raw
   provider body.

Run the complete prerequisite gate:

```bash
CARGO_INCREMENTAL=0 make verify
```

Expected: the full repository gate passes before GitHub agent-read work starts.
