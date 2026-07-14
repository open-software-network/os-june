use crate::{
    charge_flow::{
        AuthorizeParams, ChargeParams, ReleaseHoldParams, authorize_or_deny, charge, clamp_to_cap,
        log_settled, new_charge_operation_id, release_hold, zero_receipt,
    },
    error::ServiceError,
    metering::{log_skipped_user_venice_key, uses_user_venice_key},
    util::sha256_hex,
};
use june_config::ModelProvider;
use june_domain::{
    ActionSlug, Credits, GeneratedImage, ImageEditRequest, ImageEditor, ImageGenerationRequest,
    ImageGenerator, ModelId, OsAccountsClient, ProviderCredentials, Receipt, UserId,
};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex as StdMutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Notify;

/// Metered image generation. Each generation is flat-priced per model (Venice
/// bills per image), so the authorize estimate and the settled charge are the
/// same configured credit amount rather than a usage-derived figure. A model
/// with no configured price is rejected before the wallet or Venice is touched;
/// a failed or rejected generation returns the error WITHOUT charging (the hold
/// simply expires), matching the web and agent chat paths.
pub struct ImageServiceDeps {
    pub os_accounts: Arc<dyn OsAccountsClient>,
    pub generator: Arc<dyn ImageGenerator>,
    pub editor: Arc<dyn ImageEditor>,
    /// Flat price and upstream provider per image model. A model absent here
    /// is rejected as `model_not_priced`.
    pub pricing: BTreeMap<String, ImageModelPrice>,
    /// Flat price and upstream provider per EDITED image, keyed by edit model
    /// id (a separate catalog). A model absent here is rejected as
    /// `model_not_priced`.
    pub edit_pricing: BTreeMap<String, ImageModelPrice>,
    /// Edit model used when an edit request names none (the image MCP never
    /// does). Must be a key in `edit_pricing`.
    pub default_edit_model: String,
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
    editor: Arc<dyn ImageEditor>,
    pricing: BTreeMap<String, ImageModelPrice>,
    edit_pricing: BTreeMap<String, ImageModelPrice>,
    default_edit_model: String,
    hold_ttl_seconds: u64,
    request_ledger: ImageRequestLedger,
}

