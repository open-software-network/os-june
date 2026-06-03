use crate::{
    app_paths::AppPaths,
    audio::{
        capture::{
            capture_status, finish_capture, microphone_permission_state, pause_capture,
            resume_capture, start_capture,
        },
        recovery::scan_recoverable_recordings,
        validation::{
            checksum_file, source_audio_passes_validation, validate_audio_artifact,
            validation_config_for_source, AudioValidationConfig,
        },
    },
    db::{migrations::run_migrations, repositories::Repositories},
    domain::{
        processing::{
            manual_notes_for_generation, process_saved_audio, process_saved_source_audio,
            retry_from_saved_audio,
        },
        processing_queue,
        types::{
            AppError, AssignNoteToFolderRequest, BootstrapResponse,
            CheckRecordingSourceReadinessRequest, CreateDictionaryEntryRequest,
            CreateFolderRequest, CreateNoteRequest, DeleteDictionaryEntryRequest,
            DeleteFolderRequest, DeleteNoteRequest, DictionaryEntryDto, FinishRecordingResponse,
            GetNoteRequest, ListNotesRequest, ListNotesResponse, MicrophonePermissionResponse,
            NoteDto, OpenPrivacySettingsRequest, RecordingSessionDto, RecordingSource,
            RecordingSourceMode, RecordingSourceReadinessDto, RecordingStatusDto,
            RemoveNoteFromFolderRequest, RenameFolderRequest, RetryProcessingRequest,
            SessionRequest, SourceReadinessDto, StartRecordingRequest,
            UpdateDictionaryEntryRequest, UpdateNoteRequest,
        },
    },
};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::str::FromStr;
use std::{path::PathBuf, time::Instant};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn bootstrap_app(app: AppHandle) -> Result<BootstrapResponse, AppError> {
    let repos = repositories(&app).await?;
    let active_recoveries = scan_recoverable_recordings(&repos.pool)
        .await
        .map_err(|error| AppError::new("recovery_scan_failed", error.to_string()))?;
    let folders = repos
        .list_folders()
        .await
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?;
    let notes = repos
        .list_notes(None, 100, None)
        .await
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?
        .items;
    Ok(BootstrapResponse {
        folders,
        notes,
        active_recoveries,
        provider_configured: crate::providers::provider_configured(),
    })
}

#[tauri::command]
pub async fn create_note(app: AppHandle, request: CreateNoteRequest) -> Result<NoteDto, AppError> {
    Ok(repositories(&app)
        .await?
        .create_note(request.folder_id)
        .await?)
}

#[tauri::command]
pub async fn list_notes(
    app: AppHandle,
    request: ListNotesRequest,
) -> Result<ListNotesResponse, AppError> {
    Ok(repositories(&app)
        .await?
        .list_notes(
            request.folder_id,
            request.limit.unwrap_or(100),
            request.cursor,
        )
        .await?)
}

#[tauri::command]
pub async fn get_note(app: AppHandle, request: GetNoteRequest) -> Result<NoteDto, AppError> {
    let mut note = repositories(&app).await?.get_note(&request.note_id).await?;
    note.queued_recordings = processing_queue::queued_behind(&request.note_id);
    Ok(note)
}

#[tauri::command]
pub async fn update_note(app: AppHandle, request: UpdateNoteRequest) -> Result<NoteDto, AppError> {
    Ok(repositories(&app)
        .await?
        .update_note(
            &request.note_id,
            request.title,
            request.edited_content,
            request.active_tab,
        )
        .await?)
}

#[tauri::command]
pub async fn delete_note(app: AppHandle, request: DeleteNoteRequest) -> Result<(), AppError> {
    let repos = repositories(&app).await?;
    let audio_paths = repos
        .audio_artifact_paths_for_note(&request.note_id)
        .await?;
    repos.delete_note(&request.note_id).await?;
    for path in audio_paths {
        if path.trim().is_empty() {
            continue;
        }
        if let Err(error) = std::fs::remove_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("failed to remove deleted note audio {path}: {error}");
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn create_folder(
    app: AppHandle,
    request: CreateFolderRequest,
) -> Result<crate::domain::types::FolderDto, AppError> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err(AppError::new(
            "folder_name_required",
            "Folder name is required.",
        ));
    }
    Ok(repositories(&app)
        .await?
        .create_folder(name, request.description.as_deref())
        .await?)
}

