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
use june_domain::ModelId;
use june_services::AgentChatParams;
use tokio_stream::wrappers::UnboundedReceiverStream;

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
    let model_id = resolve_priced_text_model(&state, &requested_model_id)?;
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
