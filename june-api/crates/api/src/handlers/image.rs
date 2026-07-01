use crate::{
    auth::{authenticated_user, provider_credentials},
    envelope::ApiResponse,
    error::ApiError,
    state::ApiState,
    validation,
};
use axum::{Json, extract::State, http::HeaderMap};
use june_domain::GeneratedImage;
use june_services::ImageGenerateParams;
use serde::{Deserialize, Serialize};

/// Bounds for an explicit `width`/`height`. We only reject values above Venice's
/// max here; the per-model *minimum* is enforced by Venice itself (pixel models
/// typically floor at 64-256 px), where a too-small value returns a 400 that
/// surfaces as `image_generation_rejected`. Client validation defers to Venice's
/// per-model floor rather than guessing one.
const MIN_IMAGE_DIMENSION: u32 = 1;
const MAX_IMAGE_DIMENSION: u32 = 1280;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerateRequest {
    pub prompt: String,
    pub model: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerateResponse {
    pub image_base64: String,
    pub mime_type: String,
    pub model: String,
    pub provider: String,
}

impl From<GeneratedImage> for ImageGenerateResponse {
    fn from(value: GeneratedImage) -> Self {
        Self {
            image_base64: value.image_base64,
            mime_type: value.mime_type,
            model: value.model,
            provider: value.provider,
        }
    }
}

/// Generates an image from a text prompt via Venice. Without a user Venice key,
/// the service holds a wallet estimate, generates, then charges the model's
/// flat per-image price (see `ImageService`). A user Venice key skips June
/// credit metering. An unpriced model is rejected `model_not_priced`; an
/// out-of-credits user without BYOK gets 402 before Venice is called.
pub(crate) async fn generate(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<ImageGenerateRequest>,
) -> Result<Json<ApiResponse<ImageGenerateResponse>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let provider_credentials = provider_credentials(&headers)?;

    let prompt = request.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(ApiError::bad_request("prompt_required"));
    }
    validation::validate_text_len("prompt", &prompt, validation::MAX_IMAGE_PROMPT_CHARS)?;

    let model = request.model.trim().to_string();
    if model.is_empty() {
        return Err(ApiError::bad_request("model_required"));
    }
    validation::validate_text_len("model", &model, validation::MAX_MODEL_CHARS)?;

    let width = validate_dimension("width", request.width)?;
    let height = validate_dimension("height", request.height)?;

    let output = state
        .image()
        .generate(ImageGenerateParams {
            user_id,
            prompt,
            model,
            width,
            height,
            provider_credentials,
        })
        .await?;

    Ok(Json(ApiResponse::ok(output.image.into())))
}

fn validate_dimension(field: &str, value: Option<u32>) -> Result<Option<u32>, ApiError> {
    match value {
        Some(value) if !(MIN_IMAGE_DIMENSION..=MAX_IMAGE_DIMENSION).contains(&value) => {
            Err(ApiError::bad_request(format!("{field}_out_of_range")))
        }
        other => Ok(other),
    }
}
