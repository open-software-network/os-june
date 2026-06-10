use crate::{
    audio::validate_audio,
    auth::authenticated_user,
    envelope::ApiResponse,
    error::ApiError,
    handlers::notes::{require_priced_model, required},
    multipart::MultipartFields,
    state::ApiState,
    validation,
};
use axum::{
    Json,
    extract::{Multipart, State},
    http::HeaderMap,
};
use scribe_domain::{ModelId, ModelKind};
use scribe_services::{
    DictateCleanupOutput, DictateCleanupParams, DictateTranscribeOutput, DictateTranscribeParams,
};
use serde::{Deserialize, Serialize};

pub(crate) async fn transcribe(
    State(state): State<ApiState>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Json<ApiResponse<DictateTranscribeResponse>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let limits = state.limits();
    let mut form = MultipartFields::collect(multipart, limits.max_audio_bytes).await?;
    let audio = form.required_audio()?;
    validate_audio(&audio)?;
    let model_id = form.required_text("model")?;
    validation::validate_text_len("model", &model_id, validation::MAX_MODEL_CHARS)?;
    require_priced_model(&state, &model_id, ModelKind::Asr)?;
    let session_id = form.required_text("sessionId")?;
    validation::validate_text_len("session_id", &session_id, validation::MAX_ID_CHARS)?;
    let utterance_id = form.required_text("utteranceId")?;
    validation::validate_text_len("utterance_id", &utterance_id, validation::MAX_ID_CHARS)?;
    let context = form.optional_text("context");
    validation::validate_optional_text_len(
        "context",
        context.as_deref(),
        validation::MAX_TRANSCRIPTION_CONTEXT_CHARS,
    )?;
    let language = form.optional_text("language");
    validation::validate_optional_text_len(
        "language",
        language.as_deref(),
        validation::MAX_LANGUAGE_CHARS,
    )?;
    let filename = form
        .take_filename()
        .unwrap_or_else(|| "dictation.wav".to_string());
    let output = state
        .dictate()
        .transcribe(DictateTranscribeParams {
            user_id,
            session_id,
            utterance_id,
            audio,
            filename,
            context,
            language,
            model_id: ModelId(model_id),
        })
        .await?;
    Ok(Json(ApiResponse::ok(DictateTranscribeResponse::from(
        output,
    ))))
}

pub(crate) async fn cleanup(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<DictateCleanupRequest>,
) -> Result<Json<ApiResponse<DictateCleanupResponse>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    request.validate()?;
    let model_id = required(request.model, "model_required")?;
    validation::validate_text_len("model", &model_id, validation::MAX_MODEL_CHARS)?;
    require_priced_model(&state, &model_id, ModelKind::Text)?;
    let output = state
        .dictate()
        .cleanup(DictateCleanupParams {
            user_id,
            session_id: required(request.session_id, "session_id_required")?,
            utterance_id: required(request.utterance_id, "utterance_id_required")?,
            text: request.text,
            dictionary_context: request.dictionary_context,
            style: request.style,
            model_id: ModelId(model_id),
        })
        .await?;
    Ok(Json(ApiResponse::ok(DictateCleanupResponse::from(output))))
}

impl DictateCleanupRequest {
    fn validate(&self) -> Result<(), ApiError> {
        validation::validate_optional_text_len(
            "session_id",
            self.session_id.as_deref(),
            validation::MAX_ID_CHARS,
        )?;
        validation::validate_optional_text_len(
            "utterance_id",
            self.utterance_id.as_deref(),
            validation::MAX_ID_CHARS,
        )?;
        validation::validate_text_len("text", &self.text, validation::MAX_DICTATION_TEXT_CHARS)?;
        validation::validate_optional_text_len(
            "dictionary_context",
            self.dictionary_context.as_deref(),
            validation::MAX_TRANSCRIPTION_CONTEXT_CHARS,
        )?;
        validation::validate_text_len("style", &self.style, validation::MAX_DICTATION_STYLE_CHARS)?;
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictateCleanupRequest {
    pub session_id: Option<String>,
    pub utterance_id: Option<String>,
    pub text: String,
    pub dictionary_context: Option<String>,
    pub style: String,
    pub model: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictateTranscribeResponse {
    pub text: String,
    pub language: Option<String>,
    pub provider: String,
    pub credits_charged: u64,
    pub idempotent_replay: bool,
}

impl From<DictateTranscribeOutput> for DictateTranscribeResponse {
    fn from(output: DictateTranscribeOutput) -> Self {
        Self {
            text: output.transcript.text,
            language: output.transcript.language,
            provider: output.transcript.provider,
            credits_charged: output.receipt.credits_charged.0,
            idempotent_replay: output.receipt.idempotent_replay,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictateCleanupResponse {
    pub text: String,
    pub provider: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub credits_charged: u64,
    pub idempotent_replay: bool,
}

impl From<DictateCleanupOutput> for DictateCleanupResponse {
    fn from(output: DictateCleanupOutput) -> Self {
        Self {
            text: output.cleaned.text,
            provider: output.cleaned.provider,
            prompt_tokens: output.cleaned.usage.prompt_tokens,
            completion_tokens: output.cleaned.usage.completion_tokens,
            credits_charged: output.receipt.credits_charged.0,
            idempotent_replay: output.receipt.idempotent_replay,
        }
    }
}
