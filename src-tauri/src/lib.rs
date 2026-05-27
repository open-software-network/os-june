pub mod app_paths;
pub mod audio;
pub mod commands;
pub mod db;
pub mod dictation;
pub mod domain;
pub mod meeting_detection;
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
            meeting_detection::latest_meeting_detection_event,
            meeting_detection::dismiss_detected_meeting,
            meeting_detection::start_detected_meeting_recording,
            meeting_detection::meeting_detection_hud_prepare_prompt,
            meeting_detection::meeting_detection_hud_restore_compact,
            providers::provider_model_settings,
            providers::list_venice_models,
            providers::set_venice_model
        ])
        .setup(|app| {
            providers::setup(app);
            dictation::setup(app);
            meeting_detection::setup(app);
            Ok(())
        })
        .build(context)
        .expect("failed to build OS Notetaker")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                dictation::stop_helper(app);
                meeting_detection::stop_helper(app);
            }
        });
}
