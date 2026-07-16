#![allow(dead_code)] // Task 8 wires the staged endpoint contract into the dispatcher.

use crate::{
    connectors::{
        github::EligibleGitHubRepository,
        github_api::{
            GitHubApiError, GitHubReadClient, LIST_RESPONSE_MAX_BYTES, SINGLETON_RESPONSE_MAX_BYTES,
        },
        github_capabilities::{filter_fingerprint, CapabilityRegistry, CursorScope},
        github_content_guard::{
            normalize_untrusted_text, validate_labels, validate_search_literal,
        },
        github_read::{
            GitHubFinalizationCheckpoints, GitHubOperationOutput, GitHubReadFailure, GitHubSource,
        },
    },
    domain::types::AppError,
};
use serde::Deserialize;
use serde_json::{json, Value};

const DEFAULT_LIST_LIMIT: u16 = 30;
const MAX_LIST_LIMIT: u16 = 50;
const ISSUE_BODY_MAX_BYTES: usize = 64 * 1024;
const COMMENT_BODY_MAX_BYTES: usize = 16 * 1024;
const DATA_SOFT_BUDGET: usize = 248 * 1024;
const TITLE_MAX_BYTES: usize = 8 * 1024;
const IDENTITY_MAX_BYTES: usize = 255;
const LABEL_DESCRIPTION_MAX_BYTES: usize = 4 * 1024;
const MILESTONE_TITLE_MAX_BYTES: usize = 2 * 1024;
const TIMESTAMP_MAX_BYTES: usize = 64;
const LIST_ISSUES_OPERATION: &str = "list_issues";
const LIST_ISSUE_COMMENTS_OPERATION: &str = "list_issue_comments";

#[derive(Clone, Debug)]
pub(crate) struct IssueList {
    pub(crate) state: Option<String>,
    pub(crate) query: Option<String>,
    pub(crate) labels: Option<Vec<String>>,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<u16>,
}

#[derive(Clone, Debug)]
pub(crate) struct IssueComments {
    pub(crate) number: u64,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<u16>,
}

pub(crate) async fn list_issues(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    request: IssueList,
    capabilities: &CapabilityRegistry,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    let state = validate_state(request.state.as_deref())?;
    let query = request
        .query
        .as_deref()
        .map(validate_search_literal)
        .transpose()
        .map_err(GitHubReadFailure::Input)?;
    let labels = validate_labels(request.labels.as_deref().unwrap_or_default())
        .map_err(GitHubReadFailure::Input)?;
    let limit = validate_limit(request.limit)?;
    let fingerprint = filter_fingerprint(&json!({
        "state": state,
        "query": query,
        "labels": labels,
        "limit": limit,
    }));
    let (provider_page, raw_offset) = resolve_page(
        capabilities,
        request.cursor.as_deref(),
        LIST_ISSUES_OPERATION,
        repository,
        &fingerprint,
    )?;

    let provider_issues = if let Some(query) = query.as_deref() {
        let qualified_query = scoped_issue_query(query, &state, &labels, repository);
        let per_page = limit.to_string();
        let page = provider_page.to_string();
        let response: ProviderIssueSearch = client
            .get_json(
                access_token,
                &["search", "issues"],
                &[
                    ("q", qualified_query.as_str()),
                    ("per_page", per_page.as_str()),
                    ("page", page.as_str()),
                ],
                LIST_RESPONSE_MAX_BYTES,
            )
            .await
            .map_err(GitHubReadFailure::Provider)?;
        response.items
    } else {
        let per_page = limit.to_string();
        let page = provider_page.to_string();
        let labels = (!labels.is_empty()).then(|| labels.join(","));
        let mut query_pairs = vec![
            ("state", state.as_str()),
            ("per_page", per_page.as_str()),
            ("page", page.as_str()),
        ];
        if let Some(labels) = labels.as_deref() {
            query_pairs.insert(1, ("labels", labels));
        }
        client
            .get_json(
                access_token,
                &[
                    "repos",
                    repository.owner_login.as_str(),
                    repository.name.as_str(),
                    "issues",
                ],
                &query_pairs,
                LIST_RESPONSE_MAX_BYTES,
            )
            .await
            .map_err(GitHubReadFailure::Provider)?
    };

    normalize_issue_page(
        provider_issues,
        repository,
        capabilities,
        fingerprint,
        provider_page,
        raw_offset,
        limit,
    )
}

pub(crate) async fn get_issue(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    number: u64,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    validate_number(number)?;
    let number_segment = number.to_string();
    let issue: ProviderIssue = client
        .get_json(
            access_token,
            &[
                "repos",
                repository.owner_login.as_str(),
                repository.name.as_str(),
                "issues",
                number_segment.as_str(),
            ],
            &[],
            SINGLETON_RESPONSE_MAX_BYTES,
        )
        .await
        .map_err(GitHubReadFailure::Provider)?;
    if issue.number != number || issue.pull_request.is_some() {
        return Err(GitHubReadFailure::Provider(GitHubApiError::NotFound));
    }
    let mut normalized = normalize_issue(issue, repository)?;
    fit_singleton_data_budget(&mut normalized)?;
    Ok(GitHubOperationOutput {
        data: normalized.data,
        truncated: normalized.content_truncated,
        continuation_cursor: None,
        redactions_applied: normalized.redactions_applied,
        sources: vec![normalized.source],
        finalization_checkpoints: None,
    })
}

pub(crate) async fn list_issue_comments(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    request: IssueComments,
    capabilities: &CapabilityRegistry,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    validate_number(request.number)?;
    let limit = validate_limit(request.limit)?;
    let fingerprint = filter_fingerprint(&json!({
        "number": request.number,
        "limit": limit,
    }));
    let (provider_page, raw_offset) = resolve_page(
        capabilities,
        request.cursor.as_deref(),
        LIST_ISSUE_COMMENTS_OPERATION,
        repository,
        &fingerprint,
    )?;
    let number = request.number.to_string();
    let per_page = limit.to_string();
    let page = provider_page.to_string();
    let comments: Vec<ProviderIssueComment> = client
        .get_json(
            access_token,
            &[
                "repos",
                repository.owner_login.as_str(),
                repository.name.as_str(),
                "issues",
                number.as_str(),
                "comments",
            ],
            &[("per_page", per_page.as_str()), ("page", page.as_str())],
            LIST_RESPONSE_MAX_BYTES,
        )
        .await
        .map_err(GitHubReadFailure::Provider)?;

    normalize_comment_page(
        comments,
        repository,
        request.number,
        capabilities,
        fingerprint,
        provider_page,
        raw_offset,
        limit,
    )
}

fn validate_state(state: Option<&str>) -> Result<String, GitHubReadFailure> {
    match state.unwrap_or("open") {
        state @ ("open" | "closed" | "all") => Ok(state.to_owned()),
        _ => Err(input_invalid()),
    }
}

