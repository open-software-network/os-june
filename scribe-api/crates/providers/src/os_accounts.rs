use async_trait::async_trait;
use scribe_config::OsAccountsConfig;
use scribe_domain::{
    Authorization, AuthorizeRequest, ChargeRequest, Credits, DomainError, OsAccountsClient, Receipt,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const ERR_INSUFFICIENT_CREDITS: i64 = 4301;
// OS Accounts returns this when a charge is replayed with the same
// idempotency key. It means the note was already settled, so it is a
// success signal — not a failure. Surface it as an idempotent replay so a
// retry of an already-charged note returns its transcript instead of 502ing.
const ERR_IDEMPOTENCY_KEY_COLLISION: i64 = 4001;
const CHARGE_RETRY_ATTEMPTS: u32 = 2;
const CHARGE_RETRY_BACKOFF: Duration = Duration::from_millis(250);

pub struct OsAccountsHttpClient {
    http: reqwest::Client,
    api_url: String,
    app_api_key: String,
}

impl OsAccountsHttpClient {
    pub fn from_config(http: reqwest::Client, config: &OsAccountsConfig) -> Self {
        Self::new(http, &config.api_url, &config.app_api_key)
    }

    pub fn new(http: reqwest::Client, api_url: &str, app_api_key: &str) -> Self {
        Self {
            http,
            api_url: api_url.trim_end_matches('/').to_string(),
            app_api_key: app_api_key.to_string(),
        }
    }
}

#[async_trait]
impl OsAccountsClient for OsAccountsHttpClient {
    async fn authorize(&self, request: AuthorizeRequest) -> Result<Authorization, DomainError> {
        let url = format!("{}/authorize", self.api_url);
        let body = AuthorizeWireRequest::from(request);
        let response = self
            .http
            .post(&url)
            .bearer_auth(&self.app_api_key)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                tracing::error!(%error, %url, "os_accounts: authorize transport error");
                DomainError::UpstreamProvider
            })?;
        let status = response.status();
        if status.is_server_error() {
            let body = response.text().await.unwrap_or_default();
            tracing::error!(%status, %url, body_bytes = body.len(), "os_accounts: authorize server error");
            return Err(DomainError::UpstreamProvider);
        }
        let raw = response.text().await.map_err(|error| {
            tracing::error!(%error, %url, "os_accounts: authorize body read failed");
            DomainError::UpstreamProvider
        })?;
        let envelope: Envelope<AuthorizationWire> = serde_json::from_str(&raw).map_err(|error| {
            tracing::error!(%error, %url, body_bytes = raw.len(), "os_accounts: authorize JSON parse failed");
            DomainError::UpstreamProvider
        })?;
        if envelope.success {
            let authorization = envelope
                .data
                .map(Authorization::from)
                .ok_or_else(|| {
                    tracing::error!(%url, body_bytes = raw.len(), "os_accounts: authorize success envelope missing data");
                    DomainError::UpstreamProvider
                })?;
            tracing::info!(
                %url,
                allowed = authorization.allowed,
                has_action_token = authorization.action_token.is_some(),
                cap_credits = ?authorization.cap_credits,
                reason = ?authorization.reason,
                "os_accounts: authorize success"
            );
            return Ok(authorization);
        }
        if envelope.error_code == Some(ERR_INSUFFICIENT_CREDITS) {
            return Ok(Authorization {
                allowed: false,
                action_token: None,
                cap_credits: None,
                reason: Some("insufficient_available_balance".to_string()),
            });
        }
        tracing::error!(
            %status,
            %url,
            body_bytes = raw.len(),
            error_code = ?envelope.error_code,
            "os_accounts: authorize denied"
        );
        Err(DomainError::UpstreamProvider)
    }

    async fn charge(&self, request: ChargeRequest) -> Result<Receipt, DomainError> {
        let url = format!("{}/charge", self.api_url);
        let body = ChargeWireRequest::from(request);
        for attempt in 0..CHARGE_RETRY_ATTEMPTS {
            match self.charge_once(&url, &body).await {
                Ok(receipt) => return Ok(receipt),
                Err(ChargeError::Retryable) if attempt + 1 < CHARGE_RETRY_ATTEMPTS => {
                    tokio::time::sleep(CHARGE_RETRY_BACKOFF).await;
                }
                Err(ChargeError::Retryable) => return Err(DomainError::UpstreamProvider),
                Err(ChargeError::Domain(error)) => return Err(error),
            }
        }
        Err(DomainError::UpstreamProvider)
    }
}

