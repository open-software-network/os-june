//! Connector token custody, shared by every provider (Google and Linear).
//!
//! Tokens live in the OS keychain, one entry per connected account (user =
//! the caller-supplied account id: a Google account email, or a Linear
//! workspace id), and NEVER anywhere else: the SQLite index only carries
//! non-secret account metadata (emails, scopes, status) so accounts can be
//! enumerated without touching the keychain. Each provider gets its own
//! keychain SERVICE (`co.opensoftware.june.<provider>`), so two providers'
//! tokens never collide even if they ever shared an account id. Debug builds
//! use a separate keychain service per provider, and can opt into a
//! plaintext token file for local development via
//! `OS_JUNE_DEV_PLAINTEXT_TOKEN_STORE=1` (also what unit tests exercise,
//! since the Keychain is unavailable in CI); that file is per provider too.

use super::ConnectorProvider;
use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

const KEYCHAIN_SERVICE_PREFIX: &str = "co.opensoftware.june";
const DEV_KEYCHAIN_SERVICE_PREFIX: &str = "co.opensoftware.june-dev";
#[cfg(debug_assertions)]
const DEV_PLAINTEXT_TOKEN_STORE_ENV: &str = "OS_JUNE_DEV_PLAINTEXT_TOKEN_STORE";
const USE_PROD_ACCOUNTS_TOKENS_ENV: &str = "OS_JUNE_USE_PROD_ACCOUNTS_TOKENS";

/// The dev plaintext token file's basename for a provider (under
/// `target/`). Kept separate per provider for the same reason the keychain
/// service is: so a Google and a Linear dev-mode connect never share a file.
#[cfg(any(debug_assertions, test))]
fn dev_plaintext_token_file(provider: ConnectorProvider) -> &'static str {
    match provider {
        ConnectorProvider::Google => "dev-google-connector-tokens.json",
        ConnectorProvider::Linear => "dev-linear-connector-tokens.json",
        ConnectorProvider::Notion => "dev-notion-connector-tokens.json",
    }
}

/// What lives in one keychain entry. Token fields zeroize on drop so rotated
/// grants don't linger in memory (mirrors `os_accounts::TokenPair`).
#[derive(Serialize, Deserialize, Clone, Zeroize, ZeroizeOnDrop)]
pub struct StoredConnectorTokens {
    pub access_token: String,
    pub refresh_token: String,
    #[zeroize(skip)]
    pub expires_at_unix: i64,
    #[zeroize(skip)]
    pub scopes: Vec<String>,
    #[zeroize(skip)]
    pub email: String,
}

/// Write `tokens` to the keychain, keyed by `(provider, account_id)`.
/// `account_id` is the caller-supplied keychain user: a Google account
/// email, or a Linear workspace id.
pub async fn store_tokens(
    provider: ConnectorProvider,
    account_id: &str,
    tokens: &StoredConnectorTokens,
) -> Result<(), AppError> {
    let json = serde_json::to_string(tokens)
        .map_err(|e| AppError::new("connector_token_serialize_failed", e.to_string()))?;
    let account_id = account_id.to_string();
    #[cfg(debug_assertions)]
    if use_dev_plaintext_token_store() {
        return store_dev_plaintext_tokens(provider, account_id, json).await;
    }
    store_platform_tokens(provider, account_id, json).await
}

/// Load the stored tokens for one account. `Ok(None)` means "not connected"
/// (no keychain entry); errors are real keychain failures.
pub async fn load_tokens(
    provider: ConnectorProvider,
    account_id: &str,
) -> Result<Option<StoredConnectorTokens>, AppError> {
    #[cfg(debug_assertions)]
    if use_dev_plaintext_token_store() {
        return load_dev_plaintext_tokens(provider, account_id).await;
    }
    load_platform_tokens(provider, account_id).await
}

