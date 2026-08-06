//! Host-owned MCP server registry for the Clovy agent harness.
//!
//! This module deliberately keeps server configuration and MCP transport out
//! of the TypeScript sidecar. SQLite stores only non-secret connection data;
//! environment values and HTTP headers are held as one opaque bundle in the
//! operating system keychain. The sidecar receives compiled function-tool
//! descriptors and invokes an opaque capability id through Rust.
//!
//! The module is intentionally not registered from `lib.rs` yet. The runtime
//! cutover wires its schema bootstrap and `AgentMcpSubsystem` at one boundary.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlx::{query::query, row::Row};
use sqlx_sqlite::SqlitePool;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    future::Future,
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::AppHandle;
use thiserror::Error;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex as AsyncMutex,
    time::timeout,
};
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop};

pub const AGENT_MCP_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS agent_mcp_servers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL,
  transport TEXT NOT NULL,
  command TEXT,
  args_json TEXT NOT NULL,
  url TEXT,
  secret_ref TEXT,
  metadata_json TEXT NOT NULL,
  tool_visibility_json TEXT NOT NULL,
  safety_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_mcp_servers_enabled
  ON agent_mcp_servers(enabled, name);
"#;

pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 1_048_576;
const KEYCHAIN_SERVICE: &str = "co.opensoftware.clovy.agent-mcp";
const DEV_KEYCHAIN_SERVICE: &str = "co.opensoftware.clovy-dev.agent-mcp";
const LEGACY_KEYCHAIN_SERVICE: &str = "co.opensoftware.june.agent-mcp";
const LEGACY_DEV_KEYCHAIN_SERVICE: &str = "co.opensoftware.june-dev.agent-mcp";
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const OAUTH_CONNECT_TIMEOUT: Duration = Duration::from_secs(300);
const OAUTH_HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const OAUTH_EXPIRY_BUFFER_SECS: i64 = 60;
pub const MANAGED_LINEAR_SERVER_ID: &str = "builtin:linear";
pub const MANAGED_LINEAR_SERVER_NAME: &str = "linear";
pub const MANAGED_LINEAR_MCP_URL: &str = "https://mcp.linear.app/mcp";
const MANAGED_LINEAR_POLICY_REVISION: &str = "linear-official-mcp-v1";
const MANAGED_MCP_TOOL_SCHEMA_MAX_BYTES: usize = 64 * 1024;
const MANAGED_MCP_TOOL_ANNOTATIONS_MAX_BYTES: usize = 64 * 1024;
const MANAGED_MCP_DESCRIPTION_MAX_CHARS: usize = 240;
const MANAGED_MCP_TOOL_NAME_MAX_CHARS: usize = 128;
const MANAGED_MCP_DISCOVERY_MAX_PAGES: usize = 20;
const MANAGED_MCP_DISCOVERY_MAX_TOOLS: usize = 512;
const MANAGED_MCP_DISCOVERY_MAX_BYTES: usize = 4 * 1024 * 1024;
const MANAGED_MCP_CURSOR_MAX_CHARS: usize = 2_048;

type SharedMcpSession = Arc<AsyncMutex<McpSessionSlot>>;
static MCP_SESSIONS: OnceLock<AsyncMutex<HashMap<String, SharedMcpSession>>> = OnceLock::new();

struct McpSessionSlot {
    fingerprint: String,
    next_request_id: u64,
    transport: Option<PersistentMcpTransport>,
    discovery_pages: BTreeMap<String, Value>,
}

enum PersistentMcpTransport {
    Stdio(Box<StdioMcpSession>),
    Http(Box<HttpMcpSession>),
}

struct StdioMcpSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    pending: Option<PendingStdioRequest>,
}

struct HttpMcpSession {
    client: reqwest::Client,
    session_id: Option<String>,
    pending: Option<PendingHttpRequest>,
}

struct PendingStdioRequest {
    request_id: u64,
    elicitation: Value,
    consumed: usize,
}

struct PendingHttpRequest {
    request_id: u64,
    elicitation: Value,
    response: reqwest::Response,
    bytes: Vec<u8>,
    session_id: Option<String>,
}

#[derive(Debug, Error)]
pub enum AgentMcpError {
    #[error("MCP server definition is invalid: {0}")]
    InvalidDefinition(String),
    #[error("MCP server already exists")]
    DuplicateServer,
    #[error("MCP server was not found")]
    NotFound,
    #[error("MCP tool is not available for this server")]
    ToolUnavailable,
    #[error("MCP response exceeded Clovy's safety limit")]
    OutputTooLarge,
    #[error("MCP operation timed out")]
    TimedOut,
    #[error("MCP server returned an invalid protocol response")]
    Protocol,
    #[error("MCP secure storage is unavailable on this platform")]
    SecureStorageUnavailable,
    #[error("MCP secure storage operation failed")]
    SecureStorage,
    #[error("MCP storage operation failed")]
    Storage,
    #[error("MCP transport operation failed")]
    Transport,
    #[error("MCP authorization was rejected")]
    Unauthorized,
    #[error("MCP authorization has expired. Reconnect this server in Settings.")]
    OauthReconnectRequired,
    #[error("MCP server requested user input: {0}")]
    ElicitationRequired(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpTransport {
    Stdio,
    StreamableHttp,
}

impl McpTransport {
    fn as_db(self) -> &'static str {
        match self {
            Self::Stdio => "stdio",
            Self::StreamableHttp => "streamable_http",
        }
    }

    fn from_db(value: &str) -> Result<Self, AgentMcpError> {
        match value {
            "stdio" => Ok(Self::Stdio),
            "streamable_http" => Ok(Self::StreamableHttp),
            _ => Err(AgentMcpError::Storage),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpToolVisibility {
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
}

impl McpToolVisibility {
    pub fn allows(&self, tool_name: &str) -> bool {
        !self.exclude.iter().any(|name| name == tool_name)
            && (self.include.is_empty() || self.include.iter().any(|name| name == tool_name))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSafetyPolicy {
    #[serde(default)]
    pub requires_approval: bool,
    #[serde(default = "default_allow_sandboxed")]
    pub allow_sandboxed: bool,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_max_output_bytes")]
    pub max_output_bytes: usize,
    /// Tool ids that always need approval even when the server is normally
    /// read-only. This is host policy, not untrusted server metadata.
    #[serde(default)]
    pub approval_tools: Vec<String>,
}

impl Default for McpSafetyPolicy {
    fn default() -> Self {
        Self {
            requires_approval: true,
            allow_sandboxed: true,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            approval_tools: Vec::new(),
        }
    }
}

fn default_allow_sandboxed() -> bool {
    true
}
fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}
fn default_max_output_bytes() -> usize {
    DEFAULT_MAX_OUTPUT_BYTES
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerDefinition {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub transport: McpTransport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Opaque keychain account id. It is never a bearer token, header value,
    /// or environment value and is safe to persist in SQLite.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<String>,
    #[serde(default)]
    pub metadata: Value,
    #[serde(default)]
    pub tool_visibility: McpToolVisibility,
    #[serde(default)]
    pub safety: McpSafetyPolicy,
}

impl McpServerDefinition {
    pub fn new(name: impl Into<String>, transport: McpTransport) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            enabled: true,
            transport,
            command: None,
            args: Vec::new(),
            url: None,
            secret_ref: None,
            metadata: Value::Object(Map::new()),
            tool_visibility: McpToolVisibility::default(),
            safety: McpSafetyPolicy::default(),
        }
    }

    pub fn validate(&self) -> Result<(), AgentMcpError> {
        let name = self.name.trim();
        if name.is_empty()
            || name.len() > 64
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'))
        {
            return Err(AgentMcpError::InvalidDefinition(
                "server name may use ASCII letters, numbers, spaces, periods, underscores, and hyphens"
                    .into(),
            ));
        }
        if self.id.trim().is_empty() {
            return Err(AgentMcpError::InvalidDefinition(
                "server id is required".into(),
            ));
        }
        if self.safety.timeout_ms == 0 || self.safety.timeout_ms > 600_000 {
            return Err(AgentMcpError::InvalidDefinition(
                "timeout must be between 1 ms and 10 minutes".into(),
            ));
        }
        if self.safety.max_output_bytes == 0
            || self.safety.max_output_bytes > DEFAULT_MAX_OUTPUT_BYTES
        {
            return Err(AgentMcpError::InvalidDefinition(
                "output limit must be between 1 byte and 1 MB".into(),
            ));
        }
        match self.transport {
            McpTransport::Stdio => {
                if self.command.as_deref().map(str::is_empty).unwrap_or(true) || self.url.is_some()
                {
                    return Err(AgentMcpError::InvalidDefinition(
                        "stdio servers require command and forbid url".into(),
                    ));
                }
                if self.args.iter().any(|arg| arg.contains(['\n', '\r', '\0'])) {
                    return Err(AgentMcpError::InvalidDefinition(
                        "stdio args may not contain control separators".into(),
                    ));
                }
            }
            McpTransport::StreamableHttp => {
                let url = self.url.as_deref().ok_or_else(|| {
                    AgentMcpError::InvalidDefinition("HTTP servers require url".into())
                })?;
                let parsed = url::Url::parse(url)
                    .map_err(|_| AgentMcpError::InvalidDefinition("HTTP url is invalid".into()))?;
                let secure_transport = parsed.scheme() == "https"
                    || (parsed.scheme() == "http"
                        && parsed
                            .host_str()
                            .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "::1")));
                if !secure_transport || self.command.is_some() || !self.args.is_empty() {
                    return Err(AgentMcpError::InvalidDefinition(
                        "streamable HTTP requires HTTPS or a loopback HTTP url".into(),
                    ));
                }
            }
        }
        Ok(())
    }

    fn validate_custom(&self) -> Result<(), AgentMcpError> {
        self.validate()?;
        self.validate_custom_id()
    }

    fn validate_custom_id(&self) -> Result<(), AgentMcpError> {
        if self.id.trim() == MANAGED_LINEAR_SERVER_ID {
            return Err(AgentMcpError::InvalidDefinition(
                "server id is reserved for managed Linear".into(),
            ));
        }
        Ok(())
    }
}

/// Values held only in keychain. `env` is supplied to a stdio process and
/// `headers` only to the configured HTTP origin. Neither is serialized with a
/// [`McpServerDefinition`] or placed in runtime tool descriptors.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpSecretBundle {
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// Legacy OAuth client configuration is retained only for recovery.
    /// The Clovy-owned runtime does not consume it until a first-party OAuth
    /// flow can replace the retired Hermes token cache safely.
    #[serde(default)]
    pub oauth: BTreeMap<String, String>,
}

impl std::fmt::Debug for McpSecretBundle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("McpSecretBundle")
            .field("env_keys", &self.env.keys().collect::<Vec<_>>())
            .field("header_keys", &self.headers.keys().collect::<Vec<_>>())
            .field("oauth_keys", &self.oauth.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl Drop for McpSecretBundle {
    fn drop(&mut self) {
        for value in self.env.values_mut() {
            value.zeroize();
        }
        for value in self.headers.values_mut() {
            value.zeroize();
        }
        for value in self.oauth.values_mut() {
            value.zeroize();
        }
    }
}

pub trait McpSecretStore: Send + Sync {
    fn put(&self, secret_ref: &str, bundle: &McpSecretBundle) -> Result<(), AgentMcpError>;
    fn get(&self, secret_ref: &str) -> Result<Option<McpSecretBundle>, AgentMcpError>;
    fn delete(&self, secret_ref: &str) -> Result<(), AgentMcpError>;
}

pub struct KeychainMcpSecretStore;

impl McpSecretStore for KeychainMcpSecretStore {
    fn put(&self, secret_ref: &str, bundle: &McpSecretBundle) -> Result<(), AgentMcpError> {
        let raw = serde_json::to_string(bundle).map_err(|_| AgentMcpError::SecureStorage)?;
        platform_keychain_put(keychain_services(), secret_ref, raw)
    }
    fn get(&self, secret_ref: &str) -> Result<Option<McpSecretBundle>, AgentMcpError> {
        let Some(raw) = platform_keychain_get(keychain_services(), secret_ref)? else {
            return Ok(None);
        };
        serde_json::from_str(&raw)
            .map(Some)
            .map_err(|_| AgentMcpError::SecureStorage)
    }
    fn delete(&self, secret_ref: &str) -> Result<(), AgentMcpError> {
        platform_keychain_delete(keychain_services(), secret_ref)
    }
}

#[derive(Debug, Deserialize)]
struct OAuthResourceMetadata {
    resource: String,
    #[serde(default)]
    authorization_servers: Vec<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthAuthorizationServerMetadata {
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
    code_challenge_methods_supported: Vec<String>,
}

#[derive(Debug, Serialize)]
struct OAuthRegistrationRequest<'a> {
    client_name: &'a str,
    redirect_uris: Vec<&'a str>,
    grant_types: Vec<&'a str>,
    response_types: Vec<&'a str>,
    token_endpoint_auth_method: &'a str,
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
struct OAuthRegistrationResponse {
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
struct OAuthTokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[zeroize(skip)]
    #[serde(default)]
    expires_in: Option<i64>,
    #[zeroize(skip)]
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Deserialize)]
struct OAuthTokenError {
    #[serde(default)]
    error: Option<String>,
}

fn oauth_now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn secure_oauth_url(raw: &str) -> Result<reqwest::Url, AgentMcpError> {
    let parsed = reqwest::Url::parse(raw).map_err(|_| AgentMcpError::Protocol)?;
    let secure = parsed.scheme() == "https"
        || (parsed.scheme() == "http"
            && parsed
                .host_str()
                .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "::1")));
    if !secure
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.host_str().is_none()
    {
        return Err(AgentMcpError::Protocol);
    }
    Ok(parsed)
}

fn protected_resource_metadata_urls(
    resource: &reqwest::Url,
) -> Result<Vec<reqwest::Url>, AgentMcpError> {
    let origin = format!(
        "{}://{}{}",
        resource.scheme(),
        resource.host_str().ok_or(AgentMcpError::Protocol)?,
        resource
            .port()
            .map(|port| format!(":{port}"))
            .unwrap_or_default()
    );
    let mut paths = Vec::new();
    let resource_path = resource.path().trim_start_matches('/');
    if !resource_path.is_empty() {
        paths.push(format!(
            "{origin}/.well-known/oauth-protected-resource/{resource_path}"
        ));
    }
    paths.push(format!("{origin}/.well-known/oauth-protected-resource"));
    paths
        .into_iter()
        .map(|value| reqwest::Url::parse(&value).map_err(|_| AgentMcpError::Protocol))
        .collect()
}

fn authorization_server_metadata_urls(
    issuer: &reqwest::Url,
) -> Result<Vec<reqwest::Url>, AgentMcpError> {
    let origin = format!(
        "{}://{}{}",
        issuer.scheme(),
        issuer.host_str().ok_or(AgentMcpError::Protocol)?,
        issuer
            .port()
            .map(|port| format!(":{port}"))
            .unwrap_or_default()
    );
    let issuer_path = issuer.path().trim_matches('/');
    let suffix = if issuer_path.is_empty() {
        String::new()
    } else {
        format!("/{issuer_path}")
    };
    [
        format!("{origin}/.well-known/oauth-authorization-server{suffix}"),
        format!("{origin}/.well-known/openid-configuration{suffix}"),
    ]
    .into_iter()
    .map(|value| reqwest::Url::parse(&value).map_err(|_| AgentMcpError::Protocol))
    .collect()
}

async fn get_first_oauth_metadata<T: for<'de> Deserialize<'de>>(
    client: &reqwest::Client,
    urls: Vec<reqwest::Url>,
) -> Result<T, AgentMcpError> {
    for url in urls {
        let Ok(response) = client.get(url).timeout(OAUTH_HTTP_TIMEOUT).send().await else {
            continue;
        };
        if response.status().is_success() {
            if let Ok(metadata) = response.json::<T>().await {
                return Ok(metadata);
            }
        }
    }
    Err(AgentMcpError::Protocol)
}

fn resource_metadata_from_challenge(value: &str) -> Option<&str> {
    let marker = "resource_metadata=";
    let start = value.find(marker)? + marker.len();
    let remainder = value[start..].trim_start();
    if let Some(quoted) = remainder.strip_prefix('"') {
        return quoted.split_once('"').map(|(url, _)| url);
    }
    Some(
        remainder
            .split([',', ' '])
            .next()
            .unwrap_or_default()
            .trim(),
    )
    .filter(|value| !value.is_empty())
}

async fn challenge_resource_metadata_url(
    client: &reqwest::Client,
    resource_url: &reqwest::Url,
) -> Result<reqwest::Url, AgentMcpError> {
    let response = client
        .post(resource_url.clone())
        .timeout(OAUTH_HTTP_TIMEOUT)
        .header("accept", "application/json, text/event-stream")
        .header("content-type", "application/json")
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": initialize_params()
        }))
        .send()
        .await
        .map_err(|_| AgentMcpError::Transport)?;
    let advertised = response
        .headers()
        .get_all(reqwest::header::WWW_AUTHENTICATE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(resource_metadata_from_challenge)
        .ok_or(AgentMcpError::Protocol)
        .and_then(secure_oauth_url)?;
    if advertised.origin() != resource_url.origin() {
        return Err(AgentMcpError::Protocol);
    }
    Ok(advertised)
}

async fn discover_oauth_metadata(
    endpoint: &str,
) -> Result<(OAuthResourceMetadata, OAuthAuthorizationServerMetadata), AgentMcpError> {
    let resource_url = secure_oauth_url(endpoint)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| AgentMcpError::Transport)?;
    let resource = match get_first_oauth_metadata::<OAuthResourceMetadata>(
        &client,
        protected_resource_metadata_urls(&resource_url)?,
    )
    .await
    {
        Ok(metadata) => metadata,
        Err(_) => {
            let advertised = challenge_resource_metadata_url(&client, &resource_url).await?;
            get_first_oauth_metadata::<OAuthResourceMetadata>(&client, vec![advertised]).await?
        }
    };
    let declared_resource = secure_oauth_url(&resource.resource)?;
    if declared_resource.origin() != resource_url.origin() {
        return Err(AgentMcpError::Protocol);
    }
    let issuer = resource
        .authorization_servers
        .first()
        .ok_or(AgentMcpError::Protocol)
        .and_then(|value| secure_oauth_url(value))?;
    let auth = get_first_oauth_metadata::<OAuthAuthorizationServerMetadata>(
        &client,
        authorization_server_metadata_urls(&issuer)?,
    )
    .await?;
    if secure_oauth_url(&auth.issuer)? != issuer
        || secure_oauth_url(&auth.authorization_endpoint).is_err()
        || secure_oauth_url(&auth.token_endpoint).is_err()
        || !auth
            .response_types_supported
            .iter()
            .any(|value| value == "code")
        || (!auth.grant_types_supported.is_empty()
            && !auth
                .grant_types_supported
                .iter()
                .any(|value| value == "authorization_code"))
        || !auth
            .code_challenge_methods_supported
            .iter()
            .any(|value| value == "S256")
    {
        return Err(AgentMcpError::Protocol);
    }
    if let Some(registration_endpoint) = auth.registration_endpoint.as_deref() {
        secure_oauth_url(registration_endpoint)?;
    }
    Ok((resource, auth))
}

async fn register_oauth_client(
    auth: &OAuthAuthorizationServerMetadata,
    redirect_uri: &str,
) -> Result<OAuthRegistrationResponse, AgentMcpError> {
    let endpoint = auth
        .registration_endpoint
        .as_deref()
        .ok_or(AgentMcpError::Protocol)?;
    let response = reqwest::Client::new()
        .post(endpoint)
        .timeout(OAUTH_HTTP_TIMEOUT)
        .json(&OAuthRegistrationRequest {
            client_name: "Clovy",
            redirect_uris: vec![redirect_uri],
            grant_types: vec!["authorization_code", "refresh_token"],
            response_types: vec!["code"],
            token_endpoint_auth_method: "none",
        })
        .send()
        .await
        .map_err(|_| AgentMcpError::Transport)?;
    if !response.status().is_success() {
        return Err(AgentMcpError::Protocol);
    }
    let registration = response
        .json::<OAuthRegistrationResponse>()
        .await
        .map_err(|_| AgentMcpError::Protocol)?;
    if registration.client_id.trim().is_empty() {
        return Err(AgentMcpError::Protocol);
    }
    Ok(registration)
}

fn oauth_authorization_url(
    auth: &OAuthAuthorizationServerMetadata,
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
    resource: &str,
    scope: &str,
) -> Result<String, AgentMcpError> {
    let mut url = secure_oauth_url(&auth.authorization_endpoint)?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", state)
            .append_pair("resource", resource);
        if !scope.is_empty() {
            query.append_pair("scope", scope);
        }
    }
    Ok(url.to_string())
}

