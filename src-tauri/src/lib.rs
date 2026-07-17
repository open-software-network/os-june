pub mod agent_hud;
pub mod app_paths;
pub mod audio;
pub mod commands;
pub mod computer_use;
mod computer_use_permission_drag;
pub mod connectors;
pub mod db;
pub mod dictation;
pub mod domain;
pub mod feature_flags;
pub mod hermes_bridge;
pub mod image_safety;
pub mod june_api;
pub mod macos_menu_icons;
pub mod meeting_detection;
pub mod meeting_hud;
pub mod menu_bar;
mod note_audio_export;
pub mod notifications;
pub mod os_accounts;
pub mod p3a;
pub mod providers;
pub mod theme_icon;
pub mod updates;
pub mod video_download_url;

use serde::Deserialize;
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::sync::OnceLock;
use tauri::{Emitter, Manager};

const CHECK_FOR_UPDATES_MENU_ID: &str = "check_for_updates";
const CHECK_FOR_UPDATES_EVENT: &str = "june://check-for-updates";
const CLOSE_TAB_MENU_ID: &str = "close_tab";
const CLOSE_TAB_EVENT: &str = "june://close-tab";
const CLOSE_WINDOW_MENU_ID: &str = "close_window_main";
const OPEN_SETTINGS_MENU_ID: &str = "open_settings";
const OPEN_SETTINGS_EVENT: &str = "june://open-settings";

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingPresenceBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl RecordingPresenceBounds {
    fn contains(self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.width && y >= self.y && y <= self.y + self.height
    }

    fn is_valid(self) -> bool {
        self.width > 0.0 && self.height > 0.0
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetRecordingPresenceBoundsRequest {
    owner_id: String,
    bounds: Option<RecordingPresenceBounds>,
}

#[derive(Debug, Clone)]
struct RegisteredRecordingPresenceBounds {
    owner_id: String,
    bounds: RecordingPresenceBounds,
}

#[derive(Default)]
struct RecordingPresenceBoundsState(Mutex<Option<RegisteredRecordingPresenceBounds>>);

#[cfg(target_os = "macos")]
static MAIN_WINDOW_APP: OnceLock<tauri::AppHandle> = OnceLock::new();
#[cfg(target_os = "macos")]
static MAIN_WINDOW_NS_WINDOW: Mutex<Option<usize>> = Mutex::new(None);
#[cfg(target_os = "macos")]
static MAIN_WINDOW_SEND_EVENT_ORIGINAL: OnceLock<MainWindowSendEventImp> = OnceLock::new();
#[cfg(target_os = "macos")]
type MainWindowSendEventImp = unsafe extern "C-unwind" fn(
    &objc2::runtime::AnyObject,
    objc2::runtime::Sel,
    *mut objc2::runtime::AnyObject,
);

pub fn run() {
    providers::load_local_env();
    let context = tauri::generate_context!();
    let mut builder = tauri::Builder::default();

    // Single-instance MUST register before the deep-link plugin so it owns
    // the second-launch handoff: when a deep link fires while the app is
    // already running, the OS launches a new instance, single-instance
    // forwards argv (which includes the URL on macOS) to the live instance,
    // and tauri-plugin-single-instance's `deep-link` feature wires that into
    // the deep-link plugin's `on_open_url` event so we hear one signal in
    // both cold-launch and warm-launch cases.
    #[cfg(desktop)]
    {
        if should_register_single_instance_plugin() {
            builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }));
        }
    }

    builder
        // deep-link registers immediately after single-instance to keep the
        // single-instance -> deep-link handoff (documented above) adjacent and
        // obvious; process/updater are order-independent so they follow.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_menu_event(|app, event| {
            if event.id().as_ref() == CHECK_FOR_UPDATES_MENU_ID {
                let _ = app.emit(CHECK_FOR_UPDATES_EVENT, ());
                return;
            }
            if event.id().as_ref() == CLOSE_TAB_MENU_ID {
                emit_close_tab_if_main_window_focused(app);
                return;
            }
            if event.id().as_ref() == CLOSE_WINDOW_MENU_ID {
                close_main_window(app);
                return;
            }
            if event.id().as_ref() == OPEN_SETTINGS_MENU_ID {
                #[cfg(target_os = "macos")]
                show_main_window(app);
                let _ = app.emit(OPEN_SETTINGS_EVENT, ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            theme_icon::set_dock_icon,
            print_current_webview,
            commands::bootstrap_app,
            commands::create_note,
            commands::list_notes,
            commands::get_note,
            commands::download_note_audio,
            commands::update_note,
            commands::delete_note,
            commands::delete_notes,
            commands::create_folder,
            commands::list_folders,
            commands::delete_folder,
            commands::rename_folder,
            commands::assign_note_to_folder,
            commands::remove_note_from_folder,
            commands::list_session_folders,
            commands::assign_session_to_folder,
            commands::remove_session_from_folder,
            commands::list_dictionary_entries,
            commands::create_dictionary_entry,
            commands::update_dictionary_entry,
            commands::delete_dictionary_entry,
            commands::list_memories,
            commands::create_memory,
            commands::update_memory,
            commands::delete_memory,
            commands::set_folder_instructions,
            commands::set_folder_memory_disabled,
            commands::memory_settings,
            commands::set_memory_enabled,
            commands::list_agent_tasks,
            commands::create_agent_task,
            commands::get_agent_task,
            commands::send_agent_message,
            commands::save_agent_assistant_message,
            commands::save_agent_hermes_session,
            commands::suggest_agent_session_title,
            commands::submit_issue_report,
            commands::finalize_hermes_bridge_branch,
            commands::explain_agent_approval,
            commands::cancel_agent_task,
            commands::retry_agent_task,
            commands::list_agent_tool_events,
            commands::share_create,
            commands::share_list,
            commands::share_get,
            commands::share_add_invites,
            commands::share_revoke_invite,
            commands::share_delete,
            commands::share_key_save,
            commands::share_key_get,
            commands::share_invite_key_save,
            commands::share_invite_keys_get,
            commands::get_share_base_url,
            hermes_bridge::hermes_bridge_status,
            hermes_bridge::ensure_hermes_bridge_gateway,
            hermes_bridge::resolve_agent_recorder_request,
            hermes_bridge::hermes_admin_request,
            hermes_bridge::hermes_mcp_oauth_login,
            hermes_bridge::hermes_reset_bundled_skill,
            hermes_bridge::hermes_skill_tap_list,
            hermes_bridge::hermes_skill_tap_add,
            hermes_bridge::hermes_skill_tap_remove,
            hermes_bridge::hermes_inspect_external_dirs,
            hermes_bridge::hermes_list_skill_bundles,
            hermes_bridge::hermes_save_skill_bundle,
            hermes_bridge::hermes_delete_skill_bundle,
            hermes_bridge::hermes_bridge_skills,
            hermes_bridge::hermes_pending_skill_writes,
            hermes_bridge::hermes_resolve_pending_skill_write,
            hermes_bridge::hermes_bridge_toolsets,
            hermes_bridge::hermes_bridge_messaging_platforms,
            hermes_bridge::hermes_bridge_filesystem_snapshot,
            hermes_bridge::download_hermes_bridge_file,
            hermes_bridge::hermes_bridge_file_preview,
            hermes_bridge::hermes_bridge_image_data_url,
            hermes_bridge::hermes_bridge_file_text,
            hermes_bridge::import_hermes_bridge_file,
            hermes_bridge::import_hermes_bridge_file_bytes,
            hermes_bridge::hermes_bridge_sessions,
            hermes_bridge::ensure_hermes_bridge_session,
            hermes_bridge::hermes_bridge_session_messages,
            hermes_bridge::delete_hermes_bridge_session,
            hermes_bridge::hermes_bridge_cron_jobs,
            hermes_bridge::create_hermes_bridge_cron_job,
            hermes_bridge::update_hermes_bridge_cron_job,
            hermes_bridge::hermes_bridge_cron_job_action,
            hermes_bridge::delete_hermes_bridge_cron_job,
            hermes_bridge::start_hermes_bridge,
            hermes_bridge::stop_hermes_bridge,
            hermes_bridge::toggle_hermes_bridge_skill,
            hermes_bridge::get_hermes_bridge_skill,
            hermes_bridge::update_hermes_bridge_skill,
            hermes_bridge::toggle_hermes_bridge_toolset,
            hermes_bridge::update_hermes_bridge_messaging_platform,
            hermes_bridge::hermes_agent_cli_access,
            hermes_bridge::set_hermes_agent_cli_access,
            hermes_bridge::june_character,
            hermes_bridge::set_june_character,
            hermes_bridge::open_hermes_tui_debug,
            commands::get_microphone_permission_state,
            commands::check_recording_source_readiness,
            commands::open_privacy_settings,
            commands::reveal_path,
            commands::june_open_verify_page,
            commands::june_open_community_page,
            commands::june_open_external_url,
            commands::start_recording,
            commands::pause_recording,
            commands::resume_recording,
            commands::get_recording_status,
            set_recording_presence_bounds,
            commands::finish_recording,
            commands::retry_processing,
            commands::recover_recording,
            dictation::dictation_capabilities,
            dictation::dictation_settings,
            dictation::list_dictation_history,
            dictation::delete_dictation_history_item,
            dictation::set_dictation_shortcut,
            dictation::set_dictation_microphone,
            dictation::set_dictation_style,
            dictation::set_dictation_language,
            dictation::dictation_helper_command,
            dictation::dictation_hud_set_stop_bounds,
            dictation::dictation_hud_set_dismiss_bounds,
            dictation::dictation_hud_set_record_bounds,
            dictation::dictation_hud_preferred_error_placement,
            dictation::dictation_hud_set_size,
            dictation::dictation_hud_set_alpha,
            dictation::dictation_hud_show,
            dictation::dictation_hud_exit,
            dictation::dictation_hud_set_chrome,
            dictation::dictation_hud_shake,
            dictation::dictation_hotkey_status,
            dictation::latest_dictation_event,
            agent_hud::agent_hud_show,
            agent_hud::agent_hud_hide,
            agent_hud::agent_hud_set_layout,
            agent_hud::agent_hud_open_agent,
            notifications::send_app_notification,
            notifications::agent_open_ready,
            meeting_hud::meeting_hud_latest_status,
            meeting_hud::meeting_hud_reopen,
            providers::provider_model_settings,
            providers::list_venice_models,
            providers::set_venice_model,
            providers::set_cost_quality,
            providers::set_venice_api_key,
            providers::clear_venice_api_key,
            providers::set_image_safe_mode,
            providers::set_image_safe_mode_prompt_dismissed,
            image_safety::image_prompt_may_be_explicit,
            providers::generate_image,
            providers::edit_image,
            providers::video_generate,
            providers::video_status,
            providers::generated_video_dir,
            providers::save_local_generation_settings,
            providers::set_local_generation_enabled,
            providers::probe_local_generation_endpoint,
            p3a::p3a_settings,
            p3a::p3a_question_catalog,
            p3a::set_p3a_enabled,
            p3a::p3a_record,
            os_accounts::os_accounts_status,
            os_accounts::os_accounts_status_local,
            os_accounts::os_accounts_login,
            os_accounts::os_accounts_cancel_login,
            os_accounts::os_accounts_logout,
            os_accounts::os_accounts_set_avatar_seed,
            os_accounts::os_accounts_upgrade,
            os_accounts::os_accounts_upgrade_session,
            os_accounts::os_accounts_change_plan,
            os_accounts::os_accounts_open_portal,
            os_accounts::os_accounts_referral_summary,
            connectors::commands::connectors_list,
            connectors::commands::connectors_connect,
            connectors::commands::connectors_cancel_connect,
            connectors::commands::connectors_disconnect,
            connectors::commands::connectors_linear_teams,
            connectors::commands::connectors_selected_teams_set,
            connectors::commands::routine_trust_get,
            connectors::commands::routine_trust_set,
            connectors::commands::routine_trust_record_run,
            connectors::commands::connector_triggers_list,
            connectors::commands::connector_trigger_set,
            connectors::commands::connector_trigger_delete,
            connectors::approvals::connector_approvals_pending,
            connectors::approvals::connector_approval_respond,
            connectors::approvals::connector_approvals_respond_all,
            hermes_bridge::connectors_apply_runtime,
            computer_use::computer_use_status,
            computer_use::set_computer_use_grant,
            computer_use::computer_use_request_permissions,
            computer_use_permission_drag::set_computer_use_permission_drag_bounds,
            computer_use::computer_use_stop,
            computer_use::computer_use_begin_run,
            computer_use::computer_use_end_run,
            computer_use::computer_use_approvals_pending,
            computer_use::computer_use_approval_respond,
            updates::get_release_channel,
            updates::set_release_channel,
            updates::fetch_update,
            updates::install_update,
            updates::relaunch_for_update,
        ])
        .manage(RecordingPresenceBoundsState::default())
        .manage(hermes_bridge::HermesBridge::default())
        .manage(computer_use::ComputerUseState::default())
        .manage(os_accounts::LoginFlow::default())
        .manage(connectors::ConnectFlow::default())
        .setup(|app| {
            setup_app_menu(app)?;
            menu_bar::setup(app)?;
            providers::setup(app);
            setup_video_asset_scope(app);
            setup_computer_use_asset_scope(app);
            p3a::setup(app);
            updates::setup(app);
            dictation::setup(app);
            agent_hud::setup(app);
            notifications::setup(app);
            meeting_detection::setup(app);
            repair_agent_task_statuses_on_app_start(app);
            hermes_bridge::start_on_app_start(app);
            // Poll Google for the events routines subscribe to (email arrivals,
            // upcoming meetings) and wake the matching routine. Runs after the
            // bridge init so cron triggers have a runtime to fire into.
            connectors::triggers::start(app.handle());
            meeting_hud::setup(app);
            os_accounts::setup_deep_link(app);
            #[cfg(target_os = "macos")]
            setup_main_window_lifecycle(app);
            Ok(())
        })
        .build(context)
        .expect("failed to build June")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => {
                dictation::stop_helper(app);
                tauri::async_runtime::block_on(computer_use::shutdown(app));
                hermes_bridge::shutdown(app);
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main_window(app),
            _ => {}
        });
}

