//! Blind, bounded relay and desktop-approved pairing for the June companion.
//!
//! The relay parses routing metadata, never the encrypted companion frame. It
//! retains no offline control message: if the Mac is disconnected, delivery
//! fails closed and the phone must resync after reconnecting.

use crate::{
    ApiResponse,
    auth::{PROFILE_READ_SCOPE, authenticated_user_with_scope},
    error::ApiError,
    state::{ApiState, CompanionPushConfig},
};
use axum::{
    Json,
    extract::{
        Path, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, header::AUTHORIZATION},
    response::Response,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use june_companion_protocol::{MAX_RELAY_ENVELOPE_BYTES, PROTOCOL_VERSION, RelayEnvelope};
use june_domain::{
    CompanionApprovalRecord, CompanionDeviceRecord, CompanionLinkRecord, CompanionSnapshot,
    CompanionStore, CompanionStoreError, UserId,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::mpsc;
use uuid::Uuid;

const PAIRING_TTL_MS: u64 = 5 * 60 * 1_000;
const MAX_DEVICE_NAME_BYTES: usize = 128;
const OUTBOUND_QUEUE_CAPACITY: usize = 64;
const MAX_MESSAGES_PER_MINUTE: usize = 120;
const MIN_APNS_TOKEN_BYTES: usize = 16;
const MAX_APNS_TOKEN_BYTES: usize = 256;
const APNS_WAKE_COOLDOWN: Duration = Duration::from_secs(30);
const DEVICE_AUTH_SCHEME: &str = "Device ";
const SECRET_BYTES: usize = 32;
const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

pub(crate) struct CompanionRelay {
    inner: Mutex<RelayState>,
    store: Option<Arc<dyn CompanionStore>>,
    enabled: bool,
    push: Option<ApnsClient>,
}

#[derive(Default)]
struct RelayState {
    pairings: HashMap<Uuid, Pairing>,
    devices: HashMap<Uuid, Device>,
    links: HashSet<DeviceLink>,
    connections: HashMap<Uuid, Connection>,
    last_push_at: HashMap<Uuid, Instant>,
}

#[derive(Clone)]
struct Device {
    user_id: UserId,
    public_key: [u8; 32],
    display_name: String,
    credential_hash: Option<[u8; SECRET_BYTES]>,
    revoked: bool,
    push_token: Option<Vec<u8>>,
}

struct DeviceRegistration {
    device_id: Uuid,
    public_key: [u8; 32],
    display_name: String,
    credential_hash: Option<[u8; SECRET_BYTES]>,
}

struct Pairing {
    user_id: UserId,
    desktop_device_id: Uuid,
    proof: [u8; SECRET_BYTES],
    mobile_device_id: Option<Uuid>,
    mobile_credential: Option<String>,
    expires_at_ms: u64,
    approving: bool,
    approved: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct DeviceLink(Uuid, Uuid);

impl DeviceLink {
    fn new(left: Uuid, right: Uuid) -> Self {
        if left.as_bytes() <= right.as_bytes() {
            Self(left, right)
        } else {
            Self(right, left)
        }
    }

    fn contains(self, device_id: Uuid) -> bool {
        self.0 == device_id || self.1 == device_id
    }
}

struct Connection {
    id: Uuid,
    outbound: mpsc::Sender<Outbound>,
}

enum Outbound {
    Ciphertext(Vec<u8>),
    Revoked,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreatePairingRequest {
    desktop_device_id: Uuid,
    desktop_public_key: Vec<u8>,
    display_name: String,
    pairing_proof: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProposePairingRequest {
    mobile_device_id: Uuid,
    mobile_public_key: Vec<u8>,
    display_name: String,
    pairing_proof: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobilePairingStatusRequest {
    pairing_proof: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApprovePairingRequest {
    mobile_device_id: Uuid,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingResponse {
    pairing_id: Uuid,
    expires_at_ms: u64,
    state: PairingState,
    desktop_device_id: Uuid,
    desktop_public_key: Vec<u8>,
    mobile_device_id: Option<Uuid>,
    mobile_public_key: Option<Vec<u8>>,
    mobile_display_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobilePairingResponse {
    #[serde(flatten)]
    pairing: PairingResponse,
    device_credential: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum PairingState {
    WaitingForPhone,
    WaitingForApproval,
    Approved,
    Expired,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevokedResponse {
    revoked: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PushRegistrationResponse {
    registered: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegisterPushRequest {
    token: Vec<u8>,
}

#[derive(Clone)]
struct ApnsClient {
    http: reqwest::Client,
    config: CompanionPushConfig,
}

#[derive(Serialize)]
struct ApnsClaims<'a> {
    iss: &'a str,
    iat: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RelayQuery {
    device_id: Uuid,
}

pub(crate) async fn create_pairing(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<CreatePairingRequest>,
) -> Result<Json<ApiResponse<PairingResponse>>, ApiError> {
    let user_id = companion_user(&state, &headers).await?;
    let public_key = validate_device(&request.desktop_public_key, &request.display_name)?;
    let pairing_proof = validate_secret(&request.pairing_proof, "invalid_pairing_proof")?;
    let response = state.companion().create_pairing(
        user_id,
        DeviceRegistration {
            device_id: request.desktop_device_id,
            public_key,
            display_name: request.display_name,
            credential_hash: None,
        },
        pairing_proof,
    )?;
    Ok(Json(ApiResponse::ok(response)))
}

pub(crate) async fn propose_pairing(
    State(state): State<ApiState>,
    Path(pairing_id): Path<Uuid>,
    Json(request): Json<ProposePairingRequest>,
) -> Result<Json<ApiResponse<MobilePairingResponse>>, ApiError> {
    let public_key = validate_device(&request.mobile_public_key, &request.display_name)?;
    let pairing_proof = validate_secret(&request.pairing_proof, "invalid_pairing_proof")?;
    let response = state.companion().propose_pairing(
        pairing_id,
        DeviceRegistration {
            device_id: request.mobile_device_id,
            public_key,
            display_name: request.display_name,
            credential_hash: None,
        },
        &pairing_proof,
    )?;
    Ok(Json(ApiResponse::ok(MobilePairingResponse {
        pairing: response,
        device_credential: None,
    })))
}

pub(crate) async fn mobile_pairing_status(
    State(state): State<ApiState>,
    Path(pairing_id): Path<Uuid>,
    Json(request): Json<MobilePairingStatusRequest>,
) -> Result<Json<ApiResponse<MobilePairingResponse>>, ApiError> {
    let pairing_proof = validate_secret(&request.pairing_proof, "invalid_pairing_proof")?;
    let response = state
        .companion()
        .mobile_pairing_status(pairing_id, &pairing_proof)?;
    Ok(Json(ApiResponse::ok(response)))
}

pub(crate) async fn pairing_status(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(pairing_id): Path<Uuid>,
) -> Result<Json<ApiResponse<PairingResponse>>, ApiError> {
    let user_id = companion_user(&state, &headers).await?;
    let response = state.companion().pairing_status(&user_id, pairing_id)?;
    Ok(Json(ApiResponse::ok(response)))
}

pub(crate) async fn approve_pairing(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(pairing_id): Path<Uuid>,
    Json(request): Json<ApprovePairingRequest>,
) -> Result<Json<ApiResponse<PairingResponse>>, ApiError> {
    let user_id = companion_user(&state, &headers).await?;
    let response = state
        .companion()
        .approve_pairing(&user_id, pairing_id, request.mobile_device_id)
        .await?;
    Ok(Json(ApiResponse::ok(response)))
}

pub(crate) async fn revoke_device(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(device_id): Path<Uuid>,
) -> Result<Json<ApiResponse<RevokedResponse>>, ApiError> {
    let user_id = companion_device_user(&state, &headers, device_id).await?;
    state.companion().revoke(&user_id, device_id).await?;
    Ok(Json(ApiResponse::ok(RevokedResponse { revoked: true })))
}

pub(crate) async fn register_push(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(device_id): Path<Uuid>,
    Json(request): Json<RegisterPushRequest>,
) -> Result<Json<ApiResponse<PushRegistrationResponse>>, ApiError> {
    let user_id = companion_device_user(&state, &headers, device_id).await?;
    if request.token.len() < MIN_APNS_TOKEN_BYTES || request.token.len() > MAX_APNS_TOKEN_BYTES {
        return Err(ApiError::bad_request("invalid_push_token"));
    }
    state
        .companion()
        .register_push(&user_id, device_id, request.token)
        .await?;
    Ok(Json(ApiResponse::ok(PushRegistrationResponse {
        registered: true,
    })))
}

pub(crate) async fn relay_socket(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<RelayQuery>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let user_id = companion_device_user(&state, &headers, query.device_id).await?;
    state
        .companion()
        .authorize_connection(&user_id, query.device_id)?;
    Ok(upgrade.on_upgrade(move |socket| relay_connection(state, user_id, query.device_id, socket)))
}

async fn companion_user(state: &ApiState, headers: &HeaderMap) -> Result<UserId, ApiError> {
    authenticated_user_with_scope(state, headers, PROFILE_READ_SCOPE).await
}

async fn companion_device_user(
    state: &ApiState,
    headers: &HeaderMap,
    device_id: Uuid,
) -> Result<UserId, ApiError> {
    if let Some(credential) = device_credential(headers)? {
        return state
            .companion()
            .authorize_device_credential(device_id, credential);
    }
    companion_user(state, headers).await
}

fn device_credential(headers: &HeaderMap) -> Result<Option<&str>, ApiError> {
    let Some(value) = headers.get(AUTHORIZATION) else {
        return Ok(None);
    };
    let value = value
        .to_str()
        .map_err(|_| ApiError::unauthorized("invalid_device_credential"))?;
    if let Some(credential) = value.strip_prefix(DEVICE_AUTH_SCHEME) {
        if credential.is_empty() || credential.len() > 128 {
            return Err(ApiError::unauthorized("invalid_device_credential"));
        }
        return Ok(Some(credential));
    }
    Ok(None)
}

async fn relay_connection(state: ApiState, user_id: UserId, device_id: Uuid, socket: WebSocket) {
    let Ok((mut outbound, connection_id)) = state.companion().connect(&user_id, device_id) else {
        return;
    };
    let (mut sender, mut receiver) = socket.split();
    let mut message_times = VecDeque::new();
    loop {
        tokio::select! {
            outbound_message = outbound.recv() => {
                let message = match outbound_message {
                    Some(Outbound::Ciphertext(bytes)) => Message::Binary(bytes.into()),
                    Some(Outbound::Revoked) => Message::Close(None),
                    None => break,
                };
                if sender.send(message).await.is_err() { break; }
            }
            inbound = receiver.next() => {
                let Some(Ok(message)) = inbound else { break; };
                let bytes = match message {
                    Message::Binary(bytes) => bytes.to_vec(),
                    Message::Text(text) => text.as_bytes().to_vec(),
                    Message::Close(_) => break,
                    Message::Ping(payload) => {
                        if sender.send(Message::Pong(payload)).await.is_err() { break; }
                        continue;
                    }
                    Message::Pong(_) => continue,
                };
                if !allow_message(&mut message_times) { break; }
                if bytes.len() > MAX_RELAY_ENVELOPE_BYTES { break; }
                let Ok(envelope) = serde_json::from_slice::<RelayEnvelope>(&bytes) else { break; };
                if envelope.validate().is_err() || envelope.sender_device_id != device_id { break; }
                match state.companion().route(&user_id, envelope).await {
                    Ok(()) | Err(RelayError::RecipientOffline) => {}
                    Err(_) => break,
                }
            }
        }
    }
    state.companion().disconnect(device_id, connection_id);
}

fn allow_message(times: &mut VecDeque<Instant>) -> bool {
    let now = Instant::now();
    while times
        .front()
        .is_some_and(|at| now.duration_since(*at) >= Duration::from_mins(1))
    {
        times.pop_front();
    }
    if times.len() >= MAX_MESSAGES_PER_MINUTE {
        return false;
    }
    times.push_back(now);
    true
}

fn validate_device(public_key: &[u8], display_name: &str) -> Result<[u8; 32], ApiError> {
    if display_name.trim().is_empty() || display_name.len() > MAX_DEVICE_NAME_BYTES {
        return Err(ApiError::bad_request("invalid_device_name"));
    }
    public_key
        .try_into()
        .map_err(|_| ApiError::bad_request("invalid_device_public_key"))
}

fn validate_secret(value: &[u8], error: &'static str) -> Result<[u8; SECRET_BYTES], ApiError> {
    value.try_into().map_err(|_| ApiError::bad_request(error))
}

impl CompanionRelay {
    pub(crate) fn new(
        store: Option<Arc<dyn CompanionStore>>,
        snapshot: CompanionSnapshot,
        enabled: bool,
        push_config: Option<CompanionPushConfig>,
    ) -> Self {
        let devices = snapshot
            .devices
            .into_iter()
            .map(|record| {
                (
                    record.device_id,
                    Device {
                        user_id: record.user_id,
                        public_key: record.public_key,
                        display_name: record.display_name,
                        credential_hash: record.credential_hash,
                        revoked: false,
                        push_token: record.push_token,
                    },
                )
            })
            .collect();
        let links = snapshot
            .links
            .into_iter()
            .map(|link| DeviceLink::new(link.left_device_id, link.right_device_id))
            .collect();
        Self {
            inner: Mutex::new(RelayState {
                pairings: HashMap::new(),
                devices,
                links,
                connections: HashMap::new(),
                last_push_at: HashMap::new(),
            }),
            store,
            enabled,
            push: push_config.map(ApnsClient::new),
        }
    }

    fn ensure_enabled(&self) -> Result<(), ApiError> {
        if self.enabled {
            Ok(())
        } else {
            Err(ApiError::service_overloaded())
        }
    }

    fn create_pairing(
        &self,
        user_id: UserId,
        desktop: DeviceRegistration,
        proof: [u8; SECRET_BYTES],
    ) -> Result<PairingResponse, ApiError> {
        self.ensure_enabled()?;
        let pairing_id = Uuid::new_v4();
        let expires_at_ms = now_ms().saturating_add(PAIRING_TTL_MS);
        let desktop_device_id = desktop.device_id;
        let desktop_public_key = desktop.public_key.to_vec();
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        register_device(&mut state, &user_id, desktop)?;
        state.pairings.insert(
            pairing_id,
            Pairing {
                user_id,
                desktop_device_id,
                proof,
                mobile_device_id: None,
                mobile_credential: None,
                expires_at_ms,
                approving: false,
                approved: false,
            },
        );
        Ok(PairingResponse {
            pairing_id,
            expires_at_ms,
            state: PairingState::WaitingForPhone,
            desktop_device_id,
            desktop_public_key,
            mobile_device_id: None,
            mobile_public_key: None,
            mobile_display_name: None,
        })
    }

    fn propose_pairing(
        &self,
        pairing_id: Uuid,
        mobile: DeviceRegistration,
        proof: &[u8; SECRET_BYTES],
    ) -> Result<PairingResponse, ApiError> {
        self.ensure_enabled()?;
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mobile_device_id = mobile.device_id;
        let user_id = {
            let pairing = valid_mobile_pairing_mut(&mut state, pairing_id, proof)?;
            if pairing.expires_at_ms < now_ms() {
                return Err(ApiError::not_found("pairing_not_found"));
            }
            if pairing.approved || pairing.approving {
                return Err(ApiError::bad_request("pairing_closed"));
            }
            if pairing.desktop_device_id == mobile_device_id {
                return Err(ApiError::bad_request("pairing_device_mismatch"));
            }
            if pairing
                .mobile_device_id
                .is_some_and(|existing| existing != mobile_device_id)
            {
                return Err(ApiError::bad_request("pairing_already_claimed"));
            }
            pairing.user_id.clone()
        };
        register_device(&mut state, &user_id, mobile)?;
        state
            .pairings
            .get_mut(&pairing_id)
            .ok_or_else(|| ApiError::not_found("pairing_not_found"))?
            .mobile_device_id = Some(mobile_device_id);
        pairing_response(&state, pairing_id).ok_or_else(|| ApiError::not_found("pairing_not_found"))
    }

    fn mobile_pairing_status(
        &self,
        pairing_id: Uuid,
        proof: &[u8; SECRET_BYTES],
    ) -> Result<MobilePairingResponse, ApiError> {
        self.ensure_enabled()?;
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let pairing_state = valid_mobile_pairing_mut(&mut state, pairing_id, proof)?;
        let credential = (pairing_state.expires_at_ms >= now_ms() && pairing_state.approved)
            .then(|| pairing_state.mobile_credential.clone())
            .flatten();
        let pairing = pairing_response(&state, pairing_id)
            .ok_or_else(|| ApiError::not_found("pairing_not_found"))?;
        Ok(MobilePairingResponse {
            pairing,
            device_credential: credential,
        })
    }

    fn pairing_status(
        &self,
        user_id: &UserId,
        pairing_id: Uuid,
    ) -> Result<PairingResponse, ApiError> {
        self.ensure_enabled()?;
        let state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let pairing = state
            .pairings
            .get(&pairing_id)
            .ok_or_else(|| ApiError::not_found("pairing_not_found"))?;
        if &pairing.user_id != user_id {
            return Err(ApiError::not_found("pairing_not_found"));
        }
        pairing_response(&state, pairing_id).ok_or_else(|| ApiError::not_found("pairing_not_found"))
    }

    async fn approve_pairing(
        &self,
        user_id: &UserId,
        pairing_id: Uuid,
        mobile_device_id: Uuid,
    ) -> Result<PairingResponse, ApiError> {
        self.ensure_enabled()?;
        let (desktop_device_id, desktop, mut mobile) = {
            let mut state = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let pairing = valid_pairing_mut(&mut state, user_id, pairing_id)?;
            if pairing.mobile_device_id != Some(mobile_device_id) {
                return Err(ApiError::bad_request("pairing_device_mismatch"));
            }
            if pairing.approved {
                return pairing_response(&state, pairing_id)
                    .ok_or_else(|| ApiError::not_found("pairing_not_found"));
            }
            if pairing.approving {
                return Err(ApiError::service_overloaded());
            }
            pairing.approving = true;
            let desktop_device_id = pairing.desktop_device_id;
            let desktop = state
                .devices
                .get(&desktop_device_id)
                .cloned()
                .ok_or_else(|| ApiError::not_found("pairing_not_found"))?;
            let mobile = state
                .devices
                .get(&mobile_device_id)
                .cloned()
                .ok_or_else(|| ApiError::not_found("pairing_not_found"))?;
            (desktop_device_id, desktop, mobile)
        };
        let credential = new_device_credential();
        let credential_hash = hash_secret(credential.as_bytes());
        mobile.credential_hash = Some(credential_hash);
        let link = DeviceLink::new(desktop_device_id, mobile_device_id);
        if let Some(store) = &self.store {
            let persisted = store
                .approve_pairing(
                    user_id,
                    CompanionApprovalRecord {
                        desktop: device_record(desktop_device_id, &desktop),
                        mobile: device_record(mobile_device_id, &mobile),
                        link: CompanionLinkRecord {
                            left_device_id: link.0,
                            right_device_id: link.1,
                        },
                    },
                )
                .await;
            if let Err(error) = persisted {
                let mut state = self
                    .inner
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(pairing) = state.pairings.get_mut(&pairing_id) {
                    pairing.approving = false;
                }
                return Err(match error {
                    CompanionStoreError::IdentityConflict => {
                        ApiError::bad_request("device_identity_conflict")
                    }
                    CompanionStoreError::Unavailable { .. } => {
                        tracing::error!(%error, "companion pairing persistence failed");
                        ApiError::service_overloaded()
                    }
                });
            }
        }
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let pairing = state
            .pairings
            .get_mut(&pairing_id)
            .filter(|pairing| &pairing.user_id == user_id)
            .ok_or_else(|| ApiError::not_found("pairing_not_found"))?;
        pairing.approving = false;
        pairing.approved = true;
        pairing.mobile_credential = Some(credential);
        let device = state
            .devices
            .get_mut(&mobile_device_id)
            .ok_or_else(|| ApiError::not_found("pairing_not_found"))?;
        device.credential_hash = Some(credential_hash);
        state.links.insert(link);
        pairing_response(&state, pairing_id).ok_or_else(|| ApiError::not_found("pairing_not_found"))
    }

    fn authorize_device_credential(
        &self,
        device_id: Uuid,
        credential: &str,
    ) -> Result<UserId, ApiError> {
        self.ensure_enabled()?;
        let candidate = hash_secret(credential.as_bytes());
        let state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let device = state
            .devices
            .get(&device_id)
            .ok_or_else(|| ApiError::unauthorized("invalid_device_credential"))?;
        let Some(expected) = device.credential_hash else {
            return Err(ApiError::unauthorized("invalid_device_credential"));
        };
        if device.revoked
            || !state.links.iter().any(|link| link.contains(device_id))
            || !constant_time_equal(&expected, &candidate)
        {
            return Err(ApiError::unauthorized("invalid_device_credential"));
        }
        Ok(device.user_id.clone())
    }

    fn authorize_connection(&self, user_id: &UserId, device_id: Uuid) -> Result<(), ApiError> {
        self.ensure_enabled()?;
        let state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let device = state
            .devices
            .get(&device_id)
            .ok_or_else(|| ApiError::not_found("device_not_found"))?;
        if &device.user_id != user_id
            || device.revoked
            || !state.links.iter().any(|link| link.contains(device_id))
        {
            return Err(ApiError::not_found("device_not_found"));
        }
        Ok(())
    }

    fn connect(
        &self,
        user_id: &UserId,
        device_id: Uuid,
    ) -> Result<(mpsc::Receiver<Outbound>, Uuid), ApiError> {
        self.authorize_connection(user_id, device_id)?;
        let (outbound, receiver) = mpsc::channel(OUTBOUND_QUEUE_CAPACITY);
        let id = Uuid::new_v4();
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.connections.contains_key(&device_id) {
            return Err(ApiError::service_overloaded());
        }
        state
            .connections
            .insert(device_id, Connection { id, outbound });
        Ok((receiver, id))
    }

    fn disconnect(&self, device_id: Uuid, connection_id: Uuid) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state
            .connections
            .get(&device_id)
            .is_some_and(|connection| connection.id == connection_id)
        {
            state.connections.remove(&device_id);
        }
    }

    async fn route(&self, user_id: &UserId, envelope: RelayEnvelope) -> Result<(), RelayError> {
        let encoded = serde_json::to_vec(&envelope).map_err(|_| RelayError::InvalidEnvelope)?;
        if encoded.len() > MAX_RELAY_ENVELOPE_BYTES || envelope.version != PROTOCOL_VERSION {
            return Err(RelayError::InvalidEnvelope);
        }
        let push_token = {
            let mut state = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let sender = state
                .devices
                .get(&envelope.sender_device_id)
                .ok_or(RelayError::Unauthorized)?;
            let recipient = state
                .devices
                .get(&envelope.recipient_device_id)
                .ok_or(RelayError::Unauthorized)?;
            if sender.revoked
                || recipient.revoked
                || &sender.user_id != user_id
                || recipient.user_id != *user_id
            {
                return Err(RelayError::Unauthorized);
            }
            if !state.links.contains(&DeviceLink::new(
                envelope.sender_device_id,
                envelope.recipient_device_id,
            )) {
                return Err(RelayError::Unauthorized);
            }
            if let Some(connection) = state.connections.get(&envelope.recipient_device_id) {
                return connection
                    .outbound
                    .try_send(Outbound::Ciphertext(encoded))
                    .map_err(|_| RelayError::Backpressure);
            }
            let token = recipient.push_token.clone();
            if token.is_none()
                || state
                    .last_push_at
                    .get(&envelope.recipient_device_id)
                    .is_some_and(|last| last.elapsed() < APNS_WAKE_COOLDOWN)
            {
                None
            } else {
                state
                    .last_push_at
                    .insert(envelope.recipient_device_id, Instant::now());
                token
            }
        };
        if let (Some(push), Some(token)) = (&self.push, push_token)
            && let Err(error) = push.send_wake(&token).await
        {
            tracing::warn!(%error, "opaque companion wake delivery failed");
        }
        Err(RelayError::RecipientOffline)
    }

    async fn register_push(
        &self,
        user_id: &UserId,
        device_id: Uuid,
        token: Vec<u8>,
    ) -> Result<(), ApiError> {
        self.ensure_enabled()?;
        {
            let state = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let device = state
                .devices
                .get(&device_id)
                .ok_or_else(|| ApiError::not_found("device_not_found"))?;
            if &device.user_id != user_id
                || device.revoked
                || !state.links.iter().any(|link| link.contains(device_id))
            {
                return Err(ApiError::not_found("device_not_found"));
            }
        }
        if let Some(store) = &self.store {
            store
                .set_push_token(user_id, device_id, token.clone())
                .await
                .map_err(|error| {
                    tracing::error!(%error, "companion push-token persistence failed");
                    ApiError::service_overloaded()
                })?;
        }
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let device = state
            .devices
            .get_mut(&device_id)
            .ok_or_else(|| ApiError::not_found("device_not_found"))?;
        device.push_token = Some(token);
        Ok(())
    }

    async fn revoke(&self, user_id: &UserId, device_id: Uuid) -> Result<(), ApiError> {
        self.ensure_enabled()?;
        {
            let state = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let device = state
                .devices
                .get(&device_id)
                .ok_or_else(|| ApiError::not_found("device_not_found"))?;
            if &device.user_id != user_id {
                return Err(ApiError::not_found("device_not_found"));
            }
        }
        if let Some(store) = &self.store {
            store
                .revoke_device(user_id, device_id)
                .await
                .map_err(|error| {
                    tracing::error!(%error, "companion device revocation persistence failed");
                    ApiError::service_overloaded()
                })?;
        }
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let device = state
            .devices
            .get_mut(&device_id)
            .ok_or_else(|| ApiError::not_found("device_not_found"))?;
        if &device.user_id != user_id {
            return Err(ApiError::not_found("device_not_found"));
        }
        device.revoked = true;
        state.links.retain(|link| !link.contains(device_id));
        if let Some(connection) = state.connections.remove(&device_id) {
            let _ = connection.outbound.try_send(Outbound::Revoked);
        }
        Ok(())
    }
}

impl Default for CompanionRelay {
    fn default() -> Self {
        Self::new(None, CompanionSnapshot::default(), true, None)
    }
}

impl ApnsClient {
    fn new(config: CompanionPushConfig) -> Self {
        Self {
            http: reqwest::Client::new(),
            config,
        }
    }

    async fn send_wake(&self, device_token: &[u8]) -> Result<(), String> {
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(self.config.key_id.clone());
        let key = EncodingKey::from_ec_pem(self.config.private_key_pem.as_bytes())
            .map_err(|error| format!("invalid APNs signing key: {error}"))?;
        let authorization = encode(
            &header,
            &ApnsClaims {
                iss: &self.config.team_id,
                iat: now_ms() / 1_000,
            },
            &key,
        )
        .map_err(|error| format!("APNs token signing failed: {error}"))?;
        let host = if self.config.production {
            "https://api.push.apple.com"
        } else {
            "https://api.sandbox.push.apple.com"
        };
        let mut token = String::with_capacity(device_token.len() * 2);
        for byte in device_token {
            token.push(char::from(HEX_DIGITS[usize::from(byte >> 4)]));
            token.push(char::from(HEX_DIGITS[usize::from(byte & 0x0f)]));
        }
        let response = self
            .http
            .post(format!("{host}/3/device/{token}"))
            .bearer_auth(authorization)
            .header("apns-topic", &self.config.bundle_id)
            .header("apns-push-type", "background")
            .header("apns-priority", "5")
            .json(&serde_json::json!({ "aps": { "content-available": 1 } }))
            .send()
            .await
            .map_err(|error| format!("APNs request failed: {error}"))?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(format!(
                "APNs rejected generic wake with status {}",
                response.status()
            ))
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RelayError {
    InvalidEnvelope,
    Unauthorized,
    RecipientOffline,
    Backpressure,
}

fn valid_pairing_mut<'a>(
    state: &'a mut RelayState,
    user_id: &UserId,
    pairing_id: Uuid,
) -> Result<&'a mut Pairing, ApiError> {
    let pairing = state
        .pairings
        .get_mut(&pairing_id)
        .ok_or_else(|| ApiError::not_found("pairing_not_found"))?;
    if &pairing.user_id != user_id || pairing.expires_at_ms < now_ms() {
        return Err(ApiError::not_found("pairing_not_found"));
    }
    Ok(pairing)
}

fn valid_mobile_pairing_mut<'a>(
    state: &'a mut RelayState,
    pairing_id: Uuid,
    proof: &[u8; SECRET_BYTES],
) -> Result<&'a mut Pairing, ApiError> {
    let pairing = state
        .pairings
        .get_mut(&pairing_id)
        .ok_or_else(|| ApiError::not_found("pairing_not_found"))?;
    if !constant_time_equal(&pairing.proof, proof) {
        return Err(ApiError::not_found("pairing_not_found"));
    }
    Ok(pairing)
}

fn register_device(
    state: &mut RelayState,
    user_id: &UserId,
    registration: DeviceRegistration,
) -> Result<(), ApiError> {
    let DeviceRegistration {
        device_id,
        public_key,
        display_name,
        credential_hash,
    } = registration;
    if let Some(device) = state.devices.get_mut(&device_id) {
        if &device.user_id != user_id || device.public_key != public_key || device.revoked {
            return Err(ApiError::bad_request("device_identity_conflict"));
        }
        device.display_name = display_name;
        if credential_hash.is_some() {
            device.credential_hash = credential_hash;
        }
        return Ok(());
    }
    state.devices.insert(
        device_id,
        Device {
            user_id: user_id.clone(),
            public_key,
            display_name,
            credential_hash,
            revoked: false,
            push_token: None,
        },
    );
    Ok(())
}

fn device_record(device_id: Uuid, device: &Device) -> CompanionDeviceRecord {
    CompanionDeviceRecord {
        device_id,
        user_id: device.user_id.clone(),
        public_key: device.public_key,
        display_name: device.display_name.clone(),
        credential_hash: device.credential_hash,
        push_token: device.push_token.clone(),
    }
}

fn new_device_credential() -> String {
    let mut bytes = Vec::with_capacity(SECRET_BYTES);
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn hash_secret(value: &[u8]) -> [u8; SECRET_BYTES] {
    Sha256::digest(value).into()
}

fn constant_time_equal(left: &[u8; SECRET_BYTES], right: &[u8; SECRET_BYTES]) -> bool {
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn pairing_response(state: &RelayState, pairing_id: Uuid) -> Option<PairingResponse> {
    let pairing = state.pairings.get(&pairing_id)?;
    let desktop = state.devices.get(&pairing.desktop_device_id)?;
    let mobile = pairing
        .mobile_device_id
        .and_then(|id| state.devices.get(&id).map(|device| (id, device)));
    let pairing_state = if pairing.expires_at_ms < now_ms() {
        PairingState::Expired
    } else if pairing.approved {
        PairingState::Approved
    } else if mobile.is_some() {
        PairingState::WaitingForApproval
    } else {
        PairingState::WaitingForPhone
    };
    Some(PairingResponse {
        pairing_id,
        expires_at_ms: pairing.expires_at_ms,
        state: pairing_state,
        desktop_device_id: pairing.desktop_device_id,
        desktop_public_key: desktop.public_key.to_vec(),
        mobile_device_id: mobile.map(|(id, _)| id),
        mobile_public_key: mobile.map(|(_, device)| device.public_key.to_vec()),
        mobile_display_name: mobile.map(|(_, device)| device.display_name.clone()),
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user() -> UserId {
        UserId("usr_companion".to_string())
    }

    fn device(device_id: Uuid, public_key: [u8; 32], display_name: &str) -> DeviceRegistration {
        DeviceRegistration {
            device_id,
            public_key,
            display_name: display_name.to_string(),
            credential_hash: None,
        }
    }

    async fn linked_relay() -> (CompanionRelay, Uuid, Uuid) {
        let relay = CompanionRelay::default();
        let desktop = Uuid::new_v4();
        let mobile = Uuid::new_v4();
        let proof = [9; SECRET_BYTES];
        let pairing = relay
            .create_pairing(user(), device(desktop, [1; 32], "Mac"), proof)
            .unwrap();
        relay
            .propose_pairing(
                pairing.pairing_id,
                device(mobile, [2; 32], "iPhone"),
                &proof,
            )
            .unwrap();
        relay
            .approve_pairing(&user(), pairing.pairing_id, mobile)
            .await
            .unwrap();
        (relay, desktop, mobile)
    }

    #[tokio::test]
    async fn pairing_proof_and_desktop_approval_issue_a_scoped_device_credential() {
        let relay = CompanionRelay::default();
        let desktop = Uuid::new_v4();
        let mobile = Uuid::new_v4();
        let proof = [3; SECRET_BYTES];
        let pairing = relay
            .create_pairing(user(), device(desktop, [1; 32], "Mac"), proof)
            .unwrap();

        assert!(
            relay
                .propose_pairing(
                    pairing.pairing_id,
                    device(mobile, [2; 32], "iPhone"),
                    &[4; SECRET_BYTES],
                )
                .is_err()
        );
        relay
            .propose_pairing(
                pairing.pairing_id,
                device(mobile, [2; 32], "iPhone"),
                &proof,
            )
            .unwrap();
        relay
            .approve_pairing(&user(), pairing.pairing_id, mobile)
            .await
            .unwrap();

        let status = relay
            .mobile_pairing_status(pairing.pairing_id, &proof)
            .unwrap();
        let credential = status.device_credential.unwrap();
        assert_eq!(
            relay
                .authorize_device_credential(mobile, &credential)
                .unwrap(),
            user()
        );
        assert!(relay.authorize_device_credential(mobile, "wrong").is_err());
    }

    #[tokio::test]
    async fn duplicate_device_id_with_different_identity_is_rejected() {
        let relay = CompanionRelay::default();
        let desktop = Uuid::new_v4();
        relay
            .create_pairing(
                user(),
                device(desktop, [1; SECRET_BYTES], "Mac"),
                [2; SECRET_BYTES],
            )
            .unwrap();

        assert!(
            relay
                .create_pairing(
                    user(),
                    device(desktop, [9; SECRET_BYTES], "Mac"),
                    [3; SECRET_BYTES],
                )
                .is_err()
        );
    }

    #[tokio::test]
    async fn routes_only_ciphertext_between_explicitly_linked_devices() {
        let (relay, desktop, mobile) = linked_relay().await;
        let (mut receiver, _) = relay.connect(&user(), desktop).unwrap();
        let envelope = RelayEnvelope {
            version: PROTOCOL_VERSION,
            sender_device_id: mobile,
            recipient_device_id: desktop,
            message_id: Uuid::new_v4(),
            created_at_ms: now_ms(),
            ciphertext: vec![8, 9, 10],
        };
        relay.route(&user(), envelope.clone()).await.unwrap();
        let Outbound::Ciphertext(encoded) = receiver.recv().await.unwrap() else {
            panic!("ciphertext")
        };
        let routed: RelayEnvelope = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(routed, envelope);
    }

    #[tokio::test]
    async fn offline_control_is_not_queued_and_unlinked_routes_are_denied() {
        let (relay, desktop, mobile) = linked_relay().await;
        let envelope = RelayEnvelope {
            version: PROTOCOL_VERSION,
            sender_device_id: mobile,
            recipient_device_id: desktop,
            message_id: Uuid::new_v4(),
            created_at_ms: now_ms(),
            ciphertext: vec![1],
        };
        assert_eq!(
            relay.route(&user(), envelope).await,
            Err(RelayError::RecipientOffline)
        );

        let other = UserId("usr_other".to_string());
        assert!(relay.authorize_connection(&other, desktop).is_err());
    }

    #[tokio::test]
    async fn revocation_closes_current_and_blocks_future_connections() {
        let (relay, desktop, _) = linked_relay().await;
        let (mut receiver, _) = relay.connect(&user(), desktop).unwrap();
        relay.revoke(&user(), desktop).await.unwrap();
        assert!(matches!(receiver.recv().await, Some(Outbound::Revoked)));
        assert!(relay.connect(&user(), desktop).is_err());
    }

    #[test]
    fn frame_rate_limiter_is_fail_closed() {
        let mut times = VecDeque::new();
        for _ in 0..MAX_MESSAGES_PER_MINUTE {
            assert!(allow_message(&mut times));
        }
        assert!(!allow_message(&mut times));
    }
}
