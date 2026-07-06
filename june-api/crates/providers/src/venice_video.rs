//! Venice video generation: proxies the async `/video/*` endpoints.
//!
//! Video is Venice's asynchronous, dynamically priced surface (ADR 0012). A
//! `quote` is the free price oracle, `queue` starts a job and returns a queue
//! handle, and `retrieve` polls it — returning either JSON progress or, when
//! COMPLETED and non-VPS, the raw `video/mp4` bytes (discriminated by response
//! `Content-Type`). Billing (quote -> credits -> authorize -> charge-once)
//! lives in `VideoService`; this provider does inference/transport only and
//! surfaces Venice's policy/consent/region/capacity statuses as reasoned
//! `DomainError`s the service translates.

use async_trait::async_trait;
use june_config::UpstreamConfig;
use june_domain::{
    DomainError, VideoAnimationRequest, VideoGenerationRequest, VideoProvider, VideoQueued,
    VideoQuoteRequest, VideoRetrieved,
};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const DEFAULT_VIDEO_MIME: &str = "video/mp4";

pub struct VeniceVideoProvider {
    http: reqwest::Client,
    api_key: String,
    base_url: String,
    /// Per-call budget for a single Venice video request. The async job budget
    /// (many polls) is bounded by the video hold TTL in june-config, not here.
    timeout: Duration,
}

impl VeniceVideoProvider {
    pub fn from_config(http: reqwest::Client, config: &UpstreamConfig, timeout: Duration) -> Self {
        Self {
            http,
            api_key: config.api_key.clone(),
            base_url: config.base_url.trim_end_matches('/').to_string(),
            timeout,
        }
    }

    async fn queue_body(
        &self,
        url: &str,
        body: &VeniceVideoQueueBody<'_>,
    ) -> Result<VideoQueued, DomainError> {
        let send = self
            .http
            .post(url)
            .bearer_auth(&self.api_key)
            .json(body)
            .send();
        let response = match tokio::time::timeout(self.timeout, send).await {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                tracing::error!(%error, %url, model = %body.model, "venice video: queue transport error");
                return Err(DomainError::UpstreamProvider);
            }
            Err(_elapsed) => {
                tracing::error!(%url, model = %body.model, "venice video: queue timed out");
                return Err(DomainError::UpstreamProvider);
            }
        };
        let status = response.status();
        if !status.is_success() {
            let body_text = response.text().await.unwrap_or_default();
            tracing::error!(%status, %url, model = %body.model, body_bytes = body_text.len(), "venice video: queue non-success response");
            return Err(venice_video_error(status, "video_generation_rejected"));
        }
        let parsed = response.json::<VeniceVideoQueueResponse>().await.map_err(|error| {
            tracing::error!(%error, %url, model = %body.model, "venice video: queue JSON parse failed");
            DomainError::UpstreamProvider
        })?;
        let queue_id = parsed.queue_id.trim().to_string();
        if queue_id.is_empty() {
            tracing::error!(%url, model = %body.model, "venice video: queue response missing queue_id");
            return Err(DomainError::UpstreamProvider);
        }
        Ok(VideoQueued {
            venice_queue_id: queue_id,
            download_url: parsed
                .download_url
                .map(|url| url.trim().to_string())
                .filter(|url| !url.is_empty()),
        })
    }
}

