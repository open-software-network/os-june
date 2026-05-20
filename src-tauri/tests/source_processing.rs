use os_notetaker_lib::domain::processing::{
    labeled_transcript_from_sources, valid_sources_for_processing, SourceTranscriptInput,
};

#[test]
fn labeled_transcript_keeps_microphone_and_system_sections() {
    let transcript = labeled_transcript_from_sources(&[
        SourceTranscriptInput {
            source: "microphone".to_string(),
            text: "My action item is to follow up.".to_string(),
            valid: true,
            warning: None,
        },
        SourceTranscriptInput {
            source: "system".to_string(),
            text: "The deadline is Friday.".to_string(),
            valid: true,
            warning: None,
        },
    ]);

    assert!(transcript.contains("## Microphone"));
    assert!(transcript.contains("My action item is to follow up."));
    assert!(transcript.contains("## System audio"));
    assert!(transcript.contains("The deadline is Friday."));
}

#[test]
fn processing_uses_only_valid_source_transcripts() {
    let sources = valid_sources_for_processing(vec![
        SourceTranscriptInput {
            source: "microphone".to_string(),
            text: "valid mic text".to_string(),
            valid: true,
            warning: None,
        },
        SourceTranscriptInput {
            source: "system".to_string(),
            text: "invalid system text".to_string(),
            valid: false,
            warning: Some("System audio was silent.".to_string()),
        },
    ]);

    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].source, "microphone");
}
