use os_june_lib::{
    db::{
        migrations::run_migrations,
        repositories::{PersonaClusterRecord, Repositories},
    },
    domain::types::{PersonaCommitmentDirection, RecordingSourceMode},
};
use sqlx::query::query;
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
async fn single_speaker_microphone_cluster_implicitly_enrolls_the_protected_self_voiceprint() {
    let repos = repos().await;
    let note = repos.create_note(None).await.expect("note");
    let session_id = format!("session-{}", uuid::Uuid::new_v4());
    repos
        .create_recording_session(
            &note.id,
            &session_id,
            RecordingSourceMode::MicrophoneOnly,
            "/tmp/self.partial.wav",
            "/tmp/self.wav",
            None,
        )
        .await
        .expect("session");
    let audio = repos
        .create_audio_artifact(
            &note.id,
            &session_id,
            "/tmp/self.wav",
            1_000,
            2_048,
            &session_id,
        )
        .await
        .expect("audio");
    let transcript = repos
        .create_source_transcript(
            &note.id,
            &session_id,
            &audio.id,
            RecordingSourceMode::MicrophoneOnly,
            "microphone",
            "My update",
            Some("en".into()),
            "venice",
            Some(0),
            Some(1_000),
            Some(0),
        )
        .await
        .expect("transcript");
    repos
        .persist_persona_recognition(
            &note.id,
            &session_id,
            &[PersonaClusterRecord {
                id: "self-cluster".into(),
                recording_session_id: session_id.clone(),
                note_id: note.id.clone(),
                source: "microphone".into(),
                speaker_index: 0,
                anonymous_label: "Speaker 00".into(),
                model_id: "sherpa-onnx-pyannote-3.0-wespeaker-voxceleb-resnet34".into(),
                embedding: vec![1, 2, 3, 4],
                spans_json: "[[0,1000]]".into(),
                state: "anonymous".into(),
                persona_id: None,
                confidence: None,
            }],
        )
        .await
        .expect("recognition");

    let proposed = repos.get_note(&note.id).await.expect("proposed note");
    assert!(proposed.participants.is_empty());
    let attribution = proposed.source_transcripts[0]
        .attribution
        .as_ref()
        .expect("self suggestion");
    assert_eq!(attribution.state, "suggested");
    assert_eq!(
        attribution.candidate.as_ref().expect("self candidate").name,
        "You"
    );
    let assigned = repos
        .confirm_persona_suggestion(&note.id, &transcript.id)
        .await
        .expect("confirm owner voice");
    let self_id = assigned.participants[0].persona.id.clone();
    assert_eq!(assigned.participants[0].persona.name, "You");
    let detail = repos.get_persona(&self_id).await.expect("self detail");
    assert!(detail.is_self);
    assert_eq!(detail.voiceprint_count, 1);
    let generation_result_id = repos
        .create_generation_result(
            &note.id,
            &transcript.id,
            "Generated owner note",
            None,
            "venice",
            "test",
        )
        .await
        .expect("owner generation");
    repos
        .set_generated_note_for_session(
            &note.id,
            Some(&session_id),
            Some(&generation_result_id),
            None,
            "Generated owner note".to_string(),
        )
        .await
        .expect("ready owner note");
    assert!(repos
        .get_persona(&self_id)
        .await
        .expect("self detail after generation")
        .dossier_jobs
        .is_empty());
    assert_eq!(
        repos
            .archive_persona(&self_id)
            .await
            .expect_err("protected")
            .code,
        "persona_self_protected"
    );

    let remote_note = repos.create_note(None).await.expect("remote note");
    let remote_session_id = format!("session-{}", uuid::Uuid::new_v4());
    repos
        .create_recording_session(
            &remote_note.id,
            &remote_session_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "/tmp/remote.partial.wav",
            "/tmp/remote.wav",
            None,
        )
        .await
        .expect("remote session");
    let remote_audio = repos
        .create_audio_artifact(
            &remote_note.id,
            &remote_session_id,
            "/tmp/remote.wav",
            1_000,
            2_048,
            &remote_session_id,
        )
        .await
        .expect("remote audio");
    let remote_turn = repos
        .create_source_transcript(
            &remote_note.id,
            &remote_session_id,
            &remote_audio.id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "Remote speech",
            Some("en".into()),
            "venice",
            Some(0),
            Some(1_000),
            Some(0),
        )
        .await
        .expect("remote transcript");
    repos
        .persist_persona_recognition(
            &remote_note.id,
            &remote_session_id,
            &[PersonaClusterRecord {
                id: "remote-cluster".into(),
                recording_session_id: remote_session_id.clone(),
                note_id: remote_note.id.clone(),
                source: "system".into(),
                speaker_index: 0,
                anonymous_label: "Speaker 00".into(),
                model_id: "test-model".into(),
                embedding: vec![4, 3, 2, 1],
                spans_json: "[[0,1000]]".into(),
                state: "anonymous".into(),
                persona_id: None,
                confidence: None,
            }],
        )
        .await
        .expect("remote recognition");
    assert_eq!(
        repos
            .assign_transcript_persona_with_options(
                &remote_note.id,
                &remote_turn.id,
                Some(&self_id),
                "You",
                None,
                false,
            )
            .await
            .expect_err("self cannot be assigned to System speech")
            .code,
        "persona_not_found"
    );
}

