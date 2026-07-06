use crate::{
    auth::{authenticated_user, provider_credentials},
    envelope::ApiResponse,
    error::ApiError,
    state::ApiState,
    validation,
};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, header},
    response::{IntoResponse, Response},
};
use june_domain::GeneratedVideo;
use june_services::{JobId, VideoAnimateParams, VideoGenerateParams, VideoStatusOutput};
use serde::{Deserialize, Serialize};

const VIDEO_MIME_FALLBACK: &str = "video/mp4";

/// A text-to-video request. `duration` is Venice's string enum; per-model valid
/// combinations of `duration`/`resolution`/`aspectRatio`/`audio` are enforced by
/// Venice, surfaced as a bad request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoGenerateRequest {
    pub prompt: String,
    pub model: String,
    /// Optional client-generated id for deduping a retried video create to one
    /// Venice queue. New clients send a fresh id per logical call and reuse it
    /// only when retrying a dropped response.
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub duration: String,
    #[serde(default)]
    pub resolution: Option<String>,
    #[serde(default)]
    pub aspect_ratio: Option<String>,
    #[serde(default)]
    pub audio: Option<bool>,
    #[serde(default)]
    pub negative_prompt: Option<String>,
}

/// An image-to-video (animate) request. `image` is the source frame as raw
/// base64 (no `data:` prefix), like `/v1/image/edit`. `model` is optional —
/// omitted requests use June API's default animate model.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoAnimateRequest {
    pub image: String,
    pub prompt: String,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub duration: String,
    #[serde(default)]
    pub resolution: Option<String>,
    #[serde(default)]
    pub aspect_ratio: Option<String>,
    #[serde(default)]
    pub audio: Option<bool>,
    #[serde(default)]
    pub negative_prompt: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoJobResponse {
    pub job_id: String,
}

/// The JSON status payload for a poll that has not yet resolved to inline bytes.
/// A completed non-VPS job streams raw `video/mp4` instead of this envelope.
#[derive(Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum VideoStatusResponse {
    Processing {
        average_execution_ms: u64,
        execution_ms: u64,
    },
    Completed {
        download_url: Option<String>,
        mime_type: String,
        model: String,
        provider: String,
        size_bytes: Option<u64>,
    },
    Failed {
        reason: String,
    },
}

/// Text-to-video: authorize a hold, quote, queue the Venice job, and return a
/// `jobId`. The client polls `GET /v1/video/status/:jobId`; the charge settles
/// once on the completing poll (see `VideoService`). An unpriced model is
/// rejected `model_not_priced`; a user Venice key skips June credit metering.
pub(crate) async fn generate(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<VideoGenerateRequest>,
) -> Result<Json<ApiResponse<VideoJobResponse>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let provider_credentials = provider_credentials(&headers)?;

    let prompt = required_prompt(&request.prompt)?;
    let model = required_model(&request.model)?;
    let request_id = optional_request_id(request.request_id)?;
    let duration = required_duration(&request.duration)?;
    let resolution = optional_param("resolution", request.resolution)?;
    let aspect_ratio = optional_param("aspectRatio", request.aspect_ratio)?;
    let negative_prompt = optional_negative_prompt(request.negative_prompt)?;

    let output = state
        .video()
        .generate(VideoGenerateParams {
            user_id,
            request_id,
            prompt,
            model,
            duration,
            resolution,
            aspect_ratio,
            audio: request.audio,
            negative_prompt,
            provider_credentials,
        })
        .await?;

    Ok(Json(ApiResponse::ok(VideoJobResponse {
        job_id: output.job_id.0,
    })))
}

/// Image-to-video: like `generate`, but seeded with a source image supplied as
/// base64. The model is optional (the MCP names none); the default animate model
/// governs when absent.
pub(crate) async fn animate(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<VideoAnimateRequest>,
) -> Result<Json<ApiResponse<VideoJobResponse>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let provider_credentials = provider_credentials(&headers)?;

    let prompt = required_prompt(&request.prompt)?;
    let image = request.image.trim().to_string();
    if image.is_empty() {
        return Err(ApiError::bad_request("image_required"));
    }
    let request_id = optional_request_id(request.request_id)?;
    let duration = required_duration(&request.duration)?;
    let resolution = optional_param("resolution", request.resolution)?;
    let aspect_ratio = optional_param("aspectRatio", request.aspect_ratio)?;
    let negative_prompt = optional_negative_prompt(request.negative_prompt)?;

    // Model is optional; an empty string is treated as absent so the service's
    // default animate model applies.
    let model = request
        .model
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty());
    if let Some(model) = &model {
        validation::validate_text_len("model", model, validation::MAX_MODEL_CHARS)?;
    }

    let output = state
        .video()
        .animate(VideoAnimateParams {
            user_id,
            request_id,
            image_base64: image,
            mime_type: request
                .mime_type
                .map(|mime| mime.trim().to_string())
                .filter(|mime| !mime.is_empty())
                .unwrap_or_else(|| "image/png".to_string()),
            prompt,
            model,
            duration,
            resolution,
            aspect_ratio,
            audio: request.audio,
            negative_prompt,
            provider_credentials,
        })
        .await?;

    Ok(Json(ApiResponse::ok(VideoJobResponse {
        job_id: output.job_id.0,
    })))
}

