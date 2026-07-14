use crate::{
    auth::{authenticated_user, provider_credentials},
    error::ApiError,
    handlers::notes::{AUTO_TEXT_MODEL, credentials_for_resolved_model, resolve_priced_text_model},
    state::ApiState,
    validation,
};
use axum::{
    Json,
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
};
use june_domain::{ModelId, ModelKind};
use june_services::{AgentChatParams, PricingTable};
use tokio_stream::wrappers::UnboundedReceiverStream;

const PREFERRED_VISION_TEXT_MODEL: &str = "kimi-k2-6";

pub(crate) async fn chat_completions(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(mut body): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let provider_credentials = provider_credentials(&headers)?;
    let requested_model_id = body
        .get("model")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("model_required"))?
        .to_string();
    validation::validate_text_len("model", &requested_model_id, validation::MAX_MODEL_CHARS)?;
    validation::validate_agent_chat_body(&body)?;
    let model_id = resolve_priced_agent_text_model(&state, &requested_model_id, &body)?;
    let provider_credentials = credentials_for_resolved_model(
        provider_credentials,
        &requested_model_id,
        &model_id,
        state.pricing().is_venice_model(&model_id),
    )?;
    if let Some(object) = body.as_object_mut() {
        if model_id != AUTO_TEXT_MODEL {
            object.remove("auto");
        }
        object.insert(
            "model".to_string(),
            serde_json::Value::String(model_id.clone()),
        );
    }
    if body.get("stream").and_then(serde_json::Value::as_bool) == Some(true) {
        let output = state
            .agent_chat()
            .complete_stream(AgentChatParams {
                user_id,
                model_id: ModelId(model_id),
                body,
                provider_credentials,
            })
            .await?;
        // The route TimeoutLayer bounds this handler future; the streamed body
        // is bounded by the upstream reqwest client's total timeout.
        return Ok((
            StatusCode::OK,
            [(CONTENT_TYPE, output.content_type)],
            Body::from_stream(UnboundedReceiverStream::new(output.chunks)),
        )
            .into_response());
    }
    let output = state
        .agent_chat()
        .complete(AgentChatParams {
            user_id,
            model_id: ModelId(model_id),
            body,
            provider_credentials,
        })
        .await?;
    Ok((
        StatusCode::OK,
        [(CONTENT_TYPE, output.completion.content_type)],
        output.completion.body,
    )
        .into_response())
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct AgentModelRequirements {
    vision: bool,
    tools: bool,
}

impl AgentModelRequirements {
    fn from_body(body: &serde_json::Value) -> Self {
        Self {
            vision: body.get("messages").is_some_and(chat_items_contain_image),
            tools: body
                .get("tools")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|tools| !tools.is_empty()),
        }
    }

    fn is_empty(self) -> bool {
        !self.vision && !self.tools
    }
}

fn resolve_priced_agent_text_model(
    state: &ApiState,
    requested_model_id: &str,
    body: &serde_json::Value,
) -> Result<String, ApiError> {
    let resolved_model_id = resolve_priced_text_model(state, requested_model_id)?;
    let requirements = AgentModelRequirements::from_body(body);
    if resolved_model_id == AUTO_TEXT_MODEL
        || resolved_model_id == requested_model_id
        || requirements.is_empty()
        || model_supports_requirements(state.pricing(), &resolved_model_id, requirements)
    {
        return Ok(resolved_model_id);
    }

    [PREFERRED_VISION_TEXT_MODEL]
        .into_iter()
        .filter(|model_id| {
            state
                .pricing()
                .ensure_model_kind(model_id, ModelKind::Text)
                .is_ok()
        })
        .find(|model_id| model_supports_requirements(state.pricing(), model_id, requirements))
        .map(str::to_string)
        .or_else(|| {
            state
                .pricing()
                .priced_models(Some(ModelKind::Text))
                .into_iter()
                .map(|(model_id, _)| model_id)
                .filter(|model_id| *model_id != AUTO_TEXT_MODEL)
                .find(|model_id| {
                    state
                        .pricing()
                        .ensure_model_kind(model_id, ModelKind::Text)
                        .is_ok()
                        && model_supports_requirements(state.pricing(), model_id, requirements)
                })
                .cloned()
        })
        .ok_or_else(|| ApiError::unprocessable("model_not_priced"))
}

fn chat_items_contain_image(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Array(values) => values.iter().any(chat_items_contain_image),
        serde_json::Value::Object(object) => {
            matches!(
                object.get("type").and_then(serde_json::Value::as_str),
                Some("image_url")
            ) || object.get("content").is_some_and(chat_items_contain_image)
        }
        _ => false,
    }
}

fn model_supports_requirements(
    pricing: &PricingTable,
    model_id: &str,
    requirements: AgentModelRequirements,
) -> bool {
    pricing
        .iter()
        .find(|(candidate_id, _)| candidate_id.as_str() == model_id)
        .is_some_and(|(_, model)| {
            (!requirements.vision || has_capability(&model.capabilities, "supportsvision"))
                && (!requirements.tools
                    || has_capability(&model.capabilities, "supportsfunctioncalling"))
        })
}

fn has_capability(capabilities: &[String], expected: &str) -> bool {
    capabilities.iter().any(|capability| {
        capability
            .chars()
            .filter(char::is_ascii_alphabetic)
            .map(|character| character.to_ascii_lowercase())
            .collect::<String>()
            == expected
    })
}

#[cfg(test)]
mod tests {
    use super::{AgentModelRequirements, has_capability};

    #[test]
    fn infers_image_and_tool_requirements_from_chat_content() {
        let body = serde_json::json!({
            "messages": [{
                "role": "user",
                "content": [{
                    "type": "image_url",
                    "image_url": { "url": "https://example.com/image.png" }
                }]
            }],
            "tools": [{ "type": "function" }]
        });

        assert_eq!(
            AgentModelRequirements::from_body(&body),
            AgentModelRequirements {
                vision: true,
                tools: true,
            }
        );
    }

    #[test]
    fn ignores_image_like_content_outside_supported_message_content() {
        let body = serde_json::json!({
            "messages": [{
                "role": "user",
                "content": "hello",
                "metadata": { "type": "image_url" }
            }],
            "input": [{
                "content": [{ "type": "image_url", "image_url": "unsupported-here" }]
            }]
        });

        assert_eq!(
            AgentModelRequirements::from_body(&body),
            AgentModelRequirements::default()
        );
    }

    #[test]
    fn capability_matching_uses_the_catalog_names_normalized() {
        assert!(has_capability(
            &["supports_vision".to_string()],
            "supportsvision"
        ));
        assert!(!has_capability(
            &["supportsVision".to_string()],
            "supportsfunctioncalling"
        ));
    }
}
