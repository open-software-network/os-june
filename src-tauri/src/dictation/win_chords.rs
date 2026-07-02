//! Pure, host-testable logic for the in-process Windows dictation helper.
//!
//! This module mirrors the Swift helper's `ShortcutKeyMonitor` state machine
//! (native/mac-dictation-helper/main.swift) on top of Windows virtual-key
//! events instead of NSEvent/Carbon:
//!
//! - Key chords (e.g. Ctrl+Opt+D) match on the trigger key's virtual key with
//!   an exact modifier state, and produce `shortcut_key_down`/`up` edges that
//!   the existing Rust `ShortcutActivationController` consumes unchanged.
//! - Modifier-only chords (code == "Modifiers") match on the exact modifier
//!   set, with the press edge gated on the changed key belonging to the set,
//!   like the Swift `handleFlagsChanged` path.
//! - Double-press toggles (pressCount == 2) and the shared-trigger hold
//!   threshold (a single-press push sharing its chord with a toggle) are
//!   ported from the Swift monitor with the same timing constants.
//!
//! Mapping choice: settings store both a macOS `keyCode` and a W3C UI Events
//! `code` string ("KeyD"). We ignore the macOS keyCode and map `code` to a
//! Windows virtual key so settings roam across platforms. VKs (not scancodes)
//! are used deliberately: the shortcut label says "Ctrl+Opt+D", and matching
//! VK 'D' keeps that label truthful on every keyboard layout, whereas the
//! scancode at the US-D position types a different character on non-QWERTY
//! layouts. Punctuation codes use the US-layout OEM VKs (documented
//! limitation for exotic layouts). "Fn" is not observable on Windows, so
//! Fn-based shortcuts report `fn_monitor_unavailable`, matching the Swift
//! helper's handling of unregistrable chords.
//!
//! Everything here is pure (no Win32 calls) so the chord matcher, key map,
//! and command parsing unit-test on any host.

use super::DictationShortcutKind;
use std::time::{Duration, Instant};

/// A push shorter than this on a shared trigger is (or arms) the toggle;
/// only a hold is the push. Mirrors the Swift monitor's `holdThreshold`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) const HOLD_THRESHOLD: Duration = Duration::from_millis(160);
/// Two taps of a pressCount == 2 toggle must land within this window.
/// Mirrors the Swift monitor's `doublePressWindow`.
pub(crate) const DOUBLE_PRESS_WINDOW: Duration = Duration::from_millis(340);
/// A modifier-only chord held stable for this long during shortcut capture
/// commits as the captured shortcut. Mirrors the Swift capture debounce.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) const CAPTURE_DEBOUNCE: Duration = Duration::from_millis(180);

// Modifier virtual keys (winuser.h). Generic VKs are included alongside the
// left/right variants; the low-level hook reports the specific keys, but the
// generic codes cost nothing to accept.
const VK_SHIFT: u32 = 0x10;
const VK_CONTROL: u32 = 0x11;
const VK_MENU: u32 = 0x12;
const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
const VK_LCONTROL: u32 = 0xA2;
const VK_RCONTROL: u32 = 0xA3;
const VK_LMENU: u32 = 0xA4;
const VK_RMENU: u32 = 0xA5;

