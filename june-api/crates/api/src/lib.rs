#![cfg_attr(test, allow(clippy::expect_used, clippy::unwrap_used, clippy::panic))]

mod audio;
mod auth;
mod envelope;
mod error;
mod handlers;
mod multipart;
mod state;
mod validation;

use axum::{
    Router,
    error_handling::HandleErrorLayer,
    extract::DefaultBodyLimit,
    response::IntoResponse,
    routing::{get, post},
};
use std::time::Duration;
use tower::{BoxError, ServiceBuilder, timeout::TimeoutLayer};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

pub use envelope::{
    ApiResponse, ERR_AUTHORIZATION_DENIED, ERR_BAD_REQUEST, ERR_INSUFFICIENT_CREDITS, ERR_INTERNAL,
    ERR_METERING, ERR_NOT_FOUND, ERR_PAYLOAD_TOO_LARGE, ERR_TIMEOUT, ERR_UNAUTHORIZED,
    ERR_UNPROCESSABLE, ERR_UPSTREAM,
};
pub use error::ApiError;
pub use handlers::dictate::{
    DictateCleanupRequest, DictateCleanupResponse, DictateTranscribeResponse,
};
pub use handlers::health::HealthDto;
pub use handlers::image::{ImageEditRequest, ImageGenerateRequest, ImageGenerateResponse};
pub use handlers::issues::IssueReportResponse;
pub use handlers::models::ModelDto;
pub use handlers::notes::{GenerateRequest, GenerateResponse, TranscribeResponse};
pub use handlers::video::{
    VideoAnimateRequest, VideoGenerateRequest, VideoJobResponse, VideoStatusResponse,
};
pub use handlers::web::{WebFetchRequest, WebSearchRequest};
pub use state::{ApiLimits, ApiState, ApiStateParams, AttestationInfo};

pub fn router(state: ApiState) -> Router {
    let limits = state.limits();
    let timeout = ServiceBuilder::new()
        .layer(HandleErrorLayer::new(handle_timeout_error))
        .layer(TimeoutLayer::new(Duration::from_secs(
            limits.request_timeout_secs,
        )));
    Router::new()
        .route("/livez", get(handlers::health::livez))
        .route("/readyz", get(handlers::health::readyz))
        .route("/healthz", get(handlers::health::healthz))
        .route("/verify", get(handlers::verify::verify))
        .route("/v1/models", get(handlers::models::list_models))
        .route(
            "/v1/notes/transcribe",
            post(handlers::notes::transcribe).layer(DefaultBodyLimit::max(limits.max_audio_bytes)),
        )
        .route(
            "/v1/notes/generate",
            post(handlers::notes::generate).layer(DefaultBodyLimit::max(limits.max_json_bytes)),
        )
        .route(
            "/v1/chat/completions",
            post(handlers::agent::chat_completions)
                .layer(DefaultBodyLimit::max(limits.max_json_bytes)),
        )
        .route(
            "/v1/image/generate",
            post(handlers::image::generate).layer(DefaultBodyLimit::max(limits.max_json_bytes)),
        )
        .route(
            // Edits carry a base64 source image, so use the explicit image-edit
            // budget rather than the small JSON budget or unrelated audio cap.
            "/v1/image/edit",
            post(handlers::image::edit).layer(DefaultBodyLimit::max(limits.max_image_edit_bytes)),
        )
        .route(
            "/v1/video/generate",
            post(handlers::video::generate).layer(DefaultBodyLimit::max(limits.max_json_bytes)),
        )
        .route(
            // Animate carries a base64 source image, so it uses the image-edit
            // body budget rather than the small JSON budget.
            "/v1/video/animate",
            post(handlers::video::animate)
                .layer(DefaultBodyLimit::max(limits.max_image_edit_bytes)),
        )
        .route(
            "/v1/video/status/{job_id}",
            get(handlers::video::status).layer(DefaultBodyLimit::max(limits.max_json_bytes)),
        )
        .route(
            "/v1/dictate",
            post(handlers::dictate::transcribe)
                .layer(DefaultBodyLimit::max(limits.max_audio_bytes)),
        )
        .route(
            "/v1/dictate/cleanup",
            post(handlers::dictate::cleanup).layer(DefaultBodyLimit::max(limits.max_json_bytes)),
        )
        .route(
            "/v1/web/search",
            post(handlers::web::search).layer(DefaultBodyLimit::max(limits.max_json_bytes)),
        )
        .route(
            "/v1/web/fetch",
            post(handlers::web::fetch).layer(DefaultBodyLimit::max(limits.max_json_bytes)),
        )
        .route(
            "/v1/issue-reports",
            // Reports carry screenshot uploads, so they get the audio-sized
            // body budget rather than the JSON one.
            post(handlers::issues::submit).layer(DefaultBodyLimit::max(limits.max_audio_bytes)),
        )
        .layer(timeout)
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::new())
        .with_state(state)
}

async fn handle_timeout_error(error: BoxError) -> axum::response::Response {
    if error.is::<tower::timeout::error::Elapsed>() {
        return envelope::timeout_response();
    }
    error::ApiError::Internal.into_response()
}
