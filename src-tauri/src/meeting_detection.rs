use crate::{
    audio::capture::has_active_recording,
    commands::{recording_source_readiness, repositories, start_recording_for_note},
    domain::types::{
        AppError, NoteDto, RecordingSessionDto, RecordingSourceMode, RecordingSourceReadinessDto,
    },
};
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow};

const STABILITY_POLLS: u8 = 2;
const MEETING_HUD_WIDTH: u32 = 384;
const MEETING_HUD_HEIGHT: u32 = 112;
const COMPACT_HUD_WIDTH: u32 = 220;
const COMPACT_HUD_HEIGHT: u32 = 120;
const MEETING_TOP_MARGIN: i32 = 12;

pub struct MeetingDetectionState {
    process: Mutex<Option<MeetingDetectorProcess>>,
    engine: Mutex<MeetingDetectionEngine>,
    latest_event: Mutex<Option<MeetingDetectionEvent>>,
}

pub struct MeetingDetectorProcess {
    child: Child,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDetectionEvent {
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<MeetingDetectionPayload>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDetectionPayload {
    pub detection_id: String,
    pub app_name: String,
    pub bundle_id: String,
    pub pid: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperEvent {
    r#type: String,
    #[serde(default)]
    payload: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotPayload {
    processes: Vec<ProcessSnapshot>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessSnapshot {
    pid: i32,
    bundle_id: Option<String>,
    app_name: Option<String>,
    is_running_input: bool,
    is_foreground: bool,
    accessibility_trusted: bool,
    window_title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MeetingCandidate {
    session_key: String,
    detection_id: String,
    pid: i32,
    bundle_id: String,
    app_name: String,
    window_title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum EngineEvent {
    Detected(MeetingCandidate),
    Ended(MeetingCandidate),
}

#[derive(Debug, Default)]
struct MeetingDetectionEngine {
    stable_key: Option<String>,
    stable_count: u8,
    active: Option<MeetingCandidate>,
    snoozed_sessions: HashSet<String>,
    sequence: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRecordingStartedResponse {
    pub note: NoteDto,
    pub recording: RecordingSessionDto,
}

pub fn setup(app: &mut tauri::App) {
    let process = spawn_helper(app.handle()).ok();
    app.manage(MeetingDetectionState {
        process: Mutex::new(process),
        engine: Mutex::new(MeetingDetectionEngine::default()),
        latest_event: Mutex::new(None),
    });
}

pub fn stop_helper(app: &AppHandle) {
    let Some(state) = app.try_state::<MeetingDetectionState>() else {
        return;
    };
    let Ok(mut guard) = state.process.lock() else {
        return;
    };
    let Some(mut process) = guard.take() else {
        return;
    };
    let _ = process.child.kill();
    let _ = process.child.wait();
}

#[tauri::command]
pub fn latest_meeting_detection_event(
    state: State<'_, MeetingDetectionState>,
) -> Option<MeetingDetectionEvent> {
    state
        .latest_event
        .lock()
        .ok()
        .and_then(|event| event.clone())
}

#[tauri::command]
pub fn dismiss_detected_meeting(
    app: AppHandle,
    state: State<'_, MeetingDetectionState>,
    detection_id: String,
) -> Result<(), AppError> {
    let dismissed = state
        .engine
        .lock()
        .map_err(|_| {
            AppError::new(
                "meeting_detection_unavailable",
                "Meeting detection lock failed.",
            )
        })?
        .dismiss(&detection_id);
    if dismissed {
        if let Ok(mut latest) = state.latest_event.lock() {
            *latest = None;
        }
        let _ = app.emit(
            "meeting-detection-event",
            MeetingDetectionEvent {
                r#type: "dismissed".to_string(),
                payload: None,
            },
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn start_detected_meeting_recording(
    app: AppHandle,
    state: State<'_, MeetingDetectionState>,
    detection_id: String,
) -> Result<MeetingRecordingStartedResponse, AppError> {
    let candidate = state
        .engine
        .lock()
        .map_err(|_| {
            AppError::new(
                "meeting_detection_unavailable",
                "Meeting detection lock failed.",
            )
        })?
        .active_for_detection(&detection_id)
        .ok_or_else(|| {
            AppError::new(
                "meeting_detection_stale",
                "This meeting prompt is no longer active.",
            )
        })?;

    let readiness = recording_source_readiness(RecordingSourceMode::MicrophonePlusSystem);
    if !readiness.ready {
        let error = readiness_error(&readiness);
        emit_meeting_error(&app, &candidate, &error);
        return Err(error);
    }

    let repos = repositories(&app).await?;
    let note = repos
        .create_note(None)
        .await
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?;
    let title = detected_meeting_title(&candidate.app_name);
    let note = repos
        .update_note(&note.id, Some(title), None, None)
        .await
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?;

    let recording = match start_recording_for_note(
        &app,
        note.id.clone(),
        RecordingSourceMode::MicrophonePlusSystem,
    )
    .await
    {
        Ok(recording) => recording,
        Err(error) => {
            emit_meeting_error(&app, &candidate, &error);
            return Err(error);
        }
    };
    let note = repos.get_note(&note.id).await?;
    let response = MeetingRecordingStartedResponse { note, recording };
    if let Ok(mut latest) = state.latest_event.lock() {
        *latest = None;
    }
    let _ = app.emit("meeting-recording-started", &response);
    let _ = app.emit(
        "meeting-detection-event",
        MeetingDetectionEvent {
            r#type: "started".to_string(),
            payload: None,
        },
    );
    Ok(response)
}

#[tauri::command]
pub fn meeting_detection_hud_prepare_prompt(app: AppHandle) -> Result<(), AppError> {
    let Some(hud) = app.get_webview_window("hud") else {
        return Ok(());
    };
    hud.set_size(PhysicalSize::new(MEETING_HUD_WIDTH, MEETING_HUD_HEIGHT))
        .map_err(|error| AppError::new("hud_update_failed", error.to_string()))?;
    position_hud_top_center(&hud);
    let _ = hud.set_focusable(true);
    let _ = hud.set_ignore_cursor_events(false);
    Ok(())
}

#[tauri::command]
pub fn meeting_detection_hud_restore_compact(app: AppHandle) -> Result<(), AppError> {
    let Some(hud) = app.get_webview_window("hud") else {
        return Ok(());
    };
    hud.set_size(PhysicalSize::new(COMPACT_HUD_WIDTH, COMPACT_HUD_HEIGHT))
        .map_err(|error| AppError::new("hud_update_failed", error.to_string()))?;
    let _ = hud.set_focusable(false);
    let _ = hud.set_ignore_cursor_events(true);
    Ok(())
}

fn readiness_error(readiness: &RecordingSourceReadinessDto) -> AppError {
    let message = readiness
        .sources
        .iter()
        .find(|source| source.required && !source.ready)
        .and_then(|source| source.message.clone())
        .unwrap_or_else(|| "Microphone plus system audio is not ready.".to_string());
    AppError::new("source_not_ready", message)
}

fn emit_meeting_error(app: &AppHandle, candidate: &MeetingCandidate, error: &AppError) {
    let payload = MeetingDetectionPayload {
        detection_id: candidate.detection_id.clone(),
        app_name: candidate.app_name.clone(),
        bundle_id: candidate.bundle_id.clone(),
        pid: candidate.pid,
        window_title: candidate.window_title.clone(),
        message: Some(error.message.clone()),
        code: Some(error.code.clone()),
    };
    let event = MeetingDetectionEvent {
        r#type: "error".to_string(),
        payload: Some(payload),
    };
    let _ = app.emit("meeting-detection-event", &event);
    let _ = app.emit("meeting-detection-error", error);
}

fn detected_meeting_title(app_name: &str) -> String {
    format!(
        "{} meeting - {}",
        app_name.trim().if_empty("Meeting"),
        Local::now().format("%b %-d, %Y %H:%M")
    )
}

trait IfEmpty {
    fn if_empty<'a>(&'a self, fallback: &'a str) -> &'a str;
}

impl IfEmpty for str {
    fn if_empty<'a>(&'a self, fallback: &'a str) -> &'a str {
        if self.is_empty() {
            fallback
        } else {
            self
        }
    }
}

fn helper_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let manifest_dir = PathBuf::from(manifest_dir);
        if let Some(repo_dir) = manifest_dir.parent() {
            paths.push(
                repo_dir
                    .join(".tauri-helper")
                    .join("OS Scribe Meeting Detector.app")
                    .join("Contents")
                    .join("MacOS")
                    .join("os-scribe-meeting-detector"),
            );
        }
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            paths.push(exe_dir.join("os-scribe-meeting-detector"));
            paths.push(exe_dir.join("../Resources/os-scribe-meeting-detector"));
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        paths.push(resource_dir.join("os-scribe-meeting-detector"));
        paths.push(
            resource_dir
                .join("native")
                .join("bin")
                .join("OS Scribe Meeting Detector.app")
                .join("Contents")
                .join("MacOS")
                .join("os-scribe-meeting-detector"),
        );
    }
    paths
}

fn spawn_helper(app: &AppHandle) -> Result<MeetingDetectorProcess, AppError> {
    let helper_path = helper_candidates(app)
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| {
            AppError::new(
                "meeting_detector_missing",
                "Could not find bundled meeting detector helper binary.",
            )
        })?;
    let mut child = Command::new(&helper_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            AppError::new(
                "meeting_detector_start_failed",
                format!(
                    "Failed to start helper at {}: {error}",
                    helper_path.display()
                ),
            )
        })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        AppError::new(
            "meeting_detector_start_failed",
            "Meeting detector stdout was unavailable.",
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        AppError::new(
            "meeting_detector_start_failed",
            "Meeting detector stderr was unavailable.",
        )
    })?;
    let output_app = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            handle_helper_line(&output_app, &line);
        }
    });
    let error_app = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let _ = error_app.emit("meeting-detector-stderr", line);
        }
    });
    Ok(MeetingDetectorProcess { child })
}

