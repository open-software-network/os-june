//! Scribe API client. The Tauri side calls the backend for every metered
//! action; provider keys live there, never here.

use crate::{domain::types::AppError, providers::PROVIDER_OPENAI};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

const DEFAULT_SCRIBE_API_URL: &str = "https://scribe-api.opensoftware.network";
const DEFAULT_DICTATION_CLEANUP_MODEL: &str = "nvidia-nemotron-3-nano-30b-a3b";
const HTTP_TIMEOUT: Duration = Duration::from_secs(60);
const ERR_INSUFFICIENT_CREDITS: i64 = 4301;
const ERR_TOKEN_EXPIRED: i64 = 3001;

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct TranscriptionRequest {
    pub provider: String,
    pub audio_path: PathBuf,
    pub title: String,
    pub context: Option<String>,
    pub operation_id: Option<String>,
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
    pub session_id: String,
    pub utterance_id: String,
}

#[derive(Debug, Clone)]
pub struct DictateCleanupRequestParams {
    pub text: String,
    pub dictionary_context: Option<String>,
    pub style: String,
    pub session_id: String,
    pub utterance_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelDto {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub model_type: String,
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
    style: String,
    model: String,
}

pub async fn transcribe_saved_audio(
    request: TranscriptionRequest,
) -> Result<TranscriptionProviderResult, AppError> {
    let audio = read_audio(&request.audio_path).await?;
    let filename = filename_for_audio(&request.audio_path, "recording.wav");
    let mut form = Form::new()
        .text("noteId", request.operation_id())
        .text("title", title_or_placeholder(&request.title))
        .text("model", crate::providers::transcription_model())
        .part("audio", audio_part(audio, &filename, &request.audio_path)?);
    if let Some(context) = request
        .context
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        form = form.text("context", context.to_string());
    }
    let response: TranscribeResponse = post_multipart("/v1/notes/transcribe", form).await?;
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
    let body = GenerateBody {
        note_id: request.operation_id(),
        prompt_version: crate::domain::processing::PROMPT_VERSION.to_string(),
        title: title_or_placeholder(&request.title),
        transcript: transcript.to_string(),
        manual_notes: request.manual_notes,
        language: request.language,
        existing_generated_note: request.existing_generated_note,
        model: crate::providers::generation_model(),
    };
    let response: GenerateResponse = post_json("/v1/notes/generate", &body).await?;
    Ok(GenerationProviderResult {
        content: response.content,
        title_suggestion: response.title_suggestion,
        provider: response.provider,
        prompt_version: crate::domain::processing::PROMPT_VERSION.to_string(),
    })
}

pub async fn dictate_transcribe(
    request: DictateTranscribeRequest,
) -> Result<TranscriptionProviderResult, AppError> {
    let audio = read_audio(&request.audio_path).await?;
    let filename = filename_for_audio(&request.audio_path, "dictation.wav");
    let form = Form::new()
        .text("sessionId", request.session_id)
        .text("utteranceId", request.utterance_id)
        .text("model", crate::providers::transcription_model())
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
    let response: TranscribeResponse = post_multipart("/v1/dictate", form).await?;
    Ok(TranscriptionProviderResult {
        text: response.text,
        language: response.language,
        provider: response.provider,
    })
}

pub async fn cleanup_text(params: DictateCleanupRequestParams) -> Result<String, AppError> {
    let body = DictateCleanupBody {
        session_id: params.session_id,
        utterance_id: params.utterance_id,
        text: params.text,
        dictionary_context: params.dictionary_context,
        style: params.style,
        model: DEFAULT_DICTATION_CLEANUP_MODEL.to_string(),
    };
    let response: CleanupResponse = post_json("/v1/dictate/cleanup", &body).await?;
    Ok(response.text)
}

pub async fn list_models(model_type: &str) -> Result<Vec<ModelDto>, AppError> {
    let url = format!("{}/v1/models", scribe_api_url());
    let response = http_client()
        .get(url)
        .query(&[("type", model_type)])
        .send()
        .await
        .map_err(network_error)?;
    parse_response("/v1/models", response).await
}

pub fn dictation_provider_for_model(model_id: &str) -> &'static str {
    crate::providers::transcription_provider_for_model(model_id)
}

pub fn configured() -> bool {
    !scribe_api_url().is_empty()
}

async fn post_json<T, B>(path: &str, body: &B) -> Result<T, AppError>
where
    T: for<'de> Deserialize<'de>,
    B: Serialize,
{
    let response = authed_send(path, |client, url, token| {
        client.post(url).bearer_auth(token).json(body)
    })
    .await?;
    parse_response(path, response).await
}

async fn post_multipart<T>(path: &str, form: Form) -> Result<T, AppError>
where
    T: for<'de> Deserialize<'de>,
{
    // access_token() now pre-emptively refreshes if the cached JWT is stale,
    // so multipart bodies (which can't be replayed on a 401) go out with a
    // known-fresh token. Form is not Clone, so a retry-on-401 fallback isn't
    // possible here anyway.
    let url = format!("{}{}", scribe_api_url(), path);
    let token = crate::os_accounts::access_token().await?;
    let response = http_client()
        .post(&url)
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(network_error)?;
    parse_response(path, response).await
}

async fn authed_send<F>(path: &str, build: F) -> Result<reqwest::Response, AppError>
where
    F: Fn(&reqwest::Client, String, String) -> reqwest::RequestBuilder,
{
    let client = http_client();
    let url = format!("{}{}", scribe_api_url(), path);
    let mut token = crate::os_accounts::access_token().await?;
    for attempt in 0..2 {
        let response = build(client, url.clone(), token.clone())
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
    let body = response.text().await.map_err(network_error)?;
    let envelope: ApiEnvelope<T> = serde_json::from_str(&body)
        .map_err(|error| AppError::new("scribe_api_response_invalid", error.to_string()))?;
    if envelope.success {
        return envelope
            .data
            .ok_or_else(|| AppError::new("empty_response", "Scribe returned no data."));
    }
    if envelope.error_code == Some(ERR_TOKEN_EXPIRED) || status == reqwest::StatusCode::UNAUTHORIZED
    {
        return Err(AppError::new("unauthorized", "Not signed in."));
    }
    if envelope.error_code == Some(ERR_INSUFFICIENT_CREDITS) {
        return Err(AppError::new(
            "insufficient_credits",
            "Your balance is too low. Add funds to continue.",
        ));
    }
    let _ = path;
    Err(AppError::new(
        "scribe_request_failed",
        envelope
            .message
            .unwrap_or_else(|| "Couldn't reach Scribe.".to_string()),
    ))
}

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .user_agent("os-scribe/0.1")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

// Scribe API requires a non-empty `title` on transcribe and generate calls
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

fn scribe_api_url() -> String {
    crate::os_accounts::load_local_env();
    std::env::var("SCRIBE_API_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_SCRIBE_API_URL.to_string())
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
        .map_err(|error| AppError::new("scribe_request_failed", error.to_string()))
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
    AppError::new("scribe_request_failed", error.to_string())
}
