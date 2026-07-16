#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::{
        github::EligibleGitHubRepository,
        github_api::{GitHubApiError, GitHubReadClient},
        github_auth::tests::{scripted_server, RequestExpectations, ResponseFixture},
        github_capabilities::{filter_fingerprint, CapabilityRegistry, CursorScope, PullFileScope},
        github_read::GitHubReadFailure,
    };
    use serde_json::{json, Value};

    const TOKEN: &str = "fixture-pull-read-token";
    const HEAD_SHA: &str = "0123456789abcdef0123456789abcdef01234567";
    const CHANGED_HEAD_SHA: &str = "fedcba9876543210fedcba9876543210fedcba98";

    fn repository() -> EligibleGitHubRepository {
        EligibleGitHubRepository {
            repository_id: "123456".to_owned(),
            installation_id: "789".to_owned(),
            owner_login: "open-software-network".to_owned(),
            name: "test-repo".to_owned(),
            full_name: "open-software-network/test-repo".to_owned(),
            private: true,
        }
    }

    fn expectation() -> RequestExpectations {
        RequestExpectations {
            bearer_token: Some(TOKEN),
            ..RequestExpectations::default()
        }
    }

    fn pull(number: u64, head_sha: &str, changed_files: u64) -> Value {
        json!({
            "id": 9000 + number,
            "number": number,
            "title": "Fix connector behavior",
            "state": "open",
            "draft": false,
            "body": "Pull body",
            "user": {"id": 17, "login": "contributor", "html_url": "https://evil.example/user"},
            "created_at": "2026-07-16T00:00:00Z",
            "updated_at": "2026-07-16T01:00:00Z",
            "closed_at": null,
            "merged_at": null,
            "mergeable_state": "clean",
            "changed_files": changed_files,
            "commits": 3,
            "additions": 10,
            "deletions": 4,
            "comments": 2,
            "review_comments": 1,
            "head": {
                "label": "contributor:feature",
                "ref": "feature",
                "sha": head_sha,
                "repo": {"id": 88, "full_name": "contributor/test-repo", "html_url": "https://evil.example/head"}
            },
            "base": {
                "label": "open-software-network:main",
                "ref": "main",
                "sha": "1111111111111111111111111111111111111111",
                "repo": {"id": 123456, "full_name": "open-software-network/test-repo", "html_url": "https://evil.example/base"}
            },
            "html_url": "https://evil.example/pull",
            "url": "https://evil.example/api",
            "_links": {"self": {"href": "https://evil.example/link"}}
        })
    }

    fn pull_file(path: &str, previous_path: Option<&str>, patch: Option<&str>) -> Value {
        let mut value = json!({
            "sha": "2222222222222222222222222222222222222222",
            "filename": path,
            "status": if previous_path.is_some() { "renamed" } else { "modified" },
            "additions": 8,
            "deletions": 3,
            "changes": 11,
            "blob_url": "https://evil.example/blob",
            "raw_url": "https://evil.example/raw",
            "contents_url": "https://evil.example/contents"
        });
        if let Some(previous_path) = previous_path {
            value["previous_filename"] = json!(previous_path);
        }
        if let Some(patch) = patch {
            value["patch"] = json!(patch);
        }
        value
    }

    fn page(number: u64) -> PullRequestPage {
        PullRequestPage {
            number,
            cursor: None,
            limit: Some(30),
        }
    }

    fn assert_input_code<T: std::fmt::Debug>(result: Result<T, GitHubReadFailure>, expected: &str) {
        match result {
            Err(GitHubReadFailure::Input(error)) => assert_eq!(error.code, expected),
            other => panic!("expected input error {expected}, got {other:?}"),
        }
    }

    fn assert_provider_error<T: std::fmt::Debug>(
        result: Result<T, GitHubReadFailure>,
        expected: GitHubApiError,
    ) {
        match result {
            Err(GitHubReadFailure::Provider(error)) => assert_eq!(error, expected),
            other => panic!("expected provider error {expected:?}, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn list_pull_requests_uses_only_fixed_list_and_search_endpoints() {
        let list_body = json!([pull(7, HEAD_SHA, 2)]).to_string();
        let (base_url, server) =
            scripted_server(vec![(ResponseFixture::json(200, list_body), expectation())]).await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        let output = list_pull_requests(
            &client,
            TOKEN,
            &repository(),
            PullRequestList {
                state: Some("all".to_owned()),
                query: None,
                base: Some("main".to_owned()),
                head: Some("contributor:feature/fix-1".to_owned()),
                cursor: None,
                limit: Some(30),
            },
            &CapabilityRegistry::new(),
        )
        .await
        .expect("list pulls");
        assert_eq!(output.data["items"][0]["number"], 7);
        let captures = server.await.expect("server");
        assert_eq!(captures.len(), 1);
        assert_eq!(captures[0].method, "GET");
        assert_eq!(
            captures[0].path,
            "/repos/open-software-network/test-repo/pulls?state=all&base=main&head=contributor%3Afeature%2Ffix-1&per_page=30&page=1"
        );

        let mut search_pull = pull(8, HEAD_SHA, 1);
        search_pull["repository_url"] =
            json!("https://api.github.com/repos/open-software-network/test-repo");
        search_pull["pull_request"] = json!({"url": "https://evil.example/pull-marker"});
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(
                200,
                json!({"total_count": 1, "incomplete_results": false, "items": [search_pull]})
                    .to_string(),
            ),
            expectation(),
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        let output = list_pull_requests(
            &client,
            TOKEN,
            &repository(),
            PullRequestList {
                state: Some("open".to_owned()),
                query: Some("connector bug".to_owned()),
                base: None,
                head: Some("contributor:feature/fix-1".to_owned()),
                cursor: None,
                limit: Some(20),
            },
            &CapabilityRegistry::new(),
        )
        .await
        .expect("search pulls");
        assert_eq!(output.data["items"][0]["number"], 8);
        let captures = server.await.expect("server");
        assert_eq!(captures.len(), 1);
        assert_eq!(captures[0].method, "GET");
        assert_eq!(
            captures[0].path,
            "/search/issues?q=connector+bug+repo%3Aopen-software-network%2Ftest-repo+is%3Apr+is%3Aopen+head%3Afeature%2Ffix-1&per_page=20&page=1"
        );
        assert!(!captures[0].path.contains("head%3Acontributor%3A"));
    }

    #[tokio::test]
    async fn pull_list_inputs_and_cursors_are_bound_to_every_filter() {
        let client = GitHubReadClient::for_test("http://127.0.0.1:9").expect("test client");
        for request in [
            PullRequestList {
                state: Some("merged".to_owned()),
                query: None,
                base: None,
                head: None,
                cursor: None,
                limit: None,
            },
            PullRequestList {
                state: None,
                query: Some("repo:someone/else".to_owned()),
                base: None,
                head: None,
                cursor: None,
                limit: None,
            },
            PullRequestList {
                state: None,
                query: None,
                base: Some("../main".to_owned()),
                head: None,
                cursor: None,
                limit: None,
            },
            PullRequestList {
                state: None,
                query: None,
                base: None,
                head: Some("owner head:branch".to_owned()),
                cursor: None,
                limit: None,
            },
            PullRequestList {
                state: None,
                query: None,
                base: None,
                head: None,
                cursor: None,
                limit: Some(51),
            },
        ] {
            assert_input_code(
                list_pull_requests(
                    &client,
                    TOKEN,
                    &repository(),
                    request,
                    &CapabilityRegistry::new(),
                )
                .await,
                "github_input_invalid",
            );
        }

        let pulls = vec![pull(1, HEAD_SHA, 1), pull(2, HEAD_SHA, 1)];
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, serde_json::to_string(&pulls).expect("pulls")),
            expectation(),
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        let capabilities = CapabilityRegistry::new();
        let output = list_pull_requests(
            &client,
            TOKEN,
            &repository(),
            PullRequestList {
                state: Some("open".to_owned()),
                query: None,
                base: None,
                head: None,
                cursor: None,
                limit: Some(2),
            },
            &capabilities,
        )
        .await
        .expect("first page");
        server.await.expect("server");
        let cursor = output.continuation_cursor.expect("continuation cursor");
        assert_input_code(
            list_pull_requests(
                &client,
                TOKEN,
                &repository(),
                PullRequestList {
                    state: Some("closed".to_owned()),
                    query: None,
                    base: None,
                    head: None,
                    cursor: Some(cursor),
                    limit: Some(2),
                },
                &capabilities,
            )
            .await,
            "github_cursor_invalid",
        );
    }

    #[tokio::test]
    async fn pull_list_head_requires_one_bounded_user_or_org_qualified_ref() {
        let client = GitHubReadClient::for_test("http://127.0.0.1:9").expect("test client");
        for head in [
            "feature",
            ":feature",
            "contributor:",
            "contributor:feature:injected",
            "contributor/team:feature",
            "-contributor:feature",
            "contributor-:feature",
            "contributor head:feature",
            "contributor:../feature",
            "contributor:feature head:attacker",
        ] {
            assert_input_code(
                list_pull_requests(
                    &client,
                    TOKEN,
                    &repository(),
                    PullRequestList {
                        state: None,
                        query: None,
                        base: None,
                        head: Some(head.to_owned()),
                        cursor: None,
                        limit: None,
                    },
                    &CapabilityRegistry::new(),
                )
                .await,
                "github_input_invalid",
            );
        }

        let overlong_qualifier = format!("{}:feature", "a".repeat(40));
        assert_input_code(
            list_pull_requests(
                &client,
                TOKEN,
                &repository(),
                PullRequestList {
                    state: None,
                    query: None,
                    base: None,
                    head: Some(overlong_qualifier),
                    cursor: None,
                    limit: None,
                },
                &CapabilityRegistry::new(),
            )
            .await,
            "github_input_invalid",
        );
    }

    #[tokio::test]
    async fn search_rejects_cross_repository_results() {
        let mut hostile = pull(9, HEAD_SHA, 1);
        hostile["repository_url"] = json!("https://api.github.com/repos/other/private-repo");
        hostile["pull_request"] = json!({"url": "https://evil.example/pull-marker"});
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(
                200,
                json!({"total_count": 1, "incomplete_results": false, "items": [hostile]})
                    .to_string(),
            ),
            expectation(),
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        assert_provider_error(
            list_pull_requests(
                &client,
                TOKEN,
                &repository(),
                PullRequestList {
                    state: None,
                    query: Some("bug".to_owned()),
                    base: None,
                    head: None,
                    cursor: None,
                    limit: None,
                },
                &CapabilityRegistry::new(),
            )
            .await,
            GitHubApiError::Malformed,
        );
        server.await.expect("server");
    }

    #[tokio::test]
    async fn get_pull_request_bounds_body_and_builds_sources_from_the_selected_repository() {
        let mut fixture = pull(7, HEAD_SHA, 2);
        fixture["body"] = json!(format!("token=fixture-secret\n{}", "x".repeat(70 * 1024)));
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, fixture.to_string()),
            expectation(),
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        let output = get_pull_request(&client, TOKEN, &repository(), 7)
            .await
            .expect("get pull");
        assert_eq!(output.data["number"], 7);
        assert_eq!(output.data["head"]["sha"], HEAD_SHA);
        assert_eq!(output.data["base"]["ref"], "main");
        assert_eq!(output.data["bodyTruncated"], true);
        assert!(output.redactions_applied);
        assert!(output.data["body"].as_str().expect("body").len() <= 64 * 1024);
        assert_eq!(
            output.sources[0].url,
            "https://github.com/open-software-network/test-repo/pull/7"
        );
        let serialized = serde_json::to_string(&output.data).expect("serialize output");
        assert!(!serialized.contains("evil.example"));
        assert!(!serialized.contains("fixture-secret"));
        let captures = server.await.expect("server");
        assert_eq!(
            captures[0].path,
            "/repos/open-software-network/test-repo/pulls/7"
        );

        assert_input_code(
            get_pull_request(&client, TOKEN, &repository(), 0).await,
            "github_input_invalid",
        );
    }

    #[tokio::test]
    async fn list_pull_request_files_rechecks_head_and_issues_bound_refs_for_renames() {
        let files = json!([
            pull_file(
                "src/new.rs",
                Some("src/old.rs"),
                Some("provider patch must not leak here")
            ),
            pull_file("README.md", None, None)
        ]);
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 2).to_string()),
                expectation(),
            ),
            (ResponseFixture::json(200, files.to_string()), expectation()),
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 2).to_string()),
                expectation(),
            ),
        ])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        let capabilities = CapabilityRegistry::new();
        let output = list_pull_request_files(
            &client,
            TOKEN,
            &repository(),
            PullRequestPage {
                number: 42,
                cursor: None,
                limit: Some(2),
            },
            &capabilities,
        )
        .await
        .expect("list files");
        assert_eq!(output.data["items"][0]["status"], "renamed");
        assert_eq!(output.data["items"][0]["previousFilename"], "src/old.rs");
        assert!(output.data["items"][0]["patch"].is_null());
        let file_ref = output.data["items"][0]["fileRef"]
            .as_str()
            .expect("file ref");
        let scope = capabilities
            .resolve_pull_file(file_ref, "123456", 42, HEAD_SHA)
            .expect("bound file ref");
        assert_eq!(scope.absolute_index, 0);
        assert_eq!(scope.expected_path, "src/new.rs");
        let captures = server.await.expect("server");
        assert_eq!(captures.len(), 3);
        assert_eq!(
            captures[0].path,
            "/repos/open-software-network/test-repo/pulls/42"
        );
        assert_eq!(
            captures[1].path,
            "/repos/open-software-network/test-repo/pulls/42/files?per_page=2&page=1"
        );
        assert_eq!(
            captures[2].path,
            "/repos/open-software-network/test-repo/pulls/42"
        );
    }

    #[tokio::test]
    async fn pull_file_pages_enforce_the_three_thousand_file_provider_limit() {
        let capabilities = CapabilityRegistry::new();
        let fingerprint = filter_fingerprint(&json!({"number": 42, "limit": 50}));
        let cursor = capabilities
            .issue_cursor(CursorScope {
                operation: "list_pull_request_files",
                repository_id: Some("123456".to_owned()),
                filter_fingerprint: fingerprint,
                provider_page: 60,
                raw_offset: 0,
                phase: None,
            })
            .expect("page cursor");
        let files = (0..50)
            .map(|index| pull_file(&format!("src/file-{index}.rs"), None, None))
            .collect::<Vec<_>>();
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 3001).to_string()),
                expectation(),
            ),
            (
                ResponseFixture::json(200, serde_json::to_string(&files).expect("files")),
                expectation(),
            ),
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 3001).to_string()),
                expectation(),
            ),
        ])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        let output = list_pull_request_files(
            &client,
            TOKEN,
            &repository(),
            PullRequestPage {
                number: 42,
                cursor: Some(cursor),
                limit: Some(50),
            },
            &capabilities,
        )
        .await
        .expect("last provider page");
        assert_eq!(output.data["providerFileLimitReached"], true);
        assert!(output.continuation_cursor.is_none());
        let last_ref = output.data["items"][49]["fileRef"]
            .as_str()
            .expect("last ref");
        assert_eq!(
            capabilities
                .resolve_pull_file(last_ref, "123456", 42, HEAD_SHA)
                .expect("last bound ref")
                .absolute_index,
            2999
        );
        let captures = server.await.expect("server");
        assert_eq!(
            captures[1].path,
            "/repos/open-software-network/test-repo/pulls/42/files?per_page=50&page=60"
        );
    }

    #[tokio::test]
    async fn unstable_pull_heads_discard_file_and_check_content() {
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 1).to_string()),
                expectation(),
            ),
            (
                ResponseFixture::json(
                    200,
                    json!([pull_file("src/lib.rs", None, None)]).to_string(),
                ),
                expectation(),
            ),
            (
                ResponseFixture::json(200, pull(42, CHANGED_HEAD_SHA, 1).to_string()),
                expectation(),
            ),
        ])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        assert_input_code(
            list_pull_request_files(
                &client,
                TOKEN,
                &repository(),
                page(42),
                &CapabilityRegistry::new(),
            )
            .await,
            "github_pull_request_changed",
        );
        server.await.expect("server");

        let check = json!({
            "id": 801,
            "name": "CI",
            "head_sha": HEAD_SHA,
            "status": "completed",
            "conclusion": "success",
            "started_at": "2026-07-16T00:00:00Z",
            "completed_at": "2026-07-16T00:01:00Z",
            "app": null,
            "output": {"title": "Passed", "summary": "All good", "text": null}
        });
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 1).to_string()),
                expectation(),
            ),
            (
                ResponseFixture::json(
                    200,
                    json!({"total_count": 1, "check_runs": [check]}).to_string(),
                ),
                expectation(),
            ),
            (
                ResponseFixture::json(200, pull(42, CHANGED_HEAD_SHA, 1).to_string()),
                expectation(),
            ),
        ])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        assert_input_code(
            list_pull_request_checks(
                &client,
                TOKEN,
                &repository(),
                page(42),
                &CapabilityRegistry::new(),
            )
            .await,
            "github_pull_request_changed",
        );
        server.await.expect("server");
    }

    #[tokio::test]
    async fn read_pull_request_file_diff_uses_only_the_bound_single_file_page() {
        let capabilities = CapabilityRegistry::new();
        let file_ref = capabilities
            .issue_pull_file(PullFileScope {
                repository_id: "123456".to_owned(),
                pull_number: 42,
                head_sha: HEAD_SHA.to_owned(),
                absolute_index: 7,
                expected_path: "src/new.rs".to_owned(),
            })
            .expect("file ref");
        let patch = (0..2001)
            .map(|line| format!("+line-{line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let response = json!([pull_file("src/new.rs", Some("src/old.rs"), Some(&patch))]);
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 8).to_string()),
                expectation(),
            ),
            (
                ResponseFixture::json(200, response.to_string()),
                expectation(),
            ),
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 8).to_string()),
                expectation(),
            ),
        ])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        let output = read_pull_request_file_diff(
            &client,
            TOKEN,
            &repository(),
            PullRequestFileDiff {
                number: 42,
                file_ref: file_ref.clone(),
                cursor: None,
            },
            &capabilities,
        )
        .await
        .expect("read file patch");
        assert_eq!(output.data["patchState"], "provider_supplied");
        assert!(
            output.data["patch"]
                .as_str()
                .expect("patch")
                .lines()
                .count()
                <= 2000
        );
        assert!(output.continuation_cursor.is_some());
        assert_eq!(output.sources[0].path.as_deref(), Some("src/new.rs"));
        assert_eq!(output.sources[0].git_ref.as_deref(), Some(HEAD_SHA));
        let captures = server.await.expect("server");
        assert_eq!(captures.len(), 3);
        assert_eq!(
            captures[1].path,
            "/repos/open-software-network/test-repo/pulls/42/files?per_page=1&page=8"
        );
        assert!(captures
            .iter()
            .all(|capture| !capture.path.ends_with(".diff")));

        let cursor = output.continuation_cursor.expect("patch cursor");
        let response = json!([pull_file("src/new.rs", Some("src/old.rs"), Some(&patch))]);
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 8).to_string()),
                expectation(),
            ),
            (
                ResponseFixture::json(200, response.to_string()),
                expectation(),
            ),
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 8).to_string()),
                expectation(),
            ),
        ])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        let continuation = read_pull_request_file_diff(
            &client,
            TOKEN,
            &repository(),
            PullRequestFileDiff {
                number: 42,
                file_ref,
                cursor: Some(cursor),
            },
            &capabilities,
        )
        .await
        .expect("continue patch");
        assert!(!continuation.data["patch"]
            .as_str()
            .expect("continued patch")
            .contains("+line-0\n"));
        server.await.expect("server");
    }

    #[tokio::test]
    async fn missing_oversize_and_wrong_path_patches_are_reported_without_widening() {
        let capabilities = CapabilityRegistry::new();
        let file_ref = capabilities
            .issue_pull_file(PullFileScope {
                repository_id: "123456".to_owned(),
                pull_number: 42,
                head_sha: HEAD_SHA.to_owned(),
                absolute_index: 0,
                expected_path: "src/lib.rs".to_owned(),
            })
            .expect("file ref");

        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 1).to_string()),
                expectation(),
            ),
            (
                ResponseFixture::json(
                    200,
                    json!([pull_file("src/lib.rs", None, None)]).to_string(),
                ),
                expectation(),
            ),
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 1).to_string()),
                expectation(),
            ),
        ])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        let output = read_pull_request_file_diff(
            &client,
            TOKEN,
            &repository(),
            PullRequestFileDiff {
                number: 42,
                file_ref: file_ref.clone(),
                cursor: None,
            },
            &capabilities,
        )
        .await
        .expect("missing patch is data");
        assert_eq!(output.data["patchState"], "unavailable");
        assert!(output.continuation_cursor.is_none());
        server.await.expect("server");

        let oversized_patch = "x".repeat(400 * 1024);
        let oversized = json!([pull_file("src/lib.rs", None, Some(&oversized_patch))]);
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 1).to_string()),
                expectation(),
            ),
            (
                ResponseFixture::json(200, oversized.to_string()).chunked(),
                expectation(),
            ),
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 1).to_string()),
                expectation(),
            ),
        ])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        let output = read_pull_request_file_diff(
            &client,
            TOKEN,
            &repository(),
            PullRequestFileDiff {
                number: 42,
                file_ref: file_ref.clone(),
                cursor: None,
            },
            &capabilities,
        )
        .await
        .expect("oversize patch is data");
        assert_eq!(output.data["patchState"], "response_too_large");
        assert!(output.continuation_cursor.is_none());
        server.await.expect("server");

        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 1).to_string()),
                expectation(),
            ),
            (
                ResponseFixture::json(
                    200,
                    json!([pull_file("src/other.rs", None, Some("patch"))]).to_string(),
                ),
                expectation(),
            ),
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 1).to_string()),
                expectation(),
            ),
        ])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        assert_input_code(
            read_pull_request_file_diff(
                &client,
                TOKEN,
                &repository(),
                PullRequestFileDiff {
                    number: 42,
                    file_ref,
                    cursor: None,
                },
                &capabilities,
            )
            .await,
            "github_file_ref_invalid",
        );
        server.await.expect("server");

        let unstable_ref = capabilities
            .issue_pull_file(PullFileScope {
                repository_id: "123456".to_owned(),
                pull_number: 42,
                head_sha: HEAD_SHA.to_owned(),
                absolute_index: 0,
                expected_path: "src/lib.rs".to_owned(),
            })
            .expect("unstable file ref");
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 1).to_string()),
                expectation(),
            ),
            (
                ResponseFixture::json(
                    200,
                    json!([pull_file("src/lib.rs", None, Some("patch"))]).to_string(),
                ),
                expectation(),
            ),
            (
                ResponseFixture::json(200, pull(42, CHANGED_HEAD_SHA, 1).to_string()),
                expectation(),
            ),
        ])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        assert_input_code(
            read_pull_request_file_diff(
                &client,
                TOKEN,
                &repository(),
                PullRequestFileDiff {
                    number: 42,
                    file_ref: unstable_ref,
                    cursor: None,
                },
                &capabilities,
            )
            .await,
            "github_pull_request_changed",
        );
        server.await.expect("server");
    }

    #[tokio::test]
    async fn commit_review_and_review_comment_reads_use_fixed_endpoints_and_bounds() {
        let commit = json!({
            "sha": "3333333333333333333333333333333333333333",
            "commit": {
                "message": format!("api_key=fixture-secret\n{}", "m".repeat(10 * 1024)),
                "author": {"name": "Author", "email": "private@example.com", "date": "2026-07-16T00:00:00Z"},
                "committer": {"name": "Committer", "email": "private@example.com", "date": "2026-07-16T00:00:00Z"}
            },
            "author": {"id": 17, "login": "author"},
            "committer": {"id": 18, "login": "committer"},
            "html_url": "https://evil.example/commit"
        });
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, json!([commit]).to_string()),
            expectation(),
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        let output = list_pull_request_commits(
            &client,
            TOKEN,
            &repository(),
            page(42),
            &CapabilityRegistry::new(),
        )
        .await
        .expect("commits");
        assert!(
            output.data["items"][0]["message"]
                .as_str()
                .expect("message")
                .len()
                <= 8 * 1024
        );
        assert_eq!(output.data["items"][0]["messageTruncated"], true);
        assert!(output.redactions_applied);
        assert!(!serde_json::to_string(&output.data)
            .expect("serialize")
            .contains("evil.example"));
        let captures = server.await.expect("server");
        assert_eq!(
            captures[0].path,
            "/repos/open-software-network/test-repo/pulls/42/commits?per_page=30&page=1"
        );

        let review = json!({
            "id": 501,
            "user": {"id": 19, "login": "reviewer"},
            "body": format!("password=fixture-secret\n{}", "r".repeat(18 * 1024)),
            "state": "APPROVED",
            "submitted_at": "2026-07-16T00:00:00Z",
            "commit_id": HEAD_SHA,
            "html_url": "https://evil.example/review"
        });
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, json!([review]).to_string()),
            expectation(),
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        let output = list_pull_request_reviews(
            &client,
            TOKEN,
            &repository(),
            page(42),
            &CapabilityRegistry::new(),
        )
        .await
        .expect("reviews");
        assert!(
            output.data["items"][0]["body"]
                .as_str()
                .expect("body")
                .len()
                <= 16 * 1024
        );
        assert_eq!(output.data["items"][0]["bodyTruncated"], true);
        assert!(output.redactions_applied);
        let captures = server.await.expect("server");
        assert_eq!(
            captures[0].path,
            "/repos/open-software-network/test-repo/pulls/42/reviews?per_page=30&page=1"
        );

        let comment = json!({
            "id": 700,
            "user": {"id": 20, "login": "reviewer"},
            "body": "Review comment",
            "path": "src/lib.rs",
            "line": 9,
            "side": "RIGHT",
            "start_line": null,
            "start_side": null,
            "commit_id": HEAD_SHA,
            "original_commit_id": HEAD_SHA,
            "created_at": "2026-07-16T00:00:00Z",
            "updated_at": "2026-07-16T00:00:00Z",
            "html_url": "https://evil.example/comment"
        });
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, json!([comment]).to_string()),
            expectation(),
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        let output = list_pull_request_review_comments(
            &client,
            TOKEN,
            &repository(),
            page(42),
            &CapabilityRegistry::new(),
        )
        .await
        .expect("review comments");
        assert_eq!(output.data["items"][0]["path"], "src/lib.rs");
        assert_eq!(output.sources[0].path.as_deref(), Some("src/lib.rs"));
        assert!(!output.sources[0].url.contains("evil.example"));
        let captures = server.await.expect("server");
        assert_eq!(
            captures[0].path,
            "/repos/open-software-network/test-repo/pulls/42/comments?per_page=30&page=1"
        );
    }

    #[tokio::test]
    async fn pull_request_checks_page_check_runs_then_statuses_without_hidden_draining() {
        let check = json!({
            "id": 801,
            "name": "CI",
            "head_sha": HEAD_SHA,
            "status": "completed",
            "conclusion": "success",
            "started_at": "2026-07-16T00:00:00Z",
            "completed_at": "2026-07-16T00:01:00Z",
            "app": {"id": 91, "name": "Checks app"},
            "output": {"title": "Passed", "summary": "All good", "text": "token=fixture-secret"},
            "details_url": "https://evil.example/check"
        });
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 1).to_string()),
                expectation(),
            ),
            (
                ResponseFixture::json(
                    200,
                    json!({"total_count": 1, "check_runs": [check]}).to_string(),
                ),
                expectation(),
            ),
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 1).to_string()),
                expectation(),
            ),
        ])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        let capabilities = CapabilityRegistry::new();
        let output = list_pull_request_checks(
            &client,
            TOKEN,
            &repository(),
            PullRequestPage {
                number: 42,
                cursor: None,
                limit: Some(30),
            },
            &capabilities,
        )
        .await
        .expect("check runs");
        assert_eq!(output.data["phase"], "check_runs");
        assert!(output.redactions_applied);
        let cursor = output.continuation_cursor.expect("statuses cursor");
        let captures = server.await.expect("server");
        assert_eq!(captures.len(), 3);
        assert_eq!(
            captures[1].path,
            format!("/repos/open-software-network/test-repo/commits/{HEAD_SHA}/check-runs?per_page=30&page=1")
        );

        let status = json!({
            "id": 901,
            "state": "success",
            "context": "continuous-integration/test",
            "description": "Tests passed",
            "created_at": "2026-07-16T00:00:00Z",
            "updated_at": "2026-07-16T00:00:00Z",
            "creator": {"id": 22, "login": "automation"},
            "target_url": "https://evil.example/status"
        });
        let (base_url, server) = scripted_server(vec![
            (ResponseFixture::json(200, pull(42, HEAD_SHA, 1).to_string()), expectation()),
            (ResponseFixture::json(200, json!({"state": "success", "sha": HEAD_SHA, "total_count": 1, "statuses": [status]}).to_string()), expectation()),
            (ResponseFixture::json(200, pull(42, HEAD_SHA, 1).to_string()), expectation()),
        ])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        let output = list_pull_request_checks(
            &client,
            TOKEN,
            &repository(),
            PullRequestPage {
                number: 42,
                cursor: Some(cursor),
                limit: Some(30),
            },
            &capabilities,
        )
        .await
        .expect("statuses");
        assert_eq!(output.data["phase"], "statuses");
        assert!(output.continuation_cursor.is_none());
        assert!(!serde_json::to_string(&output.data)
            .expect("serialize")
            .contains("evil.example"));
        let captures = server.await.expect("server");
        assert_eq!(captures.len(), 3);
        assert_eq!(
            captures[1].path,
            format!("/repos/open-software-network/test-repo/commits/{HEAD_SHA}/status?per_page=30&page=1")
        );
    }

    #[tokio::test]
    async fn rate_limited_check_runs_remain_a_typed_provider_failure() {
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, pull(42, HEAD_SHA, 1).to_string()),
                expectation(),
            ),
            (
                ResponseFixture::json(429, "provider body must not leak")
                    .with_header("Retry-After", "17"),
                expectation(),
            ),
        ])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        assert_provider_error(
            list_pull_request_checks(
                &client,
                TOKEN,
                &repository(),
                page(42),
                &CapabilityRegistry::new(),
            )
            .await,
            GitHubApiError::RateLimited {
                retry_after_seconds: Some(17),
            },
        );
        let captures = server.await.expect("server");
        assert_eq!(captures.len(), 2);
    }

    #[tokio::test]
    async fn normalized_pull_lists_honor_the_shared_soft_budget() {
        let pulls = (1..=20)
            .map(|number| {
                let mut item = pull(number, HEAD_SHA, 1);
                item["body"] = json!("b".repeat(20 * 1024));
                item
            })
            .collect::<Vec<_>>();
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, serde_json::to_string(&pulls).expect("pulls")),
            expectation(),
        )])
        .await;
        let client = GitHubReadClient::for_test(&base_url).expect("test client");
        let output = list_pull_requests(
            &client,
            TOKEN,
            &repository(),
            PullRequestList {
                state: None,
                query: None,
                base: None,
                head: None,
                cursor: None,
                limit: Some(30),
            },
            &CapabilityRegistry::new(),
        )
        .await
        .expect("bounded list");
        assert!(
            serde_json::to_vec(&output.data)
                .expect("serialize data")
                .len()
                <= 248 * 1024
        );
        assert!(output.truncated);
        assert!(output.continuation_cursor.is_some());
        server.await.expect("server");
    }

    #[test]
    fn list_budget_counts_item_source_pairs_and_preserves_same_page_progress() {
        const FIXED_ENVELOPE_ALLOWANCE: usize = 4 * 1024;
        let total = 50_usize;
        let normalized = (0..total)
            .map(|index| {
                let path = format!("src/{index:02}/{}", "x".repeat(980));
                NormalizedItem {
                    value: json!({
                        "id": index.to_string(),
                        "body": "b".repeat(4_600),
                    }),
                    source: GitHubSource {
                        repository_id: "123456".to_owned(),
                        repository_full_name: "open-software-network/test-repo".to_owned(),
                        url: format!(
                            "https://github.com/open-software-network/test-repo/blob/{HEAD_SHA}/{path}"
                        ),
                        object_id: index.to_string(),
                        path: Some(path),
                        git_ref: Some(HEAD_SHA.to_owned()),
                    },
                    redactions_applied: false,
                }
            })
            .collect::<Vec<_>>();

        let selected = select_items(normalized, None).expect("select bounded pairs");
        let serialized_pairs = serde_json::to_vec(&json!({
            "data": {"items": &selected.values},
            "sources": &selected.sources,
        }))
        .expect("serialize selected item-source pairs");
        assert!(
            serialized_pairs.len() + FIXED_ENVELOPE_ALLOWANCE <= SOFT_DATA_BUDGET,
            "selected item-source pairs and fixed envelope allowance must fit the soft budget"
        );
        assert!(selected.accepted > 0);
        assert!(selected.accepted < total);

        let capabilities = CapabilityRegistry::new();
        let fingerprint = filter_fingerprint(&json!({"fixture": "source-heavy"}));
        let cursor = list_continuation(
            &capabilities,
            "list_pull_requests",
            "123456",
            fingerprint,
            PagePosition {
                provider_page: 1,
                raw_offset: 0,
            },
            total,
            selected.accepted,
            total as u16,
        )
        .expect("issue continuation")
        .expect("source-heavy page must continue");
        let continued = resolve_page(
            &capabilities,
            Some(&cursor),
            "list_pull_requests",
            "123456",
            &fingerprint,
        )
        .expect("resolve continuation");
        assert_eq!(continued.provider_page, 1);
        assert_eq!(continued.raw_offset, selected.accepted);
    }
}
use super::{
    github::EligibleGitHubRepository,
    github_api::{
        GitHubApiError, GitHubReadClient, FILE_RESPONSE_MAX_BYTES, LIST_RESPONSE_MAX_BYTES,
        SINGLETON_RESPONSE_MAX_BYTES,
    },
    github_capabilities::{filter_fingerprint, CapabilityRegistry, CursorScope, PullFileScope},
    github_content_guard::{
        normalize_untrusted_text, validate_git_ref, validate_repository_path,
        validate_search_literal,
    },
    github_read::{
        GitHubFinalizationCheckpoints, GitHubOperationOutput, GitHubPatchCheckpoint,
        GitHubReadFailure, GitHubSource,
    },
};
use crate::domain::types::AppError;
use serde::Deserialize;
use serde_json::{json, Value};

