//! Identity-only integration with OS Accounts (Login with Open Software).
//!
//! Tokens live in the OS keychain (never the webview). Debug builds use a
//! separate keychain service by default. Metering goes through June API,
//! which holds the App API key — never this binary.
//!
//! Debug builds can opt into a plaintext token file for local development via
//! `OS_JUNE_DEV_PLAINTEXT_TOKEN_STORE=1`; release builds always use Keychain.

use crate::domain::types::AppError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    error::Error as StdError,
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
    time::Duration,
};
use tokio::sync::{mpsc, Mutex as AsyncMutex};
#[cfg(debug_assertions)]
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use zeroize::{Zeroize, ZeroizeOnDrop};

const DEFAULT_LOOPBACK_PORT: u16 = 8765;
// Scopes June needs. profile:read for /me, billing:read for /billing/balance,
// billing:write for subscription checkout, and credits:spend so June API can
// authorize-and-charge against the user's credits for transcription /
// generation / dictation work.
const OAUTH_SCOPES: &str = "profile:read billing:read billing:write credits:spend";
// June's OS Accounts token store. Keep this app-scoped so June does not
// touch credentials written by other Open Software apps on startup.
const KEYCHAIN_SERVICE: &str = "co.opensoftware.june.accounts";
const DEV_KEYCHAIN_SERVICE: &str = "co.opensoftware.june-dev.accounts";
const KEYCHAIN_USER: &str = "tokens";
const LOCAL_DEV_ENV: &str = "OS_JUNE_LOCAL_DEV";
const LOCAL_DEV_BEARER_TOKEN_ENV: &str = "OS_JUNE_LOCAL_DEV_BEARER_TOKEN";
const LOCAL_DEV_USER_ID_ENV: &str = "OS_JUNE_LOCAL_DEV_USER_ID";
const DEFAULT_LOCAL_DEV_BEARER_TOKEN: &str = "local-dev-token";
const DEFAULT_LOCAL_DEV_USER_ID: &str = "usr_local_dev";
#[cfg(debug_assertions)]
const DEV_PLAINTEXT_TOKEN_STORE_ENV: &str = "OS_JUNE_DEV_PLAINTEXT_TOKEN_STORE";
#[cfg(debug_assertions)]
const DEV_PLAINTEXT_TOKEN_FILE: &str = "dev-os-accounts-tokens.json";
const USE_PROD_ACCOUNTS_TOKENS_ENV: &str = "OS_JUNE_USE_PROD_ACCOUNTS_TOKENS";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
#[cfg(debug_assertions)]
const SOCKET_READ_TIMEOUT: Duration = Duration::from_secs(5);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const ERR_TOKEN_EXPIRED: i64 = 3001;

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static REFRESH_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
static ENV_LOADED: OnceLock<()> = OnceLock::new();
static SIGNED_IN_CACHE: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
struct Envelope<T> {
    data: Option<T>,
    success: bool,
    error_code: Option<i64>,
    message: Option<String>,
}

/// Token pair. Stored in the OS keychain by default, **never** handed to the webview.
/// Zeroizes memory on drop so a refresh-rotated token doesn't linger.
#[derive(Serialize, Deserialize, Clone, Zeroize, ZeroizeOnDrop)]
struct TokenPair {
    access_token: String,
    refresh_token: String,
}

