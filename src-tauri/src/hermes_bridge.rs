use crate::domain::types::AppError;
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use std::{
    io,
    net::TcpListener,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::oneshot,
};

const READY_TIMEOUT: Duration = Duration::from_secs(45);
const READY_POLL: Duration = Duration::from_millis(500);
const SCRIBE_HERMES_COMMAND_ENV: &str = "SCRIBE_HERMES_COMMAND";

const ISOLATED_HERMES_ENV_VARS: &[&str] = &[
    "HERMES_HOME",
    "HERMES_CONFIG",
    "HERMES_CONFIG_PATH",
    "HERMES_DASHBOARD_SESSION_TOKEN",
    "HERMES_MODEL",
    "HERMES_PROVIDER",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "VENICE_API_KEY",
    "ANTHROPIC_API_KEY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
];

#[derive(Default)]
pub struct HermesBridge {
    process: Mutex<Option<HermesProcess>>,
}

struct HermesProcess {
    child: Child,
    connection: HermesBridgeConnection,
    proxy: Option<ScribeProviderProxy>,
}

struct ScribeProviderProxy {
    shutdown: Option<oneshot::Sender<()>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesBridgeConnection {
    pub base_url: String,
    pub ws_url: String,
    pub token: String,
    pub port: u16,
    pub command: String,
    pub hermes_home: String,
    pub provider_proxy_port: u16,
    pub pid: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesBridgeStatus {
    pub running: bool,
    pub connection: Option<HermesBridgeConnection>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartHermesBridgeRequest {
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleHermesCapabilityRequest {
    pub name: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateHermesMessagingPlatformRequest {
    pub platform_id: String,
    pub enabled: Option<bool>,
    pub env: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesSessionsRequest {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub archived: Option<String>,
    pub min_messages: Option<u32>,
    pub order: Option<String>,
    pub query: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesSessionMessagesRequest {
    pub session_id: String,
}

#[tauri::command]
pub async fn hermes_bridge_status(
    bridge: State<'_, HermesBridge>,
) -> Result<HermesBridgeStatus, AppError> {
    let mut guard = bridge
        .process
        .lock()
        .map_err(|_| AppError::new("hermes_bridge_unavailable", "Hermes bridge lock failed."))?;
    let Some(process) = guard.as_mut() else {
        return Ok(HermesBridgeStatus {
            running: false,
            connection: None,
            message: Some("Hermes bridge is not running.".to_string()),
        });
    };
    match process.child.try_wait() {
        Ok(Some(status)) => {
            *guard = None;
            Ok(HermesBridgeStatus {
                running: false,
                connection: None,
                message: Some(format!("Hermes exited with status {status}.")),
            })
        }
        Ok(None) => Ok(HermesBridgeStatus {
            running: true,
            connection: Some(process.connection.clone()),
            message: None,
        }),
        Err(error) => Err(AppError::new(
            "hermes_bridge_status_failed",
            error.to_string(),
        )),
    }
}

#[tauri::command]
pub async fn start_hermes_bridge(
    app: AppHandle,
    bridge: State<'_, HermesBridge>,
    request: StartHermesBridgeRequest,
) -> Result<HermesBridgeStatus, AppError> {
    start_hermes_bridge_inner(&app, &bridge, request).await
}

pub fn start_on_app_start(app: &tauri::App) {
    let app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let bridge = app.state::<HermesBridge>();
        if let Err(error) =
            start_hermes_bridge_inner(&app, &bridge, StartHermesBridgeRequest { cwd: None }).await
        {
            eprintln!(
                "failed to start Hermes bridge during app startup: {}",
                error.message
            );
        }
    });
}

async fn start_hermes_bridge_inner(
    app: &AppHandle,
    bridge: &HermesBridge,
    request: StartHermesBridgeRequest,
) -> Result<HermesBridgeStatus, AppError> {
    if let Some(status) = existing_running_status(bridge)? {
        return Ok(status);
    }

    let command = resolve_hermes_command();
    let port = pick_port()?;
    let token = random_token();
    let base_url = format!("http://127.0.0.1:{port}");
    let ws_url = format!(
        "ws://127.0.0.1:{port}/api/ws?token={}",
        urlencoding::encode(&token)
    );
    let cwd = request
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::current_dir().ok());
    let hermes_home = resolve_scribe_hermes_home(app)?;
    let provider_proxy = start_scribe_provider_proxy().await?;
    sync_hermes_config(&hermes_home, provider_proxy.port)?;

    let mut cmd = Command::new(&command);
    cmd.args([
        "dashboard",
        "--no-open",
        "--tui",
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    apply_isolated_hermes_env(&mut cmd, &hermes_home, &token);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }

    let child = cmd.spawn().map_err(|error| {
        AppError::new(
            "hermes_bridge_start_failed",
            format!("Could not start Hermes. Install Hermes or set {SCRIBE_HERMES_COMMAND_ENV}. {error}"),
        )
    })?;
    let pid = child.id();
    let connection = HermesBridgeConnection {
        base_url: base_url.clone(),
        ws_url,
        token: token.clone(),
        port,
        command,
        hermes_home: hermes_home.to_string_lossy().into_owned(),
        provider_proxy_port: provider_proxy.port,
        pid,
    };

    {
        let mut guard = bridge.process.lock().map_err(|_| {
            AppError::new("hermes_bridge_unavailable", "Hermes bridge lock failed.")
        })?;
        *guard = Some(HermesProcess {
            child,
            connection: connection.clone(),
            proxy: Some(ScribeProviderProxy {
                shutdown: Some(provider_proxy.shutdown),
            }),
        });
    }

    if let Err(error) = wait_for_hermes(&base_url, &token).await {
        let _ = stop_hermes_bridge_inner(bridge);
        return Err(error);
    }

    Ok(HermesBridgeStatus {
        running: true,
        connection: Some(connection),
        message: None,
    })
}

#[tauri::command]
pub async fn stop_hermes_bridge(
    bridge: State<'_, HermesBridge>,
) -> Result<HermesBridgeStatus, AppError> {
    stop_hermes_bridge_inner(&bridge)?;
    Ok(HermesBridgeStatus {
        running: false,
        connection: None,
        message: Some("Hermes bridge stopped.".to_string()),
    })
}

#[tauri::command]
pub async fn hermes_bridge_skills(
    bridge: State<'_, HermesBridge>,
) -> Result<serde_json::Value, AppError> {
    hermes_api_json(&bridge, reqwest::Method::GET, "/api/skills", None).await
}

#[tauri::command]
pub async fn toggle_hermes_bridge_skill(
    bridge: State<'_, HermesBridge>,
    request: ToggleHermesCapabilityRequest,
) -> Result<serde_json::Value, AppError> {
    hermes_api_json(
        &bridge,
        reqwest::Method::PUT,
        "/api/skills/toggle",
        Some(serde_json::json!({
            "name": request.name,
            "enabled": request.enabled,
        })),
    )
    .await
}

#[tauri::command]
pub async fn hermes_bridge_toolsets(
    bridge: State<'_, HermesBridge>,
) -> Result<serde_json::Value, AppError> {
    hermes_api_json(&bridge, reqwest::Method::GET, "/api/tools/toolsets", None).await
}

#[tauri::command]
pub async fn toggle_hermes_bridge_toolset(
    bridge: State<'_, HermesBridge>,
    request: ToggleHermesCapabilityRequest,
) -> Result<serde_json::Value, AppError> {
    hermes_api_json(
        &bridge,
        reqwest::Method::PUT,
        &format!("/api/tools/toolsets/{}", urlencoding::encode(&request.name)),
        Some(serde_json::json!({
            "enabled": request.enabled,
        })),
    )
    .await
}

#[tauri::command]
pub async fn hermes_bridge_messaging_platforms(
    bridge: State<'_, HermesBridge>,
) -> Result<serde_json::Value, AppError> {
    hermes_api_json(
        &bridge,
        reqwest::Method::GET,
        "/api/messaging/platforms",
        None,
    )
    .await
}

#[tauri::command]
pub async fn update_hermes_bridge_messaging_platform(
    bridge: State<'_, HermesBridge>,
    request: UpdateHermesMessagingPlatformRequest,
) -> Result<serde_json::Value, AppError> {
    hermes_api_json(
        &bridge,
        reqwest::Method::PUT,
        &format!(
            "/api/messaging/platforms/{}",
            urlencoding::encode(&request.platform_id)
        ),
        Some(serde_json::json!({
            "enabled": request.enabled,
            "env": request.env.unwrap_or_default(),
        })),
    )
    .await
}

#[tauri::command]
pub async fn hermes_bridge_sessions(
    bridge: State<'_, HermesBridge>,
    request: HermesSessionsRequest,
) -> Result<serde_json::Value, AppError> {
    let mut params = vec![
        ("limit", request.limit.unwrap_or(100).to_string()),
        ("offset", request.offset.unwrap_or(0).to_string()),
    ];
    if let Some(archived) = request
        .archived
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        params.push(("archived", archived.to_string()));
    }
    if let Some(min_messages) = request.min_messages {
        params.push(("min_messages", min_messages.to_string()));
    }
    if let Some(order) = request
        .order
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        params.push(("order", order.to_string()));
    }
    if let Some(query) = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        params.push(("q", query.to_string()));
    }
    let query = params
        .into_iter()
        .map(|(key, value)| format!("{key}={}", urlencoding::encode(&value)))
        .collect::<Vec<_>>()
        .join("&");
    hermes_api_json(
        &bridge,
        reqwest::Method::GET,
        &format!("/api/sessions?{query}"),
        None,
    )
    .await
}

#[tauri::command]
pub async fn hermes_bridge_session_messages(
    bridge: State<'_, HermesBridge>,
    request: HermesSessionMessagesRequest,
) -> Result<serde_json::Value, AppError> {
    hermes_api_json(
        &bridge,
        reqwest::Method::GET,
        &format!(
            "/api/sessions/{}/messages",
            urlencoding::encode(&request.session_id)
        ),
        None,
    )
    .await
}

pub fn shutdown(app: &tauri::AppHandle) {
    let bridge = app.state::<HermesBridge>();
    let _ = stop_hermes_bridge_inner(&bridge);
}

async fn hermes_api_json(
    bridge: &State<'_, HermesBridge>,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, AppError> {
    let connection = {
        let mut guard = bridge.process.lock().map_err(|_| {
            AppError::new("hermes_bridge_unavailable", "Hermes bridge lock failed.")
        })?;
        let Some(process) = guard.as_mut() else {
            return Err(AppError::new(
                "hermes_bridge_not_running",
                "Hermes bridge is not running.",
            ));
        };
        match process.child.try_wait() {
            Ok(Some(status)) => {
                *guard = None;
                return Err(AppError::new(
                    "hermes_bridge_not_running",
                    format!("Hermes exited with status {status}."),
                ));
            }
            Ok(None) => process.connection.clone(),
            Err(error) => {
                return Err(AppError::new(
                    "hermes_bridge_status_failed",
                    error.to_string(),
                ));
            }
        }
    };
    let url = format!("{}{}", connection.base_url, path);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| AppError::new("hermes_bridge_api_failed", error.to_string()))?;
    let mut request = client
        .request(method, &url)
        .header("X-Hermes-Session-Token", connection.token)
        .header("Content-Type", "application/json");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| AppError::new("hermes_bridge_api_failed", error.to_string()))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| AppError::new("hermes_bridge_api_failed", error.to_string()))?;
    if !status.is_success() {
        return Err(AppError::new(
            "hermes_bridge_api_failed",
            format!("Hermes API returned {status}: {text}"),
        ));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::json!(null));
    }
    serde_json::from_str(&text)
        .map_err(|error| AppError::new("hermes_bridge_api_failed", error.to_string()))
}

