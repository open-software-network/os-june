use crate::domain::types::{AppError, AudioLevelDto, RecordingSource, SourceReadinessDto};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Default)]
pub struct SystemAudioStats {
    pub level: AudioLevelDto,
    pub max_level: f32,
    pub last_error: Option<String>,
    last_debug_log: Option<Instant>,
}

pub struct SystemAudioCapture {
    pid: u32,
    stats: Arc<Mutex<SystemAudioStats>>,
    partial_path: PathBuf,
    final_path: PathBuf,
    status_path: PathBuf,
    pid_path: PathBuf,
    log_path: PathBuf,
}

impl SystemAudioCapture {
    pub fn start(
        partial_path: PathBuf,
        final_path: PathBuf,
        timeline_offset: Duration,
    ) -> Result<Self, AppError> {
        let helper_app = helper_app_path();
        if !helper_app.exists() {
            return Err(AppError::new(
                "system_audio_unavailable",
                "System audio helper is not built. Run pnpm tauri:dev again.",
            ));
        }
        terminate_existing_helpers();
        let status_path = partial_path.with_extension("status.json");
        let pid_path = partial_path.with_extension("pid");
        let log_path = partial_path.with_extension("helper.log");
        let _ = std::fs::remove_file(&status_path);
        let _ = std::fs::remove_file(&pid_path);
        let _ = std::fs::remove_file(&log_path);
        dev_log(format!(
            "starting helper app={} output={} status={} pid={} log={}",
            helper_app.display(),
            partial_path.display(),
            status_path.display(),
            pid_path.display(),
            log_path.display()
        ));
        let open_status = Command::new("/usr/bin/open")
            .arg("-n")
            .arg(&helper_app)
            .arg("--args")
            .arg("--output")
            .arg(&partial_path)
            .arg("--status")
            .arg(&status_path)
            .arg("--pid")
            .arg(&pid_path)
            .arg("--log")
            .arg(&log_path)
            .arg("--timeline-offset-ms")
            .arg(timeline_offset.as_millis().to_string())
            .status()
            .map_err(|error| AppError::new("system_audio_unavailable", error.to_string()))?;
        dev_log(format!("open returned status={open_status}"));

        let stats = Arc::new(Mutex::new(SystemAudioStats::default()));
        let ready = match wait_for_status(
            &status_path,
            Some(&log_path),
            Duration::from_secs(30),
            &["ready", "level", "error"],
            "System audio helper did not become ready. See the terminal helper log for the last CoreAudio step.",
        ) {
            Ok(ready) => ready,
            Err(error) => {
                abort_failed_helper_start(&partial_path, &status_path, &pid_path);
                return Err(error);
            }
        };
        if ready.event == "error" {
            abort_failed_helper_start(&partial_path, &status_path, &pid_path);
            return Err(AppError::new(
                "system_audio_permission_denied",
                ready
                    .message
                    .unwrap_or_else(|| "System audio capture failed.".to_string()),
            ));
        }
        let Some(pid) = read_pid(&pid_path) else {
            abort_failed_helper_start(&partial_path, &status_path, &pid_path);
            return Err(AppError::new(
                "system_audio_unavailable",
                "System audio helper PID was not written.",
            ));
        };
        dev_log(format!("helper ready event={} pid={pid}", ready.event));
        Ok(Self {
            pid,
            stats,
            partial_path,
            final_path,
            status_path,
            pid_path,
            log_path,
        })
    }

    pub fn pause(&mut self) {
        dev_log(format!("sending pause to helper pid={}", self.pid));
        send_signal(self.pid, "-USR1");
    }

    pub fn resume(&mut self) {
        dev_log(format!("sending resume to helper pid={}", self.pid));
        send_signal(self.pid, "-USR2");
    }

