//! GitHub App user access tokens, web application flow.
//!
//! GitHub does NOT support PKCE-only public clients: the token endpoint
//! requires the client secret. The consent flow uses the user's default browser
//! and a loopback callback on a fixed registered port (GitHub matches the
//! callback URL exactly, port included). A random `state` value replaces the
//! PKCE code challenge for CSRF protection.
//!
//! Token lifetime: when the GitHub App has "expire user authorization tokens"
//! enabled, the exchange returns an `expires_in` and a `refresh_token` that
//! rotates on every refresh. When the app has that setting disabled, GitHub
//! returns a non-expiring token with no `expires_in` and no `refresh_token`;
//! June stores it with a far-future expiry so the freshness gate never triggers
//! an unnecessary refresh.
//!
//! NEVER log, print, or serialize tokens (or authorization codes) into errors.
//! Error messages carry stable codes and short human text only.

use crate::domain::types::AppError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

use super::oauth::{self, ConnectFlow};

const AUTH_ENDPOINT: &str = "https://github.com/login/oauth/authorize";
const TOKEN_ENDPOINT: &str = "https://github.com/login/oauth/access_token";
/// GitHub requires a User-Agent header on every API call; mirror the shared
/// http_client's value.
const GITHUB_USER_AGENT: &str = "os-june/0.1";
const GITHUB_API_VERSION: &str = "2022-11-28";

/// For GitHub Apps that do not expire user tokens: store a far-future expiry
/// so the freshness gate never triggers. ~100 years in seconds.
pub(super) const NON_EXPIRING_TOKEN_LIFETIME_SECS: i64 = 3_153_600_000;

// ----- Token exchange & refresh -----------------------------------------------

/// GitHub token exchange/refresh response. Secret fields zeroize on drop.
/// GitHub returns HTTP 200 with an `error` field on failure (not a 4xx), so
/// callers must parse the `error` field even on 200.
#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct GithubTokenResponse {
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub token_type: String,
    /// Present only when the GitHub App has "expire user authorization tokens"
    /// enabled. `None` means the token is non-expiring.
    #[serde(default)]
    #[zeroize(skip)]
    pub expires_in: Option<i64>,
    /// Rotates on every refresh. Absent for non-expiring token apps.
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    #[zeroize(skip)]
    pub refresh_token_expires_in: Option<i64>,
    /// Present when GitHub returns an error on HTTP 200.
    #[serde(default)]
    #[zeroize(skip)]
    pub error: Option<String>,
    #[serde(default)]
    #[zeroize(skip)]
    pub error_description: Option<String>,
}

impl GithubTokenResponse {
    fn is_success(&self) -> bool {
        self.error.is_none() && !self.access_token.is_empty()
    }
}

/// The GitHub user who authorized, resolved from `GET /user`.
/// Carries no token material; `Debug` is safe.
#[derive(Debug, Clone)]
pub struct GithubIdentity {
    /// Stringified numeric GitHub user id (e.g. "1234567"). Keys custody and
    /// the DB index - NOT the login, which can change.
    pub user_id: String,
    /// GitHub username (@-handle), used as the display identity.
    pub login: String,
    /// Display name from the profile; may be empty.
    pub name: String,
}

/// Outcome of the full browser handoff.
pub struct GithubAuthorizedGrant {
    pub tokens: GithubTokenResponse,
    pub identity: GithubIdentity,
}

/// Outcome of one refresh attempt. Mirrors [`linear::LinearRefreshOutcome`]
/// with GitHub-specific error classification.
pub enum GithubRefreshOutcome {
    Refreshed(GithubTokenResponse),
    /// Definitive: the grant was revoked or the refresh token is invalid.
    /// GitHub signals this with `error: "bad_refresh_token"`. Reconnect required.
    InvalidGrant,
    /// Upstream wobble (network error, 5xx): worth a bounded retry.
    Transient,
}

/// Run the full GitHub authorization handoff: open the consent screen in the
/// default browser, wait on the loopback listener for the redirect, exchange
/// the code for tokens, and resolve the user identity. No PKCE (GitHub does
/// not support it); CSRF protection via the random `state` value that
/// [`oauth::loopback_authorize`] mints.
pub async fn authorize(
    flow: &ConnectFlow,
    client_id: &str,
    client_secret: &str,
    loopback_ports: &[u16],
) -> Result<GithubAuthorizedGrant, AppError> {
    let authorization = oauth::loopback_authorize(
        flow,
        "GitHub",
        oauth::LoopbackPort::Candidates(loopback_ports.to_vec()),
        |redirect_uri, _code_challenge, state| {
            // No PKCE: the code_challenge is ignored; the state is the CSRF token.
            // No scope param: GitHub Apps ignore scopes on the authorize URL.
            build_auth_url(client_id, redirect_uri, state)
        },
    )
    .await?;

    let tokens = exchange_code(
        client_id,
        client_secret,
        &authorization.code,
        &authorization.redirect_uri,
    )
    .await?;
    let identity = fetch_identity(&tokens.access_token).await?;
    Ok(GithubAuthorizedGrant { tokens, identity })
}

fn build_auth_url(client_id: &str, redirect_uri: &str, state: &str) -> String {
    // No scope param: GitHub Apps' user tokens carry permissions derived from
    // the app's configured permissions and the installation's repository
    // selection; scopes on the authorize URL are ignored.
    // No code_challenge: GitHub does not support PKCE for App user tokens.
    format!(
        "{AUTH_ENDPOINT}?client_id={}&redirect_uri={}&state={}",
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(state),
    )
}

