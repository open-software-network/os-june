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
pub(crate) const MAX_ISSUE_DESCRIPTION_CHARS: usize = 20_000;
pub(crate) const MAX_ISSUE_DIAGNOSIS_CHARS: usize = 50_000;
pub(crate) const MAX_ISSUE_ATTACHMENTS: usize = 20;
pub(crate) const MAX_ISSUE_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
pub(crate) const MAX_AGENT_STRING_CHARS: usize = 100_000;
pub(crate) const MAX_AGENT_TOTAL_STRING_CHARS: usize = 240_000;
pub(crate) const MAX_AGENT_JSON_DEPTH: usize = 16;
pub(crate) const MAX_AGENT_OUTPUT_TOKENS: u64 = 32_768;
/// Venice caps a search query at 400 characters.
pub(crate) const MAX_WEB_QUERY_CHARS: usize = 400;
pub(crate) const MAX_WEB_URL_CHARS: usize = 4_096;

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
                // Agent clients recover from context overflow automatically
                // (compress the history, retry), but they classify by the
                // provider error TEXT: hermes-agent's overflow patterns match
                // phrases like "maximum context" and "context length", not
                // the bare token. Keep `prompt_too_long` first for clients
                // keying on it; the rest of the sentence is what unwedges an
                // agent whose conversation outgrew the model.
                return Err(ApiError::bad_request(
                    "prompt_too_long: the request exceeds the model's maximum context length",
                ));
            }
        }
        Value::Array(items) => {
            for item in items {
                validate_json_shape(item, depth + 1, total_string_chars)?;
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                // The only sanctioned home for a large base64 image is
                // messages[].content[].image_url.url. Exempt exactly that string
                // from BOTH the per-string and aggregate guards; every other
                // string (metadata, tool descriptions, …) stays subject to them,
                // so an oversized data URL can't be smuggled into an unrelated
                // field to bypass the cap.
                if key == "image_url"
                    && let Some(image) = child.as_object()
                    && image
                        .get("url")
                        .and_then(Value::as_str)
                        .is_some_and(is_agent_image_data_url)
                {
                    for (field, value) in image {
                        if field == "url" {
                            continue;
                        }
                        validate_json_shape(value, depth + 2, total_string_chars)?;
                    }
                    continue;
                }
                validate_json_shape(child, depth + 1, total_string_chars)?;
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
    Ok(())
}

fn is_agent_image_data_url(text: &str) -> bool {
    let Some((mime, data)) = text.split_once(";base64,") else {
        return false;
    };
    mime.starts_with("data:image/")
        && !data.is_empty()
        && data.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'\r' | b'\n')
        })
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
    fn agent_body_accepts_many_small_messages() {
        let messages = (0..128)
            .map(|_| json!({ "role": "user", "content": "hello" }))
            .collect::<Vec<_>>();

        assert!(
            validate_agent_chat_body(&json!({
                "model": "text-model",
                "messages": messages,
            }))
            .is_ok()
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

    #[test]
    fn agent_body_accepts_image_data_url_over_single_string_limit() {
        let image = format!(
            "data:image/png;base64,{}",
            "a".repeat(MAX_AGENT_STRING_CHARS + 1)
        );

        assert!(
            validate_agent_chat_body(&json!({
                "model": "text-model",
                "messages": [{
                    "role": "user",
                    "content": [{
                        "type": "image_url",
                        "image_url": { "url": image },
                    }],
                }],
            }))
            .is_ok()
        );
    }

    #[test]
    fn agent_body_rejects_non_image_data_url_over_single_string_limit() {
        let text = format!(
            "data:text/plain;base64,{}",
            "a".repeat(MAX_AGENT_STRING_CHARS + 1)
        );

        assert!(matches!(
            validate_agent_chat_body(&json!({
                "model": "text-model",
                "messages": [{ "role": "user", "content": text }],
            })),
            Err(ApiError::BadRequest { message, .. }) if message == "string_too_long"
        ));
    }

    #[test]
    fn agent_body_accepts_image_data_url_over_aggregate_limit() {
        // A real screenshot can exceed the aggregate prompt-char cap on its own;
        // the image_url.url payload must be exempt from the aggregate count too,
        // not just the per-string limit, or sending a screenshot 400s.
        let image = format!(
            "data:image/png;base64,{}",
            "a".repeat(MAX_AGENT_TOTAL_STRING_CHARS + 1)
        );

        assert!(
            validate_agent_chat_body(&json!({
                "model": "text-model",
                "messages": [{
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "describe this" },
                        { "type": "image_url", "image_url": { "url": image } },
                    ],
                }],
            }))
            .is_ok()
        );
    }

    #[test]
    fn agent_body_rejects_image_data_url_outside_image_url_field() {
        // The exemption is structural: a large data:image payload smuggled into
        // an unrelated field must NOT bypass the per-string guard.
        let image = format!(
            "data:image/png;base64,{}",
            "a".repeat(MAX_AGENT_STRING_CHARS + 1)
        );

        assert!(matches!(
            validate_agent_chat_body(&json!({
                "model": "text-model",
                "messages": [{ "role": "user", "content": "hi" }],
                "metadata": { "note": image },
            })),
            Err(ApiError::BadRequest { message, .. }) if message == "string_too_long"
        ));
    }
}
