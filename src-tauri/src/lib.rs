pub mod app_paths;
pub mod audio;
pub mod commands;
pub mod db;
pub mod domain;
pub mod providers;

pub fn run() {
    providers::load_local_env();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap_app,
            commands::create_note,
            commands::list_notes,
            commands::get_note,
            commands::delete_note,
            commands::update_note,
            commands::create_folder,
            commands::list_folders,
            commands::delete_folder,
            commands::assign_note_to_folder,
            commands::remove_note_from_folder,
            commands::get_microphone_permission_state,
            commands::check_recording_source_readiness,
            commands::start_recording,
            commands::pause_recording,
            commands::resume_recording,
            commands::get_recording_status,
            commands::finish_recording,
            commands::retry_processing,
            commands::recover_recording
        ])
        .run(tauri::generate_context!())
        .expect("failed to run OS Notetaker");
}
