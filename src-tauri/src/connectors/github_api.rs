use crate::{connectors::github_auth::GITHUB_API_VERSION, domain::types::AppError};
use reqwest::{header::HeaderMap, StatusCode, Url};
use serde::de::DeserializeOwned;
use std::{fmt, time::Duration};

const PRODUCTION_BASE_URL: &str = "https://api.github.com/";
const GITHUB_USER_AGENT: &str = "os-june/0.1";
const GITHUB_JSON_ACCEPT: &str = "application/vnd.github+json";
const GITHUB_TEXT_MATCH_ACCEPT: &str = "application/vnd.github.text-match+json";
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RETRY_AFTER_SECONDS: u64 = 24 * 60 * 60;

#[allow(dead_code)]
pub(super) const LIST_RESPONSE_MAX_BYTES: usize = 2 * 1024 * 1024;
#[allow(dead_code)]
pub(super) const SINGLETON_RESPONSE_MAX_BYTES: usize = 512 * 1024;
#[allow(dead_code)]
pub(super) const FILE_RESPONSE_MAX_BYTES: usize = 384 * 1024;

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GitHubApiError {
    Unauthorized,
    Forbidden,
    NotFound,
    RateLimited { retry_after_seconds: Option<u64> },
    ResponseTooLarge,
    Malformed,
    Transient,
}

impl fmt::Display for GitHubApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unauthorized => "GitHub authorization was rejected.",
            Self::Forbidden => "GitHub access was denied.",
            Self::NotFound => "GitHub content was not found.",
            Self::RateLimited { .. } => "GitHub rate limited the request.",
            Self::ResponseTooLarge => "GitHub returned too much data.",
            Self::Malformed => "GitHub returned invalid data.",
            Self::Transient => "GitHub could not be read right now.",
        })
    }
}

impl std::error::Error for GitHubApiError {}

#[allow(dead_code)]
#[derive(Clone)]
pub(crate) struct GitHubReadClient {
    http: reqwest::Client,
    base_url: Url,
}

#[allow(dead_code)]
impl GitHubReadClient {
    pub(crate) fn production() -> Result<Self, AppError> {
        Self::new(PRODUCTION_BASE_URL)
    }

    #[cfg(test)]
    pub(crate) fn for_test(base_url: &str) -> Result<Self, AppError> {
        Self::new(base_url)
    }

    fn new(base_url: &str) -> Result<Self, AppError> {
        let mut base_url = Url::parse(base_url).map_err(|_| client_unavailable())?;
        if !matches!(base_url.scheme(), "http" | "https")
            || base_url.host_str().is_none()
            || base_url.cannot_be_a_base()
        {
            return Err(client_unavailable());
        }
        base_url.set_query(None);
        base_url.set_fragment(None);
        if !base_url.path().ends_with('/') {
            let mut path = base_url.path().to_owned();
            path.push('/');
            base_url.set_path(&path);
        }
        let http = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(HTTP_TIMEOUT)
            .user_agent(GITHUB_USER_AGENT)
            .build()
            .map_err(|_| client_unavailable())?;
        Ok(Self { http, base_url })
    }

    pub(super) async fn get_json<T: DeserializeOwned>(
        &self,
        access_token: &str,
        path_segments: &[&str],
        query_pairs: &[(&str, &str)],
        max_response_bytes: usize,
    ) -> Result<T, GitHubApiError> {
        self.get_json_with_accept(
            access_token,
            path_segments,
            query_pairs,
            max_response_bytes,
            GITHUB_JSON_ACCEPT,
        )
        .await
    }

    pub(super) async fn get_json_with_text_matches<T: DeserializeOwned>(
        &self,
        access_token: &str,
        path_segments: &[&str],
        query_pairs: &[(&str, &str)],
        max_response_bytes: usize,
    ) -> Result<T, GitHubApiError> {
        self.get_json_with_accept(
            access_token,
            path_segments,
            query_pairs,
            max_response_bytes,
            GITHUB_TEXT_MATCH_ACCEPT,
        )
        .await
    }

