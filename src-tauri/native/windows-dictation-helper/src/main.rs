#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

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

const CLIPBOARD_RESTORE_DELAY: Duration = Duration::from_millis(700);
const CLIPBOARD_RESTORE_RETRY_DELAY: Duration = Duration::from_millis(100);
const CLIPBOARD_RESTORE_RETRY_WINDOW: Duration = Duration::from_secs(5);
const COMPOSER_ACK_TIMEOUT: Duration = Duration::from_secs(2);

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

struct MicTest {
    recorder: Recorder,
    deadline: std::time::Instant,
}

struct DelayedClipboardRestore {
    deadline: std::time::Instant,
    expires_at: std::time::Instant,
    text: String,
    backup: clipboard::ClipboardBackup,
}

struct DirectComposerRequest {
    id: String,
    june_pid: Option<u32>,
    june_window_handle: Option<isize>,
    start_target: Option<PinnedTarget>,
}

struct PendingComposerAck {
    id: String,
    deadline: std::time::Instant,
    text: String,
    backup: Option<clipboard::ClipboardBackup>,
}

fn composer_error_event(
    code: &str,
    message: impl Into<String>,
    composer_request_id: &str,
) -> serde_json::Value {
    event(
        "error",
        serde_json::json!({
            "code": code,
            "message": message.into(),
            "delivery": "agent_composer",
            "composerRequestId": composer_request_id,
        }),
    )
}

struct HelperApp {
    writer: EventWriter,
    recorder: Option<Recorder>,
    mic_test: Option<MicTest>,
    selected_microphone_id: Option<String>,
    pinned_target: Option<PinnedTarget>,
    hotkeys: Option<HotkeyManager>,
    delayed_clipboard_restore: Option<DelayedClipboardRestore>,
    direct_composer_request: Option<DirectComposerRequest>,
    pending_composer_ack: Option<PendingComposerAck>,
    awaiting_transcript: bool,
    last_mic_test_path: Option<std::path::PathBuf>,
}