/// Exchange the authorization code for tokens. GitHub requires the client
/// secret (unlike Linear's PKCE-only flow). The response is always HTTP 200;
/// failure is signaled by an `error` field in the JSON body.
async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: &str,
) -> Result<GithubTokenResponse, AppError> {
    let response = oauth::http_client()
        .post(TOKEN_ENDPOINT)
        .header("Accept", "application/json")
        .form(&exchange_form(client_id, client_secret, code, redirect_uri))
        .send()
        .await
        .map_err(|_| exchange_failed(None))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| exchange_failed(None))?;
    match serde_json::from_str::<GithubTokenResponse>(&body) {
        Ok(resp) if resp.is_success() => Ok(resp),
        Ok(resp) => {
            // GitHub returns HTTP 200 with an error field.
            let error_code = resp.error.clone();
            tracing::warn!(status, error_code = ?error_code, "github token exchange returned error");
            Err(exchange_failed(error_code))
        }
        Err(_) => {
            tracing::warn!(status, "github token exchange response unparseable");
            Err(exchange_failed(None))
        }
    }
}

fn exchange_form<'a>(
    client_id: &'a str,
    client_secret: &'a str,
    code: &'a str,
    redirect_uri: &'a str,
) -> [(&'static str, &'a str); 4] {
    [
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("code", code),
        ("redirect_uri", redirect_uri),
    ]
}

fn exchange_failed(error_code: Option<String>) -> AppError {
    let message = match error_code {
        Some(code) => format!("Could not complete the GitHub connection ({code})."),
        None => "Could not complete the GitHub connection.".to_string(),
    };
    AppError::new("connector_token_exchange_failed", message)
}

/// One refresh attempt. `bad_refresh_token` is the definitive invalid-grant
/// signal from GitHub; everything else (network failure, 5xx) is transient.
/// Refresh tokens rotate on every successful refresh; the caller persists the
/// new one and logs if the persist fails (strand-logging mirrors Linear's
/// pattern).
pub async fn refresh(
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> GithubRefreshOutcome {
    let response = match oauth::http_client()
        .post(TOKEN_ENDPOINT)
        .header("Accept", "application/json")
        .form(&refresh_form(client_id, client_secret, refresh_token))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return GithubRefreshOutcome::Transient,
    };
    let status = response.status().as_u16();
    let body = match response.text().await {
        Ok(body) => body,
        Err(_) => return GithubRefreshOutcome::Transient,
    };
    match serde_json::from_str::<GithubTokenResponse>(&body) {
        Ok(resp) if resp.is_success() => GithubRefreshOutcome::Refreshed(resp),
        Ok(resp) => classify_refresh_failure(status, resp.error.as_deref()),
        Err(_) => GithubRefreshOutcome::Transient,
    }
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

/// `bad_refresh_token` is GitHub's definitive "grant invalid" error; every
/// other failure (5xx, network, unknown error code) is transient. Mirrors the
/// Google/Linear classification pattern.
fn classify_refresh_failure(status: u16, error_code: Option<&str>) -> GithubRefreshOutcome {
    tracing::warn!(status, error_code = ?error_code, "github token refresh failed");
    match error_code {
        Some("bad_refresh_token") => GithubRefreshOutcome::InvalidGrant,
        _ => GithubRefreshOutcome::Transient,
    }
}

/// Shared GitHub API request builder: Bearer auth, required Accept and
/// X-GitHub-Api-Version headers, and the required User-Agent. GitHub requires
/// a User-Agent on every call; absent one returns 403.
fn github_api_request(
    access_token: &str,
    method: reqwest::Method,
    url: &str,
) -> reqwest::RequestBuilder {
    oauth::http_client()
        .request(method, url)
        .bearer_auth(access_token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
        .header("User-Agent", GITHUB_USER_AGENT)
}

// ----- Identity ---------------------------------------------------------------

const USER_ENDPOINT: &str = "https://api.github.com/user";

#[derive(Deserialize)]
struct GithubUserWire {
    id: u64,
    login: String,
    #[serde(default)]
    name: Option<String>,
}

fn identity_failed() -> AppError {
    AppError::new(
        "connector_identity_failed",
        "Could not determine the GitHub account.",
    )
}

/// Resolve the user identity with the fresh access token. The numeric id keys
/// custody and the DB index; the login is the display identity. Mirrors how
/// Linear's fetch_identity works: any transport or API failure maps to the
/// single identity error.
pub async fn fetch_identity(access_token: &str) -> Result<GithubIdentity, AppError> {
    let response = github_api_request(access_token, reqwest::Method::GET, USER_ENDPOINT)
        .send()
        .await
        .map_err(|_| identity_failed())?;
    if !response.status().is_success() {
        return Err(identity_failed());
    }
    let user: GithubUserWire = response.json().await.map_err(|_| identity_failed())?;
    if user.login.is_empty() {
        return Err(identity_failed());
    }
    Ok(GithubIdentity {
        user_id: user.id.to_string(),
        login: user.login,
        name: user.name.unwrap_or_default(),
    })
}

// ----- Revoke -----------------------------------------------------------------

/// Best-effort revocation of a user access token at GitHub (used by
/// `disconnect(revoke_grant = true)`). Uses HTTP Basic auth (client_id:client_secret)
/// and a JSON body, as GitHub requires for this endpoint. Failures are logged
/// and swallowed; local custody removal is the real disconnect.
pub async fn revoke(client_id: &str, client_secret: &str, access_token: &str) -> bool {
    let url = format!("https://api.github.com/applications/{client_id}/token");
    match oauth::http_client()
        .delete(&url)
        .basic_auth(client_id, Some(client_secret))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
        .header("User-Agent", GITHUB_USER_AGENT)
        .json(&serde_json::json!({ "access_token": access_token }))
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status().as_u16();
            let ok = response.status().is_success() || status == 404;
            if !ok {
                tracing::warn!(status, "github token revoke did not confirm");
            }
            ok
        }
        Err(_) => {
            tracing::warn!("github revoke request failed");
            false
        }
    }
}

