use async_trait::async_trait;
use scribe_config::IssueReportsConfig;
use scribe_domain::{DomainError, IssueReport, IssueReportSink};
use serde::Deserialize;

/// Files user reports as Issues in the os-platform tracker. Uses only
/// os-platform's stock API: attachments are uploaded first (best-effort — a
/// failed upload never blocks the report; the names are listed in the body
/// either way), the Issue is created with the report category mapped to an
/// os-platform Issue type, and the configured label is attached afterwards
/// via the labels PUT when it applies.
/// Delivery to os-platform is best-effort: the sink retries without a Project
/// destination and finally logs the report rather than surfacing delivery
/// failures to the user.
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

#[derive(Clone, Copy)]
enum IssueCreateDestination {
    Project,
    OrgFallback,
}

struct IssueCreateEntry {
    title: String,
    body_markdown: String,
}

struct SplitDiagnosisIssue {
    title: String,
    diagnosis: String,
    preamble: Option<String>,
}

struct ProjectIssueFailure<'a> {
    report: &'a IssueReport,
    file_ids: &'a [String],
    project_message: &'a str,
}

struct IssueCreateRequest<'a> {
    url: String,
    report: &'a IssueReport,
    entry: &'a IssueCreateEntry,
    file_ids: &'a [String],
}

impl IssueCreateDestination {
    fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::OrgFallback => "org_fallback",
        }
    }
}

