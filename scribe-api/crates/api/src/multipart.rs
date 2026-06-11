use crate::error::ApiError;
use axum::extract::Multipart;
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

pub(crate) fn multipart_invalid<E>(error: E) -> ApiError
where
    E: std::fmt::Display,
{
    tracing::warn!(error = %error, "multipart parse failed");
    ApiError::bad_request("multipart_invalid")
}
