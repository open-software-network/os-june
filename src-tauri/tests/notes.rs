use os_june_lib::{
    db::{
        migrations::run_migrations,
        repositories::{PersonaClusterRecord, Repositories},
    },
    domain::types::{ProcessingStatus, RecordingSourceMode},
    personas::PERSONA_MODEL_ID,
};
use sqlx_sqlite::SqlitePoolOptions;

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
async fn deleting_notes_removes_multiple_notes_from_all_note_lists() {
    let repos = repos().await;
    let folder = repos.create_folder("Work", None).await.expect("folder");
    let first = repos
        .create_note(Some(folder.id.clone()))
        .await
        .expect("first note");
    let second = repos
        .create_note(Some(folder.id.clone()))
        .await
        .expect("second note");
    let retained = repos
        .create_note(Some(folder.id.clone()))
        .await
        .expect("retained note");

    repos
        .delete_notes(&[first.id.clone(), second.id.clone()])
        .await
        .expect("delete notes");

    let all_notes = repos.list_notes(None, 50, None).await.expect("all notes");
    assert_eq!(all_notes.items.len(), 1);
    assert_eq!(all_notes.items[0].id, retained.id);

    let folder_notes = repos
        .list_notes(Some(folder.id), 50, None)
        .await
        .expect("folder notes");
    assert_eq!(folder_notes.items.len(), 1);
    assert_eq!(folder_notes.items[0].id, retained.id);
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
async fn generated_note_derives_title_when_provider_returns_placeholder() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");

    let generated = repos
        .set_generated_note(
            &note.id,
            Some("Untitled note".to_string()),
            "- Conversation about rate limits for upcoming launch\n- Sabrina can help with higher limits"
                .to_string(),
        )
        .await
        .expect("generated note");

    assert_eq!(
        generated.title,
        "Conversation about rate limits for upcoming launch"
    );
}

#[tokio::test]
async fn generated_note_derives_title_from_all_section_headings() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");

    let generated = repos
        .set_generated_note(
            &note.id,
            Some("Untitled note".to_string()),
            "# Budget review\n\n- Costs are rising\n\n# Hiring plan\n\n- Open roles are approved\n\n# Product launch\n\n- The team is keeping the launch date"
                .to_string(),
        )
        .await
        .expect("generated note");

    assert_eq!(
        generated.title,
        "Budget review, Hiring plan, and Product launch"
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
async fn discarded_recording_no_longer_exposes_retryable_audio() {
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
    repos
        .create_audio_artifact(&note.id, session_id, "/tmp/final.wav", 1200, 2048, "abc")
        .await
        .expect("artifact");

    let discarded = repos
        .mark_recording_discarded(session_id, &note.id)
        .await
        .expect("discarded note");

    assert_eq!(discarded.processing_status, ProcessingStatus::Failed);
    assert_eq!(discarded.last_error.as_deref(), Some("Recording discarded"));
    assert!(discarded.audio.is_none());
    assert!(discarded.audio_sources.is_empty());
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

#[tokio::test]
async fn transcript_persona_assignment_round_trips_and_can_be_removed() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    let audio_id = create_session_audio(&repos, &note.id, "session-persona").await;
    let transcript = repos
        .create_source_transcript(
            &note.id,
            "session-persona",
            &audio_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "The person speaking is Jun.",
            Some("en".into()),
            "venice",
            Some(1_000),
            Some(2_000),
            Some(0),
        )
        .await
        .expect("source transcript");

    let assigned = repos
        .assign_transcript_persona(&note.id, &transcript.id, "Jun", Some("Product lead"))
        .await
        .expect("assign persona");
    let persona = assigned.source_transcripts[0]
        .persona
        .as_ref()
        .expect("persona should be returned with the turn");
    assert_eq!(persona.name, "Jun");
    assert_eq!(persona.relationship.as_deref(), Some("Product lead"));

    let removed = repos
        .unassign_transcript_persona(&note.id, &transcript.id)
        .await
        .expect("remove persona assignment");
    assert!(removed.source_transcripts[0].persona.is_none());
}

#[tokio::test]
async fn transcript_persona_assignment_keeps_same_name_relationships_distinct() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    let audio_id = create_session_audio(&repos, &note.id, "session-persona-duplicates").await;
    let first = repos
        .create_source_transcript(
            &note.id,
            "session-persona-duplicates",
            &audio_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "First Jun",
            Some("en".into()),
            "venice",
            Some(1_000),
            Some(2_000),
            Some(0),
        )
        .await
        .expect("first transcript");
    let second = repos
        .create_source_transcript(
            &note.id,
            "session-persona-duplicates",
            &audio_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "Second Jun",
            Some("en".into()),
            "venice",
            Some(2_000),
            Some(3_000),
            Some(1),
        )
        .await
        .expect("second transcript");

    let _first_assigned = repos
        .assign_transcript_persona(&note.id, &first.id, "Jun", Some("Product lead"))
        .await
        .expect("first assignment");
    let assigned = repos
        .assign_transcript_persona(&note.id, &second.id, "Jun", Some("Customer"))
        .await
        .expect("second assignment");

    let relationships = assigned
        .source_transcripts
        .iter()
        .filter_map(|transcript| transcript.persona.as_ref())
        .map(|persona| persona.relationship.as_deref())
        .collect::<Vec<_>>();
    assert_eq!(relationships, vec![Some("Product lead"), Some("Customer")]);
}