#[async_trait]
impl VideoProvider for VeniceVideoProvider {
    async fn quote(&self, request: VideoQuoteRequest) -> Result<f64, DomainError> {
        let url = format!("{}/video/quote", self.base_url);
        let body = VeniceVideoQuoteBody {
            model: &request.model.0,
            duration: &request.duration,
            resolution: request.resolution.as_deref(),
            aspect_ratio: request.aspect_ratio.as_deref(),
            audio: request.audio,
        };
        // The quote is June's own pricing basis, so it always runs against the
        // configured Venice key (no user credentials).
        let send = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send();
        let response = match tokio::time::timeout(self.timeout, send).await {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                tracing::error!(%error, %url, model = %request.model.0, "venice video: quote transport error");
                return Err(DomainError::UpstreamProvider);
            }
            Err(_elapsed) => {
                tracing::error!(%url, model = %request.model.0, "venice video: quote timed out");
                return Err(DomainError::UpstreamProvider);
            }
        };
        let status = response.status();
        if !status.is_success() {
            let body_text = response.text().await.unwrap_or_default();
            tracing::error!(%status, %url, model = %request.model.0, body_bytes = body_text.len(), "venice video: quote non-success response");
            return Err(venice_video_error(status, "video_quote_rejected"));
        }
        let parsed = response.json::<VeniceVideoQuoteResponse>().await.map_err(|error| {
            tracing::error!(%error, %url, model = %request.model.0, "venice video: quote JSON parse failed");
            DomainError::UpstreamProvider
        })?;
        if !parsed.quote.is_finite() || parsed.quote < 0.0 {
            tracing::error!(%url, model = %request.model.0, quote = parsed.quote, "venice video: quote is not a valid price");
            return Err(DomainError::UpstreamProvider);
        }
        Ok(parsed.quote)
    }

    async fn queue(&self, request: VideoGenerationRequest) -> Result<VideoQueued, DomainError> {
        let prompt = request.prompt.trim();
        if prompt.is_empty() {
            return Err(DomainError::InvalidInput {
                reason: "video_prompt_empty".to_string(),
            });
        }
        let url = format!("{}/video/queue", self.base_url);
        let body = VeniceVideoQueueBody {
            model: &request.model.0,
            prompt,
            duration: &request.duration,
            resolution: request.resolution.as_deref(),
            aspect_ratio: request.aspect_ratio.as_deref(),
            audio: request.audio,
            negative_prompt: request.negative_prompt.as_deref(),
            image_url: None,
        };
        self.queue_body(&url, &body).await
    }

    async fn queue_animation(
        &self,
        request: VideoAnimationRequest,
    ) -> Result<VideoQueued, DomainError> {
        let prompt = request.prompt.trim();
        if prompt.is_empty() {
            return Err(DomainError::InvalidInput {
                reason: "video_prompt_empty".to_string(),
            });
        }
        let image = request.image_base64.trim();
        if image.is_empty() {
            return Err(DomainError::InvalidInput {
                reason: "video_source_empty".to_string(),
            });
        }
        let mime = if request.mime_type.trim().is_empty() {
            "image/png"
        } else {
            request.mime_type.trim()
        };
        let image_url = format!("data:{mime};base64,{image}");
        let url = format!("{}/video/queue", self.base_url);
        let body = VeniceVideoQueueBody {
            model: &request.model.0,
            prompt,
            duration: &request.duration,
            resolution: request.resolution.as_deref(),
            aspect_ratio: request.aspect_ratio.as_deref(),
            audio: request.audio,
            negative_prompt: request.negative_prompt.as_deref(),
            image_url: Some(&image_url),
        };
        self.queue_body(&url, &body).await
    }

    async fn retrieve(&self, model: &str, queue_id: &str) -> Result<VideoRetrieved, DomainError> {
        let url = format!("{}/video/retrieve", self.base_url);
        let body = VeniceVideoRetrieveBody { model, queue_id };
        // Retrieve runs against the configured Venice key: June queued the job.
        let send = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send();
        let response = match tokio::time::timeout(self.timeout, send).await {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                tracing::error!(%error, %url, model, "venice video: retrieve transport error");
                return Err(DomainError::UpstreamProvider);
            }
            Err(_elapsed) => {
                tracing::error!(%url, model, "venice video: retrieve timed out");
                return Err(DomainError::UpstreamProvider);
            }
        };
        let status = response.status();
        if !status.is_success() {
            if status == StatusCode::NOT_FOUND {
                tracing::warn!(%status, %url, model, "venice video: retrieve media expired or deleted");
                return Err(DomainError::InvalidInput {
                    reason: "video_media_expired".to_string(),
                });
            }
            let body_text = response.text().await.unwrap_or_default();
            tracing::error!(%status, %url, model, body_bytes = body_text.len(), "venice video: retrieve non-success response");
            return Err(venice_video_error(status, "video_retrieve_rejected"));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        if content_type_is_json(&content_type) {
            let parsed = response.json::<VeniceVideoRetrieveResponse>().await.map_err(|error| {
                tracing::error!(%error, %url, model, "venice video: retrieve JSON parse failed");
                DomainError::UpstreamProvider
            })?;
            return retrieved_from_json(parsed, model);
        }
        // Any non-JSON success body is the raw video bytes (COMPLETED, non-VPS).
        let mime = if content_type.trim().is_empty() {
            DEFAULT_VIDEO_MIME.to_string()
        } else {
            content_type
        };
        let bytes = response.bytes().await.map_err(|error| {
            tracing::error!(%error, %url, model, "venice video: reading retrieved bytes failed");
            DomainError::UpstreamProvider
        })?;
        if bytes.is_empty() {
            return Err(DomainError::UpstreamProvider);
        }
        Ok(VideoRetrieved::CompletedBytes {
            bytes: bytes.to_vec(),
            mime_type: mime,
        })
    }
}

