use crate::{
    connectors::{
        github::{EligibleGitHubRepository, GitHubToolEligibility},
        github_api::{
            GitHubApiError, GitHubReadClient, FILE_RESPONSE_MAX_BYTES, LIST_RESPONSE_MAX_BYTES,
            SINGLETON_RESPONSE_MAX_BYTES,
        },
        github_capabilities::{filter_fingerprint, CapabilityRegistry, CursorScope},
        github_content_guard::{
            normalize_untrusted_text, sensitive_path_blocked, validate_git_ref,
            validate_repository_path, validate_search_literal,
        },
        github_read::{GitHubOperationOutput, GitHubReadFailure, GitHubSource},
    },
    domain::types::AppError,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Map, Value};

const DEFAULT_LIST_LIMIT: u16 = 30;
const MAX_LIST_LIMIT: u16 = 50;
const DEFAULT_LINE_COUNT: u16 = 200;
const MAX_LINE_COUNT: u16 = 1_000;
const SOFT_DATA_BUDGET: usize = 248 * 1024;
const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_SEARCH_FRAGMENT_BYTES: usize = 4 * 1024;
const MAX_SEARCH_FRAGMENTS_PER_ITEM: usize = 10;

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct DirectoryRead {
    pub(crate) path: String,
    pub(crate) git_ref: Option<String>,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<u16>,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct FileRead {
    pub(crate) path: String,
    pub(crate) git_ref: Option<String>,
    pub(crate) start_line: Option<u32>,
    pub(crate) line_count: Option<u16>,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct CodeSearch {
    pub(crate) query: String,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<u16>,
}

#[allow(dead_code)]
pub(crate) async fn list_repositories(
    eligibility: &GitHubToolEligibility,
    capabilities: &CapabilityRegistry,
    cursor: Option<&str>,
    limit: Option<u16>,
) -> Result<GitHubOperationOutput, AppError> {
    let limit = bounded_limit(limit)?;
    let filters = filter_fingerprint(&json!({"limit": limit}));
    let offset = if let Some(cursor) = cursor {
        let scope = capabilities.resolve_cursor(cursor, "list_repositories", None, &filters)?;
        if scope.provider_page != 1 || scope.phase.is_some() {
            return Err(cursor_invalid());
        }
        usize::from(scope.raw_offset)
    } else {
        0
    };
    if offset > eligibility.repositories.len() {
        return Err(cursor_invalid());
    }

    let mut items = Vec::new();
    let mut sources = Vec::new();
    let requested_end = offset
        .saturating_add(usize::from(limit))
        .min(eligibility.repositories.len());
    let mut next_offset = offset;
    for repository in &eligibility.repositories[offset..requested_end] {
        let item = json!({
            "repositoryId": repository.repository_id,
            "name": repository.name,
            "fullName": repository.full_name,
            "private": repository.private,
            "visibility": if repository.private { "private" } else { "public" },
        });
        items.push(item);
        let candidate = json!({"items": items});
        if !fits_soft_budget(&candidate) {
            items.pop();
            break;
        }
        sources.push(repository_source(repository).map_err(|_| read_unavailable())?);
        next_offset += 1;
    }
    if next_offset == offset && offset < eligibility.repositories.len() {
        return Err(response_too_large());
    }

    let continuation_cursor = if next_offset < eligibility.repositories.len() {
        Some(capabilities.issue_cursor(CursorScope {
            operation: "list_repositories",
            repository_id: None,
            filter_fingerprint: filters,
            provider_page: 1,
            raw_offset: u16::try_from(next_offset).map_err(|_| response_too_large())?,
            phase: None,
        })?)
    } else {
        None
    };
    Ok(GitHubOperationOutput {
        data: json!({"items": items}),
        truncated: continuation_cursor.is_some(),
        continuation_cursor,
        redactions_applied: false,
        sources,
    })
}

#[allow(dead_code)]
pub(crate) async fn get_repository(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
) -> Result<GitHubOperationOutput, GitHubApiError> {
    let response: Value = client
        .get_json(
            access_token,
            &["repos", &repository.owner_login, &repository.name],
            &[],
            SINGLETON_RESPONSE_MAX_BYTES,
        )
        .await?;
    let object = response.as_object().ok_or(GitHubApiError::Malformed)?;
    validate_provider_repository_id(object.get("id"), repository)?;

    let archived = required_bool(object, "archived")?;
    let default_branch = required_string(object, "default_branch", 255)?;
    let default_branch = validate_git_ref(Some(default_branch.as_str()))
        .map_err(|_| GitHubApiError::Malformed)?
        .ok_or(GitHubApiError::Malformed)?;
    let (description, description_truncated, description_redacted) =
        optional_bounded_text(object.get("description"), 32 * 1024, 1_000)?;
    let language = optional_short_string(object.get("language"), 100)?;
    let topics = normalized_topics(object.get("topics"))?;
    let license = normalized_license(object.get("license"))?;
    let data = json!({
        "repositoryId": repository.repository_id,
        "name": repository.name,
        "fullName": repository.full_name,
        "private": repository.private,
        "visibility": if repository.private { "private" } else { "public" },
        "archived": archived,
        "defaultBranch": default_branch,
        "description": description,
        "descriptionTruncated": description_truncated,
        "language": language,
        "topics": topics,
        "license": license,
        "counts": {
            "stars": optional_u64(object, "stargazers_count")?,
            "watchers": optional_u64(object, "watchers_count")?,
            "forks": optional_u64(object, "forks_count")?,
            "openIssues": optional_u64(object, "open_issues_count")?,
        },
    });
    if !fits_soft_budget(&data) {
        return Err(GitHubApiError::ResponseTooLarge);
    }
    Ok(GitHubOperationOutput {
        data,
        truncated: description_truncated,
        continuation_cursor: None,
        redactions_applied: description_redacted,
        sources: vec![repository_source(repository)?],
    })
}

#[allow(dead_code)]
pub(crate) async fn list_directory(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    request: DirectoryRead,
    capabilities: &CapabilityRegistry,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    let path = validate_repository_path(&request.path, true).map_err(GitHubReadFailure::Input)?;
    let limit = bounded_limit(request.limit).map_err(GitHubReadFailure::Input)?;
    let git_ref = resolve_ref(client, access_token, repository, request.git_ref.as_deref()).await?;
    let filters = filter_fingerprint(&json!({
        "path": path,
        "ref": git_ref,
        "limit": limit,
    }));
    let offset = if let Some(cursor) = request.cursor.as_deref() {
        let scope = capabilities
            .resolve_cursor(
                cursor,
                "list_directory",
                Some(&repository.repository_id),
                &filters,
            )
            .map_err(GitHubReadFailure::Input)?;
        if scope.provider_page != 1 || scope.phase.is_some() {
            return Err(GitHubReadFailure::Input(cursor_invalid()));
        }
        usize::from(scope.raw_offset)
    } else {
        0
    };

    let mut segments = vec![
        "repos",
        repository.owner_login.as_str(),
        repository.name.as_str(),
        "contents",
    ];
    segments.extend(path.split('/').filter(|segment| !segment.is_empty()));
    let response: Value = client
        .get_json(
            access_token,
            &segments,
            &[("ref", git_ref.as_str())],
            LIST_RESPONSE_MAX_BYTES,
        )
        .await
        .map_err(GitHubReadFailure::Provider)?;
    let provider_entries = response
        .as_array()
        .ok_or(GitHubReadFailure::Provider(GitHubApiError::Malformed))?;
    if offset > provider_entries.len() {
        return Err(GitHubReadFailure::Input(cursor_invalid()));
    }

    let requested_end = offset
        .saturating_add(usize::from(limit))
        .min(provider_entries.len());
    let mut entries = Vec::new();
    let mut next_offset = offset;
    for provider_entry in &provider_entries[offset..requested_end] {
        let entry = normalize_directory_entry(provider_entry, &path)
            .map_err(GitHubReadFailure::Provider)?;
        entries.push(entry);
        let candidate = json!({
            "repositoryId": repository.repository_id,
            "path": path,
            "ref": git_ref,
            "entries": entries,
        });
        if !fits_soft_budget(&candidate) {
            entries.pop();
            break;
        }
        next_offset += 1;
    }
    if next_offset == offset && offset < provider_entries.len() {
        return Err(GitHubReadFailure::Input(response_too_large()));
    }
    let continuation_cursor = if next_offset < provider_entries.len() {
        Some(
            capabilities
                .issue_cursor(CursorScope {
                    operation: "list_directory",
                    repository_id: Some(repository.repository_id.clone()),
                    filter_fingerprint: filters,
                    provider_page: 1,
                    raw_offset: u16::try_from(next_offset)
                        .map_err(|_| GitHubReadFailure::Input(response_too_large()))?,
                    phase: None,
                })
                .map_err(GitHubReadFailure::Input)?,
        )
    } else {
        None
    };
    let data = json!({
        "repositoryId": repository.repository_id,
        "path": path,
        "ref": git_ref,
        "entries": entries,
    });
    Ok(GitHubOperationOutput {
        data,
        truncated: continuation_cursor.is_some(),
        continuation_cursor,
        redactions_applied: false,
        sources: vec![
            directory_source(repository, &path, &git_ref).map_err(GitHubReadFailure::Provider)?
        ],
    })
}

#[allow(dead_code)]
pub(crate) async fn read_file(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    request: FileRead,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    let path = validate_repository_path(&request.path, false).map_err(GitHubReadFailure::Input)?;
    if sensitive_path_blocked(&path) {
        return Err(GitHubReadFailure::Input(sensitive_path_error()));
    }
    let start_line = request.start_line.unwrap_or(1);
    if start_line == 0 {
        return Err(GitHubReadFailure::Input(input_invalid()));
    }
    let line_count = bounded_line_count(request.line_count).map_err(GitHubReadFailure::Input)?;
    let git_ref = resolve_ref(client, access_token, repository, request.git_ref.as_deref()).await?;

    let mut segments = vec![
        "repos",
        repository.owner_login.as_str(),
        repository.name.as_str(),
        "contents",
    ];
    segments.extend(path.split('/'));
    let response: Value = client
        .get_json(
            access_token,
            &segments,
            &[("ref", git_ref.as_str())],
            FILE_RESPONSE_MAX_BYTES,
        )
        .await
        .map_err(GitHubReadFailure::Provider)?;
    let object = response
        .as_object()
        .ok_or(GitHubReadFailure::Provider(GitHubApiError::Malformed))?;
    let content_type = required_string(object, "type", 32).map_err(GitHubReadFailure::Provider)?;
    if content_type == "submodule"
        || object
            .get("submodule_git_url")
            .is_some_and(Value::is_string)
    {
        return Err(GitHubReadFailure::Input(binary_content()));
    }
    if content_type != "file" {
        return Err(GitHubReadFailure::Input(binary_content()));
    }
    if object
        .get("size")
        .and_then(Value::as_u64)
        .is_some_and(|size| size > MAX_FILE_BYTES as u64)
    {
        return Err(GitHubReadFailure::Input(response_too_large()));
    }
    if required_string(object, "encoding", 32).map_err(GitHubReadFailure::Provider)? != "base64" {
        return Err(GitHubReadFailure::Provider(GitHubApiError::Malformed));
    }
    let encoded = object
        .get("content")
        .and_then(Value::as_str)
        .filter(|value| value.len() <= FILE_RESPONSE_MAX_BYTES)
        .ok_or(GitHubReadFailure::Provider(GitHubApiError::Malformed))?;
    let compact = encoded
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    let decoded = STANDARD
        .decode(compact)
        .map_err(|_| GitHubReadFailure::Provider(GitHubApiError::Malformed))?;
    if decoded.len() > MAX_FILE_BYTES {
        return Err(GitHubReadFailure::Input(response_too_large()));
    }
    let sha = normalized_sha(object.get("sha")).map_err(GitHubReadFailure::Provider)?;
    let guarded = normalize_untrusted_text(&decoded, MAX_FILE_BYTES, usize::MAX)
        .map_err(GitHubReadFailure::Input)?;
    let lines = guarded.text.lines().collect::<Vec<_>>();
    let total_lines = lines.len();
    let start_index = usize::try_from(start_line - 1).unwrap_or(usize::MAX);
    let requested_end = start_index
        .saturating_add(usize::from(line_count))
        .min(total_lines);
    let selected = if start_index < total_lines {
        lines[start_index..requested_end].join("\n")
    } else {
        String::new()
    };
    let (data, soft_truncated) = fit_file_data(
        repository,
        &path,
        &git_ref,
        &sha,
        selected,
        start_line,
        total_lines,
    )?;
    let truncated =
        guarded.truncated || soft_truncated || start_index > 0 || requested_end < total_lines;
    Ok(GitHubOperationOutput {
        data,
        truncated,
        continuation_cursor: None,
        redactions_applied: guarded.redactions_applied,
        sources: vec![
            file_source(repository, &path, &git_ref, &sha).map_err(GitHubReadFailure::Provider)?
        ],
    })
}

#[allow(dead_code)]
pub(crate) async fn search_code(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    request: CodeSearch,
    capabilities: &CapabilityRegistry,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    let query = validate_search_literal(&request.query).map_err(GitHubReadFailure::Input)?;
    let limit = bounded_limit(request.limit).map_err(GitHubReadFailure::Input)?;
    let filters = filter_fingerprint(&json!({"query": query, "limit": limit}));
    let (page, offset) = if let Some(cursor) = request.cursor.as_deref() {
        let scope = capabilities
            .resolve_cursor(
                cursor,
                "search_code",
                Some(&repository.repository_id),
                &filters,
            )
            .map_err(GitHubReadFailure::Input)?;
        if scope.provider_page == 0 || scope.phase.is_some() {
            return Err(GitHubReadFailure::Input(cursor_invalid()));
        }
        (scope.provider_page, usize::from(scope.raw_offset))
    } else {
        (1, 0)
    };
    let scoped_query = format!("{query} repo:{}", repository.full_name);
    let per_page = limit.to_string();
    let page_string = page.to_string();
    let response: Value = client
        .get_json_with_text_matches(
            access_token,
            &["search", "code"],
            &[
                ("q", scoped_query.as_str()),
                ("per_page", per_page.as_str()),
                ("page", page_string.as_str()),
            ],
            LIST_RESPONSE_MAX_BYTES,
        )
        .await
        .map_err(GitHubReadFailure::Provider)?;
    let object = response
        .as_object()
        .ok_or(GitHubReadFailure::Provider(GitHubApiError::Malformed))?;
    let total_count = required_u64(object, "total_count").map_err(GitHubReadFailure::Provider)?;
    let incomplete_results =
        required_bool(object, "incomplete_results").map_err(GitHubReadFailure::Provider)?;
    let provider_items = object
        .get("items")
        .and_then(Value::as_array)
        .ok_or(GitHubReadFailure::Provider(GitHubApiError::Malformed))?;
    if offset > provider_items.len() {
        return Err(GitHubReadFailure::Input(cursor_invalid()));
    }

    let requested_end = offset
        .saturating_add(usize::from(limit))
        .min(provider_items.len());
    let mut items = Vec::new();
    let mut sources = Vec::new();
    let mut redactions_applied = false;
    let mut next_offset = offset;
    for provider_item in &provider_items[offset..requested_end] {
        let (item, item_redacted) = normalize_search_item(provider_item, repository)
            .map_err(GitHubReadFailure::Provider)?;
        items.push(item);
        let candidate = json!({
            "repositoryId": repository.repository_id,
            "query": query,
            "totalCount": total_count,
            "incompleteResults": incomplete_results,
            "items": items,
        });
        if !fits_soft_budget(&candidate) {
            items.pop();
            break;
        }
        let path = items
            .last()
            .and_then(|item| item.get("path"))
            .and_then(Value::as_str)
            .ok_or(GitHubReadFailure::Provider(GitHubApiError::Malformed))?;
        let sha = items
            .last()
            .and_then(|item| item.get("sha"))
            .and_then(Value::as_str)
            .ok_or(GitHubReadFailure::Provider(GitHubApiError::Malformed))?;
        sources.push(file_source(repository, path, sha, sha).map_err(GitHubReadFailure::Provider)?);
        redactions_applied |= item_redacted;
        next_offset += 1;
    }
    if next_offset == offset && offset < provider_items.len() {
        return Err(GitHubReadFailure::Input(response_too_large()));
    }

    let (next_page, next_raw_offset) = if next_offset < provider_items.len() {
        (page, next_offset)
    } else if u64::from(page).saturating_mul(u64::from(limit)) < total_count {
        (
            page.checked_add(1)
                .ok_or(GitHubReadFailure::Input(response_too_large()))?,
            0,
        )
    } else {
        (0, 0)
    };
    let continuation_cursor = if next_page > 0 {
        Some(
            capabilities
                .issue_cursor(CursorScope {
                    operation: "search_code",
                    repository_id: Some(repository.repository_id.clone()),
                    filter_fingerprint: filters,
                    provider_page: next_page,
                    raw_offset: u16::try_from(next_raw_offset)
                        .map_err(|_| GitHubReadFailure::Input(response_too_large()))?,
                    phase: None,
                })
                .map_err(GitHubReadFailure::Input)?,
        )
    } else {
        None
    };
    let data = json!({
        "repositoryId": repository.repository_id,
        "query": query,
        "totalCount": total_count,
        "incompleteResults": incomplete_results,
        "items": items,
    });
    Ok(GitHubOperationOutput {
        data,
        truncated: incomplete_results || continuation_cursor.is_some(),
        continuation_cursor,
        redactions_applied,
        sources,
    })
}

async fn resolve_ref(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    git_ref: Option<&str>,
) -> Result<String, GitHubReadFailure> {
    if let Some(git_ref) = validate_git_ref(git_ref).map_err(GitHubReadFailure::Input)? {
        return Ok(git_ref);
    }
    let response: Value = client
        .get_json(
            access_token,
            &["repos", &repository.owner_login, &repository.name],
            &[],
            SINGLETON_RESPONSE_MAX_BYTES,
        )
        .await
        .map_err(GitHubReadFailure::Provider)?;
    let object = response
        .as_object()
        .ok_or(GitHubReadFailure::Provider(GitHubApiError::Malformed))?;
    let branch =
        required_string(object, "default_branch", 255).map_err(GitHubReadFailure::Provider)?;
    validate_git_ref(Some(&branch))
        .map_err(|_| GitHubReadFailure::Provider(GitHubApiError::Malformed))?
        .ok_or(GitHubReadFailure::Provider(GitHubApiError::Malformed))
}

fn normalize_directory_entry(value: &Value, requested_path: &str) -> Result<Value, GitHubApiError> {
    let object = value.as_object().ok_or(GitHubApiError::Malformed)?;
    let name = required_string(object, "name", 255)?;
    if name.contains('/') || validate_repository_path(&name, false).is_err() {
        return Err(GitHubApiError::Malformed);
    }
    let path = required_string(object, "path", 1_024)?;
    let path = validate_repository_path(&path, false).map_err(|_| GitHubApiError::Malformed)?;
    let expected_path = if requested_path.is_empty() {
        name.clone()
    } else {
        format!("{requested_path}/{name}")
    };
    if path != expected_path {
        return Err(GitHubApiError::Malformed);
    }
    let sha = normalized_sha(object.get("sha"))?;
    let provider_kind = required_string(object, "type", 32)?;
    let kind = if object
        .get("submodule_git_url")
        .is_some_and(Value::is_string)
    {
        "submodule"
    } else {
        match provider_kind.as_str() {
            "file" | "dir" | "symlink" | "submodule" => provider_kind.as_str(),
            _ => return Err(GitHubApiError::Malformed),
        }
    };
    Ok(json!({
        "name": name,
        "path": path,
        "sha": sha,
        "size": optional_u64(object, "size")?,
        "kind": kind,
    }))
}

fn normalize_search_item(
    value: &Value,
    repository: &EligibleGitHubRepository,
) -> Result<(Value, bool), GitHubApiError> {
    let object = value.as_object().ok_or(GitHubApiError::Malformed)?;
    let provider_repository = object
        .get("repository")
        .and_then(Value::as_object)
        .ok_or(GitHubApiError::Malformed)?;
    validate_provider_repository_id(provider_repository.get("id"), repository)?;
    if required_string(provider_repository, "name", 255)? != repository.name
        || required_string(provider_repository, "full_name", 1_024)? != repository.full_name
        || provider_repository
            .get("owner")
            .and_then(Value::as_object)
            .and_then(|owner| owner.get("login"))
            .and_then(Value::as_str)
            != Some(repository.owner_login.as_str())
    {
        return Err(GitHubApiError::Malformed);
    }
    let path = required_string(object, "path", 1_024)?;
    let path = validate_repository_path(&path, false).map_err(|_| GitHubApiError::Malformed)?;
    let sha = normalized_sha(object.get("sha"))?;
    let mut fragments = Vec::new();
    let mut fragments_truncated = false;
    let mut redactions_applied = false;
    if let Some(matches) = object.get("text_matches") {
        let matches = matches.as_array().ok_or(GitHubApiError::Malformed)?;
        fragments_truncated = matches.len() > MAX_SEARCH_FRAGMENTS_PER_ITEM;
        for text_match in matches.iter().take(MAX_SEARCH_FRAGMENTS_PER_ITEM) {
            let fragment = text_match
                .as_object()
                .and_then(|item| item.get("fragment"))
                .and_then(Value::as_str)
                .ok_or(GitHubApiError::Malformed)?;
            let guarded = normalize_untrusted_text(
                fragment.as_bytes(),
                MAX_SEARCH_FRAGMENT_BYTES,
                usize::MAX,
            )
            .map_err(|_| GitHubApiError::Malformed)?;
            fragments_truncated |= guarded.truncated;
            redactions_applied |= guarded.redactions_applied;
            fragments.push(guarded.text);
        }
    }
    Ok((
        json!({
            "name": path.rsplit('/').next().unwrap_or(path.as_str()),
            "path": path,
            "sha": sha,
            "fragments": fragments,
            "fragmentsTruncated": fragments_truncated,
        }),
        redactions_applied,
    ))
}

fn fit_file_data(
    repository: &EligibleGitHubRepository,
    path: &str,
    git_ref: &str,
    sha: &str,
    mut text: String,
    start_line: u32,
    total_lines: usize,
) -> Result<(Value, bool), GitHubReadFailure> {
    let original_len = text.len();
    loop {
        let returned_lines = if text.is_empty() {
            0
        } else {
            text.lines().count()
        };
        let end_line = if returned_lines == 0 {
            Value::Null
        } else {
            json!(u64::from(start_line) + returned_lines as u64 - 1)
        };
        let data = json!({
            "repositoryId": repository.repository_id,
            "path": path,
            "ref": git_ref,
            "sha": sha,
            "text": text,
            "startLine": start_line,
            "endLine": end_line,
            "totalLines": total_lines,
        });
        if fits_soft_budget(&data) {
            return Ok((data, text.len() < original_len));
        }
        if text.is_empty() {
            return Err(GitHubReadFailure::Input(response_too_large()));
        }
        let target = text.len().saturating_mul(3) / 4;
        let end = utf8_floor(&text, target);
        text.truncate(end);
    }
}

fn normalized_topics(value: Option<&Value>) -> Result<Vec<String>, GitHubApiError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value.as_array().ok_or(GitHubApiError::Malformed)?;
    if values.len() > 100 {
        return Err(GitHubApiError::ResponseTooLarge);
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| value.len() <= 100 && !value.chars().any(char::is_control))
                .map(str::to_owned)
                .ok_or(GitHubApiError::Malformed)
        })
        .collect()
}

