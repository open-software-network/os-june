use super::skill_identity::{
    canonical_skill_id, canonical_skill_ids, read_skill_ids, skill_content_for_id, skill_file,
    write_skill_ids,
};
use super::{
    repository::ContextSummaryReplacement, AgentItemDto, AgentItemPayload, AgentRepository,
    AgentRuntimeHost, AgentSafetyMode, MessageAttachmentPayload,
};
use crate::domain::types::AppError;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Component,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Manager, State};

const INSTRUCTIONS: &str = "You are Clovy, a private personal AI assistant. Use the tools provided by the Clovy app when they help answer the user's request. Never claim a tool succeeded unless its result confirms success. If an MCP tool returns elicitationRequired, call request_clarification with its clarificationQuestion exactly, then retry the same MCP tool after the user answers.";
const MAX_INLINE_VISION_BYTES: i64 = 6 * 1024 * 1024;
const AGENT_MODEL_OUTPUT_RESERVE: i64 = 8_192;
const MAX_STAGED_AGENT_ATTACHMENT_BYTES: usize = 50 * 1024 * 1024;
// Composer attachments may remain recoverable across restarts. Reap only
// abandoned UUID staging directories that have been untouched for seven days.
const STAGED_AGENT_ATTACHMENT_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
// Eight legal 50 MiB attachments fit at once, with headroom for one composer
// being abandoned while another begins staging.
const MAX_STAGED_AGENT_ATTACHMENT_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
const MAX_STAGED_AGENT_ATTACHMENT_DIRECTORIES: usize = 128;
const STAGED_AGENT_ATTACHMENTS_DIR: &str = "agent-attachment-staging";
static STAGED_AGENT_ATTACHMENTS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    pub title: Option<String>,
    pub model: String,
    pub safety_mode: AgentSafetyMode,
    #[serde(default = "default_data_partition")]
    pub profile: String,
}

