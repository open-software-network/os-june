use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use scribe_config::IssueReportsConfig;
use scribe_domain::{DomainError, IssueReport, IssueReportSink};
use serde::{Deserialize, Serialize};

/// Files issue reports as Issues in the os-platform tracker, tagged with the
/// configured label (default `bug`). Uses only os-platform's stock API:
/// attachments are uploaded first (best-effort — a failed upload never
/// blocks the report; the names are listed in the body either way), the
/// Issue is created with `type: bug`, and the label is attached afterwards
/// via the labels PUT — creating the label in the Project the first time.
/// Every step after the create is best-effort: an Issue without its tag
/// beats a lost report.
pub struct OsPlatformIssueReportSink {
    http: reqwest::Client,
    api_url: String,
    api_key: String,
    org: String,
    project: String,
    label: String,
    reward_asset: String,
}

/// fellow's `ApiResponse` envelope — same shape as ours.
#[derive(Deserialize)]
struct FellowEnvelope<T> {
    data: Option<T>,
    success: bool,
    message: Option<String>,
}

#[derive(Deserialize)]
struct FellowFile {
    id: String,
}

#[derive(Deserialize)]
struct FellowIssue {
    external_id: String,
    /// The labels PUT addresses the Issue by its per-Org number.
    number_in_org: i64,
}

impl OsPlatformIssueReportSink {
    /// `None` when the tracker isn't configured — the caller falls through
    /// to the webhook/log sinks.
    pub fn from_config(http: reqwest::Client, config: &IssueReportsConfig) -> Option<Self> {
        let api_url = config.os_platform_api_url.trim();
        let api_key = config.os_platform_api_key.trim();
        let org = config.os_platform_org.trim();
        let project = config.os_platform_project.trim();
        if api_url.is_empty() || api_key.is_empty() || org.is_empty() || project.is_empty() {
            return None;
        }
        Some(Self {
            http,
            api_url: api_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
            org: org.to_string(),
            project: project.to_string(),
            label: config.os_platform_label.trim().to_string(),
            reward_asset: config.os_platform_reward_asset.trim().to_string(),
        })
    }

    async fn upload_attachments(&self, report: &IssueReport) -> Vec<String> {
        let mut file_ids = Vec::new();
        for attachment in &report.attachments {
            let part = match reqwest::multipart::Part::bytes(attachment.bytes.clone())
                .file_name(attachment.name.clone())
                .mime_str(&attachment.content_type)
            {
                Ok(part) => part,
                Err(error) => {
                    tracing::warn!(%error, name = %attachment.name, "issue_reports: skipping attachment with invalid content type");
                    continue;
                }
            };
            let form = reqwest::multipart::Form::new().part("file", part);
            let uploaded: Result<FellowEnvelope<FellowFile>, _> = async {
                self.http
                    .post(format!("{}/v1/files", self.api_url))
                    .bearer_auth(&self.api_key)
                    .multipart(form)
                    .send()
                    .await?
                    .json::<FellowEnvelope<FellowFile>>()
                    .await
            }
            .await;
            match uploaded {
                Ok(envelope) if envelope.success => {
                    if let Some(file) = envelope.data {
                        file_ids.push(file.id);
                    }
                }
                Ok(envelope) => {
                    tracing::warn!(
                        message = envelope.message.as_deref().unwrap_or(""),
                        name = %attachment.name,
                        "issue_reports: os-platform rejected attachment upload"
                    );
                }
                Err(error) => {
                    tracing::warn!(%error, name = %attachment.name, "issue_reports: attachment upload failed");
                }
            }
        }
        file_ids
    }