#[tauri::command]
pub async fn list_folders(
    app: AppHandle,
) -> Result<Vec<crate::domain::types::FolderDto>, AppError> {
    Ok(repositories(&app).await?.list_folders().await?)
}

#[tauri::command]
pub async fn delete_folder(app: AppHandle, request: DeleteFolderRequest) -> Result<(), AppError> {
    repositories(&app)
        .await?
        .delete_folder(&request.folder_id, request.delete_notes)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn rename_folder(
    app: AppHandle,
    request: RenameFolderRequest,
) -> Result<crate::domain::types::FolderDto, AppError> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err(AppError::new(
            "folder_name_required",
            "Folder name is required.",
        ));
    }
    repositories(&app)
        .await?
        .rename_folder(&request.folder_id, name, request.description.as_deref())
        .await
}

#[tauri::command]
pub async fn assign_note_to_folder(
    app: AppHandle,
    request: AssignNoteToFolderRequest,
) -> Result<NoteDto, AppError> {
    Ok(repositories(&app)
        .await?
        .assign_note_to_folder(&request.note_id, &request.folder_id)
        .await?)
}

#[tauri::command]
pub async fn remove_note_from_folder(
    app: AppHandle,
    request: RemoveNoteFromFolderRequest,
) -> Result<NoteDto, AppError> {
    Ok(repositories(&app)
        .await?
        .remove_note_from_folder(&request.note_id, &request.folder_id)
        .await?)
}

#[tauri::command]
pub async fn list_dictionary_entries(app: AppHandle) -> Result<Vec<DictionaryEntryDto>, AppError> {
    Ok(repositories(&app).await?.list_dictionary_entries().await?)
}

#[tauri::command]
pub async fn create_dictionary_entry(
    app: AppHandle,
    request: CreateDictionaryEntryRequest,
) -> Result<DictionaryEntryDto, AppError> {
    let phrase = request.phrase.trim();
    if phrase.is_empty() {
        return Err(AppError::new(
            "dictionary_phrase_required",
            "Dictionary word or phrase is required.",
        ));
    }
    Ok(repositories(&app)
        .await?
        .create_dictionary_entry(phrase)
        .await?)
}

#[tauri::command]
pub async fn update_dictionary_entry(
    app: AppHandle,
    request: UpdateDictionaryEntryRequest,
) -> Result<DictionaryEntryDto, AppError> {
    let phrase = request.phrase.trim();
    if phrase.is_empty() {
        return Err(AppError::new(
            "dictionary_phrase_required",
            "Dictionary word or phrase is required.",
        ));
    }
    repositories(&app)
        .await?
        .update_dictionary_entry(&request.entry_id, phrase)
        .await
}

#[tauri::command]
pub async fn delete_dictionary_entry(
    app: AppHandle,
    request: DeleteDictionaryEntryRequest,
) -> Result<(), AppError> {
    repositories(&app)
        .await?
        .delete_dictionary_entry(&request.entry_id)
        .await
}

#[tauri::command]
pub async fn get_microphone_permission_state() -> Result<MicrophonePermissionResponse, AppError> {
    let (state, recovery_hint) = microphone_permission_state();
    Ok(MicrophonePermissionResponse {
        state,
        recovery_hint,
    })
}

#[tauri::command]
pub async fn check_recording_source_readiness(
    request: CheckRecordingSourceReadinessRequest,
) -> Result<RecordingSourceReadinessDto, AppError> {
    Ok(recording_source_readiness(request.source_mode))
}

#[tauri::command]
pub async fn open_privacy_settings(request: OpenPrivacySettingsRequest) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        let url = match request.pane.as_str() {
            "microphone" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            "accessibility" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            "systemAudio" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            _ => "x-apple.systempreferences:com.apple.preference.security",
        };
        let status = std::process::Command::new("/usr/bin/open")
            .arg(url)
            .status()
            .map_err(|error| AppError::new("settings_open_failed", error.to_string()))?;
        if status.success() {
            Ok(())
        } else {
            Err(AppError::new(
                "settings_open_failed",
                format!("System Settings returned status {status}."),
            ))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
        Err(AppError::new(
            "settings_open_unsupported",
            "Privacy settings shortcuts are only supported on macOS.",
        ))
    }
}

