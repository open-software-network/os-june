use super::{AgentRepository, AgentSafetyMode};
use crate::domain::types::AppError;
use serde_json::{json, Value};
use sqlx::{query::query, row::Row};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tauri::AppHandle;
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{oneshot, Mutex},
};

const MAX_TOOL_OUTPUT_BYTES: usize = 1_048_576;

#[derive(Clone)]
pub struct ToolContext {
    pub app: AppHandle,
    pub repository: AgentRepository,
    pub workspace: PathBuf,
    pub safety_mode: AgentSafetyMode,
    pub session_id: String,
    pub run_id: String,
    pub cancellations: ToolCancellationRegistry,
    pub call_id: Option<String>,
}

#[derive(Clone, Default)]
pub struct ToolCancellationRegistry {
    inner: std::sync::Arc<Mutex<std::collections::HashMap<String, Vec<oneshot::Sender<()>>>>>,
}

impl ToolCancellationRegistry {
    async fn register(&self, run_id: &str) -> oneshot::Receiver<()> {
        let (send, receive) = oneshot::channel();
        self.inner
            .lock()
            .await
            .entry(run_id.to_string())
            .or_default()
            .push(send);
        receive
    }
    pub async fn cancel(&self, run_id: &str) {
        if let Some(senders) = self.inner.lock().await.remove(run_id) {
            for sender in senders {
                let _ = sender.send(());
            }
        }
    }
}

pub async fn dispatch_tool(
    context: &ToolContext,
    name: &str,
    arguments: Value,
) -> Result<Value, AppError> {
    match name {
        "search_june" => search_june(context, &arguments).await,
        "web_search" => web(context, "/v1/web/search", &arguments).await,
        "web_fetch" => web(context, "/v1/web/fetch", &arguments).await,
        "list_files" => list_files(context, &arguments).await,
        "read_file" => read_file(context, &arguments).await,
        "write_file" => write_file(context, &arguments).await,
        "patch_file" => patch_file(context, &arguments).await,
        "import_file" => import_file(context, &arguments).await,
        "preview_file" => preview_file(context, &arguments).await,
        "search_files" => search_files(context, &arguments).await,
        "run_shell" => run_shell(context, &arguments).await,
        "list_skills" => list_skills(context).await,
        "load_skill" => load_skill(context, &arguments).await,
        "request_clarification" => consume_clarification_answer(context).await,
        "computer_use" => {
            Ok(crate::computer_use::handle_proxy_action(&context.app, arguments).await)
        }
        "notion_call" | "notion_action" => notion_tool(context, name, &arguments).await,
        // These capabilities stay behind Rust-owned seams. Their existing brokers
        // can be connected without granting the runtime direct credentials or UI access.
        name if name.starts_with("browser_")
            || name.starts_with("computer_")
            || name.starts_with("connector_") =>
        {
            Err(AppError::new(
                "agent_tool_unavailable",
                format!("{name} is not enabled for this runtime yet."),
            ))
        }
        _ => Err(AppError::new(
            "agent_tool_unsupported",
            format!("Unsupported agent tool: {name}"),
        )),
    }
}

