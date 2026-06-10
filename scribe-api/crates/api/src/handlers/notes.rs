use crate::{
    audio::validate_audio, auth::authenticated_user, envelope::ApiResponse, error::ApiError,
    multipart::MultipartFields, state::ApiState, validation,
};
use axum::{
    Json,
    extract::{Multipart, State},
    http::HeaderMap,
};
use scribe_domain::{ModelId, ModelKind};
use scribe_services::{
    NoteGenerateOutput, NoteGenerateParams, NoteTranscribeOutput, NoteTranscribeParams,
    PricingError, PricingTable,
};
use serde::{Deserialize, Serialize};

pub(crate) async fn transcribe(
    State(state): State<ApiState>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Json<ApiResponse<TranscribeResponse>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let limits = state.limits();
    let mut form = MultipartFields::collect(multipart, limits.max_audio_bytes).await?;
    let audio = form.required_audio()?;
    validate_audio(&audio)?;
    let model_id = form.required_text("model")?;
    validation::validate_text_len("model", &model_id, validation::MAX_MODEL_CHARS)?;
    require_priced_model(&state, &model_id, ModelKind::Asr)?;
    let title = form.required_text("title")?;
    validation::validate_text_len("title", &title, validation::MAX_TITLE_CHARS)?;
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
    let note_id = form.required_text("noteId")?;
    validation::validate_text_len("note_id", &note_id, validation::MAX_ID_CHARS)?;
    let filename = form
        .take_filename()
        .unwrap_or_else(|| "recording.wav".to_string());
    let output = state
        .note_transcribe()
        .transcribe(NoteTranscribeParams {
            user_id,
            note_id,
            audio,
            filename,
            title,
            context,
            language,
            model_id: ModelId(model_id),
        })
        .await?;
    Ok(Json(ApiResponse::ok(TranscribeResponse::from(output))))
}

pub(crate) async fn generate(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<GenerateRequest>,
) -> Result<Json<ApiResponse<GenerateResponse>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    request.validate()?;
    let model_id = required(request.model, "model_required")?;
    validation::validate_text_len("model", &model_id, validation::MAX_MODEL_CHARS)?;
    require_priced_model(&state, &model_id, ModelKind::Text)?;
    let output = state
        .note_generate()
        .generate(NoteGenerateParams {
            user_id,
            note_id: required(request.note_id, "note_id_required")?,
            prompt_version: required(request.prompt_version, "prompt_version_required")?,
            title: request.title,
            transcript: request.transcript,
            manual_notes: request.manual_notes,
            language: request.language,
            existing_generated_note: request.existing_generated_note,
            model_id: ModelId(model_id),
        })
        .await?;
    Ok(Json(ApiResponse::ok(GenerateResponse::from(output))))
}