/// Registers the generated-video directory in the asset-protocol scope so the
/// inline `<video>` player can load it. `app_data_dir` appends a `-dev` suffix
/// in debug builds (dev/prod data isolation), but the static assetProtocol
/// scope (`$APPDATA/hermes/videos`) resolves the config identifier *without*
/// that suffix, so inline playback of a generated file is denied in dev even
/// though download (an fs read, unscoped) works. Registering the resolved
/// directory here matches the real write path in both dev and prod.
fn setup_video_asset_scope(app: &mut tauri::App) {
    let videos_dir = match crate::app_paths::app_data_dir(app.handle()) {
        Ok(data_dir) => data_dir.join("hermes").join("videos"),
        Err(error) => {
            tracing::warn!(%error, "video asset scope: could not resolve app data dir");
            return;
        }
    };
    if let Err(error) = app
        .asset_protocol_scope()
        .allow_directory(&videos_dir, false)
    {
        tracing::warn!(%error, path = %videos_dir.display(), "video asset scope: allow_directory failed");
    }
}

fn setup_computer_use_asset_scope(app: &mut tauri::App) {
    let captures_dir = match crate::app_paths::app_data_dir(app.handle()) {
        Ok(data_dir) => data_dir
            .join("hermes")
            .join("computer-use")
            .join("captures"),
        Err(error) => {
            tracing::warn!(%error, "computer use asset scope: could not resolve app data dir");
            return;
        }
    };
    if let Err(error) = app
        .asset_protocol_scope()
        .allow_directory(&captures_dir, false)
    {
        tracing::warn!(%error, path = %captures_dir.display(), "computer use asset scope: allow_directory failed");
    }
}