// ----- API error type ---------------------------------------------------------

/// API error type for GitHub REST calls. Mirrors [`linear::LinearApiError`]'s
/// shape: `Unauthorized` for 401 so callers can force-refresh and retry once.
#[derive(Debug)]
pub enum GithubApiError {
    /// 401: the token was rejected. Caller should force-refresh and retry once.
    Unauthorized,
    /// 403: typically rate-limiting or scope issues.
    Forbidden,
    /// 404: the requested resource was not found.
    NotFound,
    /// Any other HTTP error with status and message.
    Api { status: u16, message: String },
    /// Network failure.
    Network(String),
}

impl From<GithubApiError> for AppError {
    fn from(error: GithubApiError) -> Self {
        match error {
            GithubApiError::Unauthorized => AppError::new(
                "github_unauthorized",
                "GitHub rejected the connection's access token.",
            ),
            GithubApiError::Forbidden => AppError::new(
                "github_forbidden",
                "GitHub denied this request. Check the app's permissions.",
            ),
            GithubApiError::NotFound => AppError::new(
                "github_not_found",
                "The requested GitHub resource was not found.",
            ),
            GithubApiError::Api { status, message } => AppError::new(
                "github_api_error",
                format!("GitHub API request failed ({status}): {message}"),
            ),
            GithubApiError::Network(message) => AppError::new("network_error", message),
        }
    }
}

/// Classify an HTTP status into the error type. A response body message is
/// bounded and never echoes token material.
fn classify_api_error(status: u16, message: String) -> GithubApiError {
    match status {
        401 => GithubApiError::Unauthorized,
        403 => GithubApiError::Forbidden,
        404 => GithubApiError::NotFound,
        _ => GithubApiError::Api { status, message },
    }
}

/// Extract a human-readable error message from a GitHub API error body,
/// bounded to avoid flooding context.
async fn error_message_from_response(response: reqwest::Response) -> String {
    #[derive(Deserialize)]
    struct GithubErrorWire {
        #[serde(default)]
        message: String,
    }
    match response.json::<GithubErrorWire>().await {
        Ok(body) if !body.message.is_empty() => body.message.chars().take(200).collect(),
        _ => "request failed".to_string(),
    }
}

// ----- Repositories -----------------------------------------------------------

/// One repository reachable through the connected user's installations.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepository {
    pub full_name: String,
    pub private: bool,
    pub default_branch: String,
    pub html_url: String,
    pub description: Option<String>,
}

#[derive(Deserialize)]
struct InstallationWire {
    id: u64,
}

#[derive(Deserialize)]
struct InstallationsWire {
    installations: Vec<InstallationWire>,
}

#[derive(Deserialize)]
struct InstallationReposWire {
    repositories: Vec<RepoWire>,
}

#[derive(Deserialize)]
struct RepoWire {
    full_name: String,
    #[serde(default)]
    private: bool,
    default_branch: String,
    html_url: String,
    #[serde(default)]
    description: Option<String>,
}

/// Maximum pages fetched per paginated GitHub endpoint call (100 items/page,
/// so at most 500 installations or 500 repos per installation).
const PAGINATION_MAX_PAGES: u32 = 5;
const PAGINATION_PER_PAGE: u32 = 100;

/// Result of a paginated page-accumulation run. Carries the accumulated items
/// and whether the safety cap was reached before exhausting all pages.
pub struct PageAccumulation {
    pub count: usize,
    pub truncated: bool,
}

/// Pure helper: given the number of items on the latest page (`page_len`) and
/// the page number just fetched (`page`), decide whether to continue to the
/// next page. Returns `(fetch_next, truncated)`.
///
/// - If `page_len < per_page`, the API has no more items — stop, not truncated.
/// - If `page == max_pages`, we hit the cap with a full page — stop, truncated.
/// - Otherwise, continue to `page + 1`.
pub fn pagination_next(
    page_len: usize,
    page: u32,
    per_page: usize,
    max_pages: u32,
) -> (bool, bool) {
    if page_len < per_page {
        // Last page (partial or empty): no more data.
        (false, false)
    } else if page >= max_pages {
        // Full page but safety cap reached — more pages may remain.
        (false, true)
    } else {
        (true, false)
    }
}

/// List of repositories reachable through the user's GitHub App installations,
/// with a `truncated` flag that is `true` when the safety-cap cut enumeration
/// short (meaning more items exist beyond what was returned).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepositoryList {
    pub repositories: Vec<GithubRepository>,
    /// `true` when the safety page cap was reached with more pages remaining,
    /// meaning the list is incomplete. Users with more than 500 installations
    /// or more than 500 repositories in a single installation will see this.
    pub truncated: bool,
}

