use crate::{openai::OpenAiTranscriber, venice::VeniceTranscriber};
use async_trait::async_trait;
use june_config::UpstreamsConfig;
use june_domain::{DomainError, Transcriber, Transcript, TranscriptionRequest};
use std::sync::Arc;

pub struct RoutingTranscriber {
    openai: OpenAiTranscriber,
    venice: VeniceTranscriber,
    is_openai_model: Arc<dyn Fn(&str) -> bool + Send + Sync>,
}

impl RoutingTranscriber {
    pub fn from_config(
        http: reqwest::Client,
        config: &UpstreamsConfig,
        is_openai_model: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    ) -> Self {
        Self {
            openai: OpenAiTranscriber::from_config(http.clone(), &config.openai),
            venice: VeniceTranscriber::from_config(http, &config.venice),
            is_openai_model,
        }
    }
}

#[async_trait]
impl Transcriber for RoutingTranscriber {
    async fn transcribe(&self, request: TranscriptionRequest) -> Result<Transcript, DomainError> {
        if (self.is_openai_model)(&request.model.0) {
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
    use june_config::{UpstreamConfig, UpstreamsConfig};
    use june_domain::{ModelId, ProviderCredentials, Transcriber, TranscriptionRequest};
    use pretty_assertions::assert_eq;
    use serde_json::json;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_string_contains, header, method, path},
    };

    #[tokio::test]
    async fn consults_the_live_catalog_for_each_request() {
        let openai_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/audio/transcriptions"))
            .and(header("authorization", "Bearer openai_key"))
            .and(body_string_contains(r#"name="language""#))
            .and(body_string_contains("es"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "text": "Transcribed text"
            })))
            .mount(&openai_server)
            .await;
        let venice_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/audio/transcriptions"))
            .and(header("authorization", "Bearer venice_key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "text": "Venice text"
            })))
            .mount(&venice_server)
            .await;
        let route_to_openai = Arc::new(AtomicBool::new(false));
        let live_route = route_to_openai.clone();
        let transcriber = RoutingTranscriber::from_config(
            http::default_client(),
            &UpstreamsConfig {
                openai: UpstreamConfig {
                    api_key: "openai_key".to_string(),
                    base_url: openai_server.uri(),
                    byok_base_url: None,
                },
                venice: UpstreamConfig {
                    api_key: "venice_key".to_string(),
                    base_url: venice_server.uri(),
                    byok_base_url: None,
                },
            },
            Arc::new(move |_| live_route.load(Ordering::Relaxed)),
        );

        let venice_transcript = transcriber
            .transcribe(TranscriptionRequest {
                audio: b"fake wav".to_vec(),
                format: june_domain::AudioFormat::Wav,
                context: Some("Prompt context".to_string()),
                language: Some("es".to_string()),
                model: ModelId("gpt-4o-mini-transcribe".to_string()),
                provider_credentials: ProviderCredentials::default(),
            })
            .await;
        route_to_openai.store(true, Ordering::Relaxed);
        let openai_transcript = transcriber
            .transcribe(TranscriptionRequest {
                audio: b"fake wav".to_vec(),
                format: june_domain::AudioFormat::Wav,
                context: Some("Prompt context".to_string()),
                language: Some("es".to_string()),
                model: ModelId("gpt-4o-mini-transcribe".to_string()),
                provider_credentials: ProviderCredentials::default(),
            })
            .await;

        assert_eq!(
            venice_transcript.map(|value| (value.text, value.provider)),
            Ok(("Venice text".to_string(), "venice".to_string()))
        );
        assert_eq!(
            openai_transcript.map(|value| (value.text, value.provider)),
            Ok(("Transcribed text".to_string(), "openai".to_string()))
        );
    }
}
