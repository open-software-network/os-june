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
    pub recording: Option<RecordingSessionDto>,
    pub audio: Option<AudioArtifactDto>,
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
    pub processing_started: bool,
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
pub struct TranscriptDto {
    pub id: String,
    pub text: String,
    pub language: Option<String>,
    pub status: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSessionDto {
    pub id: String,
    pub note_id: String,
    pub state: RecordingState,
    pub started_at: String,
    pub elapsed_ms: i64,
    pub device_label: Option<String>,
    pub level: AudioLevelDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatusDto {
    pub session_id: String,
    pub state: RecordingState,
    pub elapsed_ms: i64,
    pub level: AudioLevelDto,
    pub silence_warning: bool,
    pub bytes_written: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioArtifactDto {
    pub id: String,
    pub format: String,
    pub duration_ms: i64,
    pub size_bytes: i64,
    pub checksum: String,
    pub created_at: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverableRecordingDto {
    pub session_id: String,
    pub note_id: String,
    pub started_at: String,
    pub partial_path_present: bool,
    pub final_path_present: bool,
    pub bytes_found: i64,
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
pub enum RecordingState {
    Idle,
    PermissionDenied,
    Recording,
    Paused,
    Finalizing,
    Validating,
    Invalid,
    Ready,
    Failed,
    Recoverable,
}
