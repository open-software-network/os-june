#[cfg(target_os = "windows")]
use crate::audio::turns::normalize_wav_for_transcription;
use crate::domain::{
    processing::{build_dictionary_context, merge_transcription_context},
    types::{AppError, ListDictationHistoryResponse},
};
use crate::june_api::{
    cleanup_text, dictate_transcribe, DictateCleanupRequestParams, DictateTranscribeRequest,
    TranscriptionProviderResult,
};
use crate::providers::{configured_transcription_provider, OPENAI_PROVIDER, VENICE_PROVIDER};
use chrono::Utc;
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow, WindowEvent,
};

const DICTATION_TRANSCRIPTION_CONTEXT: &str = "Transcribe this as clean hands-free dictation for direct insertion into the active app. Preserve the speaker's intended words, language, and meaning. Remove filler sounds and accidental false starts when they are not meaningful, especially um, uh, ah, er, and a... stutters. Do not remove intentional articles such as a or an when they are grammatically needed. Convert spoken punctuation and formatting into text punctuation, including comma, period, question mark, exclamation point, colon, semicolon, dash, newline, and new paragraph. Convert quote/unquote, open quote/close quote, and start quote/end quote into actual quotation marks around the quoted words. Output only the dictated text.";
/// Cleanup regenerates the whole transcript through the LLM, so its latency
/// grows with dictation length. A flat budget silently degraded long
/// dictations: the call timed out, cleanup was skipped, and the raw ASR text
/// (capitalized but unpunctuated) was pasted (JUN-212). Scale the budget with
/// the transcript instead: the base covers short dictations plus network
/// overhead, each byte of transcript buys generation time, and the cap keeps
/// a hung request from wedging finalization for minutes.
const DICTATION_CLEANUP_BASE_TIMEOUT_MS: u64 = 15_000;
/// ~5 ms per input byte ≈ 20 ms per regenerated token (≈4 bytes/token), a
/// conservative floor of ~50 tokens/s for the cleanup model.
const DICTATION_CLEANUP_TIMEOUT_MS_PER_BYTE: u64 = 5;
const DICTATION_CLEANUP_MAX_TIMEOUT_MS: u64 = 60_000;
/// No single cleanup request may wait longer than June API's cleanup billing
/// hold (`cleanup_hold_ttl_seconds`, 30s): a response that arrives after its
/// hold expired could paste text whose charge no longer settles. The overall
/// budget above spans multiple sequential chunk requests; this cap bounds
/// each one. Keep in sync with the june-api config default.
const DICTATION_CLEANUP_REQUEST_MAX_TIMEOUT_MS: u64 = 30_000;
/// Above this size, cleanup runs chunked. Measured against the production
/// prompt (JUN-212): the cleanup model punctuates ~800-byte passages of
/// filler-heavy run-on speech reliably, while at 2 KB and beyond it degrades
/// into echoing the transcript back with no punctuation at all.
const DICTATION_CLEANUP_CHUNK_TARGET_BYTES: usize = 800;
/// Below this input size a chunk plausibly is a single sentence, so a cleaned
/// result without sentence punctuation is not evidence of the echo failure.
const DICTATION_CLEANUP_RETRY_MIN_CHUNK_BYTES: usize = 300;
/// App-context slug sent with dictation cleanup when the paste target is a
/// known kind of app, so the cleaned text is laid out for that surface.
/// Email is the only recognized context today.
const APP_CONTEXT_EMAIL: &str = "email";
/// Native email clients by bundle id. Browser webmail (Gmail, Outlook web)
/// needs focused-tab detection and is a deliberate follow-up.
const EMAIL_APP_BUNDLE_IDS: &[&str] = &[
    "com.apple.mail",
    "com.microsoft.Outlook",
    "com.readdle.SparkDesktop",
    "com.readdle.smartemail-Mac",
    "it.bloop.airmail2",
    "com.mimestream.Mimestream",
    "com.superhuman.electron",
];
const DICTATION_AUDIO_ACTIVITY_THRESHOLD: f32 = 0.04;
const DICTATION_EVENT_LOG: &str = "dictation-events.log";

static SETTINGS_CACHE: OnceLock<Mutex<DictationSettings>> = OnceLock::new();

pub struct HelperProcess {
    child: Child,
    stdin: ChildStdin,
}

pub struct HelperState {
    process: Mutex<Option<HelperProcess>>,
    /// Set only on intentional teardown (app quit / [`stop_helper`]) so the
    /// supervisor can tell a deliberate stop from a crash and skip respawning.
    shutting_down: AtomicBool,
    /// Consecutive rapid respawn attempts, used to cap a crash loop. Reset once
    /// a respawned helper survives long enough to be considered healthy.
    respawn_failures: AtomicU32,
}

impl Default for HelperState {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
            respawn_failures: AtomicU32::new(0),
        }
    }
}

pub struct LastDictationEvent {
    event: Mutex<Option<String>>,
}

pub struct DictationSettingsState {
    path: PathBuf,
    settings: Mutex<DictationSettings>,
}

pub struct HotkeyStatus {
    event: Mutex<serde_json::Value>,
}

/// Position the HUD remembers between dictation sessions in the same process.
/// Intentionally process-scoped, not disk-persisted: every fresh launch of
/// June should put the pill back at top-center, but within a single run
/// the user's drag-to-corner choice should stick.
pub struct HudPosition {
    inner: Mutex<Option<(i32, i32)>>,
}

