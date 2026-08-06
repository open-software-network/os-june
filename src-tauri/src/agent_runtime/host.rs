use super::{
    protocol::{RpcFrame, PROTOCOL_VERSION},
    tools::{dispatch_tool, ToolCancellationRegistry, ToolContext},
    AgentItemPayload, AgentRepository, AgentRunDto, TextPayload, ToolPayload,
};
use crate::domain::types::AppError;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc, Weak,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
};
use uuid::Uuid;

pub const AGENT_RUNTIME_EVENT: &str = "clovy://agent-runtime-event";
const RUNTIME_CONTROL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const HISTORY_COMPACTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
type PendingRequests = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, AppError>>>>>;
type OwnedRuns = Arc<Mutex<HashSet<(String, String)>>>;

pub(crate) fn emit_persisted_run_cancelled(
    app: &AppHandle,
    run: &AgentRunDto,
) -> Result<(), AppError> {
    app.emit(
        AGENT_RUNTIME_EVENT,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": run.session_id,
            "runId": run.id,
            "sequence": run.last_sequence.saturating_add(1),
            "eventId": Uuid::new_v4(),
            "method": "run.cancelled",
            "data": {
                "completedAt": run.completed_at,
            },
        }),
    )
    .map_err(|error| AppError::new("agent_event_emit_failed", error.to_string()))
}

#[derive(Default)]
pub struct AgentRuntimeHost {
    inner: Mutex<Option<RunningRuntime>>,
    startup: Mutex<()>,
    request_sequence: AtomicI64,
    interruption_resolutions: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    model_streams: Arc<Mutex<HashMap<String, ModelStream>>>,
    model_scopes: Arc<Mutex<HashSet<String>>>,
    cancellations: ToolCancellationRegistry,
}

struct ModelStream {
    response: crate::clovy_api::AgentChatCompletionsResponse,
    route: crate::clovy_api::AgentModelRouteMetadata,
    buffer: Vec<u8>,
    done: bool,
    run_id: String,
}

struct RunningRuntime {
    id: Uuid,
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: PendingRequests,
    expected_exit: Arc<AtomicBool>,
    owned_runs: OwnedRuns,
}

struct RuntimeReaderContext {
    app: AppHandle,
    repository: AgentRepository,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: PendingRequests,
    model_streams: Arc<Mutex<HashMap<String, ModelStream>>>,
    model_scopes: Arc<Mutex<HashSet<String>>>,
    cancellations: ToolCancellationRegistry,
    expected_exit: Arc<AtomicBool>,
    owned_runs: OwnedRuns,
}

impl AgentRuntimeHost {
    pub(crate) async fn lock_interruption_resolution(
        &self,
        interruption_id: &str,
    ) -> tokio::sync::OwnedMutexGuard<()> {
        let resolution = {
            let mut resolutions = self.interruption_resolutions.lock().await;
            resolutions.retain(|_, resolution| resolution.strong_count() > 0);
            if let Some(resolution) = resolutions.get(interruption_id).and_then(Weak::upgrade) {
                resolution
            } else {
                let resolution = Arc::new(Mutex::new(()));
                resolutions.insert(interruption_id.to_string(), Arc::downgrade(&resolution));
                resolution
            }
        };
        resolution.lock_owned().await
    }

