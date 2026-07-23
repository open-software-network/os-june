//! Release channel selection for the in-app updater.
//!
//! Tauri has no built-in update "channel": the channel is simply which updater
//! manifest URL we point at. The JS `check()` cannot override endpoints (Tauri
//! restricts runtime endpoints to Rust for security), so channel selection
//! lives here and the update check/install run as the `fetch_update` /
//! `install_update` commands below.

use semver::Version;
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

/// The updater's install gate, extracted from the `version_comparator` closure so
/// it can be tested without a live updater. Mirrors Tauri's default
/// (`remote > current`) except when reconciling onto stable: there, a prerelease
/// build is also allowed to install an *older* stable, so a user leaving the rc
/// channel drops back onto the current stable line instead of being stranded on
/// their rc build until stable catches up (Q4-Q6).
///
/// The prerelease escape is gated on `channel == Stable`: on the rc channel the
/// installed build is always a prerelease, so allowing the escape there would let
/// rc.2 "update" down to rc.1 and wreck rc iteration ordering (Q1). `reconcile` is
/// a one-time flag the frontend only sets on the leave-rc switch, never on routine
/// launch/periodic/manual checks, so a normal check never downgrades.
fn should_update(
    channel: ReleaseChannel,
    current: &Version,
    remote: &Version,
    reconcile: bool,
) -> bool {
    if channel == ReleaseChannel::Stable && reconcile {
        remote > current || !current.pre.is_empty()
    } else {
        remote > current
    }
}

/// Checks the persisted channel's manifest for an update. Endpoints are set at
/// runtime (the only place Tauri allows it) from the channel, while the
/// signature pubkey is inherited from `tauri.conf.json`. The found `Update` is
/// stashed for `install_update`; a `None` result clears any stale handle.
///
/// The channel is read from managed state rather than passed in, so the check
/// always follows the setting the user actually saved. `reconcile` (false for
/// every routine check) opens the one-time escape from a prerelease onto an older
/// stable when leaving the rc channel; see `should_update`.
#[tauri::command]
pub async fn fetch_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    reconcile: bool,
) -> Result<Option<UpdateMeta>, AppError> {
    let channel = current_channel(&app);
    let endpoint = tauri::Url::parse(channel.endpoint())
        .map_err(|error| AppError::new("update_check_failed", error.to_string()))?;
    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| AppError::new("update_check_failed", error.to_string()))?
        // The comparator is the sole downgrade gate; routing the default path
        // through `should_update` too keeps all install-decision logic in one
        // tested place. With reconcile=false this is exactly `remote > current`.
        .version_comparator(move |current, release| {
            should_update(channel, &current, &release.version, reconcile)
        })
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

/// Relaunches June after an in-app update has been staged, running the same
/// child-process teardown app quit does *before* the process restarts.
///
/// The plugin `relaunch()` (and `AppHandle::restart()` on the main thread)
/// restarts without a guaranteed pass through the `RunEvent::Exit` cleanup that
/// reaps June's children. On an update the `.app` bundle is swapped, so a
/// skipped teardown orphans the dictation helper — which keeps the global
/// CGEventTap and its stdio — and the relaunched instance then cannot bring up a
/// clean helper, so every helper-reported permission (dictation mic and
/// accessibility) reads missing even though the grants are intact (JUN-338).
/// Tearing down explicitly here guarantees the helpers and Hermes runtime are
/// gone before the new instance starts. The final restart is dispatched to the
/// main thread so Tauri restarts directly instead of delivering `RunEvent::Exit`
/// and synchronously repeating the full cleanup on the UI event loop. That
/// duplicate exit path can leave the window parked in its disabled relaunching
/// state while a background service is still winding down.
#[tauri::command]
pub async fn relaunch_for_update(app: AppHandle) -> Result<(), AppError> {
    crate::note_save_flush::request(&app).await;
    crate::dictation::stop_helper(&app);
    crate::computer_use::shutdown(&app).await;
    crate::hermes_bridge::shutdown(&app).await;

    let restart_app = app.clone();
    app.run_on_main_thread(move || restart_app.restart())
        .map_err(|error| AppError::new("update_relaunch_failed", error.to_string()))
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

    fn v(raw: &str) -> Version {
        Version::parse(raw).unwrap()
    }

    // The reconcile escape: on stable, a prerelease build installs an OLDER stable
    // so leaving rc drops you back onto the stable line (Q4-Q6).
    #[test]
    fn stable_reconcile_from_prerelease_installs_older_stable() {
        assert!(should_update(
            ReleaseChannel::Stable,
            &v("1.2.3-rc.2"),
            &v("1.2.2"),
            true,
        ));
    }

    // The escape must never fire on a routine check, even from a prerelease, or a
    // periodic check would silently downgrade an rc user (Q6).
    #[test]
    fn stable_without_reconcile_never_downgrades_a_prerelease() {
        assert!(!should_update(
            ReleaseChannel::Stable,
            &v("1.2.3-rc.2"),
            &v("1.2.2"),
            false,
        ));
    }

    // A clean stable build ignores the escape entirely: reconcile only rescues a
    // prerelease, it is not a general stable rollback lever (Q5).
    #[test]
    fn stable_reconcile_from_clean_build_only_moves_forward() {
        assert!(!should_update(
            ReleaseChannel::Stable,
            &v("1.2.3"),
            &v("1.2.2"),
            true,
        ));
        assert!(should_update(
            ReleaseChannel::Stable,
            &v("1.2.3"),
            &v("1.2.4"),
            true,
        ));
    }

    // The escape is guarded on the stable channel: on rc it must stay a plain
    // forward-only compare so rc.2 never "updates" down to rc.1 (Q1). Even a stray
    // reconcile=true (which the frontend never sends on rc) cannot break ordering.
    #[test]
    fn rc_channel_is_forward_only_even_with_reconcile() {
        assert!(!should_update(
            ReleaseChannel::Rc,
            &v("1.2.3-rc.2"),
            &v("1.2.3-rc.1"),
            true,
        ));
        assert!(should_update(
            ReleaseChannel::Rc,
            &v("1.2.3-rc.1"),
            &v("1.2.3-rc.2"),
            false,
        ));
    }

    // Semver already orders a clean base above its prereleases, so promoting an rc
    // to its stable base is a normal forward update, escape or not.
    #[test]
    fn base_version_supersedes_its_prerelease() {
        assert!(should_update(
            ReleaseChannel::Stable,
            &v("1.2.3-rc.1"),
            &v("1.2.3"),
            false,
        ));
    }
}
