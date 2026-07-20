//! Notion hosted MCP connector preview.
//!
//! This module owns Notion's hosted MCP OAuth flow, the `june_notion` MCP
//! server and read toolset, and the `june_notion_actions` MCP server with the
//! approved page-create and page-update toolset. All other actions are denied;
//! selected-resource scoping is not verified in this preview. See ADR 0033.

use crate::{
    connectors::{ConnectorAccountStatus, ConnectorProvider},
    domain::types::AppError,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Mutex as AsyncMutex,
};
use zeroize::{Zeroize, ZeroizeOnDrop};

const MCP_ENDPOINT: &str = "https://mcp.notion.com/mcp";
const RESOURCE_METADATA_ENDPOINT: &str =
    "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp";
const AUTHORIZATION_SERVER_METADATA_ENDPOINT: &str =
    "https://mcp.notion.com/.well-known/oauth-authorization-server";
const EXPECTED_RESOURCE: &str = MCP_ENDPOINT;
const EXPECTED_AUTHORIZATION_SERVER: &str = "https://mcp.notion.com";
const EXPECTED_ISSUER: &str = "https://mcp.notion.com";
const EXPECTED_AUTHORIZATION_ENDPOINT: &str = "https://mcp.notion.com/authorize";
const EXPECTED_TOKEN_ENDPOINT: &str = "https://mcp.notion.com/token";
const EXPECTED_REGISTRATION_ENDPOINT: &str = "https://mcp.notion.com/register";
const NOTION_ACCOUNT_ID: &str = "notion-hosted-mcp";
const NOTION_ACCOUNT_EMAIL: &str = "Notion";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(300);
const SOCKET_READ_TIMEOUT: Duration = Duration::from_secs(5);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MCP_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
const MCP_ACTION_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const TOKEN_EXPIRY_BUFFER_SECS: i64 = 60;
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const MCP_RESPONSE_MAX_BYTES: usize = 512 * 1024;
const MCP_TOOL_SCHEMA_MAX_BYTES: usize = 64 * 1024;
const MCP_DESCRIPTION_MAX_CHARS: usize = 240;
const MCP_TOOL_NAME_MAX_CHARS: usize = 128;
const MCP_SESSION_ID_HEADER: &str = "mcp-session-id";
const NOTION_READ_TOOL_ALLOWLIST: &[&str] = &[
    "notion-search",
    "notion-fetch",
    "notion-query-data-sources",
    "notion-query-database-view",
    "notion-get-comments",
    "notion-get-enhanced-markdown-specification",
    "notion-get-view-configuration-dsl",
];
const NOTION_ACTION_TOOL_ALLOWLIST: &[&str] = &["notion-create-pages", "notion-update-page"];
const NOTION_DESTRUCTIVE_UPDATE_FIELDS: &[&str] = &["erase_content", "in_trash", "is_archived"];
const NOTION_UPDATE_PAGE_ALLOWED_FIELDS: &[&str] = &[
    "page_id",
    "allow_async",
    "command",
    "selection_with_ellipsis",
    "new_str",
    "properties",
    "content",
    "content_updates",
    "position",
    "allow_deleting_content",
    "children",
    "body",
    "markdown",
    "title",
    "name",
];
const NOTION_ACTIONS_SERVER_NAME: &str = "june_notion_actions";

static HTTP_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
static CREDENTIAL_LIFECYCLE_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();

fn credential_lifecycle_lock() -> &'static AsyncMutex<()> {
    CREDENTIAL_LIFECYCLE_LOCK.get_or_init(|| AsyncMutex::new(()))
}

fn http_client() -> Result<&'static reqwest::Client, AppError> {
    HTTP_CLIENT
        .get_or_init(|| {
            // Notion hosted MCP traffic carries user-granted connector tokens.
            // Keep it direct-to-provider for this preview instead of honoring
            // ambient process proxy variables that could redirect credentials.
            // This means proxy-required networks are intentionally unsupported
            // until June has an explicit trusted-proxy connector setting.
            reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(HTTP_CONNECT_TIMEOUT)
                .pool_idle_timeout(Duration::from_secs(90))
                .tcp_keepalive(Some(Duration::from_secs(30)))
                .user_agent("os-june/0.1 notion-hosted-mcp-preview")
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|error| {
            AppError::new(
                "notion_http_client_failed",
                format!("Could not initialize the Notion HTTP client: {error}"),
            )
        })
}

