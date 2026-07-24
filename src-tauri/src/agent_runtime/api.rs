use super::{
    AgentItemDto, AgentItemPayload, AgentRepository, AgentRuntimeHost, AgentSafetyMode,
    MessageAttachmentPayload,
};
use crate::domain::types::AppError;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf};
use tauri::{AppHandle, State};

const INSTRUCTIONS: &str = "You are June, a private personal AI assistant. Use the tools provided by the June app when they help answer the user's request. Never claim a tool succeeded unless its result confirms success.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    pub title: Option<String>,
    pub model: String,
    pub safety_mode: AgentSafetyMode,
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
    pub safety_mode: AgentSafetyMode,
    pub workspace_path: String,
    #[serde(default)]
    pub enabled_skill_ids: Vec<String>,
    #[serde(default)]
    pub attachments: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveInterruptionRequest {
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
pub struct ReadArtifactRequest {
    pub path: String,
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
        .create_session(
            request.title.as_deref().unwrap_or("New session"),
            &model,
            request.safety_mode,
            workspace.to_str(),
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
pub async fn delete_agent_session(app: AppHandle, session_id: String) -> Result<(), AppError> {
    repository(&app).await?.delete_session(&session_id).await?;
    Ok(())
}

#[tauri::command]
pub async fn list_agent_items(app: AppHandle, session_id: String) -> Result<Vec<Value>, AppError> {
    repository(&app)
        .await?
        .items(&session_id)
        .await?
        .into_iter()
        .map(item_json)
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
    let prepared_attachments =
        prepare_attachments(&request.attachments, std::path::Path::new(&workspace)).await?;
    let run = repository.create_run(&session.id, &model).await?;
    let params = run_params(
        &app,
        &repository,
        RunParamsInput {
            session_id: &session.id,
            run_id: &run.id,
            model: &model,
            safety_mode: request.safety_mode,
            workspace: &workspace,
            input: &request.prompt,
            skills: &request.enabled_skill_ids,
            attachments: &prepared_attachments,
        },
    )
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
    host.ensure_started(&app, repository.clone()).await?;
    host.request("run.start", &session.id, &run.id, params)
        .await?;
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
    host.request("run.cancel", &run.session_id, &run.id, json!({}))
        .await?;
    host.cancel_run_streams(&run.id).await;
    Ok(())
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
    let message = repository
        .items(&session.id)
        .await?
        .into_iter()
        .rev()
        .find_map(|item| match item.payload {
            AgentItemPayload::UserMessage(message) => Some(message),
            _ => None,
        })
        .ok_or_else(|| {
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
    let run = repository.create_run(&session.id, &model).await?;
    let params = run_params(
        &app,
        &repository,
        RunParamsInput {
            session_id: &session.id,
            run_id: &run.id,
            model: &model,
            safety_mode: session.safety_mode,
            workspace: &workspace,
            input: &prompt,
            skills: &[],
            attachments: &attachments,
        },
    )
    .await?;
    let _ = repository
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
        .await?;
    host.ensure_started(&app, repository.clone()).await?;
    host.request("run.start", &session.id, &run.id, params)
        .await?;
    Ok(run_json(repository.get_run(&run.id).await?))
}

#[tauri::command]
pub async fn resolve_agent_interruption(
    app: AppHandle,
    host: State<'_, AgentRuntimeHost>,
    request: ResolveInterruptionRequest,
) -> Result<Value, AppError> {
    let repository = repository(&app).await?;
    let row = sqlx::query::query("SELECT id, run_id, session_id, payload_json FROM agent_items WHERE kind = 'interruption' AND json_extract(payload_json, '$.id') = ? ORDER BY created_at DESC LIMIT 1")
        .bind(&request.interruption_id).fetch_one(&repository.pool).await?;
    use sqlx::row::Row;
    let run_id: String = row.get("run_id");
    let session_id: String = row.get("session_id");
    let item_id: String = row.get("id");
    let mut interruption: Value = serde_json::from_str(&row.get::<String, _>("payload_json"))
        .map_err(|error| AppError::new("agent_interruption_invalid", error.to_string()))?;
    let run = repository.get_run(&run_id).await?;
    if run.status != "waiting_for_user" {
        return Err(AppError::new(
            "agent_interruption_expired",
            "This interruption can no longer be resumed.",
        ));
    }
    let session = repository.get_session(&session_id).await?;
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
    let clarification_answer = request
        .resolution
        .get("answer")
        .and_then(Value::as_str)
        .map(str::to_string);
    let approved = clarification_answer.is_some()
        || request
            .resolution
            .get("choice")
            .and_then(Value::as_str)
            .is_some_and(|choice| choice != "deny");
    interruption["status"] = json!("resolved");
    interruption["resolvedAt"] = json!(chrono::Utc::now().to_rfc3339());
    if let Some(answer) = clarification_answer.as_deref() {
        interruption["answer"] = json!(answer);
    }
    sqlx::query::query("UPDATE agent_items SET payload_json = ? WHERE id = ?")
        .bind(interruption.to_string())
        .bind(item_id)
        .execute(&repository.pool)
        .await?;
    let workspace = session.workspace_path.clone().ok_or_else(|| {
        AppError::new(
            "agent_workspace_missing",
            "Session workspace is unavailable.",
        )
    })?;
    let model = normalize_agent_model(&session.model);
    host.ensure_started(&app, repository.clone()).await?;
    let mut params = run_params(
        &app,
        &repository,
        RunParamsInput {
            session_id: &session.id,
            run_id: &run.id,
            model: &model,
            safety_mode: session.safety_mode,
            workspace: &workspace,
            input: "",
            skills: &[],
            attachments: &[],
        },
    )
    .await?;
    params
        .as_object_mut()
        .expect("run params object")
        .remove("input");
    params
        .as_object_mut()
        .expect("run params object")
        .remove("history");
    params["serializedState"] = json!(serialized_state);
    params["resolutions"] = if let Some(answer) = clarification_answer {
        json!([{ "interruptionId": request.interruption_id, "kind": "clarification", "answer": answer }])
    } else {
        json!([{ "interruptionId": request.interruption_id, "decision": if approved { "approve" } else { "reject" } }])
    };
    host.request("run.resume", &session.id, &run.id, params)
        .await?;
    Ok(run_json(
        repository
            .update_run_status(&run.id, "running", None, None, None)
            .await?,
    ))
}

#[tauri::command]
pub async fn list_agent_artifacts(
    app: AppHandle,
    session_id: String,
) -> Result<Vec<Value>, AppError> {
    Ok(repository(&app).await?.artifacts(&session_id).await?.into_iter().map(|artifact| json!({ "id": artifact.id, "sessionId": artifact.session_id, "runId": artifact.run_id, "itemId": artifact.item_id, "name": PathBuf::from(&artifact.path).file_name().map(|v| v.to_string_lossy().into_owned()).unwrap_or_else(|| "Artifact".into()), "path": artifact.path, "mimeType": artifact.mime_type, "sizeBytes": artifact.size_bytes, "action": artifact.action, "available": artifact.available, "createdAt": artifact.created_at })).collect())
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
    let overrides: HashMap<String, bool> = repository
        .skills()
        .await?
        .into_iter()
        .map(|skill| (skill.id, skill.enabled))
        .collect();
    let mut result = Vec::new();
    for (root, managed) in skill_roots(&app) {
        let Ok(mut entries) = tokio::fs::read_dir(&root).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let skill_file = entry.path().join("SKILL.md");
            if !skill_file.is_file() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if result
                .iter()
                .any(|value: &Value| value.get("id").and_then(Value::as_str) == Some(&id))
            {
                continue;
            }
            let description = tokio::fs::read_to_string(&skill_file)
                .await
                .ok()
                .and_then(|text| {
                    text.lines()
                        .map(str::trim)
                        .find(|line| {
                            !line.is_empty() && !line.starts_with('#') && !line.starts_with("---")
                        })
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "June agent skill".into());
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
    let managed = skill_roots(&app)
        .into_iter()
        .find(|(_, managed)| *managed)
        .is_some_and(|(root, _)| root.join(&request.skill_id).join("SKILL.md").is_file());
    if !managed {
        return Err(AppError::new(
            "agent_skill_read_only",
            "User-global skills are read-only in June.",
        ));
    }
    let skill = repository(&app)
        .await?
        .set_skill_enabled(&request.skill_id, request.enabled, managed)
        .await?;
    Ok(
        json!({ "id": skill.id, "name": skill.id, "description": "June agent skill", "source": "managed", "enabled": skill.enabled, "editable": true }),
    )
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

struct RunParamsInput<'a> {
    session_id: &'a str,
    run_id: &'a str,
    model: &'a str,
    safety_mode: AgentSafetyMode,
    workspace: &'a str,
    input: &'a str,
    skills: &'a [String],
    attachments: &'a [MessageAttachmentPayload],
}

async fn run_params(
    app: &AppHandle,
    repository: &AgentRepository,
    request: RunParamsInput<'_>,
) -> Result<Value, AppError> {
    let history: Vec<Value> = repository
        .items(request.session_id)
        .await?
        .into_iter()
        .filter_map(history_item)
        .collect();
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
    Ok(
        json!({ "model": request.model, "instructions": INSTRUCTIONS, "workspace": request.workspace, "safetyMode": request.safety_mode.as_db(), "input": message_with_attachment_context(request.input, request.attachments), "history": history, "tools": tools, "skills": request.skills.iter().map(|name| json!({ "name": name, "description": "Enabled June skill", "source": "managed" })).collect::<Vec<_>>(), "contextWindow": 128000, "maxOutputTokens": 8192 }),
    )
}

async fn tool_descriptors(
    app: &AppHandle,
    repository: &AgentRepository,
    safety_mode: AgentSafetyMode,
    workspace: &str,
) -> Result<Value, AppError> {
    let mut tools = json!([
        { "name": "search_june", "description": "Search June notes, transcripts, and dictations.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"], "additionalProperties": false } },
        { "name": "web_search", "description": "Search the public web.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"], "additionalProperties": false } },
        { "name": "web_fetch", "description": "Fetch a public web page.", "parameters": { "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"], "additionalProperties": false } },
        { "name": "list_files", "description": "List files in a directory.", "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": [], "additionalProperties": false } },
        { "name": "read_file", "description": "Read a UTF-8 text file.", "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"], "additionalProperties": false } },
        { "name": "write_file", "description": "Write a UTF-8 text file.", "parameters": { "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } }, "required": ["path", "content"], "additionalProperties": false }, "requiresApproval": true },
        { "name": "patch_file", "description": "Replace one exact text occurrence in a file.", "parameters": { "type": "object", "properties": { "path": { "type": "string" }, "before": { "type": "string" }, "after": { "type": "string" } }, "required": ["path", "before", "after"], "additionalProperties": false }, "requiresApproval": true },
        { "name": "import_file", "description": "Copy a user file into this session workspace.", "parameters": { "type": "object", "properties": { "sourcePath": { "type": "string" } }, "required": ["sourcePath"], "additionalProperties": false }, "requiresApproval": true },
        { "name": "preview_file", "description": "Read file metadata and a bounded text preview.", "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"], "additionalProperties": false } },
        { "name": "search_files", "description": "Search text files.", "parameters": { "type": "object", "properties": { "query": { "type": "string" }, "path": { "type": "string" } }, "required": ["query"], "additionalProperties": false } },
        { "name": "run_shell", "description": "Run a shell command in the session workspace.", "parameters": { "type": "object", "properties": { "command": { "type": "string" } }, "required": ["command"], "additionalProperties": false }, "requiresApproval": true },
        { "name": "list_skills", "description": "List available June skills.", "parameters": { "type": "object", "properties": {}, "required": [], "additionalProperties": false } },
        { "name": "load_skill", "description": "Load instructions for one June skill.", "parameters": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"], "additionalProperties": false } }
        ,{ "name": "list_routines", "description": "List June routines and their schedules.", "parameters": { "type": "object", "properties": {}, "required": [], "additionalProperties": false } }
        ,{ "name": "create_routine", "description": "Create a June routine after the user has confirmed its instructions and timing.", "parameters": { "type": "object", "properties": { "name": { "type": "string" }, "prompt": { "type": "string" }, "schedule": { "type": "string", "description": "RFC 3339, every <n>m/h/d, or a five-field cron expression." }, "safetyMode": { "type": "string", "enum": ["sandboxed", "unrestricted"] } }, "required": ["prompt", "schedule", "safetyMode"], "additionalProperties": false }, "requiresApproval": true }
        ,{ "name": "update_routine", "description": "Update an existing June routine.", "parameters": { "type": "object", "properties": { "routineId": { "type": "string" }, "name": { "type": "string" }, "prompt": { "type": "string" }, "schedule": { "type": "string" }, "safetyMode": { "type": "string", "enum": ["sandboxed", "unrestricted"] } }, "required": ["routineId"], "additionalProperties": false }, "requiresApproval": true }
        ,{ "name": "pause_routine", "description": "Pause a June routine.", "parameters": { "type": "object", "properties": { "routineId": { "type": "string" } }, "required": ["routineId"], "additionalProperties": false }, "requiresApproval": true }
        ,{ "name": "resume_routine", "description": "Resume a paused June routine.", "parameters": { "type": "object", "properties": { "routineId": { "type": "string" } }, "required": ["routineId"], "additionalProperties": false }, "requiresApproval": true }
        ,{ "name": "delete_routine", "description": "Delete a June routine.", "parameters": { "type": "object", "properties": { "routineId": { "type": "string" } }, "required": ["routineId"], "additionalProperties": false }, "requiresApproval": true }
        ,{ "name": "request_clarification", "description": "Pause and ask the user a question when their answer is required to continue.", "parameters": { "type": "object", "properties": { "question": { "type": "string" }, "choices": { "type": "array", "items": { "type": "string" } } }, "required": ["question", "choices"], "additionalProperties": false }, "requiresApproval": true }
        ,{ "name": "computer_use", "description": "Operate the attended computer-use session through June's permission and approval broker.", "parameters": { "type": "object", "properties": { "action": { "type": "string" }, "arguments": {} }, "required": ["action"], "additionalProperties": true }, "requiresApproval": true }
        ,{ "name": "notion_call", "description": "Call an enabled read-only Notion tool through June's connected account.", "parameters": { "type": "object", "properties": { "toolName": { "type": "string" }, "arguments": { "type": "object" } }, "required": ["toolName", "arguments"], "additionalProperties": false } }
        ,{ "name": "notion_action", "description": "Call an enabled Notion action through June's approval broker.", "parameters": { "type": "object", "properties": { "toolName": { "type": "string" }, "arguments": { "type": "object" } }, "required": ["toolName", "arguments"], "additionalProperties": false }, "requiresApproval": true }
    ]);
    let subsystem = crate::agent_mcp::AgentMcpSubsystem::new(
        crate::agent_mcp::AgentMcpRepository::new(repository.pool.clone()),
        crate::agent_mcp::KeychainMcpSecretStore,
    );
    match subsystem
        .refresh_registry_for_workspace(
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
            json!({ "id": item.id, "kind": "message", "role": message.role, "text": message_with_attachment_context(&message.content, &message.attachments) }),
        ),
        AgentItemPayload::ContextSummary(text) => Some(
            json!({ "id": item.id, "kind": "context_summary", "role": "system", "text": text.text }),
        ),
        _ => None,
    }
}

