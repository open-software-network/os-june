//! Identity-only integration with OS Accounts (Login with Open Software).
//!
//! Tokens live in the OS keychain (never the webview). Metering goes through
//! Scribe API, which holds the App API key — never this binary.
//!
//! Debug builds can opt into a plaintext token file for local development via
//! `OS_SCRIBE_DEV_PLAINTEXT_TOKEN_STORE=1`; release builds always use Keychain.

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
use tokio::sync::Mutex as AsyncMutex;
#[cfg(debug_assertions)]
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use zeroize::{Zeroize, ZeroizeOnDrop};

const DEFAULT_LOOPBACK_PORT: u16 = 8765;
// Scopes Scribe needs. profile:read for /me, billing:read for /billing/balance,
// credits:spend so Scribe API can authorize-and-charge against the user's
// wallet for transcription / generation / dictation work.
const OAUTH_SCOPES: &str = "profile:read billing:read credits:spend";
// Scribe's OS Accounts token store. Keep this app-scoped so Scribe does not
// touch credentials written by other Open Software apps on startup.
const KEYCHAIN_SERVICE: &str = "co.opensoftware.scribe.accounts";
const KEYCHAIN_USER: &str = "tokens";
#[cfg(debug_assertions)]
const DEV_PLAINTEXT_TOKEN_STORE_ENV: &str = "OS_SCRIBE_DEV_PLAINTEXT_TOKEN_STORE";
#[cfg(debug_assertions)]
const DEV_PLAINTEXT_TOKEN_FILE: &str = "dev-os-accounts-tokens.json";
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
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub signed_in: bool,
    pub configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<AccountUser>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance: Option<AccountBalance>,
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

impl From<BalanceWire> for AccountBalance {
    fn from(w: BalanceWire) -> Self {
        Self {
            credits: w.credits,
            usd_millis: w.usd_millis,
        }
    }
}