#[tokio::test]
async fn reassigning_a_legacy_turn_removes_the_unused_previous_participant() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    let audio_id = create_session_audio(&repos, &note.id, "session-persona-reassign").await;
    let transcript = repos
        .create_source_transcript(
            &note.id,
            "session-persona-reassign",
            &audio_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "Reassigned speaker",
            Some("en".into()),
            "venice",
            Some(1_000),
            Some(2_000),
            Some(0),
        )
        .await
        .expect("transcript");

    repos
        .assign_transcript_persona(&note.id, &transcript.id, "First", None)
        .await
        .expect("first assignment");
    let reassigned = repos
        .assign_transcript_persona(&note.id, &transcript.id, "Second", None)
        .await
        .expect("second assignment");

    assert_eq!(reassigned.participants.len(), 1);
    assert_eq!(reassigned.participants[0].persona.name, "Second");
}

#[tokio::test]
async fn tagging_a_cluster_enrolls_a_voiceprint_and_assigns_every_cluster_turn() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    let session_id = "session-cluster-tag";
    let audio_id = create_session_audio(&repos, &note.id, session_id).await;
    let first = repos
        .create_source_transcript(
            &note.id,
            session_id,
            &audio_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "First cluster turn",
            Some("en".into()),
            "venice",
            Some(1_000),
            Some(2_000),
            Some(0),
        )
        .await
        .expect("first transcript");
    repos
        .create_source_transcript(
            &note.id,
            session_id,
            &audio_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "Second cluster turn",
            Some("en".into()),
            "venice",
            Some(2_000),
            Some(3_000),
            Some(1),
        )
        .await
        .expect("second transcript");
    repos
        .persist_persona_recognition(
            &note.id,
            session_id,
            &[PersonaClusterRecord {
                id: "cluster-1".to_string(),
                recording_session_id: session_id.to_string(),
                note_id: note.id.clone(),
                source: "system".to_string(),
                speaker_index: 0,
                anonymous_label: "Speaker 00".to_string(),
                model_id: PERSONA_MODEL_ID.to_string(),
                embedding: vec![0, 0, 128, 63],
                spans_json: "[[1000,3000]]".to_string(),
                state: "anonymous".to_string(),
                persona_id: None,
                confidence: None,
            }],
        )
        .await
        .expect("persist clusters");

    let tagged = repos
        .assign_transcript_persona(&note.id, &first.id, "Jun", Some("Product lead"))
        .await
        .expect("tag cluster");

    assert_eq!(tagged.participants.len(), 1);
    assert!(tagged.source_transcripts.iter().all(|transcript| transcript
        .persona
        .as_ref()
        .map(|persona| persona.name.as_str())
        == Some("Jun")));
    assert!(tagged.source_transcripts.iter().all(|transcript| transcript
        .attribution
        .as_ref()
        .map(|value| value.state.as_str())
        == Some("tagged")));
    let voiceprints = repos
        .persona_voiceprints_for_source("system", PERSONA_MODEL_ID, "future-session")
        .await
        .expect("voiceprints");
    assert_eq!(voiceprints.len(), 1);
    assert_eq!(voiceprints[0].kind, "positive");
}

