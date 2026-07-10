use crate::protocol::{ShortcutCommand, ShortcutKind, ShortcutModifiers};
use std::{
    collections::{HashMap, HashSet},
    sync::{mpsc, Arc},
    thread,
};
use windows_sys::Win32::{
    Foundation::GetLastError,
    UI::{
        Input::KeyboardAndMouse::{
            GetAsyncKeyState, RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT,
            MOD_SHIFT, MOD_WIN, VK_0, VK_A, VK_BACK, VK_CONTROL, VK_DOWN, VK_ESCAPE, VK_F1, VK_F12,
            VK_LCONTROL, VK_LEFT, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU, VK_OEM_1, VK_OEM_2,
            VK_OEM_3, VK_OEM_4, VK_OEM_5, VK_OEM_6, VK_OEM_7, VK_OEM_COMMA, VK_OEM_MINUS,
            VK_OEM_PERIOD, VK_OEM_PLUS, VK_RCONTROL, VK_RETURN, VK_RIGHT, VK_RMENU, VK_RSHIFT,
            VK_RWIN, VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
        },
        WindowsAndMessaging::{
            CallNextHookEx, DispatchMessageW, GetMessageW, KillTimer, PeekMessageW,
            PostThreadMessageW, SetTimer, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
            KBDLLHOOKSTRUCT, MSG, PM_NOREMOVE, WH_KEYBOARD_LL, WM_APP, WM_HOTKEY, WM_KEYDOWN,
            WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_TIMER,
        },
    },
};

const HOTKEY_PUSH_TO_TALK: i32 = 1;
const HOTKEY_TOGGLE: i32 = 2;
const HOTKEY_RECONFIGURE: u32 = WM_APP + 1;
const HOTKEY_KEYBOARD_EVENT: u32 = WM_APP + 2;
const CAPTURE_TIMEOUT_MS: u32 = 12_000;
const PUSH_RELEASE_POLL_MS: u32 = 50;

type EventSink = Arc<dyn Fn(HotkeyEvent) + Send + Sync + 'static>;

#[derive(Clone, Debug)]
pub enum HotkeyEvent {
    KeyDown {
        kind: ShortcutKind,
        shortcut: String,
    },
    KeyUp {
        kind: ShortcutKind,
        shortcut: String,
    },
    Ready {
        push_to_talk_shortcut: String,
        toggle_shortcut: String,
    },
    RegistrationFailed {
        kind: ShortcutKind,
        shortcut: String,
        code: String,
        message: String,
    },
    CaptureStarted {
        kind: ShortcutKind,
    },
    CaptureCancelled {
        kind: ShortcutKind,
    },
    CaptureError {
        kind: ShortcutKind,
        code: String,
        message: String,
    },
    Captured {
        kind: ShortcutKind,
        shortcut: ShortcutCommand,
    },
}

#[derive(Clone, Debug)]
pub struct HotkeyManager {
    sender: mpsc::Sender<HotkeyMessage>,
    thread_id: u32,
}

#[derive(Clone, Debug)]
enum HotkeyMessage {
    Set(ShortcutCommand),
    StartCapture(ShortcutKind),
    CancelCapture,
    Shutdown,
}

impl HotkeyManager {
    pub fn start(event_sink: Box<dyn Fn(HotkeyEvent) + Send + Sync + 'static>) -> Option<Self> {
        let (message_tx, message_rx) = mpsc::channel::<HotkeyMessage>();
        let (ready_tx, ready_rx) = mpsc::channel::<u32>();
        let event_sink = Arc::from(event_sink);
        thread::spawn(move || hotkey_thread(message_rx, ready_tx, event_sink));
        let thread_id = ready_rx.recv().ok()?;
        Some(Self {
            sender: message_tx,
            thread_id,
        })
    }

    pub fn set_shortcut(&self, shortcut: ShortcutCommand) {
        self.send(HotkeyMessage::Set(shortcut), HOTKEY_RECONFIGURE);
    }

    pub fn start_capture(&self, kind: ShortcutKind) {
        self.send(HotkeyMessage::StartCapture(kind), HOTKEY_RECONFIGURE);
    }

    pub fn cancel_capture(&self) {
        self.send(HotkeyMessage::CancelCapture, HOTKEY_RECONFIGURE);
    }