/// List all repositories accessible via the user's GitHub App installations.
/// Paginates both `GET /user/installations` (up to 5 pages × 100 = 500
/// installations) and `GET /user/installations/{id}/repositories` (same cap
/// per installation). Returns `truncated: true` when the safety cap cuts
/// enumeration short.
pub async fn list_repositories(access_token: &str) -> Result<GithubRepositoryList, GithubApiError> {
    // --- Paginate installations -----------------------------------------------
    let mut installations: Vec<InstallationWire> = Vec::new();
    let mut install_truncated = false;
    'install_pages: for page in 1..=PAGINATION_MAX_PAGES {
        let url = format!(
            "https://api.github.com/user/installations?per_page={}&page={}",
            PAGINATION_PER_PAGE, page
        );
        let response = github_api_request(access_token, reqwest::Method::GET, &url)
            .send()
            .await
            .map_err(|e| GithubApiError::Network(e.to_string()))?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            let message = error_message_from_response(response).await;
            return Err(classify_api_error(status, message));
        }
        let wire: InstallationsWire = response
            .json()
            .await
            .map_err(|e| GithubApiError::Network(e.to_string()))?;
        let page_len = wire.installations.len();
        installations.extend(wire.installations);
        let (fetch_next, truncated) = pagination_next(
            page_len,
            page,
            PAGINATION_PER_PAGE as usize,
            PAGINATION_MAX_PAGES,
        );
        if truncated {
            install_truncated = true;
            break 'install_pages;
        }
        if !fetch_next {
            break 'install_pages;
        }
    }

    // --- For each installation, paginate repositories -------------------------
    let mut repos: Vec<GithubRepository> = Vec::new();
    let mut repo_truncated = false;
    for installation in installations {
        'repo_pages: for page in 1..=PAGINATION_MAX_PAGES {
            let url = format!(
                "https://api.github.com/user/installations/{}/repositories?per_page={}&page={}",
                installation.id, PAGINATION_PER_PAGE, page
            );
            let resp = github_api_request(access_token, reqwest::Method::GET, &url)
                .send()
                .await
                .map_err(|e| GithubApiError::Network(e.to_string()))?;
            let install_status = resp.status().as_u16();
            if !resp.status().is_success() {
                let message = error_message_from_response(resp).await;
                return Err(classify_api_error(install_status, message));
            }
            let install_repos: InstallationReposWire = resp
                .json()
                .await
                .map_err(|e| GithubApiError::Network(e.to_string()))?;
            let page_len = install_repos.repositories.len();
            for repo in install_repos.repositories {
                repos.push(GithubRepository {
                    full_name: repo.full_name,
                    private: repo.private,
                    default_branch: repo.default_branch,
                    html_url: repo.html_url,
                    description: repo.description,
                });
            }
            let (fetch_next, truncated) = pagination_next(
                page_len,
                page,
                PAGINATION_PER_PAGE as usize,
                PAGINATION_MAX_PAGES,
            );
            if truncated {
                repo_truncated = true;
                break 'repo_pages;
            }
            if !fetch_next {
                break 'repo_pages;
            }
        }
    }

    Ok(GithubRepositoryList {
        repositories: repos,
        truncated: install_truncated || repo_truncated,
    })
}

// ----- Issue search -----------------------------------------------------------

/// One issue or pull request from a search result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubIssueSummary {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub is_pull_request: bool,
    pub repo_full_name: String,
    pub updated_at: String,
    pub html_url: String,
}

#[derive(Deserialize)]
struct SearchIssuesWire {
    items: Vec<SearchIssueItemWire>,
}

#[derive(Deserialize)]
struct SearchIssueItemWire {
    number: u64,
    title: String,
    state: String,
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
    repository_url: String,
    updated_at: String,
    html_url: String,
}

/// Search issues and pull requests via GitHub's search API. `per_page` is
/// capped at 30.
pub async fn search_issues(
    access_token: &str,
    query: &str,
    per_page: Option<u32>,
) -> Result<Vec<GithubIssueSummary>, GithubApiError> {
    let per_page = per_page.unwrap_or(25).min(30);
    let url = format!(
        "https://api.github.com/search/issues?q={}&per_page={}",
        urlencoding::encode(query),
        per_page,
    );
    let response = github_api_request(access_token, reqwest::Method::GET, &url)
        .send()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let message = error_message_from_response(response).await;
        return Err(classify_api_error(status, message));
    }
    let result: SearchIssuesWire = response
        .json()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;
    Ok(result
        .items
        .into_iter()
        .map(|item| {
            // Parse repo full_name from repository_url:
            // "https://api.github.com/repos/{owner}/{repo}"
            let repo_full_name = item
                .repository_url
                .strip_prefix("https://api.github.com/repos/")
                .unwrap_or(&item.repository_url)
                .to_string();
            GithubIssueSummary {
                number: item.number,
                title: item.title,
                state: item.state,
                is_pull_request: item.pull_request.is_some(),
                repo_full_name,
                updated_at: item.updated_at,
                html_url: item.html_url,
            }
        })
        .collect())
}

// ----- Issue detail -----------------------------------------------------------

const ISSUE_BODY_MAX_CHARS: usize = 20_000;

