//! GitHub connector token custody.
//!
//! Rotating GitHub user tokens live in a GitHub-specific OS Keychain service,
//! one entry per stable numeric GitHub user ID. Debug builds can explicitly opt
//! into a separate plaintext development fixture with
//! `OS_JUNE_DEV_PLAINTEXT_TOKEN_STORE=1`; release builds never use that path.

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const RELEASE_KEYCHAIN_SERVICE: &str = "co.opensoftware.june.github";
const DEV_KEYCHAIN_SERVICE: &str = "co.opensoftware.june-dev.github";
#[cfg(debug_assertions)]
const PLAINTEXT_TOKEN_STORE_ENV: &str = "OS_JUNE_DEV_PLAINTEXT_TOKEN_STORE";
#[cfg(any(debug_assertions, test))]
const DEV_TOKEN_FILENAME: &str = "dev-github-connector-tokens.json";

const INVALID_ERROR_CODE: &str = "github_token_store_invalid";
const INVALID_ERROR_MESSAGE: &str = "Stored GitHub tokens are invalid.";
const UNAVAILABLE_ERROR_CODE: &str = "github_token_store_unavailable";
const UNAVAILABLE_ERROR_MESSAGE: &str = "GitHub token storage is unavailable.";

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
) -> Result<Option<StoredGitHubTokens>, AppError> {
    #[cfg(debug_assertions)]
    if use_dev_plaintext_token_store() {
        return load_dev_plaintext_tokens(github_user_id).await;
    }
    load_platform_tokens(github_user_id).await
}

pub async fn store_github_tokens(
    github_user_id: &str,
    tokens: &StoredGitHubTokens,
) -> Result<(), AppError> {
    validate_account_match(github_user_id, tokens)?;
    #[cfg(debug_assertions)]
    if use_dev_plaintext_token_store() {
        return store_dev_plaintext_tokens(github_user_id, tokens).await;
    }
    store_platform_tokens(github_user_id, tokens).await
}

pub async fn delete_github_tokens(github_user_id: &str) -> Result<(), AppError> {
    #[cfg(debug_assertions)]
    if use_dev_plaintext_token_store() {
        return delete_dev_plaintext_tokens(github_user_id).await;
    }
    delete_platform_tokens(github_user_id).await
}

fn invalid_store() -> AppError {
    AppError::new(INVALID_ERROR_CODE, INVALID_ERROR_MESSAGE)
}

fn unavailable_store() -> AppError {
    AppError::new(UNAVAILABLE_ERROR_CODE, UNAVAILABLE_ERROR_MESSAGE)
}