    pub fn shutdown(&self) {
        self.send(HotkeyMessage::Shutdown, WM_QUIT);
    }

    fn send(&self, message: HotkeyMessage, wake_message: u32) {
        let _ = self.sender.send(message);
        unsafe { PostThreadMessageW(self.thread_id, wake_message, 0, 0) };
    }
}

#[derive(Clone, Copy, Debug)]
struct CaptureState {
    kind: ShortcutKind,
}

#[derive(Default)]
struct HotkeyThreadState {
    shortcuts: HashMap<ShortcutKind, ShortcutCommand>,
    registered: HashSet<i32>,
    pressed_keys: HashSet<u32>,
    active_push_to_talk: bool,
    capture: Option<CaptureState>,
    capture_timer_id: Option<usize>,
    push_release_timer_id: Option<usize>,
}

fn hotkey_thread(
    message_rx: mpsc::Receiver<HotkeyMessage>,
    ready_tx: mpsc::Sender<u32>,
    event_sink: EventSink,
) {
    let thread_id = unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() };
    let mut initial_msg = MSG::default();
    unsafe {
        PeekMessageW(&mut initial_msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
    }
    let hook = unsafe {
        SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(low_level_keyboard_proc),
            std::ptr::null_mut(),
            0,
        )
    };
    let _ = ready_tx.send(thread_id);

    let mut state = HotkeyThreadState::default();
    if hook.is_null() {
        event_sink(HotkeyEvent::RegistrationFailed {
            kind: ShortcutKind::PushToTalk,
            shortcut: String::new(),
            code: "keyboard_hook_unavailable".to_string(),
            message: "Windows could not start dictation shortcut monitoring.".to_string(),
        });
    }

    loop {
        if drain_messages(&message_rx, &mut state, &event_sink) {
            break;
        }
        let mut msg = MSG::default();
        let result = unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) };
        if result <= 0 {
            break;
        }
        match msg.message {
            HOTKEY_RECONFIGURE => {}
            HOTKEY_KEYBOARD_EVENT => {
                handle_keyboard_event(&mut state, msg.wParam as u32, msg.lParam != 0, &event_sink)
            }
            WM_TIMER => {
                if state.capture_timer_id == Some(msg.wParam) {
                    cancel_capture(&mut state, &event_sink);
                } else if state.push_release_timer_id == Some(msg.wParam) {
                    poll_active_push_to_talk(&mut state, &event_sink);
                }
            }
            WM_HOTKEY if state.capture.is_none() => match msg.wParam as i32 {
                HOTKEY_PUSH_TO_TALK if !state.active_push_to_talk => {
                    if let Some(shortcut) = state.shortcuts.get(&ShortcutKind::PushToTalk) {
                        state.active_push_to_talk = true;
                        state.push_release_timer_id = nonzero_timer_id(unsafe {
                            SetTimer(std::ptr::null_mut(), 0, PUSH_RELEASE_POLL_MS, None)
                        });
                        event_sink(HotkeyEvent::KeyDown {
                            kind: ShortcutKind::PushToTalk,
                            shortcut: shortcut.label.clone(),
                        });
                    }
                }
                HOTKEY_TOGGLE => {
                    if let Some(shortcut) = state.shortcuts.get(&ShortcutKind::Toggle) {
                        event_sink(HotkeyEvent::KeyDown {
                            kind: ShortcutKind::Toggle,
                            shortcut: shortcut.label.clone(),
                        });
                    }
                }
                _ => {}
            },
            _ => unsafe {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            },
        }
    }

    release_active_push_to_talk(&mut state, &event_sink);
    unregister_all(&mut state);
    if !hook.is_null() {
        let _ = unsafe { UnhookWindowsHookEx(hook) };
    }
}