const DEFAULT_LIMIT: u16 = 30;
const MAX_LIMIT: u16 = 50;
const SOFT_DATA_BUDGET: usize = 248 * 1024;
const LIST_FIXED_ENVELOPE_ALLOWANCE: usize = 4 * 1024;
const MAX_HEAD_QUALIFIER_BYTES: usize = 39;
const MAX_PULL_HEAD_FILTER_BYTES: usize = 295;
const PULL_BODY_MAX_BYTES: usize = 64 * 1024;
const COLLABORATION_BODY_MAX_BYTES: usize = 16 * 1024;
const COMMIT_MESSAGE_MAX_BYTES: usize = 8 * 1024;
const INLINE_TEXT_MAX_BYTES: usize = 4 * 1024;
const PATCH_MAX_BYTES: usize = 240 * 1024;
const PATCH_MAX_LINES: usize = 2_000;
const MAX_PROVIDER_FILES: usize = 3_000;

#[allow(dead_code)] // Task 8 consumes this staged endpoint request.
pub(crate) struct PullRequestList {
    pub state: Option<String>,
    pub query: Option<String>,
    pub base: Option<String>,
    pub head: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<u16>,
}

#[allow(dead_code)] // Task 8 consumes this staged endpoint request.
pub(crate) struct PullRequestPage {
    pub number: u64,
    pub cursor: Option<String>,
    pub limit: Option<u16>,
}

