//! Google native-app OAuth for private connectors.
//!
//! PKCE (S256) + loopback redirect on an ephemeral 127.0.0.1 port, for BOTH
//! debug and release builds: Google desktop-app clients use the loopback
//! flow, not a custom URI scheme. Google requires the Desktop client's
//! `client_secret` at its token endpoint even though an installed application
//! cannot keep that credential confidential; PKCE remains the protection for
//! an intercepted authorization code. Mirrors the os_accounts.rs login flow
//! mechanics.
//!
//! NEVER log, print, or serialize tokens (or authorization codes) into
//! errors. Error messages carry stable codes and short human text only.

use crate::domain::types::AppError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{sync::OnceLock, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use zeroize::{Zeroize, ZeroizeOnDrop};

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT: &str = "https://openidconnect.googleapis.com/v1/userinfo";
/// How long the whole connect handoff (browser consent + callback) may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(300);
const SOCKET_READ_TIMEOUT: Duration = Duration::from_secs(5);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// Total refresh attempts (1 initial + retries) on transient upstream
/// failures; definitive rejections (invalid_grant) never retry.
pub(crate) const REFRESH_MAX_ATTEMPTS: usize = 3;
pub(crate) const REFRESH_RETRY_BACKOFF: Duration = Duration::from_millis(300);

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub(crate) fn http_client() -> &'static reqwest::Client {
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

/// Cancel slot for an in-flight connect, mirroring `os_accounts::LoginFlow`.
/// Managed as Tauri state; `connectors_cancel_connect` drains it.
#[derive(Default)]
pub struct ConnectFlow {
    cancel: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl ConnectFlow {
    pub fn cancel(&self) {
        if let Ok(mut slot) = self.cancel.lock() {
            if let Some(sender) = slot.take() {
                let _ = sender.send(());
            }
        }
    }
}

/// Token endpoint response. Secret fields zeroize on drop.
#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct GoogleTokenResponse {
    pub access_token: String,
    /// Absent on refresh (unless Google rotates) and on scope escalation for
    /// an already-connected account; callers keep the existing one then.
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[zeroize(skip)]
    pub expires_in: i64,
    /// Space-joined scope set actually granted.
    #[serde(default)]
    #[zeroize(skip)]
    pub scope: Option<String>,
    #[serde(default)]
    pub id_token: Option<String>,
}

/// Outcome of the full browser handoff: granted tokens plus the account
/// email that keys the keychain entry and the DB index row.
pub struct AuthorizedGrant {
    pub tokens: GoogleTokenResponse,
    pub email: String,
}

#[derive(Deserialize)]
struct TokenErrorBody {
    #[serde(default)]
    error: Option<String>,
}

pub enum RefreshOutcome {
    Refreshed(GoogleTokenResponse),
    /// Definitive: the grant was revoked or expired. The account must be
    /// reconnected; retrying cannot help.
    InvalidGrant,
    /// Upstream wobble (5xx, 429, network error): worth a bounded retry.
    Transient,
}

/// Run the full authorization handoff: open the consent screen in the
/// default browser, wait on a loopback listener for the redirect, exchange
/// the code, and resolve the account email.
pub async fn authorize(
    flow: &ConnectFlow,
    client_id: &str,
    client_secret: &str,
    scopes: &[&str],
    login_hint: Option<&str>,
) -> Result<AuthorizedGrant, AppError> {
    let (verifier, challenge) = pkce();
    let csrf = random_b64url(24);

    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| {
        AppError::new(
            "connector_loopback_bind_failed",
            format!("Could not start the local connect listener: {e}"),
        )
    })?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::new("connector_loopback_bind_failed", e.to_string()))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let auth_url = build_auth_url(
        client_id,
        &redirect_uri,
        scopes,
        &challenge,
        &csrf,
        login_hint,
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
                    "connector_connect_timed_out",
                    "Connecting to Google timed out. Please try again.",
                ))
            })
        }
        _ = cancel_rx => Err(AppError::new(
            "connector_connect_canceled",
            "Connecting to Google was canceled.",
        )),
    };
    if let Ok(mut slot) = flow.cancel.lock() {
        *slot = None;
    }
    let code = outcome?;

    let tokens = exchange_code(client_id, client_secret, &code, &verifier, &redirect_uri).await?;
    let email = resolve_email(&tokens).await?;
    Ok(AuthorizedGrant { tokens, email })
}

fn build_auth_url(
    client_id: &str,
    redirect_uri: &str,
    scopes: &[&str],
    code_challenge: &str,
    state: &str,
    login_hint: Option<&str>,
) -> String {
    let mut url = format!(
        "{AUTH_ENDPOINT}?client_id={}&redirect_uri={}&response_type=code&scope={}\
         &code_challenge={}&code_challenge_method=S256&state={}\
         &access_type=offline&prompt=consent&include_granted_scopes=true",
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(&scopes.join(" ")),
        urlencoding::encode(code_challenge),
        urlencoding::encode(state),
    );
    // Incremental scope escalation on an existing account: pre-select the
    // account so the user consents for the right identity.
    if let Some(hint) = login_hint.map(str::trim).filter(|hint| !hint.is_empty()) {
        url.push_str("&login_hint=");
        url.push_str(&urlencoding::encode(hint));
    }
    url
}