    pub async fn ensure_started(
        &self,
        app: &AppHandle,
        repository: AgentRepository,
    ) -> Result<(), AppError> {
        // Keep a second caller from observing a spawned process before the
        // initialize handshake has completed.
        let _startup = self.startup.lock().await;
        let mut guard = self.inner.lock().await;
        if let Some(runtime) = guard.as_mut() {
            if runtime_process_running(&mut runtime.child) {
                return Ok(());
            }
            // An exited child retains its pid until it is reaped. Drop the
            // stale pipes so the next request gets a fresh initialized runtime
            // instead of writing to the dead process.
            *guard = None;
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
        let runtime_id = Uuid::new_v4();
        let expected_exit = Arc::new(AtomicBool::new(false));
        let owned_runs = Arc::new(Mutex::new(HashSet::new()));
        spawn_stdout_reader(
            stdout,
            RuntimeReaderContext {
                app: app.clone(),
                repository: repository.clone(),
                stdin: stdin.clone(),
                pending: pending.clone(),
                model_streams: self.model_streams.clone(),
                model_scopes: self.model_scopes.clone(),
                cancellations: self.cancellations.clone(),
                expected_exit: expected_exit.clone(),
                owned_runs: owned_runs.clone(),
            },
        );
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::warn!(target: "agent_runtime", "{}", sanitize_log(&line));
            }
        });
        *guard = Some(RunningRuntime {
            id: runtime_id,
            child,
            stdin,
            pending,
            expected_exit,
            owned_runs,
        });
        drop(guard);
        let initialized = self
            .request(
                "runtime.initialize",
                "runtime",
                "runtime",
                json!({
                    "clientName": "Clovy", "clientVersion": env!("CARGO_PKG_VERSION")
                }),
            )
            .await;
        if let Err(error) = initialized {
            self.discard_failed_start().await;
            return Err(error);
        }
        Ok(())
    }

    async fn discard_failed_start(&self) {
        let mut guard = self.inner.lock().await;
        let Some(mut runtime) = guard.take() else {
            return;
        };
        runtime.expected_exit.store(true, Ordering::Release);
        let _ = runtime.child.kill().await;
        let _ = runtime.child.wait().await;
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
        let runtime_id = runtime.id;
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
        let pending = runtime.pending.clone();
        let owned_runs = runtime.owned_runs.clone();
        let owns_run = matches!(method, "run.start" | "run.resume");
        if owns_run {
            runtime
                .owned_runs
                .lock()
                .await
                .insert((session_id.to_string(), run_id.to_string()));
        }
        if opens_model_scope(method) {
            self.model_scopes.lock().await.insert(run_id.to_string());
        }
        pending.lock().await.insert(id.clone(), send);
        if let Err(error) = write_frame(&runtime.stdin, &frame).await {
            pending.lock().await.remove(&id);
            if owns_run && error.code == "agent_protocol_encode_failed" {
                runtime
                    .owned_runs
                    .lock()
                    .await
                    .remove(&(session_id.to_string(), run_id.to_string()));
            }
            if opens_model_scope(method) {
                self.cancel_run_streams(run_id).await;
            }
            return Err(error);
        }
        drop(guard);
        let response = self
            .await_request_response(
                &pending,
                &id,
                receive,
                runtime_request_timeout(method),
                run_id,
                opens_model_scope(method),
            )
            .await;
        if response
            .as_ref()
            .is_err_and(|error| error.code == "agent_runtime_request_timed_out")
        {
            self.terminate_timed_out_runtime(runtime_id).await;
        }
        if owns_run
            && response
                .as_ref()
                .is_err_and(|error| error.code == "agent_runtime_request_failed")
        {
            owned_runs
                .lock()
                .await
                .remove(&(session_id.to_string(), run_id.to_string()));
        }
        response
    }

    async fn terminate_timed_out_runtime(&self, runtime_id: Uuid) {
        let mut guard = self.inner.lock().await;
        if !guard
            .as_ref()
            .is_some_and(|runtime| runtime.id == runtime_id)
        {
            return;
        }
        let Some(mut runtime) = guard.take() else {
            return;
        };
        tracing::warn!(%runtime_id, "terminating an unresponsive agent runtime");
        let _ = runtime.child.kill().await;
        let _ = runtime.child.wait().await;
    }

    async fn await_request_response(
        &self,
        pending: &PendingRequests,
        id: &str,
        receive: oneshot::Receiver<Result<Value, AppError>>,
        timeout: std::time::Duration,
        run_id: &str,
        cancel_scope_on_error: bool,
    ) -> Result<Value, AppError> {
        let response = await_runtime_response(pending, id, receive, timeout).await;
        if response.is_err()
            && (cancel_scope_on_error
                || response
                    .as_ref()
                    .is_err_and(|error| error.code == "agent_runtime_request_timed_out"))
        {
            self.cancel_run_streams(run_id).await;
        }
        response
    }

    pub async fn shutdown(&self) {
        let _startup = self.startup.lock().await;
        crate::agent_mcp::shutdown_sessions().await;
        cancel_all_model_scopes(&self.model_streams, &self.model_scopes, &self.cancellations).await;
        let mut guard = self.inner.lock().await;
        let Some(mut runtime) = guard.take() else {
            return;
        };
        runtime.expected_exit.store(true, Ordering::Release);
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
        cancel_model_scope(
            &self.model_streams,
            &self.model_scopes,
            &self.cancellations,
            run_id,
        )
        .await;
    }
}

fn opens_model_scope(method: &str) -> bool {
    matches!(method, "run.start" | "run.resume" | "history.compact")
}

fn runtime_request_timeout(method: &str) -> std::time::Duration {
    if method == "history.compact" {
        HISTORY_COMPACTION_TIMEOUT
    } else {
        RUNTIME_CONTROL_TIMEOUT
    }
}

async fn await_runtime_response(
    pending: &PendingRequests,
    id: &str,
    receive: oneshot::Receiver<Result<Value, AppError>>,
    timeout: std::time::Duration,
) -> Result<Value, AppError> {
    match tokio::time::timeout(timeout, receive).await {
        Ok(response) => response.map_err(|_| {
            AppError::new("agent_runtime_disconnected", "Agent runtime disconnected.")
        })?,
        Err(_) => {
            pending.lock().await.remove(id);
            Err(AppError::new(
                "agent_runtime_request_timed_out",
                "The local agent runtime did not respond in time.",
            ))
        }
    }
}

