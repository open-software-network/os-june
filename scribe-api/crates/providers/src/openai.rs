use crate::retry::{self, UpstreamAttemptError};
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
        let url = format!("{}/audio/transcriptions", self.base_url);
        // Bounded retry on transient failures (connection reset, 429, 5xx).
        // Safe to replay: the metering charge only settles after this call
        // succeeds, so a retried attempt can never double-charge.
        for attempt in 0..retry::UPSTREAM_ATTEMPTS {
            let error = match self.transcribe_once(&url, &request).await {
                Ok(transcript) => return Ok(transcript),
                Err(error) => error,
            };
            if error.retryable && attempt + 1 < retry::UPSTREAM_ATTEMPTS {
                tracing::warn!(
                    %url,
                    model = %request.model.0,
                    attempt,
                    "openai: transient upstream failure, retrying"
                );
                tokio::time::sleep(retry::UPSTREAM_RETRY_BACKOFF).await;
                continue;
            }
            return Err(error.error);
        }
        Err(DomainError::UpstreamProvider)
    }
}

impl OpenAiTranscriber {
    async fn transcribe_once(
        &self,
        url: &str,
        request: &TranscriptionRequest,
    ) -> Result<Transcript, UpstreamAttemptError> {
        let model_id = &request.model.0;
        let audio_part = Part::bytes(request.audio.clone())
            .file_name(request.filename.clone())
            .mime_str(crate::transcription::audio_mime(&request.filename))
            .map_err(|error| {
                tracing::error!(%error, %url, model = %model_id, "openai: audio mime build failed");
                UpstreamAttemptError::fatal(DomainError::UpstreamProvider)
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
        if let Some(language) = request
            .language
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            form = form.text("language", language.to_string());
        }
        let response = self
            .http
            .post(url)
            .bearer_auth(&self.api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|error| {
                let retryable = retry::is_retryable_transport_error(&error);
                tracing::error!(%error, %url, model = %model_id, retryable, "openai: transport error");
                UpstreamAttemptError {
                    error: DomainError::UpstreamProvider,
                    retryable,
                }
            })?;
        let status = response.status();
        if !status.is_success() {
            let retryable = retry::is_retryable_status(status);
            let body = response.text().await.unwrap_or_default();
            tracing::error!(%status, %url, model = %model_id, body_bytes = body.len(), retryable, "openai: non-success response");
            return Err(UpstreamAttemptError {
                error: DomainError::UpstreamProvider,
                retryable,
            });
        }
        let parsed = response
            .json::<TranscriptionWireResponse>()
            .await
            .map_err(|error| {
                tracing::error!(%error, %url, model = %model_id, "openai: response JSON parse failed");
                UpstreamAttemptError::fatal(DomainError::UpstreamProvider)
            })?;
        let text = parsed.text.trim().to_string();
        if text.is_empty() {
            // No speech detected is an input condition, not an upstream fault —
            // surface it as a 400 so the client can stay silent ("nothing
            // captured") instead of flashing a backend error.
            tracing::info!(%url, model = %model_id, "openai: no speech in audio");
            return Err(UpstreamAttemptError::fatal(DomainError::InvalidInput {
                reason: "no_speech".to_string(),
            }));
        }
        Ok(Transcript {
            text,
            language: parsed.language,
            provider: PROVIDER_NAME.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::OpenAiTranscriber;
    use crate::http;
    use pretty_assertions::assert_eq;
    use scribe_config::UpstreamConfig;
    use scribe_domain::{DomainError, ModelId, Transcriber, TranscriptionRequest};
    use serde_json::json;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{method, path},
    };

    fn transcriber(server: &MockServer) -> OpenAiTranscriber {
        OpenAiTranscriber::from_config(
            http::default_client(),
            &UpstreamConfig {
                api_key: "openai_key".to_string(),
                base_url: server.uri(),
            },
        )
    }

    fn request() -> TranscriptionRequest {
        TranscriptionRequest {
            audio: b"fake wav".to_vec(),
            filename: "recording.wav".to_string(),
            title: "Title".to_string(),
            context: None,
            language: None,
            model: ModelId("gpt-4o-mini-transcribe".to_string()),
        }
    }

    #[tokio::test]
    async fn retries_transient_5xx_then_succeeds() {
        // Regression: a single momentary 503 used to surface straight to the
        // user as upstream_provider_failed with no retry.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/audio/transcriptions"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/audio/transcriptions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "text": "Hello" })))
            .mount(&server)
            .await;

        let transcript = transcriber(&server).transcribe(request()).await;

        assert_eq!(transcript.map(|value| value.text), Ok("Hello".to_string()));
    }

    #[tokio::test]
    async fn does_not_retry_deterministic_client_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/audio/transcriptions"))
            .respond_with(ResponseTemplate::new(400))
            .expect(1)
            .mount(&server)
            .await;

        let result = transcriber(&server).transcribe(request()).await;

        assert_eq!(result, Err(DomainError::UpstreamProvider));
    }
}
