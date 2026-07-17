use super::{
    JobId, VideoAnimateParams, VideoGenerateParams, VideoModelPrice, VideoService,
    VideoServiceDeps, VideoStatusOutput, credits_from_quote,
};
use crate::ServiceError;
use async_trait::async_trait;
use june_domain::{
    Authorization, AuthorizeRequest, ChargeRequest, DomainError, GeneratedVideo, OsAccountsClient,
    ProviderCredentials, Receipt, UserId, VideoAnimationRequest, VideoGenerationRequest,
    VideoProvider, VideoQueued, VideoQuoteRequest, VideoRetrieved,
};
use pretty_assertions::assert_eq;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

// --- OS Accounts mocks -------------------------------------------------------

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

// --- Video provider mock -----------------------------------------------------

#[derive(Clone)]
enum MockQueue {
    Ok,
    ContentViolation,
    Capacity,
    Upstream,
}

#[derive(Clone)]
enum MockRetrieve {
    Processing { avg: u64, exec: u64 },
    CompletedBytes(Vec<u8>),
    CompletedUrl(String),
    ContentViolation,
    TooLarge,
    MediaExpired,
    Transient,
}

struct MockVideoProvider {
    quote_usd: f64,
    queue: MockQueue,
    download_url: Option<String>,
    queue_calls: AtomicU64,
    retrieve_calls: AtomicU64,
    script: Mutex<VecDeque<MockRetrieve>>,
    default_retrieve: MockRetrieve,
}

impl MockVideoProvider {
    fn completed(quote_usd: f64, bytes: Vec<u8>) -> Self {
        Self {
            quote_usd,
            queue: MockQueue::Ok,
            download_url: None,
            queue_calls: AtomicU64::new(0),
            retrieve_calls: AtomicU64::new(0),
            script: Mutex::new(VecDeque::new()),
            default_retrieve: MockRetrieve::CompletedBytes(bytes),
        }
    }

    fn with_default_retrieve(mut self, retrieve: MockRetrieve) -> Self {
        self.default_retrieve = retrieve;
        self
    }

    fn with_queue(mut self, queue: MockQueue) -> Self {
        self.queue = queue;
        self
    }

    fn queue_calls(&self) -> u64 {
        self.queue_calls.load(Ordering::SeqCst)
    }

    fn queued(&self) -> Result<VideoQueued, DomainError> {
        self.queue_calls.fetch_add(1, Ordering::SeqCst);
        match self.queue {
            MockQueue::Ok => Ok(VideoQueued {
                venice_queue_id: "vq_1".to_string(),
                download_url: self.download_url.clone(),
            }),
            MockQueue::ContentViolation => Err(DomainError::InvalidInput {
                reason: "video_content_violation".to_string(),
            }),
            MockQueue::Capacity => Err(DomainError::MeteringProvider),
            MockQueue::Upstream => Err(DomainError::UpstreamProvider),
        }
    }
}

fn retrieve_outcome(outcome: MockRetrieve) -> Result<VideoRetrieved, DomainError> {
    match outcome {
        MockRetrieve::Processing { avg, exec } => Ok(VideoRetrieved::Processing {
            average_execution_ms: avg,
            execution_ms: exec,
        }),
        MockRetrieve::CompletedBytes(bytes) => Ok(VideoRetrieved::CompletedBytes {
            bytes,
            mime_type: "video/mp4".to_string(),
        }),
        MockRetrieve::CompletedUrl(url) => Ok(VideoRetrieved::CompletedUrl { download_url: url }),
        MockRetrieve::ContentViolation => Err(DomainError::InvalidInput {
            reason: "video_content_violation".to_string(),
        }),
        MockRetrieve::TooLarge => Err(DomainError::InvalidInput {
            reason: "video_too_large".to_string(),
        }),
        MockRetrieve::MediaExpired => Err(DomainError::InvalidInput {
            reason: "video_media_expired".to_string(),
        }),
        MockRetrieve::Transient => Err(DomainError::MeteringProvider),
    }
}

