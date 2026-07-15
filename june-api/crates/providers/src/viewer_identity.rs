//! Resolves the caller's verified emails from OS Accounts `/me` using the
//! caller's own bearer token. The share ACL is email-based (JUN-308) while
//! the access JWT carries only `sub`, so the API asks OS Accounts which
//! verified addresses the authenticated user actually holds.

use async_trait::async_trait;
use june_domain::{DomainError, ViewerIdentity};
use serde::Deserialize;

pub struct OsAccountsViewerIdentity {
    http: reqwest::Client,
    api_url: String,
}

impl OsAccountsViewerIdentity {
    pub fn new(http: reqwest::Client, api_url: &str) -> Self {
        Self {
            http,
            api_url: api_url.trim_end_matches('/').to_string(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct Envelope {
    data: Option<MeWire>,
    success: bool,
}

// OS Accounts `/me` returns the account's addresses as `emails[]`, each tagged
// with a `verified` flag (shipped with the ADR-0011 provider-agnostic identity
// work and in production since 2026-06-02). We read only that array and keep
// only verified addresses, because the share ACL authorizes by verified email:
// an unverified address must never resolve an invite.
//
// The legacy singular `data.email` field is deliberately NOT used as a fallback.
// It carries no `verified` flag and can hold an unverified primary (e.g. a
// Stripe-collected billing address), so trusting it would let someone claim a
// share bound to an address they have not proven they own. The desktop `MeWire`
// (`src-tauri/src/os_accounts.rs`) reads only `email` because that is all it
// needs; serde ignores the `emails` it doesn't model, so that struct is no
// evidence the array is absent. If `/me` ever omitted `emails[]`, resolving to
// an empty set and failing closed with `share_not_found` is the correct, safe
// outcome for an access-control path.
#[derive(Debug, Deserialize)]
struct MeWire {
    #[serde(default)]
    emails: Vec<EmailWire>,
}

#[derive(Debug, Deserialize)]
struct EmailWire {
    email: String,
    verified: bool,
}

#[async_trait]
impl ViewerIdentity for OsAccountsViewerIdentity {
    async fn verified_emails(&self, access_token: &str) -> Result<Vec<String>, DomainError> {
        let url = format!("{}/me", self.api_url);
        let response = self
            .http
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| {
                tracing::error!(%error, %url, "viewer identity: /me transport error");
                DomainError::MeteringProvider
            })?;
        let status = response.status();
        if !status.is_success() {
            tracing::warn!(%status, %url, "viewer identity: /me non-success");
            return Err(DomainError::MeteringProvider);
        }
        let envelope: Envelope = response.json().await.map_err(|error| {
            tracing::error!(%error, %url, "viewer identity: /me parse failed");
            DomainError::MeteringProvider
        })?;
        let me = envelope
            .data
            .filter(|_| envelope.success)
            .ok_or(DomainError::MeteringProvider)?;
        Ok(me
            .emails
            .into_iter()
            .filter(|email| email.verified)
            .map(|email| email.email.trim().to_ascii_lowercase())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::OsAccountsViewerIdentity;
    use crate::http;
    use june_domain::ViewerIdentity;
    use pretty_assertions::assert_eq;
    use serde_json::json;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{header, method, path},
    };

    #[tokio::test]
    async fn returns_only_verified_emails_lowercased() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/me"))
            .and(header("authorization", "Bearer user_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "success": true,
                "data": {
                    "id": "usr_1",
                    "emails": [
                        { "email": "Jun@Example.com", "verified": true, "is_primary": true },
                        { "email": "unverified@example.com", "verified": false, "is_primary": false }
                    ]
                }
            })))
            .mount(&server)
            .await;
        let identity = OsAccountsViewerIdentity::new(http::default_client(), &server.uri());

        let emails = identity
            .verified_emails("user_token")
            .await
            .expect("emails resolve");

        assert_eq!(emails, vec!["jun@example.com".to_string()]);
    }
}
