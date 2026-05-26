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
async fn deleting_note_removes_it_from_all_note_lists() {
    let repos = repos().await;
    let folder = repos.create_folder("Work", None).await.expect("folder");
    let note = repos
        .create_note(Some(folder.id.clone()))
        .await
        .expect("note");

    repos.delete_note(&note.id).await.expect("delete note");

    let all_notes = repos.list_notes(None, 50, None).await.expect("all notes");
    assert!(all_notes.items.is_empty());

    let folder_notes = repos
        .list_notes(Some(folder.id), 50, None)
        .await
        .expect("folder notes");
    assert!(folder_notes.items.is_empty());
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
async fn generated_note_does_not_duplicate_full_regenerated_content() {
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
        .set_generated_note(
            &note.id,
            None,
            "First recording\n\nSecond recording".to_string(),
        )
        .await
        .expect("full regenerated note");

    assert_eq!(
        updated.generated_content.as_deref(),
        Some("First recording\n\nSecond recording")
    );
}

#[tokio::test]
async fn generated_note_strips_placeholder_heading_when_appending() {
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
        .set_generated_note(&note.id, None, "# New note\n\nSecond recording".to_string())
        .await
        .expect("second generated note");

    assert_eq!(
        updated.generated_content.as_deref(),
        Some("First recording\n\nSecond recording")
    );
}

#[tokio::test]
async fn generated_note_strips_existing_note_prefix_when_appending() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    repos
        .set_generated_note(
            &note.id,
            Some("Generated title".to_string()),
            "Hola hola\n\nSegundo test".to_string(),
        )
        .await
        .expect("first generated note");

    let updated = repos
        .set_generated_note(
            &note.id,
            None,
            "Hola hola\n\nSegundo test\n\nTres, tres, dos, uno.".to_string(),
        )
        .await
        .expect("second generated note");

    assert_eq!(
        updated.generated_content.as_deref(),
        Some("Hola hola\n\nSegundo test\n\nTres, tres, dos, uno.")
    );
}

#[tokio::test]
async fn generated_note_strips_manual_note_echo_when_appending() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    repos
        .set_generated_note(
            &note.id,
            Some("Generated title".to_string()),
            "## Transcript (verbatim)\n\n- \"Un, dos, tres, hola hola.\"".to_string(),
        )
        .await
        .expect("first generated note");
    repos
        .update_note(
            &note.id,
            None,
            Some(
                "## Transcript (verbatim)\n\n- \"Un, dos, tres, hola hola.\"\n\nTest 2".to_string(),
            ),
            Some("notes".to_string()),
        )
        .await
        .expect("manual note");

    let updated = repos
        .set_generated_note(
            &note.id,
            None,
            "## Transcript (verbatim)\n\n- \"Un, dos, tres, hola hola.\"\n\nTest 2:\n\n## Test 2\n\n- Transcript: \"Tres, dos, uno, hola hola.\""
                .to_string(),
        )
        .await
        .expect("second generated note");

    assert_eq!(
        updated.edited_content.as_deref(),
        Some(
            "## Transcript (verbatim)\n\n- \"Un, dos, tres, hola hola.\"\n\nTest 2\n\n- Transcript: \"Tres, dos, uno, hola hola.\""
        )
    );
}

#[tokio::test]
async fn generated_note_replaces_existing_session_block() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");

    repos
        .set_generated_note_for_session(
            &note.id,
            Some("session-1"),
            None,
            Some("Generated title".to_string()),
            "First transcript result".to_string(),
        )
        .await
        .expect("first generated block");

    let updated = repos
        .set_generated_note_for_session(
            &note.id,
            Some("session-1"),
            None,
            None,
            "Retried transcript result".to_string(),
        )
        .await
        .expect("retried generated block");

    assert_eq!(
        updated.generated_content.as_deref(),
        Some("Retried transcript result")
    );
}

#[tokio::test]
async fn generated_note_composes_distinct_session_blocks_in_order() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");

    repos
        .set_generated_note_for_session(
            &note.id,
            Some("session-1"),
            None,
            Some("Generated title".to_string()),
            "First transcript result".to_string(),
        )
        .await
        .expect("first generated block");

    let updated = repos
        .set_generated_note_for_session(
            &note.id,
            Some("session-2"),
            None,
            None,
            "First transcript result\n\nSecond transcript result".to_string(),
        )
        .await
        .expect("second generated block");

    assert_eq!(
        updated.generated_content.as_deref(),
        Some("First transcript result\n\nSecond transcript result")
    );
}

