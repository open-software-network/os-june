use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, AppHandle, Emitter, Listener, Manager, Runtime,
};

const TRAY_ID: &str = "agent-menu-bar";
const AGENT_MENU_BAR_STATE_EVENT: &str = "scribe:menu-bar:agent-state";
const AGENT_MENU_BAR_NEW_SESSION_EVENT: &str = "scribe:menu-bar:new-agent-session";
const AGENT_MENU_BAR_OPEN_SESSION_EVENT: &str = "scribe:menu-bar:open-agent-session";

const MENU_SHOW_ID: &str = "agent_menu_bar_show";
const MENU_NEW_SESSION_ID: &str = "agent_menu_bar_new_session";
const MENU_QUIT_ID: &str = "agent_menu_bar_quit";
const MENU_STATUS_ID: &str = "agent_menu_bar_status";
const MENU_LAST_STATUS_ID: &str = "agent_menu_bar_last_status";
const MENU_RECENT_SESSIONS_ID: &str = "agent_menu_bar_recent_sessions";
const MENU_EMPTY_SESSIONS_ID: &str = "agent_menu_bar_empty_sessions";
const MENU_SESSION_ID_PREFIX: &str = "agent_menu_bar_session:";

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentMenuBarState {
    #[serde(default)]
    active_count: usize,
    #[serde(default)]
    needs_user_count: usize,
    #[serde(default)]
    sessions: Vec<AgentMenuBarSession>,
    #[serde(default)]
    last_status: Option<AgentMenuBarLastStatus>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentMenuBarSession {
    id: String,
    title: String,
    #[serde(default)]
    subtitle: Option<String>,
    status: AgentMenuBarSessionStatus,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum AgentMenuBarSessionStatus {
    Idle,
    Running,
    WaitingForUser,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentMenuBarLastStatus {
    #[serde(default)]
    title: Option<String>,
    status: String,
    #[serde(default)]
    summary: Option<String>,
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    let initial_state = AgentMenuBarState::default();
    let initial_menu = build_menu(app, &initial_state)?;
    let mut tray_builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&initial_menu)
        .tooltip(tray_tooltip(&initial_state))
        .show_menu_on_left_click(true)
        .on_menu_event(handle_menu_event);

    if let Some(title) = tray_title(&initial_state) {
        tray_builder = tray_builder.title(title);
    }

    if let Some(icon) = app.handle().default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon).icon_as_template(true);
    }

    let tray = tray_builder.build(app)?;
    update_tray(&tray, &initial_state);

    let handle = app.handle().clone();
    app.listen_any(AGENT_MENU_BAR_STATE_EVENT, move |event| {
        let Ok(state) = serde_json::from_str::<AgentMenuBarState>(event.payload()) else {
            return;
        };
        let Some(tray) = handle.tray_by_id(TRAY_ID) else {
            return;
        };
        if let Ok(menu) = build_menu(&handle, &state) {
            let _ = tray.set_menu(Some(menu));
        }
        update_tray(&tray, &state);
    });

    Ok(())
}

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    if id == MENU_SHOW_ID {
        show_main_window(app);
        return;
    }
    if id == MENU_NEW_SESSION_ID {
        show_main_window(app);
        let _ = app.emit(AGENT_MENU_BAR_NEW_SESSION_EVENT, ());
        return;
    }
    if id == MENU_QUIT_ID {
        app.exit(0);
        return;
    }
    if let Some(session_id) = id.strip_prefix(MENU_SESSION_ID_PREFIX) {
        show_main_window(app);
        let _ = app.emit(AGENT_MENU_BAR_OPEN_SESSION_EVENT, session_id.to_string());
    }
}

