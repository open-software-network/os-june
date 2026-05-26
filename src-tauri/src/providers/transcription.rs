use crate::domain::types::AppError;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_TRANSCRIPTION_PROVIDER: &str = crate::providers::VENICE_PROVIDER;

#[derive(Debug, Clone)]
pub struct TranscriptionRequest {
    pub provider: String,
    pub audio_path: PathBuf,
    pub title: String,
    pub context: Option<String>,
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
        crate::providers::VENICE_PROVIDER => transcribe_with_venice(&request).await,
        _ => Err(AppError::new(
            "provider_not_configured",
            "Unsupported transcription provider. Venice is the only supported provider; set VENICE_API_KEY.",
        )),
    }
}

pub fn normalize_transcription_language(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    if value.len() == 2
        && value
            .chars()
            .all(|character| character.is_ascii_lowercase())
    {
        Some(value)
    } else {
        None
    }
}

async fn transcribe_with_venice(
    request: &TranscriptionRequest,
) -> Result<TranscriptionProviderResult, AppError> {
    let api_key = crate::providers::venice_api_key().ok_or_else(|| {
        AppError::new(
            "provider_not_configured",
            "VENICE_API_KEY is required for Venice transcription.",
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
    let model = crate::providers::venice_transcription_model();
    let audio_part = Part::bytes(audio_bytes)
        .file_name(filename)
        .mime_str(transcription_audio_mime(&request.audio_path))
        .map_err(|error| AppError::new("provider_request_failed", error.to_string()))?;
    let mut form = Form::new()
        .text("model", model)
        .text("response_format", "json")
        .part("file", audio_part);
    if let Some(language) = transcription_language_override() {
        form = form.text("language", language);
    }
    let response = reqwest::Client::new()
        .post(format!(
            "{}/audio/transcriptions",
            crate::providers::venice_api_base_url()
        ))
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
            format!("Venice transcription failed with status {status}: {body}"),
        ));
    }
    let parsed: OpenAiTranscriptionResponse = serde_json::from_str(&body)
        .map_err(|error| AppError::new("provider_response_invalid", error.to_string()))?;
    let text = parsed.text.trim().to_string();
    if text.is_empty() {
        return Err(AppError::new(
            "transcription_empty",
            "Venice returned an empty transcript.",
        ));
    }
    Ok(TranscriptionProviderResult {
        text,
        language: None,
        provider: crate::providers::VENICE_PROVIDER.to_string(),
    })
}

pub fn transcription_audio_mime(path: &Path) -> &'static str {
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

fn transcription_language_override() -> Option<String> {
    crate::providers::load_local_env();
    std::env::var("OS_NOTETAKER_TRANSCRIPTION_LANGUAGE")
        .ok()
        .and_then(|value| normalize_transcription_language(&value))
}

#[derive(Debug, Deserialize)]
struct OpenAiTranscriptionResponse {
    text: String,
}
