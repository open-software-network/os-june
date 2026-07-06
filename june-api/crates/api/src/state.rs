use june_domain::{IssueReportSink, TokenVerifier};
use june_services::{
    AgentChatService, DictateService, ImageService, NoteGenerateService, NoteTranscribeService,
    PricingTable, VideoService, WebAugmentService,
};
use std::sync::Arc;

#[derive(Clone)]
pub struct ApiState {
    inner: Arc<ApiStateInner>,
}

struct ApiStateInner {
    pricing: Arc<PricingTable>,
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
    issue_reports: Arc<dyn IssueReportSink>,
    limits: ApiLimits,
    attestation: AttestationInfo,
}

#[derive(Clone, Copy)]
pub struct ApiLimits {
    pub max_audio_bytes: usize,
    pub max_json_bytes: usize,
    pub max_image_edit_bytes: usize,
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

pub struct ApiStateParams {
    pub pricing: Arc<PricingTable>,
    pub token_verifier: Arc<dyn TokenVerifier>,
    pub note_transcribe: Arc<NoteTranscribeService>,
    pub note_generate: Arc<NoteGenerateService>,
    pub agent_chat: Arc<AgentChatService>,
    pub dictate: Arc<DictateService>,
    pub web: Arc<WebAugmentService>,
    pub image: Arc<ImageService>,
    pub video: Arc<VideoService>,
    pub issue_reports: Arc<dyn IssueReportSink>,
    pub limits: ApiLimits,
    pub attestation: AttestationInfo,
}

impl ApiState {
    pub fn new(params: ApiStateParams) -> Self {
        Self {
            inner: Arc::new(ApiStateInner {
                pricing: params.pricing,
                token_verifier: params.token_verifier,
                note_transcribe: params.note_transcribe,
                note_generate: params.note_generate,
                agent_chat: params.agent_chat,
                dictate: params.dictate,
                web: params.web,
                image: params.image,
                video: params.video,
                issue_reports: params.issue_reports,
                limits: params.limits,
                attestation: params.attestation,
            }),
        }
    }

    pub(crate) fn pricing(&self) -> &PricingTable {
        &self.inner.pricing
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

    pub(crate) fn issue_reports(&self) -> &dyn IssueReportSink {
        self.inner.issue_reports.as_ref()
    }

    pub(crate) fn limits(&self) -> ApiLimits {
        self.inner.limits
    }

    pub(crate) fn attestation(&self) -> &AttestationInfo {
        &self.inner.attestation
    }
}
