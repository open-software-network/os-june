# GitHub agent-read capability isolation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared GitHub bearer/MCP path with a macOS peer-pid-authenticated Unix-domain broker and verified bundled `june_github` tool extension, while preserving the existing 16 read operations and selected-repository policy.

**Architecture:** Rust starts one broker per eligible interactive dashboard runtime, admits exactly the pid and generation June spawned, and executes the existing `GitHubReadService` over a bounded framed protocol. A verified first-party Hermes backend extension registers the 16 tools and uses one persistent broker connection; shared config contains no GitHub authority, and cron, `no_mcp`, unsupported platforms, unverified runtime sources, and separate child processes fail closed.

**Tech Stack:** Rust 2021, Tokio Unix sockets and async I/O, macOS `LOCAL_PEERPID`, Tauri runtime resources, Python 3.11 standard library, pinned Hermes `PluginContext.register_tool`, Vitest, Rust unit/integration tests, Python `unittest`, shell/PowerShell runtime bundlers.

---

## Scope and file structure

This remains one plan because neither half is independently useful: the Rust
broker has no agent caller without the bundled extension, and the extension has
no authority or provider path without the broker.

**Create:**

- `src-tauri/src/hermes_bridge/github_read_broker.rs` - framing, peer-pid
  admission, lifecycle, fixed public outcome serialization, and broker tests.
- `src-tauri/resources/hermes-plugins/june_github/plugin.yaml` - pinned Hermes
  backend-extension manifest with the exact 16 tool names.
- `src-tauri/resources/hermes-plugins/june_github/__init__.py` - schemas,
  validation, persistent Unix-socket client, handlers, and registration.
- `src-tauri/src/hermes/test_june_github_plugin.py` - stdlib contract and live
  fake-broker tests for the bundled extension.

**Modify:**

- `src-tauri/src/hermes_bridge.rs` - broker lifecycle, eligibility and toolset
  selection, plugin overlay verification, stale MCP pruning, sandbox roots, and
  removal of the GitHub bearer/provider-proxy route.
- `src-tauri/src/connectors/github_read.rs` - expose the existing request and
  public outcome types only as needed by the broker; operation policy stays
  unchanged.
- `src-tauri/tauri.conf.json` - bundle the first-party extension source.
- `src-tauri/build.rs` - watch and validate the extension resource.
- `scripts/bundle-hermes-runtime.sh` - overlay and self-test the extension in
  the signed macOS runtime.
- `scripts/bundle-hermes-runtime-windows.ps1` - create the same deterministic
  runtime overlay, even though Windows exposure remains disabled.
- `scripts/hermes-smoke.ts` - exercise the overlay against the real pinned
  Hermes plugin loader and tool registry.
- `src/lib/hermes-admin/mcp-servers-view.ts` and
  `src/test/mcp-servers.test.tsx` - keep the removed legacy server hidden while
  stale config migrates away.
- `docs/private-connectors-threat-model.md`, `docs/configuration.md`, and
  `docs/index.md` - record the enforced boundary, platform gate, and same-process
  extension limitation.

**Delete after the replacement path is green:**

- `src-tauri/src/hermes/june_github_mcp.py`
- `src-tauri/src/hermes/test_june_github_mcp.py`

## Invariants for every task

- Never log frame bodies, repository content, credentials, socket payloads, or
  provider responses.
- Never add a generic URL, HTTP method, header, repository name, installation
  id, or provider path to the broker protocol.
- Keep `GitHubReadService::execute` and all repository/permission/revocation
  revalidation intact.
- Keep the old bearer path until the new broker path is proven, then remove it
  in the same migration before calling the feature complete.
- Commit each task separately and run `git diff --check` before every commit.

### Task 1: Add the bounded GitHub read broker protocol

**Files:**

- Create: `src-tauri/src/hermes_bridge/github_read_broker.rs`
- Modify: `src-tauri/src/hermes_bridge.rs:1-30`
- Modify: `src-tauri/src/connectors/github_read.rs:24-195`

- [ ] **Step 1: Write failing framing and public-outcome tests**

Add `mod github_read_broker;` beside the imports in `hermes_bridge.rs`. In the
new module, first add a socket-pair round trip using the intended helpers:

```rust
#[tokio::test]
async fn github_read_broker_round_trips_one_typed_request() {
    let (mut client, server) = tokio::net::UnixStream::pair().expect("socket pair");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let executor = recording_executor(seen.clone(), serde_json::json!({
        "success": true,
        "result": {"trust": "untrusted_repository_content", "data": {"ok": true}},
        "connectorStateChanged": false
    }));
    let state = AdmissionState::Active {
        pid: std::process::id(),
        generation: 1,
    };
    let task = tokio::spawn(serve_admitted_connection(
        server,
        executor,
        watch::channel(state).1,
        REQUEST_DEADLINE,
    ));
    write_request_frame(&mut client, &serde_json::json!({
        "operation": "get_repository",
        "arguments": {"repository_id": "789"}
    })).await.expect("write request");
    let response = read_response_frame(&mut client).await.expect("read response");
    assert_eq!(response["success"], true);
    assert!(matches!(seen.lock().expect("seen").as_slice(),
        [GitHubReadRequest::GetRepository { repository_id }] if repository_id == "789"));
    drop(client);
    task.await.expect("serve task").expect("serve result");
}
```

Add three more tests using the same helpers:

- `github_read_broker_rejects_request_larger_than_64_kib_before_json` writes
  `(MAX_REQUEST_BYTES + 1) as u32` as the prefix without a body and asserts the
  fixed input-invalid envelope.
- `github_read_broker_maps_unknown_errors_to_sanitized_unavailable` passes
  `AppError::new("internal_path_leak", "/Users/example/secret")` to
  `public_error` and asserts neither the private code nor message is present.
- `github_read_broker_caps_serialized_responses_at_256_kib` passes a success
  value containing `"x".repeat(MAX_RESPONSE_BYTES)` to `bounded_response` and
  asserts the fixed `github_response_too_large` error.

Use a test executor that records the deserialized `GitHubReadRequest` and
returns a fixed JSON outcome. Assert that an unknown operation becomes:

```json
{"success":false,"error":{"code":"github_input_invalid","message":"GitHub input is invalid."},"connectorStateChanged":false}
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml github_read_broker -- --nocapture
```

Expected: compilation fails because `github_read_broker` and its frame helpers
do not exist.

- [ ] **Step 3: Implement the minimal fixed protocol**

Expose `GitHubReadRequest`, `GitHubReadEnvelope`, and `GitHubReadOutcome` to the
bridge submodule with `pub(crate)` only. Do not make provider internals public.
Use these exact constants and executor seam:

```rust
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const REQUEST_DEADLINE: Duration = Duration::from_secs(35);

type BoxResponseFuture = Pin<Box<dyn Future<Output = serde_json::Value> + Send>>;
type RequestExecutor =
    Arc<dyn Fn(GitHubReadRequest) -> BoxResponseFuture + Send + Sync + 'static>;
```

Implement `read_frame`, `write_frame`, `bounded_response`, `public_success`,
and `public_error`.
`read_frame` reads the 4-byte length before allocating and returns a typed
`FrameError::TooLarge` for any value above `MAX_REQUEST_BYTES`. `write_frame`
serializes first; if the result exceeds `MAX_RESPONSE_BYTES`, replace it with:

```rust
public_error(
    AppError::new(
        "github_response_too_large",
        "GitHub content exceeds the response limit.",
    ),
    false,
)
```

Move the stable error-code mapping currently in
`github_read_error_response` into a pure `public_error` helper. Preserve the
rate-limit `retryAfterSeconds.min(86_400)` behavior. The broker protocol has no
HTTP status field.

- [ ] **Step 4: Run focused tests and formatting**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml github_read_broker -- --nocapture
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Expected: all `github_read_broker` tests pass; rustfmt reports no diff.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/hermes_bridge.rs src-tauri/src/hermes_bridge/github_read_broker.rs src-tauri/src/connectors/github_read.rs
git commit -m "feat: define GitHub read broker protocol"
```

### Task 2: Enforce macOS peer-pid admission and revocation

**Files:**

- Modify: `src-tauri/src/hermes_bridge/github_read_broker.rs`

- [ ] **Step 1: Write failing kernel-admission tests**

Add macOS-gated tests with these exact arrangements and assertions:

- `registered_dashboard_pid_reuses_one_persistent_connection`: start with the
  recording executor, authorize `(std::process::id(), 7)`, connect once, send
  two `list_repositories` frames, and assert two successful replies plus one
  accepted connection.
- `same_user_child_process_is_rejected_even_with_socket_path`: authorize the
  current test pid, spawn the helper child, and assert it reads EOF without the
  executor count changing.
- `second_connection_cannot_reuse_consumed_admission`: establish the authorized
  first connection, connect again from the same test process, and assert the
  second stream reads EOF while the first still completes another frame.
- `revoked_or_wrong_generation_cannot_return_another_frame`: assert generation
  8 cannot consume generation 7, then revoke generation 7 and assert the live
  connection closes before another executor call.
- `broker_socket_is_owner_only_and_stalled_calls_time_out`: assert
  `metadata.permissions().mode() & 0o777 == 0o600`, start through the test seam
  with a 25 ms deadline, leave a frame incomplete for 50 ms, and assert EOF
  without reopening admission. Production always passes
  `REQUEST_DEADLINE` (35 seconds); do not enable Tokio's `test-util` feature.

The child test must spawn the current test binary with a helper-test environment
flag or a stdlib Python one-liner. It receives only the socket path and attempts
one valid frame. Never pass a token fixture.

- [ ] **Step 2: Run the kernel tests and confirm RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml github_read_broker -- --nocapture
```