pub struct ShortcutActivationState {
    controller: Mutex<ShortcutActivationController>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct HudClientRect {
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
}

/// Hover state for HUD controls. Polled by [`spawn_hud_hover_thread`]; we
/// don't poll from JS because WebKit throttles timers on the non-key HUD
/// panel (and CSS :hover is unreliable there for the same reason). The
/// stop button and the meeting prompt's corner dismiss each get a rect.
/// The window includes a small transparent gutter for the CSS shadow, but
/// hover still keys off the controls themselves rather than the full frame.
pub struct HudHoverState {
    stop_bounds: Mutex<Option<HudClientRect>>,
    last_hover: std::sync::atomic::AtomicBool,
    dismiss_bounds: Mutex<Option<HudClientRect>>,
    last_dismiss_hover: std::sync::atomic::AtomicBool,
    record_bounds: Mutex<Option<HudClientRect>>,
    last_record_hover: std::sync::atomic::AtomicBool,
}

pub fn configured_transcription_language() -> Option<String> {
    settings_store()
        .lock()
        .ok()
        .and_then(|settings| settings.language.clone())
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DictationSettings {
    pub push_to_talk_shortcut: DictationShortcutSetting,
    pub toggle_shortcut: DictationShortcutSetting,
    pub microphone: DictationMicrophoneSetting,
    pub style: DictationStyle,
    pub language: Option<String>,
}

impl Default for DictationSettings {
    fn default() -> Self {
        Self {
            push_to_talk_shortcut: DictationShortcutSetting::control_option_d(),
            toggle_shortcut: DictationShortcutSetting::control_option_t(),
            microphone: DictationMicrophoneSetting::default(),
            style: DictationStyle::Standard,
            language: None,
        }
    }
}

impl<'de> Deserialize<'de> for DictationSettings {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct SettingsValue {
            push_to_talk_shortcut: Option<DictationShortcutSetting>,
            toggle_shortcut: Option<DictationShortcutSetting>,
            microphone: Option<DictationMicrophoneSetting>,
            style: Option<DictationStyle>,
            language: Option<String>,
        }

        let value = serde_json::Value::deserialize(deserializer)?;
        let microphone = value
            .get("microphone")
            .cloned()
            .and_then(|microphone| serde_json::from_value(microphone).ok())
            .unwrap_or_default();

        if value.get("shortcut").is_some() || value.get("activationMode").is_some() {
            return Ok(Self {
                microphone,
                ..Self::default()
            });
        }

        let settings: SettingsValue =
            serde_json::from_value(value).map_err(serde::de::Error::custom)?;

        Ok(Self {
            push_to_talk_shortcut: settings
                .push_to_talk_shortcut
                .map(|shortcut| shortcut.normalized_or_default(DictationShortcutKind::PushToTalk))
                .unwrap_or_else(DictationShortcutSetting::control_option_d),
            toggle_shortcut: settings
                .toggle_shortcut
                .map(|shortcut| shortcut.normalized_or_default(DictationShortcutKind::Toggle))
                .unwrap_or_else(DictationShortcutSetting::control_option_t),
            microphone: settings.microphone.unwrap_or(microphone),
            style: settings.style.unwrap_or_default(),
            language: normalize_language(settings.language),
        })
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DictationStyle {
    #[default]
    Standard,
    CasualLowercase,
    Formal,
}

impl DictationStyle {
    fn instruction(self) -> &'static str {
        match self {
            Self::Standard => {
                "Writing style: standard. Standard sentence capitalization and punctuation. Keep the speaker's wording and tone exactly as dictated."
            }
            Self::CasualLowercase => {
                "Writing style: casual lowercase. Use lowercase wherever grammatically possible, including the beginning of sentences, while preserving proper nouns, acronyms, brand names, and code exactly when capitalization matters. Keep the speaker's wording exactly as dictated."
            }
            Self::Formal => {
                "Writing style: formal. Conventional capitalization, complete punctuation, and full words: expand casual contractions, for example don't becomes do not. Beyond that, keep the speaker's own words and sentence structure; do not reword, shorten, or polish their phrasing."
            }
        }
    }

    /// Whether this style capitalizes the start of a sentence. CasualLowercase
    /// keeps sentence starts lowercase, so the deterministic filler backstop
    /// must not re-capitalize a surviving first word under it.
    fn capitalizes_sentence_starts(self) -> bool {
        !matches!(self, Self::CasualLowercase)
    }
}

fn control_option_label(key: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("Ctrl+Alt+{key}")
    } else {
        format!("Ctrl+Opt+{key}")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationShortcutSetting {
    pub key_code: u32,
    pub code: String,
    pub modifiers: DictationShortcutModifiers,
    pub label: String,
    pub press_count: u8,
}

impl<'de> Deserialize<'de> for DictationShortcutSetting {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ShortcutSettingValue {
            key_code: u32,
            code: String,
            modifiers: DictationShortcutModifiers,
            label: String,
            press_count: Option<u8>,
        }

        let value = serde_json::Value::deserialize(deserializer)?;
        if let Some(shortcut) = value.as_str() {
            return legacy_shortcut_setting(shortcut)
                .ok_or_else(|| serde::de::Error::custom("unknown legacy shortcut"));
        }

        let shortcut: ShortcutSettingValue =
            serde_json::from_value(value).map_err(serde::de::Error::custom)?;
        let press_count = shortcut.press_count.unwrap_or(1);
        Ok(Self {
            key_code: shortcut.key_code,
            code: shortcut.code,
            modifiers: shortcut.modifiers,
            label: shortcut.label,
            press_count: if press_count == 2 { 2 } else { 1 },
        })
    }
}

impl DictationShortcutSetting {
    fn bare_fn() -> Self {
        Self {
            key_code: 0,
            code: "Fn".to_string(),
            modifiers: DictationShortcutModifiers {
                function: true,
                ..DictationShortcutModifiers::default()
            },
            label: "Fn".to_string(),
            press_count: 1,
        }
    }

    fn modifier_only(modifiers: DictationShortcutModifiers) -> Self {
        Self {
            key_code: 0,
            code: "Modifiers".to_string(),
            label: modifier_only_label(&modifiers),
            modifiers,
            press_count: 1,
        }
    }

    fn control_option_d() -> Self {
        Self {
            key_code: 0x02,
            code: "KeyD".to_string(),
            modifiers: DictationShortcutModifiers {
                control: true,
                option: true,
                ..DictationShortcutModifiers::default()
            },
            label: control_option_label("D"),
            press_count: 1,
        }
    }

    fn control_option_t() -> Self {
        Self {
            key_code: 0x11,
            code: "KeyT".to_string(),
            modifiers: DictationShortcutModifiers {
                control: true,
                option: true,
                ..DictationShortcutModifiers::default()
            },
            label: control_option_label("T"),
            press_count: 1,
        }
    }

    fn same_trigger_as(&self, other: &Self) -> bool {
        self.key_code == other.key_code
            && self.code == other.code
            && self.modifiers == other.modifiers
            && self.press_count == other.press_count
    }

    fn normalized_or_default(mut self, kind: DictationShortcutKind) -> Self {
        if cfg!(target_os = "windows")
            && (self.press_count != 1
                || self.modifiers.function
                || is_modifier_only_input(&self.code, &self.modifiers))
        {
            return default_shortcut_for_kind(kind);
        }
        if self.is_bare_fn() {
            return DictationShortcutSetting::bare_fn();
        }
        if is_modifier_only_input(&self.code, &self.modifiers) {
            return DictationShortcutSetting::modifier_only(self.modifiers);
        }
        let Some(key_code) = key_code_for_code(&self.code) else {
            return default_shortcut_for_kind(kind);
        };
        if !self.modifiers.has_any() {
            return default_shortcut_for_kind(kind);
        }
        self.key_code = key_code;
        self.press_count = if self.press_count == 2 { 2 } else { 1 };
        self
    }

    fn is_bare_fn(&self) -> bool {
        is_bare_fn_input(&self.code, &self.modifiers)
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationShortcutModifiers {
    pub command: bool,
    pub control: bool,
    pub option: bool,
    pub shift: bool,
    pub function: bool,
}

impl DictationShortcutModifiers {
    fn has_any(&self) -> bool {
        self.command || self.control || self.option || self.shift || self.function
    }

    fn count(&self) -> usize {
        [
            self.command,
            self.control,
            self.option,
            self.shift,
            self.function,
        ]
        .into_iter()
        .filter(|enabled| *enabled)
        .count()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationShortcutInput {
    pub code: String,
    pub modifiers: DictationShortcutModifiers,
    pub label: String,
    pub press_count: Option<u8>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DictationShortcutKind {
    PushToTalk,
    Toggle,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DictationMicrophoneSetting {
    pub id: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationCapabilities {
    pub available: bool,
    pub platform: &'static str,
    pub shortcuts: bool,
    pub paste: bool,
    pub microphone_selection: bool,
    pub accessibility_permission: bool,
    pub system_audio: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationCapabilitiesResponse {
    pub capabilities: DictationCapabilities,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationSettingsResponse {
    pub settings: DictationSettings,
}

/// A push released faster than this is a graze or an aborted press, not a
/// dictation: recording starts on the down edge now (the helper no longer
/// holds unambiguous presses back), so quick releases must discard instead of
/// transcribing a fraction of a second of noise. Mirrors the helper's old
/// holdThreshold, which used to absorb these by delaying the start.
const PUSH_TO_TALK_MIN_HOLD: Duration = Duration::from_millis(160);
const TOGGLE_SHORTCUT_DEBOUNCE: Duration = Duration::from_millis(275);
/// A toggle ack normally arrives within milliseconds; if the helper dies (or
/// a permission prompt never calls back) no ack event ever comes, and an
/// unexpiring in-flight flag would wedge the shortcut until app restart.
const TOGGLE_ACK_EXPIRY: Duration = Duration::from_secs(8);
/// Finalizing normally resolves in a few seconds (one dictation round-trip);
/// a helper that dies mid-finalize emits no terminal event, so the
/// suppression must expire rather than wedge the shortcut.
const FINALIZING_SUPPRESSION_EXPIRY: Duration = Duration::from_secs(30);

#[derive(Debug, Default)]
struct ShortcutActivationController {
    active_mode: Option<DictationShortcutKind>,
    push_to_talk_is_down: bool,
    push_started_at: Option<Instant>,
    toggle_command_in_flight: bool,
    last_toggle_command_at: Option<Instant>,
    helper_finalizing_since: Option<Instant>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShortcutKeyEdge {
    Down,
    Up,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DictationCommand {
    StartListening,
    StopAndPaste,
    DiscardListening,
    ToggleListening,
}

impl ShortcutActivationController {
    fn handle_edge(
        &mut self,
        edge: ShortcutKeyEdge,
        kind: DictationShortcutKind,
        now: Instant,
    ) -> Option<DictationCommand> {
        match (kind, edge) {
            (DictationShortcutKind::PushToTalk, ShortcutKeyEdge::Down) => {
                if self.active_mode.is_some()
                    || self.push_to_talk_is_down
                    || self.helper_is_finalizing(now)
                {
                    return None;
                }
                self.active_mode = Some(DictationShortcutKind::PushToTalk);
                self.push_to_talk_is_down = true;
                self.push_started_at = Some(now);
                Some(DictationCommand::StartListening)
            }
            (DictationShortcutKind::PushToTalk, ShortcutKeyEdge::Up) => {
                let started_at = self.push_started_at.take();
                if self.active_mode == Some(DictationShortcutKind::PushToTalk)
                    && self.push_to_talk_is_down
                {
                    self.active_mode = None;
                    self.push_to_talk_is_down = false;
                    let grazed =
                        started_at.is_some_and(|at| now.duration_since(at) < PUSH_TO_TALK_MIN_HOLD);
                    Some(if grazed {
                        DictationCommand::DiscardListening
                    } else {
                        DictationCommand::StopAndPaste
                    })
                } else {
                    self.push_to_talk_is_down = false;
                    None
                }
            }
            (DictationShortcutKind::Toggle, ShortcutKeyEdge::Down) => match self.active_mode {
                Some(DictationShortcutKind::PushToTalk) => None,
                Some(DictationShortcutKind::Toggle) if self.can_send_toggle_command(now) => {
                    self.active_mode = None;
                    self.mark_toggle_command_sent(now);
                    Some(DictationCommand::ToggleListening)
                }
                Some(DictationShortcutKind::Toggle) => None,
                None if self.can_send_toggle_command(now) => {
                    self.active_mode = Some(DictationShortcutKind::Toggle);
                    self.mark_toggle_command_sent(now);
                    Some(DictationCommand::ToggleListening)
                }
                None => None,
            },
            (DictationShortcutKind::Toggle, ShortcutKeyEdge::Up) => None,
        }
    }

    fn can_send_toggle_command(&self, now: Instant) -> bool {
        let in_flight = self.toggle_command_in_flight
            && self
                .last_toggle_command_at
                .map_or(true, |last| now.duration_since(last) < TOGGLE_ACK_EXPIRY);
        !in_flight
            && !self.helper_is_finalizing(now)
            && self.last_toggle_command_at.map_or(true, |last| {
                now.duration_since(last) >= TOGGLE_SHORTCUT_DEBOUNCE
            })
    }

    fn helper_is_finalizing(&self, now: Instant) -> bool {
        self.helper_finalizing_since
            .is_some_and(|since| now.duration_since(since) < FINALIZING_SUPPRESSION_EXPIRY)
    }

    fn mark_toggle_command_sent(&mut self, now: Instant) {
        self.toggle_command_in_flight = true;
        self.last_toggle_command_at = Some(now);
    }

    fn acknowledge_toggle_command(&mut self) {
        self.toggle_command_in_flight = false;
    }

    fn mark_helper_finalizing(&mut self) {
        self.helper_finalizing_since = Some(Instant::now());
    }

    fn clear_helper_finalizing(&mut self) {
        self.helper_finalizing_since = None;
    }

    fn reset(&mut self) {
        self.active_mode = None;
        self.push_to_talk_is_down = false;
        self.push_started_at = None;
        self.toggle_command_in_flight = false;
        self.last_toggle_command_at = None;
        self.helper_finalizing_since = None;
    }
}

impl DictationCommand {
    fn helper_command(self, shortcut_label: &str) -> serde_json::Value {
        match self {
            Self::StartListening => serde_json::json!({ "type": "start_listening" }),
            Self::StopAndPaste => serde_json::json!({ "type": "stop_and_paste" }),
            Self::DiscardListening => serde_json::json!({ "type": "discard_recording" }),
            Self::ToggleListening => serde_json::json!({
                "type": "toggle_listening",
                "shortcut": shortcut_label,
            }),
        }
    }
}

impl DictationShortcutInput {
    fn into_setting(self) -> Result<DictationShortcutSetting, AppError> {
        self.into_setting_for_platform(cfg!(target_os = "windows"))
    }

    fn into_setting_for_platform(
        self,
        windows: bool,
    ) -> Result<DictationShortcutSetting, AppError> {
        if self.code.trim().is_empty() || self.label.trim().is_empty() {
            return Err(AppError::new(
                "dictation_shortcut_incomplete",
                "Shortcut is incomplete.",
            ));
        }

        let requested_press_count = self.press_count.unwrap_or(1);

        if windows && requested_press_count != 1 {
            return Err(AppError::new(
                "dictation_shortcut_unsupported",
                "Double-press shortcuts are not supported on Windows.",
            ));
        }
        let press_count = 1;

        if is_bare_fn_input(&self.code, &self.modifiers) {
            if windows {
                return Err(AppError::new(
                    "dictation_shortcut_unsupported",
                    "The Fn key is not supported for Windows dictation shortcuts.",
                ));
            }
            return Ok(DictationShortcutSetting {
                press_count,
                label: "Fn".to_string(),
                ..DictationShortcutSetting::bare_fn()
            });
        }

        if is_modifier_only_input(&self.code, &self.modifiers) {
            if windows {
                return Err(AppError::new(
                    "dictation_shortcut_unsupported",
                    "Modifier-only shortcuts are not supported on Windows.",
                ));
            }
            return Ok(DictationShortcutSetting::modifier_only(self.modifiers));
        }

        if windows && self.modifiers.function {
            return Err(AppError::new(
                "dictation_shortcut_unsupported",
                "The Fn key is not supported for Windows dictation shortcuts.",
            ));
        }

        if windows
            && !self.modifiers.command
            && !self.modifiers.control
            && !self.modifiers.option
            && !self.modifiers.shift
        {
            return Err(AppError::new(
                "dictation_shortcut_modifier_required",
                "Shortcut must include at least one modifier key (Ctrl, Alt, Shift, Win).",
            ));
        }

        let key_code = key_code_for_code(&self.code).ok_or_else(|| {
            AppError::new(
                "dictation_shortcut_unsupported",
                "Shortcut must include a supported non-modifier key.",
            )
        })?;

        if !self.modifiers.has_any() {
            return Err(AppError::new(
                "dictation_shortcut_modifier_required",
                "Shortcut must include at least one modifier key.",
            ));
        }

        Ok(DictationShortcutSetting {
            key_code,
            code: self.code,
            modifiers: self.modifiers,
            label: self.label,
            press_count,
        })
    }
}

fn is_bare_fn_input(code: &str, modifiers: &DictationShortcutModifiers) -> bool {
    code.eq_ignore_ascii_case("Fn") && modifiers.function && no_standard_modifiers(modifiers)
}

fn is_modifier_only_input(code: &str, modifiers: &DictationShortcutModifiers) -> bool {
    code.eq_ignore_ascii_case("Modifiers")
        && modifiers.has_any()
        && (is_bare_fn_input("Fn", modifiers) || modifiers.count() >= 2)
}

fn modifier_only_label(modifiers: &DictationShortcutModifiers) -> String {
    [
        (modifiers.command, "Cmd"),
        (modifiers.control, "Ctrl"),
        (modifiers.option, "Opt"),
        (modifiers.shift, "Shift"),
        (modifiers.function, "Fn"),
    ]
    .into_iter()
    .filter_map(|(enabled, label)| enabled.then_some(label))
    .collect::<Vec<_>>()
    .join("+")
}

fn legacy_shortcut_setting(id: &str) -> Option<DictationShortcutSetting> {
    match id {
        "bare_fn" | "fn" => Some(DictationShortcutSetting::bare_fn()),
        "fn_space" => Some(DictationShortcutSetting {
            key_code: 0x31,
            code: "Space".to_string(),
            modifiers: DictationShortcutModifiers {
                function: true,
                ..DictationShortcutModifiers::default()
            },
            label: "Fn+Space".to_string(),
            press_count: 1,
        }),
        "control_option_space" => Some(DictationShortcutSetting::control_option_t()),
        _ => None,
    }
}

fn no_standard_modifiers(modifiers: &DictationShortcutModifiers) -> bool {
    !modifiers.command && !modifiers.control && !modifiers.option && !modifiers.shift
}

fn default_shortcut_for_kind(kind: DictationShortcutKind) -> DictationShortcutSetting {
    match kind {
        DictationShortcutKind::PushToTalk => DictationShortcutSetting::control_option_d(),
        DictationShortcutKind::Toggle => DictationShortcutSetting::control_option_t(),
    }
}

pub fn setup(app: &mut tauri::App) {
    app.manage(HudPosition {
        inner: Mutex::new(None),
    });
    app.manage(HudHoverState {
        stop_bounds: Mutex::new(None),
        last_hover: std::sync::atomic::AtomicBool::new(false),
        dismiss_bounds: Mutex::new(None),
        last_dismiss_hover: std::sync::atomic::AtomicBool::new(false),
        record_bounds: Mutex::new(None),
        last_record_hover: std::sync::atomic::AtomicBool::new(false),
    });
    app.manage(HudFrameLock::default());
    spawn_hud_hover_thread(app.handle().clone());
    if let Err(error) = configure_hud_window(app.handle()) {
        tracing::warn!(%error, "failed to configure dictation HUD");
    }
    manage_settings(app.handle());
    app.manage(LastDictationEvent {
        event: Mutex::new(None),
    });
    app.manage(ShortcutActivationState {
        controller: Mutex::new(ShortcutActivationController::default()),
    });

    let helper = spawn_helper(app.handle()).ok();
    app.manage(HelperState {
        process: Mutex::new(helper),
        ..HelperState::default()
    });

    {
        let settings = app.state::<DictationSettingsState>();
        let helper_state = app.state::<HelperState>();
        let settings = settings
            .settings
            .lock()
            .ok()
            .map(|settings| settings.clone());
        if let Some(settings) = settings {
            let _ = apply_microphone_setting(&helper_state, &settings.microphone);
            let _ = apply_shortcut_settings(&helper_state, &settings);
        }
    }

    let settings = app
        .state::<DictationSettingsState>()
        .settings
        .lock()
        .map(|settings| settings.clone())
        .unwrap_or_default();
    let event = initial_hotkey_event(&settings);
    app.manage(HotkeyStatus {
        event: Mutex::new(event.clone()),
    });
    let _ = app.emit("dictation-event", event.to_string());
}

#[tauri::command]
pub fn dictation_capabilities() -> DictationCapabilitiesResponse {
    DictationCapabilitiesResponse {
        capabilities: DictationCapabilities {
            available: cfg!(any(target_os = "macos", target_os = "windows")),
            platform: if cfg!(target_os = "macos") {
                "macos"
            } else if cfg!(target_os = "windows") {
                "windows"
            } else {
                "unsupported"
            },
            shortcuts: cfg!(any(target_os = "macos", target_os = "windows")),
            paste: cfg!(any(target_os = "macos", target_os = "windows")),
            microphone_selection: cfg!(any(target_os = "macos", target_os = "windows")),
            accessibility_permission: cfg!(target_os = "macos"),
            system_audio: cfg!(target_os = "macos"),
        },
    }
}

#[tauri::command]
pub fn dictation_settings(
    state: State<'_, DictationSettingsState>,
) -> Result<DictationSettingsResponse, AppError> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| AppError::new("dictation_settings_unavailable", "Settings lock failed."))?
        .clone();
    Ok(DictationSettingsResponse { settings })
}

#[tauri::command]
pub async fn list_dictation_history(
    app: AppHandle,
) -> Result<ListDictationHistoryResponse, AppError> {
    crate::commands::repositories(&app)
        .await?
        .list_dictation_history(200)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn delete_dictation_history_item(app: AppHandle, id: String) -> Result<(), AppError> {
    crate::commands::repositories(&app)
        .await?
        .delete_dictation_history_item(&id)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn set_dictation_shortcut(
    app: AppHandle,
    state: State<'_, DictationSettingsState>,
    helper_state: State<'_, HelperState>,
    _hotkey_status: State<'_, HotkeyStatus>,
    kind: DictationShortcutKind,
    shortcut: DictationShortcutInput,
) -> Result<DictationSettings, AppError> {
    let shortcut = shortcut.into_setting()?;
    let current_settings = state
        .settings
        .lock()
        .map_err(|_| AppError::new("dictation_settings_unavailable", "Settings lock failed."))?
        .clone();

    validate_shortcut_update(&current_settings, kind, &shortcut)?;

    let current_shortcut = match kind {
        DictationShortcutKind::PushToTalk => &current_settings.push_to_talk_shortcut,
        DictationShortcutKind::Toggle => &current_settings.toggle_shortcut,
    };

    if current_shortcut == &shortcut {
        #[cfg(target_os = "macos")]
        set_hotkey_status(&_hotkey_status, hotkey_ready_event(&current_settings));
        apply_shortcut_settings(&helper_state, &current_settings)?;
        return Ok(current_settings);
    }

    let settings = update_settings(&state, |settings| match kind {
        DictationShortcutKind::PushToTalk => settings.push_to_talk_shortcut = shortcut,
        DictationShortcutKind::Toggle => settings.toggle_shortcut = shortcut,
    })?;
    reset_shortcut_activation(&app);
    apply_shortcut_settings(&helper_state, &settings)?;

    #[cfg(target_os = "macos")]
    set_hotkey_status(&_hotkey_status, hotkey_ready_event(&settings));
    Ok(settings)
}

#[tauri::command]
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn set_dictation_shortcut(
    kind: DictationShortcutKind,
    shortcut: DictationShortcutInput,
) -> Result<DictationSettings, AppError> {
    let _ = (kind, shortcut);
    Err(AppError::new(
        "dictation_shortcut_unsupported",
        "Dictation shortcuts are not supported on this platform.",
    ))
}

#[tauri::command]
pub fn set_dictation_microphone(
    state: State<'_, DictationSettingsState>,
    helper_state: State<'_, HelperState>,
    id: Option<String>,
    name: Option<String>,
) -> Result<DictationSettings, AppError> {
    let settings = update_settings(&state, |settings| {
        settings.microphone = DictationMicrophoneSetting { id, name };
    })?;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    if helper_state
        .process
        .lock()
        .map(|process| process.is_none())
        .unwrap_or(true)
    {
        return Ok(settings);
    }

    apply_microphone_setting(&helper_state, &settings.microphone)?;
    Ok(settings)
}

#[tauri::command]
pub fn set_dictation_style(
    state: State<'_, DictationSettingsState>,
    style: DictationStyle,
) -> Result<DictationSettings, AppError> {
    update_settings(&state, |settings| {
        settings.style = style;
    })
}

#[tauri::command]
pub fn set_dictation_language(
    state: State<'_, DictationSettingsState>,
    language: Option<String>,
) -> Result<DictationSettings, AppError> {
    let language = normalize_language(language);
    update_settings(&state, |settings| {
        settings.language = language;
    })
}

#[tauri::command]
pub fn dictation_helper_command(
    app: AppHandle,
    state: State<'_, HelperState>,
    command: serde_json::Value,
) -> Result<(), AppError> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if helper_command_resets_shortcut_activation(&command) {
        reset_shortcut_activation(&app);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    if state
        .process
        .lock()
        .map(|process| process.is_none())
        .unwrap_or(true)
    {
        return handle_missing_helper_command(&app, &command);
    }

    send_helper_command(&state, command)
}

fn helper_command_resets_shortcut_activation(command: &serde_json::Value) -> bool {
    matches!(
        command.get("type").and_then(serde_json::Value::as_str),
        Some("stop_and_paste" | "discard_recording" | "toggle_listening")
    )
}

#[tauri::command]
pub fn dictation_hotkey_status(state: State<'_, HotkeyStatus>) -> serde_json::Value {
    state
        .event
        .lock()
        .map(|event| event.clone())
        .unwrap_or_else(|_| hotkey_error_event("Hotkey status lock was poisoned.".to_string()))
}

#[tauri::command]
pub fn latest_dictation_event(state: State<'_, LastDictationEvent>) -> Option<String> {
    state.event.lock().ok().and_then(|event| event.clone())
}

/// Cursor position in logical points (top-left origin) read directly from
/// the window server. `WebviewWindow::cursor_position()` is not used here
/// because on macOS it only refreshes while the window is key, and the HUD
/// is a non-activating NSPanel.
#[cfg(target_os = "macos")]
fn cursor_position_via_cg() -> Option<(f64, f64)> {
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
        fn CGEventGetLocation(event: *const std::ffi::c_void) -> CGPoint;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const std::ffi::c_void);
    }

    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return None;
        }
        let point = CGEventGetLocation(event);
        CFRelease(event);
        Some((point.x, point.y))
    }
}

#[tauri::command]
pub fn dictation_hud_set_stop_bounds(state: State<'_, HudHoverState>, rect: Option<HudClientRect>) {
    if let Ok(mut guard) = state.stop_bounds.lock() {
        *guard = rect;
    }
}

#[tauri::command]
pub fn dictation_hud_set_dismiss_bounds(
    state: State<'_, HudHoverState>,
    rect: Option<HudClientRect>,
) {
    if let Ok(mut guard) = state.dismiss_bounds.lock() {
        *guard = rect;
    }
}

#[tauri::command]
pub fn dictation_hud_set_record_bounds(
    state: State<'_, HudHoverState>,
    rect: Option<HudClientRect>,
) {
    if let Ok(mut guard) = state.record_bounds.lock() {
        *guard = rect;
    }
}

#[tauri::command]
pub fn dictation_hud_preferred_error_placement(app: AppHandle) -> String {
    let Some(hud) = app.get_webview_window("hud") else {
        return "below".to_string();
    };
    let Ok(window_size) = hud.outer_size() else {
        return "below".to_string();
    };
    let Some(position) = current_or_next_hud_position(&app, &hud, window_size) else {
        return "below".to_string();
    };

    let center_x = position.x as f64 + window_size.width as f64 / 2.0;
    let center_y = position.y as f64 + window_size.height as f64 / 2.0;
    let monitor = hud
        .monitor_from_point(center_x, center_y)
        .ok()
        .flatten()
        .or_else(|| hud.current_monitor().ok().flatten())
        .or_else(|| hud.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return "below".to_string();
    };

    let work_area = monitor.work_area();
    let work_mid_y = work_area.position.y as f64 + work_area.size.height as f64 / 2.0;
    if center_y > work_mid_y {
        "above".to_string()
    } else {
        "below".to_string()
    }
}

/// Serializes window-frame motion (resize morphs, the error shake) so two
/// concurrent commands never fight over the window's position.
pub struct HudFrameLock(Mutex<()>);

impl Default for HudFrameLock {
    fn default() -> Self {
        Self(Mutex::new(()))
    }
}

/// Resize the HUD window to the pill's measured CSS size. The pill's width
/// varies by state (error text, meeting prompt), and with the frosted surface
/// being a window-filling NSVisualEffectView the window must track the pill
/// exactly. Re-anchors horizontally so the pill's center stays put; when the
/// window is visible the frame eases over rather than popping (the webview
/// crossfades the pill content around the same beat). Blocks until the motion
/// finishes so the webview can sequence its fade-in off the resolved invoke.
#[tauri::command]
pub fn dictation_hud_set_size(app: AppHandle, width: f64, height: f64, animate: bool) {
    let Some(hud) = app.get_webview_window("hud") else {
        return;
    };
    let lock = app.try_state::<HudFrameLock>();
    let _guard = lock.as_ref().and_then(|lock| lock.0.lock().ok());
    let Ok(scale) = hud.scale_factor() else {
        return;
    };
    let new_size = PhysicalSize::new(
        (width * scale).round() as u32,
        (height * scale).round() as u32,
    );
    animate_frame_to(&hud, new_size, animate);
}

/// Ease the window to `new_size`, keeping its center anchored. Skips the
/// animation (snaps) when the window is hidden or `animate` is false.
fn animate_frame_to(hud: &WebviewWindow, new_size: PhysicalSize<u32>, animate: bool) {
    let (Ok(position), Ok(old_size)) = (hud.outer_position(), hud.outer_size()) else {
        return;
    };
    if new_size == old_size {
        return;
    }
    let target_x = position.x + (old_size.width as i32 - new_size.width as i32) / 2;
    let target_y = position.y + (old_size.height as i32 - new_size.height as i32) / 2;

    if animate && hud.is_visible().unwrap_or(false) {
        const STEPS: u32 = 12;
        const STEP_MS: u64 = 12;
        for step in 1..STEPS {
            let t = f64::from(step) / f64::from(STEPS);
            // ease-out cubic — fast start, soft landing.
            let e = 1.0 - (1.0 - t).powi(3);
            let w = f64::from(old_size.width)
                + f64::from(new_size.width as i32 - old_size.width as i32) * e;
            let h = f64::from(old_size.height)
                + f64::from(new_size.height as i32 - old_size.height as i32) * e;
            let x = f64::from(position.x) + f64::from(target_x - position.x) * e;
            let y = f64::from(position.y) + f64::from(target_y - position.y) * e;
            let _ = hud.set_size(PhysicalSize::new(w.round() as u32, h.round() as u32));
            let _ = hud.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
            thread::sleep(Duration::from_millis(STEP_MS));
        }
    }
    let _ = hud.set_size(new_size);
    let _ = hud.set_position(PhysicalPosition::new(target_x, target_y));
}

/// Set the native window alpha. The exit dissolve is driven from the webview
/// (rAF over ~160ms) but must fade the NSWindow itself — CSS opacity can't
/// touch the vibrancy view or the native shadow.
#[tauri::command]
pub fn dictation_hud_set_alpha(app: AppHandle, alpha: f64) {
    let Some(hud) = app.get_webview_window("hud") else {
        return;
    };
    let _ = app.run_on_main_thread(move || {
        set_window_alpha(&hud, alpha.clamp(0.0, 1.0));
    });
}

#[cfg(target_os = "macos")]
fn set_window_alpha(hud: &WebviewWindow, alpha: f64) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let Ok(handle) = hud.ns_window() else {
        return;
    };
    if handle.is_null() {
        return;
    }
    unsafe {
        let window = handle as *mut AnyObject;
        let _: () = msg_send![window, setAlphaValue: alpha];
    }
}

#[cfg(not(target_os = "macos"))]
fn set_window_alpha(_hud: &WebviewWindow, _alpha: f64) {}

/// Show the HUD window. Invoked by the webview from showHud() once it has
/// measured the pill and resized the window to match — the window must never
/// become visible before that resize, or it flashes up at a stale frame
/// (bare frost, then a clipped pill) until the next visible-state resize.
///
/// `enter` marks a fresh meeting-prompt show: the window is placed at the
/// default top-center spot (the saved drag position is the dictation
/// pill's, not the prompt's) and — unless `animate` is false — slides down
/// from 8px above it while its alpha ramps up. The motion is native: a CSS
/// translate would slide the tinted card off the stationary window
/// chrome, flashing bare edges. Ignored when the window is already up
/// with content, where it would blink the visible pill. Blocks until the
/// motion settles; returns whether this was a fresh entrance.
#[tauri::command]
pub fn dictation_hud_show(app: AppHandle, enter: Option<bool>, animate: Option<bool>) -> bool {
    let Some(hud) = app.get_webview_window("hud") else {
        return false;
    };
    // A window woken at alpha 0 (wake_hud_window) reports visible but the
    // user can't see it — that still counts as a fresh entrance.
    let entering = enter.unwrap_or(false);
    let was_hidden = !hud.is_visible().unwrap_or(false)
        || HUD_WOKEN_FADED.load(std::sync::atomic::Ordering::Relaxed);
    if !hud.is_visible().unwrap_or(false) && !entering {
        position_hud_window(&app, &hud);
    }
    HUD_WOKEN_FADED.store(false, std::sync::atomic::Ordering::Relaxed);

    if !(was_hidden && entering) {
        // Plain show. An interrupted exit fade may have left the native
        // alpha low; restore it.
        let alpha_hud = hud.clone();
        let _ = app.run_on_main_thread(move || set_window_alpha(&alpha_hud, 1.0));
        let _ = hud.show();
        return was_hidden;
    }

    // The entrance is the meeting prompt, which always starts top-center.
    // Compute the target directly and anchor the motion on it — window
    // setters apply asynchronously on the main thread, so set_position
    // followed by outer_position() races and can hand the motion a stale
    // anchor, landing the prompt wherever the pill last sat.
    let target = hud
        .outer_size()
        .ok()
        .and_then(|size| default_hud_position(&hud, size));
    let Some((x, y)) = target else {
        let alpha_hud = hud.clone();
        let _ = app.run_on_main_thread(move || set_window_alpha(&alpha_hud, 1.0));
        let _ = hud.show();
        return was_hidden;
    };

    if !animate.unwrap_or(true) {
        // Reduced motion: right spot, no slide.
        let _ = hud.set_position(PhysicalPosition::new(x, y));
        let alpha_hud = hud.clone();
        let _ = app.run_on_main_thread(move || set_window_alpha(&alpha_hud, 1.0));
        let _ = hud.show();
        return was_hidden;
    }

    // Hold the frame lock so a concurrent resize morph or shake can't
    // capture a mid-entrance position as its anchor.
    let lock = app.try_state::<HudFrameLock>();
    let _guard = lock.as_ref().and_then(|lock| lock.0.lock().ok());
    let offset = hud
        .scale_factor()
        .map(|scale| (HUD_ENTER_OFFSET_LOGICAL * scale).round() as i32)
        .unwrap_or(0);
    let _ = hud.set_position(PhysicalPosition::new(x, y - offset));
    {
        let alpha_hud = hud.clone();
        let _ = app.run_on_main_thread(move || set_window_alpha(&alpha_hud, 0.0));
    }
    let _ = hud.show();
    // Position and alpha land in one main-thread closure per frame so the
    // slide and the fade can't desync.
    const STEPS: u32 = 18;
    const STEP_MS: u64 = 12;
    for step in 1..STEPS {
        let t = f64::from(step) / f64::from(STEPS);
        // ease-out cubic — fast start, soft landing.
        let e = 1.0 - (1.0 - t).powi(3);
        let frame_y = f64::from(y) - f64::from(offset) * (1.0 - e);
        let frame_hud = hud.clone();
        let frame = PhysicalPosition::new(x, frame_y.round() as i32);
        let _ = app.run_on_main_thread(move || {
            let _ = frame_hud.set_position(frame);
            set_window_alpha(&frame_hud, e);
        });
        thread::sleep(Duration::from_millis(STEP_MS));
    }
    let _ = hud.set_position(PhysicalPosition::new(x, y));
    let alpha_hud = hud.clone();
    let _ = app.run_on_main_thread(move || set_window_alpha(&alpha_hud, 1.0));
    was_hidden
}

/// Logical pixels the meeting prompt travels during its native entrance
/// and exit motion.
const HUD_ENTER_OFFSET_LOGICAL: f64 = 8.0;

/// Keep the HUD window on frostless chrome. The webview paints its own CSS
/// surface and shadow into a transparent, click-through gutter, matching the
/// agent HUD and avoiding native vibrancy rims or end-of-exit repaint flashes.
#[tauri::command]
pub fn dictation_hud_set_chrome(app: AppHandle, _frostless: bool) {
    let Some(hud) = app.get_webview_window("hud") else {
        return;
    };
    let _ = hud.set_shadow(false);
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::clear_vibrancy;
        if let Err(error) = clear_vibrancy(&hud) {
            tracing::warn!(%error, "failed to clear dictation HUD vibrancy");
        }
    }
}

/// Native exit for the meeting prompt: the mirror of the entrance — the
/// window slides up toward the top edge while its alpha ramps down, then
/// hides. The frame and alpha are restored afterwards so the saved drag
/// position doesn't creep upward and the next show starts clean. Blocks
/// until hidden.
#[tauri::command]
pub fn dictation_hud_exit(app: AppHandle) {
    let Some(hud) = app.get_webview_window("hud") else {
        return;
    };
    if !hud.is_visible().unwrap_or(false) {
        return;
    }
    let lock = app.try_state::<HudFrameLock>();
    let _guard = lock.as_ref().and_then(|lock| lock.0.lock().ok());
    let (Ok(base), Ok(scale)) = (hud.outer_position(), hud.scale_factor()) else {
        let _ = hud.hide();
        return;
    };
    let offset = (HUD_ENTER_OFFSET_LOGICAL * scale).round() as i32;
    // Long enough to read as a fade, matching the entrance; position and
    // alpha land in one main-thread closure per frame so they can't
    // desync.
    const STEPS: u32 = 18;
    const STEP_MS: u64 = 12;
    for step in 1..STEPS {
        let t = f64::from(step) / f64::from(STEPS);
        let e = 1.0 - (1.0 - t).powi(3);
        let y = f64::from(base.y) - f64::from(offset) * e;
        let frame_hud = hud.clone();
        let frame = PhysicalPosition::new(base.x, y.round() as i32);
        let _ = app.run_on_main_thread(move || {
            let _ = frame_hud.set_position(frame);
            set_window_alpha(&frame_hud, 1.0 - e);
        });
        thread::sleep(Duration::from_millis(STEP_MS));
    }
    let _ = hud.hide();
    let _ = hud.set_position(base);
    let alpha_hud = hud.clone();
    let _ = app.run_on_main_thread(move || set_window_alpha(&alpha_hud, 1.0));
}

/// Error-state shake. Pre-vibrancy this was a CSS translateX on the pill, but
/// the pill now fills the window — a CSS nudge would slide the tint off the
/// stationary frost. Wobble the window itself instead, tracing the same
/// decaying curve as the old `hud-shake` keyframes.
#[tauri::command]
pub fn dictation_hud_shake(app: AppHandle) {
    let Some(hud) = app.get_webview_window("hud") else {
        return;
    };
    thread::spawn(move || {
        // Hold the frame lock so a concurrent resize morph can't capture a
        // mid-wobble position as its anchor (and vice versa).
        let lock = app.try_state::<HudFrameLock>();
        let _guard = lock.as_ref().and_then(|lock| lock.0.lock().ok());
        const DURATION_MS: f64 = 380.0;
        const FRAME_MS: u64 = 16;
        // (progress, logical x offset) — the old CSS keyframes.
        const CURVE: [(f64, f64); 8] = [
            (0.0, 0.0),
            (0.12, -3.0),
            (0.28, 3.0),
            (0.44, -2.0),
            (0.60, 2.0),
            (0.76, -1.0),
            (0.90, 1.0),
            (1.0, 0.0),
        ];
        let (Ok(base), Ok(scale)) = (hud.outer_position(), hud.scale_factor()) else {
            return;
        };
        let mut elapsed = 0.0;
        while elapsed < DURATION_MS {
            let t = elapsed / DURATION_MS;
            let offset = CURVE
                .windows(2)
                .find(|w| t >= w[0].0 && t <= w[1].0)
                .map(|w| {
                    let (t0, x0) = w[0];
                    let (t1, x1) = w[1];
                    x0 + (x1 - x0) * ((t - t0) / (t1 - t0))
                })
                .unwrap_or(0.0);
            let x = base.x + (offset * scale).round() as i32;
            let _ = hud.set_position(PhysicalPosition::new(x, base.y));
            thread::sleep(Duration::from_millis(FRAME_MS));
            elapsed += FRAME_MS as f64;
        }
        let _ = hud.set_position(base);
    });
}

fn rect_contains(
    rect: &HudClientRect,
    position: PhysicalPosition<i32>,
    scale_factor: f64,
    cx: f64,
    cy: f64,
) -> bool {
    let left = position.x as f64 + rect.left * scale_factor;
    let right = position.x as f64 + rect.right * scale_factor;
    let top = position.y as f64 + rect.top * scale_factor;
    let bottom = position.y as f64 + rect.bottom * scale_factor;
    cx >= left && cx <= right && cy >= top && cy <= bottom
}

/// Polls the cursor against the cached control bounds (stop button, meeting
/// dismiss) and emits hover state changes. Short-circuits when no bounds
/// are registered.
fn spawn_hud_hover_thread(app: AppHandle) {
    thread::spawn(move || {
        let tick = Duration::from_millis(33);
        loop {
            thread::sleep(tick);

            let hover_state = match app.try_state::<HudHoverState>() {
                Some(state) => state,
                None => continue,
            };

            let Some(hud) = app.get_webview_window("hud") else {
                continue;
            };
            let visible = hud.is_visible().unwrap_or(false);

            let stop_rect = hover_state.stop_bounds.lock().ok().and_then(|g| g.clone());
            let dismiss_rect = hover_state
                .dismiss_bounds
                .lock()
                .ok()
                .and_then(|g| g.clone());
            let record_rect = hover_state
                .record_bounds
                .lock()
                .ok()
                .and_then(|g| g.clone());

            // Hidden or no hoverable controls on screen: drop stale hover.
            if !visible || (stop_rect.is_none() && dismiss_rect.is_none() && record_rect.is_none())
            {
                if hover_state.last_hover.swap(false, Ordering::Relaxed) {
                    let _ = app.emit("hud-stop-hover", false);
                }
                if hover_state
                    .last_dismiss_hover
                    .swap(false, Ordering::Relaxed)
                {
                    let _ = app.emit("hud-dismiss-hover", false);
                }
                if hover_state.last_record_hover.swap(false, Ordering::Relaxed) {
                    let _ = app.emit("hud-record-hover", false);
                }
                continue;
            }

            let (Ok(position), Ok(scale_factor)) = (hud.outer_position(), hud.scale_factor())
            else {
                continue;
            };

            #[cfg(target_os = "macos")]
            let cursor =
                cursor_position_via_cg().map(|(x, y)| (x * scale_factor, y * scale_factor));
            #[cfg(not(target_os = "macos"))]
            let cursor = hud.cursor_position().ok().map(|p| (p.x, p.y));

            let Some((cx, cy)) = cursor else { continue };

            let stop_hovered = match stop_rect.as_ref() {
                Some(rect) => rect_contains(rect, position, scale_factor, cx, cy),
                None => false,
            };
            if stop_hovered != hover_state.last_hover.load(Ordering::Relaxed) {
                hover_state
                    .last_hover
                    .store(stop_hovered, Ordering::Relaxed);
                let _ = app.emit("hud-stop-hover", stop_hovered);
            }

            let dismiss_hovered = match dismiss_rect.as_ref() {
                Some(rect) => rect_contains(rect, position, scale_factor, cx, cy),
                None => false,
            };
            if dismiss_hovered != hover_state.last_dismiss_hover.load(Ordering::Relaxed) {
                hover_state
                    .last_dismiss_hover
                    .store(dismiss_hovered, Ordering::Relaxed);
                let _ = app.emit("hud-dismiss-hover", dismiss_hovered);
            }

            let record_hovered = match record_rect.as_ref() {
                Some(rect) => rect_contains(rect, position, scale_factor, cx, cy),
                None => false,
            };
            if record_hovered != hover_state.last_record_hover.load(Ordering::Relaxed) {
                hover_state
                    .last_record_hover
                    .store(record_hovered, Ordering::Relaxed);
                let _ = app.emit("hud-record-hover", record_hovered);
            }
        }
    });
}

pub fn stop_helper(app: &AppHandle) {
    let state = app.state::<HelperState>();
    // Mark the teardown as intentional before killing so the supervisor thread
    // (woken by the resulting stdout EOF) skips respawning instead of fighting
    // app quit.
    state.shutting_down.store(true, Ordering::SeqCst);
    // Take the helper out from under the lock, then kill outside it so the
    // blocking wait() cannot stall a concurrent command thread.
    let helper = state.process.lock().ok().and_then(|mut guard| guard.take());
    if let Some(helper) = helper {
        abandon_helper(helper);
    }
}

pub(crate) fn dictation_helper_pid(app: &AppHandle) -> Option<u32> {
    app.try_state::<HelperState>().and_then(|state| {
        state
            .process
            .lock()
            .ok()?
            .as_ref()
            .map(|process| process.child.id())
    })
}

fn send_helper_command(state: &HelperState, command: serde_json::Value) -> Result<(), AppError> {
    let mut guard = state
        .process
        .lock()
        .map_err(|_| AppError::new("dictation_helper_unavailable", "Helper lock failed."))?;
    let process = guard.as_mut().ok_or_else(|| {
        AppError::new(
            "dictation_helper_unavailable",
            "Dictation helper process is not running.",
        )
    })?;
    let mut line = serde_json::to_string(&command)
        .map_err(|error| AppError::new("dictation_helper_command_invalid", error.to_string()))?;
    line.push('\n');
    process
        .stdin
        .write_all(line.as_bytes())
        .map_err(|error| AppError::new("dictation_helper_write_failed", error.to_string()))?;
    process
        .stdin
        .flush()
        .map_err(|error| AppError::new("dictation_helper_write_failed", error.to_string()))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn handle_missing_helper_command(
    app: &AppHandle,
    command: &serde_json::Value,
) -> Result<(), AppError> {
    match command.get("type").and_then(serde_json::Value::as_str) {
        Some(
            "get_permission_status"
            | "request_microphone_permission"
            | "request_accessibility_permission",
        ) => {
            emit_dictation_event_value(app, non_macos_permission_status_event());
            Ok(())
        }
        Some("list_microphones") => {
            emit_dictation_event_value(
                app,
                serde_json::json!({
                    "type": "microphone_devices",
                    "payload": {
                        "devices": [],
                        "selectedID": "",
                    },
                }),
            );
            Ok(())
        }
        Some(
            "cancel_shortcut_capture"
            | "start_shortcut_capture"
            | "set_microphone"
            | "discard_mic_test",
        ) => Ok(()),
        _ => Err(AppError::new(
            "dictation_helper_unavailable",
            "Dictation recording is not supported on this platform.",
        )),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn non_macos_permission_status_event() -> serde_json::Value {
    let (microphone, _) = crate::audio::capture::microphone_permission_state();
    serde_json::json!({
        "type": "permission_status",
        "payload": {
            "microphone": microphone,
            "accessibility": "granted",
        },
    })
}

fn apply_microphone_setting(
    helper_state: &HelperState,
    microphone: &DictationMicrophoneSetting,
) -> Result<(), AppError> {
    send_helper_command(
        helper_state,
        serde_json::json!({
            "type": "set_microphone",
            "id": microphone.id,
            "name": microphone.name,
        }),
    )
}

fn apply_shortcut_setting(
    helper_state: &HelperState,
    kind: DictationShortcutKind,
    shortcut: &DictationShortcutSetting,
) -> Result<(), AppError> {
    send_helper_command(
        helper_state,
        serde_json::json!({
            "type": "set_shortcut",
            "shortcut": {
                "keyCode": shortcut.key_code,
                "code": shortcut.code,
                "label": shortcut.label,
                "kind": kind,
                "pressCount": shortcut.press_count,
                "modifiers": shortcut.modifiers,
            },
        }),
    )
}

fn apply_shortcut_settings(
    helper_state: &HelperState,
    settings: &DictationSettings,
) -> Result<(), AppError> {
    apply_shortcut_setting(
        helper_state,
        DictationShortcutKind::PushToTalk,
        &settings.push_to_talk_shortcut,
    )?;
    apply_shortcut_setting(
        helper_state,
        DictationShortcutKind::Toggle,
        &settings.toggle_shortcut,
    )
}

fn validate_shortcut_update(
    settings: &DictationSettings,
    kind: DictationShortcutKind,
    shortcut: &DictationShortcutSetting,
) -> Result<(), AppError> {
    let other = match kind {
        DictationShortcutKind::PushToTalk => &settings.toggle_shortcut,
        DictationShortcutKind::Toggle => &settings.push_to_talk_shortcut,
    };

    if shortcut.same_trigger_as(other) {
        return Err(AppError::new(
            "dictation_shortcut_duplicate",
            "Push-to-talk and toggle dictation shortcuts must be different.",
        ));
    }

    Ok(())
}

fn handle_shortcut_key_event(
    app: &AppHandle,
    event_type: Option<&str>,
    event: Option<&serde_json::Value>,
) {
    let Some(event_type) = event_type else {
        return;
    };

    let edge = match event_type {
        "fn_key_down" | "shortcut_key_down" => ShortcutKeyEdge::Down,
        "fn_key_up" | "shortcut_key_up" => ShortcutKeyEdge::Up,
        _ => return,
    };

    let Some(kind) = shortcut_kind_from_event(event) else {
        reset_shortcut_activation(app);
        return;
    };

    let Some(settings) = current_dictation_settings(app) else {
        reset_shortcut_activation(app);
        return;
    };

    let command = app
        .try_state::<ShortcutActivationState>()
        .and_then(|state| {
            state
                .controller
                .lock()
                .ok()
                .and_then(|mut state| state.handle_edge(edge, kind, Instant::now()))
        });

    let shortcut = match kind {
        DictationShortcutKind::PushToTalk => settings.push_to_talk_shortcut,
        DictationShortcutKind::Toggle => settings.toggle_shortcut,
    };

    if let Some(command) = command {
        send_dictation_command(app, command, &shortcut.label);
    }
}

fn shortcut_kind_from_event(event: Option<&serde_json::Value>) -> Option<DictationShortcutKind> {
    let kind = event?
        .get("payload")
        .and_then(|payload| payload.get("kind"))
        .and_then(serde_json::Value::as_str)?;
    match kind {
        "push_to_talk" => Some(DictationShortcutKind::PushToTalk),
        "toggle" => Some(DictationShortcutKind::Toggle),
        _ => None,
    }
}

fn current_dictation_settings(app: &AppHandle) -> Option<DictationSettings> {
    app.try_state::<DictationSettingsState>()
        .and_then(|state| state.settings.lock().ok().map(|settings| settings.clone()))
}

fn reset_shortcut_activation(app: &AppHandle) {
    if let Some(state) = app.try_state::<ShortcutActivationState>() {
        if let Ok(mut controller) = state.controller.lock() {
            controller.reset();
        }
    }
}

fn acknowledge_shortcut_toggle(app: &AppHandle) {
    if let Some(state) = app.try_state::<ShortcutActivationState>() {
        if let Ok(mut controller) = state.controller.lock() {
            controller.acknowledge_toggle_command();
        }
    }
}

fn update_shortcut_helper_finalizing(app: &AppHandle, finalizing: bool) {
    if let Some(state) = app.try_state::<ShortcutActivationState>() {
        if let Ok(mut controller) = state.controller.lock() {
            if finalizing {
                controller.mark_helper_finalizing();
            } else {
                controller.clear_helper_finalizing();
            }
        }
    }
}

fn send_dictation_command(app: &AppHandle, command: DictationCommand, shortcut_label: &str) {
    // The start path needs a signed-in OS Accounts session for the
    // transcription that follows, but the token check must not sit between
    // the key press and the microphone: capture is local and the token is
    // only consumed once the recording ends. Awaiting it here delayed every
    // start by an executor hop, blocked on a network refresh whenever the
    // cached token was stale, and could reorder a fast press-release so
    // stop_and_paste reached the helper before start_listening. Start
    // immediately and check in parallel; a signed-out session discards the
    // moments-old local recording and lands on the same sign-in surface as
    // before. ToggleListening can also start, but we can't tell
    // start-from-stop without extra state; transcribe_recording_ready acts
    // as the backstop there.
    let forwarded = forward_dictation_command(app, command, shortcut_label);
    if !forwarded && matches!(command, DictationCommand::ToggleListening) {
        reset_shortcut_activation(app);
    }
    if matches!(command, DictationCommand::StartListening) {
        let app = app.clone();
        let label = shortcut_label.to_string();
        tauri::async_runtime::spawn(async move {
            match classify_dictation_auth(&crate::os_accounts::access_token().await) {
                DictationAuthGate::Proceed => {}
                // A transient outage at the key press must not kill a live
                // dictation: let it record. The recording_ready backstop
                // re-checks at the end and, if still unavailable, cleans up
                // the finalized audio and shows a retriable error.
                DictationAuthGate::Unavailable(_) => {}
                DictationAuthGate::SignedOut => {
                    forward_dictation_command(&app, DictationCommand::DiscardListening, &label);
                    notify_dictation_not_signed_in(&app);
                    reset_shortcut_activation(&app);
                }
            }
        });
    }
}

fn forward_dictation_command(
    app: &AppHandle,
    command: DictationCommand,
    shortcut_label: &str,
) -> bool {
    let Some(state) = app.try_state::<HelperState>() else {
        emit_dictation_event_value(
            app,
            app_error_event(AppError::new(
                "dictation_helper_unavailable",
                "Dictation helper process is not running.",
            )),
        );
        return false;
    };

    if let Err(error) = send_helper_command(&state, command.helper_command(shortcut_label)) {
        emit_dictation_event_value(app, app_error_event(error));
        return false;
    }
    true
}

/// Instant (millis since the Unix epoch) of the last signed-out prompt.
/// One press-release can hit two signed-out checks — the parallel
/// fast-discard task on the down edge and the transcribe_recording_ready
/// backstop on the up edge — and which of them fires (or both) depends on
/// how far the recording got before the discard landed. Deduping here, at
/// the notifier, collapses every ordering to a single prompt + focus pull
/// without losing the prompt in the paths where only one check runs.
static LAST_NOT_SIGNED_IN_AT_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
const NOT_SIGNED_IN_DEDUPE_MS: u64 = 2_000;

/// Emits the signed-out prompt and pulls the app forward, unless the same
/// prompt fired within the dedupe window. Owns the focus pull too, so
/// callers can't split the prompt from it.
fn notify_dictation_not_signed_in(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    let last = LAST_NOT_SIGNED_IN_AT_MS.load(Ordering::Relaxed);
    if now_ms.saturating_sub(last) < NOT_SIGNED_IN_DEDUPE_MS {
        return;
    }
    if LAST_NOT_SIGNED_IN_AT_MS
        .compare_exchange(last, now_ms, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        // Another path won the race within the same window.
        return;
    }
    emit_dictation_event_value(app, dictation_not_signed_in_event());
    focus_main_window(app);
}

fn dictation_not_signed_in_event() -> serde_json::Value {
    serde_json::json!({
        "type": "error",
        "payload": {
            "code": "not_signed_in",
            "message": "Sign in to use dictation.",
        },
    })
}

/// How a dictation auth check should be handled. A transient OS Accounts
/// failure is distinct from a genuine sign-out: the recording must be kept and
/// a retriable error shown, never discarded behind a sign-in prompt.
enum DictationAuthGate {
    /// The token is usable; continue with transcription.
    Proceed,
    /// OS Accounts was momentarily unreachable. Keep the recording; show a
    /// retriable error carrying the upstream message.
    Unavailable(AppError),
    /// The user is genuinely signed out. Discard and prompt to sign in.
    SignedOut,
}

fn classify_dictation_auth(result: &Result<String, AppError>) -> DictationAuthGate {
    match result {
        Ok(_) => DictationAuthGate::Proceed,
        Err(error) if crate::os_accounts::is_transient_auth_error(error) => {
            DictationAuthGate::Unavailable(error.clone())
        }
        Err(_) => DictationAuthGate::SignedOut,
    }
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("dictation-settings.json"))
}

fn manage_settings(app: &AppHandle) {
    let path = settings_path(app).unwrap_or_else(|| PathBuf::from("dictation-settings.json"));
    let settings = load_settings(app);
    replace_current_settings(settings.clone());
    app.manage(DictationSettingsState {
        path,
        settings: Mutex::new(settings),
    });
}

fn load_settings(app: &AppHandle) -> DictationSettings {
    let Some(path) = settings_path(app) else {
        return DictationSettings::default();
    };

    fs::read_to_string(path)
        .ok()
        .and_then(|settings| serde_json::from_str::<DictationSettings>(&settings).ok())
        .unwrap_or_default()
}

fn normalize_language(language: Option<String>) -> Option<String> {
    language
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| {
            value.len() == 2
                && value
                    .chars()
                    .all(|character| character.is_ascii_lowercase())
        })
}

fn settings_store() -> &'static Mutex<DictationSettings> {
    SETTINGS_CACHE.get_or_init(|| Mutex::new(DictationSettings::default()))
}

fn replace_current_settings(settings: DictationSettings) {
    if let Ok(mut current) = settings_store().lock() {
        *current = settings;
    }
}

fn update_settings(
    state: &DictationSettingsState,
    update: impl FnOnce(&mut DictationSettings),
) -> Result<DictationSettings, AppError> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| AppError::new("dictation_settings_unavailable", "Settings lock failed."))?;
    update(&mut settings);
    save_settings(state, &settings)?;
    replace_current_settings(settings.clone());
    Ok(settings.clone())
}

fn save_settings(
    state: &DictationSettingsState,
    settings: &DictationSettings,
) -> Result<(), AppError> {
    if let Some(parent) = state.path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::new("dictation_settings_save_failed", error.to_string()))?;
    }

    let serialized = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::new("dictation_settings_save_failed", error.to_string()))?;
    fs::write(&state.path, serialized)
        .map_err(|error| AppError::new("dictation_settings_save_failed", error.to_string()))
}

fn helper_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let manifest_dir = PathBuf::from(manifest_dir);
        #[cfg(target_os = "macos")]
        if let Some(repo_dir) = manifest_dir.parent() {
            paths.push(
                repo_dir
                    .join(".tauri-helper")
                    .join("June Dictation Helper.app")
                    .join("Contents")
                    .join("MacOS")
                    .join("june-dictation-helper"),
            );
        }
        #[cfg(target_os = "windows")]
        paths.push(
            manifest_dir
                .join("native")
                .join("bin")
                .join("june-dictation-helper.exe"),
        );
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            #[cfg(target_os = "windows")]
            {
                paths.push(exe_dir.join("june-dictation-helper.exe"));
                paths.push(
                    exe_dir
                        .join("native")
                        .join("bin")
                        .join("june-dictation-helper.exe"),
                );
                paths.push(
                    exe_dir
                        .join("resources")
                        .join("native")
                        .join("bin")
                        .join("june-dictation-helper.exe"),
                );
            }
            #[cfg(target_os = "macos")]
            {
                paths.push(exe_dir.join("june-dictation-helper"));
                paths.push(exe_dir.join("../Resources/june-dictation-helper"));
            }
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        #[cfg(target_os = "windows")]
        {
            paths.push(resource_dir.join("june-dictation-helper.exe"));
            paths.push(
                resource_dir
                    .join("native")
                    .join("bin")
                    .join("june-dictation-helper.exe"),
            );
        }
        #[cfg(target_os = "macos")]
        {
            paths.push(resource_dir.join("june-dictation-helper"));
            paths.push(
                resource_dir
                    .join("native")
                    .join("bin")
                    .join("June Dictation Helper.app")
                    .join("Contents")
                    .join("MacOS")
                    .join("june-dictation-helper"),
            );
            paths.push(
                resource_dir
                    .join("June Dictation Helper.app")
                    .join("Contents")
                    .join("MacOS")
                    .join("june-dictation-helper"),
            );
        }
    }