async fn exchange_oauth_code(
    auth: &OAuthAuthorizationServerMetadata,
    client_id: &str,
    client_secret: Option<&str>,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
    resource: &str,
) -> Result<OAuthTokenResponse, AgentMcpError> {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("code_verifier", verifier),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("resource", resource),
    ];
    if let Some(secret) = client_secret.filter(|value| !value.is_empty()) {
        form.push(("client_secret", secret));
    }
    let response = reqwest::Client::new()
        .post(&auth.token_endpoint)
        .timeout(OAUTH_HTTP_TIMEOUT)
        .form(&form)
        .send()
        .await
        .map_err(|_| AgentMcpError::Transport)?;
    if !response.status().is_success() {
        return Err(AgentMcpError::Protocol);
    }
    let tokens = response
        .json::<OAuthTokenResponse>()
        .await
        .map_err(|_| AgentMcpError::Protocol)?;
    if tokens.access_token.trim().is_empty() {
        return Err(AgentMcpError::Protocol);
    }
    Ok(tokens)
}

async fn authorize_oauth_server(
    server: &McpServerDefinition,
    existing: &McpSecretBundle,
) -> Result<McpSecretBundle, AgentMcpError> {
    if server.transport != McpTransport::StreamableHttp {
        return Err(AgentMcpError::InvalidDefinition(
            "OAuth is available only for Streamable HTTP servers".into(),
        ));
    }
    let endpoint = server.url.as_deref().ok_or(AgentMcpError::Protocol)?;
    let (resource, auth) = discover_oauth_metadata(endpoint).await?;
    let saved_port = existing
        .oauth
        .get("redirect_uri")
        .and_then(|value| reqwest::Url::parse(value).ok())
        .filter(|url| {
            url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.path() == "/callback"
                && url.query().is_none()
                && url.fragment().is_none()
        })
        .and_then(|url| url.port());
    let (listener, can_reuse_registration) = if let Some(port) = saved_port {
        match crate::connectors::oauth::bind_loopback(
            &crate::connectors::oauth::LoopbackPort::Candidates(vec![port]),
        )
        .await
        {
            Ok(listener) => (listener, true),
            Err(_) => (
                crate::connectors::oauth::bind_loopback(
                    &crate::connectors::oauth::LoopbackPort::Ephemeral,
                )
                .await
                .map_err(|_| AgentMcpError::Transport)?,
                false,
            ),
        }
    } else {
        (
            crate::connectors::oauth::bind_loopback(
                &crate::connectors::oauth::LoopbackPort::Ephemeral,
            )
            .await
            .map_err(|_| AgentMcpError::Transport)?,
            false,
        )
    };
    let port = listener
        .local_addr()
        .map_err(|_| AgentMcpError::Transport)?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let registration = match existing.oauth.get("client_id") {
        Some(client_id) if can_reuse_registration && !client_id.trim().is_empty() => {
            OAuthRegistrationResponse {
                client_id: client_id.clone(),
                client_secret: existing.oauth.get("client_secret").cloned(),
            }
        }
        _ => register_oauth_client(&auth, &redirect_uri).await?,
    };
    let (verifier, challenge) = crate::connectors::oauth::pkce();
    let state = crate::connectors::oauth::random_b64url(24);
    let scope = existing
        .oauth
        .get("scope")
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| resource.scopes_supported.join(" "));
    let authorization_url = oauth_authorization_url(
        &auth,
        &registration.client_id,
        &redirect_uri,
        &challenge,
        &state,
        &resource.resource,
        &scope,
    )?;
    crate::os_accounts::open_in_browser(&authorization_url)
        .map_err(|_| AgentMcpError::Transport)?;
    let code = timeout(
        OAUTH_CONNECT_TIMEOUT,
        crate::connectors::oauth::await_callback(&listener, &state, &server.name),
    )
    .await
    .map_err(|_| AgentMcpError::TimedOut)?
    .map_err(|_| AgentMcpError::Protocol)?;
    let tokens = exchange_oauth_code(
        &auth,
        &registration.client_id,
        registration.client_secret.as_deref(),
        &code,
        &verifier,
        &redirect_uri,
        &resource.resource,
    )
    .await?;
    let mut bundle = existing.clone();
    bundle
        .oauth
        .insert("access_token".into(), tokens.access_token.clone());
    if let Some(refresh_token) = tokens.refresh_token.as_ref() {
        bundle
            .oauth
            .insert("refresh_token".into(), refresh_token.clone());
    }
    bundle
        .oauth
        .insert("client_id".into(), registration.client_id.clone());
    if let Some(client_secret) = registration.client_secret.as_ref() {
        bundle
            .oauth
            .insert("client_secret".into(), client_secret.clone());
    }
    bundle
        .oauth
        .insert("token_endpoint".into(), auth.token_endpoint.clone());
    bundle.oauth.insert(
        "authorization_endpoint".into(),
        auth.authorization_endpoint.clone(),
    );
    bundle
        .oauth
        .insert("resource".into(), resource.resource.clone());
    bundle.oauth.insert("redirect_uri".into(), redirect_uri);
    if let Some(expires_in) = tokens.expires_in {
        bundle.oauth.insert(
            "expires_at_unix".into(),
            (oauth_now_unix() + expires_in.max(0)).to_string(),
        );
    } else {
        bundle.oauth.remove("expires_at_unix");
    }
    if let Some(granted_scope) = tokens.scope.as_ref() {
        bundle.oauth.insert("scope".into(), granted_scope.clone());
    } else if !scope.is_empty() {
        bundle.oauth.insert("scope".into(), scope);
    }
    Ok(bundle)
}

