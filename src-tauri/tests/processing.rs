use os_notetaker_lib::{
    domain::{
        processing::manual_notes_for_generation,
        types::{NoteDto, ProcessingStatus},
    },
    providers::{
        generation::{generate_note_from_transcript, GenerationRequest},
        transcription::{
            normalize_transcription_language, transcribe_saved_audio, transcription_audio_mime,
            TranscriptionRequest,
        },
    },
};
use tempfile::NamedTempFile;

const NOW: &str = "2026-05-21T10:00:00Z";

fn note(overrides: impl FnOnce(&mut NoteDto)) -> NoteDto {
    let mut note = NoteDto {
        id: "note-1".to_string(),
        title: "Note".to_string(),
        preview: String::new(),
        processing_status: ProcessingStatus::Ready,
        folder_ids: Vec::new(),
        created_at: NOW.to_string(),
        updated_at: NOW.to_string(),
        duration_ms: None,
        generated_content: None,
        edited_content: None,
        transcript: None,
        source_transcripts: Vec::new(),
        recording: None,
        audio: None,
        audio_sources: Vec::new(),
        active_tab: Some("notes".to_string()),
        last_error: None,
    };
    overrides(&mut note);
    note
}

#[tokio::test]
async fn venice_transcription_fails_for_missing_audio() {
    let err = transcribe_saved_audio(TranscriptionRequest {
        provider: "venice".to_string(),
        audio_path: "/tmp/os-notetaker-missing.wav".into(),
        title: "Missing".to_string(),
        context: None,
    })
    .await
    .expect_err("missing audio should fail");

    assert_eq!(err.code, "audio_artifact_missing");
}

#[tokio::test]
async fn mock_transcription_provider_is_rejected() {
    let file = NamedTempFile::new().expect("temp audio");
    std::fs::write(file.path(), b"audio").expect("audio bytes");

    let err = transcribe_saved_audio(TranscriptionRequest {
        provider: "mock".to_string(),
        audio_path: file.path().to_path_buf(),
        title: "Planning note".to_string(),
        context: None,
    })
    .await
    .expect_err("mock provider should be rejected");

    assert_eq!(err.code, "provider_not_configured");
}

#[tokio::test]
async fn mock_generation_provider_is_rejected() {
    let err = generate_note_from_transcript(GenerationRequest {
        provider: "mock".to_string(),
        title: "Meeting notes".to_string(),
        existing_generated_note: Some("Existing generated note".to_string()),
        transcript: "System: The launch deadline is Friday.".to_string(),
        manual_notes: Some("Ask Marta about the release checklist.".to_string()),
        language: Some("en".to_string()),
    })
    .await
    .expect_err("mock provider should be rejected");

    assert_eq!(err.code, "provider_not_configured");
}

#[test]
fn manual_notes_for_generation_uses_only_new_text_after_generated_note() {
    let note = note(|note| {
        note.generated_content = Some("First generated note".to_string());
        note.edited_content =
            Some("First generated note\n\nManual note for the next recording".to_string());
    });

    assert_eq!(
        manual_notes_for_generation(&note).as_deref(),
        Some("Manual note for the next recording")
    );
}

#[test]
fn manual_notes_for_generation_ignores_existing_edited_note_body() {
    let note = note(|note| {
        note.generated_content = Some("First generated note".to_string());
        note.edited_content = Some("Edited version of the first generated note".to_string());
    });

    assert_eq!(manual_notes_for_generation(&note), None);
}

#[test]
fn manual_notes_for_generation_uses_new_tail_after_manual_preface() {
    let note = note(|note| {
        note.generated_content = Some("- Generated transcript note".to_string());
        note.edited_content = Some("Test 1:\n\n- Generated transcript note\n\nTest 2".to_string());
    });

    assert_eq!(
        manual_notes_for_generation(&note).as_deref(),
        Some("Test 2")
    );
}

#[tokio::test]
async fn generation_rejects_empty_transcript() {
    let err = generate_note_from_transcript(GenerationRequest {
        provider: "venice".to_string(),
        title: "Empty".to_string(),
        existing_generated_note: None,
        transcript: "   ".to_string(),
        manual_notes: None,
        language: None,
    })
    .await
    .expect_err("empty transcript should fail");

    assert_eq!(err.code, "transcription_empty");
}

#[test]
fn transcription_language_override_accepts_iso_639_1_codes() {
    assert_eq!(
        normalize_transcription_language(" es "),
        Some("es".to_string())
    );
    assert_eq!(
        normalize_transcription_language("EN"),
        Some("en".to_string())
    );
}

#[test]
fn transcription_language_override_rejects_invalid_values() {
    assert_eq!(normalize_transcription_language(""), None);
    assert_eq!(normalize_transcription_language("spanish"), None);
    assert_eq!(normalize_transcription_language("es-ES"), None);
}

#[test]
fn transcription_audio_mime_uses_file_extension() {
    assert_eq!(
        transcription_audio_mime("recording.wav".as_ref()),
        "audio/wav"
    );
    assert_eq!(
        transcription_audio_mime("dictation.m4a".as_ref()),
        "audio/mp4"
    );
    assert_eq!(
        transcription_audio_mime("dictation.MP4".as_ref()),
        "audio/mp4"
    );
}
