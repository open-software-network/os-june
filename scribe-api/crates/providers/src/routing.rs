use crate::{openai::OpenAiTranscriber, venice::VeniceTranscriber};
use async_trait::async_trait;
use scribe_config::UpstreamsConfig;
use scribe_domain::{DomainError, Transcriber, Transcript, TranscriptionRequest};
use std::collections::BTreeSet;

pub struct RoutingTranscriber {
    openai: OpenAiTranscriber,
    venice: VeniceTranscriber,
    openai_model_ids: BTreeSet<String>,
}

impl RoutingTranscriber {
    pub fn from_config(
        http: reqwest::Client,
        config: &UpstreamsConfig,
        openai_model_ids: impl IntoIterator<Item = String>,
    ) -> Self {
        Self {
            openai: OpenAiTranscriber::from_config(http.clone(), &config.openai),
            venice: VeniceTranscriber::from_config(http, &config.venice),
            openai_model_ids: openai_model_ids.into_iter().collect(),
        }
    }
}

#[async_trait]
impl Transcriber for RoutingTranscriber {
    async fn transcribe(&self, request: TranscriptionRequest) -> Result<Transcript, DomainError> {
        if self.openai_model_ids.contains(&request.model.0) {
            self.openai.transcribe(request).await
        } else {
            self.venice.transcribe(request).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::RoutingTranscriber;
    use crate::http;
    use pretty_assertions::assert_eq;
    use scribe_config::{UpstreamConfig, UpstreamsConfig};
    use scribe_domain::{ModelId, Transcriber, TranscriptionRequest};
    use serde_json::json;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_string_contains, header, method, path},
    };

    #[tokio::test]
    async fn calls_openai_for_configured_openai_model() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/audio/transcriptions"))
            .and(header("authorization", "Bearer openai_key"))
            .and(body_string_contains(r#"name="language""#))
            .and(body_string_contains("es"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "text": "Transcribed text"
            })))
            .mount(&server)
            .await;
        let transcriber = RoutingTranscriber::from_config(
            http::default_client(),
            &UpstreamsConfig {
                openai: UpstreamConfig {
                    api_key: "openai_key".to_string(),
                    base_url: server.uri(),
                },
                venice: UpstreamConfig {
                    api_key: "venice_key".to_string(),
                    base_url: server.uri(),
                },
            },
            ["gpt-4o-mini-transcribe".to_string()],
        );

        let transcript = transcriber
            .transcribe(TranscriptionRequest {
                audio: b"fake wav".to_vec(),
                format: scribe_domain::AudioFormat::Wav,
                context: Some("Prompt context".to_string()),
                language: Some("es".to_string()),
                model: ModelId("gpt-4o-mini-transcribe".to_string()),
            })
            .await;

        assert_eq!(
            transcript.map(|value| (value.text, value.provider)),
            Ok(("Transcribed text".to_string(), "openai".to_string()))
        );
    }
}