#[async_trait]
impl VideoProvider for MockVideoProvider {
    async fn quote(&self, _request: VideoQuoteRequest) -> Result<f64, DomainError> {
        Ok(self.quote_usd)
    }

    async fn queue(&self, _request: VideoGenerationRequest) -> Result<VideoQueued, DomainError> {
        self.queued()
    }

    async fn queue_animation(
        &self,
        _request: VideoAnimationRequest,
    ) -> Result<VideoQueued, DomainError> {
        self.queued()
    }

    async fn retrieve(&self, _model: &str, _queue_id: &str) -> Result<VideoRetrieved, DomainError> {
        self.retrieve_calls.fetch_add(1, Ordering::SeqCst);
        let outcome = self
            .script
            .lock()
            .ok()
            .and_then(|mut script| script.pop_front())
            .unwrap_or_else(|| self.default_retrieve.clone());
        retrieve_outcome(outcome)
    }
}

// --- Helpers -----------------------------------------------------------------

fn service(
    os_accounts: Arc<dyn OsAccountsClient>,
    provider: Arc<dyn VideoProvider>,
) -> VideoService {
    service_with_ceiling(os_accounts, provider, 20_000)
}

fn service_with_ceiling(
    os_accounts: Arc<dyn OsAccountsClient>,
    provider: Arc<dyn VideoProvider>,
    max_credits_per_request: u64,
) -> VideoService {
    VideoService::new(VideoServiceDeps {
        os_accounts,
        provider,
        pricing: BTreeMap::from([(
            "wan-2.2-a14b-text-to-video".to_string(),
            VideoModelPrice::venice(2000),
        )]),
        animate_pricing: BTreeMap::from([(
            "wan-2.6-image-to-video".to_string(),
            VideoModelPrice::venice(2000),
        )]),
        default_animate_model: "wan-2.6-image-to-video".to_string(),
        max_credits_per_request,
        hold_ttl_seconds: 600,
    })
}

fn generate_params(model: &str) -> VideoGenerateParams {
    VideoGenerateParams {
        user_id: UserId("usr_1".to_string()),
        request_id: None,
        prompt: "a cat".to_string(),
        model: model.to_string(),
        duration: "5s".to_string(),
        resolution: Some("720p".to_string()),
        aspect_ratio: Some("16:9".to_string()),
        audio: None,
        negative_prompt: None,
        provider_credentials: ProviderCredentials::default(),
    }
}

fn usr(id: &str) -> UserId {
    UserId(id.to_string())
}

fn charge_calls(events: &[Call]) -> Vec<(u64, String)> {
    events
        .iter()
        .filter_map(|call| match call {
            Call::Charge {
                credits,
                idempotency_key,
            } => Some((*credits, idempotency_key.clone())),
            Call::Authorize { .. } => None,
        })
        .collect()
}

fn authorize_count(events: &[Call]) -> usize {
    events
        .iter()
        .filter(|call| matches!(call, Call::Authorize { .. }))
        .count()
}

/// The zero-credit release settling a failed job's hold (grant-scoped key,
/// derived from the mock's fixed `agt_test` token).
fn release_call() -> (u64, String) {
    (
        0,
        format!(
            "release:video_generate:{}",
            &crate::util::sha256_hex("agt_test".as_bytes())[..32],
        ),
    )
}

// --- credits_from_quote ------------------------------------------------------

#[test]
fn quote_derived_credits_use_ceil_and_markup() {
    // 0.11 USD * 2.0x = 220 credits, exactly (float epsilon must not push to 221).
    assert_eq!(credits_from_quote(0.11, 2000).expect("valid"), 220);
    // A genuine fractional credit rounds up.
    assert_eq!(credits_from_quote(0.06005, 2000).expect("valid"), 121);
    // 0.35 * 2.0x = 700 exactly.
    assert_eq!(credits_from_quote(0.35, 2000).expect("valid"), 700);
    // A zero quote is zero credits.
    assert_eq!(credits_from_quote(0.0, 2000).expect("valid"), 0);
    // Non-finite is rejected.
    assert!(credits_from_quote(f64::INFINITY, 2000).is_err());
}

