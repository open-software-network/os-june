use crate::{
    app_paths::AppPaths,
    audio::{
        capture::{
            capture_recovery_checkpoint, capture_start_timeout_error, capture_status,
            current_status, finish_active_capture, finish_capture, is_capture_active,
            microphone_device_available, microphone_device_hint, microphone_permission_state,
            pause_capture, resume_capture, start_capture_with_cancel, CaptureRecoverySnapshot,
            CaptureStartHandshake, CaptureStartState, StartedRecording, CAPTURE_START_TIMEOUT,
            RECOVERY_SNAPSHOT_INTERVAL,
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
            add_latency_checkpoint, manual_notes_for_generation,
            process_saved_source_audio_with_progress, NoteProcessingProgressReporter,
            ProcessingTiming, NOTE_PROCESSING_PROGRESS_EVENT,
        },
        processing_queue,
        types::{
            AppError, AssignNoteToFolderRequest, AssignSessionToFolderRequest,
            AssignSessionToProfileRequest, BootstrapResponse, CheckRecordingSourceReadinessRequest,
            ClaudeProjectCandidateDto, CompletedSessionDto, CreateDictionaryEntryRequest,
            CreateFolderRequest, CreateNoteRequest, DeleteDictionaryEntryRequest,
            DeleteFolderRequest, DeleteNoteRequest, DeleteNotesRequest, DictionaryEntryDto,
            DownloadNoteAudioRequest, DownloadNoteAudioResponse, ExplainAgentApprovalRequest,
            ExplainAgentApprovalResponse, FinishRecordingResponse, GetNoteRequest,
            ImportClaudeProjectsRequest, ListNotesRequest, ListNotesResponse, MemoryDto,
            MemorySettingsDto, MicrophonePermissionResponse, NoteDto, OpenPrivacySettingsRequest,
            ProcessingStatus, ProfileDataSummaryDto, RecordingSessionDto, RecordingSource,
            RecordingSourceMode, RecordingSourceReadinessDto, RecordingStatusDto,
            RemoveNoteFromFolderRequest, RemoveSessionFromFolderRequest, RenameFolderRequest,
            RetryProcessingRequest, SessionFolderDto, SessionProfileDto, SessionRequest,
            SetSessionCompletedRequest, ShareAddInvitesRequest, ShareCreateRequest,
            ShareCreatedDto, ShareDeleteRequest, ShareDto, ShareGetRequest, ShareInviteKeyDto,
            ShareInviteKeySaveRequest, ShareInviteKeysGetRequest, ShareInvitesAddedDto,
            ShareKeyDto, ShareKeyGetRequest, ShareKeySaveRequest, ShareRevokeInviteRequest,
            ShareSummaryDto, SourceReadinessDto, StartMeetingRecordingRequest,
            StartRecordingRequest, SubmitIssueReportRequest, SubmitIssueReportResponse,
            SuggestAgentSessionTitleRequest, SuggestAgentSessionTitleResponse,
            UpdateDictionaryEntryRequest, UpdateNoteRequest, UpdateNoteResponse,
        },
    },
    meeting_detection::{MeetingStartRecordingOutcome, MeetingStartRequestState},
};
use chrono::Utc;
use sqlx_sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use std::collections::HashSet;
use std::fs;
use std::str::FromStr;
use std::sync::{mpsc, Arc, Mutex};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::OnceCell;

const MEMORY_CONTENT_MAX_CHARS: usize = 4_000;
const FOLDER_INSTRUCTIONS_MAX_CHARS: usize = 4_000;
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const SQLITE_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(10);
static MEMORY_SETTINGS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
// React StrictMode and renderer reloads may call `bootstrap_app` more than once
// while native processing tasks keep running. Startup repair must run exactly
// once per native process or a second bootstrap could reset a genuinely live
// job from running back to pending.
static TRANSCRIPTION_STARTUP_REPAIR: OnceCell<()> = OnceCell::const_new();

fn sqlite_connect_options(path: &Path) -> Result<SqliteConnectOptions, sqlx::Error> {
    SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))
        .map(|options| options.busy_timeout(SQLITE_BUSY_TIMEOUT))
}

fn sqlite_pool_options(max_connections: u32) -> SqlitePoolOptions {
    SqlitePoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(SQLITE_ACQUIRE_TIMEOUT)
}

/// Owns a newly published capture until every required database row exists.
/// If startup returns early or its future is cancelled, dropping this guard
/// stops the capture and removes its unpublished audio files. This prevents a
/// persistence error from leaving an invisible microphone stream running.
struct CaptureStartupGuard {
    session_id: String,
    paths: AppPaths,
    audio_paths: Vec<PathBuf>,
    armed: bool,
}

impl CaptureStartupGuard {
    fn new(paths: &AppPaths, started: &StartedRecording) -> Self {
        let mut audio_paths = vec![started.partial_path.clone(), started.final_path.clone()];
        for source in &started.sources {
            audio_paths.push(source.partial_path.clone());
            audio_paths.push(source.final_path.clone());
        }
        Self {
            session_id: started.session_id.clone(),
            paths: paths.clone(),
            audio_paths,
            armed: true,
        }
    }

    fn rollback(&mut self) {
        self.rollback_with(|session_id| finish_capture(session_id).map(|_| ()));
    }

    fn rollback_with<F>(&mut self, stop_capture: F)
    where
        F: FnOnce(&str) -> Result<(), AppError>,
    {
        if !self.armed {
            return;
        }
        self.armed = false;
        if let Err(error) = stop_capture(&self.session_id) {
            eprintln!(
                "failed to stop recording {} after startup persistence error; preserving unpublished audio because shutdown was not confirmed: {}",
                self.session_id, error.message
            );
            return;
        }
        for path in &self.audio_paths {
            if let Err(error) = self.paths.remove_recording_file(path) {
                eprintln!(
                    "failed to remove unpublished recording audio {}: {}",
                    path.display(),
                    error
                );
            }
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CaptureStartupGuard {
    fn drop(&mut self) {
        self.rollback();
    }
}

struct MeetingStartCompletionGuard<'a> {
    state: &'a MeetingStartRequestState,
    request_id: String,
    finished: bool,
}

impl<'a> MeetingStartCompletionGuard<'a> {
    fn new(state: &'a MeetingStartRequestState, request_id: String) -> Self {
        Self {
            state,
            request_id,
            finished: false,
        }
    }

    fn finish(&mut self, outcome: MeetingStartRecordingOutcome) -> Result<(), AppError> {
        self.state.finish_start(&self.request_id, outcome)?;
        self.finished = true;
        Ok(())
    }
}

impl Drop for MeetingStartCompletionGuard<'_> {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        if let Err(error) = self.state.fail_start_if_running(&self.request_id) {
            eprintln!(
                "failed to mark interrupted meeting start {}: {}",
                self.request_id, error.message
            );
        }
    }
}

#[tauri::command]
pub async fn bootstrap_app(app: AppHandle) -> Result<BootstrapResponse, AppError> {
    let repos = repositories(&app).await?;
    let profile = active_profile(&app);
    TRANSCRIPTION_STARTUP_REPAIR
        .get_or_try_init(|| async {
            repos.release_interrupted_note_transcription_jobs().await?;
            Ok::<(), sqlx::Error>(())
        })
        .await?;
    let active_recording = current_status();
    let mut active_recoveries = scan_recoverable_recordings(&repos.pool)
        .await
        .map_err(|error| AppError::new("recovery_scan_failed", error.to_string()))?;
    if let Some(active) = &active_recording {
        active_recoveries.retain(|recovery| recovery.session_id != active.session_id);
    }
    for recovery in &active_recoveries {
        repos
            .mark_recording_recoverable(&recovery.session_id, &recovery.note_id)
            .await?;
    }
    let folders = repos
        .list_folders(&profile)
        .await
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?;
    let notes = repos
        .list_notes(&profile, None, 100, None)
        .await
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?
        .items;
    Ok(BootstrapResponse {
        folders,
        notes,
        active_recoveries,
        active_recording,
        provider_configured: crate::providers::provider_configured(),
    })
}

#[tauri::command]
pub fn experimental_flags_get(
    state: tauri::State<'_, crate::experimental_settings::ExperimentalSettingsState>,
) -> Result<crate::experimental_settings::ExperimentalSettings, AppError> {
    crate::experimental_settings::get(state.inner())
}

#[tauri::command]
pub fn experimental_flags_set(
    app: AppHandle,
    state: tauri::State<'_, crate::experimental_settings::ExperimentalSettingsState>,
    request: crate::experimental_settings::ExperimentalSettings,
) -> Result<crate::experimental_settings::ExperimentalSettings, AppError> {
    crate::experimental_settings::set(&app, state.inner(), request)
}

#[tauri::command]
pub async fn create_note(app: AppHandle, request: CreateNoteRequest) -> Result<NoteDto, AppError> {
    let profile = active_profile(&app);
    Ok(repositories(&app)
        .await?
        .create_note(&profile, request.folder_id)
        .await?)
}

#[tauri::command]
pub async fn list_notes(
    app: AppHandle,
    request: ListNotesRequest,
) -> Result<ListNotesResponse, AppError> {
    let profile = active_profile(&app);
    Ok(repositories(&app)
        .await?
        .list_notes(
            &profile,
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
pub async fn download_note_audio(
    app: AppHandle,
    request: DownloadNoteAudioRequest,
) -> Result<DownloadNoteAudioResponse, AppError> {
    let selection = repositories(&app)
        .await?
        .note_audio_export_selection(&request.note_id)
        .await?
        .ok_or_else(crate::note_audio_export::unavailable_error)?;
    let paths = app_paths(&app)?;
    let downloads_dir = app
        .path()
        .download_dir()
        .map_err(|error| AppError::new("note_audio_export_failed", error.to_string()))?;

    tokio::task::spawn_blocking(move || {
        crate::note_audio_export::export_note_audio(&paths, &downloads_dir, selection)
    })
    .await
    .map_err(|error| AppError::new("note_audio_export_failed", error.to_string()))?
}

#[tauri::command]
pub async fn update_note(
    app: AppHandle,
    request: UpdateNoteRequest,
) -> Result<UpdateNoteResponse, AppError> {
    let repositories = repositories(&app).await?;
    let patch = repositories
        .update_note(
            &request.note_id,
            request.title,
            request.edited_content,
            request.active_tab,
        )
        .await?;
    if request.patch_only {
        return Ok(UpdateNoteResponse::Patch(patch));
    }

    Ok(UpdateNoteResponse::Note(Box::new(
        repositories.get_note(&request.note_id).await?,
    )))
}

/// Revoke the remote share for an item and drop its local keys, if the item is
/// shared. Called before deleting a shared item so its server-side ciphertext
/// and invite ACL don't outlive it: once the source note/session is gone the
/// owner has no Share dialog left to revoke from, and existing recipient links
/// would keep opening forever. Fail closed - if the revoke can't be confirmed
/// the caller keeps the item rather than orphaning a live share.
async fn revoke_item_share(
    repos: &Repositories,
    item_kind: &str,
    item_id: &str,
) -> Result<(), AppError> {
    if let Some(record) = repos.share_key_for_item(item_kind, item_id).await? {
        delete_remote_share_or_accept_missing(&record.share_id).await?;
        repos.delete_share_keys(&record.share_id).await?;
    }
    Ok(())
}

async fn delete_remote_share_or_accept_missing(share_id: &str) -> Result<(), AppError> {
    match crate::june_api::share_delete(share_id).await {
        Ok(()) => Ok(()),
        // `share_not_found` is deliberately ambiguous for non-enumeration. For
        // deletion, either meaning is terminal for this local profile: the
        // remote share is already absent or cannot be managed by this account,
        // so retaining the stale key would permanently block item deletion.
        Err(error) if is_share_not_found(&error) => Ok(()),
        Err(error) => Err(error),
    }
}

fn is_share_not_found(error: &AppError) -> bool {
    error.code == "june_request_failed" && error.message == "share_not_found"
}

async fn delete_profile_records_with_share_revoker<F, Fut>(
    repos: &Repositories,
    profile: &str,
    mut revoke_share: F,
) -> Result<Vec<String>, AppError>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<(), AppError>>,
{
    if profile == "default" {
        return Ok(Vec::new());
    }

    for record in repos.share_keys_for_profile_notes(profile).await? {
        revoke_share(record.share_id.clone()).await?;
        repos.delete_share_keys(&record.share_id).await?;
    }

    let audio_paths = repos.audio_artifact_paths_for_profile(profile).await?;
    repos.delete_profile_data(profile).await?;
    Ok(audio_paths)
}

#[tauri::command]
pub async fn delete_note(app: AppHandle, request: DeleteNoteRequest) -> Result<(), AppError> {
    let paths = app_paths(&app)?;
    let repos = repositories(&app).await?;
    revoke_item_share(&repos, "note", &request.note_id).await?;
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
pub async fn delete_notes(app: AppHandle, request: DeleteNotesRequest) -> Result<(), AppError> {
    let note_ids = request
        .note_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if note_ids.is_empty() {
        return Ok(());
    }

    let paths = app_paths(&app)?;
    let repos = repositories(&app).await?;
    for note_id in &note_ids {
        revoke_item_share(&repos, "note", note_id).await?;
    }
    let audio_paths = repos.audio_artifact_paths_for_notes(&note_ids).await?;
    repos.delete_notes(&note_ids).await?;
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
    let profile = active_profile(&app);
    Ok(repositories(&app)
        .await?
        .create_folder(&profile, name, request.description.as_deref())
        .await?)
}

#[tauri::command]
pub async fn list_folders(
    app: AppHandle,
) -> Result<Vec<crate::domain::types::FolderDto>, AppError> {
    let profile = active_profile(&app);
    Ok(repositories(&app).await?.list_folders(&profile).await?)
}

#[tauri::command]
pub async fn discover_claude_projects(
    app: AppHandle,
) -> Result<Vec<ClaudeProjectCandidateDto>, AppError> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| AppError::new("claude_projects_unavailable", error.to_string()))?;
    let profile = active_profile(&app);
    let folders = repositories(&app).await?.list_folders(&profile).await?;
    let already_added = folders
        .into_iter()
        .filter_map(|folder| folder.local_path)
        .filter_map(|path| PathBuf::from(path).canonicalize().ok())
        .collect::<HashSet<_>>();
    Ok(crate::claude_projects::discover(&home, &already_added))
}

#[tauri::command]
pub async fn import_claude_projects(
    app: AppHandle,
    request: ImportClaudeProjectsRequest,
) -> Result<Vec<crate::domain::types::FolderDto>, AppError> {
    if request.paths.is_empty() {
        return Ok(Vec::new());
    }
    if request.paths.len() > 500 {
        return Err(AppError::new(
            "claude_projects_too_many",
            "Choose 500 project folders or fewer at a time.",
        ));
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|error| AppError::new("claude_projects_unavailable", error.to_string()))?;
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for path in request.paths {
        let Some(canonical) = crate::claude_projects::validate_import_path(&home, &path) else {
            return Err(AppError::new(
                "claude_project_invalid",
                "One of the selected project folders is no longer available.",
            ));
        };
        if seen.insert(canonical.clone()) {
            paths.push(canonical);
        }
    }

    let mut projects = Vec::with_capacity(paths.len());
    for path in paths {
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            return Err(AppError::new(
                "claude_project_invalid",
                "One of the selected project folders has no usable name.",
            ));
        };
        projects.push((name.to_string(), path.to_string_lossy().into_owned()));
    }
    let profile = active_profile(&app);
    Ok(repositories(&app)
        .await?
        .create_linked_folders(&profile, &projects)
        .await?)
}

/// The active June profile used by every profile-scoped Rust read.
#[tauri::command]
pub fn sticky_active_profile(app: AppHandle) -> String {
    active_profile(&app)
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
    let profile = active_profile(&app);
    repositories(&app)
        .await?
        .assign_note_to_folder(&profile, &request.note_id, &request.folder_id)
        .await
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
    let profile = active_profile(&app);
    repositories(&app)
        .await?
        .assign_session_to_folder(&profile, &request.session_id, &request.folder_id)
        .await
}

#[tauri::command]
pub async fn list_session_profiles(app: AppHandle) -> Result<Vec<SessionProfileDto>, AppError> {
    Ok(repositories(&app).await?.list_session_profiles().await?)
}

#[tauri::command]
pub async fn assign_session_to_profile(
    app: AppHandle,
    request: AssignSessionToProfileRequest,
) -> Result<(), AppError> {
    Ok(repositories(&app)
        .await?
        .assign_session_to_profile(&request.session_id, &request.profile)
        .await?)
}

#[tauri::command]
pub async fn profile_data_summary(
    app: AppHandle,
    profile: String,
) -> Result<ProfileDataSummaryDto, AppError> {
    Ok(repositories(&app)
        .await?
        .profile_data_summary(&profile)
        .await?)
}

#[tauri::command]
pub async fn move_profile_data_to_default(app: AppHandle, profile: String) -> Result<(), AppError> {
    Ok(repositories(&app)
        .await?
        .move_profile_data_to_default(&profile)
        .await?)
}

#[tauri::command]
pub async fn delete_profile_data(app: AppHandle, profile: String) -> Result<(), AppError> {
    // "Delete permanently" is a privacy promise: remote note shares are
    // revoked before their source rows disappear, and recordings on disk go
    // with those rows, mirroring delete_note / delete_notes.
    let paths = app_paths(&app)?;
    let repos = repositories(&app).await?;
    let audio_paths =
        delete_profile_records_with_share_revoker(&repos, &profile, |share_id| async move {
            delete_remote_share_or_accept_missing(&share_id).await
        })
        .await?;
    for path in audio_paths {
        if path.trim().is_empty() {
            continue;
        }
        if let Err(error) = paths.remove_recording_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("failed to remove deleted profile audio {path}: {error}");
            }
        }
    }
    Ok(())
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
pub async fn list_completed_sessions(app: AppHandle) -> Result<Vec<CompletedSessionDto>, AppError> {
    Ok(repositories(&app).await?.list_completed_sessions().await?)
}

