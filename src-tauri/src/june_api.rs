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
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

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
const HTTP_TIMEOUT: Duration = Duration::from_secs(600);
const AGENT_HTTP_TIMEOUT: Duration = Duration::from_secs(600);
const AGENT_PROXY_MAX_MESSAGES: usize = 64;
const AGENT_PROXY_MAX_INSTRUCTION_MESSAGES: usize = 4;
// Mirrors the public June API validation cap. Hermes may request a larger
// per-call output budget than the backend accepts, which otherwise trips a
// validation error that it misclassifies as prompt context overflow.
const AGENT_PROXY_MAX_OUTPUT_TOKENS: u64 = 32_768;
const AGENT_TITLE_MAX_CHARS: usize = 48;
const VENICE_API_KEY_HEADER: &str = "x-venice-api-key";
const ERR_INSUFFICIENT_CREDITS: i64 = 4301;
const ERR_TOKEN_EXPIRED: i64 = 3001;
const INVALID_JUNE_RESPONSE_MESSAGE: &str = "The processing service returned an invalid response.";
const IMAGE_REQUEST_MAX_ATTEMPTS: usize = 3;
const IMAGE_REQUEST_RETRY_DELAY: Duration = Duration::from_millis(250);
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

pub async fn transcribe_saved_audio(
    request: TranscriptionRequest,
) -> Result<TranscriptionProviderResult, AppError> {
    let audio = read_audio(&request.audio_path).await?;
    let filename = filename_for_audio(&request.audio_path, "recording.wav");
    let model = crate::providers::transcription_model();
    let send_venice_api_key = model_accepts_venice_api_key(&model);
    let mut form = Form::new()
        .text("noteId", request.operation_id())
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
        note_id: request.operation_id(),
        prompt_version: crate::domain::processing::PROMPT_VERSION.to_string(),
        title: title_or_placeholder(&request.title),
        transcript: transcript.to_string(),
        transcript_source_labels: request.transcript_source_labels,
        manual_notes: request.manual_notes,
        language: request.language,
        existing_generated_note: request.existing_generated_note,
        model,
    };
    let response: GenerateResponse =
        post_json("/v1/notes/generate", &body, send_venice_api_key).await?;
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

pub async fn proxy_agent_chat_completions(
    mut body: serde_json::Value,
) -> Result<AgentChatCompletionsResponse, AppError> {
    normalize_agent_chat_request_for_proxy(&mut body);
    if crate::providers::generation_provider() == PROVIDER_LOCAL {
        return proxy_local_agent_chat_completions(body).await;
    }
    // Remote provider safety net: a Hermes session started while local mode was
    // on keeps sending the local model id (Hermes loads its model at spawn and
    // does not reload on a settings change), which the remote backend rejects
    // via require_priced_model and would hard-fail every message until restart.
    // Degrade a stale local model id to the current global model instead.
    let local_model_id = crate::providers::local_generation_settings().model_id;
    let global_model = crate::providers::generation_model();
    redirect_stale_local_model(&mut body, &local_model_id, &global_model);
    // Computed after the redirect so a degraded stale-local body is gated on the
    // real (global) model, not the local id it arrived with.
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
        agent_http_client().post(local_chat_completions_url(&settings)?),
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
        agent_http_client().post(local_chat_completions_url(&settings)?),
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
    clamp_agent_chat_output_tokens(object, "max_tokens");
    clamp_agent_chat_output_tokens(object, "max_completion_tokens");
}

/// The frontend's synthetic catalog id prefix for the local model option
/// (`LOCAL_GENERATION_OPTION_ID_PREFIX` in `src/lib/local-generation.ts`).
/// The prefix exists so the synthetic id can never collide with a real
/// remote model id, which makes it sufficient on its own to identify a local
/// reference — no need to decode the percent-encoded remainder.
const LOCAL_GENERATION_OPTION_ID_PREFIX: &str = "__june_local_generation__:";

/// True when `model` names a local model: the configured raw id, or ANY id in
/// the frontend's prefixed synthetic catalog form. Defense in depth: the
/// synthetic id is translated to the raw id at the Hermes boundary, but
/// sessions persisted before that fix can still carry the prefixed form —
/// and a prefixed id is by construction never a valid remote model, even
/// when it encodes a since-changed local id.
fn is_local_model_reference(model: &str, local_model_id: &str) -> bool {
    (!local_model_id.is_empty() && model == local_model_id)
        || model.starts_with(LOCAL_GENERATION_OPTION_ID_PREFIX)
}

