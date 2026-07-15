use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{fmt, time::Duration};
use thiserror::Error;

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct UserId(pub String);

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct ModelId(pub String);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Credits(pub u64);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionSlug {
    AgentChat,
    DictateCleanup,
    DictateTranscribe,
    ImageEdit,
    ImageGenerate,
    NoteGenerate,
    NoteTranscribe,
    VideoAnimate,
    VideoGenerate,
    WebFetch,
    WebSearch,
}

impl ActionSlug {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AgentChat => "agent_chat",
            Self::DictateCleanup => "dictate_cleanup",
            Self::DictateTranscribe => "dictate_transcribe",
            Self::ImageEdit => "image_edit",
            Self::ImageGenerate => "image_generate",
            Self::NoteGenerate => "note_generate",
            Self::NoteTranscribe => "note_transcribe",
            Self::VideoAnimate => "video_animate",
            Self::VideoGenerate => "video_generate",
            Self::WebFetch => "web_fetch",
            Self::WebSearch => "web_search",
        }
    }
}

impl fmt::Display for ActionSlug {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelKind {
    Asr,
    Text,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub text: String,
    pub language: Option<String>,
    pub provider: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedNote {
    pub content: String,
    pub title_suggestion: Option<String>,
    pub provider: String,
    pub route: UpstreamRouteMetadata,
    pub usage: TokenUsage,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanedText {
    pub text: String,
    pub provider: String,
    pub route: UpstreamRouteMetadata,
    pub usage: TokenUsage,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatCompletion {
    pub body: Vec<u8>,
    pub content_type: String,
    pub provider: String,
    pub route: UpstreamRouteMetadata,
    pub usage: TokenUsage,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamRouteMetadata {
    pub provider: Option<String>,
    pub privacy_level: Option<String>,
    pub endpoint: Option<String>,
}

/// A streaming agent chat completion: response headers have been received
/// from the upstream; body chunks arrive on `chunks` as the upstream
/// produces them, and `outcome` resolves once the body has fully drained.
///
/// `chunks` is deliberately unbounded: the producer must be able to drain the
/// upstream to its usage frame at upstream speed even when the client reads
/// slowly, or billing settlement would be hostage to client pace. Worst-case
/// memory is the full response body — the same profile as the buffered path.
pub struct AgentChatStream {
    pub content_type: String,
    pub provider: String,
    pub route: UpstreamRouteMetadata,
    pub chunks: tokio::sync::mpsc::UnboundedReceiver<Result<bytes::Bytes, DomainError>>,
    pub outcome: tokio::sync::oneshot::Receiver<AgentChatStreamOutcome>,
}

/// How a streamed agent chat body ended. Settlement branches on this: a
/// transport failure must charge nothing (matching the buffered path, which
/// errors before its charge line on the same failure), while a body that
/// completed but carried no usage frame settles at the flat estimate —
/// content WAS delivered, only the meter reading is missing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentChatStreamOutcome {
    Usage(TokenUsage),
    CompletedWithoutUsage,
    Failed,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

impl TokenUsage {
    pub fn total(self) -> Option<u64> {
        self.prompt_tokens.checked_add(self.completion_tokens)
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProviderCredentials {
    pub venice_api_key: Option<String>,
}

impl ProviderCredentials {
    pub fn has_venice_api_key(&self) -> bool {
        self.venice_api_key
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Authorization {
    pub allowed: bool,
    pub action_token: Option<String>,
    pub cap_credits: Option<Credits>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub credits_charged: Credits,
    pub idempotent_replay: bool,
}

/// Audio container of a transcription request. The domain request carries
/// this instead of the client's file name, so upstream providers receive a
/// canonical, non-identifying part name no matter what the user's files are
/// called — the anonymization is structural, not a sanitization step.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AudioFormat {
    Wav,
    Mp4,
}

impl AudioFormat {
    /// Container detection by extension — the same rule the upload pipeline
    /// has always used: m4a/mp4 are MP4 audio, everything else is WAV.
    pub fn from_filename(filename: &str) -> Self {
        let is_mp4 = std::path::Path::new(filename)
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                extension.eq_ignore_ascii_case("m4a") || extension.eq_ignore_ascii_case("mp4")
            });
        if is_mp4 { Self::Mp4 } else { Self::Wav }
    }

    /// The only file name upstream providers ever see.
    pub fn upstream_filename(self) -> &'static str {
        match self {
            Self::Wav => "audio.wav",
            Self::Mp4 => "audio.m4a",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Self::Wav => "audio/wav",
            Self::Mp4 => "audio/mp4",
        }
    }
}

/// What a transcriber needs and nothing more: the audio, its container, and
/// the inference knobs. Deliberately no file name, note title, user id, or
/// session id — a provider cannot leak metadata it never receives.
#[derive(Clone, Debug)]
pub struct TranscriptionRequest {
    pub audio: Vec<u8>,
    pub format: AudioFormat,
    pub context: Option<String>,
    pub language: Option<String>,
    pub model: ModelId,
    pub provider_credentials: ProviderCredentials,
}

#[derive(Clone, Debug)]
pub struct GenerationRequest {
    pub title: String,
    pub transcript: String,
    pub transcript_source_labels: bool,
    pub manual_notes: Option<String>,
    pub language: Option<String>,
    pub existing_generated_note: Option<String>,
    pub model: ModelId,
    pub system_prompt: String,
    pub cost_quality: Option<f64>,
    pub provider_credentials: ProviderCredentials,
    /// See `AgentChatRequest::unmetered`.
    pub unmetered: bool,
}

#[derive(Clone, Debug)]
pub struct CleanupRequest {
    pub text: String,
    pub dictionary_context: Option<String>,
    /// Recognized insertion-surface slug ("email"); shapes output layout.
    pub app_context: Option<String>,
    pub style: String,
    pub model: ModelId,
    pub system_prompt: String,
    pub provider_credentials: ProviderCredentials,
}

#[derive(Clone, Debug)]
pub struct AgentChatRequest {
    pub body: serde_json::Value,
    pub model: ModelId,
    pub provider_credentials: ProviderCredentials,
    /// True when the caller settles no OS Accounts charge for this request
    /// (user-supplied upstream key). Providers may then use their full-route
    /// client: the shortened metered window exists only to keep settlement
    /// inside the authorization hold, and there is no hold to protect.
    pub unmetered: bool,
}

/// What an image generator needs: a prompt, the model, optional pixel
/// dimensions, and provider credentials. Deliberately carries no user id,
/// so the provider sees only the inference inputs and the upstream key.
#[derive(Clone, Debug)]
pub struct ImageGenerationRequest {
    pub prompt: String,
    pub model: ModelId,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Venice `safe_mode` (blurs adult content). `None` leaves it unset so Venice
    /// applies its own default; a value forces it on/off. Carried so the on-device
    /// safe-mode setting can flow through to generation.
    pub safe_mode: Option<bool>,
    pub provider_credentials: ProviderCredentials,
}

/// What an image editor needs: the source image bytes (base64, no `data:`
/// prefix) plus its mime, the edit instruction, the model, optional Venice
/// safe mode, and provider credentials. Image editing is a SEPARATE
/// Venice endpoint and model catalog from generation, with a raw-binary
/// response, so it has its own domain type and provider rather than reusing
/// the generator.
#[derive(Clone, Debug)]
pub struct ImageEditRequest {
    pub image_base64: String,
    pub mime_type: String,
    pub prompt: String,
    pub model: ModelId,
    pub safe_mode: Option<bool>,
    pub provider_credentials: ProviderCredentials,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImage {
    /// Base64-encoded image bytes, no `data:` prefix. The frontend wraps this
    /// in a data URL for the existing inline image display path.
    pub image_base64: String,
    /// IANA mime of the encoded bytes, e.g. `image/png`.
    pub mime_type: String,
    pub model: String,
    pub provider: String,
}

/// What a text-to-video generation needs: a prompt, the model, Venice's
/// duration/resolution/aspect-ratio/audio knobs, and an optional negative
/// prompt. Deliberately carries no user id or caller key, so the provider sees
/// only the inference inputs and June's configured upstream key. Video is an
/// async job: this queues the job and returns a Venice queue handle, not the
/// bytes.
#[derive(Clone, Debug)]
pub struct VideoGenerationRequest {
    pub prompt: String,
    pub model: ModelId,
    /// Venice `duration` string enum ("1s".."30s", "1 gen", "Auto").
    pub duration: String,
    /// Venice `resolution` string enum ("256p".."2160p", "4k", ...). `None`
    /// leaves it to Venice's per-model default.
    pub resolution: Option<String>,
    /// Venice `aspect_ratio` string enum ("1:1", "16:9", ...).
    pub aspect_ratio: Option<String>,
    pub audio: Option<bool>,
    pub negative_prompt: Option<String>,
}

/// What an image-to-video (animate) job needs: the source image bytes (base64,
/// no `data:` prefix) plus its mime, a prompt, the model, and the same Venice
/// knobs as generation. Image-to-video is a SEPARATE Venice model catalog from
/// text-to-video (default `default_video_animate_model`), so it has its own
/// domain type mirroring `ImageEditRequest`.
#[derive(Clone, Debug)]
pub struct VideoAnimationRequest {
    pub image_base64: String,
    pub mime_type: String,
    pub prompt: String,
    pub model: ModelId,
    pub duration: String,
    pub resolution: Option<String>,
    pub aspect_ratio: Option<String>,
    pub audio: Option<bool>,
    pub negative_prompt: Option<String>,
}

/// The free Venice price oracle input: everything that shapes a video quote.
/// Carries no prompt and no credentials — the quote is June's own pricing
/// basis, always run against June's configured Venice key.
#[derive(Clone, Debug)]
pub struct VideoQuoteRequest {
    pub model: ModelId,
    pub duration: String,
    pub resolution: Option<String>,
    pub aspect_ratio: Option<String>,
    pub audio: Option<bool>,
}

/// A queued Venice video job: June's handle onto the async lifecycle. The
/// `download_url` is present only for VPS-backed models (a 24h pre-signed mp4
/// URL); otherwise the bytes come from `retrieve`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VideoQueued {
    pub venice_queue_id: String,
    pub download_url: Option<String>,
}

/// The outcome of a single Venice `retrieve` poll, discriminated by the
/// response `Content-Type` (application/json vs video/mp4).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VideoRetrieved {
    /// Still running. Venice reports timing estimates in milliseconds.
    Processing {
        average_execution_ms: u64,
        execution_ms: u64,
    },
    /// COMPLETED, non-VPS: the raw `video/mp4` bytes came back inline.
    CompletedBytes { bytes: Vec<u8>, mime_type: String },
    /// COMPLETED, VPS-backed: the retrieve returned JSON without bytes; the
    /// mp4 lives at a pre-signed URL. The URL may be empty here when Venice's
    /// retrieve response omits it — the service falls back to the `download_url`
    /// captured at queue time.
    CompletedUrl { download_url: String },
}

/// A generated video handed back from the service to the API boundary. Never
/// stored in the registry: `bytes` (when present) are fetched from Venice on
/// the completing poll and streamed straight to the HTTP response, so nothing
/// byte-sized is pinned in memory. `bytes` is `#[serde(skip)]` — the status
/// handler streams them as `video/mp4` rather than base64-through-JSON.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedVideo {
    #[serde(skip)]
    pub bytes: Option<Vec<u8>>,
    pub download_url: Option<String>,
    pub mime_type: String,
    pub model: String,
    pub provider: String,
    pub size_bytes: Option<u64>,
}

/// Which upstream engine Venice should run a web search against. Brave is the
/// default and runs under zero data retention; Google is anonymized and
/// proxied through Venice so the query is not associated with an identity.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchProvider {
    #[default]
    Brave,
    Google,
}

#[derive(Clone, Debug)]
pub struct WebSearchRequest {
    pub query: String,
    /// Number of results to return. The provider clamps this to its own bounds;
    /// `None` lets the provider apply its default.
    pub limit: Option<u32>,
    pub provider: WebSearchProvider,
    pub provider_credentials: ProviderCredentials,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResults {
    pub query: String,
    pub provider: String,
    pub results: Vec<WebSearchResult>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResult {
    pub title: String,
    pub url: String,
    /// A short snippet or description of the result, when the provider supplies
    /// one.
    pub snippet: Option<String>,
    /// Publication date as reported by the provider, when available.
    pub published_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct WebFetchRequest {
    pub url: String,
    pub provider_credentials: ProviderCredentials,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResult {
    pub url: String,
    /// The page rendered as markdown.
    pub content: String,
    /// The content format the provider returned (currently always `markdown`).
    pub format: String,
    pub provider: String,
}

#[derive(Clone, Debug)]
pub struct AuthorizeRequest {
    pub user_id: UserId,
    pub action: ActionSlug,
    pub estimate: Credits,
    pub hold_ttl_seconds: u64,
}

#[derive(Clone, Debug)]
pub struct ChargeRequest {
    pub action_token: String,
    pub credits: Credits,
    pub idempotency_key: String,
}

/// A user-submitted report from the desktop app, paired with the agent's
/// own diagnostic assessment of the issue when one was produced.
#[derive(Clone, Debug)]
pub struct IssueReport {
    pub user_id: UserId,
    pub category: Option<String>,
    pub description: String,
    pub agent_diagnosis: Option<String>,
    /// Names of everything the user attached, including local files whose
    /// bytes were unreadable or empty.
    pub attachment_names: Vec<String>,
    /// The readable attachment files, including screenshots and videos.
    pub attachments: Vec<IssueReportAttachment>,
    pub session_id: Option<String>,
    pub app_version: Option<String>,
    pub platform: Option<String>,
}

#[derive(Clone)]
pub struct IssueReportAttachment {
    pub name: String,
    pub content_type: String,
    pub bytes: bytes::Bytes,
}

/// Manual Debug: these can be large video payloads and must never be dumped
/// into logs or error messages.
impl std::fmt::Debug for IssueReportAttachment {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("IssueReportAttachment")
            .field("name", &self.name)
            .field("content_type", &self.content_type)
            .field("byte_len", &self.bytes.len())
            .finish()
    }
}

/// Outcome of delivering an issue report after June API accepted it.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct IssueReportDelivery {
    /// Names of files not attached to an issue in Open Software.
    pub unattached_names: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct P3aReport {
    pub product_slug: String,
    pub question_id: String,
    pub epoch: String,
    pub platform: String,
    pub version_series: String,
    pub bucket: u8,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum DomainError {
    #[error("model is not priced")]
    ModelNotPriced,
    #[error("insufficient credits")]
    InsufficientCredits,
    #[error("upstream provider failed")]
    UpstreamProvider,
    /// The metering/billing provider (OS Accounts) call failed or was rejected
    /// — distinct from an LLM provider failure so the two can be told apart at
    /// the API boundary and in logs.
    #[error("metering provider failed")]
    MeteringProvider,
    #[error("invalid input: {reason}")]
    InvalidInput { reason: String },
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum AuthError {
    #[error("missing bearer token")]
    MissingToken,
    #[error("invalid access token")]
    InvalidToken,
}

#[async_trait]
pub trait Transcriber: Send + Sync {
    async fn transcribe(&self, request: TranscriptionRequest) -> Result<Transcript, DomainError>;
}

#[async_trait]
pub trait Generator: Send + Sync {
    async fn generate(&self, request: GenerationRequest) -> Result<GeneratedNote, DomainError>;
}

#[async_trait]
pub trait Cleaner: Send + Sync {
    async fn cleanup(&self, request: CleanupRequest) -> Result<CleanedText, DomainError>;
}

#[async_trait]
pub trait AgentChatCompleter: Send + Sync {
    async fn complete(&self, request: AgentChatRequest)
    -> Result<AgentChatCompletion, DomainError>;

    async fn complete_stream(
        &self,
        request: AgentChatRequest,
    ) -> Result<AgentChatStream, DomainError>;
}

#[async_trait]
pub trait ImageGenerator: Send + Sync {
    async fn generate(
        &self,
        request: ImageGenerationRequest,
    ) -> Result<GeneratedImage, DomainError>;
}

#[async_trait]
pub trait ImageEditor: Send + Sync {
    async fn edit(&self, request: ImageEditRequest) -> Result<GeneratedImage, DomainError>;
}

/// Venice's asynchronous, dynamically priced video API. Quoting is free and is
/// June's price oracle; queueing starts an async job; retrieving polls it. The
/// provider does inference/transport only — billing (quote -> credits ->
/// authorize -> charge-once) lives in `VideoService`.
#[async_trait]
pub trait VideoProvider: Send + Sync {
    async fn quote(&self, request: VideoQuoteRequest) -> Result<f64, DomainError>;
    async fn queue(&self, request: VideoGenerationRequest) -> Result<VideoQueued, DomainError>;
    async fn queue_animation(
        &self,
        request: VideoAnimationRequest,
    ) -> Result<VideoQueued, DomainError>;
    async fn retrieve(&self, model: &str, queue_id: &str) -> Result<VideoRetrieved, DomainError>;
}

#[async_trait]
pub trait WebSearcher: Send + Sync {
    async fn search(&self, request: WebSearchRequest) -> Result<WebSearchResults, DomainError>;
}

#[async_trait]
pub trait WebFetcher: Send + Sync {
    async fn fetch(&self, request: WebFetchRequest) -> Result<WebFetchResult, DomainError>;
}

#[async_trait]
pub trait OsAccountsClient: Send + Sync {
    async fn authorize(&self, request: AuthorizeRequest) -> Result<Authorization, DomainError>;

    async fn charge(&self, request: ChargeRequest) -> Result<Receipt, DomainError>;
}

#[async_trait]
pub trait TokenVerifier: Send + Sync {
    async fn verify(&self, access_jwt: &str) -> Result<UserId, AuthError>;
}

#[async_trait]
pub trait IssueReportSink: Send + Sync {
    async fn deliver(&self, report: IssueReport) -> Result<IssueReportDelivery, DomainError>;
}

#[async_trait]
pub trait P3aSink: Send + Sync {
    async fn submit(&self, report: P3aReport) -> Result<(), DomainError>;
}

pub trait AudioDurationProbe: Send + Sync {
    fn probe(&self, audio: &[u8]) -> Result<Duration, DomainError>;
}

#[cfg(test)]
mod tests {
    use super::AudioFormat;

    #[test]
    fn audio_format_detects_mp4_containers_case_insensitively() {
        assert_eq!(AudioFormat::from_filename("clip.m4a"), AudioFormat::Mp4);
        assert_eq!(AudioFormat::from_filename("CLIP.M4A"), AudioFormat::Mp4);
        assert_eq!(AudioFormat::from_filename("video.mp4"), AudioFormat::Mp4);
        assert_eq!(AudioFormat::from_filename("take.wav"), AudioFormat::Wav);
        assert_eq!(AudioFormat::from_filename("noext"), AudioFormat::Wav);
    }

    #[test]
    fn upstream_filenames_never_echo_the_input() {
        // The canonical names are constants by construction; this pins the
        // exact strings providers send so a regression is loud.
        assert_eq!(AudioFormat::Wav.upstream_filename(), "audio.wav");
        assert_eq!(AudioFormat::Mp4.upstream_filename(), "audio.m4a");
        assert_eq!(AudioFormat::Wav.mime(), "audio/wav");
        assert_eq!(AudioFormat::Mp4.mime(), "audio/mp4");
    }
}