#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    request: StartRecordingRequest,
) -> Result<RecordingSessionDto, AppError> {
    let paths = app_paths(&app)?;
    let repos = repositories(&app).await?;
    let source_mode = request.source_mode.unwrap_or_default();
    let readiness = recording_source_readiness(source_mode);
    if !readiness.ready {
        let message = readiness
            .sources
            .iter()
            .find(|source| source.required && !source.ready)
            .and_then(|source| source.message.clone())
            .unwrap_or_else(|| "The selected recording sources are not ready.".to_string());
        return Err(AppError::new("source_not_ready", message));
    }
    let started = start_capture(&paths, request.note_id.clone(), source_mode)?;
    repos
        .create_recording_session(
            &request.note_id,
            &started.session_id,
            source_mode,
            &started.partial_path.to_string_lossy(),
            &started.final_path.to_string_lossy(),
            started.device_label.clone(),
        )
        .await?;
    for source in &started.sources {
        repos
            .create_pending_source_artifact(
                &request.note_id,
                &started.session_id,
                source.source.as_db(),
                &source.partial_path.to_string_lossy(),
                &source.final_path.to_string_lossy(),
            )
            .await?;
    }
    Ok(RecordingSessionDto {
        id: started.session_id,
        note_id: request.note_id,
        source_mode,
        state: started.status.state,
        started_at: crate::db::repositories::timestamp(),
        elapsed_ms: started.status.elapsed_ms,
        device_label: started.device_label,
        level: started.status.level,
        sources: started.status.sources,
        warnings: Vec::new(),
    })
}

#[tauri::command]
pub async fn pause_recording(request: SessionRequest) -> Result<RecordingStatusDto, AppError> {
    pause_capture(&request.session_id)
}

#[tauri::command]
pub async fn resume_recording(request: SessionRequest) -> Result<RecordingStatusDto, AppError> {
    resume_capture(&request.session_id)
}

#[tauri::command]
pub async fn get_recording_status(request: SessionRequest) -> Result<RecordingStatusDto, AppError> {
    capture_status(&request.session_id)
}

