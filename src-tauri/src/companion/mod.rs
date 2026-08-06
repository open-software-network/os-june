mod controller;
mod files;
mod media;
mod transport;

use crate::{commands::repositories, domain::types::AppError};
use base64::{
    engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD},
    Engine as _,
};
use clovy_companion_crypto::{generate_identity, KEY_BYTES};
use clovy_companion_protocol::{
    AgentStatus, Body, Capability, ComputerUseApprovalDecision, ComputerUseApprovalRequest,
    ComputerUseApprovalStatus, ComputerUseApprovalStatusEvent, Event, Frame, MediaChunk,
    ResultPayload, SessionModelSelection, COMPUTER_USE_APPROVAL_TTL_MS,
    MAX_COMPUTER_USE_ACTION_BYTES, MAX_COMPUTER_USE_DESCRIPTION_BYTES,
    MAX_COMPUTER_USE_TARGET_APP_BYTES, MAX_COMPUTER_USE_TARGET_URL_BYTES,
    MAX_DEVICE_DISPLAY_NAME_BYTES, MAX_TEXT_BYTES,
};
use rand::{rngs::OsRng, RngCore};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, oneshot, Notify};
use uuid::Uuid;

pub use controller::{frontend_response, Controller, ControllerOutcome, FrontendIntent};

const KEYCHAIN_SERVICE: &str = "co.opensoftware.clovy.companion.desktop.identity";
const LEGACY_KEYCHAIN_SERVICE: &str = "co.opensoftware.june.companion.desktop.identity";
const PAIRING_RELAY_READY_TIMEOUT: Duration = Duration::from_secs(10);
const ACCOUNT_ACTIVITY_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(35);
const COMPUTER_USE_APPROVAL_EXPIRY_RETRY_ATTEMPTS: usize = 8;
const COMPUTER_USE_APPROVAL_EXPIRY_RETRY_DELAY: Duration = Duration::from_millis(250);

pub struct CompanionRuntime {
    pub controller: Controller,
    pairings: Mutex<HashMap<Uuid, PendingPairing>>,
    browse_references: Mutex<HashMap<Uuid, files::BrowseReference>>,
    pending_frontend: Mutex<HashMap<Uuid, oneshot::Sender<ResultPayload>>>,
    active_frontend_operations: Mutex<HashSet<Uuid>>,
    inflight_operations: Mutex<HashMap<Uuid, Vec<oneshot::Sender<()>>>>,
    event_sender: Mutex<Option<mpsc::Sender<Event>>>,
    media_transfers: Mutex<media::MediaTransferCache>,
    transport_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    relay_connected: AtomicBool,
    relay_connection_changed: Notify,
    account_transport_enabled: AtomicBool,
    account_session_changed: Notify,
    account_activity: AtomicUsize,
    account_activity_changed: Notify,
    peer_capabilities: Mutex<HashMap<Uuid, HashSet<Capability>>>,
    computer_use_approvals: Mutex<ComputerUseApprovalRegistry>,
    effective_enabled: OnceLock<bool>,
    desktop_display_name: OnceLock<String>,
}

impl Default for CompanionRuntime {
    fn default() -> Self {
        Self {
            controller: Controller::default(),
            pairings: Mutex::default(),
            browse_references: Mutex::default(),
            pending_frontend: Mutex::default(),
            active_frontend_operations: Mutex::default(),
            inflight_operations: Mutex::default(),
            event_sender: Mutex::default(),
            media_transfers: Mutex::default(),
            transport_task: Mutex::default(),
            relay_connected: AtomicBool::new(false),
            relay_connection_changed: Notify::new(),
            account_transport_enabled: AtomicBool::new(true),
            account_session_changed: Notify::new(),
            account_activity: AtomicUsize::new(0),
            account_activity_changed: Notify::new(),
            peer_capabilities: Mutex::default(),
            computer_use_approvals: Mutex::default(),
            effective_enabled: OnceLock::new(),
            desktop_display_name: OnceLock::new(),
        }
    }
}

impl CompanionRuntime {
    fn latch_effective_enabled(&self, enabled: bool) -> bool {
        *self.effective_enabled.get_or_init(|| enabled)
    }

    fn effective_enabled(&self) -> bool {
        self.effective_enabled.get().copied().unwrap_or(false)
    }

    fn latch_desktop_display_name(&self, display_name: String) -> &str {
        self.desktop_display_name
            .get_or_init(|| display_name)
            .as_str()
    }

    pub(super) fn desktop_display_name(&self) -> String {
        self.desktop_display_name
            .get()
            .cloned()
            .unwrap_or_else(default_desktop_display_name)
    }

    fn set_peer_capabilities(&self, device_id: Uuid, capabilities: HashSet<Capability>) {
        if let Ok(mut peers) = self.peer_capabilities.lock() {
            peers.insert(device_id, capabilities);
        }
    }

    fn remove_peer_capabilities(&self, device_id: Uuid) {
        if let Ok(mut peers) = self.peer_capabilities.lock() {
            peers.remove(&device_id);
        }
    }

    fn clear_peer_capabilities(&self) {
        if let Ok(mut peers) = self.peer_capabilities.lock() {
            peers.clear();
        }
    }

    fn has_peer_capability(&self, capability: Capability) -> bool {
        self.peer_capabilities.lock().is_ok_and(|peers| {
            peers
                .values()
                .any(|capabilities| capabilities.contains(&capability))
        })
    }

    fn peer_has_capability(&self, device_id: Uuid, capability: Capability) -> bool {
        self.peer_capabilities.lock().is_ok_and(|peers| {
            peers
                .get(&device_id)
                .is_some_and(|capabilities| capabilities.contains(&capability))
        })
    }
}

