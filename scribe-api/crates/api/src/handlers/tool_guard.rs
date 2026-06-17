use crate::{
    auth::authenticated_user, envelope::ApiResponse, error::ApiError, state::ApiState, validation,
};
use axum::{Json, extract::State, http::HeaderMap};
use scribe_domain::{
    ToolDestinationClass, ToolGuardAnalysis, ToolGuardCallAnalysisRequest,
    ToolGuardResultAnalysisRequest,
};
use serde::Deserialize;

/// Proxies a tool-call analysis to OS-Guard's Tool Guard. The desktop client
/// sends the pending tool call (arguments plus correlation fields); scribe sets
/// `caller_identity` from the authenticated principal, forwards the request with
/// the server-side gateway token, and relays the detection analysis. The client
/// applies the redaction operations and surfaces the advisories locally — scribe
/// neither executes the tool nor applies any redaction.
pub(crate) async fn analyze_call(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<ToolGuardCallBody>,
) -> Result<Json<ApiResponse<ToolGuardAnalysis>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let analyzer = state.tool_guard().ok_or(ApiError::ToolGuardUnavailable)?;
    request.validate()?;
    // caller_identity always comes from the verified token, never the body.
    let analysis = analyzer
        .analyze_call(ToolGuardCallAnalysisRequest {
            caller_identity: user_id.0,
            agent_turn_id: request.agent_turn_id,
            tool_call_id: request.tool_call_id,
            tool_name: request.tool_name,
            destination_id: request.destination_id,
            destination_class: request.destination_class,
            tool_schema_ref: request.tool_schema_ref,
            arguments: request.arguments,
            deadline_ms: request.deadline_ms,
            policy_context: request.policy_context,
        })
        .await?;
    Ok(Json(ApiResponse::ok(analysis)))
}

/// Proxies a tool-result analysis to OS-Guard's Tool Guard. Same proxy
/// semantics as `analyze_call`: scribe sets `caller_identity` from auth and
/// relays the analysis; the client applies the operations before reinjecting
/// the (redacted) result into the model context.
pub(crate) async fn analyze_result(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<ToolGuardResultBody>,
) -> Result<Json<ApiResponse<ToolGuardAnalysis>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let analyzer = state.tool_guard().ok_or(ApiError::ToolGuardUnavailable)?;
    request.validate()?;
    let analysis = analyzer
        .analyze_result(ToolGuardResultAnalysisRequest {
            caller_identity: user_id.0,
            agent_turn_id: request.agent_turn_id,
            tool_call_id: request.tool_call_id,
            destination_id: request.destination_id,
            destination_class: request.destination_class,
            result: request.result,
            deadline_ms: request.deadline_ms,
            policy_context: request.policy_context,
        })
        .await?;
    Ok(Json(ApiResponse::ok(analysis)))
}

/// Tool-call analysis request body. Deliberately omits `caller_identity`: the
/// client cannot supply its own identity — scribe derives it from auth.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolGuardCallBody {
    pub agent_turn_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub destination_id: String,
    pub destination_class: ToolDestinationClass,
    #[serde(default)]
    pub tool_schema_ref: Option<String>,
    pub arguments: serde_json::Value,
    pub deadline_ms: u64,
    #[serde(default)]
    pub policy_context: Option<serde_json::Value>,
}

impl ToolGuardCallBody {
    fn validate(&self) -> Result<(), ApiError> {
        validate_correlation_id("agentTurnId", &self.agent_turn_id)?;
        validate_correlation_id("toolCallId", &self.tool_call_id)?;
        validate_tool_name(&self.tool_name)?;
        validate_correlation_id("destinationId", &self.destination_id)?;
        validation::validate_optional_text_len(
            "toolSchemaRef",
            self.tool_schema_ref.as_deref(),
            validation::MAX_MODEL_CHARS,
        )?;
        validate_deadline(self.deadline_ms)?;
        Ok(())
    }
}

/// Tool-result analysis request body. As with the call body, `caller_identity`
/// is intentionally absent and set from auth.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolGuardResultBody {
    pub agent_turn_id: String,
    pub tool_call_id: String,
    pub destination_id: String,
    pub destination_class: ToolDestinationClass,
    pub result: serde_json::Value,
    pub deadline_ms: u64,
    #[serde(default)]
    pub policy_context: Option<serde_json::Value>,
}

impl ToolGuardResultBody {
    fn validate(&self) -> Result<(), ApiError> {
        validate_correlation_id("agentTurnId", &self.agent_turn_id)?;
        validate_correlation_id("toolCallId", &self.tool_call_id)?;
        validate_correlation_id("destinationId", &self.destination_id)?;
        validate_deadline(self.deadline_ms)?;
        Ok(())
    }
}

fn validate_correlation_id(field: &str, value: &str) -> Result<(), ApiError> {
    if value.trim().is_empty() {
        return Err(ApiError::bad_request(format!("{field}_required")));
    }
    validation::validate_text_len(field, value, validation::MAX_ID_CHARS)
}

fn validate_tool_name(value: &str) -> Result<(), ApiError> {
    if value.trim().is_empty() {
        return Err(ApiError::bad_request("toolName_required"));
    }
    validation::validate_text_len("toolName", value, validation::MAX_MODEL_CHARS)
}

fn validate_deadline(deadline_ms: u64) -> Result<(), ApiError> {
    if deadline_ms == 0 {
        return Err(ApiError::bad_request("deadlineMs_required"));
    }
    Ok(())
}
