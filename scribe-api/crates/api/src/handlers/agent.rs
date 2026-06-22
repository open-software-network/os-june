use crate::{
    auth::authenticated_user, error::ApiError, handlers::notes::require_priced_model,
    state::ApiState, validation,
};
use axum::{
    Json,
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
};
use scribe_domain::{ModelId, ModelKind};
use scribe_services::{AgentChatParams, AgentChatRoute, ServiceError};

pub(crate) const DIRECT_CHAT_TOKEN_HEADER: &str = "x-scribe-direct-chat-token";

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
    let direct_token = if route == AgentChatRoute::Direct {
        let token = require_direct_chat_token(&headers)?;
        if !state.direct_chat_grant_matches(&token, &user_id, body) {
            return Err(ApiError::forbidden("direct_chat_token_invalid"));
        }
        Some(token)
    } else {
        None
    };
    let streaming = body
        .get("stream")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let params = AgentChatParams {
        user_id: user_id.clone(),
        model_id: ModelId(model_id),
        body: body.clone(),
        route,
    };

    // A streaming caller gets the provider response forwarded as it arrives, so
    // a slow reasoning model does not stall behind a fully buffered response (a
    // non-streaming caller still gets a single buffered JSON body).
    if streaming {
        let output = match state.agent_chat().complete_streaming(params).await {
            Ok(output) => output,
            Err(error) => {
                if route == AgentChatRoute::Guarded {
                    return agent_chat_error_response(&state, &user_id, body, error);
                }
                return Err(ApiError::from(error));
            }
        };
        return Ok((
            StatusCode::OK,
            [(CONTENT_TYPE, output.content_type)],
            Body::from_stream(output.body),
        )
            .into_response());
    }

    let output = match state.agent_chat().complete(params).await {
        Ok(output) => output,
        Err(error) => {
            if route == AgentChatRoute::Guarded {
                return agent_chat_error_response(&state, &user_id, body, error);
            }
            return Err(ApiError::from(error));
        }
    };
    if let Some(token) = direct_token {
        state.remember_direct_chat_session_key(&token, body, &output.completion.body);
    }
    Ok((
        StatusCode::OK,
        [(CONTENT_TYPE, output.completion.content_type)],
        output.completion.body,
    )
        .into_response())
}

fn require_direct_chat_token(headers: &HeaderMap) -> Result<String, ApiError> {
    headers
        .get(DIRECT_CHAT_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| ApiError::forbidden("direct_chat_token_required"))
}

fn agent_chat_error_response(
    state: &ApiState,
    user_id: &scribe_domain::UserId,
    body: &serde_json::Value,
    error: ServiceError,
) -> Result<Response, ApiError> {
    if matches!(error, ServiceError::PolicyBlocked) {
        return policy_blocked_response_with_direct_grant(state, user_id, body);
    }
    Err(ApiError::from(error))
}

fn policy_blocked_response_with_direct_grant(
    state: &ApiState,
    user_id: &scribe_domain::UserId,
    body: &serde_json::Value,
) -> Result<Response, ApiError> {
    let token = state
        .issue_direct_chat_grant(user_id, body)
        .ok_or(ApiError::Internal)?;
    let mut response = ApiError::PolicyBlocked.into_response();
    let header_name = HeaderName::from_static(DIRECT_CHAT_TOKEN_HEADER);
    let header_value = HeaderValue::from_str(&token).map_err(|_| ApiError::Internal)?;
    response.headers_mut().insert(header_name, header_value);
    Ok(response)
}
