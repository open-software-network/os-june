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
    body::Body,
    error_handling::HandleErrorLayer,
    extract::{DefaultBodyLimit, Request, State},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use state::{IssueReportDeadline, IssueReportPermit, IssueReportRequestContext};
use std::{sync::Arc, time::Duration};
use tokio_stream::StreamExt;
use tower::{BoxError, ServiceBuilder, timeout::TimeoutLayer};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

pub use envelope::{
    ApiResponse, ERR_AUTHORIZATION_DENIED, ERR_BAD_REQUEST, ERR_INSUFFICIENT_CREDITS, ERR_INTERNAL,
    ERR_METERING, ERR_NOT_FOUND, ERR_PAYLOAD_TOO_LARGE, ERR_SHARING_UNAVAILABLE, ERR_TIMEOUT,
    ERR_UNAUTHORIZED, ERR_UNPROCESSABLE, ERR_UPSTREAM,
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
pub use handlers::p3a::{P3aReportRequest, P3aReportResponse};
pub use handlers::video::{
    VideoAnimateRequest, VideoGenerateRequest, VideoJobResponse, VideoStatusResponse,
};
pub use handlers::web::{WebFetchRequest, WebSearchRequest};
pub use state::{ApiLimits, ApiState, ApiStateParams, AttestationInfo, ShareViewerInfo};

/// Real shipped app version, sent by the desktop client on every request.
/// Old stable builds keep calling production long after main moves on; this
/// header is how logs and metrics tell them apart (ADR 0021).
pub const JUNE_APP_VERSION_HEADER: &str = "x-june-app-version";

// The route table: one line per endpoint, so it grows with each capability
// (private sharing is the latest). Splitting it would scatter the surface.
#[allow(clippy::too_many_lines)]
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
        .route("/robots.txt", get(handlers::share_viewer::robots))
        .route("/s/{share_id}", get(handlers::share_viewer::shell))
        .route(
            "/v1/share-viewer/token",
            post(handlers::share_viewer::token_exchange),
        )
        .route(
            "/v1/shares",
            post(handlers::share::create)
                .layer(DefaultBodyLimit::max(limits.max_share_body_bytes))
                .get(handlers::share::list),
        )
        .route(
            "/v1/shares/{share_id}",
            get(handlers::share::detail).delete(handlers::share::delete),
        )
        .route(
            "/v1/shares/{share_id}/invites",
            post(handlers::share::add_invites)
                .layer(DefaultBodyLimit::max(limits.max_share_body_bytes)),
        )
        .route(
            "/v1/shares/{share_id}/invites/{invite_id}",
            axum::routing::delete(handlers::share::revoke_invite),
        )
        .route("/v1/shares/{share_id}/view", get(handlers::share::view))
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
            // Reports can carry QA videos accepted by os-platform, so they
            // have a dedicated body budget instead of inheriting audio's
            // unrelated 25 MiB ceiling.
            post(handlers::issues::submit).layer(
                ServiceBuilder::new()
                    // ServiceBuilder's first layer is outermost: acquire the
                    // one shared permit before multipart extraction, then keep
                    // it through delivery and response-body completion.
                    .layer(middleware::from_fn_with_state(
                        state.clone(),
                        issue_report_permit_middleware,
                    ))
                    .layer(DefaultBodyLimit::max(limits.max_issue_report_bytes)),
            ),
        )
        .route(
            "/v1/p3a/reports",
            post(handlers::p3a::submit).layer(DefaultBodyLimit::max(limits.max_json_bytes)),
        )
        .layer(timeout)
        .layer(
            // The request span carries the calling app version so a deploy
            // that hurts only older shipped clients shows up in logs as a
            // per-version error spike instead of support tickets.
            TraceLayer::new_for_http().make_span_with(|request: &Request| {
                let app_version = request
                    .headers()
                    .get(JUNE_APP_VERSION_HEADER)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("");
                tracing::info_span!(
                    "request",
                    method = %request.method(),
                    uri = %request.uri(),
                    version = ?request.version(),
                    app_version,
                )
            }),
        )
        .layer(CorsLayer::new())
        .with_state(state)
}

async fn handle_timeout_error(error: BoxError) -> axum::response::Response {
    if error.is::<tower::timeout::error::Elapsed>() {
        return envelope::timeout_response();
    }
    error::ApiError::Internal.into_response()
}

async fn issue_report_permit_middleware(
    State(state): State<ApiState>,
    mut request: Request,
    next: Next,
) -> Response {
    let deadline =
        IssueReportDeadline::from_now(Duration::from_secs(state.limits().request_timeout_secs));
    let permit = match state.acquire_issue_report_permit().await {
        Ok(permit) => permit,
        Err(error) => {
            tracing::error!(%error, "issue-report concurrency semaphore closed");
            return ApiError::Internal.into_response();
        }
    };
    request.extensions_mut().insert(IssueReportRequestContext {
        permit: permit.clone(),
        deadline,
    });
    let response = next.run(request).await;
    hold_issue_report_permit_through_body(response, permit)
}

fn hold_issue_report_permit_through_body(
    response: Response,
    permit: Arc<IssueReportPermit>,
) -> Response {
    let (parts, body) = response.into_parts();
    let stream = body.into_data_stream().map(move |chunk| {
        let _keep_permit_alive = &permit;
        chunk
    });
    Response::from_parts(parts, Body::from_stream(stream))
}
