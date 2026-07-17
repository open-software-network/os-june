use super::{
    current_time_ms, finish_pairing, frontend_response, has_pending_pairing,
    load_or_create_identity, pairing_for_mobile, relay_websocket_url, CompanionRuntime,
    FrontendIntent, StoredIdentity,
};
use crate::{commands::repositories, db::repositories::Repositories, domain::types::AppError};
use futures_util::{SinkExt, StreamExt};
use june_companion_crypto::Session;
use june_companion_protocol::{
    decode_frame, encode_frame, Body, Event, FailureCode, Frame, ProtocolFailure, RelayEnvelope,
    Response, ResultPayload,
};
use rand::Rng;
use serde::Serialize;
use std::{collections::HashMap, sync::atomic::Ordering, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{header::AUTHORIZATION, HeaderValue},
        Message,
    },
    MaybeTlsStream, WebSocketStream,
};
use uuid::Uuid;

const FRONTEND_TIMEOUT: Duration = Duration::from_secs(25);
const ENVELOPE_TTL_MS: u64 = 30_000;
const MAX_RECONNECT_DELAY_SECS: u64 = 60;

type RelaySocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct PeerSession {
    crypto: Session,
    expected_public_key: [u8; 32],
    pairing_id: Option<Uuid>,
}

struct RelayConnectionGuard<'a> {
    runtime: &'a CompanionRuntime,
}

impl Drop for RelayConnectionGuard<'_> {
    fn drop(&mut self) {
        self.runtime.relay_connected.store(false, Ordering::Release);
        if let Ok(mut sender) = self.runtime.event_sender.lock() {
            *sender = None;
        }
        self.runtime.relay_connection_changed.notify_waiters();
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrontendRequest {
    operation_id: Uuid,
    intent: FrontendIntent,
}

pub(super) fn start(app: &AppHandle) {
    let runtime = app.state::<CompanionRuntime>();
    if runtime
        .transport_started
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        reconnect_loop(app).await;
    });
}

async fn reconnect_loop(app: AppHandle) {
    let mut attempt = 0_u32;
    loop {
        let has_active_device = match repositories(&app).await {
            Ok(repos) => repos
                .list_companion_devices()
                .await
                .map(|devices| {
                    devices
                        .into_iter()
                        .any(|device| device.revoked_at.is_none())
                })
                .unwrap_or(false),
            Err(_) => false,
        };
        if !has_active_device && !has_pending_pairing(&app.state::<CompanionRuntime>()) {
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        }

        match connect_once(&app).await {
            Ok(()) => attempt = 0,
            Err(error) => {
                tracing::warn!(code = %error.code, "companion relay connection ended");
                attempt = attempt.saturating_add(1).min(8);
            }
        }
        let cap = 2_u64
            .saturating_pow(attempt)
            .clamp(1, MAX_RECONNECT_DELAY_SECS);
        let delay = rand::thread_rng().gen_range(0..=cap);
        tokio::time::sleep(Duration::from_secs(delay)).await;
    }
}

