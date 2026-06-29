use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub(crate) struct TranscriptionWireResponse {
    pub text: String,
    pub language: Option<String>,
}
