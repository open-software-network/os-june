# GitHub agent reads implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every eligible interactive June session a bounded, source-attributed, read-only GitHub toolset for the user's selected repositories, issues, and pull requests.

**Architecture:** Add a fixed Rust GitHub read service behind a dedicated loopback proxy credential and a bundled stdlib-only MCP process. Rust resolves opaque repository IDs against the current selected-repository snapshot, coordinates reads with connector state changes through a writer-fair authorization gate, calls only fixed GitHub REST operations, normalizes and bounds untrusted content, and registers the server only in eligible interactive runtimes.

**Tech Stack:** Rust, Tokio, reqwest, serde/serde_json, zeroize, sha2, Tauri, stdlib Python MCP, Vitest, existing Hermes bridge and SQLite repository snapshot

## Global Constraints

- Approved design: [`docs/superpowers/specs/2026-07-16-github-agent-reads-design.md`](../specs/2026-07-16-github-agent-reads-design.md).
- Prerequisite plan: [`docs/superpowers/plans/2026-07-16-github-revocation-reconnect.md`](2026-07-16-github-revocation-reconnect.md). Complete its live verification before Task 1.
- Follow [ADR 0016](../../adr/0016-private-connectors-local-mode.md): GitHub credential custody and GitHub REST traffic remain on the Mac. June API receives neither.
- Add no ADR: ADR 0016 already owns this accepted app-proxied local connector boundary.
- The selected online model may receive bounded GitHub tool results in inference context; documentation must say this plainly.
- Expose exactly the 16 approved read operations. No generic URL, HTTP method, headers, owner, repository name, installation ID, GraphQL, mutation, clone, checkout, index, webhook, cache, or persistence of retrieved content.
- Every repository-specific operation accepts only the stable opaque `repository_id`; Rust resolves owner/name from the current SQLite snapshot.
- Register `june_github` only for a connected GitHub account with a usable credential and at least one selected repository on an unsuspended installation with `metadata`, `contents`, `issues`, `pull_requests`, `checks`, and `statuses` at read-or-write level.
- Make `june_github` automatic for interactive sessions, including an existing explicit CLI MCP allowlist. Preserve literal `no_mcp` as the user's explicit global MCP opt-out.
- Do not add GitHub to `CONNECTOR_READ_TOOLSETS`, `cron_platform_toolsets`, routine `enabled_toolsets`, or connector autonomy grants. Scheduled routines are out of scope.
- Treat file text, search results, issues, comments, pull requests, reviews, commits, diffs, checks, and statuses as `untrusted_repository_content`.
- Default list size is 30; maximum is 50. Normalized responses are at most 256 KiB. File reads are at most 1,000 lines and 256 KiB. Per-file patches are at most 2,000 lines and 256 KiB.
- Cursors and pull-request file references are random, process-memory-only capabilities with a 15-minute TTL and a 1,024-entry total cap. Never serialize provider URLs or content into them.
- Block high-confidence sensitive paths and redact high-confidence credentials and private-key blocks. Describe filtering as defense in depth, never exhaustive secret detection.
- Never log or return a GitHub access/refresh token, dedicated proxy token, authorization header, provider body, or URL assembled from repository-controlled data.
- Do not add a package, database migration, June API route, GitHub write permission, settings status, or user-facing control.
- Future mutations require a separately designed `june_github_actions` server, new App permissions, approvals, and revalidation; do not add any part of that server here.
- Use test-driven steps: run each named RED test before its implementation and rerun it GREEN afterward. Keep each task's commit limited to its listed files.

## Dependency and parallel execution map

```text
Prerequisite reconnect plan
        |
        v
Task 1: eligibility + authorization gate
        |
        +--------------------+
        v                    v
Task 2: content guard   Task 3: capabilities
        \                    /
         +--------+---------+
                  v
Task 4: fixed REST transport
                  |
       +----------+-----------+
       v          v           v
Task 5: repo   Task 6: issue  Task 7: pull request
       \          |           /
        +---------+----------+
                  v
Task 8: read orchestrator
                  |
       +----------+-----------+
       v                      v
Task 9: proxy boundary   Task 10: Python MCP
       \                      /
        +----------+---------+
                   v
Task 11: runtime registration
                   |
                   v
Task 12: native reconciliation
                   |
                   v
Task 13: docs + full/live verification
```

Tasks 2 and 3 may run in parallel after Task 1. Tasks 5, 6, and 7 may run in
parallel after Task 4. Tasks 9 and 10 may run in parallel after Task 8 freezes
the proxy request and response contract. Parallel workers must not edit files
outside their task's file list. Run each parallel worker in its own git
worktree/branch and have the coordinator cherry-pick the finished commits in
task-number order; do not let concurrent workers share one git index.

---

### Task 1: Enforce permission readiness and serialize authorization state

**Files:**

- Modify: `src-tauri/src/connectors/github.rs`
- Modify: `src-tauri/src/connectors/mod.rs`
- Create: `src-tauri/src/connectors/github_read.rs`
- Create: `src-tauri/src/connectors/github_content_guard.rs`
- Create: `src-tauri/src/connectors/github_capabilities.rs`

**Interfaces:**

- Produces: `github_authorization_gate() -> &'static tokio::sync::RwLock<()>`
- Produces: `installation_has_required_read_permissions(permissions: &BTreeMap<String, String>) -> bool`
- Produces: `github_tool_eligibility(vault: &dyn GitHubTokenVault, repositories: &Repositories) -> Result<GitHubToolEligibility, AppError>`
- Produces: `github_tool_eligibility_from_snapshot(snapshot: &GitHubSnapshotRecord, expected_user_id: &str) -> Result<GitHubToolEligibility, AppError>` for callers that already hold a read lease
- Produces: the shared typed request, normalized operation-output, source, envelope, and outcome contracts used by later tasks
- Changes: `status_for_discovery(installations: &[DiscoveredGitHubInstallation], repositories: &[DiscoveredGitHubRepository])` requires a fully read-eligible selected repository
- Lock order: flow-local completion guard when applicable, authorization gate, `connection_operation_lock`, per-user refresh lock, then database/Keychain/provider work

- [ ] **Step 1: Add failing permission-readiness tests**

In `github.rs`, add table-driven tests named
`status_requires_every_github_read_permission` and
`tool_eligibility_excludes_suspended_and_unselected_repositories`. Use this
exact permission set:

```rust
const REQUIRED_GITHUB_READ_PERMISSIONS: [&str; 6] = [
    "metadata",
    "contents",
    "issues",
    "pull_requests",
    "checks",
    "statuses",
];
```

The table must prove that `read` and `write` both satisfy a required key,
`none`, missing keys, suspension, and zero selected repositories fail closed,
and one eligible repository keeps the connection `connected` even when a
second installation is awaiting approval.

