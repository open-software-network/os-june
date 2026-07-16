use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