    pub fn status(&self) -> (AudioLevelDto, i64, Option<String>) {
        if let Ok(status) = read_status(&self.status_path) {
            if let Ok(mut stats) = self.stats.lock() {
                if let Some(level) = status.level {
                    stats.max_level = stats.max_level.max(status.max_level.unwrap_or(level));
                    stats.level = AudioLevelDto {
                        peak: level,
                        rms: level,
                        recent_peaks: vec![level],
                    };
                }
                if status.event == "error" {
                    stats.last_error = Some(
                        status
                            .message
                            .unwrap_or_else(|| "System audio capture failed.".to_string()),
                    );
                } else if status.message.is_some() {
                    stats.last_error = status.message;
                } else if status.event == "ready" || status.event == "level" {
                    stats.last_error = None;
                }
                if stats
                    .last_debug_log
                    .map(|logged| logged.elapsed() >= Duration::from_secs(2))
                    .unwrap_or(true)
                {
                    dev_log(format!(
                        "capture status event={} level={:.5} max_level={:.5}",
                        status.event, stats.level.peak, stats.max_level
                    ));
                    stats.last_debug_log = Some(Instant::now());
                }
            }
        }
        let (level, error) = self
            .stats
            .lock()
            .map(|stats| (stats.level.clone(), stats.last_error.clone()))
            .unwrap_or_default();
        let bytes = std::fs::metadata(&self.partial_path)
            .or_else(|_| std::fs::metadata(&self.final_path))
            .map(|metadata| metadata.len() as i64)
            .unwrap_or_default();
        (level, bytes, error)
    }

    pub fn stop(self) -> Result<PathBuf, AppError> {
        dev_log(format!("stopping helper pid={}", self.pid));
        send_signal(self.pid, "-TERM");
        if wait_for_stopped(&self.status_path, Duration::from_secs(5)).is_err() {
            dev_log(format!(
                "helper pid={} did not stop; sending kill",
                self.pid
            ));
            send_signal(self.pid, "-KILL");
            std::thread::sleep(Duration::from_millis(100));
        }
        if self.partial_path.exists() {
            std::fs::rename(&self.partial_path, &self.final_path)
                .map_err(|error| AppError::new("audio_finalization_failed", error.to_string()))?;
        }
        let _ = std::fs::remove_file(&self.status_path);
        let _ = std::fs::remove_file(&self.pid_path);
        dev_log(format!(
            "preserved helper log at {}",
            self.log_path.display()
        ));
        Ok(self.final_path)
    }
}