fn existing_running_status(bridge: &HermesBridge) -> Result<Option<HermesBridgeStatus>, AppError> {
    let mut guard = bridge
        .process
        .lock()
        .map_err(|_| AppError::new("hermes_bridge_unavailable", "Hermes bridge lock failed."))?;
    let Some(process) = guard.as_mut() else {
        return Ok(None);
    };
    match process.child.try_wait() {
        Ok(Some(_)) => {
            *guard = None;
            Ok(None)
        }
        Ok(None) => Ok(Some(HermesBridgeStatus {
            running: true,
            connection: Some(process.connection.clone()),
            message: None,
        })),
        Err(error) => Err(AppError::new(
            "hermes_bridge_status_failed",
            error.to_string(),
        )),
    }
}

fn stop_hermes_bridge_inner(bridge: &HermesBridge) -> Result<(), AppError> {
    let mut process = bridge
        .process
        .lock()
        .map_err(|_| AppError::new("hermes_bridge_unavailable", "Hermes bridge lock failed."))?
        .take();
    if let Some(process) = process.as_mut() {
        let _ = process.child.kill();
        let _ = process.child.wait();
        if let Some(proxy) = process.proxy.as_mut() {
            if let Some(shutdown) = proxy.shutdown.take() {
                let _ = shutdown.send(());
            }
        }
    }
    Ok(())
}

