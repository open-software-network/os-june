use crate::{
    connectors::{
        github::{
            github_app_config, github_authorization_gate, github_tool_eligibility_from_snapshot,
            installations_refresh, resolve_github_read_credential,
            resolve_github_read_credential_after_unauthorized, EligibleGitHubRepository,
            GitHubAppConfig, GitHubReadCredential, GitHubTokenVault, GitHubToolEligibility,
        },
        github_api::{GitHubApiError, GitHubReadClient},
        github_auth::GitHubAuthClient,
        github_capabilities::{CapabilityRegistry, CursorScope},
        github_issue_reads::{self, IssueComments, IssueList},
        github_pull_reads::{self, PullRequestFileDiff, PullRequestList, PullRequestPage},
        github_repository_reads::{self, CodeSearch, DirectoryRead, FileRead},
    },
    db::repositories::{GitHubSnapshotRecord, Repositories},
    domain::types::AppError,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const MAX_ENVELOPE_BYTES: usize = 256 * 1024;

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(
    tag = "operation",
    content = "arguments",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(crate) enum GitHubReadRequest {
    ListRepositories {
        cursor: Option<String>,
        limit: Option<u16>,
    },
    GetRepository {
        repository_id: String,
    },
    ListDirectory {
        repository_id: String,
        path: String,
        #[serde(rename = "ref")]
        git_ref: Option<String>,
        cursor: Option<String>,
        limit: Option<u16>,
    },
    ReadFile {
        repository_id: String,
        path: String,
        #[serde(rename = "ref")]
        git_ref: Option<String>,
        start_line: Option<u32>,
        line_count: Option<u16>,
    },
    SearchCode {
        repository_id: String,
        query: String,
        cursor: Option<String>,
        limit: Option<u16>,
    },
    ListIssues {
        repository_id: String,
        state: Option<String>,
        query: Option<String>,
        labels: Option<Vec<String>>,
        cursor: Option<String>,
        limit: Option<u16>,
    },
    GetIssue {
        repository_id: String,
        number: u64,
    },
    ListIssueComments {
        repository_id: String,
        number: u64,
        cursor: Option<String>,
        limit: Option<u16>,
    },
    ListPullRequests {
        repository_id: String,
        state: Option<String>,
        query: Option<String>,
        base: Option<String>,
        head: Option<String>,
        cursor: Option<String>,
        limit: Option<u16>,
    },
    GetPullRequest {
        repository_id: String,
        number: u64,
    },
    ListPullRequestFiles {
        repository_id: String,
        number: u64,
        cursor: Option<String>,
        limit: Option<u16>,
    },
    ReadPullRequestFileDiff {
        repository_id: String,
        number: u64,
        file_ref: String,
        cursor: Option<String>,
    },
    ListPullRequestCommits {
        repository_id: String,
        number: u64,
        cursor: Option<String>,
        limit: Option<u16>,
    },
    ListPullRequestReviews {
        repository_id: String,
        number: u64,
        cursor: Option<String>,
        limit: Option<u16>,
    },
    ListPullRequestReviewComments {
        repository_id: String,
        number: u64,
        cursor: Option<String>,
        limit: Option<u16>,
    },
    ListPullRequestChecks {
        repository_id: String,
        number: u64,
        cursor: Option<String>,
        limit: Option<u16>,
    },
}

#[allow(dead_code)]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitHubSource {
    pub repository_id: String,
    pub repository_full_name: String,
    pub url: String,
    pub object_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct GitHubOperationOutput {
    pub data: serde_json::Value,
    pub truncated: bool,
    pub continuation_cursor: Option<String>,
    pub redactions_applied: bool,
    pub sources: Vec<GitHubSource>,
    pub finalization_checkpoints: Option<GitHubFinalizationCheckpoints>,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) enum GitHubFinalizationCheckpoints {
    List {
        data_field: &'static str,
        sources_per_item: bool,
        resume_after_prefix: Vec<CursorScope>,
    },
    Patch {
        resume_after_prefix: Vec<GitHubPatchCheckpoint>,
    },
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct GitHubPatchCheckpoint {
    pub output_prefix_bytes: usize,
    pub resume: CursorScope,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitHubReadEnvelope {
    pub trust: &'static str,
    pub data: serde_json::Value,
    pub truncated: bool,
    pub continuation_cursor: Option<String>,
    pub redactions_applied: bool,
    pub sources: Vec<GitHubSource>,
}

#[allow(dead_code)]
pub(crate) struct GitHubReadOutcome {
    pub result: Result<GitHubReadEnvelope, AppError>,
    pub connector_state_changed: bool,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) enum GitHubReadFailure {
    Input(AppError),
    Provider(GitHubApiError),
}

#[allow(dead_code)] // Task 9 wires the orchestrator into the provider proxy.
pub(crate) struct GitHubReadService {
    api: GitHubReadClient,
    auth: GitHubAuthClient,
    config: GitHubAppConfig,
    capabilities: Arc<CapabilityRegistry>,
}

#[allow(dead_code)] // Task 9 wires the orchestrator into the provider proxy.
impl GitHubReadService {
    pub(crate) fn production() -> Result<Self, AppError> {
        Ok(Self {
            api: GitHubReadClient::production()?,
            auth: GitHubAuthClient::production()?,
            config: github_app_config()?,
            capabilities: Arc::new(CapabilityRegistry::new()),
        })
    }

    #[cfg(test)]
    pub(crate) fn for_test(
        api: GitHubReadClient,
        auth: GitHubAuthClient,
        config: GitHubAppConfig,
        capabilities: Arc<CapabilityRegistry>,
    ) -> Self {
        Self {
            api,
            auth,
            config,
            capabilities,
        }
    }

    pub(crate) async fn execute(
        &self,
        request: GitHubReadRequest,
        vault: &dyn GitHubTokenVault,
        repositories: &Repositories,
    ) -> GitHubReadOutcome {
        let mut credential =
            match resolve_github_read_credential(&self.auth, vault, repositories, &self.config)
                .await
            {
                Ok(credential) => credential,
                Err(error) => return outcome_from_credential_error(error),
            };

        let mut attempt = 0_u8;
        loop {
            attempt += 1;
            let _lease = github_authorization_gate().read().await;
            let before = match authoritative_snapshot(repositories).await {
                Ok(snapshot) => snapshot,
                Err(error) => return unchanged_error(error),
            };
            let eligibility = match validated_eligibility(&before, &credential) {
                Ok(eligibility) => eligibility,
                Err(error) => return unchanged_error(error),
            };
            if let Err(error) = resolve_selected_repository(&request, &eligibility) {
                return unchanged_error(error);
            }

            match self.dispatch(&request, &credential, &eligibility).await {
                Ok(output) => {
                    let after = match authoritative_snapshot(repositories).await {
                        Ok(snapshot) => snapshot,
                        Err(error) => return unchanged_error(error),
                    };
                    if before != after || validated_eligibility(&after, &credential).is_err() {
                        return unchanged_error(access_removed_or_not_found());
                    }
                    return match finalize_output(&request, output, &self.capabilities) {
                        Ok(envelope) => GitHubReadOutcome {
                            result: Ok(envelope),
                            connector_state_changed: false,
                        },
                        Err(error) => unchanged_error(error),
                    };
                }
                Err(GitHubReadFailure::Input(error)) => {
                    return unchanged_error(stable_input_error(error));
                }
                Err(GitHubReadFailure::Provider(GitHubApiError::Unauthorized)) => {
                    let rejected_user_id = credential.github_user_id.clone();
                    let rejected_access_token =
                        zeroize::Zeroizing::new(credential.access_token.clone());
                    drop(_lease);
                    let resolved = resolve_github_read_credential_after_unauthorized(
                        &self.auth,
                        vault,
                        repositories,
                        &self.config,
                        &rejected_user_id,
                        rejected_access_token.as_str(),
                    )
                    .await;
                    match resolved {
                        Ok(next) if attempt == 1 => {
                            credential = next;
                            continue;
                        }
                        Ok(_) => return unchanged_error(read_unavailable()),
                        Err(error) if error.code == "github_reconnect_required" => {
                            return GitHubReadOutcome {
                                result: Err(reconnect_required()),
                                connector_state_changed: true,
                            };
                        }
                        Err(_) => return unchanged_error(read_unavailable()),
                    }
                }
                Err(GitHubReadFailure::Provider(
                    GitHubApiError::Forbidden | GitHubApiError::NotFound,
                )) => {
                    drop(_lease);
                    let before_refresh = repositories.github_snapshot().await.ok().flatten();
                    let refresh =
                        installations_refresh(&self.auth, vault, repositories, &self.config).await;
                    let after_refresh = repositories.github_snapshot().await.ok().flatten();
                    let connector_state_changed = before_refresh != after_refresh
                        || refresh
                            .as_ref()
                            .is_err_and(|error| error.code == "github_reconnect_required");
                    return GitHubReadOutcome {
                        result: Err(access_removed_or_not_found()),
                        connector_state_changed,
                    };
                }
                Err(GitHubReadFailure::Provider(error)) => {
                    return unchanged_error(public_provider_error(error));
                }
            }
        }
    }

    async fn dispatch(
        &self,
        request: &GitHubReadRequest,
        credential: &GitHubReadCredential,
        eligibility: &GitHubToolEligibility,
    ) -> Result<GitHubOperationOutput, GitHubReadFailure> {
        let token = credential.access_token.as_str();
        match request {
            GitHubReadRequest::ListRepositories { cursor, limit } => {
                github_repository_reads::list_repositories(
                    eligibility,
                    &self.capabilities,
                    cursor.as_deref(),
                    *limit,
                )
                .await
                .map_err(GitHubReadFailure::Input)
            }
            GitHubReadRequest::GetRepository { .. } => github_repository_reads::get_repository(
                &self.api,
                token,
                selected_repository(request, eligibility)?,
            )
            .await
            .map_err(GitHubReadFailure::Provider),
            GitHubReadRequest::ListDirectory {
                path,
                git_ref,
                cursor,
                limit,
                ..
            } => {
                github_repository_reads::list_directory(
                    &self.api,
                    token,
                    selected_repository(request, eligibility)?,
                    DirectoryRead {
                        path: path.clone(),
                        git_ref: git_ref.clone(),
                        cursor: cursor.clone(),
                        limit: *limit,
                    },
                    &self.capabilities,
                )
                .await
            }
            GitHubReadRequest::ReadFile {
                path,
                git_ref,
                start_line,
                line_count,
                ..
            } => {
                github_repository_reads::read_file(
                    &self.api,
                    token,
                    selected_repository(request, eligibility)?,
                    FileRead {
                        path: path.clone(),
                        git_ref: git_ref.clone(),
                        start_line: *start_line,
                        line_count: *line_count,
                    },
                )
                .await
            }
            GitHubReadRequest::SearchCode {
                query,
                cursor,
                limit,
                ..
            } => {
                github_repository_reads::search_code(
                    &self.api,
                    token,
                    selected_repository(request, eligibility)?,
                    CodeSearch {
                        query: query.clone(),
                        cursor: cursor.clone(),
                        limit: *limit,
                    },
                    &self.capabilities,
                )
                .await
            }
            GitHubReadRequest::ListIssues {
                state,
                query,
                labels,
                cursor,
                limit,
                ..
            } => {
                github_issue_reads::list_issues(
                    &self.api,
                    token,
                    selected_repository(request, eligibility)?,
                    IssueList {
                        state: state.clone(),
                        query: query.clone(),
                        labels: labels.clone(),
                        cursor: cursor.clone(),
                        limit: *limit,
                    },
                    &self.capabilities,
                )
                .await
            }
            GitHubReadRequest::GetIssue { number, .. } => {
                github_issue_reads::get_issue(
                    &self.api,
                    token,
                    selected_repository(request, eligibility)?,
                    *number,
                )
                .await
            }
            GitHubReadRequest::ListIssueComments {
                number,
                cursor,
                limit,
                ..
            } => {
                github_issue_reads::list_issue_comments(
                    &self.api,
                    token,
                    selected_repository(request, eligibility)?,
                    IssueComments {
                        number: *number,
                        cursor: cursor.clone(),
                        limit: *limit,
                    },
                    &self.capabilities,
                )
                .await
            }
            GitHubReadRequest::ListPullRequests {
                state,
                query,
                base,
                head,
                cursor,
                limit,
                ..
            } => {
                github_pull_reads::list_pull_requests(
                    &self.api,
                    token,
                    selected_repository(request, eligibility)?,
                    PullRequestList {
                        state: state.clone(),
                        query: query.clone(),
                        base: base.clone(),
                        head: head.clone(),
                        cursor: cursor.clone(),
                        limit: *limit,
                    },
                    &self.capabilities,
                )
                .await
            }
            GitHubReadRequest::GetPullRequest { number, .. } => {
                github_pull_reads::get_pull_request(
                    &self.api,
                    token,
                    selected_repository(request, eligibility)?,
                    *number,
                )
                .await
            }
            GitHubReadRequest::ListPullRequestFiles {
                number,
                cursor,
                limit,
                ..
            } => {
                github_pull_reads::list_pull_request_files(
                    &self.api,
                    token,
                    selected_repository(request, eligibility)?,
                    PullRequestPage {
                        number: *number,
                        cursor: cursor.clone(),
                        limit: *limit,
                    },
                    &self.capabilities,
                )
                .await
            }
            GitHubReadRequest::ReadPullRequestFileDiff {
                number,
                file_ref,
                cursor,
                ..
            } => {
                github_pull_reads::read_pull_request_file_diff(
                    &self.api,
                    token,
                    selected_repository(request, eligibility)?,
                    PullRequestFileDiff {
                        number: *number,
                        file_ref: file_ref.clone(),
                        cursor: cursor.clone(),
                    },
                    &self.capabilities,
                )
                .await
            }
            GitHubReadRequest::ListPullRequestCommits {
                number,
                cursor,
                limit,
                ..
            } => {
                github_pull_reads::list_pull_request_commits(
                    &self.api,
                    token,
                    selected_repository(request, eligibility)?,
                    PullRequestPage {
                        number: *number,
                        cursor: cursor.clone(),
                        limit: *limit,
                    },
                    &self.capabilities,
                )
                .await
            }
            GitHubReadRequest::ListPullRequestReviews {
                number,
                cursor,
                limit,
                ..
            } => {
                github_pull_reads::list_pull_request_reviews(
                    &self.api,
                    token,
                    selected_repository(request, eligibility)?,
                    PullRequestPage {
                        number: *number,
                        cursor: cursor.clone(),
                        limit: *limit,
                    },
                    &self.capabilities,
                )
                .await
            }
            GitHubReadRequest::ListPullRequestReviewComments {
                number,
                cursor,
                limit,
                ..
            } => {
                github_pull_reads::list_pull_request_review_comments(
                    &self.api,
                    token,
                    selected_repository(request, eligibility)?,
                    PullRequestPage {
                        number: *number,
                        cursor: cursor.clone(),
                        limit: *limit,
                    },
                    &self.capabilities,
                )
                .await
            }
            GitHubReadRequest::ListPullRequestChecks {
                number,
                cursor,
                limit,
                ..
            } => {
                github_pull_reads::list_pull_request_checks(
                    &self.api,
                    token,
                    selected_repository(request, eligibility)?,
                    PullRequestPage {
                        number: *number,
                        cursor: cursor.clone(),
                        limit: *limit,
                    },
                    &self.capabilities,
                )
                .await
            }
        }
    }
}

async fn authoritative_snapshot(
    repositories: &Repositories,
) -> Result<GitHubSnapshotRecord, AppError> {
    repositories
        .github_snapshot()
        .await
        .map_err(|_| read_unavailable())?
        .ok_or_else(reconnect_required)
}

fn validated_eligibility(
    snapshot: &GitHubSnapshotRecord,
    credential: &GitHubReadCredential,
) -> Result<GitHubToolEligibility, AppError> {
    github_tool_eligibility_from_snapshot(snapshot, &credential.github_user_id)
        .map_err(stable_input_error)
}

#[cfg(test)]
fn operation_name(request: &GitHubReadRequest) -> &'static str {
    match request {
        GitHubReadRequest::ListRepositories { .. } => "list_repositories",
        GitHubReadRequest::GetRepository { .. } => "get_repository",
        GitHubReadRequest::ListDirectory { .. } => "list_directory",
        GitHubReadRequest::ReadFile { .. } => "read_file",
        GitHubReadRequest::SearchCode { .. } => "search_code",
        GitHubReadRequest::ListIssues { .. } => "list_issues",
        GitHubReadRequest::GetIssue { .. } => "get_issue",
        GitHubReadRequest::ListIssueComments { .. } => "list_issue_comments",
        GitHubReadRequest::ListPullRequests { .. } => "list_pull_requests",
        GitHubReadRequest::GetPullRequest { .. } => "get_pull_request",
        GitHubReadRequest::ListPullRequestFiles { .. } => "list_pull_request_files",
        GitHubReadRequest::ReadPullRequestFileDiff { .. } => "read_pull_request_file_diff",
        GitHubReadRequest::ListPullRequestCommits { .. } => "list_pull_request_commits",
        GitHubReadRequest::ListPullRequestReviews { .. } => "list_pull_request_reviews",
        GitHubReadRequest::ListPullRequestReviewComments { .. } => {
            "list_pull_request_review_comments"
        }
        GitHubReadRequest::ListPullRequestChecks { .. } => "list_pull_request_checks",
    }
}

fn request_repository_id(request: &GitHubReadRequest) -> Option<&str> {
    match request {
        GitHubReadRequest::ListRepositories { .. } => None,
        GitHubReadRequest::GetRepository { repository_id }
        | GitHubReadRequest::ListDirectory { repository_id, .. }
        | GitHubReadRequest::ReadFile { repository_id, .. }
        | GitHubReadRequest::SearchCode { repository_id, .. }
        | GitHubReadRequest::ListIssues { repository_id, .. }
        | GitHubReadRequest::GetIssue { repository_id, .. }
        | GitHubReadRequest::ListIssueComments { repository_id, .. }
        | GitHubReadRequest::ListPullRequests { repository_id, .. }
        | GitHubReadRequest::GetPullRequest { repository_id, .. }
        | GitHubReadRequest::ListPullRequestFiles { repository_id, .. }
        | GitHubReadRequest::ReadPullRequestFileDiff { repository_id, .. }
        | GitHubReadRequest::ListPullRequestCommits { repository_id, .. }
        | GitHubReadRequest::ListPullRequestReviews { repository_id, .. }
        | GitHubReadRequest::ListPullRequestReviewComments { repository_id, .. }
        | GitHubReadRequest::ListPullRequestChecks { repository_id, .. } => Some(repository_id),
    }
}

fn resolve_selected_repository<'a>(
    request: &GitHubReadRequest,
    eligibility: &'a GitHubToolEligibility,
) -> Result<Option<&'a EligibleGitHubRepository>, AppError> {
    let Some(repository_id) = request_repository_id(request) else {
        return Ok(None);
    };
    eligibility
        .repositories
        .iter()
        .find(|repository| repository.repository_id == repository_id)
        .map(Some)
        .ok_or_else(repository_not_selected)
}

fn selected_repository<'a>(
    request: &GitHubReadRequest,
    eligibility: &'a GitHubToolEligibility,
) -> Result<&'a EligibleGitHubRepository, GitHubReadFailure> {
    resolve_selected_repository(request, eligibility)
        .map_err(GitHubReadFailure::Input)?
        .ok_or_else(|| GitHubReadFailure::Input(repository_not_selected()))
}