#[derive(Default)]
pub struct NotionConnectFlow {
    cancel: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl NotionConnectFlow {
    pub fn cancel(&self) {
        if let Ok(mut slot) = self.cancel.lock() {
            if let Some(sender) = slot.take() {
                let _ = sender.send(());
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionConnectionStatus {
    pub connected: bool,
    pub account_id: String,
    pub endpoint: String,
    pub preview: bool,
    pub selected_resource_scoping_verified: bool,
    pub access_token_present: bool,
    pub refresh_token_present: bool,
    pub client_id_present: bool,
    pub keychain_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionConnection {
    pub account_id: String,
    pub endpoint: String,
    pub preview: bool,
    pub selected_resource_scoping_verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionToolInventory {
    pub endpoint: String,
    pub protocol_version: String,
    pub tool_count: usize,
    pub tools: Vec<NotionToolSummary>,
    pub session_established: bool,
    pub inventory_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionToolSummary {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub write_class: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionMcpTool {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub input_schema: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionMcpToolList {
    pub tools: Vec<NotionMcpTool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionHostedToolCallRequest {
    pub tool_name: String,
    #[serde(default)]
    pub arguments: serde_json::Value,
    #[serde(default)]
    pub deadline_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionHostedToolCallResult {
    pub tool_name: String,
    pub result: serde_json::Value,
}

#[derive(Deserialize)]
struct ResourceMetadata {
    resource: String,
    #[serde(default)]
    authorization_servers: Vec<String>,
    #[serde(default)]
    bearer_methods_supported: Vec<String>,
}

#[derive(Deserialize)]
struct AuthorizationServerMetadata {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    registration_endpoint: Option<String>,
    #[serde(default)]
    response_types_supported: Vec<String>,
    #[serde(default)]
    grant_types_supported: Vec<String>,
    #[serde(default)]
    token_endpoint_auth_methods_supported: Vec<String>,
    #[serde(default)]
    code_challenge_methods_supported: Vec<String>,
}

#[derive(Serialize)]
struct RegistrationRequest<'a> {
    client_name: &'a str,
    redirect_uris: Vec<&'a str>,
    grant_types: Vec<&'a str>,
    response_types: Vec<&'a str>,
    token_endpoint_auth_method: &'a str,
}

#[derive(Clone, Deserialize, Zeroize, ZeroizeOnDrop)]
struct RegistrationResponse {
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
}

struct PreparedRegistration {
    listener: TcpListener,
    redirect_uri: String,
    registration: RegistrationResponse,
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct StoredNotionConnection {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[zeroize(skip)]
    expires_at_unix: Option<i64>,
    #[zeroize(skip)]
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
    #[zeroize(skip)]
    endpoint: String,
    #[serde(default)]
    #[zeroize(skip)]
    registration_redirect_uri: Option<String>,
}

#[derive(Deserialize)]
struct TokenErrorBody {
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RefreshFailureKind {
    ReconnectRequired,
    ReconnectRequiredWithFreshRegistration,
    Retryable,
}

pub async fn status(app: &AppHandle) -> Result<NotionConnectionStatus, AppError> {
    let stored = store::load().await?;
    let health = notion_health(app).await?;
    let connected = stored.is_some() && health == ConnectorAccountStatus::Connected;
    Ok(NotionConnectionStatus {
        connected,
        account_id: NOTION_ACCOUNT_ID.to_string(),
        endpoint: MCP_ENDPOINT.to_string(),
        preview: true,
        selected_resource_scoping_verified: false,
        access_token_present: stored
            .as_ref()
            .is_some_and(|entry| !entry.access_token.is_empty()),
        refresh_token_present: stored
            .as_ref()
            .and_then(|entry| entry.refresh_token.as_deref())
            .is_some_and(|token| !token.is_empty()),
        client_id_present: stored
            .as_ref()
            .is_some_and(|entry| !entry.client_id.is_empty()),
        keychain_only: true,
    })
}

pub async fn has_connection(app: &AppHandle) -> Result<bool, AppError> {
    Ok(status(app).await?.connected)
}

pub async fn account_status(app: &AppHandle) -> Result<Option<ConnectorAccountStatus>, AppError> {
    if store::load().await?.is_none() {
        return Ok(None);
    }
    notion_health(app).await.map(Some)
}

async fn notion_health(app: &AppHandle) -> Result<ConnectorAccountStatus, AppError> {
    let repos = crate::commands::repositories(app).await?;
    let record = repos.get_connector_account(NOTION_ACCOUNT_ID).await?;
    Ok(record
        .filter(|record| record.provider == ConnectorProvider::Notion.as_str())
        .map(|record| ConnectorAccountStatus::from_db(&record.status))
        // Existing preview credentials predate the non-secret account index.
        // Treat them as connected until their next connect or refresh records
        // an explicit health transition.
        .unwrap_or(ConnectorAccountStatus::Connected))
}

async fn record_connected(app: &AppHandle) -> Result<(), AppError> {
    let repos = crate::commands::repositories(app).await?;
    repos
        .upsert_connector_account(
            NOTION_ACCOUNT_ID,
            ConnectorProvider::Notion.as_str(),
            NOTION_ACCOUNT_EMAIL,
            &[],
            ConnectorAccountStatus::Connected.as_str(),
            "{}",
        )
        .await?;
    Ok(())
}

async fn record_reconnect_required(app: &AppHandle) {
    match crate::commands::repositories(app).await {
        Ok(repos) => {
            if let Err(error) = repos
                .upsert_connector_account(
                    NOTION_ACCOUNT_ID,
                    ConnectorProvider::Notion.as_str(),
                    NOTION_ACCOUNT_EMAIL,
                    &[],
                    ConnectorAccountStatus::ReconnectRequired.as_str(),
                    "{}",
                )
                .await
            {
                tracing::warn!(error_code = %AppError::from(error).code, "failed to flag Notion connector for reconnect");
            } else {
                crate::connectors::emit_connectors_changed(app);
            }
        }
        Err(error) => {
            tracing::warn!(error_code = %error.code, "failed to open repositories to flag Notion reconnect")
        }
    }
}

pub async fn connect(
    app: &AppHandle,
    flow: &NotionConnectFlow,
) -> Result<NotionConnection, AppError> {
    let (resource, auth_server) = discover_and_validate().await?;
    let (verifier, challenge) = pkce();
    let csrf = random_b64url(24);

    let prepared = prepare_registration(&auth_server).await?;
    let PreparedRegistration {
        listener,
        redirect_uri,
        registration,
    } = prepared;
    let auth_url = build_auth_url(
        &auth_server,
        &registration.client_id,
        &redirect_uri,
        &challenge,
        &csrf,
        &resource.resource,
    );

    crate::os_accounts::open_in_browser(&auth_url)?;

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    if let Ok(mut slot) = flow.cancel.lock() {
        *slot = Some(cancel_tx);
    }
    let outcome = tokio::select! {
        result = tokio::time::timeout(CONNECT_TIMEOUT, await_callback(&listener, &csrf)) => {
            result.unwrap_or_else(|_| {
                Err(AppError::new(
                    "notion_connect_timed_out",
                    "Connecting to Notion timed out. Please try again.",
                ))
            })
        }
        _ = cancel_rx => Err(AppError::new(
            "notion_connect_canceled",
            "Connecting to Notion was canceled.",
        )),
    };
    if let Ok(mut slot) = flow.cancel.lock() {
        *slot = None;
    }
    let code = outcome?;

    let tokens = exchange_code(
        &auth_server,
        &registration.client_id,
        registration.client_secret.as_deref(),
        &code,
        &verifier,
        &redirect_uri,
        &resource.resource,
    )
    .await?;
    let stored = StoredNotionConnection {
        access_token: tokens.access_token.clone(),
        refresh_token: tokens.refresh_token.clone(),
        expires_at_unix: tokens.expires_in.map(|expires| now_unix() + expires.max(0)),
        client_id: registration.client_id.clone(),
        client_secret: registration.client_secret.clone(),
        endpoint: MCP_ENDPOINT.to_string(),
        registration_redirect_uri: Some(redirect_uri),
    };
    verify_hosted_mcp_discovery(&stored.access_token).await?;
    {
        let _guard = credential_lifecycle_lock().lock().await;
        store::store(&stored).await?;
        record_connected(app).await?;
    }
    Ok(connection())
}

pub async fn disconnect(app: &AppHandle) -> Result<(), AppError> {
    let _guard = credential_lifecycle_lock().lock().await;
    store::delete().await?;
    let repos = crate::commands::repositories(app).await?;
    repos.delete_connector_account(NOTION_ACCOUNT_ID).await?;
    Ok(())
}

async fn verify_hosted_mcp_discovery(access_token: &str) -> Result<(), AppError> {
    let client = McpHttpClient::new(access_token.to_string());
    client.initialize().await?;
    let tools = client.hosted_tools_list().await?;
    if tools.is_empty() {
        return Err(AppError::new(
            "notion_mcp_tools_list_failed",
            "Notion hosted MCP returned no tools.",
        ));
    }
    Ok(())
}

pub async fn list_tools(app: &AppHandle) -> Result<NotionToolInventory, AppError> {
    let (tools, bytes, session_established) = run_with_fresh_client(app, |client| async move {
        client.initialize().await?;
        let (tools, bytes) = client.tools_list().await?;
        Ok((tools, bytes, client.session_id().is_some()))
    })
    .await?;
    Ok(NotionToolInventory {
        endpoint: MCP_ENDPOINT.to_string(),
        protocol_version: MCP_PROTOCOL_VERSION.to_string(),
        tool_count: tools.len(),
        tools,
        session_established,
        inventory_bytes: bytes,
    })
}

pub async fn mcp_tool_list(app: &AppHandle) -> Result<NotionMcpToolList, AppError> {
    filtered_mcp_tool_list(app, tool_allowed_for_hermes).await
}

pub async fn mcp_action_tool_list(app: &AppHandle) -> Result<NotionMcpToolList, AppError> {
    filtered_mcp_tool_list(app, action_tool_allowed_for_hermes).await
}

async fn filtered_mcp_tool_list(
    app: &AppHandle,
    allowed: fn(&str) -> Option<&'static str>,
) -> Result<NotionMcpToolList, AppError> {
    let tools = run_with_fresh_client(app, |client| async move {
        client.initialize().await?;
        client.hosted_tools_list().await
    })
    .await?;
    Ok(NotionMcpToolList {
        tools: filter_allowed_tools(tools, allowed),
    })
}

pub async fn call_hosted_tool(
    app: &AppHandle,
    request: NotionHostedToolCallRequest,
) -> Result<NotionHostedToolCallResult, AppError> {
    let Some(tool_name) = tool_allowed_for_hermes(&request.tool_name) else {
        return Err(AppError::new(
            "notion_tool_not_allowed",
            "That Notion hosted MCP tool is not enabled in June yet.",
        ));
    };
    preflight_read_tool_arguments(tool_name, &request.arguments)?;
    call_hosted_tool_unchecked(app, tool_name, request.arguments).await
}

pub async fn call_hosted_action_tool(
    app: &AppHandle,
    request: NotionHostedToolCallRequest,
) -> Result<NotionHostedToolCallResult, AppError> {
    let Some(tool_name) = action_tool_allowed_for_hermes(&request.tool_name) else {
        return Err(AppError::new(
            "notion_tool_not_allowed",
            "That Notion hosted MCP action is not enabled in June yet.",
        ));
    };
    preflight_action_arguments(tool_name, &request.arguments)?;
    let summary = summarize_action(tool_name, &request.arguments);
    let args_preview = preview_action(tool_name, &request.arguments);
    let approval = crate::connectors::approvals::ActionRequest {
        grant_token: None,
        account_id: notion_account_email(),
        server: NOTION_ACTIONS_SERVER_NAME,
        tool: tool_name,
        summary,
        args_preview,
    };
    if let crate::connectors::approvals::ActionDecision::Deny(reason) =
        crate::connectors::approvals::gate_action(app, approval).await
    {
        return Err(AppError::new("connector_action_denied", reason));
    }
    let timeout = action_request_timeout(request.deadline_unix_ms)?;
    tokio::time::timeout(timeout, call_hosted_tool_unchecked(app, tool_name, request.arguments))
        .await
        .map_err(|_| {
            AppError::new(
                "notion_mcp_action_timeout",
                "Notion did not finish the approved action before June's safety timeout. Check Notion before retrying.",
            )
        })?
}

fn action_request_timeout(deadline_unix_ms: Option<i64>) -> Result<Duration, AppError> {
    let Some(deadline_unix_ms) = deadline_unix_ms else {
        return Ok(MCP_ACTION_REQUEST_TIMEOUT);
    };
    const DEADLINE_SAFETY_BUFFER_MS: i64 = 5_000;
    let now_ms = now_unix_ms();
    let remaining_ms = deadline_unix_ms - now_ms - DEADLINE_SAFETY_BUFFER_MS;
    if remaining_ms <= 0 {
        return Err(AppError::new(
            "notion_mcp_action_deadline_expired",
            "Notion approval completed too late to run safely. Please try again.",
        ));
    }
    let remaining = Duration::from_millis(remaining_ms as u64);
    Ok(remaining.min(MCP_ACTION_REQUEST_TIMEOUT))
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

async fn call_hosted_tool_unchecked(
    app: &AppHandle,
    tool_name: &str,
    arguments: serde_json::Value,
) -> Result<NotionHostedToolCallResult, AppError> {
    let result = run_with_fresh_client(app, |client| {
        let arguments = arguments.clone();
        async move {
            client.initialize().await?;
            client.call_tool(tool_name, arguments).await
        }
    })
    .await?;
    Ok(NotionHostedToolCallResult {
        tool_name: tool_name.to_string(),
        result,
    })
}

async fn load_connected() -> Result<StoredNotionConnection, AppError> {
    store::load().await?.ok_or_else(|| {
        AppError::new(
            "notion_not_connected",
            "Connect Notion before using Notion tools.",
        )
    })
}

async fn load_connected_with_fresh_token(
    app: &AppHandle,
) -> Result<StoredNotionConnection, AppError> {
    if notion_health(app).await? == ConnectorAccountStatus::ReconnectRequired {
        return Err(reconnect_required());
    }
    let stored = load_connected().await?;
    if !notion_token_expired_at(&stored, now_unix()) {
        return Ok(stored);
    }
    refresh_connected_token(app, false).await
}

async fn refresh_connected_token(
    app: &AppHandle,
    force: bool,
) -> Result<StoredNotionConnection, AppError> {
    let _guard = credential_lifecycle_lock().lock().await;
    let stored = load_connected().await?;
    if !force && !notion_token_expired_at(&stored, now_unix()) {
        return Ok(stored);
    }
    let refreshed = match refresh_stored_connection(&stored).await {
        Ok(refreshed) => refreshed,
        Err(error) if error.code == "notion_reconnect_required" => {
            if reconnect_requires_fresh_registration(&error) {
                store::store(&clear_dynamic_registration(stored)).await?;
            }
            record_reconnect_required(app).await;
            return Err(error);
        }
        Err(error) => return Err(error),
    };
    store::store(&refreshed).await?;
    Ok(refreshed)
}

async fn refresh_stored_connection(
    stored: &StoredNotionConnection,
) -> Result<StoredNotionConnection, AppError> {
    let refresh_token = stored
        .refresh_token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(reconnect_required)?;
    let tokens = refresh_token_request(
        &stored.client_id,
        stored.client_secret.as_deref(),
        refresh_token,
    )
    .await?;
    Ok(merge_refreshed_tokens(stored, tokens, now_unix()))
}

async fn refresh_token_request(
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
) -> Result<TokenResponse, AppError> {
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
        ("resource", EXPECTED_RESOURCE),
    ];
    if let Some(secret) = client_secret.filter(|secret| !secret.is_empty()) {
        form.push(("client_secret", secret));
    }
    let response = http_client()?
        .post(EXPECTED_TOKEN_ENDPOINT)
        .timeout(HTTP_TIMEOUT)
        .form(&form)
        .send()
        .await
        .map_err(|_| refresh_failed(RefreshFailureKind::Retryable, None))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|_| refresh_failed(RefreshFailureKind::Retryable, None))?;
    if (200..300).contains(&status) {
        if let Ok(tokens) = serde_json::from_str::<TokenResponse>(&body) {
            if !tokens.access_token.is_empty() {
                return Ok(tokens);
            }
        }
        tracing::warn!(
            status,
            "notion token refresh returned an incomplete response"
        );
        return Err(refresh_failed(RefreshFailureKind::Retryable, None));
    }
    let error_code = serde_json::from_str::<TokenErrorBody>(&body)
        .ok()
        .and_then(|body| body.error);
    let kind = classify_refresh_failure(status, error_code.as_deref());
    tracing::warn!(status, error_code = ?error_code, "notion token refresh failed");
    Err(refresh_failed(kind, error_code))
}

fn classify_refresh_failure(status: u16, error_code: Option<&str>) -> RefreshFailureKind {
    match error_code {
        Some("invalid_client" | "unauthorized_client") => {
            RefreshFailureKind::ReconnectRequiredWithFreshRegistration
        }
        Some("invalid_grant") => RefreshFailureKind::ReconnectRequired,
        _ if status >= 500 => RefreshFailureKind::Retryable,
        _ => RefreshFailureKind::Retryable,
    }
}

fn merge_refreshed_tokens(
    stored: &StoredNotionConnection,
    tokens: TokenResponse,
    now: i64,
) -> StoredNotionConnection {
    StoredNotionConnection {
        access_token: tokens.access_token.clone(),
        refresh_token: tokens
            .refresh_token
            .clone()
            .filter(|token| !token.trim().is_empty())
            .or_else(|| stored.refresh_token.clone()),
        expires_at_unix: tokens.expires_in.map(|expires| now + expires.max(0)),
        client_id: stored.client_id.clone(),
        client_secret: stored.client_secret.clone(),
        endpoint: MCP_ENDPOINT.to_string(),
        registration_redirect_uri: stored.registration_redirect_uri.clone(),
    }
}

fn reconnect_required() -> AppError {
    AppError::new(
        "notion_reconnect_required",
        "Reconnect Notion before using Notion tools.",
    )
}

fn reconnect_required_with_fresh_registration() -> AppError {
    let mut error = reconnect_required();
    error.details = Some(serde_json::json!({
        "freshRegistrationRequired": true,
    }));
    error
}

fn reconnect_requires_fresh_registration(error: &AppError) -> bool {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("freshRegistrationRequired"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn clear_dynamic_registration(stored: StoredNotionConnection) -> StoredNotionConnection {
    StoredNotionConnection {
        access_token: stored.access_token.clone(),
        refresh_token: stored.refresh_token.clone(),
        expires_at_unix: stored.expires_at_unix,
        client_id: String::new(),
        client_secret: None,
        endpoint: stored.endpoint.clone(),
        registration_redirect_uri: None,
    }
}

fn refresh_failed(kind: RefreshFailureKind, error_code: Option<String>) -> AppError {
    match kind {
        RefreshFailureKind::ReconnectRequired => reconnect_required(),
        RefreshFailureKind::ReconnectRequiredWithFreshRegistration => {
            reconnect_required_with_fresh_registration()
        }
        RefreshFailureKind::Retryable => {
            let message = match error_code {
                Some(code) => format!("Could not refresh the Notion connection ({code})."),
                None => {
                    "Could not refresh the Notion connection. Try again in a moment.".to_string()
                }
            };
            AppError::new("notion_token_refresh_failed", message)
        }
    }
}

async fn run_with_fresh_client<T, F, Fut>(app: &AppHandle, operation: F) -> Result<T, AppError>
where
    F: Fn(McpHttpClient) -> Fut,
    Fut: Future<Output = Result<T, AppError>>,
{
    let stored = load_connected_with_fresh_token(app).await?;
    let client = McpHttpClient::new(stored.access_token.clone());
    match operation(client).await {
        Err(error) if error.code == "notion_mcp_unauthorized" => {
            let refreshed = refresh_connected_token(app, true).await?;
            operation(McpHttpClient::new(refreshed.access_token.clone())).await
        }
        result => result,
    }
}

fn notion_token_expired_at(stored: &StoredNotionConnection, now: i64) -> bool {
    stored
        .expires_at_unix
        .is_some_and(|expires_at| expires_at <= now + TOKEN_EXPIRY_BUFFER_SECS)
}

fn connection() -> NotionConnection {
    NotionConnection {
        account_id: NOTION_ACCOUNT_ID.to_string(),
        endpoint: MCP_ENDPOINT.to_string(),
        preview: true,
        selected_resource_scoping_verified: false,
    }
}

async fn discover_and_validate() -> Result<(ResourceMetadata, AuthorizationServerMetadata), AppError>
{
    let resource = get_json::<ResourceMetadata>(RESOURCE_METADATA_ENDPOINT).await?;
    if resource.resource != EXPECTED_RESOURCE
        || !resource
            .authorization_servers
            .iter()
            .any(|server| server == EXPECTED_AUTHORIZATION_SERVER)
        || !resource
            .bearer_methods_supported
            .iter()
            .any(|method| method == "header")
    {
        return Err(metadata_error());
    }

    let auth_server =
        get_json::<AuthorizationServerMetadata>(AUTHORIZATION_SERVER_METADATA_ENDPOINT).await?;
    if auth_server.issuer != EXPECTED_ISSUER
        || auth_server.authorization_endpoint != EXPECTED_AUTHORIZATION_ENDPOINT
        || auth_server.token_endpoint != EXPECTED_TOKEN_ENDPOINT
        || auth_server.registration_endpoint.as_deref() != Some(EXPECTED_REGISTRATION_ENDPOINT)
        || !auth_server
            .response_types_supported
            .iter()
            .any(|response_type| response_type == "code")
        || !auth_server
            .grant_types_supported
            .iter()
            .any(|grant_type| grant_type == "authorization_code")
        || !auth_server
            .code_challenge_methods_supported
            .iter()
            .any(|method| method == "S256")
        || !auth_server
            .token_endpoint_auth_methods_supported
            .iter()
            .any(|method| method == "none")
    {
        return Err(metadata_error());
    }
    Ok((resource, auth_server))
}

async fn get_json<T: for<'de> Deserialize<'de>>(url: &str) -> Result<T, AppError> {
    let response = http_client()?
        .get(url)
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|_| metadata_error())?;
    if !response.status().is_success() {
        return Err(metadata_error());
    }
    response.json::<T>().await.map_err(|_| metadata_error())
}

fn metadata_error() -> AppError {
    AppError::new(
        "notion_oauth_metadata_invalid",
        "Notion's hosted MCP OAuth metadata did not match June's expected endpoint.",
    )
}

async fn prepare_registration(
    auth_server: &AuthorizationServerMetadata,
) -> Result<PreparedRegistration, AppError> {
    let stored = store::load().await.ok().flatten();
    if let Some(stored) = stored.as_ref() {
        if let Some(redirect_uri) = stored.registration_redirect_uri.as_deref() {
            if let Ok(listener) = bind_registration_redirect_uri(redirect_uri).await {
                if !stored.client_id.trim().is_empty() {
                    return Ok(PreparedRegistration {
                        listener,
                        redirect_uri: redirect_uri.to_string(),
                        registration: RegistrationResponse {
                            client_id: stored.client_id.clone(),
                            client_secret: stored.client_secret.clone(),
                        },
                    });
                }
            }
        }
    }

    let (listener, redirect_uri) = bind_ephemeral_redirect_uri().await?;
    let registration = register_client(auth_server, &redirect_uri).await?;
    Ok(PreparedRegistration {
        listener,
        redirect_uri,
        registration,
    })
}

async fn bind_ephemeral_redirect_uri() -> Result<(TcpListener, String), AppError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(loopback_bind_failed)?;
    let port = listener
        .local_addr()
        .map_err(|error| AppError::new("notion_loopback_bind_failed", error.to_string()))?
        .port();
    Ok((listener, format!("http://127.0.0.1:{port}/callback")))
}

async fn bind_registration_redirect_uri(redirect_uri: &str) -> Result<TcpListener, AppError> {
    let parsed = reqwest::Url::parse(redirect_uri).map_err(|_| loopback_redirect_invalid())?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.path() != "/callback"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(loopback_redirect_invalid());
    }
    let port = parsed.port().ok_or_else(loopback_redirect_invalid)?;
    TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(loopback_bind_failed)
}

fn loopback_redirect_invalid() -> AppError {
    AppError::new(
        "notion_loopback_redirect_invalid",
        "The saved Notion connection callback is invalid.",
    )
}

fn loopback_bind_failed(error: std::io::Error) -> AppError {
    AppError::new(
        "notion_loopback_bind_failed",
        format!("Could not start the local Notion connect listener: {error}"),
    )
}

async fn register_client(
    auth_server: &AuthorizationServerMetadata,
    redirect_uri: &str,
) -> Result<RegistrationResponse, AppError> {
    let endpoint = auth_server
        .registration_endpoint
        .as_deref()
        .ok_or_else(metadata_error)?;
    let response = http_client()?
        .post(endpoint)
        .timeout(HTTP_TIMEOUT)
        .json(&RegistrationRequest {
            client_name: "June",
            redirect_uris: vec![redirect_uri],
            grant_types: vec!["authorization_code", "refresh_token"],
            response_types: vec!["code"],
            token_endpoint_auth_method: "none",
        })
        .send()
        .await
        .map_err(|_| registration_failed())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| registration_failed())?;
    let registration =
        serde_json::from_str::<RegistrationResponse>(&body).map_err(|_| registration_failed())?;
    if registration.client_id.is_empty() {
        tracing::warn!(status, "notion dynamic registration returned no client id");
        return Err(registration_failed());
    }
    Ok(registration)
}

fn registration_failed() -> AppError {
    AppError::new(
        "notion_dynamic_registration_failed",
        "Could not prepare the Notion connection. Try again in a moment.",
    )
}

fn build_auth_url(
    auth_server: &AuthorizationServerMetadata,
    client_id: &str,
    redirect_uri: &str,
    code_challenge: &str,
    state: &str,
    resource: &str,
) -> String {
    format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&code_challenge={}&code_challenge_method=S256&state={}&resource={}",
        auth_server.authorization_endpoint,
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(code_challenge),
        urlencoding::encode(state),
        urlencoding::encode(resource),
    )
}

async fn exchange_code(
    auth_server: &AuthorizationServerMetadata,
    client_id: &str,
    client_secret: Option<&str>,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
    resource: &str,
) -> Result<TokenResponse, AppError> {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("code_verifier", verifier),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("resource", resource),
    ];
    if let Some(secret) = client_secret.filter(|secret| !secret.is_empty()) {
        form.push(("client_secret", secret));
    }
    let response = http_client()?
        .post(&auth_server.token_endpoint)
        .timeout(HTTP_TIMEOUT)
        .form(&form)
        .send()
        .await
        .map_err(|_| token_exchange_failed(None))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|_| token_exchange_failed(None))?;
    if let Ok(tokens) = serde_json::from_str::<TokenResponse>(&body) {
        if !tokens.access_token.is_empty() {
            return Ok(tokens);
        }
    }
    let error_code = serde_json::from_str::<TokenErrorBody>(&body)
        .ok()
        .and_then(|body| body.error);
    tracing::warn!(status, error_code = ?error_code, "notion token exchange failed");
    Err(token_exchange_failed(error_code))
}

fn token_exchange_failed(error_code: Option<String>) -> AppError {
    let message = match error_code {
        Some(code) => format!("Could not complete the Notion connection ({code})."),
        None => "Could not complete the Notion connection.".to_string(),
    };
    AppError::new("notion_token_exchange_failed", message)
}

struct McpHttpClient {
    access_token: String,
    session_id: std::sync::Mutex<Option<String>>,
}

impl McpHttpClient {
    fn new(access_token: String) -> Self {
        Self {
            access_token,
            session_id: std::sync::Mutex::new(None),
        }
    }

    fn session_id(&self) -> Option<String> {
        self.session_id.lock().ok().and_then(|guard| guard.clone())
    }

    async fn initialize(&self) -> Result<(), AppError> {
        let response = self
            .post_json(serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {
                        "name": "June",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                },
            }))
            .await?;
        self.capture_session_id(&response);
        let value = read_mcp_json(response).await?;
        ensure_jsonrpc_ok(&value, "notion_mcp_initialize_failed")?;
        self.post_json(serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {},
        }))
        .await?;
        Ok(())
    }

    async fn tools_list(&self) -> Result<(Vec<NotionToolSummary>, usize), AppError> {
        let (tools, value, bytes) = self.hosted_tools_list_with_value().await?;
        let summaries = tools
            .into_iter()
            .map(|tool| summarize_tool(&tool))
            .collect();
        let inventory_bytes = serde_json::to_vec(&value)
            .map(|body| body.len())
            .unwrap_or(bytes);
        Ok((summaries, inventory_bytes))
    }

    async fn hosted_tools_list(&self) -> Result<Vec<NotionMcpTool>, AppError> {
        let (tools, _value, _bytes) = self.hosted_tools_list_with_value().await?;
        Ok(tools)
    }

    async fn hosted_tools_list_with_value(
        &self,
    ) -> Result<(Vec<NotionMcpTool>, serde_json::Value, usize), AppError> {
        let value = self
            .jsonrpc_request(2, "tools/list", serde_json::json!({}))
            .await?;
        ensure_jsonrpc_ok(&value, "notion_mcp_tools_list_failed")?;
        let tools = value
            .get("result")
            .and_then(|result| result.get("tools"))
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| {
                AppError::new(
                    "notion_mcp_tools_list_failed",
                    "Notion returned an unexpected tool inventory.",
                )
            })?
            .iter()
            .filter_map(parse_hosted_tool)
            .collect();
        let bytes = serde_json::to_vec(&value)
            .map(|body| body.len())
            .unwrap_or(0);
        Ok((tools, value, bytes))
    }

    async fn call_tool(
        &self,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<serde_json::Value, AppError> {
        let value = self
            .jsonrpc_request(
                3,
                "tools/call",
                serde_json::json!({
                    "name": tool_name,
                    "arguments": arguments,
                }),
            )
            .await?;
        ensure_jsonrpc_ok(&value, "notion_mcp_tool_call_failed")?;
        value.get("result").cloned().ok_or_else(|| {
            AppError::new(
                "notion_mcp_tool_call_failed",
                "Notion hosted MCP returned an incomplete tool result.",
            )
        })
    }

    async fn jsonrpc_request(
        &self,
        id: u64,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, AppError> {
        let response = self
            .post_json(serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params,
            }))
            .await?;
        self.capture_session_id(&response);
        read_mcp_json(response).await
    }

    async fn post_json(&self, body: serde_json::Value) -> Result<reqwest::Response, AppError> {
        let mut request = http_client()?
            .post(MCP_ENDPOINT)
            .bearer_auth(&self.access_token)
            .header("accept", "application/json, text/event-stream")
            .header("content-type", "application/json")
            .header("mcp-protocol-version", MCP_PROTOCOL_VERSION)
            .timeout(MCP_REQUEST_TIMEOUT)
            .json(&body);
        if let Some(session_id) = self.session_id() {
            request = request.header(MCP_SESSION_ID_HEADER, session_id);
        }
        let response = request.send().await.map_err(|_| {
            AppError::new(
                "notion_mcp_request_failed",
                "Could not reach Notion hosted MCP.",
            )
        })?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            tracing::warn!(status, "notion MCP request failed");
            if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                return Err(AppError::new(
                    "notion_mcp_unauthorized",
                    "Notion rejected the saved connection. June will refresh it and retry.",
                ));
            }
            return Err(AppError::new(
                "notion_mcp_request_failed",
                "Notion hosted MCP did not accept the request.",
            ));
        }
        Ok(response)
    }