fn drain_messages(
    message_rx: &mpsc::Receiver<HotkeyMessage>,
    state: &mut HotkeyThreadState,
    event_sink: &EventSink,
) -> bool {
    let mut shortcuts_changed = false;
    while let Ok(message) = message_rx.try_recv() {
        match message {
            HotkeyMessage::Set(shortcut) => {
                release_active_push_to_talk(state, event_sink);
                state.shortcuts.insert(shortcut.kind, shortcut);
                shortcuts_changed = true;
            }
            HotkeyMessage::StartCapture(kind) => {
                release_active_push_to_talk(state, event_sink);
                unregister_all(state);
                state.capture = Some(CaptureState { kind });
                state.pressed_keys.clear();
                kill_timer(&mut state.capture_timer_id);
                state.capture_timer_id = nonzero_timer_id(unsafe {
                    SetTimer(std::ptr::null_mut(), 0, CAPTURE_TIMEOUT_MS, None)
                });
                event_sink(HotkeyEvent::CaptureStarted { kind });
            }
            HotkeyMessage::CancelCapture => cancel_capture(state, event_sink),
            HotkeyMessage::Shutdown => return true,
        }
    }
    if shortcuts_changed && state.capture.is_none() {
        register_shortcuts(state, event_sink);
    }
    false
}

fn handle_keyboard_event(
    state: &mut HotkeyThreadState,
    vk: u32,
    is_down: bool,
    event_sink: &EventSink,
) {
    let repeated = if is_down {
        !state.pressed_keys.insert(vk)
    } else {
        !state.pressed_keys.remove(&vk)
    };
    if repeated {
        return;
    }

    if let Some(capture) = state.capture {
        handle_capture_key(state, capture, vk, is_down, event_sink);
        return;
    }

    if !is_down && state.active_push_to_talk {
        let should_release =
            state
                .shortcuts
                .get(&ShortcutKind::PushToTalk)
                .is_some_and(|shortcut| {
                    virtual_key_for_code(&shortcut.code) == Some(vk)
                        || modifier_virtual_keys(shortcut.modifiers).contains(&vk)
                });
        if should_release {
            release_active_push_to_talk(state, event_sink);
        }
    }
}

fn handle_capture_key(
    state: &mut HotkeyThreadState,
    capture: CaptureState,
    vk: u32,
    is_down: bool,
    event_sink: &EventSink,
) {
    if is_down && vk == VK_ESCAPE as u32 {
        cancel_capture(state, event_sink);
        return;
    }
    if !is_down || is_modifier_vk(vk) {
        return;
    }

    let modifiers = current_modifiers(&state.pressed_keys);
    if !has_standard_modifier(modifiers) {
        event_sink(HotkeyEvent::CaptureError {
            kind: capture.kind,
            code: "modifier_required".to_string(),
            message: "Shortcut must include Ctrl, Alt, Shift, or Win.".to_string(),
        });
        return;
    }
    let Some(code) = code_for_virtual_key(vk) else {
        event_sink(HotkeyEvent::CaptureError {
            kind: capture.kind,
            code: "unsupported_key".to_string(),
            message: "Choose a supported letter, number, punctuation, navigation, or function key."
                .to_string(),
        });
        return;
    };

    let shortcut = ShortcutCommand {
        key_code: vk,
        code: code.to_string(),
        label: shortcut_label(modifiers, code),
        kind: capture.kind,
        press_count: 1,
        modifiers,
    };
    state.capture = None;
    kill_timer(&mut state.capture_timer_id);
    state.pressed_keys.clear();
    event_sink(HotkeyEvent::Captured {
        kind: capture.kind,
        shortcut,
    });
    register_shortcuts(state, event_sink);
}

fn cancel_capture(state: &mut HotkeyThreadState, event_sink: &EventSink) {
    let Some(capture) = state.capture.take() else {
        return;
    };
    kill_timer(&mut state.capture_timer_id);
    state.pressed_keys.clear();
    event_sink(HotkeyEvent::CaptureCancelled { kind: capture.kind });
    register_shortcuts(state, event_sink);
}

fn register_shortcuts(state: &mut HotkeyThreadState, event_sink: &EventSink) {
    register_shortcuts_with(state, event_sink, |id, modifiers, vk| {
        if unsafe { RegisterHotKey(std::ptr::null_mut(), id, modifiers, vk) } != 0 {
            Ok(())
        } else {
            Err(unsafe { GetLastError() })
        }
    });
}