Expected: the peer-admission tests fail because any process can still connect.

- [ ] **Step 3: Implement the broker lifecycle**

Add this public surface, keeping the test-only executor constructor private to
the module:

```rust
pub(super) struct GitHubReadBroker {
    socket_path: PathBuf,
    admission: Arc<Mutex<Admission>>,
    state_tx: watch::Sender<AdmissionState>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl GitHubReadBroker {
    pub(super) async fn start(
        app: &AppHandle,
        service: Arc<GitHubReadService>,
        socket_dir: &Path,
        generation: u64,
    ) -> Result<Self, AppError>;

    pub(super) fn socket_path(&self) -> &Path;
    pub(super) fn authorize_interactive(&self, pid: u32, generation: u64) -> Result<(), AppError>;
    pub(super) fn revoke_interactive(&self, pid: u32, generation: u64);
}
```

`Admission` stores `pid`, `generation`, and `consumed`. Accepting a peer checks
the kernel pid while holding the admission mutex, marks the exact matching
entry consumed, and then serves only that connection. An unregistered peer is
dropped without changing admission. `watch` closes an accepted connection as
soon as its generation is revoked. `Drop` sends shutdown and removes the socket
file best-effort.

Immediately after binding, set the socket's permissions with
`std::os::unix::fs::PermissionsExt::from_mode(0o600)` and fail startup if that
cannot be enforced. Serve frames sequentially on the admitted connection and
wrap the future for each read-execute-write cycle in
`tokio::time::timeout(REQUEST_DEADLINE, frame_future)`; a timed-out connection
closes without reopening admission.

On macOS, implement peer lookup with `getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID)`
through a small `unsafe extern "C"` declaration using `std::ffi::c_void` and
`std::os::fd::AsRawFd`; add a `// SAFETY:` comment covering the valid fd,
correctly sized output buffer, and initialized length. Do not add a dependency.
On every other platform, `start` returns stable code
`github_read_broker_unsupported` before binding anything.

The production executor loads `commands::repositories(app)`, calls
`service.execute(request, &PlatformGitHubTokenVault, &repositories)`, and maps
the outcome through Task 1's pure response helper.

- [ ] **Step 4: Run focused tests and Clippy**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml github_read_broker -- --nocapture
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: current-pid persistent calls pass; child, second-connection, revoke,
and generation tests fail closed; Clippy emits no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/hermes_bridge/github_read_broker.rs
git commit -m "feat: authenticate GitHub broker peers"
```

### Task 3: Replace the MCP process with a bundled Hermes tool extension

**Files:**

- Create: `src-tauri/resources/hermes-plugins/june_github/plugin.yaml`
- Create: `src-tauri/resources/hermes-plugins/june_github/__init__.py`
- Create: `src-tauri/src/hermes/test_june_github_plugin.py`

- [ ] **Step 1: Write failing plugin contract tests**

Load the extension by file path with a recording `PluginContext` stub. Assert:

- the manifest is `kind: backend` and lists exactly the 16 approved names;
- `register(ctx)` registers each name once with `toolset="june_github"`;
- every schema has `additionalProperties: false` and matches the old MCP schema;
- absent `JUNE_GITHUB_BROKER_SOCKET` returns only the sanitized unavailable
  result;
- a fake Unix broker receives `{"operation": name, "arguments": args}` and no
  URL, method, header, token, repository name, or installation id;
- two calls use one accepted socket;
- 256 KiB + 1 responses and malformed frames fail closed; and
- a token-like sentinel from broker output never reaches the returned string.

Run:

```bash
python3 -m unittest src-tauri/src/hermes/test_june_github_plugin.py -v
```

Expected: import fails because the extension resource does not exist.

- [ ] **Step 2: Add the exact manifest**

Create:

```yaml
name: june_github
version: 0.1.0
description: "June's fixed read-only GitHub tools over the on-device broker."
author: Open Software Network
kind: backend
provides_tools:
  - list_repositories
  - get_repository
  - list_directory
  - read_file
  - search_code
  - list_issues
  - get_issue
  - list_issue_comments
  - list_pull_requests
  - get_pull_request
  - list_pull_request_files
  - read_pull_request_file_diff
  - list_pull_request_commits
  - list_pull_request_reviews
  - list_pull_request_review_comments
  - list_pull_request_checks