    paths
}

/// The dictation helper binary's basename, used by the ownership-aware orphan
/// reap below to confirm a recorded pid is still a dictation helper.
#[cfg(target_os = "macos")]
const DICTATION_HELPER_NAME: &str = "june-dictation-helper";

/// Filename prefix for the per-instance ownership records. One record per owning
/// app pid (never a single shared file), so concurrent instances — allowed in
/// debug builds — cannot clobber each other's pointer to their helper.
#[cfg(target_os = "macos")]
const HELPER_OWNER_RECORD_PREFIX: &str = "dictation-helper-owner-";

/// How long the reap waits for a killed orphan to actually exit before giving
/// up. `kill` only submits the signal; the old helper can still hold its global
/// CGEventTap for a moment, which would collide with the replacement helper.
#[cfg(target_os = "macos")]
const HELPER_ORPHAN_EXIT_TIMEOUT: Duration = Duration::from_millis(500);

/// Records which app instance owns the currently-spawned helper. Identity is
/// bound to `(pid, start_time)` for BOTH the owner and the helper, never a bare
/// pid: pids are recycled, and sequential reuse would otherwise let a new app
/// mistake a dead owner's record for its own (or let a stale helper pid, now
/// reused by another live instance's helper, be killed). The start time is the
/// non-reusable half of the identity.
#[cfg(target_os = "macos")]
#[derive(serde::Serialize, serde::Deserialize)]
struct HelperOwnershipRecord {
    /// The app process that spawned the helper (`std::process::id()`).
    app_pid: u32,
    /// The owning app's process start time (`ps -o lstart=`), the non-reusable
    /// half of its identity.
    app_start: String,
    /// The spawned helper process.
    helper_pid: u32,
    /// The helper's process start time, so a reused helper pid is not mistaken
    /// for the recorded orphan.
    helper_start: String,
}

/// The result of probing a pid's start time: distinguishes "the pid is gone"
/// (definitive) from "could not run `ps`" (unknown), so callers can fail closed
/// on the latter instead of assuming the process is absent.
#[cfg(target_os = "macos")]
enum StartTimeProbe {
    /// `ps` could not be run — identity cannot be established.
    Unknown,
    /// No process with this pid exists.
    Gone,
    /// The process exists and started at this (`ps -o lstart=`) time.
    StartedAt(String),
}

/// Tri-state executable-identity check, kept distinct from "gone" so the caller
/// can fail closed when `ps` itself could not run.
#[cfg(target_os = "macos")]
enum HelperIdentity {
    /// `ps` could not be run — identity cannot be established.
    Unknown,
    IsHelper,
    NotHelper,
}

/// Whether the recorded owner is still the same live process.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum OwnerLiveness {
    Alive,
    Dead,
    /// Could not be determined (e.g. `ps` failed).
    Unknown,
}

/// Whether the recorded helper pid still refers to the exact recorded process.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum HelperMatch {
    /// The pid is alive, is a dictation helper, and its start time matches.
    MatchesRecord,
    /// The pid is gone, or was reused for a different process.
    GoneOrReused,
    /// Could not be determined (e.g. `ps` failed).
    Unknown,
}

/// What to do with one ownership record.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RecordAction {
    /// Owner still owns it — leave the record and its helper alone.
    Skip,
    /// Owner is gone and the helper is gone/reused — drop the stale record.
    DeleteStale,
    /// Owner is gone and the helper is the recorded orphan — kill it.
    Reap,
    /// Identity could not be established — fail closed: abort the spawn and keep
    /// the record for the next attempt.
    Abort,
}

#[cfg(target_os = "macos")]
fn helper_ownership_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
}

/// This instance's own record path, keyed by our app pid so we never overwrite
/// another live instance's record.
#[cfg(target_os = "macos")]
fn helper_ownership_path(app: &AppHandle) -> Option<PathBuf> {
    helper_ownership_dir(app).map(|directory| {
        directory.join(format!(
            "{HELPER_OWNER_RECORD_PREFIX}{}.json",
            std::process::id()
        ))
    })
}

/// Probes a pid's start time. `ps` exits non-zero with no output for an absent
/// pid (definitive `Gone`); a failure to run `ps` at all is `Unknown`.
#[cfg(target_os = "macos")]
fn probe_start_time(pid: u32) -> StartTimeProbe {
    let output = Command::new("/bin/ps")
        .arg("-p")
        .arg(pid.to_string())
        .arg("-o")
        .arg("lstart=")
        .stdin(Stdio::null())
        .output();
    match output {
        Err(_) => StartTimeProbe::Unknown,
        Ok(output) if !output.status.success() => StartTimeProbe::Gone,
        Ok(output) => {
            let started = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if started.is_empty() {
                StartTimeProbe::Gone
            } else {
                StartTimeProbe::StartedAt(started)
            }
        }
    }
}

/// Whether a `ps -o comm=` line names the dictation helper. Pure and
/// truncation-tolerant: `comm=` may return the kernel `p_comm`, truncated to 15
/// printable chars (`june-dictation-`) instead of the full 21-char name, so a
/// basename that is a non-empty prefix of length ≥ 15 (the truncation length)
/// counts as a match. No other expected process shares a 15-char prefix of
/// `june-dictation-helper`, so this cannot false-positive. Handles both a bare
/// `comm` and a full path (`rsplit('/')`).
#[cfg(target_os = "macos")]
fn comm_line_is_dictation_helper(comm_line: &str) -> bool {
    let Some(basename) = comm_line
        .trim()
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    basename == DICTATION_HELPER_NAME
        || (basename.len() >= 15 && DICTATION_HELPER_NAME.starts_with(basename))
}

/// Tri-state executable-identity check via `ps -o comm=`. `Unknown` when `ps`
/// could not run; `NotHelper` when the pid is gone or is a different program.
#[cfg(target_os = "macos")]
fn inspect_helper_identity(pid: u32) -> HelperIdentity {
    let output = Command::new("/bin/ps")
        .arg("-p")
        .arg(pid.to_string())
        .arg("-o")
        .arg("comm=")
        .stdin(Stdio::null())
        .output();
    match output {
        Err(_) => HelperIdentity::Unknown,
        Ok(output) if !output.status.success() => HelperIdentity::NotHelper,
        Ok(output) => {
            if comm_line_is_dictation_helper(&String::from_utf8_lossy(&output.stdout)) {
                HelperIdentity::IsHelper
            } else {
                HelperIdentity::NotHelper
            }
        }
    }
}

/// Classifies the recorded owner against a live probe. Pure, so the pid-reuse
/// cases are unit-testable without processes.
#[cfg(target_os = "macos")]
fn owner_liveness(probe: &StartTimeProbe, recorded_start: &str) -> OwnerLiveness {
    match probe {
        StartTimeProbe::Unknown => OwnerLiveness::Unknown,
        StartTimeProbe::Gone => OwnerLiveness::Dead,
        // Same pid, but a *different* start time means the pid was reused by an
        // unrelated process: the original owner is gone.
        StartTimeProbe::StartedAt(started) => {
            if started == recorded_start {
                OwnerLiveness::Alive
            } else {
                OwnerLiveness::Dead
            }
        }
    }
}

/// Classifies the recorded helper against a live probe and identity check. Pure.
#[cfg(target_os = "macos")]
fn helper_match(
    probe: &StartTimeProbe,
    recorded_start: &str,
    identity: &HelperIdentity,
) -> HelperMatch {
    match probe {
        StartTimeProbe::Unknown => HelperMatch::Unknown,
        StartTimeProbe::Gone => HelperMatch::GoneOrReused,
        StartTimeProbe::StartedAt(started) => {
            if started != recorded_start {
                // Pid reused by a different process (possibly another live
                // instance's helper) — never touch it.
                HelperMatch::GoneOrReused
            } else {
                match identity {
                    HelperIdentity::Unknown => HelperMatch::Unknown,
                    HelperIdentity::IsHelper => HelperMatch::MatchesRecord,
                    // Exact recorded (pid, start_time) but the executable does
                    // not read as the helper. With the truncation-tolerant
                    // identity check above, a real helper reads IsHelper, so this
                    // is only a genuine same-second pid reuse by a non-helper —
                    // rare. Fail closed (abort + retry) rather than delete the
                    // record and risk racing an orphan.
                    HelperIdentity::NotHelper => HelperMatch::Unknown,
                }
            }
        }
    }
}

/// The full reap decision for one record. Pure and total, so every combination
/// is unit-testable. Fails closed (`Abort`) whenever identity is `Unknown`.
#[cfg(target_os = "macos")]
fn decide_record_action(owner: OwnerLiveness, helper: HelperMatch) -> RecordAction {
    match owner {
        OwnerLiveness::Alive => RecordAction::Skip,
        OwnerLiveness::Unknown => RecordAction::Abort,
        OwnerLiveness::Dead => match helper {
            HelperMatch::MatchesRecord => RecordAction::Reap,
            HelperMatch::GoneOrReused => RecordAction::DeleteStale,
            HelperMatch::Unknown => RecordAction::Abort,
        },
    }
}

/// Records the just-spawned helper's `(pid, start_time)` alongside our own
/// `(pid, start_time)`, so the next instance's [`reap_orphaned_helpers`] can
/// establish ownership against non-reusable identities. Written atomically (temp
/// file + fsync + rename) so a crash or partial write never leaves an
/// unparseable record. Returns an error on any failure — including being unable
/// to read our own or the helper's start time — so the caller reaps the just-
/// spawned child rather than leaving it untracked (fail closed).
#[cfg(target_os = "macos")]
fn record_helper_ownership(app: &AppHandle, helper_pid: u32) -> Result<(), AppError> {
    let path = helper_ownership_path(app).ok_or_else(|| {
        AppError::new(
            "dictation_helper_owner_unrecordable",
            "Could not resolve the dictation helper ownership path.",
        )
    })?;
    let StartTimeProbe::StartedAt(app_start) = probe_start_time(std::process::id()) else {
        return Err(AppError::new(
            "dictation_helper_owner_unrecordable",
            "Could not read this app's process start time.",
        ));
    };
    let StartTimeProbe::StartedAt(helper_start) = probe_start_time(helper_pid) else {
        return Err(AppError::new(
            "dictation_helper_owner_unrecordable",
            "Could not read the dictation helper's process start time.",
        ));
    };
    let record = HelperOwnershipRecord {
        app_pid: std::process::id(),
        app_start,
        helper_pid,
        helper_start,
    };
    let serialized = serde_json::to_string(&record)
        .map_err(|error| AppError::new("dictation_helper_owner_unrecordable", error.to_string()))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            AppError::new("dictation_helper_owner_unrecordable", error.to_string())
        })?;
    }
    let tmp = path.with_extension("json.tmp");
    let write = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(serialized.as_bytes())?;
        file.sync_all()?;
        fs::rename(&tmp, &path)
    })();
    write.map_err(|error| {
        let _ = fs::remove_file(&tmp);
        AppError::new("dictation_helper_owner_unrecordable", error.to_string())
    })
}

#[cfg(not(target_os = "macos"))]
fn record_helper_ownership(_app: &AppHandle, _helper_pid: u32) -> Result<(), AppError> {
    Ok(())
}

/// Reaps any dictation helper orphaned by a *prior* app instance before a fresh
/// one is spawned. A stale helper — most often left by an in-app update relaunch
/// that skipped teardown (JUN-338) — keeps the global CGEventTap and its stdio,
/// so a newly spawned helper collides with it and never delivers a clean
/// permission status.
///
/// Ownership-aware, never a name-wide sweep, and keyed on non-reusable
/// `(pid, start_time)` identities: it kills only a pid a prior instance
/// recorded, only when that instance is proven gone AND the pid is still the
/// exact recorded helper. A helper a concurrently-running instance owns has a
/// live owner (or a mismatching start time), so it is never touched — which
/// matters because debug builds allow multiple instances.
///
/// Fails closed: if a confirmed orphan will not die, or identity cannot be
/// established (`ps`/fs failure), it returns an error that aborts the
/// replacement spawn and keeps the record, rather than spawning over a helper
/// that may still hold the tap. macOS-only.
#[cfg(target_os = "macos")]
fn reap_orphaned_helpers(app: &AppHandle) -> Result<(), AppError> {
    let Some(dir) = helper_ownership_dir(app) else {
        // No config dir means no record was ever written: nothing to reap.
        tracing::warn!("dictation reap: no app config dir; skipping orphan reap");
        return Ok(());
    };
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            // The dir exists but is unreadable: we cannot prove there is no
            // orphan, so fail closed.
            tracing::warn!(%error, "dictation reap: ownership dir unreadable; aborting spawn");
            return Err(AppError::new(
                "dictation_helper_reap_failed",
                "Could not read the dictation helper ownership records.",
            ));
        }
    };
    for entry in entries {
        // A directory entry we cannot even enumerate might be a record naming a
        // live orphan: fail closed rather than skip it as absent.
        let entry = entry.map_err(|error| {
            tracing::warn!(%error, "dictation reap: ownership entry unreadable; aborting spawn");
            AppError::new(
                "dictation_helper_reap_failed",
                "Could not enumerate the dictation helper ownership records.",
            )
        })?;
        let path = entry.path();
        let is_record = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.starts_with(HELPER_OWNER_RECORD_PREFIX) && name.ends_with(".json")
            });
        if !is_record {
            continue;
        }
        // Distinguish a read I/O error from malformed content. An unreadable
        // record may name a live orphan still holding the event tap, so retain
        // it and fail closed; only a successfully-read-but-unparseable record is
        // the (atomic-write-guarded, near-impossible) delete-stale case.
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "dictation reap: ownership record unreadable; aborting spawn");
                return Err(AppError::new(
                    "dictation_helper_reap_failed",
                    "Could not read a dictation helper ownership record.",
                ));
            }
        };
        let Ok(record) = serde_json::from_str::<HelperOwnershipRecord>(&raw) else {
            tracing::warn!(path = %path.display(), "dictation reap: dropping unparseable ownership record");
            let _ = fs::remove_file(&path);
            continue;
        };
        let owner = owner_liveness(&probe_start_time(record.app_pid), &record.app_start);
        let action = if owner == OwnerLiveness::Alive {
            RecordAction::Skip
        } else {
            let helper = helper_match(
                &probe_start_time(record.helper_pid),
                &record.helper_start,
                &inspect_helper_identity(record.helper_pid),
            );
            decide_record_action(owner, helper)
        };
        match action {
            RecordAction::Skip => {}
            RecordAction::DeleteStale => {
                let _ = fs::remove_file(&path);
            }
            RecordAction::Reap => {
                kill_pid(record.helper_pid);
                if !wait_for_pid_exit(record.helper_pid, HELPER_ORPHAN_EXIT_TIMEOUT) {
                    tracing::warn!(
                        helper_pid = record.helper_pid,
                        "dictation reap: orphaned helper would not exit; aborting spawn"
                    );
                    return Err(AppError::new(
                        "dictation_helper_orphan_stuck",
                        "An orphaned dictation helper would not exit; retrying.",
                    ));
                }
                let _ = fs::remove_file(&path);
            }
            RecordAction::Abort => {
                tracing::warn!(
                    app_pid = record.app_pid,
                    helper_pid = record.helper_pid,
                    "dictation reap: could not establish ownership; aborting spawn"
                );
                return Err(AppError::new(
                    "dictation_helper_reap_failed",
                    "Could not establish dictation helper ownership; retrying.",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn reap_orphaned_helpers(_app: &AppHandle) -> Result<(), AppError> {
    Ok(())
}

/// What to do with a *running* helper process found by name enumeration (the
/// legacy/migration sweep) rather than by an ownership record.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum UnrecordedAction {
    /// Claimed by a live-owner record (a sibling instance's healthy helper) or
    /// not confirmably a helper — leave it alone.
    Skip,
    /// An unclaimed, confirmed helper — a legacy/leftover orphan; kill it.
    Reap,
    /// Identity could not be established — fail closed: abort the spawn.
    Abort,
}

/// The decision for one enumerated helper pid. Pure and total, so unit-testable.
/// A pid claimed by a *live* owner is a running instance's helper (never
/// touched); an unclaimed pid is reaped only when confirmed to still be a
/// dictation helper, and an indeterminate identity fails closed.
#[cfg(target_os = "macos")]
fn decide_unrecorded_action(
    claimed_by_live_owner: bool,
    identity: &HelperIdentity,
) -> UnrecordedAction {
    if claimed_by_live_owner {
        return UnrecordedAction::Skip;
    }
    match identity {
        HelperIdentity::IsHelper => UnrecordedAction::Reap,
        // Enumeration matched the name but `ps` disagrees on identity: do not
        // kill an unconfirmed process.
        HelperIdentity::NotHelper => UnrecordedAction::Skip,
        HelperIdentity::Unknown => UnrecordedAction::Abort,
    }
}

/// The helper pids that a *live-owner* ownership record currently claims. Used
/// by the legacy sweep to avoid killing a concurrently-running sibling
/// instance's healthy helper (debug multi-instance). Fails closed (error) on any
/// inability to enumerate or read a record, mirroring [`reap_orphaned_helpers`].
#[cfg(target_os = "macos")]
fn live_owner_claimed_helper_pids(app: &AppHandle) -> Result<Vec<u32>, AppError> {
    let Some(dir) = helper_ownership_dir(app) else {
        return Ok(Vec::new());
    };
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            tracing::warn!(%error, "dictation legacy reap: ownership dir unreadable; aborting spawn");
            return Err(AppError::new(
                "dictation_helper_reap_failed",
                "Could not read the dictation helper ownership records.",
            ));
        }
    };
    let mut claimed = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            tracing::warn!(%error, "dictation legacy reap: ownership entry unreadable; aborting spawn");
            AppError::new(
                "dictation_helper_reap_failed",
                "Could not enumerate the dictation helper ownership records.",
            )
        })?;
        let path = entry.path();
        let is_record = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.starts_with(HELPER_OWNER_RECORD_PREFIX) && name.ends_with(".json")
            });
        if !is_record {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "dictation legacy reap: ownership record unreadable; aborting spawn");
                return Err(AppError::new(
                    "dictation_helper_reap_failed",
                    "Could not read a dictation helper ownership record.",
                ));
            }
        };
        // Unparseable records name no live orphan; the record-driven reap that
        // ran first already dropped them. Ignore here.
        let Ok(record) = serde_json::from_str::<HelperOwnershipRecord>(&raw) else {
            continue;
        };
        if owner_liveness(&probe_start_time(record.app_pid), &record.app_start)
            == OwnerLiveness::Alive
        {
            claimed.push(record.helper_pid);
        }
    }
    Ok(claimed)
}

/// Enumerates running dictation-helper pids by matching the FULL command line
/// (`pgrep -f`), which carries the untruncated binary name/path and so is robust
/// to the `comm` truncation the record-driven path handles. Best-effort: `pgrep`
/// exits non-zero with no matches, and any failure yields an empty list.
#[cfg(target_os = "macos")]
fn enumerate_running_helper_pids() -> Vec<u32> {
    let output = Command::new("/usr/bin/pgrep")
        .arg("-f")
        .arg(DICTATION_HELPER_NAME)
        .stdin(Stdio::null())
        .output();
    match output {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .filter_map(|token| token.parse::<u32>().ok())
            .collect(),
        _ => Vec::new(),
    }
}