fn register_shortcuts_with(
    state: &mut HotkeyThreadState,
    event_sink: &EventSink,
    mut register: impl FnMut(i32, u32, u32) -> Result<(), u32>,
) {
    unregister_all(state);
    let mut all_registered = state.shortcuts.len() == 2;
    for kind in [ShortcutKind::PushToTalk, ShortcutKind::Toggle] {
        let Some(shortcut) = state.shortcuts.get(&kind) else {
            all_registered = false;
            continue;
        };
        let Some(vk) = virtual_key_for_code(&shortcut.code) else {
            all_registered = false;
            event_sink(HotkeyEvent::RegistrationFailed {
                kind,
                shortcut: shortcut.label.clone(),
                code: "unsupported_key".to_string(),
                message: format!(
                    "{} is not supported as a Windows dictation shortcut.",
                    shortcut.label
                ),
            });
            continue;
        };
        if shortcut.press_count != 1
            || shortcut.modifiers.function
            || !has_standard_modifier(shortcut.modifiers)
        {
            all_registered = false;
            event_sink(HotkeyEvent::RegistrationFailed {
                kind,
                shortcut: shortcut.label.clone(),
                code: "unsupported_shortcut".to_string(),
                message: format!(
                    "{} is not supported as a Windows dictation shortcut.",
                    shortcut.label
                ),
            });
            continue;
        }
        let id = hotkey_id(kind);
        let modifiers = modifiers_to_win32(shortcut.modifiers) | MOD_NOREPEAT;
        match register(id, modifiers, vk) {
            Ok(()) => {
                state.registered.insert(id);
            }
            Err(error) => {
                all_registered = false;
                event_sink(HotkeyEvent::RegistrationFailed {
                    kind,
                    shortcut: shortcut.label.clone(),
                    code: format!("register_hotkey_{}", error),
                    message: format!(
                        "Windows could not register {}. It may already be used by another app.",
                        shortcut.label
                    ),
                });
            }
        }
    }

    if !all_registered {
        return;
    }

    let push_to_talk_shortcut = state
        .shortcuts
        .get(&ShortcutKind::PushToTalk)
        .map(|shortcut| shortcut.label.clone())
        .unwrap_or_default();
    let toggle_shortcut = state
        .shortcuts
        .get(&ShortcutKind::Toggle)
        .map(|shortcut| shortcut.label.clone())
        .unwrap_or_default();
    event_sink(HotkeyEvent::Ready {
        push_to_talk_shortcut,
        toggle_shortcut,
    });
}

fn nonzero_timer_id(timer_id: usize) -> Option<usize> {
    (timer_id != 0).then_some(timer_id)
}

fn kill_timer(timer_id: &mut Option<usize>) {
    if let Some(timer_id) = timer_id.take() {
        unsafe { KillTimer(std::ptr::null_mut(), timer_id) };
    }
}

fn poll_active_push_to_talk(state: &mut HotkeyThreadState, event_sink: &EventSink) {
    if !state.active_push_to_talk {
        kill_timer(&mut state.push_release_timer_id);
        return;
    }
    let still_held = state
        .shortcuts
        .get(&ShortcutKind::PushToTalk)
        .and_then(|shortcut| {
            let key = virtual_key_for_code(&shortcut.code)?;
            Some(key_is_down(key) && required_modifiers_are_down(shortcut.modifiers))
        })
        .unwrap_or(false);
    if !still_held {
        release_active_push_to_talk(state, event_sink);
    }
}

fn required_modifiers_are_down(modifiers: ShortcutModifiers) -> bool {
    (!modifiers.command || key_is_down(VK_LWIN as u32) || key_is_down(VK_RWIN as u32))
        && (!modifiers.control
            || key_is_down(VK_CONTROL as u32)
            || key_is_down(VK_LCONTROL as u32)
            || key_is_down(VK_RCONTROL as u32))
        && (!modifiers.option
            || key_is_down(VK_MENU as u32)
            || key_is_down(VK_LMENU as u32)
            || key_is_down(VK_RMENU as u32))
        && (!modifiers.shift
            || key_is_down(VK_SHIFT as u32)
            || key_is_down(VK_LSHIFT as u32)
            || key_is_down(VK_RSHIFT as u32))
}

fn key_is_down(vk: u32) -> bool {
    (unsafe { GetAsyncKeyState(vk as i32) }) < 0
}