// --- generate / pricing ------------------------------------------------------

#[tokio::test]
async fn unpriced_model_is_rejected_before_quote_authorize_or_queue() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(MockVideoProvider::completed(0.11, vec![1, 2, 3]));
    let result = service(os.clone(), provider.clone())
        .generate(generate_params("unlisted-video-model"))
        .await;

    assert!(matches!(result, Err(ServiceError::ModelNotPriced)));
    assert_eq!(provider.queue_calls(), 0);
    assert!(os.events().is_empty());
}

#[tokio::test]
async fn quote_derived_credits_are_authorized_and_charged() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(MockVideoProvider::completed(0.11, vec![9, 9, 9]));
    let service = service(os.clone(), provider);
    let handle = service
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await
        .expect("generate succeeds");
    service
        .status(usr("usr_1"), handle.job_id)
        .await
        .expect("status completes");

    let events = os.events();
    assert_eq!(
        events[0],
        Call::Authorize {
            action: "video_generate".to_string(),
            estimate: 220,
        }
    );
    let charges = charge_calls(&events);
    assert_eq!(charges.len(), 1);
    assert_eq!(charges[0].0, 220);
    assert_attempt_charge_key("video_generate:usr_1:", &charges[0].1);
}

#[tokio::test]
async fn quote_over_the_ceiling_is_rejected_before_authorize() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    // 11.0 USD * 2.0x = 22000 credits > 20000 ceiling.
    let provider = Arc::new(MockVideoProvider::completed(11.0, vec![1]));
    let result = service(os.clone(), provider.clone())
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await;

    assert!(matches!(result, Err(ServiceError::PriceOverflow)));
    // The ceiling is enforced before the wallet or Venice queue is touched.
    assert!(os.events().is_empty());
    assert_eq!(provider.queue_calls(), 0);
}

// --- dedupe ------------------------------------------------------------------

#[tokio::test]
async fn same_request_id_same_shape_dedupes_to_one_queue() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(MockVideoProvider::completed(0.11, vec![1, 2]));
    let service = service(os, provider.clone());
    let mut params = generate_params("wan-2.2-a14b-text-to-video");
    params.request_id = Some("req_1".to_string());

    let first = service
        .generate(params.clone())
        .await
        .expect("first generate succeeds");
    let second = service
        .generate(params)
        .await
        .expect("second generate dedupes");

    assert_eq!(first.job_id, second.job_id);
    assert_eq!(provider.queue_calls(), 1);
}

#[tokio::test]
async fn same_request_id_different_shape_creates_distinct_jobs() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(MockVideoProvider::completed(0.11, vec![1, 2]));
    let service = service(os, provider.clone());

    let mut first = generate_params("wan-2.2-a14b-text-to-video");
    first.request_id = Some("req_1".to_string());
    let mut second = first.clone();
    second.prompt = "a dog".to_string();

    let a = service.generate(first).await.expect("first generate");
    let b = service.generate(second).await.expect("second generate");

    assert_ne!(a.job_id, b.job_id);
    assert_eq!(provider.queue_calls(), 2);
}

// --- status happy path -------------------------------------------------------