/// One-time migration sweep for helpers left by a *pre-record* build. Those
/// orphans have no `dictation-helper-owner-*.json`, so the record-driven
/// [`reap_orphaned_helpers`] cannot see them: on the very upgrade that fixes
/// JUN-338 the legacy helper would otherwise survive, keep the CGEventTap, and
/// leave permissions wedged.
///
/// SAFETY / TRADEOFF (call out for review): this deliberately reintroduces the
/// name-based enumeration that an earlier round replaced with ownership records.
/// It is justified ONLY for the unrecorded/migration case, and made safe by
/// skipping any pid a *live-owner* record claims — so a concurrently-running
/// sibling instance's healthy helper is skipped once that sibling has recorded
/// ownership. A debug-only TOCTOU remains: a sibling that has spawned its helper
/// but not yet written its record (spawn precedes the record write) could be
/// reaped by another instance's sweep. Production is single instance, so at
/// startup-before-spawn there is no sibling and we have not spawned yet — any
/// running helper is a legacy orphan and is reaped. Fails closed on record-read
/// ambiguity but never livelocks: a genuine
/// legacy orphan reads `IsHelper` and is killed so dictation recovers.
#[cfg(target_os = "macos")]
fn reap_unrecorded_helpers(app: &AppHandle) -> Result<(), AppError> {
    let pids = enumerate_running_helper_pids();
    if pids.is_empty() {
        return Ok(());
    }
    let claimed = live_owner_claimed_helper_pids(app)?;
    for pid in pids {
        let claimed_by_live_owner = claimed.contains(&pid);
        let identity = inspect_helper_identity(pid);
        match decide_unrecorded_action(claimed_by_live_owner, &identity) {
            UnrecordedAction::Skip => {}
            UnrecordedAction::Reap => {
                kill_pid(pid);
                if !wait_for_pid_exit(pid, HELPER_ORPHAN_EXIT_TIMEOUT) {
                    tracing::warn!(
                        helper_pid = pid,
                        "dictation legacy reap: unrecorded helper would not exit; aborting spawn"
                    );
                    return Err(AppError::new(
                        "dictation_helper_orphan_stuck",
                        "An orphaned dictation helper would not exit; retrying.",
                    ));
                }
            }
            UnrecordedAction::Abort => {
                tracing::warn!(
                    helper_pid = pid,
                    "dictation legacy reap: could not establish helper identity; aborting spawn"
                );
                return Err(AppError::new(
                    "dictation_helper_reap_failed",
                    "Could not establish a running dictation helper's identity; retrying.",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn reap_unrecorded_helpers(_app: &AppHandle) -> Result<(), AppError> {
    Ok(())
}

/// Submits SIGKILL to a single pid (best-effort; the caller confirms exit).
#[cfg(target_os = "macos")]
fn kill_pid(pid: u32) {
    let _ = Command::new("/bin/kill")
        .arg("-KILL")
        .arg(pid.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Polls until `pid` is no longer alive, or the timeout elapses. Returns whether
/// it exited, so the caller can refuse to spawn a replacement while an orphan
/// still holds the global CGEventTap.
#[cfg(target_os = "macos")]
fn wait_for_pid_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !process_alive(pid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

/// Whether a pid is live and signalable by us (`kill -0`). Same-user only, which
/// is all June ever records.
#[cfg(target_os = "macos")]
fn process_alive(pid: u32) -> bool {
    Command::new("/bin/kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn spawn_helper(app: &AppHandle) -> Result<HelperProcess, AppError> {
    // Abort the spawn if a prior instance's orphaned helper is still holding the
    // global CGEventTap; racing it would reproduce the permission collision.
    // Record-driven reap first, then the one-time legacy sweep for helpers left
    // by pre-record builds (no ownership record exists for those) — JUN-338.
    reap_orphaned_helpers(app)?;
    reap_unrecorded_helpers(app)?;

    let helper_path = helper_candidates(app)
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| {
            AppError::new(
                "dictation_helper_missing",
                "Could not find bundled dictation helper binary.",
            )
        })?;

    let mut child = Command::new(&helper_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            AppError::new(
                "dictation_helper_start_failed",
                format!(
                    "Failed to start helper at {}: {error}",
                    helper_path.display()
                ),
            )
        })?;

    let stdin = child.stdin.take().ok_or_else(|| {
        AppError::new(
            "dictation_helper_start_failed",
            "Helper stdin was unavailable.",
        )
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        AppError::new(
            "dictation_helper_start_failed",
            "Helper stdout was unavailable.",
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        AppError::new(
            "dictation_helper_start_failed",
            "Helper stderr was unavailable.",
        )
    })?;

    // Record ownership so the next instance can reap this exact helper if we
    // exit without tearing it down (e.g. an update relaunch), and never touch a
    // helper another live instance owns (JUN-338). If it cannot be persisted,
    // do not leave an untracked helper running: kill it and fail the spawn.
    if let Err(error) = record_helper_ownership(app, child.id()) {
        tracing::warn!(
            error = %error.message,
            "dictation: could not record helper ownership; killing untracked helper"
        );
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    // Recorded before handing stdout to the reader so the supervisor can tell a
    // healthy helper (ran a while, then died) from a crash loop.
    let spawn_instant = Instant::now();

    let output_app = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            handle_helper_event_line(&output_app, line);
        }
        // The helper's event stream lives for the whole process lifetime, so
        // stdout closing means the helper exited (crash, SIGKILL after an
        // update swaps the bundle, or an intentional stop). Hand off to the
        // supervisor to reap it and decide whether to respawn.
        supervise_helper_exit(&output_app, spawn_instant);
    });

    let error_app = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let _ = error_app.emit("dictation-helper-stderr", line);
        }
    });

    Ok(HelperProcess { child, stdin })
}

/// How many consecutive rapid respawns we attempt before giving up and showing
/// the "relaunch to recover" notice. Bounds a genuine crash loop so it can't
/// burn CPU forever, while still recovering from any isolated helper death.
const HELPER_MAX_RESPAWN_ATTEMPTS: u32 = 5;
/// Backoff before the first respawn; doubles each attempt up to the cap below.
const HELPER_RESPAWN_BASE_BACKOFF: Duration = Duration::from_millis(500);
const HELPER_RESPAWN_MAX_BACKOFF: Duration = Duration::from_secs(8);
/// A helper that ran at least this long before dying is treated as healthy: its
/// death starts a fresh failure count instead of counting toward the cap, so
/// repeated manual kills (or a death long after launch) always recover.
const HELPER_HEALTHY_RUNTIME: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy)]
struct RespawnPolicy {
    max_attempts: u32,
    base_backoff: Duration,
    max_backoff: Duration,
    healthy_runtime: Duration,
}

impl Default for RespawnPolicy {
    fn default() -> Self {
        Self {
            max_attempts: HELPER_MAX_RESPAWN_ATTEMPTS,
            base_backoff: HELPER_RESPAWN_BASE_BACKOFF,
            max_backoff: HELPER_RESPAWN_MAX_BACKOFF,
            healthy_runtime: HELPER_HEALTHY_RUNTIME,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RespawnAction {
    /// Intentional shutdown: leave the helper down.
    Skip,
    /// Relaunch the helper after `backoff`. `attempt` is 1-based.
    Respawn { attempt: u32, backoff: Duration },
    /// Too many rapid failures: surface the unavailable notice and stop trying.
    GiveUp,
}

/// Pure decision for what to do after the dictation helper process exits.
///
/// `prior_failures` is the count of consecutive rapid respawns so far;
/// `survived` is how long the process that just exited had been running.
/// Returns the action to take plus the new consecutive-failure count to persist
/// (so the caller stays a thin, side-effecting shell around this logic).
fn decide_respawn(
    shutting_down: bool,
    prior_failures: u32,
    survived: Duration,
    policy: &RespawnPolicy,
) -> (RespawnAction, u32) {
    if shutting_down {
        return (RespawnAction::Skip, prior_failures);
    }
    let attempt = if survived >= policy.healthy_runtime {
        1
    } else {
        prior_failures.saturating_add(1)
    };
    if attempt > policy.max_attempts {
        return (RespawnAction::GiveUp, attempt);
    }
    (
        RespawnAction::Respawn {
            attempt,
            backoff: respawn_backoff(attempt, policy),
        },
        attempt,
    )
}

fn respawn_backoff(attempt: u32, policy: &RespawnPolicy) -> Duration {
    // 1-based attempts: the first respawn waits `base_backoff`, each later one
    // doubles, all clamped to `max_backoff`.
    let shift = attempt.saturating_sub(1).min(16);
    policy
        .base_backoff
        .checked_mul(1u32 << shift)
        .unwrap_or(policy.max_backoff)
        .min(policy.max_backoff)
}

fn helper_unavailable_event(reason: &str, message: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "helper_unavailable",
        "payload": {
            "reason": reason,
            "message": message,
        },
    })
}

/// Runs on the helper's stdout reader thread once that stream closes (the helper
/// exited or was killed). Reaps the child, then respawns with backoff unless the
/// exit was an intentional shutdown or the retry cap is exhausted. A successful
/// respawn re-applies settings and re-arms the hotkey, and its own reader thread
/// takes over supervision, so this thread simply returns.
fn supervise_helper_exit(app: &AppHandle, spawn_instant: Instant) {
    // A helper that dies mid-listening emits no terminal event, so restore
    // any ducked meeting mic here — the crash path must not swallow the rest
    // of the meeting's mic track.
    crate::audio::capture::set_mic_ducked(false);

    let Some(state) = app.try_state::<HelperState>() else {
        return;
    };

    // Reap the exited child so it does not linger as a zombie, and clear the
    // stale handle so commands correctly see the helper as unavailable while
    // it is down.
    if !reap_exited_helper(&state) {
        return;
    }
    reset_shortcut_activation(app);

    let policy = RespawnPolicy::default();
    let mut survived = spawn_instant.elapsed();
    loop {
        let (action, next_failures) = decide_and_record_respawn(&state, survived, &policy);

        match action {
            RespawnAction::Skip => return,
            RespawnAction::GiveUp => {
                tracing::error!(
                    attempts = next_failures,
                    "dictation helper kept exiting; giving up until relaunch"
                );
                emit_helper_unavailable(
                    app,
                    "exhausted",
                    "Dictation stopped and could not restart. Relaunch June to restore it.",
                );
                return;
            }
            RespawnAction::Respawn { attempt, backoff } => {
                tracing::warn!(
                    attempt,
                    ?backoff,
                    "dictation helper exited unexpectedly; respawning"
                );
                // Surface the notice while the helper is down so the hotkey is
                // never silently dead; a successful respawn clears it by
                // re-emitting the hotkey-ready event.
                emit_helper_unavailable(app, "restarting", "Dictation stopped and is restarting.");
                thread::sleep(backoff);
                if state.shutting_down.load(Ordering::SeqCst) {
                    return;
                }
                match spawn_helper(app) {
                    Ok(helper) => match store_respawned_helper(&state, helper) {
                        StoreRespawnedHelper::Stored => {
                            reapply_helper_settings(app);
                            // The new helper is live and its reader thread now
                            // supervises.
                            return;
                        }
                        StoreRespawnedHelper::ExitedBeforeStore => {
                            survived = Duration::ZERO;
                        }
                        StoreRespawnedHelper::Abandoned => return,
                    },
                    Err(error) => {
                        tracing::warn!(
                            error = %error.message,
                            "failed to respawn dictation helper; retrying"
                        );
                        // A spawn failure (e.g. the bundle is still mid-swap)
                        // counts as an immediate, unhealthy failure so the cap
                        // still applies.
                        survived = Duration::ZERO;
                    }
                }
            }
        }
    }
}

fn decide_and_record_respawn(
    state: &HelperState,
    survived: Duration,
    policy: &RespawnPolicy,
) -> (RespawnAction, u32) {
    loop {
        let shutting_down = state.shutting_down.load(Ordering::SeqCst);
        let prior = state.respawn_failures.load(Ordering::SeqCst);
        let (action, next_failures) = decide_respawn(shutting_down, prior, survived, policy);
        if matches!(action, RespawnAction::Skip) {
            return (action, next_failures);
        }
        if state
            .respawn_failures
            .compare_exchange(prior, next_failures, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            return (action, next_failures);
        }
    }
}

fn reap_exited_helper(state: &HelperState) -> bool {
    if let Ok(mut guard) = state.process.lock() {
        if let Some(mut process) = guard.take() {
            let _ = process.child.wait();
            return true;
        }
    }
    false
}

#[derive(Debug, PartialEq, Eq)]
enum StoreRespawnedHelper {
    Stored,
    ExitedBeforeStore,
    Abandoned,
}

/// Installs a freshly respawned helper as the active process, unless an
/// intentional shutdown raced in first, in which case the new helper is stopped
/// so it does not leak.
fn store_respawned_helper(state: &HelperState, mut helper: HelperProcess) -> StoreRespawnedHelper {
    let Ok(mut guard) = state.process.lock() else {
        // Poisoned lock: stop the orphan we just created rather than leak it.
        abandon_helper(helper);
        return StoreRespawnedHelper::Abandoned;
    };
    if state.shutting_down.load(Ordering::SeqCst) {
        // Shutdown won the race. Drop the lock before the blocking kill so
        // other command threads are not stalled on wait().
        drop(guard);
        abandon_helper(helper);
        return StoreRespawnedHelper::Abandoned;
    }
    if matches!(helper.child.try_wait(), Ok(Some(_))) {
        return StoreRespawnedHelper::ExitedBeforeStore;
    }
    *guard = Some(helper);
    StoreRespawnedHelper::Stored
}

const HELPER_SHUTDOWN_GRACE: Duration = Duration::from_millis(750);
const HELPER_SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Stops a helper we spawned but will not install (shutdown raced the respawn).
/// Dropping a [`Child`] only detaches it, so we kill explicitly to avoid an
/// orphaned helper holding the global hotkey tap. Give a cooperative shutdown a
/// short grace period first so the helper can restore clipboard state and remove
/// temporary recordings before the forced-kill fallback.
fn abandon_helper(mut helper: HelperProcess) {
    let _ = helper.stdin.write_all(b"{\"type\":\"shutdown\"}\n");
    let _ = helper.stdin.flush();
    if wait_for_helper_exit(&mut helper.child, HELPER_SHUTDOWN_GRACE) {
        return;
    }
    let _ = helper.child.kill();
    let _ = helper.child.wait();
}

fn wait_for_helper_exit(child: &mut Child, grace: Duration) -> bool {
    let deadline = Instant::now() + grace;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {}
            Err(_) => return true,
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(HELPER_SHUTDOWN_POLL_INTERVAL);
    }
}

/// Re-applies the persisted microphone and shortcut settings to a just-respawned
/// helper and re-arms the hotkey, mirroring the one-time wiring in [`setup`]. The
/// hotkey-ready event also clears the "dictation restarting" notice in the UI.
fn reapply_helper_settings(app: &AppHandle) {
    let Some(helper_state) = app.try_state::<HelperState>() else {
        return;
    };
    let settings = app
        .try_state::<DictationSettingsState>()
        .and_then(|state| state.settings.lock().ok().map(|settings| settings.clone()));
    let Some(settings) = settings else {
        return;
    };
    let _ = apply_microphone_setting(&helper_state, &settings.microphone);
    let _ = apply_shortcut_settings(&helper_state, &settings);
    #[cfg(target_os = "macos")]
    {
        let event = hotkey_ready_event(&settings);
        if let Some(status) = app.try_state::<HotkeyStatus>() {
            set_hotkey_status(&status, event.clone());
        }
        emit_dictation_event_value(app, event);
    }
}

fn emit_helper_unavailable(app: &AppHandle, reason: &str, message: &str) {
    let event = helper_unavailable_event(reason, message);
    if let Some(status) = app.try_state::<HotkeyStatus>() {
        set_hotkey_status(&status, event.clone());
    }
    emit_dictation_event_value(app, event);
}

fn handle_helper_event_line(app: &AppHandle, line: String) {
    let event = serde_json::from_str::<serde_json::Value>(&line).ok();
    let event_type = event
        .as_ref()
        .and_then(|event| event.get("type"))
        .and_then(serde_json::Value::as_str);

    if matches!(
        event_type,
        Some("hotkey_trigger_ready" | "hotkey_trigger_unavailable")
    ) {
        if let (Some(status), Some(event)) = (app.try_state::<HotkeyStatus>(), event.as_ref()) {
            set_hotkey_status(&status, event.clone());
        }
    }

    handle_shortcut_key_event(app, event_type, event.as_ref());
    if matches!(
        event_type,
        Some(
            "listening_started"
                | "finalizing_transcript"
                | "recording_discarded"
                | "final_transcript"
                | "error"
        )
    ) {
        acknowledge_shortcut_toggle(app);
    }
    match event_type {
        Some("finalizing_transcript") => update_shortcut_helper_finalizing(app, true),
        Some("listening_started" | "recording_discarded" | "final_transcript" | "error") => {
            update_shortcut_helper_finalizing(app, false);
        }
        _ => {}
    }

    if matches!(event_type, Some("recording_ready")) {
        if let Some(event) = event.as_ref() {
            match recording_ready_info_from_event(event) {
                Ok(info) => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        transcribe_recording_ready(app, info).await;
                    });
                }
                Err(error) => {
                    let state = app.state::<HelperState>();
                    let _ = send_helper_command(
                        &state,
                        serde_json::json!({ "type": "discard_recording" }),
                    );
                    emit_dictation_event_value(app, app_error_event(error));
                }
            }
        }
    }

    // Route through emit_dictation_event_value so error events get the
    // `payload.silent` annotation from a single classification site.
    if let Some(event) = event {
        emit_dictation_event_value(app, event);
    } else {
        update_latest_event(app, event_type, Some(line.clone()));
        update_hud_window(app, event_type, None);
        let _ = app.emit("dictation-event", line);
    }
}

async fn transcribe_recording_ready(app: AppHandle, recording: RecordingReadyInfo) {
    let audio_path = recording.audio_path.clone();
    // Resolve the paste target before the first await. Prefer the bundle id
    // the helper captured with the recording: the helper pins that same app
    // when the recording stops and pastes into it once we return, so layout
    // and paste share one source of truth even though the awaits below can
    // take many seconds. Fall back to the frontmost app for helper builds
    // that predate the field.
    let app_context = recording
        .target_bundle_id
        .as_deref()
        .map(|bundle_id| is_email_app_bundle(bundle_id).then(|| APP_CONTEXT_EMAIL.to_string()))
        .unwrap_or_else(frontmost_app_context);
    // Backstop for the toggle-start path (where the start-time gate in
    // send_dictation_command can't tell start from stop) and for tokens that
    // expired between start and finish.
    match classify_dictation_auth(&crate::os_accounts::access_token().await) {
        DictationAuthGate::Proceed => {}
        DictationAuthGate::Unavailable(error) => {
            // OS Accounts is temporarily unreachable. The helper has already
            // finalized this capture to a temp WAV, and there is no retained
            // retry handle after recording_ready, so remove it before
            // surfacing the retriable auth error.
            remove_windows_dictation_audio(&recording.audio_path);
            update_shortcut_helper_finalizing(&app, false);
            emit_dictation_event_value(&app, app_error_event(error));
            return;
        }
        DictationAuthGate::SignedOut => {
            remove_windows_dictation_audio(&recording.audio_path);
            let state = app.state::<HelperState>();
            let _ = send_helper_command(&state, serde_json::json!({ "type": "discard_recording" }));
            update_shortcut_helper_finalizing(&app, false);
            notify_dictation_not_signed_in(&app);
            let _ = std::fs::remove_file(&audio_path);
            return;
        }
    }
    let provider = match dictation_transcription_provider(configured_transcription_provider()) {
        Ok(provider) => provider,
        Err(error) => {
            remove_windows_dictation_audio(&recording.audio_path);
            let state = app.state::<HelperState>();
            let _ = send_helper_command(&state, serde_json::json!({ "type": "discard_recording" }));
            update_shortcut_helper_finalizing(&app, false);
            emit_dictation_event_value(&app, app_error_event(error));
            let _ = std::fs::remove_file(&audio_path);
            return;
        }
    };
    let current_settings = current_dictation_settings(&app).unwrap_or_default();
    let style = current_settings.style;
    let language = current_settings.language;
    let dictionary_context = dictionary_context_for_app(&app).await;
    let session_id = dictation_session_id();
    let utterance_id = uuid::Uuid::new_v4().to_string();
    let transcription_context = merge_transcription_context(
        dictionary_context.as_deref(),
        Some(dictation_transcription_context(style).as_str()),
    );
    let transcription_audio = match prepare_dictation_audio(&recording.audio_path, &utterance_id) {
        Ok(path) => path,
        Err(error) => {
            remove_windows_dictation_audio(&recording.audio_path);
            let state = app.state::<HelperState>();
            let _ = send_helper_command(&state, serde_json::json!({ "type": "discard_recording" }));
            update_shortcut_helper_finalizing(&app, false);
            emit_dictation_event_value(&app, app_error_event(error));
            return;
        }
    };
    let result = dictate_transcribe(DictateTranscribeRequest {
        audio_path: transcription_audio.clone(),
        context: transcription_context,
        language,
        session_id: session_id.clone(),
        utterance_id: utterance_id.clone(),
    })
    .await;
    if transcription_audio != recording.audio_path {
        let _ = fs::remove_file(&transcription_audio);
    }
    remove_windows_dictation_audio(&recording.audio_path);
    let result = maybe_cleanup_dictation_result(
        &app,
        &provider,
        result,
        dictionary_context,
        app_context,
        style,
        session_id,
        utterance_id,
    )
    .await;
    let outcome = outcome_from_transcription_result(result, recording.observed_audio_level, style);
    let state = app.state::<HelperState>();
    if let Err(error) = send_helper_command(&state, outcome.helper_command) {
        update_shortcut_helper_finalizing(&app, false);
        emit_dictation_event_value(&app, app_error_event(error));
        let _ = std::fs::remove_file(&audio_path);
        return;
    }
    if let Some(transcript) = outcome.transcript.as_ref() {
        crate::p3a::record_question_best_effort(
            app.clone(),
            crate::p3a::questions::Question::DictationSessions,
        );
        spawn_dictation_history_write(app.clone(), transcript.clone());
    }
    if let Some(event) = outcome.event {
        emit_dictation_event_value(&app, event);
    }
    let _ = std::fs::remove_file(&audio_path);
}

fn prepare_dictation_audio(
    input_path: &std::path::Path,
    utterance_id: &str,
) -> Result<PathBuf, AppError> {
    #[cfg(target_os = "windows")]
    {
        let output_path =
            std::env::temp_dir().join(format!("os-june-dictation-{utterance_id}-normalized.wav"));
        return normalize_wav_for_transcription(input_path, &output_path);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = utterance_id;
        Ok(input_path.to_path_buf())
    }
}

#[cfg(target_os = "windows")]
fn remove_windows_dictation_audio(path: &std::path::Path) {
    let _ = fs::remove_file(path);
}

#[cfg(not(target_os = "windows"))]
fn remove_windows_dictation_audio(_path: &std::path::Path) {}

fn dictation_session_id() -> String {
    use std::sync::OnceLock;
    static SESSION_ID: OnceLock<String> = OnceLock::new();
    SESSION_ID
        .get_or_init(|| uuid::Uuid::new_v4().to_string())
        .clone()
}

fn dictation_transcription_provider(provider: String) -> Result<String, AppError> {
    if provider != OPENAI_PROVIDER && provider != VENICE_PROVIDER {
        return Err(AppError::new(
            "dictation_provider_not_configured",
            "Dictation requires an OpenAI or Venice transcription model through June API.",
        ));
    }
    Ok(provider)
}

fn dictation_transcription_context(style: DictationStyle) -> String {
    format!(
        "{DICTATION_TRANSCRIPTION_CONTEXT}\n\n{}",
        style.instruction()
    )
}

fn is_email_app_bundle(bundle_id: &str) -> bool {
    EMAIL_APP_BUNDLE_IDS
        .iter()
        .any(|known| bundle_id.eq_ignore_ascii_case(known))
}

/// The app-context slug for the app the user is dictating into, read when
/// dictation stops (the frontmost app is the paste target). None when the
/// frontmost app is not a recognized context or cannot be determined.
#[cfg(target_os = "macos")]
fn frontmost_app_context() -> Option<String> {
    let bundle_id = frontmost_bundle_id()?;
    is_email_app_bundle(&bundle_id).then(|| APP_CONTEXT_EMAIL.to_string())
}

#[cfg(not(target_os = "macos"))]
fn frontmost_app_context() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn frontmost_bundle_id() -> Option<String> {
    let workspace = objc2_app_kit::NSWorkspace::sharedWorkspace();
    let front = workspace.frontmostApplication()?;
    let bundle_id = front.bundleIdentifier()?;
    Some(bundle_id.to_string())
}

async fn dictionary_context_for_app(app: &AppHandle) -> Option<String> {
    let repos = crate::commands::repositories(app).await.ok()?;
    let entries = repos.list_dictionary_entries().await.ok()?;
    build_dictionary_context(&entries)
}

async fn maybe_cleanup_dictation_result(
    app: &AppHandle,
    provider: &str,
    result: Result<TranscriptionProviderResult, AppError>,
    dictionary_context: Option<String>,
    app_context: Option<String>,
    style: DictationStyle,
    session_id: String,
    utterance_id: String,
) -> Result<TranscriptionProviderResult, AppError> {
    let mut transcript = match result {
        Ok(transcript) => transcript,
        Err(error) => return Err(error),
    };
    let transcript_bytes = transcript.text.trim().len();
    tracing::info!(
        provider,
        style = ?style,
        app_context = app_context.as_deref(),
        transcript_bytes,
        timeout_ms = dictation_cleanup_timeout(transcript_bytes).as_millis() as u64,
        "dictation cleanup starting",
    );
    let started_at = Instant::now();
    match cleanup_dictation_text(
        &transcript.text,
        dictionary_context.as_deref(),
        app_context,
        style,
        session_id,
        utterance_id,
    )
    .await
    {
        Ok(cleaned) => {
            if !cleaned.trim().is_empty() {
                transcript.text = cleaned;
                tracing::info!(
                    provider,
                    elapsed_ms = started_at.elapsed().as_millis() as u64,
                    "dictation cleanup applied",
                );
            }
        }
        Err(error) => {
            emit_dictation_cleanup_skipped(
                app,
                provider,
                &error,
                transcript_bytes,
                started_at.elapsed(),
            );
        }
    }
    Ok(transcript)
}

/// Budget for one cleanup round-trip, scaled to the transcript so long
/// dictations get the generation time they need instead of silently falling
/// back to raw ASR text. Byte length is a fine proxy: multibyte scripts also
/// cost more tokens to regenerate.
fn dictation_cleanup_timeout(text_bytes: usize) -> Duration {
    let scaled = DICTATION_CLEANUP_BASE_TIMEOUT_MS
        .saturating_add((text_bytes as u64).saturating_mul(DICTATION_CLEANUP_TIMEOUT_MS_PER_BYTE));
    Duration::from_millis(scaled.min(DICTATION_CLEANUP_MAX_TIMEOUT_MS))
}

async fn cleanup_dictation_text(
    text: &str,
    dictionary_context: Option<&str>,
    app_context: Option<String>,
    style: DictationStyle,
    session_id: String,
    utterance_id: String,
) -> Result<String, AppError> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(String::new());
    }
    let chunks = split_dictation_cleanup_chunks(text, DICTATION_CLEANUP_CHUNK_TARGET_BYTES);
    if chunks.len() == 1 {
        return match tokio::time::timeout(
            dictation_cleanup_timeout(text.len()).min(Duration::from_millis(
                DICTATION_CLEANUP_REQUEST_MAX_TIMEOUT_MS,
            )),
            cleanup_dictation_call(
                text,
                dictionary_context,
                app_context,
                style,
                session_id,
                utterance_id,
            ),
        )
        .await
        {
            Ok(result) => Ok(trim_cleaned_dictation(&result?)),
            Err(_) => Err(AppError::new(
                "dictation_cleanup_timeout",
                "Dictation cleanup timed out.",
            )),
        };
    }
    cleanup_dictation_chunks(
        &chunks,
        dictionary_context,
        app_context,
        style,
        session_id,
        utterance_id,
    )
    .await
}

/// Clean a long transcript through `/v1/dictate/cleanup` a word-boundary
/// chunk at a time and rejoin the results. The cleanup model reliably
/// punctuates short passages but degrades into an unpunctuated verbatim echo
/// on long run-on speech (JUN-212). Each chunk gets its own utterance id
/// suffix so metering treats it as its own unit of work.
///
/// Chunks that already cleaned up are never discarded: they were billed, so
/// their output must reach the paste. Running out of the shared deadline or
/// hitting a transport error mid-batch degrades the affected chunk and the
/// rest to their raw text. Only an error before any chunk succeeds fails the
/// whole cleanup (the caller's raw-transcript fallback, as before).
async fn cleanup_dictation_chunks(
    chunks: &[&str],
    dictionary_context: Option<&str>,
    app_context: Option<String>,
    style: DictationStyle,
    session_id: String,
    utterance_id: String,
) -> Result<String, AppError> {
    let total_bytes: usize = chunks.iter().map(|chunk| chunk.len()).sum();
    let deadline = Instant::now() + dictation_cleanup_timeout(total_bytes);
    let chunk_count = chunks.len();
    let mut cleaned_chunks: Vec<String> = Vec::with_capacity(chunk_count);
    let mut raw_chunks = 0usize;
    let mut any_cleaned = false;
    for (index, chunk) in chunks.iter().enumerate() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            raw_chunks += 1;
            cleaned_chunks.push((*chunk).to_string());
            continue;
        }
        let chunk_utterance_id = format!("{utterance_id}-c{index}");
        // Bounded by both the batch deadline and the per-request billing
        // hold cap (the chunk budget covers at most two small requests).
        let chunk_budget = remaining.min(Duration::from_millis(
            DICTATION_CLEANUP_REQUEST_MAX_TIMEOUT_MS,
        ));
        match tokio::time::timeout(
            chunk_budget,
            cleanup_dictation_chunk_with_retry(
                chunk,
                dictionary_context,
                app_context.clone(),
                style,
                session_id.clone(),
                chunk_utterance_id,
            ),
        )
        .await
        {
            Ok(Ok(cleaned)) => {
                any_cleaned = true;
                cleaned_chunks.push(trim_cleaned_dictation_chunk(&cleaned));
            }
            Ok(Err(error)) => {
                // Nothing cleaned yet: fail the whole cleanup so the caller
                // emits the skip event and pastes the raw transcript.
                if !any_cleaned {
                    return Err(error);
                }
                // Mid-batch failure after billed successes: keep the cleaned
                // chunks and degrade this one and the rest to raw. Retrying
                // the remainder against a failing backend would only burn
                // the deadline.
                tracing::warn!(
                    code = %error.code,
                    chunk_index = index,
                    "dictation cleanup chunk failed mid-batch; keeping raw for the rest",
                );
                for rest in &chunks[index..] {
                    raw_chunks += 1;
                    cleaned_chunks.push((*rest).to_string());
                }
                break;
            }
            Err(_) => {
                // This chunk ran out of its budget (the batch deadline or the
                // per-request cap): keep it raw and move on. Chunks that
                // already cleaned up are preserved; later chunks still get
                // whatever batch budget is left.
                tracing::warn!(
                    chunk_index = index,
                    chunk_bytes = chunk.len(),
                    "dictation cleanup chunk timed out; keeping raw chunk",
                );
                raw_chunks += 1;
                cleaned_chunks.push((*chunk).to_string());
            }
        }
    }
    if raw_chunks > 0 {
        tracing::warn!(
            chunk_count,
            raw_chunks,
            "dictation cleanup degraded; some chunks pasted raw",
        );
    }
    tracing::info!(chunk_count, raw_chunks, "dictation cleanup ran chunked");
    Ok(join_cleaned_dictation_chunks(&cleaned_chunks))
}

/// Trim a single-call cleanup result (the historical behavior).
fn trim_cleaned_dictation(cleaned: &str) -> String {
    cleaned.trim().to_string()
}

/// Trim a cleaned chunk for joining: drop surrounding spaces but keep
/// newlines on either edge, so a line or paragraph break the model placed at
/// a chunk boundary survives the join whether it landed at the end of one
/// chunk or the start of the next.
fn trim_cleaned_dictation_chunk(cleaned: &str) -> String {
    cleaned
        .trim_start_matches([' ', '\t'])
        .trim_end_matches([' ', '\t'])
        .to_string()
}

/// Join cleaned chunks with a single space, except across a boundary that
/// already carries a line break (a space would indent the line) or where the
/// next chunk starts with punctuation that attaches to the previous word
/// (a spoken "comma" or "period" right after the split point).
fn join_cleaned_dictation_chunks(chunks: &[String]) -> String {
    let mut joined = String::new();
    for chunk in chunks {
        if chunk.is_empty() {
            continue;
        }
        if !joined.is_empty()
            && !joined.ends_with('\n')
            && !chunk.starts_with('\n')
            && !chunk.starts_with([',', '.', '!', '?', ':', ';', ')', ']'])
        {
            joined.push(' ');
        }
        joined.push_str(chunk);
    }
    joined
}