fn spawn_stdout_reader(stdout: tokio::process::ChildStdout, context: RuntimeReaderContext) {
    tauri::async_runtime::spawn(async move {
        let RuntimeReaderContext {
            app,
            repository,
            stdin,
            pending,
            model_streams,
            model_scopes,
            cancellations,
            expected_exit,
            owned_runs,
        } = context;
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
                let persisted = match persist_and_emit_event(&app, &repository, &frame).await {
                    Ok(()) => true,
                    Err(error) => {
                        tracing::warn!(%error.message, "Failed to persist agent event");
                        false
                    }
                };
                if runtime_event_releases_run(frame.method.as_deref()) {
                    if persisted {
                        owned_runs
                            .lock()
                            .await
                            .remove(&(frame.session_id.clone(), frame.run_id.clone()));
                    }
                    cancel_model_scope(
                        &model_streams,
                        &model_scopes,
                        &cancellations,
                        &frame.run_id,
                    )
                    .await;
                }
                continue;
            }
            let request_app = app.clone();
            let request_repository = repository.clone();
            let request_streams = model_streams.clone();
            let request_scopes = model_scopes.clone();
            let request_cancellations = cancellations.clone();
            let request_stdin = stdin.clone();
            tauri::async_runtime::spawn(async move {
                let response = handle_runtime_request(
                    &request_app,
                    &request_repository,
                    &request_streams,
                    &request_scopes,
                    &request_cancellations,
                    &frame,
                )
                .await;
                let response_frame = match response {
                    Ok(value) => RpcFrame::success(&frame, value),
                    Err(error) => {
                        let mut response = RpcFrame::failure(&frame, -32603, error.message);
                        if let Some(rpc_error) = response.error.as_mut() {
                            rpc_error.data = Some(json!({ "appErrorCode": error.code }));
                        }
                        response
                    }
                };
                let _ = write_frame(&request_stdin, &response_frame).await;
            });
        }
        for (_, sender) in pending.lock().await.drain() {
            let _ = sender.send(Err(AppError::new(
                "agent_runtime_disconnected",
                "Agent runtime disconnected.",
            )));
        }
        if !expected_exit.load(Ordering::Acquire) {
            let runs = owned_runs.lock().await.drain().collect::<Vec<_>>();
            for (stored_session_id, agent_run_id) in runs {
                cancel_model_scope(&model_streams, &model_scopes, &cancellations, &agent_run_id)
                    .await;
                match repository.get_run(&agent_run_id).await {
                    Ok(run)
                        if run.session_id == stored_session_id
                            && matches!(
                                run.status.as_str(),
                                "queued" | "running" | "waiting_for_user"
                            ) =>
                    {
                        let frame = RpcFrame {
                            jsonrpc: "2.0".into(),
                            protocol_version: PROTOCOL_VERSION,
                            session_id: stored_session_id,
                            run_id: agent_run_id,
                            sequence: run.last_sequence.saturating_add(1),
                            id: None,
                            event_id: Some(Uuid::new_v4().to_string()),
                            method: Some("run.failed".into()),
                            params: Some(json!({
                                "error": "Clovy stopped unexpectedly.",
                                "category": "runtime",
                                "code": "runtime_crashed",
                                "retryable": true,
                            })),
                            result: None,
                            error: None,
                        };
                        if let Err(error) = persist_and_emit_event(&app, &repository, &frame).await
                        {
                            tracing::warn!(
                                agent_run_id = %frame.run_id,
                                stored_session_id = %frame.session_id,
                                error_code = %error.code,
                                "failed to settle an agent run after the runtime stopped"
                            );
                        }
                    }
                    Ok(_) => {}
                    Err(error) => tracing::warn!(
                        agent_run_id,
                        %error,
                        "failed to load an agent run after its owning runtime stopped"
                    ),
                }
            }
        }
    });
}

fn runtime_event_releases_run(method: Option<&str>) -> bool {
    matches!(
        method,
        Some("interruption.requested" | "run.completed" | "run.cancelled" | "run.failed")
    )
}

