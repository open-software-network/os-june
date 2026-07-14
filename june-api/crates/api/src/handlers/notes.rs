use crate::{
    audio::validate_audio,
    auth::{authenticated_user, provider_credentials},
    envelope::{self, ApiResponse},
    error::ApiError,
    multipart::MultipartFields,
    state::ApiState,
    validation,
};
use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Multipart, State},
    http::{HeaderMap, StatusCode, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
};
use june_domain::{ModelId, ModelKind, ProviderCredentials};
use june_services::{
    NoteGenerateOutput, NoteGenerateParams, NoteTranscribeOutput, NoteTranscribeParams,
    PricingError, PricingTable,
};
use serde::{Deserialize, Serialize};
use std::{convert::Infallible, time::Duration};
use tokio::{sync::mpsc, time::MissedTickBehavior};
use tokio_stream::wrappers::UnboundedReceiverStream;

pub(crate) async fn transcribe(
    State(state): State<ApiState>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Json<ApiResponse<TranscribeResponse>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let provider_credentials = provider_credentials(&headers)?;
    let limits = state.limits();
    let mut form = MultipartFields::collect(multipart, limits.max_audio_bytes).await?;
    let audio = form.required_audio()?;
    validate_audio(&audio)?;
    let requested_model_id = form.required_text("model")?;
    validation::validate_text_len("model", &requested_model_id, validation::MAX_MODEL_CHARS)?;
    let model_id = resolve_priced_asr_model(&state, &requested_model_id)?;
    let provider_credentials = credentials_for_resolved_model(
        provider_credentials,
        &requested_model_id,
        &model_id,
        state.pricing().is_venice_model(&model_id),
    )?;
    // Accepted and validated for wire compatibility, but deliberately not
    // carried into the transcription pipeline: the note title is user data
    // an ASR provider has no business seeing.
    let title = form.required_text("title")?;
    validation::validate_text_len("title", &title, validation::MAX_TITLE_CHARS)?;
    drop(title);
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
    // This client field is not an authorization decision. It only requests
    // live-preview semantics; NoteTranscribeService still probes duration,
    // enforces the preview cap, and gates ASR through OS Accounts.
    let preview = parse_preview_flag(form.optional_text("preview").as_deref());
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
            context,
            language,
            model_id: ModelId(model_id),
            preview,
            provider_credentials,
        })
        .await?;
    Ok(Json(ApiResponse::ok(TranscribeResponse::from(output))))
}

pub(crate) async fn generate(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<GenerateRequest>,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let provider_credentials = provider_credentials(&headers)?;
    request.validate()?;
    let requested_model_id = required(request.model, "model_required")?;
    validation::validate_text_len("model", &requested_model_id, validation::MAX_MODEL_CHARS)?;
    let model_id = resolve_priced_text_model(&state, &requested_model_id)?;
    if state.local_dev_enabled() && model_id != AUTO_TEXT_MODEL && model_id != requested_model_id {
        tracing::warn!(
            requested_model = %requested_model_id,
            resolved_model = %model_id,
            "local dev substituted a concrete text model for unavailable Auto"
        );
    }
    let cost_quality = if model_id == AUTO_TEXT_MODEL {
        request.cost_quality
    } else {
        None
    };
    let provider_credentials = credentials_for_resolved_model(
        provider_credentials,
        &requested_model_id,
        &model_id,
        state.pricing().is_venice_model(&model_id),
    )?;

    let stream = request.stream;
    let params = NoteGenerateParams {
        user_id,
        note_id: required(request.note_id, "note_id_required")?,
        prompt_version: required(request.prompt_version, "prompt_version_required")?,
        title: request.title,
        transcript: request.transcript,
        transcript_source_labels: request.transcript_source_labels,
        manual_notes: request.manual_notes,
        language: request.language,
        existing_generated_note: request.existing_generated_note,
        model_id: ModelId(model_id),
        provider_credentials,
        cost_quality,
    };

    if stream {
        return Ok(stream_generate(state, params));
    }

    let output = state.note_generate().generate(params).await?;
    Ok(Json(ApiResponse::ok(GenerateResponse::from(output))).into_response())
}