/// One chunk of a chunked cleanup. Transport errors propagate to the caller,
/// which keeps any already-cleaned chunks and degrades the rest to raw.
/// Content-quality failures get one retry — the provider is not deterministic
/// even at temperature 0, and a retry usually punctuates a chunk the first
/// attempt echoed — then degrade to the raw chunk so one bad chunk never
/// costs the rest of the dictation its cleanup.
async fn cleanup_dictation_chunk_with_retry(
    chunk: &str,
    dictionary_context: Option<&str>,
    app_context: Option<String>,
    style: DictationStyle,
    session_id: String,
    chunk_utterance_id: String,
) -> Result<String, AppError> {
    let first = cleanup_dictation_call(
        chunk,
        dictionary_context,
        app_context.clone(),
        style,
        session_id.clone(),
        chunk_utterance_id.clone(),
    )
    .await;
    // A distinct utterance id: the retry wants a fresh model completion, so
    // it must not share the first attempt's idempotency identity.
    let retry_utterance_id = format!("{chunk_utterance_id}r");
    match first {
        Ok(cleaned) if !cleaned_chunk_lacks_sentence_punctuation(chunk, &cleaned) => Ok(cleaned),
        Ok(unpunctuated) => {
            match cleanup_dictation_call(
                chunk,
                dictionary_context,
                app_context,
                style,
                session_id,
                retry_utterance_id,
            )
            .await
            {
                Ok(retried) if !cleaned_chunk_lacks_sentence_punctuation(chunk, &retried) => {
                    Ok(retried)
                }
                // Keep the first attempt: unpunctuated but still cleaned
                // (fillers stripped) beats both raw text and failing the
                // whole dictation's cleanup over one stubborn chunk.
                _ => {
                    tracing::warn!(
                        chunk_bytes = chunk.len(),
                        "dictation cleanup chunk still unpunctuated after retry",
                    );
                    Ok(unpunctuated)
                }
            }
        }
        Err(error)
            if error.code == "provider_response_invalid"
                || error.code == "dictation_cleanup_invalid" =>
        {
            match cleanup_dictation_call(
                chunk,
                dictionary_context,
                app_context,
                style,
                session_id,
                retry_utterance_id,
            )
            .await
            {
                Ok(retried) => Ok(retried),
                Err(retry_error) => {
                    if retry_error.code == "provider_response_invalid"
                        || retry_error.code == "dictation_cleanup_invalid"
                    {
                        // The model refused this chunk twice; keep the
                        // speaker's words raw rather than dropping them or
                        // failing the whole dictation's cleanup.
                        tracing::warn!(
                            code = %retry_error.code,
                            chunk_bytes = chunk.len(),
                            "dictation cleanup chunk kept raw after retry",
                        );
                        Ok(chunk.to_string())
                    } else {
                        Err(retry_error)
                    }
                }
            }
        }
        Err(error) => Err(error),
    }
}

/// One `/v1/dictate/cleanup` round-trip plus content-quality checks.
async fn cleanup_dictation_call(
    text: &str,
    dictionary_context: Option<&str>,
    app_context: Option<String>,
    style: DictationStyle,
    session_id: String,
    utterance_id: String,
) -> Result<String, AppError> {
    let cleaned = cleanup_text(DictateCleanupRequestParams {
        text: text.to_string(),
        dictionary_context: dictionary_context.map(str::to_string),
        app_context,
        style: style.instruction().to_string(),
        session_id,
        utterance_id,
    })
    .await?;
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return Err(AppError::new(
            "provider_response_invalid",
            "Dictation cleanup response did not contain text output.",
        ));
    }
    if looks_like_instruction_response(trimmed) {
        return Err(AppError::new(
            "dictation_cleanup_invalid",
            "Dictation cleanup returned an instruction response.",
        ));
    }
    // Callers trim for their context: fully for a single-call cleanup,
    // newline-preserving for chunks about to be joined.
    Ok(cleaned)
}

/// Split a transcript into cleanup-sized chunks at whitespace boundaries.
/// Short transcripts come back as a single borrowed chunk (the exact input),
/// keeping the single-call path byte-identical to the unchunked behavior.
/// A chunk may run past the target until the next whitespace; text with no
/// whitespace at all (e.g. unsegmented CJK) stays one chunk.
fn split_dictation_cleanup_chunks(text: &str, target_bytes: usize) -> Vec<&str> {
    if text.len() <= target_bytes {
        return vec![text];
    }
    let mut chunks = Vec::new();
    let mut chunk_start = 0;
    let mut last_whitespace: Option<usize> = None;
    for (index, character) in text.char_indices() {
        if character.is_whitespace() {
            last_whitespace = Some(index);
        }
        if index - chunk_start >= target_bytes {
            if let Some(cut) = last_whitespace.filter(|cut| *cut > chunk_start) {
                chunks.push(text[chunk_start..cut].trim());
                chunk_start = cut + character_width_at(text, cut);
                last_whitespace = None;
            }
        }
    }
    if chunk_start < text.len() {
        let tail = text[chunk_start..].trim();
        if !tail.is_empty() {
            chunks.push(tail);
        }
    }
    if chunks.is_empty() {
        vec![text]
    } else {
        chunks
    }
}

fn character_width_at(text: &str, index: usize) -> usize {
    text[index..].chars().next().map_or(1, char::len_utf8)
}

/// Whether a cleaned chunk came back without any sentence punctuation at a
/// size where some is clearly expected — the JUN-212 failure shape, where the
/// model echoes long run-on speech verbatim instead of punctuating it.
fn cleaned_chunk_lacks_sentence_punctuation(chunk_input: &str, cleaned: &str) -> bool {
    chunk_input.len() >= DICTATION_CLEANUP_RETRY_MIN_CHUNK_BYTES
        && !cleaned.contains(['.', '!', '?', ':', ';', '\n', '。', '！', '？'])
}

/// The paste falls back to the raw ASR transcript when cleanup fails, so this
/// warn line (with the transcript size and how long the attempt ran) is the
/// only trace that the pasted text skipped punctuation and filler cleanup.
fn emit_dictation_cleanup_skipped(
    app: &AppHandle,
    provider: &str,
    error: &AppError,
    transcript_bytes: usize,
    elapsed: Duration,
) {
    tracing::warn!(
        provider,
        code = %error.code,
        message = %error.message,
        transcript_bytes,
        elapsed_ms = elapsed.as_millis() as u64,
        "dictation cleanup skipped; pasting raw transcript",
    );
    emit_dictation_event_value(
        app,
        serde_json::json!({
            "type": "dictation_cleanup_skipped",
            "payload": {
                "provider": provider,
                "code": &error.code,
                "message": &error.message,
            },
        }),
    );
}

fn looks_like_instruction_response(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    looks_like_report_summary_response(&normalized)
        || normalized.starts_with("sure")
        || looks_like_here_prefaced_instruction_response(&normalized)
        || normalized.starts_with("summary:")
        || normalized.starts_with("the transcript ")
        || normalized.starts_with("the user expresses")
        || normalized.starts_with("the user did")
        || normalized.starts_with("the user asks")
        || normalized.starts_with("i can")
        || normalized.starts_with("i'll")
        || normalized.starts_with("i will")
        || normalized.contains(" the transcript ")
        || normalized.contains(" the user expresses")
        || normalized.contains(" the user did")
        || normalized.contains(" the user asks")
        || normalized.contains(" did not ask ")
        || normalized.contains(" only shared ")
        || normalized.contains(" writing style ")
        || normalized.contains(" tone is ")
        || normalized.contains(" filler sounds ")
        || normalized.contains(" custom terms ")
        || normalized.contains(" spelled correctly ")
        || normalized.contains("rewritten text")
        || normalized.contains("normalized transcript")
}

fn looks_like_here_prefaced_instruction_response(normalized: &str) -> bool {
    let normalized = normalized.replace('’', "'");
    let normalized = normalized.as_str();
    let structural_preamble_end = [":", "\n", " - ", " — ", " – ", "—", "–"]
        .iter()
        .filter_map(|separator| normalized.find(separator))
        .min();
    if structural_preamble_end.is_some_and(|end| is_here_instruction_preamble(&normalized[..end])) {
        return true;
    }
    let punctuation_preamble_end = [". ", "! ", "? "]
        .iter()
        .filter_map(|separator| normalized.find(separator))
        .min();
    if punctuation_preamble_end
        .is_some_and(|end| is_terminal_here_instruction_preamble(&normalized[..end]))
    {
        return true;
    }
    if normalized
        .find(", ")
        .is_some_and(|end| is_here_instruction_preamble(&normalized[..end]))
    {
        return true;
    }
    is_terminal_here_instruction_preamble(normalized)
}

fn is_here_instruction_preamble(preamble: &str) -> bool {
    let preamble = preamble.trim_end_matches(['.', '!', '?']).trim_end();
    if is_generic_here_instruction_preamble(preamble) {
        return true;
    }
    let Some(subject) = ["here is ", "here's ", "here are "]
        .iter()
        .find_map(|prefix| preamble.strip_prefix(prefix))
    else {
        return false;
    };
    subject
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|word| {
            is_here_instruction_subject_marker(word) || is_here_instruction_cleanup_modifier(word)
        })
}

fn is_terminal_here_instruction_preamble(normalized: &str) -> bool {
    let preamble = normalized.trim_end_matches(['.', '!', '?']).trim_end();
    if is_generic_here_instruction_preamble(preamble) {
        return true;
    }
    let Some(subject) = ["here is ", "here's ", "here are "]
        .iter()
        .find_map(|prefix| preamble.strip_prefix(prefix))
    else {
        return false;
    };
    let words: Vec<&str> = subject
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect();
    words.iter().copied().any(|word| {
        is_here_instruction_subject_marker(word) || is_here_instruction_cleanup_modifier(word)
    }) && words.iter().all(|word| {
        is_here_instruction_subject_marker(word)
            || is_here_instruction_cleanup_modifier(word)
            || matches!(*word, "a" | "an" | "the" | "up")
    })
}

fn is_here_instruction_subject_marker(word: &str) -> bool {
    matches!(
        word,
        "transcript"
            | "transcription"
            | "dictation"
            | "text"
            | "notes"
            | "version"
            | "result"
            | "content"
            | "output"
            | "message"
            | "email"
            | "response"
            | "copy"
            | "draft"
            | "improvements"
            | "rewrite"
    )
}

fn is_here_instruction_cleanup_modifier(word: &str) -> bool {
    matches!(
        word,
        "clean" | "cleaned" | "corrected" | "normalized" | "punctuated" | "rewritten"
    )
}

fn is_generic_here_instruction_preamble(preamble: &str) -> bool {
    if matches!(
        preamble,
        "here you go"
            | "here it is"
            | "here you are"
            | "here is what i heard"
            | "here's what i heard"
            | "here is what i got"
            | "here's what i got"
            | "here is what you said"
            | "here's what you said"
    ) {
        return true;
    }
    preamble.starts_with("here, i")
        && preamble
            .split(|character: char| !character.is_ascii_alphanumeric())
            .any(|word| {
                matches!(
                    word,
                    "cleaned" | "corrected" | "normalized" | "punctuated" | "rewritten"
                )
            })
}

fn looks_like_report_summary_response(normalized: &str) -> bool {
    normalized.starts_with("bug report assessment")
        || normalized.starts_with("user report summary")
        || normalized.starts_with("what likely happened")
        || normalized.starts_with("likely affected component")
        || normalized.starts_with("notes for the team")
        || normalized.contains(" user report summary")
        || normalized.contains(" bug report assessment")
        || normalized.contains(" what likely happened")
        || normalized.contains(" likely affected component")
        || normalized.contains(" notes for the team")
        || ((normalized.starts_with("user performed ")
            || normalized.starts_with("user reported ")
            || normalized.starts_with("the user performed")
            || normalized.starts_with("the user reported"))
            && (normalized.contains("long dictation")
                || normalized.contains("instead of producing")
                || normalized.contains("summary-like")
                || normalized.contains("transcription pipeline")))
}

fn spawn_dictation_history_write(app: AppHandle, transcript: TranscriptionProviderResult) {
    tauri::async_runtime::spawn(async move {
        store_dictation_history_item(&app, &transcript).await;
    });
}

fn recording_ready_info_from_event(
    event: &serde_json::Value,
) -> Result<RecordingReadyInfo, AppError> {
    let path = event
        .get("payload")
        .and_then(|payload| payload.get("path"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            AppError::new(
                "dictation_recording_path_missing",
                "Dictation helper did not provide a recording path.",
            )
        })?;
    Ok(RecordingReadyInfo {
        audio_path: PathBuf::from(path),
        observed_audio_level: observed_audio_level_from_event(event),
        target_bundle_id: event
            .get("payload")
            .and_then(|payload| payload.get("targetBundleIdentifier"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|bundle_id| !bundle_id.is_empty())
            .map(str::to_string),
    })
}

fn observed_audio_level_from_event(event: &serde_json::Value) -> Option<f32> {
    let value = event
        .get("payload")
        .and_then(|payload| payload.get("observedAudioLevel"))?;
    let level = value
        .as_f64()
        .map(|level| level as f32)
        .or_else(|| value.as_str().and_then(|level| level.parse::<f32>().ok()))?;
    if level.is_finite() {
        Some(level)
    } else {
        None
    }
}

#[derive(Debug)]
struct DictationTranscriptionOutcome {
    helper_command: serde_json::Value,
    event: Option<serde_json::Value>,
    transcript: Option<TranscriptionProviderResult>,
}

#[derive(Debug)]
struct RecordingReadyInfo {
    audio_path: PathBuf,
    observed_audio_level: Option<f32>,
    /// Bundle id of the paste target the helper pinned when the recording
    /// stopped: the same app it will paste into once we hand back a
    /// transcript. None with older helper builds that predate the field.
    target_bundle_id: Option<String>,
}

fn outcome_from_transcription_result(
    result: Result<TranscriptionProviderResult, AppError>,
    observed_audio_level: Option<f32>,
    style: DictationStyle,
) -> DictationTranscriptionOutcome {
    match result {
        Ok(mut transcript) => {
            let had_speech_before_cleaning = !transcript.text.trim().is_empty();
            transcript.text = clean_dictation_fillers(&transcript.text, style);
            if had_speech_before_cleaning && transcript.text.trim().is_empty() {
                // Filler-only capture (e.g. "Um, uh."): the provider DID return
                // speech that we stripped to nothing. Discard quietly with a
                // silent no_speech event, regardless of the observed audio
                // level — the audio-detected-but-no-text error is meant for
                // genuine silence misheard as loud audio, not for fillers.
                return DictationTranscriptionOutcome {
                    helper_command: serde_json::json!({ "type": "discard_recording" }),
                    event: Some(silent_no_speech_event()),
                    transcript: None,
                };
            }
            outcome_from_clean_transcript(transcript, observed_audio_level)
        }
        Err(error) => {
            let event = promote_silent_error_if_audio_detected(
                app_error_event(error),
                observed_audio_level,
            );
            DictationTranscriptionOutcome {
                helper_command: serde_json::json!({ "type": "discard_recording" }),
                event: Some(event),
                transcript: None,
            }
        }
    }
}

fn outcome_from_clean_transcript(
    transcript: TranscriptionProviderResult,
    observed_audio_level: Option<f32>,
) -> DictationTranscriptionOutcome {
    match transcript {
        // Recorded silence / nothing to type is not a failure — discard quietly
        // and emit a `no_speech` event (classified silent, so the HUD just
        // dismisses instead of flashing an error). Don't store an empty item.
        transcript if transcript.text.trim().is_empty() => DictationTranscriptionOutcome {
            helper_command: serde_json::json!({ "type": "discard_recording" }),
            event: Some(no_text_event_for_observed_audio(observed_audio_level)),
            transcript: None,
        },
        transcript if looks_like_instruction_response(&transcript.text) => {
            DictationTranscriptionOutcome {
                helper_command: serde_json::json!({ "type": "discard_recording" }),
                event: Some(serde_json::json!({
                    "type": "error",
                    "payload": {
                        "code": "dictation_response_invalid",
                        "message": "Dictation returned a summary instead of dictated text. Try again.",
                    },
                })),
                transcript: None,
            }
        }
        transcript => {
            if let Some(prompt) = agent_session_prompt_from_dictation(&transcript.text) {
                DictationTranscriptionOutcome {
                    helper_command: serde_json::json!({ "type": "discard_recording" }),
                    event: Some(serde_json::json!({
                        "type": "agent_session_prompt",
                        "payload": { "prompt": prompt },
                    })),
                    transcript: Some(transcript),
                }
            } else {
                DictationTranscriptionOutcome {
                    helper_command: serde_json::json!({
                        "type": "paste_text",
                        "text": transcript.text.clone(),
                    }),
                    event: None,
                    transcript: Some(transcript),
                }
            }
        }
    }
}

fn clean_dictation_fillers(text: &str, style: DictationStyle) -> String {
    let text = text.trim();
    if text.is_empty() {
        return String::new();
    }

    let stripped = remove_standalone_fillers(text);
    let cleaned = normalize_after_filler_removal(&stripped.text, stripped.removed);
    if stripped.removed && !contains_meaningful_dictation_word(&cleaned) {
        String::new()
    } else if stripped.removed_leading && style.capitalizes_sentence_starts() {
        // The transcript capitalized the leading filler ("Um, can you…"), so
        // once it's stripped the surviving first word would start lowercase.
        // Restore the capital — but only when the filler actually led the
        // transcript (a mid-sentence filler must not touch a brand/code token
        // like "iPhone"), and only for styles that capitalize sentence starts
        // so we never fight CasualLowercase. Mid-sentence sentence-starts are
        // left as-is; reflowing those is the LLM cleanup pass's job, not this
        // deterministic backstop's.
        capitalize_leading_letter(&cleaned)
    } else {
        cleaned
    }
}

/// Uppercase the first character when it's a lowercase letter, leaving
/// everything else (already-capitalized words, leading punctuation, digits)
/// untouched. Unicode-aware, so accented starts like "é" capitalize too.
fn capitalize_leading_letter(text: &str) -> String {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return text.to_string();
    };
    if !first.is_lowercase() {
        return text.to_string();
    }
    let mut output = String::with_capacity(text.len());
    output.extend(first.to_uppercase());
    output.push_str(chars.as_str());
    output
}

fn remove_standalone_fillers(text: &str) -> RemovedFillers {
    let mut output = String::with_capacity(text.len());
    let mut removed = false;
    let mut removed_leading = false;
    let mut emitted_word = false;
    let mut needs_word_boundary = false;
    let mut index = 0;

    while index < text.len() {
        let Some(ch) = text[index..].chars().next() else {
            break;
        };

        if !ch.is_ascii_alphabetic() {
            // Honor a pending boundary here too: a filler can be followed by a
            // digit or opening quote/paren (e.g. "um 3", "um \"hi\""), which
            // must keep the separating space the filler removal swallowed.
            if needs_word_boundary && !ch.is_whitespace() && !output.is_empty() {
                output.push(' ');
            }
            needs_word_boundary = false;
            output.push(ch);
            index += ch.len_utf8();
            continue;
        }

        let start = index;
        index += ch.len_utf8();
        while index < text.len() {
            let Some(next) = text[index..].chars().next() else {
                break;
            };
            if !next.is_ascii_alphabetic() {
                break;
            }
            index += next.len_utf8();
        }

        let word = &text[start..index];
        let previous = text[..start].chars().next_back();
        let next = text[index..].chars().next();
        if is_dictation_filler_word(word) && previous != Some('-') && next != Some('-') {
            removed = true;
            // A filler removed before any real word means the transcript led
            // with it ("Um, …"); that's the only case where re-capitalizing the
            // surviving first word is correct.
            if !emitted_word {
                removed_leading = true;
            }
            trim_soft_filler_prefix(&mut output);
            // Removing a filler swallows the whitespace on both sides of it, so
            // re-insert a separator before the next word. A standalone filler
            // sentence ("… Um. …") leaves the prior sentence's terminal
            // punctuation as the last char, so guard on that too — otherwise
            // "Send it. Um. Now." would collapse to "Send it.Now.".
            needs_word_boundary = output
                .chars()
                .next_back()
                .is_some_and(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '!' | '?'));
            index = skip_soft_filler_suffix(text, index);
        } else {
            if needs_word_boundary && !output.ends_with(' ') && !output.is_empty() {
                output.push(' ');
            }
            needs_word_boundary = false;
            emitted_word = true;
            output.push_str(word);
        }
    }

    RemovedFillers {
        text: output,
        removed,
        removed_leading,
    }
}

struct RemovedFillers {
    text: String,
    /// Any standalone filler was stripped.
    removed: bool,
    /// A filler led the transcript and was stripped, exposing a new first word.
    removed_leading: bool,
}

fn trim_soft_filler_prefix(output: &mut String) {
    while output.chars().next_back().is_some_and(char::is_whitespace) {
        output.pop();
    }
    if output.ends_with(',') || output.ends_with(':') || output.ends_with(';') {
        output.pop();
    }
    while output.chars().next_back().is_some_and(char::is_whitespace) {
        output.pop();
    }
}

fn skip_soft_filler_suffix(text: &str, mut index: usize) -> usize {
    while index < text.len() {
        let Some(ch) = text[index..].chars().next() else {
            break;
        };
        if ch.is_whitespace() || matches!(ch, ',' | ':' | ';' | '.' | '!' | '?') {
            index += ch.len_utf8();
        } else {
            break;
        }
    }
    index
}

fn normalize_after_filler_removal(text: &str, removed_filler: bool) -> String {
    let mut normalized = collapse_dictation_whitespace(text);
    if removed_filler {
        normalized = normalized
            .trim_start_matches(|ch: char| ch.is_whitespace() || matches!(ch, ',' | ':' | ';'))
            .trim()
            .to_string();
    }
    normalized
}

/// Collapse runs of horizontal whitespace to a single space, but preserve line
/// breaks (and a single blank line between paragraphs). The cleanup prompt now
/// emits paragraph-grouped, line-broken text, and spoken "new line" formatting
/// becomes real breaks — flattening all whitespace would paste/store those as
/// one flat line.
fn collapse_dictation_whitespace(text: &str) -> String {
    let mut lines: Vec<String> = text
        .split('\n')
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect();
    while lines.first().is_some_and(String::is_empty) {
        lines.remove(0);
    }
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    let mut collapsed: Vec<String> = Vec::with_capacity(lines.len());
    let mut previous_blank = false;
    for line in lines {
        let blank = line.is_empty();
        if blank && previous_blank {
            continue;
        }
        previous_blank = blank;
        collapsed.push(line);
    }
    collapsed.join("\n")
}

fn contains_meaningful_dictation_word(text: &str) -> bool {
    let mut index = 0;
    while index < text.len() {
        let Some(ch) = text[index..].chars().next() else {
            break;
        };
        // Digits are meaningful on their own — an OTP, extension, or amount
        // dictated after a hesitation ("um 123456") must still paste, not
        // discard as if it were filler-only.
        if ch.is_ascii_digit() {
            return true;
        }
        if !ch.is_ascii_alphabetic() {
            index += ch.len_utf8();
            continue;
        }
        let start = index;
        index += ch.len_utf8();
        while index < text.len() {
            let Some(next) = text[index..].chars().next() else {
                break;
            };
            if !next.is_ascii_alphabetic() {
                break;
            }
            index += next.len_utf8();
        }
        let word = &text[start..index];
        if !is_dictation_filler_word(word) && !is_dictation_connector_word(word) {
            return true;
        }
    }
    false
}

fn is_dictation_filler_word(word: &str) -> bool {
    // An all-caps multi-letter token is almost certainly a dictated acronym
    // (e.g. "ER"), not a hesitation — keep it. The capitalized hesitation form
    // ("Er, no.") isn't all-caps, so it still strips.
    if word.len() >= 2 && word.chars().all(|ch| ch.is_ascii_uppercase()) {
        return false;
    }
    matches!(
        word.to_ascii_lowercase().as_str(),
        "um" | "ums"
            | "umm"
            | "ummm"
            | "uh"
            | "uhs"
            | "uhh"
            | "uhhh"
            | "er"
            | "erm"
            | "ah"
            | "ahh"
            | "hmm"
            | "hm"
    )
}

fn is_dictation_connector_word(word: &str) -> bool {
    matches!(word.to_ascii_lowercase().as_str(), "and" | "or" | "then")
}

fn no_text_event_for_observed_audio(observed_audio_level: Option<f32>) -> serde_json::Value {
    if probable_speech_detected(observed_audio_level) {
        return audio_detected_but_no_text_event(None, None, observed_audio_level);
    }
    silent_no_speech_event()
}

fn silent_no_speech_event() -> serde_json::Value {
    serde_json::json!({
        "type": "error",
        "payload": { "code": "no_speech", "message": "No speech detected." },
    })
}

fn promote_silent_error_if_audio_detected(
    event: serde_json::Value,
    observed_audio_level: Option<f32>,
) -> serde_json::Value {
    if probable_speech_detected(observed_audio_level) && is_silent_transcription_error(&event) {
        let payload = event.get("payload");
        let underlying_code = payload
            .and_then(|payload| payload.get("code"))
            .and_then(serde_json::Value::as_str);
        let underlying_message = payload
            .and_then(|payload| payload.get("message"))
            .and_then(serde_json::Value::as_str);
        return audio_detected_but_no_text_event(
            underlying_code,
            underlying_message,
            observed_audio_level,
        );
    }
    event
}

fn audio_detected_but_no_text_event(
    underlying_code: Option<&str>,
    underlying_message: Option<&str>,
    observed_audio_level: Option<f32>,
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "code": "dictation_audio_without_text",
        "message": "Dictation detected audio but produced no text. Try again.",
    });
    if let Some(level) = observed_audio_level {
        payload["observedAudioLevel"] = serde_json::json!(level);
    }
    if let Some(code) = underlying_code {
        payload["underlyingCode"] = serde_json::json!(code);
    }
    if let Some(message) = underlying_message {
        payload["underlyingMessage"] = serde_json::json!(message);
    }
    serde_json::json!({
        "type": "error",
        "payload": payload,
    })
}

fn probable_speech_detected(observed_audio_level: Option<f32>) -> bool {
    observed_audio_level.is_some_and(|level| level >= DICTATION_AUDIO_ACTIVITY_THRESHOLD)
}

fn agent_session_prompt_from_dictation(text: &str) -> Option<String> {
    let trimmed = text.trim_start();
    let (first, after_first) = take_ascii_word(trimmed)?;
    if !first.eq_ignore_ascii_case("hey") {
        return None;
    }
    let after_first = skip_word_separators(after_first);
    let (second, after_second) = take_ascii_word(after_first)?;
    if !is_agent_session_wake_name(second) {
        return None;
    }
    Some(skip_word_separators(after_second).trim().to_string())
}

fn is_agent_session_wake_name(word: &str) -> bool {
    ["june", "jun", "joon"]
        .iter()
        .any(|variant| word.eq_ignore_ascii_case(variant))
}

fn take_ascii_word(value: &str) -> Option<(&str, &str)> {
    let end = value
        .char_indices()
        .take_while(|(_, ch)| ch.is_ascii_alphabetic())
        .map(|(index, ch)| index + ch.len_utf8())
        .last()?;
    Some(value.split_at(end))
}

fn skip_word_separators(value: &str) -> &str {
    value.trim_start_matches(|ch: char| ch.is_ascii_whitespace() || ch.is_ascii_punctuation())
}

async fn store_dictation_history_item(app: &AppHandle, transcript: &TranscriptionProviderResult) {
    match crate::commands::repositories(app).await {
        Ok(repos) => {
            if let Err(error) = repos
                .create_dictation_history_item(
                    &transcript.text,
                    transcript.language.clone(),
                    &transcript.provider,
                )
                .await
            {
                eprintln!("[dictation] history save failed: {error}");
            }
        }
        Err(error) => {
            eprintln!(
                "[dictation] history unavailable code={} message={}",
                error.code, error.message
            );
        }
    }
}

fn app_error_event(error: AppError) -> serde_json::Value {
    serde_json::json!({
        "type": "error",
        "payload": {
            "code": error.code,
            "message": error.message,
        },
    })
}

fn emit_dictation_event_value(app: &AppHandle, mut event: serde_json::Value) {
    annotate_silent_error(&mut event);
    let event_type = event.get("type").and_then(serde_json::Value::as_str);
    sync_capture_mic_duck(event_type);
    append_dictation_event_log(app, event_type, &event);
    let line = event.to_string();
    update_latest_event(app, event_type, Some(line.clone()));
    update_hud_window(app, event_type, Some(&event));
    let _ = app.emit("dictation-event", line);
}

/// Keeps a live meeting recording's microphone out of the dictation's way:
/// while the helper listens, the user's voice belongs to the dictation, not
/// the note, so the capture's mic channel is ducked (silence-filled, keeping
/// the mic and system tracks aligned — see capture::set_mic_ducked) and
/// restored the moment listening ends, HOWEVER it ends. Every helper event
/// funnels through emit_dictation_event_value, so this is the single seam.
fn sync_capture_mic_duck(event_type: Option<&str>) {
    if let Some(ducked) = mic_duck_action_for_event(event_type) {
        crate::audio::capture::set_mic_ducked(ducked);
    }
}

/// The duck decision for a helper event: `Some(true)` starts a duck (listening
/// began), `Some(false)` lifts it (listening ended, however it ended),
/// `None` leaves the current state untouched. The un-duck set is deliberately
/// broad — every terminal, finalizing, or post-listening event lifts the duck
/// — because a leaked duck would silently swallow the rest of the meeting's
/// mic track, and re-lifting an already-lifted duck is a harmless no-op.
/// Intermediate events like `audio_level` return `None` so the duck holds for
/// the whole listening window. System audio is never touched.
fn mic_duck_action_for_event(event_type: Option<&str>) -> Option<bool> {
    match event_type {
        Some("listening_started") => Some(true),
        Some(
            "recording_ready"
            | "recording_discarded"
            | "finalizing_transcript"
            | "final_transcript"
            | "paste_completed"
            | "error"
            | "helper_unavailable"
            | "shutdown_ack",
        ) => Some(false),
        _ => None,
    }
}

fn append_dictation_event_log(
    app: &AppHandle,
    event_type: Option<&str>,
    event: &serde_json::Value,
) {
    let Some(event_type) = event_type else {
        return;
    };
    if event_type == "audio_level" {
        return;
    }
    let entry = dictation_event_log_entry(event_type, event);
    let Ok(directory) = crate::app_paths::app_data_dir(app) else {
        return;
    };
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join(DICTATION_EVENT_LOG))
    else {
        return;
    };
    let _ = writeln!(file, "{entry}");
}

