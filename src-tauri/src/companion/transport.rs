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

struct InflightOperationGuard {
    app: AppHandle,
    operation_id: Uuid,
}

struct TransportActivityGuard {
    app: AppHandle,
}

impl TransportActivityGuard {
    fn new(app: &AppHandle) -> Self {
        app.state::<CompanionRuntime>()
            .transport_activity
            .fetch_add(1, Ordering::AcqRel);
        Self { app: app.clone() }
    }
}

impl Drop for TransportActivityGuard {
    fn drop(&mut self) {
        let runtime = self.app.state::<CompanionRuntime>();
        runtime.transport_activity.fetch_sub(1, Ordering::AcqRel);
        runtime.transport_activity_changed.notify_one();
    }
}

impl Drop for InflightOperationGuard {
    fn drop(&mut self) {
        let waiters = self
            .app
            .state::<CompanionRuntime>()
            .inflight_operations
            .lock()
            .ok()
            .and_then(|mut operations| operations.remove(&self.operation_id))
            .unwrap_or_default();
        for waiter in waiters {
            let _ = waiter.send(());
        }
    }
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
        let activity = TransportActivityGuard::new(&app);
        if !app
            .state::<CompanionRuntime>()
            .account_transport_enabled
            .load(Ordering::Acquire)
        {
            drop(activity);
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        }
        let has_active_device = match (
            repositories(&app).await,
            crate::os_accounts::current_user_id().await,
        ) {
            (Ok(repos), Ok(account_user_id)) => repos
                .list_companion_devices(&account_user_id)
                .await
                .map(|devices| {
                    devices
                        .into_iter()
                        .any(|device| device.revoked_at.is_none())
                })
                .unwrap_or(false),
            _ => false,
        };
        if !has_active_device && !has_pending_pairing(&app.state::<CompanionRuntime>()) {
            drop(activity);
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
        drop(activity);
        let cap = 2_u64
            .saturating_pow(attempt)
            .clamp(1, MAX_RECONNECT_DELAY_SECS);
        let delay = rand::thread_rng().gen_range(0..=cap);
        tokio::time::sleep(Duration::from_secs(delay)).await;
    }
}