    fn capture_session_id(&self, response: &reqwest::Response) {
        let Some(session_id) = response
            .headers()
            .get(MCP_SESSION_ID_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return;
        };
        if let Ok(mut slot) = self.session_id.lock() {
            *slot = Some(session_id.to_string());
        }
    }
}

async fn read_mcp_json(response: reqwest::Response) -> Result<serde_json::Value, AppError> {
    let bytes = response.bytes().await.map_err(|_| {
        AppError::new(
            "notion_mcp_response_failed",
            "Could not read Notion hosted MCP's response.",
        )
    })?;
    if bytes.len() > MCP_RESPONSE_MAX_BYTES {
        return Err(AppError::new(
            "notion_mcp_response_too_large",
            "Notion hosted MCP returned more metadata than June will accept.",
        ));
    }
    let raw = std::str::from_utf8(&bytes).map_err(|_| {
        AppError::new(
            "notion_mcp_response_failed",
            "Notion hosted MCP returned an unreadable response.",
        )
    })?;
    parse_json_or_sse_json(raw).ok_or_else(|| {
        AppError::new(
            "notion_mcp_response_failed",
            "Notion hosted MCP returned an unexpected response.",
        )
    })
}

fn parse_json_or_sse_json(raw: &str) -> Option<serde_json::Value> {
    serde_json::from_str(raw).ok().or_else(|| {
        raw.lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim)
            .filter(|line| !line.is_empty() && *line != "[DONE]")
            .find_map(|line| serde_json::from_str(line).ok())
    })
}

