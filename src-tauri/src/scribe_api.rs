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
// Mirrors the public Scribe API validation cap. Hermes may request a larger
// per-call output budget than the backend accepts, which otherwise trips a
// validation error that it misclassifies as prompt context overflow.
const AGENT_PROXY_MAX_OUTPUT_TOKENS: u64 = 32_768;
const AGENT_TITLE_MAX_CHARS: usize = 48;
const ERR_INSUFFICIENT_CREDITS: i64 = 4301;
const ERR_TOKEN_EXPIRED: i64 = 3001;
const INVALID_SCRIBE_RESPONSE_MESSAGE: &str =
    "The processing service returned an invalid response.";

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
        transcript_source_labels: request.transcript_source_labels,
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
    normalize_agent_chat_request_for_proxy(&mut body);
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
                "content": "Name this agent session by the work being done, not by repeating the user's request. Return only a concrete 2 to 5 word title. Avoid first person, words like please/help/you, trailing ellipses, quotes, punctuation wrappers, markdown, or explanations."
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
    post_multipart("/v1/issue-reports", form).await
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
    !scribe_api_url().is_empty()
}

/// Public URL of the attestation walkthrough the backend serves from inside
/// its confidential VM — same origin every metered request already goes to.
pub fn verify_url() -> String {
    format!("{}/verify", scribe_api_url())
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
            "scribe api returned a non-json response"
        );
        AppError::new(
            "scribe_api_response_invalid",
            INVALID_SCRIBE_RESPONSE_MESSAGE,
        )
    })?;
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
    let mut error = AppError::new(
        "scribe_request_failed",
        envelope
            .message
            .unwrap_or_else(|| "Couldn't reach Scribe.".to_string()),
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
                "Create a Quarterly Planning Briefing With Follow Up Action Items",
            )
            .as_deref(),
            Some("Create a Quarterly Planning Briefing With Follow")
        );
        assert_eq!(clean_agent_session_title("   "), None);
    }

    #[test]
    fn invalid_scribe_response_hides_json_parser_error() {
        let result = parse_response_body::<GenerateResponse>(
            "/v1/notes/generate",
            reqwest::StatusCode::BAD_GATEWAY,
            None,
            "",
        );

        assert!(result.is_err());
        let error = result.err().expect("invalid response should fail");
        assert_eq!(error.code, "scribe_api_response_invalid");
        assert_eq!(error.message, INVALID_SCRIBE_RESPONSE_MESSAGE);
        assert!(!error.message.contains("expected value"));
    }

    #[test]
    fn retry_after_header_is_preserved_on_scribe_failures() {
        let result = parse_response_body::<GenerateResponse>(
            "/v1/notes/generate",
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            Some(2_000),
            r#"{"data":null,"success":false,"error_code":4401,"message":"authorization_denied"}"#,
        );

        assert!(result.is_err());
        let error = result.err().expect("authorization denial should fail");
        assert_eq!(error.code, "scribe_request_failed");
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
    fn agent_proxy_preserves_session_selected_model() {
        let mut body = serde_json::json!({
            "model": "hermes-selected-model",
            "messages": [{ "role": "user", "content": "hello" }],
        });

        normalize_agent_chat_request_for_proxy(&mut body);

        assert_eq!(body["model"], serde_json::json!("hermes-selected-model"));
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