async fn search_june(context: &ToolContext, arguments: &Value) -> Result<Value, AppError> {
    let query_text = required_string(arguments, "query")?;
    let pattern = format!("%{}%", query_text.replace('%', "\\%").replace('_', "\\_"));
    let rows = query(
        "SELECT n.id, n.title, COALESCE(n.edited_content, n.generated_content, '') AS note,
                COALESCE((SELECT text FROM transcripts t WHERE t.note_id = n.id ORDER BY t.created_at DESC LIMIT 1), '') AS transcript,
                n.updated_at
         FROM notes n
         WHERE n.title LIKE ? ESCAPE '\\' OR n.generated_content LIKE ? ESCAPE '\\'
            OR n.edited_content LIKE ? ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM transcripts t WHERE t.note_id = n.id AND t.text LIKE ? ESCAPE '\\')
         ORDER BY n.updated_at DESC LIMIT 20",
    )
    .bind(&pattern).bind(&pattern).bind(&pattern).bind(&pattern)
    .fetch_all(&context.repository.pool).await?;
    let notes: Vec<Value> = rows.into_iter().map(|row| json!({
        "id": row.get::<String, _>("id"), "title": row.get::<String, _>("title"),
        "note": truncate(row.get::<String, _>("note")), "transcript": truncate(row.get::<String, _>("transcript")),
        "updatedAt": row.get::<String, _>("updated_at")
    })).collect();
    let dictations = query("SELECT id, text, language, created_at FROM dictation_history WHERE text LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 20")
        .bind(&pattern).fetch_all(&context.repository.pool).await?;
    let dictations: Vec<Value> = dictations.into_iter().map(|row| json!({
        "id": row.get::<String, _>("id"), "text": truncate(row.get::<String, _>("text")),
        "language": row.get::<Option<String>, _>("language"), "createdAt": row.get::<String, _>("created_at")
    })).collect();
    Ok(json!({ "notes": notes, "dictations": dictations }))
}

async fn web(context: &ToolContext, path: &str, arguments: &Value) -> Result<Value, AppError> {
    let request = web_request(arguments, context.call_id.as_deref());
    let response = crate::june_api::forward_web_request(path, &request).await?;
    if response.status >= 400 {
        return Err(AppError::new(
            "agent_web_failed",
            String::from_utf8_lossy(&response.body).into_owned(),
        ));
    }
    serde_json::from_slice(&response.body)
        .map_err(|error| AppError::new("agent_web_invalid_response", error.to_string()))
}

fn web_request(arguments: &Value, call_id: Option<&str>) -> Value {
    let mut request = arguments.clone();
    request["requestId"] = Value::String(
        call_id
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
    );
    request
}

async fn list_files(context: &ToolContext, arguments: &Value) -> Result<Value, AppError> {
    let path = resolve_path(
        context,
        arguments.get("path").and_then(Value::as_str).unwrap_or("."),
        true,
    )?;
    let mut entries = tokio::fs::read_dir(&path).await.map_err(io_error)?;
    let mut result = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(io_error)? {
        let metadata = entry.metadata().await.map_err(io_error)?;
        result.push(json!({ "name": entry.file_name().to_string_lossy(), "path": entry.path(), "directory": metadata.is_dir(), "sizeBytes": metadata.len() }));
        if result.len() >= 500 {
            break;
        }
    }
    Ok(json!({ "path": path, "entries": result }))
}

async fn read_file(context: &ToolContext, arguments: &Value) -> Result<Value, AppError> {
    let path = resolve_path(context, required_string(arguments, "path")?, true)?;
    let bytes = tokio::fs::read(&path).await.map_err(io_error)?;
    if bytes.len() > MAX_TOOL_OUTPUT_BYTES {
        return Err(AppError::new(
            "agent_tool_output_too_large",
            "File exceeds the 1 MB read limit.",
        ));
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| AppError::new("agent_file_not_text", "File is not UTF-8 text."))?;
    Ok(json!({ "path": path, "content": content }))
}

async fn write_file(context: &ToolContext, arguments: &Value) -> Result<Value, AppError> {
    let path = resolve_path(context, required_string(arguments, "path")?, false)?;
    let content = required_string(arguments, "content")?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(io_error)?;
    }
    tokio::fs::write(&path, content).await.map_err(io_error)?;
    record_artifact(context, &path, "created", None).await?;
    Ok(json!({ "path": path, "sizeBytes": content.len() }))
}

async fn patch_file(context: &ToolContext, arguments: &Value) -> Result<Value, AppError> {
    let path = resolve_path(context, required_string(arguments, "path")?, true)?;
    let before = required_string(arguments, "before")?;
    let after = required_string(arguments, "after")?;
    let content = tokio::fs::read_to_string(&path).await.map_err(io_error)?;
    let occurrences = content.matches(before).count();
    if occurrences != 1 {
        return Err(AppError::new(
            "agent_patch_ambiguous",
            format!("Patch target must occur exactly once, but occurred {occurrences} times."),
        ));
    }
    tokio::fs::write(&path, content.replacen(before, after, 1))
        .await
        .map_err(io_error)?;
    record_artifact(context, &path, "updated", None).await?;
    Ok(json!({ "path": path, "updated": true }))
}

