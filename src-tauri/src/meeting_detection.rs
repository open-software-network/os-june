use crate::domain::types::{AppError, NoteDto, RecordingSessionDto};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

const CLEAR_AFTER_INACTIVE_POLLS: u8 = 2;
const HEARTBEAT_EVERY_ACTIVE_POLLS: u8 = 5;
const POLL_INTERVAL: Duration = Duration::from_secs(1);
const MEETING_DETECTION_EVENT_NAME: &str = "meeting-detection-event";
const MEETING_START_REQUEST_EVENT_NAME: &str = "june://meeting-start-transcription";
const MEETING_START_REQUEST_TTL_MS: u64 = 30_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMeetingStartRequest {
    request_id: String,
    note_id: String,
    requested_at_ms: u64,
    expired: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum MeetingStartRecordingOutcome {
    Started {
        note: Box<NoteDto>,
        recording: Box<RecordingSessionDto>,
    },
    Failed {
        error: AppError,
    },
}

#[derive(Debug)]
enum MeetingStartRequestPhase {
    Queued,
    Starting,
    Finished(Box<MeetingStartRecordingOutcome>),
}

#[derive(Debug)]
struct MeetingStartRequest {
    request_id: String,
    note_id: String,
    requested_at_ms: u64,
    phase: MeetingStartRequestPhase,
}

#[derive(Debug, Default)]
struct MeetingStartRequestMailbox {
    next_request_id: u64,
    pending: Option<MeetingStartRequest>,
}

#[derive(Debug, Default)]
pub struct MeetingStartRequestState {
    mailbox: Mutex<MeetingStartRequestMailbox>,
    start_lock: tokio::sync::Mutex<()>,
}

impl MeetingStartRequestState {
    fn queue_at(&self, requested_at_ms: u64) -> Result<String, String> {
        let mut mailbox = self
            .mailbox
            .lock()
            .map_err(|_| "meeting start request state is unavailable".to_string())?;
        if let Some(pending) = mailbox.pending.as_ref() {
            if matches!(pending.phase, MeetingStartRequestPhase::Starting) {
                return Ok(pending.request_id.clone());
            }
        }

        // Every queued click gets a new generation, even though the one-slot
        // mailbox still replaces the older intent. An acknowledgement based
        // on an expired snapshot can therefore never clear a newer click.
        mailbox.next_request_id = mailbox.next_request_id.saturating_add(1).max(1);
        let request_id = mailbox.next_request_id.to_string();
        mailbox.pending = Some(MeetingStartRequest {
            request_id: request_id.clone(),
            note_id: uuid::Uuid::new_v4().to_string(),
            requested_at_ms,
            phase: MeetingStartRequestPhase::Queued,
        });
        Ok(request_id)
    }

    fn peek_at(&self, now_ms: u64) -> Result<Option<PendingMeetingStartRequest>, String> {
        let mailbox = self
            .mailbox
            .lock()
            .map_err(|_| "meeting start request state is unavailable".to_string())?;
        Ok(mailbox
            .pending
            .as_ref()
            .map(|pending| PendingMeetingStartRequest {
                request_id: pending.request_id.clone(),
                note_id: pending.note_id.clone(),
                requested_at_ms: pending.requested_at_ms,
                expired: matches!(pending.phase, MeetingStartRequestPhase::Queued)
                    && now_ms.saturating_sub(pending.requested_at_ms)
                        > MEETING_START_REQUEST_TTL_MS,
            }))
    }

    fn acknowledge(&self, request_id: &str) -> Result<bool, String> {
        let mut mailbox = self
            .mailbox
            .lock()
            .map_err(|_| "meeting start request state is unavailable".to_string())?;
        let matches = mailbox.pending.as_ref().is_some_and(|pending| {
            pending.request_id == request_id
                && !matches!(pending.phase, MeetingStartRequestPhase::Starting)
        });
        if matches {
            mailbox.pending = None;
        }
        Ok(matches)
    }

    pub async fn lock_start(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.start_lock.lock().await
    }

    pub fn begin_start_now(&self, request_id: &str) -> Result<String, AppError> {
        let now_ms = wall_clock_millis()
            .map_err(|message| AppError::new("meeting_start_unavailable", message))?;
        self.begin_start(request_id, now_ms)
    }

    pub fn begin_start(&self, request_id: &str, now_ms: u64) -> Result<String, AppError> {
        let mut mailbox = self.mailbox.lock().map_err(|_| {
            AppError::new(
                "meeting_start_unavailable",
                "The meeting start request is unavailable.",
            )
        })?;
        let pending = mailbox.pending.as_mut().ok_or_else(|| {
            AppError::new(
                "meeting_start_not_found",
                "The meeting start request was not found.",
            )
        })?;
        if pending.request_id != request_id {
            return Err(AppError::new(
                "meeting_start_not_found",
                "The meeting start request is no longer current.",
            ));
        }
        match &pending.phase {
            MeetingStartRequestPhase::Queued => {
                if now_ms.saturating_sub(pending.requested_at_ms) > MEETING_START_REQUEST_TTL_MS {
                    return Err(AppError::new(
                        "meeting_start_expired",
                        "The meeting start request expired before recording began.",
                    ));
                }
                pending.phase = MeetingStartRequestPhase::Starting;
                Ok(pending.note_id.clone())
            }
            MeetingStartRequestPhase::Starting => Err(AppError::new(
                "meeting_start_in_progress",
                "The meeting recording is already starting.",
            )),
            MeetingStartRequestPhase::Finished(_) => Err(AppError::new(
                "meeting_start_already_finished",
                "The meeting start request already finished.",
            )),
        }
    }

    pub fn finished_outcome(
        &self,
        request_id: &str,
    ) -> Result<Option<MeetingStartRecordingOutcome>, AppError> {
        let mailbox = self.mailbox.lock().map_err(|_| {
            AppError::new(
                "meeting_start_unavailable",
                "The meeting start request is unavailable.",
            )
        })?;
        let Some(pending) = mailbox
            .pending
            .as_ref()
            .filter(|pending| pending.request_id == request_id)
        else {
            return Err(AppError::new(
                "meeting_start_not_found",
                "The meeting start request was not found.",
            ));
        };
        Ok(match &pending.phase {
            MeetingStartRequestPhase::Finished(outcome) => Some((**outcome).clone()),
            _ => None,
        })
    }

    pub fn finish_start(
        &self,
        request_id: &str,
        outcome: MeetingStartRecordingOutcome,
    ) -> Result<(), AppError> {
        let mut mailbox = self.mailbox.lock().map_err(|_| {
            AppError::new(
                "meeting_start_unavailable",
                "The meeting start request is unavailable.",
            )
        })?;
        let Some(pending) = mailbox
            .pending
            .as_mut()
            .filter(|pending| pending.request_id == request_id)
        else {
            return Err(AppError::new(
                "meeting_start_not_found",
                "The meeting start request was not found.",
            ));
        };
        pending.phase = MeetingStartRequestPhase::Finished(Box::new(outcome));
        Ok(())
    }

    pub fn fail_start_if_running(&self, request_id: &str) -> Result<bool, AppError> {
        let mut mailbox = self.mailbox.lock().map_err(|_| {
            AppError::new(
                "meeting_start_unavailable",
                "The meeting start request is unavailable.",
            )
        })?;
        let Some(pending) = mailbox
            .pending
            .as_mut()
            .filter(|pending| pending.request_id == request_id)
        else {
            return Ok(false);
        };
        if !matches!(pending.phase, MeetingStartRequestPhase::Starting) {
            return Ok(false);
        }
        pending.phase =
            MeetingStartRequestPhase::Finished(Box::new(MeetingStartRecordingOutcome::Failed {
                error: AppError::new(
                    "meeting_start_interrupted",
                    "Meeting recording stopped before startup completed. Try again.",
                ),
            }));
        Ok(true)
    }
}

fn wall_clock_millis() -> Result<u64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before the Unix epoch".to_string())?
        .as_millis();
    u64::try_from(millis).map_err(|_| "system clock is outside the supported range".to_string())
}

