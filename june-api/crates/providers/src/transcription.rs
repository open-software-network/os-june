use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize)]
pub(crate) struct TranscriptionWireResponse {
    pub text: String,
    pub language: Option<String>,
}

pub(crate) fn audio_mime(filename: &str) -> &'static str {
    if Path::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("m4a") || extension.eq_ignore_ascii_case("mp4")
        })
    {
        "audio/mp4"
    } else {
        "audio/wav"
    }
}
