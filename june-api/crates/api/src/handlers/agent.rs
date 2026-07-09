use crate::{
    auth::{authenticated_user, provider_credentials},
    error::ApiError,
    handlers::notes::require_priced_model,
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
use june_services::AgentChatParams;
use tokio_stream::wrappers::UnboundedReceiverStream;

pub(crate) async fn chat_completions(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(mut body): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let provider_credentials = provider_credentials(&headers)?;
    let model_id = body
        .get("model")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("model_required"))?
        .to_string();
    validation::validate_text_len("model", &model_id, validation::MAX_MODEL_CHARS)?;
    validation::validate_agent_chat_body(&body)?;
    require_priced_model(&state, &model_id, ModelKind::Text)?;
    if let Some(object) = body.as_object_mut() {
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