async fn import_file(context: &ToolContext, arguments: &Value) -> Result<Value, AppError> {
    let source = PathBuf::from(required_string(arguments, "sourcePath")?)
        .canonicalize()
        .map_err(io_error)?;
    if !source.is_file() {
        return Err(AppError::new(
            "agent_import_invalid",
            "Import source is not a file.",
        ));
    }
    let name = source
        .file_name()
        .ok_or_else(|| AppError::new("agent_import_invalid", "Import source has no file name."))?;
    let destination = resolve_path(
        context,
        &format!("imports/{}", name.to_string_lossy()),
        false,
    )?;
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(io_error)?;
    }
    tokio::fs::copy(&source, &destination)
        .await
        .map_err(io_error)?;
    record_artifact(context, &destination, "imported", Some(&source)).await?;
    Ok(json!({ "path": destination, "sourcePath": source }))
}

async fn preview_file(context: &ToolContext, arguments: &Value) -> Result<Value, AppError> {
    let path = resolve_path(context, required_string(arguments, "path")?, true)?;
    let metadata = tokio::fs::metadata(&path).await.map_err(io_error)?;
    let preview = if metadata.len() <= 64 * 1024 {
        tokio::fs::read_to_string(&path).await.ok()
    } else {
        None
    };
    Ok(json!({ "path": path, "sizeBytes": metadata.len(), "text": preview }))
}

async fn record_artifact(
    context: &ToolContext,
    path: &Path,
    action: &str,
    original: Option<&Path>,
) -> Result<(), AppError> {
    let metadata = tokio::fs::metadata(path).await.map_err(io_error)?;
    sqlx::query::query("INSERT INTO agent_artifacts(id, session_id, run_id, provenance, action, path, original_path, size_bytes, available, created_at) VALUES (?, ?, ?, 'tool', ?, ?, ?, ?, 1, ?)")
        .bind(uuid::Uuid::new_v4().to_string()).bind(&context.session_id).bind(&context.run_id)
        .bind(action).bind(path.to_string_lossy().as_ref()).bind(original.map(|value| value.to_string_lossy().into_owned()))
        .bind(metadata.len() as i64).bind(chrono::Utc::now().to_rfc3339()).execute(&context.repository.pool).await?;
    Ok(())
}

async fn search_files(context: &ToolContext, arguments: &Value) -> Result<Value, AppError> {
    let needle = required_string(arguments, "query")?;
    let root = resolve_path(
        context,
        arguments.get("path").and_then(Value::as_str).unwrap_or("."),
        true,
    )?;
    let mut command = Command::new("rg");
    command
        .arg("--line-number")
        .arg("--no-heading")
        .arg("--max-count")
        .arg("200")
        .arg("--")
        .arg(needle)
        .arg(&root);
    let output = command.output().await.map_err(io_error)?;
    Ok(
        json!({ "matches": truncate(String::from_utf8_lossy(&output.stdout).into_owned()), "truncated": output.stdout.len() > MAX_TOOL_OUTPUT_BYTES }),
    )
}

