use axum::{Json, extract::State};
use serde::Serialize;

use crate::{ApiState, envelope::ApiResponse};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTransportPolicyDto {
    pub attended_enabled: bool,
    pub managed_enabled: bool,
}

pub(crate) async fn get(
    State(state): State<ApiState>,
) -> Json<ApiResponse<BrowserTransportPolicyDto>> {
    let policy = state.browser_transports();
    Json(ApiResponse::ok(BrowserTransportPolicyDto {
        attended_enabled: policy.attended_enabled,
        managed_enabled: policy.managed_enabled,
    }))
}
