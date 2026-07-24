use serde::Deserialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, AppHandle, Emitter, Listener, Manager, Runtime,
};

const TRAY_ID: &str = "agent-menu-bar";

/// Set by `set_dictation_active` (called from the dictation seam) and read when
/// rendering the tooltip. Independent of the agent-session state so a dictation
/// edge can never clobber it.
static DICTATION_ACTIVE: AtomicBool = AtomicBool::new(false);

/// The last agent-session state seen by the agent listener. The dictation
/// listener needs it to re-render the tooltip (which carries both the agent
/// status and the dictation indicator) without an agent payload of its own.
static LAST_AGENT_STATE: Mutex<Option<AgentMenuBarState>> = Mutex::new(None);

/// The June logo mark as a macOS template image (black glyph on transparent).
/// The menu bar must show the same mark as the app icon, but the app icon itself
/// can't be used
/// directly: template rendering keeps only the alpha channel, so the icon's
/// opaque squircle background becomes a solid blob instead of the glyph.
const TRAY_ICON_TEMPLATE_PNG: &[u8] = include_bytes!("../icons/tray-icon-template.png");
/// Shown while a dictation take runs: June's "≈" wave plus a red recording dot.
/// Unlike the logo these are full-colour (NON-template) images, because macOS
/// flattens a template image to monochrome and would drop the red. That is why
/// there are two — one per menu-bar appearance — selected by `menu_bar_is_dark`:
/// a white wave for a dark bar, a black wave for a light one.
const TRAY_ICON_DICTATING_DARK_PNG: &[u8] = include_bytes!("../icons/tray-icon-dictating-dark.png");
const TRAY_ICON_DICTATING_LIGHT_PNG: &[u8] =
    include_bytes!("../icons/tray-icon-dictating-light.png");
const AGENT_MENU_BAR_STATE_EVENT: &str = "june:menu-bar:agent-state";
/// Carries the native dictation indicator (a bare `true`/`false`) from the
/// dictation seam to the tray, so all tray mutation stays inside this module.
const DICTATION_MENU_BAR_STATE_EVENT: &str = "june:menu-bar:dictation-state";
const AGENT_MENU_BAR_NEW_SESSION_EVENT: &str = "june:menu-bar:new-agent-session";
const AGENT_MENU_BAR_OPEN_SESSION_EVENT: &str = "june:menu-bar:open-agent-session";
const AGENT_MENU_BAR_SET_AGENT_HUD_EVENT: &str = "june:menu-bar:set-agent-hud";
const AGENT_MENU_BAR_OPEN_SETTINGS_EVENT: &str = "june://open-settings";

const MENU_SHOW_ID: &str = "agent_menu_bar_show";
const MENU_SETTINGS_ID: &str = "agent_menu_bar_settings";
const MENU_NEW_SESSION_ID: &str = "agent_menu_bar_new_session";
const MENU_SHOW_AGENT_HUD_ID: &str = "agent_menu_bar_show_agent_hud";
const MENU_HIDE_AGENT_HUD_ID: &str = "agent_menu_bar_hide_agent_hud";
const MENU_QUIT_ID: &str = "agent_menu_bar_quit";
const MENU_STATUS_ID: &str = "agent_menu_bar_status";
const MENU_LAST_STATUS_ID: &str = "agent_menu_bar_last_status";
const MENU_SESSION_ID_PREFIX: &str = "agent_menu_bar_session:";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentMenuBarState {
    #[serde(default)]
    active_count: usize,
    #[serde(default)]
    needs_user_count: usize,
    #[serde(default)]
    sessions: Vec<AgentMenuBarSession>,
    #[serde(default = "default_agent_hud_enabled")]
    agent_hud_enabled: bool,
    #[serde(default)]
    last_status: Option<AgentMenuBarLastStatus>,
}

impl Default for AgentMenuBarState {
    fn default() -> Self {
        Self {
            active_count: 0,
            needs_user_count: 0,
            sessions: Vec::new(),
            agent_hud_enabled: default_agent_hud_enabled(),
            last_status: None,
        }
    }
}

