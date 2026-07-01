use crate::{
    charge_flow::{
        AuthorizeParams, ChargeParams, authorize_or_deny, charge, clamp_to_cap, log_settled,
        zero_receipt,
    },
    error::ServiceError,
    metering::{log_skipped_user_venice_key, uses_user_venice_key},
    util::sha256_hex,
};
use june_config::ModelProvider;
use june_domain::{
    ActionSlug, Credits, GeneratedImage, ImageGenerationRequest, ImageGenerator, ModelId,
    OsAccountsClient, ProviderCredentials, Receipt, UserId,
};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

/// Metered image generation. Each generation is flat-priced per model (Venice
/// bills per image), so the authorize estimate and the settled charge are the
/// same configured credit amount rather than a usage-derived figure. A model
/// with no configured price is rejected before the wallet or Venice is touched;
/// a failed or rejected generation returns the error WITHOUT charging (the hold
/// simply expires), matching the web and agent chat paths.
pub struct ImageServiceDeps {
    pub os_accounts: Arc<dyn OsAccountsClient>,
    pub generator: Arc<dyn ImageGenerator>,
    /// Flat price and upstream provider per image model. A model absent here
    /// is rejected as `model_not_priced`.
    pub pricing: BTreeMap<String, ImageModelPrice>,
    pub hold_ttl_seconds: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ImageModelPrice {
    pub credits: u64,
    pub provider: ModelProvider,
}

impl ImageModelPrice {
    pub fn venice(credits: u64) -> Self {
        Self {
            credits,
            provider: ModelProvider::Venice,
        }
    }
}

pub struct ImageService {
    os_accounts: Arc<dyn OsAccountsClient>,
    generator: Arc<dyn ImageGenerator>,
    pricing: BTreeMap<String, ImageModelPrice>,
    hold_ttl_seconds: u64,
    /// Per-process sequence that makes every generation settle under a UNIQUE
    /// charge key. Image generation is not idempotent — a repeat produces a new
    /// image and a new upstream cost — so the key is never client-supplied; that
    /// prevents replaying one settlement to mint free images.
    seq: AtomicU64,
}

impl ImageService {
    pub fn new(deps: ImageServiceDeps) -> Self {
        Self {
            os_accounts: deps.os_accounts,
            generator: deps.generator,
            pricing: deps.pricing,
            hold_ttl_seconds: deps.hold_ttl_seconds,
            seq: AtomicU64::new(0),
        }
    }

    /// Look up a model's flat per-image price. `None` for an unpriced model.
    pub fn price(&self, model: &str) -> Option<u64> {
        self.pricing.get(model).map(|price| price.credits)
    }

    pub async fn generate(
        &self,
        params: ImageGenerateParams,
    ) -> Result<ImageGenerateOutput, ServiceError> {
        // Reject an unpriced model before touching the wallet or Venice.
        let price = self
            .pricing
            .get(&params.model)
            .copied()
            .ok_or(ServiceError::ModelNotPriced)?;
        let estimate = Credits(price.credits);
        if price.provider == ModelProvider::Venice
            && uses_user_venice_key(&params.provider_credentials)
        {
            let image = self
                .generator
                .generate(ImageGenerationRequest {
                    prompt: params.prompt.clone(),
                    model: ModelId(params.model.clone()),
                    width: params.width,
                    height: params.height,
                    provider_credentials: params.provider_credentials.clone(),
                })
                .await?;
            log_skipped_user_venice_key(ActionSlug::ImageGenerate, &params.user_id, &params.model);
            return Ok(ImageGenerateOutput {
                image,
                receipt: zero_receipt(),
            });
        }
        let authorization = authorize_or_deny(AuthorizeParams {
            os_accounts: self.os_accounts.as_ref(),
            user_id: params.user_id.clone(),
            action: ActionSlug::ImageGenerate,
            estimate,
            hold_ttl_seconds: self.hold_ttl_seconds,
        })
        .await?;
        // A failed/rejected generation returns the error WITHOUT charging; the
        // wallet hold simply expires (same as the web and agent chat paths).
        let image = self
            .generator
            .generate(ImageGenerationRequest {
                prompt: params.prompt.clone(),
                model: ModelId(params.model.clone()),
                width: params.width,
                height: params.height,
                provider_credentials: params.provider_credentials.clone(),
            })
            .await?;
        let charge_credits = clamp_to_cap(estimate, authorization.cap_credits);
        let receipt = charge(ChargeParams {
            os_accounts: self.os_accounts.as_ref(),
            action_token: authorization.action_token,
            credits: charge_credits,
            idempotency_key: self.idempotency_key(&params),
        })
        .await?;
        log_settled(
            ActionSlug::ImageGenerate,
            &params.user_id,
            &params.model,
            &receipt,
        );
        Ok(ImageGenerateOutput { image, receipt })
    }