fn default_data_partition() -> String {
    "default".to_string()
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameSessionRequest {
    pub session_id: String,
    pub title: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    pub session_id: String,
    pub prompt: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub safety_mode: AgentSafetyMode,
    pub workspace_path: String,
    #[serde(default)]
    pub enabled_skill_ids: Vec<String>,
    #[serde(default)]
    pub attachments: Vec<String>,
    #[serde(default)]
    pub attachment_metadata: Vec<AttachmentMetadataInput>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMetadataInput {
    pub name: String,
    pub media_type: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveInterruptionRequest {
    pub run_id: String,
    pub interruption_id: String,
    pub resolution: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSkillEnabledRequest {
    pub skill_id: String,
    pub enabled: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSkillRequest {
    pub skill_id: String,
    pub content: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadArtifactRequest {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardStagedAgentAttachmentsRequest {
    pub paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneStagedAgentAttachmentsRequest {
    pub protected_paths: Vec<String>,
}

async fn repository(app: &AppHandle) -> Result<AgentRepository, AppError> {
    Ok(AgentRepository::new(
        crate::commands::repositories(app).await?.pool,
    ))
}

#[tauri::command]
pub async fn list_agent_sessions(app: AppHandle) -> Result<Vec<Value>, AppError> {
    Ok(repository(&app)
        .await?
        .list_sessions()
        .await?
        .into_iter()
        .map(session_json)
        .collect())
}

#[tauri::command]
pub async fn get_agent_session(app: AppHandle, session_id: String) -> Result<Value, AppError> {
    Ok(session_json(
        repository(&app).await?.get_session(&session_id).await?,
    ))
}

#[tauri::command]
pub async fn get_latest_agent_run(
    app: AppHandle,
    session_id: String,
) -> Result<Option<Value>, AppError> {
    let repository = repository(&app).await?;
    let row = sqlx::query::query(
        "SELECT id FROM agent_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(&repository.pool)
    .await?;
    use sqlx::row::Row;
    match row {
        Some(row) => Ok(Some(run_json(
            repository.get_run(&row.get::<String, _>("id")).await?,
        ))),
        None => Ok(None),
    }
}

/// Stages a DOM-dropped attachment until the next agent run copies it into the
/// session workspace. WKWebView exposes a dropped file's bytes, not its local
/// filesystem path, so this command deliberately accepts Tauri's raw payload.
#[tauri::command]
pub fn stage_agent_attachment_bytes(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, AppError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::new(
            "agent_attachment_staging_invalid",
            "Expected the dropped file's contents as a binary payload.",
        ));
    };
    validate_staged_attachment_size(bytes.len())?;
    let raw_name = request
        .headers()
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| urlencoding::decode(value).ok())
        .map(|value| value.into_owned())
        .unwrap_or_default();
    let name = validate_staged_attachment_file_name(&raw_name)?;
    let _guard = STAGED_AGENT_ATTACHMENTS_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| {
            AppError::new(
                "agent_attachment_staging_failed",
                "The attachment staging lock is unavailable.",
            )
        })?;
    let root = staged_agent_attachments_root(&app)?;
    prepare_staged_agent_attachments_root(&root, bytes.len() as u64)?;
    let parent = root.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&parent).map_err(staging_error)?;
    let destination = parent.join(name);
    if let Err(error) = fs::write(&destination, bytes) {
        let _ = fs::remove_dir_all(&parent);
        return Err(staging_error(error));
    }
    Ok(destination.to_string_lossy().into_owned())
}

/// Removes temporary DOM-drop files after they have been copied into a session
/// workspace. Picker paths and every path outside the staging root are ignored.
#[tauri::command]
pub fn discard_staged_agent_attachments(
    app: AppHandle,
    request: DiscardStagedAgentAttachmentsRequest,
) -> Result<(), AppError> {
    let _guard = STAGED_AGENT_ATTACHMENTS_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| {
            AppError::new(
                "agent_attachment_staging_failed",
                "The attachment staging lock is unavailable.",
            )
        })?;
    let root = staged_agent_attachments_root(&app)?;
    for path in request.paths {
        let Some(parent) = staged_attachment_parent_for_path(&root, Path::new(&path)) else {
            continue;
        };
        match fs::remove_dir_all(parent) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(staging_error(error)),
        }
    }
    Ok(())
}

/// Reaps expired staging directories while preserving exact staged file paths
/// still referenced by live, queued, or recoverable frontend state.
#[tauri::command]
pub fn prune_staged_agent_attachments(
    app: AppHandle,
    request: PruneStagedAgentAttachmentsRequest,
) -> Result<(), AppError> {
    let _guard = STAGED_AGENT_ATTACHMENTS_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| {
            AppError::new(
                "agent_attachment_staging_failed",
                "The attachment staging lock is unavailable.",
            )
        })?;
    let root = staged_agent_attachments_root(&app)?;
    fs::create_dir_all(&root).map_err(staging_error)?;
    let protected = protected_staging_parents(&root, &request.protected_paths);
    prune_expired_staged_agent_attachments(&root, SystemTime::now(), &protected)
}

#[tauri::command]
pub async fn compact_agent_session(
    app: AppHandle,
    host: State<'_, AgentRuntimeHost>,
    session_id: String,
) -> Result<Value, AppError> {
    let repository = repository(&app).await?;
    let session = repository.get_session(&session_id).await?;
    if matches!(
        session.status.as_str(),
        "queued" | "running" | "waiting_for_user"
    ) {
        return Err(AppError::new(
            "agent_run_active",
            "Wait for the current turn to finish before compacting context.",
        ));
    }
    use sqlx::row::Row;
    let row = sqlx::query::query(
        "SELECT id FROM agent_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1",
    )
    .bind(&session_id)
    .fetch_optional(&repository.pool)
    .await?
    .ok_or_else(|| {
        AppError::new(
            "agent_compaction_unavailable",
            "There is not enough session history to compact yet.",
        )
    })?;
    let run_id: String = row.get("id");
    let items = repository.items(&session_id).await?;
    let expected_last_item_sequence = items.last().map_or(-1, |item| item.sequence);
    let history = items
        .into_iter()
        .filter_map(history_item)
        .collect::<Vec<_>>();
    let model = normalize_agent_model(&session.model);
    let context_window = crate::providers::clovy_model_runtime_capabilities(&model)
        .await
        .context_tokens
        .unwrap_or(128_000)
        .max(1_024);
    let max_output_tokens = agent_model_output_reserve(context_window);
    let stream_scope_id = format!("history-compact:{}", uuid::Uuid::new_v4());
    host.ensure_started(&app, repository.clone()).await?;
    let response = host
        .request(
            "history.compact",
            &session_id,
            &stream_scope_id,
            json!({ "history": history, "model": model, "contextWindow": context_window, "maxOutputTokens": max_output_tokens }),
        )
        .await;
    host.cancel_run_streams(&stream_scope_id).await;
    let response = response?;
    let removed_item_ids = response
        .get("removedItemIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let summary_text = response
        .get("summary")
        .and_then(|summary| summary.get("text"))
        .and_then(Value::as_str);
    let summary_metadata = response
        .get("summary")
        .and_then(|summary| summary.get("metadata"));
    if let Some(summary_text) = summary_text {
        let replacement = repository
            .replace_items_with_context_summary_if_unchanged(
                &session_id,
                &run_id,
                summary_text,
                summary_metadata,
                &removed_item_ids,
                expected_last_item_sequence,
            )
            .await?;
        if !matches!(replacement, ContextSummaryReplacement::Applied(_)) {
            return Err(AppError::new(
                "agent_compact_conflict",
                "The conversation changed while Clovy was compacting it. Wait for the current turn to finish, then try again.",
            ));
        }
    }
    Ok(json!({
        "compacted": summary_text.is_some(),
        "removedItems": removed_item_ids.len(),
        "estimatedTokens": response.get("estimatedTokens").cloned()
    }))
}

#[tauri::command]
pub async fn create_agent_session(
    app: AppHandle,
    request: CreateSessionRequest,
) -> Result<Value, AppError> {
    let repository = repository(&app).await?;
    let model = normalize_agent_model(&request.model);
    let workspace = session_workspace(&app, None)?;
    tokio::fs::create_dir_all(&workspace)
        .await
        .map_err(io_error)?;
    let session = repository
        .create_session_in_profile(
            request.title.as_deref().unwrap_or("New session"),
            &model,
            request.safety_mode,
            workspace.to_str(),
            &request.profile,
        )
        .await?;
    let final_workspace = session_workspace(&app, Some(&session.id))?;
    tokio::fs::create_dir_all(&final_workspace)
        .await
        .map_err(io_error)?;
    sqlx::query::query("UPDATE agent_sessions SET workspace_path = ? WHERE id = ?")
        .bind(final_workspace.to_string_lossy().as_ref())
        .bind(&session.id)
        .execute(&repository.pool)
        .await?;
    Ok(session_json(repository.get_session(&session.id).await?))
}

#[tauri::command]
pub async fn rename_agent_session(
    app: AppHandle,
    request: RenameSessionRequest,
) -> Result<Value, AppError> {
    Ok(session_json(
        repository(&app)
            .await?
            .rename_session(&request.session_id, &request.title)
            .await?,
    ))
}

#[tauri::command]
pub async fn branch_agent_session(
    app: AppHandle,
    session_id: String,
    item_id: String,
) -> Result<Value, AppError> {
    let repository = repository(&app).await?;
    let source = repository.get_session(&session_id).await?;
    let row = sqlx::query::query(
        "SELECT sequence, created_at FROM agent_items WHERE id = ? AND session_id = ?",
    )
    .bind(&item_id)
    .bind(&session_id)
    .fetch_optional(&repository.pool)
    .await?
    .ok_or_else(|| {
        AppError::new(
            "agent_branch_point_missing",
            "The selected message is not available to branch from.",
        )
    })?;
    use sqlx::row::Row;
    let sequence: i64 = row.get("sequence");
    let cutoff_created_at: String = row.get("created_at");
    let workspace = session_workspace(&app, None)?;
    tokio::fs::create_dir_all(&workspace)
        .await
        .map_err(io_error)?;
    let branch = repository
        .create_session(
            &format!("{} branch", source.title),
            &source.model,
            source.safety_mode,
            workspace.to_str(),
        )
        .await?;
    let final_workspace = session_workspace(&app, Some(&branch.id))?;
    tokio::fs::create_dir_all(&final_workspace)
        .await
        .map_err(io_error)?;
    let mut transaction = repository.pool.begin().await?;
    sqlx::query::query("UPDATE agent_sessions SET workspace_path = ? WHERE id = ?")
        .bind(final_workspace.to_string_lossy().as_ref())
        .bind(&branch.id)
        .execute(&mut *transaction)
        .await?;
    inherit_session_profile(
        &mut transaction,
        &session_id,
        &branch.id,
        &chrono::Utc::now().to_rfc3339(),
    )
    .await?;
    let items = sqlx::query::query(
        "SELECT id, sequence, kind, payload_json, created_at
         FROM agent_items WHERE session_id = ? AND sequence <= ? ORDER BY sequence ASC",
    )
    .bind(&session_id)
    .bind(sequence)
    .fetch_all(&mut *transaction)
    .await?;
    let mut item_ids = HashMap::new();
    for item in items {
        let source_item_id: String = item.get("id");
        let branch_item_id = uuid::Uuid::new_v4().to_string();
        sqlx::query::query(
            "INSERT INTO agent_items
             (id, session_id, sequence, kind, payload_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&branch_item_id)
        .bind(&branch.id)
        .bind(item.get::<i64, _>("sequence"))
        .bind(item.get::<String, _>("kind"))
        .bind(item.get::<String, _>("payload_json"))
        .bind(item.get::<String, _>("created_at"))
        .execute(&mut *transaction)
        .await?;
        item_ids.insert(source_item_id, branch_item_id);
    }
    let artifacts = sqlx::query::query(
        "SELECT id, item_id, provenance, action, path, original_path, display_name, mime_type, size_bytes, available, created_at
         FROM agent_artifacts WHERE session_id = ? AND created_at <= ? ORDER BY created_at ASC",
    )
    .bind(&session_id)
    .bind(&cutoff_created_at)
    .fetch_all(&mut *transaction)
    .await?;
    let artifact_root = final_workspace.join("artifacts");
    tokio::fs::create_dir_all(&artifact_root)
        .await
        .map_err(io_error)?;
    let mut path_replacements = Vec::new();
    for artifact in artifacts {
        let source_path = PathBuf::from(artifact.get::<String, _>("path"));
        let available = artifact.get::<i64, _>("available") != 0 && source_path.is_file();
        let destination = if available {
            let name = source_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("artifact");
            let destination = artifact_root.join(format!("{}-{name}", uuid::Uuid::new_v4()));
            tokio::fs::copy(&source_path, &destination)
                .await
                .map_err(io_error)?;
            path_replacements.push((
                source_path.to_string_lossy().into_owned(),
                destination.to_string_lossy().into_owned(),
            ));
            destination
        } else {
            artifact_root.join(
                source_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("missing-artifact"),
            )
        };
        let source_item_id: Option<String> = artifact.get("item_id");
        sqlx::query::query(
            "INSERT INTO agent_artifacts
             (id, session_id, item_id, provenance, action, path, original_path, display_name, mime_type, size_bytes, available, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&branch.id)
        .bind(source_item_id.and_then(|id| item_ids.get(&id).cloned()))
        .bind(artifact.get::<String, _>("provenance"))
        .bind(artifact.get::<String, _>("action"))
        .bind(destination.to_string_lossy().as_ref())
        .bind(artifact.get::<Option<String>, _>("original_path"))
        .bind(artifact.get::<Option<String>, _>("display_name"))
        .bind(artifact.get::<Option<String>, _>("mime_type"))
        .bind(artifact.get::<Option<i64>, _>("size_bytes"))
        .bind(i64::from(available))
        .bind(artifact.get::<String, _>("created_at"))
        .execute(&mut *transaction)
        .await?;
    }
    if !path_replacements.is_empty() {
        let branch_items = sqlx::query::query(
            "SELECT id, payload_json FROM agent_items WHERE session_id = ? ORDER BY sequence ASC",
        )
        .bind(&branch.id)
        .fetch_all(&mut *transaction)
        .await?;
        for item in branch_items {
            let item_id: String = item.get("id");
            let mut payload: Value = serde_json::from_str(&item.get::<String, _>("payload_json"))
                .map_err(|error| {
                AppError::new("agent_branch_payload_invalid", error.to_string())
            })?;
            replace_json_paths(&mut payload, &path_replacements);
            sqlx::query::query("UPDATE agent_items SET payload_json = ? WHERE id = ?")
                .bind(payload.to_string())
                .bind(item_id)
                .execute(&mut *transaction)
                .await?;
        }
    }
    transaction.commit().await?;
    Ok(session_json(repository.get_session(&branch.id).await?))
}

fn replace_json_paths(value: &mut Value, replacements: &[(String, String)]) {
    match value {
        Value::String(text) => {
            if let Some((_, replacement)) = replacements.iter().find(|(source, _)| source == text) {
                *text = replacement.clone();
            }
        }
        Value::Array(values) => {
            for value in values {
                replace_json_paths(value, replacements);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                replace_json_paths(value, replacements);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod branch_tests {
    use super::*;

    #[test]
    fn branch_payload_paths_follow_copied_artifacts_without_changing_other_text() {
        let mut payload = json!({
            "output": {
                "path": "/source/session/image.png",
                "caption": "Keep /source/session/image.png in prose unchanged"
            },
            "attachments": [{ "path": "/source/session/image.png" }]
        });
        replace_json_paths(
            &mut payload,
            &[(
                "/source/session/image.png".into(),
                "/branch/session/artifacts/image.png".into(),
            )],
        );

        assert_eq!(
            payload["output"]["path"],
            "/branch/session/artifacts/image.png"
        );
        assert_eq!(
            payload["attachments"][0]["path"],
            "/branch/session/artifacts/image.png"
        );
        assert_eq!(
            payload["output"]["caption"],
            "Keep /source/session/image.png in prose unchanged"
        );
    }
}

#[tauri::command]
pub async fn delete_agent_session(app: AppHandle, session_id: String) -> Result<(), AppError> {
    let repository = repository(&app).await?;
    let session = repository.get_session(&session_id).await?;
    if matches!(session.status.as_str(), "running" | "waiting_for_user") {
        return Err(AppError::new(
            "agent_run_active",
            "Stop or resolve the current turn before deleting this session.",
        ));
    }
    repository.delete_session(&session_id).await?;
    Ok(())
}

#[tauri::command]
pub async fn list_agent_items(app: AppHandle, session_id: String) -> Result<Vec<Value>, AppError> {
    let repository = repository(&app).await?;
    let active_run_id = repository
        .latest_run(&session_id)
        .await
        .ok()
        .filter(|run| {
            matches!(
                run.status.as_str(),
                "queued" | "running" | "waiting_for_user"
            )
        })
        .map(|run| run.id);
    repository
        .items(&session_id)
        .await?
        .into_iter()
        .map(|item| item_json_with_active_run(item, active_run_id.as_deref()))
        .collect()
}

#[tauri::command]
pub async fn start_agent_run(
    app: AppHandle,
    host: State<'_, AgentRuntimeHost>,
    request: StartRunRequest,
) -> Result<Value, AppError> {
    let repository = repository(&app).await?;
    let session = repository.get_session(&request.session_id).await?;
    let model = normalize_agent_model(&request.model);
    if session.status == "running" || session.status == "waiting_for_user" {
        return Err(AppError::new(
            "agent_run_active",
            "This session already has an active run.",
        ));
    }
    let workspace = if request.workspace_path.trim().is_empty() {
        session.workspace_path.clone().unwrap_or(
            session_workspace(&app, Some(&session.id))?
                .to_string_lossy()
                .into_owned(),
        )
    } else {
        request.workspace_path.clone()
    };
    tokio::fs::create_dir_all(&workspace)
        .await
        .map_err(io_error)?;
    sqlx::query::query(
        "UPDATE agent_sessions SET model = ?, safety_mode = ?, workspace_path = ? WHERE id = ?",
    )
    .bind(&model)
    .bind(request.safety_mode.as_db())
    .bind(&workspace)
    .bind(&session.id)
    .execute(&repository.pool)
    .await?;
    let prepared_attachments = prepare_attachments(
        &request.attachments,
        &request.attachment_metadata,
        std::path::Path::new(&workspace),
    )
    .await?;
    let available_skills = agent_skill_catalog(&app, &repository).await?;
    let requested_skills =
        canonical_skill_ids(request.enabled_skill_ids.iter().map(String::as_str))
            .into_iter()
            .filter(|id| {
                available_skills.iter().any(|skill| {
                    skill.get("id").and_then(Value::as_str) == Some(id.as_str())
                        && skill.get("enabled").and_then(Value::as_bool) == Some(true)
                })
            })
            .collect::<Vec<_>>();
    let reasoning_effort = normalize_reasoning_effort(request.reasoning_effort.as_deref())?;
    let run = repository
        .create_run(&session.id, &model, reasoning_effort)
        .await?;
    let preparation = async {
        repository
            .set_run_enabled_skills(&run.id, &requested_skills)
            .await?;
        let params = run_params(
            &app,
            &repository,
            RunParamsInput {
                session_id: &session.id,
                run_id: &run.id,
                model: &model,
                reasoning_effort,
                safety_mode: request.safety_mode,
                workspace: &workspace,
                input: &request.prompt,
                skills: &requested_skills,
                attachments: &prepared_attachments,
                excluded_history_run_id: None,
            },
        )
        .await?;
        repository
            .set_run_config(&run.id, &resumable_run_config(&params))
            .await?;
        let user_item = repository
            .append_item(
                &session.id,
                Some(&run.id),
                0,
                &AgentItemPayload::UserMessage(super::MessagePayload {
                    role: "user".into(),
                    content: request.prompt.clone(),
                    attachments: prepared_attachments.clone(),
                }),
                Some(&format!("user:{}", run.id)),
            )
            .await?
            .ok_or_else(|| {
                AppError::new(
                    "agent_message_persist_failed",
                    "The user message could not be persisted.",
                )
            })?;
        persist_attachments(
            &repository,
            &session.id,
            &run.id,
            &user_item.id,
            &prepared_attachments,
            &request.attachments,
        )
        .await?;
        Ok::<_, AppError>(params)
    }
    .await;
    let params = match preparation {
        Ok(params) => params,
        Err(error) => {
            mark_dispatch_failed(&repository, &run.id, &error).await;
            return Err(error);
        }
    };
    if let Err(error) = host.ensure_started(&app, repository.clone()).await {
        mark_dispatch_failed(&repository, &run.id, &error).await;
        return Err(error);
    }
    if let Err(error) = host
        .request("run.start", &session.id, &run.id, params)
        .await
    {
        if runtime_dispatch_is_ambiguous(&error) {
            tracing::warn!(
                agent_run_id = %run.id,
                stored_session_id = %session.id,
                error_code = %error.code,
                "agent run dispatch outcome is ambiguous; waiting for its owned runtime to settle"
            );
            return Ok(run_json(repository.get_run(&run.id).await?));
        }
        mark_dispatch_failed(&repository, &run.id, &error).await;
        return Err(error);
    }
    Ok(run_json(repository.get_run(&run.id).await?))
}

#[tauri::command]
pub async fn cancel_agent_run(
    host: State<'_, AgentRuntimeHost>,
    app: AppHandle,
    run_id: String,
) -> Result<(), AppError> {
    let repository = repository(&app).await?;
    let run = repository.get_run(&run_id).await?;
    if run.status == "waiting_for_user" {
        let pending_interruption_ids = repository.pending_interruption_ids(&run.id).await?;
        let mut _resolution_guards = Vec::with_capacity(pending_interruption_ids.len());
        for interruption_id in pending_interruption_ids {
            _resolution_guards.push(host.lock_interruption_resolution(&interruption_id).await);
        }
        let Some(cancelled_run) = repository.cancel_waiting_run(&run.id).await? else {
            return Err(AppError::new(
                "agent_waiting_cancel_conflict",
                "This request is already resuming. Wait for Clovy to continue before stopping it.",
            ));
        };
        crate::companion::cancel_computer_use_approvals_for_session(&app, &run.session_id);
        host.cancel_run_streams(&run.id).await;
        super::host::emit_persisted_run_cancelled(&app, &cancelled_run)?;
        return Ok(());
    }
    host.request("run.cancel", &run.session_id, &run.id, json!({}))
        .await?;
    host.cancel_run_streams(&run.id).await;
    crate::companion::cancel_computer_use_approvals_for_session(&app, &run.session_id);
    Ok(())
}

#[tauri::command]
pub async fn steer_agent_run(
    host: State<'_, AgentRuntimeHost>,
    app: AppHandle,
    run_id: String,
    message_id: String,
    text: String,
) -> Result<Value, AppError> {
    let text = text.trim();
    if text.is_empty() || message_id.trim().is_empty() {
        return Err(AppError::new(
            "agent_steer_invalid",
            "A live instruction is required.",
        ));
    }
    let repository = repository(&app).await?;
    let run = repository.get_run(&run_id).await?;
    if run.status != "running" && run.status != "queued" {
        return Ok(json!({ "accepted": false, "reason": "not_active" }));
    }
    host.request(
        "run.steer",
        &run.session_id,
        &run.id,
        json!({ "messageId": message_id, "text": text }),
    )
    .await
}

#[tauri::command]
pub async fn retry_agent_run(
    app: AppHandle,
    host: State<'_, AgentRuntimeHost>,
    run_id: String,
) -> Result<Value, AppError> {
    let repository = repository(&app).await?;
    let previous = repository.get_run(&run_id).await?;
    let session = repository.get_session(&previous.session_id).await?;
    let message =
        retry_message(repository.items(&session.id).await?, &previous.id).ok_or_else(|| {
            AppError::new(
                "agent_retry_unavailable",
                "No user message is available to retry.",
            )
        })?;
    let prompt = message.content;
    let attachments = message.attachments;
    let workspace = session.workspace_path.clone().ok_or_else(|| {
        AppError::new(
            "agent_workspace_missing",
            "Session workspace is unavailable.",
        )
    })?;
    let model = normalize_agent_model(&session.model);
    if model != session.model {
        sqlx::query::query("UPDATE agent_sessions SET model = ? WHERE id = ?")
            .bind(&model)
            .bind(&session.id)
            .execute(&repository.pool)
            .await?;
    }
    let enabled_skill_ids = repository.run_enabled_skills(&previous.id).await?;
    let run = repository
        .create_run(&session.id, &model, previous.reasoning_effort.as_deref())
        .await?;
    let preparation = async {
        repository
            .set_run_enabled_skills(&run.id, &enabled_skill_ids)
            .await?;
        let params = run_params(
            &app,
            &repository,
            RunParamsInput {
                session_id: &session.id,
                run_id: &run.id,
                model: &model,
                reasoning_effort: previous.reasoning_effort.as_deref(),
                safety_mode: session.safety_mode,
                workspace: &workspace,
                input: &prompt,
                skills: &enabled_skill_ids,
                attachments: &attachments,
                excluded_history_run_id: Some(&previous.id),
            },
        )
        .await?;
        repository
            .set_run_config(&run.id, &resumable_run_config(&params))
            .await?;
        repository
            .append_item(
                &session.id,
                Some(&run.id),
                0,
                &AgentItemPayload::UserMessage(super::MessagePayload {
                    role: "user".into(),
                    content: prompt.clone(),
                    attachments,
                }),
                Some(&format!("user:{}", run.id)),
            )
            .await?
            .ok_or_else(|| {
                AppError::new(
                    "agent_message_persist_failed",
                    "The user message could not be persisted.",
                )
            })?;
        Ok::<_, AppError>(params)
    }
    .await;
    let params = match preparation {
        Ok(params) => params,
        Err(error) => {
            mark_dispatch_failed(&repository, &run.id, &error).await;
            return Err(error);
        }
    };
    if let Err(error) = host.ensure_started(&app, repository.clone()).await {
        mark_dispatch_failed(&repository, &run.id, &error).await;
        return Err(error);
    }
    if let Err(error) = host
        .request("run.start", &session.id, &run.id, params)
        .await
    {
        if runtime_dispatch_is_ambiguous(&error) {
            tracing::warn!(
                agent_run_id = %run.id,
                stored_session_id = %session.id,
                error_code = %error.code,
                "agent retry dispatch outcome is ambiguous; waiting for its owned runtime to settle"
            );
            return Ok(run_json(repository.get_run(&run.id).await?));
        }
        mark_dispatch_failed(&repository, &run.id, &error).await;
        return Err(error);
    }
    Ok(run_json(repository.get_run(&run.id).await?))
}

fn retry_message(items: Vec<AgentItemDto>, run_id: &str) -> Option<super::MessagePayload> {
    items.into_iter().rev().find_map(|item| match item.payload {
        AgentItemPayload::UserMessage(message) if item.run_id.as_deref() == Some(run_id) => {
            Some(message)
        }
        _ => None,
    })
}

struct InterruptionRecord {
    item_id: String,
    run_id: String,
    session_id: String,
    payload_json: String,
}

async fn interruption_record(
    repository: &AgentRepository,
    run_id: &str,
    interruption_id: &str,
) -> Result<Option<InterruptionRecord>, sqlx::Error> {
    use sqlx::row::Row;

    let row = sqlx::query::query(
        "SELECT id, run_id, session_id, payload_json
         FROM agent_items
         WHERE kind = 'interruption'
           AND run_id = ?
           AND json_extract(payload_json, '$.id') = ?
         ORDER BY created_at DESC
         LIMIT 1",
    )
    .bind(run_id)
    .bind(interruption_id)
    .fetch_optional(&repository.pool)
    .await?;

    Ok(row.map(|row| InterruptionRecord {
        item_id: row.get("id"),
        run_id: row.get("run_id"),
        session_id: row.get("session_id"),
        payload_json: row.get("payload_json"),
    }))
}

async fn claim_interruption_resume(
    repository: &AgentRepository,
    record: &InterruptionRecord,
    original_payload_json: &str,
    resolved_payload_json: &str,
    updated_at: &str,
    companion_audit: Option<(&str, &str, &str, &str, &str)>,
) -> Result<bool, sqlx::Error> {
    let mut transaction = repository.pool.begin_with("BEGIN IMMEDIATE").await?;
    let claimed = sqlx::query::query(
        "UPDATE agent_runs
         SET status = 'queued', last_sequence = 0, updated_at = ?
         WHERE id = ? AND status = 'waiting_for_user'",
    )
    .bind(updated_at)
    .bind(&record.run_id)
    .execute(&mut *transaction)
    .await?
    .rows_affected();
    if claimed != 1 {
        transaction.rollback().await?;
        return Ok(false);
    }
    let item_updated = sqlx::query::query(
        "UPDATE agent_items
         SET payload_json = ?
         WHERE id = ?
           AND run_id = ?
           AND payload_json = ?
           AND COALESCE(json_extract(payload_json, '$.status'), 'pending') = 'pending'",
    )
    .bind(resolved_payload_json)
    .bind(&record.item_id)
    .bind(&record.run_id)
    .bind(original_payload_json)
    .execute(&mut *transaction)
    .await?
    .rows_affected();
    if item_updated != 1 {
        transaction.rollback().await?;
        return Ok(false);
    }
    let session_updated = sqlx::query::query(
        "UPDATE agent_sessions
         SET status = 'running', updated_at = ?, last_error = NULL
         WHERE id = ? AND status = 'waiting_for_user'",
    )
    .bind(updated_at)
    .bind(&record.session_id)
    .execute(&mut *transaction)
    .await?
    .rows_affected();
    if session_updated != 1 {
        transaction.rollback().await?;
        return Ok(false);
    }
    if let Some((device_id, request_id, session_id, decision, resolved_at)) = companion_audit {
        crate::db::repositories::Repositories::record_companion_computer_use_approval_decision_in_transaction(
            &mut transaction,
            device_id,
            request_id,
            session_id,
            decision,
            resolved_at,
        )
        .await?;
    }
    transaction.commit().await?;
    Ok(true)
}

fn settle_interruption_payload(
    interruption: &mut Value,
    interruption_kind: &str,
    approval_choice: Option<&str>,
    clarification_answer: Option<&str>,
    secret_ref: Option<&str>,
    resolved_at: &str,
) {
    interruption["status"] = json!("resolved");
    interruption["resolvedAt"] = json!(resolved_at);
    if interruption_kind == "approval" {
        if let Some(choice) = approval_choice {
            interruption["resolution"] = json!(choice);
        }
    }
    if let Some(answer) = clarification_answer {
        interruption["answer"] = json!(answer);
    }
    if let Some(secret_ref) = secret_ref {
        interruption["secretRef"] = json!(secret_ref);
    }
}

fn approval_choice_from_resolution<'a>(
    interruption_kind: &str,
    resolution: &'a Value,
) -> Option<&'a str> {
    if interruption_kind != "approval" {
        return None;
    }
    match resolution.get("choice").and_then(Value::as_str) {
        Some(choice @ ("once" | "session" | "always" | "deny")) => Some(choice),
        _ => Some("deny"),
    }
}

#[tauri::command]
pub async fn resolve_agent_interruption(
    app: AppHandle,
    host: State<'_, AgentRuntimeHost>,
    request: ResolveInterruptionRequest,
) -> Result<Value, AppError> {
    resolve_agent_interruption_inner(&app, &host, request, InterruptionResolutionOrigin::Desktop)
        .await
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum InterruptionResolutionOrigin {
    Desktop,
    Companion(crate::companion::ComputerUseApprovalOrigin),
}

pub(crate) async fn resolve_companion_computer_use_approval(
    app: &AppHandle,
    request_id: &str,
    stored_session_id: &str,
    decision: clovy_companion_protocol::ComputerUseApprovalDecision,
    origin: crate::companion::ComputerUseApprovalOrigin,
) -> Result<Value, AppError> {
    use sqlx::row::Row;
    let repository = repository(app).await?;
    let row = sqlx::query::query(
        "SELECT run_id
         FROM agent_items
         WHERE session_id = ?
           AND kind = 'interruption'
           AND json_extract(payload_json, '$.id') = ?
           AND json_extract(payload_json, '$.status') = 'pending'
         ORDER BY created_at DESC
         LIMIT 1",
    )
    .bind(stored_session_id)
    .bind(request_id)
    .fetch_optional(&repository.pool)
    .await?
    .ok_or_else(|| {
        AppError::new(
            "agent_interruption_not_found",
            "This interruption could not be found.",
        )
    })?;
    let request = ResolveInterruptionRequest {
        interruption_id: request_id.to_string(),
        run_id: row.get("run_id"),
        resolution: json!({
            "kind": "approval",
            "choice": match decision {
                clovy_companion_protocol::ComputerUseApprovalDecision::Approve => "once",
                clovy_companion_protocol::ComputerUseApprovalDecision::Deny => "deny",
            },
            "storedSessionId": stored_session_id,
        }),
    };
    let host = app.state::<AgentRuntimeHost>();
    resolve_agent_interruption_inner(
        app,
        &host,
        request,
        InterruptionResolutionOrigin::Companion(origin),
    )
    .await
}

async fn resolve_agent_interruption_inner(
    app: &AppHandle,
    host: &AgentRuntimeHost,
    request: ResolveInterruptionRequest,
    origin: InterruptionResolutionOrigin,
) -> Result<Value, AppError> {
    let _resolution = host
        .lock_interruption_resolution(&request.interruption_id)
        .await;
    let companion_session_id = match &origin {
        InterruptionResolutionOrigin::Desktop => None,
        InterruptionResolutionOrigin::Companion(companion_origin) => {
            let stored_session_id = request
                .resolution
                .get("storedSessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::new(
                        "companion_computer_use_approval_invalid",
                        "The Computer use approval session is missing.",
                    )
                })?;
            crate::companion::begin_companion_computer_use_resolution(
                app,
                &request.interruption_id,
                stored_session_id,
                companion_origin.clone(),
            )?;
            Some(stored_session_id.to_string())
        }
    };
    let repository = repository(app).await?;
    let record = interruption_record(&repository, &request.run_id, &request.interruption_id)
        .await?
        .ok_or_else(|| {
            AppError::new(
                "agent_interruption_expired",
                "This interruption can no longer be resumed.",
            )
        })?;
    let original_interruption_json = record.payload_json.clone();
    let mut interruption: Value = serde_json::from_str(&original_interruption_json)
        .map_err(|error| AppError::new("agent_interruption_invalid", error.to_string()))?;
    if let Some(expected_session_id) = companion_session_id.as_deref() {
        if record.session_id != expected_session_id
            || interruption.get("kind").and_then(Value::as_str) != Some("approval")
            || interruption.get("toolName").and_then(Value::as_str) != Some("computer_use")
        {
            return Err(AppError::new(
                "companion_computer_use_approval_invalid",
                "The Computer use approval does not match the pending action.",
            ));
        }
    }
    let run = repository.get_run(&record.run_id).await?;
    if run.status != "waiting_for_user" {
        return Err(AppError::new(
            "agent_interruption_expired",
            "This interruption can no longer be resumed.",
        ));
    }
    let session = repository.get_session(&record.session_id).await?;
    let serialized_state = run
        .interrupted_state
        .as_ref()
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::new(
                "agent_interruption_expired",
                "This interruption can no longer be resumed.",
            )
        })?;
    let interruption_kind = interruption
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("approval")
        .to_string();
    let resolution_kind = request
        .resolution
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::new(
                "agent_interruption_resolution_invalid",
                "The interruption response kind is required.",
            )
        })?;
    if resolution_kind != interruption_kind {
        return Err(AppError::new(
            "agent_interruption_resolution_invalid",
            "The interruption response does not match the pending request.",
        ));
    }
    let clarification_answer = request
        .resolution
        .get("answer")
        .and_then(Value::as_str)
        .map(str::to_string);
    let secret_value = request
        .resolution
        .get("secret")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let choice = request.resolution.get("choice").and_then(Value::as_str);
    let approved = match interruption_kind.as_str() {
        "clarification" if clarification_answer.is_some() => true,
        "secret" if secret_value.is_some() && choice == Some("once") => true,
        "secret" if secret_value.is_none() && choice == Some("deny") => false,
        "approval" if matches!(choice, Some("once" | "session" | "always")) => true,
        "approval" if choice == Some("deny") => false,
        _ => {
            return Err(AppError::new(
                "agent_interruption_resolution_invalid",
                "The interruption response is invalid.",
            ));
        }
    };
    let approval_choice = approval_choice_from_resolution(&interruption_kind, &request.resolution)
        .map(str::to_string);
    let workspace = session.workspace_path.clone().ok_or_else(|| {
        AppError::new(
            "agent_workspace_missing",
            "Session workspace is unavailable.",
        )
    })?;
    let model = normalize_agent_model(&run.model);
    let auto_run = crate::clovy_api::is_agent_auto_model(&model);
    let resolved_model = resolved_model_from_usage(run.usage.as_ref());
    if auto_run && resolved_model.is_none() {
        return Err(AppError::new(
            "agent_auto_resume_model_missing",
            "This older Auto run cannot resume because its model was not recorded. Stop the run to continue.",
        ));
    }
    let enabled_skill_ids = repository.run_enabled_skills(&run.id).await?;
    host.ensure_started(app, repository.clone()).await?;
    let mut params = match repository.run_config(&run.id).await? {
        Some(config) => config,
        None => match crate::routines::reconstruct_unattended_resume_params(
            app,
            &repository,
            &run.id,
            &session.id,
            &model,
            session.safety_mode,
            &workspace,
        )
        .await?
        {
            Some(config) => config,
            None => resumable_run_config(
                &run_params(
                    app,
                    &repository,
                    RunParamsInput {
                        session_id: &session.id,
                        run_id: &run.id,
                        model: &model,
                        reasoning_effort: run.reasoning_effort.as_deref(),
                        safety_mode: session.safety_mode,
                        workspace: &workspace,
                        input: "",
                        skills: &enabled_skill_ids,
                        attachments: &[],
                        excluded_history_run_id: None,
                    },
                )
                .await?,
            ),
        },
    };
    params["model"] = json!(model);
    params
        .as_object_mut()
        .expect("run params object")
        .remove("input");
    params
        .as_object_mut()
        .expect("run params object")
        .remove("history");
    params["serializedState"] = json!(serialized_state);
    if let Some(resolved_model) = resolved_model {
        params["resolvedModel"] = json!(resolved_model);
    }
    params["resolutions"] = if let Some(answer) = clarification_answer.as_deref() {
        json!([{ "interruptionId": request.interruption_id, "kind": "clarification", "answer": answer }])
    } else if interruption_kind == "secret" {
        json!([{ "interruptionId": request.interruption_id, "kind": "secret", "decision": if approved { "approve" } else { "reject" } }])
    } else {
        json!([{ "interruptionId": request.interruption_id, "kind": "approval", "decision": if approved { "approve" } else { "reject" } }])
    };
    let secret_ref = if interruption_kind == "secret" {
        match secret_value {
            Some(value) => {
                let secret_ref = format!("agent-secret-{}", uuid::Uuid::new_v4());
                super::secrets::put(&secret_ref, value).await?;
                Some(secret_ref)
            }
            None => None,
        }
    } else {
        None
    };
    let resolution_nonce = uuid::Uuid::new_v4().to_string();
    let resolution_time = chrono::Utc::now().to_rfc3339();
    settle_interruption_payload(
        &mut interruption,
        &interruption_kind,
        approval_choice.as_deref(),
        clarification_answer.as_deref(),
        secret_ref.as_deref(),
        &resolution_time,
    );
    interruption["approved"] = json!(approved);
    interruption["resolutionNonce"] = json!(resolution_nonce);
    if interruption_kind == "approval" {
        interruption["resolvedBy"] = json!(match &origin {
            InterruptionResolutionOrigin::Desktop => "desktop",
            InterruptionResolutionOrigin::Companion(
                crate::companion::ComputerUseApprovalOrigin::Companion { .. },
            ) => "linkedDevice",
            InterruptionResolutionOrigin::Companion(
                crate::companion::ComputerUseApprovalOrigin::Timeout,
            ) => "timeout",
        });
        if let InterruptionResolutionOrigin::Companion(
            crate::companion::ComputerUseApprovalOrigin::Companion { device_id },
        ) = &origin
        {
            interruption["resolvedByDeviceId"] = json!(device_id);
        }
    }
    let resolved_interruption_json = interruption.to_string();
    let companion_audit = match &origin {
        InterruptionResolutionOrigin::Companion(
            crate::companion::ComputerUseApprovalOrigin::Companion { device_id },
        ) => Some((
            device_id.as_str(),
            request.interruption_id.as_str(),
            companion_session_id
                .as_deref()
                .unwrap_or(record.session_id.as_str()),
            if approved { "approve" } else { "deny" },
            resolution_time.as_str(),
        )),
        _ => None,
    };
    // Persist the visible resolution and reset sequencing as one unit. The
    // sidecar can emit resumed events immediately after accepting the request,
    // so both must be in place before dispatch, but neither may be left behind
    // when preparation or persistence fails.
    let claimed = match claim_interruption_resume(
        &repository,
        &record,
        &original_interruption_json,
        &resolved_interruption_json,
        &resolution_time,
        companion_audit,
    )
    .await
    {
        Ok(claimed) => claimed,
        Err(error) => {
            if let Some(secret_ref) = secret_ref.as_deref() {
                let _ = super::secrets::delete(secret_ref).await;
            }
            return Err(error.into());
        }
    };
    if !claimed {
        if let Some(secret_ref) = secret_ref.as_deref() {
            let _ = super::secrets::delete(secret_ref).await;
        }
        return Err(AppError::new(
            "agent_interruption_expired",
            "This interruption can no longer be resumed.",
        ));
    }
    if let InterruptionResolutionOrigin::Companion(companion_origin) = &origin {
        crate::companion::complete_computer_use_resolution(
            app,
            &request.interruption_id,
            companion_session_id
                .as_deref()
                .unwrap_or(record.session_id.as_str()),
            approved,
            approved
                && matches!(
                    companion_origin,
                    crate::companion::ComputerUseApprovalOrigin::Companion { .. }
                ),
            Some(companion_origin.clone()),
        );
    }
    if let Err(error) = host
        .request("run.resume", &session.id, &run.id, params)
        .await
    {
        if runtime_dispatch_is_ambiguous(&error) {
            tracing::warn!(
                agent_run_id = %run.id,
                stored_session_id = %session.id,
                error_code = %error.code,
                "agent resume dispatch outcome is ambiguous; waiting for its owned runtime to settle"
            );
            return Ok(run_json(repository.get_run(&run.id).await?));
        }
        let restore_result: Result<bool, sqlx::Error> = async {
            let mut transaction = repository.pool.begin_with("BEGIN IMMEDIATE").await?;
            let run_restored = sqlx::query::query(
                "UPDATE agent_runs
                 SET status = 'waiting_for_user', last_sequence = ?, updated_at = ?
                 WHERE id = ? AND status = 'queued'",
            )
            .bind(run.last_sequence)
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(&run.id)
            .execute(&mut *transaction)
            .await?
            .rows_affected();
            if run_restored != 1 {
                transaction.rollback().await?;
                return Ok(false);
            }
            let item_restored = sqlx::query::query(
                "UPDATE agent_items
                 SET payload_json = ?
                 WHERE id = ? AND payload_json = ?",
            )
            .bind(&original_interruption_json)
            .bind(&record.item_id)
            .bind(&resolved_interruption_json)
            .execute(&mut *transaction)
            .await?
            .rows_affected();
            if item_restored != 1 {
                transaction.rollback().await?;
                return Ok(false);
            }
            let session_restored = sqlx::query::query(
                "UPDATE agent_sessions
                 SET status = 'waiting_for_user', updated_at = ?
                 WHERE id = ? AND status = 'running'",
            )
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(&session.id)
            .execute(&mut *transaction)
            .await?
            .rows_affected();
            if session_restored != 1 {
                transaction.rollback().await?;
                return Ok(false);
            }
            transaction.commit().await?;
            Ok(true)
        }
        .await;
        if restore_result.as_ref().is_ok_and(|restored| *restored) {
            if let Some(secret_ref) = secret_ref.as_deref() {
                if let Err(cleanup_error) = super::secrets::delete(secret_ref).await {
                    tracing::warn!(
                        error_code = %cleanup_error.code,
                        "failed to remove a secret after resume dispatch failed"
                    );
                }
            }
        }
        if let Some(stored_session_id) = companion_session_id.as_deref() {
            crate::companion::cancel_computer_use_resolution(
                app,
                &request.interruption_id,
                stored_session_id,
            );
        }
        restore_result?;
        return Err(error);
    }
    if origin == InterruptionResolutionOrigin::Desktop {
        crate::companion::complete_computer_use_resolution(
            app,
            &request.interruption_id,
            &session.id,
            approved,
            false,
            None,
        );
    }
    tracing::info!(
        interruption_id = %request.interruption_id,
        stored_session_id = %session.id,
        approved,
        origin = ?origin,
        "resolved agent interruption"
    );
    Ok(run_json(
        repository
            .update_run_status(&run.id, "running", None, None, None)
            .await?,
    ))
}

fn resolved_model_from_usage(usage: Option<&Value>) -> Option<&str> {
    usage
        .and_then(Value::as_object)
        .and_then(|usage| usage.get("resolvedModel"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| crate::clovy_api::is_canonical_agent_model(model))
}

fn runtime_dispatch_is_ambiguous(error: &AppError) -> bool {
    matches!(
        error.code.as_str(),
        "agent_runtime_disconnected" | "agent_runtime_request_timed_out"
    )
}

async fn mark_dispatch_failed(repository: &AgentRepository, run_id: &str, error: &AppError) {
    if let Err(persist_error) = repository
        .update_run_status(
            run_id,
            "failed",
            None,
            None,
            Some((&error.code, &error.message)),
        )
        .await
    {
        tracing::warn!(
            error = %persist_error,
            run_id,
            "failed to persist agent dispatch failure"
        );
    }
}

#[tauri::command]
pub async fn list_agent_artifacts(
    app: AppHandle,
    session_id: String,
) -> Result<Vec<Value>, AppError> {
    let repository = repository(&app).await?;
    Ok(repository.artifacts(&session_id).await?.into_iter().map(|artifact| {
        let name = artifact_display_name(
            &artifact.path,
            artifact.original_path.as_deref(),
            &artifact.provenance,
            artifact.display_name.as_deref(),
        );
        json!({ "id": artifact.id, "sessionId": artifact.session_id, "runId": artifact.run_id, "itemId": artifact.item_id, "name": name, "path": artifact.path, "mimeType": artifact.mime_type, "sizeBytes": artifact.size_bytes, "action": artifact.action, "available": artifact.available, "createdAt": artifact.created_at })
    }).collect())
}

fn artifact_display_name(
    path: &str,
    original_path: Option<&str>,
    provenance: &str,
    persisted_name: Option<&str>,
) -> String {
    if let Some(name) = persisted_name {
        return name.to_string();
    }
    let stored_name = PathBuf::from(path)
        .file_name()
        .map(|value| value.to_string_lossy().into_owned());
    if provenance == "attachment" {
        let original_name = original_path
            .and_then(|value| PathBuf::from(value).file_name().map(|name| name.to_owned()))
            .map(|value| value.to_string_lossy().into_owned());
        if let Some(name) = stored_name
            .as_deref()
            .and_then(|name| copied_attachment_name(name, original_name.as_deref()))
        {
            return name.to_string();
        }
        if let Some(name) = original_name {
            return name;
        }
    }
    stored_name.unwrap_or_else(|| "Artifact".into())
}

fn copied_attachment_name<'a>(
    stored_name: &'a str,
    original_name: Option<&str>,
) -> Option<&'a str> {
    let mut name = stored_name;
    let mut stripped = false;
    while let Some(remainder) = strip_copy_prefix(name) {
        stripped = true;
        name = remainder;
        if original_name == Some(name) {
            break;
        }
    }
    stripped.then_some(name)
}