async fn connect_once(app: &AppHandle) -> Result<(), AppError> {
    let identity = load_or_create_identity()?;
    let token = crate::os_accounts::access_token().await?;
    let separator = if relay_websocket_url().contains('?') {
        '&'
    } else {
        '?'
    };
    let url = format!(
        "{}{separator}deviceId={}",
        relay_websocket_url(),
        identity.device_id
    );
    let mut request = url
        .into_client_request()
        .map_err(|_| transport_error("The companion relay URL is invalid."))?;
    let authorization = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| transport_error("The OS Accounts session is invalid."))?;
    request.headers_mut().insert(AUTHORIZATION, authorization);
    let (mut socket, _) = connect_async(request)
        .await
        .map_err(|_| transport_error("The companion relay is unavailable."))?;
    let repos = repositories(app).await?;
    let mut peers = HashMap::new();
    let mut outbound_sequence = 0_u64;
    let runtime = app.state::<CompanionRuntime>();
    let (event_sender, mut event_receiver) = tokio::sync::mpsc::channel(128);
    *runtime
        .event_sender
        .lock()
        .map_err(|_| transport_error("Companion event lock failed."))? = Some(event_sender);
    runtime.relay_connected.store(true, Ordering::Release);
    runtime.relay_connection_changed.notify_waiters();
    let _connection_guard = RelayConnectionGuard { runtime: &runtime };
    let mut delta_tick = tokio::time::interval(Duration::from_millis(750));
    let mut pending_deltas: HashMap<String, String> = HashMap::new();

    loop {
        tokio::select! {
            message = socket.next() => {
                let Some(message) = message else { return Ok(()); };
                let message = message.map_err(|_| transport_error("The companion relay disconnected."))?;
                let bytes = match message {
                    Message::Binary(bytes) => bytes.to_vec(),
                    Message::Text(text) => text.as_str().as_bytes().to_vec(),
                    Message::Ping(payload) => {
                        socket.send(Message::Pong(payload)).await
                            .map_err(|_| transport_error("The companion relay disconnected."))?;
                        continue;
                    }
                    Message::Pong(_) | Message::Frame(_) => continue,
                    Message::Close(_) => return Ok(()),
                };
                let envelope: RelayEnvelope = serde_json::from_slice(&bytes)
                    .map_err(|_| transport_error("The companion relay frame is invalid."))?;
                receive_envelope(
                    app,
                    &repos,
                    &identity,
                    &mut socket,
                    &mut peers,
                    &mut outbound_sequence,
                    envelope,
                ).await?;
            }
            event = event_receiver.recv() => {
                let Some(event) = event else { return Ok(()); };
                match event {
                    Event::AgentDelta { session_id, text } => {
                        let pending = pending_deltas.entry(session_id.clone()).or_default();
                        if pending.len().saturating_add(text.len()) > june_companion_protocol::MAX_TEXT_BYTES {
                            let ready = std::mem::take(pending);
                            if !ready.is_empty() {
                                publish_event(
                                    &repos,
                                    &identity,
                                    &mut socket,
                                    &mut peers,
                                    &mut outbound_sequence,
                                    Event::AgentDelta { session_id: session_id.clone(), text: ready },
                                ).await?;
                            }
                        }
                        pending.push_str(&text);
                    }
                    event => publish_event(
                        &repos,
                        &identity,
                        &mut socket,
                        &mut peers,
                        &mut outbound_sequence,
                        event,
                    ).await?,
                }
            }
            _ = delta_tick.tick() => {
                for (session_id, text) in pending_deltas.drain() {
                    if text.is_empty() { continue; }
                    publish_event(
                        &repos,
                        &identity,
                        &mut socket,
                        &mut peers,
                        &mut outbound_sequence,
                        Event::AgentDelta { session_id, text },
                    ).await?;
                }
            }
        }
    }
}