fn build_menu<R, M>(manager: &M, state: &AgentMenuBarState) -> tauri::Result<Menu<R>>
where
    R: Runtime,
    M: Manager<R>,
{
    let menu = Menu::new(manager)?;

    let show_item = MenuItem::with_id(manager, MENU_SHOW_ID, "Open June", true, None::<&str>)?;
    let new_session_item = MenuItem::with_id(
        manager,
        MENU_NEW_SESSION_ID,
        "New Agent Session...",
        true,
        None::<&str>,
    )?;
    let status_item = MenuItem::with_id(
        manager,
        MENU_STATUS_ID,
        escape_menu_text(status_label(state)),
        false,
        None::<&str>,
    )?;

    menu.append(&show_item)?;
    menu.append(&new_session_item)?;
    menu.append(&PredefinedMenuItem::separator(manager)?)?;
    menu.append(&status_item)?;

    if let Some(last_status) = state.last_status.as_ref() {
        let last_status_item = MenuItem::with_id(
            manager,
            MENU_LAST_STATUS_ID,
            escape_menu_text(last_status_label(last_status)),
            false,
            None::<&str>,
        )?;
        menu.append(&last_status_item)?;
    }

    menu.append(&PredefinedMenuItem::separator(manager)?)?;

    let recent_label = MenuItem::with_id(
        manager,
        MENU_RECENT_SESSIONS_ID,
        "Recent Agent Sessions",
        false,
        None::<&str>,
    )?;
    menu.append(&recent_label)?;

    if state.sessions.is_empty() {
        let empty_item = MenuItem::with_id(
            manager,
            MENU_EMPTY_SESSIONS_ID,
            "No sessions yet",
            false,
            None::<&str>,
        )?;
        menu.append(&empty_item)?;
    } else {
        for session in &state.sessions {
            let session_item = MenuItem::with_id(
                manager,
                format!("{MENU_SESSION_ID_PREFIX}{}", session.id),
                escape_menu_text(session_label(session)),
                true,
                None::<&str>,
            )?;
            menu.append(&session_item)?;
        }
    }

    menu.append(&PredefinedMenuItem::separator(manager)?)?;

    let quit_item = MenuItem::with_id(manager, MENU_QUIT_ID, "Quit June", true, None::<&str>)?;
    menu.append(&quit_item)?;

    Ok(menu)
}

fn update_tray<R: Runtime>(tray: &tauri::tray::TrayIcon<R>, state: &AgentMenuBarState) {
    let _ = tray.set_title(tray_title(state));
    let _ = tray.set_tooltip(Some(tray_tooltip(state)));
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn tray_title(state: &AgentMenuBarState) -> Option<String> {
    if state.needs_user_count > 0 {
        return Some(counted_status_title(
            "Needs Approval",
            state.needs_user_count,
        ));
    }
    if state.active_count > 0 {
        return Some(counted_status_title("Working...", state.active_count));
    }
    if let Some(last_status) = state.last_status.as_ref() {
        return status_title(&last_status.status).map(str::to_string);
    }
    None
}

fn tray_tooltip(state: &AgentMenuBarState) -> String {
    let status = status_label(state);
    format!("June - {status}")
}

fn status_label(state: &AgentMenuBarState) -> String {
    if state.needs_user_count > 0 {
        let waiting = pluralize(state.needs_user_count, "session", "sessions");
        let needs_approval = if state.needs_user_count == 1 {
            "needs approval"
        } else {
            "need approval"
        };
        if state.active_count > state.needs_user_count {
            let working_count = state.active_count - state.needs_user_count;
            return format!(
                "{waiting} {needs_approval}, {} working",
                pluralize(working_count, "session", "sessions")
            );
        }
        return format!("{waiting} {needs_approval}");
    }
    if state.active_count > 0 {
        return format!(
            "{} working",
            pluralize(state.active_count, "session", "sessions")
        );
    }
    "No active agent sessions".to_string()
}

fn last_status_label(last_status: &AgentMenuBarLastStatus) -> String {
    let title = last_status
        .title
        .as_deref()
        .map(normalize_menu_text)
        .filter(|value| !value.is_empty());
    let summary = last_status
        .summary
        .as_deref()
        .map(normalize_menu_text)
        .filter(|value| !value.is_empty());
    let status = readable_status(&last_status.status);

    match (title, summary) {
        (Some(title), Some(summary)) => format!("Last: {title} - {summary}"),
        (Some(title), None) => format!("Last: {title} - {status}"),
        (None, Some(summary)) => format!("Last: {summary}"),
        (None, None) => format!("Last: {status}"),
    }
}

fn session_label(session: &AgentMenuBarSession) -> String {
    let title = normalize_menu_text(&session.title);
    let title = if title.is_empty() {
        "Untitled session".to_string()
    } else {
        title
    };
    let prefix = match session.status {
        AgentMenuBarSessionStatus::WaitingForUser => "Needs Approval - ",
        AgentMenuBarSessionStatus::Running => "Working - ",
        AgentMenuBarSessionStatus::Idle => "",
    };
    let subtitle = session
        .subtitle
        .as_deref()
        .map(normalize_menu_text)
        .filter(|value| !value.is_empty());

    match subtitle {
        Some(subtitle) => format!("{prefix}{title} - {subtitle}"),
        None => format!("{prefix}{title}"),
    }
}

fn readable_status(status: &str) -> &'static str {
    match status {
        "received" => "Received",
        "starting" => "Starting",
        "running" => "Working",
        "waitingForUser" => "Needs Approval",
        "completed" => "Completed",
        "failed" => "Failed",
        "cancelled" => "Cancelled",
        _ => "Updated",
    }
}

