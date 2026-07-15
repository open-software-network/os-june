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
    Linear,
}

impl ConnectorProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConnectorProvider::Google => "google",
            ConnectorProvider::Linear => "linear",
        }
    }

    /// Parse the `connector_accounts.provider` column. Unrecognized values
    /// default to `Google` (mirrors `ConnectorAccountStatus::from_db`'s
    /// defaulting style) rather than failing to load the whole account list
    /// over a single stale or corrupt row.
    pub fn from_db(value: &str) -> Self {
        match value {
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
/// for a Google row; a later Linear chunk keys it by workspace id instead.
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
                store::store_tokens(ConnectorProvider::Linear, account_id, &stored).await?;
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
    let selected_teams = repos
        .list_selected_teams(&record.account_id)
        .await?
        .into_iter()
        .map(|team| SelectedTeamDto {
            id: team.team_id,
            key: team.team_key,
            name: team.team_name,
        })
        .collect();
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

/// Enumerate connected accounts from the non-secret DB index (no keychain
/// access, so listing never prompts).
pub async fn list_accounts(app: &tauri::AppHandle) -> Result<Vec<ConnectorAccount>, AppError> {
    let repos = crate::commands::repositories(app).await?;
    let records = repos.list_connector_accounts().await?;
    let mut accounts = Vec::with_capacity(records.len());
    for record in records {
        accounts.push(account_dto(&repos, record).await?);
    }
    Ok(accounts)
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
    // grants the token still carries.
    let existing_scopes = existing_accounts
        .iter()
        .find(|record| record.email.eq_ignore_ascii_case(&email))
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
    let grant = linear::authorize(flow, &client_id, &requested).await?;
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
        },
        None => &[ConnectorProvider::Google, ConnectorProvider::Linear],
    };
    for &provider in providers {
        if revoke_grant {
            if let Ok(Some(stored)) = store::load_tokens(provider, account_id).await {
                // Revoking either token of the pair invalidates the whole
                // grant; prefer the refresh token.
                let token = if stored.refresh_token.is_empty() {
                    stored.access_token.clone()
                } else {
                    stored.refresh_token.clone()
                };
                if !token.is_empty() {
                    match provider {
                        ConnectorProvider::Google => {
                            let _ = oauth::revoke(&token).await;
                        }
                        ConnectorProvider::Linear => {
                            let _ = linear::revoke(&token).await;
                        }
                    }
                }
            }
        }
        store::delete_tokens(provider, account_id).await?;
    }
    repos.delete_connector_account(account_id).await?;
    emit_connectors_changed(app);
    Ok(())
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
}