async fn create_persona(repos: &Repositories, name: &str) -> (String, String) {
    let note = repos.create_note(None).await.expect("note");
    let session_id = format!("session-{}", uuid::Uuid::new_v4());
    repos
        .create_recording_session(
            &note.id,
            &session_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "/tmp/persona.partial.wav",
            "/tmp/persona.wav",
            None,
        )
        .await
        .expect("session");
    let audio = repos
        .create_audio_artifact(
            &note.id,
            &session_id,
            "/tmp/persona.wav",
            1_000,
            2_048,
            &session_id,
        )
        .await
        .expect("audio");
    let transcript = repos
        .create_source_transcript(
            &note.id,
            &session_id,
            &audio.id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "Hello",
            Some("en".into()),
            "venice",
            Some(0),
            Some(1_000),
            Some(0),
        )
        .await
        .expect("transcript");
    let assigned = repos
        .assign_transcript_persona(&note.id, &transcript.id, name, Some("Colleague"))
        .await
        .expect("assign");
    (assigned.participants[0].persona.id.clone(), note.id)
}

async fn create_detected_session(
    repos: &Repositories,
    name: &str,
    existing_persona_id: Option<&str>,
    bundle_ids_json: &str,
    weekday: i64,
    bucket: i64,
) -> (String, String, String) {
    let note = repos.create_note(None).await.expect("note");
    let session_id = format!("session-{}", uuid::Uuid::new_v4());
    repos
        .create_recording_session(
            &note.id,
            &session_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "/tmp/detected.partial.wav",
            "/tmp/detected.wav",
            None,
        )
        .await
        .expect("session");
    repos
        .attach_detection_context(
            &session_id,
            &format!("episode-{session_id}"),
            bundle_ids_json,
            weekday,
            bucket,
        )
        .await
        .expect("detection context");
    let audio = repos
        .create_audio_artifact(
            &note.id,
            &session_id,
            "/tmp/detected.wav",
            1_000,
            2_048,
            &session_id,
        )
        .await
        .expect("audio");
    let transcript = repos
        .create_source_transcript(
            &note.id,
            &session_id,
            &audio.id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "Hello again",
            Some("en".into()),
            "venice",
            Some(0),
            Some(1_000),
            Some(0),
        )
        .await
        .expect("transcript");
    let assigned = repos
        .assign_transcript_persona_with_id(
            &note.id,
            &transcript.id,
            existing_persona_id,
            name,
            Some("Colleague"),
        )
        .await
        .expect("assign");
    repos
        .update_recording_session(
            &session_id,
            "valid",
            1_000,
            Some(2_048),
            Some(1_000),
            Some("checksum".into()),
            Some(0.5),
            Some(0.2),
            None,
            None,
        )
        .await
        .expect("valid session");
    (
        assigned.participants[0].persona.id.clone(),
        note.id,
        session_id,
    )
}

#[tokio::test]
async fn persona_lifecycle_preserves_memory_while_archived() {
    let repos = repos().await;
    let (persona_id, _note_id) = create_persona(&repos, "Jun").await;

    let updated = repos
        .update_persona(
            &persona_id,
            "June",
            Some("Product lead"),
            "Prefers concise updates.",
        )
        .await
        .expect("update");
    assert_eq!(updated.name, "June");
    assert_eq!(updated.dossier, "Prefers concise updates.");

    repos.archive_persona(&persona_id).await.expect("archive");
    assert!(repos
        .list_personas("active", None)
        .await
        .expect("active")
        .is_empty());
    let archived = repos
        .list_personas("archived", Some("june"))
        .await
        .expect("archived");
    assert_eq!(archived.len(), 1);
    assert_eq!(
        repos
            .get_persona(&persona_id)
            .await
            .expect("detail")
            .dossier,
        "Prefers concise updates."
    );

    repos.restore_persona(&persona_id).await.expect("restore");
    assert_eq!(
        repos
            .list_personas("active", None)
            .await
            .expect("active")
            .len(),
        1
    );
}