fn normalized_license(value: Option<&Value>) -> Result<Value, GitHubApiError> {
    let Some(value) = value else {
        return Ok(Value::Null);
    };
    if value.is_null() {
        return Ok(Value::Null);
    }
    let object = value.as_object().ok_or(GitHubApiError::Malformed)?;
    Ok(json!({
        "key": optional_short_string(object.get("key"), 100)?,
        "name": optional_short_string(object.get("name"), 255)?,
        "spdxId": optional_short_string(object.get("spdx_id"), 100)?,
    }))
}

fn optional_bounded_text(
    value: Option<&Value>,
    max_bytes: usize,
    max_lines: usize,
) -> Result<(Option<String>, bool, bool), GitHubApiError> {
    let Some(value) = value else {
        return Ok((None, false, false));
    };
    if value.is_null() {
        return Ok((None, false, false));
    }
    let text = value.as_str().ok_or(GitHubApiError::Malformed)?;
    let guarded = normalize_untrusted_text(text.as_bytes(), max_bytes, max_lines)
        .map_err(|_| GitHubApiError::Malformed)?;
    Ok((
        Some(guarded.text),
        guarded.truncated,
        guarded.redactions_applied,
    ))
}

fn optional_short_string(
    value: Option<&Value>,
    max_bytes: usize,
) -> Result<Option<String>, GitHubApiError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let value = value.as_str().ok_or(GitHubApiError::Malformed)?;
    if value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err(GitHubApiError::Malformed);
    }
    Ok(Some(value.to_owned()))
}

