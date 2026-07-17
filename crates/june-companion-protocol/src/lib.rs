//! Versioned, bounded, capability-scoped messages exchanged by June desktop
//! and a linked June companion. Relay envelopes deliberately contain only
//! routing metadata and ciphertext.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_ENCODED_FRAME_BYTES: usize = 44 * 1024;
pub const MAX_CIPHERTEXT_BYTES: usize = 45 * 1024;
pub const MAX_RELAY_ENVELOPE_BYTES: usize = 64 * 1024;
pub const MAX_TEXT_BYTES: usize = 32 * 1024;
pub const MAX_PAGE_SIZE: u16 = 100;
pub const DEFAULT_CONTROL_TTL_MS: u64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    NotesRead,
    NotesEdit,
    AgentRead,
    AgentChat,
    AgentCancel,
    SettingsRead,
    SettingsEditSafe,
    RecordingControlExisting,
    AppFocus,
    DevicesReadSelf,
    DevicesRevokeSelf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub version: u16,
    pub operation_id: Uuid,
    pub sequence: u64,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub capability: Capability,
    pub body: Body,
}

impl Frame {
    pub fn new(
        operation_id: Uuid,
        sequence: u64,
        issued_at_ms: u64,
        capability: Capability,
        body: Body,
    ) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            operation_id,
            sequence,
            issued_at_ms,
            expires_at_ms: issued_at_ms.saturating_add(DEFAULT_CONTROL_TTL_MS),
            capability,
            body,
        }
    }

    pub fn validate(&self, now_ms: u64) -> Result<(), ProtocolError> {
        if self.version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion(self.version));
        }
        if now_ms > self.expires_at_ms {
            return Err(ProtocolError::Expired);
        }
        if self.expires_at_ms < self.issued_at_ms
            || self.expires_at_ms.saturating_sub(self.issued_at_ms) > DEFAULT_CONTROL_TTL_MS
        {
            return Err(ProtocolError::InvalidExpiry);
        }
        if self.capability != self.body.required_capability() {
            return Err(ProtocolError::CapabilityMismatch);
        }
        self.body.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum Body {
    NotesList(PageRequest),
    NoteGet {
        note_id: String,
    },
    NoteEdit(NoteEditRequest),
    AgentSessionsList(PageRequest),
    AgentMessagesList {
        stored_session_id: String,
        page: PageRequest,
    },
    AgentSend(AgentSendRequest),
    AgentCancel {
        stored_session_id: String,
    },
    SettingsGet,
    SettingsEditSafe(SafeSettingsPatch),
    RecordingPause {
        session_id: String,
    },
    RecordingResume {
        session_id: String,
    },
    RecordingStop {
        session_id: String,
    },
    RecordingGetActive,
    AppFocus {
        target: FocusTarget,
    },
    DeviceGetSelf,
    DeviceRevokeSelf,
    Response(Response),
    Event(Event),
}

impl Body {
    pub fn is_mutation(&self) -> bool {
        matches!(
            self,
            Self::NoteEdit(_)
                | Self::AgentSend(_)
                | Self::AgentCancel { .. }
                | Self::SettingsEditSafe(_)
                | Self::RecordingPause { .. }
                | Self::RecordingResume { .. }
                | Self::RecordingStop { .. }
                | Self::AppFocus { .. }
                | Self::DeviceRevokeSelf
        )
    }

    pub fn required_capability(&self) -> Capability {
        match self {
            Self::NotesList(_) | Self::NoteGet { .. } => Capability::NotesRead,
            Self::NoteEdit(_) => Capability::NotesEdit,
            Self::AgentSessionsList(_) | Self::AgentMessagesList { .. } => Capability::AgentRead,
            Self::AgentSend(_) => Capability::AgentChat,
            Self::AgentCancel { .. } => Capability::AgentCancel,
            Self::SettingsGet => Capability::SettingsRead,
            Self::SettingsEditSafe(_) => Capability::SettingsEditSafe,
            Self::RecordingPause { .. }
            | Self::RecordingResume { .. }
            | Self::RecordingStop { .. }
            | Self::RecordingGetActive => Capability::RecordingControlExisting,
            Self::AppFocus { .. } => Capability::AppFocus,
            Self::DeviceGetSelf => Capability::DevicesReadSelf,
            Self::DeviceRevokeSelf => Capability::DevicesRevokeSelf,
            Self::Response(response) => response.capability,
            Self::Event(event) => event.capability(),
        }
    }

    fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::NotesList(page) | Self::AgentSessionsList(page) => page.validate(),
            Self::AgentMessagesList {
                stored_session_id,
                page,
            } => {
                validate_id(stored_session_id)?;
                page.validate()
            }
            Self::NoteGet { note_id }
            | Self::AgentCancel {
                stored_session_id: note_id,
            }
            | Self::RecordingPause {
                session_id: note_id,
            }
            | Self::RecordingResume {
                session_id: note_id,
            }
            | Self::RecordingStop {
                session_id: note_id,
            } => validate_id(note_id),
            Self::NoteEdit(request) => request.validate(),
            Self::AgentSend(request) => request.validate(),
            Self::SettingsEditSafe(patch) if patch.is_empty() => Err(ProtocolError::EmptyPatch),
            Self::Event(Event::AgentDelta {
                stored_session_id,
                text,
            }) => {
                validate_id(stored_session_id)?;
                validate_text(text, MAX_TEXT_BYTES)
            }
            Self::Event(Event::AgentStatus {
                stored_session_id, ..
            }) => validate_id(stored_session_id),
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    pub cursor: Option<String>,
    pub limit: u16,
}

impl Default for PageRequest {
    fn default() -> Self {
        Self {
            cursor: None,
            limit: 50,
        }
    }
}