impl ImageService {
    pub fn new(deps: ImageServiceDeps) -> Self {
        Self {
            os_accounts: deps.os_accounts,
            generator: deps.generator,
            editor: deps.editor,
            pricing: deps.pricing,
            edit_pricing: deps.edit_pricing,
            default_edit_model: deps.default_edit_model,
            hold_ttl_seconds: deps.hold_ttl_seconds,
            request_ledger: ImageRequestLedger::new(Duration::from_secs(deps.hold_ttl_seconds)),
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
        let uses_user_key = price.provider == ModelProvider::Venice
            && uses_user_venice_key(&params.provider_credentials);
        if let Some(key) = image_ledger_key(&params) {
            match self.request_ledger.claim(key).await {
                ImageLedgerClaim::Replay(output) => return Ok(output),
                ImageLedgerClaim::ChargePending { key, pending } => {
                    return self.settle_pending_ledger_charge(key, pending).await;
                }
                ImageLedgerClaim::Run { guard } => {
                    if uses_user_key {
                        return Self::finish_claimed_output(
                            guard,
                            self.generate_with_user_venice_key(&params).await,
                        );
                    }
                    return self
                        .finish_claimed_charge(
                            guard,
                            self.prepare_generate_charge(&params, estimate).await,
                        )
                        .await;
                }
            }
        }
        if uses_user_key {
            return self.generate_with_user_venice_key(&params).await;
        }
        let pending = self.prepare_generate_charge(&params, estimate).await?;
        self.settle_pending_charge_cancellation_safe(None, pending)
            .await
    }

    async fn generate_with_user_venice_key(
        &self,
        params: &ImageGenerateParams,
    ) -> Result<ImageGenerateOutput, ServiceError> {
        let image = self
            .generator
            .generate(ImageGenerationRequest {
                prompt: params.prompt.clone(),
                model: ModelId(params.model.clone()),
                width: params.width,
                height: params.height,
                safe_mode: params.safe_mode,
                provider_credentials: params.provider_credentials.clone(),
            })
            .await?;
        log_skipped_user_venice_key(ActionSlug::ImageGenerate, &params.user_id, &params.model);
        Ok(ImageGenerateOutput {
            image,
            receipt: zero_receipt(),
        })
    }

    async fn prepare_generate_charge(
        &self,
        params: &ImageGenerateParams,
        estimate: Credits,
    ) -> Result<PendingImageCharge, ServiceError> {
        let authorization = authorize_or_deny(AuthorizeParams {
            os_accounts: self.os_accounts.as_ref(),
            user_id: params.user_id.clone(),
            action: ActionSlug::ImageGenerate,
            estimate,
            hold_ttl_seconds: self.hold_ttl_seconds,
        })
        .await?;
        let charge_created_at = Instant::now();
        let operation_id = new_charge_operation_id();
        // A failed/rejected generation returns the error WITHOUT charging; the
        // wallet hold is released so it stops counting against the user's
        // concurrency cap (same as the web and agent chat paths).
        let image = match self
            .generator
            .generate(ImageGenerationRequest {
                prompt: params.prompt.clone(),
                model: ModelId(params.model.clone()),
                width: params.width,
                height: params.height,
                safe_mode: params.safe_mode,
                provider_credentials: params.provider_credentials.clone(),
            })
            .await
        {
            Ok(image) => image,
            Err(error) => {
                release_hold(ReleaseHoldParams {
                    os_accounts: self.os_accounts.as_ref(),
                    action: ActionSlug::ImageGenerate,
                    action_token: authorization.action_token,
                })
                .await;
                return Err(error.into());
            }
        };
        let charge_credits = clamp_to_cap(estimate, authorization.cap_credits);
        Ok(PendingImageCharge {
            action: ActionSlug::ImageGenerate,
            user_id: params.user_id.clone(),
            model: params.model.clone(),
            image,
            action_token: authorization.action_token,
            credits: charge_credits,
            idempotency_key: Self::idempotency_key(params, &operation_id),
            created_at: charge_created_at,
        })
    }

    /// Metered image edit, mirroring `generate`: resolve the edit
    /// model (requests name none, so the default governs), reject an unpriced
    /// model before any wallet/Venice call, authorize a hold, edit, then charge
    /// the flat edit price under a unique key. A failed/rejected edit returns the
    /// error WITHOUT charging (the hold is released).
    pub async fn edit(&self, params: ImageEditParams) -> Result<ImageGenerateOutput, ServiceError> {
        let model = params
            .model
            .clone()
            .filter(|model| !model.trim().is_empty())
            .unwrap_or_else(|| self.default_edit_model.clone());
        let price = self
            .edit_pricing
            .get(&model)
            .copied()
            .ok_or(ServiceError::ModelNotPriced)?;
        let estimate = Credits(price.credits);
        let uses_user_key = price.provider == ModelProvider::Venice
            && uses_user_venice_key(&params.provider_credentials);
        if let Some(key) = edit_ledger_key(&params, &model) {
            match self.request_ledger.claim(key).await {
                ImageLedgerClaim::Replay(output) => return Ok(output),
                ImageLedgerClaim::ChargePending { key, pending } => {
                    return self.settle_pending_ledger_charge(key, pending).await;
                }
                ImageLedgerClaim::Run { guard } => {
                    if uses_user_key {
                        return Self::finish_claimed_output(
                            guard,
                            self.edit_with_user_venice_key(&params, &model).await,
                        );
                    }
                    return self
                        .finish_claimed_charge(
                            guard,
                            self.prepare_edit_charge(&params, &model, estimate).await,
                        )
                        .await;
                }
            }
        }
        if uses_user_key {
            return self.edit_with_user_venice_key(&params, &model).await;
        }
        let pending = self.prepare_edit_charge(&params, &model, estimate).await?;
        self.settle_pending_charge_cancellation_safe(None, pending)
            .await
    }

    async fn edit_with_user_venice_key(
        &self,
        params: &ImageEditParams,
        model: &str,
    ) -> Result<ImageGenerateOutput, ServiceError> {
        let image = self
            .editor
            .edit(ImageEditRequest {
                image_base64: params.image_base64.clone(),
                mime_type: params.mime_type.clone(),
                prompt: params.prompt.clone(),
                model: ModelId(model.to_string()),
                safe_mode: params.safe_mode,
                provider_credentials: params.provider_credentials.clone(),
            })
            .await?;
        log_skipped_user_venice_key(ActionSlug::ImageEdit, &params.user_id, model);
        Ok(ImageGenerateOutput {
            image,
            receipt: zero_receipt(),
        })
    }

    async fn prepare_edit_charge(
        &self,
        params: &ImageEditParams,
        model: &str,
        estimate: Credits,
    ) -> Result<PendingImageCharge, ServiceError> {
        let authorization = authorize_or_deny(AuthorizeParams {
            os_accounts: self.os_accounts.as_ref(),
            user_id: params.user_id.clone(),
            action: ActionSlug::ImageEdit,
            estimate,
            hold_ttl_seconds: self.hold_ttl_seconds,
        })
        .await?;
        let charge_created_at = Instant::now();
        let operation_id = new_charge_operation_id();
        let image = match self
            .editor
            .edit(ImageEditRequest {
                image_base64: params.image_base64.clone(),
                mime_type: params.mime_type.clone(),
                prompt: params.prompt.clone(),
                model: ModelId(model.to_string()),
                safe_mode: params.safe_mode,
                provider_credentials: params.provider_credentials.clone(),
            })
            .await
        {
            Ok(image) => image,
            Err(error) => {
                release_hold(ReleaseHoldParams {
                    os_accounts: self.os_accounts.as_ref(),
                    action: ActionSlug::ImageEdit,
                    action_token: authorization.action_token,
                })
                .await;
                return Err(error.into());
            }
        };
        let charge_credits = clamp_to_cap(estimate, authorization.cap_credits);
        Ok(PendingImageCharge {
            action: ActionSlug::ImageEdit,
            user_id: params.user_id.clone(),
            model: model.to_string(),
            image,
            action_token: authorization.action_token,
            credits: charge_credits,
            idempotency_key: Self::edit_idempotency_key(params, model, &operation_id),
            created_at: charge_created_at,
        })
    }

    async fn finish_claimed_charge(
        &self,
        guard: ImageLedgerRun,
        pending: Result<PendingImageCharge, ServiceError>,
    ) -> Result<ImageGenerateOutput, ServiceError> {
        let pending = match pending {
            Ok(pending) => pending,
            Err(error) => {
                guard.fail();
                return Err(error);
            }
        };
        let pending_key = guard.start_settling(&pending);
        self.settle_pending_charge_cancellation_safe(pending_key, pending)
            .await
    }

    fn finish_claimed_output(
        guard: ImageLedgerRun,
        output: Result<ImageGenerateOutput, ServiceError>,
    ) -> Result<ImageGenerateOutput, ServiceError> {
        match output {
            Ok(output) => {
                guard.complete(output.clone());
                Ok(output)
            }
            Err(error) => {
                guard.fail();
                Err(error)
            }
        }
    }

    async fn settle_pending_ledger_charge(
        &self,
        key: String,
        pending: PendingImageCharge,
    ) -> Result<ImageGenerateOutput, ServiceError> {
        let mut key = key;
        let mut pending = pending;
        loop {
            if self
                .request_ledger
                .start_settling_pending(key.clone(), &pending)
            {
                return self
                    .settle_pending_charge_cancellation_safe(Some(key), pending)
                    .await;
            }
            match self.request_ledger.claim(key.clone()).await {
                ImageLedgerClaim::Replay(output) => return Ok(output),
                ImageLedgerClaim::ChargePending {
                    key: next_key,
                    pending: next_pending,
                } => {
                    key = next_key;
                    pending = next_pending;
                }
                ImageLedgerClaim::Run { guard } => {
                    guard.fail();
                    return Err(ServiceError::MeteringProvider);
                }
            }
        }
    }

    async fn settle_pending_charge_cancellation_safe(
        &self,
        key: Option<String>,
        pending: PendingImageCharge,
    ) -> Result<ImageGenerateOutput, ServiceError> {
        let handle = spawn_pending_charge_settlement(
            self.os_accounts.clone(),
            self.request_ledger.clone(),
            key,
            pending,
        );
        match handle.await {
            Ok(result) => result,
            Err(error) => {
                tracing::warn!(%error, "image settlement task failed");
                Err(ServiceError::MeteringProvider)
            }
        }
    }

    async fn settle_pending_charge_with(
        os_accounts: Arc<dyn OsAccountsClient>,
        pending: &PendingImageCharge,
    ) -> Result<ImageGenerateOutput, ServiceError> {
        let receipt = charge(ChargeParams {
            os_accounts: os_accounts.as_ref(),
            action_token: pending.action_token.clone(),
            credits: pending.credits,
            idempotency_key: pending.idempotency_key.clone(),
        })
        .await?;
        log_settled(pending.action, &pending.user_id, &pending.model, &receipt);
        Ok(ImageGenerateOutput {
            image: pending.image.clone(),
            receipt,
        })
    }

    /// Each paid image attempt gets a globally unique settlement scope. The
    /// request ledger absorbs same-request retries before they reach Venice;
    /// keeping the settlement key attempt-unique preserves the invariant that
    /// fresh upstream work after a process restart never replays an old charge.
    fn idempotency_key(params: &ImageGenerateParams, operation_id: &str) -> String {
        format!(
            "image_generate:{}:attempt:{}:{}",
            params.user_id.0,
            operation_id,
            sha256_hex(image_shape(params).as_bytes())
        )
    }

    /// Edit counterpart of [`Self::idempotency_key`].
    fn edit_idempotency_key(params: &ImageEditParams, model: &str, operation_id: &str) -> String {
        format!(
            "image_edit:{}:attempt:{}:{}",
            params.user_id.0,
            operation_id,
            sha256_hex(edit_shape(params, model).as_bytes())
        )
    }
}

fn spawn_pending_charge_settlement(
    os_accounts: Arc<dyn OsAccountsClient>,
    ledger: ImageRequestLedger,
    key: Option<String>,
    pending: PendingImageCharge,
) -> tokio::task::JoinHandle<Result<ImageGenerateOutput, ServiceError>> {
    tokio::spawn(async move {
        let result = ImageService::settle_pending_charge_with(os_accounts, &pending).await;
        if let Some(key) = key {
            match &result {
                Ok(output) => ledger.complete_pending(key, output.clone()),
                Err(_) => ledger.settlement_failed(key, pending.clone()),
            }
        }
        result
    })
}

#[derive(Clone)]
struct PendingImageCharge {
    action: ActionSlug,
    user_id: UserId,
    model: String,
    image: GeneratedImage,
    action_token: String,
    credits: Credits,
    idempotency_key: String,
    created_at: Instant,
}

/// Settled replays are kept only briefly: each entry pins a full base64 image
/// in memory, so an unbounded ledger would grow by megabytes per generation
/// for the life of the process. Duplicate request ids only arise from
/// short-lived client retries, so a short window plus a hard cap bounds memory
/// without weakening the replay guarantee in practice.
///
/// KNOWN BOUNDARY: this ledger is per-process memory, so its retry guarantee
/// does not survive a June API restart, a replay eviction, or (hypothetically)
/// a multi-instance deployment. A client retrying a dropped response across
/// one of those events re-runs the provider and settles under a fresh charge
/// key - a duplicate charge. Exactly-once billing across restarts requires
/// durable request state, which this stateless service does not have; the
/// exposure is bounded by the MCP's short transport-retry window and flat
/// per-image prices. Accepted for now - see the follow-up issue linked in
/// PR #584 before "fixing" this by deriving charge keys from the request id
/// (that reintroduces the replay-funded free-work hole this design closed).
const IMAGE_LEDGER_REPLAY_TTL: Duration = Duration::from_mins(10);
const IMAGE_LEDGER_IN_FLIGHT_TTL: Duration = Duration::from_mins(15);
const IMAGE_LEDGER_MAX_SETTLED: usize = 32;
const IMAGE_LEDGER_MAX_PENDING_PER_USER: usize = IMAGE_LEDGER_MAX_SETTLED;
const IMAGE_LEDGER_MAX_PENDING_GLOBAL: usize = IMAGE_LEDGER_MAX_PENDING_PER_USER * 4;

#[derive(Clone)]
struct ImageRequestLedger {
    inner: Arc<ImageRequestLedgerInner>,
    pending_ttl: Duration,
}

#[derive(Default)]
struct ImageRequestLedgerInner {
    entries: StdMutex<BTreeMap<String, ImageLedgerEntry>>,
    next_owner: AtomicU64,
}

enum ImageLedgerEntry {
    InFlight {
        notify: Arc<Notify>,
        started_at: Instant,
        owner: u64,
    },
    ChargePending {
        pending: PendingImageCharge,
        created_at: Instant,
    },
    Settling {
        notify: Arc<Notify>,
        user_id: UserId,
        created_at: Instant,
    },
    Complete {
        output: ImageGenerateOutput,
        settled_at: Instant,
    },
}

enum ImageLedgerClaim {
    Replay(ImageGenerateOutput),
    ChargePending {
        key: String,
        pending: PendingImageCharge,
    },
    Run {
        guard: ImageLedgerRun,
    },
}

struct ImageLedgerRun {
    ledger: ImageRequestLedger,
    key: Option<String>,
    owner: u64,
}

impl ImageLedgerRun {
    #[cfg(test)]
    fn charge_pending(mut self, pending: PendingImageCharge) -> Option<String> {
        if let Some(key) = self.key.take()
            && self.ledger.charge_pending(key.clone(), self.owner, pending)
        {
            return Some(key);
        }
        None
    }