fn stream_generate(state: ApiState, params: NoteGenerateParams) -> Response {
    // Unbounded + non-blocking sends: a client that stops reading must not
    // suspend this loop mid-send, or the generation timeout below would stop
    // being polled and holds/upstream work could outlive request_timeout_secs.
    // Keep-alives are tiny and the terminal event is a single frame, so the
    // queue cannot grow meaningfully.
    let (tx, rx) = mpsc::unbounded_channel::<Result<Bytes, Infallible>>();
    // Full-route backstop only. `generate()` spans authorize + upstream +
    // charge settlement; a tighter bound would cancel `charge` after June
    // already paid the upstream. The hold-TTL guarantee comes from the layers
    // below: the upstream leg is cut at the metered-inference client timeout
    // (route minus the authorize + settlement budgets), which leaves the
    // settlement budget inside the hold (validate_long_inference_hold_ttl).
    let generation_backstop = Duration::from_secs(state.limits().request_timeout_secs);
    tokio::spawn(async move {
        let generation =
            tokio::time::timeout(generation_backstop, state.note_generate().generate(params));
        tokio::pin!(generation);
        let mut keep_alive = tokio::time::interval(Duration::from_secs(10));
        keep_alive.set_missed_tick_behavior(MissedTickBehavior::Skip);
        keep_alive.tick().await;

        loop {
            // Biased so a disconnect that is already visible wins over a
            // generation that became ready in the same wake: polling the
            // generation first could drive it across its charge call after
            // the client is known gone. (Once the charge request is on the
            // wire nothing here can recall it — bias narrows the race to
            // that unavoidable in-flight window.)
            tokio::select! {
                biased;
                // Cancel the moment the client is gone — not at the next
                // keep-alive tick. Generation is all-or-nothing delivery:
                // dropping the future cancels the upstream call and no charge
                // settles, the same semantics a buffered request has when the
                // connection drops (and deliberately different from agent
                // chat's drain-and-settle, where content was already
                // streamed). Waiting for a tick left a window where a
                // generation completing after the disconnect billed for a
                // result nobody received.
                () = tx.closed() => {
                    break;
                }
                result = &mut generation => {
                    let event = match result {
                        Ok(Ok(output)) => result_event(output).unwrap_or_else(|_| {
                            error_event(ApiError::Internal.response_parts(), None)
                        }),
                        Ok(Err(error)) => {
                            let error = ApiError::from(error);
                            let retry_after = error.retry_after_secs();
                            error_event(error.response_parts(), retry_after)
                        }
                        Err(_elapsed) => error_event(envelope::timeout_response_parts(), None),
                    };
                    let _ = tx.send(Ok(Bytes::from(event)));
                    break;
                }
                _ = keep_alive.tick() => {
                    // Unbounded sends never fail on backpressure; a failure
                    // means the client vanished between closed() polls.
                    // Comment line only — no blank line (same rule as the
                    // chat pump: a blank line dispatches buffered SSE fields).
                    if tx.send(Ok(Bytes::from_static(b": keep-alive\n"))).is_err() {
                        break;
                    }
                }
            }
        }
    });

    (
        StatusCode::OK,
        [(CONTENT_TYPE, "text/event-stream")],
        Body::from_stream(UnboundedReceiverStream::new(rx)),
    )
        .into_response()
}

fn result_event(output: NoteGenerateOutput) -> Result<String, serde_json::Error> {
    let body = ApiResponse::ok(GenerateResponse::from(output));
    Ok(format!(
        "event: result\ndata: {}\n\n",
        serde_json::to_string(&body)?
    ))
}

fn error_event(
    (status, body): (StatusCode, serde_json::Value),
    retry_after_secs: Option<u64>,
) -> String {
    // retry_after_secs carries the buffered path's Retry-After header — an
    // SSE body cannot set response headers, so the hint rides the payload.
    let mut data = serde_json::json!({
        "status": status.as_u16(),
        "body": body,
    });
    if let (Some(secs), Some(object)) = (retry_after_secs, data.as_object_mut()) {
        object.insert("retry_after_secs".to_string(), serde_json::json!(secs));
    }
    format!("event: error\ndata: {data}\n\n")
}