- [ ] **Step 2: Run the permission tests and verify RED**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked status_requires_every_github_read_permission
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked tool_eligibility_excludes_suspended_and_unselected_repositories
```

Expected: the first test fails because current discovery checks only
suspension; the second fails to compile because tool eligibility does not
exist.

- [ ] **Step 3: Add the eligibility contract**

Add these non-secret types and helpers in `github.rs`:

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EligibleGitHubRepository {
    pub repository_id: String,
    pub installation_id: String,
    pub owner_login: String,
    pub name: String,
    pub full_name: String,
    pub private: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GitHubToolEligibility {
    pub github_user_id: String,
    pub repositories: Vec<EligibleGitHubRepository>,
}

fn permission_grants_read(value: Option<&String>) -> bool {
    matches!(value.map(String::as_str), Some("read" | "write"))
}

fn installation_has_required_read_permissions(
    permissions: &BTreeMap<String, String>,
) -> bool {
    REQUIRED_GITHUB_READ_PERMISSIONS
        .iter()
        .all(|key| permission_grants_read(permissions.get(*key)))
}
```

`status_for_discovery` must join each selected repository to its installation
and require `suspended_at.is_none()` plus the complete permission set.
`github_tool_eligibility` takes its own shared authorization lease, reads one
transactional `github_snapshot()`, requires status `connected`, requires a
present Keychain credential, validates numeric IDs and
`full_name == format!("{owner_login}/{name}")`, and returns only eligible
repositories. Factor the snapshot-only validation into
`github_tool_eligibility_from_snapshot(snapshot, expected_user_id)`; Task 8
uses that helper while it already holds the read lease and must never nest a
second read acquisition. Both paths return sanitized setup/reconnect/storage
errors and never include snapshot contents in messages.

- [ ] **Step 4: Freeze the typed read contract before parallel endpoint work**

Create `github_read.rs` with the complete request enum. The proxy accepts this
enum directly, so unknown operation names or fields fail deserialization:

```rust
#[derive(Debug, Deserialize)]
#[serde(
    tag = "operation",
    content = "arguments",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(crate) enum GitHubReadRequest {
    ListRepositories { cursor: Option<String>, limit: Option<u16> },
    GetRepository { repository_id: String },
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
    GetIssue { repository_id: String, number: u64 },
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
    GetPullRequest { repository_id: String, number: u64 },
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

#[derive(Clone, Debug)]
pub(crate) struct GitHubOperationOutput {
    pub data: serde_json::Value,
    pub truncated: bool,
    pub continuation_cursor: Option<String>,
    pub redactions_applied: bool,
    pub sources: Vec<GitHubSource>,
}

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

pub(crate) struct GitHubReadOutcome {
    pub result: Result<GitHubReadEnvelope, AppError>,
    pub connector_state_changed: bool,
}
```

Add serde tests proving all 16 operation names parse, an unknown operation and
unknown argument fail, and serialization always spells the trust marker
`untrusted_repository_content`. Add stub orchestration only as needed for the
module to compile; endpoint dispatch is Task 8.

Create compile-safe empty `github_content_guard.rs` and
`github_capabilities.rs` modules and declare them in `connectors/mod.rs` now.
Tasks 2 and 3 then replace one stub each without sharing `mod.rs`.

- [ ] **Step 5: Add failing authorization-gate race tests**

Add tests named `disconnect_waits_for_an_inflight_github_read_lease` and
`queued_disconnect_prevents_a_later_github_read_lease`. The first holds a read
guard, starts disconnect, asserts disconnect is pending, releases the guard,
and asserts disconnect completes. The second queues a writer while the first
read is held, then starts another reader and proves the writer completes before
the later reader. Use `tokio::time::timeout` rather than sleeps.

- [ ] **Step 6: Run the gate tests and verify RED**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked disconnect_waits_for_an_inflight_github_read_lease
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked queued_disconnect_prevents_a_later_github_read_lease
```

Expected: the tests fail to compile because the authorization gate is absent.

- [ ] **Step 7: Add the writer-fair gate and lock ordering**

Add:

```rust
pub(crate) fn github_authorization_gate() -> &'static tokio::sync::RwLock<()> {
    static GATE: OnceLock<tokio::sync::RwLock<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::RwLock::new(()))
}
```

In `complete_connect`, preserve the device-flow wait outside the gate, then
acquire `write().await` after the flow-local completion guard and before the
existing `connection_operation_lock`. Acquire the write lease before the
operation lock for `connection_get`, `installations_refresh`, and `disconnect`.
Add one comment at the gate definition stating the binding order. Never attempt
a read-to-write lock upgrade.

- [ ] **Step 8: Run the focused suite and commit**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github::tests
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_read::tests
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
git diff --check
git add src-tauri/src/connectors/github.rs src-tauri/src/connectors/github_read.rs src-tauri/src/connectors/github_content_guard.rs src-tauri/src/connectors/github_capabilities.rs src-tauri/src/connectors/mod.rs
git commit -m "feat: gate GitHub read eligibility"
```

---

### Task 2: Validate paths and bound untrusted content

**Files:**

- Modify: `src-tauri/src/connectors/github_content_guard.rs`

**Interfaces:**

- Produces: validated repository paths, refs, search literals, labels, and branch filters
- Produces: UTF-8 line-window extraction and bounded text normalization
- Produces: sensitive-path blocking and high-confidence redaction metadata
- Consumes no database, Keychain, network, or filesystem state

- [ ] **Step 1: Add the complete failing guard corpus**

Create the module with tests first. Use these public-in-crate shapes:

```rust
pub(crate) struct GuardedText {
    pub text: String,
    pub truncated: bool,
    pub redactions_applied: bool,
}

pub(crate) fn validate_repository_path(path: &str, allow_root: bool)
    -> Result<String, AppError>;
pub(crate) fn validate_git_ref(value: Option<&str>)
    -> Result<Option<String>, AppError>;
pub(crate) fn validate_search_literal(value: &str) -> Result<String, AppError>;
pub(crate) fn validate_labels(values: &[String]) -> Result<Vec<String>, AppError>;
pub(crate) fn sensitive_path_blocked(path: &str) -> bool;
pub(crate) fn normalize_untrusted_text(
    bytes: &[u8],
    max_bytes: usize,
    max_lines: usize,
) -> Result<GuardedText, AppError>;
```

Add named tests covering:

- accepted root/directory/file paths and refs;
- rejection of absolute paths, backslashes, NUL/control characters, empty
  non-root paths, `.` and `..` segments, repeated separators, ref traversal,
  quotes, backslashes, and colons in search literals, and all overlength
  fields;
- blocking `.env`, `.env.local`, `id_rsa`, `id_ed25519`, `.pem`, `.key`,
  `.p12`, `.pfx`, `.netrc`, `.git-credentials`, `.npmrc`, `.pypirc`,
  `.pgpass`, and credential/secrets JSON filenames case-insensitively;
- rejection of invalid UTF-8, NUL-containing and control-heavy buffers;
- exact line and byte truncation without splitting a Unicode scalar;
- redaction of PEM private-key blocks, GitHub token prefixes, and
  high-confidence `token`, `secret`, `password`, and `api_key` assignments;
- preserving ordinary prose such as `password policy` and source code that
  contains the word `secret` without an assignment value.

- [ ] **Step 2: Run the module and verify RED**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_content_guard::tests
```

Expected: compilation fails because the declared functions have no
implementation.

- [ ] **Step 3: Implement pure validation and normalization**

Use byte/character scanning and existing standard-library facilities; add no
regex or Unicode package. Return stable codes:

```text
github_input_invalid
github_sensitive_path_blocked
github_binary_content
github_response_too_large
```

Redact matched values as `[REDACTED]`, preserve line structure, set
`redactions_applied`, and apply redaction before the final byte ceiling.
Sensitive-path matching uses the normalized repository-relative path only.

- [ ] **Step 4: Run the module and commit**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_content_guard::tests
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
git diff --check
git add src-tauri/src/connectors/github_content_guard.rs
git commit -m "feat: guard GitHub repository content"
```