    fn start_settling(mut self, pending: &PendingImageCharge) -> Option<String> {
        if let Some(key) = self.key.take()
            && self
                .ledger
                .start_settling_in_flight(key.clone(), self.owner, pending)
        {
            return Some(key);
        }
        None
    }

    fn complete(mut self, output: ImageGenerateOutput) {
        if let Some(key) = self.key.take() {
            self.ledger.complete_in_flight(key, self.owner, output);
        }
    }

    fn fail(mut self) {
        if let Some(key) = self.key.take() {
            self.ledger.remove_in_flight(&key, self.owner);
        }
    }
}

impl Drop for ImageLedgerRun {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.ledger.remove_in_flight(&key, self.owner);
        }
    }
}

impl ImageRequestLedger {
    fn new(pending_ttl: Duration) -> Self {
        Self {
            inner: Arc::new(ImageRequestLedgerInner::default()),
            pending_ttl,
        }
    }

    async fn claim(&self, key: String) -> ImageLedgerClaim {
        loop {
            let notified = {
                let mut entries = self.entries();
                prune_expired_entries(&mut entries, Instant::now(), self.pending_ttl);
                match entries.get(&key) {
                    Some(ImageLedgerEntry::Complete { output, .. }) => {
                        return ImageLedgerClaim::Replay(output.clone());
                    }
                    Some(ImageLedgerEntry::ChargePending { pending, .. }) => {
                        return ImageLedgerClaim::ChargePending {
                            key: key.clone(),
                            pending: pending.clone(),
                        };
                    }
                    Some(
                        ImageLedgerEntry::InFlight { notify, .. }
                        | ImageLedgerEntry::Settling { notify, .. },
                    ) => notify.clone().notified_owned(),
                    None => {
                        let owner = self.inner.next_owner.fetch_add(1, Ordering::Relaxed);
                        entries.insert(
                            key.clone(),
                            ImageLedgerEntry::InFlight {
                                notify: Arc::new(Notify::new()),
                                started_at: Instant::now(),
                                owner,
                            },
                        );
                        return ImageLedgerClaim::Run {
                            guard: ImageLedgerRun {
                                ledger: self.clone(),
                                key: Some(key),
                                owner,
                            },
                        };
                    }
                }
            };
            notified.await;
        }
    }

    #[cfg(test)]
    fn charge_pending(&self, key: String, owner: u64, pending: PendingImageCharge) -> bool {
        let notify = {
            let mut entries = self.entries();
            let notify = match entries.get(&key) {
                Some(ImageLedgerEntry::InFlight {
                    notify,
                    owner: current_owner,
                    ..
                }) if *current_owner == owner => Some(notify.clone()),
                Some(
                    ImageLedgerEntry::InFlight { .. }
                    | ImageLedgerEntry::ChargePending { .. }
                    | ImageLedgerEntry::Settling { .. }
                    | ImageLedgerEntry::Complete { .. },
                )
                | None => None,
            };
            if notify.is_some() {
                let user_id = pending.user_id.clone();
                entries.insert(
                    key,
                    ImageLedgerEntry::ChargePending {
                        created_at: pending.created_at,
                        pending,
                    },
                );
                evict_over_pending_cap(&mut entries, &user_id);
            }
            notify
        };
        if let Some(notify) = notify {
            notify.notify_waiters();
            return true;
        }
        false
    }

    fn start_settling_in_flight(
        &self,
        key: String,
        owner: u64,
        pending: &PendingImageCharge,
    ) -> bool {
        let notify = {
            let mut entries = self.entries();
            let notify = match entries.get(&key) {
                Some(ImageLedgerEntry::InFlight {
                    notify,
                    owner: current_owner,
                    ..
                }) if *current_owner == owner => Some(notify.clone()),
                Some(
                    ImageLedgerEntry::InFlight { .. }
                    | ImageLedgerEntry::ChargePending { .. }
                    | ImageLedgerEntry::Settling { .. }
                    | ImageLedgerEntry::Complete { .. },
                )
                | None => None,
            };
            if notify.is_some() {
                entries.insert(
                    key,
                    ImageLedgerEntry::Settling {
                        notify: Arc::new(Notify::new()),
                        user_id: pending.user_id.clone(),
                        created_at: pending.created_at,
                    },
                );
                evict_over_pending_cap(&mut entries, &pending.user_id);
            }
            notify
        };
        if let Some(notify) = notify {
            notify.notify_waiters();
            return true;
        }
        false
    }

    fn start_settling_pending(&self, key: String, pending: &PendingImageCharge) -> bool {
        let mut entries = self.entries();
        if matches!(
            entries.get(&key),
            Some(ImageLedgerEntry::ChargePending { .. })
        ) {
            entries.insert(
                key,
                ImageLedgerEntry::Settling {
                    notify: Arc::new(Notify::new()),
                    user_id: pending.user_id.clone(),
                    created_at: pending.created_at,
                },
            );
            evict_over_pending_cap(&mut entries, &pending.user_id);
            return true;
        }
        false
    }

    fn complete_in_flight(&self, key: String, owner: u64, output: ImageGenerateOutput) {
        let notify = {
            let mut entries = self.entries();
            match entries.get(&key) {
                Some(ImageLedgerEntry::InFlight {
                    notify,
                    owner: current_owner,
                    ..
                }) if *current_owner == owner => {
                    let notify = notify.clone();
                    entries.insert(
                        key,
                        ImageLedgerEntry::Complete {
                            output,
                            settled_at: Instant::now(),
                        },
                    );
                    evict_over_replay_cap(&mut entries);
                    Some(notify)
                }
                Some(
                    ImageLedgerEntry::InFlight { .. }
                    | ImageLedgerEntry::ChargePending { .. }
                    | ImageLedgerEntry::Settling { .. }
                    | ImageLedgerEntry::Complete { .. },
                )
                | None => None,
            }
        };
        if let Some(notify) = notify {
            notify.notify_waiters();
        }
    }

    fn complete_pending(&self, key: String, output: ImageGenerateOutput) {
        let notify = {
            let mut entries = self.entries();
            match entries.get(&key) {
                Some(ImageLedgerEntry::ChargePending { .. }) => {
                    entries.insert(
                        key,
                        ImageLedgerEntry::Complete {
                            output,
                            settled_at: Instant::now(),
                        },
                    );
                    evict_over_replay_cap(&mut entries);
                    None
                }
                Some(ImageLedgerEntry::Settling { notify, .. }) => {
                    let notify = notify.clone();
                    entries.insert(
                        key,
                        ImageLedgerEntry::Complete {
                            output,
                            settled_at: Instant::now(),
                        },
                    );
                    evict_over_replay_cap(&mut entries);
                    Some(notify)
                }
                Some(ImageLedgerEntry::InFlight { .. } | ImageLedgerEntry::Complete { .. })
                | None => None,
            }
        };
        if let Some(notify) = notify {
            notify.notify_waiters();
        }
    }

    fn settlement_failed(&self, key: String, pending: PendingImageCharge) {
        let notify = {
            let mut entries = self.entries();
            match entries.get(&key) {
                Some(ImageLedgerEntry::Settling { notify, .. }) => {
                    let notify = notify.clone();
                    let user_id = pending.user_id.clone();
                    entries.insert(
                        key,
                        ImageLedgerEntry::ChargePending {
                            created_at: pending.created_at,
                            pending,
                        },
                    );
                    evict_over_pending_cap(&mut entries, &user_id);
                    Some(notify)
                }
                Some(
                    ImageLedgerEntry::InFlight { .. }
                    | ImageLedgerEntry::ChargePending { .. }
                    | ImageLedgerEntry::Complete { .. },
                )
                | None => None,
            }
        };
        if let Some(notify) = notify {
            notify.notify_waiters();
        }
    }

    fn remove_in_flight(&self, key: &str, owner: u64) {
        let notify = {
            let mut entries = self.entries();
            match entries.get(key) {
                Some(ImageLedgerEntry::InFlight {
                    notify,
                    owner: current_owner,
                    ..
                }) if *current_owner == owner => {
                    let notify = notify.clone();
                    entries.remove(key);
                    Some(notify)
                }
                Some(
                    ImageLedgerEntry::InFlight { .. }
                    | ImageLedgerEntry::ChargePending { .. }
                    | ImageLedgerEntry::Settling { .. }
                    | ImageLedgerEntry::Complete { .. },
                )
                | None => None,
            }
        };
        if let Some(notify) = notify {
            notify.notify_waiters();
        }
    }

    fn entries(&self) -> MutexGuard<'_, BTreeMap<String, ImageLedgerEntry>> {
        match self.inner.entries.lock() {
            Ok(entries) => entries,
            Err(poisoned) => {
                tracing::warn!("image request ledger mutex was poisoned");
                poisoned.into_inner()
            }
        }
    }
}

