use super::{
    protocol::{RpcFrame, PROTOCOL_VERSION},
    tools::{dispatch_tool, ToolCancellationRegistry, ToolContext},
    AgentItemPayload, AgentRepository, MessagePayload, TextPayload, ToolPayload,
};
use crate::domain::types::AppError;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
};
use uuid::Uuid;

pub const AGENT_RUNTIME_EVENT: &str = "june://agent-runtime-event";
type PendingRequests = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, AppError>>>>>;

#[derive(Default)]
pub struct AgentRuntimeHost {
    inner: Mutex<Option<RunningRuntime>>,
    request_sequence: AtomicI64,
    model_streams: Arc<Mutex<HashMap<String, ModelStream>>>,
    cancellations: ToolCancellationRegistry,
}

struct ModelStream {
    response: crate::june_api::AgentChatCompletionsResponse,
    buffer: Vec<u8>,
    done: bool,
    run_id: String,
}

struct RunningRuntime {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: PendingRequests,
}

impl AgentRuntimeHost {
    pub async fn ensure_started(
        &self,
        app: &AppHandle,
        repository: AgentRepository,
    ) -> Result<(), AppError> {
        let mut guard = self.inner.lock().await;
        if guard
            .as_mut()
            .is_some_and(|runtime| runtime.child.id().is_some())
        {
            return Ok(());
        }

        let (program, args) = resolve_runtime_command(app)?;
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| AppError::new("agent_runtime_start_failed", error.to_string()))?;
        let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
            AppError::new(
                "agent_runtime_start_failed",
                "Runtime stdin was unavailable.",
            )
        })?));
        let stdout = child.stdout.take().ok_or_else(|| {
            AppError::new(
                "agent_runtime_start_failed",
                "Runtime stdout was unavailable.",
            )
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            AppError::new(
                "agent_runtime_start_failed",
                "Runtime stderr was unavailable.",
            )
        })?;
        let pending = Arc::new(Mutex::new(HashMap::new()));
        spawn_stdout_reader(
            app.clone(),
            repository.clone(),
            stdout,
            stdin.clone(),
            pending.clone(),
            self.model_streams.clone(),
            self.cancellations.clone(),
        );
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::warn!(target: "agent_runtime", "{}", sanitize_log(&line));
            }
        });
        *guard = Some(RunningRuntime {
            child,
            stdin,
            pending,
        });
        drop(guard);
        self.request(
            "runtime.initialize",
            "runtime",
            "runtime",
            json!({
                "clientName": "June", "clientVersion": env!("CARGO_PKG_VERSION")
            }),
        )
        .await?;
        Ok(())
    }

    pub async fn request(
        &self,
        method: &str,
        session_id: &str,
        run_id: &str,
        params: Value,
    ) -> Result<Value, AppError> {
        let guard = self.inner.lock().await;
        let runtime = guard.as_ref().ok_or_else(|| {
            AppError::new("agent_runtime_unavailable", "Agent runtime is not running.")
        })?;
        let id = Uuid::new_v4().to_string();
        let frame = RpcFrame::request(
            id.clone(),
            method,
            session_id,
            run_id,
            self.request_sequence.fetch_add(1, Ordering::Relaxed) + 1,
            params,
        );
        let (send, receive) = oneshot::channel();
        runtime.pending.lock().await.insert(id, send);
        write_frame(&runtime.stdin, &frame).await?;
        drop(guard);
        receive.await.map_err(|_| {
            AppError::new("agent_runtime_disconnected", "Agent runtime disconnected.")
        })?
    }

    pub async fn shutdown(&self) {
        crate::agent_mcp::shutdown_sessions().await;
        let mut guard = self.inner.lock().await;
        let Some(mut runtime) = guard.take() else {
            return;
        };
        let frame = RpcFrame::request(
            Uuid::new_v4().to_string(),
            "runtime.shutdown",
            "runtime",
            "runtime",
            self.request_sequence.fetch_add(1, Ordering::Relaxed) + 1,
            json!({}),
        );
        let _ = write_frame(&runtime.stdin, &frame).await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), runtime.child.wait()).await;
        let _ = runtime.child.kill().await;
    }

    pub async fn cancel_run_streams(&self, run_id: &str) {
        self.model_streams
            .lock()
            .await
            .retain(|_, stream| stream.run_id != run_id);
        self.cancellations.cancel(run_id).await;
    }
}

