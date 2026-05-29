use os_scribe_lib::domain::processing::{
    build_dictionary_context, build_transcription_context, coalesce_source_transcripts,
    labeled_transcript_from_sources, merge_transcription_context, valid_sources_for_processing,
    SourceTranscriptInput,
};
use os_scribe_lib::domain::types::DictionaryEntryDto;

#[test]
fn labeled_transcript_keeps_microphone_and_system_sections() {
    let transcript = labeled_transcript_from_sources(&[
        SourceTranscriptInput {
            source: "microphone".to_string(),
            text: "My action item is to follow up.".to_string(),
            valid: true,
            warning: None,
            start_ms: Some(2_000),
            end_ms: Some(3_000),
            turn_index: Some(1),
        },
        SourceTranscriptInput {
            source: "system".to_string(),
            text: "The deadline is Friday.".to_string(),
            valid: true,
            warning: None,
            start_ms: Some(1_000),
            end_ms: Some(1_800),
            turn_index: Some(0),
        },
    ]);

    assert_eq!(
        transcript,
        "System: The deadline is Friday.\nMicrophone: My action item is to follow up."
    );
}

#[test]
fn processing_uses_only_valid_source_transcripts() {
    let sources = valid_sources_for_processing(vec![
        SourceTranscriptInput {
            source: "microphone".to_string(),
            text: "valid mic text".to_string(),
            valid: true,
            warning: None,
            start_ms: None,
            end_ms: None,
            turn_index: None,
        },
        SourceTranscriptInput {
            source: "system".to_string(),
            text: "invalid system text".to_string(),
            valid: false,
            warning: Some("System audio was silent.".to_string()),
            start_ms: None,
            end_ms: None,
            turn_index: None,
        },
    ]);

    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].source, "microphone");
}

#[test]
fn coalesces_consecutive_same_source_transcripts_for_display() {
    let sources = coalesce_source_transcripts(vec![
        SourceTranscriptInput {
            source: "system".to_string(),
            text: "First part.".to_string(),
            valid: true,
            warning: None,
            start_ms: Some(1_000),
            end_ms: Some(3_000),
            turn_index: Some(0),
        },
        SourceTranscriptInput {
            source: "system".to_string(),
            text: "Second part.".to_string(),
            valid: true,
            warning: None,
            start_ms: Some(4_000),
            end_ms: Some(5_000),
            turn_index: Some(1),
        },
        SourceTranscriptInput {
            source: "microphone".to_string(),
            text: "Reply.".to_string(),
            valid: true,
            warning: None,
            start_ms: Some(7_000),
            end_ms: Some(8_000),
            turn_index: Some(2),
        },
    ]);

    assert_eq!(sources.len(), 2);
    assert_eq!(sources[0].source, "system");
    assert_eq!(sources[0].text, "First part. Second part.");
    assert_eq!(sources[0].start_ms, Some(1_000));
    assert_eq!(sources[0].end_ms, Some(5_000));
    assert_eq!(sources[0].turn_index, Some(0));
    assert_eq!(sources[1].turn_index, Some(1));
}

#[test]
fn builds_transcription_context_from_previous_turns() {
    let context = build_transcription_context(&[
        SourceTranscriptInput {
            source: "system".to_string(),
            text: "No, al final lo puedes hacer con Planeta Azul.".to_string(),
            valid: true,
            warning: None,
            start_ms: Some(1_000),
            end_ms: Some(5_000),
            turn_index: Some(0),
        },
        SourceTranscriptInput {
            source: "microphone".to_string(),
            text: "Con Planeta Magic.".to_string(),
            valid: true,
            warning: None,
            start_ms: Some(6_000),
            end_ms: Some(7_000),
            turn_index: Some(1),
        },
    ])
    .expect("context should be built");

    assert!(context.contains("Previous transcript context"));
    assert!(context.contains("System: No, al final"));
    assert!(context.contains("Microphone: Con Planeta Magic."));
    assert!(context.contains("Preserve the spoken language"));
}

#[test]
fn builds_dictionary_context_from_custom_terms() {
    let context = build_dictionary_context(&[DictionaryEntryDto {
        id: "entry-1".to_string(),
        phrase: "Junho Hong".to_string(),
        created_at: "2026-05-26T00:00:00Z".to_string(),
        updated_at: "2026-05-26T00:00:00Z".to_string(),
    }])
    .expect("dictionary context should be built");

    assert!(context.contains("Custom dictionary terms"));
    assert!(context.contains("Junho Hong"));
    assert!(context.contains("exact spelling and capitalization"));
}

#[test]
fn merges_dictionary_and_previous_transcription_context() {
    let merged = merge_transcription_context(
        Some("Custom dictionary terms:\n- OSS"),
        Some("Previous transcript context:\nMicrophone: OSS"),
    )
    .expect("merged context");

    assert!(merged.contains("Custom dictionary terms"));
    assert!(merged.contains("Previous transcript context"));
}