/// Detailed view of one GitHub issue.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubIssueDetail {
    pub number: u64,
    pub title: String,
    pub body: Option<String>,
    pub body_truncated: bool,
    pub state: String,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub updated_at: String,
    pub html_url: String,
}

#[derive(Deserialize)]
struct IssueDetailWire {
    number: u64,
    title: String,
    #[serde(default)]
    body: Option<String>,
    state: String,
    #[serde(default)]
    labels: Vec<LabelWire>,
    #[serde(default)]
    assignees: Vec<AssigneeWire>,
    updated_at: String,
    html_url: String,
}

#[derive(Deserialize)]
struct LabelWire {
    name: String,
}

#[derive(Deserialize)]
struct AssigneeWire {
    login: String,
}

/// Fetch one issue's full detail. `owner` and `repo` are the repository owner
/// and name; `number` is the issue number.
pub async fn get_issue(
    access_token: &str,
    owner: &str,
    repo: &str,
    number: u64,
) -> Result<GithubIssueDetail, GithubApiError> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/issues/{number}");
    let response = github_api_request(access_token, reqwest::Method::GET, &url)
        .send()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let message = error_message_from_response(response).await;
        return Err(classify_api_error(status, message));
    }
    let wire: IssueDetailWire = response
        .json()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;
    let (body, body_truncated) = bound_body(wire.body);
    Ok(GithubIssueDetail {
        number: wire.number,
        title: wire.title,
        body,
        body_truncated,
        state: wire.state,
        labels: wire.labels.into_iter().map(|l| l.name).collect(),
        assignees: wire.assignees.into_iter().map(|a| a.login).collect(),
        updated_at: wire.updated_at,
        html_url: wire.html_url,
    })
}

/// Bound a body text to `ISSUE_BODY_MAX_CHARS`, returning the bounded text and
/// whether truncation occurred. Works on chars so multi-byte text always lands
/// on a valid boundary.
fn bound_body(body: Option<String>) -> (Option<String>, bool) {
    match body {
        None => (None, false),
        Some(text) => {
            let char_count = text.chars().count();
            if char_count <= ISSUE_BODY_MAX_CHARS {
                (Some(text), false)
            } else {
                let bounded: String = text.chars().take(ISSUE_BODY_MAX_CHARS).collect();
                (Some(bounded), true)
            }
        }
    }
}

// ----- Issue comments ---------------------------------------------------------

const COMMENT_BODY_MAX_CHARS: usize = 4_000;

/// One comment on a GitHub issue or pull request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubIssueComment {
    pub id: u64,
    pub author_login: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Deserialize)]
struct CommentWire {
    id: u64,
    #[serde(default)]
    user: Option<UserLoginWire>,
    #[serde(default)]
    body: String,
    created_at: String,
}

#[derive(Deserialize)]
struct UserLoginWire {
    login: String,
}

/// List comments on an issue or pull request. `per_page` is capped at 30.
pub async fn list_issue_comments(
    access_token: &str,
    owner: &str,
    repo: &str,
    number: u64,
    per_page: Option<u32>,
) -> Result<Vec<GithubIssueComment>, GithubApiError> {
    let per_page = per_page.unwrap_or(25).min(30);
    let url = format!(
        "https://api.github.com/repos/{owner}/{repo}/issues/{number}/comments?per_page={per_page}"
    );
    let response = github_api_request(access_token, reqwest::Method::GET, &url)
        .send()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let message = error_message_from_response(response).await;
        return Err(classify_api_error(status, message));
    }
    let wires: Vec<CommentWire> = response
        .json()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;
    Ok(wires
        .into_iter()
        .map(|w| {
            let body_chars: String = w.body.chars().take(COMMENT_BODY_MAX_CHARS).collect();
            GithubIssueComment {
                id: w.id,
                author_login: w.user.map(|u| u.login).unwrap_or_default(),
                body: body_chars,
                created_at: w.created_at,
            }
        })
        .collect())
}

// ----- Pull request detail ----------------------------------------------------

/// Detailed view of one GitHub pull request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullRequest {
    pub number: u64,
    pub title: String,
    pub body: Option<String>,
    pub body_truncated: bool,
    pub state: String,
    pub draft: bool,
    pub head_ref: String,
    pub head_sha: String,
    pub base_ref: String,
    pub base_sha: String,
    pub mergeable_state: Option<String>,
    pub changed_files: u32,
    pub additions: u32,
    pub deletions: u32,
    pub html_url: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
struct PullRequestWire {
    number: u64,
    title: String,
    #[serde(default)]
    body: Option<String>,
    state: String,
    #[serde(default)]
    draft: bool,
    head: BranchRefWire,
    base: BranchRefWire,
    #[serde(default)]
    mergeable_state: Option<String>,
    #[serde(default)]
    changed_files: u32,
    #[serde(default)]
    additions: u32,
    #[serde(default)]
    deletions: u32,
    html_url: String,
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchRefWire {
    #[serde(rename = "ref")]
    ref_name: String,
    sha: String,
}

/// Fetch one pull request's detail.
pub async fn get_pull_request(
    access_token: &str,
    owner: &str,
    repo: &str,
    number: u64,
) -> Result<GithubPullRequest, GithubApiError> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/pulls/{number}");
    let response = github_api_request(access_token, reqwest::Method::GET, &url)
        .send()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let message = error_message_from_response(response).await;
        return Err(classify_api_error(status, message));
    }
    let wire: PullRequestWire = response
        .json()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;
    let (body, body_truncated) = bound_body(wire.body);
    Ok(GithubPullRequest {
        number: wire.number,
        title: wire.title,
        body,
        body_truncated,
        state: wire.state,
        draft: wire.draft,
        head_ref: wire.head.ref_name,
        head_sha: wire.head.sha,
        base_ref: wire.base.ref_name,
        base_sha: wire.base.sha,
        mergeable_state: wire.mergeable_state,
        changed_files: wire.changed_files,
        additions: wire.additions,
        deletions: wire.deletions,
        html_url: wire.html_url,
        updated_at: wire.updated_at,
    })
}