fn release_active_push_to_talk(state: &mut HotkeyThreadState, event_sink: &EventSink) {
    if !state.active_push_to_talk {
        return;
    }
    state.active_push_to_talk = false;
    kill_timer(&mut state.push_release_timer_id);
    if let Some(shortcut) = state.shortcuts.get(&ShortcutKind::PushToTalk) {
        event_sink(HotkeyEvent::KeyUp {
            kind: ShortcutKind::PushToTalk,
            shortcut: shortcut.label.clone(),
        });
    }
}

fn unregister_all(state: &mut HotkeyThreadState) {
    for id in state.registered.drain() {
        unsafe { UnregisterHotKey(std::ptr::null_mut(), id) };
    }
}

fn hotkey_id(kind: ShortcutKind) -> i32 {
    match kind {
        ShortcutKind::PushToTalk => HOTKEY_PUSH_TO_TALK,
        ShortcutKind::Toggle => HOTKEY_TOGGLE,
    }
}

fn modifiers_to_win32(modifiers: ShortcutModifiers) -> u32 {
    let mut value = 0;
    if modifiers.control {
        value |= MOD_CONTROL;
    }
    if modifiers.option {
        value |= MOD_ALT;
    }
    if modifiers.shift {
        value |= MOD_SHIFT;
    }
    if modifiers.command {
        value |= MOD_WIN;
    }
    value
}

fn current_modifiers(pressed_keys: &HashSet<u32>) -> ShortcutModifiers {
    ShortcutModifiers {
        command: key_is_down(VK_LWIN as u32)
            || key_is_down(VK_RWIN as u32)
            || pressed_keys.contains(&(VK_LWIN as u32))
            || pressed_keys.contains(&(VK_RWIN as u32)),
        control: key_is_down(VK_CONTROL as u32)
            || key_is_down(VK_LCONTROL as u32)
            || key_is_down(VK_RCONTROL as u32)
            || pressed_keys.contains(&(VK_CONTROL as u32))
            || pressed_keys.contains(&(VK_LCONTROL as u32))
            || pressed_keys.contains(&(VK_RCONTROL as u32)),
        option: key_is_down(VK_MENU as u32)
            || key_is_down(VK_LMENU as u32)
            || key_is_down(VK_RMENU as u32)
            || pressed_keys.contains(&(VK_MENU as u32))
            || pressed_keys.contains(&(VK_LMENU as u32))
            || pressed_keys.contains(&(VK_RMENU as u32)),
        shift: key_is_down(VK_SHIFT as u32)
            || key_is_down(VK_LSHIFT as u32)
            || key_is_down(VK_RSHIFT as u32)
            || pressed_keys.contains(&(VK_SHIFT as u32))
            || pressed_keys.contains(&(VK_LSHIFT as u32))
            || pressed_keys.contains(&(VK_RSHIFT as u32)),
        function: false,
    }
}

fn modifier_virtual_keys(modifiers: ShortcutModifiers) -> Vec<u32> {
    let mut keys = Vec::new();
    if modifiers.command {
        keys.extend([VK_LWIN as u32, VK_RWIN as u32]);
    }
    if modifiers.control {
        keys.extend([VK_CONTROL as u32, VK_LCONTROL as u32, VK_RCONTROL as u32]);
    }
    if modifiers.option {
        keys.extend([VK_MENU as u32, VK_LMENU as u32, VK_RMENU as u32]);
    }
    if modifiers.shift {
        keys.extend([VK_SHIFT as u32, VK_LSHIFT as u32, VK_RSHIFT as u32]);
    }
    keys
}

fn has_standard_modifier(modifiers: ShortcutModifiers) -> bool {
    modifiers.command || modifiers.control || modifiers.option || modifiers.shift
}

fn is_modifier_vk(vk: u32) -> bool {
    matches!(
        vk,
        value if value == VK_CONTROL as u32
            || value == VK_LCONTROL as u32
            || value == VK_RCONTROL as u32
            || value == VK_MENU as u32
            || value == VK_LMENU as u32
            || value == VK_RMENU as u32
            || value == VK_SHIFT as u32
            || value == VK_LSHIFT as u32
            || value == VK_RSHIFT as u32
            || value == VK_LWIN as u32
            || value == VK_RWIN as u32
    )
}