#[cfg(desktop)]
fn should_register_single_instance_plugin() -> bool {
    single_instance_enabled_for_build(
        cfg!(debug_assertions),
        std::env::var_os("OS_JUNE_ENABLE_DEV_SINGLE_INSTANCE").is_some(),
    )
}

#[cfg(desktop)]
fn single_instance_enabled_for_build(debug_assertions: bool, force_dev: bool) -> bool {
    !debug_assertions || force_dev
}

#[cfg(all(test, desktop))]
mod tests {
    use super::{should_emit_close_tab_event, single_instance_enabled_for_build};

    #[test]
    fn single_instance_is_disabled_for_dev_builds_by_default() {
        assert!(!single_instance_enabled_for_build(true, false));
    }

    #[test]
    fn single_instance_can_be_forced_on_for_dev_builds() {
        assert!(single_instance_enabled_for_build(true, true));
    }

    #[test]
    fn single_instance_remains_enabled_for_release_builds() {
        assert!(single_instance_enabled_for_build(false, false));
    }

    #[test]
    fn close_tab_menu_emits_only_when_main_window_focus_is_known_true() {
        assert!(should_emit_close_tab_event(Some(true)));
        assert!(!should_emit_close_tab_event(Some(false)));
        assert!(!should_emit_close_tab_event(None));
    }
}