struct PendingPairing {
    secret: [u8; KEY_BYTES],
    expires_at_ms: u64,
    approved_mobile: Option<Uuid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ComputerUseApprovalPhase {
    Pending,
    Approved,
    Executing,
    Resolved,
}

#[derive(Debug, Clone)]
struct TrackedComputerUseApproval {
    request: ComputerUseApprovalRequest,
    tool_call_id: String,
    published_target: Option<crate::computer_use::CompanionApprovalTarget>,
    deadline: Instant,
    expiry_armed: bool,
    phase: ComputerUseApprovalPhase,
    remote_permit_armed: bool,
}

#[derive(Debug, Default)]
struct ComputerUseApprovalRegistry {
    requests: HashMap<String, TrackedComputerUseApproval>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ComputerUsePermitTake {
    Consumed {
        request_id: String,
        stored_session_id: String,
    },
    TargetMismatch {
        request_id: String,
        stored_session_id: String,
    },
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ComputerUseApprovalOrigin {
    Companion { device_id: String },
    Timeout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ComputerUseExecutionStatus {
    Started,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ComputerUsePermitOutcome {
    Approved,
    TargetMismatch,
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionComputerUseApprovalSettings {
    enabled: bool,
    available: bool,
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
    pairing_code: String,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseRootDto {
    pub id: Uuid,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantBrowseRootRequest {
    pub path: String,
}

#[tauri::command]
pub async fn companion_begin_pairing(
    runtime: State<'_, CompanionRuntime>,
) -> Result<PairingQrPayload, AppError> {
    ensure_companion_pairing_enabled(&runtime)?;
    let _account_activity = CompanionAccountActivityGuard::begin(&runtime)?;
    let account_user_id = crate::os_accounts::current_user_id().await?;
    let identity = load_or_create_identity(&account_user_id)?;
    let mut secret = [0_u8; KEY_BYTES];
    OsRng.fill_bytes(&mut secret);
    let request = create_pairing_request(&runtime, &identity, &secret)?;
    let status: PairingStatus = companion_post("/v1/companion/pairings", &request).await?;
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
        version: clovy_companion_protocol::PROTOCOL_VERSION,
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
    let pairing_code = URL_SAFE_NO_PAD.encode(&encoded);
    let code = qrcode::QrCode::new(&encoded).map_err(|_| {
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
        pairing_code,
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
pub async fn companion_pairing_status(
    runtime: State<'_, CompanionRuntime>,
    pairing_id: Uuid,
) -> Result<PairingStatus, AppError> {
    ensure_companion_pairing_enabled(&runtime)?;
    companion_get(&format!("/v1/companion/pairings/{pairing_id}")).await
}

#[tauri::command]
pub async fn companion_approve_pairing(
    app: AppHandle,
    runtime: State<'_, CompanionRuntime>,
    pairing_id: Uuid,
    mobile_device_id: Uuid,
) -> Result<PairingStatus, AppError> {
    ensure_companion_pairing_enabled(&runtime)?;
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
    start(&app);

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
                "Clovy could not prepare the secure companion connection.",
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
pub async fn companion_list_devices(
    app: AppHandle,
    runtime: State<'_, CompanionRuntime>,
) -> Result<Vec<LinkedDeviceDto>, AppError> {
    ensure_companion_pairing_enabled(&runtime)?;
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
        Capability::ModelRead,
        Capability::ModelEdit,
        Capability::MediaRead,
        Capability::SettingsRead,
        Capability::SettingsEditSafe,
        Capability::RecordingControlExisting,
        Capability::AppFocus,
        Capability::FilesUpload,
        Capability::FilesBrowse,
        Capability::DevicesReadSelf,
        Capability::DevicesRevokeSelf,
        Capability::ComputerUseApprove,
    ]
}

fn computer_use_approval_gate(
    companion_enabled: bool,
    browser_use_enabled: bool,
    desktop_opt_in: bool,
    capable_peer_connected: bool,
) -> bool {
    companion_enabled && browser_use_enabled && desktop_opt_in && capable_peer_connected
}

pub(crate) fn computer_use_approvals_enabled(app: &AppHandle) -> bool {
    effective_pairing_enabled(app)
        && crate::experimental_settings::browser_use_enabled(app)
        && crate::experimental_settings::companion_computer_use_approvals_enabled(app)
}

fn computer_use_approval_routing_enabled(app: &AppHandle, runtime: &CompanionRuntime) -> bool {
    computer_use_approval_gate(
        effective_pairing_enabled(app),
        crate::experimental_settings::browser_use_enabled(app),
        crate::experimental_settings::companion_computer_use_approvals_enabled(app),
        runtime.has_peer_capability(Capability::ComputerUseApprove),
    )
}

#[tauri::command]
pub fn companion_computer_use_approval_settings(
    app: AppHandle,
) -> CompanionComputerUseApprovalSettings {
    CompanionComputerUseApprovalSettings {
        enabled: crate::experimental_settings::companion_computer_use_approvals_enabled(&app),
        available: effective_pairing_enabled(&app)
            && crate::experimental_settings::browser_use_enabled(&app),
    }
}

#[tauri::command]
pub fn companion_set_computer_use_approval_enabled(
    app: AppHandle,
    state: State<'_, crate::experimental_settings::ExperimentalSettingsState>,
    enabled: bool,
) -> Result<CompanionComputerUseApprovalSettings, AppError> {
    let available =
        effective_pairing_enabled(&app) && crate::experimental_settings::browser_use_enabled(&app);
    if enabled && !available {
        return Err(AppError::new(
            "companion_computer_use_approval_unavailable",
            "Enable Companion pairing and Computer use before allowing linked approvals.",
        ));
    }
    crate::experimental_settings::set_companion_computer_use_approvals_enabled(
        &app, &state, enabled,
    )?;
    if !enabled {
        retire_computer_use_approvals(&app, ComputerUseApprovalStatus::Cancelled);
    }
    tracing::info!(enabled, "companion Computer use approval setting changed");
    Ok(CompanionComputerUseApprovalSettings { enabled, available })
}

#[tauri::command]
pub async fn companion_list_browse_roots(
    app: AppHandle,
    runtime: State<'_, CompanionRuntime>,
) -> Result<Vec<BrowseRootDto>, AppError> {
    ensure_companion_pairing_enabled(&runtime)?;
    let account_user_id = crate::os_accounts::current_user_id().await?;
    Ok(
        files::list_root_records(&repositories(&app).await?, &account_user_id)
            .await?
            .into_iter()
            .map(|root| BrowseRootDto {
                id: root.id,
                name: root.display_name,
                path: root.canonical_path.to_string_lossy().into_owned(),
            })
            .collect(),
    )
}

#[tauri::command]
pub async fn companion_grant_browse_root(
    app: AppHandle,
    runtime: State<'_, CompanionRuntime>,
    request: GrantBrowseRootRequest,
) -> Result<BrowseRootDto, AppError> {
    ensure_companion_pairing_enabled(&runtime)?;
    let account_user_id = crate::os_accounts::current_user_id().await?;
    let root = files::grant_root(
        &repositories(&app).await?,
        &account_user_id,
        std::path::Path::new(&request.path),
    )
    .await?;
    Ok(BrowseRootDto {
        id: root.id,
        name: root.display_name,
        path: root.canonical_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn companion_revoke_browse_root(
    app: AppHandle,
    runtime: State<'_, CompanionRuntime>,
    root_id: Uuid,
) -> Result<(), AppError> {
    ensure_companion_pairing_enabled(&runtime)?;
    files::revoke_root(
        &app,
        &repositories(&app).await?,
        &crate::os_accounts::current_user_id().await?,
        root_id,
    )
    .await
}

#[tauri::command]
pub async fn companion_consume_attachments(
    app: AppHandle,
    runtime: State<'_, CompanionRuntime>,
    reference_ids: Vec<Uuid>,
) -> Result<(), AppError> {
    ensure_companion_pairing_enabled(&runtime)?;
    if reference_ids.len() > clovy_companion_protocol::MAX_ATTACHMENT_REFERENCES {
        return Err(AppError::new(
            "companion_attachment_invalid",
            "Too many companion attachments were selected.",
        ));
    }
    files::consume_attachments(
        &app,
        &repositories(&app).await?,
        &crate::os_accounts::current_user_id().await?,
        &reference_ids,
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn companion_rename_device(
    app: AppHandle,
    runtime: State<'_, CompanionRuntime>,
    request: RenameDeviceRequest,
) -> Result<(), AppError> {
    ensure_companion_pairing_enabled(&runtime)?;
    let name = request.display_name.trim();
    if name.is_empty() || name.len() > MAX_DEVICE_DISPLAY_NAME_BYTES {
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
pub async fn companion_revoke_device(
    app: AppHandle,
    runtime: State<'_, CompanionRuntime>,
    device_id: Uuid,
) -> Result<(), AppError> {
    ensure_companion_pairing_enabled(&runtime)?;
    let account_user_id = crate::os_accounts::current_user_id().await?;
    revoke_device_remote(device_id).await?;
    repositories(&app)
        .await?
        .revoke_companion_device(&account_user_id, &device_id.to_string())
        .await?;
    files::cleanup_device_uploads(
        &app,
        &repositories(&app).await?,
        &account_user_id,
        &device_id.to_string(),
    )
    .await;
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
    ensure_companion_pairing_enabled(&runtime)?;
    let sender = runtime
        .pending_frontend
        .lock()
        .map_err(|_| {
            AppError::new(
                "companion_frontend_unavailable",
                "Companion response lock failed.",
            )
        })?
        .remove(&operation_id);
    finish_frontend_activity(&runtime, operation_id)?;
    let Some(sender) = sender else {
        return Err(AppError::new(
            "companion_request_expired",
            "The companion request already expired.",
        ));
    };
    sender.send(result).map_err(|_| {
        AppError::new(
            "companion_request_expired",
            "The companion request already expired.",
        )
    })
}

#[tauri::command]
pub fn companion_cancel_frontend_request(
    runtime: State<'_, CompanionRuntime>,
    operation_id: Uuid,
) -> Result<(), AppError> {
    ensure_companion_pairing_enabled(&runtime)?;
    let removed = runtime
        .pending_frontend
        .lock()
        .map_err(|_| {
            AppError::new(
                "companion_frontend_unavailable",
                "Companion response lock failed.",
            )
        })?
        .remove(&operation_id)
        .is_some();
    finish_frontend_activity(&runtime, operation_id)?;
    if !removed {
        return Err(AppError::new(
            "companion_request_expired",
            "The companion request already expired.",
        ));
    }
    Ok(())
}

fn begin_frontend_activity(runtime: &CompanionRuntime, operation_id: Uuid) -> Result<(), AppError> {
    let inserted = runtime
        .active_frontend_operations
        .lock()
        .map_err(|_| {
            AppError::new(
                "companion_frontend_unavailable",
                "Companion activity lock failed.",
            )
        })?
        .insert(operation_id);
    if inserted {
        runtime.account_activity.fetch_add(1, Ordering::AcqRel);
    }
    Ok(())
}

fn finish_frontend_activity(
    runtime: &CompanionRuntime,
    operation_id: Uuid,
) -> Result<(), AppError> {
    let removed = runtime
        .active_frontend_operations
        .lock()
        .map_err(|_| {
            AppError::new(
                "companion_frontend_unavailable",
                "Companion activity lock failed.",
            )
        })?
        .remove(&operation_id);
    if removed {
        runtime.account_activity.fetch_sub(1, Ordering::AcqRel);
        runtime.account_activity_changed.notify_one();
    }
    Ok(())
}

pub(super) struct FrontendActivityGuard<'a> {
    runtime: &'a CompanionRuntime,
    operation_id: Uuid,
}

impl<'a> FrontendActivityGuard<'a> {
    pub(super) fn begin(
        runtime: &'a CompanionRuntime,
        operation_id: Uuid,
    ) -> Result<Self, AppError> {
        begin_frontend_activity(runtime, operation_id)?;
        Ok(Self {
            runtime,
            operation_id,
        })
    }
}

impl Drop for FrontendActivityGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.runtime.pending_frontend.lock() {
            pending.remove(&self.operation_id);
        }
        let _ = finish_frontend_activity(self.runtime, self.operation_id);
    }
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
        run_id: Option<String>,
    },
    ModelChanged {
        selection: SessionModelSelection,
    },
}

#[tauri::command]
pub async fn companion_publish_agent_event(
    app: AppHandle,
    runtime: State<'_, CompanionRuntime>,
    request: CompanionAgentEventRequest,
) -> Result<(), AppError> {
    ensure_companion_pairing_enabled(&runtime)?;
    let (stored_session_id, text, run_id) = match &request {
        CompanionAgentEventRequest::Delta {
            stored_session_id,
            text,
        } => (stored_session_id, Some(text), None),
        CompanionAgentEventRequest::Status {
            stored_session_id,
            run_id,
            ..
        } => (stored_session_id, None, run_id.as_ref()),
        CompanionAgentEventRequest::ModelChanged { selection } => {
            (&selection.stored_session_id, None, None)
        }
    };
    if stored_session_id.is_empty()
        || stored_session_id.len() > 256
        || text.is_some_and(|text| text.is_empty() || text.len() > MAX_TEXT_BYTES)
        || run_id.is_some_and(|run_id| run_id.is_empty() || run_id.len() > 256)
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
            run_id,
        } => Event::AgentStatus {
            media: if let Some(run_id) = run_id {
                let repositories = repositories(&app).await?;
                ensure_companion_agent_session_exists(&repositories, &stored_session_id).await?;
                let references =
                    media::run_references(&repositories, &stored_session_id, &run_id).await?;
                ensure_companion_agent_session_exists(&repositories, &stored_session_id).await?;
                references
            } else {
                Vec::new()
            },
            stored_session_id,
            status,
        },
        CompanionAgentEventRequest::ModelChanged { selection } => {
            Event::SessionModelChanged { selection }
        }
    };
    publish_event(&runtime, event)
}

fn publish_event(runtime: &CompanionRuntime, event: Event) -> Result<(), AppError> {
    let now_ms = current_time_ms();
    Frame::new(
        Uuid::nil(),
        0,
        now_ms,
        event.capability(),
        Body::Event(event.clone()),
    )
    .validate(now_ms)
    .map_err(|_| {
        AppError::new(
            "companion_event_invalid",
            "The companion event exceeded its size limit.",
        )
    })?;
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

#[tauri::command]
pub async fn companion_list_agent_media(
    app: AppHandle,
    runtime: State<'_, CompanionRuntime>,
    stored_session_id: String,
) -> Result<Vec<media::CompanionMediaProjection>, AppError> {
    ensure_companion_pairing_enabled(&runtime)?;
    let repositories = repositories(&app).await?;
    ensure_companion_agent_session_exists(&repositories, &stored_session_id).await?;
    let projections = media::session_projections(&repositories, &stored_session_id).await?;
    ensure_companion_agent_session_exists(&repositories, &stored_session_id).await?;
    Ok(projections)
}

#[tauri::command]
pub async fn companion_read_agent_media_chunk(
    app: AppHandle,
    runtime: State<'_, CompanionRuntime>,
    stored_session_id: String,
    artifact_id: String,
    offset_bytes: u64,
) -> Result<MediaChunk, AppError> {
    ensure_companion_pairing_enabled(&runtime)?;
    let repositories = repositories(&app).await?;
    ensure_companion_agent_session_exists(&repositories, &stored_session_id).await?;
    let artifact =
        media::resolve_fetch_artifact(&repositories, &stored_session_id, &artifact_id).await?;
    ensure_companion_agent_session_exists(&repositories, &stored_session_id).await?;
    let chunk = media::read_chunk(
        &runtime.media_transfers,
        "companion-frontend",
        artifact,
        offset_bytes,
    )
    .await?;
    ensure_companion_agent_session_exists(&repositories, &stored_session_id).await?;
    Ok(chunk)
}

async fn ensure_companion_agent_session_exists(
    repositories: &crate::db::repositories::Repositories,
    stored_session_id: &str,
) -> Result<(), AppError> {
    let found = sqlx::query::query(
        "SELECT 1
         FROM agent_sessions
         WHERE id = ?
         LIMIT 1",
    )
    .bind(stored_session_id)
    .fetch_optional(&repositories.pool)
    .await?
    .is_some();
    if !found {
        return Err(AppError::new(
            "companion_agent_session_not_found",
            "That agent session is no longer available.",
        ));
    }
    Ok(())
}

fn status_event(
    request_id: &str,
    stored_session_id: &str,
    status: ComputerUseApprovalStatus,
) -> Event {
    Event::ComputerUseApprovalStatusChanged(ComputerUseApprovalStatusEvent {
        request_id: request_id.to_string(),
        stored_session_id: stored_session_id.to_string(),
        status,
    })
}

fn publish_computer_use_status(
    runtime: &CompanionRuntime,
    request_id: &str,
    stored_session_id: &str,
    status: ComputerUseApprovalStatus,
) {
    if let Err(error) = publish_event(runtime, status_event(request_id, stored_session_id, status))
    {
        tracing::warn!(
            code = %error.code,
            request_id,
            stored_session_id,
            ?status,
            "failed to publish companion Computer use approval status"
        );
    }
}

fn approval_description(action: &str, target_app: Option<&str>) -> String {
    let target = target_app.unwrap_or("the selected app");
    match action {
        "capture" => format!("Capture {target}."),
        "list_apps" => "List available app windows.".to_string(),
        "wait" => "Wait before the next Computer use action.".to_string(),
        "open_app" => format!("Open {target}."),
        "focus_app" => format!("Focus {target}."),
        "click" => format!("Click a control in {target}."),
        "double_click" => format!("Double-click a control in {target}."),
        "right_click" => format!("Right-click a control in {target}."),
        "drag" => format!("Drag a control in {target}."),
        "scroll" => format!("Scroll in {target}."),
        "type" => format!("Type in {target}."),
        "key" => format!("Press a key in {target}."),
        "set_value" => format!("Set a control value in {target}."),
        _ => unreachable!("approval actions are normalized before description generation"),
    }
}

fn reject_overlong_approval_field(value: &str, max_bytes: usize) -> Result<(), AppError> {
    if value.len() <= max_bytes {
        return Ok(());
    }
    Err(AppError::new(
        "companion_computer_use_approval_too_large",
        "This Computer use approval cannot be shown safely on a linked device. Approve it on this Mac.",
    ))
}

fn validate_computer_use_approval_fields(
    request: &ComputerUseApprovalRequest,
) -> Result<(), AppError> {
    reject_overlong_approval_field(&request.action, MAX_COMPUTER_USE_ACTION_BYTES)?;
    reject_overlong_approval_field(&request.description, MAX_COMPUTER_USE_DESCRIPTION_BYTES)?;
    if let Some(target_app) = request.target_app.as_deref() {
        reject_overlong_approval_field(target_app, MAX_COMPUTER_USE_TARGET_APP_BYTES)?;
    }
    if let Some(target_url) = request.target_url.as_deref() {
        reject_overlong_approval_field(target_url, MAX_COMPUTER_USE_TARGET_URL_BYTES)?;
    }
    Ok(())
}

pub(crate) async fn register_computer_use_approval(
    app: &AppHandle,
    request_id: &str,
    tool_call_id: &str,
    stored_session_id: &str,
    arguments: &serde_json::Value,
) -> Result<bool, AppError> {
    let runtime = app.state::<CompanionRuntime>();
    if !computer_use_approval_routing_enabled(app, &runtime) {
        return Ok(false);
    }
    if request_id.is_empty()
        || request_id.len() > 128
        || tool_call_id.is_empty()
        || tool_call_id.len() > 128
        || stored_session_id.is_empty()
        || stored_session_id.len() > 128
    {
        return Err(AppError::new(
            "companion_computer_use_approval_invalid",
            "The Computer use approval identifiers exceed the protocol limit.",
        ));
    }
    let requested_at_ms = current_time_ms();
    let action = crate::computer_use::normalized_action(arguments)?;
    let published_target =
        crate::computer_use::companion_approval_target(app, arguments, &action).await?;
    let target_app = published_target
        .as_ref()
        .map(|target| target.app_name().to_string());
    let request = ComputerUseApprovalRequest {
        request_id: request_id.to_string(),
        stored_session_id: stored_session_id.to_string(),
        description: approval_description(&action, target_app.as_deref()),
        action,
        target_app,
        // The existing Computer use broker has no URL-targeted action. Never
        // echo an untrusted extra argument onto the phone approval card.
        target_url: None,
        requested_at_ms,
        expires_at_ms: requested_at_ms.saturating_add(COMPUTER_USE_APPROVAL_TTL_MS),
    };
    validate_computer_use_approval_fields(&request)?;
    let deadline = Instant::now()
        .checked_add(Duration::from_millis(COMPUTER_USE_APPROVAL_TTL_MS))
        .ok_or_else(|| {
            AppError::new(
                "companion_computer_use_approval_unavailable",
                "Computer use approval deadline could not be created.",
            )
        })?;
    let mut registry = runtime.computer_use_approvals.lock().map_err(|_| {
        AppError::new(
            "companion_computer_use_approval_unavailable",
            "Computer use approval lock failed.",
        )
    })?;
    registry.prune(requested_at_ms);
    if registry.requests.contains_key(&request.request_id) {
        return Err(AppError::new(
            "companion_computer_use_approval_replay",
            "This Computer use approval request was already registered.",
        ));
    }
    if registry.requests.values().any(|approval| {
        approval.request.stored_session_id == stored_session_id
            && approval.tool_call_id == tool_call_id
            && approval.phase != ComputerUseApprovalPhase::Resolved
    }) {
        return Err(AppError::new(
            "companion_computer_use_approval_replay",
            "This Computer use tool call already has a linked approval request.",
        ));
    }
    registry.requests.insert(
        request.request_id.clone(),
        TrackedComputerUseApproval {
            request: request.clone(),
            tool_call_id: tool_call_id.to_string(),
            published_target,
            deadline,
            expiry_armed: false,
            phase: ComputerUseApprovalPhase::Pending,
            remote_permit_armed: false,
        },
    );
    if let Err(error) = publish_event(
        &runtime,
        Event::ComputerUseApprovalRequested(request.clone()),
    ) {
        registry.requests.remove(&request.request_id);
        return Err(error);
    }
    drop(registry);
    tracing::info!(
        request_id = %request.request_id,
        stored_session_id = %request.stored_session_id,
        expires_at_ms = request.expires_at_ms,
        "queued companion Computer use approval request"
    );
    Ok(true)
}

pub(crate) fn confirm_computer_use_approval_delivery(
    app: &AppHandle,
    request_id: &str,
    stored_session_id: &str,
) -> Result<(), AppError> {
    let deadline = {
        let runtime = app.state::<CompanionRuntime>();
        let mut registry = runtime.computer_use_approvals.lock().map_err(|_| {
            AppError::new(
                "companion_computer_use_approval_unavailable",
                "Computer use approval lock failed.",
            )
        })?;
        registry.confirm_delivery(
            request_id,
            stored_session_id,
            current_time_ms(),
            Instant::now(),
        )?
    };
    if let Some(deadline) = deadline {
        spawn_computer_use_expiration(
            app.clone(),
            request_id.to_string(),
            stored_session_id.to_string(),
            deadline,
        );
        tracing::info!(
            request_id,
            stored_session_id,
            "armed companion Computer use approval expiry after authenticated delivery receipt"
        );
    }
    Ok(())
}

fn spawn_computer_use_expiration(
    app: AppHandle,
    request_id: String,
    stored_session_id: String,
    deadline: Instant,
) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
        let result = retry_computer_use_expiration(
            || {
                let app = app.clone();
                let request_id = request_id.clone();
                let stored_session_id = stored_session_id.clone();
                async move {
                    crate::agent_runtime::api::resolve_companion_computer_use_approval(
                        &app,
                        &request_id,
                        &stored_session_id,
                        ComputerUseApprovalDecision::Deny,
                        ComputerUseApprovalOrigin::Timeout,
                    )
                    .await
                }
            },
            COMPUTER_USE_APPROVAL_EXPIRY_RETRY_ATTEMPTS,
            COMPUTER_USE_APPROVAL_EXPIRY_RETRY_DELAY,
        )
        .await;
        if let Err(error) = result {
            if !matches!(
                error.code.as_str(),
                "companion_computer_use_approval_replay"
                    | "companion_computer_use_approval_not_found"
            ) {
                tracing::warn!(
                    code = %error.code,
                    request_id,
                    stored_session_id,
                    "failed to expire companion Computer use approval"
                );
                // The interruption remains available on the Mac. Retire the
                // remote request honestly instead of leaving a phone card
                // pending after all bounded auto-deny attempts fail.
                cancel_computer_use_resolution(&app, &request_id, &stored_session_id);
            }
        }
    });
}

async fn retry_computer_use_expiration<F, Fut>(
    mut resolve: F,
    attempts: usize,
    retry_delay: Duration,
) -> Result<(), AppError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<serde_json::Value, AppError>>,
{
    let attempts = attempts.max(1);
    for attempt in 1..=attempts {
        match resolve().await {
            Ok(_) => return Ok(()),
            Err(error)
                if matches!(
                    error.code.as_str(),
                    "companion_computer_use_approval_replay"
                        | "companion_computer_use_approval_not_found"
                ) =>
            {
                return Err(error);
            }
            Err(error) if attempt == attempts => return Err(error),
            Err(_) => tokio::time::sleep(retry_delay).await,
        }
    }
    unreachable!("expiration resolution always returns from the bounded loop")
}

impl ComputerUseApprovalRegistry {
    fn prune(&mut self, now_ms: u64) {
        self.requests.retain(|_, approval| {
            approval.phase != ComputerUseApprovalPhase::Resolved
                || now_ms <= approval.request.expires_at_ms.saturating_add(5 * 60_000)
        });
        if self.requests.len() > 512 {
            let mut resolved = self
                .requests
                .iter()
                .filter(|(_, approval)| approval.phase == ComputerUseApprovalPhase::Resolved)
                .map(|(id, approval)| (id.clone(), approval.request.expires_at_ms))
                .collect::<Vec<_>>();
            resolved.sort_by_key(|(_, expires_at_ms)| *expires_at_ms);
            let remove_count = self.requests.len().saturating_sub(512);
            for (id, _) in resolved.into_iter().take(remove_count) {
                self.requests.remove(&id);
            }
        }
    }

    fn begin_resolution(
        &mut self,
        request_id: &str,
        stored_session_id: &str,
        now_ms: u64,
        now: Instant,
        origin: &ComputerUseApprovalOrigin,
    ) -> Result<(), AppError> {
        self.prune(now_ms);
        let approval = self.requests.get_mut(request_id).ok_or_else(|| {
            AppError::new(
                "companion_computer_use_approval_not_found",
                "This Computer use approval request is no longer pending.",
            )
        })?;
        if approval.request.stored_session_id != stored_session_id {
            return Err(AppError::new(
                "companion_computer_use_approval_invalid",
                "The Computer use approval does not belong to this session.",
            ));
        }
        if approval.phase != ComputerUseApprovalPhase::Pending {
            return Err(AppError::new(
                "companion_computer_use_approval_replay",
                "This Computer use approval was already resolved.",
            ));
        }
        if *origin == ComputerUseApprovalOrigin::Timeout && !approval.expiry_armed {
            return Err(AppError::new(
                "companion_computer_use_approval_delivery_unconfirmed",
                "This Computer use approval was not confirmed as delivered to a linked device.",
            ));
        }
        if now < approval.deadline && *origin == ComputerUseApprovalOrigin::Timeout {
            return Err(AppError::new(
                "companion_computer_use_approval_not_expired",
                "This Computer use approval has not expired yet.",
            ));
        }
        if now >= approval.deadline && matches!(origin, ComputerUseApprovalOrigin::Companion { .. })
        {
            approval.phase = ComputerUseApprovalPhase::Resolved;
            return Err(AppError::new(
                "companion_computer_use_approval_expired",
                "This Computer use approval expired.",
            ));
        }
        Ok(())
    }

    fn confirm_delivery(
        &mut self,
        request_id: &str,
        stored_session_id: &str,
        now_ms: u64,
        now: Instant,
    ) -> Result<Option<Instant>, AppError> {
        self.prune(now_ms);
        let approval = self.requests.get_mut(request_id).ok_or_else(|| {
            AppError::new(
                "companion_computer_use_approval_not_found",
                "This Computer use approval request is no longer pending.",
            )
        })?;
        if approval.request.stored_session_id != stored_session_id {
            return Err(AppError::new(
                "companion_computer_use_approval_invalid",
                "The Computer use approval does not belong to this session.",
            ));
        }
        if approval.phase != ComputerUseApprovalPhase::Pending {
            return Err(AppError::new(
                "companion_computer_use_approval_replay",
                "This Computer use approval was already resolved.",
            ));
        }
        if now >= approval.deadline {
            approval.phase = ComputerUseApprovalPhase::Resolved;
            return Err(AppError::new(
                "companion_computer_use_approval_expired",
                "This Computer use approval expired before delivery was confirmed.",
            ));
        }
        if approval.expiry_armed {
            return Ok(None);
        }
        approval.expiry_armed = true;
        Ok(Some(approval.deadline))
    }

    fn complete_resolution(
        &mut self,
        request_id: &str,
        stored_session_id: &str,
        approved: bool,
        remote_permit: bool,
    ) -> bool {
        let Some(entry) = self.requests.get_mut(request_id) else {
            return false;
        };
        if entry.request.stored_session_id != stored_session_id
            || entry.phase != ComputerUseApprovalPhase::Pending
        {
            return false;
        }
        entry.phase = if approved {
            ComputerUseApprovalPhase::Approved
        } else {
            ComputerUseApprovalPhase::Resolved
        };
        entry.remote_permit_armed = approved && remote_permit;
        true
    }

    fn take_remote_permit(
        &mut self,
        tool_call_id: &str,
        stored_session_id: &str,
        resolved_target: &crate::computer_use::CompanionApprovalTarget,
    ) -> ComputerUsePermitTake {
        let Some(entry) = self.requests.values_mut().find(|entry| {
            entry.tool_call_id == tool_call_id
                && entry.request.stored_session_id == stored_session_id
        }) else {
            return ComputerUsePermitTake::Unavailable;
        };
        if !entry.remote_permit_armed
            || !matches!(
                entry.phase,
                ComputerUseApprovalPhase::Approved | ComputerUseApprovalPhase::Executing
            )
        {
            return ComputerUsePermitTake::Unavailable;
        }
        entry.remote_permit_armed = false;
        let request_id = entry.request.request_id.clone();
        let stored_session_id = entry.request.stored_session_id.clone();
        if entry.published_target.as_ref() != Some(resolved_target) {
            entry.phase = ComputerUseApprovalPhase::Resolved;
            return ComputerUsePermitTake::TargetMismatch {
                request_id,
                stored_session_id,
            };
        }
        entry.phase = ComputerUseApprovalPhase::Executing;
        ComputerUsePermitTake::Consumed {
            request_id,
            stored_session_id,
        }
    }

    fn request_for_tool_call(
        &mut self,
        tool_call_id: &str,
        stored_session_id: &str,
    ) -> Option<&mut TrackedComputerUseApproval> {
        self.requests.values_mut().find(|entry| {
            entry.tool_call_id == tool_call_id
                && entry.request.stored_session_id == stored_session_id
        })
    }
}

pub(crate) fn begin_companion_computer_use_resolution(
    app: &AppHandle,
    request_id: &str,
    stored_session_id: &str,
    origin: ComputerUseApprovalOrigin,
) -> Result<(), AppError> {
    if !computer_use_approvals_enabled(app)
        && matches!(&origin, ComputerUseApprovalOrigin::Companion { .. })
    {
        return Err(AppError::new(
            "companion_computer_use_approval_disabled",
            "Linked Computer use approvals are disabled on this Mac.",
        ));
    }
    let runtime = app.state::<CompanionRuntime>();
    let now_ms = current_time_ms();
    let now = Instant::now();
    let mut registry = runtime.computer_use_approvals.lock().map_err(|_| {
        AppError::new(
            "companion_computer_use_approval_unavailable",
            "Computer use approval lock failed.",
        )
    })?;
    let request = registry
        .requests
        .get(request_id)
        .map(|approval| approval.request.clone());
    if let Err(error) =
        registry.begin_resolution(request_id, stored_session_id, now_ms, now, &origin)
    {
        drop(registry);
        if error.code == "companion_computer_use_approval_expired" {
            if let Some(request) = request {
                publish_computer_use_status(
                    &runtime,
                    &request.request_id,
                    &request.stored_session_id,
                    ComputerUseApprovalStatus::Expired,
                );
            }
        }
        return Err(error);
    }
    Ok(())
}

pub(crate) fn complete_computer_use_resolution(
    app: &AppHandle,
    request_id: &str,
    stored_session_id: &str,
    approved: bool,
    remote_permit: bool,
    origin: Option<ComputerUseApprovalOrigin>,
) {
    let runtime = app.state::<CompanionRuntime>();
    let Ok(mut registry) = runtime.computer_use_approvals.lock() else {
        return;
    };
    if !registry.complete_resolution(request_id, stored_session_id, approved, remote_permit) {
        return;
    }
    let status = match (approved, origin.as_ref()) {
        (true, _) => ComputerUseApprovalStatus::Approved,
        (false, Some(ComputerUseApprovalOrigin::Timeout)) => ComputerUseApprovalStatus::Expired,
        (false, _) => ComputerUseApprovalStatus::Denied,
    };
    drop(registry);
    publish_computer_use_status(&runtime, request_id, stored_session_id, status);
    tracing::info!(
        request_id,
        stored_session_id,
        approved,
        origin = ?origin,
        "resolved companion Computer use approval"
    );
}

pub(crate) fn cancel_computer_use_resolution(
    app: &AppHandle,
    request_id: &str,
    stored_session_id: &str,
) {
    let runtime = app.state::<CompanionRuntime>();
    let Ok(mut registry) = runtime.computer_use_approvals.lock() else {
        return;
    };
    let Some(entry) = registry.requests.get_mut(request_id) else {
        return;
    };
    if entry.request.stored_session_id != stored_session_id {
        return;
    }
    entry.phase = ComputerUseApprovalPhase::Resolved;
    entry.remote_permit_armed = false;
    drop(registry);
    publish_computer_use_status(
        &runtime,
        request_id,
        stored_session_id,
        ComputerUseApprovalStatus::Cancelled,
    );
}

pub(crate) fn take_computer_use_remote_permit(
    app: &AppHandle,
    stored_session_id: &str,
    tool_call_id: &str,
    resolved_target: &crate::computer_use::CompanionApprovalTarget,
) -> ComputerUsePermitOutcome {
    if !computer_use_approvals_enabled(app) {
        return ComputerUsePermitOutcome::Unavailable;
    }
    let runtime = app.state::<CompanionRuntime>();
    let Ok(mut registry) = runtime.computer_use_approvals.lock() else {
        return ComputerUsePermitOutcome::Unavailable;
    };
    match registry.take_remote_permit(tool_call_id, stored_session_id, resolved_target) {
        ComputerUsePermitTake::Consumed {
            request_id,
            stored_session_id,
        } => {
            drop(registry);
            publish_computer_use_status(
                &runtime,
                &request_id,
                &stored_session_id,
                ComputerUseApprovalStatus::Executing,
            );
            tracing::info!(
                request_id,
                stored_session_id,
                tool_call_id,
                "consumed target-bound companion Computer use permit"
            );
            ComputerUsePermitOutcome::Approved
        }
        ComputerUsePermitTake::TargetMismatch {
            request_id,
            stored_session_id,
        } => {
            drop(registry);
            publish_computer_use_status(
                &runtime,
                &request_id,
                &stored_session_id,
                ComputerUseApprovalStatus::Denied,
            );
            tracing::warn!(
                request_id,
                stored_session_id,
                tool_call_id,
                "rejected companion Computer use permit after target mismatch"
            );
            ComputerUsePermitOutcome::TargetMismatch
        }
        ComputerUsePermitTake::Unavailable => ComputerUsePermitOutcome::Unavailable,
    }
}

pub(crate) fn publish_computer_use_execution_status(
    app: &AppHandle,
    tool_call_id: &str,
    stored_session_id: &str,
    status: ComputerUseExecutionStatus,
) {
    let runtime = app.state::<CompanionRuntime>();
    let Ok(mut registry) = runtime.computer_use_approvals.lock() else {
        return;
    };
    let Some(entry) = registry.request_for_tool_call(tool_call_id, stored_session_id) else {
        return;
    };
    if matches!(
        entry.phase,
        ComputerUseApprovalPhase::Pending | ComputerUseApprovalPhase::Resolved
    ) {
        return;
    }
    // The sidecar announces tool.started before the Rust host tool has
    // re-resolved and compared the exact target. For targetful requests,
    // permit consumption publishes Executing only after that comparison.
    if status == ComputerUseExecutionStatus::Started
        && entry.published_target.is_some()
        && entry.remote_permit_armed
    {
        return;
    }
    let request_id = entry.request.request_id.clone();
    let protocol_status = match status {
        ComputerUseExecutionStatus::Started => {
            entry.phase = ComputerUseApprovalPhase::Executing;
            ComputerUseApprovalStatus::Executing
        }
        ComputerUseExecutionStatus::Succeeded => {
            entry.phase = ComputerUseApprovalPhase::Resolved;
            entry.remote_permit_armed = false;
            ComputerUseApprovalStatus::Succeeded
        }
        ComputerUseExecutionStatus::Failed => {
            entry.phase = ComputerUseApprovalPhase::Resolved;
            entry.remote_permit_armed = false;
            ComputerUseApprovalStatus::Failed
        }
    };
    drop(registry);
    publish_computer_use_status(&runtime, &request_id, stored_session_id, protocol_status);
    tracing::info!(
        request_id,
        stored_session_id,
        status = ?protocol_status,
        "recorded companion Computer use execution status"
    );
}

fn retire_computer_use_approvals(app: &AppHandle, status: ComputerUseApprovalStatus) {
    let runtime = app.state::<CompanionRuntime>();
    let requests = runtime
        .computer_use_approvals
        .lock()
        .map(|mut registry| {
            registry
                .requests
                .values_mut()
                .filter(|entry| entry.phase != ComputerUseApprovalPhase::Resolved)
                .map(|entry| {
                    entry.phase = ComputerUseApprovalPhase::Resolved;
                    entry.remote_permit_armed = false;
                    (
                        entry.request.request_id.clone(),
                        entry.request.stored_session_id.clone(),
                    )
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for (request_id, stored_session_id) in requests {
        publish_computer_use_status(&runtime, &request_id, &stored_session_id, status);
    }
}

pub(crate) fn cancel_computer_use_approvals_for_session(app: &AppHandle, stored_session_id: &str) {
    let runtime = app.state::<CompanionRuntime>();
    let requests = runtime
        .computer_use_approvals
        .lock()
        .map(|mut registry| {
            registry
                .requests
                .values_mut()
                .filter(|entry| {
                    entry.request.stored_session_id == stored_session_id
                        && entry.phase != ComputerUseApprovalPhase::Resolved
                })
                .map(|entry| {
                    entry.phase = ComputerUseApprovalPhase::Resolved;
                    entry.remote_permit_armed = false;
                    entry.request.request_id.clone()
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for request_id in requests {
        publish_computer_use_status(
            &runtime,
            &request_id,
            stored_session_id,
            ComputerUseApprovalStatus::Cancelled,
        );
    }
}

pub fn setup(app: &AppHandle) {
    let stored_enabled = crate::experimental_settings::companion_pairing_enabled(app);
    let runtime = app.state::<CompanionRuntime>();
    runtime.latch_effective_enabled(stored_enabled);
    runtime.latch_desktop_display_name(resolve_desktop_display_name());
    files::start_cleanup(app);
    media::start_cleanup(app);
    start(app);
}

pub fn effective_pairing_enabled(app: &AppHandle) -> bool {
    app.try_state::<CompanionRuntime>()
        .is_some_and(|runtime| runtime.effective_enabled())
}

pub fn start(app: &AppHandle) {
    if effective_pairing_enabled(app) {
        transport::start(app);
    }
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
    retire_computer_use_approvals(app, ComputerUseApprovalStatus::Cancelled);
    media::clear_cache(app);
    transport::stop(app).await?;

    // A relay task may be awaiting a frontend-backed operation, or pairing may
    // be committing an authorization grant. Wait until all authorized account
    // work observes the sign-out boundary before revoking local state.
    wait_for_account_activity_then_clear_media(&runtime, ACCOUNT_ACTIVITY_SHUTDOWN_TIMEOUT).await?;

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
            for device in devices
                .into_iter()
                .filter(|device| device.revoked_at.is_none())
            {
                if let Ok(device_id) = Uuid::parse_str(&device.id) {
                    remote_device_ids.insert(device_id);
                }
                files::cleanup_device_uploads(app, &repos, &account_user_id, &device.id).await;
            }
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

async fn wait_for_account_activity(
    runtime: &CompanionRuntime,
    timeout: Duration,
) -> Result<(), AppError> {
    tokio::time::timeout(timeout, async {
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
    })
}

async fn wait_for_account_activity_then_clear_media(
    runtime: &CompanionRuntime,
    timeout: Duration,
) -> Result<(), AppError> {
    wait_for_account_activity(runtime, timeout).await?;
    media::clear_transfer_cache(&runtime.media_transfers);
    Ok(())
}

pub fn resume_account_transport(app: &AppHandle) {
    let runtime = app.state::<CompanionRuntime>();
    runtime
        .account_transport_enabled
        .store(true, Ordering::Release);
    runtime.account_session_changed.notify_waiters();
    start(app);
}

pub(crate) fn ensure_companion_pairing_enabled(runtime: &CompanionRuntime) -> Result<(), AppError> {
    ensure_companion_pairing_enabled_with(runtime.effective_enabled())
}

fn ensure_companion_pairing_enabled_with(enabled: bool) -> Result<(), AppError> {
    if enabled {
        Ok(())
    } else {
        Err(AppError::new(
            "companion_experimental_disabled",
            "Clovy Companion is off. Enable Companion pairing in Experiments, then restart Clovy.",
        ))
    }
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

fn create_pairing_request(
    runtime: &CompanionRuntime,
    identity: &StoredIdentity,
    secret: &[u8; KEY_BYTES],
) -> Result<CreatePairingRequest, AppError> {
    Ok(CreatePairingRequest {
        desktop_device_id: identity.device_id,
        desktop_public_key: identity.public_key()?.to_vec(),
        display_name: runtime.desktop_display_name(),
        pairing_proof: Sha256::digest(secret).to_vec(),
    })
}

fn resolve_desktop_display_name() -> String {
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
    ["COMPUTERNAME", "HOSTNAME"]
        .into_iter()
        .find_map(|key| {
            std::env::var(key)
                .ok()
                .and_then(|value| normalized_device_name(&value))
        })
        .unwrap_or_else(default_desktop_display_name)
}

fn default_desktop_display_name() -> String {
    "Clovy on Mac".to_string()
}

fn normalized_device_name(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let mut end = value.len().min(MAX_DEVICE_DISPLAY_NAME_BYTES);
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    Some(value[..end].to_string())
}

fn relay_websocket_url() -> String {
    let base = crate::clovy_api::clovy_api_url();
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
    let url = format!("{}{}", crate::clovy_api::clovy_api_url(), path);
    let client = companion_http_client()?;
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

fn companion_http_client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .default_headers(crate::clovy_api::app_version_headers())
        .build()
        .map_err(|_| {
            AppError::new(
                "companion_relay_unavailable",
                "The companion relay client could not start.",
            )
        })
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn load_identity(account_user_id: &str) -> Result<Option<StoredIdentity>, AppError> {
    let encoded = crate::credential_compat::get_password(
        KEYCHAIN_SERVICE,
        LEGACY_KEYCHAIN_SERVICE,
        account_user_id,
    )
    .map_err(|_| AppError::new("companion_keychain_unavailable", "Keychain is unavailable."))?;
    if let Some(encoded) = encoded {
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
    crate::credential_compat::set_password(
        KEYCHAIN_SERVICE,
        LEGACY_KEYCHAIN_SERVICE,
        account_user_id,
        &encoded,
    )
    .map_err(|_| {
        AppError::new(
            "companion_keychain_unavailable",
            "The companion identity could not be saved to Keychain.",
        )
    })?;
    Ok(identity)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn remove_identity(account_user_id: &str) {
    let _ = crate::credential_compat::delete_password(
        KEYCHAIN_SERVICE,
        LEGACY_KEYCHAIN_SERVICE,
        account_user_id,
    );
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
        "Clovy Companion linking is available on supported desktop platforms.",
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn approval_registry() -> ComputerUseApprovalRegistry {
        let now = Instant::now();
        let request = ComputerUseApprovalRequest {
            request_id: "call-1".to_string(),
            stored_session_id: "session-1".to_string(),
            action: "click".to_string(),
            description: "Click a control in TextEdit.".to_string(),
            target_app: Some("TextEdit".to_string()),
            target_url: None,
            requested_at_ms: 1_000,
            expires_at_ms: 1_000 + COMPUTER_USE_APPROVAL_TTL_MS,
        };
        ComputerUseApprovalRegistry {
            requests: HashMap::from([(
                request.request_id.clone(),
                TrackedComputerUseApproval {
                    request,
                    tool_call_id: "tool-call-1".to_string(),
                    published_target: Some(crate::computer_use::CompanionApprovalTarget::fixture(
                        "TextEdit", 100,
                    )),
                    deadline: now + Duration::from_millis(COMPUTER_USE_APPROVAL_TTL_MS),
                    expiry_armed: false,
                    phase: ComputerUseApprovalPhase::Pending,
                    remote_permit_armed: false,
                },
            )]),
        }
    }

    #[test]
    fn computer_use_approval_gate_requires_features_and_desktop_opt_in() {
        assert!(computer_use_approval_gate(true, true, true, true));
        assert!(!computer_use_approval_gate(false, true, true, true));
        assert!(!computer_use_approval_gate(true, false, true, true));
        assert!(!computer_use_approval_gate(true, true, false, true));
        assert!(!computer_use_approval_gate(true, true, true, false));
        assert!(companion_capabilities().contains(&Capability::ComputerUseApprove));
    }

    #[test]
    fn computer_use_approval_rejects_wrong_id_session_expiry_and_replay() {
        let expires_at_ms = 1_000 + COMPUTER_USE_APPROVAL_TTL_MS;
        let mut registry = approval_registry();
        let deadline = registry.requests["call-1"].deadline;
        let companion = ComputerUseApprovalOrigin::Companion {
            device_id: "phone-1".to_string(),
        };
        assert_eq!(
            registry
                .begin_resolution(
                    "other-call",
                    "session-1",
                    1_001,
                    deadline - Duration::from_millis(1),
                    &companion,
                )
                .unwrap_err()
                .code,
            "companion_computer_use_approval_not_found"
        );
        assert_eq!(
            registry
                .begin_resolution(
                    "call-1",
                    "other-session",
                    1_001,
                    deadline - Duration::from_millis(1),
                    &companion,
                )
                .unwrap_err()
                .code,
            "companion_computer_use_approval_invalid"
        );
        assert_eq!(
            registry
                .begin_resolution("call-1", "session-1", expires_at_ms, deadline, &companion,)
                .unwrap_err()
                .code,
            "companion_computer_use_approval_expired"
        );
        assert_eq!(
            registry
                .begin_resolution("call-1", "session-1", expires_at_ms, deadline, &companion,)
                .unwrap_err()
                .code,
            "companion_computer_use_approval_replay"
        );
    }

    #[test]
    fn timeout_denies_and_desktop_decisions_override_remote_prompts() {
        let expires_at_ms = 1_000 + COMPUTER_USE_APPROVAL_TTL_MS;
        let mut timeout = approval_registry();
        let deadline = timeout.requests["call-1"].deadline;
        assert_eq!(
            timeout
                .confirm_delivery(
                    "call-1",
                    "session-1",
                    1_001,
                    deadline - Duration::from_millis(1),
                )
                .unwrap(),
            Some(deadline)
        );
        assert!(timeout
            .begin_resolution(
                "call-1",
                "session-1",
                expires_at_ms,
                deadline,
                &ComputerUseApprovalOrigin::Timeout,
            )
            .is_ok());
        assert!(timeout.complete_resolution("call-1", "session-1", false, false));
        assert_eq!(
            timeout
                .begin_resolution(
                    "call-1",
                    "session-1",
                    expires_at_ms,
                    deadline,
                    &ComputerUseApprovalOrigin::Companion {
                        device_id: "phone-1".to_string(),
                    },
                )
                .unwrap_err()
                .code,
            "companion_computer_use_approval_replay"
        );

        let mut desktop = approval_registry();
        let desktop_deadline = desktop.requests["call-1"].deadline;
        assert!(desktop.complete_resolution("call-1", "session-1", true, false));
        assert_eq!(
            desktop.take_remote_permit(
                "tool-call-1",
                "session-1",
                &crate::computer_use::CompanionApprovalTarget::fixture("TextEdit", 100),
            ),
            ComputerUsePermitTake::Unavailable
        );
        assert_eq!(
            desktop
                .begin_resolution(
                    "call-1",
                    "session-1",
                    1_001,
                    desktop_deadline - Duration::from_millis(1),
                    &ComputerUseApprovalOrigin::Companion {
                        device_id: "phone-1".to_string(),
                    },
                )
                .unwrap_err()
                .code,
            "companion_computer_use_approval_replay"
        );
    }

    #[test]
    fn remote_permit_is_bound_to_one_matching_invocation() {
        let mut registry = approval_registry();
        let published = crate::computer_use::CompanionApprovalTarget::fixture("TextEdit", 100);
        let other = crate::computer_use::CompanionApprovalTarget::fixture("Mail", 200);
        assert!(registry.complete_resolution("call-1", "session-1", true, true));
        assert_eq!(
            registry.take_remote_permit("tool-call-1", "other-session", &published),
            ComputerUsePermitTake::Unavailable
        );
        assert!(matches!(
            registry.take_remote_permit("tool-call-1", "session-1", &published),
            ComputerUsePermitTake::Consumed { .. }
        ));
        assert_eq!(
            registry.take_remote_permit("tool-call-1", "session-1", &published),
            ComputerUsePermitTake::Unavailable
        );

        let mut mismatch = approval_registry();
        assert!(mismatch.complete_resolution("call-1", "session-1", true, true));
        assert!(matches!(
            mismatch.take_remote_permit("tool-call-1", "session-1", &other),
            ComputerUsePermitTake::TargetMismatch { .. }
        ));
        assert_eq!(
            mismatch.requests["call-1"].phase,
            ComputerUseApprovalPhase::Resolved
        );

        let mut reused_window = approval_registry();
        assert!(reused_window.complete_resolution("call-1", "session-1", true, true));
        let replacement_process =
            crate::computer_use::CompanionApprovalTarget::fixture_with_pid("TextEdit", 200, 100);
        assert!(matches!(
            reused_window.take_remote_permit("tool-call-1", "session-1", &replacement_process),
            ComputerUsePermitTake::TargetMismatch { .. }
        ));
    }

    #[test]
    fn approval_expiry_requires_one_authenticated_delivery_receipt() {
        let mut registry = approval_registry();
        let deadline = registry.requests["call-1"].deadline;
        assert_eq!(
            registry
                .begin_resolution(
                    "call-1",
                    "session-1",
                    1_000 + COMPUTER_USE_APPROVAL_TTL_MS,
                    deadline,
                    &ComputerUseApprovalOrigin::Timeout,
                )
                .unwrap_err()
                .code,
            "companion_computer_use_approval_delivery_unconfirmed"
        );
        assert_eq!(
            registry
                .confirm_delivery(
                    "call-1",
                    "session-1",
                    1_001,
                    deadline - Duration::from_millis(1),
                )
                .unwrap(),
            Some(deadline)
        );
        assert_eq!(
            registry
                .confirm_delivery(
                    "call-1",
                    "session-1",
                    1_002,
                    deadline - Duration::from_millis(1),
                )
                .unwrap(),
            None
        );
    }

    #[test]
    fn approval_description_omits_typed_text_and_stays_bounded() {
        let arguments = serde_json::json!({
            "action": "Type",
            "app": "TextEdit",
            "text": "private words",
        });
        let action = crate::computer_use::normalized_action(&arguments).unwrap();
        let description = approval_description(&action, Some("TextEdit"));

        assert_eq!(description, "Type in TextEdit.");
        assert!(!description.contains("private words"));
        assert!(description.len() <= MAX_COMPUTER_USE_DESCRIPTION_BYTES);
    }

    #[test]
    fn monotonic_deadline_expires_even_when_wall_clock_moves_backward() {
        let mut registry = approval_registry();
        let deadline = registry.requests["call-1"].deadline;
        registry
            .confirm_delivery(
                "call-1",
                "session-1",
                1,
                deadline - Duration::from_millis(1),
            )
            .unwrap();

        assert!(registry
            .begin_resolution(
                "call-1",
                "session-1",
                1,
                deadline,
                &ComputerUseApprovalOrigin::Timeout,
            )
            .is_ok());
    }

    #[tokio::test]
    async fn expiration_resolution_retries_transient_failures() {
        let attempts = AtomicUsize::new(0);

        retry_computer_use_expiration(
            || {
                let attempt = attempts.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt < 2 {
                        Err(AppError::new("temporary_failure", "Try again."))
                    } else {
                        Ok(serde_json::json!({ "status": "resolved" }))
                    }
                }
            },
            3,
            Duration::ZERO,
        )
        .await
        .unwrap();

        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn overlong_approval_fields_fail_closed_instead_of_being_truncated() {
        let mut request = approval_registry()
            .requests
            .remove("call-1")
            .expect("approval fixture")
            .request;
        request.target_url = Some(format!(
            "https://trusted.example/{}",
            "x".repeat(MAX_COMPUTER_USE_TARGET_URL_BYTES)
        ));

        let url_error = validate_computer_use_approval_fields(&request).unwrap_err();
        assert_eq!(url_error.code, "companion_computer_use_approval_too_large");
        assert!(request
            .target_url
            .as_deref()
            .is_some_and(|url| url.len() > MAX_COMPUTER_USE_TARGET_URL_BYTES));

        request.target_url = None;
        request.description = "é".repeat((MAX_COMPUTER_USE_DESCRIPTION_BYTES / 2) + 1);
        let description_error = validate_computer_use_approval_fields(&request).unwrap_err();
        assert_eq!(
            description_error.code,
            "companion_computer_use_approval_too_large"
        );
        assert!(request.description.len() > MAX_COMPUTER_USE_DESCRIPTION_BYTES);
    }

    #[test]
    fn begin_pairing_refuses_when_the_experiment_is_off() {
        let error = ensure_companion_pairing_enabled_with(false).unwrap_err();

        assert_eq!(error.code, "companion_experimental_disabled");
        assert_eq!(
            error.message,
            "Clovy Companion is off. Enable Companion pairing in Experiments, then restart Clovy."
        );
    }

    #[test]
    fn stored_disable_does_not_stop_an_effective_companion_runtime() {
        let runtime = CompanionRuntime::default();

        assert!(runtime.latch_effective_enabled(true));
        assert!(runtime.latch_effective_enabled(false));
        assert!(ensure_companion_pairing_enabled(&runtime).is_ok());
    }

    #[test]
    fn stored_enable_does_not_start_an_ineffective_companion_runtime() {
        let runtime = CompanionRuntime::default();

        assert!(!runtime.latch_effective_enabled(false));
        assert!(!runtime.latch_effective_enabled(true));
        assert_eq!(
            ensure_companion_pairing_enabled(&runtime).unwrap_err().code,
            "companion_experimental_disabled"
        );
    }

    #[test]
    fn pairing_discloses_separate_model_read_and_edit_grants() {
        let capabilities = companion_capabilities();

        assert!(capabilities.contains(&Capability::ModelRead));
        assert!(capabilities.contains(&Capability::ModelEdit));
    }

    #[tokio::test]
    async fn companion_http_requests_carry_the_app_version() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 4096];
            let read = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]).to_string();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                .await
                .unwrap();
            request
        });

        companion_http_client()
            .unwrap()
            .get(format!("http://{address}/v1/companion/pairings"))
            .send()
            .await
            .unwrap();

        let request = server.await.unwrap().to_ascii_lowercase();
        assert!(request.contains(&format!(
            "x-june-app-version: {}",
            env!("CARGO_PKG_VERSION")
        )));
    }

    #[test]
    fn manual_pairing_code_contains_the_same_bootstrap_payload_as_the_qr() {
        let pairing_id = Uuid::new_v4();
        let wire = PairingQrWirePayload {
            version: clovy_companion_protocol::PROTOCOL_VERSION,
            pairing_id,
            pairing_secret: URL_SAFE_NO_PAD.encode([7_u8; KEY_BYTES]),
            relay_url: "wss://api.example.test/v1/companion/relay".to_string(),
            expires_at_ms: 2_000,
        };
        let encoded = serde_json::to_vec(&wire).unwrap();
        let pairing_code = URL_SAFE_NO_PAD.encode(&encoded);

        assert_eq!(URL_SAFE_NO_PAD.decode(&pairing_code).unwrap(), encoded);

        let response = PairingQrPayload {
            pairing_id,
            expires_at_ms: 2_000,
            qr_svg: "<svg />".to_string(),
            pairing_code: pairing_code.clone(),
        };
        let serialized = serde_json::to_value(response).unwrap();
        assert_eq!(serialized["pairingCode"], pairing_code);
        assert!(serialized.get("pairingSecret").is_none());
    }

    #[test]
    fn main_window_can_copy_pairing_codes_without_reading_the_clipboard() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/main.json")).unwrap();
        let permissions = capability["permissions"].as_array().unwrap();

        assert!(permissions
            .iter()
            .any(|value| value == "clipboard-manager:allow-write-text"));
        assert!(!permissions
            .iter()
            .any(|value| value == "clipboard-manager:allow-read-text"));
    }

    #[test]
    fn device_names_are_trimmed_and_bounded_by_encoded_size() {
        assert_eq!(
            normalized_device_name("  Studio Mac  ").as_deref(),
            Some("Studio Mac")
        );
        assert_eq!(normalized_device_name("  "), None);

        let oversized = "a".repeat(MAX_DEVICE_DISPLAY_NAME_BYTES + 1);
        assert_eq!(
            normalized_device_name(&oversized).unwrap().len(),
            MAX_DEVICE_DISPLAY_NAME_BYTES
        );

        let unicode = "é".repeat(MAX_DEVICE_DISPLAY_NAME_BYTES);
        let normalized = normalized_device_name(&unicode).unwrap();
        assert!(normalized.len() <= MAX_DEVICE_DISPLAY_NAME_BYTES);
        assert!(normalized.is_char_boundary(normalized.len()));
    }

    #[test]
    fn pairing_request_uses_the_startup_cached_desktop_name() {
        let runtime = CompanionRuntime::default();
        runtime.latch_desktop_display_name("Studio Mac".to_string());
        let identity = StoredIdentity {
            account_user_id: "usr_test".to_string(),
            device_id: Uuid::nil(),
            private_key_b64: STANDARD_NO_PAD.encode([1_u8; KEY_BYTES]),
            public_key_b64: STANDARD_NO_PAD.encode([2_u8; KEY_BYTES]),
        };

        let request = create_pairing_request(&runtime, &identity, &[3_u8; KEY_BYTES]).unwrap();
        let serialized = serde_json::to_value(request).unwrap();

        assert_eq!(serialized["displayName"], "Studio Mac");
        assert_eq!(
            serialized["desktopPublicKey"],
            serde_json::json!(vec![2_u8; KEY_BYTES])
        );
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

    #[tokio::test]
    async fn frontend_timeout_releases_activity_before_logout_waits() {
        let runtime = CompanionRuntime::default();
        let operation_id = Uuid::new_v4();
        let (sender, receiver) = oneshot::channel::<ResultPayload>();
        runtime
            .pending_frontend
            .lock()
            .unwrap()
            .insert(operation_id, sender);

        {
            let _activity = FrontendActivityGuard::begin(&runtime, operation_id).unwrap();
            assert!(tokio::time::timeout(Duration::ZERO, receiver)
                .await
                .is_err());
        }

        assert_eq!(runtime.account_activity.load(Ordering::Acquire), 0);
        assert!(!runtime
            .pending_frontend
            .lock()
            .unwrap()
            .contains_key(&operation_id));
        runtime
            .account_transport_enabled
            .store(false, Ordering::Release);
        wait_for_account_activity(&runtime, Duration::from_millis(10))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn logout_clears_media_handles_inserted_by_draining_activity() {
        let runtime = CompanionRuntime::default();
        runtime.account_activity.store(1, Ordering::Release);
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("media.png");
        std::fs::write(&path, [1]).unwrap();

        media::clear_transfer_cache(&runtime.media_transfers);
        runtime
            .media_transfers
            .lock()
            .unwrap()
            .insert_test_transfer(path);
        assert_eq!(
            runtime
                .media_transfers
                .lock()
                .unwrap()
                .test_transfer_count(),
            1
        );

        let drain =
            wait_for_account_activity_then_clear_media(&runtime, Duration::from_millis(100));
        tokio::pin!(drain);
        assert!(tokio::time::timeout(Duration::ZERO, &mut drain)
            .await
            .is_err());

        runtime.account_activity.store(0, Ordering::Release);
        runtime.account_activity_changed.notify_one();
        drain.await.unwrap();
        assert_eq!(
            runtime
                .media_transfers
                .lock()
                .unwrap()
                .test_transfer_count(),
            0
        );
    }
}
