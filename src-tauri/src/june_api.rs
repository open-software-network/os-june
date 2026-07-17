//! June API client. The Tauri side calls the backend for metered remote
//! actions. When the user explicitly selects a local model, text generation
//! uses their own OpenAI-compatible endpoint directly (bring your own
//! inference; any http/https host, optional bearer api key).

use crate::{
    domain::types::AppError,
    providers::{LocalGenerationSettings, PROVIDER_LOCAL, PROVIDER_OPENAI},
};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::AppHandle;

// The deployed production API (Phala dstack; see june-api/deploy/
// docker-compose.production.yml). NOT .network — that hostname has no DNS
// record, and the v0.0.3 DMG shipped pointing at it.
const DEFAULT_JUNE_API_URL: &str = "https://june-api.opensoftware.co";
// Nemotron Nano over GLM 5.2: dictation is latency-critical and nano runs
// ~0.8s per utterance vs GLM's 2-4s (12s outliers), which felt too slow in
// daily use. Known nano tradeoffs, accepted for speed: explicit unnumbered
// "make a list with" requests may still be listified (over-formatting, never
// word loss) and the formal style sometimes skips contraction expansion. No
// other catalog model beats it: everything smarter benchmarked 2-20x slower.
const DEFAULT_DICTATION_CLEANUP_MODEL: &str = "nvidia-nemotron-3-nano-30b-a3b";
// Mirrors June API's authoritative 600-second request deadline.
const HTTP_TIMEOUT: Duration = Duration::from_secs(600);
// Adds 300 seconds of client-only grace around that server deadline for a
// large request-body transfer and the terminal SSE event. This is not a
// second server budget.
const ISSUE_REPORT_MULTIPART_TIMEOUT: Duration = Duration::from_secs(900);
const AGENT_HTTP_TIMEOUT: Duration = Duration::from_secs(600);
const AGENT_PROXY_MAX_MESSAGES: usize = 64;
const AGENT_PROXY_MAX_INSTRUCTION_MESSAGES: usize = 4;
// Mirrors the public June API validation cap. Hermes may request a larger
// per-call output budget than the backend accepts, which otherwise trips a
// validation error that it misclassifies as prompt context overflow.
const AGENT_PROXY_MAX_OUTPUT_TOKENS: u64 = 32_768;
/// Internal Hermes model id used to carry a per-run Auto preference through
/// session-scoped `config.set`. June's on-device provider proxy rewrites it
/// before forwarding, so June API never sees this implementation detail.
const AGENT_RUN_AUTO_MODEL_PREFIX: &str = "__june_auto_generation__:";
/// Internal Hermes model id that preserves an explicitly remote selection
/// even when a configured local endpoint exposes the same raw model id.
const AGENT_RUN_REMOTE_MODEL_PREFIX: &str = "__june_remote_generation__:";
/// The frontend's synthetic catalog id prefix for the local model option
/// (`LOCAL_GENERATION_OPTION_ID_PREFIX` in `src/lib/local-generation.ts`).
const LOCAL_GENERATION_OPTION_ID_PREFIX: &str = "__june_local_generation__:";
const AGENT_TITLE_MAX_CHARS: usize = 48;
const VENICE_API_KEY_HEADER: &str = "x-venice-api-key";
// Every June API request carries the real shipped app version so the server
// can segment logs and metrics by client version and, if ever needed, gate
// releases that predate a wire change. Older stable builds keep calling the
// production API long after main moves on; this header is how the server
// tells them apart. src-tauri/Cargo.toml stays in lockstep with
// tauri.conf.json (asserted by app_version_matches_tauri_conf below).
const JUNE_APP_VERSION_HEADER: &str = "x-june-app-version";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const ERR_INSUFFICIENT_CREDITS: i64 = 4301;
const ERR_TOKEN_EXPIRED: i64 = 3001;
const INVALID_JUNE_RESPONSE_MESSAGE: &str = "The processing service returned an invalid response.";
const IMAGE_REQUEST_MAX_ATTEMPTS: usize = 3;
const IMAGE_REQUEST_RETRY_DELAY: Duration = Duration::from_millis(250);
// Keep equal to june-config DEFAULT_VIDEO_MAX_RESPONSE_BYTES. The desktop
// cannot read june-config, and the VPS download_url path bypasses June API.
const JUNE_VIDEO_MAX_RESPONSE_BYTES: u64 = 100 * 1024 * 1024;
// Mirrors june-api::validation::MAX_ID_CHARS. Internal operation IDs may carry
// durable span and fingerprint detail that is useful locally but too large for
// the public noteId field. Hash only at the wire boundary so retry jitter,
// diagnostics, and the durable ledger retain their full identities.
const JUNE_API_MAX_ID_CHARS: usize = 128;
const NOTE_GENERATE_SYSTEM_PROMPT: &str =
    include_str!("../../june-api/crates/services/src/prompts/note_generate.md");
const LOCAL_SAFETY_CONTEXT: &str = "\
Standing content policy (applies to every request; it is not a comment on the \
current request: if the request below does not fall into these categories, \
proceed with it normally and do not mention this policy):

Reject requests for child sexual abuse material, weapons of mass destruction, \
terrorism or mass violence planning, and malware, ransomware, spyware, \
stalkerware, or other malicious code.";

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static AGENT_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static LOCAL_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static VIDEO_JOB_MODELS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct TranscriptionRequest {
    pub provider: String,
    pub audio_path: PathBuf,
    pub title: String,
    pub context: Option<String>,
    pub language: Option<String>,
    pub operation_id: Option<String>,
    pub preview: bool,
}