pub fn system_audio_readiness() -> SourceReadinessDto {
    #[cfg(target_os = "macos")]
    {
        let capture_available = macos_version_supports_system_audio() && helper_app_path().exists();
        SourceReadinessDto {
            source: RecordingSource::System,
            required: true,
            ready: capture_available,
            permission_state: if capture_available {
                "unknown".to_string()
            } else {
                "unsupported".to_string()
            },
            device_available: capture_available,
            capture_available,
            recovery_action: if capture_available {
                Some("openSystemAudioSettings".to_string())
            } else {
                Some("upgradeMacos".to_string())
            },
            message: if capture_available {
                None
            } else {
                Some(
                    "System audio capture requires macOS 14.2 or later and a built capture helper."
                        .to_string(),
                )
            },
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        SourceReadinessDto {
            source: RecordingSource::System,
            required: true,
            ready: false,
            permission_state: "unsupported".to_string(),
            device_available: false,
            capture_available: false,
            recovery_action: None,
            message: Some("System audio capture is only supported on macOS.".to_string()),
        }
    }
}

pub fn helper_permission_check() -> Result<(), AppError> {
    let helper_app = helper_app_path();
    if !helper_app.exists() {
        return Err(AppError::new(
            "system_audio_unavailable",
            "System audio helper is not built. Run pnpm tauri:dev again.",
        ));
    }
    terminate_existing_helpers();
    let temp = std::env::temp_dir().join(format!("os-scribe-audio-check-{}", uuid::Uuid::new_v4()));
    let output_path = temp.with_extension("wav");
    let status_path = temp.with_extension("json");
    let pid_path = temp.with_extension("pid");
    let log_path = temp.with_extension("log");
    dev_log(format!(
        "probing helper capture app={} output={} status={} pid={} log={}",
        helper_app.display(),
        output_path.display(),
        status_path.display(),
        pid_path.display(),
        log_path.display()
    ));
    let open_status = Command::new("/usr/bin/open")
        .arg("-n")
        .arg(&helper_app)
        .arg("--args")
        .arg("--output")
        .arg(&output_path)
        .arg("--status")
        .arg(&status_path)
        .arg("--pid")
        .arg(&pid_path)
        .arg("--log")
        .arg(&log_path)
        .status()
        .map_err(|error| AppError::new("system_audio_unavailable", error.to_string()))?;
    dev_log(format!("capture probe open status={open_status}"));
    let status = wait_for_status(
        &status_path,
        Some(&log_path),
        Duration::from_secs(75),
        &["ready", "level", "error"],
        "System audio helper could not start a usable CoreAudio capture. Grant System Audio Recording permission if macOS prompts for it, then try again. The terminal helper log shows the last completed CoreAudio step.",
    );
    let helper_pid = read_pid(&pid_path);
    if let Some(pid) = helper_pid {
        send_signal(pid, "-TERM");
        let _ = wait_for_stopped(&status_path, Duration::from_secs(3));
    }
    let result = match status {
        Ok(status) if status.event == "ready" || status.event == "level" => Ok(()),
        Ok(status) if status.event == "error" => Err(AppError::new(
            "system_audio_permission_denied",
            status
                .message
                .unwrap_or_else(|| "System audio capture probe failed.".to_string()),
        )),
        Ok(status) => {
            dump_helper_log(&log_path);
            Err(AppError::new(
                "system_audio_permission_denied",
                format!(
                    "System audio capture probe ended with unexpected event '{}'.",
                    status.event
                ),
            ))
        }
        Err(error) => {
            if let Some(pid) = helper_pid {
                send_signal(pid, "-KILL");
            }
            Err(error)
        }
    };
    let _ = std::fs::remove_file(&output_path);
    let _ = std::fs::remove_file(&status_path);
    let _ = std::fs::remove_file(&pid_path);
    let _ = std::fs::remove_file(&log_path);
    result
}

#[cfg(target_os = "macos")]
fn macos_version_supports_system_audio() -> bool {
    let output = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output();
    let Ok(output) = output else {
        return false;
    };
    let version = String::from_utf8_lossy(&output.stdout);
    let mut parts = version
        .trim()
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok());
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    major > 14 || (major == 14 && minor >= 2)
}

pub fn helper_app_path() -> PathBuf {
    let dev_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .join(".tauri-helper")
        .join("June.app");
    if dev_path.exists() {
        return dev_path;
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(contents_dir) = current_exe
            .ancestors()
            .find(|path| path.file_name().and_then(|name| name.to_str()) == Some("Contents"))
        {
            let resource_path = contents_dir
                .join("Resources")
                .join("native")
                .join("bin")
                .join("June.app");
            if resource_path.exists() {
                return resource_path;
            }
        }
    }
    dev_path
}

/// Kill a helper that launched but never became usable, so a failed start
/// doesn't leave a stray process recording in the background. The probe in
/// `helper_permission_check` already does this; `start` must too.
fn abort_failed_helper_start(partial_path: &Path, status_path: &Path, pid_path: &Path) {
    if let Some(pid) = read_pid(pid_path) {
        send_signal(pid, "-TERM");
        if wait_for_stopped(status_path, Duration::from_secs(2)).is_err() {
            send_signal(pid, "-KILL");
        }
    }
    let _ = std::fs::remove_file(partial_path);
    let _ = std::fs::remove_file(status_path);
    let _ = std::fs::remove_file(pid_path);
}

fn send_signal(pid: u32, signal: &str) {
    let _ = Command::new("kill")
        .arg(signal)
        .arg(pid.to_string())
        .status();
}

