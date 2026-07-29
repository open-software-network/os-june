//! Headless Agent Client Protocol entrypoint for external hosts such as Buzz.
//! The wire transport is newline-delimited JSON-RPC 2.0 over stdin/stdout.

use crate::{
    agent_mcp::{EphemeralMcpServer, RuntimeToolDescriptorJson},
    agent_runtime::{api::start_acp_run, AgentRepository, AgentRuntimeHost, AgentSafetyMode},
    domain::types::AppError,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, sync::Arc};
use tauri::{AppHandle, Listener, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, Mutex},
};

const ACP_PROTOCOL_VERSION: u64 = 2;
const MAX_PROMPT_CHARS: usize = 1_000_000;
const DEFAULT_SESSION_TITLE: &str = "Buzz session";

#[derive(Clone)]
struct SessionState {
    system_prompt: Option<String>,
    tools: Vec<RuntimeToolDescriptorJson>,
    active: Option<ActivePrompt>,
}

#[derive(Clone)]
struct ActivePrompt {
    request_id: Value,
    run_id: String,
}

#[derive(Debug)]
enum Input {
    Message(Value),
    Invalid(String),
    Closed,
}

#[derive(Debug)]
struct RuntimeEvent {
    session_id: String,
    run_id: String,
    method: String,
    data: Value,
}

pub async fn serve(app: AppHandle) -> Result<(), AppError> {
    let output = Arc::new(Mutex::new(tokio::io::stdout()));
    let (input_tx, mut input_rx) = mpsc::unbounded_channel();
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    tauri::async_runtime::spawn(read_input(input_tx));
    let listener_id = app.listen(
        crate::agent_runtime::host::AGENT_RUNTIME_EVENT,
        move |event| {
            let parsed = serde_json::from_str::<Value>(event.payload())
                .ok()
                .and_then(parse_runtime_event);
            if let Some(event) = parsed {
                let _ = event_tx.send(event);
            }
        },
    );

    let mut initialized = false;
    let mut sessions = BTreeMap::<String, SessionState>::new();
    loop {
        tokio::select! {
            Some(input) = input_rx.recv() => {
                match input {
                    Input::Closed => break,
                    Input::Invalid(message) => {
                        write_value(&output, &rpc_error(Value::Null, -32700, &message)).await?;
                    }
                    Input::Message(message) => {
                        if let Err(error) = handle_message(
                            &app,
                            &output,
                            &mut initialized,
                            &mut sessions,
                            message,
                        ).await {
                            eprintln!("June ACP request failed: {}", error.message);
                        }
                    }
                }
            }
            Some(event) = event_rx.recv() => {
                handle_runtime_event(&output, &mut sessions, event).await?;
            }
            else => break,
        }
    }

    app.unlisten(listener_id);
    let host = app.state::<AgentRuntimeHost>();
    for session_id in sessions.keys() {
        host.unregister_ephemeral_mcp(session_id).await;
    }
    host.shutdown().await;
    Ok(())
}

async fn read_input(sender: mpsc::UnboundedSender<Input>) {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) if line.trim().is_empty() => continue,
            Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                Ok(value) => {
                    if sender.send(Input::Message(value)).is_err() {
                        return;
                    }
                }
                Err(_) => {
                    if sender.send(Input::Invalid("Invalid JSON".into())).is_err() {
                        return;
                    }
                }
            },
            Ok(None) => {
                let _ = sender.send(Input::Closed);
                return;
            }
            Err(error) => {
                let _ = sender.send(Input::Invalid(error.to_string()));
                let _ = sender.send(Input::Closed);
                return;
            }
        }
    }
}

