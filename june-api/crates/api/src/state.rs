use june_domain::TokenVerifier;
use june_services::{
    AgentChatService, DictateService, ImageService, IssueReportService, NoteGenerateService,
    NoteTranscribeService, P3aReportService, PricingTable, ShareService, VideoService,
    WebAugmentService,
};
use std::{sync::Arc, time::Duration};
use tokio::sync::{AcquireError, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

const ISSUE_REPORT_MAX_CONCURRENCY: usize = 1;

/// Shared ownership keeps the one issue-report permit alive until both the
/// delivery task and the HTTP response body have finished (or been dropped).
pub(crate) struct IssueReportPermit {
    _permit: OwnedSemaphorePermit,
}

/// One absolute request deadline shared by permit wait, multipart extraction,
/// and streamed delivery. Copying it never resets the request budget.
#[derive(Clone, Copy)]
pub(crate) struct IssueReportDeadline(Instant);

impl IssueReportDeadline {
    pub(crate) fn from_now(timeout: Duration) -> Self {
        Self(Instant::now() + timeout)
    }

    pub(crate) fn instant(self) -> Instant {
        self.0
    }
}

#[derive(Clone)]
pub(crate) struct IssueReportRequestContext {
    pub(crate) permit: Arc<IssueReportPermit>,
    pub(crate) deadline: IssueReportDeadline,
}

#[derive(Clone)]
pub struct ApiState {
    inner: Arc<ApiStateInner>,
}

struct ApiStateInner {
    pricing: Arc<PricingTable>,
    local_dev_enabled: bool,
    token_verifier: Arc<dyn TokenVerifier>,
    note_transcribe: Arc<NoteTranscribeService>,
    note_generate: Arc<NoteGenerateService>,
    agent_chat: Arc<AgentChatService>,
    dictate: Arc<DictateService>,
    web: Arc<WebAugmentService>,
    // Image generation is metered (authorize -> generate -> charge), so it is
    // held as a service like the other billed surfaces rather than the bare
    // provider.
    image: Arc<ImageService>,
    // Video generation is metered as an async job (authorize -> quote -> queue,
    // then charge on the completing poll), held as a service like image.
    video: Arc<VideoService>,
    issue_reports: Arc<IssueReportService>,
    issue_report_permits: Arc<Semaphore>,
    // Private sharing (JUN-308). None until a share database is configured;
    // handlers answer 501 sharing_unavailable in that state.
    share: Option<Arc<ShareService>>,
    share_viewer: ShareViewerInfo,
    share_rate: ShareRateLimiter,
    share_http: reqwest::Client,
    p3a_reports: Arc<P3aReportService>,
    limits: ApiLimits,
    attestation: AttestationInfo,
}

#[derive(Clone, Copy)]
pub struct ApiLimits {
    pub max_audio_bytes: usize,
    pub max_json_bytes: usize,
    pub max_issue_report_bytes: usize,
    pub max_image_edit_bytes: usize,
    /// Body cap for share create/add-invites: the base64-encoded ciphertext
    /// plus envelope/JSON overhead (~4/3 of `share.max_ciphertext_bytes`).
    pub max_share_body_bytes: usize,
    pub request_timeout_secs: u64,
}

/// Public deployment facts rendered by the `/verify` attestation page.
#[derive(Clone)]
pub struct AttestationInfo {
    /// Full git commit the running image was built from; empty when the
    /// build did not stamp one (local/dev builds).
    pub source_commit: String,
    pub source_repo_url: String,
    pub image_repo: String,
    pub trust_center_url: String,
}

/// Static facts the browser viewer page needs to run its PKCE sign-in.
#[derive(Clone, Debug, Default)]
pub struct ShareViewerInfo {
    /// OS Accounts site origin (sign-in UI).
    pub accounts_url: String,
    /// OS Accounts API origin (token exchange proxy target).
    pub accounts_api_url: String,
    /// Public OAuth client id registered for the viewer.
    pub client_id: String,
}

/// Minimal fixed-window limiter for share endpoints (JUN-308: rate-limit
/// invite and access attempts). Single-instance CVM makes in-memory state
/// sufficient; the window is per user id.
pub(crate) struct ShareRateLimiter {
    hits: std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, u32)>>,
}

impl Default for ShareRateLimiter {
    fn default() -> Self {
        Self {
            hits: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }
}

impl ShareRateLimiter {
    const WINDOW: std::time::Duration = std::time::Duration::from_mins(1);
    const MAX_PER_WINDOW: u32 = 60;

