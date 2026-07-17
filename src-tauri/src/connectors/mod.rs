//! Private connectors (Google, Linear), local mode.
//!
//! OAuth (PKCE + loopback), Keychain token custody, the scope registry, and
//! the direct provider clients. The provider proxy and the trigger daemon
//! consume this module: they resolve an access token via
//! [`google_access_token`] / [`linear_access_token`] and call the [`google`]
//! / [`linear`] functions with it. June API and OpenSoftware infrastructure
//! are never in the connector data path.
//!
//! Secrets live ONLY in the keychain ([`store`]); the SQLite index carries
//! non-secret account metadata (emails, scopes, status) so accounts can be
//! enumerated without keychain prompts. Tokens are never logged and never
//! serialized into errors.

pub mod approvals;
pub mod commands;
pub mod google;
pub mod linear;
pub mod notion;
pub mod oauth;
pub mod scopes;
pub mod store;
pub mod triggers;

use crate::domain::types::AppError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex, OnceLock},
};
use tokio::sync::Mutex as AsyncMutex;

pub use notion::NotionConnectFlow;
pub use oauth::ConnectFlow;

/// Access tokens within this many seconds of expiry are refreshed instead of
/// returned, so a caller never receives a token that dies mid-request.
const ACCESS_TOKEN_EXPIRY_BUFFER_SECS: i64 = 60;
const GOOGLE_OAUTH_CLIENT_ID_ENV: &str = "GOOGLE_OAUTH_CLIENT_ID";
const GOOGLE_OAUTH_CLIENT_SECRET_ENV: &str = "GOOGLE_OAUTH_CLIENT_SECRET";
const LINEAR_OAUTH_CLIENT_ID_ENV: &str = "LINEAR_OAUTH_CLIENT_ID";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorProvider {
    Google,
    Notion,
    Linear,
}

impl ConnectorProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConnectorProvider::Google => "google",
            ConnectorProvider::Notion => "notion",
            ConnectorProvider::Linear => "linear",
        }
    }

    /// Parse the `connector_accounts.provider` column. Unrecognized values
    /// default to `Google` (mirrors `ConnectorAccountStatus::from_db`'s
    /// defaulting style) rather than failing to load the whole account list
    /// over a single stale or corrupt row.
    pub fn from_db(value: &str) -> Self {
        match value {
            "notion" => ConnectorProvider::Notion,
            "linear" => ConnectorProvider::Linear,
            _ => ConnectorProvider::Google,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorAccountStatus {
    Connected,
    ReconnectRequired,
}

impl ConnectorAccountStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConnectorAccountStatus::Connected => "connected",
            ConnectorAccountStatus::ReconnectRequired => "reconnect_required",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "reconnect_required" => ConnectorAccountStatus::ReconnectRequired,
            _ => ConnectorAccountStatus::Connected,
        }
    }
}

/// Non-secret account descriptor returned to the frontend and used by the
/// proxy to enumerate accounts. The account id IS the Google account email
/// for a Google row, and the Linear workspace id for a Linear row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorAccount {
    pub account_id: String,
    pub provider: ConnectorProvider,
    pub email: String,
    pub scopes: Vec<String>,
    pub status: ConnectorAccountStatus,
    /// Linear workspace display name, parsed from the account's `metadata`
    /// JSON. Always `None` for Google rows.
    pub workspace_name: Option<String>,
    /// Linear workspace url key (the `foo` in `linear.app/foo`), parsed from
    /// `metadata`. Always `None` for Google rows.
    pub workspace_url_key: Option<String>,
    /// The Linear teams this account is scoped to. Always empty for Google
    /// rows, which have no team concept.
    pub selected_teams: Vec<SelectedTeamDto>,
}

/// One Linear team the account is scoped to, as shown to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedTeamDto {
    pub id: String,
    pub key: String,
    pub name: String,
}

/// Non-secret metadata carried on a `connector_accounts` row, beyond the
/// columns every provider shares (email, scopes, status). Parsed
/// best-effort from the `metadata` JSON column; unknown or absent keys
/// resolve to `None` rather than failing account enumeration.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectorAccountMetadata {
    #[serde(default)]
    workspace_name: Option<String>,
    #[serde(default)]
    workspace_url_key: Option<String>,
}

// --- Config ------------------------------------------------------------------