fn content_type_is_json(content_type: &str) -> bool {
    content_type
        .split(';')
        .next()
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case("application/json"))
}

fn retrieved_from_json(
    parsed: VeniceVideoRetrieveResponse,
    model: &str,
) -> Result<VideoRetrieved, DomainError> {
    match parsed.status.trim().to_ascii_uppercase().as_str() {
        "PROCESSING" => Ok(VideoRetrieved::Processing {
            average_execution_ms: parsed.average_execution_time.unwrap_or(0),
            execution_ms: parsed.execution_duration.unwrap_or(0),
        }),
        // COMPLETED JSON means the bytes are at a VPS-backed pre-signed URL, not
        // inline. Venice's retrieve JSON usually omits the URL, so carry whatever
        // it gave (possibly empty) and let the service fall back to the queue-time
        // download_url.
        "COMPLETED" => Ok(VideoRetrieved::CompletedUrl {
            download_url: parsed
                .download_url
                .map(|url| url.trim().to_string())
                .unwrap_or_default(),
        }),
        other => {
            tracing::error!(
                model,
                status = other,
                "venice video: retrieve unknown status"
            );
            Err(DomainError::UpstreamProvider)
        }
    }
}

/// Maps a Venice video error status to a reasoned `DomainError` the service
/// translates. Policy/consent/region/too-large are deterministic 4xx surfaced
/// as reasoned `InvalidInput`; a 503 (at-capacity) is retryable and surfaced as
/// `MeteringProvider` (the only variant whose API mapping is a retryable 503 -
/// June has no dedicated upstream-capacity status).
fn venice_video_error(status: StatusCode, rejected_reason: &str) -> DomainError {
    match status {
        StatusCode::BAD_REQUEST => DomainError::InvalidInput {
            reason: rejected_reason.to_string(),
        },
        StatusCode::UNPROCESSABLE_ENTITY => DomainError::InvalidInput {
            reason: "video_content_violation".to_string(),
        },
        StatusCode::CONFLICT => DomainError::InvalidInput {
            reason: "video_needs_consent".to_string(),
        },
        StatusCode::PAYLOAD_TOO_LARGE => DomainError::InvalidInput {
            reason: "video_payload_too_large".to_string(),
        },
        StatusCode::FORBIDDEN => DomainError::InvalidInput {
            reason: "video_model_region_blocked".to_string(),
        },
        StatusCode::SERVICE_UNAVAILABLE => DomainError::MeteringProvider,
        _ => DomainError::UpstreamProvider,
    }
}

#[derive(Serialize)]
struct VeniceVideoQuoteBody<'a> {
    model: &'a str,
    duration: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolution: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    aspect_ratio: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    audio: Option<bool>,
}

#[derive(Serialize)]
struct VeniceVideoQueueBody<'a> {
    model: &'a str,
    prompt: &'a str,
    duration: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolution: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    aspect_ratio: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    audio: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    negative_prompt: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_url: Option<&'a str>,
}

#[derive(Serialize)]
struct VeniceVideoRetrieveBody<'a> {
    model: &'a str,
    queue_id: &'a str,
}

#[derive(Deserialize)]
struct VeniceVideoQuoteResponse {
    quote: f64,
}

#[derive(Deserialize)]
struct VeniceVideoQueueResponse {
    queue_id: String,
    #[serde(default)]
    download_url: Option<String>,
}