```

- [ ] **Step 3: Port schemas and implement the persistent client**

Move the schema helpers and all 16 definitions from
`src-tauri/src/hermes/june_github_mcp.py` into the extension, changing each
registry schema from MCP's `inputSchema` wrapper to:

```python
{
    "name": name,
    "description": f"{purpose} {UNTRUSTED_CONTENT_WARNING}",
    "parameters": _object_schema(properties, required),
}
```

Use these exact transport constants and client shape:

```python
BROKER_SOCKET_ENV = "JUNE_GITHUB_BROKER_SOCKET"
REQUEST_TIMEOUT_SECONDS = 35
MAX_REQUEST_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 256 * 1024
CONNECT_RETRY_SECONDS = 2.0

class _BrokerClient:
    def __init__(self, socket_path: str) -> None:
        self._socket_path = socket_path
        self._socket: socket.socket | None = None
        self._lock = threading.Lock()

    def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        body = _compact_json(payload).encode("utf-8")
        if len(body) > MAX_REQUEST_BYTES:
            raise BrokerFailure(INPUT_ERROR_CODE, INPUT_ERROR_MESSAGE)
        with self._lock:
            connection = self._connect_once_with_bounded_retry()
            connection.sendall(struct.pack(">I", len(body)) + body)
            size = struct.unpack(">I", _recv_exact(connection, 4))[0]
            if size > MAX_RESPONSE_BYTES:
                self._close()
                raise unavailable()
            return _validate_response(_recv_exact(connection, size))
```

Every connected socket calls `settimeout(REQUEST_TIMEOUT_SECONDS)`. The bounded
connect retry sleeps at most 50 ms between attempts and stops after
`CONNECT_RETRY_SECONDS`; after a previously admitted persistent socket drops,
one failed reconnect is sanitized as unavailable and no new authority is
invented.

`register(ctx)` constructs one client, makes one closure per tool name, and
calls:

```python
ctx.register_tool(
    name=name,
    toolset="june_github",
    schema=schema,
    handler=_handler,
    check_fn=lambda: bool(os.environ.get(BROKER_SOCKET_ENV)),
)
```

Handlers validate the existing schema, send only the tagged request, return the
compact `result` object for `success: true`, and return
`{"error": message, "code": code}` for a safe fixed error. They never include
exception text, socket paths, frame bodies, or environment values.

- [ ] **Step 4: Run the standalone and syntax tests**

Run:

```bash
python3 -m unittest src-tauri/src/hermes/test_june_github_plugin.py -v
python3 -m py_compile src-tauri/resources/hermes-plugins/june_github/__init__.py
```

Expected: all contract tests pass and compilation produces no diagnostic.
Remove any generated `__pycache__` before staging.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/resources/hermes-plugins/june_github src-tauri/src/hermes/test_june_github_plugin.py
git commit -m "feat: bundle GitHub read tool extension"
```

### Task 4: Overlay and verify the extension in every managed runtime

**Files:**

- Modify: `src-tauri/tauri.conf.json:129-133`
- Modify: `src-tauri/build.rs:8-28`
- Modify: `scripts/bundle-hermes-runtime.sh:90-130,160-320`
- Modify: `scripts/bundle-hermes-runtime-windows.ps1:150-410`
- Modify: `src-tauri/src/hermes_bridge.rs:35-45,5840-6255,6490-6685`
- Modify: `scripts/hermes-smoke.ts`

- [ ] **Step 1: Write failing overlay and immutability tests**

Add Rust tests with these exact operations:

- `managed_github_plugin_overlay_replaces_tampered_files_with_embedded_bytes`
  writes `tampered` to both files in a temporary
  `hermes-agent/plugins/june_github`, calls
  `sync_managed_june_github_plugin`, and asserts both bytes equal the two
  `include_bytes!` constants.
- `unsupported_or_user_local_runtime_source_disables_github_extension` asserts
  `false` for `EnvOverride`, `UserLocalFallback`, and `PathFallback`, without
  reading those command paths.
