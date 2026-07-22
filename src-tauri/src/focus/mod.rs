mod deep_link;
mod macos_shortcuts;
mod repository;
pub mod types;

use crate::{commands, domain::types::AppError, notifications};
use deep_link::FocusDeepLinkAction;
use repository::FocusTransition;
use serde::Serialize;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use types::{
    FocusActionRequest, FocusSessionDto, FocusSessionRequest, ListFocusHistoryRequest,
    ReassignFocusSegmentRequest, SplitFocusSegmentRequest, StartFocusRequest,
    UpdateFocusCompletionRequest, UpdateNextFocusProjectRequest,
};

pub use deep_link::parse_focus_deep_link;
pub use repository::DEFAULT_FOCUS_MINUTES;

pub const FOCUS_CHANGED_EVENT: &str = "june:focus:changed";
pub const FOCUS_OPEN_EVENT: &str = "june:focus:open";
static FOCUS_OPEN_PENDING: AtomicBool = AtomicBool::new(false);
static FOCUS_ERROR_PENDING: std::sync::Mutex<Option<AppError>> = std::sync::Mutex::new(None);
static FOCUS_COMMAND_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FocusTransitionEvent {
    transition: &'static str,
}

#[tauri::command]
pub async fn focus_start(
    app: AppHandle,
    request: StartFocusRequest,
) -> Result<FocusSessionDto, AppError> {
    let _guard = FOCUS_COMMAND_LOCK.lock().await;
    let repos = commands::repositories(&app).await?;
    let session = repos.start_focus(request).await?;
    emit_session(&app, &session);
    macos_shortcuts::launch_start_shortcut(&app, session.start_shortcut_name.as_deref());
    Ok(session)
}

#[tauri::command]
pub async fn focus_create_plan(
    app: AppHandle,
    request: StartFocusRequest,
) -> Result<FocusSessionDto, AppError> {
    let _guard = FOCUS_COMMAND_LOCK.lock().await;
    let repos = commands::repositories(&app).await?;
    let session = repos.create_focus_plan(request).await?;
    emit_session(&app, &session);
    Ok(session)
}

#[tauri::command]
pub async fn focus_start_plan(
    app: AppHandle,
    request: FocusSessionRequest,
) -> Result<FocusSessionDto, AppError> {
    let _guard = FOCUS_COMMAND_LOCK.lock().await;
    let repos = commands::repositories(&app).await?;
    let session = repos.start_focus_plan(&request.session_id).await?;
    emit_session(&app, &session);
    macos_shortcuts::launch_start_shortcut(&app, session.start_shortcut_name.as_deref());
    Ok(session)
}

#[tauri::command]
pub async fn focus_list_macos_shortcuts() -> Result<Vec<String>, AppError> {
    macos_shortcuts::list().await
}

#[tauri::command]
pub async fn focus_status(app: AppHandle) -> Result<Option<FocusSessionDto>, AppError> {
    let _guard = FOCUS_COMMAND_LOCK.lock().await;
    let repos = commands::repositories(&app).await?;
    emit_transitions(
        &app,
        repos.reconcile_active_focus_at(chrono::Utc::now()).await?,
    );
    repos.active_focus_session_at(chrono::Utc::now()).await
}

/// Drains a Focus deep link that arrived before the webview registered its
/// `june:focus:open` listener. The native route still emits immediately for a
/// warm app; this handshake covers cold launch and webview reload races.
#[tauri::command]
pub fn focus_open_ready() -> bool {
    FOCUS_OPEN_PENDING.swap(false, Ordering::AcqRel)
}

/// Drains a deep-link action error that arrived before the webview's error
/// listener was ready. Warm events call this too so an already-rendered error
/// cannot leak into a later open action.
#[tauri::command]
pub fn focus_error_ready() -> Option<AppError> {
    FOCUS_ERROR_PENDING
        .lock()
        .ok()
        .and_then(|mut pending| pending.take())
}

#[tauri::command]
pub async fn focus_pause(
    app: AppHandle,
    request: FocusActionRequest,
) -> Result<FocusSessionDto, AppError> {
    action(&app, request, |repos, session_id| {
        Box::pin(repos.pause_focus(session_id))
    })
    .await
}

#[tauri::command]
pub async fn focus_resume(
    app: AppHandle,
    request: FocusActionRequest,
) -> Result<FocusSessionDto, AppError> {
    action(&app, request, |repos, session_id| {
        Box::pin(repos.resume_focus(session_id))
    })
    .await
}

#[tauri::command]
pub async fn focus_start_break(
    app: AppHandle,
    request: FocusActionRequest,
) -> Result<FocusSessionDto, AppError> {
    action(&app, request, |repos, session_id| {
        Box::pin(repos.start_focus_break(session_id))
    })
    .await
}

#[tauri::command]
pub async fn focus_finish(
    app: AppHandle,
    request: FocusActionRequest,
) -> Result<FocusSessionDto, AppError> {
    action(&app, request, |repos, session_id| {
        Box::pin(repos.finish_focus(session_id))
    })
    .await
}

#[tauri::command]
pub async fn focus_abandon(
    app: AppHandle,
    request: FocusActionRequest,
) -> Result<FocusSessionDto, AppError> {
    action(&app, request, |repos, session_id| {
        Box::pin(repos.abandon_focus(session_id))
    })
    .await
}

