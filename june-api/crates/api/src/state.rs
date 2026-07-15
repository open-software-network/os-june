use crate::error::ApiError;
use june_domain::{TokenVerifier, UserId};
use june_services::{
    AgentChatService, DictateService, ImageService, IssueReportService, NoteGenerateService,
    NoteTranscribeService, P3aReportService, PricingTable, VideoService, WebAugmentService,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{AcquireError, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

const ISSUE_REPORT_MAX_CONCURRENCY: usize = 1;

pub(crate) struct AgentAdmissionControl {
    body_budget_kib: Arc<Semaphore>,
    total_budget_kib: usize,
    per_user: Arc<Mutex<HashMap<UserId, usize>>>,
    max_per_user: usize,
}

pub(crate) struct AgentAdmission {
    _body_permit: OwnedSemaphorePermit,
    per_user: Arc<Mutex<HashMap<UserId, usize>>>,
    user_id: UserId,
}

impl AgentAdmissionControl {
    fn new(max_inflight_body_bytes: usize, max_per_user: usize) -> Self {
        let total_budget_kib = (max_inflight_body_bytes / 1024).max(1);
        Self {
            body_budget_kib: Arc::new(Semaphore::new(total_budget_kib)),
            total_budget_kib,
            per_user: Arc::new(Mutex::new(HashMap::new())),
            max_per_user,
        }
    }

    fn admit(&self, user_id: &UserId, content_length: usize) -> Result<AgentAdmission, ApiError> {
        let weight_kib = content_length
            .div_ceil(1024)
            .clamp(1, self.total_budget_kib);
        let weight_kib = u32::try_from(weight_kib).map_err(|_| ApiError::service_overloaded())?;
        let body_permit = self
            .body_budget_kib
            .clone()
            .try_acquire_many_owned(weight_kib)
            .map_err(|_| ApiError::service_overloaded())?;
        let Ok(mut per_user) = self.per_user.lock() else {
            return Err(ApiError::Internal);
        };
        let count = per_user.entry(user_id.clone()).or_insert(0);
        if *count >= self.max_per_user {
            return Err(ApiError::service_overloaded());
        }
        *count += 1;
        drop(per_user);

        Ok(AgentAdmission {
            _body_permit: body_permit,
            per_user: self.per_user.clone(),
            user_id: user_id.clone(),
        })
    }
}

impl Drop for AgentAdmission {
    fn drop(&mut self) {
        let Ok(mut per_user) = self.per_user.lock() else {
            return;
        };
        let remove = if let Some(count) = per_user.get_mut(&self.user_id) {
            *count = count.saturating_sub(1);
            *count == 0
        } else {
            false
        };
        if remove {
            per_user.remove(&self.user_id);
        }
    }
}

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
    agent_admission: AgentAdmissionControl,
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
    pub max_agent_chat_bytes: usize,
    pub max_agent_inflight_body_bytes: usize,
    pub max_agent_concurrent_requests_per_user: usize,
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
    pub gateway_attestation_required: bool,
    pub gateway_attestation_url: String,
    pub gateway_image_digest: String,
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
                agent_admission: AgentAdmissionControl::new(
                    params.limits.max_agent_inflight_body_bytes,
                    params.limits.max_agent_concurrent_requests_per_user,
                ),
                p3a_reports: params.p3a_reports,
                limits: params.limits,
                attestation: params.attestation,
            }),
        }
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

    pub(crate) fn admit_agent_request(
        &self,
        user_id: &UserId,
        content_length: usize,
    ) -> Result<AgentAdmission, ApiError> {
        self.inner.agent_admission.admit(user_id, content_length)
    }

    pub(crate) fn limits(&self) -> ApiLimits {
        self.inner.limits
    }

    pub(crate) fn attestation(&self) -> &AttestationInfo {
        &self.inner.attestation
    }
}

#[cfg(test)]
mod tests {
    use super::AgentAdmissionControl;
    use crate::ApiError;
    use june_domain::UserId;

    fn user(id: &str) -> UserId {
        UserId(id.to_string())
    }

    #[test]
    fn per_user_cap_load_sheds_beyond_limit() {
        let control = AgentAdmissionControl::new(1024 * 1024, 2);
        let user = user("usr_test");

        let first = control.admit(&user, 1024).expect("first admission");
        let _second = control.admit(&user, 1024).expect("second admission");
        let err = control.admit(&user, 1024).err().expect("third must shed");
        assert!(matches!(err, ApiError::ServiceOverloaded));

        drop(first);
        assert!(control.admit(&user, 1024).is_ok());
    }

    #[test]
    fn global_budget_load_sheds_when_exhausted() {
        let control = AgentAdmissionControl::new(10 * 1024, 100);
        let user_a = user("usr_a");
        let user_b = user("usr_b");

        let first = control.admit(&user_a, 8 * 1024).expect("first admission");
        let err = control
            .admit(&user_b, 8 * 1024)
            .err()
            .expect("second must shed");
        assert!(matches!(err, ApiError::ServiceOverloaded));

        drop(first);
        assert!(control.admit(&user_b, 8 * 1024).is_ok());
    }

    #[test]
    fn oversized_request_is_clamped_to_the_whole_budget() {
        let control = AgentAdmissionControl::new(4 * 1024, 100);
        let user_a = user("usr_a");
        let user_b = user("usr_b");

        let oversized = control
            .admit(&user_a, 100 * 1024 * 1024)
            .expect("oversized admission");
        let err = control
            .admit(&user_b, 1024)
            .err()
            .expect("concurrent request must shed");
        assert!(matches!(err, ApiError::ServiceOverloaded));

        drop(oversized);
        assert!(control.admit(&user_b, 1024).is_ok());
    }
}