fn strip_copy_prefix(name: &str) -> Option<&str> {
    let uuid_prefix = name.get(..36)?;
    let remainder = name.get(37..)?;
    (name.as_bytes().get(36) == Some(&b'-')
        && uuid::Uuid::parse_str(uuid_prefix).is_ok()
        && !remainder.is_empty())
    .then_some(remainder)
}

#[tauri::command]
pub async fn read_agent_artifact_preview(
    app: AppHandle,
    request: ReadArtifactRequest,
) -> Result<Option<String>, AppError> {
    let path = authorized_artifact_path(&app, &request.path).await?;
    let Some(mime_type) = image_mime_type(&path) else {
        return Ok(None);
    };
    let bytes = tokio::fs::read(&path).await.map_err(io_error)?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Ok(None);
    }
    Ok(Some(format!(
        "data:{mime_type};base64,{}",
        BASE64.encode(bytes)
    )))
}

#[tauri::command]
pub async fn read_agent_artifact_text(
    app: AppHandle,
    request: ReadArtifactRequest,
) -> Result<Option<String>, AppError> {
    let path = authorized_artifact_path(&app, &request.path).await?;
    let metadata = tokio::fs::metadata(&path).await.map_err(io_error)?;
    if metadata.len() > 1024 * 1024 {
        return Ok(None);
    }
    match tokio::fs::read_to_string(path).await {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidData => Ok(None),
        Err(error) => Err(io_error(error)),
    }
}

