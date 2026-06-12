use crate::{
    auth::authenticated_user, envelope::ApiResponse, error::ApiError, state::ApiState, validation,
};
use axum::{Json, extract::State, http::HeaderMap};
use scribe_domain::{DomainError, OnboardingSurvey, OnboardingSurveySource};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingSurveyRequest {
    source: String,
    app_version: Option<String>,
    platform: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingSurveyResponse {
    pub received: bool,
}

impl OnboardingSurveyRequest {
    fn validate(&self) -> Result<OnboardingSurveySource, ApiError> {
        let source = OnboardingSurveySource::from_slug(self.source.trim())
            .ok_or_else(|| ApiError::bad_request("source_invalid"))?;
        validation::validate_optional_text_len(
            "app_version",
            self.app_version.as_deref(),
            validation::MAX_ID_CHARS,
        )?;
        validation::validate_optional_text_len(
            "platform",
            self.platform.as_deref(),
            validation::MAX_ID_CHARS,
        )?;
        Ok(source)
    }
}

pub(crate) async fn submit(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<OnboardingSurveyRequest>,
) -> Result<Json<ApiResponse<OnboardingSurveyResponse>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let source = request.validate()?;
    state
        .surveys()
        .deliver(OnboardingSurvey {
            user_id,
            source,
            app_version: request.app_version,
            platform: request.platform,
        })
        .await
        .map_err(|error| match error {
            DomainError::InvalidInput { reason } => ApiError::bad_request(reason),
            _ => ApiError::Upstream,
        })?;
    Ok(Json(ApiResponse::ok(OnboardingSurveyResponse {
        received: true,
    })))
}