async fn handle_message(
    app: &AppHandle,
    output: &Arc<Mutex<tokio::io::Stdout>>,
    initialized: &mut bool,
    sessions: &mut BTreeMap<String, SessionState>,
    message: Value,
) -> Result<(), AppError> {
    let id = message.get("id").cloned();
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") || method.is_empty() {
        if let Some(id) = id {
            write_value(output, &rpc_error(id, -32600, "Invalid JSON-RPC request")).await?;
        }
        return Ok(());
    }
    if !*initialized && method != "initialize" {
        if let Some(id) = id {
            write_value(
                output,
                &rpc_error(id, -32002, "Initialize June before creating a session"),
            )
            .await?;
        }
        return Ok(());
    }
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    match method {
        "initialize" => {
            let Some(id) = id else {
                return Ok(());
            };
            let requested = params
                .get("protocolVersion")
                .and_then(Value::as_u64)
                .unwrap_or_default();
            if requested != ACP_PROTOCOL_VERSION {
                write_value(
                    output,
                    &rpc_error(id, -32602, "June supports ACP protocol version 2"),
                )
                .await?;
                return Ok(());
            }
            *initialized = true;
            write_value(output, &rpc_result(id, initialize_result())).await?;
        }
        "session/new" => {
            let Some(id) = id else {
                return Ok(());
            };
            match create_session(app, &params).await {
                Ok((session_id, state)) => {
                    sessions.insert(session_id.clone(), state);
                    write_value(output, &rpc_result(id, json!({ "sessionId": session_id })))
                        .await?;
                }
                Err(error) => {
                    write_value(output, &rpc_error(id, -32602, &error.message)).await?;
                }
            }
        }
        "session/prompt" => {
            let Some(id) = id else {
                return Ok(());
            };
            let session_id = match params.get("sessionId").and_then(Value::as_str) {
                Some(value) => value.to_string(),
                None => {
                    write_value(output, &rpc_error(id, -32602, "sessionId is required")).await?;
                    return Ok(());
                }
            };
            let prompt = match prompt_text(&params) {
                Ok(prompt) => prompt,
                Err(message) => {
                    write_value(output, &rpc_error(id, -32602, &message)).await?;
                    return Ok(());
                }
            };
            let Some(state) = sessions.get(&session_id) else {
                write_value(output, &rpc_error(id, -32001, "ACP session was not found")).await?;
                return Ok(());
            };
            if state.active.is_some() {
                write_value(
                    output,
                    &rpc_error(id, -32003, "ACP session already has an active turn"),
                )
                .await?;
                return Ok(());
            }
            let tools = state.tools.clone();
            let system_prompt = state.system_prompt.clone();
            let host = app.state::<AgentRuntimeHost>();
            match start_acp_run(
                app,
                &host,
                &session_id,
                &prompt,
                system_prompt.as_deref(),
                &tools,
            )
            .await
            {
                Ok(run) => {
                    if let Some(state) = sessions.get_mut(&session_id) {
                        state.active = Some(ActivePrompt {
                            request_id: id,
                            run_id: run.id,
                        });
                    }
                }
                Err(error) => {
                    write_value(output, &rpc_error(id, -32000, &error.message)).await?;
                }
            }
        }
        "session/cancel" => {
            if let Some(session_id) = params.get("sessionId").and_then(Value::as_str) {
                if let Some(active) = sessions
                    .get(session_id)
                    .and_then(|state| state.active.as_ref())
                    .cloned()
                {
                    let host = app.state::<AgentRuntimeHost>();
                    let _ = host
                        .request("run.cancel", session_id, &active.run_id, json!({}))
                        .await;
                    host.cancel_run_streams(&active.run_id).await;
                }
            }
        }
        _ => {
            if let Some(id) = id {
                write_value(output, &rpc_error(id, -32601, "Method not found")).await?;
            }
        }
    }
    Ok(())
}

async fn create_session(
    app: &AppHandle,
    params: &Value,
) -> Result<(String, SessionState), AppError> {
    let cwd = params
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::new("acp_invalid_session", "cwd is required"))?;
    if !Path::new(cwd).is_absolute() || !Path::new(cwd).is_dir() {
        return Err(AppError::new(
            "acp_invalid_session",
            "cwd must be an existing absolute directory",
        ));
    }
    let servers = parse_mcp_servers(params)?;
    let title = params
        .pointer("/_meta/sessionTitle")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_SESSION_TITLE)
        .chars()
        .take(100)
        .collect::<String>();
    let repositories = crate::commands::repositories(app).await?;
    let repository = AgentRepository::new(repositories.pool);
    let session = repository
        .create_session_in_profile(
            &title,
            crate::providers::AUTO_GENERATION_MODEL,
            AgentSafetyMode::Unrestricted,
            Some(cwd),
            "default",
        )
        .await?;
    let host = app.state::<AgentRuntimeHost>();
    let tools = match host.register_ephemeral_mcp(&session.id, servers).await {
        Ok(tools) => tools,
        Err(error) => {
            let _ = repository.delete_session(&session.id).await;
            return Err(error);
        }
    };
    Ok((
        session.id,
        SessionState {
            system_prompt: params
                .get("systemPrompt")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            tools,
            active: None,
        },
    ))
}