#[tokio::test]
async fn confirming_a_first_cross_meeting_suggestion_trusts_future_matches() {
    let repos = repos().await;
    let enrollment_note = repos.create_note(None).await.expect("enrollment note");
    let enrollment_audio =
        create_session_audio(&repos, &enrollment_note.id, "enrollment-session").await;
    let enrollment_transcript = repos
        .create_source_transcript(
            &enrollment_note.id,
            "enrollment-session",
            &enrollment_audio,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "Enrollment",
            Some("en".into()),
            "venice",
            Some(0),
            Some(1_000),
            Some(0),
        )
        .await
        .expect("enrollment transcript");
    repos
        .persist_persona_recognition(
            &enrollment_note.id,
            "enrollment-session",
            &[PersonaClusterRecord {
                id: "enrollment-cluster".to_string(),
                recording_session_id: "enrollment-session".to_string(),
                note_id: enrollment_note.id.clone(),
                source: "system".to_string(),
                speaker_index: 0,
                anonymous_label: "Speaker 00".to_string(),
                model_id: PERSONA_MODEL_ID.to_string(),
                embedding: vec![0, 0, 128, 63],
                spans_json: "[[0,1000]]".to_string(),
                state: "anonymous".to_string(),
                persona_id: None,
                confidence: None,
            }],
        )
        .await
        .expect("enrollment cluster");
    let enrolled = repos
        .assign_transcript_persona(
            &enrollment_note.id,
            &enrollment_transcript.id,
            "Jun",
            Some("Product lead"),
        )
        .await
        .expect("enroll Persona");
    let persona_id = enrolled.participants[0].persona.id.clone();

    let note = repos.create_note(None).await.expect("next note");
    let session_id = "next-session";
    let audio_id = create_session_audio(&repos, &note.id, session_id).await;
    let transcript = repos
        .create_source_transcript(
            &note.id,
            session_id,
            &audio_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "Recognized later",
            Some("en".into()),
            "venice",
            Some(0),
            Some(1_000),
            Some(0),
        )
        .await
        .expect("future transcript");
    repos
        .persist_persona_recognition(
            &note.id,
            session_id,
            &[PersonaClusterRecord {
                id: "future-cluster".to_string(),
                recording_session_id: session_id.to_string(),
                note_id: note.id.clone(),
                source: "system".to_string(),
                speaker_index: 0,
                anonymous_label: "Speaker 00".to_string(),
                model_id: PERSONA_MODEL_ID.to_string(),
                embedding: vec![0, 0, 128, 63],
                spans_json: "[[0,1000]]".to_string(),
                state: "suggested".to_string(),
                persona_id: Some(persona_id.clone()),
                confidence: Some(0.95),
            }],
        )
        .await
        .expect("suggestion");
    let suggested = repos.get_note(&note.id).await.expect("suggested note");
    assert!(suggested.participants.is_empty());
    assert_eq!(
        suggested.source_transcripts[0]
            .attribution
            .as_ref()
            .and_then(|value| value.candidate.as_ref())
            .map(|persona| persona.id.as_str()),
        Some(persona_id.as_str())
    );

    let confirmed = repos
        .confirm_persona_suggestion(&note.id, &transcript.id)
        .await
        .expect("confirm suggestion");
    assert_eq!(confirmed.participants[0].persona.id, persona_id);
    assert_eq!(
        confirmed.source_transcripts[0]
            .attribution
            .as_ref()
            .map(|value| value.state.as_str()),
        Some("confirmed")
    );
    let voiceprints = repos
        .persona_voiceprints_for_source("system", PERSONA_MODEL_ID, "third-session")
        .await
        .expect("confirmed voiceprints");
    assert!(voiceprints
        .iter()
        .all(|voiceprint| voiceprint.recognition_confirmed));
}