fn handle_helper_line(app: &AppHandle, line: &str) {
    let Ok(event) = serde_json::from_str::<HelperEvent>(line) else {
        return;
    };
    match event.r#type.as_str() {
        "snapshot" => {
            let Ok(snapshot) = serde_json::from_value::<SnapshotPayload>(event.payload) else {
                return;
            };
            handle_snapshot(app, snapshot.processes);
        }
        "error" => {
            let message = event
                .payload
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Meeting detection failed.")
                .to_string();
            let error = AppError::new("meeting_detection_failed", message);
            let _ = app.emit("meeting-detection-error", &error);
        }
        _ => {}
    }
}

fn handle_snapshot(app: &AppHandle, processes: Vec<ProcessSnapshot>) {
    let Some(state) = app.try_state::<MeetingDetectionState>() else {
        return;
    };
    let engine_event = state
        .engine
        .lock()
        .ok()
        .and_then(|mut engine| engine.ingest(processes, has_active_recording()));
    let Some(engine_event) = engine_event else {
        return;
    };
    match engine_event {
        EngineEvent::Detected(candidate) => {
            let event = event_for_candidate("detected", candidate);
            if let Ok(mut latest) = state.latest_event.lock() {
                *latest = Some(event.clone());
            }
            let _ = app.emit("meeting-detection-event", event);
        }
        EngineEvent::Ended(candidate) => {
            if let Ok(mut latest) = state.latest_event.lock() {
                if latest
                    .as_ref()
                    .and_then(|event| event.payload.as_ref())
                    .map(|payload| payload.detection_id.as_str())
                    == Some(candidate.detection_id.as_str())
                {
                    *latest = None;
                }
            }
            let _ = app.emit(
                "meeting-detection-event",
                event_for_candidate("ended", candidate),
            );
        }
    }
}