async fn handle_runtime_request(
    app: &AppHandle,
    repository: &AgentRepository,
    model_streams: &Arc<Mutex<HashMap<String, ModelStream>>>,
    model_scopes: &Arc<Mutex<HashSet<String>>>,
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
            if name == "__clovy_notion_action_preflight" {
                let runtime_name = arguments
                    .get("toolName")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        AppError::new("agent_protocol_invalid", "Notion tool name is required.")
                    })?;
                let tool_arguments = arguments
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let call_id = params
                    .get("callId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        AppError::new("agent_protocol_invalid", "Notion call id is required.")
                    })?;
                let preflight = crate::connectors::notion::preflight_runtime_action(
                    app,
                    runtime_name,
                    &tool_arguments,
                    &frame.run_id,
                    call_id,
                )
                .await?;
                if let Some(row) = sqlx::query::query("SELECT payload_json FROM agent_items WHERE run_id = ? AND kind = 'interruption' AND json_extract(payload_json, '$.id') = ? ORDER BY created_at DESC LIMIT 1")
                    .bind(&frame.run_id).bind(call_id).fetch_optional(&repository.pool).await?
                {
                    use sqlx::row::Row;
                    let payload: Value = serde_json::from_str(&row.get::<String, _>("payload_json")).map_err(|error| AppError::new("notion_action_binding_invalid", error.to_string()))?;
                    let binding = payload.get("approvalBinding").ok_or_else(|| AppError::new("notion_action_binding_missing", "The Notion approval binding is unavailable."))?;
                    if binding.get("digest").and_then(Value::as_str) != Some(&preflight.digest) {
                        return Err(AppError::new("notion_action_binding_mismatch", "The approved Notion action or connection changed. Please try again."));
                    }
                }
                return serde_json::to_value(preflight).map_err(|error| {
                    AppError::new("agent_connector_response_invalid", error.to_string())
                });
            }
            if matches!(
                name,
                "__clovy_model_chat_completions" | "__june_model_chat_completions"
            ) {
                if !model_scopes.lock().await.contains(&frame.run_id) {
                    return Err(AppError::new(
                        "agent_model_scope_inactive",
                        "The agent model scope is no longer active.",
                    ));
                }
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
                let mut cancelled = cancellations.register(&frame.run_id).await;
                if !model_scopes.lock().await.contains(&frame.run_id) {
                    return Err(AppError::new(
                        "agent_model_scope_inactive",
                        "The agent model scope is no longer active.",
                    ));
                }
                let response = tokio::select! {
                    response = crate::clovy_api::proxy_agent_chat_completions(request) => response?,
                    _ = cancelled.cancelled() => {
                        return Err(AppError::new(
                            "agent_model_scope_cancelled",
                            "The agent model request was cancelled.",
                        ));
                    }
                };
                if response.status >= 400 {
                    let bytes = response.collect_body().await?;
                    let body: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
                    return Err(AppError::new(
                        "agent_model_request_failed",
                        model_gateway_error_message(&body),
                    ));
                }
                let stream_id = Uuid::new_v4().to_string();
                let route = response.route.clone();
                let scopes = model_scopes.lock().await;
                if !scopes.contains(&frame.run_id) {
                    return Err(AppError::new(
                        "agent_model_scope_inactive",
                        "The agent model scope is no longer active.",
                    ));
                }
                model_streams.lock().await.insert(
                    stream_id.clone(),
                    ModelStream {
                        response,
                        route,
                        buffer: Vec::new(),
                        done: false,
                        run_id: frame.run_id.clone(),
                    },
                );
                drop(scopes);
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

async fn cancel_model_scope(
    model_streams: &Arc<Mutex<HashMap<String, ModelStream>>>,
    model_scopes: &Arc<Mutex<HashSet<String>>>,
    cancellations: &ToolCancellationRegistry,
    run_id: &str,
) {
    model_scopes.lock().await.remove(run_id);
    model_streams
        .lock()
        .await
        .retain(|_, stream| stream.run_id != run_id);
    cancellations.cancel(run_id).await;
}

async fn cancel_all_model_scopes(
    model_streams: &Arc<Mutex<HashMap<String, ModelStream>>>,
    model_scopes: &Arc<Mutex<HashSet<String>>>,
    cancellations: &ToolCancellationRegistry,
) {
    let scopes = model_scopes.lock().await.drain().collect::<Vec<_>>();
    model_streams.lock().await.clear();
    for scope in scopes {
        cancellations.cancel(&scope).await;
    }
}

fn model_gateway_error_message(body: &Value) -> &str {
    body.get("error")
        .and_then(|error| error.get("message").or(Some(error)))
        .and_then(Value::as_str)
        .or_else(|| body.get("message").and_then(Value::as_str))
        .unwrap_or("Clovy's model routing service rejected the request.")
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
    let result =
        json!({ "streamId": stream_id, "chunks": chunks, "done": done, "route": stream.route });
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
    let mut persistence_external_id = event_id.clone();
    let mut data = params.clone();
    let payload = match method {
        "message.delta" => {
            data["itemId"] = json!(assistant_id);
            data["role"] = json!("assistant");
            data["createdAt"] = json!(created_at);
            repository
                .append_assistant_message_delta(
                    &frame.session_id,
                    &frame.run_id,
                    frame.sequence,
                    params
                        .get("delta")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    &assistant_id,
                )
                .await?;
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
            repository
                .complete_assistant_message(
                    &frame.session_id,
                    &frame.run_id,
                    frame.sequence,
                    text,
                    &assistant_id,
                )
                .await?;
            None
        }
        "reasoning.delta" => {
            data["itemId"] = json!(reasoning_id);
            data["createdAt"] = json!(created_at);
            repository
                .append_reasoning_delta(
                    &frame.session_id,
                    &frame.run_id,
                    frame.sequence,
                    params
                        .get("delta")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    &reasoning_id,
                )
                .await?;
            None
        }
        "steering.consumed" => {
            persistence_external_id = steering_stable_id(&params, &event_id);
            data["itemId"] = json!(persistence_external_id.clone());
            data["createdAt"] = json!(created_at);
            Some(AgentItemPayload::Steering(TextPayload {
                text: params
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .into(),
                metadata: None,
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
            let usage = params.get("usage");
            repository
                .update_run_status(
                    &frame.run_id,
                    "waiting_for_user",
                    usage,
                    Some(&serialized),
                    None,
                )
                .await?;
            crate::routines::mark_agent_run_waiting(&repository.pool, &frame.run_id).await?;
            let kind = params
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("approval");
            let interruption_id = interruption_stable_id(&params, &event_id);
            persistence_external_id = interruption_external_id(&frame.run_id, &interruption_id);
            let interruption = match kind {
                "clarification" => {
                    json!({ "id": interruption_id, "sessionId": frame.session_id, "runId": frame.run_id, "status": "pending", "createdAt": created_at, "kind": "clarification", "question": params.get("question").cloned().unwrap_or_else(|| json!("What would you like Clovy to do?")), "choices": params.get("choices").cloned().unwrap_or_else(|| json!([])) })
                }
                "secret" => {
                    json!({ "id": interruption_id, "sessionId": frame.session_id, "runId": frame.run_id, "status": "pending", "createdAt": created_at, "kind": "secret", "reason": params.get("reason").cloned().unwrap_or_else(|| json!("Clovy needs a secret before it can continue.")) })
                }
                _ => {
                    let tool_name = params
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown_tool");
                    if let Some(presentation) = params.get("approvalPresentation") {
                        json!({ "id": interruption_id, "toolCallId": params.get("callId").cloned().unwrap_or(Value::Null), "sessionId": frame.session_id, "runId": frame.run_id, "status": "pending", "createdAt": created_at, "kind": "approval", "toolName": tool_name, "title": presentation.get("title").cloned().unwrap_or_else(|| json!("Approval required")), "description": presentation.get("description").cloned().unwrap_or_else(|| json!("Review this Notion action.")), "command": presentation.get("command").cloned().unwrap_or_else(|| json!(tool_name)), "preview": presentation.get("preview").cloned().unwrap_or(Value::Null), "approvalBinding": params.get("approvalBinding").cloned().unwrap_or(Value::Null), "allowAlways": false })
                    } else {
                        let (operation_name, operation_description) =
                            approval_operation_identity(&params, tool_name);
                        let command = approval_command(&operation_name, params.get("arguments"));
                        json!({ "id": interruption_id, "toolCallId": params.get("callId").cloned().unwrap_or(Value::Null), "sessionId": frame.session_id, "runId": frame.run_id, "status": "pending", "createdAt": created_at, "kind": "approval", "toolName": tool_name, "title": "Approval required", "description": format!("Clovy wants to run {operation_description}. Review the requested operation before approving."), "command": command, "allowAlways": false })
                    }
                }
            };
            data = json!({ "itemId": persistence_external_id, "interruption": interruption });
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
            let run = repository
                .update_run_status(&frame.run_id, "running", None, None, None)
                .await?;
            if run.status != "running" {
                tracing::warn!(
                    run_id = %frame.run_id,
                    status = %run.status,
                    "ignored a late run.started event for a terminal run"
                );
                return Ok(());
            }
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
                let summary_metadata = params
                    .get("contextSummary")
                    .and_then(|summary| summary.get("metadata"));
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
                            summary_metadata,
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
                            "metadata": summary_metadata,
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
            if let Err(error) =
                crate::routines::mark_agent_run_terminal(&repository.pool, &frame.run_id).await
            {
                tracing::warn!(agent_run_id = %frame.run_id, error_code = %error.code, "routine terminal projection failed");
            }
            None
        }
        "run.cancelled" => {
            data["completedAt"] = json!(created_at);
            repository
                .update_run_status(&frame.run_id, "cancelled", None, None, None)
                .await?;
            if let Err(error) =
                crate::routines::mark_agent_run_terminal(&repository.pool, &frame.run_id).await
            {
                tracing::warn!(agent_run_id = %frame.run_id, error_code = %error.code, "routine terminal projection failed");
            }
            None
        }
        "run.failed" => {
            let message = params
                .get("error")
                .and_then(Value::as_str)
                .map(sanitize_log)
                .unwrap_or_else(|| "Agent run failed.".into());
            let category = params
                .get("category")
                .and_then(Value::as_str)
                .filter(|value| {
                    matches!(
                        *value,
                        "tool" | "provider" | "runtime" | "context" | "credits"
                    )
                })
                .unwrap_or("runtime");
            let code = params
                .get("code")
                .and_then(Value::as_str)
                .filter(|value| value.starts_with("agent_") || *value == "runtime_crashed")
                .unwrap_or("agent_runtime_failed");
            let retryable = params
                .get("retryable")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            data = json!({ "completedAt": created_at, "message": message, "category": category, "code": code, "retryable": retryable });
            repository
                .update_run_status(
                    &frame.run_id,
                    "failed",
                    None,
                    None,
                    Some((
                        code,
                        data["message"].as_str().unwrap_or("Agent run failed."),
                    )),
                )
                .await?;
            if let Err(error) =
                crate::routines::mark_agent_run_terminal(&repository.pool, &frame.run_id).await
            {
                tracing::warn!(agent_run_id = %frame.run_id, error_code = %error.code, "routine terminal projection failed");
            }
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
                Some(&persistence_external_id),
            )
            .await?;
    }
    match method {
        "interruption.requested" if is_computer_use_approval(&params) => {
            let interruption_id = interruption_stable_id(&params, &event_id);
            let arguments = params.get("arguments").unwrap_or(&Value::Null);
            if let Some(tool_call_id) = params.get("callId").and_then(Value::as_str) {
                if let Err(error) = crate::companion::register_computer_use_approval(
                    app,
                    &interruption_id,
                    tool_call_id,
                    &frame.session_id,
                    arguments,
                )
                .await
                {
                    tracing::warn!(
                        code = %error.code,
                        request_id = %interruption_id,
                        tool_call_id,
                        stored_session_id = %frame.session_id,
                        "did not route Computer use approval to a linked companion"
                    );
                }
            } else {
                tracing::warn!(
                    request_id = %interruption_id,
                    stored_session_id = %frame.session_id,
                    "kept Computer use approval desktop-local because its tool call identity was missing"
                );
            }
        }
        "tool.started" | "tool.completed" | "tool.failed"
            if params.get("name").and_then(Value::as_str) == Some("computer_use") =>
        {
            if let Some(tool_call_id) = params.get("callId").and_then(Value::as_str) {
                let status = match method {
                    "tool.started" => crate::companion::ComputerUseExecutionStatus::Started,
                    "tool.completed" => crate::companion::ComputerUseExecutionStatus::Succeeded,
                    _ => crate::companion::ComputerUseExecutionStatus::Failed,
                };
                crate::companion::publish_computer_use_execution_status(
                    app,
                    tool_call_id,
                    &frame.session_id,
                    status,
                );
            }
        }
        _ => {}
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

fn is_computer_use_approval(params: &Value) -> bool {
    params
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("approval")
        == "approval"
        && params.get("toolName").and_then(Value::as_str) == Some("computer_use")
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
        "clovy-agent-runtime.exe"
    } else {
        "clovy-agent-runtime"
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

fn approval_command(tool_name: &str, arguments: Option<&Value>) -> String {
    let details = match arguments {
        Some(Value::Object(arguments)) => arguments
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                serde_json::to_string_pretty(arguments).unwrap_or_else(|_| "{}".into())
            }),
        Some(arguments) => arguments.to_string(),
        None => "{}".into(),
    };
    sanitize_log(&format!("{tool_name} {details}"))
}

fn approval_operation_identity(params: &Value, fallback: &str) -> (String, String) {
    let provider = params.get("approvalProvider").and_then(Value::as_str);
    let remote_tool_name = params.get("approvalRemoteToolName").and_then(Value::as_str);
    match (provider, remote_tool_name) {
        (Some(provider), Some(remote_tool_name))
            if !provider.is_empty() && !remote_tool_name.is_empty() =>
        {
            (
                format!("{provider}:{remote_tool_name}"),
                format!("{provider} tool {remote_tool_name}"),
            )
        }
        _ => (fallback.to_string(), fallback.to_string()),
    }
}

fn interruption_stable_id(params: &Value, event_id: &str) -> String {
    params
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(event_id)
        .to_string()
}

fn interruption_external_id(run_id: &str, interruption_id: &str) -> String {
    format!("interruption:{run_id}:{interruption_id}")
}

fn steering_stable_id(params: &Value, event_id: &str) -> String {
    format!(
        "steering:{}",
        params
            .get("messageId")
            .and_then(Value::as_str)
            .unwrap_or(event_id)
    )
}

pub(crate) fn sanitize_log(value: &str) -> String {
    let value = redact_bearer_tokens(value);
    let value = redact_key_tokens(&value);
    let value = redact_named_secrets(&value);
    value.chars().take(2_000).collect()
}

fn redact_named_secrets(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = String::with_capacity(value.len());
    let mut copy_from = 0;
    let mut cursor = 0;
    while cursor < bytes.len() {
        if matches!(bytes[cursor], b':' | b'=') {
            let mut key_end = cursor;
            while key_end > 0 && bytes[key_end - 1].is_ascii_whitespace() {
                key_end -= 1;
            }
            if key_end > 0 && matches!(bytes[key_end - 1], b'\'' | b'"') {
                key_end -= 1;
            }
            let mut key_start = key_end;
            while key_start > 0
                && matches!(bytes[key_start - 1], b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-')
            {
                key_start -= 1;
            }
            let key = value[key_start..key_end].to_ascii_lowercase();
            if matches!(
                key.as_str(),
                "authorization"
                    | "api-key"
                    | "api_key"
                    | "apikey"
                    | "cookie"
                    | "password"
                    | "secret"
            ) || key.contains("token")
            {
                let redact_through_line = matches!(key.as_str(), "authorization" | "cookie");
                let mut value_start = cursor + 1;
                while value_start < bytes.len() && bytes[value_start].is_ascii_whitespace() {
                    value_start += 1;
                }
                output.push_str(&value[copy_from..value_start]);
                if value_start < bytes.len() && matches!(bytes[value_start], b'\'' | b'"') {
                    let quote = bytes[value_start];
                    output.push(char::from(quote));
                    output.push_str("[redacted]");
                    let mut value_end = value_start + 1;
                    while value_end < bytes.len()
                        && bytes[value_end] != quote
                        && !matches!(bytes[value_end], b'\r' | b'\n')
                    {
                        value_end += 1;
                    }
                    if value_end < bytes.len() && bytes[value_end] == quote {
                        output.push(char::from(quote));
                        value_end += 1;
                    }
                    copy_from = value_end;
                    cursor = value_end;
                } else {
                    output.push_str("[redacted]");
                    let mut value_end = value_start;
                    while value_end < bytes.len()
                        && !matches!(bytes[value_end], b'\r' | b'\n')
                        && (redact_through_line
                            || !matches!(bytes[value_end], b',' | b';' | b'}' | b']'))
                    {
                        value_end += 1;
                    }
                    copy_from = value_end;
                    cursor = value_end;
                }
                continue;
            }
        }
        cursor += 1;
    }
    output.push_str(&value[copy_from..]);
    output
}

fn runtime_process_running(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(None))
}

fn redact_bearer_tokens(value: &str) -> String {
    const PREFIX: &str = "bearer ";
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    while cursor < value.len() {
        let tail = &value[cursor..];
        if tail
            .get(..PREFIX.len())
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(PREFIX))
        {
            output.push_str(&tail[..PREFIX.len()]);
            output.push_str("[redacted]");
            cursor += PREFIX.len();
            while cursor < value.len() {
                let character = value[cursor..]
                    .chars()
                    .next()
                    .expect("cursor remains on a character boundary");
                if !matches!(character, 'A'..='Z' | 'a'..='z' | '0'..='9' | '.' | '_' | '~' | '+' | '/' | '=' | '-')
                {
                    break;
                }
                cursor += character.len_utf8();
            }
            continue;
        }
        let character = tail
            .chars()
            .next()
            .expect("cursor remains on a character boundary");
        output.push(character);
        cursor += character.len_utf8();
    }
    output
}

fn redact_key_tokens(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    while cursor < value.len() {
        let tail = &value[cursor..];
        let prefix_len = if tail.starts_with("osk_") {
            4
        } else if tail.starts_with("sk_") {
            3
        } else {
            0
        };
        if prefix_len > 0 {
            let mut end = cursor + prefix_len;
            while end < value.len() {
                let character = value[end..]
                    .chars()
                    .next()
                    .expect("token cursor remains on a character boundary");
                if !(character == '_' || character == '-' || character.is_ascii_alphanumeric()) {
                    break;
                }
                end += character.len_utf8();
            }
            if end - cursor >= prefix_len + 12 {
                output.push_str("[redacted]");
                cursor = end;
                continue;
            }
        }
        let character = tail
            .chars()
            .next()
            .expect("cursor remains on a character boundary");
        output.push(character);
        cursor += character.len_utf8();
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consumed_steering_uses_message_id_as_its_persisted_external_id() {
        assert_eq!(
            steering_stable_id(&json!({ "messageId": "message-1" }), "event-1"),
            "steering:message-1"
        );
        assert_eq!(
            steering_stable_id(&json!({}), "event-1"),
            "steering:event-1"
        );
    }

    #[test]
    fn history_compaction_uses_the_data_plane_timeout() {
        assert_eq!(
            runtime_request_timeout("history.compact"),
            std::time::Duration::from_secs(120)
        );
        assert_eq!(
            runtime_request_timeout("run.start"),
            std::time::Duration::from_secs(15)
        );
    }

    #[test]
    fn parked_and_terminal_events_release_runtime_run_ownership() {
        for method in [
            "interruption.requested",
            "run.completed",
            "run.cancelled",
            "run.failed",
        ] {
            assert!(runtime_event_releases_run(Some(method)), "{method}");
        }
        assert!(!runtime_event_releases_run(Some("run.started")));
        assert!(!runtime_event_releases_run(Some("tool.failed")));
    }

    #[tokio::test]
    async fn timed_out_control_requests_drop_pending_and_cancel_the_model_scope() {
        let host = AgentRuntimeHost::default();
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let id = "request-timeout";
        let scope = "run-timeout";
        host.model_scopes.lock().await.insert(scope.into());
        let _registration = host.cancellations.register(scope).await;
        let (send, receive) = oneshot::channel();
        pending.lock().await.insert(id.into(), send);

        let error = host
            .await_request_response(
                &pending,
                id,
                receive,
                std::time::Duration::ZERO,
                scope,
                false,
            )
            .await
            .expect_err("the pending response must time out");

        assert_eq!(error.code, "agent_runtime_request_timed_out");
        assert!(!pending.lock().await.contains_key(id));
        assert!(!host.model_scopes.lock().await.contains(scope));
        assert_eq!(host.cancellations.registration_count(scope), 0);
    }

    #[tokio::test]
    async fn cancelling_a_scope_disposes_its_live_model_registrations() {
        let host = AgentRuntimeHost::default();
        let scope = "run-timeout";
        host.model_scopes.lock().await.insert(scope.into());
        let _registration = host.cancellations.register(scope).await;
        assert_eq!(host.cancellations.registration_count(scope), 1);

        host.cancel_run_streams(scope).await;

        assert!(!host.model_scopes.lock().await.contains(scope));
        assert_eq!(host.cancellations.registration_count(scope), 0);
    }

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

    #[test]
    fn runtime_logs_remove_credentials_and_bound_unicode_safely() {
        let sanitized = sanitize_log(&format!(
            "Authorization: Basic dXNlcjpwYXNz\nCookie: session=abc; csrf=def\nBearer live.token-123 osk_abcdefghijklmnop sk_abcdefghijklmnop\npassword=plain\napi_key='second key'\n{{\"access_token\":\"third-token\"}}\n{}",
            "é".repeat(2_100)
        ));
        assert!(!sanitized.contains("live.token-123"));
        assert!(!sanitized.contains("dXNlcjpwYXNz"));
        assert!(!sanitized.contains("csrf=def"));
        assert!(!sanitized.contains("osk_abcdefghijklmnop"));
        assert!(!sanitized.contains("sk_abcdefghijklmnop"));
        assert!(!sanitized.contains("password=plain"));
        assert!(!sanitized.contains("second key"));
        assert!(!sanitized.contains("third-token"));
        assert!(sanitized.contains("Authorization: [redacted]"));
        assert!(sanitized.contains("Cookie: [redacted]"));
        assert!(sanitized.contains("password=[redacted]"));
        assert!(sanitized.contains("api_key='[redacted]'"));
        assert!(sanitized.contains("\"access_token\":\"[redacted]\""));
        assert!(sanitized.chars().count() <= 2_000);
    }

    #[test]
    fn approval_cards_preserve_sanitized_operation_details() {
        let command = approval_command(
            "write_file",
            Some(&json!({
                "path": "/workspace/report.md",
                "content": "safe content",
                "token": "[redacted]"
            })),
        );

        assert!(command.contains("write_file"));
        assert!(command.contains("/workspace/report.md"));
        assert!(command.contains("safe content"));
        assert!(command.contains("[redacted]"));
    }

    #[test]
    fn hosted_approval_identity_preserves_provider_and_remote_tool_name() {
        let params = json!({
            "approvalProvider": "Linear",
            "approvalRemoteToolName": "save-issue.v2"
        });
        assert_eq!(
            approval_operation_identity(&params, "mcp_linear_save_issue"),
            (
                "Linear:save-issue.v2".to_string(),
                "Linear tool save-issue.v2".to_string()
            )
        );
    }

    #[test]
    fn interruption_persistence_uses_the_stable_sdk_id_across_transport_replays() {
        let params = json!({
            "id": "sdk-interruption-1",
            "callId": "sdk-tool-call-1"
        });
        let first = interruption_stable_id(&params, "transport-event-a");
        let replay = interruption_stable_id(&params, "transport-event-b");

        assert_eq!(first, replay);
        assert_eq!(
            interruption_external_id("run-1", &first),
            interruption_external_id("run-1", &replay)
        );
        assert_ne!(
            interruption_external_id("run-1", &first),
            interruption_external_id("run-2", &replay)
        );
        assert_ne!(
            interruption_stable_id(&params, "transport-event-a"),
            params["callId"]
        );
        assert_eq!(
            interruption_stable_id(&json!({}), "transport-event-c"),
            "transport-event-c"
        );
    }

    #[test]
    fn only_computer_use_approval_interruptions_are_remotely_routable() {
        assert!(is_computer_use_approval(
            &json!({ "toolName": "computer_use" })
        ));
        assert!(is_computer_use_approval(
            &json!({ "kind": "approval", "toolName": "computer_use" })
        ));
        assert!(!is_computer_use_approval(
            &json!({ "kind": "secret", "toolName": "computer_use" })
        ));
        assert!(!is_computer_use_approval(
            &json!({ "kind": "approval", "toolName": "run_shell" })
        ));
    }

    #[tokio::test]
    async fn interruption_resolution_lock_is_scoped_to_one_interruption() {
        let host = AgentRuntimeHost::default();
        let first = host.lock_interruption_resolution("approval-1").await;

        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(10),
                host.lock_interruption_resolution("approval-1"),
            )
            .await
            .is_err(),
            "the same interruption must serialize"
        );
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(10),
                host.lock_interruption_resolution("approval-2"),
            )
            .await
            .is_ok(),
            "an unrelated interruption must not wait for a slow sidecar RPC"
        );

        drop(first);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exited_runtime_children_are_not_treated_as_running() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .expect("short-lived child should start");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        assert!(
            child.id().is_some(),
            "the exited child has not been reaped yet"
        );
        assert!(!runtime_process_running(&mut child));
    }
}