fn validate_limit(limit: Option<u16>) -> Result<u16, GitHubReadFailure> {
    match limit.unwrap_or(DEFAULT_LIST_LIMIT) {
        1..=MAX_LIST_LIMIT => Ok(limit.unwrap_or(DEFAULT_LIST_LIMIT)),
        _ => Err(input_invalid()),
    }
}

fn validate_number(number: u64) -> Result<(), GitHubReadFailure> {
    if number == 0 {
        Err(input_invalid())
    } else {
        Ok(())
    }
}

fn input_invalid() -> GitHubReadFailure {
    GitHubReadFailure::Input(AppError::new(
        "github_input_invalid",
        "GitHub input is invalid.",
    ))
}

fn resolve_page(
    capabilities: &CapabilityRegistry,
    cursor: Option<&str>,
    operation: &'static str,
    repository: &EligibleGitHubRepository,
    fingerprint: &[u8; 32],
) -> Result<(u32, u16), GitHubReadFailure> {
    let Some(cursor) = cursor else {
        return Ok((1, 0));
    };
    let scope = capabilities
        .resolve_cursor(
            cursor,
            operation,
            Some(repository.repository_id.as_str()),
            fingerprint,
        )
        .map_err(GitHubReadFailure::Input)?;
    if scope.provider_page == 0 || scope.phase.is_some() {
        return Err(GitHubReadFailure::Input(AppError::new(
            "github_cursor_invalid",
            "The GitHub cursor is invalid or expired.",
        )));
    }
    Ok((scope.provider_page, scope.raw_offset))
}

fn issue_cursor(
    capabilities: &CapabilityRegistry,
    repository: &EligibleGitHubRepository,
    filter_fingerprint: [u8; 32],
    provider_page: u32,
    raw_offset: u16,
) -> Result<String, GitHubReadFailure> {
    capabilities
        .issue_cursor(CursorScope {
            operation: LIST_ISSUES_OPERATION,
            repository_id: Some(repository.repository_id.clone()),
            filter_fingerprint,
            provider_page,
            raw_offset,
            phase: None,
        })
        .map_err(GitHubReadFailure::Input)
}

fn comment_cursor(
    capabilities: &CapabilityRegistry,
    repository: &EligibleGitHubRepository,
    filter_fingerprint: [u8; 32],
    provider_page: u32,
    raw_offset: u16,
) -> Result<String, GitHubReadFailure> {
    capabilities
        .issue_cursor(CursorScope {
            operation: LIST_ISSUE_COMMENTS_OPERATION,
            repository_id: Some(repository.repository_id.clone()),
            filter_fingerprint,
            provider_page,
            raw_offset,
            phase: None,
        })
        .map_err(GitHubReadFailure::Input)
}

fn scoped_issue_query(
    query: &str,
    state: &str,
    labels: &[String],
    repository: &EligibleGitHubRepository,
) -> String {
    let mut scoped = format!("{query} repo:{} is:issue", repository.full_name);
    if state != "all" {
        scoped.push_str(" is:");
        scoped.push_str(state);
    }
    for label in labels {
        scoped.push_str(" label:\"");
        for character in label.chars() {
            if matches!(character, '\\' | '"') {
                scoped.push('\\');
            }
            scoped.push(character);
        }
        scoped.push('"');
    }
    scoped
}

fn normalize_issue_page(
    provider_items: Vec<ProviderIssue>,
    repository: &EligibleGitHubRepository,
    capabilities: &CapabilityRegistry,
    fingerprint: [u8; 32],
    provider_page: u32,
    raw_offset: u16,
    limit: u16,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    let raw_len = provider_items.len().min(limit as usize);
    let mut items = Vec::new();
    let mut sources = Vec::new();
    let mut redactions_applied = false;
    let mut content_truncated = false;
    let mut same_page_offset = None;
    let mut resume_after_prefix = vec![CursorScope {
        operation: LIST_ISSUES_OPERATION,
        repository_id: Some(repository.repository_id.clone()),
        filter_fingerprint: fingerprint,
        provider_page,
        raw_offset,
        phase: None,
    }];

    for (raw_index, issue) in provider_items
        .into_iter()
        .take(limit as usize)
        .enumerate()
        .skip(raw_offset as usize)
    {
        if issue.pull_request.is_some() {
            continue;
        }
        let normalized = normalize_issue(issue, repository)?;
        let mut candidate = items.clone();
        candidate.push(normalized.data.clone());
        if serde_json::to_vec(&json!({"items": candidate}))
            .map_err(|_| GitHubReadFailure::Provider(GitHubApiError::Malformed))?
            .len()
            > DATA_SOFT_BUDGET
        {
            if items.is_empty() && raw_index == raw_offset as usize {
                return Err(GitHubReadFailure::Provider(
                    GitHubApiError::ResponseTooLarge,
                ));
            }
            same_page_offset = Some(raw_index as u16);
            break;
        }
        redactions_applied |= normalized.redactions_applied;
        content_truncated |= normalized.content_truncated;
        items.push(normalized.data);
        sources.push(normalized.source);
        resume_after_prefix.push(CursorScope {
            operation: LIST_ISSUES_OPERATION,
            repository_id: Some(repository.repository_id.clone()),
            filter_fingerprint: fingerprint,
            provider_page,
            raw_offset: u16::try_from(raw_index + 1)
                .map_err(|_| GitHubReadFailure::Provider(GitHubApiError::ResponseTooLarge))?,
            phase: None,
        });
    }

    let continuation_cursor = if let Some(raw_offset) = same_page_offset {
        Some(issue_cursor(
            capabilities,
            repository,
            fingerprint,
            provider_page,
            raw_offset,
        )?)
    } else if raw_len == limit as usize {
        let next_page = provider_page
            .checked_add(1)
            .ok_or(GitHubReadFailure::Provider(
                GitHubApiError::ResponseTooLarge,
            ))?;
        Some(issue_cursor(
            capabilities,
            repository,
            fingerprint,
            next_page,
            0,
        )?)
    } else {
        None
    };
    let truncated = continuation_cursor.is_some() || content_truncated;
    Ok(GitHubOperationOutput {
        data: json!({"items": items}),
        truncated,
        continuation_cursor,
        redactions_applied,
        sources,
        finalization_checkpoints: Some(GitHubFinalizationCheckpoints::List {
            data_field: "items",
            sources_per_item: true,
            resume_after_prefix,
        }),
    })
}

