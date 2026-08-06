use crate::domain::types::{AppError, RecordingSourceMode};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

const REQUEST_EVENT: &str = "clovy://agent-recorder-request";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(420);
const COMPLETED_CAP: usize = 32;

#[derive(Default)]
pub struct AgentRecorderBroker {
    pending: Mutex<HashMap<String, oneshot::Sender<ResolveAgentRecorderRequest>>>,
    completed: Mutex<VecDeque<String>>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentRecorderAction {
    Start,
    Stop,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRecorderRequestPayload {
    request_id: String,
    action: AgentRecorderAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_mode: Option<RecordingSourceMode>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveAgentRecorderRequest {
    pub request_id: String,
    pub ok: bool,
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub note_title: Option<String>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
}

impl AgentRecorderBroker {
    pub async fn request(
        &self,
        app: &AppHandle,
        action: AgentRecorderAction,
        source_mode: Option<RecordingSourceMode>,
    ) -> Result<serde_json::Value, AppError> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| unavailable())?
            .insert(request_id.clone(), sender);
        let payload = AgentRecorderRequestPayload {
            request_id: request_id.clone(),
            action,
            source_mode,
        };
        let emit_result = app
            .get_webview_window("main")
            .ok_or_else(|| {
                AppError::new(
                    "agent_recorder_window_unavailable",
                    "The Clovy window is unavailable.",
                )
            })
            .and_then(|window| {
                window
                    .emit(REQUEST_EVENT, payload)
                    .map_err(|error| AppError::new("agent_recorder_emit_failed", error.to_string()))
            });
        if let Err(error) = emit_result {
            self.remove_pending(&request_id);
            return Err(error);
        }
        let resolution = match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(resolution)) => resolution,
            Ok(Err(_)) => {
                return Err(AppError::new(
                    "agent_recorder_cancelled",
                    "The recorder request was cancelled before Clovy answered.",
                ));
            }
            Err(_) => {
                self.remove_pending(&request_id);
                return Err(AppError::new(
                    "agent_recorder_timeout",
                    "The recorder request timed out waiting for Clovy.",
                ));
            }
        };
        if !resolution.ok {
            return Err(AppError::new(
                resolution
                    .error_code
                    .unwrap_or_else(|| "agent_recorder_failed".to_string()),
                resolution
                    .error_message
                    .unwrap_or_else(|| "The recorder request failed.".to_string()),
            ));
        }
        Ok(serde_json::json!({
            "success": true,
            "noteId": resolution.note_id,
            "noteTitle": resolution.note_title,
        }))
    }

    fn remove_pending(&self, request_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(request_id);
        }
    }

    fn resolve(&self, request: ResolveAgentRecorderRequest) -> Result<(), AppError> {
        let request_id = request.request_id.clone();
        let sender = self
            .pending
            .lock()
            .map_err(|_| unavailable())?
            .remove(&request_id);
        let Some(sender) = sender else {
            if self
                .completed
                .lock()
                .map(|completed| completed.iter().any(|id| id == &request_id))
                .unwrap_or(false)
            {
                return Ok(());
            }
            return Err(AppError::new(
                "agent_recorder_request_not_found",
                "The recorder request was not found or has already timed out.",
            ));
        };
        sender.send(request).map_err(|_| {
            AppError::new(
                "agent_recorder_request_not_found",
                "The recorder request was not found or has already timed out.",
            )
        })?;
        if let Ok(mut completed) = self.completed.lock() {
            completed.push_back(request_id);
            while completed.len() > COMPLETED_CAP {
                completed.pop_front();
            }
        }
        Ok(())
    }
}

fn unavailable() -> AppError {
    AppError::new(
        "agent_recorder_unavailable",
        "The recorder request broker is unavailable.",
    )
}

#[tauri::command]
pub fn resolve_agent_recorder_request(
    broker: State<'_, AgentRecorderBroker>,
    request: ResolveAgentRecorderRequest,
) -> Result<(), AppError> {
    broker.resolve(request)
}
