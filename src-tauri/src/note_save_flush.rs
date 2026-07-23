use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use tokio::sync::oneshot;
use uuid::Uuid;

pub(crate) const NOTE_SAVE_FLUSH_REQUESTED_EVENT: &str = "june://flush-pending-note-saves";
const NOTE_SAVE_FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
pub(crate) struct NoteSaveFlushState {
    pending: Mutex<HashMap<String, oneshot::Sender<()>>>,
    exit_flush_started: AtomicBool,
    exit_allowed: AtomicBool,
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
/// writes while the webview and command runtime are still alive.
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

/// Current-main compatibility seam. Once the shared shutdown coordinator is
/// present, it calls [`request`] as its first cleanup step instead.
pub(crate) fn handle_exit_requested(
    app: &tauri::AppHandle,
    code: Option<i32>,
    api: &tauri::ExitRequestApi,
) {
    let state = app.state::<NoteSaveFlushState>();
    if state.exit_allowed.load(Ordering::Acquire) {
        return;
    }

    api.prevent_exit();
    if state.exit_flush_started.swap(true, Ordering::AcqRel) {
        return;
    }

    let flush_app = app.clone();
    tauri::async_runtime::spawn(async move {
        request(&flush_app).await;
        flush_app
            .state::<NoteSaveFlushState>()
            .exit_allowed
            .store(true, Ordering::Release);
        let exit_code = code.unwrap_or(0);
        let final_app = flush_app.clone();
        if let Err(error) = flush_app.run_on_main_thread(move || final_app.exit(exit_code)) {
            tracing::warn!(%error, "could not schedule exit after pending note-save flush");
            flush_app.exit(exit_code);
        }
    });
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
