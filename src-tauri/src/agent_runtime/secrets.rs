//! One-shot secret delivery for agent interruptions.
//!
//! SQLite stores only an opaque reference. The value lives in the operating
//! system keychain until the resumed tool consumes it, then it is deleted.

use crate::domain::types::AppError;
use zeroize::Zeroize;

const KEYCHAIN_SERVICE: &str = "co.opensoftware.june.agent-secrets";
const DEV_KEYCHAIN_SERVICE: &str = "co.opensoftware.june.dev.agent-secrets";

fn service() -> &'static str {
    if cfg!(debug_assertions) {
        DEV_KEYCHAIN_SERVICE
    } else {
        KEYCHAIN_SERVICE
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub async fn put(secret_ref: &str, value: String) -> Result<(), AppError> {
    let service = service().to_string();
    let secret_ref = secret_ref.to_string();
    tokio::task::spawn_blocking(move || {
        let mut value = value;
        let result = keyring::Entry::new(&service, &secret_ref)
            .and_then(|entry| entry.set_password(&value))
            .map_err(|_| {
                AppError::new(
                    "agent_secret_store_failed",
                    "Clovy could not save the secret securely.",
                )
            });
        value.zeroize();
        result
    })
    .await
    .map_err(|_| {
        AppError::new(
            "agent_secret_store_failed",
            "Clovy could not save the secret securely.",
        )
    })?
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub async fn put(_secret_ref: &str, mut value: String) -> Result<(), AppError> {
    value.zeroize();
    Err(AppError::new(
        "agent_secret_store_unavailable",
        "Secure secret delivery is unavailable on this platform.",
    ))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub async fn take(secret_ref: &str) -> Result<Option<String>, AppError> {
    let service = service().to_string();
    let secret_ref = secret_ref.to_string();
    tokio::task::spawn_blocking(move || {
        let entry = keyring::Entry::new(&service, &secret_ref).map_err(|_| {
            AppError::new(
                "agent_secret_read_failed",
                "Clovy could not read the saved secret.",
            )
        })?;
        let value = match entry.get_password() {
            Ok(value) => Some(value),
            Err(keyring::Error::NoEntry) => None,
            Err(_) => {
                return Err(AppError::new(
                    "agent_secret_read_failed",
                    "Clovy could not read the saved secret.",
                ))
            }
        };
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(value),
            Err(_) => Err(AppError::new(
                "agent_secret_delete_failed",
                "Clovy could not remove the consumed secret.",
            )),
        }
    })
    .await
    .map_err(|_| {
        AppError::new(
            "agent_secret_read_failed",
            "Clovy could not read the saved secret.",
        )
    })?
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub async fn take(_secret_ref: &str) -> Result<Option<String>, AppError> {
    Ok(None)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub async fn delete(secret_ref: &str) -> Result<(), AppError> {
    let service = service().to_string();
    let secret_ref = secret_ref.to_string();
    tokio::task::spawn_blocking(move || {
        let entry = keyring::Entry::new(&service, &secret_ref).map_err(|_| {
            AppError::new(
                "agent_secret_delete_failed",
                "Clovy could not remove the saved secret.",
            )
        })?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AppError::new(
                "agent_secret_delete_failed",
                "Clovy could not remove the saved secret.",
            )),
        }
    })
    .await
    .map_err(|_| {
        AppError::new(
            "agent_secret_delete_failed",
            "Clovy could not remove the saved secret.",
        )
    })?
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub async fn delete(_secret_ref: &str) -> Result<(), AppError> {
    Ok(())
}