async fn run_shell(context: &ToolContext, arguments: &Value) -> Result<Value, AppError> {
    #[cfg(target_os = "windows")]
    if context.safety_mode == AgentSafetyMode::Sandboxed {
        return Err(AppError::new(
            "agent_shell_sandbox_unavailable",
            "Shell execution is unavailable in Sandboxed mode on Windows.",
        ));
    }
    let script = required_string(arguments, "command")?;
    let mut command = if cfg!(target_os = "windows") {
        let mut command = Command::new("cmd");
        command.arg("/C").arg(script);
        command
    } else if cfg!(target_os = "macos") && context.safety_mode == AgentSafetyMode::Sandboxed {
        let profile = sandbox_profile(&context.workspace);
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command
            .arg("-p")
            .arg(profile)
            .arg("/bin/zsh")
            .arg("-lc")
            .arg(script);
        command
    } else {
        let mut command = Command::new("/bin/sh");
        command.arg("-lc").arg(script);
        command
    };
    command
        .current_dir(&context.workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(io_error)?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::new("agent_shell_failed", "Shell stdout was unavailable."))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::new("agent_shell_failed", "Shell stderr was unavailable."))?;
    let stdout_task = tokio::spawn(async move { read_bounded(&mut stdout).await });
    let stderr_task = tokio::spawn(async move { read_bounded(&mut stderr).await });
    let mut cancelled = context.cancellations.register(&context.run_id).await;
    let status = tokio::select! {
        status = child.wait() => status.map_err(io_error)?,
        _ = &mut cancelled => { let _ = child.kill().await; return Err(AppError::new("agent_tool_cancelled", "Shell command was cancelled.")); }
    };
    let stdout_text = stdout_task
        .await
        .map_err(|error| AppError::new("agent_shell_failed", error.to_string()))??;
    let stderr_text = stderr_task
        .await
        .map_err(|error| AppError::new("agent_shell_failed", error.to_string()))??;
    Ok(json!({ "exitCode": status.code(), "stdout": stdout_text, "stderr": stderr_text }))
}

async fn notion_tool(
    context: &ToolContext,
    kind: &str,
    arguments: &Value,
) -> Result<Value, AppError> {
    let tool_name = required_string(arguments, "toolName")?.to_string();
    let tool_arguments = arguments
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let request = crate::connectors::notion::NotionHostedToolCallRequest {
        tool_name,
        arguments: tool_arguments,
        deadline_unix_ms: None,
    };
    let result = if kind == "notion_action" {
        crate::connectors::notion::call_hosted_action_tool(&context.app, request).await?
    } else {
        crate::connectors::notion::call_hosted_tool(&context.app, request).await?
    };
    serde_json::to_value(result)
        .map_err(|error| AppError::new("agent_connector_response_invalid", error.to_string()))
}

async fn list_skills(context: &ToolContext) -> Result<Value, AppError> {
    let roots = skill_roots(&context.app);
    let mut skills = Vec::new();
    for root in roots {
        let Ok(mut entries) = tokio::fs::read_dir(&root).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry.path().join("SKILL.md").is_file() {
                skills.push(json!({ "name": entry.file_name().to_string_lossy(), "root": root }));
            }
        }
    }
    Ok(json!({ "skills": skills }))
}

async fn load_skill(context: &ToolContext, arguments: &Value) -> Result<Value, AppError> {
    let name = required_string(arguments, "name")?;
    if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err(AppError::new(
            "agent_skill_invalid",
            "Skill name is invalid.",
        ));
    }
    for root in skill_roots(&context.app) {
        let path = root.join(name).join("SKILL.md");
        if path.is_file() {
            let content = tokio::fs::read_to_string(&path).await.map_err(io_error)?;
            return Ok(json!({ "name": name, "content": content, "path": path }));
        }
    }
    Err(AppError::new(
        "agent_skill_not_found",
        "Skill was not found.",
    ))
}