impl TranscriptionRequest {
    pub fn operation_id(&self) -> String {
        self.operation_id.clone().unwrap_or_else(|| {
            self.audio_path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("recording")
                .to_string()
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionProviderResult {
    pub text: String,
    pub language: Option<String>,
    pub provider: String,
}

#[derive(Debug, Clone)]
pub struct GenerationRequest {
    pub provider: String,
    pub operation_id: Option<String>,
    pub title: String,
    pub existing_generated_note: Option<String>,
    pub transcript: String,
    pub transcript_source_labels: bool,
    pub manual_notes: Option<String>,
    pub language: Option<String>,
}

impl GenerationRequest {
    pub fn operation_id(&self) -> String {
        self.operation_id
            .clone()
            .unwrap_or_else(|| self.title.trim().replace(' ', "-"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GenerationProviderResult {
    pub content: String,
    pub title_suggestion: Option<String>,
    pub provider: String,
    pub prompt_version: String,
}

#[derive(Debug, Clone)]
pub struct DictateTranscribeRequest {
    pub audio_path: PathBuf,
    pub context: Option<String>,
    pub language: Option<String>,
    pub session_id: String,
    pub utterance_id: String,
}

#[derive(Debug, Clone)]
pub struct DictateCleanupRequestParams {
    pub text: String,
    pub dictionary_context: Option<String>,
    /// Where the cleaned text will be inserted ("email"); lays the output
    /// out for that surface. None means no special layout.
    pub app_context: Option<String>,
    pub style: String,
    pub session_id: String,
    pub utterance_id: String,
}

/// Response from the agent chat-completions proxy. Holds the upstream
/// reqwest response so callers can forward body bytes as they arrive
/// (Hermes requests `stream: true`) instead of buffering the whole
/// generation before the first token is visible.
pub struct AgentChatCompletionsResponse {
    pub status: u16,
    pub content_type: String,
    upstream: reqwest::Response,
}

impl AgentChatCompletionsResponse {
    /// Next chunk of the upstream body as it arrives. Returns `Ok(None)`
    /// once the body is complete.
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>, AppError> {
        Ok(self
            .upstream
            .chunk()
            .await
            .map_err(network_error)?
            .map(|chunk| chunk.to_vec()))
    }

    /// Buffer the entire body. For small non-streamed responses such as
    /// session-title suggestions.
    pub async fn collect_body(self) -> Result<Vec<u8>, AppError> {
        Ok(self.upstream.bytes().await.map_err(network_error)?.to_vec())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelDto {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub model_type: String,
    pub description: Option<String>,
    pub privacy: Option<String>,
    pub pricing: Option<serde_json::Value>,
    pub context_tokens: Option<i64>,
    pub traits: Vec<String>,
    pub capabilities: Vec<String>,
    pub price_unit: String,
    pub price_description: String,
    pub credits_per_million_seconds: Option<u64>,
    pub input_credits_per_million_tokens: Option<u64>,
    pub output_credits_per_million_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct ApiEnvelope<T> {
    data: Option<T>,
    success: bool,
    error_code: Option<i64>,
    message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeResponse {
    text: String,
    language: Option<String>,
    provider: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateResponse {
    content: String,
    title_suggestion: Option<String>,
    provider: String,
    prompt_version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupResponse {
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerateBody {
    note_id: String,
    prompt_version: String,
    title: String,
    transcript: String,
    transcript_source_labels: bool,
    manual_notes: Option<String>,
    language: Option<String>,
    existing_generated_note: Option<String>,
    model: String,
    cost_quality: Option<f64>,
    stream: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DictateCleanupBody {
    session_id: String,
    utterance_id: String,
    text: String,
    dictionary_context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    app_context: Option<String>,
    style: String,
    model: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct P3aReportRequest {
    pub schema: u32,
    pub question_id: String,
    pub epoch: String,
    pub platform: String,
    pub version_series: String,
    pub bucket: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct P3aReportBody {
    schema: u32,
    question_id: String,
    epoch: String,
    platform: String,
    version_series: String,
    bucket: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct P3aReportResponse {
    accepted: bool,
}

pub async fn transcribe_saved_audio(
    request: TranscriptionRequest,
) -> Result<TranscriptionProviderResult, AppError> {
    let audio = read_audio(&request.audio_path).await?;
    let filename = filename_for_audio(&request.audio_path, "recording.wav");
    let model = crate::providers::transcription_model();
    let send_venice_api_key = model_accepts_venice_api_key(&model);
    let mut form = Form::new()
        .text("noteId", june_api_operation_id(&request.operation_id()))
        .text("title", title_or_placeholder(&request.title))
        .text("model", model)
        .part("audio", audio_part(audio, &filename, &request.audio_path)?);
    if request.preview {
        form = form.text("preview", "true");
    }
    if let Some(context) = request
        .context
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        form = form.text("context", context.to_string());
    }
    if let Some(language) = normalized_language(request.language.as_deref()) {
        form = form.text("language", language.to_string());
    }
    let response: TranscribeResponse =
        post_multipart("/v1/notes/transcribe", form, send_venice_api_key).await?;
    Ok(TranscriptionProviderResult {
        text: response.text,
        language: response.language,
        provider: response.provider,
    })
}

pub async fn generate_note_from_transcript(
    request: GenerationRequest,
) -> Result<GenerationProviderResult, AppError> {
    let transcript = request.transcript.trim();
    if transcript.is_empty() {
        return Err(AppError::new(
            "transcription_empty",
            "Transcript is empty, so a note cannot be generated.",
        ));
    }
    if crate::providers::generation_provider() == PROVIDER_LOCAL {
        return generate_note_from_transcript_local(request).await;
    }
    let model = crate::providers::generation_model();
    let send_venice_api_key = model_accepts_venice_api_key(&model);
    let body = GenerateBody {
        note_id: june_api_operation_id(&request.operation_id()),
        prompt_version: crate::domain::processing::PROMPT_VERSION.to_string(),
        title: title_or_placeholder(&request.title),
        transcript: transcript.to_string(),
        transcript_source_labels: request.transcript_source_labels,
        manual_notes: request.manual_notes,
        language: request.language,
        existing_generated_note: request.existing_generated_note,
        model,
        cost_quality: (crate::providers::generation_model()
            == crate::providers::AUTO_GENERATION_MODEL)
            .then(crate::providers::cost_quality),
        stream: true,
    };
    let response: GenerateResponse =
        post_generate_note("/v1/notes/generate", &body, send_venice_api_key).await?;
    Ok(GenerationProviderResult {
        content: response.content,
        title_suggestion: response.title_suggestion,
        provider: response.provider,
        prompt_version: response
            .prompt_version
            .unwrap_or_else(|| crate::domain::processing::PROMPT_VERSION.to_string()),
    })
}

pub async fn dictate_transcribe(
    request: DictateTranscribeRequest,
) -> Result<TranscriptionProviderResult, AppError> {
    let audio = read_audio(&request.audio_path).await?;
    let filename = filename_for_audio(&request.audio_path, "dictation.wav");
    let model = crate::providers::transcription_model();
    let send_venice_api_key = model_accepts_venice_api_key(&model);
    let form = Form::new()
        .text("sessionId", request.session_id)
        .text("utteranceId", request.utterance_id)
        .text("model", model)
        .part("audio", audio_part(audio, &filename, &request.audio_path)?);
    let mut form = form;
    if let Some(context) = request
        .context
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        form = form.text("context", context.to_string());
    }
    if let Some(language) = normalized_language(request.language.as_deref()) {
        form = form.text("language", language.to_string());
    }
    let response: TranscribeResponse =
        post_multipart("/v1/dictate", form, send_venice_api_key).await?;
    Ok(TranscriptionProviderResult {
        text: response.text,
        language: response.language,
        provider: response.provider,
    })
}

fn normalized_language(language: Option<&str>) -> Option<&str> {
    language.map(str::trim).filter(|value| {
        value.len() == 2
            && value
                .chars()
                .all(|character| character.is_ascii_lowercase())
    })
}

pub async fn cleanup_text(params: DictateCleanupRequestParams) -> Result<String, AppError> {
    let model = DEFAULT_DICTATION_CLEANUP_MODEL.to_string();
    let send_venice_api_key = model_accepts_venice_api_key(&model);
    let body = DictateCleanupBody {
        session_id: params.session_id,
        utterance_id: params.utterance_id,
        text: params.text,
        dictionary_context: params.dictionary_context,
        app_context: params.app_context,
        style: params.style,
        model,
    };
    let response: CleanupResponse =
        post_json("/v1/dictate/cleanup", &body, send_venice_api_key).await?;
    Ok(response.text)
}

pub async fn submit_p3a_report(request: P3aReportRequest) -> Result<(), AppError> {
    let body = P3aReportBody {
        schema: request.schema,
        question_id: request.question_id,
        epoch: request.epoch,
        platform: request.platform,
        version_series: request.version_series,
        bucket: request.bucket,
    };
    let response: P3aReportResponse = post_json("/v1/p3a/reports", &body, false).await?;
    if response.accepted {
        Ok(())
    } else {
        Err(AppError::new(
            "p3a_report_rejected",
            "Telemetry report was rejected.",
        ))
    }
}

pub async fn list_models(model_type: &str) -> Result<Vec<ModelDto>, AppError> {
    let url = format!("{}/v1/models", june_api_url());
    let response = http_client()
        .get(url)
        .query(&[("type", model_type)])
        .send()
        .await
        .map_err(network_error)?;
    parse_response("/v1/models", response).await
}

// ---- Private sharing (JUN-308) -------------------------------------------
// Owner-side proxy for the /v1/shares endpoints. The client only ever moves
// ciphertext, IVs, envelopes, and metadata here; plaintext and keys stay in
// the webview (src/lib/share-crypto.ts).

use crate::domain::types::{
    ShareCreateRequest, ShareCreatedDto, ShareDto, ShareInvitePayload, ShareInvitesAddedDto,
    ShareSummaryDto,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareAddInvitesBody<'a> {
    invites: &'a [ShareInvitePayload],
}

pub async fn share_create(request: &ShareCreateRequest) -> Result<ShareCreatedDto, AppError> {
    post_json("/v1/shares", request, false).await
}

pub async fn share_list() -> Result<Vec<ShareSummaryDto>, AppError> {
    get_json("/v1/shares").await
}

pub async fn share_get(share_id: &str) -> Result<ShareDto, AppError> {
    get_json(&format!("/v1/shares/{share_id}")).await
}

pub async fn share_add_invites(
    share_id: &str,
    invites: &[ShareInvitePayload],
) -> Result<ShareInvitesAddedDto, AppError> {
    post_json(
        &format!("/v1/shares/{share_id}/invites"),
        &ShareAddInvitesBody { invites },
        false,
    )
    .await
}

pub async fn share_revoke_invite(share_id: &str, invite_id: &str) -> Result<(), AppError> {
    delete_expect_success(&format!("/v1/shares/{share_id}/invites/{invite_id}")).await
}

pub async fn share_delete(share_id: &str) -> Result<(), AppError> {
    delete_expect_success(&format!("/v1/shares/{share_id}")).await
}

/// One generated image from the June API `/v1/image/generate` endpoint. The
/// bytes arrive base64-encoded so the frontend can wrap them in a data URL for
/// the existing inline image display path.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImageDto {
    pub image_base64: String,
    pub mime_type: String,
    pub model: String,
    pub provider: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageGenerateBody {
    prompt: String,
    model: String,
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    safe_mode: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageEditBody {
    image: String,
    prompt: String,
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    safe_mode: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoJobDto {
    pub job_id: String,
}

#[derive(Clone, Debug)]
pub struct VideoGenerateParams {
    pub prompt: String,
    pub model: String,
    pub request_id: Option<String>,
    pub duration: String,
    pub resolution: Option<String>,
    pub aspect_ratio: Option<String>,
    pub audio: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoGenerateBody {
    prompt: String,
    model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    duration: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    aspect_ratio: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    audio: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum VideoStatusDto {
    Processing {
        average_execution_ms: u64,
        execution_ms: u64,
    },
    Completed {
        path: String,
        mime_type: String,
        size_bytes: u64,
        model: String,
    },
    Failed {
        reason: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum VideoStatusApiDto {
    Processing {
        average_execution_ms: u64,
        execution_ms: u64,
    },
    Completed {
        download_url: Option<String>,
        mime_type: String,
        model: String,
        #[allow(dead_code)]
        provider: String,
        size_bytes: Option<u64>,
    },
    Failed {
        reason: String,
    },
}

/// Forwards a prompt to June API image generation with the user's access token.
/// `safe_mode` carries the on-device setting (blur adult content); `None` leaves
/// it unset so June API applies its own default.
pub async fn generate_image(
    prompt: String,
    model: String,
    safe_mode: Option<bool>,
    request_id: Option<String>,
) -> Result<GeneratedImageDto, AppError> {
    let send_venice_api_key = model_accepts_venice_api_key(&model);
    post_json_image_retryable(
        "/v1/image/generate",
        &ImageGenerateBody {
            prompt,
            model,
            request_id: request_id.unwrap_or_else(new_image_request_id),
            safe_mode,
        },
        send_venice_api_key,
    )
    .await
}

/// Edits an existing image through June API. The edit model is optional; when it
/// is absent June API uses its default image-edit model, matching the MCP tool.
pub async fn edit_image(
    image: String,
    prompt: String,
    mime_type: Option<String>,
    model: Option<String>,
    safe_mode: Option<bool>,
    request_id: Option<String>,
) -> Result<GeneratedImageDto, AppError> {
    post_json_image_retryable(
        "/v1/image/edit",
        &ImageEditBody {
            image,
            prompt,
            request_id: request_id.unwrap_or_else(new_image_request_id),
            model,
            mime_type,
            safe_mode,
        },
        true,
    )
    .await
}

fn new_image_request_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub async fn video_generate(params: VideoGenerateParams) -> Result<VideoJobDto, AppError> {
    let model = params.model.clone();
    let job: VideoJobDto = post_json(
        "/v1/video/generate",
        &VideoGenerateBody {
            prompt: params.prompt,
            model: params.model,
            request_id: params.request_id,
            duration: params.duration,
            resolution: params.resolution,
            aspect_ratio: params.aspect_ratio,
            audio: params.audio,
        },
        false,
    )
    .await?;
    remember_video_job_model(&job.job_id, &model);
    Ok(job)
}

pub async fn video_status(app: &AppHandle, job_id: String) -> Result<VideoStatusDto, AppError> {
    let path = format!("/v1/video/status/{job_id}");
    let response = authed_send(&path, false, |client, url, token| {
        client.get(url).bearer_auth(token)
    })
    .await?;
    video_status_from_response(app, &path, response).await
}

async fn video_status_from_response(
    app: &AppHandle,
    path: &str,
    response: reqwest::Response,
) -> Result<VideoStatusDto, AppError> {
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    if status.is_success() && content_type.to_ascii_lowercase().contains("video/mp4") {
        // Terminal status observed: forget the job before the fallible read/write
        // so an oversized, unreadable, or unwritable video still leaves the map
        // bounded (matching the JSON-completed and failed paths below).
        let model = take_video_job_model(job_id_from_status_path(path));
        let bytes = read_video_response_bytes(response).await?;
        let (local_path, size_bytes) = write_video_bytes(app, &bytes).await?;
        return Ok(VideoStatusDto::Completed {
            path: local_path,
            mime_type: "video/mp4".to_string(),
            size_bytes,
            model,
        });
    }

    let retry_after_ms = response_retry_after_ms(&response);
    let body = response.text().await.map_err(network_error)?;
    let status: VideoStatusApiDto = parse_response_body(path, status, retry_after_ms, &body)?;
    match status {
        VideoStatusApiDto::Processing {
            average_execution_ms,
            execution_ms,
        } => Ok(VideoStatusDto::Processing {
            average_execution_ms,
            execution_ms,
        }),
        VideoStatusApiDto::Failed { reason } => {
            // Terminal: this job will never be polled again, so drop its label.
            take_video_job_model(job_id_from_status_path(path));
            Ok(VideoStatusDto::Failed { reason })
        }
        VideoStatusApiDto::Completed {
            download_url,
            mime_type,
            model,
            size_bytes,
            ..
        } => {
            // Terminal: the model comes from the response here, so the remembered
            // fallback is no longer needed — forget it to keep the map bounded.
            take_video_job_model(job_id_from_status_path(path));
            let url = download_url.ok_or_else(|| {
                AppError::new(
                    "video_download_missing",
                    "June returned a completed video without downloadable media.",
                )
            })?;
            let bytes = download_video_bytes(&url).await?;
            let (path, written_size_bytes) = write_video_bytes(app, &bytes).await?;
            Ok(VideoStatusDto::Completed {
                path,
                mime_type,
                size_bytes: size_bytes.unwrap_or(written_size_bytes),
                model,
            })
        }
    }
}

async fn download_video_bytes(url: &str) -> Result<Vec<u8>, AppError> {
    let (parsed, validated_addrs) = crate::video_download_url::validate_video_download_url(url)
        .map_err(|message| AppError::new("video_download_url_rejected", message))?;
    let client =
        crate::video_download_url::video_download_client_builder(&parsed, &validated_addrs)
            .map_err(|message| AppError::new("video_download_url_rejected", message))?
            .timeout(HTTP_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .user_agent("os-june-video-download/0.1")
            .build()
            .map_err(network_error)?;
    let response = client.get(parsed).send().await.map_err(network_error)?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::new(
            "video_download_failed",
            format!("Video download returned status {}.", status.as_u16()),
        ));
    }
    read_video_response_bytes(response).await
}

async fn write_video_bytes(app: &AppHandle, bytes: &[u8]) -> Result<(String, u64), AppError> {
    reject_oversized_video_bytes(bytes.len() as u64)?;
    let videos_dir = crate::app_paths::app_data_dir(app)
        .map_err(|error| AppError::new("video_write_failed", error.to_string()))?
        .join("hermes")
        .join("videos");
    fs::create_dir_all(&videos_dir)
        .map_err(|error| AppError::new("video_write_failed", error.to_string()))?;
    let path = videos_dir.join(generated_video_filename());
    fs::write(&path, bytes)
        .map_err(|error| AppError::new("video_write_failed", error.to_string()))?;
    Ok((path.to_string_lossy().into_owned(), bytes.len() as u64))
}

async fn read_video_response_bytes(mut response: reqwest::Response) -> Result<Vec<u8>, AppError> {
    if response
        .content_length()
        .is_some_and(|len| len > JUNE_VIDEO_MAX_RESPONSE_BYTES)
    {
        return Err(video_too_large_error());
    }
    let capacity = response
        .content_length()
        .and_then(|len| usize::try_from(len).ok())
        .unwrap_or(0);
    let mut bytes = Vec::with_capacity(capacity);
    let mut total = 0_u64;
    loop {
        let chunk = response.chunk().await.map_err(network_error)?;
        let Some(chunk) = chunk else {
            break;
        };
        total = total
            .checked_add(chunk.len() as u64)
            .ok_or_else(video_too_large_error)?;
        if total > JUNE_VIDEO_MAX_RESPONSE_BYTES {
            return Err(video_too_large_error());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn reject_oversized_video_bytes(size_bytes: u64) -> Result<(), AppError> {
    if size_bytes > JUNE_VIDEO_MAX_RESPONSE_BYTES {
        return Err(video_too_large_error());
    }
    Ok(())
}

fn video_too_large_error() -> AppError {
    AppError::new(
        "video_too_large",
        "The generated video is too large for June to retrieve.",
    )
}

fn generated_video_filename() -> String {
    format!("generated-video-{}.mp4", uuid::Uuid::new_v4().simple())
}

fn video_job_models() -> &'static Mutex<HashMap<String, String>> {
    VIDEO_JOB_MODELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember_video_job_model(job_id: &str, model: &str) {
    if let Ok(mut models) = video_job_models().lock() {
        models.insert(job_id.to_string(), model.to_string());
    }
}

/// Removes and returns the model remembered for `job_id`, if any.
///
/// Called on every terminal status (completed or failed) so the map stays
/// bounded to in-flight jobs rather than growing once per generated video.
fn take_video_job_model(job_id: &str) -> String {
    video_job_models()
        .lock()
        .ok()
        .and_then(|mut models| models.remove(job_id))
        .unwrap_or_default()
}

fn job_id_from_status_path(path: &str) -> &str {
    path.rsplit_once('/')
        .map(|(_, job_id)| job_id)
        .unwrap_or(path)
}

pub async fn proxy_agent_chat_completions(
    mut body: serde_json::Value,
) -> Result<AgentChatCompletionsResponse, AppError> {
    let local_settings = crate::providers::local_generation_settings();
    let route = agent_generation_route(
        &body,
        &local_settings,
        &crate::providers::generation_provider(),
    )?;
    normalize_agent_chat_request_for_proxy(&mut body);
    // Route from the tagged model Hermes stored for this session, not from a
    // mutable process-wide provider setting. Every inference in one agent run
    // therefore keeps the route selected at its prompt boundary.
    if route == AgentGenerationRoute::Local {
        return proxy_local_agent_chat_completions(body).await;
    }
    let send_venice_api_key = body_model_accepts_venice_api_key(&body);
    let url = format!("{}/v1/chat/completions", june_api_url());
    let mut token = crate::os_accounts::access_token().await?;
    for attempt in 0..2 {
        let request = agent_http_client()
            .post(&url)
            .bearer_auth(&token)
            .json(&body);
        let response = with_venice_api_key("/v1/chat/completions", request, send_venice_api_key)
            .send()
            .await
            .map_err(network_error)?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            token = crate::os_accounts::refresh_access_token().await?;
            continue;
        }
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/json")
            .to_string();
        return Ok(AgentChatCompletionsResponse {
            status,
            content_type,
            upstream: response,
        });
    }
    Err(AppError::new("unauthorized", "Not signed in."))
}

async fn generate_note_from_transcript_local(
    request: GenerationRequest,
) -> Result<GenerationProviderResult, AppError> {
    let settings = local_generation_settings_or_error()?;
    let title_hint = request.title.trim();
    let user_message = format!(
        "Current title: {}\nDetected language: {}\n\n{}",
        if title_hint.is_empty() {
            "New note"
        } else {
            title_hint
        },
        request.language.as_deref().unwrap_or("unknown"),
        generation_source_text(
            request.existing_generated_note.as_deref(),
            request.manual_notes.as_deref(),
            request.transcript.trim(),
            request.transcript_source_labels,
        )
    );
    let body = serde_json::json!({
        "model": settings.model_id,
        "messages": [
            { "role": "system", "content": LOCAL_SAFETY_CONTEXT },
            { "role": "system", "content": NOTE_GENERATE_SYSTEM_PROMPT.trim() },
            { "role": "user", "content": user_message }
        ]
    });
    let local_request = with_local_auth(
        local_http_client().post(local_chat_completions_url(&settings)?),
        &settings,
    );
    let response = local_request
        .json(&body)
        .send()
        .await
        .map_err(network_error)?;
    let status = response.status();
    let body = response.bytes().await.map_err(network_error)?;
    if !status.is_success() {
        return Err(AppError::new(
            "local_model_failed",
            format!("Local model returned status {}.", status.as_u16()),
        ));
    }
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|error| AppError::new("local_model_invalid", error.to_string()))?;
    let content = extract_chat_completion_text(&value)
        .map(|text| {
            if request.transcript_source_labels {
                cleanup_generated_note_text(&text, request.transcript.trim())
            } else {
                text
            }
        })
        .filter(|text| !text.is_empty())
        .ok_or_else(|| {
            AppError::new(
                "local_model_empty",
                "Local model did not return generated note text.",
            )
        })?;
    Ok(GenerationProviderResult {
        content,
        title_suggestion: Some(if title_hint.is_empty() {
            "New note".to_string()
        } else {
            title_hint.to_string()
        }),
        provider: PROVIDER_LOCAL.to_string(),
        prompt_version: crate::domain::processing::PROMPT_VERSION.to_string(),
    })
}

async fn proxy_local_agent_chat_completions(
    mut body: serde_json::Value,
) -> Result<AgentChatCompletionsResponse, AppError> {
    let settings = local_generation_settings_or_error()?;
    if let Some(object) = body.as_object_mut() {
        object.insert(
            "model".to_string(),
            serde_json::Value::String(settings.model_id.clone()),
        );
        inject_local_safety_context(object);
    }
    let request = with_local_auth(
        local_http_client().post(local_chat_completions_url(&settings)?),
        &settings,
    );
    let response = request.json(&body).send().await.map_err(network_error)?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    Ok(AgentChatCompletionsResponse {
        status,
        content_type,
        upstream: response,
    })
}

fn local_generation_settings_or_error() -> Result<LocalGenerationSettings, AppError> {
    let settings = crate::providers::local_generation_settings();
    if settings.base_url.trim().is_empty() || settings.model_id.trim().is_empty() {
        return Err(AppError::new(
            "local_model_not_configured",
            "Configure a local model endpoint and model ID first.",
        ));
    }
    Ok(settings)
}

/// Attaches `Authorization: Bearer {api_key}` when the user configured an api
/// key for their local endpoint (Ollama needs none; vLLM / LiteLLM / a hosted
/// gateway may). No header is sent when the key is empty.
fn with_local_auth(
    request: reqwest::RequestBuilder,
    settings: &LocalGenerationSettings,
) -> reqwest::RequestBuilder {
    let api_key = settings.api_key.trim();
    if api_key.is_empty() {
        request
    } else {
        request.bearer_auth(api_key)
    }
}

fn local_chat_completions_url(settings: &LocalGenerationSettings) -> Result<String, AppError> {
    let base_url = settings.base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err(AppError::new(
            "local_model_not_configured",
            "Configure a local model endpoint first.",
        ));
    }
    Ok(format!("{base_url}/chat/completions"))
}

fn inject_local_safety_context(object: &mut serde_json::Map<String, serde_json::Value>) {
    let Some(messages) = object
        .get_mut("messages")
        .and_then(|value| value.as_array_mut())
    else {
        return;
    };
    messages.insert(
        0,
        serde_json::json!({ "role": "system", "content": LOCAL_SAFETY_CONTEXT }),
    );
}

/// A buffered June API response forwarded verbatim to the local web MCP.
pub struct WebProxyResponse {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

/// Forwards a web tool request (`/v1/web/search` or `/v1/web/fetch`) to the
/// June API with the user's access token, returning the raw response so the
/// caller can pass the `ApiResponse` envelope straight through. The access
/// token never leaves this process; the MCP only ever talks to the loopback
/// proxy.
pub async fn forward_web_request(
    path: &str,
    body: &serde_json::Value,
) -> Result<WebProxyResponse, AppError> {
    let response = authed_send(path, true, |client, url, token| {
        client.post(url).bearer_auth(token).json(body)
    })
    .await?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let bytes = response.bytes().await.map_err(network_error)?;
    Ok(WebProxyResponse {
        status,
        content_type,
        body: bytes.to_vec(),
    })
}

/// Forwards an image tool request (`/v1/image/generate` or `/v1/image/edit`) to
/// the June API with the user's access token, returning the raw response so the
/// loopback proxy can pass the metered envelope straight through to the local
/// image MCP. Same token-injection guarantee as the web proxy path: the access
/// token never leaves this process.
pub async fn forward_image_request(
    path: &str,
    body: &serde_json::Value,
) -> Result<WebProxyResponse, AppError> {
    forward_web_request(path, body).await
}

/// Forwards a video tool request to June API with the user's token. Video is
/// June-key-only in the first cut, so this path deliberately never forwards a
/// locally configured Venice inference key.
pub async fn forward_video_request(
    path: &str,
    body: Option<&serde_json::Value>,
) -> Result<WebProxyResponse, AppError> {
    let response = authed_send(path, false, |client, url, token| match body {
        Some(body) => client.post(url).bearer_auth(token).json(body),
        None => client.get(url).bearer_auth(token),
    })
    .await?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let bytes = if content_type.to_ascii_lowercase().contains("video/mp4") {
        read_video_response_bytes(response).await?
    } else {
        response.bytes().await.map_err(network_error)?.to_vec()
    };
    Ok(WebProxyResponse {
        status,
        content_type,
        body: bytes,
    })
}

fn limit_agent_chat_messages_for_proxy(body: &mut serde_json::Value) {
    limit_agent_chat_messages(body, AGENT_PROXY_MAX_MESSAGES);
}

fn normalize_agent_chat_request_for_proxy(body: &mut serde_json::Value) {
    limit_agent_chat_messages_for_proxy(body);
    let Some(object) = body.as_object_mut() else {
        return;
    };
    let has_request_model = object
        .get("model")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .map(|model| !model.is_empty())
        .unwrap_or(false);
    if !has_request_model {
        object.insert(
            "model".to_string(),
            serde_json::Value::String(crate::providers::generation_model()),
        );
    }
    let mut request_model = object
        .get("model")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    for prefix in [
        AGENT_RUN_REMOTE_MODEL_PREFIX,
        LOCAL_GENERATION_OPTION_ID_PREFIX,
    ] {
        if request_model.starts_with(prefix) {
            if let Some(decoded) = decode_tagged_model(&request_model, prefix) {
                request_model = decoded;
                object.insert(
                    "model".to_string(),
                    serde_json::Value::String(request_model.clone()),
                );
            }
            break;
        }
    }
    let auto_cost_quality =
        if let Some(encoded) = request_model.strip_prefix(AGENT_RUN_AUTO_MODEL_PREFIX) {
            Some(
                encoded
                    .parse::<u8>()
                    .ok()
                    .filter(|value| *value <= 100)
                    .map_or_else(crate::providers::cost_quality, |value| {
                        f64::from(value) / 100.0
                    }),
            )
        } else if request_model == crate::providers::AUTO_GENERATION_MODEL {
            Some(crate::providers::cost_quality())
        } else {
            None
        };
    if let Some(cost_quality) = auto_cost_quality {
        object.insert(
            "model".to_string(),
            serde_json::Value::String(crate::providers::AUTO_GENERATION_MODEL.to_string()),
        );
        object.insert(
            "auto".to_string(),
            serde_json::json!({
                "cost_quality": cost_quality
            }),
        );
    }
    clamp_agent_chat_output_tokens(object, "max_tokens");
    clamp_agent_chat_output_tokens(object, "max_completion_tokens");
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AgentGenerationRoute {
    Local,
    Remote,
}

fn decode_tagged_model(model: &str, prefix: &str) -> Option<String> {
    let encoded = model.strip_prefix(prefix)?;
    let decoded = urlencoding::decode(encoded).ok()?.trim().to_string();
    (!decoded.is_empty()).then_some(decoded)
}

/// Resolve provider provenance before normalization removes internal tags.
/// New June sessions are always tagged. The raw-id comparison remains only
/// for sessions created by older app versions, where provenance was not
/// persisted and a configured local match is the safest compatibility choice.
fn agent_generation_route(
    body: &serde_json::Value,
    settings: &LocalGenerationSettings,
    global_provider: &str,
) -> Result<AgentGenerationRoute, AppError> {
    let requested_model = body
        .as_object()
        .and_then(|object| object.get("model"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let local_model_id = settings.model_id.trim();
    if requested_model.starts_with(LOCAL_GENERATION_OPTION_ID_PREFIX) {
        let selected_local_model =
            decode_tagged_model(requested_model, LOCAL_GENERATION_OPTION_ID_PREFIX).ok_or_else(
                || {
                    AppError::new(
                "local_model_invalid",
                "The local model selected for this session is invalid. Choose the model again.",
            )
                },
            )?;
        if settings.base_url.trim().is_empty() || selected_local_model != local_model_id {
            return Err(AppError::new(
                "local_model_unavailable",
                "The local model selected for this session is no longer configured. Reconfigure it or choose another model.",
            ));
        }
        return Ok(AgentGenerationRoute::Local);
    }
    if requested_model.starts_with(AGENT_RUN_REMOTE_MODEL_PREFIX) {
        decode_tagged_model(requested_model, AGENT_RUN_REMOTE_MODEL_PREFIX).ok_or_else(|| {
            AppError::new(
                "remote_model_invalid",
                "The model selected for this session is invalid. Choose the model again.",
            )
        })?;
        return Ok(AgentGenerationRoute::Remote);
    }
    if requested_model.starts_with(AGENT_RUN_AUTO_MODEL_PREFIX)
        || requested_model == crate::providers::AUTO_GENERATION_MODEL
    {
        return Ok(AgentGenerationRoute::Remote);
    }
    if requested_model.is_empty() {
        return Ok(if global_provider == PROVIDER_LOCAL {
            AgentGenerationRoute::Local
        } else {
            AgentGenerationRoute::Remote
        });
    }
    Ok(
        if !settings.base_url.trim().is_empty()
            && !local_model_id.is_empty()
            && requested_model == local_model_id
        {
            AgentGenerationRoute::Local
        } else {
            AgentGenerationRoute::Remote
        },
    )
}

fn clamp_agent_chat_output_tokens(
    object: &mut serde_json::Map<String, serde_json::Value>,
    field: &str,
) {
    let Some(value) = object.get_mut(field) else {
        return;
    };
    if output_tokens_exceeds_proxy_cap(value) {
        *value = serde_json::Value::Number(AGENT_PROXY_MAX_OUTPUT_TOKENS.into());
    }
}

fn output_tokens_exceeds_proxy_cap(value: &serde_json::Value) -> bool {
    if let Some(tokens) = value.as_u64() {
        return tokens > AGENT_PROXY_MAX_OUTPUT_TOKENS;
    }
    if let Some(tokens) = value.as_i64() {
        return tokens > AGENT_PROXY_MAX_OUTPUT_TOKENS as i64;
    }
    if let Some(tokens) = value.as_f64() {
        return tokens > AGENT_PROXY_MAX_OUTPUT_TOKENS as f64;
    }
    false
}

fn limit_agent_chat_messages(body: &mut serde_json::Value, max_messages: usize) {
    let Some(messages) = body
        .as_object_mut()
        .and_then(|object| object.get_mut("messages"))
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    if max_messages == 0 || messages.len() <= max_messages {
        return;
    }

    let instruction_count = messages
        .iter()
        .take_while(|message| is_agent_instruction_message(message))
        .count();
    let mut next_messages = messages
        .iter()
        .take(instruction_count.min(AGENT_PROXY_MAX_INSTRUCTION_MESSAGES))
        .cloned()
        .collect::<Vec<_>>();
    let remaining_capacity = max_messages.saturating_sub(next_messages.len());

    let tail = agent_message_chunks(&messages[instruction_count..]);
    let mut suffix = Vec::new();
    let mut suffix_len = 0usize;
    for chunk in tail.into_iter().rev() {
        // Always keep the most recent chunk (the latest turn plus its tool
        // results), even when it alone exceeds the budget — otherwise the
        // request would go out with only system/developer messages.
        // Truncate older chunks instead.
        if !suffix.is_empty() && suffix_len + chunk.len() > remaining_capacity {
            break;
        }
        suffix_len += chunk.len();
        suffix.push(chunk);
    }
    suffix.reverse();

    for chunk in suffix {
        next_messages.extend(chunk);
    }
    drop_leading_orphan_tool_messages(&mut next_messages);
    *messages = next_messages;
}

fn is_agent_instruction_message(message: &serde_json::Value) -> bool {
    matches!(agent_message_role(message), Some("system" | "developer"))
}

fn agent_message_chunks(messages: &[serde_json::Value]) -> Vec<Vec<serde_json::Value>> {
    let mut chunks = Vec::new();
    let mut index = 0usize;
    while index < messages.len() {
        let message = &messages[index];
        let mut chunk = vec![message.clone()];
        index += 1;

        if agent_message_role(message) == Some("assistant") {
            let tool_call_ids = agent_tool_call_ids(message);
            if !tool_call_ids.is_empty() {
                while index < messages.len()
                    && agent_tool_message_matches(&messages[index], &tool_call_ids)
                {
                    chunk.push(messages[index].clone());
                    index += 1;
                }
            }
        }

        chunks.push(chunk);
    }
    chunks
}

fn agent_message_role(message: &serde_json::Value) -> Option<&str> {
    message.get("role").and_then(serde_json::Value::as_str)
}

fn agent_tool_call_ids(message: &serde_json::Value) -> Vec<String> {
    message
        .get("tool_calls")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool_call| tool_call.get("id").and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .collect()
}

fn agent_tool_message_matches(message: &serde_json::Value, tool_call_ids: &[String]) -> bool {
    if agent_message_role(message) != Some("tool") {
        return false;
    }
    message
        .get("tool_call_id")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|id| tool_call_ids.iter().any(|candidate| candidate == id))
}

fn drop_leading_orphan_tool_messages(messages: &mut Vec<serde_json::Value>) {
    loop {
        let first_non_instruction = messages
            .iter()
            .position(|message| !is_agent_instruction_message(message));
        let Some(index) = first_non_instruction else {
            return;
        };
        if agent_message_role(&messages[index]) != Some("tool") {
            return;
        }
        messages.remove(index);
    }
}

const AGENT_SESSION_TITLE_SYSTEM_PROMPT: &str = "Name this agent session for the user's primary intent or topic. The user request is authoritative. Use an assistant reply excerpt only as secondary context to clarify concrete work, never as the title's point of view. Do not title an acknowledgement, conversational preamble, clarification question, or other wording from the assistant reply. If the user request is already clear, base the title on it even when the assistant asks a follow-up question. Example: for the request 'tell me about my calendar' and reply 'Sure! Which calendar service are you using?', return 'Calendar overview'. Return only a concrete 2 to 5 word title in sentence case: capitalize the first word and proper nouns only, never every word. Avoid first person, words like please/help/you, trailing ellipses, quotes, punctuation wrappers, markdown, or explanations.";

pub async fn suggest_agent_session_title(
    prompt: &str,
    response: Option<&str>,
) -> Result<String, AppError> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(AppError::new(
            "agent_title_empty",
            "Cannot title an empty agent request.",
        ));
    }
    let user_content = agent_session_title_user_content(prompt, response);
    let response = proxy_agent_chat_completions(serde_json::json!({
        "messages": [
            {
                "role": "system",
                "content": AGENT_SESSION_TITLE_SYSTEM_PROMPT
            },
            {
                "role": "user",
                "content": user_content
            }
        ],
        "temperature": 0.1,
        // Sized for reasoning models: hidden thinking spends from the same
        // budget as the 2-to-5-word title, and a cap hit mid-think yields no
        // title at all.
        "max_tokens": 500
    }))
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(AppError::new(
            "agent_title_failed",
            format!("Title generation returned status {}.", response.status),
        ));
    }
    let body = response.collect_body().await?;
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|error| AppError::new("agent_title_invalid", error.to_string()))?;
    let text = extract_chat_completion_text(&value).ok_or_else(|| {
        AppError::new(
            "agent_title_invalid",
            "Title generation did not return text.",
        )
    })?;
    clean_agent_session_title(&text).ok_or_else(|| {
        AppError::new(
            "agent_title_empty",
            "Title generation returned an empty title.",
        )
    })
}

/// One-shot YES/NO classification: does this image prompt request explicit
/// (adult) content? Language-agnostic - this backs the /image consent gate
/// where no model is otherwise in the loop. Metered like any agent chat.
pub async fn classify_image_prompt_explicit(prompt: &str) -> Result<bool, AppError> {
    if prompt.trim().is_empty() {
        return Err(AppError::new(
            "image_prompt_classification_empty",
            "Cannot classify an empty image prompt.",
        ));
    }
    let response = proxy_agent_chat_completions(serde_json::json!({
        "messages": [
            {
                "role": "system",
                "content": "You are a strict content classifier for an image generator. The user message is an image-generation prompt, in any language. Answer with exactly one word: YES if it requests adult, sexual, nude, or otherwise explicit content; NO otherwise. Answer NO when the request is ambiguous or benign."
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        "temperature": 0,
        // Sized for reasoning models: hidden thinking spends from the same
        // budget as the one-word answer, and a cap hit mid-think yields no
        // classification at all.
        "max_tokens": 500
    }))
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(AppError::new(
            "image_prompt_classification_failed",
            format!(
                "Image prompt classification returned status {}.",
                response.status
            ),
        ));
    }
    let body = response.collect_body().await?;
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|error| AppError::new("image_prompt_classification_invalid", error.to_string()))?;
    let text = extract_chat_completion_text(&value).ok_or_else(|| {
        AppError::new(
            "image_prompt_classification_invalid",
            "Image prompt classification did not return text.",
        )
    })?;
    parse_explicit_classification(&text).ok_or_else(|| {
        AppError::new(
            "image_prompt_classification_invalid",
            "Image prompt classification did not return YES or NO.",
        )
    })
}

fn parse_explicit_classification(text: &str) -> Option<bool> {
    let text = text
        .trim()
        .trim_matches(|character: char| !character.is_alphanumeric())
        .trim();
    let lower = text.to_ascii_lowercase();
    if lower.starts_with("yes") {
        Some(true)
    } else if lower.starts_with("no") {
        Some(false)
    } else {
        None
    }
}

pub async fn submit_issue_report(
    request: &crate::domain::types::SubmitIssueReportRequest,
    app_version: &str,
) -> Result<crate::domain::types::SubmitIssueReportResponse, AppError> {
    let description = request.description.trim();
    if description.is_empty() {
        return Err(AppError::new(
            "issue_report_empty",
            "Cannot send an empty issue report.",
        ));
    }

    let IssueAttachmentParts {
        parts,
        included_names,
        skipped_names,
    } = issue_attachment_parts(&request.attachment_paths).await?;
    let mut form = issue_report_form(request, app_version);
    for part in parts {
        form = form.part("attachment", part);
    }

    let first_response = send_multipart("/v1/issue-reports", form, false).await?;
    let status = first_response.status();
    let retry_after_ms = response_retry_after_ms(&first_response);
    if status.is_success() && response_is_event_stream(&first_response) {
        let mut response: crate::domain::types::SubmitIssueReportResponse =
            parse_sse_response("/v1/issue-reports", first_response).await?;
        merge_skipped_attachment_names(&mut response, skipped_names);
        return Ok(response);
    }
    let body = first_response.text().await.map_err(network_error)?;

    if issue_report_needs_names_only_retry(status, &body) {
        // Older June API deployments and a lower production ingress limit can
        // reject a body containing files. Rebuild the form once without file
        // parts so the issue report is still delivered with attachment names.
        let mut omitted_names = request.attachment_names.clone();
        extend_unique_names(&mut omitted_names, skipped_names);
        extend_unique_names(&mut omitted_names, included_names);
        let retry_response = send_multipart(
            "/v1/issue-reports",
            issue_report_form(request, app_version),
            false,
        )
        .await?;
        let mut response: crate::domain::types::SubmitIssueReportResponse =
            parse_json_or_sse_response("/v1/issue-reports", retry_response).await?;
        merge_skipped_attachment_names(&mut response, omitted_names);
        return Ok(response);
    }

    let mut response: crate::domain::types::SubmitIssueReportResponse =
        parse_response_body("/v1/issue-reports", status, retry_after_ms, &body)?;
    merge_skipped_attachment_names(&mut response, skipped_names);
    Ok(response)
}

fn issue_report_form(
    request: &crate::domain::types::SubmitIssueReportRequest,
    app_version: &str,
) -> Form {
    let mut form = Form::new()
        .text("description", request.description.trim().to_string())
        .text("appVersion", app_version.to_string())
        .text("platform", std::env::consts::OS)
        // Keep-alive comments prevent ingress idle timeouts while June API
        // forwards platform-sized files to Open Software.
        .text("stream", "true");
    if let Some(category) = request
        .category
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        form = form.text("category", category.to_string());
    }
    if let Some(session_id) = request
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        form = form.text("sessionId", session_id.to_string());
    }
    if let Some(diagnosis) = request
        .agent_diagnosis
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        form = form.text("agentDiagnosis", diagnosis.to_string());
    }
    for name in &request.attachment_names {
        form = form.text("attachmentName", name.clone());
    }
    form
}

fn issue_report_needs_names_only_retry(status: reqwest::StatusCode, body: &str) -> bool {
    if status == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
        return true;
    }
    if status != reqwest::StatusCode::BAD_REQUEST {
        return false;
    }
    serde_json::from_str::<ApiEnvelope<serde_json::Value>>(body)
        .ok()
        .and_then(|envelope| envelope.message)
        .is_some_and(|message| {
            matches!(message.as_str(), "multipart_invalid" | "payload_too_large")
        })
}

fn extend_unique_names(names: &mut Vec<String>, additional: impl IntoIterator<Item = String>) {
    for name in additional {
        if !names.contains(&name) {
            names.push(name);
        }
    }
}

fn merge_skipped_attachment_names(
    response: &mut crate::domain::types::SubmitIssueReportResponse,
    local_names: Vec<String>,
) {
    let mut combined = Vec::new();
    extend_unique_names(&mut combined, local_names);
    extend_unique_names(
        &mut combined,
        std::mem::take(&mut response.skipped_attachment_names),
    );
    response.skipped_attachment_names = combined;
}

fn issue_attachment_filename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "attachment".to_string())
}

const ISSUE_ATTACHMENT_MAX_BYTES: u64 = 300 * 1024 * 1024;
const ISSUE_ATTACHMENTS_TOTAL_MAX_BYTES: u64 = 300 * 1024 * 1024;

struct IssueAttachmentParts {
    parts: Vec<Part>,
    included_names: Vec<String>,
    skipped_names: Vec<String>,
}

/// Builds one streaming multipart part per readable, non-empty attachment.
///
/// Metadata is checked before a file is opened for streaming so an unreadable,
/// empty, or over-budget file does not block the report or allocate its entire
/// contents. The cumulative byte budget mirrors June API's single-request
/// attachment allowance and prevents the desktop from building a form June API
/// must reject. Every skipped file remains represented by its `attachmentName`.
async fn issue_attachment_parts(paths: &[String]) -> Result<IssueAttachmentParts, AppError> {
    let mut parts = Vec::new();
    let mut included_names = Vec::new();
    let mut skipped_names = Vec::new();
    let mut included_bytes = 0_u64;
    for path in paths {
        let filename = issue_attachment_filename(path);
        let metadata = match tokio::fs::metadata(path).await {
            Ok(metadata) => metadata,
            Err(error) => {
                eprintln!("skipping unreadable issue report attachment {path}: {error}");
                skipped_names.push(filename);
                continue;
            }
        };
        let file_bytes = metadata.len();
        if !metadata.is_file() || file_bytes == 0 {
            eprintln!("skipping empty issue report attachment {path}");
            skipped_names.push(filename);
            continue;
        }
        if file_bytes > ISSUE_ATTACHMENT_MAX_BYTES
            || included_bytes.saturating_add(file_bytes) > ISSUE_ATTACHMENTS_TOTAL_MAX_BYTES
        {
            eprintln!("skipping over-budget issue report attachment {path}: {file_bytes} bytes");
            skipped_names.push(filename);
            continue;
        }
        let part = match Part::file(path).await {
            Ok(part) => part,
            Err(error) => {
                eprintln!("skipping unreadable issue report attachment {path}: {error}");
                skipped_names.push(filename);
                continue;
            }
        };
        let part = part
            .file_name(filename.clone())
            .mime_str(issue_attachment_mime(path))
            .map_err(|error| AppError::new("issue_report_attachment_invalid", error.to_string()))?;
        included_bytes += file_bytes;
        included_names.push(filename);
        parts.push(part);
    }
    Ok(IssueAttachmentParts {
        parts,
        included_names,
        skipped_names,
    })
}

fn issue_attachment_mime(path: &str) -> &'static str {
    let extension = Path::new(path)
        .extension()
        .map(|extension| extension.to_string_lossy().to_lowercase());
    match extension.as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("heic") => "image/heic",
        Some("mp4") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("m4v") => "video/x-m4v",
        Some("webm") => "video/webm",
        Some("pdf") => "application/pdf",
        Some("txt" | "log") => "text/plain",
        _ => "application/octet-stream",
    }
}

/// Plain-language explanation of a pending approval request, written by the
/// generation model. The agent runtime is parked waiting on the approval, so
/// this is a one-shot side call — it never touches the paused session.
pub async fn explain_agent_approval(
    description: &str,
    command: Option<&str>,
) -> Result<String, AppError> {
    let description = description.trim();
    let command = command.map(str::trim).filter(|value| !value.is_empty());
    if description.is_empty() && command.is_none() {
        return Err(AppError::new(
            "approval_explanation_empty",
            "There is nothing to explain for this approval request.",
        ));
    }
    let mut request_text = format!("Permission request: {description}");
    if let Some(command) = command {
        request_text.push_str("\nExact command or action:\n");
        request_text.push_str(command);
    }
    let response = proxy_agent_chat_completions(serde_json::json!({
        "messages": [
            {
                "role": "system",
                "content": "An AI agent paused mid-task to ask its user for permission. Explain what this specific request would actually do, in plain language the user can act on: name the files, hosts, or data involved, decode any flags or shell syntax, and call out anything risky or hard to undo (deleting or overwriting files, sending data off the machine, spending money). Keep it as short as the request allows: a few sentences for a simple command, short paragraphs (separated by blank lines) only when the request genuinely needs them. Never be generic, never use markdown or headings, and never tell the user which button to press."
            },
            {
                "role": "user",
                "content": request_text
            }
        ],
        "temperature": 0.2,
        // Generous on purpose: reasoning models spend hidden thinking from
        // this same budget (a 220-token cap once cut the visible answer off
        // mid-word), and a complex script can legitimately need several
        // paragraphs to explain. A one-shot side call is cheap; a truncated
        // safety explanation is not.
        "max_tokens": 8000
    }))
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(AppError::new(
            "approval_explanation_failed",
            format!(
                "Explanation generation returned status {}.",
                response.status
            ),
        ));
    }
    let body = response.collect_body().await?;
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|error| AppError::new("approval_explanation_invalid", error.to_string()))?;
    let text = extract_chat_completion_text(&value).ok_or_else(|| {
        AppError::new(
            "approval_explanation_invalid",
            "Explanation generation did not return text.",
        )
    })?;
    let explanation = text.trim();
    if explanation.is_empty() {
        return Err(AppError::new(
            "approval_explanation_empty",
            "Explanation generation returned an empty explanation.",
        ));
    }
    Ok(explanation.to_string())
}

pub fn dictation_provider_for_model(model_id: &str) -> &'static str {
    crate::providers::transcription_provider_for_model(model_id)
}

pub fn configured() -> bool {
    !june_api_url().is_empty()
}

/// Public URL of the attestation walkthrough the backend serves from inside
/// its confidential VM — same origin every metered request already goes to.
pub fn verify_url() -> String {
    format!("{}/verify", june_api_url())
}

/// Origin that share links point at (`{origin}/s/{share_id}#…`). The viewer
/// is served by june-api, so this is the same base every metered request
/// already goes to.
pub fn share_base_url() -> String {
    june_api_url()
}

/// Final assistant text from a chat completion, normalized for reasoning
/// models: inline `<think>` blocks are stripped, and when generation stopped
/// at the token cap (`finish_reason: "length"`) the text is cut back to its
/// last complete sentence so the UI never shows a mid-word fragment. Returns
/// `None` when nothing presentable survives (e.g. the cap landed inside an
/// unterminated think block), which callers surface as a generation error.
fn extract_chat_completion_text(value: &serde_json::Value) -> Option<String> {
    let choice = value.get("choices")?.as_array()?.first()?;
    let content = choice.get("message")?.get("content")?.as_str()?;
    let text = strip_think_blocks(content);
    let truncated = choice
        .get("finish_reason")
        .and_then(serde_json::Value::as_str)
        == Some("length");
    let text = if truncated {
        trim_to_sentence_boundary(&text)
    } else {
        text.trim().to_string()
    };
    (!text.is_empty()).then_some(text)
}

/// Removes `<think>...</think>` spans some reasoning models inline into
/// `content`. An unterminated `<think>` means the token cap landed inside the
/// reasoning itself, so nothing after it is an answer; drop it all.
fn strip_think_blocks(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find("<think>") {
        out.push_str(&rest[..start]);
        match rest[start..].find("</think>") {
            Some(end) => rest = &rest[start + end + "</think>".len()..],
            None => return out.trim().to_string(),
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// Cuts capped output back to its last sentence terminator. A fragment with
/// no terminator has no complete sentence to keep, so it yields an empty
/// string rather than a mid-word cutoff.
fn trim_to_sentence_boundary(text: &str) -> String {
    let trimmed = text.trim_end();
    match trimmed.rfind(['.', '!', '?']) {
        Some(index) => trimmed[..=index].trim().to_string(),
        None => String::new(),
    }
}

fn generation_source_text(
    existing_generated_note: Option<&str>,
    manual_notes: Option<&str>,
    transcript: &str,
    transcript_source_labels: bool,
) -> String {
    let mut sections = Vec::new();
    if let Some(existing_generated_note) = existing_generated_note
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        sections.push(format!(
            "<existing_generated_note_context>\n{existing_generated_note}\n</existing_generated_note_context>"
        ));
    }
    if let Some(manual_notes) = manual_notes
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        sections.push(format!(
            "<new_manual_notes_context>\n{manual_notes}\n</new_manual_notes_context>"
        ));
    }
    if transcript_source_labels {
        sections.push(
            "<transcript_source_metadata>\nTranscript lines may begin with source labels such as Microphone: or System:. These labels identify the audio source only. They are not spoken words and must not appear in the generated note.\n</transcript_source_metadata>".to_string(),
        );
    }
    sections.push(format!(
        "<new_transcript>\n{}\n</new_transcript>",
        transcript.trim()
    ));
    let output_contract = if transcript_source_labels {
        "Return only the new note block for the new transcript. Do not repeat existing note content. Do not output manual note labels or transcript source labels. Do not add wrapper headings."
    } else {
        "Return only the new note block for the new transcript. Do not repeat existing note content. Do not output manual note labels. Do not add wrapper headings."
    };
    sections.push(format!(
        "<output_contract>\n{output_contract}\n</output_contract>"
    ));
    sections.join("\n\n")
}

fn cleanup_generated_note_text(text: &str, labeled_transcript: &str) -> String {
    let spoken_lines = labeled_transcript_spoken_lines(labeled_transcript);
    text.lines()
        .map(|line| strip_generated_source_label(line, &spoken_lines))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn strip_generated_source_label(line: &str, spoken_lines: &[String]) -> String {
    let trimmed = line.trim_start();
    let indent_len = line.len() - trimmed.len();
    let indent = &line[..indent_len];
    let (markdown_marker, text) = markdown_line_marker(trimmed);
    let Some(rest) = strip_source_label_prefix(text) else {
        return line.to_string();
    };
    let stripped = rest.trim_start();
    if spoken_lines
        .iter()
        .any(|spoken| spoken.eq_ignore_ascii_case(stripped))
    {
        format!("{indent}{markdown_marker}{stripped}")
    } else {
        line.to_string()
    }
}

fn labeled_transcript_spoken_lines(labeled_transcript: &str) -> Vec<String> {
    labeled_transcript
        .lines()
        .filter_map(|line| strip_source_label_prefix(line.trim_start()))
        .map(|line| line.trim_start().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

fn markdown_line_marker(value: &str) -> (&str, &str) {
    let bytes = value.as_bytes();
    let heading_len = bytes.iter().take_while(|byte| **byte == b'#').count();
    if (1..=6).contains(&heading_len) && bytes.get(heading_len) == Some(&b' ') {
        return value.split_at(heading_len + 1);
    }
    if bytes.len() >= 2 && matches!(bytes[0], b'-' | b'*' | b'+' | b'>') && bytes[1] == b' ' {
        return value.split_at(2);
    }
    let digit_len = bytes
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digit_len > 0
        && matches!(bytes.get(digit_len), Some(b'.' | b')'))
        && bytes.get(digit_len + 1) == Some(&b' ')
    {
        return value.split_at(digit_len + 2);
    }
    ("", value)
}

fn strip_source_label_prefix(value: &str) -> Option<&str> {
    let lower = value.to_ascii_lowercase();
    for prefix in ["microphone:", "system:"] {
        if lower.starts_with(prefix) {
            return Some(&value[prefix.len()..]);
        }
    }
    None
}

fn agent_session_title_user_content(prompt: &str, response: Option<&str>) -> String {
    let prompt = prompt.trim();
    let Some(response) = response.map(str::trim).filter(|value| !value.is_empty()) else {
        return prompt.to_string();
    };
    // 1200 chars keeps the excerpt a few hundred tokens: enough signal to name
    // the work, small enough that the reply never drowns out the request or
    // crowds the shared max_tokens budget. The frontend caps to the same
    // length before invoking; this cap is the trust-boundary backstop.
    let response: String = response.chars().take(1200).collect();
    format!(
        "Primary user intent (authoritative):\n{prompt}\n\nSecondary assistant context (clarification only):\n{response}"
    )
}

fn clean_agent_session_title(value: &str) -> Option<String> {
    let mut title = value
        .trim()
        .trim_matches(|ch: char| ch == '"' || ch == '\'' || ch == '`')
        .replace(['\r', '\n'], " ");
    let label_prefixes = ["Title:", "Session title:", "Request:"];
    loop {
        let mut changed = false;
        for prefix in label_prefixes {
            if title.to_lowercase().starts_with(&prefix.to_lowercase()) {
                title = title[prefix.len()..].trim_start().to_string();
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    title = title
        .trim()
        .trim_matches(|ch: char| ch == '"' || ch == '\'' || ch == '`')
        .trim()
        .to_string();
    if !is_valid_agent_session_title_candidate(&title) {
        return None;
    }
    let request_prefixes = [
        "Please ",
        "Can you ",
        "Could you ",
        "Would you ",
        "Help me to ",
        "Help me ",
        "I want you to ",
        "I want to ",
        "I need you to ",
        "I need to ",
        "I'd like you to ",
        "I'd like to ",
        "Ask June to ",
        "Have June ",
    ];
    loop {
        let mut changed = false;
        for prefix in request_prefixes {
            if title.to_lowercase().starts_with(&prefix.to_lowercase()) {
                title = title[prefix.len()..].trim_start().to_string();
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    title = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|ch: char| ch == '"' || ch == '\'' || ch == '`')
        .trim_end_matches(['.', ':', '-'])
        .trim()
        .to_string();
    if title.is_empty() {
        return None;
    }
    if title.chars().count() > AGENT_TITLE_MAX_CHARS {
        let truncated: String = title.chars().take(AGENT_TITLE_MAX_CHARS).collect();
        let boundary = if title
            .chars()
            .nth(AGENT_TITLE_MAX_CHARS)
            .is_some_and(char::is_whitespace)
        {
            Some(truncated.len())
        } else {
            truncated.rfind(char::is_whitespace)
        };
        let boundary = boundary.unwrap_or(truncated.len());
        title = truncated[..boundary]
            .trim_end()
            .trim_end_matches(|ch: char| ch.is_ascii_punctuation() || matches!(ch, '–' | '—' | '…'))
            .trim_end()
            .to_string();
    }
    is_valid_agent_session_title_candidate(&title).then_some(title)
}

fn is_valid_agent_session_title_candidate(value: &str) -> bool {
    let normalized = value.trim().replace(['‘', '’'], "'").to_lowercase();
    if normalized.is_empty() || normalized.contains('?') {
        return false;
    }
    let dialogue_prefixes = [
        "i'm sorry",
        "i am sorry",
        "i'm unable",
        "i am unable",
        "i can't",
        "i cannot",
        "i won't",
        "i don't",
        "i do not",
        "i found",
        "i fixed",
        "i updated",
        "i created",
        "i completed",
        "i finished",
        "i wrote",
        "i added",
        "i removed",
        "i changed",
        "i checked",
        "i reviewed",
        "i traced",
        "sorry",
        "as an ai",
        "sure",
        "certainly",
        "of course",
        "here's",
        "here is",
        "here are",
        "unable to help",
        "unable to assist",
        "unable to comply",
    ];
    if dialogue_prefixes
        .iter()
        .any(|prefix| starts_with_title_phrase(&normalized, prefix))
        || ["can't help", "cannot help", "can't assist", "cannot assist"]
            .iter()
            .any(|phrase| normalized.contains(phrase))
    {
        return false;
    }
    let mut words = normalized
        .split(|character: char| !character.is_ascii_alphanumeric() && character != '\'')
        .filter(|word| !word.is_empty());
    let first = words.next().unwrap_or_default();
    let second = words.next().unwrap_or_default();
    let question_words = ["who", "what", "when", "where", "why", "how"];
    let question_auxiliaries = [
        "could",
        "would",
        "should",
        "do",
        "does",
        "did",
        "is",
        "are",
        "am",
        "have",
        "has",
        "was",
        "were",
        "had",
        "must",
        "shall",
        "can't",
        "couldn't",
        "wouldn't",
        "shouldn't",
        "don't",
        "doesn't",
        "didn't",
        "isn't",
        "aren't",
        "won't",
        "haven't",
        "hasn't",
        "wasn't",
        "weren't",
        "mustn't",
        "shan't",
    ];
    let ambiguous_question_auxiliaries = ["can", "will", "may", "might"];
    let question_subjects = [
        "i", "you", "we", "he", "she", "it", "they", "june", "this", "that", "these", "those",
        "there", "the", "a", "an", "my", "your", "our", "his", "her", "their",
    ];
    let is_how_to_title = first == "how" && second == "to";
    !(first == "which"
        || (question_words.contains(&first) && !is_how_to_title)
        || question_auxiliaries.contains(&first)
        || (ambiguous_question_auxiliaries.contains(&first) && question_subjects.contains(&second)))
}

fn starts_with_title_phrase(value: &str, phrase: &str) -> bool {
    value.strip_prefix(phrase).is_some_and(|suffix| {
        suffix.is_empty()
            || suffix
                .chars()
                .next()
                .is_some_and(|character| character.is_whitespace() || ",:;.!".contains(character))
    })
}

async fn post_json<T, B>(path: &str, body: &B, send_venice_api_key: bool) -> Result<T, AppError>
where
    T: for<'de> Deserialize<'de>,
    B: Serialize,
{
    let response = authed_send(path, send_venice_api_key, |client, url, token| {
        client.post(url).bearer_auth(token).json(body)
    })
    .await?;
    parse_response(path, response).await
}

async fn get_json<T>(path: &str) -> Result<T, AppError>
where
    T: for<'de> Deserialize<'de>,
{
    let response = authed_send(path, false, |client, url, token| {
        client.get(url).bearer_auth(token)
    })
    .await?;
    parse_response(path, response).await
}

/// Sends an authenticated DELETE and accepts any success envelope, with or
/// without a `data` payload. Failure envelopes map through the same error
/// handling as every other June API call.
async fn delete_expect_success(path: &str) -> Result<(), AppError> {
    let response = authed_send(path, false, |client, url, token| {
        client.delete(url).bearer_auth(token)
    })
    .await?;
    let status = response.status();
    let retry_after_ms = response_retry_after_ms(&response);
    let body = response.text().await.map_err(network_error)?;
    match parse_response_body::<serde_json::Value>(path, status, retry_after_ms, &body) {
        Ok(_) => Ok(()),
        // `success: true` with no `data` is still a success for a DELETE.
        Err(error) if error.code == "empty_response" => Ok(()),
        Err(error) => Err(error),
    }
}

async fn post_generate_note<B>(
    path: &str,
    body: &B,
    send_venice_api_key: bool,
) -> Result<GenerateResponse, AppError>
where
    B: Serialize,
{
    let response = authed_send(path, send_venice_api_key, |client, url, token| {
        client.post(url).bearer_auth(token).json(body)
    })
    .await?;
    parse_json_or_sse_response(path, response).await
}

fn response_is_event_stream(response: &reqwest::Response) -> bool {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase())
        .is_some_and(|value| value.starts_with("text/event-stream"))
}

async fn parse_json_or_sse_response<T>(
    path: &str,
    response: reqwest::Response,
) -> Result<T, AppError>
where
    T: for<'de> Deserialize<'de>,
{
    if response.status().is_success() && response_is_event_stream(&response) {
        return parse_sse_response(path, response).await;
    }
    parse_response(path, response).await
}

async fn parse_sse_response<T>(path: &str, mut response: reqwest::Response) -> Result<T, AppError>
where
    T: for<'de> Deserialize<'de>,
{
    let mut parser = ApiSseParser::default();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if let Some(event) = parser.push(&chunk)? {
            return parse_sse_terminal_event(path, event);
        }
    }
    if let Some(event) = parser.finish()? {
        return parse_sse_terminal_event(path, event);
    }
    Err(api_stream_ended_unexpectedly())
}

fn parse_sse_terminal_event<T>(path: &str, event: ApiTerminalEvent) -> Result<T, AppError>
where
    T: for<'de> Deserialize<'de>,
{
    match event {
        ApiTerminalEvent::Result(body) => {
            parse_response_body(path, reqwest::StatusCode::OK, None, &body)
        }
        ApiTerminalEvent::Error {
            status,
            body,
            retry_after_secs,
        } => {
            let status =
                reqwest::StatusCode::from_u16(status).unwrap_or(reqwest::StatusCode::BAD_GATEWAY);
            // The streamed error's retry hint replaces the buffered path's
            // Retry-After header (headers can't follow a committed 200), so
            // both paths surface the same details.retryAfterMs.
            let retry_after_ms = retry_after_secs.map(|secs| secs.saturating_mul(1000));
            parse_response_body(path, status, retry_after_ms, &body.to_string())
        }
    }
}

fn api_stream_ended_unexpectedly() -> AppError {
    AppError::new(
        "june_request_failed",
        "The processing service response stream ended unexpectedly.",
    )
}

#[derive(Debug, PartialEq)]
enum ApiTerminalEvent {
    Result(String),
    Error {
        status: u16,
        body: serde_json::Value,
        retry_after_secs: Option<u64>,
    },
}

#[derive(Default)]
struct ApiSseParser {
    buffer: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
}

impl ApiSseParser {
    fn push(&mut self, chunk: &[u8]) -> Result<Option<ApiTerminalEvent>, AppError> {
        self.buffer.extend_from_slice(chunk);
        while let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line = self.buffer.drain(..=newline).collect::<Vec<_>>();
            let line = line.strip_suffix(b"\n").unwrap_or(&line);
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            let line = std::str::from_utf8(line).map_err(|error| {
                AppError::new(
                    "june_api_response_invalid",
                    format!("The response stream contained invalid UTF-8: {error}"),
                )
            })?;
            if let Some(event) = self.push_line(line)? {
                return Ok(Some(event));
            }
        }
        Ok(None)
    }

    fn finish(&mut self) -> Result<Option<ApiTerminalEvent>, AppError> {
        if !self.buffer.is_empty() {
            let line = std::str::from_utf8(&self.buffer).map_err(|error| {
                AppError::new(
                    "june_api_response_invalid",
                    format!("The response stream contained invalid UTF-8: {error}"),
                )
            })?;
            let line = line.strip_suffix('\r').unwrap_or(line).to_string();
            self.buffer.clear();
            if let Some(event) = self.push_line(&line)? {
                return Ok(Some(event));
            }
        }
        Ok(None)
    }

    fn push_line(&mut self, line: &str) -> Result<Option<ApiTerminalEvent>, AppError> {
        if line.is_empty() {
            return self.dispatch();
        }
        if line.starts_with(':') {
            return Ok(None);
        }
        if let Some(value) = line.strip_prefix("event:") {
            self.event = Some(sse_field_value(value).to_string());
            return Ok(None);
        }
        if let Some(value) = line.strip_prefix("data:") {
            self.data.push(sse_field_value(value).to_string());
        }
        Ok(None)
    }

    fn dispatch(&mut self) -> Result<Option<ApiTerminalEvent>, AppError> {
        let event = self.event.take();
        if self.data.is_empty() {
            return Ok(None);
        }
        let data = std::mem::take(&mut self.data).join("\n");
        match event.as_deref() {
            Some("result") => Ok(Some(ApiTerminalEvent::Result(data))),
            Some("error") => {
                let error: ApiStreamError = serde_json::from_str(&data).map_err(|error| {
                    tracing::warn!(
                        body_bytes = data.len(),
                        %error,
                        "june api returned an invalid response stream error"
                    );
                    AppError::new("june_api_response_invalid", INVALID_JUNE_RESPONSE_MESSAGE)
                })?;
                Ok(Some(ApiTerminalEvent::Error {
                    status: error.status,
                    body: error.body,
                    retry_after_secs: error.retry_after_secs,
                }))
            }
            _ => Ok(None),
        }
    }
}

#[derive(Deserialize)]
struct ApiStreamError {
    status: u16,
    body: serde_json::Value,
    #[serde(default)]
    retry_after_secs: Option<u64>,
}

fn sse_field_value(value: &str) -> &str {
    value.strip_prefix(' ').unwrap_or(value)
}

async fn post_json_image_retryable<T, B>(
    path: &str,
    body: &B,
    send_venice_api_key: bool,
) -> Result<T, AppError>
where
    T: for<'de> Deserialize<'de>,
    B: Serialize,
{
    for attempt in 0..IMAGE_REQUEST_MAX_ATTEMPTS {
        match authed_send(path, send_venice_api_key, |client, url, token| {
            client.post(url).bearer_auth(token).json(body)
        })
        .await
        {
            Ok(response) => {
                let status = response.status();
                if image_retryable_status(status) && attempt + 1 < IMAGE_REQUEST_MAX_ATTEMPTS {
                    let delay = response_retry_after_ms(&response)
                        .map(Duration::from_millis)
                        .unwrap_or(IMAGE_REQUEST_RETRY_DELAY);
                    tokio::time::sleep(delay).await;
                    continue;
                }
                return parse_response(path, response).await;
            }
            Err(error)
                if image_transport_retryable(&error)
                    && attempt + 1 < IMAGE_REQUEST_MAX_ATTEMPTS =>
            {
                tokio::time::sleep(IMAGE_REQUEST_RETRY_DELAY).await;
            }
            Err(error) => return Err(error),
        }
    }
    Err(AppError::new("june_request_failed", "Couldn't reach June."))
}

fn image_retryable_status(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::TOO_MANY_REQUESTS
            | reqwest::StatusCode::SERVICE_UNAVAILABLE
            | reqwest::StatusCode::GATEWAY_TIMEOUT
    )
}

fn image_transport_retryable(error: &AppError) -> bool {
    error.code == "june_request_failed"
}

async fn post_multipart<T>(path: &str, form: Form, send_venice_api_key: bool) -> Result<T, AppError>
where
    T: for<'de> Deserialize<'de>,
{
    let response = send_multipart(path, form, send_venice_api_key).await?;
    parse_response(path, response).await
}

async fn send_multipart(
    path: &str,
    form: Form,
    send_venice_api_key: bool,
) -> Result<reqwest::Response, AppError> {
    // access_token() now pre-emptively refreshes if the cached JWT is stale,
    // so multipart bodies (which can't be replayed on a 401) go out with a
    // known-fresh token. Form is not Clone, so a retry-on-401 fallback isn't
    // possible here anyway.
    let url = format!("{}{}", june_api_url(), path);
    let token = crate::os_accounts::access_token().await?;
    let request = http_client()
        .post(&url)
        .bearer_auth(token)
        .multipart(form)
        .timeout(multipart_request_timeout(path));
    let response = with_venice_api_key(path, request, send_venice_api_key)
        .send()
        .await
        .map_err(network_error)?;
    Ok(response)
}

fn multipart_request_timeout(path: &str) -> Duration {
    if path == "/v1/issue-reports" {
        ISSUE_REPORT_MULTIPART_TIMEOUT
    } else {
        HTTP_TIMEOUT
    }
}

async fn authed_send<F>(
    path: &str,
    send_venice_api_key: bool,
    build: F,
) -> Result<reqwest::Response, AppError>
where
    F: Fn(&reqwest::Client, String, String) -> reqwest::RequestBuilder,
{
    let client = http_client();
    let url = format!("{}{}", june_api_url(), path);
    let mut token = crate::os_accounts::access_token().await?;
    for attempt in 0..2 {
        let request = build(client, url.clone(), token.clone());
        let response = with_venice_api_key(path, request, send_venice_api_key)
            .send()
            .await
            .map_err(network_error)?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            token = crate::os_accounts::refresh_access_token().await?;
            continue;
        }
        return Ok(response);
    }
    Err(AppError::new("unauthorized", "Not signed in."))
}

async fn parse_response<T>(path: &str, response: reqwest::Response) -> Result<T, AppError>
where
    T: for<'de> Deserialize<'de>,
{
    let status = response.status();
    let retry_after_ms = response_retry_after_ms(&response);
    let body = response.text().await.map_err(network_error)?;
    parse_response_body(path, status, retry_after_ms, &body)
}

fn parse_response_body<T>(
    path: &str,
    status: reqwest::StatusCode,
    retry_after_ms: Option<u64>,
    body: &str,
) -> Result<T, AppError>
where
    T: for<'de> Deserialize<'de>,
{
    let envelope: ApiEnvelope<T> = serde_json::from_str(body).map_err(|error| {
        tracing::warn!(
            path,
            status = status.as_u16(),
            body_bytes = body.len(),
            %error,
            "june api returned a non-json response"
        );
        AppError::new("june_api_response_invalid", INVALID_JUNE_RESPONSE_MESSAGE)
    })?;
    if envelope.success {
        return envelope
            .data
            .ok_or_else(|| AppError::new("empty_response", "June returned no data."));
    }
    if envelope.error_code == Some(ERR_TOKEN_EXPIRED) || status == reqwest::StatusCode::UNAUTHORIZED
    {
        return Err(AppError::new("unauthorized", "Not signed in."));
    }
    if envelope.error_code == Some(ERR_INSUFFICIENT_CREDITS) {
        return Err(AppError::new(
            "insufficient_credits",
            "Your balance is too low. Upgrade to continue.",
        ));
    }
    if envelope.message.as_deref() == Some("venice_api_key_invalid") {
        return Err(AppError::new(
            "venice_api_key_invalid",
            "June could not use your saved Venice API key. If June just updated, try again later. Otherwise, open Settings and replace the key.",
        ));
    }
    if envelope.message.as_deref() == Some("venice_api_key_model_unavailable") {
        return Err(AppError::new(
            "venice_api_key_model_unavailable",
            "Your selected Venice model is no longer available. Open Settings and choose another Venice model.",
        ));
    }
    if envelope.message.as_deref() == Some("venice_api_key_rejected") {
        return Err(AppError::new(
            "venice_api_key_rejected",
            "Venice rejected your saved API key. Open Settings and update it.",
        ));
    }
    let _ = path;
    let mut error = AppError::new(
        "june_request_failed",
        envelope
            .message
            .unwrap_or_else(|| "Couldn't reach June.".to_string()),
    );
    if let Some(retry_after_ms) = retry_after_ms {
        error.details = Some(serde_json::json!({ "retryAfterMs": retry_after_ms }));
    }
    Err(error)
}

fn response_retry_after_ms(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| seconds.saturating_mul(1_000))
}

fn with_venice_api_key(
    path: &str,
    request: reqwest::RequestBuilder,
    model_accepts_venice_api_key: bool,
) -> reqwest::RequestBuilder {
    if !request_accepts_venice_api_key(path, model_accepts_venice_api_key) {
        return request;
    }
    match crate::providers::venice_api_key() {
        Some(api_key) => request.header(VENICE_API_KEY_HEADER, api_key),
        None => request,
    }
}

fn path_accepts_venice_api_key(path: &str) -> bool {
    matches!(
        path,
        "/v1/notes/transcribe"
            | "/v1/notes/generate"
            | "/v1/dictate"
            | "/v1/dictate/cleanup"
            | "/v1/chat/completions"
            | "/v1/image/generate"
            | "/v1/image/edit"
            | "/v1/web/search"
            | "/v1/web/fetch"
    )
}

fn request_accepts_venice_api_key(path: &str, model_accepts_venice_api_key: bool) -> bool {
    model_accepts_venice_api_key && path_accepts_venice_api_key(path)
}

fn model_accepts_venice_api_key(model: &str) -> bool {
    let model = model.trim();
    model != crate::providers::AUTO_GENERATION_MODEL
        && crate::providers::transcription_provider_for_model(model)
            == crate::providers::PROVIDER_VENICE
}

fn body_model_accepts_venice_api_key(body: &serde_json::Value) -> bool {
    body.get("model")
        .and_then(serde_json::Value::as_str)
        .is_some_and(model_accepts_venice_api_key)
}

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(HTTP_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .user_agent(concat!("os-june/", env!("CARGO_PKG_VERSION")))
            .default_headers(app_version_headers())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn agent_http_client() -> &'static reqwest::Client {
    AGENT_HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(AGENT_HTTP_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .user_agent(concat!("os-june-agent/", env!("CARGO_PKG_VERSION")))
            .default_headers(app_version_headers())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn app_version_headers() -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    if let Ok(value) = reqwest::header::HeaderValue::from_str(APP_VERSION) {
        headers.insert(JUNE_APP_VERSION_HEADER, value);
    }
    headers
}

/// For user-configured local/BYO inference endpoints. Same transport
/// settings as the agent client, but without the June-only version header;
/// that header is a June API contract, not something to send to whatever
/// host the user pointed their local model at.
fn local_http_client() -> &'static reqwest::Client {
    LOCAL_HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(AGENT_HTTP_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .user_agent(concat!("os-june-agent/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

// June API requires a non-empty `title` on transcribe and generate calls
// (server enforces with error_code 2001). Untitled-note recordings are a
// valid product state — the generation step usually returns a
// title_suggestion that replaces this placeholder — so we send a generic
// placeholder rather than blocking the request at the client.
const TITLE_PLACEHOLDER: &str = "Untitled note";

fn title_or_placeholder(title: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        TITLE_PLACEHOLDER.to_string()
    } else {
        trimmed.to_string()
    }
}

fn june_api_operation_id(operation_id: &str) -> String {
    if operation_id.chars().count() <= JUNE_API_MAX_ID_CHARS {
        return operation_id.to_string();
    }

    let mut digest = Sha256::new();
    digest.update(b"june-api-operation-id-v1\0");
    digest.update((operation_id.len() as u64).to_be_bytes());
    digest.update(operation_id.as_bytes());
    format!("june-op-{:x}", digest.finalize())
}

fn june_api_url() -> String {
    crate::os_accounts::load_local_env();
    std::env::var("JUNE_API_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            option_env!("JUNE_API_URL")
                .map(|value| value.trim().trim_end_matches('/').to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_JUNE_API_URL.to_string())
}

async fn read_audio(path: &Path) -> Result<Vec<u8>, AppError> {
    if !path.exists() {
        return Err(AppError::new(
            "audio_artifact_missing",
            "Saved audio is missing and cannot be transcribed.",
        ));
    }
    tokio::fs::read(path)
        .await
        .map_err(|error| AppError::new("audio_artifact_missing", error.to_string()))
}

fn filename_for_audio(path: &Path, fallback: &str) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(fallback)
        .to_string()
}

fn audio_part(audio: Vec<u8>, filename: &str, path: &Path) -> Result<Part, AppError> {
    Part::bytes(audio)
        .file_name(filename.to_string())
        .mime_str(audio_mime(path))
        .map_err(|error| AppError::new("june_request_failed", error.to_string()))
}

fn audio_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("m4a") | Some("mp4") => "audio/mp4",
        _ => "audio/wav",
    }
}

fn network_error(error: reqwest::Error) -> AppError {
    let _ = PROVIDER_OPENAI;
    AppError::new("june_request_failed", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE_GENERATE_PATH: &str = "/v1/notes/generate";
    const ISSUE_REPORT_PATH: &str = "/v1/issue-reports";

    // APP_VERSION (from Cargo.toml) is what the x-june-app-version header
    // reports, while tauri.conf.json is what releases actually ship as. If
    // they drift, the server would segment traffic by the wrong version.
    #[test]
    fn app_version_matches_tauri_conf() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        assert_eq!(conf["version"].as_str(), Some(APP_VERSION));
    }

    #[test]
    fn app_version_header_is_present_and_valid() {
        let headers = app_version_headers();
        assert_eq!(
            headers
                .get(JUNE_APP_VERSION_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some(APP_VERSION)
        );
    }

    #[test]
    fn share_create_body_serializes_camel_case() {
        let request = ShareCreateRequest {
            kind: "note".to_string(),
            ciphertext_b64: "Y2lwaGVy".to_string(),
            iv_b64: "aXY".to_string(),
            invites: vec![ShareInvitePayload {
                email: "friend@example.com".to_string(),
                envelope_b64: "ZW52".to_string(),
                envelope_iv_b64: "ZW52aXY".to_string(),
            }],
        };
        let body = serde_json::to_value(&request).expect("serialize");
        assert_eq!(
            body,
            serde_json::json!({
                "kind": "note",
                "ciphertextB64": "Y2lwaGVy",
                "ivB64": "aXY",
                "invites": [{
                    "email": "friend@example.com",
                    "envelopeB64": "ZW52",
                    "envelopeIvB64": "ZW52aXY",
                }]
            })
        );
    }

    #[test]
    fn june_api_operation_id_preserves_ids_within_the_wire_limit() {
        assert_eq!(june_api_operation_id("note-1"), "note-1");
        assert_eq!(
            june_api_operation_id(&"a".repeat(JUNE_API_MAX_ID_CHARS)),
            "a".repeat(JUNE_API_MAX_ID_CHARS)
        );
    }

    #[test]
    fn share_created_response_parses_from_envelope() {
        let body = serde_json::json!({
            "success": true,
            "data": {
                "shareId": "shr_abc",
                "invites": [
                    { "inviteId": "shi_1", "email": "friend@example.com" }
                ]
            }
        })
        .to_string();
        let parsed: ShareCreatedDto =
            parse_response_body("/v1/shares", reqwest::StatusCode::OK, None, &body)
                .expect("parse share created");
        assert_eq!(parsed.share_id, "shr_abc");
        assert_eq!(parsed.invites.len(), 1);
        assert_eq!(parsed.invites[0].invite_id, "shi_1");
        assert_eq!(parsed.invites[0].email, "friend@example.com");
    }

    #[test]
    fn share_invites_added_response_parses_without_share_id() {
        // POST /v1/shares/{id}/invites returns only `{ invites }`; parsing it
        // as ShareCreatedDto (which requires shareId) would fail.
        let body = serde_json::json!({
            "success": true,
            "data": { "invites": [{ "inviteId": "shi_9", "email": "new@example.com" }] }
        })
        .to_string();
        let parsed: ShareInvitesAddedDto = parse_response_body(
            "/v1/shares/shr_abc/invites",
            reqwest::StatusCode::OK,
            None,
            &body,
        )
        .expect("parse add-invites response");
        assert_eq!(parsed.invites.len(), 1);
        assert_eq!(parsed.invites[0].invite_id, "shi_9");
        assert_eq!(parsed.invites[0].email, "new@example.com");
    }

    #[test]
    fn share_list_response_parses_summaries() {
        // GET /v1/shares returns summaries with no invite list.
        let body = serde_json::json!({
            "success": true,
            "data": [
                { "shareId": "shr_a", "kind": "note", "createdAt": "2026-07-14T00:00:00Z" },
                { "shareId": "shr_b", "kind": "session" }
            ]
        })
        .to_string();
        let parsed: Vec<ShareSummaryDto> =
            parse_response_body("/v1/shares", reqwest::StatusCode::OK, None, &body)
                .expect("parse share list");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].share_id, "shr_a");
        assert_eq!(
            parsed[0].created_at.as_deref(),
            Some("2026-07-14T00:00:00Z")
        );
        assert_eq!(parsed[1].kind, "session");
        assert_eq!(parsed[1].created_at, None);
    }

    #[test]
    fn share_detail_response_parses_invite_states() {
        let body = serde_json::json!({
            "success": true,
            "data": {
                "shareId": "shr_abc",
                "kind": "session",
                "createdAt": "2026-07-14T00:00:00Z",
                "invites": [
                    { "inviteId": "shi_1", "email": "a@example.com", "state": "pending" },
                    {
                        "inviteId": "shi_2",
                        "email": "b@example.com",
                        "state": "accepted",
                        "lastAccessAt": "2026-07-14T01:00:00Z"
                    },
                    { "inviteId": "shi_3", "email": "c@example.com", "state": "revoked" }
                ]
            }
        })
        .to_string();
        let parsed: ShareDto =
            parse_response_body("/v1/shares/shr_abc", reqwest::StatusCode::OK, None, &body)
                .expect("parse share detail");
        assert_eq!(parsed.share_id, "shr_abc");
        assert_eq!(parsed.kind, "session");
        let states: Vec<&str> = parsed
            .invites
            .iter()
            .map(|invite| invite.state.as_str())
            .collect();
        assert_eq!(states, vec!["pending", "accepted", "revoked"]);
        assert_eq!(
            parsed.invites[1].last_access_at.as_deref(),
            Some("2026-07-14T01:00:00Z")
        );
    }

    #[test]
    fn share_not_found_maps_to_request_failed_with_message() {
        let body = serde_json::json!({
            "success": false,
            "message": "share_not_found"
        })
        .to_string();
        let error = parse_response_body::<ShareDto>(
            "/v1/shares/shr_missing",
            reqwest::StatusCode::NOT_FOUND,
            None,
            &body,
        )
        .expect_err("share_not_found should error");
        assert_eq!(error.code, "june_request_failed");
        assert_eq!(error.message, "share_not_found");
    }

    #[test]
    fn success_envelope_without_data_is_empty_response() {
        // delete_expect_success treats this as success; everything else
        // surfaces it as an error. Pin the code it keys on.
        let body = serde_json::json!({ "success": true }).to_string();
        let error = parse_response_body::<serde_json::Value>(
            "/v1/shares/shr_abc",
            reqwest::StatusCode::OK,
            None,
            &body,
        )
        .expect_err("no data should error");
        assert_eq!(error.code, "empty_response");
    }

    #[test]
    fn june_api_operation_id_hashes_long_ids_stably_and_distinctly() {
        let first = june_api_operation_id(&format!("{}-chunk-0", "durable-operation".repeat(12)));
        let repeated =
            june_api_operation_id(&format!("{}-chunk-0", "durable-operation".repeat(12)));
        let second = june_api_operation_id(&format!("{}-chunk-1", "durable-operation".repeat(12)));

        assert_eq!(first, repeated);
        assert_ne!(first, second);
        assert!(first.starts_with("june-op-"));
        assert!(first.chars().count() <= JUNE_API_MAX_ID_CHARS);
    }

    fn generate_success_envelope(content: &str) -> String {
        serde_json::json!({
            "success": true,
            "data": {
                "content": content,
                "titleSuggestion": "Summary",
                "provider": "venice",
                "promptVersion": "test-prompt"
            }
        })
        .to_string()
    }

    fn insufficient_credits_envelope() -> serde_json::Value {
        serde_json::json!({
            "success": false,
            "errorCode": ERR_INSUFFICIENT_CREDITS,
            "message": "insufficient_credits"
        })
    }

    fn issue_report_success_envelope(skipped_attachment_names: &[&str]) -> String {
        serde_json::json!({
            "success": true,
            "data": {
                "received": true,
                "skippedAttachmentNames": skipped_attachment_names,
            }
        })
        .to_string()
    }

    fn buffered_response(content_type: &str, body: String) -> reqwest::Response {
        tauri::http::Response::builder()
            .status(reqwest::StatusCode::OK)
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(body)
            .expect("test response should build")
            .into()
    }

    fn parse_sse_chunks(chunks: &[&[u8]]) -> Result<Option<ApiTerminalEvent>, AppError> {
        let mut parser = ApiSseParser::default();
        for chunk in chunks {
            if let Some(event) = parser.push(chunk)? {
                return Ok(Some(event));
            }
        }
        parser.finish()
    }

    fn expect_generate_error(
        result: Result<GenerateResponse, AppError>,
        message: &str,
    ) -> AppError {
        match result {
            Ok(_) => panic!("{message}"),
            Err(error) => error,
        }
    }

    #[test]
    fn generate_buffered_json_response_parses_success() {
        let response: GenerateResponse = parse_response_body(
            NOTE_GENERATE_PATH,
            reqwest::StatusCode::OK,
            None,
            &generate_success_envelope("Generated note"),
        )
        .expect("buffered JSON envelope should parse");

        assert_eq!(response.content, "Generated note");
        assert_eq!(response.title_suggestion.as_deref(), Some("Summary"));
        assert_eq!(response.provider, "venice");
        assert_eq!(response.prompt_version.as_deref(), Some("test-prompt"));
    }

    #[test]
    fn issue_report_legacy_json_response_remains_compatible() {
        let response: crate::domain::types::SubmitIssueReportResponse = parse_response_body(
            ISSUE_REPORT_PATH,
            reqwest::StatusCode::OK,
            None,
            &issue_report_success_envelope(&["legacy.mov"]),
        )
        .expect("legacy JSON envelope should parse");

        assert!(response.received);
        assert_eq!(response.skipped_attachment_names, vec!["legacy.mov"]);
    }

    #[test]
    fn issue_report_multipart_timeout_adds_client_grace_only_for_that_path() {
        let issue_report_timeout = multipart_request_timeout(ISSUE_REPORT_PATH);
        assert_eq!(issue_report_timeout, Duration::from_secs(900));
        assert!(issue_report_timeout > HTTP_TIMEOUT);
        assert_eq!(
            issue_report_timeout - HTTP_TIMEOUT,
            Duration::from_secs(300)
        );
        for path in ["/v1/notes/transcribe", "/v1/dictate"] {
            assert_eq!(multipart_request_timeout(path), HTTP_TIMEOUT);
        }
    }

    #[test]
    fn issue_report_sse_keep_alive_comments_then_result_parse_success() {
        let stream = format!(
            ": keep-alive\n\n: keep-alive\n\nevent: result\ndata: {}\n\n",
            issue_report_success_envelope(&["platform.mov"])
        );
        let event = parse_sse_chunks(&[stream.as_bytes()])
            .expect("SSE should parse")
            .expect("SSE should contain a terminal event");

        let response: crate::domain::types::SubmitIssueReportResponse =
            parse_sse_terminal_event(ISSUE_REPORT_PATH, event)
                .expect("result event should parse through the API envelope");

        assert!(response.received);
        assert_eq!(response.skipped_attachment_names, vec!["platform.mov"]);
    }

    #[test]
    fn issue_report_sse_error_maps_like_buffered_non_success_response() {
        let body = serde_json::json!({
            "success": false,
            "errorCode": 5000,
            "message": "issue_report_delivery_failed",
        });
        let buffered = parse_response_body::<crate::domain::types::SubmitIssueReportResponse>(
            ISSUE_REPORT_PATH,
            reqwest::StatusCode::BAD_GATEWAY,
            None,
            &body.to_string(),
        )
        .expect_err("buffered delivery failure should fail");
        let stream = format!(
            "event: error\ndata: {}\n\n",
            serde_json::json!({
                "status": reqwest::StatusCode::BAD_GATEWAY.as_u16(),
                "body": body,
            })
        );
        let event = parse_sse_chunks(&[stream.as_bytes()])
            .expect("SSE error should parse")
            .expect("SSE should contain a terminal event");
        let streamed = parse_sse_terminal_event::<crate::domain::types::SubmitIssueReportResponse>(
            ISSUE_REPORT_PATH,
            event,
        )
        .expect_err("streamed delivery failure should fail");

        assert_eq!(streamed.code, buffered.code);
        assert_eq!(streamed.message, buffered.message);
        assert_eq!(streamed.details, buffered.details);
    }

    #[tokio::test]
    async fn issue_report_names_only_retry_accepts_json_or_sse_response() {
        let envelope = issue_report_success_envelope(&["fallback.mov"]);
        let sse = format!(": keep-alive\n\nevent: result\ndata: {envelope}\n\n");
        for (content_type, body) in [
            ("application/json", envelope),
            ("text/event-stream; charset=utf-8", sse),
        ] {
            let response: crate::domain::types::SubmitIssueReportResponse =
                parse_json_or_sse_response(
                    ISSUE_REPORT_PATH,
                    buffered_response(content_type, body),
                )
                .await
                .expect("retry response should parse");

            assert!(response.received);
            assert_eq!(response.skipped_attachment_names, vec!["fallback.mov"]);
        }
    }

    #[test]
    fn generate_sse_keep_alive_comments_then_result_parse_success() {
        let stream = format!(
            ": keep-alive\n\n: keep-alive\n\nevent: result\ndata: {}\n\n",
            generate_success_envelope("Streamed note")
        );
        let event = parse_sse_chunks(&[stream.as_bytes()])
            .expect("SSE should parse")
            .expect("SSE should contain a terminal event");

        let response: GenerateResponse = parse_sse_terminal_event(NOTE_GENERATE_PATH, event)
            .expect("result event should parse through the API envelope");

        assert_eq!(response.content, "Streamed note");
        assert_eq!(response.provider, "venice");
    }

    #[test]
    fn generate_sse_error_maps_like_buffered_non_success_response() {
        let body = insufficient_credits_envelope();
        let buffered = parse_response_body::<GenerateResponse>(
            NOTE_GENERATE_PATH,
            reqwest::StatusCode::PAYMENT_REQUIRED,
            None,
            &body.to_string(),
        );
        let buffered = expect_generate_error(buffered, "buffered insufficient credits should fail");
        let stream = format!(
            "event: error\ndata: {}\n\n",
            serde_json::json!({
                "status": reqwest::StatusCode::PAYMENT_REQUIRED.as_u16(),
                "body": body,
            })
        );
        let event = parse_sse_chunks(&[stream.as_bytes()])
            .expect("SSE error should parse")
            .expect("SSE should contain a terminal event");
        let streamed = expect_generate_error(
            parse_sse_terminal_event(NOTE_GENERATE_PATH, event),
            "streamed insufficient credits should fail",
        );

        assert_eq!(streamed.code, buffered.code);
        assert_eq!(streamed.message, buffered.message);
        assert_eq!(streamed.details, buffered.details);
    }

    #[test]
    fn generate_sse_error_retry_hint_maps_to_retry_after_ms_details() {
        let stream = format!(
            "event: error\ndata: {}\n\n",
            serde_json::json!({
                "status": 429,
                "body": {
                    "success": false,
                    "errorCode": 4401,
                    "message": "authorization_denied"
                },
                "retry_after_secs": 2,
            })
        );
        let event = parse_sse_chunks(&[stream.as_bytes()])
            .expect("SSE error should parse")
            .expect("SSE should contain a terminal event");
        let error = expect_generate_error(
            parse_sse_terminal_event(NOTE_GENERATE_PATH, event),
            "streamed authorization denial should fail",
        );

        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details.get("retryAfterMs").cloned()),
            Some(serde_json::json!(2000)),
            "the streamed retry hint must surface exactly like the buffered Retry-After header"
        );
    }

    #[test]
    fn generate_sse_truncated_without_terminal_event_reports_unexpected_end() {
        let event = parse_sse_chunks(&[b": keep-alive\n\n", b"event: result\n"])
            .expect("truncated SSE should still be valid UTF-8");
        let error = event
            .map(|event| {
                expect_generate_error(
                    parse_sse_terminal_event(NOTE_GENERATE_PATH, event),
                    "truncated stream must not produce a successful response",
                )
            })
            .unwrap_or_else(api_stream_ended_unexpectedly);

        assert_eq!(error.code, "june_request_failed");
        assert_eq!(
            error.message,
            "The processing service response stream ended unexpectedly."
        );
    }

    #[test]
    fn generate_sse_chunk_boundary_can_split_line() {
        let body = generate_success_envelope("Split note");
        let chunks = [
            b": keep-al".as_slice(),
            b"ive\n\nevent: res".as_slice(),
            b"ult\ndata: ".as_slice(),
            body.as_bytes(),
            b"\n\n".as_slice(),
        ];
        let event = parse_sse_chunks(&chunks)
            .expect("split SSE should parse")
            .expect("split SSE should contain a terminal event");
        let response: GenerateResponse = parse_sse_terminal_event(NOTE_GENERATE_PATH, event)
            .expect("split result should parse through the API envelope");

        assert_eq!(response.content, "Split note");
    }

    #[test]
    fn generate_sse_multiline_data_joins_with_newlines() {
        let stream = b"event: result\n\
data: {\"success\":true,\n\
data: \"data\":{\"content\":\"Joined\",\"titleSuggestion\":null,\"provider\":\"venice\",\"promptVersion\":\"test\"}}\n\n";
        let event = parse_sse_chunks(&[stream])
            .expect("multiline SSE should parse")
            .expect("multiline SSE should contain a terminal event");
        let response: GenerateResponse = parse_sse_terminal_event(NOTE_GENERATE_PATH, event)
            .expect("multiline result should parse after newline joining");

        assert_eq!(response.content, "Joined");
    }

    #[test]
    fn extracts_text_and_strips_inline_think_blocks() {
        let value = serde_json::json!({
            "choices": [{
                "message": { "content": "<think>weighing the risks here</think>This reads two files." },
                "finish_reason": "stop"
            }]
        });
        assert_eq!(
            extract_chat_completion_text(&value).as_deref(),
            Some("This reads two files.")
        );
    }

    #[test]
    fn capped_output_is_cut_to_its_last_complete_sentence() {
        // The screenshot bug: finish_reason "length" used to surface
        // "This checks whether your ANTHROPI" verbatim.
        let value = serde_json::json!({
            "choices": [{
                "message": { "content": "This checks your config. It then probes whether your ANTHROPI" },
                "finish_reason": "length"
            }]
        });
        assert_eq!(
            extract_chat_completion_text(&value).as_deref(),
            Some("This checks your config.")
        );
    }

    #[test]
    fn capped_output_with_no_complete_sentence_yields_none() {
        let value = serde_json::json!({
            "choices": [{
                "message": { "content": "This checks whether your ANTHROPI" },
                "finish_reason": "length"
            }]
        });
        assert_eq!(extract_chat_completion_text(&value), None);
    }

    #[test]
    fn cap_landing_inside_reasoning_yields_none() {
        // Unterminated <think>: the budget ran out before any answer text.
        let value = serde_json::json!({
            "choices": [{
                "message": { "content": "<think>first I should check the key, then" },
                "finish_reason": "length"
            }]
        });
        assert_eq!(extract_chat_completion_text(&value), None);
    }

    #[test]
    fn cleans_agent_session_titles() {
        assert_eq!(
            clean_agent_session_title("Title: \"Open GarageBand\"").as_deref(),
            Some("Open GarageBand")
        );
        assert_eq!(
            clean_agent_session_title("I want you to Keep this CLI run organized.").as_deref(),
            Some("Keep this CLI run organized")
        );
        assert_eq!(
            clean_agent_session_title("Help me to organize files").as_deref(),
            Some("organize files")
        );
        assert_eq!(
            clean_agent_session_title(
                "Create a quarterly planning briefing with follow-up action items",
            )
            .as_deref(),
            Some("Create a quarterly planning briefing with")
        );
        assert_eq!(
            clean_agent_session_title(
                "Create a quarterly planning briefing, extraordinary follow-up actions",
            )
            .as_deref(),
            Some("Create a quarterly planning briefing")
        );
        assert_eq!(
            clean_agent_session_title(&"a".repeat(AGENT_TITLE_MAX_CHARS + 1)),
            Some("a".repeat(AGENT_TITLE_MAX_CHARS))
        );
        assert_eq!(
            clean_agent_session_title(&"界".repeat(AGENT_TITLE_MAX_CHARS + 1)),
            Some("界".repeat(AGENT_TITLE_MAX_CHARS))
        );
        assert_eq!(clean_agent_session_title("   "), None);
    }

    #[test]
    fn rejects_assistant_dialogue_and_questions_as_agent_session_titles() {
        assert_eq!(
            clean_agent_session_title("I'm sorry, but I can't help with that"),
            None
        );
        assert_eq!(
            clean_agent_session_title("I’m sorry, but I can’t help with that"),
            None
        );
        assert_eq!(
            clean_agent_session_title("Could you clarify the target?"),
            None
        );
        assert_eq!(clean_agent_session_title("What should I update"), None);
        assert_eq!(
            clean_agent_session_title("What, exactly should I update"),
            None
        );
        assert_eq!(
            clean_agent_session_title("What,exactly should I update"),
            None
        );
        assert_eq!(clean_agent_session_title("Would/you clarify"), None);
        assert_eq!(clean_agent_session_title("Can June access the note"), None);
        assert_eq!(clean_agent_session_title("Will June rename this"), None);
        assert_eq!(
            clean_agent_session_title("Which email service should I use"),
            None
        );
        assert_eq!(
            clean_agent_session_title("Would it be okay to rename this"),
            None
        );
        assert_eq!(clean_agent_session_title("Should this use Gmail"), None);
        assert_eq!(clean_agent_session_title("Are there archived notes"), None);
        assert_eq!(clean_agent_session_title("Was this already deployed"), None);
        assert_eq!(clean_agent_session_title("Were there archived notes"), None);
        assert_eq!(clean_agent_session_title("Had this failed before"), None);
        assert_eq!(clean_agent_session_title("Must I choose a project"), None);
        assert_eq!(clean_agent_session_title("Shall I continue"), None);
        assert_eq!(
            clean_agent_session_title("Wouldn't this overwrite the note"),
            None
        );
        assert_eq!(clean_agent_session_title("I don't have email access"), None);
        assert_eq!(
            clean_agent_session_title("Could you clarify the target"),
            None
        );
        assert_eq!(
            clean_agent_session_title("Session title: \"Could you clarify the target\""),
            None
        );
    }

    #[test]
    fn retains_concise_topic_agent_session_titles() {
        assert_eq!(
            clean_agent_session_title("Clarification handling").as_deref(),
            Some("Clarification handling")
        );
        assert_eq!(
            clean_agent_session_title("Assistant refusal guard").as_deref(),
            Some("Assistant refusal guard")
        );
        assert_eq!(
            clean_agent_session_title("May release planning").as_deref(),
            Some("May release planning")
        );
        assert_eq!(
            clean_agent_session_title("Will migration review").as_deref(),
            Some("Will migration review")
        );
        assert_eq!(
            clean_agent_session_title("Can bus diagnostics").as_deref(),
            Some("Can bus diagnostics")
        );
        assert_eq!(
            clean_agent_session_title("Open GarageBand").as_deref(),
            Some("Open GarageBand")
        );
        assert_eq!(
            clean_agent_session_title("How to deploy June").as_deref(),
            Some("How to deploy June")
        );
        assert_eq!(
            clean_agent_session_title("Surefire recovery plan").as_deref(),
            Some("Surefire recovery plan")
        );
    }

    #[test]
    fn agent_session_title_user_content_passes_through_prompt_only() {
        assert_eq!(
            agent_session_title_user_content("  Refactor this parser  ", None),
            "Refactor this parser"
        );
    }

    #[test]
    fn agent_session_title_user_content_treats_whitespace_response_as_absent() {
        assert_eq!(
            agent_session_title_user_content("  Refactor this parser  ", Some(" \n\t ")),
            "Refactor this parser"
        );
    }

    #[test]
    fn agent_session_title_user_content_formats_prompt_and_response() {
        assert_eq!(
            agent_session_title_user_content(
                "  Refactor this parser  ",
                Some("  I rewrote the tokenizer and added coverage.  "),
            ),
            "Primary user intent (authoritative):\nRefactor this parser\n\nSecondary assistant context (clarification only):\nI rewrote the tokenizer and added coverage."
        );
    }

    #[test]
    fn agent_session_title_prompt_prioritizes_clear_user_intent_over_reply() {
        assert!(AGENT_SESSION_TITLE_SYSTEM_PROMPT.contains("user request is authoritative"));
        assert!(AGENT_SESSION_TITLE_SYSTEM_PROMPT.contains("clarification question"));
        assert!(AGENT_SESSION_TITLE_SYSTEM_PROMPT.contains("tell me about my calendar"));
        assert!(AGENT_SESSION_TITLE_SYSTEM_PROMPT.contains("Calendar overview"));
    }

    #[test]
    fn agent_session_title_user_content_truncates_response_on_char_boundary() {
        let response = "é".repeat(1201);
        let content = agent_session_title_user_content("Summarize the work", Some(&response));
        let excerpt = content
            .strip_prefix(
                "Primary user intent (authoritative):\nSummarize the work\n\nSecondary assistant context (clarification only):\n",
            )
            .expect("formatted content should include assistant reply prefix");
        assert_eq!(excerpt.chars().count(), 1200);
        assert_eq!(excerpt, "é".repeat(1200));
    }

    #[test]
    fn parses_explicit_classification_yes_no_answers() {
        assert_eq!(parse_explicit_classification("YES"), Some(true));
        assert_eq!(parse_explicit_classification("no."), Some(false));
        assert_eq!(parse_explicit_classification("  Yes\n"), Some(true));
        assert_eq!(parse_explicit_classification("**NO**"), Some(false));
        assert_eq!(parse_explicit_classification("maybe"), None);
        assert_eq!(parse_explicit_classification(""), None);
        assert_eq!(parse_explicit_classification("The answer is yes."), None);
    }

    #[test]
    fn invalid_june_response_hides_json_parser_error() {
        let result = parse_response_body::<GenerateResponse>(
            "/v1/notes/generate",
            reqwest::StatusCode::BAD_GATEWAY,
            None,
            "",
        );

        assert!(result.is_err());
        let error = result.err().expect("invalid response should fail");
        assert_eq!(error.code, "june_api_response_invalid");
        assert_eq!(error.message, INVALID_JUNE_RESPONSE_MESSAGE);
        assert!(!error.message.contains("expected value"));
    }

    #[tokio::test]
    async fn download_video_bytes_rejects_local_url_before_fetch() {
        let scheme_error = download_video_bytes("http://example.com/video.mp4")
            .await
            .expect_err("http video URL should be rejected");
        assert_eq!(scheme_error.code, "video_download_url_rejected");
        assert!(scheme_error.message.contains("https"));

        let local_error = download_video_bytes("https://127.0.0.1:9/video.mp4")
            .await
            .expect_err("local https video URL should be rejected");
        assert_eq!(local_error.code, "video_download_url_rejected");
        assert!(local_error.message.contains("non-public"));
    }

    #[test]
    fn retry_after_header_is_preserved_on_june_failures() {
        let result = parse_response_body::<GenerateResponse>(
            "/v1/notes/generate",
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            Some(2_000),
            r#"{"data":null,"success":false,"error_code":4401,"message":"authorization_denied"}"#,
        );

        assert!(result.is_err());
        let error = result.err().expect("authorization denial should fail");
        assert_eq!(error.code, "june_request_failed");
        assert_eq!(error.message, "authorization_denied");
        assert_eq!(
            error
                .details
                .and_then(|details| details.get("retryAfterMs").cloned())
                .and_then(|value| value.as_u64()),
            Some(2_000)
        );
    }

    #[test]
    fn venice_api_key_errors_are_mapped_to_user_action() {
        let Err(invalid) = parse_response_body::<GenerateResponse>(
            "/v1/notes/generate",
            reqwest::StatusCode::BAD_REQUEST,
            None,
            r#"{"data":null,"success":false,"error_code":4000,"message":"venice_api_key_invalid"}"#,
        ) else {
            panic!("invalid Venice key should fail");
        };
        assert_eq!(invalid.code, "venice_api_key_invalid");
        assert!(invalid.message.contains("try again later"));

        let Err(rejected) = parse_response_body::<GenerateResponse>(
            "/v1/notes/generate",
            reqwest::StatusCode::BAD_REQUEST,
            None,
            r#"{"data":null,"success":false,"error_code":4000,"message":"venice_api_key_rejected"}"#,
        ) else {
            panic!("rejected Venice key should fail");
        };
        assert_eq!(rejected.code, "venice_api_key_rejected");
        assert!(rejected.message.contains("update it"));

        let Err(model_unavailable) = parse_response_body::<GenerateResponse>(
            "/v1/notes/generate",
            reqwest::StatusCode::UNPROCESSABLE_ENTITY,
            None,
            r#"{"data":null,"success":false,"error_code":4000,"message":"venice_api_key_model_unavailable"}"#,
        ) else {
            panic!("retired Venice model should fail");
        };
        assert_eq!(model_unavailable.code, "venice_api_key_model_unavailable");
        assert!(model_unavailable
            .message
            .contains("choose another Venice model"));
    }

    #[test]
    fn agent_proxy_preserves_session_selected_model() {
        let mut body = serde_json::json!({
            "model": "hermes-selected-model",
            "messages": [{ "role": "user", "content": "hello" }],
        });

        normalize_agent_chat_request_for_proxy(&mut body);

        assert_eq!(body["model"], serde_json::json!("hermes-selected-model"));
    }

    #[test]
    fn agent_proxy_routes_legacy_configured_local_model_locally() {
        let body = serde_json::json!({
            "model": "llama3.1:8b",
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let settings = LocalGenerationSettings {
            base_url: "http://localhost:11434/v1".to_string(),
            model_id: "llama3.1:8b".to_string(),
            api_key: String::new(),
        };

        assert_eq!(
            agent_generation_route(&body, &settings, "venice").unwrap(),
            AgentGenerationRoute::Local
        );
    }

    #[test]
    fn agent_proxy_preserves_explicit_remote_provenance_when_model_ids_collide() {
        let body = serde_json::json!({
            "model": "__june_remote_generation__:llama3.1%3A8b",
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let settings = LocalGenerationSettings {
            base_url: "http://localhost:11434/v1".to_string(),
            model_id: "llama3.1:8b".to_string(),
            api_key: String::new(),
        };

        assert_eq!(
            agent_generation_route(&body, &settings, PROVIDER_LOCAL).unwrap(),
            AgentGenerationRoute::Remote
        );

        let mut normalized = body;
        normalize_agent_chat_request_for_proxy(&mut normalized);
        assert_eq!(normalized["model"], serde_json::json!("llama3.1:8b"));
    }

    #[test]
    fn agent_proxy_routes_matching_tagged_local_model_locally() {
        let mut body = serde_json::json!({
            "model": "__june_local_generation__:llama3.1%3A8b",
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let settings = LocalGenerationSettings {
            base_url: "http://localhost:11434/v1".to_string(),
            model_id: "llama3.1:8b".to_string(),
            api_key: String::new(),
        };

        assert_eq!(
            agent_generation_route(&body, &settings, "venice").unwrap(),
            AgentGenerationRoute::Local
        );

        normalize_agent_chat_request_for_proxy(&mut body);
        assert_eq!(body["model"], serde_json::json!("llama3.1:8b"));
    }

    #[test]
    fn agent_proxy_rejects_tagged_local_model_when_endpoint_is_unavailable() {
        let body = serde_json::json!({
            "model": "__june_local_generation__:llama3.1%3A8b",
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let settings = LocalGenerationSettings {
            base_url: String::new(),
            model_id: "llama3.1:8b".to_string(),
            api_key: String::new(),
        };

        let error = agent_generation_route(&body, &settings, "venice").unwrap_err();
        assert_eq!(error.code, "local_model_unavailable");
    }

    #[test]
    fn agent_proxy_rejects_tagged_local_model_after_configuration_changes() {
        let body = serde_json::json!({
            "model": "__june_local_generation__:llama3.1%3A8b",
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let settings = LocalGenerationSettings {
            base_url: "http://localhost:11434/v1".to_string(),
            model_id: "qwen3:8b".to_string(),
            api_key: String::new(),
        };

        let error = agent_generation_route(&body, &settings, "venice").unwrap_err();
        assert_eq!(error.code, "local_model_unavailable");
    }

    #[test]
    fn agent_proxy_fills_missing_model_from_settings() {
        let mut body = serde_json::json!({
            "messages": [{ "role": "user", "content": "hello" }],
        });

        normalize_agent_chat_request_for_proxy(&mut body);

        assert_eq!(
            body["model"],
            serde_json::json!(crate::providers::generation_model())
        );
    }

    #[test]
    fn agent_proxy_replaces_blank_model_from_settings() {
        let mut body = serde_json::json!({
            "model": "  ",
            "messages": [{ "role": "user", "content": "hello" }],
        });

        normalize_agent_chat_request_for_proxy(&mut body);

        assert_eq!(
            body["model"],
            serde_json::json!(crate::providers::generation_model())
        );
    }

    #[test]
    fn agent_proxy_injects_auto_cost_quality_preference() {
        let mut body = serde_json::json!({
            "model": crate::providers::AUTO_GENERATION_MODEL,
            "messages": []
        });
        normalize_agent_chat_request_for_proxy(&mut body);
        assert_eq!(
            body["auto"]["cost_quality"],
            serde_json::json!(crate::providers::cost_quality())
        );
        assert!(!body_model_accepts_venice_api_key(&body));
    }

    #[test]
    fn agent_proxy_decodes_per_run_auto_cost_quality_preference() {
        for (model, expected) in [
            ("__june_auto_generation__:0", 0.0),
            ("__june_auto_generation__:73", 0.73),
            ("__june_auto_generation__:100", 1.0),
        ] {
            let mut body = serde_json::json!({
                "model": model,
                "messages": []
            });

            normalize_agent_chat_request_for_proxy(&mut body);

            assert_eq!(
                body["model"],
                serde_json::json!(crate::providers::AUTO_GENERATION_MODEL)
            );
            assert_eq!(body["auto"]["cost_quality"], serde_json::json!(expected));
            assert!(!body_model_accepts_venice_api_key(&body));
        }
    }

    #[test]
    fn agent_proxy_falls_back_safely_for_malformed_per_run_auto_model() {
        let mut body = serde_json::json!({
            "model": "__june_auto_generation__:not-a-preset",
            "messages": []
        });

        normalize_agent_chat_request_for_proxy(&mut body);

        assert_eq!(
            body["model"],
            serde_json::json!(crate::providers::AUTO_GENERATION_MODEL)
        );
        assert_eq!(
            body["auto"]["cost_quality"],
            serde_json::json!(crate::providers::cost_quality())
        );
        assert!(!body.to_string().contains("__june_auto_generation__:"));
    }

    #[test]
    fn agent_proxy_falls_back_safely_for_out_of_range_per_run_auto_model() {
        let mut body = serde_json::json!({
            "model": "__june_auto_generation__:101",
            "messages": []
        });

        normalize_agent_chat_request_for_proxy(&mut body);

        assert_eq!(
            body["model"],
            serde_json::json!(crate::providers::AUTO_GENERATION_MODEL)
        );
        assert_eq!(
            body["auto"]["cost_quality"],
            serde_json::json!(crate::providers::cost_quality())
        );
    }

    #[test]
    fn venice_key_gate_rejects_openai_transcription_models() {
        assert!(request_accepts_venice_api_key(
            "/v1/notes/transcribe",
            model_accepts_venice_api_key(crate::providers::DEFAULT_TRANSCRIPTION_MODEL)
        ));
        assert!(!request_accepts_venice_api_key(
            "/v1/notes/transcribe",
            model_accepts_venice_api_key("gpt-4o-mini-transcribe")
        ));
        assert!(!request_accepts_venice_api_key(
            "/v1/dictate",
            model_accepts_venice_api_key("whisper-1")
        ));
        assert!(!request_accepts_venice_api_key(
            "/v1/notes/generate",
            model_accepts_venice_api_key(crate::providers::AUTO_GENERATION_MODEL)
        ));
        assert!(!request_accepts_venice_api_key(
            "/v1/issue-reports",
            model_accepts_venice_api_key(crate::providers::DEFAULT_TRANSCRIPTION_MODEL)
        ));
        assert!(request_accepts_venice_api_key(
            "/v1/image/generate",
            model_accepts_venice_api_key(crate::providers::DEFAULT_IMAGE_MODEL)
        ));
        assert!(request_accepts_venice_api_key(
            "/v1/image/edit",
            model_accepts_venice_api_key(crate::providers::DEFAULT_IMAGE_MODEL)
        ));
    }

    #[test]
    fn agent_proxy_venice_key_gate_uses_normalized_model() {
        let mut body = serde_json::json!({
            "messages": [{ "role": "user", "content": "hello" }],
        });

        normalize_agent_chat_request_for_proxy(&mut body);

        assert!(body_model_accepts_venice_api_key(&body));
        body["model"] = serde_json::json!("gpt-4o-mini-transcribe");
        assert!(!body_model_accepts_venice_api_key(&body));
    }

    #[test]
    fn agent_proxy_caps_oversized_output_token_budgets() {
        let mut body = serde_json::json!({
            "model": "hermes-selected-model",
            "messages": [{ "role": "user", "content": "hello" }],
            "max_tokens": AGENT_PROXY_MAX_OUTPUT_TOKENS + 1,
            "max_completion_tokens": AGENT_PROXY_MAX_OUTPUT_TOKENS + 10,
        });

        normalize_agent_chat_request_for_proxy(&mut body);

        assert_eq!(
            body["max_tokens"],
            serde_json::json!(AGENT_PROXY_MAX_OUTPUT_TOKENS)
        );
        assert_eq!(
            body["max_completion_tokens"],
            serde_json::json!(AGENT_PROXY_MAX_OUTPUT_TOKENS)
        );
    }

    #[test]
    fn agent_proxy_preserves_valid_output_token_budgets() {
        let mut body = serde_json::json!({
            "model": "hermes-selected-model",
            "messages": [{ "role": "user", "content": "hello" }],
            "max_tokens": 500,
            "max_completion_tokens": AGENT_PROXY_MAX_OUTPUT_TOKENS,
        });

        normalize_agent_chat_request_for_proxy(&mut body);

        assert_eq!(body["max_tokens"], serde_json::json!(500));
        assert_eq!(
            body["max_completion_tokens"],
            serde_json::json!(AGENT_PROXY_MAX_OUTPUT_TOKENS)
        );
    }

    #[test]
    fn agent_proxy_caps_float_output_token_budgets_over_the_limit() {
        let mut body = serde_json::json!({
            "model": "hermes-selected-model",
            "messages": [{ "role": "user", "content": "hello" }],
            "max_tokens": 32769.0,
        });

        normalize_agent_chat_request_for_proxy(&mut body);

        assert_eq!(
            body["max_tokens"],
            serde_json::json!(AGENT_PROXY_MAX_OUTPUT_TOKENS)
        );
    }

    #[test]
    fn agent_proxy_leaves_negative_output_token_budgets_for_backend_validation() {
        let mut body = serde_json::json!({
            "model": "hermes-selected-model",
            "messages": [{ "role": "user", "content": "hello" }],
            "max_tokens": -1,
        });

        normalize_agent_chat_request_for_proxy(&mut body);

        assert_eq!(body["max_tokens"], serde_json::json!(-1));
    }

    #[test]
    fn agent_proxy_limits_messages_while_preserving_latest_context() {
        let mut body = serde_json::json!({
            "messages": std::iter::once(serde_json::json!({
                "role": "system",
                "content": "system prompt"
            }))
            .chain((0..8).map(|index| serde_json::json!({
                "role": "user",
                "content": format!("message {index}")
            })))
            .collect::<Vec<_>>()
        });

        limit_agent_chat_messages(&mut body, 5);

        let messages = body["messages"].as_array().expect("messages array");
        assert_eq!(messages.len(), 5);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["content"], "message 4");
        assert_eq!(messages[4]["content"], "message 7");
    }

    #[test]
    fn agent_proxy_keeps_tool_call_messages_together() {
        let mut body = serde_json::json!({
            "messages": [
                { "role": "system", "content": "system prompt" },
                { "role": "user", "content": "old context" },
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": { "name": "browser_console", "arguments": "{}" }
                    }]
                },
                { "role": "tool", "tool_call_id": "call_1", "content": "result" },
                { "role": "user", "content": "next request" }
            ]
        });

        limit_agent_chat_messages(&mut body, 4);

        let messages = body["messages"].as_array().expect("messages array");
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[2]["role"], "tool");
        assert_eq!(messages[3]["content"], "next request");
    }

    #[test]
    fn agent_proxy_keeps_latest_chunk_even_when_it_exceeds_the_budget() {
        let tool_calls = (0..6)
            .map(|index| {
                serde_json::json!({
                    "id": format!("call_{index}"),
                    "type": "function",
                    "function": { "name": "browser_console", "arguments": "{}" }
                })
            })
            .collect::<Vec<_>>();
        let mut messages = vec![
            serde_json::json!({ "role": "system", "content": "system prompt" }),
            serde_json::json!({ "role": "user", "content": "old context" }),
            serde_json::json!({ "role": "user", "content": "latest request" }),
            serde_json::json!({
                "role": "assistant",
                "content": null,
                "tool_calls": tool_calls
            }),
        ];
        messages.extend((0..6).map(|index| {
            serde_json::json!({
                "role": "tool",
                "tool_call_id": format!("call_{index}"),
                "content": format!("result {index}")
            })
        }));
        let mut body = serde_json::json!({ "messages": messages });

        // The most recent chunk (assistant turn + 6 tool results) alone
        // exceeds the budget; it must still be kept rather than stripping
        // the conversation down to the system prompt.
        limit_agent_chat_messages(&mut body, 4);

        let messages = body["messages"].as_array().expect("messages array");
        assert_eq!(messages.len(), 8);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[2]["role"], "tool");
        assert_eq!(messages[7]["content"], "result 5");
    }

    #[test]
    fn local_generation_source_text_marks_source_labels_as_metadata() {
        let source = generation_source_text(
            Some("# Existing"),
            Some("Follow up with Sam"),
            "Microphone: We need to ship.\nSystem: The demo starts now.",
            true,
        );

        assert!(source.contains("<existing_generated_note_context>"));
        assert!(source.contains("<new_manual_notes_context>"));
        assert!(source.contains("<transcript_source_metadata>"));
        assert!(source.contains("Do not output manual note labels or transcript source labels."));
    }

    #[test]
    fn local_generation_cleanup_strips_echoed_source_labels() {
        let cleaned = cleanup_generated_note_text(
            "- Microphone: We need to ship.\n- System: The demo starts now.",
            "Microphone: We need to ship.\nSystem: The demo starts now.",
        );

        assert_eq!(cleaned, "- We need to ship.\n- The demo starts now.");
    }

    #[test]
    fn local_agent_proxy_injects_safety_context() {
        let mut object = serde_json::json!({
            "messages": [{ "role": "user", "content": "hello" }]
        });
        inject_local_safety_context(object.as_object_mut().unwrap());

        let messages = object["messages"].as_array().expect("messages");
        assert_eq!(messages[0]["role"], "system");
        assert!(messages[0]["content"]
            .as_str()
            .unwrap()
            .contains("Standing content policy"));
    }

    #[test]
    fn issue_attachment_mime_maps_videos() {
        assert_eq!(issue_attachment_mime("/tmp/clip.mp4"), "video/mp4");
        assert_eq!(
            issue_attachment_mime("/tmp/Screen Recording.MOV"),
            "video/quicktime"
        );
        assert_eq!(issue_attachment_mime("/tmp/clip.m4v"), "video/x-m4v");
        assert_eq!(issue_attachment_mime("/tmp/clip.webm"), "video/webm");
        assert_eq!(
            issue_attachment_mime("/tmp/unknown.bin"),
            "application/octet-stream"
        );
    }

    fn create_sparse_file(path: &Path, len: u64) {
        let file = std::fs::File::create(path).expect("create sparse file");
        file.set_len(len).expect("size sparse file");
    }

    // JUN-238: a video larger than June's former 10 MiB limit must remain an
    // issue-report attachment part without reading the whole file into memory.
    #[tokio::test]
    async fn issue_attachment_parts_streams_video_above_legacy_limit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let large = dir.path().join("clip.mov");
        let empty = dir.path().join("empty.txt");
        create_sparse_file(&large, (10 * 1024 * 1024) + 1);
        std::fs::write(&empty, b"").expect("write empty");
        let missing = dir.path().join("gone.mp4");

        let paths: Vec<String> = [&large, &empty, &missing]
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect();
        let result = issue_attachment_parts(&paths)
            .await
            .expect("parts should build");

        assert_eq!(result.parts.len(), 1);
        assert_eq!(result.included_names, vec!["clip.mov".to_string()]);
        assert_eq!(
            result.skipped_names,
            vec!["empty.txt".to_string(), "gone.mp4".to_string()]
        );
    }

    #[tokio::test]
    async fn issue_attachment_parts_skip_per_file_and_cumulative_overages() {
        let dir = tempfile::tempdir().expect("tempdir");
        let accepted = dir.path().join("accepted.mov");
        let exceeds_total = dir.path().join("exceeds-total.mp4");
        let exceeds_file = dir.path().join("exceeds-file.webm");
        create_sparse_file(&accepted, 200 * 1024 * 1024);
        create_sparse_file(&exceeds_total, (100 * 1024 * 1024) + 1);
        create_sparse_file(&exceeds_file, ISSUE_ATTACHMENT_MAX_BYTES + 1);

        let paths = [&accepted, &exceeds_total, &exceeds_file]
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        let result = issue_attachment_parts(&paths)
            .await
            .expect("metadata checks should succeed");

        assert_eq!(result.parts.len(), 1);
        assert_eq!(result.included_names, vec!["accepted.mov".to_string()]);
        assert_eq!(
            result.skipped_names,
            vec![
                "exceeds-total.mp4".to_string(),
                "exceeds-file.webm".to_string(),
            ]
        );
    }

    #[test]
    fn issue_report_names_only_retry_is_limited_to_size_failures() {
        assert!(issue_report_needs_names_only_retry(
            reqwest::StatusCode::PAYLOAD_TOO_LARGE,
            "<html>ingress rejection</html>",
        ));
        for message in ["multipart_invalid", "payload_too_large"] {
            let body = serde_json::json!({
                "data": null,
                "success": false,
                "error_code": 4000,
                "message": message,
            })
            .to_string();
            assert!(issue_report_needs_names_only_retry(
                reqwest::StatusCode::BAD_REQUEST,
                &body,
            ));
        }
        let validation = serde_json::json!({
            "data": null,
            "success": false,
            "error_code": 4000,
            "message": "description_required",
        })
        .to_string();
        assert!(!issue_report_needs_names_only_retry(
            reqwest::StatusCode::BAD_REQUEST,
            &validation,
        ));
    }

    #[test]
    fn skipped_attachment_names_merge_without_duplicates() {
        let mut response = crate::domain::types::SubmitIssueReportResponse {
            received: true,
            skipped_attachment_names: vec!["server.mov".to_string(), "local.mov".to_string()],
        };

        merge_skipped_attachment_names(
            &mut response,
            vec!["local.mov".to_string(), "fallback.mp4".to_string()],
        );

        assert_eq!(
            response.skipped_attachment_names,
            vec![
                "local.mov".to_string(),
                "fallback.mp4".to_string(),
                "server.mov".to_string(),
            ]
        );
    }
}

/// Live tests against a real OpenAI-compatible local endpoint (e.g. Ollama).
///
/// Every test is `#[ignore]`d so CI and the normal `cargo test` run never
/// need a model server. To run them, start the endpoint and pull a model:
///
/// ```sh
/// ollama serve &
/// ollama pull llama3.1:8b
/// cargo test --locked -- --ignored live_local
/// ```
///
/// Configuration comes from the environment:
/// - `JUNE_QA_LOCAL_BASE_URL`: OpenAI-compatible base URL
///   (default `http://127.0.0.1:11434/v1`)
/// - `JUNE_QA_LOCAL_MODEL`: model id the endpoint serves
///   (default `llama3.1:8b`)
///
/// Each test skips (passes with a stderr note) when the endpoint is
/// unreachable, so an accidental `--include-ignored` run does not fail.
///
/// The generation tests install settings into the process-wide provider
/// store that `crate::providers::current_settings()` reads, which is shared
/// global state. They serialize themselves through a module-local mutex, so
/// the default parallel test runner is safe for `-- --ignored live_local`;
/// mixing them with other settings-mutating tests in one run
/// (`--include-ignored`) requires `--test-threads=1`.
#[cfg(test)]
mod live_local_tests {
    use super::*;
    use crate::providers::{
        probe_local_generation_endpoint, LocalGenerationSettings,
        ProbeLocalGenerationEndpointRequest, PROVIDER_LOCAL,
    };
    use std::sync::{Mutex, MutexGuard};

    const DEFAULT_LIVE_BASE_URL: &str = "http://127.0.0.1:11434/v1";
    const DEFAULT_LIVE_MODEL: &str = "llama3.1:8b";

    fn live_base_url() -> String {
        std::env::var("JUNE_QA_LOCAL_BASE_URL")
            .ok()
            .map(|value| value.trim().trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_LIVE_BASE_URL.to_string())
    }

    fn live_model() -> String {
        std::env::var("JUNE_QA_LOCAL_MODEL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_LIVE_MODEL.to_string())
    }

    /// True when the live endpoint answers `GET {base}/models`. Used to skip
    /// gracefully instead of failing when no server is running.
    async fn live_server_reachable(base_url: &str) -> bool {
        let Ok(client) = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
        else {
            return false;
        };
        match client.get(format!("{base_url}/models")).send().await {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }

    fn skip_message(base_url: &str) -> String {
        format!(
            "SKIPPED: no OpenAI-compatible server reachable at {base_url}. \
             Start one (e.g. `ollama serve`) or set JUNE_QA_LOCAL_BASE_URL."
        )
    }

    /// Serializes the tests that mutate the process-wide provider settings
    /// and restores the defaults afterwards, even on panic.
    struct LiveSettingsGuard(#[allow(dead_code)] MutexGuard<'static, ()>);

    impl Drop for LiveSettingsGuard {
        fn drop(&mut self) {
            crate::providers::replace_current_settings_for_tests(
                crate::providers::default_settings_for_tests(),
            );
        }
    }

    fn install_live_local_provider(base_url: &str, model_id: &str) -> LiveSettingsGuard {
        static LOCK: Mutex<()> = Mutex::new(());
        let guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut settings = crate::providers::default_settings_for_tests();
        settings.generation_provider = PROVIDER_LOCAL.to_string();
        settings.generation_model = model_id.to_string();
        settings.local_generation = LocalGenerationSettings {
            base_url: base_url.to_string(),
            model_id: model_id.to_string(),
            api_key: String::new(),
        };
        crate::providers::replace_current_settings_for_tests(settings);
        LiveSettingsGuard(guard)
    }

    /// Exercises the real probe path (`probe_local_generation_endpoint`:
    /// reqwest GET `{base}/models` + `parse_local_models_response`) against
    /// the live server and expects the configured model in the list.
    #[tokio::test]
    #[ignore = "requires a live local OpenAI-compatible server"]
    async fn live_local_probe_lists_pulled_models() {
        let base_url = live_base_url();
        if !live_server_reachable(&base_url).await {
            eprintln!("{}", skip_message(&base_url));
            return;
        }

        let probe = probe_local_generation_endpoint(ProbeLocalGenerationEndpointRequest {
            base_url: base_url.clone(),
            api_key: String::new(),
        })
        .await
        .expect("probe against the live endpoint should succeed");

        let model = live_model();
        assert!(
            !probe.models.is_empty(),
            "live endpoint advertised no models"
        );
        assert!(
            probe.models.iter().any(|id| id == &model),
            "expected model {model:?} in the live endpoint's model list {:?}; \
             pull it first (e.g. `ollama pull {model}`)",
            probe.models
        );
    }

    /// Drives `generate_note_from_transcript` end to end on the local path
    /// with a source-labeled transcript: real prompt assembly, real
    /// completion parsing, and the source-label cleanup pass.
    #[tokio::test]
    #[ignore = "requires a live local OpenAI-compatible server"]
    async fn live_local_note_generation_returns_clean_markdown() {
        let base_url = live_base_url();
        if !live_server_reachable(&base_url).await {
            eprintln!("{}", skip_message(&base_url));
            return;
        }
        let model = live_model();
        let _guard = install_live_local_provider(&base_url, &model);

        let transcript = "\
Microphone: Alright, let's kick off the weekly sync. First up is the release timeline.
System: Thanks. The desktop build is ready, but the updater feed still points at staging.
Microphone: Okay, so the action item is to repoint the updater feed before Thursday.
System: Agreed. I also want to flag that onboarding drop-off improved after the copy change.
Microphone: Great. Let's ship the feed fix this week, then review the onboarding metrics next Monday.";

        let result = generate_note_from_transcript(GenerationRequest {
            provider: PROVIDER_LOCAL.to_string(),
            operation_id: Some("live-local-test".to_string()),
            title: "Weekly sync".to_string(),
            existing_generated_note: None,
            transcript: transcript.to_string(),
            transcript_source_labels: true,
            manual_notes: None,
            language: Some("en".to_string()),
        })
        .await
        .expect("live local note generation should succeed");

        assert_eq!(result.provider, PROVIDER_LOCAL);
        assert!(
            !result.content.trim().is_empty(),
            "generated note should not be empty"
        );
        // Visible with --nocapture: lets a live QA run eyeball the note the
        // model actually produced.
        eprintln!("live note generation ({model}):\n{}\n", result.content);
        // The audio source labels are transcript metadata; neither the model
        // (instructed via <transcript_source_metadata>) nor the cleanup pass
        // may let them through to the note.
        for line in result.content.lines() {
            let (_, text) = markdown_line_marker(line.trim_start());
            assert!(
                strip_source_label_prefix(text.trim_start()).is_none(),
                "transcript source label leaked into the generated note line {line:?};\nfull note:\n{}",
                result.content
            );
        }
    }

    /// Drives `proxy_agent_chat_completions` on the local path: buffered
    /// JSON first, then `stream: true` asserting SSE framing terminated by
    /// `data: [DONE]` (the shape Hermes consumes through the proxy).
    #[tokio::test]
    #[ignore = "requires a live local OpenAI-compatible server"]
    async fn live_local_agent_proxy_completes_buffered_and_streaming() {
        let base_url = live_base_url();
        if !live_server_reachable(&base_url).await {
            eprintln!("{}", skip_message(&base_url));
            return;
        }
        let model = live_model();
        let _guard = install_live_local_provider(&base_url, &model);

        // Buffered request, exactly what the session-title path sends.
        let response = proxy_agent_chat_completions(serde_json::json!({
            "messages": [
                { "role": "user", "content": "Reply with the single word: pong" }
            ],
            "stream": false,
            "max_tokens": 512,
        }))
        .await
        .expect("live local agent proxy call should succeed");
        assert_eq!(response.status, 200);
        assert!(
            response.content_type.contains("json"),
            "expected a JSON content type, got {:?}",
            response.content_type
        );
        let body = response
            .collect_body()
            .await
            .expect("proxy body should be readable");
        let value: serde_json::Value =
            serde_json::from_slice(&body).expect("proxy body should be an OpenAI completion");
        let content = extract_chat_completion_text(&value)
            .expect("completion should carry non-empty assistant content");
        assert!(!content.trim().is_empty());

        // Streaming request, the shape Hermes actually uses.
        let mut response = proxy_agent_chat_completions(serde_json::json!({
            "messages": [
                { "role": "user", "content": "Reply with the single word: pong" }
            ],
            "stream": true,
            "max_tokens": 512,
        }))
        .await
        .expect("live local streaming proxy call should succeed");
        assert_eq!(response.status, 200);
        assert!(
            response.content_type.starts_with("text/event-stream"),
            "expected an SSE content type for stream: true, got {:?}",
            response.content_type
        );
        let mut raw = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .expect("SSE chunk should be readable")
        {
            raw.extend_from_slice(&chunk);
        }
        let stream = String::from_utf8_lossy(&raw);
        assert!(
            stream.contains("data: [DONE]"),
            "SSE stream should terminate with data: [DONE]; got tail {:?}",
            &stream[stream.len().saturating_sub(200)..]
        );
        let has_parseable_delta = stream
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter(|data| *data != "[DONE]")
            .any(|data| {
                serde_json::from_str::<serde_json::Value>(data)
                    .is_ok_and(|event| event.get("choices").is_some())
            });
        assert!(
            has_parseable_delta,
            "SSE stream should contain at least one parseable chat.completion.chunk"
        );
    }
}