fn ensure_jsonrpc_ok(value: &serde_json::Value, code: &'static str) -> Result<(), AppError> {
    if value.get("error").is_some() {
        return Err(AppError::new(
            code,
            "Notion hosted MCP returned an error for this request.",
        ));
    }
    if value.get("result").is_none() {
        return Err(AppError::new(
            code,
            "Notion hosted MCP returned an incomplete response.",
        ));
    }
    Ok(())
}

fn parse_hosted_tool(value: &serde_json::Value) -> Option<NotionMcpTool> {
    let name = value
        .get("name")?
        .as_str()?
        .trim()
        .chars()
        .take(MCP_TOOL_NAME_MAX_CHARS + 1)
        .collect::<String>();
    if name.is_empty() || name.chars().count() > MCP_TOOL_NAME_MAX_CHARS {
        return None;
    }
    let description = value
        .get("description")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|description| !description.is_empty())
        .map(truncate_description);
    let input_schema = value.get("inputSchema")?.as_object()?.clone();
    if serde_json::to_vec(&input_schema)
        .map(|schema| schema.len() > MCP_TOOL_SCHEMA_MAX_BYTES)
        .unwrap_or(true)
    {
        return None;
    }
    Some(NotionMcpTool {
        name,
        description,
        input_schema,
    })
}

fn summarize_tool(tool: &NotionMcpTool) -> NotionToolSummary {
    NotionToolSummary {
        write_class: classify_tool(&tool.name).to_string(),
        name: tool.name.clone(),
        description: tool.description.clone(),
    }
}

fn truncate_description(description: &str) -> String {
    let mut truncated: String = description
        .chars()
        .take(MCP_DESCRIPTION_MAX_CHARS)
        .collect();
    if description.chars().count() > MCP_DESCRIPTION_MAX_CHARS {
        truncated.push_str("...");
    }
    truncated
}

fn filter_allowed_tools(
    tools: Vec<NotionMcpTool>,
    allowed: fn(&str) -> Option<&'static str>,
) -> Vec<NotionMcpTool> {
    let mut filtered = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for mut tool in tools {
        let Some(canonical_name) = allowed(&tool.name) else {
            continue;
        };
        if !seen.insert(canonical_name) {
            continue;
        }
        tool.name = canonical_name.to_string();
        filtered.push(tool);
    }
    filtered
}

fn canonical_allowed_tool_name(name: &str, allowlist: &[&'static str]) -> Option<&'static str> {
    let trimmed = name.trim();
    allowlist
        .iter()
        .copied()
        .find(|allowed| *allowed == trimmed)
}

fn tool_allowed_for_hermes(name: &str) -> Option<&'static str> {
    canonical_allowed_tool_name(name, NOTION_READ_TOOL_ALLOWLIST)
}

fn action_tool_allowed_for_hermes(name: &str) -> Option<&'static str> {
    canonical_allowed_tool_name(name, NOTION_ACTION_TOOL_ALLOWLIST)
}