#[tauri::command]
pub async fn set_session_completed(
    app: AppHandle,
    request: SetSessionCompletedRequest,
) -> Result<(), AppError> {
    Ok(repositories(&app)
        .await?
        .set_session_completed(&request.session_id, request.completed)
        .await?)
}

#[tauri::command]
pub async fn list_dictionary_entries(app: AppHandle) -> Result<Vec<DictionaryEntryDto>, AppError> {
    Ok(repositories(&app).await?.list_dictionary_entries().await?)
}

#[tauri::command]
pub async fn list_memories(
    app: AppHandle,
    folder_id: Option<String>,
    include_global: bool,
) -> Result<Vec<MemoryDto>, AppError> {
    let profile = active_profile(&app);
    Ok(repositories(&app)
        .await?
        .list_memories(&profile, folder_id.as_deref(), include_global)
        .await?)
}

#[tauri::command]
pub async fn create_memory(
    app: AppHandle,
    folder_id: Option<String>,
    content: String,
    source: String,
) -> Result<MemoryDto, AppError> {
    let profile = active_profile(&app);
    let repos = repositories(&app).await?;
    let settings_path = memory_settings_path(&app)?;
    create_memory_with_settings(
        &repos,
        &settings_path,
        &profile,
        folder_id.as_deref(),
        &content,
        &source,
    )
    .await
}

#[tauri::command]
pub async fn update_memory(
    app: AppHandle,
    id: String,
    content: String,
) -> Result<MemoryDto, AppError> {
    let profile = active_profile(&app);
    let repos = repositories(&app).await?;
    let settings_path = memory_settings_path(&app)?;
    update_memory_with_settings(&repos, &settings_path, &profile, &id, &content).await
}

#[tauri::command]
pub async fn delete_memory(app: AppHandle, id: String) -> Result<(), AppError> {
    let profile = active_profile(&app);
    repositories(&app).await?.delete_memory(&profile, &id).await
}

#[tauri::command]
pub async fn set_folder_instructions(
    app: AppHandle,
    folder_id: String,
    instructions: Option<String>,
) -> Result<crate::domain::types::FolderDto, AppError> {
    let instructions = validated_folder_instructions(instructions.as_deref())?;
    repositories(&app)
        .await?
        .set_folder_instructions(&folder_id, instructions)
        .await
}

#[tauri::command]
pub async fn set_folder_memory_disabled(
    app: AppHandle,
    folder_id: String,
    disabled: bool,
) -> Result<crate::domain::types::FolderDto, AppError> {
    repositories(&app)
        .await?
        .set_folder_memory_disabled(&folder_id, disabled)
        .await
}

#[tauri::command]
pub async fn memory_settings(app: AppHandle) -> Result<MemorySettingsDto, AppError> {
    let path = memory_settings_path(&app)?;
    let _guard = MEMORY_SETTINGS_LOCK.lock().await;
    Ok(load_memory_settings(&path))
}

#[tauri::command]
pub async fn set_memory_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<MemorySettingsDto, AppError> {
    // Keep the transaction lock through persistence, direct policy mutation,
    // live-runtime convergence, and the authoritative response read. Otherwise
    // two commands can persist in order but finish out of order, allowing an
    // older response to overwrite the UI after a newer choice has landed.
    let _guard = MEMORY_SETTINGS_LOCK.lock().await;
    let settings = MemorySettingsDto { enabled };
    let path = memory_settings_path(&app)?;
    persist_memory_settings(&path, &settings)?;
    // The persisted file is authoritative for June's own memory write gate.
    Ok(load_memory_settings(&path))
}

pub(crate) async fn create_memory_with_settings(
    repos: &Repositories,
    settings_path: &Path,
    profile: &str,
    folder_id: Option<&str>,
    content: &str,
    source: &str,
) -> Result<MemoryDto, AppError> {
    // Every write path (Tauri command AND the loopback proxy) takes the
    // settings lock across the enabled check and the insert, so a save that
    // read "enabled" can never commit after a concurrent toggle-off persists.
    let _guard = MEMORY_SETTINGS_LOCK.lock().await;
    ensure_memory_enabled(settings_path)?;
    let content = validated_memory_content(content)?;
    let source = source.trim();
    if !matches!(source, "agent" | "user") {
        return Err(AppError::new(
            "memory_source_invalid",
            "Memory source must be agent or user.",
        ));
    }
    repos
        .create_memory(profile, folder_id, content, source)
        .await
}

async fn update_memory_with_settings(
    repos: &Repositories,
    settings_path: &Path,
    profile: &str,
    id: &str,
    content: &str,
) -> Result<MemoryDto, AppError> {
    // Same lock discipline as create: check + write under the settings lock.
    let _guard = MEMORY_SETTINGS_LOCK.lock().await;
    ensure_memory_enabled(settings_path)?;
    let content = validated_memory_content(content)?;
    repos.update_memory(profile, id, content).await
}

fn ensure_memory_enabled(settings_path: &Path) -> Result<(), AppError> {
    if load_memory_settings(settings_path).enabled {
        Ok(())
    } else {
        Err(memory_disabled_error())
    }
}

fn persist_memory_settings(path: &Path, settings: &MemorySettingsDto) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::new("memory_settings_save_failed", error.to_string()))?;
    }
    let serialized = serde_json::to_string_pretty(&settings)
        .map_err(|error| AppError::new("memory_settings_save_failed", error.to_string()))?;
    let temporary_path = path.with_extension("json.tmp");
    fs::write(&temporary_path, serialized)
        .map_err(|error| AppError::new("memory_settings_save_failed", error.to_string()))?;
    // `fs::rename` does not replace an existing destination on Windows;
    // `replace_file` is the repo's platform-aware wrapper (POSIX rename, or
    // ReplaceFileW/MoveFileExW on Windows) so a second toggle can't fail and an
    // existing destination keeps its security metadata.
    crate::filesystem::replace_file(&temporary_path, path).map_err(|error| {
        let _ = fs::remove_file(&temporary_path);
        AppError::new("memory_settings_save_failed", error.to_string())
    })
}

fn validated_memory_content(content: &str) -> Result<&str, AppError> {
    let content = content.trim();
    if content.is_empty() {
        return Err(AppError::new(
            "memory_content_required",
            "Memory content is required.",
        ));
    }
    if content.chars().count() > MEMORY_CONTENT_MAX_CHARS {
        return Err(AppError::new(
            "memory_content_too_long",
            format!("Memory content cannot exceed {MEMORY_CONTENT_MAX_CHARS} characters."),
        ));
    }
    Ok(content)
}

fn validated_folder_instructions(instructions: Option<&str>) -> Result<Option<&str>, AppError> {
    let instructions = instructions
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if instructions.is_some_and(|value| value.chars().count() > FOLDER_INSTRUCTIONS_MAX_CHARS) {
        return Err(AppError::new(
            "folder_instructions_too_long",
            format!(
                "Folder instructions cannot exceed {FOLDER_INSTRUCTIONS_MAX_CHARS} characters."
            ),
        ));
    }
    Ok(instructions)
}

pub(crate) fn memory_settings_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("memory-settings.json"))
        .map_err(|error| AppError::new("memory_settings_unavailable", error.to_string()))
}

