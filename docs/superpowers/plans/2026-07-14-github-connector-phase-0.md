# GitHub Connector Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a staging-only GitHub connector slice that authenticates with GitHub App device flow, keeps rotating user tokens in the OS Keychain, and persists the connected user plus authorized installations and repositories for `open-software-network/test-repo`.

**Architecture:** Keep GitHub beside the existing Google connector instead of generalizing the connector stack. A GitHub-specific protocol client owns device flow, token refresh, and read-only discovery; a GitHub-specific service coordinates Keychain and SQLite state; narrow Tauri commands expose only non-secret state to React. GitHub traffic stays desktop-to-GitHub, with no June API dependency and no GitHub write tools in this phase.

**Tech Stack:** Rust, Tauri 2, Tokio, reqwest, sqlx/SQLite, keyring, zeroize, React 18, TypeScript, Vitest, Testing Library, Biome, central-icons.

---

## Ground rules

- Approved design: [`docs/superpowers/specs/2026-07-14-github-connector-phase-0-design.md`](../specs/2026-07-14-github-connector-phase-0-design.md).
- Product contract: [`docs/plugins/github-prd.md`](../../plugins/github-prd.md), [`docs/plugins/github-implementation-plan.md`](../../plugins/github-implementation-plan.md), and [`docs/adr/0016-private-connectors-local-mode.md`](../../adr/0016-private-connectors-local-mode.md).
- Phase 0 performs no GitHub mutations. Do not add MCP servers, agent tools, routines, webhooks, installation-token minting, a client secret, or a private key.
- Store GitHub numeric identifiers as decimal strings in Rust DTOs, TypeScript, and SQLite so JavaScript never rounds them.
- Never place access tokens, refresh tokens, or device codes in SQLite, logs, errors, Tauri DTOs, telemetry, or test snapshots.
- Keep all existing Google connector commands, tables, tests, and UI behavior working.
- Do not add a package. The existing Rust and frontend dependencies cover this work.
- All UI copy must follow sentence case, use ordinary hyphens, use central-icons, and use tokens for size, color, spacing, typography, and controls.
- The public staging identifiers are:
  - Client ID: `Iv23lihKGi1yIb8QZm9L`
  - App slug: `june-staging`
  - App ID `4296474` is fixture metadata only and must not be used at runtime.

## Task 1: Add the GitHub App configuration seam

**Files:**

- Create: `src-tauri/src/connectors/github.rs`
- Modify: `src-tauri/src/connectors/mod.rs`
- Modify: `src-tauri/build.rs`
- Modify: `Makefile`

- [ ] Add failing configuration tests to `src-tauri/src/connectors/github.rs`.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_requires_both_public_identifiers() {
        assert_eq!(
            config_from_values("".into(), "june-staging".into())
                .unwrap_err()
                .code,
            "github_not_configured"
        );
        assert_eq!(
            config_from_values("Iv23example".into(), "".into())
                .unwrap_err()
                .code,
            "github_not_configured"
        );
    }

    #[test]
    fn config_builds_installation_url_from_slug() {
        let config = config_from_values(
            "Iv23lihKGi1yIb8QZm9L".into(),
            "june-staging".into(),
        )
        .unwrap();
        assert_eq!(
            config.installation_url(),
            "https://github.com/apps/june-staging/installations/new"
        );
    }

    #[test]
    fn config_rejects_values_that_can_change_the_github_origin_or_path() {
        assert!(config_from_values("bad client".into(), "june-staging".into()).is_err());
        assert!(config_from_values("Iv23example".into(), "../login".into()).is_err());
        assert!(config_from_values("Iv23example".into(), "-june".into()).is_err());
    }
}
```

- [ ] Run the focused test and confirm it fails because the module and helpers do not exist.

Run: `cargo test --manifest-path src-tauri/Cargo.toml connectors::github::tests --locked`

Expected: compilation fails on unresolved `config_from_values` or the missing `github` module.

- [ ] Add the minimal configuration implementation.

```rust
use crate::domain::types::AppError;

const GITHUB_APP_CLIENT_ID_ENV: &str = "GITHUB_APP_CLIENT_ID";
const GITHUB_APP_SLUG_ENV: &str = "GITHUB_APP_SLUG";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitHubAppConfig {
    pub client_id: String,
    pub slug: String,
}

impl GitHubAppConfig {
    pub fn installation_url(&self) -> String {
        format!("https://github.com/apps/{}/installations/new", self.slug)
    }
}

fn config_from_values(
    client_id: String,
    slug: String,
) -> Result<GitHubAppConfig, AppError> {
    let client_id = client_id.trim();
    let slug = slug.trim();
    let valid_client_id = (8..=128).contains(&client_id.len())
        && client_id.bytes().all(|byte| byte.is_ascii_alphanumeric());
    let valid_slug = (1..=100).contains(&slug.len())
        && slug.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && !slug.starts_with('-')
        && !slug.ends_with('-');
    if !valid_client_id || !valid_slug {
        return Err(AppError::new(
            "github_not_configured",
            "GitHub is not configured for this build.",
        ));
    }
    Ok(GitHubAppConfig {
        client_id: client_id.to_owned(),
        slug: slug.to_owned(),
    })
}

pub fn github_app_config() -> Result<GitHubAppConfig, AppError> {
    crate::os_accounts::load_local_env();
    config_from_values(
        super::env_or_build_trimmed(
            GITHUB_APP_CLIENT_ID_ENV,
            option_env!("GITHUB_APP_CLIENT_ID"),
        ),
        super::env_or_build_trimmed(
            GITHUB_APP_SLUG_ENV,
            option_env!("GITHUB_APP_SLUG"),
        ),
    )
}
```

In `connectors/mod.rs`, export `pub mod github;`. The child module can reuse the existing private `env_or_build_trimmed` helper through `super::env_or_build_trimmed` without widening its visibility.

- [ ] Add Cargo build invalidation for both public values in `src-tauri/build.rs`.

```rust
println!("cargo:rerun-if-env-changed=GITHUB_APP_CLIENT_ID");
println!("cargo:rerun-if-env-changed=GITHUB_APP_SLUG");
```

- [ ] Add the approved staging identifiers to `make dev-staging`, before `pnpm tauri:dev`.

```make
		OS_JUNE_DEV_PLAINTEXT_TOKEN_STORE=0 \
		GITHUB_APP_CLIENT_ID=Iv23lihKGi1yIb8QZm9L \
		GITHUB_APP_SLUG=june-staging \
```

This explicit override prevents a developer's local `.env` from placing real staging tokens in the plaintext test fixture. Do not add the App ID, a client secret, or a private key.

- [ ] Run the focused tests and formatting.

Run: `cargo test --manifest-path src-tauri/Cargo.toml connectors::github::tests --locked`

Expected: 3 tests pass.

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`

Expected: exit 0.

- [ ] Commit the configuration seam.

```bash
git add src-tauri/src/connectors/github.rs src-tauri/src/connectors/mod.rs src-tauri/build.rs Makefile
git commit -m "feat: add GitHub App configuration"
```

## Task 2: Persist non-secret GitHub connection state transactionally

**Files:**

- Create: `src-tauri/migrations/014_github_connections.sql`
- Modify: `src-tauri/src/db/migrations.rs`
- Modify: `src-tauri/src/db/repositories.rs`

- [ ] Add a failing repository test in the existing `#[cfg(test)]` module in `src-tauri/src/db/repositories.rs`.

The test must use the existing in-memory database helper and prove all of these behaviors in one deterministic flow:

```rust
#[tokio::test]
async fn github_snapshot_replacement_and_disconnect_are_atomic() {
    let repos = test_repositories().await;
    let connection = github_connection_fixture("123", "octocat", "connected");
    let installation = github_installation_fixture("456", "123", "open-software-network");
    let first = vec![
        github_repository_fixture("789", "456", "open-software-network/test-repo"),
        github_repository_fixture("790", "456", "open-software-network/removed-repo"),
    ];

    repos
        .replace_github_snapshot(&connection, &[installation.clone()], &first)
        .await
        .unwrap();
    let stored = repos.github_snapshot().await.unwrap().unwrap();
    assert_eq!(stored.repositories.len(), 2);

    repos
        .replace_github_snapshot(&connection, &[installation], &first[..1])
        .await
        .unwrap();
    let refreshed = repos.github_snapshot().await.unwrap().unwrap();
    assert_eq!(
        refreshed.repositories
            .iter()
            .map(|repository| repository.repository_id.as_str())
            .collect::<Vec<_>>(),
        vec!["789"]
    );

    repos.delete_github_state("123").await.unwrap();
    assert!(repos.github_snapshot().await.unwrap().is_none());
}
```