#[allow(dead_code)] // Task 8 consumes this staged endpoint request.
pub(crate) struct PullRequestFileDiff {
    pub number: u64,
    pub file_ref: String,
    pub cursor: Option<String>,
}

struct ValidatedPullList {
    state: String,
    query: Option<String>,
    base: Option<String>,
    head: Option<String>,
    limit: u16,
}

#[derive(Clone, Copy)]
struct PagePosition {
    provider_page: u32,
    raw_offset: usize,
}

struct NormalizedItem {
    value: Value,
    source: GitHubSource,
    redactions_applied: bool,
}

struct SelectedItems {
    values: Vec<Value>,
    sources: Vec<GitHubSource>,
    redactions_applied: bool,
    accepted: usize,
}

#[derive(Deserialize)]
struct ProviderUser {
    id: u64,
    login: String,
}

#[derive(Deserialize)]
struct ProviderRepositoryIdentity {
    #[allow(dead_code)]
    id: Option<u64>,
    full_name: String,
}

#[derive(Deserialize)]
struct ProviderPullRef {
    label: String,
    #[serde(rename = "ref")]
    git_ref: String,
    sha: String,
    repo: Option<ProviderRepositoryIdentity>,
}

#[derive(Deserialize)]
struct ProviderPull {
    id: u64,
    number: u64,
    title: String,
    state: String,
    #[serde(default)]
    draft: bool,
    body: Option<String>,
    user: ProviderUser,
    created_at: String,
    updated_at: String,
    closed_at: Option<String>,
    merged_at: Option<String>,
    mergeable_state: Option<String>,
    #[serde(default)]
    changed_files: u64,
    #[serde(default)]
    commits: u64,
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
    #[serde(default)]
    comments: u64,
    #[serde(default)]
    review_comments: u64,
    head: Option<ProviderPullRef>,
    base: Option<ProviderPullRef>,
    repository_url: Option<String>,
    pull_request: Option<Value>,
}

