#![cfg_attr(test, allow(clippy::expect_used, clippy::unwrap_used, clippy::panic))]

mod agent_chat;
mod charge_flow;
mod dictate;
mod error;
mod image;
mod issue_reports;
mod language;
mod metering;
mod note_generate;
mod note_transcribe;
mod p3a;
mod pricing;
mod prompts;
mod util;
mod video;
mod web_augment;

pub use agent_chat::{
    AgentChatOutput, AgentChatParams, AgentChatService, AgentChatServiceDeps, AgentChatStreamOutput,
};
pub use dictate::{
    DictateCleanupOutput, DictateCleanupParams, DictateService, DictateServiceDeps,
    DictateTranscribeOutput, DictateTranscribeParams,
};
pub use error::ServiceError;
pub use image::{
    ImageEditParams, ImageGenerateOutput, ImageGenerateParams, ImageModelPrice, ImageService,
    ImageServiceDeps,
};
pub use issue_reports::{IssueReportService, IssueReportServiceDeps};
pub use note_generate::{
    NOTE_GENERATE_PROMPT_VERSION, NoteGenerateOutput, NoteGenerateParams, NoteGenerateService,
    NoteGenerateServiceDeps,
};
pub use note_transcribe::{
    NoteTranscribeOutput, NoteTranscribeParams, NoteTranscribeService, NoteTranscribeServiceDeps,
};
pub use p3a::{P3aReportParams, P3aReportService, P3aReportServiceDeps};
pub use pricing::{PricingError, PricingTable};
pub use video::{
    JobId, VideoAnimateParams, VideoGenerateParams, VideoJobHandle, VideoModelPrice, VideoService,
    VideoServiceDeps, VideoStatusOutput,
};
pub use web_augment::{
    WebAugmentService, WebAugmentServiceDeps, WebFetchOutput, WebFetchParams, WebSearchOutput,
    WebSearchParams,
};

#[cfg(test)]
mod tests {
    use super::{
        AgentChatParams, AgentChatService, AgentChatServiceDeps, DictateCleanupParams,
        DictateService, DictateServiceDeps, DictateTranscribeParams, NOTE_GENERATE_PROMPT_VERSION,
        NoteGenerateParams, NoteGenerateService, NoteGenerateServiceDeps, NoteTranscribeParams,
        NoteTranscribeService, NoteTranscribeServiceDeps, PricingTable, ServiceError,
    };
    use async_trait::async_trait;
    use june_config::{ModelPriceConfig, ModelProvider, ModelType, PriceUnit};
    use june_domain::{
        AgentChatCompleter, AgentChatCompletion, AgentChatRequest, AgentChatStream,
        AgentChatStreamOutcome, AudioDurationProbe, Authorization, AuthorizeRequest, ChargeRequest,
        CleanedText, Cleaner, CleanupRequest, Credits, DomainError, GeneratedNote,
        GenerationRequest, Generator, ModelId, OsAccountsClient, ProviderCredentials, Receipt,
        TokenUsage, Transcriber, Transcript, TranscriptionRequest, UpstreamRouteMetadata, UserId,
    };
    use pretty_assertions::assert_eq;
    use std::{
        collections::BTreeMap,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::{Duration, Instant},
    };

    #[derive(Clone, Debug, Eq, PartialEq)]
    enum RecordedCall {
        Authorize {
            user_id: String,
            action: String,
            estimate: u64,
            hold_ttl: u64,
        },
        Charge {
            action_token: String,
            credits: u64,
            idempotency_key: String,
        },
    }

