use crate::retry::{self, UpstreamAttemptError};
use async_trait::async_trait;
use scribe_config::UpstreamConfig;
use scribe_domain::{
    DomainError, ToolGuardAnalysis, ToolGuardAnalyzer, ToolGuardCallAnalysisRequest,
    ToolGuardResultAnalysisRequest,
};
use serde::Serialize;

pub const PROVIDER_NAME: &str = "osguard";

const CALLS_PATH: &str = "/tool-guard/calls";
const RESULTS_PATH: &str = "/tool-guard/results";

/// HTTP client for OS-Guard's detection-only Tool Guard endpoints. scribe holds
/// the server-side gateway token; the desktop client never sees it. Requests
/// are forwarded with `Authorization: Bearer <gateway token>` and the analysis
/// is relayed back unchanged. scribe does not execute tools, apply redaction
/// operations, or decide — it only proxies the analysis.
pub struct OsGuardToolGuard {
    http: reqwest::Client,
    api_key: String,
    base_url: String,
}

impl OsGuardToolGuard {
    pub fn from_config(http: reqwest::Client, config: &UpstreamConfig) -> Self {
        Self {
            http,
            api_key: config.api_key.clone(),
            base_url: config.base_url.trim_end_matches('/').to_string(),
        }
    }

    /// POSTs `body` to `path` under the gateway base URL with the bounded retry
    /// the other upstream calls use. Audit-safe by construction: the request
    /// body (which may carry PII in `arguments`/`result`) is serialized once and
    /// never logged — only the path, status, and counts appear in traces.
    async fn analyze<B: Serialize>(
        &self,
        path: &str,
        operation: &str,
        body: &B,
    ) -> Result<ToolGuardAnalysis, DomainError> {
        let url = format!("{}{}", self.base_url, path);
        for attempt in 0..retry::UPSTREAM_ATTEMPTS {
            let error = match self.analyze_once(&url, body).await {
                Ok(analysis) => return Ok(analysis),
                Err(error) => error,
            };
            if error.retryable && attempt + 1 < retry::UPSTREAM_ATTEMPTS {
                tracing::warn!(
                    %url,
                    operation,
                    attempt,
                    "tool-guard: transient upstream failure, retrying"
                );
                tokio::time::sleep(retry::UPSTREAM_RETRY_BACKOFF).await;
                continue;
            }
            return Err(error.error);
        }
        Err(DomainError::UpstreamProvider)
    }

    async fn analyze_once<B: Serialize>(
        &self,
        url: &str,
        body: &B,
    ) -> Result<ToolGuardAnalysis, UpstreamAttemptError> {
        let response = self
            .http
            .post(url)
            .bearer_auth(&self.api_key)
            .json(body)
            .send()
            .await
            .map_err(|error| {
                let retryable = retry::is_retryable_transport_error(&error);
                tracing::error!(%error, %url, retryable, "tool-guard: transport error");
                UpstreamAttemptError {
                    error: DomainError::UpstreamProvider,
                    retryable,
                }
            })?;
        let status = response.status();
        if !status.is_success() {
            let error = status_error(status);
            // Only the generic upstream failure is worth replaying; a 400/403
            // is deterministic and must not be retried.
            let retryable =
                error == DomainError::UpstreamProvider && retry::is_retryable_status(status);
            // The error body may echo request fragments, so it is not logged.
            let _ = response.bytes().await;
            tracing::error!(%status, %url, retryable, "tool-guard: non-success response");
            return Err(UpstreamAttemptError { error, retryable });
        }
        response.json::<ToolGuardAnalysis>().await.map_err(|error| {
            tracing::error!(%error, %url, "tool-guard: response JSON parse failed");
            UpstreamAttemptError::fatal(DomainError::UpstreamProvider)
        })
    }
}

#[async_trait]
impl ToolGuardAnalyzer for OsGuardToolGuard {
    async fn analyze_call(
        &self,
        request: ToolGuardCallAnalysisRequest,
    ) -> Result<ToolGuardAnalysis, DomainError> {
        self.analyze(CALLS_PATH, "calls", &request).await
    }

    async fn analyze_result(
        &self,
        request: ToolGuardResultAnalysisRequest,
    ) -> Result<ToolGuardAnalysis, DomainError> {
        self.analyze(RESULTS_PATH, "results", &request).await
    }
}

/// Classifies a non-success status from the gateway. `403` is a policy block
/// (deterministic, never retried, never billed); `400` is a bad/expired request
/// surfaced to the client as invalid input; everything else maps to the generic
/// upstream error, whose retryability the caller derives from the status.
fn status_error(status: reqwest::StatusCode) -> DomainError {
    match status {
        reqwest::StatusCode::FORBIDDEN => DomainError::PolicyBlocked,
        reqwest::StatusCode::BAD_REQUEST => DomainError::InvalidInput {
            reason: "tool_guard_request_rejected".to_string(),
        },
        _ => DomainError::UpstreamProvider,
    }
}

