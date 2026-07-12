use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Condvar, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

const STATUS_EVENT: &str = "june://voice-playback-status";
const PYTHON_VERSION: &str = "3.12";
const MODEL_REPOSITORY: &str = "k2-fsa/OmniVoice";
const MODEL_REVISION: &str = "c5fdb5ccb189668d56333f77ba2629f4cd7535f4";
const RUNTIME_SOURCE_REVISION: &str = "3d2bd9d07bbe8d16c2439745b0ded450dc41e215";
const WORKER_SOURCE: &str = include_str!("../resources/voice-playback/worker.py");
const RUNTIME_LOCK: &str = include_str!("../resources/voice-playback/uv.lock");
const DEFAULT_REFERENCE_TRANSCRIPT: &str =
    "Hi, I'm June. Your private notes stay with you on this Mac.";
const MAX_SYNTHESIS_CHARS: usize = 1_000;
const INSTALL_TERM_TIMEOUT: Duration = Duration::from_secs(3);
const INSTALL_KILL_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy)]
struct ModelFile {
    path: &'static str,
    size: u64,
    sha256: &'static str,
}

const MODEL_FILES: [ModelFile; 13] = [
    ModelFile {
        path: ".gitattributes",
        size: 1_570,
        sha256: "34448b82c17d60fec9b65b1f093c115ddbaadc04beb1b0140b6bfed2e012a930",
    },
    ModelFile {
        path: "README.md",
        size: 9_424,
        sha256: "b5d645a1874baa96a460a0e3a7d5a262811d682d04ce235878a16d5fed287fd3",
    },
    ModelFile {
        path: "audio_tokenizer/.gitattributes",
        size: 1_519,
        sha256: "11ad7efa24975ee4b0c3c3a38ed18737f0658a5f75a0a96787b576a78a023361",
    },
    ModelFile {
        path: "audio_tokenizer/LICENSE",
        size: 9_171,
        sha256: "ac933dc084d119bd20401956b90d11ae87c248b2da62622cd580d82cdf2fa049",
    },
    ModelFile {
        path: "audio_tokenizer/README.md",
        size: 5_174,
        sha256: "0336368f8274a5ed09f54cee8d56a851ecee96026d9f391a6735762c16608a60",
    },
    ModelFile {
        path: "audio_tokenizer/config.json",
        size: 2_531,
        sha256: "eefb20806f7104e77c9a5277c9df0f9bb8826b08eb1d4e8ab2b9829b6ef9fac1",
    },
    ModelFile {
        path: "audio_tokenizer/model.safetensors",
        size: 805_665_628,
        sha256: "fe7c5e8785e0a05833e1bfc3e002ec7f55af21e306b2e7154a448c1f54ccfb0d",
    },
    ModelFile {
        path: "audio_tokenizer/preprocessor_config.json",
        size: 206,
        sha256: "ae61eea88558608ee2fa86d2aec9fce8d99a5ff75d09cb7651ccce21ae1d9084",
    },
    ModelFile {
        path: "chat_template.jinja",
        size: 4_168,
        sha256: "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
    },
    ModelFile {
        path: "config.json",
        size: 2_238,
        sha256: "5e359117e13b420c5e0c925d4aba650d624767131f1d1746928f8b850d5dc372",
    },
    ModelFile {
        path: "model.safetensors",
        size: 2_450_344_112,
        sha256: "730839316de585f4c8298ec0e1712efc10fb19c6fa4e36eb741cb8d51ebcf6aa",
    },
    ModelFile {
        path: "tokenizer.json",
        size: 11_423_986,
        sha256: "408f669b7e2b045fdf54201d815bd364e6667dbd845115da81239c40bc6dcfd1",
    },
    ModelFile {
        path: "tokenizer_config.json",
        size: 533,
        sha256: "49f78845596a82bf15c83673794bdf9f76f812b11f60ab6a2239d9be65b00676",
    },
];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VoicePlaybackMode {
    #[default]
    Click,
    Streaming,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceClip {
    file_name: String,
    duration_ms: u64,
    transcript: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicePlaybackSettings {
    playback_mode: VoicePlaybackMode,
    model_use_acknowledged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reference_clip: Option<ReferenceClip>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    playback_mode: VoicePlaybackMode,
    model_use_acknowledged: bool,
    reference: Option<StoredReference>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredReference {
    file_name: String,
    duration_ms: u64,
    transcript: String,
    sha256: String,
}

impl StoredSettings {
    fn public(&self) -> VoicePlaybackSettings {
        VoicePlaybackSettings {
            playback_mode: self.playback_mode,
            model_use_acknowledged: self.model_use_acknowledged,
            reference_clip: self.reference.as_ref().map(|reference| ReferenceClip {
                file_name: reference.file_name.clone(),
                duration_ms: reference.duration_ms,
                transcript: reference.transcript.clone(),
            }),
        }
    }
}

pub struct VoicePlaybackSettingsState {
    path: PathBuf,
    settings: Mutex<StoredSettings>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum VoicePlaybackStatus {
    Unavailable { reason: String },
    NotInstalled,
    Installing { stage: String, progress: u8 },
    Idle,
    Starting,
    Ready,
    Error { message: String },
}

#[derive(Clone)]
enum Phase {
    Installing { stage: String, progress: u8 },
    Idle,
    Starting,
    Ready,
    Busy,
    Error(String),
}

struct WorkerRequest {
    text: String,
    generation: u64,
    reference_path: PathBuf,
    reference_transcript: String,
    reply: tokio::sync::oneshot::Sender<Result<PathBuf, AppError>>,
}

#[derive(Default)]
struct WorkerSlot {
    sender: Option<mpsc::Sender<WorkerRequest>>,
    pid: Option<u32>,
    token: u64,
    running: bool,
}

struct ActivePlayback {
    child: Child,
    path: PathBuf,
}

#[derive(Default)]
struct InstallSlot {
    running: bool,
    pid: Option<u32>,
    token: u64,
    cancel_requested: bool,
}

#[derive(Default)]
pub struct VoicePlaybackRuntime {
    lifecycle: Mutex<()>,
    worker: Mutex<WorkerSlot>,
    worker_exited: Condvar,
    playback: Mutex<Option<ActivePlayback>>,
    output_leases: Mutex<HashMap<PathBuf, u64>>,
    install: Mutex<InstallSlot>,
    install_exited: Condvar,
    phase: Mutex<Option<Phase>>,
    generation: AtomicU64,
    next_worker_token: AtomicU64,
    next_install_token: AtomicU64,
}

pub fn setup(app: &mut tauri::App) {
    let path = app
        .path()
        .app_config_dir()
        .map(|dir| dir.join("voice-playback.json"))
        .unwrap_or_else(|_| PathBuf::from("voice-playback.json"));
    let settings = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    app.manage(VoicePlaybackSettingsState {
        path,
        settings: Mutex::new(settings),
    });
    app.manage(VoicePlaybackRuntime::default());
}

pub fn shutdown(app: &AppHandle) {
    let _ = cancel(app, true);
}

fn availability_reason() -> Option<String> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Some("Local voice playback requires an Apple Silicon Mac.".into());
    }
    if !cfg!(debug_assertions) && option_env!("OS_JUNE_ENABLE_LOCAL_VOICE_PLAYBACK") != Some("1") {
        return Some("Local voice playback is not enabled in this release build.".into());
    }
    None
}

fn require_available() -> Result<(), AppError> {
    availability_reason()
        .map(|reason| Err(AppError::new("voice_playback_unavailable", reason)))
        .unwrap_or(Ok(()))
}

fn base_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    crate::app_paths::app_data_dir(app)
        .map(|dir| dir.join("voice-playback"))
        .map_err(|error| AppError::new("voice_playback_paths", error.to_string()))
}

fn runtime_dir(base: &Path) -> PathBuf {
    base.join("runtime")
}

fn runtime_python(base: &Path) -> PathBuf {
    runtime_dir(base).join(".venv/bin/python")
}

fn model_dir(base: &Path) -> PathBuf {
    base.join("model").join(MODEL_REVISION)
}

fn default_reference_path(base: &Path) -> PathBuf {
    base.join("default-reference.wav")
}

fn custom_reference_path(base: &Path) -> PathBuf {
    base.join("reference/reference.wav")
}

fn install_marker(base: &Path) -> PathBuf {
    base.join("install-fingerprint")
}

fn install_fingerprint() -> String {
    let mut digest = Sha256::new();
    digest.update(b"june-voice-playback-v2\0");
    digest.update(PYTHON_VERSION.as_bytes());
    digest.update(RUNTIME_SOURCE_REVISION.as_bytes());
    digest.update(RUNTIME_LOCK.as_bytes());
    digest.update(WORKER_SOURCE.as_bytes());
    digest.update(MODEL_REVISION.as_bytes());
    for file in MODEL_FILES {
        digest.update(file.path.as_bytes());
        digest.update(file.size.to_le_bytes());
        digest.update(file.sha256.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

fn is_installed(base: &Path) -> bool {
    runtime_python(base).is_file()
        && default_reference_path(base).is_file()
        && MODEL_FILES.iter().all(|file| {
            fs::metadata(model_dir(base).join(file.path))
                .is_ok_and(|metadata| metadata.len() == file.size)
        })
        && fs::read_to_string(install_marker(base))
            .is_ok_and(|value| value.trim() == install_fingerprint())
}

fn set_phase(app: &AppHandle, phase: Phase) {
    *app.state::<VoicePlaybackRuntime>()
        .phase
        .lock()
        .expect("voice playback phase lock") = Some(phase);
    let _ = app.emit(STATUS_EVENT, status_for(app));
}

fn status_for(app: &AppHandle) -> VoicePlaybackStatus {
    if let Some(reason) = availability_reason() {
        return VoicePlaybackStatus::Unavailable { reason };
    }
    let runtime = app.state::<VoicePlaybackRuntime>();
    let phase = runtime
        .phase
        .lock()
        .expect("voice playback phase lock")
        .clone();
    match phase {
        Some(Phase::Installing { stage, progress }) => {
            VoicePlaybackStatus::Installing { stage, progress }
        }
        Some(Phase::Starting) => VoicePlaybackStatus::Starting,
        Some(Phase::Ready | Phase::Busy) => VoicePlaybackStatus::Ready,
        Some(Phase::Error(message)) => VoicePlaybackStatus::Error { message },
        Some(Phase::Idle) | None => match base_dir(app) {
            Ok(base) if is_installed(&base) => VoicePlaybackStatus::Idle,
            _ => VoicePlaybackStatus::NotInstalled,
        },
    }
}

#[tauri::command]
pub fn voice_playback_status(app: AppHandle) -> VoicePlaybackStatus {
    status_for(&app)
}

#[tauri::command]
pub fn voice_playback_settings(
    state: State<'_, VoicePlaybackSettingsState>,
) -> VoicePlaybackSettings {
    state
        .settings
        .lock()
        .expect("voice playback settings lock")
        .public()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSettingsRequest {
    playback_mode: VoicePlaybackMode,
    model_use_acknowledged: bool,
}

#[tauri::command]
pub fn save_voice_playback_settings(
    state: State<'_, VoicePlaybackSettingsState>,
    request: SaveSettingsRequest,
) -> Result<VoicePlaybackSettings, AppError> {
    let mut settings = state.settings.lock().expect("voice playback settings lock");
    settings.playback_mode = request.playback_mode;
    settings.model_use_acknowledged = request.model_use_acknowledged;
    persist_settings(&state.path, &settings)?;
    Ok(settings.public())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetReferenceRequest {
    source_path: String,
    transcript: String,
}

#[tauri::command]
pub fn set_voice_playback_reference(
    app: AppHandle,
    state: State<'_, VoicePlaybackSettingsState>,
    request: SetReferenceRequest,
) -> Result<VoicePlaybackSettings, AppError> {
    require_available()?;
    let transcript = request.transcript.trim();
    if transcript.is_empty() {
        return Err(AppError::new(
            "voice_playback_reference",
            "Enter the exact words spoken in the reference clip.",
        ));
    }
    let source = PathBuf::from(request.source_path);
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("reference.wav")
        .to_string();
    validate_wav(&source)?;
    let reference_dir = base_dir(&app)?.join("reference");
    fs::create_dir_all(&reference_dir)
        .map_err(|error| AppError::new("voice_playback_reference", error.to_string()))?;
    let staged = reference_dir.join(format!("reference-{}.wav", uuid::Uuid::new_v4()));
    fs::copy(&source, &staged)
        .map_err(|error| AppError::new("voice_playback_reference", error.to_string()))?;
    let duration_ms = validate_wav(&staged)?;
    let sha256 = sha256_file(&staged)?;
    let destination = custom_reference_path(&base_dir(&app)?);
    fs::rename(&staged, &destination)
        .map_err(|error| AppError::new("voice_playback_reference", error.to_string()))?;

    let mut settings = state.settings.lock().expect("voice playback settings lock");
    settings.reference = Some(StoredReference {
        file_name,
        duration_ms,
        transcript: transcript.to_string(),
        sha256,
    });
    persist_settings(&state.path, &settings)?;
    Ok(settings.public())
}

#[tauri::command]
pub fn clear_voice_playback_reference(
    app: AppHandle,
    state: State<'_, VoicePlaybackSettingsState>,
) -> Result<VoicePlaybackSettings, AppError> {
    let mut settings = state.settings.lock().expect("voice playback settings lock");
    if settings.reference.take().is_some() {
        let _ = fs::remove_file(custom_reference_path(&base_dir(&app)?));
    }
    persist_settings(&state.path, &settings)?;
    Ok(settings.public())
}

fn persist_settings(path: &Path, settings: &StoredSettings) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("voice_playback_settings", "Settings path has no parent."))?;
    fs::create_dir_all(parent)
        .map_err(|error| AppError::new("voice_playback_settings", error.to_string()))?;
    let staged = parent.join(format!("voice-playback-{}.json", uuid::Uuid::new_v4()));
    let serialized = serde_json::to_vec_pretty(settings)
        .map_err(|error| AppError::new("voice_playback_settings", error.to_string()))?;
    fs::write(&staged, serialized)
        .map_err(|error| AppError::new("voice_playback_settings", error.to_string()))?;
    fs::rename(staged, path)
        .map_err(|error| AppError::new("voice_playback_settings", error.to_string()))
}

fn validate_wav(path: &Path) -> Result<u64, AppError> {
    let mut reader = hound::WavReader::open(path).map_err(|_| {
        AppError::new(
            "voice_playback_reference",
            "The reference clip must be a decodable WAV file.",
        )
    })?;
    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return Err(AppError::new(
            "voice_playback_reference",
            "The reference clip has invalid audio metadata.",
        ));
    }
    let duration_ms = u64::from(reader.duration()) * 1_000 / u64::from(spec.sample_rate);
    let mut audible = false;
    match spec.sample_format {
        hound::SampleFormat::Float => {
            for sample in reader.samples::<f32>() {
                let value = sample.map_err(|_| invalid_reference_wav())?;
                if !value.is_finite() {
                    return Err(invalid_reference_wav());
                }
                audible |= value.abs() >= 0.000_1;
            }
        }
        hound::SampleFormat::Int => {
            let shift = u32::from(spec.bits_per_sample.saturating_sub(12)).min(30);
            let threshold = 1_i64 << shift;
            for sample in reader.samples::<i32>() {
                let value = sample.map_err(|_| invalid_reference_wav())?;
                audible |= i64::from(value).abs() >= threshold;
            }
        }
    }
    if !audible {
        return Err(AppError::new(
            "voice_playback_reference",
            "The reference clip is silent or too quiet.",
        ));
    }
    Ok(duration_ms)
}

fn invalid_reference_wav() -> AppError {
    AppError::new(
        "voice_playback_reference",
        "The reference clip must be a complete, decodable WAV file.",
    )
}

#[tauri::command]
pub fn voice_playback_install(
    app: AppHandle,
    settings: State<'_, VoicePlaybackSettingsState>,
) -> Result<(), AppError> {
    require_available()?;
    if !settings
        .settings
        .lock()
        .expect("voice playback settings lock")
        .model_use_acknowledged
    {
        return Err(AppError::new(
            "voice_playback_acknowledgement",
            "Acknowledge the local model terms before installing.",
        ));
    }
    let runtime = app.state::<VoicePlaybackRuntime>();
    let _lifecycle = runtime
        .lifecycle
        .lock()
        .expect("voice playback lifecycle lock");
    if runtime
        .install
        .lock()
        .expect("voice playback install lock")
        .running
    {
        return Ok(());
    }
    stop_playback_and_worker(&app, true)?;
    let token = runtime.next_install_token.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut install = runtime.install.lock().expect("voice playback install lock");
        install.running = true;
        install.pid = None;
        install.token = token;
        install.cancel_requested = false;
    }
    set_phase(
        &app,
        Phase::Installing {
            stage: "Preparing".into(),
            progress: 0,
        },
    );
    let thread_app = app.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("june-voice-playback-install".into())
        .spawn(move || {
            let outcome = run_install(&thread_app, token);
            finish_install(&thread_app, token);
            match outcome {
                Ok(()) => set_phase(&thread_app, Phase::Idle),
                Err(error) if error.code == "voice_playback_cancelled" => {
                    set_phase(&thread_app, Phase::Idle)
                }
                Err(error) => set_phase(&thread_app, Phase::Error(error.message)),
            }
        })
    {
        finish_install(&app, token);
        set_phase(&app, Phase::Error(error.to_string()));
        return Err(AppError::new("voice_playback_install", error.to_string()));
    }
    Ok(())
}

fn run_install(app: &AppHandle, token: u64) -> Result<(), AppError> {
    let base = base_dir(app)?;
    fs::create_dir_all(&base)
        .map_err(|error| AppError::new("voice_playback_install", error.to_string()))?;
    ensure_install_active(app, token)?;
    clean_stale_install_artifacts(&base)?;
    let uv = find_uv().ok_or_else(|| {
        AppError::new(
            "voice_playback_install",
            "uv was not found. Install uv and try again.",
        )
    })?;
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| AppError::new("voice_playback_install", error.to_string()))?
        .join("native/voice-playback");
    let staged_runtime = base.join(format!("runtime-stage-{}", uuid::Uuid::new_v4()));
    let staged_reference = base.join(format!(
        "default-reference-{}.partial.wav",
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        copy_tree_for_install(app, token, &resources, &staged_runtime)?;
        install_stage(app, "Installing the local runtime", 5);
        run_install_command(
            app,
            token,
            Command::new(uv)
                .args([
                    "sync",
                    "--frozen",
                    "--no-dev",
                    "--python",
                    PYTHON_VERSION,
                    "--project",
                ])
                .arg(&staged_runtime),
        )?;

        let snapshot = model_dir(&base);
        let model_size = MODEL_FILES.iter().map(|file| file.size).sum();
        let mut completed_bytes = 0;
        for file in MODEL_FILES {
            download_model_file(app, token, &snapshot, file, completed_bytes, model_size)?;
            completed_bytes += file.size;
        }
        install_stage(app, "Verifying model files", 82);
        for file in MODEL_FILES {
            verify_model_file_for_install(app, token, &snapshot.join(file.path), file)?;
        }

        install_stage(app, "Testing Apple Metal synthesis", 90);
        let seed = u64::from_le_bytes(*uuid::Uuid::new_v4().as_bytes().first_chunk().unwrap());
        run_install_command(
            app,
            token,
            Command::new(staged_runtime.join(".venv/bin/python"))
                .arg(staged_runtime.join("worker.py"))
                .arg("--model")
                .arg(&snapshot)
                .arg("--smoke-output")
                .arg(&staged_reference)
                .arg("--seed")
                .arg(seed.to_string()),
        )?;
        validate_generated_wav(&staged_reference)?;
        ensure_install_active(app, token)?;
        activate_install(&base, &staged_runtime, &staged_reference)?;
        install_stage(app, "Ready", 100);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staged_runtime);
        let _ = fs::remove_file(&staged_reference);
    }
    result
}

fn activate_install(
    base: &Path,
    staged_runtime: &Path,
    staged_reference: &Path,
) -> Result<(), AppError> {
    let current_runtime = runtime_dir(base);
    let current_reference = default_reference_path(base);
    let runtime_backup = base.join(format!("runtime-old-{}", uuid::Uuid::new_v4()));
    let reference_backup = base.join(format!(
        "default-reference-old-{}.wav",
        uuid::Uuid::new_v4()
    ));

    if current_runtime.exists() {
        fs::rename(&current_runtime, &runtime_backup)
            .map_err(|error| AppError::new("voice_playback_install", error.to_string()))?;
    }
    if let Err(error) = fs::rename(staged_runtime, &current_runtime) {
        let _ = fs::rename(&runtime_backup, &current_runtime);
        return Err(AppError::new("voice_playback_install", error.to_string()));
    }

    if current_reference.exists() {
        if let Err(error) = fs::rename(&current_reference, &reference_backup) {
            rollback_runtime(&current_runtime, &runtime_backup);
            return Err(AppError::new("voice_playback_install", error.to_string()));
        }
    }
    if let Err(error) = fs::rename(staged_reference, &current_reference) {
        let _ = fs::rename(&reference_backup, &current_reference);
        rollback_runtime(&current_runtime, &runtime_backup);
        return Err(AppError::new("voice_playback_install", error.to_string()));
    }

    let marker = install_marker(base);
    let staged_marker = base.join(format!("install-fingerprint-{}", uuid::Uuid::new_v4()));
    if let Err(error) = fs::write(&staged_marker, install_fingerprint())
        .and_then(|()| fs::rename(&staged_marker, &marker))
    {
        let _ = fs::remove_file(&current_reference);
        let _ = fs::rename(&reference_backup, &current_reference);
        rollback_runtime(&current_runtime, &runtime_backup);
        return Err(AppError::new("voice_playback_install", error.to_string()));
    }

    let _ = fs::remove_dir_all(runtime_backup);
    let _ = fs::remove_file(reference_backup);
    Ok(())
}

fn rollback_runtime(current: &Path, backup: &Path) {
    let _ = fs::remove_dir_all(current);
    let _ = fs::rename(backup, current);
}

fn install_stage(app: &AppHandle, stage: &str, progress: u8) {
    set_phase(
        app,
        Phase::Installing {
            stage: stage.into(),
            progress,
        },
    );
}

fn finish_install(app: &AppHandle, token: u64) {
    let runtime = app.state::<VoicePlaybackRuntime>();
    let mut install = runtime.install.lock().expect("voice playback install lock");
    if install.token != token {
        return;
    }
    install.running = false;
    install.pid = None;
    install.cancel_requested = false;
    runtime.install_exited.notify_all();
}

fn ensure_install_active(app: &AppHandle, token: u64) -> Result<(), AppError> {
    let runtime = app.state::<VoicePlaybackRuntime>();
    let install = runtime.install.lock().expect("voice playback install lock");
    if !install.running || install.token != token || install.cancel_requested {
        return Err(cancelled());
    }
    Ok(())
}

fn clean_stale_install_artifacts(base: &Path) -> Result<(), AppError> {
    let entries = fs::read_dir(base)
        .map_err(|error| AppError::new("voice_playback_install", error.to_string()))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| AppError::new("voice_playback_install", error.to_string()))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let stale_runtime = name.starts_with("runtime-stage-");
        let stale_reference =
            name.starts_with("default-reference-") && name.ends_with(".partial.wav");
        let stale_marker = name.starts_with("install-fingerprint-");
        if !(stale_runtime || stale_reference || stale_marker) {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| AppError::new("voice_playback_install", error.to_string()))?;
        if file_type.is_dir() {
            fs::remove_dir_all(entry.path())
        } else {
            fs::remove_file(entry.path())
        }
        .map_err(|error| AppError::new("voice_playback_install", error.to_string()))?;
    }
    Ok(())
}