// ----- File read --------------------------------------------------------------

/// Maximum bytes to decode from a file's base64 content before truncating.
const READ_FILE_MAX_BYTES: usize = 200_000;

/// Contents of one file from a GitHub repository.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubFileContent {
    pub path: String,
    pub content: String,
    pub truncated: bool,
    pub encoding: String,
    pub size: u64,
}

#[derive(Deserialize)]
struct ContentsWire {
    #[serde(rename = "type")]
    content_type: String,
    path: String,
    content: String,
    encoding: String,
    #[serde(default)]
    size: u64,
}

/// Read one file from a GitHub repository, decoding base64 content. Refuses
/// non-file types (directories, symlinks, submodules) with a clean error.
/// Caps decoded content at `READ_FILE_MAX_BYTES` bytes.
pub async fn read_file(
    access_token: &str,
    owner: &str,
    repo: &str,
    path: &str,
    git_ref: Option<&str>,
) -> Result<GithubFileContent, GithubApiError> {
    let mut url = format!(
        "https://api.github.com/repos/{owner}/{repo}/contents/{}",
        urlencoding::encode(path)
    );
    if let Some(r) = git_ref {
        url.push_str(&format!("?ref={}", urlencoding::encode(r)));
    }
    let response = github_api_request(access_token, reqwest::Method::GET, &url)
        .send()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let message = error_message_from_response(response).await;
        return Err(classify_api_error(status, message));
    }
    let wire: ContentsWire = response
        .json()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;

    if wire.content_type != "file" {
        return Err(GithubApiError::Api {
            status: 422,
            message: format!("Path '{}' is a {}, not a file.", path, wire.content_type),
        });
    }

    // GitHub base64 encodes with newlines; strip them before decoding.
    let cleaned = wire.content.replace(['\n', '\r'], "");
    let decoded = URL_SAFE_NO_PAD
        .decode(cleaned.as_bytes())
        .or_else(|_| {
            // Standard base64 (with padding) as fallback.
            base64::engine::general_purpose::STANDARD.decode(cleaned.as_bytes())
        })
        .map_err(|_| GithubApiError::Api {
            status: 422,
            message: "Could not decode file content from GitHub.".to_string(),
        })?;

    let truncated = decoded.len() > READ_FILE_MAX_BYTES;
    let capped = &decoded[..decoded.len().min(READ_FILE_MAX_BYTES)];
    // Lossy UTF-8: non-UTF-8 bytes become replacement characters rather than
    // failing the whole read; binary files are expected to be unreadable.
    let content = String::from_utf8_lossy(capped).into_owned();

    Ok(GithubFileContent {
        path: wire.path,
        content,
        truncated,
        encoding: wire.encoding,
        size: wire.size,
    })
}

// ----- Code search ------------------------------------------------------------

/// One code search result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubCodeSearchResult {
    pub repo_full_name: String,
    pub path: String,
    pub html_url: String,
}

#[derive(Deserialize)]
struct SearchCodeWire {
    items: Vec<SearchCodeItemWire>,
}

#[derive(Deserialize)]
struct SearchCodeItemWire {
    path: String,
    html_url: String,
    repository: SearchCodeRepoWire,
}

#[derive(Deserialize)]
struct SearchCodeRepoWire {
    full_name: String,
}

/// Search code within repositories accessible via the installation. `per_page`
/// is capped at 30.
pub async fn search_code(
    access_token: &str,
    query: &str,
    per_page: Option<u32>,
) -> Result<Vec<GithubCodeSearchResult>, GithubApiError> {
    let per_page = per_page.unwrap_or(25).min(30);
    let url = format!(
        "https://api.github.com/search/code?q={}&per_page={}",
        urlencoding::encode(query),
        per_page,
    );
    let response = github_api_request(access_token, reqwest::Method::GET, &url)
        .send()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let message = error_message_from_response(response).await;
        return Err(classify_api_error(status, message));
    }
    let result: SearchCodeWire = response
        .json()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;
    Ok(result
        .items
        .into_iter()
        .map(|item| GithubCodeSearchResult {
            repo_full_name: item.repository.full_name,
            path: item.path,
            html_url: item.html_url,
        })
        .collect())
}

// ----- Write operations -------------------------------------------------------

/// Created or updated issue returned by GitHub.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubIssueRef {
    pub number: u64,
    pub html_url: String,
}

#[derive(Deserialize)]
struct IssueRefWire {
    number: u64,
    html_url: String,
}