/// Rewrites a request that still carries a local model reference to the
/// current global generation model, for the remote proxy path only. Mirrors
/// the local path's unconditional model stomp: when the global provider is
/// remote, a body still naming the local model is a stale spawn-time default
/// from a session created while local mode was on, and the remote backend
/// would reject it. Genuine remote per-session overrides (any non-synthetic
/// id other than the configured local model id) are left untouched, so an
/// explicit `/model` switch to a real remote model still wins.
fn redirect_stale_local_model(
    body: &mut serde_json::Value,
    local_model_id: &str,
    global_model: &str,
) {
    let local_model_id = local_model_id.trim();
    let Some(object) = body.as_object_mut() else {
        return;
    };
    let is_stale_local = object
        .get("model")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .is_some_and(|model| is_local_model_reference(model, local_model_id));
    if is_stale_local {
        object.insert(
            "model".to_string(),
            serde_json::Value::String(global_model.to_string()),
        );
    }
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

pub async fn suggest_agent_session_title(prompt: &str) -> Result<String, AppError> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(AppError::new(
            "agent_title_empty",
            "Cannot title an empty agent request.",
        ));
    }
    let response = proxy_agent_chat_completions(serde_json::json!({
        "messages": [
            {
                "role": "system",
                "content": "Name this agent session by the work being done, not by repeating the user's request. Return only a concrete 2 to 5 word title in sentence case: capitalize the first word and proper nouns only, never every word. Avoid first person, words like please/help/you, trailing ellipses, quotes, punctuation wrappers, markdown, or explanations."
            },
            {
                "role": "user",
                "content": prompt
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

// Matches the server's per-attachment cap; bigger files are listed by name
// in the report but their bytes stay local.
const ISSUE_ATTACHMENT_MAX_BYTES: usize = 10 * 1024 * 1024;

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
    let mut form = Form::new()
        .text("description", description.to_string())
        .text("appVersion", app_version.to_string())
        .text("platform", std::env::consts::OS);
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
    // Attachment uploads are best-effort: an unreadable or oversized file
    // must not block the report, and its name above still tells the team it
    // existed.
    for path in &request.attachment_paths {
        let bytes = match tokio::fs::read(path).await {
            Ok(bytes) => bytes,
            Err(error) => {
                eprintln!("skipping unreadable issue report attachment {path}: {error}");
                continue;
            }
        };
        if bytes.is_empty() || bytes.len() > ISSUE_ATTACHMENT_MAX_BYTES {
            eprintln!(
                "skipping issue report attachment {path}: {} bytes",
                bytes.len()
            );
            continue;
        }
        let filename = Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "attachment".to_string());
        let part = Part::bytes(bytes)
            .file_name(filename)
            .mime_str(issue_attachment_mime(path))
            .map_err(|error| AppError::new("issue_report_attachment_invalid", error.to_string()))?;
        form = form.part("attachment", part);
    }
    post_multipart("/v1/issue-reports", form, false).await
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

fn clean_agent_session_title(value: &str) -> Option<String> {
    let mut title = value
        .trim()
        .trim_matches(|ch: char| ch == '"' || ch == '\'' || ch == '`')
        .replace(['\r', '\n'], " ");
    let prefixes = [
        "Title:",
        "Session title:",
        "Request:",
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
        for prefix in prefixes {
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
        title = title.chars().take(AGENT_TITLE_MAX_CHARS).collect();
        title = title.trim_end().to_string();
    }
    Some(title)
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
    // access_token() now pre-emptively refreshes if the cached JWT is stale,
    // so multipart bodies (which can't be replayed on a 401) go out with a
    // known-fresh token. Form is not Clone, so a retry-on-401 fallback isn't
    // possible here anyway.
    let url = format!("{}{}", june_api_url(), path);
    let token = crate::os_accounts::access_token().await?;
    let request = http_client().post(&url).bearer_auth(token).multipart(form);
    let response = with_venice_api_key(path, request, send_venice_api_key)
        .send()
        .await
        .map_err(network_error)?;
    parse_response(path, response).await
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
            "Your saved Venice API key is not an inference key. Open Settings and paste a key that starts with VENICE_INFERENCE_KEY_.",
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
    crate::providers::transcription_provider_for_model(model.trim())
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
            .user_agent("os-june/0.1")
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
            .user_agent("os-june-agent/0.1")
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
            Some("Create a quarterly planning briefing with follow")
        );
        assert_eq!(clean_agent_session_title("   "), None);
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
        assert!(invalid.message.contains("VENICE_INFERENCE_KEY_"));

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
    fn remote_proxy_redirects_stale_local_model_to_global_model() {
        // A session started while local mode was on keeps sending the local
        // model id; on the remote path it must degrade to the global model
        // rather than hard-fail against require_priced_model.
        let mut body = serde_json::json!({
            "model": "llama3.1:8b",
            "messages": [{ "role": "user", "content": "hi" }],
        });

        redirect_stale_local_model(&mut body, "llama3.1:8b", "zai-org-glm-5-2");

        assert_eq!(body["model"], serde_json::json!("zai-org-glm-5-2"));
    }

    #[test]
    fn remote_proxy_redirects_prefixed_synthetic_local_model_to_global_model() {
        // A session persisted before the Hermes-boundary translation can carry
        // the frontend's synthetic catalog id (prefix + encodeURIComponent of
        // the raw id). The guard must recognize and rewrite that form too.
        let mut body = serde_json::json!({
            "model": "__june_local_generation__:llama3.1%3A8b",
            "messages": [{ "role": "user", "content": "hi" }],
        });

        redirect_stale_local_model(&mut body, "llama3.1:8b", "zai-org-glm-5-2");

        assert_eq!(body["model"], serde_json::json!("zai-org-glm-5-2"));
    }

    #[test]
    fn remote_proxy_redirects_any_prefixed_synthetic_id_even_without_local_settings() {
        // A prefixed id is never a valid remote model, so it degrades to the
        // global model even when the encoded id no longer matches the saved
        // local settings (here: local settings cleared entirely).
        let mut body = serde_json::json!({
            "model": "__june_local_generation__:other-model",
            "messages": [{ "role": "user", "content": "hi" }],
        });

        redirect_stale_local_model(&mut body, "", "zai-org-glm-5-2");

        assert_eq!(body["model"], serde_json::json!("zai-org-glm-5-2"));
    }

    #[test]
    fn remote_proxy_preserves_genuine_remote_model_override() {
        // A real remote per-session override (an explicit /model switch) must
        // survive the guard so the session keeps the model the user chose.
        let mut body = serde_json::json!({
            "model": "kimi-k2-6",
            "messages": [{ "role": "user", "content": "hi" }],
        });

        redirect_stale_local_model(&mut body, "llama3.1:8b", "zai-org-glm-5-2");

        assert_eq!(body["model"], serde_json::json!("kimi-k2-6"));
    }

    #[test]
    fn remote_proxy_stale_local_redirect_is_noop_without_local_model() {
        // No local model configured: never touch the request model.
        let mut body = serde_json::json!({
            "model": "kimi-k2-6",
            "messages": [{ "role": "user", "content": "hi" }],
        });

        redirect_stale_local_model(&mut body, "   ", "zai-org-glm-5-2");

        assert_eq!(body["model"], serde_json::json!("kimi-k2-6"));
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
    fn agent_proxy_preserves_tool_request_fields() {
        let mut body = serde_json::json!({
            "model": "hermes-selected-model",
            "messages": [{ "role": "user", "content": "call the tool" }],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "june_test_tool",
                    "description": "Test tool",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "value": { "type": "string" }
                        },
                        "required": ["value"]
                    }
                }
            }],
            "tool_choice": "auto"
        });

        normalize_agent_chat_request_for_proxy(&mut body);

        assert_eq!(body["tool_choice"], serde_json::json!("auto"));
        assert_eq!(
            body["tools"][0]["function"]["name"],
            serde_json::json!("june_test_tool")
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

    fn live_api_key() -> String {
        std::env::var("JUNE_QA_LOCAL_API_KEY")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_default()
    }

    /// True when the live endpoint answers `GET {base}/models`. Used to skip
    /// gracefully instead of failing when no server is running.
    async fn live_server_reachable(base_url: &str, api_key: &str) -> bool {
        let Ok(client) = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
        else {
            return false;
        };
        let mut request = client.get(format!("{base_url}/models"));
        if !api_key.trim().is_empty() {
            request = request.bearer_auth(api_key.trim());
        }
        match request.send().await {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }

    fn skip_message(base_url: &str) -> String {
        format!(
            "SKIPPED: no OpenAI-compatible server reachable at {base_url}. \
             Start one or set JUNE_QA_LOCAL_BASE_URL. For a tool-calling \
             GLM-4.5-Air run, use vLLM with --enable-auto-tool-choice \
             --tool-call-parser glm45."
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

    fn install_live_local_provider(
        base_url: &str,
        model_id: &str,
        api_key: &str,
    ) -> LiveSettingsGuard {
        static LOCK: Mutex<()> = Mutex::new(());
        let guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut settings = crate::providers::default_settings_for_tests();
        settings.generation_provider = PROVIDER_LOCAL.to_string();
        settings.generation_model = model_id.to_string();
        settings.local_generation = LocalGenerationSettings {
            base_url: base_url.to_string(),
            model_id: model_id.to_string(),
            api_key: api_key.to_string(),
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
        let api_key = live_api_key();
        if !live_server_reachable(&base_url, &api_key).await {
            eprintln!("{}", skip_message(&base_url));
            return;
        }

        let probe = probe_local_generation_endpoint(ProbeLocalGenerationEndpointRequest {
            base_url: base_url.clone(),
            api_key,
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
        let api_key = live_api_key();
        if !live_server_reachable(&base_url, &api_key).await {
            eprintln!("{}", skip_message(&base_url));
            return;
        }
        let model = live_model();
        let _guard = install_live_local_provider(&base_url, &model, &api_key);

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
        let api_key = live_api_key();
        if !live_server_reachable(&base_url, &api_key).await {
            eprintln!("{}", skip_message(&base_url));
            return;
        }
        let model = live_model();
        let _guard = install_live_local_provider(&base_url, &model, &api_key);

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

    /// Drives a real local endpoint through June's agent proxy with OpenAI-style
    /// tools. This is the live proof needed for local tool-calling models such as
    /// GLM-4.5-Air served by vLLM with `--enable-auto-tool-choice
    /// --tool-call-parser glm45`.
    #[tokio::test]
    #[ignore = "requires a live local OpenAI-compatible server with tool calling enabled"]
    async fn live_local_agent_proxy_returns_tool_calls() {
        let base_url = live_base_url();
        let api_key = live_api_key();
        if !live_server_reachable(&base_url, &api_key).await {
            eprintln!("{}", skip_message(&base_url));
            return;
        }
        let model = live_model();
        let _guard = install_live_local_provider(&base_url, &model, &api_key);

        let response = proxy_agent_chat_completions(serde_json::json!({
            "messages": [
                {
                    "role": "user",
                    "content": "Use the june_test_weather tool for New York City. Do not answer directly."
                }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "june_test_weather",
                        "description": "Gets the current weather for one city.",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "city": {
                                    "type": "string",
                                    "description": "The city to check."
                                }
                            },
                            "required": ["city"],
                            "additionalProperties": false
                        }
                    }
                }
            ],
            "tool_choice": "auto",
            "stream": false,
            "max_tokens": 512,
        }))
        .await
        .expect("live local tool-call proxy call should succeed");

        assert_eq!(response.status, 200);
        let body = response
            .collect_body()
            .await
            .expect("proxy body should be readable");
        let value: serde_json::Value =
            serde_json::from_slice(&body).expect("proxy body should be an OpenAI completion");
        let tool_calls = value
            .get("choices")
            .and_then(serde_json::Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("tool_calls"))
            .and_then(serde_json::Value::as_array)
            .expect("completion should include tool_calls");

        assert!(
            tool_calls.iter().any(|tool_call| {
                tool_call
                    .get("function")
                    .and_then(|function| function.get("name"))
                    .and_then(serde_json::Value::as_str)
                    == Some("june_test_weather")
            }),
            "expected june_test_weather tool call in {value:#}"
        );
    }
}