---

### Task 3: Issue opaque pagination and pull-file capabilities

**Files:**

- Modify: `src-tauri/src/connectors/github_capabilities.rs`

**Interfaces:**

- Produces: `CapabilityRegistry` with cursor and pull-file reference issue/resolve APIs
- Uses: `random_b64url(24)` and SHA-256 filter fingerprints
- Enforces: 15-minute TTL, 1,024 total entries, operation/scope/filter binding, one-process lifetime

- [ ] **Step 1: Add failing capability tests**

Define these internal payloads and test them before implementing the registry:

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CursorScope {
    pub operation: &'static str,
    pub repository_id: Option<String>,
    pub filter_fingerprint: [u8; 32],
    pub provider_page: u32,
    pub raw_offset: u16,
    pub phase: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PullFileScope {
    pub repository_id: String,
    pub pull_number: u64,
    pub head_sha: String,
    pub absolute_index: u16,
    pub expected_path: String,
}
```

Tests must prove:

- a freshly issued token resolves once or repeatedly until expiry;
- wrong operation, repository, filter fingerprint, pull number, head SHA, or
  expected path returns `github_cursor_invalid` or `github_file_ref_invalid`;
- expired and evicted tokens do not resolve;
- the 1,025th insertion evicts the oldest entry;
- debug output and serialized errors do not expose stored payloads;
- two registries cannot resolve each other's tokens;
- a pull-file index above 2,999 cannot be issued.

- [ ] **Step 2: Run the tests and verify RED**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_capabilities::tests
```

Expected: compilation fails because the registry is not implemented.

- [ ] **Step 3: Implement the bounded in-memory registry**

Use `std::sync::Mutex<VecDeque<CapabilityEntry>>`, `std::time::Instant`, and a
private enum that distinguishes cursors from file references. Hash the
canonical JSON of operation filters with existing `sha2`; never place raw
filters, names, paths, URLs, or provider data in the random public token.
Provide a test constructor with an injectable clock so expiry tests do not
sleep.

- [ ] **Step 4: Run the module and commit**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_capabilities::tests
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
git diff --check
git add src-tauri/src/connectors/github_capabilities.rs
git commit -m "feat: issue GitHub read capabilities"
```

---

### Task 4: Build the bounded fixed GitHub REST transport

**Files:**

- Create: `src-tauri/src/connectors/github_api.rs`
- Create: `src-tauri/src/connectors/github_repository_reads.rs`
- Create: `src-tauri/src/connectors/github_issue_reads.rs`
- Create: `src-tauri/src/connectors/github_pull_reads.rs`
- Modify: `src-tauri/src/connectors/github_read.rs`
- Modify: `src-tauri/src/connectors/mod.rs`

**Interfaces:**

- Produces: `GitHubReadClient::production()` and `GitHubReadClient::for_test(base_url)`
- Produces: authenticated fixed GET transport with redirect refusal, 30-second timeout, GitHub API version header, and streamed body ceiling
- Produces: sanitized `GitHubApiError` classification without provider bodies or repository-controlled URLs

- [ ] **Step 1: Add a scripted-server transport suite**

Reuse the existing `pub(crate)`
`github_auth::tests::scripted_server` fixture, extending only its safe capture
fields when a transport assertion needs them. Add tests named:

```text
transport_sends_only_get_and_required_github_headers
transport_refuses_redirects
transport_stops_streaming_at_the_byte_ceiling
transport_classifies_401_403_404_rate_limit_and_transient_failures
transport_never_includes_body_or_url_in_errors
transport_rejects_malformed_json
```

The request assertion must verify `GET`, `Authorization: Bearer <fixture>`,
`Accept: application/vnd.github+json`, the pinned `X-GitHub-Api-Version`, and
the fixed user agent. Tests must use only fixture tokens and assert that the
token never appears in `Debug`, `Display`, or `AppError` text.

- [ ] **Step 2: Run the transport suite and verify RED**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_api::tests
```

Expected: compilation fails because the transport types do not exist.

- [ ] **Step 3: Implement the production client**

Use this error contract:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GitHubApiError {
    Unauthorized,
    Forbidden,
    NotFound,
    RateLimited { retry_after_seconds: Option<u64> },
    ResponseTooLarge,
    Malformed,
    Transient,
}
```

Build reqwest with:

```rust
reqwest::Client::builder()
    .no_proxy()
    .redirect(reqwest::redirect::Policy::none())
    .timeout(std::time::Duration::from_secs(30))
```

Change the existing `github_auth.rs` constant to
`pub(crate) const GITHUB_API_VERSION: &str = "2026-03-10";` and reuse it in
the read client so authentication, discovery, and reads cannot drift to
different provider contracts.

Keep the generic `get_json<T>` method `pub(super)` so only sibling connector
modules can call it. It accepts
validated path segments and fixed query pairs, builds the URL with
`reqwest::Url::path_segments_mut()` plus `query_pairs_mut()`, streams
`Response::chunk()` into a bounded buffer, and deserializes only after the
status and ceiling checks. The production base URL is exactly
`https://api.github.com/`. No caller can pass a full URL or HTTP method.

Use fixed code-owned stream ceilings: 2 MiB for list/search responses, 512 KiB
for repository/issue/pull singletons, and 384 KiB for file-content or
single-file-diff JSON. The selected endpoint function passes one of these
constants; no request field can alter it.

Add the shared internal endpoint failure to `github_read.rs` now that
`GitHubApiError` exists:

```rust
#[derive(Clone, Debug)]
pub(crate) enum GitHubReadFailure {
    Input(AppError),
    Provider(GitHubApiError),
}
```

Create compile-safe empty `github_repository_reads.rs`,
`github_issue_reads.rs`, and `github_pull_reads.rs` modules and declare them in
`connectors/mod.rs`. Tasks 5, 6, and 7 then replace one stub each without a
shared-file merge.

- [ ] **Step 4: Run the transport suite and commit**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_api::tests
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
git diff --check
git add src-tauri/src/connectors/github_api.rs src-tauri/src/connectors/github_repository_reads.rs src-tauri/src/connectors/github_issue_reads.rs src-tauri/src/connectors/github_pull_reads.rs src-tauri/src/connectors/github_auth.rs src-tauri/src/connectors/github_read.rs src-tauri/src/connectors/mod.rs
git commit -m "feat: add bounded GitHub read transport"
```

---

### Task 5: Implement repository, directory, file, and code-search reads

**Files:**

- Modify: `src-tauri/src/connectors/github_repository_reads.rs`

**Interfaces:**

- Implements: `list_repositories`, `get_repository`, `list_directory`, `read_file`, `search_code`
- Consumes: `EligibleGitHubRepository`, `GitHubReadClient`, `CapabilityRegistry`, content guards, and the shared `GitHubOperationOutput`
- Calls only: repository metadata, repository contents, and code-search GET endpoints

- [ ] **Step 1: Add exact-endpoint RED tests for all five operations**

Add a scripted server and named tests that assert these request families:

```text
GET /repos/{resolved_owner}/{resolved_repo}
GET /repos/{resolved_owner}/{resolved_repo}/contents/{validated_path}?ref={validated_ref}
GET /search/code?q={validated_literal plus Rust-owned repo qualifier}&per_page={limit}&page={page}
```

The tests must prove:

- `list_repositories` uses only the eligible local snapshot, defaults to 30,
  caps at 50, and issues a scope-bound cursor without making a network call;
- `get_repository` returns normalized name, visibility, archive state, default
  branch, description, language, topics, license, and counts without returning
  provider URL fields;
- directory entries are normalized, sorted in provider order, bounded, and
  never return a submodule body;
- an omitted ref first resolves the current default branch and returns that
  explicit ref in data and sources;
- `read_file` decodes only GitHub's base64 content response, enforces
  `start_line >= 1`, defaults `line_count` to 200, caps it at 1,000, blocks a
  sensitive path before provider traffic, rejects binary/oversize content,
  and reports the exact returned line window;
- `search_code` rejects GitHub search qualifiers supplied by the model,
  appends exactly one Rust-owned `repo:{owner}/{name}` qualifier, validates
  every result's repository identity, bounds each fragment to 4 KiB, and does
  not follow provider pagination automatically;
- owner/name/ref/path are percent-encoded path or query components and cannot
  alter the endpoint;
- sources are constructed from the validated repository tuple and normalized
  result identifiers, not copied from `url`, `download_url`, or `_links`.

Use fixtures for an empty page, exactly 50 entries, an oversize 51st entry,
malformed base64, a submodule entry, a cross-repository search result, and a
provider response that contains a hostile URL string.

- [ ] **Step 2: Run the repository module and verify RED**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_repository_reads::tests
```

Expected: compilation fails because the endpoint functions are absent.

- [ ] **Step 3: Implement normalized repository operations**

Expose only these module functions:

```rust
pub(crate) async fn list_repositories(
    eligibility: &GitHubToolEligibility,
    capabilities: &CapabilityRegistry,
    cursor: Option<&str>,
    limit: Option<u16>,
) -> Result<GitHubOperationOutput, AppError>;

pub(crate) async fn get_repository(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
) -> Result<GitHubOperationOutput, GitHubApiError>;

pub(crate) async fn list_directory(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    request: DirectoryRead,
    capabilities: &CapabilityRegistry,
) -> Result<GitHubOperationOutput, GitHubReadFailure>;

pub(crate) async fn read_file(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    request: FileRead,
) -> Result<GitHubOperationOutput, GitHubReadFailure>;

pub(crate) async fn search_code(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    request: CodeSearch,
    capabilities: &CapabilityRegistry,
) -> Result<GitHubOperationOutput, GitHubReadFailure>;
```

Define the three request structs in this module from already validated typed
fields. `GitHubReadFailure` is the shared internal enum in `github_read.rs`
with `Input(AppError)` and `Provider(GitHubApiError)` variants. Apply a 248 KiB
soft data budget so Task 8 can add the common envelope and remain under the
hard 256 KiB serialized ceiling.

- [ ] **Step 4: Run the module and commit**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_repository_reads::tests
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
git diff --check
git add src-tauri/src/connectors/github_repository_reads.rs
git commit -m "feat: read selected GitHub repositories"
```

---

### Task 6: Implement issue and issue-comment reads

**Files:**

- Modify: `src-tauri/src/connectors/github_issue_reads.rs`

**Interfaces:**

- Implements: `list_issues`, `get_issue`, `list_issue_comments`
- Calls only: repository issues, issue comments, and issue-search GET endpoints
- Normalizes: user identity, labels, milestone, timestamps, state/reason, bounded body, and repository-built sources

- [ ] **Step 1: Add exact-endpoint RED tests for issue reads**

Assert these request families:

```text
GET /repos/{resolved_owner}/{resolved_repo}/issues
GET /repos/{resolved_owner}/{resolved_repo}/issues/{positive_number}
GET /repos/{resolved_owner}/{resolved_repo}/issues/{positive_number}/comments
GET /search/issues?q={validated_literal plus Rust-owned repo and is:issue qualifiers}
```

Tests must prove:

- state accepts only `open`, `closed`, or `all`; numbers are positive; labels
  are individually validated, deduplicated, and bounded;
- list mode filters any item containing a `pull_request` marker without
  silently fetching another page;
- search mode strips no user qualifier because qualifiers are rejected before
  the request, then appends exactly one repository scope and `is:issue`;
- cursors bind repository, operation, state, query, and labels;
- issue bodies are bounded to 64 KiB, comment bodies to 16 KiB, and both pass
  through redaction while preserving `body_truncated` per object;
- no response field can redirect a subsequent request or replace the
  repository source identity;
- a provider 401, 403, 404, rate limit, oversize body, and malformed response
  remain typed internal failures for Task 8 to classify.

- [ ] **Step 2: Run the issue module and verify RED**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_issue_reads::tests
```

Expected: compilation fails because the module functions do not exist.

- [ ] **Step 3: Implement the three fixed operations**

Expose:

```rust
pub(crate) async fn list_issues(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    request: IssueList,
    capabilities: &CapabilityRegistry,
) -> Result<GitHubOperationOutput, GitHubReadFailure>;

pub(crate) async fn get_issue(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    number: u64,
) -> Result<GitHubOperationOutput, GitHubReadFailure>;

pub(crate) async fn list_issue_comments(
    client: &GitHubReadClient,
    access_token: &str,
    repository: &EligibleGitHubRepository,
    request: IssueComments,
    capabilities: &CapabilityRegistry,
) -> Result<GitHubOperationOutput, GitHubReadFailure>;
```

Define `IssueList` and `IssueComments` locally. Normalize only approved fields;
discard provider link maps, reactions URLs, author association URLs, and raw
repository objects. Apply the shared 248 KiB soft data budget without hidden
page fetches.

- [ ] **Step 4: Run the module and commit**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_issue_reads::tests
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
git diff --check
git add src-tauri/src/connectors/github_issue_reads.rs
git commit -m "feat: read selected GitHub issues"
```

---

### Task 7: Implement pull request, review, diff, commit, and check reads

**Files:**

- Modify: `src-tauri/src/connectors/github_pull_reads.rs`

**Interfaces:**

- Implements: all eight pull-request operations from the approved contract
- Calls only: pulls, pull files, pull commits, reviews, review comments, check-runs, combined statuses, and pull-search GET endpoints
- Enforces: head-SHA-bound per-file references and the provider's 3,000-file list ceiling

- [ ] **Step 1: Add exact-endpoint RED tests for pull request reads**

Cover these request families and assert GET for each:

```text
/repos/{owner}/{repo}/pulls
/repos/{owner}/{repo}/pulls/{number}
/repos/{owner}/{repo}/pulls/{number}/files
/repos/{owner}/{repo}/pulls/{number}/commits
/repos/{owner}/{repo}/pulls/{number}/reviews
/repos/{owner}/{repo}/pulls/{number}/comments
/repos/{owner}/{repo}/commits/{head_sha}/check-runs
/repos/{owner}/{repo}/commits/{head_sha}/status
/search/issues?q={validated literal plus repo scope and is:pr}
```

The suite must prove:

- state accepts only `open`, `closed`, or `all`; base/head filters and positive
  pull numbers are bounded and validated;
- list/search cursors bind every original filter and never switch resource
  type or repository;
- pull bodies are capped at 64 KiB, review/review-comment/check output at
  16 KiB, and commit messages at 8 KiB, with redaction metadata;
- `list_pull_request_files` reads the pull head before and after the requested
  page, emits a random `file_ref` for every file only when the head is stable,
  binds absolute indexes 0 through 2,999, and reports
  `provider_file_limit_reached` when `changed_files > 3_000`;
- `read_pull_request_file_diff` resolves a file reference, re-reads the pull,
  fetches exactly `/files?per_page=1&page={absolute_index + 1}`, re-reads the
  pull, verifies unchanged head SHA and exact path, and never downloads or
  searches a whole-PR diff;
- a present patch is labeled `provider_supplied`, an absent patch is
  `unavailable`, a response above the per-file ceiling is `response_too_large`,
  and continuation traverses only the already parsed provider-supplied patch;
- per-file patch windows stop at 2,000 lines and 256 KiB;
- `list_pull_request_checks` first pages check runs, then uses a cursor phase to
  page combined statuses; one request never silently drains both phases;
- check/status calls use only the head SHA obtained from the authorized pull
  response, never a model-supplied SHA;
- a changed head between any consistency reads returns
  `github_pull_request_changed` without content.

Include fixtures for renamed files, missing patches, 3,001 changed files,
unstable heads, wrong file path at the bound index, cross-repository search
results, and rate-limited check runs.

- [ ] **Step 2: Run the pull module and verify RED**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_pull_reads::tests
```

Expected: compilation fails because the pull-read functions are absent.

- [ ] **Step 3: Implement all fixed pull operations**

Keep endpoint-specific request structs in this module and expose one function
per operation using the same arguments as Tasks 5 and 6: client, access token,
resolved eligible repository, validated operation request, and capability
registry when pagination or file references apply. Construct every source URL
from the validated repository tuple plus normalized pull number, path, and
head SHA. Discard provider link maps and raw repository objects.

Do not call a whole-diff media endpoint. For a file reference at absolute index
`i`, derive only `per_page=1&page=i+1` after enforcing `i < 3_000`.

- [ ] **Step 4: Run the module and commit**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_pull_reads::tests
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
git diff --check
git add src-tauri/src/connectors/github_pull_reads.rs
git commit -m "feat: read selected GitHub pull requests"
```

---

### Task 8: Orchestrate credentials, retries, authorization leases, and envelopes

**Files:**

- Modify: `src-tauri/src/connectors/github.rs`
- Modify: `src-tauri/src/connectors/github_read.rs`

**Interfaces:**

- Produces: `GitHubReadService::production()` and `GitHubReadService::for_test(api: GitHubReadClient, auth: GitHubAuthClient, config: GitHubAppConfig, capabilities: Arc<CapabilityRegistry>)`
- Produces: `execute(request, vault, repositories) -> GitHubReadOutcome`
- Produces: a zeroizing access-token-only `GitHubReadCredential`
- Guarantees: one provider retry after 401, one discovery refresh after 403/404, response finalization under a shared authorization lease, and a hard 256 KiB envelope ceiling

- [ ] **Step 1: Add failing dispatch and authorization tests**

Add named tests covering all of these cases:

```text
dispatches_exactly_the_sixteen_read_variants
rejects_unknown_repository_id_before_provider_traffic
revalidates_repository_snapshot_before_returning_content
disconnect_cannot_complete_before_read_response_finalization
disconnect_that_wins_the_gate_prevents_provider_traffic
refreshes_once_after_401_and_retries_once
second_401_marks_terminal_grant_reconnect_without_a_third_request
newer_token_after_second_401_returns_transient_without_a_third_request
403_or_404_refreshes_discovery_once_and_returns_one_indistinguishable_error
rate_limit_uses_only_trusted_retry_headers
serialized_envelope_never_exceeds_256_kib
credential_debug_and_errors_never_expose_tokens
```

The race fixtures must use barriers/oneshots and `tokio::time::timeout`; do not
use timing sleeps. Snapshot revalidation compares the complete authorization
tuple: GitHub user/status, repository ID/installation/owner/name/full name,
installation permissions/suspension/refresh time, and selection membership.

- [ ] **Step 2: Run the orchestrator suite and verify RED**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_read::tests
```

Expected: dispatch, retry, race, and size tests fail because orchestration is
still a stub.

- [ ] **Step 3: Add access-token-only credential resolution**

In `github.rs`, add:

```rust
#[derive(zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
pub(crate) struct GitHubReadCredential {
    pub github_user_id: String,
    pub access_token: String,
}

impl std::fmt::Debug for GitHubReadCredential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GitHubReadCredential")
            .field("github_user_id", &self.github_user_id)
            .field("access_token", &"[REDACTED]")
            .finish()
    }
}
```

Add `resolve_github_read_credential` and
`resolve_github_read_credential_after_unauthorized`. Each wrapper acquires the
authorization gate's write lease, then the connection operation lock, then
uses the existing per-user refresh lock and Keychain helpers. It returns only
user ID and access token; refresh tokens never enter `GitHubReadService`.
Keep `usable_tokens_inner` private for existing discovery paths.

- [ ] **Step 4: Implement the lease-safe execution algorithm**

`GitHubReadService` owns the fixed API client, auth client, App config, and an
`Arc<CapabilityRegistry>`. Its operation flow is:

1. Resolve a fresh-enough credential before taking a shared lease.
2. Take `github_authorization_gate().read().await`.
3. Load one authoritative snapshot, validate status/credential user,
   permissions/suspension/selection, and resolve `repository_id`.
4. Dispatch exactly one typed operation to Tasks 5 through 7.
5. For success, reload and compare the full authorization tuple while still
   holding the read lease, construct the envelope, serialize it, enforce the
   256 KiB hard ceiling, and only then release the lease.
6. For 401, retain no content, release the read lease, resolve after the
   rejected token under the exclusive path, reacquire/revalidate, and retry
   exactly once. A second 401 releases the lease and resolves the rejected
   current token once; terminal invalidation sets `connector_state_changed`,
   while a newer usable token yields sanitized transient failure without a
   third provider call.
7. For 403 or 404, retain no content, release the read lease, run one existing
   installation discovery refresh under the exclusive path, compare pre/post
   snapshots, set `connector_state_changed` when changed, and return
   `github_access_removed_or_not_found`. Do not retry or probe a name.
8. For every other failure, return a stable sanitized `AppError` without state
   mutation.

Use `trust: "untrusted_repository_content"` on every success. Singleton body
truncation sets object-level `body_truncated` and does not invent a continuation
cursor. List/diff continuations come only from `CapabilityRegistry`.
When the serialized envelope still exceeds 256 KiB, remove trailing list items
or patch lines until the envelope fits and issue a capability at the exact next
offset. For a singleton, shorten only its bounded body text and set
`body_truncated`; if fixed normalized metadata and sources alone exceed the
ceiling, return `github_response_too_large` without content.

- [ ] **Step 5: Map stable public errors**

The orchestrator may return only these GitHub read codes:

```text
github_reconnect_required
github_setup_required
github_repository_not_selected
github_access_removed_or_not_found
github_input_invalid
github_cursor_invalid
github_file_ref_invalid
github_sensitive_path_blocked
github_binary_content
github_response_too_large
github_pull_request_changed
github_rate_limited
github_read_unavailable
```

Messages are fixed sentence-case strings. Rate-limit metadata may contain a
bounded integer derived from `Retry-After` or `X-RateLimit-Reset`; never copy a
provider body or arbitrary header.

- [ ] **Step 6: Run all connector read suites and commit**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_read::tests
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_repository_reads::tests
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_issue_reads::tests
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_pull_reads::tests
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
CARGO_INCREMENTAL=0 cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
git diff --check
git add src-tauri/src/connectors/github.rs src-tauri/src/connectors/github_read.rs
git commit -m "feat: orchestrate safe GitHub reads"
```

---

### Task 9: Isolate the GitHub route behind a dedicated loopback token

**Files:**

- Modify: `src-tauri/src/hermes_bridge.rs`

**Interfaces:**

- Adds: `github_token` to `SharedProviderProxy`, `ProviderProxyState`, and `SharedProviderProxyInfo`
- Adds: exact `POST /v1/github/read` provider-proxy route
- Adds: persistent `Arc<GitHubReadService>` to proxy state
- Enforces: exact-route token isolation and a 64 KiB request-body cap

- [ ] **Step 1: Add failing token-isolation and routing tests**

Extend the provider proxy tests with a matrix containing the general provider,
recorder, Google connector, and GitHub tokens. Assert:

- only the GitHub token authorizes exact path `/v1/github/read`;
- provider, recorder, and Google connector tokens receive 401 on that path;
- the GitHub token receives 401 on model, recorder, Gmail, and Google Calendar
  routes;
- `GET`, `PUT`, `PATCH`, and `DELETE` on `/v1/github/read` return 404 after
  successful GitHub-token authentication;
- `/v1/github/other` returns 404 and cannot dispatch a read;
- an unknown operation and an extra argument return a sanitized 400 without a
  provider call;
- a body of exactly 64 KiB reaches JSON validation and a body of 64 KiB plus
  one byte is rejected by `read_http_request`;
- a successful response serializes `GitHubReadEnvelope`; an error serializes
  only `code`, `message`, optional bounded `details`, and
  `connectorStateChanged`.

- [ ] **Step 2: Run the proxy tests and verify RED**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked provider_proxy_token_isolation
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked github_read_proxy_route
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked provider_proxy_body_limits
```

Expected: tests fail because the token, route, and body limit do not exist.

- [ ] **Step 3: Mint and thread the dedicated secret**

Add `github_token: String` to the three proxy structs and mint it with
`random_token()` beside the existing scoped secrets. Construct one
`Arc::new(GitHubReadService::production()?)` in `start_june_provider_proxy`; do
not recreate its capability registry per request.

Change the token selector signature to:

```rust
fn provider_proxy_required_token<'a>(
    path: &str,
    provider_token: &'a str,
    recorder_token: &'a str,
    connector_token: &'a str,
    github_token: &'a str,
) -> &'a str
```

Select `github_token` only when `path == "/v1/github/read"`. Preserve existing
scopes for every other route.

- [ ] **Step 4: Add the exact route and response protocol**

Add the route before generic fallthrough:

```rust
("POST", "/v1/github/read") => {
    handle_github_read(&mut stream, &state, &request.body).await?;
}
```

`handle_github_read` must:

1. require `state.app` and obtain `Repositories` from the app;
2. deserialize `GitHubReadRequest` with unknown-field denial;
3. execute with `PlatformGitHubTokenVault`;
4. return status 200 for a success envelope;
5. map input/capability errors to 400, reconnect/setup to 409, rate limit to
   429, and transient provider/storage errors to 502;
6. return this fixed error shape:

```json
{
  "success": false,
  "error": {
    "code": "github_read_unavailable",
    "message": "GitHub could not be read right now."
  },
  "connectorStateChanged": false
}
```

Success uses `{ "success": true, "result": <GitHubReadEnvelope>,
"connectorStateChanged": false }`. Never log the request body. Add exact path
`/v1/github/read` to `provider_proxy_max_body_bytes` with `64 * 1024`.

- [ ] **Step 5: Run the proxy suite and commit**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked provider_proxy_token_isolation
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked github_read_proxy_route
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked provider_proxy_body_limits
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
git diff --check
git add src-tauri/src/hermes_bridge.rs
git commit -m "feat: isolate the GitHub read proxy"
```

---

### Task 10: Expose the fixed read contract through a stdlib-only MCP server

**Files:**

- Create: `src-tauri/src/hermes/june_github_mcp.py`
- Create: `src-tauri/src/hermes/test_june_github_mcp.py`

**Interfaces:**

- Exposes: exactly the 16 approved MCP tool names and JSON schemas
- Calls: only `POST {loopback_base_url}/github/read`
- Reads: only `JUNE_GITHUB_PROXY_TOKEN`
- Returns: Rust's structured success envelope in MCP `content` and `structuredContent`

- [ ] **Step 1: Add a real Python contract test before the server**

Using only `unittest`, `http.server`, `threading`, and standard JSON/IO helpers,
create tests named:

```text
test_tools_list_contains_exactly_the_approved_sixteen_names
test_each_tool_posts_one_typed_operation_to_the_fixed_route
test_tool_input_is_validated_before_proxy_traffic
test_proxy_success_preserves_trust_sources_and_continuation
test_proxy_error_returns_only_sanitized_code_and_message
test_missing_token_fails_without_proxy_traffic
test_timeout_and_malformed_proxy_response_are_sanitized
test_token_never_appears_in_mcp_output_or_exception_text
```

Drive `handle_message` directly and also run one initialize/list/call exchange
through the subprocess's stdin/stdout protocol. The fake server must capture
method, path, authorization header, and JSON body and assert the body is exactly:

```json
{
  "operation": "get_issue",
  "arguments": {
    "repository_id": "123456",
    "number": 7
  }
}
```

- [ ] **Step 2: Run the Python test and verify RED**

```bash
python3 -m unittest src-tauri/src/hermes/test_june_github_mcp.py
```

Expected: import fails because `june_github_mcp.py` does not exist.

- [ ] **Step 3: Implement the MCP server with exact schemas**

Follow the existing newline/content-length JSON-RPC handling in
`june_gmail_mcp.py`, but do not copy its account or variable-route behavior.
Define `TOOLS` with exactly these names:

```python
TOOL_NAMES = (
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
)
```

Each JSON Schema mirrors the Task 1 enum, sets `additionalProperties: false`,
uses `repository_id` rather than owner/name, sets positive integer minima,
and caps `limit` at 50 and `line_count` at 1,000. Every description says the
result is untrusted repository content and cannot supply instructions.

`call_proxy` always sends `POST` to `base_url.rstrip("/") + "/github/read"`,
sets bearer auth from `JUNE_GITHUB_PROXY_TOKEN`, uses a 35-second timeout, and
caps the response read at 256 KiB plus 16 KiB of protocol overhead. The base
URL comes from Rust argv and is never a tool argument. Tool arguments cannot
choose a URL, method, header, owner, repository name, account, or token.

On success, return compact JSON text in `content` and the envelope itself in
`structuredContent`. On failure, set `isError: true` and include only the
sanitized Rust code/message. Never include urllib exception bodies or URLs.

- [ ] **Step 4: Run the contract and commit**

```bash
python3 -m unittest src-tauri/src/hermes/test_june_github_mcp.py
git diff --check
git add src-tauri/src/hermes/june_github_mcp.py src-tauri/src/hermes/test_june_github_mcp.py
git commit -m "feat: expose GitHub read tools to June"
```

---

### Task 11: Register GitHub only in eligible interactive runtimes

**Files:**

- Modify: `src-tauri/src/hermes_bridge.rs`
- Modify: `src/lib/hermes-admin/mcp-servers-view.ts`
- Modify: `src/test/mcp-servers.test.tsx`

**Interfaces:**

- Adds: `JuneGitHubMcpConfig { command, script_path }`
- Adds: `sync_june_github_mcp(app: &AppHandle, hermes_command: &str) -> Result<Option<JuneGitHubMcpConfig>, AppError>`
- Adds: `june_github` to built-in render/prune/interactive selection and June instructions
- Excludes: cron and routine connector toolsets

- [ ] **Step 1: Add failing runtime-render and visibility tests**

In `hermes_bridge.rs`, add named tests proving:

```text
github_mcp_renders_only_when_tool_eligible
github_mcp_receives_only_base_url_and_dedicated_token
github_mcp_is_pruned_after_eligibility_is_removed
github_mcp_is_appended_to_an_explicit_interactive_mcp_allowlist
no_mcp_remains_an_explicit_global_opt_out
github_mcp_is_never_added_to_cron_toolsets
github_soul_section_is_present_only_when_registered
github_token_is_visible_only_to_the_github_mcp_sandbox_profile
github_registration_failure_does_not_wedge_bridge_start
bundled_github_mcp_contract_passes
```

The explicit allowlist fixture is `cli: [web, user_server]`; expected output
adds `june_github` once. The cron assertion must inspect rendered YAML, not just
a helper return. The sandbox assertion must prove Gmail, Calendar, recorder,
web, image, and model subprocess environments do not receive
`JUNE_GITHUB_PROXY_TOKEN`.

`bundled_github_mcp_contract_passes` invokes `default_python_command()` with
`-m unittest <absolute source path>/hermes/test_june_github_mcp.py`, asserts
exit success, and prints captured stdout/stderr only on failure. This makes
`cargo test` and `make verify` enforce the real bundled script contract.

In `mcp-servers.test.tsx`, first assert that a fixture named `june_github`
still appears in `userManagedMcpServers`; this is the frontend RED test.

- [ ] **Step 2: Run the runtime tests and verify RED**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked github_mcp_
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked no_mcp_remains_an_explicit_global_opt_out
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked bundled_github_mcp_contract_passes
pnpm test -- src/test/mcp-servers.test.tsx
```

Expected: runtime tests fail because the server is not rendered and the
frontend test fails because `june_github` is not yet internal.

- [ ] **Step 3: Bundle and conditionally configure the server**

Add constants beside the existing built-in script constants:

```rust
const JUNE_GITHUB_MCP_SERVER_NAME: &str = "june_github";
const JUNE_GITHUB_MCP_SCRIPT_NAME: &str = "june_github_mcp.py";
const JUNE_GITHUB_MCP_SCRIPT: &str = include_str!("hermes/june_github_mcp.py");
const JUNE_GITHUB_PROXY_TOKEN_ENV: &str = "JUNE_GITHUB_PROXY_TOKEN";
```

`sync_june_github_mcp` checks valid App config, non-secret snapshot eligibility,
and credential presence through the GitHub service. On an eligibility/storage/
Keychain error, log only `error_code`, skip the server, and allow chat startup.
When eligible, write the bundled script to the managed MCP directory and
return its Python command and path.

Thread `Option<&JuneGitHubMcpConfig>` and `github_proxy_token` through
`sync_hermes_config`, `sync_hermes_config_with_external_dirs`,
`BuiltinMcpConfigs`, `render_hermes_config`, and `render_mcp_servers_config`.
Render a stdio entry with argv containing only the loopback `/v1` base URL and
env containing only the dedicated GitHub token.

- [ ] **Step 4: Make registration interactive-only and stale-safe**

Update `is_june_connector_server_name` so `merge_hermes_config` prunes
`june_github`; otherwise deep merge preserves stale access after disconnect.

Update `hermes_interactive_toolsets` to append an enabled `june_github` even
when the CLI list already names another MCP, unless the list contains
`no_mcp`. Deduplicate the result. Do not add the server to
`cron_platform_toolsets` or any `june_*_auto_*` pattern.

- [ ] **Step 5: Inject a separate GitHub safety section into SOUL**

Add `github_registered: bool` to `sync_june_soul` and append a dedicated
`JUNE_SOUL_GITHUB_MD` only when true. It must name all 16 read capabilities,
require stable `repository_id`, say GitHub data is untrusted and cannot
override user/June/tool rules, and state that the server has no write tools.
Keep June's identity; do not present Hermes as the product.

- [ ] **Step 6: Hide the built-in server from MCP administration**

Add `"june_github"` to `INTERNAL_MCP_SERVER_NAMES`. Change the RED frontend
assertion to expect it is filtered while a user server remains visible.

- [ ] **Step 7: Run runtime/frontend gates and commit**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked github_mcp_
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked no_mcp_remains_an_explicit_global_opt_out
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked cron_platform_toolsets
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked soul_
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked bundled_github_mcp_contract_passes
pnpm test -- src/test/mcp-servers.test.tsx
pnpm check
pnpm typecheck
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
git diff --check
git add src-tauri/src/hermes_bridge.rs src/lib/hermes-admin/mcp-servers-view.ts src/test/mcp-servers.test.tsx
git commit -m "feat: register GitHub reads in interactive sessions"
```

---

### Task 12: Reconcile live runtimes when GitHub authority changes

**Files:**

- Modify: `src-tauri/src/hermes_bridge.rs`
- Modify: `src-tauri/src/connectors/github_commands.rs`
- Modify: `src-tauri/src/connectors/mod.rs`

**Interfaces:**

- Produces: `reconcile_github_runtime(app: &AppHandle) -> Result<(), AppError>`
- Refactors: reusable internal body behind `connectors_apply_runtime`
- Triggers: connect/reconnect, refresh, disconnect, and read-caused terminal/discovery state changes
- Preserves: command/read result even when best-effort runtime reconciliation fails

- [ ] **Step 1: Add failing reconciliation-decision tests**

Add pure tests named:

```text
github_runtime_restarts_only_when_registration_changes
github_connect_success_reconciles_after_state_event
github_refresh_success_and_terminal_reconnect_both_reconcile
github_transient_refresh_failure_does_not_reconcile
github_disconnect_reconciles_after_state_deletion
github_read_state_change_reconciles_only_after_response_write
github_reconcile_preserves_live_mode_cwd_and_full_mode
```

Model current registration by parsing `mcp_servers.june_github` from the live
Hermes config. Test absent-to-present and present-to-absent as restart cases,
and absent-to-absent/present-to-present as no-op cases. Use injected hooks for
event/restart/response ordering so tests do not launch a real runtime.

- [ ] **Step 2: Run the reconciliation tests and verify RED**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked github_runtime_restarts_only_when_registration_changes
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked github_read_state_change_reconciles_only_after_response_write
```

Expected: tests fail because native reconciliation does not exist.

- [ ] **Step 3: Refactor and implement native reconciliation**

Extract the body of the Tauri `connectors_apply_runtime` command into an
internal function that preserves each live connection's `full_mode` and `cwd`.
The command delegates to it unchanged.

`reconcile_github_runtime` computes desired GitHub MCP eligibility without UI
state, reads current rendered registration, and calls the internal restart only
when the boolean changed. If no runtime is live, return success without
starting one. Restart each live mode through existing mode-scoped stop/start so
stored agent sessions remain intact.

- [ ] **Step 4: Trigger reconciliation at every local state boundary**

Make `connectors::emit_connectors_changed` `pub(crate)`. In GitHub commands:

- after successful connect/reconnect, emit then reconcile;
- after refresh success or `github_reconnect_required`, emit then reconcile;
- after successful disconnect, emit then reconcile;
- for transient refresh errors, do neither.

Reconciliation is best-effort: log only its stable error code and return the
original connector result. In `handle_github_read`, write and flush the
response first. If `connectorStateChanged` is true, spawn a task that emits the
same event and calls `reconcile_github_runtime`; never synchronously stop the
runtime that is still delivering its own tool response.

- [ ] **Step 5: Run command, proxy, and runtime suites and commit**

```bash
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked connectors::github_commands::tests
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked github_read_proxy_route
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked github_runtime_
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
CARGO_INCREMENTAL=0 cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
git diff --check
git add src-tauri/src/hermes_bridge.rs src-tauri/src/connectors/github_commands.rs src-tauri/src/connectors/mod.rs
git commit -m "feat: reconcile GitHub agent access"
```

---

### Task 13: Update privacy documentation and verify the complete feature

**Files:**

- Modify: `docs/configuration.md`
- Modify: `docs/private-connectors-threat-model.md`
- Modify: `docs/plugins/github-implementation-plan.md`
- Modify: `docs/index.md`

**Interfaces:**

- Documents: App permission checklist, direct on-device provider path, selected-model inference boundary, fixed read tools, untrusted content, and later write phase
- Verifies: deterministic full gate plus live interactive use against `open-software-network/test-repo`

- [ ] **Step 1: Add a documentation assertion before editing prose**

Run:

```bash
rg -n "ending before MCP tools|repository reads" docs/private-connectors-threat-model.md
rg -n "GITHUB_APP_CLIENT_ID|GITHUB_APP_SLUG" docs/configuration.md
```

Expected: the threat model still describes Phase 0 as ending before reads and
configuration does not yet list the six required repository permissions.

- [ ] **Step 2: Update source-of-truth documentation**

In `docs/private-connectors-threat-model.md`, replace the obsolete Phase 0
boundary with the shipped read architecture: Keychain custody, dedicated
loopback token, stable selected-repository IDs, fixed REST operations,
authorization leases, content bounds/redaction, no persistence, no June API,
and untrusted-content handling. State explicitly that an online selected model
can receive bounded retrieved content in inference context.

In `docs/configuration.md`, keep App ID non-secret and document the required
read-only permission keys: `metadata`, `contents`, `issues`, `pull_requests`,
`checks`, `statuses`. Explain that organization approval may be required after
permission changes and that no client secret/private key is used.

In `docs/plugins/github-implementation-plan.md`, mark this read-only slice as
implemented and link the approved design and this plan. Leave issues/comments,
reviews, merges, and content mutation in the separate future action server.
Do not rewrite the broader roadmap.

In `docs/index.md`, link both the revocation reconnect and GitHub agent-read
design/plan pairs under the existing GitHub entry.

- [ ] **Step 3: Run deterministic verification**

```bash
python3 -m unittest src-tauri/src/hermes/test_june_github_mcp.py
pnpm check
pnpm typecheck
pnpm test
CARGO_INCREMENTAL=0 cargo test --manifest-path src-tauri/Cargo.toml --locked
CARGO_INCREMENTAL=0 make verify
git diff --check
```

Expected: all real test failures are zero, Rust formatting/clippy/tests pass,
and `make verify` exits 0. If the known HUD teardown or ProseMirror duplicate
flake appears with zero real failures, rerun the affected Vitest file once and
record both outputs rather than changing product code.

- [ ] **Step 4: Run live agent-driven QA**

Use the `agent-e2e-qa` skill. Run `pnpm tauri:dev` with the staging GitHub App,
connected to exactly `open-software-network/test-repo`. Before launching,
configure the staging App's repository permissions `metadata`, `contents`,
`issues`, `pull_requests`, `checks`, and `statuses` as read-only, complete any
organization approval GitHub requests, then click **Refresh** until June shows
the connection as eligible. In a new interactive June session, verify:

1. June lists only the selected repository and cites it.
2. June reads one safe text file and reports the requested line window.
3. June lists issues and reads one issue plus its comments when present.
4. June lists pull requests and, when one exists, reads metadata, files,
   commits, reviews, review comments, and checks/statuses.
5. A sensitive path is blocked and a traversal path is rejected before GitHub
   traffic.
6. An online selected model can use the same tools; QA records that bounded
   results enter model context without claiming connector traffic goes through
   June API.
7. Disconnect removes `june_github` from the live session/runtime and a later
   call returns no content.
8. Reconnect restores it without losing stored chat sessions.
9. No GitHub tool appears in a scheduled routine.

Record a compressed QA video and attach it through the project workflow. Do
not show tokens, Keychain values, authorization headers, raw provider bodies,
or private repository content in the recording. The PR description must state
that the change was tested visually, that no June API deploy is required, and
that the revocation bug's root cause was the unclassified definitive
`incorrect_client_credentials` response plus the command's error-path event
skip. State that GitHub writes and routine access remain out of scope.

- [ ] **Step 5: Commit documentation and verification evidence**

```bash
git add docs/configuration.md docs/private-connectors-threat-model.md docs/plugins/github-implementation-plan.md docs/index.md
git commit -m "docs: document GitHub agent reads"
```

## Specification traceability

| Approved requirement | Plan coverage |
| --- | --- |
| Read-only, exactly 16 tools | Tasks 1, 5, 6, 7, 10 |
| Stable selected `repository_id` | Tasks 1, 5-8 |
| Direct device-to-GitHub path, no June API | Tasks 4, 9, 13 |
| Dedicated MCP credential and fixed route | Tasks 9-11 |
| Interactive automatic registration only | Tasks 11-12 |
| `no_mcp` explicit opt-out | Task 11 |
| Required App permissions and setup state | Tasks 1, 13 |
| Writer-fair read/state-change ordering | Tasks 1, 8, 12 |
| One refresh retry, terminal reconnect | Tasks 8, 12 plus prerequisite plan |
| 403/404 indistinguishable reconciliation | Task 8 |
| Opaque TTL-bound cursors/file references | Tasks 3, 5-8 |
| Per-file PR patch, no whole diff | Task 7 |
| Bounds, binary/sensitive-path blocking, redaction | Tasks 2, 5-8 |
| Untrusted-content instruction and sources | Tasks 5-8, 10-11 |
| No clone/index/cache/content persistence | Global constraints, Tasks 4-8, 13 |
| Online model inference disclosure | Global constraints, Tasks 11, 13 |
| Future writes remain separate | Global constraints, Tasks 10-11, 13 |