#[tauri::command]
pub async fn download_agent_artifact(
    app: AppHandle,
    request: ReadArtifactRequest,
) -> Result<String, AppError> {
    let source = authorized_artifact_path(&app, &request.path).await?;
    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| AppError::new("agent_artifact_download_failed", error.to_string()))?;
    tokio::fs::create_dir_all(&downloads)
        .await
        .map_err(|error| AppError::new("agent_artifact_download_failed", error.to_string()))?;
    let destination = unique_download_path(&downloads, &source)?;
    tokio::fs::copy(&source, &destination)
        .await
        .map_err(|error| AppError::new("agent_artifact_download_failed", error.to_string()))?;
    Ok(destination.to_string_lossy().into_owned())
}

fn unique_download_path(downloads: &Path, source: &Path) -> Result<PathBuf, AppError> {
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            AppError::new(
                "agent_artifact_download_failed",
                "The Clovy file does not have a downloadable filename.",
            )
        })?;
    let candidate = downloads.join(file_name);
    if !candidate.exists() {
        return Ok(candidate);
    }
    let stem = source
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    let extension = source.extension().and_then(|name| name.to_str());
    for index in 1..1000 {
        let file_name = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
            _ => format!("{stem} ({index})"),
        };
        let candidate = downloads.join(file_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(AppError::new(
        "agent_artifact_download_failed",
        "Could not find an available Downloads filename.",
    ))
}

async fn authorized_artifact_path(app: &AppHandle, requested: &str) -> Result<PathBuf, AppError> {
    use sqlx::row::Row;
    let repository = repository(app).await?;
    let row = sqlx::query::query(
        "SELECT path FROM agent_artifacts WHERE path = ? AND available = 1 LIMIT 1",
    )
    .bind(requested)
    .fetch_optional(&repository.pool)
    .await?;
    let path: String = row
        .ok_or_else(|| AppError::new("agent_artifact_unavailable", "Artifact is unavailable."))?
        .get("path");
    PathBuf::from(path)
        .canonicalize()
        .map_err(|_| AppError::new("agent_artifact_unavailable", "Artifact is unavailable."))
}

fn image_mime_type(path: &std::path::Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "tif" | "tiff" => Some("image/tiff"),
        _ => None,
    }
}

#[tauri::command]
pub async fn list_agent_skills(app: AppHandle) -> Result<Vec<Value>, AppError> {
    let repository = repository(&app).await?;
    agent_skill_catalog(&app, &repository).await
}

#[tauri::command]
pub async fn read_agent_skill(app: AppHandle, skill_id: String) -> Result<Value, AppError> {
    validate_skill_id(&skill_id)?;
    let canonical_id = canonical_skill_id(&skill_id);
    for (root, managed) in skill_roots(&app) {
        for read_id in read_skill_ids(canonical_id) {
            let path = skill_file(&root, read_id);
            if path.is_file() {
                let content = tokio::fs::read_to_string(path)
                    .await
                    .map_err(|error| AppError::new("agent_skill_read_failed", error.to_string()))?;
                return Ok(json!({ "content": content, "readOnly": !managed }));
            }
        }
    }
    Err(AppError::new(
        "agent_skill_not_found",
        "The requested skill was not found.",
    ))
}

#[tauri::command]
pub async fn update_agent_skill(
    app: AppHandle,
    request: UpdateSkillRequest,
) -> Result<Value, AppError> {
    validate_skill_id(&request.skill_id)?;
    let canonical_id = canonical_skill_id(&request.skill_id).to_string();
    if request.content.len() > 512 * 1024 {
        return Err(AppError::new(
            "agent_skill_too_large",
            "Skill instructions must be smaller than 512 KB.",
        ));
    }
    let root = skill_roots(&app)
        .into_iter()
        .find_map(|(root, managed)| managed.then_some(root))
        .ok_or_else(|| {
            AppError::new(
                "agent_skill_write_failed",
                "Managed skill storage is unavailable.",
            )
        })?;
    if !read_skill_ids(&canonical_id)
        .into_iter()
        .any(|read_id| skill_file(&root, read_id).is_file())
    {
        return Err(AppError::new(
            "agent_skill_read_only",
            "User-global skills are read-only in Clovy.",
        ));
    }
    write_managed_skill_content(&root, &canonical_id, &request.content).await?;
    let skill = repository(&app)
        .await?
        .skills()
        .await?
        .into_iter()
        .find(|skill| skill.id == canonical_id)
        .map(|skill| skill.enabled)
        .unwrap_or(true);
    let description =
        skill_description(&request.content).unwrap_or_else(|| "Clovy agent skill".into());
    Ok(
        json!({ "id": canonical_id, "name": canonical_id, "description": description, "source": "managed", "enabled": skill, "editable": true }),
    )
}

async fn write_managed_skill_content(
    root: &Path,
    skill_id: &str,
    content: &str,
) -> Result<(), AppError> {
    for write_id in write_skill_ids(skill_id) {
        let content = skill_content_for_id(content, write_id);
        let path = skill_file(root, write_id);
        let parent = path.parent().ok_or_else(|| {
            AppError::new(
                "agent_skill_write_failed",
                "Skill path has no parent directory.",
            )
        })?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| AppError::new("agent_skill_write_failed", error.to_string()))?;
        let temporary = path.with_extension("md.tmp");
        tokio::fs::write(&temporary, content)
            .await
            .map_err(|error| AppError::new("agent_skill_write_failed", error.to_string()))?;
        if let Err(error) = tokio::fs::rename(&temporary, &path).await {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(AppError::new("agent_skill_write_failed", error.to_string()));
        }
    }
    Ok(())
}

fn validate_skill_id(skill_id: &str) -> Result<(), AppError> {
    if skill_id.is_empty()
        || skill_id.len() > 128
        || !skill_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(AppError::new(
            "agent_skill_invalid",
            "Skill ids may contain letters, numbers, hyphens, and underscores.",
        ));
    }
    Ok(())
}

pub(crate) async fn agent_skill_catalog(
    app: &AppHandle,
    repository: &AgentRepository,
) -> Result<Vec<Value>, AppError> {
    let overrides: HashMap<String, bool> = repository
        .skills()
        .await?
        .into_iter()
        .map(|skill| (canonical_skill_id(&skill.id).to_string(), skill.enabled))
        .collect();
    agent_skill_catalog_from_roots(skill_roots(app), &overrides).await
}

async fn agent_skill_catalog_from_roots(
    roots: Vec<(PathBuf, bool)>,
    overrides: &HashMap<String, bool>,
) -> Result<Vec<Value>, AppError> {
    let mut result = Vec::new();
    for (root, managed) in roots {
        let Ok(mut entries) = tokio::fs::read_dir(&root).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let stored_skill_file = entry.path().join("SKILL.md");
            if !stored_skill_file.is_file() {
                continue;
            }
            let stored_id = entry.file_name().to_string_lossy().into_owned();
            let id = canonical_skill_id(&stored_id).to_string();
            if stored_id != id && skill_file(&root, &id).is_file() {
                continue;
            }
            if result
                .iter()
                .any(|value: &Value| value.get("id").and_then(Value::as_str) == Some(&id))
            {
                continue;
            }
            let description = tokio::fs::read_to_string(&stored_skill_file)
                .await
                .ok()
                .and_then(|text| skill_description(&text))
                .unwrap_or_else(|| "Clovy agent skill".into());
            result.push(json!({ "id": id, "name": id, "description": description, "source": if managed { "managed" } else { "user_global" }, "enabled": overrides.get(&id).copied().unwrap_or(true), "editable": managed }));
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn set_agent_skill_enabled(
    app: AppHandle,
    request: SetSkillEnabledRequest,
) -> Result<Value, AppError> {
    validate_skill_id(&request.skill_id)?;
    let canonical_id = canonical_skill_id(&request.skill_id).to_string();
    let managed_root = skill_roots(&app)
        .into_iter()
        .find(|(_, managed)| *managed)
        .map(|(root, _)| root)
        .filter(|root| {
            read_skill_ids(&canonical_id)
                .into_iter()
                .any(|read_id| skill_file(root, read_id).is_file())
        });
    let Some(managed_root) = managed_root else {
        return Err(AppError::new(
            "agent_skill_read_only",
            "User-global skills are read-only in Clovy.",
        ));
    };
    let skill = repository(&app)
        .await?
        .set_skill_enabled(&canonical_id, request.enabled, true)
        .await?;
    let mut description = None;
    for read_id in read_skill_ids(&canonical_id) {
        if let Ok(text) = tokio::fs::read_to_string(skill_file(&managed_root, read_id)).await {
            description = skill_description(&text);
            break;
        }
    }
    let description = description.unwrap_or_else(|| "Clovy agent skill".into());
    Ok(
        json!({ "id": skill.id, "name": skill.id, "description": description, "source": "managed", "enabled": skill.enabled, "editable": true }),
    )
}

fn skill_description(text: &str) -> Option<String> {
    let mut lines = text.lines().map(str::trim);
    if lines.next() == Some("---") {
        for line in &mut lines {
            if line == "---" {
                break;
            }
            if let Some((key, value)) = line.split_once(':') {
                if key.trim() == "description" {
                    let value = value
                        .trim()
                        .trim_matches(|character| character == '"' || character == '\'');
                    if !value.is_empty() {
                        return Some(value.to_string());
                    }
                }
            }
        }
    }
    lines
        .find(|line| !line.is_empty() && !line.starts_with('#') && *line != "---")
        .map(str::to_string)
}

fn skill_roots(app: &AppHandle) -> Vec<(PathBuf, bool)> {
    let mut roots = crate::app_paths::app_data_dir(app)
        .ok()
        .map(|path| (path.join("agents").join("skills"), true))
        .into_iter()
        .collect::<Vec<_>>();
    if let Some(home) = std::env::var_os("HOME") {
        roots.push((PathBuf::from(home).join(".agents").join("skills"), false));
    }
    roots
}

fn normalize_agent_model(model: &str) -> String {
    let model = model.trim();
    if model.is_empty() || model == "auto" {
        crate::providers::AUTO_GENERATION_MODEL.to_string()
    } else {
        model.to_string()
    }
}

fn normalize_reasoning_effort(effort: Option<&str>) -> Result<Option<&str>, AppError> {
    match effort.map(str::trim).filter(|effort| !effort.is_empty()) {
        None => Ok(None),
        Some(effort @ ("minimal" | "medium" | "high")) => Ok(Some(effort)),
        Some(_) => Err(AppError::new(
            "agent_reasoning_effort_invalid",
            "Reasoning effort must be minimal, medium, or high.",
        )),
    }
}

struct RunParamsInput<'a> {
    session_id: &'a str,
    run_id: &'a str,
    model: &'a str,
    reasoning_effort: Option<&'a str>,
    safety_mode: AgentSafetyMode,
    workspace: &'a str,
    input: &'a str,
    skills: &'a [String],
    attachments: &'a [MessageAttachmentPayload],
    excluded_history_run_id: Option<&'a str>,
}

async fn run_params(
    app: &AppHandle,
    repository: &AgentRepository,
    request: RunParamsInput<'_>,
) -> Result<Value, AppError> {
    let model_capabilities =
        crate::providers::clovy_model_runtime_capabilities(request.model).await;
    let supports_vision = model_capabilities.supports_vision;
    let context_window = model_capabilities
        .context_tokens
        .unwrap_or(128_000)
        .max(1_024);
    let mut history = runtime_history(
        repository.items(request.session_id).await?,
        request.excluded_history_run_id,
    );
    if !supports_vision {
        for item in &mut history {
            if let Some(object) = item.as_object_mut() {
                object.remove("attachments");
            }
        }
    }
    let vision_attachments = request
        .attachments
        .iter()
        .filter(|attachment| {
            supports_vision
                && attachment
                    .mime_type
                    .as_deref()
                    .is_some_and(is_supported_vision_mime_type)
        })
        .cloned()
        .collect::<Vec<_>>();
    let current_vision_bytes = vision_attachments
        .iter()
        .map(|attachment| attachment.size_bytes.max(0))
        .fold(0_i64, i64::saturating_add);
    if current_vision_bytes > MAX_INLINE_VISION_BYTES {
        return Err(AppError::new(
            "agent_vision_attachments_too_large",
            "Image attachments must total 6 MB or less for one message.",
        ));
    }
    if supports_vision {
        retain_recent_vision_attachments(
            &mut history,
            MAX_INLINE_VISION_BYTES - current_vision_bytes,
        );
    }
    let vision_attachments = vision_attachments
        .iter()
        .map(runtime_attachment)
        .collect::<Vec<_>>();
    let tools = tool_descriptors(app, repository, request.safety_mode, request.workspace).await?;
    let mcp_descriptors = tools
        .as_array()
        .into_iter()
        .flatten()
        .filter(|descriptor| {
            descriptor
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("mcp:"))
        })
        .filter_map(|descriptor| serde_json::from_value(descriptor.clone()).ok())
        .collect::<Vec<crate::agent_mcp::RuntimeToolDescriptorJson>>();
    crate::agent_mcp::snapshot_run_policies(&repository.pool, request.run_id, &mcp_descriptors)
        .await
        .map_err(|error| AppError::new("agent_mcp_policy_snapshot_failed", error.to_string()))?;
    let skill_catalog = agent_skill_catalog(app, repository).await?;
    let skill_lookup: HashMap<String, Value> = skill_catalog
        .into_iter()
        .filter_map(|skill| {
            let id = skill
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)?;
            Some((id, skill))
        })
        .collect();
    let skills = request
        .skills
        .iter()
        .map(|name| {
            let entry = skill_lookup.get(name);
            let description = entry
                .and_then(|skill| skill.get("description").and_then(Value::as_str))
                .unwrap_or("Clovy agent skill")
                .to_string();
            let source = entry
                .and_then(|skill| skill.get("source").and_then(Value::as_str))
                .unwrap_or("managed")
                .to_string();
            json!({ "name": name, "description": description, "source": source })
        })
        .collect::<Vec<_>>();
    let instructions = super::persona::instructions_for_app(app, INSTRUCTIONS);
    Ok(
        json!({ "model": request.model, "reasoningEffort": request.reasoning_effort, "instructions": instructions, "workspace": request.workspace, "safetyMode": request.safety_mode.as_db(), "input": message_with_attachment_context(request.input, request.attachments), "attachments": vision_attachments, "history": history, "tools": tools, "skills": skills, "contextWindow": context_window, "maxOutputTokens": agent_model_output_reserve(context_window) }),
    )
}

