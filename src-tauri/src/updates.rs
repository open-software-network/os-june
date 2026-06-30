//! Release channel selection for the in-app updater.
//!
//! Tauri has no built-in update "channel": the channel is simply which updater
//! manifest URL we point at. The JS `check()` cannot override endpoints (Tauri
//! restricts runtime endpoints to Rust for security), so channel selection
//! lives here and the update check/install run as the `fetch_update` /
//! `install_update` commands below.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::UpdaterExt;

use crate::domain::types::AppError;

/// Stable manifest: GitHub's `/latest` redirect resolves to the newest
/// non-prerelease, mirroring the single endpoint baked into `tauri.conf.json`.
const STABLE_ENDPOINT: &str = "https://github.com/open-software-network/os-june-releases/releases/latest/download/latest.json";
/// RC manifest: published under a fixed `rc` tag (GitHub's `/latest` skips
/// prereleases, so it can't host this), with its asset overwritten each build.
const RC_ENDPOINT: &str =
    "https://github.com/open-software-network/os-june-releases/releases/download/rc/latest-rc.json";

/// Which release stream the updater follows. The wire form is the camelCase
/// variant name (`"stable"` / `"rc"`) shared with the frontend setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReleaseChannel {
    #[default]
    Stable,
    Rc,
}

impl ReleaseChannel {
    /// The updater manifest URL for this channel.
    pub fn endpoint(self) -> &'static str {
        match self {
            Self::Stable => STABLE_ENDPOINT,
            Self::Rc => RC_ENDPOINT,
        }
    }
}

/// On-disk shape of the channel preference. A struct (rather than a bare enum)
/// leaves room to grow the file without a migration, and `#[serde(default)]`
/// keeps older/partial files loading as stable.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseSettings {
    #[serde(default)]
    channel: ReleaseChannel,
}

/// Reads the channel preference, treating a missing or unreadable/corrupt file
/// as stable. Same forgiving contract as `dictation-settings.json`: a bad file
/// must never wedge the updater.
fn load_release_settings(path: &Path) -> ReleaseSettings {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<ReleaseSettings>(&raw).ok())
        .unwrap_or_default()
}

/// Persists the channel preference, creating the config directory if needed.
fn save_release_settings(path: &Path, settings: &ReleaseSettings) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::new("release_settings_save_failed", error.to_string()))?;
    }
    let serialized = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::new("release_settings_save_failed", error.to_string()))?;
    fs::write(path, serialized)
        .map_err(|error| AppError::new("release_settings_save_failed", error.to_string()))
}

/// Managed state holding the live channel plus where it persists. Mirrors the
/// dictation-settings pattern: the cached value answers reads without disk I/O,
/// and writes update both the file and the cache.
pub struct ReleaseChannelState {
    path: PathBuf,
    channel: Mutex<ReleaseChannel>,
}

fn settings_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("release-settings.json"))
        .unwrap_or_else(|_| PathBuf::from("release-settings.json"))
}

/// Loads the persisted channel and registers it as managed state. Called from
/// the app `setup` hook before any update check runs.
pub fn setup(app: &mut tauri::App) {
    let path = settings_path(app.handle());
    let channel = load_release_settings(&path).channel;
    app.manage(ReleaseChannelState {
        path,
        channel: Mutex::new(channel),
    });
    app.manage(PendingUpdate::default());
}

/// The channel the updater should follow right now. Defaults to stable if the
/// state is missing or its lock is poisoned, so an update check never panics.
pub fn current_channel(app: &AppHandle) -> ReleaseChannel {
    app.try_state::<ReleaseChannelState>()
        .and_then(|state| state.channel.lock().ok().map(|channel| *channel))
        .unwrap_or_default()
}

/// What `fetch_update` reports to the frontend: just enough to prompt the user.
/// Mirrors the fields `update-decision.ts` reads off an update (`version`,
/// `body`); the live `Update` handle stays in Rust (see `PendingUpdate`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMeta {
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