fn dictation_event_log_entry(event_type: &str, event: &serde_json::Value) -> serde_json::Value {
    let payload = event.get("payload");
    let text_chars = payload
        .and_then(|payload| payload.get("text"))
        .and_then(serde_json::Value::as_str)
        .map(|text| text.chars().count());
    let prompt_chars = payload
        .and_then(|payload| payload.get("prompt"))
        .and_then(serde_json::Value::as_str)
        .map(|prompt| prompt.chars().count());
    serde_json::json!({
        "timestamp": Utc::now().to_rfc3339(),
        "type": event_type,
        "code": payload
            .and_then(|payload| payload.get("code"))
            .and_then(serde_json::Value::as_str),
        "underlyingCode": payload
            .and_then(|payload| payload.get("underlyingCode"))
            .and_then(serde_json::Value::as_str),
        "message": payload
            .and_then(|payload| payload.get("message"))
            .and_then(serde_json::Value::as_str),
        "underlyingMessage": payload
            .and_then(|payload| payload.get("underlyingMessage"))
            .and_then(serde_json::Value::as_str),
        "silent": payload
            .and_then(|payload| payload.get("silent"))
            .and_then(serde_json::Value::as_bool),
        "path": payload
            .and_then(|payload| payload.get("path"))
            .and_then(serde_json::Value::as_str),
        "observedAudioLevel": payload
            .and_then(|payload| payload.get("observedAudioLevel"))
            .cloned(),
        "pasteTarget": payload
            .and_then(|payload| payload.get("app"))
            .and_then(serde_json::Value::as_str),
        "provider": payload
            .and_then(|payload| payload.get("provider"))
            .and_then(serde_json::Value::as_str),
        "textChars": text_chars,
        "promptChars": prompt_chars,
    })
}

/// Tag error events with `payload.silent: bool` so the HUD doesn't have to
/// re-derive the classification — Rust is the single source of truth.
fn annotate_silent_error(event: &mut serde_json::Value) {
    if event.get("type").and_then(serde_json::Value::as_str) != Some("error") {
        return;
    }
    let silent = is_silent_transcription_error(event);
    if let Some(payload) = event
        .get_mut("payload")
        .and_then(serde_json::Value::as_object_mut)
    {
        payload.insert("silent".to_string(), serde_json::Value::Bool(silent));
    }
}

fn update_hud_window(app: &AppHandle, event_type: Option<&str>, event: Option<&serde_json::Value>) {
    match dictation_event_visibility(event_type) {
        // The webview owns showing for dictation events: hud.ts resizes the
        // window to the measured pill, then invokes dictation_hud_show.
        // Showing eagerly from here raced that resize — the window came up at
        // a stale frame as a gray bar, then a clipped pill, until the next
        // visible-state resize healed it.
        DictationEventVisibility::Show => {}
        DictationEventVisibility::Hide => {
            schedule_hud_hide(app, hud_hide_delay_for_event(event_type, event))
        }
        DictationEventVisibility::Ignore => {}
    }
}