fn shortcut_label(modifiers: ShortcutModifiers, code: &str) -> String {
    [
        modifiers.control.then_some("Ctrl"),
        modifiers.option.then_some("Alt"),
        modifiers.shift.then_some("Shift"),
        modifiers.command.then_some("Win"),
        Some(key_label(code)),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("+")
}

fn key_label(code: &str) -> &str {
    code.strip_prefix("Key")
        .or_else(|| code.strip_prefix("Digit"))
        .unwrap_or(code)
}

pub(crate) fn virtual_key_for_code(code: &str) -> Option<u32> {
    if code.len() == 4 && code.starts_with("Key") {
        let letter = code.as_bytes()[3];
        if letter.is_ascii_uppercase() {
            return Some(VK_A as u32 + u32::from(letter - b'A'));
        }
    }
    if code.len() == 6 && code.starts_with("Digit") {
        let digit = code.as_bytes()[5];
        if digit.is_ascii_digit() {
            return Some(VK_0 as u32 + u32::from(digit - b'0'));
        }
    }
    if let Some(number) = code
        .strip_prefix('F')
        .and_then(|value| value.parse::<u32>().ok())
    {
        if (1..=12).contains(&number) {
            return Some(VK_F1 as u32 + number - 1);
        }
    }
    Some(match code {
        "Space" => VK_SPACE as u32,
        "Tab" => VK_TAB as u32,
        "Enter" => VK_RETURN as u32,
        "Backspace" => VK_BACK as u32,
        "Escape" => VK_ESCAPE as u32,
        "ArrowLeft" => VK_LEFT as u32,
        "ArrowUp" => VK_UP as u32,
        "ArrowRight" => VK_RIGHT as u32,
        "ArrowDown" => VK_DOWN as u32,
        "Semicolon" => VK_OEM_1 as u32,
        "Equal" => VK_OEM_PLUS as u32,
        "Comma" => VK_OEM_COMMA as u32,
        "Minus" => VK_OEM_MINUS as u32,
        "Period" => VK_OEM_PERIOD as u32,
        "Slash" => VK_OEM_2 as u32,
        "Backquote" => VK_OEM_3 as u32,
        "BracketLeft" => VK_OEM_4 as u32,
        "Backslash" => VK_OEM_5 as u32,
        "BracketRight" => VK_OEM_6 as u32,
        "Quote" => VK_OEM_7 as u32,
        _ => return None,
    })
}

fn code_for_virtual_key(vk: u32) -> Option<&'static str> {
    const LETTER_CODES: [&str; 26] = [
        "KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI", "KeyJ", "KeyK",
        "KeyL", "KeyM", "KeyN", "KeyO", "KeyP", "KeyQ", "KeyR", "KeyS", "KeyT", "KeyU", "KeyV",
        "KeyW", "KeyX", "KeyY", "KeyZ",
    ];
    const DIGIT_CODES: [&str; 10] = [
        "Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8",
        "Digit9",
    ];
    const FUNCTION_CODES: [&str; 12] = [
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
    ];
    if (VK_A as u32..VK_A as u32 + 26).contains(&vk) {
        return LETTER_CODES.get((vk - VK_A as u32) as usize).copied();
    }
    if (VK_0 as u32..VK_0 as u32 + 10).contains(&vk) {
        return DIGIT_CODES.get((vk - VK_0 as u32) as usize).copied();
    }
    if (VK_F1 as u32..=VK_F12 as u32).contains(&vk) {
        return FUNCTION_CODES.get((vk - VK_F1 as u32) as usize).copied();
    }
    match vk {
        value if value == VK_SPACE as u32 => Some("Space"),
        value if value == VK_TAB as u32 => Some("Tab"),
        value if value == VK_RETURN as u32 => Some("Enter"),
        value if value == VK_BACK as u32 => Some("Backspace"),
        value if value == VK_ESCAPE as u32 => Some("Escape"),
        value if value == VK_LEFT as u32 => Some("ArrowLeft"),
        value if value == VK_UP as u32 => Some("ArrowUp"),
        value if value == VK_RIGHT as u32 => Some("ArrowRight"),
        value if value == VK_DOWN as u32 => Some("ArrowDown"),
        value if value == VK_OEM_1 as u32 => Some("Semicolon"),
        value if value == VK_OEM_PLUS as u32 => Some("Equal"),
        value if value == VK_OEM_COMMA as u32 => Some("Comma"),
        value if value == VK_OEM_MINUS as u32 => Some("Minus"),
        value if value == VK_OEM_PERIOD as u32 => Some("Period"),
        value if value == VK_OEM_2 as u32 => Some("Slash"),
        value if value == VK_OEM_3 as u32 => Some("Backquote"),
        value if value == VK_OEM_4 as u32 => Some("BracketLeft"),
        value if value == VK_OEM_5 as u32 => Some("Backslash"),
        value if value == VK_OEM_6 as u32 => Some("BracketRight"),
        value if value == VK_OEM_7 as u32 => Some("Quote"),
        _ => None,
    }
}