- `sandbox_write_roots_exclude_managed_runtime_and_plugin_source` asserts the
  canonical managed runtime and resource plugin paths are absent from the
  returned write roots and from generated SBPL `allow file-write*` subpaths.

Extend `scripts/hermes-smoke.ts` to copy the resource into the pinned checkout,
load bundled plugins, and assert the registry reports the exact `june_github`
tool names under one toolset. Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml github_plugin -- --nocapture
pnpm test:hermes-smoke
```

Expected: Rust helpers are missing and Hermes smoke cannot discover the overlay.

- [ ] **Step 2: Bundle the signed source resource**

Add this resource mapping:

```json
"resources/hermes-plugins": "native/hermes-plugins"
```

Make `build.rs` emit `cargo:rerun-if-changed` for both extension files and fail
the build when the manifest's `provides_tools` set differs from the canonical
16 names. Parse only the `provides_tools:` block with the standard library;
do not add a build dependency.

- [ ] **Step 3: Overlay both release runtimes deterministically**

In the macOS bundler, add a `sync_june_plugins` function that deletes only
`$out/hermes-agent/plugins/june_github`, recreates it, copies `plugin.yaml` and
`__init__.py` from the repository resource, and verifies each destination with
`cmp -s`. Call it for both cached and newly built runtime paths before signing
and `run_self_test`. Extend `run_self_test` to import the extension with the
pinned plugin loader and assert all 16 registry entries.

Implement the same two-file replacement and SHA-256 comparison in the Windows
bundler with `Copy-Item -Force` and `Get-FileHash -Algorithm SHA256`. Windows
builds carry the deterministic overlay for parity, but Task 5 still omits its
toolset until a named-pipe peer-pid broker exists.

- [ ] **Step 4: Verify the managed fallback before each spawn**

Embed the two canonical resource files with `include_bytes!`. Add:

```rust
fn sync_managed_june_github_plugin(install_dir: &Path) -> Result<PathBuf, AppError>;

fn github_plugin_verified_for_source(
    app: &AppHandle,
    source: HermesCommandSource,
) -> Result<bool, AppError>;
```

The managed helper atomically replaces both destination files from embedded
bytes and reads them back for an exact byte comparison. The bundled-runtime
helper verifies the two files under its signed `hermes-agent/plugins` tree.
`EnvOverride`, `UserLocalFallback`, and `PathFallback` return `false`; they do
not load a privileged extension from an unverified origin.

Call managed overlay synchronization after every successful current-runtime
resolution, not just a fresh install, so an unchanged Hermes pin still receives
extension updates.

Set `PYTHONDONTWRITEBYTECODE=1` in `apply_isolated_hermes_env`. Change
`sandbox_write_roots` to omit `managed_hermes_runtime_dir`; keep only
`hermes_home`, the scoped temp directories, and their existing explicit config
write grants. The existing sandbox execution probe must prove that Python still
starts and that neither runtime nor extension source is writable.

- [ ] **Step 5: Run overlay, smoke, shell, and sandbox gates**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml github_plugin -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml sandbox_ -- --nocapture
python3 -m unittest src-tauri/src/hermes/test_june_github_plugin.py -v
bash -n scripts/bundle-hermes-runtime.sh
pnpm test:hermes-smoke
```

If `pwsh` is installed, also run:

```bash
pwsh -NoProfile -Command '$null = [System.Management.Automation.Language.Parser]::ParseFile("scripts/bundle-hermes-runtime-windows.ps1", [ref]$null, [ref]$null)'
```

