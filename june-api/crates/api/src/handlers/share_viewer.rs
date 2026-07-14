//! Read-only browser viewer for private shares (JUN-308).
//!
//! The shell is static: the same bytes are served for every well-formed
//! share id (existence is never revealed by this route), all decryption
//! happens in the page via `WebCrypto` with key material from the URL
//! fragment, and the CSP pins the exact inline script/style hashes with
//! `connect-src 'self'` — the page cannot talk to anything but june-api.
//! OS Accounts sign-in uses PKCE; the token exchange is proxied through
//! `/v1/share-viewer/token` so the browser never needs cross-origin CORS.

use crate::{error::ApiError, state::ApiState};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderValue, header},
    response::{Html, IntoResponse, Response},
};
use base64::Engine as _;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const PAGE_TEMPLATE: &str = include_str!("share_viewer_page.html");
const PAGE_SCRIPT: &str = include_str!("share_viewer_page.js");
const PAGE_STYLE: &str = include_str!("share_viewer_page.css");

fn csp_hash(source: &str) -> String {
    let digest = Sha256::digest(source.as_bytes());
    format!(
        "'sha256-{}'",
        base64::engine::general_purpose::STANDARD.encode(digest)
    )
}

fn csp_header() -> &'static str {
    static CSP: OnceLock<String> = OnceLock::new();
    CSP.get_or_init(|| {
        format!(
            "default-src 'none'; script-src {script}; style-src {style}; \
             connect-src 'self'; base-uri 'none'; form-action 'none'; \
             frame-ancestors 'none'",
            script = csp_hash(PAGE_SCRIPT),
            style = csp_hash(PAGE_STYLE),
        )
    })
}

fn render_page(state: &ApiState) -> String {
    let viewer = state.share_viewer();
    PAGE_TEMPLATE
        .replace("/*STYLE*/", PAGE_STYLE)
        .replace("/*SCRIPT*/", PAGE_SCRIPT)
        .replace(
            "__ACCOUNTS_URL__",
            viewer.accounts_url.trim_end_matches('/'),
        )
        .replace("__CLIENT_ID__", &viewer.client_id)
}

fn shell_response(state: &ApiState) -> Response {
    let mut response = Html(render_page(state)).into_response();
    let headers = response.headers_mut();
    headers.insert(
        "x-robots-tag",
        HeaderValue::from_static("noindex, nofollow, noarchive"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    if let Ok(value) = HeaderValue::from_str(csp_header()) {
        headers.insert(header::CONTENT_SECURITY_POLICY, value);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// `GET /s/{share_id}` and `GET /s/callback` — one static shell for both;
/// the page script decides which mode it is in from the URL.
pub(crate) async fn shell(State(state): State<ApiState>) -> Response {
    shell_response(&state)
}

/// `GET /robots.txt` — private share pages must never be indexed.
pub(crate) async fn robots() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "User-agent: *\nDisallow: /s/\n",
    )
}

#[derive(Debug, Deserialize)]
pub(crate) struct TokenExchangeRequest {
    code: String,
    code_verifier: String,
    redirect_uri: String,
}

/// PKCE code exchange proxy. Unauthenticated by nature (the code IS the
/// credential); rate-limited per client address; forwards to OS Accounts
/// and relays the envelope verbatim so the page sees the same shape the
/// desktop client does.
pub(crate) async fn token_exchange(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<TokenExchangeRequest>,
) -> Result<(axum::http::StatusCode, Json<serde_json::Value>), ApiError> {
    if state.share().is_none() {
        return Err(ApiError::SharingUnavailable);
    }
    // Rate-limit per address, keyed on the LAST x-forwarded-for hop (the one
    // our ingress appended); earlier entries are client-controlled and
    // spoofable, so a caller cannot vary this to escape their own budget. A
    // single global counter is deliberately NOT used here: sizing one small
    // enough to bound abuse would let one client's 60/min exhaust it and lock
    // every recipient out of sign-in platform-wide, and the non-spoofable
    // per-address key already caps each source.
    let client_key = format!("ip:{}", client_address(&headers));
    if !state.share_rate().allow(&client_key) {
        return Err(ApiError::AuthorizationDenied);
    }
    if request.code.len() > 4096
        || request.code_verifier.len() > 256
        || request.redirect_uri.len() > 512
    {
        return Err(ApiError::bad_request("token exchange field too long"));
    }
    let accounts_api = state.share_viewer_accounts_api();
    let response = state
        .share_http()
        .post(format!("{accounts_api}/auth/token"))
        .json(&serde_json::json!({
            "grant_type": "authorization_code",
            "code": request.code,
            "code_verifier": request.code_verifier,
            "redirect_uri": request.redirect_uri,
        }))
        .send()
        .await
        .map_err(|error| {
            tracing::error!(%error, "share viewer: token exchange transport error");
            ApiError::Metering
        })?;
    // Relay the upstream status AND JSON envelope so the page can tell an
    // expired code from a provider outage; a non-JSON upstream body (gateway
    // HTML, timeout text) becomes a clean metering error instead of a parse
    // panic surfaced as success.
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| {
        tracing::error!(%error, "share viewer: token exchange body read error");
        ApiError::Metering
    })?;
    let body: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
        tracing::error!(%error, %status, "share viewer: token exchange non-JSON upstream body");
        ApiError::Metering
    })?;
    Ok((status, Json(body)))
}

fn client_address(headers: &HeaderMap) -> String {
    // dstack-ingress appends the peer address as the FINAL x-forwarded-for
    // entry; everything before it arrived from the client and is spoofable.
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next_back())
        .map_or_else(|| "unknown".to_string(), |value| value.trim().to_string())
}
