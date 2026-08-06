//! Versioned, bounded, capability-scoped messages exchanged by Clovy desktop
//! and a linked Clovy Companion. Relay envelopes deliberately contain only
//! routing metadata and ciphertext.

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use std::collections::HashSet;
use thiserror::Error;
use uuid::Uuid;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_ENCODED_FRAME_BYTES: usize = 44 * 1024;
pub const MAX_CIPHERTEXT_BYTES: usize = 45 * 1024;
pub const MAX_RELAY_ENVELOPE_BYTES: usize = 64 * 1024;
pub const MAX_TEXT_BYTES: usize = 32 * 1024;
pub const MAX_PAGE_SIZE: u16 = 100;
pub const MAX_DEVICE_DISPLAY_NAME_BYTES: usize = 128;
pub const MAX_PAGE_CURSOR_BYTES: usize = 512;
pub const MAX_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_UPLOAD_CHUNK_BYTES: usize = 32 * 1024;
pub const MAX_ATTACHMENT_REFERENCES: usize = 8;
pub const MAX_BROWSE_ROOTS: usize = 16;
pub const MAX_FILE_NAME_BYTES: usize = 255;
pub const MAX_MEDIA_TYPE_BYTES: usize = 127;
pub const MAX_RELATIVE_PATH_BYTES: usize = 2 * 1024;
pub const MAX_MODEL_OPTIONS: usize = 8;
pub const MAX_MODEL_NAME_BYTES: usize = 256;
pub const MAX_MODEL_PROVIDER_BYTES: usize = 64;
pub const MAX_MODEL_DESCRIPTION_BYTES: usize = 512;
pub const MAX_MODEL_LABEL_BYTES: usize = 128;
pub const MAX_MEDIA_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_MEDIA_CHUNK_BYTES: usize = 31 * 1024;
pub const MAX_MEDIA_REFERENCES: usize = 8;
pub const MAX_MEDIA_DIMENSION_PX: u32 = 32_768;
pub const MAX_MEDIA_DURATION_MS: u64 = 6 * 60 * 60 * 1_000;
pub const DEFAULT_CONTROL_TTL_MS: u64 = 30_000;
pub const COMPUTER_USE_APPROVAL_TTL_MS: u64 = 60_000;
pub const MAX_COMPUTER_USE_APPROVAL_ID_BYTES: usize = 128;
pub const MAX_COMPUTER_USE_ACTION_BYTES: usize = 64;
pub const MAX_COMPUTER_USE_DESCRIPTION_BYTES: usize = 2 * 1024;
pub const MAX_COMPUTER_USE_TARGET_APP_BYTES: usize = 256;
pub const MAX_COMPUTER_USE_TARGET_URL_BYTES: usize = 2 * 1024;
pub const MAX_PEER_CAPABILITIES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    NotesRead,
    NotesEdit,
    AgentRead,
    AgentChat,
    AgentCancel,
    ModelRead,
    ModelEdit,
    MediaRead,
    SettingsRead,
    SettingsEditSafe,
    RecordingControlExisting,
    AppFocus,
    FilesUpload,
    FilesBrowse,
    DevicesReadSelf,
    DevicesRevokeSelf,
    ComputerUseApprove,
}

fn deserialize_peer_capabilities<'de, D>(deserializer: D) -> Result<Vec<Capability>, D::Error>
where
    D: Deserializer<'de>,
{
    let names = Vec::<String>::deserialize(deserializer)?;
    if names.len() > MAX_PEER_CAPABILITIES {
        return Err(D::Error::custom("too many peer capabilities"));
    }
    Ok(names
        .into_iter()
        .filter_map(|name| serde_json::from_value(serde_json::Value::String(name)).ok())
        .collect())
}

/// Optional authenticated Noise-handshake payload sent by a linked device.
///
/// An empty handshake payload remains valid for older companions and means
/// that no optional receive-side capabilities were advertised.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerHello {
    #[serde(default, deserialize_with = "deserialize_peer_capabilities")]
    pub capabilities: Vec<Capability>,
}

impl PeerHello {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.capabilities.len() > MAX_PEER_CAPABILITIES {
            return Err(ProtocolError::InvalidCapabilities);
        }
        let unique = self.capabilities.iter().copied().collect::<HashSet<_>>();
        if unique.len() != self.capabilities.len() {
            return Err(ProtocolError::InvalidCapabilities);
        }
        Ok(())
    }
}

pub fn encode_peer_hello(hello: &PeerHello) -> Result<Vec<u8>, ProtocolError> {
    hello.validate()?;
    serde_json::to_vec(hello).map_err(ProtocolError::Json)
}

pub fn decode_peer_hello(encoded: &[u8]) -> Result<PeerHello, ProtocolError> {
    if encoded.is_empty() {
        return Ok(PeerHello::default());
    }
    let hello = serde_json::from_slice::<PeerHello>(encoded).map_err(ProtocolError::Json)?;
    hello.validate()?;
    Ok(hello)
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
        #[serde(rename = "noteId", alias = "note_id")]
        note_id: String,
    },
    NoteEdit(NoteEditRequest),
    AgentSessionsList(PageRequest),
    AgentMessagesList {
        #[serde(rename = "storedSessionId", alias = "stored_session_id")]
        stored_session_id: String,
        page: PageRequest,
    },
    AgentSend(AgentSendRequest),
    UploadBegin(UploadBeginRequest),
    UploadChunk(UploadChunkRequest),
    UploadCommit {
        reservation_id: Uuid,
    },
    BrowseRootsList,
    BrowseDirList {
        root_id: Uuid,
        relative_path: String,
        page: PageRequest,
    },
    BrowseFileStat {
        root_id: Uuid,
        relative_path: String,
    },
    MediaFetch(MediaFetchRequest),
    AgentCancel {
        #[serde(rename = "storedSessionId", alias = "stored_session_id")]
        stored_session_id: String,
    },
    ModelsList,
    SessionModelGet {
        #[serde(rename = "storedSessionId", alias = "stored_session_id")]
        stored_session_id: String,
    },
    SessionModelSet(SessionModelSetRequest),
    SettingsGet,
    SettingsEditSafe(SafeSettingsPatch),
    RecordingPause {
        #[serde(rename = "recordingSessionId", alias = "recording_session_id")]
        recording_session_id: String,
    },
    RecordingResume {
        #[serde(rename = "recordingSessionId", alias = "recording_session_id")]
        recording_session_id: String,
    },
    RecordingStop {
        #[serde(rename = "recordingSessionId", alias = "recording_session_id")]
        recording_session_id: String,
    },
    RecordingGetActive,
    AppFocus {
        target: FocusTarget,
    },
    DeviceGetSelf,
    DeviceRevokeSelf,
    ComputerUseApprovalReceived(ComputerUseApprovalReceipt),
    ComputerUseApprovalRespond(ComputerUseApprovalDecisionRequest),
    Response(Response),
    Event(Event),
}

impl Body {
    pub fn is_mutation(&self) -> bool {
        matches!(
            self,
            Self::NoteEdit(_)
                | Self::AgentSend(_)
                | Self::UploadBegin(_)
                | Self::UploadChunk(_)
                | Self::UploadCommit { .. }
                | Self::BrowseFileStat { .. }
                | Self::AgentCancel { .. }
                | Self::SessionModelSet(_)
                | Self::SettingsEditSafe(_)
                | Self::RecordingPause { .. }
                | Self::RecordingResume { .. }
                | Self::RecordingStop { .. }
                | Self::AppFocus { .. }
                | Self::DeviceRevokeSelf
                | Self::ComputerUseApprovalReceived(_)
                | Self::ComputerUseApprovalRespond(_)
        )
    }

