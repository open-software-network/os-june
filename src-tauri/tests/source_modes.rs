use os_june_lib::{
    db::{migrations::run_migrations, repositories::Repositories},
    domain::types::{AudioValidationDto, RecordingSourceMode},
};
use sqlx::query::query;
use sqlx_sqlite::SqlitePoolOptions;

async fn test_repositories() -> Repositories {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("in-memory sqlite should open");
    run_migrations(&pool).await.expect("migrations should run");
    Repositories::new(pool)
}

fn validation_summary(expected_duration_ms: i64, actual_duration_ms: i64) -> String {
    serde_json::to_string(&AudioValidationDto {
        file_exists: true,
        non_zero_size: true,
        readable_audio: true,
        expected_duration_ms,
        actual_duration_ms,
        duration_within_tolerance: false,
        non_silent_signal: true,
        peak_amplitude: 0.2,
        rms_amplitude: 0.1,
        warnings: vec!["audio duration mismatch".to_string()],
    })
    .expect("validation summary should serialize")
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
async fn latest_retryable_audio_paths_include_invalid_saved_artifacts() {
    let repos = test_repositories().await;
    let note = repos.create_note(None).await.expect("note should exist");

    repos
        .create_recording_session(
            &note.id,
            "session-1",
            RecordingSourceMode::MicrophoneOnly,
            "/tmp/old.partial.wav",
            "/tmp/old.wav",
            None,
        )
        .await
        .expect("old session should be created");
    repos
        .create_audio_artifact(&note.id, "session-1", "/tmp/old.wav", 1_000, 100, "old")
        .await
        .expect("old artifact should be valid");

    repos
        .create_recording_session(
            &note.id,
            "session-2",
            RecordingSourceMode::MicrophonePlusSystem,
            "/tmp/mic.partial.wav",
            "/tmp/mic.wav",
            None,
        )
        .await
        .expect("latest session should be created");
    let artifact = repos
        .create_pending_source_artifact(
            &note.id,
            "session-2",
            "microphone",
            "/tmp/mic.partial.wav",
            "/tmp/mic.wav",
        )
        .await
        .expect("microphone artifact should be created");
    repos
        .finalize_source_artifact(
            &artifact.id,
            "/tmp/mic.wav",
            "invalid",
            2_515_414,
            4096,
            "checksum",
            2_082_511,
            Some(validation_summary(2_082_511, 2_515_414)),
            Some("audio duration mismatch".to_string()),
        )
        .await
        .expect("artifact should be finalized as invalid");

    let retryable = repos
        .latest_retryable_audio_artifact_paths(&note.id)
        .await
        .expect("retryable paths should load");

    assert_eq!(retryable.len(), 1);
    assert_eq!(retryable[0].recording_session_id, "session-2");
    assert_eq!(retryable[0].status, "invalid");
    assert_eq!(retryable[0].expected_duration_ms, 2_082_511);
}

#[tokio::test]
async fn latest_retryable_audio_paths_fall_back_to_valid_session() {
    let repos = test_repositories().await;
    let note = repos.create_note(None).await.expect("note should exist");

    repos
        .create_recording_session(
            &note.id,
            "session-1",
            RecordingSourceMode::MicrophoneOnly,
            "/tmp/old.partial.wav",
            "/tmp/old.wav",
            None,
        )
        .await
        .expect("old session should be created");
    repos
        .create_audio_artifact(&note.id, "session-1", "/tmp/old.wav", 1_000, 100, "old")
        .await
        .expect("old artifact should be valid");

    repos
        .create_recording_session(
            &note.id,
            "session-2",
            RecordingSourceMode::MicrophoneOnly,
            "/tmp/new.partial.wav",
            "/tmp/new.wav",
            None,
        )
        .await
        .expect("latest session should be created");
    let artifact = repos
        .create_pending_source_artifact(
            &note.id,
            "session-2",
            "microphone",
            "/tmp/new.partial.wav",
            "/tmp/new.wav",
        )
        .await
        .expect("latest artifact should be created");
    repos
        .finalize_source_artifact(
            &artifact.id,
            "/tmp/new.wav",
            "invalid",
            1_000,
            4096,
            "checksum",
            10_000,
            Some(validation_summary(10_000, 1_000)),
            Some("audio duration mismatch".to_string()),
        )
        .await
        .expect("latest artifact should be finalized as invalid");

    let retryable = repos
        .latest_retryable_audio_artifact_paths(&note.id)
        .await
        .expect("retryable paths should load");

    assert_eq!(retryable.len(), 1);
    assert_eq!(retryable[0].recording_session_id, "session-1");
    assert_eq!(retryable[0].status, "valid");
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

#[tokio::test]
async fn note_source_transcripts_are_ordered_by_session_then_turn() {
    let repos = test_repositories().await;
    let note = repos.create_note(None).await.expect("note should exist");

    repos
        .create_recording_session(
            &note.id,
            "session-1",
            RecordingSourceMode::MicrophonePlusSystem,
            "/tmp/session-1-mic.partial.wav",
            "/tmp/session-1-mic.wav",
            None,
        )
        .await
        .expect("first session should be created");
    repos
        .create_recording_session(
            &note.id,
            "session-2",
            RecordingSourceMode::MicrophonePlusSystem,
            "/tmp/session-2-mic.partial.wav",
            "/tmp/session-2-mic.wav",
            None,
        )
        .await
        .expect("second session should be created");
    query("UPDATE recording_sessions SET started_at = ? WHERE id = ?")
        .bind("2026-05-20T10:00:00.000Z")
        .bind("session-1")
        .execute(&repos.pool)
        .await
        .expect("first session timestamp");
    query("UPDATE recording_sessions SET started_at = ? WHERE id = ?")
        .bind("2026-05-20T10:05:00.000Z")
        .bind("session-2")
        .execute(&repos.pool)
        .await
        .expect("second session timestamp");

    let first_artifact = repos
        .create_pending_source_artifact(
            &note.id,
            "session-1",
            "microphone",
            "/tmp/session-1-mic.partial.wav",
            "/tmp/session-1-mic.wav",
        )
        .await
        .expect("first artifact should be created");
    let second_artifact = repos
        .create_pending_source_artifact(
            &note.id,
            "session-2",
            "microphone",
            "/tmp/session-2-mic.partial.wav",
            "/tmp/session-2-mic.wav",
        )
        .await
        .expect("second artifact should be created");

    repos
        .upsert_successful_source_turn_transcript(
            &note.id,
            "session-1",
            &first_artifact.id,
            RecordingSourceMode::MicrophonePlusSystem,
            "microphone",
            "First recording, first turn",
            Some("en".to_string()),
            "test",
            0,
            1_000,
            0,
        )
        .await
        .expect("first turn should be stored");
    repos
        .upsert_successful_source_turn_transcript(
            &note.id,
            "session-1",
            &first_artifact.id,
            RecordingSourceMode::MicrophonePlusSystem,
            "microphone",
            "First recording, second turn",
            Some("en".to_string()),
            "test",
            2_000,
            3_000,
            1,
        )
        .await
        .expect("second turn should be stored");
    repos
        .upsert_successful_source_turn_transcript(
            &note.id,
            "session-2",
            &second_artifact.id,
            RecordingSourceMode::MicrophonePlusSystem,
            "microphone",
            "Second recording, first turn",
            Some("en".to_string()),
            "test",
            0,
            1_000,
            0,
        )
        .await
        .expect("third turn should be stored");

    let note = repos.get_note(&note.id).await.expect("note should load");
    let texts = note
        .source_transcripts
        .iter()
        .map(|transcript| transcript.text.as_str())
        .collect::<Vec<_>>();

    assert_eq!(
        texts,
        vec![
            "First recording, first turn",
            "First recording, second turn",
            "Second recording, first turn",
        ]
    );
}
