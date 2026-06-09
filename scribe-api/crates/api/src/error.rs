use crate::envelope::{
    ERR_AUTHORIZATION_DENIED, ERR_BAD_REQUEST, ERR_INSUFFICIENT_CREDITS, ERR_INTERNAL,
    ERR_PAYLOAD_TOO_LARGE, ERR_UNAUTHORIZED, ERR_UNPROCESSABLE, ERR_UPSTREAM, error_response,
};
use axum::{http::StatusCode, response::IntoResponse};
use scribe_domain::AuthError;
use scribe_services::ServiceError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("bad_request")]
    BadRequest { code: i32, message: String },
    #[error("unauthorized")]
    Unauthorized { code: i32, message: String },
    #[error("payload_too_large")]
    PayloadTooLarge,
    #[error("unprocessable")]
    Unprocessable { code: i32, message: String },
    #[error("insufficient_credits")]
    InsufficientCredits,
    #[error("authorization_denied")]
    AuthorizationDenied,
    #[error("upstream_provider_failed")]
    Upstream,
    #[error("internal_error")]
    Internal,
}

impl ApiError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::BadRequest {
            code: ERR_BAD_REQUEST,
            message: message.into(),
        }
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::Unauthorized {
            code: ERR_UNAUTHORIZED,
            message: message.into(),
        }
    }

    pub fn unprocessable(message: impl Into<String>) -> Self {
        Self::Unprocessable {
            code: ERR_UNPROCESSABLE,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        match self {
            Self::BadRequest { code, message } => {
                error_response(StatusCode::BAD_REQUEST, code, &message)
            }
            Self::Unauthorized { code, message } => {
                error_response(StatusCode::UNAUTHORIZED, code, &message)
            }
            Self::PayloadTooLarge => error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                ERR_PAYLOAD_TOO_LARGE,
                "payload_too_large",
            ),
            Self::Unprocessable { code, message } => {
                error_response(StatusCode::UNPROCESSABLE_ENTITY, code, &message)
            }
            Self::InsufficientCredits => error_response(
                StatusCode::PAYMENT_REQUIRED,
                ERR_INSUFFICIENT_CREDITS,
                "insufficient_credits",
            ),
            // Transient metering denial (e.g. a concurrency cap): the user is
            // funded and the upstream providers are fine — tell the client to
            // retry shortly instead of pretending the provider failed.
            Self::AuthorizationDenied => error_response(
                StatusCode::TOO_MANY_REQUESTS,
                ERR_AUTHORIZATION_DENIED,
                "authorization_denied",
            ),
            Self::Upstream => error_response(
                StatusCode::BAD_GATEWAY,
                ERR_UPSTREAM,
                "upstream_provider_failed",
            ),
            Self::Internal => error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                ERR_INTERNAL,
                "internal_error",
            ),
        }
    }
}

impl From<ServiceError> for ApiError {
    fn from(error: ServiceError) -> Self {
        match error {
            ServiceError::ModelNotPriced => Self::unprocessable("model_not_priced"),
            ServiceError::PriceOverflow => Self::unprocessable("price_overflow"),
            ServiceError::InsufficientCredits => Self::InsufficientCredits,
            ServiceError::AuthorizationDenied => Self::AuthorizationDenied,
            ServiceError::UpstreamProvider => Self::Upstream,
            ServiceError::InvalidInput { reason } => Self::bad_request(reason),
        }
    }
}

pub(crate) fn from_auth_error(error: &AuthError) -> ApiError {
    match error {
        AuthError::MissingToken | AuthError::InvalidToken => {
            ApiError::unauthorized("invalid_access_token")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ApiError;
    use axum::{http::StatusCode, response::IntoResponse};
    use pretty_assertions::assert_eq;
    use scribe_services::ServiceError;

    async fn body_json(response: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("read body");
        serde_json::from_slice(&bytes).expect("body is JSON")
    }

    #[tokio::test]
    async fn authorization_denied_maps_to_429_with_structured_code() {
        // Regression: a transient metering denial (e.g. concurrency cap) used
        // to surface as 502 upstream_provider_failed — the client told users
        // the provider couldn't process their audio when a short retry would
        // have succeeded.
        let response = ApiError::from(ServiceError::AuthorizationDenied).into_response();

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        let body = body_json(response).await;
        assert_eq!(body["error_code"], 4401);
        assert_eq!(body["message"], "authorization_denied");
        assert_eq!(body["success"], false);
    }

    #[tokio::test]
    async fn upstream_failure_keeps_its_existing_code_and_message() {
        // The desktop client string-matches "upstream_provider_failed"; the
        // shape of genuine provider failures must not change.
        let response = ApiError::from(ServiceError::UpstreamProvider).into_response();

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = body_json(response).await;
        assert_eq!(body["error_code"], 5001);
        assert_eq!(body["message"], "upstream_provider_failed");
    }
}
