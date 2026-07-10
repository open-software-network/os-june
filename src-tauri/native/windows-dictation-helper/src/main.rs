mod audio;
mod clipboard;
mod focus;
mod hotkeys;
mod permissions;
mod protocol;

use audio::Recorder;
use focus::PinnedTarget;
use hotkeys::{HotkeyEvent, HotkeyManager};
use permissions::ComApartment;
use protocol::{error_event, event, simple_event, CommandEnvelope, ShortcutKind};
use std::{
    io::{self, BufRead, Write},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

#[derive(Clone)]
struct EventWriter {
    inner: Arc<Mutex<io::Stdout>>,
}

impl EventWriter {
    fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(io::stdout())),
        }
    }

    fn emit(&self, value: serde_json::Value) {
        if let Ok(mut stdout) = self.inner.lock() {
            let _ = serde_json::to_writer(&mut *stdout, &value);
            let _ = stdout.write_all(b"\n");
            let _ = stdout.flush();
        }
    }
}

struct HelperApp {
    writer: EventWriter,
    recorder: Option<Recorder>,
    selected_microphone_id: Option<String>,
    pinned_target: Option<PinnedTarget>,
    hotkeys: Option<HotkeyManager>,
}

impl HelperApp {
    fn new(writer: EventWriter) -> Self {
        let hotkey_writer = writer.clone();
        let hotkeys = HotkeyManager::start(Box::new(move |hotkey| {
            let event = match hotkey {
                HotkeyEvent::KeyDown { kind, shortcut } => event(
                    "shortcut_key_down",
                    serde_json::json!({ "kind": kind, "shortcut": shortcut }),
                ),
                HotkeyEvent::KeyUp { kind, shortcut } => event(
                    "shortcut_key_up",
                    serde_json::json!({ "kind": kind, "shortcut": shortcut }),
                ),
                HotkeyEvent::Ready {
                    push_to_talk_shortcut,
                    toggle_shortcut,
                } => event(
                    "hotkey_trigger_ready",
                    serde_json::json!({
                        "shortcut": push_to_talk_shortcut,
                        "pushToTalkShortcut": push_to_talk_shortcut,
                        "toggleShortcut": toggle_shortcut,
                        "shortcuts": format!(
                            "Push to talk: {push_to_talk_shortcut}; Toggle: {toggle_shortcut}"
                        ),
                    }),
                ),
                HotkeyEvent::RegistrationFailed {
                    kind,
                    shortcut,
                    code,
                    message,
                } => event(
                    "hotkey_trigger_unavailable",
                    serde_json::json!({
                        "kind": kind,
                        "shortcut": shortcut,
                        "code": code,
                        "message": message,
                    }),
                ),
                HotkeyEvent::CaptureStarted { kind } => event(
                    "shortcut_capture_started",
                    serde_json::json!({ "kind": kind }),
                ),
                HotkeyEvent::CaptureCancelled { kind } => event(
                    "shortcut_capture_cancelled",
                    serde_json::json!({ "kind": kind }),
                ),
                HotkeyEvent::CaptureError {
                    kind,
                    code,
                    message,
                } => event(
                    "shortcut_capture_error",
                    serde_json::json!({ "kind": kind, "code": code, "message": message }),
                ),
                HotkeyEvent::Captured { kind, shortcut } => event(
                    "shortcut_captured",
                    serde_json::json!({ "kind": kind, "shortcut": shortcut }),
                ),
            };
            hotkey_writer.emit(event);
        }));
        Self {
            writer,
            recorder: None,
            selected_microphone_id: None,
            pinned_target: None,
            hotkeys,
        }
    }

    fn handle_command(&mut self, command: CommandEnvelope) -> bool {
        match command.command_type.as_str() {
            "ping" => self.writer.emit(simple_event("pong")),
            "get_permission_status"
            | "request_microphone_permission"
            | "request_accessibility_permission" => {
                let microphone = audio::microphone_permission_status();
                if command.command_type == "request_microphone_permission"
                    && microphone != "granted"
                {
                    open_microphone_settings();
                }
                self.emit_permission_status();
            }
            "list_microphones" => self.emit_microphones(),
            "set_microphone" => {
                self.selected_microphone_id = command.id.or(command.name);
            }
            "set_shortcut" => {
                if let Some(shortcut) = command.shortcut {
                    if let Some(hotkeys) = &self.hotkeys {
                        hotkeys.set_shortcut(shortcut);
                    }
                }
            }
            "start_shortcut_capture" => {
                let kind = command.kind.unwrap_or(ShortcutKind::Toggle);
                if let Some(hotkeys) = &self.hotkeys {
                    hotkeys.start_capture(kind);
                } else {
                    self.writer.emit(event(
                        "shortcut_capture_error",
                        serde_json::json!({
                            "kind": kind,
                            "code": "hotkey_monitor_unavailable",
                            "message": "Windows shortcut monitoring is unavailable.",
                        }),
                    ));
                }
            }
            "cancel_shortcut_capture" => {
                if let Some(hotkeys) = &self.hotkeys {
                    hotkeys.cancel_capture();
                }
            }
            "start_listening" => self.start_listening(),
            "stop_and_paste" => self.stop_and_paste(),
            "toggle_listening" => {
                if self.recorder.is_some() {
                    self.stop_and_paste();
                } else {
                    self.start_listening();
                }
            }
            "paste_text" => self.paste_text(command.text.unwrap_or_default()),
            "discard_recording" | "discard_mic_test" => self.discard_recording(),
            "shutdown" => return false,
            other => self.writer.emit(error_event(
                "unknown_command",
                format!("Unknown dictation helper command: {other}"),
            )),
        }
        true
    }