    pub fn required_capability(&self) -> Capability {
        match self {
            Self::NotesList(_) | Self::NoteGet { .. } => Capability::NotesRead,
            Self::NoteEdit(_) => Capability::NotesEdit,
            Self::AgentSessionsList(_) | Self::AgentMessagesList { .. } => Capability::AgentRead,
            Self::AgentSend(_) => Capability::AgentChat,
            Self::UploadBegin(_) | Self::UploadChunk(_) | Self::UploadCommit { .. } => {
                Capability::FilesUpload
            }
            Self::BrowseRootsList | Self::BrowseDirList { .. } | Self::BrowseFileStat { .. } => {
                Capability::FilesBrowse
            }
            Self::MediaFetch(_) => Capability::MediaRead,
            Self::AgentCancel { .. } => Capability::AgentCancel,
            Self::ModelsList | Self::SessionModelGet { .. } => Capability::ModelRead,
            Self::SessionModelSet(_) => Capability::ModelEdit,
            Self::SettingsGet => Capability::SettingsRead,
            Self::SettingsEditSafe(_) => Capability::SettingsEditSafe,
            Self::RecordingPause { .. }
            | Self::RecordingResume { .. }
            | Self::RecordingStop { .. }
            | Self::RecordingGetActive => Capability::RecordingControlExisting,
            Self::AppFocus { .. } => Capability::AppFocus,
            Self::DeviceGetSelf => Capability::DevicesReadSelf,
            Self::DeviceRevokeSelf => Capability::DevicesRevokeSelf,
            Self::ComputerUseApprovalReceived(_) | Self::ComputerUseApprovalRespond(_) => {
                Capability::ComputerUseApprove
            }
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
            | Self::SessionModelGet {
                stored_session_id: note_id,
            }
            | Self::RecordingPause {
                recording_session_id: note_id,
            }
            | Self::RecordingResume {
                recording_session_id: note_id,
            }
            | Self::RecordingStop {
                recording_session_id: note_id,
            } => validate_id(note_id),
            Self::NoteEdit(request) => request.validate(),
            Self::AgentSend(request) => request.validate(),
            Self::UploadBegin(request) => request.validate(),
            Self::UploadChunk(request) => request.validate(),
            Self::UploadCommit { reservation_id } if reservation_id.is_nil() => {
                Err(ProtocolError::InvalidIdentifier)
            }
            Self::BrowseDirList {
                root_id,
                relative_path,
                page,
                ..
            } => {
                if root_id.is_nil() {
                    return Err(ProtocolError::InvalidIdentifier);
                }
                validate_relative_path(relative_path, true)?;
                page.validate()
            }
            Self::BrowseFileStat {
                root_id,
                relative_path,
            } => {
                if root_id.is_nil() {
                    return Err(ProtocolError::InvalidIdentifier);
                }
                validate_relative_path(relative_path, false)
            }
            Self::SessionModelSet(request) => request.validate(),
            Self::MediaFetch(request) => request.validate(),
            Self::ComputerUseApprovalReceived(receipt) => receipt.validate(),
            Self::ComputerUseApprovalRespond(request) => request.validate(),
            Self::SettingsEditSafe(patch) if patch.is_empty() => Err(ProtocolError::EmptyPatch),
            Self::Event(Event::AgentDelta {
                stored_session_id,
                text,
            }) => {
                validate_id(stored_session_id)?;
                validate_text(text, MAX_TEXT_BYTES)
            }
            Self::Event(Event::AgentStatus {
                stored_session_id,
                media,
                ..
            }) => {
                validate_id(stored_session_id)?;
                validate_media_references(media)
            }
            Self::Event(Event::SessionModelChanged { selection }) => selection.validate(),
            Self::Response(response) => {
                response.validate()?;
                if let ResultPayload::Device(device) = &response.result {
                    validate_text(&device.display_name, MAX_DEVICE_DISPLAY_NAME_BYTES)?;
                    if let Some(desktop_display_name) = &device.desktop_display_name {
                        validate_text(desktop_display_name, MAX_DEVICE_DISPLAY_NAME_BYTES)?;
                    }
                }
                Ok(())
            }
            Self::Event(Event::ComputerUseApprovalRequested(request)) => request.validate(),
            Self::Event(Event::ComputerUseApprovalStatusChanged(status)) => status.validate(),
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseApprovalReceipt {
    pub request_id: String,
    pub stored_session_id: String,
}

impl ComputerUseApprovalReceipt {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_computer_use_approval_id(&self.request_id)?;
        validate_computer_use_approval_id(&self.stored_session_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseApprovalDecisionRequest {
    pub request_id: String,
    pub stored_session_id: String,
    pub decision: ComputerUseApprovalDecision,
}

impl ComputerUseApprovalDecisionRequest {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_computer_use_approval_id(&self.request_id)?;
        validate_computer_use_approval_id(&self.stored_session_id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComputerUseApprovalDecision {
    Approve,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseApprovalRequest {
    pub request_id: String,
    pub stored_session_id: String,
    pub action: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_url: Option<String>,
    pub requested_at_ms: u64,
    pub expires_at_ms: u64,
}

impl ComputerUseApprovalRequest {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_computer_use_approval_id(&self.request_id)?;
        validate_computer_use_approval_id(&self.stored_session_id)?;
        validate_text(&self.action, MAX_COMPUTER_USE_ACTION_BYTES)?;
        validate_text(&self.description, MAX_COMPUTER_USE_DESCRIPTION_BYTES)?;
        validate_optional_nonempty_text(
            self.target_app.as_deref(),
            MAX_COMPUTER_USE_TARGET_APP_BYTES,
        )?;
        validate_optional_nonempty_text(
            self.target_url.as_deref(),
            MAX_COMPUTER_USE_TARGET_URL_BYTES,
        )?;
        if self.expires_at_ms <= self.requested_at_ms
            || self.expires_at_ms.saturating_sub(self.requested_at_ms)
                > COMPUTER_USE_APPROVAL_TTL_MS
        {
            return Err(ProtocolError::InvalidExpiry);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseApprovalStatusEvent {
    pub request_id: String,
    pub stored_session_id: String,
    pub status: ComputerUseApprovalStatus,
}

impl ComputerUseApprovalStatusEvent {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_computer_use_approval_id(&self.request_id)?;
        validate_computer_use_approval_id(&self.stored_session_id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComputerUseApprovalStatus {
    Approved,
    Denied,
    Executing,
    Succeeded,
    Failed,
    Expired,
    Cancelled,
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
            .is_some_and(|value| value.len() > MAX_PAGE_CURSOR_BYTES)
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachment_reference_ids: Vec<Uuid>,
}

impl AgentSendRequest {
    fn validate(&self) -> Result<(), ProtocolError> {
        if let Some(stored_session_id) = &self.stored_session_id {
            validate_id(stored_session_id)?;
        }
        validate_text(&self.message, MAX_TEXT_BYTES)?;
        if self.attachment_reference_ids.len() > MAX_ATTACHMENT_REFERENCES
            || self.attachment_reference_ids.iter().any(Uuid::is_nil)
            || self
                .attachment_reference_ids
                .iter()
                .enumerate()
                .any(|(index, id)| self.attachment_reference_ids[..index].contains(id))
        {
            return Err(ProtocolError::InvalidAttachmentReferences);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadBeginRequest {
    pub reservation_id: Uuid,
    pub name: String,
    pub media_type: Option<String>,
    pub size_bytes: u64,
    pub sha256: String,
}

impl UploadBeginRequest {
    fn validate(&self) -> Result<(), ProtocolError> {
        if self.reservation_id.is_nil() {
            return Err(ProtocolError::InvalidIdentifier);
        }
        validate_file_name(&self.name)?;
        validate_attachment_media_type(self.media_type.as_deref())?;
        if self.size_bytes == 0 || self.size_bytes > MAX_UPLOAD_BYTES {
            return Err(ProtocolError::UploadTooLarge);
        }
        validate_sha256(&self.sha256)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadChunkRequest {
    pub reservation_id: Uuid,
    pub offset_bytes: u64,
    #[serde(with = "base64_bytes")]
    pub bytes: Vec<u8>,
}

impl UploadChunkRequest {
    fn validate(&self) -> Result<(), ProtocolError> {
        if self.reservation_id.is_nil() {
            return Err(ProtocolError::InvalidIdentifier);
        }
        if self.bytes.is_empty()
            || self.bytes.len() > MAX_UPLOAD_CHUNK_BYTES
            || self.offset_bytes.saturating_add(self.bytes.len() as u64) > MAX_UPLOAD_BYTES
        {
            return Err(ProtocolError::InvalidUploadChunk);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelSetRequest {
    pub stored_session_id: String,
    pub model_id: String,
}

impl SessionModelSetRequest {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_id(&self.stored_session_id)?;
        validate_id(&self.model_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFetchRequest {
    pub stored_session_id: String,
    pub artifact_id: String,
    pub offset_bytes: u64,
}

impl MediaFetchRequest {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_id(&self.stored_session_id)?;
        validate_id(&self.artifact_id)?;
        if self.offset_bytes >= MAX_MEDIA_BYTES {
            return Err(ProtocolError::InvalidMediaChunk);
        }
        Ok(())
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
    Agent {
        #[serde(rename = "storedSessionId", alias = "stored_session_id")]
        stored_session_id: Option<String>,
    },
    Note {
        #[serde(rename = "noteId", alias = "note_id")]
        note_id: String,
    },
    Settings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub capability: Capability,
    pub result: ResultPayload,
}

impl Response {
    fn validate(&self) -> Result<(), ProtocolError> {
        match &self.result {
            ResultPayload::Upload(progress) => progress.validate(),
            ResultPayload::BrowseRoots(roots) => {
                if roots.len() > MAX_BROWSE_ROOTS {
                    return Err(ProtocolError::InvalidPageSize);
                }
                for root in roots {
                    root.validate()?;
                }
                Ok(())
            }
            ResultPayload::BrowseEntries(page) => {
                if page.items.len() > MAX_PAGE_SIZE as usize
                    || page
                        .next_cursor
                        .as_deref()
                        .is_some_and(|value| value.len() > MAX_PAGE_CURSOR_BYTES)
                {
                    return Err(ProtocolError::InvalidPageSize);
                }
                for entry in &page.items {
                    entry.validate()?;
                }
                Ok(())
            }
            ResultPayload::AgentMessages(page) => {
                if page.items.len() > MAX_PAGE_SIZE as usize
                    || page
                        .next_cursor
                        .as_deref()
                        .is_some_and(|value| value.len() > 512)
                {
                    return Err(ProtocolError::InvalidPageSize);
                }
                for message in &page.items {
                    message.validate()?;
                }
                Ok(())
            }
            ResultPayload::MediaChunk(chunk) => {
                if self.capability != Capability::MediaRead {
                    return Err(ProtocolError::CapabilityMismatch);
                }
                chunk.validate()
            }
            ResultPayload::BrowseFile(file) => file.validate(),
            ResultPayload::Models(catalog) => catalog.validate(),
            ResultPayload::SessionModel(selection) => selection.validate(),
            ResultPayload::Error(failure) => validate_text(&failure.message, 2 * 1024),
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum ResultPayload {
    Accepted,
    Notes(Page<NoteSummary>),
    Note(NoteRecord),
    AgentSessions(Page<AgentSession>),
    AgentMessages(Page<AgentMessage>),
    AgentAccepted {
        #[serde(rename = "storedSessionId", alias = "stored_session_id")]
        stored_session_id: String,
    },
    Upload(UploadProgress),
    BrowseRoots(Vec<BrowseRoot>),
    BrowseEntries(Page<BrowseEntry>),
    BrowseFile(BrowseFile),
    Models(ModelCatalog),
    SessionModel(SessionModelSelection),
    MediaChunk(MediaChunk),
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
pub struct UploadProgress {
    pub reservation_id: Uuid,
    pub accepted_bytes: u64,
    pub size_bytes: u64,
    pub expires_at_ms: u64,
    pub attachment: Option<AttachmentReference>,
}

impl UploadProgress {
    fn validate(&self) -> Result<(), ProtocolError> {
        if self.reservation_id.is_nil()
            || self.size_bytes == 0
            || self.size_bytes > MAX_UPLOAD_BYTES
            || self.accepted_bytes > self.size_bytes
        {
            return Err(ProtocolError::InvalidUploadChunk);
        }
        if let Some(attachment) = &self.attachment {
            attachment.validate()?;
            if self.accepted_bytes != self.size_bytes || attachment.size_bytes != self.size_bytes {
                return Err(ProtocolError::InvalidUploadChunk);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentReference {
    pub reference_id: Uuid,
    pub source: AttachmentSource,
    pub name: String,
    pub media_type: Option<String>,
    pub size_bytes: u64,
    pub expires_at_ms: u64,
}

impl AttachmentReference {
    fn validate(&self) -> Result<(), ProtocolError> {
        if self.reference_id.is_nil() || self.size_bytes == 0 || self.size_bytes > MAX_UPLOAD_BYTES
        {
            return Err(ProtocolError::InvalidAttachmentReferences);
        }
        validate_file_name(&self.name)?;
        validate_attachment_media_type(self.media_type.as_deref())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentSource {
    PhoneUpload,
    MacFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseRoot {
    pub root_id: Uuid,
    pub name: String,
}

impl BrowseRoot {
    fn validate(&self) -> Result<(), ProtocolError> {
        if self.root_id.is_nil() {
            return Err(ProtocolError::InvalidIdentifier);
        }
        validate_text(&self.name, 128)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseEntry {
    pub name: String,
    pub relative_path: String,
    pub kind: BrowseEntryKind,
    pub size_bytes: Option<u64>,
    pub modified_at: Option<String>,
}

impl BrowseEntry {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_file_name(&self.name)?;
        validate_relative_path(&self.relative_path, false)?;
        if self.kind == BrowseEntryKind::Directory && self.size_bytes.is_some() {
            return Err(ProtocolError::InvalidBrowseEntry);
        }
        if self.size_bytes.is_some_and(|size| size > MAX_UPLOAD_BYTES) {
            return Err(ProtocolError::UploadTooLarge);
        }
        validate_optional_text(self.modified_at.as_deref(), 64)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowseEntryKind {
    Directory,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseFile {
    pub entry: BrowseEntry,
    pub attachment: AttachmentReference,
}

impl BrowseFile {
    fn validate(&self) -> Result<(), ProtocolError> {
        self.entry.validate()?;
        self.attachment.validate()?;
        if self.entry.kind != BrowseEntryKind::File
            || self.entry.size_bytes != Some(self.attachment.size_bytes)
            || self.entry.name != self.attachment.name
            || self.attachment.source != AttachmentSource::MacFile
        {
            return Err(ProtocolError::InvalidAttachmentReferences);
        }
        Ok(())
    }
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub media: Vec<MediaResultReference>,
}

impl AgentMessage {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_id(&self.id)?;
        if self.text.len() > MAX_TEXT_BYTES
            || (self.text.trim().is_empty() && self.media.is_empty())
        {
            return Err(ProtocolError::TextTooLarge);
        }
        validate_optional_text(Some(&self.created_at), 64)?;
        validate_media_references(&self.media)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    Image,
    Video,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaResultReference {
    pub artifact_id: String,
    pub kind: MediaKind,
    pub media_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width_px: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height_px: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub size_bytes: u64,
}

impl MediaResultReference {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_id(&self.artifact_id)?;
        validate_media_type(&self.media_type, self.kind)?;
        if self.size_bytes == 0 || self.size_bytes > MAX_MEDIA_BYTES {
            return Err(ProtocolError::MediaTooLarge);
        }
        match (self.width_px, self.height_px) {
            (Some(width), Some(height))
                if width > 0
                    && width <= MAX_MEDIA_DIMENSION_PX
                    && height > 0
                    && height <= MAX_MEDIA_DIMENSION_PX => {}
            (None, None) => {}
            _ => return Err(ProtocolError::InvalidMediaReference),
        }
        match (self.kind, self.duration_ms) {
            (MediaKind::Image, None) | (MediaKind::Video, None) => Ok(()),
            (MediaKind::Video, Some(duration))
                if duration > 0 && duration <= MAX_MEDIA_DURATION_MS =>
            {
                Ok(())
            }
            _ => Err(ProtocolError::InvalidMediaReference),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaChunk {
    pub artifact_id: String,
    pub offset_bytes: u64,
    pub total_size_bytes: u64,
    pub sha256: String,
    #[serde(with = "base64_bytes")]
    pub bytes: Vec<u8>,
    pub complete: bool,
}

impl MediaChunk {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_id(&self.artifact_id)?;
        if self.total_size_bytes == 0
            || self.total_size_bytes > MAX_MEDIA_BYTES
            || self.bytes.is_empty()
            || self.bytes.len() > MAX_MEDIA_CHUNK_BYTES
            || self.offset_bytes.saturating_add(self.bytes.len() as u64) > self.total_size_bytes
            || self.complete
                != (self.offset_bytes.saturating_add(self.bytes.len() as u64)
                    == self.total_size_bytes)
            || !valid_sha256(&self.sha256)
        {
            return Err(ProtocolError::InvalidMediaChunk);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub models: Vec<ModelOption>,
}

impl ModelCatalog {
    fn validate(&self) -> Result<(), ProtocolError> {
        if self.models.is_empty() || self.models.len() > MAX_MODEL_OPTIONS {
            return Err(ProtocolError::InvalidModelCatalog);
        }
        for model in &self.models {
            model.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub description: String,
    pub routing: ModelRouting,
    pub privacy: Option<ModelPrivacy>,
    pub privacy_label: Option<String>,
    pub price_label: Option<String>,
}

impl ModelOption {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_id(&self.id)?;
        validate_text(&self.name, MAX_MODEL_NAME_BYTES)?;
        if self.provider.len() > MAX_MODEL_PROVIDER_BYTES
            || self.description.len() > MAX_MODEL_DESCRIPTION_BYTES
        {
            return Err(ProtocolError::TextTooLarge);
        }
        validate_optional_text(self.privacy_label.as_deref(), MAX_MODEL_LABEL_BYTES)?;
        validate_optional_text(self.price_label.as_deref(), MAX_MODEL_LABEL_BYTES)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelRouting {
    Automatic,
    Remote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelPrivacy {
    EndToEndEncrypted,
    Private,
    Anonymous,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelSelection {
    pub stored_session_id: String,
    pub model_id: String,
    pub model_name: String,
    pub cost_quality: Option<u8>,
}

impl SessionModelSelection {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_id(&self.stored_session_id)?;
        validate_id(&self.model_id)?;
        validate_text(&self.model_name, MAX_MODEL_NAME_BYTES)?;
        if self.cost_quality.is_some_and(|value| value > 100) {
            return Err(ProtocolError::InvalidModelSelection);
        }
        Ok(())
    }
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
    pub recording_session_id: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop_display_name: Option<String>,
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
    LimitExceeded,
    IntegrityMismatch,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum Event {
    AgentDelta {
        #[serde(rename = "storedSessionId", alias = "stored_session_id")]
        stored_session_id: String,
        text: String,
    },
    AgentStatus {
        #[serde(rename = "storedSessionId", alias = "stored_session_id")]
        stored_session_id: String,
        status: AgentStatus,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        media: Vec<MediaResultReference>,
    },
    SessionModelChanged {
        selection: SessionModelSelection,
    },
    NotesChanged {
        cursor: Option<String>,
    },
    ComputerUseApprovalRequested(ComputerUseApprovalRequest),
    ComputerUseApprovalStatusChanged(ComputerUseApprovalStatusEvent),
    DeviceRevoked,
    ResyncRequired,
}

impl Event {
    pub fn capability(&self) -> Capability {
        match self {
            Self::AgentDelta { .. } | Self::AgentStatus { .. } => Capability::AgentRead,
            Self::SessionModelChanged { .. } => Capability::ModelRead,
            Self::NotesChanged { .. } => Capability::NotesRead,
            Self::ComputerUseApprovalRequested(_) | Self::ComputerUseApprovalStatusChanged(_) => {
                Capability::ComputerUseApprove
            }
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
    #[error("upload exceeds the supported size")]
    UploadTooLarge,
    #[error("upload chunk is empty, too large, or outside the file")]
    InvalidUploadChunk,
    #[error("attachment references are invalid or exceed the supported count")]
    InvalidAttachmentReferences,
    #[error("browse entry metadata is invalid")]
    InvalidBrowseEntry,
    #[error("file name is invalid")]
    InvalidFileName,
    #[error("media type is invalid")]
    InvalidMediaType,
    #[error("content hash must be a lowercase SHA-256 hex digest")]
    InvalidContentHash,
    #[error("relative path is invalid")]
    InvalidRelativePath,
    #[error("media artifact is too large")]
    MediaTooLarge,
    #[error("media reference is invalid")]
    InvalidMediaReference,
    #[error("media chunk is invalid")]
    InvalidMediaChunk,
    #[error("patch has no editable fields")]
    EmptyPatch,
    #[error("model catalog is empty or exceeds its item limit")]
    InvalidModelCatalog,
    #[error("model selection is outside the supported range")]
    InvalidModelSelection,
    #[error("relay route is invalid")]
    InvalidRoute,
    #[error("peer capability advertisement is invalid")]
    InvalidCapabilities,
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

fn validate_computer_use_approval_id(value: &str) -> Result<(), ProtocolError> {
    if value.is_empty() || value.len() > MAX_COMPUTER_USE_APPROVAL_ID_BYTES {
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

fn validate_file_name(value: &str) -> Result<(), ProtocolError> {
    if value.is_empty()
        || value.len() > MAX_FILE_NAME_BYTES
        || value == "."
        || value == ".."
        || value.starts_with('.')
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | ':'))
    {
        Err(ProtocolError::InvalidFileName)
    } else {
        Ok(())
    }
}

fn validate_optional_nonempty_text(value: Option<&str>, max: usize) -> Result<(), ProtocolError> {
    if value.is_some_and(|value| value.trim().is_empty() || value.len() > max) {
        Err(ProtocolError::TextTooLarge)
    } else {
        Ok(())
    }
}

fn validate_attachment_media_type(value: Option<&str>) -> Result<(), ProtocolError> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.is_empty()
        || value.len() > MAX_MEDIA_TYPE_BYTES
        || value.matches('/').count() != 1
        || value.starts_with('/')
        || value.ends_with('/')
        || !value.is_ascii()
        || value
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        Err(ProtocolError::InvalidMediaType)
    } else {
        Ok(())
    }
}

fn validate_sha256(value: &str) -> Result<(), ProtocolError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(ProtocolError::InvalidContentHash)
    }
}

fn validate_relative_path(value: &str, allow_empty: bool) -> Result<(), ProtocolError> {
    if value.len() > MAX_RELATIVE_PATH_BYTES
        || (!allow_empty && value.is_empty())
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains('\\')
        || value.contains(':')
        || (!value.is_empty()
            && value.split('/').any(|component| {
                component.is_empty()
                    || component == "."
                    || component == ".."
                    || component.starts_with('.')
                    || component.len() > MAX_FILE_NAME_BYTES
                    || component.chars().any(char::is_control)
            }))
    {
        Err(ProtocolError::InvalidRelativePath)
    } else {
        Ok(())
    }
}

fn validate_media_references(references: &[MediaResultReference]) -> Result<(), ProtocolError> {
    if references.len() > MAX_MEDIA_REFERENCES {
        return Err(ProtocolError::InvalidMediaReference);
    }
    for (index, reference) in references.iter().enumerate() {
        reference.validate()?;
        if references[..index]
            .iter()
            .any(|prior| prior.artifact_id == reference.artifact_id)
        {
            return Err(ProtocolError::InvalidMediaReference);
        }
    }
    Ok(())
}

pub fn validate_media_type(value: &str, kind: MediaKind) -> Result<(), ProtocolError> {
    if value.is_empty() || value.len() > MAX_MEDIA_TYPE_BYTES || !value.is_ascii() {
        return Err(ProtocolError::InvalidMediaReference);
    }
    let Some((top_level, subtype)) = value.split_once('/') else {
        return Err(ProtocolError::InvalidMediaReference);
    };
    if top_level.is_empty() || subtype.is_empty() || subtype.contains('/') {
        return Err(ProtocolError::InvalidMediaReference);
    }
    let valid_token = |token: &str| {
        token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
    };
    if valid_token(top_level)
        && valid_token(subtype)
        && match kind {
            MediaKind::Image => top_level == "image",
            MediaKind::Video => top_level == "video",
        }
    {
        Ok(())
    } else {
        Err(ProtocolError::InvalidMediaReference)
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_option(id: &str) -> ModelOption {
        ModelOption {
            id: id.to_string(),
            name: "Private model".to_string(),
            provider: "venice".to_string(),
            description: "A curated model for Clovy agent sessions.".to_string(),
            routing: ModelRouting::Remote,
            privacy: Some(ModelPrivacy::Private),
            privacy_label: Some("Private mode".to_string()),
            price_label: Some("$1.00 input / $2.00 output per 1M tokens".to_string()),
        }
    }

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
    fn peer_hello_advertises_optional_capabilities_inside_the_handshake() {
        let hello = PeerHello {
            capabilities: vec![Capability::AgentRead, Capability::ComputerUseApprove],
        };
        let encoded = encode_peer_hello(&hello).unwrap();

        assert_eq!(decode_peer_hello(&encoded).unwrap(), hello);
        assert_eq!(decode_peer_hello(&[]).unwrap(), PeerHello::default());

        let duplicate = PeerHello {
            capabilities: vec![
                Capability::ComputerUseApprove,
                Capability::ComputerUseApprove,
            ],
        };
        assert!(matches!(
            encode_peer_hello(&duplicate),
            Err(ProtocolError::InvalidCapabilities)
        ));

        let future = br#"{"capabilities":["agentRead","futureCapability","computerUseApprove"]}"#;
        assert_eq!(
            decode_peer_hello(future).unwrap(),
            PeerHello {
                capabilities: vec![Capability::AgentRead, Capability::ComputerUseApprove],
            }
        );

        let too_many_unknown = serde_json::to_vec(&serde_json::json!({
            "capabilities": (0..=MAX_PEER_CAPABILITIES)
                .map(|index| format!("futureCapability{index}"))
                .collect::<Vec<_>>()
        }))
        .unwrap();
        assert!(decode_peer_hello(&too_many_unknown).is_err());
    }

    #[test]
    fn agent_accepted_uses_the_camel_case_session_id_wire_field() {
        let encoded = r#"{"type":"agentAccepted","data":{"storedSessionId":"stored-1"}}"#;
        let payload: ResultPayload = serde_json::from_str(encoded).unwrap();
        assert_eq!(
            payload,
            ResultPayload::AgentAccepted {
                stored_session_id: "stored-1".to_string(),
            }
        );
        assert_eq!(serde_json::to_string(&payload).unwrap(), encoded);
    }

    #[test]
    fn agent_message_reads_use_the_camel_case_session_id_wire_field() {
        let encoded = r#"{"type":"agentMessagesList","data":{"storedSessionId":"stored-1","page":{"cursor":null,"limit":100}}}"#;
        let body: Body = serde_json::from_str(encoded).unwrap();
        assert_eq!(
            body,
            Body::AgentMessagesList {
                stored_session_id: "stored-1".to_string(),
                page: PageRequest {
                    cursor: None,
                    limit: 100,
                },
            }
        );
        assert_eq!(serde_json::to_string(&body).unwrap(), encoded);
    }

    #[test]
    fn agent_events_use_the_camel_case_session_id_wire_field() {
        let encoded =
            r#"{"type":"agentStatus","data":{"storedSessionId":"stored-1","status":"completed"}}"#;
        let event: Event = serde_json::from_str(encoded).unwrap();
        assert_eq!(
            event,
            Event::AgentStatus {
                stored_session_id: "stored-1".to_string(),
                status: AgentStatus::Completed,
                media: Vec::new(),
            }
        );
        assert_eq!(serde_json::to_string(&event).unwrap(), encoded);
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
                attachment_reference_ids: Vec::new(),
            })
            .is_mutation()
        );
        assert!(
            Body::UploadBegin(UploadBeginRequest {
                reservation_id: Uuid::new_v4(),
                name: "brief.pdf".to_string(),
                media_type: Some("application/pdf".to_string()),
                size_bytes: 10,
                sha256: "a".repeat(64),
            })
            .is_mutation()
        );
        assert!(
            Body::UploadChunk(UploadChunkRequest {
                reservation_id: Uuid::new_v4(),
                offset_bytes: 0,
                bytes: vec![1],
            })
            .is_mutation()
        );
        assert!(
            Body::UploadCommit {
                reservation_id: Uuid::new_v4(),
            }
            .is_mutation()
        );
        assert!(
            Body::BrowseFileStat {
                root_id: Uuid::new_v4(),
                relative_path: "Project/briefs/jca-8.md".to_string(),
            }
            .is_mutation()
        );
        assert!(
            Body::RecordingStop {
                recording_session_id: "recording-1".to_string(),
            }
            .is_mutation()
        );
        assert!(
            Body::SessionModelSet(SessionModelSetRequest {
                stored_session_id: "session-1".to_string(),
                model_id: "private-model".to_string(),
            })
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
        assert!(
            Body::ComputerUseApprovalReceived(ComputerUseApprovalReceipt {
                request_id: "call-1".to_string(),
                stored_session_id: "session-1".to_string(),
            })
            .is_mutation()
        );
        assert!(
            Body::ComputerUseApprovalRespond(ComputerUseApprovalDecisionRequest {
                request_id: "call-1".to_string(),
                stored_session_id: "session-1".to_string(),
                decision: ComputerUseApprovalDecision::Approve,
            })
            .is_mutation()
        );
        assert!(!Body::NotesList(PageRequest::default()).is_mutation());
        assert!(!Body::SettingsGet.is_mutation());
    }

    #[test]
    fn model_contract_round_trips_with_exact_capabilities_and_wire_tags() {
        let now = 1_000_000;
        let read = Frame::new(Uuid::nil(), 1, now, Capability::ModelRead, Body::ModelsList);
        let encoded = encode_frame(&read).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(json["capability"], "modelRead");
        assert_eq!(json["body"]["type"], "modelsList");
        assert_eq!(decode_frame(&encoded, now).unwrap(), read);

        let get = Frame::new(
            Uuid::nil(),
            2,
            now,
            Capability::ModelRead,
            Body::SessionModelGet {
                stored_session_id: "session-1".to_string(),
            },
        );
        let encoded = encode_frame(&get).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(json["body"]["type"], "sessionModelGet");
        assert_eq!(json["body"]["data"]["storedSessionId"], "session-1");
        assert_eq!(decode_frame(&encoded, now).unwrap(), get);

        let write = Frame::new(
            Uuid::nil(),
            3,
            now,
            Capability::ModelEdit,
            Body::SessionModelSet(SessionModelSetRequest {
                stored_session_id: "session-1".to_string(),
                model_id: "private-model".to_string(),
            }),
        );
        let encoded = encode_frame(&write).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(json["capability"], "modelEdit");
        assert_eq!(json["body"]["type"], "sessionModelSet");
        assert_eq!(json["body"]["data"]["storedSessionId"], "session-1");
        assert_eq!(decode_frame(&encoded, now).unwrap(), write);

        let confused = Frame::new(
            Uuid::nil(),
            4,
            now,
            Capability::ModelRead,
            Body::SessionModelSet(SessionModelSetRequest {
                stored_session_id: "session-1".to_string(),
                model_id: "private-model".to_string(),
            }),
        );
        assert!(matches!(
            confused.validate(now),
            Err(ProtocolError::CapabilityMismatch)
        ));
    }

    #[test]
    fn model_results_and_change_events_round_trip() {
        let selection = SessionModelSelection {
            stored_session_id: "session-1".to_string(),
            model_id: "open-software/auto".to_string(),
            model_name: "Auto".to_string(),
            cost_quality: Some(100),
        };
        let results = [
            ResultPayload::Models(ModelCatalog {
                models: vec![model_option("private-model")],
            }),
            ResultPayload::SessionModel(selection.clone()),
        ];
        for result in results {
            let body = Body::Response(Response {
                capability: Capability::ModelRead,
                result,
            });
            let encoded = serde_json::to_vec(&body).unwrap();
            assert_eq!(serde_json::from_slice::<Body>(&encoded).unwrap(), body);
        }

        let event = Body::Event(Event::SessionModelChanged { selection });
        let encoded = serde_json::to_vec(&event).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(json["type"], "event");
        assert_eq!(json["data"]["type"], "sessionModelChanged");
        assert_eq!(
            json["data"]["data"]["selection"]["modelId"],
            "open-software/auto"
        );
        assert_eq!(serde_json::from_slice::<Body>(&encoded).unwrap(), event);
    }

    #[test]
    fn rejects_unbounded_model_catalogs_and_selections() {
        let now = 1_000_000;
        let oversized_catalog = Frame::new(
            Uuid::nil(),
            1,
            now,
            Capability::ModelRead,
            Body::Response(Response {
                capability: Capability::ModelRead,
                result: ResultPayload::Models(ModelCatalog {
                    models: (0..=MAX_MODEL_OPTIONS)
                        .map(|index| model_option(&format!("model-{index}")))
                        .collect(),
                }),
            }),
        );
        assert!(matches!(
            oversized_catalog.validate(now),
            Err(ProtocolError::InvalidModelCatalog)
        ));

        let invalid_selection = Frame::new(
            Uuid::nil(),
            2,
            now,
            Capability::ModelRead,
            Body::Event(Event::SessionModelChanged {
                selection: SessionModelSelection {
                    stored_session_id: "session-1".to_string(),
                    model_id: "open-software/auto".to_string(),
                    model_name: "Auto".to_string(),
                    cost_quality: Some(101),
                },
            }),
        );
        assert!(matches!(
            invalid_selection.validate(now),
            Err(ProtocolError::InvalidModelSelection)
        ));
    }

    #[test]
    fn computer_use_approval_wire_contract_is_explicit_and_bounded() {
        let request = ComputerUseApprovalRequest {
            request_id: "call-1".to_string(),
            stored_session_id: "session-1".to_string(),
            action: "click".to_string(),
            description: "Click a control in TextEdit.".to_string(),
            target_app: Some("TextEdit".to_string()),
            target_url: None,
            requested_at_ms: 1_000,
            expires_at_ms: 1_000 + COMPUTER_USE_APPROVAL_TTL_MS,
        };
        let event = Event::ComputerUseApprovalRequested(request.clone());
        let frame = Frame::new(
            Uuid::nil(),
            1,
            1_000,
            Capability::ComputerUseApprove,
            Body::Event(event),
        );
        frame.validate(1_000).unwrap();

        let encoded = serde_json::to_value(&frame).unwrap();
        assert_eq!(encoded["capability"], "computerUseApprove");
        assert_eq!(encoded["body"]["type"], "event");
        assert_eq!(
            encoded["body"]["data"]["type"],
            "computerUseApprovalRequested"
        );
        assert_eq!(
            encoded["body"]["data"]["data"]["storedSessionId"],
            "session-1"
        );
        assert!(encoded["body"]["data"]["data"].get("targetUrl").is_none());
        assert_eq!(
            encoded["body"],
            serde_json::json!({
                "type": "event",
                "data": {
                    "type": "computerUseApprovalRequested",
                    "data": {
                        "requestId": "call-1",
                        "storedSessionId": "session-1",
                        "action": "click",
                        "description": "Click a control in TextEdit.",
                        "targetApp": "TextEdit",
                        "requestedAtMs": 1_000,
                        "expiresAtMs": 1_000 + COMPUTER_USE_APPROVAL_TTL_MS
                    }
                }
            })
        );

        let mut too_long = request;
        too_long.description = "x".repeat(MAX_COMPUTER_USE_DESCRIPTION_BYTES + 1);
        assert!(matches!(
            Body::Event(Event::ComputerUseApprovalRequested(too_long)).validate(),
            Err(ProtocolError::TextTooLarge)
        ));
    }

    #[test]
    fn computer_use_approval_decisions_and_statuses_have_stable_wire_values() {
        let receipt = Body::ComputerUseApprovalReceived(ComputerUseApprovalReceipt {
            request_id: "call-1".to_string(),
            stored_session_id: "session-1".to_string(),
        });
        assert_eq!(
            serde_json::to_value(&receipt).unwrap(),
            serde_json::json!({
                "type": "computerUseApprovalReceived",
                "data": {
                    "requestId": "call-1",
                    "storedSessionId": "session-1"
                }
            })
        );

        let decision = Body::ComputerUseApprovalRespond(ComputerUseApprovalDecisionRequest {
            request_id: "call-1".to_string(),
            stored_session_id: "session-1".to_string(),
            decision: ComputerUseApprovalDecision::Deny,
        });
        assert_eq!(
            serde_json::to_value(&decision).unwrap(),
            serde_json::json!({
                "type": "computerUseApprovalRespond",
                "data": {
                    "requestId": "call-1",
                    "storedSessionId": "session-1",
                    "decision": "deny"
                }
            })
        );

        let status = Body::Event(Event::ComputerUseApprovalStatusChanged(
            ComputerUseApprovalStatusEvent {
                request_id: "call-1".to_string(),
                stored_session_id: "session-1".to_string(),
                status: ComputerUseApprovalStatus::Approved,
            },
        ));
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({
                "type": "event",
                "data": {
                    "type": "computerUseApprovalStatusChanged",
                    "data": {
                        "requestId": "call-1",
                        "storedSessionId": "session-1",
                        "status": "approved"
                    }
                }
            })
        );

        for (status, expected) in [
            (ComputerUseApprovalStatus::Approved, "approved"),
            (ComputerUseApprovalStatus::Denied, "denied"),
            (ComputerUseApprovalStatus::Executing, "executing"),
            (ComputerUseApprovalStatus::Succeeded, "succeeded"),
            (ComputerUseApprovalStatus::Failed, "failed"),
            (ComputerUseApprovalStatus::Expired, "expired"),
            (ComputerUseApprovalStatus::Cancelled, "cancelled"),
        ] {
            assert_eq!(serde_json::to_value(status).unwrap(), expected);
        }
    }

    #[test]
    fn computer_use_approval_requests_reject_capability_confusion_and_bad_expiry() {
        let mut request = ComputerUseApprovalRequest {
            request_id: "call-1".to_string(),
            stored_session_id: "session-1".to_string(),
            action: "click".to_string(),
            description: "Click a control.".to_string(),
            target_app: None,
            target_url: None,
            requested_at_ms: 1_000,
            expires_at_ms: 1_000 + COMPUTER_USE_APPROVAL_TTL_MS,
        };
        request.validate().unwrap();

        request.expires_at_ms = request.requested_at_ms + 1;
        request.validate().unwrap();

        request.expires_at_ms = request.requested_at_ms;
        assert!(matches!(
            request.validate(),
            Err(ProtocolError::InvalidExpiry)
        ));
        request.expires_at_ms = request.requested_at_ms + COMPUTER_USE_APPROVAL_TTL_MS + 1;
        assert!(matches!(
            request.validate(),
            Err(ProtocolError::InvalidExpiry)
        ));

        let mut frame = Frame::new(
            Uuid::nil(),
            1,
            1_000,
            Capability::AgentChat,
            Body::Event(Event::ComputerUseApprovalRequested(
                ComputerUseApprovalRequest {
                    expires_at_ms: 1_000 + COMPUTER_USE_APPROVAL_TTL_MS,
                    ..request
                },
            )),
        );
        assert!(matches!(
            frame.validate(1_000),
            Err(ProtocolError::CapabilityMismatch)
        ));
        frame.capability = Capability::ComputerUseApprove;
        frame.validate(1_000).unwrap();
    }

    #[test]
    fn computer_use_approval_ids_use_the_128_byte_contract_bound() {
        let request = ComputerUseApprovalRequest {
            request_id: "r".repeat(MAX_COMPUTER_USE_APPROVAL_ID_BYTES),
            stored_session_id: "s".repeat(MAX_COMPUTER_USE_APPROVAL_ID_BYTES),
            action: "click".to_string(),
            description: "Click a control.".to_string(),
            target_app: None,
            target_url: None,
            requested_at_ms: 1_000,
            expires_at_ms: 1_000 + COMPUTER_USE_APPROVAL_TTL_MS,
        };
        request.validate().unwrap();

        let mut oversized_request = request.clone();
        oversized_request.request_id.push('r');
        assert!(matches!(
            oversized_request.validate(),
            Err(ProtocolError::InvalidIdentifier)
        ));

        let oversized_session = "s".repeat(MAX_COMPUTER_USE_APPROVAL_ID_BYTES + 1);
        assert!(matches!(
            ComputerUseApprovalReceipt {
                request_id: request.request_id.clone(),
                stored_session_id: oversized_session.clone(),
            }
            .validate(),
            Err(ProtocolError::InvalidIdentifier)
        ));
        assert!(matches!(
            ComputerUseApprovalDecisionRequest {
                request_id: request.request_id.clone(),
                stored_session_id: oversized_session.clone(),
                decision: ComputerUseApprovalDecision::Approve,
            }
            .validate(),
            Err(ProtocolError::InvalidIdentifier)
        ));
        assert!(matches!(
            ComputerUseApprovalStatusEvent {
                request_id: request.request_id,
                stored_session_id: oversized_session,
                status: ComputerUseApprovalStatus::Approved,
            }
            .validate(),
            Err(ProtocolError::InvalidIdentifier)
        ));
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
                attachment_reference_ids: Vec::new(),
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
    fn file_contract_round_trips_with_explicit_capabilities() {
        let reservation_id = Uuid::new_v4();
        let root_id = Uuid::new_v4();
        let requests = [
            (
                Capability::FilesUpload,
                Body::UploadBegin(UploadBeginRequest {
                    reservation_id,
                    name: "brief.pdf".to_string(),
                    media_type: Some("application/pdf".to_string()),
                    size_bytes: 123,
                    sha256: "a".repeat(64),
                }),
            ),
            (
                Capability::FilesUpload,
                Body::UploadChunk(UploadChunkRequest {
                    reservation_id,
                    offset_bytes: 0,
                    bytes: vec![1, 2, 3],
                }),
            ),
            (
                Capability::FilesUpload,
                Body::UploadCommit { reservation_id },
            ),
            (Capability::FilesBrowse, Body::BrowseRootsList),
            (
                Capability::FilesBrowse,
                Body::BrowseDirList {
                    root_id,
                    relative_path: "Project/briefs".to_string(),
                    page: PageRequest::default(),
                },
            ),
            (
                Capability::FilesBrowse,
                Body::BrowseFileStat {
                    root_id,
                    relative_path: "Project/briefs/jca-8.md".to_string(),
                },
            ),
        ];

        for (index, (capability, body)) in requests.into_iter().enumerate() {
            let frame = Frame::new(Uuid::new_v4(), index as u64 + 1, 100, capability, body);
            let encoded = encode_frame(&frame).unwrap();
            assert_eq!(decode_frame(&encoded, 100).unwrap(), frame);
        }
    }

    #[test]
    fn legacy_agent_send_without_attachments_remains_compatible() {
        let request: AgentSendRequest =
            serde_json::from_str(r#"{"storedSessionId":"stored-1","message":"Hello"}"#).unwrap();
        assert!(request.attachment_reference_ids.is_empty());
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({"storedSessionId": "stored-1", "message": "Hello"})
        );
    }

    #[test]
    fn maximum_upload_chunk_stays_below_the_44_kib_plaintext_ceiling() {
        let frame = Frame::new(
            Uuid::from_u128(u128::MAX),
            u64::MAX,
            1_000_000,
            Capability::FilesUpload,
            Body::UploadChunk(UploadChunkRequest {
                reservation_id: Uuid::from_u128(u128::MAX),
                offset_bytes: MAX_UPLOAD_BYTES - MAX_UPLOAD_CHUNK_BYTES as u64,
                bytes: vec![u8::MAX; MAX_UPLOAD_CHUNK_BYTES],
            }),
        );
        let encoded = encode_frame(&frame).unwrap();
        assert!(
            encoded.len() <= MAX_ENCODED_FRAME_BYTES,
            "encoded maximum chunk was {} bytes",
            encoded.len()
        );
        assert!(MAX_ENCODED_FRAME_BYTES - encoded.len() >= 1_000);
        assert_eq!(decode_frame(&encoded, 1_000_000).unwrap(), frame);
    }

    #[test]
    fn media_contract_round_trips_with_explicit_capability_equality() {
        let artifact_id = "artifact-1".to_string();
        let request = Frame::new(
            Uuid::new_v4(),
            1,
            100,
            Capability::MediaRead,
            Body::MediaFetch(MediaFetchRequest {
                stored_session_id: "stored-1".to_string(),
                artifact_id: artifact_id.clone(),
                offset_bytes: 0,
            }),
        );
        let encoded = encode_frame(&request).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(json["capability"], "mediaRead");
        assert_eq!(json["body"]["type"], "mediaFetch");
        assert_eq!(decode_frame(&encoded, 100).unwrap(), request);

        let response = Frame::new(
            Uuid::new_v4(),
            2,
            100,
            Capability::MediaRead,
            Body::Response(Response {
                capability: Capability::MediaRead,
                result: ResultPayload::MediaChunk(MediaChunk {
                    artifact_id,
                    offset_bytes: 0,
                    total_size_bytes: 3,
                    sha256: "a".repeat(64),
                    bytes: vec![1, 2, 3],
                    complete: true,
                }),
            }),
        );
        let encoded = encode_frame(&response).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(json["body"]["data"]["result"]["type"], "mediaChunk");
        assert_eq!(decode_frame(&encoded, 100).unwrap(), response);

        let mismatched = Frame::new(
            Uuid::new_v4(),
            3,
            100,
            Capability::AgentRead,
            Body::MediaFetch(MediaFetchRequest {
                stored_session_id: "stored-1".to_string(),
                artifact_id: "artifact-1".to_string(),
                offset_bytes: 0,
            }),
        );
        assert!(matches!(
            mismatched.validate(100),
            Err(ProtocolError::CapabilityMismatch)
        ));
    }

    #[test]
    fn legacy_messages_and_status_events_omit_empty_media() {
        let legacy = r#"{"id":"message-1","role":"assistant","text":"Done","createdAt":"2026-07-28T00:00:00Z","streaming":false}"#;
        let message: AgentMessage = serde_json::from_str(legacy).unwrap();
        assert!(message.media.is_empty());
        assert_eq!(serde_json::to_string(&message).unwrap(), legacy);

        let event = Event::AgentStatus {
            stored_session_id: "stored-1".to_string(),
            status: AgentStatus::Completed,
            media: Vec::new(),
        };
        let encoded = serde_json::to_value(event).unwrap();
        assert!(encoded["data"].get("media").is_none());
    }

    #[test]
    fn maximum_media_chunk_stays_below_the_44_kib_plaintext_ceiling() {
        let frame = Frame::new(
            Uuid::from_u128(u128::MAX),
            u64::MAX,
            1_000_000,
            Capability::MediaRead,
            Body::Response(Response {
                capability: Capability::MediaRead,
                result: ResultPayload::MediaChunk(MediaChunk {
                    artifact_id: "a".repeat(256),
                    offset_bytes: MAX_MEDIA_BYTES - MAX_MEDIA_CHUNK_BYTES as u64,
                    total_size_bytes: MAX_MEDIA_BYTES,
                    sha256: "f".repeat(64),
                    bytes: vec![u8::MAX; MAX_MEDIA_CHUNK_BYTES],
                    complete: true,
                }),
            }),
        );
        let encoded = encode_frame(&frame).unwrap();
        assert!(
            encoded.len() <= MAX_ENCODED_FRAME_BYTES,
            "encoded maximum chunk was {} bytes",
            encoded.len()
        );
        assert!(MAX_ENCODED_FRAME_BYTES - encoded.len() >= 750);
        assert_eq!(decode_frame(&encoded, 1_000_000).unwrap(), frame);
    }

    #[test]
    fn rejects_oversized_uploads_chunks_references_and_traversal() {
        let oversized = Frame::new(
            Uuid::new_v4(),
            1,
            100,
            Capability::FilesUpload,
            Body::UploadBegin(UploadBeginRequest {
                reservation_id: Uuid::new_v4(),
                name: "large.bin".to_string(),
                media_type: Some("application/octet-stream".to_string()),
                size_bytes: MAX_UPLOAD_BYTES + 1,
                sha256: "a".repeat(64),
            }),
        );
        assert!(matches!(
            oversized.validate(100),
            Err(ProtocolError::UploadTooLarge)
        ));

        let chunk = UploadChunkRequest {
            reservation_id: Uuid::new_v4(),
            offset_bytes: 0,
            bytes: vec![0; MAX_UPLOAD_CHUNK_BYTES + 1],
        };
        assert!(matches!(
            chunk.validate(),
            Err(ProtocolError::InvalidUploadChunk)
        ));

        let send = AgentSendRequest {
            stored_session_id: None,
            message: "Read these".to_string(),
            attachment_reference_ids: (0..=MAX_ATTACHMENT_REFERENCES)
                .map(|_| Uuid::new_v4())
                .collect(),
        };
        assert!(matches!(
            send.validate(),
            Err(ProtocolError::InvalidAttachmentReferences)
        ));

        for path in [
            "../secret.txt",
            "/Users/me/secret.txt",
            "Project/.env",
            "Project//secret.txt",
            r"C:\secret.txt",
        ] {
            assert!(matches!(
                validate_relative_path(path, false),
                Err(ProtocolError::InvalidRelativePath)
            ));
        }
    }

    #[test]
    fn directory_browse_entries_require_a_null_size() {
        let mut directory = BrowseEntry {
            name: "briefs".to_string(),
            relative_path: "Project/briefs".to_string(),
            kind: BrowseEntryKind::Directory,
            size_bytes: None,
            modified_at: Some("2026-07-28T12:00:00Z".to_string()),
        };
        directory.validate().unwrap();

        directory.size_bytes = Some(0);
        assert!(matches!(
            directory.validate(),
            Err(ProtocolError::InvalidBrowseEntry)
        ));
    }

    #[test]
    fn file_results_round_trip_without_exposing_a_mac_path() {
        let attachment = AttachmentReference {
            reference_id: Uuid::new_v4(),
            source: AttachmentSource::MacFile,
            name: "brief.md".to_string(),
            media_type: Some("text/markdown".to_string()),
            size_bytes: 42,
            expires_at_ms: 1_000_000,
        };
        let result = BrowseFile {
            entry: BrowseEntry {
                name: "brief.md".to_string(),
                relative_path: "Project/brief.md".to_string(),
                kind: BrowseEntryKind::File,
                size_bytes: Some(42),
                modified_at: Some("2026-07-28T12:00:00Z".to_string()),
            },
            attachment,
        };
        let frame = Frame::new(
            Uuid::new_v4(),
            1,
            100,
            Capability::FilesBrowse,
            Body::Response(Response {
                capability: Capability::FilesBrowse,
                result: ResultPayload::BrowseFile(result),
            }),
        );
        let encoded = encode_frame(&frame).unwrap();
        let encoded_text = String::from_utf8(encoded.clone()).unwrap();
        assert!(!encoded_text.contains("/Users/"));
        assert_eq!(decode_frame(&encoded, 100).unwrap(), frame);
    }

    #[test]
    fn media_references_and_chunks_are_bounded_and_self_consistent() {
        let image = MediaResultReference {
            artifact_id: "image-1".to_string(),
            kind: MediaKind::Image,
            media_type: "image/png".to_string(),
            width_px: Some(1024),
            height_px: Some(1024),
            duration_ms: None,
            size_bytes: 4 * 1024,
        };
        image.validate().unwrap();

        let mut oversized = image.clone();
        oversized.size_bytes = MAX_MEDIA_BYTES + 1;
        assert!(matches!(
            oversized.validate(),
            Err(ProtocolError::MediaTooLarge)
        ));

        let mut incomplete_dimensions = image;
        incomplete_dimensions.height_px = None;
        assert!(matches!(
            incomplete_dimensions.validate(),
            Err(ProtocolError::InvalidMediaReference)
        ));

        let invalid_chunk = MediaChunk {
            artifact_id: "video-1".to_string(),
            offset_bytes: 0,
            total_size_bytes: 2,
            sha256: "A".repeat(64),
            bytes: vec![1],
            complete: true,
        };
        assert!(matches!(
            invalid_chunk.validate(),
            Err(ProtocolError::InvalidMediaChunk)
        ));
    }

    #[test]
    fn media_types_require_one_slash_and_the_full_ascii_token_grammar() {
        for (kind, media_type) in [
            (MediaKind::Image, "image/x!#$%&'*+-.^_`|~"),
            (MediaKind::Video, "video/x!#$%&'*+-.^_`|~"),
        ] {
            let reference = MediaResultReference {
                artifact_id: "artifact-1".to_string(),
                kind,
                media_type: media_type.to_string(),
                width_px: None,
                height_px: None,
                duration_ms: None,
                size_bytes: 1,
            };
            reference.validate().unwrap();
        }

        for media_type in [
            "image/png/extra",
            "image/",
            "/png",
            "image",
            "image/p ng",
            "image/püng",
            "video/mp4/extra",
        ] {
            let reference = MediaResultReference {
                artifact_id: "artifact-1".to_string(),
                kind: if media_type.starts_with("video") {
                    MediaKind::Video
                } else {
                    MediaKind::Image
                },
                media_type: media_type.to_string(),
                width_px: None,
                height_px: None,
                duration_ms: None,
                size_bytes: 1,
            };
            assert!(
                matches!(
                    reference.validate(),
                    Err(ProtocolError::InvalidMediaReference)
                ),
                "{media_type} must be rejected"
            );
        }

        let wrong_kind = MediaResultReference {
            artifact_id: "artifact-1".to_string(),
            kind: MediaKind::Image,
            media_type: "video/mp4".to_string(),
            width_px: None,
            height_px: None,
            duration_ms: None,
            size_bytes: 1,
        };
        assert!(matches!(
            wrong_kind.validate(),
            Err(ProtocolError::InvalidMediaReference)
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

    #[test]
    fn device_self_round_trips_with_and_without_the_optional_desktop_name() {
        let now = 1_000_000;
        let response = |desktop_display_name| {
            Frame::new(
                Uuid::nil(),
                1,
                now,
                Capability::DevicesReadSelf,
                Body::Response(Response {
                    capability: Capability::DevicesReadSelf,
                    result: ResultPayload::Device(DeviceSelf {
                        device_id: Uuid::nil(),
                        display_name: "Phone".to_string(),
                        desktop_display_name,
                        linked_at: "2026-07-27T12:00:00Z".to_string(),
                        last_seen_at: None,
                        revoked_at: None,
                    }),
                }),
            )
        };

        let without_name = response(None);
        let encoded_without_name = encode_frame(&without_name).unwrap();
        assert!(!String::from_utf8_lossy(&encoded_without_name).contains("desktopDisplayName"));
        assert_eq!(
            decode_frame(&encoded_without_name, now).unwrap(),
            without_name
        );

        let with_name = response(Some("Studio Mac".to_string()));
        let encoded_with_name = encode_frame(&with_name).unwrap();
        assert!(String::from_utf8_lossy(&encoded_with_name).contains("desktopDisplayName"));
        assert_eq!(decode_frame(&encoded_with_name, now).unwrap(), with_name);

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct LegacyDeviceSelf {
            device_id: Uuid,
            display_name: String,
        }
        let current_device = DeviceSelf {
            device_id: Uuid::nil(),
            display_name: "Phone".to_string(),
            desktop_display_name: Some("Studio Mac".to_string()),
            linked_at: "2026-07-27T12:00:00Z".to_string(),
            last_seen_at: None,
            revoked_at: None,
        };
        let legacy_device: LegacyDeviceSelf =
            serde_json::from_slice(&serde_json::to_vec(&current_device).unwrap()).unwrap();
        assert_eq!(legacy_device.device_id, Uuid::nil());
        assert_eq!(legacy_device.display_name, "Phone");
    }

    #[test]
    fn device_self_rejects_an_unbounded_desktop_name() {
        let now = 1_000_000;
        let frame = Frame::new(
            Uuid::nil(),
            1,
            now,
            Capability::DevicesReadSelf,
            Body::Response(Response {
                capability: Capability::DevicesReadSelf,
                result: ResultPayload::Device(DeviceSelf {
                    device_id: Uuid::nil(),
                    display_name: "Phone".to_string(),
                    desktop_display_name: Some(
                        "x".repeat(MAX_DEVICE_DISPLAY_NAME_BYTES.saturating_add(1)),
                    ),
                    linked_at: "2026-07-27T12:00:00Z".to_string(),
                    last_seen_at: None,
                    revoked_at: None,
                }),
            }),
        );

        assert!(matches!(
            frame.validate(now),
            Err(ProtocolError::TextTooLarge)
        ));
    }
}
