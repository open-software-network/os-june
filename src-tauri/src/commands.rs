use crate::{
    app_paths::AppPaths,
    audio::{
        capture::{
            capture_status, finish_capture, microphone_permission_state, pause_capture,
            resume_capture, start_capture,
        },
        recovery::scan_recoverable_recordings,
        validation::{checksum_file, validate_audio_artifact, AudioValidationConfig},
    },
    db::{migrations::run_migrations, repositories::Repositories},
    domain::{
        processing::{process_saved_audio, retry_from_saved_audio},
        types::{
            AppError, AssignNoteToFolderRequest, BootstrapResponse, CreateFolderRequest,
            CreateNoteRequest, FinishRecordingResponse, GetNoteRequest, ListNotesRequest,
            ListNotesResponse, MicrophonePermissionResponse, NoteDto, RecordingSessionDto,
            RecordingStatusDto, RemoveNoteFromFolderRequest, RetryProcessingRequest,
            SessionRequest, StartRecordingRequest, UpdateNoteRequest,
        },
    },
};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::path::PathBuf;
use std::str::FromStr;
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
        provider_configured: crate::providers::openai_provider_configured(),
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
    Ok(repositories(&app).await?.get_note(&request.note_id).await?)
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
    Ok(repositories(&app).await?.create_folder(name).await?)
}

#[tauri::command]
pub async fn list_folders(
    app: AppHandle,
) -> Result<Vec<crate::domain::types::FolderDto>, AppError> {
    Ok(repositories(&app).await?.list_folders().await?)
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
pub async fn get_microphone_permission_state() -> Result<MicrophonePermissionResponse, AppError> {
    let (state, recovery_hint) = microphone_permission_state();
    Ok(MicrophonePermissionResponse {
        state,
        recovery_hint,
    })
}

#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    request: StartRecordingRequest,
) -> Result<RecordingSessionDto, AppError> {
    let paths = app_paths(&app)?;
    let repos = repositories(&app).await?;
    let started = start_capture(&paths, request.note_id.clone())?;
    repos
        .create_recording_session(
            &request.note_id,
            &started.session_id,
            &started.partial_path.to_string_lossy(),
            &started.final_path.to_string_lossy(),
            started.device_label.clone(),
        )
        .await?;
    Ok(RecordingSessionDto {
        id: started.session_id,
        note_id: request.note_id,
        state: started.status.state,
        started_at: crate::db::repositories::timestamp(),
        elapsed_ms: started.status.elapsed_ms,
        device_label: started.device_label,
        level: started.status.level,
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
    let finished = finish_capture(&request.session_id)?;
    let repos = repositories(&app).await?;
    repos
        .add_checkpoint(&finished.session_id, "done", None)
        .await?;
    let validation = validate_audio_artifact(
        &finished.final_path,
        finished.elapsed_ms,
        AudioValidationConfig::default(),
    )
    .map_err(|error| AppError::new("audio_validation_failed", error.to_string()))?;
    let checksum = checksum_file(&finished.final_path).unwrap_or_default();
    let file_size = std::fs::metadata(&finished.final_path)
        .map(|metadata| metadata.len() as i64)
        .unwrap_or_default();
    repos
        .update_recording_session(
            &finished.session_id,
            if validation.readable_audio && validation.non_zero_size {
                "valid"
            } else {
                "invalid"
            },
            finished.elapsed_ms,
            Some(file_size),
            Some(validation.actual_duration_ms),
            Some(checksum.clone()),
            Some(validation.peak_amplitude),
            Some(validation.rms_amplitude),
            Some(serde_json::to_string(&validation).unwrap_or_default()),
            if validation.non_silent_signal && validation.duration_within_tolerance {
                None
            } else {
                Some(validation.warnings.join("; "))
            },
        )
        .await?;

    if !(validation.non_zero_size
        && validation.readable_audio
        && validation.duration_within_tolerance
        && validation.non_silent_signal)
    {
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
            processing_started: false,
        });
    }

    let artifact = repos
        .create_audio_artifact(
            &finished.note_id,
            &finished.session_id,
            &finished.final_path.to_string_lossy(),
            validation.actual_duration_ms,
            file_size,
            &checksum,
        )
        .await?;
    repos
        .add_checkpoint(&finished.session_id, "validation", None)
        .await?;
    let title = repos.get_note(&finished.note_id).await?.title;
    let note = process_saved_audio(
        &repos,
        &finished.note_id,
        &artifact.id,
        finished.final_path,
        title,
    )
    .await?;
    Ok(FinishRecordingResponse {
        note,
        recording: finished.recording,
        validation,
        processing_started: true,
    })
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
        for path in [&info.partial_path, &info.final_path].into_iter().flatten() {
            let _ = std::fs::remove_file(path);
        }
        return Ok(repos
            .mark_recording_discarded(&info.session_id, &info.note_id)
            .await?);
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
            if validation.non_silent_signal && validation.duration_within_tolerance {
                None
            } else {
                Some(validation.warnings.join("; "))
            },
        )
        .await?;
    if !(validation.non_zero_size
        && validation.readable_audio
        && validation.duration_within_tolerance
        && validation.non_silent_signal)
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
    let title = repos.get_note(&info.note_id).await?.title;
    process_saved_audio(&repos, &info.note_id, &artifact.id, path, title).await
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

async fn repositories(app: &AppHandle) -> Result<Repositories, AppError> {
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