/// Download progress streamed to the frontend over an IPC `Channel`. The shape
/// is adjacently tagged to match the JS plugin's original event stream
/// (`{ event, data }`) so the existing throttling logic keeps working.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        #[serde(skip_serializing_if = "Option::is_none")]
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

/// Holds the `Update` returned by the most recent `fetch_update` so that a
/// follow-up `install_update` can run it. The handle is not serializable and
/// must stay Rust-side, so the frontend drives install through commands rather
/// than holding the update itself.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<tauri_plugin_updater::Update>>);

/// Checks the persisted channel's manifest for an update. Endpoints are set at
/// runtime (the only place Tauri allows it) from the channel, while the
/// signature pubkey is inherited from `tauri.conf.json`. The found `Update` is
/// stashed for `install_update`; a `None` result clears any stale handle.
///
/// The channel is read from managed state rather than passed in, so the check
/// always follows the setting the user actually saved.
#[tauri::command]
pub async fn fetch_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateMeta>, AppError> {
    let endpoint = tauri::Url::parse(current_channel(&app).endpoint())
        .map_err(|error| AppError::new("update_check_failed", error.to_string()))?;
    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| AppError::new("update_check_failed", error.to_string()))?
        .build()
        .map_err(|error| AppError::new("update_check_failed", error.to_string()))?
        .check()
        .await
        .map_err(|error| AppError::new("update_check_failed", error.to_string()))?;

    let meta = update.as_ref().map(|update| UpdateMeta {
        version: update.version.clone(),
        body: update.body.clone(),
    });

    *pending
        .0
        .lock()
        .map_err(|_| AppError::new("update_check_failed", "Update lock failed."))? = update;

    Ok(meta)
}