impl OsAccountsHttpClient {
    async fn charge_once(
        &self,
        url: &str,
        body: &ChargeWireRequest,
    ) -> Result<Receipt, ChargeError> {
        let response = self
            .http
            .post(url)
            .bearer_auth(&self.app_api_key)
            .json(body)
            .send()
            .await
            .map_err(|error| {
                tracing::error!(%error, %url, "os_accounts: charge transport error");
                ChargeError::Retryable
            })?;
        let status = response.status();
        if status.is_server_error() {
            let body = response.text().await.unwrap_or_default();
            tracing::error!(%status, %url, body_bytes = body.len(), "os_accounts: charge server error (retryable)");
            return Err(ChargeError::Retryable);
        }
        let raw = response.text().await.map_err(|error| {
            tracing::error!(%error, %url, "os_accounts: charge body read failed");
            ChargeError::Domain(DomainError::UpstreamProvider)
        })?;
        let envelope: Envelope<ReceiptWire> = serde_json::from_str(&raw).map_err(|error| {
            tracing::error!(%error, %url, body_bytes = raw.len(), "os_accounts: charge JSON parse failed");
            ChargeError::Domain(DomainError::UpstreamProvider)
        })?;
        if envelope.success {
            return envelope
                .data
                .map(Receipt::from)
                .ok_or_else(|| {
                    tracing::error!(%url, body_bytes = raw.len(), "os_accounts: charge success envelope missing data");
                    ChargeError::Domain(DomainError::UpstreamProvider)
                });
        }
        if envelope.error_code == Some(ERR_INSUFFICIENT_CREDITS) {
            tracing::warn!(%url, body_bytes = raw.len(), "os_accounts: charge denied — insufficient credits");
            return Err(ChargeError::Domain(DomainError::InsufficientCredits));
        }
        if envelope.error_code == Some(ERR_IDEMPOTENCY_KEY_COLLISION) {
            // The note was already charged under this key (e.g. an earlier
            // attempt settled before a transient failure). Treat it as an
            // idempotent replay: the user already paid, so return success and
            // let the transcript through rather than failing the whole call.
            //
            // The 4001 reply carries `data: null`, so we cannot recover the
            // amount actually settled — we report this request's `credits` as
            // an approximation. Logged at WARN so any discrepancy between this
            // value and the original settlement is visible to accounting/audit.
            tracing::warn!(
                %url,
                body_bytes = raw.len(),
                reported_credits = body.credits,
                "os_accounts: charge replayed — idempotency key already settled; \
                 credits_charged reflects the requested estimate, not the settled amount"
            );
            return Ok(Receipt {
                credits_charged: Credits(body.credits),
                idempotent_replay: true,
            });
        }
        tracing::error!(
            %status,
            %url,
            body_bytes = raw.len(),
            error_code = ?envelope.error_code,
            "os_accounts: charge denied"
        );
        Err(ChargeError::Domain(DomainError::UpstreamProvider))
    }
}

enum ChargeError {
    Retryable,
    Domain(DomainError),
}

#[derive(Debug, Deserialize)]
struct Envelope<T> {
    data: Option<T>,
    success: bool,
    error_code: Option<i64>,
}

#[derive(Debug, Serialize)]
struct AuthorizeWireRequest {
    user_id: String,
    action: String,
    estimate_credits: u64,
    hold_ttl_seconds: u64,
}

impl From<AuthorizeRequest> for AuthorizeWireRequest {
    fn from(request: AuthorizeRequest) -> Self {
        Self {
            user_id: request.user_id.0,
            action: request.action.to_string(),
            estimate_credits: request.estimate.0,
            hold_ttl_seconds: request.hold_ttl_seconds,
        }
    }
}