fn resolve_hermes_command() -> String {
    std::env::var(SCRIBE_HERMES_COMMAND_ENV).unwrap_or_else(|_| {
        std::env::var("HOME")
            .ok()
            .map(|home| {
                [
                    std::path::PathBuf::from(&home).join(".hermes/hermes-agent/venv/bin/hermes"),
                    std::path::PathBuf::from(&home).join(".local/bin/hermes"),
                ]
            })
            .and_then(|paths| paths.into_iter().find(|path| path.exists()))
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| "hermes".to_string())
    })
}

fn apply_isolated_hermes_env(cmd: &mut Command, hermes_home: &std::path::Path, token: &str) {
    for name in ISOLATED_HERMES_ENV_VARS {
        cmd.env_remove(name);
    }
    cmd.env("HERMES_HOME", hermes_home)
        .env("HERMES_DASHBOARD_SESSION_TOKEN", token)
        .env("NO_PROXY", "127.0.0.1,localhost,::1")
        .env("no_proxy", "127.0.0.1,localhost,::1");
}

fn resolve_scribe_hermes_home(app: &AppHandle) -> Result<PathBuf, AppError> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::new("hermes_bridge_home_failed", error.to_string()))?
        .join("hermes");
    std::fs::create_dir_all(&path)
        .map_err(|error| AppError::new("hermes_bridge_home_failed", error.to_string()))?;
    Ok(path)
}