async fn connect_once(app: &AppHandle) -> Result<(), AppError> {
    let account_user_id = crate::os_accounts::current_user_id().await?;
    let identity = load_or_create_identity(&account_user_id)?;
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
                    Event::AgentDelta { stored_session_id, text } => {
                        let pending = pending_deltas.entry(stored_session_id.clone()).or_default();
                        if pending.len().saturating_add(text.len()) > june_companion_protocol::MAX_TEXT_BYTES {
                            let ready = std::mem::take(pending);
                            if !ready.is_empty() {
                                publish_event(
                                    &repos,
                                    &identity,
                                    &mut socket,
                                    &mut peers,
                                    &mut outbound_sequence,
                                    Event::AgentDelta { stored_session_id: stored_session_id.clone(), text: ready },
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
                if !runtime.account_transport_enabled.load(Ordering::Acquire) {
                    return Ok(());
                }
                for (stored_session_id, text) in pending_deltas.drain() {
                    if text.is_empty() { continue; }
                    publish_event(
                        &repos,
                        &identity,
                        &mut socket,
                        &mut peers,
                        &mut outbound_sequence,
                        Event::AgentDelta { stored_session_id, text },
                    ).await?;
                }
            }
            _ = runtime.account_session_changed.notified() => return Ok(()),
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
            .companion_device(&identity.account_user_id, &peer_id.to_string())
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
            .companion_device(&identity.account_user_id, &peer_id.to_string())
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
            authenticate_peer(app, repos, &identity.account_user_id, peer_id, &mut peer).await?;
        }
        entry.insert(peer);
        return Ok(());
    }

    let peer = peers
        .get_mut(&peer_id)
        .ok_or_else(|| transport_error("The linked device session disappeared."))?;
    let was_transport_ready = peer.crypto.is_transport_ready();
    let plaintext = match peer.crypto.read(&envelope.ciphertext) {
        Ok(plaintext) => plaintext,
        Err(_) if was_transport_ready => {
            // A mobile reconnect starts a fresh Noise handshake while the
            // desktop relay socket can stay open. Retire the stale peer
            // transport only when the same ciphertext authenticates as a new
            // pairing or linked-device handshake.
            let runtime = app.state::<CompanionRuntime>();
            let pairing = pairing_for_mobile(&runtime, peer_id)?;
            let mut replacement = if let Some((_, secret)) = pairing {
                Session::pairing(false, &identity.private_key()?, &secret)
            } else {
                Session::linked(false, &identity.private_key()?, &peer.expected_public_key)
            }
            .map_err(|_| transport_error("The secure companion session could not restart."))?;
            let handshake_payload = replacement
                .read(&envelope.ciphertext)
                .map_err(|_| transport_error("The encrypted companion frame was rejected."))?;
            if !handshake_payload.is_empty() {
                return Err(transport_error(
                    "The linked device handshake carried unexpected data.",
                ));
            }
            let response = replacement
                .write(&[])
                .map_err(|_| transport_error("The linked device handshake was rejected."))?;
            send_envelope(socket, identity.device_id, peer_id, response).await?;
            peer.crypto = replacement;
            peer.pairing_id = pairing.map(|(pairing_id, _)| pairing_id);
            if peer.crypto.is_transport_ready() {
                authenticate_peer(app, repos, &identity.account_user_id, peer_id, peer).await?;
            }
            return Ok(());
        }
        Err(_) => {
            return Err(transport_error("The linked device handshake was rejected."));
        }
    };
    if !was_transport_ready {
        if !plaintext.is_empty() {
            return Err(transport_error(
                "The linked device handshake carried unexpected data.",
            ));
        }
        if !peer.crypto.is_transport_ready() {
            return Err(transport_error(
                "The linked device handshake did not finish.",
            ));
        }
        authenticate_peer(app, repos, &identity.account_user_id, peer_id, peer).await?;
        return Ok(());
    }

    let frame = decode_frame(&plaintext, now)
        .map_err(|_| transport_error("The encrypted companion request is invalid."))?;
    let operation_id = frame.operation_id;
    let capability = frame.capability;
    let _operation_guard = reserve_operation(app, operation_id).await?;
    let result = dispatch_request(app, repos, &identity.account_user_id, peer_id, frame).await;
    let response = match result {
        Ok(response) => response,
        Err(error) => Response {
            capability,
            result: ResultPayload::Error(protocol_failure(&error)),
        },
    };
    if should_cache_response(&response) {
        repos
            .complete_companion_operation(
                &identity.account_user_id,
                &peer_id.to_string(),
                &operation_id.to_string(),
                &serde_json::to_vec(&response)
                    .map_err(|_| transport_error("The companion response could not be saved."))?,
            )
            .await?;
    }
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

async fn reserve_operation(
    app: &AppHandle,
    operation_id: Uuid,
) -> Result<InflightOperationGuard, AppError> {
    loop {
        let receiver = {
            let runtime = app.state::<CompanionRuntime>();
            let mut operations = runtime
                .inflight_operations
                .lock()
                .map_err(|_| transport_error("The companion operation lock failed."))?;
            if let std::collections::hash_map::Entry::Occupied(mut entry) =
                operations.entry(operation_id)
            {
                let (sender, receiver) = tokio::sync::oneshot::channel();
                entry.get_mut().push(sender);
                Some(receiver)
            } else {
                operations.insert(operation_id, Vec::new());
                None
            }
        };
        if let Some(receiver) = receiver {
            let _ = receiver.await;
        } else {
            return Ok(InflightOperationGuard {
                app: app.clone(),
                operation_id,
            });
        }
    }
}

async fn authenticate_peer(
    app: &AppHandle,
    repos: &Repositories,
    account_user_id: &str,
    peer_id: Uuid,
    peer: &mut PeerSession,
) -> Result<(), AppError> {
    if peer.crypto.remote_static() != Some(&peer.expected_public_key) {
        return Err(transport_error("The linked device identity did not match."));
    }
    app.state::<CompanionRuntime>()
        .controller
        .reset_sequence(&peer_id.to_string());
    repos
        .touch_companion_device(account_user_id, &peer_id.to_string())
        .await?;
    if let Some(pairing_id) = peer.pairing_id.take() {
        finish_pairing(&app.state::<CompanionRuntime>(), pairing_id);
    }
    Ok(())
}

async fn dispatch_request(
    app: &AppHandle,
    repos: &Repositories,
    account_user_id: &str,
    peer_id: Uuid,
    frame: Frame,
) -> Result<Response, AppError> {
    let operation_id = frame.operation_id;
    let capability = frame.capability;
    match app
        .state::<CompanionRuntime>()
        .controller
        .dispatch(
            app,
            repos,
            account_user_id,
            &peer_id.to_string(),
            frame,
            current_time_ms(),
        )
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
            Ok(frontend_response(capability, result))
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

fn should_cache_response(response: &Response) -> bool {
    !matches!(
        &response.result,
        ResultPayload::Error(ProtocolFailure {
            retryable: true,
            ..
        })
    )
}

fn transport_error(message: &str) -> AppError {
    AppError::new("companion_transport_unavailable", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use june_companion_crypto::{generate_identity, KEY_BYTES};
    use june_companion_protocol::Capability;

    #[test]
    fn final_pairing_handshake_read_is_not_an_application_frame() {
        let mobile = generate_identity().unwrap();
        let desktop = generate_identity().unwrap();
        let secret = [7_u8; KEY_BYTES];
        let mut initiator = Session::pairing(true, &mobile.private, &secret).unwrap();
        let mut responder = Session::pairing(false, &desktop.private, &secret).unwrap();

        let first = initiator.write(&[]).unwrap();
        assert_eq!(responder.read(&first).unwrap(), b"");
        let second = responder.write(&[]).unwrap();
        assert_eq!(initiator.read(&second).unwrap(), b"");
        let third = initiator.write(&[]).unwrap();

        let was_transport_ready = responder.is_transport_ready();
        let plaintext = responder.read(&third).unwrap();
        assert!(!was_transport_ready);
        assert!(responder.is_transport_ready());
        assert!(plaintext.is_empty());
    }

    #[test]
    fn fresh_linked_handshake_replaces_stale_transport_keys() {
        let mobile = generate_identity().unwrap();
        let desktop = generate_identity().unwrap();
        let secret = [7_u8; KEY_BYTES];
        let mut old_mobile = Session::pairing(true, &mobile.private, &secret).unwrap();
        let mut old_desktop = Session::pairing(false, &desktop.private, &secret).unwrap();
        let first = old_mobile.write(&[]).unwrap();
        old_desktop.read(&first).unwrap();
        let second = old_desktop.write(&[]).unwrap();
        old_mobile.read(&second).unwrap();
        let third = old_mobile.write(&[]).unwrap();
        old_desktop.read(&third).unwrap();

        let mut new_mobile = Session::linked(true, &mobile.private, &desktop.public).unwrap();
        let reconnect_first = new_mobile.write(&[]).unwrap();
        assert!(old_desktop.read(&reconnect_first).is_err());

        let mut new_desktop = Session::linked(false, &desktop.private, &mobile.public).unwrap();
        assert_eq!(new_desktop.read(&reconnect_first).unwrap(), b"");
        let reconnect_second = new_desktop.write(&[]).unwrap();
        assert_eq!(new_mobile.read(&reconnect_second).unwrap(), b"");
        assert!(new_desktop.is_transport_ready());
        assert!(new_mobile.is_transport_ready());
    }

    #[test]
    fn retryable_failures_are_not_cached_as_final_operation_results() {
        let response = Response {
            capability: Capability::AgentChat,
            result: ResultPayload::Error(ProtocolFailure {
                code: FailureCode::MacOffline,
                message: "Open June on your Mac and try again.".to_string(),
                retryable: true,
            }),
        };
        assert!(!should_cache_response(&response));

        let response = Response {
            capability: Capability::AgentChat,
            result: ResultPayload::Error(ProtocolFailure {
                code: FailureCode::InvalidRequest,
                message: "That request is invalid.".to_string(),
                retryable: false,
            }),
        };
        assert!(should_cache_response(&response));
    }
}
