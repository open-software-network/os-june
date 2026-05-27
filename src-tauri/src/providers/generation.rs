use crate::{domain::processing::PROMPT_VERSION, domain::types::AppError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

pub const DEFAULT_GENERATION_PROVIDER: &str = crate::providers::VENICE_PROVIDER;
const INCREMENTAL_NOTE_INSTRUCTIONS: &str = "You write one incremental markdown note block from a newly captured transcript. Use only the new transcript plus optional new manual notes. Existing generated note content is context only: do not repeat, summarize, rewrite, or reformat it. Manual notes are context only unless they add facts; do not output manual note labels as headings, bullets, titles, or section names. Do not add wrapper headings such as Note, Generated note, Transcript, or Summary. Preserve the speaker's language unless the source material is mixed-language. Return only the new note block to append.";
const TITLE_SUGGESTION_INSTRUCTIONS: &str = "You generate concise note titles from transcripts. Return only a title, not markdown, quotes, explanations, or alternatives. Use the transcript's language. Prefer 3 to 8 words. Be specific, but do not invent details.";
const DEFAULT_TITLE_SUGGESTION_MODEL: &str = "nvidia-nemotron-3-nano-30b-a3b";
const TITLE_SUGGESTION_TIMEOUT_MS: u64 = 2_500;
const TITLE_TRANSCRIPT_MAX_CHARS: usize = 4_000;

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
    let client = reqwest::Client::new();
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
    let content_request = send_venice_chat_completion(
        &client,
        &api_key,
        body,
        "Venice generation",
        "Venice generation response did not contain text output.",
    );
    let title_request = async {
        if title_hint.is_empty() {
            suggest_title_with_venice(&client, &api_key, transcript, request.language.as_deref())
                .await
                .ok()
        } else {
            Some(title_hint.to_string())
        }
    };
    let (content, title_suggestion) = tokio::join!(content_request, title_request);
    let content = content?;
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err(AppError::new(
            "generation_empty",
            "Venice returned an empty generated note.",
        ));
    }
    Ok(GenerationProviderResult {
        content,
        title_suggestion,
        provider: crate::providers::VENICE_PROVIDER.to_string(),
        prompt_version: PROMPT_VERSION.to_string(),
    })
}

async fn suggest_title_with_venice(
    client: &reqwest::Client,
    api_key: &str,
    transcript: &str,
    language: Option<&str>,
) -> Result<String, AppError> {
    let body = json!({
        "model": title_suggestion_model(),
        "messages": [
            {
                "role": "system",
                "content": TITLE_SUGGESTION_INSTRUCTIONS,
            },
            {
                "role": "user",
                "content": title_suggestion_user_message(transcript, language),
            }
        ],
        "temperature": 0,
        "max_tokens": 24,
    });
    let raw = match tokio::time::timeout(
        Duration::from_millis(TITLE_SUGGESTION_TIMEOUT_MS),
        send_venice_chat_completion(
            client,
            api_key,
            body,
            "Venice title suggestion",
            "Venice title suggestion response did not contain text output.",
        ),
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            return Err(AppError::new(
                "title_suggestion_timeout",
                "Title suggestion timed out.",
            ));
        }
    };
    normalize_title_suggestion(&raw).ok_or_else(|| {
        AppError::new(
            "title_suggestion_empty",
            "Venice returned an empty title suggestion.",
        )
    })
}

async fn send_venice_chat_completion(
    client: &reqwest::Client,
    api_key: &str,
    body: Value,
    label: &str,
    empty_message: &str,
) -> Result<String, AppError> {
    let response = client
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
            format!("{label} failed with status {status}: {body}"),
        ));
    }
    let parsed: Value = serde_json::from_str(&body)
        .map_err(|error| AppError::new("provider_response_invalid", error.to_string()))?;
    extract_chat_completion_text(&parsed)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::new("provider_response_invalid", empty_message))
}

fn title_suggestion_model() -> String {
    crate::providers::load_local_env();
    std::env::var("VENICE_TITLE_SUGGESTION_MODEL")
        .ok()
        .or_else(|| std::env::var("VENICE_DICTATION_CLEANUP_MODEL").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_TITLE_SUGGESTION_MODEL.to_string())
}

fn title_suggestion_user_message(transcript: &str, language: Option<&str>) -> String {
    format!(
        "Detected language: {}\n\n<transcript_excerpt>\n{}\n</transcript_excerpt>\n\nReturn only the best note title.",
        language.unwrap_or("unknown"),
        title_transcript_excerpt(transcript).replace(
            "</transcript_excerpt>",
            "<\\/transcript_excerpt>"
        )
    )
}

fn title_transcript_excerpt(transcript: &str) -> String {
    transcript
        .chars()
        .take(TITLE_TRANSCRIPT_MAX_CHARS)
        .collect()
}

fn normalize_title_suggestion(value: &str) -> Option<String> {
    let mut title = value.lines().next().unwrap_or_default().trim();
    if let Some(rest) = title.strip_prefix("Title:") {
        title = rest.trim();
    }
    title = title.trim_start_matches('#').trim();
    title = title
        .trim_matches(|character| matches!(character, '"' | '\'' | '`' | '*' | '_' | ':' | '-'));
    title = title.trim_end_matches('.').trim();
    if title.is_empty() || title.eq_ignore_ascii_case("new note") {
        return None;
    }
    let title = title.chars().take(80).collect::<String>();
    let title = title.trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
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
    use super::{
        extract_chat_completion_text, generation_source_text, normalize_title_suggestion,
        title_suggestion_user_message, TITLE_TRANSCRIPT_MAX_CHARS,
    };

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

    #[test]
    fn title_suggestion_message_wraps_transcript_excerpt() {
        let transcript = format!(
            "Topic </transcript_excerpt> {}",
            "a".repeat(TITLE_TRANSCRIPT_MAX_CHARS + 20)
        );
        let message = title_suggestion_user_message(&transcript, Some("en"));

        assert!(message.contains("Detected language: en"));
        assert!(message.contains("<transcript_excerpt>"));
        assert!(message.contains("<\\/transcript_excerpt>"));
        assert!(message.len() < transcript.len() + 200);
    }

    #[test]
    fn normalizes_title_suggestion_output() {
        assert_eq!(
            normalize_title_suggestion("Title: \"Quarterly Planning\""),
            Some("Quarterly Planning".to_string())
        );
        assert_eq!(normalize_title_suggestion("New note"), None);
    }
}