impl GenerateRequest {
    fn validate(&self) -> Result<(), ApiError> {
        validation::validate_optional_text_len(
            "note_id",
            self.note_id.as_deref(),
            validation::MAX_ID_CHARS,
        )?;
        validation::validate_optional_text_len(
            "prompt_version",
            self.prompt_version.as_deref(),
            validation::MAX_ID_CHARS,
        )?;
        validation::validate_text_len("title", &self.title, validation::MAX_TITLE_CHARS)?;
        validation::validate_text_len(
            "transcript",
            &self.transcript,
            validation::MAX_NOTE_TRANSCRIPT_CHARS,
        )?;
        validation::validate_optional_text_len(
            "manual_notes",
            self.manual_notes.as_deref(),
            validation::MAX_NOTE_MANUAL_NOTES_CHARS,
        )?;
        validation::validate_optional_text_len(
            "language",
            self.language.as_deref(),
            validation::MAX_LANGUAGE_CHARS,
        )?;
        validation::validate_optional_text_len(
            "existing_generated_note",
            self.existing_generated_note.as_deref(),
            validation::MAX_EXISTING_NOTE_CHARS,
        )?;
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    pub note_id: Option<String>,
    pub prompt_version: Option<String>,
    pub title: String,
    pub transcript: String,
    pub manual_notes: Option<String>,
    pub language: Option<String>,
    pub existing_generated_note: Option<String>,
    pub model: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeResponse {
    pub text: String,
    pub language: Option<String>,
    pub provider: String,
    pub credits_charged: u64,
    pub idempotent_replay: bool,
}

impl From<NoteTranscribeOutput> for TranscribeResponse {
    fn from(output: NoteTranscribeOutput) -> Self {
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
pub struct GenerateResponse {
    pub content: String,
    pub title_suggestion: Option<String>,
    pub provider: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub credits_charged: u64,
    pub idempotent_replay: bool,
}

impl From<NoteGenerateOutput> for GenerateResponse {
    fn from(output: NoteGenerateOutput) -> Self {
        Self {
            content: output.generated.content,
            title_suggestion: output.generated.title_suggestion,
            provider: output.generated.provider,
            prompt_tokens: output.generated.usage.prompt_tokens,
            completion_tokens: output.generated.usage.completion_tokens,
            credits_charged: output.receipt.credits_charged.0,
            idempotent_replay: output.receipt.idempotent_replay,
        }
    }
}

pub(crate) fn required(value: Option<String>, message: &str) -> Result<String, ApiError> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request(message))
}

pub(crate) fn require_priced_model(
    state: &ApiState,
    model_id: &str,
    kind: ModelKind,
) -> Result<(), ApiError> {
    require_priced_model_kind(state.pricing(), model_id, kind)
}

fn require_priced_model_kind(
    pricing: &PricingTable,
    model_id: &str,
    kind: ModelKind,
) -> Result<(), ApiError> {
    match pricing.ensure_model_kind(model_id, kind) {
        Ok(()) => Ok(()),
        Err(PricingError::WrongUnit) => Err(ApiError::unprocessable("model_type_invalid")),
        Err(PricingError::NotPriced | PricingError::MissingRate) => {
            Err(ApiError::unprocessable("model_not_priced"))
        }
        Err(PricingError::Overflow) => Err(ApiError::unprocessable("price_overflow")),
    }
}

#[cfg(test)]
mod tests {
    use super::require_priced_model_kind;
    use crate::ApiError;
    use scribe_config::{ModelPriceConfig, ModelProvider, ModelType, PriceUnit};
    use scribe_domain::ModelKind;
    use scribe_services::PricingTable;
    use std::collections::BTreeMap;

    fn pricing_table() -> PricingTable {
        let mut models = BTreeMap::new();
        models.insert(
            "asr-model".to_string(),
            ModelPriceConfig {
                unit: PriceUnit::Seconds,
                credits_per_million_seconds: Some(1),
                input_credits_per_million_tokens: None,
                output_credits_per_million_tokens: None,
                provider: ModelProvider::Openai,
                model_type: ModelType::Asr,
                display_name: "ASR".to_string(),
                description: None,
                privacy: None,
                pricing: None,
                context_tokens: None,
                traits: Vec::new(),
                capabilities: Vec::new(),
            },
        );
        models.insert(
            "text-model".to_string(),
            ModelPriceConfig {
                unit: PriceUnit::Tokens,
                credits_per_million_seconds: None,
                input_credits_per_million_tokens: Some(1),
                output_credits_per_million_tokens: Some(1),
                provider: ModelProvider::Venice,
                model_type: ModelType::Text,
                display_name: "Text".to_string(),
                description: None,
                privacy: None,
                pricing: None,
                context_tokens: None,
                traits: Vec::new(),
                capabilities: Vec::new(),
            },
        );
        PricingTable::new(models)
    }

    #[test]
    fn require_priced_model_kind_accepts_matching_model_type() {
        let pricing = pricing_table();

        assert!(require_priced_model_kind(&pricing, "asr-model", ModelKind::Asr).is_ok());
        assert!(require_priced_model_kind(&pricing, "text-model", ModelKind::Text).is_ok());
    }

    #[test]
    fn require_priced_model_kind_rejects_wrong_endpoint_model_type() {
        let pricing = pricing_table();

        let error = require_priced_model_kind(&pricing, "asr-model", ModelKind::Text)
            .expect_err("ASR model must not be accepted for text generation");

        assert!(matches!(
            error,
            ApiError::Unprocessable { message, .. } if message == "model_type_invalid"
        ));
    }

    #[test]
    fn require_priced_model_kind_keeps_missing_model_error() {
        let pricing = pricing_table();

        let error = require_priced_model_kind(&pricing, "missing", ModelKind::Text)
            .expect_err("missing model should be rejected");

        assert!(matches!(
            error,
            ApiError::Unprocessable { message, .. } if message == "model_not_priced"
        ));
    }
}
