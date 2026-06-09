use crate::{
    charge_flow::{
        AuthorizeParams, ChargeParams, authorize_or_deny, charge, clamp_to_cap, log_settled,
    },
    error::ServiceError,
    pricing::PricingTable,
    util::ceil_seconds,
};
use scribe_domain::{
    ActionSlug, AudioDurationProbe, Credits, ModelId, OsAccountsClient, Receipt, Transcriber,
    Transcript, TranscriptionRequest, UserId,
};
use std::sync::Arc;

pub struct NoteTranscribeServiceDeps {
    pub pricing: Arc<PricingTable>,
    pub os_accounts: Arc<dyn OsAccountsClient>,
    pub transcriber: Arc<dyn Transcriber>,
    pub duration_probe: Arc<dyn AudioDurationProbe>,
    pub hold_ttl_seconds: u64,
    pub flat_estimate_credits: u64,
}

pub struct NoteTranscribeService {
    pricing: Arc<PricingTable>,
    os_accounts: Arc<dyn OsAccountsClient>,
    transcriber: Arc<dyn Transcriber>,
    duration_probe: Arc<dyn AudioDurationProbe>,
    hold_ttl_seconds: u64,
    flat_estimate_credits: u64,
}

impl NoteTranscribeService {
    pub fn new(deps: NoteTranscribeServiceDeps) -> Self {
        Self {
            pricing: deps.pricing,
            os_accounts: deps.os_accounts,
            transcriber: deps.transcriber,
            duration_probe: deps.duration_probe,
            hold_ttl_seconds: deps.hold_ttl_seconds,
            flat_estimate_credits: deps.flat_estimate_credits,
        }
    }

    pub async fn transcribe(
        &self,
        params: NoteTranscribeParams,
    ) -> Result<NoteTranscribeOutput, ServiceError> {
        tracing::info!(
            user_id = %params.user_id.0,
            note_id = %params.note_id,
            model = %params.model_id.0,
            audio_bytes = params.audio.len(),
            filename = %params.filename,
            "note_transcribe: handler entered"
        );
        // Probe duration and price BEFORE taking a hold: corrupt or
        // unpriceable audio fails fast as invalid input without an OS
        // Accounts round-trip and without stranding a hold on the user's
        // wallet until its TTL expires. (Retried bad uploads used to pile up
        // holds and could trip spurious balance/concurrency denials.)
        let seconds = ceil_seconds(self.duration_probe.probe(&params.audio)?)?;
        let actual = self
            .pricing
            .price_audio_seconds(&params.model_id.0, seconds)?;
        // Flat-estimate mode: skip per-request estimation for the upfront
        // authorize. The Hold is bigger than necessary; the actual charge
        // below is what the user pays.
        let estimate = Credits(self.flat_estimate_credits);
        tracing::info!(
            note_id = %params.note_id,
            estimate_credits = estimate.0,
            "note_transcribe: flat estimate"
        );
        let authorization = authorize_or_deny(AuthorizeParams {
            os_accounts: self.os_accounts.as_ref(),
            user_id: params.user_id.clone(),
            action: ActionSlug::NoteTranscribe,
            estimate,
            hold_ttl_seconds: self.hold_ttl_seconds,
        })
        .await?;
        tracing::info!(
            note_id = %params.note_id,
            model = %params.model_id.0,
            "note_transcribe: calling transcriber"
        );
        let transcript = self
            .transcriber
            .transcribe(TranscriptionRequest {
                audio: params.audio,
                filename: params.filename,
                title: params.title,
                context: params.context,
                language: params.language,
                model: params.model_id.clone(),
            })
            .await?;
        tracing::info!(
            note_id = %params.note_id,
            text_len = transcript.text.len(),
            seconds,
            actual_credits = actual.0,
            "note_transcribe: transcriber returned"
        );
        let charge_credits = clamp_to_cap(actual, authorization.cap_credits);
        let idempotency_key = format!("note_transcribe:{}:{}", params.user_id.0, params.note_id);
        let receipt = charge(ChargeParams {
            os_accounts: self.os_accounts.as_ref(),
            action_token: authorization.action_token,
            credits: charge_credits,
            idempotency_key,
        })
        .await?;
        log_settled(
            ActionSlug::NoteTranscribe,
            &params.user_id,
            &params.model_id.0,
            &receipt,
        );
        Ok(NoteTranscribeOutput {
            transcript,
            receipt,
        })
    }
}

#[derive(Clone, Debug)]
pub struct NoteTranscribeParams {
    pub user_id: UserId,
    pub note_id: String,
    pub audio: Vec<u8>,
    pub filename: String,
    pub title: String,
    pub context: Option<String>,
    pub language: Option<String>,
    pub model_id: ModelId,
}

#[derive(Clone, Debug)]
pub struct NoteTranscribeOutput {
    pub transcript: Transcript,
    pub receipt: Receipt,
}
