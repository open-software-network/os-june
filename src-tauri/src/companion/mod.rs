mod controller;
mod transport;

use crate::{commands::repositories, domain::types::AppError};
use base64::{
    engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD},
    Engine as _,
};
use june_companion_crypto::{generate_identity, KEY_BYTES};
use june_companion_protocol::{AgentStatus, Capability, Event, ResultPayload, MAX_TEXT_BYTES};
use rand::{rngs::OsRng, RngCore};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{atomic::AtomicBool, Mutex},
};
use tauri::{AppHandle, State};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

pub use controller::{frontend_response, Controller, ControllerOutcome, FrontendIntent};

const KEYCHAIN_SERVICE: &str = "co.opensoftware.june.companion.desktop.identity";
const KEYCHAIN_ACCOUNT: &str = "current";
const MAX_DEVICE_NAME_BYTES: usize = 128;

#[derive(Default)]
pub struct CompanionRuntime {
    pub controller: Controller,
    pairings: Mutex<HashMap<Uuid, PendingPairing>>,
    pending_frontend: Mutex<HashMap<Uuid, oneshot::Sender<ResultPayload>>>,
    event_sender: Mutex<Option<mpsc::Sender<Event>>>,
    transport_started: AtomicBool,
}

struct PendingPairing {
    secret: [u8; KEY_BYTES],
    expires_at_ms: u64,
    approved_mobile: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredIdentity {
    device_id: Uuid,
    private_key_b64: String,
    public_key_b64: String,
}

impl StoredIdentity {
    fn private_key(&self) -> Result<[u8; KEY_BYTES], AppError> {
        decode_key(&self.private_key_b64)
    }
    fn public_key(&self) -> Result<[u8; KEY_BYTES], AppError> {
        decode_key(&self.public_key_b64)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingQrPayload {
    pairing_id: Uuid,
    expires_at_ms: u64,
    qr_svg: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingQrWirePayload {
    version: u16,
    pairing_id: Uuid,
    pairing_secret: String,
    relay_url: String,
    expires_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatus {
    pub pairing_id: Uuid,
    pub expires_at_ms: u64,
    pub state: PairingState,
    pub desktop_device_id: Uuid,
    pub desktop_public_key: Vec<u8>,
    pub mobile_device_id: Option<Uuid>,
    pub mobile_public_key: Option<Vec<u8>>,
    pub mobile_display_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PairingState {
    WaitingForPhone,
    WaitingForApproval,
    Approved,
    Expired,
}

#[derive(Debug, Deserialize)]
struct ApiEnvelope<T> {
    data: Option<T>,
    success: bool,
    message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatePairingRequest {
    desktop_device_id: Uuid,
    desktop_public_key: Vec<u8>,
    display_name: String,
    pairing_proof: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovePairingRequest {
    mobile_device_id: Uuid,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedDeviceDto {
    pub id: String,
    pub display_name: String,
    pub linked_at: String,
    pub last_seen_at: Option<String>,
    pub revoked_at: Option<String>,
    pub capabilities: Vec<Capability>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameDeviceRequest {
    pub device_id: String,
    pub display_name: String,
}

#[tauri::command]
pub async fn companion_begin_pairing(
    runtime: State<'_, CompanionRuntime>,
) -> Result<PairingQrPayload, AppError> {
    let identity = load_or_create_identity()?;
    let mut secret = [0_u8; KEY_BYTES];
    OsRng.fill_bytes(&mut secret);
    let status: PairingStatus = companion_post(
        "/v1/companion/pairings",
        &CreatePairingRequest {
            desktop_device_id: identity.device_id,
            desktop_public_key: identity.public_key()?.to_vec(),
            display_name: desktop_display_name(),
            pairing_proof: Sha256::digest(secret).to_vec(),
        },
    )
    .await?;
    runtime
        .pairings
        .lock()
        .map_err(|_| AppError::new("companion_pairing_unavailable", "Pairing lock failed."))?
        .insert(
            status.pairing_id,
            PendingPairing {
                secret,
                expires_at_ms: status.expires_at_ms,
                approved_mobile: None,
            },
        );
    let wire = PairingQrWirePayload {
        version: june_companion_protocol::PROTOCOL_VERSION,
        pairing_id: status.pairing_id,
        pairing_secret: URL_SAFE_NO_PAD.encode(secret),
        relay_url: relay_websocket_url(),
        expires_at_ms: status.expires_at_ms,
    };
    let encoded = serde_json::to_vec(&wire).map_err(|_| {
        AppError::new(
            "companion_pairing_invalid",
            "The pairing code could not be encoded.",
        )
    })?;
    let code = qrcode::QrCode::new(encoded).map_err(|_| {
        AppError::new(
            "companion_pairing_invalid",
            "The pairing code could not be generated.",
        )
    })?;
    let qr_svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(256, 256)
        .dark_color(qrcode::render::svg::Color("#17171A"))
        .light_color(qrcode::render::svg::Color("#FFFFFF"))
        .build();
    Ok(PairingQrPayload {
        pairing_id: status.pairing_id,
        expires_at_ms: status.expires_at_ms,
        qr_svg,
    })
}

#[tauri::command]
pub async fn companion_pairing_status(pairing_id: Uuid) -> Result<PairingStatus, AppError> {
    companion_get(&format!("/v1/companion/pairings/{pairing_id}")).await
}

#[tauri::command]
pub async fn companion_approve_pairing(
    app: AppHandle,
    runtime: State<'_, CompanionRuntime>,
    pairing_id: Uuid,
    mobile_device_id: Uuid,
) -> Result<PairingStatus, AppError> {
    {
        let pending = runtime
            .pairings
            .lock()
            .map_err(|_| AppError::new("companion_pairing_unavailable", "Pairing lock failed."))?;
        let pairing = pending.get(&pairing_id).ok_or_else(|| {
            AppError::new(
                "companion_pairing_expired",
                "Start pairing again on this Mac.",
            )
        })?;
        if pairing.expires_at_ms < current_time_ms() || pairing.secret.iter().all(|byte| *byte == 0)
        {
            return Err(AppError::new(
                "companion_pairing_expired",
                "Start pairing again on this Mac.",
            ));
        }
    }
    let status: PairingStatus = companion_post(
        &format!("/v1/companion/pairings/{pairing_id}/approve"),
        &ApprovePairingRequest { mobile_device_id },
    )
    .await?;
    let public_key = status.mobile_public_key.clone().ok_or_else(|| {
        AppError::new(
            "companion_pairing_invalid",
            "The phone public key is missing.",
        )
    })?;
    let display_name = status
        .mobile_display_name
        .clone()
        .unwrap_or_else(|| "iPhone".to_string());
    repositories(&app)
        .await?
        .upsert_companion_device(&mobile_device_id.to_string(), &display_name, &public_key)
        .await?;
    if let Some(pairing) = runtime
        .pairings
        .lock()
        .map_err(|_| AppError::new("companion_pairing_unavailable", "Pairing lock failed."))?
        .get_mut(&pairing_id)
    {
        pairing.approved_mobile = Some(mobile_device_id);
    }
    transport::start(&app);
    Ok(status)
}

#[tauri::command]
pub async fn companion_list_devices(app: AppHandle) -> Result<Vec<LinkedDeviceDto>, AppError> {
    Ok(repositories(&app)
        .await?
        .list_companion_devices()
        .await?
        .into_iter()
        .map(|device| LinkedDeviceDto {
            id: device.id,
            display_name: device.display_name,
            linked_at: device.linked_at,
            last_seen_at: device.last_seen_at,
            revoked_at: device.revoked_at,
            capabilities: companion_capabilities(),
        })
        .collect())
}

fn companion_capabilities() -> Vec<Capability> {
    vec![
        Capability::NotesRead,
        Capability::NotesEdit,
        Capability::AgentRead,
        Capability::AgentChat,
        Capability::AgentCancel,
        Capability::SettingsRead,
        Capability::SettingsEditSafe,
        Capability::RecordingControlExisting,
        Capability::AppFocus,
        Capability::DevicesReadSelf,
        Capability::DevicesRevokeSelf,
    ]
}

#[tauri::command]
pub async fn companion_rename_device(
    app: AppHandle,
    request: RenameDeviceRequest,
) -> Result<(), AppError> {
    let name = request.display_name.trim();
    if name.is_empty() || name.len() > MAX_DEVICE_NAME_BYTES {
        return Err(AppError::new(
            "companion_device_name_invalid",
            "Enter a shorter device name.",
        ));
    }
    repositories(&app)
        .await?
        .rename_companion_device(&request.device_id, name)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn companion_revoke_device(app: AppHandle, device_id: Uuid) -> Result<(), AppError> {
    let _: serde_json::Value = companion_post(
        &format!("/v1/companion/devices/{device_id}/revoke"),
        &serde_json::json!({}),
    )
    .await?;
    repositories(&app)
        .await?
        .revoke_companion_device(&device_id.to_string())
        .await?;
    Ok(())
}

#[tauri::command]
pub fn companion_complete_frontend_request(
    runtime: State<'_, CompanionRuntime>,
    operation_id: Uuid,
    result: ResultPayload,
) -> Result<(), AppError> {
    let sender = runtime
        .pending_frontend
        .lock()
        .map_err(|_| {
            AppError::new(
                "companion_frontend_unavailable",
                "Companion response lock failed.",
            )
        })?
        .remove(&operation_id)
        .ok_or_else(|| {
            AppError::new(
                "companion_request_expired",
                "The companion request already expired.",
            )
        })?;
    sender.send(result).map_err(|_| {
        AppError::new(
            "companion_request_expired",
            "The companion request already expired.",
        )
    })
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum CompanionAgentEventRequest {
    Delta {
        session_id: String,
        text: String,
    },
    Status {
        session_id: String,
        status: AgentStatus,
    },
}

#[tauri::command]
pub async fn companion_publish_agent_event(
    runtime: State<'_, CompanionRuntime>,
    request: CompanionAgentEventRequest,
) -> Result<(), AppError> {
    let (session_id, text) = match &request {
        CompanionAgentEventRequest::Delta { session_id, text } => (session_id, Some(text)),
        CompanionAgentEventRequest::Status { session_id, .. } => (session_id, None),
    };
    if session_id.is_empty()
        || session_id.len() > 256
        || text.is_some_and(|text| text.is_empty() || text.len() > MAX_TEXT_BYTES)
    {
        return Err(AppError::new(
            "companion_event_invalid",
            "The companion event exceeded its size limit.",
        ));
    }
    let event = match request {
        CompanionAgentEventRequest::Delta { session_id, text } => {
            Event::AgentDelta { session_id, text }
        }
        CompanionAgentEventRequest::Status { session_id, status } => {
            Event::AgentStatus { session_id, status }
        }
    };
    let sender = runtime
        .event_sender
        .lock()
        .map_err(|_| {
            AppError::new(
                "companion_transport_unavailable",
                "Companion event lock failed.",
            )
        })?
        .clone()
        .ok_or_else(|| {
            AppError::new(
                "companion_transport_unavailable",
                "No linked companion is connected.",
            )
        })?;
    sender.try_send(event).map_err(|_| {
        AppError::new(
            "companion_transport_busy",
            "Companion event delivery is busy.",
        )
    })
}

pub fn start(app: &AppHandle) {
    transport::start(app);
}

pub fn pairing_secret(
    runtime: &CompanionRuntime,
    pairing_id: Uuid,
) -> Result<[u8; KEY_BYTES], AppError> {
    let pairings = runtime
        .pairings
        .lock()
        .map_err(|_| AppError::new("companion_pairing_unavailable", "Pairing lock failed."))?;
    let pending = pairings.get(&pairing_id).ok_or_else(|| {
        AppError::new(
            "companion_pairing_expired",
            "Start pairing again on this Mac.",
        )
    })?;
    if pending.expires_at_ms < current_time_ms() {
        return Err(AppError::new(
            "companion_pairing_expired",
            "Start pairing again on this Mac.",
        ));
    }
    Ok(pending.secret)
}

fn pairing_for_mobile(
    runtime: &CompanionRuntime,
    mobile_device_id: Uuid,
) -> Result<Option<(Uuid, [u8; KEY_BYTES])>, AppError> {
    let pairings = runtime
        .pairings
        .lock()
        .map_err(|_| AppError::new("companion_pairing_unavailable", "Pairing lock failed."))?;
    Ok(pairings.iter().find_map(|(pairing_id, pairing)| {
        (pairing.approved_mobile == Some(mobile_device_id)
            && pairing.expires_at_ms >= current_time_ms())
        .then_some((*pairing_id, pairing.secret))
    }))
}

fn finish_pairing(runtime: &CompanionRuntime, pairing_id: Uuid) {
    if let Ok(mut pairings) = runtime.pairings.lock() {
        pairings.remove(&pairing_id);
    }
}

fn desktop_display_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "June on Mac".to_string())
}

fn relay_websocket_url() -> String {
    let base = crate::june_api::june_api_url();
    let base = base
        .strip_prefix("https://")
        .map(|rest| format!("wss://{rest}"))
        .or_else(|| {
            base.strip_prefix("http://")
                .map(|rest| format!("ws://{rest}"))
        })
        .unwrap_or(base);
    format!("{base}/v1/companion/relay")
}

async fn companion_get<T: DeserializeOwned>(path: &str) -> Result<T, AppError> {
    companion_send(path, |client, url, token| {
        client.get(url).bearer_auth(token)
    })
    .await
}

async fn companion_post<T: DeserializeOwned, B: Serialize + ?Sized>(
    path: &str,
    body: &B,
) -> Result<T, AppError> {
    companion_send(path, |client, url, token| {
        client.post(url).bearer_auth(token).json(body)
    })
    .await
}

async fn companion_send<T, F>(path: &str, build: F) -> Result<T, AppError>
where
    T: DeserializeOwned,
    F: Fn(&reqwest::Client, String, String) -> reqwest::RequestBuilder,
{
    let url = format!("{}{}", crate::june_api::june_api_url(), path);
    let client = reqwest::Client::new();
    let mut token = crate::os_accounts::access_token().await?;
    for attempt in 0..2 {
        let response = build(&client, url.clone(), token.clone())
            .send()
            .await
            .map_err(|_| {
                AppError::new(
                    "companion_relay_unavailable",
                    "The companion relay is unavailable.",
                )
            })?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            token = crate::os_accounts::refresh_access_token().await?;
            continue;
        }
        let status = response.status();
        let envelope: ApiEnvelope<T> = response.json().await.map_err(|_| {
            AppError::new(
                "companion_relay_invalid",
                "The companion relay returned an invalid response.",
            )
        })?;
        if status.is_success() && envelope.success {
            return envelope.data.ok_or_else(|| {
                AppError::new(
                    "companion_relay_invalid",
                    "The companion relay response was empty.",
                )
            });
        }
        return Err(AppError::new(
            "companion_relay_rejected",
            envelope
                .message
                .unwrap_or_else(|| "The companion relay rejected the request.".to_string()),
        ));
    }
    Err(AppError::new(
        "unauthorized",
        "Sign in to link a companion.",
    ))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn load_or_create_identity() -> Result<StoredIdentity, AppError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|_| AppError::new("companion_keychain_unavailable", "Keychain is unavailable."))?;
    if let Ok(encoded) = entry.get_password() {
        if let Ok(identity) = serde_json::from_str::<StoredIdentity>(&encoded) {
            if identity.private_key().is_ok() && identity.public_key().is_ok() {
                return Ok(identity);
            }
        }
    }
    let generated = generate_identity().map_err(|_| {
        AppError::new(
            "companion_identity_failed",
            "A companion identity could not be generated.",
        )
    })?;
    let identity = StoredIdentity {
        device_id: Uuid::new_v4(),
        private_key_b64: STANDARD_NO_PAD.encode(generated.private.as_slice()),
        public_key_b64: STANDARD_NO_PAD.encode(&generated.public),
    };
    let encoded = serde_json::to_string(&identity).map_err(|_| {
        AppError::new(
            "companion_identity_failed",
            "A companion identity could not be stored.",
        )
    })?;
    entry.set_password(&encoded).map_err(|_| {
        AppError::new(
            "companion_keychain_unavailable",
            "The companion identity could not be saved to Keychain.",
        )
    })?;
    Ok(identity)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn load_or_create_identity() -> Result<StoredIdentity, AppError> {
    Err(AppError::new(
        "companion_platform_unsupported",
        "June companion linking is available on supported desktop platforms.",
    ))
}

fn decode_key(encoded: &str) -> Result<[u8; KEY_BYTES], AppError> {
    STANDARD_NO_PAD
        .decode(encoded)
        .ok()
        .and_then(|value| value.try_into().ok())
        .ok_or_else(|| {
            AppError::new(
                "companion_identity_invalid",
                "The companion identity is invalid.",
            )
        })
}

fn current_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
