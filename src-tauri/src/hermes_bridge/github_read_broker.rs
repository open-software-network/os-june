// Task 5 wires this broker into the interactive bridge runtime.
#![allow(dead_code)]

#[cfg(target_os = "macos")]
use crate::{commands, connectors::github::PlatformGitHubTokenVault};
use crate::{
    connectors::github_read::{GitHubReadEnvelope, GitHubReadRequest, GitHubReadService},
    domain::types::AppError,
};
use std::{
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::AppHandle;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
#[cfg(target_os = "macos")]
use tokio::net::UnixListener;
#[cfg(unix)]
use tokio::net::UnixStream;
use tokio::{
    sync::{oneshot, watch},
    task::JoinHandle,
};

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const REQUEST_DEADLINE: Duration = Duration::from_secs(35);

type BoxResponseFuture = Pin<Box<dyn Future<Output = serde_json::Value> + Send>>;
type RequestExecutor = Arc<dyn Fn(GitHubReadRequest) -> BoxResponseFuture + Send + Sync + 'static>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AdmissionState {
    Active { pid: u32, generation: u64 },
    Revoked,
}

#[derive(Debug, thiserror::Error)]
enum FrameError {
    #[error("broker connection closed")]
    Closed,
    #[error("broker request exceeds the frame limit")]
    TooLarge,
    #[error("broker request frame is incomplete")]
    Malformed,
    #[error("broker I/O failed")]
    Io(#[from] io::Error),
    #[error("broker JSON serialization failed")]
    Json(#[from] serde_json::Error),
}

enum FrameDisposition {
    Continue,
    Close,
}

#[cfg(test)]
#[derive(Clone)]
struct ConnectionSelectGate {
    reached: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    target_iteration: usize,
    force_buffered_frame_branch: bool,
}

#[derive(Debug)]
struct Admission {
    pid: Option<u32>,
    generation: u64,
    consumed: bool,
}

pub(super) struct GitHubReadBroker {
    socket_path: PathBuf,
    admission: Arc<Mutex<Admission>>,
    state_tx: watch::Sender<AdmissionState>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl GitHubReadBroker {
    #[cfg(target_os = "macos")]
    pub(super) async fn start(
        app: &AppHandle,
        service: Arc<GitHubReadService>,
        socket_dir: &Path,
        generation: u64,
    ) -> Result<Self, AppError> {
        let executor = production_executor(app.clone(), service);
        let (broker, _) =
            Self::start_with_executor(socket_dir, generation, executor, REQUEST_DEADLINE).await?;
        Ok(broker)
    }

    #[cfg(not(target_os = "macos"))]
    pub(super) async fn start(
        _app: &AppHandle,
        _service: Arc<GitHubReadService>,
        _socket_dir: &Path,
        _generation: u64,
    ) -> Result<Self, AppError> {
        Err(AppError::new(
            "github_read_broker_unsupported",
            "GitHub reads are not supported on this platform.",
        ))
    }

    pub(super) fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    pub(super) fn authorize_interactive(&self, pid: u32, generation: u64) -> Result<(), AppError> {
        let mut admission = self.admission.lock().map_err(|_| {
            AppError::new(
                "github_read_broker_admission_failed",
                "GitHub read admission could not be updated.",
            )
        })?;
        if admission.generation != generation {
            return Err(AppError::new(
                "github_read_broker_generation_mismatch",
                "GitHub read admission generation does not match.",
            ));
        }
        if admission.pid.is_some() || admission.consumed {
            return Err(AppError::new(
                "github_read_broker_admission_conflict",
                "GitHub read admission was already registered.",
            ));
        }

        admission.pid = Some(pid);
        self.state_tx
            .send_replace(AdmissionState::Active { pid, generation });
        Ok(())
    }

    pub(super) fn revoke_interactive(&self, pid: u32, generation: u64) {
        let Ok(admission) = self.admission.lock() else {
            self.state_tx.send_replace(AdmissionState::Revoked);
            return;
        };
        if admission.pid == Some(pid) && admission.generation == generation {
            self.state_tx.send_replace(AdmissionState::Revoked);
        }
    }

    #[cfg(target_os = "macos")]
    async fn start_with_executor(
        socket_dir: &Path,
        generation: u64,
        executor: RequestExecutor,
        request_deadline: Duration,
    ) -> Result<(Self, Arc<std::sync::atomic::AtomicUsize>), AppError> {
        use std::os::unix::fs::PermissionsExt;

        std::fs::create_dir_all(socket_dir).map_err(|_| broker_start_error())?;
        let socket_path = socket_dir.join(format!(
            "grb-{generation}-{:016x}.sock",
            rand::random::<u64>()
        ));
        let listener = UnixListener::bind(&socket_path).map_err(|_| broker_start_error())?;
        if std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600)).is_err() {
            drop(listener);
            let _ = std::fs::remove_file(&socket_path);
            return Err(broker_start_error());
        }
        let mode = match std::fs::metadata(&socket_path) {
            Ok(metadata) => metadata.permissions().mode() & 0o777,
            Err(_) => {
                drop(listener);
                let _ = std::fs::remove_file(&socket_path);
                return Err(broker_start_error());
            }
        };
        if mode != 0o600 {
            drop(listener);
            let _ = std::fs::remove_file(&socket_path);
            return Err(broker_start_error());
        }

        let admission = Arc::new(Mutex::new(Admission {
            pid: None,
            generation,
            consumed: false,
        }));
        let (state_tx, _) = watch::channel(AdmissionState::Revoked);
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let accepted_connections = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let task = tokio::spawn(serve_listener(
            listener,
            admission.clone(),
            state_tx.clone(),
            executor,
            request_deadline,
            accepted_connections.clone(),
            shutdown_rx,
        ));

        Ok((
            Self {
                socket_path,
                admission,
                state_tx,
                shutdown_tx: Some(shutdown_tx),
                task,
            },
            accepted_connections,
        ))
    }
}

impl Drop for GitHubReadBroker {
    fn drop(&mut self) {
        self.state_tx.send_replace(AdmissionState::Revoked);
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
        self.task.abort();
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

#[cfg(target_os = "macos")]
fn broker_start_error() -> AppError {
    AppError::new(
        "github_read_broker_start_failed",
        "GitHub read broker could not start.",
    )
}

#[cfg(target_os = "macos")]
fn production_executor(app: AppHandle, service: Arc<GitHubReadService>) -> RequestExecutor {
    Arc::new(move |request| {
        let app = app.clone();
        let service = service.clone();
        Box::pin(async move {
            let repositories = match commands::repositories(&app).await {
                Ok(repositories) => repositories,
                Err(error) => return public_error(error, false).body,
            };
            let outcome = service
                .execute(request, &PlatformGitHubTokenVault, &repositories)
                .await;
            match outcome.result {
                Ok(result) => public_success(result, outcome.connector_state_changed),
                Err(error) => public_error(error, outcome.connector_state_changed).body,
            }
        })
    })
}

#[cfg(target_os = "macos")]
async fn serve_listener(
    listener: UnixListener,
    admission: Arc<Mutex<Admission>>,
    state_tx: watch::Sender<AdmissionState>,
    executor: RequestExecutor,
    request_deadline: Duration,
    accepted_connections: Arc<std::sync::atomic::AtomicUsize>,
    mut shutdown_rx: oneshot::Receiver<()>,
) {
    loop {
        let stream = tokio::select! {
            _ = &mut shutdown_rx => return,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => stream,
                Err(_) => return,
            },
        };
        if !consume_admission(&admission, &state_tx, &stream) {
            continue;
        }

        accepted_connections.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let executor = executor.clone();
        let state_rx = state_tx.subscribe();
        tokio::spawn(async move {
            let _ = serve_admitted_connection(stream, executor, state_rx, request_deadline).await;
        });
    }
}

#[cfg(target_os = "macos")]
fn consume_admission(
    admission: &Mutex<Admission>,
    state_tx: &watch::Sender<AdmissionState>,
    stream: &UnixStream,
) -> bool {
    let Ok(mut admission) = admission.lock() else {
        state_tx.send_replace(AdmissionState::Revoked);
        return false;
    };
    let Ok(peer_pid) = peer_pid(stream) else {
        return false;
    };
    let expected_state = AdmissionState::Active {
        pid: peer_pid,
        generation: admission.generation,
    };
    if admission.pid != Some(peer_pid) || admission.consumed || *state_tx.borrow() != expected_state
    {
        return false;
    }
    admission.consumed = true;
    true
}

#[cfg(target_os = "macos")]
fn peer_pid(stream: &UnixStream) -> io::Result<u32> {
    use std::{
        ffi::{c_int, c_void},
        os::fd::AsRawFd,
    };

    const SOL_LOCAL: c_int = 0;
    const LOCAL_PEERPID: c_int = 2;

    unsafe extern "C" {
        fn getsockopt(
            socket: c_int,
            level: c_int,
            option_name: c_int,
            option_value: *mut c_void,
            option_len: *mut u32,
        ) -> c_int;
    }

    let mut pid: c_int = 0;
    let mut length = std::mem::size_of::<c_int>() as u32;
    // SAFETY: `stream` owns a valid socket fd for the duration of this call,
    // `pid` is a correctly sized writable output buffer, and `length` is
    // initialized to that buffer's size as required by `getsockopt`.
    let result = unsafe {
        getsockopt(
            stream.as_raw_fd(),
            SOL_LOCAL,
            LOCAL_PEERPID,
            std::ptr::from_mut(&mut pid).cast::<c_void>(),
            std::ptr::from_mut(&mut length),
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    if length as usize != std::mem::size_of::<c_int>() || pid <= 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid local peer pid",
        ));
    }
    Ok(pid as u32)
}

pub(super) struct PublicErrorResponse {
    pub(super) status: u16,
    pub(super) body: serde_json::Value,
}

async fn read_frame<R>(reader: &mut R) -> Result<Vec<u8>, FrameError>
where
    R: AsyncRead + Unpin,
{
    let mut prefix = [0_u8; 4];
    match reader.read(&mut prefix[..1]).await {
        Ok(0) => return Err(FrameError::Closed),
        Ok(_) => {}
        Err(error) => return Err(FrameError::Io(error)),
    }
    match reader.read_exact(&mut prefix[1..]).await {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
            return Err(FrameError::Malformed);
        }
        Err(error) => return Err(FrameError::Io(error)),
    }
    let length = u32::from_be_bytes(prefix) as usize;
    if length > MAX_REQUEST_BYTES {
        return Err(FrameError::TooLarge);
    }