- [ ] Run the focused test and confirm it fails on the missing migration, records, and methods.

Run: `cargo test --manifest-path src-tauri/Cargo.toml github_snapshot_replacement_and_disconnect_are_atomic --locked`

Expected: compilation fails on unresolved GitHub repository types or methods.

- [ ] Create migration `014_github_connections.sql` with the exact non-secret schema.

```sql
CREATE TABLE IF NOT EXISTS github_connections (
  github_user_id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  avatar_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('connected', 'setup_incomplete', 'reconnect_required')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS github_installations (
  installation_id TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_login TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  management_url TEXT NOT NULL,
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  permissions_json TEXT NOT NULL DEFAULT '{}',
  suspended_at TEXT,
  last_refreshed_at TEXT NOT NULL,
  FOREIGN KEY (github_user_id) REFERENCES github_connections(github_user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS github_repositories (
  repository_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  owner_login TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  is_private INTEGER NOT NULL CHECK (is_private IN (0, 1)),
  is_archived INTEGER NOT NULL CHECK (is_archived IN (0, 1)),
  permissions_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES github_installations(installation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_github_installations_user
  ON github_installations(github_user_id);

CREATE INDEX IF NOT EXISTS idx_github_repositories_installation
  ON github_repositories(installation_id);
```

- [ ] Wire migration 014 after migration 013 in `run_migrations`, using the repository's existing `split(';')` pattern.

```rust
for statement in include_str!("../../migrations/014_github_connections.sql").split(';') {
    let statement = statement.trim();
    if !statement.is_empty() {
        query(statement).execute(_pool).await?;
    }
}
```