fn sync_hermes_config(
    hermes_home: &std::path::Path,
    provider_proxy_port: u16,
) -> Result<(), AppError> {
    let model = crate::providers::generation_model();
    let base_url = format!("http://127.0.0.1:{provider_proxy_port}/v1");
    let config = format!(
        r#"model:
  default: {model}
  provider: custom
  base_url: {base_url}
  api_key: scribe-backend
  api_mode: chat_completions
agent:
  max_turns: 90
display:
  skin: mono
"#,
        model = yaml_string(&model),
        base_url = yaml_string(&base_url),
    );
    std::fs::write(hermes_home.join("config.yaml"), config)
        .map_err(|error| AppError::new("hermes_bridge_config_failed", error.to_string()))
}

fn yaml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

async fn start_scribe_provider_proxy() -> Result<RunningScribeProviderProxy, AppError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| AppError::new("scribe_provider_proxy_failed", error.to_string()))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| AppError::new("scribe_provider_proxy_failed", error.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|error| AppError::new("scribe_provider_proxy_failed", error.to_string()))?
        .port();
    let listener = tokio::net::TcpListener::from_std(listener)
        .map_err(|error| AppError::new("scribe_provider_proxy_failed", error.to_string()))?;
    let (shutdown, shutdown_rx) = oneshot::channel();
    tauri::async_runtime::spawn(run_scribe_provider_proxy(listener, shutdown_rx));
    Ok(RunningScribeProviderProxy { port, shutdown })
}