fn required_string(
    object: &Map<String, Value>,
    key: &str,
    max_bytes: usize,
) -> Result<String, GitHubApiError> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .ok_or(GitHubApiError::Malformed)?;
    if value.is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err(GitHubApiError::Malformed);
    }
    Ok(value.to_owned())
}

fn required_bool(object: &Map<String, Value>, key: &str) -> Result<bool, GitHubApiError> {
    object
        .get(key)
        .and_then(Value::as_bool)
        .ok_or(GitHubApiError::Malformed)
}

fn required_u64(object: &Map<String, Value>, key: &str) -> Result<u64, GitHubApiError> {
    object
        .get(key)
        .and_then(Value::as_u64)
        .ok_or(GitHubApiError::Malformed)
}

fn optional_u64(object: &Map<String, Value>, key: &str) -> Result<Option<u64>, GitHubApiError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or(GitHubApiError::Malformed),
    }
}

fn validate_provider_repository_id(
    value: Option<&Value>,
    repository: &EligibleGitHubRepository,
) -> Result<(), GitHubApiError> {
    let observed = value
        .and_then(|value| {
            value
                .as_u64()
                .map(|number| number.to_string())
                .or_else(|| value.as_str().map(str::to_owned))
        })
        .ok_or(GitHubApiError::Malformed)?;
    if observed == repository.repository_id {
        Ok(())
    } else {
        Err(GitHubApiError::Malformed)
    }
}