#[derive(Deserialize)]
struct ProviderPullSearch {
    #[allow(dead_code)]
    total_count: u64,
    items: Vec<ProviderPull>,
}

#[derive(Deserialize)]
struct ProviderPullFile {
    sha: String,
    filename: String,
    status: String,
    additions: u64,
    deletions: u64,
    changes: u64,
    previous_filename: Option<String>,
    patch: Option<String>,
}

#[derive(Deserialize)]
struct ProviderCommitIdentity {
    name: String,
    date: String,
}

#[derive(Deserialize)]
struct ProviderCommitDetails {
    message: String,
    author: Option<ProviderCommitIdentity>,
    committer: Option<ProviderCommitIdentity>,
}

#[derive(Deserialize)]
struct ProviderCommit {
    sha: String,
    commit: ProviderCommitDetails,
    author: Option<ProviderUser>,
    committer: Option<ProviderUser>,
}

#[derive(Deserialize)]
struct ProviderReview {
    id: u64,
    user: ProviderUser,
    body: Option<String>,
    state: String,
    submitted_at: Option<String>,
    commit_id: Option<String>,
}

#[derive(Deserialize)]
struct ProviderReviewComment {
    id: u64,
    user: ProviderUser,
    body: String,
    path: String,
    line: Option<u64>,
    side: Option<String>,
    start_line: Option<u64>,
    start_side: Option<String>,
    commit_id: String,
    original_commit_id: String,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
struct ProviderCheckApp {
    id: u64,
    name: String,
}

#[derive(Default, Deserialize)]
struct ProviderCheckOutput {
    title: Option<String>,
    summary: Option<String>,
    text: Option<String>,
}

#[derive(Deserialize)]
struct ProviderCheckRun {
    id: u64,
    name: String,
    head_sha: String,
    status: String,
    conclusion: Option<String>,
    started_at: Option<String>,
    completed_at: Option<String>,
    app: Option<ProviderCheckApp>,
    #[serde(default)]
    output: ProviderCheckOutput,
}

#[derive(Deserialize)]
struct ProviderCheckRuns {
    #[allow(dead_code)]
    total_count: u64,
    check_runs: Vec<ProviderCheckRun>,
}

#[derive(Deserialize)]
struct ProviderStatus {
    id: u64,
    state: String,
    context: String,
    description: Option<String>,
    created_at: String,
    updated_at: String,
    creator: Option<ProviderUser>,
}

#[derive(Deserialize)]
struct ProviderCombinedStatus {
    state: String,
    sha: String,
    #[allow(dead_code)]
    total_count: u64,
    statuses: Vec<ProviderStatus>,
}

fn input_invalid() -> GitHubReadFailure {
    GitHubReadFailure::Input(AppError::new(
        "github_input_invalid",
        "GitHub input is invalid.",
    ))
}

fn pull_changed() -> GitHubReadFailure {
    GitHubReadFailure::Input(AppError::new(
        "github_pull_request_changed",
        "The GitHub pull request changed while it was being read.",
    ))
}

fn file_ref_invalid() -> GitHubReadFailure {
    GitHubReadFailure::Input(AppError::new(
        "github_file_ref_invalid",
        "The GitHub file reference is invalid or expired.",
    ))
}

fn provider_malformed() -> GitHubReadFailure {
    GitHubReadFailure::Provider(GitHubApiError::Malformed)
}

fn map_input(error: AppError) -> GitHubReadFailure {
    GitHubReadFailure::Input(error)
}

fn checked_number(number: u64) -> Result<u64, GitHubReadFailure> {
    (number > 0).then_some(number).ok_or_else(input_invalid)
}

fn checked_limit(limit: Option<u16>) -> Result<u16, GitHubReadFailure> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT);
    (1..=MAX_LIMIT)
        .contains(&limit)
        .then_some(limit)
        .ok_or_else(input_invalid)
}

fn checked_provider_page_len(raw_len: usize, limit: u16) -> Result<(), GitHubReadFailure> {
    if raw_len > usize::from(limit) {
        return Err(provider_malformed());
    }
    Ok(())
}

fn validate_pull_head_filter(value: Option<&str>) -> Result<Option<String>, GitHubReadFailure> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Some((qualifier, git_ref)) = value.split_once(':') else {
        return Err(input_invalid());
    };
    let qualifier_bytes = qualifier.as_bytes();
    if value.len() > MAX_PULL_HEAD_FILTER_BYTES
        || git_ref.contains(':')
        || qualifier_bytes.is_empty()
        || qualifier_bytes.len() > MAX_HEAD_QUALIFIER_BYTES
        || !qualifier_bytes
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !qualifier_bytes
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !qualifier_bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
    {
        return Err(input_invalid());
    }
    let git_ref = validate_git_ref(Some(git_ref))
        .map_err(map_input)?
        .ok_or_else(input_invalid)?;
    Ok(Some(format!("{qualifier}:{git_ref}")))
}

fn validate_pull_list(request: &PullRequestList) -> Result<ValidatedPullList, GitHubReadFailure> {
    let state = request.state.as_deref().unwrap_or("open");
    if !matches!(state, "open" | "closed" | "all") {
        return Err(input_invalid());
    }
    let query = request
        .query
        .as_deref()
        .map(validate_search_literal)
        .transpose()
        .map_err(map_input)?;
    let base = validate_git_ref(request.base.as_deref()).map_err(map_input)?;
    let head = validate_pull_head_filter(request.head.as_deref())?;
    Ok(ValidatedPullList {
        state: state.to_owned(),
        query,
        base,
        head,
        limit: checked_limit(request.limit)?,
    })
}

fn page_fingerprint(number: u64, limit: u16) -> [u8; 32] {
    filter_fingerprint(&json!({"number": number, "limit": limit}))
}

fn pull_list_fingerprint(request: &ValidatedPullList) -> [u8; 32] {
    filter_fingerprint(&json!({
        "state": request.state,
        "query": request.query,
        "base": request.base,
        "head": request.head,
        "limit": request.limit,
    }))
}

fn resolve_page(
    capabilities: &CapabilityRegistry,
    cursor: Option<&str>,
    operation: &'static str,
    repository_id: &str,
    fingerprint: &[u8; 32],
) -> Result<PagePosition, GitHubReadFailure> {
    let Some(cursor) = cursor else {
        return Ok(PagePosition {
            provider_page: 1,
            raw_offset: 0,
        });
    };
    let scope = capabilities
        .resolve_cursor(cursor, operation, Some(repository_id), fingerprint)
        .map_err(map_input)?;
    if scope.provider_page == 0 || scope.phase.is_some() {
        return Err(input_invalid());
    }
    Ok(PagePosition {
        provider_page: scope.provider_page,
        raw_offset: usize::from(scope.raw_offset),
    })
}

#[allow(clippy::too_many_arguments)] // The cursor contract binds each scope component explicitly.
fn issue_page_cursor(
    capabilities: &CapabilityRegistry,
    operation: &'static str,
    repository_id: &str,
    fingerprint: [u8; 32],
    provider_page: u32,
    raw_offset: usize,
    phase: Option<&str>,
) -> Result<String, GitHubReadFailure> {
    let raw_offset = u16::try_from(raw_offset).map_err(|_| input_invalid())?;
    capabilities
        .issue_cursor(CursorScope {
            operation,
            repository_id: Some(repository_id.to_owned()),
            filter_fingerprint: fingerprint,
            provider_page,
            raw_offset,
            phase: phase.map(str::to_owned),
        })
        .map_err(map_input)
}

fn query_refs(query: &[(String, String)]) -> Vec<(&str, &str)> {
    query
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect()
}

fn guarded(value: &str, max_bytes: usize) -> Result<(String, bool, bool), GitHubReadFailure> {
    let guarded = normalize_untrusted_text(value.as_bytes(), max_bytes, max_bytes.max(1))
        .map_err(map_input)?;
    Ok((guarded.text, guarded.truncated, guarded.redactions_applied))
}

fn guarded_optional(
    value: Option<&str>,
    max_bytes: usize,
) -> Result<(Option<String>, bool, bool), GitHubReadFailure> {
    let Some(value) = value else {
        return Ok((None, false, false));
    };
    let (text, truncated, redacted) = guarded(value, max_bytes)?;
    Ok((Some(text), truncated, redacted))
}

fn validate_sha(value: &str) -> Result<String, GitHubReadFailure> {
    if !(7..=64).contains(&value.len()) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(provider_malformed());
    }
    Ok(value.to_ascii_lowercase())
}

fn validate_provider_repository_name(value: &str) -> Result<String, GitHubReadFailure> {
    if value.is_empty()
        || value.len() > 512
        || value.chars().any(char::is_control)
        || value.split('/').count() != 2
    {
        return Err(provider_malformed());
    }
    Ok(value.to_owned())
}