fn setup_app_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{
        AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    };

    let handle = app.handle();
    let pkg_info = handle.package_info();
    let config = handle.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        handle,
        pkg_info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(handle, None, Some(about_metadata))?,
            &MenuItem::with_id(
                handle,
                CHECK_FOR_UPDATES_MENU_ID,
                "Check for Updates",
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(
                handle,
                OPEN_SETTINGS_MENU_ID,
                "Settings...",
                true,
                Some("CmdOrCtrl+,"),
            )?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::show_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &MenuItem::with_id(
                handle,
                CLOSE_TAB_MENU_ID,
                "Close tab",
                true,
                Some("CmdOrCtrl+W"),
            )?,
            &MenuItem::with_id(
                handle,
                CLOSE_WINDOW_MENU_ID,
                "Close window",
                true,
                Some("CmdOrCtrl+Shift+W"),
            )?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        handle,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(handle, None)?],
    )?;
    let window_menu = Submenu::with_id_and_items(
        handle,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
        ],
    )?;
    let help_menu = Submenu::with_id_and_items(handle, HELP_SUBMENU_ID, "Help", true, &[])?;

    let menu = Menu::with_items(
        handle,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )?;
    app.set_menu(menu)?;
    macos_menu_icons::install_settings_symbol_on_app_menu();
    Ok(())
}