    let mut body = vec![0_u8; length];
    match reader.read_exact(&mut body).await {
        Ok(_) => Ok(body),
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => Err(FrameError::Malformed),
        Err(error) => Err(FrameError::Io(error)),
    }
}

async fn write_frame<W>(writer: &mut W, response: serde_json::Value) -> Result<(), FrameError>
where
    W: AsyncWrite + Unpin,
{
    let response = bounded_response(response);
    let bytes = serde_json::to_vec(&response)?;
    writer
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .await?;
    writer.write_all(&bytes).await?;
    Ok(())
}

fn bounded_response(response: serde_json::Value) -> serde_json::Value {
    match serde_json::to_vec(&response) {
        Ok(bytes) if bytes.len() <= MAX_RESPONSE_BYTES => response,
        Ok(_) => {
            public_error(
                AppError::new(
                    "github_response_too_large",
                    "GitHub content exceeds the response limit.",
                ),
                false,
            )
            .body
        }
        Err(_) => {
            public_error(
                AppError::new(
                    "github_read_unavailable",
                    "GitHub could not be read right now.",
                ),
                false,
            )
            .body
        }
    }
}

pub(super) fn public_success(
    result: GitHubReadEnvelope,
    connector_state_changed: bool,
) -> serde_json::Value {
    serde_json::json!({
        "success": true,
        "result": result,
        "connectorStateChanged": connector_state_changed,
    })
}