fn copy_tree_for_install(
    app: &AppHandle,
    token: u64,
    source: &Path,
    destination: &Path,
) -> Result<(), AppError> {
    ensure_install_active(app, token)?;
    fs::create_dir_all(destination)
        .map_err(|error| AppError::new("voice_playback_install", error.to_string()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| AppError::new("voice_playback_install", error.to_string()))?
    {
        ensure_install_active(app, token)?;
        let entry =
            entry.map_err(|error| AppError::new("voice_playback_install", error.to_string()))?;
        let target = destination.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree_for_install(app, token, &entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)
                .map_err(|error| AppError::new("voice_playback_install", error.to_string()))?;
        }
    }
    Ok(())
}

fn find_uv() -> Option<PathBuf> {
    let mut candidates = vec![PathBuf::from("uv")];
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".local/bin/uv"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/uv"));
    candidates.into_iter().find(|candidate| {
        Command::new(candidate)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
}

fn run_install_command(app: &AppHandle, token: u64, command: &mut Command) -> Result<(), AppError> {
    let mut child = spawn_install_child(app, token, command)?;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| AppError::new("voice_playback_install", error.to_string()))?
        {
            clear_install_pid(app, token, child.id());
            if status.success() {
                return ensure_install_active(app, token);
            }
            if ensure_install_active(app, token).is_err() {
                return Err(cancelled());
            }
            return Err(install_child_error(&mut child, "The setup command failed."));
        }
        if ensure_install_active(app, token).is_err() {
            terminate_install_child(&mut child);
            clear_install_pid(app, token, child.id());
            return Err(cancelled());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn spawn_install_child(
    app: &AppHandle,
    token: u64,
    command: &mut Command,
) -> Result<Child, AppError> {
    ensure_install_active(app, token)?;
    command.stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| AppError::new("voice_playback_install", error.to_string()))?;
    let runtime = app.state::<VoicePlaybackRuntime>();
    let mut install = runtime.install.lock().expect("voice playback install lock");
    if !install.running || install.token != token || install.cancel_requested {
        drop(install);
        terminate_install_child(&mut child);
        return Err(cancelled());
    }
    install.pid = Some(child.id());
    Ok(child)
}

fn clear_install_pid(app: &AppHandle, token: u64, pid: u32) {
    let runtime = app.state::<VoicePlaybackRuntime>();
    let mut install = runtime.install.lock().expect("voice playback install lock");
    if install.token == token && install.pid == Some(pid) {
        install.pid = None;
        runtime.install_exited.notify_all();
    }
}

fn install_child_error(child: &mut Child, fallback: &str) -> AppError {
    let mut detail = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut detail);
    }
    let message = detail
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(fallback);
    AppError::new("voice_playback_install", message)
}

