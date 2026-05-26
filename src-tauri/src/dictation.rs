use crate::domain::types::AppError;
use crate::providers::{
    configured_transcription_provider,
    transcription::{transcribe_saved_audio, TranscriptionProviderResult, TranscriptionRequest},
    OPENAI_PROVIDER, VENICE_PROVIDER,
};
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State};

pub struct HelperProcess {
    child: Child,
    stdin: ChildStdin,
}

pub struct HelperState {
    process: Mutex<Option<HelperProcess>>,
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

pub struct ShortcutActivationState {
    controller: Mutex<ShortcutActivationController>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DictationSettings {
    pub shortcut: DictationShortcutSetting,
    pub activation_mode: DictationActivationMode,
    pub microphone: DictationMicrophoneSetting,
}

impl Default for DictationSettings {
    fn default() -> Self {
        Self {
            shortcut: DictationShortcutSetting::bare_fn(),
            activation_mode: DictationActivationMode::default(),
            microphone: DictationMicrophoneSetting::default(),
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
            shortcut: Option<DictationShortcutSetting>,
            activation_mode: Option<DictationActivationMode>,
            microphone: Option<DictationMicrophoneSetting>,
        }

        let value = serde_json::Value::deserialize(deserializer)?;
        let has_activation_mode = value.get("activationMode").is_some();
        let settings: SettingsValue =
            serde_json::from_value(value).map_err(serde::de::Error::custom)?;

        Ok(Self {
            shortcut: if has_activation_mode {
                settings
                    .shortcut
                    .unwrap_or_else(DictationShortcutSetting::bare_fn)
            } else {
                DictationShortcutSetting::bare_fn()
            },
            activation_mode: settings.activation_mode.unwrap_or_default(),
            microphone: settings.microphone.unwrap_or_default(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationShortcutSetting {
    pub key_code: u32,
    pub code: String,
    pub modifiers: DictationShortcutModifiers,
    pub label: String,
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
        }

        let value = serde_json::Value::deserialize(deserializer)?;
        if let Some(shortcut) = value.as_str() {
            return legacy_shortcut_setting(shortcut)
                .ok_or_else(|| serde::de::Error::custom("unknown legacy shortcut"));
        }

        let shortcut: ShortcutSettingValue =
            serde_json::from_value(value).map_err(serde::de::Error::custom)?;
        Ok(Self {
            key_code: shortcut.key_code,
            code: shortcut.code,
            modifiers: shortcut.modifiers,
            label: shortcut.label,
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
        }
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationShortcutInput {
    pub code: String,
    pub modifiers: DictationShortcutModifiers,
    pub label: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DictationActivationMode {
    #[default]
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
pub struct DictationSettingsResponse {
    pub settings: DictationSettings,
}

#[derive(Debug, Default)]
struct ShortcutActivationController {
    is_down: bool,
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
    ToggleListening,
}

impl ShortcutActivationController {
    fn handle_edge(
        &mut self,
        edge: ShortcutKeyEdge,
        mode: DictationActivationMode,
    ) -> Option<DictationCommand> {
        match (mode, edge) {
            (DictationActivationMode::PushToTalk, ShortcutKeyEdge::Down) => {
                if self.is_down {
                    None
                } else {
                    self.is_down = true;
                    Some(DictationCommand::StartListening)
                }
            }
            (DictationActivationMode::PushToTalk, ShortcutKeyEdge::Up) => {
                if self.is_down {
                    self.is_down = false;
                    Some(DictationCommand::StopAndPaste)
                } else {
                    None
                }
            }
            (DictationActivationMode::Toggle, ShortcutKeyEdge::Down) => {
                if self.is_down {
                    None
                } else {
                    self.is_down = true;
                    Some(DictationCommand::ToggleListening)
                }
            }
            (DictationActivationMode::Toggle, ShortcutKeyEdge::Up) => {
                self.is_down = false;
                None
            }
        }
    }

    fn reset(&mut self) {
        self.is_down = false;
    }
}

impl DictationCommand {
    fn helper_command(self, shortcut_label: &str) -> serde_json::Value {
        match self {
            Self::StartListening => serde_json::json!({ "type": "start_listening" }),
            Self::StopAndPaste => serde_json::json!({ "type": "stop_and_paste" }),
            Self::ToggleListening => serde_json::json!({
                "type": "toggle_listening",
                "shortcut": shortcut_label,
            }),
        }
    }
}

impl DictationShortcutInput {
    fn into_setting(self) -> Result<DictationShortcutSetting, AppError> {
        if self.code.trim().is_empty() || self.label.trim().is_empty() {
            return Err(AppError::new(
                "dictation_shortcut_incomplete",
                "Shortcut is incomplete.",
            ));
        }

        if is_bare_fn_input(&self.code, &self.modifiers) {
            return Ok(DictationShortcutSetting::bare_fn());
        }

        let key_code = key_code_for_code(&self.code).ok_or_else(|| {
            AppError::new(
                "dictation_shortcut_unsupported",
                "Shortcut key is not supported.",
            )
        })?;

        let has_modifier = self.modifiers.command
            || self.modifiers.control
            || self.modifiers.option
            || self.modifiers.shift
            || self.modifiers.function;
        if !has_modifier {
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
        })
    }
}

fn is_bare_fn_input(code: &str, modifiers: &DictationShortcutModifiers) -> bool {
    code.eq_ignore_ascii_case("Fn") && modifiers.function && no_standard_modifiers(modifiers)
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
        }),
        "control_option_space" => Some(DictationShortcutSetting {
            key_code: 0x31,
            code: "Space".to_string(),
            modifiers: DictationShortcutModifiers {
                control: true,
                option: true,
                ..DictationShortcutModifiers::default()
            },
            label: "Ctrl+Opt+Space".to_string(),
        }),
        _ => None,
    }
}

fn is_bare_fn_shortcut(shortcut: &DictationShortcutSetting) -> bool {
    shortcut.code.eq_ignore_ascii_case("Fn")
        && shortcut.modifiers.function
        && no_standard_modifiers(&shortcut.modifiers)
}

fn no_standard_modifiers(modifiers: &DictationShortcutModifiers) -> bool {
    !modifiers.command && !modifiers.control && !modifiers.option && !modifiers.shift
}

pub fn setup(app: &mut tauri::App) {
    if let Err(error) = configure_hud_window(app.handle()) {
        eprintln!("failed to configure dictation HUD: {error}");
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
            let _ = apply_shortcut_setting(&helper_state, &settings.shortcut);
        }
    }

    #[cfg(target_os = "macos")]
    {
        let shortcut = app
            .state::<DictationSettingsState>()
            .settings
            .lock()
            .map(|settings| settings.shortcut.clone())
            .unwrap_or_else(|_| DictationShortcutSetting::bare_fn());
        let event = hotkey_ready_event(&shortcut);

        app.manage(HotkeyStatus {
            event: Mutex::new(event.clone()),
        });
        let _ = app.emit("dictation-event", event.to_string());
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
#[cfg(target_os = "macos")]
pub fn set_dictation_shortcut(
    app: AppHandle,
    state: State<'_, DictationSettingsState>,
    helper_state: State<'_, HelperState>,
    hotkey_status: State<'_, HotkeyStatus>,
    shortcut: DictationShortcutInput,
) -> Result<DictationSettings, AppError> {
    let shortcut = shortcut.into_setting()?;
    let current_settings = state
        .settings
        .lock()
        .map_err(|_| AppError::new("dictation_settings_unavailable", "Settings lock failed."))?
        .clone();

    if current_settings.shortcut == shortcut {
        set_hotkey_status(&hotkey_status, hotkey_ready_event(&shortcut));
        apply_shortcut_setting(&helper_state, &shortcut)?;
        return Ok(current_settings);
    }

    let settings = update_settings(&state, |settings| {
        settings.shortcut = shortcut;
    })?;
    reset_shortcut_activation(&app);
    apply_shortcut_setting(&helper_state, &settings.shortcut)?;

    set_hotkey_status(&hotkey_status, hotkey_ready_event(&settings.shortcut));
    Ok(settings)
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
    apply_microphone_setting(&helper_state, &settings.microphone)?;
    Ok(settings)
}

#[tauri::command]
pub fn set_dictation_activation_mode(
    app: AppHandle,
    state: State<'_, DictationSettingsState>,
    activation_mode: DictationActivationMode,
) -> Result<DictationSettings, AppError> {
    let settings = update_settings(&state, |settings| {
        settings.activation_mode = activation_mode;
    })?;
    reset_shortcut_activation(&app);
    Ok(settings)
}

#[tauri::command]
pub fn dictation_helper_command(
    state: State<'_, HelperState>,
    command: serde_json::Value,
) -> Result<(), AppError> {
    send_helper_command(&state, command)
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

pub fn stop_helper(app: &AppHandle) {
    let state = app.state::<HelperState>();
    let Ok(mut guard) = state.process.lock() else {
        return;
    };
    let Some(mut process) = guard.take() else {
        return;
    };

    let _ = process.stdin.write_all(b"{\"type\":\"shutdown\"}\n");
    let _ = process.stdin.flush();
    let _ = process.child.kill();
    let _ = process.child.wait();
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
                "modifiers": shortcut.modifiers,
            },
        }),
    )
}

fn handle_shortcut_key_event(app: &AppHandle, event_type: Option<&str>) {
    let Some(event_type) = event_type else {
        return;
    };

    let edge = match event_type {
        "fn_key_down" | "shortcut_key_down" => ShortcutKeyEdge::Down,
        "fn_key_up" | "shortcut_key_up" => ShortcutKeyEdge::Up,
        _ => return,
    };

    let Some(settings) = current_dictation_settings(app) else {
        reset_shortcut_activation(app);
        return;
    };

    if matches!(event_type, "fn_key_down" | "fn_key_up") && !is_bare_fn_shortcut(&settings.shortcut)
    {
        reset_shortcut_activation(app);
        return;
    }

    let command = app
        .try_state::<ShortcutActivationState>()
        .and_then(|state| {
            state
                .controller
                .lock()
                .ok()
                .and_then(|mut state| state.handle_edge(edge, settings.activation_mode))
        });

    if let Some(command) = command {
        send_dictation_command(app, command, &settings.shortcut.label);
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

fn send_dictation_command(app: &AppHandle, command: DictationCommand, shortcut_label: &str) {
    let Some(state) = app.try_state::<HelperState>() else {
        emit_dictation_event_value(
            app,
            app_error_event(AppError::new(
                "dictation_helper_unavailable",
                "Dictation helper process is not running.",
            )),
        );
        return;
    };

    if let Err(error) = send_helper_command(&state, command.helper_command(shortcut_label)) {
        emit_dictation_event_value(app, app_error_event(error));
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
        if let Some(repo_dir) = manifest_dir.parent() {
            paths.push(
                repo_dir
                    .join(".tauri-helper")
                    .join("OS Scribe Dictation Helper.app")
                    .join("Contents")
                    .join("MacOS")
                    .join("os-scribe-dictation-helper"),
            );
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            paths.push(exe_dir.join("os-scribe-dictation-helper"));
            paths.push(exe_dir.join("../Resources/os-scribe-dictation-helper"));
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        paths.push(resource_dir.join("os-scribe-dictation-helper"));
        paths.push(
            resource_dir
                .join("native")
                .join("bin")
                .join("OS Scribe Dictation Helper.app")
                .join("Contents")
                .join("MacOS")
                .join("os-scribe-dictation-helper"),
        );
        paths.push(
            resource_dir
                .join("OS Scribe Dictation Helper.app")
                .join("Contents")
                .join("MacOS")
                .join("os-scribe-dictation-helper"),
        );
    }

    paths
}

fn spawn_helper(app: &AppHandle) -> Result<HelperProcess, AppError> {
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

    let output_app = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            handle_helper_event_line(&output_app, line);
        }
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

fn handle_helper_event_line(app: &AppHandle, line: String) {
    let event = serde_json::from_str::<serde_json::Value>(&line).ok();
    let event_type = event
        .as_ref()
        .and_then(|event| event.get("type"))
        .and_then(serde_json::Value::as_str);

    handle_shortcut_key_event(app, event_type);

    if matches!(event_type, Some("recording_ready")) {
        if let Some(event) = event.as_ref() {
            match recording_path_from_event(event) {
                Ok(audio_path) => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        transcribe_recording_ready(app, audio_path).await;
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

    update_latest_event(app, event_type, Some(line.clone()));
    update_hud_window(app, event_type, event.as_ref());
    let _ = app.emit("dictation-event", line);
}

async fn transcribe_recording_ready(app: AppHandle, audio_path: PathBuf) {
    let provider = match dictation_transcription_provider(configured_transcription_provider()) {
        Ok(provider) => provider,
        Err(error) => {
            let state = app.state::<HelperState>();
            let _ = send_helper_command(&state, serde_json::json!({ "type": "discard_recording" }));
            emit_dictation_event_value(&app, app_error_event(error));
            return;
        }
    };
    let result = transcribe_saved_audio(TranscriptionRequest {
        provider,
        audio_path,
        title: "Dictation".to_string(),
        context: None,
    })
    .await;
    let outcome = outcome_from_transcription_result(result);
    let state = app.state::<HelperState>();
    if let Err(error) = send_helper_command(&state, outcome.helper_command) {
        emit_dictation_event_value(&app, app_error_event(error));
        return;
    }
    if let Some(event) = outcome.event {
        emit_dictation_event_value(&app, event);
    }
}

fn dictation_transcription_provider(provider: String) -> Result<String, AppError> {
    if provider != OPENAI_PROVIDER && provider != VENICE_PROVIDER {
        return Err(AppError::new(
            "dictation_provider_not_configured",
            "Dictation requires OpenAI transcription. Set OPENAI_API_KEY in .env or in the shell that launches Tauri.",
        ));
    }
    Ok(provider)
}

fn recording_path_from_event(event: &serde_json::Value) -> Result<PathBuf, AppError> {
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
    Ok(PathBuf::from(path))
}

#[derive(Debug)]
struct DictationTranscriptionOutcome {
    helper_command: serde_json::Value,
    event: Option<serde_json::Value>,
}

fn outcome_from_transcription_result(
    result: Result<TranscriptionProviderResult, AppError>,
) -> DictationTranscriptionOutcome {
    match result {
        Ok(transcript) => DictationTranscriptionOutcome {
            helper_command: serde_json::json!({
                "type": "paste_text",
                "text": transcript.text,
            }),
            event: None,
        },
        Err(error) => DictationTranscriptionOutcome {
            helper_command: serde_json::json!({ "type": "discard_recording" }),
            event: Some(app_error_event(error)),
        },
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

fn emit_dictation_event_value(app: &AppHandle, event: serde_json::Value) {
    let event_type = event.get("type").and_then(serde_json::Value::as_str);
    let line = event.to_string();
    update_latest_event(app, event_type, Some(line.clone()));
    update_hud_window(app, event_type, Some(&event));
    let _ = app.emit("dictation-event", line);
}

fn update_hud_window(app: &AppHandle, event_type: Option<&str>, event: Option<&serde_json::Value>) {
    match dictation_event_visibility(event_type) {
        DictationEventVisibility::Show if should_show_hud_window_for_type(event_type) => {
            show_hud_window(app)
        }
        DictationEventVisibility::Hide => {
            schedule_hud_hide(app, hud_hide_delay_for_event(event_type, event))
        }
        DictationEventVisibility::Show | DictationEventVisibility::Ignore => {}
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
        Some("paste_completed" | "error" | "shutdown_ack") => DictationEventVisibility::Hide,
        _ => DictationEventVisibility::Ignore,
    }
}

fn should_show_hud_window_for_type(event_type: Option<&str>) -> bool {
    !matches!(event_type, Some("audio_level"))
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

    matches!(code, "no_speech" | "no_transcription" | "empty_transcript")
        || message == "OpenAI did not return any transcript text."
}

fn show_hud_window(app: &AppHandle) {
    if let Some(hud) = app.get_webview_window("hud") {
        position_hud_window(&hud);
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

fn position_hud_window(hud: &tauri::WebviewWindow) {
    const HUD_BOTTOM_MARGIN: i32 = 12;

    let monitor = hud
        .cursor_position()
        .ok()
        .and_then(|cursor| hud.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| hud.current_monitor().ok().flatten())
        .or_else(|| hud.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        return;
    };
    let Ok(window_size) = hud.outer_size() else {
        return;
    };

    let work_area = monitor.work_area();
    let x = work_area.position.x
        + ((work_area.size.width as i32).saturating_sub(window_size.width as i32) / 2);
    let y = work_area.position.y + work_area.size.height as i32
        - window_size.height as i32
        - HUD_BOTTOM_MARGIN;

    let _ = hud.set_position(PhysicalPosition::new(x, y));
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
        hud.set_shadow(false).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn hotkey_ready_event(shortcut: &DictationShortcutSetting) -> serde_json::Value {
    serde_json::json!({
        "type": "hotkey_trigger_ready",
        "payload": {
            "shortcut": shortcut.label,
            "shortcuts": shortcut.label,
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

    #[test]
    fn default_settings_use_bare_fn() {
        let settings = DictationSettings::default();

        assert_eq!(settings.shortcut.label, "Fn");
        assert_eq!(settings.shortcut.code, "Fn");
        assert_eq!(settings.shortcut.key_code, 0);
        assert!(settings.shortcut.modifiers.function);
        assert_eq!(
            settings.activation_mode,
            DictationActivationMode::PushToTalk
        );
    }

    #[test]
    fn deserializes_legacy_shortcut_string() {
        let settings: DictationSettings = serde_json::from_str(
            r#"{"shortcut":"control_option_space","activationMode":"toggle","microphone":{"id":null,"name":null}}"#,
        )
        .expect("legacy shortcut should deserialize");

        assert_eq!(settings.shortcut.label, "Ctrl+Opt+Space");
        assert!(settings.shortcut.modifiers.control);
        assert!(settings.shortcut.modifiers.option);
        assert_eq!(settings.activation_mode, DictationActivationMode::Toggle);
    }

    #[test]
    fn old_settings_without_activation_mode_migrate_to_fn_push_to_talk() {
        let settings: DictationSettings = serde_json::from_str(
            r#"{"shortcut":"control_option_space","microphone":{"id":"usb","name":"USB Mic"}}"#,
        )
        .expect("legacy settings should deserialize");

        assert_eq!(settings.shortcut, DictationShortcutSetting::bare_fn());
        assert_eq!(
            settings.activation_mode,
            DictationActivationMode::PushToTalk
        );
        assert_eq!(settings.microphone.id.as_deref(), Some("usb"));
        assert_eq!(settings.microphone.name.as_deref(), Some("USB Mic"));
    }

    #[test]
    fn deserializes_legacy_bare_fn_shortcut_string() {
        let settings: DictationSettings = serde_json::from_str(
            r#"{"shortcut":"bare_fn","activationMode":"push_to_talk","microphone":{"id":null,"name":null}}"#,
        )
        .expect("legacy shortcut should deserialize");

        assert_eq!(settings.shortcut, DictationShortcutSetting::bare_fn());
        assert!(is_bare_fn_shortcut(&settings.shortcut));
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
        }
        .into_setting()
        .expect("bare Fn should be accepted");

        assert_eq!(shortcut, DictationShortcutSetting::bare_fn());
    }

    #[test]
    fn shortcut_input_requires_modifier() {
        let err = DictationShortcutInput {
            code: "KeyT".to_string(),
            modifiers: DictationShortcutModifiers::default(),
            label: "T".to_string(),
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
        }
        .into_setting()
        .expect_err("unsupported key should fail");

        assert_eq!(err.code, "dictation_shortcut_unsupported");
    }

    #[test]
    fn push_to_talk_starts_on_down_and_stops_on_up() {
        let mut controller = ShortcutActivationController::default();

        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Down, DictationActivationMode::PushToTalk),
            Some(DictationCommand::StartListening)
        );
        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Up, DictationActivationMode::PushToTalk),
            Some(DictationCommand::StopAndPaste)
        );
    }

    #[test]
    fn toggle_mode_toggles_on_down_and_ignores_up() {
        let mut controller = ShortcutActivationController::default();

        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Down, DictationActivationMode::Toggle),
            Some(DictationCommand::ToggleListening)
        );
        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Up, DictationActivationMode::Toggle),
            None
        );
    }

    #[test]
    fn shortcut_activation_ignores_duplicate_edges() {
        let mut controller = ShortcutActivationController::default();

        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Down, DictationActivationMode::PushToTalk),
            Some(DictationCommand::StartListening)
        );
        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Down, DictationActivationMode::PushToTalk),
            None
        );
        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Up, DictationActivationMode::PushToTalk),
            Some(DictationCommand::StopAndPaste)
        );
        assert_eq!(
            controller.handle_edge(ShortcutKeyEdge::Up, DictationActivationMode::PushToTalk),
            None
        );
    }

    #[test]
    fn successful_transcription_maps_to_paste_command() {
        let outcome = outcome_from_transcription_result(Ok(TranscriptionProviderResult {
            text: "Paste this transcript.".to_string(),
            language: Some("en".to_string()),
            provider: crate::providers::VENICE_PROVIDER.to_string(),
        }));

        assert_eq!(
            outcome.helper_command,
            serde_json::json!({
                "type": "paste_text",
                "text": "Paste this transcript.",
            })
        );
        assert!(outcome.event.is_none());
    }

    #[test]
    fn failed_transcription_maps_to_discard_and_error() {
        let outcome = outcome_from_transcription_result(Err(AppError::new(
            "transcription_failed",
            "The provider failed.",
        )));

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
}
