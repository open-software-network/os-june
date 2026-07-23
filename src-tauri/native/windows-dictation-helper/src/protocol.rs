use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandEnvelope {
    #[serde(rename = "type")]
    pub command_type: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub kind: Option<ShortcutKind>,
    #[serde(default)]
    pub shortcut: Option<Value>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub composer_request_id: Option<String>,
    #[serde(default)]
    pub june_process_id: Option<u32>,
    #[serde(default)]
    pub june_window_handle: Option<isize>,
    #[serde(default)]
    pub inserted: Option<bool>,
    #[serde(default)]
    pub duration_seconds: Option<u64>,
    #[serde(flatten)]
    pub _extra: serde_json::Map<String, Value>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShortcutKind {
    PushToTalk,
    Toggle,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutCommand {
    #[serde(default)]
    pub key_code: u32,
    pub code: String,
    pub label: String,
    pub kind: ShortcutKind,
    #[serde(default = "default_press_count")]
    pub press_count: u8,
    pub modifiers: ShortcutModifiers,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutModifiers {
    #[serde(default)]
    pub command: bool,
    #[serde(default)]
    pub control: bool,
    #[serde(default)]
    pub option: bool,
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub function: bool,
}

fn default_press_count() -> u8 {
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggle_command_accepts_legacy_shortcut_label() {
        let command: CommandEnvelope =
            serde_json::from_str(r#"{"type":"toggle_listening","shortcut":"Ctrl+Alt+T"}"#)
                .expect("toggle command parses");

        assert_eq!(command.command_type, "toggle_listening");
        assert_eq!(
            command.shortcut,
            Some(Value::String("Ctrl+Alt+T".to_string()))
        );
    }

    #[test]
    fn composer_command_accepts_exact_june_window_identity() {
        let command: CommandEnvelope = serde_json::from_str(
            r#"{"type":"start_listening","composerRequestId":"request-1","juneProcessId":42,"juneWindowHandle":1234}"#,
        )
        .expect("composer command parses");

        assert_eq!(command.composer_request_id.as_deref(), Some("request-1"));
        assert_eq!(command.june_process_id, Some(42));
        assert_eq!(command.june_window_handle, Some(1234));
    }

    #[test]
    fn set_shortcut_keeps_structured_payload() {
        let command: CommandEnvelope = serde_json::from_str(
            r#"{"type":"set_shortcut","shortcut":{"keyCode":32,"code":"KeyU","label":"Ctrl+U","kind":"push_to_talk","pressCount":1,"modifiers":{"control":true}}}"#,
        )
        .expect("set shortcut command parses");
        let shortcut =
            serde_json::from_value::<ShortcutCommand>(command.shortcut.expect("shortcut payload"))
                .expect("structured shortcut parses");

        assert_eq!(shortcut.kind, ShortcutKind::PushToTalk);
        assert_eq!(shortcut.code, "KeyU");
        assert!(shortcut.modifiers.control);
    }

    #[test]
    fn composer_delivery_fields_parse() {
        let command: CommandEnvelope = serde_json::from_str(
            r#"{"type":"composer_delivery_result","composerRequestId":"request-1","juneProcessId":42,"inserted":true}"#,
        )
        .expect("composer acknowledgement parses");

        assert_eq!(command.composer_request_id.as_deref(), Some("request-1"));
        assert_eq!(command.june_process_id, Some(42));
        assert_eq!(command.inserted, Some(true));
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneDevice {
    pub id: String,
    pub name: String,
}

pub fn event(event_type: &str, payload: Value) -> Value {
    serde_json::json!({
        "type": event_type,
        "payload": payload,
    })
}

pub fn simple_event(event_type: &str) -> Value {
    serde_json::json!({ "type": event_type })
}

pub fn error_event(code: &str, message: impl Into<String>) -> Value {
    event(
        "error",
        serde_json::json!({
            "code": code,
            "message": message.into(),
        }),
    )
}