#[derive(Deserialize)]
struct MeWire {
    id: String,
    handle: String,
    email: Option<String>,
    display_name: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct BalanceWire {
    credits: i64,
    usd_millis: i64,
    #[serde(default)]
    usage_remaining_percent: Option<i64>,
    /// Per-plan usage limits (os-accounts ADR-0022). Absent on accounts APIs
    /// that predate them and when every window is uncapped.
    #[serde(default)]
    usage_limits: Option<UsageLimitsWire>,
}

#[derive(Deserialize)]
struct UsageLimitsWire {
    plan: String,
    daily: Option<UsageWindowWire>,
    weekly: Option<UsageWindowWire>,
    monthly: Option<UsageWindowWire>,
}

#[derive(Deserialize)]
struct UsageWindowWire {
    limit_credits: i64,
    used_credits: i64,
    remaining_percent: i64,
    /// RFC 3339; passed through as a string like the subscription dates.
    resets_at: String,
}

#[derive(Deserialize)]
struct CheckoutSessionWire {
    url: String,
}

#[derive(Deserialize)]
struct SubscriptionWire {
    subscribed: bool,
    status: Option<String>,
    /// Plan slug ("pro", "max"). Absent on accounts APIs that predate plan
    /// tiers and on legacy subscription rows.
    plan: Option<String>,
    plan_credits: Option<i64>,
    trial_end: Option<String>,
    current_period_end: Option<String>,
    /// Trial length from the Stripe price config, available pre-subscription.
    /// Absent on accounts APIs that don't expose it yet; the UI falls back to
    /// a pinned default.
    trial_period_days: Option<u32>,
}

#[derive(Deserialize)]
struct ReferralSummaryWire {
    code: String,
    url: String,
    referred_count: i64,
    pending_count: i64,
    qualified_count: i64,
    earned_months: i64,
    applied_months: i64,
    available_months: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReferralSummary {
    pub code: String,
    pub url: String,
    pub referred_count: i64,
    pub pending_count: i64,
    pub qualified_count: i64,
    pub earned_months: i64,
    pub applied_months: i64,
    pub available_months: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountUser {
    pub id: String,
    pub handle: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountBalance {
    pub credits: i64,
    pub usd_millis: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_remaining_percent: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_limits: Option<AccountUsageLimits>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageLimits {
    /// "free" for accounts without an active subscription, else the plan
    /// slug ("pro", "max").
    pub plan: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daily: Option<AccountUsageWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weekly: Option<AccountUsageWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monthly: Option<AccountUsageWindow>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageWindow {
    pub limit_credits: i64,
    pub used_credits: i64,
    pub remaining_percent: i64,
    pub resets_at: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountSubscription {
    pub subscribed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_credits: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trial_end: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_period_end: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trial_period_days: Option<u32>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub signed_in: bool,
    pub configured: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub local_dev: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<AccountUser>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance: Option<AccountBalance>,
    /// None when the subscription endpoint is unavailable (older accounts
    /// API) or the fetch failed — distinct from "not subscribed".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription: Option<AccountSubscription>,
    /// The accounts portal origin, where funding and billing live.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portal_url: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountsLogoutRequest {
    #[serde(default)]
    pub clear_browser_session: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl From<MeWire> for AccountUser {
    fn from(w: MeWire) -> Self {
        Self {
            id: w.id,
            handle: w.handle,
            email: w.email,
            display_name: w.display_name,
            avatar_url: w.avatar_url,
        }
    }
}

impl From<ReferralSummaryWire> for ReferralSummary {
    fn from(w: ReferralSummaryWire) -> Self {
        Self {
            code: w.code,
            url: w.url,
            referred_count: w.referred_count,
            pending_count: w.pending_count,
            qualified_count: w.qualified_count,
            earned_months: w.earned_months,
            applied_months: w.applied_months,
            available_months: w.available_months,
        }
    }
}

impl From<BalanceWire> for AccountBalance {
    fn from(w: BalanceWire) -> Self {
        Self {
            credits: w.credits,
            usd_millis: w.usd_millis,
            usage_remaining_percent: w.usage_remaining_percent,
            usage_limits: w.usage_limits.map(Into::into),
        }
    }
}

impl From<UsageLimitsWire> for AccountUsageLimits {
    fn from(w: UsageLimitsWire) -> Self {
        Self {
            plan: w.plan,
            daily: w.daily.map(Into::into),
            weekly: w.weekly.map(Into::into),
            monthly: w.monthly.map(Into::into),
        }
    }
}

impl From<UsageWindowWire> for AccountUsageWindow {
    fn from(w: UsageWindowWire) -> Self {
        Self {
            limit_credits: w.limit_credits,
            used_credits: w.used_credits,
            remaining_percent: w.remaining_percent,
            resets_at: w.resets_at,
        }
    }
}

pub(crate) fn cached_signed_in() -> bool {
    if local_dev_enabled() {
        return true;
    }
    SIGNED_IN_CACHE.load(Ordering::Relaxed)
}

fn set_cached_signed_in(signed_in: bool) {
    SIGNED_IN_CACHE.store(signed_in, Ordering::Relaxed);
}

struct Config {
    accounts_url: String,
    api_url: String,
    client_id: String,
    loopback_port: u16,
}

impl Config {
    fn load() -> Self {
        load_local_env();
        Self {
            accounts_url: env_or_build_trimmed("OS_ACCOUNTS_URL", option_env!("OS_ACCOUNTS_URL")),
            api_url: env_or_build_trimmed(
                "OS_ACCOUNTS_API_URL",
                option_env!("OS_ACCOUNTS_API_URL"),
            ),
            client_id: env_or_build_trimmed(
                "OS_ACCOUNTS_CLIENT_ID",
                option_env!("OS_ACCOUNTS_CLIENT_ID"),
            ),
            loopback_port: std::env::var("OS_ACCOUNTS_LOOPBACK_PORT")
                .ok()
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(DEFAULT_LOOPBACK_PORT),
        }
    }

    fn configured(&self) -> bool {
        !self.accounts_url.is_empty() && !self.api_url.is_empty() && !self.client_id.is_empty()
    }

    /// Where OS Accounts redirects after the user signs in. Dev builds use a
    /// loopback HTTP listener (works in `pnpm tauri:dev`, no installed bundle
    /// required). Release builds use the `osjune://` custom URI scheme,
    /// registered by `tauri-plugin-deep-link` against the signed `.app`
    /// bundle — no temp HTTP listener, no macOS firewall prompt, cleaner UX.
    fn redirect_uri(&self) -> String {
        #[cfg(debug_assertions)]
        {
            format!("http://127.0.0.1:{}/callback", self.loopback_port)
        }
        #[cfg(not(debug_assertions))]
        {
            let _ = self.loopback_port; // suppress dead_code lint in release builds
            "osjune://auth/callback".to_string()
        }
    }
}

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

fn env_truthy(key: &str) -> bool {
    matches!(
        env_trimmed(key).to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

pub(crate) fn local_dev_enabled() -> bool {
    load_local_env();
    env_truthy(LOCAL_DEV_ENV)
}

fn local_dev_bearer_token() -> String {
    load_local_env();
    let token = env_trimmed(LOCAL_DEV_BEARER_TOKEN_ENV);
    if token.is_empty() {
        DEFAULT_LOCAL_DEV_BEARER_TOKEN.to_string()
    } else {
        token
    }
}

fn local_dev_user_id() -> String {
    load_local_env();
    normalize_local_dev_user_id(&env_trimmed(LOCAL_DEV_USER_ID_ENV))
}

fn normalize_local_dev_user_id(value: &str) -> String {
    let user_id = value.trim();
    if user_id.starts_with("usr_") {
        user_id.to_string()
    } else {
        DEFAULT_LOCAL_DEV_USER_ID.to_string()
    }
}

/// Representative free-plan usage windows so the local-dev build exercises
/// the usage limit UI without a live accounts API.
fn local_dev_usage_limits() -> AccountUsageLimits {
    let now = chrono::Utc::now();
    let tomorrow = (now.date_naive() + chrono::Days::new(1))
        .and_time(chrono::NaiveTime::MIN)
        .and_utc();
    AccountUsageLimits {
        plan: "free".to_string(),
        daily: Some(AccountUsageWindow {
            limit_credits: 400,
            used_credits: 120,
            remaining_percent: 70,
            resets_at: tomorrow.to_rfc3339(),
        }),
        weekly: Some(AccountUsageWindow {
            limit_credits: 1_000,
            used_credits: 320,
            remaining_percent: 68,
            resets_at: tomorrow.to_rfc3339(),
        }),
        monthly: Some(AccountUsageWindow {
            limit_credits: 2_000,
            used_credits: 480,
            remaining_percent: 76,
            resets_at: tomorrow.to_rfc3339(),
        }),
    }
}

fn local_dev_account_status() -> AccountStatus {
    AccountStatus {
        signed_in: true,
        configured: true,
        local_dev: true,
        user: Some(AccountUser {
            id: local_dev_user_id(),
            handle: "local-dev".to_string(),
            email: None,
            display_name: Some("Local developer".to_string()),
            avatar_url: None,
        }),
        balance: Some(AccountBalance {
            credits: 0,
            usd_millis: 0,
            usage_remaining_percent: Some(100),
            usage_limits: Some(local_dev_usage_limits()),
        }),
        subscription: Some(AccountSubscription {
            subscribed: true,
            status: Some("active".to_string()),
            plan: None,
            plan_credits: Some(0),
            trial_end: None,
            current_period_end: None,
            trial_period_days: None,
        }),
        portal_url: None,
    }
}

pub fn load_local_env() {
    ENV_LOADED.get_or_init(|| {
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(current_dir) = std::env::current_dir() {
            candidates.push(current_dir.join(".env"));
            if let Some(parent) = current_dir.parent() {
                candidates.push(parent.join(".env"));
            }
        }
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        candidates.push(manifest_dir.join(".env"));
        if let Some(parent) = manifest_dir.parent() {
            candidates.push(parent.join(".env"));
        }
        for candidate in candidates {
            if candidate.exists() {
                let _ = dotenvy::from_path(&candidate);
                break;
            }
        }
    });
}

/// Two slots, both populated only while a login is in flight:
/// - `cancel`: drained by `os_accounts_cancel_login` to abort the wait.
/// - `callback`: receives every auth deep-link callback while the release
///   login flow validates `state`; dev uses a loopback listener instead.
#[derive(Default)]
pub struct LoginFlow {
    cancel: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    callback: std::sync::Mutex<Option<mpsc::UnboundedSender<String>>>,
}

#[tauri::command]
pub async fn os_accounts_status() -> Result<AccountStatus, AppError> {
    if local_dev_enabled() {
        set_cached_signed_in(true);
        return Ok(local_dev_account_status());
    }
    let cfg = Config::load();
    if load_tokens().await.is_none() {
        set_cached_signed_in(false);
        return Ok(AccountStatus {
            configured: cfg.configured(),
            ..Default::default()
        });
    }
    match fetch_snapshot(&cfg).await {
        Ok((user, balance, subscription)) => {
            set_cached_signed_in(true);
            Ok(AccountStatus {
                signed_in: true,
                configured: cfg.configured(),
                local_dev: false,
                user: Some(user),
                balance: Some(balance),
                subscription,
                portal_url: portal_url(&cfg),
            })
        }
        Err(_) => {
            set_cached_signed_in(false);
            Ok(AccountStatus {
                configured: cfg.configured(),
                ..Default::default()
            })
        }
    }
}

#[tauri::command]
pub async fn os_accounts_login(
    flow: tauri::State<'_, LoginFlow>,
) -> Result<AccountStatus, AppError> {
    if local_dev_enabled() {
        set_cached_signed_in(true);
        return Ok(local_dev_account_status());
    }
    let cfg = Config::load();
    if !cfg.configured() {
        let mut missing: Vec<&str> = Vec::new();
        if cfg.accounts_url.is_empty() {
            missing.push("OS_ACCOUNTS_URL");
        }
        if cfg.api_url.is_empty() {
            missing.push("OS_ACCOUNTS_API_URL");
        }
        if cfg.client_id.is_empty() {
            missing.push("OS_ACCOUNTS_CLIENT_ID");
        }
        return Err(AppError::new(
            "os_accounts_unconfigured",
            format!(
                "OS Accounts is not configured. Missing env vars: {}.",
                missing.join(", ")
            ),
        ));
    }

    let (verifier, challenge) = pkce();
    let csrf = random_b64url(24);
    let redirect_uri = cfg.redirect_uri();

    let login_url = format!(
        "{}/login?client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        cfg.accounts_url.trim_end_matches('/'),
        urlencoding::encode(&cfg.client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(OAUTH_SCOPES),
        urlencoding::encode(&csrf),
        urlencoding::encode(&challenge),
    );

    let code = await_authorization_code(&cfg, &flow, &login_url, &csrf).await?;
    let pair = exchange_code(&cfg, &code, &verifier, &redirect_uri).await?;
    store_tokens(&pair).await?;
    let (user, balance, subscription) = fetch_snapshot(&cfg).await?;
    set_cached_signed_in(true);
    Ok(AccountStatus {
        signed_in: true,
        configured: true,
        local_dev: false,
        user: Some(user),
        balance: Some(balance),
        subscription,
        portal_url: portal_url(&cfg),
    })
}

#[tauri::command]
pub fn os_accounts_cancel_login(flow: tauri::State<'_, LoginFlow>) -> Result<(), AppError> {
    if let Ok(mut slot) = flow.cancel.lock() {
        if let Some(sender) = slot.take() {
            let _ = sender.send(());
        }
    }
    // Drop any pending callback sender too. In release the cancel branch wins
    // the select; in dev the slot is unused.
    if let Ok(mut slot) = flow.callback.lock() {
        slot.take();
    }
    Ok(())
}

#[tauri::command]
pub async fn os_accounts_logout(request: Option<AccountsLogoutRequest>) -> Result<(), AppError> {
    if local_dev_enabled() {
        set_cached_signed_in(true);
        return Ok(());
    }
    let cfg = Config::load();
    if let Some(pair) = load_tokens().await {
        let _ = http_client()
            .post(format!("{}/auth/logout", cfg.api_url.trim_end_matches('/')))
            .json(&serde_json::json!({ "refresh_token": pair.refresh_token }))
            .send()
            .await;
    }
    clear_tokens().await;
    set_cached_signed_in(false);
    if request
        .map(|request| request.clear_browser_session)
        .unwrap_or(false)
    {
        let _ = open_accounts_browser_logout(&cfg);
    }
    Ok(())
}

fn open_accounts_browser_logout(cfg: &Config) -> Result<(), AppError> {
    let Some(url) = accounts_browser_logout_url(cfg) else {
        return Ok(());
    };
    open_in_browser(&url)
}

fn accounts_browser_logout_url(cfg: &Config) -> Option<String> {
    let accounts_url = cfg.accounts_url.trim().trim_end_matches('/');
    if accounts_url.is_empty() {
        return None;
    }
    Some(format!("{accounts_url}/login?signed-out=1"))
}

#[tauri::command]
pub async fn os_accounts_upgrade(plan: Option<String>) -> Result<(), AppError> {
    if local_dev_enabled() {
        return Ok(());
    }
    let cfg = Config::load();
    if !cfg.configured() {
        return Err(AppError::new(
            "os_accounts_unconfigured",
            "OS Accounts is not configured for this build.",
        ));
    }
    let session: CheckoutSessionWire = authed_post(
        &cfg,
        "/billing/subscription",
        subscription_checkout_request(plan.as_deref()),
    )
    .await?;
    let url = session.url.trim();
    if url.is_empty() {
        return Err(AppError::new(
            "empty_response",
            "OS Accounts returned no checkout URL.",
        ));
    }
    open_in_browser(url)
}

/// Omitting `plan` keeps the accounts-API default (Pro), so June stays
/// compatible with deployments that predate plan tiers.
fn subscription_checkout_request(plan: Option<&str>) -> serde_json::Value {
    let plan = plan.map(str::trim).filter(|plan| !plan.is_empty());
    match plan {
        Some(plan) => serde_json::json!({
            "allow_promotion_codes": true,
            "plan": plan,
        }),
        None => serde_json::json!({
            "allow_promotion_codes": true,
        }),
    }
}

/// Opens the accounts portal in the default browser. The webview swallows
/// `target="_blank"` anchors, so any in-app "go to the portal" affordance
/// (funding, billing, referrals) must route through this command.
#[tauri::command]
pub fn os_accounts_open_portal() -> Result<(), AppError> {
    if local_dev_enabled() {
        return Ok(());
    }
    let cfg = Config::load();
    let url = cfg.accounts_url.trim_end_matches('/');
    if url.is_empty() {
        return Err(AppError::new(
            "os_accounts_unconfigured",
            "OS Accounts is not configured for this build.",
        ));
    }
    open_in_browser(url)
}

#[tauri::command]
pub async fn os_accounts_referral_summary() -> Result<ReferralSummary, AppError> {
    if local_dev_enabled() {
        return Err(AppError::new(
            "referrals_unavailable",
            "Referral links are not available in local development mode.",
        ));
    }
    let cfg = Config::load();
    if !cfg.configured() {
        return Err(AppError::new(
            "os_accounts_unconfigured",
            "OS Accounts is not configured for this build.",
        ));
    }
    let summary: ReferralSummaryWire = authed_get(&cfg, "/referrals/me").await?;
    Ok(summary.into())
}

/// Register the deep-link handler at app setup. Forwards every exact
/// `osjune://auth/callback?...` URL to any in-flight login so the login
/// flow can validate `state` before accepting it. Works in both cold-launch
/// (OS starts the app with the URL) and warm-launch (app already running, OS
/// hands the URL to the existing instance via tauri-plugin-single-instance's
/// deep-link feature).
///
/// Safe to call in dev too; the loopback flow doesn't use the callback
/// slot, so the handler just never fires there.
pub fn setup_deep_link(app: &tauri::App) {
    use tauri::Manager;
    use tauri_plugin_deep_link::DeepLinkExt;

    let app_handle = app.app_handle().clone();
    app.deep_link().on_open_url(move |event| {
        let Some(url) = event.urls().first().cloned() else {
            return;
        };
        if url.scheme() != "osjune" {
            return;
        }
        // Match on the parsed URL components — `starts_with` would also
        // accept `osjune://auth/callback-extra?...` and similar, letting
        // an unrelated webpage drain the one-shot. CSRF would still reject
        // downstream, but tightening the gate here keeps the in-flight
        // login intact when a stray URL fires the handler.
        if url.host_str() != Some("auth") || url.path() != "/callback" {
            return;
        }
        let url_str = url.to_string();
        let Some(flow) = app_handle.try_state::<LoginFlow>() else {
            return;
        };
        // Clone the sender instead of draining it. A stray webpage can open a
        // custom-scheme callback with the wrong OAuth state; the login flow
        // ignores that URL and keeps waiting for the real provider callback.
        let tx = flow
            .callback
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().cloned());
        if let Some(tx) = tx {
            let _ = tx.send(url_str);
        }
    });
}

/// Dispatch to the loopback (dev) or deep-link (release) variant. Opens
/// the browser, installs a cancel sender on the LoginFlow, waits for the
/// callback or timeout, drains the slot before returning.
async fn await_authorization_code(
    cfg: &Config,
    flow: &tauri::State<'_, LoginFlow>,
    login_url: &str,
    csrf: &str,
) -> Result<String, AppError> {
    #[cfg(debug_assertions)]
    {
        let listener = TcpListener::bind(("127.0.0.1", cfg.loopback_port))
            .await
            .map_err(|e| {
                AppError::new(
                    "loopback_bind_failed",
                    format!(
                        "Could not start the local login listener on port {}: {e}",
                        cfg.loopback_port
                    ),
                )
            })?;
        open_in_browser(login_url)?;

        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
        if let Ok(mut slot) = flow.cancel.lock() {
            *slot = Some(cancel_tx);
        }
        let outcome = tokio::select! {
            result = tokio::time::timeout(LOGIN_TIMEOUT, await_callback(&listener, csrf)) => {
                result.unwrap_or_else(|_| {
                    Err(AppError::new("login_timed_out", "Login timed out. Please try again."))
                })
            }
            _ = cancel_rx => Err(AppError::new("login_canceled", "Sign-in canceled.")),
        };
        if let Ok(mut slot) = flow.cancel.lock() {
            *slot = None;
        }
        outcome
    }

    #[cfg(not(debug_assertions))]
    {
        let _ = cfg.loopback_port; // unused in release; keep the borrow shape
        let (callback_tx, mut callback_rx) = mpsc::unbounded_channel::<String>();
        if let Ok(mut slot) = flow.callback.lock() {
            *slot = Some(callback_tx);
        }
        // Drain the slot if the browser open fails — otherwise we return
        // Err leaving a sender behind whose receiver was already dropped.
        // The next login attempt would overwrite it harmlessly, but the
        // intermediate state is inconsistent.
        if let Err(e) = open_in_browser(login_url) {
            if let Ok(mut slot) = flow.callback.lock() {
                slot.take();
            }
            return Err(e);
        }

        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
        if let Ok(mut slot) = flow.cancel.lock() {
            *slot = Some(cancel_tx);
        }

        let outcome = tokio::select! {
            result = tokio::time::timeout(
                LOGIN_TIMEOUT,
                await_valid_callback_url(&mut callback_rx, csrf),
            ) => {
                match result {
                    Ok(result) => result,
                    Err(_) => Err(AppError::new(
                        "login_timed_out",
                        "Login timed out. Please try again.",
                    )),
                }
            }
            _ = cancel_rx => Err(AppError::new("login_canceled", "Sign-in canceled.")),
        };
        if let Ok(mut slot) = flow.cancel.lock() {
            *slot = None;
        }
        if let Ok(mut slot) = flow.callback.lock() {
            slot.take();
        }
        outcome
    }
}

// Branded loopback success page. Self-contained (the loopback origin can't
// reach the app's bundled fonts/assets), but mirrors the OS Accounts / June
// look: warm-grey surface, inset card, OS mark, calm hierarchy — and follows
// the system light/dark preference.
#[cfg(debug_assertions)]
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
    <span class=check><svg viewBox="0 0 14 14" fill=none stroke=currentColor stroke-width=1.8 stroke-linecap=round stroke-linejoin=round><path d="M3 7.5 6 10l5-6"/></svg>Signed in</span>
    <h1 class=title>Signed in to June</h1>
    <p class=sub>You can close this tab and return to the app.</p>
  </main>
</body>
</html>"##;

/// Accept connections until one hits `/callback`. Every per-socket read is
/// bounded so a slow-loris client on the loopback port can't stall the
/// listener for the full LOGIN_TIMEOUT.
#[cfg(debug_assertions)]
async fn await_callback(listener: &TcpListener, expected_state: &str) -> Result<String, AppError> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| AppError::new("loopback_accept_failed", e.to_string()))?;

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

        match validate_callback_code(path, expected_state) {
            CallbackCode::Ignore => {
                write_http(&mut stream, "400 Bad Request", "Invalid login callback").await;
                continue;
            }
            CallbackCode::MissingCode => {
                write_http(&mut stream, "400 Bad Request", "Missing authorization code").await;
                return Err(missing_code_error());
            }
            CallbackCode::Code(code) => {
                write_http(&mut stream, "200 OK", SUCCESS_BODY).await;
                return Ok(code);
            }
        }
    }
}

#[cfg(debug_assertions)]
fn is_loopback_callback_path(path: &str) -> bool {
    path.split_once('?').map_or(path, |(path, _query)| path) == "/callback"
}

#[cfg(debug_assertions)]
async fn write_http(stream: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
}

fn parse_callback_query(path: &str) -> (Option<String>, Option<String>) {
    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut code = None;
    let mut state = None;
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
            _ => {}
        }
    }
    (code, state)
}

enum CallbackCode {
    Ignore,
    MissingCode,
    Code(String),
}

fn validate_callback_code(path: &str, expected_state: &str) -> CallbackCode {
    let (code, state) = parse_callback_query(path);
    if state.as_deref() != Some(expected_state) {
        return CallbackCode::Ignore;
    }
    code.map_or(CallbackCode::MissingCode, CallbackCode::Code)
}

#[cfg(any(not(debug_assertions), test))]
async fn await_valid_callback_url(
    callback_rx: &mut mpsc::UnboundedReceiver<String>,
    expected_state: &str,
) -> Result<String, AppError> {
    while let Some(url) = callback_rx.recv().await {
        match validate_callback_code(&url, expected_state) {
            CallbackCode::Ignore => continue,
            CallbackCode::MissingCode => return Err(missing_code_error()),
            CallbackCode::Code(code) => return Ok(code),
        }
    }
    Err(AppError::new("login_canceled", "Sign-in canceled."))
}

fn missing_code_error() -> AppError {
    AppError::new(
        "missing_code",
        "Login response was missing an authorization code.",
    )
}

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(HTTP_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .user_agent("os-june/0.1")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn refresh_lock() -> &'static AsyncMutex<()> {
    REFRESH_LOCK.get_or_init(|| AsyncMutex::new(()))
}

async fn exchange_code(
    cfg: &Config,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<TokenPair, AppError> {
    let resp: Envelope<TokenPair> = http_client()
        .post(format!("{}/auth/token", cfg.api_url.trim_end_matches('/')))
        .json(&serde_json::json!({
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": redirect_uri,
        }))
        .send()
        .await
        .map_err(net_error)?
        .json()
        .await
        .map_err(net_error)?;
    resp.data
        .filter(|_| resp.success)
        .ok_or_else(|| AppError::new("token_exchange_failed", "Could not complete sign-in."))
}

/// Refresh tokens ROTATE. The lock serialises concurrent callers so two
/// parallel 401s don't both burn the same refresh token (and force-log-out the
/// user). Inside the lock we re-check the keychain in case another caller
/// already refreshed.
async fn refresh_locked(cfg: &Config) -> Result<String, AppError> {
    let _guard = refresh_lock().lock().await;
    let pair = match load_tokens().await {
        Some(pair) => pair,
        None => {
            set_cached_signed_in(false);
            return Err(AppError::new("signed_out", "Not signed in."));
        }
    };
    let resp: Envelope<TokenPair> = http_client()
        .post(format!(
            "{}/auth/refresh",
            cfg.api_url.trim_end_matches('/')
        ))
        .json(&serde_json::json!({ "refresh_token": pair.refresh_token }))
        .send()
        .await
        .map_err(net_error)?
        .json()
        .await
        .map_err(net_error)?;
    let fresh = resp
        .data
        .filter(|_| resp.success)
        .ok_or_else(|| AppError::new("session_expired", "Your session expired. Sign in again."))?;
    let access = fresh.access_token.clone();
    store_tokens(&fresh).await?;
    set_cached_signed_in(true);
    Ok(access)
}

/// Read the current access token without refreshing.
pub async fn access_token() -> Result<String, AppError> {
    if local_dev_enabled() {
        set_cached_signed_in(true);
        return Ok(local_dev_bearer_token());
    }
    let pair = match load_tokens().await {
        Some(pair) => pair,
        None => {
            set_cached_signed_in(false);
            return Err(AppError::new("signed_out", "Not signed in."));
        }
    };
    // Pre-emptively refresh if the cached token is expired or within 30s of
    // expiry. Otherwise multipart uploads (which can't replay their body on a
    // 401) would burn a request before discovering the token was stale.
    if access_token_is_stale(&pair.access_token) {
        let cfg = Config::load();
        return match refresh_locked(&cfg).await {
            Ok(access) => Ok(access),
            Err(error) => {
                set_cached_signed_in(false);
                Err(error)
            }
        };
    }
    set_cached_signed_in(true);
    Ok(pair.access_token.clone())
}

const ACCESS_TOKEN_REFRESH_SKEW_SECS: i64 = 30;

fn access_token_is_stale(jwt: &str) -> bool {
    let Some(payload) = jwt.split('.').nth(1) else {
        return false;
    };
    use base64::Engine as _;
    let Ok(decoded) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload) else {
        return false;
    };
    let Ok(claims) = serde_json::from_slice::<serde_json::Value>(&decoded) else {
        return false;
    };
    let Some(exp) = claims.get("exp").and_then(serde_json::Value::as_i64) else {
        return false;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    exp <= now + ACCESS_TOKEN_REFRESH_SKEW_SECS
}

/// Force a token refresh and return the new access token.
pub async fn refresh_access_token() -> Result<String, AppError> {
    if local_dev_enabled() {
        set_cached_signed_in(true);
        return Ok(local_dev_bearer_token());
    }
    let cfg = Config::load();
    match refresh_locked(&cfg).await {
        Ok(access) => Ok(access),
        Err(error) => {
            set_cached_signed_in(false);
            Err(error)
        }
    }
}

async fn authed_get<T: for<'de> Deserialize<'de>>(cfg: &Config, path: &str) -> Result<T, AppError> {
    let url = format!("{}{}", cfg.api_url.trim_end_matches('/'), path);
    let mut access = access_token().await?;
    for attempt in 0..2 {
        let response = http_client()
            .get(&url)
            .bearer_auth(&access)
            .send()
            .await
            .map_err(net_error)?;
        let status = response.status();
        let body = response.text().await.map_err(net_error)?;
        if body.trim().is_empty() {
            return Err(empty_accounts_response(path, status));
        }
        let resp: Envelope<T> = serde_json::from_str(&body)
            .map_err(|error| decode_accounts_response_error(path, error))?;
        if resp.success {
            return resp
                .data
                .ok_or_else(|| AppError::new("empty_response", "OS Accounts returned no data."));
        }
        if resp.error_code == Some(ERR_TOKEN_EXPIRED) && attempt == 0 {
            access = refresh_locked(cfg).await?;
            continue;
        }
        return Err(AppError::new(
            "request_failed",
            accounts_request_failed_message(resp.message),
        ));
    }
    Err(AppError::new("unauthorized", "Not signed in."))
}

async fn authed_post<T: for<'de> Deserialize<'de>>(
    cfg: &Config,
    path: &str,
    body: serde_json::Value,
) -> Result<T, AppError> {
    let url = format!("{}{}", cfg.api_url.trim_end_matches('/'), path);
    let mut access = access_token().await?;
    for attempt in 0..2 {
        let response = http_client()
            .post(&url)
            .bearer_auth(&access)
            .json(&body)
            .send()
            .await
            .map_err(net_error)?;
        let status = response.status();
        let body = response.text().await.map_err(net_error)?;
        if body.trim().is_empty() {
            return Err(empty_accounts_response(path, status));
        }
        let resp: Envelope<T> = serde_json::from_str(&body)
            .map_err(|error| decode_accounts_response_error(path, error))?;
        if resp.success {
            return resp
                .data
                .ok_or_else(|| AppError::new("empty_response", "OS Accounts returned no data."));
        }
        if resp.error_code == Some(ERR_TOKEN_EXPIRED) && attempt == 0 {
            access = refresh_locked(cfg).await?;
            continue;
        }
        return Err(AppError::new(
            "request_failed",
            accounts_request_failed_message(resp.message),
        ));
    }
    Err(AppError::new("unauthorized", "Not signed in."))
}

fn accounts_request_failed_message(message: Option<String>) -> String {
    match message.as_deref() {
        Some("access token is missing required scope") => {
            "Sign in again to refresh your billing permissions.".to_string()
        }
        Some(message) => message.to_string(),
        None => "OS Accounts request failed.".to_string(),
    }
}

fn empty_accounts_response(path: &str, status: reqwest::StatusCode) -> AppError {
    if path.starts_with("/referrals/") && status == reqwest::StatusCode::NOT_FOUND {
        return AppError::new(
            "referrals_unavailable",
            "Referral links are not available on this OS Accounts deployment yet.",
        );
    }
    AppError::new(
        "empty_response",
        format!("OS Accounts returned an empty response for {path} ({status})."),
    )
}

fn decode_accounts_response_error(path: &str, error: serde_json::Error) -> AppError {
    if path.starts_with("/referrals/") {
        return AppError::new(
            "referrals_unavailable",
            "Referral links are not available on this OS Accounts deployment yet.",
        );
    }
    AppError::new(
        "network_error",
        format!("OS Accounts returned an invalid response for {path}: {error}"),
    )
}

async fn fetch_snapshot(
    cfg: &Config,
) -> Result<(AccountUser, AccountBalance, Option<AccountSubscription>), AppError> {
    let me: MeWire = authed_get(cfg, "/me").await?;
    let balance: BalanceWire = authed_get(cfg, "/billing/balance").await?;
    // Best-effort: an accounts API without the subscription endpoint must not
    // break sign-in. None means "unknown", not "not subscribed".
    let subscription = authed_get::<SubscriptionWire>(cfg, "/billing/subscription")
        .await
        .ok()
        .map(|w| AccountSubscription {
            subscribed: w.subscribed,
            status: w.status,
            plan: w.plan,
            plan_credits: w.plan_credits,
            trial_end: w.trial_end,
            current_period_end: w.current_period_end,
            trial_period_days: w.trial_period_days,
        });
    Ok((me.into(), balance.into(), subscription))
}

fn portal_url(cfg: &Config) -> Option<String> {
    let url = cfg.accounts_url.trim_end_matches('/');
    (!url.is_empty()).then(|| url.to_string())
}

fn net_error(e: reqwest::Error) -> AppError {
    let mut message = e.to_string();
    let mut source = e.source();
    while let Some(error) = source {
        message.push_str(": ");
        message.push_str(&error.to_string());
        source = error.source();
    }
    AppError::new("network_error", message)
}

async fn store_tokens(pair: &TokenPair) -> Result<(), AppError> {
    let json = serde_json::to_string(pair)
        .map_err(|e| AppError::new("token_serialize_failed", e.to_string()))?;
    #[cfg(debug_assertions)]
    if use_dev_plaintext_token_store() {
        return store_dev_plaintext_tokens(json).await;
    }
    store_platform_tokens(json).await
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn store_platform_tokens(json: String) -> Result<(), AppError> {
    let service = keychain_service().to_string();
    tokio::task::spawn_blocking(move || {
        keyring::Entry::new(&service, KEYCHAIN_USER).and_then(|entry| entry.set_password(&json))
    })
    .await
    .map_err(|e| AppError::new("keychain_write_failed", e.to_string()))?
    .map_err(|e| AppError::new("keychain_write_failed", e.to_string()))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn store_platform_tokens(_json: String) -> Result<(), AppError> {
    Err(AppError::new(
        "secure_token_storage_unavailable",
        "Secure token storage is only available on macOS and Windows.",
    ))
}

async fn load_tokens() -> Option<TokenPair> {
    #[cfg(debug_assertions)]
    if use_dev_plaintext_token_store() {
        return load_dev_plaintext_tokens().await;
    }
    load_platform_tokens().await
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn load_platform_tokens() -> Option<TokenPair> {
    let service = keychain_service().to_string();
    let raw = tokio::task::spawn_blocking(move || {
        keyring::Entry::new(&service, KEYCHAIN_USER)
            .ok()
            .and_then(|entry| entry.get_password().ok())
    })
    .await
    .ok()??;
    serde_json::from_str(&raw).ok()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn load_platform_tokens() -> Option<TokenPair> {
    None
}

async fn clear_tokens() {
    #[cfg(debug_assertions)]
    if use_dev_plaintext_token_store() {
        let _ = tokio::task::spawn_blocking(|| {
            let _ = std::fs::remove_file(dev_plaintext_token_path());
        })
        .await;
        return;
    }
    clear_platform_tokens().await;
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn clear_platform_tokens() {
    let service = keychain_service().to_string();
    let _ = tokio::task::spawn_blocking(move || {
        if let Ok(entry) = keyring::Entry::new(&service, KEYCHAIN_USER) {
            let _ = entry.delete_credential();
        }
    })
    .await;
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn clear_platform_tokens() {}

fn keychain_service() -> &'static str {
    keychain_service_for_build(cfg!(debug_assertions), use_prod_accounts_tokens())
}

fn keychain_service_for_build(debug_assertions: bool, use_prod: bool) -> &'static str {
    if debug_assertions && !use_prod {
        DEV_KEYCHAIN_SERVICE
    } else {
        KEYCHAIN_SERVICE
    }
}

fn use_prod_accounts_tokens() -> bool {
    load_local_env();
    cfg!(debug_assertions) && env_truthy(USE_PROD_ACCOUNTS_TOKENS_ENV)
}

#[cfg(debug_assertions)]
fn use_dev_plaintext_token_store() -> bool {
    load_local_env();
    std::env::var(DEV_PLAINTEXT_TOKEN_STORE_ENV)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

#[cfg(debug_assertions)]
fn dev_plaintext_token_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(DEV_PLAINTEXT_TOKEN_FILE)
}

#[cfg(debug_assertions)]
async fn store_dev_plaintext_tokens(json: String) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let path = dev_plaintext_token_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::PermissionsExt;

            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&path)?;
            file.write_all(json.as_bytes())?;
            let mut permissions = file.metadata()?.permissions();
            permissions.set_mode(0o600);
            std::fs::set_permissions(&path, permissions)?;
            Ok::<(), std::io::Error>(())
        }
        #[cfg(not(unix))]
        {
            std::fs::write(&path, json)
        }
    })
    .await
    .map_err(|e| AppError::new("dev_token_store_write_failed", e.to_string()))?
    .map_err(|e| AppError::new("dev_token_store_write_failed", e.to_string()))
}

#[cfg(debug_assertions)]
async fn load_dev_plaintext_tokens() -> Option<TokenPair> {
    let raw = tokio::task::spawn_blocking(|| std::fs::read_to_string(dev_plaintext_token_path()))
        .await
        .ok()?
        .ok()?;
    serde_json::from_str(&raw).ok()
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

pub(crate) fn open_in_browser(url: &str) -> Result<(), AppError> {
    let mut command = browser_open_command(url);
    let mut child = command
        .spawn()
        .map_err(|e| AppError::new("browser_open_failed", e.to_string()))?;
    // Reap the short-lived `open` process off-thread so it doesn't linger as
    // a zombie until the app exits.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn browser_open_command(url: &str) -> std::process::Command {
    let mut command = std::process::Command::new("open");
    command.arg(url);
    command
}

#[cfg(target_os = "windows")]
fn browser_open_command(url: &str) -> std::process::Command {
    let mut command = std::process::Command::new("explorer.exe");
    command.arg(url);
    command
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn browser_open_command(url: &str) -> std::process::Command {
    let mut command = std::process::Command::new("xdg-open");
    command.arg(url);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_validation_ignores_wrong_state() {
        assert!(matches!(
            validate_callback_code("osjune://auth/callback?code=bad&state=wrong", "expected"),
            CallbackCode::Ignore
        ));
    }

    #[test]
    fn callback_validation_accepts_matching_state() {
        assert!(matches!(
            validate_callback_code(
                "osjune://auth/callback?code=good&state=expected",
                "expected"
            ),
            CallbackCode::Code(code) if code == "good"
        ));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn loopback_callback_path_rejects_prefix_matches() {
        assert!(is_loopback_callback_path(
            "/callback?code=good&state=expected"
        ));
        assert!(!is_loopback_callback_path(
            "/callback-extra?code=bad&state=expected"
        ));
    }

    #[tokio::test]
    async fn callback_receiver_waits_through_spoofed_state() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        tx.send("osjune://auth/callback?code=bad&state=wrong".to_string())
            .expect("send spoofed callback");
        tx.send("osjune://auth/callback?code=good&state=expected".to_string())
            .expect("send valid callback");

        let code = await_valid_callback_url(&mut rx, "expected")
            .await
            .expect("valid callback");

        assert_eq!(code, "good");
    }

    #[test]
    fn normalizes_blank_local_dev_user_id_to_default() {
        assert_eq!(
            normalize_local_dev_user_id("   "),
            DEFAULT_LOCAL_DEV_USER_ID.to_string()
        );
    }

    #[test]
    fn normalizes_invalid_local_dev_user_id_to_default() {
        assert_eq!(
            normalize_local_dev_user_id("local-dev"),
            DEFAULT_LOCAL_DEV_USER_ID.to_string()
        );
    }

    #[test]
    fn preserves_valid_local_dev_user_id() {
        assert_eq!(
            normalize_local_dev_user_id("  usr_custom_local  "),
            "usr_custom_local"
        );
    }

    #[test]
    fn release_builds_use_the_production_keychain_service() {
        assert_eq!(keychain_service_for_build(false, false), KEYCHAIN_SERVICE);
    }

    #[test]
    fn debug_builds_use_a_separate_keychain_service_by_default() {
        assert_eq!(
            keychain_service_for_build(true, false),
            DEV_KEYCHAIN_SERVICE
        );
    }

    #[test]
    fn debug_builds_can_opt_into_the_production_keychain_service() {
        assert_eq!(keychain_service_for_build(true, true), KEYCHAIN_SERVICE);
    }

    #[test]
    fn oauth_scope_allows_checkout_and_credit_spend() {
        assert!(OAUTH_SCOPES.contains("billing:write"));
        assert!(OAUTH_SCOPES.contains("credits:spend"));
    }

    #[test]
    fn subscription_checkout_request_allows_promotion_codes() {
        assert_eq!(
            subscription_checkout_request(None),
            serde_json::json!({ "allow_promotion_codes": true })
        );
    }

    #[test]
    fn subscription_checkout_request_carries_the_chosen_plan() {
        assert_eq!(
            subscription_checkout_request(Some("max")),
            serde_json::json!({ "allow_promotion_codes": true, "plan": "max" })
        );
        // Blank input degrades to the accounts-API default instead of sending
        // an empty slug the server would reject.
        assert_eq!(
            subscription_checkout_request(Some("  ")),
            serde_json::json!({ "allow_promotion_codes": true })
        );
    }

    #[test]
    fn browser_logout_url_points_at_signed_out_login() {
        let cfg = Config {
            accounts_url: "https://accounts.opensoftware.co/".to_string(),
            api_url: "https://api.accounts.opensoftware.co".to_string(),
            client_id: "ocl_test".to_string(),
            loopback_port: DEFAULT_LOOPBACK_PORT,
        };

        assert_eq!(
            accounts_browser_logout_url(&cfg).as_deref(),
            Some("https://accounts.opensoftware.co/login?signed-out=1")
        );
    }

    #[test]
    fn browser_logout_url_is_absent_without_accounts_origin() {
        let cfg = Config {
            accounts_url: "   ".to_string(),
            api_url: "https://api.accounts.opensoftware.co".to_string(),
            client_id: "ocl_test".to_string(),
            loopback_port: DEFAULT_LOOPBACK_PORT,
        };

        assert_eq!(accounts_browser_logout_url(&cfg), None);
    }
}