/// Map a W3C UI Events `code` string to a Windows virtual key.
pub(crate) fn vk_for_code(code: &str) -> Option<u32> {
    if let Some(letter) = code.strip_prefix("Key").filter(|rest| rest.len() == 1) {
        let ch = letter.chars().next()?;
        if ch.is_ascii_uppercase() {
            return Some(ch as u32); // 'A'..'Z' == VK_A..VK_Z
        }
        return None;
    }
    if let Some(digit) = code.strip_prefix("Digit").filter(|rest| rest.len() == 1) {
        let ch = digit.chars().next()?;
        if ch.is_ascii_digit() {
            return Some(ch as u32); // '0'..'9' == VK_0..VK_9
        }
        return None;
    }
    if let Some(number) = code.strip_prefix('F').filter(|rest| {
        !rest.is_empty() && rest.len() <= 2 && rest.chars().all(|ch| ch.is_ascii_digit())
    }) {
        let index: u32 = number.parse().ok()?;
        if (1..=24).contains(&index) {
            return Some(0x70 + index - 1); // VK_F1..VK_F24
        }
        return None;
    }
    Some(match code {
        "Space" => 0x20,
        "Enter" => 0x0D,
        "Tab" => 0x09,
        "Backspace" => 0x08,
        "Escape" => 0x1B,
        "Minus" => 0xBD,        // VK_OEM_MINUS
        "Equal" => 0xBB,        // VK_OEM_PLUS
        "BracketLeft" => 0xDB,  // VK_OEM_4
        "BracketRight" => 0xDD, // VK_OEM_6
        "Backslash" => 0xDC,    // VK_OEM_5
        "Semicolon" => 0xBA,    // VK_OEM_1
        "Quote" => 0xDE,        // VK_OEM_7
        "Comma" => 0xBC,        // VK_OEM_COMMA
        "Period" => 0xBE,       // VK_OEM_PERIOD
        "Slash" => 0xBF,        // VK_OEM_2
        "Backquote" => 0xC0,    // VK_OEM_3
        "ArrowLeft" => 0x25,
        "ArrowUp" => 0x26,
        "ArrowRight" => 0x27,
        "ArrowDown" => 0x28,
        _ => return None,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ModifierKey {
    Command,
    Control,
    Option,
    Shift,
}

/// The modifier a virtual key contributes, if any. The macOS "command"
/// modifier maps to the Windows key and "option" to Alt.
pub(crate) fn modifier_key_for_vk(vk: u32) -> Option<ModifierKey> {
    match vk {
        VK_SHIFT | VK_LSHIFT | VK_RSHIFT => Some(ModifierKey::Shift),
        VK_CONTROL | VK_LCONTROL | VK_RCONTROL => Some(ModifierKey::Control),
        VK_MENU | VK_LMENU | VK_RMENU => Some(ModifierKey::Option),
        VK_LWIN | VK_RWIN => Some(ModifierKey::Command),
        _ => None,
    }
}

/// Modifier state of a chord. `function` is intentionally absent: Windows
/// keyboards handle Fn in firmware and it never reaches the OS input stream.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Mods {
    pub command: bool,
    pub control: bool,
    pub option: bool,
    pub shift: bool,
}

impl Mods {
    pub fn count(self) -> usize {
        [self.command, self.control, self.option, self.shift]
            .into_iter()
            .filter(|enabled| *enabled)
            .count()
    }

    pub fn has_any(self) -> bool {
        self.count() > 0
    }

    fn set(&mut self, key: ModifierKey, down: bool) {
        match key {
            ModifierKey::Command => self.command = down,
            ModifierKey::Control => self.control = down,
            ModifierKey::Option => self.option = down,
            ModifierKey::Shift => self.shift = down,
        }
    }

    fn contains_key(self, key: ModifierKey) -> bool {
        match key {
            ModifierKey::Command => self.command,
            ModifierKey::Control => self.control,
            ModifierKey::Option => self.option,
            ModifierKey::Shift => self.shift,
        }
    }

    /// Label parts using the same names the Swift helper emits, so captured
    /// modifier-only shortcuts round-trip through the shared settings
    /// normalizer (which regenerates labels in this vocabulary).
    pub fn label_parts(self) -> Vec<&'static str> {
        [
            (self.command, "Cmd"),
            (self.control, "Ctrl"),
            (self.option, "Opt"),
            (self.shift, "Shift"),
        ]
        .into_iter()
        .filter_map(|(enabled, label)| enabled.then_some(label))
        .collect()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Trigger {
    Key(u32),
    ModifierOnly,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WinShortcut {
    pub trigger: Trigger,
    pub mods: Mods,
    pub label: String,
    pub press_count: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Identity {
    trigger: Trigger,
    mods: Mods,
}

impl Identity {
    fn of(shortcut: &WinShortcut) -> Self {
        Self {
            trigger: shortcut.trigger,
            mods: shortcut.mods,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Action {
    /// Emit a shortcut_key_down / shortcut_key_up event.
    Emit {
        kind: DictationShortcutKind,
        label: String,
        down: bool,
    },
    /// Return 1 from the hook: consume the trigger key system-wide, like a
    /// registered Carbon hot key does on macOS.
    SwallowKey,
    /// Call `fire_pending_push(token)` after [`HOLD_THRESHOLD`].
    SchedulePushStart { token: u64 },
    /// Call `fire_capture_commit(token)` after [`CAPTURE_DEBOUNCE`].
    ScheduleCaptureCommit { token: u64 },
}

/// Chord matcher fed raw key transitions from the WH_KEYBOARD_LL hook.
#[derive(Debug, Default)]
pub(crate) struct ChordMatcher {
    push_to_talk: Option<WinShortcut>,
    toggle: Option<WinShortcut>,
    modifiers: Mods,
    active: Option<Identity>,
    active_push: Option<Identity>,
    pending_push: Option<(u64, Identity)>,
    last_tap: Option<(Identity, Instant)>,
    capturing: bool,
    pending_capture: Option<(u64, Mods)>,
    swallowed_vk: Option<u32>,
    next_token: u64,
}

impl ChordMatcher {
    pub fn set_shortcut(&mut self, kind: DictationShortcutKind, shortcut: WinShortcut) {
        match kind {
            DictationShortcutKind::PushToTalk => self.push_to_talk = Some(shortcut),
            DictationShortcutKind::Toggle => self.toggle = Some(shortcut),
        }
        self.reset_transient();
    }

    /// Drop a kind's chord entirely (its configured shortcut cannot be
    /// monitored on Windows, e.g. Fn-based). Mirrors the Swift helper
    /// skipping registration for such chords.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn clear_shortcut(&mut self, kind: DictationShortcutKind) {
        match kind {
            DictationShortcutKind::PushToTalk => self.push_to_talk = None,
            DictationShortcutKind::Toggle => self.toggle = None,
        }
        self.reset_transient();
    }

    pub fn start_capture(&mut self) {
        self.reset_transient();
        self.capturing = true;
    }

    pub fn cancel_capture(&mut self) {
        self.capturing = false;
        self.pending_capture = None;
    }

    fn reset_transient(&mut self) {
        self.active = None;
        self.active_push = None;
        self.pending_push = None;
        self.last_tap = None;
        self.pending_capture = None;
    }

    fn take_token(&mut self) -> u64 {
        self.next_token += 1;
        self.next_token
    }

    /// Feed one raw key transition. `down` covers WM_KEYDOWN/WM_SYSKEYDOWN.
    pub fn key_event(&mut self, vk: u32, down: bool, now: Instant) -> Vec<Action> {
        let mut actions = Vec::new();

        if let Some(modifier) = modifier_key_for_vk(vk) {
            let was_down = self.modifiers.contains_key(modifier);
            self.modifiers.set(modifier, down);
            let current = self.modifiers;
            if down == was_down {
                // Auto-repeat of a held modifier: no edge.
                return actions;
            }

            if self.capturing {
                self.handle_capture(current, &mut actions);
                return actions;
            }

            // Any modifier change away from an active chord's exact set ends
            // the press. It only counts as a physical release (arming the
            // double-press detector) when the changed key belongs to the
            // chord, mirroring the Swift handleFlagsChanged gating.
            if let Some(active) = self.active {
                if active.mods != current {
                    let physical = active.mods.contains_key(modifier);
                    self.physical_up(active, physical, now, &mut actions);
                }
            }

            // Modifier-only press edge: exact match, and the changed key must
            // be part of the chord (an arrow key's phantom flags or a foreign
            // modifier release must not read as a fresh press).
            if let Some(identity) = self.matching_modifier_only(current) {
                if identity.mods.contains_key(modifier) && down {
                    self.physical_down(identity, now, &mut actions);
                }
            }
            return actions;
        }

        if self.capturing {
            // Key chords are captured by the focused settings webview (DOM),
            // exactly as on macOS. Don't match or swallow while capturing.
            return actions;
        }

        if down {
            if let Some(identity) = self.matching_key_identity(vk) {
                self.swallowed_vk = Some(vk);
                actions.push(Action::SwallowKey);
                self.physical_down(identity, now, &mut actions);
            }
        } else {
            if self.swallowed_vk == Some(vk) {
                self.swallowed_vk = None;
                actions.push(Action::SwallowKey);
            }
            if let Some(active) = self.active {
                if active.trigger == Trigger::Key(vk) {
                    self.physical_up(active, true, now, &mut actions);
                }
            }
        }
        actions
    }

    /// The hold threshold elapsed for a scheduled ambiguous push start.
    pub fn fire_pending_push(&mut self, token: u64) -> Vec<Action> {
        let mut actions = Vec::new();
        let Some((pending_token, identity)) = self.pending_push else {
            return actions;
        };
        if pending_token != token || self.active != Some(identity) {
            return actions;
        }
        self.pending_push = None;
        if let Some((kind, shortcut)) =
            self.matches(identity).into_iter().find(|(kind, shortcut)| {
                *kind == DictationShortcutKind::PushToTalk && shortcut.press_count == 1
            })
        {
            self.active_push = Some(identity);
            actions.push(Action::Emit {
                kind,
                label: shortcut.label,
                down: true,
            });
        }
        actions
    }

    /// The capture debounce elapsed; commit the held modifier-only chord.
    pub fn fire_capture_commit(&mut self, token: u64) -> Option<Mods> {
        if !self.capturing {
            return None;
        }
        let (pending_token, mods) = self.pending_capture?;
        if pending_token != token {
            return None;
        }
        self.capturing = false;
        self.pending_capture = None;
        Some(mods)
    }

    fn handle_capture(&mut self, current: Mods, actions: &mut Vec<Action>) {
        // Only combos of two or more modifiers are supported modifier-only
        // shortcuts (bare Fn, the macOS single-modifier case, does not exist
        // on Windows).
        if current.count() >= 2 {
            if self
                .pending_capture
                .is_some_and(|(_, pending)| pending == current)
            {
                return;
            }
            let token = self.take_token();
            self.pending_capture = Some((token, current));
            actions.push(Action::ScheduleCaptureCommit { token });
        } else {
            self.pending_capture = None;
        }
    }

    fn matching_key_identity(&self, vk: u32) -> Option<Identity> {
        let current = self.modifiers;
        self.entries()
            .into_iter()
            .find(|(_, shortcut)| shortcut.trigger == Trigger::Key(vk) && shortcut.mods == current)
            .map(|(_, shortcut)| Identity::of(&shortcut))
    }

    fn matching_modifier_only(&self, current: Mods) -> Option<Identity> {
        self.entries()
            .into_iter()
            .find(|(_, shortcut)| {
                shortcut.trigger == Trigger::ModifierOnly && shortcut.mods == current
            })
            .map(|(_, shortcut)| Identity::of(&shortcut))
    }

    fn entries(&self) -> Vec<(DictationShortcutKind, WinShortcut)> {
        let mut entries = Vec::with_capacity(2);
        if let Some(shortcut) = &self.push_to_talk {
            entries.push((DictationShortcutKind::PushToTalk, shortcut.clone()));
        }
        if let Some(shortcut) = &self.toggle {
            entries.push((DictationShortcutKind::Toggle, shortcut.clone()));
        }
        entries
    }

    fn matches(&self, identity: Identity) -> Vec<(DictationShortcutKind, WinShortcut)> {
        self.entries()
            .into_iter()
            .filter(|(_, shortcut)| Identity::of(shortcut) == identity)
            .collect()
    }

    fn physical_down(&mut self, identity: Identity, now: Instant, actions: &mut Vec<Action>) {
        if self.active == Some(identity) {
            return;
        }
        self.active = Some(identity);

        let matches = self.matches(identity);
        if let Some((_, shortcut)) = matches.iter().find(|(kind, shortcut)| {
            *kind == DictationShortcutKind::Toggle && shortcut.press_count == 2
        }) {
            let double_tapped = self.last_tap.is_some_and(|(tap_identity, tapped_at)| {
                tap_identity == identity && now.duration_since(tapped_at) <= DOUBLE_PRESS_WINDOW
            });
            if double_tapped {
                self.last_tap = None;
                self.pending_push = None;
                actions.push(Action::Emit {
                    kind: DictationShortcutKind::Toggle,
                    label: shortcut.label.clone(),
                    down: true,
                });
                return;
            }
        }

        if let Some((_, shortcut)) = matches.iter().find(|(kind, shortcut)| {
            *kind == DictationShortcutKind::Toggle && shortcut.press_count == 1
        }) {
            actions.push(Action::Emit {
                kind: DictationShortcutKind::Toggle,
                label: shortcut.label.clone(),
                down: true,
            });
        }

        if let Some((_, shortcut)) = matches.iter().find(|(kind, shortcut)| {
            *kind == DictationShortcutKind::PushToTalk && shortcut.press_count == 1
        }) {
            let shares_toggle = matches
                .iter()
                .any(|(kind, _)| *kind == DictationShortcutKind::Toggle);
            if shares_toggle {
                // A toggle shares this trigger, so a fresh press is
                // ambiguous: a tap is (or arms) the toggle, only a hold is
                // the push. The hold threshold tells them apart.
                let token = self.take_token();
                self.pending_push = Some((token, identity));
                actions.push(Action::SchedulePushStart { token });
            } else {
                self.pending_push = None;
                self.active_push = Some(identity);
                actions.push(Action::Emit {
                    kind: DictationShortcutKind::PushToTalk,
                    label: shortcut.label.clone(),
                    down: true,
                });
            }
        }
    }

    fn physical_up(
        &mut self,
        identity: Identity,
        is_physical_release: bool,
        now: Instant,
        actions: &mut Vec<Action>,
    ) {
        if self.active != Some(identity) {
            return;
        }
        self.active = None;

        if self.active_push == Some(identity) {
            self.active_push = None;
            if let Some((kind, shortcut)) = self
                .matches(identity)
                .into_iter()
                .find(|(kind, _)| *kind == DictationShortcutKind::PushToTalk)
            {
                actions.push(Action::Emit {
                    kind,
                    label: shortcut.label,
                    down: false,
                });
                return;
            }
        }

        self.pending_push = None;

        if is_physical_release
            && self.matches(identity).iter().any(|(kind, shortcut)| {
                *kind == DictationShortcutKind::Toggle && shortcut.press_count == 2
            })
        {
            self.last_tap = Some((identity, now));
        }
    }
}

/// Mirror of the Swift helper's `MonitoredShortcut.displayLabel`: a
/// double-press shortcut renders as "label+label" unless already doubled.
pub(crate) fn display_label(label: &str, press_count: u8) -> String {
    if press_count != 2 {
        return label.to_string();
    }
    let parts: Vec<&str> = label.split('+').collect();
    if !parts.is_empty() && parts.len() % 2 == 0 {
        let half = parts.len() / 2;
        if parts[..half] == parts[half..] {
            return label.to_string();
        }
    }
    format!("{label}+{label}")
}

/// The helper command vocabulary (the JSON lines the Swift helper accepts on
/// stdin, routed in-process on Windows).
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum HelperCommand {
    Ping,
    GetPermissionStatus,
    RequestMicrophonePermission,
    RequestAccessibilityPermission,
    ListMicrophones,
    StartListening,
    StopAndPaste,
    StartMicTest {
        duration_seconds: f64,
    },
    DiscardMicTest,
    SetMicrophone {
        id: Option<String>,
        name: Option<String>,
    },
    SetShortcut {
        shortcut: Option<serde_json::Value>,
    },
    StartShortcutCapture,
    CancelShortcutCapture,
    ToggleListening {
        shortcut: String,
    },
    PasteText {
        text: String,
    },
    DiscardRecording,
    Shutdown,
    Unknown,
}

pub(crate) fn parse_helper_command(command: &serde_json::Value) -> HelperCommand {
    let command_type = command
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    match command_type {
        "ping" => HelperCommand::Ping,
        "get_permission_status" => HelperCommand::GetPermissionStatus,
        "request_microphone_permission" => HelperCommand::RequestMicrophonePermission,
        "request_accessibility_permission" => HelperCommand::RequestAccessibilityPermission,
        "list_microphones" => HelperCommand::ListMicrophones,
        "start_listening" => HelperCommand::StartListening,
        "stop_and_paste" => HelperCommand::StopAndPaste,
        "start_mic_test" => HelperCommand::StartMicTest {
            duration_seconds: command
                .get("durationSeconds")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(5.0),
        },
        "discard_mic_test" => HelperCommand::DiscardMicTest,
        "set_microphone" => HelperCommand::SetMicrophone {
            id: command
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            name: command
                .get("name")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
        },
        "set_shortcut" => HelperCommand::SetShortcut {
            shortcut: command.get("shortcut").cloned(),
        },
        "start_shortcut_capture" => HelperCommand::StartShortcutCapture,
        "cancel_shortcut_capture" => HelperCommand::CancelShortcutCapture,
        "toggle_listening" => HelperCommand::ToggleListening {
            shortcut: command
                .get("shortcut")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("hotkey")
                .to_string(),
        },
        "paste_text" => HelperCommand::PasteText {
            text: command
                .get("text")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
        },
        "discard_recording" => HelperCommand::DiscardRecording,
        "shutdown" => HelperCommand::Shutdown,
        _ => HelperCommand::Unknown,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ShortcutParseError {
    /// The payload is malformed; the Swift helper answers `invalid_shortcut`.
    Invalid,
    /// The chord relies on the Fn key, which Windows cannot observe.
    FunctionUnsupported { label: String },
    /// The `code` string has no Windows virtual key mapping.
    Unmappable { label: String },
}

/// Parse a `set_shortcut` payload into a monitorable Windows chord.
pub(crate) fn parse_shortcut(
    payload: &serde_json::Value,
) -> Result<(DictationShortcutKind, WinShortcut), ShortcutParseError> {
    let code = payload
        .get("code")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let label = payload
        .get("label")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let kind = match payload.get("kind").and_then(serde_json::Value::as_str) {
        Some("push_to_talk") => DictationShortcutKind::PushToTalk,
        Some("toggle") => DictationShortcutKind::Toggle,
        _ => return Err(ShortcutParseError::Invalid),
    };
    if code.is_empty() || label.is_empty() {
        return Err(ShortcutParseError::Invalid);
    }

    let raw_press_count = payload
        .get("pressCount")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(1);
    let press_count = if raw_press_count == 2 { 2 } else { 1 };

    let modifiers = payload.get("modifiers");
    let modifier = |name: &str| {
        modifiers
            .and_then(|modifiers| modifiers.get(name))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    };
    let mods = Mods {
        command: modifier("command"),
        control: modifier("control"),
        option: modifier("option"),
        shift: modifier("shift"),
    };
    let function = modifier("function");

    if function || code.eq_ignore_ascii_case("Fn") {
        return Err(ShortcutParseError::FunctionUnsupported { label });
    }

    let key_code = payload
        .get("keyCode")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let trigger = if key_code == 0 && code.eq_ignore_ascii_case("Modifiers") {
        if mods.count() < 2 {
            return Err(ShortcutParseError::Invalid);
        }
        Trigger::ModifierOnly
    } else {
        let vk = vk_for_code(&code).ok_or_else(|| ShortcutParseError::Unmappable {
            label: label.clone(),
        })?;
        if !mods.has_any() {
            return Err(ShortcutParseError::Invalid);
        }
        Trigger::Key(vk)
    };

    Ok((
        kind,
        WinShortcut {
            trigger,
            mods,
            label: display_label(&label, press_count),
            press_count,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctrl_alt(vk: u32, label: &str) -> WinShortcut {
        WinShortcut {
            trigger: Trigger::Key(vk),
            mods: Mods {
                control: true,
                option: true,
                ..Mods::default()
            },
            label: label.to_string(),
            press_count: 1,
        }
    }

    fn press_chord(matcher: &mut ChordMatcher, now: Instant) -> Vec<Action> {
        let mut actions = Vec::new();
        actions.extend(matcher.key_event(VK_LCONTROL, true, now));
        actions.extend(matcher.key_event(VK_LMENU, true, now));
        actions.extend(matcher.key_event(0x44, true, now)); // 'D'
        actions
    }

    #[test]
    fn maps_w3c_codes_to_virtual_keys() {
        assert_eq!(vk_for_code("KeyD"), Some(0x44));
        assert_eq!(vk_for_code("KeyA"), Some(0x41));
        assert_eq!(vk_for_code("Digit1"), Some(0x31));
        assert_eq!(vk_for_code("Digit0"), Some(0x30));
        assert_eq!(vk_for_code("Space"), Some(0x20));
        assert_eq!(vk_for_code("Comma"), Some(0xBC));
        assert_eq!(vk_for_code("F1"), Some(0x70));
        assert_eq!(vk_for_code("F12"), Some(0x7B));
        assert_eq!(vk_for_code("ArrowUp"), Some(0x26));
        assert_eq!(vk_for_code("Fn"), None);
        assert_eq!(vk_for_code("Modifiers"), None);
        assert_eq!(vk_for_code(""), None);
        assert_eq!(vk_for_code("F25"), None);
    }

    #[test]
    fn key_chord_push_emits_down_and_up_and_swallows_trigger() {
        let mut matcher = ChordMatcher::default();
        matcher.set_shortcut(
            DictationShortcutKind::PushToTalk,
            ctrl_alt(0x44, "Ctrl+Opt+D"),
        );

        let now = Instant::now();
        let actions = press_chord(&mut matcher, now);
        assert_eq!(
            actions,
            vec![
                Action::SwallowKey,
                Action::Emit {
                    kind: DictationShortcutKind::PushToTalk,
                    label: "Ctrl+Opt+D".to_string(),
                    down: true,
                },
            ]
        );

        let actions = matcher.key_event(0x44, false, now + Duration::from_millis(400));
        assert_eq!(
            actions,
            vec![
                Action::SwallowKey,
                Action::Emit {
                    kind: DictationShortcutKind::PushToTalk,
                    label: "Ctrl+Opt+D".to_string(),
                    down: false,
                },
            ]
        );
    }

    #[test]
    fn releasing_a_chord_modifier_ends_the_push() {
        let mut matcher = ChordMatcher::default();
        matcher.set_shortcut(
            DictationShortcutKind::PushToTalk,
            ctrl_alt(0x44, "Ctrl+Opt+D"),
        );
        let now = Instant::now();
        press_chord(&mut matcher, now);

        let actions = matcher.key_event(VK_LCONTROL, false, now + Duration::from_millis(300));
        assert_eq!(
            actions,
            vec![Action::Emit {
                kind: DictationShortcutKind::PushToTalk,
                label: "Ctrl+Opt+D".to_string(),
                down: false,
            }]
        );
        // The still-swallowed trigger key's release stays consumed.
        let actions = matcher.key_event(0x44, false, now + Duration::from_millis(320));
        assert_eq!(actions, vec![Action::SwallowKey]);
    }

    #[test]
    fn wrong_modifiers_do_not_match_or_swallow() {
        let mut matcher = ChordMatcher::default();
        matcher.set_shortcut(
            DictationShortcutKind::PushToTalk,
            ctrl_alt(0x44, "Ctrl+Opt+D"),
        );
        let now = Instant::now();
        matcher.key_event(VK_LCONTROL, true, now);
        assert!(matcher.key_event(0x44, true, now).is_empty());
        assert!(matcher.key_event(0x44, false, now).is_empty());
    }

    #[test]
    fn single_press_toggle_emits_down_only() {
        let mut matcher = ChordMatcher::default();
        matcher.set_shortcut(DictationShortcutKind::Toggle, ctrl_alt(0x54, "Ctrl+Opt+T"));
        let now = Instant::now();

        let mut actions = Vec::new();
        actions.extend(matcher.key_event(VK_LCONTROL, true, now));
        actions.extend(matcher.key_event(VK_LMENU, true, now));
        actions.extend(matcher.key_event(0x54, true, now));
        assert_eq!(
            actions,
            vec![
                Action::SwallowKey,
                Action::Emit {
                    kind: DictationShortcutKind::Toggle,
                    label: "Ctrl+Opt+T".to_string(),
                    down: true,
                },
            ]
        );
        // Toggle releases emit no edge (only the swallow of the trigger).
        let actions = matcher.key_event(0x54, false, now + Duration::from_millis(50));
        assert_eq!(actions, vec![Action::SwallowKey]);
    }

    #[test]
    fn double_press_toggle_fires_on_second_tap_within_window() {
        let mut matcher = ChordMatcher::default();
        let mut shortcut = ctrl_alt(0x54, "Ctrl+Opt+T+Ctrl+Opt+T");
        shortcut.press_count = 2;
        matcher.set_shortcut(DictationShortcutKind::Toggle, shortcut);

        let now = Instant::now();
        matcher.key_event(VK_LCONTROL, true, now);
        matcher.key_event(VK_LMENU, true, now);
        // First tap: no edge.
        let actions = matcher.key_event(0x54, true, now);
        assert_eq!(actions, vec![Action::SwallowKey]);
        matcher.key_event(0x54, false, now + Duration::from_millis(60));

        // Second tap inside the window: toggle fires.
        let actions = matcher.key_event(0x54, true, now + Duration::from_millis(200));
        assert_eq!(
            actions,
            vec![
                Action::SwallowKey,
                Action::Emit {
                    kind: DictationShortcutKind::Toggle,
                    label: "Ctrl+Opt+T+Ctrl+Opt+T".to_string(),
                    down: true,
                },
            ]
        );
    }

    #[test]
    fn double_press_toggle_expires_outside_window() {
        let mut matcher = ChordMatcher::default();
        let mut shortcut = ctrl_alt(0x54, "Ctrl+Opt+T");
        shortcut.press_count = 2;
        matcher.set_shortcut(DictationShortcutKind::Toggle, shortcut);

        let now = Instant::now();
        matcher.key_event(VK_LCONTROL, true, now);
        matcher.key_event(VK_LMENU, true, now);
        matcher.key_event(0x54, true, now);
        matcher.key_event(0x54, false, now + Duration::from_millis(60));

        let late = now + Duration::from_millis(600);
        let actions = matcher.key_event(0x54, true, late);
        assert_eq!(actions, vec![Action::SwallowKey]);
    }

    #[test]
    fn shared_trigger_hold_becomes_push_and_tap_arms_toggle() {
        let mut matcher = ChordMatcher::default();
        matcher.set_shortcut(
            DictationShortcutKind::PushToTalk,
            ctrl_alt(0x44, "Ctrl+Opt+D"),
        );
        let mut toggle = ctrl_alt(0x44, "Ctrl+Opt+D+Ctrl+Opt+D");
        toggle.press_count = 2;
        matcher.set_shortcut(DictationShortcutKind::Toggle, toggle);

        // Hold: pending push scheduled, then fires after the threshold.
        let now = Instant::now();
        let actions = press_chord(&mut matcher, now);
        let token = actions
            .iter()
            .find_map(|action| match action {
                Action::SchedulePushStart { token } => Some(*token),
                _ => None,
            })
            .expect("ambiguous press should schedule a pending push");
        let actions = matcher.fire_pending_push(token);
        assert_eq!(
            actions,
            vec![Action::Emit {
                kind: DictationShortcutKind::PushToTalk,
                label: "Ctrl+Opt+D".to_string(),
                down: true,
            }]
        );
        let actions = matcher.key_event(0x44, false, now + Duration::from_millis(500));
        assert!(actions.contains(&Action::Emit {
            kind: DictationShortcutKind::PushToTalk,
            label: "Ctrl+Opt+D".to_string(),
            down: false,
        }));

        // Quick tap-tap: the stale pending push never fires, the second tap
        // toggles.
        let now = now + Duration::from_secs(2);
        let actions = press_chord(&mut matcher, now);
        let token = actions
            .iter()
            .find_map(|action| match action {
                Action::SchedulePushStart { token } => Some(*token),
                _ => None,
            })
            .expect("second ambiguous press should schedule a pending push");
        matcher.key_event(0x44, false, now + Duration::from_millis(50));
        assert!(matcher.fire_pending_push(token).is_empty());
        let actions = matcher.key_event(0x44, true, now + Duration::from_millis(150));
        assert!(actions.contains(&Action::Emit {
            kind: DictationShortcutKind::Toggle,
            label: "Ctrl+Opt+D+Ctrl+Opt+D".to_string(),
            down: true,
        }));
    }

    #[test]
    fn modifier_only_chord_edges() {
        let mut matcher = ChordMatcher::default();
        matcher.set_shortcut(
            DictationShortcutKind::PushToTalk,
            WinShortcut {
                trigger: Trigger::ModifierOnly,
                mods: Mods {
                    control: true,
                    option: true,
                    ..Mods::default()
                },
                label: "Ctrl+Opt".to_string(),
                press_count: 1,
            },
        );

        let now = Instant::now();
        assert!(matcher.key_event(VK_LCONTROL, true, now).is_empty());
        let actions = matcher.key_event(VK_LMENU, true, now);
        assert_eq!(
            actions,
            vec![Action::Emit {
                kind: DictationShortcutKind::PushToTalk,
                label: "Ctrl+Opt".to_string(),
                down: true,
            }]
        );

        // A foreign modifier interrupting the chord ends the press.
        let actions = matcher.key_event(VK_LSHIFT, true, now + Duration::from_millis(300));
        assert_eq!(
            actions,
            vec![Action::Emit {
                kind: DictationShortcutKind::PushToTalk,
                label: "Ctrl+Opt".to_string(),
                down: false,
            }]
        );
    }

    #[test]
    fn modifier_only_release_ends_the_press() {
        let mut matcher = ChordMatcher::default();
        matcher.set_shortcut(
            DictationShortcutKind::PushToTalk,
            WinShortcut {
                trigger: Trigger::ModifierOnly,
                mods: Mods {
                    control: true,
                    option: true,
                    ..Mods::default()
                },
                label: "Ctrl+Opt".to_string(),
                press_count: 1,
            },
        );
        let now = Instant::now();
        matcher.key_event(VK_LCONTROL, true, now);
        matcher.key_event(VK_LMENU, true, now);
        let actions = matcher.key_event(VK_LMENU, false, now + Duration::from_millis(400));
        assert_eq!(
            actions,
            vec![Action::Emit {
                kind: DictationShortcutKind::PushToTalk,
                label: "Ctrl+Opt".to_string(),
                down: false,
            }]
        );
    }

    #[test]
    fn capture_commits_a_stable_modifier_combo() {
        let mut matcher = ChordMatcher::default();
        matcher.start_capture();
        let now = Instant::now();
        assert!(matcher.key_event(VK_LCONTROL, true, now).is_empty());
        let actions = matcher.key_event(VK_LSHIFT, true, now);
        let token = actions
            .iter()
            .find_map(|action| match action {
                Action::ScheduleCaptureCommit { token } => Some(*token),
                _ => None,
            })
            .expect("two held modifiers should schedule a capture commit");
        let mods = matcher.fire_capture_commit(token).expect("capture commits");
        assert_eq!(
            mods,
            Mods {
                control: true,
                shift: true,
                ..Mods::default()
            }
        );
        assert_eq!(mods.label_parts(), vec!["Ctrl", "Shift"]);
    }

    #[test]
    fn capture_cancels_when_combo_drops_below_two_modifiers() {
        let mut matcher = ChordMatcher::default();
        matcher.start_capture();
        let now = Instant::now();
        matcher.key_event(VK_LCONTROL, true, now);
        let actions = matcher.key_event(VK_LSHIFT, true, now);
        let token = actions
            .iter()
            .find_map(|action| match action {
                Action::ScheduleCaptureCommit { token } => Some(*token),
                _ => None,
            })
            .expect("commit scheduled");
        matcher.key_event(VK_LSHIFT, false, now + Duration::from_millis(50));
        assert_eq!(matcher.fire_capture_commit(token), None);

        matcher.cancel_capture();
        assert_eq!(matcher.fire_capture_commit(token), None);
    }

    #[test]
    fn capture_ignores_key_chords_for_the_dom() {
        let mut matcher = ChordMatcher::default();
        matcher.set_shortcut(
            DictationShortcutKind::PushToTalk,
            ctrl_alt(0x44, "Ctrl+Opt+D"),
        );
        matcher.start_capture();
        let now = Instant::now();
        matcher.key_event(VK_LCONTROL, true, now);
        matcher.key_event(VK_LMENU, true, now);
        // The user's current chord must reach the DOM unswallowed and
        // unmatched while capturing (the held modifier pair may still
        // schedule a modifier-only capture, which typing the key does not
        // commit).
        assert!(matcher.key_event(0x44, true, now).is_empty());
        assert!(matcher.key_event(0x44, false, now).is_empty());
    }

    #[test]
    fn parses_helper_commands() {
        assert_eq!(
            parse_helper_command(&json!({"type": "start_listening"})),
            HelperCommand::StartListening
        );
        assert_eq!(
            parse_helper_command(&json!({"type": "stop_and_paste"})),
            HelperCommand::StopAndPaste
        );
        assert_eq!(
            parse_helper_command(&json!({"type": "toggle_listening", "shortcut": "Ctrl+Opt+T"})),
            HelperCommand::ToggleListening {
                shortcut: "Ctrl+Opt+T".to_string()
            }
        );
        assert_eq!(
            parse_helper_command(&json!({"type": "toggle_listening"})),
            HelperCommand::ToggleListening {
                shortcut: "hotkey".to_string()
            }
        );
        assert_eq!(
            parse_helper_command(&json!({"type": "paste_text", "text": "hello"})),
            HelperCommand::PasteText {
                text: "hello".to_string()
            }
        );
        assert_eq!(
            parse_helper_command(&json!({"type": "start_mic_test", "durationSeconds": 3})),
            HelperCommand::StartMicTest {
                duration_seconds: 3.0
            }
        );
        assert_eq!(
            parse_helper_command(&json!({"type": "start_mic_test"})),
            HelperCommand::StartMicTest {
                duration_seconds: 5.0
            }
        );
        assert_eq!(
            parse_helper_command(
                &json!({"type": "set_microphone", "id": "mic-1", "name": "USB Mic"})
            ),
            HelperCommand::SetMicrophone {
                id: Some("mic-1".to_string()),
                name: Some("USB Mic".to_string()),
            }
        );
        assert_eq!(
            parse_helper_command(&json!({"type": "made_up"})),
            HelperCommand::Unknown
        );
        assert_eq!(parse_helper_command(&json!({})), HelperCommand::Unknown);
    }

    #[test]
    fn parses_key_chord_shortcut() {
        let (kind, shortcut) = parse_shortcut(&json!({
            "keyCode": 2,
            "code": "KeyD",
            "label": "Ctrl+Opt+D",
            "kind": "push_to_talk",
            "pressCount": 1,
            "modifiers": {"command": false, "control": true, "option": true, "shift": false, "function": false},
        }))
        .expect("chord should parse");
        assert_eq!(kind, DictationShortcutKind::PushToTalk);
        assert_eq!(shortcut.trigger, Trigger::Key(0x44));
        assert_eq!(
            shortcut.mods,
            Mods {
                control: true,
                option: true,
                ..Mods::default()
            }
        );
        assert_eq!(shortcut.label, "Ctrl+Opt+D");
        assert_eq!(shortcut.press_count, 1);
    }

    #[test]
    fn parses_modifier_only_and_double_press_shortcuts() {
        let (kind, shortcut) = parse_shortcut(&json!({
            "keyCode": 0,
            "code": "Modifiers",
            "label": "Ctrl+Shift",
            "kind": "toggle",
            "pressCount": 2,
            "modifiers": {"command": false, "control": true, "option": false, "shift": true, "function": false},
        }))
        .expect("modifier-only chord should parse");
        assert_eq!(kind, DictationShortcutKind::Toggle);
        assert_eq!(shortcut.trigger, Trigger::ModifierOnly);
        assert_eq!(shortcut.press_count, 2);
        assert_eq!(shortcut.label, "Ctrl+Shift+Ctrl+Shift");
    }

    #[test]
    fn rejects_fn_and_unmappable_shortcuts() {
        assert_eq!(
            parse_shortcut(&json!({
                "keyCode": 0,
                "code": "Fn",
                "label": "Fn",
                "kind": "push_to_talk",
                "pressCount": 1,
                "modifiers": {"function": true},
            })),
            Err(ShortcutParseError::FunctionUnsupported {
                label: "Fn".to_string()
            })
        );
        assert_eq!(
            parse_shortcut(&json!({
                "keyCode": 99,
                "code": "NumpadEnter",
                "label": "Ctrl+NumpadEnter",
                "kind": "toggle",
                "pressCount": 1,
                "modifiers": {"control": true},
            })),
            Err(ShortcutParseError::Unmappable {
                label: "Ctrl+NumpadEnter".to_string()
            })
        );
        assert_eq!(
            parse_shortcut(&json!({"kind": "toggle"})),
            Err(ShortcutParseError::Invalid)
        );
    }

    #[test]
    fn doubles_display_labels_once() {
        assert_eq!(display_label("Ctrl+Opt+T", 1), "Ctrl+Opt+T");
        assert_eq!(display_label("Ctrl+Opt+T", 2), "Ctrl+Opt+T+Ctrl+Opt+T");
        assert_eq!(
            display_label("Ctrl+Opt+T+Ctrl+Opt+T", 2),
            "Ctrl+Opt+T+Ctrl+Opt+T"
        );
    }
}