#[derive(Debug, Deserialize)]
struct AuthorizationWire {
    allowed: bool,
    // OS Accounts wire field is `token` (per
    // os-accounts-integration/references/metering-and-billing.md). Renamed
    // here so internal Rust code can keep the more descriptive
    // `action_token` name.
    #[serde(rename = "token")]
    action_token: Option<String>,
    cap_credits: Option<u64>,
    reason: Option<String>,
}

impl From<AuthorizationWire> for Authorization {
    fn from(wire: AuthorizationWire) -> Self {
        Self {
            allowed: wire.allowed,
            action_token: wire.action_token,
            cap_credits: wire.cap_credits.map(Credits),
            reason: wire.reason,
        }
    }
}

#[derive(Debug, Serialize)]
struct ChargeWireRequest {
    // Wire field is `token` per the OS Accounts spec; Rust keeps the
    // descriptive name internally.
    #[serde(rename = "token")]
    action_token: String,
    credits: u64,
    idempotency_key: String,
}

impl From<ChargeRequest> for ChargeWireRequest {
    fn from(request: ChargeRequest) -> Self {
        Self {
            action_token: request.action_token,
            credits: request.credits.0,
            idempotency_key: request.idempotency_key,
        }
    }
}

#[derive(Debug, Deserialize)]
struct ReceiptWire {
    // OS Accounts uses `credits_settled` on the /charge response; the
    // domain type calls this `credits_charged` for readability.
    #[serde(rename = "credits_settled")]
    credits_charged: u64,
    idempotent_replay: bool,
}

impl From<ReceiptWire> for Receipt {
    fn from(wire: ReceiptWire) -> Self {
        Self {
            credits_charged: Credits(wire.credits_charged),
            idempotent_replay: wire.idempotent_replay,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::OsAccountsHttpClient;
    use crate::http;
    use pretty_assertions::assert_eq;
    use scribe_domain::{
        ActionSlug, AuthorizeRequest, ChargeRequest, Credits, DomainError, OsAccountsClient, UserId,
    };
    use serde_json::json;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_json, header, method, path},
    };

    #[tokio::test]
    async fn authorize_sends_app_key_and_parses_action_token_with_cap() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/authorize"))
            .and(header("authorization", "Bearer osk_test"))
            .and(body_json(json!({
                "user_id": "usr_123",
                "action": "note_transcribe",
                "estimate_credits": 42,
                "hold_ttl_seconds": 60,
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "success": true,
                "data": {
                    "allowed": true,
                    "token": "agts_test",
                    "cap_credits": 50,
                    "reason": null,
                }
            })))
            .mount(&server)
            .await;

        let client = OsAccountsHttpClient::new(http::default_client(), &server.uri(), "osk_test");
        let authorization = client
            .authorize(AuthorizeRequest {
                user_id: UserId("usr_123".to_string()),
                action: ActionSlug::NoteTranscribe,
                estimate: Credits(42),
                hold_ttl_seconds: 60,
            })
            .await
            .expect("authorize returned error");