fn terminate_existing_helpers() {
    // Also match the pre-rename helper so a recorder left over from an older
    // "OS Scribe" build still gets cleaned up.
    let helper_names = ["june-system-audio-recorder", "os-scribe-system-audio-recorder"];
    let mut pids: Vec<u32> = Vec::new();
    for helper_name in helper_names {
        let Ok(output) = Command::new("pgrep").arg("-f").arg(helper_name).output() else {
            continue;
        };
        pids.extend(
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| line.trim().parse::<u32>().ok())
                .filter(|pid| *pid != std::process::id()),
        );
    }
    pids.sort_unstable();
    pids.dedup();
    if pids.is_empty() {
        return;
    }
    dev_log(format!("terminating stale helper pids={pids:?}"));
    for pid in &pids {
        send_signal(*pid, "-TERM");
    }
    std::thread::sleep(Duration::from_millis(250));
    for pid in pids {
        if process_is_running(pid) {
            send_signal(pid, "-KILL");
        }
    }
}

fn process_is_running(pid: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[derive(Debug)]
struct HelperStatus {
    event: String,
    level: Option<f32>,
    max_level: Option<f32>,
    message: Option<String>,
}

fn wait_for_status(
    path: &Path,
    log_path: Option<&Path>,
    timeout: Duration,
    terminal_events: &[&str],
    timeout_message: &str,
) -> Result<HelperStatus, AppError> {
    let started = Instant::now();
    let mut last_event = String::new();
    loop {
        if let Ok(status) = read_status(path) {
            if status.event != last_event {
                dev_log(format!("helper status event={}", status.event));
                last_event = status.event.clone();
            }
            if terminal_events.contains(&status.event.as_str()) {
                return Ok(status);
            }
        }
        if started.elapsed() >= timeout {
            dev_log(format!(
                "helper readiness timed out after {:?}; status_exists={}",
                timeout,
                path.exists()
            ));
            if let Some(log_path) = log_path {
                dump_helper_log(log_path);
            }
            return Err(AppError::new("system_audio_unavailable", timeout_message));
        }
        std::thread::sleep(Duration::from_millis(80));
    }
}

fn wait_for_stopped(path: &Path, timeout: Duration) -> Result<(), AppError> {
    let started = Instant::now();
    loop {
        if read_status(path)
            .map(|status| status.event == "stopped")
            .unwrap_or(false)
        {
            return Ok(());
        }
        if started.elapsed() >= timeout {
            return Err(AppError::new(
                "system_audio_unavailable",
                "System audio helper did not stop cleanly.",
            ));
        }
        std::thread::sleep(Duration::from_millis(80));
    }
}

fn read_status(path: &Path) -> Result<HelperStatus, std::io::Error> {
    let data = std::fs::read_to_string(path)?;
    let value = serde_json::from_str::<serde_json::Value>(&data)?;
    let event = value
        .get("event")
        .and_then(|event| event.as_str())
        .unwrap_or_default()
        .to_string();
    let level = value
        .get("level")
        .and_then(|level| level.as_str())
        .and_then(|level| level.parse::<f32>().ok());
    let message = value
        .get("message")
        .and_then(|message| message.as_str())
        .map(str::to_string);
    let max_level = value
        .get("maxLevel")
        .and_then(|level| level.as_str())
        .and_then(|level| level.parse::<f32>().ok());
    Ok(HelperStatus {
        event,
        level,
        max_level,
        message,
    })
}

fn read_pid(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

#[cfg(debug_assertions)]
fn dev_log(message: String) {
    eprintln!("[system-audio] {message}");
}

#[cfg(not(debug_assertions))]
fn dev_log(_message: String) {}

#[cfg(debug_assertions)]
fn dump_helper_log(path: &Path) {
    match std::fs::read_to_string(path) {
        Ok(log) if !log.trim().is_empty() => {
            eprintln!("[system-audio] helper log follows:");
            for line in log.lines() {
                eprintln!("[system-audio-helper] {line}");
            }
        }
        Ok(_) => eprintln!("[system-audio] helper log is empty at {}", path.display()),
        Err(error) => eprintln!(
            "[system-audio] helper log unavailable at {}: {}",
            path.display(),
            error
        ),
    }
}

#[cfg(not(debug_assertions))]
fn dump_helper_log(_path: &Path) {}