pub async fn delete_tokens(provider: ConnectorProvider, account_id: &str) -> Result<(), AppError> {
    #[cfg(debug_assertions)]
    if use_dev_plaintext_token_store() {
        return delete_dev_plaintext_tokens(provider, account_id).await;
    }
    delete_platform_tokens(provider, account_id).await
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn store_platform_tokens(
    provider: ConnectorProvider,
    account_id: String,
    json: String,
) -> Result<(), AppError> {
    let service = keychain_service(provider);
    tokio::task::spawn_blocking(move || {
        keyring::Entry::new(&service, &account_id).and_then(|entry| entry.set_password(&json))
    })
    .await
    .map_err(|e| AppError::new("connector_keychain_write_failed", e.to_string()))?
    .map_err(|e| AppError::new("connector_keychain_write_failed", e.to_string()))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn store_platform_tokens(
    _provider: ConnectorProvider,
    _account_id: String,
    _json: String,
) -> Result<(), AppError> {
    Err(secure_storage_unavailable())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn load_platform_tokens(
    provider: ConnectorProvider,
    account_id: &str,
) -> Result<Option<StoredConnectorTokens>, AppError> {
    let service = keychain_service(provider);
    let user = account_id.to_string();
    let raw = tokio::task::spawn_blocking(move || {
        match keyring::Entry::new(&service, &user).and_then(|entry| entry.get_password()) {
            Ok(raw) => Ok(Some(raw)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::new(
                "connector_keychain_read_failed",
                e.to_string(),
            )),
        }
    })
    .await
    .map_err(|e| AppError::new("connector_keychain_read_failed", e.to_string()))??;
    let Some(raw) = raw else {
        return Ok(None);
    };
    // A corrupt entry is indistinguishable from "no usable grant": report it
    // as such (the caller surfaces the reconnect path) without ever echoing
    // the entry contents into the error.
    serde_json::from_str::<StoredConnectorTokens>(&raw)
        .map(Some)
        .map_err(|_| {
            AppError::new(
                "connector_keychain_read_failed",
                "Stored connector tokens could not be parsed.",
            )
        })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn load_platform_tokens(
    _provider: ConnectorProvider,
    _account_id: &str,
) -> Result<Option<StoredConnectorTokens>, AppError> {
    Ok(None)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn delete_platform_tokens(
    provider: ConnectorProvider,
    account_id: &str,
) -> Result<(), AppError> {
    let service = keychain_service(provider);
    let user = account_id.to_string();
    tokio::task::spawn_blocking(move || {
        match keyring::Entry::new(&service, &user).and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::new(
                "connector_keychain_delete_failed",
                e.to_string(),
            )),
        }
    })
    .await
    .map_err(|e| AppError::new("connector_keychain_delete_failed", e.to_string()))?
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn delete_platform_tokens(
    _provider: ConnectorProvider,
    _account_id: &str,
) -> Result<(), AppError> {
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn secure_storage_unavailable() -> AppError {
    AppError::new(
        "connector_keychain_write_failed",
        "Secure token storage is only available on macOS and Windows.",
    )
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn keychain_service(provider: ConnectorProvider) -> String {
    keychain_service_for_build(
        provider,
        cfg!(debug_assertions),
        use_prod_connector_tokens(),
    )
}

#[cfg(any(target_os = "macos", target_os = "windows", test))]
fn keychain_service_for_build(
    provider: ConnectorProvider,
    debug_assertions: bool,
    use_prod: bool,
) -> String {
    let prefix = if debug_assertions && !use_prod {
        DEV_KEYCHAIN_SERVICE_PREFIX
    } else {
        KEYCHAIN_SERVICE_PREFIX
    };
    format!("{prefix}.{}", provider.as_str())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn use_prod_connector_tokens() -> bool {
    crate::os_accounts::load_local_env();
    cfg!(debug_assertions) && super::env_truthy(USE_PROD_ACCOUNTS_TOKENS_ENV)
}

#[cfg(debug_assertions)]
fn use_dev_plaintext_token_store() -> bool {
    crate::os_accounts::load_local_env();
    super::env_truthy(DEV_PLAINTEXT_TOKEN_STORE_ENV)
}

#[cfg(any(debug_assertions, test))]
fn dev_plaintext_token_path(provider: ConnectorProvider) -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(dev_plaintext_token_file(provider))
}

// --- Dev plaintext file store (debug builds only) ---------------------------
//
// One JSON object keyed by account id, in a file scoped to the provider. The
// pure `dev_file_*` helpers take an explicit path so unit tests can exercise
// them against a temp dir without mutating process env or the shared
// target/ file.

#[cfg(debug_assertions)]
async fn store_dev_plaintext_tokens(
    provider: ConnectorProvider,
    account_id: String,
    json: String,
) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        dev_file_store(&dev_plaintext_token_path(provider), &account_id, &json)
    })
    .await
    .map_err(|e| AppError::new("connector_dev_token_store_write_failed", e.to_string()))?
}

#[cfg(debug_assertions)]
async fn load_dev_plaintext_tokens(
    provider: ConnectorProvider,
    account_id: &str,
) -> Result<Option<StoredConnectorTokens>, AppError> {
    let account_id = account_id.to_string();
    tokio::task::spawn_blocking(move || {
        dev_file_load(&dev_plaintext_token_path(provider), &account_id)
    })
    .await
    .map_err(|e| AppError::new("connector_dev_token_store_read_failed", e.to_string()))?
}

#[cfg(debug_assertions)]
async fn delete_dev_plaintext_tokens(
    provider: ConnectorProvider,
    account_id: &str,
) -> Result<(), AppError> {
    let account_id = account_id.to_string();
    tokio::task::spawn_blocking(move || {
        dev_file_delete(&dev_plaintext_token_path(provider), &account_id)
    })
    .await
    .map_err(|e| AppError::new("connector_dev_token_store_write_failed", e.to_string()))?
}

#[cfg(any(debug_assertions, test))]
fn dev_file_read_map(
    path: &std::path::Path,
) -> std::collections::HashMap<String, serde_json::Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

#[cfg(any(debug_assertions, test))]
fn dev_file_write_map(
    path: &std::path::Path,
    map: &std::collections::HashMap<String, serde_json::Value>,
) -> Result<(), AppError> {
    let json = serde_json::to_string(map)
        .map_err(|e| AppError::new("connector_dev_token_store_write_failed", e.to_string()))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::new("connector_dev_token_store_write_failed", e.to_string()))?;
    }
    let write = || -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::PermissionsExt;

            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(path)?;
            file.write_all(json.as_bytes())?;
            let mut permissions = file.metadata()?.permissions();
            permissions.set_mode(0o600);
            std::fs::set_permissions(path, permissions)?;
            Ok(())
        }
        #[cfg(not(unix))]
        {
            std::fs::write(path, &json)
        }
    };
    write().map_err(|e| AppError::new("connector_dev_token_store_write_failed", e.to_string()))
}