#[tokio::test]
async fn generated_session_block_strips_manual_note_echo_before_composing() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    repos
        .set_generated_note_for_session(
            &note.id,
            Some("session-1"),
            None,
            Some("Generated title".to_string()),
            "## Transcript (verbatim)\n\n- \"Un, dos, tres, hola hola.\"".to_string(),
        )
        .await
        .expect("first generated block");
    repos
        .update_note(
            &note.id,
            None,
            Some(
                "## Transcript (verbatim)\n\n- \"Un, dos, tres, hola hola.\"\n\nTest 2".to_string(),
            ),
            Some("notes".to_string()),
        )
        .await
        .expect("manual note");

    let updated = repos
        .set_generated_note_for_session(
            &note.id,
            Some("session-2"),
            None,
            None,
            "## Transcript (verbatim)\n\n- \"Un, dos, tres, hola hola.\"\n\nTest 2:\n\n## Test 2\n\n- Transcript: \"Tres, dos, uno, hola hola.\""
                .to_string(),
        )
        .await
        .expect("second generated block");

    assert_eq!(
        updated.generated_content.as_deref(),
        Some(
            "## Transcript (verbatim)\n\n- \"Un, dos, tres, hola hola.\"\n\n- Transcript: \"Tres, dos, uno, hola hola.\""
        )
    );
    assert_eq!(
        updated.edited_content.as_deref(),
        Some(
            "## Transcript (verbatim)\n\n- \"Un, dos, tres, hola hola.\"\n\nTest 2\n\n- Transcript: \"Tres, dos, uno, hola hola.\""
        )
    );
}

#[tokio::test]
async fn first_generated_session_block_strips_initial_manual_note_echo() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    repos
        .update_note(
            &note.id,
            None,
            Some("Test 1:".to_string()),
            Some("notes".to_string()),
        )
        .await
        .expect("manual note");

    let updated = repos
        .set_generated_note_for_session(
            &note.id,
            Some("session-1"),
            None,
            Some("Generated title".to_string()),
            "Test 1:\n\n- Test 1\n- \"Test uno, probando probando, un dos tres.\"".to_string(),
        )
        .await
        .expect("first generated block");

    assert_eq!(
        updated.generated_content.as_deref(),
        Some("- \"Test uno, probando probando, un dos tres.\"")
    );
    assert_eq!(
        updated.edited_content.as_deref(),
        Some("Test 1:\n\n- \"Test uno, probando probando, un dos tres.\"")
    );
}

#[tokio::test]
async fn generated_session_block_strips_generic_note_heading_after_manual_echo() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    repos
        .set_generated_note_for_session(
            &note.id,
            Some("session-1"),
            None,
            Some("Generated title".to_string()),
            "- \"Test uno, probando probando, un dos tres.\"".to_string(),
        )
        .await
        .expect("first generated block");
    repos
        .update_note(
            &note.id,
            None,
            Some("- \"Test uno, probando probando, un dos tres.\"\n\nTest 2:".to_string()),
            Some("notes".to_string()),
        )
        .await
        .expect("manual note");

    let updated = repos
        .set_generated_note_for_session(
            &note.id,
            Some("session-2"),
            None,
            None,
            "Test 2:\n\n## Note\n\n- Test: \"probando, probando, tres, dos, uno\"".to_string(),
        )
        .await
        .expect("second generated block");

    assert_eq!(
        updated.edited_content.as_deref(),
        Some(
            "- \"Test uno, probando probando, un dos tres.\"\n\nTest 2:\n\n- Test: \"probando, probando, tres, dos, uno\""
        )
    );
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
async fn generated_note_does_not_duplicate_full_regenerated_edited_content() {
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
            Some("First recording".to_string()),
            Some("notes".to_string()),
        )
        .await
        .expect("edited note");

    let updated = repos
        .set_generated_note(
            &note.id,
            None,
            "First recording\n\nSecond recording".to_string(),
        )
        .await
        .expect("full regenerated note");

    assert_eq!(
        updated.edited_content.as_deref(),
        Some("First recording\n\nSecond recording")
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
            "venice",
        )
        .await
        .expect("transcript");

    let loaded = repos.get_note(&note.id).await.expect("loaded note");

    assert_eq!(loaded.audio.expect("audio").id, audio.id);
    assert_eq!(
        loaded.transcript.expect("transcript").text,
        "Raw transcript text"
    );
    assert!(loaded.source_transcripts.is_empty());
}

#[tokio::test]
async fn get_note_returns_only_timed_source_transcript_rows() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    let session_id = "session-1";
    repos
        .create_recording_session(
            &note.id,
            session_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "/tmp/microphone.partial.wav",
            "/tmp/microphone.wav",
            None,
        )
        .await
        .expect("session");
    let audio = repos
        .create_audio_artifact(
            &note.id,
            session_id,
            "/tmp/microphone.wav",
            1200,
            2048,
            "abc",
        )
        .await
        .expect("artifact");
    repos
        .create_transcript(
            &note.id,
            &audio.id,
            "Standalone transcript should not be displayed as a turn.",
            Some("en".into()),
            "venice",
        )
        .await
        .expect("standalone transcript");
    repos
        .create_source_transcript(
            &note.id,
            session_id,
            &audio.id,
            RecordingSourceMode::MicrophonePlusSystem,
            "microphone",
            "Timed source transcript",
            Some("en".into()),
            "venice",
            Some(1_000),
            Some(2_000),
            Some(0),
        )
        .await
        .expect("source transcript");

    let loaded = repos.get_note(&note.id).await.expect("loaded note");

    assert_eq!(loaded.source_transcripts.len(), 1);
    assert_eq!(loaded.source_transcripts[0].text, "Timed source transcript");
}