#[tauri::command]
pub async fn finish_recording(
    app: AppHandle,
    request: SessionRequest,
) -> Result<FinishRecordingResponse, AppError> {
    let finalization_started = Instant::now();
    let finished = finish_capture(&request.session_id)?;
    let finalization_ms = finalization_started
        .elapsed()
        .as_millis()
        .min(i64::MAX as u128) as i64;
    let repos = repositories(&app).await?;
    repos
        .add_checkpoint(
            &finished.session_id,
            "recording_finalization",
            Some(
                serde_json::json!({
                    "durationMs": finalization_ms,
                    "sourceCount": finished.sources.len(),
                })
                .to_string(),
            ),
        )
        .await?;
    repos
        .add_checkpoint(&finished.session_id, "done", None)
        .await?;
    let source_artifacts = repos
        .source_artifacts_for_session(&finished.session_id)
        .await?;
    let mut source_validations = Vec::new();
    let mut valid_sources = Vec::new();
    let mut warnings = Vec::new();
    let mut primary_validation = None;
    let mut primary_checksum = String::new();
    let mut primary_file_size = 0;
    let validation_started = Instant::now();
    for source in &finished.sources {
        let validation = validate_audio_artifact(
            &source.final_path,
            source.elapsed_ms,
            validation_config_for_source(source.source),
        )
        .map_err(|error| AppError::new("audio_validation_failed", error.to_string()))?;
        let checksum = checksum_file(&source.final_path).unwrap_or_default();
        let file_size = std::fs::metadata(&source.final_path)
            .map(|metadata| metadata.len() as i64)
            .unwrap_or_default();
        if source.source == RecordingSource::Microphone {
            primary_validation = Some(validation.clone());
            primary_checksum = checksum.clone();
            primary_file_size = file_size;
        }
        let valid = source_audio_passes_validation(source.source, &validation);
        if let Some(artifact) = source_artifacts
            .iter()
            .find(|artifact| artifact.source == source.source.as_db())
        {
            repos
                .finalize_source_artifact(
                    &artifact.id,
                    if valid { "valid" } else { "invalid" },
                    validation.actual_duration_ms,
                    file_size,
                    &checksum,
                    source.elapsed_ms,
                    Some(serde_json::to_string(&validation).unwrap_or_default()),
                    if valid {
                        None
                    } else {
                        Some(validation.warnings.join("; "))
                    },
                )
                .await?;
            if valid {
                valid_sources.push((
                    artifact.id.clone(),
                    source.source.as_db().to_string(),
                    source.final_path.clone(),
                ));
            }
        }
        if !valid {
            warnings.push(crate::domain::types::SourceWarningDto {
                source: source.source,
                code: "source_validation_failed".to_string(),
                message: format!(
                    "{} source did not pass validation: {}",
                    source.source.as_db(),
                    validation.warnings.join("; ")
                ),
            });
        }
        source_validations.push(crate::domain::types::SourceValidationDto {
            source: source.source,
            file_exists: validation.file_exists,
            non_zero_size: validation.non_zero_size,
            readable_audio: validation.readable_audio,
            expected_duration_ms: validation.expected_duration_ms,
            actual_duration_ms: Some(validation.actual_duration_ms),
            duration_within_tolerance: validation.duration_within_tolerance,
            non_silent_signal: validation.non_silent_signal,
            peak_amplitude: Some(validation.peak_amplitude),
            rms_amplitude: Some(validation.rms_amplitude),
            warnings: validation.warnings.clone(),
            error: if valid {
                None
            } else {
                Some(validation.warnings.join("; "))
            },
        });
    }
    let validation =
        primary_validation.unwrap_or_else(|| crate::domain::types::AudioValidationDto {
            file_exists: false,
            non_zero_size: false,
            readable_audio: false,
            expected_duration_ms: finished.elapsed_ms,
            actual_duration_ms: 0,
            duration_within_tolerance: false,
            non_silent_signal: false,
            peak_amplitude: 0.0,
            rms_amplitude: 0.0,
            warnings: vec!["No microphone validation was available.".to_string()],
        });
    repos
        .update_recording_session(
            &finished.session_id,
            if validation.readable_audio && validation.non_zero_size {
                "valid"
            } else {
                "invalid"
            },
            finished.elapsed_ms,
            Some(primary_file_size),
            Some(validation.actual_duration_ms),
            Some(primary_checksum.clone()),
            Some(validation.peak_amplitude),
            Some(validation.rms_amplitude),
            Some(serde_json::to_string(&validation).unwrap_or_default()),
            if validation.duration_within_tolerance {
                None
            } else {
                Some(validation.warnings.join("; "))
            },
        )
        .await?;

    if valid_sources.is_empty() {
        repos
            .set_note_status(
                &finished.note_id,
                crate::domain::types::ProcessingStatus::Failed,
                Some(validation.warnings.join("; ")),
            )
            .await?;
        return Ok(FinishRecordingResponse {
            note: repos.get_note(&finished.note_id).await?,
            recording: finished.recording,
            validation,
            validations: source_validations,
            processing_started: false,
            warnings,
        });
    }

    repos
        .add_checkpoint(
            &finished.session_id,
            "audio_validation",
            Some(
                serde_json::json!({
                    "durationMs": validation_started.elapsed().as_millis().min(i64::MAX as u128) as i64,
                    "validSourceCount": valid_sources.len(),
                    "sourceCount": finished.sources.len(),
                })
                .to_string(),
            ),
        )
        .await?;

    // Capture is single-instance, but processing runs asynchronously — so the
    // user may have already recorded (and stopped) another message on this note
    // while a previous one is still in flight. Register this recording behind
    // any in-flight job for the note; the spawned task waits its turn and reads
    // the note's generated content *after* acquiring the lock, so incremental
    // generation always builds on whatever the previous job wrote.
    let (ticket, depth) = processing_queue::enqueue(&finished.note_id);
    if depth <= 1 {
        // First in line: reflect "processing" immediately for snappy feedback.
        repos
            .set_note_status(
                &finished.note_id,
                crate::domain::types::ProcessingStatus::Transcribing,
                None,
            )
            .await?;
    }

    let mut note = repos.get_note(&finished.note_id).await?;
    note.queued_recordings = processing_queue::queued_behind(&finished.note_id);

    let task_repos = repos.clone();
    let task_note_id = finished.note_id.clone();
    let task_session_id = finished.session_id.clone();
    let task_source_mode = finished.source_mode;
    tokio::spawn(async move {
        let queue_lock = ticket.lock();
        let _guard = queue_lock.lock().await;
        // Now that earlier jobs on this note are done, read the latest note so
        // generation has the freshest existing content as context.
        let note = match task_repos.get_note(&task_note_id).await {
            Ok(note) => note,
            Err(_) => {
                ticket.finish();
                return;
            }
        };
        let title = note.title.clone();
        let existing_generated_note = note.generated_content.clone();
        let manual_notes = manual_notes_for_generation(&note);
        let result = if valid_sources.len() == 1
            && task_source_mode == RecordingSourceMode::MicrophoneOnly
        {
            let (artifact_id, _source, path) = valid_sources
                .into_iter()
                .next()
                .expect("valid source was checked before starting processing");
            process_saved_audio(
                &task_repos,
                &task_note_id,
                &task_session_id,
                &artifact_id,
                path,
                title,
                existing_generated_note,
                manual_notes,
            )
            .await
        } else {
            process_saved_source_audio(
                &task_repos,
                &task_note_id,
                &task_session_id,
                task_source_mode,
                valid_sources,
                title,
                existing_generated_note,
                manual_notes,
            )
            .await
        };
        if let Err(error) = result {
            let _ = task_repos
                .set_note_status(
                    &task_note_id,
                    crate::domain::types::ProcessingStatus::Failed,
                    Some(error.message),
                )
                .await;
        }
        ticket.finish();
    });
    Ok(FinishRecordingResponse {
        note,
        recording: finished.recording,
        validation,
        validations: source_validations,
        processing_started: true,
        warnings,
    })
}