fn event_for_candidate(event_type: &str, candidate: MeetingCandidate) -> MeetingDetectionEvent {
    MeetingDetectionEvent {
        r#type: event_type.to_string(),
        payload: Some(MeetingDetectionPayload {
            detection_id: candidate.detection_id,
            app_name: candidate.app_name,
            bundle_id: candidate.bundle_id,
            pid: candidate.pid,
            window_title: candidate.window_title,
            message: None,
            code: None,
        }),
    }
}

fn position_hud_top_center(hud: &WebviewWindow) {
    let monitor = hud
        .cursor_position()
        .ok()
        .and_then(|cursor| hud.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| hud.current_monitor().ok().flatten())
        .or_else(|| hud.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let work = monitor.work_area();
    let x = work.position.x + (work.size.width as i32 - MEETING_HUD_WIDTH as i32) / 2;
    let y = work.position.y + MEETING_TOP_MARGIN;
    let _ = hud.set_position(PhysicalPosition::new(x, y));
}

impl MeetingDetectionEngine {
    fn ingest(
        &mut self,
        processes: Vec<ProcessSnapshot>,
        recording_active: bool,
    ) -> Option<EngineEvent> {
        let active_session_keys = processes
            .iter()
            .filter(|process| process.is_running_input)
            .filter_map(session_key_for_snapshot)
            .collect::<HashSet<_>>();
        self.snoozed_sessions
            .retain(|session| active_session_keys.contains(session));

        let candidate = if recording_active {
            None
        } else {
            select_candidate(&processes).map(|candidate| self.assign_detection_id(candidate))
        };

        if let Some(active) = self.active.as_ref() {
            if candidate
                .as_ref()
                .map(|candidate| candidate.session_key.as_str())
                == Some(active.session_key.as_str())
            {
                return None;
            }
            let ended = self.active.take().expect("active candidate existed");
            self.stable_key = candidate
                .as_ref()
                .map(|candidate| candidate.session_key.clone());
            self.stable_count = u8::from(candidate.is_some());
            return Some(EngineEvent::Ended(ended));
        }

        let Some(candidate) = candidate else {
            self.stable_key = None;
            self.stable_count = 0;
            return None;
        };
        if self.snoozed_sessions.contains(&candidate.session_key) {
            self.stable_key = Some(candidate.session_key);
            self.stable_count = 0;
            return None;
        }
        if self.stable_key.as_deref() == Some(candidate.session_key.as_str()) {
            self.stable_count = self.stable_count.saturating_add(1);
        } else {
            self.stable_key = Some(candidate.session_key.clone());
            self.stable_count = 1;
        }
        if self.stable_count < STABILITY_POLLS {
            return None;
        }
        self.active = Some(candidate.clone());
        Some(EngineEvent::Detected(candidate))
    }

    fn assign_detection_id(&mut self, mut candidate: MeetingCandidate) -> MeetingCandidate {
        if candidate.detection_id.is_empty() {
            self.sequence = self.sequence.saturating_add(1);
            candidate.detection_id = format!("meeting-{}-{}", candidate.pid, self.sequence);
        }
        candidate
    }

    fn dismiss(&mut self, detection_id: &str) -> bool {
        let Some(active) = self.active.as_mut() else {
            return false;
        };
        if active.detection_id != detection_id {
            return false;
        }
        self.snoozed_sessions.insert(active.session_key.clone());
        true
    }

    fn active_for_detection(&self, detection_id: &str) -> Option<MeetingCandidate> {
        self.active
            .as_ref()
            .filter(|candidate| candidate.detection_id == detection_id)
            .filter(|candidate| !self.snoozed_sessions.contains(&candidate.session_key))
            .cloned()
    }
}

fn select_candidate(processes: &[ProcessSnapshot]) -> Option<MeetingCandidate> {
    let mut candidates = processes
        .iter()
        .filter(|process| process.is_running_input)
        .filter_map(candidate_from_snapshot)
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .app_name
            .cmp(&left.app_name)
            .then_with(|| left.pid.cmp(&right.pid))
    });
    candidates.into_iter().next()
}