fn load_memory_settings(path: &Path) -> MemorySettingsDto {
    match fs::read_to_string(path) {
        Ok(settings) => {
            serde_json::from_str(&settings).unwrap_or(MemorySettingsDto { enabled: false })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => MemorySettingsDto::default(),
        Err(_) => MemorySettingsDto { enabled: false },
    }
}

fn memory_disabled_error() -> AppError {
    AppError::new("memory_disabled", "Memory is disabled for this scope.")
}

#[tauri::command]
pub async fn suggest_agent_session_title(
    request: SuggestAgentSessionTitleRequest,
) -> Result<SuggestAgentSessionTitleResponse, AppError> {
    let title =
        crate::june_api::suggest_agent_session_title(&request.prompt, request.response.as_deref())
            .await?;
    Ok(SuggestAgentSessionTitleResponse { title })
}

#[tauri::command]
pub async fn submit_issue_report(
    app: AppHandle,
    request: SubmitIssueReportRequest,
) -> Result<SubmitIssueReportResponse, AppError> {
    let app_version = app.package_info().version.to_string();
    crate::june_api::submit_issue_report(&request, &app_version).await
}

#[tauri::command]
pub async fn explain_agent_approval(
    request: ExplainAgentApprovalRequest,
) -> Result<ExplainAgentApprovalResponse, AppError> {
    let explanation =
        crate::june_api::explain_agent_approval(&request.description, request.command.as_deref())
            .await?;
    Ok(ExplainAgentApprovalResponse { explanation })
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

/// Opens the june-api `/verify` page (enclave attestation, routing,
/// retention) in the default browser. Must route through Rust: the webview
/// installs no new-window handler, so `target="_blank"` anchors are silently
/// dropped — same reason the accounts portal links go through a command.
#[tauri::command]
pub fn june_open_verify_page() -> Result<(), AppError> {
    crate::os_accounts::open_in_browser(&crate::june_api::verify_url())
}

const JUNE_COMMUNITY_URL: &str = "https://t.me/osjune";

/// Opens the June Telegram community in the default browser.
#[tauri::command]
pub fn june_open_community_page() -> Result<(), AppError> {
    crate::os_accounts::open_in_browser(JUNE_COMMUNITY_URL)
}

/// Opens an arbitrary external link in the default browser. This is the
/// generic sibling of the fixed-URL commands above: the frontend's global
/// anchor interceptor (src/lib/external-links.ts) routes every external
/// `target="_blank"` click here, since the webview drops them otherwise.
/// Scheme-checked to http/https so a crafted href can't reach other URL
/// handlers (file:, tel:, custom schemes) through the OS opener.
#[tauri::command]
pub fn june_open_external_url(url: String) -> Result<(), AppError> {
    let scheme_ok = {
        let lower = url.trim_start().to_ascii_lowercase();
        lower.starts_with("https://") || lower.starts_with("http://")
    };
    if !scheme_ok {
        return Err(AppError::new(
            "external_url_rejected",
            "Only http(s) links can be opened externally.",
        ));
    }
    crate::os_accounts::open_in_browser(url.trim())
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
            "screenRecording" | "systemAudio" => {
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
        open_non_macos_privacy_settings(request)
    }
}

#[cfg(target_os = "windows")]
fn open_non_macos_privacy_settings(request: OpenPrivacySettingsRequest) -> Result<(), AppError> {
    match request.pane.as_str() {
        "microphone" => crate::os_accounts::open_in_browser("ms-settings:privacy-microphone"),
        _ => Err(AppError::new(
            "settings_open_unsupported",
            "This privacy settings shortcut is only supported on macOS.",
        )),
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn open_non_macos_privacy_settings(request: OpenPrivacySettingsRequest) -> Result<(), AppError> {
    let _ = request;
    Err(AppError::new(
        "settings_open_unsupported",
        "Privacy settings shortcuts are only supported on macOS.",
    ))
}

/// Reveals an absolute path in the platform file manager: on macOS it opens
/// Finder with the item selected (`open -R`), on Windows it selects the item
/// in Explorer (`explorer /select,`), and elsewhere it opens the containing
/// directory with `xdg-open`. The path is validated to be absolute and to
/// exist, then passed as a distinct argument (never through a shell) so it
/// cannot be interpolated. The child is spawned without blocking.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.is_absolute() {
        return Err(format!("Path must be absolute: {path}"));
    }
    if !target.exists() {
        return Err(format!("Path does not exist: {path}"));
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Failed to reveal path in Finder: {error}"))
    }
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsString;
        use std::os::windows::process::CommandExt;

        // Explorer has its own legacy command-line parser. Build the exact
        // argument string it expects and pass it with `raw_arg` so Rust does
        // not escape the inner quotes as `\"`, which makes Explorer fall
        // back to the default folder instead of selecting the file. Keep the
        // path as an OsString so non-UTF-8 Windows paths are not lossy-formatted.
        let mut command = std::process::Command::new("explorer.exe");
        let mut arg = OsString::new();
        if target.is_dir() {
            arg.push("\"");
            arg.push(target.as_os_str());
            arg.push("\"");
        } else {
            arg.push("/select,\"");
            arg.push(target.as_os_str());
            arg.push("\"");
        }
        command
            .raw_arg(arg)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Failed to reveal path in Explorer: {error}"))
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let dir = target.parent().unwrap_or(target);
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Failed to open containing directory: {error}"))
    }
}

/// Copies the exact bundled developer extension into app data and reveals the
/// destination. The source manifest is validated before and after copying so a
/// release-package manifest whose key was stripped can never be offered as an
/// unpacked build with a random extension id.
#[tauri::command]
pub fn unpack_bundled_extension(app: AppHandle) -> Result<String, AppError> {
    let source = app
        .path()
        .resource_dir()
        .map_err(|error| AppError::new("bundled_extension_unavailable", error.to_string()))?
        .join("native")
        .join("extension");
    crate::extension_host::validate_extension_manifest(&source.join("manifest.json"))?;

    let data_dir = crate::app_paths::app_data_dir(&app)
        .map_err(|error| AppError::new("bundled_extension_unpack_failed", error.to_string()))?;
    fs::create_dir_all(&data_dir)
        .map_err(|error| AppError::new("bundled_extension_unpack_failed", error.to_string()))?;
    let destination = data_dir.join("extension-unpacked");
    let staging = data_dir.join("extension-unpacked.tmp");
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|error| AppError::new("bundled_extension_unpack_failed", error.to_string()))?;
    }
    copy_directory(&source, &staging).map_err(|error| {
        let _ = fs::remove_dir_all(&staging);
        AppError::new("bundled_extension_unpack_failed", error.to_string())
    })?;
    crate::extension_host::validate_extension_manifest(&staging.join("manifest.json"))?;

    replace_directory_from_staging(&staging, &destination, |from, to| fs::rename(from, to))
        .map_err(|error| AppError::new("bundled_extension_unpack_failed", error.to_string()))?;

    let destination_string = destination.to_string_lossy().into_owned();
    reveal_path(destination_string.clone())
        .map_err(|error| AppError::new("bundled_extension_reveal_failed", error))?;
    Ok(destination_string)
}

fn replace_directory_from_staging(
    staging: &Path,
    destination: &Path,
    mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let destination_name = destination.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "extension destination has no file name",
        )
    })?;
    let mut backup_name = destination_name.to_os_string();
    backup_name.push(".backup");
    let backup = destination.with_file_name(backup_name);

    if backup.exists() {
        if destination.exists() {
            fs::remove_dir_all(&backup)?;
        } else {
            rename(&backup, destination)?;
        }
    }

    let had_destination = destination.exists();
    if had_destination {
        rename(destination, &backup)?;
    }

    if let Err(replace_error) = rename(staging, destination) {
        if had_destination {
            rename(&backup, destination).map_err(|restore_error| {
                std::io::Error::new(
                    restore_error.kind(),
                    format!(
                        "failed to replace extension directory ({replace_error}); failed to restore backup ({restore_error})"
                    ),
                )
            })?;
        }
        return Err(replace_error);
    }

    if had_destination {
        fs::remove_dir_all(backup)?;
    }
    Ok(())
}

fn copy_directory(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    let staging_root = destination.canonicalize()?;
    copy_directory_contents(source, destination, &staging_root)
}

fn copy_directory_contents(
    source: &Path,
    destination: &Path,
    staging_root: &Path,
) -> std::io::Result<()> {
    ensure_destination_within_staging(destination, staging_root)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        ensure_destination_within_staging(&destination_path, staging_root)?;
        if file_type.is_dir() {
            fs::create_dir(&destination_path)?;
            ensure_destination_within_staging(&destination_path, staging_root)?;
            copy_directory_contents(&source_path, &destination_path, staging_root)?;
        } else if file_type.is_file() {
            fs::copy(source_path, &destination_path)?;
            ensure_destination_within_staging(&destination_path, staging_root)?;
        }
    }
    Ok(())
}

fn ensure_destination_within_staging(
    destination: &Path,
    staging_root: &Path,
) -> std::io::Result<()> {
    let candidate = match fs::symlink_metadata(destination) {
        Ok(_) => destination.canonicalize()?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = destination.parent().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "extension destination has no parent",
                )
            })?;
            let name = destination.file_name().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "extension destination has no file name",
                )
            })?;
            parent.canonicalize()?.join(name)
        }
        Err(error) => return Err(error),
    };
    if candidate.starts_with(staging_root) {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "extension destination escapes the staging directory",
        ))
    }
}

#[tauri::command]
pub async fn start_meeting_recording(
    app: AppHandle,
    state: State<'_, MeetingStartRequestState>,
    request: StartMeetingRecordingRequest,
) -> Result<MeetingStartRecordingOutcome, AppError> {
    // The guard spans the full native operation. A second webview invocation
    // for the same retained request waits for the first one, then reads its
    // cached terminal outcome instead of touching the active capture.
    let _start_guard = state.lock_start().await;
    if let Some(outcome) = state.finished_outcome(&request.request_id)? {
        return Ok(outcome);
    }

    let note_id = match state.begin_start_now(&request.request_id) {
        Ok(note_id) => note_id,
        Err(error) if error.code == "meeting_start_expired" => {
            let outcome = MeetingStartRecordingOutcome::Failed { error };
            state.finish_start(&request.request_id, outcome.clone())?;
            return Ok(outcome);
        }
        Err(error) => return Err(error),
    };
    let mut completion =
        MeetingStartCompletionGuard::new(state.inner(), request.request_id.clone());

    let outcome =
        match execute_meeting_recording(app, &note_id, request.source_mode.unwrap_or_default())
            .await
        {
            Ok((note, recording)) => MeetingStartRecordingOutcome::Started {
                note: Box::new(note),
                recording: Box::new(recording),
            },
            Err(error) => MeetingStartRecordingOutcome::Failed { error },
        };
    completion.finish(outcome.clone())?;
    Ok(outcome)
}

