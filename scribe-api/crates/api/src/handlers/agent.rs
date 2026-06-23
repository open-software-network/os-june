use crate::{
    auth::authenticated_user, error::ApiError, handlers::notes::require_priced_model,
    state::ApiState, validation,
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
};
use scribe_domain::{ModelId, ModelKind};
use scribe_services::AgentChatParams;

pub(crate) async fn chat_completions(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(mut body): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let waive_metering = take_initial_report_billing_marker(&mut body);
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
    let output = state
        .agent_chat()
        .complete(AgentChatParams {
            user_id,
            model_id: ModelId(model_id),
            waive_metering,
            body,
        })
        .await?;
    Ok((
        StatusCode::OK,
        [(CONTENT_TYPE, output.completion.content_type)],
        output.completion.body,
    )
        .into_response())
}

fn take_initial_report_billing_marker(body: &mut serde_json::Value) -> bool {
    const INTERNAL_MARKER_KEY: &str = "__june";
    const BILLING_INTENT_KEY: &str = "billingIntent";
    const INITIAL_REPORT_INTENT: &str = "initial_issue_report";

    let Some(object) = body.as_object_mut() else {
        return false;
    };
    let marker = object.remove(INTERNAL_MARKER_KEY);
    marker
        .as_ref()
        .and_then(serde_json::Value::as_object)
        .and_then(|object| object.get(BILLING_INTENT_KEY))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|intent| intent == INITIAL_REPORT_INTENT)
}

#[cfg(test)]
mod tests {
    use super::take_initial_report_billing_marker;
    use serde_json::json;

    #[test]
    fn billing_marker_is_consumed_from_chat_body() {
        let mut body = json!({
            "model": "text-model",
            "__june": { "billingIntent": "initial_issue_report" },
            "messages": [{ "role": "user", "content": "report" }]
        });

        assert!(take_initial_report_billing_marker(&mut body));
        assert!(body.get("__june").is_none());
        assert_eq!(body["messages"][0]["content"], "report");
    }

    #[test]
    fn invalid_billing_marker_is_consumed_without_waiver() {
        let mut body = json!({
            "model": "text-model",
            "__june": { "billingIntent": "ordinary" },
            "messages": [{ "role": "user", "content": "hello" }]
        });

        assert!(!take_initial_report_billing_marker(&mut body));
        assert!(body.get("__june").is_none());
    }
}
