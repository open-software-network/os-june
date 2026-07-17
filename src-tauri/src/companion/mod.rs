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
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, oneshot, Notify};
use uuid::Uuid;

pub use controller::{frontend_response, Controller, ControllerOutcome, FrontendIntent};

const KEYCHAIN_SERVICE: &str = "co.opensoftware.june.companion.desktop.identity";
const MAX_DEVICE_NAME_BYTES: usize = 128;
const PAIRING_RELAY_READY_TIMEOUT: Duration = Duration::from_secs(10);
const ACCOUNT_ACTIVITY_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(35);

pub struct CompanionRuntime {
    pub controller: Controller,
    pairings: Mutex<HashMap<Uuid, PendingPairing>>,
    pending_frontend: Mutex<HashMap<Uuid, oneshot::Sender<ResultPayload>>>,
    inflight_operations: Mutex<HashMap<Uuid, Vec<oneshot::Sender<()>>>>,
    event_sender: Mutex<Option<mpsc::Sender<Event>>>,
    transport_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    relay_connected: AtomicBool,
    relay_connection_changed: Notify,
    account_transport_enabled: AtomicBool,
    account_session_changed: Notify,
    account_activity: AtomicUsize,
    account_activity_changed: Notify,
}

impl Default for CompanionRuntime {
    fn default() -> Self {
        Self {
            controller: Controller::default(),
            pairings: Mutex::default(),
            pending_frontend: Mutex::default(),
            inflight_operations: Mutex::default(),
            event_sender: Mutex::default(),
            transport_task: Mutex::default(),
            relay_connected: AtomicBool::new(false),
            relay_connection_changed: Notify::new(),
            account_transport_enabled: AtomicBool::new(true),
            account_session_changed: Notify::new(),
            account_activity: AtomicUsize::new(0),
            account_activity_changed: Notify::new(),
        }
    }
}

struct PendingPairing {
    secret: [u8; KEY_BYTES],
    expires_at_ms: u64,
    approved_mobile: Option<Uuid>,
}

struct CompanionAccountActivityGuard<'a> {
    runtime: &'a CompanionRuntime,
}

impl<'a> CompanionAccountActivityGuard<'a> {
    fn begin(runtime: &'a CompanionRuntime) -> Result<Self, AppError> {
        runtime.account_activity.fetch_add(1, Ordering::AcqRel);
        let guard = Self { runtime };
        if !runtime.account_transport_enabled.load(Ordering::Acquire) {
            return Err(AppError::new(
                "unauthorized",
                "Sign in to manage companion devices.",
            ));
        }
        Ok(guard)
    }
}

