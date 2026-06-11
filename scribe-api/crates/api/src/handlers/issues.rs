use crate::{
    auth::authenticated_user, envelope::ApiResponse, error::ApiError, state::ApiState, validation,
};
use axum::{Json, extract::State, http::HeaderMap};
use scribe_domain::{DomainError, IssueReport};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueReportRequest {
    /// The user's report as they typed it in the app.
    pub description: String,
    /// The agent's diagnostic assessment of the issue, when one was produced.
    #[serde(default)]
    pub agent_diagnosis: Option<String>,
    #[serde(default)]
    pub attachment_names: Vec<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueReportResponse {
    pub received: bool,
}

impl IssueReportRequest {
    fn validate(&self) -> Result<(), ApiError> {
        if self.description.trim().is_empty() {
            return Err(ApiError::bad_request("description_required".to_string()));
        }
        validation::validate_text_len(
            "description",
            &self.description,
            validation::MAX_ISSUE_DESCRIPTION_CHARS,
        )?;
        validation::validate_optional_text_len(
            "agent_diagnosis",
            self.agent_diagnosis.as_deref(),
            validation::MAX_ISSUE_DIAGNOSIS_CHARS,
        )?;
        if self.attachment_names.len() > validation::MAX_ISSUE_ATTACHMENTS {
            return Err(ApiError::bad_request(
                "attachment_names_too_many".to_string(),
            ));
        }
        for name in &self.attachment_names {
            validation::validate_text_len("attachment_name", name, validation::MAX_TITLE_CHARS)?;
        }
        validation::validate_optional_text_len(
            "session_id",
            self.session_id.as_deref(),
            validation::MAX_ID_CHARS,
        )?;
        validation::validate_optional_text_len(
            "app_version",
            self.app_version.as_deref(),
            validation::MAX_ID_CHARS,
        )?;
        validation::validate_optional_text_len(
            "platform",
            self.platform.as_deref(),
            validation::MAX_ID_CHARS,
        )?;
        Ok(())
    }
}

pub(crate) async fn submit(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<IssueReportRequest>,
) -> Result<Json<ApiResponse<IssueReportResponse>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    request.validate()?;
    state
        .issue_reports()
        .deliver(IssueReport {
            user_id,
            description: request.description,
            agent_diagnosis: request.agent_diagnosis,
            attachment_names: request.attachment_names,
            session_id: request.session_id,
            app_version: request.app_version,
            platform: request.platform,
        })
        .await
        .map_err(|error| match error {
            DomainError::InvalidInput { reason } => ApiError::bad_request(reason),
            _ => ApiError::Upstream,
        })?;
    Ok(Json(ApiResponse::ok(IssueReportResponse {
        received: true,
    })))
}