async fn refresh_oauth_bundle(
    bundle: &mut McpSecretBundle,
    force: bool,
) -> Result<bool, AgentMcpError> {
    let Some(refresh_token) = bundle.oauth.get("refresh_token").cloned() else {
        return if force {
            Err(AgentMcpError::OauthReconnectRequired)
        } else {
            Ok(false)
        };
    };
    let should_refresh = force
        || bundle
            .oauth
            .get("expires_at_unix")
            .and_then(|value| value.parse::<i64>().ok())
            .is_some_and(|expires| expires <= oauth_now_unix() + OAUTH_EXPIRY_BUFFER_SECS);
    if !should_refresh {
        return Ok(false);
    }
    let token_endpoint = bundle
        .oauth
        .get("token_endpoint")
        .ok_or(AgentMcpError::Protocol)
        .and_then(|value| secure_oauth_url(value))?;
    let client_id = bundle
        .oauth
        .get("client_id")
        .filter(|value| !value.trim().is_empty())
        .ok_or(AgentMcpError::Protocol)?;
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.as_str()),
        ("client_id", client_id.as_str()),
    ];
    if let Some(resource) = bundle.oauth.get("resource") {
        form.push(("resource", resource.as_str()));
    }
    if let Some(client_secret) = bundle.oauth.get("client_secret") {
        form.push(("client_secret", client_secret.as_str()));
    }
    let response = reqwest::Client::new()
        .post(token_endpoint)
        .timeout(OAUTH_HTTP_TIMEOUT)
        .form(&form)
        .send()
        .await
        .map_err(|_| AgentMcpError::Transport)?;
    if !response.status().is_success() {
        let invalid_grant = response
            .json::<OAuthTokenError>()
            .await
            .ok()
            .and_then(|body| body.error)
            .is_some_and(|error| error == "invalid_grant");
        return if invalid_grant {
            Err(AgentMcpError::OauthReconnectRequired)
        } else {
            Err(AgentMcpError::Protocol)
        };
    }
    let tokens = response
        .json::<OAuthTokenResponse>()
        .await
        .map_err(|_| AgentMcpError::Protocol)?;
    if tokens.access_token.trim().is_empty() {
        return Err(AgentMcpError::Protocol);
    }
    bundle
        .oauth
        .insert("access_token".into(), tokens.access_token.clone());
    if let Some(rotated) = tokens.refresh_token.as_ref() {
        bundle.oauth.insert("refresh_token".into(), rotated.clone());
    }
    if let Some(expires_in) = tokens.expires_in {
        bundle.oauth.insert(
            "expires_at_unix".into(),
            (oauth_now_unix() + expires_in.max(0)).to_string(),
        );
    } else {
        bundle.oauth.remove("expires_at_unix");
    }
    if let Some(scope) = tokens.scope.as_ref() {
        bundle.oauth.insert("scope".into(), scope.clone());
    }
    Ok(true)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn platform_keychain_put(
    services: (String, String),
    secret_ref: &str,
    raw: String,
) -> Result<(), AgentMcpError> {
    crate::credential_compat::set_password(&services.0, &services.1, secret_ref, &raw)
        .map_err(|_| AgentMcpError::SecureStorage)
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_keychain_put(
    _services: (String, String),
    _secret_ref: &str,
    _raw: String,
) -> Result<(), AgentMcpError> {
    Err(AgentMcpError::SecureStorageUnavailable)
}
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn platform_keychain_get(
    services: (String, String),
    secret_ref: &str,
) -> Result<Option<String>, AgentMcpError> {
    crate::credential_compat::get_password(&services.0, &services.1, secret_ref)
        .map_err(|_| AgentMcpError::SecureStorage)
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_keychain_get(
    _services: (String, String),
    _secret_ref: &str,
) -> Result<Option<String>, AgentMcpError> {
    Ok(None)
}
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn platform_keychain_delete(
    services: (String, String),
    secret_ref: &str,
) -> Result<(), AgentMcpError> {
    crate::credential_compat::delete_password(&services.0, &services.1, secret_ref)
        .map_err(|_| AgentMcpError::SecureStorage)
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_keychain_delete(
    _services: (String, String),
    _secret_ref: &str,
) -> Result<(), AgentMcpError> {
    Ok(())
}
fn keychain_services() -> (String, String) {
    if cfg!(debug_assertions) {
        (
            DEV_KEYCHAIN_SERVICE.into(),
            LEGACY_DEV_KEYCHAIN_SERVICE.into(),
        )
    } else {
        (KEYCHAIN_SERVICE.into(), LEGACY_KEYCHAIN_SERVICE.into())
    }
}

#[derive(Clone)]
pub struct AgentMcpRepository {
    pool: SqlitePool,
}

impl AgentMcpRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
    pub async fn ensure_schema(&self) -> Result<(), AgentMcpError> {
        for statement in AGENT_MCP_SCHEMA_SQL
            .split(';')
            .map(str::trim)
            .filter(|sql| !sql.is_empty())
        {
            query(statement)
                .execute(&self.pool)
                .await
                .map_err(|_| AgentMcpError::Storage)?;
        }
        Ok(())
    }
    pub async fn create(&self, definition: &McpServerDefinition) -> Result<(), AgentMcpError> {
        definition.validate_custom()?;
        let now = now();
        let result = query("INSERT INTO agent_mcp_servers (id, name, enabled, transport, command, args_json, url, secret_ref, metadata_json, tool_visibility_json, safety_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(&definition.id).bind(definition.name.trim()).bind(definition.enabled as i64).bind(definition.transport.as_db())
            .bind(&definition.command).bind(json_text(&definition.args)?).bind(&definition.url).bind(&definition.secret_ref)
            .bind(json_text(&definition.metadata)?).bind(json_text(&definition.tool_visibility)?).bind(json_text(&definition.safety)?)
            .bind(&now).bind(&now).execute(&self.pool).await;
        match result {
            Ok(_) => Ok(()),
            Err(error) if error.to_string().contains("UNIQUE") => {
                Err(AgentMcpError::DuplicateServer)
            }
            Err(_) => Err(AgentMcpError::Storage),
        }
    }
    pub async fn replace(&self, definition: &McpServerDefinition) -> Result<(), AgentMcpError> {
        definition.validate_custom()?;
        let result = query("UPDATE agent_mcp_servers SET name = ?, enabled = ?, transport = ?, command = ?, args_json = ?, url = ?, secret_ref = ?, metadata_json = ?, tool_visibility_json = ?, safety_json = ?, updated_at = ? WHERE id = ?")
            .bind(definition.name.trim()).bind(definition.enabled as i64).bind(definition.transport.as_db()).bind(&definition.command)
            .bind(json_text(&definition.args)?).bind(&definition.url).bind(&definition.secret_ref).bind(json_text(&definition.metadata)?)
            .bind(json_text(&definition.tool_visibility)?).bind(json_text(&definition.safety)?).bind(now()).bind(&definition.id)
            .execute(&self.pool).await;
        match result {
            Ok(result) if result.rows_affected() == 1 => Ok(()),
            Ok(_) => Err(AgentMcpError::NotFound),
            Err(error) if error.to_string().contains("UNIQUE") => {
                Err(AgentMcpError::DuplicateServer)
            }
            Err(_) => Err(AgentMcpError::Storage),
        }
    }
    pub async fn list(&self) -> Result<Vec<McpServerDefinition>, AgentMcpError> {
        query("SELECT id, name, enabled, transport, command, args_json, url, secret_ref, metadata_json, tool_visibility_json, safety_json FROM agent_mcp_servers ORDER BY name ASC, id ASC")
            .fetch_all(&self.pool).await.map_err(|_| AgentMcpError::Storage)?.into_iter().map(row_definition).collect()
    }
    pub async fn get(&self, id: &str) -> Result<McpServerDefinition, AgentMcpError> {
        row_definition(query("SELECT id, name, enabled, transport, command, args_json, url, secret_ref, metadata_json, tool_visibility_json, safety_json FROM agent_mcp_servers WHERE id = ?").bind(id).fetch_one(&self.pool).await.map_err(|_| AgentMcpError::NotFound)?)
    }
    pub async fn delete(&self, id: &str) -> Result<McpServerDefinition, AgentMcpError> {
        let existing = self.get(id).await?;
        let result = query("DELETE FROM agent_mcp_servers WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|_| AgentMcpError::Storage)?;
        if result.rows_affected() == 1 {
            Ok(existing)
        } else {
            Err(AgentMcpError::NotFound)
        }
    }
}

fn json_text(value: &impl Serialize) -> Result<String, AgentMcpError> {
    serde_json::to_string(value).map_err(|_| AgentMcpError::Storage)
}
fn row_definition(row: sqlx_sqlite::SqliteRow) -> Result<McpServerDefinition, AgentMcpError> {
    Ok(McpServerDefinition {
        id: row.get("id"),
        name: row.get("name"),
        enabled: row.get::<i64, _>("enabled") != 0,
        transport: McpTransport::from_db(&row.get::<String, _>("transport"))?,
        command: row.get("command"),
        args: serde_json::from_str(&row.get::<String, _>("args_json"))
            .map_err(|_| AgentMcpError::Storage)?,
        url: row.get("url"),
        secret_ref: row.get("secret_ref"),
        metadata: serde_json::from_str(&row.get::<String, _>("metadata_json"))
            .map_err(|_| AgentMcpError::Storage)?,
        tool_visibility: serde_json::from_str(&row.get::<String, _>("tool_visibility_json"))
            .map_err(|_| AgentMcpError::Storage)?,
        safety: serde_json::from_str(&row.get::<String, _>("safety_json"))
            .map_err(|_| AgentMcpError::Storage)?,
    })
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDiscoveredTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub input_schema: Value,
    #[serde(default)]
    pub annotations: McpToolAnnotations,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct McpToolAnnotations(Value);

impl Default for McpToolAnnotations {
    fn default() -> Self {
        Self(json!({}))
    }
}

impl McpToolAnnotations {
    #[cfg(test)]
    fn from_hints(read_only_hint: Option<bool>, destructive_hint: Option<bool>) -> Self {
        let mut annotations = Map::new();
        if let Some(value) = read_only_hint {
            annotations.insert("readOnlyHint".into(), Value::Bool(value));
        }
        if let Some(value) = destructive_hint {
            annotations.insert("destructiveHint".into(), Value::Bool(value));
        }
        Self(Value::Object(annotations))
    }

    fn read_only_hint(&self) -> Option<bool> {
        self.0.get("readOnlyHint").and_then(Value::as_bool)
    }

    fn destructive_hint(&self) -> Option<bool> {
        self.0.get("destructiveHint").and_then(Value::as_bool)
    }

    #[cfg(test)]
    fn raw(&self) -> &Value {
        &self.0
    }

    #[cfg(test)]
    fn from_raw(value: Value) -> Self {
        Self(value)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeToolDescriptorJson {
    pub id: String,
    pub name: String,
    pub description: String,
    pub parameters: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strict: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_approval: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_remote_tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_fingerprint: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RegisteredMcpTool {
    pub server_id: String,
    pub server_name: String,
    pub remote_name: String,
    pub descriptor: RuntimeToolDescriptorJson,
}

#[derive(Debug, Clone)]
pub struct McpToolPolicy {
    pub server_id: String,
    pub requires_approval: bool,
    pub policy_fingerprint: Option<String>,
}

#[derive(Default)]
pub struct McpToolRegistry {
    tools: BTreeMap<String, RegisteredMcpTool>,
}

impl McpToolRegistry {
    pub fn register(
        &mut self,
        server: &McpServerDefinition,
        discovered: Vec<McpDiscoveredTool>,
    ) -> Result<(), AgentMcpError> {
        server.validate_custom_id()?;
        self.register_with_approval(server, discovered, |server, tool| {
            server.safety.requires_approval
                || server
                    .safety
                    .approval_tools
                    .iter()
                    .any(|item| item == &tool.name)
        })
    }

    fn register_managed_linear(
        &mut self,
        server: &McpServerDefinition,
        discovered: Vec<McpDiscoveredTool>,
    ) -> Result<(), AgentMcpError> {
        let mut seen_remote = BTreeSet::new();
        let mut seen_runtime = BTreeSet::new();
        for tool in discovered {
            let Some(tool) = normalize_managed_mcp_tool(tool) else {
                tracing::warn!(
                    error_code = "linear_managed_mcp_tool_invalid",
                    "Skipping an invalid Linear hosted MCP tool"
                );
                continue;
            };
            if tool.name.is_empty()
                || !seen_remote.insert(tool.name.clone())
                || !server.tool_visibility.allows(&tool.name)
            {
                continue;
            }
            let name = match runtime_tool_name(&server.name, &tool.name) {
                Ok(name) if seen_runtime.insert(name.clone()) => name,
                Ok(_) => continue,
                Err(error) => {
                    tracing::warn!(
                        error_code = "linear_managed_mcp_tool_invalid",
                        error = %error,
                        "Skipping an invalid Linear hosted MCP tool"
                    );
                    continue;
                }
            };
            let requires_approval = tool.annotations.read_only_hint() != Some(true)
                || tool.annotations.destructive_hint() == Some(true);
            let policy_fingerprint = managed_linear_policy_fingerprint(&tool)?;
            let descriptor = RuntimeToolDescriptorJson {
                id: format!("mcp:{}/{}", server.id, tool.name),
                name: name.clone(),
                description: tool.description,
                parameters: object_schema(tool.input_schema),
                strict: Some(false),
                requires_approval: requires_approval.then_some(true),
                approval_provider: Some("Linear".to_string()),
                approval_remote_tool_name: Some(tool.name.clone()),
                policy_fingerprint: Some(policy_fingerprint),
            };
            // The managed source owns the mcp_linear_* namespace. A
            // user-configured server with the same display name must not
            // shadow Linear's official tools.
            self.tools.insert(
                name,
                RegisteredMcpTool {
                    server_id: server.id.clone(),
                    server_name: server.name.clone(),
                    remote_name: tool.name,
                    descriptor,
                },
            );
        }
        Ok(())
    }

    fn register_with_approval(
        &mut self,
        server: &McpServerDefinition,
        discovered: Vec<McpDiscoveredTool>,
        requires_approval: impl Fn(&McpServerDefinition, &McpDiscoveredTool) -> bool,
    ) -> Result<(), AgentMcpError> {
        let mut seen = BTreeSet::new();
        for tool in discovered {
            if tool.name.is_empty()
                || !seen.insert(tool.name.clone())
                || !server.tool_visibility.allows(&tool.name)
            {
                continue;
            }
            let name = runtime_tool_name(&server.name, &tool.name)?;
            if self.tools.contains_key(&name) {
                return Err(AgentMcpError::DuplicateServer);
            }
            let requires_approval = requires_approval(server, &tool);
            let descriptor = RuntimeToolDescriptorJson {
                id: format!("mcp:{}/{}", server.id, tool.name),
                name: name.clone(),
                description: tool.description,
                parameters: object_schema(tool.input_schema),
                strict: None,
                requires_approval: requires_approval.then_some(true),
                approval_provider: None,
                approval_remote_tool_name: None,
                policy_fingerprint: None,
            };
            self.tools.insert(
                name,
                RegisteredMcpTool {
                    server_id: server.id.clone(),
                    server_name: server.name.clone(),
                    remote_name: tool.name,
                    descriptor,
                },
            );
        }
        Ok(())
    }
    pub fn descriptors(&self) -> Vec<RuntimeToolDescriptorJson> {
        self.tools
            .values()
            .map(|tool| tool.descriptor.clone())
            .collect()
    }
    pub fn resolve(&self, runtime_name: &str) -> Option<&RegisteredMcpTool> {
        self.tools.get(runtime_name)
    }
}

pub fn runtime_tool_name(server_name: &str, remote_name: &str) -> Result<String, AgentMcpError> {
    let segment = |raw: &str| {
        raw.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '_'
                }
            })
            .collect::<String>()
            .trim_matches('_')
            .to_string()
    };
    let server = segment(server_name);
    let tool = segment(remote_name);
    if server.is_empty() || tool.is_empty() {
        return Err(AgentMcpError::InvalidDefinition(
            "tool name cannot be empty".into(),
        ));
    }
    let name = format!("mcp_{server}_{tool}");
    if name.len() > 128 {
        return Err(AgentMcpError::InvalidDefinition(
            "mapped tool name exceeds 128 characters".into(),
        ));
    }
    Ok(name)
}
fn object_schema(value: Value) -> Value {
    if value.get("type").and_then(Value::as_str) == Some("object") {
        value
    } else {
        json!({"type":"object","properties":{},"additionalProperties":true})
    }
}

fn normalize_managed_mcp_tool(mut tool: McpDiscoveredTool) -> Option<McpDiscoveredTool> {
    let name = tool.name.trim();
    if name.is_empty() || name.chars().count() > MANAGED_MCP_TOOL_NAME_MAX_CHARS {
        return None;
    }
    let schema = tool.input_schema.as_object()?;
    if schema.get("type").and_then(Value::as_str) != Some("object")
        || schema
            .get("properties")
            .is_some_and(|properties| !properties.is_object())
        || schema.get("required").is_some_and(|required| {
            !required
                .as_array()
                .is_some_and(|items| items.iter().all(Value::is_string))
        })
    {
        return None;
    }
    if serde_json::to_vec(schema)
        .map(|encoded| encoded.len() > MANAGED_MCP_TOOL_SCHEMA_MAX_BYTES)
        .unwrap_or(true)
        || serde_json::to_vec(&tool.annotations)
            .map(|encoded| encoded.len() > MANAGED_MCP_TOOL_ANNOTATIONS_MAX_BYTES)
            .unwrap_or(true)
    {
        return None;
    }
    tool.name = name.to_string();
    let description = tool.description.trim().to_string();
    tool.description = description
        .chars()
        .take(MANAGED_MCP_DESCRIPTION_MAX_CHARS)
        .collect();
    if description.chars().count() > MANAGED_MCP_DESCRIPTION_MAX_CHARS {
        tool.description.push_str("...");
    }
    Some(tool)
}

fn managed_linear_policy_fingerprint(tool: &McpDiscoveredTool) -> Result<String, AgentMcpError> {
    let identity = serde_json::to_vec(&json!({
        "remoteName": tool.name,
        "description": tool.description,
        "inputSchema": tool.input_schema,
        "annotations": tool.annotations,
    }))
    .map_err(|_| AgentMcpError::Protocol)?;
    let mut hash = Sha256::new();
    hash.update(MANAGED_LINEAR_POLICY_REVISION.as_bytes());
    hash.update([0]);
    hash.update(identity);
    Ok(format!(
        "{MANAGED_LINEAR_POLICY_REVISION}:{:x}",
        hash.finalize()
    ))
}

pub struct AgentMcpSubsystem<S: McpSecretStore> {
    pub repository: AgentMcpRepository,
    pub secrets: S,
    pub registry: Mutex<McpToolRegistry>,
}
impl<S: McpSecretStore> AgentMcpSubsystem<S> {
    pub fn new(repository: AgentMcpRepository, secrets: S) -> Self {
        Self {
            repository,
            secrets,
            registry: Mutex::new(McpToolRegistry::default()),
        }
    }
    async fn load_server_secrets(
        &self,
        server: &McpServerDefinition,
        force_oauth_refresh: bool,
    ) -> Result<McpSecretBundle, AgentMcpError> {
        let Some(reference) = server.secret_ref.as_deref() else {
            return Ok(McpSecretBundle::default());
        };
        let mut bundle = self.secrets.get(reference)?.unwrap_or_default();
        if refresh_oauth_bundle(&mut bundle, force_oauth_refresh).await? {
            self.secrets.put(reference, &bundle)?;
            retire_server_sessions(&server.id).await;
        }
        Ok(bundle)
    }
    pub async fn refresh_registry(&self) -> Result<Vec<RuntimeToolDescriptorJson>, AgentMcpError> {
        self.refresh_registry_for(false).await
    }
    pub async fn refresh_registry_for(
        &self,
        sandboxed: bool,
    ) -> Result<Vec<RuntimeToolDescriptorJson>, AgentMcpError> {
        self.refresh_registry_for_workspace(sandboxed, None).await
    }
    pub async fn refresh_registry_for_workspace(
        &self,
        sandboxed: bool,
        workspace: Option<&std::path::Path>,
    ) -> Result<Vec<RuntimeToolDescriptorJson>, AgentMcpError> {
        self.refresh_registry_for_workspace_internal(sandboxed, workspace, None)
            .await
    }

    pub async fn refresh_registry_for_workspace_with_managed_linear(
        &self,
        app: &AppHandle,
        sandboxed: bool,
        workspace: Option<&std::path::Path>,
    ) -> Result<Vec<RuntimeToolDescriptorJson>, AgentMcpError> {
        self.refresh_registry_for_workspace_internal(sandboxed, workspace, Some(app))
            .await
    }

    async fn refresh_registry_for_workspace_internal(
        &self,
        sandboxed: bool,
        workspace: Option<&std::path::Path>,
        app: Option<&AppHandle>,
    ) -> Result<Vec<RuntimeToolDescriptorJson>, AgentMcpError> {
        let mut next = McpToolRegistry::default();
        for server in self.repository.list().await? {
            if server.id.trim() == MANAGED_LINEAR_SERVER_ID {
                tracing::warn!(
                    error_code = "agent_mcp_server_id_reserved",
                    server_id = %server.id,
                    "Skipping a custom MCP server with a reserved managed id"
                );
                continue;
            }
            if !server_available(&server, sandboxed, workspace) {
                continue;
            }
            let secret = self.load_server_secrets(&server, false).await?;
            let mut discovered =
                discover_server(&server, &secret, sandboxed.then_some(workspace).flatten()).await;
            if matches!(discovered, Err(AgentMcpError::Unauthorized)) && !secret.oauth.is_empty() {
                discovered = match self.load_server_secrets(&server, true).await {
                    Ok(refreshed) => {
                        discover_server(
                            &server,
                            &refreshed,
                            sandboxed.then_some(workspace).flatten(),
                        )
                        .await
                    }
                    Err(error) => Err(error),
                };
            }
            match discovered {
                Ok(tools) => next.register(&server, tools)?,
                Err(error) => tracing::warn!(
                    error_code = "agent_mcp_discovery_failed",
                    server_id = %server.id,
                    transport = ?server.transport,
                    error = %error,
                    "MCP server discovery failed; continuing with the remaining servers"
                ),
            }
        }
        if let Some(app) = app {
            match discover_managed_linear(app, sandboxed.then_some(workspace).flatten()).await {
                Ok(Some((server, tools))) => next.register_managed_linear(&server, tools)?,
                Ok(None) => {}
                Err(error) => tracing::warn!(
                    error_code = "linear_managed_mcp_discovery_failed",
                    server_id = MANAGED_LINEAR_SERVER_ID,
                    error = %error,
                    "Linear hosted MCP discovery failed"
                ),
            }
        }
        let descriptors = next.descriptors();
        *self.registry.lock().map_err(|_| AgentMcpError::Storage)? = next;
        Ok(descriptors)
    }
    pub async fn invoke(
        &self,
        runtime_name: &str,
        arguments: Value,
        sandboxed: bool,
    ) -> Result<Value, AgentMcpError> {
        self.invoke_in_workspace(runtime_name, arguments, sandboxed, None)
            .await
    }
    pub async fn invoke_in_workspace(
        &self,
        runtime_name: &str,
        arguments: Value,
        sandboxed: bool,
        workspace: Option<&std::path::Path>,
    ) -> Result<Value, AgentMcpError> {
        self.invoke_in_workspace_with_elicitation(
            runtime_name,
            arguments,
            sandboxed,
            workspace,
            None,
        )
        .await
    }

    pub async fn invoke_in_workspace_with_elicitation(
        &self,
        runtime_name: &str,
        arguments: Value,
        sandboxed: bool,
        workspace: Option<&std::path::Path>,
        elicitation_answer: Option<&str>,
    ) -> Result<Value, AgentMcpError> {
        self.invoke_registered(
            runtime_name,
            arguments,
            sandboxed,
            workspace,
            elicitation_answer,
            None,
        )
        .await
    }

    pub async fn invoke_in_workspace_with_elicitation_and_managed_linear(
        &self,
        app: &AppHandle,
        runtime_name: &str,
        arguments: Value,
        sandboxed: bool,
        workspace: Option<&std::path::Path>,
        elicitation_answer: Option<&str>,
    ) -> Result<Value, AgentMcpError> {
        self.invoke_registered(
            runtime_name,
            arguments,
            sandboxed,
            workspace,
            elicitation_answer,
            Some(app),
        )
        .await
    }

    async fn invoke_registered(
        &self,
        runtime_name: &str,
        arguments: Value,
        sandboxed: bool,
        workspace: Option<&std::path::Path>,
        elicitation_answer: Option<&str>,
        app: Option<&AppHandle>,
    ) -> Result<Value, AgentMcpError> {
        let registered = self
            .registry
            .lock()
            .map_err(|_| AgentMcpError::Storage)?
            .resolve(runtime_name)
            .cloned()
            .ok_or(AgentMcpError::ToolUnavailable)?;
        if registered.server_id == MANAGED_LINEAR_SERVER_ID {
            let app = app.ok_or(AgentMcpError::ToolUnavailable)?;
            let Some((server, secrets, lifecycle)) = managed_linear_connection(app, false).await?
            else {
                return Err(AgentMcpError::ToolUnavailable);
            };
            // Never replay a hosted Linear tools/call request. A timeout,
            // disconnect, or 401 can arrive after Linear applied a mutation.
            return call_server(
                &server,
                &secrets,
                &registered.remote_name,
                arguments,
                sandboxed.then_some(workspace).flatten(),
                elicitation_answer,
                Some(&lifecycle),
            )
            .await;
        }
        let server = self.repository.get(&registered.server_id).await?;
        if !server_available(&server, sandboxed, workspace) {
            return Err(AgentMcpError::ToolUnavailable);
        }
        let secret = self.load_server_secrets(&server, false).await?;
        let first = call_server(
            &server,
            &secret,
            &registered.remote_name,
            arguments.clone(),
            sandboxed.then_some(workspace).flatten(),
            elicitation_answer,
            None,
        )
        .await;
        if matches!(first, Err(AgentMcpError::Unauthorized)) && !secret.oauth.is_empty() {
            let refreshed = self.load_server_secrets(&server, true).await?;
            return call_server(
                &server,
                &refreshed,
                &registered.remote_name,
                arguments,
                sandboxed.then_some(workspace).flatten(),
                elicitation_answer,
                None,
            )
            .await;
        }
        first
    }

    pub fn server_name_for_tool(
        &self,
        runtime_name: &str,
    ) -> Result<Option<String>, AgentMcpError> {
        Ok(self
            .registry
            .lock()
            .map_err(|_| AgentMcpError::Storage)?
            .resolve(runtime_name)
            .map(|registered| registered.server_name.clone()))
    }

    pub fn policy_for_tool(
        &self,
        runtime_name: &str,
    ) -> Result<Option<McpToolPolicy>, AgentMcpError> {
        Ok(self
            .registry
            .lock()
            .map_err(|_| AgentMcpError::Storage)?
            .resolve(runtime_name)
            .map(|registered| McpToolPolicy {
                server_id: registered.server_id.clone(),
                requires_approval: registered.descriptor.requires_approval == Some(true),
                policy_fingerprint: registered.descriptor.policy_fingerprint.clone(),
            }))
    }
}

fn managed_linear_definition() -> McpServerDefinition {
    McpServerDefinition {
        id: MANAGED_LINEAR_SERVER_ID.to_string(),
        name: MANAGED_LINEAR_SERVER_NAME.to_string(),
        enabled: true,
        transport: McpTransport::StreamableHttp,
        command: None,
        args: Vec::new(),
        url: Some(MANAGED_LINEAR_MCP_URL.to_string()),
        secret_ref: None,
        metadata: json!({"managed": true, "provider": "linear"}),
        tool_visibility: McpToolVisibility::default(),
        safety: McpSafetyPolicy {
            requires_approval: false,
            ..McpSafetyPolicy::default()
        },
    }
}

async fn managed_linear_connection(
    app: &AppHandle,
    force_refresh: bool,
) -> Result<
    Option<(
        McpServerDefinition,
        McpSecretBundle,
        crate::connectors::LinearLifecycleSnapshot,
    )>,
    AgentMcpError,
> {
    let account = crate::connectors::list_runtime_accounts(app)
        .await
        .map_err(|_| AgentMcpError::Storage)?
        .into_iter()
        .find(|account| {
            account.provider == crate::connectors::ConnectorProvider::Linear
                && account.status == crate::connectors::ConnectorAccountStatus::Connected
        });
    let Some(account) = account else {
        return Ok(None);
    };
    let lifecycle = crate::connectors::acquire_linear_lifecycle(&account.account_id).await;
    let still_connected = crate::connectors::list_runtime_accounts(app)
        .await
        .map_err(|_| AgentMcpError::Storage)?
        .into_iter()
        .any(|candidate| {
            candidate.provider == crate::connectors::ConnectorProvider::Linear
                && candidate.account_id == account.account_id
                && candidate.status == crate::connectors::ConnectorAccountStatus::Connected
        });
    if !still_connected {
        return Ok(None);
    }
    // Capture eligibility while the account row is stable, then release the
    // lifecycle gate before token refresh can perform network I/O. Disconnect
    // advances this epoch before waiting on the shared refresh lock, so an
    // overlapping refresh either finishes before custody deletion or observes
    // missing custody; either way this snapshot becomes stale before MCP I/O.
    let snapshot = lifecycle.snapshot();
    drop(lifecycle);
    let token = if force_refresh {
        crate::connectors::force_refresh_linear_access_token(app, &account.account_id).await
    } else {
        crate::connectors::linear_access_token(app, &account.account_id).await
    }
    .map_err(|error| match error.code.as_str() {
        "connector_reconnect_required" | "linear_unauthorized" => AgentMcpError::Unauthorized,
        _ => AgentMcpError::Transport,
    })?;
    let mut secrets = McpSecretBundle::default();
    secrets
        .headers
        .insert("Authorization".to_string(), format!("Bearer {token}"));
    Ok(Some((managed_linear_definition(), secrets, snapshot)))
}

async fn discover_managed_linear(
    app: &AppHandle,
    sandbox_workspace: Option<&std::path::Path>,
) -> Result<Option<(McpServerDefinition, Vec<McpDiscoveredTool>)>, AgentMcpError> {
    let Some((server, secrets, lifecycle)) = managed_linear_connection(app, false).await? else {
        return Ok(None);
    };
    match discover_managed_server(&server, &secrets, sandbox_workspace, &lifecycle).await {
        Ok(tools) => Ok(Some((server, tools))),
        Err(AgentMcpError::Unauthorized) => {
            retire_server_sessions(MANAGED_LINEAR_SERVER_ID).await;
            let Some((server, refreshed, lifecycle)) = managed_linear_connection(app, true).await?
            else {
                return Ok(None);
            };
            discover_managed_server(&server, &refreshed, sandbox_workspace, &lifecycle)
                .await
                .map(|tools| Some((server, tools)))
        }
        Err(error) => Err(error),
    }
}

pub async fn snapshot_run_policies(
    pool: &SqlitePool,
    run_id: &str,
    descriptors: &[RuntimeToolDescriptorJson],
) -> Result<(), AgentMcpError> {
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|_| AgentMcpError::Storage)?;
    let already_snapshotted = query(
        "SELECT mcp_policy_snapshotted
         FROM agent_runs
         WHERE id = ?",
    )
    .bind(run_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| AgentMcpError::Storage)?
    .ok_or(AgentMcpError::NotFound)?
    .get::<i64, _>("mcp_policy_snapshotted")
        != 0;
    if already_snapshotted {
        return transaction
            .commit()
            .await
            .map_err(|_| AgentMcpError::Storage);
    }
    for descriptor in descriptors {
        let Some(server_id) = descriptor
            .id
            .strip_prefix("mcp:")
            .and_then(|value| value.split('/').next())
        else {
            continue;
        };
        let updated_at = if server_id == MANAGED_LINEAR_SERVER_ID {
            descriptor
                .policy_fingerprint
                .clone()
                .ok_or(AgentMcpError::Storage)?
        } else {
            query("SELECT updated_at FROM agent_mcp_servers WHERE id = ?")
                .bind(server_id)
                .fetch_optional(&mut *transaction)
                .await
                .map_err(|_| AgentMcpError::Storage)?
                .map(|row| row.get::<String, _>("updated_at"))
                .ok_or(AgentMcpError::NotFound)?
        };
        query(
            "INSERT INTO agent_run_mcp_policies
             (run_id, tool_name, server_id, server_updated_at, requires_approval)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(run_id)
        .bind(&descriptor.name)
        .bind(server_id)
        .bind(updated_at)
        .bind(descriptor.requires_approval == Some(true))
        .execute(&mut *transaction)
        .await
        .map_err(|_| AgentMcpError::Storage)?;
    }
    query(
        "UPDATE agent_runs
         SET mcp_policy_snapshotted = 1
         WHERE id = ? AND mcp_policy_snapshotted = 0",
    )
    .bind(run_id)
    .execute(&mut *transaction)
    .await
    .map_err(|_| AgentMcpError::Storage)?;
    transaction
        .commit()
        .await
        .map_err(|_| AgentMcpError::Storage)
}

pub async fn run_policy_matches(
    pool: &SqlitePool,
    run_id: &str,
    tool_name: &str,
    current: &McpToolPolicy,
) -> Result<bool, AgentMcpError> {
    if current.server_id == MANAGED_LINEAR_SERVER_ID {
        let row = query(
            "SELECT server_id, server_updated_at, requires_approval
             FROM agent_run_mcp_policies
             WHERE run_id = ? AND tool_name = ?",
        )
        .bind(run_id)
        .bind(tool_name)
        .fetch_optional(pool)
        .await
        .map_err(|_| AgentMcpError::Storage)?;
        return Ok(row.is_some_and(|row| {
            row.get::<String, _>("server_id") == current.server_id
                && current
                    .policy_fingerprint
                    .as_ref()
                    .is_some_and(|fingerprint| {
                        row.get::<String, _>("server_updated_at") == *fingerprint
                    })
                && row.get::<bool, _>("requires_approval") == current.requires_approval
        }));
    }
    let row = query(
        "SELECT policy.server_id, policy.server_updated_at, policy.requires_approval,
                server.updated_at AS current_updated_at
         FROM agent_run_mcp_policies policy
         JOIN agent_mcp_servers server ON server.id = policy.server_id
         WHERE policy.run_id = ? AND policy.tool_name = ?",
    )
    .bind(run_id)
    .bind(tool_name)
    .fetch_optional(pool)
    .await
    .map_err(|_| AgentMcpError::Storage)?;
    Ok(row.is_some_and(|row| {
        row.get::<String, _>("server_id") == current.server_id
            && row.get::<String, _>("server_updated_at")
                == row.get::<String, _>("current_updated_at")
            && row.get::<bool, _>("requires_approval") == current.requires_approval
    }))
}

fn server_available(
    server: &McpServerDefinition,
    sandboxed: bool,
    workspace: Option<&std::path::Path>,
) -> bool {
    if !server.enabled || (sandboxed && !server.safety.allow_sandboxed) {
        return false;
    }
    if !sandboxed || server.transport == McpTransport::StreamableHttp {
        return true;
    }
    cfg!(target_os = "macos") && workspace.is_some()
}

async fn discover_server(
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
    sandbox_workspace: Option<&std::path::Path>,
) -> Result<Vec<McpDiscoveredTool>, AgentMcpError> {
    let value = session_request(
        server,
        secrets,
        "tools/list",
        json!({}),
        sandbox_workspace,
        None,
        None,
    )
    .await?;
    discovered_tools_from_response(&value)
}

#[derive(Debug)]
struct McpDiscoveredToolsPage {
    tools: Vec<McpDiscoveredTool>,
    next_cursor: Option<String>,
}

async fn discover_managed_tools_with<F, Fut>(
    mut fetch_page: F,
) -> Result<Vec<McpDiscoveredTool>, AgentMcpError>
where
    F: FnMut(Value) -> Fut,
    Fut: Future<Output = Result<Value, AgentMcpError>>,
{
    let mut tools = Vec::new();
    let mut total_bytes = 0usize;
    let mut next_cursor: Option<String> = None;
    let mut seen_cursors = BTreeSet::new();

    for _ in 0..MANAGED_MCP_DISCOVERY_MAX_PAGES {
        let params = next_cursor
            .as_deref()
            .map_or_else(|| json!({}), |cursor| json!({ "cursor": cursor }));
        let page = discovered_tools_page_from_response(&fetch_page(params).await?)?;
        if tools.len().saturating_add(page.tools.len()) > MANAGED_MCP_DISCOVERY_MAX_TOOLS {
            return Err(AgentMcpError::Protocol);
        }
        let page_bytes = serde_json::to_vec(&page.tools)
            .map_err(|_| AgentMcpError::Protocol)?
            .len();
        total_bytes = total_bytes
            .checked_add(page_bytes)
            .ok_or(AgentMcpError::Protocol)?;
        if total_bytes > MANAGED_MCP_DISCOVERY_MAX_BYTES {
            return Err(AgentMcpError::Protocol);
        }
        tools.extend(page.tools);

        let Some(cursor) = page.next_cursor else {
            return Ok(tools);
        };
        if cursor.chars().count() > MANAGED_MCP_CURSOR_MAX_CHARS
            || !seen_cursors.insert(cursor.clone())
        {
            return Err(AgentMcpError::Protocol);
        }
        next_cursor = Some(cursor);
    }

    Err(AgentMcpError::Protocol)
}

async fn discover_managed_server(
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
    sandbox_workspace: Option<&std::path::Path>,
    lifecycle: &crate::connectors::LinearLifecycleSnapshot,
) -> Result<Vec<McpDiscoveredTool>, AgentMcpError> {
    discover_managed_tools_with(|params| {
        session_request(
            server,
            secrets,
            "tools/list",
            params,
            sandbox_workspace,
            None,
            Some(lifecycle),
        )
    })
    .await
}

fn discovered_tools_from_response(value: &Value) -> Result<Vec<McpDiscoveredTool>, AgentMcpError> {
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or(AgentMcpError::Protocol)?;
    discovered_tools_from_result(result)
}

fn discovered_tools_page_from_response(
    value: &Value,
) -> Result<McpDiscoveredToolsPage, AgentMcpError> {
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or(AgentMcpError::Protocol)?;
    let next_cursor = match result.get("nextCursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(cursor)) if cursor.is_empty() => None,
        Some(Value::String(cursor)) => Some(cursor.clone()),
        Some(_) => return Err(AgentMcpError::Protocol),
    };
    Ok(McpDiscoveredToolsPage {
        tools: discovered_tools_from_result(result)?,
        next_cursor,
    })
}

fn discovered_tools_from_result(
    result: &Map<String, Value>,
) -> Result<Vec<McpDiscoveredTool>, AgentMcpError> {
    let tools = result
        .get("tools")
        .and_then(Value::as_array)
        .ok_or(AgentMcpError::Protocol)?;
    Ok(tools
        .iter()
        .filter_map(|tool| {
            let name = tool.get("name")?.as_str()?.to_string();
            Some(McpDiscoveredTool {
                name,
                description: tool
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                input_schema: tool
                    .get("inputSchema")
                    .or_else(|| tool.get("input_schema"))
                    .cloned()
                    .unwrap_or(Value::Null),
                annotations: tool
                    .get("annotations")
                    .cloned()
                    .and_then(|annotations| serde_json::from_value(annotations).ok())
                    .unwrap_or_default(),
            })
        })
        .collect())
}
async fn call_server(
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
    tool_name: &str,
    arguments: Value,
    sandbox_workspace: Option<&std::path::Path>,
    elicitation_answer: Option<&str>,
    linear_lifecycle: Option<&crate::connectors::LinearLifecycleSnapshot>,
) -> Result<Value, AgentMcpError> {
    let value = session_request(
        server,
        secrets,
        "tools/call",
        json!({"name":tool_name,"arguments":arguments}),
        sandbox_workspace,
        elicitation_answer,
        linear_lifecycle,
    )
    .await?;
    value.get("result").cloned().ok_or(AgentMcpError::Protocol)
}
async fn session_request(
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
    method: &str,
    params: Value,
    sandbox_workspace: Option<&std::path::Path>,
    elicitation_answer: Option<&str>,
    linear_lifecycle: Option<&crate::connectors::LinearLifecycleSnapshot>,
) -> Result<Value, AgentMcpError> {
    if linear_lifecycle.is_some_and(|snapshot| !snapshot.is_current()) {
        return Err(AgentMcpError::ToolUnavailable);
    }
    let deadline = Duration::from_millis(server.safety.timeout_ms);
    let result = timeout(deadline, async move {
        let shared = persistent_session(server, secrets, sandbox_workspace).await;
        // Linearize eligibility before taking the persistent-session slot and
        // keep it through the remote request. Disconnect and reconnect take
        // the same lifecycle gate before retiring the slot, so the global
        // lock order is lifecycle -> session and an admitted request either
        // finishes before the epoch advances or fails here as stale.
        let _linear_dispatch_guard = match linear_lifecycle {
            Some(snapshot) => Some(
                snapshot
                    .acquire_current()
                    .await
                    .ok_or(AgentMcpError::ToolUnavailable)?,
            ),
            None => None,
        };
        let mut slot = shared.lock().await;
        if linear_lifecycle.is_some_and(|snapshot| !snapshot.is_current()) {
            slot.close().await;
            return Err(AgentMcpError::ToolUnavailable);
        }
        let fingerprint = session_fingerprint(server, secrets, sandbox_workspace);
        if slot.fingerprint != fingerprint {
            slot.close().await;
            slot.fingerprint = fingerprint;
            slot.next_request_id = 2;
        }
        let discovery_cache_key = (method == "tools/list")
            .then(|| serde_json::to_string(&params).ok())
            .flatten();
        // A server-initiated elicitation parks the original tools/call inside
        // this session. A turn retry rebuilds the ephemeral registry before
        // loading the user's answer; replay the already-validated discovery
        // page instead of letting that tools/list collide with the parked
        // call. Managed pagination keys each cached page by its cursor params.
        let has_pending_elicitation = slot
            .transport
            .as_ref()
            .is_some_and(PersistentMcpTransport::has_pending_elicitation);
        if has_pending_elicitation {
            if let Some(cached) = discovery_cache_key
                .as_ref()
                .and_then(|key| slot.discovery_pages.get(key))
            {
                return Ok(cached.clone());
            }
        } else if method == "tools/list"
            && params.as_object().is_some_and(serde_json::Map::is_empty)
        {
            // A non-parked empty-params request starts a fresh discovery
            // round. Retain only that round's bounded pages; older cursor
            // values are never needed to resume a future elicitation.
            slot.discovery_pages.clear();
        }
        for attempt in 0..2 {
            if linear_lifecycle.is_some_and(|snapshot| !snapshot.is_current()) {
                slot.close().await;
                return Err(AgentMcpError::ToolUnavailable);
            }
            if slot.transport.is_none() {
                slot.transport = Some(start_transport(server, secrets, sandbox_workspace).await?);
                // Initialization performs network I/O while this session slot
                // is held. Disconnect can advance the lifecycle epoch while
                // waiting to retire the slot, so recheck before the first
                // request is allowed to leave the initialized transport.
                if linear_lifecycle.is_some_and(|snapshot| !snapshot.is_current()) {
                    slot.close().await;
                    return Err(AgentMcpError::ToolUnavailable);
                }
            }
            let id = slot.next_request_id;
            slot.next_request_id = slot.next_request_id.saturating_add(1);
            let result = match slot.transport.as_mut().expect("transport initialized") {
                PersistentMcpTransport::Stdio(session) => {
                    session
                        .request(
                            id,
                            method,
                            params.clone(),
                            server.safety.max_output_bytes,
                            elicitation_answer,
                        )
                        .await
                }
                PersistentMcpTransport::Http(session) => {
                    session
                        .request(
                            server,
                            secrets,
                            id,
                            method,
                            params.clone(),
                            elicitation_answer,
                        )
                        .await
                }
            };
            match result {
                Ok(value) => {
                    if let Some(key) = discovery_cache_key.as_ref() {
                        slot.discovery_pages.insert(key.clone(), value.clone());
                    }
                    return Ok(value);
                }
                // Discovery/listing is read-only and can be retried after a
                // reconnect. A tool call may already have mutated remote
                // state before its response was lost, so never replay it.
                Err(AgentMcpError::Transport) if attempt == 0 && method != "tools/call" => {
                    slot.close().await;
                }
                Err(AgentMcpError::Transport) => {
                    slot.close().await;
                    return Err(AgentMcpError::Transport);
                }
                Err(error) => return Err(error),
            }
        }
        Err(AgentMcpError::Transport)
    })
    .await;
    match result {
        // Elicitation deliberately leaves the transport and original request
        // parked in the persistent session. The next invocation supplies the
        // answer and resumes that request without replaying `tools/call`.
        Ok(result) => result,
        Err(_) => {
            retire_server_sessions(&server.id).await;
            Err(AgentMcpError::TimedOut)
        }
    }
}

async fn persistent_session(
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
    sandbox_workspace: Option<&std::path::Path>,
) -> SharedMcpSession {
    let key = session_key(server, sandbox_workspace);
    let sessions = MCP_SESSIONS.get_or_init(|| AsyncMutex::new(HashMap::new()));
    let mut sessions = sessions.lock().await;
    sessions
        .entry(key)
        .or_insert_with(|| {
            Arc::new(AsyncMutex::new(McpSessionSlot {
                fingerprint: session_fingerprint(server, secrets, sandbox_workspace),
                next_request_id: 2,
                transport: None,
                discovery_pages: BTreeMap::new(),
            }))
        })
        .clone()
}

fn session_key(
    server: &McpServerDefinition,
    sandbox_workspace: Option<&std::path::Path>,
) -> String {
    let workspace = sandbox_workspace
        .and_then(|path| path.canonicalize().ok())
        .unwrap_or_default();
    format!("{}:{}", server.id, workspace.display())
}

fn session_fingerprint(
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
    sandbox_workspace: Option<&std::path::Path>,
) -> String {
    let mut hash = Sha256::new();
    if let Ok(server) = serde_json::to_vec(server) {
        hash.update(server);
    }
    for (key, value) in &secrets.env {
        hash.update(key.as_bytes());
        hash.update([0]);
        hash.update(value.as_bytes());
        hash.update([0]);
    }
    for (key, value) in &secrets.headers {
        hash.update(key.as_bytes());
        hash.update([0]);
        hash.update(value.as_bytes());
        hash.update([0]);
    }
    for (key, value) in &secrets.oauth {
        hash.update(key.as_bytes());
        hash.update([0]);
        hash.update(value.as_bytes());
        hash.update([0]);
    }
    if let Some(workspace) = sandbox_workspace {
        hash.update(workspace.as_os_str().as_encoded_bytes());
    }
    format!("{:x}", hash.finalize())
}

async fn start_transport(
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
    sandbox_workspace: Option<&std::path::Path>,
) -> Result<PersistentMcpTransport, AgentMcpError> {
    match server.transport {
        McpTransport::Stdio => start_stdio_session(server, secrets, sandbox_workspace)
            .await
            .map(Box::new)
            .map(PersistentMcpTransport::Stdio),
        McpTransport::StreamableHttp => start_http_session(server, secrets)
            .await
            .map(Box::new)
            .map(PersistentMcpTransport::Http),
    }
}

async fn start_stdio_session(
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
    sandbox_workspace: Option<&std::path::Path>,
) -> Result<StdioMcpSession, AgentMcpError> {
    let executable = server.command.as_deref().ok_or(AgentMcpError::Transport)?;
    let mut command = if let Some(workspace) = sandbox_workspace {
        #[cfg(target_os = "macos")]
        {
            let mut command = Command::new("/usr/bin/sandbox-exec");
            command
                .arg("-p")
                .arg(crate::agent_runtime::tools::sandbox_profile(workspace))
                .arg(executable)
                .args(&server.args);
            command
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = workspace;
            return Err(AgentMcpError::ToolUnavailable);
        }
    } else {
        let mut command = Command::new(executable);
        command.args(&server.args);
        command
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for (key, value) in &secrets.env {
        command.env(key, value);
    }
    let mut child = command.spawn().map_err(|_| AgentMcpError::Transport)?;
    let mut stdin = child.stdin.take().ok_or(AgentMcpError::Transport)?;
    let stdout = child.stdout.take().ok_or(AgentMcpError::Transport)?;
    let mut stdout = BufReader::new(stdout);
    write_stdio_frame(&mut stdin, 1, "initialize", initialize_params()).await?;
    read_stdio_response_with_elicitation(
        &mut stdout,
        Some(&mut stdin),
        server.safety.max_output_bytes,
        1,
        None,
    )
    .await?;
    write_stdio_notification(&mut stdin, "notifications/initialized", json!({})).await?;
    Ok(StdioMcpSession {
        child,
        stdin,
        stdout,
        pending: None,
    })
}

impl StdioMcpSession {
    async fn request(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
        max_output_bytes: usize,
        elicitation_answer: Option<&str>,
    ) -> Result<Value, AgentMcpError> {
        if self.child.id().is_none() {
            return Err(AgentMcpError::Transport);
        }
        if let Some(pending) = self.pending.take() {
            let Some(answer) = elicitation_answer else {
                let message = elicitation_message(&pending.elicitation);
                self.pending = Some(pending);
                return Err(AgentMcpError::ElicitationRequired(message));
            };
            write_stdio_elicitation_response(&mut self.stdin, &pending.elicitation, answer).await?;
            return self
                .read_request(pending.request_id, max_output_bytes, pending.consumed, None)
                .await;
        }
        write_stdio_frame(&mut self.stdin, id, method, params).await?;
        self.read_request(id, max_output_bytes, 0, elicitation_answer)
            .await
    }

    async fn read_request(
        &mut self,
        request_id: u64,
        max_output_bytes: usize,
        consumed: usize,
        mut elicitation_answer: Option<&str>,
    ) -> Result<Value, AgentMcpError> {
        let mut consumed = consumed;
        loop {
            let (event, next_consumed) =
                read_stdio_response_event(&mut self.stdout, max_output_bytes, request_id, consumed)
                    .await?;
            consumed = next_consumed;
            match event {
                StdioResponseEvent::Response(value) => return Ok(value),
                StdioResponseEvent::Elicitation(request) => {
                    if let Some(answer) = elicitation_answer.take() {
                        write_stdio_elicitation_response(&mut self.stdin, &request, answer).await?;
                    } else {
                        let message = elicitation_message(&request);
                        self.pending = Some(PendingStdioRequest {
                            request_id,
                            elicitation: request,
                            consumed,
                        });
                        return Err(AgentMcpError::ElicitationRequired(message));
                    }
                }
            }
        }
    }
}

async fn write_stdio_frame(
    stdin: &mut tokio::process::ChildStdin,
    id: u64,
    method: &str,
    params: Value,
) -> Result<(), AgentMcpError> {
    let frame = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    stdin
        .write_all(
            serde_json::to_string(&frame)
                .map_err(|_| AgentMcpError::Protocol)?
                .as_bytes(),
        )
        .await
        .map_err(|_| AgentMcpError::Transport)?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|_| AgentMcpError::Transport)?;
    stdin.flush().await.map_err(|_| AgentMcpError::Transport)
}

async fn write_stdio_notification(
    stdin: &mut tokio::process::ChildStdin,
    method: &str,
    params: Value,
) -> Result<(), AgentMcpError> {
    let frame = json!({"jsonrpc":"2.0","method":method,"params":params});
    stdin
        .write_all(
            serde_json::to_string(&frame)
                .map_err(|_| AgentMcpError::Protocol)?
                .as_bytes(),
        )
        .await
        .map_err(|_| AgentMcpError::Transport)?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|_| AgentMcpError::Transport)?;
    stdin.flush().await.map_err(|_| AgentMcpError::Transport)
}

#[cfg(test)]
async fn read_stdio_response<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    limit: usize,
    id: u64,
) -> Result<Value, AgentMcpError> {
    read_stdio_response_with_elicitation(reader, None, limit, id, None).await
}

async fn read_stdio_response_with_elicitation<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    mut stdin: Option<&mut tokio::process::ChildStdin>,
    limit: usize,
    id: u64,
    elicitation_answer: Option<&str>,
) -> Result<Value, AgentMcpError> {
    let mut consumed = 0_usize;
    let mut elicitation_answer = elicitation_answer;
    loop {
        let (event, next_consumed) = read_stdio_response_event(reader, limit, id, consumed).await?;
        consumed = next_consumed;
        match event {
            StdioResponseEvent::Response(value) => return Ok(value),
            StdioResponseEvent::Elicitation(candidate) => {
                let Some(answer) = elicitation_answer.take() else {
                    return Err(AgentMcpError::ElicitationRequired(elicitation_message(
                        &candidate,
                    )));
                };
                let stdin = stdin.as_deref_mut().ok_or_else(|| {
                    AgentMcpError::ElicitationRequired(elicitation_message(&candidate))
                })?;
                write_stdio_elicitation_response(stdin, &candidate, answer).await?;
            }
        }
    }
}

enum StdioResponseEvent {
    Response(Value),
    Elicitation(Value),
}

async fn read_stdio_response_event<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    limit: usize,
    id: u64,
    mut consumed: usize,
) -> Result<(StdioResponseEvent, usize), AgentMcpError> {
    for _ in 0..64 {
        let raw = read_bounded_line(reader, limit.saturating_sub(consumed)).await?;
        consumed = consumed.saturating_add(raw.len());
        let Ok(candidate) = serde_json::from_slice::<Value>(&raw) else {
            return Err(AgentMcpError::Protocol);
        };
        if is_elicitation(&candidate) {
            return Ok((StdioResponseEvent::Elicitation(candidate), consumed));
        }
        if candidate.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if candidate.get("error").is_some() {
            return Err(AgentMcpError::Protocol);
        }
        return Ok((StdioResponseEvent::Response(candidate), consumed));
    }
    Err(AgentMcpError::Protocol)
}

async fn write_stdio_elicitation_response(
    stdin: &mut tokio::process::ChildStdin,
    request: &Value,
    answer: &str,
) -> Result<(), AgentMcpError> {
    let frame = json!({
        "jsonrpc": "2.0",
        "id": request.get("id").cloned().ok_or(AgentMcpError::Protocol)?,
        "result": {
            "action": "accept",
            "content": elicitation_content(request, answer)
        }
    });
    stdin
        .write_all(
            serde_json::to_string(&frame)
                .map_err(|_| AgentMcpError::Protocol)?
                .as_bytes(),
        )
        .await
        .map_err(|_| AgentMcpError::Transport)?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|_| AgentMcpError::Transport)?;
    stdin.flush().await.map_err(|_| AgentMcpError::Transport)
}

