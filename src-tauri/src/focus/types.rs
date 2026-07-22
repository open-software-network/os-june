use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FocusStatus {
    Planned,
    Focusing,
    Paused,
    Overtime,
    OnBreak,
    Completed,
    Abandoned,
}

impl FocusStatus {
    pub(crate) const fn as_db(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Focusing => "focusing",
            Self::Paused => "paused",
            Self::Overtime => "overtime",
            Self::OnBreak => "on_break",
            Self::Completed => "completed",
            Self::Abandoned => "abandoned",
        }
    }

    pub(crate) fn from_db(value: &str) -> Option<Self> {
        match value {
            "planned" => Some(Self::Planned),
            "focusing" => Some(Self::Focusing),
            "paused" => Some(Self::Paused),
            "overtime" => Some(Self::Overtime),
            "on_break" => Some(Self::OnBreak),
            "completed" => Some(Self::Completed),
            "abandoned" => Some(Self::Abandoned),
            _ => None,
        }
    }

    pub(crate) const fn is_active(self) -> bool {
        matches!(
            self,
            Self::Planned | Self::Focusing | Self::Paused | Self::Overtime | Self::OnBreak
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FocusIntervalKind {
    Focus,
    Break,
}

impl FocusIntervalKind {
    pub(crate) const fn as_db(self) -> &'static str {
        match self {
            Self::Focus => "focus",
            Self::Break => "break",
        }
    }

    pub(crate) fn from_db(value: &str) -> Option<Self> {
        match value {
            "focus" => Some(Self::Focus),
            "break" => Some(Self::Break),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FocusSegmentKind {
    Focus,
    Pause,
    Break,
    Overtime,
}

impl FocusSegmentKind {
    pub(crate) const fn as_db(self) -> &'static str {
        match self {
            Self::Focus => "focus",
            Self::Pause => "pause",
            Self::Break => "break",
            Self::Overtime => "overtime",
        }
    }

    pub(crate) fn from_db(value: &str) -> Option<Self> {
        match value {
            "focus" => Some(Self::Focus),
            "pause" => Some(Self::Pause),
            "break" => Some(Self::Break),
            "overtime" => Some(Self::Overtime),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FocusOutcome {
    Active,
    Completed,
    Shortened,
    Overtime,
    Abandoned,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusIntervalInput {
    pub kind: FocusIntervalKind,
    pub duration_minutes: u32,
    #[serde(default)]
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartFocusRequest {
    #[serde(default)]
    pub intention: Option<String>,
    #[serde(default)]
    pub start_shortcut_name: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub duration_minutes: Option<u32>,
    #[serde(default)]
    pub interval_count: Option<u32>,
    #[serde(default)]
    pub interval_duration_minutes: Option<u32>,
    #[serde(default)]
    pub break_duration_minutes: Option<u32>,
    #[serde(default)]
    pub long_break_duration_minutes: Option<u32>,
    #[serde(default)]
    pub interval_plan: Option<Vec<FocusIntervalInput>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSessionRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusActionRequest {
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFocusCompletionRequest {
    pub session_id: String,
    #[serde(default)]
    pub reflection: Option<String>,
    #[serde(default)]
    pub quality: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNextFocusProjectRequest {
    pub session_id: String,
    #[serde(default)]
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitFocusSegmentRequest {
    pub segment_id: String,
    pub split_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReassignFocusSegmentRequest {
    pub segment_id: String,
    #[serde(default)]
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFocusHistoryRequest {
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusIntervalDto {
    pub position: u32,
    pub kind: FocusIntervalKind,
    pub planned_duration_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSegmentDto {
    pub id: String,
    pub interval_position: u32,
    pub kind: FocusSegmentKind,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    pub duration_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSessionDto {
    pub id: String,
    pub intention: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_shortcut_name: Option<String>,
    pub status: FocusStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_from: Option<FocusStatus>,
    pub current_interval_position: u32,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abandoned_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reflection: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<u8>,
    pub intervals: Vec<FocusIntervalDto>,
    pub segments: Vec<FocusSegmentDto>,
    pub planned_focus_ms: i64,
    pub actual_focus_ms: i64,
    pub actual_break_ms: i64,
    pub paused_ms: i64,
    pub current_elapsed_ms: i64,
    pub remaining_ms: i64,
    pub overtime_ms: i64,
    pub outcome: FocusOutcome,
}
