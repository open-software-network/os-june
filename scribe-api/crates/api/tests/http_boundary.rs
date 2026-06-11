use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode, header},
};
use pretty_assertions::assert_eq;
use scribe_api::{ApiLimits, ApiState, ApiStateParams, AttestationInfo, router};
use scribe_config::{ModelPriceConfig, ModelProvider, ModelType, PriceUnit};
use scribe_domain::{
    AgentChatCompleter, AgentChatCompletion, AgentChatRequest, AudioDurationProbe, AuthError,
    Authorization, AuthorizeRequest, CleanedText, Cleaner, CleanupRequest, Credits, DomainError,
    GeneratedNote, GenerationRequest, Generator, IssueReport, IssueReportSink, OsAccountsClient,
    Receipt, TokenUsage, Transcriber, Transcript, TranscriptionRequest, UserId,
};
use scribe_services::{
    AgentChatService, AgentChatServiceDeps, DictateService, DictateServiceDeps,
    NoteGenerateService, NoteGenerateServiceDeps, NoteTranscribeService, NoteTranscribeServiceDeps,
    PricingTable,
};
use std::{
    collections::BTreeMap,
    error::Error,
    sync::{Arc, Mutex},
    time::Duration,
};
use tower::ServiceExt;

const AUTHORIZATION: &str = "Bearer valid-token";

#[tokio::test]
async fn integration_missing_auth_returns_unauthorized_envelope() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/notes/generate",
        &serde_json::json!({
            "noteId": "note-1",
            "promptVersion": "prompt-v1",
            "title": "Planning",
            "transcript": "Transcript",
            "model": "text-model"
        }),
        None,
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["error_code"], 3001);
    assert_eq!(body["message"], "missing_bearer_token");
    Ok(())
}

#[tokio::test]
async fn integration_note_generate_returns_enveloped_response() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/notes/generate",
        &serde_json::json!({
            "noteId": "note-1",
            "promptVersion": "prompt-v1",
            "title": "Planning",
            "transcript": "System: launch is Friday",
            "manualNotes": "Ask about rate limits",
            "model": "text-model"
        }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["content"], "Generated note body");
    assert_eq!(body["data"]["titleSuggestion"], "Generated title");
    assert_eq!(body["data"]["creditsCharged"], 1);
    Ok(())
}

#[tokio::test]
async fn integration_note_generate_rejects_wrong_model_kind() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/notes/generate",
        &serde_json::json!({
            "noteId": "note-1",
            "promptVersion": "prompt-v1",
            "title": "Planning",
            "transcript": "Transcript",
            "model": "asr-model"
        }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "model_type_invalid");
    Ok(())
}

#[tokio::test]
async fn integration_issue_report_requires_auth() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/issue-reports",
        &serde_json::json!({ "description": "The recorder freezes" }),
        None,
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["error_code"], 3001);
    Ok(())
}

#[tokio::test]
async fn integration_issue_report_rejects_blank_description() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/issue-reports",
        &serde_json::json!({ "description": "   " }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "description_required");
    Ok(())
}

#[tokio::test]
async fn integration_issue_report_delivers_to_the_sink() -> Result<(), Box<dyn Error>> {
    let sink = Arc::new(RecordingIssueReportSink::default());
    let router = router(test_state_with_issue_sink(sink.clone(), test_attestation()));

    let response = match router
        .oneshot(json_request(
            "/v1/issue-reports",
            &serde_json::json!({
                "description": "The recorder freezes after a long meeting",
                "agentDiagnosis": "Likely the audio capture thread is blocked",
                "attachmentNames": ["screenshot.png"],
                "sessionId": "session-9",
                "appVersion": "0.0.5",
                "platform": "macos"
            }),
            Some(AUTHORIZATION),
        )?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["received"], true);

    let Ok(reports) = sink.reports.lock() else {
        return Err("sink mutex poisoned".into());
    };
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].user_id, UserId("usr_test".to_string()));
    assert_eq!(
        reports[0].description,
        "The recorder freezes after a long meeting"
    );
    assert_eq!(
        reports[0].agent_diagnosis.as_deref(),
        Some("Likely the audio capture thread is blocked")
    );
    assert_eq!(reports[0].attachment_names, vec!["screenshot.png"]);
    assert_eq!(reports[0].session_id.as_deref(), Some("session-9"));
    Ok(())
}