#[tokio::test]
async fn completed_status_charges_once_and_re_serves_without_recharging() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(MockVideoProvider::completed(0.11, vec![4, 5, 6, 7]));
    let service = service(os.clone(), provider.clone());
    let handle = service
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await
        .expect("generate succeeds");

    let first = service
        .status(usr("usr_1"), handle.job_id.clone())
        .await
        .expect("first status");
    assert_completed_bytes(&first, &[4, 5, 6, 7]);

    let second = service
        .status(usr("usr_1"), handle.job_id)
        .await
        .expect("second status re-serves");
    assert_completed_bytes(&second, &[4, 5, 6, 7]);

    // Exactly one charge; the re-serve re-fetches bytes but never recharges.
    assert_eq!(charge_calls(&os.events()).len(), 1);
    assert_eq!(provider.retrieve_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn processing_status_reports_progress_without_charging() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(
        MockVideoProvider::completed(0.11, vec![1]).with_default_retrieve(
            MockRetrieve::Processing {
                avg: 145_000,
                exec: 30_000,
            },
        ),
    );
    let service = service(os.clone(), provider);
    let handle = service
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await
        .expect("generate succeeds");

    let status = service
        .status(usr("usr_1"), handle.job_id)
        .await
        .expect("status polls");

    assert_eq!(
        status,
        VideoStatusOutput::Processing {
            average_execution_ms: 145_000,
            execution_ms: 30_000,
        }
    );
    assert_eq!(charge_calls(&os.events()).len(), 0);
}

#[tokio::test]
async fn concurrent_completed_polls_charge_exactly_once() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(MockVideoProvider::completed(0.11, vec![8, 8, 8]));
    let service = Arc::new(service(os.clone(), provider));
    let handle = service
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await
        .expect("generate succeeds");

    let a = tokio::spawn({
        let service = service.clone();
        let job_id = handle.job_id.clone();
        async move { service.status(usr("usr_1"), job_id).await }
    });
    let b = tokio::spawn({
        let service = service.clone();
        let job_id = handle.job_id.clone();
        async move { service.status(usr("usr_1"), job_id).await }
    });
    let first = a.await.expect("task a").expect("status a");
    let second = b.await.expect("task b").expect("status b");

    assert_completed_bytes(&first, &[8, 8, 8]);
    assert_completed_bytes(&second, &[8, 8, 8]);
    assert_eq!(charge_calls(&os.events()).len(), 1);
}

// --- content policy ----------------------------------------------------------

#[tokio::test]
async fn content_violation_on_queue_rejects_without_charging() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(
        MockVideoProvider::completed(0.11, vec![1]).with_queue(MockQueue::ContentViolation),
    );
    let result = service(os.clone(), provider)
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await;

    assert!(matches!(
        result,
        Err(ServiceError::ContentRejected { reason }) if reason == "content_violation"
    ));
    // The hold was taken (authorize) and released at zero credits.
    assert_eq!(authorize_count(&os.events()), 1);
    assert_eq!(charge_calls(&os.events()), vec![release_call()]);
}

#[tokio::test]
async fn content_violation_on_status_fails_without_charging() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(
        MockVideoProvider::completed(0.11, vec![1])
            .with_default_retrieve(MockRetrieve::ContentViolation),
    );
    let service = service(os.clone(), provider);
    let handle = service
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await
        .expect("generate succeeds");

    let status = service
        .status(usr("usr_1"), handle.job_id.clone())
        .await
        .expect("status resolves to a terminal failure");
    assert_eq!(
        status,
        VideoStatusOutput::Failed {
            reason: "content_violation".to_string(),
        }
    );

    // A re-poll stays Failed and still never charges.
    let repoll = service
        .status(usr("usr_1"), handle.job_id)
        .await
        .expect("re-poll");
    assert_eq!(
        repoll,
        VideoStatusOutput::Failed {
            reason: "content_violation".to_string(),
        }
    );
    assert_eq!(charge_calls(&os.events()), vec![release_call()]);
}