/// Stores the HUD action before emitting the wake event. Tauri events are not
/// buffered while a webview listener is registering, so the main window also
/// reads this one-slot mailbox after its listener and app bootstrap are ready.
#[tauri::command]
pub fn queue_meeting_start_request(
    app: AppHandle,
    state: State<'_, MeetingStartRequestState>,
) -> Result<(), String> {
    state.queue_at(wall_clock_millis()?)?;
    app.emit(MEETING_START_REQUEST_EVENT_NAME, ())
        .map_err(|error| format!("failed to wake the meeting-start listener: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn pending_meeting_start_request(
    state: State<'_, MeetingStartRequestState>,
) -> Result<Option<PendingMeetingStartRequest>, String> {
    state.peek_at(wall_clock_millis()?)
}

#[tauri::command]
pub fn acknowledge_meeting_start_request(
    state: State<'_, MeetingStartRequestState>,
    request_id: String,
) -> Result<bool, String> {
    state.acknowledge(&request_id)
}

struct AllowedMicApp {
    bundle_prefix: &'static str,
    label: &'static str,
}

const fn mic_app(bundle_prefix: &'static str, label: &'static str) -> AllowedMicApp {
    AllowedMicApp {
        bundle_prefix,
        label,
    }
}

const ALLOWED_MIC_APPS: &[AllowedMicApp] = &[
    mic_app("ai.perplexity.comet", "Comet"),
    mic_app("Cisco-Systems.Spark", "Webex"),
    mic_app("com.apple.FaceTime", "FaceTime"),
    mic_app("com.apple.Safari", "Safari"),
    mic_app("com.brave.Browser", "Brave"),
    mic_app("com.cisco.webexmeetingsapp", "Webex"),
    mic_app("com.gather.GatherV2", "Gather"),
    mic_app("com.google.Chrome", "Chrome"),
    mic_app("com.hnc.Discord", "Discord"),
    mic_app("com.microsoft.edgemac", "Edge"),
    mic_app("com.microsoft.teams", "Teams"),
    mic_app("com.microsoft.teams2", "Teams"),
    mic_app("com.operasoftware.Opera", "Opera"),
    mic_app("com.tinyspeck.slackmacgap", "Slack"),
    mic_app("com.vivaldi.Vivaldi", "Vivaldi"),
    mic_app("company.thebrowser.Browser", "Arc"),
    mic_app("company.thebrowser.dia", "Dia"),
    mic_app("net.whatsapp.WhatsApp", "WhatsApp"),
    mic_app("org.mozilla.firefox", "Firefox"),
    mic_app("org.mozilla.firefoxdeveloperedition", "Firefox"),
    mic_app("org.mozilla.nightly", "Firefox"),
    mic_app("org.telegram.desktop", "Telegram"),
    mic_app("org.whispersystems.signal-desktop", "Signal"),
    mic_app("ru.keepcoder.Telegram", "Telegram"),
    mic_app("us.zoom.xos", "Zoom"),
];

pub fn setup(app: &mut tauri::App) {
    app.manage(MeetingStartRequestState::default());

    #[cfg(target_os = "macos")]
    spawn_monitor(app.handle().clone());

    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MeetingDetectionEvent {
    Detected,
    /// Periodic re-emit while a meeting stays active, so a HUD webview that
    /// missed the initial event (e.g. after a reload) can still catch up.
    Heartbeat,
    Cleared,
}

#[derive(Debug, Default)]
pub(crate) struct MeetingDetectionState {
    active: bool,
    inactive_polls: u8,
    active_polls_since_emit: u8,
}

impl MeetingDetectionState {
    pub(crate) fn update(
        &mut self,
        signed_in: bool,
        active_external_input: bool,
        os_june_capture_active: bool,
    ) -> Option<MeetingDetectionEvent> {
        if !signed_in {
            return self.clear();
        }

        let should_be_active = active_external_input && !os_june_capture_active;
        if should_be_active {
            self.inactive_polls = 0;
            if !self.active {
                self.active = true;
                self.active_polls_since_emit = 0;
                return Some(MeetingDetectionEvent::Detected);
            }

            self.active_polls_since_emit = self.active_polls_since_emit.saturating_add(1);
            if self.active_polls_since_emit >= HEARTBEAT_EVERY_ACTIVE_POLLS {
                self.active_polls_since_emit = 0;
                return Some(MeetingDetectionEvent::Heartbeat);
            }
            return None;
        }

        self.active_polls_since_emit = 0;
        if !self.active {
            self.inactive_polls = 0;
            return None;
        }

        self.inactive_polls = self.inactive_polls.saturating_add(1);
        if self.inactive_polls >= CLEAR_AFTER_INACTIVE_POLLS {
            self.active = false;
            self.inactive_polls = 0;
            return Some(MeetingDetectionEvent::Cleared);
        }

        None
    }

    fn clear(&mut self) -> Option<MeetingDetectionEvent> {
        self.inactive_polls = 0;
        self.active_polls_since_emit = 0;
        if self.active {
            self.active = false;
            return Some(MeetingDetectionEvent::Cleared);
        }
        None
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MicrophoneInputProcess {
    pub(crate) pid: u32,
    pub(crate) bundle_id: String,
    pub(crate) app_label: String,
}

impl MicrophoneInputProcess {
    pub(crate) fn new(pid: u32, bundle_id: String) -> Option<Self> {
        let bundle_id = bundle_id.trim().to_string();
        if pid == 0 || bundle_id.is_empty() {
            return None;
        }
        let app_label = app_label_from_bundle_id(&bundle_id);
        Some(Self {
            pid,
            bundle_id,
            app_label,
        })
    }
}

pub(crate) fn active_allowed_external_processes(
    active_input_processes: &[MicrophoneInputProcess],
    owned_pids: &BTreeSet<u32>,
) -> Vec<MicrophoneInputProcess> {
    active_input_processes
        .iter()
        .filter(|process| process.pid != 0 && !owned_pids.contains(&process.pid))
        .filter(|process| is_allowed_microphone_app(&process.bundle_id))
        .cloned()
        .collect()
}

fn is_allowed_microphone_app(bundle_id: &str) -> bool {
    allowed_mic_app(bundle_id).is_some()
}

fn bundle_id_matches_prefix(bundle_id: &str, prefix: &str) -> bool {
    let bundle_id = bundle_id.trim().to_ascii_lowercase();
    let prefix = prefix.trim().to_ascii_lowercase();
    bundle_id == prefix
        || bundle_id
            .strip_prefix(&prefix)
            .is_some_and(|suffix| suffix.starts_with('.'))
}

fn app_label_from_bundle_id(bundle_id: &str) -> String {
    if let Some(app) = allowed_mic_app(bundle_id) {
        return app.label.to_string();
    }
    bundle_id
        .rsplit('.')
        .find(|part| !part.trim().is_empty())
        .unwrap_or(bundle_id)
        .to_string()
}

fn allowed_mic_app(bundle_id: &str) -> Option<&'static AllowedMicApp> {
    ALLOWED_MIC_APPS
        .iter()
        .find(|app| bundle_id_matches_prefix(bundle_id, app.bundle_prefix))
}

#[cfg(target_os = "macos")]
fn spawn_monitor(app: AppHandle) {
    std::thread::spawn(move || {
        let mut state = MeetingDetectionState::default();
        let mut warned_after_probe_error = false;

        loop {
            std::thread::sleep(POLL_INTERVAL);

            if !crate::os_accounts::cached_signed_in() {
                if let Some(event) = state.update(false, false, false) {
                    emit_detection_event(&app, event, &[]);
                }
                continue;
            }

            let active_processes = match active_input_processes() {
                Ok(active_processes) => {
                    warned_after_probe_error = false;
                    active_processes
                }
                Err(error) => {
                    if !warned_after_probe_error {
                        tracing::warn!(%error, "meeting detection probe failed");
                        warned_after_probe_error = true;
                    }
                    Vec::new()
                }
            };
            let allowed_processes =
                active_allowed_external_processes(&active_processes, &owned_pids(&app));
            let capture_active = crate::audio::capture::is_capture_active();
            if let Some(event) = state.update(true, !allowed_processes.is_empty(), capture_active) {
                emit_detection_event(&app, event, &allowed_processes);
            }
        }
    });
}

fn owned_pids(app: &AppHandle) -> BTreeSet<u32> {
    let mut pids = BTreeSet::from([std::process::id()]);
    if let Some(helper_pid) = crate::dictation::dictation_helper_pid(app) {
        pids.insert(helper_pid);
    }
    pids
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeetingDetectionPayload {
    active_process_count: usize,
    /// Friendly names of the apps holding the microphone ("Zoom", "Chrome"),
    /// deduped in detection order. The HUD shows these under the prompt title.
    app_labels: Vec<String>,
}

#[derive(Debug, Serialize)]
struct MeetingDetectionEnvelope {
    #[serde(rename = "type")]
    event_type: &'static str,
    payload: MeetingDetectionPayload,
}

pub(crate) fn deduped_app_labels(processes: &[MicrophoneInputProcess]) -> Vec<String> {
    let mut labels: Vec<String> = Vec::new();
    for process in processes {
        if !labels.contains(&process.app_label) {
            labels.push(process.app_label.clone());
        }
    }
    labels
}

fn emit_detection_event(
    app: &AppHandle,
    event: MeetingDetectionEvent,
    allowed_processes: &[MicrophoneInputProcess],
) {
    let event_type = match event {
        MeetingDetectionEvent::Detected => {
            // Wake the (possibly suspended) HUD webview without revealing
            // the window — it shows itself once the prompt is sized.
            crate::dictation::wake_hud_window(app);
            "meeting_detected"
        }
        // Heartbeats must NOT re-show the native window: after the prompt
        // auto-suppresses, the webview renders nothing, and a re-shown window
        // is just the bare vibrancy frost — a stuck gray bar the user can't
        // drag or dismiss. The HUD shows itself when it decides to render.
        MeetingDetectionEvent::Heartbeat => "meeting_detected",
        MeetingDetectionEvent::Cleared => "meeting_cleared",
    };
    let payload = MeetingDetectionEnvelope {
        event_type,
        payload: MeetingDetectionPayload {
            active_process_count: allowed_processes.len(),
            app_labels: deduped_app_labels(allowed_processes),
        },
    };
    match serde_json::to_string(&payload) {
        Ok(payload) => {
            let _ = app.emit(MEETING_DETECTION_EVENT_NAME, payload);
        }
        Err(error) => {
            tracing::warn!(%error, "failed to encode meeting detection event");
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) use macos::active_input_processes;

#[cfg(not(target_os = "macos"))]
pub(crate) fn active_input_processes() -> Result<Vec<MicrophoneInputProcess>, ProbeError> {
    Ok(Vec::new())
}

#[derive(Debug)]
pub(crate) struct ProbeError {
    operation: &'static str,
    status: i32,
}

impl ProbeError {
    fn new(operation: &'static str, status: i32) -> Self {
        Self { operation, status }
    }
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} failed with OSStatus {}",
            self.operation, self.status
        )
    }
}

impl std::error::Error for ProbeError {}

#[cfg(target_os = "macos")]
mod macos {
    use super::{MicrophoneInputProcess, ProbeError};
    use std::{ffi::c_void, mem, ptr};

    type AudioObjectId = u32;
    type AudioObjectPropertySelector = u32;
    type AudioObjectPropertyScope = u32;
    type AudioObjectPropertyElement = u32;
    type OsStatus = i32;

    const AUDIO_OBJECT_SYSTEM_OBJECT: AudioObjectId = 1;
    const AUDIO_OBJECT_UNKNOWN: AudioObjectId = 0;
    const AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: AudioObjectPropertyScope = four_cc(*b"glob");
    const AUDIO_OBJECT_PROPERTY_SCOPE_INPUT: AudioObjectPropertyScope = four_cc(*b"inpt");
    const AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: AudioObjectPropertyElement = 0;
    const AUDIO_HARDWARE_PROPERTY_PROCESS_OBJECT_LIST: AudioObjectPropertySelector =
        four_cc(*b"prs#");
    const AUDIO_PROCESS_PROPERTY_PID: AudioObjectPropertySelector = four_cc(*b"ppid");
    const AUDIO_PROCESS_PROPERTY_BUNDLE_ID: AudioObjectPropertySelector = four_cc(*b"pbid");
    const AUDIO_PROCESS_PROPERTY_DEVICES: AudioObjectPropertySelector = four_cc(*b"pdv#");
    const AUDIO_PROCESS_PROPERTY_IS_RUNNING_INPUT: AudioObjectPropertySelector = four_cc(*b"piri");

    #[repr(C)]
    struct AudioObjectPropertyAddress {
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
        element: AudioObjectPropertyElement,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyDataSize(
            object_id: AudioObjectId,
            address: *const AudioObjectPropertyAddress,
            qualifier_data_size: u32,
            qualifier_data: *const c_void,
            data_size: *mut u32,
        ) -> OsStatus;

        fn AudioObjectGetPropertyData(
            object_id: AudioObjectId,
            address: *const AudioObjectPropertyAddress,
            qualifier_data_size: u32,
            qualifier_data: *const c_void,
            data_size: *mut u32,
            data: *mut c_void,
        ) -> OsStatus;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringGetCString(
            string: *const c_void,
            buffer: *mut i8,
            buffer_size: isize,
            encoding: u32,
        ) -> u8;

        fn CFRelease(cf: *const c_void);
    }

    pub(crate) fn active_input_processes() -> Result<Vec<MicrophoneInputProcess>, ProbeError> {
        let mut processes = Vec::new();
        for process_object in process_objects()? {
            if process_object == AUDIO_OBJECT_UNKNOWN {
                continue;
            }
            let running_input = read_u32_property(
                process_object,
                AUDIO_PROCESS_PROPERTY_IS_RUNNING_INPUT,
                "read process input state",
            )
            .unwrap_or_default();
            if running_input == 0 {
                continue;
            }
            if !process_has_input_devices(process_object) {
                continue;
            }
            if let (Ok(Some(pid)), Ok(Some(bundle_id))) = (
                read_process_pid(process_object),
                read_process_bundle_id(process_object),
            ) {
                if let Some(process) = MicrophoneInputProcess::new(pid, bundle_id) {
                    processes.push(process);
                }
            }
        }
        processes.sort_by_key(|process| process.pid);
        processes.dedup_by_key(|process| process.pid);
        Ok(processes)
    }

    fn process_objects() -> Result<Vec<AudioObjectId>, ProbeError> {
        read_object_array_property(
            AUDIO_OBJECT_SYSTEM_OBJECT,
            AUDIO_HARDWARE_PROPERTY_PROCESS_OBJECT_LIST,
            AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            "read process object list size",
            "read process object list",
        )
    }

    fn read_object_array_property(
        object_id: AudioObjectId,
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
        size_operation: &'static str,
        data_operation: &'static str,
    ) -> Result<Vec<AudioObjectId>, ProbeError> {
        let address = property_address_with_scope(selector, scope);
        let mut data_size = 0_u32;
        status_result(size_operation, unsafe {
            AudioObjectGetPropertyDataSize(object_id, &address, 0, ptr::null(), &mut data_size)
        })?;

        if data_size == 0 {
            return Ok(Vec::new());
        }

        let object_count = data_size as usize / mem::size_of::<AudioObjectId>();
        let mut objects = vec![AUDIO_OBJECT_UNKNOWN; object_count];
        status_result(data_operation, unsafe {
            AudioObjectGetPropertyData(
                object_id,
                &address,
                0,
                ptr::null(),
                &mut data_size,
                objects.as_mut_ptr().cast(),
            )
        })?;

        let actual_count = data_size as usize / mem::size_of::<AudioObjectId>();
        objects.truncate(actual_count);
        Ok(objects)
    }

    fn process_devices(
        process_object: AudioObjectId,
        scope: AudioObjectPropertyScope,
    ) -> Result<Vec<AudioObjectId>, ProbeError> {
        read_object_array_property(
            process_object,
            AUDIO_PROCESS_PROPERTY_DEVICES,
            scope,
            "read process device list size",
            "read process device list",
        )
    }

    fn read_process_pid(process_object: AudioObjectId) -> Result<Option<u32>, ProbeError> {
        let pid = read_i32_property(
            process_object,
            AUDIO_PROCESS_PROPERTY_PID,
            "read process pid",
        )?;
        if pid <= 0 {
            Ok(None)
        } else {
            Ok(Some(pid as u32))
        }
    }

    fn process_has_input_devices(process_object: AudioObjectId) -> bool {
        process_devices(process_object, AUDIO_OBJECT_PROPERTY_SCOPE_INPUT)
            .map(|devices| !devices.is_empty())
            .unwrap_or(false)
    }

    fn read_process_bundle_id(process_object: AudioObjectId) -> Result<Option<String>, ProbeError> {
        let mut value: *const c_void = ptr::null();
        read_scalar_property(
            process_object,
            AUDIO_PROCESS_PROPERTY_BUNDLE_ID,
            "read process bundle id",
            &mut value,
        )?;
        if value.is_null() {
            return Ok(None);
        }

        let mut buffer = vec![0_i8; 512];
        let ok = unsafe {
            CFStringGetCString(
                value,
                buffer.as_mut_ptr(),
                buffer.len() as isize,
                0x0800_0100,
            )
        };
        unsafe {
            CFRelease(value);
        }
        if ok == 0 {
            return Ok(None);
        }
        let value = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }
            .to_string_lossy()
            .trim()
            .to_string();
        Ok((!value.is_empty()).then_some(value))
    }

    fn read_i32_property(
        object_id: AudioObjectId,
        selector: AudioObjectPropertySelector,
        operation: &'static str,
    ) -> Result<i32, ProbeError> {
        let mut value = 0_i32;
        read_scalar_property(object_id, selector, operation, &mut value)?;
        Ok(value)
    }

    fn read_u32_property(
        object_id: AudioObjectId,
        selector: AudioObjectPropertySelector,
        operation: &'static str,
    ) -> Result<u32, ProbeError> {
        let mut value = 0_u32;
        read_scalar_property(object_id, selector, operation, &mut value)?;
        Ok(value)
    }

    fn read_scalar_property<T>(
        object_id: AudioObjectId,
        selector: AudioObjectPropertySelector,
        operation: &'static str,
        value: &mut T,
    ) -> Result<(), ProbeError> {
        let address = property_address(selector);
        let mut data_size = mem::size_of::<T>() as u32;
        status_result(operation, unsafe {
            AudioObjectGetPropertyData(
                object_id,
                &address,
                0,
                ptr::null(),
                &mut data_size,
                (value as *mut T).cast(),
            )
        })
    }

    fn property_address(selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        property_address_with_scope(selector, AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL)
    }

    fn property_address_with_scope(
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
    ) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            selector,
            scope,
            element: AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        }
    }

    fn status_result(operation: &'static str, status: OsStatus) -> Result<(), ProbeError> {
        if status == 0 {
            Ok(())
        } else {
            Err(ProbeError::new(operation, status))
        }
    }

    const fn four_cc(value: [u8; 4]) -> u32 {
        ((value[0] as u32) << 24)
            | ((value[1] as u32) << 16)
            | ((value[2] as u32) << 8)
            | value[3] as u32
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn four_cc_matches_core_audio_constants() {
            assert_eq!(AUDIO_HARDWARE_PROPERTY_PROCESS_OBJECT_LIST, 0x7072_7323);
            assert_eq!(AUDIO_PROCESS_PROPERTY_PID, 0x7070_6964);
            assert_eq!(AUDIO_PROCESS_PROPERTY_BUNDLE_ID, 0x7062_6964);
            assert_eq!(AUDIO_PROCESS_PROPERTY_DEVICES, 0x7064_7623);
            assert_eq!(AUDIO_PROCESS_PROPERTY_IS_RUNNING_INPUT, 0x7069_7269);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_meeting_start_request_is_retained_until_matching_ack() {
        let state = MeetingStartRequestState::default();
        let request_id = state.queue_at(1_000).expect("queue request");
        let note_id = state
            .peek_at(1_100)
            .expect("peek queued request")
            .expect("queued request")
            .note_id;
        let expected = Some(PendingMeetingStartRequest {
            request_id: request_id.clone(),
            note_id,
            requested_at_ms: 1_000,
            expired: false,
        });

        assert_eq!(state.peek_at(1_100).expect("peek request"), expected);
        assert_eq!(state.peek_at(1_100).expect("peek again"), expected);
        assert!(!state.acknowledge("stale").expect("reject stale ack"));
        assert_eq!(state.peek_at(1_100).expect("peek retained"), expected);
        assert!(state.acknowledge(&request_id).expect("ack request"));
        assert_eq!(state.peek_at(1_100).expect("peek empty request"), None);
    }

    #[test]
    fn newer_queued_action_replaces_the_request_generation() {
        let state = MeetingStartRequestState::default();
        let first_request_id = state.queue_at(1_000).expect("queue first request");
        let second_request_id = state.queue_at(2_000).expect("queue second request");
        let note_id = state
            .peek_at(2_100)
            .expect("peek queued request")
            .expect("queued request")
            .note_id;

        assert_ne!(second_request_id, first_request_id);
        assert_eq!(
            state.peek_at(2_100).expect("peek request"),
            Some(PendingMeetingStartRequest {
                request_id: second_request_id,
                note_id,
                requested_at_ms: 2_000,
                expired: false,
            })
        );
    }

    #[test]
    fn pending_meeting_start_request_expires_on_wall_clock_time() {
        let state = MeetingStartRequestState::default();
        let request_id = state.queue_at(1_000).expect("queue request");
        let note_id = state
            .peek_at(1_000)
            .expect("peek queued request")
            .expect("queued request")
            .note_id;

        assert_eq!(
            state
                .peek_at(1_000 + MEETING_START_REQUEST_TTL_MS + 1)
                .expect("peek stale request"),
            Some(PendingMeetingStartRequest {
                request_id: request_id.clone(),
                note_id,
                requested_at_ms: 1_000,
                expired: true,
            })
        );
        assert_eq!(
            state
                .peek_at(1_000 + MEETING_START_REQUEST_TTL_MS + 1)
                .expect("peek retained stale request")
                .as_ref()
                .map(|request| request.request_id.as_str()),
            Some(request_id.as_str())
        );
    }

    #[test]
    fn finished_meeting_start_outcome_is_replayed_without_restarting() {
        let state = MeetingStartRequestState::default();
        let request_id = state.queue_at(1_000).expect("queue request");
        let note_id = state
            .begin_start(&request_id, 1_100)
            .expect("begin request");
        assert!(!note_id.is_empty());
        assert_eq!(
            state
                .begin_start(&request_id, 1_100)
                .expect_err("starting request cannot begin twice")
                .code,
            "meeting_start_in_progress"
        );

        state
            .finish_start(
                &request_id,
                MeetingStartRecordingOutcome::Failed {
                    error: AppError::new("source_not_ready", "Microphone is not ready."),
                },
            )
            .expect("finish request");
        for _ in 0..2 {
            let Some(MeetingStartRecordingOutcome::Failed { error }) =
                state.finished_outcome(&request_id).expect("read outcome")
            else {
                panic!("expected cached failure");
            };
            assert_eq!(error.code, "source_not_ready");
        }
    }

    #[test]
    fn stale_ack_cannot_clear_a_newer_request() {
        let state = MeetingStartRequestState::default();
        let first_request_id = state.queue_at(1_000).expect("queue first request");
        let second_request_id = state.queue_at(2_000).expect("queue second request");

        assert_ne!(second_request_id, first_request_id);
        assert!(!state
            .acknowledge(&first_request_id)
            .expect("reject stale ack"));
        assert_eq!(
            state
                .peek_at(2_100)
                .expect("peek second request")
                .map(|request| request.request_id),
            Some(second_request_id)
        );
    }

    #[test]
    fn acknowledgement_cannot_clear_a_request_while_native_start_is_running() {
        let state = MeetingStartRequestState::default();
        let request_id = state.queue_at(1_000).expect("queue request");
        state
            .begin_start(&request_id, 1_100)
            .expect("begin request");

        assert!(!state
            .acknowledge(&request_id)
            .expect("reject in-progress acknowledgement"));
        assert_eq!(
            state
                .peek_at(1_200)
                .expect("peek in-progress request")
                .map(|request| request.request_id),
            Some(request_id)
        );
    }

    #[test]
    fn interrupted_native_start_becomes_a_replayable_failure() {
        let state = MeetingStartRequestState::default();
        let request_id = state.queue_at(1_000).expect("queue request");
        state
            .begin_start(&request_id, 1_100)
            .expect("begin request");

        assert!(state
            .fail_start_if_running(&request_id)
            .expect("interrupt request"));
        let Some(MeetingStartRecordingOutcome::Failed { error }) = state
            .finished_outcome(&request_id)
            .expect("read interrupted outcome")
        else {
            panic!("expected replayable interrupted outcome");
        };
        assert_eq!(error.code, "meeting_start_interrupted");
        assert!(!state
            .fail_start_if_running(&request_id)
            .expect("finished request is unchanged"));
    }

    #[test]
    fn starting_action_coalesces_but_finished_action_can_be_replaced() {
        let state = MeetingStartRequestState::default();
        let request_id = state.queue_at(1_000).expect("queue request");
        state
            .begin_start(&request_id, 1_100)
            .expect("begin request");

        assert_eq!(
            state.queue_at(1_200).expect("coalesce starting request"),
            request_id
        );
        state
            .finish_start(
                &request_id,
                MeetingStartRecordingOutcome::Failed {
                    error: AppError::new("source_not_ready", "Microphone is not ready."),
                },
            )
            .expect("finish request");

        assert_ne!(
            state.queue_at(2_000).expect("replace finished request"),
            request_id
        );
    }

    fn input_process(pid: u32, bundle_id: &str) -> MicrophoneInputProcess {
        MicrophoneInputProcess::new(pid, bundle_id.to_string()).expect("valid process")
    }

    fn allowed_pids(processes: &[MicrophoneInputProcess]) -> Vec<u32> {
        active_allowed_external_processes(processes, &BTreeSet::new())
            .into_iter()
            .map(|process| process.pid)
            .collect()
    }

    #[test]
    fn deduped_app_labels_collapses_helper_processes_in_detection_order() {
        let processes = vec![
            input_process(30, "us.zoom.xos"),
            input_process(31, "us.zoom.xos.helper"),
            input_process(32, "com.google.Chrome"),
        ];

        assert_eq!(deduped_app_labels(&processes), vec!["Zoom", "Chrome"]);
        assert!(deduped_app_labels(&[]).is_empty());
    }

    #[test]
    fn active_allowed_external_processes_excludes_owned_processes() {
        let owned = BTreeSet::from([10, 20]);
        let processes = vec![
            MicrophoneInputProcess {
                pid: 0,
                bundle_id: "com.google.Chrome".to_string(),
                app_label: "Chrome".to_string(),
            },
            input_process(10, "com.google.Chrome"),
            input_process(30, "com.google.Chrome"),
            input_process(20, "company.thebrowser.Browser"),
            input_process(40, "company.thebrowser.Browser"),
        ];

        assert_eq!(
            active_allowed_external_processes(&processes, &owned)
                .into_iter()
                .map(|process| process.pid)
                .collect::<Vec<_>>(),
            vec![30, 40]
        );
    }

    #[test]
    fn supported_mic_processes_trigger_detection_filter() {
        let cases = [
            ("ai.perplexity.comet", "ai.perplexity.comet.helper", "Comet"),
            (
                "ai.perplexity.comet.ios",
                "ai.perplexity.comet.ios.helper",
                "Comet",
            ),
            ("Cisco-Systems.Spark", "Cisco-Systems.Spark.helper", "Webex"),
            (
                "com.apple.FaceTime",
                "com.apple.FaceTime.helper",
                "FaceTime",
            ),
            ("com.apple.Safari", "com.apple.Safari.WebContent", "Safari"),
            ("com.brave.Browser", "com.brave.Browser.beta", "Brave"),
            (
                "com.cisco.webexmeetingsapp",
                "com.cisco.webexmeetingsapp.helper",
                "Webex",
            ),
            (
                "com.gather.GatherV2",
                "com.gather.GatherV2.helper",
                "Gather",
            ),
            ("com.google.Chrome", "COM.GOOGLE.CHROME.helper", "Chrome"),
            ("com.hnc.Discord", "com.hnc.Discord.helper", "Discord"),
            (
                "com.microsoft.edgemac",
                "com.microsoft.edgemac.Beta",
                "Edge",
            ),
            ("com.microsoft.teams", "com.microsoft.teams.helper", "Teams"),
            (
                "com.microsoft.teams2",
                "com.microsoft.teams2.helper",
                "Teams",
            ),
            (
                "com.operasoftware.Opera",
                "com.operasoftware.Opera.helper",
                "Opera",
            ),
            (
                "com.tinyspeck.slackmacgap",
                "com.tinyspeck.slackmacgap.helper",
                "Slack",
            ),
            (
                "com.vivaldi.Vivaldi",
                "com.vivaldi.Vivaldi.snapshot",
                "Vivaldi",
            ),
            (
                "company.thebrowser.Browser",
                "company.thebrowser.Browser.helper",
                "Arc",
            ),
            (
                "company.thebrowser.dia",
                "company.thebrowser.dia.helper",
                "Dia",
            ),
            (
                "net.whatsapp.WhatsApp",
                "net.whatsapp.WhatsApp.helper",
                "WhatsApp",
            ),
            (
                "org.mozilla.firefox",
                "org.mozilla.firefox.helper",
                "Firefox",
            ),
            (
                "org.mozilla.firefoxdeveloperedition",
                "org.mozilla.firefoxdeveloperedition.helper",
                "Firefox",
            ),
            (
                "org.mozilla.nightly",
                "org.mozilla.nightly.helper",
                "Firefox",
            ),
            (
                "org.telegram.desktop",
                "org.telegram.desktop.helper",
                "Telegram",
            ),
            (
                "org.whispersystems.signal-desktop",
                "org.whispersystems.signal-desktop.helper",
                "Signal",
            ),
            (
                "ru.keepcoder.Telegram",
                "ru.keepcoder.Telegram.helper",
                "Telegram",
            ),
            ("us.zoom.xos", "us.zoom.xos.helper", "Zoom"),
        ];

        for (index, (exact_bundle_id, helper_bundle_id, label)) in cases.into_iter().enumerate() {
            let exact_pid = 100 + (index as u32 * 2);
            let helper_pid = exact_pid + 1;
            let exact = input_process(exact_pid, exact_bundle_id);
            let helper = input_process(helper_pid, helper_bundle_id);

            assert_eq!(exact.app_label, label, "{exact_bundle_id}");
            assert_eq!(helper.app_label, label, "{helper_bundle_id}");
            assert_eq!(
                allowed_pids(&[exact, helper]),
                vec![exact_pid, helper_pid],
                "{exact_bundle_id}"
            );
        }
    }

    #[test]
    fn unlisted_mic_process_does_not_trigger_detection_filter() {
        assert!(allowed_pids(&[
            input_process(55, "com.apple.PhotoBooth"),
            input_process(56, "com.google.ChromeRemoteDesktop"),
            input_process(57, "com.apple.WebKit.WebContent"),
            input_process(58, "ai.perplexity.cometary"),
            input_process(59, "company.thebrowser.dialog"),
            input_process(60, "com.microsoft.teamsClassic"),
            input_process(61, "net.whatsapp.WhatsAppBusiness"),
            input_process(62, "org.mozilla.firefoxish"),
            input_process(63, "org.whispersystems.signal-desktopx"),
            input_process(64, "com.gather.GatherV20"),
        ])
        .is_empty());
    }

    #[test]
    fn detector_clears_when_allowed_mic_process_becomes_unlisted() {
        let mut state = MeetingDetectionState::default();
        let active_allowed = allowed_pids(&[input_process(60, "com.google.Chrome")]);
        let active_unlisted = allowed_pids(&[input_process(61, "com.apple.PhotoBooth")]);

        assert_eq!(
            state.update(true, !active_allowed.is_empty(), false),
            Some(MeetingDetectionEvent::Detected)
        );
        assert_eq!(state.update(true, !active_unlisted.is_empty(), false), None);
        assert_eq!(
            state.update(true, !active_unlisted.is_empty(), false),
            Some(MeetingDetectionEvent::Cleared)
        );
    }

    #[test]
    fn detector_shows_when_external_input_starts() {
        let mut state = MeetingDetectionState::default();

        assert_eq!(
            state.update(true, true, false),
            Some(MeetingDetectionEvent::Detected)
        );
        assert_eq!(state.update(true, true, false), None);
    }

    #[test]
    fn detector_suppresses_until_user_is_signed_in() {
        let mut state = MeetingDetectionState::default();

        assert_eq!(state.update(false, true, false), None);
        assert_eq!(state.update(false, true, false), None);
        assert_eq!(
            state.update(true, true, false),
            Some(MeetingDetectionEvent::Detected)
        );
    }

    #[test]
    fn detector_clears_immediately_when_user_signs_out() {
        let mut state = MeetingDetectionState::default();

        assert_eq!(
            state.update(true, true, false),
            Some(MeetingDetectionEvent::Detected)
        );
        assert_eq!(
            state.update(false, true, false),
            Some(MeetingDetectionEvent::Cleared)
        );
        assert_eq!(state.update(false, true, false), None);
    }

    #[test]
    fn detector_suppresses_while_os_june_capture_is_active() {
        let mut state = MeetingDetectionState::default();

        assert_eq!(state.update(true, true, true), None);
        assert_eq!(
            state.update(true, true, false),
            Some(MeetingDetectionEvent::Detected)
        );
    }

    #[test]
    fn detector_clears_after_inactive_debounce() {
        let mut state = MeetingDetectionState::default();
        assert_eq!(
            state.update(true, true, false),
            Some(MeetingDetectionEvent::Detected)
        );

        assert_eq!(state.update(true, false, false), None);
        assert_eq!(
            state.update(true, false, false),
            Some(MeetingDetectionEvent::Cleared)
        );
        assert_eq!(state.update(true, false, false), None);
    }

    #[test]
    fn detector_emits_heartbeat_while_active() {
        let mut state = MeetingDetectionState::default();
        assert_eq!(
            state.update(true, true, false),
            Some(MeetingDetectionEvent::Detected)
        );

        for _ in 0..(HEARTBEAT_EVERY_ACTIVE_POLLS - 1) {
            assert_eq!(state.update(true, true, false), None);
        }
        assert_eq!(
            state.update(true, true, false),
            Some(MeetingDetectionEvent::Heartbeat)
        );
    }

    #[test]
    fn detector_clears_when_os_june_capture_starts() {
        let mut state = MeetingDetectionState::default();
        assert_eq!(
            state.update(true, true, false),
            Some(MeetingDetectionEvent::Detected)
        );

        assert_eq!(state.update(true, true, true), None);
        assert_eq!(
            state.update(true, true, true),
            Some(MeetingDetectionEvent::Cleared)
        );
    }
}