#[tokio::test]
async fn integration_note_transcribe_accepts_valid_audio_multipart() -> Result<(), Box<dyn Error>> {
    let response = send(multipart_request(
        "/v1/notes/transcribe",
        multipart_body([
            text_part("model", "asr-model"),
            text_part("title", "Standup"),
            text_part("noteId", "note-1"),
            text_part("context", "Previous transcript context"),
            text_part("language", "en"),
            file_part("audio", "recording.wav", valid_wav()),
        ]),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["text"], "Transcribed audio");
    assert_eq!(body["data"]["language"], "en");
    assert_eq!(body["data"]["provider"], "fake-transcriber");
    Ok(())
}

#[tokio::test]
async fn integration_note_transcribe_rejects_unsupported_audio() -> Result<(), Box<dyn Error>> {
    let response = send(multipart_request(
        "/v1/notes/transcribe",
        multipart_body([
            text_part("model", "asr-model"),
            text_part("title", "Standup"),
            text_part("noteId", "note-1"),
            file_part("audio", "recording.txt", b"not-audio".to_vec()),
        ]),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "unsupported_audio_format");
    Ok(())
}

#[tokio::test]
async fn integration_dictate_cleanup_returns_enveloped_response() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/dictate/cleanup",
        &serde_json::json!({
            "sessionId": "session-1",
            "utteranceId": "utterance-1",
            "text": "hello scribe",
            "dictionaryContext": "Scribe",
            "style": "standard",
            "model": "text-model"
        }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["text"], "Cleaned dictation");
    assert_eq!(body["data"]["creditsCharged"], 0);
    Ok(())
}

#[tokio::test]
async fn integration_verify_page_is_public_html() -> Result<(), Box<dyn Error>> {
    let response = send(get_request("/verify")?).await;

    assert_eq!(response.status(), StatusCode::OK);
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(
        content_type.starts_with("text/html"),
        "unexpected content type: {content_type}"
    );
    let body = response_text(response).await?;
    assert!(body.contains("Verify this server"));
    assert!(body.contains("ghcr.io/open-software-network/scribe-api:0123abc"));
    assert!(body.contains(&format!(
        "https://github.com/open-software-network/os-scribe/commit/{TEST_COMMIT}"
    )));
    assert!(body.contains("https://trust.phala.com/app/test-app-id"));
    Ok(())
}

#[tokio::test]
async fn integration_verify_page_without_commit_reports_unstamped_build()
-> Result<(), Box<dyn Error>> {
    let attestation = AttestationInfo {
        source_commit: String::new(),
        ..test_attestation()
    };
    let response = match router(test_state_with_attestation(attestation))
        .oneshot(get_request("/verify")?)
        .await
    {
        Ok(response) => response,
        Err(error) => match error {},
    };

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_text(response).await?;
    assert!(body.contains("not stamped"));
    Ok(())
}

fn test_router() -> Router {
    router(test_state())
}

const TEST_COMMIT: &str = "0123abc4567890def0123abc4567890def012345";

fn test_attestation() -> AttestationInfo {
    AttestationInfo {
        source_commit: TEST_COMMIT.to_string(),
        source_repo_url: "https://github.com/open-software-network/os-scribe".to_string(),
        image_repo: "ghcr.io/open-software-network/scribe-api".to_string(),
        trust_center_url: "https://trust.phala.com/app/test-app-id".to_string(),
    }
}

fn test_state() -> ApiState {
    test_state_with_attestation(test_attestation())
}

fn test_state_with_attestation(attestation: AttestationInfo) -> ApiState {
    test_state_with_issue_sink(Arc::new(RecordingIssueReportSink::default()), attestation)
}

fn test_state_with_issue_sink(
    issue_reports: Arc<dyn IssueReportSink>,
    attestation: AttestationInfo,
) -> ApiState {
    let pricing = Arc::new(PricingTable::new(models()));
    let os_accounts = Arc::new(FakeOsAccounts);
    let transcriber = Arc::new(FakeTranscriber);
    let generator = Arc::new(FakeGenerator);
    let cleaner = Arc::new(FakeCleaner);
    let duration_probe = Arc::new(FakeDurationProbe);
    let chat_completer = Arc::new(FakeChatCompleter);

    ApiState::new(ApiStateParams {
        pricing: pricing.clone(),
        token_verifier: Arc::new(FakeTokenVerifier),
        note_transcribe: Arc::new(NoteTranscribeService::new(NoteTranscribeServiceDeps {
            pricing: pricing.clone(),
            os_accounts: os_accounts.clone(),
            transcriber: transcriber.clone(),
            duration_probe: duration_probe.clone(),
            hold_ttl_seconds: 30,
            flat_estimate_credits: 1_000,
        })),
        note_generate: Arc::new(NoteGenerateService::new(NoteGenerateServiceDeps {
            pricing: pricing.clone(),
            os_accounts: os_accounts.clone(),
            generator,
            hold_ttl_seconds: 30,
            flat_estimate_credits: 1_000,
        })),
        agent_chat: Arc::new(AgentChatService::new(AgentChatServiceDeps {
            pricing: pricing.clone(),
            os_accounts: os_accounts.clone(),
            chat_completer,
            hold_ttl_seconds: 30,
            flat_estimate_credits: 1_000,
        })),
        dictate: Arc::new(DictateService::new(DictateServiceDeps {
            pricing,
            os_accounts,
            transcriber,
            cleaner,
            duration_probe,
            transcribe_hold_ttl_seconds: 30,
            cleanup_hold_ttl_seconds: 30,
            flat_estimate_credits: 1_000,
        })),
        issue_reports,
        limits: ApiLimits {
            max_audio_bytes: 1024 * 1024,
            max_json_bytes: 1024 * 1024,
            request_timeout_secs: 5,
        },
        attestation,
    })
}

fn models() -> BTreeMap<String, ModelPriceConfig> {
    [
        (
            "asr-model",
            ModelPriceConfig {
                unit: PriceUnit::Seconds,
                credits_per_million_seconds: Some(250_000),
                input_credits_per_million_tokens: None,
                output_credits_per_million_tokens: None,
                provider: ModelProvider::Openai,
                model_type: ModelType::Asr,
                display_name: "ASR Model".to_string(),
                description: None,
                privacy: None,
                pricing: None,
                context_tokens: None,
                traits: Vec::new(),
                capabilities: Vec::new(),
            },
        ),
        (
            "text-model",
            ModelPriceConfig {
                unit: PriceUnit::Tokens,
                credits_per_million_seconds: None,
                input_credits_per_million_tokens: Some(500),
                output_credits_per_million_tokens: Some(500),
                provider: ModelProvider::Openai,
                model_type: ModelType::Text,
                display_name: "Text Model".to_string(),
                description: None,
                privacy: None,
                pricing: None,
                context_tokens: None,
                traits: Vec::new(),
                capabilities: Vec::new(),
            },
        ),
    ]
    .into_iter()
    .map(|(id, model)| (id.to_string(), model))
    .collect()
}

async fn send(request: Request<Body>) -> axum::response::Response {
    match test_router().oneshot(request).await {
        Ok(response) => response,
        Err(error) => match error {},
    }
}

fn json_request(
    uri: &str,
    value: &serde_json::Value,
    authorization: Option<&str>,
) -> Result<Request<Body>, axum::http::Error> {
    let mut builder = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(authorization) = authorization {
        builder = builder.header(header::AUTHORIZATION, authorization);
    }
    builder.body(Body::from(value.to_string()))
}

fn get_request(uri: &str) -> Result<Request<Body>, axum::http::Error> {
    Request::builder()
        .method(Method::GET)
        .uri(uri)
        .body(Body::empty())
}

fn multipart_request(uri: &str, body: Vec<u8>) -> Result<Request<Body>, axum::http::Error> {
    Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::AUTHORIZATION, AUTHORIZATION)
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={}", boundary()),
        )
        .body(Body::from(body))
}

