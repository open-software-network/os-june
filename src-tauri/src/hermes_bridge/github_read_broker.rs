// Task 2 wires this protocol into the broker listener and production executor.
#![allow(dead_code)]

use crate::{
    connectors::github_read::{GitHubReadEnvelope, GitHubReadRequest},
    domain::types::AppError,
};
use std::{future::Future, io, pin::Pin, sync::Arc, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
#[cfg(unix)]
use tokio::{net::UnixStream, sync::watch};

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
    mut stream: UnixStream,
    executor: RequestExecutor,
    mut state: watch::Receiver<AdmissionState>,
    request_deadline: Duration,
) -> Result<(), FrameError> {
    let admitted_state = *state.borrow();
    if admitted_state == AdmissionState::Revoked {
        return Ok(());
    }
    let mut state_channel_closed = false;

    loop {
        tokio::select! {
            changed = state.changed(), if !state_channel_closed => {
                match changed {
                    Ok(()) if *state.borrow() != admitted_state => return Ok(()),
                    Ok(()) => {}
                    Err(_) => state_channel_closed = true,
                }
            }
            frame = tokio::time::timeout(
                request_deadline,
                serve_request_frame(&mut stream, executor.clone()),
            ) => {
                match frame {
                    Err(_) | Ok(Err(FrameError::Closed)) => return Ok(()),
                    Ok(Err(FrameError::TooLarge | FrameError::Malformed)) => {
                        write_frame(
                            &mut stream,
                            public_error(
                                AppError::new(
                                    "github_input_invalid",
                                    "GitHub input is invalid.",
                                ),
                                false,
                            ).body,
                        ).await?;
                        return Ok(());
                    }
                    Ok(Err(error)) => return Err(error),
                    Ok(Ok(())) => {}
                }
            }
        }
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
    use std::sync::{Arc, Mutex};
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
        let task = tokio::spawn(serve_admitted_connection(
            server,
            executor,
            watch::channel(active_state()).1,
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
        let task = tokio::spawn(serve_admitted_connection(
            server,
            recording_executor(seen.clone(), serde_json::json!({"success": true})),
            watch::channel(active_state()).1,
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
        let task = tokio::spawn(serve_admitted_connection(
            server,
            recording_executor(seen.clone(), serde_json::json!({"success": true})),
            watch::channel(active_state()).1,
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
        let task = tokio::spawn(serve_admitted_connection(
            server,
            recording_executor(seen.clone(), serde_json::json!({"success": true})),
            watch::channel(active_state()).1,
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