fn candidate_from_snapshot(snapshot: &ProcessSnapshot) -> Option<MeetingCandidate> {
    let bundle_id = snapshot.bundle_id.as_deref()?.trim();
    if should_ignore_bundle(bundle_id) {
        return None;
    }
    let app_name = snapshot
        .app_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Meeting app");
    if is_browser_bundle(bundle_id) {
        if !snapshot.is_foreground || !snapshot.accessibility_trusted {
            return None;
        }
        let title = snapshot.window_title.as_deref()?.trim();
        if !meeting_title_like(title) {
            return None;
        }
    } else if !is_meeting_bundle(bundle_id) {
        return None;
    }
    Some(MeetingCandidate {
        session_key: session_key(snapshot.pid, bundle_id),
        detection_id: String::new(),
        pid: snapshot.pid,
        bundle_id: bundle_id.to_string(),
        app_name: app_name.to_string(),
        window_title: snapshot.window_title.clone(),
    })
}

fn session_key_for_snapshot(snapshot: &ProcessSnapshot) -> Option<String> {
    snapshot
        .bundle_id
        .as_deref()
        .map(str::trim)
        .filter(|bundle_id| !bundle_id.is_empty())
        .map(|bundle_id| session_key(snapshot.pid, bundle_id))
}

fn session_key(pid: i32, bundle_id: &str) -> String {
    format!("{pid}:{}", bundle_id.to_ascii_lowercase())
}

fn should_ignore_bundle(bundle_id: &str) -> bool {
    let normalized = bundle_id.to_ascii_lowercase();
    normalized.starts_with("network.opensoftware.os-notetaker")
        || normalized.starts_with("network.opensoftware.os-scribe")
}

