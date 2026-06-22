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
use bytes::Bytes;
use futures_util::Stream;
use scribe_domain::{ModelId, ModelKind};
use scribe_services::{AgentChatParams, AgentChatRoute, ServiceError};
use serde_json::{Map, Value};
use std::{
    pin::Pin,
    task::{Context, Poll},
};

pub(crate) const DIRECT_CHAT_TOKEN_HEADER: &str = "x-scribe-direct-chat-token";
const DIRECT_CHAT_STREAM_REMEMBER_BYTES: usize = 1024 * 1024;

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
        let body = if let Some(token) = direct_token {
            Body::from_stream(DirectChatRememberStream::new(
                output.body,
                DirectChatRememberTarget {
                    state: state.clone(),
                    token,
                    request_body: body.clone(),
                    content_type: output.content_type.clone(),
                },
            ))
        } else {
            Body::from_stream(output.body)
        };
        return Ok((StatusCode::OK, [(CONTENT_TYPE, output.content_type)], body).into_response());
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

struct DirectChatRememberStream {
    inner: Pin<Box<dyn Stream<Item = Result<Bytes, scribe_domain::DomainError>> + Send>>,
    state: ApiState,
    token: String,
    request_body: Value,
    content_type: String,
    captured: Vec<u8>,
    truncated: bool,
    failed: bool,
    remembered: bool,
}

struct DirectChatRememberTarget {
    state: ApiState,
    token: String,
    request_body: Value,
    content_type: String,
}

impl DirectChatRememberStream {
    fn new(
        inner: Pin<Box<dyn Stream<Item = Result<Bytes, scribe_domain::DomainError>> + Send>>,
        target: DirectChatRememberTarget,
    ) -> Self {
        Self {
            inner,
            state: target.state,
            token: target.token,
            request_body: target.request_body,
            content_type: target.content_type,
            captured: Vec::new(),
            truncated: false,
            failed: false,
            remembered: false,
        }
    }

    fn capture(&mut self, chunk: &[u8]) {
        if self.truncated {
            return;
        }
        let remaining = DIRECT_CHAT_STREAM_REMEMBER_BYTES.saturating_sub(self.captured.len());
        if chunk.len() > remaining {
            self.truncated = true;
            self.captured.clear();
            return;
        }
        self.captured.extend_from_slice(chunk);
    }

    fn remember_if_complete(&mut self) {
        if self.remembered || self.failed || self.truncated {
            return;
        }
        self.remembered = true;
        let Some(response_body) = direct_chat_remember_body(&self.content_type, &self.captured)
        else {
            return;
        };
        self.state.remember_direct_chat_session_key(
            &self.token,
            &self.request_body,
            &response_body,
        );
    }
}

impl Stream for DirectChatRememberStream {
    type Item = Result<Bytes, scribe_domain::DomainError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                self.capture(&chunk);
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(Some(Err(error))) => {
                self.failed = true;
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                self.remember_if_complete();
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

fn direct_chat_remember_body(content_type: &str, body: &[u8]) -> Option<Vec<u8>> {
    if content_type.contains("text/event-stream") {
        return direct_chat_sse_remember_body(body);
    }
    Some(body.to_vec())
}

fn direct_chat_sse_remember_body(body: &[u8]) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(body).ok()?;
    let mut assistant = StreamedAssistantMessage::default();
    for line in text.lines() {
        let Some(data) = line.trim().strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        let Some(delta) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("delta"))
        else {
            continue;
        };
        assistant.apply_delta(delta);
    }
    assistant.into_chat_response_body()
}

#[derive(Default)]
struct StreamedAssistantMessage {
    content: String,
    tool_calls: Vec<Map<String, Value>>,
}

impl StreamedAssistantMessage {
    fn apply_delta(&mut self, delta: &Value) {
        if let Some(content) = delta.get("content").and_then(Value::as_str) {
            self.content.push_str(content);
        }
        let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) else {
            return;
        };
        for (offset, tool_call) in tool_calls.iter().enumerate() {
            let index = tool_call
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(offset);
            while self.tool_calls.len() <= index {
                self.tool_calls.push(Map::new());
            }
            if let Some(delta) = tool_call.as_object() {
                merge_tool_call_delta(&mut self.tool_calls[index], delta);
            }
        }
    }

    fn into_chat_response_body(self) -> Option<Vec<u8>> {
        if self.content.is_empty() && self.tool_calls.is_empty() {
            return None;
        }
        let mut message = Map::new();
        message.insert("role".to_string(), Value::String("assistant".to_string()));
        message.insert("content".to_string(), Value::String(self.content));
        if !self.tool_calls.is_empty() {
            message.insert(
                "tool_calls".to_string(),
                Value::Array(self.tool_calls.into_iter().map(Value::Object).collect()),
            );
        }
        serde_json::to_vec(&serde_json::json!({
            "choices": [{ "message": Value::Object(message) }],
        }))
        .ok()
    }
}

fn merge_tool_call_delta(target: &mut Map<String, Value>, delta: &Map<String, Value>) {
    for (key, value) in delta {
        if key == "index" {
            continue;
        }
        if key == "function" {
            let function = target
                .entry(key.clone())
                .or_insert_with(|| Value::Object(Map::new()));
            if let (Some(target), Some(delta)) = (function.as_object_mut(), value.as_object()) {
                merge_string_delta_fields(target, delta);
                continue;
            }
        }
        merge_value_delta(target, key, value);
    }
}

fn merge_string_delta_fields(target: &mut Map<String, Value>, delta: &Map<String, Value>) {
    for (key, value) in delta {
        merge_value_delta(target, key, value);
    }
}

fn merge_value_delta(target: &mut Map<String, Value>, key: &str, value: &Value) {
    if let Some(next) = value.as_str()
        && let Some(Value::String(existing)) = target.get_mut(key)
    {
        existing.push_str(next);
        return;
    }
    target.insert(key.to_string(), value.clone());
}
