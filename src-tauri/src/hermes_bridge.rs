use crate::domain::types::AppError;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
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
const HERMES_AGENT_INSTALL_COMMIT: &str = "31c40c72c03cb11d5e596d015d61e7dd118cecee";
const HERMES_SOURCE_TARBALL_URL: &str =
    "https://github.com/NousResearch/hermes-agent/archive/31c40c72c03cb11d5e596d015d61e7dd118cecee.tar.gz";
const HERMES_SOURCE_TARBALL_SHA256: &str =
    "287ead740a444d7e8c8e00a6d6e073d9b3329034f649a07b42e0a3f5b14686e4";
const FILESYSTEM_MAX_DEPTH: usize = 2;
const FILESYSTEM_MAX_ENTRIES_PER_DIR: usize = 80;
const HERMES_IMPORT_MAX_BYTES: u64 = 50 * 1024 * 1024;
const HERMES_IMAGE_PREVIEW_MAX_BYTES: u64 = 5 * 1024 * 1024;
const SCRIBE_PROVIDER_PROXY_MAX_HEADER_BYTES: usize = 32 * 1024;
const SCRIBE_PROVIDER_PROXY_MAX_BODY_BYTES: usize = 512 * 1024;

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

#[derive(Debug, Clone)]
struct HermesCommandResolution {
    command: String,
    source: HermesCommandSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HermesCommandSource {
    EnvOverride,
    BundledRuntime,
    ManagedRuntime,
    UserLocalFallback,
    PathFallback,
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
    pub cwd: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteHermesSessionRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureHermesSessionRequest {
    pub session_id: String,
    pub title: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadHermesFileRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesFilePreviewRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportHermesFileRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHermesFile {
    pub name: String,
    pub path: String,
    pub root_label: String,
    pub size: u64,
    pub preview_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesFilesystemSnapshot {
    pub roots: Vec<HermesFilesystemRoot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesFilesystemRoot {
    pub id: String,
    pub label: String,
    pub path: String,
    pub description: String,
    pub entries: Vec<HermesFilesystemEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesFilesystemEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: Option<u64>,
    pub modified_at: Option<String>,
    pub children: Option<Vec<HermesFilesystemEntry>>,
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
        if !hermes_runtime_available_for_auto_start(&app) {
            return;
        }
        let bridge = app.state::<HermesBridge>();
        let status =
            start_hermes_bridge_inner(&app, &bridge, StartHermesBridgeRequest { cwd: None })
                .await
                .inspect_err(|error| {
                    eprintln!(
                        "failed to start Hermes bridge during app startup: {}",
                        error.message
                    );
                });
        let Ok(status) = status else {
            return;
        };
        if let Some(connection) = status.connection.as_ref() {
            if let Err(error) = start_hermes_gateway_if_needed(connection).await {
                eprintln!(
                    "failed to start Hermes messaging gateway during app startup: {}",
                    error.message
                );
            }
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

    let port = pick_port()?;
    let token = random_token();
    let base_url = format!("http://127.0.0.1:{port}");
    let ws_url = format!(
        "ws://127.0.0.1:{port}/api/ws?token={}",
        urlencoding::encode(&token)
    );
    let hermes_home = resolve_scribe_hermes_home(app)?;
    let command_resolution = resolve_hermes_command(app, &hermes_home).await?;
    let command = command_resolution.command;
    let _command_source = command_resolution.source;
    let default_cwd = hermes_home.join("workspace");
    std::fs::create_dir_all(&default_cwd)
        .map_err(|error| AppError::new("hermes_bridge_workspace_failed", error.to_string()))?;
    let cwd = request
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or(default_cwd);
    let cwd_display = Some(cwd.to_string_lossy().into_owned());
    let provider_proxy_token = random_token();
    let provider_proxy = start_scribe_provider_proxy(provider_proxy_token.clone()).await?;
    sync_hermes_config(&hermes_home, provider_proxy.port, &provider_proxy_token)?;

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
    cmd.current_dir(cwd);

    let child = cmd.spawn().map_err(|error| {
        AppError::new(
            "hermes_bridge_start_failed",
            format!("Could not start the Scribe-managed Hermes runtime. {error}"),
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
        cwd: cwd_display,
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
pub async fn ensure_hermes_bridge_session(
    bridge: State<'_, HermesBridge>,
    request: EnsureHermesSessionRequest,
) -> Result<serde_json::Value, AppError> {
    let session_id = request.session_id.trim();
    if session_id.is_empty() {
        return Err(AppError::new(
            "hermes_session_id_required",
            "Hermes session ID is required.",
        ));
    }
    let mut body = serde_json::json!({ "id": session_id });
    if let Some(title) = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body["title"] = serde_json::Value::String(title.to_string());
    }
    if let Some(model) = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body["model"] = serde_json::Value::String(model.to_string());
    }
    match hermes_api_json(&bridge, reqwest::Method::POST, "/api/sessions", Some(body)).await {
        Ok(value) => Ok(value),
        Err(error)
            if error.code == "hermes_bridge_api_failed"
                && error.message.starts_with("Hermes API returned 409") =>
        {
            Ok(serde_json::json!({
                "object": "hermes.session.ensure",
                "id": session_id,
                "created": false
            }))
        }
        Err(error) => Err(error),
    }
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

#[tauri::command]
pub async fn delete_hermes_bridge_session(
    bridge: State<'_, HermesBridge>,
    request: DeleteHermesSessionRequest,
) -> Result<serde_json::Value, AppError> {
    hermes_api_json(
        &bridge,
        reqwest::Method::DELETE,
        &format!("/api/sessions/{}", urlencoding::encode(&request.session_id)),
        None,
    )
    .await
}

#[tauri::command]
pub async fn hermes_bridge_filesystem_snapshot(
    app: AppHandle,
    bridge: State<'_, HermesBridge>,
) -> Result<HermesFilesystemSnapshot, AppError> {
    let status = hermes_bridge_status(bridge).await?;
    let connection = status.connection;
    let hermes_home = connection
        .as_ref()
        .map(|item| PathBuf::from(&item.hermes_home))
        .unwrap_or(resolve_scribe_hermes_home(&app)?);
    let roots = filesystem_roots(&hermes_home)?
        .into_iter()
        .filter_map(|root| {
            if !root.path.exists() {
                return None;
            }
            let entries = list_filesystem_entries(&root.path, 0).unwrap_or_default();
            Some(HermesFilesystemRoot {
                id: root.id,
                label: root.label,
                path: root.path.to_string_lossy().into_owned(),
                description: root.description,
                entries,
            })
        })
        .collect();

    Ok(HermesFilesystemSnapshot { roots })
}

#[tauri::command]
pub async fn download_hermes_bridge_file(
    app: AppHandle,
    request: DownloadHermesFileRequest,
) -> Result<String, AppError> {
    let requested = validate_hermes_file_path(&app, &request.path)?;
    let downloads_dir = app
        .path()
        .download_dir()
        .map_err(|error| AppError::new("hermes_file_download_failed", error.to_string()))?;
    fs::create_dir_all(&downloads_dir)
        .map_err(|error| AppError::new("hermes_file_download_failed", error.to_string()))?;
    let destination = unique_download_path(&downloads_dir, &requested)?;
    fs::copy(&requested, &destination)
        .map_err(|error| AppError::new("hermes_file_download_failed", error.to_string()))?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn hermes_bridge_file_preview(
    app: AppHandle,
    request: HermesFilePreviewRequest,
) -> Result<Option<String>, AppError> {
    let requested = validate_hermes_file_path(&app, &request.path)?;
    image_preview_data_url(&requested)
}

#[tauri::command]
pub async fn import_hermes_bridge_file(
    app: AppHandle,
    request: ImportHermesFileRequest,
) -> Result<ImportedHermesFile, AppError> {
    let source = validate_dropped_file_path(&request.path)?;
    let metadata = fs::metadata(&source)
        .map_err(|error| AppError::new("hermes_file_import_failed", error.to_string()))?;
    if metadata.len() > HERMES_IMPORT_MAX_BYTES {
        return Err(AppError::new(
            "hermes_file_import_denied",
            "Dropped files must be 50 MB or smaller.",
        ));
    }
    let hermes_home = resolve_scribe_hermes_home(&app)?;
    let upload_dir = hermes_home.join("workspace").join("uploads");
    fs::create_dir_all(&upload_dir)
        .map_err(|error| AppError::new("hermes_file_import_failed", error.to_string()))?;
    let destination = unique_upload_path(&upload_dir, &source)?;
    fs::copy(&source, &destination)
        .map_err(|error| AppError::new("hermes_file_import_failed", error.to_string()))?;
    let size = fs::metadata(&destination)
        .map_err(|error| AppError::new("hermes_file_import_failed", error.to_string()))?
        .len();
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment")
        .to_string();
    Ok(ImportedHermesFile {
        name,
        path: destination.to_string_lossy().into_owned(),
        root_label: "Workspace".to_string(),
        size,
        preview_data_url: image_preview_data_url(&destination)?,
    })
}

fn validate_hermes_file_path(app: &AppHandle, path: &str) -> Result<PathBuf, AppError> {
    let hermes_home = resolve_scribe_hermes_home(&app)?;
    let requested = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| AppError::new("hermes_file_download_failed", error.to_string()))?;
    if !requested.is_file() {
        return Err(AppError::new(
            "hermes_file_download_failed",
            "Only files in the Hermes workspace or memory can be downloaded.",
        ));
    }
    if is_hidden_secret_path(&requested) {
        return Err(AppError::new(
            "hermes_file_download_denied",
            "This Hermes file is hidden or sensitive.",
        ));
    }
    let allowed = filesystem_roots(&hermes_home)?
        .into_iter()
        .filter_map(|root| root.path.canonicalize().ok())
        .any(|root| requested.starts_with(root));
    if !allowed {
        return Err(AppError::new(
            "hermes_file_download_denied",
            "Only files in this app's Hermes workspace or memory can be downloaded.",
        ));
    }
    Ok(requested)
}

fn validate_dropped_file_path(path: &str) -> Result<PathBuf, AppError> {
    let requested = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| AppError::new("hermes_file_import_failed", error.to_string()))?;
    if !requested.is_file() {
        return Err(AppError::new(
            "hermes_file_import_failed",
            "Only files can be attached to an agent message.",
        ));
    }
    if is_hidden_secret_path(&requested) {
        return Err(AppError::new(
            "hermes_file_import_denied",
            "Hidden or sensitive files cannot be attached.",
        ));
    }
    Ok(requested)
}

fn unique_download_path(downloads_dir: &Path, source: &Path) -> Result<PathBuf, AppError> {
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            AppError::new(
                "hermes_file_download_failed",
                "The Hermes file does not have a downloadable filename.",
            )
        })?;
    let candidate = downloads_dir.join(file_name);
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
        let candidate = downloads_dir.join(file_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(AppError::new(
        "hermes_file_download_failed",
        "Could not find an available Downloads filename.",
    ))
}

fn unique_upload_path(upload_dir: &Path, source: &Path) -> Result<PathBuf, AppError> {
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            AppError::new(
                "hermes_file_import_failed",
                "The dropped file does not have a usable filename.",
            )
        })?;
    let candidate = upload_dir.join(file_name);
    if !candidate.exists() {
        return Ok(candidate);
    }

    let stem = source
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("attachment");
    let extension = source.extension().and_then(|name| name.to_str());
    for index in 1..1000 {
        let file_name = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
            _ => format!("{stem} ({index})"),
        };
        let candidate = upload_dir.join(file_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(AppError::new(
        "hermes_file_import_failed",
        "Could not find an available attachment filename.",
    ))
}

fn image_preview_data_url(path: &Path) -> Result<Option<String>, AppError> {
    let Some(mime_type) = image_mime_type(path) else {
        return Ok(None);
    };
    let metadata = fs::metadata(path)
        .map_err(|error| AppError::new("hermes_file_preview_failed", error.to_string()))?;
    if metadata.len() > HERMES_IMAGE_PREVIEW_MAX_BYTES {
        return Ok(None);
    }
    let bytes = fs::read(path)
        .map_err(|error| AppError::new("hermes_file_preview_failed", error.to_string()))?;
    Ok(Some(format!(
        "data:{mime_type};base64,{}",
        BASE64_STANDARD.encode(bytes)
    )))
}

fn image_mime_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
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
    hermes_connection_json(&connection, method, path, body).await
}

async fn start_hermes_gateway_if_needed(
    connection: &HermesBridgeConnection,
) -> Result<(), AppError> {
    let status = hermes_connection_json(connection, reqwest::Method::GET, "/api/status", None)
        .await
        .unwrap_or_else(|_| serde_json::json!({}));
    if status
        .get("gateway_running")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(());
    }
    hermes_connection_json(
        connection,
        reqwest::Method::POST,
        "/api/gateway/start",
        None,
    )
    .await?;
    Ok(())
}

async fn hermes_connection_json(
    connection: &HermesBridgeConnection,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, AppError> {
    let url = format!("{}{}", connection.base_url, path);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| AppError::new("hermes_bridge_api_failed", error.to_string()))?;
    let mut request = client
        .request(method, &url)
        .header("X-Hermes-Session-Token", connection.token.as_str())
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

async fn resolve_hermes_command(
    app: &AppHandle,
    hermes_home: &Path,
) -> Result<HermesCommandResolution, AppError> {
    if let Ok(command) = std::env::var(SCRIBE_HERMES_COMMAND_ENV) {
        let command = command.trim();
        if !command.is_empty() {
            return Ok(HermesCommandResolution {
                command: command.to_string(),
                source: HermesCommandSource::EnvOverride,
            });
        }
    }

    if let Some(command) = bundled_hermes_command(app) {
        return Ok(HermesCommandResolution {
            command: command.to_string_lossy().into_owned(),
            source: HermesCommandSource::BundledRuntime,
        });
    }

    let managed_command = managed_hermes_command(app)?;
    if managed_command.exists() && managed_hermes_runtime_current(app)? {
        return Ok(HermesCommandResolution {
            command: managed_command.to_string_lossy().into_owned(),
            source: HermesCommandSource::ManagedRuntime,
        });
    }

    if let Err(error) = install_managed_hermes_runtime(app, hermes_home).await {
        if let Some(command) = user_local_hermes_command() {
            eprintln!(
                "failed to install Scribe-managed Hermes runtime; using existing user-local Hermes fallback: {}",
                error.message
            );
            return Ok(HermesCommandResolution {
                command: command.to_string_lossy().into_owned(),
                source: HermesCommandSource::UserLocalFallback,
            });
        }
        return Err(error);
    }

    if managed_command.exists() {
        return Ok(HermesCommandResolution {
            command: managed_command.to_string_lossy().into_owned(),
            source: HermesCommandSource::ManagedRuntime,
        });
    }

    if let Some(command) = user_local_hermes_command() {
        return Ok(HermesCommandResolution {
            command: command.to_string_lossy().into_owned(),
            source: HermesCommandSource::UserLocalFallback,
        });
    }

    Ok(HermesCommandResolution {
        command: "hermes".to_string(),
        source: HermesCommandSource::PathFallback,
    })
}

fn bundled_hermes_command(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let candidates = [
        resource_dir.join("native/hermes/hermes-agent/venv/bin/hermes"),
        resource_dir.join("native/hermes/bin/hermes"),
    ];
    candidates.into_iter().find(|path| path.exists())
}

fn managed_hermes_runtime_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::new("hermes_runtime_home_failed", error.to_string()))?
        .join("hermes-runtime"))
}

fn managed_hermes_command(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(managed_hermes_runtime_dir(app)?
        .join("hermes-agent")
        .join("venv/bin/hermes"))
}

fn managed_hermes_runtime_current(app: &AppHandle) -> Result<bool, AppError> {
    let metadata_path = managed_hermes_runtime_dir(app)?.join("runtime.json");
    let Ok(metadata) = fs::read_to_string(metadata_path) else {
        return Ok(false);
    };
    Ok(metadata.contains(&format!(r#""commit":"{HERMES_AGENT_INSTALL_COMMIT}""#)))
}

fn user_local_hermes_command() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    [
        PathBuf::from(&home).join(".hermes/hermes-agent/venv/bin/hermes"),
        PathBuf::from(&home).join(".local/bin/hermes"),
    ]
    .into_iter()
    .find(|path| path.exists())
}

fn hermes_runtime_available_for_auto_start(app: &AppHandle) -> bool {
    if bundled_hermes_command(app).is_some() {
        return true;
    }
    let Ok(command) = managed_hermes_command(app) else {
        return false;
    };
    command.exists() && managed_hermes_runtime_current(app).unwrap_or(false)
}

async fn install_managed_hermes_runtime(
    app: &AppHandle,
    hermes_home: &Path,
) -> Result<(), AppError> {
    let runtime_dir = managed_hermes_runtime_dir(app)?;
    let install_dir = runtime_dir.join("hermes-agent");
    fs::create_dir_all(&runtime_dir)
        .map_err(|error| AppError::new("hermes_runtime_install_failed", error.to_string()))?;
    if install_dir.exists() && !managed_hermes_runtime_current(app)? {
        fs::remove_dir_all(&install_dir)
            .map_err(|error| AppError::new("hermes_runtime_install_failed", error.to_string()))?;
    }
    let install_log = runtime_dir.join("install.log");

    let log_file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&install_log)
        .map_err(|error| AppError::new("hermes_runtime_install_failed", error.to_string()))?;
    let log_file_for_stderr = log_file
        .try_clone()
        .map_err(|error| AppError::new("hermes_runtime_install_failed", error.to_string()))?;

    let status = Command::new("/bin/bash")
        .arg("-c")
        .arg(MANAGED_HERMES_INSTALL_SCRIPT)
        .env("SCRIBE_HERMES_RUNTIME_DIR", &runtime_dir)
        .env("SCRIBE_HERMES_INSTALL_DIR", &install_dir)
        .env("SCRIBE_HERMES_HOME", hermes_home)
        .env("SCRIBE_HERMES_INSTALL_COMMIT", HERMES_AGENT_INSTALL_COMMIT)
        .env(
            "SCRIBE_HERMES_SOURCE_TARBALL_URL",
            HERMES_SOURCE_TARBALL_URL,
        )
        .env(
            "SCRIBE_HERMES_SOURCE_TARBALL_SHA256",
            HERMES_SOURCE_TARBALL_SHA256,
        )
        .env("HERMES_HOME", hermes_home)
        .env("HERMES_INSTALL_DIR", &install_dir)
        .env("UV_NO_CONFIG", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_for_stderr))
        .status()
        .map_err(|error| {
            AppError::new(
                "hermes_runtime_install_failed",
                format!(
                    "Could not run the Hermes runtime installer. Install log: {}. {error}",
                    install_log.display()
                ),
            )
        })?;

    if !status.success() {
        return Err(AppError::new(
            "hermes_runtime_install_failed",
            format!(
                "Could not set up the Scribe-managed Hermes runtime. Install log: {}.",
                install_log.display()
            ),
        ));
    }

    if !install_dir.join("venv/bin/hermes").exists() {
        return Err(AppError::new(
            "hermes_runtime_install_failed",
            format!(
                "Hermes setup completed but the runtime command was not created. Install log: {}.",
                install_log.display()
            ),
        ));
    }

    Ok(())
}

const MANAGED_HERMES_INSTALL_SCRIPT: &str = r#"
set -euo pipefail

runtime_dir="${SCRIBE_HERMES_RUNTIME_DIR:?}"
install_dir="${SCRIBE_HERMES_INSTALL_DIR:?}"
hermes_home="${SCRIBE_HERMES_HOME:?}"
install_commit="${SCRIBE_HERMES_INSTALL_COMMIT:?}"
source_tarball_url="${SCRIBE_HERMES_SOURCE_TARBALL_URL:?}"
source_tarball_sha256="${SCRIBE_HERMES_SOURCE_TARBALL_SHA256:?}"

mkdir -p "$runtime_dir" "$hermes_home"

if [ ! -f "$install_dir/pyproject.toml" ] || [ ! -f "$install_dir/scripts/install.sh" ]; then
  tmp_dir="$(mktemp -d "$runtime_dir/download.XXXXXX")"
  cleanup() { rm -rf "$tmp_dir"; }
  trap cleanup EXIT
  curl -LsSf "$source_tarball_url" -o "$tmp_dir/hermes-agent.tar.gz"
  actual_sha256="$(shasum -a 256 "$tmp_dir/hermes-agent.tar.gz" | awk '{print $1}')"
  if [ "$actual_sha256" != "$source_tarball_sha256" ]; then
    echo "Hermes source archive checksum mismatch." >&2
    echo "expected: $source_tarball_sha256" >&2
    echo "actual:   $actual_sha256" >&2
    exit 1
  fi
  tar -xzf "$tmp_dir/hermes-agent.tar.gz" -C "$tmp_dir"
  unpacked_dir="$(find "$tmp_dir" -maxdepth 1 -type d -name 'hermes-agent-*' | head -n 1)"
  if [ -z "$unpacked_dir" ]; then
    echo "Hermes source archive did not contain a hermes-agent directory." >&2
    exit 1
  fi
  rm -rf "$install_dir"
  mkdir -p "$(dirname "$install_dir")"
  mv "$unpacked_dir" "$install_dir"
fi

run_stage() {
  local stage="$1"
  HERMES_HOME="$hermes_home" HERMES_INSTALL_DIR="$install_dir" \
    bash "$install_dir/scripts/install.sh" \
      --dir "$install_dir" \
      --hermes-home "$hermes_home" \
      --stage "$stage" \
      --json \
      --non-interactive
}

run_stage venv
run_stage python-deps
run_stage node-deps
run_stage config
run_stage complete

cat > "$runtime_dir/runtime.json" <<EOF
{"source":"NousResearch/hermes-agent","commit":"$install_commit","installDir":"$install_dir"}
EOF
"#;

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
    provider_proxy_token: &str,
) -> Result<(), AppError> {
    let model = crate::providers::generation_model();
    let base_url = format!("http://127.0.0.1:{provider_proxy_port}/v1");
    let config = format!(
        r#"model:
  default: {model}
  provider: custom
  base_url: {base_url}
  api_key: {provider_proxy_token}
  api_mode: chat_completions
agent:
  max_turns: 90
display:
  skin: mono
"#,
        model = yaml_string(&model),
        base_url = yaml_string(&base_url),
        provider_proxy_token = yaml_string(provider_proxy_token),
    );
    std::fs::write(hermes_home.join("config.yaml"), config)
        .map_err(|error| AppError::new("hermes_bridge_config_failed", error.to_string()))
}

struct FilesystemRootCandidate {
    id: String,
    label: String,
    path: PathBuf,
    description: String,
}

fn filesystem_roots(hermes_home: &Path) -> Result<Vec<FilesystemRootCandidate>, AppError> {
    let mut roots = Vec::new();
    for (id, label, relative, description) in [
        (
            "workspace",
            "Workspace",
            "workspace",
            "Hermes scratch files and generated outputs.",
        ),
        (
            "memory",
            "Memory",
            "memories",
            "Persistent Hermes memory files and stores.",
        ),
    ] {
        roots.push(FilesystemRootCandidate {
            id: id.to_string(),
            label: label.to_string(),
            path: hermes_home.join(relative),
            description: description.to_string(),
        });
    }
    Ok(dedupe_filesystem_roots(roots))
}

fn dedupe_filesystem_roots(roots: Vec<FilesystemRootCandidate>) -> Vec<FilesystemRootCandidate> {
    let mut seen = std::collections::HashSet::new();
    roots
        .into_iter()
        .filter(|root| {
            let key = root.path.to_string_lossy().into_owned();
            seen.insert(key)
        })
        .collect()
}

fn list_filesystem_entries(
    path: &Path,
    depth: usize,
) -> Result<Vec<HermesFilesystemEntry>, AppError> {
    if is_hidden_secret_path(path) {
        return Ok(Vec::new());
    }
    if path.is_file() {
        return filesystem_entry(path.to_path_buf(), depth).map(|entry| vec![entry]);
    }
    let mut entries = fs::read_dir(path)
        .map_err(|error| AppError::new("hermes_filesystem_read_failed", error.to_string()))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| !is_hidden_secret_path(&entry.path()))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        let left_path = left.path();
        let right_path = right.path();
        right_path.is_dir().cmp(&left_path.is_dir()).then_with(|| {
            left.file_name()
                .to_string_lossy()
                .to_lowercase()
                .cmp(&right.file_name().to_string_lossy().to_lowercase())
        })
    });
    entries.truncate(FILESYSTEM_MAX_ENTRIES_PER_DIR);
    Ok(entries
        .into_iter()
        .filter_map(|entry| filesystem_entry(entry.path(), depth).ok())
        .collect())
}