    async fn create_issue(
        &self,
        report: &IssueReport,
        file_ids: &[String],
    ) -> Result<FellowEnvelope<FellowIssue>, DomainError> {
        let mut body = serde_json::json!({
            "title": issue_title(&report.description),
            "body_markdown": issue_body(report),
            "reward_amount_units": "0",
            "type": "bug",
            "status": "todo",
            "file_ids": file_ids,
        });
        if !self.reward_asset.is_empty() {
            body["asset_symbol"] = serde_json::Value::String(self.reward_asset.clone());
        }
        self.http
            .post(format!(
                "{}/v1/orgs/{}/projects/{}/bounties",
                self.api_url, self.org, self.project
            ))
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                tracing::error!(%error, "issue_reports: os-platform transport error");
                DomainError::UpstreamProvider
            })?
            .json::<FellowEnvelope<FellowIssue>>()
            .await
            .map_err(|error| {
                tracing::error!(%error, "issue_reports: os-platform returned a malformed envelope");
                DomainError::UpstreamProvider
            })
    }

    /// Attaches the configured label via the labels PUT (set-replace; a
    /// just-created Issue has no labels to clobber). Returns the envelope
    /// so the caller can spot the label-doesn't-exist rejection.
    async fn put_label(&self, number_in_org: i64) -> Option<FellowEnvelope<serde_json::Value>> {
        let body = serde_json::json!({ "label_slugs": [self.label] });
        let response = self
            .http
            .put(format!(
                "{}/v1/orgs/{}/bounties/{}/labels",
                self.api_url, self.org, number_in_org
            ))
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await;
        match response {
            Ok(response) => response.json().await.ok(),
            Err(error) => {
                tracing::warn!(%error, "issue_reports: label request failed");
                None
            }
        }
    }

    /// Creates the configured label in the target Project. The color is
    /// fixed; an "already exists" rejection is fine — the retry will
    /// resolve the slug either way.
    async fn ensure_label(&self) -> bool {
        let body = serde_json::json!({
            "name": "Bug",
            "color": "#ef4444",
            "slug": self.label,
        });
        let response = self
            .http
            .post(format!(
                "{}/v1/orgs/{}/projects/{}/labels",
                self.api_url, self.org, self.project
            ))
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await;
        match response {
            Ok(response) => response.status().is_success(),
            Err(error) => {
                tracing::warn!(%error, "issue_reports: could not create the report label");
                false
            }
        }
    }

    /// Best-effort tagging after the Issue exists. First report into a
    /// Project: the label won't exist yet, so the missing-label rejection
    /// creates it and retries once. Failure here never fails the delivery —
    /// the Issue is already filed (and carries `type: bug` regardless).
    async fn tag_issue(&self, number_in_org: i64) {
        if self.label.is_empty() {
            return;
        }
        let attached = match self.put_label(number_in_org).await {
            Some(envelope) if envelope.success => true,
            Some(envelope) if envelope.message.as_deref().is_some_and(is_missing_label) => {
                self.ensure_label().await
                    && self
                        .put_label(number_in_org)
                        .await
                        .is_some_and(|retry| retry.success)
            }
            _ => false,
        };
        if !attached {
            tracing::warn!(
                number_in_org,
                label = %self.label,
                "issue_reports: issue filed but the label could not be attached"
            );
        }
    }
}

#[async_trait]
impl IssueReportSink for OsPlatformIssueReportSink {
    async fn deliver(&self, report: IssueReport) -> Result<(), DomainError> {
        let file_ids = self.upload_attachments(&report).await;

        let envelope = self.create_issue(&report, &file_ids).await?;
        if !envelope.success {
            tracing::error!(
                message = envelope.message.as_deref().unwrap_or(""),
                "issue_reports: os-platform rejected the issue"
            );
            return Err(DomainError::UpstreamProvider);
        }
        let issue = envelope.data.as_ref();
        if let Some(issue) = issue {
            self.tag_issue(issue.number_in_org).await;
        }
        tracing::info!(
            issue = issue.map_or("", |issue| issue.external_id.as_str()),
            user_id = %report.user_id.0,
            attachments = file_ids.len(),
            "issue_reports: report filed as an os-platform issue"
        );
        Ok(())
    }
}

fn is_missing_label(message: &str) -> bool {
    message.contains("label(s) not found")
}

const ISSUE_TITLE_MAX_CHARS: usize = 120;

/// Strips the report form's field labels so a line's *content* drives the
/// title: "What happened: X" yields "X", and a bare label line yields ""
/// (and is skipped by the caller).
fn report_line_content(line: &str) -> &str {
    for label in ["What happened:", "What I expected:"] {
        if let Some(rest) = line.strip_prefix(label) {
            return rest.trim();
        }
    }
    if line.starts_with("Extra details") {
        return line.rsplit_once(':').map_or("", |(_, rest)| rest.trim());
    }
    line
}