impl PageRequest {
    fn validate(&self) -> Result<(), ProtocolError> {
        if self.limit == 0 || self.limit > MAX_PAGE_SIZE {
            return Err(ProtocolError::InvalidPageSize);
        }
        if self
            .cursor
            .as_deref()
            .is_some_and(|value| value.len() > 512)
        {
            return Err(ProtocolError::TextTooLarge);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteEditRequest {
    pub note_id: String,
    pub expected_revision: u64,
    pub title: Option<String>,
    pub edited_content: Option<String>,
}

impl NoteEditRequest {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_id(&self.note_id)?;
        if self.expected_revision == 0 || (self.title.is_none() && self.edited_content.is_none()) {
            return Err(ProtocolError::EmptyPatch);
        }
        validate_optional_text(self.title.as_deref(), 512)?;
        validate_optional_text(self.edited_content.as_deref(), MAX_TEXT_BYTES)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSendRequest {
    pub stored_session_id: Option<String>,
    pub message: String,
}

impl AgentSendRequest {
    fn validate(&self) -> Result<(), ProtocolError> {
        if let Some(stored_session_id) = &self.stored_session_id {
            validate_id(stored_session_id)?;
        }
        validate_text(&self.message, MAX_TEXT_BYTES)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SafeSettingsPatch {
    pub dictation_style: Option<DictationStyle>,
    pub image_safe_mode: Option<bool>,
}

impl SafeSettingsPatch {
    pub fn is_empty(&self) -> bool {
        self.dictation_style.is_none() && self.image_safe_mode.is_none()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DictationStyle {
    Standard,
    CasualLowercase,
    Formal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FocusTarget {
    Agent { stored_session_id: Option<String> },
    Note { note_id: String },
    Settings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub capability: Capability,
    pub result: ResultPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum ResultPayload {
    Accepted,
    Notes(Page<NoteSummary>),
    Note(NoteRecord),
    AgentSessions(Page<AgentSession>),
    AgentMessages(Page<AgentMessage>),
    AgentAccepted { stored_session_id: String },
    Settings(SafeSettings),
    Recording(ActiveRecordingSnapshot),
    Device(DeviceSelf),
    Conflict(NoteConflict),
    Error(ProtocolFailure),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub revision: u64,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub id: String,
    pub title: String,
    pub edited_content: String,
    pub revision: u64,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteConflict {
    pub expected_revision: u64,
    pub current: NoteRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub title: String,
    pub status: AgentStatus,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentStatus {
    Idle,
    Running,
    WaitingForUser,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub id: String,
    pub role: MessageRole,
    pub text: String,
    pub created_at: String,
    pub streaming: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeSettings {
    pub dictation_style: DictationStyle,
    pub image_safe_mode: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRecordingSnapshot {
    pub active: Option<ActiveRecording>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRecording {
    pub session_id: String,
    pub state: ActiveRecordingState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActiveRecordingState {
    Recording,
    Paused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSelf {
    pub device_id: Uuid,
    pub display_name: String,
    pub linked_at: String,
    pub last_seen_at: Option<String>,
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolFailure {
    pub code: FailureCode,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    Unauthorized,
    Revoked,
    Expired,
    Replay,
    Unsupported,
    InvalidRequest,
    NotFound,
    Conflict,
    MacOffline,
    Busy,
    OutcomeUnknown,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum Event {
    AgentDelta {
        stored_session_id: String,
        text: String,
    },
    AgentStatus {
        stored_session_id: String,
        status: AgentStatus,
    },
    NotesChanged {
        cursor: Option<String>,
    },
    DeviceRevoked,
    ResyncRequired,
}

impl Event {
    pub fn capability(&self) -> Capability {
        match self {
            Self::AgentDelta { .. } | Self::AgentStatus { .. } => Capability::AgentRead,
            Self::NotesChanged { .. } => Capability::NotesRead,
            Self::DeviceRevoked => Capability::DevicesReadSelf,
            Self::ResyncRequired => Capability::DevicesReadSelf,
        }
    }
}

/// This is the only structure the blind relay parses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayEnvelope {
    pub version: u16,
    pub sender_device_id: Uuid,
    pub recipient_device_id: Uuid,
    pub message_id: Uuid,
    pub created_at_ms: u64,
    #[serde(with = "base64_bytes")]
    pub ciphertext: Vec<u8>,
}

mod base64_bytes {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &[u8], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&STANDARD.encode(value))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = String::deserialize(deserializer)?;
        STANDARD.decode(encoded).map_err(serde::de::Error::custom)
    }
}

impl RelayEnvelope {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion(self.version));
        }
        if self.sender_device_id == self.recipient_device_id {
            return Err(ProtocolError::InvalidRoute);
        }
        if self.ciphertext.is_empty() || self.ciphertext.len() > MAX_CIPHERTEXT_BYTES {
            return Err(ProtocolError::FrameTooLarge);
        }
        Ok(())
    }
}

pub fn encode_frame(frame: &Frame) -> Result<Vec<u8>, ProtocolError> {
    let encoded = serde_json::to_vec(frame).map_err(ProtocolError::Json)?;
    if encoded.len() > MAX_ENCODED_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge);
    }
    Ok(encoded)
}

pub fn decode_frame(encoded: &[u8], now_ms: u64) -> Result<Frame, ProtocolError> {
    if encoded.len() > MAX_ENCODED_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge);
    }
    let frame: Frame = serde_json::from_slice(encoded).map_err(ProtocolError::Json)?;
    frame.validate(now_ms)?;
    Ok(frame)
}

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("unsupported protocol version {0}")]
    UnsupportedVersion(u16),
    #[error("frame expired")]
    Expired,
    #[error("invalid frame expiry")]
    InvalidExpiry,
    #[error("capability does not match the message body")]
    CapabilityMismatch,
    #[error("frame is too large")]
    FrameTooLarge,
    #[error("text is empty or too large")]
    TextTooLarge,
    #[error("identifier is empty or too large")]
    InvalidIdentifier,
    #[error("page size is outside the supported range")]
    InvalidPageSize,
    #[error("patch has no editable fields")]
    EmptyPatch,
    #[error("relay route is invalid")]
    InvalidRoute,
    #[error("invalid JSON: {0}")]
    Json(serde_json::Error),
}

fn validate_id(value: &str) -> Result<(), ProtocolError> {
    if value.is_empty() || value.len() > 256 {
        Err(ProtocolError::InvalidIdentifier)
    } else {
        Ok(())
    }
}

fn validate_text(value: &str, max: usize) -> Result<(), ProtocolError> {
    if value.trim().is_empty() || value.len() > max {
        Err(ProtocolError::TextTooLarge)
    } else {
        Ok(())
    }
}

fn validate_optional_text(value: Option<&str>, max: usize) -> Result<(), ProtocolError> {
    if value.is_some_and(|value| value.len() > max) {
        Err(ProtocolError::TextTooLarge)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip_preserves_the_versioned_contract() {
        let now = 1_000_000;
        let frame = Frame::new(
            Uuid::nil(),
            7,
            now,
            Capability::NotesRead,
            Body::NotesList(PageRequest::default()),
        );
        let encoded = encode_frame(&frame).unwrap();
        assert_eq!(decode_frame(&encoded, now + 1).unwrap(), frame);
    }

    #[test]
    fn rejects_expired_or_overlong_control_frames() {
        let now = 1_000_000;
        let mut frame = Frame::new(
            Uuid::nil(),
            1,
            now,
            Capability::SettingsRead,
            Body::SettingsGet,
        );
        assert!(matches!(
            frame.validate(now + DEFAULT_CONTROL_TTL_MS + 1),
            Err(ProtocolError::Expired)
        ));
        frame.expires_at_ms = now + DEFAULT_CONTROL_TTL_MS + 1;
        assert!(matches!(
            frame.validate(now),
            Err(ProtocolError::InvalidExpiry)
        ));
    }

    #[test]
    fn rejects_capability_confusion() {
        let frame = Frame::new(
            Uuid::nil(),
            1,
            100,
            Capability::AgentChat,
            Body::SettingsGet,
        );
        assert!(matches!(
            frame.validate(100),
            Err(ProtocolError::CapabilityMismatch)
        ));
    }

    #[test]
    fn classifies_every_side_effecting_request_as_a_mutation() {
        assert!(
            Body::NoteEdit(NoteEditRequest {
                note_id: "note-1".to_string(),
                expected_revision: 1,
                title: None,
                edited_content: Some("updated".to_string()),
            })
            .is_mutation()
        );
        assert!(
            Body::AgentSend(AgentSendRequest {
                stored_session_id: None,
                message: "hello".to_string(),
            })
            .is_mutation()
        );
        assert!(
            Body::RecordingStop {
                session_id: "runtime-1".to_string(),
            }
            .is_mutation()
        );
        assert!(
            Body::AppFocus {
                target: FocusTarget::Agent {
                    stored_session_id: None,
                },
            }
            .is_mutation()
        );
        assert!(!Body::NotesList(PageRequest::default()).is_mutation());
        assert!(!Body::SettingsGet.is_mutation());
    }

    #[test]
    fn rejects_unbounded_messages_and_pages() {
        let message = "x".repeat(MAX_TEXT_BYTES + 1);
        let frame = Frame::new(
            Uuid::nil(),
            1,
            100,
            Capability::AgentChat,
            Body::AgentSend(AgentSendRequest {
                stored_session_id: None,
                message,
            }),
        );
        assert!(matches!(
            frame.validate(100),
            Err(ProtocolError::TextTooLarge)
        ));

        let page = PageRequest {
            cursor: None,
            limit: MAX_PAGE_SIZE + 1,
        };
        assert!(matches!(
            page.validate(),
            Err(ProtocolError::InvalidPageSize)
        ));
    }

    #[test]
    fn relay_only_accepts_bounded_ciphertext_between_distinct_devices() {
        let mut envelope = RelayEnvelope {
            version: PROTOCOL_VERSION,
            sender_device_id: Uuid::nil(),
            recipient_device_id: Uuid::new_v4(),
            message_id: Uuid::new_v4(),
            created_at_ms: 100,
            ciphertext: vec![1, 2, 3],
        };
        envelope.validate().unwrap();
        let encoded = serde_json::to_vec(&envelope).unwrap();
        let decoded: RelayEnvelope = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded.ciphertext, vec![1, 2, 3]);
        envelope.ciphertext = vec![0; MAX_CIPHERTEXT_BYTES + 1];
        assert!(matches!(
            envelope.validate(),
            Err(ProtocolError::FrameTooLarge)
        ));
    }
}