fn filesystem_entry(path: PathBuf, depth: usize) -> Result<HermesFilesystemEntry, AppError> {
    let metadata = fs::metadata(&path)
        .map_err(|error| AppError::new("hermes_filesystem_read_failed", error.to_string()))?;
    let is_dir = metadata.is_dir();
    let children = if is_dir && depth < FILESYSTEM_MAX_DEPTH {
        Some(list_filesystem_entries(&path, depth + 1)?)
    } else {
        None
    };
    Ok(HermesFilesystemEntry {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
        path: path.to_string_lossy().into_owned(),
        kind: if is_dir { "directory" } else { "file" }.to_string(),
        size: if is_dir { None } else { Some(metadata.len()) },
        modified_at: metadata.modified().ok().map(system_time_to_iso),
        children,
    })
}

fn is_hidden_secret_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    matches!(
        name,
        ".env" | "auth.lock" | ".credentials" | "credentials" | "secrets" | "secrets.json"
    ) || name.ends_with(".lock")
        || name.ends_with(".key")
        || name.ends_with(".pem")
}

fn system_time_to_iso(value: std::time::SystemTime) -> String {
    let datetime: chrono::DateTime<chrono::Utc> = value.into();
    datetime.to_rfc3339()
}

fn yaml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

async fn start_scribe_provider_proxy(
    token: String,
) -> Result<RunningScribeProviderProxy, AppError> {
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
    tauri::async_runtime::spawn(run_scribe_provider_proxy(
        listener,
        Arc::new(token),
        shutdown_rx,
    ));
    Ok(RunningScribeProviderProxy { port, shutdown })
}

