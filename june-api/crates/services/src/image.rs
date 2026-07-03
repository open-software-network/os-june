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
use uuid::Uuid;

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
                    safe_mode: params.safe_mode,
                    provider_credentials: params.provider_credentials.clone(),
                })
                .await?;
            log_skipped_user_venice_key(ActionSlug::ImageGenerate, &params.user_id, &params.model);
            return Ok(ImageGenerateOutput {
                image,
                receipt: zero_receipt(),
            });
        }
        if let Some(key) = image_ledger_key(&params) {
            match self.request_ledger.claim(key).await {
                ImageLedgerClaim::Replay(output) => return Ok(output),
                ImageLedgerClaim::ChargePending { key, pending } => {
                    return self.settle_pending_ledger_charge(key, pending).await;
                }
                ImageLedgerClaim::Run { guard } => {
                    return self
                        .finish_claimed_charge(
                            guard,
                            self.prepare_generate_charge(&params, estimate).await,
                        )
                        .await;
                }
            }
        }
        let pending = self.prepare_generate_charge(&params, estimate).await?;
        self.settle_pending_charge(&pending).await
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
        // wallet hold simply expires (same as the web and agent chat paths).
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
    /// error WITHOUT charging (the hold expires).
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
        if price.provider == ModelProvider::Venice
            && uses_user_venice_key(&params.provider_credentials)
        {
            let image = self
                .editor
                .edit(ImageEditRequest {
                    image_base64: params.image_base64.clone(),
                    mime_type: params.mime_type.clone(),
                    prompt: params.prompt.clone(),
                    model: ModelId(model.clone()),
                    safe_mode: params.safe_mode,
                    provider_credentials: params.provider_credentials.clone(),
                })
                .await?;
            log_skipped_user_venice_key(ActionSlug::ImageEdit, &params.user_id, &model);
            return Ok(ImageGenerateOutput {
                image,
                receipt: zero_receipt(),
            });
        }
        if let Some(key) = edit_ledger_key(&params, &model) {
            match self.request_ledger.claim(key).await {
                ImageLedgerClaim::Replay(output) => return Ok(output),
                ImageLedgerClaim::ChargePending { key, pending } => {
                    return self.settle_pending_ledger_charge(key, pending).await;
                }
                ImageLedgerClaim::Run { guard } => {
                    return self
                        .finish_claimed_charge(
                            guard,
                            self.prepare_edit_charge(&params, &model, estimate).await,
                        )
                        .await;
                }
            }
        }
        let pending = self.prepare_edit_charge(&params, &model, estimate).await?;
        self.settle_pending_charge(&pending).await
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
        let pending_key = guard.charge_pending(pending.clone());
        match self.settle_pending_charge(&pending).await {
            Ok(output) => {
                if let Some(key) = pending_key {
                    self.request_ledger.complete_pending(key, output.clone());
                }
                Ok(output)
            }
            Err(error) => Err(error),
        }
    }

    async fn settle_pending_ledger_charge(
        &self,
        key: String,
        pending: PendingImageCharge,
    ) -> Result<ImageGenerateOutput, ServiceError> {
        let output = self.settle_pending_charge(&pending).await?;
        self.request_ledger.complete_pending(key, output.clone());
        Ok(output)
    }

    async fn settle_pending_charge(
        &self,
        pending: &PendingImageCharge,
    ) -> Result<ImageGenerateOutput, ServiceError> {
        let receipt = charge(ChargeParams {
            os_accounts: self.os_accounts.as_ref(),
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

fn new_charge_operation_id() -> String {
    Uuid::now_v7().to_string()
}

/// Settled replays are kept only briefly: each entry pins a full base64 image
/// in memory, so an unbounded ledger would grow by megabytes per generation
/// for the life of the process. Duplicate request ids only arise from
/// short-lived client retries, so a short window plus a hard cap bounds memory
/// without weakening the replay guarantee in practice.
const IMAGE_LEDGER_REPLAY_TTL: Duration = Duration::from_mins(10);
const IMAGE_LEDGER_IN_FLIGHT_TTL: Duration = Duration::from_mins(15);
const IMAGE_LEDGER_MAX_SETTLED: usize = 32;

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
    fn charge_pending(mut self, pending: PendingImageCharge) -> Option<String> {
        if let Some(key) = self.key.take()
            && self.ledger.charge_pending(key.clone(), self.owner, pending)
        {
            return Some(key);
        }
        None
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
                    Some(ImageLedgerEntry::InFlight { notify, .. }) => {
                        notify.clone().notified_owned()
                    }
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
                    | ImageLedgerEntry::Complete { .. },
                )
                | None => None,
            };
            if notify.is_some() {
                entries.insert(
                    key,
                    ImageLedgerEntry::ChargePending {
                        created_at: pending.created_at,
                        pending,
                    },
                );
                evict_over_pending_cap(&mut entries);
            }
            notify
        };
        if let Some(notify) = notify {
            notify.notify_waiters();
            return true;
        }
        false
    }

    fn complete_pending(&self, key: String, output: ImageGenerateOutput) {
        let mut entries = self.entries();
        if matches!(
            entries.get(&key),
            Some(ImageLedgerEntry::ChargePending { .. })
        ) {
            entries.insert(
                key,
                ImageLedgerEntry::Complete {
                    output,
                    settled_at: Instant::now(),
                },
            );
            evict_over_replay_cap(&mut entries);
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
                ImageLedgerEntry::InFlight { .. } | ImageLedgerEntry::ChargePending { .. } => None,
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

fn evict_over_pending_cap(entries: &mut BTreeMap<String, ImageLedgerEntry>) {
    loop {
        let pending: Vec<(String, Instant)> = entries
            .iter()
            .filter_map(|(key, entry)| match entry {
                ImageLedgerEntry::ChargePending { created_at, .. } => {
                    Some((key.clone(), *created_at))
                }
                ImageLedgerEntry::InFlight { .. } | ImageLedgerEntry::Complete { .. } => None,
            })
            .collect();
        if pending.len() <= IMAGE_LEDGER_MAX_SETTLED {
            return;
        }
        let Some((oldest, _)) = pending
            .into_iter()
            .min_by_key(|(_, created_at)| *created_at)
        else {
            return;
        };
        entries.remove(&oldest);
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
    use june_config::ModelProvider;
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
    struct StaleTokenChargeFailsOsAccounts {
        next_token: AtomicU64,
        events: Mutex<Vec<TokenCall>>,
    }

    impl StaleTokenChargeFailsOsAccounts {
        fn events(&self) -> Vec<TokenCall> {
            self.events.lock().map(|e| e.clone()).unwrap_or_default()
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
        for index in 0..=super::IMAGE_LEDGER_MAX_SETTLED {
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
                .claim(format!("pending-{:03}", super::IMAGE_LEDGER_MAX_SETTLED))
                .await,
            super::ImageLedgerClaim::ChargePending { .. }
        ));
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
        super::PendingImageCharge {
            action: june_domain::ActionSlug::ImageGenerate,
            user_id: UserId("usr_1".to_string()),
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
