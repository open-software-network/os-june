use crate::{
    charge_flow::{
        AsyncChargeParams, AuthorizeParams, authorize_or_deny, clamp_to_cap, spawn_charge,
    },
    error::ServiceError,
    pricing::PricingTable,
    prompts,
    util::ceil_seconds,
};
use scribe_domain::{
    ActionSlug, AudioDurationProbe, CleanedText, Cleaner, CleanupRequest, Credits, ModelId,
    ModelKind, OsAccountsClient, Receipt, Transcriber, Transcript, TranscriptionRequest, UserId,
};
use std::sync::Arc;

pub struct DictateServiceDeps {
    pub pricing: Arc<PricingTable>,
    pub os_accounts: Arc<dyn OsAccountsClient>,
    pub transcriber: Arc<dyn Transcriber>,
    pub cleaner: Arc<dyn Cleaner>,
    pub duration_probe: Arc<dyn AudioDurationProbe>,
    pub transcribe_hold_ttl_seconds: u64,
    pub cleanup_hold_ttl_seconds: u64,
    pub flat_estimate_credits: u64,
}

pub struct DictateService {
    pricing: Arc<PricingTable>,
    os_accounts: Arc<dyn OsAccountsClient>,
    transcriber: Arc<dyn Transcriber>,
    cleaner: Arc<dyn Cleaner>,
    duration_probe: Arc<dyn AudioDurationProbe>,
    transcribe_hold_ttl_seconds: u64,
    cleanup_hold_ttl_seconds: u64,
    flat_estimate_credits: u64,
}

impl DictateService {
    pub fn new(deps: DictateServiceDeps) -> Self {
        Self {
            pricing: deps.pricing,
            os_accounts: deps.os_accounts,
            transcriber: deps.transcriber,
            cleaner: deps.cleaner,
            duration_probe: deps.duration_probe,
            transcribe_hold_ttl_seconds: deps.transcribe_hold_ttl_seconds,
            cleanup_hold_ttl_seconds: deps.cleanup_hold_ttl_seconds,
            flat_estimate_credits: deps.flat_estimate_credits,
        }
    }

    pub async fn transcribe(
        &self,
        params: DictateTranscribeParams,
    ) -> Result<DictateTranscribeOutput, ServiceError> {
        // Probe duration and price BEFORE taking a hold — see the matching
        // comment in note_transcribe.rs: bad audio fails fast and never
        // strands a hold on the user's wallet.
        let seconds = ceil_seconds(self.duration_probe.probe(&params.audio)?)?;
        let actual = self
            .pricing
            .price_audio_seconds(&params.model_id.0, seconds)?;
        // Flat-estimate mode — see the matching comment in note_transcribe.rs.
        let estimate = Credits(self.flat_estimate_credits);
        let authorization = authorize_or_deny(AuthorizeParams {
            os_accounts: self.os_accounts.as_ref(),
            user_id: params.user_id.clone(),
            action: ActionSlug::DictateTranscribe,
            estimate,
            hold_ttl_seconds: self.transcribe_hold_ttl_seconds,
        })
        .await?;
        let transcript = self
            .transcriber
            .transcribe(TranscriptionRequest {
                audio: params.audio,
                filename: params.filename,
                title: "Dictation".to_string(),
                context: params.context,
                language: params.language,
                model: params.model_id.clone(),
            })
            .await?;
        let charge_credits = clamp_to_cap(actual, authorization.cap_credits);
        let idempotency_key = format!(
            "dictate_transcribe:{}:{}:{}",
            params.user_id.0, params.session_id, params.utterance_id
        );
        let receipt = pending_receipt();
        spawn_charge(AsyncChargeParams {
            os_accounts: self.os_accounts.clone(),
            user_id: params.user_id.clone(),
            action: ActionSlug::DictateTranscribe,
            model_id: Some(params.model_id.0.clone()),
            action_token: authorization.action_token,
            credits: charge_credits,
            idempotency_key,
        });
        Ok(DictateTranscribeOutput {
            transcript,
            receipt,
        })
    }

    pub async fn cleanup(
        &self,
        params: DictateCleanupParams,
    ) -> Result<DictateCleanupOutput, ServiceError> {
        self.pricing
            .ensure_model_kind(&params.model_id.0, ModelKind::Text)?;
        let authorization = authorize_or_deny(AuthorizeParams {
            os_accounts: self.os_accounts.as_ref(),
            user_id: params.user_id.clone(),
            action: ActionSlug::DictateCleanup,
            estimate: Credits(self.flat_estimate_credits),
            hold_ttl_seconds: self.cleanup_hold_ttl_seconds,
        })
        .await?;
        let cleaned = self
            .cleaner
            .cleanup(CleanupRequest {
                text: params.text,
                dictionary_context: params.dictionary_context,
                style: params.style,
                model: params.model_id.clone(),
                system_prompt: prompts::DICTATE_CLEANUP.to_string(),
            })
            .await?;
        let actual = self
            .pricing
            .price_token_usage(&params.model_id.0, cleaned.usage)?;
        let receipt = pending_receipt();
        spawn_charge(AsyncChargeParams {
            os_accounts: self.os_accounts.clone(),
            user_id: params.user_id.clone(),
            action: ActionSlug::DictateCleanup,
            model_id: Some(params.model_id.0.clone()),
            action_token: authorization.action_token,
            credits: clamp_to_cap(actual, authorization.cap_credits),
            idempotency_key: format!(
                "dictate_cleanup:{}:{}:{}",
                params.user_id.0, params.session_id, params.utterance_id
            ),
        });
        Ok(DictateCleanupOutput { cleaned, receipt })
    }
}

fn pending_receipt() -> Receipt {
    Receipt {
        credits_charged: Credits(0),
        idempotent_replay: false,
    }
}

#[derive(Clone, Debug)]
pub struct DictateTranscribeParams {
    pub user_id: UserId,
    pub session_id: String,
    pub utterance_id: String,
    pub audio: Vec<u8>,
    pub filename: String,
    pub context: Option<String>,
    pub language: Option<String>,
    pub model_id: ModelId,
}

#[derive(Clone, Debug)]
pub struct DictateCleanupParams {
    pub user_id: UserId,
    pub session_id: String,
    pub utterance_id: String,
    pub text: String,
    pub dictionary_context: Option<String>,
    pub style: String,
    pub model_id: ModelId,
}

#[derive(Clone, Debug)]
pub struct DictateTranscribeOutput {
    pub transcript: Transcript,
    pub receipt: Receipt,
}

#[derive(Clone, Debug)]
pub struct DictateCleanupOutput {
    pub cleaned: CleanedText,
    pub receipt: Receipt,
}
