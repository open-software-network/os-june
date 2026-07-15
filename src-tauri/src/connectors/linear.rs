//! Linear native-app OAuth and the fixed GraphQL documents slice 1 needs.
//!
//! Linear is a PKCE-only PUBLIC client: unlike Google's Desktop credential,
//! no client secret exists anywhere in this flow - the token endpoint marks
//! it optional for PKCE and June never sends one (see
//! docs/plugins/linear-oauth-spike.md). The browser handoff itself is the
//! shared [`oauth::loopback_authorize`] primitive; this module owns Linear's
//! auth-URL shape (COMMA-joined scopes, explicit `actor=user` - v1
//! deliberately uses the user actor so grants inherit the authorizing user's
//! team visibility, never the app actor's all-teams view), the secretless
//! token exchange and refresh, revocation, and the two GraphQL documents the
//! connect flow needs: viewer/organization identity and the Teams listing.
//!
//! Refresh responses rotate the refresh token on every success; callers
//! persist the rotated token when present and keep the old one otherwise
//! (same logic as Google). Rate limiting arrives as HTTP 400 with a
//! `RATELIMITED` error code in the GraphQL errors array, not as HTTP 429.
//!
//! NEVER log, print, or serialize tokens (or authorization codes) into
//! errors. Error messages carry stable codes and short human text only.

use crate::domain::types::AppError;
use serde::{de::DeserializeOwned, Deserialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

use super::oauth::{self, ConnectFlow};

const AUTH_ENDPOINT: &str = "https://linear.app/oauth/authorize";
const TOKEN_ENDPOINT: &str = "https://api.linear.app/oauth/token";
const REVOKE_ENDPOINT: &str = "https://api.linear.app/oauth/revoke";
const GRAPHQL_ENDPOINT: &str = "https://api.linear.app/graphql";
const API_ERROR_MESSAGE_MAX_LEN: usize = 200;
/// Teams pagination hard cap: 5 pages of 100 covers 500 teams, far beyond
/// any workspace June plausibly serves; the cap bounds a pathological or
/// adversarial cursor loop.
const TEAMS_PAGE_SIZE: u32 = 100;
const TEAMS_MAX_PAGES: usize = 5;

/// Token endpoint response. Secret fields zeroize on drop.
#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct LinearTokenResponse {
    pub access_token: String,
    /// Present on the initial exchange and (rotated) on every refresh; may
    /// be absent on a scope escalation for an already-connected workspace,
    /// in which case callers keep the one in custody.
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[zeroize(skip)]
    pub expires_in: i64,
    /// The granted scope set. Linear's separator is not contractual, so
    /// callers parse it with [`parse_scope_field`] (commas or whitespace).
    #[serde(default)]
    #[zeroize(skip)]
    pub scope: Option<String>,
}

