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

// The deployed production API (Phala dstack; see scribe-api/deploy/
// docker-compose.production.yml). NOT .network — that hostname has no DNS
// record, and the v0.0.3 DMG shipped pointing at it.
const DEFAULT_SCRIBE_API_URL: &str = "https://scribe-api.opensoftware.co";
const DEFAULT_DICTATION_CLEANUP_MODEL: &str = "nvidia-nemotron-3-nano-30b-a3b";
const HTTP_TIMEOUT: Duration = Duration::from_secs(60);
const AGENT_HTTP_TIMEOUT: Duration = Duration::from_secs(600);
const AGENT_PROXY_MAX_MESSAGES: usize = 64;
const AGENT_PROXY_MAX_INSTRUCTION_MESSAGES: usize = 4;
const AGENT_TITLE_MAX_CHARS: usize = 48;
const ERR_INSUFFICIENT_CREDITS: i64 = 4301;
const ERR_TOKEN_EXPIRED: i64 = 3001;

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
    pub language: Option<String>,
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
    if let Some(language) = normalized_language(request.language.as_deref()) {
        form = form.text("language", language.to_string());
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
    if let Some(language) = normalized_language(request.language.as_deref()) {
        form = form.text("language", language.to_string());
    }
    let response: TranscribeResponse = post_multipart("/v1/dictate", form).await?;
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

pub async fn proxy_agent_chat_completions(
    mut body: serde_json::Value,
) -> Result<AgentChatCompletionsResponse, AppError> {
    limit_agent_chat_messages_for_proxy(&mut body);
    if let Some(object) = body.as_object_mut() {
        object.insert(
            "model".to_string(),
            serde_json::Value::String(crate::providers::generation_model()),
        );
    }
    let url = format!("{}/v1/chat/completions", scribe_api_url());
    let mut token = crate::os_accounts::access_token().await?;
    for attempt in 0..2 {
        let response = agent_http_client()
            .post(&url)
            .bearer_auth(&token)
            .json(&body)
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

fn limit_agent_chat_messages_for_proxy(body: &mut serde_json::Value) {
    limit_agent_chat_messages(body, AGENT_PROXY_MAX_MESSAGES);
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
                "content": "Name this agent session by the work being done, not by repeating the user's request. Return only a concrete 2 to 5 word title. Avoid first person, words like please/help/you, trailing ellipses, quotes, punctuation wrappers, markdown, or explanations."
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        "temperature": 0.1,
        "max_tokens": 24
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
                "content": "An AI agent paused mid-task to ask its user for permission. Explain what this specific request would actually do, in plain language the user can act on: name the files, hosts, or data involved, decode any flags or shell syntax, and call out anything risky or hard to undo (deleting or overwriting files, sending data off the machine, spending money). Use 2 to 4 short sentences. Never be generic, never use markdown or headings, and never tell the user which button to press."
            },
            {
                "role": "user",
                "content": request_text
            }
        ],
        "temperature": 0.2,
        "max_tokens": 220
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
    !scribe_api_url().is_empty()
}

/// Public URL of the attestation walkthrough the backend serves from inside
/// its confidential VM — same origin every metered request already goes to.
pub fn verify_url() -> String {
    format!("{}/verify", scribe_api_url())
}

fn extract_chat_completion_text(value: &serde_json::Value) -> Option<String> {
    value
        .get("choices")?
        .as_array()?
        .first()?
        .get("message")?
        .get("content")?
        .as_str()
        .map(str::to_string)
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
        .trim_end_matches(|ch: char| matches!(ch, '.' | ':' | '-'))
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
            .no_proxy()
            .timeout(HTTP_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .user_agent("os-scribe/0.1")
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
            .user_agent("os-scribe-agent/0.1")
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
        .or_else(|| {
            option_env!("SCRIBE_API_URL")
                .map(|value| value.trim().trim_end_matches('/').to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_SCRIBE_API_URL.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
                "Create a Quarterly Planning Briefing With Follow Up Action Items",
            )
            .as_deref(),
            Some("Create a Quarterly Planning Briefing With Follow")
        );
        assert_eq!(clean_agent_session_title("   "), None);
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