#[tokio::test]
async fn automatic_attribution_persists_and_rejection_enrolls_negative_feedback() {
    let repos = repos().await;
    let enrollment_note = repos.create_note(None).await.expect("enrollment note");
    let enrollment_session = "automatic-enrollment-session";
    let enrollment_audio =
        create_session_audio(&repos, &enrollment_note.id, enrollment_session).await;
    let enrollment_transcript = repos
        .create_source_transcript(
            &enrollment_note.id,
            enrollment_session,
            &enrollment_audio,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "Enrollment",
            Some("en".into()),
            "venice",
            Some(0),
            Some(1_000),
            Some(0),
        )
        .await
        .expect("enrollment transcript");
    repos
        .persist_persona_recognition(
            &enrollment_note.id,
            enrollment_session,
            &[PersonaClusterRecord {
                id: "automatic-enrollment-cluster".to_string(),
                recording_session_id: enrollment_session.to_string(),
                note_id: enrollment_note.id.clone(),
                source: "system".to_string(),
                speaker_index: 0,
                anonymous_label: "Speaker 00".to_string(),
                model_id: PERSONA_MODEL_ID.to_string(),
                embedding: vec![0, 0, 128, 63],
                spans_json: "[[0,1000]]".to_string(),
                state: "anonymous".to_string(),
                persona_id: None,
                confidence: None,
            }],
        )
        .await
        .expect("enrollment cluster");
    let enrolled = repos
        .assign_transcript_persona(
            &enrollment_note.id,
            &enrollment_transcript.id,
            "Jun",
            Some("Product lead"),
        )
        .await
        .expect("enroll Persona");
    let persona_id = enrolled.participants[0].persona.id.clone();

    let note = repos.create_note(None).await.expect("recognized note");
    let session_id = "automatic-recognition-session";
    let audio_id = create_session_audio(&repos, &note.id, session_id).await;
    let transcript = repos
        .create_source_transcript(
            &note.id,
            session_id,
            &audio_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "Recognized automatically",
            Some("en".into()),
            "venice",
            Some(0),
            Some(1_000),
            Some(0),
        )
        .await
        .expect("recognized transcript");
    repos
        .persist_persona_recognition(
            &note.id,
            session_id,
            &[PersonaClusterRecord {
                id: "automatic-recognition-cluster".to_string(),
                recording_session_id: session_id.to_string(),
                note_id: note.id.clone(),
                source: "system".to_string(),
                speaker_index: 0,
                anonymous_label: "Speaker 00".to_string(),
                model_id: PERSONA_MODEL_ID.to_string(),
                embedding: vec![0, 0, 128, 63],
                spans_json: "[[0,1000]]".to_string(),
                state: "automatic".to_string(),
                persona_id: Some(persona_id.clone()),
                confidence: Some(0.96),
            }],
        )
        .await
        .expect("automatic attribution");

    let automatic = repos.get_note(&note.id).await.expect("automatic note");
    assert_eq!(automatic.participants[0].provenance, "automatic");
    assert_eq!(automatic.participants[0].persona.id, persona_id);
    assert_eq!(
        automatic.source_transcripts[0]
            .attribution
            .as_ref()
            .map(|value| value.state.as_str()),
        Some("automatic")
    );

    let rejected = repos
        .reject_persona_attribution(&note.id, &transcript.id)
        .await
        .expect("reject attribution");
    assert!(rejected.participants.is_empty());
    assert!(rejected.source_transcripts[0].persona.is_none());
    assert_eq!(
        rejected.source_transcripts[0]
            .attribution
            .as_ref()
            .map(|value| value.state.as_str()),
        Some("anonymous")
    );
    let voiceprints = repos
        .persona_voiceprints_for_source("system", PERSONA_MODEL_ID, "later-session")
        .await
        .expect("feedback voiceprints");
    assert!(voiceprints
        .iter()
        .any(|voiceprint| voiceprint.persona_id == persona_id && voiceprint.kind == "negative"));
}

#[tokio::test]
async fn get_note_returns_failed_source_transcript_reason() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    let session_id = "session-1";
    repos
        .create_recording_session(
            &note.id,
            session_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "/tmp/system.partial.wav",
            "/tmp/system.wav",
            None,
        )
        .await
        .expect("session");
    let audio = repos
        .create_audio_artifact(&note.id, session_id, "/tmp/system.wav", 1200, 2048, "abc")
        .await
        .expect("artifact");

    repos
        .create_failed_source_transcript(
            &note.id,
            session_id,
            &audio.id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "venice",
            "System source was silent.",
            Some(1_000),
            Some(2_000),
            Some(0),
        )
        .await
        .expect("failed source transcript");

    let loaded = repos.get_note(&note.id).await.expect("loaded note");

    assert_eq!(loaded.source_transcripts.len(), 1);
    assert_eq!(
        loaded.source_transcripts[0].source.as_deref(),
        Some("system")
    );
    assert_eq!(loaded.source_transcripts[0].status, "failed");
    assert_eq!(
        loaded.source_transcripts[0].last_error.as_deref(),
        Some("System source was silent.")
    );
}