Expected: all available gates pass; the smoke test reports exactly 16
`june_github` tools.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/build.rs src-tauri/src/hermes_bridge.rs scripts/bundle-hermes-runtime.sh scripts/bundle-hermes-runtime-windows.ps1 scripts/hermes-smoke.ts
git commit -m "feat: verify bundled GitHub tool extension"
```

### Task 5: Wire the broker only into eligible interactive dashboards

**Files:**

- Modify: `src-tauri/src/hermes_bridge.rs:430-500,1040-1335,7040-7140,7400-7555,8240-8280,5780-5840`
- Modify: `src-tauri/src/hermes_bridge/github_read_broker.rs`

- [ ] **Step 1: Write failing eligibility and lifecycle tests**

Replace MCP-registration-specific expectations with tests that exercise the
real in-memory SQLite snapshot and test vault already introduced in commit
`8abd0355`:

- `eligible_interactive_start_selects_tool_sets_socket_and_authorizes_spawned_pid`
  uses a valid App config, connected snapshot, selected repository, all six
  read permissions, and a stored token; it asserts the selected toolsets equal
  the prior interactive list plus one `june_github`, the child environment has
  one socket path, and the broker admission equals the spawned fake pid and
  generation.
- `invalid_app_config_snapshot_permission_or_custody_starts_without_github`
  runs the existing table of invalid App config, status, selection, each
  missing permission, missing token, and vault error; every row asserts bridge
  config still renders while toolset, socket env, and SOUL omit GitHub.
- `no_mcp_omits_github_toolset_and_soul_even_when_eligible` renders
  `platform_toolsets.cli: [hermes-cli, no_mcp]`, passes `true` availability,
  and asserts both outputs omit `june_github`.
- `cron_and_unrestricted_routine_lists_never_include_june_github` checks the
  exact cron and frontend unrestricted lists rather than a substring only.
- `spawn_failure_readiness_failure_stop_and_restart_revoke_broker_generation`
  drives each existing bridge cleanup seam and asserts the prior generation is
  absent and its socket rejects a frame before the replacement is authorized.
- `broker_service_bind_or_setup_failure_starts_the_dashboard_without_github`
  injects failures from service construction and broker bind, then asserts the
  ordinary dashboard still starts with no socket env, toolset, or SOUL section.

Also assert `config.yaml`, the dashboard arguments, and every sibling MCP env
map contain neither `JUNE_GITHUB_PROXY_TOKEN` nor any token-like fixture.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml github_ -- --nocapture
```

Expected: lifecycle tests fail because startup still registers an MCP and has
no broker socket or pid admission.

- [ ] **Step 3: Replace registration with availability**

Replace `JuneGitHubMcpConfig`, `sync_june_github_mcp*`, and
`complete_github_registration_for_bridge_start` with:

```rust
async fn github_read_tool_eligible(
    app: &AppHandle,
    source: HermesCommandSource,
) -> bool {
    if !cfg!(target_os = "macos")
        || !github_plugin_verified_for_source(app, source).unwrap_or(false)
    {
        return false;
    }
    let result = async {
        crate::connectors::github::github_app_config()?;
        let repositories = crate::commands::repositories(app).await?;
        crate::connectors::github::github_tool_eligibility(
            &crate::connectors::github::PlatformGitHubTokenVault,
            &repositories,
        )
        .await
    }
    .await;
    if let Err(error) = &result {
        tracing::warn!(error_code = %error.code, "GitHub read tool skipped");
    }
    result.is_ok()
}
```

Keep dependency-injected versions for the full eligibility matrix; production
logs only stable codes.

Change `hermes_interactive_toolsets` to accept `github_available: bool`. It
appends `june_github` only when that flag is true and literal `no_mcp` is
absent. It no longer searches `mcp_servers` for GitHub. Derive the SOUL boolean
from the final selected toolsets.

- [ ] **Step 4: Tie one broker to one `HermesProcess`**

Add `github_broker: Option<GitHubReadBroker>` to `HermesProcess`. Allocate the
runtime generation before spawn. Prepare the optional capability without
wedging ordinary bridge startup:

```rust
let mut github_broker = if github_eligible {
    match GitHubReadService::production() {
        Ok(service) => GitHubReadBroker::start(
            app,
            Arc::new(service),
            &app_data_dir.join("grb"),
            generation,
        )
        .await
        .map(Some)
        .unwrap_or_else(|error| {
            tracing::warn!(error_code = %error.code, "GitHub read broker skipped");
            None
        }),
        Err(error) => {
            tracing::warn!(error_code = %error.code, "GitHub read broker skipped");
            None
        }
    }
} else {
    None
};
if let Some(broker) = github_broker.as_ref() {
    cmd.env("JUNE_GITHUB_BROKER_SOCKET", broker.socket_path());
}
```

Derive `github_available`, `HERMES_TUI_TOOLSETS`, and SOUL from
`github_broker.is_some()`, not the earlier eligibility result. A Unix-socket
path-length bind error therefore disables only GitHub and never falls back to
TCP or a bearer.

After `cmd.spawn()` returns, authorize exactly once:

```rust
if let Some(broker) = github_broker.as_ref() {
    if let Err(error) = broker.authorize_interactive(child.id(), generation) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(AppError::new("hermes_bridge_start_failed", error.code));
    }
}
```

Authorization only mutates the broker instance June just created; a poisoned
admission lock is a bridge-integrity failure, while all ordinary GitHub setup,
service, bind, and platform failures were already converted to `None` before
spawn. Store `github_broker` only with the matching process slot.