fn is_browser_bundle(bundle_id: &str) -> bool {
    matches!(
        bundle_id,
        "com.google.Chrome"
            | "com.google.Chrome.canary"
            | "org.chromium.Chromium"
            | "com.brave.Browser"
            | "com.microsoft.edgemac"
            | "com.apple.Safari"
            | "com.apple.SafariTechnologyPreview"
            | "com.operasoftware.Opera"
            | "company.thebrowser.Browser"
    )
}

fn is_meeting_bundle(bundle_id: &str) -> bool {
    matches!(
        bundle_id,
        "us.zoom.xos"
            | "com.microsoft.teams"
            | "com.microsoft.teams2"
            | "com.microsoft.Teams"
            | "com.tinyspeck.slackmacgap"
            | "com.apple.FaceTime"
            | "com.hnc.Discord"
            | "com.hnc.DiscordPTB"
            | "com.hnc.DiscordCanary"
            | "net.whatsapp.WhatsApp"
            | "com.facebook.archon"
    )
}

fn meeting_title_like(title: &str) -> bool {
    let normalized = title.to_ascii_lowercase();
    [
        "google meet",
        "meet.google",
        "zoom meeting",
        "zoom webinar",
        "microsoft teams",
        "teams meeting",
        "whereby",
        "webex",
        "jitsi",
        "around",
        "slack huddle",
        "discord",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(bundle_id: &str) -> ProcessSnapshot {
        ProcessSnapshot {
            pid: 42,
            bundle_id: Some(bundle_id.to_string()),
            app_name: Some("Zoom".to_string()),
            is_running_input: true,
            is_foreground: false,
            accessibility_trusted: false,
            window_title: None,
        }
    }

    #[test]
    fn known_meeting_app_requires_stability_threshold() {
        let mut engine = MeetingDetectionEngine::default();
        let first = engine.ingest(vec![process("us.zoom.xos")], false);
        assert!(first.is_none());
        let second = engine.ingest(vec![process("us.zoom.xos")], false);
        assert!(matches!(second, Some(EngineEvent::Detected(_))));
    }

    #[test]
    fn unknown_mic_app_does_not_trigger() {
        let mut engine = MeetingDetectionEngine::default();
        engine.ingest(vec![process("com.apple.VoiceMemos")], false);
        let event = engine.ingest(vec![process("com.apple.VoiceMemos")], false);
        assert!(event.is_none());
    }

    #[test]
    fn dismissed_session_does_not_retrigger_until_input_stops() {
        let mut engine = MeetingDetectionEngine::default();
        engine.ingest(vec![process("us.zoom.xos")], false);
        let Some(EngineEvent::Detected(candidate)) =
            engine.ingest(vec![process("us.zoom.xos")], false)
        else {
            panic!("expected detection");
        };
        assert!(engine.dismiss(&candidate.detection_id));
        let event = engine.ingest(vec![process("us.zoom.xos")], false);
        assert!(event.is_none());
        engine.ingest(Vec::new(), false);
        engine.ingest(vec![process("us.zoom.xos")], false);
        let event = engine.ingest(vec![process("us.zoom.xos")], false);
        assert!(matches!(event, Some(EngineEvent::Detected(_))));
    }

    #[test]
    fn browser_requires_foreground_and_meeting_title_when_accessible() {
        let mut snapshot = process("com.google.Chrome");
        snapshot.app_name = Some("Chrome".to_string());
        snapshot.is_foreground = true;
        snapshot.accessibility_trusted = true;
        snapshot.window_title = Some("Weekly sync - Google Meet".to_string());
        assert!(candidate_from_snapshot(&snapshot).is_some());

        snapshot.is_foreground = false;
        assert!(candidate_from_snapshot(&snapshot).is_none());
        snapshot.is_foreground = true;
        snapshot.window_title = Some("Inbox".to_string());
        assert!(candidate_from_snapshot(&snapshot).is_none());
    }

    #[test]
    fn browser_is_skipped_without_accessibility() {
        let mut snapshot = process("com.apple.Safari");
        snapshot.is_foreground = true;
        snapshot.accessibility_trusted = false;
        snapshot.window_title = Some("Google Meet".to_string());
        assert!(candidate_from_snapshot(&snapshot).is_none());
    }

    #[test]
    fn active_recording_suppresses_prompt() {
        let mut engine = MeetingDetectionEngine::default();
        engine.ingest(vec![process("us.zoom.xos")], true);
        let event = engine.ingest(vec![process("us.zoom.xos")], true);
        assert!(event.is_none());
    }
}