fn terminate_install_child(child: &mut Child) {
    signal_install_process(child.id(), false);
    for _ in 0..20 {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    signal_install_process(child.id(), true);
    let _ = child.wait();
}

#[cfg(unix)]
fn signal_install_process(pid: u32, force: bool) {
    let signal = if force { "-KILL" } else { "-TERM" };
    let _ = Command::new("/bin/kill")
        .arg(signal)
        .arg(format!("-{pid}"))
        .status();
}

#[cfg(not(unix))]
fn signal_install_process(pid: u32, force: bool) {
    let mut command = Command::new("taskkill");
    command.args(["/PID", &pid.to_string(), "/T"]);
    if force {
        command.arg("/F");
    }
    let _ = command.status();
}

fn download_model_file(
    app: &AppHandle,
    token: u64,
    snapshot: &Path,
    file: ModelFile,
    completed_bytes: u64,
    model_size: u64,
) -> Result<(), AppError> {
    let destination = snapshot.join(file.path);
    if verify_model_file(&destination, file).is_ok() {
        install_stage(
            app,
            &format!("Verified {}", file.path),
            model_download_progress(completed_bytes + file.size, model_size),
        );
        return Ok(());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::new("voice_playback_install", error.to_string()))?;
    }
    let partial = destination.with_extension(format!(
        "{}.partial",
        destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("file")
    ));
    if partial.is_file() {
        if verify_model_file_for_install(app, token, &partial, file).is_ok() {
            fs::rename(&partial, &destination)
                .map_err(|error| AppError::new("voice_playback_install", error.to_string()))?;
            return Ok(());
        }
        if fs::metadata(&partial).is_ok_and(|metadata| metadata.len() >= file.size) {
            fs::remove_file(&partial)
                .map_err(|error| AppError::new("voice_playback_install", error.to_string()))?;
        }
    }
    let url = format!(
        "https://huggingface.co/{MODEL_REPOSITORY}/resolve/{MODEL_REVISION}/{}",
        file.path
    );
    let mut command = Command::new("/usr/bin/curl");
    command
        .args([
            "--fail",
            "--location",
            "--retry",
            "3",
            "--continue-at",
            "-",
            "--silent",
            "--show-error",
        ])
        .arg("--output")
        .arg(&partial)
        .arg(&url);
    let mut child = spawn_install_child(app, token, &mut command)?;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| AppError::new("voice_playback_install", error.to_string()))?
        {
            clear_install_pid(app, token, child.id());
            if !status.success() {
                if ensure_install_active(app, token).is_err() {
                    return Err(cancelled());
                }
                return Err(install_child_error(
                    &mut child,
                    "The model download failed.",
                ));
            }
            break;
        }
        if ensure_install_active(app, token).is_err() {
            terminate_install_child(&mut child);
            clear_install_pid(app, token, child.id());
            return Err(cancelled());
        }
        let partial_size = fs::metadata(&partial)
            .map(|metadata| metadata.len().min(file.size))
            .unwrap_or(0);
        install_stage(
            app,
            &format!("Downloading {}", file.path),
            model_download_progress(completed_bytes + partial_size, model_size),
        );
        std::thread::sleep(Duration::from_millis(250));
    }
    if let Err(error) = verify_model_file_for_install(app, token, &partial, file) {
        if error.code != "voice_playback_cancelled" {
            let _ = fs::remove_file(&partial);
        }
        return Err(error);
    }
    fs::rename(partial, destination)
        .map_err(|error| AppError::new("voice_playback_install", error.to_string()))
}

