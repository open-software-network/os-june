use axum::{Json, http::StatusCode};
use serde::Serialize;

use crate::envelope::ApiResponse;

/// Liveness probe — the process is up. Polled by the Phala/dstack prelaunch and
/// load balancers; must stay dependency-free so it answers even mid-startup.
pub(crate) async fn livez() -> StatusCode {
    StatusCode::OK
}

/// Readiness probe — the service is ready to accept traffic.
pub(crate) async fn readyz() -> StatusCode {
    StatusCode::OK
}

/// Service identity + build version, returned in the standard response envelope.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthDto {
    pub status: &'static str,
    pub service: &'static str,
    pub version: &'static str,
}

/// Health summary: reports the running service name and compiled-in version so
/// callers can confirm which build is live.
pub(crate) async fn healthz() -> Json<ApiResponse<HealthDto>> {
    Json(ApiResponse::ok(HealthDto {
        status: "healthy",
        service: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
    }))
}