fn normalized_sha(value: Option<&Value>) -> Result<String, GitHubApiError> {
    let sha = value
        .and_then(Value::as_str)
        .ok_or(GitHubApiError::Malformed)?;
    if matches!(sha.len(), 40 | 64) && sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(sha.to_ascii_lowercase())
    } else {
        Err(GitHubApiError::Malformed)
    }
}

fn repository_source(
    repository: &EligibleGitHubRepository,
) -> Result<GitHubSource, GitHubApiError> {
    Ok(GitHubSource {
        repository_id: repository.repository_id.clone(),
        repository_full_name: repository.full_name.clone(),
        url: github_url(repository, &[])?,
        object_id: repository.repository_id.clone(),
        path: None,
        git_ref: None,
    })
}

fn directory_source(
    repository: &EligibleGitHubRepository,
    path: &str,
    git_ref: &str,
) -> Result<GitHubSource, GitHubApiError> {
    let mut suffix = vec!["tree", git_ref];
    suffix.extend(path.split('/').filter(|segment| !segment.is_empty()));
    Ok(GitHubSource {
        repository_id: repository.repository_id.clone(),
        repository_full_name: repository.full_name.clone(),
        url: github_url(repository, &suffix)?,
        object_id: repository.repository_id.clone(),
        path: Some(path.to_owned()),
        git_ref: Some(git_ref.to_owned()),
    })
}

