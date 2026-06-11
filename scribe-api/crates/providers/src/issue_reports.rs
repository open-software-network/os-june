use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use scribe_config::IssueReportsConfig;
use scribe_domain::{DomainError, IssueReport, IssueReportSink};
use serde::Serialize;

/// Forwards issue reports as a JSON POST to the configured webhook.
pub struct WebhookIssueReportSink {
    http: reqwest::Client,
    webhook_url: String,
}

impl WebhookIssueReportSink {
    /// `None` when no webhook is configured — the caller falls back to the
    /// log sink so reports are never dropped silently.
    pub fn from_config(http: reqwest::Client, config: &IssueReportsConfig) -> Option<Self> {
        let webhook_url = config.webhook_url.trim();
        if webhook_url.is_empty() {
            return None;
        }
        Some(Self {
            http,
            webhook_url: webhook_url.to_string(),
        })
    }
}

#[async_trait]
impl IssueReportSink for WebhookIssueReportSink {
    async fn deliver(&self, report: IssueReport) -> Result<(), DomainError> {
        let body = IssueReportWire::from(&report);
        let response = self
            .http
            .post(&self.webhook_url)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                tracing::error!(%error, "issue_reports: webhook transport error");
                DomainError::UpstreamProvider
            })?;
        let status = response.status();
        if !status.is_success() {
            // Reading the body also drains the connection back to the pool;
            // an early return would otherwise hold it until drop.
            let body = response.text().await.unwrap_or_default();
            tracing::error!(%status, body_bytes = body.len(), "issue_reports: webhook rejected report");
            return Err(DomainError::UpstreamProvider);
        }
        tracing::info!(
            user_id = %report.user_id.0,
            has_diagnosis = report.agent_diagnosis.is_some(),
            attachments = report.attachments.len(),
            "issue_reports: report forwarded to webhook"
        );
        Ok(())
    }
}

/// Fallback sink when no webhook is configured: the report becomes a
/// structured log line, so it still reaches whoever reads the service logs.
pub struct LogIssueReportSink;

#[async_trait]
impl IssueReportSink for LogIssueReportSink {
    async fn deliver(&self, report: IssueReport) -> Result<(), DomainError> {
        tracing::warn!(
            user_id = %report.user_id.0,
            description = %report.description,
            agent_diagnosis = report.agent_diagnosis.as_deref().unwrap_or(""),
            attachment_names = ?report.attachment_names,
            // The Debug impl reports name/type/length only — uploaded bytes
            // never reach the logs.
            attachments = ?report.attachments,
            session_id = report.session_id.as_deref().unwrap_or(""),
            app_version = report.app_version.as_deref().unwrap_or(""),
            platform = report.platform.as_deref().unwrap_or(""),
            "issue_reports: no webhook configured; report logged only"
        );
        Ok(())
    }
}

#[derive(Serialize)]
struct IssueReportWire<'a> {
    user_id: &'a str,
    description: &'a str,
    agent_diagnosis: Option<&'a str>,
    attachment_names: &'a [String],
    attachments: Vec<AttachmentWire<'a>>,
    session_id: Option<&'a str>,
    app_version: Option<&'a str>,
    platform: Option<&'a str>,
}

#[derive(Serialize)]
struct AttachmentWire<'a> {
    name: &'a str,
    content_type: &'a str,
    bytes_base64: String,
}

impl<'a> From<&'a IssueReport> for IssueReportWire<'a> {
    fn from(report: &'a IssueReport) -> Self {
        Self {
            user_id: &report.user_id.0,
            description: &report.description,
            agent_diagnosis: report.agent_diagnosis.as_deref(),
            attachment_names: &report.attachment_names,
            attachments: report
                .attachments
                .iter()
                .map(|attachment| AttachmentWire {
                    name: &attachment.name,
                    content_type: &attachment.content_type,
                    bytes_base64: BASE64.encode(&attachment.bytes),
                })
                .collect(),
            session_id: report.session_id.as_deref(),
            app_version: report.app_version.as_deref(),
            platform: report.platform.as_deref(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use scribe_domain::UserId;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn report() -> IssueReport {
        IssueReport {
            user_id: UserId("usr_test".to_string()),
            description: "The recorder freezes".to_string(),
            agent_diagnosis: Some("Likely the audio capture thread".to_string()),
            attachment_names: vec!["screenshot.png".to_string()],
            attachments: vec![scribe_domain::IssueReportAttachment {
                name: "screenshot.png".to_string(),
                content_type: "image/png".to_string(),
                bytes: b"png-bytes".to_vec(),
            }],
            session_id: Some("session-1".to_string()),
            app_version: Some("0.0.5".to_string()),
            platform: Some("macos".to_string()),
        }
    }

    #[test]
    fn from_config_requires_a_webhook_url() {
        let config = IssueReportsConfig {
            webhook_url: "  ".to_string(),
        };
        assert!(WebhookIssueReportSink::from_config(reqwest::Client::new(), &config).is_none());
    }

    #[tokio::test]
    async fn webhook_sink_posts_the_report_as_json() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/hook"))
            .and(body_partial_json(serde_json::json!({
                "user_id": "usr_test",
                "description": "The recorder freezes",
                "agent_diagnosis": "Likely the audio capture thread",
                "attachment_names": ["screenshot.png"],
                "attachments": [{
                    "name": "screenshot.png",
                    "content_type": "image/png",
                    "bytes_base64": BASE64.encode(b"png-bytes"),
                }],
            })))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let config = IssueReportsConfig {
            webhook_url: format!("{}/hook", server.uri()),
        };
        let sink = WebhookIssueReportSink::from_config(reqwest::Client::new(), &config)
            .expect("configured sink");

        assert!(sink.deliver(report()).await.is_ok());
    }

    #[tokio::test]
    async fn webhook_sink_surfaces_rejections_as_upstream_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let config = IssueReportsConfig {
            webhook_url: server.uri(),
        };
        let sink = WebhookIssueReportSink::from_config(reqwest::Client::new(), &config)
            .expect("configured sink");

        assert_eq!(
            sink.deliver(report()).await,
            Err(DomainError::UpstreamProvider)
        );
    }
}
