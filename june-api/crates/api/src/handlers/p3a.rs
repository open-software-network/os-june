use crate::{auth::authenticated_user, envelope::ApiResponse, error::ApiError, state::ApiState};
use axum::{Json, extract::State, http::HeaderMap};
use june_services::P3aReportParams;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct P3aReportRequest {
    pub schema: u32,
    pub question_id: String,
    pub epoch: String,
    pub platform: String,
    pub version_series: String,
    pub bucket: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P3aReportResponse {
    pub accepted: bool,
}

pub(crate) async fn submit(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<P3aReportRequest>,
) -> Result<Json<ApiResponse<P3aReportResponse>>, ApiError> {
    let _ = authenticated_user(&state, &headers).await?;

    state
        .p3a_reports()
        .record(P3aReportParams {
            schema: request.schema,
            question_id: request.question_id,
            epoch: request.epoch,
            platform: request.platform,
            version_series: request.version_series,
            bucket: request.bucket,
        })
        .await?;

    Ok(Json(ApiResponse::ok(P3aReportResponse { accepted: true })))
}
