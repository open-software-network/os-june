//! Windows dictation backend — the platform twin of the macOS Swift dictation
//! helper (`src-tauri/native/mac-dictation-helper/main.swift`).
//!
//! On macOS a separate Swift process owns global shortcut listening, microphone
//! capture, focus tracking and paste injection, and talks to `dictation.rs`
//! over a JSON line protocol. Windows has every one of those capabilities
//! available in-process through Win32, so instead of a second binary this
//! module runs an in-process helper that speaks the exact same event/command
//! protocol:
//!
//! * shortcut edges are emitted as `shortcut_key_down` / `shortcut_key_up`
//!   events (kind `toggle` / `push_to_talk`) that flow into the shared
//!   [`crate::dictation`] activation controller, which decides start/stop;
//! * microphone capture writes the same 16-bit PCM WAV the note-recording path
//!   produces (via `cpal`/`hound`) and reports `recording_ready` with the
//!   foreground executable as the paste target;
//! * `paste_text` sets the clipboard and synthesizes Ctrl+V, restoring the
//!   prior clipboard text afterwards.
//!
//! The transcription and cleanup pipeline stays entirely in `dictation.rs` and
//! is shared with macOS. Only the pure, platform-neutral helpers below (key
//! mapping, modifier labels) are compiled off-Windows so they can be unit
//! tested on the host; everything that touches Win32 is behind
//! `cfg(target_os = "windows")`.

use crate::dictation::{DictationShortcutKind, DictationShortcutModifiers};

/// Maps a subset of DOM `KeyboardEvent.code` values (how dictation shortcuts
/// are stored, platform-neutrally) to Windows virtual-key codes. Covers the
/// letters, digits and a handful of common keys that a dictation shortcut is
/// realistically bound to; anything outside the table (e.g. the macOS-only
/// bare `Fn` or modifier-only chords) has no Windows equivalent and disables
/// hook matching for that shortcut.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn vk_for_code(code: &str) -> Option<u16> {
    // Letters: "KeyA".."KeyZ" -> 0x41..0x5A (VK == ASCII uppercase).
    if let Some(letter) = code.strip_prefix("Key") {
        let mut chars = letter.chars();
        if let (Some(ch), None) = (chars.next(), chars.next()) {
            if ch.is_ascii_alphabetic() {
                return Some(ch.to_ascii_uppercase() as u16);
            }
        }
    }
    // Digit row: "Digit0".."Digit9" -> 0x30..0x39.
    if let Some(digit) = code.strip_prefix("Digit") {
        let mut chars = digit.chars();
        if let (Some(ch), None) = (chars.next(), chars.next()) {
            if ch.is_ascii_digit() {
                return Some(ch as u16);
            }
        }
    }
    Some(match code {
        "Space" => 0x20,
        "Enter" => 0x0D,
        "Tab" => 0x09,
        "Backquote" => 0xC0,
        "Minus" => 0xBD,
        "Equal" => 0xBB,
        "BracketLeft" => 0xDB,
        "BracketRight" => 0xDD,
        "Backslash" => 0xDC,
        "Semicolon" => 0xBA,
        "Quote" => 0xDE,
        "Comma" => 0xBC,
        "Period" => 0xBE,
        "Slash" => 0xBF,
        "F1" => 0x70,
        "F2" => 0x71,
        "F3" => 0x72,
        "F4" => 0x73,
        "F5" => 0x74,
        "F6" => 0x75,
        "F7" => 0x76,
        "F8" => 0x77,
        "F9" => 0x78,
        "F10" => 0x79,
        "F11" => 0x7A,
        "F12" => 0x7B,
        _ => return None,
    })
}

/// Inverse of [`vk_for_code`] for the interactive shortcut-capture flow: turns
/// a captured virtual-key code back into a DOM `KeyboardEvent.code` the
/// settings UI understands.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn code_for_vk(vk: u16) -> Option<String> {
    match vk {
        0x41..=0x5A => Some(format!("Key{}", (vk as u8) as char)),
        0x30..=0x39 => Some(format!("Digit{}", (vk as u8) as char)),
        0x20 => Some("Space".to_string()),
        0x0D => Some("Enter".to_string()),
        0x09 => Some("Tab".to_string()),
        0xC0 => Some("Backquote".to_string()),
        0xBD => Some("Minus".to_string()),
        0xBB => Some("Equal".to_string()),
        0xDB => Some("BracketLeft".to_string()),
        0xDD => Some("BracketRight".to_string()),
        0xDC => Some("Backslash".to_string()),
        0xBA => Some("Semicolon".to_string()),
        0xDE => Some("Quote".to_string()),
        0xBC => Some("Comma".to_string()),
        0xBE => Some("Period".to_string()),
        0xBF => Some("Slash".to_string()),
        0x70..=0x7B => Some(format!("F{}", vk - 0x6F)),
        _ => None,
    }
}

/// Human-readable key label for the non-modifier key of a captured shortcut,
/// e.g. VK `0x44` -> "D", `0x20` -> "Space".
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn key_label_for_vk(vk: u16) -> Option<String> {
    match vk {
        0x41..=0x5A => Some(((vk as u8) as char).to_string()),
        0x30..=0x39 => Some(((vk as u8) as char).to_string()),
        0x20 => Some("Space".to_string()),
        0x0D => Some("Enter".to_string()),
        0x09 => Some("Tab".to_string()),
        0x70..=0x7B => Some(format!("F{}", vk - 0x6F)),
        _ => code_for_vk(vk),
    }
}