`shutdown_hermes_process` must revoke `(child.id(), generation)` before killing
the process and dropping the broker. The duplicate-live-process defense and
readiness-failure cleanup must drop the just-created broker without touching a
newer generation.

- [ ] **Step 5: Run focused integration gates**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml github_ -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml no_mcp -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml cron_platform_toolsets -- --nocapture
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: all eligibility, exposure, lifecycle, and kernel-boundary tests pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/hermes_bridge.rs src-tauri/src/hermes_bridge/github_read_broker.rs
git commit -m "feat: bind GitHub reads to interactive runtimes"
```

### Task 6: Remove the obsolete bearer route and MCP implementation

**Files:**

- Modify: `src-tauri/src/hermes_bridge.rs:135-155,455-495,1290-1375,7280-7355,7760-8010,8470-9040,9980-10210,11450-12490,13770-14360`
- Delete: `src-tauri/src/hermes/june_github_mcp.py`
- Delete: `src-tauri/src/hermes/test_june_github_mcp.py`
- Modify: `src/lib/hermes-admin/mcp-servers-view.ts:25-45`
- Modify: `src/test/mcp-servers.test.tsx:155-185`

- [ ] **Step 1: Write failing removal and migration tests**

Add assertions that:

- `/v1/github/read` returns the ordinary 404 response even with the former
  bearer fixture;
- provider proxy state has only provider, recorder, and Google connector
  scoped tokens;
- merged config prunes a stale `mcp_servers.june_github` entry and does not
  re-add it;
- `config.yaml` contains neither `JUNE_GITHUB_PROXY_TOKEN` nor
  `june_github_mcp.py`;
- the admin UI continues hiding a stale legacy `june_github` MCP fixture during
  migration; and
- the bundled Python extension contract is the only 16-tool Python test.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml github_ -- --nocapture
pnpm test -- src/test/mcp-servers.test.tsx
python3 -m unittest src-tauri/src/hermes/test_june_github_plugin.py -v
```

Expected: route/config assertions fail while the bearer fields and MCP files
still exist.

- [ ] **Step 3: Remove the old capability surface**

Delete `JUNE_GITHUB_PROXY_TOKEN_ENV`, script include constants,
`JuneGitHubMcpConfig`, GitHub fields from `SharedProviderProxyInfo`,
`SharedProviderProxy`, and `ProviderProxyState`, and the `GitHubReadService`
owned by the provider proxy.

Remove GitHub token generation, `provider_proxy_required_token`'s GitHub
parameter/branch, the 64 KiB HTTP special case, `handle_github_read`, and the
`POST /v1/github/read` match arm. Keep the broker's fixed outcome mapper.

Remove GitHub from `BuiltinMcpConfigs` and every renderer argument. Retain a
renamed `JUNE_GITHUB_LEGACY_MCP_SERVER_NAME` only in stale-config pruning and
admin hiding until one release has migrated existing homes.

Delete both old MCP Python files. Update the frontend fixture to say explicitly
that it represents legacy config; it must remain hidden and non-editable.

- [ ] **Step 4: Prove no reusable GitHub authority remains**

Run:

```bash
rg -n "JUNE_GITHUB_PROXY_TOKEN|github_token|/v1/github/read|june_github_mcp.py" src-tauri/src/hermes_bridge.rs src-tauri/src/hermes src-tauri/resources src/lib src/test
```

Expected: no token, route, or script matches; only intentional connector token
storage names elsewhere in the repository remain outside this scoped search.