fn file_source(
    repository: &EligibleGitHubRepository,
    path: &str,
    git_ref: &str,
    object_id: &str,
) -> Result<GitHubSource, GitHubApiError> {
    let mut suffix = vec!["blob", git_ref];
    suffix.extend(path.split('/'));
    Ok(GitHubSource {
        repository_id: repository.repository_id.clone(),
        repository_full_name: repository.full_name.clone(),
        url: github_url(repository, &suffix)?,
        object_id: object_id.to_owned(),
        path: Some(path.to_owned()),
        git_ref: Some(git_ref.to_owned()),
    })
}

fn github_url(
    repository: &EligibleGitHubRepository,
    suffix: &[&str],
) -> Result<String, GitHubApiError> {
    let mut url =
        reqwest::Url::parse("https://github.com/").map_err(|_| GitHubApiError::Malformed)?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| GitHubApiError::Malformed)?;
        segments.pop_if_empty();
        segments.push(&repository.owner_login);
        segments.push(&repository.name);
        segments.extend(suffix.iter().copied());
    }
    Ok(url.to_string())
}

fn bounded_limit(limit: Option<u16>) -> Result<u16, AppError> {
    let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT);
    if limit == 0 {
        return Err(input_invalid());
    }
    Ok(limit.min(MAX_LIST_LIMIT))
}

fn bounded_line_count(line_count: Option<u16>) -> Result<u16, AppError> {
    let line_count = line_count.unwrap_or(DEFAULT_LINE_COUNT);
    if line_count == 0 {
        return Err(input_invalid());
    }
    Ok(line_count.min(MAX_LINE_COUNT))
}

fn fits_soft_budget(value: &Value) -> bool {
    serde_json::to_vec(value)
        .map(|serialized| serialized.len() <= SOFT_DATA_BUDGET)
        .unwrap_or(false)
}

