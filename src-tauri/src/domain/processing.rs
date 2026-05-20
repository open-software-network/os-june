use crate::{
    db::repositories::Repositories,
    domain::types::{AppError, NoteDto, ProcessingStatus, RecordingSourceMode},
    providers::{
        generation::{generate_note_from_transcript, GenerationRequest},
        transcription::{transcribe_saved_audio, TranscriptionRequest},
    },
};
use std::path::PathBuf;

pub const PROMPT_VERSION: &str = "notes-mvp-v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceTranscriptInput {
    pub source: String,
    pub text: String,
    pub valid: bool,
    pub warning: Option<String>,
}

pub fn valid_sources_for_processing(
    sources: Vec<SourceTranscriptInput>,
) -> Vec<SourceTranscriptInput> {
    sources
        .into_iter()
        .filter(|source| source.valid && !source.text.trim().is_empty())
        .collect()
}

pub fn labeled_transcript_from_sources(sources: &[SourceTranscriptInput]) -> String {
    sources
        .iter()
        .filter(|source| source.valid && !source.text.trim().is_empty())
        .map(|source| {
            let label = match source.source.as_str() {
                "system" => "System audio",
                _ => "Microphone",
            };
            format!("## {label}\n{}", source.text.trim())
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub async fn process_saved_audio(
    repos: &Repositories,
    note_id: &str,
    audio_artifact_id: &str,
    audio_path: PathBuf,
    title: String,
) -> Result<NoteDto, AppError> {
    repos
        .set_note_status(note_id, ProcessingStatus::Transcribing, None)
        .await?;
    let provider = crate::providers::configured_provider();
    let transcript = match transcribe_saved_audio(TranscriptionRequest {
        provider: provider.clone(),
        audio_path,
        title: title.clone(),
    })
    .await
    {
        Ok(transcript) => transcript,
        Err(error) => {
            repos
                .set_note_status(
                    note_id,
                    ProcessingStatus::Failed,
                    Some(error.message.clone()),
                )
                .await?;
            return Err(error);
        }
    };
    let transcript_row = repos
        .create_transcript(
            note_id,
            audio_artifact_id,
            &transcript.text,
            transcript.language.clone(),
            &transcript.provider,
        )
        .await?;

    repos
        .set_note_status(note_id, ProcessingStatus::Generating, None)
        .await?;
    let generated = match generate_note_from_transcript(GenerationRequest {
        provider,
        title,
        transcript: transcript.text,
        language: transcript.language,
    })
    .await
    {
        Ok(generated) => generated,
        Err(error) => {
            repos
                .set_note_status(
                    note_id,
                    ProcessingStatus::Failed,
                    Some(error.message.clone()),
                )
                .await?;
            return Err(error);
        }
    };
    repos
        .create_generation_result(
            note_id,
            &transcript_row.id,
            &generated.content,
            generated.title_suggestion.clone(),
            &generated.provider,
            &generated.prompt_version,
        )
        .await?;
    Ok(repos
        .set_generated_note(note_id, generated.title_suggestion, generated.content)
        .await?)
}

pub async fn process_saved_source_audio(
    repos: &Repositories,
    note_id: &str,
    session_id: &str,
    source_mode: RecordingSourceMode,
    sources: Vec<(String, String, PathBuf)>,
    title: String,
) -> Result<NoteDto, AppError> {
    repos
        .set_note_status(note_id, ProcessingStatus::Transcribing, None)
        .await?;
    let provider = crate::providers::configured_provider();
    let mut transcript_inputs = Vec::new();
    let mut first_transcript_id = None;
    for (artifact_id, source, audio_path) in sources {
        let transcript = match transcribe_saved_audio(TranscriptionRequest {
            provider: provider.clone(),
            audio_path,
            title: title.clone(),
        })
        .await
        {
            Ok(transcript) => transcript,
            Err(error) => {
                transcript_inputs.push(SourceTranscriptInput {
                    source,
                    text: String::new(),
                    valid: false,
                    warning: Some(error.message),
                });
                continue;
            }
        };
        let row = repos
            .create_source_transcript(
                note_id,
                session_id,
                &artifact_id,
                source_mode,
                &source,
                &transcript.text,
                transcript.language.clone(),
                &transcript.provider,
            )
            .await?;
        if first_transcript_id.is_none() {
            first_transcript_id = Some(row.id);
        }
        transcript_inputs.push(SourceTranscriptInput {
            source,
            text: transcript.text,
            valid: true,
            warning: None,
        });
    }

    let valid_sources = valid_sources_for_processing(transcript_inputs);
    if valid_sources.is_empty() {
        repos
            .set_note_status(
                note_id,
                ProcessingStatus::Failed,
                Some("No selected source produced a usable transcript.".to_string()),
            )
            .await?;
        return Err(AppError::new(
            "transcription_failed",
            "No selected source produced a usable transcript.",
        ));
    }
    let labeled_transcript = labeled_transcript_from_sources(&valid_sources);
    repos
        .set_note_status(note_id, ProcessingStatus::Generating, None)
        .await?;
    let generated = match generate_note_from_transcript(GenerationRequest {
        provider,
        title,
        transcript: labeled_transcript,
        language: None,
    })
    .await
    {
        Ok(generated) => generated,
        Err(error) => {
            repos
                .set_note_status(
                    note_id,
                    ProcessingStatus::Failed,
                    Some(error.message.clone()),
                )
                .await?;
            return Err(error);
        }
    };
    let transcript_id = first_transcript_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    repos
        .create_generation_result(
            note_id,
            &transcript_id,
            &generated.content,
            generated.title_suggestion.clone(),
            &generated.provider,
            &generated.prompt_version,
        )
        .await?;
    Ok(repos
        .set_generated_note(note_id, generated.title_suggestion, generated.content)
        .await?)
}

pub async fn retry_from_saved_audio(
    repos: &Repositories,
    note_id: &str,
) -> Result<NoteDto, AppError> {
    let sources = repos.latest_valid_audio_artifact_paths(note_id).await?;
    if sources.is_empty() {
        return Err(AppError::new(
            "audio_artifact_missing",
            "No saved audio is available for retry.",
        ));
    }
    let note = repos.get_note(note_id).await?;
    if sources.len() == 1 {
        let (audio_artifact_id, _source, audio_path) = sources[0].clone();
        return process_saved_audio(
            repos,
            note_id,
            &audio_artifact_id,
            PathBuf::from(audio_path),
            note.title,
        )
        .await;
    }
    process_saved_source_audio(
        repos,
        note_id,
        "",
        RecordingSourceMode::MicrophonePlusSystem,
        sources
            .into_iter()
            .map(|(id, source, path)| (id, source, PathBuf::from(path)))
            .collect(),
        note.title,
    )
    .await
}
