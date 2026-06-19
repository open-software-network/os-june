use crate::{
    auth::authenticated_user, error::ApiError, handlers::notes::require_priced_model,
    state::ApiState, validation,
};
use axum::{
    Json,
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
};
use scribe_domain::{ModelId, ModelKind};
use scribe_services::{AgentChatParams, AgentChatRoute};

pub(crate) async fn chat_completions(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(mut body): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    chat_completions_with_route(state, headers, &mut body, AgentChatRoute::Guarded).await
}

pub(crate) async fn chat_completions_direct(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(mut body): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    chat_completions_with_route(state, headers, &mut body, AgentChatRoute::Direct).await
}

async fn chat_completions_with_route(
    state: ApiState,
    headers: HeaderMap,
    body: &mut serde_json::Value,
    route: AgentChatRoute,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let model_id = body
        .get("model")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("model_required"))?
        .to_string();
    validation::validate_text_len("model", &model_id, validation::MAX_MODEL_CHARS)?;
    validation::validate_agent_chat_body(body)?;
    require_priced_model(&state, &model_id, ModelKind::Text)?;
    if let Some(object) = body.as_object_mut() {
        object.insert(
            "model".to_string(),
            serde_json::Value::String(model_id.clone()),
        );
    }
    let streaming = body
        .get("stream")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let params = AgentChatParams {
        user_id,
        model_id: ModelId(model_id),
        body: body.clone(),
        route,
    };

    // A streaming caller gets the provider response forwarded as it arrives, so
    // a slow reasoning model does not stall behind a fully buffered response (a
    // non-streaming caller still gets a single buffered JSON body).
    if streaming {
        let output = state.agent_chat().complete_streaming(params).await?;
        return Ok((
            StatusCode::OK,
            [(CONTENT_TYPE, output.content_type)],
            Body::from_stream(output.body),
        )
            .into_response());
    }

    let output = state.agent_chat().complete(params).await?;
    Ok((
        StatusCode::OK,
        [(CONTENT_TYPE, output.completion.content_type)],
        output.completion.body,
    )
        .into_response())
}