        assert_eq!(authorization.action_token, Some("agts_test".to_string()));
        assert_eq!(authorization.cap_credits, Some(Credits(50)));
        assert!(authorization.allowed);
    }

    #[tokio::test]
    async fn authorize_maps_insufficient_credits_to_denied() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/authorize"))
            .respond_with(ResponseTemplate::new(402).set_body_json(json!({
                "success": false,
                "data": null,
                "error_code": 4301,
                "message": "insufficient credits",
            })))
            .mount(&server)
            .await;
        let client = OsAccountsHttpClient::new(http::default_client(), &server.uri(), "osk_test");

        let authorization = client
            .authorize(AuthorizeRequest {
                user_id: UserId("usr_123".to_string()),
                action: ActionSlug::NoteGenerate,
                estimate: Credits(99),
                hold_ttl_seconds: 300,
            })
            .await;

        assert_eq!(
            authorization.map(|value| (value.allowed, value.reason)),
            Ok((false, Some("insufficient_available_balance".to_string())))
        );
    }

    #[tokio::test]
    async fn charge_sends_action_token_and_idempotency_key() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/charge"))
            .and(header("authorization", "Bearer osk_test"))
            .and(body_json(json!({
                "token": "agts_test",
                "credits": 12,
                "idempotency_key": "note_generate:usr_123:note_1:v7",
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "success": true,
                "data": {
                    "credits_settled": 12,
                    "idempotent_replay": false,
                }
            })))
            .mount(&server)
            .await;
        let client = OsAccountsHttpClient::new(http::default_client(), &server.uri(), "osk_test");

        let receipt = client
            .charge(ChargeRequest {
                action_token: "agts_test".to_string(),
                credits: Credits(12),
                idempotency_key: "note_generate:usr_123:note_1:v7".to_string(),
            })
            .await;

        assert_eq!(
            receipt.map(|value| (value.credits_charged.0, value.idempotent_replay)),
            Ok((12, false))
        );
    }

    #[tokio::test]
    async fn charge_parses_idempotent_replay() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/charge"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "success": true,
                "data": {
                    "credits_settled": 12,
                    "idempotent_replay": true,
                }
            })))
            .mount(&server)
            .await;
        let client = OsAccountsHttpClient::new(http::default_client(), &server.uri(), "osk_test");

        let receipt = client
            .charge(ChargeRequest {
                action_token: "agt_test".to_string(),
                credits: Credits(12),
                idempotency_key: "note_generate:usr_123:note_1:v7".to_string(),
            })
            .await;

        assert_eq!(receipt.map(|value| value.idempotent_replay), Ok(true));
    }

    #[tokio::test]
    async fn charge_treats_idempotency_collision_as_replay() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/charge"))
            .respond_with(ResponseTemplate::new(409).set_body_json(json!({
                "data": null,
                "success": false,
                "error_code": 4001,
                "message": "idempotency_key_collision",
            })))
            .mount(&server)
            .await;
        let client = OsAccountsHttpClient::new(http::default_client(), &server.uri(), "osk_test");

        let receipt = client
            .charge(ChargeRequest {
                action_token: "agts_test".to_string(),
                credits: Credits(7),
                idempotency_key: "note_transcribe:usr_123:turn-0".to_string(),
            })
            .await;

        // Already settled under this key → success, surfaced as an idempotent
        // replay carrying the attempted amount.
        assert_eq!(
            receipt.map(|value| (value.credits_charged.0, value.idempotent_replay)),
            Ok((7, true))
        );
    }

    #[tokio::test]
    async fn charge_redacts_upstream_error_detail() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/charge"))
            .respond_with(ResponseTemplate::new(403).set_body_json(json!({
                "success": false,
                "data": null,
                "error_code": 3001,
                "message": "missing app key detail that must not leak",
            })))
            .mount(&server)
            .await;
        let client = OsAccountsHttpClient::new(http::default_client(), &server.uri(), "osk_test");

        let receipt = client
            .charge(ChargeRequest {
                action_token: "agt_test".to_string(),
                credits: Credits(12),
                idempotency_key: "note_generate:usr_123:note_1:v7".to_string(),
            })
            .await;

        assert!(matches!(receipt, Err(DomainError::UpstreamProvider)));
    }

    #[tokio::test]
    async fn charge_retries_on_transient_5xx() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/charge"))
            .respond_with(ResponseTemplate::new(502))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/charge"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "success": true,
                "data": {
                    "credits_settled": 12,
                    "idempotent_replay": false,
                }
            })))
            .mount(&server)
            .await;
        let client = OsAccountsHttpClient::new(http::default_client(), &server.uri(), "osk_test");

        let receipt = client
            .charge(ChargeRequest {
                action_token: "agts_test".to_string(),
                credits: Credits(12),
                idempotency_key: "note_generate:usr_123:note_1:v7".to_string(),
            })
            .await;

        assert_eq!(receipt.map(|value| value.credits_charged.0), Ok(12));
    }
}
