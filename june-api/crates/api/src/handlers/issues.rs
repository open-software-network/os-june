use crate::{
    auth::authenticated_user,
    envelope::{self, ApiResponse},
    error::ApiError,
    multipart::multipart_invalid,
    state::{ApiState, IssueReportRequestContext},
    validation,
};
use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Extension, Multipart, State},
    http::{HeaderMap, StatusCode, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
};
use june_domain::{DomainError, IssueReport, IssueReportAttachment, IssueReportDelivery};
use serde::Serialize;
use std::{convert::Infallible, time::Duration};
use tokio::{sync::mpsc, time::MissedTickBehavior};
use tokio_stream::wrappers::UnboundedReceiverStream;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueReportResponse {
    pub received: bool,
    pub skipped_attachment_names: Vec<String>,
}

/// Multipart form fields of an issue report. Text fields use the same
/// camelCase names as the rest of the wire; attachment files arrive as
/// repeated `attachment` file parts, and `attachmentName` text parts list
/// every attached file, including ones whose bytes could not be sent.
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
    stream: bool,
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
                        bytes,
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
                "stream" => {
                    fields.stream = field.text().await.map_err(multipart_invalid)?.trim() == "true";
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
    Extension(request_context): Extension<IssueReportRequestContext>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;
    let request = IssueReportFields::collect(multipart).await?;
    request.validate()?;
    let stream = request.stream;
    let report = IssueReport {
        user_id,
        category: clean_optional_text(request.category),
        description: request.description,
        agent_diagnosis: request.agent_diagnosis,
        attachment_names: request.attachment_names,
        attachments: request.attachments,
        session_id: request.session_id,
        app_version: request.app_version,
        platform: request.platform,
    };

    if stream {
        return Ok(stream_submit(state, report, request_context));
    }

    let delivery = state
        .issue_reports()
        .submit(report)
        .await
        .map_err(issue_report_error)?;
    Ok(Json(issue_report_response(delivery)).into_response())
}

fn stream_submit(
    state: ApiState,
    report: IssueReport,
    request_context: IssueReportRequestContext,
) -> Response {
    // The background task intentionally survives a client disconnect so a
    // report already accepted by June can finish delivery. The shared permit
    // remains owned by this task as well as the response-body wrapper, keeping
    // the next platform-sized request out until both lifetimes are over.
    let (tx, rx) = mpsc::unbounded_channel::<Result<Bytes, Infallible>>();
    tokio::spawn(async move {
        let _permit = request_context.permit;
        let delivery = tokio::time::timeout_at(
            request_context.deadline.instant(),
            state.issue_reports().submit(report),
        );
        tokio::pin!(delivery);
        let mut keep_alive = tokio::time::interval(Duration::from_secs(10));
        keep_alive.set_missed_tick_behavior(MissedTickBehavior::Skip);
        keep_alive.tick().await;

        loop {
            tokio::select! {
                result = &mut delivery => {
                    let event = match result {
                        Ok(Ok(delivery)) => result_event(delivery).unwrap_or_else(|_| {
                            error_event(ApiError::Internal.response_parts())
                        }),
                        Ok(Err(error)) => error_event(issue_report_error(error).response_parts()),
                        Err(_elapsed) => error_event(envelope::timeout_response_parts()),
                    };
                    let _ = tx.send(Ok(Bytes::from(event)));
                    break;
                }
                _ = keep_alive.tick() => {
                    // Comment line only: the terminal result/error event owns
                    // the blank line that dispatches the SSE frame.
                    let _ = tx.send(Ok(Bytes::from_static(b": keep-alive\n")));
                }
            }
        }
    });

    (
        StatusCode::OK,
        [(CONTENT_TYPE, "text/event-stream")],
        Body::from_stream(UnboundedReceiverStream::new(rx)),
    )
        .into_response()
}

fn issue_report_response(delivery: IssueReportDelivery) -> ApiResponse<IssueReportResponse> {
    ApiResponse::ok(IssueReportResponse {
        received: true,
        skipped_attachment_names: delivery.unattached_names,
    })
}

fn result_event(delivery: IssueReportDelivery) -> Result<String, serde_json::Error> {
    Ok(format!(
        "event: result\ndata: {}\n\n",
        serde_json::to_string(&issue_report_response(delivery))?
    ))
}

fn error_event((status, body): (StatusCode, serde_json::Value)) -> String {
    let data = serde_json::json!({
        "status": status.as_u16(),
        "body": body,
    });
    format!("event: error\ndata: {data}\n\n")
}

fn issue_report_error(error: DomainError) -> ApiError {
    match error {
        DomainError::InvalidInput { reason } => ApiError::bad_request(reason),
        // A billing/metering outage must keep its distinct 503 even on this
        // direct DomainError -> ApiError path (issue delivery never goes
        // through ServiceError). Exhaustive match so a new DomainError variant
        // forces a deliberate mapping instead of silently collapsing into an
        // upstream provider failure.
        DomainError::MeteringProvider => ApiError::Metering,
        DomainError::UpstreamProvider
        | DomainError::ModelNotPriced
        | DomainError::InsufficientCredits => ApiError::Upstream,
    }
}

fn clean_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