fn update_latest_event(app: &AppHandle, event_type: Option<&str>, line: Option<String>) {
    if let Some(state) = app.try_state::<LastDictationEvent>() {
        if let Ok(mut event) = state.event.lock() {
            match dictation_event_visibility(event_type) {
                DictationEventVisibility::Show => *event = line,
                DictationEventVisibility::Hide => *event = None,
                DictationEventVisibility::Ignore => {}
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DictationEventVisibility {
    Show,
    Hide,
    Ignore,
}

fn dictation_event_visibility(event_type: Option<&str>) -> DictationEventVisibility {
    match event_type {
        Some(
            "listening_started"
            | "audio_level"
            | "finalizing_transcript"
            | "final_transcript"
            | "paste_target",
        ) => DictationEventVisibility::Show,
        Some(
            "paste_completed"
            | "agent_session_prompt"
            | "error"
            | "shutdown_ack"
            | "helper_unavailable",
        ) => DictationEventVisibility::Hide,
        _ => DictationEventVisibility::Ignore,
    }
}

fn hud_hide_delay_for_event(
    event_type: Option<&str>,
    event: Option<&serde_json::Value>,
) -> Duration {
    match event_type {
        Some("shutdown_ack") => Duration::ZERO,
        Some("error") if event.is_some_and(is_silent_transcription_error) => {
            Duration::from_millis(900)
        }
        Some("error") => Duration::from_millis(2200),
        _ => Duration::from_millis(900),
    }
}

fn is_silent_transcription_error(event: &serde_json::Value) -> bool {
    let payload = event.get("payload");
    let code = payload
        .and_then(|payload| payload.get("code"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let message = payload
        .and_then(|payload| payload.get("message"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let normalized_message = message.to_ascii_lowercase();

    matches!(
        code,
        "missing_recording"
            | "no_speech"
            | "no_transcription"
            | "empty_transcript"
            | "transcription_empty"
    ) || normalized_message.contains("empty transcript")
        || normalized_message.contains("no transcript")
        || normalized_message.contains("no speech")
        || normalized_message.contains("no recorded audio")
        || normalized_message.contains("audio file is too short")
        || normalized_message.contains("did not return any transcript")
        // June API collapses an empty dictation to a BadRequest whose message
        // is the service reason (e.g. "no_speech", "dictation_text_empty").
        // Treat those as "nothing captured", not a fault.
        || normalized_message.contains("no_speech")
        || normalized_message.contains("dictation_text_empty")
}

/// True while the window has been shown fully transparent by
/// wake_hud_window and the webview hasn't revealed it properly yet —
/// is_visible() can't tell a transparent window from a shown one.
static HUD_WOKEN_FADED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Wake the HUD window for the meeting prompt without revealing it. The
/// webview of a long-hidden window may be suspended and slow to process the
/// detection event, but showing it eagerly at full alpha flashes a stale
/// frame — bare frost, then a clipped pill — until the webview's resize
/// lands. Show it fully transparent instead; the webview sizes the window
/// and fades it in via dictation_hud_show.
pub(crate) fn wake_hud_window(app: &AppHandle) {
    if let Some(hud) = app.get_webview_window("hud") {
        if hud.is_visible().unwrap_or(false) {
            // Already up — either with real content (leave it alone) or
            // from an earlier wake (already transparent).
            return;
        }
        // Meeting prompts always come up top-center; dictation_hud_show
        // re-centers precisely once the webview has sized the window.
        position_hud_window_top_center(&hud);
        HUD_WOKEN_FADED.store(true, std::sync::atomic::Ordering::Relaxed);
        let alpha_hud = hud.clone();
        let _ = app.run_on_main_thread(move || set_window_alpha(&alpha_hud, 0.0));
        let _ = hud.show();
    }
}

fn schedule_hud_hide(app: &AppHandle, delay: Duration) {
    let app = app.clone();
    thread::spawn(move || {
        if !delay.is_zero() {
            thread::sleep(delay);
        }

        if let Some(state) = app.try_state::<LastDictationEvent>() {
            if state
                .event
                .lock()
                .ok()
                .and_then(|event| event.clone())
                .is_some()
            {
                return;
            }
        }

        if let Some(hud) = app.get_webview_window("hud") {
            let _ = hud.hide();
        }
    });
}

fn position_hud_window(app: &AppHandle, hud: &WebviewWindow) {
    let Ok(window_size) = hud.outer_size() else {
        return;
    };

    // Restore the in-memory drag position if it's still on-screen. This
    // doesn't persist across app restarts — that's deliberate; quitting
    // June resets the HUD to top-center so it can't end up lost on a
    // monitor that's no longer connected.
    if let Some(state) = app.try_state::<HudPosition>() {
        let saved = state.inner.lock().ok().and_then(|guard| *guard);
        if let Some((x, y)) = saved {
            if hud_position_is_visible(hud, x, y, window_size) {
                let _ = hud.set_position(PhysicalPosition::new(x, y));
                return;
            }
        }
    }

    if let Some((x, y)) = default_hud_position(hud, window_size) {
        let _ = hud.set_position(PhysicalPosition::new(x, y));
    }
}

fn current_or_next_hud_position(
    app: &AppHandle,
    hud: &WebviewWindow,
    window_size: PhysicalSize<u32>,
) -> Option<PhysicalPosition<i32>> {
    if hud.is_visible().unwrap_or(false)
        && !HUD_WOKEN_FADED.load(std::sync::atomic::Ordering::Relaxed)
    {
        if let Ok(position) = hud.outer_position() {
            return Some(position);
        }
    }

    if let Some(state) = app.try_state::<HudPosition>() {
        let saved = state.inner.lock().ok().and_then(|guard| *guard);
        if let Some((x, y)) = saved {
            if hud_position_is_visible(hud, x, y, window_size) {
                return Some(PhysicalPosition::new(x, y));
            }
        }
    }

    default_hud_position(hud, window_size)
        .map(|(x, y)| PhysicalPosition::new(x, y))
        .or_else(|| hud.outer_position().ok())
}

/// Meeting prompts always enter at the default top-center spot. They're
/// transient notifications, not the user's parked dictation pill, so the
/// saved drag position doesn't apply to them.
fn position_hud_window_top_center(hud: &WebviewWindow) {
    let Ok(window_size) = hud.outer_size() else {
        return;
    };
    if let Some((x, y)) = default_hud_position(hud, window_size) {
        let _ = hud.set_position(PhysicalPosition::new(x, y));
    }
}

fn default_hud_position(hud: &WebviewWindow, window_size: PhysicalSize<u32>) -> Option<(i32, i32)> {
    const HUD_TOP_MARGIN: i32 = 12;

    let monitor = hud
        .cursor_position()
        .ok()
        .and_then(|cursor| hud.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| hud.current_monitor().ok().flatten())
        .or_else(|| hud.primary_monitor().ok().flatten())?;

    let work_area = monitor.work_area();
    let work_top = work_area.position.y;
    let work_center_x = work_area.position.x + work_area.size.width as i32 / 2;

    // The window is the pill plus its transparent shadow gutter. Anchor the
    // full frame; the webview centers the pill inside it.
    let x = work_center_x - window_size.width as i32 / 2;
    let y = work_top + HUD_TOP_MARGIN;
    Some((x, y))
}

/// Treat a saved position as still usable as long as the pill overlaps a
/// connected monitor by at least this many pixels on each axis. Guards
/// against "I unplugged the external display" losing the HUD off-screen.
fn hud_position_is_visible(
    hud: &WebviewWindow,
    x: i32,
    y: i32,
    window_size: PhysicalSize<u32>,
) -> bool {
    const MIN_OVERLAP_PX: i32 = 24;
    let Ok(monitors) = hud.available_monitors() else {
        return false;
    };
    let pill_w = window_size.width as i32;
    let pill_h = window_size.height as i32;
    monitors.iter().any(|monitor| {
        let work = monitor.work_area();
        let mx = work.position.x;
        let my = work.position.y;
        let mw = work.size.width as i32;
        let mh = work.size.height as i32;
        let overlap_x = (x + pill_w).min(mx + mw) - x.max(mx);
        let overlap_y = (y + pill_h).min(my + mh) - y.max(my);
        overlap_x >= MIN_OVERLAP_PX && overlap_y >= MIN_OVERLAP_PX
    })
}

fn configure_hud_window(app: &AppHandle) -> Result<(), String> {
    if let Some(hud) = app.get_webview_window("hud") {
        hud.set_always_on_top(true)
            .map_err(|error| error.to_string())?;
        hud.set_visible_on_all_workspaces(true)
            .map_err(|error| error.to_string())?;
        hud.set_focusable(false)
            .map_err(|error| error.to_string())?;
        hud.set_skip_taskbar(true)
            .map_err(|error| error.to_string())?;
        // The webview paints the HUD surface and shadow into a transparent
        // gutter, matching the agent HUD. Keep native shadow/vibrancy off so
        // no frosted rim or large repaint can appear during transitions.
        hud.set_shadow(false).map_err(|error| error.to_string())?;

        #[cfg(target_os = "macos")]
        {
            make_hud_nonactivating(&hud);
            use window_vibrancy::clear_vibrancy;
            if let Err(error) = clear_vibrancy(&hud) {
                tracing::warn!(%error, "failed to clear dictation HUD vibrancy");
            }
        }

        let app_for_events = app.clone();
        hud.on_window_event(move |event| {
            if let WindowEvent::Moved(position) = event {
                if let Some(state) = app_for_events.try_state::<HudPosition>() {
                    if let Ok(mut guard) = state.inner.lock() {
                        *guard = Some((position.x, position.y));
                    }
                }
            }
        });
    }
    Ok(())
}

/// macOS: reclass the HUD's NSWindow to NSPanel and set the
/// `NSWindowStyleMaskNonactivatingPanel` style bit, so clicking the drag
/// handle or stop button doesn't steal focus from whichever app the user is
/// dictating into. Without this, every interaction with the HUD activates
/// June and yanks the text cursor out of the user's document.
#[cfg(target_os = "macos")]
fn make_hud_nonactivating(hud: &WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    let Ok(handle) = hud.ns_window() else {
        return;
    };
    if handle.is_null() {
        return;
    }
    let Some(panel_class) = AnyClass::get(c"NSPanel") else {
        return;
    };

    unsafe {
        let window = handle as *mut AnyObject;
        // NSWindow → NSPanel; required because the non-activating style mask
        // is only honored on NSPanel instances.
        objc2::ffi::object_setClass(window, panel_class as *const _ as *const _);

        // NSWindowStyleMaskNonactivatingPanel = 1 << 7.
        const NON_ACTIVATING: usize = 1 << 7;
        let current_mask: usize = msg_send![window, styleMask];
        let _: () = msg_send![window, setStyleMask: current_mask | NON_ACTIVATING];

        // Allow mouseMoved + brief key acquisition without activating the
        // app, so native drag and any AppKit-routed mouse events still work.
        let _: () = msg_send![window, setAcceptsMouseMovedEvents: true];
        let _: () = msg_send![window, setBecomesKeyOnlyIfNeeded: true];
    }
}

fn hotkey_ready_event(settings: &DictationSettings) -> serde_json::Value {
    let shortcuts = format!(
        "Push to talk: {}; Toggle: {}",
        settings.push_to_talk_shortcut.label, settings.toggle_shortcut.label
    );
    serde_json::json!({
        "type": "hotkey_trigger_ready",
        "payload": {
            "shortcut": settings.push_to_talk_shortcut.label,
            "pushToTalkShortcut": settings.push_to_talk_shortcut.label,
            "toggleShortcut": settings.toggle_shortcut.label,
            "shortcuts": shortcuts,
        },
    })
}

#[cfg(target_os = "macos")]
fn initial_hotkey_event(settings: &DictationSettings) -> serde_json::Value {
    hotkey_ready_event(settings)
}

#[cfg(target_os = "windows")]
fn initial_hotkey_event(_settings: &DictationSettings) -> serde_json::Value {
    serde_json::json!({
        "type": "hotkey_trigger_unavailable",
        "payload": {
            "reason": "registering",
            "message": "Windows is registering dictation shortcuts.",
        },
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn initial_hotkey_event(_settings: &DictationSettings) -> serde_json::Value {
    serde_json::json!({
        "type": "hotkey_trigger_unavailable",
        "payload": {
            "reason": "unsupported",
            "message": "Dictation shortcuts are not supported on this platform.",
        },
    })
}

fn hotkey_error_event(error: String) -> serde_json::Value {
    serde_json::json!({
        "type": "error",
        "payload": {
            "code": "hotkey_registration_failed",
            "message": error,
        },
    })
}

fn set_hotkey_status(state: &HotkeyStatus, event: serde_json::Value) {
    if let Ok(mut status) = state.event.lock() {
        *status = event;
    }
}

pub fn key_code_for_code(code: &str) -> Option<u32> {
    Some(match code {
        "KeyA" => 0x00,
        "KeyS" => 0x01,
        "KeyD" => 0x02,
        "KeyF" => 0x03,
        "KeyH" => 0x04,
        "KeyG" => 0x05,
        "KeyZ" => 0x06,
        "KeyX" => 0x07,
        "KeyC" => 0x08,
        "KeyV" => 0x09,
        "KeyB" => 0x0b,
        "KeyQ" => 0x0c,
        "KeyW" => 0x0d,
        "KeyE" => 0x0e,
        "KeyR" => 0x0f,
        "KeyY" => 0x10,
        "KeyT" => 0x11,
        "Digit1" => 0x12,
        "Digit2" => 0x13,
        "Digit3" => 0x14,
        "Digit4" => 0x15,
        "Digit6" => 0x16,
        "Digit5" => 0x17,
        "Equal" => 0x18,
        "Digit9" => 0x19,
        "Digit7" => 0x1a,
        "Minus" => 0x1b,
        "Digit8" => 0x1c,
        "Digit0" => 0x1d,
        "BracketRight" => 0x1e,
        "KeyO" => 0x1f,
        "KeyU" => 0x20,
        "BracketLeft" => 0x21,
        "KeyI" => 0x22,
        "KeyP" => 0x23,
        "Enter" => 0x24,
        "KeyL" => 0x25,
        "KeyJ" => 0x26,
        "Quote" => 0x27,
        "KeyK" => 0x28,
        "Semicolon" => 0x29,
        "Backslash" => 0x2a,
        "Comma" => 0x2b,
        "Slash" => 0x2c,
        "KeyN" => 0x2d,
        "KeyM" => 0x2e,
        "Period" => 0x2f,
        "Tab" => 0x30,
        "Space" => 0x31,
        "Backquote" => 0x32,
        "Backspace" => 0x33,
        "Escape" => 0x35,
        "F1" => 0x7a,
        "F2" => 0x78,
        "F3" => 0x63,
        "F4" => 0x76,
        "F5" => 0x60,
        "F6" => 0x61,
        "F7" => 0x62,
        "F8" => 0x64,
        "F9" => 0x65,
        "F10" => 0x6d,
        "F11" => 0x67,
        "F12" => 0x6f,
        "ArrowLeft" => 0x7b,
        "ArrowRight" => 0x7c,
        "ArrowDown" => 0x7d,
        "ArrowUp" => 0x7e,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn comm_line_identity_is_truncation_tolerant() {
        // Full path (comm= returned the executable path).
        assert!(comm_line_is_dictation_helper(
            "/Applications/June Dictation Helper.app/Contents/MacOS/june-dictation-helper"
        ));
        // Bare full name.
        assert!(comm_line_is_dictation_helper("june-dictation-helper"));
        // Kernel p_comm truncated to 15 chars: the real orphan MUST still read
        // as the helper, or it is deleted-not-killed and JUN-338 reopens.
        assert!(comm_line_is_dictation_helper("june-dictation-"));
        // Trailing whitespace/newline from ps is tolerated.
        assert!(comm_line_is_dictation_helper("june-dictation-helper\n"));
        // A shorter prefix (< 15) is ambiguous and must NOT match.
        assert!(!comm_line_is_dictation_helper("june-dictation"));
        // Unrelated process and empty output never match.
        assert!(!comm_line_is_dictation_helper("/usr/bin/login"));
        assert!(!comm_line_is_dictation_helper("bash"));
        assert!(!comm_line_is_dictation_helper(""));
        assert!(!comm_line_is_dictation_helper("   "));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn owner_liveness_uses_start_time_to_defeat_pid_reuse() {
        // Same pid, same start time -> the owner is genuinely still alive.
        assert_eq!(
            owner_liveness(&StartTimeProbe::StartedAt("t0".into()), "t0"),
            OwnerLiveness::Alive
        );
        // Same pid, DIFFERENT start time -> the pid was recycled (e.g. a new
        // June with a sequentially-reused pid); the original owner is dead, so
        // its record is NOT treated as the new instance's own. This is the
        // JUN-338 reopening the round-3 review caught.
        assert_eq!(
            owner_liveness(&StartTimeProbe::StartedAt("t1".into()), "t0"),
            OwnerLiveness::Dead
        );
        assert_eq!(
            owner_liveness(&StartTimeProbe::Gone, "t0"),
            OwnerLiveness::Dead
        );
        // Probe failure is never treated as "dead" -> fail closed.
        assert_eq!(
            owner_liveness(&StartTimeProbe::Unknown, "t0"),
            OwnerLiveness::Unknown
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn helper_match_skips_reused_pid_and_requires_identity() {
        // Exact recorded process (pid + start time) that is still a helper.
        assert_eq!(
            helper_match(
                &StartTimeProbe::StartedAt("t0".into()),
                "t0",
                &HelperIdentity::IsHelper
            ),
            HelperMatch::MatchesRecord
        );
        // Same pid, different start time -> reused by another process (possibly
        // another live instance's helper); never a kill target.
        assert_eq!(
            helper_match(
                &StartTimeProbe::StartedAt("t9".into()),
                "t0",
                &HelperIdentity::IsHelper
            ),
            HelperMatch::GoneOrReused
        );
        // Matching pid+start but the executable does not read as a helper. With
        // the truncation-tolerant identity check this is only a genuine
        // same-second pid reuse by a non-helper -> fail closed (abort), never
        // delete-and-race.
        assert_eq!(
            helper_match(
                &StartTimeProbe::StartedAt("t0".into()),
                "t0",
                &HelperIdentity::NotHelper
            ),
            HelperMatch::Unknown
        );
        // Gone/reused pid (start-time mismatch or dead) with a non-helper -> the
        // record names no live orphan, so it is safe to treat as stale.
        assert_eq!(
            helper_match(&StartTimeProbe::Gone, "t0", &HelperIdentity::NotHelper),
            HelperMatch::GoneOrReused
        );
        // Identity indeterminate -> fail closed.
        assert_eq!(
            helper_match(
                &StartTimeProbe::StartedAt("t0".into()),
                "t0",
                &HelperIdentity::Unknown
            ),
            HelperMatch::Unknown
        );
        assert_eq!(
            helper_match(&StartTimeProbe::Unknown, "t0", &HelperIdentity::IsHelper),
            HelperMatch::Unknown
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn decide_record_action_reaps_only_proven_orphans_and_fails_closed() {
        // Live owner -> leave it (covers "this is my own record" and "another
        // live instance's record").
        assert_eq!(
            decide_record_action(OwnerLiveness::Alive, HelperMatch::MatchesRecord),
            RecordAction::Skip
        );
        // Proven-dead owner + the recorded helper still alive -> reap.
        assert_eq!(
            decide_record_action(OwnerLiveness::Dead, HelperMatch::MatchesRecord),
            RecordAction::Reap
        );
        // Dead owner, helper already gone/reused -> just drop the stale record.
        assert_eq!(
            decide_record_action(OwnerLiveness::Dead, HelperMatch::GoneOrReused),
            RecordAction::DeleteStale
        );
        // Any indeterminate identity -> fail closed (abort the replacement spawn).
        assert_eq!(
            decide_record_action(OwnerLiveness::Unknown, HelperMatch::MatchesRecord),
            RecordAction::Abort
        );
        assert_eq!(
            decide_record_action(OwnerLiveness::Dead, HelperMatch::Unknown),
            RecordAction::Abort
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn decide_unrecorded_action_reaps_only_unclaimed_confirmed_helpers() {
        // Enumerated helper with no matching record (claimed=false) -> reap.
        // This is the legacy/migration orphan from a pre-record build.
        assert_eq!(
            decide_unrecorded_action(false, &HelperIdentity::IsHelper),
            UnrecordedAction::Reap
        );
        // A dead-owner record does not add to the live-claimed set, so its
        // helper reads claimed=false here -> reap (same as no record).
        //
        // A live-owner record DOES claim its helper (claimed=true) -> skip, so a
        // running sibling instance's healthy helper is never killed.
        assert_eq!(
            decide_unrecorded_action(true, &HelperIdentity::IsHelper),
            UnrecordedAction::Skip
        );
        // pgrep matched the name but `ps` says it is not a helper -> do not kill.
        assert_eq!(
            decide_unrecorded_action(false, &HelperIdentity::NotHelper),
            UnrecordedAction::Skip
        );
        // Identity indeterminate on an unclaimed pid -> fail closed.
        assert_eq!(
            decide_unrecorded_action(false, &HelperIdentity::Unknown),
            UnrecordedAction::Abort
        );
        // Claimed by a live owner always wins, regardless of identity probe.
        assert_eq!(
            decide_unrecorded_action(true, &HelperIdentity::Unknown),
            UnrecordedAction::Skip
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn wait_for_pid_exit_confirms_a_kill_and_bounds_a_survivor() {
        // A dead pid is observed as exited. Reap the child first so it is not a
        // zombie: `kill -0` still reports a zombie as alive, but a real orphan
        // (whose parent is the dead prior app) is reparented to launchd and
        // reaped, so in production the pid genuinely disappears.
        let mut victim = Command::new("/bin/sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn victim");
        let victim_pid = victim.id();
        kill_pid(victim_pid);
        let _ = victim.wait();
        assert!(wait_for_pid_exit(victim_pid, Duration::from_secs(2)));

        // ...and a live process is NOT declared exited, so the reap aborts the
        // replacement spawn rather than racing a helper that still holds the tap.
        let mut survivor = Command::new("/bin/sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn survivor");
        assert!(!wait_for_pid_exit(
            survivor.id(),
            Duration::from_millis(100)
        ));
        let _ = survivor.kill();
        let _ = survivor.wait();
    }

    #[test]
    fn mic_duck_starts_on_listening_and_holds_through_levels() {
        assert_eq!(
            mic_duck_action_for_event(Some("listening_started")),
            Some(true)
        );
        // Mid-listening chatter must not lift the duck, or the tail of a long
        // dictation would leak back into the note.
        assert_eq!(mic_duck_action_for_event(Some("audio_level")), None);
        assert_eq!(mic_duck_action_for_event(Some("paste_target")), None);
    }

    #[test]
    fn mic_duck_lifts_on_every_way_listening_can_end() {
        // Success, discard, and each failure/terminal path all restore the mic
        // — a leaked duck would silently swallow the rest of the meeting.
        for event in [
            "recording_ready",
            "recording_discarded",
            "finalizing_transcript",
            "final_transcript",
            "paste_completed",
            "error",
            "helper_unavailable",
            "shutdown_ack",
        ] {
            assert_eq!(
                mic_duck_action_for_event(Some(event)),
                Some(false),
                "{event} should lift the mic duck"
            );
        }
    }

    #[test]
    fn mic_duck_ignores_unrelated_events() {
        assert_eq!(mic_duck_action_for_event(Some("permission_status")), None);
        assert_eq!(mic_duck_action_for_event(None), None);
    }

    fn test_policy() -> RespawnPolicy {
        RespawnPolicy {
            max_attempts: 3,
            base_backoff: Duration::from_millis(100),
            max_backoff: Duration::from_secs(1),
            healthy_runtime: Duration::from_secs(30),
        }
    }

    #[test]
    fn intentional_shutdown_never_respawns() {
        let policy = test_policy();
        let (action, failures) = decide_respawn(true, 0, Duration::ZERO, &policy);
        assert_eq!(action, RespawnAction::Skip);
        // The failure count is left untouched on an intentional stop.
        assert_eq!(failures, 0);

        // Even mid-crash-loop, a shutdown wins and stops respawning.
        let (action, _) = decide_respawn(true, 2, Duration::ZERO, &policy);
        assert_eq!(action, RespawnAction::Skip);
    }

    #[test]
    fn unexpected_exit_respawns_and_counts_up() {
        let policy = test_policy();
        let (action, failures) = decide_respawn(false, 0, Duration::ZERO, &policy);
        assert_eq!(
            action,
            RespawnAction::Respawn {
                attempt: 1,
                backoff: Duration::from_millis(100),
            }
        );
        assert_eq!(failures, 1);

        let (action, failures) = decide_respawn(false, 1, Duration::ZERO, &policy);
        assert_eq!(
            action,
            RespawnAction::Respawn {
                attempt: 2,
                backoff: Duration::from_millis(200),
            }
        );
        assert_eq!(failures, 2);
    }

    #[test]
    fn retry_cap_exhaustion_gives_up() {
        let policy = test_policy();
        // The last allowed attempt still respawns.
        let (action, failures) = decide_respawn(false, 2, Duration::ZERO, &policy);
        assert!(matches!(action, RespawnAction::Respawn { attempt: 3, .. }));
        assert_eq!(failures, 3);

        // One past the cap gives up instead of respawning.
        let (action, _) = decide_respawn(false, 3, Duration::ZERO, &policy);
        assert_eq!(action, RespawnAction::GiveUp);
    }

    #[test]
    fn healthy_runtime_resets_the_failure_count() {
        let policy = test_policy();
        // A helper that had exhausted its retries but then ran healthily is
        // treated as a fresh first failure, so an isolated later kill recovers.
        let (action, failures) = decide_respawn(
            false,
            3,
            policy.healthy_runtime + Duration::from_secs(1),
            &policy,
        );
        assert_eq!(
            action,
            RespawnAction::Respawn {
                attempt: 1,
                backoff: Duration::from_millis(100),
            }
        );
        assert_eq!(failures, 1);
    }

    #[test]
    fn respawn_backoff_doubles_and_clamps() {
        let policy = test_policy();
        assert_eq!(respawn_backoff(1, &policy), Duration::from_millis(100));
        assert_eq!(respawn_backoff(2, &policy), Duration::from_millis(200));
        assert_eq!(respawn_backoff(3, &policy), Duration::from_millis(400));
        // Clamped to max_backoff once doubling would overshoot it.
        assert_eq!(respawn_backoff(20, &policy), policy.max_backoff);
    }

    #[test]
    fn respawn_decision_records_failure_count() {
        let state = HelperState::default();
        let policy = test_policy();

        let (action, failures) = decide_and_record_respawn(&state, Duration::ZERO, &policy);
        assert!(matches!(action, RespawnAction::Respawn { attempt: 1, .. }));
        assert_eq!(failures, 1);
        assert_eq!(state.respawn_failures.load(Ordering::SeqCst), 1);

        let (action, failures) = decide_and_record_respawn(&state, Duration::ZERO, &policy);
        assert!(matches!(action, RespawnAction::Respawn { attempt: 2, .. }));
        assert_eq!(failures, 2);
        assert_eq!(state.respawn_failures.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn default_settings_use_keyboard_shortcuts_without_bare_fn() {
        let settings = DictationSettings::default();

        assert_eq!(
            settings.push_to_talk_shortcut,
            DictationShortcutSetting::control_option_d()
        );
        assert_eq!(
            settings.toggle_shortcut,
            DictationShortcutSetting::control_option_t()
        );
        assert_eq!(settings.style, DictationStyle::Standard);
        assert_eq!(settings.language, None);
    }

    #[test]
    fn legacy_settings_reset_to_defaults_and_preserve_microphone() {
        let settings: DictationSettings = serde_json::from_str(
            r#"{"shortcut":"control_option_space","activationMode":"toggle","microphone":{"id":"usb","name":"USB Mic"}}"#,
        )
        .expect("legacy shortcut should deserialize");

        assert_eq!(
            settings.push_to_talk_shortcut,
            DictationShortcutSetting::control_option_d()
        );
        assert_eq!(
            settings.toggle_shortcut,
            DictationShortcutSetting::control_option_t()
        );
        assert_eq!(settings.microphone.id.as_deref(), Some("usb"));
        assert_eq!(settings.microphone.name.as_deref(), Some("USB Mic"));
        assert_eq!(settings.style, DictationStyle::Standard);
        assert_eq!(settings.language, None);
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn deserializes_new_shortcut_settings_and_preserves_bare_fn_push_to_talk() {
        let settings: DictationSettings = serde_json::from_str(
            r#"{"pushToTalkShortcut":{"keyCode":0,"code":"Fn","modifiers":{"command":false,"control":false,"option":false,"shift":false,"function":true},"label":"Fn","pressCount":1},"toggleShortcut":{"keyCode":49,"code":"Space","modifiers":{"command":false,"control":true,"option":true,"shift":false,"function":false},"label":"Ctrl+Opt+Space","pressCount":1},"microphone":{"id":null,"name":null}}"#,
        )
        .expect("new settings should deserialize");

        assert_eq!(
            settings.push_to_talk_shortcut,
            DictationShortcutSetting::bare_fn()
        );
        assert_eq!(settings.push_to_talk_shortcut.press_count, 1);
        assert_eq!(settings.toggle_shortcut.key_code, 0x31);
        assert_eq!(settings.toggle_shortcut.code, "Space");
        assert_eq!(settings.toggle_shortcut.label, "Ctrl+Opt+Space");
        assert_eq!(settings.toggle_shortcut.press_count, 1);
        assert_eq!(settings.style, DictationStyle::Standard);
        assert_eq!(settings.language, None);
    }

    #[test]
    fn deserializes_control_letter_and_digit_shortcuts() {
        let settings: DictationSettings = serde_json::from_str(
            r#"{"pushToTalkShortcut":{"keyCode":999,"code":"KeyT","modifiers":{"command":false,"control":true,"option":false,"shift":false,"function":false},"label":"Ctrl+T","pressCount":1},"toggleShortcut":{"keyCode":999,"code":"Digit1","modifiers":{"command":false,"control":true,"option":false,"shift":false,"function":false},"label":"Ctrl+1","pressCount":1},"microphone":{"id":null,"name":null}}"#,
        )
        .expect("control shortcuts should deserialize");

        assert_eq!(settings.push_to_talk_shortcut.key_code, 0x11);
        assert_eq!(settings.push_to_talk_shortcut.code, "KeyT");
        assert_eq!(settings.push_to_talk_shortcut.label, "Ctrl+T");
        assert_eq!(settings.toggle_shortcut.key_code, 0x12);
        assert_eq!(settings.toggle_shortcut.code, "Digit1");
        assert_eq!(settings.toggle_shortcut.label, "Ctrl+1");
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn deserializes_modifier_only_shortcuts() {
        let settings: DictationSettings = serde_json::from_str(
            r#"{"pushToTalkShortcut":{"keyCode":0,"code":"Modifiers","modifiers":{"command":false,"control":true,"option":true,"shift":false,"function":false},"label":"Ctrl+Opt","pressCount":1},"toggleShortcut":{"keyCode":999,"code":"Digit1","modifiers":{"command":false,"control":true,"option":false,"shift":false,"function":false},"label":"Ctrl+1","pressCount":1},"microphone":{"id":null,"name":null}}"#,
        )
        .expect("modifier-only shortcuts should deserialize");

        assert_eq!(settings.push_to_talk_shortcut.key_code, 0);
        assert_eq!(settings.push_to_talk_shortcut.code, "Modifiers");
        assert_eq!(settings.push_to_talk_shortcut.label, "Ctrl+Opt");
        assert!(settings.push_to_talk_shortcut.modifiers.control);
        assert!(settings.push_to_talk_shortcut.modifiers.option);
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn shortcut_updates_are_written_in_reloadable_settings_file() {
        let directory = tempfile::tempdir().expect("settings tempdir should be created");
        let state = DictationSettingsState {
            path: directory.path().join("dictation-settings.json"),
            settings: Mutex::new(DictationSettings::default()),
        };

        let settings = update_settings(&state, |settings| {
            settings.push_to_talk_shortcut = DictationShortcutSetting::bare_fn();
            settings.toggle_shortcut = DictationShortcutSetting {
                key_code: 0x31,
                code: "Space".to_string(),
                modifiers: DictationShortcutModifiers {
                    control: true,
                    option: true,
                    ..DictationShortcutModifiers::default()
                },
                label: "Ctrl+Opt+Space".to_string(),
                press_count: 1,
            };
        })
        .expect("shortcut settings should save");

        let stored = std::fs::read_to_string(&state.path).expect("settings file should be written");
        let reloaded: DictationSettings =
            serde_json::from_str(&stored).expect("settings file should reload");

        assert_eq!(
            reloaded.push_to_talk_shortcut,
            settings.push_to_talk_shortcut
        );
        assert_eq!(reloaded.toggle_shortcut, settings.toggle_shortcut);
    }

    #[test]
    fn deserializes_unsupported_modifier_only_shortcuts_to_defaults() {
        let settings: DictationSettings = serde_json::from_str(
            r#"{"pushToTalkShortcut":{"keyCode":59,"code":"ControlLeft","modifiers":{"command":false,"control":true,"option":true,"shift":false,"function":false},"label":"Ctrl+Opt","pressCount":1},"toggleShortcut":{"keyCode":58,"code":"OptionLeft","modifiers":{"command":false,"control":false,"option":true,"shift":false,"function":false},"label":"Opt","pressCount":1},"microphone":{"id":null,"name":null}}"#,
        )
        .expect("settings should deserialize");

        assert_eq!(
            settings.push_to_talk_shortcut,
            DictationShortcutSetting::control_option_d()
        );
        assert_eq!(
            settings.toggle_shortcut,
            DictationShortcutSetting::control_option_t()
        );
    }

    #[test]
    fn deserializes_dictation_style() {
        let settings: DictationSettings = serde_json::from_str(
            r#"{"pushToTalkShortcut":{"keyCode":0,"code":"Fn","modifiers":{"command":false,"control":false,"option":false,"shift":false,"function":true},"label":"Fn","pressCount":1},"toggleShortcut":{"keyCode":49,"code":"Space","modifiers":{"command":false,"control":true,"option":true,"shift":false,"function":false},"label":"Ctrl+Opt+Space","pressCount":1},"microphone":{"id":null,"name":null},"style":"casualLowercase"}"#,
        )
        .expect("style settings should deserialize");

        assert_eq!(settings.style, DictationStyle::CasualLowercase);
    }

    #[test]
    fn deserializes_default_transcription_language() {
        let settings: DictationSettings = serde_json::from_str(
            r#"{"pushToTalkShortcut":{"keyCode":0,"code":"Fn","modifiers":{"command":false,"control":false,"option":false,"shift":false,"function":true},"label":"Fn","pressCount":1},"toggleShortcut":{"keyCode":49,"code":"Space","modifiers":{"command":false,"control":true,"option":true,"shift":false,"function":false},"label":"Ctrl+Opt+Space","pressCount":1},"microphone":{"id":null,"name":null},"language":"ES"}"#,
        )
        .expect("language settings should deserialize");

        assert_eq!(settings.language.as_deref(), Some("es"));
    }

    #[test]
    fn ignores_invalid_default_transcription_language() {
        assert_eq!(normalize_language(Some("english".to_string())), None);
        assert_eq!(normalize_language(Some(" e ".to_string())), None);
        assert_eq!(
            normalize_language(Some(" en ".to_string())).as_deref(),
            Some("en")
        );
    }

    #[test]
    fn shortcut_input_accepts_bare_fn() {
        let shortcut = DictationShortcutInput {
            code: "Fn".to_string(),
            modifiers: DictationShortcutModifiers {
                function: true,
                ..DictationShortcutModifiers::default()
            },
            label: "Fn".to_string(),
            press_count: None,
        }
        .into_setting_for_platform(false)
        .expect("bare Fn should be accepted");

        assert_eq!(shortcut, DictationShortcutSetting::bare_fn());
    }

    #[test]
    fn shortcut_input_normalizes_double_bare_fn_to_single_press() {
        let shortcut = DictationShortcutInput {
            code: "Fn".to_string(),
            modifiers: DictationShortcutModifiers {
                function: true,
                ..DictationShortcutModifiers::default()
            },
            label: "Fn".to_string(),
            press_count: Some(2),
        }
        .into_setting_for_platform(false)
        .expect("bare Fn should be accepted");

        assert_eq!(shortcut, DictationShortcutSetting::bare_fn());
    }

    #[test]
    fn shortcut_input_accepts_control_letter_and_normalizes_press_count() {
        let shortcut = DictationShortcutInput {
            code: "KeyT".to_string(),
            modifiers: DictationShortcutModifiers {
                control: true,
                ..DictationShortcutModifiers::default()
            },
            label: "Ctrl+T".to_string(),
            press_count: Some(2),
        }
        .into_setting_for_platform(false)
        .expect("control letter should be accepted");

        assert_eq!(shortcut.key_code, 0x11);
        assert_eq!(shortcut.code, "KeyT");
        assert!(shortcut.modifiers.control);
        assert_eq!(shortcut.press_count, 1);
    }

    #[test]
    fn windows_shortcut_input_rejects_bare_fn() {
        let err = DictationShortcutInput {
            code: "Fn".to_string(),
            modifiers: DictationShortcutModifiers {
                function: true,
                ..DictationShortcutModifiers::default()
            },
            label: "Fn".to_string(),
            press_count: Some(1),
        }
        .into_setting_for_platform(true)
        .expect_err("Windows must reject bare Fn");

        assert_eq!(err.code, "dictation_shortcut_unsupported");
    }

    #[test]
    fn windows_shortcut_input_rejects_modifier_only_combo() {
        let err = DictationShortcutInput {
            code: "Modifiers".to_string(),
            modifiers: DictationShortcutModifiers {
                control: true,
                option: true,
                ..DictationShortcutModifiers::default()
            },
            label: "Ctrl+Alt".to_string(),
            press_count: Some(1),
        }
        .into_setting_for_platform(true)
        .expect_err("Windows must reject modifier-only shortcuts");

        assert_eq!(err.code, "dictation_shortcut_unsupported");
    }

    #[test]
    fn windows_shortcut_input_rejects_fn_chord() {
        let err = DictationShortcutInput {
            code: "KeyD".to_string(),
            modifiers: DictationShortcutModifiers {
                control: true,
                function: true,
                ..DictationShortcutModifiers::default()
            },
            label: "Ctrl+Fn+D".to_string(),
            press_count: Some(1),
        }
        .into_setting_for_platform(true)
        .expect_err("Windows must reject Fn chords");

        assert_eq!(err.code, "dictation_shortcut_unsupported");
    }

    #[test]
    fn windows_shortcut_input_rejects_double_press() {
        let err = DictationShortcutInput {
            code: "KeyD".to_string(),
            modifiers: DictationShortcutModifiers {
                control: true,
                option: true,
                ..DictationShortcutModifiers::default()
            },
            label: "Ctrl+Alt+D".to_string(),
            press_count: Some(2),
        }
        .into_setting_for_platform(true)
        .expect_err("Windows must reject double-press shortcuts");

        assert_eq!(err.code, "dictation_shortcut_unsupported");
    }

    #[test]
    fn windows_shortcut_input_accepts_supported_chord() {
        let shortcut = DictationShortcutInput {
            code: "F12".to_string(),
            modifiers: DictationShortcutModifiers {
                command: true,
                ..DictationShortcutModifiers::default()
            },
            label: "Win+F12".to_string(),
            press_count: Some(1),
        }
        .into_setting_for_platform(true)
        .expect("Windows should accept a supported modifier plus key chord");

        assert_eq!(shortcut.code, "F12");
        assert_eq!(shortcut.press_count, 1);
    }

    #[test]
    fn shortcut_input_accepts_control_digit() {
        let shortcut = DictationShortcutInput {
            code: "Digit1".to_string(),
            modifiers: DictationShortcutModifiers {
                control: true,
                ..DictationShortcutModifiers::default()
            },
            label: "Ctrl+1".to_string(),
            press_count: Some(1),
        }
        .into_setting()
        .expect("control digit should be accepted");

        assert_eq!(shortcut.key_code, 0x12);
        assert_eq!(shortcut.code, "Digit1");
        assert!(shortcut.modifiers.control);
    }

    #[test]
    fn shortcut_input_accepts_modifier_only_combo() {
        let shortcut = DictationShortcutInput {
            code: "Modifiers".to_string(),
            modifiers: DictationShortcutModifiers {
                control: true,
                option: true,
                ..DictationShortcutModifiers::default()
            },
            label: "Ctrl+Opt".to_string(),
            press_count: Some(1),
        }
        .into_setting_for_platform(false)
        .expect("modifier-only combo should be accepted");

        assert_eq!(shortcut.key_code, 0);
        assert_eq!(shortcut.code, "Modifiers");
        assert_eq!(shortcut.label, "Ctrl+Opt");
        assert!(shortcut.modifiers.control);
        assert!(shortcut.modifiers.option);
    }

    #[test]
    fn shortcut_input_rejects_single_modifier_only_shortcut() {
        let err = DictationShortcutInput {
            code: "Modifiers".to_string(),
            modifiers: DictationShortcutModifiers {
                control: true,
                ..DictationShortcutModifiers::default()
            },
            label: "Ctrl".to_string(),
            press_count: Some(1),
        }
        .into_setting()
        .expect_err("single modifier-only shortcut should fail");

        assert_eq!(err.code, "dictation_shortcut_unsupported");
    }

    #[test]
    fn shortcut_input_requires_modifier() {
        let err = DictationShortcutInput {
            code: "KeyT".to_string(),
            modifiers: DictationShortcutModifiers::default(),
            label: "T".to_string(),
            press_count: Some(1),
        }
        .into_setting()
        .expect_err("shortcut without modifiers should fail");

        assert_eq!(err.code, "dictation_shortcut_modifier_required");
    }

    #[test]
    fn shortcut_input_rejects_unsupported_key() {
        let err = DictationShortcutInput {
            code: "NumpadEnter".to_string(),
            modifiers: DictationShortcutModifiers {
                control: true,
                ..DictationShortcutModifiers::default()
            },
            label: "Ctrl+NumpadEnter".to_string(),
            press_count: Some(1),
        }
        .into_setting()
        .expect_err("unsupported key should fail");

        assert_eq!(err.code, "dictation_shortcut_unsupported");
    }

    #[test]
    fn duplicate_validation_rejects_same_key_combo() {
        let settings = DictationSettings {
            push_to_talk_shortcut: DictationShortcutSetting {
                key_code: 0x31,
                code: "Space".to_string(),
                modifiers: DictationShortcutModifiers {
                    control: true,
                    ..DictationShortcutModifiers::default()
                },
                label: "Ctrl+Space".to_string(),
                press_count: 1,
            },
            toggle_shortcut: DictationShortcutSetting {
                key_code: 0x31,
                code: "Space".to_string(),
                modifiers: DictationShortcutModifiers {
                    control: true,
                    ..DictationShortcutModifiers::default()
                },
                label: "Ctrl+Space".to_string(),
                press_count: 1,
            },
            microphone: DictationMicrophoneSetting::default(),
            style: DictationStyle::Standard,
            language: None,
        };

        assert!(validate_shortcut_update(
            &settings,
            DictationShortcutKind::PushToTalk,
            &settings.push_to_talk_shortcut
        )
        .is_err());
    }

    #[test]
    fn push_to_talk_starts_on_down_and_stops_on_up() {
        let mut controller = ShortcutActivationController::default();
        let down = Instant::now();
        let up = down + PUSH_TO_TALK_MIN_HOLD;

        assert_eq!(
            controller.handle_edge(
                ShortcutKeyEdge::Down,
                DictationShortcutKind::PushToTalk,
                down
            ),
            Some(DictationCommand::StartListening)
        );
        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Up, DictationShortcutKind::PushToTalk, up),
            Some(DictationCommand::StopAndPaste)
        );
    }

    #[test]
    fn push_to_talk_graze_discards_instead_of_transcribing() {
        // Recording starts on the down edge now, so an accidental brush of
        // the key produces a real (tiny) recording. Releasing inside the
        // minimum hold must discard it rather than paste transcribed noise.
        let mut controller = ShortcutActivationController::default();
        let down = Instant::now();
        let up = down + PUSH_TO_TALK_MIN_HOLD - Duration::from_millis(1);

        assert_eq!(
            controller.handle_edge(
                ShortcutKeyEdge::Down,
                DictationShortcutKind::PushToTalk,
                down
            ),
            Some(DictationCommand::StartListening)
        );
        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Up, DictationShortcutKind::PushToTalk, up),
            Some(DictationCommand::DiscardListening)
        );

        // The graze fully releases the press: the next hold is a fresh start.
        let next_down = up + Duration::from_millis(5);
        assert_eq!(
            controller.handle_edge(
                ShortcutKeyEdge::Down,
                DictationShortcutKind::PushToTalk,
                next_down
            ),
            Some(DictationCommand::StartListening)
        );
    }

    #[test]
    fn toggle_mode_toggles_on_down_and_ignores_up() {
        let mut controller = ShortcutActivationController::default();
        let now = Instant::now();

        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Down, DictationShortcutKind::Toggle, now),
            Some(DictationCommand::ToggleListening)
        );
        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Up, DictationShortcutKind::Toggle, now),
            None
        );
        controller.acknowledge_toggle_command();
        assert_eq!(
            controller.handle_edge(
                ShortcutKeyEdge::Down,
                DictationShortcutKind::Toggle,
                now + TOGGLE_SHORTCUT_DEBOUNCE
            ),
            Some(DictationCommand::ToggleListening)
        );
    }

    #[test]
    fn rapid_toggle_edges_send_one_command_until_acknowledged() {
        let mut controller = ShortcutActivationController::default();
        let now = Instant::now();

        let commands = [
            controller.handle_edge(ShortcutKeyEdge::Down, DictationShortcutKind::Toggle, now),
            controller.handle_edge(
                ShortcutKeyEdge::Up,
                DictationShortcutKind::Toggle,
                now + Duration::from_millis(20),
            ),
            controller.handle_edge(
                ShortcutKeyEdge::Down,
                DictationShortcutKind::Toggle,
                now + Duration::from_millis(100),
            ),
            controller.handle_edge(
                ShortcutKeyEdge::Up,
                DictationShortcutKind::Toggle,
                now + Duration::from_millis(120),
            ),
        ];

        assert_eq!(
            commands
                .into_iter()
                .flatten()
                .filter(|command| *command == DictationCommand::ToggleListening)
                .count(),
            1
        );
    }

    #[test]
    fn acknowledged_toggle_still_respects_debounce_window() {
        let mut controller = ShortcutActivationController::default();
        let now = Instant::now();

        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Down, DictationShortcutKind::Toggle, now),
            Some(DictationCommand::ToggleListening)
        );
        controller.acknowledge_toggle_command();

        assert_eq!(
            controller.handle_edge(
                ShortcutKeyEdge::Down,
                DictationShortcutKind::Toggle,
                now + TOGGLE_SHORTCUT_DEBOUNCE - Duration::from_millis(1)
            ),
            None
        );
        assert_eq!(
            controller.handle_edge(
                ShortcutKeyEdge::Down,
                DictationShortcutKind::Toggle,
                now + TOGGLE_SHORTCUT_DEBOUNCE
            ),
            Some(DictationCommand::ToggleListening)
        );
    }

    #[test]
    fn unacknowledged_toggle_expires_instead_of_wedging_the_shortcut() {
        let mut controller = ShortcutActivationController::default();
        let now = Instant::now();

        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Down, DictationShortcutKind::Toggle, now),
            Some(DictationCommand::ToggleListening)
        );
        // No ack ever arrives (helper died / permission prompt never called
        // back). Within the expiry the toggle stays suppressed...
        assert_eq!(
            controller.handle_edge(
                ShortcutKeyEdge::Down,
                DictationShortcutKind::Toggle,
                now + TOGGLE_SHORTCUT_DEBOUNCE
            ),
            None
        );
        // ...and past the expiry the shortcut recovers on its own.
        controller.last_toggle_command_at = Some(now - TOGGLE_ACK_EXPIRY);
        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Down, DictationShortcutKind::Toggle, now),
            Some(DictationCommand::ToggleListening)
        );
    }

    #[test]
    fn stuck_finalizing_suppression_expires_instead_of_wedging_the_shortcut() {
        let mut controller = ShortcutActivationController::default();
        let now = Instant::now();

        controller.helper_finalizing_since = Some(now - FINALIZING_SUPPRESSION_EXPIRY);
        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Down, DictationShortcutKind::Toggle, now),
            Some(DictationCommand::ToggleListening)
        );
    }

    #[test]
    fn push_to_talk_during_helper_finalizing_is_dropped() {
        let mut controller = ShortcutActivationController::default();
        let now = Instant::now();

        controller.helper_finalizing_since = Some(now);
        assert_eq!(
            controller.handle_edge(
                ShortcutKeyEdge::Down,
                DictationShortcutKind::PushToTalk,
                now
            ),
            None
        );
        assert_eq!(
            controller.handle_edge(
                ShortcutKeyEdge::Down,
                DictationShortcutKind::PushToTalk,
                now + FINALIZING_SUPPRESSION_EXPIRY
            ),
            Some(DictationCommand::StartListening)
        );
    }

    #[test]
    fn toggle_during_helper_finalizing_is_dropped_without_parity_flip() {
        let mut controller = ShortcutActivationController::default();
        let now = Instant::now();

        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Down, DictationShortcutKind::Toggle, now),
            Some(DictationCommand::ToggleListening)
        );
        controller.acknowledge_toggle_command();
        assert_eq!(
            controller.handle_edge(
                ShortcutKeyEdge::Down,
                DictationShortcutKind::Toggle,
                now + TOGGLE_SHORTCUT_DEBOUNCE
            ),
            Some(DictationCommand::ToggleListening)
        );
        controller.acknowledge_toggle_command();
        controller.mark_helper_finalizing();

        assert_eq!(
            controller.handle_edge(
                ShortcutKeyEdge::Down,
                DictationShortcutKind::Toggle,
                now + TOGGLE_SHORTCUT_DEBOUNCE + Duration::from_secs(1)
            ),
            None
        );
        controller.clear_helper_finalizing();
        assert_eq!(
            controller.handle_edge(
                ShortcutKeyEdge::Down,
                DictationShortcutKind::Toggle,
                now + TOGGLE_SHORTCUT_DEBOUNCE + Duration::from_secs(2)
            ),
            Some(DictationCommand::ToggleListening)
        );
    }

    #[test]
    fn toggle_gate_never_drops_push_to_talk_release() {
        let mut controller = ShortcutActivationController::default();
        let now = Instant::now();

        assert_eq!(
            controller.handle_edge(
                ShortcutKeyEdge::Down,
                DictationShortcutKind::PushToTalk,
                now
            ),
            Some(DictationCommand::StartListening)
        );
        controller.toggle_command_in_flight = true;
        controller.last_toggle_command_at = Some(now);

        assert_eq!(
            controller.handle_edge(
                ShortcutKeyEdge::Up,
                DictationShortcutKind::PushToTalk,
                now + PUSH_TO_TALK_MIN_HOLD
            ),
            Some(DictationCommand::StopAndPaste)
        );
    }

    #[test]
    fn shortcut_activation_ignores_push_while_toggle_active() {
        let mut controller = ShortcutActivationController::default();
        let now = Instant::now();

        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Down, DictationShortcutKind::Toggle, now),
            Some(DictationCommand::ToggleListening)
        );
        assert_eq!(
            controller.handle_edge(
                ShortcutKeyEdge::Down,
                DictationShortcutKind::PushToTalk,
                now
            ),
            None
        );
        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Up, DictationShortcutKind::PushToTalk, now),
            None
        );
    }

    #[test]
    fn external_hands_free_stop_allows_push_to_talk_again() {
        let mut controller = ShortcutActivationController::default();
        let now = Instant::now();

        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Down, DictationShortcutKind::Toggle, now),
            Some(DictationCommand::ToggleListening)
        );
        assert_eq!(
            controller.handle_edge(
                ShortcutKeyEdge::Down,
                DictationShortcutKind::PushToTalk,
                now + Duration::from_millis(1)
            ),
            None
        );

        controller.reset();

        assert_eq!(
            controller.handle_edge(
                ShortcutKeyEdge::Down,
                DictationShortcutKind::PushToTalk,
                now + Duration::from_millis(2)
            ),
            Some(DictationCommand::StartListening)
        );
    }

    #[test]
    fn direct_helper_listening_commands_reset_shortcut_activation() {
        assert!(helper_command_resets_shortcut_activation(
            &serde_json::json!({ "type": "stop_and_paste" })
        ));
        assert!(helper_command_resets_shortcut_activation(
            &serde_json::json!({ "type": "discard_recording" })
        ));
        assert!(helper_command_resets_shortcut_activation(
            &serde_json::json!({ "type": "toggle_listening" })
        ));
        assert!(!helper_command_resets_shortcut_activation(
            &serde_json::json!({ "type": "start_shortcut_capture" })
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dictation_audio_is_normalized_for_transcription() {
        let directory = tempfile::tempdir().expect("tempdir");
        let input = directory.path().join("captured.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&input, spec).expect("create captured wav");
        for sample in [500_i16, 500, -500, -500] {
            writer.write_sample(sample).expect("write sample");
        }
        writer.finalize().expect("finalize captured wav");

        let prepared = prepare_dictation_audio(&input, "test-utterance").expect("normalize wav");
        let reader = hound::WavReader::open(&prepared).expect("open normalized wav");
        assert_ne!(prepared, input);
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.spec().sample_rate, 16_000);
        let _ = fs::remove_file(prepared);
    }

    #[test]
    fn successful_transcription_maps_to_paste_command() {
        let outcome = outcome_from_transcription_result(
            Ok(TranscriptionProviderResult {
                text: "Paste this transcript.".to_string(),
                language: Some("en".to_string()),
                provider: crate::providers::VENICE_PROVIDER.to_string(),
            }),
            None,
            DictationStyle::Standard,
        );

        assert_eq!(
            outcome.helper_command,
            serde_json::json!({
                "type": "paste_text",
                "text": "Paste this transcript.",
            })
        );
        assert!(outcome.event.is_none());
        assert_eq!(
            outcome.transcript.as_ref().map(|item| item.text.as_str()),
            Some("Paste this transcript.")
        );
    }

    #[test]
    fn literal_dictation_starting_with_heres_maps_to_paste_command() {
        let outcome = outcome_from_transcription_result(
            Ok(TranscriptionProviderResult {
                text: "Here's the API key to Poncho.".to_string(),
                language: Some("en".to_string()),
                provider: crate::providers::VENICE_PROVIDER.to_string(),
            }),
            None,
            DictationStyle::Standard,
        );

        assert_eq!(
            outcome.helper_command,
            serde_json::json!({
                "type": "paste_text",
                "text": "Here's the API key to Poncho.",
            })
        );
        assert!(outcome.event.is_none());
        assert_eq!(
            outcome.transcript.as_ref().map(|item| item.text.as_str()),
            Some("Here's the API key to Poncho.")
        );
    }

    #[test]
    fn summary_like_transcription_discards_with_visible_error() {
        let outcome = outcome_from_transcription_result(
            Ok(TranscriptionProviderResult {
                text: "User performed a very long dictation session. Instead of producing a full transcription, the app emitted an error.".to_string(),
                language: Some("en".to_string()),
                provider: crate::providers::VENICE_PROVIDER.to_string(),
            }),
            None,
            DictationStyle::Standard,
        );

        assert_eq!(
            outcome.helper_command,
            serde_json::json!({ "type": "discard_recording" })
        );
        assert!(outcome.transcript.is_none());
        let event = outcome.event.expect("summary-like text emits an error");
        assert_eq!(event["payload"]["code"], "dictation_response_invalid");
        assert!(!is_silent_transcription_error(&event));
    }

    #[test]
    fn filler_only_transcription_discards_silently() {
        let outcome = outcome_from_transcription_result(
            Ok(TranscriptionProviderResult {
                text: "Ums and uhs.".to_string(),
                language: Some("en".to_string()),
                provider: crate::providers::VENICE_PROVIDER.to_string(),
            }),
            None,
            DictationStyle::Standard,
        );

        assert_eq!(
            outcome.helper_command,
            serde_json::json!({ "type": "discard_recording" })
        );
        assert!(outcome.transcript.is_none());
        let event = outcome.event.expect("filler-only capture emits an event");
        assert!(is_silent_transcription_error(&event));
    }

    #[test]
    fn filler_only_transcription_stays_silent_even_with_detected_audio() {
        // Speaking "um" registers real audio, but a filler-only capture must
        // still discard quietly — never the visible audio-without-text error.
        let outcome = outcome_from_transcription_result(
            Ok(TranscriptionProviderResult {
                text: "Um, uh.".to_string(),
                language: Some("en".to_string()),
                provider: crate::providers::VENICE_PROVIDER.to_string(),
            }),
            Some(DICTATION_AUDIO_ACTIVITY_THRESHOLD),
            DictationStyle::Standard,
        );

        assert_eq!(
            outcome.helper_command,
            serde_json::json!({ "type": "discard_recording" })
        );
        assert!(outcome.transcript.is_none());
        let event = outcome.event.expect("filler-only capture emits an event");
        assert!(is_silent_transcription_error(&event));
    }

    #[test]
    fn all_caps_acronym_is_not_treated_as_filler() {
        assert_eq!(
            clean_dictation_fillers("Send the patient to the ER.", DictationStyle::Standard),
            "Send the patient to the ER."
        );
        // The capitalized hesitation form still strips.
        assert_eq!(
            clean_dictation_fillers("Er, no.", DictationStyle::Standard),
            "No."
        );
    }

    #[test]
    fn mixed_filler_transcription_pastes_clean_text() {
        let outcome = outcome_from_transcription_result(
            Ok(TranscriptionProviderResult {
                text: "Um, uh, Send this, please.".to_string(),
                language: Some("en".to_string()),
                provider: crate::providers::VENICE_PROVIDER.to_string(),
            }),
            None,
            DictationStyle::Standard,
        );

        assert_eq!(
            outcome.helper_command,
            serde_json::json!({
                "type": "paste_text",
                "text": "Send this, please.",
            })
        );
        assert!(outcome.event.is_none());
        assert_eq!(
            outcome.transcript.as_ref().map(|item| item.text.as_str()),
            Some("Send this, please.")
        );
    }

    #[test]
    fn mid_sentence_fillers_are_removed_without_touching_articles() {
        assert_eq!(
            clean_dictation_fillers(
                "I, uh, need a test and an example.",
                DictationStyle::Standard
            ),
            "I need a test and an example."
        );
    }

    #[test]
    fn leading_filler_removal_recapitalizes_surviving_first_word() {
        assert_eq!(
            clean_dictation_fillers("Um, can you send this email?", DictationStyle::Standard),
            "Can you send this email?"
        );
        assert_eq!(
            clean_dictation_fillers("Hmm, that is interesting.", DictationStyle::Standard),
            "That is interesting."
        );
        // Mid-sentence fillers don't disturb an already-capitalized start.
        assert_eq!(
            clean_dictation_fillers("The um value is um five.", DictationStyle::Standard),
            "The value is five."
        );
        // Unicode-aware: an accented surviving first word still capitalizes.
        assert_eq!(
            clean_dictation_fillers("um, élan is nice.", DictationStyle::Standard),
            "Élan is nice."
        );
    }

    #[test]
    fn mid_sentence_filler_does_not_recapitalize_brand_or_code_token() {
        // A filler removed mid-sentence must leave the original first word's
        // casing alone — only a *leading* filler triggers re-capitalization.
        assert_eq!(
            clean_dictation_fillers("iPhone, um, battery is low.", DictationStyle::Standard),
            "iPhone battery is low."
        );
        assert_eq!(
            clean_dictation_fillers("camelCase, uh, value.", DictationStyle::Standard),
            "camelCase value."
        );
    }

    #[test]
    fn numeric_dictation_after_filler_is_kept() {
        // "um 123456" must paste the number, not discard as filler-only.
        assert_eq!(
            clean_dictation_fillers("um 123456", DictationStyle::Standard),
            "123456"
        );
        assert_eq!(
            clean_dictation_fillers("Call, uh, 5551234.", DictationStyle::Standard),
            "Call 5551234."
        );
    }

    #[test]
    fn line_breaks_and_paragraphs_are_preserved() {
        // Cleanup-prompt paragraph grouping and spoken "new line" must survive.
        assert_eq!(
            clean_dictation_fillers("First line.\nSecond line.", DictationStyle::Standard),
            "First line.\nSecond line."
        );
        assert_eq!(
            clean_dictation_fillers("Paragraph one.\n\nParagraph two.", DictationStyle::Standard),
            "Paragraph one.\n\nParagraph two."
        );
        // Horizontal whitespace still collapses within a line.
        assert_eq!(
            clean_dictation_fillers("Too    many   spaces.", DictationStyle::Standard),
            "Too many spaces."
        );
    }

    #[test]
    fn filler_before_non_alpha_token_keeps_separator() {
        // The space the filler swallowed must be restored even when the next
        // token is a digit or an opening quote, not just an alphabetic word.
        assert_eq!(
            clean_dictation_fillers("I need um 3 things.", DictationStyle::Standard),
            "I need 3 things."
        );
        assert_eq!(
            clean_dictation_fillers("I said, um, \"hello\".", DictationStyle::Standard),
            "I said \"hello\"."
        );
    }

    #[test]
    fn email_app_bundles_map_to_the_email_context() {
        assert!(is_email_app_bundle("com.apple.mail"));
        assert!(is_email_app_bundle("COM.APPLE.MAIL"));
        assert!(is_email_app_bundle("com.microsoft.Outlook"));
        assert!(!is_email_app_bundle("com.google.Chrome"));
        assert!(!is_email_app_bundle(""));
    }

    #[test]
    fn casual_lowercase_style_keeps_stripped_first_word_lowercase() {
        // The backstop must never re-capitalize under CasualLowercase, even
        // when stripping a leading filler exposes a lowercase first word.
        assert_eq!(
            clean_dictation_fillers(
                "um, can you send this email?",
                DictationStyle::CasualLowercase
            ),
            "can you send this email?"
        );
        // Standard and Formal do restore the capital.
        assert_eq!(
            clean_dictation_fillers("um, can you send this email?", DictationStyle::Formal),
            "Can you send this email?"
        );
    }

    #[test]
    fn standalone_filler_sentence_keeps_neighboring_sentences_separated() {
        assert_eq!(
            clean_dictation_fillers("Let me think. Um. Yeah, do it.", DictationStyle::Standard),
            "Let me think. Yeah, do it."
        );
        // "also" stays lowercase on purpose: this deterministic backstop only
        // restores the casing of a *leading* filler's surviving word, not every
        // sentence start. Re-flowing mid-transcript sentence casing is the LLM
        // cleanup pass's job; the backstop just avoids merging words.
        assert_eq!(
            clean_dictation_fillers("That works. Uh, also add tests.", DictationStyle::Standard),
            "That works. also add tests."
        );
        assert_eq!(
            clean_dictation_fillers("Done! Um. Ship it?", DictationStyle::Standard),
            "Done! Ship it?"
        );
    }

    #[test]
    fn hey_june_transcription_maps_to_agent_session_event() {
        let outcome = outcome_from_transcription_result(
            Ok(TranscriptionProviderResult {
                text: "Hey, June, summarize the open document.".to_string(),
                language: Some("en".to_string()),
                provider: crate::providers::VENICE_PROVIDER.to_string(),
            }),
            None,
            DictationStyle::Standard,
        );

        assert_eq!(
            outcome.helper_command,
            serde_json::json!({ "type": "discard_recording" })
        );
        assert_eq!(
            outcome.event,
            Some(serde_json::json!({
                "type": "agent_session_prompt",
                "payload": { "prompt": "summarize the open document." },
            }))
        );
        assert_eq!(
            outcome.transcript.as_ref().map(|item| item.text.as_str()),
            Some("Hey, June, summarize the open document.")
        );
    }

    #[test]
    fn agent_session_prompt_hides_dictation_hud() {
        assert!(matches!(
            dictation_event_visibility(Some("agent_session_prompt")),
            DictationEventVisibility::Hide
        ));
    }

    #[test]
    fn helper_unavailable_hides_dictation_hud() {
        assert!(matches!(
            dictation_event_visibility(Some("helper_unavailable")),
            DictationEventVisibility::Hide
        ));
    }

    #[test]
    fn hey_june_detection_requires_first_two_words() {
        assert_eq!(
            agent_session_prompt_from_dictation("Hey June open settings").as_deref(),
            Some("open settings")
        );
        assert_eq!(
            agent_session_prompt_from_dictation("Hey Jun open settings").as_deref(),
            Some("open settings")
        );
        assert_eq!(
            agent_session_prompt_from_dictation("Hey Joon open settings").as_deref(),
            Some("open settings")
        );
        assert_eq!(
            agent_session_prompt_from_dictation("well hey june open"),
            None
        );
        assert_eq!(
            agent_session_prompt_from_dictation("hey juniper open"),
            None
        );
    }

    #[test]
    fn empty_transcription_discards_silently() {
        let outcome = outcome_from_transcription_result(
            Ok(TranscriptionProviderResult {
                text: "   ".to_string(),
                language: None,
                provider: crate::providers::VENICE_PROVIDER.to_string(),
            }),
            None,
            DictationStyle::Standard,
        );

        assert_eq!(
            outcome.helper_command,
            serde_json::json!({ "type": "discard_recording" })
        );
        assert!(outcome.transcript.is_none());
        let event = outcome.event.expect("empty capture emits an event");
        assert!(is_silent_transcription_error(&event));
    }

    #[test]
    fn empty_transcription_with_detected_audio_is_visible_error() {
        let outcome = outcome_from_transcription_result(
            Ok(TranscriptionProviderResult {
                text: "   ".to_string(),
                language: None,
                provider: crate::providers::VENICE_PROVIDER.to_string(),
            }),
            Some(DICTATION_AUDIO_ACTIVITY_THRESHOLD),
            DictationStyle::Standard,
        );

        let event = outcome.event.expect("empty capture emits an event");
        assert_eq!(event["payload"]["code"], "dictation_audio_without_text");
        assert_eq!(
            event["payload"]["message"],
            "Dictation detected audio but produced no text. Try again."
        );
        let observed = event["payload"]["observedAudioLevel"]
            .as_f64()
            .expect("observed audio level");
        assert!((observed - 0.04).abs() < 0.001);
        assert!(!is_silent_transcription_error(&event));
    }

    #[test]
    fn recording_ready_info_carries_the_paste_target_bundle_id() {
        let event = serde_json::json!({
            "type": "recording_ready",
            "payload": {
                "path": "/tmp/os-june-dictation-test.m4a",
                "targetBundleIdentifier": "com.apple.mail",
            }
        });
        let info = recording_ready_info_from_event(&event).expect("info parses");
        assert_eq!(info.target_bundle_id.as_deref(), Some("com.apple.mail"));

        // Older helpers omit the field (or send it empty): no target.
        let legacy = serde_json::json!({
            "type": "recording_ready",
            "payload": { "path": "/tmp/os-june-dictation-test.m4a", "targetBundleIdentifier": "" }
        });
        let info = recording_ready_info_from_event(&legacy).expect("info parses");
        assert_eq!(info.target_bundle_id, None);
    }

    #[test]
    fn recording_ready_info_includes_observed_audio_level() {
        let event = serde_json::json!({
            "type": "recording_ready",
            "payload": {
                "path": "/tmp/os-june-dictation-test.m4a",
                "observedAudioLevel": "0.1732",
            }
        });

        let info = recording_ready_info_from_event(&event).expect("recording info");

        assert_eq!(
            info.audio_path,
            PathBuf::from("/tmp/os-june-dictation-test.m4a")
        );
        assert_eq!(info.observed_audio_level, Some(0.1732));
    }

    #[test]
    fn dictation_text_empty_error_is_silent() {
        let event = app_error_event(AppError::new("june_request_failed", "dictation_text_empty"));
        assert!(is_silent_transcription_error(&event));
    }

    #[test]
    fn accessibility_permission_missing_error_is_visible() {
        // The dictation helper emits this when Accessibility trust is missing,
        // so the synthetic Cmd+V paste can't fire. The transcript is left on
        // the clipboard and the user must be told: it must render as a real
        // HUD error, never be swallowed as a "nothing recorded" silent case.
        let mut event = serde_json::json!({
            "type": "error",
            "payload": {
                "code": "accessibility_permission_missing",
                "message": "June couldn't paste automatically. Your transcript is on the clipboard, so you can paste it with Cmd+V.",
            }
        });
        assert!(!is_silent_transcription_error(&event));
        annotate_silent_error(&mut event);
        assert_eq!(event["payload"]["silent"], false);
    }

    #[test]
    fn paste_target_unavailable_error_is_visible() {
        // The dictation helper emits this when the app that was frontmost as
        // the recording stopped has since quit, so there is nowhere safe to
        // send the synthetic Cmd+V. Like the Accessibility case, the
        // transcript is left on the clipboard and the user must be told.
        let mut event = serde_json::json!({
            "type": "error",
            "payload": {
                "code": "paste_target_unavailable",
                "message": "June couldn't paste automatically. Your transcript is on the clipboard, so you can paste it with Cmd+V.",
            }
        });
        assert!(!is_silent_transcription_error(&event));
        annotate_silent_error(&mut event);
        assert_eq!(event["payload"]["silent"], false);
    }

    #[test]
    fn dictation_event_log_redacts_transcript_text() {
        let event = serde_json::json!({
            "type": "final_transcript",
            "payload": {
                "text": "Sensitive dictated sentence."
            }
        });

        let entry = dictation_event_log_entry("final_transcript", &event);

        assert_eq!(entry["type"], "final_transcript");
        assert_eq!(entry["textChars"], 28);
        assert!(entry.to_string().contains("textChars"));
        assert!(!entry.to_string().contains("Sensitive dictated sentence"));
    }

    #[test]
    fn dictation_event_log_records_silent_error_code() {
        let mut event = serde_json::json!({
            "type": "error",
            "payload": {
                "code": "missing_recording",
                "message": "No recorded audio was available to transcribe."
            }
        });
        annotate_silent_error(&mut event);

        let entry = dictation_event_log_entry("error", &event);

        assert_eq!(entry["code"], "missing_recording");
        assert_eq!(entry["silent"], true);
        assert_eq!(
            entry["message"],
            "No recorded audio was available to transcribe."
        );
    }

    #[test]
    fn failed_transcription_maps_to_discard_and_error() {
        let outcome = outcome_from_transcription_result(
            Err(AppError::new(
                "transcription_failed",
                "The provider failed.",
            )),
            None,
            DictationStyle::Standard,
        );

        assert_eq!(
            outcome.helper_command,
            serde_json::json!({ "type": "discard_recording" })
        );
        assert_eq!(
            outcome.event,
            Some(serde_json::json!({
                "type": "error",
                "payload": {
                    "code": "transcription_failed",
                    "message": "The provider failed.",
                },
            }))
        );
        assert!(outcome.transcript.is_none());
    }

    #[test]
    fn no_speech_error_with_detected_audio_is_visible_error() {
        let outcome = outcome_from_transcription_result(
            Err(AppError::new("june_request_failed", "no_speech")),
            Some(0.2),
            DictationStyle::Standard,
        );

        let event = outcome.event.expect("no speech emits an event");
        assert_eq!(event["payload"]["code"], "dictation_audio_without_text");
        assert_eq!(event["payload"]["underlyingCode"], "june_request_failed");
        assert_eq!(event["payload"]["underlyingMessage"], "no_speech");
        assert!(!is_silent_transcription_error(&event));
    }

    #[test]
    fn dictation_rejects_unsupported_provider() {
        let err = dictation_transcription_provider("mock".to_string())
            .expect_err("dictation should only accept supported transcripts");

        assert_eq!(err.code, "dictation_provider_not_configured");
    }

    #[test]
    fn dictation_accepts_openai_provider() {
        assert_eq!(
            dictation_transcription_provider(crate::providers::OPENAI_PROVIDER.to_string())
                .expect("openai should be accepted"),
            crate::providers::OPENAI_PROVIDER
        );
    }

    #[test]
    fn dictation_context_guides_clean_hands_free_typing() {
        let context = dictation_transcription_context(DictationStyle::Standard);

        assert!(context.contains("hands-free dictation"));
        assert!(context.contains("Remove filler sounds"));
        assert!(context.contains("quote/unquote"));
        assert!(context.contains("actual quotation marks"));
        assert!(context.contains("Do not remove intentional articles"));
    }

    #[test]
    fn dictation_context_includes_selected_style() {
        let context = dictation_transcription_context(DictationStyle::CasualLowercase);

        assert!(context.contains("Writing style: casual lowercase"));
        assert!(context.contains("Use lowercase"));
    }

    #[test]
    fn detects_instruction_responses_from_cleanup() {
        assert!(looks_like_instruction_response(
            "Sure, here is the rewritten text: Hello."
        ));
        assert!(looks_like_instruction_response(
            "Here is the normalized transcript: Hello."
        ));
        assert!(looks_like_instruction_response(
            "Here is the corrected transcript: Hello."
        ));
        assert!(looks_like_instruction_response(
            "Here’s the corrected transcript: Hello."
        ));
        assert!(looks_like_instruction_response("Here you go: Hello."));
        assert!(looks_like_instruction_response(
            "Here is the transcript: Hello."
        ));
        assert!(looks_like_instruction_response(
            "Here are the cleaned notes: Hello."
        ));
        assert!(looks_like_instruction_response(
            "Here's the cleaned-up version: Hello."
        ));
        assert!(looks_like_instruction_response(
            "Here is the corrected transcript. Hello."
        ));
        assert!(looks_like_instruction_response(
            "Here are the cleaned notes - Hello."
        ));
        assert!(looks_like_instruction_response(
            "Here is the corrected text\nHello."
        ));
        assert!(looks_like_instruction_response(
            "Here is the corrected transcript, Hello."
        ));
        assert!(looks_like_instruction_response(
            "Here is the corrected, punctuated transcript: Hello."
        ));
        assert!(looks_like_instruction_response(
            "Here you go, Hello. World."
        ));
        assert!(looks_like_instruction_response(
            "Here's the cleaned-up version—Hello."
        ));
        assert!(looks_like_instruction_response("Here it is: Hello."));
        assert!(looks_like_instruction_response("Here you are: Hello."));
        assert!(looks_like_instruction_response(
            "Here is the cleaned dictation: Hello."
        ));
        assert!(looks_like_instruction_response(
            "Here is the result: Hello."
        ));
        assert!(looks_like_instruction_response(
            "Here is the cleaned content: Hello."
        ));
        assert!(looks_like_instruction_response(
            "Here is the cleaned output: Hello."
        ));
        assert!(looks_like_instruction_response("Here is the transcript."));
        assert!(looks_like_instruction_response("Here you go."));
        assert!(looks_like_instruction_response("Here you go!"));
        assert!(looks_like_instruction_response("Here is the transcript?"));
        assert!(looks_like_instruction_response(
            "Here's the cleaned-up message: Hello."
        ));
        assert!(looks_like_instruction_response("Here is the email: Hello."));
        assert!(!looks_like_instruction_response(
            "Here's your text message from John."
        ));
        assert!(!looks_like_instruction_response(
            "Here's your text message from John. Call him back."
        ));
        assert!(!looks_like_instruction_response(
            "Here's the result of the game."
        ));
        assert!(!looks_like_instruction_response(
            "Here's my notes on the trip."
        ));
        assert!(looks_like_instruction_response(
            "Here is what I heard: Send it today."
        ));
        assert!(looks_like_instruction_response(
            "Here's what I got: Send it today."
        ));
        assert!(looks_like_instruction_response(
            "Here, I've cleaned it up: Send it today."
        ));
        assert!(!looks_like_instruction_response(
            "Here, I think we should send it today."
        ));
        assert!(looks_like_instruction_response(
            "Here's a cleaned-up copy: Send it today."
        ));
        assert!(looks_like_instruction_response(
            "Here's the rewritten draft: Send it today."
        ));
        assert!(looks_like_instruction_response(
            "Here are the improvements: Send it today."
        ));
        assert!(looks_like_instruction_response(
            "Here is what you said: Send it today."
        ));
        assert!(looks_like_instruction_response(
            "Here is the transcription: Send it today."
        ));
        assert!(looks_like_instruction_response(
            "Here you go! Send it today."
        ));
        assert!(looks_like_instruction_response(
            "Here is the transcript? Send it today."
        ));
        assert!(looks_like_instruction_response(
            "The transcript ends here without additional context. The user did not ask a question."
        ));
        assert!(looks_like_instruction_response(
            "Bug Report Assessment: The user performed a long dictation session."
        ));
        assert!(looks_like_instruction_response(
            "User report summary: User performed a long dictation session."
        ));
        assert!(!looks_like_instruction_response("Hello, \"testing\"."));
        assert!(!looks_like_instruction_response(
            "The user story for this sprint covers the dictation page."
        ));
        assert!(!looks_like_instruction_response(
            "User reported the bug to support."
        ));
        assert!(!looks_like_instruction_response(
            "Here's the API key to Poncho."
        ));
        assert!(!looks_like_instruction_response(
            "Here’s the API key to Poncho."
        ));
        assert!(!looks_like_instruction_response("I’ll send the agenda."));
    }

    #[test]
    fn cleanup_timeout_keeps_base_budget_for_short_dictations() {
        // A quick one-liner should not wait longer than the historical 15s.
        assert_eq!(
            dictation_cleanup_timeout("Send the doc to Sarah today".len()),
            Duration::from_millis(DICTATION_CLEANUP_BASE_TIMEOUT_MS + 27 * 5),
        );
        assert_eq!(
            dictation_cleanup_timeout(0),
            Duration::from_millis(DICTATION_CLEANUP_BASE_TIMEOUT_MS),
        );
    }

    #[test]
    fn cleanup_timeout_scales_with_long_rambling_dictations() {
        // JUN-212: a long rambling dictation timed out of the flat 15s cleanup
        // budget and pasted raw, unpunctuated ASR text. Model the reported
        // transcript: minutes of continuous filler-heavy speech, several
        // thousand bytes long.
        let reported_fragment = "side nav and everything Like it looks really sharp you \
             know meeting should kind of be or medium should kind of be used like sparingly ";
        let long_rambling_transcript = reported_fragment.repeat(40);
        let budget = dictation_cleanup_timeout(long_rambling_transcript.len());

        assert!(
            budget > Duration::from_millis(DICTATION_CLEANUP_BASE_TIMEOUT_MS),
            "a long dictation must get more than the base cleanup budget"
        );
        assert!(
            budget <= Duration::from_millis(DICTATION_CLEANUP_MAX_TIMEOUT_MS),
            "the cleanup budget must stay bounded"
        );
    }

    /// The JUN-212 transcript shape: minutes of unpunctuated, filler-heavy,
    /// run-on speech, with stray mid-text capitals from the ASR pass.
    fn jun_212_style_transcript() -> String {
        "side nav and everything Like it looks really sharp you know meeting \
         should kind of be or medium should kind of be used like sparingly \
         because when everything is bold nothing is bold right and then I was \
         thinking about the onboarding flow because we still have that drop \
         off on the second step "
            .repeat(12)
            .trim()
            .to_string()
    }

    #[test]
    fn short_dictations_stay_one_cleanup_chunk() {
        let text = "just a quick note about the design review tomorrow";
        assert_eq!(
            split_dictation_cleanup_chunks(text, DICTATION_CLEANUP_CHUNK_TARGET_BYTES),
            vec![text]
        );
    }

    #[test]
    fn long_rambling_dictations_split_at_word_boundaries_and_keep_every_word() {
        let transcript = jun_212_style_transcript();
        let chunks =
            split_dictation_cleanup_chunks(&transcript, DICTATION_CLEANUP_CHUNK_TARGET_BYTES);

        assert!(chunks.len() > 1, "a long dictation must be chunked");
        for chunk in &chunks {
            // A chunk may overrun the target only until the next whitespace.
            assert!(
                chunk.len() <= DICTATION_CLEANUP_CHUNK_TARGET_BYTES + 40,
                "chunk of {} bytes overruns the target too far",
                chunk.len()
            );
            assert!(!chunk.is_empty());
            assert!(!chunk.starts_with(char::is_whitespace));
            assert!(!chunk.ends_with(char::is_whitespace));
        }
        // Chunking must never cost the speaker a single word.
        assert_eq!(chunks.join(" "), transcript);
    }

    #[test]
    fn whitespace_free_text_stays_one_cleanup_chunk() {
        // Unsegmented text (e.g. CJK with no spaces) has no safe cut points.
        let text = "x".repeat(2_000);
        assert_eq!(
            split_dictation_cleanup_chunks(&text, DICTATION_CLEANUP_CHUNK_TARGET_BYTES),
            vec![text.as_str()]
        );
    }

    #[test]
    fn unpunctuated_echo_of_a_long_chunk_triggers_a_retry() {
        let input = jun_212_style_transcript();
        let chunk = &input[..500];

        // The echo failure: same run-on words back, zero punctuation.
        assert!(cleaned_chunk_lacks_sentence_punctuation(chunk, chunk));
        // A punctuated cleaning passes.
        assert!(!cleaned_chunk_lacks_sentence_punctuation(
            chunk,
            "The side nav looks really sharp. Meeting should be used sparingly."
        ));
        // A short chunk may legitimately be one unterminated sentence.
        assert!(!cleaned_chunk_lacks_sentence_punctuation(
            "add milk to the shopping list",
            "add milk to the shopping list"
        ));
    }

    #[test]
    fn joining_cleaned_chunks_preserves_boundary_line_breaks() {
        let chunks = vec![
            "First topic wrapped up.\n\n".to_string(),
            "Second topic starts here.".to_string(),
            String::new(),
            "And a closing thought.".to_string(),
        ];
        assert_eq!(
            join_cleaned_dictation_chunks(&chunks),
            "First topic wrapped up.\n\nSecond topic starts here. And a closing thought."
        );

        // A break the model emitted at the START of the next chunk survives
        // too, without picking up a stray space before it.
        let leading_break = vec![
            "First topic wrapped up.".to_string(),
            "\n\nSecond topic starts here.".to_string(),
        ];
        assert_eq!(
            join_cleaned_dictation_chunks(&leading_break),
            "First topic wrapped up.\n\nSecond topic starts here."
        );
    }

    #[test]
    fn joining_cleaned_chunks_attaches_leading_punctuation() {
        // A spoken "comma" or "period" right after the split point makes the
        // next cleaned chunk start with the mark; it must attach to the
        // previous word instead of floating after a space.
        let chunks = vec![
            "we shipped the fix".to_string(),
            ", and the tests are green.".to_string(),
        ];
        assert_eq!(
            join_cleaned_dictation_chunks(&chunks),
            "we shipped the fix, and the tests are green."
        );
    }

    #[test]
    fn chunk_trim_keeps_edge_line_breaks_but_drops_spaces() {
        assert_eq!(
            trim_cleaned_dictation_chunk("  New paragraph next.\n\n \t"),
            "New paragraph next.\n\n"
        );
        assert_eq!(
            trim_cleaned_dictation_chunk("\n\nStarts on a new paragraph."),
            "\n\nStarts on a new paragraph."
        );
        assert_eq!(trim_cleaned_dictation_chunk(" plain text "), "plain text");
    }

    #[test]
    fn cleanup_timeout_is_capped_at_the_maximum() {
        // MAX_DICTATION_TEXT_CHARS upstream is 20k; even that never waits
        // longer than the cap, and absurd lengths cannot overflow.
        assert_eq!(
            dictation_cleanup_timeout(20_000),
            Duration::from_millis(DICTATION_CLEANUP_MAX_TIMEOUT_MS),
        );
        assert_eq!(
            dictation_cleanup_timeout(usize::MAX),
            Duration::from_millis(DICTATION_CLEANUP_MAX_TIMEOUT_MS),
        );
    }

    #[test]
    fn treats_empty_provider_transcript_as_silent_error() {
        let event = serde_json::json!({
            "type": "error",
            "payload": {
                "code": "transcription_empty",
                "message": "OpenAI did not return any transcript text."
            }
        });

        assert!(is_silent_transcription_error(&event));
    }

    #[test]
    fn dictation_not_signed_in_event_carries_actionable_code() {
        let mut event = dictation_not_signed_in_event();
        annotate_silent_error(&mut event);

        assert_eq!(event["type"], "error");
        assert_eq!(event["payload"]["code"], "not_signed_in");
        assert_eq!(event["payload"]["message"], "Sign in to use dictation.");
        // Must be classified as non-silent so the HUD renders the actionable
        // message instead of the "Nothing recorded" terminal state.
        assert_eq!(event["payload"]["silent"], false);
    }

    #[test]
    fn dictation_auth_gate_keeps_recording_on_transient_failure() {
        let transient: Result<String, AppError> = Err(AppError::new(
            "auth_refresh_unavailable",
            "Couldn't reach your account.",
        ));
        assert!(matches!(
            classify_dictation_auth(&transient),
            DictationAuthGate::Unavailable(_)
        ));
    }

    #[test]
    fn dictation_auth_gate_signs_out_on_genuine_rejection() {
        let signed_out: Result<String, AppError> =
            Err(AppError::new("signed_out", "Not signed in."));
        assert!(matches!(
            classify_dictation_auth(&signed_out),
            DictationAuthGate::SignedOut
        ));
        let expired: Result<String, AppError> = Err(AppError::new(
            "session_expired",
            "Your session expired. Sign in again.",
        ));
        assert!(matches!(
            classify_dictation_auth(&expired),
            DictationAuthGate::SignedOut
        ));
    }

    #[test]
    fn dictation_auth_gate_proceeds_with_a_token() {
        let ok: Result<String, AppError> = Ok("token".to_string());
        assert!(matches!(
            classify_dictation_auth(&ok),
            DictationAuthGate::Proceed
        ));
    }

    #[test]
    fn transient_auth_error_renders_as_a_visible_hud_error() {
        // The kept-recording branch emits app_error_event for the transient
        // failure; it must not be silent-classified, or the HUD would swallow
        // it and the user would see nothing after their dictation vanished.
        let error = AppError::new(
            "auth_refresh_unavailable",
            "Couldn't reach your account. Try again in a moment.",
        );
        let mut event = app_error_event(error);
        annotate_silent_error(&mut event);

        assert_eq!(event["type"], "error");
        assert_eq!(event["payload"]["code"], "auth_refresh_unavailable");
        assert_eq!(event["payload"]["silent"], false);
        assert!(!is_silent_transcription_error(&event));
    }
}