    async fn get_json_with_accept<T: DeserializeOwned>(
        &self,
        access_token: &str,
        path_segments: &[&str],
        query_pairs: &[(&str, &str)],
        max_response_bytes: usize,
        accept: &'static str,
    ) -> Result<T, GitHubApiError> {
        if path_segments.is_empty()
            || path_segments.iter().any(|segment| {
                segment.is_empty()
                    || matches!(*segment, "." | "..")
                    || segment.chars().any(char::is_control)
            })
            || query_pairs.iter().any(|(name, value)| {
                name.is_empty()
                    || name.chars().any(char::is_control)
                    || value.chars().any(char::is_control)
            })
        {
            return Err(GitHubApiError::Malformed);
        }

        let mut url = self.base_url.clone();
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| GitHubApiError::Malformed)?;
            segments.pop_if_empty();
            segments.extend(path_segments.iter().copied());
        }
        if !query_pairs.is_empty() {
            url.query_pairs_mut()
                .extend_pairs(query_pairs.iter().copied());
        }

        let mut response = self
            .http
            .get(url)
            .header(reqwest::header::ACCEPT, accept)
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|_| GitHubApiError::Transient)?;

        if !response.status().is_success() {
            return Err(classify_status(response.status(), response.headers()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > max_response_bytes as u64)
        {
            return Err(GitHubApiError::ResponseTooLarge);
        }

        let mut body = Vec::with_capacity(max_response_bytes.min(64 * 1024));
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| GitHubApiError::Transient)?
        {
            let next_len = body
                .len()
                .checked_add(chunk.len())
                .ok_or(GitHubApiError::ResponseTooLarge)?;
            if next_len > max_response_bytes {
                return Err(GitHubApiError::ResponseTooLarge);
            }
            body.extend_from_slice(&chunk);
        }

        serde_json::from_slice(&body).map_err(|_| GitHubApiError::Malformed)
    }
}

fn classify_status(status: StatusCode, headers: &HeaderMap) -> GitHubApiError {
    match status {
        StatusCode::UNAUTHORIZED => GitHubApiError::Unauthorized,
        StatusCode::FORBIDDEN if is_rate_limited(headers) => GitHubApiError::RateLimited {
            retry_after_seconds: retry_after_seconds(headers),
        },
        StatusCode::FORBIDDEN => GitHubApiError::Forbidden,
        StatusCode::NOT_FOUND => GitHubApiError::NotFound,
        StatusCode::TOO_MANY_REQUESTS => GitHubApiError::RateLimited {
            retry_after_seconds: retry_after_seconds(headers),
        },
        _ => GitHubApiError::Transient,
    }
}

fn is_rate_limited(headers: &HeaderMap) -> bool {
    headers.contains_key(reqwest::header::RETRY_AFTER)
        || headers
            .get("x-ratelimit-remaining")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.trim() == "0")
}

fn retry_after_seconds(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| seconds.min(MAX_RETRY_AFTER_SECONDS))
        .or_else(|| {
            let reset_at = headers
                .get("x-ratelimit-reset")?
                .to_str()
                .ok()?
                .trim()
                .parse::<u64>()
                .ok()?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_secs();
            Some(reset_at.saturating_sub(now).min(MAX_RETRY_AFTER_SECONDS))
        })
}