impl GenerateRequest {
    fn validate(&self) -> Result<(), ApiError> {
        if self
            .cost_quality
            .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
        {
            return Err(ApiError::unprocessable("cost_quality_invalid"));
        }
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
    #[serde(default)]
    pub transcript_source_labels: bool,
    pub manual_notes: Option<String>,
    pub language: Option<String>,
    pub existing_generated_note: Option<String>,
    pub model: Option<String>,
    pub cost_quality: Option<f64>,
    #[serde(default)]
    pub stream: bool,
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
    pub upstream_provider: Option<String>,
    pub privacy_level: Option<String>,
    pub upstream_endpoint: Option<String>,
    pub prompt_version: String,
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
            upstream_provider: output.generated.route.provider,
            privacy_level: output.generated.route.privacy_level,
            upstream_endpoint: output.generated.route.endpoint,
            prompt_version: output.prompt_version,
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

pub(crate) const AUTO_TEXT_MODEL: &str = "open-software/auto";
const DEFAULT_TEXT_MODEL: &str = "zai-org-glm-5-2";
const DEFAULT_ASR_MODEL: &str = "nvidia/parakeet-tdt-0.6b-v3";

/// Older June clients may retain a Venice model that disappeared when the
/// production catalog moved behind os-api. Preserve those sessions by routing
/// an unpriced text selection through Auto when available, or through a
/// concrete priced text model in local environments where Auto is unavailable.
/// Wrong-kind models still fail.
pub(crate) fn resolve_priced_text_model(
    state: &ApiState,
    requested_model_id: &str,
) -> Result<String, ApiError> {
    resolve_priced_text_model_kind(
        state.pricing(),
        requested_model_id,
        state.local_dev_enabled(),
    )
}

/// Auto is a June-managed route. Strip BYOK from an explicit Auto selection,
/// and reject every other non-Venice resolution instead of forwarding the key
/// across a provider boundary. Callers may preserve a legacy ASR fallback only
/// when it resolves to another Venice model.
pub(crate) fn credentials_for_resolved_model(
    mut credentials: ProviderCredentials,
    requested_model_id: &str,
    resolved_model_id: &str,
    resolved_supports_venice_byok: bool,
) -> Result<ProviderCredentials, ApiError> {
    if requested_model_id == AUTO_TEXT_MODEL {
        credentials.venice_api_key = None;
        return Ok(credentials);
    }
    if credentials.has_venice_api_key()
        && ((resolved_model_id == AUTO_TEXT_MODEL && requested_model_id != AUTO_TEXT_MODEL)
            || (resolved_model_id != AUTO_TEXT_MODEL && !resolved_supports_venice_byok))
    {
        return Err(ApiError::unprocessable("venice_api_key_model_unavailable"));
    }
    if resolved_model_id == AUTO_TEXT_MODEL {
        credentials.venice_api_key = None;
    }
    Ok(credentials)
}

fn resolve_priced_text_model_kind(
    pricing: &PricingTable,
    requested_model_id: &str,
    allow_concrete_fallback: bool,
) -> Result<String, ApiError> {
    match pricing.ensure_model_kind(requested_model_id, ModelKind::Text) {
        Ok(()) => Ok(requested_model_id.to_string()),
        Err(PricingError::NotPriced | PricingError::MissingRate) => {
            if pricing
                .ensure_model_kind(AUTO_TEXT_MODEL, ModelKind::Text)
                .is_ok()
            {
                return Ok(AUTO_TEXT_MODEL.to_string());
            }
            if !allow_concrete_fallback {
                return Err(ApiError::unprocessable("model_not_priced"));
            }
            if pricing
                .ensure_model_kind(DEFAULT_TEXT_MODEL, ModelKind::Text)
                .is_ok()
            {
                return Ok(DEFAULT_TEXT_MODEL.to_string());
            }
            pricing
                .priced_models(Some(ModelKind::Text))
                .into_iter()
                .map(|(model_id, _)| model_id)
                .find(|model_id| pricing.ensure_model_kind(model_id, ModelKind::Text).is_ok())
                .cloned()
                .ok_or_else(|| ApiError::unprocessable("model_not_priced"))
        }
        Err(PricingError::WrongUnit) => Err(ApiError::unprocessable("model_type_invalid")),
        Err(PricingError::Overflow) => Err(ApiError::unprocessable("price_overflow")),
    }
}

/// Preserve dictation for clients with a retired ASR selection. Prefer June's
/// default private transcription model, then any currently priced ASR model.
/// A text-model selection remains a hard type error.
pub(crate) fn resolve_priced_asr_model(
    state: &ApiState,
    requested_model_id: &str,
) -> Result<String, ApiError> {
    resolve_priced_asr_model_kind(state.pricing(), requested_model_id)
}

fn resolve_priced_asr_model_kind(
    pricing: &PricingTable,
    requested_model_id: &str,
) -> Result<String, ApiError> {
    match pricing.ensure_model_kind(requested_model_id, ModelKind::Asr) {
        Ok(()) => Ok(requested_model_id.to_string()),
        Err(PricingError::NotPriced | PricingError::MissingRate) => {
            if pricing
                .ensure_model_kind(DEFAULT_ASR_MODEL, ModelKind::Asr)
                .is_ok()
            {
                return Ok(DEFAULT_ASR_MODEL.to_string());
            }
            pricing
                .priced_models(Some(ModelKind::Asr))
                .into_iter()
                .map(|(model_id, _)| model_id)
                .find(|model_id| pricing.ensure_model_kind(model_id, ModelKind::Asr).is_ok())
                .cloned()
                .ok_or_else(|| ApiError::unprocessable("model_not_priced"))
        }
        Err(PricingError::WrongUnit) => Err(ApiError::unprocessable("model_type_invalid")),
        Err(PricingError::Overflow) => Err(ApiError::unprocessable("price_overflow")),
    }
}

fn parse_preview_flag(value: Option<&str>) -> bool {
    value.is_some_and(|value| matches!(value, "true" | "1"))
}

#[cfg(test)]
mod tests {
    use super::{
        AUTO_TEXT_MODEL, DEFAULT_TEXT_MODEL, credentials_for_resolved_model, parse_preview_flag,
        resolve_priced_asr_model_kind, resolve_priced_text_model_kind,
    };
    use crate::ApiError;
    use june_config::{ModelPriceConfig, ModelProvider, ModelType, PriceUnit};
    use june_domain::ProviderCredentials;
    use june_services::PricingTable;
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
            AUTO_TEXT_MODEL.to_string(),
            ModelPriceConfig {
                unit: PriceUnit::Tokens,
                credits_per_million_seconds: None,
                input_credits_per_million_tokens: Some(1),
                output_credits_per_million_tokens: Some(1),
                provider: ModelProvider::Venice,
                model_type: ModelType::Text,
                display_name: "Auto".to_string(),
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
    fn stale_text_model_falls_back_to_auto() {
        let resolved =
            resolve_priced_text_model_kind(&pricing_table(), "retired-venice-model", false)
                .expect("stale model should remain usable through Auto");
        assert_eq!(resolved, AUTO_TEXT_MODEL);
    }

    #[test]
    fn auto_falls_back_to_the_concrete_default_when_auto_is_not_priced() {
        let mut models = pricing_table()
            .iter()
            .map(|(model_id, model)| (model_id.clone(), model.clone()))
            .collect::<BTreeMap<_, _>>();
        models.remove(AUTO_TEXT_MODEL);
        let text_model = models
            .remove("text-model")
            .expect("text model should exist");
        models.insert(DEFAULT_TEXT_MODEL.to_string(), text_model);

        let resolved =
            resolve_priced_text_model_kind(&PricingTable::new(models), AUTO_TEXT_MODEL, true)
                .expect("local Auto should resolve to the built-in concrete default");

        assert_eq!(resolved, DEFAULT_TEXT_MODEL);
    }

    #[test]
    fn non_local_auto_without_auto_pricing_fails_loudly() {
        let mut models = pricing_table()
            .iter()
            .map(|(model_id, model)| (model_id.clone(), model.clone()))
            .collect::<BTreeMap<_, _>>();
        models.remove(AUTO_TEXT_MODEL);

        let error =
            resolve_priced_text_model_kind(&PricingTable::new(models), AUTO_TEXT_MODEL, false)
                .expect_err("production must not silently substitute a concrete model");

        assert!(matches!(
            error,
            ApiError::Unprocessable { message, .. } if message == "model_not_priced"
        ));
    }

    #[test]
    fn unpriced_text_falls_back_to_another_priced_text_model_without_auto_or_default() {
        let mut models = pricing_table()
            .iter()
            .map(|(model_id, model)| (model_id.clone(), model.clone()))
            .collect::<BTreeMap<_, _>>();
        models.remove(AUTO_TEXT_MODEL);

        let resolved =
            resolve_priced_text_model_kind(&PricingTable::new(models), "retired-model", true)
                .expect("a remaining priced text model should be used");

        assert_eq!(resolved, "text-model");
    }

    #[test]
    fn byok_rejects_retired_asr_fallback_to_non_venice_model() {
        let credentials = ProviderCredentials {
            venice_api_key: Some("opaque-user-key".to_string()),
        };

        let error =
            credentials_for_resolved_model(credentials, "retired-venice-asr", "openai-asr", false)
                .expect_err("provider-changing BYOK fallback should fail");

        assert!(matches!(
            error,
            ApiError::Unprocessable { message, .. }
                if message == "venice_api_key_model_unavailable"
        ));
    }

    #[test]
    fn byok_rejects_current_non_venice_model() {
        let credentials = ProviderCredentials {
            venice_api_key: Some("opaque-user-key".to_string()),
        };

        let error = credentials_for_resolved_model(
            credentials,
            "openai/current-model",
            "openai/current-model",
            false,
        )
        .expect_err("Venice BYOK must not cross into a non-Venice provider");

        assert!(matches!(
            error,
            ApiError::Unprocessable { message, .. }
                if message == "venice_api_key_model_unavailable"
        ));
    }

    #[test]
    fn explicit_auto_strips_byok() {
        let credentials = ProviderCredentials {
            venice_api_key: Some("opaque-user-key".to_string()),
        };

        let credentials =
            credentials_for_resolved_model(credentials, AUTO_TEXT_MODEL, AUTO_TEXT_MODEL, false)
                .expect("explicit Auto remains a June-managed request");

        assert!(!credentials.has_venice_api_key());
    }

    #[test]
    fn explicit_auto_strips_byok_after_resolving_to_a_concrete_model() {
        let credentials = ProviderCredentials {
            venice_api_key: Some("opaque-user-key".to_string()),
        };

        let credentials =
            credentials_for_resolved_model(credentials, AUTO_TEXT_MODEL, DEFAULT_TEXT_MODEL, true)
                .expect("explicit Auto remains June-managed after a local fallback");

        assert!(!credentials.has_venice_api_key());
    }

    #[test]
    fn stale_text_byok_rejects_fallback_to_auto() {
        let credentials = ProviderCredentials {
            venice_api_key: Some("opaque-user-key".to_string()),
        };

        let error = credentials_for_resolved_model(
            credentials,
            "venice/retired-model",
            AUTO_TEXT_MODEL,
            true,
        )
        .expect_err("stale Venice BYOK must not silently switch to Auto billing");

        assert!(matches!(
            error,
            ApiError::Unprocessable { message, .. }
                if message == "venice_api_key_model_unavailable"
        ));
    }

    #[test]
    fn priced_text_model_is_preserved() {
        let resolved = resolve_priced_text_model_kind(&pricing_table(), "text-model", false)
            .expect("priced text model should remain explicit");
        assert_eq!(resolved, "text-model");
    }

    #[test]
    fn stale_asr_model_falls_back_to_a_priced_asr_model() {
        let resolved = resolve_priced_asr_model_kind(&pricing_table(), "retired-asr-model")
            .expect("stale ASR model should remain usable");
        assert_eq!(resolved, "asr-model");
    }

    #[test]
    fn priced_asr_model_is_preserved() {
        let resolved = resolve_priced_asr_model_kind(&pricing_table(), "asr-model")
            .expect("priced ASR model should remain explicit");
        assert_eq!(resolved, "asr-model");
    }

    #[test]
    fn text_model_cannot_fall_back_into_asr() {
        let error = resolve_priced_asr_model_kind(&pricing_table(), "text-model")
            .expect_err("text model must not be accepted for transcription");
        assert!(matches!(
            error,
            ApiError::Unprocessable { message, .. } if message == "model_type_invalid"
        ));
    }

    #[test]
    fn parse_preview_flag_accepts_only_wire_true_values() {
        assert!(parse_preview_flag(Some("true")));
        assert!(parse_preview_flag(Some("1")));
        assert!(!parse_preview_flag(None));
        assert!(!parse_preview_flag(Some("false")));
        assert!(!parse_preview_flag(Some("yes")));
    }
}