/// Split a token response `scope` field into individual scopes. Accepts
/// comma- and whitespace-separated forms (and mixtures) because Linear's
/// exact separator is not contractual; empty fragments are dropped.
pub fn parse_scope_field(raw: &str) -> Vec<String> {
    raw.split(|c: char| c.is_whitespace() || c == ',')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

/// Who authorized, and for which workspace. The workspace id keys the
/// keychain entry and the DB index row (NOT the email: a Linear account is a
/// workspace grant, and the email may legitimately be empty). Carries no
/// token material, so deriving `Debug` is safe.
#[derive(Debug, Clone)]
pub struct LinearIdentity {
    pub workspace_id: String,
    pub workspace_name: String,
    pub workspace_url_key: String,
    pub user_id: String,
    pub user_name: String,
    /// Lowercased and trimmed; may be empty (kept as-is, never substituted).
    pub user_email: String,
}

/// Outcome of the full browser handoff: granted tokens plus the identity
/// resolved with the fresh access token.
pub struct LinearAuthorizedGrant {
    pub tokens: LinearTokenResponse,
    pub identity: LinearIdentity,
}

#[derive(Deserialize)]
struct TokenErrorBody {
    #[serde(default)]
    error: Option<String>,
}

/// Mirrors `oauth::RefreshOutcome`, which hard-codes the Google token type;
/// a Linear-local enum beats contorting the Google one.
pub enum LinearRefreshOutcome {
    Refreshed(LinearTokenResponse),
    /// Definitive: the grant was revoked or expired. The workspace must be
    /// reconnected; retrying cannot help.
    InvalidGrant,
    /// Upstream wobble (5xx, 429, network error): worth a bounded retry.
    Transient,
}

/// Run the full Linear authorization handoff: open the consent screen in the
/// default browser, wait on the loopback listener for the redirect, exchange
/// the code (no client secret), and resolve the workspace identity with the
/// fresh access token. A thin Linear-specific wrapper over
/// [`oauth::loopback_authorize`], parallel to the Google `oauth::authorize`.
pub async fn authorize(
    flow: &ConnectFlow,
    client_id: &str,
    scopes: &[&str],
    loopback_ports: &[u16],
) -> Result<LinearAuthorizedGrant, AppError> {
    // Fixed candidate ports, not an ephemeral one: Linear matches the
    // registered callback URL exactly (port included), so the redirect URI
    // must be one whose URL is registered on the OAuth application.
    let authorization = oauth::loopback_authorize(
        flow,
        "Linear",
        oauth::LoopbackPort::Candidates(loopback_ports.to_vec()),
        |redirect_uri, code_challenge, state| {
            build_auth_url(client_id, redirect_uri, scopes, code_challenge, state)
        },
    )
    .await?;

    let tokens = exchange_code(
        client_id,
        &authorization.code,
        &authorization.verifier,
        &authorization.redirect_uri,
    )
    .await?;
    let identity = fetch_identity(&tokens.access_token).await?;
    Ok(LinearAuthorizedGrant { tokens, identity })
}

fn build_auth_url(
    client_id: &str,
    redirect_uri: &str,
    scopes: &[&str],
    code_challenge: &str,
    state: &str,
) -> String {
    // Scopes are COMMA-joined (Linear's documented form, unlike Google's
    // spaces). `actor=user` is the default but stated explicitly: v1
    // deliberately authorizes as the user, never the app actor (see the
    // spike doc - app actor needs a secret and sees every public team).
    format!(
        "{AUTH_ENDPOINT}?client_id={}&redirect_uri={}&response_type=code&scope={}\
         &state={}&code_challenge={}&code_challenge_method=S256&actor=user",
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(&scopes.join(",")),
        urlencoding::encode(state),
        urlencoding::encode(code_challenge),
    )
}

/// Exchange the authorization code for tokens. PKCE only: the form carries
/// NO client_secret (public client), the verifier is the whole proof.
async fn exchange_code(
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<LinearTokenResponse, AppError> {
    let response = oauth::http_client()
        .post(TOKEN_ENDPOINT)
        .form(&authorization_code_form(
            client_id,
            code,
            verifier,
            redirect_uri,
        ))
        .send()
        .await
        .map_err(|_| exchange_failed(None))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| exchange_failed(None))?;
    if let Ok(tokens) = serde_json::from_str::<LinearTokenResponse>(&body) {
        if !tokens.access_token.is_empty() {
            return Ok(tokens);
        }
    }
    // Never echo the body: it could carry partial token material. Surface
    // the OAuth error code word only.
    let error_code = serde_json::from_str::<TokenErrorBody>(&body)
        .ok()
        .and_then(|body| body.error);
    tracing::warn!(status, error_code = ?error_code, "linear token exchange failed");
    Err(exchange_failed(error_code))
}

fn authorization_code_form<'a>(
    client_id: &'a str,
    code: &'a str,
    verifier: &'a str,
    redirect_uri: &'a str,
) -> [(&'static str, &'a str); 5] {
    [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", client_id),
        ("code_verifier", verifier),
    ]
}