fn client_unavailable() -> AppError {
    AppError::new(
        "github_read_unavailable",
        "GitHub could not be read right now.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        connectors::github_auth::tests::{scripted_server, RequestExpectations, ResponseFixture},
        domain::types::AppError,
    };
    use serde_json::Value;
    use tokio::net::TcpListener;

    const FIXTURE_TOKEN: &str = "fixture-access-token-secret";

    async fn request(client: &GitHubReadClient, ceiling: usize) -> Result<Value, GitHubApiError> {
        client
            .get_json(
                FIXTURE_TOKEN,
                &["repos", "open-software-network", "test-repo"],
                &[("per_page", "30")],
                ceiling,
            )
            .await
    }

    #[tokio::test]
    async fn transport_sends_only_get_and_required_github_headers() {
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, r#"{"id":123}"#),
            RequestExpectations {
                bearer_token: Some(FIXTURE_TOKEN),
                ..RequestExpectations::default()
            },
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");

        let response: Value = client
            .get_json(
                FIXTURE_TOKEN,
                &["repos", "open software", "repo/name"],
                &[("per_page", "30"), ("q", "a b")],
                SINGLETON_RESPONSE_MAX_BYTES,
            )
            .await
            .expect("fixed GET succeeds");
        assert_eq!(response["id"], 123);

        let captures = server.await.expect("scripted server");
        assert_eq!(captures.len(), 1);
        let capture = &captures[0];
        assert_eq!(capture.method, "GET");
        assert_eq!(
            capture.path,
            "/repos/open%20software/repo%2Fname?per_page=30&q=a+b"
        );
        assert!(capture.has_expected_bearer_token);
        assert!(capture
            .headers
            .contains("accept: application/vnd.github+json"));
        assert!(capture.headers.contains("x-github-api-version: 2026-03-10"));
        assert!(capture.headers.contains("user-agent: os-june/0.1"));
    }

    #[tokio::test]
    async fn transport_refuses_redirects() {
        let redirect_target = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind redirect target");
        let target_url = format!(
            "http://{}/redirected",
            redirect_target
                .local_addr()
                .expect("redirect target address")
        );
        let target = tokio::spawn(async move {
            tokio::time::timeout(
                std::time::Duration::from_millis(250),
                redirect_target.accept(),
            )
            .await
            .is_ok()
        });
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(302, "redirect body must not be exposed")
                .with_header("Location", &target_url),
            RequestExpectations {
                bearer_token: Some(FIXTURE_TOKEN),
                ..RequestExpectations::default()
            },
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");

        assert_eq!(
            request(&client, SINGLETON_RESPONSE_MAX_BYTES).await,
            Err(GitHubApiError::Transient)
        );
        assert!(!target.await.expect("redirect target task"));
        assert_eq!(server.await.expect("scripted server").len(), 1);
    }

    #[tokio::test]
    async fn transport_stops_streaming_at_the_byte_ceiling() {
        let oversized = format!(r#"{{"content":"{}"}}"#, "x".repeat(FILE_RESPONSE_MAX_BYTES));
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, oversized).chunked(),
            RequestExpectations {
                bearer_token: Some(FIXTURE_TOKEN),
                ..RequestExpectations::default()
            },
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");

        assert_eq!(
            request(&client, FILE_RESPONSE_MAX_BYTES).await,
            Err(GitHubApiError::ResponseTooLarge)
        );
        assert_eq!(server.await.expect("scripted server").len(), 1);
    }

    #[tokio::test]
    async fn transport_classifies_401_403_404_rate_limit_and_transient_failures() {
        let script = vec![
            (
                ResponseFixture::json(401, "unauthorized secret"),
                RequestExpectations::default(),
            ),
            (
                ResponseFixture::json(403, "forbidden secret"),
                RequestExpectations::default(),
            ),
            (
                ResponseFixture::json(404, "not-found secret"),
                RequestExpectations::default(),
            ),
            (
                ResponseFixture::json(429, "rate-limit secret").with_header("Retry-After", "17"),
                RequestExpectations::default(),
            ),
            (
                ResponseFixture::json(500, "transient secret"),
                RequestExpectations::default(),
            ),
        ];
        let (base_url, server) = scripted_server(script).await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");

        let expected = [
            GitHubApiError::Unauthorized,
            GitHubApiError::Forbidden,
            GitHubApiError::NotFound,
            GitHubApiError::RateLimited {
                retry_after_seconds: Some(17),
            },
            GitHubApiError::Transient,
        ];
        for expected_error in expected {
            assert_eq!(
                request(&client, SINGLETON_RESPONSE_MAX_BYTES).await,
                Err(expected_error)
            );
        }
        assert_eq!(server.await.expect("scripted server").len(), 5);
    }

    #[tokio::test]
    async fn transport_never_includes_body_or_url_in_errors() {
        let provider_body = "provider-body-secret";
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(500, provider_body),
            RequestExpectations {
                bearer_token: Some(FIXTURE_TOKEN),
                ..RequestExpectations::default()
            },
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        let error = client
            .get_json::<Value>(
                FIXTURE_TOKEN,
                &["repos", "repository-url-secret", "test-repo"],
                &[],
                SINGLETON_RESPONSE_MAX_BYTES,
            )
            .await
            .expect_err("server failure");

        let debug = format!("{error:?}");
        let display = error.to_string();
        let app_error =
            serde_json::to_string(&AppError::new("github_read_unavailable", error.to_string()))
                .expect("serialize app error");
        for rendered in [&debug, &display, &app_error] {
            assert!(!rendered.contains(FIXTURE_TOKEN));
            assert!(!rendered.contains(provider_body));
            assert!(!rendered.contains("repository-url-secret"));
            assert!(!rendered.contains(&base_url));
        }
        assert_eq!(server.await.expect("scripted server").len(), 1);
    }

    #[tokio::test]
    async fn transport_rejects_malformed_json() {
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, "{malformed-json"),
            RequestExpectations {
                bearer_token: Some(FIXTURE_TOKEN),
                ..RequestExpectations::default()
            },
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");

        assert_eq!(
            request(&client, SINGLETON_RESPONSE_MAX_BYTES).await,
            Err(GitHubApiError::Malformed)
        );
        assert_eq!(server.await.expect("scripted server").len(), 1);
    }
}