async fn consume_clarification_answer(context: &ToolContext) -> Result<Value, AppError> {
    let row = query("SELECT id, payload_json FROM agent_items WHERE run_id = ? AND kind = 'interruption' AND json_extract(payload_json, '$.kind') = 'clarification' AND (? IS NULL OR json_extract(payload_json, '$.id') = ?) AND json_extract(payload_json, '$.answer') IS NOT NULL AND COALESCE(json_extract(payload_json, '$.answerConsumed'), 0) = 0 ORDER BY created_at DESC LIMIT 1")
        .bind(&context.run_id).bind(context.call_id.as_deref()).bind(context.call_id.as_deref()).fetch_one(&context.repository.pool).await?;
    let id: String = row.get("id");
    let mut payload: Value = serde_json::from_str(&row.get::<String, _>("payload_json"))
        .map_err(|error| AppError::new("agent_interruption_invalid", error.to_string()))?;
    let answer = payload
        .get("answer")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::new(
                "agent_clarification_unanswered",
                "The clarification has not been answered.",
            )
        })?
        .to_string();
    payload["answerConsumed"] = Value::Bool(true);
    query("UPDATE agent_items SET payload_json = ? WHERE id = ?")
        .bind(payload.to_string())
        .bind(id)
        .execute(&context.repository.pool)
        .await?;
    Ok(json!({ "answer": answer }))
}

fn resolve_path(
    context: &ToolContext,
    requested: &str,
    must_exist: bool,
) -> Result<PathBuf, AppError> {
    let requested = Path::new(requested);
    let joined = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        context.workspace.join(requested)
    };
    let resolved = if must_exist || joined.exists() {
        joined.canonicalize().map_err(io_error)?
    } else {
        let mut existing = joined.as_path();
        while !existing.exists() {
            existing = existing.parent().ok_or_else(|| {
                AppError::new("agent_path_invalid", "Path has no existing ancestor.")
            })?;
        }
        let canonical_existing = existing.canonicalize().map_err(io_error)?;
        let suffix = joined
            .strip_prefix(existing)
            .map_err(|_| AppError::new("agent_path_invalid", "Path could not be resolved."))?;
        canonical_existing.join(suffix)
    };
    if context.safety_mode == AgentSafetyMode::Sandboxed {
        let workspace = context.workspace.canonicalize().map_err(io_error)?;
        if !resolved.starts_with(workspace) {
            return Err(AppError::new(
                "agent_path_denied",
                "Path is outside this session's workspace.",
            ));
        }
    }
    Ok(resolved)
}

fn skill_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = crate::app_paths::app_data_dir(app)
        .ok()
        .map(|path| path.join("agents").join("skills"))
        .into_iter()
        .collect::<Vec<_>>();
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join(".agents").join("skills"));
    }
    roots
}

fn sandbox_profile(workspace: &Path) -> String {
    let escaped = workspace.to_string_lossy().replace('"', "\\\"");
    format!("(version 1) (allow default) (deny file-write*) (allow file-write* (subpath \"{escaped}\")) (allow file-write* (subpath \"/private/tmp\"))")
}

async fn read_bounded(
    reader: &mut (impl tokio::io::AsyncRead + Unpin),
) -> Result<String, AppError> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_TOOL_OUTPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(io_error)?;
    if bytes.len() > MAX_TOOL_OUTPUT_BYTES {
        bytes.truncate(MAX_TOOL_OUTPUT_BYTES);
        bytes.extend_from_slice(b"\n[output truncated]");
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, AppError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::new(
                "agent_tool_arguments_invalid",
                format!("{key} is required."),
            )
        })
}
fn truncate(mut value: String) -> String {
    if value.len() > MAX_TOOL_OUTPUT_BYTES {
        value.truncate(MAX_TOOL_OUTPUT_BYTES);
        value.push_str("\n[output truncated]");
    }
    value
}
fn io_error(error: std::io::Error) -> AppError {
    AppError::new("agent_tool_io_failed", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_profile_only_grants_workspace_and_tmp_writes() {
        let profile = sandbox_profile(Path::new("/Users/example/June Workspace"));
        assert!(profile.contains("(deny file-write*)"));
        assert!(profile.contains("/Users/example/June Workspace"));
        assert!(!profile.contains("(allow file-write*)"));
    }

    #[test]
    fn web_requests_use_the_tool_call_id() {
        let request = web_request(&json!({ "query": "OpenAI Agents SDK" }), Some("call-42"));

        assert_eq!(request["query"], "OpenAI Agents SDK");
        assert_eq!(request["requestId"], "call-42");
    }
}
