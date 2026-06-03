use os_scribe_lib::{
    db::{migrations::run_migrations, repositories::Repositories},
    domain::types::RecordingSourceMode,
};
use sqlx::sqlite::SqlitePoolOptions;

async fn test_repositories() -> Repositories {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("in-memory sqlite should open");
    run_migrations(&pool).await.expect("migrations should run");
    Repositories::new(pool)
}

#[tokio::test]
async fn persists_source_mode_with_recording_session() {
    let repos = test_repositories().await;
    let note = repos.create_note(None).await.expect("note should exist");

    repos
        .create_recording_session(
            &note.id,
            "session-1",
            RecordingSourceMode::MicrophonePlusSystem,
            "/tmp/mic.partial.wav",
            "/tmp/mic.wav",
            Some("Built-in Microphone".to_string()),
        )
        .await
        .expect("session should be created");

    let session = repos
        .recording_session_source_mode("session-1")
        .await
        .expect("query should succeed")
        .expect("session should be found");

    assert_eq!(session, RecordingSourceMode::MicrophonePlusSystem);
}

#[tokio::test]
async fn stores_source_artifacts_independently() {
    let repos = test_repositories().await;
    let note = repos.create_note(None).await.expect("note should exist");

    repos
        .create_recording_session(
            &note.id,
            "session-1",
            RecordingSourceMode::MicrophonePlusSystem,
            "/tmp/mic.partial.wav",
            "/tmp/mic.wav",
            None,
        )
        .await
        .expect("session should be created");
    repos
        .create_pending_source_artifact(
            &note.id,
            "session-1",
            "microphone",
            "/tmp/mic.partial.wav",
            "/tmp/mic.wav",
        )
        .await
        .expect("microphone artifact should be created");
    repos
        .create_pending_source_artifact(
            &note.id,
            "session-1",
            "system",
            "/tmp/system.partial.wav",
            "/tmp/system.wav",
        )
        .await
        .expect("system artifact should be created");

    let artifacts = repos
        .source_artifacts_for_session("session-1")
        .await
        .expect("artifacts should load");

    assert_eq!(artifacts.len(), 2);
    assert!(artifacts
        .iter()
        .any(|artifact| artifact.source == "microphone"));
    assert!(artifacts.iter().any(|artifact| artifact.source == "system"));
}

#[tokio::test]
async fn upserts_source_turn_transcripts_for_retry() {
    let repos = test_repositories().await;
    let note = repos.create_note(None).await.expect("note should exist");

    repos
        .create_recording_session(
            &note.id,
            "session-1",
            RecordingSourceMode::MicrophonePlusSystem,
            "/tmp/mic.partial.wav",
            "/tmp/mic.wav",
            None,
        )
        .await
        .expect("session should be created");
    let artifact = repos
        .create_pending_source_artifact(
            &note.id,
            "session-1",
            "microphone",
            "/tmp/mic.partial.wav",
            "/tmp/mic.wav",
        )
        .await
        .expect("microphone artifact should be created");

    let failed = repos
        .upsert_failed_source_turn_transcript(
            &note.id,
            "session-1",
            &artifact.id,
            RecordingSourceMode::MicrophonePlusSystem,
            "microphone",
            "test",
            "temporary provider failure",
            0,
            1_000,
            0,
        )
        .await
        .expect("failed turn should be stored");
    let succeeded = repos
        .upsert_successful_source_turn_transcript(
            &note.id,
            "session-1",
            &artifact.id,
            RecordingSourceMode::MicrophonePlusSystem,
            "microphone",
            "Recovered transcript",
            Some("en".to_string()),
            "test",
            0,
            1_000,
            0,
        )
        .await
        .expect("successful retry should replace failed turn");

    assert_eq!(failed.id, succeeded.id);
    let transcripts = repos
        .successful_source_turn_transcripts_for_session("session-1")
        .await
        .expect("successful turns should load");
    assert_eq!(transcripts.len(), 1);
    assert_eq!(transcripts[0].text, "Recovered transcript");
    assert_eq!(transcripts[0].status, "succeeded");
}