fn finalize_output(
    request: &GitHubReadRequest,
    output: GitHubOperationOutput,
    capabilities: &CapabilityRegistry,
) -> Result<GitHubReadEnvelope, AppError> {
    let checkpoints = output.finalization_checkpoints;
    let mut envelope = GitHubReadEnvelope {
        trust: "untrusted_repository_content",
        data: output.data,
        truncated: output.truncated,
        continuation_cursor: output.continuation_cursor,
        redactions_applied: output.redactions_applied,
        sources: output.sources,
    };
    if serialized_size(&envelope)? <= MAX_ENVELOPE_BYTES {
        return Ok(envelope);
    }

    match checkpoints {
        Some(GitHubFinalizationCheckpoints::List {
            data_field,
            sources_per_item,
            resume_after_prefix,
        }) => {
            return trim_list_envelope(
                &mut envelope,
                data_field,
                sources_per_item,
                &resume_after_prefix,
                capabilities,
            );
        }
        Some(GitHubFinalizationCheckpoints::Patch {
            resume_after_prefix,
        }) => {
            return trim_patch_envelope(&mut envelope, &resume_after_prefix, capabilities);
        }
        None => {}
    }

    if !matches!(
        request,
        GitHubReadRequest::GetRepository { .. }
            | GitHubReadRequest::GetIssue { .. }
            | GitHubReadRequest::GetPullRequest { .. }
    ) {
        return Err(response_too_large());
    }
    for (field, truncated_field) in [
        ("body", "bodyTruncated"),
        ("description", "descriptionTruncated"),
    ] {
        if shrink_string_field(&mut envelope, field, truncated_field)? {
            return Ok(envelope);
        }
    }
    Err(response_too_large())
}

