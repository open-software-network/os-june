//! Global dictation-shortcut state machine (platform-agnostic core).
//!
//! Ported from the dictation helper's `ShortcutKeyMonitor` so shortcut
//! detection runs in the *main* June process — part of making `June.app` the
//! sole Accessibility subject (the global modifier monitor needs that grant).
//!
//! This module is pure logic: it consumes [`Input`]s (Carbon hot-key edges,
//! modifier-flag changes, timer firings, config changes) and returns
//! [`Action`]s (emit a shortcut down/up, schedule/cancel a timer, (re)register
//! Carbon hot keys). The macOS driver in [`crate::macos_shortcuts`] wires Carbon
//! + `NSEvent` + dispatch timers to it; all the hard-won edge-detection lives
//! here and is unit-tested without any event loop.

use std::collections::HashMap;

/// Hold this long before an ambiguous press (a trigger shared by push-to-talk
/// and a toggle) commits to push-to-talk.
const HOLD_THRESHOLD_MS: u64 = 160;
/// Two taps of a double-press toggle must land within this window.
const DOUBLE_PRESS_WINDOW_MS: u64 = 340;
/// Debounce a modifier-only chord this long during capture before accepting it.
const CAPTURE_DEBOUNCE_MS: u64 = 180;

// Carbon modifier bit masks (`<Carbon/Carbon.h>`).
const CMD_KEY: u32 = 0x0100;
const SHIFT_KEY: u32 = 0x0200;
const OPTION_KEY: u32 = 0x0800;
const CONTROL_KEY: u32 = 0x1000;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Default)]
pub struct ShortcutModifiers {
    pub command: bool,
    pub control: bool,
    pub option: bool,
    pub shift: bool,
    pub function: bool,
}

impl ShortcutModifiers {
    pub fn is_bare_function(&self) -> bool {
        self.function && !self.command && !self.control && !self.option && !self.shift
    }

    pub fn modifier_count(&self) -> usize {
        [
            self.command,
            self.control,
            self.option,
            self.shift,
            self.function,
        ]
        .iter()
        .filter(|set| **set)
        .count()
    }

    /// A modifier-only chord is usable as a shortcut when it is a bare Fn or has
    /// at least two modifiers (one stray modifier is too easy to trigger).
    pub fn is_supported_modifier_only_shortcut(&self) -> bool {
        self.is_bare_function() || self.modifier_count() >= 2
    }

