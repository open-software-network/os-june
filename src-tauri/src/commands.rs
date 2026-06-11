use crate::{
    app_paths::AppPaths,
    audio::{
        capture::{
            capture_status, finish_active_capture, finish_capture, is_capture_active,
            microphone_permission_state, pause_capture, resume_capture, start_capture,
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
            AgentMessageRole, AgentTaskDto, AgentTaskListResponse, AgentTaskRequest,
            AgentTaskStatus, AgentToolEventDto, AgentToolEventStatus, AppError,
            AssignNoteToFolderRequest, AssignSessionToFolderRequest, BootstrapResponse,
            CheckRecordingSourceReadinessRequest, CreateAgentTaskRequest,
            CreateDictionaryEntryRequest, CreateFolderRequest, CreateNoteRequest,
            DeleteDictionaryEntryRequest, DeleteFolderRequest, DeleteNoteRequest,
            DictionaryEntryDto, ExplainAgentApprovalRequest, ExplainAgentApprovalResponse,
            FinishRecordingResponse, GetAgentTaskRequest, GetNoteRequest, ListNotesRequest,
            ListNotesResponse, MicrophonePermissionResponse, NoteDto, OpenPrivacySettingsRequest,
            RecordingSessionDto, RecordingSource, RecordingSourceMode, RecordingSourceReadinessDto,
            RecordingStatusDto, RemoveNoteFromFolderRequest, RemoveSessionFromFolderRequest,
            RenameFolderRequest, RetryProcessingRequest, SaveAgentAssistantMessageRequest,
            SaveAgentHermesSessionRequest, SendAgentMessageRequest, SessionFolderDto,
            SessionRequest, SourceReadinessDto, StartRecordingRequest,
            SuggestAgentSessionTitleRequest, SuggestAgentSessionTitleResponse,
            UpdateDictionaryEntryRequest, UpdateNoteRequest,
        },
    },
};
use chrono::{TimeZone, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::collections::HashSet;
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};
use std::{
    path::{Path, PathBuf},
    time::Instant,
};
use tauri::{AppHandle, Manager};
use tokio::sync::OnceCell;

