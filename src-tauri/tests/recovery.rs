use os_june_lib::{
    audio::recovery::scan_recoverable_recordings,
    db::{migrations::run_migrations, repositories::Repositories},
    domain::types::{ProcessingStatus, RecordingSourceMode, RecordingState},
};
use sqlx::query_scalar::query_scalar;
use sqlx_sqlite::SqlitePoolOptions;
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
    let note = repos.create_note("default", None).await.expect("note");
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
async fn recovery_snapshot_persists_elapsed_time_for_session_and_sources() {
    let repos = repos().await;
    let dir = tempdir().expect("tempdir");
    let note = repos.create_note("default", None).await.expect("note");
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
    repos
        .create_pending_source_artifact(
            &note.id,
            "session-1",
            "microphone",
            &dir.path().join("microphone.partial.wav").to_string_lossy(),
            &dir.path().join("microphone.wav").to_string_lossy(),
        )
        .await
        .expect("artifact");

    repos
        .update_recording_recovery_snapshot("session-1", RecordingState::Paused, 2_500)
        .await
        .expect("snapshot");

    let info = repos
        .recording_recovery_info("session-1")
        .await
        .expect("recovery info")
        .expect("session");
    let artifacts = repos
        .source_artifact_paths_for_session("session-1")
        .await
        .expect("artifacts");
    let artifact_status: String =
        query_scalar("SELECT status FROM audio_artifacts WHERE recording_session_id = ?")
            .bind("session-1")
            .fetch_one(&repos.pool)
            .await
            .expect("artifact status");

    assert_eq!(info.expected_elapsed_ms, 2_500);
    assert_eq!(artifacts[0].expected_duration_ms, 2_500);
    assert_eq!(artifact_status, "paused");
}

#[tokio::test]
async fn boot_recovery_marks_note_recoverable_when_audio_survived() {
    let repos = repos().await;
    let dir = tempdir().expect("tempdir");
    let partial = dir.path().join("session.partial.wav");
    std::fs::write(&partial, b"partial audio").expect("partial bytes");
    let note = repos.create_note("default", None).await.expect("note");
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
    for recovery in &recoveries {
        repos
            .mark_recording_recoverable(&recovery.session_id, &recovery.note_id)
            .await
            .expect("mark recoverable");
    }
    let recovered_note = repos.get_note(&note.id).await.expect("note");
    let recording_status: String =
        query_scalar("SELECT status FROM recording_sessions WHERE id = ?")
            .bind("session-1")
            .fetch_one(&repos.pool)
            .await
            .expect("recording status");

    assert_eq!(recoveries.len(), 1);
    assert_eq!(recording_status, "recoverable");
    assert_eq!(
        recovered_note.processing_status,
        ProcessingStatus::Recoverable
    );
}

#[tokio::test]
async fn scan_ignores_missing_audio_bytes() {
    let repos = repos().await;
    let dir = tempdir().expect("tempdir");
    let note = repos.create_note("default", None).await.expect("note");
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