    /// Each successful generation gets a distinct charge key from the
    /// per-process sequence, so a repeat can never replay a prior settlement to
    /// bill zero. A transport-level retry of THIS one charge reuses the same
    /// computed key (it is built once per `generate` call) and so still dedups.
    /// The request shape is hashed in for traceability.
    fn idempotency_key(&self, params: &ImageGenerateParams) -> String {
        format!(
            "image_generate:{}:{}:{}",
            params.user_id.0,
            self.seq.fetch_add(1, Ordering::Relaxed),
            sha256_hex(image_shape(params).as_bytes())
        )
    }
}

/// A canonical string for everything that shapes an image, hashed into the
/// idempotency key. `serde_json` sorts object keys, so the encoding is
/// deterministic across calls.
fn image_shape(params: &ImageGenerateParams) -> String {
    serde_json::json!({
        "prompt": params.prompt,
        "model": params.model,
        "width": params.width,
        "height": params.height,
    })
    .to_string()
}

#[derive(Clone, Debug)]
pub struct ImageGenerateParams {
    pub user_id: UserId,
    pub prompt: String,
    pub model: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub provider_credentials: ProviderCredentials,
}

#[derive(Clone, Debug)]
pub struct ImageGenerateOutput {
    pub image: GeneratedImage,
    pub receipt: Receipt,
}

#[cfg(test)]
mod tests {
    use super::{ImageGenerateParams, ImageModelPrice, ImageService, ImageServiceDeps};
    use async_trait::async_trait;
    use june_config::ModelProvider;
    use june_domain::{
        Authorization, AuthorizeRequest, ChargeRequest, DomainError, GeneratedImage,
        ImageGenerationRequest, ImageGenerator, OsAccountsClient, ProviderCredentials, Receipt,
        UserId,
    };
    use pretty_assertions::assert_eq;
    use std::{
        collections::BTreeMap,
        sync::{Arc, Mutex},
    };

    #[derive(Clone, Debug, Eq, PartialEq)]
    enum Call {
        Authorize {
            action: String,
            estimate: u64,
        },
        Charge {
            credits: u64,
            idempotency_key: String,
        },
    }

    struct RecordingOsAccounts {
        allow: bool,
        events: Mutex<Vec<Call>>,
    }

    impl RecordingOsAccounts {
        fn new(allow: bool) -> Self {
            Self {
                allow,
                events: Mutex::new(Vec::new()),
            }
        }

        fn events(&self) -> Vec<Call> {
            self.events.lock().map(|e| e.clone()).unwrap_or_default()
        }
    }

    #[async_trait]
    impl OsAccountsClient for RecordingOsAccounts {
        async fn authorize(&self, request: AuthorizeRequest) -> Result<Authorization, DomainError> {
            if let Ok(mut events) = self.events.lock() {
                events.push(Call::Authorize {
                    action: request.action.to_string(),
                    estimate: request.estimate.0,
                });
            }
            Ok(Authorization {
                allowed: self.allow,
                action_token: self.allow.then(|| "agt_test".to_string()),
                cap_credits: self.allow.then_some(request.estimate),
                reason: (!self.allow).then(|| "insufficient_available_balance".to_string()),
            })
        }

        async fn charge(&self, request: ChargeRequest) -> Result<Receipt, DomainError> {
            if let Ok(mut events) = self.events.lock() {
                events.push(Call::Charge {
                    credits: request.credits.0,
                    idempotency_key: request.idempotency_key,
                });
            }
            Ok(Receipt {
                credits_charged: request.credits,
                idempotent_replay: false,
            })
        }
    }

    struct FixedGenerator;

    #[async_trait]
    impl ImageGenerator for FixedGenerator {
        async fn generate(
            &self,
            request: ImageGenerationRequest,
        ) -> Result<GeneratedImage, DomainError> {
            Ok(GeneratedImage {
                image_base64: "aGVsbG8=".to_string(),
                mime_type: "image/png".to_string(),
                model: request.model.0,
                provider: "venice".to_string(),
            })
        }
    }

    struct FailingGenerator;

    #[async_trait]
    impl ImageGenerator for FailingGenerator {
        async fn generate(
            &self,
            _request: ImageGenerationRequest,
        ) -> Result<GeneratedImage, DomainError> {
            Err(DomainError::UpstreamProvider)
        }
    }

    fn service(
        os_accounts: Arc<RecordingOsAccounts>,
        generator: Arc<dyn ImageGenerator>,
    ) -> ImageService {
        ImageService::new(ImageServiceDeps {
            os_accounts,
            generator,
            pricing: BTreeMap::from([("venice-sd35".to_string(), ImageModelPrice::venice(20))]),
            hold_ttl_seconds: 60,
        })
    }

    fn params(model: &str) -> ImageGenerateParams {
        ImageGenerateParams {
            user_id: UserId("usr_1".to_string()),
            prompt: "a cat".to_string(),
            model: model.to_string(),
            width: None,
            height: None,
            provider_credentials: ProviderCredentials::default(),
        }
    }