fn preflight_read_tool_arguments(
    tool_name: &str,
    arguments: &serde_json::Value,
) -> Result<(), AppError> {
    if tool_name != "notion-fetch" {
        return Ok(());
    }
    if arguments
        .as_object()
        .and_then(|object| object.get("id"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        == Some("self")
    {
        return Err(AppError::new(
            "notion_fetch_identity_unsupported",
            "Notion identity lookups are not available in this preview.",
        ));
    }
    Ok(())
}

fn preflight_action_arguments(
    tool_name: &str,
    arguments: &serde_json::Value,
) -> Result<(), AppError> {
    match tool_name {
        "notion-create-pages" => preflight_create_pages_arguments(arguments),
        "notion-update-page" => preflight_update_page_arguments(arguments),
        _ => Err(AppError::new(
            "notion_tool_not_allowed",
            "That Notion hosted MCP action is not enabled in June yet.",
        )),
    }
}

fn summarize_action(tool_name: &str, arguments: &serde_json::Value) -> String {
    match tool_name {
        "notion-update-page" => summarize_update_page_action(arguments),
        _ => summarize_create_pages_action(arguments),
    }
}

fn preview_action(tool_name: &str, arguments: &serde_json::Value) -> String {
    match tool_name {
        "notion-update-page" => preview_update_page_action(arguments),
        _ => preview_create_pages_action(arguments),
    }
}

fn preflight_create_pages_arguments(arguments: &serde_json::Value) -> Result<(), AppError> {
    let Some(object) = arguments.as_object() else {
        return Err(AppError::new(
            "notion_create_pages_invalid_args",
            "Notion page creation requires object arguments.",
        ));
    };
    reject_async_action(arguments)?;
    let Some(pages) = object.get("pages").and_then(serde_json::Value::as_array) else {
        return Err(AppError::new(
            "notion_create_pages_invalid_pages",
            "Notion page creation requires a pages array containing exactly one page object.",
        ));
    };
    if pages.len() > 1 {
        return Err(AppError::new(
            "notion_create_pages_batching_unsupported",
            "Create one Notion page at a time so June can show and approve its exact destination and content.",
        ));
    }
    if pages.len() != 1 || !pages[0].is_object() {
        return Err(AppError::new(
            "notion_create_pages_invalid_pages",
            "Notion page creation requires a pages array containing exactly one page object.",
        ));
    }
    Ok(())
}

fn reject_async_action(arguments: &serde_json::Value) -> Result<(), AppError> {
    if arguments
        .as_object()
        .and_then(|object| object.get("allow_async"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return Err(AppError::new(
            "notion_async_actions_unsupported",
            "Notion async page actions are not supported in this preview.",
        ));
    }
    Ok(())
}

fn preflight_update_page_arguments(arguments: &serde_json::Value) -> Result<(), AppError> {
    let Some(object) = arguments.as_object() else {
        return Err(AppError::new(
            "notion_update_page_invalid_args",
            "Notion page updates require object arguments.",
        ));
    };
    if update_page_target(arguments).is_none() {
        return Err(AppError::new(
            "notion_update_page_missing_target",
            "Notion page updates require a top-level page_id target.",
        ));
    }
    reject_async_action(arguments)?;
    if object.iter().any(|(key, value)| {
        NOTION_DESTRUCTIVE_UPDATE_FIELDS.contains(&key.as_str()) && !value.is_null()
    }) {
        return Err(AppError::new(
            "notion_update_page_destructive_fields",
            "Notion page updates cannot archive, trash, or erase content in this preview.",
        ));
    }
    if object
        .get("allow_deleting_content")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return Err(AppError::new(
            "notion_update_page_deleting_content_unsupported",
            "Notion page updates cannot delete child pages or databases in this preview.",
        ));
    }
    if object.iter().any(|(key, value)| {
        !NOTION_UPDATE_PAGE_ALLOWED_FIELDS.contains(&key.as_str()) && !value.is_null()
    }) {
        return Err(AppError::new(
            "notion_update_page_unsupported_fields",
            "That Notion update field is not supported in this preview.",
        ));
    }
    let has_change = object
        .iter()
        .any(|(key, value)| key.as_str() != "page_id" && !value.is_null());
    if !has_change {
        return Err(AppError::new(
            "notion_update_page_empty",
            "Notion page updates require a change payload.",
        ));
    }
    Ok(())
}

fn summarize_create_pages_action(arguments: &serde_json::Value) -> String {
    let _ = arguments;
    "Create a Notion page".to_string()
}

fn preview_create_pages_action(arguments: &serde_json::Value) -> String {
    let title = find_first_string_by_key(arguments, &["title", "name"])
        .unwrap_or_else(|| "(title not specified)".to_string());
    let parent = create_pages_parent(arguments).unwrap_or_else(|| "Not specified".to_string());
    let payload =
        summarize_create_payload(arguments).unwrap_or_else(|| "Not specified".to_string());
    format!(
        "Operation: create Notion page | Title: {} | Parent: {} | Content: {}",
        truncate_approval_value(&title),
        truncate_approval_value(&parent),
        truncate_approval_value(&payload)
    )
}

fn summarize_update_page_action(_arguments: &serde_json::Value) -> String {
    "Update a Notion page".to_string()
}

fn preview_update_page_action(arguments: &serde_json::Value) -> String {
    let target = update_page_target(arguments).unwrap_or_else(|| "Unknown".to_string());
    let title = update_page_title(arguments).unwrap_or_else(|| "Not specified".to_string());
    let changes = summarize_update_change_keys(arguments);
    let values = summarize_update_values(arguments).unwrap_or_else(|| "Not specified".to_string());
    let destructive_disclosure = blank_replacement_disclosure(arguments)
        .map(|disclosure| format!(" | Effect: {disclosure}"))
        .unwrap_or_default();
    format!(
        "Operation: update Notion page{} | Target: {} | Title: {} | Changes: {} | Values: {}",
        destructive_disclosure,
        truncate_approval_value(&target),
        truncate_approval_value(&title),
        changes,
        truncate_approval_value(&values)
    )
}

fn blank_replacement_disclosure(arguments: &serde_json::Value) -> Option<&'static str> {
    let object = arguments.as_object()?;
    let command = object.get("command")?.as_str()?;
    match command {
        "replace_content"
            if object
                .get("new_str")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|replacement| replacement.trim().is_empty()) =>
        {
            Some("Blank replacement clears all page content")
        }
        "replace_content_range"
            if object
                .get("new_str")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|replacement| replacement.trim().is_empty()) =>
        {
            Some("Blank replacement deletes the selected content")
        }
        "update_content"
            if object
                .get("content_updates")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|updates| {
                    updates.iter().any(|update| {
                        update
                            .get("new_str")
                            .and_then(serde_json::Value::as_str)
                            .is_some_and(|replacement| replacement.trim().is_empty())
                    })
                }) =>
        {
            Some("Blank replacements delete the matched content")
        }
        _ => None,
    }
}

fn summarize_update_change_keys(arguments: &serde_json::Value) -> String {
    let Some(object) = arguments.as_object() else {
        return "Unknown".to_string();
    };
    let keys: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|key| *key != "page_id" && NOTION_UPDATE_PAGE_ALLOWED_FIELDS.contains(key))
        .collect();
    if keys.is_empty() {
        "None".to_string()
    } else {
        keys.join(", ")
    }
}

fn summarize_create_payload(arguments: &serde_json::Value) -> Option<String> {
    let pages = arguments
        .get("pages")
        .and_then(serde_json::Value::as_array)
        .filter(|pages| !pages.is_empty());
    let source = pages.and_then(|pages| pages.first()).unwrap_or(arguments);
    summarize_payload_fields(
        source,
        &["properties", "content", "children", "body", "markdown"],
    )
}

fn summarize_update_values(arguments: &serde_json::Value) -> Option<String> {
    summarize_payload_fields(
        arguments,
        &[
            "command",
            "content_updates",
            "selection_with_ellipsis",
            "new_str",
            "properties",
            "content",
            "position",
            "allow_deleting_content",
            "children",
            "body",
            "markdown",
            "title",
            "name",
        ],
    )
}

fn summarize_payload_fields(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    let object = value.as_object()?;
    let mut parts = Vec::new();
    for key in keys {
        let Some(field_value) = object
            .get(*key)
            .filter(|field_value| !field_value.is_null())
        else {
            continue;
        };
        parts.push(format!("{key}: {}", summarize_approval_json(field_value)));
        if parts.len() >= 3 {
            break;
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("; "))
    }
}

fn summarize_approval_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.split_whitespace().collect::<Vec<_>>().join(" "),
        serde_json::Value::Number(_) | serde_json::Value::Bool(_) => value.to_string(),
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Array(items) => {
            let mut rendered = Vec::new();
            for item in items.iter().take(3) {
                rendered.push(summarize_approval_json(item));
            }
            let suffix = if items.len() > 3 { ", ..." } else { "" };
            format!("[{}{}]", rendered.join(", "), suffix)
        }
        serde_json::Value::Object(map) => {
            let mut rendered = Vec::new();
            for (key, child) in map.iter().take(5) {
                rendered.push(format!("{key}: {}", summarize_approval_json(child)));
            }
            let suffix = if map.len() > 5 { ", ..." } else { "" };
            format!("{{{}{} }}", rendered.join(", "), suffix)
        }
    }
}

fn update_page_target(arguments: &serde_json::Value) -> Option<String> {
    arguments
        .as_object()
        .and_then(|object| object.get("page_id"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|target| !target.is_empty())
        .map(ToOwned::to_owned)
}

fn update_page_title(arguments: &serde_json::Value) -> Option<String> {
    arguments
        .as_object()
        .and_then(|object| object.get("title").or_else(|| object.get("name")))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(ToOwned::to_owned)
}

fn create_pages_parent(arguments: &serde_json::Value) -> Option<String> {
    top_level_string(arguments, &["parent", "parent_id", "parentId"])
        .or_else(|| nested_parent_string(arguments))
        .or_else(|| {
            arguments
                .get("pages")
                .and_then(serde_json::Value::as_array)
                .and_then(|pages| pages.first())
                .and_then(|page| {
                    top_level_string(page, &["parent", "parent_id", "parentId"])
                        .or_else(|| nested_parent_string(page))
                })
        })
}

fn top_level_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    let object = value.as_object()?;
    keys.iter().find_map(|key| {
        object
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn nested_parent_string(value: &serde_json::Value) -> Option<String> {
    let parent = value.as_object()?.get("parent")?.as_object()?;
    ["page_id", "database_id", "url", "id"]
        .iter()
        .find_map(|key| {
            parent
                .get(*key)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(ToOwned::to_owned)
        })
}

fn find_first_string_by_key(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                if keys
                    .iter()
                    .any(|candidate| key.eq_ignore_ascii_case(candidate))
                {
                    if let Some(text) = child.as_str().filter(|text| !text.trim().is_empty()) {
                        return Some(text.trim().to_string());
                    }
                }
                if let Some(found) = find_first_string_by_key(child, keys) {
                    return Some(found);
                }
            }
            None
        }
        serde_json::Value::Array(items) => items
            .iter()
            .find_map(|item| find_first_string_by_key(item, keys)),
        _ => None,
    }
}

