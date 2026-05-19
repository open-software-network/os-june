use crate::domain::types::AppError;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DEFAULT_TRANSCRIPTION_PROVIDER: &str = "mock";
const DEFAULT_OPENAI_TRANSCRIPTION_MODEL: &str = "gpt-4o-mini-transcribe";
const OPENAI_TRANSCRIPTIONS_URL: &str = "https://api.openai.com/v1/audio/transcriptions";

#[derive(Debug, Clone)]
pub struct TranscriptionRequest {
    pub provider: String,
    pub audio_path: PathBuf,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionProviderResult {
    pub text: String,
    pub language: Option<String>,
    pub provider: String,
}

pub async fn transcribe_saved_audio(
    request: TranscriptionRequest,
) -> Result<TranscriptionProviderResult, AppError> {
    if !request.audio_path.exists() {
        return Err(AppError::new(
            "audio_artifact_missing",
            "Saved audio is missing and cannot be transcribed.",
        ));
    }

    match request.provider.as_str() {
        "mock" | "" => Ok(TranscriptionProviderResult {
            text: format!(
                "{}: This is a local mock transcript generated from saved audio.",
                request.title.trim()
            ),
            language: Some("en".to_string()),
            provider: DEFAULT_TRANSCRIPTION_PROVIDER.to_string(),
        }),
        "openai" => transcribe_with_openai(&request).await,
        _ => Err(AppError::new(
            "provider_not_configured",
            "Unsupported transcription provider. Use OS_NOTETAKER_PROVIDER=mock or configure OPENAI_API_KEY.",
        )),
    }
}

async fn transcribe_with_openai(
    request: &TranscriptionRequest,
) -> Result<TranscriptionProviderResult, AppError> {
    let api_key = crate::providers::openai_api_key().ok_or_else(|| {
        AppError::new(
            "provider_not_configured",
            "OPENAI_API_KEY is required for real transcription. Unset OS_NOTETAKER_PROVIDER or set it to mock for offline verification.",
        )
    })?;
    let audio_bytes = std::fs::read(&request.audio_path)
        .map_err(|error| AppError::new("audio_artifact_missing", error.to_string()))?;
    let filename = request
        .audio_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("recording.wav")
        .to_string();
    let model = std::env::var("OS_NOTETAKER_TRANSCRIPTION_MODEL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_OPENAI_TRANSCRIPTION_MODEL.to_string());
    let audio_part = Part::bytes(audio_bytes)
        .file_name(filename)
        .mime_str("audio/wav")
        .map_err(|error| AppError::new("provider_request_failed", error.to_string()))?;
    let form = Form::new()
        .text("model", model)
        .text("response_format", "json")
        .part("file", audio_part);
    let response = reqwest::Client::new()
        .post(OPENAI_TRANSCRIPTIONS_URL)
        .bearer_auth(api_key)
        .multipart(form)
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
            format!("OpenAI transcription failed with status {status}: {body}"),
        ));
    }
    let parsed: OpenAiTranscriptionResponse = serde_json::from_str(&body)
        .map_err(|error| AppError::new("provider_response_invalid", error.to_string()))?;
    let text = parsed.text.trim().to_string();
    if text.is_empty() {
        return Err(AppError::new(
            "transcription_empty",
            "OpenAI returned an empty transcript.",
        ));
    }
    Ok(TranscriptionProviderResult {
        text,
        language: None,
        provider: crate::providers::OPENAI_PROVIDER.to_string(),
    })
}

#[derive(Debug, Deserialize)]
struct OpenAiTranscriptionResponse {
    text: String,
}
