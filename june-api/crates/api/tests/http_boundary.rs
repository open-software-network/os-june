use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode, header},
};
use june_api::{ApiLimits, ApiState, ApiStateParams, AttestationInfo, router};
use june_config::{ModelPriceConfig, ModelProvider, ModelType, PriceUnit};
use june_domain::{
    AgentChatCompleter, AgentChatCompletion, AgentChatRequest, AudioDurationProbe, AuthError,
    Authorization, AuthorizeRequest, CleanedText, Cleaner, CleanupRequest, Credits, DomainError,
    GeneratedImage, GeneratedNote, GenerationRequest, Generator, ImageGenerationRequest,
    ImageGenerator, IssueReport, IssueReportSink, OsAccountsClient, Receipt, TokenUsage,
    Transcriber, Transcript, TranscriptionRequest, UserId, WebFetchRequest, WebFetchResult,
    WebFetcher, WebSearchRequest, WebSearchResult, WebSearchResults, WebSearcher,
};
use june_services::{
    AgentChatService, AgentChatServiceDeps, DictateService, DictateServiceDeps, ImageModelPrice,
    ImageService, ImageServiceDeps, NOTE_GENERATE_PROMPT_VERSION, NoteGenerateService,
    NoteGenerateServiceDeps, NoteTranscribeService, NoteTranscribeServiceDeps, PricingTable,
    WebAugmentService, WebAugmentServiceDeps,
};
use pretty_assertions::assert_eq;
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
    assert_eq!(body["data"]["promptVersion"], NOTE_GENERATE_PROMPT_VERSION);
    assert_eq!(body["data"]["creditsCharged"], 1);
    Ok(())
}

