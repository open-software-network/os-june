use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use tokio::sync::oneshot;
use uuid::Uuid;

pub(crate) const NOTE_SAVE_FLUSH_REQUESTED_EVENT: &str = "june://flush-pending-note-saves";
pub(crate) const NOTE_SAVE_FLUSH_TIMEOUT_MS: u64 = 10_000;
const NOTE_SAVE_FLUSH_TIMEOUT: Duration = Duration::from_millis(NOTE_SAVE_FLUSH_TIMEOUT_MS);

#[derive(Default)]
pub(crate) struct NoteSaveFlushState {
    pending: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteSaveFlushRequested {
    request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompleteNoteSaveFlushRequest {
    request_id: String,
}

#[tauri::command]
pub(crate) fn complete_note_save_flush(
    state: State<'_, NoteSaveFlushState>,
    request: CompleteNoteSaveFlushRequest,
) -> bool {
    complete(&state, &request.request_id)
}

/// Gives the renderer a bounded opportunity to drain its debounced note-row
/// writes while the webview and command runtime are still alive. The shutdown
/// supervisor includes this full budget so a patch already executing in SQLite
/// can finish before native teardown advances.
pub(crate) async fn request(app: &tauri::AppHandle) {
    let request_id = Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    let state = app.state::<NoteSaveFlushState>();
    state
        .pending
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(request_id.clone(), sender);

    if let Err(error) = app.emit(
        NOTE_SAVE_FLUSH_REQUESTED_EVENT,
        NoteSaveFlushRequested {
            request_id: request_id.clone(),
        },
    ) {
        remove_pending(&state, &request_id);
        tracing::warn!(%error, "could not request pending note-save flush");
        return;
    }

    match tokio::time::timeout(NOTE_SAVE_FLUSH_TIMEOUT, receiver).await {
        Ok(Ok(())) => {}
        Ok(Err(_)) => {
            tracing::warn!("pending note-save flush acknowledgement channel closed");
        }
        Err(_) => {
            tracing::warn!(
                timeout_ms = NOTE_SAVE_FLUSH_TIMEOUT.as_millis(),
                "timed out waiting for pending note saves"
            );
        }
    }
    remove_pending(&state, &request_id);
}

fn complete(state: &NoteSaveFlushState, request_id: &str) -> bool {
    let sender = state
        .pending
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(request_id);
    sender.is_some_and(|sender| sender.send(()).is_ok())
}

fn remove_pending(state: &NoteSaveFlushState, request_id: &str) {
    state
        .pending
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(request_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn acknowledgement_only_completes_the_matching_flush() {
        let state = NoteSaveFlushState::default();
        let (sender, receiver) = oneshot::channel();
        state
            .pending
            .lock()
            .expect("pending lock")
            .insert("flush-1".to_string(), sender);

        assert!(!complete(&state, "flush-2"));
        assert!(complete(&state, "flush-1"));
        receiver.await.expect("matching acknowledgement");
        assert!(!complete(&state, "flush-1"));
    }
}