async fn read_bounded_line<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    limit: usize,
) -> Result<Vec<u8>, AgentMcpError> {
    let mut output = Vec::new();
    loop {
        let byte = reader
            .read_u8()
            .await
            .map_err(|_| AgentMcpError::Transport)?;
        if byte == b'\n' {
            return Ok(output);
        }
        if output.len() == limit {
            return Err(AgentMcpError::OutputTooLarge);
        }
        output.push(byte);
    }
}

async fn start_http_session(
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
) -> Result<HttpMcpSession, AgentMcpError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| AgentMcpError::Transport)?;
    let (_, session_id) = http_post(
        &client,
        server,
        secrets,
        None,
        1,
        "initialize",
        initialize_params(),
        None,
    )
    .await?;
    http_notify(
        &client,
        server,
        secrets,
        session_id.as_deref(),
        "notifications/initialized",
        json!({}),
    )
    .await?;
    Ok(HttpMcpSession {
        client,
        session_id,
        pending: None,
    })
}

impl HttpMcpSession {
    async fn request(
        &mut self,
        server: &McpServerDefinition,
        secrets: &McpSecretBundle,
        id: u64,
        method: &str,
        params: Value,
        elicitation_answer: Option<&str>,
    ) -> Result<Value, AgentMcpError> {
        if let Some(pending) = self.pending.take() {
            let Some(answer) = elicitation_answer else {
                let message = elicitation_message(&pending.elicitation);
                self.pending = Some(pending);
                return Err(AgentMcpError::ElicitationRequired(message));
            };
            http_respond_elicitation(
                &self.client,
                server,
                secrets,
                pending.session_id.as_deref(),
                &pending.elicitation,
                answer,
            )
            .await?;
            let answered_id = pending.elicitation.get("id").map(Value::to_string);
            return match consume_http_response(
                &self.client,
                server,
                secrets,
                pending.request_id,
                pending.response,
                pending.bytes,
                pending.session_id,
                None,
                answered_id,
            )
            .await?
            {
                HttpResponseOutcome::Complete(value) => Ok(value),
                HttpResponseOutcome::Elicitation(pending) => {
                    let message = elicitation_message(&pending.elicitation);
                    self.pending = Some(pending);
                    Err(AgentMcpError::ElicitationRequired(message))
                }
            };
        }
        let (response, session_id) = begin_http_request(
            &self.client,
            server,
            secrets,
            self.session_id.as_deref(),
            id,
            method,
            params,
        )
        .await?;
        if let Some(session_id) = session_id.as_ref() {
            self.session_id = Some(session_id.clone());
        }
        match consume_http_response(
            &self.client,
            server,
            secrets,
            id,
            response,
            Vec::new(),
            session_id,
            elicitation_answer,
            None,
        )
        .await?
        {
            HttpResponseOutcome::Complete(value) => Ok(value),
            HttpResponseOutcome::Elicitation(pending) => {
                let message = elicitation_message(&pending.elicitation);
                self.pending = Some(pending);
                Err(AgentMcpError::ElicitationRequired(message))
            }
        }
    }
}