#[derive(Deserialize)]
struct VeniceVideoRetrieveResponse {
    #[serde(default)]
    status: String,
    #[serde(default)]
    average_execution_time: Option<u64>,
    #[serde(default)]
    execution_duration: Option<u64>,
    #[serde(default)]
    download_url: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::VeniceVideoProvider;
    use crate::http;
    use june_config::UpstreamConfig;
    use june_domain::{
        DomainError, ModelId, VideoGenerationRequest, VideoProvider, VideoQuoteRequest,
        VideoRetrieved,
    };
    use pretty_assertions::assert_eq;
    use serde_json::json;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_string_contains, header, method, path},
    };

    fn provider(server: &MockServer) -> VeniceVideoProvider {
        VeniceVideoProvider::from_config(
            http::default_client(),
            &UpstreamConfig {
                api_key: "venice_key".to_string(),
                base_url: server.uri(),
            },
            std::time::Duration::from_secs(5),
        )
    }

    fn generation_request(prompt: &str) -> VideoGenerationRequest {
        VideoGenerationRequest {
            prompt: prompt.to_string(),
            model: ModelId("wan-2.2-a14b-text-to-video".to_string()),
            duration: "5s".to_string(),
            resolution: Some("720p".to_string()),
            aspect_ratio: Some("16:9".to_string()),
            audio: Some(false),
            negative_prompt: None,
        }
    }

    #[tokio::test]
    async fn quote_returns_the_usd_price() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/video/quote"))
            .and(header("authorization", "Bearer venice_key"))
            .and(body_string_contains(
                "\"model\":\"wan-2.2-a14b-text-to-video\"",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "quote": 0.11 })))
            .mount(&server)
            .await;

        let quote = provider(&server)
            .quote(VideoQuoteRequest {
                model: ModelId("wan-2.2-a14b-text-to-video".to_string()),
                duration: "5s".to_string(),
                resolution: Some("720p".to_string()),
                aspect_ratio: None,
                audio: None,
            })
            .await
            .expect("quote succeeds");

        assert!((quote - 0.11).abs() < 1e-9);
    }

    #[tokio::test]
    async fn queue_returns_queue_id_and_optional_download_url() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/video/queue"))
            .and(header("authorization", "Bearer venice_key"))
            .and(body_string_contains("\"prompt\":\"a robot dancing\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "model": "wan-2.2-a14b-text-to-video",
                "queue_id": "vq_123",
            })))
            .mount(&server)
            .await;

        let queued = provider(&server)
            .queue(generation_request("a robot dancing"))
            .await
            .expect("queue succeeds");

        assert_eq!(queued.venice_queue_id, "vq_123");
        assert_eq!(queued.download_url, None);
    }

    #[tokio::test]
    async fn retrieve_parses_processing_then_completed_bytes() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/video/retrieve"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "PROCESSING",
                "average_execution_time": 145_000,
                "execution_duration": 30_000,
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/video/retrieve"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(vec![0_u8, 1, 2, 3], "video/mp4"))
            .mount(&server)
            .await;

        let first = provider(&server)
            .retrieve("wan-2.2-a14b-text-to-video", "vq_123")
            .await
            .expect("first retrieve succeeds");
        assert_eq!(
            first,
            VideoRetrieved::Processing {
                average_execution_ms: 145_000,
                execution_ms: 30_000,
            }
        );

        let second = provider(&server)
            .retrieve("wan-2.2-a14b-text-to-video", "vq_123")
            .await
            .expect("second retrieve succeeds");
        assert_eq!(
            second,
            VideoRetrieved::CompletedBytes {
                bytes: vec![0, 1, 2, 3],
                mime_type: "video/mp4".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn retrieve_completed_json_returns_completed_url() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/video/retrieve"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "COMPLETED",
                "download_url": "https://cdn.venice.ai/vq_123.mp4",
            })))
            .mount(&server)
            .await;

        let retrieved = provider(&server)
            .retrieve("wan-2.2-a14b-text-to-video", "vq_123")
            .await
            .expect("retrieve succeeds");

        assert_eq!(
            retrieved,
            VideoRetrieved::CompletedUrl {
                download_url: "https://cdn.venice.ai/vq_123.mp4".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn queue_content_violation_maps_to_reasoned_invalid_input() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/video/queue"))
            .respond_with(ResponseTemplate::new(422).set_body_string("content violation"))
            .mount(&server)
            .await;

        let error = provider(&server)
            .queue(generation_request("something disallowed"))
            .await
            .expect_err("a 422 should surface as content violation");

        assert_eq!(
            error,
            DomainError::InvalidInput {
                reason: "video_content_violation".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn queue_needs_consent_maps_to_reasoned_invalid_input() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/video/queue"))
            .respond_with(ResponseTemplate::new(409).set_body_string("needs consent"))
            .mount(&server)
            .await;

        let error = provider(&server)
            .queue(generation_request("a person"))
            .await
            .expect_err("a 409 should surface as needs consent");

        assert_eq!(
            error,
            DomainError::InvalidInput {
                reason: "video_needs_consent".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn queue_capacity_maps_to_metering_provider() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/video/queue"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;

        let error = provider(&server)
            .queue(generation_request("anything"))
            .await
            .expect_err("a 503 should surface as a retryable metering error");

        assert_eq!(error, DomainError::MeteringProvider);
    }

    #[tokio::test]
    async fn retrieve_expired_media_maps_to_reasoned_invalid_input() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/video/retrieve"))
            .respond_with(ResponseTemplate::new(404).set_body_string("not found"))
            .mount(&server)
            .await;

        let error = provider(&server)
            .retrieve("wan-2.2-a14b-text-to-video", "vq_expired")
            .await
            .expect_err("a 404 should surface as expired media");

        assert_eq!(
            error,
            DomainError::InvalidInput {
                reason: "video_media_expired".to_string(),
            }
        );
    }
}