    #[tokio::test]
    async fn note_generate_authorizes_then_charges_actual_clamped_to_cap() {
        let os_accounts = Arc::new(RecordingOsAccounts::with_cap(Some(40)));
        let service = NoteGenerateService::new(NoteGenerateServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "text-model",
                PriceUnit::Tokens,
                2,
                ModelType::Text,
            )]))),
            os_accounts: os_accounts.clone(),
            generator: Arc::new(FixedGenerator),
            hold_ttl_seconds: 300,
            flat_estimate_credits: 8200,
        });

        let output = service
            .generate(NoteGenerateParams {
                user_id: UserId("usr_123".to_string()),
                note_id: "note_1".to_string(),
                prompt_version: "v7".to_string(),
                title: "Title".to_string(),
                transcript: "Transcript".to_string(),
                transcript_source_labels: false,
                manual_notes: None,
                language: None,
                existing_generated_note: None,
                model_id: ModelId("text-model".to_string()),
                provider_credentials: ProviderCredentials::default(),
                cost_quality: None,
            })
            .await
            .expect("generate succeeds with happy path");

        // Cap clamps the actual 60 down to 40.
        assert_eq!(output.receipt.credits_charged.0, 40);
        assert_eq!(
            os_accounts.events(),
            vec![
                RecordedCall::Authorize {
                    user_id: "usr_123".to_string(),
                    action: "note_generate".to_string(),
                    estimate: 8200,
                    hold_ttl: 300,
                },
                RecordedCall::Charge {
                    action_token: "agt_test".to_string(),
                    credits: 40,
                    idempotency_key: format!(
                        "note_generate:usr_123:note_1:{NOTE_GENERATE_PROMPT_VERSION}"
                    ),
                },
            ]
        );
        assert_eq!(output.prompt_version, NOTE_GENERATE_PROMPT_VERSION);
    }

    #[tokio::test]
    async fn note_generate_user_venice_key_skips_wallet_metering_for_venice_model() {
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let service = NoteGenerateService::new(NoteGenerateServiceDeps {
            pricing: Arc::new(PricingTable::new(venice_models([(
                "text-model",
                PriceUnit::Tokens,
                2,
                ModelType::Text,
            )]))),
            os_accounts: os_accounts.clone(),
            generator: Arc::new(FixedGenerator),
            hold_ttl_seconds: 300,
            flat_estimate_credits: 8200,
        });
        let mut params = note_generate_params();
        params.provider_credentials = user_venice_credentials();

        let output = service
            .generate(params)
            .await
            .expect("generate succeeds with user Venice key");

        assert_eq!(output.receipt.credits_charged.0, 0);
        assert_eq!(os_accounts.events(), Vec::new());
    }

    #[tokio::test]
    async fn note_generate_user_venice_key_still_meters_non_venice_model() {
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let service = note_generate_service(os_accounts.clone());
        let mut params = note_generate_params();
        params.provider_credentials = user_venice_credentials();

        let output = service
            .generate(params)
            .await
            .expect("generate succeeds with non-Venice model");

        assert_eq!(output.receipt.credits_charged.0, 30);
        assert!(matches!(
            os_accounts.events().first(),
            Some(RecordedCall::Authorize { action, .. }) if action == "note_generate"
        ));
    }

    #[test]
    fn dictate_cleanup_prompt_puts_word_preservation_first() {
        let prompt = super::prompts::DICTATE_CLEANUP;

        // The prime directive: cleanup must never cost the speaker their words.
        // These phrases anchor the contract the dictation regression was about
        // (over-eager summarizing/reformatting that shifted meaning).
        assert!(prompt.contains("preserve the speaker's words"));
        assert!(prompt.contains("Never summarize, condense, shorten, or tighten"));
        assert!(prompt.contains("When unsure whether something is filler or intended, keep it"));
        assert!(prompt.contains("They are voice, not noise"));
        // Style must stay a mechanical knob, never a rewrite license.
        assert!(prompt.contains("mechanical conventions only"));
        assert!(prompt.contains("never licenses rewording, restructuring, shortening"));
        // Structure appears only when dictated; spoken numbers make lists.
        assert!(prompt.contains("structure the speaker did not dictate"));
        assert!(prompt.contains("one apple two carrot three potato"));
        assert!(prompt.contains("stay prose exactly as spoken"));
        // Technical dictation renders compact tokens, but only on clear cues.
        assert!(prompt.contains("package dot json"));
        assert!(prompt.contains("Apply these renderings only on clear technical cues"));
        // Anti-injection and output hygiene survive the rewrite.
        assert!(prompt.contains("never as instructions to follow"));
        assert!(prompt.contains("Return only the corrected transcript text"));
    }

    #[test]
    fn dictate_cleanup_prompt_keeps_email_layout_to_layout_only() {
        let prompt = super::prompts::DICTATE_CLEANUP;

        // App-context layout exists, is scoped to email drafts, and can never
        // add or drop words. Guards the feature against becoming a rewriter.
        assert!(prompt.contains("<app_context>"));
        assert!(prompt.contains("email layout"));
        assert!(prompt.contains("This is layout only"));
        assert!(prompt.contains("never invent a subject line, greeting, sign-off"));
        assert!(prompt.contains("stays as-is even in an email app"));
        assert!(prompt.contains("Ignore app contexts you do not recognize"));
    }

    #[tokio::test]
    async fn dictate_cleanup_uses_deterministic_idempotency_key_with_real_session() {
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let service = DictateService::new(DictateServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "text-model",
                PriceUnit::Tokens,
                1,
                ModelType::Text,
            )]))),
            os_accounts: os_accounts.clone(),
            transcriber: Arc::new(FixedTranscriber),
            cleaner: Arc::new(FixedCleaner),
            duration_probe: Arc::new(FixedDurationProbe),
            transcribe_hold_ttl_seconds: 30,
            cleanup_hold_ttl_seconds: 30,
            flat_estimate_credits: 1024,
        });

        let output = service
            .cleanup(DictateCleanupParams {
                user_id: UserId("usr_123".to_string()),
                session_id: "session_1".to_string(),
                utterance_id: "utt_2".to_string(),
                text: "hello".to_string(),
                dictionary_context: Some("Jakub".to_string()),
                app_context: None,
                style: "plain".to_string(),
                model_id: ModelId("text-model".to_string()),
                provider_credentials: ProviderCredentials::default(),
            })
            .await
            .expect("cleanup succeeds with happy path");

        assert_eq!(output.receipt.credits_charged.0, 0);
        let charge_call = wait_for_charge_idempotency_key(&os_accounts)
            .await
            .unwrap_or_default();
        assert_eq!(charge_call, "dictate_cleanup:usr_123:session_1:utt_2");
    }

    #[tokio::test]
    async fn dictate_user_venice_key_skips_wallet_metering() {
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let service = DictateService::new(DictateServiceDeps {
            pricing: Arc::new(PricingTable::new(venice_models([
                ("audio-model", PriceUnit::Seconds, 2, ModelType::Asr),
                ("text-model", PriceUnit::Tokens, 1, ModelType::Text),
            ]))),
            os_accounts: os_accounts.clone(),
            transcriber: Arc::new(FixedTranscriber),
            cleaner: Arc::new(FixedCleaner),
            duration_probe: Arc::new(FixedDurationProbe),
            transcribe_hold_ttl_seconds: 30,
            cleanup_hold_ttl_seconds: 30,
            flat_estimate_credits: 1024,
        });

        let transcribe = service
            .transcribe(DictateTranscribeParams {
                user_id: UserId("usr_123".to_string()),
                session_id: "session_1".to_string(),
                utterance_id: "utt_1".to_string(),
                audio: vec![1, 2, 3],
                filename: "dictation.wav".to_string(),
                context: None,
                language: None,
                model_id: ModelId("audio-model".to_string()),
                provider_credentials: user_venice_credentials(),
            })
            .await
            .expect("dictate transcription succeeds with user Venice key");
        let cleanup = service
            .cleanup(DictateCleanupParams {
                user_id: UserId("usr_123".to_string()),
                session_id: "session_1".to_string(),
                utterance_id: "utt_1".to_string(),
                text: "hello".to_string(),
                dictionary_context: None,
                app_context: None,
                style: "plain".to_string(),
                model_id: ModelId("text-model".to_string()),
                provider_credentials: user_venice_credentials(),
            })
            .await
            .expect("dictate cleanup succeeds with user Venice key");

        assert_eq!(transcribe.receipt.credits_charged.0, 0);
        assert_eq!(cleanup.receipt.credits_charged.0, 0);
        assert_eq!(os_accounts.events(), Vec::new());
    }

    #[tokio::test]
    async fn dictate_transcribe_forwards_context_to_transcriber() {
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let transcriber = Arc::new(RecordingTranscriber::default());
        let service = DictateService::new(DictateServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "audio-model",
                PriceUnit::Seconds,
                2,
                ModelType::Asr,
            )]))),
            os_accounts: os_accounts.clone(),
            transcriber: transcriber.clone(),
            cleaner: Arc::new(FixedCleaner),
            duration_probe: Arc::new(FixedDurationProbe),
            transcribe_hold_ttl_seconds: 30,
            cleanup_hold_ttl_seconds: 30,
            flat_estimate_credits: 1024,
        });

        let output = service
            .transcribe(DictateTranscribeParams {
                user_id: UserId("usr_123".to_string()),
                session_id: "session_1".to_string(),
                utterance_id: "utt_2".to_string(),
                audio: vec![1, 2, 3],
                filename: "dictation.wav".to_string(),
                context: Some("Writing style: formal.".to_string()),
                language: Some("es".to_string()),
                model_id: ModelId("audio-model".to_string()),
                provider_credentials: ProviderCredentials::default(),
            })
            .await
            .expect("transcribe succeeds with happy path");

        assert_eq!(output.receipt.credits_charged.0, 0);
        assert!(matches!(
            os_accounts.events().first(),
            Some(RecordedCall::Authorize { action, .. }) if action == "dictate_transcribe"
        ));
        assert_eq!(
            transcriber.last_context(),
            Some("Writing style: formal.".to_string())
        );
        assert_eq!(transcriber.last_language(), Some("es".to_string()));
        assert_eq!(
            wait_for_charge_idempotency_key(&os_accounts).await,
            Some("dictate_transcribe:usr_123:session_1:utt_2".to_string())
        );
    }

    #[tokio::test]
    async fn dictate_transcribe_denied_authorization_does_not_dispatch_asr() {
        let os_accounts = Arc::new(RecordingOsAccounts {
            allow: false,
            deny_reason: Some("insufficient_available_balance".to_string()),
            ..RecordingOsAccounts::default()
        });
        let transcriber = Arc::new(RecordingTranscriber::default());
        let service = DictateService::new(DictateServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "audio-model",
                PriceUnit::Seconds,
                2,
                ModelType::Asr,
            )]))),
            os_accounts: os_accounts.clone(),
            transcriber: transcriber.clone(),
            cleaner: Arc::new(FixedCleaner),
            duration_probe: Arc::new(FixedDurationProbe),
            transcribe_hold_ttl_seconds: 30,
            cleanup_hold_ttl_seconds: 30,
            flat_estimate_credits: 1024,
        });

        let result = service
            .transcribe(DictateTranscribeParams {
                user_id: UserId("usr_123".to_string()),
                session_id: "session_1".to_string(),
                utterance_id: "utt_2".to_string(),
                audio: vec![1, 2, 3],
                filename: "dictation.wav".to_string(),
                context: None,
                language: None,
                model_id: ModelId("audio-model".to_string()),
                provider_credentials: ProviderCredentials::default(),
            })
            .await;

        assert!(matches!(result, Err(ServiceError::InsufficientCredits)));
        assert_eq!(transcriber.call_count(), 0);
        assert_eq!(
            os_accounts.events(),
            vec![RecordedCall::Authorize {
                user_id: "usr_123".to_string(),
                action: "dictate_transcribe".to_string(),
                estimate: 1024,
                hold_ttl: 30,
            }]
        );
    }

    #[tokio::test]
    async fn note_generate_prompt_requests_topic_headings() {
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let generator = Arc::new(RecordingGenerator::default());
        let service = NoteGenerateService::new(NoteGenerateServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "text-model",
                PriceUnit::Tokens,
                1,
                ModelType::Text,
            )]))),
            os_accounts,
            generator: generator.clone(),
            hold_ttl_seconds: 300,
            flat_estimate_credits: 1024,
        });

        service
            .generate(note_generate_params())
            .await
            .expect("generate succeeds with happy path");

        let prompt = generator.last_system_prompt().unwrap_or_default();
        assert!(prompt.contains("markdown H1 headings"));
        assert!(prompt.contains("# Heading"));
        assert!(prompt.contains("Do not add wrapper headings"));
    }

    #[tokio::test]
    async fn note_generate_prompt_requests_contextual_meeting_filtering() {
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let generator = Arc::new(RecordingGenerator::default());
        let service = NoteGenerateService::new(NoteGenerateServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "text-model",
                PriceUnit::Tokens,
                1,
                ModelType::Text,
            )]))),
            os_accounts,
            generator: generator.clone(),
            hold_ttl_seconds: 300,
            flat_estimate_credits: 1024,
        });

        service
            .generate(note_generate_params())
            .await
            .expect("generate succeeds with happy path");

        let prompt = generator.last_system_prompt().unwrap_or_default();
        assert!(prompt.contains("Use contextual judgment like a human meeting note-taker"));
        assert!(prompt.contains("decisions, commitments, action items"));
        assert!(prompt.contains("Do not preserve transient logistics"));
        assert!(prompt.contains("someone possibly being late"));
        assert!(prompt.contains("Prefer useful meeting notes over a faithful summary"));
    }

    #[tokio::test]
    async fn note_generate_rejects_asr_model_before_authorize() {
        // Regression: generation accepted any priced model id. Passing an ASR
        // model could take a wallet hold and call the text upstream before the
        // token-pricing unit mismatch was discovered.
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let service = NoteGenerateService::new(NoteGenerateServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "audio-model",
                PriceUnit::Seconds,
                2,
                ModelType::Asr,
            )]))),
            os_accounts: os_accounts.clone(),
            generator: Arc::new(FixedGenerator),
            hold_ttl_seconds: 300,
            flat_estimate_credits: 1024,
        });
        let mut params = note_generate_params();
        params.model_id = ModelId("audio-model".to_string());

        let result = service.generate(params).await;

        assert_eq!(result.map(|_| ()), Err(ServiceError::ModelNotPriced));
        assert_eq!(os_accounts.events(), Vec::new());
    }

    #[tokio::test]
    async fn dictate_cleanup_rejects_asr_model_before_authorize() {
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let service = DictateService::new(DictateServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "audio-model",
                PriceUnit::Seconds,
                2,
                ModelType::Asr,
            )]))),
            os_accounts: os_accounts.clone(),
            transcriber: Arc::new(FixedTranscriber),
            cleaner: Arc::new(FixedCleaner),
            duration_probe: Arc::new(FixedDurationProbe),
            transcribe_hold_ttl_seconds: 30,
            cleanup_hold_ttl_seconds: 30,
            flat_estimate_credits: 1024,
        });

        let result = service
            .cleanup(DictateCleanupParams {
                user_id: UserId("usr_123".to_string()),
                session_id: "session_1".to_string(),
                utterance_id: "utt_2".to_string(),
                text: "hello".to_string(),
                dictionary_context: None,
                app_context: None,
                style: "plain".to_string(),
                model_id: ModelId("audio-model".to_string()),
                provider_credentials: ProviderCredentials::default(),
            })
            .await;

        assert_eq!(result.map(|_| ()), Err(ServiceError::ModelNotPriced));
        assert_eq!(os_accounts.events(), Vec::new());
    }

    fn note_generate_service(os_accounts: Arc<RecordingOsAccounts>) -> NoteGenerateService {
        NoteGenerateService::new(NoteGenerateServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "text-model",
                PriceUnit::Tokens,
                1,
                ModelType::Text,
            )]))),
            os_accounts,
            generator: Arc::new(FixedGenerator),
            hold_ttl_seconds: 300,
            flat_estimate_credits: 1024,
        })
    }

    fn note_generate_params() -> NoteGenerateParams {
        NoteGenerateParams {
            user_id: UserId("usr_123".to_string()),
            note_id: "note_1".to_string(),
            prompt_version: "v7".to_string(),
            title: "Title".to_string(),
            transcript: "Transcript".to_string(),
            transcript_source_labels: false,
            manual_notes: None,
            language: None,
            existing_generated_note: None,
            model_id: ModelId("text-model".to_string()),
            provider_credentials: ProviderCredentials::default(),
            cost_quality: None,
        }
    }

    #[tokio::test]
    async fn note_transcribe_corrupt_audio_fails_fast_without_taking_a_hold() {
        // Regression: corrupt audio used to be probed only AFTER authorize,
        // stranding a hold on the user's wallet until its TTL expired. A user
        // retrying a bad upload could pile up holds and hit spurious
        // balance/concurrency denials.
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let service = NoteTranscribeService::new(NoteTranscribeServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "audio-model",
                PriceUnit::Seconds,
                2,
                ModelType::Asr,
            )]))),
            os_accounts: os_accounts.clone(),
            transcriber: Arc::new(FixedTranscriber),
            duration_probe: Arc::new(FailingDurationProbe),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1024,
            preview_max_audio_seconds: 30,
        });

        let result = service
            .transcribe(NoteTranscribeParams {
                user_id: UserId("usr_123".to_string()),
                note_id: "note_1".to_string(),
                audio: vec![1, 2, 3],
                filename: "recording.wav".to_string(),
                context: None,
                language: None,
                model_id: ModelId("audio-model".to_string()),
                preview: false,
                provider_credentials: ProviderCredentials::default(),
            })
            .await;

        assert!(matches!(result, Err(ServiceError::InvalidInput { .. })));
        assert_eq!(os_accounts.events(), Vec::new());
    }

    #[tokio::test]
    async fn note_transcribe_preview_authorizes_dispatches_asr_and_charges_actual_credits() {
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let transcriber = Arc::new(RecordingTranscriber::default());
        let service = NoteTranscribeService::new(NoteTranscribeServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "audio-model",
                PriceUnit::Seconds,
                2,
                ModelType::Asr,
            )]))),
            os_accounts: os_accounts.clone(),
            transcriber: transcriber.clone(),
            duration_probe: Arc::new(FixedDurationProbe),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1024,
            preview_max_audio_seconds: 30,
        });

        let output = service
            .transcribe(NoteTranscribeParams {
                user_id: UserId("usr_123".to_string()),
                note_id: "live-preview-session-1".to_string(),
                audio: vec![1, 2, 3],
                filename: "preview.wav".to_string(),
                context: Some("Previous words".to_string()),
                language: Some("en".to_string()),
                model_id: ModelId("audio-model".to_string()),
                preview: true,
                provider_credentials: ProviderCredentials::default(),
            })
            .await
            .expect("preview transcription succeeds");

        assert_eq!(output.receipt.credits_charged.0, 4);
        assert_eq!(
            os_accounts.events(),
            vec![
                RecordedCall::Authorize {
                    user_id: "usr_123".to_string(),
                    action: "note_transcribe".to_string(),
                    estimate: 1024,
                    hold_ttl: 60,
                },
                RecordedCall::Charge {
                    action_token: "agt_test".to_string(),
                    credits: 4,
                    idempotency_key: concat!(
                        "note_transcribe_preview:usr_123:live-preview-session-1:",
                        "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
                    )
                    .to_string(),
                },
            ]
        );
        assert_eq!(transcriber.call_count(), 1);
        assert_eq!(
            transcriber.last_context(),
            Some("Previous words".to_string())
        );
        assert_eq!(transcriber.last_language(), Some("en".to_string()));
    }

    #[tokio::test]
    async fn note_transcribe_hold_covers_actual_price_above_flat_estimate() {
        // Audio priced above the flat estimate must raise the hold to the
        // already-known price — otherwise the charge is clamped to the flat
        // cap and the overage is silently unbilled.
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let service = NoteTranscribeService::new(NoteTranscribeServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "audio-model",
                PriceUnit::Seconds,
                1_000,
                ModelType::Asr,
            )]))),
            os_accounts: os_accounts.clone(),
            transcriber: Arc::new(FixedTranscriber),
            duration_probe: Arc::new(FixedDurationProbe),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1024,
            preview_max_audio_seconds: 30,
        });

        let output = service
            .transcribe(NoteTranscribeParams {
                user_id: UserId("usr_123".to_string()),
                note_id: "note_pricey".to_string(),
                audio: vec![1, 2, 3],
                filename: "pricey.wav".to_string(),
                context: None,
                language: None,
                model_id: ModelId("audio-model".to_string()),
                preview: true,
                provider_credentials: ProviderCredentials::default(),
            })
            .await
            .expect("transcription succeeds");

        // 2s (probed, ceiled) × 1_000 credits/sec = 2_000 > flat 1_024: the
        // hold rises to the actual price and the charge settles unclamped.
        assert_eq!(output.receipt.credits_charged.0, 2_000);
        assert!(matches!(
            os_accounts.events().first(),
            Some(RecordedCall::Authorize {
                estimate: 2_000,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn note_transcribe_user_venice_key_skips_wallet_metering_for_preview_and_final() {
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let transcriber = Arc::new(RecordingTranscriber::default());
        let service = NoteTranscribeService::new(NoteTranscribeServiceDeps {
            pricing: Arc::new(PricingTable::new(venice_models([(
                "audio-model",
                PriceUnit::Seconds,
                2,
                ModelType::Asr,
            )]))),
            os_accounts: os_accounts.clone(),
            transcriber: transcriber.clone(),
            duration_probe: Arc::new(FixedDurationProbe),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1024,
            preview_max_audio_seconds: 30,
        });

        for preview in [true, false] {
            let output = service
                .transcribe(NoteTranscribeParams {
                    user_id: UserId("usr_123".to_string()),
                    note_id: format!("note_{preview}"),
                    audio: vec![1, 2, 3],
                    filename: "recording.wav".to_string(),
                    context: None,
                    language: None,
                    model_id: ModelId("audio-model".to_string()),
                    preview,
                    provider_credentials: user_venice_credentials(),
                })
                .await
                .expect("transcription succeeds with user Venice key");
            assert_eq!(output.receipt.credits_charged.0, 0);
        }

        assert_eq!(transcriber.call_count(), 2);
        assert_eq!(os_accounts.events(), Vec::new());
    }

    #[tokio::test]
    async fn note_transcribe_preview_failure_releases_hold_without_billing() {
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let service = NoteTranscribeService::new(NoteTranscribeServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "audio-model",
                PriceUnit::Seconds,
                2,
                ModelType::Asr,
            )]))),
            os_accounts: os_accounts.clone(),
            transcriber: Arc::new(FailingTranscriber),
            duration_probe: Arc::new(FixedDurationProbe),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1024,
            preview_max_audio_seconds: 30,
        });

        let result = service
            .transcribe(NoteTranscribeParams {
                user_id: UserId("usr_123".to_string()),
                note_id: "live-preview-session-1".to_string(),
                audio: vec![1, 2, 3],
                filename: "preview.wav".to_string(),
                context: None,
                language: None,
                model_id: ModelId("audio-model".to_string()),
                preview: true,
                provider_credentials: ProviderCredentials::default(),
            })
            .await;

        assert!(matches!(result, Err(ServiceError::UpstreamProvider)));
        // Failed previews used to bill the full audio price just to close the
        // hold; a zero-credit release closes it without charging.
        assert_eq!(
            os_accounts.events(),
            vec![
                RecordedCall::Authorize {
                    user_id: "usr_123".to_string(),
                    action: "note_transcribe".to_string(),
                    estimate: 1024,
                    hold_ttl: 60,
                },
                release_charge_event("note_transcribe"),
            ]
        );
    }

    /// The grant-scoped release key: never collides with a later successful
    /// charge of the same work under a fresh grant.
    fn release_charge_event(action: &str) -> RecordedCall {
        RecordedCall::Charge {
            action_token: "agt_test".to_string(),
            credits: 0,
            idempotency_key: format!(
                "release:{action}:{}",
                &crate::util::sha256_hex("agt_test".as_bytes())[..32],
            ),
        }
    }

    #[tokio::test]
    async fn note_transcribe_failure_releases_hold() {
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let service = NoteTranscribeService::new(NoteTranscribeServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "audio-model",
                PriceUnit::Seconds,
                2,
                ModelType::Asr,
            )]))),
            os_accounts: os_accounts.clone(),
            transcriber: Arc::new(FailingTranscriber),
            duration_probe: Arc::new(FixedDurationProbe),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1024,
            preview_max_audio_seconds: 30,
        });

        let result = service
            .transcribe(NoteTranscribeParams {
                user_id: UserId("usr_123".to_string()),
                note_id: "note-1-turn-4-chunk-0".to_string(),
                audio: vec![1, 2, 3],
                filename: "turn.wav".to_string(),
                context: None,
                language: None,
                model_id: ModelId("audio-model".to_string()),
                preview: false,
                provider_credentials: ProviderCredentials::default(),
            })
            .await;

        // The provider failure propagates, but the hold is settled at zero:
        // stranded holds from failed turns are what saturated the concurrency
        // cap and denied every later authorize in the 2026-07-14 incident.
        assert!(matches!(result, Err(ServiceError::UpstreamProvider)));
        assert_eq!(
            os_accounts.events(),
            vec![
                RecordedCall::Authorize {
                    user_id: "usr_123".to_string(),
                    action: "note_transcribe".to_string(),
                    estimate: 1024,
                    hold_ttl: 60,
                },
                release_charge_event("note_transcribe"),
            ]
        );
    }

    #[tokio::test]
    async fn note_transcribe_preview_idempotency_key_distinguishes_audio_chunks() {
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let service = NoteTranscribeService::new(NoteTranscribeServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "audio-model",
                PriceUnit::Seconds,
                2,
                ModelType::Asr,
            )]))),
            os_accounts: os_accounts.clone(),
            transcriber: Arc::new(FixedTranscriber),
            duration_probe: Arc::new(FixedDurationProbe),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1024,
            preview_max_audio_seconds: 30,
        });

        for audio in [vec![1, 2, 3], vec![4, 5, 6]] {
            service
                .transcribe(NoteTranscribeParams {
                    user_id: UserId("usr_123".to_string()),
                    note_id: "legacy-preview-note-id".to_string(),
                    audio,
                    filename: "preview.wav".to_string(),
                    context: None,
                    language: None,
                    model_id: ModelId("audio-model".to_string()),
                    preview: true,
                    provider_credentials: ProviderCredentials::default(),
                })
                .await
                .expect("preview transcription succeeds");
        }

        let charge_keys = os_accounts
            .events()
            .into_iter()
            .filter_map(|event| match event {
                RecordedCall::Charge {
                    idempotency_key, ..
                } => Some(idempotency_key),
                RecordedCall::Authorize { .. } => None,
            })
            .collect::<Vec<_>>();

        assert_eq!(
            charge_keys,
            vec![
                concat!(
                    "note_transcribe_preview:usr_123:legacy-preview-note-id:",
                    "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
                )
                .to_string(),
                concat!(
                    "note_transcribe_preview:usr_123:legacy-preview-note-id:",
                    "787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472",
                )
                .to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn note_transcribe_preview_denied_authorization_does_not_dispatch_asr() {
        let os_accounts = Arc::new(RecordingOsAccounts {
            allow: false,
            deny_reason: Some("insufficient_available_balance".to_string()),
            ..RecordingOsAccounts::default()
        });
        let transcriber = Arc::new(RecordingTranscriber::default());
        let service = NoteTranscribeService::new(NoteTranscribeServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "audio-model",
                PriceUnit::Seconds,
                2,
                ModelType::Asr,
            )]))),
            os_accounts: os_accounts.clone(),
            transcriber: transcriber.clone(),
            duration_probe: Arc::new(FixedDurationProbe),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1024,
            preview_max_audio_seconds: 30,
        });

        let result = service
            .transcribe(NoteTranscribeParams {
                user_id: UserId("usr_123".to_string()),
                note_id: "live-preview-session-1".to_string(),
                audio: vec![1, 2, 3],
                filename: "preview.wav".to_string(),
                context: None,
                language: None,
                model_id: ModelId("audio-model".to_string()),
                preview: true,
                provider_credentials: ProviderCredentials::default(),
            })
            .await;

        assert!(matches!(result, Err(ServiceError::InsufficientCredits)));
        assert_eq!(transcriber.call_count(), 0);
        assert_eq!(
            os_accounts.events(),
            vec![RecordedCall::Authorize {
                user_id: "usr_123".to_string(),
                action: "note_transcribe".to_string(),
                estimate: 1024,
                hold_ttl: 60,
            }]
        );
    }

    #[tokio::test]
    async fn note_transcribe_preview_rejects_audio_over_duration_cap() {
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let transcriber = Arc::new(RecordingTranscriber::default());
        let service = NoteTranscribeService::new(NoteTranscribeServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "audio-model",
                PriceUnit::Seconds,
                2,
                ModelType::Asr,
            )]))),
            os_accounts: os_accounts.clone(),
            transcriber: transcriber.clone(),
            duration_probe: Arc::new(FixedDurationProbe),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1024,
            preview_max_audio_seconds: 1,
        });

        let result = service
            .transcribe(NoteTranscribeParams {
                user_id: UserId("usr_123".to_string()),
                note_id: "live-preview-session-1".to_string(),
                audio: vec![1, 2, 3],
                filename: "preview.wav".to_string(),
                context: None,
                language: None,
                model_id: ModelId("audio-model".to_string()),
                preview: true,
                provider_credentials: ProviderCredentials::default(),
            })
            .await;

        assert!(matches!(result, Err(ServiceError::InvalidInput { .. })));
        assert_eq!(transcriber.call_count(), 0);
        assert_eq!(os_accounts.events(), Vec::new());
    }

    #[tokio::test]
    async fn dictate_transcribe_corrupt_audio_fails_fast_without_taking_a_hold() {
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let service = DictateService::new(DictateServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "audio-model",
                PriceUnit::Seconds,
                2,
                ModelType::Asr,
            )]))),
            os_accounts: os_accounts.clone(),
            transcriber: Arc::new(FixedTranscriber),
            cleaner: Arc::new(FixedCleaner),
            duration_probe: Arc::new(FailingDurationProbe),
            transcribe_hold_ttl_seconds: 30,
            cleanup_hold_ttl_seconds: 30,
            flat_estimate_credits: 1024,
        });

        let result = service
            .transcribe(DictateTranscribeParams {
                user_id: UserId("usr_123".to_string()),
                session_id: "session_1".to_string(),
                utterance_id: "utt_1".to_string(),
                audio: vec![1, 2, 3],
                filename: "dictation.wav".to_string(),
                context: None,
                language: None,
                model_id: ModelId("audio-model".to_string()),
                provider_credentials: ProviderCredentials::default(),
            })
            .await;

        assert!(matches!(result, Err(ServiceError::InvalidInput { .. })));
        assert_eq!(os_accounts.events(), Vec::new());
    }

    #[tokio::test]
    async fn balance_denial_maps_to_insufficient_credits() {
        let os_accounts = Arc::new(RecordingOsAccounts {
            allow: false,
            deny_reason: Some("insufficient_available_balance".to_string()),
            ..RecordingOsAccounts::default()
        });
        let service = note_generate_service(os_accounts);

        let result = service.generate(note_generate_params()).await;

        assert!(matches!(result, Err(ServiceError::InsufficientCredits)));
    }

    #[tokio::test]
    async fn transient_denial_does_not_map_to_insufficient_credits() {
        // A user with funds who hits a concurrency cap must NOT be told to add
        // funds — it surfaces as a transient authorization denial instead.
        let os_accounts = Arc::new(RecordingOsAccounts {
            allow: false,
            deny_reason: Some("concurrency_cap_exceeded".to_string()),
            ..RecordingOsAccounts::default()
        });
        let service = note_generate_service(os_accounts);

        let result = service.generate(note_generate_params()).await;

        assert!(matches!(result, Err(ServiceError::AuthorizationDenied)));
    }

    #[tokio::test]
    async fn agent_chat_user_venice_key_skips_wallet_metering_for_venice_model() {
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let service = AgentChatService::new(AgentChatServiceDeps {
            pricing: Arc::new(PricingTable::new(venice_models([(
                "text-model",
                PriceUnit::Tokens,
                1,
                ModelType::Text,
            )]))),
            os_accounts: os_accounts.clone(),
            chat_completer: Arc::new(FixedAgentChatCompleter),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1024,
        });

        let output = service
            .complete(AgentChatParams {
                user_id: UserId("usr_123".to_string()),
                model_id: ModelId("text-model".to_string()),
                body: serde_json::json!({
                    "model": "text-model",
                    "messages": [{ "role": "user", "content": "hello" }],
                }),
                provider_credentials: user_venice_credentials(),
            })
            .await
            .expect("agent chat succeeds with user Venice key");

        assert_eq!(output.receipt.credits_charged.0, 0);
        assert_eq!(os_accounts.events(), Vec::new());
    }

    #[tokio::test]
    async fn agent_chat_stream_settles_charge_from_usage_after_stream_end() {
        let os_accounts = Arc::new(RecordingOsAccounts::with_cap(Some(100)));
        let service = AgentChatService::new(AgentChatServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "text-model",
                PriceUnit::Tokens,
                1,
                ModelType::Text,
            )]))),
            os_accounts: os_accounts.clone(),
            chat_completer: Arc::new(FixedAgentChatCompleter),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1024,
        });

        let _output = service
            .complete_stream(agent_chat_params())
            .await
            .expect("stream starts");

        let idempotency_key = wait_for_charge_idempotency_key(&os_accounts)
            .await
            .expect("stream settlement charges");
        let rest = idempotency_key
            .strip_prefix("agent_chat:usr_123:attempt:")
            .expect("settlement key is attempt-scoped");
        let (operation_id, digest) = rest.split_once(':').expect("attempt:digest");
        uuid::Uuid::parse_str(operation_id).expect("attempt scope is a UUID");
        assert_eq!(digest.len(), 64, "digest suffix is full sha256 hex");
        assert_eq!(
            os_accounts.events(),
            vec![
                RecordedCall::Authorize {
                    user_id: "usr_123".to_string(),
                    action: "agent_chat".to_string(),
                    estimate: 1024,
                    hold_ttl: 60,
                },
                RecordedCall::Charge {
                    action_token: "agt_test".to_string(),
                    credits: 30,
                    idempotency_key,
                },
            ]
        );
    }

    #[tokio::test]
    async fn agent_chat_retried_identical_body_settles_under_a_fresh_key() {
        // A retried identical body runs a fresh upstream completion that
        // delivers its own content; a key derived from content alone would
        // replay the first settlement and deliver the second one free.
        let os_accounts = Arc::new(RecordingOsAccounts::with_cap(Some(100)));
        let service = AgentChatService::new(AgentChatServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "text-model",
                PriceUnit::Tokens,
                1,
                ModelType::Text,
            )]))),
            os_accounts: os_accounts.clone(),
            chat_completer: Arc::new(FixedAgentChatCompleter),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1024,
        });

        service
            .complete(agent_chat_params())
            .await
            .expect("first attempt succeeds");
        service
            .complete(agent_chat_params())
            .await
            .expect("retried attempt succeeds");

        let keys: Vec<String> = os_accounts
            .events()
            .into_iter()
            .filter_map(|call| match call {
                RecordedCall::Charge {
                    idempotency_key, ..
                } => Some(idempotency_key),
                RecordedCall::Authorize { .. } => None,
            })
            .collect();
        assert_eq!(keys.len(), 2, "both attempts settle a charge");
        assert_ne!(keys[0], keys[1], "each attempt has its own settlement key");
        let digest_of = |key: &str| key.rsplit(':').next().map(str::to_string);
        assert_eq!(
            digest_of(&keys[0]),
            digest_of(&keys[1]),
            "identical bodies share the digest suffix"
        );
    }

    #[tokio::test]
    async fn agent_chat_stream_missing_usage_charges_flat_estimate_clamped_to_cap() {
        let os_accounts = Arc::new(RecordingOsAccounts::with_cap(Some(40)));
        let service = AgentChatService::new(AgentChatServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "text-model",
                PriceUnit::Tokens,
                1,
                ModelType::Text,
            )]))),
            os_accounts: os_accounts.clone(),
            chat_completer: Arc::new(MissingUsageAgentChatCompleter),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1024,
        });

        let _output = service
            .complete_stream(agent_chat_params())
            .await
            .expect("stream starts");

        let _ = wait_for_charge_idempotency_key(&os_accounts)
            .await
            .expect("fallback settlement charges");
        assert!(
            os_accounts
                .events()
                .into_iter()
                .any(|event| matches!(event, RecordedCall::Charge { credits: 40, .. }))
        );
    }

    #[tokio::test]
    async fn agent_chat_stream_transport_failure_charges_nothing() {
        let os_accounts = Arc::new(RecordingOsAccounts::with_cap(Some(40)));
        let service = AgentChatService::new(AgentChatServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "text-model",
                PriceUnit::Tokens,
                1,
                ModelType::Text,
            )]))),
            os_accounts: os_accounts.clone(),
            chat_completer: Arc::new(TransportFailedAgentChatCompleter),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1024,
        });

        let mut output = service
            .complete_stream(agent_chat_params())
            .await
            .expect("stream starts");
        while output.chunks.recv().await.is_some() {}
        // The settle task releases the hold (zero-credit charge) on a
        // transport failure; yield so it runs to completion before asserting.
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }

        let charges = os_accounts
            .events()
            .into_iter()
            .filter(|event| matches!(event, RecordedCall::Charge { .. }))
            .collect::<Vec<_>>();
        assert_eq!(
            charges,
            vec![release_charge_event("agent_chat")],
            "a transport-failed stream must release the hold without billing"
        );
    }

    #[tokio::test]
    async fn agent_chat_stream_user_venice_key_skips_wallet_metering() {
        let os_accounts = Arc::new(RecordingOsAccounts::default());
        let service = AgentChatService::new(AgentChatServiceDeps {
            pricing: Arc::new(PricingTable::new(venice_models([(
                "text-model",
                PriceUnit::Tokens,
                1,
                ModelType::Text,
            )]))),
            os_accounts: os_accounts.clone(),
            chat_completer: Arc::new(FixedAgentChatCompleter),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1024,
        });

        let _output = service
            .complete_stream(AgentChatParams {
                provider_credentials: user_venice_credentials(),
                ..agent_chat_params()
            })
            .await
            .expect("stream starts with user Venice key");

        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(os_accounts.events(), Vec::new());
    }

    #[tokio::test]
    async fn agent_chat_stream_authorize_deny_returns_before_completer_call() {
        let os_accounts = Arc::new(RecordingOsAccounts {
            allow: false,
            deny_reason: Some("concurrency_cap_exceeded".to_string()),
            ..RecordingOsAccounts::default()
        });
        let completer = Arc::new(CountingAgentChatCompleter::default());
        let service = AgentChatService::new(AgentChatServiceDeps {
            pricing: Arc::new(PricingTable::new(models([(
                "text-model",
                PriceUnit::Tokens,
                1,
                ModelType::Text,
            )]))),
            os_accounts,
            chat_completer: completer.clone(),
            hold_ttl_seconds: 60,
            flat_estimate_credits: 1024,
        });

        let result = service.complete_stream(agent_chat_params()).await;

        assert!(matches!(result, Err(ServiceError::AuthorizationDenied)));
        assert_eq!(completer.calls.load(Ordering::SeqCst), 0);
    }

    async fn wait_for_charge_idempotency_key(os_accounts: &RecordingOsAccounts) -> Option<String> {
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            if let Some(idempotency_key) =
                os_accounts
                    .events()
                    .into_iter()
                    .find_map(|call| match call {
                        RecordedCall::Charge {
                            idempotency_key, ..
                        } => Some(idempotency_key),
                        RecordedCall::Authorize { .. } => None,
                    })
            {
                return Some(idempotency_key);
            }
            if Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn models<const N: usize>(
        values: [(&str, PriceUnit, u64, ModelType); N],
    ) -> BTreeMap<String, ModelPriceConfig> {
        values
            .into_iter()
            .map(|(id, unit, credits_per_unit, model_type)| {
                (
                    id.to_string(),
                    ModelPriceConfig {
                        unit,
                        credits_per_million_seconds: (unit == PriceUnit::Seconds)
                            .then_some(credits_per_unit.saturating_mul(1_000_000)),
                        input_credits_per_million_tokens: (unit == PriceUnit::Tokens)
                            .then_some(credits_per_unit.saturating_mul(1_000_000)),
                        output_credits_per_million_tokens: (unit == PriceUnit::Tokens)
                            .then_some(credits_per_unit.saturating_mul(1_000_000)),
                        provider: ModelProvider::Openai,
                        model_type,
                        display_name: id.to_string(),
                        description: None,
                        privacy: None,
                        pricing: None,
                        context_tokens: None,
                        traits: Vec::new(),
                        capabilities: Vec::new(),
                    },
                )
            })
            .collect()
    }

    fn venice_models<const N: usize>(
        values: [(&str, PriceUnit, u64, ModelType); N],
    ) -> BTreeMap<String, ModelPriceConfig> {
        let mut models = models(values);
        for model in models.values_mut() {
            model.provider = ModelProvider::Venice;
        }
        models
    }

    fn user_venice_credentials() -> ProviderCredentials {
        ProviderCredentials {
            venice_api_key: Some("vc_user_key".to_string()),
        }
    }

    fn agent_chat_params() -> AgentChatParams {
        AgentChatParams {
            user_id: UserId("usr_123".to_string()),
            model_id: ModelId("text-model".to_string()),
            body: serde_json::json!({
                "model": "text-model",
                "messages": [{ "role": "user", "content": "hello" }],
                "stream": true,
            }),
            provider_credentials: ProviderCredentials::default(),
        }
    }

    struct RecordingOsAccounts {
        allow: bool,
        cap: Option<u64>,
        deny_reason: Option<String>,
        fail_charge: bool,
        events: Mutex<Vec<RecordedCall>>,
    }

    impl Default for RecordingOsAccounts {
        fn default() -> Self {
            Self {
                allow: true,
                cap: Some(10_000),
                deny_reason: None,
                fail_charge: false,
                events: Mutex::new(Vec::new()),
            }
        }
    }

    impl RecordingOsAccounts {
        fn with_cap(cap: Option<u64>) -> Self {
            Self {
                allow: true,
                cap,
                deny_reason: None,
                fail_charge: false,
                events: Mutex::new(Vec::new()),
            }
        }

        fn events(&self) -> Vec<RecordedCall> {
            self.events
                .lock()
                .map(|events| events.clone())
                .unwrap_or_default()
        }
    }

    #[async_trait]
    impl OsAccountsClient for RecordingOsAccounts {
        async fn authorize(&self, request: AuthorizeRequest) -> Result<Authorization, DomainError> {
            if let Ok(mut events) = self.events.lock() {
                events.push(RecordedCall::Authorize {
                    user_id: request.user_id.0.clone(),
                    action: request.action.to_string(),
                    estimate: request.estimate.0,
                    hold_ttl: request.hold_ttl_seconds,
                });
            }
            Ok(Authorization {
                allowed: self.allow,
                action_token: self.allow.then(|| "agt_test".to_string()),
                cap_credits: self.cap.map(Credits),
                reason: self.deny_reason.clone(),
            })
        }

        async fn charge(&self, request: ChargeRequest) -> Result<Receipt, DomainError> {
            if let Ok(mut events) = self.events.lock() {
                events.push(RecordedCall::Charge {
                    action_token: request.action_token,
                    credits: request.credits.0,
                    idempotency_key: request.idempotency_key,
                });
            }
            if self.fail_charge {
                return Err(DomainError::MeteringProvider);
            }
            Ok(Receipt {
                credits_charged: request.credits,
                idempotent_replay: false,
            })
        }
    }

    struct FixedGenerator;

    #[async_trait]
    impl Generator for FixedGenerator {
        async fn generate(
            &self,
            _request: GenerationRequest,
        ) -> Result<GeneratedNote, DomainError> {
            Ok(GeneratedNote {
                content: "Generated note".to_string(),
                title_suggestion: Some("Title".to_string()),
                provider: "test".to_string(),
                route: UpstreamRouteMetadata::default(),
                usage: TokenUsage {
                    prompt_tokens: 10,
                    completion_tokens: 20,
                },
            })
        }
    }

    #[derive(Default)]
    struct RecordingGenerator {
        last_system_prompt: Mutex<Option<String>>,
    }

    impl RecordingGenerator {
        fn last_system_prompt(&self) -> Option<String> {
            self.last_system_prompt
                .lock()
                .ok()
                .and_then(|value| value.clone())
        }
    }

    #[async_trait]
    impl Generator for RecordingGenerator {
        async fn generate(&self, request: GenerationRequest) -> Result<GeneratedNote, DomainError> {
            if let Ok(mut last_system_prompt) = self.last_system_prompt.lock() {
                *last_system_prompt = Some(request.system_prompt);
            }
            Ok(GeneratedNote {
                content: "Generated note".to_string(),
                title_suggestion: Some("Title".to_string()),
                provider: "test".to_string(),
                route: UpstreamRouteMetadata::default(),
                usage: TokenUsage {
                    prompt_tokens: 10,
                    completion_tokens: 20,
                },
            })
        }
    }

    struct FixedCleaner;

    #[async_trait]
    impl Cleaner for FixedCleaner {
        async fn cleanup(&self, _request: CleanupRequest) -> Result<CleanedText, DomainError> {
            Ok(CleanedText {
                text: "Hello".to_string(),
                provider: "test".to_string(),
                route: UpstreamRouteMetadata::default(),
                usage: TokenUsage {
                    prompt_tokens: 5,
                    completion_tokens: 6,
                },
            })
        }
    }

    struct FixedAgentChatCompleter;

    #[async_trait]
    impl AgentChatCompleter for FixedAgentChatCompleter {
        async fn complete(
            &self,
            _request: AgentChatRequest,
        ) -> Result<AgentChatCompletion, DomainError> {
            Ok(AgentChatCompletion {
                body: br#"{"id":"chatcmpl_test"}"#.to_vec(),
                content_type: "application/json".to_string(),
                provider: "test".to_string(),
                route: UpstreamRouteMetadata::default(),
                usage: TokenUsage {
                    prompt_tokens: 10,
                    completion_tokens: 20,
                },
            })
        }

        async fn complete_stream(
            &self,
            _request: AgentChatRequest,
        ) -> Result<AgentChatStream, DomainError> {
            let (chunks_tx, chunks_rx) = tokio::sync::mpsc::unbounded_channel();
            let (outcome_tx, outcome_rx) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let _ = chunks_tx.send(Ok(bytes::Bytes::from_static(br"data: hello\n\n")));
                let _ = outcome_tx.send(AgentChatStreamOutcome::Usage(TokenUsage {
                    prompt_tokens: 10,
                    completion_tokens: 20,
                }));
            });
            Ok(AgentChatStream {
                content_type: "text/event-stream".to_string(),
                provider: "test".to_string(),
                route: UpstreamRouteMetadata::default(),
                chunks: chunks_rx,
                outcome: outcome_rx,
            })
        }
    }

    struct MissingUsageAgentChatCompleter;

    #[async_trait]
    impl AgentChatCompleter for MissingUsageAgentChatCompleter {
        async fn complete(
            &self,
            _request: AgentChatRequest,
        ) -> Result<AgentChatCompletion, DomainError> {
            Err(DomainError::UpstreamProvider)
        }

        async fn complete_stream(
            &self,
            _request: AgentChatRequest,
        ) -> Result<AgentChatStream, DomainError> {
            let (chunks_tx, chunks_rx) = tokio::sync::mpsc::unbounded_channel();
            let (outcome_tx, outcome_rx) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let _ = chunks_tx.send(Ok(bytes::Bytes::from_static(br"data: hello\n\n")));
                let _ = outcome_tx.send(AgentChatStreamOutcome::CompletedWithoutUsage);
            });
            Ok(AgentChatStream {
                content_type: "text/event-stream".to_string(),
                provider: "test".to_string(),
                route: UpstreamRouteMetadata::default(),
                chunks: chunks_rx,
                outcome: outcome_rx,
            })
        }
    }

    struct TransportFailedAgentChatCompleter;

    #[async_trait]
    impl AgentChatCompleter for TransportFailedAgentChatCompleter {
        async fn complete(
            &self,
            _request: AgentChatRequest,
        ) -> Result<AgentChatCompletion, DomainError> {
            Err(DomainError::UpstreamProvider)
        }

        async fn complete_stream(
            &self,
            _request: AgentChatRequest,
        ) -> Result<AgentChatStream, DomainError> {
            let (chunks_tx, chunks_rx) = tokio::sync::mpsc::unbounded_channel();
            let (outcome_tx, outcome_rx) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let _ = chunks_tx.send(Ok(bytes::Bytes::from_static(br"data: hel")));
                let _ = chunks_tx.send(Err(DomainError::UpstreamProvider));
                let _ = outcome_tx.send(AgentChatStreamOutcome::Failed);
            });
            Ok(AgentChatStream {
                content_type: "text/event-stream".to_string(),
                provider: "test".to_string(),
                route: UpstreamRouteMetadata::default(),
                chunks: chunks_rx,
                outcome: outcome_rx,
            })
        }
    }

    #[derive(Default)]
    struct CountingAgentChatCompleter {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl AgentChatCompleter for CountingAgentChatCompleter {
        async fn complete(
            &self,
            _request: AgentChatRequest,
        ) -> Result<AgentChatCompletion, DomainError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(DomainError::UpstreamProvider)
        }

        async fn complete_stream(
            &self,
            _request: AgentChatRequest,
        ) -> Result<AgentChatStream, DomainError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(DomainError::UpstreamProvider)
        }
    }

    struct FixedTranscriber;

    #[async_trait]
    impl Transcriber for FixedTranscriber {
        async fn transcribe(
            &self,
            _request: TranscriptionRequest,
        ) -> Result<Transcript, DomainError> {
            Ok(Transcript {
                text: "Transcript".to_string(),
                language: Some("en".to_string()),
                provider: "test".to_string(),
            })
        }
    }

    struct FailingTranscriber;

    #[async_trait]
    impl Transcriber for FailingTranscriber {
        async fn transcribe(
            &self,
            _request: TranscriptionRequest,
        ) -> Result<Transcript, DomainError> {
            Err(DomainError::UpstreamProvider)
        }
    }

    #[derive(Default)]
    struct RecordingTranscriber {
        last_context: Mutex<Option<String>>,
        last_language: Mutex<Option<String>>,
        calls: Mutex<u64>,
    }

    impl RecordingTranscriber {
        fn call_count(&self) -> u64 {
            self.calls.lock().map(|value| *value).unwrap_or_default()
        }

        fn last_context(&self) -> Option<String> {
            self.last_context
                .lock()
                .ok()
                .and_then(|value| value.clone())
        }

        fn last_language(&self) -> Option<String> {
            self.last_language
                .lock()
                .ok()
                .and_then(|value| value.clone())
        }
    }

    #[async_trait]
    impl Transcriber for RecordingTranscriber {
        async fn transcribe(
            &self,
            request: TranscriptionRequest,
        ) -> Result<Transcript, DomainError> {
            if let Ok(mut calls) = self.calls.lock() {
                *calls += 1;
            }
            if let Ok(mut last_context) = self.last_context.lock() {
                *last_context = request.context;
            }
            if let Ok(mut last_language) = self.last_language.lock() {
                *last_language = request.language;
            }
            Ok(Transcript {
                text: "Transcript".to_string(),
                language: Some("en".to_string()),
                provider: "test".to_string(),
            })
        }
    }

    struct FixedDurationProbe;

    impl AudioDurationProbe for FixedDurationProbe {
        fn probe(&self, _audio: &[u8]) -> Result<Duration, DomainError> {
            Ok(Duration::from_millis(1500))
        }
    }

    struct FailingDurationProbe;

    impl AudioDurationProbe for FailingDurationProbe {
        fn probe(&self, _audio: &[u8]) -> Result<Duration, DomainError> {
            Err(DomainError::InvalidInput {
                reason: "invalid wav".to_string(),
            })
        }
    }
}