#[tokio::test]
async fn integration_note_generate_forwards_venice_api_key_header() -> Result<(), Box<dyn Error>> {
    let response = send(json_request_with_venice_api_key(
        "/v1/notes/generate",
        &serde_json::json!({
            "noteId": "note-1",
            "promptVersion": "prompt-v1",
            "title": "Planning",
            "transcript": "System: launch is Friday",
            "model": "text-model"
        }),
        "vc_user_key",
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(
        body["data"]["content"],
        "Generated note body with user Venice key"
    );
    assert!(!body.to_string().contains("vc_user_key"));
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
    let response = send(multipart_request_with_auth(
        "/v1/issue-reports",
        multipart_body([text_part("description", "The recorder freezes")]),
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
    let response = send(multipart_request(
        "/v1/issue-reports",
        multipart_body([text_part("description", "   ")]),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "description_required");
    Ok(())
}

#[tokio::test]
async fn integration_issue_report_delivers_attachments_to_the_sink() -> Result<(), Box<dyn Error>> {
    let sink = Arc::new(RecordingIssueReportSink::default());
    let router = router(test_state_with_issue_sink(sink.clone(), test_attestation()));

    let response = match router
        .oneshot(multipart_request(
            "/v1/issue-reports",
            multipart_body([
                text_part("description", "The recorder freezes after a long meeting"),
                text_part("category", "feedback"),
                text_part(
                    "agentDiagnosis",
                    "Likely the audio capture thread is blocked",
                ),
                text_part("attachmentName", "screenshot.png"),
                text_part("sessionId", "session-9"),
                text_part("appVersion", "0.0.5"),
                text_part("platform", "macos"),
                typed_file_part(
                    "attachment",
                    "screenshot.png",
                    "image/png",
                    b"fake-png-bytes".to_vec(),
                ),
            ]),
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
    assert_eq!(reports[0].category.as_deref(), Some("feedback"));
    assert_eq!(
        reports[0].agent_diagnosis.as_deref(),
        Some("Likely the audio capture thread is blocked")
    );
    assert_eq!(reports[0].attachment_names, vec!["screenshot.png"]);
    assert_eq!(reports[0].session_id.as_deref(), Some("session-9"));
    assert_eq!(reports[0].attachments.len(), 1);
    assert_eq!(reports[0].attachments[0].name, "screenshot.png");
    assert_eq!(reports[0].attachments[0].content_type, "image/png");
    assert_eq!(reports[0].attachments[0].bytes, b"fake-png-bytes".to_vec());
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
            "text": "hello june",
            "dictionaryContext": "June",
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
async fn integration_web_search_returns_enveloped_results() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/search",
        &serde_json::json!({ "query": "rust async", "limit": 5, "requestId": "req-1" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["provider"], "brave");
    assert_eq!(body["data"]["results"][0]["title"], "Result one");
    assert_eq!(body["data"]["results"][0]["url"], "https://example.com/one");
    Ok(())
}

#[tokio::test]
async fn integration_web_search_requires_auth() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/search",
        &serde_json::json!({ "query": "rust async", "requestId": "req-1" }),
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
async fn integration_web_search_rejects_blank_query() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/search",
        &serde_json::json!({ "query": "   ", "requestId": "req-1" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "query_required");
    Ok(())
}

#[tokio::test]
async fn integration_web_search_requires_request_id() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/search",
        &serde_json::json!({ "query": "rust async" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "request_id_required");
    Ok(())
}

#[tokio::test]
async fn integration_web_fetch_returns_markdown() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/fetch",
        &serde_json::json!({ "url": "https://93.184.216.34/post", "requestId": "req-1" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["url"], "https://93.184.216.34/post");
    assert_eq!(body["data"]["format"], "markdown");
    assert_eq!(body["data"]["content"], "# Heading\n\nBody.");
    Ok(())
}

#[tokio::test]
async fn integration_web_fetch_forwards_canonical_url() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/fetch",
        &serde_json::json!({
            "url": "http://93.184.216.34\\@169.254.169.254/",
            "requestId": "req-1"
        }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(
        body["data"]["url"],
        "http://93.184.216.34/@169.254.169.254/"
    );
    Ok(())
}

#[tokio::test]
async fn integration_web_fetch_blocked_site_returns_bad_request() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/fetch",
        &serde_json::json!({ "url": "https://93.184.216.34/x.com/some/post", "requestId": "req-1" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    // A site Venice refuses to scrape surfaces as a usable 400, not a 502.
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "web_fetch_unsupported_url");
    Ok(())
}

#[tokio::test]
async fn integration_web_fetch_rejects_non_http_url() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/fetch",
        &serde_json::json!({ "url": "file:///etc/passwd", "requestId": "req-1" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "url_must_be_http");
    Ok(())
}

#[tokio::test]
async fn integration_web_fetch_rejects_private_network_url() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/web/fetch",
        &serde_json::json!({
            "url": "http://169.254.169.254/latest/meta-data",
            "requestId": "req-1"
        }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "url_must_be_public_http");
    Ok(())
}

#[tokio::test]
async fn integration_image_generate_returns_enveloped_image() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/image/generate",
        &serde_json::json!({ "prompt": "a red bicycle", "model": "venice-sd35" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await?;
    assert_eq!(body["success"], true);
    assert_eq!(body["data"]["imageBase64"], "aGVsbG8=");
    assert_eq!(body["data"]["mimeType"], "image/png");
    assert_eq!(body["data"]["model"], "venice-sd35");
    assert_eq!(body["data"]["provider"], "fake-image");
    Ok(())
}

#[tokio::test]
async fn integration_image_generate_requires_auth() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/image/generate",
        &serde_json::json!({ "prompt": "a red bicycle", "model": "venice-sd35" }),
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
async fn integration_image_generate_rejects_blank_prompt() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/image/generate",
        &serde_json::json!({ "prompt": "   ", "model": "venice-sd35" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "prompt_required");
    Ok(())
}

#[tokio::test]
async fn integration_image_generate_maps_upstream_failure_to_502() -> Result<(), Box<dyn Error>> {
    let response = send(json_request(
        "/v1/image/generate",
        &serde_json::json!({ "prompt": "boom", "model": "venice-sd35" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "upstream_provider_failed");
    Ok(())
}

#[tokio::test]
async fn integration_image_generate_rejects_unpriced_model() -> Result<(), Box<dyn Error>> {
    // A model with no configured image price is rejected at the metering
    // boundary (before Venice is called) rather than generating for free.
    let response = send(json_request(
        "/v1/image/generate",
        &serde_json::json!({ "prompt": "a red bicycle", "model": "unpriced-image-model" }),
        Some(AUTHORIZATION),
    )?)
    .await;

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = response_json(response).await?;
    assert_eq!(body["success"], false);
    assert_eq!(body["message"], "model_not_priced");
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
    assert!(body.contains("<title>Verify this server</title>"));
    assert!(body.contains("This server runs inside an Intel TDX confidential VM."));
    assert!(body.contains("<dt>Version</dt>"));
    assert!(!body.contains("Verify this server ·"));
    assert!(!body.contains("<dt>Service</dt>"));
    assert!(!body.to_ascii_lowercase().contains("scribe-api"));
    assert!(!body.to_ascii_lowercase().contains("scribe api"));
    assert!(body.contains("ghcr.io/open-software-network/june-api:0123abc"));
    assert!(body.contains(&format!(
        "https://github.com/open-software-network/os-june/commit/{TEST_COMMIT}"
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
        source_repo_url: "https://github.com/open-software-network/os-june".to_string(),
        image_repo: "ghcr.io/open-software-network/june-api".to_string(),
        trust_center_url: "https://trust.phala.com/app/test-app-id".to_string(),
    }
}

fn test_state() -> ApiState {
    test_state_with_attestation(test_attestation())
}

fn test_state_with_attestation(attestation: AttestationInfo) -> ApiState {
    test_state_with_sinks(Arc::new(RecordingIssueReportSink::default()), attestation)
}

fn test_state_with_issue_sink(
    issue_reports: Arc<dyn IssueReportSink>,
    attestation: AttestationInfo,
) -> ApiState {
    test_state_with_sinks(issue_reports, attestation)
}

fn test_state_with_sinks(
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
    let image = Arc::new(ImageService::new(ImageServiceDeps {
        os_accounts: os_accounts.clone(),
        generator: Arc::new(FakeImageGenerator),
        pricing: BTreeMap::from([("venice-sd35".to_string(), ImageModelPrice::venice(20))]),
        hold_ttl_seconds: 30,
    }));

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
            preview_max_audio_seconds: 30,
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
            os_accounts: os_accounts.clone(),
            transcriber,
            cleaner,
            duration_probe,
            transcribe_hold_ttl_seconds: 30,
            cleanup_hold_ttl_seconds: 30,
            flat_estimate_credits: 1_000,
        })),
        web: Arc::new(WebAugmentService::new(WebAugmentServiceDeps {
            os_accounts,
            searcher: Arc::new(FakeWebSearcher),
            fetcher: Arc::new(FakeWebFetcher),
            search_credits: 20,
            fetch_credits: 20,
            hold_ttl_seconds: 30,
        })),
        image,
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

fn json_request_with_venice_api_key(
    uri: &str,
    value: &serde_json::Value,
    venice_api_key: &str,
) -> Result<Request<Body>, axum::http::Error> {
    Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, AUTHORIZATION)
        .header("x-venice-api-key", venice_api_key)
        .body(Body::from(value.to_string()))
}

fn get_request(uri: &str) -> Result<Request<Body>, axum::http::Error> {
    Request::builder()
        .method(Method::GET)
        .uri(uri)
        .body(Body::empty())
}

fn multipart_request(uri: &str, body: Vec<u8>) -> Result<Request<Body>, axum::http::Error> {
    multipart_request_with_auth(uri, body, Some(AUTHORIZATION))
}

fn multipart_request_with_auth(
    uri: &str,
    body: Vec<u8>,
    authorization: Option<&str>,
) -> Result<Request<Body>, axum::http::Error> {
    let mut builder = Request::builder().method(Method::POST).uri(uri).header(
        header::CONTENT_TYPE,
        format!("multipart/form-data; boundary={}", boundary()),
    );
    if let Some(authorization) = authorization {
        builder = builder.header(header::AUTHORIZATION, authorization);
    }
    builder.body(Body::from(body))
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
        content_type: &'static str,
        bytes: Vec<u8>,
    },
}

fn text_part(name: &'static str, value: &'static str) -> MultipartPart {
    MultipartPart::Text { name, value }
}

fn file_part(name: &'static str, filename: &'static str, bytes: Vec<u8>) -> MultipartPart {
    typed_file_part(name, filename, "audio/wav", bytes)
}

fn typed_file_part(
    name: &'static str,
    filename: &'static str,
    content_type: &'static str,
    bytes: Vec<u8>,
) -> MultipartPart {
    MultipartPart::File {
        name,
        filename,
        content_type,
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
                content_type,
                bytes,
            } => {
                body.extend_from_slice(
                    format!(
                        "Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n"
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
impl june_domain::TokenVerifier for FakeTokenVerifier {
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
    async fn authorize(&self, request: AuthorizeRequest) -> Result<Authorization, DomainError> {
        Ok(Authorization {
            allowed: true,
            action_token: Some("agt_test".to_string()),
            cap_credits: Some(request.estimate),
            reason: None,
        })
    }

    async fn charge(&self, _request: june_domain::ChargeRequest) -> Result<Receipt, DomainError> {
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
    async fn generate(&self, request: GenerationRequest) -> Result<GeneratedNote, DomainError> {
        let content =
            if request.provider_credentials.venice_api_key.as_deref() == Some("vc_user_key") {
                "Generated note body with user Venice key"
            } else {
                "Generated note body"
            };
        Ok(GeneratedNote {
            content: content.to_string(),
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

struct FakeImageGenerator;

#[async_trait]
impl ImageGenerator for FakeImageGenerator {
    async fn generate(
        &self,
        request: ImageGenerationRequest,
    ) -> Result<GeneratedImage, DomainError> {
        if request.prompt.contains("boom") {
            return Err(DomainError::UpstreamProvider);
        }
        Ok(GeneratedImage {
            image_base64: "aGVsbG8=".to_string(),
            mime_type: "image/png".to_string(),
            model: request.model.0,
            provider: "fake-image".to_string(),
        })
    }
}

struct FakeWebSearcher;

#[async_trait]
impl WebSearcher for FakeWebSearcher {
    async fn search(&self, request: WebSearchRequest) -> Result<WebSearchResults, DomainError> {
        Ok(WebSearchResults {
            query: request.query,
            provider: "brave".to_string(),
            results: vec![WebSearchResult {
                title: "Result one".to_string(),
                url: "https://example.com/one".to_string(),
                snippet: Some("A snippet.".to_string()),
                published_at: Some("2026-01-01".to_string()),
            }],
        })
    }
}

struct FakeWebFetcher;

#[async_trait]
impl WebFetcher for FakeWebFetcher {
    async fn fetch(&self, request: WebFetchRequest) -> Result<WebFetchResult, DomainError> {
        // Mirror Venice rejecting bot-walled sites with a deterministic error.
        if request.url.contains("x.com") {
            return Err(DomainError::InvalidInput {
                reason: "web_fetch_unsupported_url".to_string(),
            });
        }
        Ok(WebFetchResult {
            url: request.url,
            content: "# Heading\n\nBody.".to_string(),
            format: "markdown".to_string(),
            provider: "venice".to_string(),
        })
    }
}
