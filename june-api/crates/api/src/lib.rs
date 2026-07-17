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
    ERR_METERING, ERR_NOT_FOUND, ERR_PAYLOAD_TOO_LARGE, ERR_SERVICE_OVERLOADED,
    ERR_SHARING_UNAVAILABLE, ERR_TIMEOUT, ERR_UNAUTHORIZED, ERR_UNPROCESSABLE, ERR_UPSTREAM,
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
        .route("/v1/shares", get(handlers::share::list))
        .route(
            "/v1/shares/{share_id}",
            get(handlers::share::detail).delete(handlers::share::delete),
        )
        .route(
            "/v1/shares/{share_id}/invites/{invite_id}",
            axum::routing::delete(handlers::share::revoke_invite),
        )
        .route("/v1/shares/{share_id}/view", get(handlers::share::view))
        .route(
            "/v1/shares/{share_id}/link-view",
            get(handlers::share::link_view),
        )
        .route("/v1/models", get(handlers::models::list_models))
        .route(
            "/v1/notes/generate",
            post(handlers::notes::generate).layer(DefaultBodyLimit::max(limits.max_json_bytes)),
        )
        .route(
            "/v1/image/generate",
            post(handlers::image::generate).layer(DefaultBodyLimit::max(limits.max_json_bytes)),
        )
        .route(
            "/v1/video/generate",
            post(handlers::video::generate).layer(DefaultBodyLimit::max(limits.max_json_bytes)),
        )
        .route(
            "/v1/video/status/{job_id}",
            get(handlers::video::status).layer(DefaultBodyLimit::max(limits.max_json_bytes)),
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
        .merge(authenticated_body_routes(&state, limits))
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

/// Read-only surface for the isolated `june.link` CVM.
///
/// Keeping this router separate is a deployment boundary, not just a UI
/// convention: the short-link origin can render/decrypt shares and complete
/// legacy recipient sign-in, but it cannot create, mutate, or delete shares
/// and cannot invoke any inference or reporting endpoint.
pub fn viewer_router(state: ApiState) -> Router {
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
        .route("/v1/shares/{share_id}/view", get(handlers::share::view))
        .route(
            "/v1/shares/{share_id}/link-view",
            get(handlers::share::link_view),
        )
        .layer(timeout)
        .layer(
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

/// The large-body routes — those whose cap is well above the shared 512 KiB
/// small-JSON cap — grouped so authentication and admission control run, as the
/// outermost layer, before any of their body-limit layers buffer a request.
/// Grouping keeps both unauthenticated and authenticated resource-exhaustion
/// surfaces closed for every multi-MiB route at once (JUN-336/JUN-308 review).
fn authenticated_body_routes(state: &ApiState, limits: ApiLimits) -> Router<ApiState> {
    Router::new()
        .route(
            "/v1/shares",
            post(handlers::share::create).layer(DefaultBodyLimit::max(limits.max_share_body_bytes)),
        )
        .route(
            "/v1/shares/{share_id}/invites",
            post(handlers::share::add_invites)
                .layer(DefaultBodyLimit::max(limits.max_share_body_bytes)),
        )
        .route(
            "/v1/chat/completions",
            post(handlers::agent::chat_completions)
                .layer(DefaultBodyLimit::max(limits.max_agent_chat_bytes)),
        )
        .route(
            // Edits carry a base64 source image, so use the explicit image-edit
            // budget rather than the small JSON budget or unrelated audio cap.
            "/v1/image/edit",
            post(handlers::image::edit).layer(DefaultBodyLimit::max(limits.max_image_edit_bytes)),
        )
        .route(
            // Animate carries a base64 source image, so it uses the image-edit
            // body budget rather than the small JSON budget.
            "/v1/video/animate",
            post(handlers::video::animate)
                .layer(DefaultBodyLimit::max(limits.max_image_edit_bytes)),
        )
        .route(
            "/v1/notes/transcribe",
            post(handlers::notes::transcribe).layer(DefaultBodyLimit::max(limits.max_audio_bytes)),
        )
        .route(
            "/v1/dictate",
            post(handlers::dictate::transcribe)
                .layer(DefaultBodyLimit::max(limits.max_audio_bytes)),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            authenticate_and_admit,
        ))
}

async fn handle_timeout_error(error: BoxError) -> axum::response::Response {
    if error.is::<tower::timeout::error::Elapsed>() {
        return envelope::timeout_response();
    }
    error::ApiError::Internal.into_response()
}

/// Header-only bearer authentication and admission run BEFORE the body extractor on the
/// large-body routes (those whose cap exceeds the shared 512 KiB small-JSON
/// cap). Without it, an unauthenticated client could force June API to buffer
/// and JSON-parse a multi-MiB body — up to `max_agent_chat_bytes` (12 MiB),
/// `max_share_body_bytes` (~14 MiB), `max_image_edit_bytes` (~66 MiB), or
/// `max_audio_bytes` (25 MiB) — before the handler's own `authenticated_user`
/// check ran. The verify is a cached-JWKS signature check, so re-checking in
/// the handler is cheap; keeping the handler check makes each handler correct
/// on its own.
async fn authenticate_and_admit(
    State(state): State<ApiState>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    // Auth on headers before the body is buffered (JUN-336).
    let user_id = auth::authenticated_user(&state, request.headers()).await?;
    // Byte-weighted global + per-user admission BEFORE body extraction, so
    // concurrent authenticated large bodies cannot exhaust the shared TEE
    // (JUN-336 review). Held through body extraction + handler, released after.
    //
    // Weight by what Axum will ACTUALLY buffer — the route's body cap — not the
    // client's `Content-Length`. That header is untrusted: a missing/chunked
    // length would otherwise reserve only the 1 KiB minimum while the body still
    // buffers up to the cap, and an exaggerated length would reserve the whole
    // global budget. An honest length under the cap is charged as-is.
    let limits = state.limits();
    let route_cap = authenticated_route_body_cap(request.uri().path(), &limits);
    let declared = request
        .headers()
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let charge_bytes = if declared == 0 || declared > route_cap {
        route_cap
    } else {
        declared
    };
    let _admission = state.admit_agent_request(&user_id, charge_bytes)?;
    Ok(next.run(request).await)
}

/// The body cap Axum enforces for a large-body route — the true upper bound on
/// bytes it will buffer, used to weight admission independently of the untrusted
/// `Content-Length` (JUN-336). Unknown paths fall back to the largest cap so the
/// charge is never an underestimate.
fn authenticated_route_body_cap(path: &str, limits: &ApiLimits) -> usize {
    match path {
        "/v1/chat/completions" => limits.max_agent_chat_bytes,
        "/v1/notes/transcribe" | "/v1/dictate" => limits.max_audio_bytes,
        "/v1/shares" => limits.max_share_body_bytes,
        path if path.starts_with("/v1/shares/") && path.ends_with("/invites") => {
            limits.max_share_body_bytes
        }
        _ => limits.max_image_edit_bytes,
    }
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

#[cfg(test)]
mod tests {
    use super::authenticated_route_body_cap;
    use crate::state::ApiLimits;

    fn limits() -> ApiLimits {
        ApiLimits {
            max_audio_bytes: 25,
            max_json_bytes: 1,
            max_issue_report_bytes: 2,
            max_image_edit_bytes: 66,
            max_share_body_bytes: 14,
            max_agent_chat_bytes: 12,
            max_agent_inflight_body_bytes: 100,
            max_agent_concurrent_requests_per_user: 8,
            request_timeout_secs: 1,
        }
    }

    #[test]
    fn route_body_cap_maps_each_large_body_route_to_its_real_cap() {
        let l = limits();
        assert_eq!(authenticated_route_body_cap("/v1/chat/completions", &l), 12);
        assert_eq!(authenticated_route_body_cap("/v1/notes/transcribe", &l), 25);
        assert_eq!(authenticated_route_body_cap("/v1/dictate", &l), 25);
        assert_eq!(authenticated_route_body_cap("/v1/shares", &l), 14);
        assert_eq!(
            authenticated_route_body_cap("/v1/shares/shr_test/invites", &l),
            14
        );
        assert_eq!(authenticated_route_body_cap("/v1/image/edit", &l), 66);
        assert_eq!(authenticated_route_body_cap("/v1/video/animate", &l), 66);
        // Unknown path falls back to the largest cap (never an underestimate).
        assert_eq!(authenticated_route_body_cap("/v1/other", &l), 66);
    }
}