/// Create a new issue in a repository.
pub async fn create_issue(
    access_token: &str,
    owner: &str,
    repo: &str,
    title: &str,
    body: Option<&str>,
    labels: Option<&[String]>,
) -> Result<GithubIssueRef, GithubApiError> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/issues");
    let mut payload = serde_json::json!({ "title": title });
    if let Some(b) = body {
        payload["body"] = serde_json::json!(b);
    }
    if let Some(ls) = labels {
        payload["labels"] = serde_json::json!(ls);
    }
    let response = github_api_request(access_token, reqwest::Method::POST, &url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let message = error_message_from_response(response).await;
        return Err(classify_api_error(status, message));
    }
    let wire: IssueRefWire = response
        .json()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;
    Ok(GithubIssueRef {
        number: wire.number,
        html_url: wire.html_url,
    })
}

/// Update an existing issue's title, body, and/or labels. NEVER sends `state`:
/// closing/reopening is a launch non-goal per ADR-0036 and the PRD.
pub async fn update_issue(
    access_token: &str,
    owner: &str,
    repo: &str,
    number: u64,
    title: Option<&str>,
    body: Option<&str>,
    labels: Option<&[String]>,
) -> Result<GithubIssueRef, GithubApiError> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/issues/{number}");
    let mut payload = serde_json::json!({});
    if let Some(t) = title {
        payload["title"] = serde_json::json!(t);
    }
    if let Some(b) = body {
        payload["body"] = serde_json::json!(b);
    }
    if let Some(ls) = labels {
        payload["labels"] = serde_json::json!(ls);
    }
    let response = github_api_request(access_token, reqwest::Method::PATCH, &url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let message = error_message_from_response(response).await;
        return Err(classify_api_error(status, message));
    }
    let wire: IssueRefWire = response
        .json()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;
    Ok(GithubIssueRef {
        number: wire.number,
        html_url: wire.html_url,
    })
}

/// Add a comment to an issue or pull request. Works for both by design: GitHub
/// issue and PR comments share the same endpoint.
pub async fn add_comment(
    access_token: &str,
    owner: &str,
    repo: &str,
    number: u64,
    body: &str,
) -> Result<GithubIssueRef, GithubApiError> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/issues/{number}/comments");
    let response = github_api_request(access_token, reqwest::Method::POST, &url)
        .json(&serde_json::json!({ "body": body }))
        .send()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let message = error_message_from_response(response).await;
        return Err(classify_api_error(status, message));
    }
    // Comment response has `id` and `html_url`, not `number`. Return html_url
    // and the original issue number (which we have from the caller) so the
    // return type is consistent with create/update_issue.
    #[derive(Deserialize)]
    struct CommentRefWire {
        html_url: String,
    }
    let wire: CommentRefWire = response
        .json()
        .await
        .map_err(|e| GithubApiError::Network(e.to_string()))?;
    Ok(GithubIssueRef {
        number,
        html_url: wire.html_url,
    })
}