fn validate_account_match(
    github_user_id: &str,
    tokens: &StoredGitHubTokens,
) -> Result<(), AppError> {
    if github_user_id == tokens.github_user_id {
        Ok(())
    } else {
        Err(invalid_store())
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn store_platform_tokens(
    github_user_id: &str,
    tokens: &StoredGitHubTokens,
) -> Result<(), AppError> {
    let service = keychain_service().to_string();
    let user = github_user_id.to_string();
    let tokens = tokens.clone();
    tokio::task::spawn_blocking(move || {
        validate_account_match(&user, &tokens)?;
        let json = Zeroizing::new(serde_json::to_string(&tokens).map_err(|_| unavailable_store())?);
        let entry = keyring::Entry::new(&service, &user).map_err(|_| unavailable_store())?;
        entry.set_password(&json).map_err(|_| unavailable_store())
    })
    .await
    .map_err(|_| unavailable_store())?
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn store_platform_tokens(
    _github_user_id: &str,
    _tokens: &StoredGitHubTokens,
) -> Result<(), AppError> {
    Err(unavailable_store())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn load_platform_tokens(
    github_user_id: &str,
) -> Result<Option<StoredGitHubTokens>, AppError> {
    let service = keychain_service().to_string();
    let user = github_user_id.to_string();
    let raw = tokio::task::spawn_blocking(move || {
        let entry = keyring::Entry::new(&service, &user).map_err(|_| unavailable_store())?;
        match entry.get_password() {
            Ok(raw) => Ok(Some(raw)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(unavailable_store()),
        }
    })
    .await
    .map_err(|_| unavailable_store())??;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let raw = Zeroizing::new(raw);
    let tokens = serde_json::from_str::<StoredGitHubTokens>(&raw).map_err(|_| invalid_store())?;
    validate_account_match(github_user_id, &tokens)?;
    Ok(Some(tokens))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn load_platform_tokens(
    _github_user_id: &str,
) -> Result<Option<StoredGitHubTokens>, AppError> {
    Ok(None)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn delete_platform_tokens(github_user_id: &str) -> Result<(), AppError> {
    let service = keychain_service().to_string();
    let user = github_user_id.to_string();
    tokio::task::spawn_blocking(move || {
        let entry = keyring::Entry::new(&service, &user).map_err(|_| unavailable_store())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(unavailable_store()),
        }
    })
    .await
    .map_err(|_| unavailable_store())?
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn delete_platform_tokens(_github_user_id: &str) -> Result<(), AppError> {
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn keychain_service() -> &'static str {
    keychain_service_for_build(cfg!(debug_assertions))
}

#[cfg(any(target_os = "macos", target_os = "windows", test))]
fn keychain_service_for_build(debug_assertions: bool) -> &'static str {
    if debug_assertions {
        DEV_KEYCHAIN_SERVICE
    } else {
        RELEASE_KEYCHAIN_SERVICE
    }
}

#[cfg(debug_assertions)]
fn use_dev_plaintext_token_store() -> bool {
    crate::os_accounts::load_local_env();
    super::env_truthy(PLAINTEXT_TOKEN_STORE_ENV)
}

#[cfg(any(debug_assertions, test))]
fn dev_plaintext_token_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(DEV_TOKEN_FILENAME)
}

#[cfg(debug_assertions)]
async fn store_dev_plaintext_tokens(
    github_user_id: &str,
    tokens: &StoredGitHubTokens,
) -> Result<(), AppError> {
    let user = github_user_id.to_string();
    let tokens = tokens.clone();
    tokio::task::spawn_blocking(move || dev_file_store(&dev_plaintext_token_path(), &user, &tokens))
        .await
        .map_err(|_| unavailable_store())?
}

#[cfg(debug_assertions)]
async fn load_dev_plaintext_tokens(
    github_user_id: &str,
) -> Result<Option<StoredGitHubTokens>, AppError> {
    let user = github_user_id.to_string();
    tokio::task::spawn_blocking(move || dev_file_load(&dev_plaintext_token_path(), &user))
        .await
        .map_err(|_| unavailable_store())?
}

#[cfg(debug_assertions)]
async fn delete_dev_plaintext_tokens(github_user_id: &str) -> Result<(), AppError> {
    let user = github_user_id.to_string();
    tokio::task::spawn_blocking(move || dev_file_delete(&dev_plaintext_token_path(), &user))
        .await
        .map_err(|_| unavailable_store())?
}

#[cfg(any(debug_assertions, test))]
type DevTokenMap = std::collections::HashMap<String, StoredGitHubTokens>;

#[cfg(any(debug_assertions, test))]
fn dev_file_read_map(path: &std::path::Path) -> Result<DevTokenMap, AppError> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => Zeroizing::new(raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DevTokenMap::new());
        }
        Err(_) => return Err(unavailable_store()),
    };
    serde_json::from_str(&raw).map_err(|_| invalid_store())
}

#[cfg(any(debug_assertions, test))]
fn dev_file_write_map(path: &std::path::Path, map: &DevTokenMap) -> Result<(), AppError> {
    let json = Zeroizing::new(serde_json::to_string(map).map_err(|_| unavailable_store())?);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| unavailable_store())?;
    }

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .map_err(|_| unavailable_store())?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| unavailable_store())?;
        file.write_all(json.as_bytes())
            .map_err(|_| unavailable_store())?;
    }

    #[cfg(not(unix))]
    std::fs::write(path, json.as_bytes()).map_err(|_| unavailable_store())?;

    Ok(())
}

#[cfg(any(debug_assertions, test))]
fn dev_file_store(
    path: &std::path::Path,
    github_user_id: &str,
    tokens: &StoredGitHubTokens,
) -> Result<(), AppError> {
    validate_account_match(github_user_id, tokens)?;
    let mut map = dev_file_read_map(path)?;
    map.insert(github_user_id.to_string(), tokens.clone());
    dev_file_write_map(path, &map)
}

#[cfg(any(debug_assertions, test))]
fn dev_file_load(
    path: &std::path::Path,
    github_user_id: &str,
) -> Result<Option<StoredGitHubTokens>, AppError> {
    let mut map = dev_file_read_map(path)?;
    let Some(tokens) = map.remove(github_user_id) else {
        return Ok(None);
    };
    validate_account_match(github_user_id, &tokens)?;
    Ok(Some(tokens))
}