#[allow(clippy::too_many_arguments)]
fn normalize_comment_page(
    provider_items: Vec<ProviderIssueComment>,
    repository: &EligibleGitHubRepository,
    issue_number: u64,
    capabilities: &CapabilityRegistry,
    fingerprint: [u8; 32],
    provider_page: u32,
    raw_offset: u16,
    limit: u16,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    let raw_len = provider_items.len().min(limit as usize);
    let mut items = Vec::new();
    let mut sources = Vec::new();
    let mut redactions_applied = false;
    let mut content_truncated = false;
    let mut same_page_offset = None;
    let mut resume_after_prefix = vec![CursorScope {
        operation: LIST_ISSUE_COMMENTS_OPERATION,
        repository_id: Some(repository.repository_id.clone()),
        filter_fingerprint: fingerprint,
        provider_page,
        raw_offset,
        phase: None,
    }];

    for (raw_index, comment) in provider_items
        .into_iter()
        .take(limit as usize)
        .enumerate()
        .skip(raw_offset as usize)
    {
        let normalized = normalize_comment(comment, repository, issue_number)?;
        let mut candidate = items.clone();
        candidate.push(normalized.data.clone());
        if serde_json::to_vec(&json!({"items": candidate}))
            .map_err(|_| GitHubReadFailure::Provider(GitHubApiError::Malformed))?
            .len()
            > DATA_SOFT_BUDGET
        {
            same_page_offset = Some(raw_index as u16);
            break;
        }
        redactions_applied |= normalized.redactions_applied;
        content_truncated |= normalized.content_truncated;
        items.push(normalized.data);
        sources.push(normalized.source);
        resume_after_prefix.push(CursorScope {
            operation: LIST_ISSUE_COMMENTS_OPERATION,
            repository_id: Some(repository.repository_id.clone()),
            filter_fingerprint: fingerprint,
            provider_page,
            raw_offset: u16::try_from(raw_index + 1)
                .map_err(|_| GitHubReadFailure::Provider(GitHubApiError::ResponseTooLarge))?,
            phase: None,
        });
    }

    let continuation_cursor = if let Some(raw_offset) = same_page_offset {
        Some(comment_cursor(
            capabilities,
            repository,
            fingerprint,
            provider_page,
            raw_offset,
        )?)
    } else if raw_len == limit as usize {
        let next_page = provider_page
            .checked_add(1)
            .ok_or(GitHubReadFailure::Provider(
                GitHubApiError::ResponseTooLarge,
            ))?;
        Some(comment_cursor(
            capabilities,
            repository,
            fingerprint,
            next_page,
            0,
        )?)
    } else {
        None
    };
    let truncated = continuation_cursor.is_some() || content_truncated;
    Ok(GitHubOperationOutput {
        data: json!({"items": items}),
        truncated,
        continuation_cursor,
        redactions_applied,
        sources,
        finalization_checkpoints: Some(GitHubFinalizationCheckpoints::List {
            data_field: "items",
            sources_per_item: true,
            resume_after_prefix,
        }),
    })
}

struct NormalizedObject {
    data: Value,
    source: GitHubSource,
    redactions_applied: bool,
    content_truncated: bool,
}

fn normalize_issue(
    issue: ProviderIssue,
    repository: &EligibleGitHubRepository,
) -> Result<NormalizedObject, GitHubReadFailure> {
    if issue.id == 0 || issue.number == 0 {
        return Err(GitHubReadFailure::Provider(GitHubApiError::Malformed));
    }
    if !matches!(issue.state.as_str(), "open" | "closed")
        || issue
            .state_reason
            .as_deref()
            .is_some_and(|reason| !matches!(reason, "completed" | "not_planned" | "reopened"))
    {
        return Err(GitHubReadFailure::Provider(GitHubApiError::Malformed));
    }
    let mut redactions_applied = false;
    let title = normalize_metadata(&issue.title, TITLE_MAX_BYTES, &mut redactions_applied)?;
    let body = normalize_body(issue.body.as_deref(), ISSUE_BODY_MAX_BYTES)?;
    redactions_applied |= body.redactions_applied;
    let user = normalize_user(issue.user, &mut redactions_applied)?;
    let labels = issue
        .labels
        .into_iter()
        .map(|label| normalize_label(label, &mut redactions_applied))
        .collect::<Result<Vec<_>, _>>()?;
    let milestone = issue
        .milestone
        .map(|milestone| normalize_milestone(milestone, &mut redactions_applied))
        .transpose()?;
    let created_at = normalize_timestamp(&issue.created_at, &mut redactions_applied)?;
    let updated_at = normalize_timestamp(&issue.updated_at, &mut redactions_applied)?;
    let closed_at = issue
        .closed_at
        .as_deref()
        .map(|value| normalize_timestamp(value, &mut redactions_applied))
        .transpose()?;
    let source = issue_source(repository, issue.number, issue.id);

    Ok(NormalizedObject {
        data: json!({
            "id": issue.id,
            "number": issue.number,
            "title": title,
            "body": body.text,
            "bodyTruncated": body.truncated,
            "user": user,
            "labels": labels,
            "milestone": milestone,
            "state": issue.state,
            "stateReason": issue.state_reason,
            "locked": issue.locked,
            "commentCount": issue.comments,
            "createdAt": created_at,
            "updatedAt": updated_at,
            "closedAt": closed_at,
        }),
        source,
        redactions_applied,
        content_truncated: body.truncated,
    })
}

fn normalize_comment(
    comment: ProviderIssueComment,
    repository: &EligibleGitHubRepository,
    issue_number: u64,
) -> Result<NormalizedObject, GitHubReadFailure> {
    if comment.id == 0 {
        return Err(GitHubReadFailure::Provider(GitHubApiError::Malformed));
    }
    let mut redactions_applied = false;
    let body = normalize_body(comment.body.as_deref(), COMMENT_BODY_MAX_BYTES)?;
    redactions_applied |= body.redactions_applied;
    let user = normalize_user(comment.user, &mut redactions_applied)?;
    let created_at = normalize_timestamp(&comment.created_at, &mut redactions_applied)?;
    let updated_at = normalize_timestamp(&comment.updated_at, &mut redactions_applied)?;
    let source = comment_source(repository, issue_number, comment.id);

    Ok(NormalizedObject {
        data: json!({
            "id": comment.id,
            "body": body.text,
            "bodyTruncated": body.truncated,
            "user": user,
            "createdAt": created_at,
            "updatedAt": updated_at,
        }),
        source,
        redactions_applied,
        content_truncated: body.truncated,
    })
}

fn fit_singleton_data_budget(normalized: &mut NormalizedObject) -> Result<(), GitHubReadFailure> {
    let serialized_len = |data: &Value| {
        serde_json::to_vec(data)
            .map(|bytes| bytes.len())
            .map_err(|_| GitHubReadFailure::Provider(GitHubApiError::Malformed))
    };
    if serialized_len(&normalized.data)? <= DATA_SOFT_BUDGET {
        return Ok(());
    }

    let Some(body) = normalized.data["body"].as_str().map(str::to_owned) else {
        return Err(GitHubReadFailure::Provider(
            GitHubApiError::ResponseTooLarge,
        ));
    };
    normalized.data["body"] = Value::String(String::new());
    if serialized_len(&normalized.data)? > DATA_SOFT_BUDGET {
        return Err(GitHubReadFailure::Provider(
            GitHubApiError::ResponseTooLarge,
        ));
    }

    let mut boundaries = body
        .char_indices()
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    boundaries.push(body.len());
    let mut low = 0_usize;
    let mut high = boundaries.len() - 1;
    let mut best = 0_usize;
    while low <= high {
        let middle = low + (high - low) / 2;
        normalized.data["body"] = Value::String(body[..boundaries[middle]].to_owned());
        if serialized_len(&normalized.data)? <= DATA_SOFT_BUDGET {
            best = middle;
            low = middle + 1;
        } else if middle == 0 {
            break;
        } else {
            high = middle - 1;
        }
    }
    normalized.data["body"] = Value::String(body[..boundaries[best]].to_owned());
    normalized.data["bodyTruncated"] = Value::Bool(true);
    normalized.content_truncated = true;
    Ok(())
}