fn env_trimmed(key: &str) -> String {
    std::env::var(key)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn env_or_build_trimmed(key: &str, build_value: Option<&'static str>) -> String {
    let runtime_value = env_trimmed(key);
    if runtime_value.is_empty() {
        build_value.map(str::trim).unwrap_or_default().to_string()
    } else {
        runtime_value
    }
}

pub(crate) fn env_truthy(key: &str) -> bool {
    matches!(
        env_trimmed(key).to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Cryptographically-random base64url string of `bytes` entropy. Mirrors
/// `oauth::random_b64url`; used to mint autonomy grant tokens (never a
/// time/counter source).
pub(crate) fn random_b64url(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(&buf)
}

/// Google Desktop OAuth credential. Google calls the second field a client
/// secret and requires it at the token endpoint, but an installed app cannot
/// keep it confidential: both values are shipped in the binary and neither
/// grants user-data access without the user's authorization code or refresh
/// token. Runtime env values override the build-time values for local testing.
struct GoogleOAuthClient {
    client_id: String,
    client_secret: String,
}

fn google_oauth_client() -> GoogleOAuthClient {
    crate::os_accounts::load_local_env();
    GoogleOAuthClient {
        client_id: env_or_build_trimmed(
            GOOGLE_OAUTH_CLIENT_ID_ENV,
            option_env!("GOOGLE_OAUTH_CLIENT_ID"),
        ),
        client_secret: env_or_build_trimmed(
            GOOGLE_OAUTH_CLIENT_SECRET_ENV,
            option_env!("GOOGLE_OAUTH_CLIENT_SECRET"),
        ),
    }
}

fn require_oauth_client() -> Result<GoogleOAuthClient, AppError> {
    let client = google_oauth_client();
    if client.client_id.is_empty() || client.client_secret.is_empty() {
        return Err(AppError::new(
            "connector_not_configured",
            "Google connector is not configured in this build.",
        ));
    }
    Ok(client)
}

/// Linear public-client credential: a client id only. Linear's PKCE flow
/// needs no secret anywhere (see docs/plugins/linear-oauth-spike.md), so
/// unlike [`google_oauth_client`] there is no second field to ship. Runtime
/// env overrides the build-time value for local testing.
fn linear_oauth_client_id() -> String {
    crate::os_accounts::load_local_env();
    env_or_build_trimmed(
        LINEAR_OAUTH_CLIENT_ID_ENV,
        option_env!("LINEAR_OAUTH_CLIENT_ID"),
    )
}

fn require_linear_client_id() -> Result<String, AppError> {
    let client_id = linear_oauth_client_id();
    if client_id.is_empty() {
        return Err(AppError::new(
            "connector_not_configured",
            "Linear connector is not configured in this build.",
        ));
    }
    Ok(client_id)
}

/// The callback ports registered on the Linear OAuth application
/// (`http://127.0.0.1:<port>/callback`, one URL per port). Linear matches
/// the registered callback URL exactly - it does not ignore the loopback
/// port the way Google does (RFC 8252) - so the connect listener must bind
/// one of exactly these. Keep this list in sync with the OAuth app's
/// registered callback URLs.
const LINEAR_LOOPBACK_PORTS: &[u16] = &[44741, 44742, 44743];
const LINEAR_OAUTH_LOOPBACK_PORT_ENV: &str = "LINEAR_OAUTH_LOOPBACK_PORT";

/// The candidate loopback ports for a Linear connect: the
/// `LINEAR_OAUTH_LOOPBACK_PORT` override alone when it parses as a port
/// (for an OAuth app registered with a custom callback URL), otherwise the
/// registered defaults.
fn linear_loopback_ports() -> Vec<u16> {
    crate::os_accounts::load_local_env();
    linear_loopback_ports_from(&env_trimmed(LINEAR_OAUTH_LOOPBACK_PORT_ENV))
}

fn linear_loopback_ports_from(override_value: &str) -> Vec<u16> {
    match override_value.parse::<u16>() {
        Ok(port) if port != 0 => vec![port],
        _ => LINEAR_LOOPBACK_PORTS.to_vec(),
    }
}

// --- Access tokens ----------------------------------------------------------------

/// Per-account refresh serialization: refresh tokens can rotate, so two
/// parallel refreshes for the same account must never race (one would burn a
/// consumed token and force a reconnect).
static REFRESH_LOCKS: OnceLock<StdMutex<HashMap<String, Arc<AsyncMutex<()>>>>> = OnceLock::new();

fn refresh_lock_for(account_id: &str) -> Arc<AsyncMutex<()>> {
    let locks = REFRESH_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks
        .entry(account_id.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn access_token_is_fresh(expires_at_unix: i64, now_unix: i64) -> bool {
    expires_at_unix > now_unix + ACCESS_TOKEN_EXPIRY_BUFFER_SECS
}

fn not_connected_error() -> AppError {
    AppError::new(
        "connector_not_connected",
        "This Google account is not connected.",
    )
}

fn reconnect_required_error() -> AppError {
    AppError::new(
        "connector_reconnect_required",
        "Google access for this account expired. Reconnect it in settings.",
    )
}

fn linear_not_connected_error() -> AppError {
    AppError::new(
        "connector_not_connected",
        "This Linear workspace is not connected.",
    )
}

fn linear_reconnect_required_error() -> AppError {
    AppError::new(
        "connector_reconnect_required",
        "Linear access for this workspace expired. Reconnect it in settings.",
    )
}

/// Resolve a usable access token for the account: the cached token when it
/// is comfortably fresh, otherwise a refreshed one. Refreshes are serialized
/// per account and handle refresh-token rotation. On a definitive
/// `invalid_grant` the account is flagged `reconnect_required` in the DB
/// index and `connector_reconnect_required` is returned.
pub async fn google_access_token(
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<String, AppError> {
    let stored = store::load_tokens(ConnectorProvider::Google, account_id)
        .await?
        .ok_or_else(not_connected_error)?;
    if access_token_is_fresh(stored.expires_at_unix, now_unix()) {
        return Ok(stored.access_token.clone());
    }
    refresh_google_access_token(app, account_id).await
}

/// Refresh regardless of cached freshness. Callers use this to retry once
/// after `google::GoogleApiError::Unauthorized` (a token revoked or expired
/// server side before its local expiry).
pub async fn force_refresh_google_access_token(
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<String, AppError> {
    // Skip the freshness fast path but still serialize on the account lock.
    refresh_google_access_token_with_freshness_gate(app, account_id, false).await
}

async fn refresh_google_access_token(
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<String, AppError> {
    refresh_google_access_token_with_freshness_gate(app, account_id, true).await
}

async fn refresh_google_access_token_with_freshness_gate(
    app: &tauri::AppHandle,
    account_id: &str,
    accept_fresh: bool,
) -> Result<String, AppError> {
    let client = require_oauth_client()?;
    let lock = refresh_lock_for(account_id);
    let _guard = lock.lock().await;
    // Re-read inside the lock: another caller may have already refreshed
    // (and rotated the refresh token) while we waited.
    let mut stored = store::load_tokens(ConnectorProvider::Google, account_id)
        .await?
        .ok_or_else(not_connected_error)?;
    if accept_fresh && access_token_is_fresh(stored.expires_at_unix, now_unix()) {
        return Ok(stored.access_token.clone());
    }

    let mut attempt = 0;
    loop {
        attempt += 1;
        match oauth::refresh(
            &client.client_id,
            &client.client_secret,
            &stored.refresh_token,
        )
        .await
        {
            oauth::RefreshOutcome::Refreshed(fresh) => {
                stored.access_token = fresh.access_token.clone();
                // Rotation: Google occasionally issues a new refresh token;
                // persist it, otherwise keep the existing one.
                if let Some(rotated) = fresh
                    .refresh_token
                    .as_deref()
                    .filter(|token| !token.is_empty())
                {
                    stored.refresh_token = rotated.to_string();
                }
                stored.expires_at_unix = now_unix() + fresh.expires_in.max(0);
                store::store_tokens(ConnectorProvider::Google, account_id, &stored).await?;
                return Ok(stored.access_token.clone());
            }
            oauth::RefreshOutcome::InvalidGrant => {
                mark_reconnect_required(app, account_id).await;
                return Err(reconnect_required_error());
            }
            oauth::RefreshOutcome::Transient => {
                if attempt < oauth::REFRESH_MAX_ATTEMPTS {
                    tokio::time::sleep(oauth::REFRESH_RETRY_BACKOFF * attempt as u32).await;
                    continue;
                }
                return Err(AppError::new(
                    "connector_refresh_unavailable",
                    "Couldn't reach Google to refresh access. Try again in a moment.",
                ));
            }
        }
    }
}

/// Resolve a usable access token for the Linear workspace: the cached token
/// when it is comfortably fresh, otherwise a refreshed one. The account id
/// is the workspace id; it shares [`REFRESH_LOCKS`] with Google accounts
/// (workspace ids and emails cannot collide). The refresh loop is a
/// deliberate duplicate of the Google one with Linear types - the two flows
/// differ in credential shape (no secret) and outcome enum, and an
/// abstraction over both would obscure more than it saves.
pub async fn linear_access_token(
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<String, AppError> {
    let stored = store::load_tokens(ConnectorProvider::Linear, account_id)
        .await?
        .ok_or_else(linear_not_connected_error)?;
    if access_token_is_fresh(stored.expires_at_unix, now_unix()) {
        return Ok(stored.access_token.clone());
    }
    refresh_linear_access_token_with_freshness_gate(app, account_id, true).await
}

/// Refresh regardless of cached freshness. Callers use this to retry once
/// after `linear::LinearApiError::Unauthorized` (a token revoked or expired
/// server side before its local expiry).
pub async fn force_refresh_linear_access_token(
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<String, AppError> {
    // Skip the freshness fast path but still serialize on the account lock.
    refresh_linear_access_token_with_freshness_gate(app, account_id, false).await
}

async fn refresh_linear_access_token_with_freshness_gate(
    app: &tauri::AppHandle,
    account_id: &str,
    accept_fresh: bool,
) -> Result<String, AppError> {
    let client_id = require_linear_client_id()?;
    let lock = refresh_lock_for(account_id);
    let _guard = lock.lock().await;
    // Re-read inside the lock: another caller may have already refreshed
    // (and rotated the refresh token) while we waited.
    let mut stored = store::load_tokens(ConnectorProvider::Linear, account_id)
        .await?
        .ok_or_else(linear_not_connected_error)?;
    if accept_fresh && access_token_is_fresh(stored.expires_at_unix, now_unix()) {
        return Ok(stored.access_token.clone());
    }

    let mut attempt = 0;
    loop {
        attempt += 1;
        match linear::refresh(&client_id, &stored.refresh_token).await {
            linear::LinearRefreshOutcome::Refreshed(fresh) => {
                stored.access_token = fresh.access_token.clone();
                // Rotation: Linear issues a new refresh token on every
                // refresh; persist it, keep the existing one if absent.
                if let Some(rotated) = fresh
                    .refresh_token
                    .as_deref()
                    .filter(|token| !token.is_empty())
                {
                    stored.refresh_token = rotated.to_string();
                }
                stored.expires_at_unix = now_unix() + fresh.expires_in.max(0);
                // Linear already rotated server-side, so a failed persist
                // here strands the NEW refresh token. Recovery rides on
                // Linear's 30-minute grace window for the consumed (old)
                // token still in custody (spike doc): the next refresh
                // within that window rotates again. Log distinctly so a
                // later forced reconnect is diagnosable to this write.
                if let Err(error) =
                    store::store_tokens(ConnectorProvider::Linear, account_id, &stored).await
                {
                    tracing::error!(
                        error_code = %error.code,
                        "persisting rotated linear refresh token failed; grant recovers only within linear's consumption grace window"
                    );
                    return Err(error);
                }
                return Ok(stored.access_token.clone());
            }
            linear::LinearRefreshOutcome::InvalidGrant => {
                mark_reconnect_required(app, account_id).await;
                return Err(linear_reconnect_required_error());
            }
            linear::LinearRefreshOutcome::Transient => {
                if attempt < oauth::REFRESH_MAX_ATTEMPTS {
                    tokio::time::sleep(oauth::REFRESH_RETRY_BACKOFF * attempt as u32).await;
                    continue;
                }
                return Err(AppError::new(
                    "connector_refresh_unavailable",
                    "Couldn't reach Linear to refresh access. Try again in a moment.",
                ));
            }
        }
    }
}

/// Fired whenever an account's connection state changes (connect, disconnect,
/// or a background `reconnect_required` transition) so an open settings page
/// refreshes without a remount. The frontend `CONNECTORS_CHANGED_EVENT`
/// subscribes to this.
const CONNECTORS_CHANGED_EVENT: &str = "june://connectors-changed";

fn emit_connectors_changed(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let _ = app.emit(CONNECTORS_CHANGED_EVENT, ());
}

async fn mark_reconnect_required(app: &tauri::AppHandle, account_id: &str) {
    match crate::commands::repositories(app).await {
        Ok(repos) => {
            if let Err(error) = repos
                .set_connector_account_status(
                    account_id,
                    ConnectorAccountStatus::ReconnectRequired.as_str(),
                )
                .await
            {
                tracing::warn!(
                    error_code = %AppError::from(error).code,
                    "failed to flag connector account for reconnect"
                );
            } else {
                // A background refresh just downgraded this account; tell any
                // open settings page so it does not show a stale "Connected".
                emit_connectors_changed(app);
            }
        }
        Err(error) => {
            tracing::warn!(
                error_code = %error.code,
                "failed to open repositories to flag connector reconnect"
            );
        }
    }
}

// --- Account lifecycle -------------------------------------------------------------

/// Build the frontend-facing DTO for one stored account row: map the
/// provider/status columns, parse the metadata JSON, and load the selected
/// teams. The single mapping shared by [`list_accounts`], the connect
/// short-circuits, and the team-selection command, so the row-to-DTO
/// translation cannot drift between call sites.
async fn account_dto(
    repos: &crate::db::repositories::Repositories,
    record: crate::db::repositories::ConnectorAccountRecord,
) -> Result<ConnectorAccount, AppError> {
    // Best-effort: a malformed metadata blob degrades to "no workspace
    // info" rather than failing the whole account list.
    let metadata: ConnectorAccountMetadata =
        serde_json::from_str(&record.metadata).unwrap_or_default();
    // Same best-effort stance for the team rows: account enumeration was
    // infallible before selected teams existed, and callers treat an Err as
    // "no accounts" (blanking the settings page and routine gates), so one
    // transient DB hiccup on one row must not fail the whole list.
    let selected_teams = match repos.list_selected_teams(&record.account_id).await {
        Ok(teams) => teams
            .into_iter()
            .map(|team| SelectedTeamDto {
                id: team.team_id,
                key: team.team_key,
                name: team.team_name,
            })
            .collect(),
        Err(error) => {
            tracing::warn!(
                error_code = %AppError::from(error).code,
                "listing selected teams failed; account enumerates with an empty team set"
            );
            Vec::new()
        }
    };
    Ok(ConnectorAccount {
        account_id: record.account_id,
        provider: ConnectorProvider::from_db(&record.provider),
        email: record.email,
        scopes: record.scopes,
        status: ConnectorAccountStatus::from_db(&record.status),
        workspace_name: metadata.workspace_name,
        workspace_url_key: metadata.workspace_url_key,
        selected_teams,
    })
}

/// Enumerate persisted Google accounts from the non-secret DB index.
///
/// This intentionally does not inspect Notion. Callers that need a real Google
/// identity for grants or Google MCP registration must use this provider-scoped
/// listing so the synthetic Notion preview row can never be treated as an email.
pub async fn list_google_accounts(
    app: &tauri::AppHandle,
) -> Result<Vec<ConnectorAccount>, AppError> {
    let repos = crate::commands::repositories(app).await?;
    let records = repos.list_connector_accounts().await?;
    let mut accounts = Vec::new();
    for record in records {
        if record.provider == ConnectorProvider::Google.as_str() {
            accounts.push(account_dto(&repos, record).await?);
        }
    }
    Ok(accounts)
}

/// Enumerate the persisted account index used for Google and Linear runtime
/// registration. Notion is deliberately excluded: its optional Keychain state
/// must never hide otherwise healthy database-backed connector accounts.
pub async fn list_runtime_accounts(
    app: &tauri::AppHandle,
) -> Result<Vec<ConnectorAccount>, AppError> {
    let repos = crate::commands::repositories(app).await?;
    let records = repos.list_connector_accounts().await?;
    let mut accounts = Vec::with_capacity(records.len());
    for record in records {
        if record.provider != ConnectorProvider::Notion.as_str() {
            accounts.push(account_dto(&repos, record).await?);
        }
    }
    Ok(accounts)
}

/// Enumerate connected accounts for shared API consumers.
pub async fn list_accounts(app: &tauri::AppHandle) -> Result<Vec<ConnectorAccount>, AppError> {
    let mut accounts = list_runtime_accounts(app).await?;
    append_notion_account(&mut accounts, notion::account_status(app).await, false)?;
    Ok(accounts)
}

/// Enumerate accounts for the Connectors settings UI.
///
/// The settings provider directory owns disconnected rows, so an unreadable
/// optional Notion preview is represented by omission here only. Shared API
/// consumers should call [`list_accounts`] and receive the Notion read error.
pub async fn list_accounts_resilient(
    app: &tauri::AppHandle,
) -> Result<Vec<ConnectorAccount>, AppError> {
    let repos = crate::commands::repositories(app).await?;
    let records = repos.list_connector_accounts().await?;
    let mut accounts = Vec::with_capacity(records.len() + 1);
    for record in records {
        if record.provider != ConnectorProvider::Notion.as_str() {
            accounts.push(account_dto(&repos, record).await?);
        }
    }
    append_notion_account(&mut accounts, notion::account_status(app).await, true)?;
    Ok(accounts)
}

fn append_notion_account(
    accounts: &mut Vec<ConnectorAccount>,
    status: Result<Option<ConnectorAccountStatus>, AppError>,
    suppress_error: bool,
) -> Result<(), AppError> {
    match status {
        Ok(Some(status)) => accounts.push(ConnectorAccount {
            account_id: notion::notion_account_id().to_string(),
            provider: ConnectorProvider::Notion,
            email: notion::notion_account_email().to_string(),
            scopes: Vec::new(),
            status,
            workspace_name: None,
            workspace_url_key: None,
            selected_teams: Vec::new(),
        }),
        Ok(None) => {}
        Err(error) if suppress_error => {
            tracing::warn!(
                error_code = %error.code,
                "failed to read optional Notion connector status; omitting Notion from settings account listing"
            );
        }
        Err(error) => return Err(error),
    }
    Ok(())
}

/// The identity of an already-stored account, for the SAME provider, that
/// differs from the one being connected, if any. The identity string is
/// whatever keys that provider's accounts: the email for Google, the
/// workspace id for Linear. Local mode is single-account per provider
/// (every connector surface for a given provider resolves the one connected
/// account for that provider), so a second, distinct account for that
/// provider is refused to avoid a cross-account read/write mix-up. A
/// different provider's account never conflicts: a connected Google account
/// must not block connecting Linear, and vice versa. Comparison is
/// case-insensitive, so reconnecting or adding scope to the same identity
/// returns `None` and is allowed.
fn conflicting_existing_account<'a>(
    existing: impl IntoIterator<Item = (&'a str, &'a str)>,
    connecting_provider: &str,
    connecting_identity: &str,
) -> Option<String> {
    existing
        .into_iter()
        .filter(|(provider, _)| *provider == connecting_provider)
        .find(|(_, identity)| !identity.eq_ignore_ascii_case(connecting_identity))
        .map(|(_, identity)| identity.to_string())
}

/// Run the full connect flow (browser consent, loopback callback, code
/// exchange, custody write, DB index upsert) for the requested scope
/// bundles. With a `login_hint` for an already-connected account whose
/// granted scopes already cover the request, no browser round-trip happens
/// (incremental auth short-circuit).
pub async fn begin_connect(
    app: &tauri::AppHandle,
    flow: &ConnectFlow,
    bundles: &[scopes::ScopeBundle],
    login_hint: Option<&str>,
) -> Result<ConnectorAccount, AppError> {
    let client = require_oauth_client()?;
    let repos = crate::commands::repositories(app).await?;

    // Escalation short-circuit: an existing, healthy account that already
    // holds every wanted scope needs no new consent.
    if let Some(hint) = login_hint.map(str::trim).filter(|hint| !hint.is_empty()) {
        let hint_lower = hint.to_ascii_lowercase();
        if let Some(record) = repos.get_connector_account(&hint_lower).await? {
            let already_granted = scopes::missing_scopes(&record.scopes, bundles).is_empty();
            if already_granted && record.status == ConnectorAccountStatus::Connected.as_str() {
                return account_dto(&repos, record).await;
            }
        }
    }

    let requested = scopes::requested_scopes(bundles);
    let grant = oauth::authorize(
        flow,
        &client.client_id,
        &client.client_secret,
        &requested,
        login_hint,
    )
    .await?;
    let email = grant.email.clone();

    // A login hint means the user asked to (re)connect one specific account.
    // Google only preselects it; the browser can still consent as a different
    // account. Abort on mismatch rather than silently storing the wrong account
    // (which would leave the intended account still flagged reconnect_required).
    if let Some(hint) = login_hint.map(str::trim).filter(|hint| !hint.is_empty()) {
        if !email.eq_ignore_ascii_case(hint) {
            return Err(AppError::new(
                "connector_account_mismatch",
                "That Google account does not match the one you were reconnecting. Try again and choose that account.",
            ));
        }
    }

    // Local mode v1 binds every connector surface to a single account: the base
    // Gmail/Calendar MCP servers, the per-job autonomy servers, and every
    // trigger all independently resolve "the connected account" (the first
    // connected row). A second, distinct account would let a routine created
    // against account B silently read or mutate account A's mail and calendar,
    // a cross-account privacy leak. Refuse a different account while one is
    // already stored; reconnecting or adding scope to the same email still
    // passes (the email matches). Multi-account routing is a documented
    // follow-up. Checked after auth because the account identity is only known
    // once Google returns it; the settings UI also hides "add another" so this
    // guard is the safety net, not the primary path.
    let existing_accounts = repos.list_connector_accounts().await?;
    if let Some(existing_email) = conflicting_existing_account(
        existing_accounts
            .iter()
            .map(|record| (record.provider.as_str(), record.email.as_str())),
        ConnectorProvider::Google.as_str(),
        &email,
    ) {
        return Err(AppError::new(
            "connector_single_account_only",
            format!(
                "June local mode uses one Google account at a time. Disconnect {existing_email} before connecting another."
            ),
        ));
    }

    // Persist the account's scopes. When Google omits the response scope field
    // on an incremental grant, this unions the requested scopes with the ones
    // the account already held, so add-access never makes the DB forget earlier
    // grants the token still carries. Matched by provider AND email: a Linear
    // row can carry the same email (the Linear viewer email is often the
    // Google address), and its "read"/"write" scopes must never leak into the
    // Google account's persisted grant.
    let existing_scopes = existing_accounts
        .iter()
        .find(|record| {
            record.provider == ConnectorProvider::Google.as_str()
                && record.email.eq_ignore_ascii_case(&email)
        })
        .map(|record| record.scopes.as_slice());
    let granted_scopes =
        scopes::resolve_granted_scopes(grant.tokens.scope.as_deref(), &requested, existing_scopes);

    // Scope escalation on an existing grant can omit the refresh token; keep
    // the one already in custody then.
    let refresh_token = match grant
        .tokens
        .refresh_token
        .as_deref()
        .filter(|token| !token.is_empty())
    {
        Some(token) => token.to_string(),
        None => store::load_tokens(ConnectorProvider::Google, &email)
            .await?
            .map(|existing| existing.refresh_token.clone())
            .ok_or_else(|| {
                AppError::new(
                    "connector_missing_refresh_token",
                    "Google did not return a refresh token. Remove June's access at myaccount.google.com/permissions and connect again.",
                )
            })?,
    };

    let tokens = store::StoredConnectorTokens {
        access_token: grant.tokens.access_token.clone(),
        refresh_token,
        expires_at_unix: now_unix() + grant.tokens.expires_in.max(0),
        scopes: granted_scopes.clone(),
        email: email.clone(),
    };
    store::store_tokens(ConnectorProvider::Google, &email, &tokens).await?;

    repos
        .upsert_connector_account(
            &email,
            ConnectorProvider::Google.as_str(),
            &email,
            &granted_scopes,
            ConnectorAccountStatus::Connected.as_str(),
            "{}",
        )
        .await?;
    emit_connectors_changed(app);

    Ok(ConnectorAccount {
        account_id: email.clone(),
        provider: ConnectorProvider::Google,
        email,
        scopes: granted_scopes,
        status: ConnectorAccountStatus::Connected,
        workspace_name: None,
        workspace_url_key: None,
        selected_teams: Vec::new(),
    })
}

/// The non-secret metadata blob persisted on a Linear account row. Keys are
/// camelCase to match [`ConnectorAccountMetadata`]'s parse; empty-string
/// fields are omitted rather than stored as noise.
fn linear_account_metadata_json(identity: &linear::LinearIdentity) -> String {
    let mut map = serde_json::Map::new();
    for (key, value) in [
        ("workspaceName", &identity.workspace_name),
        ("workspaceUrlKey", &identity.workspace_url_key),
        ("actorUserId", &identity.user_id),
        ("actorName", &identity.user_name),
    ] {
        if !value.is_empty() {
            map.insert(key.to_string(), serde_json::Value::String(value.clone()));
        }
    }
    serde_json::Value::Object(map).to_string()
}

/// Run the full Linear connect flow (browser consent, loopback callback,
/// code exchange, identity resolution, custody write, DB index upsert) for
/// the requested scope bundles. The account is keyed by WORKSPACE id, not
/// email: a Linear grant is a workspace grant, and `reconnect_account_id`
/// carries that id on a reconnect or scope escalation. With a
/// `reconnect_account_id` naming an already-connected workspace whose
/// granted scopes cover the request, no browser round-trip happens
/// (mirroring the Google incremental-auth short-circuit).
pub async fn begin_connect_linear(
    app: &tauri::AppHandle,
    flow: &ConnectFlow,
    bundles: &[scopes::ScopeBundle],
    reconnect_account_id: Option<&str>,
) -> Result<ConnectorAccount, AppError> {
    // Defensive: the command layer validates too, but a Google bundle here
    // would request Google scope URLs from Linear's consent screen.
    if let Some(bundle) = bundles
        .iter()
        .find(|bundle| bundle.provider() != ConnectorProvider::Linear)
    {
        return Err(AppError::new(
            "connector_scope_provider_mismatch",
            format!(
                "Scope bundle \"{}\" does not belong to the linear connector.",
                bundle.name()
            ),
        ));
    }
    let client_id = require_linear_client_id()?;
    let repos = crate::commands::repositories(app).await?;

    let reconnect_account_id = reconnect_account_id
        .map(str::trim)
        .filter(|id| !id.is_empty());

    // Escalation/reconnect short-circuit: an existing, healthy workspace
    // that already holds every wanted scope needs no new consent.
    if let Some(account_id) = reconnect_account_id {
        if let Some(record) = repos.get_connector_account(account_id).await? {
            let already_granted = scopes::missing_scopes(&record.scopes, bundles).is_empty();
            if record.provider == ConnectorProvider::Linear.as_str()
                && already_granted
                && record.status == ConnectorAccountStatus::Connected.as_str()
            {
                return account_dto(&repos, record).await;
            }
        }
    }

    let requested = scopes::requested_linear_scopes(bundles);
    let grant = linear::authorize(flow, &client_id, &requested, &linear_loopback_ports()).await?;
    let identity = grant.identity;
    let workspace_id = identity.workspace_id.clone();

    // A reconnect id means the user asked to (re)connect one specific
    // workspace. The browser can still consent for a different one; abort on
    // mismatch rather than silently storing the wrong workspace (which would
    // leave the intended one still flagged reconnect_required).
    if let Some(expected) = reconnect_account_id {
        if !workspace_id.eq_ignore_ascii_case(expected) {
            return Err(AppError::new(
                "connector_account_mismatch",
                "That Linear workspace does not match the one you were reconnecting. Try again and pick that workspace.",
            ));
        }
    }

    // Same single-account rationale as the Google guard above, scoped to the
    // Linear provider: every Linear surface resolves "the connected
    // workspace", so a second, distinct workspace is refused. Compared by
    // workspace id (the account id), never email.
    let existing_accounts = repos.list_connector_accounts().await?;
    if let Some(existing_id) = conflicting_existing_account(
        existing_accounts
            .iter()
            .map(|record| (record.provider.as_str(), record.account_id.as_str())),
        ConnectorProvider::Linear.as_str(),
        &workspace_id,
    ) {
        // Name the stored workspace when its metadata carries a name; the
        // raw id is a last resort that at least identifies the row.
        let display = existing_accounts
            .iter()
            .find(|record| record.account_id == existing_id)
            .and_then(|record| {
                serde_json::from_str::<ConnectorAccountMetadata>(&record.metadata).ok()
            })
            .and_then(|metadata| metadata.workspace_name)
            .filter(|name| !name.is_empty())
            .unwrap_or(existing_id);
        return Err(AppError::new(
            "connector_single_account_only",
            format!(
                "June local mode uses one Linear workspace at a time. Disconnect {display} before connecting another."
            ),
        ));
    }

    // Persist the granted scopes: Linear's response scope field when it
    // carries anything, otherwise the requested list.
    let granted_scopes: Vec<String> = grant
        .tokens
        .scope
        .as_deref()
        .map(linear::parse_scope_field)
        .filter(|scopes| !scopes.is_empty())
        .unwrap_or_else(|| requested.iter().map(|scope| scope.to_string()).collect());

    // Scope escalation on an existing grant can omit the refresh token; keep
    // the one already in custody then (mirrors the Google fallback).
    let refresh_token = match grant
        .tokens
        .refresh_token
        .as_deref()
        .filter(|token| !token.is_empty())
    {
        Some(token) => token.to_string(),
        None => store::load_tokens(ConnectorProvider::Linear, &workspace_id)
            .await?
            .map(|existing| existing.refresh_token.clone())
            .ok_or_else(|| {
                AppError::new(
                    "connector_missing_refresh_token",
                    "Linear did not return a refresh token. Remove June's access in Linear settings and connect again.",
                )
            })?,
    };

    let tokens = store::StoredConnectorTokens {
        access_token: grant.tokens.access_token.clone(),
        refresh_token,
        expires_at_unix: now_unix() + grant.tokens.expires_in.max(0),
        scopes: granted_scopes.clone(),
        // May be empty; informational only. The workspace id keys custody.
        email: identity.user_email.clone(),
    };
    store::store_tokens(ConnectorProvider::Linear, &workspace_id, &tokens).await?;

    let metadata_json = linear_account_metadata_json(&identity);
    repos
        .upsert_connector_account(
            &workspace_id,
            ConnectorProvider::Linear.as_str(),
            &identity.user_email,
            &granted_scopes,
            ConnectorAccountStatus::Connected.as_str(),
            &metadata_json,
        )
        .await?;
    emit_connectors_changed(app);

    // On a reconnect the previous team selection survives (the rows were
    // never deleted); a fresh connect has none until the user picks teams.
    let selected_teams = repos
        .list_selected_teams(&workspace_id)
        .await?
        .into_iter()
        .map(|team| SelectedTeamDto {
            id: team.team_id,
            key: team.team_key,
            name: team.team_name,
        })
        .collect();
    Ok(ConnectorAccount {
        account_id: workspace_id,
        provider: ConnectorProvider::Linear,
        email: identity.user_email,
        scopes: granted_scopes,
        status: ConnectorAccountStatus::Connected,
        workspace_name: Some(identity.workspace_name).filter(|name| !name.is_empty()),
        workspace_url_key: Some(identity.workspace_url_key).filter(|key| !key.is_empty()),
        selected_teams,
    })
}

/// Abort an in-flight connect (drains the browser-handoff wait).
pub fn cancel_connect(flow: &ConnectFlow) {
    flow.cancel();
}

/// Disconnect an account: optionally revoke the grant at the provider
/// (best-effort), always remove local custody, and drop the account from
/// the DB index along with its triggers, cursors, and selected teams. The
/// provider is read from the account row; when the row is already gone
/// (a half-completed earlier disconnect), custody cleanup sweeps BOTH
/// providers' keychain services so no token is ever stranded.
pub async fn disconnect(
    app: &tauri::AppHandle,
    account_id: &str,
    revoke_grant: bool,
) -> Result<(), AppError> {
    let repos = crate::commands::repositories(app).await?;
    let providers: &[ConnectorProvider] = match repos.get_connector_account(account_id).await? {
        Some(record) => match ConnectorProvider::from_db(&record.provider) {
            ConnectorProvider::Google => &[ConnectorProvider::Google],
            ConnectorProvider::Linear => &[ConnectorProvider::Linear],
            ConnectorProvider::Notion => &[],
        },
        None => &[ConnectorProvider::Google, ConnectorProvider::Linear],
    };
    for &provider in providers {
        if revoke_grant {
            if let Ok(Some(stored)) = store::load_tokens(provider, account_id).await {
                match provider {
                    ConnectorProvider::Google => {
                        // Google: revoking either token of the pair
                        // invalidates the whole grant; prefer the refresh
                        // token.
                        let token = if stored.refresh_token.is_empty() {
                            stored.access_token.clone()
                        } else {
                            stored.refresh_token.clone()
                        };
                        if !token.is_empty() {
                            let _ = oauth::revoke(&token).await;
                        }
                    }
                    ConnectorProvider::Linear => {
                        // Linear documents no cross-token cascade, so revoke
                        // BOTH tokens: a lone refresh-token revoke can leave
                        // the 24-hour access token alive and the app still
                        // listed under the user's authorized applications.
                        if !stored.refresh_token.is_empty() {
                            let _ = linear::revoke(&stored.refresh_token, "refresh_token").await;
                        }
                        if !stored.access_token.is_empty() {
                            let _ = linear::revoke(&stored.access_token, "access_token").await;
                        }
                    }
                    ConnectorProvider::Notion => {}
                }
            }
        }
        store::delete_tokens(provider, account_id).await?;
    }
    repos.delete_connector_account(account_id).await?;
    emit_connectors_changed(app);
    Ok(())
}

// --- Linear team enforcement (agent reads) -----------------------------------------
//
// The selected-team grant is the enforcement boundary for every `june_linear`
// agent read (slice 2, JUN-284): the provider-proxy route handlers (a later
// chunk) load the grant once per request via [`linear_granted_team_ids`] and
// check individual reads against it with [`linear_require_team_granted`] /
// [`linear_require_any_team_granted`]. Both stable error codes are defined
// here because this is where the caller-level checks live; `linear.rs`
// itself never sees an `AppHandle` or the repository layer, so it cannot
// construct these errors directly.

fn linear_teams_not_selected_error() -> AppError {
    AppError::new(
        "linear_teams_not_selected",
        "Select Linear teams in settings before June can read this workspace.",
    )
}

fn linear_team_not_granted_error() -> AppError {
    AppError::new(
        "linear_team_not_granted",
        "That team is not in June's selected teams.",
    )
}

/// Pure "records -> granted ids or error" mapping behind
/// [`linear_granted_team_ids`]: an empty selection fails closed rather than
/// letting a caller silently query an unscoped workspace (spec decision 7).
fn granted_team_ids_from_records(
    records: &[crate::db::repositories::SelectedTeamRecord],
) -> Result<Vec<String>, AppError> {
    if records.is_empty() {
        return Err(linear_teams_not_selected_error());
    }
    Ok(records.iter().map(|team| team.team_id.clone()).collect())
}

/// Load the account's selected-team grant for a `june_linear` read. Errors
/// `linear_teams_not_selected` when the account has no selected teams -
/// every team-scoped route calls this before doing anything else, so an
/// empty grant fails the whole request closed rather than reading an
/// unscoped workspace.
pub async fn linear_granted_team_ids(
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<Vec<String>, AppError> {
    let repos = crate::commands::repositories(app).await?;
    let records = repos.list_selected_teams(account_id).await?;
    granted_team_ids_from_records(&records)
}

/// Validate a single team id against the grant: used where the caller names
/// one team directly (`list_cycles`'s `team_id`, `search_issues`'s optional
/// team narrow). Errors `linear_team_not_granted` when `team_id` is not in
/// `granted_team_ids`.
pub fn linear_require_team_granted(
    team_id: &str,
    granted_team_ids: &[String],
) -> Result<(), AppError> {
    if granted_team_ids.iter().any(|granted| granted == team_id) {
        Ok(())
    } else {
        Err(linear_team_not_granted_error())
    }
}

/// Validate that at least one of `team_ids` (an already-fetched issue's or
/// project's linked teams) is in the grant: the post-fetch check for
/// `get_issue` / `list_issue_comments` / `list_project_updates`. The caller
/// discards the fetched data on `Err` rather than returning it partially.
/// Errors `linear_team_not_granted`.
pub fn linear_require_any_team_granted(
    team_ids: &[String],
    granted_team_ids: &[String],
) -> Result<(), AppError> {
    let granted = team_ids
        .iter()
        .any(|id| granted_team_ids.iter().any(|granted| granted == id));
    if granted {
        Ok(())
    } else {
        Err(linear_team_not_granted_error())
    }
}

// --- Linear writes: action ids, journal, stable errors (slice 3) --------------------
//
// Every Linear mutation is journaled in `connector_actions` (migration 015)
// around the provider call: `pending` before, then exactly one of
// `committed` / `failed` / `ambiguous`. The journal is an AUDIT surface, not
// a gate: a journal write failure is logged and swallowed, because failing
// the user's already-approved mutation over local bookkeeping would be
// strictly worse than a missing journal row (the mutation itself stays
// reconcilable through its client-minted object id). The stable write-flow
// error constructors live here, next to the read-flow ones above, so their
// wording exists in exactly one place.

/// Mint the client-side v4 UUID for a Linear create: it becomes the created
/// object's id at Linear (making the create idempotent and reconcilable)
/// AND the journal's action id. Hyphenated lowercase, e.g.
/// `67e55044-10b1-426f-9247-bb680e5fe0c8`.
pub fn mint_action_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// The update conflicted with a newer edit: the issue's `updatedAt` no
/// longer matches the `expected_updated_at` the agent supplied from its last
/// read. The route layer returns this WITHOUT mutating anything.
pub fn linear_issue_conflict_error() -> AppError {
    AppError::new(
        "linear_issue_conflict",
        "This issue changed since June last read it. Re-read it and try again.",
    )
}

/// The mutation's outcome is unknown (timeout or transport loss, and the
/// reconciliation lookup could not confirm the object exists). Carries the
/// action id so the user can locate the attempt; the agent must NOT retry.
pub fn linear_action_ambiguous_error(action_id: &str) -> AppError {
    AppError::new(
        "linear_action_ambiguous",
        format!(
            "June could not confirm whether Linear applied this change. Check Linear before retrying; action id {action_id}."
        ),
    )
}

/// Journal a mutation attempt as `pending` before the provider call.
/// Best-effort by design: on a DB failure this logs a warning and returns -
/// the journal must never block or fail a mutation the user approved.
pub async fn journal_action_pending(
    app: &tauri::AppHandle,
    action_id: &str,
    account_id: &str,
    tool: &str,
    summary: &str,
) {
    let result = match crate::commands::repositories(app).await {
        Ok(repos) => repos
            .insert_connector_action(action_id, account_id, tool, summary)
            .await
            .map_err(AppError::from),
        Err(error) => Err(error),
    };
    if let Err(error) = result {
        tracing::warn!(
            error_code = %error.code,
            tool,
            "journaling pending connector action failed; continuing with the mutation"
        );
    }
}

/// Record a journaled mutation's outcome (`committed` / `ambiguous` /
/// `failed`). Best-effort like [`journal_action_pending`]: the user-facing
/// outcome of the mutation is already decided by the time this runs, so a
/// journal failure is logged, never surfaced.
pub async fn journal_action_resolved(app: &tauri::AppHandle, action_id: &str, status: &str) {
    let result = match crate::commands::repositories(app).await {
        Ok(repos) => repos
            .resolve_connector_action(action_id, status)
            .await
            .map_err(AppError::from),
        Err(error) => Err(error),
    };
    if let Err(error) = result {
        tracing::warn!(
            error_code = %error.code,
            status,
            "resolving journaled connector action failed"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_and_status_serialize_snake_case() {
        assert_eq!(
            serde_json::to_string(&ConnectorProvider::Google).unwrap(),
            "\"google\""
        );
        assert_eq!(
            serde_json::to_string(&ConnectorProvider::Notion).unwrap(),
            "\"notion\""
        );
        assert_eq!(
            serde_json::from_str::<ConnectorProvider>("\"notion\"").unwrap(),
            ConnectorProvider::Notion
        );
        assert_eq!(ConnectorProvider::Notion.as_str(), "notion");
        assert_eq!(
            serde_json::to_string(&ConnectorProvider::Linear).unwrap(),
            "\"linear\""
        );
        assert_eq!(
            serde_json::to_string(&ConnectorAccountStatus::ReconnectRequired).unwrap(),
            "\"reconnect_required\""
        );
        assert_eq!(
            serde_json::from_str::<ConnectorAccountStatus>("\"connected\"").unwrap(),
            ConnectorAccountStatus::Connected
        );
    }

    #[test]
    fn provider_from_db_defaults_to_google() {
        assert_eq!(
            ConnectorProvider::from_db("google"),
            ConnectorProvider::Google
        );
        assert_eq!(
            ConnectorProvider::from_db("linear"),
            ConnectorProvider::Linear
        );
        assert_eq!(
            ConnectorProvider::from_db("unexpected"),
            ConnectorProvider::Google
        );
    }

    #[test]
    fn account_serializes_camel_case_for_the_frontend() {
        let account = ConnectorAccount {
            account_id: "user@example.com".to_string(),
            provider: ConnectorProvider::Google,
            email: "user@example.com".to_string(),
            scopes: vec!["openid".to_string()],
            status: ConnectorAccountStatus::Connected,
            workspace_name: None,
            workspace_url_key: None,
            selected_teams: Vec::new(),
        };
        let json = serde_json::to_value(&account).unwrap();
        assert_eq!(json["accountId"], "user@example.com");
        assert_eq!(json["provider"], "google");
        assert_eq!(json["status"], "connected");
        assert!(json["workspaceName"].is_null());
        assert!(json["workspaceUrlKey"].is_null());
        assert_eq!(json["selectedTeams"], serde_json::json!([]));

        let linear_account = ConnectorAccount {
            account_id: "workspace-1".to_string(),
            provider: ConnectorProvider::Linear,
            email: String::new(),
            scopes: Vec::new(),
            status: ConnectorAccountStatus::Connected,
            workspace_name: Some("Acme".to_string()),
            workspace_url_key: Some("acme".to_string()),
            selected_teams: vec![SelectedTeamDto {
                id: "team-1".to_string(),
                key: "ENG".to_string(),
                name: "Engineering".to_string(),
            }],
        };
        let json = serde_json::to_value(&linear_account).unwrap();
        assert_eq!(json["provider"], "linear");
        assert_eq!(json["workspaceName"], "Acme");
        assert_eq!(json["workspaceUrlKey"], "acme");
        assert_eq!(json["selectedTeams"][0]["id"], "team-1");
        assert_eq!(json["selectedTeams"][0]["key"], "ENG");
        assert_eq!(json["selectedTeams"][0]["name"], "Engineering");
    }

    #[test]
    fn notion_account_serializes_camel_case_for_the_frontend() {
        let account = ConnectorAccount {
            account_id: notion::notion_account_id().to_string(),
            provider: ConnectorProvider::Notion,
            email: notion::notion_account_email().to_string(),
            scopes: Vec::new(),
            status: ConnectorAccountStatus::Connected,
            workspace_name: None,
            workspace_url_key: None,
            selected_teams: Vec::new(),
        };
        let json = serde_json::to_value(&account).unwrap();
        assert_eq!(json["accountId"], "notion-hosted-mcp");
        assert_eq!(json["provider"], "notion");
        assert_eq!(json["email"], "Notion");
        assert_eq!(json["scopes"].as_array().unwrap().len(), 0);
        assert_eq!(json["status"], "connected");
        assert!(json["workspaceName"].is_null());
        assert!(json["workspaceUrlKey"].is_null());
        assert_eq!(json["selectedTeams"], serde_json::json!([]));
    }

    #[test]
    fn append_notion_account_preserves_errors_unless_resilient() {
        let mut strict = Vec::new();
        let error = AppError::new("notion_keychain_read_failed", "failed");
        assert!(append_notion_account(&mut strict, Err(error.clone()), false).is_err());
        assert!(strict.is_empty());

        let mut resilient = Vec::new();
        append_notion_account(&mut resilient, Err(error), true).unwrap();
        assert!(resilient.is_empty());
    }

    #[test]
    fn append_notion_account_adds_synthetic_connected_row() {
        let mut accounts = Vec::new();
        append_notion_account(
            &mut accounts,
            Ok(Some(ConnectorAccountStatus::Connected)),
            false,
        )
        .unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].provider, ConnectorProvider::Notion);
        assert_eq!(accounts[0].account_id, notion::notion_account_id());
        assert_eq!(accounts[0].email, notion::notion_account_email());
        assert!(accounts[0].selected_teams.is_empty());
    }

    #[test]
    fn append_notion_account_preserves_reconnect_required_status() {
        let mut accounts = Vec::new();
        append_notion_account(
            &mut accounts,
            Ok(Some(ConnectorAccountStatus::ReconnectRequired)),
            false,
        )
        .unwrap();
        assert_eq!(
            accounts[0].status,
            ConnectorAccountStatus::ReconnectRequired
        );
    }

    #[test]
    fn freshness_uses_expiry_buffer() {
        let now = 1_000_000;
        assert!(access_token_is_fresh(now + 61, now));
        assert!(!access_token_is_fresh(now + 60, now));
        assert!(!access_token_is_fresh(now - 1, now));
    }

    #[test]
    fn status_from_db_defaults_to_connected() {
        assert_eq!(
            ConnectorAccountStatus::from_db("reconnect_required"),
            ConnectorAccountStatus::ReconnectRequired
        );
        assert_eq!(
            ConnectorAccountStatus::from_db("connected"),
            ConnectorAccountStatus::Connected
        );
        assert_eq!(
            ConnectorAccountStatus::from_db("unexpected"),
            ConnectorAccountStatus::Connected
        );
    }

    #[test]
    fn single_account_guard_blocks_a_different_account_only() {
        // First-ever connect: nothing stored, nothing conflicts.
        assert_eq!(
            conflicting_existing_account([], "google", "a@example.com"),
            None
        );
        // Reconnect or scope-add on the same account (any casing) is allowed.
        assert_eq!(
            conflicting_existing_account([("google", "a@example.com")], "google", "A@Example.com"),
            None
        );
        // A second, distinct account is refused, naming the stored one.
        assert_eq!(
            conflicting_existing_account([("google", "a@example.com")], "google", "b@example.com"),
            Some("a@example.com".to_string())
        );
        // The stored account is reported even when the new one is also present
        // in the list (defensive: only the differing email matters).
        assert_eq!(
            conflicting_existing_account(
                [("google", "a@example.com"), ("google", "b@example.com")],
                "google",
                "b@example.com"
            ),
            Some("a@example.com".to_string())
        );
    }

    #[test]
    fn linear_metadata_json_omits_empty_fields_and_round_trips() {
        let identity = linear::LinearIdentity {
            workspace_id: "org-1".to_string(),
            workspace_name: "Acme".to_string(),
            workspace_url_key: String::new(),
            user_id: "user-1".to_string(),
            user_name: String::new(),
            user_email: "ada@example.com".to_string(),
        };
        let raw = linear_account_metadata_json(&identity);
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(json["workspaceName"], "Acme");
        assert_eq!(json["actorUserId"], "user-1");
        assert!(json.get("workspaceUrlKey").is_none());
        assert!(json.get("actorName").is_none());
        // The stored blob parses back through the account-metadata reader
        // that list_accounts uses.
        let metadata: ConnectorAccountMetadata = serde_json::from_str(&raw).unwrap();
        assert_eq!(metadata.workspace_name.as_deref(), Some("Acme"));
        assert_eq!(metadata.workspace_url_key, None);
    }

    #[test]
    fn linear_loopback_ports_prefer_a_valid_env_override_only() {
        // A parseable non-zero override narrows the candidates to that port.
        assert_eq!(linear_loopback_ports_from("50000"), vec![50000]);
        // Empty, garbage, zero, and out-of-range values all fall back to the
        // registered defaults instead of breaking the connect flow.
        assert_eq!(linear_loopback_ports_from(""), LINEAR_LOOPBACK_PORTS);
        assert_eq!(
            linear_loopback_ports_from("not-a-port"),
            LINEAR_LOOPBACK_PORTS
        );
        assert_eq!(linear_loopback_ports_from("0"), LINEAR_LOOPBACK_PORTS);
        assert_eq!(linear_loopback_ports_from("70000"), LINEAR_LOOPBACK_PORTS);
    }

    #[test]
    fn single_account_guard_ignores_other_providers() {
        // A connected Google account must never block connecting a Linear
        // workspace (and vice versa): the single-account guard is scoped per
        // provider, not global across the whole connector_accounts table.
        assert_eq!(
            conflicting_existing_account([("google", "a@example.com")], "linear", "workspace-1"),
            None
        );
        assert_eq!(
            conflicting_existing_account(
                [("linear", "workspace-1"), ("google", "a@example.com")],
                "google",
                "b@example.com"
            ),
            Some("a@example.com".to_string())
        );
    }

    fn selected_team(id: &str) -> crate::db::repositories::SelectedTeamRecord {
        crate::db::repositories::SelectedTeamRecord {
            team_id: id.to_string(),
            team_key: id.to_uppercase(),
            team_name: format!("Team {id}"),
        }
    }

    #[test]
    fn granted_team_ids_from_records_fails_closed_on_an_empty_selection() {
        let error = granted_team_ids_from_records(&[]).unwrap_err();
        assert_eq!(error.code, "linear_teams_not_selected");
    }

    #[test]
    fn granted_team_ids_from_records_maps_ids_when_present() {
        let records = vec![selected_team("eng"), selected_team("design")];
        let ids = granted_team_ids_from_records(&records).expect("granted ids");
        assert_eq!(ids, vec!["eng", "design"]);
    }

    #[test]
    fn linear_require_team_granted_checks_membership() {
        let granted = vec!["eng".to_string(), "design".to_string()];
        assert!(linear_require_team_granted("eng", &granted).is_ok());
        let error = linear_require_team_granted("ops", &granted).unwrap_err();
        assert_eq!(error.code, "linear_team_not_granted");
        // An empty grant refuses every team id, including one that would
        // otherwise match a non-empty grant.
        let error = linear_require_team_granted("eng", &[]).unwrap_err();
        assert_eq!(error.code, "linear_team_not_granted");
    }

    #[test]
    fn linear_require_any_team_granted_checks_intersection() {
        let granted = vec!["eng".to_string(), "design".to_string()];
        assert!(linear_require_any_team_granted(
            &["design".to_string(), "ops".to_string()],
            &granted
        )
        .is_ok());
        let error = linear_require_any_team_granted(&["ops".to_string()], &granted).unwrap_err();
        assert_eq!(error.code, "linear_team_not_granted");
        // An empty team-ids list (an entity linked to no team at all) and an
        // empty grant both refuse to match anything.
        let error = linear_require_any_team_granted(&[], &granted).unwrap_err();
        assert_eq!(error.code, "linear_team_not_granted");
        let error = linear_require_any_team_granted(&["eng".to_string()], &[]).unwrap_err();
        assert_eq!(error.code, "linear_team_not_granted");
    }

    #[test]
    fn mint_action_id_produces_hyphenated_lowercase_v4_uuids() {
        let id = mint_action_id();
        let bytes: Vec<char> = id.chars().collect();
        assert_eq!(bytes.len(), 36);
        for position in [8, 13, 18, 23] {
            assert_eq!(bytes[position], '-', "hyphen expected at {position}");
        }
        // RFC 4122: version nibble is 4, variant nibble is 8|9|a|b.
        assert_eq!(bytes[14], '4');
        assert!(matches!(bytes[19], '8' | '9' | 'a' | 'b'));
        assert_eq!(id, id.to_lowercase());
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));

        // Practically collision-free: 1000 mints, 1000 distinct ids.
        let mut ids: Vec<String> = (0..1000).map(|_| mint_action_id()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 1000);
    }

    #[test]
    fn linear_write_errors_carry_stable_codes_and_wording() {
        let conflict = linear_issue_conflict_error();
        assert_eq!(conflict.code, "linear_issue_conflict");
        assert_eq!(
            conflict.message,
            "This issue changed since June last read it. Re-read it and try again."
        );

        let ambiguous = linear_action_ambiguous_error("action-123");
        assert_eq!(ambiguous.code, "linear_action_ambiguous");
        assert_eq!(
            ambiguous.message,
            "June could not confirm whether Linear applied this change. Check Linear before retrying; action id action-123."
        );
    }
}