fn trim_list_envelope(
    envelope: &mut GitHubReadEnvelope,
    data_field: &str,
    sources_per_item: bool,
    resume_after_prefix: &[CursorScope],
    capabilities: &CapabilityRegistry,
) -> Result<GitHubReadEnvelope, AppError> {
    let item_count = envelope
        .data
        .get(data_field)
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .ok_or_else(read_unavailable)?;
    if (sources_per_item && envelope.sources.len() != item_count)
        || resume_after_prefix.len() != item_count + 1
    {
        return Err(read_unavailable());
    }
    envelope.truncated = true;
    envelope.continuation_cursor = Some("x".repeat(32));
    while serialized_size(envelope)? > MAX_ENVELOPE_BYTES {
        let items = envelope
            .data
            .get_mut(data_field)
            .and_then(serde_json::Value::as_array_mut)
            .ok_or_else(read_unavailable)?;
        if items.pop().is_none() {
            return Err(response_too_large());
        }
        if sources_per_item {
            envelope.sources.pop().ok_or_else(read_unavailable)?;
        }
    }
    let kept = envelope
        .data
        .get(data_field)
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .ok_or_else(read_unavailable)?;
    envelope.continuation_cursor = Some(
        capabilities
            .issue_cursor(resume_after_prefix[kept].clone())
            .map_err(stable_input_error)?,
    );
    if serialized_size(envelope)? > MAX_ENVELOPE_BYTES {
        return Err(response_too_large());
    }
    Ok(envelope.clone())
}

fn trim_patch_envelope(
    envelope: &mut GitHubReadEnvelope,
    resume_after_prefix: &[GitHubPatchCheckpoint],
    capabilities: &CapabilityRegistry,
) -> Result<GitHubReadEnvelope, AppError> {
    let patch = envelope
        .data
        .get("patch")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(read_unavailable)?
        .to_owned();
    if resume_after_prefix.is_empty()
        || resume_after_prefix[0].output_prefix_bytes != 0
        || resume_after_prefix
            .windows(2)
            .any(|pair| pair[0].output_prefix_bytes >= pair[1].output_prefix_bytes)
        || resume_after_prefix
            .last()
            .is_some_and(|checkpoint| checkpoint.output_prefix_bytes > patch.len())
    {
        return Err(read_unavailable());
    }
    envelope.truncated = true;
    envelope.data["patchTruncated"] = serde_json::Value::Bool(true);
    envelope.continuation_cursor = Some("x".repeat(32));
    let mut selected = None;
    for checkpoint in resume_after_prefix.iter().rev() {
        let end = checkpoint.output_prefix_bytes;
        if !patch.is_char_boundary(end) {
            return Err(read_unavailable());
        }
        envelope.data["patch"] = serde_json::Value::String(patch[..end].to_owned());
        if serialized_size(envelope)? <= MAX_ENVELOPE_BYTES {
            selected = Some(checkpoint);
            break;
        }
    }
    let selected = selected.ok_or_else(response_too_large)?;
    envelope.continuation_cursor = Some(
        capabilities
            .issue_cursor(selected.resume.clone())
            .map_err(stable_input_error)?,
    );
    if serialized_size(envelope)? > MAX_ENVELOPE_BYTES {
        return Err(response_too_large());
    }
    Ok(envelope.clone())
}