fn default_agent_hud_enabled() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentMenuBarSession {
    id: String,
    title: String,
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
        .tooltip(tray_tooltip(&initial_state, false))
        .show_menu_on_left_click(true)
        .on_menu_event(handle_menu_event);

    match tauri::image::Image::from_bytes(TRAY_ICON_TEMPLATE_PNG) {
        Ok(icon) => {
            tray_builder = tray_builder.icon(icon).icon_as_template(true);
        }
        // The embedded asset can only fail to decode if it was corrupted at
        // build time; a wrong-looking menu bar item beats a missing one.
        Err(_) => {
            if let Some(icon) = app.handle().default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon).icon_as_template(true);
            }
        }
    }

    let tray = tray_builder.build(app)?;
    update_tray(
        app.handle(),
        &tray,
        &initial_state,
        DICTATION_ACTIVE.load(Ordering::SeqCst),
    );

    let handle = app.handle().clone();
    app.listen_any(AGENT_MENU_BAR_STATE_EVENT, move |event| {
        let Ok(state) = serde_json::from_str::<AgentMenuBarState>(event.payload()) else {
            return;
        };
        if let Ok(mut last) = LAST_AGENT_STATE.lock() {
            *last = Some(state.clone());
        }
        let Some(tray) = handle.tray_by_id(TRAY_ID) else {
            return;
        };
        if let Ok(menu) = build_menu(&handle, &state) {
            let _ = tray.set_menu(Some(menu));
        }
        update_tray(
            &handle,
            &tray,
            &state,
            DICTATION_ACTIVE.load(Ordering::SeqCst),
        );
    });

    // A second, independent listener: the dictation indicator must never
    // rebuild the menu or touch agent-session state. It only re-renders the
    // tooltip from the last-seen agent state plus the new dictation flag.
    let handle = app.handle().clone();
    app.listen_any(DICTATION_MENU_BAR_STATE_EVENT, move |event| {
        let active = event.payload() == "true";
        DICTATION_ACTIVE.store(active, Ordering::SeqCst);
        let Some(tray) = handle.tray_by_id(TRAY_ID) else {
            return;
        };
        let state = LAST_AGENT_STATE
            .lock()
            .ok()
            .and_then(|last| last.clone())
            .unwrap_or_default();
        update_tray(&handle, &tray, &state, active);
    });

    Ok(())
}