fn user_value(user: &ProviderUser) -> Result<Value, GitHubReadFailure> {
    let (login, _, _) = guarded(&user.login, 256)?;
    Ok(json!({"id": user.id.to_string(), "login": login}))
}

fn github_url(
    repository: &EligibleGitHubRepository,
    tail: &[&str],
    fragment: Option<&str>,
) -> Result<String, GitHubReadFailure> {
    let mut url = reqwest::Url::parse("https://github.com/").map_err(|_| provider_malformed())?;
    {
        let mut segments = url.path_segments_mut().map_err(|_| provider_malformed())?;
        segments.pop_if_empty();
        segments.push(&repository.owner_login);
        segments.push(&repository.name);
        for segment in tail {
            segments.push(segment);
        }
    }
    url.set_fragment(fragment);
    Ok(url.to_string())
}

fn source(
    repository: &EligibleGitHubRepository,
    url: String,
    object_id: String,
    path: Option<String>,
    git_ref: Option<String>,
) -> GitHubSource {
    GitHubSource {
        repository_id: repository.repository_id.clone(),
        repository_full_name: repository.full_name.clone(),
        url,
        object_id,
        path,
        git_ref,
    }
}

fn select_items(
    items: Vec<NormalizedItem>,
    phase: Option<&str>,
) -> Result<SelectedItems, GitHubReadFailure> {
    let mut values = Vec::new();
    let mut sources = Vec::new();
    let mut redactions_applied = false;
    for item in items {
        let NormalizedItem {
            value,
            source,
            redactions_applied: item_redactions_applied,
        } = item;
        values.push(value);
        sources.push(source);
        let data = if let Some(phase) = phase {
            json!({"phase": phase, "items": &values})
        } else {
            json!({"items": &values})
        };
        let item_source_pairs = json!({
            "data": data,
            "sources": &sources,
        });
        if serde_json::to_vec(&item_source_pairs)
            .map_err(|_| provider_malformed())?
            .len()
            .saturating_add(LIST_FIXED_ENVELOPE_ALLOWANCE)
            > SOFT_DATA_BUDGET
        {
            values.pop();
            sources.pop();
            break;
        }
        redactions_applied |= item_redactions_applied;
    }
    if values.is_empty() && !sources.is_empty() {
        return Err(GitHubReadFailure::Input(AppError::new(
            "github_response_too_large",
            "GitHub content exceeds the response limit.",
        )));
    }
    Ok(SelectedItems {
        accepted: values.len(),
        values,
        sources,
        redactions_applied,
    })
}

#[allow(clippy::too_many_arguments)] // Pagination state stays explicit at this security boundary.
fn list_continuation(
    capabilities: &CapabilityRegistry,
    operation: &'static str,
    repository_id: &str,
    fingerprint: [u8; 32],
    position: PagePosition,
    raw_len: usize,
    accepted: usize,
    limit: u16,
) -> Result<Option<String>, GitHubReadFailure> {
    let consumed = position.raw_offset.saturating_add(accepted);
    if consumed < raw_len {
        return issue_page_cursor(
            capabilities,
            operation,
            repository_id,
            fingerprint,
            position.provider_page,
            consumed,
            None,
        )
        .map(Some);
    }
    if raw_len == usize::from(limit) {
        return issue_page_cursor(
            capabilities,
            operation,
            repository_id,
            fingerprint,
            position.provider_page.saturating_add(1),
            0,
            None,
        )
        .map(Some);
    }
    Ok(None)
}

fn list_finalization_checkpoints(
    operation: &'static str,
    repository: &EligibleGitHubRepository,
    fingerprint: [u8; 32],
    position: PagePosition,
    accepted: usize,
    phase: Option<&str>,
) -> Result<GitHubFinalizationCheckpoints, GitHubReadFailure> {
    let mut resume_after_prefix = Vec::with_capacity(accepted + 1);
    for prefix in 0..=accepted {
        resume_after_prefix.push(CursorScope {
            operation,
            repository_id: Some(repository.repository_id.clone()),
            filter_fingerprint: fingerprint,
            provider_page: position.provider_page,
            raw_offset: u16::try_from(position.raw_offset.saturating_add(prefix))
                .map_err(|_| input_invalid())?,
            phase: phase.map(str::to_owned),
        });
    }
    Ok(GitHubFinalizationCheckpoints::List {
        data_field: "items",
        sources_per_item: true,
        resume_after_prefix,
    })
}

async fn fetch_pull(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    number: u64,
) -> Result<ProviderPull, GitHubReadFailure> {
    client
        .get_json(
            access_token,
            &[
                "repos",
                &repository.owner_login,
                &repository.name,
                "pulls",
                &number.to_string(),
            ],
            &[],
            SINGLETON_RESPONSE_MAX_BYTES,
        )
        .await
        .map_err(GitHubReadFailure::Provider)
}

fn stable_head(
    before: &ProviderPull,
    after: &ProviderPull,
    number: u64,
) -> Result<String, GitHubReadFailure> {
    if before.number != number || after.number != number {
        return Err(provider_malformed());
    }
    let before_sha = validate_sha(&before.head.as_ref().ok_or_else(provider_malformed)?.sha)?;
    let after_sha = validate_sha(&after.head.as_ref().ok_or_else(provider_malformed)?.sha)?;
    if before_sha != after_sha {
        return Err(pull_changed());
    }
    Ok(before_sha)
}

fn normalize_pull(
    repository: &EligibleGitHubRepository,
    pull: ProviderPull,
) -> Result<NormalizedItem, GitHubReadFailure> {
    if pull.number == 0 || !matches!(pull.state.as_str(), "open" | "closed") {
        return Err(provider_malformed());
    }
    if pull
        .base
        .as_ref()
        .and_then(|base| base.repo.as_ref())
        .is_some_and(|repo| repo.full_name != repository.full_name)
        || pull.base.as_ref().is_some_and(|base| base.repo.is_none())
    {
        return Err(provider_malformed());
    }
    let head_sha = pull
        .head
        .as_ref()
        .map(|head| validate_sha(&head.sha))
        .transpose()?;
    let base_sha = pull
        .base
        .as_ref()
        .map(|base| validate_sha(&base.sha))
        .transpose()?;
    let head_ref = pull
        .head
        .as_ref()
        .map(|head| {
            validate_git_ref(Some(&head.git_ref))
                .map_err(|_| provider_malformed())?
                .ok_or_else(provider_malformed)
        })
        .transpose()?;
    let base_ref = pull
        .base
        .as_ref()
        .map(|base| {
            validate_git_ref(Some(&base.git_ref))
                .map_err(|_| provider_malformed())?
                .ok_or_else(provider_malformed)
        })
        .transpose()?;
    let (title, title_truncated, title_redacted) = guarded(&pull.title, INLINE_TEXT_MAX_BYTES)?;
    let (body, body_truncated, body_redacted) =
        guarded_optional(pull.body.as_deref(), PULL_BODY_MAX_BYTES)?;
    let (head_label, head_label_redacted) = pull
        .head
        .as_ref()
        .map(|head| guarded(&head.label, 512).map(|(value, _, redacted)| (Some(value), redacted)))
        .transpose()?
        .unwrap_or((None, false));
    let (base_label, base_label_redacted) = pull
        .base
        .as_ref()
        .map(|base| guarded(&base.label, 512).map(|(value, _, redacted)| (Some(value), redacted)))
        .transpose()?
        .unwrap_or((None, false));
    let head_repository = pull
        .head
        .as_ref()
        .and_then(|head| head.repo.as_ref())
        .map(|repo| validate_provider_repository_name(&repo.full_name))
        .transpose()?;
    let base_repository = pull
        .base
        .as_ref()
        .and_then(|base| base.repo.as_ref())
        .map(|repo| validate_provider_repository_name(&repo.full_name))
        .transpose()?;
    let number = pull.number;
    let url = github_url(repository, &["pull", &number.to_string()], None)?;
    let value = json!({
        "id": pull.id.to_string(),
        "number": number,
        "title": title,
        "titleTruncated": title_truncated,
        "state": pull.state,
        "draft": pull.draft,
        "body": body,
        "bodyTruncated": body_truncated,
        "author": user_value(&pull.user)?,
        "createdAt": pull.created_at,
        "updatedAt": pull.updated_at,
        "closedAt": pull.closed_at,
        "mergedAt": pull.merged_at,
        "mergeableState": pull.mergeable_state,
        "changedFiles": pull.changed_files,
        "commitCount": pull.commits,
        "additions": pull.additions,
        "deletions": pull.deletions,
        "commentCount": pull.comments,
        "reviewCommentCount": pull.review_comments,
        "head": {"label": head_label, "ref": head_ref, "sha": head_sha.clone(), "repositoryFullName": head_repository},
        "base": {"label": base_label, "ref": base_ref, "sha": base_sha, "repositoryFullName": base_repository},
    });
    Ok(NormalizedItem {
        value,
        source: source(repository, url, pull.id.to_string(), None, head_sha),
        redactions_applied: title_redacted
            || body_redacted
            || head_label_redacted
            || base_label_redacted,
    })
}

#[allow(dead_code)] // Task 8 dispatches this staged endpoint.
pub(crate) async fn list_pull_requests(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    request: PullRequestList,
    capabilities: &CapabilityRegistry,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    let validated = validate_pull_list(&request)?;
    let fingerprint = pull_list_fingerprint(&validated);
    let position = resolve_page(
        capabilities,
        request.cursor.as_deref(),
        "list_pull_requests",
        &repository.repository_id,
        &fingerprint,
    )?;
    let mut query = Vec::<(String, String)>::new();
    let pulls = if let Some(search) = validated.query.as_deref() {
        let mut scoped = format!(
            "{search} repo:{}/{} is:pr",
            repository.owner_login, repository.name
        );
        if validated.state != "all" {
            scoped.push_str(" is:");
            scoped.push_str(&validated.state);
        }
        if let Some(base) = validated.base.as_deref() {
            scoped.push_str(" base:");
            scoped.push_str(base);
        }
        if let Some(head) = validated.head.as_deref() {
            scoped.push_str(" head:");
            scoped.push_str(
                head.split_once(':')
                    .map(|(_, git_ref)| git_ref)
                    .ok_or_else(input_invalid)?,
            );
        }
        query.push(("q".to_owned(), scoped));
        query.push(("per_page".to_owned(), validated.limit.to_string()));
        query.push(("page".to_owned(), position.provider_page.to_string()));
        let refs = query_refs(&query);
        let response: ProviderPullSearch = client
            .get_json(
                access_token,
                &["search", "issues"],
                &refs,
                LIST_RESPONSE_MAX_BYTES,
            )
            .await
            .map_err(GitHubReadFailure::Provider)?;
        let expected_repository_url = format!(
            "https://api.github.com/repos/{}/{}",
            repository.owner_login, repository.name
        );
        if response.items.iter().any(|pull| {
            pull.repository_url.as_deref() != Some(expected_repository_url.as_str())
                || pull.pull_request.is_none()
        }) {
            return Err(provider_malformed());
        }
        response.items
    } else {
        query.push(("state".to_owned(), validated.state.clone()));
        if let Some(base) = validated.base.as_ref() {
            query.push(("base".to_owned(), base.clone()));
        }
        if let Some(head) = validated.head.as_ref() {
            query.push(("head".to_owned(), head.clone()));
        }
        query.push(("per_page".to_owned(), validated.limit.to_string()));
        query.push(("page".to_owned(), position.provider_page.to_string()));
        let refs = query_refs(&query);
        client
            .get_json(
                access_token,
                &["repos", &repository.owner_login, &repository.name, "pulls"],
                &refs,
                LIST_RESPONSE_MAX_BYTES,
            )
            .await
            .map_err(GitHubReadFailure::Provider)?
    };
    let raw_len = pulls.len();
    checked_provider_page_len(raw_len, validated.limit)?;
    if position.raw_offset > raw_len {
        return Err(input_invalid());
    }
    let normalized = pulls
        .into_iter()
        .skip(position.raw_offset)
        .map(|pull| normalize_pull(repository, pull))
        .collect::<Result<Vec<_>, _>>()?;
    let selected = select_items(normalized, None)?;
    if selected.accepted == 0 && position.raw_offset < raw_len {
        return Err(GitHubReadFailure::Input(AppError::new(
            "github_response_too_large",
            "GitHub content exceeds the response limit.",
        )));
    }
    let continuation_cursor = list_continuation(
        capabilities,
        "list_pull_requests",
        &repository.repository_id,
        fingerprint,
        position,
        raw_len,
        selected.accepted,
        validated.limit,
    )?;
    Ok(GitHubOperationOutput {
        data: json!({"items": selected.values}),
        truncated: continuation_cursor.is_some(),
        continuation_cursor,
        redactions_applied: selected.redactions_applied,
        sources: selected.sources,
        finalization_checkpoints: Some(list_finalization_checkpoints(
            "list_pull_requests",
            repository,
            fingerprint,
            position,
            selected.accepted,
            None,
        )?),
    })
}

