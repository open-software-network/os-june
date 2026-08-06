use crate::error::ApiError;
use axum::{
    extract::{Multipart, multipart::MultipartError},
    http::StatusCode,
};
use std::collections::HashMap;

#[derive(Default)]
pub(crate) struct MultipartFields {
    text: HashMap<String, String>,
    audio: Option<Vec<u8>>,
    filename: Option<String>,
}

impl MultipartFields {
    pub(crate) async fn collect(
        mut multipart: Multipart,
        max_audio_bytes: usize,
    ) -> Result<Self, ApiError> {
        let mut fields = Self::default();
        while let Some(field) = multipart.next_field().await.map_err(multipart_invalid)? {
            let name = field.name().map(ToString::to_string).unwrap_or_default();
            if name == "audio" || name == "file" {
                fields.filename = field.file_name().map(ToString::to_string);
                let bytes = field.bytes().await.map_err(multipart_invalid)?;
                if bytes.len() > max_audio_bytes {
                    return Err(ApiError::PayloadTooLarge);
                }
                fields.audio = Some(bytes.to_vec());
            } else {
                let value = field.text().await.map_err(multipart_invalid)?;
                fields.text.insert(name, value);
            }
        }
        Ok(fields)
    }

    pub(crate) fn take_filename(&mut self) -> Option<String> {
        self.filename.take()
    }

    pub(crate) fn required_text(&mut self, key: &str) -> Result<String, ApiError> {
        self.optional_text(key)
            .ok_or_else(|| ApiError::bad_request(format!("{key}_required")))
    }

    pub(crate) fn optional_text(&mut self, key: &str) -> Option<String> {
        self.text
            .get(key)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    pub(crate) fn required_audio(&mut self) -> Result<Vec<u8>, ApiError> {
        self.audio
            .take()
            .filter(|bytes| !bytes.is_empty())
            .ok_or_else(|| ApiError::bad_request("audio_required"))
    }
}

// `Result::map_err` passes the extractor error by value at every call site.
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn multipart_invalid(error: MultipartError) -> ApiError {
    tracing::warn!(error = %error, "multipart parse failed");
    if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
        ApiError::PayloadTooLarge
    } else {
        ApiError::bad_request("multipart_invalid")
    }
}

#[cfg(test)]
mod tests {
    use super::MultipartFields;
    use crate::error::ApiError;
    use axum::{
        Router,
        body::{Body, to_bytes},
        extract::{DefaultBodyLimit, Multipart},
        http::{Request, StatusCode, header},
        routing::post,
    };
    use pretty_assertions::assert_eq;
    use tower::ServiceExt;

    async fn collect_multipart(multipart: Multipart) -> Result<(), ApiError> {
        MultipartFields::collect(multipart, usize::MAX)
            .await
            .map(|_| ())
    }

    #[tokio::test]
    async fn body_limit_multipart_error_maps_to_payload_too_large_envelope() {
        const BOUNDARY: &str = "june-boundary";
        let mut body = format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"clip.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .into_bytes();
        body.extend(std::iter::repeat_n(b'x', 256));
        body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());

        let app = Router::new().route(
            "/",
            post(collect_multipart).layer(DefaultBodyLimit::max(128)),
        );
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .header(
                        header::CONTENT_TYPE,
                        format!("multipart/form-data; boundary={BOUNDARY}"),
                    )
                    .body(Body::from(body))
                    .expect("request builds"),
            )
            .await
            .expect("router is infallible");

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let body = to_bytes(response.into_body(), 4096)
            .await
            .expect("response body reads");
        let body: serde_json::Value = serde_json::from_slice(&body).expect("JSON envelope");
        assert_eq!(body["message"], "payload_too_large");
        assert_eq!(body["success"], false);
    }
}