#[cfg(any(debug_assertions, test))]
fn dev_file_delete(path: &std::path::Path, github_user_id: &str) -> Result<(), AppError> {
    let mut map = dev_file_read_map(path)?;
    if map.remove(github_user_id).is_none() {
        return Ok(());
    }
    if map.is_empty() {
        return match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(unavailable_store()),
        };
    }
    dev_file_write_map(path, &map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(github_user_id: &str) -> StoredGitHubTokens {
        StoredGitHubTokens {
            github_user_id: github_user_id.into(),
            access_token: "access-secret".into(),
            refresh_token: "refresh-secret".into(),
            expires_at_unix: 2_000_000_000,
            refresh_token_expires_at_unix: 2_100_000_000,
        }
    }

    #[test]
    fn github_uses_a_separate_keychain_namespace() {
        assert_eq!(
            keychain_service_for_build(false),
            "co.opensoftware.june.github"
        );
        assert_eq!(
            keychain_service_for_build(true),
            "co.opensoftware.june-dev.github"
        );
        assert_ne!(
            keychain_service_for_build(false),
            "co.opensoftware.june.google"
        );
    }

    #[test]
    fn stored_tokens_round_trip_without_debug_output() {
        let tokens = tokens("123");
        let encoded = serde_json::to_string(&tokens).unwrap();
        let decoded: StoredGitHubTokens = serde_json::from_str(&encoded).unwrap();

        assert_eq!(decoded.access_token, "access-secret");
        let debug = format!("{tokens:?}");
        assert!(!debug.contains("access-secret"));
        assert!(!debug.contains("refresh-secret"));
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn plaintext_path_is_the_explicit_github_development_fixture() {
        assert_eq!(
            dev_plaintext_token_path(),
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join("dev-github-connector-tokens.json")
        );
    }

    #[test]
    fn dev_file_store_round_trips_per_github_user() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let first = tokens("123");
        let second = tokens("456");

        dev_file_store(&path, "123", &first).expect("store first");
        dev_file_store(&path, "456", &second).expect("store second");

        let loaded = dev_file_load(&path, "123").expect("load").expect("present");
        assert_eq!(loaded.github_user_id, "123");
        assert_eq!(loaded.access_token, "access-secret");
        assert_eq!(loaded.refresh_token, "refresh-secret");
        assert_eq!(loaded.expires_at_unix, 2_000_000_000);
        assert_eq!(loaded.refresh_token_expires_at_unix, 2_100_000_000);
        assert!(dev_file_load(&path, "456").expect("load").is_some());
        assert!(dev_file_load(&path, "missing").expect("load").is_none());
    }

    #[test]
    fn dev_file_store_overwrites_rotated_tokens() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let mut entry = tokens("123");
        dev_file_store(&path, "123", &entry).expect("store");
        entry.access_token = "rotated-access".into();
        entry.refresh_token = "rotated-refresh".into();
        entry.expires_at_unix += 1;
        entry.refresh_token_expires_at_unix += 1;

        dev_file_store(&path, "123", &entry).expect("store rotated");

        let loaded = dev_file_load(&path, "123").expect("load").expect("present");
        assert_eq!(loaded.access_token, "rotated-access");
        assert_eq!(loaded.refresh_token, "rotated-refresh");
        assert_eq!(loaded.expires_at_unix, 2_000_000_001);
        assert_eq!(loaded.refresh_token_expires_at_unix, 2_100_000_001);
    }

    #[test]
    fn dev_file_delete_removes_only_that_github_user() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        dev_file_store(&path, "123", &tokens("123")).expect("store first");
        dev_file_store(&path, "456", &tokens("456")).expect("store second");

        dev_file_delete(&path, "123").expect("delete");
        assert!(dev_file_load(&path, "123").expect("load").is_none());
        assert!(dev_file_load(&path, "456").expect("load").is_some());

        dev_file_delete(&path, "456").expect("delete last");
        assert!(!path.exists());
        dev_file_delete(&path, "456").expect("delete idempotent");
    }

    #[test]
    fn invalid_json_error_is_stable_and_redacted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let secret_payload = r#"{"123":{"access_token":"must-not-leak""#;
        std::fs::write(&path, secret_payload).expect("write corrupt fixture");

        let error = dev_file_load(&path, "123").expect_err("invalid JSON");

        assert_eq!(error.code, "github_token_store_invalid");
        assert!(!format!("{error:?}").contains("must-not-leak"));
    }

    #[test]
    fn dev_file_store_rejects_a_mismatched_github_user_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");

        let error =
            dev_file_store(&path, "456", &tokens("123")).expect_err("mismatched account key");

        assert_eq!(error.code, "github_token_store_invalid");
        assert!(!path.exists());
    }

    #[test]
    fn dev_file_load_rejects_a_mismatched_github_user_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let encoded = serde_json::json!({ "456": tokens("123") });
        std::fs::write(&path, serde_json::to_vec(&encoded).unwrap())
            .expect("write mismatched fixture");

        let error = dev_file_load(&path, "456").expect_err("mismatched account key");

        assert_eq!(error.code, "github_token_store_invalid");
    }

    #[tokio::test]
    async fn public_store_rejects_a_mismatched_github_user_id_before_storage() {
        let error = store_github_tokens("456", &tokens("123"))
            .await
            .expect_err("mismatched account key");

        assert_eq!(error.code, "github_token_store_invalid");
    }

    #[cfg(unix)]
    #[test]
    fn dev_file_is_owner_read_write_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        dev_file_store(&path, "123", &tokens("123")).expect("store");

        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
