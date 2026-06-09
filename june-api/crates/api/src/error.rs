use crate::envelope::{
    ERR_BAD_REQUEST, ERR_INSUFFICIENT_CREDITS, ERR_INTERNAL, ERR_PAYLOAD_TOO_LARGE,
    ERR_UNAUTHORIZED, ERR_UNPROCESSABLE, ERR_UPSTREAM, error_response,
};
use axum::{http::StatusCode, response::IntoResponse};
use june_domain::AuthError;
use june_services::ServiceError;
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
            ServiceError::AuthorizationDenied | ServiceError::UpstreamProvider => Self::Upstream,
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