fn initialize_params() -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {"name": "Clovy", "version": "1"}
    })
}

impl McpSessionSlot {
    async fn close(&mut self) {
        if let Some(PersistentMcpTransport::Stdio(session)) = self.transport.as_mut() {
            let _ = session.child.kill().await;
            let _ = session.child.wait().await;
        }
        self.transport = None;
        self.discovery_pages.clear();
    }
}

impl PersistentMcpTransport {
    fn has_pending_elicitation(&self) -> bool {
        match self {
            PersistentMcpTransport::Stdio(session) => session.pending.is_some(),
            PersistentMcpTransport::Http(session) => session.pending.is_some(),
        }
    }
}

pub async fn shutdown_sessions() {
    let Some(sessions) = MCP_SESSIONS.get() else {
        return;
    };
    let drained = {
        let mut sessions = sessions.lock().await;
        sessions
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>()
    };
    for session in drained {
        session.lock().await.close().await;
    }
}

pub(crate) async fn retire_server_sessions(server_id: &str) {
    let Some(sessions) = MCP_SESSIONS.get() else {
        return;
    };
    let retired = {
        let mut sessions = sessions.lock().await;
        let keys = sessions
            .keys()
            .filter(|key| key.starts_with(&format!("{server_id}:")))
            .cloned()
            .collect::<Vec<_>>();
        keys.into_iter()
            .filter_map(|key| sessions.remove(&key))
            .collect::<Vec<_>>()
    };
    for session in retired {
        session.lock().await.close().await;
    }
}

fn apply_http_credentials(
    mut request: reqwest::RequestBuilder,
    secrets: &McpSecretBundle,
) -> reqwest::RequestBuilder {
    for (key, value) in &secrets.headers {
        request = request.header(key, value);
    }
    if !secrets
        .headers
        .keys()
        .any(|key| key.eq_ignore_ascii_case("authorization"))
    {
        if let Some(token) = secrets
            .oauth
            .get("access_token")
            .filter(|value| !value.trim().is_empty())
        {
            request = request.bearer_auth(token);
        }
    }
    request
}

async fn http_notify(
    client: &reqwest::Client,
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
    session_id: Option<&str>,
    method: &str,
    params: Value,
) -> Result<(), AgentMcpError> {
    let url = server.url.as_deref().ok_or(AgentMcpError::Transport)?;
    let mut request = apply_http_credentials(
        client
            .post(url)
            .header("accept", "application/json, text/event-stream")
            .header("content-type", "application/json")
            .header("mcp-protocol-version", MCP_PROTOCOL_VERSION),
        secrets,
    );
    if let Some(session_id) = session_id {
        request = request.header("mcp-session-id", session_id);
    }
    let response = request
        .json(&json!({"jsonrpc":"2.0","method":method,"params":params}))
        .send()
        .await
        .map_err(|_| AgentMcpError::Transport)?;
    if response.status().is_success() {
        Ok(())
    } else if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        Err(AgentMcpError::Unauthorized)
    } else {
        Err(AgentMcpError::Transport)
    }
}

async fn http_post(
    client: &reqwest::Client,
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
    session_id: Option<&str>,
    id: u64,
    method: &str,
    params: Value,
    elicitation_answer: Option<&str>,
) -> Result<(Value, Option<String>), AgentMcpError> {
    let (response, session_id) =
        begin_http_request(client, server, secrets, session_id, id, method, params).await?;
    match consume_http_response(
        client,
        server,
        secrets,
        id,
        response,
        Vec::new(),
        session_id.clone(),
        elicitation_answer,
        None,
    )
    .await?
    {
        HttpResponseOutcome::Complete(value) => Ok((value, session_id)),
        HttpResponseOutcome::Elicitation(pending) => Err(AgentMcpError::ElicitationRequired(
            elicitation_message(&pending.elicitation),
        )),
    }
}

async fn begin_http_request(
    client: &reqwest::Client,
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
    session_id: Option<&str>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<(reqwest::Response, Option<String>), AgentMcpError> {
    let url = server.url.as_deref().ok_or(AgentMcpError::Transport)?;
    let mut request = apply_http_credentials(
        client
            .post(url)
            .header("accept", "application/json, text/event-stream")
            .header("content-type", "application/json")
            .header("mcp-protocol-version", MCP_PROTOCOL_VERSION),
        secrets,
    );
    if let Some(session_id) = session_id {
        request = request.header("mcp-session-id", session_id);
    }
    let response = request
        .json(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
        .send()
        .await
        .map_err(|_| AgentMcpError::Transport)?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AgentMcpError::Unauthorized);
    }
    if !response.status().is_success() {
        return Err(AgentMcpError::Transport);
    }
    let session_id = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    Ok((response, session_id))
}

enum HttpResponseOutcome {
    Complete(Value),
    Elicitation(PendingHttpRequest),
}

#[allow(clippy::too_many_arguments)]
async fn consume_http_response(
    client: &reqwest::Client,
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
    request_id: u64,
    mut response: reqwest::Response,
    mut bytes: Vec<u8>,
    session_id: Option<String>,
    mut elicitation_answer: Option<&str>,
    mut answered_elicitation: Option<String>,
) -> Result<HttpResponseOutcome, AgentMcpError> {
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AgentMcpError::Transport)?
    {
        if bytes.len().saturating_add(chunk.len()) > server.safety.max_output_bytes {
            return Err(AgentMcpError::OutputTooLarge);
        }
        bytes.extend_from_slice(&chunk);
        if let Some(elicitation) =
            find_unanswered_elicitation_request(&bytes, answered_elicitation.as_deref())
        {
            let elicitation_id = elicitation
                .get("id")
                .map(Value::to_string)
                .ok_or(AgentMcpError::Protocol)?;
            if answered_elicitation.as_deref() != Some(elicitation_id.as_str()) {
                let Some(answer) = elicitation_answer.take() else {
                    return Ok(HttpResponseOutcome::Elicitation(PendingHttpRequest {
                        request_id,
                        elicitation,
                        response,
                        bytes,
                        session_id,
                    }));
                };
                http_respond_elicitation(
                    client,
                    server,
                    secrets,
                    session_id.as_deref(),
                    &elicitation,
                    answer,
                )
                .await?;
                answered_elicitation = Some(elicitation_id);
            }
        }
    }
    Ok(HttpResponseOutcome::Complete(parse_mcp_response(
        &bytes, request_id,
    )?))
}

async fn http_respond_elicitation(
    client: &reqwest::Client,
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
    session_id: Option<&str>,
    elicitation: &Value,
    answer: &str,
) -> Result<(), AgentMcpError> {
    let url = server.url.as_deref().ok_or(AgentMcpError::Transport)?;
    let mut request = apply_http_credentials(
        client
            .post(url)
            .header("accept", "application/json, text/event-stream")
            .header("content-type", "application/json")
            .header("mcp-protocol-version", MCP_PROTOCOL_VERSION),
        secrets,
    );
    if let Some(session_id) = session_id {
        request = request.header("mcp-session-id", session_id);
    }
    let response = request
        .json(&json!({
            "jsonrpc": "2.0",
            "id": elicitation.get("id").cloned().ok_or(AgentMcpError::Protocol)?,
            "result": {
                "action": "accept",
                "content": elicitation_content(elicitation, answer)
            }
        }))
        .send()
        .await
        .map_err(|_| AgentMcpError::Transport)?;
    if response.status().is_success() {
        Ok(())
    } else if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        Err(AgentMcpError::Unauthorized)
    } else {
        Err(AgentMcpError::Transport)
    }
}

#[cfg(test)]
fn contains_elicitation_request(bytes: &[u8]) -> bool {
    find_elicitation_request(bytes).is_some()
}

#[cfg(test)]
fn find_elicitation_request(bytes: &[u8]) -> Option<Value> {
    find_unanswered_elicitation_request(bytes, None)
}

fn find_unanswered_elicitation_request(bytes: &[u8], answered_id: Option<&str>) -> Option<Value> {
    let Ok(raw) = std::str::from_utf8(bytes) else {
        return None;
    };
    serde_json::from_str(raw)
        .ok()
        .into_iter()
        .chain(
            raw.lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim)
                .filter_map(|data| serde_json::from_str(data).ok()),
        )
        .find(|candidate| {
            is_elicitation(candidate)
                && candidate.get("id").map(Value::to_string).as_deref() != answered_id
        })
}

fn is_elicitation(candidate: &Value) -> bool {
    candidate.get("method").and_then(Value::as_str) == Some("elicitation/create")
        && candidate.get("id").is_some()
}

fn elicitation_message(request: &Value) -> String {
    request
        .get("params")
        .and_then(|params| params.get("message"))
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or("Please provide the information requested by the MCP server.")
        .chars()
        .take(500)
        .collect()
}

fn elicitation_content(request: &Value, answer: &str) -> Value {
    if let Ok(value) = serde_json::from_str::<Value>(answer) {
        if value.is_object() {
            return value;
        }
    }
    let schema = request
        .get("params")
        .and_then(|params| {
            params
                .get("requestedSchema")
                .or_else(|| params.get("requested_schema"))
        })
        .and_then(Value::as_object);
    let field = schema
        .and_then(|schema| schema.get("properties"))
        .and_then(Value::as_object)
        .and_then(|properties| properties.keys().next())
        .cloned()
        .unwrap_or_else(|| "answer".into());
    json!({ field: answer })
}

fn parse_mcp_response(bytes: &[u8], id: u64) -> Result<Value, AgentMcpError> {
    let raw = std::str::from_utf8(bytes).map_err(|_| AgentMcpError::Protocol)?;
    let candidates = serde_json::from_str(raw)
        .ok()
        .into_iter()
        .chain(
            raw.lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim)
                .filter_map(|data| serde_json::from_str(data).ok()),
        )
        .collect::<Vec<Value>>();
    candidates
        .into_iter()
        .find(|candidate| candidate.get("id").and_then(Value::as_u64) == Some(id))
        .filter(|candidate| candidate.get("error").is_none())
        .ok_or(AgentMcpError::Protocol)
}

/// Identifiers for existing Rust-owned connector clients. These are intentionally
/// separate from a user-managed MCP server name: the connector path never
/// accepts third-party server configuration or credentials from the harness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeConnectorProvider {
    Gmail,
    Calendar,
    Linear,
    Github,
    Notion,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeConnectorCapability {
    pub provider: NativeConnectorProvider,
    pub capability_id: String,
    pub descriptor: RuntimeToolDescriptorJson,
}

/// Type-erased bridge point for existing provider-owned connector clients.
/// The runtime integration provides implementations backed by Google,
/// Calendar, Linear, GitHub, and Notion Rust code. No default implementation
/// intentionally exists: a missing provider must remove its descriptor rather
/// than advertise an unavailable capability.
pub trait NativeConnectorMcp: Send + Sync {
    fn catalog(&self) -> Result<Vec<NativeConnectorCapability>, AgentMcpError>;
    fn invoke(
        &self,
        capability_id: &str,
        arguments: Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Value, AgentMcpError>> + Send + '_>,
    >;
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpServerInput {
    pub id: Option<String>,
    pub name: String,
    pub enabled: Option<bool>,
    pub transport: McpTransport,
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub url: Option<String>,
    #[serde(default)]
    pub metadata: Value,
    #[serde(default)]
    pub tool_visibility: McpToolVisibility,
    #[serde(default)]
    pub safety: McpSafetyPolicy,
    /// Present means replace the keychain bundle. An omitted value preserves
    /// existing credentials during ordinary edits.
    pub secrets: Option<McpSecretBundle>,
}

impl AgentMcpServerInput {
    fn into_definition(self, existing: Option<&McpServerDefinition>) -> McpServerDefinition {
        McpServerDefinition {
            id: self
                .id
                .or_else(|| existing.map(|value| value.id.clone()))
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
            name: self.name,
            enabled: self
                .enabled
                .or_else(|| existing.map(|value| value.enabled))
                .unwrap_or(true),
            transport: self.transport,
            command: self.command,
            args: self.args,
            url: self.url,
            secret_ref: existing.and_then(|value| value.secret_ref.clone()),
            metadata: self.metadata,
            tool_visibility: self.tool_visibility,
            safety: self.safety,
        }
    }
}

fn app_error(error: AgentMcpError) -> crate::domain::types::AppError {
    crate::domain::types::AppError::new("agent_mcp_failed", error.to_string())
}

async fn command_repository(app: &AppHandle) -> Result<AgentMcpRepository, AgentMcpError> {
    let repositories = crate::commands::repositories(app)
        .await
        .map_err(|_| AgentMcpError::Storage)?;
    Ok(AgentMcpRepository::new(repositories.pool))
}

#[tauri::command]
pub async fn list_agent_mcp_servers(
    app: AppHandle,
) -> Result<Vec<McpServerDefinition>, crate::domain::types::AppError> {
    command_repository(&app)
        .await
        .map_err(app_error)?
        .list()
        .await
        .map_err(app_error)
}

#[tauri::command]
pub async fn create_agent_mcp_server(
    app: AppHandle,
    input: AgentMcpServerInput,
) -> Result<McpServerDefinition, crate::domain::types::AppError> {
    let secrets = input.secrets.clone();
    let mut definition = input.into_definition(None);
    let store = KeychainMcpSecretStore;
    if let Some(bundle) = secrets.as_ref() {
        if !bundle.env.is_empty() || !bundle.headers.is_empty() || !bundle.oauth.is_empty() {
            let secret_ref = Uuid::new_v4().to_string();
            store.put(&secret_ref, bundle).map_err(app_error)?;
            definition.secret_ref = Some(secret_ref);
        }
    }
    let repository = command_repository(&app).await.map_err(app_error)?;
    if let Err(error) = repository.create(&definition).await {
        if let Some(secret_ref) = definition.secret_ref.as_deref() {
            let _ = store.delete(secret_ref);
        }
        return Err(app_error(error));
    }
    Ok(definition)
}

#[tauri::command]
pub async fn update_agent_mcp_server(
    app: AppHandle,
    input: AgentMcpServerInput,
) -> Result<McpServerDefinition, crate::domain::types::AppError> {
    let id = input.id.clone().ok_or_else(|| {
        crate::domain::types::AppError::new("invalid_arguments", "An MCP server id is required.")
    })?;
    let repository = command_repository(&app).await.map_err(app_error)?;
    let existing = repository.get(&id).await.map_err(app_error)?;
    let replacement_secrets = input.secrets.clone();
    let mut definition = input.into_definition(Some(&existing));
    definition.validate_custom().map_err(app_error)?;
    let mut legacy_oauth = definition
        .metadata
        .get("legacyAuth")
        .and_then(Value::as_str)
        == Some("oauth");
    let supplied_supported_credentials = replacement_secrets
        .as_ref()
        .is_some_and(|bundle| !bundle.headers.is_empty());
    if legacy_oauth
        && definition.transport == McpTransport::StreamableHttp
        && supplied_supported_credentials
    {
        if let Some(metadata) = definition.metadata.as_object_mut() {
            metadata.remove("legacyAuth");
            metadata.remove("needsReview");
            metadata.remove("migrationWarning");
        }
        legacy_oauth = false;
    }
    if legacy_oauth && definition.enabled {
        return Err(crate::domain::types::AppError::new(
            "agent_mcp_oauth_reconnect_required",
            "Reconnect this OAuth MCP server before enabling it.",
        ));
    }
    if !legacy_oauth {
        if let Some(metadata) = definition.metadata.as_object_mut() {
            metadata.remove("needsReview");
            metadata.remove("migrationWarning");
        }
    }
    let store = KeychainMcpSecretStore;
    let previous_bundle = match existing.secret_ref.as_deref() {
        Some(secret_ref) => store.get(secret_ref).map_err(app_error)?,
        None => None,
    };
    if let Some(bundle) = replacement_secrets.as_ref() {
        let secret_ref = definition
            .secret_ref
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        if bundle.env.is_empty() && bundle.headers.is_empty() && bundle.oauth.is_empty() {
            if definition.secret_ref.is_some() {
                store.delete(&secret_ref).map_err(app_error)?;
            }
            definition.secret_ref = None;
        } else {
            store.put(&secret_ref, bundle).map_err(app_error)?;
            definition.secret_ref = Some(secret_ref);
        }
    }
    if let Err(error) = repository.replace(&definition).await {
        if replacement_secrets.is_some() {
            if let Some(secret_ref) = existing.secret_ref.as_deref() {
                if let Some(bundle) = previous_bundle.as_ref() {
                    let _ = store.put(secret_ref, bundle);
                }
            } else if let Some(secret_ref) = definition.secret_ref.as_deref() {
                let _ = store.delete(secret_ref);
            }
        }
        return Err(app_error(error));
    }
    retire_server_sessions(&id).await;
    Ok(definition)
}

#[tauri::command]
pub async fn delete_agent_mcp_server(
    app: AppHandle,
    server_id: String,
) -> Result<(), crate::domain::types::AppError> {
    let repository = command_repository(&app).await.map_err(app_error)?;
    let deleted = repository.delete(&server_id).await.map_err(app_error)?;
    retire_server_sessions(&server_id).await;
    if let Some(secret_ref) = deleted.secret_ref.as_deref() {
        // A failed cleanup leaves an unreachable keychain entry, never a
        // plaintext secret or a live duplicate registration.
        store_secret_cleanup(secret_ref);
    }
    Ok(())
}

fn store_secret_cleanup(secret_ref: &str) {
    if let Err(error) = KeychainMcpSecretStore.delete(secret_ref) {
        tracing::warn!(
            error_code = "agent_mcp_secret_cleanup_failed",
            error = %error,
            "MCP keychain cleanup did not complete"
        );
    }
}

#[tauri::command]
pub async fn test_agent_mcp_server(
    app: AppHandle,
    server_id: String,
) -> Result<Vec<McpDiscoveredTool>, crate::domain::types::AppError> {
    let repository = command_repository(&app).await.map_err(app_error)?;
    let server = repository.get(&server_id).await.map_err(app_error)?;
    let mut secrets = match server.secret_ref.as_deref() {
        Some(secret_ref) => KeychainMcpSecretStore
            .get(secret_ref)
            .map_err(app_error)?
            .unwrap_or_default(),
        None => McpSecretBundle::default(),
    };
    if refresh_oauth_bundle(&mut secrets, false)
        .await
        .map_err(app_error)?
    {
        if let Some(secret_ref) = server.secret_ref.as_deref() {
            KeychainMcpSecretStore
                .put(secret_ref, &secrets)
                .map_err(app_error)?;
            retire_server_sessions(&server.id).await;
        }
    }
    discover_server(&server, &secrets, None)
        .await
        .map_err(app_error)
}

#[tauri::command]
pub async fn connect_agent_mcp_oauth(
    app: AppHandle,
    server_id: String,
) -> Result<McpServerDefinition, crate::domain::types::AppError> {
    let repository = command_repository(&app).await.map_err(app_error)?;
    let existing = repository.get(&server_id).await.map_err(app_error)?;
    let store = KeychainMcpSecretStore;
    let old_bundle = match existing.secret_ref.as_deref() {
        Some(secret_ref) => store
            .get(secret_ref)
            .map_err(app_error)?
            .unwrap_or_default(),
        None => McpSecretBundle::default(),
    };
    let bundle = authorize_oauth_server(&existing, &old_bundle)
        .await
        .map_err(app_error)?;
    discover_server(&existing, &bundle, None)
        .await
        .map_err(app_error)?;

    let secret_ref = existing
        .secret_ref
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    store.put(&secret_ref, &bundle).map_err(app_error)?;
    let mut connected = existing.clone();
    connected.secret_ref = Some(secret_ref.clone());
    connected.enabled = true;
    let metadata = connected
        .metadata
        .as_object_mut()
        .ok_or_else(|| app_error(AgentMcpError::Storage))?;
    metadata.remove("legacyAuth");
    metadata.remove("needsReview");
    metadata.remove("migrationWarning");
    metadata.insert("auth".into(), json!("oauth"));
    metadata.insert("oauthConnected".into(), json!(true));
    if let Err(error) = repository.replace(&connected).await {
        if let Some(previous_ref) = existing.secret_ref.as_deref() {
            let _ = store.put(previous_ref, &old_bundle);
        } else {
            let _ = store.delete(&secret_ref);
        }
        return Err(app_error(error));
    }
    retire_server_sessions(&server_id).await;
    Ok(connected)
}

#[derive(Debug, Clone, PartialEq)]
pub struct LegacyMcpImport {
    pub definitions: Vec<McpServerDefinition>,
    pub secrets: Vec<(String, McpSecretBundle)>,
}

/// Parses old Hermes `config.yaml` / imported JSON while splitting every env
/// and header value into a keychain bundle. Callers persist `definitions` to
/// SQLite and `secrets` through [`McpSecretStore`]; they must never log this
/// return value.
pub fn parse_legacy_mcp_config(input: &str) -> Result<LegacyMcpImport, AgentMcpError> {
    let root: Value = serde_yaml::from_str(input).map_err(|_| {
        AgentMcpError::InvalidDefinition("legacy MCP config is not valid YAML".into())
    })?;
    let entries = root
        .get("mcp_servers")
        .or_else(|| root.get("mcpServers"))
        .and_then(Value::as_object)
        .ok_or_else(|| {
            AgentMcpError::InvalidDefinition("legacy MCP config has no mcp_servers object".into())
        })?;
    let mut definitions = Vec::new();
    let mut secrets = Vec::new();
    for (name, raw) in entries {
        let raw = raw.as_object().ok_or_else(|| {
            AgentMcpError::InvalidDefinition("legacy server is not an object".into())
        })?;
        let transport = if raw.get("command").and_then(Value::as_str).is_some() {
            McpTransport::Stdio
        } else {
            McpTransport::StreamableHttp
        };
        let mut definition = McpServerDefinition::new(name, transport);
        let mut id_hash = Sha256::new();
        id_hash.update(b"legacy-mcp:");
        id_hash.update(name.as_bytes());
        definition.id = format!("legacy-{:x}", id_hash.finalize());
        definition.enabled = raw.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        definition.command = raw
            .get("command")
            .or_else(|| raw.get("cmd"))
            .and_then(Value::as_str)
            .map(str::to_string);
        definition.args = raw
            .get("args")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        definition.url = raw
            .get("url")
            .or_else(|| raw.get("endpoint"))
            .and_then(Value::as_str)
            .map(str::to_string);
        definition.metadata = raw
            .get("metadata")
            .cloned()
            .unwrap_or_else(|| json!({"importedFrom":"legacy_hermes"}));
        let legacy_transport = raw.get("transport").and_then(Value::as_str);
        if let Some(legacy_transport) = legacy_transport {
            if !definition.metadata.is_object() {
                definition.metadata = json!({});
            }
            definition.metadata["legacyTransport"] = json!(legacy_transport);
            if matches!(legacy_transport, "sse" | "http-oauth") {
                let requested_enabled = definition.enabled;
                definition.enabled = false;
                definition.metadata["needsReview"] = json!(true);
                definition.metadata["legacyRequestedEnabled"] = json!(requested_enabled);
                definition.metadata["migrationWarning"] = json!(
                    "This legacy MCP transport needs to be reconfigured as Streamable HTTP before it can be enabled."
                );
            }
        }
        if let Some(tools) = raw.get("tools").and_then(Value::as_object) {
            definition.tool_visibility = McpToolVisibility {
                include: string_array(tools.get("include").or_else(|| tools.get("include_tools"))),
                exclude: string_array(tools.get("exclude").or_else(|| tools.get("exclude_tools"))),
            };
        }
        let bundle = McpSecretBundle {
            env: string_map(raw.get("env")),
            headers: string_map(raw.get("headers").or_else(|| raw.get("http_headers"))),
            oauth: string_map(raw.get("oauth")),
        };
        let legacy_oauth =
            raw.get("auth").and_then(Value::as_str) == Some("oauth") || raw.get("oauth").is_some();
        if legacy_oauth {
            let requested_enabled = definition.enabled;
            definition.enabled = false;
            if !definition.metadata.is_object() {
                definition.metadata = json!({});
            }
            definition.metadata["needsReview"] = json!(true);
            definition.metadata["legacyAuth"] = json!("oauth");
            definition.metadata["legacyRequestedEnabled"] = json!(requested_enabled);
            definition.metadata["migrationWarning"] = json!(
                "Reconnect this OAuth MCP server. Its legacy client configuration was retained in keychain, but Hermes OAuth tokens are not reused."
            );
        }
        if !bundle.env.is_empty() || !bundle.headers.is_empty() || !bundle.oauth.is_empty() {
            let reference = format!("legacy-{}", definition.id);
            definition.secret_ref = Some(reference.clone());
            secrets.push((reference, bundle));
        }
        if let Err(error) = definition.validate_custom() {
            let requested_enabled = definition.enabled;
            definition.enabled = false;
            if !definition.metadata.is_object() {
                definition.metadata = json!({});
            }
            definition.metadata["needsReview"] = json!(true);
            if definition.metadata.get("legacyRequestedEnabled").is_none() {
                definition.metadata["legacyRequestedEnabled"] = json!(requested_enabled);
            }
            definition.metadata["migrationWarning"] = json!(error.to_string());
        }
        definitions.push(definition);
    }
    Ok(LegacyMcpImport {
        definitions,
        secrets,
    })
}
fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}
fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx_sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::collections::HashMap;
    use std::str::FromStr;