async fn action<F>(
    app: &AppHandle,
    request: FocusActionRequest,
    run: F,
) -> Result<FocusSessionDto, AppError>
where
    F: for<'a> FnOnce(
        &'a crate::db::repositories::Repositories,
        Option<&'a str>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<FocusSessionDto, AppError>> + Send + 'a>,
    >,
{
    let _guard = FOCUS_COMMAND_LOCK.lock().await;
    let repos = commands::repositories(app).await?;
    emit_transitions(
        app,
        repos.reconcile_active_focus_at(chrono::Utc::now()).await?,
    );
    let session = run(&repos, request.session_id.as_deref()).await?;
    emit_session(app, &session);
    Ok(session)
}

#[tauri::command]
pub async fn focus_update_completion(
    app: AppHandle,
    request: UpdateFocusCompletionRequest,
) -> Result<FocusSessionDto, AppError> {
    let _guard = FOCUS_COMMAND_LOCK.lock().await;
    let repos = commands::repositories(&app).await?;
    let session = repos
        .update_focus_completion(
            &request.session_id,
            request.reflection.as_deref(),
            request.quality,
        )
        .await?;
    emit_session(&app, &session);
    Ok(session)
}

#[tauri::command]
pub async fn focus_update_next_project(
    app: AppHandle,
    request: UpdateNextFocusProjectRequest,
) -> Result<FocusSessionDto, AppError> {
    let _guard = FOCUS_COMMAND_LOCK.lock().await;
    let repos = commands::repositories(&app).await?;
    emit_transitions(
        &app,
        repos.reconcile_active_focus_at(chrono::Utc::now()).await?,
    );
    let session = repos
        .update_next_focus_project(&request.session_id, request.project_id.as_deref())
        .await?;
    emit_session(&app, &session);
    Ok(session)
}

#[tauri::command]
pub async fn focus_split_segment(
    app: AppHandle,
    request: SplitFocusSegmentRequest,
) -> Result<FocusSessionDto, AppError> {
    let _guard = FOCUS_COMMAND_LOCK.lock().await;
    let repos = commands::repositories(&app).await?;
    let session = repos
        .split_focus_segment(&request.segment_id, &request.split_at)
        .await?;
    emit_session(&app, &session);
    Ok(session)
}

#[tauri::command]
pub async fn focus_reassign_segment(
    app: AppHandle,
    request: ReassignFocusSegmentRequest,
) -> Result<FocusSessionDto, AppError> {
    let _guard = FOCUS_COMMAND_LOCK.lock().await;
    let repos = commands::repositories(&app).await?;
    let session = repos
        .reassign_focus_segment(&request.segment_id, request.project_id.as_deref())
        .await?;
    emit_session(&app, &session);
    Ok(session)
}

#[tauri::command]
pub async fn focus_history(
    app: AppHandle,
    request: ListFocusHistoryRequest,
) -> Result<Vec<FocusSessionDto>, AppError> {
    commands::repositories(&app)
        .await?
        .list_focus_history(request)
        .await
}

pub fn setup(app: &tauri::App) {
    let app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            let _guard = FOCUS_COMMAND_LOCK.lock().await;
            let Ok(repos) = commands::repositories(&app).await else {
                continue;
            };
            if let Ok(transitions) = repos.reconcile_active_focus_at(chrono::Utc::now()).await {
                emit_transitions(&app, transitions);
            }
        }
    });
}

pub fn handle_deep_link(app: AppHandle, value: &str) -> bool {
    let Some(action) = parse_focus_deep_link(value) else {
        return false;
    };
    show_main_window(&app);
    FOCUS_OPEN_PENDING.store(true, Ordering::Release);
    let _ = app.emit(FOCUS_OPEN_EVENT, ());
    tauri::async_runtime::spawn(async move {
        let result = match action {
            FocusDeepLinkAction::Open => return,
            FocusDeepLinkAction::Start(request) => focus_start(app.clone(), request).await,
            FocusDeepLinkAction::Pause => {
                focus_pause(app.clone(), FocusActionRequest::default()).await
            }
            FocusDeepLinkAction::Resume => {
                focus_resume(app.clone(), FocusActionRequest::default()).await
            }
            FocusDeepLinkAction::StartBreak => {
                focus_start_break(app.clone(), FocusActionRequest::default()).await
            }
            FocusDeepLinkAction::Finish => {
                focus_finish(app.clone(), FocusActionRequest::default()).await
            }
            FocusDeepLinkAction::Abandon => {
                focus_abandon(app.clone(), FocusActionRequest::default()).await
            }
        };
        if let Err(error) = result {
            if let Ok(mut pending) = FOCUS_ERROR_PENDING.lock() {
                *pending = Some(error.clone());
            }
            let _ = app.emit("june:focus:error", error);
        }
    });
    true
}

fn emit_session(app: &AppHandle, session: &FocusSessionDto) {
    let _ = app.emit(FOCUS_CHANGED_EVENT, session);
}

fn emit_transitions(app: &AppHandle, transitions: Vec<FocusTransition>) {
    for transition in transitions {
        let (name, title, body) = match transition {
            FocusTransition::EnteredOvertime => (
                "enteredOvertime",
                "Focus time is up",
                "Finish, continue in overtime, or start your planned break.",
            ),
            FocusTransition::BreakCompleted => (
                "breakCompleted",
                "Break is over",
                "Your next focus interval has started.",
            ),
        };
        notifications::send_focus_notification(app, title, body);
        let _ = app.emit(
            FOCUS_CHANGED_EVENT,
            FocusTransitionEvent { transition: name },
        );
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
