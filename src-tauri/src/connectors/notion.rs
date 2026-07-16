//! Notion hosted MCP connector preview.
//!
//! This module owns Notion's hosted MCP OAuth flow plus a read-only hosted MCP
//! bridge for the `june_notion` Hermes toolset. Write/action tools stay denied;
//! selected-resource scoping is not verified in this preview. See ADR 0025.

use crate::domain::types::AppError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{sync::OnceLock, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
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
const NOTION_ACCOUNT_EMAIL: &str = "Notion hosted MCP preview";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(300);
const SOCKET_READ_TIMEOUT: Duration = Duration::from_secs(5);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const MCP_RESPONSE_MAX_BYTES: usize = 512 * 1024;
const MCP_SESSION_ID_HEADER: &str = "mcp-session-id";
const NOTION_READ_TOOL_ALLOWLIST: &[&str] = &[
    "notion-search",
    "notion-fetch",
    "notion-query-data-sources",
    "notion-query-database-view",
    "notion-get-comments",
];

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(HTTP_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .user_agent("os-june/0.1 notion-hosted-mcp-preview")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
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
    #[serde(rename = "inputSchema")]
    pub input_schema: serde_json::Value,
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
}

#[derive(Deserialize)]
struct TokenErrorBody {
    #[serde(default)]
    error: Option<String>,
}

pub async fn status() -> Result<NotionConnectionStatus, AppError> {
    let stored = store::load().await?;
    Ok(NotionConnectionStatus {
        connected: stored.is_some(),
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

pub async fn connect(flow: &NotionConnectFlow) -> Result<NotionConnection, AppError> {
    let (resource, auth_server) = discover_and_validate().await?;
    let (verifier, challenge) = pkce();
    let csrf = random_b64url(24);

    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| {
        AppError::new(
            "notion_loopback_bind_failed",
            format!("Could not start the local Notion connect listener: {e}"),
        )
    })?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::new("notion_loopback_bind_failed", e.to_string()))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let registration = register_client(&auth_server, &redirect_uri).await?;
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
    };
    store::store(&stored).await?;
    if let Err(error) = verify_hosted_mcp_discovery(&stored.access_token).await {
        let _ = store::delete().await;
        return Err(error);
    }
    Ok(connection())
}

pub async fn disconnect() -> Result<(), AppError> {
    store::delete().await
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

pub async fn list_tools() -> Result<NotionToolInventory, AppError> {
    let stored = load_connected().await?;
    let client = McpHttpClient::new(stored.access_token.clone());
    client.initialize().await?;
    let (tools, bytes) = client.tools_list().await?;
    Ok(NotionToolInventory {
        endpoint: MCP_ENDPOINT.to_string(),
        protocol_version: MCP_PROTOCOL_VERSION.to_string(),
        tool_count: tools.len(),
        tools,
        session_established: client.session_id().is_some(),
        inventory_bytes: bytes,
    })
}

pub async fn mcp_tool_list() -> Result<NotionMcpToolList, AppError> {
    let stored = load_connected().await?;
    let client = McpHttpClient::new(stored.access_token.clone());
    client.initialize().await?;
    let tools = client.hosted_tools_list().await?;
    Ok(NotionMcpToolList {
        tools: tools
            .into_iter()
            .filter(|tool| tool_allowed_for_hermes(&tool.name))
            .collect(),
    })
}

pub async fn call_hosted_tool(
    request: NotionHostedToolCallRequest,
) -> Result<NotionHostedToolCallResult, AppError> {
    let tool_name = request.tool_name.trim();
    if !tool_allowed_for_hermes(tool_name) {
        return Err(AppError::new(
            "notion_tool_not_allowed",
            "That Notion hosted MCP tool is not enabled in June yet.",
        ));
    }
    let stored = load_connected().await?;
    let client = McpHttpClient::new(stored.access_token.clone());
    client.initialize().await?;
    let result = client.call_tool(tool_name, request.arguments).await?;
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

fn connection() -> NotionConnection {
    NotionConnection {
        account_id: NOTION_ACCOUNT_ID.to_string(),
        endpoint: MCP_ENDPOINT.to_string(),
        preview: true,
        selected_resource_scoping_verified: false,
    }
}

async fn discover_and_validate() -> Result<(ResourceMetadata, AuthorizationServerMetadata), AppError> {
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

    let auth_server = get_json::<AuthorizationServerMetadata>(
        AUTHORIZATION_SERVER_METADATA_ENDPOINT,
    )
    .await?;
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
    let response = http_client()
        .get(url)
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

async fn register_client(
    auth_server: &AuthorizationServerMetadata,
    redirect_uri: &str,
) -> Result<RegistrationResponse, AppError> {
    let endpoint = auth_server
        .registration_endpoint
        .as_deref()
        .ok_or_else(metadata_error)?;
    let response = http_client()
        .post(endpoint)
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
    let registration = serde_json::from_str::<RegistrationResponse>(&body)
        .map_err(|_| registration_failed())?;
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
    let response = http_client()
        .post(&auth_server.token_endpoint)
        .form(&form)
        .send()
        .await
        .map_err(|_| token_exchange_failed(None))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| token_exchange_failed(None))?;
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
        self.session_id
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
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
        self
            .post_json(serde_json::json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
                "params": {},
            }))
            .await?;
        Ok(())
    }

    async fn tools_list(&self) -> Result<(Vec<NotionToolSummary>, usize), AppError> {
        let (tools, value, bytes) = self.hosted_tools_list_with_value().await?;
        let summaries = tools.into_iter().map(|tool| summarize_tool(&tool)).collect();
        let inventory_bytes = serde_json::to_vec(&value).map(|body| body.len()).unwrap_or(bytes);
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
        let bytes = serde_json::to_vec(&value).map(|body| body.len()).unwrap_or(0);
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
        let mut request = http_client()
            .post(MCP_ENDPOINT)
            .bearer_auth(&self.access_token)
            .header("accept", "application/json, text/event-stream")
            .header("content-type", "application/json")
            .header("mcp-protocol-version", MCP_PROTOCOL_VERSION)
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
            tracing::warn!(status = response.status().as_u16(), "notion MCP request failed");
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
    let name = value.get("name")?.as_str()?.to_string();
    let description = value
        .get("description")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|description| !description.is_empty())
        .map(truncate_description);
    let input_schema = value
        .get("inputSchema")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({ "type": "object", "properties": {} }));
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
    const MAX_DESCRIPTION_CHARS: usize = 240;
    let mut truncated: String = description.chars().take(MAX_DESCRIPTION_CHARS).collect();
    if description.chars().count() > MAX_DESCRIPTION_CHARS {
        truncated.push_str("...");
    }
    truncated
}

fn tool_allowed_for_hermes(name: &str) -> bool {
    NOTION_READ_TOOL_ALLOWLIST
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(name))
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
                Err(e) => Err(AppError::new("notion_keychain_delete_failed", e.to_string())),
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

    #[test]
    fn connection_status_defaults_to_preview_unverified() {
        let connection = connection();
        assert_eq!(connection.account_id, "notion-hosted-mcp");
        assert!(connection.preview);
        assert!(!connection.selected_resource_scoping_verified);
    }
}