fn parse_mcp_servers(params: &Value) -> Result<Vec<EphemeralMcpServer>, AppError> {
    let values = params
        .get("mcpServers")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::new("acp_invalid_session", "mcpServers must be an array"))?;
    values
        .iter()
        .map(|value| {
            let required = |key: &str| {
                value
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .ok_or_else(|| {
                        AppError::new(
                            "acp_invalid_session",
                            format!("MCP server {key} is required"),
                        )
                    })
            };
            let args = value
                .get("args")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    AppError::new("acp_invalid_session", "MCP server args must be an array")
                })?
                .iter()
                .map(|argument| {
                    argument.as_str().map(str::to_string).ok_or_else(|| {
                        AppError::new(
                            "acp_invalid_session",
                            "MCP server args must contain strings",
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            let env = value
                .get("env")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    AppError::new("acp_invalid_session", "MCP server env must be an array")
                })?
                .iter()
                .map(|entry| {
                    let name = entry
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| {
                            AppError::new(
                                "acp_invalid_session",
                                "MCP environment variable name is required",
                            )
                        })?;
                    let value = entry.get("value").and_then(Value::as_str).ok_or_else(|| {
                        AppError::new(
                            "acp_invalid_session",
                            "MCP environment variable value must be a string",
                        )
                    })?;
                    Ok((name.to_string(), value.to_string()))
                })
                .collect::<Result<BTreeMap<_, _>, AppError>>()?;
            Ok(EphemeralMcpServer {
                name: required("name")?,
                command: required("command")?,
                args,
                env,
            })
        })
        .collect()
}

fn prompt_text(params: &Value) -> Result<String, String> {
    let blocks = params
        .get("prompt")
        .and_then(Value::as_array)
        .ok_or_else(|| "prompt must be an array".to_string())?;
    let text = blocks
        .iter()
        .map(|block| {
            if block.get("type").and_then(Value::as_str) != Some("text") {
                return Err("June ACP currently accepts text prompt blocks".to_string());
            }
            block
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| "Text prompt blocks require text".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?
        .join("\n\n");
    if text.trim().is_empty() {
        return Err("prompt must contain text".into());
    }
    if text.chars().count() > MAX_PROMPT_CHARS {
        return Err("prompt is too large".into());
    }
    Ok(text)
}

fn parse_runtime_event(value: Value) -> Option<RuntimeEvent> {
    Some(RuntimeEvent {
        session_id: value.get("sessionId")?.as_str()?.to_string(),
        run_id: value.get("runId")?.as_str()?.to_string(),
        method: value.get("method")?.as_str()?.to_string(),
        data: value.get("data").cloned().unwrap_or_else(|| json!({})),
    })
}

async fn handle_runtime_event(
    output: &Arc<Mutex<tokio::io::Stdout>>,
    sessions: &mut BTreeMap<String, SessionState>,
    event: RuntimeEvent,
) -> Result<(), AppError> {
    let Some(state) = sessions.get_mut(&event.session_id) else {
        return Ok(());
    };
    let Some(active) = state.active.as_ref() else {
        return Ok(());
    };
    if active.run_id != event.run_id {
        return Ok(());
    }
    if let Some(update) = acp_update(&event.method, &event.data) {
        write_value(
            output,
            &json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": { "sessionId": event.session_id, "update": update },
            }),
        )
        .await?;
    }
    match event.method.as_str() {
        "run.completed" => {
            let active = state.active.take().expect("active prompt checked");
            write_value(
                output,
                &rpc_result(active.request_id, json!({ "stopReason": "end_turn" })),
            )
            .await?;
        }
        "run.cancelled" => {
            let active = state.active.take().expect("active prompt checked");
            write_value(
                output,
                &rpc_result(active.request_id, json!({ "stopReason": "cancelled" })),
            )
            .await?;
        }
        "run.failed" | "interruption.requested" => {
            let active = state.active.take().expect("active prompt checked");
            let message = event
                .data
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("June could not complete the ACP turn");
            write_value(output, &rpc_error(active.request_id, -32000, message)).await?;
        }
        _ => {}
    }
    Ok(())
}