async fn execute_meeting_recording(
    app: AppHandle,
    note_id: &str,
    requested_source_mode: RecordingSourceMode,
) -> Result<(NoteDto, RecordingSessionDto), AppError> {
    let repos = repositories(&app).await?;
    let profile = active_profile(&app);
    let note = repos
        .create_note_with_id(&profile, None, note_id)
        .await
        .map_err(AppError::from)?;

    let result = async {
        // Match the ordinary recorder's graceful fallback: system audio is an
        // enhancement, while the microphone remains the required source.
        let readiness =
            tokio::task::spawn_blocking(move || recording_source_readiness(requested_source_mode))
                .await
                .map_err(|error| AppError::new("readiness_check_failed", error.to_string()))?;
        let system_ready = readiness
            .sources
            .iter()
            .find(|source| source.source == RecordingSource::System)
            .map_or(true, |source| source.ready);
        let source_mode = if requested_source_mode == RecordingSourceMode::MicrophonePlusSystem
            && !system_ready
        {
            RecordingSourceMode::MicrophoneOnly
        } else {
            requested_source_mode
        };

        start_recording_inner(
            app,
            StartRecordingRequest {
                note_id: note.id.clone(),
                source_mode: Some(source_mode),
            },
            false,
        )
        .await
    }
    .await;
    match result {
        Ok(recording) => Ok((note, recording)),
        Err(error) => {
            // The startup guard stops any partially published capture before
            // returning an error. Keep the ownership check defensive so a
            // future recoverable outcome can never delete real user data.
            let active_capture_owns_note = current_status()
                .and_then(|status| status.note_id)
                .is_some_and(|active_note_id| active_note_id == note.id);
            if !active_capture_owns_note {
                match repos.delete_untouched_draft(&note.id).await {
                    Ok(true) => {}
                    Ok(false) => eprintln!(
                        "preserved changed meeting-start draft {} after startup error",
                        note.id
                    ),
                    Err(delete_error) => {
                        eprintln!(
                            "failed to delete meeting-start draft {} after startup error: {}",
                            note.id, delete_error
                        );
                    }
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    request: StartRecordingRequest,
) -> Result<RecordingSessionDto, AppError> {
    start_recording_inner(app, request, true).await
}

async fn start_recording_inner(
    app: AppHandle,
    request: StartRecordingRequest,
    finish_existing_capture: bool,
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
    // First capture on a fresh install: the main app must own its TCC mic
    // prompt (the dictation helper's grant is a different bundle). Resolve
    // `not_determined` here, before the stream opens, so a denial is a clear
    // error instead of a recording full of zeros.
    #[cfg(target_os = "macos")]
    {
        let (permission_state, permission_hint) = tokio::task::spawn_blocking(
            crate::audio::capture::request_microphone_permission_blocking,
        )
        .await
        .map_err(|error| AppError::new("readiness_check_failed", error.to_string()))?;
        if matches!(
            permission_state.as_str(),
            "denied" | "restricted" | "not_determined"
        ) {
            return Err(AppError::new(
                "microphone_permission_missing",
                permission_hint
                    .unwrap_or_else(|| "Microphone permission is required to record.".to_string()),
            ));
        }
    }
    if finish_existing_capture {
        finish_active_capture_before_start(&app, &repos).await?;
    } else if is_capture_active() {
        return Err(AppError::new(
            "recording_already_active",
            "Another recording is already running.",
        ));
    }
    let capture_paths = paths.clone();
    let capture_note_id = note.id.clone();
    let calendar_app = app.clone();
    let started = start_capture_with_timeout(move |abandoned| {
        start_capture_with_cancel(app, &capture_paths, capture_note_id, source_mode, abandoned)
    })
    .await?;
    let mut startup_guard = CaptureStartupGuard::new(&paths, &started);
    let source_rows = started
        .sources
        .iter()
        .map(|source| {
            (
                source.source.as_db().to_string(),
                source.partial_path.to_string_lossy().into_owned(),
                source.final_path.to_string_lossy().into_owned(),
            )
        })
        .collect::<Vec<_>>();
    if let Err(error) = repos
        .create_recording_start(
            &note.id,
            &started.session_id,
            source_mode,
            &started.partial_path.to_string_lossy(),
            &started.final_path.to_string_lossy(),
            started.device_label.clone(),
            &source_rows,
        )
        .await
    {
        startup_guard.rollback();
        return Err(error.into());
    }
    // The capture now has all rows required for reload/recovery. Optional
    // diagnostics below must not roll it back if their future is cancelled.
    startup_guard.disarm();
    spawn_recording_recovery_checkpoint_worker(repos.clone(), started.session_id.clone());
    if let Err(error) = repos
        .add_checkpoint(
            &started.session_id,
            "source_readiness",
            Some(
                serde_json::json!({
                    "sourceMode": readiness.source_mode,
                    "ready": readiness.ready,
                    "checkedAt": readiness.checked_at,
                    "sourceCount": readiness.sources.len(),
                    "requiredSourceCount": readiness.sources.iter().filter(|source| source.required).count(),
                    "readySourceCount": readiness.sources.iter().filter(|source| source.ready).count(),
                })
                .to_string(),
            ),
        )
        .await
    {
        eprintln!(
            "failed to persist source_readiness checkpoint for {}: {}",
            started.session_id, error
        );
    }
    for source in &readiness.sources {
        if let Err(error) = repos
            .add_source_checkpoint(
                &started.session_id,
                None,
                Some(source.source.as_db()),
                "source_readiness",
                Some(
                    serde_json::json!({
                        "source": source.source.as_db(),
                        "required": source.required,
                        "ready": source.ready,
                        "permissionState": source.permission_state,
                        "deviceAvailable": source.device_available,
                        "captureAvailable": source.capture_available,
                        "recoveryAction": source.recovery_action,
                        "message": source.message,
                        "taxonomyCode": readiness_taxonomy_code(source),
                    })
                    .to_string(),
                ),
            )
            .await
        {
            eprintln!(
                "failed to persist source_readiness checkpoint for {} source {}: {}",
                started.session_id,
                source.source.as_db(),
                error
            );
        }
    }
    let calendar_repos = repos.clone();
    let calendar_note_id = note.id.clone();
    let expected_title = note.title.clone();
    let recording_started_at = Utc::now();
    tokio::spawn(async move {
        let enrichment = crate::meeting_calendar_context::enrich_note_for_recording(
            &calendar_app,
            calendar_repos.clone(),
            calendar_note_id.clone(),
            expected_title,
            recording_started_at,
        )
        .await;
        match enrichment {
            Ok(true) => match calendar_repos.get_note(&calendar_note_id).await {
                Ok(mut note) => {
                    note.queued_recordings = processing_queue::queued_behind(&calendar_note_id);
                    let _ = calendar_app.emit(
                        crate::meeting_calendar_context::NOTE_CALENDAR_CONTEXT_UPDATED_EVENT,
                        note,
                    );
                }
                Err(error) => {
                    eprintln!("calendar context was saved but could not be reloaded: {error}")
                }
            },
            Ok(false) => {}
            Err(error) => eprintln!(
                "calendar context lookup failed without interrupting recording: {}: {}",
                error.code, error.message
            ),
        }
    });
    Ok(RecordingSessionDto {
        id: started.session_id,
        note_id: note.id,
        source_mode,
        state: started.status.state,
        started_at: crate::db::repositories::timestamp(),
        elapsed_ms: started.status.elapsed_ms,
        device_label: started.device_label,
        level: started.status.level,
        live_preview_enabled: started.status.live_preview_enabled,
        sources: started.status.sources,
        warnings: Vec::new(),
    })
}

async fn start_capture_with_timeout<F>(start_capture: F) -> Result<StartedRecording, AppError>
where
    F: FnOnce(Arc<CaptureStartHandshake>) -> Result<StartedRecording, AppError> + Send + 'static,
{
    start_capture_with_timeout_and_cleanup(
        start_capture,
        |started| {
            if let Err(error) = finish_capture(&started.session_id) {
                eprintln!(
                    "failed to tear down abandoned recording {} after start timeout: {}",
                    started.session_id, error.message
                );
            }
        },
        CAPTURE_START_TIMEOUT,
    )
    .await
}

async fn start_capture_with_timeout_and_cleanup<F, C>(
    start_capture: F,
    cleanup_late_success: C,
    timeout: Duration,
) -> Result<StartedRecording, AppError>
where
    F: FnOnce(Arc<CaptureStartHandshake>) -> Result<StartedRecording, AppError> + Send + 'static,
    C: FnOnce(&StartedRecording) + Send + 'static,
{
    let handshake = Arc::new(Mutex::new(CaptureStartState::Pending));
    let worker_handshake = Arc::clone(&handshake);
    let (sender, receiver) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("capture-start".to_string())
        .spawn(move || {
            let result = start_capture(worker_handshake);
            match result {
                Ok(started) => {
                    if let Err(mpsc::SendError(Ok(started))) = sender.send(Ok(started)) {
                        cleanup_late_success(&started);
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(error));
                }
            }
        })
        .map_err(|error| AppError::new("recording_start_failed", error.to_string()))?;
    drop(thread);

    tokio::task::spawn_blocking(move || {
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Abandon only a build that has not committed. If the builder
                // already published (it won the race by a hair), its capture
                // is live: take the in-flight result as success instead of
                // stranding an active recording behind a timeout error.
                let published = handshake
                    .lock()
                    .map(|mut state| {
                        if *state == CaptureStartState::Published {
                            true
                        } else {
                            *state = CaptureStartState::Abandoned;
                            false
                        }
                    })
                    .unwrap_or(false);
                if published {
                    receiver.recv().unwrap_or_else(|_| {
                        Err(AppError::new(
                            "recording_start_failed",
                            "Recording start failed before reporting a result.",
                        ))
                    })
                } else {
                    Err(capture_start_timeout_error())
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(AppError::new(
                "recording_start_failed",
                "Recording start failed before reporting a result.",
            )),
        }
    })
    .await
    .map_err(|error| AppError::new("recording_start_failed", error.to_string()))?
}

#[tauri::command]
pub async fn pause_recording(
    app: AppHandle,
    request: SessionRequest,
) -> Result<RecordingStatusDto, AppError> {
    let snapshot = pause_capture(&request.session_id)?;
    checkpoint_recording_recovery_snapshot(&app, &snapshot).await;
    Ok(snapshot.status)
}

#[tauri::command]
pub async fn resume_recording(
    app: AppHandle,
    request: SessionRequest,
) -> Result<RecordingStatusDto, AppError> {
    let snapshot = resume_capture(&request.session_id)?;
    checkpoint_recording_recovery_snapshot(&app, &snapshot).await;
    Ok(snapshot.status)
}

#[tauri::command]
pub async fn get_recording_status(
    _app: AppHandle,
    request: SessionRequest,
) -> Result<RecordingStatusDto, AppError> {
    capture_status(&request.session_id)
}

fn spawn_recording_recovery_checkpoint_worker(repos: Repositories, session_id: String) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(RECOVERY_SNAPSHOT_INTERVAL);
        let mut reported_dropped_samples = 0_u64;
        let mut reported_capture_issue = None;
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Tokio intervals tick immediately. The recording-start rows already
        // hold elapsed=0, so wait for the first real checkpoint interval.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            match capture_recovery_checkpoint(&session_id) {
                Ok(Some(checkpoint)) => {
                    if checkpoint.dropped_samples > reported_dropped_samples {
                        let dropped_since_last =
                            checkpoint.dropped_samples - reported_dropped_samples;
                        match repos
                            .add_source_checkpoint(
                                &checkpoint.session_id,
                                None,
                                Some(RecordingSource::Microphone.as_db()),
                                "capture_buffer_overflow",
                                Some(
                                    serde_json::json!({
                                        "droppedSamples": checkpoint.dropped_samples,
                                        "droppedSinceLastCheckpoint": dropped_since_last,
                                        "elapsedMs": checkpoint.elapsed_ms,
                                    })
                                    .to_string(),
                                ),
                            )
                            .await
                        {
                            Ok(()) => {
                                reported_dropped_samples = checkpoint.dropped_samples;
                            }
                            Err(error) => {
                                eprintln!(
                                    "recording overflow checkpoint failed for {}: {}",
                                    checkpoint.session_id, error
                                );
                            }
                        }
                    }
                    if let Some(issue) = checkpoint.capture_issue.as_ref() {
                        if reported_capture_issue.as_deref() != Some(issue.code.as_str()) {
                            match repos
                                .add_source_checkpoint(
                                    &checkpoint.session_id,
                                    None,
                                    Some(RecordingSource::Microphone.as_db()),
                                    "capture_stream_error",
                                    Some(
                                        serde_json::json!({
                                            "code": issue.code,
                                            "message": issue.message,
                                            "elapsedMs": issue.elapsed_ms,
                                        })
                                        .to_string(),
                                    ),
                                )
                                .await
                            {
                                Ok(()) => {
                                    reported_capture_issue = Some(issue.code.clone());
                                }
                                Err(error) => {
                                    eprintln!(
                                        "recording capture issue checkpoint failed for {}: {}",
                                        checkpoint.session_id, error
                                    );
                                }
                            }
                        }
                    }
                    if let Err(error) = persist_recording_recovery_state(
                        &repos,
                        &checkpoint.session_id,
                        checkpoint.state,
                        checkpoint.elapsed_ms,
                    )
                    .await
                    {
                        eprintln!(
                            "recording recovery checkpoint failed for {}: {}: {}",
                            checkpoint.session_id, error.code, error.message
                        );
                    }
                }
                Ok(None) => {}
                Err(error) if error.code == "recording_not_found" => break,
                Err(error) => {
                    eprintln!(
                        "recording recovery checkpoint worker stopped for {}: {}: {}",
                        session_id, error.code, error.message
                    );
                    break;
                }
            }
        }
    });
}

async fn checkpoint_recording_recovery_snapshot(
    app: &AppHandle,
    snapshot: &CaptureRecoverySnapshot,
) {
    if !snapshot.should_persist {
        return;
    }
    let repos = match repositories(app).await {
        Ok(repos) => repos,
        Err(error) => {
            eprintln!(
                "recording recovery checkpoint unavailable for session {}: {}: {}",
                snapshot.status.session_id, error.code, error.message
            );
            return;
        }
    };
    if let Err(error) = persist_recording_recovery_snapshot(&repos, snapshot).await {
        eprintln!(
            "recording recovery checkpoint failed for session {}: {}: {}",
            snapshot.status.session_id, error.code, error.message
        );
    }
}

async fn persist_recording_recovery_snapshot(
    repos: &Repositories,
    snapshot: &CaptureRecoverySnapshot,
) -> Result<(), AppError> {
    persist_recording_recovery_state(
        repos,
        &snapshot.status.session_id,
        snapshot.status.state,
        snapshot.status.elapsed_ms,
    )
    .await
}

async fn persist_recording_recovery_state(
    repos: &Repositories,
    session_id: &str,
    state: crate::domain::types::RecordingState,
    elapsed_ms: i64,
) -> Result<(), AppError> {
    repos
        .update_recording_recovery_snapshot(session_id, state, elapsed_ms)
        .await?;
    Ok(())
}

fn note_processing_progress_reporter(app: &AppHandle) -> NoteProcessingProgressReporter {
    let app = app.clone();
    NoteProcessingProgressReporter::new(move |progress| {
        if let Err(error) = app.emit(NOTE_PROCESSING_PROGRESS_EVENT, progress) {
            tracing::warn!(%error, "failed to emit note processing progress");
        }
    })
}

#[tauri::command]
pub async fn finish_recording(
    app: AppHandle,
    request: SessionRequest,
) -> Result<FinishRecordingResponse, AppError> {
    let timing = ProcessingTiming::from_done(Instant::now());
    let repos = repositories(&app).await?;
    let finalization_started = Instant::now();
    let finished = finish_capture(&request.session_id)?;
    let response = finish_recording_session_with_timing(
        &repos,
        finished,
        finalization_started,
        timing,
        note_processing_progress_reporter(&app),
    )
    .await?;
    if response.processing_started {
        crate::p3a::record_question_best_effort(
            app,
            crate::p3a::questions::Question::NotesMeetingsRecorded,
        );
    }
    Ok(response)
}