- [ ] Add the repository records and aggregate. Keep GitHub IDs as `String`.

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitHubConnectionRecord {
    pub github_user_id: String,
    pub login: String,
    pub avatar_url: Option<String>,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitHubInstallationRecord {
    pub installation_id: String,
    pub github_user_id: String,
    pub owner_id: String,
    pub owner_login: String,
    pub owner_type: String,
    pub management_url: String,
    pub repository_selection: String,
    pub permissions_json: String,
    pub suspended_at: Option<String>,
    pub last_refreshed_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitHubRepositoryRecord {
    pub repository_id: String,
    pub installation_id: String,
    pub owner_login: String,
    pub name: String,
    pub full_name: String,
    pub is_private: bool,
    pub is_archived: bool,
    pub permissions_json: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitHubSnapshotRecord {
    pub connection: GitHubConnectionRecord,
    pub installations: Vec<GitHubInstallationRecord>,
    pub repositories: Vec<GitHubRepositoryRecord>,
}
```

- [ ] Implement `replace_github_snapshot`, `github_snapshot`, `get_github_installation`, `set_github_connection_status`, and `delete_github_state` on `Repositories`.

`replace_github_snapshot` must begin one SQLite transaction and perform this exact order:

1. Delete any connection whose `github_user_id` differs from the incoming user, enforcing one connected GitHub user per June profile.
2. Upsert the connection, preserving its original `created_at` on conflict.
3. Delete the incoming user's existing installations. Cascading foreign keys remove stale repositories.
4. Insert the complete new installation set.
5. Insert the complete new repository set.
6. Commit only after every insert succeeds.

Serialize permission maps before calling the repository, reject serialization errors in the service layer, and bind booleans as `i64::from(value)`. `github_snapshot` must order installations by `owner_login, installation_id` and repositories by `full_name, repository_id` for stable DTOs and tests.

`management_url` is the installation `html_url` returned by GitHub, retained only so the Rust command can open the correct installation settings page. Validate it as an HTTPS `github.com` URL with an installation-settings path before persistence. `last_refreshed_at` is repository metadata used for diagnosis and refresh tests; it is intentionally not exposed in the Phase 0 frontend DTO.

- [ ] Add an explicit migration test proving the tables exist after `run_migrations` and a second repository test proving a failed insert leaves the previous snapshot unchanged.

Use an invalid `repository_selection` value to trigger the `CHECK` constraint inside `replace_github_snapshot`, then assert the original snapshot is intact.

- [ ] Run the focused repository and migration tests.

Run: `cargo test --manifest-path src-tauri/Cargo.toml github_ --locked`

Expected: all GitHub persistence tests pass, including replacement, rollback, and disconnect.

- [ ] Commit the non-secret persistence layer.

```bash
git add src-tauri/migrations/014_github_connections.sql src-tauri/src/db/migrations.rs src-tauri/src/db/repositories.rs
git commit -m "feat: persist GitHub connector state"
```

## Task 3: Store rotating GitHub tokens only in the Keychain

**Files:**

- Create: `src-tauri/src/connectors/github_store.rs`
- Modify: `src-tauri/src/connectors/mod.rs`
- Modify: `src-tauri/src/hermes_bridge.rs`

- [ ] Add failing token-store tests at the bottom of `github_store.rs`.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_uses_a_separate_keychain_namespace() {
        assert_eq!(keychain_service_for_build(false), "co.opensoftware.june.github");
        assert_eq!(keychain_service_for_build(true), "co.opensoftware.june-dev.github");
        assert_ne!(keychain_service_for_build(false), "co.opensoftware.june.google");
    }

    #[test]
    fn stored_tokens_round_trip_without_debug_output() {
        let tokens = StoredGitHubTokens {
            github_user_id: "123".into(),
            access_token: "access-secret".into(),
            refresh_token: "refresh-secret".into(),
            expires_at_unix: 2_000_000_000,
            refresh_token_expires_at_unix: 2_100_000_000,
        };
        let encoded = serde_json::to_string(&tokens).unwrap();
        let decoded: StoredGitHubTokens = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.access_token, "access-secret");
        assert!(!format!("{tokens:?}").contains("access-secret"));
    }
}
```

- [ ] Run the focused test and confirm it fails because the store does not exist.

Run: `cargo test --manifest-path src-tauri/Cargo.toml connectors::github_store::tests --locked`

Expected: compilation fails on the missing module or types.

- [ ] Implement the GitHub token container and platform store.

```rust
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

const RELEASE_KEYCHAIN_SERVICE: &str = "co.opensoftware.june.github";
const DEV_KEYCHAIN_SERVICE: &str = "co.opensoftware.june-dev.github";
const PLAINTEXT_TOKEN_STORE_ENV: &str = "OS_JUNE_DEV_PLAINTEXT_TOKEN_STORE";
const DEV_TOKEN_FILENAME: &str = "dev-github-connector-tokens.json";

#[derive(Serialize, Deserialize, Clone, Zeroize, ZeroizeOnDrop)]
pub struct StoredGitHubTokens {
    pub github_user_id: String,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at_unix: i64,
    pub refresh_token_expires_at_unix: i64,
}

impl std::fmt::Debug for StoredGitHubTokens {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StoredGitHubTokens")
            .field("github_user_id", &self.github_user_id)
            .field("access_token", &"[REDACTED]")
            .field("refresh_token", &"[REDACTED]")
            .field("expires_at_unix", &self.expires_at_unix)
            .field(
                "refresh_token_expires_at_unix",
                &self.refresh_token_expires_at_unix,
            )
            .finish()
    }
}

pub async fn load_github_tokens(
    github_user_id: &str,
) -> Result<Option<StoredGitHubTokens>, AppError>;
pub async fn store_github_tokens(
    github_user_id: &str,
    tokens: &StoredGitHubTokens,
) -> Result<(), AppError>;
pub async fn delete_github_tokens(github_user_id: &str) -> Result<(), AppError>;
```

Implement the same platform policy as the existing Google store, but with the GitHub services and filename above:

- Release builds always use Keychain.
- Development builds use Keychain unless `OS_JUNE_DEV_PLAINTEXT_TOKEN_STORE=1`.
- The plaintext development file mirrors the Google test fixture location at `src-tauri/target/dev-github-connector-tokens.json`, contains only a JSON map keyed by GitHub user ID, and is never enabled implicitly.
- A missing Keychain entry returns `Ok(None)`.
- Store and load validate that the Keychain account key equals `tokens.github_user_id`; a mismatch is `github_token_store_invalid` and never yields a usable token.
- Parsing and Keychain errors use stable codes such as `github_token_store_unavailable` and never include raw payloads.
- `delete_github_tokens` treats an already-missing entry as success.

- [ ] Add pure temporary-directory tests for plaintext load, overwrite rotation, deletion, invalid JSON redaction, and Unix file mode `0600`, matching the existing Google store coverage. The tests call helpers with an explicit path and never mutate the process environment or shared `target/` fixture.

- [ ] Add the GitHub development file to both Hermes secret defenses in `src-tauri/src/hermes_bridge.rs`.

Append `src-tauri/target/dev-github-connector-tokens.json` to `secret_read_paths` beside the Google file and add `dev-github-connector-tokens.json` to `is_sensitive_file_name`. Add `hidden_secret_filter_rejects_connector_token_fixtures` to prove both connector token filenames are denied. This is required even though plaintext mode is opt-in: a sandboxed agent must never read the fixture.

- [ ] Export `pub mod github_store;` from `connectors/mod.rs`. Keep the explicit redacting `Debug` implementation even though the type is cloneable for Keychain and in-memory test adapters; every clone still zeroizes on drop.

- [ ] Run the focused store tests and Rust formatting.

Run: `cargo test --manifest-path src-tauri/Cargo.toml connectors::github_store::tests --locked`

Expected: all GitHub store tests pass.

Run: `cargo test --manifest-path src-tauri/Cargo.toml hidden_secret_filter_rejects_connector_token_fixtures --locked`

Expected: the Hermes secret-path regression test passes.

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`

Expected: exit 0.

- [ ] Commit the GitHub token store.

```bash
git add src-tauri/src/connectors/github_store.rs src-tauri/src/connectors/mod.rs src-tauri/src/hermes_bridge.rs
git commit -m "feat: secure GitHub connector tokens"
```

## Task 4: Implement the GitHub device-flow and discovery protocol client

**Files:**

- Create: `src-tauri/src/connectors/github_auth.rs`
- Modify: `src-tauri/src/connectors/mod.rs`

- [ ] Add failing protocol tests in `github_auth.rs` for request construction and response classification.

```rust
#[test]
fn device_and_refresh_forms_never_include_a_secret() {
    let device = device_code_form("Iv23example");
    assert_eq!(device, vec![("client_id", "Iv23example".to_owned())]);

    let refresh = refresh_form("Iv23example", "refresh-value");
    assert!(refresh.iter().any(|(key, _)| *key == "client_id"));
    assert!(refresh.iter().any(|(key, _)| *key == "refresh_token"));
    assert!(refresh.iter().all(|(key, _)| *key != "client_secret"));
}

#[test]
fn polling_errors_map_to_stable_outcomes() {
    assert!(matches!(
        classify_token_body(r#"{"error":"authorization_pending"}"#).unwrap(),
        PollOutcome::Pending
    ));
    assert!(matches!(
        classify_token_body(r#"{"error":"slow_down"}"#).unwrap(),
        PollOutcome::SlowDown
    ));
    assert_eq!(
        classify_token_body(r#"{"error":"access_denied"}"#)
            .unwrap_err()
            .code,
            "github_connect_denied"
    );
    assert_eq!(
        classify_token_body(r#"{"error":"expired_token"}"#)
            .unwrap_err()
            .code,
            "github_connect_expired"
    );
}
```

- [ ] Add an async local-server test, using `tokio::net::TcpListener`, that captures the device-code request and returns a fixture response.

The assertion must prove all of the following without using the public network:

```rust
assert_eq!(request.method, "POST");
assert_eq!(request.path, "/login/device/code");
assert!(request.headers.contains("accept: application/json"));
assert!(request.has_expected_public_client_id);
assert_eq!(request.form_field_names, BTreeSet::from(["client_id".into()]));
assert_eq!(prompt.user_code, "ABCD-EFGH");
assert_eq!(prompt.verification_uri, "https://github.com/login/device");
```

- [ ] Run the focused tests and confirm they fail on the missing protocol implementation.

Run: `cargo test --manifest-path src-tauri/Cargo.toml connectors::github_auth::tests --locked`

Expected: compilation fails on unresolved protocol types and helpers.

- [ ] Add the public non-secret protocol types and private wire types.

```rust
const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const API_BASE_URL: &str = "https://api.github.com";
const GITHUB_API_VERSION: &str = "2026-03-10";
const MAX_PAGES: u32 = 100;
const MAX_INSTALLATIONS: usize = 100;
const MAX_REPOSITORIES: usize = 10_000;
const MAX_DISCOVERY_REQUESTS: usize = 512;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_DISCOVERY_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubDevicePrompt {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_at_unix: i64,
    pub interval_seconds: u64,
}

impl std::fmt::Debug for GitHubDevicePrompt {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GitHubDevicePrompt")
            .field("user_code", &"[REDACTED]")
            .field("verification_uri", &self.verification_uri)
            .field("expires_at_unix", &self.expires_at_unix)
            .field("interval_seconds", &self.interval_seconds)
            .finish()
    }
}

#[derive(Zeroize, ZeroizeOnDrop)]
struct PendingDeviceCode {
    device_code: String,
    interval_seconds: u64,
    expires_at_unix: i64,
}

enum PollOutcome {
    Pending,
    SlowDown,
    Authorized(GitHubTokenGrant),
}

pub enum RefreshOutcome {
    Refreshed(GitHubTokenGrant),
    InvalidGrant,
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub(super) struct GitHubTokenGrant {
    access_token: String,
    refresh_token: String,
    expires_at_unix: i64,
    refresh_token_expires_at_unix: i64,
}

impl GitHubTokenGrant {
    pub(super) fn into_stored(self, github_user_id: String) -> StoredGitHubTokens;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredGitHubUser {
    pub github_user_id: String,
    pub login: String,
    pub avatar_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredGitHubInstallation {
    pub installation_id: String,
    pub owner_id: String,
    pub owner_login: String,
    pub owner_type: String,
    pub management_url: String,
    pub repository_selection: String,
    pub permissions: BTreeMap<String, String>,
    pub suspended_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredGitHubRepository {
    pub repository_id: String,
    pub installation_id: String,
    pub owner_login: String,
    pub name: String,
    pub full_name: String,
    pub is_private: bool,
    pub is_archived: bool,
    pub permissions: BTreeMap<String, bool>,
}
```

`PendingDeviceCode` is never serialized or debug-printed. Convert every GitHub numeric ID to a decimal `String` as soon as its wire response is parsed.

Keep the two permission shapes distinct: GitHub installation permissions are access-level strings, while repository/user permissions are booleans. Serialize each typed map to its existing `permissions_json` column and reject any provider response that does not match the expected shape.

- [ ] Implement `GitHubAuthClient` with injectable endpoints for tests and fixed production defaults.

```rust
#[derive(Clone)]
pub struct GitHubAuthClient {
    http: reqwest::Client,
    device_code_url: String,
    access_token_url: String,
    api_base_url: String,
}

impl GitHubAuthClient {
    pub fn production() -> Result<Self, AppError>;
    #[cfg(test)]
    pub(crate) fn for_test(base_url: &str) -> Result<Self, AppError>;

    async fn start_device_flow(
        &self,
        client_id: &str,
    ) -> Result<(GitHubDevicePrompt, PendingDeviceCode), AppError>;

    async fn poll_device_flow_once(
        &self,
        client_id: &str,
        pending: &PendingDeviceCode,
    ) -> Result<PollOutcome, AppError>;

    pub async fn refresh_tokens(
        &self,
        client_id: &str,
        refresh_token: &str,
    ) -> Result<RefreshOutcome, AppError>;

    pub async fn current_user(
        &self,
        access_token: &str,
    ) -> Result<DiscoveredGitHubUser, AppError>;

    pub async fn installations_and_repositories(
        &self,
        access_token: &str,
    ) -> Result<(
        Vec<DiscoveredGitHubInstallation>,
        Vec<DiscoveredGitHubRepository>,
    ), AppError>;
}
```

The client requirements are exact:

- `reqwest::Client` has a 30 second timeout, June user agent, and no proxy, matching the existing connector client.
- OAuth endpoints send `Accept: application/json` and form-encoded bodies.
- API endpoints send `Accept: application/vnd.github+json`, `Authorization: Bearer <token>`, `X-GitHub-Api-Version: 2026-03-10`, and a user agent.
- Device start sends only `client_id`.
- Device poll sends only `client_id`, `device_code`, and `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
- Refresh sends only `client_id`, `refresh_token`, and `grant_type=refresh_token`.
- Token success requires non-empty access and refresh tokens plus both expiry values. Store absolute Unix expiry instants.
- The device response is accepted only when `verification_uri` is exactly `https://github.com/login/device`; any other origin, scheme, query, fragment, or path is `github_token_exchange_failed` and is never opened or returned to React.
- `authorization_pending` waits the current interval. `slow_down` adds five seconds to all later intervals. Cancellation remains responsive during waits.
- HTTP 401 maps to `github_reconnect_required`. HTTP 429 and 403 responses with rate-limit signals map to `github_rate_limited`, preserving only parsed `Retry-After`, `X-RateLimit-Reset`, and remaining-quota values in `AppError.details`. A 403 with `X-GitHub-SSO` maps to `github_installation_required` with safe `reason: "sso_required"` details; any SSO URL must pass the same HTTPS `github.com` allowlist before inclusion. Other discovery 403 responses map to `github_installation_required`. A collection 404 maps to `github_installation_required`; repository removal is detected by diffing the old and new stable ID sets and classified as `github_repository_access_removed`. Error messages never include response bodies.
- Device denial, expiry, and cancellation map to `github_connect_denied`, `github_connect_expired`, and `github_connect_canceled`. Malformed token responses map to `github_token_exchange_failed`, and refresh failures map to `github_refresh_failed`.
- `PollOutcome::Pending` and `PollOutcome::SlowDown` expose test-only stable classifications `github_connect_pending` and `github_connect_slow_down`; they control the internal wait loop and are not rendered as user failures.
- A suspended installation is retained with its timestamp and classified as `github_installation_suspended` when inspected, but the overall connection remains `setup_incomplete` unless another non-suspended installation has repositories.
- Discover with `GET /user`, `GET /user/installations?per_page=100&page=N`, and `GET /user/installations/{installation_id}/repositories?per_page=100&page=N`.
- Follow GitHub's `Link` header while it contains `rel="next"`, incrementing June's own numeric `page` parameter rather than fetching an arbitrary provider-supplied URL. Stop when `rel="next"` is absent and reject more than `MAX_PAGES` with `github_result_limit_exceeded`.
- Reject duplicate installation or repository IDs in one discovery response as `github_state_invalid` instead of letting later rows overwrite earlier authorization context.
- Enforce all aggregate caps above across the complete discovery, not once per installation. Read every response with `Response::chunk()` and stop before the per-response or aggregate byte limit is exceeded. Check the installation, repository, and request-count caps before issuing the next request.
- Suspended installations remain in the snapshot but contribute no repository bindings.
- Accept installation management URLs only when `reqwest::Url` parses them as HTTPS on `github.com` with an installation-settings path. Accept avatar URLs only from HTTPS `avatars.githubusercontent.com`; otherwise set `avatar_url` to `None` before the DTO reaches the webview.
- Refresh response `bad_refresh_token` and equivalent definitive invalid-grant responses produce `RefreshOutcome::InvalidGrant`; transport failures, 5xx, malformed success payloads, and other transient failures return sanitized `github_refresh_failed` errors.

- [ ] Expand the local-server tests to cover successful tokens, `slow_down`, refresh rotation, `bad_refresh_token`, a 401 response, 403 SSO headers, 403 and 429 rate limits, exactly-100 pagination with and without `Link: rel="next"`, two-page installation discovery, two-page repository discovery, invalid verification/management/avatar URLs, duplicate IDs, oversized bodies, and aggregate request/install/repository caps.

Fixtures must use fake secrets and assert error codes only. The captured-request helper must not derive raw `Debug`; it records redacted booleans and form-field names, never authorization-header values, device codes, refresh values, or raw form bodies.

- [ ] Run the focused protocol tests.

Run: `cargo test --manifest-path src-tauri/Cargo.toml connectors::github_auth::tests --locked`

Expected: all request, response, pagination, and redaction tests pass without internet access.

- [ ] Commit the GitHub protocol client.

```bash
git add src-tauri/src/connectors/github_auth.rs src-tauri/src/connectors/mod.rs
git commit -m "feat: implement GitHub device authentication"
```

## Task 5: Coordinate device flow, refresh, discovery, and local state

**Files:**

- Modify: `src-tauri/src/connectors/github_auth.rs`
- Modify: `src-tauri/src/connectors/github.rs`
- Modify: `src-tauri/src/connectors/github_store.rs`
- Modify: `src-tauri/src/db/repositories.rs`

- [ ] Add failing `GitHubConnectFlow` tests in `github_auth.rs`.

The tests must prove that only one pending device flow exists, a second start cancels the first, explicit cancellation interrupts a sleeping poll immediately, and denial or expiry returns no tokens.

```rust
#[tokio::test]
async fn a_delayed_first_start_cannot_replace_a_faster_second_start() {
    let server = DeviceFlowServer::with_delayed_first_response().await;
    let flow = Arc::new(GitHubConnectFlow::default());
    let first = tokio::spawn(start_fixture(flow.clone(), server.client()));
    server.wait_until_first_request_is_blocked().await;
    let second = tokio::spawn(start_fixture(flow.clone(), server.client()));
    server.release_second_then_first().await;

    assert_eq!(second.await.unwrap().unwrap().user_code, "NEW-CODE");
    assert_eq!(first.await.unwrap().unwrap_err().code, "github_connect_canceled");
    assert_eq!(flow.active_attempt_id().await, Some(2));
}
```

Also test explicit cancellation while polling. Do not expose `PendingDeviceCode` through a production public method or derive `Debug`, `Clone`, `Serialize`, or `Deserialize` for it. Test-only inspection helpers are `#[cfg(test)] pub(crate)`.

- [ ] Add failing service tests in `github.rs` using the Task 4 local HTTP server, Task 2 in-memory SQLite repository, and an in-memory token vault.

Define a small asynchronous vault seam so tests do not touch the real Keychain. Use a boxed future so the trait remains object-safe without adding `async-trait`:

```rust
use std::{future::Future, pin::Pin};

pub type GitHubVaultFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, AppError>> + Send + 'a>>;

pub trait GitHubTokenVault: Send + Sync {
    fn load<'a>(
        &'a self,
        github_user_id: &'a str,
    ) -> GitHubVaultFuture<'a, Option<StoredGitHubTokens>>;
    fn store<'a>(
        &'a self,
        github_user_id: &'a str,
        tokens: &'a StoredGitHubTokens,
    ) -> GitHubVaultFuture<'a, ()>;
    fn delete<'a>(&'a self, github_user_id: &'a str) -> GitHubVaultFuture<'a, ()>;
}

pub struct PlatformGitHubTokenVault;
```

`PlatformGitHubTokenVault` boxes and delegates directly to `load_github_tokens`, `store_github_tokens`, and `delete_github_tokens`. The in-memory test implementation owns a `Mutex<HashMap<String, StoredGitHubTokens>>` and clones zeroizing token values only at the vault boundary.

Add these service cases:

1. Successful authorization stores tokens by stable user ID and returns `connected` when one accessible repository is discovered.
2. Successful authorization returns `setup_incomplete` when no accessible repository exists and still stores the user connection.
3. A suspended installation is retained, contributes no repositories, and yields `setup_incomplete` when it is the only installation.
4. A second connected GitHub user replaces the prior SQLite snapshot and deletes the prior user's Keychain entry only after the new authorization and discovery succeed.
5. Access tokens within 60 seconds of expiry refresh before discovery and atomically replace both rotated token values.
6. Two concurrent refresh callers cause one provider refresh request.
7. A discovery 401 forces one refresh and one retry; a second 401 deletes usable tokens and marks the connection `reconnect_required`.
8. A discovery 401 followed by refresh `bad_refresh_token` deletes unusable tokens and marks `reconnect_required` without a second discovery request.
9. Repository removal, permission downgrade, and suspension replace or disable stale snapshot state by stable ID.
10. Disconnect deletes the Keychain entry and all GitHub rows.
11. A database failure never deletes the prior user's tokens and leaves no newly authorized orphan token.
12. Cancellation after token issuance, during `/user`, during installation discovery, before Keychain write, and before SQLite commit leaves no new token or connection row.
13. The debug-only one-shot force-refresh QA seam rotates both token values once; normal and release paths ignore it.
14. If GitHub rotates tokens but the atomic Keychain replacement fails, the connection becomes `reconnect_required` and the service never reuses the now-invalid old refresh token.
15. Loading a cached connection whose Keychain entry is missing marks and returns `reconnect_required` rather than presenting stale metadata as connected.

- [ ] Run the focused tests and confirm they fail on the missing flow and service orchestration.

Run: `cargo test --manifest-path src-tauri/Cargo.toml connectors::github --locked`

Expected: compilation fails on `GitHubConnectFlow`, the vault seam, or service functions.

- [ ] Implement the cancellable device-flow state in `github_auth.rs`.

```rust
#[derive(Default)]
pub struct GitHubConnectFlow {
    next_attempt_id: std::sync::atomic::AtomicU64,
    active: tokio::sync::Mutex<Option<ActiveGitHubAttempt>>,
    completion_lock: tokio::sync::Mutex<()>,
}

impl GitHubConnectFlow {
    pub async fn start(
        &self,
        client: &GitHubAuthClient,
        client_id: &str,
    ) -> Result<GitHubDevicePrompt, AppError>;

    pub(super) async fn wait(
        &self,
        client: &GitHubAuthClient,
        client_id: &str,
    ) -> Result<AuthorizedGitHubAttempt, AppError>;

    pub async fn cancel(&self) -> Result<(), AppError>;
}
```

`ActiveGitHubAttempt` contains a monotonically increasing ID, one `tokio::sync::watch` cancellation sender, and at most one pending device code. `start` installs the new attempt marker before awaiting the device-code request; after the response it stores the pending code only if the marker still matches. This prevents a delayed older start from replacing a newer prompt. `wait` takes the pending code and polls with `tokio::select!` over cancellation and `tokio::time::sleep`. It checks `expires_at_unix` before every request, adds five seconds after `slow_down`, and returns a private `AuthorizedGitHubAttempt` carrying the attempt ID, cancellation receiver, and zeroizing tokens.

The service holds `completion_lock` from token issuance through final commit or compensation. Every provider await is cancellation-selectable, and the service verifies the attempt ID immediately before and after each Keychain or SQLite side effect. Cancel or replacement after a side effect runs the same compensation path before returning `github_connect_canceled`. A newer attempt may poll while cleanup runs but cannot commit until the older attempt releases `completion_lock`.

- [ ] Add service DTOs and snapshot conversion in `github.rs`.

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitHubConnectionStatus {
    Connected,
    SetupIncomplete,
    ReconnectRequired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepository {
    pub repository_id: String,
    pub installation_id: String,
    pub owner_login: String,
    pub name: String,
    pub full_name: String,
    pub private: bool,
    pub archived: bool,
    pub permissions: BTreeMap<String, bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubInstallation {
    pub installation_id: String,
    pub owner_id: String,
    pub owner_login: String,
    pub owner_type: String,
    pub repository_selection: String,
    pub permissions: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suspended_at: Option<String>,
    pub repositories: Vec<GitHubRepository>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubConnection {
    pub github_user_id: String,
    pub login: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub status: GitHubConnectionStatus,
    pub installations: Vec<GitHubInstallation>,
}
```

The snapshot converter must fail closed on malformed JSON permissions in SQLite, nest repositories under the matching stable installation ID, and ignore no row silently. An orphan repository is a sanitized `github_state_invalid` error.

- [ ] Implement service functions that accept a `Repositories`, `GitHubAuthClient`, and `GitHubTokenVault` seam.

```rust
pub async fn complete_connect(
    flow: &GitHubConnectFlow,
    client: &GitHubAuthClient,
    vault: &dyn GitHubTokenVault,
    repositories: &Repositories,
    config: &GitHubAppConfig,
) -> Result<GitHubConnection, AppError>;

pub async fn connection_get(
    vault: &dyn GitHubTokenVault,
    repositories: &Repositories,
) -> Result<Option<GitHubConnection>, AppError>;

pub async fn installations_refresh(
    client: &GitHubAuthClient,
    vault: &dyn GitHubTokenVault,
    repositories: &Repositories,
    config: &GitHubAppConfig,
) -> Result<GitHubConnection, AppError>;

pub async fn disconnect(
    vault: &dyn GitHubTokenVault,
    repositories: &Repositories,
) -> Result<(), AppError>;
```

Implement these invariants explicitly:

- Resolve `/user` before choosing the Keychain account key.
- Store the authorized token set only under the stable GitHub user ID.
- `connection_get` validates that a Keychain entry exists and its embedded stable user ID matches the SQLite connection. Missing or mismatched custody marks the cached row `reconnect_required` before returning it.
- Compute `connected` only when at least one non-suspended installation exposes at least one repository. Otherwise compute `setup_incomplete`.
- Serialize permission maps with `serde_json` before entering the repository transaction.
- When replacing another GitHub user, finish authorization and discovery first, load the old token set for compensation, store the new token set, delete the old entry, and then replace SQLite. If old-entry deletion fails, delete the new entry and leave SQLite unchanged. If SQLite replacement fails, restore the old entry and delete the new entry before returning the sanitized storage error.
- When reconnecting the same GitHub user, retain the prior token set in zeroizing memory until SQLite succeeds; restore it if the snapshot replacement fails.
- On a near-expiry token, coalesce refreshes with a per-user `tokio::sync::Mutex` stored in a `OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>>`, then reload the token after acquiring the lock before deciding to refresh.
- If the refresh token itself is expired or GitHub rejects it, delete the unusable token set, mark the connection `reconnect_required`, and return `github_reconnect_required`.
- A provider 401 may force one refresh and retry once. A second 401 deletes the token entry, sets `reconnect_required`, and returns `github_reconnect_required`.
- `RefreshOutcome::InvalidGrant` follows the same terminal reconnect path immediately; a transient `github_refresh_failed` leaves the existing token and snapshot intact for retry.
- A provider refresh that returns a new access token but omits a refresh token is invalid; never keep a half-rotated set.
- After GitHub returns a rotated set, persist access and refresh values in one Keychain JSON replacement. If that local write fails, treat the old refresh token as invalidated, best-effort delete the stale entry, mark SQLite `reconnect_required`, and return `github_reconnect_required`.
- `disconnect` deletes the Keychain entry first. Only delete SQLite state after secret deletion succeeds, preventing a silent orphaned credential.
- `cancel` invalidates the active attempt even after token issuance. Completion must check the same attempt ID through user lookup, discovery, token storage, and SQLite commit; a frontend generation guard alone is not sufficient.
- Add a private `installations_refresh_with_force` helper with the same client, vault, repositories, and config arguments as `installations_refresh`, plus `force_token_refresh: bool`. The normal command passes false, except a debug build may consume `OS_JUNE_GITHUB_FORCE_REFRESH_ONCE=1` once per process for the staging rotation probe. Compile the flag check behind `#[cfg(debug_assertions)]`; release builds always pass false. Never add this flag to `.env.example` or normal startup.

For the cancellation-at-side-effect tests, add a `#[cfg(test)]` completion-hook struct backed by `tokio::sync::Notify` and an in-memory vault that can block before store/delete. In sibling-module service tests, construct a fresh in-memory `SqlitePool` and call `run_migrations` directly; do not refer to the private `db::repositories::tests::test_repositories` helper. Make `GitHubAuthClient::for_test` and the redacting HTTP fixture server `#[cfg(test)] pub(crate)` so `github.rs` can reuse them.

- [ ] Run all connector Rust tests, including the existing Google suite.

Run: `cargo test --manifest-path src-tauri/Cargo.toml connectors:: --locked`

Expected: all GitHub and Google connector tests pass.

- [ ] Run Clippy on the Tauri target.

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings`

Expected: exit 0 with no warnings.

- [ ] Commit the connection service.

```bash
git add src-tauri/src/connectors/github_auth.rs src-tauri/src/connectors/github.rs src-tauri/src/connectors/github_store.rs src-tauri/src/db/repositories.rs
git commit -m "feat: coordinate GitHub connection state"
```

## Task 6: Expose a narrow Tauri command contract and TypeScript bindings

**Files:**

- Create: `src-tauri/src/connectors/github_commands.rs`
- Modify: `src-tauri/src/connectors/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/tauri.ts`

- [ ] Add Rust command-boundary tests in `github_commands.rs` for DTO serialization and error redaction.

```rust
#[test]
fn device_prompt_serializes_only_public_fields() {
    let value = serde_json::to_value(GitHubDevicePrompt {
        user_code: "ABCD-EFGH".into(),
        verification_uri: "https://github.com/login/device".into(),
        expires_at_unix: 2_000_000_000,
        interval_seconds: 5,
    })
    .unwrap();

    assert_eq!(
        value.as_object().unwrap().keys().cloned().collect::<BTreeSet<_>>(),
        BTreeSet::from([
            "expiresAtUnix".into(),
            "intervalSeconds".into(),
            "userCode".into(),
            "verificationUri".into(),
        ])
    );
    assert!(value.get("deviceCode").is_none());
    assert!(value.get("accessToken").is_none());
    assert!(value.get("refreshToken").is_none());
}
```

Also serialize a full `GitHubConnection` fixture and assert every ID remains a JSON string.

- [ ] Run the focused test and confirm it fails because commands are not exported.

Run: `cargo test --manifest-path src-tauri/Cargo.toml connectors::github_commands::tests --locked`

Expected: compilation fails on the missing command module.

- [ ] Add the exact command surface to `github_commands.rs`.

```rust
#[tauri::command]
pub async fn github_connect_start(
    app: tauri::AppHandle,
    flow: tauri::State<'_, GitHubConnectFlow>,
) -> Result<GitHubDevicePrompt, AppError>;

#[tauri::command]
pub async fn github_connect_wait(
    app: tauri::AppHandle,
    flow: tauri::State<'_, GitHubConnectFlow>,
) -> Result<GitHubConnection, AppError>;

#[tauri::command]
pub async fn github_connect_cancel(
    flow: tauri::State<'_, GitHubConnectFlow>,
) -> Result<(), AppError>;

#[tauri::command]
pub async fn github_connection_get(
    app: tauri::AppHandle,
) -> Result<Option<GitHubConnection>, AppError>;

#[tauri::command]
pub async fn github_installations_refresh(
    app: tauri::AppHandle,
) -> Result<GitHubConnection, AppError>;

#[tauri::command]
pub async fn github_installation_open(
    app: tauri::AppHandle,
    installation_id: Option<String>,
) -> Result<(), AppError>;

#[tauri::command]
pub async fn github_disconnect(
    app: tauri::AppHandle,
    flow: tauri::State<'_, GitHubConnectFlow>,
) -> Result<(), AppError>;
```

Command behavior:

- `github_connect_start` loads config, starts the device flow, calls `crate::os_accounts::open_in_browser` with the already-validated verification URI, and returns only `GitHubDevicePrompt`. If browser opening fails, it cancels and zeroizes that pending attempt before returning the browser error.
- `github_connect_wait` completes authorization and discovery, then emits the existing `june://connectors-changed` event.
- `github_connect_cancel` is idempotent.
- `github_connection_get` checks Keychain custody through `PlatformGitHubTokenVault` before returning cached state, without exposing the loaded tokens.
- `github_installations_refresh` performs read-only discovery and emits the event on success.
- `github_installation_open` opens `GitHubAppConfig::installation_url()` when `installation_id` is absent. When an ID is present, it loads that exact installation from SQLite and opens its already-validated `management_url`. Unknown IDs fail as `github_installation_required`; never accept a URL from React.
- `github_disconnect` first cancels any active attempt, then deletes local GitHub state and emits the event on success.
- Commands construct the production HTTP client and platform token vault. Neither object enters Tauri state or a payload.

- [ ] Export `pub mod github_commands;`, register all seven commands in `tauri::generate_handler!`, and manage `GitHubConnectFlow::default()` beside the existing Google `ConnectFlow` in `src-tauri/src/lib.rs`. The child command module can call the existing private `super::emit_connectors_changed` helper without widening its visibility.

Each command that reads SQLite obtains the existing repository handle with `crate::commands::repositories(&app).await?`; do not create a second database pool or new Tauri database state.

- [ ] Add the exact TypeScript wire types to the connector section of `src/lib/tauri.ts`.

```ts
export type GitHubConnectionStatus =
  | "connected"
  | "setup_incomplete"
  | "reconnect_required";

export type GitHubDevicePrompt = {
  userCode: string;
  verificationUri: string;
  expiresAtUnix: number;
  intervalSeconds: number;
};

export type GitHubRepository = {
  repositoryId: string;
  installationId: string;
  ownerLogin: string;
  name: string;
  fullName: string;
  private: boolean;
  archived: boolean;
  permissions: Record<string, boolean>;
};

export type GitHubInstallation = {
  installationId: string;
  ownerId: string;
  ownerLogin: string;
  ownerType: string;
  repositorySelection: "all" | "selected";
  permissions: Record<string, string>;
  suspendedAt?: string;
  repositories: GitHubRepository[];
};

export type GitHubConnection = {
  githubUserId: string;
  login: string;
  avatarUrl?: string;
  status: GitHubConnectionStatus;
  installations: GitHubInstallation[];
};
```

- [ ] Add typed wrappers with exact command names.

```ts
export function githubConnectStart(): Promise<GitHubDevicePrompt> {
  return invoke<GitHubDevicePrompt>("github_connect_start");
}

export function githubConnectWait(): Promise<GitHubConnection> {
  return invoke<GitHubConnection>("github_connect_wait");
}

export function githubConnectCancel(): Promise<void> {
  return invoke<void>("github_connect_cancel");
}

export function githubConnectionGet(): Promise<GitHubConnection | null> {
  return invoke<GitHubConnection | null>("github_connection_get");
}

export function githubInstallationsRefresh(): Promise<GitHubConnection> {
  return invoke<GitHubConnection>("github_installations_refresh");
}

export function githubInstallationOpen(installationId?: string): Promise<void> {
  return invoke<void>("github_installation_open", {
    installationId: installationId ?? null,
  });
}

export function githubDisconnect(): Promise<void> {
  return invoke<void>("github_disconnect");
}
```

- [ ] Run Rust boundary tests and TypeScript compilation.

Run: `cargo test --manifest-path src-tauri/Cargo.toml connectors::github_commands::tests --locked`

Expected: all command-boundary tests pass.

Run: `pnpm typecheck`

Expected: exit 0.

- [ ] Commit the command contract and bindings.

```bash
git add src-tauri/src/connectors/github_commands.rs src-tauri/src/connectors/mod.rs src-tauri/src/lib.rs src/lib/tauri.ts
git commit -m "feat: expose GitHub connector commands"
```

## Task 7: Add GitHub connector view-state helpers and provider icon

**Files:**

- Create: `src/lib/github-connectors.ts`
- Create: `src/test/github-connectors.test.ts`
- Create: `src/test/connector-provider-icon.test.tsx`
- Modify: `src/components/connectors/ConnectorProviderIcon.tsx`

- [ ] Write failing pure view-state tests in `src/test/github-connectors.test.ts`.

```ts
import { describe, expect, it } from "vitest";
import {
  githubConnectionSubtitle,
  githubRepositoryCount,
  githubStatusLabel,
} from "../lib/github-connectors";

describe("GitHub connector view state", () => {
  it("counts repositories across installations", () => {
    expect(githubRepositoryCount(githubConnectionFixture())).toBe(2);
  });

  it("describes connected and incomplete states in sentence case", () => {
    expect(githubStatusLabel("connected")).toBe("Connected");
    expect(githubStatusLabel("setup_incomplete")).toBe("Setup incomplete");
    expect(githubStatusLabel("reconnect_required")).toBe("Reconnect required");
    expect(githubConnectionSubtitle(githubConnectionFixture())).toBe(
      "octocat · 2 repositories",
    );
  });
});
```

Add a one-repository assertion for the singular `repository` form and a suspended-only fixture that returns `0 repositories`.

- [ ] Add a failing direct component test in `src/test/connector-provider-icon.test.tsx` that renders `ConnectorProviderIcon` with provider `github` and expects the same decorative accessibility semantics as the Google icon.

- [ ] Run the focused tests and confirm they fail on the missing helper and provider support.

Run: `pnpm test -- src/test/github-connectors.test.ts src/test/connector-provider-icon.test.tsx`

Expected: Vitest reports missing module or failed GitHub rendering assertions.

- [ ] Implement the pure helpers in `src/lib/github-connectors.ts`.

```ts
import type { GitHubConnection, GitHubConnectionStatus } from "./tauri";

export function githubRepositoryCount(connection: GitHubConnection): number {
  return connection.installations.reduce(
    (total, installation) => total + installation.repositories.length,
    0,
  );
}

export function githubStatusLabel(status: GitHubConnectionStatus): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "setup_incomplete":
      return "Setup incomplete";
    case "reconnect_required":
      return "Reconnect required";
  }
}

export function githubConnectionSubtitle(connection: GitHubConnection): string {
  const count = githubRepositoryCount(connection);
  return `${connection.login} · ${count} ${count === 1 ? "repository" : "repositories"}`;
}
```

- [ ] Expand `ConnectorProviderIcon` from provider `"google"` to `"google" | "github"` and render `IconGithub` from `central-icons`.

Do not import lucide or add a custom SVG. Keep the existing icon wrapper and decorative accessibility behavior.

- [ ] Run the focused tests, TypeScript, and Biome.

Run: `pnpm test -- src/test/github-connectors.test.ts src/test/connector-provider-icon.test.tsx`

Expected: all focused tests pass.

Run: `pnpm typecheck`

Expected: exit 0.

Run: `pnpm check`

Expected: exit 0.

- [ ] Commit the GitHub view model.

```bash
git add src/lib/github-connectors.ts src/test/github-connectors.test.ts src/test/connector-provider-icon.test.tsx src/components/connectors/ConnectorProviderIcon.tsx
git commit -m "feat: add GitHub connector view state"
```

## Task 8: Build the GitHub connector settings and device-code flow

**Files:**

- Create: `src/components/settings/GitHubConnectorRow.tsx`
- Create: `src/test/github-connector-row.test.tsx`
- Modify: `src/components/settings/ConnectorsSection.tsx`
- Modify: `src/test/connectors-section.test.tsx`
- Modify: `src/styles/app.css`
- Modify: `src-tauri/tauri.conf.json`

- [ ] Create failing component tests in `src/test/github-connector-row.test.tsx` with mocked Tauri wrappers and `navigator.clipboard.writeText`.

Cover these exact behaviors:

1. Disconnected state shows the provider blurb and `Connect`.
2. `github_not_configured` becomes an inline `GitHub is not configured for this build.` notice, not a raw object.
3. Selecting `Connect` calls `githubConnectStart`, displays `ABCD-EFGH`, the verification link, and a `Copy code` action, then calls `githubConnectWait` once.
4. `Copy code` writes only the user code to the clipboard.
5. Closing the pending dialog calls `githubConnectCancel` and ignores a late wait result.
6. Denied, expired, canceled, rate-limited, and malformed responses show sanitized state-specific copy and allow retry.
7. `setup_incomplete` shows the connected login plus `Install GitHub App` and `Manage repositories` actions.
8. `connected` shows login, avatar when present, installation owners, repository names, `Refresh`, `Manage repositories`, and `Disconnect`.
9. `reconnect_required` shows `Reconnect` and does not present the cache as connected.
10. Refresh calls `githubInstallationsRefresh`, replaces the visible repository list, and removes a repository absent from the response.
11. Install calls `githubInstallationOpen()` and each manage action calls `githubInstallationOpen(installation.installationId)`; React never supplies a URL.
12. Disconnect requires confirmation, calls `githubDisconnect`, and returns the row to disconnected state.

Use fake codes and fake GitHub IDs only. No test snapshot may contain access tokens, refresh tokens, or device codes.

- [ ] Extend `src/test/connectors-section.test.tsx` with an integrated refresh test.

Mock `connectorsList` and `githubConnectionGet` and assert `ConnectorsSection` starts Google and GitHub loads in parallel. Emit `june://connectors-changed`, then assert both are refreshed without changing the existing Google account behavior. Add partial-failure cases proving a GitHub failure leaves Google visible and a Google failure leaves GitHub visible, plus a delayed-old versus fast-new refresh case proving old results cannot overwrite new state.

- [ ] Run the focused settings tests and confirm they fail because the GitHub row does not exist.

Run: `pnpm test -- src/test/github-connector-row.test.tsx src/test/connectors-section.test.tsx`

Expected: Vitest reports missing component and GitHub row assertions.

- [ ] Implement `GitHubConnectorRow` as a provider `<li>` that receives state from the settings section.

```ts
type GitHubConnectorRowProps = {
  connection: GitHubConnection | null;
  loading: boolean;
  onConnectionChanged: (connection: GitHubConnection | null) => void;
};
```

The component owns only transient UI state: current device prompt, pending wait, local sanitized error, copy confirmation, and dialog visibility. It must not persist the user code to local storage, session storage, a query string, or a module singleton.

Use the existing shared `Dialog` and button classes. The flow must be race-safe:

```ts
const flowGeneration = useRef(0);

async function beginConnect() {
  const generation = ++flowGeneration.current;
  setError(null);
  try {
    const nextPrompt = await githubConnectStart();
    if (generation !== flowGeneration.current) return;
    setPrompt(nextPrompt);
    setDeviceDialogOpen(true);
    const nextConnection = await githubConnectWait();
    if (generation !== flowGeneration.current) return;
    setDeviceDialogOpen(false);
    setPrompt(null);
    onConnectionChanged(nextConnection);
  } catch (cause) {
    if (generation !== flowGeneration.current) return;
    setError(githubErrorMessage(cause));
  }
}

async function cancelConnect() {
  flowGeneration.current += 1;
  setDeviceDialogOpen(false);
  setPrompt(null);
  await githubConnectCancel();
}
```

On unmount, increment `flowGeneration` and, when a flow is pending, call `void githubConnectCancel().catch(() => undefined)`. This prevents a late wait from updating the parent after Settings closes; Rust's attempt cancellation remains the authority that prevents persistence.

Implement `githubErrorMessage` as an explicit stable-code switch. Unknown failures return `GitHub could not complete the connection. Try again.` Never render `String(error)` for an arbitrary object or provider body.

- [ ] Render the device dialog with this exact sentence-case content.

- Title: `Connect GitHub`
- Description: `Enter this code on GitHub to authorize June.`
- Code action: `Copy code`
- Browser action: `Open GitHub`
- Pending text: `Waiting for authorization...`
- Cancel action: `Cancel`

The verification URL is the URL returned by GitHub, uses `target="_blank"` and `rel="noreferrer"`, and therefore passes through June's existing external-link interception. Do not construct a different OAuth URL in React.

- [ ] Render connected state from stable DTOs.

Show the login and repository count in the row summary. In the detail dialog, group repositories by installation owner, show `Private` and `Archived` labels only when true, and show suspended installations as `Installation suspended`. Never treat an owner/name pair as an authorization key; actions receive no repository identifier in Phase 0.

Render an avatar only when Rust retained an HTTPS `avatars.githubusercontent.com` URL. Add only that origin to the existing `img-src` CSP in `src-tauri/tauri.conf.json`; do not broaden `connect-src`, add a wildcard, or render any other remote image origin.

- [ ] Update `ConnectorsSection` to load Google and GitHub concurrently but independently.

Use `Promise.allSettled([connectorsList(), githubConnectionGet()])` in the existing refresh path, apply each fulfilled result independently, and maintain provider-specific sanitized error state so one connector cannot hide the other. Guard each refresh with a monotonically increasing `refreshGeneration` ref and ignore both results when a newer refresh has started. Preserve the Google provider row and dialogs. Render GitHub after Google and pass a callback that updates only the GitHub state. The existing `june://connectors-changed` listener remains the single refresh signal.

- [ ] Add token-based styles to the existing connector section in `src/styles/app.css`.

Use new classes such as `.github-device-code`, `.github-device-actions`, `.github-installation-list`, and `.github-repository-list`. The code uses `var(--font-mono)` and an existing `--fs-*` token; controls use existing button/control classes; spacing, borders, radii, colors, and shadows use existing tokens. Do not add raw font sizes, font weights other than 400 or `var(--fw-medium)`, raw control heights, uppercase transforms, or custom icon CSS.

If the installation list is height-clipped, add the shared `useScrollFade` plus `.scroll-fade` and `.scroll-fade-mask`; otherwise leave it naturally sized and do not add a fade.

- [ ] Run focused tests and inspect test output for React act warnings or leaked async flows.

Run: `pnpm test -- src/test/github-connector-row.test.tsx src/test/connectors-section.test.tsx src/test/github-connectors.test.ts`

Expected: all focused tests pass with no unhandled rejections and no real failures.

- [ ] Run frontend gates.

Run: `pnpm typecheck`

Expected: exit 0.

Run: `pnpm check`

Expected: exit 0.

- [ ] Commit the settings UI.

```bash
git add src/components/settings/GitHubConnectorRow.tsx src/components/settings/ConnectorsSection.tsx src/test/github-connector-row.test.tsx src/test/connectors-section.test.tsx src/styles/app.css src-tauri/tauri.conf.json
git commit -m "feat: add GitHub connection settings"
```

## Task 9: Document, verify, and prove the staging contract live

**Files:**

- Modify: `.env.example`
- Modify: `docs/configuration.md`
- Modify: `docs/development.md`
- Modify: `docs/private-connectors-threat-model.md`
- Modify: `docs/index.md` only if a new document is added during implementation
- Modify: implementation files only when a verification failure proves a scoped defect

- [ ] Add blank public GitHub configuration keys to `.env.example`.

```dotenv
# GitHub App connector (public identifiers only; no secret or private key)
GITHUB_APP_CLIENT_ID=
GITHUB_APP_SLUG=
```

Update the development plaintext-store comment to say the opt-in fixture may contain local Google or GitHub connector tokens and must never be shared or committed.

- [ ] Document the GitHub configuration and privacy boundary in `docs/configuration.md`.

The configuration table must state:

- `GITHUB_APP_CLIENT_ID` is the public GitHub App client identifier used by device flow.
- `GITHUB_APP_SLUG` builds the App installation-management URL.
- Both may be supplied at runtime or build time, with runtime values winning.
- App ID `4296474` is not a runtime input.
- No client secret, private key, installation token, or webhook secret is used.
- User access and refresh tokens live in Keychain, with the existing explicit development-only plaintext override.
- June API is not in the GitHub credential or repository-discovery path, so this desktop change needs no June API deploy.

- [ ] Document staging setup and device flow in `docs/development.md`.

Include the exact command:

```bash
make dev-staging
```

Explain that it supplies `GITHUB_APP_CLIENT_ID=Iv23lihKGi1yIb8QZm9L` and `GITHUB_APP_SLUG=june-staging`, that the App must be installed with selected repository `open-software-network/test-repo`, and that the person completing device flow must be allowed to authorize the organization-owned App. Do not document or request a secret.

Document the one-shot QA-only refresh probe separately: restart the debug app with `OS_JUNE_GITHUB_FORCE_REFRESH_ONCE=1 make dev-staging`, select `Refresh` once, verify rotation through timestamps and deterministic service assertions without printing token values, then restart normally. State that release builds ignore the flag.

Record the required staging registration settings: Device Flow enabled, user-to-server token expiration enabled, Metadata read permission present, the approved Phase 0 repository permissions unchanged, and webhooks disabled. Where organization SAML applies, the QA user needs an active organization session before authorization; deterministic tests still own the SSO error classification.

- [ ] Add a GitHub Phase 0 section to `docs/private-connectors-threat-model.md`.

Cover the device user-token and rotating refresh-token assets, selected-repository metadata, validated avatar origin, development plaintext override, Keychain and Hermes sandbox defenses, cancellation/compensation boundary, direct desktop-to-GitHub traffic, and the exact statement that June API receives no GitHub credential or repository data. Keep the existing Google analysis intact. No ADR is needed because the approved design keeps the existing local-mode boundary and adds no signer.

- [ ] Run deterministic backend verification.

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`

Expected: exit 0.

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings`

Expected: exit 0 with no warnings.

Run: `pnpm test:rust`

Expected: all Tauri Rust tests pass.

- [ ] Run deterministic frontend verification.

Run: `pnpm check`

Expected: exit 0.

Run: `pnpm typecheck`

Expected: exit 0.

Run: `pnpm test`

Expected: zero real failures. If the documented HUD teardown noise appears with zero failures, record it separately and do not misclassify it as a GitHub regression.

- [ ] Run the full repository gate.

Run: `make verify`

Expected: exit 0. If an unrelated documented flaky ProseMirror test fails, rerun that exact test once and record both outputs; do not weaken or skip a gate.

- [ ] Use the `agent-e2e-qa` skill for the live staging walkthrough.

Use a disposable QA GitHub user and obtain the exclusive fixture lock from the staging owner before changing installation state. Confirm `OS_JUNE_DEV_PLAINTEXT_TOKEN_STORE=0` in the launched process and confirm `src-tauri/target/dev-github-connector-tokens.json` does not exist before authorizing. Start with `make dev-staging`, open Settings > Connectors, and capture a short recording or screenshots that prove:

1. GitHub appears after Google and the existing Google behavior remains intact.
2. Connect opens the browser and shows the device-code UI. Do not record an active code; pause capture, authorize, and resume only after the code has expired or redact it locally before any upload.
3. Completing authorization connects the expected GitHub login.
4. June discovers the `open-software-network` installation and `open-software-network/test-repo`.
5. An unselected private sibling repository is absent from the UI and SQLite negative-control check.
6. Refresh remains read-only and preserves the stable installation and repository IDs in local state.
7. Manage repositories opens the existing installation settings page, while install opens the `june-staging` App installation page.
8. Canceling, denying, and expiring fresh device flows leave no token entry or connection row.
9. Disconnect removes the UI connection and the local non-secret database rows.

Do not create or modify an issue, pull request, check, status, comment, branch, file, release, workflow, deployment, secret, or repository setting during this walkthrough.

Evidence must be redacted and kept private if it contains a GitHub login, organization-private repository name, or installation metadata. Never upload an active user code, token, raw Keychain value, or private repository metadata to a public PR or os-platform attachment.

After the initial connection, run the documented one-shot debug refresh probe and confirm refresh succeeds without a client secret, both token expiries advance, and the subsequent normal refresh still discovers the same stable repository IDs. Compare rotation as booleans inside Rust; never print either token value.

- [ ] Perform the two live lifecycle checks that require GitHub-side fixture changes, one at a time and with the user present.

1. Remove `test-repo` from the selected repositories, refresh June, and confirm it disappears and status becomes `setup_incomplete`; then restore `test-repo` and confirm refresh restores `connected`.
2. Suspend and unsuspend the staging App, then uninstall and reinstall it. At each transition, refresh June and confirm stale repositories fail closed; finish with the App installed only on the original selected repositories.
3. Revoke the disposable user's authorization, refresh June, and confirm invalid refresh credentials end in `reconnect_required`; then reconnect and confirm the repository returns.

These are staging-fixture changes, not repository content mutations. Run them serially under the fixture lock and restore the original selected-repository installation before releasing it.

- [ ] Inspect storage and logs after live QA.

Verify SQLite contains only the user, installation, permission, and repository metadata. Search app logs and captured diagnostics for `ghu_`, `ghr_`, device-code field names, and deterministic fake markers; there must be no access token, refresh token, or secret device code. This supplements, but does not replace, deterministic redaction tests. Confirm captured network destinations are GitHub only and June API receives no GitHub request or repository metadata. On macOS, verify the Keychain service is `co.opensoftware.june-dev.github` for the development build without printing, copying, or comparing the stored value.

- [ ] Update the implementation's PR notes with the required project disclosures.

Record:

- Visual testing: yes, with the captured staging evidence.
- June API deploy: no.
- Root cause: not applicable; this is a new connector slice.
- Out of scope: GitHub MCP tools, all GitHub writes, routines, webhooks, production App registration, backend signing, and broad connector generalization.
- Followups: V1 read/action server design, stable approval payloads, action journal, PR head-SHA revalidation, production GitHub App registration, and provider-neutral extraction after the staging contract is proven.

- [ ] Commit documentation or small verification fixes.

```bash
git add .env.example docs/configuration.md docs/development.md docs/private-connectors-threat-model.md
git commit -m "docs: document GitHub connector staging"
```

If verification required scoped implementation fixes, stage those exact files and use a separate commit whose message describes the defect. Do not fold unrelated worktree changes into either commit.

## Completion criteria

- [ ] `make verify` passes with zero real failures.
- [ ] Device flow uses only the public Client ID and never requires a GitHub secret or private key.
- [ ] Keychain is the default and only release token store.
- [ ] SQLite and Tauri payloads contain no GitHub token or secret device code.
- [ ] One connected user, multiple installations, and selected repositories are represented by stable string IDs.
- [ ] Cancellation, expiry, denial, refresh rotation, revoke, suspension, repository removal, reconnect, and disconnect are covered by deterministic tests or the explicit live staging checks above.
- [ ] `open-software-network/test-repo` is discovered through the installed `june-staging` App.
- [ ] No GitHub write endpoint, MCP server, routine, webhook, June API route, signer, client secret, or private key was added.
- [ ] Existing Google connector behavior remains green.
- [ ] The staging installation is restored to its original selected-repository state after QA.
