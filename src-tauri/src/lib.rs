pub mod app_paths;
pub mod audio;
pub mod commands;
pub mod db;
pub mod dictation;
pub mod domain;
pub mod providers;

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
            dictation::set_dictation_activation_mode,
            dictation::set_dictation_microphone,
            dictation::dictation_helper_command,
            dictation::dictation_hotkey_status,
            dictation::latest_dictation_event,
            providers::provider_model_settings,
            providers::list_venice_models,
            providers::set_venice_model
        ])
        .setup(|app| {
            providers::setup(app);
            dictation::setup(app);
            Ok(())
        })
        .build(context)
        .expect("failed to build OS Notetaker")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                dictation::stop_helper(app);
            }
        });
}