/// Downloads and installs the update staged by `fetch_update`, streaming
/// progress over `on_event`. The update is consumed; a failed install requires
/// a fresh `fetch_update` (the frontend re-checks before retrying).
#[tauri::command]
pub async fn install_update(
    pending: State<'_, PendingUpdate>,
    on_event: Channel<DownloadEvent>,
) -> Result<(), AppError> {
    let update = pending
        .0
        .lock()
        .map_err(|_| AppError::new("update_install_failed", "Update lock failed."))?
        .take()
        .ok_or_else(|| AppError::new("update_install_failed", "No update is staged."))?;

    let progress_channel = on_event.clone();
    let finished_channel = on_event;
    let mut started = false;

    update
        .download_and_install(
            move |chunk_length, content_length| {
                // The Rust API has no separate "started" callback, so synthesize
                // it from the first chunk to preserve the JS event sequence.
                if !started {
                    started = true;
                    let _ = progress_channel.send(DownloadEvent::Started { content_length });
                }
                let _ = progress_channel.send(DownloadEvent::Progress { chunk_length });
            },
            move || {
                let _ = finished_channel.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(|error| AppError::new("update_install_failed", error.to_string()))?;

    Ok(())
}

#[tauri::command]
pub fn get_release_channel(
    state: State<'_, ReleaseChannelState>,
) -> Result<ReleaseChannel, AppError> {
    state
        .channel
        .lock()
        .map(|channel| *channel)
        .map_err(|_| AppError::new("release_channel_unavailable", "Channel lock failed."))
}

#[tauri::command]
pub fn set_release_channel(
    channel: ReleaseChannel,
    state: State<'_, ReleaseChannelState>,
) -> Result<(), AppError> {
    let mut current = state
        .channel
        .lock()
        .map_err(|_| AppError::new("release_channel_unavailable", "Channel lock failed."))?;
    // Persist first: if the write fails the in-memory value stays in sync with
    // disk, so a later relaunch and this session agree on the channel.
    save_release_settings(&state.path, &ReleaseSettings { channel })?;
    *current = channel;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    // The frontend's download-progress throttling (update-decision.ts) reads
    // `event.event` and `event.data.contentLength` / `event.data.chunkLength`
    // verbatim, so these serde shapes are a hard wire contract, not cosmetics.
    #[test]
    fn started_event_carries_content_length_under_data() {
        let json = serde_json::to_string(&DownloadEvent::Started {
            content_length: Some(100),
        })
        .unwrap();
        assert_eq!(json, r#"{"event":"Started","data":{"contentLength":100}}"#);
    }

    #[test]
    fn started_event_omits_content_length_when_unknown() {
        let json = serde_json::to_string(&DownloadEvent::Started {
            content_length: None,
        })
        .unwrap();
        assert_eq!(json, r#"{"event":"Started","data":{}}"#);
    }

    #[test]
    fn progress_event_carries_chunk_length_under_data() {
        let json = serde_json::to_string(&DownloadEvent::Progress { chunk_length: 5 }).unwrap();
        assert_eq!(json, r#"{"event":"Progress","data":{"chunkLength":5}}"#);
    }

    #[test]
    fn finished_event_has_no_data_field() {
        let json = serde_json::to_string(&DownloadEvent::Finished).unwrap();
        assert_eq!(json, r#"{"event":"Finished"}"#);
    }

    #[test]
    fn update_meta_exposes_version_and_notes_to_the_frontend() {
        let json = serde_json::to_string(&UpdateMeta {
            version: "1.2.3-rc.4".into(),
            body: Some("notes".into()),
        })
        .unwrap();
        assert_eq!(json, r#"{"version":"1.2.3-rc.4","body":"notes"}"#);
    }

    #[test]
    fn update_meta_omits_absent_notes() {
        let json = serde_json::to_string(&UpdateMeta {
            version: "1.2.3".into(),
            body: None,
        })
        .unwrap();
        assert_eq!(json, r#"{"version":"1.2.3"}"#);
    }

    #[test]
    fn channel_uses_lowercase_wire_strings_shared_with_the_frontend() {
        assert_eq!(
            serde_json::to_string(&ReleaseChannel::Stable).unwrap(),
            "\"stable\""
        );
        assert_eq!(
            serde_json::to_string(&ReleaseChannel::Rc).unwrap(),
            "\"rc\""
        );
        assert_eq!(
            serde_json::from_str::<ReleaseChannel>("\"rc\"").unwrap(),
            ReleaseChannel::Rc
        );
    }

    #[test]
    fn missing_settings_file_defaults_to_stable() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("release-settings.json");
        assert_eq!(load_release_settings(&path).channel, ReleaseChannel::Stable);
    }

    #[test]
    fn saved_channel_round_trips_through_disk() {
        let dir = tempdir().unwrap();
        // Nested path also proves save creates missing parent directories.
        let path = dir.path().join("nested/release-settings.json");
        save_release_settings(
            &path,
            &ReleaseSettings {
                channel: ReleaseChannel::Rc,
            },
        )
        .unwrap();
        assert_eq!(load_release_settings(&path).channel, ReleaseChannel::Rc);
    }

    #[test]
    fn corrupt_settings_file_defaults_to_stable() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("release-settings.json");
        std::fs::write(&path, "{ not valid json").unwrap();
        assert_eq!(load_release_settings(&path).channel, ReleaseChannel::Stable);
    }

    #[test]
    fn stable_channel_points_at_the_latest_manifest() {
        assert_eq!(ReleaseChannel::Stable.endpoint(), STABLE_ENDPOINT);
        assert!(ReleaseChannel::Stable
            .endpoint()
            .ends_with("/releases/latest/download/latest.json"));
    }

    #[test]
    fn rc_channel_points_at_a_distinct_rc_manifest() {
        assert!(ReleaseChannel::Rc.endpoint().contains("latest-rc.json"));
        assert_ne!(
            ReleaseChannel::Rc.endpoint(),
            ReleaseChannel::Stable.endpoint()
        );
    }
}