fn prune_expired_entries(
    entries: &mut BTreeMap<String, ImageLedgerEntry>,
    now: Instant,
    pending_ttl: Duration,
) {
    entries.retain(|_, entry| match entry {
        ImageLedgerEntry::InFlight {
            notify, started_at, ..
        } => {
            let keep = now.saturating_duration_since(*started_at) < IMAGE_LEDGER_IN_FLIGHT_TTL;
            if !keep {
                notify.notify_waiters();
            }
            keep
        }
        ImageLedgerEntry::ChargePending { created_at, .. } => {
            now.saturating_duration_since(*created_at) < pending_ttl
        }
        ImageLedgerEntry::Settling {
            notify, created_at, ..
        } => {
            let keep = now.saturating_duration_since(*created_at) < pending_ttl;
            if !keep {
                notify.notify_waiters();
            }
            keep
        }
        ImageLedgerEntry::Complete { settled_at, .. } => {
            now.saturating_duration_since(*settled_at) < IMAGE_LEDGER_REPLAY_TTL
        }
    });
}

fn evict_over_replay_cap(entries: &mut BTreeMap<String, ImageLedgerEntry>) {
    loop {
        let settled: Vec<(String, Instant)> = entries
            .iter()
            .filter_map(|(key, entry)| match entry {
                ImageLedgerEntry::Complete { settled_at, .. } => Some((key.clone(), *settled_at)),
                ImageLedgerEntry::InFlight { .. }
                | ImageLedgerEntry::ChargePending { .. }
                | ImageLedgerEntry::Settling { .. } => None,
            })
            .collect();
        if settled.len() <= IMAGE_LEDGER_MAX_SETTLED {
            return;
        }
        let Some((oldest, _)) = settled
            .into_iter()
            .min_by_key(|(_, settled_at)| *settled_at)
        else {
            return;
        };
        entries.remove(&oldest);
    }
}

fn evict_over_pending_cap(
    entries: &mut BTreeMap<String, ImageLedgerEntry>,
    evicting_user: &UserId,
) {
    loop {
        let user_pending_count = entries
            .values()
            .filter(|entry| pending_entry_belongs_to_user(entry, evicting_user))
            .count();
        if user_pending_count <= IMAGE_LEDGER_MAX_PENDING_PER_USER {
            break;
        }
        let Some(evicted_key) = oldest_pending_entry_for_user(entries, evicting_user) else {
            break;
        };
        remove_ledger_entry(entries, &evicted_key);
    }

    loop {
        let pending_count = entries
            .values()
            .filter(|entry| pending_entry(entry))
            .count();
        if pending_count <= IMAGE_LEDGER_MAX_PENDING_GLOBAL {
            return;
        }
        let Some(evicted_key) = oldest_pending_entry(entries) else {
            return;
        };
        remove_ledger_entry(entries, &evicted_key);
    }
}

fn pending_entry(entry: &ImageLedgerEntry) -> bool {
    matches!(
        entry,
        ImageLedgerEntry::ChargePending { .. } | ImageLedgerEntry::Settling { .. }
    )
}

fn pending_entry_belongs_to_user(entry: &ImageLedgerEntry, user_id: &UserId) -> bool {
    match entry {
        ImageLedgerEntry::ChargePending { pending, .. } => &pending.user_id == user_id,
        ImageLedgerEntry::Settling {
            user_id: entry_user_id,
            ..
        } => entry_user_id == user_id,
        ImageLedgerEntry::InFlight { .. } | ImageLedgerEntry::Complete { .. } => false,
    }
}

fn oldest_pending_entry_for_user(
    entries: &BTreeMap<String, ImageLedgerEntry>,
    user_id: &UserId,
) -> Option<String> {
    oldest_matching_pending_entry(entries, |entry| {
        pending_entry_belongs_to_user(entry, user_id)
    })
}

fn oldest_pending_entry(entries: &BTreeMap<String, ImageLedgerEntry>) -> Option<String> {
    oldest_matching_pending_entry(entries, pending_entry)
}

fn oldest_matching_pending_entry(
    entries: &BTreeMap<String, ImageLedgerEntry>,
    matches_entry: impl Fn(&ImageLedgerEntry) -> bool,
) -> Option<String> {
    oldest_matching_charge_pending_entry(entries, &matches_entry)
        .or_else(|| oldest_matching_settling_entry(entries, &matches_entry))
}

fn oldest_matching_charge_pending_entry(
    entries: &BTreeMap<String, ImageLedgerEntry>,
    matches_entry: &impl Fn(&ImageLedgerEntry) -> bool,
) -> Option<String> {
    entries
        .iter()
        .filter_map(|(key, entry)| match entry {
            ImageLedgerEntry::ChargePending { created_at, .. } if matches_entry(entry) => {
                Some((key.clone(), *created_at))
            }
            ImageLedgerEntry::InFlight { .. }
            | ImageLedgerEntry::ChargePending { .. }
            | ImageLedgerEntry::Settling { .. }
            | ImageLedgerEntry::Complete { .. } => None,
        })
        .min_by_key(|(_, created_at)| *created_at)
        .map(|(key, _)| key)
}

fn oldest_matching_settling_entry(
    entries: &BTreeMap<String, ImageLedgerEntry>,
    matches_entry: &impl Fn(&ImageLedgerEntry) -> bool,
) -> Option<String> {
    entries
        .iter()
        .filter_map(|(key, entry)| match entry {
            ImageLedgerEntry::Settling { created_at, .. } if matches_entry(entry) => {
                Some((key.clone(), *created_at))
            }
            ImageLedgerEntry::InFlight { .. }
            | ImageLedgerEntry::ChargePending { .. }
            | ImageLedgerEntry::Settling { .. }
            | ImageLedgerEntry::Complete { .. } => None,
        })
        .min_by_key(|(_, created_at)| *created_at)
        .map(|(key, _)| key)
}

fn remove_ledger_entry(entries: &mut BTreeMap<String, ImageLedgerEntry>, key: &str) {
    if let Some(entry) = entries.remove(key) {
        notify_entry_removed(&entry);
    }
}

fn notify_entry_removed(entry: &ImageLedgerEntry) {
    match entry {
        ImageLedgerEntry::InFlight { notify, .. } | ImageLedgerEntry::Settling { notify, .. } => {
            notify.notify_waiters();
        }
        ImageLedgerEntry::ChargePending { .. } | ImageLedgerEntry::Complete { .. } => {}
    }
}

fn image_ledger_key(params: &ImageGenerateParams) -> Option<String> {
    params.request_id.as_ref().map(|request_id| {
        format!(
            "image_generate:{}:{}:{}",
            params.user_id.0,
            request_id,
            sha256_hex(image_shape(params).as_bytes())
        )
    })
}

fn edit_ledger_key(params: &ImageEditParams, model: &str) -> Option<String> {
    params.request_id.as_ref().map(|request_id| {
        format!(
            "image_edit:{}:{}:{}",
            params.user_id.0,
            request_id,
            sha256_hex(edit_shape(params, model).as_bytes())
        )
    })
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
        "safe_mode": params.safe_mode,
    })
    .to_string()
}

/// A canonical string for everything that shapes an edit, hashed into the
/// idempotency key. The source image is itself hashed (not embedded whole) to
/// keep the key small while still distinguishing different source images.
fn edit_shape(params: &ImageEditParams, model: &str) -> String {
    serde_json::json!({
        "prompt": params.prompt,
        "model": model,
        "image": sha256_hex(params.image_base64.as_bytes()),
        "mime_type": params.mime_type,
        "safe_mode": params.safe_mode,
    })
    .to_string()
}

#[derive(Clone, Debug)]
pub struct ImageGenerateParams {
    pub user_id: UserId,
    /// Stable per-call id used to replay a settled duplicate without rerunning
    /// upstream image work.
    pub request_id: Option<String>,
    pub prompt: String,
    pub model: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub safe_mode: Option<bool>,
    pub provider_credentials: ProviderCredentials,
}

#[derive(Clone, Debug)]
pub struct ImageEditParams {
    pub user_id: UserId,
    /// Stable per-call id used to replay a settled duplicate without rerunning
    /// upstream image work.
    pub request_id: Option<String>,
    /// Source image as raw base64 (no `data:` prefix).
    pub image_base64: String,
    pub mime_type: String,
    pub prompt: String,
    /// `None` uses the service's default edit model.
    pub model: Option<String>,
    pub safe_mode: Option<bool>,
    pub provider_credentials: ProviderCredentials,
}

#[derive(Clone, Debug)]
pub struct ImageGenerateOutput {
    pub image: GeneratedImage,
    pub receipt: Receipt,
}