fn spawn_stdout_reader(
    app: AppHandle,
    repository: AgentRepository,
    stdout: tokio::process::ChildStdout,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: PendingRequests,
    model_streams: Arc<Mutex<HashMap<String, ModelStream>>>,
    cancellations: ToolCancellationRegistry,
) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let frame = match serde_json::from_str::<RpcFrame>(&line) {
                Ok(frame) if frame.validate().is_ok() => frame,
                Ok(frame) => {
                    tracing::warn!(
                        version = frame.protocol_version,
                        "Rejected agent runtime frame"
                    );
                    continue;
                }
                Err(error) => {
                    tracing::warn!(%error, "Invalid agent runtime frame");
                    continue;
                }
            };
            if frame.method.is_none() {
                if let Some(id) = frame.id.as_ref() {
                    if let Some(sender) = pending.lock().await.remove(id) {
                        let response = frame.error.map_or_else(
                            || Ok(frame.result.unwrap_or(Value::Null)),
                            |error| {
                                Err(AppError::new("agent_runtime_request_failed", error.message))
                            },
                        );
                        let _ = sender.send(response);
                    }
                }
                continue;
            }
            if frame.event_id.is_some() {
                if let Err(error) = persist_and_emit_event(&app, &repository, &frame).await {
                    tracing::warn!(%error.message, "Failed to persist agent event");
                }
                continue;
            }
            let response =
                handle_runtime_request(&app, &repository, &model_streams, &cancellations, &frame)
                    .await;
            let response_frame = match response {
                Ok(value) => RpcFrame::success(&frame, value),
                Err(error) => RpcFrame::failure(&frame, -32603, error.message),
            };
            let _ = write_frame(&stdin, &response_frame).await;
        }
        for (_, sender) in pending.lock().await.drain() {
            let _ = sender.send(Err(AppError::new(
                "agent_runtime_disconnected",
                "Agent runtime disconnected.",
            )));
        }
        let _ = repository
            .mark_active_runs_interrupted("The local agent runtime stopped unexpectedly.")
            .await;
        let _ = app.emit(AGENT_RUNTIME_EVENT, json!({ "protocolVersion": PROTOCOL_VERSION, "sessionId": "runtime", "runId": "runtime", "sequence": 0, "eventId": Uuid::new_v4(), "method": "run.failed", "data": { "completedAt": now(), "message": "The local agent runtime stopped unexpectedly.", "retryable": true } }));
    });
}