#[allow(dead_code)] // Task 8 dispatches this staged endpoint.
pub(crate) async fn get_pull_request(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    number: u64,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    let number = checked_number(number)?;
    let pull = fetch_pull(client, access_token, repository, number).await?;
    if pull.number != number || pull.head.is_none() || pull.base.is_none() {
        return Err(provider_malformed());
    }
    let normalized = normalize_pull(repository, pull)?;
    if serde_json::to_vec(&normalized.value)
        .map_err(|_| provider_malformed())?
        .len()
        > SOFT_DATA_BUDGET
    {
        return Err(GitHubReadFailure::Input(AppError::new(
            "github_response_too_large",
            "GitHub content exceeds the response limit.",
        )));
    }
    Ok(GitHubOperationOutput {
        data: normalized.value,
        truncated: false,
        continuation_cursor: None,
        redactions_applied: normalized.redactions_applied,
        sources: vec![normalized.source],
        finalization_checkpoints: None,
    })
}

fn normalize_pull_file(
    repository: &EligibleGitHubRepository,
    number: u64,
    head_sha: &str,
    absolute_index: usize,
    file: ProviderPullFile,
    capabilities: &CapabilityRegistry,
) -> Result<NormalizedItem, GitHubReadFailure> {
    if absolute_index >= MAX_PROVIDER_FILES {
        return Err(input_invalid());
    }
    let path = validate_repository_path(&file.filename, false).map_err(map_input)?;
    let previous_path = file
        .previous_filename
        .as_deref()
        .map(|path| validate_repository_path(path, false))
        .transpose()
        .map_err(map_input)?;
    let sha = validate_sha(&file.sha)?;
    if !matches!(
        file.status.as_str(),
        "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged"
    ) {
        return Err(provider_malformed());
    }
    let file_ref = capabilities
        .issue_pull_file(PullFileScope {
            repository_id: repository.repository_id.clone(),
            pull_number: number,
            head_sha: head_sha.to_owned(),
            absolute_index: u16::try_from(absolute_index).map_err(|_| input_invalid())?,
            expected_path: path.clone(),
        })
        .map_err(map_input)?;
    let url = github_url(repository, &["pull", &number.to_string(), "files"], None)?;
    Ok(NormalizedItem {
        value: json!({
            "sha": sha,
            "filename": path.clone(),
            "previousFilename": previous_path,
            "status": file.status,
            "additions": file.additions,
            "deletions": file.deletions,
            "changes": file.changes,
            "fileRef": file_ref,
        }),
        source: source(
            repository,
            url,
            format!("{number}:{absolute_index}"),
            Some(path),
            Some(head_sha.to_owned()),
        ),
        redactions_applied: false,
    })
}

