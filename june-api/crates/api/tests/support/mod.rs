//! Shared HTTP-boundary test harness: the full June API router wired to
//! happy-path fakes, plus request/response builders. Used by both the
//! boundary suite (`http_boundary.rs`) and the client compatibility suite
//! (`client_contract.rs`).
#![allow(dead_code)]

use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, header},
};
use june_api::{ApiLimits, ApiState, ApiStateParams, AttestationInfo, router};
use june_config::{
    DEFAULT_MAX_IMAGE_EDIT_BYTES, DEFAULT_MAX_ISSUE_REPORT_BYTES, ModelPriceConfig, ModelProvider,
    ModelType, PriceUnit,
};
use june_domain::{
    AgentChatCompleter, AgentChatCompletion, AgentChatRequest, AgentChatStream,
    AgentChatStreamOutcome, AudioDurationProbe, AuthError, Authorization, AuthorizeRequest,
    CleanedText, Cleaner, CleanupRequest, Credits, DomainError, GeneratedImage, GeneratedNote,
    GenerationRequest, Generator, ImageEditRequest, ImageEditor, ImageGenerationRequest,
    ImageGenerator, IssueReport, IssueReportDelivery, IssueReportSink, OsAccountsClient, P3aReport,
    P3aSink, Receipt, TokenUsage, Transcriber, Transcript, TranscriptionRequest,
    UpstreamRouteMetadata, UserId, VideoAnimationRequest, VideoGenerationRequest, VideoProvider,
    VideoQueued, VideoQuoteRequest, VideoRetrieved, WebFetchRequest, WebFetchResult, WebFetcher,
    WebSearchRequest, WebSearchResult, WebSearchResults, WebSearcher,
};
use june_services::{
    AgentChatService, AgentChatServiceDeps, DictateService, DictateServiceDeps, ImageModelPrice,
    ImageService, ImageServiceDeps, IssueReportService, IssueReportServiceDeps,
    NoteGenerateService, NoteGenerateServiceDeps, NoteTranscribeService, NoteTranscribeServiceDeps,
    P3aReportService, P3aReportServiceDeps, PricingTable, VideoModelPrice, VideoService,
    VideoServiceDeps, WebAugmentService, WebAugmentServiceDeps,
};
use std::{
    collections::BTreeMap,
    error::Error,
    sync::{Arc, Mutex},
    time::Duration,
};
use tower::ServiceExt;

pub(crate) const AUTHORIZATION: &str = "Bearer valid-token";
pub(crate) const TEST_COMMIT: &str = "0123abc4567890def0123abc4567890def012345";

pub(crate) fn test_router() -> Router {
    router(test_state())
}

pub(crate) fn test_attestation() -> AttestationInfo {
    AttestationInfo {
        source_commit: TEST_COMMIT.to_string(),
        source_repo_url: "https://github.com/open-software-network/os-june".to_string(),
        image_repo: "ghcr.io/open-software-network/june-api".to_string(),
        trust_center_url: "https://trust.phala.com/app/test-app-id".to_string(),
    }
}

pub(crate) fn test_state() -> ApiState {
    test_state_with_attestation(test_attestation())
}

pub(crate) fn test_state_with_attestation(attestation: AttestationInfo) -> ApiState {
    test_state_with_sinks(
        test_issue_report_service(Arc::new(RecordingIssueReportSink::default())),
        attestation,
    )
}

pub(crate) fn test_state_with_issue_sink(
    issue_reports: Arc<dyn IssueReportSink>,
    attestation: AttestationInfo,
) -> ApiState {
    test_state_with_issue_sink_and_timeout(issue_reports, attestation, 5)
}

pub(crate) fn test_state_with_issue_sink_and_timeout(
    issue_reports: Arc<dyn IssueReportSink>,
    attestation: AttestationInfo,
    request_timeout_secs: u64,
) -> ApiState {
    test_state_from_deps(TestStateDeps {
        pricing: models(),
        local_dev_enabled: false,
        issue_reports: test_issue_report_service(issue_reports),
        attestation,
        transcriber: Arc::new(FakeTranscriber),
        generator: Arc::new(FakeGenerator),
        chat_completer: Arc::new(FakeChatCompleter),
        request_timeout_secs,
        p3a_sink: Arc::new(RecordingP3aSink::default()),
    })
}

