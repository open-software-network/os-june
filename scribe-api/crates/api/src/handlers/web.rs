use crate::{
    auth::authenticated_user, envelope::ApiResponse, error::ApiError, state::ApiState, validation,
};
use axum::{Json, extract::State, http::HeaderMap};
use scribe_domain::{WebFetchResult, WebSearchProvider, WebSearchResults};
use scribe_services::{WebFetchParams, WebSearchParams};
use serde::Deserialize;
use std::net::{Ipv4Addr, Ipv6Addr};
use url::{Host, Url};

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
    /// Stable per-call id the client reuses across retries. It scopes the
    /// metering idempotency key so a genuine repeat search is charged while a
    /// dropped-response retry is not double-charged.
    #[serde(default)]
    pub request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchRequest {
    pub url: String,
    /// Stable per-call id the client reuses across retries; see
    /// [`WebSearchRequest::request_id`].
    #[serde(default)]
    pub request_id: String,
}

pub(crate) async fn search(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<WebSearchRequest>,
) -> Result<Json<ApiResponse<WebSearchResults>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let request_id = require_request_id(&request.request_id)?;
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
            request_id,
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
    let request_id = require_request_id(&request.request_id)?;
    let url = request.url.trim().to_string();
    if url.is_empty() {
        return Err(ApiError::bad_request("url_required"));
    }
    validation::validate_text_len("url", &url, validation::MAX_WEB_URL_CHARS)?;
    let url = match validate_public_http_url(&url) {
        Ok(canonical_url) => canonical_url,
        Err(FetchUrlValidationError::NonHttp) => {
            return Err(ApiError::bad_request("url_must_be_http"));
        }
        Err(FetchUrlValidationError::NonPublicHost) => {
            return Err(ApiError::bad_request("url_must_be_public_http"));
        }
    };
    let output = state
        .web()
        .fetch(WebFetchParams {
            user_id,
            request_id,
            url,
        })
        .await?;
    Ok(Json(ApiResponse::ok(output.result)))
}

/// Validates the client-supplied idempotency id shared by both web endpoints.
fn require_request_id(raw: &str) -> Result<String, ApiError> {
    let request_id = raw.trim().to_string();
    if request_id.is_empty() {
        return Err(ApiError::bad_request("request_id_required"));
    }
    validation::validate_text_len("request_id", &request_id, validation::MAX_ID_CHARS)?;
    Ok(request_id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FetchUrlValidationError {
    NonHttp,
    NonPublicHost,
}

/// Only public http(s) URLs reach the upstream scraper. Literal IPs are checked
/// locally. Domain names are rejected because the upstream scraper receives and
/// resolves only the original URL, so an API-side DNS preflight cannot bind the
/// address that is ultimately fetched.
fn validate_public_http_url(url: &str) -> Result<String, FetchUrlValidationError> {
    let parsed = Url::parse(url).map_err(|_| FetchUrlValidationError::NonHttp)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(FetchUrlValidationError::NonHttp);
    }

    match parsed.host() {
        Some(Host::Ipv4(addr)) if is_public_ipv4(addr) => Ok(parsed.to_string()),
        Some(Host::Ipv6(addr)) if is_public_ipv6(addr) => Ok(parsed.to_string()),
        Some(_) | None => Err(FetchUrlValidationError::NonPublicHost),
    }
}

fn is_public_ipv4(addr: Ipv4Addr) -> bool {
    !matches!(
        addr.octets(),
        [0 | 10 | 127 | 224..=255, _, _, _]
            | [169, 254, _, _]
            | [172, 16..=31, _, _]
            | [192, 0, 0 | 2, _]
            | [192, 168, _, _]
            | [198, 18..=19, _, _]
            | [198, 51, 100, _]
            | [203, 0, 113, _]
            | [100, 64..=127, _, _]
    )
}

fn is_public_ipv6(addr: Ipv6Addr) -> bool {
    if let Some(ipv4) = addr.to_ipv4_mapped() {
        return is_public_ipv4(ipv4);
    }

    let segments = addr.segments();
    if addr.is_unspecified()
        || addr.is_loopback()
        || addr.is_multicast()
        || segments[..6].iter().all(|segment| *segment == 0)
    {
        return false;
    }

    let first = segments[0];
    if is_local_nat64_ipv6(segments) {
        return false;
    }
    if is_well_known_nat64_ipv6(segments) {
        return is_public_ipv4(ipv4_from_segments(segments[6], segments[7]));
    }
    if is_6to4_ipv6(segments) {
        return is_public_ipv4(ipv4_from_segments(segments[1], segments[2]));
    }

    if (first & 0xe000) != 0x2000 {
        return false;
    }

    if (first & 0xfe00) == 0xfc00
        || (first & 0xffc0) == 0xfe80
        || is_ietf_protocol_assignment_ipv6(segments)
        || is_documentation_ipv6(segments)
        || is_srv6_sid_ipv6(segments)
        || is_discard_only_ipv6(segments)
        || is_benchmarking_ipv6(segments)
    {
        return false;
    }

    !(segments[0] == 0x2001 && segments[1] == 0x0db8)
}

fn is_local_nat64_ipv6(segments: [u16; 8]) -> bool {
    segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2] == 0x0001
}

