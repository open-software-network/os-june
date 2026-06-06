use crate::error::ApiError;
use serde_json::Value;

pub(crate) const MAX_ID_CHARS: usize = 128;
pub(crate) const MAX_MODEL_CHARS: usize = 128;
pub(crate) const MAX_TITLE_CHARS: usize = 512;
pub(crate) const MAX_LANGUAGE_CHARS: usize = 64;
pub(crate) const MAX_TRANSCRIPTION_CONTEXT_CHARS: usize = 20_000;
pub(crate) const MAX_NOTE_TRANSCRIPT_CHARS: usize = 200_000;
pub(crate) const MAX_NOTE_MANUAL_NOTES_CHARS: usize = 50_000;
pub(crate) const MAX_EXISTING_NOTE_CHARS: usize = 200_000;
pub(crate) const MAX_DICTATION_TEXT_CHARS: usize = 20_000;
pub(crate) const MAX_DICTATION_STYLE_CHARS: usize = 4_000;
pub(crate) const MAX_AGENT_MESSAGES: usize = 64;
pub(crate) const MAX_AGENT_STRING_CHARS: usize = 100_000;
pub(crate) const MAX_AGENT_TOTAL_STRING_CHARS: usize = 240_000;
pub(crate) const MAX_AGENT_JSON_DEPTH: usize = 16;
pub(crate) const MAX_AGENT_OUTPUT_TOKENS: u64 = 8_192;

pub(crate) fn validate_text_len(
    field: &str,
    value: &str,
    max_chars: usize,
) -> Result<(), ApiError> {
    if value.chars().count() > max_chars {
        return Err(ApiError::bad_request(format!("{field}_too_long")));
    }
    Ok(())
}

pub(crate) fn validate_optional_text_len(
    field: &str,
    value: Option<&str>,
    max_chars: usize,
) -> Result<(), ApiError> {
    if let Some(value) = value {
        validate_text_len(field, value, max_chars)?;
    }
    Ok(())
}

pub(crate) fn validate_agent_chat_body(body: &Value) -> Result<(), ApiError> {
    let Some(object) = body.as_object() else {
        return Err(ApiError::bad_request("invalid_chat_completion_body"));
    };
    if let Some(messages) = object.get("messages").and_then(Value::as_array)
        && messages.len() > MAX_AGENT_MESSAGES
    {
        return Err(ApiError::bad_request("messages_too_many"));
    }
    validate_output_tokens(object.get("max_tokens"), "max_tokens")?;
    validate_output_tokens(object.get("max_completion_tokens"), "max_completion_tokens")?;
    let mut total_string_chars = 0usize;
    validate_json_shape(body, 0, &mut total_string_chars)
}

fn validate_output_tokens(value: Option<&Value>, field: &str) -> Result<(), ApiError> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.is_null() {
        return Ok(());
    }
    let Some(tokens) = value.as_u64() else {
        return Err(ApiError::bad_request(format!("{field}_invalid")));
    };
    if tokens > MAX_AGENT_OUTPUT_TOKENS {
        return Err(ApiError::bad_request(format!("{field}_too_large")));
    }
    Ok(())
}

fn validate_json_shape(
    value: &Value,
    depth: usize,
    total_string_chars: &mut usize,
) -> Result<(), ApiError> {
    if depth > MAX_AGENT_JSON_DEPTH {
        return Err(ApiError::bad_request("json_too_deep"));
    }
    match value {
        Value::String(text) => {
            let chars = text.chars().count();
            if chars > MAX_AGENT_STRING_CHARS {
                return Err(ApiError::bad_request("string_too_long"));
            }
            *total_string_chars = total_string_chars.saturating_add(chars);
            if *total_string_chars > MAX_AGENT_TOTAL_STRING_CHARS {
                return Err(ApiError::bad_request("prompt_too_long"));
            }
        }
        Value::Array(items) => {
            for item in items {
                validate_json_shape(item, depth + 1, total_string_chars)?;
            }
        }
        Value::Object(object) => {
            for value in object.values() {
                validate_json_shape(value, depth + 1, total_string_chars)?;
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn text_length_rejects_over_limit_values() {
        assert!(validate_text_len("title", "abc", 3).is_ok());
        assert!(validate_text_len("title", "abcd", 3).is_err());
    }

    #[test]
    fn agent_body_rejects_too_many_messages() {
        let messages = (0..=MAX_AGENT_MESSAGES)
            .map(|_| json!({ "role": "user", "content": "hello" }))
            .collect::<Vec<_>>();

        assert!(
            validate_agent_chat_body(&json!({
                "model": "text-model",
                "messages": messages,
            }))
            .is_err()
        );
    }

    #[test]
    fn agent_body_rejects_excessive_output_tokens() {
        assert!(
            validate_agent_chat_body(&json!({
                "model": "text-model",
                "messages": [{ "role": "user", "content": "hello" }],
                "max_tokens": MAX_AGENT_OUTPUT_TOKENS + 1,
            }))
            .is_err()
        );
    }

    #[test]
    fn agent_body_accepts_null_output_tokens() {
        assert!(
            validate_agent_chat_body(&json!({
                "model": "text-model",
                "messages": [{ "role": "user", "content": "hello" }],
                "max_tokens": null,
                "max_completion_tokens": null,
            }))
            .is_ok()
        );
    }

    #[test]
    fn agent_body_rejects_negative_output_tokens() {
        assert!(matches!(
            validate_agent_chat_body(&json!({
                "model": "text-model",
                "messages": [{ "role": "user", "content": "hello" }],
                "max_tokens": -1,
            })),
            Err(ApiError::BadRequest { message, .. }) if message == "max_tokens_invalid"
        ));
    }

    #[test]
    fn agent_body_rejects_aggregate_prompt_strings() {
        let text = "a".repeat(MAX_AGENT_TOTAL_STRING_CHARS + 1);

        assert!(
            validate_agent_chat_body(&json!({
                "model": "text-model",
                "messages": [{ "role": "user", "content": text }],
            }))
            .is_err()
        );
    }
}