fn recording_source_readiness(source_mode: RecordingSourceMode) -> RecordingSourceReadinessDto {
    let (microphone_state, microphone_hint) = microphone_permission_state();
    let microphone_ready = microphone_state == "granted";
    let mut sources = vec![SourceReadinessDto {
        source: RecordingSource::Microphone,
        required: true,
        ready: microphone_ready,
        permission_state: microphone_state.clone(),
        device_available: microphone_ready,
        capture_available: microphone_ready,
        recovery_action: microphone_hint
            .as_ref()
            .map(|_| "openMicrophoneSettings".to_string()),
        message: microphone_hint,
    }];
    if source_mode == RecordingSourceMode::MicrophonePlusSystem {
        let mut system = crate::audio::system_macos::system_audio_readiness();
        if system.ready {
            if let Err(error) = crate::audio::system_macos::helper_permission_check() {
                system.ready = false;
                system.permission_state = "denied".to_string();
                system.capture_available = false;
                system.message = Some(error.message);
            }
        }
        sources.push(system);
    }
    let ready = sources
        .iter()
        .all(|source| !source.required || source.ready);
    RecordingSourceReadinessDto {
        source_mode,
        ready,
        checked_at: crate::db::repositories::timestamp(),
        sources,
    }
}

#[tauri::command]
pub async fn retry_processing(
    app: AppHandle,
    request: RetryProcessingRequest,
) -> Result<NoteDto, AppError> {
    let repos = repositories(&app).await?;
    retry_from_saved_audio(&repos, &request.note_id).await
}