async fn handle_runtime_request(
    app: &AppHandle,
    repository: &AgentRepository,
    model_streams: &Arc<Mutex<HashMap<String, ModelStream>>>,
    cancellations: &ToolCancellationRegistry,
    frame: &RpcFrame,
) -> Result<Value, AppError> {
    match frame.method.as_deref() {
        Some("host.log") => {
            let params = frame.params.as_ref().unwrap_or(&Value::Null);
            tracing::info!(target: "agent_runtime", level = ?params.get("level"), message = %sanitize_log(params.get("message").and_then(|value| value.as_str()).unwrap_or("runtime log")));
            Ok(json!({ "accepted": true }))
        }
        Some("tool.invoke") => {
            let params = frame.params.as_ref().ok_or_else(|| {
                AppError::new("agent_protocol_invalid", "tool.invoke params are required.")
            })?;
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::new("agent_protocol_invalid", "Tool name is required."))?;
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if name == "__june_model_chat_completions" {
                if let Some(stream_id) = arguments.get("streamId").and_then(Value::as_str) {
                    return poll_model_stream(model_streams, stream_id).await;
                }
                let mut request = arguments.get("request").cloned().ok_or_else(|| {
                    AppError::new(
                        "agent_model_request_invalid",
                        "Model request payload is required.",
                    )
                })?;
                request["stream"] = Value::Bool(true);
                let response = crate::june_api::proxy_agent_chat_completions(request).await?;
                if response.status >= 400 {
                    let bytes = response.collect_body().await?;
                    let body: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
                    return Err(AppError::new(
                        "agent_model_request_failed",
                        model_gateway_error_message(&body),
                    ));
                }
                let stream_id = Uuid::new_v4().to_string();
                model_streams.lock().await.insert(
                    stream_id.clone(),
                    ModelStream {
                        response,
                        buffer: Vec::new(),
                        done: false,
                        run_id: frame.run_id.clone(),
                    },
                );
                return poll_model_stream(model_streams, &stream_id).await;
            }
            let session = repository.get_session(&frame.session_id).await?;
            let workspace = session.workspace_path.map(PathBuf::from).ok_or_else(|| {
                AppError::new(
                    "agent_workspace_missing",
                    "Session workspace is unavailable.",
                )
            })?;
            dispatch_tool(
                &ToolContext {
                    app: app.clone(),
                    repository: repository.clone(),
                    workspace,
                    safety_mode: session.safety_mode,
                    session_id: frame.session_id.clone(),
                    run_id: frame.run_id.clone(),
                    cancellations: cancellations.clone(),
                    call_id: params
                        .get("callId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                },
                name,
                arguments,
            )
            .await
        }
        Some(method) => Err(AppError::new(
            "agent_protocol_method_unknown",
            format!("Unknown runtime request: {method}"),
        )),
        None => Err(AppError::new(
            "agent_protocol_invalid",
            "Request method is required.",
        )),
    }
}

fn model_gateway_error_message(body: &Value) -> &str {
    body.get("error")
        .and_then(|error| error.get("message").or(Some(error)))
        .and_then(Value::as_str)
        .or_else(|| body.get("message").and_then(Value::as_str))
        .unwrap_or("June's model routing service rejected the request.")
}

async fn poll_model_stream(
    streams: &Arc<Mutex<HashMap<String, ModelStream>>>,
    stream_id: &str,
) -> Result<Value, AppError> {
    let mut streams = streams.lock().await;
    let stream = streams.get_mut(stream_id).ok_or_else(|| {
        AppError::new(
            "agent_model_stream_not_found",
            "Model stream is no longer available.",
        )
    })?;
    let mut chunks = Vec::new();
    if !stream.done {
        match tokio::time::timeout(
            std::time::Duration::from_millis(100),
            stream.response.chunk(),
        )
        .await
        {
            Ok(Ok(Some(bytes))) => {
                stream.buffer.extend_from_slice(&bytes);
                parse_sse_chunks(stream, &mut chunks)?;
            }
            Ok(Ok(None)) => {
                stream.done = true;
                parse_sse_chunks(stream, &mut chunks)?;
            }
            Ok(Err(error)) => return Err(error),
            Err(_) => {}
        }
    }
    let done = stream.done;
    let result = json!({ "streamId": stream_id, "chunks": chunks, "done": done });
    if done {
        streams.remove(stream_id);
    }
    Ok(result)
}

fn parse_sse_chunks(stream: &mut ModelStream, output: &mut Vec<Value>) -> Result<(), AppError> {
    let mut consumed = 0;
    while let Some(relative) = stream.buffer[consumed..]
        .iter()
        .position(|byte| *byte == b'\n')
    {
        let end = consumed + relative;
        let line = std::str::from_utf8(&stream.buffer[consumed..end])
            .map_err(|error| AppError::new("agent_model_stream_invalid", error.to_string()))?
            .trim_end_matches('\r');
        consumed = end + 1;
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" {
            stream.done = true;
            continue;
        }
        if data.is_empty() {
            continue;
        }
        output.push(
            serde_json::from_str(data)
                .map_err(|error| AppError::new("agent_model_stream_invalid", error.to_string()))?,
        );
    }
    if consumed > 0 {
        stream.buffer.drain(..consumed);
    }
    if stream.done && !stream.buffer.is_empty() {
        let tail = std::str::from_utf8(&stream.buffer)
            .map_err(|error| AppError::new("agent_model_stream_invalid", error.to_string()))?
            .trim();
        if let Some(data) = tail
            .strip_prefix("data:")
            .map(str::trim)
            .filter(|data| !data.is_empty() && *data != "[DONE]")
        {
            output.push(
                serde_json::from_str(data).map_err(|error| {
                    AppError::new("agent_model_stream_invalid", error.to_string())
                })?,
            );
        }
        stream.buffer.clear();
    }
    Ok(())
}

