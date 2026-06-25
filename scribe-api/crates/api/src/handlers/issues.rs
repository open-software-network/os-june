use crate::{
    auth::authenticated_user, envelope::ApiResponse, error::ApiError, multipart::multipart_invalid,
    state::ApiState, validation,
};
use axum::{
    Json,
    extract::{Multipart, State},
    http::HeaderMap,
};
use scribe_domain::{DomainError, IssueReport, IssueReportAttachment};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueReportResponse {
    pub received: bool,
}

/// Multipart form fields of an issue report. Text fields use the same
/// camelCase names as the rest of the wire; attachment files arrive as
/// repeated `attachment` file parts, and `attachmentName` text parts list
/// every attached file, including ones whose bytes were not uploaded.
#[derive(Default)]
struct IssueReportFields {
    category: Option<String>,
    description: String,
    agent_diagnosis: Option<String>,
    attachment_names: Vec<String>,
    attachments: Vec<IssueReportAttachment>,
    session_id: Option<String>,
    app_version: Option<String>,
    platform: Option<String>,
}

impl IssueReportFields {
    async fn collect(mut multipart: Multipart) -> Result<Self, ApiError> {
        let mut fields = Self::default();
        while let Some(field) = multipart.next_field().await.map_err(multipart_invalid)? {
            let name = field.name().map(ToString::to_string).unwrap_or_default();
            match name.as_str() {
                "attachment" => {
                    let file_name = field
                        .file_name()
                        .map_or_else(|| "attachment".to_string(), ToString::to_string);
                    let content_type = field.content_type().map_or_else(
                        || "application/octet-stream".to_string(),
                        ToString::to_string,
                    );
                    let bytes = field.bytes().await.map_err(multipart_invalid)?;
                    if bytes.len() > validation::MAX_ISSUE_ATTACHMENT_BYTES {
                        return Err(ApiError::PayloadTooLarge);
                    }
                    fields.attachments.push(IssueReportAttachment {
                        name: file_name,
                        content_type,
                        bytes: bytes.to_vec(),
                    });
                }
                "attachmentName" => {
                    fields
                        .attachment_names
                        .push(field.text().await.map_err(multipart_invalid)?);
                }
                "description" => {
                    fields.description = field.text().await.map_err(multipart_invalid)?;
                }
                "category" => {
                    fields.category = Some(field.text().await.map_err(multipart_invalid)?);
                }
                "agentDiagnosis" => {
                    fields.agent_diagnosis = Some(field.text().await.map_err(multipart_invalid)?);
                }
                "sessionId" => {
                    fields.session_id = Some(field.text().await.map_err(multipart_invalid)?);
                }
                "appVersion" => {
                    fields.app_version = Some(field.text().await.map_err(multipart_invalid)?);
                }
                "platform" => {
                    fields.platform = Some(field.text().await.map_err(multipart_invalid)?);
                }
                // Unknown fields are tolerated so older servers and newer
                // clients can drift without hard failures.
                _ => {}
            }
        }
        Ok(fields)
    }

    fn validate(&self) -> Result<(), ApiError> {
        if self.description.trim().is_empty() {
            return Err(ApiError::bad_request("description_required"));
        }
        validation::validate_text_len(
            "description",
            &self.description,
            validation::MAX_ISSUE_DESCRIPTION_CHARS,
        )?;
        validation::validate_optional_text_len(
            "category",
            self.category.as_deref(),
            validation::MAX_ID_CHARS,
        )?;
        validation::validate_optional_text_len(
            "agent_diagnosis",
            self.agent_diagnosis.as_deref(),
            validation::MAX_ISSUE_DIAGNOSIS_CHARS,
        )?;
        if self.attachment_names.len() > validation::MAX_ISSUE_ATTACHMENTS
            || self.attachments.len() > validation::MAX_ISSUE_ATTACHMENTS
        {
            return Err(ApiError::bad_request("attachments_too_many"));
        }
        for name in &self.attachment_names {
            validation::validate_text_len("attachment_name", name, validation::MAX_TITLE_CHARS)?;
        }
        for attachment in &self.attachments {
            validation::validate_text_len(
                "attachment_name",
                &attachment.name,
                validation::MAX_TITLE_CHARS,
            )?;
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
    multipart: Multipart,
) -> Result<Json<ApiResponse<IssueReportResponse>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let request = IssueReportFields::collect(multipart).await?;
    request.validate()?;
    state
        .issue_reports()
        .deliver(IssueReport {
            user_id,
            category: clean_optional_text(request.category),
            description: request.description,
            agent_diagnosis: request.agent_diagnosis,
            attachment_names: request.attachment_names,
            attachments: request.attachments,
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

fn clean_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