fn serialized_size(envelope: &GitHubReadEnvelope) -> Result<usize, AppError> {
    serde_json::to_vec(envelope)
        .map(|bytes| bytes.len())
        .map_err(|_| read_unavailable())
}

fn shrink_string_field(
    envelope: &mut GitHubReadEnvelope,
    field: &str,
    truncated_field: &str,
) -> Result<bool, AppError> {
    let Some(original) = envelope.data.get(field).and_then(serde_json::Value::as_str) else {
        return Ok(false);
    };
    let original = original.to_owned();
    let mut low = 0_usize;
    let mut high = original.len();
    let mut best = None;
    while low <= high {
        let midpoint = low + (high - low) / 2;
        let mut end = midpoint;
        while end > 0 && !original.is_char_boundary(end) {
            end -= 1;
        }
        envelope.data[field] = serde_json::Value::String(original[..end].to_owned());
        envelope.data[truncated_field] = serde_json::Value::Bool(true);
        envelope.truncated = true;
        if serialized_size(envelope)? <= MAX_ENVELOPE_BYTES {
            best = Some(end);
            low = midpoint.saturating_add(1);
        } else if midpoint == 0 {
            break;
        } else {
            high = midpoint - 1;
        }
    }
    if let Some(end) = best {
        envelope.data[field] = serde_json::Value::String(original[..end].to_owned());
        envelope.data[truncated_field] = serde_json::Value::Bool(true);
        envelope.truncated = true;
        return Ok(serialized_size(envelope)? <= MAX_ENVELOPE_BYTES);
    }
    envelope.data[field] = serde_json::Value::String(original);
    Ok(false)
}

fn public_provider_error(error: GitHubApiError) -> AppError {
    match error {
        GitHubApiError::RateLimited {
            retry_after_seconds,
        } => {
            let mut error = AppError::new(
                "github_rate_limited",
                "GitHub rate limited the request. Try again later.",
            );
            error.details = retry_after_seconds
                .map(|seconds| serde_json::json!({"retryAfterSeconds": seconds}));
            error
        }
        GitHubApiError::ResponseTooLarge => response_too_large(),
        GitHubApiError::Forbidden | GitHubApiError::NotFound => access_removed_or_not_found(),
        GitHubApiError::Unauthorized | GitHubApiError::Malformed | GitHubApiError::Transient => {
            read_unavailable()
        }
    }
}

fn stable_input_error(error: AppError) -> AppError {
    match error.code.as_str() {
        "github_reconnect_required" => reconnect_required(),
        "github_setup_required" => setup_required(),
        "github_repository_not_selected" => repository_not_selected(),
        "github_access_removed_or_not_found" => access_removed_or_not_found(),
        "github_input_invalid" => input_invalid(),
        "github_cursor_invalid" => cursor_invalid(),
        "github_file_ref_invalid" => file_ref_invalid(),
        "github_sensitive_path_blocked" => sensitive_path_blocked(),
        "github_binary_content" => binary_content(),
        "github_response_too_large" => response_too_large(),
        "github_pull_request_changed" => pull_request_changed(),
        "github_rate_limited" => public_provider_error(GitHubApiError::RateLimited {
            retry_after_seconds: error
                .details
                .as_ref()
                .and_then(|details| details.get("retryAfterSeconds"))
                .and_then(serde_json::Value::as_u64),
        }),
        "github_read_unavailable" => read_unavailable(),
        _ => read_unavailable(),
    }
}

fn unchanged_error(error: AppError) -> GitHubReadOutcome {
    GitHubReadOutcome {
        result: Err(stable_input_error(error)),
        connector_state_changed: false,
    }
}

fn outcome_from_credential_error(error: AppError) -> GitHubReadOutcome {
    let reconnect = error.code == "github_reconnect_required";
    GitHubReadOutcome {
        result: Err(stable_input_error(error)),
        connector_state_changed: reconnect,
    }
}

fn reconnect_required() -> AppError {
    AppError::new(
        "github_reconnect_required",
        "GitHub access expired. Reconnect it in settings.",
    )
}

fn setup_required() -> AppError {
    AppError::new(
        "github_setup_required",
        "GitHub setup is incomplete. Refresh it in settings.",
    )
}

fn repository_not_selected() -> AppError {
    AppError::new(
        "github_repository_not_selected",
        "This GitHub repository is not selected.",
    )
}

fn access_removed_or_not_found() -> AppError {
    AppError::new(
        "github_access_removed_or_not_found",
        "GitHub access was removed or the content was not found.",
    )
}

fn input_invalid() -> AppError {
    AppError::new("github_input_invalid", "GitHub input is invalid.")
}

fn cursor_invalid() -> AppError {
    AppError::new(
        "github_cursor_invalid",
        "The GitHub cursor is invalid or expired.",
    )
}

fn file_ref_invalid() -> AppError {
    AppError::new(
        "github_file_ref_invalid",
        "The GitHub file reference is invalid or expired.",
    )
}

fn sensitive_path_blocked() -> AppError {
    AppError::new(
        "github_sensitive_path_blocked",
        "GitHub content at this path cannot be read.",
    )
}

fn binary_content() -> AppError {
    AppError::new(
        "github_binary_content",
        "GitHub content is not supported text.",
    )
}

fn response_too_large() -> AppError {
    AppError::new(
        "github_response_too_large",
        "GitHub content exceeds the response limit.",
    )
}

fn pull_request_changed() -> AppError {
    AppError::new(
        "github_pull_request_changed",
        "The GitHub pull request changed while it was being read.",
    )
}