impl HelperApp {
    fn new(writer: EventWriter) -> Self {
        let (event_tx, event_rx) = std::sync::mpsc::channel::<serde_json::Value>();
        let hotkey_writer = writer.clone();
        thread::spawn(move || {
            while let Ok(event) = event_rx.recv() {
                hotkey_writer.emit(event);
            }
        });

        let event_tx = std::sync::Mutex::new(event_tx);
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
            if let Ok(tx) = event_tx.lock() {
                let _ = tx.send(event);
            }
        }));
        Self {
            writer,
            recorder: None,
            mic_test: None,
            selected_microphone_id: None,
            pinned_target: None,
            hotkeys,
            delayed_clipboard_restore: None,
            direct_composer_request: None,
            pending_composer_ack: None,
            awaiting_transcript: false,
            last_mic_test_path: None,
        }
    }

    fn handle_command(&mut self, command: CommandEnvelope) -> bool {
        match command.command_type.as_str() {
            "ping" => self.writer.emit(simple_event("pong")),
            "get_permission_status"
            | "request_microphone_permission"
            | "request_accessibility_permission" => {
                self.emit_permission_status();
            }
            "list_microphones" => self.emit_microphones(),
            "set_microphone" => {
                self.selected_microphone_id = command.id.or(command.name);
                self.writer.emit(event(
                    "microphone_selected",
                    serde_json::json!({ "id": self.selected_microphone_id }),
                ));
            }
            "set_shortcut" => {
                if let Some(shortcut) = command.shortcut {
                    match serde_json::from_value(shortcut) {
                        Ok(shortcut) => {
                            if let Some(hotkeys) = &self.hotkeys {
                                hotkeys.set_shortcut(shortcut);
                            }
                        }
                        Err(error) => self.writer.emit(error_event(
                            "shortcut_invalid",
                            format!("Invalid Windows dictation shortcut: {error}"),
                        )),
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
            "start_listening" => self.start_listening(
                command.composer_request_id,
                command.june_process_id,
                command.june_window_handle,
            ),
            "stop_and_paste" => self.stop_and_paste(),
            "toggle_listening" => {
                if self.recorder.is_some() {
                    self.stop_and_paste();
                } else {
                    self.start_listening(
                        command.composer_request_id,
                        command.june_process_id,
                        command.june_window_handle,
                    );
                }
            }
            "paste_text" => self.paste_text(
                command.text.unwrap_or_default(),
                command.composer_request_id,
            ),
            "composer_delivery_result" => self.composer_delivery_result(
                command.composer_request_id,
                command.inserted.unwrap_or(false),
            ),
            "start_mic_test" => {
                self.start_mic_test(command.duration_seconds.unwrap_or(5).clamp(1, 10))
            }
            "discard_mic_test" => self.discard_mic_test(),
            "discard_recording" => self.discard_recording(),
            "shutdown" => {
                self.writer.emit(simple_event("shutdown_ack"));
                return false;
            }
            other => self.writer.emit(error_event(
                "unknown_command",
                format!("Unknown dictation helper command: {other}"),
            )),
        }
        true
    }

    fn emit_permission_status(&self) {
        let microphone = audio::microphone_permission_status();
        self.writer.emit(event(
            "permission_status",
            serde_json::json!({
                "microphone": microphone.status,
                "microphoneDeviceAvailable": microphone.device_available,
                "microphoneReason": microphone.reason,
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

    fn start_listening(
        &mut self,
        composer_request_id: Option<String>,
        june_pid: Option<u32>,
        june_window_handle: Option<isize>,
    ) {
        if self.recorder.is_some() || self.mic_test.is_some() || self.awaiting_transcript {
            return;
        }
        self.cleanup_last_mic_test();
        let start_target = focus::pin_foreground_window();
        match Recorder::start(self.selected_microphone_id.as_deref()) {
            Ok(recorder) => {
                self.recorder = Some(recorder);
                self.pinned_target = None;
                self.direct_composer_request = composer_request_id.map(|id| {
                    let verified_start_target = match (june_pid, june_window_handle, start_target) {
                        (Some(pid), Some(hwnd), Some(target))
                            if target.pid() == pid && target.hwnd_value() == hwnd =>
                        {
                            Some(target)
                        }
                        _ => None,
                    };
                    DirectComposerRequest {
                        id,
                        june_pid,
                        june_window_handle,
                        start_target: verified_start_target,
                    }
                });
                self.writer.emit(event(
                    "listening_started",
                    serde_json::json!({
                        "composerRequestId": self
                            .direct_composer_request
                            .as_ref()
                            .map(|request| request.id.as_str()),
                    }),
                ));
                self.spawn_level_thread();
            }
            Err(error) => {
                if let Some(request_id) = composer_request_id {
                    self.writer.emit(composer_error_event(
                        "recording_start_failed",
                        error.to_string(),
                        &request_id,
                    ));
                } else {
                    self.writer
                        .emit(error_event("recording_start_failed", error.to_string()));
                }
            }
        }
    }

    fn stop_and_paste(&mut self) {
        let Some(recorder) = self.recorder.take() else {
            if self.awaiting_transcript {
                return;
            }
            self.writer.emit(simple_event("recording_discarded"));
            return;
        };
        self.awaiting_transcript = true;
        self.pinned_target = focus::pin_foreground_window();
        self.writer.emit(simple_event("finalizing_transcript"));
        match recorder.stop() {
            Ok(summary) => {
                let target = self.pinned_target;
                let composer_request_id = self
                    .direct_composer_request
                    .as_ref()
                    .map(|request| request.id.clone());
                self.writer.emit(event(
                    "recording_ready",
                    serde_json::json!({
                        "path": summary.path.to_string_lossy(),
                        "durationMs": summary.duration.as_millis() as u64,
                        "observedAudioLevel": summary.observed_level,
                        "targetProcessId": target.map(|target| target.pid()),
                        "targetWindowHandle": target.map(|target| target.hwnd_value()),
                        "targetWindowTitle": target.map(|target| target.title()),
                        "composerRequestId": composer_request_id,
                    }),
                ));
            }
            Err(error) => {
                self.awaiting_transcript = false;
                if let Some(request) = self.direct_composer_request.take() {
                    self.writer.emit(composer_error_event(
                        "recording_stop_failed",
                        error.to_string(),
                        &request.id,
                    ));
                } else {
                    self.writer
                        .emit(error_event("recording_stop_failed", error.to_string()));
                }
            }
        }
    }

    fn paste_text(&mut self, text: String, composer_request_id: Option<String>) {
        let owns_current_request = match (
            self.direct_composer_request.as_ref(),
            composer_request_id.as_deref(),
        ) {
            (Some(request), Some(request_id)) => request.id == request_id,
            (None, None) => true,
            _ => false,
        };
        if !owns_current_request {
            // An asynchronous outcome can reconnect to a restarted helper
            // after another recording has begun. Preserve the newer request's
            // target and lifecycle while keeping the stale text recoverable.
            self.finish_clipboard_restore(false);
            match clipboard::replace_text(&text) {
                Ok(_) => self.delayed_clipboard_restore = None,
                Err(error) => {
                    self.writer
                        .emit(error_event("clipboard_write_failed", error.to_string()));
                    return;
                }
            }
            if let Some(request_id) = composer_request_id {
                self.writer.emit(composer_error_event(
                    "composer_request_unavailable",
                    "June copied the dictation to the clipboard. Press Ctrl+V to paste it.",
                    &request_id,
                ));
            } else {
                self.writer.emit(error_event(
                    "paste_target_unavailable",
                    "June copied the dictation to the clipboard. Press Ctrl+V to paste it.",
                ));
            }
            return;
        }
        self.awaiting_transcript = false;
        self.finish_clipboard_restore(false);
        if self.direct_composer_request.is_none() && composer_request_id.is_none() {
            self.writer.emit(event(
                "final_transcript",
                serde_json::json!({ "text": text }),
            ));
        }
        let previous_clipboard = match clipboard::replace_text(&text) {
            Ok(previous) => previous,
            Err(error) => {
                if let Some(request) = self.direct_composer_request.take() {
                    self.writer.emit(composer_error_event(
                        "clipboard_write_failed",
                        error.to_string(),
                        &request.id,
                    ));
                } else {
                    self.writer
                        .emit(error_event("clipboard_write_failed", error.to_string()));
                }
                return;
            }
        };
        // Once the new text owns the clipboard, an older restore must never
        // remain armed: on any paste failure this dictation is the fallback.
        let previous_clipboard = backup_for_next_clipboard_restore(
            previous_clipboard,
            self.delayed_clipboard_restore.take(),
        );
        if let Some(request) = self.direct_composer_request.take() {
            let exact_request = composer_request_id.as_deref() == Some(request.id.as_str());
            let exact_target = request.start_target.is_some_and(|start_target| {
                request.june_pid == Some(start_target.pid())
                    && request.june_window_handle == Some(start_target.hwnd_value())
                    && start_target.has_exact_identity()
            });
            self.pinned_target = None;
            if !exact_request || !exact_target {
                self.writer.emit(composer_error_event(
                    "paste_target_unavailable",
                    "June copied the dictation to the clipboard. Press Ctrl+V to paste it.",
                    &request.id,
                ));
                return;
            }
            self.writer.emit(event(
                "final_transcript",
                serde_json::json!({
                    "text": text,
                    "delivery": "agent_composer",
                    "composerRequestId": request.id,
                }),
            ));
            self.pending_composer_ack = Some(PendingComposerAck {
                id: request.id,
                deadline: std::time::Instant::now() + COMPOSER_ACK_TIMEOUT,
                text,
                backup: previous_clipboard,
            });
            return;
        }
        let Some(target) = self.pinned_target.take() else {
            self.writer.emit(error_event(
                "paste_target_unavailable",
                "June copied the dictation to the clipboard. Press Ctrl+V to paste it.",
            ));
            return;
        };
        if let Err(error) = focus::activate_and_settle(target) {
            let code = if error.is_target_unavailable() {
                "paste_target_unavailable"
            } else {
                "paste_target_restricted"
            };
            self.writer.emit(error_event(
                code,
                format!(
                    "June copied the dictation to the clipboard. Press Ctrl+V to paste it. ({error})"
                ),
            ));
            return;
        }
        self.writer.emit(event(
            "paste_target",
            serde_json::json!({
                "targetProcessId": target.pid(),
                "targetWindowHandle": target.hwnd_value(),
                "targetWindowTitle": target.title(),
                "activated": true,
            }),
        ));
        let submission = match focus::submit_ctrl_v_if_foreground(target) {
            Ok(submission) => submission,
            Err(error) => {
                let code = if error.is_target_unavailable() {
                    "paste_target_unavailable"
                } else {
                    "paste_target_restricted"
                };
                let guidance = if error.is_incomplete_submission() {
                    "Automatic paste may be incomplete. Check the target before pasting the full dictation from the clipboard."
                } else {
                    "Press Ctrl+V to paste it."
                };
                self.writer.emit(error_event(
                    code,
                    format!("June copied the dictation to the clipboard. {guidance} ({error})"),
                ));
                return;
            }
        };
        self.writer.emit(paste_completed_event(&submission));
        if let Some(backup) = previous_clipboard {
            let now = std::time::Instant::now();
            self.delayed_clipboard_restore = Some(DelayedClipboardRestore {
                deadline: now + CLIPBOARD_RESTORE_DELAY,
                expires_at: now + CLIPBOARD_RESTORE_RETRY_WINDOW,
                text,
                backup,
            });
        }
    }

    fn composer_delivery_result(&mut self, request_id: Option<String>, inserted: bool) {
        let Some(pending) = self.pending_composer_ack.take() else {
            return;
        };
        if request_id.as_deref() != Some(pending.id.as_str())
            || std::time::Instant::now() >= pending.deadline
        {
            self.pending_composer_ack = Some(pending);
            return;
        }
        if !inserted {
            self.writer.emit(composer_error_event(
                "composer_delivery_failed",
                "June copied the dictation to the clipboard. Press Ctrl+V to paste it.",
                &pending.id,
            ));
            return;
        }
        self.writer.emit(event(
            "paste_completed",
            serde_json::json!({
                "inputSubmitted": false,
                "deliveryConfirmed": true,
                "eventsSubmitted": 0,
                "delivery": "agent_composer",
                "composerRequestId": pending.id,
            }),
        ));
        if let Some(backup) = pending.backup {
            let now = std::time::Instant::now();
            self.delayed_clipboard_restore = Some(DelayedClipboardRestore {
                deadline: now + CLIPBOARD_RESTORE_DELAY,
                expires_at: now + CLIPBOARD_RESTORE_RETRY_WINDOW,
                text: pending.text,
                backup,
            });
        }
    }

    fn finish_clipboard_restore(&mut self, force: bool) {
        let Some(restore) = self.delayed_clipboard_restore.take() else {
            return;
        };
        let now = std::time::Instant::now();
        let restore_failed =
            clipboard::restore_clipboard_if_unchanged(&restore.text, &restore.backup).is_err();
        self.delayed_clipboard_restore =
            next_clipboard_restore(restore, force, restore_failed, now);
    }

    fn cleanup_last_mic_test(&mut self) {
        if let Some(path) = self.last_mic_test_path.take() {
            let _ = std::fs::remove_file(path);
        }
    }

    fn start_mic_test(&mut self, duration_seconds: u64) {
        if self.recorder.is_some() || self.mic_test.is_some() || self.awaiting_transcript {
            self.writer.emit(event(
                "mic_test_error",
                serde_json::json!({
                    "code": "microphone_busy",
                    "message": "Stop dictation before testing the microphone.",
                }),
            ));
            return;
        }
        self.cleanup_last_mic_test();
        match Recorder::start(self.selected_microphone_id.as_deref()) {
            Ok(recorder) => {
                let (latest_level, active) = recorder.latest_level_handle();
                self.mic_test = Some(MicTest {
                    recorder,
                    deadline: std::time::Instant::now() + Duration::from_secs(duration_seconds),
                });
                self.writer.emit(simple_event("mic_test_started"));

                let level_writer = self.writer.clone();
                thread::spawn(move || {
                    while active.load(std::sync::atomic::Ordering::SeqCst) {
                        thread::sleep(Duration::from_millis(80));
                        let level = latest_level.lock().map(|level| *level).unwrap_or_default();
                        level_writer.emit(event(
                            "mic_test_level",
                            serde_json::json!({ "level": level }),
                        ));
                    }
                });
            }
            Err(error) => self.writer.emit(event(
                "mic_test_error",
                serde_json::json!({
                    "code": "mic_test_start_failed",
                    "message": error.to_string(),
                }),
            )),
        }
    }

    fn tick(&mut self) {
        if self
            .mic_test
            .as_ref()
            .is_some_and(|test| std::time::Instant::now() >= test.deadline)
        {
            self.finish_mic_test();
        }
        if self
            .delayed_clipboard_restore
            .as_ref()
            .is_some_and(|restore| std::time::Instant::now() >= restore.deadline)
        {
            self.finish_clipboard_restore(false);
        }
        if self
            .pending_composer_ack
            .as_ref()
            .is_some_and(|pending| std::time::Instant::now() >= pending.deadline)
        {
            if let Some(pending) = self.pending_composer_ack.take() {
                self.writer.emit(composer_error_event(
                    "composer_delivery_timeout",
                    "June could not confirm the dictation was inserted. The text is on the clipboard if you need to paste it manually.",
                    &pending.id,
                ));
            }
        }
    }

    fn finish_mic_test(&mut self) {
        let Some(test) = self.mic_test.take() else {
            return;
        };
        match test.recorder.stop() {
            Ok(summary) => {
                self.last_mic_test_path = Some(summary.path.clone());
                self.writer.emit(event(
                    "mic_test_ready",
                    serde_json::json!({
                        "path": summary.path.to_string_lossy(),
                        "durationMs": summary.duration.as_millis() as u64,
                        "observedAudioLevel": summary.observed_level,
                    }),
                ));
            }
            Err(error) => self.writer.emit(event(
                "mic_test_error",
                serde_json::json!({
                    "code": "mic_test_stop_failed",
                    "message": error.to_string(),
                }),
            )),
        }
    }

    fn discard_mic_test(&mut self) {
        self.cleanup_last_mic_test();
        if let Some(test) = self.mic_test.take() {
            if let Ok(summary) = test.recorder.stop() {
                let _ = std::fs::remove_file(summary.path);
            }
        }
    }

    fn discard_recording(&mut self) {
        if let Some(recorder) = self.recorder.take() {
            if let Ok(summary) = recorder.stop() {
                let _ = std::fs::remove_file(summary.path);
            }
        }
        self.awaiting_transcript = false;
        self.pinned_target = None;
        if let Some(request) = self.direct_composer_request.take() {
            self.writer.emit(event(
                "recording_discarded",
                serde_json::json!({
                    "delivery": "agent_composer",
                    "composerRequestId": request.id,
                }),
            ));
        } else {
            self.writer.emit(simple_event("recording_discarded"));
        }
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
                writer.emit(event("audio_level", serde_json::json!({ "level": level })));
            }
        });
    }
}

fn next_clipboard_restore(
    mut restore: DelayedClipboardRestore,
    force: bool,
    restore_failed: bool,
    now: std::time::Instant,
) -> Option<DelayedClipboardRestore> {
    if restore_failed && !force && now < restore.expires_at {
        restore.deadline = now + CLIPBOARD_RESTORE_RETRY_DELAY;
        Some(restore)
    } else {
        None
    }
}

fn backup_for_next_clipboard_restore(
    backup: Option<clipboard::ClipboardBackup>,
    pending: Option<DelayedClipboardRestore>,
) -> Option<clipboard::ClipboardBackup> {
    match (backup, pending) {
        (Some(backup), Some(pending)) if backup.original_text_is(&pending.text) => {
            Some(pending.backup)
        }
        (backup, _) => backup,
    }
}

fn paste_completed_event(submission: &focus::InputSubmission) -> serde_json::Value {
    event(
        "paste_completed",
        serde_json::json!({
            "inputSubmitted": true,
            "deliveryConfirmed": false,
            "eventsSubmitted": submission.events_submitted,
        }),
    )
}

impl Drop for HelperApp {
    fn drop(&mut self) {
        self.finish_clipboard_restore(true);
        self.cleanup_last_mic_test();
        if let Some(test) = self.mic_test.take() {
            if let Ok(summary) = test.recorder.stop() {
                let _ = std::fs::remove_file(summary.path);
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paste_completed_reports_input_submission_without_claiming_delivery() {
        let event = paste_completed_event(&focus::InputSubmission {
            events_submitted: 4,
        });

        assert_eq!(event["type"], "paste_completed");
        assert_eq!(event["payload"]["inputSubmitted"], true);
        assert_eq!(event["payload"]["deliveryConfirmed"], false);
        assert_eq!(event["payload"]["eventsSubmitted"], 4);
    }

    fn restore_with_expiry(
        now: std::time::Instant,
        expires_at: std::time::Instant,
    ) -> DelayedClipboardRestore {
        DelayedClipboardRestore {
            deadline: now,
            expires_at,
            text: "dictated text".to_string(),
            backup: clipboard::ClipboardBackup::from_text_for_test("previous clipboard"),
        }
    }

    #[test]
    fn clipboard_restore_failure_keeps_backup_for_retry_before_expiry() {
        let now = std::time::Instant::now();
        let restore = restore_with_expiry(now, now + CLIPBOARD_RESTORE_RETRY_WINDOW);

        let retry = next_clipboard_restore(restore, false, true, now)
            .expect("retryable clipboard contention should keep backup");

        assert_eq!(retry.text, "dictated text");
        assert!(retry.backup.original_text_is("previous clipboard"));
        assert!(retry.deadline > now);
        assert!(retry.expires_at > now);
    }

    #[test]
    fn clipboard_restore_success_drops_backup() {
        let now = std::time::Instant::now();
        let restore = restore_with_expiry(now, now + CLIPBOARD_RESTORE_RETRY_WINDOW);

        assert!(next_clipboard_restore(restore, false, false, now).is_none());
    }

    #[test]
    fn second_paste_chains_pending_restore_backup_when_clipboard_still_has_previous_text() {
        let now = std::time::Instant::now();
        let pending = restore_with_expiry(now, now + CLIPBOARD_RESTORE_RETRY_WINDOW);
        let second_backup = clipboard::ClipboardBackup::from_text_for_test("dictated text");

        let backup = backup_for_next_clipboard_restore(Some(second_backup), Some(pending))
            .expect("original clipboard backup");

        assert!(backup.original_text_is("previous clipboard"));
    }

    #[test]
    fn second_paste_keeps_new_backup_when_clipboard_changed_after_previous_paste() {
        let now = std::time::Instant::now();
        let pending = restore_with_expiry(now, now + CLIPBOARD_RESTORE_RETRY_WINDOW);
        let second_backup = clipboard::ClipboardBackup::from_text_for_test("user copied text");

        let backup = backup_for_next_clipboard_restore(Some(second_backup), Some(pending))
            .expect("new clipboard backup");

        assert!(backup.original_text_is("user copied text"));
    }

    #[test]
    fn second_paste_without_text_backup_cancels_pending_restore() {
        let now = std::time::Instant::now();
        let pending = restore_with_expiry(now, now + CLIPBOARD_RESTORE_RETRY_WINDOW);

        assert!(backup_for_next_clipboard_restore(None, Some(pending)).is_none());
    }

    #[test]
    fn clipboard_backup_exists_when_unicode_text_is_available() {
        assert!(clipboard::backup_exists_for_text_for_test(Some(
            "rich editor text".to_string()
        )));
    }

    #[test]
    fn clipboard_backup_is_absent_without_unicode_text() {
        assert!(!clipboard::backup_exists_for_text_for_test(None));
    }

    #[test]
    fn forced_clipboard_restore_failure_drops_backup_on_shutdown() {
        let now = std::time::Instant::now();
        let restore = restore_with_expiry(now, now + CLIPBOARD_RESTORE_RETRY_WINDOW);

        assert!(next_clipboard_restore(restore, true, true, now).is_none());
    }

    #[test]
    fn clipboard_restore_failure_drops_backup_after_expiry() {
        let now = std::time::Instant::now();
        let restore = restore_with_expiry(now, now);

        assert!(next_clipboard_restore(restore, false, true, now).is_none());
    }
}

fn main() {
    let _com = ComApartment::init_sta();
    let writer = EventWriter::new();
    writer.emit(simple_event("ready"));
    let mut app = HelperApp::new(writer.clone());
    let (line_tx, line_rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines().map_while(Result::ok) {
            if line_tx.send(line).is_err() {
                break;
            }
        }
    });
    let mut last_tick = std::time::Instant::now();
    loop {
        match line_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => {
                let parsed = serde_json::from_str::<CommandEnvelope>(&line);
                match parsed {
                    Ok(command) => {
                        if !app.handle_command(command) {
                            break;
                        }
                    }
                    Err(error) => {
                        writer.emit(error_event("command_parse_failed", error.to_string()))
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if last_tick.elapsed() >= Duration::from_millis(50) {
            app.tick();
            last_tick = std::time::Instant::now();
        }
    }
}