fn exchange_failed(error_code: Option<String>) -> AppError {
    let message = match error_code {
        Some(code) => format!("Could not complete the Linear connection ({code})."),
        None => "Could not complete the Linear connection.".to_string(),
    };
    AppError::new("connector_token_exchange_failed", message)
}

/// One refresh attempt. Classifies invalid_grant (definitive, the workspace
/// must be reconnected) apart from transient upstream wobble. On success the
/// response ALWAYS carries a rotated refresh token; the caller persists it.
pub async fn refresh(client_id: &str, refresh_token: &str) -> LinearRefreshOutcome {
    let response = match oauth::http_client()
        .post(TOKEN_ENDPOINT)
        .form(&refresh_form(client_id, refresh_token))
        .send()
        .await
    {
        Ok(response) => response,
        // No response at all: DNS, connection reset, timeout. Always transient.
        Err(_) => return LinearRefreshOutcome::Transient,
    };
    let status = response.status().as_u16();
    let body = match response.text().await {
        Ok(body) => body,
        Err(_) => return LinearRefreshOutcome::Transient,
    };
    if let Ok(tokens) = serde_json::from_str::<LinearTokenResponse>(&body) {
        if !tokens.access_token.is_empty() {
            return LinearRefreshOutcome::Refreshed(tokens);
        }
    }
    let error_code = serde_json::from_str::<TokenErrorBody>(&body)
        .ok()
        .and_then(|body| body.error);
    classify_refresh_failure(status, error_code.as_deref())
}

fn refresh_form<'a>(client_id: &'a str, refresh_token: &'a str) -> [(&'static str, &'a str); 3] {
    [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
    ]
}

/// `invalid_grant` is the definitive "grant revoked/expired" signal; anything
/// else (5xx, 429, even invalid_client) is treated as transient so a config
/// hiccup never flips a workspace into the reconnect state. Mirrors the
/// Google classification in oauth.rs.
fn classify_refresh_failure(status: u16, error_code: Option<&str>) -> LinearRefreshOutcome {
    // Log status + error code word only; never the body or tokens.
    tracing::warn!(status, error_code = ?error_code, "linear token refresh failed");
    match error_code {
        Some("invalid_grant") => LinearRefreshOutcome::InvalidGrant,
        _ => LinearRefreshOutcome::Transient,
    }
}

/// Best-effort revocation of the grant at Linear (used by
/// `disconnect(revoke_grant = true)`). Linear answers 200 on revocation and
/// 400 when the token was already revoked; both leave the grant dead, so
/// both count as success. Other failures are swallowed after logging the
/// HTTP status: local custody removal is the real disconnect.
pub async fn revoke(token: &str) -> bool {
    match oauth::http_client()
        .post(REVOKE_ENDPOINT)
        .form(&[("token", token)])
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status().as_u16();
            let ok = response.status().is_success() || status == 400;
            if !ok {
                tracing::warn!(status, "linear revoke failed");
            }
            ok
        }
        Err(_) => {
            tracing::warn!("linear revoke request failed");
            false
        }
    }
}

// --- GraphQL -------------------------------------------------------------------

#[derive(Debug)]
pub enum LinearApiError {
    /// The access token was rejected. The caller should refresh and retry
    /// once before surfacing an error.
    Unauthorized,
    /// Linear's request/complexity budget is exhausted (HTTP 400 with the
    /// `RATELIMITED` error code, per the rate-limiting docs).
    RateLimited,
    Api {
        status: u16,
        message: String,
    },
    Network(String),
}

impl From<LinearApiError> for AppError {
    fn from(error: LinearApiError) -> Self {
        match error {
            LinearApiError::Unauthorized => AppError::new(
                "linear_unauthorized",
                "Linear rejected the connection's access token.",
            ),
            LinearApiError::RateLimited => AppError::new(
                "linear_rate_limited",
                "Linear is rate limiting requests. Try again in a few minutes.",
            ),
            LinearApiError::Api { status, message } => AppError::new(
                "linear_api_error",
                format!("Linear API request failed ({status}): {message}"),
            ),
            LinearApiError::Network(message) => AppError::new("network_error", message),
        }
    }
}

