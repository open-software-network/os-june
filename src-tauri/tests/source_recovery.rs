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
async fn scan_surfaces_recoverable_sources() {
    let repos = repos().await;
    let dir = tempdir().expect("tempdir");
    let note = repos.create_note(None).await.expect("note");
    repos
        .create_recording_session(
            &note.id,
            "session-1",
            RecordingSourceMode::MicrophonePlusSystem,
            &dir.path().join("microphone.partial.wav").to_string_lossy(),
            &dir.path().join("microphone.wav").to_string_lossy(),
            None,
        )
        .await
        .expect("session");
    let mic_partial = dir.path().join("microphone.partial.wav");
    let system_partial = dir.path().join("system.partial.wav");
    std::fs::write(&mic_partial, b"mic bytes").expect("mic bytes");
    std::fs::write(&system_partial, b"system bytes").expect("system bytes");
    repos
        .create_pending_source_artifact(
            &note.id,
            "session-1",
            "microphone",
            &mic_partial.to_string_lossy(),
            &dir.path().join("microphone.wav").to_string_lossy(),
        )
        .await
        .expect("mic artifact");
    repos
        .create_pending_source_artifact(
            &note.id,
            "session-1",
            "system",
            &system_partial.to_string_lossy(),
            &dir.path().join("system.wav").to_string_lossy(),
        )
        .await
        .expect("system artifact");

    let recoveries = scan_recoverable_recordings(&repos.pool)
        .await
        .expect("recoveries");

    assert_eq!(recoveries.len(), 1);
    assert_eq!(recoveries[0].sources.len(), 2);
    assert!(recoveries[0]
        .sources
        .iter()
        .any(|source| source.source.as_db() == "system"));
}