fn acp_update(method: &str, data: &Value) -> Option<Value> {
    match method {
        "message.delta" => Some(json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": data.get("delta")?.as_str()? },
        })),
        "reasoning.delta" => Some(json!({
            "sessionUpdate": "agent_thought_chunk",
            "content": { "type": "text", "text": data.get("delta")?.as_str()? },
        })),
        "tool.started" => Some(json!({
            "sessionUpdate": "tool_call",
            "toolCallId": data.get("callId")?.as_str()?,
            "title": data.get("name").and_then(Value::as_str).unwrap_or("Tool"),
            "kind": "other",
            "status": "in_progress",
            "rawInput": data.get("arguments").cloned().unwrap_or(Value::Null),
        })),
        "tool.completed" | "tool.failed" => Some(json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": data.get("callId")?.as_str()?,
            "status": if method == "tool.completed" { "completed" } else { "failed" },
            "rawOutput": data.get("output").cloned().or_else(|| data.get("error").cloned()).unwrap_or(Value::Null),
        })),
        _ => None,
    }
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": ACP_PROTOCOL_VERSION,
        "agentCapabilities": {
            "loadSession": false,
            "promptCapabilities": { "image": false, "audio": false, "embeddedContext": false },
            "mcpCapabilities": { "http": false, "sse": false },
        },
        "agentInfo": {
            "name": "june",
            "title": "June",
            "version": env!("CARGO_PKG_VERSION"),
        },
    })
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

async fn write_value(
    output: &Arc<Mutex<tokio::io::Stdout>>,
    value: &Value,
) -> Result<(), AppError> {
    let mut output = output.lock().await;
    let mut bytes = serde_json::to_vec(value)
        .map_err(|error| AppError::new("acp_encode_failed", error.to_string()))?;
    bytes.push(b'\n');
    output
        .write_all(&bytes)
        .await
        .map_err(|error| AppError::new("acp_write_failed", error.to_string()))?;
    output
        .flush()
        .await
        .map_err(|error| AppError::new("acp_write_failed", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_advertises_buzz_protocol_version() {
        let result = initialize_result();
        assert_eq!(result["protocolVersion"], 2);
        assert_eq!(result["agentInfo"]["name"], "june");
    }

    #[test]
    fn joins_buzz_text_blocks_in_order() {
        let text = prompt_text(&json!({
            "prompt": [
                { "type": "text", "text": "/goal ship it" },
                { "type": "text", "text": "[Buzz context]" }
            ]
        }))
        .unwrap();
        assert_eq!(text, "/goal ship it\n\n[Buzz context]");
    }

    #[test]
    fn maps_streaming_and_tool_events_to_acp_updates() {
        assert_eq!(
            acp_update("message.delta", &json!({ "delta": "hello" })).unwrap(),
            json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "hello" }
            })
        );
        assert_eq!(
            acp_update(
                "tool.started",
                &json!({ "callId": "call-1", "name": "send_message", "arguments": { "text": "hi" } })
            )
            .unwrap()["sessionUpdate"],
            "tool_call"
        );
    }

    #[test]
    fn parses_buzz_mcp_server_shape() {
        let parsed = parse_mcp_servers(&json!({
            "mcpServers": [{
                "name": "buzz",
                "command": "/usr/local/bin/buzz-cli",
                "args": ["mcp"],
                "env": [{ "name": "BUZZ_PRIVATE_KEY", "value": "secret" }]
            }]
        }))
        .unwrap();
        assert_eq!(parsed[0].name, "buzz");
        assert_eq!(parsed[0].args, vec!["mcp"]);
        assert_eq!(
            parsed[0].env.get("BUZZ_PRIVATE_KEY"),
            Some(&"secret".to_string())
        );
    }
}
