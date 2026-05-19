use crate::{
    db::repositories::Repositories,
    domain::types::{AppError, NoteDto, ProcessingStatus},
    providers::{
        generation::{generate_note_from_transcript, GenerationRequest},
        transcription::{transcribe_saved_audio, TranscriptionRequest},
    },
};
use std::path::PathBuf;

pub const PROMPT_VERSION: &str = "notes-mvp-v1";

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

pub async fn retry_from_saved_audio(
    repos: &Repositories,
    note_id: &str,
) -> Result<NoteDto, AppError> {
    let Some((audio_artifact_id, audio_path)) = repos.latest_audio_artifact_path(note_id).await?
    else {
        return Err(AppError::new(
            "audio_artifact_missing",
            "No saved audio is available for retry.",
        ));
    };
    let note = repos.get_note(note_id).await?;
    process_saved_audio(
        repos,
        note_id,
        &audio_artifact_id,
        PathBuf::from(audio_path),
        note.title,
    )
    .await
}
