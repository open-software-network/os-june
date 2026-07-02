//! In-process Windows dictation "helper".
//!
//! On macOS an out-of-process Swift helper owns the global hotkey, the
//! microphone capture, and the paste, talking to Rust over stdin/stdout
//! JSON lines. On Windows this module satisfies the exact same command and
//! event protocol in-process, so the existing Rust plumbing (shortcut
//! activation controller, transcription, HUD) and the frontend work
//! unchanged:
//!
//! - Commands arrive through [`handle_command`] (the same JSON shapes the
//!   Swift helper reads from stdin).
//! - Events leave through an mpsc channel whose consumer feeds them into
//!   `dictation::handle_helper_event_line`, exactly like the helper's
//!   stdout reader thread does on macOS.
//!
//! Threads:
//! - A hook thread installs a WH_KEYBOARD_LL hook and pumps messages.
//!   RegisterHotKey is not enough here: push-to-talk needs the key-up edge
//!   and the settings UI's capture mode needs raw chord observation. The
//!   hook callback only runs the pure chord matcher (dictation/win_chords)
//!   and forwards resulting events to the dispatcher, so it returns fast.
//! - A dispatcher thread turns engine events into `handle_helper_event_line`
//!   calls (which may do real work: transcription spawns, HUD updates).
//! - A capture thread owns the cpal input stream and the recording state
//!   machine (dictation + mic test), mirroring the Swift
//!   `DictationController` semantics and event vocabulary.
//! - Short-lived timer threads implement the hold-threshold and capture
//!   debounce, checking a generation token so stale timers are inert.
//!
//! Paste uses raw Win32 clipboard APIs (CF_UNICODETEXT save, set, restore)
//! plus SendInput Ctrl+V; `arboard` would pull a sizable dependency tree for
//! what is ~80 lines of Win32 here.

