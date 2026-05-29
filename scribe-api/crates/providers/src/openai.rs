use crate::transcription::TranscriptionWireResponse;
use async_trait::async_trait;
use reqwest::multipart::{Form, Part};
use scribe_config::UpstreamConfig;
use scribe_domain::{DomainError, Transcriber, Transcript, TranscriptionRequest};

pub const PROVIDER_NAME: &str = "openai";

pub struct OpenAiTranscriber {
    http: reqwest::Client,
    api_key: String,
    base_url: String,
}

impl OpenAiTranscriber {
    pub fn from_config(http: reqwest::Client, config: &UpstreamConfig) -> Self {
        Self {
            http,
            api_key: config.api_key.clone(),
            base_url: config.base_url.trim_end_matches('/').to_string(),
        }
    }
}

#[async_trait]
impl Transcriber for OpenAiTranscriber {
    async fn transcribe(&self, request: TranscriptionRequest) -> Result<Transcript, DomainError> {
        let model_id = request.model.0.clone();
        let url = format!("{}/audio/transcriptions", self.base_url);
        let audio_part = Part::bytes(request.audio)
            .file_name(request.filename.clone())
            .mime_str(crate::transcription::audio_mime(&request.filename))
            .map_err(|error| {
                tracing::error!(%error, %url, model = %model_id, "openai: audio mime build failed");
                DomainError::UpstreamProvider
            })?;
        let mut form = Form::new()
            .text("model", model_id.clone())
            .text("response_format", "json")
            .part("file", audio_part);
        if let Some(prompt) = request
            .context
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            form = form.text("prompt", prompt.to_string());
        }
        let response = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|error| {
                tracing::error!(%error, %url, model = %model_id, "openai: transport error");
                DomainError::UpstreamProvider
            })?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            tracing::error!(%status, %url, model = %model_id, body = %body, "openai: non-success response");
            return Err(DomainError::UpstreamProvider);
        }
        let parsed = response
            .json::<TranscriptionWireResponse>()
            .await
            .map_err(|error| {
                tracing::error!(%error, %url, model = %model_id, "openai: response JSON parse failed");
                DomainError::UpstreamProvider
            })?;
        let text = parsed.text.trim().to_string();
        if text.is_empty() {
            // No speech detected is an input condition, not an upstream fault —
            // surface it as a 400 so the client can stay silent ("nothing
            // captured") instead of flashing a backend error.
            tracing::info!(%url, model = %model_id, "openai: no speech in audio");
            return Err(DomainError::InvalidInput {
                reason: "no_speech".to_string(),
            });
        }
        Ok(Transcript {
            text,
            language: parsed.language,
            provider: PROVIDER_NAME.to_string(),
        })
    }
}
