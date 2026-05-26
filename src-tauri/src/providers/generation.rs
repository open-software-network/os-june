use crate::{domain::processing::PROMPT_VERSION, domain::types::AppError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const DEFAULT_GENERATION_PROVIDER: &str = crate::providers::VENICE_PROVIDER;
const INCREMENTAL_NOTE_INSTRUCTIONS: &str = "You write one incremental markdown note block from a newly captured transcript. Use only the new transcript plus optional new manual notes. Existing generated note content is context only: do not repeat, summarize, rewrite, or reformat it. Manual notes are context only unless they add facts; do not output manual note labels as headings, bullets, titles, or section names. Do not add wrapper headings such as Note, Generated note, Transcript, or Summary. Preserve the speaker's language unless the source material is mixed-language. Return only the new note block to append.";

#[derive(Debug, Clone)]
pub struct GenerationRequest {
    pub provider: String,
    pub title: String,
    pub existing_generated_note: Option<String>,
    pub transcript: String,
    pub manual_notes: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GenerationProviderResult {
    pub content: String,
    pub title_suggestion: Option<String>,
    pub provider: String,
    pub prompt_version: String,
}

pub async fn generate_note_from_transcript(
    request: GenerationRequest,
) -> Result<GenerationProviderResult, AppError> {
    let transcript = request.transcript.trim();
    if transcript.is_empty() {
        return Err(AppError::new(
            "transcription_empty",
            "Transcript is empty, so a note cannot be generated.",
        ));
    }

    match request.provider.as_str() {
        crate::providers::VENICE_PROVIDER => generate_with_venice(&request, transcript).await,
        _ => Err(AppError::new(
            "provider_not_configured",
            "Unsupported generation provider. Venice is the only supported provider; set VENICE_API_KEY.",
        )),
    }
}

async fn generate_with_venice(
    request: &GenerationRequest,
    transcript: &str,
) -> Result<GenerationProviderResult, AppError> {
    let api_key = crate::providers::venice_api_key().ok_or_else(|| {
        AppError::new(
            "provider_not_configured",
            "VENICE_API_KEY is required for Venice note generation.",
        )
    })?;
    let model = crate::providers::venice_generation_model();
    let title_hint = request.title.trim();
    let source_text = generation_source_text(
        request.existing_generated_note.as_deref(),
        request.manual_notes.as_deref(),
        transcript,
    );
    let body = json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": INCREMENTAL_NOTE_INSTRUCTIONS,
            },
            {
                "role": "user",
                "content": format!(
                    "Current title: {}\nDetected language: {}\n\n{}",
                    if title_hint.is_empty() { "New note" } else { title_hint },
                    request.language.as_deref().unwrap_or("unknown"),
                    source_text
                ),
            }
        ],
    });
    let response = reqwest::Client::new()
        .post(format!(
            "{}/chat/completions",
            crate::providers::venice_api_base_url()
        ))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| AppError::new("provider_request_failed", error.to_string()))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| AppError::new("provider_request_failed", error.to_string()))?;
    if !status.is_success() {
        return Err(AppError::new(
            "provider_request_failed",
            format!("Venice generation failed with status {status}: {body}"),
        ));
    }
    let parsed: Value = serde_json::from_str(&body)
        .map_err(|error| AppError::new("provider_response_invalid", error.to_string()))?;
    let content = extract_chat_completion_text(&parsed).ok_or_else(|| {
        AppError::new(
            "provider_response_invalid",
            "Venice generation response did not contain text output.",
        )
    })?;
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err(AppError::new(
            "generation_empty",
            "Venice returned an empty generated note.",
        ));
    }
    Ok(GenerationProviderResult {
        content,
        title_suggestion: if title_hint.is_empty() {
            Some("New note".to_string())
        } else {
            Some(title_hint.to_string())
        },
        provider: crate::providers::VENICE_PROVIDER.to_string(),
        prompt_version: PROMPT_VERSION.to_string(),
    })
}

fn generation_source_text(
    existing_generated_note: Option<&str>,
    manual_notes: Option<&str>,
    transcript: &str,
) -> String {
    let transcript = transcript.trim();
    let existing_generated_note = existing_generated_note
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let manual_notes = manual_notes
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut sections = Vec::new();
    if let Some(existing_generated_note) = existing_generated_note {
        sections.push(format!(
            "<existing_generated_note_context>\n{existing_generated_note}\n</existing_generated_note_context>"
        ));
    }
    if let Some(manual_notes) = manual_notes {
        sections.push(format!(
            "<new_manual_notes_context>\n{manual_notes}\n</new_manual_notes_context>"
        ));
    }
    sections.push(format!("<new_transcript>\n{transcript}\n</new_transcript>"));
    sections.push(
        "<output_contract>\nReturn only the new note block for the new transcript. Do not repeat existing note content. Do not output manual note labels. Do not add wrapper headings.\n</output_contract>".to_string(),
    );
    sections.join("\n\n")
}

fn extract_chat_completion_text(value: &Value) -> Option<String> {
    let content = value
        .get("choices")?
        .as_array()?
        .first()?
        .get("message")?
        .get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let parts = content
        .as_array()?
        .iter()
        .filter_map(|item| {
            item.get("text")
                .or_else(|| item.get("content"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::{extract_chat_completion_text, generation_source_text};

    #[test]
    fn generation_source_text_separates_existing_manual_and_new_transcript() {
        let input = generation_source_text(
            Some("Existing generated note"),
            Some("Test 2:"),
            "New transcript text",
        );

        assert!(input.contains("<existing_generated_note_context>\nExisting generated note"));
        assert!(input.contains("<new_manual_notes_context>\nTest 2:"));
        assert!(input.contains("<new_transcript>\nNew transcript text"));
        assert!(input.contains("Do not repeat existing note content"));
        assert!(input.contains("Do not output manual note labels"));
    }

    #[test]
    fn extracts_venice_chat_completion_text() {
        let response = serde_json::json!({
            "choices": [
                {
                    "message": {
                        "content": "Generated note block"
                    }
                }
            ]
        });

        assert_eq!(
            extract_chat_completion_text(&response).as_deref(),
            Some("Generated note block")
        );
    }
}