async fn persist_and_emit_event(
    app: &AppHandle,
    repository: &AgentRepository,
    frame: &RpcFrame,
) -> Result<(), AppError> {
    let method = frame.method.as_deref().unwrap_or_default();
    let params = frame.params.clone().unwrap_or_else(|| json!({}));
    let event_id = frame
        .event_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let created_at = now();
    let assistant_id = format!("assistant:{}", frame.run_id);
    let reasoning_id = format!("reasoning:{}", frame.run_id);
    let mut data = params.clone();
    let payload = match method {
        "message.delta" => {
            data["itemId"] = json!(assistant_id);
            data["role"] = json!("assistant");
            data["createdAt"] = json!(created_at);
            None
        }
        "message.completed" => {
            let text = params
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            data["itemId"] = json!(assistant_id);
            data["role"] = json!("assistant");
            data["createdAt"] = json!(created_at);
            Some(AgentItemPayload::AssistantMessage(MessagePayload {
                role: "assistant".into(),
                content: text.into(),
                attachments: Vec::new(),
            }))
        }
        "reasoning.delta" => {
            data["itemId"] = json!(reasoning_id);
            data["createdAt"] = json!(created_at);
            Some(AgentItemPayload::Reasoning(TextPayload {
                text: params
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .into(),
            }))
        }
        "tool.started" => {
            data["itemId"] = json!(format!("tool-call:{event_id}"));
            data["createdAt"] = json!(created_at);
            Some(AgentItemPayload::ToolCall(tool_payload(&params, "running")))
        }
        "tool.completed" => {
            data["itemId"] = json!(format!("tool-result:{event_id}"));
            data["createdAt"] = json!(created_at);
            Some(AgentItemPayload::ToolResult(tool_payload(
                &params, "complete",
            )))
        }
        "tool.failed" => {
            data["itemId"] = json!(format!("tool-result:{event_id}"));
            data["createdAt"] = json!(created_at);
            Some(AgentItemPayload::ToolResult(tool_payload(
                &params, "failed",
            )))
        }
        "interruption.requested" => {
            let serialized = params
                .get("serializedState")
                .cloned()
                .unwrap_or(Value::Null);
            repository
                .update_run_status(
                    &frame.run_id,
                    "waiting_for_user",
                    None,
                    Some(&serialized),
                    None,
                )
                .await?;
            crate::routines::mark_agent_run_waiting(&repository.pool, &frame.run_id).await?;
            let kind = params
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("approval");
            let interruption = if kind == "clarification" {
                json!({ "id": params.get("id").cloned().unwrap_or_else(|| json!(event_id)), "sessionId": frame.session_id, "runId": frame.run_id, "status": "pending", "createdAt": created_at, "kind": "clarification", "question": params.get("question").cloned().unwrap_or_else(|| json!("What would you like June to do?")), "choices": params.get("choices").cloned().unwrap_or_else(|| json!([])) })
            } else {
                json!({ "id": params.get("id").cloned().unwrap_or_else(|| json!(event_id)), "sessionId": frame.session_id, "runId": frame.run_id, "status": "pending", "createdAt": created_at, "kind": "approval", "toolName": params.get("toolName").cloned().unwrap_or_else(|| json!("unknown_tool")), "title": "Approval required", "description": "June needs permission to use this tool.", "allowAlways": false })
            };
            data = json!({ "itemId": format!("interruption:{event_id}"), "interruption": interruption });
            Some(AgentItemPayload::Interruption(data["interruption"].clone()))
        }
        "usage.updated" => {
            let current = repository.get_run(&frame.run_id).await?;
            repository
                .update_run_status(&frame.run_id, &current.status, Some(&params), None, None)
                .await?;
            None
        }
        "run.started" => {
            data["startedAt"] = json!(created_at);
            repository
                .update_run_status(&frame.run_id, "running", None, None, None)
                .await?;
            crate::routines::mark_agent_run_resumed(&repository.pool, &frame.run_id).await?;
            if params
                .get("compacted")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                let summary_text = params
                    .get("contextSummary")
                    .and_then(|summary| summary.get("text"))
                    .and_then(Value::as_str);
                let removed_item_ids = params
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
                if let Some(summary_text) = summary_text {
                    if let Some(summary) = repository
                        .replace_items_with_context_summary(
                            &frame.session_id,
                            &frame.run_id,
                            summary_text,
                            &removed_item_ids,
                        )
                        .await?
                    {
                        data["removedItemIds"] = json!(removed_item_ids);
                        data["contextSummary"] = json!({
                            "id": summary.id,
                            "sessionId": summary.session_id,
                            "runId": summary.run_id,
                            "sequence": summary.sequence,
                            "createdAt": summary.created_at,
                            "kind": "context_summary",
                            "text": summary_text,
                        });
                    }
                }
            }
            None
        }
        "run.completed" => {
            data["completedAt"] = json!(created_at);
            repository
                .update_run_status(&frame.run_id, "completed", None, None, None)
                .await?;
            None
        }
        "run.cancelled" => {
            data["completedAt"] = json!(created_at);
            repository
                .update_run_status(&frame.run_id, "cancelled", None, None, None)
                .await?;
            None
        }
        "run.failed" => {
            data = json!({ "completedAt": created_at, "message": params.get("error").cloned().unwrap_or_else(|| json!("Agent run failed.")), "retryable": true });
            repository
                .update_run_status(
                    &frame.run_id,
                    "failed",
                    None,
                    None,
                    Some((
                        "agent_run_failed",
                        data["message"].as_str().unwrap_or("Agent run failed."),
                    )),
                )
                .await?;
            Some(AgentItemPayload::Error(data.clone()))
        }
        _ => None,
    };
    if let Some(payload) = payload {
        let _ = repository
            .append_item(
                &frame.session_id,
                Some(&frame.run_id),
                frame.sequence,
                &payload,
                Some(&event_id),
            )
            .await?;
    }
    app.emit(AGENT_RUNTIME_EVENT, json!({ "protocolVersion": PROTOCOL_VERSION, "sessionId": frame.session_id, "runId": frame.run_id, "sequence": frame.sequence, "eventId": event_id, "method": method, "data": data })).map_err(|error| AppError::new("agent_event_emit_failed", error.to_string()))?;
    Ok(())
}

