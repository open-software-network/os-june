use crate::{
    auth::authenticated_user, envelope::ApiResponse, error::ApiError, state::ApiState, validation,
};
use axum::{Json, extract::State, http::HeaderMap};
use scribe_domain::{WebFetchResult, WebSearchProvider, WebSearchResults};
use scribe_services::{WebFetchParams, WebSearchParams};
use serde::Deserialize;

/// Venice clamps `limit` to its own bounds; we mirror them so an out-of-range
/// value from the agent is normalized rather than rejected.
const MIN_SEARCH_LIMIT: u32 = 1;
const MAX_SEARCH_LIMIT: u32 = 20;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchRequest {
    pub query: String,
    #[serde(default)]
    pub limit: Option<u32>,
    /// `brave` (default) or `google`; omitted means brave.
    #[serde(default)]
    pub provider: Option<WebSearchProvider>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchRequest {
    pub url: String,
}

pub(crate) async fn search(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<WebSearchRequest>,
) -> Result<Json<ApiResponse<WebSearchResults>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let query = request.query.trim().to_string();
    if query.is_empty() {
        return Err(ApiError::bad_request("query_required"));
    }
    validation::validate_text_len("query", &query, validation::MAX_WEB_QUERY_CHARS)?;
    let limit = request
        .limit
        .map(|limit| limit.clamp(MIN_SEARCH_LIMIT, MAX_SEARCH_LIMIT));
    let output = state
        .web()
        .search(WebSearchParams {
            user_id,
            query,
            limit,
            provider: request.provider.unwrap_or_default(),
        })
        .await?;
    Ok(Json(ApiResponse::ok(output.results)))
}

pub(crate) async fn fetch(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<WebFetchRequest>,
) -> Result<Json<ApiResponse<WebFetchResult>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let url = request.url.trim().to_string();
    if url.is_empty() {
        return Err(ApiError::bad_request("url_required"));
    }
    validation::validate_text_len("url", &url, validation::MAX_WEB_URL_CHARS)?;
    if !is_http_url(&url) {
        return Err(ApiError::bad_request("url_must_be_http"));
    }
    let output = state.web().fetch(WebFetchParams { user_id, url }).await?;
    Ok(Json(ApiResponse::ok(output.result)))
}

/// Only http(s) URLs reach the upstream scraper. Rejecting other schemes here
/// keeps `file://`, `data:`, and similar out of the fetch path even though
/// Venice only scrapes public URLs.
fn is_http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

#[cfg(test)]
mod tests {
    use super::is_http_url;

    #[test]
    fn accepts_http_and_https_only() {
        assert!(is_http_url("https://example.com"));
        assert!(is_http_url("HTTP://Example.com/page"));
        assert!(!is_http_url("file:///etc/passwd"));
        assert!(!is_http_url("ftp://example.com"));
        assert!(!is_http_url("javascript:alert(1)"));
        assert!(!is_http_url("example.com"));
    }
}