#[tokio::test]
async fn oversized_video_on_status_fails_without_charging() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(
        MockVideoProvider::completed(0.11, vec![1]).with_default_retrieve(MockRetrieve::TooLarge),
    );
    let service = service(os.clone(), provider);
    let handle = service
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await
        .expect("generate succeeds");

    let status = service
        .status(usr("usr_1"), handle.job_id.clone())
        .await
        .expect("oversized media resolves to a terminal failure");
    assert_eq!(
        status,
        VideoStatusOutput::Failed {
            reason: "video_too_large".to_string(),
        }
    );

    let repoll = service
        .status(usr("usr_1"), handle.job_id)
        .await
        .expect("re-poll");
    assert_eq!(
        repoll,
        VideoStatusOutput::Failed {
            reason: "video_too_large".to_string(),
        }
    );
    assert_eq!(charge_calls(&os.events()), vec![release_call()]);
}

#[tokio::test]
async fn queue_capacity_maps_to_metering_and_does_not_charge() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider =
        Arc::new(MockVideoProvider::completed(0.11, vec![1]).with_queue(MockQueue::Capacity));
    let result = service(os.clone(), provider)
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await;

    assert!(matches!(result, Err(ServiceError::MeteringProvider)));
    // Authorized (hold taken), never billed: released at zero credits.
    assert_eq!(authorize_count(&os.events()), 1);
    assert_eq!(charge_calls(&os.events()), vec![release_call()]);
}

#[tokio::test]
async fn queue_upstream_failure_maps_to_upstream_and_does_not_charge() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider =
        Arc::new(MockVideoProvider::completed(0.11, vec![1]).with_queue(MockQueue::Upstream));
    let result = service(os.clone(), provider)
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await;

    assert!(matches!(result, Err(ServiceError::UpstreamProvider)));
    assert_eq!(charge_calls(&os.events()), vec![release_call()]);
}

#[tokio::test]
async fn transient_retrieve_error_keeps_polling_without_charging() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    // First retrieve is a transient 503; the client keeps polling.
    let provider = Arc::new(
        MockVideoProvider::completed(0.11, vec![2, 2])
            .with_default_retrieve(MockRetrieve::Transient),
    );
    if let Ok(mut script) = provider.script.lock() {
        script.push_back(MockRetrieve::Transient);
    }
    let service = service(os.clone(), provider);
    let handle = service
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await
        .expect("generate succeeds");

    let status = service
        .status(usr("usr_1"), handle.job_id)
        .await
        .expect("transient retrieve is reported as still processing");
    assert_eq!(
        status,
        VideoStatusOutput::Processing {
            average_execution_ms: 0,
            execution_ms: 0,
        }
    );
    assert_eq!(charge_calls(&os.events()).len(), 0);
}

#[tokio::test]
async fn expired_media_on_status_is_not_found() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(
        MockVideoProvider::completed(0.11, vec![1])
            .with_default_retrieve(MockRetrieve::MediaExpired),
    );
    let service = service(os.clone(), provider);
    let handle = service
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await
        .expect("generate succeeds");

    let result = service.status(usr("usr_1"), handle.job_id).await;
    assert!(matches!(result, Err(ServiceError::JobNotFound)));
    assert_eq!(charge_calls(&os.events()), vec![release_call()]);
}

// --- charge failure re-poll --------------------------------------------------

#[tokio::test]
async fn charge_failure_repoll_recharges_the_same_settlement_key() {
    let os = Arc::new(ChargeFailsOnceOsAccounts::default());
    let provider = Arc::new(MockVideoProvider::completed(0.11, vec![3, 3, 3]));
    let service = service(os.clone(), provider);
    let handle = service
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await
        .expect("generate succeeds");

    let first = service.status(usr("usr_1"), handle.job_id.clone()).await;
    assert!(matches!(first, Err(ServiceError::MeteringProvider)));

    let second = service
        .status(usr("usr_1"), handle.job_id)
        .await
        .expect("re-poll settles");
    assert_completed_bytes(&second, &[3, 3, 3]);

    let charges = charge_calls(&os.events());
    assert_eq!(charges.len(), 2);
    // Both charges carry the SAME settlement key — a re-poll re-charges, never
    // re-keys under a fresh scope.
    assert_eq!(charges[0].1, charges[1].1);
}