// Branded loopback success page. Self-contained (the loopback origin cannot
// reach the app's bundled assets), matching the June look and following the
// system light/dark preference.
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

/// Accept connections until one hits `/callback` with a matching state.
/// Every per-socket read is bounded so a slow client on the loopback port
/// cannot stall the listener for the full connect timeout.
async fn await_callback(listener: &TcpListener, expected_state: &str) -> Result<String, AppError> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| AppError::new("connector_loopback_accept_failed", e.to_string()))?;

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
                    "connector_connect_denied",
                    "Google access was declined.",
                ));
            }
            CallbackOutcome::MissingCode => {
                write_http(&mut stream, "400 Bad Request", "Missing authorization code").await;
                return Err(AppError::new(
                    "connector_missing_code",
                    "Google's response was missing an authorization code.",
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
    /// Wrong or missing state: not our callback, keep waiting.
    Ignore,
    /// The user declined the consent screen (`error=access_denied`).
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

/// Exchange the authorization code for tokens. Google requires the Desktop
/// credential's `client_secret`; PKCE independently proves possession of the
/// authorization request's verifier.
async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<GoogleTokenResponse, AppError> {
    let response = http_client()
        .post(TOKEN_ENDPOINT)
        .form(&authorization_code_form(
            client_id,
            client_secret,
            code,
            verifier,
            redirect_uri,
        ))
        .send()
        .await
        .map_err(|_| exchange_failed(None))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| exchange_failed(None))?;
    if let Ok(tokens) = serde_json::from_str::<GoogleTokenResponse>(&body) {
        if !tokens.access_token.is_empty() {
            return Ok(tokens);
        }
    }
    // Never echo the body: it could carry partial token material. Surface
    // the OAuth error code word only.
    let error_code = serde_json::from_str::<TokenErrorBody>(&body)
        .ok()
        .and_then(|body| body.error);
    tracing::warn!(status, error_code = ?error_code, "google token exchange failed");
    Err(exchange_failed(error_code))
}

fn authorization_code_form<'a>(
    client_id: &'a str,
    client_secret: &'a str,
    code: &'a str,
    verifier: &'a str,
    redirect_uri: &'a str,
) -> [(&'static str, &'a str); 6] {
    [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("code_verifier", verifier),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("redirect_uri", redirect_uri),
    ]
}

fn exchange_failed(error_code: Option<String>) -> AppError {
    let message = match error_code {
        Some(code) => format!("Could not complete the Google connection ({code})."),
        None => "Could not complete the Google connection.".to_string(),
    };
    AppError::new("connector_token_exchange_failed", message)
}

/// One refresh attempt. Classifies invalid_grant (definitive, the account
/// must be reconnected) apart from transient upstream wobble.
pub async fn refresh(client_id: &str, client_secret: &str, refresh_token: &str) -> RefreshOutcome {
    let response = match http_client()
        .post(TOKEN_ENDPOINT)
        .form(&refresh_form(client_id, client_secret, refresh_token))
        .send()
        .await
    {
        Ok(response) => response,
        // No response at all: DNS, connection reset, timeout. Always transient.
        Err(_) => return RefreshOutcome::Transient,
    };
    let status = response.status().as_u16();
    let body = match response.text().await {
        Ok(body) => body,
        Err(_) => return RefreshOutcome::Transient,
    };
    if let Ok(tokens) = serde_json::from_str::<GoogleTokenResponse>(&body) {
        if !tokens.access_token.is_empty() {
            return RefreshOutcome::Refreshed(tokens);
        }
    }
    let error_code = serde_json::from_str::<TokenErrorBody>(&body)
        .ok()
        .and_then(|body| body.error);
    classify_refresh_failure(status, error_code.as_deref())
}

fn refresh_form<'a>(
    client_id: &'a str,
    client_secret: &'a str,
    refresh_token: &'a str,
) -> [(&'static str, &'a str); 4] {
    [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
        ("client_secret", client_secret),
    ]
}

/// `invalid_grant` is the definitive "grant revoked/expired" signal; 5xx and
/// 429 are upstream wobble. Any other parsed OAuth error (e.g.
/// invalid_client) will not heal by retrying either, but is not a revocation:
/// treat it as transient so a config hiccup never flips an account into the
/// reconnect state.
fn classify_refresh_failure(status: u16, error_code: Option<&str>) -> RefreshOutcome {
    // Log status + error code word only; never the body or tokens.
    tracing::warn!(status, error_code = ?error_code, "google token refresh failed");
    match error_code {
        Some("invalid_grant") => RefreshOutcome::InvalidGrant,
        _ => RefreshOutcome::Transient,
    }
}