#[allow(dead_code)] // Task 8 dispatches this staged endpoint.
pub(crate) async fn list_pull_request_files(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    request: PullRequestPage,
    capabilities: &CapabilityRegistry,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    let number = checked_number(request.number)?;
    let limit = checked_limit(request.limit)?;
    let fingerprint = page_fingerprint(number, limit);
    let position = resolve_page(
        capabilities,
        request.cursor.as_deref(),
        "list_pull_request_files",
        &repository.repository_id,
        &fingerprint,
    )?;
    let page_start = usize::try_from(position.provider_page.saturating_sub(1))
        .map_err(|_| input_invalid())?
        .checked_mul(usize::from(limit))
        .ok_or_else(input_invalid)?;
    if page_start >= MAX_PROVIDER_FILES {
        return Err(input_invalid());
    }
    let before = fetch_pull(client, access_token, repository, number).await?;
    let query = vec![
        ("per_page".to_owned(), limit.to_string()),
        ("page".to_owned(), position.provider_page.to_string()),
    ];
    let refs = query_refs(&query);
    let files: Vec<ProviderPullFile> = client
        .get_json(
            access_token,
            &[
                "repos",
                &repository.owner_login,
                &repository.name,
                "pulls",
                &number.to_string(),
                "files",
            ],
            &refs,
            LIST_RESPONSE_MAX_BYTES,
        )
        .await
        .map_err(GitHubReadFailure::Provider)?;
    let after = fetch_pull(client, access_token, repository, number).await?;
    let head_sha = stable_head(&before, &after, number)?;
    let provider_file_limit_reached = before.changed_files > MAX_PROVIDER_FILES as u64;
    let raw_len = files.len();
    checked_provider_page_len(raw_len, limit)?;
    if position.raw_offset > raw_len {
        return Err(input_invalid());
    }
    let normalized = files
        .into_iter()
        .enumerate()
        .skip(position.raw_offset)
        .map(|(index, file)| {
            normalize_pull_file(
                repository,
                number,
                &head_sha,
                page_start.saturating_add(index),
                file,
                capabilities,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let selected = select_items(normalized, None)?;
    if selected.accepted == 0 && position.raw_offset < raw_len {
        return Err(GitHubReadFailure::Input(AppError::new(
            "github_response_too_large",
            "GitHub content exceeds the response limit.",
        )));
    }
    let consumed = position.raw_offset.saturating_add(selected.accepted);
    let at_provider_ceiling = page_start.saturating_add(consumed) >= MAX_PROVIDER_FILES;
    let continuation_cursor = if at_provider_ceiling {
        None
    } else {
        list_continuation(
            capabilities,
            "list_pull_request_files",
            &repository.repository_id,
            fingerprint,
            position,
            raw_len,
            selected.accepted,
            limit,
        )?
    };
    Ok(GitHubOperationOutput {
        data: json!({
            "pullNumber": number,
            "headSha": head_sha,
            "providerFileLimitReached": provider_file_limit_reached,
            "items": selected.values,
        }),
        truncated: continuation_cursor.is_some() || provider_file_limit_reached,
        continuation_cursor,
        redactions_applied: selected.redactions_applied,
        sources: selected.sources,
        finalization_checkpoints: Some(list_finalization_checkpoints(
            "list_pull_request_files",
            repository,
            fingerprint,
            position,
            selected.accepted,
            None,
        )?),
    })
}

fn patch_fingerprint(number: u64, file_ref: &str, scope: &PullFileScope, patch: &str) -> [u8; 32] {
    filter_fingerprint(&json!({
        "number": number,
        "fileRef": file_ref,
        "headSha": scope.head_sha,
        "path": scope.expected_path,
        "patch": patch,
    }))
}

fn patch_line_end(patch: &str, start: usize) -> usize {
    let mut end = start;
    for (lines, segment) in patch[start..].split_inclusive('\n').enumerate() {
        if lines >= PATCH_MAX_LINES {
            break;
        }
        let next = end.saturating_add(segment.len());
        if next.saturating_sub(start) > PATCH_MAX_BYTES {
            break;
        }
        end = next;
    }
    if end == start && start < patch.len() {
        end = (start + PATCH_MAX_BYTES).min(patch.len());
        while end > start && !patch.is_char_boundary(end) {
            end -= 1;
        }
    }
    end
}

fn patch_window(patch: &str, start: usize) -> Result<(String, usize, bool), GitHubReadFailure> {
    if start > patch.len() || !patch.is_char_boundary(start) {
        return Err(input_invalid());
    }
    if start == patch.len() {
        return Ok((String::new(), start, false));
    }
    let mut end = patch_line_end(patch, start);
    loop {
        if end <= start {
            return Err(GitHubReadFailure::Input(AppError::new(
                "github_response_too_large",
                "GitHub content exceeds the response limit.",
            )));
        }
        let guarded = normalize_untrusted_text(
            &patch.as_bytes()[start..end],
            PATCH_MAX_BYTES,
            PATCH_MAX_LINES,
        )
        .map_err(map_input)?;
        if !guarded.truncated {
            return Ok((guarded.text, end, guarded.redactions_applied));
        }
        let candidate = start + (end - start) / 2;
        end = candidate;
        while end > start && !patch.is_char_boundary(end) {
            end -= 1;
        }
    }
}

fn patch_finalization_checkpoints(
    repository: &EligibleGitHubRepository,
    fingerprint: [u8; 32],
    patch: &str,
    window: &str,
    start: usize,
    end: usize,
) -> Result<GitHubFinalizationCheckpoints, GitHubReadFailure> {
    let base_scope = |provider_page: usize| -> Result<CursorScope, GitHubReadFailure> {
        Ok(CursorScope {
            operation: "read_pull_request_file_diff",
            repository_id: Some(repository.repository_id.clone()),
            filter_fingerprint: fingerprint,
            provider_page: u32::try_from(provider_page).map_err(|_| input_invalid())?,
            raw_offset: 0,
            phase: Some("patch".to_owned()),
        })
    };
    let mut resume_after_prefix = vec![GitHubPatchCheckpoint {
        output_prefix_bytes: 0,
        resume: base_scope(start)?,
    }];
    let provider_lines = patch[start..end].split_inclusive('\n').collect::<Vec<_>>();
    let output_lines = window.split_inclusive('\n').collect::<Vec<_>>();
    if provider_lines.len() != output_lines.len() {
        return Err(provider_malformed());
    }
    let mut provider_prefix = 0_usize;
    let mut output_prefix = 0_usize;
    for (provider_line, output_line) in provider_lines.into_iter().zip(output_lines) {
        provider_prefix = provider_prefix.saturating_add(provider_line.len());
        output_prefix = output_prefix.saturating_add(output_line.len());
        let absolute_provider_end = start.saturating_add(provider_prefix);
        if provider_line.ends_with('\n') || absolute_provider_end == patch.len() {
            resume_after_prefix.push(GitHubPatchCheckpoint {
                output_prefix_bytes: output_prefix,
                resume: base_scope(absolute_provider_end)?,
            });
        }
    }
    Ok(GitHubFinalizationCheckpoints::Patch {
        resume_after_prefix,
    })
}

#[allow(clippy::too_many_arguments)] // Patch state and its source binding are finalized together.
fn patch_output(
    repository: &EligibleGitHubRepository,
    number: u64,
    head_sha: &str,
    path: &str,
    previous_path: Option<String>,
    patch_state: &str,
    patch: Option<String>,
    continuation_cursor: Option<String>,
    redactions_applied: bool,
    finalization_checkpoints: Option<GitHubFinalizationCheckpoints>,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    let url = github_url(repository, &["pull", &number.to_string(), "files"], None)?;
    let truncated = continuation_cursor.is_some();
    Ok(GitHubOperationOutput {
        data: json!({
            "pullNumber": number,
            "headSha": head_sha,
            "path": path,
            "previousFilename": previous_path,
            "patchState": patch_state,
            "patch": patch,
            "patchTruncated": truncated,
        }),
        truncated,
        continuation_cursor,
        redactions_applied,
        sources: vec![source(
            repository,
            url,
            format!("{number}:{path}"),
            Some(path.to_owned()),
            Some(head_sha.to_owned()),
        )],
        finalization_checkpoints,
    })
}

#[allow(dead_code)] // Task 8 dispatches this staged endpoint.
pub(crate) async fn read_pull_request_file_diff(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    request: PullRequestFileDiff,
    capabilities: &CapabilityRegistry,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    let number = checked_number(request.number)?;
    if request.file_ref.len() != 32
        || !request
            .file_ref
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(file_ref_invalid());
    }
    let before = fetch_pull(client, access_token, repository, number).await?;
    if before.number != number {
        return Err(provider_malformed());
    }
    let before_head = validate_sha(&before.head.as_ref().ok_or_else(provider_malformed)?.sha)?;
    let scope = capabilities
        .resolve_pull_file(
            &request.file_ref,
            &repository.repository_id,
            number,
            &before_head,
        )
        .map_err(map_input)?;
    let query = vec![
        ("per_page".to_owned(), "1".to_owned()),
        (
            "page".to_owned(),
            (u32::from(scope.absolute_index) + 1).to_string(),
        ),
    ];
    let refs = query_refs(&query);
    let file_result: Result<Vec<ProviderPullFile>, GitHubApiError> = client
        .get_json(
            access_token,
            &[
                "repos",
                &repository.owner_login,
                &repository.name,
                "pulls",
                &number.to_string(),
                "files",
            ],
            &refs,
            FILE_RESPONSE_MAX_BYTES,
        )
        .await;
    let after = fetch_pull(client, access_token, repository, number).await?;
    let stable_head = stable_head(&before, &after, number)?;
    if stable_head != scope.head_sha {
        return Err(pull_changed());
    }
    let files = match file_result {
        Ok(files) => files,
        Err(GitHubApiError::ResponseTooLarge) => {
            return patch_output(
                repository,
                number,
                &stable_head,
                &scope.expected_path,
                None,
                "response_too_large",
                None,
                None,
                false,
                None,
            );
        }
        Err(error) => return Err(GitHubReadFailure::Provider(error)),
    };
    if files.len() != 1 {
        return Err(provider_malformed());
    }
    let file = files.into_iter().next().ok_or_else(provider_malformed)?;
    let path = validate_repository_path(&file.filename, false).map_err(map_input)?;
    scope.validate_expected_path(&path).map_err(map_input)?;
    let previous_path = file
        .previous_filename
        .as_deref()
        .map(|path| validate_repository_path(path, false))
        .transpose()
        .map_err(map_input)?;
    let Some(patch) = file.patch else {
        return patch_output(
            repository,
            number,
            &stable_head,
            &path,
            previous_path,
            "unavailable",
            None,
            None,
            false,
            None,
        );
    };
    let fingerprint = patch_fingerprint(number, &request.file_ref, &scope, &patch);
    let start = if let Some(cursor) = request.cursor.as_deref() {
        let cursor = capabilities
            .resolve_cursor(
                cursor,
                "read_pull_request_file_diff",
                Some(&repository.repository_id),
                &fingerprint,
            )
            .map_err(map_input)?;
        if cursor.phase.as_deref() != Some("patch") || cursor.raw_offset != 0 {
            return Err(input_invalid());
        }
        usize::try_from(cursor.provider_page).map_err(|_| input_invalid())?
    } else {
        0
    };
    let (window, end, redactions_applied) = patch_window(&patch, start)?;
    let continuation_cursor = if end < patch.len() {
        Some(issue_page_cursor(
            capabilities,
            "read_pull_request_file_diff",
            &repository.repository_id,
            fingerprint,
            u32::try_from(end).map_err(|_| input_invalid())?,
            0,
            Some("patch"),
        )?)
    } else {
        None
    };
    let finalization_checkpoints =
        patch_finalization_checkpoints(repository, fingerprint, &patch, &window, start, end)?;
    patch_output(
        repository,
        number,
        &stable_head,
        &path,
        previous_path,
        "provider_supplied",
        Some(window),
        continuation_cursor,
        redactions_applied,
        Some(finalization_checkpoints),
    )
}

#[allow(clippy::too_many_arguments)] // The fixed endpoint page scope is intentionally explicit.
fn finish_paged_items(
    capabilities: &CapabilityRegistry,
    operation: &'static str,
    repository: &EligibleGitHubRepository,
    fingerprint: [u8; 32],
    position: PagePosition,
    raw_len: usize,
    limit: u16,
    normalized: Vec<NormalizedItem>,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    let selected = select_items(normalized, None)?;
    if selected.accepted == 0 && position.raw_offset < raw_len {
        return Err(GitHubReadFailure::Input(AppError::new(
            "github_response_too_large",
            "GitHub content exceeds the response limit.",
        )));
    }
    let continuation_cursor = list_continuation(
        capabilities,
        operation,
        &repository.repository_id,
        fingerprint,
        position,
        raw_len,
        selected.accepted,
        limit,
    )?;
    Ok(GitHubOperationOutput {
        data: json!({"items": selected.values}),
        truncated: continuation_cursor.is_some(),
        continuation_cursor,
        redactions_applied: selected.redactions_applied,
        sources: selected.sources,
        finalization_checkpoints: Some(list_finalization_checkpoints(
            operation,
            repository,
            fingerprint,
            position,
            selected.accepted,
            None,
        )?),
    })
}

fn normalize_commit(
    repository: &EligibleGitHubRepository,
    commit: ProviderCommit,
) -> Result<NormalizedItem, GitHubReadFailure> {
    let sha = validate_sha(&commit.sha)?;
    let (message, message_truncated, redactions_applied) =
        guarded(&commit.commit.message, COMMIT_MESSAGE_MAX_BYTES)?;
    let (author_identity, author_identity_redacted) = commit
        .commit
        .author
        .map(|identity| {
            guarded(&identity.name, 512).map(|(name, _, redacted)| {
                (Some(json!({"name": name, "date": identity.date})), redacted)
            })
        })
        .transpose()?
        .unwrap_or((None, false));
    let (committer_identity, committer_identity_redacted) = commit
        .commit
        .committer
        .map(|identity| {
            guarded(&identity.name, 512).map(|(name, _, redacted)| {
                (Some(json!({"name": name, "date": identity.date})), redacted)
            })
        })
        .transpose()?
        .unwrap_or((None, false));
    let author = commit.author.as_ref().map(user_value).transpose()?;
    let committer = commit.committer.as_ref().map(user_value).transpose()?;
    let url = github_url(repository, &["commit", &sha], None)?;
    Ok(NormalizedItem {
        value: json!({
            "sha": sha.clone(),
            "message": message,
            "messageTruncated": message_truncated,
            "authorIdentity": author_identity,
            "committerIdentity": committer_identity,
            "author": author,
            "committer": committer,
        }),
        source: source(repository, url, sha.clone(), None, Some(sha)),
        redactions_applied: redactions_applied
            || author_identity_redacted
            || committer_identity_redacted,
    })
}

#[allow(dead_code)] // Task 8 dispatches this staged endpoint.
pub(crate) async fn list_pull_request_commits(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    request: PullRequestPage,
    capabilities: &CapabilityRegistry,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    let number = checked_number(request.number)?;
    let limit = checked_limit(request.limit)?;
    let fingerprint = page_fingerprint(number, limit);
    let position = resolve_page(
        capabilities,
        request.cursor.as_deref(),
        "list_pull_request_commits",
        &repository.repository_id,
        &fingerprint,
    )?;
    let query = vec![
        ("per_page".to_owned(), limit.to_string()),
        ("page".to_owned(), position.provider_page.to_string()),
    ];
    let refs = query_refs(&query);
    let commits: Vec<ProviderCommit> = client
        .get_json(
            access_token,
            &[
                "repos",
                &repository.owner_login,
                &repository.name,
                "pulls",
                &number.to_string(),
                "commits",
            ],
            &refs,
            LIST_RESPONSE_MAX_BYTES,
        )
        .await
        .map_err(GitHubReadFailure::Provider)?;
    let raw_len = commits.len();
    checked_provider_page_len(raw_len, limit)?;
    if position.raw_offset > raw_len {
        return Err(input_invalid());
    }
    let normalized = commits
        .into_iter()
        .skip(position.raw_offset)
        .map(|commit| normalize_commit(repository, commit))
        .collect::<Result<Vec<_>, _>>()?;
    finish_paged_items(
        capabilities,
        "list_pull_request_commits",
        repository,
        fingerprint,
        position,
        raw_len,
        limit,
        normalized,
    )
}

fn normalize_review(
    repository: &EligibleGitHubRepository,
    number: u64,
    review: ProviderReview,
) -> Result<NormalizedItem, GitHubReadFailure> {
    let (body, body_truncated, redactions_applied) =
        guarded_optional(review.body.as_deref(), COLLABORATION_BODY_MAX_BYTES)?;
    let (state, _, state_redacted) = guarded(&review.state, 128)?;
    let commit_id = review.commit_id.as_deref().map(validate_sha).transpose()?;
    let fragment = format!("pullrequestreview-{}", review.id);
    let url = github_url(
        repository,
        &["pull", &number.to_string(), "files"],
        Some(&fragment),
    )?;
    Ok(NormalizedItem {
        value: json!({
            "id": review.id.to_string(),
            "author": user_value(&review.user)?,
            "body": body,
            "bodyTruncated": body_truncated,
            "state": state,
            "submittedAt": review.submitted_at,
            "commitId": commit_id.clone(),
        }),
        source: source(repository, url, review.id.to_string(), None, commit_id),
        redactions_applied: redactions_applied || state_redacted,
    })
}

#[allow(dead_code)] // Task 8 dispatches this staged endpoint.
pub(crate) async fn list_pull_request_reviews(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    request: PullRequestPage,
    capabilities: &CapabilityRegistry,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    let number = checked_number(request.number)?;
    let limit = checked_limit(request.limit)?;
    let fingerprint = page_fingerprint(number, limit);
    let position = resolve_page(
        capabilities,
        request.cursor.as_deref(),
        "list_pull_request_reviews",
        &repository.repository_id,
        &fingerprint,
    )?;
    let query = vec![
        ("per_page".to_owned(), limit.to_string()),
        ("page".to_owned(), position.provider_page.to_string()),
    ];
    let refs = query_refs(&query);
    let reviews: Vec<ProviderReview> = client
        .get_json(
            access_token,
            &[
                "repos",
                &repository.owner_login,
                &repository.name,
                "pulls",
                &number.to_string(),
                "reviews",
            ],
            &refs,
            LIST_RESPONSE_MAX_BYTES,
        )
        .await
        .map_err(GitHubReadFailure::Provider)?;
    let raw_len = reviews.len();
    checked_provider_page_len(raw_len, limit)?;
    if position.raw_offset > raw_len {
        return Err(input_invalid());
    }
    let normalized = reviews
        .into_iter()
        .skip(position.raw_offset)
        .map(|review| normalize_review(repository, number, review))
        .collect::<Result<Vec<_>, _>>()?;
    finish_paged_items(
        capabilities,
        "list_pull_request_reviews",
        repository,
        fingerprint,
        position,
        raw_len,
        limit,
        normalized,
    )
}

fn normalize_review_comment(
    repository: &EligibleGitHubRepository,
    number: u64,
    comment: ProviderReviewComment,
) -> Result<NormalizedItem, GitHubReadFailure> {
    let path = validate_repository_path(&comment.path, false).map_err(map_input)?;
    let commit_id = validate_sha(&comment.commit_id)?;
    let original_commit_id = validate_sha(&comment.original_commit_id)?;
    let (body, body_truncated, redactions_applied) =
        guarded(&comment.body, COLLABORATION_BODY_MAX_BYTES)?;
    let fragment = format!("discussion_r{}", comment.id);
    let url = github_url(
        repository,
        &["pull", &number.to_string(), "files"],
        Some(&fragment),
    )?;
    Ok(NormalizedItem {
        value: json!({
            "id": comment.id.to_string(),
            "author": user_value(&comment.user)?,
            "body": body,
            "bodyTruncated": body_truncated,
            "path": path.clone(),
            "line": comment.line,
            "side": comment.side,
            "startLine": comment.start_line,
            "startSide": comment.start_side,
            "commitId": commit_id.clone(),
            "originalCommitId": original_commit_id,
            "createdAt": comment.created_at,
            "updatedAt": comment.updated_at,
        }),
        source: source(
            repository,
            url,
            comment.id.to_string(),
            Some(path),
            Some(commit_id),
        ),
        redactions_applied,
    })
}

#[allow(dead_code)] // Task 8 dispatches this staged endpoint.
pub(crate) async fn list_pull_request_review_comments(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    request: PullRequestPage,
    capabilities: &CapabilityRegistry,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    let number = checked_number(request.number)?;
    let limit = checked_limit(request.limit)?;
    let fingerprint = page_fingerprint(number, limit);
    let position = resolve_page(
        capabilities,
        request.cursor.as_deref(),
        "list_pull_request_review_comments",
        &repository.repository_id,
        &fingerprint,
    )?;
    let query = vec![
        ("per_page".to_owned(), limit.to_string()),
        ("page".to_owned(), position.provider_page.to_string()),
    ];
    let refs = query_refs(&query);
    let comments: Vec<ProviderReviewComment> = client
        .get_json(
            access_token,
            &[
                "repos",
                &repository.owner_login,
                &repository.name,
                "pulls",
                &number.to_string(),
                "comments",
            ],
            &refs,
            LIST_RESPONSE_MAX_BYTES,
        )
        .await
        .map_err(GitHubReadFailure::Provider)?;
    let raw_len = comments.len();
    checked_provider_page_len(raw_len, limit)?;
    if position.raw_offset > raw_len {
        return Err(input_invalid());
    }
    let normalized = comments
        .into_iter()
        .skip(position.raw_offset)
        .map(|comment| normalize_review_comment(repository, number, comment))
        .collect::<Result<Vec<_>, _>>()?;
    finish_paged_items(
        capabilities,
        "list_pull_request_review_comments",
        repository,
        fingerprint,
        position,
        raw_len,
        limit,
        normalized,
    )
}

fn checks_fingerprint(number: u64, limit: u16, head_sha: &str) -> [u8; 32] {
    filter_fingerprint(&json!({
        "number": number,
        "limit": limit,
        "headSha": head_sha,
    }))
}

fn normalize_check_run(
    repository: &EligibleGitHubRepository,
    head_sha: &str,
    check: ProviderCheckRun,
) -> Result<NormalizedItem, GitHubReadFailure> {
    if validate_sha(&check.head_sha)? != head_sha {
        return Err(pull_changed());
    }
    let (name, _, name_redacted) = guarded(&check.name, INLINE_TEXT_MAX_BYTES)?;
    let (title, title_truncated, title_redacted) =
        guarded_optional(check.output.title.as_deref(), INLINE_TEXT_MAX_BYTES)?;
    let (summary, summary_truncated, summary_redacted) =
        guarded_optional(check.output.summary.as_deref(), 6 * 1024)?;
    let (text, text_truncated, text_redacted) =
        guarded_optional(check.output.text.as_deref(), 6 * 1024)?;
    let (app, app_redacted) = check
        .app
        .map(|app| {
            guarded(&app.name, 512).map(|(name, _, redacted)| {
                (
                    Some(json!({"id": app.id.to_string(), "name": name})),
                    redacted,
                )
            })
        })
        .transpose()?
        .unwrap_or((None, false));
    let url = github_url(repository, &["commit", head_sha, "checks"], None)?;
    Ok(NormalizedItem {
        value: json!({
            "id": check.id.to_string(),
            "name": name,
            "headSha": head_sha,
            "status": check.status,
            "conclusion": check.conclusion,
            "startedAt": check.started_at,
            "completedAt": check.completed_at,
            "app": app,
            "output": {
                "title": title,
                "titleTruncated": title_truncated,
                "summary": summary,
                "summaryTruncated": summary_truncated,
                "text": text,
                "textTruncated": text_truncated,
            },
        }),
        source: source(
            repository,
            url,
            check.id.to_string(),
            None,
            Some(head_sha.to_owned()),
        ),
        redactions_applied: name_redacted
            || title_redacted
            || summary_redacted
            || text_redacted
            || app_redacted,
    })
}

fn normalize_status(
    repository: &EligibleGitHubRepository,
    head_sha: &str,
    status: ProviderStatus,
) -> Result<NormalizedItem, GitHubReadFailure> {
    let (context, _, context_redacted) = guarded(&status.context, INLINE_TEXT_MAX_BYTES)?;
    let (description, description_truncated, description_redacted) =
        guarded_optional(status.description.as_deref(), COLLABORATION_BODY_MAX_BYTES)?;
    let creator = status.creator.as_ref().map(user_value).transpose()?;
    let url = github_url(repository, &["commit", head_sha, "checks"], None)?;
    Ok(NormalizedItem {
        value: json!({
            "id": status.id.to_string(),
            "state": status.state,
            "context": context,
            "description": description,
            "descriptionTruncated": description_truncated,
            "createdAt": status.created_at,
            "updatedAt": status.updated_at,
            "creator": creator,
        }),
        source: source(
            repository,
            url,
            status.id.to_string(),
            None,
            Some(head_sha.to_owned()),
        ),
        redactions_applied: context_redacted || description_redacted,
    })
}

#[allow(clippy::too_many_arguments)] // Check-run/status phases share one bound cursor contract.
fn phase_continuation(
    capabilities: &CapabilityRegistry,
    repository: &EligibleGitHubRepository,
    fingerprint: [u8; 32],
    phase: &str,
    position: PagePosition,
    raw_len: usize,
    accepted: usize,
    limit: u16,
) -> Result<Option<String>, GitHubReadFailure> {
    let consumed = position.raw_offset.saturating_add(accepted);
    if consumed < raw_len {
        return issue_page_cursor(
            capabilities,
            "list_pull_request_checks",
            &repository.repository_id,
            fingerprint,
            position.provider_page,
            consumed,
            Some(phase),
        )
        .map(Some);
    }
    if raw_len == usize::from(limit) {
        return issue_page_cursor(
            capabilities,
            "list_pull_request_checks",
            &repository.repository_id,
            fingerprint,
            position.provider_page.saturating_add(1),
            0,
            Some(phase),
        )
        .map(Some);
    }
    if phase == "check_runs" {
        return issue_page_cursor(
            capabilities,
            "list_pull_request_checks",
            &repository.repository_id,
            fingerprint,
            1,
            0,
            Some("statuses"),
        )
        .map(Some);
    }
    Ok(None)
}

#[allow(dead_code)] // Task 8 dispatches this staged endpoint.
pub(crate) async fn list_pull_request_checks(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    request: PullRequestPage,
    capabilities: &CapabilityRegistry,
) -> Result<GitHubOperationOutput, GitHubReadFailure> {
    let number = checked_number(request.number)?;
    let limit = checked_limit(request.limit)?;
    let before = fetch_pull(client, access_token, repository, number).await?;
    if before.number != number {
        return Err(provider_malformed());
    }
    let head_sha = validate_sha(&before.head.as_ref().ok_or_else(provider_malformed)?.sha)?;
    let fingerprint = checks_fingerprint(number, limit, &head_sha);
    let (phase, position) = if let Some(cursor) = request.cursor.as_deref() {
        let scope = capabilities
            .resolve_cursor(
                cursor,
                "list_pull_request_checks",
                Some(&repository.repository_id),
                &fingerprint,
            )
            .map_err(map_input)?;
        let phase = scope.phase.ok_or_else(input_invalid)?;
        if scope.provider_page == 0 || !matches!(phase.as_str(), "check_runs" | "statuses") {
            return Err(input_invalid());
        }
        (
            phase,
            PagePosition {
                provider_page: scope.provider_page,
                raw_offset: usize::from(scope.raw_offset),
            },
        )
    } else {
        (
            "check_runs".to_owned(),
            PagePosition {
                provider_page: 1,
                raw_offset: 0,
            },
        )
    };
    let query = vec![
        ("per_page".to_owned(), limit.to_string()),
        ("page".to_owned(), position.provider_page.to_string()),
    ];
    let refs = query_refs(&query);
    let (raw_len, normalized, combined_state, phase_metadata_redacted) = if phase == "check_runs" {
        let response: ProviderCheckRuns = client
            .get_json(
                access_token,
                &[
                    "repos",
                    &repository.owner_login,
                    &repository.name,
                    "commits",
                    &head_sha,
                    "check-runs",
                ],
                &refs,
                LIST_RESPONSE_MAX_BYTES,
            )
            .await
            .map_err(GitHubReadFailure::Provider)?;
        let raw_len = response.check_runs.len();
        checked_provider_page_len(raw_len, limit)?;
        if position.raw_offset > raw_len {
            return Err(input_invalid());
        }
        let normalized = response
            .check_runs
            .into_iter()
            .skip(position.raw_offset)
            .map(|check| normalize_check_run(repository, &head_sha, check))
            .collect::<Result<Vec<_>, _>>()?;
        (raw_len, normalized, None, false)
    } else {
        let response: ProviderCombinedStatus = client
            .get_json(
                access_token,
                &[
                    "repos",
                    &repository.owner_login,
                    &repository.name,
                    "commits",
                    &head_sha,
                    "status",
                ],
                &refs,
                LIST_RESPONSE_MAX_BYTES,
            )
            .await
            .map_err(GitHubReadFailure::Provider)?;
        if validate_sha(&response.sha)? != head_sha {
            return Err(pull_changed());
        }
        let raw_len = response.statuses.len();
        checked_provider_page_len(raw_len, limit)?;
        if position.raw_offset > raw_len {
            return Err(input_invalid());
        }
        let normalized = response
            .statuses
            .into_iter()
            .skip(position.raw_offset)
            .map(|status| normalize_status(repository, &head_sha, status))
            .collect::<Result<Vec<_>, _>>()?;
        let (combined_state, _, state_redacted) = guarded(&response.state, 128)?;
        (raw_len, normalized, Some(combined_state), state_redacted)
    };
    let after = fetch_pull(client, access_token, repository, number).await?;
    if stable_head(&before, &after, number)? != head_sha {
        return Err(pull_changed());
    }
    let selected = select_items(normalized, Some(&phase))?;
    if selected.accepted == 0 && position.raw_offset < raw_len {
        return Err(GitHubReadFailure::Input(AppError::new(
            "github_response_too_large",
            "GitHub content exceeds the response limit.",
        )));
    }
    let continuation_cursor = phase_continuation(
        capabilities,
        repository,
        fingerprint,
        &phase,
        position,
        raw_len,
        selected.accepted,
        limit,
    )?;
    Ok(GitHubOperationOutput {
        data: json!({
            "pullNumber": number,
            "headSha": head_sha,
            "phase": phase,
            "combinedState": combined_state,
            "items": selected.values,
        }),
        truncated: continuation_cursor.is_some(),
        continuation_cursor,
        redactions_applied: selected.redactions_applied || phase_metadata_redacted,
        sources: selected.sources,
        finalization_checkpoints: Some(list_finalization_checkpoints(
            "list_pull_request_checks",
            repository,
            fingerprint,
            position,
            selected.accepted,
            Some(&phase),
        )?),
    })
}