#[cfg(test)]
mod tests {
    use super::{
        ImageEditParams, ImageGenerateParams, ImageModelPrice, ImageService, ImageServiceDeps,
    };
    use async_trait::async_trait;
    use june_config::{DEFAULT_IMAGE_HOLD_TTL_SECS, ModelProvider};
    use june_domain::{
        Authorization, AuthorizeRequest, ChargeRequest, DomainError, GeneratedImage,
        ImageEditRequest, ImageEditor, ImageGenerationRequest, ImageGenerator, OsAccountsClient,
        ProviderCredentials, Receipt, UserId,
    };
    use pretty_assertions::assert_eq;
    use std::{
        collections::{BTreeMap, BTreeSet},
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, AtomicU64, Ordering},
        },
        time::{Duration, Instant},
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

    #[derive(Clone, Debug, Eq, PartialEq)]
    enum TokenCall {
        Authorize { action_token: String },
        Charge { action_token: String },
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

    #[derive(Default)]
    struct ChargeFailsOnceOsAccounts {
        charge_failed: AtomicBool,
        events: Mutex<Vec<Call>>,
    }

    impl ChargeFailsOnceOsAccounts {
        fn events(&self) -> Vec<Call> {
            self.events.lock().map(|e| e.clone()).unwrap_or_default()
        }
    }

    #[derive(Default)]
    struct BlockingChargeOsAccounts {
        events: Mutex<Vec<Call>>,
        charge_started: tokio::sync::Notify,
        release_charge: tokio::sync::Notify,
    }

    impl BlockingChargeOsAccounts {
        fn events(&self) -> Vec<Call> {
            self.events.lock().map(|e| e.clone()).unwrap_or_default()
        }

        async fn wait_for_charge_started(&self) {
            self.charge_started.notified().await;
        }

        fn release_charge(&self) {
            self.release_charge.notify_waiters();
        }
    }

    #[derive(Default)]
    struct StaleTokenChargeFailsOsAccounts {
        next_token: AtomicU64,
        events: Mutex<Vec<TokenCall>>,
    }

    impl StaleTokenChargeFailsOsAccounts {
        fn events(&self) -> Vec<TokenCall> {
            self.events.lock().map(|e| e.clone()).unwrap_or_default()
        }
    }

    #[derive(Default)]
    struct ManualClock {
        now_seconds: AtomicU64,
    }

    impl ManualClock {
        fn now(&self) -> u64 {
            self.now_seconds.load(Ordering::SeqCst)
        }

        fn advance(&self, seconds: u64) {
            self.now_seconds.fetch_add(seconds, Ordering::SeqCst);
        }
    }

    #[derive(Default)]
    struct TtlExpiringOsAccounts {
        clock: Arc<ManualClock>,
        next_token: AtomicU64,
        expires_at_by_token: Mutex<BTreeMap<String, u64>>,
    }

    impl TtlExpiringOsAccounts {
        fn new(clock: Arc<ManualClock>) -> Self {
            Self {
                clock,
                next_token: AtomicU64::new(0),
                expires_at_by_token: Mutex::new(BTreeMap::new()),
            }
        }
    }

    #[async_trait]
    impl OsAccountsClient for StaleTokenChargeFailsOsAccounts {
        async fn authorize(&self, request: AuthorizeRequest) -> Result<Authorization, DomainError> {
            let token_number = self.next_token.fetch_add(1, Ordering::SeqCst) + 1;
            let token = format!("agt_{token_number}");
            if let Ok(mut events) = self.events.lock() {
                events.push(TokenCall::Authorize {
                    action_token: token.clone(),
                });
            }
            Ok(Authorization {
                allowed: true,
                action_token: Some(token),
                cap_credits: Some(request.estimate),
                reason: None,
            })
        }

        async fn charge(&self, request: ChargeRequest) -> Result<Receipt, DomainError> {
            if let Ok(mut events) = self.events.lock() {
                events.push(TokenCall::Charge {
                    action_token: request.action_token.clone(),
                });
            }
            if request.action_token == "agt_1" {
                return Err(DomainError::MeteringProvider);
            }
            Ok(Receipt {
                credits_charged: request.credits,
                idempotent_replay: false,
            })
        }
    }

    #[async_trait]
    impl OsAccountsClient for TtlExpiringOsAccounts {
        async fn authorize(&self, request: AuthorizeRequest) -> Result<Authorization, DomainError> {
            let token_number = self.next_token.fetch_add(1, Ordering::SeqCst) + 1;
            let token = format!("agt_ttl_{token_number}");
            if let Ok(mut expirations) = self.expires_at_by_token.lock() {
                expirations.insert(
                    token.clone(),
                    self.clock.now().saturating_add(request.hold_ttl_seconds),
                );
            }
            Ok(Authorization {
                allowed: true,
                action_token: Some(token),
                cap_credits: Some(request.estimate),
                reason: None,
            })
        }

        async fn charge(&self, request: ChargeRequest) -> Result<Receipt, DomainError> {
            let expires_at = self
                .expires_at_by_token
                .lock()
                .ok()
                .and_then(|expirations| expirations.get(&request.action_token).copied());
            if expires_at.is_none_or(|expires_at| self.clock.now() > expires_at) {
                return Err(DomainError::MeteringProvider);
            }
            Ok(Receipt {
                credits_charged: request.credits,
                idempotent_replay: false,
            })
        }
    }

    #[async_trait]
    impl OsAccountsClient for ChargeFailsOnceOsAccounts {
        async fn authorize(&self, request: AuthorizeRequest) -> Result<Authorization, DomainError> {
            if let Ok(mut events) = self.events.lock() {
                events.push(Call::Authorize {
                    action: request.action.to_string(),
                    estimate: request.estimate.0,
                });
            }
            Ok(Authorization {
                allowed: true,
                action_token: Some("agt_test".to_string()),
                cap_credits: Some(request.estimate),
                reason: None,
            })
        }

        async fn charge(&self, request: ChargeRequest) -> Result<Receipt, DomainError> {
            if let Ok(mut events) = self.events.lock() {
                events.push(Call::Charge {
                    credits: request.credits.0,
                    idempotency_key: request.idempotency_key,
                });
            }
            if !self.charge_failed.swap(true, Ordering::SeqCst) {
                return Err(DomainError::MeteringProvider);
            }
            Ok(Receipt {
                credits_charged: request.credits,
                idempotent_replay: false,
            })
        }
    }

    #[async_trait]
    impl OsAccountsClient for BlockingChargeOsAccounts {
        async fn authorize(&self, request: AuthorizeRequest) -> Result<Authorization, DomainError> {
            if let Ok(mut events) = self.events.lock() {
                events.push(Call::Authorize {
                    action: request.action.to_string(),
                    estimate: request.estimate.0,
                });
            }
            Ok(Authorization {
                allowed: true,
                action_token: Some("agt_blocking".to_string()),
                cap_credits: Some(request.estimate),
                reason: None,
            })
        }

        async fn charge(&self, request: ChargeRequest) -> Result<Receipt, DomainError> {
            if let Ok(mut events) = self.events.lock() {
                events.push(Call::Charge {
                    credits: request.credits.0,
                    idempotency_key: request.idempotency_key,
                });
            }
            self.charge_started.notify_waiters();
            self.release_charge.notified().await;
            Ok(Receipt {
                credits_charged: request.credits,
                idempotent_replay: false,
            })
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

    #[derive(Default)]
    struct CountingGenerator {
        calls: AtomicU64,
    }

    impl CountingGenerator {
        fn calls(&self) -> u64 {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl ImageGenerator for CountingGenerator {
        async fn generate(
            &self,
            request: ImageGenerationRequest,
        ) -> Result<GeneratedImage, DomainError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(GeneratedImage {
                image_base64: format!("generated-{call}"),
                mime_type: "image/png".to_string(),
                model: request.model.0,
                provider: "venice".to_string(),
            })
        }
    }

    #[derive(Default)]
    struct NotifyingCountingGenerator {
        calls: AtomicU64,
    }

    impl NotifyingCountingGenerator {
        fn calls(&self) -> u64 {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl ImageGenerator for NotifyingCountingGenerator {
        async fn generate(
            &self,
            request: ImageGenerationRequest,
        ) -> Result<GeneratedImage, DomainError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(GeneratedImage {
                image_base64: format!("generated-{call}"),
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

    struct DelayedGenerator {
        clock: Arc<ManualClock>,
        delay_seconds: u64,
    }

    impl DelayedGenerator {
        fn new(clock: Arc<ManualClock>, delay_seconds: u64) -> Self {
            Self {
                clock,
                delay_seconds,
            }
        }
    }

    #[async_trait]
    impl ImageGenerator for DelayedGenerator {
        async fn generate(
            &self,
            request: ImageGenerationRequest,
        ) -> Result<GeneratedImage, DomainError> {
            self.clock.advance(self.delay_seconds);
            Ok(GeneratedImage {
                image_base64: "ZGVsYXllZA==".to_string(),
                mime_type: "image/png".to_string(),
                model: request.model.0,
                provider: "venice".to_string(),
            })
        }
    }

    struct FixedEditor;

    #[async_trait]
    impl ImageEditor for FixedEditor {
        async fn edit(&self, request: ImageEditRequest) -> Result<GeneratedImage, DomainError> {
            Ok(GeneratedImage {
                image_base64: "ZWRpdGVk".to_string(),
                mime_type: "image/png".to_string(),
                model: request.model.0,
                provider: "venice".to_string(),
            })
        }
    }

    #[derive(Default)]
    struct CountingEditor {
        calls: AtomicU64,
    }

    impl CountingEditor {
        fn calls(&self) -> u64 {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl ImageEditor for CountingEditor {
        async fn edit(&self, request: ImageEditRequest) -> Result<GeneratedImage, DomainError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(GeneratedImage {
                image_base64: format!("edited-{call}"),
                mime_type: "image/png".to_string(),
                model: request.model.0,
                provider: "venice".to_string(),
            })
        }
    }

    fn service(
        os_accounts: Arc<dyn OsAccountsClient>,
        generator: Arc<dyn ImageGenerator>,
    ) -> ImageService {
        service_with_hold_ttl(os_accounts, generator, Arc::new(FixedEditor), 60)
    }

    fn service_with_editor(
        os_accounts: Arc<dyn OsAccountsClient>,
        generator: Arc<dyn ImageGenerator>,
        editor: Arc<dyn ImageEditor>,
    ) -> ImageService {
        service_with_hold_ttl(os_accounts, generator, editor, 60)
    }

    fn service_with_hold_ttl(
        os_accounts: Arc<dyn OsAccountsClient>,
        generator: Arc<dyn ImageGenerator>,
        editor: Arc<dyn ImageEditor>,
        hold_ttl_seconds: u64,
    ) -> ImageService {
        ImageService::new(ImageServiceDeps {
            os_accounts,
            generator,
            editor,
            pricing: BTreeMap::from([("venice-sd35".to_string(), ImageModelPrice::venice(20))]),
            edit_pricing: BTreeMap::from([(
                "firered-image-edit".to_string(),
                ImageModelPrice::venice(80),
            )]),
            default_edit_model: "firered-image-edit".to_string(),
            hold_ttl_seconds,
        })
    }

    fn params(model: &str) -> ImageGenerateParams {
        ImageGenerateParams {
            user_id: UserId("usr_1".to_string()),
            request_id: None,
            prompt: "a cat".to_string(),
            model: model.to_string(),
            width: None,
            height: None,
            safe_mode: None,
            provider_credentials: ProviderCredentials::default(),
        }
    }

    fn edit_params() -> ImageEditParams {
        ImageEditParams {
            user_id: UserId("usr_1".to_string()),
            request_id: None,
            image_base64: "aGVsbG8=".to_string(),
            mime_type: "image/png".to_string(),
            prompt: "make it fluffier".to_string(),
            model: None,
            safe_mode: Some(false),
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
                assert_attempt_charge_key("image_generate:usr_1:", idempotency_key);
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
    async fn failed_generation_authorizes_but_never_bills() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let result = service(os_accounts.clone(), Arc::new(FailingGenerator))
            .generate(params("venice-sd35"))
            .await;

        assert!(matches!(result, Err(crate::ServiceError::UpstreamProvider)));
        // The hold is released at zero credits instead of stranding until TTL.
        assert_eq!(
            os_accounts.events(),
            vec![
                Call::Authorize {
                    action: "image_generate".to_string(),
                    estimate: 20,
                },
                Call::Charge {
                    credits: 0,
                    idempotency_key: format!(
                        "release:image_generate:{}",
                        &crate::util::sha256_hex("agt_test".as_bytes())[..32],
                    ),
                },
            ]
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
    async fn user_venice_key_generation_request_id_replays_without_regenerating() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let generator = Arc::new(CountingGenerator::default());
        let service = service(os_accounts.clone(), generator.clone());
        let mut params = params("venice-sd35");
        params.request_id = Some("req_byok_generate".to_string());
        params.provider_credentials = ProviderCredentials {
            venice_api_key: Some("vc_user_key".to_string()),
        };

        let first = service
            .generate(params.clone())
            .await
            .expect("BYOK generation succeeds");
        let second = service
            .generate(params)
            .await
            .expect("BYOK generation replays");

        assert_eq!(first.image, second.image);
        assert_eq!(first.receipt.credits_charged.0, 0);
        assert_eq!(second.receipt.credits_charged.0, 0);
        assert_eq!(generator.calls(), 1);
        assert!(os_accounts.events().is_empty());
    }

    #[tokio::test]
    async fn user_venice_key_does_not_skip_non_venice_image_model_metering() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let service = ImageService::new(ImageServiceDeps {
            os_accounts: os_accounts.clone(),
            generator: Arc::new(FixedGenerator),
            editor: Arc::new(FixedEditor),
            pricing: BTreeMap::from([(
                "openai-image".to_string(),
                ImageModelPrice {
                    credits: 20,
                    provider: ModelProvider::Openai,
                },
            )]),
            edit_pricing: BTreeMap::new(),
            default_edit_model: "firered-image-edit".to_string(),
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
    async fn image_hold_ttl_covers_provider_delay_beyond_the_old_default() {
        const OLD_IMAGE_HOLD_TTL_SECONDS: u64 = 60;
        let delayed_past_old_hold = OLD_IMAGE_HOLD_TTL_SECONDS + 1;

        let old_clock = Arc::new(ManualClock::default());
        let old_result = service_with_hold_ttl(
            Arc::new(TtlExpiringOsAccounts::new(old_clock.clone())),
            Arc::new(DelayedGenerator::new(
                old_clock.clone(),
                delayed_past_old_hold,
            )),
            Arc::new(FixedEditor),
            OLD_IMAGE_HOLD_TTL_SECONDS,
        )
        .generate(params("venice-sd35"))
        .await;
        assert!(matches!(
            old_result,
            Err(crate::ServiceError::MeteringProvider)
        ));

        let clock = Arc::new(ManualClock::default());
        let service = service_with_hold_ttl(
            Arc::new(TtlExpiringOsAccounts::new(clock.clone())),
            Arc::new(DelayedGenerator::new(clock, delayed_past_old_hold)),
            Arc::new(FixedEditor),
            DEFAULT_IMAGE_HOLD_TTL_SECS,
        );

        let output = service
            .generate(params("venice-sd35"))
            .await
            .expect("settlement succeeds before the widened image hold expires");

        assert_eq!(output.receipt.credits_charged.0, 20);
        assert_eq!(output.image.image_base64, "ZGVsYXllZA==");
    }

    #[tokio::test]
    async fn each_generation_uses_a_distinct_charge_key() {
        // Two generations must settle as two distinct charges (generate twice =
        // charge twice) for older clients that do not send a request id.
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

    #[tokio::test]
    async fn legacy_generation_charge_key_stays_unique_across_service_restart() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let generator: Arc<dyn ImageGenerator> = Arc::new(FixedGenerator);
        for _ in 0..2 {
            service(os_accounts.clone(), generator.clone())
                .generate(params("venice-sd35"))
                .await
                .expect("generation succeeds");
        }

        let charge_keys = charge_keys(os_accounts.events());
        assert_eq!(charge_keys.len(), 2);
        assert_ne!(charge_keys[0], charge_keys[1]);
    }

    #[tokio::test]
    async fn generation_request_id_returns_cached_image_without_recharging_or_regenerating() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let generator = Arc::new(CountingGenerator::default());
        let service = service(os_accounts.clone(), generator.clone());
        let mut params = params("venice-sd35");
        params.request_id = Some("req_1".to_string());
        let first = service
            .generate(params.clone())
            .await
            .expect("generation succeeds");
        let second = service.generate(params).await.expect("generation succeeds");

        let charge_keys = charge_keys(os_accounts.events());
        assert_eq!(first.image, second.image);
        assert_eq!(generator.calls(), 1);
        assert_eq!(charge_keys.len(), 1);
    }

    #[tokio::test]
    async fn dropped_route_after_provider_success_settles_and_replays_without_regenerating() {
        let os_accounts = Arc::new(BlockingChargeOsAccounts::default());
        let generator = Arc::new(NotifyingCountingGenerator::default());
        let service = Arc::new(service(os_accounts.clone(), generator.clone()));
        let mut params = params("venice-sd35");
        params.request_id = Some("req_cancel_after_provider".to_string());

        let first = tokio::spawn({
            let service = service.clone();
            let params = params.clone();
            async move { service.generate(params).await }
        });
        tokio::time::timeout(
            Duration::from_secs(1),
            os_accounts.wait_for_charge_started(),
        )
        .await
        .expect("settlement should start after provider success");
        first.abort();
        let aborted = first.await;
        assert!(aborted.is_err());

        os_accounts.release_charge();
        let second = tokio::time::timeout(Duration::from_secs(1), service.generate(params))
            .await
            .expect("retry should wait for settlement rather than hang")
            .expect("retry replays settled output");

        assert_eq!(second.image.image_base64, "generated-1");
        assert_eq!(generator.calls(), 1);
        assert_eq!(charge_keys(os_accounts.events()).len(), 1);
    }

    #[tokio::test]
    async fn generation_same_request_id_different_shape_uses_a_distinct_charge_key() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let service = service(os_accounts.clone(), Arc::new(FixedGenerator));
        for prompt in ["make it red", "make it blue"] {
            service
                .generate(ImageGenerateParams {
                    request_id: Some("req_1".to_string()),
                    prompt: prompt.to_string(),
                    ..params("venice-sd35")
                })
                .await
                .expect("generation succeeds");
        }

        let charge_keys = charge_keys(os_accounts.events());
        assert_eq!(charge_keys.len(), 2);
        assert_ne!(charge_keys[0], charge_keys[1]);
    }

    #[tokio::test]
    async fn charge_failure_after_generation_retries_same_charge_without_regenerating() {
        let os_accounts = Arc::new(ChargeFailsOnceOsAccounts::default());
        let generator = Arc::new(CountingGenerator::default());
        let service = service(os_accounts.clone(), generator.clone());
        let mut params = params("venice-sd35");
        params.request_id = Some("req_ambiguous_charge".to_string());

        let first = service.generate(params.clone()).await;
        assert!(matches!(first, Err(crate::ServiceError::MeteringProvider)));

        let second = service.generate(params).await.expect("retry settles");
        let charge_keys = charge_keys(os_accounts.events());
        let distinct_charge_keys = charge_keys.iter().collect::<BTreeSet<_>>();

        assert_eq!(second.image.image_base64, "generated-1");
        assert_eq!(generator.calls(), 1);
        assert_eq!(charge_keys.len(), 2);
        assert_eq!(distinct_charge_keys.len(), 1);
    }

    #[tokio::test]
    async fn expired_pending_charge_runs_fresh_instead_of_reusing_stale_action_token() {
        let os_accounts = Arc::new(StaleTokenChargeFailsOsAccounts::default());
        let generator = Arc::new(CountingGenerator::default());
        let service = service_with_hold_ttl(
            os_accounts.clone(),
            generator.clone(),
            Arc::new(FixedEditor),
            1,
        );
        let mut params = params("venice-sd35");
        params.request_id = Some("req_expired_pending_charge".to_string());

        let first = service.generate(params.clone()).await;
        assert!(matches!(first, Err(crate::ServiceError::MeteringProvider)));
        age_pending_entries(&service.request_ledger, Duration::from_secs(2));

        let second = service.generate(params).await.expect("fresh retry settles");

        assert_eq!(second.image.image_base64, "generated-2");
        assert_eq!(generator.calls(), 2);
        assert_eq!(
            os_accounts.events(),
            vec![
                TokenCall::Authorize {
                    action_token: "agt_1".to_string(),
                },
                TokenCall::Charge {
                    action_token: "agt_1".to_string(),
                },
                TokenCall::Authorize {
                    action_token: "agt_2".to_string(),
                },
                TokenCall::Charge {
                    action_token: "agt_2".to_string(),
                },
            ]
        );
    }

    #[tokio::test]
    async fn edit_authorizes_then_charges_the_default_edit_model_price() {
        // An edit with no model uses the default edit model and charges its flat
        // edit price under the image_edit action.
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let output = service(os_accounts.clone(), Arc::new(FixedGenerator))
            .edit(edit_params())
            .await
            .expect("edit succeeds");

        assert_eq!(output.receipt.credits_charged.0, 80);
        let events = os_accounts.events();
        assert_eq!(
            events[0],
            Call::Authorize {
                action: "image_edit".to_string(),
                estimate: 80,
            }
        );
        match &events[1] {
            Call::Charge {
                credits,
                idempotency_key,
            } => {
                assert_eq!(*credits, 80);
                assert_attempt_charge_key("image_edit:usr_1:", idempotency_key);
            }
            Call::Authorize { .. } => panic!("expected a charge, got an authorize"),
        }
    }

    #[tokio::test]
    async fn edit_request_id_returns_cached_image_without_recharging_or_reediting() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let editor = Arc::new(CountingEditor::default());
        let service = service_with_editor(
            os_accounts.clone(),
            Arc::new(FixedGenerator),
            editor.clone(),
        );
        let mut params = edit_params();
        params.request_id = Some("req_1".to_string());
        let first = service.edit(params.clone()).await.expect("edit succeeds");
        let second = service.edit(params).await.expect("edit succeeds");

        let charge_keys = charge_keys(os_accounts.events());
        assert_eq!(first.image, second.image);
        assert_eq!(editor.calls(), 1);
        assert_eq!(charge_keys.len(), 1);
    }

    #[tokio::test]
    async fn edit_same_request_id_different_shape_uses_a_distinct_charge_key() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let service = service(os_accounts.clone(), Arc::new(FixedGenerator));
        for prompt in ["make it red", "make it blue"] {
            service
                .edit(ImageEditParams {
                    request_id: Some("req_1".to_string()),
                    prompt: prompt.to_string(),
                    ..edit_params()
                })
                .await
                .expect("edit succeeds");
        }

        let charge_keys = charge_keys(os_accounts.events());
        assert_eq!(charge_keys.len(), 2);
        assert_ne!(charge_keys[0], charge_keys[1]);
    }

    #[tokio::test]
    async fn ledger_evicts_the_oldest_settled_replay_over_the_cap() {
        let ledger = test_ledger();
        for index in 0..=super::IMAGE_LEDGER_MAX_SETTLED {
            let key = format!("key-{index:03}");
            match ledger.claim(key).await {
                super::ImageLedgerClaim::Run { guard } => {
                    let pending_key = guard
                        .charge_pending(sample_pending_at(Instant::now()))
                        .expect("pending charge inserted");
                    ledger.complete_pending(pending_key, sample_output());
                }
                super::ImageLedgerClaim::Replay(_) => panic!("fresh key must run"),
                super::ImageLedgerClaim::ChargePending { .. } => {
                    panic!("fresh key must not have a pending charge")
                }
            }
        }

        // One over the cap: the oldest settlement is gone, the newest replays.
        assert!(matches!(
            ledger.claim("key-000".to_string()).await,
            super::ImageLedgerClaim::Run { .. }
        ));
        assert!(matches!(
            ledger
                .claim(format!("key-{:03}", super::IMAGE_LEDGER_MAX_SETTLED))
                .await,
            super::ImageLedgerClaim::Replay(_)
        ));
    }

    #[tokio::test]
    async fn ledger_evicts_the_oldest_pending_charge_over_the_cap() {
        let ledger = test_ledger();
        let created_at = Instant::now();
        let mut offset = Duration::ZERO;
        for index in 0..=super::IMAGE_LEDGER_MAX_PENDING_PER_USER {
            let key = format!("pending-{index:03}");
            match ledger.claim(key).await {
                super::ImageLedgerClaim::Run { guard } => {
                    guard
                        .charge_pending(sample_pending_at(created_at + offset))
                        .expect("pending charge inserted");
                }
                super::ImageLedgerClaim::Replay(_) => panic!("fresh key must run"),
                super::ImageLedgerClaim::ChargePending { .. } => {
                    panic!("fresh key must not have a pending charge")
                }
            }
            offset += Duration::from_secs(1);
        }

        assert!(matches!(
            ledger.claim("pending-000".to_string()).await,
            super::ImageLedgerClaim::Run { .. }
        ));
        assert!(matches!(
            ledger
                .claim(format!(
                    "pending-{:03}",
                    super::IMAGE_LEDGER_MAX_PENDING_PER_USER
                ))
                .await,
            super::ImageLedgerClaim::ChargePending { .. }
        ));
    }

    #[tokio::test]
    async fn evicting_settling_entry_wakes_waiter_to_reclaim() {
        let ledger = test_ledger();
        let created_at = Instant::now();
        let key = "settling-000".to_string();
        insert_settling(&ledger, key.clone(), "usr_1", created_at).await;

        let waiter = tokio::spawn({
            let ledger = ledger.clone();
            let key = key.clone();
            async move { ledger.claim(key).await }
        });
        tokio::task::yield_now().await;

        let mut offset = Duration::from_secs(1);
        for index in 1..=super::IMAGE_LEDGER_MAX_PENDING_PER_USER {
            insert_settling(
                &ledger,
                format!("settling-{index:03}"),
                "usr_1",
                created_at + offset,
            )
            .await;
            offset += Duration::from_secs(1);
        }

        let claim = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("waiter should be notified when its settling entry is evicted")
            .expect("waiter task should not panic");
        let super::ImageLedgerClaim::Run { guard } = claim else {
            panic!("evicted settling entry should be claimed by a fresh runner");
        };
        guard.complete(sample_output());
        assert!(matches!(
            ledger.claim(key).await,
            super::ImageLedgerClaim::Replay(_)
        ));
    }

    #[tokio::test]
    async fn cross_user_pressure_preserves_other_user_settling_until_global_backstop() {
        let ledger = test_ledger();
        let created_at = Instant::now();
        let protected_key = "protected-settling".to_string();
        insert_settling(&ledger, protected_key.clone(), "usr_protected", created_at).await;

        let mut offset = Duration::from_secs(1);
        for index in 0..=super::IMAGE_LEDGER_MAX_PENDING_PER_USER {
            insert_settling(
                &ledger,
                format!("noisy-user-a-{index:03}"),
                "usr_noisy_a",
                created_at + offset,
            )
            .await;
            offset += Duration::from_secs(1);
        }
        assert!(
            ledger_contains_key(&ledger, &protected_key),
            "one user's per-user pressure must not evict another user's settling entry"
        );

        for user_suffix in ["b", "c", "d"] {
            let user_id = format!("usr_noisy_{user_suffix}");
            for index in 0..super::IMAGE_LEDGER_MAX_PENDING_PER_USER {
                insert_settling(
                    &ledger,
                    format!("noisy-user-{user_suffix}-{index:03}"),
                    &user_id,
                    created_at + offset,
                )
                .await;
                offset += Duration::from_secs(1);
            }
        }

        assert!(
            !ledger_contains_key(&ledger, &protected_key),
            "the global hard backstop may evict the oldest settling entry"
        );
    }

    #[test]
    fn ledger_prunes_settled_replays_past_the_ttl() {
        let mut entries = BTreeMap::new();
        let settled_at = std::time::Instant::now();
        entries.insert(
            "old".to_string(),
            super::ImageLedgerEntry::Complete {
                output: sample_output(),
                settled_at,
            },
        );
        super::prune_expired_entries(
            &mut entries,
            settled_at + super::IMAGE_LEDGER_REPLAY_TTL + std::time::Duration::from_secs(1),
            Duration::from_mins(1),
        );
        assert!(entries.is_empty());
    }

    #[test]
    fn ledger_prunes_pending_charges_past_the_hold_ttl() {
        let mut entries = BTreeMap::new();
        let created_at = Instant::now();
        entries.insert(
            "old".to_string(),
            super::ImageLedgerEntry::ChargePending {
                pending: sample_pending_at(created_at),
                created_at,
            },
        );
        super::prune_expired_entries(
            &mut entries,
            created_at + Duration::from_secs(61),
            Duration::from_mins(1),
        );
        assert!(entries.is_empty());
    }

    #[test]
    fn ledger_prunes_stale_in_flight_entries_past_the_ttl() {
        let mut entries = BTreeMap::new();
        let started_at = std::time::Instant::now();
        entries.insert(
            "stale".to_string(),
            super::ImageLedgerEntry::InFlight {
                notify: Arc::new(tokio::sync::Notify::new()),
                started_at,
                owner: 1,
            },
        );
        super::prune_expired_entries(
            &mut entries,
            started_at + super::IMAGE_LEDGER_IN_FLIGHT_TTL + std::time::Duration::from_secs(1),
            Duration::from_mins(1),
        );
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn dropped_in_flight_claim_releases_waiters_for_same_key() {
        let ledger = test_ledger();
        let key = "cancelled-key".to_string();
        let first_claim = ledger.claim(key.clone()).await;
        let super::ImageLedgerClaim::Run { guard } = first_claim else {
            panic!("fresh key must run");
        };

        let cancelled = tokio::time::timeout(std::time::Duration::from_millis(1), async move {
            let _guard = guard;
            std::future::pending::<()>().await;
        })
        .await;
        assert!(cancelled.is_err());

        let second_claim =
            tokio::time::timeout(std::time::Duration::from_secs(1), ledger.claim(key))
                .await
                .expect("second claim should not hang");
        assert!(matches!(second_claim, super::ImageLedgerClaim::Run { .. }));
    }

    fn test_ledger() -> super::ImageRequestLedger {
        super::ImageRequestLedger::new(Duration::from_mins(1))
    }

    async fn insert_settling(
        ledger: &super::ImageRequestLedger,
        key: String,
        user_id: &str,
        created_at: Instant,
    ) {
        match ledger.claim(key).await {
            super::ImageLedgerClaim::Run { guard } => {
                guard
                    .start_settling(&sample_pending_for_user_at(user_id, created_at))
                    .expect("settling entry inserted");
            }
            super::ImageLedgerClaim::Replay(_) => panic!("fresh key must run"),
            super::ImageLedgerClaim::ChargePending { .. } => {
                panic!("fresh key must not have a pending charge")
            }
        }
    }

    fn ledger_contains_key(ledger: &super::ImageRequestLedger, key: &str) -> bool {
        ledger.entries().contains_key(key)
    }

    fn age_pending_entries(ledger: &super::ImageRequestLedger, age: Duration) {
        let now = Instant::now();
        let created_at = now.checked_sub(age).unwrap_or(now);
        let mut entries = ledger.entries();
        for entry in entries.values_mut() {
            if let super::ImageLedgerEntry::ChargePending {
                created_at: entry_created_at,
                ..
            } = entry
            {
                *entry_created_at = created_at;
            }
        }
    }

    fn sample_pending_at(created_at: Instant) -> super::PendingImageCharge {
        sample_pending_for_user_at("usr_1", created_at)
    }

    fn sample_pending_for_user_at(user_id: &str, created_at: Instant) -> super::PendingImageCharge {
        super::PendingImageCharge {
            action: june_domain::ActionSlug::ImageGenerate,
            user_id: UserId(user_id.to_string()),
            model: "flux-2-pro".to_string(),
            image: GeneratedImage {
                image_base64: "aGVsbG8=".to_string(),
                mime_type: "image/png".to_string(),
                model: "flux-2-pro".to_string(),
                provider: "venice".to_string(),
            },
            action_token: "agt_test".to_string(),
            credits: june_domain::Credits(60),
            idempotency_key: "image_generate:usr_1:attempt:test:test".to_string(),
            created_at,
        }
    }

    fn sample_output() -> super::ImageGenerateOutput {
        super::ImageGenerateOutput {
            image: GeneratedImage {
                image_base64: "aGVsbG8=".to_string(),
                mime_type: "image/png".to_string(),
                model: "flux-2-pro".to_string(),
                provider: "venice".to_string(),
            },
            receipt: Receipt {
                credits_charged: june_domain::Credits(60),
                idempotent_replay: false,
            },
        }
    }

    #[tokio::test]
    async fn user_venice_key_edits_without_wallet_authorize_or_charge() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let mut params = edit_params();
        params.provider_credentials = ProviderCredentials {
            venice_api_key: Some("vc_user_key".to_string()),
        };
        let output = service(os_accounts.clone(), Arc::new(FixedGenerator))
            .edit(params)
            .await
            .expect("edit succeeds");

        assert_eq!(output.receipt.credits_charged.0, 0);
        assert!(os_accounts.events().is_empty());
    }

    #[tokio::test]
    async fn user_venice_key_edit_request_id_replays_without_reediting() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let editor = Arc::new(CountingEditor::default());
        let service = service_with_editor(
            os_accounts.clone(),
            Arc::new(FixedGenerator),
            editor.clone(),
        );
        let mut params = edit_params();
        params.request_id = Some("req_byok_edit".to_string());
        params.provider_credentials = ProviderCredentials {
            venice_api_key: Some("vc_user_key".to_string()),
        };

        let first = service
            .edit(params.clone())
            .await
            .expect("BYOK edit succeeds");
        let second = service.edit(params).await.expect("BYOK edit replays");

        assert_eq!(first.image, second.image);
        assert_eq!(first.receipt.credits_charged.0, 0);
        assert_eq!(second.receipt.credits_charged.0, 0);
        assert_eq!(editor.calls(), 1);
        assert!(os_accounts.events().is_empty());
    }

    #[tokio::test]
    async fn edit_with_an_unpriced_model_is_rejected_before_any_wallet_call() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let result = service(os_accounts.clone(), Arc::new(FixedGenerator))
            .edit(ImageEditParams {
                model: Some("some-unpriced-edit-model".to_string()),
                ..edit_params()
            })
            .await;

        assert!(matches!(result, Err(crate::ServiceError::ModelNotPriced)));
        assert!(os_accounts.events().is_empty());
    }

    fn charge_keys(events: Vec<Call>) -> Vec<String> {
        events
            .into_iter()
            .filter_map(|call| match call {
                Call::Charge {
                    idempotency_key, ..
                } => Some(idempotency_key),
                Call::Authorize { .. } => None,
            })
            .collect()
    }

    fn assert_attempt_charge_key(prefix: &str, idempotency_key: &str) {
        let rest = idempotency_key
            .strip_prefix(prefix)
            .expect("key has the expected prefix");
        let rest = rest.strip_prefix("attempt:").expect("attempt scope");
        let (operation_id, digest) = rest.split_once(':').expect("attempt:digest");
        uuid::Uuid::parse_str(operation_id).expect("attempt scope is a UUID");
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|ch| ch.is_ascii_hexdigit()));
    }
}