pub(super) fn public_error(error: AppError, connector_state_changed: bool) -> PublicErrorResponse {
    let (status, code, message) = match error.code.as_str() {
        "github_reconnect_required" => (
            409,
            "github_reconnect_required",
            "GitHub access expired. Reconnect it in settings.",
        ),
        "github_setup_required" => (
            409,
            "github_setup_required",
            "GitHub setup is incomplete. Refresh it in settings.",
        ),
        "github_repository_not_selected" => (
            400,
            "github_repository_not_selected",
            "This GitHub repository is not selected.",
        ),
        "github_access_removed_or_not_found" => (
            400,
            "github_access_removed_or_not_found",
            "GitHub access was removed or the content was not found.",
        ),
        "github_input_invalid" => (400, "github_input_invalid", "GitHub input is invalid."),
        "github_cursor_invalid" => (
            400,
            "github_cursor_invalid",
            "The GitHub cursor is invalid or expired.",
        ),
        "github_file_ref_invalid" => (
            400,
            "github_file_ref_invalid",
            "The GitHub file reference is invalid or expired.",
        ),
        "github_sensitive_path_blocked" => (
            400,
            "github_sensitive_path_blocked",
            "GitHub content at this path cannot be read.",
        ),
        "github_binary_content" => (
            400,
            "github_binary_content",
            "GitHub content is not supported text.",
        ),
        "github_response_too_large" => (
            400,
            "github_response_too_large",
            "GitHub content exceeds the response limit.",
        ),
        "github_pull_request_changed" => (
            400,
            "github_pull_request_changed",
            "The GitHub pull request changed while it was being read.",
        ),
        "github_rate_limited" => (
            429,
            "github_rate_limited",
            "GitHub rate limited the request. Try again later.",
        ),
        "github_read_unavailable" => (
            502,
            "github_read_unavailable",
            "GitHub could not be read right now.",
        ),
        _ => (
            502,
            "github_read_unavailable",
            "GitHub could not be read right now.",
        ),
    };

    let details = if code == "github_rate_limited" {
        error
            .details
            .as_ref()
            .and_then(|details| details.get("retryAfterSeconds"))
            .and_then(serde_json::Value::as_u64)
            .map(|seconds| serde_json::json!({"retryAfterSeconds": seconds.min(86_400)}))
    } else {
        None
    };
    let mut public_error = serde_json::json!({
        "code": code,
        "message": message,
    });
    if let Some(details) = details {
        public_error["details"] = details;
    }
    PublicErrorResponse {
        status,
        body: serde_json::json!({
            "success": false,
            "error": public_error,
            "connectorStateChanged": connector_state_changed,
        }),
    }
}

#[cfg(unix)]
async fn serve_admitted_connection(
    stream: UnixStream,
    executor: RequestExecutor,
    state: watch::Receiver<AdmissionState>,
    request_deadline: Duration,
) -> Result<(), FrameError> {
    serve_admitted_connection_inner(stream, executor, state, request_deadline, None).await
}

#[cfg(test)]
async fn serve_admitted_connection_with_gate(
    stream: UnixStream,
    executor: RequestExecutor,
    state: watch::Receiver<AdmissionState>,
    request_deadline: Duration,
    gate: ConnectionSelectGate,
) -> Result<(), FrameError> {
    serve_admitted_connection_inner(stream, executor, state, request_deadline, Some(gate)).await
}

