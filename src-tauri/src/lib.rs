pub mod app_paths;
pub mod audio;
pub mod commands;
pub mod db;
pub mod dictation;
pub mod domain;
pub mod providers;

#[cfg(target_os = "macos")]
use tauri::Manager;

pub fn run() {
    providers::load_local_env();
    let context = tauri::generate_context!();
    tauri::Builder::default()
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
            providers::set_venice_model
        ])
        .setup(|app| {
            providers::setup(app);
            dictation::setup(app);
            #[cfg(target_os = "macos")]
            setup_main_window_lifecycle(app);
            Ok(())
        })
        .build(context)
        .expect("failed to build OS Notetaker")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => dictation::stop_helper(app),
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main_window(app),
            _ => {}
        });
}

#[cfg(target_os = "macos")]
fn setup_main_window_lifecycle(app: &mut tauri::App) {
    if let Some(main_window) = app.get_webview_window("main") {
        let window = main_window.clone();
        main_window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        });
    }
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
        let _ = window.show();
        let _ = window.set_focus();
    }
}
