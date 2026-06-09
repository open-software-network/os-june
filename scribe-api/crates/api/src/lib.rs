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
    extract::DefaultBodyLimit,
    http::StatusCode,
    routing::{get, post},
};
use std::time::Duration;
use tower_http::{cors::CorsLayer, timeout::TimeoutLayer, trace::TraceLayer};

pub use envelope::{
    ApiResponse, ERR_AUTHORIZATION_DENIED, ERR_BAD_REQUEST, ERR_INSUFFICIENT_CREDITS, ERR_INTERNAL,
    ERR_PAYLOAD_TOO_LARGE, ERR_UNAUTHORIZED, ERR_UNPROCESSABLE, ERR_UPSTREAM,
};
pub use error::ApiError;
pub use handlers::dictate::{
    DictateCleanupRequest, DictateCleanupResponse, DictateTranscribeResponse,
};
pub use handlers::health::HealthDto;
pub use handlers::models::ModelDto;
pub use handlers::notes::{GenerateRequest, GenerateResponse, TranscribeResponse};
pub use state::{ApiLimits, ApiState, ApiStateParams};

pub fn router(state: ApiState) -> Router {
    let limits = state.limits();
    let timeout = TimeoutLayer::with_status_code(
        StatusCode::GATEWAY_TIMEOUT,
        Duration::from_secs(limits.request_timeout_secs),
    );
    Router::new()
        .route("/livez", get(handlers::health::livez))
        .route("/readyz", get(handlers::health::readyz))
        .route("/healthz", get(handlers::health::healthz))
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
            "/v1/dictate",
            post(handlers::dictate::transcribe)
                .layer(DefaultBodyLimit::max(limits.max_audio_bytes)),
        )
        .route(
            "/v1/dictate/cleanup",
            post(handlers::dictate::cleanup).layer(DefaultBodyLimit::max(limits.max_json_bytes)),
        )
        .layer(timeout)
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::new())
        .with_state(state)
}