#[derive(Deserialize)]
struct GraphqlResponseWire<T> {
    // Missing `data` reads as None (serde treats Option fields as optional);
    // no `default` attribute, which would wrongly demand `T: Default`.
    data: Option<T>,
    #[serde(default)]
    errors: Vec<GraphqlErrorWire>,
}

#[derive(Deserialize)]
struct GraphqlErrorWire {
    #[serde(default)]
    message: String,
    #[serde(default)]
    extensions: Option<GraphqlErrorExtensionsWire>,
}

#[derive(Deserialize)]
struct GraphqlErrorExtensionsWire {
    #[serde(default)]
    code: Option<String>,
    /// Linear also tags errors with a human category here (e.g.
    /// "authentication error"); carried because auth failures are not
    /// guaranteed to arrive as HTTP 401.
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

/// Shared GraphQL POST for the identity and teams documents. HTTP 401 maps
/// to `Unauthorized`; a `RATELIMITED` code anywhere in the errors array maps
/// to `RateLimited`; any other GraphQL error surfaces the first message
/// (bounded). Never logs or echoes the access token.
async fn graphql<T: DeserializeOwned>(
    access_token: &str,
    query: &str,
    variables: serde_json::Value,
) -> Result<T, LinearApiError> {
    let response = oauth::http_client()
        .post(GRAPHQL_ENDPOINT)
        .bearer_auth(access_token)
        .json(&serde_json::json!({ "query": query, "variables": variables }))
        .send()
        .await
        .map_err(|e| LinearApiError::Network(e.to_string()))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|e| LinearApiError::Network(e.to_string()))?;
    if status == 401 {
        return Err(LinearApiError::Unauthorized);
    }
    let parsed: GraphqlResponseWire<T> =
        serde_json::from_str(&body).map_err(|e| LinearApiError::Api {
            status,
            message: format!("unexpected response shape: {e}"),
        })?;
    check_graphql_errors(&parsed.errors, status)?;
    if !(200..300).contains(&status) {
        return Err(LinearApiError::Api {
            status,
            message: "request failed".to_string(),
        });
    }
    parsed.data.ok_or(LinearApiError::Api {
        status,
        message: "response carried no data".to_string(),
    })
}

/// Classify a GraphQL errors array: `RATELIMITED` (checked in both
/// `extensions.code` and the message, since the docs only guarantee the code
/// word appears) beats a generic API failure; the first error's message is
/// surfaced, bounded, never the raw body.
fn check_graphql_errors(errors: &[GraphqlErrorWire], status: u16) -> Result<(), LinearApiError> {
    if errors.is_empty() {
        return Ok(());
    }
    // Linear signals failures through GraphQL error codes rather than
    // semantic HTTP statuses (rate limiting arrives as HTTP 400), so a
    // revoked or invalid token cannot be assumed to arrive as HTTP 401
    // either: classify an authentication-flavored code or type as
    // Unauthorized so the callers' refresh-and-retry and the
    // reconnect_required transition still fire.
    let unauthorized = errors.iter().any(|error| {
        error.extensions.as_ref().is_some_and(|extensions| {
            extensions
                .code
                .as_deref()
                .is_some_and(|code| code.to_ascii_uppercase().contains("AUTHENTICATION"))
                || extensions
                    .kind
                    .as_deref()
                    .is_some_and(|kind| kind.to_ascii_lowercase().contains("authentication"))
        })
    });
    if unauthorized {
        return Err(LinearApiError::Unauthorized);
    }
    let rate_limited = errors.iter().any(|error| {
        error
            .extensions
            .as_ref()
            .and_then(|extensions| extensions.code.as_deref())
            == Some("RATELIMITED")
            || error.message.contains("RATELIMITED")
    });
    if rate_limited {
        return Err(LinearApiError::RateLimited);
    }
    let message = errors
        .first()
        .map(|error| {
            error
                .message
                .chars()
                .take(API_ERROR_MESSAGE_MAX_LEN)
                .collect()
        })
        .unwrap_or_else(|| "request failed".to_string());
    Err(LinearApiError::Api { status, message })
}