fn agent_model_output_reserve(context_window: i64) -> i64 {
    AGENT_MODEL_OUTPUT_RESERVE.min((context_window / 4).max(256))
}

pub(crate) fn resumable_run_config(params: &Value) -> Value {
    let mut config = params.clone();
    if let Some(object) = config.as_object_mut() {
        object.remove("input");
        object.remove("history");
    }
    config
}

async fn tool_descriptors(
    app: &AppHandle,
    repository: &AgentRepository,
    safety_mode: AgentSafetyMode,
    workspace: &str,
) -> Result<Value, AppError> {
    let mut tools = json!([
        { "name": "search_june", "description": "Search Clovy notes, transcripts, and dictations.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"], "additionalProperties": false } },
        { "name": "list_memories", "description": "Recall durable facts, preferences, and decisions from Clovy's memory store. Pass projectId to include that project's memories.", "parameters": { "type": "object", "properties": { "projectId": { "type": "string" }, "includeGlobal": { "type": "boolean", "default": true }, "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 8 }, "offset": { "type": "integer", "minimum": 0, "default": 0 } }, "required": [], "additionalProperties": false } },
        { "name": "save_memory", "description": "Save a durable fact, preference, or decision in Clovy's memory store. Pass projectId when it belongs to the current project.", "parameters": { "type": "object", "properties": { "content": { "type": "string", "maxLength": 4000 }, "projectId": { "type": "string" } }, "required": ["content"], "additionalProperties": false }, "requiresApproval": true },
        { "name": "forget_memory", "description": "Permanently forget one Clovy memory by id when the user asks Clovy to forget it.", "parameters": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"], "additionalProperties": false }, "requiresApproval": true },
        { "name": "generate_image", "description": "Generate an image from a text description and show it in the conversation.", "parameters": { "type": "object", "properties": { "prompt": { "type": "string" } }, "required": ["prompt"], "additionalProperties": false } },
        { "name": "edit_image", "description": "Edit an image file in the Clovy session workspace and show the result in the conversation.", "parameters": { "type": "object", "properties": { "sourcePath": { "type": "string" }, "instruction": { "type": "string" } }, "required": ["sourcePath", "instruction"], "additionalProperties": false } },
        { "name": "generate_video", "description": "Generate a short video from a text description and show it in the conversation.", "parameters": { "type": "object", "properties": { "prompt": { "type": "string" }, "duration": { "type": "string" }, "aspectRatio": { "type": "string" }, "audio": { "type": "boolean" } }, "required": ["prompt"], "additionalProperties": false } },
        { "name": "get_obsidian_vault", "description": "Discover the current Obsidian vault selected in Clovy. When the clovy-obsidian skill is available, load it before Obsidian note work. Call this tool before every distinct Obsidian task because the user may change or disconnect the vault while the session remains open. If connected is false, do not guess a vault path. If available is false, do not infer or reconstruct its path. A returned path is current discovery only, not write authorization; stay within that vault and use only filesystem operations allowed by the current safety mode.", "parameters": { "type": "object", "properties": {}, "required": [], "additionalProperties": false } },
        { "name": "start_recording", "description": "Start a visible Clovy recording only when the user explicitly asks to begin recording now.", "parameters": { "type": "object", "properties": { "sourceMode": { "type": "string", "enum": ["microphoneOnly", "microphonePlusSystem"] } }, "required": [], "additionalProperties": false }, "requiresApproval": true },
        { "name": "stop_recording", "description": "Stop the recording currently visible in Clovy.", "parameters": { "type": "object", "properties": {}, "required": [], "additionalProperties": false }, "requiresApproval": true },
        { "name": "recording_status", "description": "Check whether Clovy is currently recording and return the active recording metadata.", "parameters": { "type": "object", "properties": {}, "required": [], "additionalProperties": false } },
        { "name": "start_session", "description": "Start an attended Clovy Browser use session.", "parameters": { "type": "object", "properties": {}, "required": [], "additionalProperties": false } },
        { "name": "close_session", "description": "Close an attended Clovy Browser use session.", "parameters": { "type": "object", "properties": { "session_id": { "type": "string" } }, "required": ["session_id"], "additionalProperties": false } },
        { "name": "navigate", "description": "Navigate a Clovy Browser use session to a URL.", "parameters": { "type": "object", "properties": { "session_id": { "type": "string" }, "url": { "type": "string" } }, "required": ["session_id", "url"], "additionalProperties": true } },
        { "name": "snapshot", "description": "Read the visible page and interactive references from a Clovy Browser use session.", "parameters": { "type": "object", "properties": { "session_id": { "type": "string" } }, "required": ["session_id"], "additionalProperties": true } },
        { "name": "screenshot", "description": "Capture a screenshot from a Clovy Browser use session.", "parameters": { "type": "object", "properties": { "session_id": { "type": "string" } }, "required": ["session_id"], "additionalProperties": true } },
        { "name": "click", "description": "Click an interactive reference in a Clovy Browser use session.", "parameters": { "type": "object", "properties": { "session_id": { "type": "string" }, "ref": { "type": "string" } }, "required": ["session_id", "ref"], "additionalProperties": true } },
        { "name": "fill", "description": "Fill an interactive reference in a Clovy Browser use session.", "parameters": { "type": "object", "properties": { "session_id": { "type": "string" }, "ref": { "type": "string" }, "value": { "type": "string" } }, "required": ["session_id", "ref", "value"], "additionalProperties": true } },
        { "name": "press", "description": "Press a key in a Clovy Browser use session.", "parameters": { "type": "object", "properties": { "session_id": { "type": "string" }, "key": { "type": "string" } }, "required": ["session_id", "key"], "additionalProperties": true } },
        { "name": "back", "description": "Navigate back in a Clovy Browser use session.", "parameters": { "type": "object", "properties": { "session_id": { "type": "string" } }, "required": ["session_id"], "additionalProperties": true } },
        { "name": "list_tabs", "description": "List tabs owned by a Clovy Browser use session.", "parameters": { "type": "object", "properties": { "session_id": { "type": "string" } }, "required": ["session_id"], "additionalProperties": true } },
        { "name": "open_tab", "description": "Open a task-owned tab in a Clovy Browser use session.", "parameters": { "type": "object", "properties": { "session_id": { "type": "string" }, "url": { "type": "string" } }, "required": ["session_id"], "additionalProperties": true } },
        { "name": "switch_tab", "description": "Switch the active task-owned tab in a Clovy Browser use session.", "parameters": { "type": "object", "properties": { "session_id": { "type": "string" }, "tab_id": {} }, "required": ["session_id", "tab_id"], "additionalProperties": true } },
        { "name": "close_tab", "description": "Close a task-owned tab in a Clovy Browser use session.", "parameters": { "type": "object", "properties": { "session_id": { "type": "string" }, "tab_id": {} }, "required": ["session_id", "tab_id"], "additionalProperties": true } },
        { "name": "accept_shared_tab", "description": "Accept a one-use browser tab share code supplied by the user.", "parameters": { "type": "object", "properties": { "session_id": { "type": "string" }, "share_code": { "type": "string" } }, "required": ["session_id", "share_code"], "additionalProperties": true } },
        { "name": "web_search", "description": "Search the public web.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"], "additionalProperties": false } },
        { "name": "web_fetch", "description": "Fetch a public web page.", "parameters": { "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"], "additionalProperties": false } },
        { "name": "list_files", "description": "List files in a directory.", "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": [], "additionalProperties": false } },
        { "name": "read_file", "description": "Read a UTF-8 text file.", "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"], "additionalProperties": false } },
        { "name": "write_file", "description": "Write a UTF-8 text file.", "parameters": { "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } }, "required": ["path", "content"], "additionalProperties": false }, "requiresApproval": true },
        { "name": "patch_file", "description": "Replace one exact text occurrence in a file.", "parameters": { "type": "object", "properties": { "path": { "type": "string" }, "before": { "type": "string" }, "after": { "type": "string" } }, "required": ["path", "before", "after"], "additionalProperties": false }, "requiresApproval": true },
        { "name": "import_file", "description": "Copy a user file into this session workspace.", "parameters": { "type": "object", "properties": { "sourcePath": { "type": "string" } }, "required": ["sourcePath"], "additionalProperties": false }, "requiresApproval": true },
        { "name": "preview_file", "description": "Read file metadata and a bounded text preview.", "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"], "additionalProperties": false } },
        { "name": "search_files", "description": "Search text files.", "parameters": { "type": "object", "properties": { "query": { "type": "string" }, "path": { "type": "string" } }, "required": ["query"], "additionalProperties": false } },
        { "name": "run_shell", "description": "Run a shell command in the session workspace. Values in secretEnv must be opaque references returned by request_secret.", "parameters": { "type": "object", "properties": { "command": { "type": "string" }, "secretEnv": { "type": "object", "additionalProperties": { "type": "string" } } }, "required": ["command"], "additionalProperties": false }, "requiresApproval": true },
        { "name": "list_skills", "description": "List available Clovy skills.", "parameters": { "type": "object", "properties": {}, "required": [], "additionalProperties": false } },
        { "name": "load_skill", "description": "Load instructions for one Clovy skill.", "parameters": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"], "additionalProperties": false } }
        ,{ "name": "list_routines", "description": "List Clovy routines and their schedules.", "parameters": { "type": "object", "properties": {}, "required": [], "additionalProperties": false } }
        ,{ "name": "create_routine", "description": "Create a Clovy routine after the user has confirmed its instructions and timing.", "parameters": { "type": "object", "properties": { "name": { "type": "string" }, "prompt": { "type": "string" }, "schedule": { "type": "string", "description": "RFC 3339, every <n>m/h/d, or a five-field cron expression." }, "safetyMode": { "type": "string", "enum": ["sandboxed", "unrestricted"] } }, "required": ["prompt", "schedule", "safetyMode"], "additionalProperties": false }, "requiresApproval": true }
        ,{ "name": "update_routine", "description": "Update an existing Clovy routine.", "parameters": { "type": "object", "properties": { "routineId": { "type": "string" }, "name": { "type": "string" }, "prompt": { "type": "string" }, "schedule": { "type": "string" }, "safetyMode": { "type": "string", "enum": ["sandboxed", "unrestricted"] } }, "required": ["routineId"], "additionalProperties": false }, "requiresApproval": true }
        ,{ "name": "pause_routine", "description": "Pause a Clovy routine.", "parameters": { "type": "object", "properties": { "routineId": { "type": "string" } }, "required": ["routineId"], "additionalProperties": false }, "requiresApproval": true }
        ,{ "name": "resume_routine", "description": "Resume a paused Clovy routine.", "parameters": { "type": "object", "properties": { "routineId": { "type": "string" } }, "required": ["routineId"], "additionalProperties": false }, "requiresApproval": true }
        ,{ "name": "delete_routine", "description": "Delete a Clovy routine.", "parameters": { "type": "object", "properties": { "routineId": { "type": "string" } }, "required": ["routineId"], "additionalProperties": false }, "requiresApproval": true }
        ,{ "name": "request_clarification", "description": "Pause and ask the user a question when their answer is required to continue.", "parameters": { "type": "object", "properties": { "question": { "type": "string" }, "choices": { "type": "array", "items": { "type": "string" } } }, "required": ["question", "choices"], "additionalProperties": false }, "requiresApproval": true }
        ,{ "name": "request_secret", "description": "Securely request a secret from the user. The result is an opaque one-use reference for a safety-controlled tool, never the secret value.", "parameters": { "type": "object", "properties": { "reason": { "type": "string" } }, "required": ["reason"], "additionalProperties": false }, "requiresApproval": true }
        ,{ "name": "computer_use", "description": "Operate the attended computer-use session through Clovy's permission and approval broker.", "parameters": { "type": "object", "properties": { "action": { "type": "string" }, "arguments": {} }, "required": ["action"], "additionalProperties": true }, "requiresApproval": true }
    ]);
    let subsystem = crate::agent_mcp::AgentMcpSubsystem::new(
        crate::agent_mcp::AgentMcpRepository::new(repository.pool.clone()),
        crate::agent_mcp::KeychainMcpSecretStore,
    );
    match subsystem
        .refresh_registry_for_workspace_with_managed_linear(
            app,
            safety_mode == AgentSafetyMode::Sandboxed,
            Some(std::path::Path::new(workspace)),
        )
        .await
    {
        Ok(descriptors) => {
            tools
                .as_array_mut()
                .expect("tool descriptor catalog is an array")
                .extend(
                    descriptors
                        .into_iter()
                        .filter_map(|descriptor| serde_json::to_value(descriptor).ok()),
                );
        }
        Err(error) => {
            tracing::warn!(
                error_code = "agent_mcp_discovery_failed",
                error = %error,
                "MCP tool discovery was unavailable for this run"
            );
        }
    }
    match crate::agent_runtime::native_connectors::descriptors(app).await {
        Ok(descriptors) => tools
            .as_array_mut()
            .expect("tool descriptor catalog is an array")
            .extend(descriptors),
        Err(error) => tracing::warn!(
            error_code = %error.code,
            "native connector tool discovery was unavailable for this run"
        ),
    }
    Ok(tools)
}

fn history_item(item: AgentItemDto) -> Option<Value> {
    match item.payload {
        AgentItemPayload::UserMessage(message)
        | AgentItemPayload::AssistantMessage(message)
        | AgentItemPayload::SystemMessage(message) => Some(
            json!({ "id": item.id, "kind": "message", "role": message.role, "text": message_with_attachment_context(&message.content, &message.attachments), "attachments": message.attachments.iter().map(runtime_attachment).collect::<Vec<_>>() }),
        ),
        AgentItemPayload::ContextSummary(text) => Some(
            json!({ "id": item.id, "kind": "context_summary", "role": "user", "text": text.text, "metadata": text.metadata }),
        ),
        AgentItemPayload::Steering(text) => {
            Some(json!({ "id": item.id, "kind": "message", "role": "user", "text": text.text }))
        }
        AgentItemPayload::ToolCall(tool) => {
            let name = tool.tool_name?;
            let call_id = tool.tool_call_id?;
            let arguments =
                serde_json::to_string(&tool.arguments.unwrap_or_else(|| json!({}))).ok()?;
            Some(json!({
                "id": item.id,
                "kind": "tool_call",
                "name": name,
                "callId": call_id,
                "groupId": call_id,
                "payload": {
                    "type": "function_call",
                    "name": name,
                    "callId": call_id,
                    "status": "completed",
                    "arguments": arguments,
                }
            }))
        }
        AgentItemPayload::ToolResult(tool) => {
            let name = tool.tool_name?;
            let call_id = tool.tool_call_id?;
            let output = serde_json::to_string(&tool.result.unwrap_or(Value::Null)).ok()?;
            Some(json!({
                "id": item.id,
                "kind": "tool_result",
                "name": name,
                "callId": call_id,
                "groupId": call_id,
                "payload": {
                    "type": "function_call_result",
                    "name": name,
                    "callId": call_id,
                    "status": "completed",
                    "output": output,
                }
            }))
        }
        _ => None,
    }
}

fn runtime_history(items: Vec<AgentItemDto>, excluded_run_id: Option<&str>) -> Vec<Value> {
    items
        .into_iter()
        .filter(|item| item.run_id.as_deref() != excluded_run_id)
        .filter_map(history_item)
        .collect()
}

fn session_json(session: super::AgentSessionDto) -> Value {
    json!({ "id": session.id, "title": session.title, "status": session.status, "model": session.model, "safetyMode": session.safety_mode, "workspacePath": session.workspace_path.unwrap_or_default(), "source": match session.source.as_str() { "legacy_routine" => "legacy_routine", "routine" => "routine", "user" => "user", _ => "legacy_task" }, "createdAt": session.created_at, "updatedAt": session.updated_at, "error": session.last_error })
}
fn run_json(run: super::AgentRunDto) -> Value {
    json!({ "id": run.id, "sessionId": run.session_id, "status": run.status, "model": run.model, "reasoningEffort": run.reasoning_effort, "startedAt": run.started_at, "completedAt": run.completed_at, "usage": run.usage, "error": run.error_message })
}

