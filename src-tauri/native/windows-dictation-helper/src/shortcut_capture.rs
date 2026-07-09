use crate::protocol::{ShortcutKind, ShortcutModifiers};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{VK_D, VK_T};

pub fn default_shortcut(kind: ShortcutKind) -> serde_json::Value {
    match kind {
        ShortcutKind::PushToTalk => serde_json::json!({
            "keyCode": VK_D,
            "code": "KeyD",
            "label": "Ctrl+Alt+D",
            "pressCount": 1,
            "modifiers": ShortcutModifiers {
                command: false,
                control: true,
                option: true,
                shift: false,
                function: false,
            },
        }),
        ShortcutKind::Toggle => serde_json::json!({
            "keyCode": VK_T,
            "code": "KeyT",
            "label": "Ctrl+Alt+T",
            "pressCount": 1,
            "modifiers": ShortcutModifiers {
                command: false,
                control: true,
                option: true,
                shift: false,
                function: false,
            },
        }),
    }
}