#[tokio::test]
async fn deleting_then_scrubbing_a_persona_keeps_only_the_anonymous_label() {
    let repos = repos().await;
    let (persona_id, note_id) = create_persona(&repos, "Jun").await;

    let receipt = repos.delete_persona(&persona_id).await.expect("delete");
    assert_eq!(receipt.affected_note_ids, vec![note_id.clone()]);
    assert_eq!(receipt.affected_transcript_count, 1);
    let frozen = repos.get_note(&note_id).await.expect("frozen note");
    assert_eq!(
        frozen.source_transcripts[0]
            .attribution
            .as_ref()
            .map(|value| (value.state.as_str(), value.speaker_label.as_str())),
        Some(("frozen", "Jun"))
    );

    repos
        .scrub_deleted_persona_from_notes(&receipt.deletion_batch_id)
        .await
        .expect("scrub");
    let scrubbed = repos.get_note(&note_id).await.expect("scrubbed note");
    assert_eq!(
        scrubbed.source_transcripts[0]
            .attribution
            .as_ref()
            .map(|value| (value.state.as_str(), value.speaker_label.as_str())),
        Some(("anonymous", "System"))
    );
}

#[tokio::test]
async fn commitments_round_trip_with_wire_direction() {
    let repos = repos().await;
    let (persona_id, note_id) = create_persona(&repos, "Jun").await;

    let created = repos
        .create_persona_commitment(
            &persona_id,
            PersonaCommitmentDirection::PersonaOwesUser,
            "Send the draft",
            Some("Friday"),
            Some(&note_id),
        )
        .await
        .expect("create commitment");
    assert_eq!(
        created.direction,
        PersonaCommitmentDirection::PersonaOwesUser
    );

    let updated = repos
        .update_persona_commitment(
            &created.id,
            PersonaCommitmentDirection::UserOwesPersona,
            "Review the draft",
            None,
            "done",
        )
        .await
        .expect("update commitment");
    assert_eq!(updated.status, "done");
    assert_eq!(
        updated.direction,
        PersonaCommitmentDirection::UserOwesPersona
    );

    repos
        .delete_persona_commitment(&created.id)
        .await
        .expect("delete commitment");
    assert!(repos
        .get_persona(&persona_id)
        .await
        .expect("detail")
        .commitments
        .is_empty());
}

#[tokio::test]
async fn a_ready_generation_enqueues_one_idempotent_dossier_job_per_participant() {
    let repos = repos().await;
    let (persona_id, note_id) = create_persona(&repos, "Jun").await;
    let note = repos.get_note(&note_id).await.expect("note");
    let transcript_id = note.source_transcripts[0].id.clone();
    let generation_result_id = repos
        .create_generation_result(
            &note_id,
            &transcript_id,
            "Generated note",
            None,
            "venice",
            "test",
        )
        .await
        .expect("generation result");

    repos
        .set_generated_note_for_session(
            &note_id,
            None,
            Some(&generation_result_id),
            None,
            "Generated note".to_string(),
        )
        .await
        .expect("ready note");
    assert_eq!(
        repos
            .get_persona(&persona_id)
            .await
            .expect("detail")
            .dossier_jobs
            .len(),
        1
    );
    assert_eq!(
        repos
            .enqueue_dossier_jobs_for_generation(&generation_result_id)
            .await
            .expect("idempotent enqueue"),
        0
    );
    let replay_generation_id = repos
        .create_generation_result(
            &note_id,
            &transcript_id,
            "Regenerated note",
            None,
            "venice",
            "test",
        )
        .await
        .expect("replay generation");
    assert_eq!(
        repos
            .enqueue_dossier_jobs_for_generation(&replay_generation_id)
            .await
            .expect("stable recording idempotency"),
        0
    );
}

#[tokio::test]
async fn notes_created_before_persona_memory_enablement_are_not_retro_processed() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("sqlite memory");
    run_migrations(&pool).await.expect("migrations");
    let repos = Repositories::new(pool.clone());
    let (persona_id, note_id) = create_persona(&repos, "Historical").await;
    let note = repos.get_note(&note_id).await.expect("note");
    let generation_result_id = repos
        .create_generation_result(
            &note_id,
            &note.source_transcripts[0].id,
            "Historical generated note",
            None,
            "venice",
            "test",
        )
        .await
        .expect("generation result");
    query(
        "UPDATE persona_feature_state
         SET enabled_at = '9999-12-31T23:59:59.999Z'
         WHERE feature = 'persona_memory'",
    )
    .execute(&pool)
    .await
    .expect("move feature watermark");

    assert_eq!(
        repos
            .enqueue_dossier_jobs_for_generation(&generation_result_id)
            .await
            .expect("historical enqueue"),
        0
    );
    assert!(repos
        .get_persona(&persona_id)
        .await
        .expect("detail")
        .dossier_jobs
        .is_empty());
}