    #[derive(Default)]
    struct MemorySecrets(Mutex<HashMap<String, McpSecretBundle>>);
    impl McpSecretStore for MemorySecrets {
        fn put(&self, id: &str, value: &McpSecretBundle) -> Result<(), AgentMcpError> {
            self.0.lock().unwrap().insert(id.into(), value.clone());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<Option<McpSecretBundle>, AgentMcpError> {
            Ok(self.0.lock().unwrap().get(id).cloned())
        }
        fn delete(&self, id: &str) -> Result<(), AgentMcpError> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    #[test]
    fn oauth_metadata_candidates_follow_protected_resource_paths() {
        let resource = reqwest::Url::parse("https://tools.example.com/team/mcp").unwrap();
        let urls = protected_resource_metadata_urls(&resource)
            .unwrap()
            .into_iter()
            .map(|url| url.to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            urls,
            vec![
                "https://tools.example.com/.well-known/oauth-protected-resource/team/mcp",
                "https://tools.example.com/.well-known/oauth-protected-resource",
            ]
        );
        let issuer = reqwest::Url::parse("https://identity.example.com/tenant").unwrap();
        let urls = authorization_server_metadata_urls(&issuer)
            .unwrap()
            .into_iter()
            .map(|url| url.to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            urls,
            vec![
                "https://identity.example.com/.well-known/oauth-authorization-server/tenant",
                "https://identity.example.com/.well-known/openid-configuration/tenant",
            ]
        );
    }

    #[test]
    fn oauth_challenge_extracts_quoted_and_unquoted_resource_metadata() {
        assert_eq!(
            resource_metadata_from_challenge(
                r#"Bearer realm="mcp", resource_metadata="https://tools.example.com/.well-known/oauth-protected-resource""#
            ),
            Some("https://tools.example.com/.well-known/oauth-protected-resource")
        );
        assert_eq!(
            resource_metadata_from_challenge(
                "Bearer resource_metadata=https://tools.example.com/oauth-resource, scope=read"
            ),
            Some("https://tools.example.com/oauth-resource")
        );
        assert_eq!(resource_metadata_from_challenge("Bearer realm=mcp"), None);
    }

    #[test]
    fn oauth_authorization_uses_pkce_resource_scope_and_state() {
        let auth = OAuthAuthorizationServerMetadata {
            issuer: "https://identity.example.com".into(),
            authorization_endpoint: "https://identity.example.com/authorize".into(),
            token_endpoint: "https://identity.example.com/token".into(),
            registration_endpoint: None,
            response_types_supported: vec!["code".into()],
            grant_types_supported: vec!["authorization_code".into()],
            code_challenge_methods_supported: vec!["S256".into()],
        };
        let url = oauth_authorization_url(
            &auth,
            "client",
            "http://127.0.0.1:1234/callback",
            "challenge",
            "state",
            "https://tools.example.com/mcp",
            "read write",
        )
        .unwrap();
        let parsed = reqwest::Url::parse(&url).unwrap();
        let query = parsed.query_pairs().collect::<BTreeMap<_, _>>();
        assert_eq!(query.get("code_challenge_method").unwrap(), "S256");
        assert_eq!(
            query.get("resource").unwrap(),
            "https://tools.example.com/mcp"
        );
        assert_eq!(query.get("scope").unwrap(), "read write");
        assert_eq!(query.get("state").unwrap(), "state");
    }

    #[test]
    fn secret_debug_output_contains_keys_but_not_values() {
        let bundle = McpSecretBundle {
            env: BTreeMap::from([("TOKEN".into(), "env-secret".into())]),
            headers: BTreeMap::from([("Authorization".into(), "header-secret".into())]),
            oauth: BTreeMap::from([("access_token".into(), "oauth-secret".into())]),
        };
        let output = format!("{bundle:?}");
        assert!(output.contains("access_token"));
        assert!(!output.contains("env-secret"));
        assert!(!output.contains("header-secret"));
        assert!(!output.contains("oauth-secret"));
    }

    #[tokio::test]
    async fn oauth_refresh_rotates_access_and_refresh_tokens() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let read = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.contains("grant_type=refresh_token"));
            assert!(request.contains("refresh_token=old-refresh"));
            let body =
                r#"{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let mut bundle = McpSecretBundle::default();
        bundle.oauth = BTreeMap::from([
            ("access_token".into(), "old-access".into()),
            ("refresh_token".into(), "old-refresh".into()),
            ("client_id".into(), "client".into()),
            (
                "token_endpoint".into(),
                format!("http://127.0.0.1:{port}/token"),
            ),
            ("expires_at_unix".into(), "0".into()),
        ]);
        assert!(refresh_oauth_bundle(&mut bundle, false).await.unwrap());
        server.await.unwrap();
        assert_eq!(bundle.oauth["access_token"], "new-access");
        assert_eq!(bundle.oauth["refresh_token"], "new-refresh");
        assert!(bundle.oauth["expires_at_unix"].parse::<i64>().unwrap() > oauth_now_unix());
    }
    async fn repository() -> AgentMcpRepository {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::from_str("sqlite::memory:").unwrap())
            .await
            .unwrap();
        let repo = AgentMcpRepository::new(pool);
        repo.ensure_schema().await.unwrap();
        repo
    }
    #[test]
    fn legacy_import_never_serializes_plaintext_secrets() {
        let import = parse_legacy_mcp_config("mcp_servers:\n  private:\n    command: node\n    args: [server.js]\n    env: {TOKEN: top-secret}\n    headers: {Authorization: Bearer also-secret}\n").unwrap();
        assert_eq!(import.definitions.len(), 1);
        assert_eq!(import.secrets.len(), 1);
        let serialized = serde_json::to_string(&import.definitions).unwrap();
        assert!(!serialized.contains("top-secret") && !serialized.contains("also-secret"));
        assert!(import.definitions[0].secret_ref.is_some());
        let memory = MemorySecrets::default();
        let (reference, bundle) = &import.secrets[0];
        memory.put(reference, bundle).unwrap();
        assert_eq!(memory.get(reference).unwrap(), Some(bundle.clone()));
    }
    #[test]
    fn legacy_oauth_configuration_is_keychain_only_and_requires_reconnect() {
        let import = parse_legacy_mcp_config(
            "mcp_servers:\n  oauth_tools:\n    url: https://example.test/mcp\n    auth: oauth\n    oauth: {client_id: public-id, client_secret: top-secret}\n",
        )
        .unwrap();
        let definition = &import.definitions[0];
        assert!(!definition.enabled);
        assert_eq!(definition.metadata["needsReview"], true);
        assert!(!serde_json::to_string(definition)
            .unwrap()
            .contains("top-secret"));
        assert_eq!(import.secrets[0].1.oauth["client_secret"], "top-secret");
    }
    #[tokio::test]
    async fn server_definition_round_trips_and_stays_nonsecret() {
        let repo = repository().await;
        let mut definition = McpServerDefinition::new("docs", McpTransport::StreamableHttp);
        definition.url = Some("https://example.test/mcp".into());
        definition.secret_ref = Some("secret-1".into());
        repo.create(&definition).await.unwrap();
        let restored = repo.list().await.unwrap();
        assert_eq!(restored, vec![definition]);
        let raw: String = query("SELECT command || args_json || COALESCE(url, '') || COALESCE(secret_ref, '') || metadata_json || tool_visibility_json || safety_json AS raw FROM agent_mcp_servers WHERE name = ?")
            .bind("docs")
            .fetch_one(&repo.pool)
            .await
            .unwrap()
            .get("raw");
        assert!(!raw.contains("Bearer ") && !raw.contains("top-secret"));
    }
    #[tokio::test]
    async fn human_readable_server_names_match_the_settings_ui_contract() {
        let repo = repository().await;
        let mut definition = McpServerDefinition::new("Private tools", McpTransport::Stdio);
        definition.command = Some("node".into());

        repo.create(&definition).await.unwrap();

        assert_eq!(repo.list().await.unwrap()[0].name, "Private tools");
        assert_eq!(
            runtime_tool_name("Private tools", "list_tasks").unwrap(),
            "mcp_private_tools_list_tasks"
        );
    }
    #[tokio::test]
    async fn duplicate_names_are_rejected_across_repository_restart() {
        let repo = repository().await;
        let mut first = McpServerDefinition::new("same", McpTransport::Stdio);
        first.command = Some("node".into());
        repo.create(&first).await.unwrap();
        let restarted = AgentMcpRepository::new(repo.pool.clone());
        let mut duplicate = McpServerDefinition::new("same", McpTransport::Stdio);
        duplicate.command = Some("node".into());
        assert!(matches!(
            restarted.create(&duplicate).await,
            Err(AgentMcpError::DuplicateServer)
        ));
    }

    #[tokio::test]
    async fn custom_servers_cannot_claim_the_managed_linear_id() {
        let repo = repository().await;
        let mut custom = McpServerDefinition::new("custom linear", McpTransport::Stdio);
        custom.id = MANAGED_LINEAR_SERVER_ID.into();
        custom.command = Some("node".into());

        assert!(matches!(
            repo.create(&custom).await,
            Err(AgentMcpError::InvalidDefinition(_))
        ));
        assert!(repo.list().await.unwrap().is_empty());

        let mut registry = McpToolRegistry::default();
        assert!(matches!(
            registry.register(&custom, Vec::new()),
            Err(AgentMcpError::InvalidDefinition(_))
        ));
        assert!(managed_linear_definition().validate().is_ok());

        query(
            "INSERT INTO agent_mcp_servers
             (id, name, enabled, transport, command, args_json, url, secret_ref,
              metadata_json, tool_visibility_json, safety_json, created_at, updated_at)
             VALUES
             ('builtin:linear', 'legacy collision', 1, 'stdio', 'must-not-spawn', '[]',
              NULL, NULL, '{}', '{}', '{}', '2026-01-01T00:00:00Z',
              '2026-01-01T00:00:00Z')",
        )
        .execute(&repo.pool)
        .await
        .unwrap();
        let subsystem = AgentMcpSubsystem::new(repo, MemorySecrets::default());
        assert!(subsystem
            .refresh_registry_for(false)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn active_run_rejects_a_server_definition_changed_after_snapshot() {
        let repo = repository().await;
        query(
            "CREATE TABLE agent_runs (
                id TEXT PRIMARY KEY,
                mcp_policy_snapshotted INTEGER NOT NULL DEFAULT 0
             )",
        )
        .execute(&repo.pool)
        .await
        .unwrap();
        for statement in include_str!("../migrations/028_agent_run_mcp_policy.sql")
            .split(';')
            .filter(|statement| !statement.trim().is_empty())
        {
            query(statement).execute(&repo.pool).await.unwrap();
        }
        query("INSERT INTO agent_runs (id) VALUES ('run-1')")
            .execute(&repo.pool)
            .await
            .unwrap();
        let mut server = McpServerDefinition::new("docs", McpTransport::StreamableHttp);
        server.url = Some("https://example.test/mcp".into());
        repo.create(&server).await.unwrap();
        let descriptor = RuntimeToolDescriptorJson {
            id: format!("mcp:{}/search", server.id),
            name: "mcp_docs_search".into(),
            description: "Search docs".into(),
            parameters: json!({"type":"object","properties":{}}),
            strict: None,
            requires_approval: None,
            approval_provider: None,
            approval_remote_tool_name: None,
            policy_fingerprint: None,
        };
        snapshot_run_policies(&repo.pool, "run-1", std::slice::from_ref(&descriptor))
            .await
            .unwrap();
        let policy = McpToolPolicy {
            server_id: server.id.clone(),
            requires_approval: false,
            policy_fingerprint: None,
        };
        assert!(
            run_policy_matches(&repo.pool, "run-1", &descriptor.name, &policy)
                .await
                .unwrap()
        );
        query("UPDATE agent_mcp_servers SET updated_at = 'changed' WHERE id = ?")
            .bind(&server.id)
            .execute(&repo.pool)
            .await
            .unwrap();
        snapshot_run_policies(&repo.pool, "run-1", std::slice::from_ref(&descriptor))
            .await
            .unwrap();
        assert!(
            !run_policy_matches(&repo.pool, "run-1", &descriptor.name, &policy)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn managed_linear_policy_snapshot_binds_the_exact_hosted_tool_contract() {
        let repo = repository().await;
        query(
            "CREATE TABLE agent_runs (
                id TEXT PRIMARY KEY,
                mcp_policy_snapshotted INTEGER NOT NULL DEFAULT 0
             )",
        )
        .execute(&repo.pool)
        .await
        .unwrap();
        for statement in include_str!("../migrations/028_agent_run_mcp_policy.sql")
            .split(';')
            .filter(|statement| !statement.trim().is_empty())
        {
            query(statement).execute(&repo.pool).await.unwrap();
        }
        query("INSERT INTO agent_runs (id) VALUES ('run-linear')")
            .execute(&repo.pool)
            .await
            .unwrap();
        let annotations = McpToolAnnotations::from_hints(None, Some(false));
        let input_schema = json!({
            "type":"object",
            "properties":{"title":{"type":"string"}}
        });
        let fingerprint = managed_linear_policy_fingerprint(&McpDiscoveredTool {
            name: "save-issue".into(),
            description: "Save an issue".into(),
            input_schema: input_schema.clone(),
            annotations: annotations.clone(),
        })
        .unwrap();
        let descriptor = RuntimeToolDescriptorJson {
            id: format!("mcp:{MANAGED_LINEAR_SERVER_ID}/save-issue"),
            name: "mcp_linear_save_issue".into(),
            description: "Save an issue".into(),
            parameters: input_schema.clone(),
            strict: Some(false),
            requires_approval: Some(true),
            approval_provider: Some("Linear".into()),
            approval_remote_tool_name: Some("save-issue".into()),
            policy_fingerprint: Some(fingerprint.clone()),
        };

        snapshot_run_policies(&repo.pool, "run-linear", std::slice::from_ref(&descriptor))
            .await
            .unwrap();

        let policy = McpToolPolicy {
            server_id: MANAGED_LINEAR_SERVER_ID.into(),
            requires_approval: true,
            policy_fingerprint: Some(fingerprint),
        };
        assert!(
            run_policy_matches(&repo.pool, "run-linear", &descriptor.name, &policy)
                .await
                .unwrap()
        );
        assert!(!run_policy_matches(
            &repo.pool,
            "run-linear",
            &descriptor.name,
            &McpToolPolicy {
                server_id: MANAGED_LINEAR_SERVER_ID.into(),
                requires_approval: true,
                policy_fingerprint: None,
            },
        )
        .await
        .unwrap());
        for changed_tool in [
            McpDiscoveredTool {
                name: "save.issue".into(),
                description: "Save an issue".into(),
                input_schema: input_schema.clone(),
                annotations: annotations.clone(),
            },
            McpDiscoveredTool {
                name: "save-issue".into(),
                description: "Save an issue".into(),
                input_schema: json!({
                    "type":"object",
                    "properties":{"issueId":{"type":"string"}}
                }),
                annotations: annotations.clone(),
            },
            McpDiscoveredTool {
                name: "save-issue".into(),
                description: "Save an issue".into(),
                input_schema: input_schema.clone(),
                annotations: McpToolAnnotations::from_hints(Some(false), Some(false)),
            },
            McpDiscoveredTool {
                name: "save-issue".into(),
                description: "Save an issue".into(),
                input_schema: input_schema.clone(),
                annotations: McpToolAnnotations::from_raw(json!({
                    "destructiveHint": false,
                    "idempotentHint": true
                })),
            },
        ] {
            assert!(!run_policy_matches(
                &repo.pool,
                "run-linear",
                &descriptor.name,
                &McpToolPolicy {
                    server_id: MANAGED_LINEAR_SERVER_ID.into(),
                    requires_approval: true,
                    policy_fingerprint: Some(
                        managed_linear_policy_fingerprint(&changed_tool).unwrap()
                    ),
                },
            )
            .await
            .unwrap());
        }

        query("INSERT INTO agent_runs (id) VALUES ('run-linear-missing-fingerprint')")
            .execute(&repo.pool)
            .await
            .unwrap();
        let mut missing_fingerprint = descriptor;
        missing_fingerprint.policy_fingerprint = None;
        assert!(matches!(
            snapshot_run_policies(
                &repo.pool,
                "run-linear-missing-fingerprint",
                &[missing_fingerprint],
            )
            .await,
            Err(AgentMcpError::Storage)
        ));
    }

    #[tokio::test]
    async fn empty_run_policy_snapshot_cannot_gain_a_server_on_resume() {
        let repo = repository().await;
        query(
            "CREATE TABLE agent_runs (
                id TEXT PRIMARY KEY,
                mcp_policy_snapshotted INTEGER NOT NULL DEFAULT 0
             )",
        )
        .execute(&repo.pool)
        .await
        .unwrap();
        for statement in include_str!("../migrations/028_agent_run_mcp_policy.sql")
            .split(';')
            .filter(|statement| !statement.trim().is_empty())
        {
            query(statement).execute(&repo.pool).await.unwrap();
        }
        query("INSERT INTO agent_runs (id) VALUES ('run-empty')")
            .execute(&repo.pool)
            .await
            .unwrap();
        snapshot_run_policies(&repo.pool, "run-empty", &[])
            .await
            .unwrap();

        let mut server = McpServerDefinition::new("later", McpTransport::StreamableHttp);
        server.url = Some("https://example.test/mcp".into());
        repo.create(&server).await.unwrap();
        let descriptor = RuntimeToolDescriptorJson {
            id: format!("mcp:{}/search", server.id),
            name: "mcp_later_search".into(),
            description: "Search later".into(),
            parameters: json!({"type":"object","properties":{}}),
            strict: None,
            requires_approval: None,
            approval_provider: None,
            approval_remote_tool_name: None,
            policy_fingerprint: None,
        };
        snapshot_run_policies(&repo.pool, "run-empty", &[descriptor])
            .await
            .unwrap();

        let policy_count: i64 = query(
            "SELECT COUNT(*) AS count
             FROM agent_run_mcp_policies
             WHERE run_id = 'run-empty'",
        )
        .fetch_one(&repo.pool)
        .await
        .unwrap()
        .get("count");
        assert_eq!(policy_count, 0);
    }
    #[test]
    fn transport_validation_rejects_ambiguous_and_unsafe_shapes() {
        let mut stdio = McpServerDefinition::new("x", McpTransport::Stdio);
        assert!(stdio.validate().is_err());
        stdio.command = Some("node".into());
        stdio.url = Some("https://example.test".into());
        assert!(stdio.validate().is_err());
        let mut http = McpServerDefinition::new("x", McpTransport::StreamableHttp);
        http.url = Some("file:///tmp/server".into());
        assert!(http.validate().is_err());
        http.url = Some("http://tools.example.test/mcp".into());
        assert!(http.validate().is_err());
        http.url = Some("http://127.0.0.1:8787/mcp".into());
        assert!(http.validate().is_ok());
    }
    #[test]
    fn sandboxed_stdio_requires_a_macos_workspace_boundary() {
        let mut stdio = McpServerDefinition::new("local", McpTransport::Stdio);
        stdio.command = Some("node".into());
        assert!(server_available(&stdio, false, None));
        assert!(!server_available(&stdio, true, None));
        assert_eq!(
            server_available(&stdio, true, Some(std::path::Path::new("/tmp/workspace"))),
            cfg!(target_os = "macos")
        );
        let mut http = McpServerDefinition::new("remote", McpTransport::StreamableHttp);
        http.url = Some("https://example.test/mcp".into());
        assert!(server_available(&http, true, None));
    }
    #[tokio::test]
    async fn stdio_response_reader_ignores_server_notifications() {
        let (mut writer, reader) = tokio::io::duplex(1024);
        tokio::spawn(async move {
            writer
                .write_all(
                    b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{}}\n{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"tools\":[]}}\n",
                )
                .await
                .unwrap();
        });
        let mut reader = BufReader::new(reader);
        let response = read_stdio_response(&mut reader, 1024, 3).await.unwrap();
        assert_eq!(response["result"]["tools"], json!([]));
    }
    #[tokio::test]
    async fn stdio_session_preserves_server_state_across_discovery_and_calls() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let directory = tempfile::tempdir().unwrap();
            let script = directory.path().join("stateful-mcp.sh");
            std::fs::write(
                &script,
                r#"#!/bin/sh
count=0
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"stateful","version":"1"}}}\n' "$id"
      ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"increment","description":"Increment","inputSchema":{"type":"object","properties":{}}}]}}\n' "$id"
      ;;
    *'"method":"tools/call"'*)
      count=$((count + 1))
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"%s"}],"count":%s}}\n' "$id" "$count" "$count"
      ;;
  esac
