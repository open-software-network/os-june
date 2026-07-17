use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::AppHandle;

pub const OBSIDIAN_VAULT_PATH_ENV: &str = "OBSIDIAN_VAULT_PATH";
const OBSIDIAN_CONFIG_FILE: &str = "obsidian.json";
const HERMES_ENV_PROJECTION_LOCK_FILE: &str = ".june-obsidian-env.lock";
const HERMES_ENV_PROJECTION_LOCK_WAIT: Duration = Duration::from_secs(2);
const HERMES_ENV_PROJECTION_STALE_LOCK_AGE: Duration = Duration::from_secs(30);


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
    reject_dotenv_unsafe_path(request.vault_path.trim())?;
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

pub(crate) fn configured_vault_path(app: &AppHandle) -> Result<Option<PathBuf>, AppError> {
    let Some(config) = read_config_optional(app)? else {
        return Ok(None);
    };
    validate_vault_path(Path::new(&config.vault_path)).map(Some)
}

/// Synchronizes June's selected vault into the Hermes runtime's `.env` file.
/// `obsidian.json` remains the source of truth; this file is a narrowly owned
/// projection because the pinned Hermes runtime reloads it with precedence over
/// the process environment. June owns only `OBSIDIAN_VAULT_PATH` and preserves
/// every unrelated setting, comment, and secret.
pub(crate) fn sync_hermes_env_projection(
    hermes_home: &Path,
    vault_path: Option<&Path>,
) -> Result<(), AppError> {
    let env_path = hermes_home.join(".env");
    let _file_guard = acquire_hermes_env_projection_lock(hermes_home).map_err(|_| {
        AppError::new(
            "obsidian_runtime_config_unavailable",
            "Could not update the Hermes runtime configuration.",
        )
    })?;
    let existing = match fs::read_to_string(&env_path) {
        Ok(contents) => Some(contents),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => {
            return Err(AppError::new(
                "obsidian_runtime_config_unavailable",
                "Could not update the Hermes runtime configuration.",
            ));
        }
    };
    let projected = render_hermes_env_projection(existing.as_deref().unwrap_or(""), vault_path)?;
    if existing.as_deref() == Some(projected.as_str())
        || (existing.is_none() && projected.is_empty())
    {
        return Ok(());
    }
    atomic_write_env(&env_path, &projected).map_err(|_| {
        AppError::new(
            "obsidian_runtime_config_unavailable",
            "Could not update the Hermes runtime configuration.",
        )
    })
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

#[derive(Debug)]
struct HermesEnvProjectionFileLock {
    path: PathBuf,
}

impl Drop for HermesEnvProjectionFileLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// Cross-process counterpart to the in-process mutex. Every June process holds
/// this same-directory lock while it reads and atomically replaces `.env`; the
/// bounded stale-lock recovery avoids a crash wedging future app launches.
fn acquire_hermes_env_projection_lock(
    hermes_home: &Path,
) -> std::io::Result<HermesEnvProjectionFileLock> {
    fs::create_dir_all(hermes_home)?;
    let path = hermes_home.join(HERMES_ENV_PROJECTION_LOCK_FILE);
    let deadline = Instant::now() + HERMES_ENV_PROJECTION_LOCK_WAIT;
    loop {
        match OpenOptions::new().create_new(true).write(true).open(&path) {
            Ok(mut file) => {
                file.write_all(std::process::id().to_string().as_bytes())?;
                file.sync_all()?;
                return Ok(HermesEnvProjectionFileLock { path });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = fs::metadata(&path)
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age > HERMES_ENV_PROJECTION_STALE_LOCK_AGE);
                if stale {
                    let _ = fs::remove_file(&path);
                    continue;
                }
                if Instant::now() >= deadline {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::WouldBlock,
                        "Hermes runtime environment is busy",
                    ));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(error),
        }
    }
}

fn render_hermes_env_projection(
    existing: &str,
    vault_path: Option<&Path>,
) -> Result<String, AppError> {
    let mut retained = Vec::new();
    for line in existing.split_inclusive('\n') {
        if !is_active_obsidian_assignment(line) {
            retained.push(line);
        }
    }
    // `split_inclusive` intentionally retains every unrelated line byte-for-byte.
    // A final line without a newline remains intact, but append a separator before
    // June's derived key so it cannot join that line.
    let mut rendered = retained.concat();
    if let Some(vault_path) = vault_path {
        let vault_path = vault_path.to_string_lossy();
        reject_dotenv_unsafe_path(&vault_path)?;
        if !rendered.is_empty() && !rendered.ends_with('\n') {
            rendered.push('\n');
        }
        rendered.push_str(OBSIDIAN_VAULT_PATH_ENV);
        rendered.push('=');
        rendered.push_str(&dotenv_single_quote(&vault_path));
        rendered.push('\n');
    }
    Ok(rendered)
}

/// Matches only an uncommented dotenv assignment to the one key June owns.
/// Leading whitespace is permitted by python-dotenv; commented examples are
/// deliberately retained, as are similarly named keys such as `X_OBSIDIAN…`.
fn is_active_obsidian_assignment(line: &str) -> bool {
    let line = line.trim_start_matches([' ', '\t']);
    let line = line
        .strip_prefix("export")
        .filter(|suffix| suffix.starts_with([' ', '\t']))
        .map(str::trim_start)
        .unwrap_or(line);
    let Some((key, _)) = line.split_once('=') else {
        return false;
    };
    key.trim() == OBSIDIAN_VAULT_PATH_ENV
}