/// Windows-flavored shortcut label from modifiers plus a key label. Mirrors the
/// order the macOS helper uses but with Windows modifier names (Ctrl / Alt /
/// Win / Shift) so the settings copy reads correctly on Windows.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn windows_shortcut_label(modifiers: &DictationShortcutModifiers, key: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if modifiers.control {
        parts.push("Ctrl");
    }
    if modifiers.option {
        parts.push("Alt");
    }
    if modifiers.command {
        parts.push("Win");
    }
    if modifiers.shift {
        parts.push("Shift");
    }
    let mut label = parts.join("+");
    if !key.is_empty() {
        if !label.is_empty() {
            label.push('+');
        }
        label.push_str(key);
    }
    label
}

/// Whether a stored shortcut can be matched by the Windows keyboard hook. The
/// macOS bare-`Fn` and modifier-only chords have no Windows equivalent, and a
/// shortcut with no modifier would be a global key eater; both are rejected so
/// the hook only ever fires on a real, modified key combo.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn shortcut_is_supported(code: &str, modifiers: &DictationShortcutModifiers) -> bool {
    vk_for_code(code).is_some() && (modifiers.control || modifiers.option || modifiers.command)
}

/// What the keyboard hook should do for one key event of a (potential)
/// trigger key.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ShortcutEdgeAction {
    /// Not a shortcut interaction: let the event through to the focused app.
    PassThrough,
    /// A newly pressed trigger: dispatch the down edge and swallow the key.
    DispatchDown(DictationShortcutKind),
    /// OS key repeat for a held, already-suppressed trigger: swallow it
    /// without dispatching. A repeat is not a new press; re-dispatching the
    /// down edge would make the shared activation controller re-toggle
    /// (starting and then immediately stopping dictation on a held toggle
    /// chord).
    SwallowRepeat,
    /// Release of a suppressed trigger: dispatch the up edge and swallow.
    DispatchUp(DictationShortcutKind),
}

/// Pure decision for a trigger-key edge, factored out of the raw hook
/// callback so it is unit-testable on any host. `injected` is the
/// KBDLLHOOKSTRUCT LLKHF_INJECTED / LLKHF_LOWER_IL_INJECTED state: injected
/// events always pass through untouched, regardless of any shortcut match —
/// our own synthesized Ctrl+V paste travels back through the same low-level
/// hook, and matching it would swallow the V (so the target app never
/// receives the paste) or re-trigger dictation mid-paste for a user who bound
/// a colliding chord. `matched` is the shortcut the key+modifiers currently
/// match (down edges only); `suppressed_kind` is set when this key's down
/// edge was already suppressed and is still held. A held key whose repeats
/// arrive is swallowed even if the modifiers were released mid-hold
/// (`matched` gone), so a suppressed trigger can never leak repeats into the
/// focused app before its release.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn shortcut_edge_action(
    injected: bool,
    is_down: bool,
    matched: Option<DictationShortcutKind>,
    suppressed_kind: Option<DictationShortcutKind>,
) -> ShortcutEdgeAction {
    if injected {
        return ShortcutEdgeAction::PassThrough;
    }
    if is_down {
        if suppressed_kind.is_some() {
            return ShortcutEdgeAction::SwallowRepeat;
        }
        match matched {
            Some(kind) => ShortcutEdgeAction::DispatchDown(kind),
            None => ShortcutEdgeAction::PassThrough,
        }
    } else {
        match suppressed_kind {
            Some(kind) => ShortcutEdgeAction::DispatchUp(kind),
            None => ShortcutEdgeAction::PassThrough,
        }
    }
}