#[tokio::test]
async fn get_note_orders_source_transcripts_by_session_then_turn() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    let first_audio_id = create_session_audio(&repos, &note.id, "session-1").await;
    let second_audio_id = create_session_audio(&repos, &note.id, "session-2").await;

    repos
        .create_source_transcript(
            &note.id,
            "session-1",
            &first_audio_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "microphone",
            "First session second turn",
            Some("en".into()),
            "venice",
            Some(2_000),
            Some(3_000),
            Some(1),
        )
        .await
        .expect("first session second turn");
    repos
        .create_source_transcript(
            &note.id,
            "session-2",
            &second_audio_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "Second session first turn",
            Some("en".into()),
            "venice",
            Some(1_000),
            Some(2_000),
            Some(0),
        )
        .await
        .expect("second session first turn");
    repos
        .create_source_transcript(
            &note.id,
            "session-1",
            &first_audio_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "First session first turn",
            Some("en".into()),
            "venice",
            Some(500),
            Some(1_500),
            Some(0),
        )
        .await
        .expect("first session first turn");

    let loaded = repos.get_note(&note.id).await.expect("loaded note");

    assert_eq!(
        loaded
            .source_transcripts
            .iter()
            .map(|transcript| transcript.text.as_str())
            .collect::<Vec<_>>(),
        vec![
            "First session first turn",
            "First session second turn",
            "Second session first turn",
        ]
    );
}

#[tokio::test]
async fn successful_source_turns_for_session_exclude_failed_and_empty_rows() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    let audio_id = create_session_audio(&repos, &note.id, "session-1").await;

    repos
        .create_source_transcript(
            &note.id,
            "session-1",
            &audio_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "microphone",
            "Valid microphone turn",
            Some("en".into()),
            "venice",
            Some(1_000),
            Some(2_000),
            Some(0),
        )
        .await
        .expect("valid turn");
    repos
        .create_source_transcript(
            &note.id,
            "session-1",
            &audio_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "   ",
            Some("en".into()),
            "venice",
            Some(2_500),
            Some(3_000),
            Some(1),
        )
        .await
        .expect("empty turn");
    repos
        .create_failed_source_transcript(
            &note.id,
            "session-1",
            &audio_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "venice",
            "No speech detected.",
            Some(3_500),
            Some(4_000),
            Some(2),
        )
        .await
        .expect("failed turn");

    let transcripts = repos
        .successful_source_turn_transcripts_for_session("session-1")
        .await
        .expect("successful turns");

    assert_eq!(transcripts.len(), 1);
    assert_eq!(transcripts[0].text, "Valid microphone turn");
    assert_eq!(transcripts[0].turn_index, Some(0));
}

#[tokio::test]
async fn source_turn_upsert_replaces_failed_retry_with_success() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    let audio_id = create_session_audio(&repos, &note.id, "session-1").await;

    let failed = repos
        .upsert_failed_source_turn_transcript(
            &note.id,
            "session-1",
            &audio_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "venice",
            "No speech detected.",
            1_000,
            2_000,
            0,
        )
        .await
        .expect("failed upsert");
    let succeeded = repos
        .upsert_successful_source_turn_transcript(
            &note.id,
            "session-1",
            &audio_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "Recovered system turn",
            Some("en".into()),
            "venice",
            1_000,
            2_000,
            0,
        )
        .await
        .expect("success upsert");

    let loaded = repos.get_note(&note.id).await.expect("loaded note");

    assert_eq!(succeeded.id, failed.id);
    assert_eq!(loaded.source_transcripts.len(), 1);
    assert_eq!(loaded.source_transcripts[0].status, "succeeded");
    assert_eq!(loaded.source_transcripts[0].text, "Recovered system turn");
    assert_eq!(loaded.source_transcripts[0].last_error, None);
}

async fn create_session_audio(repos: &Repositories, note_id: &str, session_id: &str) -> String {
    let final_path = format!("/tmp/{session_id}.wav");
    repos
        .create_recording_session(
            note_id,
            session_id,
            RecordingSourceMode::MicrophonePlusSystem,
            &format!("/tmp/{session_id}.partial.wav"),
            &final_path,
            None,
        )
        .await
        .expect("session");
    repos
        .create_audio_artifact(note_id, session_id, &final_path, 1200, 2048, session_id)
        .await
        .expect("artifact")
        .id
}
