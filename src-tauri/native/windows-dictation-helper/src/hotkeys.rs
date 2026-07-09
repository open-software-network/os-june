use crate::protocol::{ShortcutCommand, ShortcutKind, ShortcutModifiers};
use std::{collections::HashMap, sync::mpsc, thread};
use windows_sys::Win32::UI::{
    Input::KeyboardAndMouse::{
        RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN, VK_0, VK_A,
    },
    WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, PeekMessageW, PostThreadMessageW, TranslateMessage, MSG,
        PM_NOREMOVE, WM_APP, WM_HOTKEY, WM_QUIT,
    },
};

const HOTKEY_PUSH_TO_TALK: i32 = 1;
const HOTKEY_TOGGLE: i32 = 2;
const HOTKEY_RECONFIGURE: u32 = WM_APP + 1;

type EventSink = Box<dyn Fn(HotkeyEvent) + Send + 'static>;

#[derive(Clone, Debug)]
pub struct HotkeyEvent {
    pub kind: ShortcutKind,
}

#[derive(Clone, Debug)]
pub struct HotkeyManager {
    sender: mpsc::Sender<HotkeyMessage>,
    thread_id: u32,
}

#[derive(Clone, Debug)]
enum HotkeyMessage {
    Set(ShortcutCommand),
    Shutdown,
}

impl HotkeyManager {
    pub fn start(event_sink: EventSink) -> Option<Self> {
        let (message_tx, message_rx) = mpsc::channel::<HotkeyMessage>();
        let (ready_tx, ready_rx) = mpsc::channel::<u32>();
        thread::spawn(move || hotkey_thread(message_rx, ready_tx, event_sink));
        let thread_id = ready_rx.recv().ok()?;
        Some(Self {
            sender: message_tx,
            thread_id,
        })
    }

    pub fn set_shortcut(&self, shortcut: ShortcutCommand) {
        let _ = self.sender.send(HotkeyMessage::Set(shortcut));
        unsafe { PostThreadMessageW(self.thread_id, HOTKEY_RECONFIGURE, 0, 0) };
    }

    pub fn shutdown(&self) {
        let _ = self.sender.send(HotkeyMessage::Shutdown);
        unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0) };
    }
}

fn hotkey_thread(
    message_rx: mpsc::Receiver<HotkeyMessage>,
    ready_tx: mpsc::Sender<u32>,
    event_sink: EventSink,
) {
    let thread_id = unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() };
    // Win32 creates a thread message queue lazily. Force it to exist before
    // the controller calls PostThreadMessageW to trigger registration.
    let mut initial_msg = MSG::default();
    unsafe {
        PeekMessageW(&mut initial_msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
    }
    let _ = ready_tx.send(thread_id);
    let mut shortcuts: HashMap<ShortcutKind, ShortcutCommand> = HashMap::new();
    let mut registered = Vec::<i32>::new();

    loop {
        drain_messages(&message_rx, &mut shortcuts, &mut registered);
        let mut msg = MSG::default();
        let result = unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) };
        if result <= 0 {
            break;
        }
        if msg.message == HOTKEY_RECONFIGURE {
            continue;
        }
        if msg.message == WM_HOTKEY {
            match msg.wParam as i32 {
                HOTKEY_PUSH_TO_TALK => event_sink(HotkeyEvent {
                    kind: ShortcutKind::PushToTalk,
                }),
                HOTKEY_TOGGLE => event_sink(HotkeyEvent {
                    kind: ShortcutKind::Toggle,
                }),
                _ => {}
            }
            continue;
        }
        unsafe {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    for id in registered {
        unsafe { UnregisterHotKey(std::ptr::null_mut(), id) };
    }
}

fn drain_messages(
    message_rx: &mpsc::Receiver<HotkeyMessage>,
    shortcuts: &mut HashMap<ShortcutKind, ShortcutCommand>,
    registered: &mut Vec<i32>,
) {
    let mut changed = false;
    while let Ok(message) = message_rx.try_recv() {
        match message {
            HotkeyMessage::Set(shortcut) => {
                shortcuts.insert(shortcut.kind, shortcut);
                changed = true;
            }
            HotkeyMessage::Shutdown => return,
        }
    }
    if !changed {
        return;
    }
    for id in registered.drain(..) {
        unsafe { UnregisterHotKey(std::ptr::null_mut(), id) };
    }
    for (kind, shortcut) in shortcuts.iter() {
        if let Some(vk) = virtual_key_for_code(&shortcut.code) {
            let id = match kind {
                ShortcutKind::PushToTalk => HOTKEY_PUSH_TO_TALK,
                ShortcutKind::Toggle => HOTKEY_TOGGLE,
            };
            let modifiers = modifiers_to_win32(shortcut.modifiers);
            if unsafe { RegisterHotKey(std::ptr::null_mut(), id, modifiers, vk) } != 0 {
                registered.push(id);
            }
        }
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

fn virtual_key_for_code(code: &str) -> Option<u32> {
    if let Some(letter) = code
        .strip_prefix("Key")
        .and_then(|rest| rest.as_bytes().first())
    {
        if letter.is_ascii_uppercase() {
            return Some(VK_A as u32 + u32::from(*letter - b'A'));
        }
    }
    if let Some(digit) = code
        .strip_prefix("Digit")
        .and_then(|rest| rest.as_bytes().first())
    {
        if digit.is_ascii_digit() {
            return Some(VK_0 as u32 + u32::from(*digit - b'0'));
        }
    }
    match code {
        _ => None,
    }
}