use super::win_chords::{
    self, parse_helper_command, parse_shortcut, Action, ChordMatcher, HelperCommand, Mods,
    ShortcutParseError,
};
use crate::domain::types::AppError;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde_json::{json, Value};
use std::{
    fs,
    io::BufWriter,
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;

use windows::Win32::Foundation::{CloseHandle, HANDLE, HGLOBAL, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Threading::{
    GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, VK_V,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
    PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, KBDLLHOOKSTRUCT,
    LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

const CF_UNICODETEXT: u32 = 13;
/// Delay between claiming the clipboard and posting Ctrl+V (matches the
/// Swift helper's 0.18s activation settle).
const PASTE_KEYSTROKE_DELAY: Duration = Duration::from_millis(180);
/// The clipboard is restored this long after the paste started (matches the
/// Swift helper's 0.7s restore).
const CLIPBOARD_RESTORE_DELAY: Duration = Duration::from_millis(700);
/// Level events are coalesced to this cadence, like the Swift helper's
/// selected-device recorder.
const LEVEL_EMIT_INTERVAL: Duration = Duration::from_millis(40);
/// Extra capture time appended to a mic test (Swift's
/// `micTestCapturePaddingSeconds`).
const MIC_TEST_PADDING: Duration = Duration::from_millis(350);

static ENGINE: OnceLock<Engine> = OnceLock::new();

struct Engine {
    events: mpsc::Sender<Value>,
    capture: mpsc::Sender<CaptureCmd>,
    matcher: Mutex<ChordMatcher>,
    hook_thread_id: AtomicU32,
}

impl Engine {
    fn emit(&self, event: Value) {
        let _ = self.events.send(event);
    }
}

fn engine() -> Option<&'static Engine> {
    ENGINE.get()
}

/// Start the in-process helper: dispatcher, capture, and hook threads.
/// Idempotent; called once from `dictation::setup`.
pub(crate) fn start(app: &AppHandle) {
    let (event_tx, event_rx) = mpsc::channel::<Value>();
    let (capture_tx, capture_rx) = mpsc::channel::<CaptureCmd>();

    let engine = Engine {
        events: event_tx.clone(),
        capture: capture_tx,
        matcher: Mutex::new(ChordMatcher::default()),
        hook_thread_id: AtomicU32::new(0),
    };
    if ENGINE.set(engine).is_err() {
        return;
    }

    let dispatch_app = app.clone();
    thread::Builder::new()
        .name("dictation-win-events".into())
        .spawn(move || {
            for event in event_rx {
                super::handle_helper_event_line(&dispatch_app, event.to_string());
            }
        })
        .ok();

    let capture_events = event_tx.clone();
    thread::Builder::new()
        .name("dictation-win-capture".into())
        .spawn(move || capture_thread(capture_rx, capture_events))
        .ok();

    thread::Builder::new()
        .name("dictation-win-hook".into())
        .spawn(hook_thread)
        .ok();

    if let Some(engine) = ENGINE.get() {
        engine.emit(json!({ "type": "ready", "payload": {} }));
        engine.emit(diagnostics_event());
    }
}

/// Stop the hook thread and reset any live recording. Called on app exit.
pub(crate) fn stop() {
    if let Some(engine) = engine() {
        let thread_id = engine.hook_thread_id.load(Ordering::SeqCst);
        if thread_id != 0 {
            unsafe {
                let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
        let _ = engine.capture.send(CaptureCmd::Reset);
    }
}

/// Route one helper command (the same JSON the Swift helper accepts on
/// stdin) to the in-process implementation.
pub(crate) fn handle_command(_app: &AppHandle, command: Value) -> Result<(), AppError> {
    let Some(engine) = engine() else {
        return Err(AppError::new(
            "dictation_helper_unavailable",
            "Dictation engine is not running.",
        ));
    };

    match parse_helper_command(&command) {
        HelperCommand::Ping => {
            engine.emit(json!({ "type": "pong", "payload": {} }));
            engine.emit(diagnostics_event());
        }
        HelperCommand::GetPermissionStatus => engine.emit(permission_status_event()),
        HelperCommand::RequestMicrophonePermission => {
            open_microphone_privacy_settings();
            engine.emit(permission_status_event());
        }
        HelperCommand::RequestAccessibilityPermission => engine.emit(permission_status_event()),
        HelperCommand::ListMicrophones => send_capture(engine, CaptureCmd::ListMicrophones),
        HelperCommand::StartListening => send_capture(
            engine,
            CaptureCmd::Start {
                purpose: Purpose::Dictation,
                duration: None,
            },
        ),
        HelperCommand::StopAndPaste => send_capture(engine, CaptureCmd::Stop),
        HelperCommand::StartMicTest { duration_seconds } => send_capture(
            engine,
            CaptureCmd::Start {
                purpose: Purpose::MicTest,
                duration: Some(Duration::from_secs_f64(duration_seconds.clamp(1.0, 15.0))),
            },
        ),
        HelperCommand::DiscardMicTest => send_capture(engine, CaptureCmd::DiscardMicTest),
        HelperCommand::SetMicrophone { id, name } => {
            send_capture(engine, CaptureCmd::SetMicrophone { id, name })
        }
        HelperCommand::SetShortcut { shortcut } => handle_set_shortcut(engine, shortcut),
        HelperCommand::StartShortcutCapture => {
            if let Ok(mut matcher) = engine.matcher.lock() {
                matcher.start_capture();
            }
            engine.emit(json!({ "type": "shortcut_capture_started", "payload": {} }));
        }
        HelperCommand::CancelShortcutCapture => {
            if let Ok(mut matcher) = engine.matcher.lock() {
                matcher.cancel_capture();
            }
            engine.emit(json!({ "type": "shortcut_capture_cancelled", "payload": {} }));
        }
        HelperCommand::ToggleListening { shortcut } => {
            send_capture(engine, CaptureCmd::Toggle { shortcut })
        }
        HelperCommand::PasteText { text } => send_capture(engine, CaptureCmd::Paste { text }),
        HelperCommand::DiscardRecording => send_capture(engine, CaptureCmd::Discard),
        HelperCommand::Shutdown => {
            send_capture(engine, CaptureCmd::Reset);
            engine.emit(json!({ "type": "shutdown_ack", "payload": {} }));
        }
        HelperCommand::Unknown => {
            engine.emit(error_event("unknown_command", "Unknown helper command."))
        }
    }
    Ok(())
}

fn send_capture(engine: &Engine, command: CaptureCmd) {
    let _ = engine.capture.send(command);
}

fn handle_set_shortcut(engine: &Engine, shortcut: Option<Value>) {
    let Some(payload) = shortcut else {
        engine.emit(error_event(
            "invalid_shortcut",
            "Shortcut configuration was invalid.",
        ));
        return;
    };
    match parse_shortcut(&payload) {
        Ok((kind, shortcut)) => {
            if let Ok(mut matcher) = engine.matcher.lock() {
                matcher.set_shortcut(kind, shortcut);
            }
        }
        Err(ShortcutParseError::Invalid) => {
            engine.emit(error_event(
                "invalid_shortcut",
                "Shortcut configuration was invalid.",
            ));
        }
        Err(ShortcutParseError::FunctionUnsupported { label }) => {
            clear_kind_for_payload(engine, &payload);
            engine.emit(json!({
                "type": "fn_monitor_unavailable",
                "payload": {
                    "message": format!(
                        "The shortcut {label} uses the Fn key, which Windows cannot monitor. Pick a different shortcut in Settings."
                    ),
                },
            }));
        }
        Err(ShortcutParseError::Unmappable { label }) => {
            clear_kind_for_payload(engine, &payload);
            engine.emit(json!({
                "type": "fn_monitor_unavailable",
                "payload": {
                    "message": format!("Could not register the shortcut {label}."),
                },
            }));
        }
    }
}

/// A chord that cannot be monitored must also stop matching its kind's
/// previous chord, mirroring the Swift helper's full hot key re-registration.
fn clear_kind_for_payload(engine: &Engine, payload: &Value) {
    let kind = match payload.get("kind").and_then(Value::as_str) {
        Some("push_to_talk") => super::DictationShortcutKind::PushToTalk,
        Some("toggle") => super::DictationShortcutKind::Toggle,
        _ => return,
    };
    if let Ok(mut matcher) = engine.matcher.lock() {
        matcher.clear_shortcut(kind);
    }
}

fn error_event(code: &str, message: &str) -> Value {
    json!({ "type": "error", "payload": { "code": code, "message": message } })
}

fn permission_status_event() -> Value {
    let (microphone, _) = crate::audio::capture::microphone_permission_state();
    json!({
        "type": "permission_status",
        "payload": {
            "microphone": microphone,
            "accessibility": "granted",
        },
    })
}

fn diagnostics_event() -> Value {
    let (microphone, _) = crate::audio::capture::microphone_permission_state();
    json!({
        "type": "dictation_diagnostics",
        "payload": {
            "bundleIdentifier": "in-process-windows",
            "microphone": microphone,
            "accessibility": "granted",
            "autoDetectRawMeter": "disabled",
        },
    })
}

fn open_microphone_privacy_settings() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "ms-settings:privacy-microphone"])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

// ---------------------------------------------------------------------------
// Keyboard hook
// ---------------------------------------------------------------------------

fn hook_thread() {
    let Some(engine) = engine() else {
        return;
    };
    engine
        .hook_thread_id
        .store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);

    let hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), None, 0) };
    let hook = match hook {
        Ok(hook) => hook,
        Err(error) => {
            engine.emit(json!({
                "type": "fn_monitor_unavailable",
                "payload": {
                    "message": format!("Could not monitor global shortcut key events: {error}"),
                },
            }));
            return;
        }
    };

    let mut message = MSG::default();
    // GetMessageW returns 0 on WM_QUIT and -1 on error; both end the pump.
    while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {
        unsafe {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }

    unsafe {
        let _ = UnhookWindowsHookEx(hook);
    }
}

unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code < 0 {
        return CallNextHookEx(None, code, wparam, lparam);
    }
    let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
    // Skip injected events: our own SendInput Ctrl+V must never re-enter the
    // chord matcher.
    if info.flags.0 & LLKHF_INJECTED.0 != 0 {
        return CallNextHookEx(None, code, wparam, lparam);
    }
    let down = matches!(wparam.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
    let up = matches!(wparam.0 as u32, WM_KEYUP | WM_SYSKEYUP);
    if !down && !up {
        return CallNextHookEx(None, code, wparam, lparam);
    }

    let Some(engine) = engine() else {
        return CallNextHookEx(None, code, wparam, lparam);
    };
    let actions = engine
        .matcher
        .lock()
        .map(|mut matcher| matcher.key_event(info.vkCode, down, Instant::now()))
        .unwrap_or_default();
    if run_matcher_actions(engine, actions) {
        return LRESULT(1);
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Perform the side effects of matcher actions; returns whether the hook
/// should swallow the key event.
fn run_matcher_actions(engine: &'static Engine, actions: Vec<Action>) -> bool {
    let mut swallow = false;
    for action in actions {
        match action {
            Action::Emit { kind, label, down } => emit_shortcut_edge(engine, kind, &label, down),
            Action::SwallowKey => swallow = true,
            Action::SchedulePushStart { token } => {
                thread::spawn(move || {
                    thread::sleep(win_chords::HOLD_THRESHOLD);
                    let actions = engine
                        .matcher
                        .lock()
                        .map(|mut matcher| matcher.fire_pending_push(token))
                        .unwrap_or_default();
                    run_matcher_actions(engine, actions);
                });
            }
            Action::ScheduleCaptureCommit { token } => {
                thread::spawn(move || {
                    thread::sleep(win_chords::CAPTURE_DEBOUNCE);
                    let captured = engine
                        .matcher
                        .lock()
                        .ok()
                        .and_then(|mut matcher| matcher.fire_capture_commit(token));
                    if let Some(mods) = captured {
                        emit_captured_modifier_shortcut(engine, mods);
                    }
                });
            }
        }
    }
    swallow
}

fn emit_shortcut_edge(
    engine: &Engine,
    kind: super::DictationShortcutKind,
    label: &str,
    down: bool,
) {
    let kind = match kind {
        super::DictationShortcutKind::PushToTalk => "push_to_talk",
        super::DictationShortcutKind::Toggle => "toggle",
    };
    engine.emit(json!({
        "type": if down { "shortcut_key_down" } else { "shortcut_key_up" },
        "payload": { "kind": kind, "shortcut": label },
    }));
}

fn emit_captured_modifier_shortcut(engine: &Engine, mods: Mods) {
    let label = mods.label_parts().join("+");
    engine.emit(json!({
        "type": "shortcut_captured",
        "payload": {
            "shortcut": {
                "keyCode": 0,
                "code": "Modifiers",
                "label": label,
                "pressCount": 1,
                "modifiers": {
                    "command": mods.command,
                    "control": mods.control,
                    "option": mods.option,
                    "shift": mods.shift,
                    "function": false,
                },
            },
        },
    }));
}

// ---------------------------------------------------------------------------
// Microphone capture
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Purpose {
    Dictation,
    MicTest,
}

#[derive(Debug)]
enum CaptureCmd {
    Start {
        purpose: Purpose,
        duration: Option<Duration>,
    },
    Stop,
    Toggle {
        shortcut: String,
    },
    Discard,
    DiscardMicTest,
    SetMicrophone {
        id: Option<String>,
        name: Option<String>,
    },
    ListMicrophones,
    Paste {
        text: String,
    },
    Reset,
}

type SharedWavWriter = Arc<Mutex<Option<hound::WavWriter<BufWriter<fs::File>>>>>;

struct ActiveRecording {
    stream: cpal::Stream,
    writer: SharedWavWriter,
    path: PathBuf,
    purpose: Purpose,
    started_at: Instant,
    /// f32 bits of the loudest observed level, shared with the stream
    /// callback.
    max_level: Arc<AtomicU32>,
    /// Mic tests stop themselves at this deadline.
    deadline: Option<Instant>,
}

struct CaptureState {
    events: mpsc::Sender<Value>,
    preferred_id: Option<String>,
    preferred_name: Option<String>,
    recording: Option<ActiveRecording>,
    /// A finalized dictation take waiting for paste_text / discard_recording.
    finalized_path: Option<PathBuf>,
    mic_test_sample: Option<PathBuf>,
}

impl CaptureState {
    fn emit(&self, event: Value) {
        let _ = self.events.send(event);
    }

    fn listening(&self) -> bool {
        self.recording.is_some() || self.finalized_path.is_some()
    }
}

fn capture_thread(rx: mpsc::Receiver<CaptureCmd>, events: mpsc::Sender<Value>) {
    let mut state = CaptureState {
        events,
        preferred_id: None,
        preferred_name: None,
        recording: None,
        finalized_path: None,
        mic_test_sample: None,
    };

    loop {
        let deadline = state
            .recording
            .as_ref()
            .and_then(|recording| recording.deadline);
        let command = match deadline {
            Some(deadline) => {
                let timeout = deadline.saturating_duration_since(Instant::now());
                match rx.recv_timeout(timeout) {
                    Ok(command) => Some(command),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            None => match rx.recv() {
                Ok(command) => Some(command),
                Err(_) => return,
            },
        };

        let Some(command) = command else {
            // Mic test deadline reached.
            finalize_recording(&mut state);
            continue;
        };

        match command {
            CaptureCmd::Start { purpose, duration } => {
                start_recording(&mut state, purpose, duration)
            }
            CaptureCmd::Stop => stop_dictation(&mut state),
            CaptureCmd::Toggle { shortcut } => {
                if state.listening() {
                    state.emit(json!({
                        "type": "hotkey_trigger",
                        "payload": { "action": "stop", "shortcut": shortcut },
                    }));
                    stop_dictation(&mut state);
                } else {
                    state.emit(json!({
                        "type": "hotkey_trigger",
                        "payload": { "action": "start", "shortcut": shortcut },
                    }));
                    start_recording(&mut state, Purpose::Dictation, None);
                }
            }
            CaptureCmd::Discard => discard_recording(&mut state),
            CaptureCmd::DiscardMicTest => {
                if state
                    .recording
                    .as_ref()
                    .is_some_and(|recording| recording.purpose == Purpose::MicTest)
                {
                    reset_recording(&mut state, false);
                }
                cleanup_mic_test_sample(&mut state);
            }
            CaptureCmd::SetMicrophone { id, name } => {
                state.preferred_id = id.filter(|id| !id.is_empty());
                state.preferred_name = name.filter(|name| !name.is_empty());
                let selected_id = state.preferred_id.clone().unwrap_or_default();
                let selected_name = state
                    .preferred_name
                    .clone()
                    .unwrap_or_else(|| "Auto-detect".to_string());
                state.emit(json!({
                    "type": "microphone_selected",
                    "payload": { "id": selected_id, "name": selected_name },
                }));
                emit_microphone_devices(&state);
            }
            CaptureCmd::ListMicrophones => emit_microphone_devices(&state),
            CaptureCmd::Paste { text } => paste_transcript(&mut state, text),
            CaptureCmd::Reset => reset_recording(&mut state, false),
        }
    }
}

fn emit_microphone_devices(state: &CaptureState) {
    let host = cpal::default_host();
    let devices: Vec<Value> = host
        .input_devices()
        .map(|devices| {
            devices
                .filter_map(|device| device.name().ok())
                .map(|name| json!({ "id": name.clone(), "name": name }))
                .collect()
        })
        .unwrap_or_default();
    let mut payload = json!({
        "devices": devices,
        "selectedID": state.preferred_id.clone().unwrap_or_default(),
    });
    if let Some(name) = host
        .default_input_device()
        .and_then(|device| device.name().ok())
    {
        payload["defaultDevice"] = json!({ "id": name.clone(), "name": name });
    }
    state.emit(json!({ "type": "microphone_devices", "payload": payload }));
}

fn recording_error_event(purpose: Purpose, code: &str, message: &str) -> Value {
    let event_type = match purpose {
        Purpose::Dictation => "error",
        Purpose::MicTest => "mic_test_error",
    };
    json!({ "type": event_type, "payload": { "code": code, "message": message } })
}

fn start_recording(state: &mut CaptureState, purpose: Purpose, duration: Option<Duration>) {
    if state.listening() {
        state.emit(match purpose {
            Purpose::Dictation => recording_error_event(
                Purpose::Dictation,
                "already_listening",
                "Dictation is already listening.",
            ),
            Purpose::MicTest => recording_error_event(
                Purpose::MicTest,
                "already_listening",
                "Audio capture is already running.",
            ),
        });
        return;
    }
    cleanup_mic_test_sample(state);

    let host = cpal::default_host();
    let pinned = state.preferred_id.is_some() || state.preferred_name.is_some();
    let device = pinned
        .then(|| {
            host.input_devices().ok().and_then(|mut devices| {
                devices.find(|device| {
                    device.name().is_ok_and(|name| {
                        state.preferred_id.as_deref() == Some(name.as_str())
                            || state.preferred_name.as_deref() == Some(name.as_str())
                    })
                })
            })
        })
        .flatten()
        .or_else(|| host.default_input_device());
    let Some(device) = device else {
        state.emit(recording_error_event(
            purpose,
            "microphone_permission_missing",
            "Microphone permission is required.",
        ));
        state.emit(permission_status_event());
        return;
    };
    let microphone_label = if pinned {
        device.name().unwrap_or_else(|_| "Auto-detect".to_string())
    } else {
        "Auto-detect".to_string()
    };

    let config = match device.default_input_config() {
        Ok(config) => config,
        Err(error) => {
            state.emit(recording_error_event(
                purpose,
                "audio_start_failed",
                &error.to_string(),
            ));
            return;
        }
    };

    let path = std::env::temp_dir().join(format!("os-june-dictation-{}.wav", uuid::Uuid::new_v4()));
    let spec = hound::WavSpec {
        channels: config.channels(),
        sample_rate: config.sample_rate().0,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let writer = match hound::WavWriter::create(&path, spec) {
        Ok(writer) => writer,
        Err(error) => {
            state.emit(recording_error_event(
                purpose,
                "audio_start_failed",
                &error.to_string(),
            ));
            return;
        }
    };
    let writer: SharedWavWriter = Arc::new(Mutex::new(Some(writer)));
    let max_level = Arc::new(AtomicU32::new(0f32.to_bits()));

    let mut meter = LevelMeter {
        events: state.events.clone(),
        purpose,
        max_level: Arc::clone(&max_level),
        pending: 0.0,
        last_emit: Instant::now(),
    };
    let callback_writer = Arc::clone(&writer);
    let err_fn = |error| tracing::warn!(%error, "dictation input stream error");
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.clone().into(),
            move |data: &[f32], _| {
                write_chunk(data.iter().copied(), &callback_writer, &mut meter);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.clone().into(),
            move |data: &[i16], _| {
                write_chunk(
                    data.iter().map(|sample| *sample as f32 / i16::MAX as f32),
                    &callback_writer,
                    &mut meter,
                );
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config.clone().into(),
            move |data: &[u16], _| {
                write_chunk(
                    data.iter()
                        .map(|sample| (*sample as f32 - 32768.0) / 32768.0),
                    &callback_writer,
                    &mut meter,
                );
            },
            err_fn,
            None,
        ),
        _ => {
            let _ = fs::remove_file(&path);
            state.emit(recording_error_event(
                purpose,
                "audio_start_failed",
                "Unsupported microphone sample format.",
            ));
            return;
        }
    };
    let stream = match stream {
        Ok(stream) => stream,
        Err(error) => {
            let _ = fs::remove_file(&path);
            state.emit(recording_error_event(
                purpose,
                "audio_start_failed",
                &error.to_string(),
            ));
            return;
        }
    };
    if let Err(error) = stream.play() {
        let _ = fs::remove_file(&path);
        state.emit(recording_error_event(
            purpose,
            "audio_start_failed",
            &error.to_string(),
        ));
        return;
    }

    let now = Instant::now();
    let deadline = duration.map(|duration| now + duration + MIC_TEST_PADDING);
    state.recording = Some(ActiveRecording {
        stream,
        writer,
        path,
        purpose,
        started_at: now,
        max_level,
        deadline,
    });

    match purpose {
        Purpose::Dictation => state.emit(json!({
            "type": "listening_started",
            "payload": {
                "recognitionMode": "venice_recording",
                "microphone": microphone_label,
            },
        })),
        Purpose::MicTest => state.emit(json!({
            "type": "mic_test_started",
            "payload": {
                "durationMs": duration.unwrap_or(Duration::from_secs(5)).as_millis() as u64,
                "microphone": microphone_label,
            },
        })),
    }
}

fn stop_dictation(state: &mut CaptureState) {
    let is_dictation = state
        .recording
        .as_ref()
        .is_some_and(|recording| recording.purpose == Purpose::Dictation);
    if !is_dictation {
        state.emit(error_event("not_listening", "Dictation is not listening."));
        return;
    }
    state.emit(json!({ "type": "finalizing_transcript", "payload": {} }));
    finalize_recording(state);
}

/// Stop the stream, close the WAV, and emit recording_ready / mic_test_ready.
fn finalize_recording(state: &mut CaptureState) {
    let Some(recording) = state.recording.take() else {
        return;
    };
    let ActiveRecording {
        stream,
        writer,
        path,
        purpose,
        started_at,
        max_level,
        ..
    } = recording;
    drop(stream);
    let finalize_result = writer
        .lock()
        .ok()
        .and_then(|mut writer| writer.take())
        .map(hound::WavWriter::finalize);

    let observed = f32::from_bits(max_level.load(Ordering::Relaxed));
    let wrote_audio = matches!(finalize_result, Some(Ok(())))
        && fs::metadata(&path)
            .map(|meta| meta.len() > 44)
            .unwrap_or(false);
    if !wrote_audio {
        let _ = fs::remove_file(&path);
        state.emit(recording_error_event(
            purpose,
            "missing_recording",
            "No recorded audio was available to transcribe.",
        ));
        return;
    }

    match purpose {
        Purpose::Dictation => {
            state.emit(json!({
                "type": "recording_ready",
                "payload": {
                    "path": path.to_string_lossy(),
                    "observedAudioLevel": format!("{observed:.4}"),
                },
            }));
            state.finalized_path = Some(path);
        }
        Purpose::MicTest => {
            let duration_ms = started_at.elapsed().as_millis() as u64;
            state.emit(json!({
                "type": "mic_test_ready",
                "payload": {
                    "path": path.to_string_lossy(),
                    "durationMs": duration_ms,
                    "observedAudioLevel": format!("{observed:.4}"),
                },
            }));
            state.mic_test_sample = Some(path);
        }
    }
}

fn discard_recording(state: &mut CaptureState) {
    let was_listening = state.recording.is_some();
    reset_recording(state, false);
    if was_listening {
        state.emit(json!({ "type": "recording_discarded", "payload": {} }));
    }
}

fn paste_transcript(state: &mut CaptureState, text: String) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        state.emit(error_event(
            "empty_transcript",
            "No transcript text was available to paste.",
        ));
        reset_recording(state, false);
        return;
    }
    // Trailing space so consecutive dictations don't run together, matching
    // the Swift helper's dictationPasteText.
    let text = format!("{trimmed} ");
    state.emit(json!({
        "type": "final_transcript",
        "payload": { "text": text },
    }));
    let events = state.events.clone();
    thread::Builder::new()
        .name("dictation-win-paste".into())
        .spawn(move || paste_worker(text, events))
        .ok();
    reset_recording(state, false);
}

fn reset_recording(state: &mut CaptureState, keep_recording_file: bool) {
    if let Some(recording) = state.recording.take() {
        drop(recording.stream);
        if let Ok(mut writer) = recording.writer.lock() {
            if let Some(writer) = writer.take() {
                let _ = writer.finalize();
            }
        }
        if !keep_recording_file {
            let _ = fs::remove_file(&recording.path);
        }
    }
    if let Some(path) = state.finalized_path.take() {
        let _ = fs::remove_file(path);
    }
}

fn cleanup_mic_test_sample(state: &mut CaptureState) {
    if let Some(path) = state.mic_test_sample.take() {
        let _ = fs::remove_file(path);
    }
}

struct LevelMeter {
    events: mpsc::Sender<Value>,
    purpose: Purpose,
    max_level: Arc<AtomicU32>,
    pending: f32,
    last_emit: Instant,
}

impl LevelMeter {
    /// Level formula and coalescing mirror the Swift helper: per chunk,
    /// `min(1, peak * 0.8 + rms * 0.2)`, emitted at most every 40ms with the
    /// max held across skipped chunks so transients still register.
    fn observe(&mut self, peak: f32, rms: f32) {
        let level = (peak * 0.8 + rms * 0.2).min(1.0);
        let previous = f32::from_bits(self.max_level.load(Ordering::Relaxed));
        if level > previous {
            self.max_level.store(level.to_bits(), Ordering::Relaxed);
        }
        self.pending = self.pending.max(level);
        let now = Instant::now();
        if now.duration_since(self.last_emit) < LEVEL_EMIT_INTERVAL {
            return;
        }
        self.last_emit = now;
        let coalesced = self.pending;
        self.pending = 0.0;
        let event_type = match self.purpose {
            Purpose::Dictation => "audio_level",
            Purpose::MicTest => "mic_test_level",
        };
        let _ = self.events.send(json!({
            "type": event_type,
            "payload": { "level": format!("{coalesced:.4}") },
        }));
    }
}

fn write_chunk<I>(samples: I, writer: &SharedWavWriter, meter: &mut LevelMeter)
where
    I: Iterator<Item = f32>,
{
    let mut guard = match writer.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let Some(writer) = guard.as_mut() else {
        return;
    };
    let mut peak = 0f32;
    let mut sum_squares = 0f64;
    let mut count = 0u32;
    for sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        peak = peak.max(clamped.abs());
        sum_squares += f64::from(clamped) * f64::from(clamped);
        count += 1;
        let _ = writer.write_sample((clamped * i16::MAX as f32) as i16);
    }
    drop(guard);
    if count > 0 {
        let rms = (sum_squares / f64::from(count)).sqrt() as f32;
        meter.observe(peak, rms);
    }
}

// ---------------------------------------------------------------------------
// Paste (clipboard + SendInput)
// ---------------------------------------------------------------------------

fn paste_worker(text: String, events: mpsc::Sender<Value>) {
    let emit = |event: Value| {
        let _ = events.send(event);
    };

    // CF_UNICODETEXT round-trip only: non-text clipboard content (images,
    // files) cannot be snapshotted this way, so in that case the transcript
    // is left on the clipboard instead of destroying the content.
    let snapshot = read_clipboard_text();
    if let Err(message) = set_clipboard_text(&text) {
        emit(error_event(
            "pasteboard_write_failed",
            &format!("Could not write transcript to the clipboard: {message}"),
        ));
        return;
    }

    emit(json!({
        "type": "paste_target",
        "payload": {
            "app": foreground_app_name(),
            "activated": "granted",
        },
    }));

    thread::sleep(PASTE_KEYSTROKE_DELAY);
    send_ctrl_v();
    emit(json!({ "type": "paste_completed", "payload": {} }));

    thread::sleep(CLIPBOARD_RESTORE_DELAY.saturating_sub(PASTE_KEYSTROKE_DELAY));
    if read_clipboard_text().as_deref() == Some(text.as_str()) {
        if let Some(previous) = snapshot {
            let _ = set_clipboard_text(&previous);
        }
    }
}

/// Open the clipboard, retrying briefly: another app can hold it.
fn open_clipboard_with_retry() -> bool {
    for _ in 0..10 {
        if unsafe { OpenClipboard(None) }.is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(15));
    }
    false
}

fn read_clipboard_text() -> Option<String> {
    if !open_clipboard_with_retry() {
        return None;
    }
    let text = unsafe {
        GetClipboardData(CF_UNICODETEXT).ok().and_then(|handle| {
            let hglobal = HGLOBAL(handle.0);
            let pointer = GlobalLock(hglobal) as *const u16;
            if pointer.is_null() {
                return None;
            }
            let mut length = 0usize;
            while *pointer.add(length) != 0 {
                length += 1;
            }
            let slice = std::slice::from_raw_parts(pointer, length);
            let text = String::from_utf16_lossy(slice);
            let _ = GlobalUnlock(hglobal);
            Some(text)
        })
    };
    unsafe {
        let _ = CloseClipboard();
    }
    text
}

fn set_clipboard_text(text: &str) -> Result<(), String> {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    if !open_clipboard_with_retry() {
        return Err("clipboard is busy".to_string());
    }
    let result = unsafe {
        (|| -> Result<(), String> {
            EmptyClipboard().map_err(|error| error.to_string())?;
            let hglobal =
                GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2).map_err(|error| error.to_string())?;
            let pointer = GlobalLock(hglobal) as *mut u16;
            if pointer.is_null() {
                return Err("could not lock clipboard memory".to_string());
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), pointer, wide.len());
            let _ = GlobalUnlock(hglobal);
            // On success the system owns the allocation.
            SetClipboardData(CF_UNICODETEXT, Some(HANDLE(hglobal.0)))
                .map_err(|error| error.to_string())?;
            Ok(())
        })()
    };
    unsafe {
        let _ = CloseClipboard();
    }
    result
}

fn keyboard_input(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Synthesize Ctrl+V. Any physically held Shift/Alt/Win is released first so
/// a not-yet-lifted shortcut chord cannot turn the paste into Ctrl+Alt+V.
fn send_ctrl_v() {
    let mut inputs: Vec<INPUT> = Vec::with_capacity(8);
    unsafe {
        for vk in [VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN] {
            if (GetAsyncKeyState(vk.0 as i32) as u16) & 0x8000 != 0 {
                inputs.push(keyboard_input(vk, true));
            }
        }
    }
    inputs.push(keyboard_input(VK_CONTROL, false));
    inputs.push(keyboard_input(VK_V, false));
    inputs.push(keyboard_input(VK_V, true));
    inputs.push(keyboard_input(VK_CONTROL, true));
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

fn foreground_app_name() -> String {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return "unknown".to_string();
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return "unknown".to_string();
        }
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return "unknown".to_string();
        };
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let name = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
        .ok()
        .and_then(|_| {
            let path = String::from_utf16_lossy(&buffer[..length as usize]);
            std::path::Path::new(&path)
                .file_stem()
                .map(|stem| stem.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "unknown".to_string());
        let _ = CloseHandle(process);
        name
    }
}
