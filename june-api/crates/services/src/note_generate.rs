use crate::{
    charge_flow::{
        AuthorizeParams, ChargeParams, authorize_or_deny, charge, clamp_to_cap, log_settled,
        zero_receipt,
    },
    error::ServiceError,
    metering::{log_skipped_user_venice_key, uses_user_venice_key_for_model},
    pricing::PricingTable,
    prompts,
};
use june_domain::{
    ActionSlug, Credits, GeneratedNote, GenerationRequest, Generator, ModelId, ModelKind,
    OsAccountsClient, ProviderCredentials, Receipt, UserId,
};
use std::sync::Arc;

pub const NOTE_GENERATE_PROMPT_VERSION: &str = "notes-mvp-v5";

pub struct NoteGenerateServiceDeps {
    pub pricing: Arc<PricingTable>,
    pub os_accounts: Arc<dyn OsAccountsClient>,
    pub generator: Arc<dyn Generator>,
    pub hold_ttl_seconds: u64,
    pub flat_estimate_credits: u64,
}

pub struct NoteGenerateService {
    pricing: Arc<PricingTable>,
    os_accounts: Arc<dyn OsAccountsClient>,
    generator: Arc<dyn Generator>,
    hold_ttl_seconds: u64,
    flat_estimate_credits: u64,
}

impl NoteGenerateService {
    pub fn new(deps: NoteGenerateServiceDeps) -> Self {
        Self {
            pricing: deps.pricing,
            os_accounts: deps.os_accounts,
            generator: deps.generator,
            hold_ttl_seconds: deps.hold_ttl_seconds,
            flat_estimate_credits: deps.flat_estimate_credits,
        }
    }

    pub async fn generate(
        &self,
        params: NoteGenerateParams,
    ) -> Result<NoteGenerateOutput, ServiceError> {
        self.pricing
            .ensure_model_kind(&params.model_id.0, ModelKind::Text)?;
        if uses_user_venice_key_for_model(
            &self.pricing,
            &params.model_id.0,
            &params.provider_credentials,
        ) {
            let generated = self
                .generator
                .generate(GenerationRequest {
                    title: params.title,
                    transcript: params.transcript,
                    transcript_source_labels: params.transcript_source_labels,
                    manual_notes: params.manual_notes,
                    language: params.language,
                    existing_generated_note: params.existing_generated_note,
                    model: params.model_id.clone(),
                    system_prompt: prompts::NOTE_GENERATE.to_string(),
                    provider_credentials: params.provider_credentials.clone(),
                })
                .await?;
            log_skipped_user_venice_key(
                ActionSlug::NoteGenerate,
                &params.user_id,
                &params.model_id.0,
            );
            return Ok(NoteGenerateOutput {
                generated,
                receipt: zero_receipt(),
                prompt_version: NOTE_GENERATE_PROMPT_VERSION.to_string(),
            });
        }
        // Flat-estimate mode — see note_transcribe.rs. The actual charge below
        // is still computed from real token usage; only the Hold size changes.
        let estimate = Credits(self.flat_estimate_credits);
        let authorization = authorize_or_deny(AuthorizeParams {
            os_accounts: self.os_accounts.as_ref(),
            user_id: params.user_id.clone(),
            action: ActionSlug::NoteGenerate,
            estimate,
            hold_ttl_seconds: self.hold_ttl_seconds,
        })
        .await?;
        let generated = self
            .generator
            .generate(GenerationRequest {
                title: params.title,
                transcript: params.transcript,
                transcript_source_labels: params.transcript_source_labels,
                manual_notes: params.manual_notes,
                language: params.language,
                existing_generated_note: params.existing_generated_note,
                model: params.model_id.clone(),
                system_prompt: prompts::NOTE_GENERATE.to_string(),
                provider_credentials: params.provider_credentials.clone(),
            })
            .await?;
        let actual = self
            .pricing
            .price_token_usage(&params.model_id.0, generated.usage)?;
        let charge_credits = clamp_to_cap(actual, authorization.cap_credits);
        let idempotency_key = format!(
            "note_generate:{}:{}:{}",
            params.user_id.0, params.note_id, NOTE_GENERATE_PROMPT_VERSION
        );
        let receipt = charge(ChargeParams {
            os_accounts: self.os_accounts.as_ref(),
            action_token: authorization.action_token,
            credits: charge_credits,
            idempotency_key,
        })
        .await?;
        log_settled(
            ActionSlug::NoteGenerate,
            &params.user_id,
            &params.model_id.0,
            &receipt,
        );
        Ok(NoteGenerateOutput {
            generated,
            receipt,
            prompt_version: NOTE_GENERATE_PROMPT_VERSION.to_string(),
        })
    }
}

#[derive(Clone, Debug)]
pub struct NoteGenerateParams {
    pub user_id: UserId,
    pub note_id: String,
    pub prompt_version: String,
    pub title: String,
    pub transcript: String,
    pub transcript_source_labels: bool,
    pub manual_notes: Option<String>,
    pub language: Option<String>,
    pub existing_generated_note: Option<String>,
    pub model_id: ModelId,
    pub provider_credentials: ProviderCredentials,
}

#[derive(Clone, Debug)]
pub struct NoteGenerateOutput {
    pub generated: GeneratedNote,
    pub receipt: Receipt,
    pub prompt_version: String,
}