pub(crate) fn test_issue_report_service(
    issue_reports: Arc<dyn IssueReportSink>,
) -> Arc<IssueReportService> {
    Arc::new(IssueReportService::new(IssueReportServiceDeps {
        sink: issue_reports,
        chat_completer: Arc::new(FakeChatCompleter),
        config: june_config::IssueReportsConfig::default(),
    }))
}

pub(crate) fn test_state_with_sinks(
    issue_reports: Arc<IssueReportService>,
    attestation: AttestationInfo,
) -> ApiState {
    test_state_with_sinks_and_transcriber(issue_reports, attestation, Arc::new(FakeTranscriber))
}

pub(crate) fn test_state_with_sinks_and_transcriber(
    issue_reports: Arc<IssueReportService>,
    attestation: AttestationInfo,
    transcriber: Arc<dyn Transcriber>,
) -> ApiState {
    test_state_from_deps(TestStateDeps {
        pricing: models(),
        local_dev_enabled: false,
        issue_reports,
        attestation,
        transcriber,
        generator: Arc::new(FakeGenerator),
        chat_completer: Arc::new(FakeChatCompleter),
        request_timeout_secs: 5,
        p3a_sink: Arc::new(RecordingP3aSink::default()),
    })
}

pub(crate) fn test_state_with_generator_and_timeout(
    generator: Arc<dyn Generator>,
    request_timeout_secs: u64,
) -> ApiState {
    test_state_from_deps(TestStateDeps {
        pricing: models(),
        local_dev_enabled: false,
        issue_reports: test_issue_report_service(Arc::new(RecordingIssueReportSink::default())),
        attestation: test_attestation(),
        transcriber: Arc::new(FakeTranscriber),
        generator,
        chat_completer: Arc::new(FakeChatCompleter),
        request_timeout_secs,
        p3a_sink: Arc::new(RecordingP3aSink::default()),
    })
}

pub(crate) fn test_state_with_p3a_sink(p3a_sink: Arc<dyn P3aSink>) -> ApiState {
    test_state_from_deps(TestStateDeps {
        pricing: models(),
        local_dev_enabled: false,
        issue_reports: test_issue_report_service(Arc::new(RecordingIssueReportSink::default())),
        attestation: test_attestation(),
        transcriber: Arc::new(FakeTranscriber),
        generator: Arc::new(FakeGenerator),
        chat_completer: Arc::new(FakeChatCompleter),
        request_timeout_secs: 5,
        p3a_sink,
    })
}

pub(crate) fn test_state_with_local_text_pricing(
    generator: Arc<dyn Generator>,
    chat_completer: Arc<dyn AgentChatCompleter>,
) -> ApiState {
    test_state_with_text_pricing_without_auto(true, generator, chat_completer)
}

pub(crate) fn test_state_with_text_pricing_without_auto(
    local_dev_enabled: bool,
    generator: Arc<dyn Generator>,
    chat_completer: Arc<dyn AgentChatCompleter>,
) -> ApiState {
    test_state_with_text_pricing_without_auto_and_kimi_capabilities(
        local_dev_enabled,
        generator,
        chat_completer,
        vec![
            "supportsFunctionCalling".to_string(),
            "supportsVision".to_string(),
        ],
    )
}

pub(crate) fn test_state_with_text_pricing_without_auto_and_kimi_capabilities(
    local_dev_enabled: bool,
    generator: Arc<dyn Generator>,
    chat_completer: Arc<dyn AgentChatCompleter>,
    kimi_capabilities: Vec<String>,
) -> ApiState {
    let mut pricing = models();
    pricing.remove("open-software/auto");
    pricing.insert(
        "zai-org-glm-5-2".to_string(),
        ModelPriceConfig {
            unit: PriceUnit::Tokens,
            credits_per_million_seconds: None,
            input_credits_per_million_tokens: Some(500),
            output_credits_per_million_tokens: Some(500),
            provider: ModelProvider::Venice,
            model_type: ModelType::Text,
            display_name: "GLM 5.2".to_string(),
            description: None,
            privacy: None,
            pricing: None,
            context_tokens: None,
            traits: Vec::new(),
            capabilities: Vec::new(),
        },
    );
    pricing.insert(
        "kimi-k2-6".to_string(),
        ModelPriceConfig {
            unit: PriceUnit::Tokens,
            credits_per_million_seconds: None,
            input_credits_per_million_tokens: Some(500),
            output_credits_per_million_tokens: Some(500),
            provider: ModelProvider::Venice,
            model_type: ModelType::Text,
            display_name: "Kimi K2.6".to_string(),
            description: None,
            privacy: None,
            pricing: None,
            context_tokens: None,
            traits: Vec::new(),
            capabilities: kimi_capabilities,
        },
    );
    test_state_from_deps(TestStateDeps {
        pricing,
        local_dev_enabled,
        issue_reports: test_issue_report_service(Arc::new(RecordingIssueReportSink::default())),
        attestation: test_attestation(),
        transcriber: Arc::new(FakeTranscriber),
        generator,
        chat_completer,
        request_timeout_secs: 5,
        p3a_sink: Arc::new(RecordingP3aSink::default()),
    })
}