struct NormalizedBody {
    text: Option<String>,
    truncated: bool,
    redactions_applied: bool,
}

fn normalize_body(
    body: Option<&str>,
    max_bytes: usize,
) -> Result<NormalizedBody, GitHubReadFailure> {
    let Some(body) = body else {
        return Ok(NormalizedBody {
            text: None,
            truncated: false,
            redactions_applied: false,
        });
    };
    let guarded = normalize_untrusted_text(body.as_bytes(), max_bytes, usize::MAX)
        .map_err(GitHubReadFailure::Input)?;
    Ok(NormalizedBody {
        text: Some(guarded.text),
        truncated: guarded.truncated,
        redactions_applied: guarded.redactions_applied,
    })
}

fn normalize_metadata(
    value: &str,
    max_bytes: usize,
    redactions_applied: &mut bool,
) -> Result<String, GitHubReadFailure> {
    let guarded = normalize_untrusted_text(value.as_bytes(), max_bytes, 32)
        .map_err(GitHubReadFailure::Input)?;
    if guarded.truncated {
        return Err(GitHubReadFailure::Provider(
            GitHubApiError::ResponseTooLarge,
        ));
    }
    *redactions_applied |= guarded.redactions_applied;
    Ok(guarded.text)
}

fn normalize_timestamp(
    value: &str,
    redactions_applied: &mut bool,
) -> Result<String, GitHubReadFailure> {
    normalize_metadata(value, TIMESTAMP_MAX_BYTES, redactions_applied)
}

fn normalize_user(
    user: Option<ProviderUser>,
    redactions_applied: &mut bool,
) -> Result<Option<Value>, GitHubReadFailure> {
    user.map(|user| {
        if user.id == 0 {
            return Err(GitHubReadFailure::Provider(GitHubApiError::Malformed));
        }
        Ok(json!({
            "id": user.id,
            "login": normalize_metadata(&user.login, IDENTITY_MAX_BYTES, redactions_applied)?,
            "type": normalize_metadata(&user.kind, IDENTITY_MAX_BYTES, redactions_applied)?,
        }))
    })
    .transpose()
}

fn normalize_label(
    label: ProviderLabel,
    redactions_applied: &mut bool,
) -> Result<Value, GitHubReadFailure> {
    if label.id == 0
        || label.color.len() != 6
        || !label.color.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(GitHubReadFailure::Provider(GitHubApiError::Malformed));
    }
    Ok(json!({
        "id": label.id,
        "name": normalize_metadata(&label.name, IDENTITY_MAX_BYTES, redactions_applied)?,
        "color": label.color.to_ascii_lowercase(),
        "description": label.description
            .as_deref()
            .map(|value| normalize_metadata(value, LABEL_DESCRIPTION_MAX_BYTES, redactions_applied))
            .transpose()?,
    }))
}

fn normalize_milestone(
    milestone: ProviderMilestone,
    redactions_applied: &mut bool,
) -> Result<Value, GitHubReadFailure> {
    if milestone.id == 0
        || milestone.number == 0
        || !matches!(milestone.state.as_str(), "open" | "closed")
    {
        return Err(GitHubReadFailure::Provider(GitHubApiError::Malformed));
    }
    Ok(json!({
        "id": milestone.id,
        "number": milestone.number,
        "title": normalize_metadata(&milestone.title, MILESTONE_TITLE_MAX_BYTES, redactions_applied)?,
        "state": milestone.state,
        "openIssueCount": milestone.open_issues,
        "closedIssueCount": milestone.closed_issues,
        "createdAt": normalize_timestamp(&milestone.created_at, redactions_applied)?,
        "updatedAt": normalize_timestamp(&milestone.updated_at, redactions_applied)?,
        "dueAt": milestone
            .due_on
            .as_deref()
            .map(|value| normalize_timestamp(value, redactions_applied))
            .transpose()?,
        "closedAt": milestone
            .closed_at
            .as_deref()
            .map(|value| normalize_timestamp(value, redactions_applied))
            .transpose()?,
    }))
}

fn issue_source(
    repository: &EligibleGitHubRepository,
    issue_number: u64,
    issue_id: u64,
) -> GitHubSource {
    GitHubSource {
        repository_id: repository.repository_id.clone(),
        repository_full_name: repository.full_name.clone(),
        url: format!(
            "https://github.com/{}/issues/{issue_number}",
            repository.full_name
        ),
        object_id: issue_id.to_string(),
        path: None,
        git_ref: None,
    }
}

fn comment_source(
    repository: &EligibleGitHubRepository,
    issue_number: u64,
    comment_id: u64,
) -> GitHubSource {
    GitHubSource {
        repository_id: repository.repository_id.clone(),
        repository_full_name: repository.full_name.clone(),
        url: format!(
            "https://github.com/{}/issues/{issue_number}#issuecomment-{comment_id}",
            repository.full_name
        ),
        object_id: comment_id.to_string(),
        path: None,
        git_ref: None,
    }
}

#[derive(Deserialize)]
struct ProviderIssueSearch {
    items: Vec<ProviderIssue>,
}

#[derive(Deserialize)]
struct ProviderIssue {
    id: u64,
    number: u64,
    title: String,
    body: Option<String>,
    user: Option<ProviderUser>,
    #[serde(default)]
    labels: Vec<ProviderLabel>,
    milestone: Option<ProviderMilestone>,
    state: String,
    state_reason: Option<String>,
    locked: bool,
    comments: u64,
    created_at: String,
    updated_at: String,
    closed_at: Option<String>,
    #[serde(default)]
    pull_request: Option<Value>,
}

#[derive(Deserialize)]
struct ProviderIssueComment {
    id: u64,
    body: Option<String>,
    user: Option<ProviderUser>,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
struct ProviderUser {
    id: u64,
    login: String,
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct ProviderLabel {
    id: u64,
    name: String,
    color: String,
    description: Option<String>,
}

#[derive(Deserialize)]
struct ProviderMilestone {
    id: u64,
    number: u64,
    title: String,
    state: String,
    open_issues: u64,
    closed_issues: u64,
    created_at: String,
    updated_at: String,
    due_on: Option<String>,
    closed_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::{
        github::EligibleGitHubRepository,
        github_api::{GitHubApiError, GitHubReadClient},
        github_auth::tests::{scripted_server, RequestExpectations, ResponseFixture},
        github_capabilities::CapabilityRegistry,
        github_read::{GitHubOperationOutput, GitHubReadFailure},
    };
    use serde_json::{json, Value};

    const FIXTURE_TOKEN: &str = "fixture-issue-token";
    const DATA_SOFT_BUDGET: usize = 248 * 1024;

