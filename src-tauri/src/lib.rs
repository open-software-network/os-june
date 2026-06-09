pub mod app_paths;
pub mod audio;
pub mod commands;
pub mod db;
pub mod dictation;
pub mod domain;
pub mod hermes_bridge;
pub mod mascot;
pub mod meeting_detection;
pub mod meeting_hud;
pub mod menu_bar;
pub mod os_accounts;
pub mod providers;
pub mod scribe_api;

use tauri::Emitter;
#[cfg(target_os = "macos")]
use tauri::Manager;

const CHECK_FOR_UPDATES_MENU_ID: &str = "check_for_updates";
const CHECK_FOR_UPDATES_EVENT: &str = "scribe://check-for-updates";

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
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        // deep-link registers immediately after single-instance to keep the
        // single-instance -> deep-link handoff (documented above) adjacent and
        // obvious; process/updater are order-independent so they follow.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_menu_event(|app, event| {
            if event.id().as_ref() == CHECK_FOR_UPDATES_MENU_ID {
                let _ = app.emit(CHECK_FOR_UPDATES_EVENT, ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap_app,
            commands::create_note,
            commands::list_notes,
            commands::get_note,
            commands::update_note,
            commands::delete_note,
            commands::create_folder,
            commands::list_folders,
            commands::delete_folder,
            commands::rename_folder,
            commands::assign_note_to_folder,
            commands::remove_note_from_folder,
            commands::list_dictionary_entries,
            commands::create_dictionary_entry,
            commands::update_dictionary_entry,
            commands::delete_dictionary_entry,
            commands::list_agent_tasks,
            commands::create_agent_task,
            commands::get_agent_task,
            commands::send_agent_message,
            commands::save_agent_assistant_message,
            commands::save_agent_hermes_session,
            commands::suggest_agent_session_title,
            commands::cancel_agent_task,
            commands::retry_agent_task,
            commands::list_agent_tool_events,
            hermes_bridge::hermes_bridge_status,
            hermes_bridge::hermes_bridge_skills,
            hermes_bridge::hermes_bridge_toolsets,
            hermes_bridge::hermes_bridge_messaging_platforms,
            hermes_bridge::hermes_bridge_filesystem_snapshot,
            hermes_bridge::download_hermes_bridge_file,
            hermes_bridge::hermes_bridge_file_preview,
            hermes_bridge::import_hermes_bridge_file,
            hermes_bridge::hermes_bridge_sessions,
            hermes_bridge::ensure_hermes_bridge_session,
            hermes_bridge::hermes_bridge_session_messages,
            hermes_bridge::delete_hermes_bridge_session,
            hermes_bridge::start_hermes_bridge,
            hermes_bridge::stop_hermes_bridge,
            hermes_bridge::toggle_hermes_bridge_skill,
            hermes_bridge::toggle_hermes_bridge_toolset,
            hermes_bridge::update_hermes_bridge_messaging_platform,
            commands::get_microphone_permission_state,
            commands::check_recording_source_readiness,
            commands::open_privacy_settings,
            commands::start_recording,
            commands::pause_recording,
            commands::resume_recording,
            commands::get_recording_status,
            commands::finish_recording,
            commands::retry_processing,
            commands::recover_recording,
            dictation::dictation_settings,
            dictation::list_dictation_history,
            dictation::delete_dictation_history_item,
            dictation::set_dictation_shortcut,
            dictation::set_dictation_microphone,
            dictation::set_dictation_style,
            dictation::set_dictation_language,
            dictation::dictation_helper_command,
            dictation::dictation_hud_set_stop_bounds,
            dictation::dictation_hud_set_size,
            dictation::dictation_hud_set_alpha,
            dictation::dictation_hud_shake,
            dictation::dictation_hotkey_status,
            dictation::latest_dictation_event,
            mascot::mascot_show,
            mascot::mascot_hide,
            mascot::mascot_set_layout,
            mascot::mascot_open_agent,
            meeting_hud::meeting_hud_latest_status,
            meeting_hud::meeting_hud_reopen,
            providers::provider_model_settings,
            providers::list_venice_models,
            providers::set_venice_model,
            os_accounts::os_accounts_status,
            os_accounts::os_accounts_login,
            os_accounts::os_accounts_cancel_login,
            os_accounts::os_accounts_logout,
            os_accounts::os_accounts_top_up
        ])
        .manage(hermes_bridge::HermesBridge::default())
        .manage(os_accounts::LoginFlow::default())
        .setup(|app| {
            setup_app_menu(app)?;
            menu_bar::setup(app)?;
            providers::setup(app);
            dictation::setup(app);
            mascot::setup(app);
            meeting_detection::setup(app);
            repair_agent_task_statuses_on_app_start(app);
            hermes_bridge::start_on_app_start(app);
            meeting_hud::setup(app);
            os_accounts::setup_deep_link(app);
            #[cfg(target_os = "macos")]
            setup_main_window_lifecycle(app);
            Ok(())
        })
        .build(context)
        .expect("failed to build OS Scribe")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => {
                dictation::stop_helper(app);
                hermes_bridge::shutdown(app);
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main_window(app),
            _ => {}
        });
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
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(
                handle,
                CHECK_FOR_UPDATES_MENU_ID,
                "Check for updates…",
                true,
                Some("CmdOrCtrl+Shift+U"),
            )?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[&PredefinedMenuItem::close_window(handle, None)?],
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
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
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

#[cfg(target_os = "macos")]
fn setup_main_window_lifecycle(app: &mut tauri::App) {
    if let Some(main_window) = app.get_webview_window("main") {
        register_main_window_lifecycle(&main_window);
    }
}

#[cfg(target_os = "macos")]
fn register_main_window_lifecycle(window: &tauri::WebviewWindow) {
    let close_window = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = close_window.hide();
        }
    });
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
        register_main_window_lifecycle(&window);
        let _ = window.show();
        let _ = window.set_focus();
    }
}