Then run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml github_ -- --nocapture
pnpm test -- src/test/mcp-servers.test.tsx
python3 -m unittest src-tauri/src/hermes/test_june_github_plugin.py -v
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/hermes_bridge.rs src-tauri/src/hermes src-tauri/resources/hermes-plugins/june_github src/lib/hermes-admin/mcp-servers-view.ts src/test/mcp-servers.test.tsx
git commit -m "fix: remove shared GitHub bearer path"
```

### Task 7: Run adversarial security and pinned-runtime review

**Files:**

- Modify only files required by findings from an independent reviewer.

- [ ] **Step 1: Dispatch an independent standards and security review**

Use a reviewer that did not author Tasks 1-6. Give it the fixed comparison
point `4329f2d8` and require it to attack:

- peer-pid race, pid reuse, second connection, disconnect, stop, restart, and
  generation replacement;
- unregistered gateway, cron, terminal child, user MCP, `no_mcp`, and explicit
  MCP allowlist bypasses;
- plugin origin, user-plugin name collision, managed-runtime tampering, and
  sandbox write roots;
- oversized length prefixes, partial frames, malformed JSON, response overflow,
  socket-path leakage, body logging, and exception leakage;
- any surviving GitHub bearer or arbitrary provider path; and
- preservation of selected-repository, required-permission, revocation,
  finalization, untrusted-content, and source-attribution checks.

- [ ] **Step 2: Reproduce every actionable finding with a failing test**

For each accepted finding, add one narrowly named RED test in the owning Rust,
Python, smoke, or frontend test file. Run only that test and record the failure
before changing implementation.

- [ ] **Step 3: Apply the smallest fix and rerun focused gates**

Do not broaden the protocol or add fallback authority. Rerun the affected test
file plus:

```bash
cargo test --manifest-path src-tauri/Cargo.toml github_ -- --nocapture
python3 -m unittest src-tauri/src/hermes/test_june_github_plugin.py -v
pnpm test:hermes-smoke
```

- [ ] **Step 4: Re-review until no actionable finding remains**

Send the fixed diff back to a reviewer that did not author it. A review that
still reports a capability-isolation defect blocks Task 8.

- [ ] **Step 5: Commit review fixes**

```bash
git add src-tauri src scripts docs
git commit -m "fix: harden GitHub read capability isolation"
```

If the reviewer is clean and no file changed, record the review result in the
session ledger and do not create an empty commit.

### Task 8: Document, fully verify, and run live June QA

**Files:**

- Modify: `docs/private-connectors-threat-model.md`
- Modify: `docs/configuration.md`
- Modify: `docs/index.md`
- Modify: `docs/qa/agent-e2e-qa-runs/2026-07-17-github-agent-reads.md`

- [ ] **Step 1: Update operational and threat-model documentation**

Document these exact facts:

- GitHub credentials remain in Keychain and provider calls originate on-device;
- the interactive capability is a kernel-authenticated broker connection, not
  the socket path and not an MCP bearer;
- separate child processes, the gateway, cron, and `no_mcp` are denied;
- macOS is supported first and other platforms fail closed;
- selected online models may receive bounded repository content as context; and
- user-enabled in-process Hermes backend extensions are same-trust code and are
  not isolated by peer pid.

Do not add a public `JUNE_GITHUB_BROKER_SOCKET` configuration knob; it is an
internal per-start environment value.

- [ ] **Step 2: Run focused static and contract gates**

Run:

```bash
git diff --check 4329f2d8..HEAD
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
python3 -m unittest src-tauri/src/hermes/test_june_github_plugin.py -v
pnpm test:hermes-smoke
pnpm hermes:upgrade-check
pnpm check
pnpm typecheck
```

Expected: every command exits 0. Existing Biome warnings may remain at the
repository baseline, but no new error is accepted.

- [ ] **Step 3: Run the full CI-parity gate**

Run:

```bash
make verify
```

Expected: frontend, Tauri Rust, and June API gates pass. If Vitest exits
non-zero with zero real failures only from the documented HUD teardown noise,
record the exact output and rerun the affected suite; do not describe a real
failure as noise.

- [ ] **Step 4: Run live agent-driven QA in the native app**

Use the `agent-e2e-qa` skill. Start `pnpm tauri:dev`, connect the staging GitHub
App if needed, and use the selected `open-software-network/test-repo`. In a
normal interactive session, ask June to:

1. list selected repositories;
2. read repository metadata and one bounded text file;
3. list/read one issue surface; and
4. list/read one pull-request surface.

Capture visible evidence that sources identify the selected repository and no
write tool exists. Then verify:

- literal `no_mcp` yields no GitHub tool and no GitHub SOUL instruction;
- a child-process socket call is denied;
- disconnect or repository deselection reconciles the runtime and removes the
  tool; and
- reconnect/reselection restores it without exposing a token in config.

Stop the app after QA. Save the run log and compressed evidence under the
dated QA path. Never include credentials, socket frames, or repository secrets
in the recording or log.

- [ ] **Step 5: Commit docs and QA evidence**

```bash
git add docs/private-connectors-threat-model.md docs/configuration.md docs/index.md docs/qa/agent-e2e-qa-runs/2026-07-17-github-agent-reads.md
git commit -m "docs: verify isolated GitHub agent reads"
```

- [ ] **Step 6: Final completion audit**

Confirm all of the following before saying done:

- `git status --short` is clean;
- the implementation contains no old bearer route or MCP script;
- all eight task commits and independent review evidence exist;
- `make verify`, pinned-runtime gates, and live QA passed;
- no June API deployment is required; and
- GitHub mutation tools remain out of scope.
