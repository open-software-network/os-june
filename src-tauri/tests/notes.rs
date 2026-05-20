use os_notetaker_lib::{
    db::{migrations::run_migrations, repositories::Repositories},
    domain::types::RecordingSourceMode,
};
use sqlx::sqlite::SqlitePoolOptions;

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
async fn updates_title_body_and_active_tab() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");

    let updated = repos
        .update_note(
            &note.id,
            Some("Edited title".to_string()),
            Some("Edited body".to_string()),
            Some("transcription".to_string()),
        )
        .await
        .expect("update");

    assert_eq!(updated.title, "Edited title");
    assert_eq!(updated.edited_content.as_deref(), Some("Edited body"));
    assert_eq!(updated.active_tab.as_deref(), Some("transcription"));
}

#[tokio::test]
async fn generated_note_returns_to_notes_tab() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    repos
        .update_note(&note.id, None, None, Some("transcription".to_string()))
        .await
        .expect("tab update");

    let generated = repos
        .set_generated_note(
            &note.id,
            Some("Generated title".to_string()),
            "Generated content".to_string(),
        )
        .await
        .expect("generated note");

    assert_eq!(generated.active_tab.as_deref(), Some("notes"));
    assert_eq!(
        generated.generated_content.as_deref(),
        Some("Generated content")
    );
}

#[tokio::test]
async fn generated_note_appends_to_existing_generated_content() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    repos
        .set_generated_note(
            &note.id,
            Some("Generated title".to_string()),
            "First recording".to_string(),
        )
        .await
        .expect("first generated note");

    let updated = repos
        .set_generated_note(&note.id, None, "Second recording".to_string())
        .await
        .expect("second generated note");

    assert_eq!(
        updated.generated_content.as_deref(),
        Some("First recording\n\nSecond recording")
    );
    assert_eq!(updated.edited_content, None);
}

#[tokio::test]
async fn generated_note_appends_to_existing_edited_content() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    repos
        .set_generated_note(
            &note.id,
            Some("Generated title".to_string()),
            "First recording".to_string(),
        )
        .await
        .expect("first generated note");
    repos
        .update_note(
            &note.id,
            None,
            Some("User edited first recording".to_string()),
            Some("notes".to_string()),
        )
        .await
        .expect("edit note");

    let updated = repos
        .set_generated_note(&note.id, None, "Second recording".to_string())
        .await
        .expect("second generated note");

    assert_eq!(
        updated.edited_content.as_deref(),
        Some("User edited first recording\n\nSecond recording")
    );
    assert_eq!(
        updated.generated_content.as_deref(),
        Some("First recording\n\nSecond recording")
    );
}

#[tokio::test]
async fn get_note_returns_transcript_and_audio_metadata() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    let session_id = "session-1";
    repos
        .create_recording_session(
            &note.id,
            session_id,
            RecordingSourceMode::MicrophoneOnly,
            "/tmp/partial.wav",
            "/tmp/final.wav",
            None,
        )
        .await
        .expect("session");
    let audio = repos
        .create_audio_artifact(&note.id, session_id, "/tmp/final.wav", 1200, 2048, "abc")
        .await
        .expect("artifact");
    repos
        .create_transcript(
            &note.id,
            &audio.id,
            "Raw transcript text",
            Some("en".into()),
            "mock",
        )
        .await
        .expect("transcript");

    let loaded = repos.get_note(&note.id).await.expect("loaded note");

    assert_eq!(loaded.audio.expect("audio").id, audio.id);
    assert_eq!(
        loaded.transcript.expect("transcript").text,
        "Raw transcript text"
    );
}
