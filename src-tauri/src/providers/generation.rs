use crate::{domain::processing::PROMPT_VERSION, domain::types::AppError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const DEFAULT_GENERATION_PROVIDER: &str = "mock";
const DEFAULT_OPENAI_GENERATION_MODEL: &str = "gpt-5.2";
const OPENAI_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";

#[derive(Debug, Clone)]
pub struct GenerationRequest {
    pub provider: String,
    pub title: String,
    pub transcript: String,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GenerationProviderResult {
    pub content: String,
    pub title_suggestion: Option<String>,
    pub provider: String,
    pub prompt_version: String,
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

    match request.provider.as_str() {
        "mock" | "" => Ok(GenerationProviderResult {
            content: format!("{}\n\n{}", heading_for(&request.title), transcript),
            title_suggestion: if request.title.trim().is_empty() {
                Some("New note".to_string())
            } else {
                Some(request.title.trim().to_string())
            },
            provider: DEFAULT_GENERATION_PROVIDER.to_string(),
            prompt_version: PROMPT_VERSION.to_string(),
        }),
        "openai" => generate_with_openai(&request, transcript).await,
        _ => Err(AppError::new(
            "provider_not_configured",
            "Unsupported generation provider. Use OS_NOTETAKER_PROVIDER=mock or configure OPENAI_API_KEY.",
        )),
    }
}

fn heading_for(title: &str) -> String {
    let title = title.trim();
    if title.is_empty() {
        "# Generated note".to_string()
    } else {
        format!("# {title}")
    }
}

async fn generate_with_openai(
    request: &GenerationRequest,
    transcript: &str,
) -> Result<GenerationProviderResult, AppError> {
    let api_key = crate::providers::openai_api_key().ok_or_else(|| {
        AppError::new(
            "provider_not_configured",
            "OPENAI_API_KEY is required for note generation. Unset OS_NOTETAKER_PROVIDER or set it to mock for offline verification.",
        )
    })?;
    let model = std::env::var("OS_NOTETAKER_GENERATION_MODEL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_OPENAI_GENERATION_MODEL.to_string());
    let title_hint = request.title.trim();
    let body = json!({
        "model": model,
        "instructions": "You turn voice transcripts into concise markdown notes. Use only the transcript. Do not invent facts, decisions, dates, or names. Preserve the speaker's language unless the transcript is mixed-language. Return only the note body in markdown.",
        "input": format!(
            "Current title: {}\nDetected language: {}\n\nTranscript:\n{}",
            if title_hint.is_empty() { "New note" } else { title_hint },
            request.language.as_deref().unwrap_or("unknown"),
            transcript
        )
    });
    let response = reqwest::Client::new()
        .post(OPENAI_RESPONSES_URL)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| AppError::new("provider_request_failed", error.to_string()))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| AppError::new("provider_request_failed", error.to_string()))?;
    if !status.is_success() {
        return Err(AppError::new(
            "provider_request_failed",
            format!("OpenAI generation failed with status {status}: {body}"),
        ));
    }
    let parsed: Value = serde_json::from_str(&body)
        .map_err(|error| AppError::new("provider_response_invalid", error.to_string()))?;
    let content = extract_response_text(&parsed).ok_or_else(|| {
        AppError::new(
            "provider_response_invalid",
            "OpenAI generation response did not contain text output.",
        )
    })?;
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err(AppError::new(
            "generation_empty",
            "OpenAI returned an empty generated note.",
        ));
    }
    Ok(GenerationProviderResult {
        content,
        title_suggestion: if title_hint.is_empty() {
            Some("New note".to_string())
        } else {
            Some(title_hint.to_string())
        },
        provider: crate::providers::OPENAI_PROVIDER.to_string(),
        prompt_version: PROMPT_VERSION.to_string(),
    })
}

fn extract_response_text(value: &Value) -> Option<String> {
    if let Some(text) = value.get("output_text").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    let mut parts = Vec::new();
    for output in value.get("output")?.as_array()? {
        let Some(content_items) = output.get("content").and_then(Value::as_array) else {
            continue;
        };
        for content in content_items {
            if let Some(text) = content.get("text").and_then(Value::as_str) {
                parts.push(text.to_string());
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}