struct RunningScribeProviderProxy {
    port: u16,
    shutdown: oneshot::Sender<()>,
}

async fn run_scribe_provider_proxy(
    listener: tokio::net::TcpListener,
    token: Arc<String>,
    mut shutdown: oneshot::Receiver<()>,
) {
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        let token = token.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = handle_scribe_provider_connection(stream, token).await;
                        });
                    }
                    Err(_) => break,
                }
            }
        }
    }
}

async fn handle_scribe_provider_connection(
    mut stream: tokio::net::TcpStream,
    token: Arc<String>,
) -> io::Result<()> {
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
    if !provider_proxy_authorized(&request, &token) {
        write_json_response(
            &mut stream,
            401,
            serde_json::json!({ "error": { "message": "Unauthorized" } }),
        )
        .await?;
        return Ok(());
    }
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
    headers: Vec<(String, String)>,
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
        if buffer.len() > SCRIBE_PROVIDER_PROXY_MAX_HEADER_BYTES {
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
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
        .collect::<Vec<_>>();
    let content_length = headers
        .iter()
        .find_map(|(name, value)| {
            if name.eq_ignore_ascii_case("content-length") {
                value.parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    if content_length > SCRIBE_PROVIDER_PROXY_MAX_BODY_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "HTTP body is too large",
        ));
    }
    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);
    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn provider_proxy_authorized(request: &HttpRequest, token: &str) -> bool {
    request
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        .and_then(|(_, value)| bearer_token(value))
        .is_some_and(|candidate| constant_time_eq(candidate, token))
}

fn bearer_token(value: &str) -> Option<&str> {
    let mut parts = value.split_whitespace();
    let scheme = parts.next()?;
    let token = parts.next()?;
    if parts.next().is_some() || !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    Some(token)
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut diff = left.len() ^ right.len();
    for (left, right) in left.iter().zip(right.iter()) {
        diff |= usize::from(*left ^ *right);
    }
    diff == 0
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

#[cfg(test)]
mod tests {
    use super::*;

    fn request_with_authorization(value: &str) -> HttpRequest {
        HttpRequest {
            method: "GET".to_string(),
            path: "/v1/models".to_string(),
            headers: vec![("Authorization".to_string(), value.to_string())],
            body: Vec::new(),
        }
    }

    #[test]
    fn provider_proxy_requires_matching_bearer_token() {
        let request = request_with_authorization("Bearer proxy-secret");

        assert!(provider_proxy_authorized(&request, "proxy-secret"));
        assert!(!provider_proxy_authorized(&request, "other-secret"));
    }

    #[test]
    fn provider_proxy_rejects_missing_or_malformed_authorization() {
        let missing = HttpRequest {
            method: "GET".to_string(),
            path: "/v1/models".to_string(),
            headers: Vec::new(),
            body: Vec::new(),
        };
        let basic = request_with_authorization("Basic proxy-secret");
        let extra = request_with_authorization("Bearer proxy-secret extra");

        assert!(!provider_proxy_authorized(&missing, "proxy-secret"));
        assert!(!provider_proxy_authorized(&basic, "proxy-secret"));
        assert!(!provider_proxy_authorized(&extra, "proxy-secret"));
    }
}