struct RunningScribeProviderProxy {
    port: u16,
    shutdown: oneshot::Sender<()>,
}

async fn run_scribe_provider_proxy(
    listener: tokio::net::TcpListener,
    mut shutdown: oneshot::Receiver<()>,
) {
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        tauri::async_runtime::spawn(async move {
                            let _ = handle_scribe_provider_connection(stream).await;
                        });
                    }
                    Err(_) => break,
                }
            }
        }
    }
}

async fn handle_scribe_provider_connection(mut stream: tokio::net::TcpStream) -> io::Result<()> {
    let request = match read_http_request(&mut stream).await {
        Ok(request) => request,
        Err(error) => {
            let _ = write_json_response(
                &mut stream,
                400,
                serde_json::json!({ "error": { "message": error.to_string() } }),
            )
            .await;
            return Ok(());
        }
    };
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/v1/models") => {
            let model = crate::providers::generation_model();
            let body = serde_json::json!({
                "object": "list",
                "data": [{
                    "id": model,
                    "object": "model",
                    "created": 0,
                    "owned_by": "scribe"
                }]
            });
            write_json_response(&mut stream, 200, body).await?;
        }
        ("POST", "/v1/chat/completions") => {
            let body = serde_json::from_slice::<serde_json::Value>(&request.body)
                .unwrap_or_else(|_| serde_json::json!({}));
            match crate::scribe_api::proxy_agent_chat_completions(body).await {
                Ok(response) => {
                    write_raw_response(
                        &mut stream,
                        response.status,
                        &response.content_type,
                        &response.body,
                    )
                    .await?;
                }
                Err(error) => {
                    write_json_response(
                        &mut stream,
                        502,
                        serde_json::json!({
                            "error": {
                                "message": format!("Scribe agent provider failed: {}", error.message),
                                "type": error.code
                            }
                        }),
                    )
                    .await?;
                }
            }
        }
        _ => {
            write_json_response(
                &mut stream,
                404,
                serde_json::json!({ "error": { "message": "Not found" } }),
            )
            .await?;
        }
    }
    Ok(())
}

struct HttpRequest {
    method: String,
    path: String,
    body: Vec<u8>,
}

async fn read_http_request(stream: &mut tokio::net::TcpStream) -> io::Result<HttpRequest> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if buffer.len() > 1024 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HTTP headers are too large",
            ));
        }
    }
    let header_end = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Incomplete HTTP request"))?;
    let headers = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = headers.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Missing HTTP request line"))?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or("").to_string();
    let path = request_parts
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("")
        .to_string();
    let content_length = lines
        .filter_map(|line| line.split_once(':'))
        .find_map(|(name, value)| {
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);
    Ok(HttpRequest { method, path, body })
}

async fn write_json_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    body: serde_json::Value,
) -> io::Result<()> {
    let body = serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec());
    write_raw_response(stream, status, "application/json", &body).await
}

async fn write_raw_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        502 => "Bad Gateway",
        _ => "OK",
    };
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(headers.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.shutdown().await
}

fn pick_port() -> Result<u16, AppError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| AppError::new("hermes_bridge_port_failed", error.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|error| AppError::new("hermes_bridge_port_failed", error.to_string()))?
        .port();
    drop(listener);
    Ok(port)
}

fn random_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(43)
        .map(char::from)
        .collect()
}

async fn wait_for_hermes(base_url: &str, token: &str) -> Result<(), AppError> {
    let client = reqwest::Client::new();
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut last_error = "timeout".to_string();
    while Instant::now() < deadline {
        match client
            .get(format!("{base_url}/api/status"))
            .bearer_auth(token)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => last_error = format!("HTTP {}", response.status()),
            Err(error) => last_error = error.to_string(),
        }
        tokio::time::sleep(READY_POLL).await;
    }
    Err(AppError::new(
        "hermes_bridge_ready_timeout",
        format!("Hermes backend did not become ready: {last_error}"),
    ))
}
