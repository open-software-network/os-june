use clovy_lib::{
    audio::recovery::{scan_marked_recoverable_recordings, scan_recoverable_recordings},
    db::{migrations::run_migrations, repositories::Repositories},
    domain::types::{ProcessingStatus, RecordingSourceMode, RecordingState},
};
use sqlx::query::query;
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
async fn scan_recovers_a_finalized_session_waiting_for_processing() {
    let repos = repos().await;
    let dir = tempdir().expect("tempdir");
    let final_path = dir.path().join("queued.wav");
    std::fs::write(&final_path, b"finalized audio").expect("audio bytes");
    let note = repos.create_note("default", None).await.expect("note");
    repos
        .create_recording_session(
            &note.id,
            "queued-session",
            RecordingSourceMode::MicrophoneOnly,
            &dir.path().join("queued.partial.wav").to_string_lossy(),
            &final_path.to_string_lossy(),
            None,
        )
        .await
        .expect("session");
    let artifact = repos
        .create_pending_source_artifact(
            &note.id,
            "queued-session",
            "microphone",
            &dir.path().join("queued.partial.wav").to_string_lossy(),
            &final_path.to_string_lossy(),
        )
        .await
        .expect("artifact");
    repos
        .finalize_source_artifact(
            &artifact.id,
            &final_path.to_string_lossy(),
            "valid",
            1_000,
            15,
            "checksum",
            1_000,
            None,
            None,
        )
        .await
        .expect("finalize artifact");
    repos
        .update_recording_session(
            "queued-session",
            "processing_pending",
            1_000,
            Some(15),
            Some(1_000),
            Some("checksum".to_string()),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("finalize session with durable processing handoff");

    let recoveries = scan_recoverable_recordings(&repos.pool)
        .await
        .expect("recovery scan");

    assert_eq!(recoveries.len(), 1);
    assert_eq!(recoveries[0].session_id, "queued-session");
    assert_eq!(recoveries[0].note_id, note.id);
    assert_eq!(recoveries[0].bytes_found, 15);
}

#[tokio::test]
async fn scan_orders_same_note_recoveries_by_recording_chronology() {
    let repos = repos().await;
    let dir = tempdir().expect("tempdir");
    let note = repos.create_note("default", None).await.expect("note");
    for session_id in ["later-session", "earlier-session"] {
        let path = dir.path().join(format!("{session_id}.wav"));
        std::fs::write(&path, session_id.as_bytes()).expect("audio bytes");
        repos
            .create_recording_session(
                &note.id,
                session_id,
                RecordingSourceMode::MicrophoneOnly,
                &dir.path()
                    .join(format!("{session_id}.partial.wav"))
                    .to_string_lossy(),
                &path.to_string_lossy(),
                None,
            )
            .await
            .expect("session");
        repos
            .mark_recording_processing_pending(session_id)
            .await
            .expect("pending handoff");
    }
    query(
        "UPDATE recording_sessions
         SET started_at = CASE id
           WHEN 'earlier-session' THEN '2026-08-21T10:00:00.000Z'
           ELSE '2026-08-21T11:00:00.000Z'
         END
         WHERE id IN ('earlier-session', 'later-session')",
    )
    .execute(&repos.pool)
    .await
    .expect("recording chronology");

    let recoveries = scan_recoverable_recordings(&repos.pool)
        .await
        .expect("recovery scan");

    assert_eq!(
        recoveries
            .iter()
            .map(|recovery| recovery.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["earlier-session", "later-session"]
    );
}

#[tokio::test]
async fn renderer_reload_scan_ignores_live_pending_processing() {
    let repos = repos().await;
    let dir = tempdir().expect("tempdir");
    let final_path = dir.path().join("live-pending.wav");
    std::fs::write(&final_path, b"live pending audio").expect("audio bytes");
    let note = repos.create_note("default", None).await.expect("note");
    repos
        .create_recording_session(
            &note.id,
            "live-pending-session",
            RecordingSourceMode::MicrophoneOnly,
            &dir.path()
                .join("live-pending.partial.wav")
                .to_string_lossy(),
            &final_path.to_string_lossy(),
            None,
        )
        .await
        .expect("session");
    repos
        .mark_recording_processing_pending("live-pending-session")
        .await
        .expect("pending handoff");

    assert!(scan_marked_recoverable_recordings(&repos.pool)
        .await
        .expect("renderer reload scan")
        .is_empty());

    repos
        .mark_recording_recoverable("live-pending-session", &note.id)
        .await
        .expect("one-time startup promotion");
    let recoveries = scan_marked_recoverable_recordings(&repos.pool)
        .await
        .expect("promoted recovery scan");
    assert_eq!(recoveries.len(), 1);
    assert_eq!(recoveries[0].session_id, "live-pending-session");
}

#[tokio::test]
async fn recovery_promotion_cannot_overwrite_a_completed_note() {
    let repos = repos().await;
    let note = repos.create_note("default", None).await.expect("note");
    repos
        .create_recording_session(
            &note.id,
            "completed-session",
            RecordingSourceMode::MicrophoneOnly,
            "/tmp/completed.partial.wav",
            "/tmp/completed.wav",
            None,
        )
        .await
        .expect("session");
    repos
        .mark_recording_processing_finished("completed-session", None)
        .await
        .expect("completed processing");
    repos
        .set_note_status(&note.id, ProcessingStatus::Ready, None)
        .await
        .expect("ready note");

    assert!(!repos
        .mark_recording_recoverable("completed-session", &note.id)
        .await
        .expect("conditional recovery promotion"));
    let unchanged = repos.get_note(&note.id).await.expect("unchanged note");
    assert_eq!(unchanged.processing_status, ProcessingStatus::Ready);
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