#[tauri::command]
pub async fn recover_recording(
    app: AppHandle,
    request: crate::domain::types::RecoverRecordingRequest,
) -> Result<NoteDto, AppError> {
    let repos = repositories(&app).await?;
    let Some(info) = repos.recording_recovery_info(&request.session_id).await? else {
        return Err(AppError::new(
            "recording_not_found",
            format!(
                "Recoverable recording {} was not found.",
                request.session_id
            ),
        ));
    };
    if request.action == "discard" {
        for artifact in repos
            .source_artifact_paths_for_session(&request.session_id)
            .await?
        {
            for path in [&artifact.partial_path, &artifact.final_path]
                .into_iter()
                .flatten()
            {
                let _ = std::fs::remove_file(path);
            }
        }
        for path in [&info.partial_path, &info.final_path].into_iter().flatten() {
            let _ = std::fs::remove_file(path);
        }
        return Ok(repos
            .mark_recording_discarded(&info.session_id, &info.note_id)
            .await?);
    }
    let source_paths = repos
        .source_artifact_paths_for_session(&request.session_id)
        .await?;
    if !source_paths.is_empty() {
        let mut valid_sources = Vec::new();
        for artifact in source_paths {
            let Some(path) = recovery_source_path(&artifact) else {
                continue;
            };
            let validation = validate_audio_artifact(
                &path,
                artifact.expected_duration_ms.max(1),
                AudioValidationConfig::default(),
            )
            .map_err(|error| AppError::new("audio_validation_failed", error.to_string()))?;
            let checksum = checksum_file(&path).unwrap_or_default();
            let file_size = std::fs::metadata(&path)
                .map(|metadata| metadata.len() as i64)
                .unwrap_or_default();
            let source = RecordingSource::from(artifact.source.as_str());
            let valid = source_audio_passes_validation(source, &validation);
            repos
                .finalize_source_artifact(
                    &artifact.id,
                    if valid { "valid" } else { "invalid" },
                    validation.actual_duration_ms,
                    file_size,
                    &checksum,
                    artifact.expected_duration_ms,
                    Some(serde_json::to_string(&validation).unwrap_or_default()),
                    if valid {
                        None
                    } else {
                        Some(validation.warnings.join("; "))
                    },
                )
                .await?;
            if valid {
                valid_sources.push((artifact.id, artifact.source, path));
            }
        }
        if valid_sources.is_empty() {
            repos
                .set_note_status(
                    &info.note_id,
                    crate::domain::types::ProcessingStatus::Failed,
                    Some("No recoverable source audio passed validation.".to_string()),
                )
                .await?;
            return Ok(repos.get_note(&info.note_id).await?);
        }
        let note = repos.get_note(&info.note_id).await?;
        let existing_generated_note = note.generated_content.clone();
        let manual_notes = manual_notes_for_generation(&note);
        return process_saved_source_audio(
            &repos,
            &info.note_id,
            &info.session_id,
            info.source_mode,
            valid_sources,
            note.title,
            existing_generated_note,
            manual_notes,
        )
        .await;
    }
    let path = recovery_audio_path(&info).ok_or_else(|| {
        AppError::new(
            "audio_artifact_missing",
            "No recoverable audio bytes are available.",
        )
    })?;
    let validation = validate_audio_artifact(
        &path,
        info.expected_elapsed_ms.max(1),
        AudioValidationConfig::default(),
    )
    .map_err(|error| AppError::new("audio_validation_failed", error.to_string()))?;
    let checksum = checksum_file(&path).unwrap_or_default();
    let file_size = std::fs::metadata(&path)
        .map(|metadata| metadata.len() as i64)
        .unwrap_or_default();
    repos
        .update_recording_session(
            &info.session_id,
            if validation.readable_audio && validation.non_zero_size {
                "valid"
            } else {
                "invalid"
            },
            info.expected_elapsed_ms,
            Some(file_size),
            Some(validation.actual_duration_ms),
            Some(checksum.clone()),
            Some(validation.peak_amplitude),
            Some(validation.rms_amplitude),
            Some(serde_json::to_string(&validation).unwrap_or_default()),
            if validation.duration_within_tolerance {
                None
            } else {
                Some(validation.warnings.join("; "))
            },
        )
        .await?;
    if !(validation.non_zero_size
        && validation.readable_audio
        && validation.duration_within_tolerance)
    {
        repos
            .set_note_status(
                &info.note_id,
                crate::domain::types::ProcessingStatus::Failed,
                Some(validation.warnings.join("; ")),
            )
            .await?;
        return Ok(repos.get_note(&info.note_id).await?);
    }
    let artifact = repos
        .create_audio_artifact(
            &info.note_id,
            &info.session_id,
            &path.to_string_lossy(),
            validation.actual_duration_ms,
            file_size,
            &checksum,
        )
        .await?;
    let note = repos.get_note(&info.note_id).await?;
    let existing_generated_note = note.generated_content.clone();
    let manual_notes = manual_notes_for_generation(&note);
    process_saved_audio(
        &repos,
        &info.note_id,
        &info.session_id,
        &artifact.id,
        path,
        note.title,
        existing_generated_note,
        manual_notes,
    )
    .await
}

fn recovery_audio_path(info: &crate::db::repositories::RecordingRecoveryInfo) -> Option<PathBuf> {
    for path in [&info.final_path, &info.partial_path].into_iter().flatten() {
        if std::fs::metadata(path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
        {
            return Some(PathBuf::from(path));
        }
    }
    None
}

fn recovery_source_path(info: &crate::db::repositories::SourceArtifactPath) -> Option<PathBuf> {
    for path in [&info.final_path, &info.partial_path].into_iter().flatten() {
        if std::fs::metadata(path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
        {
            return Some(PathBuf::from(path));
        }
    }
    None
}

pub(crate) async fn repositories(app: &AppHandle) -> Result<Repositories, AppError> {
    let paths = app_paths(app)?;
    let options =
        SqliteConnectOptions::from_str(&format!("sqlite://{}", paths.database_path.display()))
            .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?
            .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?;
    run_migrations(&pool)
        .await
        .map_err(|error| AppError::new("migration_failed", error.to_string()))?;
    Ok(Repositories::new(pool))
}

fn app_paths(app: &AppHandle) -> Result<AppPaths, AppError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?;
    AppPaths::from_data_dir(data_dir)
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))
}
