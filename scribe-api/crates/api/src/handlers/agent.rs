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
    const USER_REPORT_START: &str = "---USER REPORT---";
    const USER_REPORT_END: &str = "---END USER REPORT---";

    let is_initial_report_prompt = latest_user_message_content(body).is_some_and(|content| {
        let content = content.trim_start();
        let has_report_markers = content
            .find(USER_REPORT_START)
            .zip(content.rfind(USER_REPORT_END))
            .is_some_and(|(start, end)| start < end);
        has_report_markers
            && (content.starts_with("The user is filing a bug report about the June desktop app.")
                || content.starts_with("The user is sharing feedback about the June desktop app.")
                || content
                    .starts_with("The user is requesting a feature for the June desktop app."))
    });
    let Some(object) = body.as_object_mut() else {
        return false;
    };
    let marker = object.remove(INTERNAL_MARKER_KEY);
    is_initial_report_prompt
        && marker
            .as_ref()
            .and_then(serde_json::Value::as_object)
            .and_then(|object| object.get(BILLING_INTENT_KEY))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|intent| intent == INITIAL_REPORT_INTENT)
}

fn latest_user_message_content(body: &serde_json::Value) -> Option<&str> {
    body.get("messages")
        .and_then(serde_json::Value::as_array)?
        .iter()
        .rev()
        .find(|message| {
            message
                .get("role")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|role| role == "user")
        })?
        .get("content")
        .and_then(serde_json::Value::as_str)
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
            "messages": [
                {
                    "role": "user",
                    "content": "The user is filing a bug report about the June desktop app.\n\n---USER REPORT---\nreport\n---END USER REPORT---"
                }
            ]
        });

        assert!(take_initial_report_billing_marker(&mut body));
        assert!(body.get("__june").is_none());
        assert!(body["messages"][0]["content"]
            .as_str()
            .is_some_and(|content| content.contains("---USER REPORT---")));
    }

    #[test]
    fn invalid_billing_marker_is_consumed_without_waiver() {
        let mut body = json!({
            "model": "text-model",
            "__june": { "billingIntent": "ordinary" },
            "messages": [
                {
                    "role": "user",
                    "content": "The user is requesting a feature for the June desktop app.\n\n---USER REPORT---\nhello\n---END USER REPORT---"
                }
            ]
        });

        assert!(!take_initial_report_billing_marker(&mut body));
        assert!(body.get("__june").is_none());
    }

    #[test]
    fn marked_ordinary_prompt_is_consumed_without_waiver() {
        let mut body = json!({
            "model": "text-model",
            "__june": { "billingIntent": "initial_issue_report" },
            "messages": [{ "role": "user", "content": "Summarize this PDF." }]
        });

        assert!(!take_initial_report_billing_marker(&mut body));
        assert!(body.get("__june").is_none());
    }
}