fn tool_payload(params: &Value, status: &str) -> ToolPayload {
    ToolPayload {
        tool_name: params
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string),
        tool_call_id: params
            .get("callId")
            .and_then(Value::as_str)
            .map(str::to_string),
        arguments: params.get("arguments").cloned(),
        result: params
            .get("output")
            .cloned()
            .or_else(|| params.get("error").cloned()),
        status: Some(status.into()),
    }
}

fn resolve_runtime_command(app: &AppHandle) -> Result<(PathBuf, Vec<PathBuf>), AppError> {
    if cfg!(debug_assertions) {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("agent-runtime")
            .join("dist")
            .join("main.js");
        if !script.is_file() {
            return Err(AppError::new(
                "agent_runtime_missing",
                format!("Build the development runtime first: {}", script.display()),
            ));
        }
        return Ok((
            PathBuf::from(if cfg!(target_os = "windows") {
                "node.exe"
            } else {
                "node"
            }),
            vec![script],
        ));
    }
    let name = if cfg!(target_os = "windows") {
        "june-agent-runtime.exe"
    } else {
        "june-agent-runtime"
    };
    let executable = app
        .path()
        .resource_dir()
        .map_err(|error| AppError::new("agent_runtime_missing", error.to_string()))?
        .join("native")
        .join("bin")
        .join(name);
    if !executable.is_file() {
        return Err(AppError::new(
            "agent_runtime_missing",
            format!(
                "Agent runtime resource is missing: {}",
                executable.display()
            ),
        ));
    }
    Ok((executable, Vec::new()))
}

async fn write_frame(stdin: &Arc<Mutex<ChildStdin>>, frame: &RpcFrame) -> Result<(), AppError> {
    let mut bytes = serde_json::to_vec(frame)
        .map_err(|error| AppError::new("agent_protocol_encode_failed", error.to_string()))?;
    bytes.push(b'\n');
    let mut stdin = stdin.lock().await;
    stdin
        .write_all(&bytes)
        .await
        .map_err(|error| AppError::new("agent_runtime_disconnected", error.to_string()))?;
    stdin
        .flush()
        .await
        .map_err(|error| AppError::new("agent_runtime_disconnected", error.to_string()))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn sanitize_log(value: &str) -> String {
    let mut value = value.replace("Bearer ", "Bearer [redacted]");
    if value.len() > 2_000 {
        value.truncate(2_000);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_gateway_errors_preserve_top_level_messages() {
        assert_eq!(
            model_gateway_error_message(&json!({ "message": "model_required" })),
            "model_required"
        );
    }

    #[test]
    fn model_gateway_errors_preserve_nested_messages() {
        assert_eq!(
            model_gateway_error_message(&json!({ "error": { "message": "invalid tool result" } })),
            "invalid tool result"
        );
    }
}