pub(crate) fn cached_signed_in() -> bool {
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
    /// required). Release builds use the `osscribe://` custom URI scheme,
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
            "osscribe://auth/callback".to_string()
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
/// - `callback`: drained by the deep-link `on_open_url` handler (release
///   builds only — dev uses a loopback listener, no slot needed).
#[derive(Default)]
pub struct LoginFlow {
    cancel: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    callback: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<String>>>,
}

#[tauri::command]
pub async fn os_accounts_status() -> Result<AccountStatus, AppError> {
    let cfg = Config::load();
    if load_tokens().await.is_none() {
        set_cached_signed_in(false);
        return Ok(AccountStatus {
            configured: cfg.configured(),
            ..Default::default()
        });
    }
    match fetch_snapshot(&cfg).await {
        Ok((user, balance)) => {
            set_cached_signed_in(true);
            Ok(AccountStatus {
                signed_in: true,
                configured: cfg.configured(),
                user: Some(user),
                balance: Some(balance),
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

    let (user, balance) = fetch_snapshot(&cfg).await?;
    set_cached_signed_in(true);
    Ok(AccountStatus {
        signed_in: true,
        configured: true,
        user: Some(user),
        balance: Some(balance),
    })
}

#[tauri::command]
pub fn os_accounts_cancel_login(flow: tauri::State<'_, LoginFlow>) -> Result<(), AppError> {
    if let Ok(mut slot) = flow.cancel.lock() {
        if let Some(sender) = slot.take() {
            let _ = sender.send(());
        }
    }
    // Dropping any pending callback sender causes the deep-link wait in
    // release builds to resolve with an Err, which the select! arm then
    // surfaces as the cancel error. In dev the slot is unused.
    if let Ok(mut slot) = flow.callback.lock() {
        slot.take();
    }
    Ok(())
}

#[tauri::command]
pub async fn os_accounts_logout() -> Result<(), AppError> {
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
    Ok(())
}

#[tauri::command]
pub fn os_accounts_top_up() -> Result<(), AppError> {
    let cfg = Config::load();
    open_in_browser(cfg.accounts_url.trim_end_matches('/'))
}

/// Register the deep-link handler at app setup. Drains any in-flight
/// login's callback slot when an `osscribe://auth/callback?...` URL
/// arrives — works in both cold-launch (OS starts the app with the URL)
/// and warm-launch (app already running, OS hands the URL to the existing
/// instance via tauri-plugin-single-instance's deep-link feature).
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
        // Match on the parsed URL components — `starts_with` would also
        // accept `osscribe://auth/callback-extra?...` and similar, letting
        // an unrelated webpage drain the one-shot. CSRF would still reject
        // downstream, but tightening the gate here keeps the in-flight
        // login intact when a stray URL fires the handler.
        if url.scheme() != "osscribe" || url.host_str() != Some("auth") || url.path() != "/callback"
        {
            return;
        }
        let url_str = url.to_string();
        let Some(flow) = app_handle.try_state::<LoginFlow>() else {
            return;
        };
        // Extract the sender into an owned `Option` so the MutexGuard is
        // dropped before `flow` falls out of scope at the closure's end —
        // avoids an E0597 drop-order race on the temporary if-let.
        let tx = flow.callback.lock().ok().and_then(|mut slot| slot.take());
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
        let (callback_tx, callback_rx) = tokio::sync::oneshot::channel::<String>();
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
            result = tokio::time::timeout(LOGIN_TIMEOUT, callback_rx) => {
                match result {
                    Ok(Ok(url)) => {
                        let (code, state) = parse_callback_query(&url);
                        if state.as_deref() != Some(csrf) {
                            Err(AppError::new(
                                "state_mismatch",
                                "Login response failed verification. Please try again.",
                            ))
                        } else {
                            code.ok_or_else(|| AppError::new(
                                "missing_code",
                                "Login response was missing an authorization code.",
                            ))
                        }
                    }
                    Ok(Err(_)) => Err(AppError::new("login_canceled", "Sign-in canceled.")),
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
// reach the app's bundled fonts/assets), but mirrors the OS Accounts / Scribe
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

        if !path.starts_with("/callback") {
            write_http(&mut stream, "404 Not Found", "Not found").await;
            continue;
        }

        let (code, state) = parse_callback_query(path);
        write_http(&mut stream, "200 OK", SUCCESS_BODY).await;

        if state.as_deref() != Some(expected_state) {
            return Err(AppError::new(
                "state_mismatch",
                "Login response failed verification. Please try again.",
            ));
        }
        return code.ok_or_else(|| {
            AppError::new(
                "missing_code",
                "Login response was missing an authorization code.",
            )
        });
    }
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

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(HTTP_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .user_agent("os-scribe/0.1")
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
        let resp: Envelope<T> = http_client()
            .get(&url)
            .bearer_auth(&access)
            .send()
            .await
            .map_err(net_error)?
            .json()
            .await
            .map_err(net_error)?;
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
            "OS Accounts request failed.",
        ));
    }
    Err(AppError::new("unauthorized", "Not signed in."))
}

async fn fetch_snapshot(cfg: &Config) -> Result<(AccountUser, AccountBalance), AppError> {
    let me: MeWire = authed_get(cfg, "/me").await?;
    let balance: BalanceWire = authed_get(cfg, "/billing/balance").await?;
    Ok((me.into(), balance.into()))
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
    tokio::task::spawn_blocking(move || {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)
            .and_then(|entry| entry.set_password(&json))
    })
    .await
    .map_err(|e| AppError::new("keychain_write_failed", e.to_string()))?
    .map_err(|e| AppError::new("keychain_write_failed", e.to_string()))
}

async fn load_tokens() -> Option<TokenPair> {
    #[cfg(debug_assertions)]
    if use_dev_plaintext_token_store() {
        return load_dev_plaintext_tokens().await;
    }
    let raw = tokio::task::spawn_blocking(|| {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)
            .ok()
            .and_then(|entry| entry.get_password().ok())
    })
    .await
    .ok()??;
    serde_json::from_str(&raw).ok()
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
    let _ = tokio::task::spawn_blocking(|| {
        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER) {
            let _ = entry.delete_credential();
        }
    })
    .await;
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

fn open_in_browser(url: &str) -> Result<(), AppError> {
    let mut child = std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|e| AppError::new("browser_open_failed", e.to_string()))?;
    // Reap the short-lived `open` process off-thread so it doesn't linger as
    // a zombie until the app exits.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
