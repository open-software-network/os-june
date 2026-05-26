use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }
}

impl From<sqlx::Error> for AppError {
    fn from(value: sqlx::Error) -> Self {
        Self::new("storage_unavailable", value.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapResponse {
    pub folders: Vec<FolderDto>,
    pub notes: Vec<NoteListItemDto>,
    pub active_recoveries: Vec<RecoverableRecordingDto>,
    pub provider_configured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListNotesResponse {
    pub items: Vec<NoteListItemDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderDto {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteListItemDto {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub processing_status: ProcessingStatus,
    pub folder_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDto {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub processing_status: ProcessingStatus,
    pub folder_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub duration_ms: Option<i64>,
    pub generated_content: Option<String>,
    pub edited_content: Option<String>,
    pub transcript: Option<TranscriptDto>,
    #[serde(default)]
    pub source_transcripts: Vec<TranscriptDto>,
    pub recording: Option<RecordingSessionDto>,
    pub audio: Option<AudioArtifactDto>,
    #[serde(default)]
    pub audio_sources: Vec<AudioArtifactDto>,
    pub active_tab: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNoteRequest {
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListNotesRequest {
    pub folder_id: Option<String>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetNoteRequest {
    pub note_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteNoteRequest {
    pub note_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNoteRequest {
    pub note_id: String,
    pub title: Option<String>,
    pub edited_content: Option<String>,
    pub active_tab: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderRequest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFolderRequest {
    pub folder_id: String,
    pub delete_notes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameFolderRequest {
    pub folder_id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignNoteToFolderRequest {
    pub note_id: String,
    pub folder_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveNoteFromFolderRequest {
    pub note_id: String,
    pub folder_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingRequest {
    pub note_id: String,
    #[serde(default)]
    pub source_mode: Option<RecordingSourceMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishRecordingResponse {
    pub note: NoteDto,
    pub recording: RecordingSessionDto,
    pub validation: AudioValidationDto,
    #[serde(default)]
    pub validations: Vec<SourceValidationDto>,
    pub processing_started: bool,
    #[serde(default)]
    pub warnings: Vec<SourceWarningDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryProcessingRequest {
    pub note_id: String,
    pub step: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverRecordingRequest {
    pub session_id: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophonePermissionResponse {
    pub state: String,
    pub recovery_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRecordingSourceReadinessRequest {
    pub source_mode: RecordingSourceMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSourceReadinessDto {
    pub source_mode: RecordingSourceMode,
    pub ready: bool,
    pub checked_at: String,
    pub sources: Vec<SourceReadinessDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReadinessDto {
    pub source: RecordingSource,
    pub required: bool,
    pub ready: bool,
    pub permission_state: String,
    pub device_available: bool,
    pub capture_available: bool,
    pub recovery_action: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPrivacySettingsRequest {
    pub pane: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDto {
    pub id: String,
    pub text: String,
    pub source_mode: Option<RecordingSourceMode>,
    pub source: Option<String>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub turn_index: Option<i64>,
    pub language: Option<String>,
    pub status: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSessionDto {
    pub id: String,
    pub note_id: String,
    pub source_mode: RecordingSourceMode,
    pub state: RecordingState,
    pub started_at: String,
    pub elapsed_ms: i64,
    pub device_label: Option<String>,
    pub level: AudioLevelDto,
    #[serde(default)]
    pub sources: Vec<SourceStatusDto>,
    #[serde(default)]
    pub warnings: Vec<SourceWarningDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatusDto {
    pub session_id: String,
    pub source_mode: RecordingSourceMode,
    pub state: RecordingState,
    pub elapsed_ms: i64,
    pub level: AudioLevelDto,
    pub silence_warning: bool,
    pub bytes_written: i64,
    #[serde(default)]
    pub sources: Vec<SourceStatusDto>,
    #[serde(default)]
    pub warnings: Vec<SourceWarningDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioArtifactDto {
    pub id: String,
    pub source: String,
    pub format: String,
    pub duration_ms: i64,
    pub size_bytes: i64,
    pub checksum: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatusDto {
    pub source: RecordingSource,
    pub state: SourceState,
    pub elapsed_ms: i64,
    pub bytes_written: i64,
    pub level: AudioLevelDto,
    pub silence_warning: bool,
    pub path_finalized: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceValidationDto {
    pub source: RecordingSource,
    pub file_exists: bool,
    pub non_zero_size: bool,
    pub readable_audio: bool,
    pub expected_duration_ms: i64,
    pub actual_duration_ms: Option<i64>,
    pub duration_within_tolerance: bool,
    pub non_silent_signal: bool,
    pub peak_amplitude: Option<f32>,
    pub rms_amplitude: Option<f32>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceWarningDto {
    pub source: RecordingSource,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioValidationDto {
    pub file_exists: bool,
    pub non_zero_size: bool,
    pub readable_audio: bool,
    pub expected_duration_ms: i64,
    pub actual_duration_ms: i64,
    pub duration_within_tolerance: bool,
    pub non_silent_signal: bool,
    pub peak_amplitude: f32,
    pub rms_amplitude: f32,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevelDto {
    pub peak: f32,
    pub rms: f32,
    pub recent_peaks: Vec<f32>,
}

impl Default for AudioLevelDto {
    fn default() -> Self {
        Self {
            peak: 0.0,
            rms: 0.0,
            recent_peaks: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverableRecordingDto {
    pub session_id: String,
    pub note_id: String,
    pub source_mode: RecordingSourceMode,
    pub started_at: String,
    pub partial_path_present: bool,
    pub final_path_present: bool,
    pub bytes_found: i64,
    #[serde(default)]
    pub sources: Vec<RecoverableSourceDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverableSourceDto {
    pub source: RecordingSource,
    pub partial_path_present: bool,
    pub final_path_present: bool,
    pub bytes_found: i64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProcessingStatus {
    Draft,
    Recording,
    Validating,
    Transcribing,
    Generating,
    Ready,
    Failed,
    Recoverable,
}

impl ProcessingStatus {
    pub fn as_db(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Recording => "recording",
            Self::Validating => "validating",
            Self::Transcribing => "transcribing",
            Self::Generating => "generating",
            Self::Ready => "ready",
            Self::Failed => "failed",
            Self::Recoverable => "recoverable",
        }
    }
}

impl From<&str> for ProcessingStatus {
    fn from(value: &str) -> Self {
        match value {
            "recording" => Self::Recording,
            "validating" => Self::Validating,
            "transcribing" => Self::Transcribing,
            "generating" => Self::Generating,
            "ready" => Self::Ready,
            "failed" => Self::Failed,
            "recoverable" => Self::Recoverable,
            _ => Self::Draft,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecordingSourceMode {
    MicrophoneOnly,
    MicrophonePlusSystem,
}

impl Default for RecordingSourceMode {
    fn default() -> Self {
        Self::MicrophoneOnly
    }
}

impl RecordingSourceMode {
    pub fn as_db(self) -> &'static str {
        match self {
            Self::MicrophoneOnly => "microphone_only",
            Self::MicrophonePlusSystem => "microphone_plus_system",
        }
    }

    pub fn required_sources(self) -> Vec<RecordingSource> {
        match self {
            Self::MicrophoneOnly => vec![RecordingSource::Microphone],
            Self::MicrophonePlusSystem => {
                vec![RecordingSource::Microphone, RecordingSource::System]
            }
        }
    }
}

impl From<&str> for RecordingSourceMode {
    fn from(value: &str) -> Self {
        match value {
            "microphone_plus_system" | "microphonePlusSystem" => Self::MicrophonePlusSystem,
            _ => Self::MicrophoneOnly,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecordingSource {
    Microphone,
    System,
}

impl RecordingSource {
    pub fn as_db(self) -> &'static str {
        match self {
            Self::Microphone => "microphone",
            Self::System => "system",
        }
    }
}

impl From<&str> for RecordingSource {
    fn from(value: &str) -> Self {
        match value {
            "system" => Self::System,
            _ => Self::Microphone,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecordingState {
    Idle,
    PermissionDenied,
    Starting,
    Recording,
    Paused,
    Finalizing,
    Validating,
    PartiallyValid,
    Invalid,
    Ready,
    Failed,
    Recoverable,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceState {
    Pending,
    PermissionDenied,
    Unavailable,
    Starting,
    Recording,
    Paused,
    Finalizing,
    Finalized,
    Valid,
    Invalid,
    Recoverable,
    Failed,
}