fn item_json_with_active_run(
    item: AgentItemDto,
    active_run_id: Option<&str>,
) -> Result<Value, AppError> {
    let is_active_run = item.run_id.as_deref() == active_run_id;
    let stable_stream_id = is_active_run
        .then_some(item.external_id.as_deref())
        .flatten()
        .filter(|external_id| {
            external_id.starts_with("assistant:") || external_id.starts_with("reasoning:")
        });
    let stable_steering_id = item
        .external_id
        .as_deref()
        .filter(|external_id| external_id.starts_with("steering:"));
    let public_item_id = stable_steering_id
        .or(stable_stream_id)
        .unwrap_or(&item.id)
        .to_string();
    let stream_status =
        if stable_stream_id.is_some_and(|external_id| external_id.starts_with("assistant:")) {
            "streaming"
        } else {
            "complete"
        };
    let base = json!({ "id": public_item_id, "sessionId": item.session_id, "runId": item.run_id, "sequence": item.sequence, "createdAt": item.created_at });
    let mut object = base.as_object().cloned().expect("base object");
    let fields = match item.payload {
        AgentItemPayload::UserMessage(v)
        | AgentItemPayload::AssistantMessage(v)
        | AgentItemPayload::SystemMessage(v) => {
            let attachments = v
                .attachments
                .into_iter()
                .map(|attachment| {
                    json!({
                        "id": attachment.id,
                        "sessionId": &item.session_id,
                        "runId": &item.run_id,
                        "itemId": &item.id,
                        "name": attachment.name,
                        "path": attachment.path,
                        "mimeType": attachment.mime_type,
                        "sizeBytes": attachment.size_bytes,
                        "action": "imported",
                        "available": attachment.available,
                        "createdAt": attachment.created_at
                    })
                })
                .collect::<Vec<_>>();
            json!({ "kind": "message", "role": v.role, "text": v.content, "status": stream_status, "attachments": attachments })
        }
        AgentItemPayload::Reasoning(v) => {
            json!({ "kind": "reasoning", "text": v.text, "status": stream_status })
        }
        AgentItemPayload::Steering(v) => json!({ "kind": "steering", "text": v.text }),
        AgentItemPayload::ContextSummary(v) => {
            json!({ "kind": "context_summary", "text": v.text, "metadata": v.metadata })
        }
        AgentItemPayload::ToolCall(v) => {
            json!({ "kind": "tool_call", "callId": v.tool_call_id.unwrap_or_default(), "name": v.tool_name.unwrap_or_default(), "arguments": v.arguments, "status": v.status.unwrap_or_else(|| "complete".into()) })
        }
        AgentItemPayload::ToolResult(v) => {
            json!({ "kind": "tool_result", "callId": v.tool_call_id.unwrap_or_default(), "name": v.tool_name.unwrap_or_default(), "output": v.result, "isError": v.status.as_deref() == Some("failed") })
        }
        AgentItemPayload::Interruption(v) => json!({ "kind": "interruption", "interruption": v }),
        AgentItemPayload::Error(v) => {
            json!({ "kind": "error", "message": v.get("message").cloned().unwrap_or_else(|| json!("Agent run failed.")), "category": v.get("category").cloned().unwrap_or_else(|| json!("provider")), "code": v.get("code").cloned().unwrap_or_else(|| json!("agent_run_failed")), "retryable": v.get("retryable").cloned().unwrap_or(Value::Bool(true)) })
        }
    };
    object.extend(fields.as_object().cloned().expect("fields object"));
    Ok(Value::Object(object))
}

fn session_workspace(app: &AppHandle, session_id: Option<&str>) -> Result<PathBuf, AppError> {
    let root = crate::app_paths::app_data_dir(app)
        .map_err(|error| AppError::new("agent_workspace_failed", error.to_string()))?
        .join("agent-workspaces");
    Ok(session_id.map_or_else(
        || root.join(uuid::Uuid::new_v4().to_string()),
        |id| root.join(id),
    ))
}

fn staged_agent_attachments_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(crate::app_paths::app_data_dir(app)
        .map_err(|error| AppError::new("agent_attachment_staging_failed", error.to_string()))?
        .join(STAGED_AGENT_ATTACHMENTS_DIR))
}

fn validate_staged_attachment_size(size: usize) -> Result<(), AppError> {
    if size > MAX_STAGED_AGENT_ATTACHMENT_BYTES {
        return Err(AppError::new(
            "agent_attachment_staging_denied",
            "Dropped files must be 50 MB or smaller.",
        ));
    }
    Ok(())
}

fn validate_staged_attachment_file_name(raw_name: &str) -> Result<String, AppError> {
    let name = raw_name;
    let is_safe_bare_name = !name.trim().is_empty()
        && name.len() <= 255
        && name.chars().count() <= 255
        && !name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
        && matches!(
            Path::new(name).components().next(),
            Some(Component::Normal(_))
        )
        && Path::new(name).components().count() == 1;
    if !is_safe_bare_name {
        return Err(AppError::new(
            "agent_attachment_staging_invalid",
            "The dropped file does not have a usable filename.",
        ));
    }
    Ok(name.to_string())
}

fn prepare_staged_agent_attachments_root(root: &Path, incoming_bytes: u64) -> Result<(), AppError> {
    fs::create_dir_all(root).map_err(staging_error)?;
    if count_canonical_staging_directories(root)? >= MAX_STAGED_AGENT_ATTACHMENT_DIRECTORIES {
        return Err(AppError::new(
            "agent_attachment_staging_denied",
            "Clovy has too many temporary attachments. Remove attachments or try again later.",
        ));
    }
    let staged_bytes = directory_bytes_without_following_symlinks(root)?;
    if staged_bytes.saturating_add(incoming_bytes) > MAX_STAGED_AGENT_ATTACHMENT_TOTAL_BYTES {
        return Err(AppError::new(
            "agent_attachment_staging_denied",
            "Clovy's temporary attachment storage is full. Remove attachments or try again later.",
        ));
    }
    Ok(())
}

fn count_canonical_staging_directories(root: &Path) -> Result<usize, AppError> {
    let mut count = 0;
    for entry in fs::read_dir(root).map_err(staging_error)? {
        let entry = entry.map_err(staging_error)?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !is_canonical_staging_uuid(&name) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(staging_error)?;
        if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
            count += 1;
        }
    }
    Ok(count)
}

fn protected_staging_parents(root: &Path, paths: &[String]) -> HashSet<PathBuf> {
    paths
        .iter()
        .filter_map(|path| staged_attachment_parent_for_path(root, Path::new(path)))
        .collect()
}

fn prune_expired_staged_agent_attachments(
    root: &Path,
    now: SystemTime,
    protected: &HashSet<PathBuf>,
) -> Result<(), AppError> {
    let canonical_root = root.canonicalize().map_err(staging_error)?;
    for entry in fs::read_dir(&canonical_root).map_err(staging_error)? {
        let entry = entry.map_err(staging_error)?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !is_canonical_staging_uuid(&name) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(staging_error)?;
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        if protected.contains(&entry.path()) {
            continue;
        }
        let expired = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= STAGED_AGENT_ATTACHMENT_TTL);
        if expired {
            fs::remove_dir_all(entry.path()).map_err(staging_error)?;
        }
    }
    Ok(())
}

fn directory_bytes_without_following_symlinks(path: &Path) -> Result<u64, AppError> {
    let mut total = 0_u64;
    for entry in fs::read_dir(path).map_err(staging_error)? {
        let entry = entry.map_err(staging_error)?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(staging_error)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_file() {
            total = total.saturating_add(metadata.len());
        } else if metadata.is_dir() {
            total =
                total.saturating_add(directory_bytes_without_following_symlinks(&entry.path())?);
        }
    }
    Ok(total)
}

fn is_canonical_staging_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

fn staged_attachment_parent_for_path(root: &Path, path: &Path) -> Option<PathBuf> {
    let canonical_root = root.canonicalize().ok()?;
    let canonical_path = path.canonicalize().ok()?;
    let mut components = canonical_path
        .strip_prefix(&canonical_root)
        .ok()?
        .components();
    let parent = components.next()?.as_os_str().to_str()?;
    is_canonical_staging_uuid(parent).then_some(())?;
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return None;
    }
    Some(canonical_root.join(parent))
}

fn staging_error(error: std::io::Error) -> AppError {
    AppError::new("agent_attachment_staging_failed", error.to_string())
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new("agent_workspace_failed", error.to_string())
}

async fn inherit_session_profile(
    transaction: &mut sqlx::transaction::Transaction<'_, sqlx_sqlite::Sqlite>,
    source_session_id: &str,
    branch_session_id: &str,
    assigned_at: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query::query(
        "INSERT INTO session_profiles (session_id, profile, assigned_at)
         VALUES (?, COALESCE((SELECT profile FROM session_profiles WHERE session_id = ?), 'default'), ?)",
    )
    .bind(branch_session_id)
    .bind(source_session_id)
    .bind(assigned_at)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn prepare_attachments(
    source_paths: &[String],
    supplied_metadata: &[AttachmentMetadataInput],
    workspace: &std::path::Path,
) -> Result<Vec<MessageAttachmentPayload>, AppError> {
    if source_paths.is_empty() {
        return Ok(Vec::new());
    }
    if !supplied_metadata.is_empty() && supplied_metadata.len() != source_paths.len() {
        return Err(AppError::new(
            "agent_attachment_invalid",
            "Attachment metadata does not match the selected files.",
        ));
    }
    let destination_root = workspace.join("attachments");
    tokio::fs::create_dir_all(&destination_root)
        .await
        .map_err(io_error)?;
    let canonical_workspace = workspace.canonicalize().map_err(io_error)?;
    let mut attachments = Vec::with_capacity(source_paths.len());
    for (index, source_path) in source_paths.iter().enumerate() {
        let source = PathBuf::from(source_path)
            .canonicalize()
            .map_err(io_error)?;
        if !source.is_file() {
            return Err(AppError::new(
                "agent_attachment_invalid",
                "Attachment source is not a file.",
            ));
        }
        let name = supplied_metadata
            .get(index)
            .map(|metadata| metadata.name.trim())
            .or_else(|| source.file_name().and_then(|value| value.to_str()))
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 255
                    && !value
                        .chars()
                        .any(|character| character.is_control() || matches!(character, '/' | '\\'))
            })
            .ok_or_else(|| {
                AppError::new(
                    "agent_attachment_invalid",
                    "Attachment source has no valid file name.",
                )
            })?
            .to_string();
        let destination = if source.starts_with(&canonical_workspace) {
            source
        } else {
            let destination = destination_root.join(format!("{}-{name}", uuid::Uuid::new_v4()));
            tokio::fs::copy(&source, &destination)
                .await
                .map_err(io_error)?;
            destination
        };
        let metadata = tokio::fs::metadata(&destination).await.map_err(io_error)?;
        attachments.push(MessageAttachmentPayload {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            path: destination.to_string_lossy().into_owned(),
            mime_type: supplied_metadata
                .get(index)
                .and_then(|metadata| metadata.media_type.clone())
                .or_else(|| attachment_mime_type(&destination).map(str::to_string)),
            size_bytes: metadata.len() as i64,
            available: true,
            created_at: chrono::Utc::now().to_rfc3339(),
        });
    }
    Ok(attachments)
}

async fn persist_attachments(
    repository: &AgentRepository,
    session_id: &str,
    run_id: &str,
    item_id: &str,
    attachments: &[MessageAttachmentPayload],
    original_paths: &[String],
) -> Result<(), AppError> {
    for (index, attachment) in attachments.iter().enumerate() {
        sqlx::query::query(
            "INSERT INTO agent_artifacts (
                id, session_id, run_id, item_id, provenance, action, path,
                original_path, display_name, mime_type, size_bytes, available, created_at
             ) VALUES (?, ?, ?, ?, 'attachment', 'imported', ?, ?, ?, ?, ?, 1, ?)",
        )
        .bind(&attachment.id)
        .bind(session_id)
        .bind(run_id)
        .bind(item_id)
        .bind(&attachment.path)
        .bind(original_paths.get(index))
        .bind(&attachment.name)
        .bind(&attachment.mime_type)
        .bind(attachment.size_bytes)
        .bind(&attachment.created_at)
        .execute(&repository.pool)
        .await?;
    }
    Ok(())
}

fn message_with_attachment_context(
    message: &str,
    attachments: &[MessageAttachmentPayload],
) -> String {
    if attachments.is_empty() {
        return message.to_string();
    }
    let manifest = attachments
        .iter()
        .map(|attachment| format!("- {} ({})", attachment.name, attachment.path))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "[Clovy attachment manifest v1]\nThe following files are available locally. Use Clovy's file tools to inspect them when needed:\n{manifest}\n\n{message}"
    )
}

fn runtime_attachment(attachment: &MessageAttachmentPayload) -> Value {
    json!({
        "path": attachment.path,
        "mimeType": attachment.mime_type,
        "sizeBytes": attachment.size_bytes,
    })
}

fn retain_recent_vision_attachments(history: &mut [Value], mut remaining_bytes: i64) {
    for item in history.iter_mut().rev() {
        let Some(attachments) = item.get_mut("attachments").and_then(Value::as_array_mut) else {
            continue;
        };
        attachments.retain(|attachment| {
            let is_vision = attachment
                .get("mimeType")
                .and_then(Value::as_str)
                .is_some_and(is_supported_vision_mime_type);
            if !is_vision {
                return true;
            }
            let bytes = attachment
                .get("sizeBytes")
                .and_then(Value::as_i64)
                .unwrap_or(MAX_INLINE_VISION_BYTES + 1)
                .max(0);
            if bytes > remaining_bytes {
                return false;
            }
            remaining_bytes -= bytes;
            true
        });
    }
}