    pub fn label_parts(&self) -> Vec<&'static str> {
        let mut parts = Vec::new();
        if self.command {
            parts.push("Cmd");
        }
        if self.control {
            parts.push("Ctrl");
        }
        if self.option {
            parts.push("Opt");
        }
        if self.shift {
            parts.push("Shift");
        }
        if self.function {
            parts.push("Fn");
        }
        parts
    }

    fn carbon_modifiers(&self) -> u32 {
        let mut mask = 0;
        if self.command {
            mask |= CMD_KEY;
        }
        if self.control {
            mask |= CONTROL_KEY;
        }
        if self.option {
            mask |= OPTION_KEY;
        }
        if self.shift {
            mask |= SHIFT_KEY;
        }
        mask
    }

    /// The physical keys whose flagsChanged events can legitimately create a
    /// press/release edge for this modifier set. Left/right variants both count.
    fn key_codes(&self) -> Vec<u16> {
        let mut codes = Vec::new();
        if self.command {
            codes.extend_from_slice(&[0x36, 0x37]);
        }
        if self.shift {
            codes.extend_from_slice(&[0x38, 0x3C]);
        }
        if self.option {
            codes.extend_from_slice(&[0x3A, 0x3D]);
        }
        if self.control {
            codes.extend_from_slice(&[0x3B, 0x3E]);
        }
        if self.function {
            codes.push(0x3F);
        }
        codes
    }

    fn contains(&self, subset: &ShortcutModifiers) -> bool {
        (!subset.command || self.command)
            && (!subset.control || self.control)
            && (!subset.option || self.option)
            && (!subset.shift || self.shift)
            && (!subset.function || self.function)
    }

    /// Which modifier bit a flagsChanged key code belongs to, and whether it is
    /// set after the event. `None` for non-modifier key codes.
    fn bit_is_down(&self, key_code: u16) -> Option<bool> {
        match key_code {
            0x36 | 0x37 => Some(self.command),
            0x38 | 0x3C => Some(self.shift),
            0x3A | 0x3D => Some(self.option),
            0x3B | 0x3E => Some(self.control),
            0x3F => Some(self.function),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ShortcutKind {
    PushToTalk,
    Toggle,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MonitoredShortcut {
    pub key_code: u16,
    pub code: String,
    pub label: String,
    pub modifiers: ShortcutModifiers,
    /// 1 for a single press, 2 for a double-press (only meaningful for toggles).
    pub press_count: u8,
}

impl MonitoredShortcut {
    fn is_bare_fn(&self) -> bool {
        self.code.eq_ignore_ascii_case("Fn")
            && self.modifiers.function
            && !self.modifiers.command
            && !self.modifiers.control
            && !self.modifiers.option
            && !self.modifiers.shift
    }

    /// A modifier-only chord is watched by the flagsChanged path, not Carbon.
    fn is_modifier_only(&self) -> bool {
        self.is_bare_fn() || (self.key_code == 0 && self.code.eq_ignore_ascii_case("Modifiers"))
    }

    fn identity(&self) -> ShortcutIdentity {
        ShortcutIdentity {
            key_code: self.key_code,
            code: self.code.clone(),
            modifiers: self.modifiers,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct ShortcutIdentity {
    pub key_code: u16,
    pub code: String,
    pub modifiers: ShortcutModifiers,
}

/// A Carbon hot key for the driver to register. Carbon delivers pressed/released
/// edges for key chords with no permission prompt (unlike keyDown taps).
#[derive(Clone, Debug, PartialEq)]
pub struct HotKeyChord {
    pub identity: ShortcutIdentity,
    pub key_code: u16,
    pub carbon_modifiers: u32,
}

/// Edges and timer firings fed in by the platform driver.
#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    /// A registered Carbon hot key fired (`pressed` = down vs up).
    CarbonHotKey {
        identity: ShortcutIdentity,
        pressed: bool,
        now_ms: u64,
    },
    /// The global monitor saw a modifier-flags change.
    FlagsChanged {
        modifiers: ShortcutModifiers,
        changed_key_code: u16,
        now_ms: u64,
    },
    /// The hold-threshold timer elapsed.
    HoldTimerFired,
    /// The capture-debounce timer elapsed for these modifiers.
    CaptureTimerFired { modifiers: ShortcutModifiers },
}

/// What the driver should do in response to an [`Input`].
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    ShortcutDown { kind: ShortcutKind, label: String },
    ShortcutUp { kind: ShortcutKind, label: String },
    ScheduleHoldTimer { delay_ms: u64 },
    CancelHoldTimer,
    ScheduleCaptureTimer { modifiers: ShortcutModifiers, delay_ms: u64 },
    CancelCaptureTimer,
    /// Replace the registered Carbon hot keys with exactly these.
    RegisterHotKeys { chords: Vec<HotKeyChord> },
    /// Suspend all Carbon hot keys (during capture).
    UnregisterHotKeys,
    CaptureStarted,
    CaptureCancelled,
    Captured { shortcut: MonitoredShortcut },
    /// A configured shortcut can't be supported (Fn + key chords).
    FnUnavailable { message: String },
}

pub struct ShortcutMonitor {
    shortcuts: HashMap<ShortcutKind, MonitoredShortcut>,
    active_identity: Option<ShortcutIdentity>,
    active_push_identity: Option<ShortcutIdentity>,
    pending_push: Option<(ShortcutIdentity, MonitoredShortcut)>,
    last_tap_identity: Option<ShortcutIdentity>,
    last_tap_at_ms: Option<u64>,
    pending_overlap_identity: Option<ShortcutIdentity>,
    is_capturing: bool,
    capture_press_count: u8,
    pending_capture_modifiers: Option<ShortcutModifiers>,
}

impl Default for ShortcutMonitor {
    fn default() -> Self {
        let mut shortcuts = HashMap::new();
        shortcuts.insert(
            ShortcutKind::PushToTalk,
            MonitoredShortcut {
                key_code: 0x02,
                code: "KeyD".to_string(),
                label: "Ctrl+Opt+D".to_string(),
                modifiers: ShortcutModifiers {
                    control: true,
                    option: true,
                    ..Default::default()
                },
                press_count: 1,
            },
        );
        shortcuts.insert(
            ShortcutKind::Toggle,
            MonitoredShortcut {
                key_code: 0x11,
                code: "KeyT".to_string(),
                label: "Ctrl+Opt+T".to_string(),
                modifiers: ShortcutModifiers {
                    control: true,
                    option: true,
                    ..Default::default()
                },
                press_count: 1,
            },
        );
        Self {
            shortcuts,
            active_identity: None,
            active_push_identity: None,
            pending_push: None,
            last_tap_identity: None,
            last_tap_at_ms: None,
            pending_overlap_identity: None,
            is_capturing: false,
            capture_press_count: 1,
            pending_capture_modifiers: None,
        }
    }
}

impl ShortcutMonitor {
    pub fn new() -> Self {
        Self::default()
    }

    /// The Carbon hot keys to register for the current config (called once at
    /// startup by the driver).
    pub fn initial_hotkeys(&mut self) -> Vec<Action> {
        self.register_carbon_hotkeys()
    }

    pub fn handle(&mut self, input: Input) -> Vec<Action> {
        match input {
            Input::CarbonHotKey {
                identity,
                pressed,
                now_ms,
            } => {
                if self.is_capturing {
                    return Vec::new();
                }
                if pressed {
                    self.handle_physical_down(identity, now_ms)
                } else {
                    self.handle_physical_up(identity, true, now_ms)
                }
            }
            Input::FlagsChanged {
                modifiers,
                changed_key_code,
                now_ms,
            } => {
                if self.is_capturing {
                    self.handle_capture(modifiers)
                } else {
                    self.handle_flags_changed(modifiers, changed_key_code, now_ms)
                }
            }
            Input::HoldTimerFired => self.handle_hold_timer(),
            Input::CaptureTimerFired { modifiers } => self.handle_capture_timer(modifiers),
        }
    }

    pub fn set_shortcut(&mut self, shortcut: MonitoredShortcut, kind: ShortcutKind) -> Vec<Action> {
        self.shortcuts.insert(kind, shortcut);
        let mut actions = self.register_carbon_hotkeys();
        actions.extend(self.cancel_pending_push());
        self.active_identity = None;
        self.active_push_identity = None;
        self.last_tap_identity = None;
        self.last_tap_at_ms = None;
        self.pending_overlap_identity = None;
        actions
    }

    pub fn start_capture(&mut self, _press_count: u8) -> Vec<Action> {
        self.is_capturing = true;
        // Parity with the helper: modifier-only capture always yields a single
        // press; a double-press toggle is configured by the UI re-submitting the
        // captured chord with press_count = 2.
        self.capture_press_count = 1;
        let mut actions = self.cancel_pending_push();
        self.active_identity = None;
        self.pending_overlap_identity = None;
        actions.extend(self.cancel_pending_capture());
        actions.push(Action::UnregisterHotKeys);
        actions.push(Action::CaptureStarted);
        actions
    }

    pub fn cancel_capture(&mut self) -> Vec<Action> {
        self.is_capturing = false;
        let mut actions = self.cancel_pending_capture();
        actions.extend(self.register_carbon_hotkeys());
        actions.push(Action::CaptureCancelled);
        actions
    }

    // --- runtime edge detection ------------------------------------------

    fn handle_flags_changed(
        &mut self,
        current: ShortcutModifiers,
        changed_key_code: u16,
        now_ms: u64,
    ) -> Vec<Action> {
        let mut actions = Vec::new();
        if let Some(identity) = self.active_identity.clone() {
            if identity.modifiers != current {
                let is_release = identity.modifiers.key_codes().contains(&changed_key_code);
                actions.extend(self.handle_physical_up(identity, is_release, now_ms));
            }
        }

        self.update_pending_overlap(current, changed_key_code);

        let Some(identity) = self.matching_modifier_only_identity(current) else {
            return actions;
        };
        let edge_ok = identity.modifiers.key_codes().contains(&changed_key_code)
            || self.pending_overlap_identity.as_ref() == Some(&identity);
        if !edge_ok {
            return actions;
        }
        self.pending_overlap_identity = None;
        actions.extend(self.handle_physical_down(identity, now_ms));
        actions
    }

    /// Arms overlap recovery when a modifier-only chord's own key goes down
    /// while a foreign modifier is still held, and disarms it when that key
    /// comes back up before the chord ever held.
    fn update_pending_overlap(&mut self, current: ShortcutModifiers, changed_key_code: u16) {
        let Some(key_is_down) = current.bit_is_down(changed_key_code) else {
            return;
        };
        if key_is_down {
            for shortcut in self.shortcuts.values() {
                if !shortcut.is_modifier_only() {
                    continue;
                }
                if shortcut.modifiers.key_codes().contains(&changed_key_code)
                    && shortcut.modifiers != current
                    && current.contains(&shortcut.modifiers)
                {
                    self.pending_overlap_identity = Some(shortcut.identity());
                    return;
                }
            }
        } else if let Some(pending) = self.pending_overlap_identity.clone() {
            if pending.modifiers.key_codes().contains(&changed_key_code)
                && !current.contains(&pending.modifiers)
            {
                self.pending_overlap_identity = None;
            }
        }
    }

    fn handle_physical_down(&mut self, identity: ShortcutIdentity, now_ms: u64) -> Vec<Action> {
        let mut actions = Vec::new();
        if self.active_identity.as_ref() == Some(&identity) {
            return actions;
        }
        self.active_identity = Some(identity.clone());

        let matches = self.shortcuts_matching(&identity);

        if let Some(toggle) = matches
            .iter()
            .find(|(kind, shortcut)| *kind == ShortcutKind::Toggle && shortcut.press_count == 2)
        {
            if self.last_tap_identity.as_ref() == Some(&identity) {
                if let Some(last) = self.last_tap_at_ms {
                    if now_ms.saturating_sub(last) <= DOUBLE_PRESS_WINDOW_MS {
                        self.last_tap_identity = None;
                        self.last_tap_at_ms = None;
                        actions.extend(self.cancel_pending_push());
                        actions.push(down(ShortcutKind::Toggle, &toggle.1.label));
                        return actions;
                    }
                }
            }
        }

        if let Some(toggle) = matches
            .iter()
            .find(|(kind, shortcut)| *kind == ShortcutKind::Toggle && shortcut.press_count == 1)
        {
            actions.push(down(ShortcutKind::Toggle, &toggle.1.label));
        }

        if let Some(push) = matches
            .iter()
            .find(|(kind, shortcut)| *kind == ShortcutKind::PushToTalk && shortcut.press_count == 1)
        {
            if matches.iter().any(|(kind, _)| *kind == ShortcutKind::Toggle) {
                // A toggle shares this trigger, so a fresh press is ambiguous: a
                // tap is (or arms) the toggle, only a hold is the push. The hold
                // threshold tells them apart.
                actions.extend(self.schedule_push_start(identity, push.1.clone()));
            } else {
                actions.extend(self.cancel_pending_push());
                self.active_push_identity = Some(identity);
                actions.push(down(ShortcutKind::PushToTalk, &push.1.label));
            }
        }
        actions
    }

    fn handle_physical_up(
        &mut self,
        identity: ShortcutIdentity,
        is_physical_release: bool,
        now_ms: u64,
    ) -> Vec<Action> {
        let mut actions = Vec::new();
        if self.active_identity.as_ref() != Some(&identity) {
            return actions;
        }
        self.active_identity = None;

        if self.active_push_identity.as_ref() == Some(&identity) {
            if let Some(push) = self
                .shortcuts_matching(&identity)
                .into_iter()
                .find(|(kind, _)| *kind == ShortcutKind::PushToTalk)
            {
                self.active_push_identity = None;
                actions.push(up(ShortcutKind::PushToTalk, &push.1.label));
                return actions;
            }
        }

        actions.extend(self.cancel_pending_push());

        if is_physical_release
            && self
                .shortcuts_matching(&identity)
                .iter()
                .any(|(kind, shortcut)| *kind == ShortcutKind::Toggle && shortcut.press_count == 2)
        {
            self.last_tap_identity = Some(identity);
            self.last_tap_at_ms = Some(now_ms);
        }
        actions
    }

    fn schedule_push_start(
        &mut self,
        identity: ShortcutIdentity,
        shortcut: MonitoredShortcut,
    ) -> Vec<Action> {
        let mut actions = self.cancel_pending_push();
        self.pending_push = Some((identity, shortcut));
        actions.push(Action::ScheduleHoldTimer {
            delay_ms: HOLD_THRESHOLD_MS,
        });
        actions
    }

    fn handle_hold_timer(&mut self) -> Vec<Action> {
        let Some((identity, shortcut)) = self.pending_push.clone() else {
            return Vec::new();
        };
        if self.active_identity.as_ref() != Some(&identity) {
            return Vec::new();
        }
        self.active_push_identity = Some(identity);
        self.pending_push = None;
        vec![down(ShortcutKind::PushToTalk, &shortcut.label)]
    }

    fn cancel_pending_push(&mut self) -> Vec<Action> {
        if self.pending_push.take().is_some() {
            vec![Action::CancelHoldTimer]
        } else {
            Vec::new()
        }
    }

    // --- capture ----------------------------------------------------------

    fn handle_capture(&mut self, modifiers: ShortcutModifiers) -> Vec<Action> {
        if modifiers.is_supported_modifier_only_shortcut() {
            self.schedule_modifier_only_capture(modifiers)
        } else {
            self.cancel_pending_capture()
        }
    }

    fn schedule_modifier_only_capture(&mut self, modifiers: ShortcutModifiers) -> Vec<Action> {
        if self.pending_capture_modifiers == Some(modifiers) {
            return Vec::new();
        }
        let mut actions = self.cancel_pending_capture();
        self.pending_capture_modifiers = Some(modifiers);
        actions.push(Action::ScheduleCaptureTimer {
            modifiers,
            delay_ms: CAPTURE_DEBOUNCE_MS,
        });
        actions
    }

    fn handle_capture_timer(&mut self, modifiers: ShortcutModifiers) -> Vec<Action> {
        if !self.is_capturing || self.pending_capture_modifiers != Some(modifiers) {
            return Vec::new();
        }
        self.pending_capture_modifiers = None;
        let code = if modifiers.is_bare_function() {
            "Fn"
        } else {
            "Modifiers"
        };
        let label = modifiers.label_parts().join("+");
        let shortcut = MonitoredShortcut {
            key_code: 0,
            code: code.to_string(),
            label,
            modifiers,
            press_count: self.capture_press_count,
        };
        self.finish_capture(shortcut)
    }

    fn finish_capture(&mut self, shortcut: MonitoredShortcut) -> Vec<Action> {
        if !self.is_capturing {
            return Vec::new();
        }
        self.is_capturing = false;
        let mut actions = self.cancel_pending_capture();
        actions.extend(self.register_carbon_hotkeys());
        actions.push(Action::Captured { shortcut });
        actions
    }

    fn cancel_pending_capture(&mut self) -> Vec<Action> {
        if self.pending_capture_modifiers.take().is_some() {
            vec![Action::CancelCaptureTimer]
        } else {
            Vec::new()
        }
    }

    // --- helpers ----------------------------------------------------------

    fn register_carbon_hotkeys(&self) -> Vec<Action> {
        let mut chords = Vec::new();
        let mut actions = Vec::new();
        for shortcut in self.shortcuts.values() {
            if shortcut.is_modifier_only() {
                continue; // flagsChanged path handles modifier-only chords.
            }
            if shortcut.modifiers.function {
                // Carbon has no fn modifier bit and nothing permission-free can
                // watch fn+key chords. Say so instead of silently dying.
                actions.push(Action::FnUnavailable {
                    message: format!(
                        "The shortcut {} combines Fn with another key, which is no longer supported. Pick a different shortcut in Settings.",
                        shortcut.label
                    ),
                });
                continue;
            }
            chords.push(HotKeyChord {
                identity: shortcut.identity(),
                key_code: shortcut.key_code,
                carbon_modifiers: shortcut.modifiers.carbon_modifiers(),
            });
        }
        actions.insert(0, Action::RegisterHotKeys { chords });
        actions
    }

    fn matching_modifier_only_identity(
        &self,
        current: ShortcutModifiers,
    ) -> Option<ShortcutIdentity> {
        self.shortcuts
            .values()
            .find(|shortcut| shortcut.is_modifier_only() && shortcut.modifiers == current)
            .map(MonitoredShortcut::identity)
    }

    fn shortcuts_matching(
        &self,
        identity: &ShortcutIdentity,
    ) -> Vec<(ShortcutKind, MonitoredShortcut)> {
        self.shortcuts
            .iter()
            .filter(|(_, shortcut)| shortcut.identity() == *identity)
            .map(|(kind, shortcut)| (*kind, shortcut.clone()))
            .collect()
    }
}

fn down(kind: ShortcutKind, label: &str) -> Action {
    Action::ShortcutDown {
        kind,
        label: label.to_string(),
    }
}

fn up(kind: ShortcutKind, label: &str) -> Action {
    Action::ShortcutUp {
        kind,
        label: label.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctrl_opt() -> ShortcutModifiers {
        ShortcutModifiers {
            control: true,
            option: true,
            ..Default::default()
        }
    }

    fn ptt_identity() -> ShortcutIdentity {
        ShortcutIdentity {
            key_code: 0x02,
            code: "KeyD".to_string(),
            modifiers: ctrl_opt(),
        }
    }

    #[test]
    fn default_push_to_talk_emits_down_then_up() {
        let mut monitor = ShortcutMonitor::new();
        let down = monitor.handle(Input::CarbonHotKey {
            identity: ptt_identity(),
            pressed: true,
            now_ms: 0,
        });
        assert_eq!(
            down,
            vec![Action::ShortcutDown {
                kind: ShortcutKind::PushToTalk,
                label: "Ctrl+Opt+D".to_string(),
            }]
        );
        let up = monitor.handle(Input::CarbonHotKey {
            identity: ptt_identity(),
            pressed: false,
            now_ms: 50,
        });
        assert_eq!(
            up,
            vec![Action::ShortcutUp {
                kind: ShortcutKind::PushToTalk,
                label: "Ctrl+Opt+D".to_string(),
            }]
        );
    }

    #[test]
    fn repeated_down_without_up_is_deduped() {
        let mut monitor = ShortcutMonitor::new();
        let _ = monitor.handle(Input::CarbonHotKey {
            identity: ptt_identity(),
            pressed: true,
            now_ms: 0,
        });
        let again = monitor.handle(Input::CarbonHotKey {
            identity: ptt_identity(),
            pressed: true,
            now_ms: 5,
        });
        assert!(again.is_empty());
    }

    #[test]
    fn ambiguous_trigger_holds_then_commits_to_push() {
        let mut monitor = ShortcutMonitor::new();
        // Put both push and toggle on the same Ctrl+Opt+D trigger.
        let shortcut = MonitoredShortcut {
            key_code: 0x02,
            code: "KeyD".to_string(),
            label: "Ctrl+Opt+D".to_string(),
            modifiers: ctrl_opt(),
            press_count: 1,
        };
        let _ = monitor.set_shortcut(shortcut.clone(), ShortcutKind::Toggle);

        let down = monitor.handle(Input::CarbonHotKey {
            identity: ptt_identity(),
            pressed: true,
            now_ms: 0,
        });
        // The toggle fires immediately; the push is deferred behind the hold.
        assert!(down.contains(&Action::ShortcutDown {
            kind: ShortcutKind::Toggle,
            label: "Ctrl+Opt+D".to_string(),
        }));
        assert!(down.contains(&Action::ScheduleHoldTimer {
            delay_ms: HOLD_THRESHOLD_MS
        }));

        let fired = monitor.handle(Input::HoldTimerFired);
        assert_eq!(
            fired,
            vec![Action::ShortcutDown {
                kind: ShortcutKind::PushToTalk,
                label: "Ctrl+Opt+D".to_string(),
            }]
        );
    }

    #[test]
    fn double_press_toggle_fires_only_on_second_tap_in_window() {
        let mut monitor = ShortcutMonitor::new();
        let double = MonitoredShortcut {
            key_code: 0x11,
            code: "KeyT".to_string(),
            label: "Ctrl+Opt+T".to_string(),
            modifiers: ctrl_opt(),
            press_count: 2,
        };
        let _ = monitor.set_shortcut(double, ShortcutKind::Toggle);
        // Remove push so the trigger is unambiguous for this test.
        let identity = ShortcutIdentity {
            key_code: 0x11,
            code: "KeyT".to_string(),
            modifiers: ctrl_opt(),
        };

        // First tap: down + up, no toggle yet.
        let d1 = monitor.handle(Input::CarbonHotKey {
            identity: identity.clone(),
            pressed: true,
            now_ms: 0,
        });
        assert!(d1.is_empty());
        let u1 = monitor.handle(Input::CarbonHotKey {
            identity: identity.clone(),
            pressed: false,
            now_ms: 20,
        });
        assert!(u1.is_empty());

        // Second tap within the window: toggle fires.
        let d2 = monitor.handle(Input::CarbonHotKey {
            identity: identity.clone(),
            pressed: true,
            now_ms: 200,
        });
        assert_eq!(
            d2,
            vec![Action::ShortcutDown {
                kind: ShortcutKind::Toggle,
                label: "Ctrl+Opt+T".to_string(),
            }]
        );
    }

    #[test]
    fn double_press_toggle_ignores_second_tap_past_window() {
        let mut monitor = ShortcutMonitor::new();
        let double = MonitoredShortcut {
            key_code: 0x11,
            code: "KeyT".to_string(),
            label: "Ctrl+Opt+T".to_string(),
            modifiers: ctrl_opt(),
            press_count: 2,
        };
        let _ = monitor.set_shortcut(double, ShortcutKind::Toggle);
        let identity = ShortcutIdentity {
            key_code: 0x11,
            code: "KeyT".to_string(),
            modifiers: ctrl_opt(),
        };
        let _ = monitor.handle(Input::CarbonHotKey {
            identity: identity.clone(),
            pressed: true,
            now_ms: 0,
        });
        let _ = monitor.handle(Input::CarbonHotKey {
            identity: identity.clone(),
            pressed: false,
            now_ms: 20,
        });
        let d2 = monitor.handle(Input::CarbonHotKey {
            identity,
            pressed: true,
            now_ms: 1_000,
        });
        assert!(d2.is_empty());
    }

    #[test]
    fn bare_fn_push_to_talk_fires_on_flags_changed() {
        let mut monitor = ShortcutMonitor::new();
        let fn_shortcut = MonitoredShortcut {
            key_code: 0,
            code: "Fn".to_string(),
            label: "Fn".to_string(),
            modifiers: ShortcutModifiers {
                function: true,
                ..Default::default()
            },
            press_count: 1,
        };
        let _ = monitor.set_shortcut(fn_shortcut, ShortcutKind::PushToTalk);

        // Fn down (0x3F) with the fn flag set.
        let down = monitor.handle(Input::FlagsChanged {
            modifiers: ShortcutModifiers {
                function: true,
                ..Default::default()
            },
            changed_key_code: 0x3F,
            now_ms: 0,
        });
        assert_eq!(
            down,
            vec![Action::ShortcutDown {
                kind: ShortcutKind::PushToTalk,
                label: "Fn".to_string(),
            }]
        );

        // Fn up: flags clear.
        let up = monitor.handle(Input::FlagsChanged {
            modifiers: ShortcutModifiers::default(),
            changed_key_code: 0x3F,
            now_ms: 10,
        });
        assert_eq!(
            up,
            vec![Action::ShortcutUp {
                kind: ShortcutKind::PushToTalk,
                label: "Fn".to_string(),
            }]
        );
    }

    #[test]
    fn cmd_tab_phantom_does_not_arm_double_press() {
        // A foreign modifier (Cmd) releasing while Fn is still held must not be
        // read as a physical release that arms the double-press detector.
        let mut monitor = ShortcutMonitor::new();
        let fn_double = MonitoredShortcut {
            key_code: 0,
            code: "Fn".to_string(),
            label: "Fn".to_string(),
            modifiers: ShortcutModifiers {
                function: true,
                ..Default::default()
            },
            press_count: 2,
        };
        let _ = monitor.set_shortcut(fn_double, ShortcutKind::Toggle);

        // Fn down.
        let _ = monitor.handle(Input::FlagsChanged {
            modifiers: ShortcutModifiers {
                function: true,
                ..Default::default()
            },
            changed_key_code: 0x3F,
            now_ms: 0,
        });
        // Cmd pressed on top (foreign): chord becomes {fn, cmd}, active up fires
        // but it is NOT a physical release of fn.
        let _ = monitor.handle(Input::FlagsChanged {
            modifiers: ShortcutModifiers {
                function: true,
                command: true,
                ..Default::default()
            },
            changed_key_code: 0x37,
            now_ms: 10,
        });
        // Cmd released while fn still held: flags read {fn} again. This must not
        // count as a fresh fn press (no toggle), because the prior "up" was a
        // foreign interruption, not a release.
        let cmd_up = monitor.handle(Input::FlagsChanged {
            modifiers: ShortcutModifiers {
                function: true,
                ..Default::default()
            },
            changed_key_code: 0x37,
            now_ms: 20,
        });
        assert!(
            !cmd_up.iter().any(|action| matches!(
                action,
                Action::ShortcutDown {
                    kind: ShortcutKind::Toggle,
                    ..
                }
            )),
            "cmd release must not trigger the fn+fn toggle: {cmd_up:?}"
        );
    }
}