    fn repository() -> EligibleGitHubRepository {
        EligibleGitHubRepository {
            repository_id: "123456".into(),
            installation_id: "654321".into(),
            owner_login: "open-software-network".into(),
            name: "test-repo".into(),
            full_name: "open-software-network/test-repo".into(),
            private: true,
        }
    }

    fn other_repository() -> EligibleGitHubRepository {
        EligibleGitHubRepository {
            repository_id: "999999".into(),
            installation_id: "654321".into(),
            owner_login: "open-software-network".into(),
            name: "other-repo".into(),
            full_name: "open-software-network/other-repo".into(),
            private: true,
        }
    }

    fn issue(number: u64, body: impl Into<String>) -> Value {
        json!({
            "id": 1000 + number,
            "node_id": format!("I_fixture_{number}"),
            "number": number,
            "title": format!("Issue {number}"),
            "body": body.into(),
            "user": {
                "id": 42,
                "login": "octocat",
                "type": "User",
                "avatar_url": "https://attacker.invalid/avatar"
            },
            "labels": [{
                "id": 91,
                "name": "bug",
                "color": "d73a4a",
                "description": "Something is not working",
                "url": "https://attacker.invalid/label"
            }],
            "milestone": {
                "id": 71,
                "number": 3,
                "title": "Next release",
                "state": "open",
                "open_issues": 4,
                "closed_issues": 5,
                "created_at": "2026-07-01T00:00:00Z",
                "updated_at": "2026-07-02T00:00:00Z",
                "due_on": "2026-08-01T00:00:00Z",
                "closed_at": null,
                "url": "https://attacker.invalid/milestone"
            },
            "state": "open",
            "state_reason": null,
            "locked": false,
            "comments": 2,
            "created_at": "2026-07-10T00:00:00Z",
            "updated_at": "2026-07-11T00:00:00Z",
            "closed_at": null,
            "html_url": "https://attacker.invalid/issue",
            "url": "https://attacker.invalid/api/issue",
            "repository_url": "https://attacker.invalid/repository",
            "author_association": "OWNER",
            "reactions": {"url": "https://attacker.invalid/reactions"},
            "repository": {"full_name": "attacker/escape"},
            "_links": {"self": {"href": "https://attacker.invalid/link"}}
        })
    }

    fn pull_request_marker(number: u64) -> Value {
        let mut value = issue(number, "This is a pull request marker.");
        value["pull_request"] = json!({
            "url": "https://attacker.invalid/pull",
            "html_url": "https://attacker.invalid/pull/html"
        });
        value
    }

    fn issue_with_oversized_labels(number: u64) -> Value {
        let mut value = issue(number, "body");
        value["labels"] = Value::Array(
            (0_u64..80)
                .map(|index| {
                    json!({
                        "id": 20_000 + index,
                        "name": format!("oversized-label-{index}"),
                        "color": "abcdef",
                        "description": "d".repeat(4 * 1024)
                    })
                })
                .collect(),
        );
        value
    }

    fn comment(id: u64, body: impl Into<String>) -> Value {
        json!({
            "id": id,
            "node_id": format!("IC_fixture_{id}"),
            "body": body.into(),
            "user": {
                "id": 43,
                "login": "reviewer",
                "type": "User",
                "avatar_url": "https://attacker.invalid/comment-avatar"
            },
            "created_at": "2026-07-12T00:00:00Z",
            "updated_at": "2026-07-13T00:00:00Z",
            "html_url": "https://attacker.invalid/comment",
            "url": "https://attacker.invalid/api/comment",
            "issue_url": "https://attacker.invalid/issue",
            "author_association": "MEMBER",
            "reactions": {"url": "https://attacker.invalid/comment-reactions"}
        })
    }

    fn issue_list(
        state: Option<&str>,
        query: Option<&str>,
        labels: &[&str],
        cursor: Option<String>,
        limit: Option<u16>,
    ) -> IssueList {
        IssueList {
            state: state.map(str::to_owned),
            query: query.map(str::to_owned),
            labels: (!labels.is_empty())
                .then(|| labels.iter().map(|label| (*label).into()).collect()),
            cursor,
            limit,
        }
    }

    fn comments_request(number: u64, cursor: Option<String>, limit: Option<u16>) -> IssueComments {
        IssueComments {
            number,
            cursor,
            limit,
        }
    }

    fn assert_input_code(
        result: Result<GitHubOperationOutput, GitHubReadFailure>,
        expected_code: &str,
    ) {
        match result {
            Err(GitHubReadFailure::Input(error)) => assert_eq!(error.code, expected_code),
            Err(GitHubReadFailure::Provider(error)) => {
                panic!("expected input failure, got provider failure: {error:?}")
            }
            Ok(_) => panic!("expected input failure"),
        }
    }

    fn assert_provider_error(
        result: Result<GitHubOperationOutput, GitHubReadFailure>,
        expected: GitHubApiError,
    ) {
        match result {
            Err(GitHubReadFailure::Provider(actual)) => assert_eq!(actual, expected),
            Err(GitHubReadFailure::Input(error)) => {
                panic!(
                    "expected provider failure, got input failure: {}",
                    error.code
                )
            }
            Ok(_) => panic!("expected provider failure"),
        }
    }