fn is_well_known_nat64_ipv6(segments: [u16; 8]) -> bool {
    segments[0] == 0x0064
        && segments[1] == 0xff9b
        && segments[2] == 0
        && segments[3] == 0
        && segments[4] == 0
        && segments[5] == 0
}

fn is_6to4_ipv6(segments: [u16; 8]) -> bool {
    segments[0] == 0x2002
}

fn is_ietf_protocol_assignment_ipv6(segments: [u16; 8]) -> bool {
    segments[0] == 0x2001 && (segments[1] & 0xfe00) == 0
}

fn is_documentation_ipv6(segments: [u16; 8]) -> bool {
    segments[0] == 0x3fff && (segments[1] & 0xf000) == 0
}

fn is_srv6_sid_ipv6(segments: [u16; 8]) -> bool {
    segments[0] == 0x5f00
}

fn ipv4_from_segments(high: u16, low: u16) -> Ipv4Addr {
    let [a, b] = high.to_be_bytes();
    let [c, d] = low.to_be_bytes();
    Ipv4Addr::new(a, b, c, d)
}

fn is_discard_only_ipv6(segments: [u16; 8]) -> bool {
    segments[0] == 0x0100 && segments[1] == 0 && segments[2] == 0 && segments[3] == 0
}

fn is_benchmarking_ipv6(segments: [u16; 8]) -> bool {
    segments[0] == 0x2001 && segments[1] == 0x0002 && segments[2] == 0
}

#[cfg(test)]
mod tests {
    use super::{FetchUrlValidationError, validate_public_http_url};

    #[test]
    fn accepts_public_http_and_https_literal_ips() {
        assert_eq!(
            validate_public_http_url("https://93.184.216.34/post"),
            Ok("https://93.184.216.34/post".to_string())
        );
        assert_eq!(
            validate_public_http_url("https://[2606:2800:220:1:248:1893:25c8:1946]/post"),
            Ok("https://[2606:2800:220:1:248:1893:25c8:1946]/post".to_string())
        );
        assert_eq!(
            validate_public_http_url("http://[64:ff9b::5db8:d822]/post"),
            Ok("http://[64:ff9b::5db8:d822]/post".to_string())
        );
        assert_eq!(
            validate_public_http_url("http://[2002:5db8:d822::]/post"),
            Ok("http://[2002:5db8:d822::]/post".to_string())
        );
    }

    #[test]
    fn canonicalizes_public_literal_urls_before_forwarding() {
        assert_eq!(
            validate_public_http_url("http://93.184.216.34\\@169.254.169.254/"),
            Ok("http://93.184.216.34/@169.254.169.254/".to_string())
        );
    }

    #[test]
    fn rejects_domain_fetch_targets() {
        for url in [
            "https://example.com",
            "HTTP://Example.com/page",
            "http://localhost",
            "http://foo.localhost/path",
            "http://service.local/path",
            "http://service.internal/path",
        ] {
            assert_eq!(
                validate_public_http_url(url),
                Err(FetchUrlValidationError::NonPublicHost),
                "{url} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_non_http_urls() {
        assert_eq!(
            validate_public_http_url("file:///etc/passwd"),
            Err(FetchUrlValidationError::NonHttp)
        );
        assert_eq!(
            validate_public_http_url("ftp://example.com"),
            Err(FetchUrlValidationError::NonHttp)
        );
        assert_eq!(
            validate_public_http_url("javascript:alert(1)"),
            Err(FetchUrlValidationError::NonHttp)
        );
        assert_eq!(
            validate_public_http_url("example.com"),
            Err(FetchUrlValidationError::NonHttp)
        );
    }

    #[test]
    fn rejects_private_and_local_fetch_targets() {
        for url in [
            "http://localhost",
            "http://foo.localhost/path",
            "http://service.local/path",
            "http://service.internal/path",
            "http://127.0.0.1",
            "http://10.0.0.1",
            "http://172.16.0.1",
            "http://192.168.1.1",
            "http://169.254.169.254/latest/meta-data",
            "http://100.64.0.1",
            "http://198.18.0.1",
            "http://192.0.0.1",
            "http://192.0.0.8",
            "http://192.0.2.1",
            "http://198.51.100.1",
            "http://203.0.113.1",
            "http://2130706433",
            "http://[::1]/",
            "http://[::]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[fc00::1]/",
            "http://[fe80::1]/",
            "http://[fec0::1]/",
            "http://[100::1]/",
            "http://[100::abcd:1]/",
            "http://[2001::1]/",
            "http://[2001:2::1]/",
            "http://[2001:2:0:abcd::1]/",
            "http://[2001:20::1]/",
            "http://[2001:2f::1]/",
            "http://[2001:db8::1]/",
            "http://[3fff::1]/",
            "http://[3fff:0fff::1]/",
            "http://[4000::1]/",
            "http://[5f00::1]/",
            "http://[64:ff9b::a9fe:a9fe]/",
            "http://[64:ff9b::10.0.0.1]/",
            "http://[64:ff9b:1::a9fe:a9fe]/",
            "http://[2002:7f00:1::]/",
            "http://[2002:a00:1::]/",
        ] {
            assert_eq!(
                validate_public_http_url(url),
                Err(FetchUrlValidationError::NonPublicHost),
                "{url} should be rejected"
            );
        }
    }
}