fn model_download_progress(downloaded: u64, total: u64) -> u8 {
    15 + ((downloaded.min(total) * 65) / total) as u8
}

fn verify_model_file(path: &Path, file: ModelFile) -> Result<(), AppError> {
    let metadata = fs::metadata(path)
        .map_err(|error| AppError::new("voice_playback_model", error.to_string()))?;
    if metadata.len() != file.size || sha256_file(path)? != file.sha256 {
        return Err(AppError::new(
            "voice_playback_model",
            format!("Model file verification failed for {}.", file.path),
        ));
    }
    Ok(())
}

fn verify_model_file_for_install(
    app: &AppHandle,
    token: u64,
    path: &Path,
    file: ModelFile,
) -> Result<(), AppError> {
    let metadata = fs::metadata(path)
        .map_err(|error| AppError::new("voice_playback_model", error.to_string()))?;
    if metadata.len() != file.size || sha256_file_for_install(app, token, path)? != file.sha256 {
        return Err(AppError::new(
            "voice_playback_model",
            format!("Model file verification failed for {}.", file.path),
        ));
    }
    Ok(())
}

fn sha256_file_for_install(app: &AppHandle, token: u64, path: &Path) -> Result<String, AppError> {
    let mut file = fs::File::open(path)
        .map_err(|error| AppError::new("voice_playback_file", error.to_string()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        ensure_install_active(app, token)?;
        let count = file
            .read(&mut buffer)
            .map_err(|error| AppError::new("voice_playback_file", error.to_string()))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn sha256_file(path: &Path) -> Result<String, AppError> {
    let mut file = fs::File::open(path)
        .map_err(|error| AppError::new("voice_playback_file", error.to_string()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| AppError::new("voice_playback_file", error.to_string()))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn validate_generated_wav(path: &Path) -> Result<(), AppError> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|error| AppError::new("voice_playback_audio", error.to_string()))?;
    if reader.duration() == 0 {
        return Err(AppError::new(
            "voice_playback_audio",
            "Voice synthesis produced no audio.",
        ));
    }
    let spec = reader.spec();
    let mut audible = false;
    match spec.sample_format {
        hound::SampleFormat::Float => {
            for sample in reader.samples::<f32>() {
                let value = sample
                    .map_err(|error| AppError::new("voice_playback_audio", error.to_string()))?;
                if !value.is_finite() {
                    return Err(AppError::new(
                        "voice_playback_audio",
                        "Voice synthesis produced invalid audio.",
                    ));
                }
                audible |= value.abs() >= 0.000_1;
            }
        }
        hound::SampleFormat::Int => {
            let shift = u32::from(spec.bits_per_sample.saturating_sub(12)).min(30);
            let threshold = 1_i64 << shift;
            for sample in reader.samples::<i32>() {
                let value = sample
                    .map_err(|error| AppError::new("voice_playback_audio", error.to_string()))?;
                audible |= i64::from(value).abs() >= threshold;
            }
        }
    }
    if !audible {
        return Err(AppError::new(
            "voice_playback_audio",
            "Voice synthesis produced silent audio.",
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn voice_playback_warm(app: AppHandle) -> Result<(), AppError> {
    let runtime = app.state::<VoicePlaybackRuntime>();
    let _lifecycle = runtime
        .lifecycle
        .lock()
        .expect("voice playback lifecycle lock");
    ensure_worker(&app).map(|_| ())
}

fn ensure_worker(app: &AppHandle) -> Result<mpsc::Sender<WorkerRequest>, AppError> {
    require_available()?;
    let base = base_dir(app)?;
    if !is_installed(&base) {
        return Err(AppError::new(
            "voice_playback_not_installed",
            "Install the local voice model in Settings first.",
        ));
    }
    let runtime = app.state::<VoicePlaybackRuntime>();
    let mut slot = runtime.worker.lock().expect("voice playback worker lock");
    if let Some(sender) = slot.sender.as_ref() {
        return Ok(sender.clone());
    }
    if slot.running {
        return Err(AppError::new(
            "voice_playback_worker",
            "The previous voice worker is still stopping.",
        ));
    }
    let (sender, receiver) = mpsc::channel();
    let token = runtime.next_worker_token.fetch_add(1, Ordering::SeqCst) + 1;
    slot.sender = Some(sender.clone());
    slot.token = token;
    slot.running = true;
    drop(slot);
    let generation = runtime.generation.load(Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        let outcome = run_worker(&app, receiver, generation, token);
        let runtime = app.state::<VoicePlaybackRuntime>();
        let mut slot = runtime.worker.lock().expect("voice playback worker lock");
        let owns_slot = slot.token == token;
        if owns_slot {
            slot.sender = None;
            slot.pid = None;
            slot.running = false;
        }
        runtime.worker_exited.notify_all();
        drop(slot);
        if !owns_slot {
            return;
        }
        match outcome {
            Ok(()) => set_phase(&app, Phase::Idle),
            Err(error) if error.code == "voice_playback_cancelled" => set_phase(&app, Phase::Idle),
            Err(error) => set_phase(&app, Phase::Error(error.message)),
        }
    });
    Ok(sender)
}

fn run_worker(
    app: &AppHandle,
    receiver: mpsc::Receiver<WorkerRequest>,
    start_generation: u64,
    token: u64,
) -> Result<(), AppError> {
    set_phase(app, Phase::Starting);
    clean_temp_wavs();
    let base = base_dir(app)?;
    let mut child = Command::new(runtime_python(&base))
        .arg(runtime_dir(&base).join("worker.py"))
        .arg("--model")
        .arg(model_dir(&base))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| AppError::new("voice_playback_worker", error.to_string()))?;
    {
        let runtime = app.state::<VoicePlaybackRuntime>();
        let mut slot = runtime.worker.lock().expect("voice playback worker lock");
        if runtime.generation.load(Ordering::SeqCst) != start_generation || slot.token != token {
            let _ = child.kill();
            let _ = child.wait();
            return Err(cancelled());
        }
        slot.pid = Some(child.id());
    }
    let result = drive_worker(app, &mut child, receiver);
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn drive_worker(
    app: &AppHandle,
    child: &mut Child,
    receiver: mpsc::Receiver<WorkerRequest>,
) -> Result<(), AppError> {
    let mut stdin = child.stdin.take().expect("voice worker stdin");
    let mut lines = BufReader::new(child.stdout.take().expect("voice worker stdout")).lines();
    loop {
        let line = lines
            .next()
            .transpose()
            .map_err(|error| AppError::new("voice_playback_worker", error.to_string()))?
            .ok_or_else(|| worker_died("The worker exited while loading the model."))?;
        let event: WorkerEvent = match serde_json::from_str(&line) {
            Ok(event) => event,
            Err(_) => continue,
        };
        if event.event == "fatal" {
            return Err(worker_died(event.error.as_deref().unwrap_or("")));
        }
        if event.event == "ready" {
            break;
        }
    }
    set_phase(app, Phase::Ready);

    let runtime = app.state::<VoicePlaybackRuntime>();
    let mut request_id = 0_u64;
    while let Ok(request) = receiver.recv() {
        if request.generation != runtime.generation.load(Ordering::SeqCst) {
            let _ = request.reply.send(Err(cancelled()));
            continue;
        }
        set_phase(app, Phase::Busy);
        request_id += 1;
        let output_path = std::env::temp_dir().join(format!(
            "os-june-voice-playback-{}.wav",
            uuid::Uuid::new_v4()
        ));
        let wire = serde_json::json!({
            "id": request_id,
            "op": "synthesize",
            "text": request.text,
            "outputPath": output_path,
            "referencePath": request.reference_path,
            "referenceTranscript": request.reference_transcript,
        });
        writeln!(stdin, "{wire}")
            .map_err(|error| AppError::new("voice_playback_worker", error.to_string()))?;
        let response = loop {
            let line = lines
                .next()
                .transpose()
                .map_err(|error| AppError::new("voice_playback_worker", error.to_string()))?
                .ok_or_else(|| worker_died("The worker exited during synthesis."))?;
            if let Ok(response) = serde_json::from_str::<WorkerResponse>(&line) {
                if response.id == Some(request_id) {
                    break response;
                }
            }
        };
        let result = if request.generation != runtime.generation.load(Ordering::SeqCst) {
            let _ = fs::remove_file(&output_path);
            Err(cancelled())
        } else if response.ok {
            match validate_output_path(&output_path)
                .and_then(|()| validate_generated_wav(&output_path))
            {
                Ok(()) => {
                    let mut leases = runtime
                        .output_leases
                        .lock()
                        .expect("voice playback output lease lock");
                    if request.generation != runtime.generation.load(Ordering::SeqCst) {
                        drop(leases);
                        let _ = fs::remove_file(&output_path);
                        Err(cancelled())
                    } else {
                        leases.insert(output_path.clone(), request.generation);
                        drop(leases);
                        if request.generation != runtime.generation.load(Ordering::SeqCst) {
                            runtime
                                .output_leases
                                .lock()
                                .expect("voice playback output lease lock")
                                .remove(&output_path);
                            let _ = fs::remove_file(&output_path);
                            Err(cancelled())
                        } else {
                            Ok(output_path)
                        }
                    }
                }
                Err(error) => {
                    let _ = fs::remove_file(&output_path);
                    Err(error)
                }
            }
        } else {
            let _ = fs::remove_file(&output_path);
            Err(AppError::new(
                "voice_playback_synthesize",
                response.error.unwrap_or_else(|| "Synthesis failed.".into()),
            ))
        };
        let _ = request.reply.send(result);
        set_phase(app, Phase::Ready);
    }
    Ok(())
}

#[derive(Deserialize)]
struct WorkerEvent {
    event: String,
    error: Option<String>,
}

#[derive(Deserialize)]
struct WorkerResponse {
    id: Option<u64>,
    ok: bool,
    error: Option<String>,
}

fn worker_died(message: &str) -> AppError {
    AppError::new(
        "voice_playback_worker",
        if message.trim().is_empty() {
            "The local voice worker stopped unexpectedly.".into()
        } else {
            message.trim().to_string()
        },
    )
}

fn cancelled() -> AppError {
    AppError::new("voice_playback_cancelled", "Voice playback was cancelled.")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizeRequest {
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizeResponse {
    wav_path: String,
}

#[tauri::command]
pub async fn voice_playback_synthesize(
    app: AppHandle,
    settings: State<'_, VoicePlaybackSettingsState>,
    request: SynthesizeRequest,
) -> Result<SynthesizeResponse, AppError> {
    let text = request.text.trim().to_string();
    if text.is_empty() {
        return Err(AppError::new(
            "voice_playback_synthesize",
            "Nothing to speak.",
        ));
    }
    if text.chars().count() > MAX_SYNTHESIS_CHARS {
        return Err(AppError::new(
            "voice_playback_synthesize",
            "This voice playback request is too long.",
        ));
    }
    let base = base_dir(&app)?;
    let (model_use_acknowledged, reference) = {
        let settings = settings
            .settings
            .lock()
            .expect("voice playback settings lock");
        (settings.model_use_acknowledged, settings.reference.clone())
    };
    if !model_use_acknowledged {
        return Err(AppError::new(
            "voice_playback_acknowledgement",
            "Acknowledge the local model terms before using voice playback.",
        ));
    }
    let (reference_path, reference_transcript) = match reference {
        Some(reference) => {
            let path = custom_reference_path(&base);
            if validate_wav(&path).is_err() || sha256_file(&path)? != reference.sha256 {
                return Err(AppError::new(
                    "voice_playback_reference",
                    "The saved reference clip is missing or has changed. Choose it again in Settings.",
                ));
            }
            (path, reference.transcript)
        }
        None => (
            default_reference_path(&base),
            DEFAULT_REFERENCE_TRANSCRIPT.into(),
        ),
    };
    let (generation, sender) = {
        let runtime = app.state::<VoicePlaybackRuntime>();
        let _lifecycle = runtime
            .lifecycle
            .lock()
            .expect("voice playback lifecycle lock");
        let generation = runtime.generation.load(Ordering::SeqCst);
        (generation, ensure_worker(&app)?)
    };
    let (reply, response) = tokio::sync::oneshot::channel();
    sender
        .send(WorkerRequest {
            text,
            generation,
            reference_path,
            reference_transcript,
            reply,
        })
        .map_err(|_| worker_died(""))?;
    let wav_path = response.await.map_err(|_| worker_died(""))??;
    Ok(SynthesizeResponse {
        wav_path: wav_path.to_string_lossy().into_owned(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayRequest {
    wav_path: String,
}

#[tauri::command]
pub async fn voice_playback_play(app: AppHandle, request: PlayRequest) -> Result<(), AppError> {
    require_available()?;
    let path = PathBuf::from(request.wav_path);
    validate_output_path(&path)?;
    let runtime = app.state::<VoicePlaybackRuntime>();
    let pid = {
        let _lifecycle = runtime
            .lifecycle
            .lock()
            .expect("voice playback lifecycle lock");
        let lease = runtime
            .output_leases
            .lock()
            .expect("voice playback output lease lock")
            .remove(&path);
        if lease != Some(runtime.generation.load(Ordering::SeqCst)) {
            let _ = fs::remove_file(&path);
            return Err(cancelled());
        }
        if let Some(active) = runtime
            .playback
            .lock()
            .expect("voice playback process lock")
            .take()
        {
            stop_active_playback(active)?;
        }
        let child = match Command::new("/usr/bin/afplay")
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                let _ = fs::remove_file(&path);
                return Err(AppError::new("voice_playback_play", error.to_string()));
            }
        };
        let pid = child.id();
        *runtime
            .playback
            .lock()
            .expect("voice playback process lock") = Some(ActivePlayback {
            child,
            path: path.clone(),
        });
        pid
    };
    loop {
        let status = {
            let mut playback = runtime
                .playback
                .lock()
                .expect("voice playback process lock");
            match playback.as_mut() {
                Some(active) if active.child.id() == pid => active
                    .child
                    .try_wait()
                    .map_err(|error| AppError::new("voice_playback_play", error.to_string()))?,
                _ => {
                    let _ = fs::remove_file(&path);
                    return Err(cancelled());
                }
            }
        };
        if let Some(status) = status {
            let mut playback = runtime
                .playback
                .lock()
                .expect("voice playback process lock");
            if playback
                .as_ref()
                .is_some_and(|active| active.child.id() == pid)
            {
                playback.take();
            }
            let _ = fs::remove_file(&path);
            return if status.success() {
                Ok(())
            } else {
                Err(AppError::new(
                    "voice_playback_play",
                    "macOS could not play the synthesized audio.",
                ))
            };
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

fn stop_active_playback(mut active: ActivePlayback) -> Result<(), AppError> {
    let result = match active
        .child
        .try_wait()
        .map_err(|error| AppError::new("voice_playback_play", error.to_string()))?
    {
        Some(_) => Ok(()),
        None => {
            let _ = active.child.kill();
            active
                .child
                .wait()
                .map(|_| ())
                .map_err(|error| AppError::new("voice_playback_play", error.to_string()))
        }
    };
    let _ = fs::remove_file(active.path);
    result
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRequest {
    #[serde(default)]
    release_model: bool,
}

#[tauri::command]
pub fn voice_playback_cancel(app: AppHandle, request: CancelRequest) -> Result<(), AppError> {
    cancel(&app, request.release_model)
}

fn cancel(app: &AppHandle, release_model: bool) -> Result<(), AppError> {
    let runtime = app.state::<VoicePlaybackRuntime>();
    let _lifecycle = runtime
        .lifecycle
        .lock()
        .expect("voice playback lifecycle lock");
    stop_install(app)?;
    stop_playback_and_worker(app, release_model)?;
    set_phase(app, Phase::Idle);
    Ok(())
}

pub(crate) fn stop_for_audio_capture(app: &AppHandle) -> Result<(), AppError> {
    cancel(app, true)
}

fn stop_install(app: &AppHandle) -> Result<(), AppError> {
    let runtime = app.state::<VoicePlaybackRuntime>();
    let mut install = runtime.install.lock().expect("voice playback install lock");
    if !install.running {
        return Ok(());
    }
    install.cancel_requested = true;
    if let Some(pid) = install.pid {
        signal_install_process(pid, false);
    }
    let (next, _) = runtime
        .install_exited
        .wait_timeout_while(install, INSTALL_TERM_TIMEOUT, |install| install.running)
        .expect("voice playback install lock");
    install = next;
    if install.running {
        if let Some(pid) = install.pid {
            signal_install_process(pid, true);
        }
        let (next, _) = runtime
            .install_exited
            .wait_timeout_while(install, INSTALL_KILL_TIMEOUT, |install| install.running)
            .expect("voice playback install lock");
        install = next;
    }
    if install.running {
        return Err(AppError::new(
            "voice_playback_cancel",
            "Local voice setup did not stop. Audio capture was not started.",
        ));
    }
    Ok(())
}

fn stop_playback_and_worker(app: &AppHandle, release_model: bool) -> Result<(), AppError> {
    let runtime = app.state::<VoicePlaybackRuntime>();
    runtime.generation.fetch_add(1, Ordering::SeqCst);
    let leased_paths = std::mem::take(
        &mut *runtime
            .output_leases
            .lock()
            .expect("voice playback output lease lock"),
    );
    for path in leased_paths.into_keys() {
        let _ = fs::remove_file(path);
    }
    if let Some(playback) = runtime
        .playback
        .lock()
        .expect("voice playback process lock")
        .take()
    {
        stop_active_playback(playback)?;
    }

    let should_stop_worker = {
        let phase = runtime.phase.lock().expect("voice playback phase lock");
        release_model || matches!(phase.as_ref(), Some(Phase::Starting | Phase::Busy))
    };
    if !should_stop_worker {
        return Ok(());
    }
    let mut slot = runtime.worker.lock().expect("voice playback worker lock");
    slot.sender = None;
    let first_pid = slot.pid;
    if let Some(pid) = first_pid {
        let _ = Command::new("/bin/kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
    let (next, _) = runtime
        .worker_exited
        .wait_timeout_while(slot, Duration::from_secs(3), |slot| slot.running)
        .expect("voice playback worker lock");
    slot = next;
    if slot.running {
        if let Some(pid) = slot.pid.or(first_pid) {
            let _ = Command::new("/bin/kill")
                .args(["-KILL", &pid.to_string()])
                .status();
        }
        let (next, _) = runtime
            .worker_exited
            .wait_timeout_while(slot, Duration::from_secs(2), |slot| slot.running)
            .expect("voice playback worker lock");
        slot = next;
    }
    if slot.running {
        return Err(AppError::new(
            "voice_playback_cancel",
            "The local voice worker did not stop. Audio capture was not started.",
        ));
    }
    Ok(())
}

fn validate_output_path(path: &Path) -> Result<(), AppError> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let valid_name = file_name.starts_with("os-june-voice-playback-")
        && file_name.ends_with(".wav")
        && uuid::Uuid::parse_str(
            file_name
                .trim_start_matches("os-june-voice-playback-")
                .trim_end_matches(".wav"),
        )
        .is_ok();
    if path.parent() != Some(std::env::temp_dir().as_path()) || !valid_name || !path.is_file() {
        return Err(AppError::new(
            "voice_playback_path",
            "The synthesized audio path is outside June's temporary audio directory.",
        ));
    }
    Ok(())
}

fn clean_temp_wavs() {
    let Ok(entries) = fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("os-june-voice-playback-") && name.ends_with(".wav") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_reference_cannot_redirect_managed_file_access() {
        let settings = StoredSettings {
            playback_mode: VoicePlaybackMode::Streaming,
            model_use_acknowledged: true,
            reference: Some(StoredReference {
                file_name: "my voice.wav".into(),
                duration_ms: 4_000,
                transcript: "hello".into(),
                sha256: "abc".into(),
            }),
        };
        let value = serde_json::to_value(settings.public()).unwrap();
        assert_eq!(value["playbackMode"], "streaming");
        assert_eq!(value["modelUseAcknowledged"], true);
        assert!(value.to_string().contains("my voice.wav"));
        let stored = serde_json::to_string(&settings).unwrap();
        assert!(!stored.contains("path"));
    }

    #[test]
    fn install_fingerprint_changes_with_manifest_inputs() {
        let fingerprint = install_fingerprint();
        assert_eq!(fingerprint.len(), 64);
        assert_ne!(fingerprint, MODEL_REVISION);
        assert!(fingerprint
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
    }

    #[test]
    fn model_manifest_is_complete_and_pinned() {
        assert_eq!(MODEL_FILES.len(), 13);
        assert_eq!(MODEL_REVISION.len(), 40);
        assert_eq!(
            RUNTIME_SOURCE_REVISION,
            "3d2bd9d07bbe8d16c2439745b0ded450dc41e215"
        );
        assert_eq!(
            MODEL_FILES.iter().map(|file| file.size).sum::<u64>(),
            3_267_470_260
        );
        assert!(MODEL_FILES.iter().all(|file| file.sha256.len() == 64));
        assert_eq!(model_download_progress(0, 100), 15);
        assert_eq!(model_download_progress(50, 100), 47);
        assert_eq!(model_download_progress(100, 100), 80);
    }

    #[test]
    fn status_serializes_unavailable_reason_and_progress() {
        let unavailable = serde_json::to_value(VoicePlaybackStatus::Unavailable {
            reason: "disabled".into(),
        })
        .unwrap();
        assert_eq!(unavailable["state"], "unavailable");
        assert_eq!(unavailable["reason"], "disabled");
        let installing = serde_json::to_value(VoicePlaybackStatus::Installing {
            stage: "Downloading".into(),
            progress: 42,
        })
        .unwrap();
        assert_eq!(installing["progress"], 42);
        assert_eq!(
            serde_json::to_value(VoicePlaybackStatus::Ready).unwrap()["state"],
            "ready"
        );
    }

    #[test]
    fn wav_validation_accepts_any_nonempty_duration_and_rejects_silence() {
        let directory = tempfile::tempdir().unwrap();
        let short = directory.path().join("short.wav");
        write_test_wav(&short, 1, 1, 500);
        assert_eq!(validate_wav(&short).unwrap(), 1_000);

        let long_stereo = directory.path().join("long-stereo.wav");
        write_test_wav(&long_stereo, 12, 2, 500);
        assert_eq!(validate_wav(&long_stereo).unwrap(), 12_000);

        let silent = directory.path().join("silent.wav");
        write_test_wav(&silent, 3, 1, 0);
        assert!(validate_wav(&silent).is_err());

        let truncated = directory.path().join("truncated.wav");
        write_test_wav(&truncated, 3, 1, 500);
        let length = fs::metadata(&truncated).unwrap().len();
        fs::OpenOptions::new()
            .write(true)
            .open(&truncated)
            .unwrap()
            .set_len(length - 1)
            .unwrap();
        assert!(validate_wav(&truncated).is_err());
    }

    fn write_test_wav(path: &Path, seconds: u32, channels: u16, sample: i16) {
        let spec = hound::WavSpec {
            channels,
            sample_rate: 8_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).unwrap();
        for _ in 0..seconds * spec.sample_rate * u32::from(channels) {
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();
    }
}