#[tauri::command]
pub async fn bootstrap_app(app: AppHandle) -> Result<BootstrapResponse, AppError> {
    let repos = repositories(&app).await?;
    // Complete stale tasks that already received their assistant reply
    // before pausing the rest: the repair only considers queued/running
    // tasks, so it must run before they are flipped to paused.
    repos.complete_agent_tasks_with_assistant_messages().await?;
    repos.pause_running_agent_tasks_on_launch().await?;
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
    let paths = app_paths(&app)?;
    let repos = repositories(&app).await?;
    let audio_paths = repos
        .audio_artifact_paths_for_note(&request.note_id)
        .await?;
    repos.delete_note(&request.note_id).await?;
    for path in audio_paths {
        if path.trim().is_empty() {
            continue;
        }
        if let Err(error) = paths.remove_recording_file(&path) {
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
pub async fn list_session_folders(app: AppHandle) -> Result<Vec<SessionFolderDto>, AppError> {
    Ok(repositories(&app).await?.list_session_folders().await?)
}

#[tauri::command]
pub async fn assign_session_to_folder(
    app: AppHandle,
    request: AssignSessionToFolderRequest,
) -> Result<(), AppError> {
    Ok(repositories(&app)
        .await?
        .assign_session_to_folder(&request.session_id, &request.folder_id)
        .await?)
}

#[tauri::command]
pub async fn remove_session_from_folder(
    app: AppHandle,
    request: RemoveSessionFromFolderRequest,
) -> Result<(), AppError> {
    Ok(repositories(&app)
        .await?
        .remove_session_from_folder(&request.session_id, &request.folder_id)
        .await?)
}

#[tauri::command]
pub async fn list_dictionary_entries(app: AppHandle) -> Result<Vec<DictionaryEntryDto>, AppError> {
    Ok(repositories(&app).await?.list_dictionary_entries().await?)
}

#[tauri::command]
pub async fn list_agent_tasks(app: AppHandle) -> Result<AgentTaskListResponse, AppError> {
    let repos = repositories(&app).await?;
    repos.complete_agent_tasks_with_assistant_messages().await?;
    let response = repos.list_agent_tasks().await?;
    for task in &response.items {
        if let Err(error) = hydrate_agent_task_from_hermes(&app, &repos, &task.id).await {
            eprintln!(
                "failed to hydrate agent task {} from Hermes state: {}",
                task.id, error.message
            );
        }
    }
    Ok(repos.list_agent_tasks().await?)
}

#[tauri::command]
pub async fn create_agent_task(
    app: AppHandle,
    request: CreateAgentTaskRequest,
) -> Result<AgentTaskDto, AppError> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err(AppError::new(
            "agent_prompt_required",
            "Describe what the agent should do.",
        ));
    }
    let repos = repositories(&app).await?;
    let task = repos
        .create_agent_task(
            prompt,
            request.title.as_deref(),
            request.safety_profile.unwrap_or_default(),
        )
        .await?;
    if request.run_placeholder.unwrap_or(true) {
        schedule_agent_runtime_placeholder(repos, task.id.clone());
    }
    Ok(task)
}

#[tauri::command]
pub async fn get_agent_task(
    app: AppHandle,
    request: GetAgentTaskRequest,
) -> Result<AgentTaskDto, AppError> {
    let repos = repositories(&app).await?;
    if let Err(error) = hydrate_agent_task_from_hermes(&app, &repos, &request.task_id).await {
        eprintln!(
            "failed to hydrate agent task {} from Hermes state: {}",
            request.task_id, error.message
        );
    }
    Ok(repos.get_agent_task(&request.task_id).await?)
}

#[tauri::command]
pub async fn send_agent_message(
    app: AppHandle,
    request: SendAgentMessageRequest,
) -> Result<AgentTaskDto, AppError> {
    let content = request.content.trim();
    if content.is_empty() {
        return Err(AppError::new(
            "agent_message_required",
            "Message content is required.",
        ));
    }
    let repos = repositories(&app).await?;
    repos
        .add_agent_message(&request.task_id, AgentMessageRole::User, content)
        .await?;
    repos
        .update_agent_task_status(
            &request.task_id,
            AgentTaskStatus::Queued,
            Some("Queued for the agent runtime."),
            None,
        )
        .await?;
    if request.run_placeholder.unwrap_or(true) {
        schedule_agent_runtime_placeholder(repos.clone(), request.task_id.clone());
    }
    Ok(repos.get_agent_task(&request.task_id).await?)
}

#[tauri::command]
pub async fn save_agent_assistant_message(
    app: AppHandle,
    request: SaveAgentAssistantMessageRequest,
) -> Result<AgentTaskDto, AppError> {
    let content = request.content.trim();
    if content.is_empty() {
        return Err(AppError::new(
            "agent_message_required",
            "Message content is required.",
        ));
    }
    let repos = repositories(&app).await?;
    repos
        .add_agent_message(&request.task_id, AgentMessageRole::Assistant, content)
        .await?;
    repos
        .update_agent_task_status(
            &request.task_id,
            AgentTaskStatus::Completed,
            Some("Completed."),
            None,
        )
        .await?;
    Ok(repos.get_agent_task(&request.task_id).await?)
}

#[tauri::command]
pub async fn save_agent_hermes_session(
    app: AppHandle,
    request: SaveAgentHermesSessionRequest,
) -> Result<AgentTaskDto, AppError> {
    let hermes_session_id = request.hermes_session_id.trim();
    if hermes_session_id.is_empty() {
        return Err(AppError::new(
            "agent_hermes_session_required",
            "Hermes session id is required.",
        ));
    }
    let repos = repositories(&app).await?;
    repos
        .set_agent_task_hermes_session(&request.task_id, hermes_session_id)
        .await?;
    Ok(repos.get_agent_task(&request.task_id).await?)
}

#[tauri::command]
pub async fn suggest_agent_session_title(
    request: SuggestAgentSessionTitleRequest,
) -> Result<SuggestAgentSessionTitleResponse, AppError> {
    let title = crate::scribe_api::suggest_agent_session_title(&request.prompt).await?;
    Ok(SuggestAgentSessionTitleResponse { title })
}

#[tauri::command]
pub async fn explain_agent_approval(
    request: ExplainAgentApprovalRequest,
) -> Result<ExplainAgentApprovalResponse, AppError> {
    let explanation =
        crate::scribe_api::explain_agent_approval(&request.description, request.command.as_deref())
            .await?;
    Ok(ExplainAgentApprovalResponse { explanation })
}

#[tauri::command]
pub async fn cancel_agent_task(
    app: AppHandle,
    request: AgentTaskRequest,
) -> Result<AgentTaskDto, AppError> {
    repositories(&app)
        .await?
        .update_agent_task_status(
            &request.task_id,
            AgentTaskStatus::Cancelled,
            Some("Cancelled by the user."),
            None,
        )
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn retry_agent_task(
    app: AppHandle,
    request: AgentTaskRequest,
) -> Result<AgentTaskDto, AppError> {
    let repos = repositories(&app).await?;
    repos
        .update_agent_task_status(
            &request.task_id,
            AgentTaskStatus::Queued,
            Some("Queued for the agent runtime."),
            None,
        )
        .await?;
    schedule_agent_runtime_placeholder(repos.clone(), request.task_id.clone());
    Ok(repos.get_agent_task(&request.task_id).await?)
}

#[tauri::command]
pub async fn list_agent_tool_events(
    app: AppHandle,
    request: AgentTaskRequest,
) -> Result<Vec<AgentToolEventDto>, AppError> {
    Ok(repositories(&app)
        .await?
        .agent_tool_events(&request.task_id)
        .await?)
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
    // The system-audio permission probe can block for over a minute while the
    // helper waits on a CoreAudio permission grant; keep that work off the
    // async runtime so other commands stay responsive.
    tokio::task::spawn_blocking(move || recording_source_readiness(request.source_mode))
        .await
        .map_err(|error| AppError::new("readiness_check_failed", error.to_string()))
}

#[tauri::command]
pub fn scribe_verify_url() -> String {
    crate::scribe_api::verify_url()
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
    let note = repos.get_note(&request.note_id).await?;
    let source_mode = request.source_mode.unwrap_or_default();
    // Readiness probing and capture startup both wait on the system-audio
    // helper (up to tens of seconds); run them off the async runtime.
    let readiness = tokio::task::spawn_blocking(move || recording_source_readiness(source_mode))
        .await
        .map_err(|error| AppError::new("readiness_check_failed", error.to_string()))?;
    if !readiness.ready {
        let message = readiness
            .sources
            .iter()
            .find(|source| source.required && !source.ready)
            .and_then(|source| source.message.clone())
            .unwrap_or_else(|| "The selected recording sources are not ready.".to_string());
        return Err(AppError::new("source_not_ready", message));
    }
    finish_active_capture_before_start(&repos).await?;
    let capture_paths = paths.clone();
    let capture_note_id = note.id.clone();
    let started = tokio::task::spawn_blocking(move || {
        start_capture(&capture_paths, capture_note_id, source_mode)
    })
    .await
    .map_err(|error| AppError::new("recording_start_failed", error.to_string()))??;
    repos
        .create_recording_session(
            &note.id,
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
                &note.id,
                &started.session_id,
                source.source.as_db(),
                &source.partial_path.to_string_lossy(),
                &source.final_path.to_string_lossy(),
            )
            .await?;
    }
    Ok(RecordingSessionDto {
        id: started.session_id,
        note_id: note.id,
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
    let repos = repositories(&app).await?;
    let finalization_started = Instant::now();
    let finished = finish_capture(&request.session_id)?;
    finish_recording_session(&repos, finished, finalization_started).await
}

async fn finish_active_capture_before_start(repos: &Repositories) -> Result<(), AppError> {
    let finalization_started = Instant::now();
    if let Some(finished) = finish_active_capture()? {
        finish_recording_session(repos, finished, finalization_started).await?;
    }
    Ok(())
}

async fn finish_recording_session(
    repos: &Repositories,
    finished: crate::audio::capture::FinishedRecording,
    finalization_started: Instant,
) -> Result<FinishRecordingResponse, AppError> {
    let finalization_ms = finalization_started
        .elapsed()
        .as_millis()
        .min(i64::MAX as u128) as i64;
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

    let task_repos = (*repos).clone();
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
        if should_probe_system_audio_permission(system.ready, is_capture_active()) {
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

fn should_probe_system_audio_permission(system_ready: bool, capture_active: bool) -> bool {
    system_ready && !capture_active
}

#[tauri::command]
pub async fn retry_processing(
    app: AppHandle,
    request: RetryProcessingRequest,
) -> Result<NoteDto, AppError> {
    let paths = app_paths(&app)?;
    let repos = repositories(&app).await?;
    retry_from_saved_audio(&repos, &paths, &request.note_id).await
}

#[tauri::command]
pub async fn recover_recording(
    app: AppHandle,
    request: crate::domain::types::RecoverRecordingRequest,
) -> Result<NoteDto, AppError> {
    let paths = app_paths(&app)?;
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
                let _ = paths
                    .remove_recording_file(path)
                    .map_err(|error| AppError::new("audio_delete_failed", error.to_string()));
            }
        }
        for path in [&info.partial_path, &info.final_path].into_iter().flatten() {
            let _ = paths
                .remove_recording_file(path)
                .map_err(|error| AppError::new("audio_delete_failed", error.to_string()));
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
            let Some(path) = recovery_source_path(&paths, &artifact) else {
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
    let path = recovery_audio_path(&paths, &info).ok_or_else(|| {
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

fn recovery_audio_path(
    paths: &AppPaths,
    info: &crate::db::repositories::RecordingRecoveryInfo,
) -> Option<PathBuf> {
    for path in [&info.final_path, &info.partial_path].into_iter().flatten() {
        let Ok(path) = paths.contained_recording_file(path) else {
            continue;
        };
        if std::fs::metadata(&path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
        {
            return Some(path);
        }
    }
    None
}

fn recovery_source_path(
    paths: &AppPaths,
    info: &crate::db::repositories::SourceArtifactPath,
) -> Option<PathBuf> {
    for path in [&info.final_path, &info.partial_path].into_iter().flatten() {
        let Ok(path) = paths.contained_recording_file(path) else {
            continue;
        };
        if std::fs::metadata(&path)
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
        {
            return Some(path);
        }
    }
    None
}

static AGENT_PLACEHOLDER_TASKS_IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn agent_placeholder_tasks_in_flight() -> &'static Mutex<HashSet<String>> {
    AGENT_PLACEHOLDER_TASKS_IN_FLIGHT.get_or_init(Mutex::default)
}

fn schedule_agent_runtime_placeholder(repos: Repositories, task_id: String) {
    // Two concurrent placeholder runs for the same task (e.g. a rapid
    // double retry) would double-insert tool events and messages, so only
    // one in-flight run per task is allowed.
    {
        let mut in_flight = agent_placeholder_tasks_in_flight()
            .lock()
            .expect("agent placeholder in-flight set is poisoned");
        if !in_flight.insert(task_id.clone()) {
            return;
        }
    }
    tokio::spawn(async move {
        run_agent_runtime_placeholder(&repos, &task_id).await;
        agent_placeholder_tasks_in_flight()
            .lock()
            .expect("agent placeholder in-flight set is poisoned")
            .remove(&task_id);
    });
}

async fn run_agent_runtime_placeholder(repos: &Repositories, task_id: &str) {
    // Only move a still-queued task to running. If the user cancelled the
    // task (or it otherwise changed state) since this run was scheduled,
    // the placeholder must not resurrect it.
    let started = repos
        .update_agent_task_status_if_in(
            task_id,
            AgentTaskStatus::Running,
            Some("Preparing local privacy and tool policy."),
            None,
            &[AgentTaskStatus::Queued],
        )
        .await;
    if !matches!(started, Ok(true)) {
        return;
    }
    let _ = repos
        .add_agent_tool_event(
            task_id,
            "local_tool_policy",
            AgentToolEventStatus::Completed,
            "Autonomous private mode is active. Sensitive actions will be blocked or escalated.",
            Some(r#"{"profile":"autonomous_private"}"#),
            Some(r#"{"localToolsReady":true,"rawOutputShared":false}"#),
            true,
        )
        .await;
    let _ = repos
        .add_agent_tool_event(
            task_id,
            "backend_agent_runtime",
            AgentToolEventStatus::Blocked,
            "Backend agent orchestration is not configured in this build.",
            Some(r#"{"endpoint":"/v1/agent/tasks"}"#),
            Some(r#"{"reason":"agent_backend_unavailable"}"#),
            true,
        )
        .await;
    let _ = repos
        .add_agent_message(
            task_id,
            AgentMessageRole::Assistant,
            "I created the task and set up the local privacy/tool policy. The backend agent runtime endpoint is not configured yet, so I paused execution before taking desktop actions.",
        )
        .await;
    let _ = repos
        .update_agent_task_status_if_in(
            task_id,
            AgentTaskStatus::Paused,
            Some("Paused until the backend agent runtime is configured."),
            Some("Backend agent orchestration is not configured in this build."),
            &[AgentTaskStatus::Running],
        )
        .await;
}

async fn hydrate_agent_task_from_hermes(
    app: &AppHandle,
    repos: &Repositories,
    task_id: &str,
) -> Result<(), AppError> {
    let task = repos.get_agent_task(task_id).await?;
    let paths = app_paths(app)?;
    let hermes_db_path = paths.data_dir.join("hermes").join("state.db");
    if !hermes_db_path.exists() {
        return Ok(());
    }
    let pool = hermes_state_pool(&hermes_db_path).await?;

    let session_id = match task.hermes_session_id.clone() {
        Some(session_id) if !session_id.trim().is_empty() => Some(session_id),
        _ => match_hermes_session_for_task(repos, &pool, &task).await?,
    };

    let Some(session_id) = session_id else {
        return Ok(());
    };

    let rows = sqlx::query(
        "SELECT CAST(id AS TEXT) AS id, content, timestamp
         FROM messages
         WHERE session_id = ?
           AND role = 'assistant'
           AND active = 1
           AND content IS NOT NULL
           AND trim(content) != ''
         ORDER BY timestamp ASC, id ASC",
    )
    .bind(&session_id)
    .fetch_all(&pool)
    .await
    .map_err(|error| AppError::new("hermes_state_unavailable", error.to_string()))?;

    // A task only counts as answered when the assistant replied AFTER the
    // latest user message. Assistant messages from earlier turns must not
    // complete a task that was re-queued by a newer user message.
    let latest_user_message_at = task
        .messages
        .iter()
        .filter(|message| message.role == AgentMessageRole::User)
        .map(|message| message.created_at.clone())
        .max();
    let mut assistant_replied_to_latest_turn = false;

    for row in rows {
        let hermes_message_id: String = row.get("id");
        let content: String = row.get("content");
        let timestamp: f64 = row.get("timestamp");
        let created_at = unix_timestamp_to_rfc3339(timestamp);
        // Both timestamps are RFC3339 UTC with millisecond precision, so
        // string ordering matches chronological ordering.
        if latest_user_message_at
            .as_deref()
            .map(|user_at| created_at.as_str() > user_at)
            .unwrap_or(true)
        {
            assistant_replied_to_latest_turn = true;
        }
        let external_id = format!("hermes:{session_id}:{hermes_message_id}");
        repos
            .add_agent_message_if_absent(
                task_id,
                AgentMessageRole::Assistant,
                content.trim(),
                &created_at,
                &external_id,
            )
            .await?;
    }
    if assistant_replied_to_latest_turn
        && matches!(
            task.status,
            AgentTaskStatus::Queued | AgentTaskStatus::Running
        )
    {
        repos
            .update_agent_task_status_if_in(
                task_id,
                AgentTaskStatus::Completed,
                Some("Completed."),
                None,
                &[AgentTaskStatus::Queued, AgentTaskStatus::Running],
            )
            .await?;
    }
    Ok(())
}

/// How close (in seconds) a Hermes session's `started_at` must be to the
/// task's creation time for heuristic title matching to bind them.
const HERMES_SESSION_MATCH_WINDOW_SECONDS: f64 = 300.0;

/// Heuristically binds a Hermes session to a task by title. Titles are
/// derived from the first 64 characters of the prompt, so identical prompts
/// collide; only bind when exactly one session with this title started near
/// the task's creation time and it is not already bound to another task.
/// When the match is ambiguous, skip hydration for this poll instead of
/// persisting a guess.
async fn match_hermes_session_for_task(
    repos: &Repositories,
    pool: &SqlitePool,
    task: &AgentTaskDto,
) -> Result<Option<String>, AppError> {
    let Ok(task_started_at) = chrono::DateTime::parse_from_rfc3339(&task.created_at)
        .map(|value| value.timestamp_millis() as f64 / 1000.0)
    else {
        return Ok(None);
    };
    let rows = sqlx::query(
        "SELECT id
         FROM sessions
         WHERE title = ?
           AND ABS(started_at - ?) <= ?
         LIMIT 2",
    )
    .bind(&task.title)
    .bind(task_started_at)
    .bind(HERMES_SESSION_MATCH_WINDOW_SECONDS)
    .fetch_all(pool)
    .await
    .map_err(|error| AppError::new("hermes_state_unavailable", error.to_string()))?;
    if rows.len() != 1 {
        return Ok(None);
    }
    let session_id: String = rows[0].get("id");
    if repos
        .hermes_session_bound_to_other_task(&task.id, &session_id)
        .await?
    {
        return Ok(None);
    }
    repos
        .set_agent_task_hermes_session(&task.id, &session_id)
        .await?;
    Ok(Some(session_id))
}

/// Cached read pool for the Hermes `state.db`, re-opened only if the path
/// changes, so per-task polling does not open a fresh pool every second.
static HERMES_STATE_POOL: tokio::sync::Mutex<Option<(PathBuf, SqlitePool)>> =
    tokio::sync::Mutex::const_new(None);

async fn hermes_state_pool(path: &Path) -> Result<SqlitePool, AppError> {
    let mut cached = HERMES_STATE_POOL.lock().await;
    if let Some((cached_path, pool)) = cached.as_ref() {
        if cached_path == path && !pool.is_closed() {
            return Ok(pool.clone());
        }
    }
    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))
        .map_err(|error| AppError::new("hermes_state_unavailable", error.to_string()))?
        .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| AppError::new("hermes_state_unavailable", error.to_string()))?;
    *cached = Some((path.to_path_buf(), pool.clone()));
    Ok(pool)
}

fn unix_timestamp_to_rfc3339(timestamp: f64) -> String {
    let seconds = timestamp.trunc() as i64;
    let nanos = ((timestamp.fract() * 1_000_000_000.0).round() as u32).min(999_999_999);
    Utc.timestamp_opt(seconds, nanos)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Cached app repositories pool. The database path is derived from the app
/// data dir and never changes within a process, so the pool (and its
/// migrations) are initialized once instead of on every Tauri command.
static REPOSITORIES: OnceCell<Repositories> = OnceCell::const_new();

pub(crate) async fn repositories(app: &AppHandle) -> Result<Repositories, AppError> {
    let paths = app_paths(app)?;
    REPOSITORIES
        .get_or_try_init(|| async {
            let options = SqliteConnectOptions::from_str(&format!(
                "sqlite://{}",
                paths.database_path.display()
            ))
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
        })
        .await
        .cloned()
}

fn app_paths(app: &AppHandle) -> Result<AppPaths, AppError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?;
    AppPaths::from_data_dir(data_dir)
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::should_probe_system_audio_permission;

    #[test]
    fn skips_system_audio_permission_probe_while_capture_is_active() {
        assert!(!should_probe_system_audio_permission(true, true));
    }

    #[test]
    fn probes_system_audio_permission_only_when_available_and_idle() {
        assert!(should_probe_system_audio_permission(true, false));
        assert!(!should_probe_system_audio_permission(false, false));
    }
}
