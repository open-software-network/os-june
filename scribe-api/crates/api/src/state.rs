use scribe_domain::{IssueReportSink, TokenVerifier, ToolGuardAnalyzer, UserId};
use scribe_services::{
    AgentChatService, DictateService, NoteGenerateService, NoteTranscribeService, PricingTable,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const DIRECT_CHAT_GRANT_TTL: Duration = Duration::from_mins(15);
const MAX_DIRECT_CHAT_GRANTS: usize = 1024;

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
    /// None only for manually constructed states. The app builder requires
    /// OS-Guard and wires this analyzer in normal deployments.
    tool_guard: Option<Arc<dyn ToolGuardAnalyzer>>,
    direct_chat_grants: Mutex<DirectChatGrantStore>,
    limits: ApiLimits,
    attestation: AttestationInfo,
}

#[derive(Default)]
struct DirectChatGrantStore {
    grants: HashMap<String, DirectChatGrant>,
}

struct DirectChatGrant {
    user_id: UserId,
    blocked_conversation: String,
    session_keys: Vec<String>,
    expires_at: Instant,
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
    /// Whether chat prompts/context are redacted by the OS-Guard privacy
    /// gateway before reaching Venice. Drives the `/verify` privacy copy.
    /// Normal app configuration sets this to true.
    pub chat_via_osguard: bool,
}

pub struct ApiStateParams {
    pub pricing: Arc<PricingTable>,
    pub token_verifier: Arc<dyn TokenVerifier>,
    pub note_transcribe: Arc<NoteTranscribeService>,
    pub note_generate: Arc<NoteGenerateService>,
    pub agent_chat: Arc<AgentChatService>,
    pub dictate: Arc<DictateService>,
    pub issue_reports: Arc<dyn IssueReportSink>,
    pub tool_guard: Option<Arc<dyn ToolGuardAnalyzer>>,
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
                tool_guard: params.tool_guard,
                direct_chat_grants: Mutex::new(DirectChatGrantStore::default()),
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

    pub(crate) fn issue_reports(&self) -> &dyn IssueReportSink {
        self.inner.issue_reports.as_ref()
    }

    pub(crate) fn tool_guard(&self) -> Option<&dyn ToolGuardAnalyzer> {
        self.inner.tool_guard.as_deref()
    }

    pub(crate) fn limits(&self) -> ApiLimits {
        self.inner.limits
    }

    pub(crate) fn attestation(&self) -> &AttestationInfo {
        &self.inner.attestation
    }

    pub(crate) fn issue_direct_chat_grant(&self, user_id: &UserId, body: &Value) -> Option<String> {
        let blocked_conversation = policy_block_conversation_fingerprint(body)?;
        let token = direct_chat_token()?;
        let mut store = self.inner.direct_chat_grants.lock().ok()?;
        store.cleanup_expired();
        store.trim_to_capacity();
        store.grants.insert(
            token.clone(),
            DirectChatGrant {
                user_id: user_id.clone(),
                blocked_conversation,
                session_keys: Vec::new(),
                expires_at: Instant::now() + DIRECT_CHAT_GRANT_TTL,
            },
        );
        Some(token)
    }

    pub(crate) fn direct_chat_grant_matches(
        &self,
        token: &str,
        user_id: &UserId,
        body: &Value,
    ) -> bool {
        let Ok(mut store) = self.inner.direct_chat_grants.lock() else {
            return false;
        };
        store.cleanup_expired();
        let Some(grant) = store.grants.get_mut(token) else {
            return false;
        };
        if &grant.user_id != user_id {
            return false;
        }
        let matches_blocked_conversation = policy_block_conversation_fingerprint(body).as_ref()
            == Some(&grant.blocked_conversation);
        let matches_direct_session = policy_block_direct_session_keys(body)
            .iter()
            .any(|candidate| grant.session_keys.iter().any(|stored| stored == candidate));
        if matches_blocked_conversation || matches_direct_session {
            grant.expires_at = Instant::now() + DIRECT_CHAT_GRANT_TTL;
            return true;
        }
        false
    }

    pub(crate) fn remember_direct_chat_session_key(
        &self,
        token: &str,
        request_body: &Value,
        response_body: &[u8],
    ) {
        let Some(key) = policy_block_direct_session_key(request_body, response_body) else {
            return;
        };
        let Ok(mut store) = self.inner.direct_chat_grants.lock() else {
            return;
        };
        store.cleanup_expired();
        let Some(grant) = store.grants.get_mut(token) else {
            return;
        };
        if !grant.session_keys.iter().any(|stored| stored == &key) {
            grant.session_keys.push(key);
        }
        grant.expires_at = Instant::now() + DIRECT_CHAT_GRANT_TTL;
    }
}