async fn publish_event(
    repos: &Repositories,
    identity: &StoredIdentity,
    socket: &mut RelaySocket,
    peers: &mut HashMap<Uuid, PeerSession>,
    outbound_sequence: &mut u64,
    event: Event,
) -> Result<(), AppError> {
    let mut encrypted_events = Vec::new();
    let peer_ids: Vec<Uuid> = peers.keys().copied().collect();
    for peer_id in peer_ids {
        let active = repos
            .companion_device(&peer_id.to_string())
            .await?
            .is_some_and(|device| device.revoked_at.is_none());
        if !active {
            peers.remove(&peer_id);
            continue;
        }
        let peer = peers
            .get_mut(&peer_id)
            .ok_or_else(|| transport_error("The linked device session disappeared."))?;
        if !peer.crypto.is_transport_ready() {
            continue;
        }
        *outbound_sequence = outbound_sequence.saturating_add(1);
        let frame = Frame::new(
            Uuid::new_v4(),
            *outbound_sequence,
            current_time_ms(),
            event.capability(),
            Body::Event(event.clone()),
        );
        let encoded = encode_frame(&frame)
            .map_err(|_| transport_error("The companion event exceeded its size limit."))?;
        let encrypted = peer
            .crypto
            .write(&encoded)
            .map_err(|_| transport_error("The companion event could not be encrypted."))?;
        encrypted_events.push((peer_id, encrypted));
    }
    for (peer_id, encrypted) in encrypted_events {
        send_envelope(socket, identity.device_id, peer_id, encrypted).await?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn receive_envelope(
    app: &AppHandle,
    repos: &Repositories,
    identity: &StoredIdentity,
    socket: &mut RelaySocket,
    peers: &mut HashMap<Uuid, PeerSession>,
    outbound_sequence: &mut u64,
    envelope: RelayEnvelope,
) -> Result<(), AppError> {
    envelope
        .validate()
        .map_err(|_| transport_error("The companion relay frame failed validation."))?;
    if envelope.recipient_device_id != identity.device_id {
        return Err(transport_error("The companion relay route is invalid."));
    }
    let now = current_time_ms();
    if envelope.created_at_ms > now.saturating_add(ENVELOPE_TTL_MS)
        || now > envelope.created_at_ms.saturating_add(ENVELOPE_TTL_MS)
    {
        return Err(transport_error("The companion relay frame expired."));
    }
    let peer_id = envelope.sender_device_id;

    if let std::collections::hash_map::Entry::Vacant(entry) = peers.entry(peer_id) {
        let device = repos
            .companion_device(&peer_id.to_string())
            .await?
            .filter(|device| device.revoked_at.is_none())
            .ok_or_else(|| transport_error("The linked device is unavailable."))?;
        let expected_public_key: [u8; 32] = device
            .public_key
            .try_into()
            .map_err(|_| transport_error("The linked device identity is invalid."))?;
        let runtime = app.state::<CompanionRuntime>();
        let pairing = pairing_for_mobile(&runtime, peer_id)?;
        let mut crypto = if let Some((_, secret)) = pairing {
            Session::pairing(false, &identity.private_key()?, &secret)
        } else {
            Session::linked(false, &identity.private_key()?, &expected_public_key)
        }
        .map_err(|_| transport_error("The secure companion session could not start."))?;
        let handshake_payload = crypto
            .read(&envelope.ciphertext)
            .map_err(|_| transport_error("The linked device handshake was rejected."))?;
        if !handshake_payload.is_empty() {
            return Err(transport_error(
                "The linked device handshake carried unexpected data.",
            ));
        }
        let response = crypto
            .write(&[])
            .map_err(|_| transport_error("The linked device handshake was rejected."))?;
        send_envelope(socket, identity.device_id, peer_id, response).await?;
        let mut peer = PeerSession {
            crypto,
            expected_public_key,
            pairing_id: pairing.map(|(pairing_id, _)| pairing_id),
        };
        if peer.crypto.is_transport_ready() {
            authenticate_peer(app, repos, peer_id, &mut peer).await?;
        }
        entry.insert(peer);
        return Ok(());
    }

    let peer = peers
        .get_mut(&peer_id)
        .ok_or_else(|| transport_error("The linked device session disappeared."))?;
    let plaintext = peer
        .crypto
        .read(&envelope.ciphertext)
        .map_err(|_| transport_error("The encrypted companion frame was rejected."))?;
    if !peer.crypto.is_transport_ready() {
        if !plaintext.is_empty() {
            return Err(transport_error(
                "The linked device handshake carried unexpected data.",
            ));
        }
        authenticate_peer(app, repos, peer_id, peer).await?;
        return Ok(());
    }

    let frame = decode_frame(&plaintext, now)
        .map_err(|_| transport_error("The encrypted companion request is invalid."))?;
    let operation_id = frame.operation_id;
    let capability = frame.capability;
    let result = dispatch_request(app, repos, peer_id, frame).await;
    let response = match result {
        Ok(response) => response,
        Err(error) => Response {
            capability,
            result: ResultPayload::Error(protocol_failure(&error)),
        },
    };
    *outbound_sequence = outbound_sequence.saturating_add(1);
    let response_frame = Frame::new(
        operation_id,
        *outbound_sequence,
        current_time_ms(),
        capability,
        Body::Response(response),
    );
    let encoded = match encode_frame(&response_frame) {
        Ok(encoded) => encoded,
        Err(_) => encode_frame(&Frame::new(
            operation_id,
            *outbound_sequence,
            current_time_ms(),
            capability,
            Body::Response(Response {
                capability,
                result: ResultPayload::Error(ProtocolFailure {
                    code: FailureCode::Unsupported,
                    message: "This result is too large for the companion. Open it on your Mac."
                        .to_string(),
                    retryable: false,
                }),
            }),
        ))
        .map_err(|_| transport_error("The companion response exceeded its size limit."))?,
    };
    let encrypted = peer
        .crypto
        .write(&encoded)
        .map_err(|_| transport_error("The companion response could not be encrypted."))?;
    send_envelope(socket, identity.device_id, peer_id, encrypted).await
}

async fn authenticate_peer(
    app: &AppHandle,
    repos: &Repositories,
    peer_id: Uuid,
    peer: &mut PeerSession,
) -> Result<(), AppError> {
    if peer.crypto.remote_static() != Some(&peer.expected_public_key) {
        return Err(transport_error("The linked device identity did not match."));
    }
    app.state::<CompanionRuntime>()
        .controller
        .reset_sequence(&peer_id.to_string());
    repos.touch_companion_device(&peer_id.to_string()).await?;
    if let Some(pairing_id) = peer.pairing_id.take() {
        finish_pairing(&app.state::<CompanionRuntime>(), pairing_id);
    }
    Ok(())
}

async fn dispatch_request(
    app: &AppHandle,
    repos: &Repositories,
    peer_id: Uuid,
    frame: Frame,
) -> Result<Response, AppError> {
    let operation_id = frame.operation_id;
    let capability = frame.capability;
    match app
        .state::<CompanionRuntime>()
        .controller
        .dispatch(app, repos, &peer_id.to_string(), frame, current_time_ms())
        .await?
    {
        super::ControllerOutcome::Immediate(response) => Ok(response),
        super::ControllerOutcome::Frontend(intent) => {
            let (sender, receiver) = tokio::sync::oneshot::channel();
            app.state::<CompanionRuntime>()
                .pending_frontend
                .lock()
                .map_err(|_| {
                    AppError::new(
                        "companion_frontend_unavailable",
                        "Companion response lock failed.",
                    )
                })?
                .insert(operation_id, sender);
            if app
                .emit(
                    "june://companion-request",
                    FrontendRequest {
                        operation_id,
                        intent,
                    },
                )
                .is_err()
            {
                remove_pending(app, operation_id);
                return Err(AppError::new(
                    "companion_frontend_unavailable",
                    "Open June on this Mac and try again.",
                ));
            }
            let result = tokio::time::timeout(FRONTEND_TIMEOUT, receiver)
                .await
                .map_err(|_| {
                    remove_pending(app, operation_id);
                    AppError::new(
                        "companion_frontend_timeout",
                        "June on this Mac did not finish the request in time.",
                    )
                })?
                .map_err(|_| {
                    AppError::new(
                        "companion_frontend_unavailable",
                        "June on this Mac stopped the request.",
                    )
                })?;
            let response = frontend_response(capability, result);
            repos
                .remember_companion_operation(
                    &peer_id.to_string(),
                    &operation_id.to_string(),
                    &serde_json::to_vec(&response).map_err(|_| {
                        AppError::new(
                            "companion_response_invalid",
                            "The companion response could not be encoded.",
                        )
                    })?,
                )
                .await?;
            Ok(response)
        }
    }
}

fn remove_pending(app: &AppHandle, operation_id: Uuid) {
    if let Ok(mut pending) = app.state::<CompanionRuntime>().pending_frontend.lock() {
        pending.remove(&operation_id);
    }
}

async fn send_envelope(
    socket: &mut RelaySocket,
    sender_device_id: Uuid,
    recipient_device_id: Uuid,
    ciphertext: Vec<u8>,
) -> Result<(), AppError> {
    let envelope = RelayEnvelope {
        version: june_companion_protocol::PROTOCOL_VERSION,
        sender_device_id,
        recipient_device_id,
        message_id: Uuid::new_v4(),
        created_at_ms: current_time_ms(),
        ciphertext,
    };
    envelope
        .validate()
        .map_err(|_| transport_error("The companion response exceeded its size limit."))?;
    let encoded = serde_json::to_vec(&envelope)
        .map_err(|_| transport_error("The companion relay frame could not be encoded."))?;
    if encoded.len() > june_companion_protocol::MAX_RELAY_ENVELOPE_BYTES {
        return Err(transport_error(
            "The companion relay frame exceeded its size limit.",
        ));
    }
    socket
        .send(Message::Binary(encoded.into()))
        .await
        .map_err(|_| transport_error("The companion relay disconnected."))
}

fn protocol_failure(error: &AppError) -> ProtocolFailure {
    let code = match error.code.as_str() {
        "unauthorized" => FailureCode::Unauthorized,
        "companion_replay_rejected" => FailureCode::Replay,
        "companion_frame_invalid" | "companion_device_name_invalid" => FailureCode::InvalidRequest,
        "companion_device_not_found" => FailureCode::NotFound,
        "note_revision_conflict" => FailureCode::Conflict,
        "companion_note_too_large" => FailureCode::Unsupported,
        "companion_frontend_timeout" => FailureCode::Busy,
        "companion_frontend_unavailable" => FailureCode::MacOffline,
        _ => FailureCode::Internal,
    };
    ProtocolFailure {
        code,
        message: error.message.clone(),
        retryable: matches!(
            code,
            FailureCode::Busy | FailureCode::MacOffline | FailureCode::Internal
        ),
    }
}

fn transport_error(message: &str) -> AppError {
    AppError::new("companion_transport_unavailable", message)
}