fn utf8_floor(value: &str, mut end: usize) -> usize {
    end = end.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    end
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

fn sensitive_path_error() -> AppError {
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

fn read_unavailable() -> AppError {
    AppError::new(
        "github_read_unavailable",
        "GitHub could not be read right now.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::{
        github::{EligibleGitHubRepository, GitHubToolEligibility},
        github_api::{GitHubApiError, GitHubReadClient},
        github_auth::tests::{scripted_server, RequestExpectations, ResponseFixture},
        github_capabilities::CapabilityRegistry,
        github_read::GitHubReadFailure,
    };
    use base64::engine::general_purpose::STANDARD;
    use serde_json::{json, Value};

    const TOKEN: &str = "fixture-repository-read-token";
    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    fn repository() -> EligibleGitHubRepository {
        EligibleGitHubRepository {
            repository_id: "123456".to_owned(),
            installation_id: "654321".to_owned(),
            owner_login: "open-software-network".to_owned(),
            name: "test-repo".to_owned(),
            full_name: "open-software-network/test-repo".to_owned(),
            private: true,
        }
    }

    fn eligibility(count: usize) -> GitHubToolEligibility {
        GitHubToolEligibility {
            github_user_id: "42".to_owned(),
            repositories: (0..count)
                .map(|index| EligibleGitHubRepository {
                    repository_id: (1000 + index).to_string(),
                    installation_id: "654321".to_owned(),
                    owner_login: "open-software-network".to_owned(),
                    name: format!("repo-{index:03}"),
                    full_name: format!("open-software-network/repo-{index:03}"),
                    private: index % 2 == 0,
                })
                .collect(),
        }
    }

    fn fixture_client(base_url: &str) -> GitHubReadClient {
        GitHubReadClient::for_test(base_url).expect("fixture client")
    }

    fn fixture_expectations() -> RequestExpectations {
        RequestExpectations {
            bearer_token: Some(TOKEN),
            ..RequestExpectations::default()
        }
    }

    fn failure_code(error: GitHubReadFailure) -> String {
        match error {
            GitHubReadFailure::Input(error) => error.code,
            GitHubReadFailure::Provider(error) => format!("provider:{error:?}"),
        }
    }

    fn directory_entry(index: usize) -> Value {
        json!({
            "name": format!("file-{index:03}.rs"),
            "path": format!("src/file-{index:03}.rs"),
            "sha": SHA,
            "size": 12,
            "type": "file",
            "url": "https://attacker.invalid/provider-url",
            "download_url": "https://attacker.invalid/download",
            "_links": {"html": "https://attacker.invalid/link"},
            "content": "must-not-be-returned"
        })
    }

    fn search_item(path: &str) -> Value {
        json!({
            "name": path.rsplit('/').next().unwrap_or(path),
            "path": path,
            "sha": SHA,
            "url": "https://attacker.invalid/api",
            "html_url": "https://attacker.invalid/html",
            "repository": {
                "id": 123456,
                "name": "test-repo",
                "full_name": "open-software-network/test-repo",
                "owner": {"login": "open-software-network"},
                "html_url": "https://attacker.invalid/repository"
            },
            "text_matches": [{"fragment": "ordinary search fragment"}]
        })
    }

    #[tokio::test]
    async fn list_repositories_is_local_bounded_and_cursor_scope_bound() {
        let capabilities = CapabilityRegistry::new();
        let eligibility = eligibility(55);

        let first = list_repositories(&eligibility, &capabilities, None, None)
            .await
            .expect("first local page");
        assert_eq!(first.data["items"].as_array().unwrap().len(), 30);
        assert_eq!(first.data["items"][0]["repositoryId"], "1000");
        assert_eq!(
            first.data["items"][0]["fullName"],
            "open-software-network/repo-000"
        );
        assert_eq!(first.data["items"][0]["private"], true);
        assert!(first.truncated);
        let cursor = first.continuation_cursor.expect("local continuation");

        let second = list_repositories(&eligibility, &capabilities, Some(&cursor), None)
            .await
            .expect("second local page");
        assert_eq!(second.data["items"].as_array().unwrap().len(), 25);
        assert_eq!(second.data["items"][0]["repositoryId"], "1030");
        assert!(!second.truncated);
        assert!(second.continuation_cursor.is_none());

        let error = list_repositories(&eligibility, &capabilities, Some(&cursor), Some(10))
            .await
            .expect_err("cursor cannot change its limit");
        assert_eq!(error.code, "github_cursor_invalid");

        let capped = list_repositories(&eligibility, &capabilities, None, Some(u16::MAX))
            .await
            .expect("limit is capped");
        assert_eq!(capped.data["items"].as_array().unwrap().len(), 50);
        assert!(capped.truncated);
    }

    #[tokio::test]
    async fn list_repositories_empty_snapshot_has_no_cursor_or_network_dependency() {
        let output = list_repositories(&eligibility(0), &CapabilityRegistry::new(), None, None)
            .await
            .expect("empty local snapshot");
        assert_eq!(output.data["items"], json!([]));
        assert!(!output.truncated);
        assert!(output.continuation_cursor.is_none());
        assert!(output.sources.is_empty());
    }

    #[tokio::test]
    async fn get_repository_uses_exact_endpoint_and_discards_provider_links() {
        let body = json!({
            "id": 123456,
            "name": "provider-controlled-name",
            "full_name": "provider/controlled",
            "private": false,
            "visibility": "private",
            "archived": true,
            "default_branch": "main",
            "description": "A selected repository",
            "language": "Rust",
            "topics": ["tauri", "agent"],
            "license": {"key": "mit", "name": "MIT License", "spdx_id": "MIT", "url": "https://attacker.invalid/license"},
            "stargazers_count": 5,
            "watchers_count": 6,
            "forks_count": 7,
            "open_issues_count": 8,
            "url": "https://attacker.invalid/api",
            "html_url": "https://attacker.invalid/html",
            "clone_url": "https://attacker.invalid/clone",
            "_links": {"html": "https://attacker.invalid/link"}
        });
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, body.to_string()),
            fixture_expectations(),
        )])
        .await;

        let output = get_repository(&fixture_client(&base_url), TOKEN, &repository())
            .await
            .expect("repository metadata");
        let captures = server.await.expect("server task");
        assert_eq!(captures.len(), 1);
        assert_eq!(captures[0].method, "GET");
        assert_eq!(captures[0].path, "/repos/open-software-network/test-repo");
        assert_eq!(output.data["repositoryId"], "123456");
        assert_eq!(output.data["name"], "test-repo");
        assert_eq!(output.data["fullName"], "open-software-network/test-repo");
        assert_eq!(output.data["visibility"], "private");
        assert_eq!(output.data["archived"], true);
        assert_eq!(output.data["defaultBranch"], "main");
        assert_eq!(
            output.data["counts"],
            json!({"stars": 5, "watchers": 6, "forks": 7, "openIssues": 8})
        );
        assert_eq!(output.data["license"]["spdxId"], "MIT");
        let serialized = serde_json::to_string(&output.data).unwrap();
        assert!(!serialized.contains("attacker.invalid"));
        assert!(!serialized.contains("clone_url"));
        assert_eq!(
            output.sources[0].url,
            "https://github.com/open-software-network/test-repo"
        );
    }

    #[tokio::test]
    async fn omitted_directory_ref_resolves_default_branch_and_preserves_provider_order() {
        let directory = json!([
            directory_entry(2),
            {
                "name": "vendor-module",
                "path": "src/vendor-module",
                "sha": SHA,
                "size": 0,
                "type": "submodule",
                "submodule_git_url": "https://attacker.invalid/module",
                "content": "submodule body must not escape"
            },
            directory_entry(1)
        ]);
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, json!({"default_branch": "main"}).to_string()),
                fixture_expectations(),
            ),
            (
                ResponseFixture::json(200, directory.to_string()),
                fixture_expectations(),
            ),
        ])
        .await;
        let output = list_directory(
            &fixture_client(&base_url),
            TOKEN,
            &repository(),
            DirectoryRead {
                path: "src".to_owned(),
                git_ref: None,
                cursor: None,
                limit: Some(30),
            },
            &CapabilityRegistry::new(),
        )
        .await
        .expect("directory page");

        let captures = server.await.expect("server task");
        assert_eq!(captures[0].path, "/repos/open-software-network/test-repo");
        assert_eq!(
            captures[1].path,
            "/repos/open-software-network/test-repo/contents/src?ref=main"
        );
        assert_eq!(output.data["ref"], "main");
        assert_eq!(output.data["entries"][0]["name"], "file-002.rs");
        assert_eq!(output.data["entries"][1]["kind"], "submodule");
        assert_eq!(output.data["entries"][2]["name"], "file-001.rs");
        let serialized = serde_json::to_string(&output.data).unwrap();
        assert!(!serialized.contains("submodule body"));
        assert!(!serialized.contains("attacker.invalid"));
        assert_eq!(output.sources[0].git_ref.as_deref(), Some("main"));
        assert_eq!(output.sources[0].path.as_deref(), Some("src"));
    }

    #[tokio::test]
    async fn directory_path_ref_owner_and_name_are_encoded_as_components() {
        let repository = EligibleGitHubRepository {
            repository_id: "123456".to_owned(),
            installation_id: "654321".to_owned(),
            owner_login: "owner space".to_owned(),
            name: "repo/name".to_owned(),
            full_name: "owner space/repo/name".to_owned(),
            private: false,
        };
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, "[]"),
            fixture_expectations(),
        )])
        .await;
        let output = list_directory(
            &fixture_client(&base_url),
            TOKEN,
            &repository,
            DirectoryRead {
                path: "src/space file.rs".to_owned(),
                git_ref: Some("feature/path".to_owned()),
                cursor: None,
                limit: None,
            },
            &CapabilityRegistry::new(),
        )
        .await
        .expect("encoded directory request");
        let captures = server.await.expect("server task");
        assert_eq!(captures.len(), 1);
        assert_eq!(
            captures[0].path,
            "/repos/owner%20space/repo%2Fname/contents/src/space%20file.rs?ref=feature%2Fpath"
        );
        assert!(output.data["entries"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn directory_empty_exact_fifty_and_oversize_fifty_first_are_bounded() {
        let exact = (0..50).map(directory_entry).collect::<Vec<_>>();
        let mut over = exact.clone();
        over.push(json!({
            "name": "x".repeat(300_000),
            "path": "../must-not-be-normalized",
            "sha": "not-a-sha",
            "size": 1,
            "type": "file"
        }));
        let (base_url, server) = scripted_server(vec![
            (ResponseFixture::json(200, "[]"), fixture_expectations()),
            (
                ResponseFixture::json(200, Value::Array(exact).to_string()),
                fixture_expectations(),
            ),
            (
                ResponseFixture::json(200, Value::Array(over).to_string()),
                fixture_expectations(),
            ),
        ])
        .await;
        let client = fixture_client(&base_url);
        let registry = CapabilityRegistry::new();
        for (expected, truncated) in [(0, false), (50, false), (50, true)] {
            let output = list_directory(
                &client,
                TOKEN,
                &repository(),
                DirectoryRead {
                    path: "src".to_owned(),
                    git_ref: Some("main".to_owned()),
                    cursor: None,
                    limit: Some(50),
                },
                &registry,
            )
            .await
            .expect("bounded directory page");
            assert_eq!(output.data["entries"].as_array().unwrap().len(), expected);
            assert_eq!(output.truncated, truncated);
            assert_eq!(output.continuation_cursor.is_some(), truncated);
        }
        assert_eq!(server.await.expect("server task").len(), 3);
    }

    #[tokio::test]
    async fn read_file_decodes_base64_and_reports_exact_line_window() {
        let encoded = STANDARD.encode("line one\nline two\nline three\nline four\n");
        let file = json!({
            "name": "lib.rs",
            "path": "src/lib.rs",
            "sha": SHA,
            "size": 39,
            "type": "file",
            "encoding": "base64",
            "content": encoded,
            "url": "https://attacker.invalid/api",
            "download_url": "https://attacker.invalid/download"
        });
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, json!({"default_branch": "main"}).to_string()),
                fixture_expectations(),
            ),
            (
                ResponseFixture::json(200, file.to_string()),
                fixture_expectations(),
            ),
        ])
        .await;
        let output = read_file(
            &fixture_client(&base_url),
            TOKEN,
            &repository(),
            FileRead {
                path: "src/lib.rs".to_owned(),
                git_ref: None,
                start_line: Some(2),
                line_count: Some(2),
            },
        )
        .await
        .expect("file window");
        let captures = server.await.expect("server task");
        assert_eq!(
            captures[1].path,
            "/repos/open-software-network/test-repo/contents/src/lib.rs?ref=main"
        );
        assert_eq!(output.data["text"], "line two\nline three");
        assert_eq!(output.data["startLine"], 2);
        assert_eq!(output.data["endLine"], 3);
        assert_eq!(output.data["totalLines"], 4);
        assert_eq!(output.data["ref"], "main");
        assert!(output.truncated);
        assert!(output.continuation_cursor.is_none());
        assert_eq!(output.sources[0].path.as_deref(), Some("src/lib.rs"));
        assert_eq!(output.sources[0].git_ref.as_deref(), Some("main"));
        assert!(!serde_json::to_string(&output.data)
            .unwrap()
            .contains("attacker.invalid"));
    }

    #[tokio::test]
    async fn read_file_defaults_and_caps_line_window() {
        let content = (1..=1_100)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let body = json!({
            "name": "large.txt", "path": "large.txt", "sha": SHA, "size": content.len(),
            "type": "file", "encoding": "base64", "content": STANDARD.encode(&content)
        });
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, body.to_string()),
                fixture_expectations(),
            ),
            (
                ResponseFixture::json(200, body.to_string()),
                fixture_expectations(),
            ),
        ])
        .await;
        let client = fixture_client(&base_url);
        let defaulted = read_file(
            &client,
            TOKEN,
            &repository(),
            FileRead {
                path: "large.txt".to_owned(),
                git_ref: Some("main".to_owned()),
                start_line: None,
                line_count: None,
            },
        )
        .await
        .expect("default window");
        assert_eq!(defaulted.data["startLine"], 1);
        assert_eq!(defaulted.data["endLine"], 200);
        let capped = read_file(
            &client,
            TOKEN,
            &repository(),
            FileRead {
                path: "large.txt".to_owned(),
                git_ref: Some("main".to_owned()),
                start_line: Some(1),
                line_count: Some(u16::MAX),
            },
        )
        .await
        .expect("capped window");
        assert_eq!(capped.data["endLine"], 1000);
        assert_eq!(server.await.expect("server task").len(), 2);
    }

    #[tokio::test]
    async fn read_file_blocks_sensitive_and_invalid_windows_before_traffic() {
        let client = GitHubReadClient::for_test("http://127.0.0.1:9").expect("client");
        let sensitive = read_file(
            &client,
            TOKEN,
            &repository(),
            FileRead {
                path: ".env.local".to_owned(),
                git_ref: Some("main".to_owned()),
                start_line: None,
                line_count: None,
            },
        )
        .await
        .expect_err("sensitive path blocked");
        assert_eq!(failure_code(sensitive), "github_sensitive_path_blocked");
        let invalid = read_file(
            &client,
            TOKEN,
            &repository(),
            FileRead {
                path: "README.md".to_owned(),
                git_ref: Some("main".to_owned()),
                start_line: Some(0),
                line_count: Some(20),
            },
        )
        .await
        .expect_err("line numbering starts at one");
        assert_eq!(failure_code(invalid), "github_input_invalid");
    }

    #[tokio::test]
    async fn read_file_accepts_empty_and_line_wrapped_base64() {
        let encoded = STANDARD.encode("hello world");
        let wrapped = format!("{}\n{}", &encoded[..4], &encoded[4..]);
        let fixtures = [
            json!({
                "path":"empty.txt", "sha":SHA, "size":0, "type":"file",
                "encoding":"base64", "content":""
            }),
            json!({
                "path":"wrapped.txt", "sha":SHA, "size":11, "type":"file",
                "encoding":"base64", "content":wrapped
            }),
        ];
        let script = fixtures
            .into_iter()
            .map(|fixture| {
                (
                    ResponseFixture::json(200, fixture.to_string()),
                    fixture_expectations(),
                )
            })
            .collect();
        let (base_url, server) = scripted_server(script).await;
        let client = fixture_client(&base_url);

        let empty = read_file(
            &client,
            TOKEN,
            &repository(),
            FileRead {
                path: "empty.txt".to_owned(),
                git_ref: Some("main".to_owned()),
                start_line: None,
                line_count: None,
            },
        )
        .await
        .expect("empty base64 file");
        assert_eq!(empty.data["text"], "");
        assert_eq!(empty.data["totalLines"], 0);

        let wrapped = read_file(
            &client,
            TOKEN,
            &repository(),
            FileRead {
                path: "wrapped.txt".to_owned(),
                git_ref: Some("main".to_owned()),
                start_line: None,
                line_count: None,
            },
        )
        .await
        .expect("line-wrapped base64 file");
        assert_eq!(wrapped.data["text"], "hello world");
        assert_eq!(server.await.expect("server task").len(), 2);
    }

    #[tokio::test]
    async fn read_file_selects_later_lines_after_redaction_expands_earlier_text() {
        let content = "password=x\nsecond line\nthird line survives\n";
        let file = json!({
            "path": "guarded.txt",
            "sha": SHA,
            "size": content.len(),
            "type": "file",
            "encoding": "base64",
            "content": STANDARD.encode(content)
        });
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, file.to_string()),
            fixture_expectations(),
        )])
        .await;

        let output = read_file(
            &fixture_client(&base_url),
            TOKEN,
            &repository(),
            FileRead {
                path: "guarded.txt".to_owned(),
                git_ref: Some("main".to_owned()),
                start_line: Some(3),
                line_count: Some(1),
            },
        )
        .await
        .expect("later line window");

        assert_eq!(output.data["text"], "third line survives");
        assert_eq!(output.data["startLine"], 3);
        assert_eq!(output.data["endLine"], 3);
        assert_eq!(output.data["totalLines"], 3);
        assert!(output.redactions_applied);
        assert_eq!(server.await.expect("server task").len(), 1);
    }

    #[tokio::test]
    async fn read_file_rejects_malformed_base64_submodules_binary_and_oversize_content() {
        let binary = STANDARD.encode([0_u8, 159, 146, 150]);
        let oversize = STANDARD.encode(vec![b'a'; 256 * 1024 + 1]);
        let fixtures = [
            json!({"path":"bad.txt","sha":SHA,"size":3,"type":"file","encoding":"base64","content":"%%%"}),
            json!({"path":"bad.txt","sha":SHA,"size":0,"type":"submodule","encoding":"base64","content":"c2VjcmV0"}),
            json!({"path":"bad.txt","sha":SHA,"size":4,"type":"file","encoding":"base64","content":binary}),
            json!({"path":"bad.txt","sha":SHA,"size":256 * 1024 + 1,"type":"file","encoding":"base64","content":oversize}),
        ];
        let script = fixtures
            .into_iter()
            .map(|fixture| {
                (
                    ResponseFixture::json(200, fixture.to_string()),
                    fixture_expectations(),
                )
            })
            .collect();
        let (base_url, server) = scripted_server(script).await;
        let client = fixture_client(&base_url);
        let expected = [
            "provider:Malformed",
            "github_binary_content",
            "github_binary_content",
            "github_response_too_large",
        ];
        for code in expected {
            let error = read_file(
                &client,
                TOKEN,
                &repository(),
                FileRead {
                    path: "bad.txt".to_owned(),
                    git_ref: Some("main".to_owned()),
                    start_line: None,
                    line_count: None,
                },
            )
            .await
            .expect_err("unsafe file response rejected");
            assert_eq!(failure_code(error), code);
        }
        assert_eq!(server.await.expect("server task").len(), 4);
    }

    #[tokio::test]
    async fn search_code_rejects_model_qualifiers_before_traffic() {
        let client = GitHubReadClient::for_test("http://127.0.0.1:9").expect("client");
        for query in ["needle repo:other/repo", "language:rust", "path:src"] {
            let error = search_code(
                &client,
                TOKEN,
                &repository(),
                CodeSearch {
                    query: query.to_owned(),
                    cursor: None,
                    limit: None,
                },
                &CapabilityRegistry::new(),
            )
            .await
            .expect_err("qualifier rejected");
            assert_eq!(failure_code(error), "github_input_invalid");
        }
    }

    #[tokio::test]
    async fn search_code_appends_one_scope_bounds_fragments_and_does_not_auto_page() {
        let long_fragment = format!("token = ghp_{}\n{}", "a".repeat(40), "z".repeat(8_000));
        let mut item = search_item("src/lib.rs");
        item["text_matches"] = json!([{"fragment": long_fragment}]);
        let body = json!({"total_count": 80, "incomplete_results": false, "items": [item]});
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, body.to_string()),
            fixture_expectations(),
        )])
        .await;
        let output = search_code(
            &fixture_client(&base_url),
            TOKEN,
            &repository(),
            CodeSearch {
                query: "GitHubReadClient".to_owned(),
                cursor: None,
                limit: Some(30),
            },
            &CapabilityRegistry::new(),
        )
        .await
        .expect("search page");
        let captures = server.await.expect("one provider page only");
        assert_eq!(captures.len(), 1);
        assert_eq!(
            captures[0].path,
            "/search/code?q=GitHubReadClient+repo%3Aopen-software-network%2Ftest-repo&per_page=30&page=1"
        );
        assert!(captures[0]
            .headers
            .contains("accept: application/vnd.github.text-match+json"));
        let fragment = output.data["items"][0]["fragments"][0]
            .as_str()
            .expect("fragment");
        assert!(fragment.len() <= 4 * 1024);
        assert!(fragment.contains("[REDACTED]"));
        assert!(output.redactions_applied);
        assert!(output.truncated);
        assert!(output.continuation_cursor.is_some());
        assert_eq!(
            output.sources[0].url,
            format!("https://github.com/open-software-network/test-repo/blob/{SHA}/src/lib.rs")
        );
        assert!(!serde_json::to_string(&output.data)
            .unwrap()
            .contains("attacker.invalid"));
    }

    #[tokio::test]
    async fn search_code_rejects_cross_repository_results() {
        let mut cross = search_item("src/lib.rs");
        cross["repository"]["id"] = json!(999999);
        cross["repository"]["full_name"] = json!("attacker/other");
        let body = json!({"total_count": 1, "incomplete_results": false, "items": [cross]});
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, body.to_string()),
            fixture_expectations(),
        )])
        .await;
        let error = search_code(
            &fixture_client(&base_url),
            TOKEN,
            &repository(),
            CodeSearch {
                query: "needle".to_owned(),
                cursor: None,
                limit: None,
            },
            &CapabilityRegistry::new(),
        )
        .await
        .expect_err("cross-repository provider item rejected");
        assert_eq!(failure_code(error), "provider:Malformed");
        assert_eq!(server.await.expect("server task").len(), 1);
    }

    #[tokio::test]
    async fn every_normalized_data_value_stays_within_the_soft_budget() {
        let content = "\\\"".repeat(120_000);
        let file = json!({
            "path":"quoted.txt", "sha":SHA, "size":content.len(), "type":"file",
            "encoding":"base64", "content":STANDARD.encode(content)
        });
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, file.to_string()),
            fixture_expectations(),
        )])
        .await;
        let output = read_file(
            &fixture_client(&base_url),
            TOKEN,
            &repository(),
            FileRead {
                path: "quoted.txt".to_owned(),
                git_ref: Some("main".to_owned()),
                start_line: None,
                line_count: Some(1),
            },
        )
        .await
        .expect("bounded quoted content");
        assert!(serde_json::to_vec(&output.data).unwrap().len() <= 248 * 1024);
        assert!(output.truncated);
        assert_eq!(server.await.expect("server task").len(), 1);
    }

    #[test]
    fn provider_error_type_remains_typed_for_orchestration() {
        let error = GitHubReadFailure::Provider(GitHubApiError::RateLimited {
            retry_after_seconds: Some(12),
        });
        assert_eq!(
            failure_code(error),
            "provider:RateLimited { retry_after_seconds: Some(12) }"
        );
    }
}