async fn finish_active_capture_before_start(
    app: &AppHandle,
    repos: &Repositories,
) -> Result<(), AppError> {
    let finalization_started = Instant::now();
    if let Some(finished) = finish_active_capture()? {
        finish_recording_session_with_timing(
            repos,
            finished,
            finalization_started,
            ProcessingTiming::untracked(),
            note_processing_progress_reporter(app),
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
async fn finish_recording_session(
    repos: &Repositories,
    finished: crate::audio::capture::FinishedRecording,
    finalization_started: Instant,
) -> Result<FinishRecordingResponse, AppError> {
    finish_recording_session_with_timing(
        repos,
        finished,
        finalization_started,
        ProcessingTiming::untracked(),
        NoteProcessingProgressReporter::default(),
    )
    .await
}

async fn finish_recording_session_with_timing(
    repos: &Repositories,
    finished: crate::audio::capture::FinishedRecording,
    finalization_started: Instant,
    timing: ProcessingTiming,
    progress: NoteProcessingProgressReporter,
) -> Result<FinishRecordingResponse, AppError> {
    let finalization_ms = finalization_started
        .elapsed()
        .as_millis()
        .min(i64::MAX as u128) as i64;
    if let Err(error) = repos
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
        .await
    {
        eprintln!(
            "failed to persist recording_finalization checkpoint for {}: {}",
            finished.session_id, error
        );
    }
    if let Err(error) = repos
        .add_checkpoint(&finished.session_id, "done", None)
        .await
    {
        eprintln!(
            "failed to persist done checkpoint for {}: {}",
            finished.session_id, error
        );
    }
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
        let source_artifact = source_artifacts
            .iter()
            .find(|artifact| artifact.source == source.source.as_db());
        if source.dropped_samples > 0 {
            if let Err(error) = repos
                .add_source_checkpoint(
                    &finished.session_id,
                    source_artifact.map(|artifact| artifact.id.as_str()),
                    Some(source.source.as_db()),
                    "capture_buffer_overflow",
                    Some(
                        serde_json::json!({
                            "droppedSamples": source.dropped_samples,
                            "final": true,
                        })
                        .to_string(),
                    ),
                )
                .await
            {
                eprintln!(
                    "failed to persist capture_buffer_overflow checkpoint for {} source {}: {}",
                    finished.session_id,
                    source.source.as_db(),
                    error
                );
            }
        }
        if let Some(issue) = source.capture_issue.as_ref() {
            if let Err(error) = repos
                .add_source_checkpoint(
                    &finished.session_id,
                    source_artifact.map(|artifact| artifact.id.as_str()),
                    Some(source.source.as_db()),
                    "capture_stream_error",
                    Some(
                        serde_json::json!({
                            "code": issue.code,
                            "message": issue.message,
                            "elapsedMs": issue.elapsed_ms,
                        })
                        .to_string(),
                    ),
                )
                .await
            {
                eprintln!(
                    "failed to persist capture_stream_error checkpoint for {} source {}: {}",
                    finished.session_id,
                    source.source.as_db(),
                    error
                );
            }
        }
        if let Some(failure) = source.failure.as_ref() {
            if let Err(error) = repos
                .add_source_checkpoint(
                    &finished.session_id,
                    source_artifact.map(|artifact| artifact.id.as_str()),
                    Some(source.source.as_db()),
                    "capture_stream_error",
                    Some(
                        serde_json::json!({
                            "message": failure.message,
                            "code": failure.code,
                        })
                        .to_string(),
                    ),
                )
                .await
            {
                eprintln!(
                    "failed to persist capture_stream_error checkpoint for {} source {}: {}",
                    finished.session_id,
                    source.source.as_db(),
                    error
                );
            }
        }
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
        let valid =
            source.failure.is_none() && source_audio_passes_validation(source.source, &validation);
        let validation_taxonomy = validation_taxonomy_code(&validation, valid);
        let validation_checkpoint_details = serde_json::json!({
            "path": source.final_path.to_string_lossy(),
            "elapsedMs": source.elapsed_ms,
            "fileSizeBytes": file_size,
            "checksum": checksum,
            "fileExists": validation.file_exists,
            "nonZeroSize": validation.non_zero_size,
            "readableAudio": validation.readable_audio,
            "expectedDurationMs": validation.expected_duration_ms,
            "actualDurationMs": validation.actual_duration_ms,
            "durationWithinTolerance": validation.duration_within_tolerance,
            "nonSilentSignal": validation.non_silent_signal,
            "recordedSilence": validation.recorded_silence,
            "peakAmplitude": validation.peak_amplitude,
            "rmsAmplitude": validation.rms_amplitude,
            "valid": valid,
            "taxonomyCode": validation_taxonomy,
            "warnings": validation.warnings,
        })
        .to_string();
        if source.source == RecordingSource::Microphone {
            primary_validation = Some(validation.clone());
            primary_checksum = checksum.clone();
            primary_file_size = file_size;
        }
        if let Some(artifact) = source_artifact {
            let final_path = source.final_path.to_string_lossy().into_owned();
            repos
                .finalize_source_artifact(
                    &artifact.id,
                    &final_path,
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
            if let Err(error) = repos
                .add_source_checkpoint(
                    &finished.session_id,
                    Some(artifact.id.as_str()),
                    Some(source.source.as_db()),
                    "source_audio_validation",
                    Some(validation_checkpoint_details.clone()),
                )
                .await
            {
                eprintln!(
                    "failed to persist source_audio_validation checkpoint for {} source {}: {}",
                    finished.session_id,
                    source.source.as_db(),
                    error
                );
            }
            if valid {
                valid_sources.push((
                    artifact.id.clone(),
                    source.source.as_db().to_string(),
                    source.final_path.clone(),
                    validation.recorded_silence,
                ));
            }
        }
        if !valid {
            let failure_message = source
                .failure
                .as_ref()
                .map(|failure| failure.message.clone())
                .unwrap_or_else(|| validation.warnings.join("; "));
            warnings.push(crate::domain::types::SourceWarningDto {
                source: source.source,
                code: "source_validation_failed".to_string(),
                message: format!(
                    "{} source did not pass validation: {}",
                    source.source.as_db(),
                    failure_message
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
            recorded_silence: validation.recorded_silence,
            peak_amplitude: Some(validation.peak_amplitude),
            rms_amplitude: Some(validation.rms_amplitude),
            warnings: validation.warnings.clone(),
            error: if valid {
                None
            } else {
                source
                    .failure
                    .as_ref()
                    .map(|failure| failure.message.clone())
                    .or_else(|| Some(validation.warnings.join("; ")))
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
            recorded_silence: false,
            peak_amplitude: 0.0,
            rms_amplitude: 0.0,
            warnings: vec!["No microphone validation was available.".to_string()],
        });
    let primary_valid = source_audio_passes_validation(RecordingSource::Microphone, &validation);
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
            if primary_valid {
                None
            } else {
                Some(validation.warnings.join("; "))
            },
        )
        .await?;

    add_latency_checkpoint(
        repos,
        &finished.session_id,
        "audio_validation",
        timing.checkpoint_details(serde_json::json!({
            "durationMs": validation_started.elapsed().as_millis().min(i64::MAX as u128) as i64,
            "validSourceCount": valid_sources.len(),
            "sourceCount": finished.sources.len(),
        })),
    )
    .await;

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
        #[cfg(test)]
        note_transcription_benchmark::record_processing_dequeued(&task_session_id);
        add_latency_checkpoint(
            &task_repos,
            &task_session_id,
            "processing_dequeued",
            timing.checkpoint_details(serde_json::json!({})),
        )
        .await;
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
        let _ = process_saved_source_audio_with_progress(
            &task_repos,
            &task_note_id,
            &task_session_id,
            task_source_mode,
            valid_sources,
            title,
            existing_generated_note,
            manual_notes,
            timing,
            progress.clone(),
        )
        .await;
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

fn readiness_taxonomy_code(source: &SourceReadinessDto) -> &'static str {
    if source.ready {
        return "ready";
    }
    match source.permission_state.as_str() {
        "unsupported" => "readiness_unsupported",
        "denied" => "permission_denied",
        "restricted" => "permission_restricted",
        _ if !source.device_available => "device_unavailable",
        _ if !source.capture_available => "capture_unavailable",
        _ => "readiness_unknown",
    }
}

fn validation_taxonomy_code(
    validation: &crate::domain::types::AudioValidationDto,
    valid: bool,
) -> &'static str {
    if valid {
        return "valid";
    }
    if !validation.file_exists {
        return "missing_file";
    }
    if !validation.non_zero_size {
        return "empty_file";
    }
    if !validation.readable_audio {
        return "unreadable_wav";
    }
    if validation.recorded_silence {
        return "recorded_silence";
    }
    if !validation.duration_within_tolerance {
        return "duration_mismatch";
    }
    "validation_unknown"
}

fn recording_source_readiness(source_mode: RecordingSourceMode) -> RecordingSourceReadinessDto {
    let (microphone_state, microphone_hint) = microphone_permission_state();
    // TCC grants are bundle-scoped, so the dictation helper's grant never
    // covers the main app. `not_determined` (and the defensive `unknown`)
    // must stay startable: the start path triggers the main app's own TCC
    // prompt, and blocking here would leave a fresh install with no way to
    // ever produce that prompt.
    let microphone_permission_blocked =
        matches!(microphone_state.as_str(), "denied" | "restricted");
    let microphone_device_available = microphone_device_available();
    let microphone_ready = !microphone_permission_blocked && microphone_device_available;
    let microphone_message = if microphone_permission_blocked {
        microphone_hint.clone()
    } else if !microphone_device_available {
        Some(microphone_device_hint())
    } else {
        None
    };
    let microphone = SourceReadinessDto {
        source: RecordingSource::Microphone,
        required: true,
        ready: microphone_ready,
        permission_state: microphone_state.clone(),
        device_available: microphone_device_available,
        capture_available: microphone_ready,
        recovery_action: microphone_permission_blocked
            .then(|| "openMicrophoneSettings".to_string()),
        message: microphone_message,
    };
    let mut system = crate::audio::system_audio::system_audio_readiness();
    if should_probe_system_audio_permission(source_mode, system.ready, is_capture_active()) {
        system = apply_system_audio_permission_probe_result(
            system,
            crate::audio::system_audio::helper_permission_check(),
        );
    }

    assemble_recording_source_readiness(microphone, system, source_mode)
}

/// Readiness describes the machine, not the request: the system source is
/// always reported so callers can explain why it is unavailable. Only
/// `required` follows the requested mode, keeping the `start_recording` gate
/// from blocking a microphone-only take on a Mac that cannot capture system
/// audio at all.
fn assemble_recording_source_readiness(
    microphone: SourceReadinessDto,
    mut system: SourceReadinessDto,
    source_mode: RecordingSourceMode,
) -> RecordingSourceReadinessDto {
    system.required = source_mode == RecordingSourceMode::MicrophonePlusSystem;
    let sources = vec![microphone, system];
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

fn should_probe_system_audio_permission(
    source_mode: RecordingSourceMode,
    system_ready: bool,
    capture_active: bool,
) -> bool {
    source_mode == RecordingSourceMode::MicrophonePlusSystem && system_ready && !capture_active
}

fn apply_system_audio_permission_probe_result(
    mut system: SourceReadinessDto,
    result: Result<(), AppError>,
) -> SourceReadinessDto {
    match result {
        Ok(()) => {
            system.permission_state = "granted".to_string();
        }
        Err(error) => {
            system.ready = false;
            system.capture_available = false;
            match error.code.as_str() {
                "system_audio_permission_denied" => {
                    system.permission_state = "denied".to_string();
                    system.recovery_action = Some("openSystemAudioSettings".to_string());
                }
                "system_audio_capture_unavailable" => {
                    system.permission_state = "granted".to_string();
                    system.recovery_action = Some("restartApp".to_string());
                }
                _ => {
                    system.permission_state = "unknown".to_string();
                    system.recovery_action = Some("restartApp".to_string());
                }
            }
            system.message = Some(error.message);
        }
    }
    system
}

#[tauri::command]
pub async fn retry_processing(
    app: AppHandle,
    request: RetryProcessingRequest,
) -> Result<NoteDto, AppError> {
    let paths = app_paths(&app)?;
    let repos = repositories(&app).await?;
    let sources = retry_audio_sources(
        &repos,
        &paths,
        &request.note_id,
        request.recording_session_id.as_deref(),
    )
    .await?;
    let (ticket, depth) = processing_queue::enqueue(&request.note_id);
    if depth <= 1 {
        repos
            .set_note_status(&request.note_id, ProcessingStatus::Transcribing, None)
            .await?;
    }

    let mut note = repos.get_note(&request.note_id).await?;
    note.queued_recordings = processing_queue::queued_behind(&request.note_id);

    let task_repos = repos.clone();
    let task_note_id = request.note_id.clone();
    let task_recording_session_id = sources
        .first()
        .map(
            |(_id, _source, _path, recording_session_id, _recorded_silence)| {
                recording_session_id.clone()
            },
        )
        .unwrap_or_default();
    let task_source_mode = repos
        .recording_session_source_mode(&task_recording_session_id)
        .await?
        .unwrap_or(RecordingSourceMode::MicrophoneOnly);
    let progress = note_processing_progress_reporter(&app);
    tokio::spawn(async move {
        let queue_lock = ticket.lock();
        let _guard = queue_lock.lock().await;
        let timing = ProcessingTiming::untracked();
        add_latency_checkpoint(
            &task_repos,
            &task_recording_session_id,
            "processing_dequeued",
            timing.checkpoint_details(serde_json::json!({})),
        )
        .await;
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
        let _ = process_saved_source_audio_with_progress(
            &task_repos,
            &task_note_id,
            &task_recording_session_id,
            task_source_mode,
            sources
                .into_iter()
                .map(|(id, source, path, _session_id, recorded_silence)| {
                    (id, source, path, recorded_silence)
                })
                .collect(),
            title,
            existing_generated_note,
            manual_notes,
            timing,
            progress.clone(),
        )
        .await;
        ticket.finish();
    });
    Ok(note)
}

async fn retry_audio_sources(
    repos: &Repositories,
    paths: &AppPaths,
    note_id: &str,
    recording_session_id: Option<&str>,
) -> Result<Vec<(String, String, PathBuf, String, bool)>, AppError> {
    let source_rows = match recording_session_id {
        Some(session_id) => {
            repos
                .valid_audio_artifact_paths_for_session(note_id, session_id)
                .await?
        }
        None => repos.latest_valid_audio_artifact_paths(note_id).await?,
    };
    let mut sources = Vec::with_capacity(source_rows.len());
    for (id, source, path, session_id, recorded_silence) in source_rows {
        let path = paths.contained_recording_file(path).map_err(|_| {
            AppError::new(
                "audio_artifact_missing",
                format!(
                    "The saved {source} audio for this recording is unavailable. No transcript was changed."
                ),
            )
        })?;
        sources.push((id, source, path, session_id, recorded_silence));
    }
    if sources.is_empty() {
        return Err(AppError::new(
            "audio_artifact_missing",
            "No saved audio is available for retry.",
        ));
    }
    Ok(sources)
}

#[tauri::command]
pub async fn recover_recording(
    app: AppHandle,
    request: crate::domain::types::RecoverRecordingRequest,
) -> Result<NoteDto, AppError> {
    let paths = app_paths(&app)?;
    let repos = repositories(&app).await?;
    let progress = note_processing_progress_reporter(&app);
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
            let expected_duration_ms =
                recovery_validation_expected_duration_ms(&path, artifact.expected_duration_ms);
            let validation = validate_audio_artifact(
                &path,
                expected_duration_ms,
                AudioValidationConfig::default(),
            )
            .map_err(|error| AppError::new("audio_validation_failed", error.to_string()))?;
            let checksum = checksum_file(&path).unwrap_or_default();
            let file_size = std::fs::metadata(&path)
                .map(|metadata| metadata.len() as i64)
                .unwrap_or_default();
            let recovered_path = path.to_string_lossy().into_owned();
            let source = RecordingSource::from(artifact.source.as_str());
            let valid = source_audio_passes_validation(source, &validation);
            repos
                .finalize_source_artifact(
                    &artifact.id,
                    &recovered_path,
                    if valid { "valid" } else { "invalid" },
                    validation.actual_duration_ms,
                    file_size,
                    &checksum,
                    expected_duration_ms,
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
                    artifact.id,
                    artifact.source,
                    path,
                    validation.recorded_silence,
                ));
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
        repos
            .mark_recording_recovery_valid(&info.session_id)
            .await?;
        return process_recovered_source_audio(
            &repos,
            &info.note_id,
            &info.session_id,
            info.source_mode,
            valid_sources,
            progress,
        )
        .await;
    }
    let path = recovery_audio_path(&paths, &info).ok_or_else(|| {
        AppError::new(
            "audio_artifact_missing",
            "No recoverable audio bytes are available.",
        )
    })?;
    let expected_elapsed_ms =
        recovery_validation_expected_duration_ms(&path, info.expected_elapsed_ms);
    let validation =
        validate_audio_artifact(&path, expected_elapsed_ms, AudioValidationConfig::default())
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
            expected_elapsed_ms,
            Some(file_size),
            Some(validation.actual_duration_ms),
            Some(checksum.clone()),
            Some(validation.peak_amplitude),
            Some(validation.rms_amplitude),
            Some(serde_json::to_string(&validation).unwrap_or_default()),
            if source_audio_passes_validation(RecordingSource::Microphone, &validation) {
                None
            } else {
                Some(validation.warnings.join("; "))
            },
        )
        .await?;
    if !source_audio_passes_validation(RecordingSource::Microphone, &validation) {
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
    process_recovered_source_audio(
        &repos,
        &info.note_id,
        &info.session_id,
        RecordingSourceMode::MicrophoneOnly,
        vec![(
            artifact.id,
            RecordingSource::Microphone.as_db().to_string(),
            path,
            validation.recorded_silence,
        )],
        progress,
    )
    .await
}

async fn process_recovered_source_audio(
    repos: &Repositories,
    note_id: &str,
    session_id: &str,
    source_mode: RecordingSourceMode,
    sources: Vec<crate::domain::processing::SourceAudioForProcessing>,
    progress: NoteProcessingProgressReporter,
) -> Result<NoteDto, AppError> {
    let (ticket, _depth) = processing_queue::enqueue(note_id);
    let queue_lock = ticket.lock();
    let _guard = queue_lock.lock().await;
    let note = match repos.get_note(note_id).await {
        Ok(note) => note,
        Err(error) => {
            ticket.finish();
            return Err(error.into());
        }
    };
    let result = process_saved_source_audio_with_progress(
        repos,
        note_id,
        session_id,
        source_mode,
        sources,
        note.title.clone(),
        note.generated_content.clone(),
        manual_notes_for_generation(&note),
        ProcessingTiming::untracked(),
        progress.clone(),
    )
    .await;
    ticket.finish();
    result
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

fn recovery_validation_expected_duration_ms(path: &Path, stored_duration_ms: i64) -> i64 {
    if stored_duration_ms > 1 {
        return stored_duration_ms;
    }
    // Pending source rows persist expected_duration_ms = 0, so the expectation
    // is derived from the WAV itself. Repair a stale header first — otherwise a
    // SIGKILLed long capture yields a short expected duration that its own
    // repaired (true) duration then fails as "stale long audio".
    let _ = crate::audio::validation::repair_stale_wav_header_in_place(path);
    wav_duration_ms(path).unwrap_or_else(|| stored_duration_ms.max(1))
}

fn wav_duration_ms(path: &Path) -> Option<i64> {
    let reader = hound::WavReader::open(path).ok()?;
    let sample_rate = reader.spec().sample_rate.max(1) as i64;
    let duration_ms = (reader.duration() as i64 * 1000) / sample_rate;
    (duration_ms > 0).then_some(duration_ms)
}

// ---- Private sharing (JUN-308) -----------------------------------------
// Thin proxies to the june-api /v1/shares endpoints plus the local key
// store. All crypto happens in the webview; these commands only move
// ciphertext, envelopes, metadata, and locally persisted key bytes.

#[tauri::command]
pub async fn share_create(request: ShareCreateRequest) -> Result<ShareCreatedDto, AppError> {
    crate::june_api::share_create(&request).await
}

#[tauri::command]
pub async fn share_list() -> Result<Vec<ShareSummaryDto>, AppError> {
    crate::june_api::share_list().await
}

#[tauri::command]
pub async fn share_get(request: ShareGetRequest) -> Result<ShareDto, AppError> {
    crate::june_api::share_get(&request.share_id).await
}

#[tauri::command]
pub async fn share_add_invites(
    request: ShareAddInvitesRequest,
) -> Result<ShareInvitesAddedDto, AppError> {
    crate::june_api::share_add_invites(&request.share_id, &request.invites).await
}

#[tauri::command]
pub async fn share_revoke_invite(request: ShareRevokeInviteRequest) -> Result<(), AppError> {
    crate::june_api::share_revoke_invite(&request.share_id, &request.invite_id).await
}

#[tauri::command]
pub async fn share_delete(app: AppHandle, request: ShareDeleteRequest) -> Result<(), AppError> {
    delete_remote_share_or_accept_missing(&request.share_id).await?;
    // The share is gone server-side; its locally retained keys are useless
    // and should not outlive it.
    repositories(&app)
        .await?
        .delete_share_keys(&request.share_id)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn share_key_save(app: AppHandle, request: ShareKeySaveRequest) -> Result<(), AppError> {
    let content_key = decode_share_key_b64(&request.content_key_b64)?;
    repositories(&app)
        .await?
        .save_share_key(&crate::db::repositories::ShareKeyRecord {
            share_id: request.share_id,
            item_kind: request.item_kind,
            item_id: request.item_id,
            content_key,
        })
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn share_key_get(
    app: AppHandle,
    request: ShareKeyGetRequest,
) -> Result<Option<ShareKeyDto>, AppError> {
    let record = repositories(&app)
        .await?
        .share_key_for_item(&request.item_kind, &request.item_id)
        .await?;
    Ok(record.map(|record| ShareKeyDto {
        share_id: record.share_id,
        content_key_b64: encode_share_key_b64(&record.content_key),
    }))
}

#[tauri::command]
pub async fn share_invite_key_save(
    app: AppHandle,
    request: ShareInviteKeySaveRequest,
) -> Result<(), AppError> {
    let invite_key = decode_share_key_b64(&request.invite_key_b64)?;
    repositories(&app)
        .await?
        .save_share_invite_key(&crate::db::repositories::ShareInviteKeyRecord {
            invite_id: request.invite_id,
            share_id: request.share_id,
            invite_key,
        })
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn share_invite_keys_get(
    app: AppHandle,
    request: ShareInviteKeysGetRequest,
) -> Result<Vec<ShareInviteKeyDto>, AppError> {
    let records = repositories(&app)
        .await?
        .share_invite_keys(&request.share_id)
        .await?;
    Ok(records
        .into_iter()
        .map(|record| ShareInviteKeyDto {
            invite_id: record.invite_id,
            invite_key_b64: encode_share_key_b64(&record.invite_key),
        })
        .collect())
}

/// Origin share links point at; the webview assembles the full link
/// (including the key-carrying fragment, which must never reach Rust logs).
#[tauri::command]
pub fn get_share_base_url() -> Result<String, AppError> {
    Ok(crate::june_api::share_base_url())
}

fn decode_share_key_b64(value: &str) -> Result<Vec<u8>, AppError> {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value.trim())
        .map_err(|_| AppError::new("share_key_invalid", "Share key is not valid base64url."))
}

fn encode_share_key_b64(value: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value)
}

/// Cached app repositories pool. The database path is derived from the app
/// data dir and never changes within a process, so the pool (and its
/// migrations) are initialized once instead of on every Tauri command.
static REPOSITORIES: OnceCell<Repositories> = OnceCell::const_new();

pub(crate) async fn repositories(app: &AppHandle) -> Result<Repositories, AppError> {
    let paths = app_paths(app)?;
    REPOSITORIES
        .get_or_try_init(|| async {
            let options = sqlite_connect_options(&paths.database_path)
                .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?
                .create_if_missing(true)
                // Recording finalization, transcript persistence, and UI polling
                // legitimately overlap. WAL lets readers observe progress without
                // blocking the durable job transaction (or vice versa).
                .journal_mode(SqliteJournalMode::Wal);
            let pool = sqlite_pool_options(5)
                .connect_with(options)
                .await
                .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?;
            run_migrations(&pool)
                .await
                .map_err(|error| AppError::new("migration_failed", error.to_string()))?;
            match crate::agent_runtime::legacy_import_completed(&pool).await {
                Ok(true) => {}
                Ok(false) | Err(_) => {
                    let legacy_home = paths.data_dir.join("hermes");
                    let user_home = app.path().home_dir().ok();
                    crate::agent_runtime::stop_legacy_hermes_runtime(
                        &legacy_home,
                        user_home.as_deref(),
                    )
                    .await;
                    let legacy_state = legacy_home.join("state.db");
                    let artifact_root = paths.data_dir.join("agent-workspaces");
                    if let Err(error) = crate::agent_runtime::import_legacy_agent_state(
                        &pool,
                        &crate::agent_runtime::LegacyImportOptions {
                            hermes_state_db: legacy_state,
                            hermes_home: Some(legacy_home),
                            artifact_root: Some(artifact_root),
                        },
                    )
                    .await
                    {
                        tracing::warn!(%error, "Legacy agent history import did not complete");
                    }
                }
            }
            Ok(Repositories::new(pool))
        })
        .await
        .cloned()
}

pub(crate) fn active_profile(app: &AppHandle) -> String {
    let _ = app;
    "default".to_string()
}

fn app_paths(app: &AppHandle) -> Result<AppPaths, AppError> {
    let data_dir = crate::app_paths::app_data_dir(app)
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?;
    AppPaths::from_data_dir(data_dir)
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))
}

#[cfg(test)]
mod note_transcription_benchmark;

#[cfg(test)]
mod retry_audio_source_tests {
    use super::retry_audio_sources;
    use crate::{
        app_paths::AppPaths,
        db::{migrations::run_migrations, repositories::Repositories},
        domain::types::RecordingSourceMode,
    };

    #[tokio::test]
    async fn retry_aborts_when_any_selected_valid_source_file_is_missing() {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("test database");
        run_migrations(&pool).await.expect("migrations");
        let repos = Repositories::new(pool);
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = AppPaths::from_data_dir(temp.path().join("data")).expect("app paths");
        let note = repos.create_note("default", None).await.expect("note");
        let session_id = "retry-missing-source";
        let session_dir = paths
            .recording_session_dir(&note.id, session_id)
            .expect("session path");
        std::fs::create_dir_all(&session_dir).expect("session directory");
        let microphone_path = session_dir.join("microphone.wav");
        let system_path = session_dir.join("system.wav");
        std::fs::write(&microphone_path, b"saved microphone bytes").expect("microphone file");
        repos
            .create_recording_session(
                &note.id,
                session_id,
                RecordingSourceMode::MicrophonePlusSystem,
                &session_dir.join("microphone.partial.wav").to_string_lossy(),
                &microphone_path.to_string_lossy(),
                None,
            )
            .await
            .expect("recording session");
        for (source, path) in [
            ("microphone", microphone_path.as_path()),
            ("system", system_path.as_path()),
        ] {
            let artifact = repos
                .create_pending_source_artifact(
                    &note.id,
                    session_id,
                    source,
                    &session_dir
                        .join(format!("{source}.partial.wav"))
                        .to_string_lossy(),
                    &path.to_string_lossy(),
                )
                .await
                .expect("source artifact");
            repos
                .finalize_source_artifact(
                    &artifact.id,
                    &path.to_string_lossy(),
                    "valid",
                    30_000,
                    1,
                    &format!("{source}-checksum"),
                    30_000,
                    None,
                    None,
                )
                .await
                .expect("finalize source");
        }

        let error = retry_audio_sources(&repos, &paths, &note.id, Some(session_id))
            .await
            .expect_err("missing System WAV must abort the whole retry");
        assert_eq!(error.code, "audio_artifact_missing");
        assert!(error.message.contains("system"));
        assert!(error.message.contains("No transcript was changed"));
    }
}

#[cfg(test)]
mod note_transcription_timing_tests;

#[cfg(test)]
mod sqlite_pool_configuration_tests {
    use super::{sqlite_connect_options, sqlite_pool_options, SQLITE_ACQUIRE_TIMEOUT};
    use sqlx::query::query;
    use sqlx_sqlite::SqliteJournalMode;
    use std::time::Duration;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn contending_writer_waits_for_the_lock_and_succeeds() {
        let temp = tempfile::tempdir().expect("tempdir");
        let database_path = temp.path().join("contention.sqlite3");
        let options = sqlite_connect_options(&database_path)
            .expect("SQLite options")
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal);
        let pool_options = sqlite_pool_options(2);
        assert_eq!(pool_options.get_acquire_timeout(), SQLITE_ACQUIRE_TIMEOUT);
        let pool = pool_options
            .connect_with(options)
            .await
            .expect("contention database");

        query("CREATE TABLE writes (value TEXT NOT NULL)")
            .execute(&pool)
            .await
            .expect("create writes table");
        let mut first_writer = pool.acquire().await.expect("first writer connection");
        let mut second_writer = pool.acquire().await.expect("second writer connection");

        query("BEGIN IMMEDIATE")
            .execute(&mut *first_writer)
            .await
            .expect("begin first write transaction");
        query("INSERT INTO writes (value) VALUES ('first')")
            .execute(&mut *first_writer)
            .await
            .expect("first write");

        let (attempted_tx, attempted_rx) = tokio::sync::oneshot::channel();
        let waiting_writer = tokio::spawn(async move {
            let _ = attempted_tx.send(());
            query("INSERT INTO writes (value) VALUES ('second')")
                .execute(&mut *second_writer)
                .await
        });
        attempted_rx.await.expect("second writer should start");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !waiting_writer.is_finished(),
            "the second writer should wait while the first holds the SQLite write lock"
        );

        query("COMMIT")
            .execute(&mut *first_writer)
            .await
            .expect("commit first write transaction");
        tokio::time::timeout(Duration::from_secs(1), waiting_writer)
            .await
            .expect("second writer should finish within the busy timeout")
            .expect("second writer task")
            .expect("second write should succeed after the lock is released");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_system_audio_permission_probe_result, assemble_recording_source_readiness,
        capture_start_timeout_error, copy_directory, copy_directory_contents,
        create_memory_with_settings, delete_profile_records_with_share_revoker, is_share_not_found,
        load_memory_settings, persist_memory_settings, recovery_validation_expected_duration_ms,
        replace_directory_from_staging, should_probe_system_audio_permission,
        start_capture_with_timeout_and_cleanup, update_memory_with_settings,
        validated_folder_instructions, CaptureStartupGuard, MEMORY_SETTINGS_LOCK,
    };

    #[test]
    fn recognizes_only_the_ambiguous_share_not_found_error() {
        assert!(is_share_not_found(&AppError::new(
            "june_request_failed",
            "share_not_found"
        )));
        assert!(!is_share_not_found(&AppError::new(
            "june_request_failed",
            "network error"
        )));
        assert!(!is_share_not_found(&AppError::new(
            "storage_unavailable",
            "share_not_found"
        )));
    }
    use crate::{
        app_paths::AppPaths,
        audio::capture::{is_capture_active, CaptureStartState, StartedRecording, StartedSource},
        db::repositories::{Repositories, ShareKeyRecord},
        domain::types::{
            AppError, AudioLevelDto, MemorySettingsDto, RecordingSource, RecordingSourceMode,
            RecordingState, RecordingStatusDto, SourceReadinessDto,
        },
    };
    use std::{
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
        time::Duration,
    };

    #[cfg(unix)]
    #[test]
    fn bundled_extension_copy_skips_symlinks() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("tempdir");
        let source = root.path().join("source");
        let staging = root.path().join("staging");
        let outside = root.path().join("outside.js");
        std::fs::create_dir(&source).expect("create source");
        std::fs::write(source.join("manifest.json"), b"{}").expect("write source file");
        std::fs::write(&outside, b"outside").expect("write outside file");
        symlink(&outside, source.join("linked.js")).expect("create source symlink");

        copy_directory(&source, &staging).expect("copy extension");

        assert!(staging.join("manifest.json").is_file());
        assert!(!staging.join("linked.js").exists());
    }

    #[test]
    fn bundled_extension_copy_rejects_destination_outside_staging() {
        let root = tempfile::tempdir().expect("tempdir");
        let source = root.path().join("source");
        let staging = root.path().join("staging");
        let outside = root.path().join("outside");
        std::fs::create_dir(&source).expect("create source");
        std::fs::create_dir(&staging).expect("create staging");
        std::fs::create_dir(&outside).expect("create outside");
        std::fs::write(source.join("manifest.json"), b"{}").expect("write source file");

        let error = copy_directory_contents(
            &source,
            &outside,
            &staging.canonicalize().expect("canonical staging"),
        )
        .expect_err("outside destination must fail");

        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(!outside.join("manifest.json").exists());
    }

    #[test]
    fn bundled_extension_replace_restores_backup_when_promotion_fails() {
        let root = tempfile::tempdir().expect("tempdir");
        let destination = root.path().join("extension-unpacked");
        let staging = root.path().join("extension-unpacked.tmp");
        std::fs::create_dir(&destination).expect("create destination");
        std::fs::create_dir(&staging).expect("create staging");
        std::fs::write(destination.join("old.js"), b"old").expect("write old extension");
        std::fs::write(staging.join("new.js"), b"new").expect("write new extension");

        let mut rename_calls = 0;
        let error = replace_directory_from_staging(&staging, &destination, |from, to| {
            rename_calls += 1;
            if rename_calls == 2 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "simulated promotion failure",
                ));
            }
            std::fs::rename(from, to)
        })
        .expect_err("promotion must fail");

        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(rename_calls, 3);
        assert!(destination.join("old.js").is_file());
        assert!(!destination.join("new.js").exists());
        assert!(staging.join("new.js").is_file());
        assert!(!root.path().join("extension-unpacked.backup").exists());
    }

    async fn test_repositories() -> Repositories {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("sqlite memory");
        crate::db::migrations::run_migrations(&pool)
            .await
            .expect("migrations");
        Repositories::new(pool)
    }

    #[tokio::test]
    async fn profile_record_deletion_revokes_note_shares_before_removing_rows() {
        let repos = test_repositories().await;
        let profile_note = repos
            .create_note("research", None)
            .await
            .expect("create profile note");
        let default_note = repos
            .create_note("default", None)
            .await
            .expect("create default note");
        let profile_share = ShareKeyRecord {
            share_id: "share-research".to_string(),
            item_kind: "note".to_string(),
            item_id: profile_note.id.clone(),
            content_key: vec![1; 32],
        };
        let default_share = ShareKeyRecord {
            share_id: "share-default".to_string(),
            item_kind: "note".to_string(),
            item_id: default_note.id.clone(),
            content_key: vec![2; 32],
        };
        repos
            .save_share_key(&profile_share)
            .await
            .expect("save profile share");
        repos
            .save_share_key(&default_share)
            .await
            .expect("save default share");
        let revoked = Arc::new(Mutex::new(Vec::new()));
        let revoked_for_call = Arc::clone(&revoked);

        let audio_paths =
            delete_profile_records_with_share_revoker(&repos, "research", move |share_id| {
                let revoked = Arc::clone(&revoked_for_call);
                async move {
                    revoked.lock().expect("revoked lock").push(share_id);
                    Ok(())
                }
            })
            .await
            .expect("delete profile records");

        assert!(audio_paths.is_empty());
        assert_eq!(
            *revoked.lock().expect("revoked lock"),
            vec!["share-research".to_string()]
        );
        assert!(repos.get_note(&profile_note.id).await.is_err());
        assert!(repos
            .share_key_for_item("note", &profile_note.id)
            .await
            .expect("profile share lookup")
            .is_none());
        assert_eq!(
            repos
                .share_key_for_item("note", &default_note.id)
                .await
                .expect("default share lookup"),
            Some(default_share)
        );
        repos
            .get_note(&default_note.id)
            .await
            .expect("default note remains");
    }

    #[tokio::test]
    async fn profile_record_deletion_keeps_rows_and_keys_when_share_revocation_fails() {
        let repos = test_repositories().await;
        let note = repos
            .create_note("research", None)
            .await
            .expect("create profile note");
        let share = ShareKeyRecord {
            share_id: "share-research".to_string(),
            item_kind: "note".to_string(),
            item_id: note.id.clone(),
            content_key: vec![1; 32],
        };
        repos
            .save_share_key(&share)
            .await
            .expect("save profile share");

        let error = delete_profile_records_with_share_revoker(&repos, "research", |_| async {
            Err(AppError::new("june_request_failed", "network error"))
        })
        .await
        .expect_err("failed revocation must keep local data");

        assert_eq!(error.code, "june_request_failed");
        repos
            .get_note(&note.id)
            .await
            .expect("profile note remains");
        assert_eq!(
            repos
                .share_key_for_item("note", &note.id)
                .await
                .expect("profile share lookup"),
            Some(share)
        );
    }

    #[test]
    fn memory_settings_loader_defaults_enabled_only_when_file_is_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("memory-settings.json");

        assert!(load_memory_settings(&path).enabled);

        std::fs::write(&path, r#"{"enabled":false}"#).expect("write valid settings");
        assert!(!load_memory_settings(&path).enabled);

        std::fs::write(&path, b"not json").expect("write corrupt settings");
        assert!(!load_memory_settings(&path).enabled);
    }

    #[test]
    fn memory_settings_persistence_replaces_atomically_and_preserves_previous_file_on_failure() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("memory-settings.json");
        let temporary_path = path.with_extension("json.tmp");

        persist_memory_settings(&path, &MemorySettingsDto { enabled: false })
            .expect("persist settings");
        assert!(!load_memory_settings(&path).enabled);
        assert!(!temporary_path.exists());

        // A second toggle must replace the now-existing file (regression: a
        // bare `fs::rename` does not overwrite on Windows, which stranded the
        // toggle after its first write — persist_memory_settings goes through
        // the platform-aware replace_file wrapper instead).
        persist_memory_settings(&path, &MemorySettingsDto { enabled: true })
            .expect("persist over existing file");
        assert!(load_memory_settings(&path).enabled);
        assert!(!temporary_path.exists());

        std::fs::write(&path, r#"{"enabled":true}"#).expect("restore previous settings");
        std::fs::create_dir(&temporary_path).expect("block temporary file creation");
        let error = persist_memory_settings(&path, &MemorySettingsDto { enabled: false })
            .expect_err("temporary write must fail");

        assert_eq!(error.code, "memory_settings_save_failed");
        assert!(load_memory_settings(&path).enabled);
    }

    #[tokio::test]
    async fn memory_settings_transaction_lock_serializes_awaiting_callers() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        let active = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));
        let mut callers = Vec::new();
        for _ in 0..6 {
            let active = Arc::clone(&active);
            let max_seen = Arc::clone(&max_seen);
            callers.push(tokio::spawn(async move {
                let _guard = MEMORY_SETTINGS_LOCK.lock().await;
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                max_seen.fetch_max(now, Ordering::SeqCst);
                // The production command holds this same guard across its
                // enforcement awaits; force scheduling here to catch a lock
                // that no longer protects the full asynchronous transaction.
                tokio::task::yield_now().await;
                active.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for caller in callers {
            caller.await.expect("memory settings caller");
        }

        assert_eq!(max_seen.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn create_memory_enforces_global_and_folder_disable_matrix() {
        for global_enabled in [false, true] {
            for folder_disabled in [false, true] {
                for folder_scoped in [false, true] {
                    let repos = test_repositories().await;
                    let folder = repos
                        .create_folder("default", "Project", None)
                        .await
                        .expect("create folder");
                    repos
                        .set_folder_memory_disabled(&folder.id, folder_disabled)
                        .await
                        .expect("set folder memory state");
                    let dir = tempfile::tempdir().expect("tempdir");
                    let settings_path = dir.path().join("memory-settings.json");
                    std::fs::write(
                        &settings_path,
                        serde_json::json!({ "enabled": global_enabled }).to_string(),
                    )
                    .expect("write settings");

                    let result = create_memory_with_settings(
                        &repos,
                        &settings_path,
                        "default",
                        folder_scoped.then_some(folder.id.as_str()),
                        "Remember this",
                        "user",
                    )
                    .await;
                    let should_reject = !global_enabled || (folder_scoped && folder_disabled);

                    if should_reject {
                        assert_eq!(
                            result.expect_err("create must be rejected").code,
                            "memory_disabled"
                        );
                    } else {
                        let created = result.expect("create must succeed");
                        assert_eq!(
                            created.folder_id.as_deref(),
                            folder_scoped.then_some(folder.id.as_str())
                        );
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn update_memory_rejects_content_in_a_disabled_folder() {
        let repos = test_repositories().await;
        let folder = repos
            .create_folder("default", "Project", None)
            .await
            .expect("create folder");
        let memory = repos
            .create_memory("default", Some(&folder.id), "Original", "user")
            .await
            .expect("create memory");
        repos
            .set_folder_memory_disabled(&folder.id, true)
            .await
            .expect("disable folder memory");
        let dir = tempfile::tempdir().expect("tempdir");
        let settings_path = dir.path().join("memory-settings.json");

        let error = update_memory_with_settings(
            &repos,
            &settings_path,
            "default",
            &memory.id,
            "Replacement",
        )
        .await
        .expect_err("update must be rejected");

        assert_eq!(error.code, "memory_disabled");
        let unchanged = repos
            .list_memories("default", Some(&folder.id), false)
            .await
            .expect("list memory");
        assert_eq!(unchanged[0].content, "Original");
    }

    #[tokio::test]
    async fn update_memory_rejects_all_content_when_memory_is_globally_disabled() {
        let repos = test_repositories().await;
        let memory = repos
            .create_memory("default", None, "Original", "user")
            .await
            .expect("create memory");
        let dir = tempfile::tempdir().expect("tempdir");
        let settings_path = dir.path().join("memory-settings.json");
        std::fs::write(&settings_path, r#"{"enabled":false}"#).expect("disable memory");

        let error = update_memory_with_settings(
            &repos,
            &settings_path,
            "default",
            &memory.id,
            "Replacement",
        )
        .await
        .expect_err("update must be rejected");

        assert_eq!(error.code, "memory_disabled");
        let unchanged = repos
            .list_memories("default", None, false)
            .await
            .expect("list global memory");
        assert_eq!(unchanged[0].content, "Original");
    }

    #[test]
    fn folder_instructions_enforce_character_limit_after_trimming() {
        let boundary = format!("  {}  ", "x".repeat(4_000));
        assert_eq!(
            validated_folder_instructions(Some(&boundary))
                .expect("4,000 characters must be accepted")
                .expect("instructions"),
            "x".repeat(4_000)
        );

        let error = validated_folder_instructions(Some(&"x".repeat(4_001)))
            .expect_err("4,001 characters must be rejected");
        assert_eq!(error.code, "folder_instructions_too_long");
    }

    #[test]
    fn skips_system_audio_permission_probe_while_capture_is_active() {
        assert!(!should_probe_system_audio_permission(
            RecordingSourceMode::MicrophonePlusSystem,
            true,
            true
        ));
    }

    #[test]
    fn probes_system_audio_permission_only_when_available_and_idle() {
        assert!(should_probe_system_audio_permission(
            RecordingSourceMode::MicrophonePlusSystem,
            true,
            false
        ));
        assert!(!should_probe_system_audio_permission(
            RecordingSourceMode::MicrophonePlusSystem,
            false,
            false
        ));
    }

    #[test]
    fn system_audio_permission_probe_is_skipped_for_microphone_only() {
        assert!(!should_probe_system_audio_permission(
            RecordingSourceMode::MicrophoneOnly,
            true,
            false
        ));
    }

    #[test]
    fn microphone_only_readiness_still_reports_the_system_source() {
        let readiness = assemble_recording_source_readiness(
            microphone_readiness(),
            unsupported_system_readiness(),
            RecordingSourceMode::MicrophoneOnly,
        );
        let system = readiness
            .sources
            .iter()
            .find(|source| source.source == RecordingSource::System)
            .expect("system readiness");

        assert_eq!(system.permission_state, "unsupported");
        assert!(!system.required);
    }

    #[test]
    fn microphone_only_readiness_stays_ready_when_system_is_unsupported() {
        let readiness = assemble_recording_source_readiness(
            microphone_readiness(),
            unsupported_system_readiness(),
            RecordingSourceMode::MicrophoneOnly,
        );

        assert!(readiness.ready);
    }

    #[test]
    fn microphone_plus_system_keeps_the_system_source_required() {
        let readiness = assemble_recording_source_readiness(
            microphone_readiness(),
            unsupported_system_readiness(),
            RecordingSourceMode::MicrophonePlusSystem,
        );
        let system = readiness
            .sources
            .iter()
            .find(|source| source.source == RecordingSource::System)
            .expect("system readiness");

        assert!(system.required);
        assert!(!readiness.ready);
    }

    #[test]
    fn successful_system_audio_permission_probe_reports_granted() {
        let readiness = apply_system_audio_permission_probe_result(system_readiness(), Ok(()));

        assert!(readiness.ready);
        assert_eq!(readiness.permission_state, "granted");
        assert!(readiness.capture_available);
    }

    #[test]
    fn failed_system_audio_permission_probe_blocks_capture() {
        let readiness = apply_system_audio_permission_probe_result(
            system_readiness(),
            Err(AppError::new(
                "system_audio_permission_denied",
                "Grant access.",
            )),
        );

        assert!(!readiness.ready);
        assert_eq!(readiness.permission_state, "denied");
        assert!(!readiness.capture_available);
        assert_eq!(readiness.message.as_deref(), Some("Grant access."));
    }

    #[test]
    fn failed_system_audio_capture_probe_keeps_permission_granted() {
        let readiness = apply_system_audio_permission_probe_result(
            system_readiness(),
            Err(AppError::new(
                "system_audio_capture_unavailable",
                "Failed to create audio format for system tap.",
            )),
        );

        assert!(!readiness.ready);
        assert_eq!(readiness.permission_state, "granted");
        assert!(!readiness.capture_available);
        assert_eq!(readiness.recovery_action.as_deref(), Some("restartApp"));
        assert_eq!(
            readiness.message.as_deref(),
            Some("Failed to create audio format for system tap.")
        );
    }

    #[tokio::test]
    async fn capture_published_just_before_timeout_is_returned_as_success() {
        let result = start_capture_with_timeout_and_cleanup(
            move |handshake| {
                // Commit the publish (as the real builder does under the
                // ACTIVE_RECORDING lock), then outlive the watchdog timeout
                // before reporting: the watchdog must accept this capture as
                // success rather than strand a live recording behind a
                // timeout error.
                *handshake.lock().expect("handshake lock") = CaptureStartState::Published;
                std::thread::sleep(Duration::from_millis(60));
                Ok(fake_started_recording("published-session"))
            },
            move |_| panic!("published capture must not be torn down as late success"),
            Duration::from_millis(20),
        )
        .await;

        let started = result.expect("published capture is a success, not a timeout");
        assert_eq!(started.session_id, "published-session");
    }

    #[test]
    fn capture_startup_guard_removes_unpublished_audio_after_shutdown() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = AppPaths::from_data_dir(temp.path().join("data")).expect("app paths");
        let session_dir = paths
            .recording_session_dir("note-1", "guard-session")
            .expect("session dir");
        std::fs::create_dir_all(&session_dir).expect("create session dir");
        let partial_path = session_dir.join("microphone.partial.wav");
        let final_path = session_dir.join("microphone.wav");
        std::fs::write(&partial_path, b"partial audio").expect("write partial audio");
        std::fs::write(&final_path, b"final audio").expect("write final audio");
        let mut started = fake_started_recording("guard-session");
        started.partial_path = partial_path.clone();
        started.final_path = final_path.clone();
        started.sources[0].partial_path = partial_path.clone();
        started.sources[0].final_path = final_path.clone();

        let mut guard = CaptureStartupGuard::new(&paths, &started);
        guard.rollback_with(|session_id| {
            assert_eq!(session_id, "guard-session");
            Ok(())
        });

        assert!(!partial_path.exists());
        assert!(!final_path.exists());
    }

    #[test]
    fn capture_startup_guard_preserves_audio_when_shutdown_fails() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = AppPaths::from_data_dir(temp.path().join("data")).expect("app paths");
        let session_dir = paths
            .recording_session_dir("note-1", "guard-session")
            .expect("session dir");
        std::fs::create_dir_all(&session_dir).expect("create session dir");
        let partial_path = session_dir.join("microphone.partial.wav");
        let final_path = session_dir.join("microphone.wav");
        std::fs::write(&partial_path, b"partial audio").expect("write partial audio");
        std::fs::write(&final_path, b"final audio").expect("write final audio");
        let mut started = fake_started_recording("guard-session");
        started.partial_path = partial_path.clone();
        started.final_path = final_path.clone();
        started.sources[0].partial_path = partial_path.clone();
        started.sources[0].final_path = final_path.clone();

        let mut guard = CaptureStartupGuard::new(&paths, &started);
        guard.rollback_with(|_| {
            Err(AppError::new(
                "recording_stop_failed",
                "Capture shutdown was not confirmed.",
            ))
        });

        assert!(partial_path.exists());
        assert!(final_path.exists());
    }

    #[tokio::test]
    async fn capture_start_timeout_returns_timeout_without_registering_active_capture() {
        let builder_saw_abandoned = Arc::new(AtomicBool::new(false));
        let registered = Arc::new(AtomicBool::new(false));
        let cleanup_called = Arc::new(AtomicBool::new(false));
        let builder_saw_abandoned_for_thread = Arc::clone(&builder_saw_abandoned);
        let registered_for_thread = Arc::clone(&registered);
        let cleanup_called_for_thread = Arc::clone(&cleanup_called);

        let result = start_capture_with_timeout_and_cleanup(
            move |abandoned| {
                while *abandoned.lock().expect("handshake lock") != CaptureStartState::Abandoned {
                    std::thread::sleep(Duration::from_millis(2));
                }
                builder_saw_abandoned_for_thread.store(true, Ordering::Release);
                if *abandoned.lock().expect("handshake lock") != CaptureStartState::Abandoned {
                    registered_for_thread.store(true, Ordering::Release);
                    return Ok(fake_started_recording("late-session"));
                }
                Err(capture_start_timeout_error())
            },
            move |_| {
                cleanup_called_for_thread.store(true, Ordering::Release);
            },
            Duration::from_millis(20),
        )
        .await;

        let error = match result {
            Ok(_) => panic!("start should time out"),
            Err(error) => error,
        };
        assert_eq!(error.code, "capture_start_timeout");
        wait_until(|| builder_saw_abandoned.load(Ordering::Acquire));
        assert!(!registered.load(Ordering::Acquire));
        assert!(!cleanup_called.load(Ordering::Acquire));
        assert!(!is_capture_active());
    }

    #[tokio::test]
    async fn late_capture_start_success_is_cleaned_up_after_timeout() {
        let active_session = Arc::new(Mutex::new(None::<String>));
        let cleanup_called = Arc::new(AtomicBool::new(false));
        let active_session_for_builder = Arc::clone(&active_session);
        let active_session_for_cleanup = Arc::clone(&active_session);
        let cleanup_called_for_thread = Arc::clone(&cleanup_called);

        let result = start_capture_with_timeout_and_cleanup(
            move |abandoned| {
                // Return only after the timeout has demonstrably fired; a
                // fixed sleep races the timeout under machine load.
                while *abandoned.lock().expect("handshake lock") != CaptureStartState::Abandoned {
                    std::thread::sleep(Duration::from_millis(2));
                }
                let started = fake_started_recording("late-session");
                *active_session_for_builder
                    .lock()
                    .expect("active session lock") = Some(started.session_id.clone());
                Ok(started)
            },
            move |started| {
                let mut active = active_session_for_cleanup
                    .lock()
                    .expect("active session lock");
                if active.as_deref() == Some(started.session_id.as_str()) {
                    *active = None;
                }
                cleanup_called_for_thread.store(true, Ordering::Release);
            },
            Duration::from_millis(20),
        )
        .await;

        let error = match result {
            Ok(_) => panic!("start should time out"),
            Err(error) => error,
        };
        assert_eq!(error.code, "capture_start_timeout");
        wait_until(|| cleanup_called.load(Ordering::Acquire));
        assert_eq!(*active_session.lock().expect("active session lock"), None);
        assert!(!is_capture_active());
    }

    #[test]
    fn recovered_wav_duration_overrides_stale_stored_duration() {
        let (_dir, path) = write_one_second_wav();

        assert_eq!(recovery_validation_expected_duration_ms(&path, 0), 1_000);
        assert_eq!(recovery_validation_expected_duration_ms(&path, 1), 1_000);
    }

    fn system_readiness() -> SourceReadinessDto {
        SourceReadinessDto {
            source: RecordingSource::System,
            required: true,
            ready: true,
            permission_state: "unknown".to_string(),
            device_available: true,
            capture_available: true,
            recovery_action: Some("openSystemAudioSettings".to_string()),
            message: None,
        }
    }

    fn unsupported_system_readiness() -> SourceReadinessDto {
        SourceReadinessDto {
            source: RecordingSource::System,
            required: true,
            ready: false,
            permission_state: "unsupported".to_string(),
            device_available: false,
            capture_available: false,
            recovery_action: Some("upgradeMacos".to_string()),
            message: Some("System audio capture requires macOS 14.2 or later.".to_string()),
        }
    }

    fn microphone_readiness() -> SourceReadinessDto {
        SourceReadinessDto {
            source: RecordingSource::Microphone,
            required: true,
            ready: true,
            permission_state: "granted".to_string(),
            device_available: true,
            capture_available: true,
            recovery_action: None,
            message: None,
        }
    }

    #[test]
    fn recovered_wav_duration_reads_flush_only_wav() {
        let (_dir, path) = write_one_second_flushed_wav();

        assert_eq!(recovery_validation_expected_duration_ms(&path, 0), 1_000);
    }

    #[test]
    fn recovered_wav_duration_repairs_stale_header_before_deriving() {
        use std::io::{Seek, SeekFrom, Write};

        // 10s of samples with a SIGKILL-stale header claiming ~1s. Without an
        // up-front repair the expectation would be ~1s while validation's own
        // repaired duration is 10s, failing the source as stale-long audio.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("partial.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).expect("writer");
        for _ in 0..160_000 {
            writer.write_sample(0_i16).expect("sample");
        }
        writer.finalize().expect("finalize");

        let stale_data_size: u32 = 16_000 * 2;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open");
        // data chunk size field sits at byte 40 for a canonical 16-bit PCM WAV;
        // RIFF size at byte 4.
        file.seek(SeekFrom::Start(4)).expect("seek");
        file.write_all(&(36 + stale_data_size).to_le_bytes())
            .expect("write riff size");
        file.seek(SeekFrom::Start(40)).expect("seek");
        file.write_all(&stale_data_size.to_le_bytes())
            .expect("write data size");
        file.flush().expect("flush");
        drop(file);

        assert_eq!(recovery_validation_expected_duration_ms(&path, 0), 10_000);
    }

    #[test]
    fn recovered_wav_duration_preserves_persisted_expected_duration() {
        let (_dir, path) = write_one_second_wav();

        assert_eq!(
            recovery_validation_expected_duration_ms(&path, 10_000),
            10_000
        );
    }

    #[test]
    fn recovered_duration_falls_back_to_stored_duration_for_unreadable_audio() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("partial.wav");
        std::fs::write(&path, b"not wav").expect("write");

        assert_eq!(
            recovery_validation_expected_duration_ms(&path, 2_500),
            2_500
        );
        assert_eq!(recovery_validation_expected_duration_ms(&path, 0), 1);
    }

    fn write_one_second_wav() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("partial.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).expect("writer");
        for _ in 0..16_000 {
            writer.write_sample(0_i16).expect("sample");
        }
        writer.finalize().expect("finalize");
        (dir, path)
    }

    fn write_one_second_flushed_wav() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("partial.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).expect("writer");
        for _ in 0..16_000 {
            writer.write_sample(0_i16).expect("sample");
        }
        writer.flush().expect("flush");
        std::mem::forget(writer);
        (dir, path)
    }

    fn fake_started_recording(session_id: &str) -> StartedRecording {
        StartedRecording {
            session_id: session_id.to_string(),
            note_id: "note-1".to_string(),
            source_mode: RecordingSourceMode::MicrophoneOnly,
            partial_path: PathBuf::from("microphone.partial.wav"),
            final_path: PathBuf::from("microphone.wav"),
            sources: vec![StartedSource {
                source: RecordingSource::Microphone,
                partial_path: PathBuf::from("microphone.partial.wav"),
                final_path: PathBuf::from("microphone.wav"),
            }],
            device_label: Some("Test microphone".to_string()),
            status: RecordingStatusDto {
                session_id: session_id.to_string(),
                note_id: Some("note-1".to_string()),
                source_mode: RecordingSourceMode::MicrophoneOnly,
                state: RecordingState::Recording,
                elapsed_ms: 0,
                level: AudioLevelDto::default(),
                silence_warning: false,
                bytes_written: 0,
                live_preview_enabled: false,
                sources: Vec::new(),
                warnings: Vec::new(),
            },
        }
    }

    fn wait_until(condition: impl Fn() -> bool) {
        for _ in 0..50 {
            if condition() {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(condition());
    }
}