#[tokio::test]
async fn charging_job_ignores_late_failure_and_replays_completed_video() {
    let os = Arc::new(BlockingChargeOsAccounts::default());
    let provider = Arc::new(MockVideoProvider::completed(0.11, vec![6, 6, 6]));
    let service = Arc::new(service(os.clone(), provider));
    let handle = service
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await
        .expect("generate succeeds");

    let polling = tokio::spawn({
        let service = service.clone();
        let job_id = handle.job_id.clone();
        async move { service.status(usr("usr_1"), job_id).await }
    });
    tokio::time::timeout(Duration::from_secs(1), os.wait_for_charge_started())
        .await
        .expect("charge should start");

    service
        .registry
        .mark_failed(&handle.job_id, "content_violation");
    os.release_charge();

    let first = polling
        .await
        .expect("poll task")
        .expect("settlement completes");
    assert_completed_bytes(&first, &[6, 6, 6]);

    let replay = service
        .status(usr("usr_1"), handle.job_id)
        .await
        .expect("re-poll replays the completed job");
    assert_completed_bytes(&replay, &[6, 6, 6]);
    assert_eq!(charge_calls(&os.events()).len(), 1);
}

// --- user Venice key is ignored for video ------------------------------------

#[tokio::test]
async fn user_venice_key_generate_is_still_metered_and_deduped() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(MockVideoProvider::completed(0.11, vec![7, 7]));
    let service = service(os.clone(), provider.clone());
    let mut params = generate_params("wan-2.2-a14b-text-to-video");
    params.request_id = Some("req_byok".to_string());
    params.provider_credentials = ProviderCredentials {
        venice_api_key: Some("vc_user_key".to_string()),
    };

    let first = service
        .generate(params.clone())
        .await
        .expect("generate succeeds");
    let second = service.generate(params).await.expect("generate dedupes");
    assert_eq!(first.job_id, second.job_id);
    assert_eq!(provider.queue_calls(), 1);

    let status = service
        .status(usr("usr_1"), first.job_id)
        .await
        .expect("status completes");
    assert_completed_bytes(&status, &[7, 7]);

    let events = os.events();
    assert_eq!(authorize_count(&events), 1);
    let charges = charge_calls(&events);
    assert_eq!(charges.len(), 1);
    assert_eq!(charges[0].0, 220);
}

#[tokio::test]
async fn user_venice_key_animate_is_still_metered() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(MockVideoProvider::completed(0.35, vec![8, 8]));
    let service = service(os.clone(), provider);
    let handle = service
        .animate(VideoAnimateParams {
            user_id: usr("usr_1"),
            request_id: Some("req_animate_user_key".to_string()),
            image_base64: "aGVsbG8=".to_string(),
            mime_type: "image/png".to_string(),
            prompt: "make it move".to_string(),
            model: None,
            duration: "5s".to_string(),
            resolution: Some("720p".to_string()),
            aspect_ratio: None,
            audio: None,
            negative_prompt: None,
            provider_credentials: ProviderCredentials {
                venice_api_key: Some("vc_user_key".to_string()),
            },
        })
        .await
        .expect("animate succeeds");

    let status = service
        .status(usr("usr_1"), handle.job_id)
        .await
        .expect("status completes");
    assert_completed_bytes(&status, &[8, 8]);

    let events = os.events();
    assert_eq!(authorize_count(&events), 1);
    let charges = charge_calls(&events);
    assert_eq!(charges.len(), 1);
    assert_eq!(charges[0].0, 700);
}

// --- cancellation-safe settlement --------------------------------------------

