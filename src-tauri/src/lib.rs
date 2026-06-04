pub mod app_paths;
pub mod audio;
pub mod commands;
pub mod db;
pub mod dictation;
pub mod domain;
pub mod hermes_bridge;
pub mod os_accounts;
pub mod providers;
pub mod scribe_api;

#[cfg(target_os = "macos")]
use tauri::Manager;

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
        .plugin(tauri_plugin_deep_link::init())
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
            commands::cancel_agent_task,
            commands::retry_agent_task,
            commands::list_agent_tool_events,
            hermes_bridge::hermes_bridge_status,
            hermes_bridge::hermes_bridge_skills,
            hermes_bridge::hermes_bridge_toolsets,
            hermes_bridge::hermes_bridge_messaging_platforms,
            hermes_bridge::hermes_bridge_sessions,
            hermes_bridge::hermes_bridge_session_messages,
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
            dictation::dictation_helper_command,
            dictation::dictation_hud_set_stop_bounds,
            dictation::dictation_hud_set_pill_bounds,
            dictation::dictation_hotkey_status,
            dictation::latest_dictation_event,
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
            providers::setup(app);
            dictation::setup(app);
            repair_agent_task_statuses_on_app_start(app);
            hermes_bridge::start_on_app_start(app);
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
