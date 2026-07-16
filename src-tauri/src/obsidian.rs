use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use tauri::AppHandle;

pub const OBSIDIAN_VAULT_PATH_ENV: &str = "OBSIDIAN_VAULT_PATH";
const OBSIDIAN_CONFIG_FILE: &str = "obsidian.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianStatus {
    pub connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianConfigureRequest {
    pub vault_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObsidianConfig {
    vault_path: String,
}

#[tauri::command]
pub fn obsidian_status(app: AppHandle) -> Result<ObsidianStatus, AppError> {
    status_for_app(&app)
}

#[tauri::command]
pub fn obsidian_configure(
    app: AppHandle,
    request: ObsidianConfigureRequest,
) -> Result<ObsidianStatus, AppError> {
    let vault_path = validate_vault_path(Path::new(request.vault_path.trim()))?;
    let config = ObsidianConfig {
        vault_path: vault_path.to_string_lossy().into_owned(),
    };
    write_config(&app, &config)?;
    Ok(status_from_path(vault_path))
}

#[tauri::command]
pub fn obsidian_disconnect(app: AppHandle) -> Result<ObsidianStatus, AppError> {
    let path = config_path(&app)?;
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(AppError::new(
                "obsidian_config_unavailable",
                format!("Could not disconnect Obsidian. {error}"),
            ));
        }
    }
    Ok(ObsidianStatus {
        connected: false,
        vault_path: None,
        vault_name: None,
    })
}

pub(crate) fn configured_vault_path(app: &AppHandle) -> Option<PathBuf> {
    read_config(app)
        .ok()
        .and_then(|config| validate_vault_path(Path::new(&config.vault_path)).ok())
}

fn status_for_app(app: &AppHandle) -> Result<ObsidianStatus, AppError> {
    let Some(config) = read_config_optional(app)? else {
        return Ok(ObsidianStatus {
            connected: false,
            vault_path: None,
            vault_name: None,
        });
    };
    let vault_path = validate_vault_path(Path::new(&config.vault_path))?;
    Ok(status_from_path(vault_path))
}

fn status_from_path(path: PathBuf) -> ObsidianStatus {
    let vault_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    ObsidianStatus {
        connected: true,
        vault_path: Some(path.to_string_lossy().into_owned()),
        vault_name,
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    crate::app_paths::app_config_dir(app)
        .map(|dir| dir.join(OBSIDIAN_CONFIG_FILE))
        .map_err(|error| AppError::new("obsidian_config_unavailable", error.to_string()))
}

fn read_config(app: &AppHandle) -> Result<ObsidianConfig, AppError> {
    read_config_optional(app)?.ok_or_else(|| {
        AppError::new(
            "obsidian_not_connected",
            "Connect an Obsidian vault before using Obsidian tools.",
        )
    })
}

fn read_config_optional(app: &AppHandle) -> Result<Option<ObsidianConfig>, AppError> {
    let path = config_path(app)?;
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(AppError::new(
                "obsidian_config_unavailable",
                error.to_string(),
            ));
        }
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| AppError::new("obsidian_config_invalid", error.to_string()))
}

fn write_config(app: &AppHandle, config: &ObsidianConfig) -> Result<(), AppError> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::new("obsidian_config_unavailable", error.to_string()))?;
    }
    let text = serde_json::to_string_pretty(config)
        .map_err(|error| AppError::new("obsidian_config_unavailable", error.to_string()))?;
    fs::write(path, format!("{text}\n"))
        .map_err(|error| AppError::new("obsidian_config_unavailable", error.to_string()))
}

fn validate_vault_path(path: &Path) -> Result<PathBuf, AppError> {
    if !path.is_absolute() {
        return Err(AppError::new(
            "obsidian_vault_invalid",
            "Choose an absolute Obsidian vault folder.",
        ));
    }
    let canonical = path.canonicalize().map_err(|_| {
        AppError::new(
            "obsidian_vault_invalid",
            "Choose an existing Obsidian vault folder.",
        )
    })?;
    if !canonical.is_dir() {
        return Err(AppError::new(
            "obsidian_vault_invalid",
            "Choose an existing Obsidian vault folder.",
        ));
    }
    if !canonical.join(".obsidian").is_dir() {
        return Err(AppError::new(
            "obsidian_vault_invalid",
            "Choose a folder that contains an .obsidian directory.",
        ));
    }
    ensure_readable(&canonical)?;
    ensure_writable(&canonical)?;
    Ok(normalize_vault_path_for_external_use(canonical))
}

/// `std::fs::canonicalize` returns a Windows extended-length path (`\\?\C:\…`)
/// even when the user picked a normal drive-letter path. The prefix is useful to
/// Win32 internals but confusing in Settings and not consistently accepted by
/// tools the runtime launches, so persist and pass the conventional form.
#[cfg(target_os = "windows")]
fn normalize_vault_path_for_external_use(path: PathBuf) -> PathBuf {
    let path = path.to_string_lossy();
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    if let Some(drive_path) = path.strip_prefix(r"\\?\") {
        return PathBuf::from(drive_path);
    }
    PathBuf::from(path.as_ref())
}

#[cfg(not(target_os = "windows"))]
fn normalize_vault_path_for_external_use(path: PathBuf) -> PathBuf {
    path
}

fn ensure_readable(path: &Path) -> Result<(), AppError> {
    fs::read_dir(path)
        .map(|_| ())
        .map_err(|_| AppError::new("obsidian_vault_unreadable", "June cannot read this vault."))
}

fn ensure_writable(path: &Path) -> Result<(), AppError> {
    let probe = path.join(format!(".june-obsidian-write-probe-{}", std::process::id()));
    let result = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&probe)
        .and_then(|mut file| file.write_all(b"ok"));
    let _ = fs::remove_file(&probe);
    result.map(|_| ()).map_err(|_| {
        AppError::new(
            "obsidian_vault_unwritable",
            "June cannot write to this vault.",
        )
    })
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::normalize_vault_path_for_external_use;
    use super::validate_vault_path;

    #[test]
    fn validates_real_vault_and_canonicalizes() {
        let temp = tempfile::tempdir().expect("tempdir");
        let vault = temp.path().join("My Vault");
        std::fs::create_dir_all(vault.join(".obsidian")).expect("vault");
        std::fs::create_dir_all(vault.join("folder")).expect("child");
        let child = vault.join("folder").join("..");
        let validated = validate_vault_path(&child).expect("valid vault");
        assert_eq!(validated, vault.canonicalize().expect("canonical"));
    }

    #[test]
    fn rejects_non_obsidian_directory() {
        let temp = tempfile::tempdir().expect("tempdir");
        let err = validate_vault_path(temp.path()).expect_err("not a vault");
        assert_eq!(err.code, "obsidian_vault_invalid");
    }

    #[test]
    fn rejects_relative_path() {
        let err =
            validate_vault_path(std::path::Path::new("relative/vault")).expect_err("relative");
        assert_eq!(err.code, "obsidian_vault_invalid");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalizes_windows_extended_length_vault_paths() {
        assert_eq!(
            normalize_vault_path_for_external_use(std::path::PathBuf::from(
                r"\\?\C:\Users\jimmy\OneDrive\Dokumen\Jimmy",
            )),
            std::path::PathBuf::from(r"C:\Users\jimmy\OneDrive\Dokumen\Jimmy"),
        );
        assert_eq!(
            normalize_vault_path_for_external_use(std::path::PathBuf::from(
                r"\\?\UNC\server\share\Vault",
            )),
            std::path::PathBuf::from(r"\\server\share\Vault"),
        );
    }
}
