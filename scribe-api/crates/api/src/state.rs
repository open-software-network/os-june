use crate::remote::RemoteHub;
use scribe_domain::{IssueReportSink, TokenVerifier};
use scribe_services::{
    AgentChatService, DictateService, NoteGenerateService, NoteTranscribeService, PricingTable,
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
    issue_reports: Arc<dyn IssueReportSink>,
    remote: RemoteHub,
    limits: ApiLimits,
    attestation: AttestationInfo,
}

#[derive(Clone, Copy)]
pub struct ApiLimits {
    pub max_audio_bytes: usize,
    pub max_json_bytes: usize,
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
                issue_reports: params.issue_reports,
                remote: RemoteHub::default(),
                limits: params.limits,
                attestation: params.attestation,
            }),
        }
    }

    pub(crate) fn pricing(&self) -> &PricingTable {
        &self.inner.pricing
    }

    pub(crate) fn remote(&self) -> &RemoteHub {
        &self.inner.remote
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