done
"#,
            )
            .unwrap();
            let mut permissions = std::fs::metadata(&script).unwrap().permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(&script, permissions).unwrap();

            let mut server = McpServerDefinition::new(
                format!("stateful-{}", Uuid::new_v4()),
                McpTransport::Stdio,
            );
            server.command = Some(script.to_string_lossy().into_owned());
            let secrets = McpSecretBundle::default();

            let tools = discover_server(&server, &secrets, None).await.unwrap();
            assert_eq!(tools[0].name, "increment");
            let first = call_server(&server, &secrets, "increment", json!({}), None, None, None)
                .await
                .unwrap();
            let second = call_server(&server, &secrets, "increment", json!({}), None, None, None)
                .await
                .unwrap();

            assert_eq!(first["count"], 1);
            assert_eq!(second["count"], 2);
            retire_server_sessions(&server.id).await;
        }
    }
    #[tokio::test]
    async fn http_session_reuses_one_initialized_server_session() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let initialize_count = Arc::new(AtomicUsize::new(0));
        let tool_count = Arc::new(AtomicUsize::new(0));
        let initialize_count_server = initialize_count.clone();
        let tool_count_server = tool_count.clone();
        let server_task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let read = stream.read(&mut buffer).await.unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    let Some(headers_end) =
                        request.windows(4).position(|window| window == b"\r\n\r\n")
                    else {
                        continue;
                    };
                    let headers = String::from_utf8_lossy(&request[..headers_end]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if request.len() >= headers_end + 4 + content_length {
                        break;
                    }
                }
                let body_start = request
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .unwrap()
                    + 4;
                let frame: Value = serde_json::from_slice(&request[body_start..]).unwrap();
                let method = frame
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let response = match method {
                    "initialize" => {
                        initialize_count_server.fetch_add(1, Ordering::SeqCst);
                        Some(
                            json!({"jsonrpc":"2.0","id":frame["id"],"result":{"protocolVersion":MCP_PROTOCOL_VERSION,"capabilities":{},"serverInfo":{"name":"stateful-http","version":"1"}}}),
                        )
                    }
                    "tools/list" => Some(
                        json!({"jsonrpc":"2.0","id":frame["id"],"result":{"tools":[{"name":"increment","description":"Increment","inputSchema":{"type":"object","properties":{}}}]}}),
                    ),
                    "tools/call" => {
                        let count = tool_count_server.fetch_add(1, Ordering::SeqCst) + 1;
                        Some(
                            json!({"jsonrpc":"2.0","id":frame["id"],"result":{"content":[{"type":"text","text":count.to_string()}],"count":count}}),
                        )
                    }
                    _ => None,
                };
                let (status, body) = response.map_or_else(
                    || ("202 Accepted", String::new()),
                    |value| ("200 OK", value.to_string()),
                );
                let headers = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\nmcp-session-id: stable-session\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(headers.as_bytes()).await.unwrap();
                stream.write_all(body.as_bytes()).await.unwrap();
            }
        });

        let mut server = McpServerDefinition::new(
            format!("http-{}", Uuid::new_v4()),
            McpTransport::StreamableHttp,
        );
        server.url = Some(format!("http://{address}/mcp"));
        let secrets = McpSecretBundle::default();
        discover_server(&server, &secrets, None).await.unwrap();
        let first = call_server(&server, &secrets, "increment", json!({}), None, None, None)
            .await
            .unwrap();
        let second = call_server(&server, &secrets, "increment", json!({}), None, None, None)
            .await
            .unwrap();

        assert_eq!(first["count"], 1);
        assert_eq!(second["count"], 2);
        assert_eq!(initialize_count.load(Ordering::SeqCst), 1);
        retire_server_sessions(&server.id).await;
        server_task.abort();
    }

    #[tokio::test]
    async fn http_elicitation_answer_resumes_the_original_tool_call() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
            sync::{Mutex as TokioMutex, Notify},
        };

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let answer = Arc::new(TokioMutex::new(None::<Value>));
        let answer_ready = Arc::new(Notify::new());
        let tool_calls = Arc::new(AtomicUsize::new(0));
        let discovery_calls = Arc::new(AtomicUsize::new(0));
        let server_task = tokio::spawn({
            let answer = answer.clone();
            let answer_ready = answer_ready.clone();
            let tool_calls = tool_calls.clone();
            let discovery_calls = discovery_calls.clone();
            async move {
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let answer = answer.clone();
                    let answer_ready = answer_ready.clone();
                    let tool_calls = tool_calls.clone();
                    let discovery_calls = discovery_calls.clone();
                    tokio::spawn(async move {
                        let mut request = Vec::new();
                        let mut buffer = [0_u8; 4096];
                        loop {
                            let read = stream.read(&mut buffer).await.unwrap();
                            if read == 0 {
                                break;
                            }
                            request.extend_from_slice(&buffer[..read]);
                            let Some(headers_end) =
                                request.windows(4).position(|window| window == b"\r\n\r\n")
                            else {
                                continue;
                            };
                            let headers = String::from_utf8_lossy(&request[..headers_end]);
                            let content_length = headers
                                .lines()
                                .find_map(|line| {
                                    let (name, value) = line.split_once(':')?;
                                    name.eq_ignore_ascii_case("content-length")
                                        .then(|| value.trim().parse::<usize>().ok())
                                        .flatten()
                                })
                                .unwrap_or(0);
                            if request.len() >= headers_end + 4 + content_length {
                                break;
                            }
                        }
                        let body_start = request
                            .windows(4)
                            .position(|window| window == b"\r\n\r\n")
                            .unwrap()
                            + 4;
                        let frame: Value = serde_json::from_slice(&request[body_start..]).unwrap();
                        match frame.get("method").and_then(Value::as_str) {
                            Some("initialize") => {
                                let body = json!({
                                    "jsonrpc": "2.0",
                                    "id": frame["id"],
                                    "result": {
                                        "protocolVersion": MCP_PROTOCOL_VERSION,
                                        "capabilities": {"elicitation": {}},
                                        "serverInfo": {"name": "eliciting-http", "version": "1"}
                                    }
                                })
                                .to_string();
                                let headers = format!(
                                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nmcp-session-id: elicitation-session\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                                    body.len()
                                );
                                stream.write_all(headers.as_bytes()).await.unwrap();
                                stream.write_all(body.as_bytes()).await.unwrap();
                            }
                            Some("notifications/initialized") => {
                                stream
                                    .write_all(
                                        b"HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                                    )
                                    .await
                                    .unwrap();
                            }
                            Some("tools/list") => {
                                discovery_calls.fetch_add(1, Ordering::SeqCst);
                                let body = if frame["params"]["cursor"] == json!("page-2") {
                                    json!({
                                        "jsonrpc": "2.0",
                                        "id": frame["id"],
                                        "result": {
                                            "tools": [{
                                                "name": "other",
                                                "inputSchema": {"type": "object"}
                                            }]
                                        }
                                    })
                                } else {
                                    json!({
                                        "jsonrpc": "2.0",
                                        "id": frame["id"],
                                        "result": {
                                            "tools": [{
                                                "name": "choose",
                                                "inputSchema": {"type": "object"}
                                            }],
                                            "nextCursor": "page-2"
                                        }
                                    })
                                }
                                .to_string();
                                let headers = format!(
                                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nmcp-session-id: elicitation-session\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                                    body.len()
                                );
                                stream.write_all(headers.as_bytes()).await.unwrap();
                                stream.write_all(body.as_bytes()).await.unwrap();
                            }
                            Some("tools/call") => {
                                tool_calls.fetch_add(1, Ordering::SeqCst);
                                stream
                                    .write_all(
                                        b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nmcp-session-id: elicitation-session\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n",
                                    )
                                    .await
                                    .unwrap();
                                let question = concat!(
                                    "event: message\n",
                                    "data: {\"jsonrpc\":\"2.0\",\"id\":\"question-1\",",
                                    "\"method\":\"elicitation/create\",\"params\":{",
                                    "\"message\":\"Choose a project\",\"requestedSchema\":{",
                                    "\"type\":\"object\",\"properties\":{\"project\":{",
                                    "\"type\":\"string\"}}}}}\n\n"
                                );
                                stream
                                    .write_all(
                                        format!("{:X}\r\n{question}\r\n", question.len())
                                            .as_bytes(),
                                    )
                                    .await
                                    .unwrap();
                                stream.flush().await.unwrap();
                                while answer.lock().await.is_none() {
                                    answer_ready.notified().await;
                                }
                                let selected = answer
                                    .lock()
                                    .await
                                    .as_ref()
                                    .and_then(|value| value.get("project"))
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string();
                                let result = format!(
                                    "event: message\ndata: {}\n\n",
                                    json!({
                                        "jsonrpc": "2.0",
                                        "id": frame["id"],
                                        "result": {
                                            "content": [{"type": "text", "text": format!("{selected} selected")}]
                                        }
                                    })
                                );
                                stream
                                    .write_all(
                                        format!("{:X}\r\n{result}\r\n0\r\n\r\n", result.len())
                                            .as_bytes(),
                                    )
                                    .await
                                    .unwrap();
                            }
                            None if frame.get("result").is_some() => {
                                *answer.lock().await = frame
                                    .get("result")
                                    .and_then(|result| result.get("content"))
                                    .cloned();
                                answer_ready.notify_waiters();
                                stream
                                    .write_all(
                                        b"HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                                    )
                                    .await
                                    .unwrap();
                            }
                            _ => {
                                stream
                                    .write_all(
                                        b"HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                                    )
                                    .await
                                    .unwrap();
                            }
                        }
                    });
                }
            }
        });

        let mut server = McpServerDefinition::new(
            format!("eliciting-http-{}", Uuid::new_v4()),
            McpTransport::StreamableHttp,
        );
        server.name = MANAGED_LINEAR_SERVER_NAME.to_string();
        server.url = Some(format!("http://{address}/mcp"));
        let lifecycle_account = format!("linear-elicit-{}", Uuid::new_v4());
        let lifecycle_guard = crate::connectors::acquire_linear_lifecycle(&lifecycle_account).await;
        let lifecycle = lifecycle_guard.snapshot();
        drop(lifecycle_guard);
        let discovered =
            discover_managed_server(&server, &McpSecretBundle::default(), None, &lifecycle)
                .await
                .unwrap();
        assert_eq!(
            discovered
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            vec!["choose", "other"]
        );
        let first = call_server(
            &server,
            &McpSecretBundle::default(),
            "choose",
            json!({}),
            None,
            None,
            Some(&lifecycle),
        )
        .await;
        assert!(matches!(first, Err(AgentMcpError::ElicitationRequired(_))));
        // A resumed turn recreates its registry. Discovery must use the page
        // cached before the tool call instead of colliding with the parked
        // elicitation in the persistent session. Both managed cursor pages
        // must replay without another server request.
        let rediscovered =
            discover_managed_server(&server, &McpSecretBundle::default(), None, &lifecycle)
                .await
                .unwrap();
        let mut registry = McpToolRegistry::default();
        registry
            .register_managed_linear(&server, rediscovered)
            .unwrap();
        assert!(registry.resolve("mcp_linear_choose").is_some());
        let result = call_server(
            &server,
            &McpSecretBundle::default(),
            "choose",
            json!({}),
            None,
            Some("Alpha"),
            Some(&lifecycle),
        )
        .await
        .unwrap();

        assert_eq!(result["content"][0]["text"], "Alpha selected");
        assert_eq!(tool_calls.load(Ordering::SeqCst), 1);
        assert_eq!(discovery_calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            answer.lock().await.as_ref().unwrap()["project"],
            json!("Alpha")
        );
        retire_server_sessions(&server.id).await;
        server_task.abort();
    }

    #[tokio::test]
    async fn stdio_session_reconnects_once_after_server_exit_and_retires_cleanly() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let directory = tempfile::tempdir().unwrap();
            let script = directory.path().join("restarting-mcp.sh");
            let generations = directory.path().join("generations");
            std::fs::write(
                &script,
                r#"#!/bin/sh
generations="$1"
generation=0
if [ -f "$generations" ]; then generation=$(cat "$generations"); fi
generation=$((generation + 1))
printf '%s' "$generation" > "$generations"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"restarting","version":"1"}}}\n' "$id"
      ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"instance","description":"Instance","inputSchema":{"type":"object","properties":{}}}]}}\n' "$id"
      ;;
    *'"method":"tools/call"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"generation":%s,"pid":%s}}\n' "$id" "$generation" "$$"
      exit 0
      ;;
  esac
done
"#,
            )
            .unwrap();
            let mut permissions = std::fs::metadata(&script).unwrap().permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(&script, permissions).unwrap();

            let mut server = McpServerDefinition::new(
                format!("restarting-{}", Uuid::new_v4()),
                McpTransport::Stdio,
            );
            server.command = Some(script.to_string_lossy().into_owned());
            server.args = vec![generations.to_string_lossy().into_owned()];
            let secrets = McpSecretBundle::default();

            discover_server(&server, &secrets, None).await.unwrap();
            let first = call_server(&server, &secrets, "instance", json!({}), None, None, None)
                .await
                .unwrap();
            let second =
                call_server(&server, &secrets, "instance", json!({}), None, None, None).await;
            let third = call_server(&server, &secrets, "instance", json!({}), None, None, None)
                .await
                .unwrap();

            assert_eq!(first["generation"], 1);
            assert!(matches!(second, Err(AgentMcpError::Transport)));
            assert_eq!(third["generation"], 2);
            retire_server_sessions(&server.id).await;
            assert_eq!(std::fs::read_to_string(generations).unwrap(), "2");
        }
    }
    #[tokio::test]
    async fn timed_out_stdio_request_retires_the_poisoned_session() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let directory = tempfile::tempdir().unwrap();
            let script = directory.path().join("hanging-mcp.sh");
            std::fs::write(
                &script,
                r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"hanging","version":"1"}}}\n' "$id"
      ;;
  esac
done
"#,
            )
            .unwrap();
            let mut permissions = std::fs::metadata(&script).unwrap().permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(&script, permissions).unwrap();

            let mut server = McpServerDefinition::new(
                format!("hanging-{}", Uuid::new_v4()),
                McpTransport::Stdio,
            );
            server.command = Some(script.to_string_lossy().into_owned());
            server.safety.timeout_ms = 250;
            let key = session_key(&server, None);

            assert!(matches!(
                session_request(
                    &server,
                    &McpSecretBundle::default(),
                    "tools/call",
                    json!({"name":"hang","arguments":{}}),
                    None,
                    None,
                    None,
                )
                .await,
                Err(AgentMcpError::TimedOut)
            ));
            assert!(!MCP_SESSIONS.get().unwrap().lock().await.contains_key(&key));
        }
    }
    #[tokio::test]
    async fn elicitation_is_detected_instead_of_silently_dropped() {
        let (mut writer, reader) = tokio::io::duplex(1024);
        tokio::spawn(async move {
            writer
                .write_all(
                    b"{\"jsonrpc\":\"2.0\",\"id\":\"question-1\",\"method\":\"elicitation/create\",\"params\":{\"message\":\"Choose a project\"}}\n",
                )
                .await
                .unwrap();
        });
        let mut reader = BufReader::new(reader);
        assert!(matches!(
            read_stdio_response(&mut reader, 1024, 3).await,
            Err(AgentMcpError::ElicitationRequired(_))
        ));
        assert!(contains_elicitation_request(
            b"event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":\"question-2\",\"method\":\"elicitation/create\",\"params\":{\"message\":\"Choose\"}}\n\n"
        ));
    }

    #[tokio::test]
    async fn stdio_elicitation_answer_resumes_the_original_tool_call() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let directory = tempfile::tempdir().unwrap();
            let script = directory.path().join("eliciting-mcp.sh");
            let calls = directory.path().join("tool-calls");
            std::fs::write(
                &script,
                r#"#!/bin/sh
calls="$1"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"eliciting","version":"1"}}}\n' "$id"
      ;;
    *'"method":"tools/call"'*)
      count=0
      if [ -f "$calls" ]; then count=$(cat "$calls"); fi
      count=$((count + 1))
      printf '%s' "$count" > "$calls"
      printf '{"jsonrpc":"2.0","id":"question-1","method":"elicitation/create","params":{"message":"Choose a project","requestedSchema":{"type":"object","properties":{"project":{"type":"string"}}}}}\n'
      IFS= read -r answer
      case "$answer" in
        *'"project":"Alpha"'*)
          printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"Alpha selected"}]}}\n' "$id"
          ;;
        *)
          printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32602,"message":"bad answer"}}\n' "$id"
          ;;
      esac
      ;;
  esac