    #[tokio::test]
    async fn authorizes_then_charges_the_flat_model_price() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let output = service(os_accounts.clone(), Arc::new(FixedGenerator))
            .generate(params("venice-sd35"))
            .await
            .expect("generation succeeds");

        assert_eq!(output.receipt.credits_charged.0, 20);
        let events = os_accounts.events();
        assert_eq!(
            events[0],
            Call::Authorize {
                action: "image_generate".to_string(),
                estimate: 20,
            }
        );
        match &events[1] {
            Call::Charge {
                credits,
                idempotency_key,
            } => {
                assert_eq!(*credits, 20);
                // Key is `image_generate:<user>:<seq>:<64-hex shape digest>`.
                let rest = idempotency_key
                    .strip_prefix("image_generate:usr_1:")
                    .expect("key has the expected prefix");
                let (seq, digest) = rest.split_once(':').expect("seq:digest");
                assert!(seq.chars().all(|ch| ch.is_ascii_digit()));
                assert_eq!(digest.len(), 64);
                assert!(digest.chars().all(|ch| ch.is_ascii_hexdigit()));
            }
            Call::Authorize { .. } => panic!("expected a charge, got an authorize"),
        }
    }

    #[tokio::test]
    async fn unpriced_model_is_rejected_before_any_wallet_call() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let result = service(os_accounts.clone(), Arc::new(FixedGenerator))
            .generate(params("some-unlisted-model"))
            .await;

        assert!(matches!(result, Err(crate::ServiceError::ModelNotPriced)));
        // Never authorized or charged.
        assert!(os_accounts.events().is_empty());
    }

    #[tokio::test]
    async fn insufficient_balance_denial_does_not_generate_or_charge() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(false));
        let result = service(os_accounts.clone(), Arc::new(FixedGenerator))
            .generate(params("venice-sd35"))
            .await;

        assert!(matches!(
            result,
            Err(crate::ServiceError::InsufficientCredits)
        ));
        // Authorized (denied), never charged.
        assert_eq!(
            os_accounts.events(),
            vec![Call::Authorize {
                action: "image_generate".to_string(),
                estimate: 20,
            }]
        );
    }

    #[tokio::test]
    async fn failed_generation_authorizes_but_never_charges() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let result = service(os_accounts.clone(), Arc::new(FailingGenerator))
            .generate(params("venice-sd35"))
            .await;

        assert!(matches!(result, Err(crate::ServiceError::UpstreamProvider)));
        assert_eq!(
            os_accounts.events(),
            vec![Call::Authorize {
                action: "image_generate".to_string(),
                estimate: 20,
            }]
        );
    }

    #[tokio::test]
    async fn user_venice_key_generates_without_wallet_authorize_or_charge() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let mut params = params("venice-sd35");
        params.provider_credentials = ProviderCredentials {
            venice_api_key: Some("vc_user_key".to_string()),
        };
        let output = service(os_accounts.clone(), Arc::new(FixedGenerator))
            .generate(params)
            .await
            .expect("generation succeeds");

        assert_eq!(output.receipt.credits_charged.0, 0);
        assert!(os_accounts.events().is_empty());
    }

    #[tokio::test]
    async fn user_venice_key_does_not_skip_non_venice_image_model_metering() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let service = ImageService::new(ImageServiceDeps {
            os_accounts: os_accounts.clone(),
            generator: Arc::new(FixedGenerator),
            pricing: BTreeMap::from([(
                "openai-image".to_string(),
                ImageModelPrice {
                    credits: 20,
                    provider: ModelProvider::Openai,
                },
            )]),
            hold_ttl_seconds: 60,
        });
        let mut params = params("openai-image");
        params.provider_credentials = ProviderCredentials {
            venice_api_key: Some("vc_user_key".to_string()),
        };
        let output = service.generate(params).await.expect("generation succeeds");

        assert_eq!(output.receipt.credits_charged.0, 20);
        assert_eq!(
            os_accounts.events()[0],
            Call::Authorize {
                action: "image_generate".to_string(),
                estimate: 20,
            }
        );
    }

    #[tokio::test]
    async fn each_generation_uses_a_distinct_charge_key() {
        // Two generations must settle as two distinct charges (generate twice =
        // charge twice) — a repeat can never replay the first to bill zero.
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let service = service(os_accounts.clone(), Arc::new(FixedGenerator));
        for _ in 0..2 {
            service
                .generate(params("venice-sd35"))
                .await
                .expect("generation succeeds");
        }
        let charge_keys = os_accounts
            .events()
            .into_iter()
            .filter_map(|call| match call {
                Call::Charge {
                    idempotency_key, ..
                } => Some(idempotency_key),
                Call::Authorize { .. } => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(charge_keys.len(), 2);
        assert_ne!(charge_keys[0], charge_keys[1]);
    }
}