fn session_json(session: super::AgentSessionDto) -> Value {
    json!({ "id": session.id, "title": session.title, "status": session.status, "model": session.model, "safetyMode": session.safety_mode, "workspacePath": session.workspace_path.unwrap_or_default(), "source": match session.source.as_str() { "legacy_routine" => "legacy_routine", "routine" => "routine", "user" => "user", _ => "legacy_task" }, "createdAt": session.created_at, "updatedAt": session.updated_at, "error": session.last_error })
}
fn run_json(run: super::AgentRunDto) -> Value {
    json!({ "id": run.id, "sessionId": run.session_id, "status": run.status, "model": run.model, "startedAt": run.started_at, "completedAt": run.completed_at, "usage": run.usage, "error": run.error_message })
}

fn item_json(item: AgentItemDto) -> Result<Value, AppError> {
    let base = json!({ "id": item.id, "sessionId": item.session_id, "runId": item.run_id, "sequence": item.sequence, "createdAt": item.created_at });
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
            json!({ "kind": "message", "role": v.role, "text": v.content, "status": "complete", "attachments": attachments })
        }
        AgentItemPayload::Reasoning(v) => {
            json!({ "kind": "reasoning", "text": v.text, "status": "complete" })
        }
        AgentItemPayload::ContextSummary(v) => json!({ "kind": "context_summary", "text": v.text }),
        AgentItemPayload::ToolCall(v) => {
            json!({ "kind": "tool_call", "callId": v.tool_call_id.unwrap_or_default(), "name": v.tool_name.unwrap_or_default(), "arguments": v.arguments, "status": v.status.unwrap_or_else(|| "complete".into()) })
        }
        AgentItemPayload::ToolResult(v) => {
            json!({ "kind": "tool_result", "callId": v.tool_call_id.unwrap_or_default(), "name": v.tool_name.unwrap_or_default(), "output": v.result, "isError": v.status.as_deref() == Some("failed") })
        }
        AgentItemPayload::Interruption(v) => json!({ "kind": "interruption", "interruption": v }),
        AgentItemPayload::Error(v) => {
            json!({ "kind": "error", "message": v.get("message").cloned().unwrap_or_else(|| json!("Agent run failed.")), "retryable": v.get("retryable").cloned().unwrap_or(Value::Bool(true)) })
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
fn io_error(error: std::io::Error) -> AppError {
    AppError::new("agent_workspace_failed", error.to_string())
}

async fn prepare_attachments(
    source_paths: &[String],
    workspace: &std::path::Path,
) -> Result<Vec<MessageAttachmentPayload>, AppError> {
    if source_paths.is_empty() {
        return Ok(Vec::new());
    }
    let destination_root = workspace.join("attachments");
    tokio::fs::create_dir_all(&destination_root)
        .await
        .map_err(io_error)?;
    let canonical_workspace = workspace.canonicalize().map_err(io_error)?;
    let mut attachments = Vec::with_capacity(source_paths.len());
    for source_path in source_paths {
        let source = PathBuf::from(source_path)
            .canonicalize()
            .map_err(io_error)?;
        if !source.is_file() {
            return Err(AppError::new(
                "agent_attachment_invalid",
                "Attachment source is not a file.",
            ));
        }
        let name = source
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
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
            mime_type: attachment_mime_type(&destination).map(str::to_string),
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
                original_path, mime_type, size_bytes, available, created_at
             ) VALUES (?, ?, ?, ?, 'attachment', 'imported', ?, ?, ?, ?, 1, ?)",
        )
        .bind(&attachment.id)
        .bind(session_id)
        .bind(run_id)
        .bind(item_id)
        .bind(&attachment.path)
        .bind(original_paths.get(index))
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
        "[June attachment manifest v1]\nThe following files are available locally. Use June's file tools to inspect them when needed:\n{manifest}\n\n{message}"
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

    #[tokio::test]
    async fn attachments_are_copied_into_the_session_workspace_and_added_to_context() {
        let source_directory = tempfile::tempdir().expect("source directory");
        let workspace = tempfile::tempdir().expect("workspace");
        let source = source_directory.path().join("brief.md");
        tokio::fs::write(&source, "# Brief")
            .await
            .expect("source attachment");

        let attachments =
            prepare_attachments(&[source.to_string_lossy().into_owned()], workspace.path())
                .await
                .expect("prepared attachments");

        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].name, "brief.md");
        assert_eq!(attachments[0].mime_type.as_deref(), Some("text/markdown"));
        assert!(PathBuf::from(&attachments[0].path).starts_with(workspace.path()));
        assert_eq!(
            tokio::fs::read_to_string(&attachments[0].path)
                .await
                .expect("copied attachment"),
            "# Brief"
        );
        let input = message_with_attachment_context("Summarize this.", &attachments);
        assert!(input.starts_with("[June attachment manifest v1]"));
        assert!(input.contains("brief.md"));
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
    fn legacy_auto_alias_uses_the_priced_june_model_id() {
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

        let value = item_json(item).expect("public item");
        assert_eq!(value["attachments"][0]["sessionId"], "session-1");
        assert_eq!(value["attachments"][0]["runId"], "run-1");
        assert_eq!(value["attachments"][0]["itemId"], "message-1");
        assert_eq!(value["attachments"][0]["action"], "imported");
    }
}