async fn response_json(
    response: axum::response::Response,
) -> Result<serde_json::Value, Box<dyn Error>> {
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

async fn response_text(response: axum::response::Response) -> Result<String, Box<dyn Error>> {
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    Ok(String::from_utf8(bytes.to_vec())?)
}

fn boundary() -> &'static str {
    "test-boundary"
}

enum MultipartPart {
    Text {
        name: &'static str,
        value: &'static str,
    },
    File {
        name: &'static str,
        filename: &'static str,
        bytes: Vec<u8>,
    },
}

fn text_part(name: &'static str, value: &'static str) -> MultipartPart {
    MultipartPart::Text { name, value }
}

fn file_part(name: &'static str, filename: &'static str, bytes: Vec<u8>) -> MultipartPart {
    MultipartPart::File {
        name,
        filename,
        bytes,
    }
}

fn multipart_body<const N: usize>(parts: [MultipartPart; N]) -> Vec<u8> {
    let mut body = Vec::new();
    for part in parts {
        body.extend_from_slice(format!("--{}\r\n", boundary()).as_bytes());
        match part {
            MultipartPart::Text { name, value } => {
                body.extend_from_slice(
                    format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
                );
                body.extend_from_slice(value.as_bytes());
                body.extend_from_slice(b"\r\n");
            }
            MultipartPart::File {
                name,
                filename,
                bytes,
            } => {
                body.extend_from_slice(
                    format!(
                        "Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: audio/wav\r\n\r\n"
                    )
                    .as_bytes(),
                );
                body.extend_from_slice(&bytes);
                body.extend_from_slice(b"\r\n");
            }
        }
    }
    body.extend_from_slice(format!("--{}--\r\n", boundary()).as_bytes());
    body
}