impl OsPlatformIssueReportSink {
    /// `None` when the tracker isn't configured — the caller falls through
    /// to the structured log sink.
    pub fn from_config(http: reqwest::Client, config: &IssueReportsConfig) -> Option<Self> {
        let api_url = config.os_platform_api_url.trim();
        let api_key = config.os_platform_api_key.trim();
        let (org, project) = normalize_destination(
            config.os_platform_org.trim(),
            config.os_platform_project.trim(),
        )?;
        if api_url.is_empty() || api_key.is_empty() {
            return None;
        }
        Some(Self {
            http,
            api_url: api_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
            org,
            project,
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

    fn issue_create_body(
        &self,
        report: &IssueReport,
        entry: &IssueCreateEntry,
        file_ids: &[String],
    ) -> serde_json::Value {
        let mut body = serde_json::json!({
            "title": entry.title,
            "body_markdown": entry.body_markdown,
            "reward_amount_units": "0",
            "type": issue_type_for_report(report),
            "status": "todo",
            "file_ids": file_ids,
        });
        if !self.reward_asset.is_empty() {
            body["asset_symbol"] = serde_json::Value::String(self.reward_asset.clone());
        }
        body
    }

    async fn create_issue_at(
        &self,
        request: IssueCreateRequest<'_>,
    ) -> Result<FellowEnvelope<FellowIssue>, DomainError> {
        self.http
            .post(request.url)
            .bearer_auth(&self.api_key)
            .json(&self.issue_create_body(request.report, request.entry, request.file_ids))
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

    async fn create_project_issue(
        &self,
        report: &IssueReport,
        entry: &IssueCreateEntry,
        file_ids: &[String],
    ) -> Result<FellowEnvelope<FellowIssue>, DomainError> {
        self.create_issue_at(IssueCreateRequest {
            url: format!(
                "{}/v1/orgs/{}/projects/{}/bounties",
                self.api_url, self.org, self.project
            ),
            report,
            entry,
            file_ids,
        })
        .await
    }

    async fn create_org_issue(
        &self,
        report: &IssueReport,
        entry: &IssueCreateEntry,
        file_ids: &[String],
    ) -> Result<FellowEnvelope<FellowIssue>, DomainError> {
        self.create_issue_at(IssueCreateRequest {
            url: format!("{}/v1/orgs/{}/bounties", self.api_url, self.org),
            report,
            entry,
            file_ids,
        })
        .await
    }

    fn fallback_to_log(&self, report: &IssueReport, reason: &str) {
        log_issue_report_delivery_failed(report, reason, &self.org, &self.project);
    }

    async fn create_org_issue_after_project_failure(
        &self,
        entry: &IssueCreateEntry,
        failure: ProjectIssueFailure<'_>,
    ) -> Option<(FellowEnvelope<FellowIssue>, IssueCreateDestination)> {
        match self
            .create_org_issue(failure.report, entry, failure.file_ids)
            .await
        {
            Ok(envelope) if envelope.success => {
                Some((envelope, IssueCreateDestination::OrgFallback))
            }
            Ok(envelope) => {
                tracing::error!(
                    failure.project_message,
                    org_message = envelope.message.as_deref().unwrap_or(""),
                    "issue_reports: os-platform rejected both project and org issue creates"
                );
                self.fallback_to_log(failure.report, "project_and_org_create_rejected");
                None
            }
            Err(_) => {
                self.fallback_to_log(failure.report, "org_create_transport_or_envelope_error");
                None
            }
        }
    }

    async fn create_issue_entry_or_log(
        &self,
        entry: &IssueCreateEntry,
        report: &IssueReport,
        file_ids: &[String],
    ) -> Option<(FellowEnvelope<FellowIssue>, IssueCreateDestination)> {
        match self.create_project_issue(report, entry, file_ids).await {
            Ok(project_envelope) if project_envelope.success => {
                Some((project_envelope, IssueCreateDestination::Project))
            }
            Ok(project_envelope) => {
                let project_message = project_envelope.message.as_deref().unwrap_or("");
                tracing::warn!(
                    message = project_message,
                    target_org = %self.org,
                    target_project = %self.project,
                    "issue_reports: os-platform rejected the project-scoped issue; retrying at org scope"
                );
                self.create_org_issue_after_project_failure(
                    entry,
                    ProjectIssueFailure {
                        report,
                        file_ids,
                        project_message,
                    },
                )
                .await
            }
            Err(_) => {
                let project_message = "project_create_transport_or_envelope_error";
                tracing::warn!(
                    message = project_message,
                    target_org = %self.org,
                    target_project = %self.project,
                    "issue_reports: project-scoped issue create failed before envelope; retrying at org scope"
                );
                self.create_org_issue_after_project_failure(
                    entry,
                    ProjectIssueFailure {
                        report,
                        file_ids,
                        project_message,
                    },
                )
                .await
            }
        }
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

    fn should_attach_configured_label(&self, report: &IssueReport) -> bool {
        if self.label.is_empty() {
            return false;
        }
        self.label != "bug" || issue_type_for_report(report) == "bug"
    }

    /// Best-effort tagging after the Issue exists. First report into a
    /// Project: the label won't exist yet, so the missing-label rejection
    /// creates it and retries once. Failure here never fails the delivery;
    /// the Issue is already filed.
    async fn tag_issue(
        &self,
        report: &IssueReport,
        number_in_org: i64,
        destination: IssueCreateDestination,
    ) {
        if !self.should_attach_configured_label(report) {
            return;
        }
        let attached = match self.put_label(number_in_org).await {
            Some(envelope) if envelope.success => true,
            Some(envelope) if envelope.message.as_deref().is_some_and(is_missing_label) => {
                match destination {
                    IssueCreateDestination::Project => {
                        self.ensure_label().await
                            && self
                                .put_label(number_in_org)
                                .await
                                .is_some_and(|retry| retry.success)
                    }
                    IssueCreateDestination::OrgFallback => {
                        tracing::warn!(
                            number_in_org,
                            label = %self.label,
                            target_org = %self.org,
                            target_project = %self.project,
                            destination = destination.as_str(),
                            "issue_reports: org-fallback issue filed without label because the configured project label is unavailable"
                        );
                        return;
                    }
                }
            }
            _ => false,
        };
        if !attached {
            tracing::warn!(
                number_in_org,
                label = %self.label,
                destination = destination.as_str(),
                "issue_reports: issue filed but the label could not be attached"
            );
        }
    }
}

fn normalize_destination(org: &str, project: &str) -> Option<(String, String)> {
    let org = org.trim_matches('/');
    if org.is_empty() || project.is_empty() {
        return None;
    }

    let project_parts: Vec<&str> = project.split('/').collect();
    if project_parts.iter().any(|segment| segment.is_empty()) || project_parts.len() > 2 {
        tracing::warn!(
            configured_project = %project,
            "issue_reports: ignoring malformed project destination"
        );
        return None;
    }

    if (org == "open-software" && project == "june") || project == "open-software/june" {
        tracing::warn!(
            configured_org = %org,
            configured_project = %project,
            normalized_org = "june",
            normalized_project = "bug-reports",
            "issue_reports: remapped legacy June issue report destination"
        );
        return Some(("june".to_string(), "bug-reports".to_string()));
    }

    let normalized_project = match project_parts.as_slice() {
        [project_slug] => *project_slug,
        [project_org, project_slug] if *project_org == org => *project_slug,
        [project_org, _] => {
            tracing::warn!(
                configured_org = %org,
                project_org = %project_org,
                configured_project = %project,
                "issue_reports: project destination org does not match configured org"
            );
            return None;
        }
        [] | [_, _, _, ..] => return None,
    };
    if normalized_project != project {
        tracing::warn!(
            configured_project = %project,
            normalized_project,
            configured_org = %org,
            "issue_reports: normalized legacy org/project destination"
        );
    }

    Some((org.to_string(), normalized_project.to_string()))
}

#[async_trait]
impl IssueReportSink for OsPlatformIssueReportSink {
    async fn deliver(&self, report: IssueReport) -> Result<(), DomainError> {
        let file_ids = self.upload_attachments(&report).await;
        let entries = issue_create_entries(&report);

        for entry in &entries {
            let Some((envelope, destination)) = self
                .create_issue_entry_or_log(entry, &report, &file_ids)
                .await
            else {
                continue;
            };
            let issue = envelope.data.as_ref();
            if let Some(issue) = issue {
                self.tag_issue(&report, issue.number_in_org, destination)
                    .await;
            }
            tracing::info!(
                issue = issue.map_or("", |issue| issue.external_id.as_str()),
                user_id = %report.user_id.0,
                attachments = file_ids.len(),
                split_issues = entries.len(),
                issue_type = issue_type_for_report(&report),
                destination = destination.as_str(),
                "issue_reports: report filed as an os-platform issue"
            );
        }
        Ok(())
    }
}

fn is_missing_label(message: &str) -> bool {
    message.contains("label(s) not found")
}

const ISSUE_TITLE_MAX_CHARS: usize = 120;
const MAX_SPLIT_ISSUES: usize = 10;

fn report_category(report: &IssueReport) -> Option<&str> {
    report
        .category
        .as_deref()
        .map(str::trim)
        .filter(|category| !category.is_empty())
}

fn issue_type_for_report(report: &IssueReport) -> &'static str {
    match report_category(report) {
        Some("bug") | None => "bug",
        Some("feature") => "feature",
        Some(_) => "other",
    }
}

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
    prefixed_issue_title(first_line)
}

/// Title from the diagnosis the report model already wrote. The report
/// prompt asks June to open with an `Issue 1: <short title>` heading, so a
/// single-issue report carries a model-written title we can lift verbatim
/// instead of slicing the first content line out of the raw description.
fn diagnosis_issue_title(diagnosis: &str) -> Option<String> {
    diagnosis.lines().find_map(parse_issue_heading)
}

fn prefixed_issue_title(summary: &str) -> String {
    let summary = summary.trim();
    let mut title = String::with_capacity(ISSUE_TITLE_MAX_CHARS + 16);
    title.push_str("June report: ");
    for (count, ch) in summary.chars().enumerate() {
        if count >= ISSUE_TITLE_MAX_CHARS {
            title.push('…');
            break;
        }
        title.push(ch);
    }
    title
}

fn issue_create_entries(report: &IssueReport) -> Vec<IssueCreateEntry> {
    let mut single_diagnosis_title = None;
    if let Some(diagnosis) = report.agent_diagnosis.as_deref() {
        let split_issues = split_agent_diagnosis(diagnosis);
        if split_issues.len() > 1 && split_issues.len() <= MAX_SPLIT_ISSUES {
            let total = split_issues.len();
            return split_issues
                .into_iter()
                .enumerate()
                .map(|(index, issue)| IssueCreateEntry {
                    title: prefixed_issue_title(&issue.title),
                    body_markdown: split_issue_body(report, &issue, index + 1, total),
                })
                .collect();
        }
        // Single-issue diagnosis: reuse the model's `Issue 1:` heading as the
        // title; fall back to the description when the heading is absent. A
        // diagnosis that split into more sections than the cap files as one
        // combined issue, so its first heading would undersell the rest —
        // keep the description-derived title there.
        if split_issues.is_empty() {
            single_diagnosis_title = diagnosis_issue_title(diagnosis);
        }
    }

    vec![IssueCreateEntry {
        title: single_diagnosis_title.map_or_else(
            || issue_title(&report.description),
            |title| prefixed_issue_title(&title),
        ),
        body_markdown: issue_body(report),
    }]
}

fn split_agent_diagnosis(diagnosis: &str) -> Vec<SplitDiagnosisIssue> {
    let mut headings = Vec::new();
    let mut offset = 0;
    for raw_line in diagnosis.split_inclusive('\n') {
        let line_without_newline = line_without_newline(raw_line);
        if let Some(title) = parse_issue_heading(line_without_newline) {
            headings.push((offset, offset + raw_line.len(), title));
        }
        offset += raw_line.len();
    }

    if headings.len() < 2 {
        return Vec::new();
    }

    let preamble = headings
        .first()
        .map(|(first_heading_start, _, _)| diagnosis[..*first_heading_start].trim())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let mut issues = Vec::new();
    for (index, (heading_start, content_start, title)) in headings.iter().enumerate() {
        let end = headings
            .get(index + 1)
            .map_or(diagnosis.len(), |(next_start, _, _)| *next_start);
        if *content_start > end || *heading_start >= diagnosis.len() {
            continue;
        }
        let raw_segment = &diagnosis[*content_start..end];
        let diagnosis = trim_common_diagnosis_tail(raw_segment).trim();
        if diagnosis.is_empty() {
            continue;
        }
        issues.push(SplitDiagnosisIssue {
            title: title.clone(),
            diagnosis: diagnosis.to_string(),
            preamble: preamble.clone(),
        });
    }
    issues
}

fn parse_issue_heading(line: &str) -> Option<String> {
    let heading = strip_heading_markup(line);
    let rest = heading.strip_prefix("Issue ")?;
    let digit_end = rest
        .char_indices()
        .take_while(|(_, ch)| ch.is_ascii_digit())
        .map(|(index, ch)| index + ch.len_utf8())
        .last()?;
    let title = rest[digit_end..]
        .trim_start()
        .trim_start_matches([':', '-', '–', '—', '.', ')', ']'])
        .trim()
        .trim_end_matches(':')
        .trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

fn strip_heading_markup(line: &str) -> String {
    let mut text = line.trim();
    text = text.trim_start_matches('#').trim();
    for prefix in ["- ", "* "] {
        if let Some(stripped) = text.strip_prefix(prefix) {
            text = stripped.trim();
            break;
        }
    }
    loop {
        let stripped = text
            .strip_prefix("**")
            .and_then(|value| value.strip_suffix("**"))
            .or_else(|| {
                text.strip_prefix("__")
                    .and_then(|value| value.strip_suffix("__"))
            });
        let Some(stripped) = stripped else {
            break;
        };
        text = stripped.trim();
    }
    text.to_string()
}

fn trim_common_diagnosis_tail(segment: &str) -> &str {
    let mut offset = 0;
    for raw_line in segment.split_inclusive('\n') {
        let line = line_without_newline(raw_line);
        if is_common_diagnosis_tail(line) {
            return &segment[..offset];
        }
        offset += raw_line.len();
    }
    segment
}

fn line_without_newline(line: &str) -> &str {
    let line = line.strip_suffix('\n').unwrap_or(line);
    line.strip_suffix('\r').unwrap_or(line)
}

fn is_common_diagnosis_tail(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.starts_with("---") {
        return true;
    }
    let normalized = strip_heading_markup(trimmed).to_ascii_lowercase();
    normalized.starts_with("what the team should look at")
}

fn issue_body(report: &IssueReport) -> String {
    let mut body = String::new();
    body.push_str("## Report\n\n");
    body.push_str(report.description.trim());
    body.push('\n');
    if let Some(diagnosis) = trimmed_agent_diagnosis(report) {
        body.push_str("\n## Agent diagnosis\n\n");
        body.push_str(diagnosis);
        body.push('\n');
    }
    append_metadata(&mut body, report, None);
    body
}

fn split_issue_body(
    report: &IssueReport,
    issue: &SplitDiagnosisIssue,
    split_index: usize,
    split_total: usize,
) -> String {
    use std::fmt::Write as _;

    let mut body = String::new();
    body.push_str("## Report\n\n");
    body.push_str(report.description.trim());
    body.push('\n');
    body.push_str("\n## Agent diagnosis\n\n");
    if let Some(preamble) = issue.preamble.as_deref() {
        body.push_str(preamble);
        body.push_str("\n\n");
    }
    let _ = writeln!(body, "**{}**\n", issue.title);
    body.push_str(issue.diagnosis.trim());
    body.push('\n');
    append_metadata(&mut body, report, Some((split_index, split_total)));
    body
}

fn trimmed_agent_diagnosis(report: &IssueReport) -> Option<&str> {
    report
        .agent_diagnosis
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn append_metadata(body: &mut String, report: &IssueReport, split: Option<(usize, usize)>) {
    use std::fmt::Write as _;

    body.push_str("\n## Metadata\n\n");
    if let Some((index, total)) = split {
        let _ = writeln!(body, "- Split issue: {index} of {total}");
    }
    if let Some(category) = report.category.as_deref().filter(|v| !v.is_empty()) {
        let _ = writeln!(body, "- Category: {category}");
    }
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
}

/// Fallback sink when no delivery sink is configured: the report becomes a
/// structured log line, so it still reaches whoever reads the service logs.
pub struct LogIssueReportSink;

fn log_issue_report_delivery_failed(report: &IssueReport, reason: &str, org: &str, project: &str) {
    tracing::warn!(
        reason,
        target_org = %org,
        target_project = %project,
        user_id = %report.user_id.0,
        description = %report.description,
        agent_diagnosis = report.agent_diagnosis.as_deref().unwrap_or(""),
        attachment_names = ?report.attachment_names,
        attachments = ?report.attachments,
        category = report.category.as_deref().unwrap_or(""),
        session_id = report.session_id.as_deref().unwrap_or(""),
        app_version = report.app_version.as_deref().unwrap_or(""),
        platform = report.platform.as_deref().unwrap_or(""),
        "issue_reports: delivery failed; report logged only"
    );
}

fn log_issue_report_without_sink(report: &IssueReport) {
    tracing::warn!(
        user_id = %report.user_id.0,
        description = %report.description,
        agent_diagnosis = report.agent_diagnosis.as_deref().unwrap_or(""),
        attachment_names = ?report.attachment_names,
        // The Debug impl reports name/type/length only — uploaded bytes
        // never reach the logs.
        attachments = ?report.attachments,
        category = report.category.as_deref().unwrap_or(""),
        session_id = report.session_id.as_deref().unwrap_or(""),
        app_version = report.app_version.as_deref().unwrap_or(""),
        platform = report.platform.as_deref().unwrap_or(""),
        "issue_reports: no delivery sink configured; report logged only"
    );
}

#[async_trait]
impl IssueReportSink for LogIssueReportSink {
    async fn deliver(&self, report: IssueReport) -> Result<(), DomainError> {
        log_issue_report_without_sink(&report);
        Ok(())
    }
}

#[cfg(test)]
mod issue_title_tests {
    use super::{
        diagnosis_issue_title, issue_create_entries, issue_title, issue_type_for_report,
        split_agent_diagnosis,
    };
    use scribe_domain::{IssueReport, UserId};

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

    #[test]
    fn diagnosis_splitter_extracts_numbered_issue_sections() {
        let diagnosis = "**Bug Report Assessment**\n\n**Issue 1 — Clipped chat box in Routines:**\nThe Routines feature clips overflowing text.\n\n**Issue 2 — Model control in Routines chat:**\nThe user is asking whether model controls should be exposed.\n\n**What the team should look at:**\n- Compare the two chat surfaces.\n";

        let issues = split_agent_diagnosis(diagnosis);

        assert_eq!(issues.len(), 2);
        assert_eq!(
            issues[0].preamble.as_deref(),
            Some("**Bug Report Assessment**")
        );
        assert_eq!(issues[0].title, "Clipped chat box in Routines");
        assert_eq!(
            issues[0].diagnosis,
            "The Routines feature clips overflowing text."
        );
        assert_eq!(issues[1].title, "Model control in Routines chat");
        assert_eq!(
            issues[1].diagnosis,
            "The user is asking whether model controls should be exposed."
        );
    }

    #[test]
    fn diagnosis_splitter_keeps_overall_sentences_inside_issue_sections() {
        let diagnosis = "Issue 1: Renderer crash\nOverall, the crash appears in the rendering thread.\nMore details follow.\n\nIssue 2: Export failure\nThe export button fails.";

        let issues = split_agent_diagnosis(diagnosis);

        assert_eq!(issues.len(), 2);
        assert_eq!(
            issues[0].diagnosis,
            "Overall, the crash appears in the rendering thread.\nMore details follow."
        );
    }

    #[test]
    fn diagnosis_splitter_keeps_thank_you_content_inside_issue_sections() {
        let diagnosis = "Issue 1: Thank you page crash\nThank you page crashes after submit.\nThe stack trace points at onboarding.\n\nIssue 2: Button copy\nButton text is unclear.\nThank you\n\nIssue 3: Thank you for reporting modal hang\nThank you for reporting modal hangs after Submit.";

        let issues = split_agent_diagnosis(diagnosis);

        assert_eq!(issues.len(), 3);
        assert_eq!(issues[0].title, "Thank you page crash");
        assert_eq!(
            issues[0].diagnosis,
            "Thank you page crashes after submit.\nThe stack trace points at onboarding."
        );
        assert_eq!(issues[1].diagnosis, "Button text is unclear.\nThank you");
        assert_eq!(issues[2].title, "Thank you for reporting modal hang");
        assert_eq!(
            issues[2].diagnosis,
            "Thank you for reporting modal hangs after Submit."
        );
    }

    #[test]
    fn issue_entries_split_multi_issue_agent_diagnosis() {
        let report = IssueReport {
            user_id: UserId("usr_test".to_string()),
            category: Some("bug".to_string()),
            description:
                "Routines chat clips overflowing text. Should model controls be in routines?"
                    .to_string(),
            agent_diagnosis: Some(
                "This report describes two unrelated routines issues.\n\nIssue 1: Clipped chat box in Routines\nText overflow is clipped.\n\nIssue 2: Model control in Routines chat\nThis is a product question."
                    .to_string(),
            ),
            attachment_names: vec![],
            attachments: vec![],
            session_id: Some("session-1".to_string()),
            app_version: Some("0.0.19".to_string()),
            platform: Some("macos".to_string()),
        };

        let entries = issue_create_entries(&report);

        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0].title,
            "June report: Clipped chat box in Routines"
        );
        assert!(
            entries[0]
                .body_markdown
                .contains("This report describes two unrelated routines issues.")
        );
        assert!(
            entries[0]
                .body_markdown
                .contains("Text overflow is clipped.")
        );
        assert!(!entries[0].body_markdown.contains("product question"));
        assert_eq!(
            entries[1].title,
            "June report: Model control in Routines chat"
        );
        assert!(
            entries[1]
                .body_markdown
                .contains("This is a product question.")
        );
        assert!(entries[1].body_markdown.contains("- Split issue: 2 of 2"));
    }

    #[test]
    fn issue_entries_split_non_bug_reports_with_category_metadata() {
        let report = IssueReport {
            user_id: UserId("usr_test".to_string()),
            category: Some("feature".to_string()),
            description: "Please add separate controls for routine models.".to_string(),
            agent_diagnosis: Some(
                "Issue 1: Clipped chat box in Routines\nText overflow is clipped.\n\nIssue 2: Model control in Routines chat\nThis is a product question."
                    .to_string(),
            ),
            attachment_names: vec![],
            attachments: vec![],
            session_id: None,
            app_version: None,
            platform: None,
        };

        let entries = issue_create_entries(&report);

        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0].title,
            "June report: Clipped chat box in Routines"
        );
        assert!(
            entries[0]
                .body_markdown
                .contains("Text overflow is clipped.")
        );
        assert!(!entries[0].body_markdown.contains("product question"));
        assert_eq!(
            entries[1].title,
            "June report: Model control in Routines chat"
        );
        assert!(entries[0].body_markdown.contains("- Category: feature"));
        assert!(entries[1].body_markdown.contains("- Split issue: 2 of 2"));
    }

    #[test]
    fn issue_type_maps_report_categories_to_tracker_types() {
        let mut report = IssueReport {
            user_id: UserId("usr_test".to_string()),
            category: None,
            description: "The recorder freezes".to_string(),
            agent_diagnosis: None,
            attachment_names: vec![],
            attachments: vec![],
            session_id: None,
            app_version: None,
            platform: None,
        };

        assert_eq!(issue_type_for_report(&report), "bug");
        report.category = Some("bug".to_string());
        assert_eq!(issue_type_for_report(&report), "bug");
        report.category = Some("feature".to_string());
        assert_eq!(issue_type_for_report(&report), "feature");
        report.category = Some("feedback".to_string());
        assert_eq!(issue_type_for_report(&report), "other");
    }

    #[test]
    fn issue_entries_keep_single_issue_without_multiple_sections() {
        let report = IssueReport {
            user_id: UserId("usr_test".to_string()),
            category: None,
            description: "The recorder freezes".to_string(),
            agent_diagnosis: Some("Likely the audio capture thread.".to_string()),
            attachment_names: vec![],
            attachments: vec![],
            session_id: None,
            app_version: None,
            platform: None,
        };

        let entries = issue_create_entries(&report);

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "June report: The recorder freezes");
        assert!(
            entries[0]
                .body_markdown
                .contains("Likely the audio capture thread.")
        );
    }

