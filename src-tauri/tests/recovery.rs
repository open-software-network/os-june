use os_notetaker_lib::{
    audio::recovery::scan_recoverable_recordings,
    db::{migrations::run_migrations, repositories::Repositories},
    domain::types::RecordingSourceMode,
};
use sqlx::sqlite::SqlitePoolOptions;
use tempfile::tempdir;

async fn repos() -> Repositories {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("sqlite memory");
    run_migrations(&pool).await.expect("migrations");
    Repositories::new(pool)
}

#[tokio::test]
async fn scan_surfaces_interrupted_recording_with_audio_bytes() {
    let repos = repos().await;
    let dir = tempdir().expect("tempdir");
    let partial = dir.path().join("session.partial.wav");
    std::fs::write(&partial, b"partial audio").expect("partial bytes");
    let note = repos.create_note(None).await.expect("note");
    repos
        .create_recording_session(
            &note.id,
            "session-1",
            RecordingSourceMode::MicrophoneOnly,
            &partial.to_string_lossy(),
            &dir.path().join("session.wav").to_string_lossy(),
            None,
        )
        .await
        .expect("session");

    let recoveries = scan_recoverable_recordings(&repos.pool)
        .await
        .expect("recovery scan");

    assert_eq!(recoveries.len(), 1);
    assert_eq!(recoveries[0].session_id, "session-1");
    assert_eq!(recoveries[0].note_id, note.id);
    assert!(recoveries[0].partial_path_present);
    assert_eq!(recoveries[0].bytes_found, 13);
}

#[tokio::test]
async fn scan_ignores_missing_audio_bytes() {
    let repos = repos().await;
    let dir = tempdir().expect("tempdir");
    let note = repos.create_note(None).await.expect("note");
    repos
        .create_recording_session(
            &note.id,
            "session-1",
            RecordingSourceMode::MicrophoneOnly,
            &dir.path().join("missing.partial.wav").to_string_lossy(),
            &dir.path().join("missing.wav").to_string_lossy(),
            None,
        )
        .await
        .expect("session");

    let recoveries = scan_recoverable_recordings(&repos.pool)
        .await
        .expect("recovery scan");

    assert!(recoveries.is_empty());
}