fn status_title(status: &str) -> Option<&'static str> {
    match status {
        "received" | "starting" => Some("Starting..."),
        "running" => Some("Working..."),
        "waitingForUser" => Some("Needs Approval"),
        "failed" => Some("Failed"),
        "cancelled" => Some("Cancelled"),
        _ => None,
    }
}

fn counted_status_title(label: &str, count: usize) -> String {
    if count <= 1 {
        label.to_string()
    } else {
        format!("{label} ({count})")
    }
}

fn pluralize(count: usize, singular: &str, plural: &str) -> String {
    if count == 1 {
        format!("1 {singular}")
    } else {
        format!("{count} {plural}")
    }
}

fn normalize_menu_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn escape_menu_text(value: String) -> String {
    value.replace('&', "&&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_title_uses_active_agent_status() {
        assert_eq!(tray_title(&AgentMenuBarState::default()), None);
        assert_eq!(tray_title(&state(1, 0, None)), Some("Working...".into()));
        assert_eq!(
            tray_title(&state(3, 0, None)),
            Some("Working... (3)".into())
        );
        assert_eq!(
            tray_title(&state(1, 1, None)),
            Some("Needs Approval".into())
        );
        assert_eq!(
            tray_title(&state(4, 2, None)),
            Some("Needs Approval (2)".into())
        );
    }

    #[test]
    fn tray_title_uses_last_actionable_status() {
        assert_eq!(
            tray_title(&state(0, 0, Some("starting"))),
            Some("Starting...".into())
        );
        assert_eq!(
            tray_title(&state(0, 0, Some("running"))),
            Some("Working...".into())
        );
        assert_eq!(
            tray_title(&state(0, 0, Some("waitingForUser"))),
            Some("Needs Approval".into())
        );
        assert_eq!(
            tray_title(&state(0, 0, Some("failed"))),
            Some("Failed".into())
        );
        assert_eq!(
            tray_title(&state(0, 0, Some("cancelled"))),
            Some("Cancelled".into())
        );
    }

    #[test]
    fn tray_title_omits_passive_statuses() {
        assert_eq!(tray_title(&state(0, 0, Some("completed"))), None);
        assert_eq!(tray_title(&state(0, 0, Some("unknown"))), None);
    }

    fn state(
        active_count: usize,
        needs_user_count: usize,
        last_status: Option<&str>,
    ) -> AgentMenuBarState {
        AgentMenuBarState {
            active_count,
            needs_user_count,
            last_status: last_status.map(|status| AgentMenuBarLastStatus {
                title: None,
                status: status.to_string(),
                summary: None,
            }),
            ..AgentMenuBarState::default()
        }
    }
}