#[cfg(unix)]
async fn serve_admitted_connection_inner(
    mut stream: UnixStream,
    executor: RequestExecutor,
    mut state: watch::Receiver<AdmissionState>,
    request_deadline: Duration,
    #[cfg(test)] gate: Option<ConnectionSelectGate>,
    #[cfg(not(test))] _gate: Option<()>,
) -> Result<(), FrameError> {
    let admitted_state = *state.borrow();
    if admitted_state == AdmissionState::Revoked {
        return Ok(());
    }

    #[cfg(test)]
    let mut select_iteration = 0_usize;
    loop {
        #[cfg(test)]
        {
            select_iteration += 1;
        }
        #[cfg(test)]
        if let Some(gate) = gate
            .as_ref()
            .filter(|gate| gate.target_iteration == select_iteration)
        {
            gate.reached.notify_one();
            gate.release.notified().await;
        }
        if admission_revoked_or_watch_closed(&mut state, admitted_state) {
            return Ok(());
        }
        #[cfg(test)]
        if let Some(gate) = gate
            .as_ref()
            .filter(|gate| gate.target_iteration == select_iteration)
        {
            // Model the frame-first schedule that the former unbiased select
            // was allowed to choose when both branches were ready.
            if gate.force_buffered_frame_branch && state.has_changed().unwrap_or(true) {
                match tokio::time::timeout(
                    request_deadline,
                    serve_bounded_frame(&mut stream, executor.clone()),
                )
                .await
                {
                    Err(_) | Ok(Err(FrameError::Closed)) => return Ok(()),
                    Ok(Err(error)) => return Err(error),
                    Ok(Ok(FrameDisposition::Close)) => return Ok(()),
                    Ok(Ok(FrameDisposition::Continue)) => continue,
                }
            }
        }
        tokio::select! {
            biased;
            changed = state.changed() => {
                match changed {
                    Ok(()) if *state.borrow() != admitted_state => return Ok(()),
                    Ok(()) => {}
                    Err(_) => return Ok(()),
                }
            }
            frame = tokio::time::timeout(
                request_deadline,
                serve_bounded_frame(&mut stream, executor.clone()),
            ) => {
                match frame {
                    Err(_) | Ok(Err(FrameError::Closed)) => return Ok(()),
                    Ok(Err(error)) => return Err(error),
                    Ok(Ok(FrameDisposition::Close)) => return Ok(()),
                    Ok(Ok(FrameDisposition::Continue)) => {}
                }
            }
        }
    }
}

#[cfg(unix)]
fn admission_revoked_or_watch_closed(
    state: &mut watch::Receiver<AdmissionState>,
    admitted_state: AdmissionState,
) -> bool {
    match state.has_changed() {
        Err(_) => true,
        Ok(true) => *state.borrow_and_update() != admitted_state,
        Ok(false) => *state.borrow() != admitted_state,
    }
}