    /// Returns false when the caller is over budget for the current window.
    pub(crate) fn allow(&self, key: &str) -> bool {
        // A poisoned lock must not fail OPEN on a security gate: recover the
        // inner map (the state is a counter table; a panicking writer cannot
        // corrupt it in a way that matters more than losing the gate).
        let mut hits = self
            .hits
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let now = std::time::Instant::now();
        // Opportunistic cleanup keeps the map bounded by active users.
        hits.retain(|_, (start, _)| now.duration_since(*start) < Self::WINDOW);
        let entry = hits.entry(key.to_string()).or_insert((now, 0));
        if now.duration_since(entry.0) >= Self::WINDOW {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= Self::MAX_PER_WINDOW
    }
}

pub struct ApiStateParams {
    pub pricing: Arc<PricingTable>,
    pub local_dev_enabled: bool,
    pub token_verifier: Arc<dyn TokenVerifier>,
    pub note_transcribe: Arc<NoteTranscribeService>,
    pub note_generate: Arc<NoteGenerateService>,
    pub agent_chat: Arc<AgentChatService>,
    pub dictate: Arc<DictateService>,
    pub web: Arc<WebAugmentService>,
    pub image: Arc<ImageService>,
    pub video: Arc<VideoService>,
    pub issue_reports: Arc<IssueReportService>,
    pub p3a_reports: Arc<P3aReportService>,
    pub share: Option<Arc<ShareService>>,
    pub share_viewer: ShareViewerInfo,
    pub limits: ApiLimits,
    pub attestation: AttestationInfo,
}

impl ApiState {
    pub fn new(params: ApiStateParams) -> Self {
        Self {
            inner: Arc::new(ApiStateInner {
                pricing: params.pricing,
                local_dev_enabled: params.local_dev_enabled,
                token_verifier: params.token_verifier,
                note_transcribe: params.note_transcribe,
                note_generate: params.note_generate,
                agent_chat: params.agent_chat,
                dictate: params.dictate,
                web: params.web,
                image: params.image,
                video: params.video,
                issue_reports: params.issue_reports,
                issue_report_permits: Arc::new(Semaphore::new(ISSUE_REPORT_MAX_CONCURRENCY)),
                share: params.share,
                share_viewer: params.share_viewer,
                share_rate: ShareRateLimiter::default(),
                share_http: reqwest::Client::new(),
                p3a_reports: params.p3a_reports,
                limits: params.limits,
                attestation: params.attestation,
            }),
        }
    }

    pub(crate) fn share(&self) -> Option<&ShareService> {
        self.inner.share.as_deref()
    }

    pub(crate) fn share_viewer(&self) -> &ShareViewerInfo {
        &self.inner.share_viewer
    }

    pub(crate) fn share_rate(&self) -> &ShareRateLimiter {
        &self.inner.share_rate
    }

    pub(crate) fn share_viewer_accounts_api(&self) -> String {
        self.inner
            .share_viewer
            .accounts_api_url
            .trim_end_matches('/')
            .to_string()
    }

    pub(crate) fn share_http(&self) -> &reqwest::Client {
        &self.inner.share_http
    }

    pub(crate) fn pricing(&self) -> &PricingTable {
        &self.inner.pricing
    }

    pub(crate) fn local_dev_enabled(&self) -> bool {
        self.inner.local_dev_enabled
    }

    pub(crate) fn token_verifier(&self) -> &dyn TokenVerifier {
        self.inner.token_verifier.as_ref()
    }

    pub(crate) fn note_transcribe(&self) -> &NoteTranscribeService {
        &self.inner.note_transcribe
    }

    pub(crate) fn note_generate(&self) -> &NoteGenerateService {
        &self.inner.note_generate
    }

    pub(crate) fn agent_chat(&self) -> &AgentChatService {
        &self.inner.agent_chat
    }

    pub(crate) fn dictate(&self) -> &DictateService {
        &self.inner.dictate
    }

    pub(crate) fn web(&self) -> &WebAugmentService {
        &self.inner.web
    }

    pub(crate) fn image(&self) -> &ImageService {
        &self.inner.image
    }

    pub(crate) fn video(&self) -> &VideoService {
        &self.inner.video
    }

    pub(crate) fn issue_reports(&self) -> &IssueReportService {
        &self.inner.issue_reports
    }

    pub(crate) async fn acquire_issue_report_permit(
        &self,
    ) -> Result<Arc<IssueReportPermit>, AcquireError> {
        let permit = self
            .inner
            .issue_report_permits
            .clone()
            .acquire_owned()
            .await?;
        Ok(Arc::new(IssueReportPermit { _permit: permit }))
    }

    pub(crate) fn p3a_reports(&self) -> &P3aReportService {
        &self.inner.p3a_reports
    }

    pub(crate) fn limits(&self) -> ApiLimits {
        self.inner.limits
    }

    pub(crate) fn attestation(&self) -> &AttestationInfo {
        &self.inner.attestation
    }
}
