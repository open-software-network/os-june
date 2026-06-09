//! Audio storage policy: optional FLAC compression of saved recordings.
//!
//! Capture always records WAV; the storage mode only decides what happens to
//! validated artifacts afterwards. Compression runs on the per-note processing
//! queue so it never competes with — or deletes audio out from under — the
//! transcription job for the same recording, and a compression failure never
//! affects the note's processing status.

use crate::{
    app_paths::AppPaths,
    audio::compression::{
        compress_wav_to_flac, compression_ratio, validate_flac_matches_wav, CompressionOutcome,
        FLAC_FORMAT,
    },
    db::repositories::{CompressibleArtifact, Repositories},
    domain::{processing_queue, types::AppError},
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::Instant,
};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AudioStorageMode {
    /// Keep recordings as WAV only (no compression).
    #[default]
    WavOnly,
    /// Create a FLAC archive copy after a recording validates.
    CompressedAfterValidation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioStorageSettings {
    pub mode: AudioStorageMode,
    /// When compressing, keep the WAV original alongside the FLAC archive.
    /// When false, the WAV is deleted only after the FLAC copy passes
    /// lossless validation.
    pub keep_wav_after_compression: bool,
}

impl Default for AudioStorageSettings {
    fn default() -> Self {
        Self {
            mode: AudioStorageMode::WavOnly,
            keep_wav_after_compression: true,
        }
    }
}

pub struct AudioStorageSettingsState {
    path: PathBuf,
    settings: Mutex<AudioStorageSettings>,
}

static SETTINGS_CACHE: OnceLock<Mutex<AudioStorageSettings>> = OnceLock::new();

fn settings_cache() -> &'static Mutex<AudioStorageSettings> {
    SETTINGS_CACHE.get_or_init(|| Mutex::new(AudioStorageSettings::default()))
}

fn replace_cached_settings(settings: AudioStorageSettings) {
    if let Ok(mut cached) = settings_cache().lock() {
        *cached = settings;
    }
}

/// Storage settings readable from backend code without an [`AppHandle`]
/// (mirrors `dictation::configured_transcription_language`).
pub fn configured_audio_storage_settings() -> AudioStorageSettings {
    settings_cache()
        .lock()
        .map(|settings| settings.clone())
        .unwrap_or_default()
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("audio-storage-settings.json"))
}

fn load_settings(app: &AppHandle) -> AudioStorageSettings {
    let Some(path) = settings_path(app) else {
        return AudioStorageSettings::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|settings| serde_json::from_str::<AudioStorageSettings>(&settings).ok())
        .unwrap_or_default()
}

pub fn setup(app: &AppHandle) {
    let path = settings_path(app).unwrap_or_else(|| PathBuf::from("audio-storage-settings.json"));
    let settings = load_settings(app);
    replace_cached_settings(settings.clone());
    app.manage(AudioStorageSettingsState {
        path,
        settings: Mutex::new(settings),
    });
}

fn save_settings(
    state: &AudioStorageSettingsState,
    settings: &AudioStorageSettings,
) -> Result<(), AppError> {
    if let Some(parent) = state.path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            AppError::new("audio_storage_settings_save_failed", error.to_string())
        })?;
    }
    let serialized = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::new("audio_storage_settings_save_failed", error.to_string()))?;
    fs::write(&state.path, serialized)
        .map_err(|error| AppError::new("audio_storage_settings_save_failed", error.to_string()))
}

#[tauri::command]
pub fn audio_storage_settings(
    state: State<'_, AudioStorageSettingsState>,
) -> Result<AudioStorageSettings, AppError> {
    state
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| {
            AppError::new(
                "audio_storage_settings_unavailable",
                "Audio storage settings lock failed.",
            )
        })
}

#[tauri::command]
pub fn set_audio_storage_settings(
    state: State<'_, AudioStorageSettingsState>,
    settings: AudioStorageSettings,
) -> Result<AudioStorageSettings, AppError> {
    save_settings(&state, &settings)?;
    let mut current = state.settings.lock().map_err(|_| {
        AppError::new(
            "audio_storage_settings_unavailable",
            "Audio storage settings lock failed.",
        )
    })?;
    *current = settings.clone();
    replace_cached_settings(settings.clone());
    Ok(settings)
}

/// Queues archival compression for a validated session behind any processing
/// already running for the note. No-op unless compression is enabled.
pub fn schedule_session_compression(
    repos: Repositories,
    paths: AppPaths,
    note_id: String,
    session_id: String,
) {
    let settings = configured_audio_storage_settings();
    if settings.mode != AudioStorageMode::CompressedAfterValidation {
        return;
    }
    tokio::spawn(async move {
        let (ticket, _depth) = processing_queue::enqueue(&note_id);
        let queue_lock = ticket.lock();
        let _guard = queue_lock.lock().await;
        compress_session_artifacts(
            &repos,
            &paths,
            &session_id,
            settings.keep_wav_after_compression,
        )
        .await;
        ticket.finish();
    });
}