/// Title from the report's content, truncated on a char boundary. The
/// app's report form opens with a canned intro and field labels; the first
/// line with actual content wins. The full description is always in the
/// body.
fn issue_title(description: &str) -> String {
    let first_line = description
        .lines()
        .map(str::trim)
        .map(report_line_content)
        .find(|line| !line.is_empty() && *line != "I want to report an issue with June.")
        .unwrap_or("(no description)");
    let mut title = String::with_capacity(ISSUE_TITLE_MAX_CHARS + 16);
    title.push_str("June report: ");
    for (count, ch) in first_line.chars().enumerate() {
        if count >= ISSUE_TITLE_MAX_CHARS {
            title.push('…');
            break;
        }
        title.push(ch);
    }
    title
}

fn issue_body(report: &IssueReport) -> String {
    use std::fmt::Write as _;

    let mut body = String::new();
    body.push_str("## Report\n\n");
    body.push_str(report.description.trim());
    body.push('\n');
    if let Some(diagnosis) = report
        .agent_diagnosis
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body.push_str("\n## Agent diagnosis\n\n");
        body.push_str(diagnosis);
        body.push('\n');
    }
    body.push_str("\n## Metadata\n\n");
    let _ = writeln!(body, "- Reporter: `{}`", report.user_id.0);
    if let Some(session_id) = report.session_id.as_deref().filter(|v| !v.is_empty()) {
        let _ = writeln!(body, "- Session: `{session_id}`");
    }
    if let Some(version) = report.app_version.as_deref().filter(|v| !v.is_empty()) {
        let _ = writeln!(body, "- App version: {version}");
    }
    if let Some(platform) = report.platform.as_deref().filter(|v| !v.is_empty()) {
        let _ = writeln!(body, "- Platform: {platform}");
    }
    if !report.attachment_names.is_empty() {
        let _ = writeln!(
            body,
            "- Attachments named by the user: {}",
            report.attachment_names.join(", ")
        );
    }
    body
}

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
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
        };
        let sink = WebhookIssueReportSink::from_config(reqwest::Client::new(), &config)
            .expect("configured sink");

        assert_eq!(
            sink.deliver(report()).await,
            Err(DomainError::UpstreamProvider)
        );
    }
}

#[cfg(test)]
mod issue_title_tests {
    use super::issue_title;

    #[test]
    fn title_prefers_the_what_happened_line() {
        let description = "I want to report an issue with June.\n\nWhat happened: recorder freezes on pause\n\nWhat I expected:\n";
        assert_eq!(
            issue_title(description),
            "June report: recorder freezes on pause"
        );
    }

    #[test]
    fn title_skips_the_canned_intro_when_what_happened_is_empty() {
        let description =
            "I want to report an issue with June.\n\nWhat happened:\n\nIt crashed twice today.";
        assert_eq!(
            issue_title(description),
            "June report: It crashed twice today."
        );
    }

    #[test]
    fn title_falls_back_for_free_form_reports() {
        assert_eq!(
            issue_title("The recorder freezes\nwhen I pause it"),
            "June report: The recorder freezes"
        );
    }
}

#[cfg(test)]
mod os_platform_tests {
    use super::*;
    use scribe_domain::UserId;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn report() -> IssueReport {
        IssueReport {
            user_id: UserId("usr_test".to_string()),
            description: "The recorder freezes\nwhen I pause it".to_string(),
            agent_diagnosis: Some("Likely the audio capture thread".to_string()),
            attachment_names: vec!["screenshot.png".to_string()],
            attachments: vec![scribe_domain::IssueReportAttachment {
                name: "screenshot.png".to_string(),
                content_type: "image/png".to_string(),
                bytes: b"png-bytes".to_vec(),
            }],
            session_id: Some("session-1".to_string()),
            app_version: Some("0.0.7".to_string()),
            platform: Some("macos".to_string()),
        }
    }

    fn config(api_url: &str) -> IssueReportsConfig {
        IssueReportsConfig {
            os_platform_api_url: api_url.to_string(),
            os_platform_api_key: "osk_test".to_string(),
            os_platform_org: "open-software".to_string(),
            os_platform_project: "june".to_string(),
            os_platform_reward_asset: "POINTS".to_string(),
            ..Default::default()
        }
    }

