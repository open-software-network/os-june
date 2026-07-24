//! Host-owned MCP server registry for the June agent harness.
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
    collections::{BTreeMap, BTreeSet},
    io,
    process::Stdio,
    sync::Mutex,
    time::Duration,
};
use tauri::AppHandle;
use thiserror::Error;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    time::timeout,
};
use uuid::Uuid;
use zeroize::Zeroize;

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
const KEYCHAIN_SERVICE: &str = "co.opensoftware.june.agent-mcp";
const DEV_KEYCHAIN_SERVICE: &str = "co.opensoftware.june-dev.agent-mcp";

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
    #[error("MCP response exceeded June's safety limit")]
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
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            return Err(AgentMcpError::InvalidDefinition(
                "server name must be an ASCII slug".into(),
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
}

/// Values held only in keychain. `env` is supplied to a stdio process and
/// `headers` only to the configured HTTP origin. Neither is serialized with a
/// [`McpServerDefinition`] or placed in runtime tool descriptors.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpSecretBundle {
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// Legacy OAuth client configuration is retained only for recovery.
    /// The June-owned runtime does not consume it until a first-party OAuth
    /// flow can replace the retired Hermes token cache safely.
    #[serde(default)]
    pub oauth: BTreeMap<String, String>,
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
        platform_keychain_put(keychain_service(), secret_ref, raw)
    }
    fn get(&self, secret_ref: &str) -> Result<Option<McpSecretBundle>, AgentMcpError> {
        let Some(raw) = platform_keychain_get(keychain_service(), secret_ref)? else {
            return Ok(None);
        };
        serde_json::from_str(&raw)
            .map(Some)
            .map_err(|_| AgentMcpError::SecureStorage)
    }
    fn delete(&self, secret_ref: &str) -> Result<(), AgentMcpError> {
        platform_keychain_delete(keychain_service(), secret_ref)
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn platform_keychain_put(
    service: String,
    secret_ref: &str,
    raw: String,
) -> Result<(), AgentMcpError> {
    keyring::Entry::new(&service, secret_ref)
        .and_then(|entry| entry.set_password(&raw))
        .map_err(|_| AgentMcpError::SecureStorage)
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_keychain_put(
    _service: String,
    _secret_ref: &str,
    _raw: String,
) -> Result<(), AgentMcpError> {
    Err(AgentMcpError::SecureStorageUnavailable)
}
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn platform_keychain_get(
    service: String,
    secret_ref: &str,
) -> Result<Option<String>, AgentMcpError> {
    match keyring::Entry::new(&service, secret_ref).and_then(|entry| entry.get_password()) {
        Ok(raw) => Ok(Some(raw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(AgentMcpError::SecureStorage),
    }
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_keychain_get(
    _service: String,
    _secret_ref: &str,
) -> Result<Option<String>, AgentMcpError> {
    Ok(None)
}
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn platform_keychain_delete(service: String, secret_ref: &str) -> Result<(), AgentMcpError> {
    match keyring::Entry::new(&service, secret_ref).and_then(|entry| entry.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(AgentMcpError::SecureStorage),
    }
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_keychain_delete(_service: String, _secret_ref: &str) -> Result<(), AgentMcpError> {
    Ok(())
}
fn keychain_service() -> String {
    if cfg!(debug_assertions) {
        DEV_KEYCHAIN_SERVICE.into()
    } else {
        KEYCHAIN_SERVICE.into()
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
        definition.validate()?;
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
        definition.validate()?;
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
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeToolDescriptorJson {
    pub id: String,
    pub name: String,
    pub description: String,
    pub parameters: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_approval: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct RegisteredMcpTool {
    pub server_id: String,
    pub server_name: String,
    pub remote_name: String,
    pub descriptor: RuntimeToolDescriptorJson,
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
            let requires_approval = server.safety.requires_approval
                || server
                    .safety
                    .approval_tools
                    .iter()
                    .any(|item| item == &tool.name);
            let descriptor = RuntimeToolDescriptorJson {
                id: format!("mcp:{}/{}", server.id, tool.name),
                name: name.clone(),
                description: tool.description,
                parameters: object_schema(tool.input_schema),
                requires_approval: requires_approval.then_some(true),
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
        let mut next = McpToolRegistry::default();
        for server in self
            .repository
            .list()
            .await?
            .into_iter()
            .filter(|server| server_available(server, sandboxed, workspace))
        {
            let secret = match server.secret_ref.as_deref() {
                Some(reference) => self.secrets.get(reference)?,
                None => None,
            }
            .unwrap_or_default();
            match discover_server(&server, &secret, sandboxed.then_some(workspace).flatten()).await
            {
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
        let registered = self
            .registry
            .lock()
            .map_err(|_| AgentMcpError::Storage)?
            .resolve(runtime_name)
            .cloned()
            .ok_or(AgentMcpError::ToolUnavailable)?;
        let server = self.repository.get(&registered.server_id).await?;
        if !server_available(&server, sandboxed, workspace) {
            return Err(AgentMcpError::ToolUnavailable);
        }
        let secret = match server.secret_ref.as_deref() {
            Some(reference) => self.secrets.get(reference)?,
            None => None,
        }
        .unwrap_or_default();
        call_server(
            &server,
            &secret,
            &registered.remote_name,
            arguments,
            sandboxed.then_some(workspace).flatten(),
        )
        .await
    }
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
        2,
        "tools/list",
        json!({}),
        sandbox_workspace,
    )
    .await?;
    let tools = value
        .get("result")
        .and_then(|result| result.get("tools"))
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
                    .unwrap_or_else(|| json!({"type":"object","properties":{}})),
            })
        })
        .collect::<Vec<_>>())
}
async fn call_server(
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
    tool_name: &str,
    arguments: Value,
    sandbox_workspace: Option<&std::path::Path>,
) -> Result<Value, AgentMcpError> {
    let value = session_request(
        server,
        secrets,
        3,
        "tools/call",
        json!({"name":tool_name,"arguments":arguments}),
        sandbox_workspace,
    )
    .await?;
    value.get("result").cloned().ok_or(AgentMcpError::Protocol)
}
async fn session_request(
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
    id: u64,
    method: &str,
    params: Value,
    sandbox_workspace: Option<&std::path::Path>,
) -> Result<Value, AgentMcpError> {
    let deadline = Duration::from_millis(server.safety.timeout_ms);
    timeout(deadline, async {
        match server.transport {
            McpTransport::Stdio => {
                stdio_session(server, secrets, id, method, params, sandbox_workspace).await
            }
            McpTransport::StreamableHttp => http_session(server, secrets, id, method, params).await,
        }
    })
    .await
    .map_err(|_| AgentMcpError::TimedOut)?
}

async fn stdio_session(
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
    id: u64,
    method: &str,
    params: Value,
    sandbox_workspace: Option<&std::path::Path>,
) -> Result<Value, AgentMcpError> {
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
    write_stdio_frame(&mut stdin, 1, "initialize", json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"June","version":"1"}})).await?;
    read_stdio_response(&mut stdout, server.safety.max_output_bytes, 1).await?;
    write_stdio_notification(&mut stdin, "notifications/initialized", json!({})).await?;
    write_stdio_frame(&mut stdin, id, method, params).await?;
    let response = read_stdio_response(&mut stdout, server.safety.max_output_bytes, id).await?;
    let _ = child.kill().await;
    Ok(response)
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

async fn read_stdio_response<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    limit: usize,
    id: u64,
) -> Result<Value, AgentMcpError> {
    let mut consumed = 0_usize;
    for _ in 0..64 {
        let raw = read_bounded_line(reader, limit.saturating_sub(consumed)).await?;
        consumed = consumed.saturating_add(raw.len());
        let Ok(candidate) = serde_json::from_slice::<Value>(&raw) else {
            return Err(AgentMcpError::Protocol);
        };
        if candidate.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if candidate.get("error").is_some() {
            return Err(AgentMcpError::Protocol);
        }
        return Ok(candidate);
    }
    Err(AgentMcpError::Protocol)
}

async fn read_bounded_line<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    limit: usize,
) -> Result<Vec<u8>, AgentMcpError> {
    let mut output = Vec::new();
    loop {
        let byte = reader.read_u8().await.map_err(|error| {
            if error.kind() == io::ErrorKind::UnexpectedEof {
                AgentMcpError::Protocol
            } else {
                AgentMcpError::Transport
            }
        })?;
        if byte == b'\n' {
            return Ok(output);
        }
        if output.len() == limit {
            return Err(AgentMcpError::OutputTooLarge);
        }
        output.push(byte);
    }
}

async fn http_session(
    server: &McpServerDefinition,
    secrets: &McpSecretBundle,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, AgentMcpError> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| AgentMcpError::Transport)?;
    let (_, session_id) = http_post(&client, server, secrets, None, 1, "initialize", json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"June","version":"1"}})).await?;
    http_notify(
        &client,
        server,
        secrets,
        session_id.as_deref(),
        "notifications/initialized",
        json!({}),
    )
    .await?;
    http_post(
        &client,
        server,
        secrets,
        session_id.as_deref(),
        id,
        method,
        params,
    )
    .await
    .map(|(value, _)| value)
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
    let mut request = client
        .post(url)
        .header("accept", "application/json, text/event-stream")
        .header("content-type", "application/json")
        .header("mcp-protocol-version", "2025-06-18");
    for (key, value) in &secrets.headers {
        request = request.header(key, value);
    }
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
) -> Result<(Value, Option<String>), AgentMcpError> {
    let url = server.url.as_deref().ok_or(AgentMcpError::Transport)?;
    let mut request = client
        .post(url)
        .header("accept", "application/json, text/event-stream")
        .header("content-type", "application/json")
        .header("mcp-protocol-version", "2025-06-18");
    for (key, value) in &secrets.headers {
        request = request.header(key, value);
    }
    if let Some(session_id) = session_id {
        request = request.header("mcp-session-id", session_id);
    }
    let response = request
        .json(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
        .send()
        .await
        .map_err(|_| AgentMcpError::Transport)?;
    if !response.status().is_success() {
        return Err(AgentMcpError::Transport);
    }
    let session_id = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AgentMcpError::Transport)?
    {
        if bytes.len().saturating_add(chunk.len()) > server.safety.max_output_bytes {
            return Err(AgentMcpError::OutputTooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((parse_mcp_response(&bytes, id)?, session_id))
}

fn parse_mcp_response(bytes: &[u8], id: u64) -> Result<Value, AgentMcpError> {
    let raw = std::str::from_utf8(bytes).map_err(|_| AgentMcpError::Protocol)?;
    let candidate: Value = serde_json::from_str(raw)
        .ok()
        .or_else(|| {
            raw.lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim)
                .find_map(|data| serde_json::from_str(data).ok())
        })
        .ok_or(AgentMcpError::Protocol)?;
    if candidate.get("id").and_then(Value::as_u64) != Some(id) || candidate.get("error").is_some() {
        return Err(AgentMcpError::Protocol);
    }
    Ok(candidate)
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
        if !bundle.env.is_empty() || !bundle.headers.is_empty() {
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
    definition.validate().map_err(app_error)?;
    let legacy_oauth = definition
        .metadata
        .get("legacyAuth")
        .and_then(Value::as_str)
        == Some("oauth");
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
        if bundle.env.is_empty() && bundle.headers.is_empty() {
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
    Ok(definition)
}

#[tauri::command]
pub async fn delete_agent_mcp_server(
    app: AppHandle,
    server_id: String,
) -> Result<(), crate::domain::types::AppError> {
    let repository = command_repository(&app).await.map_err(app_error)?;
    let deleted = repository.delete(&server_id).await.map_err(app_error)?;
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
    let secrets = match server.secret_ref.as_deref() {
        Some(secret_ref) => KeychainMcpSecretStore
            .get(secret_ref)
            .map_err(app_error)?
            .unwrap_or_default(),
        None => McpSecretBundle::default(),
    };
    discover_server(&server, &secrets, None)
        .await
        .map_err(app_error)
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
        if let Err(error) = definition.validate() {
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
                    },
                    McpDiscoveredTool {
                        name: "hidden".into(),
                        description: String::new(),
                        input_schema: json!({}),
                    },
                ],
            )
            .unwrap();
        assert_eq!(registry.descriptors().len(), 1);
        assert!(registry.resolve("mcp_my_server_read_file").is_some());
    }
}
