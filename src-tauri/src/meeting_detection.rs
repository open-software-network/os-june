use serde::Serialize;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::thread;
use std::{collections::BTreeSet, time::Duration};
use tauri::{AppHandle, Emitter};

const CLEAR_AFTER_INACTIVE_POLLS: u8 = 2;
const HEARTBEAT_EVERY_ACTIVE_POLLS: u8 = 5;
const POLL_INTERVAL: Duration = Duration::from_secs(1);
const MEETING_DETECTION_EVENT_NAME: &str = "meeting-detection-event";
#[cfg(not(target_os = "windows"))]
const ALLOWED_MIC_APP_BUNDLE_PREFIXES: &[&str] = &[
    "company.thebrowser.Browser",
    "com.google.Chrome",
    "com.apple.Safari",
    "com.microsoft.teams",
    "com.microsoft.teams2",
    "us.zoom.xos",
];

pub fn setup(app: &mut tauri::App) {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    spawn_monitor(app.handle().clone());

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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

// The allow-list and friendly-label lookups are keyed on a platform-specific
// identifier: a bundle id on macOS, an executable name on Windows. Both paths
// feed the same `MicrophoneInputProcess` shape and the same shared filtering,
// so the dispatchers below keep their original names and signatures.

fn is_allowed_microphone_app(identifier: &str) -> bool {
    #[cfg(target_os = "windows")]
    let allowed = is_allowed_windows_microphone_app(identifier);
    #[cfg(not(target_os = "windows"))]
    let allowed = is_allowed_macos_microphone_app(identifier);
    allowed
}

fn app_label_from_bundle_id(identifier: &str) -> String {
    #[cfg(target_os = "windows")]
    let label = windows_app_label_from_executable(identifier);
    #[cfg(not(target_os = "windows"))]
    let label = macos_app_label_from_bundle_id(identifier);
    label
}

// ---- macOS bundle-id matching --------------------------------------------

#[cfg(not(target_os = "windows"))]
fn is_allowed_macos_microphone_app(bundle_id: &str) -> bool {
    ALLOWED_MIC_APP_BUNDLE_PREFIXES
        .iter()
        .any(|prefix| bundle_id_matches_prefix(bundle_id, prefix))
}

#[cfg(not(target_os = "windows"))]
fn bundle_id_matches_prefix(bundle_id: &str, prefix: &str) -> bool {
    let bundle_id = bundle_id.trim().to_ascii_lowercase();
    let prefix = prefix.trim().to_ascii_lowercase();
    bundle_id == prefix
        || bundle_id
            .strip_prefix(&prefix)
            .is_some_and(|suffix| suffix.starts_with('.'))
}

#[cfg(not(target_os = "windows"))]
fn macos_app_label_from_bundle_id(bundle_id: &str) -> String {
    if bundle_id_matches_prefix(bundle_id, "company.thebrowser.Browser") {
        return "Arc".to_string();
    }
    if bundle_id_matches_prefix(bundle_id, "com.google.Chrome") {
        return "Chrome".to_string();
    }
    if bundle_id_matches_prefix(bundle_id, "com.apple.Safari") {
        return "Safari".to_string();
    }
    if bundle_id_matches_prefix(bundle_id, "com.microsoft.teams")
        || bundle_id_matches_prefix(bundle_id, "com.microsoft.teams2")
    {
        return "Teams".to_string();
    }
    if bundle_id_matches_prefix(bundle_id, "us.zoom.xos") {
        return "Zoom".to_string();
    }
    bundle_id
        .rsplit('.')
        .find(|part| !part.trim().is_empty())
        .unwrap_or(bundle_id)
        .to_string()
}

// ---- Windows executable-name matching ------------------------------------

/// Allow-list of Windows meeting apps keyed on lowercase executable names,
/// mapped to the same friendly labels the macOS bundle-id path produces.
/// June's own future WASAPI capture helper is excluded by pid (`owned_pids`),
/// not by name, so it does not belong here.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const ALLOWED_WINDOWS_MIC_APPS: &[(&str, &str)] = &[
    ("ms-teams.exe", "Teams"),
    ("teams.exe", "Teams"),
    ("zoom.exe", "Zoom"),
    ("chrome.exe", "Chrome"),
    ("msedge.exe", "Edge"),
    ("arc.exe", "Arc"),
    ("firefox.exe", "Firefox"),
    ("brave.exe", "Brave"),
];

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn is_allowed_windows_microphone_app(executable: &str) -> bool {
    let executable = executable.trim().to_ascii_lowercase();
    ALLOWED_WINDOWS_MIC_APPS
        .iter()
        .any(|(name, _)| *name == executable)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_app_label_from_executable(executable: &str) -> String {
    let executable = executable.trim();
    let lowercased = executable.to_ascii_lowercase();
    if let Some((_, label)) = ALLOWED_WINDOWS_MIC_APPS
        .iter()
        .find(|(name, _)| *name == lowercased)
    {
        return (*label).to_string();
    }
    // Unlisted apps are dropped by the allow-list, so this label only surfaces
    // defensively. Strip a trailing ".exe" (case-insensitively) so it reads as
    // an app name rather than a file.
    let stem = if lowercased.ends_with(".exe") {
        &executable[..executable.len() - ".exe".len()]
    } else {
        executable
    };
    if stem.is_empty() {
        executable.to_string()
    } else {
        stem.to_string()
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn spawn_monitor(app: AppHandle) {
    thread::spawn(move || {
        let mut state = MeetingDetectionState::default();
        let mut warned_after_probe_error = false;

        loop {
            thread::sleep(POLL_INTERVAL);

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
    // Only the macOS branch mutates `pids` today; keep `mut` warning-free where
    // no helper pid is inserted.
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut pids = BTreeSet::from([std::process::id()]);
    // macOS spawns a dictation helper that also holds the microphone; exclude
    // it so June's own capture never looks like an external meeting. Windows
    // has no such helper yet, so its owned set is just this process. When a
    // Windows capture helper lands, insert its pid here under a windows cfg.
    #[cfg(target_os = "macos")]
    if let Some(helper_pid) = crate::dictation::dictation_helper_pid(app) {
        pids.insert(helper_pid);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
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

#[cfg(target_os = "windows")]
pub(crate) use windows::active_input_processes;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
        // `status` carries an OSStatus on macOS and an HRESULT on Windows;
        // both are 32-bit and read fine as a signed decimal in the log line.
        write!(
            formatter,
            "{} failed with status {}",
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

#[cfg(target_os = "windows")]
mod windows {
    use super::{MicrophoneInputProcess, ProbeError};
    use std::cell::Cell;
    use std::collections::BTreeSet;

    use ::windows::core::Interface;
    use ::windows::Win32::Foundation::CloseHandle;
    use ::windows::Win32::Media::Audio::{
        eCapture, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
        IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use ::windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use ::windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    thread_local! {
        // COM must be initialised once per thread before any WASAPI call. The
        // monitor owns a single long-lived polling thread, so we join the MTA on
        // the first probe and never uninitialise (the thread outlives the app).
        static COM_READY: Cell<bool> = const { Cell::new(false) };
    }

    fn ensure_com_initialized() {
        COM_READY.with(|ready| {
            if ready.get() {
                return;
            }
            // SAFETY: CoInitializeEx with a null reserved pointer is the
            // documented way to join an apartment. If the thread were already an
            // STA this returns RPC_E_CHANGED_MODE; we proceed regardless because
            // COM stays usable in whichever mode won and the objects below are
            // apartment-neutral. The polling thread is fresh, so MTA wins.
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            ready.set(true);
        });
    }

    pub(crate) fn active_input_processes() -> Result<Vec<MicrophoneInputProcess>, ProbeError> {
        ensure_com_initialized();

        // Dedupe pids across endpoints: one app capturing from a headset mic and
        // a webcam mic shows up as two sessions on two endpoints, but is one app.
        let mut pids: BTreeSet<u32> = BTreeSet::new();

        // SAFETY: every interface below comes from a checked COM call and lives
        // only within this scope; the `windows` crate ref-counts the pointers.
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(|error| probe(error, "create device enumerator"))?;

            // Enumerate ALL active capture endpoints, not just the default: a
            // meeting app may bind to any microphone the machine exposes.
            let endpoints = enumerator
                .EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)
                .map_err(|error| probe(error, "enumerate capture endpoints"))?;
            let endpoint_count = endpoints
                .GetCount()
                .map_err(|error| probe(error, "count capture endpoints"))?;

            for endpoint_index in 0..endpoint_count {
                let Ok(device) = endpoints.Item(endpoint_index) else {
                    continue;
                };
                let Ok(session_manager) =
                    device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None)
                else {
                    continue;
                };
                let Ok(sessions) = session_manager.GetSessionEnumerator() else {
                    continue;
                };
                let session_count = sessions.GetCount().unwrap_or(0);
                for session_index in 0..session_count {
                    let Ok(control) = sessions.GetSession(session_index) else {
                        continue;
                    };
                    let Ok(control) = control.cast::<IAudioSessionControl2>() else {
                        continue;
                    };
                    // Only sessions still actively capturing count. Sessions can
                    // linger Active briefly after capture stops, and idle apps
                    // keep Inactive sessions open; both would be false positives,
                    // so require exactly AudioSessionStateActive.
                    if !matches!(control.GetState(), Ok(state) if state == AudioSessionStateActive)
                    {
                        continue;
                    }
                    let Ok(pid) = control.GetProcessId() else {
                        continue;
                    };
                    // pid 0 is the shared system-sounds pseudo-session; skip it.
                    if pid != 0 {
                        pids.insert(pid);
                    }
                }
            }
        }

        let mut processes = Vec::new();
        for pid in pids {
            if let Some(executable) = process_executable_name(pid) {
                if let Some(process) = MicrophoneInputProcess::new(pid, executable) {
                    processes.push(process);
                }
            }
        }
        processes.sort_by_key(|process| process.pid);
        Ok(processes)
    }

    fn probe(error: ::windows::core::Error, operation: &'static str) -> ProbeError {
        ProbeError::new(operation, error.code().0)
    }

    /// Resolve a pid to its executable file name (e.g. `Zoom.exe`). Uses the
    /// limited-information access right so it succeeds across sessions and
    /// elevation levels where full query access would be denied.
    fn process_executable_name(pid: u32) -> Option<String> {
        // SAFETY: the process handle is closed on every return path, and
        // QueryFullProcessImageNameW writes into `buffer` and reports the
        // character count it produced back through `size`.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buffer = [0u16; 260];
            let mut size = buffer.len() as u32;
            let query = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                ::windows::core::PWSTR(buffer.as_mut_ptr()),
                &mut size,
            );
            let _ = CloseHandle(handle);
            query.ok()?;

            let full_path = String::from_utf16_lossy(&buffer[..size as usize]);
            let file_name = full_path
                .rsplit(['\\', '/'])
                .next()
                .unwrap_or(&full_path)
                .trim();
            (!file_name.is_empty()).then(|| file_name.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn chrome_mic_process_triggers_detection_filter() {
        let exact = input_process(30, "com.google.Chrome");
        let helper = input_process(31, "COM.GOOGLE.CHROME.helper");

        assert_eq!(exact.app_label, "Chrome");
        assert_eq!(helper.app_label, "Chrome");
        assert_eq!(allowed_pids(&[exact, helper]), vec![30, 31]);
    }

    #[test]
    fn arc_mic_process_triggers_detection_filter() {
        let exact = input_process(40, "company.thebrowser.Browser");
        let helper = input_process(41, "company.thebrowser.Browser.helper");

        assert_eq!(exact.app_label, "Arc");
        assert_eq!(helper.app_label, "Arc");
        assert_eq!(allowed_pids(&[exact, helper]), vec![40, 41]);
    }

    #[test]
    fn safari_mic_process_triggers_detection_filter() {
        let exact = input_process(42, "com.apple.Safari");
        let helper = input_process(43, "com.apple.Safari.WebContent");

        assert_eq!(exact.app_label, "Safari");
        assert_eq!(helper.app_label, "Safari");
        assert_eq!(allowed_pids(&[exact, helper]), vec![42, 43]);
    }

    #[test]
    fn teams_mic_process_triggers_detection_filter() {
        let classic = input_process(44, "com.microsoft.teams");
        let classic_helper = input_process(45, "com.microsoft.teams.helper");
        let modern = input_process(46, "com.microsoft.teams2");
        let modern_helper = input_process(47, "com.microsoft.teams2.helper");

        assert_eq!(classic.app_label, "Teams");
        assert_eq!(classic_helper.app_label, "Teams");
        assert_eq!(modern.app_label, "Teams");
        assert_eq!(modern_helper.app_label, "Teams");
        assert_eq!(
            allowed_pids(&[classic, classic_helper, modern, modern_helper]),
            vec![44, 45, 46, 47]
        );
    }

    #[test]
    fn zoom_mic_process_triggers_detection_filter() {
        let exact = input_process(48, "us.zoom.xos");
        let helper = input_process(49, "us.zoom.xos.helper");

        assert_eq!(exact.app_label, "Zoom");
        assert_eq!(helper.app_label, "Zoom");
        assert_eq!(allowed_pids(&[exact, helper]), vec![48, 49]);
    }

    #[test]
    fn unlisted_mic_process_does_not_trigger_detection_filter() {
        assert!(allowed_pids(&[
            input_process(51, "com.apple.FaceTime"),
            input_process(52, "com.google.ChromeRemoteDesktop"),
            input_process(53, "com.apple.WebKit.WebContent"),
        ])
        .is_empty());
    }

    #[test]
    fn windows_allow_list_matches_meeting_executables_case_insensitively() {
        for (executable, label) in [
            ("Zoom.exe", "Zoom"),
            ("zoom.exe", "Zoom"),
            ("ms-teams.exe", "Teams"),
            ("Teams.exe", "Teams"),
            ("chrome.exe", "Chrome"),
            ("MSEDGE.EXE", "Edge"),
            ("Arc.exe", "Arc"),
            ("firefox.exe", "Firefox"),
            ("brave.exe", "Brave"),
        ] {
            assert!(
                is_allowed_windows_microphone_app(executable),
                "{executable} should be allowed"
            );
            assert_eq!(windows_app_label_from_executable(executable), label);
        }
    }

    #[test]
    fn windows_allow_list_rejects_unlisted_executables() {
        for executable in ["notepad.exe", "explorer.exe", "obs64.exe", ""] {
            assert!(
                !is_allowed_windows_microphone_app(executable),
                "{executable} should not be allowed"
            );
        }
        // Unlisted apps still get a sensible fallback label with the ".exe" tail
        // stripped, even though the allow-list drops them before it is shown.
        assert_eq!(windows_app_label_from_executable("notepad.exe"), "notepad");
        assert_eq!(windows_app_label_from_executable("weird"), "weird");
        assert_eq!(windows_app_label_from_executable(".exe"), ".exe");
    }

    #[test]
    fn windows_allow_list_ignores_surrounding_whitespace() {
        assert!(is_allowed_windows_microphone_app("  Zoom.exe  "));
        assert_eq!(windows_app_label_from_executable("  Zoom.exe  "), "Zoom");
    }

    #[test]
    fn detector_clears_when_allowed_mic_process_becomes_unlisted() {
        let mut state = MeetingDetectionState::default();
        let active_allowed = allowed_pids(&[input_process(60, "com.google.Chrome")]);
        let active_unlisted = allowed_pids(&[input_process(61, "com.apple.FaceTime")]);

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