// --- Identity --------------------------------------------------------------------

const IDENTITY_QUERY: &str = "{ viewer { id name email } organization { id name urlKey } }";

#[derive(Deserialize)]
struct IdentityDataWire {
    #[serde(default)]
    viewer: Option<ViewerWire>,
    #[serde(default)]
    organization: Option<OrganizationWire>,
}

#[derive(Deserialize)]
struct ViewerWire {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    email: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrganizationWire {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    url_key: String,
}

fn identity_failed() -> AppError {
    AppError::new(
        "connector_identity_failed",
        "Could not determine the Linear workspace.",
    )
}

/// Resolve the workspace + user identity that keys custody and the DB index.
/// Any transport or API failure maps to the identity error (mirroring how
/// Google's email resolution reports): during a connect there is nothing
/// more actionable to say.
async fn fetch_identity(access_token: &str) -> Result<LinearIdentity, AppError> {
    let data: IdentityDataWire = graphql(access_token, IDENTITY_QUERY, serde_json::json!({}))
        .await
        .map_err(|_| identity_failed())?;
    identity_from_data(data)
}

/// Pure mapping from the identity document's data to [`LinearIdentity`].
/// Workspace and viewer ids are load-bearing (custody key, actor
/// attribution) and must be present; name/urlKey/email may be empty and are
/// carried as-is - the email is NOT substituted with the user name, because
/// the account is keyed by workspace id, not email.
fn identity_from_data(data: IdentityDataWire) -> Result<LinearIdentity, AppError> {
    let viewer = data.viewer.ok_or_else(identity_failed)?;
    let organization = data.organization.ok_or_else(identity_failed)?;
    if viewer.id.is_empty() || organization.id.is_empty() {
        return Err(identity_failed());
    }
    Ok(LinearIdentity {
        workspace_id: organization.id,
        workspace_name: organization.name,
        workspace_url_key: organization.url_key,
        user_id: viewer.id,
        user_name: viewer.name,
        user_email: viewer.email.trim().to_ascii_lowercase(),
    })
}

// --- Teams -----------------------------------------------------------------------

/// One team as offered to the selection UI. The GraphQL node shape (id, key,
/// name) deserializes directly.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct LinearTeam {
    pub id: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub name: String,
}

const TEAMS_QUERY: &str = "query Teams($after: String) { teams(first: 100, after: $after) \
     { nodes { id key name } pageInfo { hasNextPage endCursor } } }";