    fn sink(server: &MockServer) -> OsPlatformIssueReportSink {
        OsPlatformIssueReportSink::from_config(reqwest::Client::new(), &config(&server.uri()))
            .expect("configured sink")
    }

    fn issue_created() -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "external_id": "OSN-7", "number_in_org": 7 },
            "success": true,
        }))
    }

    fn labels_set() -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "external_id": "OSN-7", "number_in_org": 7 },
            "success": true,
        }))
    }

    fn label_missing() -> ResponseTemplate {
        ResponseTemplate::new(422).set_body_json(serde_json::json!({
            "data": null,
            "success": false,
            "error_code": 4201,
            "message": "label(s) not found in project: bug",
        }))
    }

    #[test]
    fn os_platform_sink_requires_full_config() {
        let mut incomplete = config("https://fellow.test");
        incomplete.os_platform_api_key = String::new();
        assert!(
            OsPlatformIssueReportSink::from_config(reqwest::Client::new(), &incomplete).is_none()
        );
        assert!(
            OsPlatformIssueReportSink::from_config(
                reqwest::Client::new(),
                &IssueReportsConfig::default()
            )
            .is_none()
        );
    }

    #[tokio::test]
    async fn os_platform_sink_files_a_bug_tagged_issue_with_attachments() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/files"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": { "id": "fil_1" },
                "success": true,
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/open-software/projects/june/bounties"))
            .and(body_partial_json(serde_json::json!({
                "title": "June report: The recorder freezes",
                "reward_amount_units": "0",
                "asset_symbol": "POINTS",
                "type": "bug",
                "status": "todo",
                "file_ids": ["fil_1"],
            })))
            .respond_with(issue_created())
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/v1/orgs/open-software/bounties/7/labels"))
            .and(body_partial_json(serde_json::json!({
                "label_slugs": ["bug"],
            })))
            .respond_with(labels_set())
            .expect(1)
            .mount(&server)
            .await;

        assert!(sink(&server).deliver(report()).await.is_ok());
    }

    #[tokio::test]
    async fn os_platform_sink_creates_the_label_on_first_use() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/files"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        // The attachment-upload failure above never blocks the report —
        // file_ids just ends up empty.
        Mock::given(method("POST"))
            .and(path("/v1/orgs/open-software/projects/june/bounties"))
            .and(body_partial_json(serde_json::json!({ "file_ids": [] })))
            .respond_with(issue_created())
            .expect(1)
            .mount(&server)
            .await;
        // First labels PUT: the label doesn't exist in the Project yet.
        // After the label create, the retried PUT lands.
        Mock::given(method("PUT"))
            .and(path("/v1/orgs/open-software/bounties/7/labels"))
            .respond_with(label_missing())
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/open-software/projects/june/labels"))
            .and(body_partial_json(serde_json::json!({
                "name": "Bug",
                "slug": "bug",
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": { "slug": "bug" },
                "success": true,
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/v1/orgs/open-software/bounties/7/labels"))
            .respond_with(labels_set())
            .expect(1)
            .mount(&server)
            .await;

        assert!(sink(&server).deliver(report()).await.is_ok());
    }

    #[tokio::test]
    async fn os_platform_sink_keeps_the_issue_when_the_label_cannot_be_attached() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/files"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/open-software/projects/june/bounties"))
            .respond_with(issue_created())
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/v1/orgs/open-software/bounties/7/labels"))
            .respond_with(label_missing())
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/open-software/projects/june/labels"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&server)
            .await;

        // The Issue exists; a permanently missing label must not fail the
        // delivery (the report would be re-shown to the user as unsent).
        assert!(sink(&server).deliver(report()).await.is_ok());
    }

    #[tokio::test]
    async fn os_platform_sink_surfaces_rejections_as_upstream_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/files"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/open-software/projects/june/bounties"))
            .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
                "data": null,
                "success": false,
                "error_code": 3001,
                "message": "caller is not an org member",
            })))
            .mount(&server)
            .await;

        let result = sink(&server).deliver(report()).await;
        assert!(matches!(result, Err(DomainError::UpstreamProvider)));
    }
}