#[tokio::test]
async fn dossier_enqueue_is_scoped_to_the_generation_recording_session() {
    let repos = repos().await;
    let (first_persona_id, note_id) = create_persona(&repos, "First").await;
    let second_session_id = format!("session-{}", uuid::Uuid::new_v4());
    repos
        .create_recording_session(
            &note_id,
            &second_session_id,
            RecordingSourceMode::MicrophonePlusSystem,
            "/tmp/second.partial.wav",
            "/tmp/second.wav",
            None,
        )
        .await
        .expect("second session");
    let audio = repos
        .create_audio_artifact(
            &note_id,
            &second_session_id,
            "/tmp/second.wav",
            1_000,
            2_048,
            &second_session_id,
        )
        .await
        .expect("second audio");
    let transcript = repos
        .create_source_transcript(
            &note_id,
            &second_session_id,
            &audio.id,
            RecordingSourceMode::MicrophonePlusSystem,
            "system",
            "Second meeting only",
            Some("en".into()),
            "venice",
            Some(0),
            Some(1_000),
            Some(0),
        )
        .await
        .expect("second transcript");
    let assigned = repos
        .assign_transcript_persona(&note_id, &transcript.id, "Second", Some("Customer"))
        .await
        .expect("second assignment");
    let second_persona_id = assigned
        .participants
        .iter()
        .find(|participant| participant.persona.name == "Second")
        .expect("second participant")
        .persona
        .id
        .clone();
    let generation_result_id = repos
        .create_generation_result(
            &note_id,
            &transcript.id,
            "Second generated note",
            None,
            "venice",
            "test",
        )
        .await
        .expect("generation result");

    repos
        .set_generated_note_for_session(
            &note_id,
            Some(&second_session_id),
            Some(&generation_result_id),
            None,
            "Second generated note".to_string(),
        )
        .await
        .expect("ready second meeting");

    assert!(repos
        .get_persona(&first_persona_id)
        .await
        .expect("first detail")
        .dossier_jobs
        .is_empty());
    assert_eq!(
        repos
            .get_persona(&second_persona_id)
            .await
            .expect("second detail")
            .dossier_jobs
            .len(),
        1
    );
}

#[tokio::test]
async fn recurring_detection_requires_two_matching_sessions_and_dedupes_the_offer_episode() {
    let repos = repos().await;
    let bundle_key = r#"["us.zoom.xos"]"#;
    let (persona_id, _, _) = create_detected_session(&repos, "Jun", None, bundle_key, 3, 18).await;

    assert!(repos
        .recurring_persona_candidates(bundle_key, 3, 18)
        .await
        .expect("one prior session")
        .is_empty());

    create_detected_session(&repos, "Jun", Some(&persona_id), bundle_key, 3, 19).await;
    assert_eq!(
        repos
            .recurring_persona_candidates(bundle_key, 3, 18)
            .await
            .expect("recurring candidates"),
        vec![persona_id.clone()]
    );

    assert!(repos
        .record_prep_offer(
            "episode-current",
            bundle_key,
            std::slice::from_ref(&persona_id)
        )
        .await
        .expect("first offer"));
    assert!(!repos
        .record_prep_offer(
            "episode-current",
            bundle_key,
            std::slice::from_ref(&persona_id)
        )
        .await
        .expect("duplicate offer"));
    assert!(repos
        .claim_prep_offer("episode-current")
        .await
        .expect("claim offer"));
    assert!(!repos
        .claim_prep_offer("episode-current")
        .await
        .expect("duplicate claim"));
    assert_eq!(
        repos
            .requeue_interrupted_prep_offers()
            .await
            .expect("requeue interrupted prep"),
        1
    );
    assert!(repos
        .claim_prep_offer("episode-current")
        .await
        .expect("reclaim offer after restart"));
    let prep_note = repos
        .complete_prep_offer_with_note("episode-current", "Prep", "Brief")
        .await
        .expect("complete offer");
    assert_eq!(
        repos
            .accepted_prep_note_id("episode-current")
            .await
            .expect("accepted note"),
        Some(prep_note.id)
    );
}