fn is_supported_vision_mime_type(mime_type: &str) -> bool {
    matches!(
        mime_type,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}

fn attachment_mime_type(path: &std::path::Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "tif" | "tiff" => Some("image/tiff"),
        "pdf" => Some("application/pdf"),
        "json" => Some("application/json"),
        "csv" => Some("text/csv"),
        "md" => Some("text/markdown"),
        "txt" => Some("text/plain"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_display_name_strips_the_internal_copy_prefix() {
        assert_eq!(
            artifact_display_name(
                "/workspace/attachments/1fb34e2e-e4e7-45d7-b538-a87aefa4c8e4-Pool Day.pdf",
                Some("/tmp/companion/content"),
                "attachment",
                None,
            ),
            "Pool Day.pdf"
        );
    }

    #[test]
    fn attachment_display_name_falls_back_to_the_original_path() {
        assert_eq!(
            artifact_display_name(
                "/workspace/attachments/staged-content",
                Some("/Users/andrew/Documents/Pool Day.pdf"),
                "attachment",
                None,
            ),
            "Pool Day.pdf"
        );
    }

    #[test]
    fn attachment_display_name_strips_copy_prefixes_from_repeated_branches() {
        assert_eq!(
            artifact_display_name(
                "/workspace/artifacts/9bc2de72-d7b9-4f2a-ae01-cce9bacb2664-1fb34e2e-e4e7-45d7-b538-a87aefa4c8e4-Pool Day.pdf",
                Some("/Users/andrew/Documents/Pool Day.pdf"),
                "attachment",
                None,
            ),
            "Pool Day.pdf"
        );
    }

    #[test]
    fn attachment_display_name_preserves_a_uuid_prefixed_original_name() {
        assert_eq!(
            artifact_display_name(
                "/workspace/attachments/1fb34e2e-e4e7-45d7-b538-a87aefa4c8e4-9bc2de72-d7b9-4f2a-ae01-cce9bacb2664-notes.pdf",
                Some("/Users/andrew/Documents/9bc2de72-d7b9-4f2a-ae01-cce9bacb2664-notes.pdf"),
                "attachment",
                None,
            ),
            "9bc2de72-d7b9-4f2a-ae01-cce9bacb2664-notes.pdf"
        );
    }

    #[test]
    fn attachment_display_name_prefers_the_persisted_metadata_name() {
        let path = "/workspace/attachments/1fb34e2e-e4e7-45d7-b538-a87aefa4c8e4-9bc2de72-d7b9-4f2a-ae01-cce9bacb2664-notes.pdf";
        let persisted_name = "9bc2de72-d7b9-4f2a-ae01-cce9bacb2664-notes.pdf";

        assert_eq!(
            artifact_display_name(
                path,
                Some("/tmp/companion/content"),
                "attachment",
                Some(persisted_name),
            ),
            persisted_name
        );
    }

    #[test]
    fn generated_artifact_display_name_keeps_its_workspace_name() {
        assert_eq!(
            artifact_display_name(
                "/workspace/artifacts/generated-report.pdf",
                Some("/Users/andrew/Documents/source.pdf"),
                "tool",
                None,
            ),
            "generated-report.pdf"
        );
    }

    #[test]
    fn staged_attachment_file_names_must_be_safe_bare_names() {
        for name in ["brief.pdf", "Résumé.pdf", " spaced name.txt "] {
            assert!(
                validate_staged_attachment_file_name(name).is_ok(),
                "{name:?}"
            );
        }
        for name in [
            "",
            "..",
            "../brief.pdf",
            "folder/brief.pdf",
            "folder\\brief.pdf",
            "a\n.txt",
        ] {
            assert!(
                validate_staged_attachment_file_name(name).is_err(),
                "{name:?} should be rejected"
            );
        }
        assert!(validate_staged_attachment_file_name(&"a".repeat(256)).is_err());
        assert!(validate_staged_attachment_file_name(&"é".repeat(128)).is_err());
    }

    #[test]
    fn staged_attachment_bytes_are_limited_to_50_mib() {
        assert!(validate_staged_attachment_size(MAX_STAGED_AGENT_ATTACHMENT_BYTES).is_ok());
        assert!(validate_staged_attachment_size(MAX_STAGED_AGENT_ATTACHMENT_BYTES + 1).is_err());
    }

    #[test]
    fn only_uuid_staging_parents_can_be_discarded() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let root = temporary.path().join(STAGED_AGENT_ATTACHMENTS_DIR);
        let id = uuid::Uuid::new_v4();
        let parent = root.join(id.to_string());
        std::fs::create_dir_all(&parent).expect("staging parent");
        let attachment = parent.join("brief.pdf");
        std::fs::write(&attachment, b"brief").expect("staged file");

        assert_eq!(
            staged_attachment_parent_for_path(&root, &attachment),
            Some(parent.canonicalize().expect("canonical staging parent"))
        );

        let non_staged = root.join("not-a-uuid").join("brief.pdf");
        std::fs::create_dir_all(non_staged.parent().expect("parent")).expect("non-staged parent");
        std::fs::write(&non_staged, b"brief").expect("non-staged file");
        assert_eq!(staged_attachment_parent_for_path(&root, &non_staged), None);

        let external = temporary.path().join("picker.pdf");
        std::fs::write(&external, b"picker").expect("picker file");
        assert_eq!(staged_attachment_parent_for_path(&root, &external), None);
    }

    #[test]
    fn staging_prunes_only_expired_unprotected_uuid_directories() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let root = temporary.path().join(STAGED_AGENT_ATTACHMENTS_DIR);
        fs::create_dir_all(&root).expect("staging root");
        let expired = root.join(uuid::Uuid::new_v4().to_string());
        let protected = root.join(uuid::Uuid::new_v4().to_string());
        let invalid = root.join("keep-this-directory");
        let noncanonical_uuid = root.join(uuid::Uuid::new_v4().simple().to_string());
        fs::create_dir_all(&expired).expect("expired staging directory");
        fs::create_dir_all(&protected).expect("protected staging directory");
        fs::create_dir_all(&invalid).expect("invalid staging directory");
        fs::create_dir_all(&noncanonical_uuid).expect("noncanonical UUID directory");
        fs::write(expired.join("brief.pdf"), b"brief").expect("expired attachment");
        let protected_attachment = protected.join("live.pdf");
        fs::write(&protected_attachment, b"live").expect("protected attachment");
        let external_attachment = temporary.path().join("external.pdf");
        fs::write(&external_attachment, b"external").expect("external attachment");
        fs::write(invalid.join("notes.txt"), b"notes").expect("invalid attachment");
        let modified = fs::symlink_metadata(&expired)
            .expect("expired metadata")
            .modified()
            .expect("modified time");

        let protected_parents = protected_staging_parents(
            &root,
            &[
                protected_attachment.to_string_lossy().into_owned(),
                external_attachment.to_string_lossy().into_owned(),
                expired
                    .join("nested")
                    .join("malformed.pdf")
                    .to_string_lossy()
                    .into_owned(),
            ],
        );
        prune_expired_staged_agent_attachments(
            &root,
            modified + STAGED_AGENT_ATTACHMENT_TTL + Duration::from_secs(1),
            &protected_parents,
        )
        .expect("prune staging");

        assert!(!expired.exists());
        assert!(protected.exists());
        assert!(invalid.exists());
        assert!(noncanonical_uuid.exists());
    }

    #[test]
    fn staging_quota_allows_a_legal_eight_file_batch_and_rejects_overflow() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let root = temporary.path().join(STAGED_AGENT_ATTACHMENTS_DIR);
        fs::create_dir_all(&root).expect("staging root");
        let parent = root.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&parent).expect("staging directory");
        let staged = fs::File::create(parent.join("existing.bin")).expect("staged file");
        staged
            .set_len(MAX_STAGED_AGENT_ATTACHMENT_TOTAL_BYTES - 8 * 50 * 1024 * 1024)
            .expect("sparse staged file");

        prepare_staged_agent_attachments_root(&root, 8 * 50 * 1024 * 1024)
            .expect("legal batch fits");
        assert!(prepare_staged_agent_attachments_root(&root, 8 * 50 * 1024 * 1024 + 1).is_err());
    }

    #[test]
    fn staging_directory_count_allows_128_total_and_rejects_more() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let root = temporary.path().join(STAGED_AGENT_ATTACHMENTS_DIR);
        fs::create_dir_all(&root).expect("staging root");
        let mut canonical_directories = Vec::new();
        for _ in 0..MAX_STAGED_AGENT_ATTACHMENT_DIRECTORIES {
            let directory = root.join(uuid::Uuid::new_v4().to_string());
            fs::create_dir(&directory).expect("canonical staging directory");
            canonical_directories.push(directory);
        }
        fs::create_dir(root.join("not-a-staging-directory")).expect("invalid directory");

        assert_eq!(
            count_canonical_staging_directories(&root).expect("count staging directories"),
            MAX_STAGED_AGENT_ATTACHMENT_DIRECTORIES
        );
        assert!(prepare_staged_agent_attachments_root(&root, 0).is_err());

        fs::remove_dir(canonical_directories.pop().expect("canonical directory"))
            .expect("remove one staging directory");
        prepare_staged_agent_attachments_root(&root, 0)
            .expect("one more staging directory is legal");
    }

    #[cfg(unix)]
    #[test]
    fn staging_cleanup_does_not_follow_uuid_symlinks() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().expect("temporary directory");
        let root = temporary.path().join(STAGED_AGENT_ATTACHMENTS_DIR);
        let external = temporary.path().join("outside");
        fs::create_dir_all(&root).expect("staging root");
        fs::create_dir_all(&external).expect("external directory");
        fs::write(external.join("keep.txt"), b"keep").expect("external file");
        let link = root.join(uuid::Uuid::new_v4().to_string());
        symlink(&external, &link).expect("uuid symlink");

        prune_expired_staged_agent_attachments(
            &root,
            SystemTime::now() + STAGED_AGENT_ATTACHMENT_TTL + Duration::from_secs(1),
            &HashSet::new(),
        )
        .expect("prune staging");

        assert!(link.exists());
        assert_eq!(
            fs::read(external.join("keep.txt")).expect("external file"),
            b"keep"
        );
        assert_eq!(
            directory_bytes_without_following_symlinks(&root).unwrap(),
            0
        );
        assert_eq!(count_canonical_staging_directories(&root).unwrap(), 0);
    }

    #[test]
    fn extracts_a_concrete_model_from_persisted_usage() {
        let usage = json!({ "resolvedModel": " z-ai/glm-5.2 " });
        assert_eq!(
            resolved_model_from_usage(Some(&usage)),
            Some("z-ai/glm-5.2")
        );
        assert_eq!(
            resolved_model_from_usage(Some(&json!({ "resolvedModel": "open-software/auto" }))),
            None
        );
        assert_eq!(
            resolved_model_from_usage(Some(
                &json!({ "resolvedModel": "__june_auto_generation__:73" })
            )),
            None
        );
        assert_eq!(
            resolved_model_from_usage(Some(
                &json!({ "resolvedModel": "__june_local_generation__:z-ai%2Fglm-5.2" })
            )),
            None
        );
        assert_eq!(
            resolved_model_from_usage(Some(&json!({ "resolvedModel": "z-ai/glm 5.2" }))),
            None
        );
        assert_eq!(
            resolved_model_from_usage(Some(&json!({ "resolvedModel": 42 }))),
            None
        );
        assert_eq!(resolved_model_from_usage(None), None);
    }

    #[test]
    fn only_transport_uncertainty_is_an_ambiguous_runtime_dispatch() {
        for code in [
            "agent_runtime_disconnected",
            "agent_runtime_request_timed_out",
        ] {
            assert!(runtime_dispatch_is_ambiguous(&AppError::new(
                code,
                "uncertain"
            )));
        }
        assert!(!runtime_dispatch_is_ambiguous(&AppError::new(
            "agent_runtime_request_failed",
            "rejected"
        )));
        assert!(!runtime_dispatch_is_ambiguous(&AppError::new(
            "agent_protocol_encode_failed",
            "not sent"
        )));
    }

    #[test]
    fn retry_uses_the_prompt_owned_by_the_selected_run() {
        let item = |id: &str, run_id: &str, content: &str, sequence: i64| AgentItemDto {
            id: id.into(),
            session_id: "session-1".into(),
            run_id: Some(run_id.into()),
            sequence,
            payload: AgentItemPayload::UserMessage(super::super::MessagePayload {
                role: "user".into(),
                content: content.into(),
                attachments: vec![],
            }),
            external_id: None,
            created_at: "2026-07-25T00:00:00Z".into(),
        };
        let items = vec![
            item("older", "run-failed", "Retry this", 0),
            item("newer", "run-later", "Do not retry this", 1),
        ];

        assert_eq!(
            retry_message(items, "run-failed").unwrap().content,
            "Retry this"
        );
    }

    #[tokio::test]
    async fn interruption_lookup_uses_the_originating_run_when_sdk_ids_repeat() {
        use sqlx_sqlite::SqlitePoolOptions;

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("memory database");
        crate::db::migrations::run_migrations(&pool)
            .await
            .expect("migrations");
        let repository = AgentRepository::new(pool);
        let session = repository
            .create_session("Approvals", "auto", AgentSafetyMode::Sandboxed, None)
            .await
            .expect("session");
        let old_run = repository
            .create_run(&session.id, "auto", None)
            .await
            .expect("old run");
        let old_item = repository
            .append_item(
                &session.id,
                Some(&old_run.id),
                1,
                &AgentItemPayload::Interruption(json!({
                    "id": "functions.mcp_linear_save_issue:0",
                    "kind": "approval",
                    "runId": old_run.id,
                    "sessionId": session.id,
                    "status": "resolved"
                })),
                Some(&format!(
                    "interruption:{}:functions.mcp_linear_save_issue:0",
                    old_run.id
                )),
            )
            .await
            .expect("old interruption")
            .expect("old interruption inserted");
        repository
            .update_run_status(&old_run.id, "completed", None, None, None)
            .await
            .expect("old run completed");

        let waiting_run = repository
            .create_run(&session.id, "auto", None)
            .await
            .expect("waiting run");
        let waiting_item = repository
            .append_item(
                &session.id,
                Some(&waiting_run.id),
                1,
                &AgentItemPayload::Interruption(json!({
                    "id": "functions.mcp_linear_save_issue:0",
                    "kind": "approval",
                    "runId": waiting_run.id,
                    "sessionId": session.id,
                    "status": "pending"
                })),
                Some(&format!(
                    "interruption:{}:functions.mcp_linear_save_issue:0",
                    waiting_run.id
                )),
            )
            .await
            .expect("waiting interruption")
            .expect("waiting interruption inserted");

        let selected = interruption_record(
            &repository,
            &waiting_run.id,
            "functions.mcp_linear_save_issue:0",
        )
        .await
        .expect("lookup")
        .expect("waiting interruption");

        assert_eq!(selected.item_id, waiting_item.id);
        assert_eq!(selected.run_id, waiting_run.id);
        assert_ne!(selected.item_id, old_item.id);
    }

    #[test]
    fn settled_approval_payload_persists_the_submitted_choice() {
        let mut interruption = json!({
            "id": "functions.mcp_linear_save_issue:0",
            "kind": "approval",
            "status": "pending"
        });

        settle_interruption_payload(
            &mut interruption,
            "approval",
            Some("deny"),
            None,
            None,
            "2026-07-28T00:00:00Z",
        );

        assert_eq!(interruption["status"], "resolved");
        assert_eq!(interruption["resolution"], "deny");
        assert_eq!(interruption["resolvedAt"], "2026-07-28T00:00:00Z");
    }

    #[test]
    fn approval_choice_validation_accepts_known_values_and_fails_closed() {
        assert_eq!(
            approval_choice_from_resolution("approval", &json!({"choice": "always"})),
            Some("always")
        );
        assert_eq!(
            approval_choice_from_resolution("approval", &json!({"choice": "unexpected"})),
            Some("deny")
        );
        assert_eq!(
            approval_choice_from_resolution("approval", &json!({})),
            Some("deny")
        );
        assert_eq!(
            approval_choice_from_resolution("clarification", &json!({"choice": "always"})),
            None
        );
    }

    #[tokio::test]
    async fn interruption_resume_claim_only_accepts_one_resolution() {
        use sqlx::{query::query, row::Row};
        use sqlx_sqlite::SqlitePoolOptions;

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("memory database");
        crate::db::migrations::run_migrations(&pool)
            .await
            .expect("migrations");
        let repository = AgentRepository::new(pool);
        let session = repository
            .create_session("Approval claim", "auto", AgentSafetyMode::Sandboxed, None)
            .await
            .expect("session");
        let run = repository
            .create_run(&session.id, "auto", None)
            .await
            .expect("run");
        repository
            .update_run_status(
                &run.id,
                "waiting_for_user",
                None,
                Some(&json!("serialized")),
                None,
            )
            .await
            .expect("waiting run");
        let item = repository
            .append_item(
                &session.id,
                Some(&run.id),
                1,
                &AgentItemPayload::Interruption(json!({
                    "id": "functions.mcp_linear_save_issue:0",
                    "kind": "approval",
                    "runId": run.id,
                    "sessionId": session.id,
                    "status": "pending"
                })),
                Some(&format!(
                    "interruption:{}:functions.mcp_linear_save_issue:0",
                    run.id
                )),
            )
            .await
            .expect("pending interruption")
            .expect("interruption inserted");
        let original_payload: String = query("SELECT payload_json FROM agent_items WHERE id = ?")
            .bind(&item.id)
            .fetch_one(&repository.pool)
            .await
            .expect("stored interruption")
            .get("payload_json");
        let record = InterruptionRecord {
            item_id: item.id,
            run_id: run.id.clone(),
            session_id: session.id,
            payload_json: original_payload.clone(),
        };
        let first_payload = json!({"status":"resolved","decision":"approve"}).to_string();
        let second_payload = json!({"status":"resolved","decision":"deny"}).to_string();

        let first = claim_interruption_resume(
            &repository,
            &record,
            &original_payload,
            &first_payload,
            "2026-07-28T00:00:00Z",
            Some((
                "device-1",
                "functions.mcp_linear_save_issue:0",
                &record.session_id,
                "approve",
                "2026-07-28T00:00:00Z",
            )),
        )
        .await
        .expect("first claim");
        let second = claim_interruption_resume(
            &repository,
            &record,
            &original_payload,
            &second_payload,
            "2026-07-28T00:00:01Z",
            Some((
                "device-1",
                "functions.mcp_linear_save_issue:0",
                &record.session_id,
                "deny",
                "2026-07-28T00:00:01Z",
            )),
        )
        .await
        .expect("second claim");

        assert!(first);
        assert!(!second);
        assert_eq!(
            repository
                .get_run(&run.id)
                .await
                .expect("claimed run")
                .status,
            "queued"
        );
        let stored_payload: String = query("SELECT payload_json FROM agent_items WHERE id = ?")
            .bind(&record.item_id)
            .fetch_one(&repository.pool)
            .await
            .expect("claimed interruption")
            .get("payload_json");
        assert_eq!(stored_payload, first_payload);
        let audit_decisions: Vec<String> = query(
            "SELECT decision
             FROM companion_computer_use_approval_audit
             WHERE device_id = ? AND request_id = ? AND stored_session_id = ?",
        )
        .bind("device-1")
        .bind("functions.mcp_linear_save_issue:0")
        .bind(&record.session_id)
        .fetch_all(&repository.pool)
        .await
        .expect("approval audit")
        .into_iter()
        .map(|row| row.get("decision"))
        .collect();
        assert_eq!(audit_decisions, vec!["approve"]);
    }

    #[tokio::test]
    async fn branches_inherit_the_source_data_partition() {
        use sqlx::{query::query, row::Row};
        use sqlx_sqlite::SqlitePoolOptions;

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("memory database");
        crate::db::migrations::run_migrations(&pool)
            .await
            .expect("migrations");
        let repository = AgentRepository::new(pool.clone());
        let source = repository
            .create_session_in_profile(
                "Source",
                "auto",
                AgentSafetyMode::Sandboxed,
                None,
                "private",
            )
            .await
            .expect("source");
        let branch = repository
            .create_session("Branch", "auto", AgentSafetyMode::Sandboxed, None)
            .await
            .expect("branch");
        let mut transaction = pool.begin().await.expect("transaction");
        inherit_session_profile(&mut transaction, &source.id, &branch.id, "now")
            .await
            .expect("inherit profile");
        transaction.commit().await.expect("commit");

        let profile: String = query("SELECT profile FROM session_profiles WHERE session_id = ?")
            .bind(&branch.id)
            .fetch_one(&pool)
            .await
            .expect("branch profile")
            .get("profile");
        assert_eq!(profile, "private");
    }

    #[test]
    fn resumable_configuration_excludes_replayed_input_but_keeps_policy() {
        let instructions = crate::agent_runtime::persona::append_persona_instructions(
            "Focused run policy.",
            &crate::agent_runtime::persona::ClovyPersonaSettings {
                schema_version: crate::agent_runtime::persona::CLOVY_PERSONA_SCHEMA_VERSION,
                area: crate::agent_runtime::persona::ClovyPersonaArea::Thinking,
                voice: 45,
                detail: 90,
                initiative: 75,
                humor: 20,
            },
        );
        let config = resumable_run_config(&json!({
            "input": "user prompt",
            "history": [{ "role": "user", "text": "old" }],
            "instructions": instructions,
            "tools": [{ "name": "read_file" }]
        }));
        assert!(config.get("input").is_none());
        assert!(config.get("history").is_none());
        assert!(config["instructions"].as_str().is_some_and(|instructions| {
            instructions.contains("Depth 90/100")
                && instructions.contains("Instruction order and untrusted content")
        }));
        assert_eq!(config["tools"][0]["name"], "read_file");
    }

    #[tokio::test]
    async fn supplied_attachment_name_and_media_type_survive_workspace_copy() {
        let source_directory = tempfile::tempdir().expect("source directory");
        let workspace = tempfile::tempdir().expect("workspace");
        let source = source_directory.path().join("brief.md");
        tokio::fs::write(&source, "# Brief")
            .await
            .expect("source attachment");

        let attachments = prepare_attachments(
            &[source.to_string_lossy().into_owned()],
            &[AttachmentMetadataInput {
                name: "launch-brief.custom".to_string(),
                media_type: Some("application/x-clovy-brief".to_string()),
            }],
            workspace.path(),
        )
        .await
        .expect("prepared attachments");

        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].name, "launch-brief.custom");
        assert_eq!(
            attachments[0].mime_type.as_deref(),
            Some("application/x-clovy-brief")
        );
        assert!(PathBuf::from(&attachments[0].path).starts_with(workspace.path()));
        assert_eq!(
            tokio::fs::read_to_string(&attachments[0].path)
                .await
                .expect("copied attachment"),
            "# Brief"
        );
        let input = message_with_attachment_context("Summarize this.", &attachments);
        assert!(input.starts_with("[Clovy attachment manifest v1]"));
        assert!(input.contains("launch-brief.custom"));
        assert!(input.contains(&attachments[0].path));
        assert!(input.ends_with("Summarize this."));
    }

    #[test]
    fn messages_without_attachments_keep_their_original_model_input() {
        assert_eq!(
            message_with_attachment_context("Hello", &[]),
            "Hello".to_string()
        );
    }

    #[test]
    fn skill_catalog_uses_frontmatter_description_instead_of_metadata_keys() {
        assert_eq!(
            skill_description(
                "---\nname: pr920-proof\ndescription: \"Readable managed skill summary.\"\n---\n\n# Proof\nBody"
            )
            .as_deref(),
            Some("Readable managed skill summary.")
        );
    }

    #[tokio::test]
    async fn obsidian_aliases_collapse_to_one_canonical_catalog_entry() {
        let root = tempfile::tempdir().expect("managed skill root");
        for (skill_id, description) in [
            ("clovy-obsidian", "Canonical instructions"),
            ("june-obsidian", "Legacy instructions"),
        ] {
            let path = skill_file(root.path(), skill_id);
            std::fs::create_dir_all(path.parent().expect("skill parent")).expect("skill directory");
            std::fs::write(
                path,
                format!("---\nname: {skill_id}\ndescription: {description}\n---\n"),
            )
            .expect("skill file");
        }
        let overrides = HashMap::from([("clovy-obsidian".to_string(), false)]);

        let catalog =
            agent_skill_catalog_from_roots(vec![(root.path().to_path_buf(), true)], &overrides)
                .await
                .expect("skill catalog");

        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0]["id"], "clovy-obsidian");
        assert_eq!(catalog[0]["name"], "clovy-obsidian");
        assert_eq!(catalog[0]["description"], "Canonical instructions");
        assert_eq!(catalog[0]["enabled"], false);
    }

    #[tokio::test]
    async fn canonical_obsidian_edits_are_written_to_the_rollback_alias_first() {
        let root = tempfile::tempdir().expect("managed skill root");

        write_managed_skill_content(root.path(), "clovy-obsidian", "edited instructions")
            .await
            .expect("dual-write skill");

        for skill_id in ["clovy-obsidian", "june-obsidian"] {
            let content = tokio::fs::read_to_string(skill_file(root.path(), skill_id))
                .await
                .expect("skill alias");
            assert!(content.contains(&format!("name: {skill_id}")));
            assert!(content.ends_with("edited instructions"));
        }
    }

    #[test]
    fn bundled_obsidian_skill_has_correct_tool_reference_and_frontmatter() {
        let skill_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("agent-skills")
            .join("clovy-obsidian")
            .join("SKILL.md");
        let content = std::fs::read_to_string(&skill_path)
            .unwrap_or_else(|_| panic!("skill file should exist at {}", skill_path.display()));
        assert!(
            content.contains("get_obsidian_vault"),
            "skill must reference the unprefixed get_obsidian_vault host tool"
        );
        assert!(
            !content.contains("june_obsidian.get_obsidian_vault"),
            "skill must not reference the retired june_obsidian MCP server prefix"
        );
        assert!(content.contains("name: clovy-obsidian"));
        assert_eq!(
            skill_description(&content).as_deref(),
            Some("Work with the Obsidian vault currently selected in Clovy.")
        );
    }

    #[test]
    fn legacy_auto_alias_uses_the_priced_clovy_model_id() {
        assert_eq!(
            normalize_agent_model("auto"),
            crate::providers::AUTO_GENERATION_MODEL
        );
        assert_eq!(
            normalize_agent_model(" open-software/auto "),
            crate::providers::AUTO_GENERATION_MODEL
        );
        assert_eq!(normalize_agent_model("kimi-k2-6"), "kimi-k2-6");
    }

    #[test]
    fn output_reserve_is_clamped_for_small_context_windows() {
        assert_eq!(agent_model_output_reserve(8_192), 2_048);
        assert_eq!(agent_model_output_reserve(16_000), 4_000);
        assert_eq!(agent_model_output_reserve(128_000), 8_192);
    }

    #[test]
    fn context_summaries_reenter_runtime_history_as_user_data_with_metadata() {
        let history = history_item(AgentItemDto {
            id: "summary-1".into(),
            session_id: "session-1".into(),
            run_id: Some("run-1".into()),
            sequence: 1,
            payload: AgentItemPayload::ContextSummary(super::super::TextPayload {
                text: "Earlier context".into(),
                metadata: Some(json!({ "fallback": true })),
            }),
            external_id: Some("context-summary:run-1".into()),
            created_at: "2026-07-27T12:00:00Z".into(),
        })
        .expect("runtime summary");

        assert_eq!(history["kind"], "context_summary");
        assert_eq!(history["role"], "user");
        assert_eq!(history["metadata"]["fallback"], true);
    }

    #[test]
    fn persisted_attachment_items_expose_complete_artifact_identity() {
        let item = AgentItemDto {
            id: "message-1".into(),
            session_id: "session-1".into(),
            run_id: Some("run-1".into()),
            sequence: 1,
            payload: AgentItemPayload::UserMessage(super::super::MessagePayload {
                role: "user".into(),
                content: "Read this.".into(),
                attachments: vec![MessageAttachmentPayload {
                    id: "attachment-1".into(),
                    name: "brief.md".into(),
                    path: "/workspace/attachments/brief.md".into(),
                    mime_type: Some("text/markdown".into()),
                    size_bytes: 42,
                    available: true,
                    created_at: "2026-07-24T12:00:00Z".into(),
                }],
            }),
            external_id: Some("user:run-1".into()),
            created_at: "2026-07-24T12:00:00Z".into(),
        };

        let history = history_item(item.clone()).expect("runtime history");
        let value = item_json_with_active_run(item, None).expect("public item");
        assert_eq!(value["attachments"][0]["sessionId"], "session-1");
        assert_eq!(value["attachments"][0]["runId"], "run-1");
        assert_eq!(value["attachments"][0]["itemId"], "message-1");
        assert_eq!(value["attachments"][0]["action"], "imported");
        assert_eq!(
            history["attachments"][0]["path"],
            "/workspace/attachments/brief.md"
        );
        assert_eq!(history["attachments"][0]["mimeType"], "text/markdown");
        assert_eq!(history["attachments"][0]["sizeBytes"], 42);
    }

    #[test]
    fn active_stream_items_keep_runtime_identity_and_streaming_status() {
        let item = AgentItemDto {
            id: "database-item-1".into(),
            session_id: "session-1".into(),
            run_id: Some("run-1".into()),
            sequence: 1,
            payload: AgentItemPayload::AssistantMessage(super::super::MessagePayload {
                role: "assistant".into(),
                content: "Everything emitted so far".into(),
                attachments: vec![],
            }),
            external_id: Some("assistant:run-1".into()),
            created_at: "2026-07-24T12:00:00Z".into(),
        };

        let active =
            item_json_with_active_run(item.clone(), Some("run-1")).expect("active public item");
        assert_eq!(active["id"], "assistant:run-1");
        assert_eq!(active["status"], "streaming");
        assert_eq!(active["text"], "Everything emitted so far");

        let completed = item_json_with_active_run(item, None).expect("completed public item");
        assert_eq!(completed["id"], "database-item-1");
        assert_eq!(completed["status"], "complete");

        let user = item_json_with_active_run(
            AgentItemDto {
                id: "user-item-1".into(),
                session_id: "session-1".into(),
                run_id: Some("run-1".into()),
                sequence: 0,
                payload: AgentItemPayload::UserMessage(super::super::MessagePayload {
                    role: "user".into(),
                    content: "Keep this complete".into(),
                    attachments: vec![],
                }),
                external_id: Some("user:run-1".into()),
                created_at: "2026-07-24T11:59:59Z".into(),
            },
            Some("run-1"),
        )
        .expect("active user item");
        assert_eq!(user["id"], "user-item-1");
        assert_eq!(user["status"], "complete");
    }

    #[test]
    fn persisted_tool_groups_continue_as_agents_sdk_history() {
        let tool_call = history_item(AgentItemDto {
            id: "tool-call-1".into(),
            session_id: "session-1".into(),
            run_id: Some("run-1".into()),
            sequence: 1,
            payload: AgentItemPayload::ToolCall(super::super::ToolPayload {
                tool_name: Some("list_files".into()),
                tool_call_id: Some("call-1".into()),
                arguments: Some(json!({"path":"."})),
                result: None,
                status: Some("complete".into()),
            }),
            external_id: None,
            created_at: "2026-07-24T12:00:00Z".into(),
        })
        .expect("tool call history");
        let tool_result = history_item(AgentItemDto {
            id: "tool-result-1".into(),
            session_id: "session-1".into(),
            run_id: Some("run-1".into()),
            sequence: 2,
            payload: AgentItemPayload::ToolResult(super::super::ToolPayload {
                tool_name: Some("list_files".into()),
                tool_call_id: Some("call-1".into()),
                arguments: None,
                result: Some(json!({"files":["brief.md"]})),
                status: Some("complete".into()),
            }),
            external_id: None,
            created_at: "2026-07-24T12:00:01Z".into(),
        })
        .expect("tool result history");

        assert_eq!(tool_call["groupId"], "call-1");
        assert_eq!(tool_call["payload"]["type"], "function_call");
        assert_eq!(tool_call["payload"]["arguments"], r#"{"path":"."}"#);
        assert_eq!(tool_result["groupId"], "call-1");
        assert_eq!(tool_result["payload"]["type"], "function_call_result");
        assert_eq!(
            tool_result["payload"]["output"],
            r#"{"files":["brief.md"]}"#
        );
    }

    #[test]
    fn consumed_steering_is_visible_and_replayed_as_user_context() {
        let item = AgentItemDto {
            id: "c896c2a5-7cd1-4695-870d-707fdbcb4abf".into(),
            session_id: "session-1".into(),
            run_id: Some("run-1".into()),
            sequence: 3,
            payload: AgentItemPayload::Steering(super::super::TextPayload {
                text: "Use the launch plan".into(),
                metadata: None,
            }),
            external_id: Some("steering:message-1".into()),
            created_at: "2026-07-24T12:00:02Z".into(),
        };

        let history = history_item(item.clone()).expect("runtime history");
        let active =
            item_json_with_active_run(item.clone(), Some("run-1")).expect("active public item");
        let completed = item_json_with_active_run(item, None).expect("completed public item");

        assert_eq!(history["kind"], "message");
        assert_eq!(history["role"], "user");
        assert_eq!(history["text"], "Use the launch plan");
        assert_eq!(active["id"], "steering:message-1");
        assert_eq!(active["kind"], "steering");
        assert_eq!(active["text"], "Use the launch plan");
        assert_eq!(completed["id"], "steering:message-1");
        assert_eq!(completed["kind"], "steering");
        assert_eq!(completed["text"], "Use the launch plan");
    }

    #[test]
    fn retry_history_excludes_every_item_from_the_failed_run() {
        let item = |id: &str, run_id: &str, content: &str| AgentItemDto {
            id: id.into(),
            session_id: "session-1".into(),
            run_id: Some(run_id.into()),
            sequence: 0,
            payload: AgentItemPayload::UserMessage(super::super::MessagePayload {
                role: "user".into(),
                content: content.into(),
                attachments: Vec::new(),
            }),
            external_id: None,
            created_at: "2026-07-25T12:00:00Z".into(),
        };
        let history = runtime_history(
            vec![
                item("prior", "run-prior", "Earlier request"),
                item("failed", "run-failed", "Retry this once"),
            ],
            Some("run-failed"),
        );

        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["text"], "Earlier request");
    }

    #[test]
    fn vision_budget_keeps_recent_images_and_drops_oversized_history() {
        let mut history = vec![
            json!({ "attachments": [{ "path": "/old.png", "mimeType": "image/png", "sizeBytes": 4 * 1024 * 1024 }] }),
            json!({ "attachments": [{ "path": "/new.png", "mimeType": "image/png", "sizeBytes": 3 * 1024 * 1024 }] }),
        ];

        retain_recent_vision_attachments(&mut history, MAX_INLINE_VISION_BYTES);

        assert_eq!(history[0]["attachments"], json!([]));
        assert_eq!(history[1]["attachments"][0]["path"], "/new.png");
    }
}