unsafe extern "system" fn low_level_keyboard_proc(
    code: i32,
    wparam: usize,
    lparam: isize,
) -> isize {
    if code >= 0 && lparam != 0 {
        let message = wparam as u32;
        let is_down = matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN);
        let is_up = matches!(message, WM_KEYUP | WM_SYSKEYUP);
        if is_down || is_up {
            let event = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
            let thread_id = unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() };
            unsafe {
                PostThreadMessageW(
                    thread_id,
                    HOTKEY_KEYBOARD_EVENT,
                    event.vkCode as usize,
                    is_down as isize,
                )
            };
        }
    }
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_supported_windows_key_allowlist() {
        for code in [
            "KeyA",
            "KeyZ",
            "Digit0",
            "Digit9",
            "Space",
            "Tab",
            "Enter",
            "Backspace",
            "Escape",
            "ArrowLeft",
            "ArrowUp",
            "ArrowRight",
            "ArrowDown",
            "Semicolon",
            "Equal",
            "Comma",
            "Minus",
            "Period",
            "Slash",
            "Backquote",
            "BracketLeft",
            "Backslash",
            "BracketRight",
            "Quote",
            "F1",
            "F12",
        ] {
            assert!(
                virtual_key_for_code(code).is_some(),
                "missing mapping for {code}"
            );
        }
        assert_eq!(virtual_key_for_code("F13"), None);
        assert_eq!(virtual_key_for_code("NumpadEnter"), None);
        assert_eq!(virtual_key_for_code("KeyAA"), None);
    }

    #[test]
    fn captured_key_round_trips_through_the_allowlist() {
        for code in ["KeyD", "Digit4", "Space", "ArrowDown", "Quote", "F8"] {
            let vk = virtual_key_for_code(code).expect("supported key");
            assert_eq!(code_for_virtual_key(vk), Some(code));
        }
    }

    #[test]
    fn partial_registration_keeps_the_successful_shortcut_armed() {
        let mut state = HotkeyThreadState::default();
        state.shortcuts.insert(
            ShortcutKind::PushToTalk,
            shortcut(ShortcutKind::PushToTalk, "KeyD", "Ctrl+Alt+D"),
        );
        state.shortcuts.insert(
            ShortcutKind::Toggle,
            shortcut(ShortcutKind::Toggle, "KeyT", "Ctrl+Alt+T"),
        );
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured_events = Arc::clone(&events);
        let event_sink: EventSink = Arc::new(move |event| {
            captured_events.lock().expect("event lock").push(event);
        });

        register_shortcuts_with(&mut state, &event_sink, |id, _, _| {
            if id == HOTKEY_PUSH_TO_TALK {
                Ok(())
            } else {
                Err(1409)
            }
        });

        assert_eq!(state.registered, HashSet::from([HOTKEY_PUSH_TO_TALK]));
        let events = events.lock().expect("event lock");
        assert!(events.iter().any(|event| matches!(
            event,
            HotkeyEvent::RegistrationFailed {
                kind: ShortcutKind::Toggle,
                ..
            }
        )));
        assert!(!events
            .iter()
            .any(|event| matches!(event, HotkeyEvent::Ready { .. })));
    }

    fn shortcut(kind: ShortcutKind, code: &str, label: &str) -> ShortcutCommand {
        ShortcutCommand {
            key_code: virtual_key_for_code(code).expect("supported shortcut"),
            code: code.to_string(),
            label: label.to_string(),
            kind,
            press_count: 1,
            modifiers: ShortcutModifiers {
                control: true,
                option: true,
                ..ShortcutModifiers::default()
            },
        }
    }
}