/// Compresses every validated, not-yet-compressed artifact of a session.
/// Failures are recorded per artifact and never propagate to the note.
pub async fn compress_session_artifacts(
    repos: &Repositories,
    paths: &AppPaths,
    session_id: &str,
    keep_wav: bool,
) {
    let artifacts = match repos.compressible_artifacts_for_session(session_id).await {
        Ok(artifacts) => artifacts,
        Err(error) => {
            tracing::warn!(%session_id, %error, "could not list artifacts for compression");
            return;
        }
    };
    for artifact in artifacts {
        let started = Instant::now();
        let result = compress_one_artifact(paths, &artifact).await;
        let duration_ms = started.elapsed().as_millis().min(i64::MAX as u128) as i64;
        match result {
            Ok(outcome) => {
                let ratio =
                    compression_ratio(outcome.original_size_bytes, outcome.compressed_size_bytes);
                if let Err(error) = repos
                    .record_artifact_compression(
                        &artifact.id,
                        FLAC_FORMAT,
                        &outcome.output_path.to_string_lossy(),
                        outcome.compressed_size_bytes,
                        &outcome.compressed_checksum,
                        "succeeded",
                        None,
                    )
                    .await
                {
                    tracing::warn!(%session_id, artifact_id = %artifact.id, %error, "could not record compression result");
                    // Without the metadata row the FLAC copy is unreachable,
                    // so the WAV original must survive regardless of policy.
                    continue;
                }
                tracing::info!(
                    %session_id,
                    artifact_id = %artifact.id,
                    source = %artifact.source,
                    original_bytes = outcome.original_size_bytes,
                    compressed_bytes = outcome.compressed_size_bytes,
                    compression_ratio = ratio.unwrap_or_default(),
                    "compressed recording artifact"
                );
                let _ = repos
                    .add_source_checkpoint(
                        session_id,
                        Some(&artifact.id),
                        Some(&artifact.source),
                        "audio_compression",
                        Some(
                            serde_json::json!({
                                "durationMs": duration_ms,
                                "status": "succeeded",
                                "format": FLAC_FORMAT,
                                "originalBytes": outcome.original_size_bytes,
                                "compressedBytes": outcome.compressed_size_bytes,
                                "compressionRatio": ratio,
                            })
                            .to_string(),
                        ),
                    )
                    .await;
                if !keep_wav {
                    remove_original_wav(repos, paths, &artifact).await;
                }
            }
            Err(error) => {
                tracing::warn!(
                    %session_id,
                    artifact_id = %artifact.id,
                    code = %error.code,
                    message = %error.message,
                    "artifact compression failed; keeping WAV original"
                );
                let _ = repos
                    .record_artifact_compression(
                        &artifact.id,
                        FLAC_FORMAT,
                        "",
                        0,
                        "",
                        "failed",
                        Some(&error.message),
                    )
                    .await;
                let _ = repos
                    .add_source_checkpoint(
                        session_id,
                        Some(&artifact.id),
                        Some(&artifact.source),
                        "audio_compression",
                        Some(
                            serde_json::json!({
                                "durationMs": duration_ms,
                                "status": "failed",
                                "error": error.code,
                            })
                            .to_string(),
                        ),
                    )
                    .await;
            }
        }
    }
}

async fn compress_one_artifact(
    paths: &AppPaths,
    artifact: &CompressibleArtifact,
) -> Result<CompressionOutcome, AppError> {
    let wav_path = paths
        .contained_recording_file(&artifact.path)
        .map_err(|error| AppError::new("audio_compression_failed", error.to_string()))?;
    if !wav_path.exists() {
        return Err(AppError::new(
            "audio_compression_failed",
            "Source WAV is no longer available.",
        ));
    }
    let flac_path = wav_path.with_extension("flac");
    tokio::task::spawn_blocking(move || {
        let outcome = compress_wav_to_flac(&wav_path, &flac_path)?;
        if let Err(error) = validate_flac_matches_wav(&flac_path, &wav_path) {
            // Never leave an unvalidated archive behind: a later retry could
            // mistake it for a usable copy of the recording.
            let _ = std::fs::remove_file(&flac_path);
            return Err(error);
        }
        Ok(outcome)
    })
    .await
    .map_err(|error| AppError::new("audio_compression_failed", error.to_string()))?
}

async fn remove_original_wav(
    repos: &Repositories,
    paths: &AppPaths,
    artifact: &CompressibleArtifact,
) {
    if let Err(error) = paths.remove_recording_file(&artifact.path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(artifact_id = %artifact.id, %error, "could not remove WAV original after compression");
            return;
        }
    }
    if let Err(error) = repos.mark_artifact_original_removed(&artifact.id).await {
        tracing::warn!(artifact_id = %artifact.id, %error, "could not mark WAV original as removed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_to_wav_only_with_originals_kept() {
        let settings = AudioStorageSettings::default();
        assert_eq!(settings.mode, AudioStorageMode::WavOnly);
        assert!(settings.keep_wav_after_compression);
    }

    #[test]
    fn settings_deserialize_with_missing_fields() {
        let settings: AudioStorageSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings, AudioStorageSettings::default());

        let settings: AudioStorageSettings =
            serde_json::from_str(r#"{"mode":"compressedAfterValidation"}"#).unwrap();
        assert_eq!(settings.mode, AudioStorageMode::CompressedAfterValidation);
        assert!(settings.keep_wav_after_compression);
    }

    #[test]
    fn settings_round_trip_camel_case() {
        let settings = AudioStorageSettings {
            mode: AudioStorageMode::CompressedAfterValidation,
            keep_wav_after_compression: false,
        };
        let serialized = serde_json::to_string(&settings).unwrap();
        assert!(serialized.contains("compressedAfterValidation"));
        assert!(serialized.contains("keepWavAfterCompression"));
        let parsed: AudioStorageSettings = serde_json::from_str(&serialized).unwrap();
        assert_eq!(parsed, settings);
    }
}