#[cfg(any(debug_assertions, test))]
fn dev_file_store(path: &std::path::Path, email: &str, json: &str) -> Result<(), AppError> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| AppError::new("connector_dev_token_store_write_failed", e.to_string()))?;
    let mut map = dev_file_read_map(path);
    map.insert(email.to_string(), value);
    dev_file_write_map(path, &map)
}

#[cfg(any(debug_assertions, test))]
fn dev_file_load(
    path: &std::path::Path,
    account_id: &str,
) -> Result<Option<StoredConnectorTokens>, AppError> {
    let map = dev_file_read_map(path);
    let Some(value) = map.get(account_id) else {
        return Ok(None);
    };
    serde_json::from_value::<StoredConnectorTokens>(value.clone())
        .map(Some)
        .map_err(|_| {
            AppError::new(
                "connector_dev_token_store_read_failed",
                "Stored connector tokens could not be parsed.",
            )
        })
}

#[cfg(any(debug_assertions, test))]
fn dev_file_delete(path: &std::path::Path, account_id: &str) -> Result<(), AppError> {
    let mut map = dev_file_read_map(path);
    if map.remove(account_id).is_none() {
        return Ok(());
    }
    if map.is_empty() {
        let _ = std::fs::remove_file(path);
        return Ok(());
    }
    dev_file_write_map(path, &map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(email: &str) -> StoredConnectorTokens {
        StoredConnectorTokens {
            access_token: "test-access".to_string(),
            refresh_token: "test-refresh".to_string(),
            expires_at_unix: 1_800_000_000,
            scopes: vec!["openid".to_string(), "email".to_string()],
            email: email.to_string(),
        }
    }

    #[test]
    fn dev_file_store_round_trips_per_account() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let first = tokens("a@example.com");
        let second = tokens("b@example.com");
        dev_file_store(&path, &first.email, &serde_json::to_string(&first).unwrap())
            .expect("store first");
        dev_file_store(
            &path,
            &second.email,
            &serde_json::to_string(&second).unwrap(),
        )
        .expect("store second");

        let loaded = dev_file_load(&path, "a@example.com")
            .expect("load")
            .expect("present");
        assert_eq!(loaded.email, "a@example.com");
        assert_eq!(loaded.access_token, "test-access");
        assert_eq!(loaded.expires_at_unix, 1_800_000_000);
        assert_eq!(loaded.scopes, vec!["openid", "email"]);
        assert!(dev_file_load(&path, "b@example.com")
            .expect("load")
            .is_some());
        assert!(dev_file_load(&path, "missing@example.com")
            .expect("load")
            .is_none());
    }

    #[test]
    fn dev_file_store_overwrites_existing_entry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let mut entry = tokens("a@example.com");
        dev_file_store(&path, &entry.email, &serde_json::to_string(&entry).unwrap())
            .expect("store");
        entry.access_token = "rotated-access".to_string();
        entry.refresh_token = "rotated-refresh".to_string();
        dev_file_store(&path, &entry.email, &serde_json::to_string(&entry).unwrap())
            .expect("store rotated");

        let loaded = dev_file_load(&path, "a@example.com")
            .expect("load")
            .expect("present");
        assert_eq!(loaded.access_token, "rotated-access");
        assert_eq!(loaded.refresh_token, "rotated-refresh");
    }

    #[test]
    fn dev_file_delete_removes_only_that_account() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let first = tokens("a@example.com");
        let second = tokens("b@example.com");
        dev_file_store(&path, &first.email, &serde_json::to_string(&first).unwrap())
            .expect("store first");
        dev_file_store(
            &path,
            &second.email,
            &serde_json::to_string(&second).unwrap(),
        )
        .expect("store second");

        dev_file_delete(&path, "a@example.com").expect("delete");
        assert!(dev_file_load(&path, "a@example.com")
            .expect("load")
            .is_none());
        assert!(dev_file_load(&path, "b@example.com")
            .expect("load")
            .is_some());

        // Deleting the last entry removes the file entirely.
        dev_file_delete(&path, "b@example.com").expect("delete last");
        assert!(!path.exists());
        dev_file_delete(&path, "b@example.com").expect("delete idempotent");
    }

    #[cfg(unix)]
    #[test]
    fn dev_file_is_owner_read_write_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let entry = tokens("a@example.com");
        dev_file_store(&path, &entry.email, &serde_json::to_string(&entry).unwrap())
            .expect("store");
        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn keychain_service_separates_dev_and_release() {
        assert_eq!(
            keychain_service_for_build(ConnectorProvider::Google, true, false),
            "co.opensoftware.june-dev.google"
        );
        assert_eq!(
            keychain_service_for_build(ConnectorProvider::Google, true, true),
            "co.opensoftware.june.google"
        );
        assert_eq!(
            keychain_service_for_build(ConnectorProvider::Google, false, false),
            "co.opensoftware.june.google"
        );
    }

    #[test]
    fn keychain_service_separates_providers() {
        assert_eq!(
            keychain_service_for_build(ConnectorProvider::Linear, true, false),
            "co.opensoftware.june-dev.linear"
        );
        assert_eq!(
            keychain_service_for_build(ConnectorProvider::Linear, true, true),
            "co.opensoftware.june.linear"
        );
        assert_eq!(
            keychain_service_for_build(ConnectorProvider::Linear, false, false),
            "co.opensoftware.june.linear"
        );
    }
}