// ----- Tests ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_url_has_no_scope_and_no_code_challenge() {
        let url = build_auth_url(
            "client-id-123",
            "http://127.0.0.1:44751/callback",
            "state-abc",
        );
        assert!(url.starts_with("https://github.com/login/oauth/authorize?"));
        assert!(url.contains("client_id=client-id-123"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A44751%2Fcallback"));
        assert!(url.contains("state=state-abc"));
        // No scope (GitHub Apps ignore scopes on the authorize URL).
        assert!(!url.contains("scope"));
        // No PKCE (GitHub does not support it).
        assert!(!url.contains("code_challenge"));
        assert!(!url.contains("code_challenge_method"));
    }

    #[test]
    fn exchange_form_carries_client_secret_and_no_code_verifier() {
        let form = exchange_form(
            "cid",
            "csecret",
            "auth-code",
            "http://127.0.0.1:44751/callback",
        );
        assert!(form.contains(&("client_id", "cid")));
        assert!(form.contains(&("client_secret", "csecret")));
        assert!(form.contains(&("code", "auth-code")));
        // No code_verifier: this is not PKCE.
        assert!(!form.iter().any(|(k, _)| *k == "code_verifier"));
    }

    #[test]
    fn refresh_form_carries_rotation_fields() {
        let form = refresh_form("cid", "csecret", "refresh-tok");
        assert!(form.contains(&("grant_type", "refresh_token")));
        assert!(form.contains(&("refresh_token", "refresh-tok")));
        assert!(form.contains(&("client_id", "cid")));
        assert!(form.contains(&("client_secret", "csecret")));
    }

    #[test]
    fn classify_refresh_failure_bad_refresh_token_is_invalid_grant() {
        assert!(matches!(
            classify_refresh_failure(200, Some("bad_refresh_token")),
            GithubRefreshOutcome::InvalidGrant
        ));
    }

    #[test]
    fn classify_refresh_failure_other_errors_are_transient() {
        assert!(matches!(
            classify_refresh_failure(500, None),
            GithubRefreshOutcome::Transient
        ));
        assert!(matches!(
            classify_refresh_failure(400, Some("some_other_error")),
            GithubRefreshOutcome::Transient
        ));
        assert!(matches!(
            classify_refresh_failure(200, Some("invalid_grant")),
            GithubRefreshOutcome::Transient
        ));
    }

    #[test]
    fn token_response_success_check() {
        let success = GithubTokenResponse {
            access_token: "ghu_abc".to_string(),
            token_type: "bearer".to_string(),
            expires_in: None,
            refresh_token: None,
            refresh_token_expires_in: None,
            error: None,
            error_description: None,
        };
        assert!(success.is_success());

        let failure = GithubTokenResponse {
            access_token: String::new(),
            token_type: String::new(),
            expires_in: None,
            refresh_token: None,
            refresh_token_expires_in: None,
            error: Some("bad_verification_code".to_string()),
            error_description: None,
        };
        assert!(!failure.is_success());
    }

    #[test]
    fn non_expiring_token_lifetime_is_about_100_years() {
        // 100 years = 100 * 365.25 * 24 * 3600 ~ 3_155_760_000 seconds.
        // The constant is slightly below that for clarity; verify it's in the
        // right ballpark (between 95 and 105 years).
        let years = NON_EXPIRING_TOKEN_LIFETIME_SECS / (365 * 24 * 3600);
        assert!(years >= 95, "expected ~100 years, got {years}");
        assert!(years <= 105, "expected ~100 years, got {years}");
    }

    #[test]
    fn bound_body_truncates_at_max_and_reports_flag() {
        // No truncation when under the limit.
        let short = "hello".to_string();
        let (text, truncated) = bound_body(Some(short.clone()));
        assert_eq!(text.as_deref(), Some("hello"));
        assert!(!truncated);

        // Truncation at exactly the limit.
        let long: String = "x".repeat(ISSUE_BODY_MAX_CHARS + 10);
        let (text, truncated) = bound_body(Some(long));
        assert_eq!(text.map(|t| t.chars().count()), Some(ISSUE_BODY_MAX_CHARS));
        assert!(truncated);

        // None body is preserved as None.
        let (text, truncated) = bound_body(None);
        assert!(text.is_none());
        assert!(!truncated);
    }

    #[test]
    fn search_issues_result_parses_pull_request_flag() {
        // Verify the JSON shape: presence of pull_request key => is_pull_request.
        let issue_json = r#"{
            "number": 1,
            "title": "Bug",
            "state": "open",
            "repository_url": "https://api.github.com/repos/owner/repo",
            "updated_at": "2026-01-01T00:00:00Z",
            "html_url": "https://github.com/owner/repo/issues/1"
        }"#;
        let pr_json = r#"{
            "number": 2,
            "title": "Feature",
            "state": "open",
            "pull_request": {"url": "https://api.github.com/repos/owner/repo/pulls/2"},
            "repository_url": "https://api.github.com/repos/owner/repo",
            "updated_at": "2026-01-01T00:00:00Z",
            "html_url": "https://github.com/owner/repo/pull/2"
        }"#;
        let issue_wire: SearchIssueItemWire = serde_json::from_str(issue_json).unwrap();
        let pr_wire: SearchIssueItemWire = serde_json::from_str(pr_json).unwrap();
        assert!(issue_wire.pull_request.is_none());
        assert!(pr_wire.pull_request.is_some());
    }

    #[test]
    fn api_error_401_maps_to_unauthorized() {
        assert!(matches!(
            classify_api_error(401, "Bad credentials".to_string()),
            GithubApiError::Unauthorized
        ));
    }

    #[test]
    fn api_error_404_maps_to_not_found() {
        assert!(matches!(
            classify_api_error(404, "Not Found".to_string()),
            GithubApiError::NotFound
        ));
    }

    #[test]
    fn api_error_403_maps_to_forbidden() {
        assert!(matches!(
            classify_api_error(403, "Forbidden".to_string()),
            GithubApiError::Forbidden
        ));
    }

    // ----- pagination_next tests -----------------------------------------------

    #[test]
    fn pagination_next_partial_page_means_done_not_truncated() {
        // Fewer items than per_page: we've seen the last page.
        let (fetch_next, truncated) = pagination_next(42, 1, 100, 5);
        assert!(!fetch_next);
        assert!(!truncated);
    }

    #[test]
    fn pagination_next_empty_page_means_done_not_truncated() {
        let (fetch_next, truncated) = pagination_next(0, 1, 100, 5);
        assert!(!fetch_next);
        assert!(!truncated);
    }

    #[test]
    fn pagination_next_full_page_below_cap_means_continue() {
        // Full page and not yet at the cap: fetch the next page.
        let (fetch_next, truncated) = pagination_next(100, 3, 100, 5);
        assert!(fetch_next);
        assert!(!truncated);
    }

    #[test]
    fn pagination_next_full_page_at_cap_means_truncated() {
        // Full page at the safety cap: stop and signal truncation.
        let (fetch_next, truncated) = pagination_next(100, 5, 100, 5);
        assert!(!fetch_next);
        assert!(truncated);
    }

    #[test]
    fn pagination_next_full_page_on_first_page_at_cap_one_is_truncated() {
        // Edge case: cap is 1 and we got a full page.
        let (fetch_next, truncated) = pagination_next(100, 1, 100, 1);
        assert!(!fetch_next);
        assert!(truncated);
    }

    #[test]
    fn github_repository_list_serializes_camel_case_with_truncated() {
        let list = GithubRepositoryList {
            repositories: vec![GithubRepository {
                full_name: "owner/repo".to_string(),
                private: false,
                default_branch: "main".to_string(),
                html_url: "https://github.com/owner/repo".to_string(),
                description: None,
            }],
            truncated: true,
        };
        let json = serde_json::to_value(&list).unwrap();
        assert_eq!(json["truncated"], true);
        assert!(json["repositories"].is_array());
        let repo = &json["repositories"][0];
        // camelCase field names
        assert!(repo.get("fullName").is_some());
        assert!(repo.get("defaultBranch").is_some());
        assert!(repo.get("htmlUrl").is_some());
    }
}