fn read_unavailable() -> AppError {
    AppError::new(
        "github_read_unavailable",
        "GitHub could not be read right now.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        connectors::{
            github::{GitHubTokenVault, GitHubVaultFuture},
            github_auth::tests::{scripted_server, RequestExpectations, ResponseFixture},
            github_store::StoredGitHubTokens,
        },
        db::repositories::{
            GitHubConnectionRecord, GitHubInstallationRecord, GitHubRepositoryRecord,
        },
    };
    use std::collections::HashMap;

    #[derive(Default)]
    struct InMemoryVault {
        tokens: tokio::sync::Mutex<HashMap<String, StoredGitHubTokens>>,
        load_count: std::sync::atomic::AtomicUsize,
        replace_on_load: tokio::sync::Mutex<Option<(usize, StoredGitHubTokens)>>,
    }

    impl InMemoryVault {
        async fn insert(&self, tokens: StoredGitHubTokens) {
            self.tokens
                .lock()
                .await
                .insert(tokens.github_user_id.clone(), tokens);
        }

        async fn current(&self) -> Option<StoredGitHubTokens> {
            self.tokens.lock().await.get("123").cloned()
        }

        async fn replace_on_load(&self, ordinal: usize, tokens: StoredGitHubTokens) {
            *self.replace_on_load.lock().await = Some((ordinal, tokens));
        }
    }

    impl GitHubTokenVault for InMemoryVault {
        fn load<'a>(
            &'a self,
            github_user_id: &'a str,
        ) -> GitHubVaultFuture<'a, Option<StoredGitHubTokens>> {
            Box::pin(async move {
                let ordinal = self
                    .load_count
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                    + 1;
                let replacement = {
                    let mut hook = self.replace_on_load.lock().await;
                    if hook.as_ref().is_some_and(|(target, _)| *target == ordinal) {
                        hook.take().map(|(_, tokens)| tokens)
                    } else {
                        None
                    }
                };
                let mut tokens = self.tokens.lock().await;
                if let Some(replacement) = replacement {
                    tokens.insert(github_user_id.to_owned(), replacement);
                }
                Ok(tokens.get(github_user_id).cloned())
            })
        }

        fn store<'a>(
            &'a self,
            github_user_id: &'a str,
            tokens: &'a StoredGitHubTokens,
        ) -> GitHubVaultFuture<'a, ()> {
            Box::pin(async move {
                self.tokens
                    .lock()
                    .await
                    .insert(github_user_id.to_owned(), tokens.clone());
                Ok(())
            })
        }

        fn delete<'a>(&'a self, github_user_id: &'a str) -> GitHubVaultFuture<'a, ()> {
            Box::pin(async move {
                self.tokens.lock().await.remove(github_user_id);
                Ok(())
            })
        }
    }

    fn now_unix() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_secs() as i64
    }

    fn stored_tokens(access_token: &str, refresh_token: &str) -> StoredGitHubTokens {
        StoredGitHubTokens {
            github_user_id: "123".to_owned(),
            access_token: access_token.to_owned(),
            refresh_token: refresh_token.to_owned(),
            expires_at_unix: now_unix() + 3_600,
            refresh_token_expires_at_unix: now_unix() + 86_400,
        }
    }

    fn config() -> GitHubAppConfig {
        GitHubAppConfig {
            client_id: "Iv23example".to_owned(),
            slug: "june-staging".to_owned(),
        }
    }

    async fn test_repositories() -> Repositories {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("sqlite memory");
        crate::db::migrations::run_migrations(&pool)
            .await
            .expect("migrations");
        Repositories::new(pool)
    }

    fn snapshot(last_refreshed_at: &str) -> GitHubSnapshotRecord {
        GitHubSnapshotRecord {
            connection: GitHubConnectionRecord {
                github_user_id: "123".to_owned(),
                login: "octocat".to_owned(),
                avatar_url: None,
                status: "connected".to_owned(),
            },
            installations: vec![GitHubInstallationRecord {
                installation_id: "456".to_owned(),
                github_user_id: "123".to_owned(),
                owner_id: "321".to_owned(),
                owner_login: "open-software-network".to_owned(),
                owner_type: "Organization".to_owned(),
                management_url: "https://github.com/organizations/open-software-network/settings/installations/456".to_owned(),
                repository_selection: "selected".to_owned(),
                permissions_json: r#"{"metadata":"read","contents":"read","issues":"read","pull_requests":"read","checks":"read","statuses":"read"}"#.to_owned(),
                suspended_at: None,
                last_refreshed_at: last_refreshed_at.to_owned(),
            }],
            repositories: vec![GitHubRepositoryRecord {
                repository_id: "789".to_owned(),
                installation_id: "456".to_owned(),
                owner_login: "open-software-network".to_owned(),
                name: "test-repo".to_owned(),
                full_name: "open-software-network/test-repo".to_owned(),
                is_private: true,
                is_archived: false,
                permissions_json: r#"{"pull":true,"push":false,"admin":false}"#.to_owned(),
            }],
        }
    }

    async fn seed_snapshot(repositories: &Repositories, last_refreshed_at: &str) {
        let snapshot = snapshot(last_refreshed_at);
        repositories
            .replace_github_snapshot(
                &snapshot.connection,
                &snapshot.installations,
                &snapshot.repositories,
            )
            .await
            .expect("seed snapshot");
    }

    fn service(base_url: &str) -> GitHubReadService {
        GitHubReadService::for_test(
            GitHubReadClient::for_test(base_url).expect("read client"),
            GitHubAuthClient::for_test(base_url).expect("auth client"),
            config(),
            Arc::new(CapabilityRegistry::new()),
        )
    }

    fn repository_request() -> GitHubReadRequest {
        GitHubReadRequest::GetRepository {
            repository_id: "789".to_owned(),
        }
    }

    fn repository_response() -> &'static str {
        r#"{"id":789,"archived":false,"default_branch":"main","description":"Fixture repository","language":"Rust","topics":[],"license":null,"stargazers_count":1,"watchers_count":1,"forks_count":0,"open_issues_count":2}"#
    }

    fn provider_expectation(token: &'static str) -> RequestExpectations {
        RequestExpectations {
            bearer_token: Some(token),
            ..RequestExpectations::default()
        }
    }

    fn refresh_fixture(
        rejected_refresh: &'static str,
        access_token: &str,
        refresh_token: &str,
    ) -> (ResponseFixture, RequestExpectations) {
        (
            ResponseFixture::json(
                200,
                format!(
                    r#"{{"access_token":"{access_token}","refresh_token":"{refresh_token}","expires_in":28800,"refresh_token_expires_in":15811200}}"#
                ),
            ),
            RequestExpectations {
                client_id: Some("Iv23example"),
                refresh_token: Some(rejected_refresh),
                grant_type: Some("refresh_token"),
                ..RequestExpectations::default()
            },
        )
    }

    async fn access_removed_outcome(status: u16) -> (GitHubReadOutcome, usize) {
        let installation = r#"{"installations":[{"id":456,"account":{"id":321,"login":"open-software-network","type":"Organization"},"html_url":"https://github.com/organizations/open-software-network/settings/installations/456","repository_selection":"selected","permissions":{"metadata":"read","contents":"read","issues":"read","pull_requests":"read","checks":"read","statuses":"read"},"suspended_at":null}]}"#;
        let selected = r#"{"repositories":[{"id":789,"owner":{"login":"open-software-network"},"name":"test-repo","full_name":"open-software-network/test-repo","private":true,"archived":false,"permissions":{"pull":true,"push":false,"admin":false}}]}"#;
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(status, r#"{"message":"must not surface"}"#),
                provider_expectation("access-one"),
            ),
            (
                ResponseFixture::json(200, installation),
                provider_expectation("access-one"),
            ),
            (
                ResponseFixture::json(200, selected),
                provider_expectation("access-one"),
            ),
        ])
        .await;
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "2026-07-16T00:00:00Z").await;
        let vault = InMemoryVault::default();
        vault
            .insert(stored_tokens("access-one", "refresh-one"))
            .await;
        let outcome = service(&base_url)
            .execute(repository_request(), &vault, &repositories)
            .await;
        let request_count = server.await.expect("discovery refresh server").len();
        (outcome, request_count)
    }

    fn public_provider_error_for_test(error: GitHubApiError) -> AppError {
        public_provider_error(error)
    }

    fn finalize_output_for_test(
        output: GitHubOperationOutput,
    ) -> Result<GitHubReadEnvelope, AppError> {
        finalize_output(
            &GitHubReadRequest::GetIssue {
                repository_id: "789".to_owned(),
                number: 1,
            },
            output,
            &CapabilityRegistry::new(),
        )
    }

    #[test]
    fn parses_exactly_the_sixteen_github_read_operations() {
        let requests = [
            serde_json::json!({"operation": "list_repositories", "arguments": {}}),
            serde_json::json!({
                "operation": "get_repository",
                "arguments": {"repository_id": "789"}
            }),
            serde_json::json!({
                "operation": "list_directory",
                "arguments": {"repository_id": "789", "path": "src"}
            }),
            serde_json::json!({
                "operation": "read_file",
                "arguments": {"repository_id": "789", "path": "README.md"}
            }),
            serde_json::json!({
                "operation": "search_code",
                "arguments": {"repository_id": "789", "query": "GitHubReadRequest"}
            }),
            serde_json::json!({
                "operation": "list_issues",
                "arguments": {"repository_id": "789"}
            }),
            serde_json::json!({
                "operation": "get_issue",
                "arguments": {"repository_id": "789", "number": 7}
            }),
            serde_json::json!({
                "operation": "list_issue_comments",
                "arguments": {"repository_id": "789", "number": 7}
            }),
            serde_json::json!({
                "operation": "list_pull_requests",
                "arguments": {"repository_id": "789"}
            }),
            serde_json::json!({
                "operation": "get_pull_request",
                "arguments": {"repository_id": "789", "number": 9}
            }),
            serde_json::json!({
                "operation": "list_pull_request_files",
                "arguments": {"repository_id": "789", "number": 9}
            }),
            serde_json::json!({
                "operation": "read_pull_request_file_diff",
                "arguments": {"repository_id": "789", "number": 9, "file_ref": "opaque"}
            }),
            serde_json::json!({
                "operation": "list_pull_request_commits",
                "arguments": {"repository_id": "789", "number": 9}
            }),
            serde_json::json!({
                "operation": "list_pull_request_reviews",
                "arguments": {"repository_id": "789", "number": 9}
            }),
            serde_json::json!({
                "operation": "list_pull_request_review_comments",
                "arguments": {"repository_id": "789", "number": 9}
            }),
            serde_json::json!({
                "operation": "list_pull_request_checks",
                "arguments": {"repository_id": "789", "number": 9}
            }),
        ];

        for request in requests {
            serde_json::from_value::<GitHubReadRequest>(request)
                .expect("approved read operation must deserialize");
        }
    }

    #[test]
    fn rejects_unknown_github_read_operation_and_argument() {
        let unknown_operation = serde_json::json!({
            "operation": "delete_repository",
            "arguments": {"repository_id": "789"}
        });
        assert!(serde_json::from_value::<GitHubReadRequest>(unknown_operation).is_err());

        let unknown_argument = serde_json::json!({
            "operation": "get_repository",
            "arguments": {"repository_id": "789", "owner": "attacker"}
        });
        assert!(serde_json::from_value::<GitHubReadRequest>(unknown_argument).is_err());
    }

    #[test]
    fn serializes_untrusted_repository_content_marker() {
        let envelope = GitHubReadEnvelope {
            trust: "untrusted_repository_content",
            data: serde_json::json!({"name": "test-repo"}),
            truncated: false,
            continuation_cursor: None,
            redactions_applied: false,
            sources: vec![GitHubSource {
                repository_id: "789".to_owned(),
                repository_full_name: "open-software-network/test-repo".to_owned(),
                url: "https://github.com/open-software-network/test-repo".to_owned(),
                object_id: "789".to_owned(),
                path: None,
                git_ref: None,
            }],
        };

        let serialized = serde_json::to_value(envelope).expect("serialize read envelope");
        assert_eq!(serialized["trust"], "untrusted_repository_content");
    }

    #[tokio::test]
    async fn dispatches_exactly_the_sixteen_read_variants() {
        let operations = [
            GitHubReadRequest::ListRepositories {
                cursor: None,
                limit: None,
            },
            GitHubReadRequest::GetRepository {
                repository_id: "789".to_owned(),
            },
            GitHubReadRequest::ListDirectory {
                repository_id: "789".to_owned(),
                path: "../outside".to_owned(),
                git_ref: None,
                cursor: None,
                limit: None,
            },
            GitHubReadRequest::ReadFile {
                repository_id: "789".to_owned(),
                path: ".env".to_owned(),
                git_ref: None,
                start_line: None,
                line_count: None,
            },
            GitHubReadRequest::SearchCode {
                repository_id: "789".to_owned(),
                query: "repo:another/repository".to_owned(),
                cursor: None,
                limit: None,
            },
            GitHubReadRequest::ListIssues {
                repository_id: "789".to_owned(),
                state: Some("invalid".to_owned()),
                query: None,
                labels: None,
                cursor: None,
                limit: None,
            },
            GitHubReadRequest::GetIssue {
                repository_id: "789".to_owned(),
                number: 0,
            },
            GitHubReadRequest::ListIssueComments {
                repository_id: "789".to_owned(),
                number: 0,
                cursor: None,
                limit: None,
            },
            GitHubReadRequest::ListPullRequests {
                repository_id: "789".to_owned(),
                state: Some("invalid".to_owned()),
                query: None,
                base: None,
                head: None,
                cursor: None,
                limit: None,
            },
            GitHubReadRequest::GetPullRequest {
                repository_id: "789".to_owned(),
                number: 0,
            },
            GitHubReadRequest::ListPullRequestFiles {
                repository_id: "789".to_owned(),
                number: 0,
                cursor: None,
                limit: None,
            },
            GitHubReadRequest::ReadPullRequestFileDiff {
                repository_id: "789".to_owned(),
                number: 0,
                file_ref: "opaque".to_owned(),
                cursor: None,
            },
            GitHubReadRequest::ListPullRequestCommits {
                repository_id: "789".to_owned(),
                number: 0,
                cursor: None,
                limit: None,
            },
            GitHubReadRequest::ListPullRequestReviews {
                repository_id: "789".to_owned(),
                number: 0,
                cursor: None,
                limit: None,
            },
            GitHubReadRequest::ListPullRequestReviewComments {
                repository_id: "789".to_owned(),
                number: 0,
                cursor: None,
                limit: None,
            },
            GitHubReadRequest::ListPullRequestChecks {
                repository_id: "789".to_owned(),
                number: 0,
                cursor: None,
                limit: None,
            },
        ];

        assert_eq!(
            operations.iter().map(operation_name).collect::<Vec<_>>(),
            [
                "list_repositories",
                "get_repository",
                "list_directory",
                "read_file",
                "search_code",
                "list_issues",
                "get_issue",
                "list_issue_comments",
                "list_pull_requests",
                "get_pull_request",
                "list_pull_request_files",
                "read_pull_request_file_diff",
                "list_pull_request_commits",
                "list_pull_request_reviews",
                "list_pull_request_review_comments",
                "list_pull_request_checks",
            ]
        );

        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, repository_response()),
            provider_expectation("access-one"),
        )])
        .await;
        let service = service(&base_url);
        let eligibility = github_tool_eligibility_from_snapshot(&snapshot("2026-07-16"), "123")
            .expect("eligible fixture");
        let credential = GitHubReadCredential {
            github_user_id: "123".to_owned(),
            access_token: "access-one".to_owned(),
        };
        let mut codes = Vec::new();
        for operation in operations {
            codes.push(
                service
                    .dispatch(&operation, &credential, &eligibility)
                    .await
                    .map(|_| "ok".to_owned())
                    .unwrap_or_else(|failure| match failure {
                        GitHubReadFailure::Input(error) => error.code,
                        GitHubReadFailure::Provider(_) => "provider".to_owned(),
                    }),
            );
        }
        assert_eq!(
            codes,
            [
                "ok",
                "ok",
                "github_input_invalid",
                "github_sensitive_path_blocked",
                "github_input_invalid",
                "github_input_invalid",
                "github_input_invalid",
                "github_input_invalid",
                "github_input_invalid",
                "github_input_invalid",
                "github_input_invalid",
                "github_input_invalid",
                "github_input_invalid",
                "github_input_invalid",
                "github_input_invalid",
                "github_input_invalid",
            ]
        );
        assert_eq!(server.await.expect("dispatch server").len(), 1);
    }

    #[tokio::test]
    async fn rejects_unknown_repository_id_before_provider_traffic() {
        let (base_url, server) = scripted_server(Vec::new()).await;
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "2026-07-16T00:00:00Z").await;
        let vault = InMemoryVault::default();
        vault
            .insert(stored_tokens("access-one", "refresh-one"))
            .await;
        let outcome = service(&base_url)
            .execute(
                GitHubReadRequest::GetRepository {
                    repository_id: "999".to_owned(),
                },
                &vault,
                &repositories,
            )
            .await;

        assert_eq!(
            outcome
                .result
                .expect_err("unknown repository must fail")
                .code,
            "github_repository_not_selected"
        );
        assert!(server.await.expect("empty server script").is_empty());
    }

    #[tokio::test]
    async fn revalidates_repository_snapshot_before_returning_content() {
        let reached = Arc::new(tokio::sync::Notify::new());
        let resume = Arc::new(tokio::sync::Notify::new());
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, repository_response())
                .blocked(reached.clone(), resume.clone()),
            provider_expectation("access-one"),
        )])
        .await;
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "2026-07-16T00:00:00Z").await;
        let vault = Arc::new(InMemoryVault::default());
        vault
            .insert(stored_tokens("access-one", "refresh-one"))
            .await;
        let service = Arc::new(service(&base_url));
        let read = {
            let repositories = repositories.clone();
            let vault = vault.clone();
            let service = service.clone();
            tokio::spawn(async move {
                service
                    .execute(repository_request(), vault.as_ref(), &repositories)
                    .await
            })
        };
        tokio::time::timeout(std::time::Duration::from_secs(1), reached.notified())
            .await
            .expect("provider reached");
        seed_snapshot(&repositories, "2026-07-17T00:00:00Z").await;
        resume.notify_one();

        let outcome = read.await.expect("read task");
        assert_eq!(
            outcome
                .result
                .expect_err("changed tuple must discard content")
                .code,
            "github_access_removed_or_not_found"
        );
        assert!(!outcome.connector_state_changed);
        assert_eq!(server.await.expect("provider server").len(), 1);
    }

    #[tokio::test]
    async fn disconnect_cannot_complete_before_read_response_finalization() {
        let reached = Arc::new(tokio::sync::Notify::new());
        let resume = Arc::new(tokio::sync::Notify::new());
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, repository_response())
                .blocked(reached.clone(), resume.clone()),
            provider_expectation("access-one"),
        )])
        .await;
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "2026-07-16T00:00:00Z").await;
        let vault = Arc::new(InMemoryVault::default());
        vault
            .insert(stored_tokens("access-one", "refresh-one"))
            .await;
        let service = Arc::new(service(&base_url));
        let read = {
            let repositories = repositories.clone();
            let vault = vault.clone();
            let service = service.clone();
            tokio::spawn(async move {
                service
                    .execute(repository_request(), vault.as_ref(), &repositories)
                    .await
            })
        };
        tokio::time::timeout(std::time::Duration::from_secs(1), reached.notified())
            .await
            .expect("provider reached");
        let (finished_tx, mut finished_rx) = tokio::sync::oneshot::channel();
        let disconnect = {
            let repositories = repositories.clone();
            let vault = vault.clone();
            tokio::spawn(async move {
                let result =
                    crate::connectors::github::disconnect(vault.as_ref(), &repositories).await;
                let _ = finished_tx.send(());
                result
            })
        };
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut finished_rx)
                .await
                .is_err(),
            "disconnect must remain blocked while response is unfinished"
        );
        resume.notify_one();
        let outcome = read.await.expect("read task");
        assert!(outcome.result.is_ok());
        tokio::time::timeout(std::time::Duration::from_secs(1), &mut finished_rx)
            .await
            .expect("disconnect completes after finalization")
            .expect("disconnect completion signal");
        disconnect
            .await
            .expect("disconnect task")
            .expect("disconnect result");
        assert!(repositories.github_snapshot().await.unwrap().is_none());
        assert_eq!(server.await.expect("blocked provider server").len(), 1);
    }

    #[tokio::test]
    async fn disconnect_that_wins_the_gate_prevents_provider_traffic() {
        let (base_url, server) = scripted_server(Vec::new()).await;
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "2026-07-16T00:00:00Z").await;
        let vault = Arc::new(InMemoryVault::default());
        vault
            .insert(stored_tokens("access-one", "refresh-one"))
            .await;
        let service = Arc::new(service(&base_url));
        let write = github_authorization_gate().write().await;
        vault.delete("123").await.expect("delete custody");
        repositories
            .delete_github_state("123")
            .await
            .expect("delete snapshot");
        let read = {
            let repositories = repositories.clone();
            let vault = vault.clone();
            let service = service.clone();
            tokio::spawn(async move {
                service
                    .execute(repository_request(), vault.as_ref(), &repositories)
                    .await
            })
        };
        drop(write);
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(1), read)
            .await
            .expect("read finishes")
            .expect("read task");
        assert_eq!(
            outcome.result.expect_err("disconnect won").code,
            "github_reconnect_required"
        );
        assert!(server.await.expect("empty provider server").is_empty());
    }

    #[tokio::test]
    async fn refreshes_once_after_401_and_retries_once() {
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(401, r#"{"message":"secret provider body"}"#),
                provider_expectation("access-one"),
            ),
            refresh_fixture("refresh-one", "access-two", "refresh-two"),
            (
                ResponseFixture::json(200, repository_response()),
                provider_expectation("access-two"),
            ),
        ])
        .await;
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "2026-07-16T00:00:00Z").await;
        let vault = InMemoryVault::default();
        vault
            .insert(stored_tokens("access-one", "refresh-one"))
            .await;
        let outcome = service(&base_url)
            .execute(repository_request(), &vault, &repositories)
            .await;

        let envelope = outcome.result.expect("one refresh and retry succeeds");
        assert_eq!(envelope.data["repositoryId"], "789");
        assert!(!outcome.connector_state_changed);
        let captures = server.await.expect("retry server");
        assert_eq!(captures.len(), 3);
        assert_eq!(captures[0].path, "/repos/open-software-network/test-repo");
        assert_eq!(captures[1].path, "/login/oauth/access_token");
        assert_eq!(captures[2].path, "/repos/open-software-network/test-repo");
        assert_eq!(
            vault.current().await.expect("rotated token").access_token,
            "access-two"
        );
    }

    #[tokio::test]
    async fn second_401_marks_terminal_grant_reconnect_without_a_third_request() {
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(401, r#"{"message":"first"}"#),
                provider_expectation("access-one"),
            ),
            refresh_fixture("refresh-one", "access-two", "refresh-two"),
            (
                ResponseFixture::json(401, r#"{"message":"second"}"#),
                provider_expectation("access-two"),
            ),
            (
                ResponseFixture::json(400, r#"{"error":"incorrect_client_credentials"}"#),
                RequestExpectations {
                    client_id: Some("Iv23example"),
                    refresh_token: Some("refresh-two"),
                    grant_type: Some("refresh_token"),
                    ..RequestExpectations::default()
                },
            ),
        ])
        .await;
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "2026-07-16T00:00:00Z").await;
        let vault = InMemoryVault::default();
        vault
            .insert(stored_tokens("access-one", "refresh-one"))
            .await;
        let outcome = service(&base_url)
            .execute(repository_request(), &vault, &repositories)
            .await;

        assert_eq!(
            outcome.result.expect_err("terminal grant").code,
            "github_reconnect_required"
        );
        assert!(outcome.connector_state_changed);
        assert!(vault.current().await.is_none());
        assert_eq!(
            repositories
                .github_snapshot()
                .await
                .unwrap()
                .unwrap()
                .connection
                .status,
            "reconnect_required"
        );
        assert_eq!(server.await.expect("terminal server").len(), 4);
    }

    #[tokio::test]
    async fn newer_token_after_second_401_returns_transient_without_a_third_request() {
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(401, r#"{"message":"first"}"#),
                provider_expectation("access-one"),
            ),
            refresh_fixture("refresh-one", "access-two", "refresh-two"),
            (
                ResponseFixture::json(401, r#"{"message":"second"}"#),
                provider_expectation("access-two"),
            ),
        ])
        .await;
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "2026-07-16T00:00:00Z").await;
        let vault = InMemoryVault::default();
        vault
            .insert(stored_tokens("access-one", "refresh-one"))
            .await;
        vault
            .replace_on_load(3, stored_tokens("access-three", "refresh-three"))
            .await;
        let outcome = service(&base_url)
            .execute(repository_request(), &vault, &repositories)
            .await;

        assert_eq!(
            outcome.result.expect_err("no third provider request").code,
            "github_read_unavailable"
        );
        assert!(!outcome.connector_state_changed);
        assert_eq!(
            vault
                .current()
                .await
                .expect("newer token remains")
                .access_token,
            "access-three"
        );
        assert_eq!(server.await.expect("newer-token server").len(), 3);
    }

    #[tokio::test]
    async fn forbidden_or_not_found_refreshes_discovery_once_and_returns_one_indistinguishable_error(
    ) {
        let (forbidden, forbidden_requests) = access_removed_outcome(403).await;
        let (not_found, not_found_requests) = access_removed_outcome(404).await;
        let forbidden_error = forbidden.result.expect_err("forbidden access");
        let not_found_error = not_found.result.expect_err("not found access");
        assert_eq!(forbidden_error.code, "github_access_removed_or_not_found");
        assert_eq!(not_found_error.code, forbidden_error.code);
        assert_eq!(not_found_error.message, forbidden_error.message);
        assert!(forbidden.connector_state_changed);
        assert!(not_found.connector_state_changed);
        assert_eq!(forbidden_requests, 3);
        assert_eq!(not_found_requests, 3);
    }

    #[tokio::test]
    async fn rate_limit_uses_only_trusted_retry_headers() {
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(
                429,
                r#"{"message":"provider body must never be surfaced","secret":"ghu_leak"}"#,
            )
            .with_header("Retry-After", "61")
            .with_header("X-Arbitrary-Secret", "do-not-copy"),
            provider_expectation("access-one"),
        )])
        .await;
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "2026-07-16T00:00:00Z").await;
        let vault = InMemoryVault::default();
        vault
            .insert(stored_tokens("access-one", "refresh-one"))
            .await;
        let error = service(&base_url)
            .execute(repository_request(), &vault, &repositories)
            .await
            .result
            .expect_err("rate limit");
        assert_eq!(error.code, "github_rate_limited");
        assert_eq!(
            error.details,
            Some(serde_json::json!({"retryAfterSeconds": 61}))
        );
        let serialized = serde_json::to_string(&error).unwrap();
        assert!(!serialized.contains("provider body"));
        assert!(!serialized.contains("do-not-copy"));
        assert!(!serialized.contains("ghu_leak"));
        assert_eq!(server.await.expect("rate server").len(), 1);
    }

    #[test]
    fn serialized_envelope_never_exceeds_256_kib() {
        let output = GitHubOperationOutput {
            data: serde_json::json!({"body": "x".repeat(300 * 1024), "bodyTruncated": false}),
            truncated: false,
            continuation_cursor: None,
            redactions_applied: false,
            sources: Vec::new(),
            finalization_checkpoints: None,
        };
        let envelope = finalize_output_for_test(output).expect("bounded envelope");
        assert!(serde_json::to_vec(&envelope).unwrap().len() <= 256 * 1024);
        assert_eq!(envelope.data["bodyTruncated"], true);
    }

    #[test]
    fn oversize_filtered_page_boundary_list_uses_exact_raw_checkpoint() {
        let capabilities = CapabilityRegistry::new();
        let fingerprint = crate::connectors::github_capabilities::filter_fingerprint(
            &serde_json::json!({"state":"open","query":null,"labels":[],"limit":2}),
        );
        let scope = |provider_page, raw_offset| CursorScope {
            operation: "list_issues",
            repository_id: Some("789".to_owned()),
            filter_fingerprint: fingerprint,
            provider_page,
            raw_offset,
            phase: None,
        };
        let provider_continuation = capabilities
            .issue_cursor(scope(2, 0))
            .expect("provider continuation");
        let source = |id: &str| GitHubSource {
            repository_id: "789".to_owned(),
            repository_full_name: "open-software-network/test-repo".to_owned(),
            url: format!("https://github.com/open-software-network/test-repo/issues/{id}"),
            object_id: id.to_owned(),
            path: None,
            git_ref: None,
        };
        let output = GitHubOperationOutput {
            data: serde_json::json!({"items": [
                {"number": 1, "body": "a".repeat(150 * 1024)},
                {"number": 2, "body": "b".repeat(150 * 1024)}
            ]}),
            truncated: true,
            continuation_cursor: Some(provider_continuation),
            redactions_applied: false,
            sources: vec![source("1"), source("2")],
            finalization_checkpoints: Some(GitHubFinalizationCheckpoints::List {
                data_field: "items",
                sources_per_item: true,
                resume_after_prefix: vec![scope(1, 0), scope(1, 2), scope(2, 0)],
            }),
        };
        let envelope = finalize_output(
            &GitHubReadRequest::ListIssues {
                repository_id: "789".to_owned(),
                state: None,
                query: None,
                labels: None,
                cursor: None,
                limit: Some(2),
            },
            output,
            &capabilities,
        )
        .expect("bounded list envelope");

        assert_eq!(envelope.data["items"].as_array().unwrap().len(), 1);
        assert_eq!(envelope.sources.len(), 1);
        assert!(serde_json::to_vec(&envelope).unwrap().len() <= MAX_ENVELOPE_BYTES);
        let cursor = envelope.continuation_cursor.expect("exact continuation");
        let resolved = capabilities
            .resolve_cursor(&cursor, "list_issues", Some("789"), &fingerprint)
            .expect("resolve exact checkpoint");
        assert_eq!((resolved.provider_page, resolved.raw_offset), (1, 2));
    }

    #[test]
    fn oversize_diff_uses_utf8_full_line_original_byte_checkpoint() {
        let capabilities = CapabilityRegistry::new();
        let fingerprint = crate::connectors::github_capabilities::filter_fingerprint(
            &serde_json::json!({"patch":"fixture"}),
        );
        let scope = |provider_page| CursorScope {
            operation: "read_pull_request_file_diff",
            repository_id: Some("789".to_owned()),
            filter_fingerprint: fingerprint,
            provider_page,
            raw_offset: 0,
            phase: Some("patch".to_owned()),
        };
        let first_line = format!("+{}\n", "é".repeat(70 * 1024));
        let second_line = format!("-{}\n", "界".repeat(48 * 1024));
        let patch = format!("{first_line}{second_line}");
        let first_original_end = 200_003_u32;
        let second_original_end = 400_007_u32;
        let provider_continuation = capabilities
            .issue_cursor(scope(second_original_end))
            .expect("provider continuation");
        let output = GitHubOperationOutput {
            data: serde_json::json!({
                "pullNumber": 7,
                "patchState": "provider_supplied",
                "patch": patch,
                "patchTruncated": true,
            }),
            truncated: true,
            continuation_cursor: Some(provider_continuation),
            redactions_applied: false,
            sources: vec![GitHubSource {
                repository_id: "789".to_owned(),
                repository_full_name: "open-software-network/test-repo".to_owned(),
                url: "https://github.com/open-software-network/test-repo/pull/7/files".to_owned(),
                object_id: "7:src/lib.rs".to_owned(),
                path: Some("src/lib.rs".to_owned()),
                git_ref: Some("0123456789abcdef0123456789abcdef01234567".to_owned()),
            }],
            finalization_checkpoints: Some(GitHubFinalizationCheckpoints::Patch {
                resume_after_prefix: vec![
                    GitHubPatchCheckpoint {
                        output_prefix_bytes: 0,
                        resume: scope(17),
                    },
                    GitHubPatchCheckpoint {
                        output_prefix_bytes: first_line.len(),
                        resume: scope(first_original_end),
                    },
                    GitHubPatchCheckpoint {
                        output_prefix_bytes: first_line.len() + second_line.len(),
                        resume: scope(second_original_end),
                    },
                ],
            }),
        };
        let envelope = finalize_output(
            &GitHubReadRequest::ReadPullRequestFileDiff {
                repository_id: "789".to_owned(),
                number: 7,
                file_ref: "opaque".to_owned(),
                cursor: None,
            },
            output,
            &capabilities,
        )
        .expect("bounded patch envelope");

        assert_eq!(envelope.data["patch"], first_line);
        assert!(envelope.data["patch"].as_str().unwrap().ends_with('\n'));
        assert!(serde_json::to_vec(&envelope).unwrap().len() <= MAX_ENVELOPE_BYTES);
        let cursor = envelope
            .continuation_cursor
            .expect("exact patch continuation");
        let resolved = capabilities
            .resolve_cursor(
                &cursor,
                "read_pull_request_file_diff",
                Some("789"),
                &fingerprint,
            )
            .expect("resolve patch checkpoint");
        assert_eq!(resolved.provider_page, first_original_end);
        assert_eq!(resolved.phase.as_deref(), Some("patch"));
    }

    #[test]
    fn credential_debug_and_errors_never_expose_tokens() {
        let credential = crate::connectors::github::GitHubReadCredential {
            github_user_id: "123".to_owned(),
            access_token: "ghu_super_secret".to_owned(),
        };
        let debug = format!("{credential:?}");
        assert!(!debug.contains("ghu_super_secret"));
        assert!(debug.contains("[REDACTED]"));
        assert!(!public_provider_error_for_test(GitHubApiError::Transient)
            .message
            .contains("ghu_super_secret"));
    }
}