impl Drop for CompanionAccountActivityGuard<'_> {
    fn drop(&mut self) {
        self.runtime.account_activity.fetch_sub(1, Ordering::AcqRel);
        self.runtime.account_activity_changed.notify_one();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredIdentity {
    account_user_id: String,
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
    let _account_activity = CompanionAccountActivityGuard::begin(&runtime)?;
    let account_user_id = crate::os_accounts::current_user_id().await?;
    let identity = load_or_create_identity(&account_user_id)?;
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
    remember_pending_pairing(
        &runtime,
        status.pairing_id,
        PendingPairing {
            secret,
            expires_at_ms: status.expires_at_ms,
            approved_mobile: None,
        },
    )?;
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

fn remember_pending_pairing(
    runtime: &CompanionRuntime,
    pairing_id: Uuid,
    pairing: PendingPairing,
) -> Result<(), AppError> {
    let mut pairings = runtime
        .pairings
        .lock()
        .map_err(|_| AppError::new("companion_pairing_unavailable", "Pairing lock failed."))?;
    if !runtime.account_transport_enabled.load(Ordering::Acquire) {
        return Err(AppError::new(
            "unauthorized",
            "Sign in to manage companion devices.",
        ));
    }
    pairings.insert(pairing_id, pairing);
    Ok(())
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
    let _account_activity = CompanionAccountActivityGuard::begin(&runtime)?;
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
    let proposed: PairingStatus =
        companion_get(&format!("/v1/companion/pairings/{pairing_id}")).await?;
    let already_approved = proposed.state == PairingState::Approved;
    if (!already_approved && proposed.state != PairingState::WaitingForApproval)
        || proposed.mobile_device_id != Some(mobile_device_id)
    {
        return Err(AppError::new(
            "companion_pairing_invalid",
            "The phone is not waiting for approval.",
        ));
    }
    let public_key = proposed.mobile_public_key.clone().ok_or_else(|| {
        AppError::new(
            "companion_pairing_invalid",
            "The phone public key is missing.",
        )
    })?;
    if public_key.len() != KEY_BYTES {
        return Err(AppError::new(
            "companion_pairing_invalid",
            "The phone public key is invalid.",
        ));
    }
    let display_name = proposed
        .mobile_display_name
        .clone()
        .unwrap_or_else(|| "iPhone".to_string());
    let repos = repositories(&app).await?;
    let account_user_id = crate::os_accounts::current_user_id().await?;
    let mobile_id = mobile_device_id.to_string();
    let existing = repos.companion_device(&account_user_id, &mobile_id).await?;
    if existing.as_ref().is_some_and(|device| {
        device.revoked_at.is_some() || device.public_key.as_slice() != public_key.as_slice()
    }) {
        return Err(AppError::new(
            "companion_pairing_invalid",
            "The phone identity does not match this device.",
        ));
    }
    let inserted_locally = existing.is_none();
    mark_pairing_mobile(&runtime, pairing_id, mobile_device_id)?;
    if inserted_locally {
        if let Err(error) = repos
            .upsert_companion_device(&account_user_id, &mobile_id, &display_name, &public_key)
            .await
        {
            clear_pairing_mobile(&runtime, pairing_id, mobile_device_id);
            return Err(error.into());
        }
    }
    transport::start(&app);

    if let Err(error) = wait_for_relay_connection(&runtime).await {
        clear_pairing_mobile(&runtime, pairing_id, mobile_device_id);
        if inserted_locally {
            repos
                .delete_companion_device(&account_user_id, &mobile_id)
                .await?;
        }
        return Err(error);
    }
    let approval: Result<PairingStatus, AppError> = if already_approved {
        Ok(proposed)
    } else {
        companion_post(
            &format!("/v1/companion/pairings/{pairing_id}/approve"),
            &ApprovePairingRequest { mobile_device_id },
        )
        .await
    };
    let status = match approval {
        Ok(status) if status.state == PairingState::Approved => status,
        Ok(_) => {
            clear_pairing_mobile(&runtime, pairing_id, mobile_device_id);
            if inserted_locally {
                repos
                    .delete_companion_device(&account_user_id, &mobile_id)
                    .await?;
            }
            return Err(AppError::new(
                "companion_pairing_expired",
                "Start pairing again on this Mac.",
            ));
        }
        Err(error) => {
            match companion_get::<PairingStatus>(&format!("/v1/companion/pairings/{pairing_id}"))
                .await
            {
                Ok(status) if status.state == PairingState::Approved => status,
                Ok(_) => {
                    clear_pairing_mobile(&runtime, pairing_id, mobile_device_id);
                    if inserted_locally {
                        repos
                            .delete_companion_device(&account_user_id, &mobile_id)
                            .await?;
                    }
                    return Err(error);
                }
                Err(reconcile_error) => {
                    tracing::warn!(
                        code = %reconcile_error.code,
                        "companion approval outcome is unknown; preserving local readiness"
                    );
                    return Err(error);
                }
            }
        }
    };
    if !inserted_locally {
        if let Err(error) = repos
            .upsert_companion_device(&account_user_id, &mobile_id, &display_name, &public_key)
            .await
        {
            tracing::warn!(%error, "failed to refresh linked companion display metadata");
        }
    }
    Ok(status)
}

fn mark_pairing_mobile(
    runtime: &CompanionRuntime,
    pairing_id: Uuid,
    mobile_device_id: Uuid,
) -> Result<(), AppError> {
    let mut pairings = runtime
        .pairings
        .lock()
        .map_err(|_| AppError::new("companion_pairing_unavailable", "Pairing lock failed."))?;
    let pairing = pairings.get_mut(&pairing_id).ok_or_else(|| {
        AppError::new(
            "companion_pairing_expired",
            "Start pairing again on this Mac.",
        )
    })?;
    if pairing.expires_at_ms < current_time_ms() {
        return Err(AppError::new(
            "companion_pairing_expired",
            "Start pairing again on this Mac.",
        ));
    }
    if pairing
        .approved_mobile
        .is_some_and(|approved| approved != mobile_device_id)
    {
        return Err(AppError::new(
            "companion_pairing_invalid",
            "A different phone is already waiting for approval.",
        ));
    }
    pairing.approved_mobile = Some(mobile_device_id);
    Ok(())
}

fn clear_pairing_mobile(runtime: &CompanionRuntime, pairing_id: Uuid, mobile_device_id: Uuid) {
    if let Ok(mut pairings) = runtime.pairings.lock() {
        if let Some(pairing) = pairings.get_mut(&pairing_id) {
            if pairing.approved_mobile == Some(mobile_device_id) {
                pairing.approved_mobile = None;
            }
        }
    }
}

async fn wait_for_relay_connection(runtime: &CompanionRuntime) -> Result<(), AppError> {
    let deadline = tokio::time::Instant::now() + PAIRING_RELAY_READY_TIMEOUT;
    loop {
        let connected = runtime.relay_connection_changed.notified();
        if runtime.relay_connected.load(Ordering::Acquire) {
            return Ok(());
        }
        if tokio::time::timeout_at(deadline, connected).await.is_err() {
            return Err(AppError::new(
                "companion_transport_unavailable",
                "June could not prepare the secure companion connection.",
            ));
        }
    }
}

fn has_pending_pairing(runtime: &CompanionRuntime) -> bool {
    runtime
        .pairings
        .lock()
        .map(|pairings| {
            pairings
                .values()
                .any(|pairing| pairing.expires_at_ms >= current_time_ms())
        })
        .unwrap_or(false)
}

#[tauri::command]
pub async fn companion_list_devices(app: AppHandle) -> Result<Vec<LinkedDeviceDto>, AppError> {
    let account_user_id = crate::os_accounts::current_user_id().await?;
    Ok(repositories(&app)
        .await?
        .list_companion_devices(&account_user_id)
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
        .rename_companion_device(
            &crate::os_accounts::current_user_id().await?,
            &request.device_id,
            name,
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn companion_revoke_device(app: AppHandle, device_id: Uuid) -> Result<(), AppError> {
    let account_user_id = crate::os_accounts::current_user_id().await?;
    revoke_device_remote(device_id).await?;
    repositories(&app)
        .await?
        .revoke_companion_device(&account_user_id, &device_id.to_string())
        .await?;
    Ok(())
}

async fn revoke_device_remote(device_id: Uuid) -> Result<(), AppError> {
    let _: serde_json::Value = companion_post(
        &format!("/v1/companion/devices/{device_id}/revoke"),
        &serde_json::json!({}),
    )
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
        stored_session_id: String,
        text: String,
    },
    Status {
        stored_session_id: String,
        status: AgentStatus,
    },
}

#[tauri::command]
pub async fn companion_publish_agent_event(
    runtime: State<'_, CompanionRuntime>,
    request: CompanionAgentEventRequest,
) -> Result<(), AppError> {
    let (stored_session_id, text) = match &request {
        CompanionAgentEventRequest::Delta {
            stored_session_id,
            text,
        } => (stored_session_id, Some(text)),
        CompanionAgentEventRequest::Status {
            stored_session_id, ..
        } => (stored_session_id, None),
    };
    if stored_session_id.is_empty()
        || stored_session_id.len() > 256
        || text.is_some_and(|text| text.is_empty() || text.len() > MAX_TEXT_BYTES)
    {
        return Err(AppError::new(
            "companion_event_invalid",
            "The companion event exceeded its size limit.",
        ));
    }
    let event = match request {
        CompanionAgentEventRequest::Delta {
            stored_session_id,
            text,
        } => Event::AgentDelta {
            stored_session_id,
            text,
        },
        CompanionAgentEventRequest::Status {
            stored_session_id,
            status,
        } => Event::AgentStatus {
            stored_session_id,
            status,
        },
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

pub async fn prepare_account_logout(app: &AppHandle) -> Result<(), AppError> {
    let runtime = app.state::<CompanionRuntime>();
    runtime
        .account_transport_enabled
        .store(false, Ordering::Release);
    runtime.account_session_changed.notify_waiters();
    if let Ok(mut pairings) = runtime.pairings.lock() {
        pairings.clear();
    }
    transport::stop(app).await?;

    // A relay task may be awaiting a frontend-backed operation, or pairing may
    // be committing an authorization grant. Wait until all authorized account
    // work observes the sign-out boundary before revoking local state.
    tokio::time::timeout(ACCOUNT_ACTIVITY_SHUTDOWN_TIMEOUT, async {
        loop {
            let stopped = runtime.account_activity_changed.notified();
            if runtime.account_activity.load(Ordering::Acquire) == 0 {
                break;
            }
            stopped.await;
        }
    })
    .await
    .map_err(|_| {
        AppError::new(
            "companion_logout_busy",
            "Companion activity did not stop in time. Try signing out again.",
        )
    })?;

    let repos = repositories(app).await?;
    let persisted_account_user_id = repos.companion_account_user_id().await?;
    let stored_account_user_id = match crate::os_accounts::stored_user_id().await {
        Ok(account_user_id) => account_user_id,
        Err(error) if persisted_account_user_id.is_none() => return Err(error),
        Err(error) => {
            tracing::warn!(code = %error.code, "OS Accounts storage was unreadable during companion logout");
            None
        }
    };
    let account_user_ids = [stored_account_user_id, persisted_account_user_id]
        .into_iter()
        .flatten()
        .collect::<HashSet<_>>();
    if account_user_ids.is_empty() {
        return Ok(());
    }
    let mut remote_device_ids = HashSet::new();
    for account_user_id in account_user_ids {
        if let Ok(devices) = repos.list_companion_devices(&account_user_id).await {
            remote_device_ids.extend(
                devices
                    .into_iter()
                    .filter(|device| device.revoked_at.is_none())
                    .filter_map(|device| Uuid::parse_str(&device.id).ok()),
            );
        }
        repos
            .revoke_companion_devices_for_account(&account_user_id)
            .await?;
        if let Ok(Some(identity)) = load_identity(&account_user_id) {
            remote_device_ids.insert(identity.device_id);
        }
        remove_identity(&account_user_id);
    }

    // Local authorization is already gone. Remote cleanup is best effort and
    // may fail offline without allowing a later sign-in to revive old links.
    futures_util::future::join_all(remote_device_ids.into_iter().map(revoke_device_remote)).await;
    Ok(())
}

pub fn resume_account_transport(app: &AppHandle) {
    let runtime = app.state::<CompanionRuntime>();
    runtime
        .account_transport_enabled
        .store(true, Ordering::Release);
    runtime.account_session_changed.notify_waiters();
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
    #[cfg(target_os = "macos")]
    if let Ok(output) = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
    {
        let name = output
            .status
            .success()
            .then(|| normalized_device_name(&String::from_utf8_lossy(&output.stdout)))
            .flatten();
        if let Some(name) = name {
            return name;
        }
    }
    std::env::var("COMPUTERNAME")
        .ok()
        .and_then(|value| normalized_device_name(&value))
        .unwrap_or_else(|| "June on Mac".to_string())
}

fn normalized_device_name(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let mut end = value.len().min(MAX_DEVICE_NAME_BYTES);
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    Some(value[..end].to_string())
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
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| {
            AppError::new(
                "companion_relay_unavailable",
                "The companion relay client could not start.",
            )
        })?;
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
fn load_identity(account_user_id: &str) -> Result<Option<StoredIdentity>, AppError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account_user_id)
        .map_err(|_| AppError::new("companion_keychain_unavailable", "Keychain is unavailable."))?;
    if let Ok(encoded) = entry.get_password() {
        if let Ok(identity) = serde_json::from_str::<StoredIdentity>(&encoded) {
            if identity.account_user_id == account_user_id
                && identity.private_key().is_ok()
                && identity.public_key().is_ok()
            {
                return Ok(Some(identity));
            }
        }
    }
    Ok(None)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn load_or_create_identity(account_user_id: &str) -> Result<StoredIdentity, AppError> {
    if let Some(identity) = load_identity(account_user_id)? {
        return Ok(identity);
    }
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account_user_id)
        .map_err(|_| AppError::new("companion_keychain_unavailable", "Keychain is unavailable."))?;
    let generated = generate_identity().map_err(|_| {
        AppError::new(
            "companion_identity_failed",
            "A companion identity could not be generated.",
        )
    })?;
    let identity = StoredIdentity {
        account_user_id: account_user_id.to_string(),
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

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn remove_identity(account_user_id: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, account_user_id) {
        let _ = entry.delete_credential();
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn remove_identity(_account_user_id: &str) {}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn load_identity(_account_user_id: &str) -> Result<Option<StoredIdentity>, AppError> {
    Ok(None)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn load_or_create_identity(_account_user_id: &str) -> Result<StoredIdentity, AppError> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_names_are_trimmed_and_bounded_by_encoded_size() {
        assert_eq!(
            normalized_device_name("  Studio Mac  ").as_deref(),
            Some("Studio Mac")
        );
        assert_eq!(normalized_device_name("  "), None);

        let oversized = "a".repeat(MAX_DEVICE_NAME_BYTES + 1);
        assert_eq!(
            normalized_device_name(&oversized).unwrap().len(),
            MAX_DEVICE_NAME_BYTES
        );

        let unicode = "é".repeat(MAX_DEVICE_NAME_BYTES);
        let normalized = normalized_device_name(&unicode).unwrap();
        assert!(normalized.len() <= MAX_DEVICE_NAME_BYTES);
        assert!(normalized.is_char_boundary(normalized.len()));
    }

    #[test]
    fn local_pairing_readiness_is_visible_before_remote_approval() {
        let runtime = CompanionRuntime::default();
        let pairing_id = Uuid::new_v4();
        let mobile_id = Uuid::new_v4();
        let secret = [7; KEY_BYTES];
        runtime.pairings.lock().unwrap().insert(
            pairing_id,
            PendingPairing {
                secret,
                expires_at_ms: current_time_ms().saturating_add(60_000),
                approved_mobile: None,
            },
        );

        mark_pairing_mobile(&runtime, pairing_id, mobile_id).unwrap();
        assert_eq!(
            pairing_for_mobile(&runtime, mobile_id).unwrap(),
            Some((pairing_id, secret))
        );

        clear_pairing_mobile(&runtime, pairing_id, mobile_id);
        assert_eq!(pairing_for_mobile(&runtime, mobile_id).unwrap(), None);
    }

    #[test]
    fn account_activity_guard_closes_pairing_commands_at_logout() {
        let runtime = CompanionRuntime::default();
        {
            let _guard = CompanionAccountActivityGuard::begin(&runtime).unwrap();
            assert_eq!(runtime.account_activity.load(Ordering::Acquire), 1);
        }
        assert_eq!(runtime.account_activity.load(Ordering::Acquire), 0);

        runtime
            .account_transport_enabled
            .store(false, Ordering::Release);
        assert!(CompanionAccountActivityGuard::begin(&runtime).is_err());
        assert_eq!(runtime.account_activity.load(Ordering::Acquire), 0);
    }

    #[test]
    fn pending_pairing_cannot_reappear_after_logout_closes_the_account() {
        let runtime = CompanionRuntime::default();
        runtime
            .account_transport_enabled
            .store(false, Ordering::Release);
        let pairing_id = Uuid::new_v4();
        let result = remember_pending_pairing(
            &runtime,
            pairing_id,
            PendingPairing {
                secret: [7; KEY_BYTES],
                expires_at_ms: current_time_ms() + 60_000,
                approved_mobile: None,
            },
        );
        assert!(result.is_err());
        assert!(!runtime.pairings.lock().unwrap().contains_key(&pairing_id));
    }
}