/// Polls a video job. Returns a JSON status envelope while processing (or for a
/// terminal failure / a VPS URL), or the raw `video/mp4` bytes on a non-VPS
/// completion. The charge settles once on the completing poll (see
/// `VideoService`).
pub(crate) async fn status(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let job_id = job_id.trim().to_string();
    if job_id.is_empty() {
        return Err(ApiError::bad_request("job_id_required"));
    }
    validation::validate_text_len("job_id", &job_id, validation::MAX_ID_CHARS)?;

    let output = state.video().status(user_id, JobId(job_id)).await?;
    Ok(match output {
        VideoStatusOutput::Processing {
            average_execution_ms,
            execution_ms,
        } => Json(ApiResponse::ok(VideoStatusResponse::Processing {
            average_execution_ms,
            execution_ms,
        }))
        .into_response(),
        VideoStatusOutput::Failed { reason } => {
            Json(ApiResponse::ok(VideoStatusResponse::Failed { reason })).into_response()
        }
        VideoStatusOutput::Completed(video) => completed_response(video),
    })
}

/// A non-VPS completion streams the mp4 bytes; a VPS-backed completion (bytes at
/// a pre-signed URL) returns a JSON envelope carrying that URL instead.
fn completed_response(video: GeneratedVideo) -> Response {
    let GeneratedVideo {
        bytes,
        download_url,
        mime_type,
        model,
        provider,
        size_bytes,
    } = video;
    if let Some(bytes) = bytes {
        let mime = if mime_type.trim().is_empty() {
            VIDEO_MIME_FALLBACK.to_string()
        } else {
            mime_type
        };
        return ([(header::CONTENT_TYPE, mime)], bytes).into_response();
    }
    Json(ApiResponse::ok(VideoStatusResponse::Completed {
        download_url,
        mime_type,
        model,
        provider,
        size_bytes,
    }))
    .into_response()
}

fn required_prompt(raw: &str) -> Result<String, ApiError> {
    let prompt = raw.trim().to_string();
    if prompt.is_empty() {
        return Err(ApiError::bad_request("prompt_required"));
    }
    validation::validate_text_len("prompt", &prompt, validation::MAX_IMAGE_PROMPT_CHARS)?;
    Ok(prompt)
}

fn required_model(raw: &str) -> Result<String, ApiError> {
    let model = raw.trim().to_string();
    if model.is_empty() {
        return Err(ApiError::bad_request("model_required"));
    }
    validation::validate_text_len("model", &model, validation::MAX_MODEL_CHARS)?;
    Ok(model)
}

fn required_duration(raw: &str) -> Result<String, ApiError> {
    let duration = raw.trim().to_string();
    if duration.is_empty() {
        return Err(ApiError::bad_request("duration_required"));
    }
    validation::validate_text_len("duration", &duration, validation::MAX_VIDEO_PARAM_CHARS)?;
    Ok(duration)
}

fn optional_param(field: &str, raw: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(value) = raw
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    validation::validate_text_len(field, &value, validation::MAX_VIDEO_PARAM_CHARS)?;
    Ok(Some(value))
}

fn optional_negative_prompt(raw: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(value) = raw
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    validation::validate_text_len("negativePrompt", &value, validation::MAX_IMAGE_PROMPT_CHARS)?;
    Ok(Some(value))
}

fn optional_request_id(raw: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(request_id) = raw
        .map(|request_id| request_id.trim().to_string())
        .filter(|request_id| !request_id.is_empty())
    else {
        return Ok(None);
    };
    validation::validate_text_len("request_id", &request_id, validation::MAX_ID_CHARS)?;
    Ok(Some(request_id))
}