#[derive(Deserialize)]
struct TeamsDataWire {
    teams: TeamsPageWire,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamsPageWire {
    #[serde(default)]
    nodes: Vec<LinearTeam>,
    page_info: PageInfoWire,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfoWire {
    #[serde(default)]
    has_next_page: bool,
    #[serde(default)]
    end_cursor: Option<String>,
}

/// Pure page-fold for the Teams query, so the merge, the page cap, and the
/// final ordering are unit-testable without HTTP.
struct TeamsPager {
    teams: Vec<LinearTeam>,
    pages: usize,
    truncated: bool,
}

impl TeamsPager {
    fn new() -> Self {
        TeamsPager {
            teams: Vec::new(),
            pages: 0,
            truncated: false,
        }
    }

    /// Fold one page in. Returns the `after` cursor for the next request, or
    /// `None` when pagination is complete - either no further page exists or
    /// the hard cap was reached (recorded as truncation).
    fn absorb(&mut self, page: TeamsPageWire) -> Option<String> {
        self.pages += 1;
        self.teams.extend(page.nodes);
        if !page.page_info.has_next_page {
            return None;
        }
        if self.pages >= TEAMS_MAX_PAGES {
            self.truncated = true;
            return None;
        }
        page.page_info
            .end_cursor
            .filter(|cursor| !cursor.is_empty())
    }

    /// The accumulated teams sorted by name, case-insensitively (stable, so
    /// equal names keep their arrival order), plus whether the cap truncated
    /// the listing.
    fn finish(self) -> (Vec<LinearTeam>, bool) {
        let mut teams = self.teams;
        teams.sort_by_key(|team| team.name.to_lowercase());
        (teams, self.truncated)
    }
}

/// A teams listing plus whether the pagination cap cut it short. The flag
/// travels to the UI: a silently incomplete list would present itself as
/// the complete team inventory in a very large workspace.
pub struct LinearTeamsListing {
    pub teams: Vec<LinearTeam>,
    pub truncated: bool,
}

/// List the workspace's teams for the selection UI: pages of 100, hard cap
/// [`TEAMS_MAX_PAGES`] pages (a warn is logged and the listing is flagged if
/// the cap truncates), sorted by name case-insensitively.
pub async fn list_teams(access_token: &str) -> Result<LinearTeamsListing, LinearApiError> {
    let mut pager = TeamsPager::new();
    let mut after: Option<String> = None;
    loop {
        let data: TeamsDataWire = graphql(
            access_token,
            TEAMS_QUERY,
            serde_json::json!({ "after": after }),
        )
        .await?;
        after = pager.absorb(data.teams);
        if after.is_none() {
            break;
        }
    }
    let (teams, truncated) = pager.finish();
    if truncated {
        tracing::warn!(
            page_cap = TEAMS_MAX_PAGES,
            page_size = TEAMS_PAGE_SIZE,
            "linear teams listing truncated at the pagination cap"
        );
    }
    Ok(LinearTeamsListing { teams, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_url_carries_pkce_public_client_params() {
        let url = build_auth_url(
            "client-123",
            "http://127.0.0.1:49152/callback",
            &["read", "write"],
            "challenge",
            "csrf-state",
        );
        assert!(url.starts_with("https://linear.app/oauth/authorize?"));
        assert!(url.contains("client_id=client-123"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fcallback"));
        assert!(url.contains("response_type=code"));
        // Scopes are comma-joined (encoded comma), never space-joined.
        assert!(url.contains("scope=read%2Cwrite"));
        assert!(url.contains("state=csrf-state"));
        assert!(url.contains("code_challenge=challenge"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("actor=user"));
        // Public client: no secret in the authorization request.
        assert!(!url.contains("client_secret"));
    }

    #[test]
    fn token_forms_carry_no_client_secret() {
        let exchange = authorization_code_form(
            "public-id",
            "authorization-code",
            "pkce-verifier",
            "http://127.0.0.1:49152/callback",
        );
        assert!(exchange.contains(&("client_id", "public-id")));
        assert!(exchange.contains(&("code_verifier", "pkce-verifier")));
        assert!(exchange.iter().all(|(key, _)| *key != "client_secret"));

        let refresh = refresh_form("public-id", "refresh-token");
        assert!(refresh.contains(&("client_id", "public-id")));
        assert!(refresh.contains(&("refresh_token", "refresh-token")));
        assert!(refresh.iter().all(|(key, _)| *key != "client_secret"));
    }

    #[test]
    fn parse_scope_field_accepts_commas_spaces_and_mixtures() {
        assert_eq!(parse_scope_field("read,write"), vec!["read", "write"]);
        assert_eq!(parse_scope_field("read write"), vec!["read", "write"]);
        assert_eq!(
            parse_scope_field(" read, write ,,  issues:create "),
            vec!["read", "write", "issues:create"]
        );
        assert!(parse_scope_field("").is_empty());
        assert!(parse_scope_field(" , ,").is_empty());
    }

    #[test]
    fn graphql_auth_errors_classify_as_unauthorized_at_any_status() {
        // Linear signals failures through GraphQL error codes rather than
        // semantic HTTP statuses, so an auth failure must classify as
        // Unauthorized even when it arrives as HTTP 400/200.
        let errors: Vec<GraphqlErrorWire> = serde_json::from_str(
            r#"[{"message":"Authentication required","extensions":{"code":"AUTHENTICATION_ERROR"}}]"#,
        )
        .expect("errors parse");
        assert!(matches!(
            check_graphql_errors(&errors, 400),
            Err(LinearApiError::Unauthorized)
        ));
        let errors: Vec<GraphqlErrorWire> = serde_json::from_str(
            r#"[{"message":"boom","extensions":{"type":"authentication error"}}]"#,
        )
        .expect("errors parse");
        assert!(matches!(
            check_graphql_errors(&errors, 200),
            Err(LinearApiError::Unauthorized)
        ));
        // A non-auth error at HTTP 400 still classifies as a plain API error.
        let errors: Vec<GraphqlErrorWire> =
            serde_json::from_str(r#"[{"message":"boom","extensions":{"code":"INTERNAL_ERROR"}}]"#)
                .expect("errors parse");
        assert!(matches!(
            check_graphql_errors(&errors, 400),
            Err(LinearApiError::Api { status: 400, .. })
        ));
    }

    #[test]
    fn refresh_failure_classification() {
        assert!(matches!(
            classify_refresh_failure(400, Some("invalid_grant")),
            LinearRefreshOutcome::InvalidGrant
        ));
        assert!(matches!(
            classify_refresh_failure(500, None),
            LinearRefreshOutcome::Transient
        ));
        assert!(matches!(
            classify_refresh_failure(429, Some("rate_limited")),
            LinearRefreshOutcome::Transient
        ));
        assert!(matches!(
            classify_refresh_failure(400, Some("invalid_client")),
            LinearRefreshOutcome::Transient
        ));
    }

    #[test]
    fn identity_parses_and_normalizes_the_email() {
        let data: IdentityDataWire = serde_json::from_str(
            r#"{
                "viewer": { "id": "user-1", "name": "Ada", "email": " Ada@Example.COM " },
                "organization": { "id": "org-1", "name": "Acme", "urlKey": "acme" }
            }"#,
        )
        .expect("fixture");
        let identity = identity_from_data(data).expect("identity");
        assert_eq!(identity.workspace_id, "org-1");
        assert_eq!(identity.workspace_name, "Acme");
        assert_eq!(identity.workspace_url_key, "acme");
        assert_eq!(identity.user_id, "user-1");
        assert_eq!(identity.user_name, "Ada");
        assert_eq!(identity.user_email, "ada@example.com");
    }

    #[test]
    fn identity_requires_workspace_and_viewer_ids_but_not_email() {
        // Missing organization: no workspace to key custody by.
        let data: IdentityDataWire =
            serde_json::from_str(r#"{ "viewer": { "id": "user-1" } }"#).expect("fixture");
        let error = identity_from_data(data).unwrap_err();
        assert_eq!(error.code, "connector_identity_failed");

        // Empty viewer id is as unusable as a missing viewer.
        let data: IdentityDataWire = serde_json::from_str(
            r#"{ "viewer": { "id": "" }, "organization": { "id": "org-1" } }"#,
        )
        .expect("fixture");
        assert_eq!(
            identity_from_data(data).unwrap_err().code,
            "connector_identity_failed"
        );

        // An empty email is fine: the account is keyed by workspace id.
        let data: IdentityDataWire = serde_json::from_str(
            r#"{ "viewer": { "id": "user-1" }, "organization": { "id": "org-1" } }"#,
        )
        .expect("fixture");
        let identity = identity_from_data(data).expect("identity");
        assert_eq!(identity.user_email, "");
    }

    fn team(name: &str) -> LinearTeam {
        LinearTeam {
            id: format!("id-{name}"),
            key: name.to_uppercase(),
            name: name.to_string(),
        }
    }

    fn page(names: &[&str], has_next: bool, cursor: Option<&str>) -> TeamsPageWire {
        TeamsPageWire {
            nodes: names.iter().map(|name| team(name)).collect(),
            page_info: PageInfoWire {
                has_next_page: has_next,
                end_cursor: cursor.map(str::to_string),
            },
        }
    }

    #[test]
    fn teams_pager_merges_pages_and_sorts_case_insensitively() {
        let mut pager = TeamsPager::new();
        assert_eq!(
            pager.absorb(page(&["zeta", "Alpha"], true, Some("c1"))),
            Some("c1".to_string())
        );
        assert_eq!(pager.absorb(page(&["beta"], false, None)), None);
        let (teams, truncated) = pager.finish();
        assert!(!truncated);
        let names: Vec<&str> = teams.iter().map(|team| team.name.as_str()).collect();
        assert_eq!(names, vec!["Alpha", "beta", "zeta"]);
    }

    #[test]
    fn teams_pager_stops_at_the_page_cap_and_reports_truncation() {
        let mut pager = TeamsPager::new();
        for index in 0..TEAMS_MAX_PAGES - 1 {
            let cursor = format!("c{index}");
            assert_eq!(
                pager.absorb(page(&["team"], true, Some(&cursor))),
                Some(cursor)
            );
        }
        // The capping page still claims more data, but the pager refuses.
        assert_eq!(pager.absorb(page(&["team"], true, Some("more"))), None);
        let (teams, truncated) = pager.finish();
        assert!(truncated);
        assert_eq!(teams.len(), TEAMS_MAX_PAGES);
    }

    #[test]
    fn teams_pager_treats_a_missing_cursor_as_the_end() {
        // hasNextPage with no cursor cannot be followed; stop rather than
        // loop on a request that would replay the same page.
        let mut pager = TeamsPager::new();
        assert_eq!(pager.absorb(page(&["team"], true, None)), None);
        let (_, truncated) = pager.finish();
        assert!(!truncated);
    }

    #[test]
    fn graphql_error_classification() {
        // Empty errors array: not an error.
        assert!(check_graphql_errors(&[], 200).is_ok());

        // RATELIMITED via extensions.code.
        let errors: Vec<GraphqlErrorWire> = serde_json::from_str(
            r#"[{ "message": "Rate limit exceeded", "extensions": { "code": "RATELIMITED" } }]"#,
        )
        .expect("fixture");
        assert!(matches!(
            check_graphql_errors(&errors, 400),
            Err(LinearApiError::RateLimited)
        ));

        // RATELIMITED mentioned only in the message still classifies.
        let errors: Vec<GraphqlErrorWire> =
            serde_json::from_str(r#"[{ "message": "RATELIMITED: slow down" }]"#).expect("fixture");
        assert!(matches!(
            check_graphql_errors(&errors, 400),
            Err(LinearApiError::RateLimited)
        ));

        // Anything else surfaces the first message, bounded to the cap.
        let long_message = "x".repeat(API_ERROR_MESSAGE_MAX_LEN + 50);
        let errors = vec![GraphqlErrorWire {
            message: long_message,
            extensions: None,
        }];
        match check_graphql_errors(&errors, 400) {
            Err(LinearApiError::Api { status, message }) => {
                assert_eq!(status, 400);
                assert_eq!(message.len(), API_ERROR_MESSAGE_MAX_LEN);
            }
            other => panic!("expected Api error, got {other:?}"),
        }
    }

    #[test]
    fn api_errors_map_to_stable_app_error_codes() {
        assert_eq!(
            AppError::from(LinearApiError::Unauthorized).code,
            "linear_unauthorized"
        );
        assert_eq!(
            AppError::from(LinearApiError::RateLimited).code,
            "linear_rate_limited"
        );
        assert_eq!(
            AppError::from(LinearApiError::Api {
                status: 400,
                message: "bad".to_string()
            })
            .code,
            "linear_api_error"
        );
        assert_eq!(
            AppError::from(LinearApiError::Network("down".to_string())).code,
            "network_error"
        );
    }
}