fn truncate_approval_value(value: &str) -> String {
    const MAX_CHARS: usize = 160;
    let cleaned = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.chars().count() <= MAX_CHARS {
        return cleaned;
    }
    let mut truncated: String = cleaned.chars().take(MAX_CHARS).collect();
    truncated.push_str("...");
    truncated
}

fn classify_tool(name: &str) -> &'static str {
    let lowered = name.to_ascii_lowercase();
    if lowered.contains("create")
        || lowered.contains("update")
        || lowered.contains("delete")
        || lowered.contains("move")
        || lowered.contains("duplicate")
        || lowered.contains("comment")
        || lowered.contains("attachment")
    {
        "write_or_action"
    } else {
        "read_or_unknown"
    }
}

const SUCCESS_BODY: &str = r##"<!doctype html>
<html lang=en>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>June</title>
<style>
  :root{--bg:#f1f0ed;--card:#fff;--fg:#2b2a28;--muted:#8a8884;--border:#e7e4de;--mark-fg:#fff;--ok:#2c6747;--ok-soft:#e7efe9}
  @media (prefers-color-scheme:dark){:root{--bg:#181817;--card:#252423;--fg:#fafafa;--muted:#b2b0ac;--border:rgba(255,255,255,.10);--mark-fg:#181817;--ok:#6fbf94;--ok-soft:rgba(111,191,148,.16)}}
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  .card{display:flex;flex-direction:column;align-items:center;gap:16px;width:100%;max-width:340px;padding:36px 32px;text-align:center;background:var(--card);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
  .mark{display:grid;place-items:center;width:40px;height:40px;border-radius:11px;background:var(--fg);color:var(--mark-fg);font-weight:700;font-size:15px;letter-spacing:.06em}
  .check{display:inline-flex;align-items:center;gap:7px;padding:4px 11px 4px 9px;border-radius:999px;background:var(--ok-soft);color:var(--ok);font-size:12.5px;font-weight:600}
  .check svg{width:13px;height:13px}
  .title{margin:0;font-size:17px;font-weight:600;letter-spacing:-.01em}
  .sub{margin:0;font-size:14px;line-height:1.5;color:var(--muted)}
</style>
<body>
  <main class=card>
    <div class=mark>OS</div>
    <span class=check><svg viewBox="0 0 14 14" fill=none stroke=currentColor stroke-width=1.8 stroke-linecap=round stroke-linejoin=round><path d="M3 7.5 6 10l5-6"/></svg>Connected</span>
    <h1 class=title>You're connected</h1>
    <p class=sub>You can close this tab and return to June.</p>
  </main>
</body>
</html>"##;

async fn await_callback(listener: &TcpListener, expected_state: &str) -> Result<String, AppError> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| AppError::new("notion_loopback_accept_failed", e.to_string()))?;

        let mut buf = [0u8; 4096];
        let n = match tokio::time::timeout(SOCKET_READ_TIMEOUT, stream.read(&mut buf)).await {
            Ok(Ok(n)) => n,
            Ok(Err(_)) | Err(_) => continue,
        };
        let request = String::from_utf8_lossy(&buf[..n]);
        let path = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("");

        if !is_loopback_callback_path(path) {
            write_http(&mut stream, "404 Not Found", "Not found").await;
            continue;
        }

        match validate_callback(path, expected_state) {
            CallbackOutcome::Ignore => {
                write_http(&mut stream, "400 Bad Request", "Invalid connect callback").await;
                continue;
            }
            CallbackOutcome::Denied => {
                write_http(&mut stream, "200 OK", "You can close this tab.").await;
                return Err(AppError::new(
                    "notion_connect_denied",
                    "Notion access was declined.",
                ));
            }
            CallbackOutcome::MissingCode => {
                write_http(&mut stream, "400 Bad Request", "Missing authorization code").await;
                return Err(AppError::new(
                    "notion_missing_code",
                    "Notion's response was missing an authorization code.",
                ));
            }
            CallbackOutcome::Code(code) => {
                write_http(&mut stream, "200 OK", SUCCESS_BODY).await;
                return Ok(code);
            }
        }
    }
}

fn is_loopback_callback_path(path: &str) -> bool {
    path.split_once('?').map_or(path, |(path, _query)| path) == "/callback"
}

async fn write_http(stream: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
}

enum CallbackOutcome {
    Ignore,
    Denied,
    MissingCode,
    Code(String),
}

fn parse_callback_query(path: &str) -> (Option<String>, Option<String>, Option<String>) {
    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let decoded = urlencoding::decode(value)
            .map(|v| v.into_owned())
            .unwrap_or_else(|_| value.to_string());
        match key {
            "code" => code = Some(decoded),
            "state" => state = Some(decoded),
            "error" => error = Some(decoded),
            _ => {}
        }
    }
    (code, state, error)
}

fn validate_callback(path: &str, expected_state: &str) -> CallbackOutcome {
    let (code, state, error) = parse_callback_query(path);
    if state.as_deref() != Some(expected_state) {
        return CallbackOutcome::Ignore;
    }
    if error.is_some() {
        return CallbackOutcome::Denied;
    }
    code.map_or(CallbackOutcome::MissingCode, CallbackOutcome::Code)
}