#[tokio::test]
async fn settlement_survives_outer_cancellation() {
    let os = Arc::new(BlockingChargeOsAccounts::default());
    let provider = Arc::new(MockVideoProvider::completed(0.11, vec![5, 5, 5]));
    let service = Arc::new(service(os.clone(), provider));
    let handle = service
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await
        .expect("generate succeeds");

    let polling = tokio::spawn({
        let service = service.clone();
        let job_id = handle.job_id.clone();
        async move { service.status(usr("usr_1"), job_id).await }
    });
    // Wait until the charge has started on the spawned settlement task, then
    // cancel the outer poll.
    tokio::time::timeout(Duration::from_secs(1), os.wait_for_charge_started())
        .await
        .expect("charge should start");
    polling.abort();
    assert!(polling.await.is_err());

    // Release the (independent) settlement task; it completes and marks Delivered
    // despite the cancelled outer poll.
    os.release_charge();

    let replay = tokio::time::timeout(
        Duration::from_secs(1),
        service.status(usr("usr_1"), handle.job_id),
    )
    .await
    .expect("re-poll should not hang")
    .expect("re-poll replays the settled job");
    assert_completed_bytes(&replay, &[5, 5, 5]);
    assert_eq!(charge_calls(&os.events()).len(), 1);
}

// --- not found / ownership ---------------------------------------------------

#[tokio::test]
async fn status_of_unknown_job_is_not_found() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(MockVideoProvider::completed(0.11, vec![1]));
    let result = service(os, provider)
        .status(usr("usr_1"), JobId("does-not-exist".to_string()))
        .await;

    assert!(matches!(result, Err(ServiceError::JobNotFound)));
}

#[tokio::test]
async fn status_is_scoped_to_the_job_owner() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(MockVideoProvider::completed(0.11, vec![1]));
    let service = service(os, provider);
    let handle = service
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await
        .expect("generate succeeds");

    // A different user must not learn the job exists, let alone settle/serve it.
    let result = service.status(usr("usr_other"), handle.job_id).await;
    assert!(matches!(result, Err(ServiceError::JobNotFound)));
}

// --- animate default model ---------------------------------------------------

#[tokio::test]
async fn animate_uses_the_default_model_and_charges_its_price() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(MockVideoProvider::completed(0.35, vec![2, 2]));
    let service = service(os.clone(), provider);
    let handle = service
        .animate(VideoAnimateParams {
            user_id: usr("usr_1"),
            request_id: None,
            image_base64: "aGVsbG8=".to_string(),
            mime_type: "image/png".to_string(),
            prompt: "make it move".to_string(),
            model: None,
            duration: "5s".to_string(),
            resolution: Some("720p".to_string()),
            aspect_ratio: None,
            audio: None,
            negative_prompt: None,
            provider_credentials: ProviderCredentials::default(),
        })
        .await
        .expect("animate succeeds");
    service
        .status(usr("usr_1"), handle.job_id)
        .await
        .expect("status completes");

    let events = os.events();
    assert_eq!(
        events[0],
        Call::Authorize {
            action: "video_animate".to_string(),
            estimate: 700,
        }
    );
    let charges = charge_calls(&events);
    assert_eq!(charges.len(), 1);
    assert_eq!(charges[0].0, 700);
    assert_attempt_charge_key("video_animate:usr_1:", &charges[0].1);
}

// --- vps download-url completion ---------------------------------------------

#[tokio::test]
async fn completed_url_status_returns_the_download_url() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(
        MockVideoProvider::completed(0.11, vec![1]).with_default_retrieve(
            MockRetrieve::CompletedUrl("https://cdn.venice.ai/vq.mp4".to_string()),
        ),
    );
    let service = service(os.clone(), provider);
    let handle = service
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await
        .expect("generate succeeds");

    let status = service
        .status(usr("usr_1"), handle.job_id)
        .await
        .expect("status completes");
    match status {
        VideoStatusOutput::Completed(GeneratedVideo {
            bytes,
            download_url,
            ..
        }) => {
            assert_eq!(bytes, None);
            assert_eq!(
                download_url,
                Some("https://cdn.venice.ai/vq.mp4".to_string())
            );
        }
        other => panic!("expected completed with url, got {other:?}"),
    }
    // A VPS-backed completion still charges exactly once.
    assert_eq!(charge_calls(&os.events()).len(), 1);
}

