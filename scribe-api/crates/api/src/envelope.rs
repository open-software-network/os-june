use axum::{Json, http::StatusCode, response::IntoResponse};
use serde::Serialize;

pub const ERR_BAD_REQUEST: i32 = 2001;
pub const ERR_UNAUTHORIZED: i32 = 3001;
pub const ERR_UNPROCESSABLE: i32 = 4201;
pub const ERR_INSUFFICIENT_CREDITS: i32 = 4301;
pub const ERR_PAYLOAD_TOO_LARGE: i32 = 4131;
pub const ERR_AUTHORIZATION_DENIED: i32 = 4401;
pub const ERR_INTERNAL: i32 = 5000;
pub const ERR_UPSTREAM: i32 = 5001;

#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub data: Option<T>,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl<T> ApiResponse<T> {
    pub fn ok(data: T) -> Self {
        Self {
            data: Some(data),
            success: true,
            error_code: None,
            message: None,
        }
    }
}

impl ApiResponse<()> {
    pub fn err(code: i32, message: impl Into<String>) -> Self {
        Self {
            data: None,
            success: false,
            error_code: Some(code),
            message: Some(message.into()),
        }
    }
}

pub(crate) fn error_response(
    status: StatusCode,
    code: i32,
    message: &str,
) -> axum::response::Response {
    (status, Json(ApiResponse::err(code, message))).into_response()
}