fn dotenv_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn reject_dotenv_unsafe_path(value: &str) -> Result<(), AppError> {
    if value.contains(['\0', '\r', '\n']) {
        return Err(AppError::new(
            "obsidian_vault_invalid",
            "Choose a vault path without line breaks.",
        ));
    }
    Ok(())
}

fn atomic_write_env(path: &Path, content: &str) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "runtime environment path has no parent",
        )
    })?;
    fs::create_dir_all(parent)?;
    let temp_path = parent.join(format!(
        ".june-obsidian-env-{}-{}.tmp",
        std::process::id(),
        rand::random::<u64>()
    ));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)?;
        if let Ok(metadata) = fs::metadata(path) {
            file.set_permissions(metadata.permissions())?;
        }
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        replace_env_file(&temp_path, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[cfg(windows)]
fn replace_env_file(temp_path: &Path, path: &Path) -> std::io::Result<()> {
    match fs::rename(temp_path, path) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            fs::remove_file(path)?;
            fs::rename(temp_path, path)
        }
        Err(error) => Err(error),
    }
}

#[cfg(not(windows))]
fn replace_env_file(temp_path: &Path, path: &Path) -> std::io::Result<()> {
    fs::rename(temp_path, path)
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
    use super::{
        acquire_hermes_env_projection_lock, dotenv_single_quote, is_active_obsidian_assignment,
        reject_dotenv_unsafe_path, render_hermes_env_projection, sync_hermes_env_projection,
        validate_vault_path, HERMES_ENV_PROJECTION_LOCK_FILE,
    };

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

    #[test]
    fn projects_only_the_obsidian_key_into_hermes_env() {
        let existing = "# Keep this comment\nOPENAI_API_KEY=secret-value\n\nOBSIDIAN_VAULT_PATH=stale\nexport OBSIDIAN_VAULT_PATH = old\n# OBSIDIAN_VAULT_PATH=example\nOTHER=value\n";
        let rendered = render_hermes_env_projection(
            existing,
            Some(std::path::Path::new("C:\\Users\\jimmy\\Vault #1")),
        )
        .expect("projection");

        assert_eq!(
            rendered,
            "# Keep this comment\nOPENAI_API_KEY=secret-value\n\n# OBSIDIAN_VAULT_PATH=example\nOTHER=value\nOBSIDIAN_VAULT_PATH='C:\\\\Users\\\\jimmy\\\\Vault #1'\n"
        );
        assert!(!is_active_obsidian_assignment(
            "# OBSIDIAN_VAULT_PATH=example"
        ));
        assert!(is_active_obsidian_assignment(
            " export OBSIDIAN_VAULT_PATH = value"
        ));
    }

    #[test]
    fn disconnect_projection_removes_only_active_obsidian_assignments() {
        let rendered = render_hermes_env_projection(
            "A=1\nOBSIDIAN_VAULT_PATH=old\n# OBSIDIAN_VAULT_PATH=example\nB=2\n",
            None,
        )
        .expect("projection");
        assert_eq!(rendered, "A=1\n# OBSIDIAN_VAULT_PATH=example\nB=2\n");
    }

    #[test]
    fn dotenv_values_escape_backslashes_and_quotes() {
        assert_eq!(
            dotenv_single_quote("C:\\Vault O'Brien"),
            "'C:\\\\Vault O\\'Brien'"
        );
    }

    #[test]
    fn rejects_dotenv_line_break_injection() {
        let error = reject_dotenv_unsafe_path("vault\nOTHER=value").expect_err("line break");
        assert_eq!(error.code, "obsidian_vault_invalid");
    }

    #[test]
    fn projection_lock_refuses_an_active_cross_process_update() {
        let home = tempfile::tempdir().expect("tempdir");
        let _guard = acquire_hermes_env_projection_lock(home.path()).expect("first lock");
        let error = acquire_hermes_env_projection_lock(home.path()).expect_err("second lock");
        assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
        assert!(home.path().join(HERMES_ENV_PROJECTION_LOCK_FILE).exists());
    }

    #[test]
    fn sync_writes_and_removes_its_derived_assignment() {
        let home = tempfile::tempdir().expect("tempdir");
        let env_path = home.path().join(".env");
        std::fs::write(&env_path, "EXISTING=value\n").expect("seed env");

        sync_hermes_env_projection(home.path(), Some(std::path::Path::new("/vault path")))
            .expect("write projection");
        assert_eq!(
            std::fs::read_to_string(&env_path).expect("read projection"),
            "EXISTING=value\nOBSIDIAN_VAULT_PATH='/vault path'\n"
        );

        sync_hermes_env_projection(home.path(), None).expect("remove projection");
        assert_eq!(
            std::fs::read_to_string(&env_path).expect("read removal"),
            "EXISTING=value\n"
        );
    }

    #[test]
    fn invalid_runtime_env_is_not_overwritten() {
        let home = tempfile::tempdir().expect("tempdir");
        let env_path = home.path().join(".env");
        let original = [0xff, b'\n'];
        std::fs::write(&env_path, original).expect("write invalid env");

        let error = sync_hermes_env_projection(home.path(), Some(std::path::Path::new("/vault")))
            .expect_err("invalid env");
        assert_eq!(error.code, "obsidian_runtime_config_unavailable");
        assert_eq!(std::fs::read(&env_path).expect("read original"), original);
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