#[cfg(target_os = "windows")]
pub use windows_impl::{dispatch, init, shutdown};

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{
        code_for_vk, key_label_for_vk, shortcut_is_supported, vk_for_code, windows_shortcut_label,
    };
    use crate::dictation::{
        ingest_helper_event, DictationShortcutKind, DictationShortcutModifiers,
    };
    use crate::domain::types::AppError;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use hound::{SampleFormat, WavSpec, WavWriter};
    use serde_json::json;
    use std::fs::File;
    use std::io::BufWriter;
    use std::path::PathBuf;
    use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::Duration;
    use tauri::AppHandle;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, GlobalFree, HANDLE, HGLOBAL, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM,
    };
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_UNICODETEXT;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_KEYUP, VIRTUAL_KEY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
        SetForegroundWindow, SetWindowsHookExW, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_INJECTED,
        LLKHF_LOWER_IL_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN,
        WM_SYSKEYUP,
    };

    const VK_CONTROL: i32 = 0x11;
    const VK_MENU: i32 = 0x12;
    const VK_SHIFT: i32 = 0x10;
    const VK_LWIN: i32 = 0x5B;
    const VK_RWIN: i32 = 0x5C;
    const VK_V: u16 = 0x56;
    const VK_CONTROL_U16: u16 = 0x11;

    /// A shortcut resolved for the keyboard hook: the trigger virtual-key plus
    /// the exact modifier combination that must be held.
    #[derive(Clone, Copy)]
    struct WinShortcut {
        kind: DictationShortcutKind,
        vk: u16,
        ctrl: bool,
        alt: bool,
        shift: bool,
        win: bool,
    }

    impl WinShortcut {
        fn modifiers_match(&self) -> bool {
            modifier_down(VK_CONTROL) == self.ctrl
                && modifier_down(VK_MENU) == self.alt
                && modifier_down(VK_SHIFT) == self.shift
                && (modifier_down(VK_LWIN) || modifier_down(VK_RWIN)) == self.win
        }
    }

    /// State the low-level keyboard hook reads on every key event. Guarded by a
    /// mutex that the hook proc only ever `try_lock`s, so a slow lock can never
    /// stall global input.
    struct HookState {
        shortcuts: Vec<WinShortcut>,
        /// When set, the next non-modifier key is recorded and reported as a
        /// captured shortcut instead of being matched.
        capturing: bool,
        /// Trigger keys whose down-edge we suppressed, so their up-edge is
        /// suppressed too and reported as a release.
        suppressed: Vec<(u16, DictationShortcutKind)>,
    }

    struct Helper {
        worker: Sender<WorkerMsg>,
    }

    static HELPER: OnceLock<Helper> = OnceLock::new();
    static HOOK_STATE: OnceLock<Mutex<HookState>> = OnceLock::new();
    static WORKER_SENDER: OnceLock<Sender<WorkerMsg>> = OnceLock::new();

    enum WorkerMsg {
        ShortcutEdge {
            kind: DictationShortcutKind,
            down: bool,
        },
        Captured {
            code: String,
            label: String,
            modifiers: DictationShortcutModifiers,
        },
        Command(serde_json::Value),
    }

    /// Initializes the in-process helper: spawns the capture/command worker and
    /// installs the global keyboard hook. Called once from `dictation::setup`
    /// before any shortcut/microphone settings are applied.
    pub fn init(app: &AppHandle) {
        if HELPER.get().is_some() {
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel::<WorkerMsg>();
        let _ = HOOK_STATE.set(Mutex::new(HookState {
            shortcuts: Vec::new(),
            capturing: false,
            suppressed: Vec::new(),
        }));
        let _ = WORKER_SENDER.set(tx.clone());
        let _ = HELPER.set(Helper { worker: tx });

        let worker_app = app.clone();
        std::thread::Builder::new()
            .name("june-dictation-worker".into())
            .spawn(move || run_worker(worker_app, rx))
            .ok();

        std::thread::Builder::new()
            .name("june-dictation-hook".into())
            .spawn(run_hook_thread)
            .ok();

        ingest_helper_event(app, json!({ "type": "ready" }));
    }

    /// Routes a helper command from `dictation.rs`. Capture- and paste-related
    /// commands are serialized onto the worker thread; hook configuration is
    /// applied inline. Unknown commands are accepted as no-ops so the shared
    /// command surface stays forgiving.
    pub fn dispatch(command: serde_json::Value) -> Result<(), AppError> {
        let kind = command
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        match kind {
            "set_shortcut" => {
                apply_set_shortcut(&command);
                Ok(())
            }
            "start_shortcut_capture" => {
                set_capturing(true);
                emit(json!({ "type": "shortcut_capture_started" }));
                Ok(())
            }
            "cancel_shortcut_capture" => {
                set_capturing(false);
                emit(json!({ "type": "shortcut_capture_cancelled" }));
                Ok(())
            }
            _ => send_worker(WorkerMsg::Command(command)),
        }
    }

    /// Stops the worker on app teardown. The global keyboard hook is torn down
    /// by process exit.
    pub fn shutdown() {
        let _ = send_worker(WorkerMsg::Command(json!({ "type": "shutdown" })));
    }

    fn send_worker(msg: WorkerMsg) -> Result<(), AppError> {
        let Some(helper) = HELPER.get() else {
            return Err(AppError::new(
                "dictation_helper_unavailable",
                "Windows dictation helper is not initialized.",
            ));
        };
        helper.worker.send(msg).map_err(|_| {
            AppError::new(
                "dictation_helper_unavailable",
                "Windows dictation worker is not running.",
            )
        })
    }

    fn emit(event: serde_json::Value) {
        if let Some(helper) = HELPER.get() {
            let _ = helper.worker.send(WorkerMsg::Command(json!({
                "type": "__emit",
                "event": event,
            })));
        }
    }

    fn set_capturing(on: bool) {
        if let Some(state) = HOOK_STATE.get() {
            if let Ok(mut guard) = state.lock() {
                guard.capturing = on;
            }
        }
    }

    fn apply_set_shortcut(command: &serde_json::Value) {
        let Some(shortcut) = command.get("shortcut") else {
            return;
        };
        let kind = match shortcut.get("kind").and_then(serde_json::Value::as_str) {
            Some("push_to_talk") => DictationShortcutKind::PushToTalk,
            Some("toggle") => DictationShortcutKind::Toggle,
            _ => return,
        };
        let code = shortcut
            .get("code")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let modifiers: DictationShortcutModifiers = shortcut
            .get("modifiers")
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_default();

        let resolved = if shortcut_is_supported(code, &modifiers) {
            vk_for_code(code).map(|vk| WinShortcut {
                kind,
                vk,
                ctrl: modifiers.control,
                alt: modifiers.option,
                shift: modifiers.shift,
                win: modifiers.command,
            })
        } else {
            None
        };

        if let Some(state) = HOOK_STATE.get() {
            if let Ok(mut guard) = state.lock() {
                guard.shortcuts.retain(|existing| existing.kind != kind);
                if let Some(resolved) = resolved {
                    guard.shortcuts.push(resolved);
                }
            }
        }
    }

    // ---- keyboard hook ----------------------------------------------------

    fn run_hook_thread() {
        unsafe {
            let module = GetModuleHandleW(PCWSTR::null()).unwrap_or_default();
            let hook = SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(keyboard_hook_proc),
                HINSTANCE(module.0),
                0,
            );
            if hook.is_err() {
                return;
            }
            // Low-level hooks require the installing thread to pump messages;
            // the proc itself runs between GetMessage calls.
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, HWND(0), 0, 0).as_bool() {}
        }
    }

    unsafe extern "system" fn keyboard_hook_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code == HC_ACTION as i32 {
            let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let message = wparam.0 as u32;
            let vk = info.vkCode as u16;
            let is_down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            let is_up = message == WM_KEYUP || message == WM_SYSKEYUP;
            // Synthesized input (including our own SendInput Ctrl+V paste)
            // arrives back through this hook flagged as injected; it must
            // never be treated as shortcut input or shortcut capture.
            let injected = (info.flags.0 & (LLKHF_INJECTED.0 | LLKHF_LOWER_IL_INJECTED.0)) != 0;
            if (is_down || is_up) && process_key(vk, is_down, injected) {
                // Swallow the trigger key so the shortcut doesn't leak into the
                // focused app (e.g. typing the push-to-talk key while dictating).
                return LRESULT(1);
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    /// Pure-ish hook decision: matches the key against configured shortcuts (or
    /// records it in capture mode) and returns whether to suppress it. Only ever
    /// `try_lock`s the shared state so it can never block global input.
    fn process_key(vk: u16, is_down: bool, injected: bool) -> bool {
        let Some(state) = HOOK_STATE.get() else {
            return false;
        };
        let Ok(mut guard) = state.try_lock() else {
            return false;
        };

        if guard.capturing {
            // Injected keys must not be recorded as a captured shortcut
            // either (e.g. a paste synthesized while the capture UI is open).
            if !injected && is_down && !is_modifier_vk(vk) {
                guard.capturing = false;
                let modifiers = current_modifiers();
                if let Some(code) = code_for_vk(vk) {
                    let key = key_label_for_vk(vk).unwrap_or_else(|| code.clone());
                    let label = windows_shortcut_label(&modifiers, &key);
                    dispatch_worker(WorkerMsg::Captured {
                        code,
                        label,
                        modifiers,
                    });
                } else {
                    dispatch_worker(WorkerMsg::Command(json!({
                        "type": "__emit",
                        "event": {
                            "type": "shortcut_capture_error",
                            "payload": { "message": "That key can't be used as a Windows shortcut." },
                        },
                    })));
                }
                return true;
            }
            return false;
        }

        let matched = if is_down {
            guard
                .shortcuts
                .iter()
                .find(|shortcut| shortcut.vk == vk && shortcut.modifiers_match())
                .map(|shortcut| shortcut.kind)
        } else {
            None
        };
        let suppressed_kind = guard
            .suppressed
            .iter()
            .find(|(held, _)| *held == vk)
            .map(|(_, kind)| *kind);

        match super::shortcut_edge_action(injected, is_down, matched, suppressed_kind) {
            super::ShortcutEdgeAction::PassThrough => false,
            super::ShortcutEdgeAction::SwallowRepeat => true,
            super::ShortcutEdgeAction::DispatchDown(kind) => {
                guard.suppressed.push((vk, kind));
                dispatch_worker(WorkerMsg::ShortcutEdge { kind, down: true });
                true
            }
            super::ShortcutEdgeAction::DispatchUp(kind) => {
                guard.suppressed.retain(|(held, _)| *held != vk);
                dispatch_worker(WorkerMsg::ShortcutEdge { kind, down: false });
                true
            }
        }
    }

    fn dispatch_worker(msg: WorkerMsg) {
        if let Some(sender) = WORKER_SENDER.get() {
            let _ = sender.send(msg);
        }
    }

    fn is_modifier_vk(vk: u16) -> bool {
        matches!(
            vk as i32,
            VK_CONTROL | VK_MENU | VK_SHIFT | VK_LWIN | VK_RWIN
        ) || vk == 0xA0 // LSHIFT
            || vk == 0xA1 // RSHIFT
            || vk == 0xA2 // LCONTROL
            || vk == 0xA3 // RCONTROL
            || vk == 0xA4 // LMENU
            || vk == 0xA5 // RMENU
    }

    fn modifier_down(vk: i32) -> bool {
        unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 }
    }

    fn current_modifiers() -> DictationShortcutModifiers {
        DictationShortcutModifiers {
            command: modifier_down(VK_LWIN) || modifier_down(VK_RWIN),
            control: modifier_down(VK_CONTROL),
            option: modifier_down(VK_MENU),
            shift: modifier_down(VK_SHIFT),
            function: false,
        }
    }

    // ---- capture / command worker ----------------------------------------

    #[derive(Default)]
    struct LevelState {
        /// Peak since the last audio_level tick (drives the live meter).
        interval_peak: f32,
        /// Max level seen for the whole utterance (reported with recording_ready).
        observed_max: f32,
    }

    struct CaptureSession {
        path: PathBuf,
        writer: Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>,
        level: Arc<Mutex<LevelState>>,
        _stream: cpal::Stream,
    }

    struct Worker {
        app: AppHandle,
        listening: bool,
        capture: Option<CaptureSession>,
        last_recording: Option<PathBuf>,
        target: Option<(isize, String)>,
        selected_mic: Option<String>,
    }

    fn run_worker(app: AppHandle, rx: Receiver<WorkerMsg>) {
        let mut worker = Worker {
            app,
            listening: false,
            capture: None,
            last_recording: None,
            target: None,
            selected_mic: None,
        };
        loop {
            match rx.recv_timeout(Duration::from_millis(60)) {
                Ok(msg) => {
                    if worker.handle(msg) {
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout) => worker.tick_level(),
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    }

    impl Worker {
        /// Returns true when the worker should stop.
        fn handle(&mut self, msg: WorkerMsg) -> bool {
            match msg {
                WorkerMsg::ShortcutEdge { kind, down } => {
                    let event_type = if down {
                        "shortcut_key_down"
                    } else {
                        "shortcut_key_up"
                    };
                    let payload_kind = match kind {
                        DictationShortcutKind::PushToTalk => "push_to_talk",
                        DictationShortcutKind::Toggle => "toggle",
                    };
                    self.emit(json!({
                        "type": event_type,
                        "payload": { "kind": payload_kind },
                    }));
                }
                WorkerMsg::Captured {
                    code,
                    label,
                    modifiers,
                } => {
                    self.emit(json!({
                        "type": "shortcut_captured",
                        "payload": {
                            "shortcut": {
                                "code": code,
                                "label": label,
                                "modifiers": modifiers,
                                "pressCount": 1,
                            },
                        },
                    }));
                }
                WorkerMsg::Command(command) => return self.handle_command(command),
            }
            false
        }

        fn handle_command(&mut self, command: serde_json::Value) -> bool {
            let kind = command
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            match kind {
                "__emit" => {
                    if let Some(event) = command.get("event") {
                        self.emit(event.clone());
                    }
                }
                "start_listening" => self.start(),
                "stop_and_paste" => self.stop(),
                "discard_recording" => self.discard(),
                "toggle_listening" => {
                    let shortcut = command
                        .get("shortcut")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("hotkey")
                        .to_string();
                    if self.listening {
                        self.emit(json!({
                            "type": "hotkey_trigger",
                            "payload": { "action": "stop", "shortcut": shortcut },
                        }));
                        self.stop();
                    } else {
                        self.emit(json!({
                            "type": "hotkey_trigger",
                            "payload": { "action": "start", "shortcut": shortcut },
                        }));
                        self.start();
                    }
                }
                "paste_text" => {
                    let text = command
                        .get("text")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    self.paste(text);
                }
                "set_microphone" => {
                    self.selected_mic = command
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .filter(|name| !name.trim().is_empty())
                        .map(str::to_string);
                }
                "list_microphones" => self.emit_microphones(),
                "get_permission_status" | "request_microphone_permission" => {
                    self.emit_permission_status()
                }
                "shutdown" => {
                    self.discard();
                    self.emit(json!({ "type": "shutdown_ack" }));
                    return true;
                }
                _ => {}
            }
            false
        }

        fn emit(&self, event: serde_json::Value) {
            ingest_helper_event(&self.app, event);
        }

        fn tick_level(&mut self) {
            if !self.listening {
                return;
            }
            let Some(session) = self.capture.as_ref() else {
                return;
            };
            let level = {
                let Ok(mut guard) = session.level.lock() else {
                    return;
                };
                let peak = guard.interval_peak;
                guard.interval_peak = 0.0;
                peak
            };
            self.emit(json!({
                "type": "audio_level",
                "payload": { "level": format!("{level:.4}") },
            }));
        }

        fn start(&mut self) {
            if self.listening {
                return;
            }
            // Remember the app the user is dictating into (the foreground window
            // now, before our non-focusable HUD appears) as the paste target.
            self.target = foreground_target();
            if let Some((_, ref name)) = self.target {
                self.emit(json!({
                    "type": "focus_target",
                    "payload": { "app": name },
                }));
            }
            match self.begin_capture() {
                Ok(session) => {
                    self.capture = Some(session);
                    self.listening = true;
                    self.emit(json!({
                        "type": "listening_started",
                        "payload": {
                            "recognitionMode": "venice_recording",
                            "microphone": self.selected_mic.clone().unwrap_or_default(),
                        },
                    }));
                }
                Err(error) => {
                    self.emit(json!({
                        "type": "error",
                        "payload": { "code": error.code, "message": error.message },
                    }));
                }
            }
        }

        fn stop(&mut self) {
            if !self.listening {
                return;
            }
            self.listening = false;
            self.emit(json!({ "type": "finalizing_transcript" }));
            let Some(session) = self.capture.take() else {
                return;
            };
            let observed = finalize_capture(session);
            match observed {
                Ok((path, observed_max)) => {
                    self.last_recording = Some(path.clone());
                    let target = self.target.as_ref().map(|(_, name)| name.clone());
                    self.emit(json!({
                        "type": "recording_ready",
                        "payload": {
                            "path": path.to_string_lossy(),
                            "observedAudioLevel": format!("{observed_max:.4}"),
                            "targetBundleIdentifier": target.unwrap_or_default(),
                        },
                    }));
                }
                Err(error) => {
                    self.emit(json!({
                        "type": "error",
                        "payload": { "code": error.code, "message": error.message },
                    }));
                }
            }
        }

        fn discard(&mut self) {
            self.listening = false;
            if let Some(session) = self.capture.take() {
                let path = session.path.clone();
                drop(session);
                let _ = std::fs::remove_file(&path);
            }
            if let Some(path) = self.last_recording.take() {
                let _ = std::fs::remove_file(path);
            }
            self.emit(json!({ "type": "recording_discarded" }));
        }

        fn paste(&mut self, text: String) {
            // Drop the just-transcribed recording; it has served its purpose.
            if let Some(path) = self.last_recording.take() {
                let _ = std::fs::remove_file(path);
            }
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return;
            }
            let to_paste = format!("{trimmed} ");
            // Mirror the macOS helper's ordering exactly: final_transcript is
            // emitted with the padded paste text before the clipboard write.
            // The dictation history view reloads on this event, so without it
            // an open history view would stay stale after a Windows dictation.
            self.emit(json!({
                "type": "final_transcript",
                "payload": { "text": to_paste },
            }));
            let previous = clipboard_get_text();
            if let Err(error) = clipboard_set_text(&to_paste) {
                self.emit(json!({
                    "type": "error",
                    "payload": { "code": error.code, "message": error.message },
                }));
                return;
            }
            let activated = self
                .target
                .as_ref()
                .map(|(hwnd, _)| activate_window(*hwnd))
                .unwrap_or(false);
            let target_name = self
                .target
                .as_ref()
                .map(|(_, name)| name.clone())
                .unwrap_or_else(|| "unknown".to_string());
            self.emit(json!({
                "type": "paste_target",
                "payload": { "app": target_name, "activated": activated },
            }));
            // Restore the clipboard on a detached timer once the paste has had a
            // moment to land, so we never clobber the app's own paste in flight.
            let app = self.app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(180));
                send_ctrl_v();
                ingest_helper_event(&app, json!({ "type": "paste_completed" }));
                std::thread::sleep(Duration::from_millis(700));
                if clipboard_get_text().as_deref() == Some(to_paste.as_str()) {
                    match previous {
                        Some(previous) => {
                            let _ = clipboard_set_text(&previous);
                        }
                        None => clipboard_clear(),
                    }
                }
            });
        }

        fn begin_capture(&self) -> Result<CaptureSession, AppError> {
            let host = cpal::default_host();
            let device = self
                .selected_mic
                .as_ref()
                .and_then(|name| {
                    host.input_devices().ok().and_then(|mut devices| {
                        devices.find(|device| device.name().ok().as_deref() == Some(name.as_str()))
                    })
                })
                .or_else(|| host.default_input_device())
                .ok_or_else(|| {
                    AppError::new(
                        "microphone_unavailable",
                        "No microphone input device is available.",
                    )
                })?;
            let config = device
                .default_input_config()
                .map_err(|error| AppError::new("microphone_unavailable", error.to_string()))?;
            let sample_rate = config.sample_rate().0;
            let channels = config.channels();

            let path = std::env::temp_dir()
                .join(format!("os-june-dictation-{}.wav", uuid::Uuid::new_v4()));
            let writer = WavWriter::create(
                &path,
                WavSpec {
                    channels,
                    sample_rate,
                    bits_per_sample: 16,
                    sample_format: SampleFormat::Int,
                },
            )
            .map_err(|error| AppError::new("audio_writer_failed", error.to_string()))?;
            let writer = Arc::new(Mutex::new(Some(writer)));
            let level = Arc::new(Mutex::new(LevelState::default()));

            let stream = build_input_stream(&device, &config, writer.clone(), level.clone())?;
            stream
                .play()
                .map_err(|error| AppError::new("audio_writer_failed", error.to_string()))?;

            Ok(CaptureSession {
                path,
                writer,
                level,
                _stream: stream,
            })
        }

        fn emit_microphones(&self) {
            let host = cpal::default_host();
            let selected = self
                .selected_mic
                .clone()
                .or_else(|| {
                    host.default_input_device()
                        .and_then(|device| device.name().ok())
                })
                .unwrap_or_default();
            let devices: Vec<serde_json::Value> = host
                .input_devices()
                .map(|devices| {
                    devices
                        .filter_map(|device| device.name().ok())
                        .map(|name| json!({ "id": name, "name": name }))
                        .collect()
                })
                .unwrap_or_default();
            self.emit(json!({
                "type": "microphone_devices",
                "payload": { "devices": devices, "selectedID": selected },
            }));
        }

        fn emit_permission_status(&self) {
            let (microphone, _) = crate::audio::capture::microphone_permission_state();
            self.emit(json!({
                "type": "permission_status",
                "payload": { "microphone": microphone, "accessibility": "granted" },
            }));
        }
    }

    fn build_input_stream(
        device: &cpal::Device,
        config: &cpal::SupportedStreamConfig,
        writer: Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>,
        level: Arc<Mutex<LevelState>>,
    ) -> Result<cpal::Stream, AppError> {
        let err_fn = |error| tracing::warn!(%error, "dictation capture stream error");
        let stream_config: cpal::StreamConfig = config.clone().into();
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                move |data: &[f32], _| write_samples(data.iter().copied(), &writer, &level),
                err_fn,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    write_samples(
                        data.iter().map(|sample| *sample as f32 / i16::MAX as f32),
                        &writer,
                        &level,
                    )
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    write_samples(
                        data.iter()
                            .map(|sample| (*sample as f32 - 32768.0) / 32768.0),
                        &writer,
                        &level,
                    )
                },
                err_fn,
                None,
            ),
            _ => {
                return Err(AppError::new(
                    "microphone_unavailable",
                    "Unsupported microphone sample format.",
                ))
            }
        }
        .map_err(|error| AppError::new("audio_writer_failed", error.to_string()))?;
        Ok(stream)
    }

    fn write_samples<I>(
        data: I,
        writer: &Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>,
        level: &Arc<Mutex<LevelState>>,
    ) where
        I: Iterator<Item = f32>,
    {
        let Ok(mut writer_guard) = writer.lock() else {
            return;
        };
        let Some(writer) = writer_guard.as_mut() else {
            return;
        };
        let mut peak = 0.0_f32;
        for sample in data {
            let clamped = sample.clamp(-1.0, 1.0);
            peak = peak.max(clamped.abs());
            let _ = writer.write_sample((clamped * i16::MAX as f32) as i16);
        }
        drop(writer_guard);
        if let Ok(mut level) = level.lock() {
            level.interval_peak = level.interval_peak.max(peak);
            level.observed_max = level.observed_max.max(peak);
        }
    }

    /// Finalizes the WAV and returns the path plus the max observed level.
    fn finalize_capture(session: CaptureSession) -> Result<(PathBuf, f32), AppError> {
        let CaptureSession {
            path,
            writer,
            level,
            _stream,
        } = session;
        drop(_stream);
        let observed_max = level.lock().map(|guard| guard.observed_max).unwrap_or(0.0);
        if let Some(writer) = writer
            .lock()
            .map_err(|_| AppError::new("audio_finalization_failed", "Audio writer lock failed."))?
            .take()
        {
            writer
                .finalize()
                .map_err(|error| AppError::new("audio_finalization_failed", error.to_string()))?;
        }
        Ok((path, observed_max))
    }

    // ---- foreground window ------------------------------------------------

    /// The foreground window's executable identity, used both as the HUD focus
    /// label and as the `targetBundleIdentifier`-equivalent for the email
    /// app-context mapping. Returns the raw HWND (as `isize`, since HWND is not
    /// `Send`) plus the lowercased executable file name (e.g. "outlook.exe").
    fn foreground_target() -> Option<(isize, String)> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0 == 0 {
                return None;
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return Some((hwnd.0, String::new()));
            }
            let name = process_executable_name(pid).unwrap_or_default();
            Some((hwnd.0, name))
        }
    }

    unsafe fn process_executable_name(pid: u32) -> Option<String> {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 260];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        result.ok()?;
        let full = String::from_utf16_lossy(&buffer[..size as usize]);
        full.rsplit(['\\', '/'])
            .next()
            .map(|name| name.to_ascii_lowercase())
    }

    fn activate_window(hwnd: isize) -> bool {
        if hwnd == 0 {
            return false;
        }
        unsafe { SetForegroundWindow(HWND(hwnd)).as_bool() }
    }

    // ---- clipboard + paste synthesis -------------------------------------

    fn send_ctrl_v() {
        unsafe {
            let inputs = [
                key_input(VK_CONTROL_U16, false),
                key_input(VK_V, false),
                key_input(VK_V, true),
                key_input(VK_CONTROL_U16, true),
            ];
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    fn key_input(vk: u16, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: 0,
                    dwFlags: if up {
                        KEYEVENTF_KEYUP
                    } else {
                        KEYBD_EVENT_FLAGS(0)
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn clipboard_get_text() -> Option<String> {
        unsafe {
            if OpenClipboard(HWND(0)).is_err() {
                return None;
            }
            let result = (|| {
                let handle = GetClipboardData(CF_UNICODETEXT.0 as u32).ok()?;
                let hglobal = HGLOBAL(handle.0 as *mut core::ffi::c_void);
                let ptr = GlobalLock(hglobal) as *const u16;
                if ptr.is_null() {
                    return None;
                }
                let mut len = 0usize;
                while *ptr.add(len) != 0 {
                    len += 1;
                }
                let slice = std::slice::from_raw_parts(ptr, len);
                let text = String::from_utf16_lossy(slice);
                let _ = GlobalUnlock(hglobal);
                Some(text)
            })();
            let _ = CloseClipboard();
            result
        }
    }

    fn clipboard_set_text(text: &str) -> Result<(), AppError> {
        let mut utf16: Vec<u16> = text.encode_utf16().collect();
        utf16.push(0);
        unsafe {
            OpenClipboard(HWND(0)).map_err(|_| {
                AppError::new(
                    "pasteboard_write_failed",
                    "Could not open the Windows clipboard.",
                )
            })?;
            let result = (|| -> Result<(), AppError> {
                EmptyClipboard().map_err(|_| {
                    AppError::new(
                        "pasteboard_write_failed",
                        "Could not clear the Windows clipboard.",
                    )
                })?;
                let bytes = utf16.len() * std::mem::size_of::<u16>();
                let hglobal = GlobalAlloc(GMEM_MOVEABLE, bytes).map_err(|_| {
                    AppError::new(
                        "pasteboard_write_failed",
                        "Could not allocate clipboard memory.",
                    )
                })?;
                // Win32 clipboard ownership rule: once SetClipboardData
                // succeeds, the system owns the HGLOBAL and the app must NOT
                // free it. On every path where SetClipboardData is not
                // reached, or fails, the allocation is still ours and must be
                // released with GlobalFree or it leaks.
                let ptr = GlobalLock(hglobal) as *mut u16;
                if ptr.is_null() {
                    let _ = GlobalFree(hglobal);
                    return Err(AppError::new(
                        "pasteboard_write_failed",
                        "Could not lock clipboard memory.",
                    ));
                }
                std::ptr::copy_nonoverlapping(utf16.as_ptr(), ptr, utf16.len());
                let _ = GlobalUnlock(hglobal);
                if SetClipboardData(CF_UNICODETEXT.0 as u32, HANDLE(hglobal.0 as isize)).is_err() {
                    let _ = GlobalFree(hglobal);
                    return Err(AppError::new(
                        "pasteboard_write_failed",
                        "Could not write transcript to the clipboard.",
                    ));
                }
                // Ownership transferred to the clipboard; do not free.
                Ok(())
            })();
            let _ = CloseClipboard();
            result
        }
    }

    fn clipboard_clear() {
        unsafe {
            if OpenClipboard(HWND(0)).is_ok() {
                let _ = EmptyClipboard();
                let _ = CloseClipboard();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        code_for_vk, key_label_for_vk, shortcut_edge_action, shortcut_is_supported, vk_for_code,
        windows_shortcut_label, DictationShortcutKind, DictationShortcutModifiers,
        ShortcutEdgeAction,
    };

    fn ctrl_alt() -> DictationShortcutModifiers {
        DictationShortcutModifiers {
            control: true,
            option: true,
            ..DictationShortcutModifiers::default()
        }
    }

    #[test]
    fn vk_for_code_maps_letters_digits_and_named_keys() {
        assert_eq!(vk_for_code("KeyD"), Some(0x44));
        assert_eq!(vk_for_code("KeyT"), Some(0x54));
        assert_eq!(vk_for_code("Digit5"), Some(0x35));
        assert_eq!(vk_for_code("Space"), Some(0x20));
        assert_eq!(vk_for_code("F7"), Some(0x76));
    }

    #[test]
    fn vk_for_code_rejects_macos_only_shapes() {
        assert_eq!(vk_for_code("Fn"), None);
        assert_eq!(vk_for_code("Modifiers"), None);
        assert_eq!(vk_for_code("KeyDD"), None);
    }

    #[test]
    fn code_for_vk_round_trips() {
        for code in ["KeyD", "KeyT", "Digit0", "Space", "F12"] {
            let vk = vk_for_code(code).expect("vk");
            assert_eq!(code_for_vk(vk).as_deref(), Some(code));
        }
    }

    #[test]
    fn key_label_is_human_readable() {
        assert_eq!(key_label_for_vk(0x44).as_deref(), Some("D"));
        assert_eq!(key_label_for_vk(0x20).as_deref(), Some("Space"));
        assert_eq!(key_label_for_vk(0x76).as_deref(), Some("F7"));
    }

    #[test]
    fn windows_label_uses_windows_modifier_names() {
        assert_eq!(windows_shortcut_label(&ctrl_alt(), "D"), "Ctrl+Alt+D");
        let win_shift = DictationShortcutModifiers {
            command: true,
            shift: true,
            ..DictationShortcutModifiers::default()
        };
        assert_eq!(
            windows_shortcut_label(&win_shift, "Space"),
            "Win+Shift+Space"
        );
    }

    #[test]
    fn key_repeat_for_a_held_trigger_is_swallowed_without_a_second_down_edge() {
        // First down: dispatch and suppress.
        assert_eq!(
            shortcut_edge_action(false, true, Some(DictationShortcutKind::Toggle), None),
            ShortcutEdgeAction::DispatchDown(DictationShortcutKind::Toggle)
        );
        // OS key repeat while held (key already suppressed): swallowed, no
        // second down edge — a repeat must not re-toggle dictation.
        assert_eq!(
            shortcut_edge_action(
                false,
                true,
                Some(DictationShortcutKind::Toggle),
                Some(DictationShortcutKind::Toggle)
            ),
            ShortcutEdgeAction::SwallowRepeat
        );
        // Same for push-to-talk: no re-dispatched down on repeats.
        assert_eq!(
            shortcut_edge_action(
                false,
                true,
                Some(DictationShortcutKind::PushToTalk),
                Some(DictationShortcutKind::PushToTalk)
            ),
            ShortcutEdgeAction::SwallowRepeat
        );
        // Repeats stay swallowed even if the modifiers were released mid-hold
        // (no current match), so a suppressed trigger never leaks into the app.
        assert_eq!(
            shortcut_edge_action(false, true, None, Some(DictationShortcutKind::Toggle)),
            ShortcutEdgeAction::SwallowRepeat
        );
    }

    #[test]
    fn release_of_a_suppressed_trigger_dispatches_the_up_edge() {
        assert_eq!(
            shortcut_edge_action(false, false, None, Some(DictationShortcutKind::PushToTalk)),
            ShortcutEdgeAction::DispatchUp(DictationShortcutKind::PushToTalk)
        );
        // A release we never suppressed passes through untouched.
        assert_eq!(
            shortcut_edge_action(false, false, None, None),
            ShortcutEdgeAction::PassThrough
        );
    }

    #[test]
    fn unmatched_keys_pass_through() {
        assert_eq!(
            shortcut_edge_action(false, true, None, None),
            ShortcutEdgeAction::PassThrough
        );
    }

    #[test]
    fn injected_events_pass_through_regardless_of_match() {
        // Our own synthesized Ctrl+V comes back through the hook flagged as
        // injected. Even if it matches a configured shortcut (a user bound
        // Ctrl+V, or a colliding toggle chord), it must pass through: matching
        // would swallow the V so the paste never lands, or start a new
        // dictation mid-paste.
        assert_eq!(
            shortcut_edge_action(true, true, Some(DictationShortcutKind::Toggle), None),
            ShortcutEdgeAction::PassThrough
        );
        assert_eq!(
            shortcut_edge_action(true, true, Some(DictationShortcutKind::PushToTalk), None),
            ShortcutEdgeAction::PassThrough
        );
        // Injected events never touch the suppressed bookkeeping either, even
        // while the same key is physically held and suppressed.
        assert_eq!(
            shortcut_edge_action(true, true, None, Some(DictationShortcutKind::Toggle)),
            ShortcutEdgeAction::PassThrough
        );
        assert_eq!(
            shortcut_edge_action(true, false, None, Some(DictationShortcutKind::Toggle)),
            ShortcutEdgeAction::PassThrough
        );
    }

    #[test]
    fn supported_requires_a_real_key_and_a_modifier() {
        assert!(shortcut_is_supported("KeyD", &ctrl_alt()));
        // No modifier: would be a global key eater.
        assert!(!shortcut_is_supported(
            "KeyD",
            &DictationShortcutModifiers::default()
        ));
        // macOS-only bare Fn / modifier-only chords have no Windows key.
        assert!(!shortcut_is_supported("Fn", &ctrl_alt()));
        assert!(!shortcut_is_supported("Modifiers", &ctrl_alt()));
    }
}