/// Best-effort revocation of the grant at Google (used by
/// `disconnect(revoke_grant = true)`). Failures are swallowed after logging
/// the HTTP status: local custody removal is the real disconnect.
pub async fn revoke(token: &str) -> bool {
    match http_client()
        .post(REVOKE_ENDPOINT)
        .form(&[("token", token)])
        .send()
        .await
    {
        Ok(response) => {
            let ok = response.status().is_success();
            if !ok {
                tracing::warn!(status = response.status().as_u16(), "google revoke failed");
            }
            ok
        }
        Err(_) => {
            tracing::warn!("google revoke request failed");
            false
        }
    }
}

/// Resolve the account email that keys custody and the DB index. Prefer the
/// id_token email claim (scopes always include `openid email`; decoded
/// without verification, like os_accounts does for `exp` — the token came
/// straight from Google over TLS); fall back to the userinfo endpoint.
async fn resolve_email(tokens: &GoogleTokenResponse) -> Result<String, AppError> {
    if let Some(email) = tokens
        .id_token
        .as_deref()
        .and_then(id_token_email)
        .filter(|email| !email.is_empty())
    {
        return Ok(email);
    }
    fetch_userinfo_email(&tokens.access_token).await
}

fn id_token_email(jwt: &str) -> Option<String> {
    let payload = jwt.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims = serde_json::from_slice::<serde_json::Value>(&decoded).ok()?;
    claims
        .get("email")
        .and_then(serde_json::Value::as_str)
        .map(|email| email.trim().to_ascii_lowercase())
}

#[derive(Deserialize)]
struct UserinfoWire {
    #[serde(default)]
    email: Option<String>,
}

async fn fetch_userinfo_email(access_token: &str) -> Result<String, AppError> {
    let identity_failed = || {
        AppError::new(
            "connector_identity_failed",
            "Could not determine the Google account email.",
        )
    };
    let response = http_client()
        .get(USERINFO_ENDPOINT)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| identity_failed())?;
    if !response.status().is_success() {
        return Err(identity_failed());
    }
    let info: UserinfoWire = response.json().await.map_err(|_| identity_failed())?;
    info.email
        .map(|email| email.trim().to_ascii_lowercase())
        .filter(|email| !email.is_empty())
        .ok_or_else(identity_failed)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_url_carries_native_app_flow_params() {
        let url = build_auth_url(
            "client-123",
            "http://127.0.0.1:49152/callback",
            &[
                "openid",
                "email",
                "https://www.googleapis.com/auth/gmail.readonly",
            ],
            "challenge",
            "csrf-state",
            None,
        );
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        assert!(url.contains("client_id=client-123"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fcallback"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains(
            "scope=openid%20email%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly"
        ));
        assert!(url.contains("code_challenge=challenge"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=csrf-state"));
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("prompt=consent"));
        assert!(url.contains("include_granted_scopes=true"));
        assert!(!url.contains("login_hint"));
    }

    #[test]
    fn auth_url_includes_login_hint_for_escalation() {
        let url = build_auth_url(
            "client-123",
            "http://127.0.0.1:49152/callback",
            &["openid", "email"],
            "challenge",
            "csrf-state",
            Some("user@example.com"),
        );
        assert!(url.contains("login_hint=user%40example.com"));
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
    fn id_token_email_decodes_payload_claim() {
        let payload = URL_SAFE_NO_PAD
            .encode(r#"{"sub":"123","email":"User@Example.COM","email_verified":true}"#);
        let jwt = format!("header.{payload}.signature");
        assert_eq!(id_token_email(&jwt), Some("user@example.com".to_string()));
        assert_eq!(id_token_email("not-a-jwt"), None);
    }

    #[test]
    fn refresh_failure_classification() {
        assert!(matches!(
            classify_refresh_failure(400, Some("invalid_grant")),
            RefreshOutcome::InvalidGrant
        ));
        assert!(matches!(
            classify_refresh_failure(500, None),
            RefreshOutcome::Transient
        ));
        assert!(matches!(
            classify_refresh_failure(429, Some("rate_limited")),
            RefreshOutcome::Transient
        ));
        assert!(matches!(
            classify_refresh_failure(400, Some("invalid_client")),
            RefreshOutcome::Transient
        ));
    }

    #[test]
    fn token_forms_include_the_google_desktop_client_credential() {
        let exchange = authorization_code_form(
            "desktop-id",
            "desktop-secret",
            "authorization-code",
            "pkce-verifier",
            "http://127.0.0.1:49152/callback",
        );
        assert!(exchange.contains(&("client_id", "desktop-id")));
        assert!(exchange.contains(&("client_secret", "desktop-secret")));
        assert!(exchange.contains(&("code_verifier", "pkce-verifier")));

        let refresh = refresh_form("desktop-id", "desktop-secret", "refresh-token");
        assert!(refresh.contains(&("client_id", "desktop-id")));
        assert!(refresh.contains(&("client_secret", "desktop-secret")));
        assert!(refresh.contains(&("refresh_token", "refresh-token")));
    }

    #[test]
    fn pkce_challenge_is_s256_of_verifier() {
        let (verifier, challenge) = pkce();
        assert_eq!(
            challenge,
            URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
        );
    }
}