done
"#,
            )
            .unwrap();
            let mut permissions = std::fs::metadata(&script).unwrap().permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(&script, permissions).unwrap();

            let mut server = McpServerDefinition::new(
                format!("eliciting-{}", Uuid::new_v4()),
                McpTransport::Stdio,
            );
            server.command = Some(script.to_string_lossy().into_owned());
            server.args = vec![calls.to_string_lossy().into_owned()];
            let first = call_server(
                &server,
                &McpSecretBundle::default(),
                "choose",
                json!({}),
                None,
                None,
                None,
            )
            .await;
            assert!(matches!(first, Err(AgentMcpError::ElicitationRequired(_))));
            let result = call_server(
                &server,
                &McpSecretBundle::default(),
                "choose",
                json!({}),
                None,
                Some("Alpha"),
                None,
            )
            .await
            .unwrap();

            assert_eq!(result["content"][0]["text"], "Alpha selected");
            assert_eq!(std::fs::read_to_string(calls).unwrap(), "1");
            retire_server_sessions(&server.id).await;
        }
    }
    #[test]
    fn mapping_is_stable_visibility_aware_and_duplicate_free() {
        assert_eq!(
            runtime_tool_name("my.server", "read-file").unwrap(),
            "mcp_my_server_read_file"
        );
        let mut server = McpServerDefinition::new("my.server", McpTransport::Stdio);
        server.command = Some("node".into());
        server.tool_visibility.exclude.push("hidden".into());
        let mut registry = McpToolRegistry::default();
        registry
            .register(
                &server,
                vec![
                    McpDiscoveredTool {
                        name: "read-file".into(),
                        description: String::new(),
                        input_schema: json!({"type":"object"}),
                        annotations: McpToolAnnotations::default(),
                    },
                    McpDiscoveredTool {
                        name: "hidden".into(),
                        description: String::new(),
                        input_schema: json!({}),
                        annotations: McpToolAnnotations::default(),
                    },
                ],
            )
            .unwrap();
        assert_eq!(registry.descriptors().len(), 1);
        assert_eq!(
            registry
                .resolve("mcp_my_server_read_file")
                .unwrap()
                .descriptor
                .strict,
            None
        );
    }

    #[test]
    fn managed_linear_uses_the_fixed_official_endpoint() {
        let server = managed_linear_definition();
        assert_eq!(server.id, MANAGED_LINEAR_SERVER_ID);
        assert_eq!(server.name, MANAGED_LINEAR_SERVER_NAME);
        assert_eq!(server.url.as_deref(), Some(MANAGED_LINEAR_MCP_URL));
        assert_eq!(server.transport, McpTransport::StreamableHttp);
        assert!(server.secret_ref.is_none());
        assert!(server.validate().is_ok());
    }

    #[test]
    fn hosted_tool_discovery_retains_safety_annotations_and_fails_closed_on_malformed_data() {
        let tools = discovered_tools_from_response(&json!({
            "result": {
                "nextCursor": 42,
                "tools": [
                    {
                        "name": "read",
                        "inputSchema": {"type": "object"},
                        "annotations": {
                            "readOnlyHint": true,
                            "destructiveHint": false,
                            "idempotentHint": true
                        }
                    },
                    {
                        "name": "unknown",
                        "inputSchema": {"type": "object"},
                        "annotations": {"readOnlyHint": "not-a-boolean"}
                    }
                ]
            }
        }))
        .unwrap();

        assert_eq!(
            tools[0].annotations.raw(),
            &json!({
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true
            })
        );
        assert_eq!(
            tools[1].annotations.raw(),
            &json!({"readOnlyHint": "not-a-boolean"})
        );
    }

    #[test]
    fn managed_linear_rejects_a_missing_schema_without_changing_custom_tolerance() {
        let discovered = discovered_tools_from_response(&json!({
            "result": {
                "tools": [{
                    "name": "schema_missing",
                    "description": "No inputSchema field"
                }]
            }
        }))
        .unwrap();
        assert!(discovered[0].input_schema.is_null());

        let mut managed = McpToolRegistry::default();
        managed
            .register_managed_linear(&managed_linear_definition(), discovered.clone())
            .unwrap();
        assert!(managed.resolve("mcp_linear_schema_missing").is_none());

        let mut custom_server = McpServerDefinition::new("custom", McpTransport::StreamableHttp);
        custom_server.url = Some("https://example.com/mcp".into());
        let mut custom = McpToolRegistry::default();
        custom.register(&custom_server, discovered).unwrap();
        assert_eq!(
            custom
                .resolve("mcp_custom_schema_missing")
                .unwrap()
                .descriptor
                .parameters,
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": true
            })
        );
    }

    #[tokio::test]
    async fn managed_linear_discovery_follows_bounded_cursor_pagination() {
        let mut pages = std::collections::VecDeque::from([
            json!({
                "result": {
                    "tools": [{
                        "name": "first",
                        "inputSchema": {"type": "object"}
                    }],
                    "nextCursor": "page-2"
                }
            }),
            json!({
                "result": {
                    "tools": [{
                        "name": "second",
                        "inputSchema": {"type": "object"}
                    }]
                }
            }),
        ]);
        let mut requests = Vec::new();

        let tools = discover_managed_tools_with(|params| {
            requests.push(params);
            std::future::ready(pages.pop_front().ok_or(AgentMcpError::Protocol))
        })
        .await
        .unwrap();

        assert_eq!(
            tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert_eq!(requests, vec![json!({}), json!({"cursor": "page-2"})]);
    }

    #[tokio::test]
    async fn stale_linear_lifecycle_cannot_start_a_managed_session() {
        let account_id = format!("linear-session-{}", Uuid::new_v4());
        let lifecycle = crate::connectors::acquire_linear_lifecycle(&account_id).await;
        let stale = lifecycle.snapshot();
        lifecycle.bump_epoch();
        drop(lifecycle);
        let mut server = managed_linear_definition();
        server.id = format!("builtin:linear-stale-{}", Uuid::new_v4());

        let result = session_request(
            &server,
            &McpSecretBundle::default(),
            "tools/list",
            json!({}),
            None,
            None,
            Some(&stale),
        )
        .await;

        assert!(matches!(result, Err(AgentMcpError::ToolUnavailable)));
        retire_server_sessions(&server.id).await;
    }

    #[tokio::test]
    async fn admitted_linear_dispatch_blocks_epoch_change_until_guard_drops() {
        let account_id = format!("linear-session-slot-{}", Uuid::new_v4());
        let lifecycle = crate::connectors::acquire_linear_lifecycle(&account_id).await;
        let snapshot = lifecycle.snapshot();
        drop(lifecycle);
        let dispatch = snapshot.acquire_current().await.unwrap();

        let lifecycle_change = tokio::spawn(async move {
            let lifecycle = crate::connectors::acquire_linear_lifecycle(&account_id).await;
            lifecycle.bump_epoch();
        });
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(!lifecycle_change.is_finished());
        assert!(snapshot.is_current());

        drop(dispatch);
        tokio::time::timeout(Duration::from_secs(1), lifecycle_change)
            .await
            .expect("lifecycle change must not deadlock")
            .unwrap();
        assert!(!snapshot.is_current());
    }

    #[tokio::test]
    async fn admitted_request_finishes_before_lifecycle_change() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::{net::TcpListener, sync::Notify};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let initialize_started = Arc::new(Notify::new());
        let release_initialize = Arc::new(Notify::new());
        let tool_calls = Arc::new(AtomicUsize::new(0));
        let server_task = tokio::spawn({
            let initialize_started = initialize_started.clone();
            let release_initialize = release_initialize.clone();
            let tool_calls = tool_calls.clone();
            async move {
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let initialize_started = initialize_started.clone();
                    let release_initialize = release_initialize.clone();
                    let tool_calls = tool_calls.clone();
                    tokio::spawn(async move {
                        let mut request = Vec::new();
                        let mut buffer = [0_u8; 4096];
                        loop {
                            let read = stream.read(&mut buffer).await.unwrap();
                            if read == 0 {
                                break;
                            }
                            request.extend_from_slice(&buffer[..read]);
                            let Some(headers_end) =
                                request.windows(4).position(|window| window == b"\r\n\r\n")
                            else {
                                continue;
                            };
                            let headers = String::from_utf8_lossy(&request[..headers_end]);
                            let content_length = headers
                                .lines()
                                .find_map(|line| {
                                    let (name, value) = line.split_once(':')?;
                                    name.eq_ignore_ascii_case("content-length")
                                        .then(|| value.trim().parse::<usize>().ok())
                                        .flatten()
                                })
                                .unwrap_or(0);
                            if request.len() >= headers_end + 4 + content_length {
                                break;
                            }
                        }
                        let body_start = request
                            .windows(4)
                            .position(|window| window == b"\r\n\r\n")
                            .unwrap()
                            + 4;
                        let frame: Value = serde_json::from_slice(&request[body_start..]).unwrap();
                        match frame.get("method").and_then(Value::as_str) {
                            Some("initialize") => {
                                initialize_started.notify_one();
                                release_initialize.notified().await;
                                let body = json!({
                                    "jsonrpc": "2.0",
                                    "id": frame["id"],
                                    "result": {
                                        "protocolVersion": MCP_PROTOCOL_VERSION,
                                        "capabilities": {},
                                        "serverInfo": {
                                            "name": "delayed-initialize",
                                            "version": "1"
                                        }
                                    }
                                })
                                .to_string();
                                let headers = format!(
                                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nmcp-session-id: delayed-session\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                                    body.len()
                                );
                                stream.write_all(headers.as_bytes()).await.unwrap();
                                stream.write_all(body.as_bytes()).await.unwrap();
                            }
                            Some("notifications/initialized") => {
                                stream
                                    .write_all(
                                        b"HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                                    )
                                    .await
                                    .unwrap();
                            }
                            Some("tools/call") => {
                                tool_calls.fetch_add(1, Ordering::SeqCst);
                                let body = json!({
                                    "jsonrpc": "2.0",
                                    "id": frame["id"],
                                    "result": {"content": []}
                                })
                                .to_string();
                                let headers = format!(
                                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                                    body.len()
                                );
                                stream.write_all(headers.as_bytes()).await.unwrap();
                                stream.write_all(body.as_bytes()).await.unwrap();
                            }
                            _ => {}
                        }
                    });
                }
            }
        });

        let account_id = format!("linear-init-{}", Uuid::new_v4());
        let lifecycle_guard = crate::connectors::acquire_linear_lifecycle(&account_id).await;
        let snapshot = lifecycle_guard.snapshot();
        drop(lifecycle_guard);
        let mut server = managed_linear_definition();
        server.id = format!("builtin:linear-init-{}", Uuid::new_v4());
        server.url = Some(format!("http://{address}/mcp"));
        let request_server = server.clone();
        let request_snapshot = snapshot.clone();
        let request = tokio::spawn(async move {
            session_request(
                &request_server,
                &McpSecretBundle::default(),
                "tools/call",
                json!({"name": "create_issue", "arguments": {}}),
                None,
                None,
                Some(&request_snapshot),
            )
            .await
        });

        initialize_started.notified().await;
        let lifecycle_change = tokio::spawn(async move {
            let lifecycle = crate::connectors::acquire_linear_lifecycle(&account_id).await;
            lifecycle.bump_epoch();
        });
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(!lifecycle_change.is_finished());
        release_initialize.notify_one();

        assert!(request.await.unwrap().is_ok());
        tokio::time::timeout(Duration::from_secs(1), lifecycle_change)
            .await
            .expect("lifecycle change must not deadlock")
            .unwrap();
        assert_eq!(tool_calls.load(Ordering::SeqCst), 1);
        retire_server_sessions(&server.id).await;
        server_task.abort();
    }

    #[tokio::test]
    async fn managed_linear_discovery_rejects_repeated_cursors() {
        let mut pages = std::collections::VecDeque::from([
            json!({"result": {"tools": [], "nextCursor": "repeat"}}),
            json!({"result": {"tools": [], "nextCursor": "repeat"}}),
        ]);
        let mut requests = Vec::new();

        let result = discover_managed_tools_with(|params| {
            requests.push(params);
            std::future::ready(pages.pop_front().ok_or(AgentMcpError::Protocol))
        })
        .await;

        assert!(matches!(result, Err(AgentMcpError::Protocol)));
        assert_eq!(requests.len(), 2);
    }

    #[tokio::test]
    async fn managed_linear_discovery_enforces_aggregate_bounds() {
        let mut page_requests = 0usize;
        let page_result = discover_managed_tools_with(|_| {
            page_requests += 1;
            std::future::ready(Ok(json!({
                "result": {
                    "tools": [],
                    "nextCursor": format!("page-{page_requests}")
                }
            })))
        })
        .await;
        assert!(matches!(page_result, Err(AgentMcpError::Protocol)));
        assert_eq!(page_requests, MANAGED_MCP_DISCOVERY_MAX_PAGES);

        let too_many_tools = vec![
            json!({
                "name": "tool",
                "inputSchema": {"type": "object"}
            });
            MANAGED_MCP_DISCOVERY_MAX_TOOLS + 1
        ];
        let tool_result = discover_managed_tools_with(|_| {
            std::future::ready(Ok(json!({"result": {"tools": too_many_tools}})))
        })
        .await;
        assert!(matches!(tool_result, Err(AgentMcpError::Protocol)));

        let long_cursor = "x".repeat(MANAGED_MCP_CURSOR_MAX_CHARS + 1);
        let cursor_result = discover_managed_tools_with(|_| {
            std::future::ready(Ok(json!({
                "result": {"tools": [], "nextCursor": long_cursor}
            })))
        })
        .await;
        assert!(matches!(cursor_result, Err(AgentMcpError::Protocol)));

        let oversized_description = "x".repeat(MANAGED_MCP_DISCOVERY_MAX_BYTES + 1);
        let byte_result = discover_managed_tools_with(|_| {
            std::future::ready(Ok(json!({
                "result": {
                    "tools": [{
                        "name": "oversized",
                        "description": oversized_description,
                        "inputSchema": {"type": "object"}
                    }]
                }
            })))
        })
        .await;
        assert!(matches!(byte_result, Err(AgentMcpError::Protocol)));
    }

    #[test]
    fn managed_linear_requires_approval_unless_annotations_are_clearly_read_only() {
        let server = managed_linear_definition();
        let tool = |name: &str, read_only_hint, destructive_hint| McpDiscoveredTool {
            name: name.to_string(),
            description: String::new(),
            input_schema: json!({"type":"object"}),
            annotations: McpToolAnnotations::from_hints(read_only_hint, destructive_hint),
        };
        let mut registry = McpToolRegistry::default();
        registry
            .register_managed_linear(
                &server,
                vec![
                    tool("safe", Some(true), Some(false)),
                    tool("ambiguous", None, None),
                    tool("missing_destructive", Some(true), None),
                    tool("conflicting", Some(true), Some(true)),
                    tool("write", Some(false), Some(false)),
                    McpDiscoveredTool {
                        name: "malformed".into(),
                        description: String::new(),
                        input_schema: json!({"type":"object"}),
                        annotations: McpToolAnnotations::from_raw(json!({
                            "readOnlyHint": "not-a-boolean",
                            "destructiveHint": false
                        })),
                    },
                ],
            )
            .unwrap();

        for name in ["safe", "missing_destructive"] {
            assert_eq!(
                registry
                    .resolve(&format!("mcp_linear_{name}"))
                    .unwrap()
                    .descriptor
                    .requires_approval,
                None
            );
        }
        for name in ["ambiguous", "conflicting", "write", "malformed"] {
            assert_eq!(
                registry
                    .resolve(&format!("mcp_linear_{name}"))
                    .unwrap()
                    .descriptor
                    .requires_approval,
                Some(true)
            );
        }
        assert!(registry
            .descriptors()
            .iter()
            .all(|descriptor| descriptor.strict == Some(false)));
    }

    #[test]
    fn managed_linear_skips_invalid_tools_and_cannot_be_shadowed_by_custom_mcp() {
        let server = managed_linear_definition();
        let mut custom = McpServerDefinition::new("linear", McpTransport::Stdio);
        custom.command = Some("node".into());
        let mut registry = McpToolRegistry::default();
        registry
            .register(
                &custom,
                vec![McpDiscoveredTool {
                    name: "search".into(),
                    description: "custom".into(),
                    input_schema: json!({"type":"object"}),
                    annotations: McpToolAnnotations::default(),
                }],
            )
            .unwrap();
        registry
            .register_managed_linear(
                &server,
                vec![
                    McpDiscoveredTool {
                        name: "x".repeat(200),
                        description: "invalid".into(),
                        input_schema: json!({"type":"object"}),
                        annotations: McpToolAnnotations::default(),
                    },
                    McpDiscoveredTool {
                        name: "search".into(),
                        description: "official".into(),
                        input_schema: json!({"type":"object"}),
                        annotations: McpToolAnnotations::from_hints(Some(true), Some(false)),
                    },
                ],
            )
            .unwrap();

        let search = registry.resolve("mcp_linear_search").unwrap();
        assert_eq!(search.server_id, MANAGED_LINEAR_SERVER_ID);
        assert_eq!(search.descriptor.description, "official");
        assert_eq!(
            search.descriptor.approval_provider.as_deref(),
            Some("Linear")
        );
        assert_eq!(
            search.descriptor.approval_remote_tool_name.as_deref(),
            Some("search")
        );
        assert_eq!(registry.descriptors().len(), 1);
    }

    #[test]
    fn managed_linear_bounds_each_hosted_descriptor_independently() {
        let server = managed_linear_definition();
        let oversized = "x".repeat(MANAGED_MCP_TOOL_SCHEMA_MAX_BYTES + 1);
        let oversized_annotations = "x".repeat(MANAGED_MCP_TOOL_ANNOTATIONS_MAX_BYTES + 1);
        let long_description = "d".repeat(MANAGED_MCP_DESCRIPTION_MAX_CHARS + 10);
        let mut registry = McpToolRegistry::default();
        registry
            .register_managed_linear(
                &server,
                vec![
                    McpDiscoveredTool {
                        name: "bad-schema".into(),
                        description: "invalid".into(),
                        input_schema: json!(["not", "an", "object"]),
                        annotations: McpToolAnnotations::default(),
                    },
                    McpDiscoveredTool {
                        name: "wrong-schema-type".into(),
                        description: "invalid".into(),
                        input_schema: json!({"type":"array","items":{}}),
                        annotations: McpToolAnnotations::default(),
                    },
                    McpDiscoveredTool {
                        name: "malformed-properties".into(),
                        description: "invalid".into(),
                        input_schema: json!({"type":"object","properties":[]}),
                        annotations: McpToolAnnotations::default(),
                    },
                    McpDiscoveredTool {
                        name: "malformed-required".into(),
                        description: "invalid".into(),
                        input_schema: json!({"type":"object","required":{}}),
                        annotations: McpToolAnnotations::default(),
                    },
                    McpDiscoveredTool {
                        name: "oversized".into(),
                        description: "invalid".into(),
                        input_schema: json!({
                            "type": "object",
                            "description": oversized,
                        }),
                        annotations: McpToolAnnotations::default(),
                    },
                    McpDiscoveredTool {
                        name: "oversized-annotations".into(),
                        description: "invalid".into(),
                        input_schema: json!({"type":"object"}),
                        annotations: McpToolAnnotations::from_raw(json!({
                            "futureHint": oversized_annotations
                        })),
                    },
                    McpDiscoveredTool {
                        name: "valid".into(),
                        description: long_description,
                        input_schema: json!({"type":"object"}),
                        annotations: McpToolAnnotations::from_hints(Some(true), Some(false)),
                    },
                ],
            )
            .unwrap();

        let valid = registry.resolve("mcp_linear_valid").unwrap();
        assert_eq!(
            valid.descriptor.description.chars().count(),
            MANAGED_MCP_DESCRIPTION_MAX_CHARS + 3
        );
        assert!(valid.descriptor.description.ends_with("..."));
        assert_eq!(registry.descriptors().len(), 1);
    }
}