#[cfg(test)]
mod tests {
    use super::OsGuardToolGuard;
    use crate::http;
    use pretty_assertions::assert_eq;
    use scribe_config::UpstreamConfig;
    use scribe_domain::{
        DomainError, ToolDestinationClass, ToolGuardAnalyzer, ToolGuardCallAnalysisRequest,
        ToolGuardResultAnalysisRequest,
    };
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_string_contains, header, method, path},
    };

    fn future_deadline_ms() -> u64 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        u64::try_from(now.saturating_add(30_000)).unwrap_or(u64::MAX)
    }

    fn call_request() -> ToolGuardCallAnalysisRequest {
        ToolGuardCallAnalysisRequest {
            caller_identity: "usr_123".to_string(),
            agent_turn_id: "turn-1".to_string(),
            tool_call_id: "call-1".to_string(),
            tool_name: "web_lookup".to_string(),
            destination_id: "web".to_string(),
            destination_class: ToolDestinationClass::ExternalUntrusted,
            tool_schema_ref: Some("schema:web_lookup:v1".to_string()),
            arguments: json!({ "query": "alice@example.com" }),
            deadline_ms: future_deadline_ms(),
            policy_context: None,
        }
    }

    fn result_request() -> ToolGuardResultAnalysisRequest {
        ToolGuardResultAnalysisRequest {
            caller_identity: "usr_123".to_string(),
            agent_turn_id: "turn-1".to_string(),
            tool_call_id: "call-1".to_string(),
            destination_id: "web".to_string(),
            destination_class: ToolDestinationClass::ExternalUntrusted,
            result: json!({ "answer": "ok" }),
            deadline_ms: future_deadline_ms(),
            policy_context: None,
        }
    }

    fn analysis_body() -> serde_json::Value {
        json!({
            "request_id": "req-1",
            "canonical_request_hash": "hash",
            "findings": [
                {
                    "finding_id": "finding-1",
                    "pii_type": "email",
                    "confidence_bucket": "high",
                    "score": 0.98,
                    "source_roles": ["pii_primary"],
                    "locator": { "target": "value", "path": [] },
                    "range": { "start": 6, "end": 23, "unit": "unicode_codepoint" },
                    "replacement": "[[OSG.EMAIL.1]]"
                }
            ],
            "advisories": [
                {
                    "advisory_id": "advisory-1",
                    "advisory_type": "prompt_injection",
                    "confidence_bucket": "high",
                    "source_roles": ["injection"],
                    "categories": ["prompt_injection"]
                }
            ],
            "redaction_plan": {
                "operations": [
                    {
                        "finding_id": "finding-1",
                        "locator": { "target": "value", "path": [] },
                        "range": { "start": 6, "end": 23, "unit": "unicode_codepoint" },
                        "replacement": "[[OSG.EMAIL.1]]"
                    }
                ]
            }
        })
    }

    fn client(server: &MockServer) -> OsGuardToolGuard {
        OsGuardToolGuard::from_config(
            http::default_client(),
            &UpstreamConfig {
                api_key: "gateway_token".to_string(),
                base_url: server.uri(),
            },
        )
    }

    #[tokio::test]
    async fn analyze_call_forwards_token_and_relays_analysis() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/tool-guard/calls"))
            .and(header("authorization", "Bearer gateway_token"))
            .and(body_string_contains("\"caller_identity\":\"usr_123\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(analysis_body()))
            .mount(&server)
            .await;

        let analysis = client(&server)
            .analyze_call(call_request())
            .await
            .expect("call analysis succeeds");

        assert_eq!(analysis.request_id, "req-1");
        assert_eq!(analysis.findings.len(), 1);
        assert_eq!(analysis.findings[0].replacement, "[[OSG.EMAIL.1]]");
        assert_eq!(analysis.advisories[0].advisory_type, "prompt_injection");
        assert_eq!(analysis.redaction_plan.operations.len(), 1);
    }

    #[tokio::test]
    async fn analyze_result_relays_analysis() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/tool-guard/results"))
            .and(header("authorization", "Bearer gateway_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "request_id": "req-2",
                "canonical_request_hash": "hash",
                "redaction_plan": { "operations": [] }
            })))
            .mount(&server)
            .await;

        let analysis = client(&server)
            .analyze_result(result_request())
            .await
            .expect("result analysis succeeds");

        assert_eq!(analysis.request_id, "req-2");
        assert!(analysis.findings.is_empty());
        assert!(analysis.advisories.is_empty());
        assert!(analysis.redaction_plan.operations.is_empty());
    }

    #[tokio::test]
    async fn policy_block_maps_to_policy_blocked_without_retry() {
        // A 403 from the gateway is a deterministic policy block: it must surface
        // as PolicyBlocked and must not be retried.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/tool-guard/calls"))
            .respond_with(ResponseTemplate::new(403))
            .expect(1)
            .mount(&server)
            .await;

        let result = client(&server).analyze_call(call_request()).await;

        assert_eq!(result.map(|_| ()), Err(DomainError::PolicyBlocked));
    }

    #[tokio::test]
    async fn bad_request_maps_to_invalid_input_without_retry() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/tool-guard/calls"))
            .respond_with(ResponseTemplate::new(400))
            .expect(1)
            .mount(&server)
            .await;

        let result = client(&server).analyze_call(call_request()).await;

        assert!(matches!(result, Err(DomainError::InvalidInput { .. })));
    }

    #[tokio::test]
    async fn transient_503_is_retried_then_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/tool-guard/calls"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/tool-guard/calls"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "request_id": "req-3",
                "canonical_request_hash": "hash",
                "redaction_plan": { "operations": [] }
            })))
            .mount(&server)
            .await;

        let analysis = client(&server)
            .analyze_call(call_request())
            .await
            .expect("retry recovers");

        assert_eq!(analysis.request_id, "req-3");
    }
}
