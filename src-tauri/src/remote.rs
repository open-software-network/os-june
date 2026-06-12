//! Desktop host for "control June from your phone".
//!
//! This process is the **host**: it authenticates to scribe-api with the
//! user's OS Accounts token (which never leaves Rust for the webview) and
//! holds the relay WebSocket. Inbound controller frames are emitted to the
//! webview as Tauri events; the webview runs each prompt through the existing
//! agent session client and hands streamed output back via a command, which
//! this module relays to the phone. Keeping the socket here is what lets the
//! agent orchestration stay in the webview without the access token going
//! with it.

use crate::domain::types::AppError;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::header, Message};

/// Emitted to the webview for each prompt the phone sends.
pub const REMOTE_PROMPT_EVENT: &str = "remote-prompt";
/// Emitted when the link's connection state changes (paired/connected/closed).
pub const REMOTE_STATUS_EVENT: &str = "remote-status";

#[derive(Default)]
pub struct RemoteHost {
    inner: Mutex<Option<HostSession>>,
}

struct HostSession {
    /// Frames to send to the phone (from the webview's agent stream).
    outbound: mpsc::UnboundedSender<String>,
    /// Cancels the host WS task.
    cancel: tokio::sync::watch::Sender<bool>,
    code: String,
    mobile_url: String,
    controller_online: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemotePairing {
    pub code: String,
    pub mobile_url: String,
    pub expires_in_seconds: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub active: bool,
    pub code: Option<String>,
    pub mobile_url: Option<String>,
    /// True once a phone has connected to the link.
    pub controller_online: bool,
}

#[derive(Deserialize)]
struct CreatePairingData {
    #[serde(rename = "pairingId")]
    pairing_id: String,
    code: String,
    #[serde(rename = "expiresInSeconds")]
    expires_in_seconds: u64,
}

/// Frame the phone sends us. We only act on prompts; everything else is
/// ignored so the protocol can grow without breaking older hosts.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ControllerFrame {
    Prompt {
        text: String,
    },
    #[serde(other)]
    Other,
}

/// Starts (or restarts) the host: mints a pairing, opens the relay socket, and
/// returns the code to show the user. Idempotent restart: an existing session
/// is torn down first.
pub async fn start(app: &AppHandle, host: &RemoteHost) -> Result<RemotePairing, AppError> {
    stop(host);

    let token = crate::os_accounts::access_token().await?;
    let api = crate::scribe_api::scribe_api_url();
    let pairing = mint_pairing(&api, &token).await?;
    let mobile_url = mobile_url_for(&api);

    let (outbound_tx, outbound_rx) = mpsc::unbounded_channel();
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let controller_online = Arc::new(std::sync::atomic::AtomicBool::new(false));

    {
        let mut guard = host
            .inner
            .lock()
            .map_err(|_| AppError::new("remote_lock", "Remote host lock poisoned."))?;
        *guard = Some(HostSession {
            outbound: outbound_tx,
            cancel: cancel_tx,
            code: pairing.code.clone(),
            mobile_url: mobile_url.clone(),
            controller_online: controller_online.clone(),
        });
    }

    let ws_url = host_ws_url(&api, &pairing.pairing_id);
    let app = app.clone();
    tauri::async_runtime::spawn(run_host_socket(RunArgs {
        app,
        ws_url,
        token,
        outbound_rx,
        cancel_rx,
        controller_online,
    }));

    Ok(RemotePairing {
        code: pairing.code,
        mobile_url,
        expires_in_seconds: pairing.expires_in_seconds,
    })
}

/// Tears down the active host session, if any.
pub fn stop(host: &RemoteHost) {
    if let Ok(mut guard) = host.inner.lock() {
        if let Some(session) = guard.take() {
            let _ = session.cancel.send(true);
        }
    }
}

pub fn status(host: &RemoteHost) -> RemoteStatus {
    match host.inner.lock() {
        Ok(guard) => match guard.as_ref() {
            Some(session) => RemoteStatus {
                active: true,
                code: Some(session.code.clone()),
                mobile_url: Some(session.mobile_url.clone()),
                controller_online: session
                    .controller_online
                    .load(std::sync::atomic::Ordering::SeqCst),
            },
            None => RemoteStatus {
                active: false,
                code: None,
                mobile_url: None,
                controller_online: false,
            },
        },
        Err(_) => RemoteStatus {
            active: false,
            code: None,
            mobile_url: None,
            controller_online: false,
        },
    }
}

/// Sends a frame from the webview's agent stream out to the phone.
pub fn send_to_controller(host: &RemoteHost, frame: String) -> Result<(), AppError> {
    let guard = host
        .inner
        .lock()
        .map_err(|_| AppError::new("remote_lock", "Remote host lock poisoned."))?;
    let session = guard
        .as_ref()
        .ok_or_else(|| AppError::new("remote_inactive", "Remote control is not active."))?;
    session
        .outbound
        .send(frame)
        .map_err(|_| AppError::new("remote_closed", "Remote link is closed."))
}