fn pkce() -> (String, String) {
    let verifier = random_b64url(32);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn random_b64url(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(&buf)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

mod store {
    use super::*;

    const KEYCHAIN_SERVICE: &str = "co.opensoftware.june.notion-hosted-mcp";
    const DEV_KEYCHAIN_SERVICE: &str = "co.opensoftware.june-dev.notion-hosted-mcp";

    pub async fn store(tokens: &StoredNotionConnection) -> Result<(), AppError> {
        let json = serde_json::to_string(tokens)
            .map_err(|e| AppError::new("notion_token_serialize_failed", e.to_string()))?;
        store_platform(json).await
    }

    pub async fn load() -> Result<Option<StoredNotionConnection>, AppError> {
        load_platform().await
    }

    pub async fn delete() -> Result<(), AppError> {
        delete_platform().await
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    async fn store_platform(json: String) -> Result<(), AppError> {
        let service = keychain_service().to_string();
        tokio::task::spawn_blocking(move || {
            keyring::Entry::new(&service, NOTION_ACCOUNT_ID)
                .and_then(|entry| entry.set_password(&json))
        })
        .await
        .map_err(|e| AppError::new("notion_keychain_write_failed", e.to_string()))?
        .map_err(|e| AppError::new("notion_keychain_write_failed", e.to_string()))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    async fn store_platform(_json: String) -> Result<(), AppError> {
        Err(AppError::new(
            "notion_keychain_write_failed",
            "Secure token storage is only available on macOS and Windows.",
        ))
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    async fn load_platform() -> Result<Option<StoredNotionConnection>, AppError> {
        let service = keychain_service().to_string();
        let raw = tokio::task::spawn_blocking(move || {
            match keyring::Entry::new(&service, NOTION_ACCOUNT_ID)
                .and_then(|entry| entry.get_password())
            {
                Ok(raw) => Ok(Some(raw)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(AppError::new("notion_keychain_read_failed", e.to_string())),
            }
        })
        .await
        .map_err(|e| AppError::new("notion_keychain_read_failed", e.to_string()))??;
        let Some(raw) = raw else {
            return Ok(None);
        };
        serde_json::from_str::<StoredNotionConnection>(&raw)
            .map(Some)
            .map_err(|_| {
                AppError::new(
                    "notion_keychain_read_failed",
                    "Stored Notion tokens could not be parsed.",
                )
            })
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    async fn load_platform() -> Result<Option<StoredNotionConnection>, AppError> {
        Ok(None)
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    async fn delete_platform() -> Result<(), AppError> {
        let service = keychain_service().to_string();
        tokio::task::spawn_blocking(move || {
            match keyring::Entry::new(&service, NOTION_ACCOUNT_ID)
                .and_then(|entry| entry.delete_credential())
            {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(AppError::new(
                    "notion_keychain_delete_failed",
                    e.to_string(),
                )),
            }
        })
        .await
        .map_err(|e| AppError::new("notion_keychain_delete_failed", e.to_string()))?
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    async fn delete_platform() -> Result<(), AppError> {
        Ok(())
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn keychain_service() -> &'static str {
        if cfg!(debug_assertions) {
            DEV_KEYCHAIN_SERVICE
        } else {
            KEYCHAIN_SERVICE
        }
    }
}

pub fn notion_account_id() -> &'static str {
    NOTION_ACCOUNT_ID
}

pub fn notion_account_email() -> &'static str {
    NOTION_ACCOUNT_EMAIL
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_url_carries_hosted_mcp_oauth_params() {
        let metadata = AuthorizationServerMetadata {
            issuer: EXPECTED_ISSUER.to_string(),
            authorization_endpoint: EXPECTED_AUTHORIZATION_ENDPOINT.to_string(),
            token_endpoint: EXPECTED_TOKEN_ENDPOINT.to_string(),
            registration_endpoint: Some(EXPECTED_REGISTRATION_ENDPOINT.to_string()),
            response_types_supported: vec!["code".to_string()],
            grant_types_supported: vec!["authorization_code".to_string()],
            token_endpoint_auth_methods_supported: vec!["none".to_string()],
            code_challenge_methods_supported: vec!["S256".to_string()],
        };
        let url = build_auth_url(
            &metadata,
            "client-123",
            "http://127.0.0.1:49152/callback",
            "challenge",
            "csrf-state",
            MCP_ENDPOINT,
        );
        assert!(url.starts_with("https://mcp.notion.com/authorize?"));
        assert!(url.contains("client_id=client-123"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fcallback"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("code_challenge=challenge"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=csrf-state"));
        assert!(url.contains("resource=https%3A%2F%2Fmcp.notion.com%2Fmcp"));
    }

    #[test]
    fn callback_validation_ignores_wrong_state() {
        assert!(matches!(
            validate_callback("/callback?code=bad&state=wrong", "expected"),
            CallbackOutcome::Ignore
        ));
    }

    #[test]
    fn callback_validation_accepts_matching_state() {
        assert!(matches!(
            validate_callback("/callback?code=good&state=expected", "expected"),
            CallbackOutcome::Code(code) if code == "good"
        ));
    }

    #[test]
    fn callback_validation_surfaces_consent_denial() {
        assert!(matches!(
            validate_callback("/callback?error=access_denied&state=expected", "expected"),
            CallbackOutcome::Denied
        ));
    }

    #[test]
    fn callback_path_rejects_prefix_matches() {
        assert!(is_loopback_callback_path("/callback?code=x&state=y"));
        assert!(!is_loopback_callback_path("/callback-extra?code=x&state=y"));
    }

    #[tokio::test]
    async fn bind_registration_redirect_uri_accepts_exact_saved_callback() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let redirect_uri = format!("http://127.0.0.1:{port}/callback");

        let rebound = bind_registration_redirect_uri(&redirect_uri).await.unwrap();

        assert_eq!(rebound.local_addr().unwrap().port(), port);
    }

    #[tokio::test]
    async fn bind_registration_redirect_uri_rejects_unexpected_callback_shape() {
        for redirect_uri in [
            "https://127.0.0.1:49152/callback",
            "http://localhost:49152/callback",
            "http://127.0.0.1:49152/other",
            "http://127.0.0.1/callback",
            "not a uri",
        ] {
            assert!(bind_registration_redirect_uri(redirect_uri).await.is_err());
        }
    }

    #[test]
    fn connection_status_defaults_to_preview_unverified() {
        let connection = connection();
        assert_eq!(connection.account_id, "notion-hosted-mcp");
        assert!(connection.preview);
        assert!(!connection.selected_resource_scoping_verified);
    }

    #[test]
    fn notion_allowlists_are_exact_and_canonical() {
        assert_eq!(
            tool_allowed_for_hermes("notion-search"),
            Some("notion-search")
        );
        assert_eq!(
            action_tool_allowed_for_hermes("notion-create-pages"),
            Some("notion-create-pages")
        );
        assert_eq!(
            action_tool_allowed_for_hermes("notion-update-page"),
            Some("notion-update-page")
        );
        assert_eq!(action_tool_allowed_for_hermes("Notion-update-page"), None);
        assert_eq!(action_tool_allowed_for_hermes("notion-move-pages"), None);
        assert_eq!(tool_allowed_for_hermes("notion-update-page"), None);
        assert_eq!(tool_allowed_for_hermes("notion-get-users"), None);
        assert_eq!(tool_allowed_for_hermes("notion-get-teams"), None);
    }

    #[test]
    fn token_expiry_uses_reconnect_buffer() {
        let mut stored = StoredNotionConnection {
            access_token: "token".to_string(),
            refresh_token: Some("refresh".to_string()),
            expires_at_unix: None,
            client_id: "client".to_string(),
            client_secret: None,
            endpoint: MCP_ENDPOINT.to_string(),
            registration_redirect_uri: None,
        };
        assert!(!notion_token_expired_at(&stored, 1_000));

        stored.expires_at_unix = Some(1_000 + TOKEN_EXPIRY_BUFFER_SECS + 1);
        assert!(!notion_token_expired_at(&stored, 1_000));

        stored.expires_at_unix = Some(1_000 + TOKEN_EXPIRY_BUFFER_SECS);
        assert!(notion_token_expired_at(&stored, 1_000));

        stored.expires_at_unix = Some(999);
        assert!(notion_token_expired_at(&stored, 1_000));
    }

    #[test]
    fn action_request_timeout_uses_deadline_budget() {
        let future_deadline = now_unix_ms() + 10_000;
        let timeout = action_request_timeout(Some(future_deadline)).unwrap();
        assert!(timeout <= Duration::from_secs(5));
        assert!(timeout > Duration::from_secs(4));

        let far_future_deadline = now_unix_ms() + 300_000;
        assert_eq!(
            action_request_timeout(Some(far_future_deadline)).unwrap(),
            MCP_ACTION_REQUEST_TIMEOUT
        );
        assert_eq!(
            action_request_timeout(None).unwrap(),
            MCP_ACTION_REQUEST_TIMEOUT
        );
    }

    #[test]
    fn action_request_timeout_rejects_expired_deadline() {
        let expired_deadline = now_unix_ms() + 1_000;
        assert_eq!(
            action_request_timeout(Some(expired_deadline))
                .unwrap_err()
                .code,
            "notion_mcp_action_deadline_expired"
        );
    }

    #[test]
    fn classify_refresh_failure_reconnects_for_definitive_oauth_auth_errors() {
        assert_eq!(
            classify_refresh_failure(400, Some("invalid_grant")),
            RefreshFailureKind::ReconnectRequired
        );
        for code in ["invalid_client", "unauthorized_client"] {
            assert_eq!(
                classify_refresh_failure(400, Some(code)),
                RefreshFailureKind::ReconnectRequiredWithFreshRegistration
            );
        }
    }

    #[test]
    fn client_auth_refresh_failures_request_fresh_registration() {
        let error = refresh_failed(
            RefreshFailureKind::ReconnectRequiredWithFreshRegistration,
            Some("invalid_client".to_string()),
        );

        assert_eq!(error.code, "notion_reconnect_required");
        assert!(reconnect_requires_fresh_registration(&error));
        assert!(!reconnect_requires_fresh_registration(&reconnect_required()));
    }

    #[test]
    fn clear_dynamic_registration_preserves_tokens_only() {
        let cleared = clear_dynamic_registration(stored_connection());

        assert_eq!(cleared.access_token, "access");
        assert_eq!(cleared.refresh_token.as_deref(), Some("refresh"));
        assert_eq!(cleared.expires_at_unix, Some(900));
        assert_eq!(cleared.endpoint, MCP_ENDPOINT);
        assert!(cleared.client_id.is_empty());
        assert!(cleared.client_secret.is_none());
        assert!(cleared.registration_redirect_uri.is_none());
    }

    #[test]
    fn classify_refresh_failure_keeps_unknown_and_server_errors_retryable() {
        assert_eq!(
            classify_refresh_failure(400, Some("invalid_request")),
            RefreshFailureKind::Retryable
        );
        assert_eq!(
            classify_refresh_failure(502, Some("temporarily_unavailable")),
            RefreshFailureKind::Retryable
        );
        assert_eq!(
            classify_refresh_failure(400, None),
            RefreshFailureKind::Retryable
        );
    }

    #[test]
    fn merge_refreshed_tokens_rotates_refresh_and_expiry() {
        let stored = stored_connection();
        let merged = merge_refreshed_tokens(
            &stored,
            TokenResponse {
                access_token: "new-access".to_string(),
                refresh_token: Some("new-refresh".to_string()),
                expires_in: Some(300),
            },
            1_000,
        );

        assert_eq!(merged.access_token, "new-access");
        assert_eq!(merged.refresh_token.as_deref(), Some("new-refresh"));
        assert_eq!(merged.expires_at_unix, Some(1_300));
        assert_eq!(merged.client_id, stored.client_id);
    }

    #[test]
    fn merge_refreshed_tokens_preserves_refresh_when_omitted_and_clears_expiry() {
        let stored = stored_connection();
        let merged = merge_refreshed_tokens(
            &stored,
            TokenResponse {
                access_token: "new-access".to_string(),
                refresh_token: None,
                expires_in: None,
            },
            1_000,
        );

        assert_eq!(merged.access_token, "new-access");
        assert_eq!(merged.refresh_token.as_deref(), Some("refresh"));
        assert_eq!(merged.expires_at_unix, None);
    }

    #[test]
    fn update_page_target_is_top_level_page_id_only() {
        let arguments = serde_json::json!({
            "page_id": " page-123 ",
            "content": { "id": "block-456", "url": "https://nested.invalid" },
            "title": "Updated title"
        });

        assert_eq!(update_page_target(&arguments).as_deref(), Some("page-123"));
        assert!(preflight_update_page_arguments(&arguments).is_ok());
        assert!(preview_update_page_action(&arguments).contains("Target: page-123"));
    }

    #[test]
    fn update_page_preflight_rejects_unpreviewed_fields() {
        for arguments in [
            serde_json::json!({
                "page_id": "page-123",
                "icon": { "type": "emoji", "emoji": "✅" }
            }),
            serde_json::json!({
                "page_id": "page-123",
                "cover": { "type": "external", "external": { "url": "https://example.com/cover.png" } }
            }),
            serde_json::json!({
                "page_id": "page-123",
                "template": "Launch template"
            }),
        ] {
            assert_eq!(
                preflight_update_page_arguments(&arguments)
                    .unwrap_err()
                    .code,
                "notion_update_page_unsupported_fields"
            );
        }
    }

    #[test]
    fn update_page_preflight_preserves_destructive_field_error() {
        let arguments = serde_json::json!({
            "page_id": "page-123",
            "is_archived": true
        });

        assert_eq!(
            preflight_update_page_arguments(&arguments)
                .unwrap_err()
                .code,
            "notion_update_page_destructive_fields"
        );
    }

    #[test]
    fn update_page_preflight_rejects_empty_changes() {
        let arguments = serde_json::json!({
            "page_id": "page-123"
        });

        assert_eq!(
            preflight_update_page_arguments(&arguments)
                .unwrap_err()
                .code,
            "notion_update_page_empty"
        );
    }

    #[test]
    fn create_pages_preflight_requires_exactly_one_object() {
        for arguments in [
            serde_json::json!({}),
            serde_json::json!({ "pages": [] }),
            serde_json::json!({ "pages": ["not an object"] }),
        ] {
            assert_eq!(
                preflight_create_pages_arguments(&arguments)
                    .unwrap_err()
                    .code,
                "notion_create_pages_invalid_pages"
            );
        }
        assert_eq!(
            preflight_create_pages_arguments(&serde_json::json!({
                "pages": [{ "title": "One" }, { "title": "Two" }]
            }))
            .unwrap_err()
            .code,
            "notion_create_pages_batching_unsupported"
        );
        assert!(preflight_create_pages_arguments(&serde_json::json!({
            "pages": [{ "title": "One" }]
        }))
        .is_ok());
    }

    #[test]
    fn create_pages_preview_shows_nested_parent() {
        let arguments = serde_json::json!({
            "pages": [{
                "title": "Child page",
                "parent": { "page_id": "page-123" }
            }]
        });

        assert!(preview_create_pages_action(&arguments).contains("Parent: page-123"));
    }

    #[test]
    fn create_pages_preview_shows_bounded_content() {
        let arguments = serde_json::json!({
            "pages": [{
                "title": "Decision log",
                "parent": { "page_id": "page-123" },
                "properties": { "Status": "Draft" },
                "content": "Publish the Q3 decision summary"
            }]
        });

        let preview = preview_create_pages_action(&arguments);
        assert!(preview.contains("Content: properties:"));
        assert!(preview.contains("Status"));
        assert!(preview.contains("Publish the Q3 decision summary"));
    }

    #[test]
    fn update_page_preview_shows_bounded_values() {
        let arguments = serde_json::json!({
            "page_id": "page-123",
            "title": "Decision log",
            "properties": { "Status": "Approved" },
            "content": "Update with approved launch notes"
        });

        let preview = preview_update_page_action(&arguments);
        assert!(preview.contains("Changes: content, properties, title"));
        assert!(preview.contains("Values: properties:"));
        assert!(preview.contains("Approved"));
        assert!(preview.contains("Update with approved launch notes"));
    }

    #[test]
    fn update_page_preview_shows_replacement_text() {
        let arguments = serde_json::json!({
            "page_id": "page-123",
            "command": "replace_content",
            "new_str": "Replacement markdown for the whole page"
        });

        let preview = preview_update_page_action(&arguments);
        assert!(preview.contains("command: replace_content"));
        assert!(preview.contains("new_str: Replacement markdown for the whole page"));
    }

    #[test]
    fn update_page_preview_shows_range_replacement_text() {
        let arguments = serde_json::json!({
            "page_id": "page-123",
            "command": "replace_content_range",
            "selection_with_ellipsis": "Old intro...old ending",
            "new_str": "Replacement range markdown"
        });

        let preview = preview_update_page_action(&arguments);
        assert!(preview.contains("selection_with_ellipsis: Old intro...old ending"));
        assert!(preview.contains("new_str: Replacement range markdown"));
    }

    #[test]
    fn update_page_preflight_accepts_current_hosted_content_commands() {
        let insert = serde_json::json!({
            "command": "insert_content",
            "content": "New worklog entry",
            "page_id": "page-123",
            "position": { "type": "end" }
        });
        assert!(preflight_update_page_arguments(&insert).is_ok());
        let insert_preview = preview_update_page_action(&insert);
        assert!(insert_preview.contains("content: New worklog entry"));
        assert!(insert_preview.contains("position: {type: end }"));

        let targeted = serde_json::json!({
            "command": "update_content",
            "content_updates": [{
                "old_str": "Existing entry",
                "new_str": "Updated entry"
            }],
            "page_id": "page-123"
        });
        assert!(preflight_update_page_arguments(&targeted).is_ok());
        let targeted_preview = preview_update_page_action(&targeted);
        assert!(targeted_preview.contains("content_updates:"));
        assert!(targeted_preview.contains("Existing entry"));
        assert!(targeted_preview.contains("Updated entry"));
    }

    #[test]
    fn update_page_preview_discloses_blank_replacement_effects() {
        for (command, expected) in [
            (
                "replace_content",
                "Blank replacement clears all page content",
            ),
            (
                "replace_content_range",
                "Blank replacement deletes the selected content",
            ),
        ] {
            let arguments = serde_json::json!({
                "page_id": "page-123",
                "command": command,
                "selection_with_ellipsis": "Old intro...old ending",
                "new_str": "  "
            });
            assert!(preflight_update_page_arguments(&arguments).is_ok());
            let preview = preview_update_page_action(&arguments);
            assert!(preview.contains(expected));
            assert!(preview.find(expected).unwrap() < preview.find("Target:").unwrap());
        }
    }

    #[test]
    fn update_page_change_summary_includes_every_present_allowlisted_key() {
        let arguments = serde_json::json!({
            "page_id": "page-123",
            "allow_async": false,
            "command": "replace_content_range",
            "selection_with_ellipsis": "old...text",
            "new_str": "new",
            "properties": { "Status": "Done" },
            "content": "content",
            "content_updates": [{ "old_str": "old", "new_str": "new" }],
            "position": { "type": "end" },
            "allow_deleting_content": false,
            "children": [],
            "body": "body",
            "markdown": "markdown",
            "title": "Title",
            "name": "Name",
            "unknown_null_one": null,
            "unknown_null_two": null,
            "unknown_null_three": null
        });
        let changes = summarize_update_change_keys(&arguments);
        for key in [
            "allow_async",
            "command",
            "selection_with_ellipsis",
            "new_str",
            "properties",
            "content",
            "content_updates",
            "position",
            "allow_deleting_content",
            "children",
            "body",
            "markdown",
            "title",
            "name",
        ] {
            assert!(changes.contains(key), "missing {key} from {changes}");
        }
        assert!(!changes.contains("unknown_null"));
        assert!(preview_update_page_action(&arguments).contains(&format!("Changes: {changes}")));
    }

    #[test]
    fn notion_fetch_rejects_self_identity_lookup() {
        for arguments in [
            serde_json::json!({ "id": "self" }),
            serde_json::json!({ "id": " self " }),
        ] {
            assert_eq!(
                preflight_read_tool_arguments("notion-fetch", &arguments)
                    .unwrap_err()
                    .code,
                "notion_fetch_identity_unsupported"
            );
        }
    }

    #[test]
    fn notion_fetch_allows_page_targets_and_nested_self_data() {
        for arguments in [
            serde_json::json!({ "id": "page-123" }),
            serde_json::json!({ "id": "https://notion.so/page-123" }),
            serde_json::json!({ "content": { "id": "self" } }),
            serde_json::json!({ "id": 123 }),
            serde_json::json!({}),
        ] {
            assert!(preflight_read_tool_arguments("notion-fetch", &arguments).is_ok());
        }
        assert!(preflight_read_tool_arguments(
            "notion-search",
            &serde_json::json!({ "id": "self" })
        )
        .is_ok());
    }

    #[test]
    fn create_and_update_reject_async_actions() {
        let create = serde_json::json!({
            "allow_async": true,
            "pages": [{ "title": "Async page" }]
        });
        let update = serde_json::json!({
            "allow_async": true,
            "page_id": "page-123",
            "title": "Async update"
        });

        assert_eq!(
            preflight_create_pages_arguments(&create).unwrap_err().code,
            "notion_async_actions_unsupported"
        );
        assert_eq!(
            preflight_update_page_arguments(&update).unwrap_err().code,
            "notion_async_actions_unsupported"
        );
    }

    #[test]
    fn update_page_rejects_destructive_fields() {
        for field in NOTION_DESTRUCTIVE_UPDATE_FIELDS {
            let arguments = serde_json::json!({
                "page_id": "page-123",
                (*field): true,
                "title": "Updated title"
            });

            assert_eq!(
                preflight_update_page_arguments(&arguments)
                    .unwrap_err()
                    .code,
                "notion_update_page_destructive_fields"
            );
        }
        assert_eq!(
            preflight_update_page_arguments(&serde_json::json!({
                "page_id": "page-123",
                "command": "replace_content",
                "new_str": "Replacement",
                "allow_deleting_content": true
            }))
            .unwrap_err()
            .code,
            "notion_update_page_deleting_content_unsupported"
        );
    }

    #[test]
    fn update_page_target_rejects_nested_or_alias_targets() {
        let nested_only = serde_json::json!({
            "content": { "page_id": "nested-page", "id": "nested-id" },
            "title": "Updated title"
        });
        let alias_only = serde_json::json!({
            "pageId": "camel-page",
            "title": "Updated title"
        });

        assert_eq!(update_page_target(&nested_only), None);
        assert_eq!(update_page_target(&alias_only), None);
        assert_eq!(
            preflight_update_page_arguments(&nested_only)
                .unwrap_err()
                .code,
            "notion_update_page_missing_target"
        );
        assert_eq!(
            preflight_update_page_arguments(&alias_only)
                .unwrap_err()
                .code,
            "notion_update_page_missing_target"
        );
    }

    fn stored_connection() -> StoredNotionConnection {
        StoredNotionConnection {
            access_token: "access".to_string(),
            refresh_token: Some("refresh".to_string()),
            expires_at_unix: Some(900),
            client_id: "client".to_string(),
            client_secret: Some("secret".to_string()),
            endpoint: MCP_ENDPOINT.to_string(),
            registration_redirect_uri: Some("http://127.0.0.1:49152/callback".to_string()),
        }
    }

    #[test]
    fn filters_provider_tools_through_canonical_allowlist() {
        let tools = vec![
            NotionMcpTool {
                name: "notion-update-page".to_string(),
                description: Some("Update".to_string()),
                input_schema: object_schema(),
            },
            NotionMcpTool {
                name: "notion-update-page".to_string(),
                description: Some("Duplicate".to_string()),
                input_schema: object_schema(),
            },
            NotionMcpTool {
                name: "notion-move-pages".to_string(),
                description: Some("Move".to_string()),
                input_schema: object_schema(),
            },
        ];

        let filtered = filter_allowed_tools(tools, action_tool_allowed_for_hermes);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "notion-update-page");
    }

    fn object_schema() -> serde_json::Map<String, serde_json::Value> {
        serde_json::json!({"type": "object"})
            .as_object()
            .cloned()
            .expect("object schema")
    }

    #[test]
    fn hosted_tool_validation_rejects_invalid_name_or_schema() {
        assert!(parse_hosted_tool(&serde_json::json!({
            "name": "",
            "description": "Update a page",
            "inputSchema": { "type": "object" },
        }))
        .is_none());
        assert!(parse_hosted_tool(&serde_json::json!({
            "name": "notion-update-page",
            "description": "Update a page",
            "inputSchema": null,
        }))
        .is_none());
        assert!(parse_hosted_tool(&serde_json::json!({
            "name": "notion-update-page",
            "description": "Update a page",
            "inputSchema": ["not", "an", "object"],
        }))
        .is_none());
    }

    #[test]
    fn hosted_tool_serializes_input_schema_as_mcp_field() {
        let tool = parse_hosted_tool(&serde_json::json!({
            "name": " notion-update-page ",
            "description": "Update a page",
            "inputSchema": { "type": "object" },
        }))
        .expect("valid hosted tool");
        let value = serde_json::to_value(&tool).expect("serialize tool");

        assert_eq!(tool.name, "notion-update-page");
        assert!(value.get("inputSchema").is_some());
        assert!(value.get("input_schema").is_none());
    }

    #[test]
    fn oversized_provider_schema_is_rejected() {
        let oversized = "x".repeat(MCP_TOOL_SCHEMA_MAX_BYTES + 1);
        let tool = serde_json::json!({
            "name": "notion-update-page",
            "description": "Update a page",
            "inputSchema": {
                "type": "object",
                "description": oversized,
            },
        });
        assert!(parse_hosted_tool(&tool).is_none());
    }
}