pub(crate) struct TestStateDeps {
    pub(crate) pricing: BTreeMap<String, ModelPriceConfig>,
    pub(crate) local_dev_enabled: bool,
    pub(crate) issue_reports: Arc<IssueReportService>,
    pub(crate) attestation: AttestationInfo,
    pub(crate) transcriber: Arc<dyn Transcriber>,
    pub(crate) generator: Arc<dyn Generator>,
    pub(crate) chat_completer: Arc<dyn AgentChatCompleter>,
    pub(crate) request_timeout_secs: u64,
    pub(crate) p3a_sink: Arc<dyn P3aSink>,
}

pub(crate) fn test_state_from_deps(deps: TestStateDeps) -> ApiState {
    let pricing = Arc::new(PricingTable::new(deps.pricing));
    let os_accounts = Arc::new(FakeOsAccounts);
    let cleaner = Arc::new(FakeCleaner);
    let duration_probe = Arc::new(FakeDurationProbe);
    let image = Arc::new(ImageService::new(ImageServiceDeps {
        os_accounts: os_accounts.clone(),
        generator: Arc::new(FakeImageGenerator),
        editor: Arc::new(FakeImageEditor),
        pricing: BTreeMap::from([("venice-sd35".to_string(), ImageModelPrice::venice(20))]),
        edit_pricing: BTreeMap::from([(
            "firered-image-edit".to_string(),
            ImageModelPrice::venice(80),
        )]),
        default_edit_model: "firered-image-edit".to_string(),
        hold_ttl_seconds: 30,
    }));
    let video = Arc::new(VideoService::new(VideoServiceDeps {
        os_accounts: os_accounts.clone(),
        provider: Arc::new(FakeVideoProvider),
        pricing: BTreeMap::from([(
            "wan-2.2-a14b-text-to-video".to_string(),
            VideoModelPrice::venice(2000),
        )]),
        animate_pricing: BTreeMap::from([(
            "wan-2.6-image-to-video".to_string(),
            VideoModelPrice::venice(2000),
        )]),
        default_animate_model: "wan-2.6-image-to-video".to_string(),
        max_credits_per_request: 20_000,
        hold_ttl_seconds: 600,
    }));

    ApiState::new(ApiStateParams {
        pricing: pricing.clone(),
        local_dev_enabled: deps.local_dev_enabled,
        token_verifier: Arc::new(FakeTokenVerifier),
        note_transcribe: Arc::new(NoteTranscribeService::new(NoteTranscribeServiceDeps {
            pricing: pricing.clone(),
            os_accounts: os_accounts.clone(),
            transcriber: deps.transcriber.clone(),
            duration_probe: duration_probe.clone(),
            hold_ttl_seconds: 30,
            flat_estimate_credits: 1_000,
            preview_max_audio_seconds: 30,
        })),
        note_generate: Arc::new(NoteGenerateService::new(NoteGenerateServiceDeps {
            pricing: pricing.clone(),
            os_accounts: os_accounts.clone(),
            generator: deps.generator,
            hold_ttl_seconds: 30,
            flat_estimate_credits: 1_000,
        })),
        agent_chat: Arc::new(AgentChatService::new(AgentChatServiceDeps {
            pricing: pricing.clone(),
            os_accounts: os_accounts.clone(),
            chat_completer: deps.chat_completer,
            hold_ttl_seconds: 30,
            flat_estimate_credits: 1_000,
        })),
        dictate: Arc::new(DictateService::new(DictateServiceDeps {
            pricing,
            os_accounts: os_accounts.clone(),
            transcriber: deps.transcriber,
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
        video,
        issue_reports: deps.issue_reports,
        p3a_reports: Arc::new(P3aReportService::new(P3aReportServiceDeps {
            sink: deps.p3a_sink,
        })),
        limits: ApiLimits {
            max_audio_bytes: 1024 * 1024,
            max_json_bytes: 1024 * 1024,
            max_issue_report_bytes: DEFAULT_MAX_ISSUE_REPORT_BYTES,
            max_image_edit_bytes: DEFAULT_MAX_IMAGE_EDIT_BYTES,
            request_timeout_secs: deps.request_timeout_secs,
        },
        attestation: deps.attestation,
    })
}

pub(crate) fn models() -> BTreeMap<String, ModelPriceConfig> {
    [
        (
            "nvidia/parakeet-tdt-0.6b-v3",
            ModelPriceConfig {
                unit: PriceUnit::Seconds,
                credits_per_million_seconds: Some(250_000),
                input_credits_per_million_tokens: None,
                output_credits_per_million_tokens: None,
                provider: ModelProvider::Venice,
                model_type: ModelType::Asr,
                display_name: "Private ASR Model".to_string(),
                description: None,
                privacy: None,
                pricing: None,
                context_tokens: None,
                traits: Vec::new(),
                capabilities: Vec::new(),
            },
        ),
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
        (
            "venice-text-model",
            ModelPriceConfig {
                unit: PriceUnit::Tokens,
                credits_per_million_seconds: None,
                input_credits_per_million_tokens: Some(500),
                output_credits_per_million_tokens: Some(500),
                provider: ModelProvider::Venice,
                model_type: ModelType::Text,
                display_name: "Venice Text Model".to_string(),
                description: None,
                privacy: None,
                pricing: None,
                context_tokens: None,
                traits: Vec::new(),
                capabilities: Vec::new(),
            },
        ),
        (
            "open-software/auto",
            ModelPriceConfig {
                unit: PriceUnit::Tokens,
                credits_per_million_seconds: None,
                input_credits_per_million_tokens: Some(500),
                output_credits_per_million_tokens: Some(500),
                provider: ModelProvider::Venice,
                model_type: ModelType::Text,
                display_name: "Auto".to_string(),
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

pub(crate) async fn send(request: Request<Body>) -> axum::response::Response {
    send_on(test_router(), request).await
}

/// Sends through a caller-held router, so multi-request flows (create a job,
/// then poll it) share the in-memory service state one deployed API has.
pub(crate) async fn send_on(router: Router, request: Request<Body>) -> axum::response::Response {
    match router.oneshot(request).await {
        Ok(response) => response,
        Err(error) => match error {},
    }
}

pub(crate) fn json_request(
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

pub(crate) fn sse_event_data(body: &str, event: &str) -> Result<String, Box<dyn Error>> {
    let marker = format!("event: {event}\n");
    let event_start = body.find(&marker).ok_or("missing SSE event")?;
    let event_body = &body[event_start + marker.len()..];
    let data = event_body
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .ok_or("missing SSE data")?;
    Ok(data.to_string())
}

pub(crate) fn get_request(uri: &str) -> Result<Request<Body>, axum::http::Error> {
    Request::builder()
        .method(Method::GET)
        .uri(uri)
        .body(Body::empty())
}

pub(crate) fn get_request_with_auth(
    uri: &str,
    authorization: Option<&str>,
) -> Result<Request<Body>, axum::http::Error> {
    let mut builder = Request::builder().method(Method::GET).uri(uri);
    if let Some(authorization) = authorization {
        builder = builder.header(header::AUTHORIZATION, authorization);
    }
    builder.body(Body::empty())
}

pub(crate) fn multipart_request(
    uri: &str,
    body: Vec<u8>,
) -> Result<Request<Body>, axum::http::Error> {
    multipart_request_with_auth(uri, body, Some(AUTHORIZATION))
}

pub(crate) fn multipart_request_with_auth(
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

pub(crate) async fn response_json(
    response: axum::response::Response,
) -> Result<serde_json::Value, Box<dyn Error>> {
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub(crate) async fn response_text(
    response: axum::response::Response,
) -> Result<String, Box<dyn Error>> {
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    Ok(String::from_utf8(bytes.to_vec())?)
}

pub(crate) fn boundary() -> &'static str {
    "test-boundary"
}

pub(crate) enum MultipartPart {
    Text {
        name: String,
        value: String,
    },
    File {
        name: String,
        filename: String,
        content_type: String,
        bytes: Vec<u8>,
    },
}

pub(crate) fn text_part(name: impl Into<String>, value: impl Into<String>) -> MultipartPart {
    MultipartPart::Text {
        name: name.into(),
        value: value.into(),
    }
}

pub(crate) fn file_part(
    name: impl Into<String>,
    filename: impl Into<String>,
    bytes: Vec<u8>,
) -> MultipartPart {
    typed_file_part(name, filename, "audio/wav", bytes)
}

pub(crate) fn typed_file_part(
    name: impl Into<String>,
    filename: impl Into<String>,
    content_type: impl Into<String>,
    bytes: Vec<u8>,
) -> MultipartPart {
    MultipartPart::File {
        name: name.into(),
        filename: filename.into(),
        content_type: content_type.into(),
        bytes,
    }
}

pub(crate) fn multipart_body(parts: impl IntoIterator<Item = MultipartPart>) -> Vec<u8> {
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

pub(crate) fn valid_wav() -> Vec<u8> {
    b"RIFF....WAVEfmt ".to_vec()
}

#[derive(Default)]
pub(crate) struct RecordingIssueReportSink {
    pub(crate) reports: Mutex<Vec<IssueReport>>,
    pub(crate) delivery: IssueReportDelivery,
}

#[async_trait]
impl IssueReportSink for RecordingIssueReportSink {
    async fn deliver(&self, report: IssueReport) -> Result<IssueReportDelivery, DomainError> {
        self.reports
            .lock()
            .map_err(|_| DomainError::UpstreamProvider)?
            .push(report);
        Ok(self.delivery.clone())
    }
}

#[derive(Default)]
pub(crate) struct RecordingP3aSink {
    pub(crate) reports: Mutex<Vec<P3aReport>>,
}

impl RecordingP3aSink {
    pub(crate) fn reports(&self) -> Result<Vec<P3aReport>, Box<dyn Error>> {
        Ok(self
            .reports
            .lock()
            .map_err(|_| "reports lock poisoned")?
            .clone())
    }
}

#[async_trait]
impl P3aSink for RecordingP3aSink {
    async fn submit(&self, report: P3aReport) -> Result<(), DomainError> {
        self.reports
            .lock()
            .map_err(|_| DomainError::MeteringProvider)?
            .push(report);
        Ok(())
    }
}

pub(crate) struct FakeTokenVerifier;

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

pub(crate) struct FakeOsAccounts;

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

pub(crate) struct FakeDurationProbe;

impl AudioDurationProbe for FakeDurationProbe {
    fn probe(&self, _audio: &[u8]) -> Result<Duration, DomainError> {
        Ok(Duration::from_secs(1))
    }
}

pub(crate) struct FakeTranscriber;

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

pub(crate) struct FakeGenerator;

#[async_trait]
impl Generator for FakeGenerator {
    async fn generate(&self, request: GenerationRequest) -> Result<GeneratedNote, DomainError> {
        if request.transcript.contains("boom") {
            return Err(DomainError::UpstreamProvider);
        }
        let content = if request.provider_credentials.has_venice_api_key() {
            "Generated note body with user Venice key"
        } else {
            "Generated note body"
        };
        Ok(GeneratedNote {
            content: content.to_string(),
            title_suggestion: Some("Generated title".to_string()),
            provider: "fake-generator".to_string(),
            route: UpstreamRouteMetadata {
                provider: Some("phala".to_string()),
                privacy_level: Some("no-retention".to_string()),
                endpoint: Some("venice-private".to_string()),
            },
            usage: TokenUsage {
                prompt_tokens: 500,
                completion_tokens: 500,
            },
        })
    }
}

pub(crate) struct FakeCleaner;

#[async_trait]
impl Cleaner for FakeCleaner {
    async fn cleanup(&self, _request: CleanupRequest) -> Result<CleanedText, DomainError> {
        Ok(CleanedText {
            text: "Cleaned dictation".to_string(),
            provider: "fake-cleaner".to_string(),
            route: UpstreamRouteMetadata {
                provider: Some("phala".to_string()),
                privacy_level: Some("no-retention".to_string()),
                endpoint: Some("venice-private".to_string()),
            },
            usage: TokenUsage {
                prompt_tokens: 100,
                completion_tokens: 100,
            },
        })
    }
}

pub(crate) struct FakeChatCompleter;

#[async_trait]
impl AgentChatCompleter for FakeChatCompleter {
    async fn complete(
        &self,
        request: AgentChatRequest,
    ) -> Result<AgentChatCompletion, DomainError> {
        let id = if request.provider_credentials.has_venice_api_key() {
            "chatcmpl_user_key"
        } else {
            "chatcmpl_test"
        };
        Ok(AgentChatCompletion {
            body: format!(r#"{{"id":"{id}"}}"#).into_bytes(),
            content_type: "application/json".to_string(),
            provider: "fake-chat".to_string(),
            route: UpstreamRouteMetadata {
                provider: Some("phala".to_string()),
                privacy_level: Some("no-retention".to_string()),
                endpoint: Some("venice-private".to_string()),
            },
            usage: TokenUsage {
                prompt_tokens: 100,
                completion_tokens: 100,
            },
        })
    }

    async fn complete_stream(
        &self,
        _request: AgentChatRequest,
    ) -> Result<AgentChatStream, DomainError> {
        let (chunks_tx, chunks_rx) = tokio::sync::mpsc::unbounded_channel();
        let (outcome_tx, outcome_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _ = chunks_tx.send(Ok(Vec::from(&b"data: {\"choices\":[]}\n\n"[..]).into()));
            let _ = outcome_tx.send(AgentChatStreamOutcome::Usage(TokenUsage {
                prompt_tokens: 100,
                completion_tokens: 100,
            }));
        });
        Ok(AgentChatStream {
            content_type: "text/event-stream".to_string(),
            provider: "fake-chat".to_string(),
            route: UpstreamRouteMetadata {
                provider: Some("phala".to_string()),
                privacy_level: Some("no-retention".to_string()),
                endpoint: Some("venice-private".to_string()),
            },
            chunks: chunks_rx,
            outcome: outcome_rx,
        })
    }
}

pub(crate) struct FakeImageGenerator;

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

pub(crate) struct FakeImageEditor;

#[async_trait]
impl ImageEditor for FakeImageEditor {
    async fn edit(&self, request: ImageEditRequest) -> Result<GeneratedImage, DomainError> {
        if request.prompt.contains("boom") {
            return Err(DomainError::UpstreamProvider);
        }
        Ok(GeneratedImage {
            image_base64: "ZWRpdGVk".to_string(),
            mime_type: "image/png".to_string(),
            model: request.model.0,
            provider: "fake-image".to_string(),
        })
    }
}

pub(crate) struct FakeVideoProvider;

#[async_trait]
impl VideoProvider for FakeVideoProvider {
    async fn quote(&self, _request: VideoQuoteRequest) -> Result<f64, DomainError> {
        Ok(0.11)
    }

    async fn queue(&self, request: VideoGenerationRequest) -> Result<VideoQueued, DomainError> {
        if request.prompt.contains("boom") {
            return Err(DomainError::UpstreamProvider);
        }
        // A prompt mentioning "instantly" yields a job whose first poll is
        // already complete (VPS-backed URL) and "inline" one whose bytes came
        // back inline (non-VPS), so tests can pin both completed status
        // shapes; every other job stays processing forever.
        let venice_queue_id = if request.prompt.contains("instantly") {
            "vq_completed".to_string()
        } else if request.prompt.contains("inline") {
            "vq_completed_inline".to_string()
        } else {
            "vq_boundary".to_string()
        };
        Ok(VideoQueued {
            venice_queue_id,
            download_url: None,
        })
    }

    async fn queue_animation(
        &self,
        _request: VideoAnimationRequest,
    ) -> Result<VideoQueued, DomainError> {
        Ok(VideoQueued {
            venice_queue_id: "vq_boundary_animate".to_string(),
            download_url: None,
        })
    }

    async fn retrieve(&self, _model: &str, queue_id: &str) -> Result<VideoRetrieved, DomainError> {
        if queue_id == "vq_completed" {
            return Ok(VideoRetrieved::CompletedUrl {
                download_url: "https://videos.example.com/generated.mp4".to_string(),
            });
        }
        if queue_id == "vq_completed_inline" {
            return Ok(VideoRetrieved::CompletedBytes {
                bytes: b"fake-mp4-bytes".to_vec(),
                mime_type: "video/mp4".to_string(),
            });
        }
        Ok(VideoRetrieved::Processing {
            average_execution_ms: 145_000,
            execution_ms: 30_000,
        })
    }
}

pub(crate) struct FakeWebSearcher;

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

pub(crate) struct FakeWebFetcher;

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
