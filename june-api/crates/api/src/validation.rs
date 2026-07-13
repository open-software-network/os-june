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
pub(crate) const MAX_ISSUE_ATTACHMENT_BYTES: usize = june_config::ISSUE_REPORT_ATTACHMENT_MAX_BYTES;
// Abuse ceilings for an agent request body, NOT the model's context window.
// The model enforces its own window; these only stop a runaway/malicious
// request from reaching it. They must sit with real HEADROOM above the largest
// advertised model window so a legitimate in-window input is never rejected here
// before the model sees it, and stay CONSISTENT with the Tauri provider proxy's
// body cap (`JUNE_PROVIDER_PROXY_MAX_BODY_BYTES`) — otherwise the stricter gate
// wins and an in-window upload fails anyway (JUN-169 review). The largest text
// model is 256k tokens (Kimi K2.6, config.toml) ≈ 1.15M chars at a conservative
// ~4.5 chars/token, so the cap is 1.5M — ~30% headroom above it, leaving room
// for the system prompt and tool schemas on top of a near-window user input.
// Per-string equals the aggregate because a single pasted document or file-read
// may legitimately fill the whole allowance. JUN-169: the old 240k aggregate
// (~60-68k tokens) rejected a single ~67k-token upload that GLM 5.2's 200k
// window holds easily, and the proxy rebranded that rejection as a "maximum
// context length" overflow, dead-ending the session on turn one.
// Tune with cost/abuse in mind — a larger cap allows larger (costlier) requests.
pub(crate) const MAX_AGENT_STRING_CHARS: usize = 1_500_000;
pub(crate) const MAX_AGENT_TOTAL_STRING_CHARS: usize = 1_500_000;
pub(crate) const MAX_AGENT_JSON_DEPTH: usize = 16;
pub(crate) const MAX_AGENT_OUTPUT_TOKENS: u64 = 32_768;
pub(crate) const MAX_PROVIDER_API_KEY_CHARS: usize = 4_096;
/// Venice caps a search query at 400 characters.
pub(crate) const MAX_WEB_QUERY_CHARS: usize = 400;
pub(crate) const MAX_WEB_URL_CHARS: usize = 4_096;
/// Venice caps an image prompt at 7,500 characters. Reused for a video prompt
/// and negative prompt.
pub(crate) const MAX_IMAGE_PROMPT_CHARS: usize = 7_500;
/// Short enum-like video knobs (`duration`, `resolution`, `aspect_ratio`).
/// Venice validates the exact values; this only bounds abuse.
pub(crate) const MAX_VIDEO_PARAM_CHARS: usize = 64;

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
    // The ONLY sanctioned home for a large base64 image is
    // messages[].content[].image_url.url. Validate that one path with the
    // exemption; every other top-level field (metadata, tools, …) goes through
    // the generic size guards with no exemption, so an oversized data URL can't
    // be smuggled through a look-alike `image_url` field outside chat content.
    for (key, value) in object {
        if key == "messages" {
            validate_messages(value, 1, &mut total_string_chars)?;
        } else {
            validate_json_shape(value, 1, &mut total_string_chars)?;
        }
    }
    Ok(())
}

/// Walk `messages[]`, routing each message's `content` through the content-part
/// validator so the image exemption only ever applies on that exact path.
fn validate_messages(
    value: &Value,
    depth: usize,
    total_string_chars: &mut usize,
) -> Result<(), ApiError> {
    if depth > MAX_AGENT_JSON_DEPTH {
        return Err(ApiError::bad_request("json_too_deep"));
    }
    let Some(items) = value.as_array() else {
        // Unexpected shape (not an array) — guard it generically.
        return validate_json_shape(value, depth, total_string_chars);
    };
    for item in items {
        if let Some(message) = item.as_object() {
            for (key, child) in message {
                if key == "content" {
                    validate_message_content(child, depth + 2, total_string_chars)?;
                } else {
                    validate_json_shape(child, depth + 2, total_string_chars)?;
                }
            }
        } else {
            validate_json_shape(item, depth + 1, total_string_chars)?;
        }
    }
    Ok(())
}

/// `content` is either a plain string or an array of parts; only an array part
/// shaped `{"type":"image_url","image_url":{"url":"data:..."}}` gets the
/// data-url exemption.
fn validate_message_content(
    value: &Value,
    depth: usize,
    total_string_chars: &mut usize,
) -> Result<(), ApiError> {
    if depth > MAX_AGENT_JSON_DEPTH {
        return Err(ApiError::bad_request("json_too_deep"));
    }
    let Some(parts) = value.as_array() else {
        return validate_json_shape(value, depth, total_string_chars);
    };
    for part in parts {
        let Some(object) = part.as_object() else {
            validate_json_shape(part, depth + 1, total_string_chars)?;
            continue;
        };
        let is_image_part = object.get("type").and_then(Value::as_str) == Some("image_url");
        for (key, child) in object {
            // Exempt the one image_url.url string from BOTH the per-string and
            // aggregate caps; every other string stays subject to them.
            if is_image_part
                && key == "image_url"
                && let Some(image) = child.as_object()
                && image
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(is_agent_image_data_url)
            {
                for (field, inner) in image {
                    if field == "url" {
                        continue;
                    }
                    validate_json_shape(inner, depth + 3, total_string_chars)?;
                }
                continue;
            }
            validate_json_shape(child, depth + 2, total_string_chars)?;
        }
    }
    Ok(())
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
            // Generic guard: no image exemption here. The data-url exemption is
            // applied ONLY on the messages[].content[].image_url.url path (see
            // validate_message_content), so a look-alike `image_url` object in
            // any other field is fully subject to the size caps.
            for value in object.values() {
                validate_json_shape(value, depth + 1, total_string_chars)?;
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

    #[test]
    fn agent_body_rejects_image_url_shaped_object_without_content_part_type() {
        // An image_url-shaped object outside a real content part (no sibling
        // "type":"image_url") must NOT bypass the guards, or an oversized data
        // URL could be smuggled through e.g. metadata.image_url.url.
        let image = format!(
            "data:image/png;base64,{}",
            "a".repeat(MAX_AGENT_STRING_CHARS + 1)
        );

        assert!(matches!(
            validate_agent_chat_body(&json!({
                "model": "text-model",
                "messages": [{ "role": "user", "content": "hi" }],
                "metadata": { "image_url": { "url": image } },
            })),
            Err(ApiError::BadRequest { message, .. }) if message == "string_too_long"
        ));
    }

    #[test]
    fn agent_body_rejects_image_content_part_outside_messages_content() {
        // Path-scoped: a full image content part ("type":"image_url" + image_url)
        // placed OUTSIDE messages[].content[] (e.g. in metadata) must NOT get the
        // exemption — the data URL is still subject to the size guards.
        let image = format!(
            "data:image/png;base64,{}",
            "a".repeat(MAX_AGENT_STRING_CHARS + 1)
        );

        assert!(matches!(
            validate_agent_chat_body(&json!({
                "model": "text-model",
                "messages": [{ "role": "user", "content": "hi" }],
                "metadata": {
                    "type": "image_url",
                    "image_url": { "url": image },
                },
            })),
            Err(ApiError::BadRequest { message, .. }) if message == "string_too_long"
        ));
    }
}