impl DirectChatGrantStore {
    fn cleanup_expired(&mut self) {
        let now = Instant::now();
        self.grants.retain(|_, grant| grant.expires_at > now);
    }

    fn trim_to_capacity(&mut self) {
        if self.grants.len() < MAX_DIRECT_CHAT_GRANTS {
            return;
        }
        let remove_count = self.grants.len() - MAX_DIRECT_CHAT_GRANTS + 1;
        let tokens = self
            .grants
            .keys()
            .take(remove_count)
            .cloned()
            .collect::<Vec<_>>();
        for token in tokens {
            self.grants.remove(&token);
        }
    }
}

fn direct_chat_token() -> Option<String> {
    let mut bytes = [0_u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .ok()?;
    Some(hex_lower(&bytes))
}

fn policy_block_conversation_fingerprint(body: &Value) -> Option<String> {
    policy_block_conversation_fingerprints(body).pop()
}

fn policy_block_conversation_fingerprints(body: &Value) -> Vec<String> {
    let system_prefix = body
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| system_message_prefix(messages))
        .unwrap_or_default();
    let Some(messages) = body.get("messages").and_then(Value::as_array) else {
        return Vec::new();
    };
    messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .filter_map(|message| chat_message_content_text(message.get("content")?))
        .map(|user_text| policy_block_text_fingerprint(&system_prefix, &user_text))
        .collect()
}

fn policy_block_direct_session_key(
    blocked_body: &Value,
    direct_response_body: &[u8],
) -> Option<String> {
    let conversation = policy_block_conversation_fingerprint(blocked_body)?;
    let assistant = assistant_message_fingerprint_from_chat_response_body(direct_response_body)?;
    Some(policy_block_session_key(&conversation, &assistant))
}

fn policy_block_direct_session_keys(body: &Value) -> Vec<String> {
    let system_prefix = body
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| system_message_prefix(messages))
        .unwrap_or_default();
    let Some(messages) = body.get("messages").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut keys = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        if message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let Some(user_text) = message.get("content").and_then(chat_message_content_text) else {
            continue;
        };
        let conversation = policy_block_text_fingerprint(&system_prefix, &user_text);
        let Some(assistant) = next_assistant_message_fingerprint(&messages[index + 1..]) else {
            continue;
        };
        keys.push(policy_block_session_key(&conversation, &assistant));
    }
    keys
}

fn system_message_prefix(messages: &[Value]) -> String {
    messages
        .iter()
        .take_while(|message| message.get("role").and_then(Value::as_str) == Some("system"))
        .filter_map(|message| chat_message_content_text(message.get("content")?))
        .collect::<Vec<_>>()
        .join("\n")
}

fn next_assistant_message_fingerprint(messages: &[Value]) -> Option<String> {
    for message in messages {
        match message.get("role").and_then(Value::as_str) {
            Some("assistant") => return assistant_message_fingerprint(message),
            Some("user") => return None,
            _ => {}
        }
    }
    None
}

fn assistant_message_fingerprint_from_chat_response_body(body: &[u8]) -> Option<String> {
    let value = serde_json::from_slice::<Value>(body).ok()?;
    let message = value
        .get("choices")
        .and_then(Value::as_array)?
        .first()?
        .get("message")?;
    assistant_message_fingerprint(message)
}

fn assistant_message_fingerprint(message: &Value) -> Option<String> {
    let content = message
        .get("content")
        .and_then(chat_message_content_text)
        .unwrap_or_default();
    let tool_calls = message.get("tool_calls").cloned().unwrap_or(Value::Null);
    let has_tool_calls = tool_calls.as_array().is_some_and(|items| !items.is_empty())
        || (!tool_calls.is_null() && !tool_calls.is_array());
    if content.is_empty() && !has_tool_calls {
        return None;
    }
    let value = serde_json::json!({
        "assistant": content,
        "tool_calls": tool_calls,
    });
    Some(policy_block_body_fingerprint(&value))
}

fn chat_message_content_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(|item| {
                    if item.get("type").and_then(Value::as_str) == Some("text") {
                        item.get("text").and_then(Value::as_str)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            if text.is_empty() { None } else { Some(text) }
        }
        _ => None,
    }
}

fn policy_block_text_fingerprint(system_prefix: &str, user_text: &str) -> String {
    policy_block_body_fingerprint(&serde_json::json!({
        "system": system_prefix,
        "user": user_text,
    }))
}

fn policy_block_session_key(conversation: &str, assistant: &str) -> String {
    policy_block_body_fingerprint(&serde_json::json!({
        "conversation": conversation,
        "assistant": assistant,
    }))
}

fn policy_block_body_fingerprint(value: &Value) -> String {
    let digest = Sha256::digest(value.to_string().as_bytes());
    hex_lower(&digest)
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}