fn repair_agent_task_statuses_on_app_start(app: &tauri::App) {
    let app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        match commands::repositories(&app).await {
            Ok(repos) => {
                if let Err(error) = repos.complete_agent_tasks_with_assistant_messages().await {
                    eprintln!("failed to repair agent task statuses on app startup: {error}");
                }
            }
            Err(error) => eprintln!(
                "failed to open repositories for agent task status repair: {}",
                error.message
            ),
        }
    });
}

fn close_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "macos")]
        let _ = window.hide();
        #[cfg(not(target_os = "macos"))]
        let _ = window.close();
    }
}

fn emit_close_tab_if_main_window_focused(app: &tauri::AppHandle) {
    if should_emit_close_tab_event(main_window_focus_state(app)) {
        let _ = app.emit_to("main", CLOSE_TAB_EVENT, ());
    }
}

fn main_window_focus_state(app: &tauri::AppHandle) -> Option<bool> {
    app.get_webview_window("main")
        .and_then(|window| window.is_focused().ok())
}

fn should_emit_close_tab_event(main_window_focused: Option<bool>) -> bool {
    main_window_focused == Some(true)
}

#[tauri::command]
fn print_current_webview(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|error| error.to_string())
}

#[tauri::command]
fn set_recording_presence_bounds(
    state: tauri::State<'_, RecordingPresenceBoundsState>,
    request: SetRecordingPresenceBoundsRequest,
) {
    if let Ok(mut current) = state.0.lock() {
        if let Some(bounds) = request.bounds.filter(|bounds| bounds.is_valid()) {
            *current = Some(RegisteredRecordingPresenceBounds {
                owner_id: request.owner_id,
                bounds,
            });
        } else if current
            .as_ref()
            .is_some_and(|registered| registered.owner_id == request.owner_id)
        {
            *current = None;
        }
    }
}

#[cfg(target_os = "macos")]
fn setup_main_window_lifecycle(app: &mut tauri::App) {
    if let Some(main_window) = app.get_webview_window("main") {
        register_main_window_lifecycle(app.handle(), &main_window);
    }
}

#[cfg(target_os = "macos")]
fn register_main_window_lifecycle(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    install_main_window_first_mouse_bridge(app, window);
    let close_window = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = close_window.hide();
        }
    });
}

