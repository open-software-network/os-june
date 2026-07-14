//! Private Google connectors, local mode.
//!
//! OAuth (PKCE + loopback), Keychain token custody, the scope registry, and
//! the direct Google REST client. The provider proxy and the trigger daemon
//! consume this module: they resolve an access token via
//! [`google_access_token`] and call the [`google`] functions with it. June
//! API and OpenSoftware infrastructure are never in the connector data path.
//!
//! Secrets live ONLY in the keychain ([`store`]); the SQLite index carries
//! non-secret account metadata (emails, scopes, status) so accounts can be
//! enumerated without keychain prompts. Tokens are never logged and never
//! serialized into errors.

pub mod approvals;
pub mod commands;
pub mod github;
pub mod github_store;
pub mod google;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorProvider {
    Google,
}

impl ConnectorProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConnectorProvider::Google => "google",
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
/// proxy to enumerate accounts. The account id IS the Google account email.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorAccount {
    pub account_id: String,
    pub provider: ConnectorProvider,
    pub email: String,
    pub scopes: Vec<String>,
    pub status: ConnectorAccountStatus,
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

/// Resolve a usable access token for the account: the cached token when it
/// is comfortably fresh, otherwise a refreshed one. Refreshes are serialized
/// per account and handle refresh-token rotation. On a definitive
/// `invalid_grant` the account is flagged `reconnect_required` in the DB
/// index and `connector_reconnect_required` is returned.
pub async fn google_access_token(
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<String, AppError> {
    let stored = store::load_tokens(account_id)
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
    let mut stored = store::load_tokens(account_id)
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
                store::store_tokens(&stored).await?;
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

/// Enumerate connected accounts from the non-secret DB index (no keychain
/// access, so listing never prompts).
pub async fn list_accounts(app: &tauri::AppHandle) -> Result<Vec<ConnectorAccount>, AppError> {
    let repos = crate::commands::repositories(app).await?;
    let records = repos.list_connector_accounts().await?;
    Ok(records
        .into_iter()
        .map(|record| ConnectorAccount {
            account_id: record.account_id,
            provider: ConnectorProvider::Google,
            email: record.email,
            scopes: record.scopes,
            status: ConnectorAccountStatus::from_db(&record.status),
        })
        .collect())
}

/// The email of an already-stored account that differs from the one being
/// connected, if any. Local mode is single-account (every connector surface
/// resolves the one connected account), so a second, distinct account is
/// refused to avoid a cross-account read/write mix-up. Comparison is
/// case-insensitive, so reconnecting or adding scope to the same email returns
/// `None` and is allowed.
fn conflicting_existing_account<'a>(
    existing_emails: impl IntoIterator<Item = &'a str>,
    connecting: &str,
) -> Option<String> {
    existing_emails
        .into_iter()
        .find(|email| !email.eq_ignore_ascii_case(connecting))
        .map(str::to_string)
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
                return Ok(ConnectorAccount {
                    account_id: record.account_id,
                    provider: ConnectorProvider::Google,
                    email: record.email,
                    scopes: record.scopes,
                    status: ConnectorAccountStatus::Connected,
                });
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
        existing_accounts.iter().map(|record| record.email.as_str()),
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
        None => store::load_tokens(&email)
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
    store::store_tokens(&tokens).await?;

    repos
        .upsert_connector_account(
            &email,
            ConnectorProvider::Google.as_str(),
            &email,
            &granted_scopes,
            ConnectorAccountStatus::Connected.as_str(),
        )
        .await?;
    emit_connectors_changed(app);

    Ok(ConnectorAccount {
        account_id: email.clone(),
        provider: ConnectorProvider::Google,
        email,
        scopes: granted_scopes,
        status: ConnectorAccountStatus::Connected,
    })
}

/// Abort an in-flight connect (drains the browser-handoff wait).
pub fn cancel_connect(flow: &ConnectFlow) {
    flow.cancel();
}

/// Disconnect an account: optionally revoke the grant at Google
/// (best-effort), always remove local custody, and drop the account from
/// the DB index along with its triggers and cursors.
pub async fn disconnect(
    app: &tauri::AppHandle,
    account_id: &str,
    revoke_grant: bool,
) -> Result<(), AppError> {
    if revoke_grant {
        if let Ok(Some(stored)) = store::load_tokens(account_id).await {
            // Revoking either token of the pair invalidates the whole grant;
            // prefer the refresh token.
            let token = if stored.refresh_token.is_empty() {
                stored.access_token.clone()
            } else {
                stored.refresh_token.clone()
            };
            if !token.is_empty() {
                let _ = oauth::revoke(&token).await;
            }
        }
    }
    store::delete_tokens(account_id).await?;
    let repos = crate::commands::repositories(app).await?;
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
            serde_json::to_string(&ConnectorAccountStatus::ReconnectRequired).unwrap(),
            "\"reconnect_required\""
        );
        assert_eq!(
            serde_json::from_str::<ConnectorAccountStatus>("\"connected\"").unwrap(),
            ConnectorAccountStatus::Connected
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
        };
        let json = serde_json::to_value(&account).unwrap();
        assert_eq!(json["accountId"], "user@example.com");
        assert_eq!(json["provider"], "google");
        assert_eq!(json["status"], "connected");
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
        assert_eq!(conflicting_existing_account([], "a@example.com"), None);
        // Reconnect or scope-add on the same account (any casing) is allowed.
        assert_eq!(
            conflicting_existing_account(["a@example.com"], "A@Example.com"),
            None
        );
        // A second, distinct account is refused, naming the stored one.
        assert_eq!(
            conflicting_existing_account(["a@example.com"], "b@example.com"),
            Some("a@example.com".to_string())
        );
        // The stored account is reported even when the new one is also present
        // in the list (defensive: only the differing email matters).
        assert_eq!(
            conflicting_existing_account(["a@example.com", "b@example.com"], "b@example.com"),
            Some("a@example.com".to_string())
        );
    }
}