fn valid_wav() -> Vec<u8> {
    b"RIFF....WAVEfmt ".to_vec()
}

#[derive(Default)]
struct RecordingIssueReportSink {
    reports: Mutex<Vec<IssueReport>>,
}

#[async_trait]
impl IssueReportSink for RecordingIssueReportSink {
    async fn deliver(&self, report: IssueReport) -> Result<(), DomainError> {
        self.reports
            .lock()
            .map_err(|_| DomainError::UpstreamProvider)?
            .push(report);
        Ok(())
    }
}

struct FakeTokenVerifier;

#[async_trait]
impl scribe_domain::TokenVerifier for FakeTokenVerifier {
    async fn verify(&self, access_jwt: &str) -> Result<UserId, AuthError> {
        if access_jwt == "valid-token" {
            Ok(UserId("usr_test".to_string()))
        } else {
            Err(AuthError::InvalidToken)
        }
    }
}

struct FakeOsAccounts;

#[async_trait]
impl OsAccountsClient for FakeOsAccounts {
    async fn authorize(&self, _request: AuthorizeRequest) -> Result<Authorization, DomainError> {
        Ok(Authorization {
            allowed: true,
            action_token: Some("agt_test".to_string()),
            cap_credits: None,
            reason: None,
        })
    }

    async fn charge(&self, _request: scribe_domain::ChargeRequest) -> Result<Receipt, DomainError> {
        Ok(Receipt {
            credits_charged: Credits(1),
            idempotent_replay: false,
        })
    }
}

struct FakeDurationProbe;

impl AudioDurationProbe for FakeDurationProbe {
    fn probe(&self, _audio: &[u8]) -> Result<Duration, DomainError> {
        Ok(Duration::from_secs(1))
    }
}

struct FakeTranscriber;

#[async_trait]
impl Transcriber for FakeTranscriber {
    async fn transcribe(&self, request: TranscriptionRequest) -> Result<Transcript, DomainError> {
        Ok(Transcript {
            text: "Transcribed audio".to_string(),
            language: request.language,
            provider: "fake-transcriber".to_string(),
        })
    }
}

struct FakeGenerator;

#[async_trait]
impl Generator for FakeGenerator {
    async fn generate(&self, _request: GenerationRequest) -> Result<GeneratedNote, DomainError> {
        Ok(GeneratedNote {
            content: "Generated note body".to_string(),
            title_suggestion: Some("Generated title".to_string()),
            provider: "fake-generator".to_string(),
            usage: TokenUsage {
                prompt_tokens: 500,
                completion_tokens: 500,
            },
        })
    }
}

struct FakeCleaner;

#[async_trait]
impl Cleaner for FakeCleaner {
    async fn cleanup(&self, _request: CleanupRequest) -> Result<CleanedText, DomainError> {
        Ok(CleanedText {
            text: "Cleaned dictation".to_string(),
            provider: "fake-cleaner".to_string(),
            usage: TokenUsage {
                prompt_tokens: 100,
                completion_tokens: 100,
            },
        })
    }
}

struct FakeChatCompleter;

#[async_trait]
impl AgentChatCompleter for FakeChatCompleter {
    async fn complete(
        &self,
        _request: AgentChatRequest,
    ) -> Result<AgentChatCompletion, DomainError> {
        Ok(AgentChatCompletion {
            body: br#"{"id":"chatcmpl_test"}"#.to_vec(),
            content_type: "application/json".to_string(),
            provider: "fake-chat".to_string(),
            usage: TokenUsage {
                prompt_tokens: 100,
                completion_tokens: 100,
            },
        })
    }
}