    #[tokio::test]
    async fn issue_reads_use_only_the_fixed_repository_get_families() {
        let list_body = json!([issue(7, "List body")]).to_string();
        let singleton_body = issue(7, "Singleton body").to_string();
        let comments_body = json!([comment(501, "Comment body")]).to_string();
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, list_body),
                RequestExpectations {
                    bearer_token: Some(FIXTURE_TOKEN),
                    ..RequestExpectations::default()
                },
            ),
            (
                ResponseFixture::json(200, singleton_body),
                RequestExpectations {
                    bearer_token: Some(FIXTURE_TOKEN),
                    ..RequestExpectations::default()
                },
            ),
            (
                ResponseFixture::json(200, comments_body),
                RequestExpectations {
                    bearer_token: Some(FIXTURE_TOKEN),
                    ..RequestExpectations::default()
                },
            ),
        ])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("client");
        let capabilities = CapabilityRegistry::new();

        list_issues(
            &client,
            FIXTURE_TOKEN,
            &repository(),
            issue_list(
                Some("open"),
                None,
                &["bug", "BUG", "help wanted"],
                None,
                None,
            ),
            &capabilities,
        )
        .await
        .expect("list issues");
        get_issue(&client, FIXTURE_TOKEN, &repository(), 7)
            .await
            .expect("get issue");
        list_issue_comments(
            &client,
            FIXTURE_TOKEN,
            &repository(),
            comments_request(7, None, None),
            &capabilities,
        )
        .await
        .expect("list comments");

        let captures = server.await.expect("server");
        assert_eq!(captures.len(), 3);
        assert!(captures.iter().all(|capture| capture.method == "GET"));
        assert_eq!(
            captures[0].path,
            "/repos/open-software-network/test-repo/issues?state=open&labels=bug%2Chelp+wanted&per_page=30&page=1"
        );
        assert_eq!(
            captures[1].path,
            "/repos/open-software-network/test-repo/issues/7"
        );
        assert_eq!(
            captures[2].path,
            "/repos/open-software-network/test-repo/issues/7/comments?per_page=30&page=1"
        );
        assert!(captures
            .iter()
            .all(|capture| capture.has_expected_bearer_token));
    }

    #[tokio::test]
    async fn scoped_issue_search_rejects_model_qualifiers_and_appends_owned_scope() {
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, json!({"items": [issue(8, "Search body")]}).to_string()),
            RequestExpectations {
                bearer_token: Some(FIXTURE_TOKEN),
                ..RequestExpectations::default()
            },
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("client");
        let capabilities = CapabilityRegistry::new();
        list_issues(
            &client,
            FIXTURE_TOKEN,
            &repository(),
            issue_list(Some("all"), Some("fix parser"), &[], None, Some(12)),
            &capabilities,
        )
        .await
        .expect("search issues");

        let captures = server.await.expect("server");
        assert_eq!(captures.len(), 1);
        assert_eq!(
            captures[0].path,
            "/search/issues?q=fix+parser+repo%3Aopen-software-network%2Ftest-repo+is%3Aissue&per_page=12&page=1"
        );

        for query in [
            "bug repo:attacker/escape",
            "is:pr bug",
            "org:somewhere bug",
            "label:\"security\"",
        ] {
            assert_input_code(
                list_issues(
                    &client,
                    FIXTURE_TOKEN,
                    &repository(),
                    issue_list(Some("all"), Some(query), &[], None, Some(12)),
                    &capabilities,
                )
                .await,
                "github_input_invalid",
            );
        }
    }

    #[tokio::test]
    async fn issue_input_validation_is_fail_closed_and_bounded() {
        let client = GitHubReadClient::for_test("http://127.0.0.1:1").expect("client");
        let capabilities = CapabilityRegistry::new();

        for state in ["OPEN", "draft", "", "all "] {
            assert_input_code(
                list_issues(
                    &client,
                    FIXTURE_TOKEN,
                    &repository(),
                    issue_list(Some(state), None, &[], None, None),
                    &capabilities,
                )
                .await,
                "github_input_invalid",
            );
        }
        assert_input_code(
            list_issues(
                &client,
                FIXTURE_TOKEN,
                &repository(),
                issue_list(Some("open"), None, &[], None, Some(51)),
                &capabilities,
            )
            .await,
            "github_input_invalid",
        );
        let too_many_labels = vec!["label"; 21];
        assert_input_code(
            list_issues(
                &client,
                FIXTURE_TOKEN,
                &repository(),
                issue_list(Some("closed"), None, &too_many_labels, None, Some(50)),
                &capabilities,
            )
            .await,
            "github_input_invalid",
        );
        let overlong_label = "x".repeat(51);
        assert_input_code(
            list_issues(
                &client,
                FIXTURE_TOKEN,
                &repository(),
                IssueList {
                    state: Some("closed".into()),
                    query: None,
                    labels: Some(vec![overlong_label]),
                    cursor: None,
                    limit: Some(50),
                },
                &capabilities,
            )
            .await,
            "github_input_invalid",
        );
        assert_input_code(
            get_issue(&client, FIXTURE_TOKEN, &repository(), 0).await,
            "github_input_invalid",
        );
        assert_input_code(
            list_issue_comments(
                &client,
                FIXTURE_TOKEN,
                &repository(),
                comments_request(0, None, None),
                &capabilities,
            )
            .await,
            "github_input_invalid",
        );
    }

    #[tokio::test]
    async fn list_mode_filters_pull_markers_without_fetching_hidden_pages() {
        let body = json!([
            pull_request_marker(9),
            issue(10, "Visible issue"),
            pull_request_marker(11)
        ])
        .to_string();
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, body),
            RequestExpectations {
                bearer_token: Some(FIXTURE_TOKEN),
                ..RequestExpectations::default()
            },
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("client");
        let output = list_issues(
            &client,
            FIXTURE_TOKEN,
            &repository(),
            issue_list(Some("all"), None, &[], None, Some(3)),
            &CapabilityRegistry::new(),
        )
        .await
        .expect("list issues");

        assert_eq!(output.data["items"].as_array().expect("items").len(), 1);
        assert_eq!(output.data["items"][0]["number"], 10);
        assert!(output.continuation_cursor.is_some());
        let captures = server.await.expect("server");
        assert_eq!(
            captures.len(),
            1,
            "one tool call may fetch only one provider page"
        );
    }

    #[tokio::test]
    async fn issue_cursor_binds_repository_operation_state_query_and_labels() {
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, json!({"items": [issue(12, "Body")]}).to_string()),
            RequestExpectations {
                bearer_token: Some(FIXTURE_TOKEN),
                ..RequestExpectations::default()
            },
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("client");
        let capabilities = CapabilityRegistry::new();
        let output = list_issues(
            &client,
            FIXTURE_TOKEN,
            &repository(),
            issue_list(Some("open"), Some("parser"), &["bug"], None, Some(1)),
            &capabilities,
        )
        .await
        .expect("first page");
        let cursor = output.continuation_cursor.expect("cursor");
        server.await.expect("server");

        let replays = [
            (
                repository(),
                issue_list(
                    Some("closed"),
                    Some("parser"),
                    &["bug"],
                    Some(cursor.clone()),
                    Some(1),
                ),
            ),
            (
                repository(),
                issue_list(
                    Some("open"),
                    Some("different"),
                    &["bug"],
                    Some(cursor.clone()),
                    Some(1),
                ),
            ),
            (
                repository(),
                issue_list(
                    Some("open"),
                    Some("parser"),
                    &["feature"],
                    Some(cursor.clone()),
                    Some(1),
                ),
            ),
            (
                other_repository(),
                issue_list(
                    Some("open"),
                    Some("parser"),
                    &["bug"],
                    Some(cursor.clone()),
                    Some(1),
                ),
            ),
            (
                repository(),
                issue_list(Some("open"), None, &["bug"], Some(cursor.clone()), Some(1)),
            ),
        ];
        for (repository, request) in replays {
            assert_input_code(
                list_issues(&client, FIXTURE_TOKEN, &repository, request, &capabilities).await,
                "github_cursor_invalid",
            );
        }
        assert_input_code(
            list_issue_comments(
                &client,
                FIXTURE_TOKEN,
                &repository(),
                comments_request(12, Some(cursor), Some(1)),
                &capabilities,
            )
            .await,
            "github_cursor_invalid",
        );
    }

    #[tokio::test]
    async fn comment_cursor_binds_repository_operation_and_issue_number() {
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, json!([comment(601, "Body")]).to_string()),
            RequestExpectations {
                bearer_token: Some(FIXTURE_TOKEN),
                ..RequestExpectations::default()
            },
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("client");
        let capabilities = CapabilityRegistry::new();
        let output = list_issue_comments(
            &client,
            FIXTURE_TOKEN,
            &repository(),
            comments_request(20, None, Some(1)),
            &capabilities,
        )
        .await
        .expect("comments");
        let cursor = output.continuation_cursor.expect("cursor");
        server.await.expect("server");

        assert_input_code(
            list_issue_comments(
                &client,
                FIXTURE_TOKEN,
                &repository(),
                comments_request(21, Some(cursor.clone()), Some(1)),
                &capabilities,
            )
            .await,
            "github_cursor_invalid",
        );
        assert_input_code(
            list_issue_comments(
                &client,
                FIXTURE_TOKEN,
                &other_repository(),
                comments_request(20, Some(cursor), Some(1)),
                &capabilities,
            )
            .await,
            "github_cursor_invalid",
        );
    }

    #[tokio::test]
    async fn issue_and_comment_bodies_are_redacted_and_individually_bounded() {
        let issue_secret = "api_key = ghp_abcdefghijklmnopqrstuvwxyz123456\n";
        let issue_body = format!("{issue_secret}{}", "é".repeat(40_000));
        let comment_secret = "password: super-secret-password\n";
        let comment_body = format!("{comment_secret}{}", "界".repeat(8_000));
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, issue(30, issue_body).to_string()),
                RequestExpectations {
                    bearer_token: Some(FIXTURE_TOKEN),
                    ..RequestExpectations::default()
                },
            ),
            (
                ResponseFixture::json(200, json!([comment(701, comment_body)]).to_string()),
                RequestExpectations {
                    bearer_token: Some(FIXTURE_TOKEN),
                    ..RequestExpectations::default()
                },
            ),
        ])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("client");
        let issue_output = get_issue(&client, FIXTURE_TOKEN, &repository(), 30)
            .await
            .expect("issue");
        let comment_output = list_issue_comments(
            &client,
            FIXTURE_TOKEN,
            &repository(),
            comments_request(30, None, None),
            &CapabilityRegistry::new(),
        )
        .await
        .expect("comments");
        server.await.expect("server");

        let issue_text = issue_output.data["body"].as_str().expect("issue body");
        let comment_text = comment_output.data["items"][0]["body"]
            .as_str()
            .expect("comment body");
        assert!(issue_text.len() <= 64 * 1024);
        assert!(comment_text.len() <= 16 * 1024);
        assert!(issue_output.data["bodyTruncated"]
            .as_bool()
            .expect("truncated"));
        assert!(comment_output.data["items"][0]["bodyTruncated"]
            .as_bool()
            .expect("truncated"));
        assert!(!issue_text.contains("ghp_"));
        assert!(!comment_text.contains("super-secret-password"));
        assert!(issue_text.contains("[REDACTED]"));
        assert!(comment_text.contains("[REDACTED]"));
        assert!(issue_output.redactions_applied);
        assert!(comment_output.redactions_applied);
        assert!(issue_output.truncated);
        assert!(comment_output.truncated);
    }

    #[tokio::test]
    async fn singleton_issue_data_respects_the_soft_budget_by_shortening_only_its_body() {
        let mut provider_issue = issue(35, "z".repeat(64 * 1024));
        provider_issue["labels"] = Value::Array(
            (0_u64..60)
                .map(|index| {
                    json!({
                        "id": 10_000 + index,
                        "name": format!("label-{index}"),
                        "color": "abcdef",
                        "description": "d".repeat(4 * 1024)
                    })
                })
                .collect(),
        );
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, provider_issue.to_string()),
            RequestExpectations {
                bearer_token: Some(FIXTURE_TOKEN),
                ..RequestExpectations::default()
            },
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("client");
        let output = get_issue(&client, FIXTURE_TOKEN, &repository(), 35)
            .await
            .expect("issue");
        server.await.expect("server");

        assert!(serde_json::to_vec(&output.data).expect("serialize").len() <= DATA_SOFT_BUDGET);
        assert!(output.data["bodyTruncated"].as_bool().expect("truncated"));
        assert!(output.truncated);
        assert!(output.continuation_cursor.is_none());
        assert_eq!(output.data["labels"].as_array().expect("labels").len(), 60);
    }

    #[tokio::test]
    async fn normalized_issue_data_discards_provider_links_and_raw_repositories() {
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, issue(40, "Ordinary body").to_string()),
            RequestExpectations {
                bearer_token: Some(FIXTURE_TOKEN),
                ..RequestExpectations::default()
            },
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("client");
        let output = get_issue(&client, FIXTURE_TOKEN, &repository(), 40)
            .await
            .expect("issue");
        server.await.expect("server");

        let issue_keys = output
            .data
            .as_object()
            .expect("issue object")
            .keys()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            issue_keys,
            std::collections::BTreeSet::from([
                "body",
                "bodyTruncated",
                "closedAt",
                "commentCount",
                "createdAt",
                "id",
                "labels",
                "locked",
                "milestone",
                "number",
                "state",
                "stateReason",
                "title",
                "updatedAt",
                "user",
            ])
        );
        assert_eq!(
            output.data["user"],
            json!({"id": 42, "login": "octocat", "type": "User"})
        );
        assert_eq!(
            output.data["labels"][0],
            json!({
                "id": 91,
                "name": "bug",
                "color": "d73a4a",
                "description": "Something is not working"
            })
        );
        assert_eq!(
            output.data["milestone"],
            json!({
                "id": 71,
                "number": 3,
                "title": "Next release",
                "state": "open",
                "openIssueCount": 4,
                "closedIssueCount": 5,
                "createdAt": "2026-07-01T00:00:00Z",
                "updatedAt": "2026-07-02T00:00:00Z",
                "dueAt": "2026-08-01T00:00:00Z",
                "closedAt": null
            })
        );
        let serialized = serde_json::to_string(&output.data).expect("serialize data");
        assert!(!serialized.contains("attacker.invalid"));
        assert!(!serialized.contains("author_association"));
        assert!(!serialized.contains("reactions"));
        assert!(!serialized.contains("attacker/escape"));

        assert_eq!(output.sources.len(), 1);
        assert_eq!(output.sources[0].repository_id, "123456");
        assert_eq!(
            output.sources[0].repository_full_name,
            "open-software-network/test-repo"
        );
        assert_eq!(
            output.sources[0].url,
            "https://github.com/open-software-network/test-repo/issues/40"
        );
        assert_eq!(output.sources[0].object_id, "1040");
    }

    #[tokio::test]
    async fn normalized_comments_keep_only_approved_identity_and_time_fields() {
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, json!([comment(801, "Safe body")]).to_string()),
            RequestExpectations {
                bearer_token: Some(FIXTURE_TOKEN),
                ..RequestExpectations::default()
            },
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("client");
        let output = list_issue_comments(
            &client,
            FIXTURE_TOKEN,
            &repository(),
            comments_request(50, None, None),
            &CapabilityRegistry::new(),
        )
        .await
        .expect("comments");
        server.await.expect("server");

        assert_eq!(
            output.data["items"][0],
            json!({
                "id": 801,
                "body": "Safe body",
                "bodyTruncated": false,
                "user": {"id": 43, "login": "reviewer", "type": "User"},
                "createdAt": "2026-07-12T00:00:00Z",
                "updatedAt": "2026-07-13T00:00:00Z"
            })
        );
        let serialized = serde_json::to_string(&output.data).expect("serialize");
        assert!(!serialized.contains("attacker.invalid"));
        assert!(!serialized.contains("author_association"));
        assert_eq!(
            output.sources[0].url,
            "https://github.com/open-software-network/test-repo/issues/50#issuecomment-801"
        );
        assert_eq!(output.sources[0].object_id, "801");
    }

    #[tokio::test]
    async fn issue_lists_apply_the_soft_data_budget_and_resume_without_page_draining() {
        let large_body = "x".repeat(64 * 1024);
        let page = json!([
            issue(61, &large_body),
            issue(62, &large_body),
            issue(63, &large_body),
            issue(64, &large_body),
            issue(65, &large_body)
        ]);
        let body = page.to_string();
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, body.clone()),
                RequestExpectations {
                    bearer_token: Some(FIXTURE_TOKEN),
                    ..RequestExpectations::default()
                },
            ),
            (
                ResponseFixture::json(200, body),
                RequestExpectations {
                    bearer_token: Some(FIXTURE_TOKEN),
                    ..RequestExpectations::default()
                },
            ),
        ])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("client");
        let capabilities = CapabilityRegistry::new();
        let first = list_issues(
            &client,
            FIXTURE_TOKEN,
            &repository(),
            issue_list(Some("open"), None, &[], None, Some(5)),
            &capabilities,
        )
        .await
        .expect("first page window");
        assert!(serde_json::to_vec(&first.data).expect("serialize").len() <= DATA_SOFT_BUDGET);
        assert!(first.truncated);
        let first_items = first.data["items"].as_array().expect("items");
        assert!(!first_items.is_empty());
        assert!(first_items.len() < 5);
        let first_last_number = first_items.last().expect("last")["number"]
            .as_u64()
            .expect("number");

        let second = list_issues(
            &client,
            FIXTURE_TOKEN,
            &repository(),
            issue_list(Some("open"), None, &[], first.continuation_cursor, Some(5)),
            &capabilities,
        )
        .await
        .expect("continued window");
        let second_first_number = second.data["items"][0]["number"].as_u64().expect("number");
        assert_eq!(second_first_number, first_last_number + 1);

        let captures = server.await.expect("server");
        assert_eq!(captures.len(), 2);
        assert_eq!(
            captures[0].path, captures[1].path,
            "continuation stays on the same provider page until its raw offset is consumed"
        );
    }

    #[test]
    fn reused_issue_cursor_never_repeats_when_the_next_issue_cannot_fit() {
        let provider_items = vec![
            serde_json::from_value::<ProviderIssue>(issue(66, "small body"))
                .expect("small provider issue"),
            serde_json::from_value::<ProviderIssue>(issue_with_oversized_labels(67))
                .expect("oversized provider issue"),
        ];
        let capabilities = CapabilityRegistry::new();
        let fingerprint = filter_fingerprint(&json!({
            "state": "open",
            "query": null,
            "labels": [],
            "limit": 2,
        }));

        let first = normalize_issue_page(
            provider_items,
            &repository(),
            &capabilities,
            fingerprint,
            1,
            0,
            2,
        )
        .expect("first item fits and advances to the oversized issue");
        assert_eq!(first.data["items"].as_array().expect("items").len(), 1);
        let cursor = first.continuation_cursor.expect("same-page cursor");
        let scope = capabilities
            .resolve_cursor(
                &cursor,
                LIST_ISSUES_OPERATION,
                Some(repository().repository_id.as_str()),
                &fingerprint,
            )
            .expect("resolve continuation");
        assert_eq!((scope.provider_page, scope.raw_offset), (1, 1));

        let replay_items = vec![
            serde_json::from_value::<ProviderIssue>(issue(66, "small body"))
                .expect("small provider issue"),
            serde_json::from_value::<ProviderIssue>(issue_with_oversized_labels(67))
                .expect("oversized provider issue"),
        ];
        assert_provider_error(
            normalize_issue_page(
                replay_items,
                &repository(),
                &capabilities,
                fingerprint,
                scope.provider_page,
                scope.raw_offset,
                2,
            ),
            GitHubApiError::ResponseTooLarge,
        );
    }

    #[tokio::test]
    async fn empty_issue_pages_have_no_unsupported_continuation() {
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, "[]"),
                RequestExpectations {
                    bearer_token: Some(FIXTURE_TOKEN),
                    ..RequestExpectations::default()
                },
            ),
            (
                ResponseFixture::json(200, "[]"),
                RequestExpectations {
                    bearer_token: Some(FIXTURE_TOKEN),
                    ..RequestExpectations::default()
                },
            ),
        ])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("client");
        let capabilities = CapabilityRegistry::new();
        let issues = list_issues(
            &client,
            FIXTURE_TOKEN,
            &repository(),
            issue_list(Some("closed"), None, &[], None, Some(50)),
            &capabilities,
        )
        .await
        .expect("issues");
        let comments = list_issue_comments(
            &client,
            FIXTURE_TOKEN,
            &repository(),
            comments_request(72, None, Some(50)),
            &capabilities,
        )
        .await
        .expect("comments");
        server.await.expect("server");
        assert!(issues.continuation_cursor.is_none());
        assert!(comments.continuation_cursor.is_none());
        assert!(!issues.truncated);
        assert!(!comments.truncated);
    }

    #[tokio::test]
    async fn provider_failures_remain_typed_and_sanitized_for_orchestration() {
        let oversized = "x".repeat(512 * 1024 + 1);
        let fixtures = vec![
            (
                ResponseFixture::json(401, "credential-body-secret"),
                RequestExpectations::default(),
            ),
            (
                ResponseFixture::json(403, "forbidden-body-secret"),
                RequestExpectations::default(),
            ),
            (
                ResponseFixture::json(404, "missing-body-secret"),
                RequestExpectations::default(),
            ),
            (
                ResponseFixture::json(429, "rate-limit-body-secret")
                    .with_header("Retry-After", "17"),
                RequestExpectations::default(),
            ),
            (
                ResponseFixture::json(200, oversized).chunked(),
                RequestExpectations::default(),
            ),
            (
                ResponseFixture::json(200, "not-json"),
                RequestExpectations::default(),
            ),
        ];
        let (base_url, server) = scripted_server(fixtures).await;
        let client = GitHubReadClient::for_test(&base_url).expect("client");
        let expected = [
            GitHubApiError::Unauthorized,
            GitHubApiError::Forbidden,
            GitHubApiError::NotFound,
            GitHubApiError::RateLimited {
                retry_after_seconds: Some(17),
            },
            GitHubApiError::ResponseTooLarge,
            GitHubApiError::Malformed,
        ];
        for expected_error in expected {
            assert_provider_error(
                get_issue(&client, FIXTURE_TOKEN, &repository(), 80).await,
                expected_error,
            );
        }
        let captures = server.await.expect("server");
        assert_eq!(captures.len(), 6);
    }
}