    #[test]
    fn diagnosis_issue_title_lifts_the_first_issue_heading() {
        let diagnosis =
            "**Issue 1 — Recorder freezes on pause:**\nThe audio capture thread stalls.";
        assert_eq!(
            diagnosis_issue_title(diagnosis).as_deref(),
            Some("Recorder freezes on pause")
        );
        assert_eq!(diagnosis_issue_title("Just some prose, no heading."), None);
    }

    #[test]
    fn issue_entries_use_single_diagnosis_heading_as_title() {
        let report = IssueReport {
            user_id: UserId("usr_test".to_string()),
            category: Some("feature".to_string()),
            description: "Can the report titles read better in the tracker?".to_string(),
            agent_diagnosis: Some(
                "Issue 1: Model-written report titles\nReuse the diagnosis heading as the tracker title."
                    .to_string(),
            ),
            attachment_names: vec![],
            attachments: vec![],
            session_id: None,
            app_version: None,
            platform: None,
        };

        let entries = issue_create_entries(&report);

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "June report: Model-written report titles");
        assert!(
            entries[0]
                .body_markdown
                .contains("Can the report titles read better")
        );
    }

    #[test]
    fn issue_entries_fall_back_when_split_diagnosis_exceeds_cap() {
        let diagnosis = (1..=11)
            .map(|index| format!("Issue {index}: Generated issue {index}\nDetails {index}."))
            .collect::<Vec<_>>()
            .join("\n\n");
        let report = IssueReport {
            user_id: UserId("usr_test".to_string()),
            category: None,
            description: "The report contains many generated findings.".to_string(),
            agent_diagnosis: Some(diagnosis),
            attachment_names: vec![],
            attachments: vec![],
            session_id: None,
            app_version: None,
            platform: None,
        };

        let entries = issue_create_entries(&report);

        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].title,
            "June report: The report contains many generated findings."
        );
        assert!(
            entries[0]
                .body_markdown
                .contains("Issue 11: Generated issue 11")
        );
        assert!(!entries[0].body_markdown.contains("- Split issue:"));
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
            category: Some("bug".to_string()),
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
            os_platform_org: "june".to_string(),
            os_platform_project: "bug-reports".to_string(),
            os_platform_reward_asset: "POINTS".to_string(),
            ..Default::default()
        }
    }

    fn missing_project_config(api_url: &str) -> IssueReportsConfig {
        IssueReportsConfig {
            os_platform_project: "missing-project".to_string(),
            ..config(api_url)
        }
    }

    fn sink_with_config(config: &IssueReportsConfig) -> OsPlatformIssueReportSink {
        OsPlatformIssueReportSink::from_config(reqwest::Client::new(), config)
            .expect("configured sink")
    }

    fn sink(server: &MockServer) -> OsPlatformIssueReportSink {
        sink_with_config(&config(&server.uri()))
    }

    fn missing_project_sink(server: &MockServer) -> OsPlatformIssueReportSink {
        sink_with_config(&missing_project_config(&server.uri()))
    }

    fn issue_created_with(number_in_org: i64) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": {
                "external_id": format!("OSN-{number_in_org}"),
                "number_in_org": number_in_org,
            },
            "success": true,
        }))
    }

    fn issue_created() -> ResponseTemplate {
        issue_created_with(7)
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

    fn issue_rejected(message: &str) -> ResponseTemplate {
        ResponseTemplate::new(404).set_body_json(serde_json::json!({
            "data": null,
            "success": false,
            "error_code": 3004,
            "message": message,
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

    #[test]
    fn os_platform_sink_uses_default_june_bug_reports_destination_with_api_key() {
        let config = IssueReportsConfig {
            os_platform_api_key: "osk_test".to_string(),
            ..Default::default()
        };
        let sink = OsPlatformIssueReportSink::from_config(reqwest::Client::new(), &config)
            .expect("default June issue report destination plus API key is configured");

        assert_eq!(sink.api_url, "https://app.opensoftware.co/api");
        assert_eq!(sink.org, "june");
        assert_eq!(sink.project, "bug-reports");
        assert_eq!(sink.label, "bug");
        assert_eq!(sink.reward_asset, "POINTS");
    }

    #[test]
    fn os_platform_sink_remaps_legacy_open_software_june_destination() {
        for (org, project) in [
            ("open-software", "june"),
            ("open-software", "open-software/june"),
            ("june", "open-software/june"),
        ] {
            let config = IssueReportsConfig {
                os_platform_api_key: "osk_test".to_string(),
                os_platform_org: org.to_string(),
                os_platform_project: project.to_string(),
                ..Default::default()
            };
            let sink = OsPlatformIssueReportSink::from_config(reqwest::Client::new(), &config)
                .expect("legacy June issue report destination should remap");

            assert_eq!(sink.org, "june");
            assert_eq!(sink.project, "bug-reports");
        }
    }

    #[test]
    fn os_platform_sink_keeps_configured_org_for_matching_legacy_destination() {
        let config = IssueReportsConfig {
            os_platform_api_key: "osk_test".to_string(),
            os_platform_org: "june-team".to_string(),
            os_platform_project: "june-team/june".to_string(),
            ..Default::default()
        };
        let sink = OsPlatformIssueReportSink::from_config(reqwest::Client::new(), &config)
            .expect("matching legacy org/project destination should normalize");

        assert_eq!(sink.org, "june-team");
        assert_eq!(sink.project, "june");
    }

    #[test]
    fn os_platform_sink_rejects_malformed_project_destination() {
        let config = IssueReportsConfig {
            os_platform_api_key: "osk_test".to_string(),
            os_platform_project: "june/bug-reports/issues".to_string(),
            ..Default::default()
        };

        assert!(OsPlatformIssueReportSink::from_config(reqwest::Client::new(), &config).is_none());
    }

    #[test]
    fn os_platform_sink_rejects_incomplete_legacy_project_destination() {
        let config = IssueReportsConfig {
            os_platform_api_key: "osk_test".to_string(),
            os_platform_project: "june/".to_string(),
            ..Default::default()
        };

        assert!(OsPlatformIssueReportSink::from_config(reqwest::Client::new(), &config).is_none());
    }

    #[test]
    fn os_platform_sink_rejects_other_org_project_destination() {
        let config = IssueReportsConfig {
            os_platform_api_key: "osk_test".to_string(),
            os_platform_project: "other-org/bug-reports".to_string(),
            ..Default::default()
        };

        assert!(OsPlatformIssueReportSink::from_config(reqwest::Client::new(), &config).is_none());
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
            .and(path("/v1/orgs/june/projects/bug-reports/bounties"))
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
            .and(path("/v1/orgs/june/bounties/7/labels"))
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
    async fn os_platform_sink_files_split_diagnosis_as_separate_issues() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/files"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/june/projects/bug-reports/bounties"))
            .and(body_partial_json(serde_json::json!({
                "title": "June report: Clipped chat box in Routines",
                "file_ids": [],
            })))
            .respond_with(issue_created_with(7))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/june/projects/bug-reports/bounties"))
            .and(body_partial_json(serde_json::json!({
                "title": "June report: Model control in Routines chat",
                "file_ids": [],
            })))
            .respond_with(issue_created_with(8))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/v1/orgs/june/bounties/7/labels"))
            .respond_with(labels_set())
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/v1/orgs/june/bounties/8/labels"))
            .respond_with(labels_set())
            .expect(1)
            .mount(&server)
            .await;

        let mut report = report();
        report.attachments.clear();
        report.agent_diagnosis = Some(
            "Issue 1: Clipped chat box in Routines\nText overflow is clipped.\n\nIssue 2: Model control in Routines chat\nThis is a product question."
                .to_string(),
        );

        assert!(sink(&server).deliver(report).await.is_ok());
    }

    #[tokio::test]
    async fn os_platform_sink_files_feature_split_diagnosis_as_feature_issues() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/june/projects/bug-reports/bounties"))
            .and(body_partial_json(serde_json::json!({
                "title": "June report: Clipped chat box in Routines",
                "type": "feature",
                "file_ids": [],
            })))
            .respond_with(issue_created_with(7))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/june/projects/bug-reports/bounties"))
            .and(body_partial_json(serde_json::json!({
                "title": "June report: Model control in Routines chat",
                "type": "feature",
                "file_ids": [],
            })))
            .respond_with(issue_created_with(8))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/v1/orgs/june/bounties/7/labels"))
            .respond_with(labels_set())
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/v1/orgs/june/bounties/8/labels"))
            .respond_with(labels_set())
            .expect(0)
            .mount(&server)
            .await;

        let mut report = report();
        report.category = Some("feature".to_string());
        report.attachments.clear();
        report.agent_diagnosis = Some(
            "Issue 1: Clipped chat box in Routines\nText overflow is clipped.\n\nIssue 2: Model control in Routines chat\nThis is a product question."
                .to_string(),
        );

        assert!(sink(&server).deliver(report).await.is_ok());
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
            .and(path("/v1/orgs/june/projects/bug-reports/bounties"))
            .and(body_partial_json(serde_json::json!({ "file_ids": [] })))
            .respond_with(issue_created())
            .expect(1)
            .mount(&server)
            .await;
        // First labels PUT: the label doesn't exist in the Project yet.
        // After the label create, the retried PUT lands.
        Mock::given(method("PUT"))
            .and(path("/v1/orgs/june/bounties/7/labels"))
            .respond_with(label_missing())
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/june/projects/bug-reports/labels"))
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
            .and(path("/v1/orgs/june/bounties/7/labels"))
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
            .and(path("/v1/orgs/june/projects/bug-reports/bounties"))
            .respond_with(issue_created())
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/v1/orgs/june/bounties/7/labels"))
            .respond_with(label_missing())
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/june/projects/bug-reports/labels"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&server)
            .await;

        // The Issue exists; a permanently missing label must not fail the
        // delivery (the report would be re-shown to the user as unsent).
        assert!(sink(&server).deliver(report()).await.is_ok());
    }

    #[tokio::test]
    async fn os_platform_sink_retries_at_org_scope_when_project_create_is_rejected() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/files"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/june/projects/missing-project/bounties"))
            .respond_with(issue_rejected("project 'june/missing-project' not found"))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/june/bounties"))
            .and(body_partial_json(serde_json::json!({
                "title": "June report: The recorder freezes",
                "reward_amount_units": "0",
                "asset_symbol": "POINTS",
                "type": "bug",
                "status": "todo",
                "file_ids": [],
            })))
            .respond_with(issue_created())
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/v1/orgs/june/bounties/7/labels"))
            .respond_with(labels_set())
            .expect(1)
            .mount(&server)
            .await;

        assert!(
            missing_project_sink(&server)
                .deliver(report())
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn os_platform_sink_retries_at_org_scope_when_project_create_has_bad_envelope() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/files"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/june/projects/missing-project/bounties"))
            .respond_with(ResponseTemplate::new(502).set_body_string("bad gateway"))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/june/bounties"))
            .respond_with(issue_created())
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/v1/orgs/june/bounties/7/labels"))
            .respond_with(labels_set())
            .expect(1)
            .mount(&server)
            .await;

        assert!(
            missing_project_sink(&server)
                .deliver(report())
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn os_platform_sink_does_not_create_project_label_after_org_fallback() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/files"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/june/projects/missing-project/bounties"))
            .respond_with(issue_rejected("project 'june/missing-project' not found"))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/june/bounties"))
            .respond_with(issue_created())
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/v1/orgs/june/bounties/7/labels"))
            .respond_with(label_missing())
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/june/projects/missing-project/labels"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;

        assert!(
            missing_project_sink(&server)
                .deliver(report())
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn os_platform_sink_accepts_and_logs_when_platform_rejects_all_creates() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/files"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/june/projects/missing-project/bounties"))
            .respond_with(issue_rejected("project 'june/missing-project' not found"))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/orgs/june/bounties"))
            .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
                "data": null,
                "success": false,
                "error_code": 3001,
                "message": "caller is not an org member",
            })))
            .expect(1)
            .mount(&server)
            .await;

        let result = missing_project_sink(&server).deliver(report()).await;
        assert!(result.is_ok());
    }
}