#[cfg(target_os = "macos")]
fn install_main_window_first_mouse_bridge(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    use objc2::runtime::AnyObject;
    use objc2::sel;

    let _ = MAIN_WINDOW_APP.get_or_init(|| app.clone());
    let Ok(handle) = window.ns_window() else {
        return;
    };
    if handle.is_null() {
        return;
    }
    unsafe {
        let window = handle as *mut AnyObject;
        if let Ok(mut current_window) = MAIN_WINDOW_NS_WINDOW.lock() {
            *current_window = Some(window as usize);
        }

        if MAIN_WINDOW_SEND_EVENT_ORIGINAL.get().is_some() {
            return;
        }

        let class = objc2::ffi::object_getClass(window);
        if class.is_null() {
            return;
        }
        let class = &*class;
        let Some(method) = class.instance_method(sel!(sendEvent:)) else {
            return;
        };
        let replacement: objc2::runtime::Imp =
            std::mem::transmute(main_window_send_event as MainWindowSendEventImp);
        let original = method.set_implementation(replacement);
        let original: MainWindowSendEventImp = std::mem::transmute(original);
        let _ = MAIN_WINDOW_SEND_EVENT_ORIGINAL.set(original);
    }
}

#[cfg(target_os = "macos")]
extern "C-unwind" fn main_window_send_event(
    this: &objc2::runtime::AnyObject,
    _sel: objc2::runtime::Sel,
    event: *mut objc2::runtime::AnyObject,
) {
    use objc2::msg_send;

    const NS_EVENT_TYPE_LEFT_MOUSE_DOWN: i64 = 1;
    const NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED: i64 = 6;

    unsafe {
        let is_registered_main_window = MAIN_WINDOW_NS_WINDOW
            .lock()
            .ok()
            .and_then(|window| *window)
            .is_some_and(|window| {
                std::ptr::addr_eq(this, window as *const objc2::runtime::AnyObject)
            });
        if is_registered_main_window && !event.is_null() {
            let event_type: i64 = msg_send![event, type];
            if event_type == NS_EVENT_TYPE_LEFT_MOUSE_DOWN
                && main_app_inactive()
                && main_first_mouse_hits_recording_presence(this, event)
            {
                emit_recording_presence_reopen();
            }
            if event_type == NS_EVENT_TYPE_LEFT_MOUSE_DRAGGED
                && MAIN_WINDOW_APP
                    .get()
                    .is_some_and(|app| computer_use::begin_permission_drag(app, this, event))
            {
                return;
            }
        }

        if let Some(original) = MAIN_WINDOW_SEND_EVENT_ORIGINAL.get().copied() {
            original(this, _sel, event);
        }
    }
}

#[cfg(target_os = "macos")]
fn main_app_inactive() -> bool {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    let Some(app_class) = AnyClass::get(c"NSApplication") else {
        return false;
    };
    unsafe {
        let app: *mut AnyObject = msg_send![app_class, sharedApplication];
        if app.is_null() {
            return false;
        }
        let active: bool = msg_send![app, isActive];
        !active
    }
}

#[cfg(target_os = "macos")]
unsafe fn main_first_mouse_hits_recording_presence(
    window: &objc2::runtime::AnyObject,
    event: *mut objc2::runtime::AnyObject,
) -> bool {
    use objc2::msg_send;
    use objc2_foundation::{NSPoint, NSRect};

    let Some(app) = MAIN_WINDOW_APP.get() else {
        return false;
    };
    let Some(registered) = app
        .try_state::<RecordingPresenceBoundsState>()
        .and_then(|state| state.0.lock().ok().and_then(|bounds| bounds.clone()))
    else {
        return false;
    };

    let content: *mut objc2::runtime::AnyObject = msg_send![window, contentView];
    if content.is_null() {
        return false;
    }
    let frame: NSRect = msg_send![content, frame];
    let point: NSPoint = msg_send![event, locationInWindow];
    let x = point.x;
    let y = frame.size.height - point.y;
    registered.bounds.contains(x, y)
}

#[cfg(target_os = "macos")]
fn emit_recording_presence_reopen() {
    let Some(app) = MAIN_WINDOW_APP.get() else {
        return;
    };
    let note_id = audio::capture::current_status().and_then(|status| status.note_id);
    let _ = app.emit_to(
        "main",
        "meeting-hud-action",
        serde_json::json!({ "action": "reopen", "noteId": note_id }),
    );
}

#[cfg(target_os = "macos")]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }

    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
    else {
        return;
    };

    if let Ok(window) =
        tauri::WebviewWindowBuilder::from_config(app, config).and_then(|builder| builder.build())
    {
        register_main_window_lifecycle(app, &window);
        let _ = window.show();
        let _ = window.set_focus();
    }
}
