use axum::{
    Json,
    http::{HeaderValue, StatusCode, header},
    response::IntoResponse,
};
use serde::Serialize;

pub const ERR_BAD_REQUEST: i32 = 2001;
pub const ERR_UNAUTHORIZED: i32 = 3001;
pub const ERR_UNPROCESSABLE: i32 = 4201;
pub const ERR_INSUFFICIENT_CREDITS: i32 = 4301;
pub const ERR_PAYLOAD_TOO_LARGE: i32 = 4131;
pub const ERR_AUTHORIZATION_DENIED: i32 = 4401;
pub const ERR_INTERNAL: i32 = 5000;
pub const ERR_UPSTREAM: i32 = 5001;
pub const ERR_METERING: i32 = 5031;
pub const ERR_TIMEOUT: i32 = 5041;
pub(crate) const TRANSIENT_RETRY_AFTER_SECS: u64 = 2;

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

pub(crate) fn error_response_with_retry_after(
    status: StatusCode,
    code: i32,
    message: &str,
    retry_after_secs: u64,
) -> axum::response::Response {
    let mut response = error_response(status, code, message);
    if let Ok(value) = HeaderValue::from_str(&retry_after_secs.to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

pub(crate) fn timeout_response() -> axum::response::Response {
    error_response(StatusCode::GATEWAY_TIMEOUT, ERR_TIMEOUT, "timeout")
}

#[cfg(test)]
mod tests {
    use super::{TRANSIENT_RETRY_AFTER_SECS, error_response_with_retry_after, timeout_response};
    use axum::{
        body::to_bytes,
        http::{HeaderValue, StatusCode, header},
    };
    use pretty_assertions::assert_eq;

    async fn body_json(response: axum::response::Response) -> serde_json::Value {
        let bytes = to_bytes(response.into_body(), 4096)
            .await
            .expect("read body");
        serde_json::from_slice(&bytes).expect("body is JSON")
    }

    #[tokio::test]
    async fn timeout_response_uses_standard_error_envelope() {
        let response = timeout_response();

        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        let body = body_json(response).await;
        assert_eq!(body["success"], false);
        assert_eq!(body["error_code"], 5041);
        assert_eq!(body["message"], "timeout");
    }

    #[test]
    fn retry_after_response_sets_seconds_header() {
        let response = error_response_with_retry_after(
            StatusCode::TOO_MANY_REQUESTS,
            4401,
            "authorization_denied",
            TRANSIENT_RETRY_AFTER_SECS,
        );

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            response.headers().get(header::RETRY_AFTER),
            Some(&HeaderValue::from_static("2"))
        );
    }
}