#[cfg(unix)]
async fn serve_bounded_frame(
    stream: &mut UnixStream,
    executor: RequestExecutor,
) -> Result<FrameDisposition, FrameError> {
    match serve_request_frame(stream, executor).await {
        Ok(()) => Ok(FrameDisposition::Continue),
        Err(FrameError::TooLarge | FrameError::Malformed) => {
            write_frame(
                stream,
                public_error(
                    AppError::new("github_input_invalid", "GitHub input is invalid."),
                    false,
                )
                .body,
            )
            .await?;
            Ok(FrameDisposition::Close)
        }
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
async fn serve_request_frame(
    stream: &mut UnixStream,
    executor: RequestExecutor,
) -> Result<(), FrameError> {
    let body = read_frame(stream).await?;
    let request = match serde_json::from_slice::<GitHubReadRequest>(&body) {
        Ok(request) => request,
        Err(_) => {
            return write_frame(
                stream,
                public_error(
                    AppError::new("github_input_invalid", "GitHub input is invalid."),
                    false,
                )
                .body,
            )
            .await;
        }
    };
    write_frame(stream, executor(request).await).await
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        sync::watch,
    };

    fn recording_executor(
        seen: Arc<Mutex<Vec<GitHubReadRequest>>>,
        response: serde_json::Value,
    ) -> RequestExecutor {
        Arc::new(move |request| {
            seen.lock().expect("seen").push(request);
            let response = response.clone();
            Box::pin(async move { response })
        })
    }

    async fn write_request_frame(
        stream: &mut tokio::net::UnixStream,
        request: &serde_json::Value,
    ) -> Result<(), FrameError> {
        let bytes = serde_json::to_vec(request)?;
        stream
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .await?;
        stream.write_all(&bytes).await?;
        Ok(())
    }

    async fn read_response_frame(
        stream: &mut tokio::net::UnixStream,
    ) -> Result<serde_json::Value, FrameError> {
        let mut prefix = [0_u8; 4];
        stream.read_exact(&mut prefix).await?;
        let length = u32::from_be_bytes(prefix) as usize;
        assert!(length <= MAX_RESPONSE_BYTES, "response exceeded broker cap");
        let mut body = vec![0_u8; length];
        stream.read_exact(&mut body).await?;
        Ok(serde_json::from_slice(&body)?)
    }

    fn active_state() -> AdmissionState {
        AdmissionState::Active {
            pid: std::process::id(),
            generation: 1,
        }
    }

    #[cfg(target_os = "macos")]
    fn successful_response() -> serde_json::Value {
        serde_json::json!({
            "success": true,
            "result": {
                "trust": "untrusted_repository_content",
                "data": {"ok": true}
            },
            "connectorStateChanged": false
        })
    }

    #[cfg(target_os = "macos")]
    fn list_repositories_request() -> serde_json::Value {
        serde_json::json!({
            "operation": "list_repositories",
            "arguments": {}
        })
    }

    #[cfg(target_os = "macos")]
    async fn assert_stream_eof(stream: &mut tokio::net::UnixStream) {
        let mut byte = [0_u8; 1];
        let read = tokio::time::timeout(Duration::from_millis(250), stream.read(&mut byte))
            .await
            .expect("rejected stream should close promptly")
            .expect("read rejected stream");
        assert_eq!(read, 0, "rejected stream should read EOF");
    }

    #[cfg(target_os = "macos")]
    async fn start_test_broker(
        socket_dir: &std::path::Path,
        generation: u64,
        seen: Arc<Mutex<Vec<GitHubReadRequest>>>,
        request_deadline: Duration,
    ) -> (GitHubReadBroker, Arc<AtomicUsize>) {
        GitHubReadBroker::start_with_executor(
            socket_dir,
            generation,
            recording_executor(seen, successful_response()),
            request_deadline,
        )
        .await
        .expect("start test broker")
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn registered_dashboard_pid_reuses_one_persistent_connection() {
        let socket_dir = tempfile::tempdir().expect("socket tempdir");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (broker, accepted_connections) =
            start_test_broker(socket_dir.path(), 7, seen.clone(), REQUEST_DEADLINE).await;
        broker
            .authorize_interactive(std::process::id(), 7)
            .expect("authorize dashboard pid");
        let mut client = tokio::net::UnixStream::connect(broker.socket_path())
            .await
            .expect("connect admitted dashboard");

        for _ in 0..2 {
            write_request_frame(&mut client, &list_repositories_request())
                .await
                .expect("write request");
            let response = read_response_frame(&mut client)
                .await
                .expect("read response");
            assert_eq!(response["success"], true);
        }

        assert_eq!(seen.lock().expect("seen").len(), 2);
        assert_eq!(accepted_connections.load(Ordering::SeqCst), 1);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn same_user_child_process_is_rejected_even_with_socket_path() {
        let socket_dir = tempfile::tempdir().expect("socket tempdir");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (broker, accepted_connections) =
            start_test_broker(socket_dir.path(), 7, seen.clone(), REQUEST_DEADLINE).await;
        broker
            .authorize_interactive(std::process::id(), 7)
            .expect("authorize dashboard pid");

        let socket_path = broker.socket_path().to_path_buf();
        let child = tokio::task::spawn_blocking(move || {
            std::process::Command::new("python3")
                .arg("-c")
                .arg(
                    r#"import json, socket, struct, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(1)
s.connect(sys.argv[1])
body = json.dumps({"operation":"list_repositories","arguments":{}}, separators=(",", ":")).encode()
s.sendall(struct.pack(">I", len(body)) + body)
raise SystemExit(0 if s.recv(1) == b"" else 2)"#,
                )
                .arg(socket_path)
                .status()
                .expect("run same-user child process")
        })
        .await
        .expect("join same-user child process");
        assert!(
            child.success(),
            "child should read EOF from rejected socket"
        );
        assert!(seen.lock().expect("seen").is_empty());
        assert_eq!(accepted_connections.load(Ordering::SeqCst), 0);

        let mut client = tokio::net::UnixStream::connect(broker.socket_path())
            .await
            .expect("connect registered dashboard after rejected child");
        write_request_frame(&mut client, &list_repositories_request())
            .await
            .expect("write admitted request");
        assert_eq!(
            read_response_frame(&mut client)
                .await
                .expect("read admitted response")["success"],
            true
        );
        assert_eq!(seen.lock().expect("seen").len(), 1);
        assert_eq!(accepted_connections.load(Ordering::SeqCst), 1);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn second_connection_cannot_reuse_consumed_admission() {
        let socket_dir = tempfile::tempdir().expect("socket tempdir");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (broker, accepted_connections) =
            start_test_broker(socket_dir.path(), 7, seen.clone(), REQUEST_DEADLINE).await;
        broker
            .authorize_interactive(std::process::id(), 7)
            .expect("authorize dashboard pid");
        let mut first = tokio::net::UnixStream::connect(broker.socket_path())
            .await
            .expect("connect first stream");
        write_request_frame(&mut first, &list_repositories_request())
            .await
            .expect("write first request");
        assert_eq!(
            read_response_frame(&mut first)
                .await
                .expect("read first response")["success"],
            true
        );

        let mut second = tokio::net::UnixStream::connect(broker.socket_path())
            .await
            .expect("connect second stream");
        assert_stream_eof(&mut second).await;

        write_request_frame(&mut first, &list_repositories_request())
            .await
            .expect("write another request on persistent stream");
        assert_eq!(
            read_response_frame(&mut first)
                .await
                .expect("read another response")["success"],
            true
        );
        assert_eq!(seen.lock().expect("seen").len(), 2);
        assert_eq!(accepted_connections.load(Ordering::SeqCst), 1);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn revoked_or_wrong_generation_cannot_return_another_frame() {
        let socket_dir = tempfile::tempdir().expect("socket tempdir");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (broker, accepted_connections) =
            start_test_broker(socket_dir.path(), 7, seen.clone(), REQUEST_DEADLINE).await;
        let wrong_generation = broker
            .authorize_interactive(std::process::id(), 8)
            .expect_err("generation 8 must not authorize generation 7");
        assert_eq!(
            wrong_generation.code,
            "github_read_broker_generation_mismatch"
        );
        let mut wrong_generation_stream = tokio::net::UnixStream::connect(broker.socket_path())
            .await
            .expect("connect before valid authorization");
        assert_stream_eof(&mut wrong_generation_stream).await;
        assert_eq!(accepted_connections.load(Ordering::SeqCst), 0);

        broker
            .authorize_interactive(std::process::id(), 7)
            .expect("authorize matching generation");
        let mut client = tokio::net::UnixStream::connect(broker.socket_path())
            .await
            .expect("connect admitted dashboard");
        write_request_frame(&mut client, &list_repositories_request())
            .await
            .expect("write request");
        assert_eq!(
            read_response_frame(&mut client)
                .await
                .expect("read response")["success"],
            true
        );

        broker.revoke_interactive(std::process::id(), 7);
        assert_stream_eof(&mut client).await;
        assert_eq!(seen.lock().expect("seen").len(), 1);
        assert_eq!(accepted_connections.load(Ordering::SeqCst), 1);

        let already_revoked_dir = tempfile::tempdir().expect("socket tempdir");
        let already_revoked_seen = Arc::new(Mutex::new(Vec::new()));
        let (already_revoked, already_revoked_connections) = start_test_broker(
            already_revoked_dir.path(),
            11,
            already_revoked_seen.clone(),
            REQUEST_DEADLINE,
        )
        .await;
        already_revoked
            .authorize_interactive(std::process::id(), 11)
            .expect("authorize dashboard before immediate revocation");
        already_revoked.revoke_interactive(std::process::id(), 11);
        let mut late_stream = tokio::net::UnixStream::connect(already_revoked.socket_path())
            .await
            .expect("connect after admission was revoked");
        assert_stream_eof(&mut late_stream).await;
        assert!(already_revoked_seen.lock().expect("seen").is_empty());
        assert_eq!(already_revoked_connections.load(Ordering::SeqCst), 0);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn broker_socket_is_owner_only_and_stalled_calls_time_out() {
        use std::os::unix::fs::PermissionsExt;

        let socket_dir = tempfile::tempdir().expect("socket tempdir");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (broker, accepted_connections) = start_test_broker(
            socket_dir.path(),
            7,
            seen.clone(),
            Duration::from_millis(25),
        )
        .await;
        assert_eq!(
            std::fs::metadata(broker.socket_path())
                .expect("socket metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        broker
            .authorize_interactive(std::process::id(), 7)
            .expect("authorize dashboard pid");
        let mut client = tokio::net::UnixStream::connect(broker.socket_path())
            .await
            .expect("connect admitted dashboard");
        client
            .write_all(&2_u32.to_be_bytes())
            .await
            .expect("write incomplete frame prefix");
        client.write_all(b"{").await.expect("write partial frame");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_stream_eof(&mut client).await;
        assert!(seen.lock().expect("seen").is_empty());
        assert_eq!(accepted_connections.load(Ordering::SeqCst), 1);

        let mut retry = tokio::net::UnixStream::connect(broker.socket_path())
            .await
            .expect("connect after consumed admission timed out");
        assert_stream_eof(&mut retry).await;
        assert_eq!(accepted_connections.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn github_read_broker_round_trips_one_typed_request() {
        let (mut client, server) = tokio::net::UnixStream::pair().expect("socket pair");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let executor = recording_executor(
            seen.clone(),
            serde_json::json!({
                "success": true,
                "result": {
                    "trust": "untrusted_repository_content",
                    "data": {"ok": true}
                },
                "connectorStateChanged": false
            }),
        );
        let (_state_tx, state_rx) = watch::channel(active_state());
        let task = tokio::spawn(serve_admitted_connection(
            server,
            executor,
            state_rx,
            REQUEST_DEADLINE,
        ));

        write_request_frame(
            &mut client,
            &serde_json::json!({
                "operation": "get_repository",
                "arguments": {"repository_id": "789"}
            }),
        )
        .await
        .expect("write request");
        let response = read_response_frame(&mut client)
            .await
            .expect("read response");

        assert_eq!(response["success"], true);
        assert!(matches!(seen.lock().expect("seen").as_slice(),
            [GitHubReadRequest::GetRepository { repository_id }] if repository_id == "789"));
        drop(client);
        task.await.expect("serve task").expect("serve result");
    }

    #[tokio::test]
    async fn github_read_broker_rejects_request_larger_than_64_kib_before_json() {
        let (mut client, server) = tokio::net::UnixStream::pair().expect("socket pair");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (_state_tx, state_rx) = watch::channel(active_state());
        let task = tokio::spawn(serve_admitted_connection(
            server,
            recording_executor(seen.clone(), serde_json::json!({"success": true})),
            state_rx,
            REQUEST_DEADLINE,
        ));

        client
            .write_all(&((MAX_REQUEST_BYTES + 1) as u32).to_be_bytes())
            .await
            .expect("write oversized prefix");
        let response = read_response_frame(&mut client)
            .await
            .expect("read response");

        assert_eq!(response, input_invalid_response());
        assert!(seen.lock().expect("seen").is_empty());
        task.await.expect("serve task").expect("serve result");
    }

    #[tokio::test]
    async fn github_read_broker_bounds_frame_error_response_writes_by_deadline() {
        let (mut server, client) = std::os::unix::net::UnixStream::pair().expect("socket pair");
        server
            .set_nonblocking(true)
            .expect("set server nonblocking");
        client
            .set_nonblocking(true)
            .expect("set client nonblocking");

        let fill = [0_u8; 8 * 1024];
        loop {
            match std::io::Write::write(&mut server, &fill) {
                Ok(0) => panic!("socket send buffer stopped accepting bytes without blocking"),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error) => panic!("fill socket send buffer: {error}"),
            }
        }

        let server = tokio::net::UnixStream::from_std(server).expect("async server stream");
        let mut client = tokio::net::UnixStream::from_std(client).expect("async client stream");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (_state_tx, state_rx) = watch::channel(active_state());
        let mut task = tokio::spawn(serve_admitted_connection(
            server,
            recording_executor(seen.clone(), serde_json::json!({"success": true})),
            state_rx,
            Duration::from_millis(25),
        ));

        client
            .write_all(&((MAX_REQUEST_BYTES + 1) as u32).to_be_bytes())
            .await
            .expect("write oversized prefix");
        let serve_result = match tokio::time::timeout(Duration::from_millis(250), &mut task).await {
            Ok(result) => result,
            Err(_) => {
                task.abort();
                panic!("frame error response write exceeded the request deadline");
            }
        };

        serve_result.expect("serve task").expect("serve result");
        assert!(seen.lock().expect("seen").is_empty());
    }

    #[test]
    fn github_read_broker_maps_unknown_errors_to_sanitized_unavailable() {
        let response = public_error(
            AppError::new("internal_path_leak", "/Users/example/secret"),
            false,
        );
        let serialized = response.body.to_string();

        assert_eq!(response.status, 502);
        assert_eq!(response.body["error"]["code"], "github_read_unavailable");
        assert_eq!(
            response.body["error"]["message"],
            "GitHub could not be read right now."
        );
        assert!(!serialized.contains("internal_path_leak"));
        assert!(!serialized.contains("/Users/example/secret"));
    }

    #[test]
    fn github_read_broker_caps_serialized_responses_at_256_kib() {
        let response = bounded_response(serde_json::json!({
            "success": true,
            "result": {"data": "x".repeat(MAX_RESPONSE_BYTES)},
            "connectorStateChanged": false
        }));

        assert_eq!(response["success"], false);
        assert_eq!(response["error"]["code"], "github_response_too_large");
        assert_eq!(
            response["error"]["message"],
            "GitHub content exceeds the response limit."
        );
    }

    #[tokio::test]
    async fn github_read_broker_maps_unknown_operations_to_input_invalid() {
        let (mut client, server) = tokio::net::UnixStream::pair().expect("socket pair");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (_state_tx, state_rx) = watch::channel(active_state());
        let task = tokio::spawn(serve_admitted_connection(
            server,
            recording_executor(seen.clone(), serde_json::json!({"success": true})),
            state_rx,
            REQUEST_DEADLINE,
        ));

        write_request_frame(
            &mut client,
            &serde_json::json!({
                "operation": "delete_repository",
                "arguments": {"repository_id": "789"}
            }),
        )
        .await
        .expect("write request");
        let response = read_response_frame(&mut client)
            .await
            .expect("read response");

        assert_eq!(response, input_invalid_response());
        assert!(seen.lock().expect("seen").is_empty());
        drop(client);
        task.await.expect("serve task").expect("serve result");
    }

    #[tokio::test]
    async fn github_read_broker_maps_incomplete_frames_to_input_invalid() {
        let (mut client, server) = tokio::net::UnixStream::pair().expect("socket pair");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (_state_tx, state_rx) = watch::channel(active_state());
        let task = tokio::spawn(serve_admitted_connection(
            server,
            recording_executor(seen.clone(), serde_json::json!({"success": true})),
            state_rx,
            REQUEST_DEADLINE,
        ));

        client
            .write_all(&2_u32.to_be_bytes())
            .await
            .expect("write prefix");
        client.write_all(b"{").await.expect("write partial body");
        client.shutdown().await.expect("finish partial frame");
        let response = read_response_frame(&mut client)
            .await
            .expect("read response");

        assert_eq!(response, input_invalid_response());
        assert!(seen.lock().expect("seen").is_empty());
        task.await.expect("serve task").expect("serve result");
    }

    #[tokio::test]
    async fn queued_complete_frame_is_discarded_when_admission_is_revoked() {
        let (mut client, server) = tokio::net::UnixStream::pair().expect("socket pair");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (state_tx, state_rx) = watch::channel(active_state());
        let gate = ConnectionSelectGate {
            reached: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
            target_iteration: 2,
            force_buffered_frame_branch: true,
        };
        let task = tokio::spawn(serve_admitted_connection_with_gate(
            server,
            recording_executor(seen.clone(), serde_json::json!({"success": true})),
            state_rx,
            REQUEST_DEADLINE,
            gate.clone(),
        ));
        write_request_frame(
            &mut client,
            &serde_json::json!({"operation": "list_repositories", "arguments": {}}),
        )
        .await
        .expect("write initial request");
        assert_eq!(
            read_response_frame(&mut client)
                .await
                .expect("read initial response")["success"],
            true
        );
        tokio::time::timeout(Duration::from_millis(250), gate.reached.notified())
            .await
            .expect("connection should reach the deterministic select gate");
        write_request_frame(
            &mut client,
            &serde_json::json!({"operation": "list_repositories", "arguments": {}}),
        )
        .await
        .expect("queue complete request before revocation");
        state_tx
            .send(AdmissionState::Revoked)
            .expect("revoke admitted connection");
        gate.release.notify_one();

        let mut byte = [0_u8; 1];
        let read = tokio::time::timeout(Duration::from_millis(250), client.read(&mut byte))
            .await
            .expect("revocation should close the connection")
            .expect("read EOF after revocation");
        assert_eq!(read, 0, "revoked connection must not return a response");
        assert_eq!(
            seen.lock().expect("seen").len(),
            1,
            "revoked connection must not invoke the executor again"
        );
        task.await.expect("serve task").expect("serve result");
    }

    #[tokio::test]
    async fn closed_admission_watch_fails_closed_before_buffered_frame() {
        let (mut client, server) = tokio::net::UnixStream::pair().expect("socket pair");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (state_tx, state_rx) = watch::channel(active_state());
        let gate = ConnectionSelectGate {
            reached: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
            target_iteration: 2,
            force_buffered_frame_branch: true,
        };
        let task = tokio::spawn(serve_admitted_connection_with_gate(
            server,
            recording_executor(seen.clone(), serde_json::json!({"success": true})),
            state_rx,
            REQUEST_DEADLINE,
            gate.clone(),
        ));
        write_request_frame(
            &mut client,
            &serde_json::json!({"operation": "list_repositories", "arguments": {}}),
        )
        .await
        .expect("write initial request");
        assert_eq!(
            read_response_frame(&mut client)
                .await
                .expect("read initial response")["success"],
            true
        );
        tokio::time::timeout(Duration::from_millis(250), gate.reached.notified())
            .await
            .expect("connection should reach the deterministic select gate");
        write_request_frame(
            &mut client,
            &serde_json::json!({"operation": "list_repositories", "arguments": {}}),
        )
        .await
        .expect("queue complete request before watch closure");
        drop(state_tx);
        gate.release.notify_one();

        let mut byte = [0_u8; 1];
        let read = tokio::time::timeout(Duration::from_millis(250), client.read(&mut byte))
            .await
            .expect("watch closure should close the connection")
            .expect("read EOF after watch closure");
        assert_eq!(read, 0, "closed watch must not return a response");
        assert_eq!(
            seen.lock().expect("seen").len(),
            1,
            "closed watch must not invoke the executor again"
        );
        task.await.expect("serve task").expect("serve result");
    }

    #[tokio::test]
    async fn github_read_broker_closes_connection_when_state_is_revoked() {
        let (mut client, server) = tokio::net::UnixStream::pair().expect("socket pair");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (state_tx, state_rx) = watch::channel(active_state());
        let task = tokio::spawn(serve_admitted_connection(
            server,
            recording_executor(seen.clone(), serde_json::json!({"success": true})),
            state_rx,
            REQUEST_DEADLINE,
        ));

        state_tx
            .send(AdmissionState::Revoked)
            .expect("revoke connection");
        let mut byte = [0_u8; 1];
        let read = tokio::time::timeout(Duration::from_millis(250), client.read(&mut byte))
            .await
            .expect("revocation should promptly close the connection")
            .expect("read EOF");
        assert_eq!(read, 0);
        assert!(seen.lock().expect("seen").is_empty());
        task.await.expect("serve task").expect("serve result");
    }

    fn input_invalid_response() -> serde_json::Value {
        serde_json::json!({
            "success": false,
            "error": {
                "code": "github_input_invalid",
                "message": "GitHub input is invalid."
            },
            "connectorStateChanged": false
        })
    }
}