    fn emit_permission_status(&self) {
        self.writer.emit(event(
            "permission_status",
            serde_json::json!({
                "microphone": audio::microphone_permission_status(),
                "accessibility": "granted",
            }),
        ));
    }

    fn emit_microphones(&self) {
        match audio::list_microphones() {
            Ok((devices, default_device)) => {
                let selected_id = self
                    .selected_microphone_id
                    .clone()
                    .or_else(|| default_device.as_ref().map(|device| device.id.clone()))
                    .unwrap_or_default();
                self.writer.emit(event(
                    "microphone_devices",
                    serde_json::json!({
                        "devices": devices,
                        "defaultDevice": default_device,
                        "selectedID": selected_id,
                    }),
                ));
            }
            Err(error) => self
                .writer
                .emit(error_event("microphone_list_failed", error.to_string())),
        }
    }

    fn start_listening(&mut self) {
        if self.recorder.is_some() {
            return;
        }
        match Recorder::start(self.selected_microphone_id.as_deref()) {
            Ok(recorder) => {
                self.recorder = Some(recorder);
                self.pinned_target = None;
                self.writer.emit(simple_event("listening_started"));
                self.spawn_level_thread();
            }
            Err(error) => self
                .writer
                .emit(error_event("recording_start_failed", error.to_string())),
        }
    }

    fn stop_and_paste(&mut self) {
        let Some(recorder) = self.recorder.take() else {
            self.writer.emit(simple_event("recording_discarded"));
            return;
        };
        self.pinned_target = focus::pin_foreground_window();
        self.writer.emit(simple_event("finalizing_transcript"));
        match recorder.stop() {
            Ok(summary) => {
                let target = self.pinned_target;
                self.writer.emit(event(
                    "recording_ready",
                    serde_json::json!({
                        "path": summary.path.to_string_lossy(),
                        "durationMs": summary.duration.as_millis().to_string(),
                        "observedAudioLevel": format!("{:.4}", summary.observed_level),
                        "targetProcessId": target.map(|target| target.pid()),
                        "targetWindowHandle": target.map(|target| target.hwnd_value()),
                        "targetWindowTitle": target.map(|target| target.title()),
                    }),
                ));
            }
            Err(error) => self
                .writer
                .emit(error_event("recording_stop_failed", error.to_string())),
        }
    }

    fn paste_text(&mut self, text: String) {
        if let Err(error) = clipboard::set_text(&text) {
            self.writer
                .emit(error_event("clipboard_write_failed", error.to_string()));
            return;
        }
        let Some(target) = self.pinned_target.take() else {
            self.writer.emit(event(
                "paste_target_unavailable",
                serde_json::json!({
                    "message": "June copied the dictation to the clipboard. Press Ctrl+V to paste it.",
                }),
            ));
            return;
        };
        if !focus::verify_foreground(target) {
            self.writer.emit(event(
                "paste_target_restricted",
                serde_json::json!({
                    "message": "June copied the dictation to the clipboard. Press Ctrl+V to paste it.",
                    "targetProcessId": target.pid(),
                    "targetWindowHandle": target.hwnd_value(),
                    "targetWindowTitle": target.title(),
                }),
            ));
            return;
        }
        if let Err(error) = focus::send_ctrl_v() {
            self.writer.emit(event(
                "paste_target_restricted",
                serde_json::json!({
                    "message": "June copied the dictation to the clipboard. Press Ctrl+V to paste it.",
                    "detail": error.to_string(),
                }),
            ));
            return;
        }
        self.writer.emit(simple_event("final_transcript"));
    }

    fn discard_recording(&mut self) {
        if let Some(recorder) = self.recorder.take() {
            if let Ok(summary) = recorder.stop() {
                let _ = std::fs::remove_file(summary.path);
            }
        }
        self.pinned_target = None;
        self.writer.emit(simple_event("recording_discarded"));
    }

    fn spawn_level_thread(&self) {
        let writer = self.writer.clone();
        let Some((latest_level, active)) =
            self.recorder.as_ref().map(Recorder::latest_level_handle)
        else {
            return;
        };
        thread::spawn(move || {
            while active.load(std::sync::atomic::Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(80));
                let level = latest_level.lock().map(|level| *level).unwrap_or_default();
                writer.emit(event(
                    "audio_level",
                    serde_json::json!({ "level": format!("{level:.4}") }),
                ));
            }
        });
    }
}

impl Drop for HelperApp {
    fn drop(&mut self) {
        if let Some(recorder) = self.recorder.take() {
            if let Ok(summary) = recorder.stop() {
                let _ = std::fs::remove_file(summary.path);
            }
        }
        if let Some(hotkeys) = &self.hotkeys {
            hotkeys.shutdown();
        }
    }
}

fn open_microphone_settings() {
    let _com = ComApartment::init_sta();
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", "ms-settings:privacy-microphone"])
        .spawn();
}

fn main() {
    let _com = ComApartment::init_sta();
    let writer = EventWriter::new();
    writer.emit(simple_event("ready"));
    let mut app = HelperApp::new(writer.clone());
    let stdin = io::stdin();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let parsed = serde_json::from_str::<CommandEnvelope>(&line);
        match parsed {
            Ok(command) => {
                if !app.handle_command(command) {
                    break;
                }
            }
            Err(error) => writer.emit(error_event("command_parse_failed", error.to_string())),
        }
    }
}
