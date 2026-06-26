use crate::{
    auth::authenticated_user, envelope::ApiResponse, error::ApiError, state::ApiState, validation,
};
use axum::{Json, extract::State, http::HeaderMap};
use scribe_domain::{WebFetchResult, WebSearchProvider, WebSearchResults};
use scribe_services::{WebFetchParams, WebSearchParams};
use serde::Deserialize;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
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
    match validate_public_http_url(&url) {
        Ok(FetchUrlTarget::Literal) => {}
        Ok(FetchUrlTarget::Domain { domain, port }) => {
            if !domain_resolves_to_public_ips(&domain, port).await {
                return Err(ApiError::bad_request("url_must_be_public_http"));
            }
        }
        Err(FetchUrlValidationError::NonHttp) => {
            return Err(ApiError::bad_request("url_must_be_http"));
        }
        Err(FetchUrlValidationError::NonPublicHost) => {
            return Err(ApiError::bad_request("url_must_be_public_http"));
        }
    }
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

#[derive(Debug, Clone, PartialEq, Eq)]
enum FetchUrlTarget {
    Literal,
    Domain { domain: String, port: u16 },
}

/// Only public http(s) URLs reach the upstream scraper. This keeps private
/// network targets and alternate schemes out of the fetch path before the
/// request is sent to a provider.
fn validate_public_http_url(url: &str) -> Result<FetchUrlTarget, FetchUrlValidationError> {
    let parsed = Url::parse(url).map_err(|_| FetchUrlValidationError::NonHttp)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(FetchUrlValidationError::NonHttp);
    }

    match parsed.host() {
        Some(Host::Domain(domain)) if is_public_domain(domain) => {
            let port = parsed
                .port_or_known_default()
                .ok_or(FetchUrlValidationError::NonPublicHost)?;
            Ok(FetchUrlTarget::Domain {
                domain: domain.to_string(),
                port,
            })
        }
        Some(Host::Ipv4(addr)) if is_public_ipv4(addr) => Ok(FetchUrlTarget::Literal),
        Some(Host::Ipv6(addr)) if is_public_ipv6(addr) => Ok(FetchUrlTarget::Literal),
        Some(_) | None => Err(FetchUrlValidationError::NonPublicHost),
    }
}

async fn domain_resolves_to_public_ips(domain: &str, port: u16) -> bool {
    tokio::net::lookup_host((domain, port))
        .await
        .is_ok_and(|addrs| {
            let ips: Vec<IpAddr> = addrs.map(|addr| addr.ip()).collect();
            resolved_ips_are_public(&ips)
        })
}

fn resolved_ips_are_public(ips: &[IpAddr]) -> bool {
    !ips.is_empty() && ips.iter().copied().all(is_public_ip)
}

fn is_public_domain(domain: &str) -> bool {
    let domain = domain.trim_end_matches('.').to_ascii_lowercase();
    if domain.is_empty()
        || has_terminal_label(&domain, "localhost")
        || has_terminal_label(&domain, "local")
        || has_terminal_label(&domain, "localdomain")
        || has_terminal_label(&domain, "internal")
    {
        return false;
    }

    // Avoid numeric-only hostnames that some HTTP stacks interpret as
    // alternate IPv4 forms.
    !domain
        .split('.')
        .all(|label| label.chars().all(|ch| ch.is_ascii_digit()))
}

fn has_terminal_label(domain: &str, label: &str) -> bool {
    domain == label
        || domain
            .strip_suffix(label)
            .is_some_and(|prefix| prefix.ends_with('.'))
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
    if (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80 {
        return false;
    }

    !(segments[0] == 0x2001 && segments[1] == 0x0db8)
}

fn is_public_ip(addr: IpAddr) -> bool {
    match addr {
        IpAddr::V4(addr) => is_public_ipv4(addr),
        IpAddr::V6(addr) => is_public_ipv6(addr),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        FetchUrlTarget, FetchUrlValidationError, resolved_ips_are_public, validate_public_http_url,
    };
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    #[test]
    fn accepts_http_and_https_only() {
        assert_eq!(
            validate_public_http_url("https://example.com"),
            Ok(FetchUrlTarget::Domain {
                domain: "example.com".to_string(),
                port: 443
            })
        );
        assert_eq!(
            validate_public_http_url("HTTP://Example.com/page"),
            Ok(FetchUrlTarget::Domain {
                domain: "example.com".to_string(),
                port: 80
            })
        );
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
            "http://2130706433",
            "http://[::1]/",
            "http://[::]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[fc00::1]/",
            "http://[fe80::1]/",
            "http://[2001:db8::1]/",
        ] {
            assert_eq!(
                validate_public_http_url(url),
                Err(FetchUrlValidationError::NonPublicHost),
                "{url} should be rejected"
            );
        }
    }

    #[test]
    fn accepts_public_literal_fetch_targets_without_dns() {
        assert_eq!(
            validate_public_http_url("https://93.184.216.34/post"),
            Ok(FetchUrlTarget::Literal)
        );
        assert_eq!(
            validate_public_http_url("https://[2606:2800:220:1:248:1893:25c8:1946]/post"),
            Ok(FetchUrlTarget::Literal)
        );
    }

    #[test]
    fn requires_every_resolved_domain_ip_to_be_public() {
        assert!(resolved_ips_are_public(&[IpAddr::V4(Ipv4Addr::new(
            93, 184, 216, 34
        ))]));
        assert!(!resolved_ips_are_public(&[IpAddr::V4(Ipv4Addr::new(
            169, 254, 169, 254
        ))]));
        assert!(!resolved_ips_are_public(&[
            IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ]));
    }
}