#[tokio::test]
async fn completed_url_without_usable_media_fails_terminally_without_charging() {
    let os = Arc::new(RecordingOsAccounts::new(true));
    let provider = Arc::new(
        MockVideoProvider::completed(0.11, vec![1])
            .with_default_retrieve(MockRetrieve::CompletedUrl(String::new())),
    );
    let service = service(os.clone(), provider);
    let handle = service
        .generate(generate_params("wan-2.2-a14b-text-to-video"))
        .await
        .expect("generate succeeds");

    let first = tokio::time::timeout(
        Duration::from_secs(1),
        service.status(usr("usr_1"), handle.job_id.clone()),
    )
    .await
    .expect("first status should not hang")
    .expect("first status resolves");
    assert_eq!(
        first,
        VideoStatusOutput::Failed {
            reason: "video_media_unavailable".to_string(),
        }
    );

    let second = tokio::time::timeout(
        Duration::from_secs(1),
        service.status(usr("usr_1"), handle.job_id),
    )
    .await
    .expect("second status should not hang")
    .expect("second status resolves");
    assert_eq!(
        second,
        VideoStatusOutput::Failed {
            reason: "video_media_unavailable".to_string(),
        }
    );
    assert_eq!(charge_calls(&os.events()), vec![release_call()]);
}

// --- registry eviction / ttl -------------------------------------------------

#[test]
fn registry_evicts_the_oldest_job_over_the_per_user_cap() {
    let registry = super::VideoJobRegistry::new();
    let created_at = Instant::now();
    for index in 0..=super::VIDEO_LEDGER_MAX_JOBS_PER_USER {
        registry.insert_job(sample_job(
            "usr_1",
            &format!("job-{index:03}"),
            created_at + Duration::from_secs(index as u64),
        ));
    }

    let state = registry.state();
    let count = state
        .jobs
        .values()
        .filter(|job| job.user_id == usr("usr_1"))
        .count();
    assert_eq!(count, super::VIDEO_LEDGER_MAX_JOBS_PER_USER);
    // The oldest is gone; the newest survives.
    assert!(!state.jobs.contains_key(&JobId("job-000".to_string())));
    assert!(state.jobs.contains_key(&JobId(format!(
        "job-{:03}",
        super::VIDEO_LEDGER_MAX_JOBS_PER_USER
    ))));
}

#[test]
fn registry_prunes_jobs_past_the_ttl() {
    let mut state = super::RegistryState::default();
    let created_at = Instant::now();
    state.jobs.insert(
        JobId("old".to_string()),
        sample_job("usr_1", "old", created_at),
    );
    super::prune_expired(
        &mut state,
        created_at + super::VIDEO_LEDGER_JOB_TTL + Duration::from_secs(1),
    );
    assert!(state.jobs.is_empty());
}

fn sample_job(user: &str, id: &str, created_at: Instant) -> super::VideoJob {
    super::VideoJob {
        job_id: JobId(id.to_string()),
        key: None,
        user_id: usr(user),
        action: june_domain::ActionSlug::VideoGenerate,
        model: "wan-2.2-a14b-text-to-video".to_string(),
        venice_queue_id: format!("vq_{id}"),
        download_url: None,
        charge: None,
        created_at,
        state: super::VideoJobState::Queued,
    }
}

// --- assertions --------------------------------------------------------------

fn assert_completed_bytes(status: &VideoStatusOutput, expected: &[u8]) {
    match status {
        VideoStatusOutput::Completed(GeneratedVideo { bytes, .. }) => {
            assert_eq!(bytes.as_deref(), Some(expected));
        }
        other => panic!("expected completed bytes, got {other:?}"),
    }
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