async fn mint_pairing(api: &str, token: &str) -> Result<CreatePairingData, AppError> {
    let response = crate::scribe_api::http_client()
        .post(format!("{api}/v1/remote/pairings"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| AppError::new("remote_pair_failed", error.to_string()))?;
    if !response.status().is_success() {
        return Err(AppError::new(
            "remote_pair_failed",
            format!("Pairing request failed with status {}.", response.status()),
        ));
    }
    let envelope: serde_json::Value = response
        .json()
        .await
        .map_err(|error| AppError::new("remote_pair_failed", error.to_string()))?;
    serde_json::from_value(envelope.get("data").cloned().unwrap_or_default())
        .map_err(|error| AppError::new("remote_pair_failed", error.to_string()))
}

struct RunArgs {
    app: AppHandle,
    ws_url: String,
    token: String,
    outbound_rx: mpsc::UnboundedReceiver<String>,
    cancel_rx: tokio::sync::watch::Receiver<bool>,
    controller_online: Arc<std::sync::atomic::AtomicBool>,
}

async fn run_host_socket(mut args: RunArgs) {
    let socket = match connect_host(&args.ws_url, &args.token).await {
        Ok(socket) => socket,
        Err(error) => {
            let _ = args.app.emit(
                REMOTE_STATUS_EVENT,
                serde_json::json!({ "active": false, "error": error.message }),
            );
            return;
        }
    };
    let (mut sink, mut stream) = socket.split();

    loop {
        tokio::select! {
            _ = args.cancel_rx.changed() => {
                if *args.cancel_rx.borrow() { break; }
            }
            outbound = args.outbound_rx.recv() => {
                match outbound {
                    Some(text) => {
                        if sink.send(Message::text(text)).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        handle_controller_frame(&args.app, &args.controller_online, text.as_str());
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                }
            }
        }
    }
    let _ = args
        .app
        .emit(REMOTE_STATUS_EVENT, serde_json::json!({ "active": false }));
}

fn handle_controller_frame(
    app: &AppHandle,
    controller_online: &Arc<std::sync::atomic::AtomicBool>,
    text: &str,
) {
    // Hub-injected presence frames flip the "phone connected" indicator.
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
        match value.get("type").and_then(serde_json::Value::as_str) {
            Some("peer_here") => {
                controller_online.store(true, std::sync::atomic::Ordering::SeqCst);
                let _ = app.emit(
                    REMOTE_STATUS_EVENT,
                    serde_json::json!({ "active": true, "controllerOnline": true }),
                );
                return;
            }
            Some("peer_left") => {
                controller_online.store(false, std::sync::atomic::Ordering::SeqCst);
                let _ = app.emit(
                    REMOTE_STATUS_EVENT,
                    serde_json::json!({ "active": true, "controllerOnline": false }),
                );
                return;
            }
            _ => {}
        }
    }
    if let Ok(ControllerFrame::Prompt { text }) = serde_json::from_str::<ControllerFrame>(text) {
        let _ = app.emit(REMOTE_PROMPT_EVENT, serde_json::json!({ "text": text }));
    }
}

async fn connect_host(
    ws_url: &str,
    token: &str,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    AppError,
> {
    let mut request = ws_url
        .into_client_request()
        .map_err(|error| AppError::new("remote_ws_failed", error.to_string()))?;
    // The OS Accounts bearer rides as the WS subprotocol, never the URL.
    request.headers_mut().insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        token
            .parse()
            .map_err(|_| AppError::new("remote_ws_failed", "Invalid token for subprotocol."))?,
    );
    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|error| AppError::new("remote_ws_failed", error.to_string()))?;
    Ok(socket)
}

fn host_ws_url(api: &str, pairing_id: &str) -> String {
    let base = api
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    format!("{base}/v1/remote/link?role=host&pairing={pairing_id}")
}

fn mobile_url_for(api: &str) -> String {
    format!("{api}/m")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_ws_url_upgrades_scheme_and_carries_role() {
        assert_eq!(
            host_ws_url("https://scribe-api.example.test", "pair-1"),
            "wss://scribe-api.example.test/v1/remote/link?role=host&pairing=pair-1"
        );
        assert_eq!(
            host_ws_url("http://127.0.0.1:8080", "pair-1"),
            "ws://127.0.0.1:8080/v1/remote/link?role=host&pairing=pair-1"
        );
    }

    #[test]
    fn mobile_url_points_at_the_phone_page() {
        assert_eq!(
            mobile_url_for("https://scribe-api.example.test"),
            "https://scribe-api.example.test/m"
        );
    }

    #[test]
    fn prompt_frames_parse_and_others_are_ignored() {
        assert!(matches!(
            serde_json::from_str::<ControllerFrame>(r#"{"type":"prompt","text":"hi"}"#),
            Ok(ControllerFrame::Prompt { text }) if text == "hi"
        ));
        assert!(matches!(
            serde_json::from_str::<ControllerFrame>(r#"{"type":"ping"}"#),
            Ok(ControllerFrame::Other)
        ));
    }
}