/// Emits the current dictation-take state toward the tray. Called from the
/// dictation seam (`dictation.rs`); routing through the event bus keeps every
/// tray mutation inside this module. Safe to call off the main thread.
pub fn set_dictation_active(app: &AppHandle, active: bool) {
    let _ = app.emit(DICTATION_MENU_BAR_STATE_EVENT, active);
}

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    if id == MENU_SHOW_ID {
        show_main_window(app);
        return;
    }
    if id == MENU_SETTINGS_ID {
        show_main_window(app);
        let _ = app.emit(AGENT_MENU_BAR_OPEN_SETTINGS_EVENT, ());
        return;
    }
    if id == MENU_NEW_SESSION_ID {
        show_main_window(app);
        let _ = app.emit(AGENT_MENU_BAR_NEW_SESSION_EVENT, ());
        return;
    }
    if id == MENU_SHOW_AGENT_HUD_ID {
        let _ = app.emit(AGENT_MENU_BAR_SET_AGENT_HUD_EVENT, true);
        return;
    }
    if id == MENU_HIDE_AGENT_HUD_ID {
        let _ = app.emit(AGENT_MENU_BAR_SET_AGENT_HUD_EVENT, false);
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
    let settings_item =
        MenuItem::with_id(manager, MENU_SETTINGS_ID, "Settings...", true, None::<&str>)?;
    let new_session_item = MenuItem::with_id(
        manager,
        MENU_NEW_SESSION_ID,
        "New session...",
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
    let agent_hud_item = MenuItem::with_id(
        manager,
        if state.agent_hud_enabled {
            MENU_HIDE_AGENT_HUD_ID
        } else {
            MENU_SHOW_AGENT_HUD_ID
        },
        if state.agent_hud_enabled {
            "Hide sessions HUD"
        } else {
            "Show sessions HUD"
        },
        true,
        None::<&str>,
    )?;
    menu.append(&agent_hud_item)?;
    menu.append(&PredefinedMenuItem::separator(manager)?)?;
    menu.append(&status_item)?;
    menu.append(&new_session_item)?;

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

    menu.append(&PredefinedMenuItem::separator(manager)?)?;
    menu.append(&settings_item)?;
    menu.append(&PredefinedMenuItem::separator(manager)?)?;

    let quit_item = MenuItem::with_id(manager, MENU_QUIT_ID, "Quit June", true, None::<&str>)?;
    menu.append(&quit_item)?;

    Ok(menu)
}

fn update_tray<R: Runtime>(
    app: &AppHandle<R>,
    tray: &tauri::tray::TrayIcon<R>,
    state: &AgentMenuBarState,
    dictation_active: bool,
) {
    // Keep the macOS menu extra compact and logo-only. Status details live in
    // the tooltip and dropdown menu; setting a title renders a wide text item
    // beside the icon in the menu bar.
    let _ = tray.set_title::<&str>(None);
    let _ = tray.set_tooltip(Some(tray_tooltip(state, dictation_active)));
    apply_tray_icon(app, tray, dictation_active);
}

/// While dictating, show the full-colour "≈ + red dot" mark (so the dot stays
/// red) matched to the menu-bar appearance; otherwise the adaptive monochrome
/// logo template. On a decode failure the current icon is left in place — a
/// stale-but-present icon beats a missing one.
fn apply_tray_icon<R: Runtime>(
    app: &AppHandle<R>,
    tray: &tauri::tray::TrayIcon<R>,
    dictation_active: bool,
) {
    let (bytes, is_template) = if dictation_active {
        let bytes = if menu_bar_is_dark(app) {
            TRAY_ICON_DICTATING_DARK_PNG
        } else {
            TRAY_ICON_DICTATING_LIGHT_PNG
        };
        (bytes, false)
    } else {
        (TRAY_ICON_TEMPLATE_PNG, true)
    };
    if let Ok(icon) = tauri::image::Image::from_bytes(bytes) {
        // Atomic on macOS (no icon+template flicker); falls back to set_icon
        // on other platforms.
        let _ = tray.set_icon_with_as_template(Some(icon), is_template);
    }
}

/// Whether the menu bar renders dark, so the dictating icon can pick the
/// matching full-colour variant. Follows the main window's effective appearance
/// (which tracks the system Light/Dark setting); defaults to dark if unknown.
fn menu_bar_is_dark<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window("main")
        .and_then(|window| window.theme().ok())
        .map(|theme| theme == tauri::Theme::Dark)
        .unwrap_or(true)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn tray_tooltip(state: &AgentMenuBarState, dictation_active: bool) -> String {
    let status = status_label(state);
    if dictation_active {
        // Sentence case, plain hyphen — matches the existing tooltip and the
        // repo copy specs.
        return format!("June - Dictating - {status}");
    }
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
    "No active sessions".to_string()
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
    format!("{prefix}{title}")
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
    fn tooltip_shows_dictating_only_when_active() {
        let state = AgentMenuBarState::default();
        assert_eq!(tray_tooltip(&state, false), "June - No active sessions");
        assert_eq!(
            tray_tooltip(&state, true),
            "June - Dictating - No active sessions"
        );
    }

    #[test]
    fn logo_tray_icon_is_a_real_template_image() {
        let icon = tauri::image::Image::from_bytes(TRAY_ICON_TEMPLATE_PNG)
            .expect("embedded logo tray template PNG must decode");
        assert_eq!(icon.width(), icon.height(), "menu bar icon must be square");
        // macOS template rendering uses only the alpha channel: the mark must be
        // opaque and the background transparent, or the menu bar shows a solid
        // blob (the bug this asset exists to fix). Both must be present.
        let alphas: Vec<u8> = icon.rgba().chunks(4).map(|px| px[3]).collect();
        assert!(
            alphas.contains(&0),
            "template needs a transparent background"
        );
        assert!(alphas.contains(&255), "template needs an opaque mark");
        // Corners stay transparent — an opaque squircle background (the app
        // icon's shape) would fail here.
        let side = icon.width() as usize;
        for corner in [0, side - 1, side * (side - 1), side * side - 1] {
            assert_eq!(alphas[corner], 0, "corner pixels must be transparent");
        }
    }

    #[test]
    fn dictating_tray_icons_carry_a_red_recording_dot() {
        // These are deliberately full-colour (NON-template) so the dot renders
        // red; a template would flatten it to monochrome. One variant per
        // menu-bar appearance.
        for (name, bytes) in [
            ("dark", TRAY_ICON_DICTATING_DARK_PNG),
            ("light", TRAY_ICON_DICTATING_LIGHT_PNG),
        ] {
            let icon = tauri::image::Image::from_bytes(bytes)
                .unwrap_or_else(|_| panic!("embedded {name} dictating PNG must decode"));
            assert_eq!(icon.width(), icon.height(), "{name} icon must be square");
            let rgba = icon.rgba();
            let side = icon.width() as usize;
            // Corners transparent — the wave and dot sit inside the canvas.
            for corner in [0, side - 1, side * (side - 1), side * side - 1] {
                assert_eq!(rgba[corner * 4 + 3], 0, "{name} corner must be transparent");
            }
            // A clearly red, opaque pixel exists: the recording dot.
            let has_red = rgba
                .chunks(4)
                .any(|px| px[3] > 200 && px[0] > 200 && px[1] < 100 && px[2] < 100);
            assert!(has_red, "{name} icon must contain a red recording dot");
        }
    }
}
