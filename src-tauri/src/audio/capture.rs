use crate::{
    app_paths::AppPaths,
    audio::{
        live_preview::{
            start_live_transcript_preview, start_system_live_transcript_preview,
            LivePreviewController, LivePreviewSink, SystemLivePreviewController,
        },
        system_macos::SystemAudioCapture,
    },
    domain::types::{
        AppError, AudioLevelDto, RecordingSessionDto, RecordingSource, RecordingSourceMode,
        RecordingState, RecordingStatusDto, SourceState, SourceStatusDto, SourceWarningDto,
    },
};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{SampleFormat, WavSpec, WavWriter};
use std::{
    collections::VecDeque,
    fs::File,
    io::BufWriter,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const DEFAULT_SILENCE_THRESHOLD: f32 = 0.012;
const RECOVERY_SNAPSHOT_INTERVAL_MS: i64 = 500;
const MICROPHONE_STALL_THRESHOLD: Duration = Duration::from_secs(3);
const MICROPHONE_STREAM_WARNING_MESSAGE: &str =
    "Microphone input stopped unexpectedly. Audio after this point may be missing.";

static ACTIVE_RECORDING: LazyLock<Mutex<Option<ActiveRecording>>> =
    LazyLock::new(|| Mutex::new(None));

pub struct StartedRecording {
    pub session_id: String,
    pub note_id: String,
    pub source_mode: RecordingSourceMode,
    pub partial_path: PathBuf,
    pub final_path: PathBuf,
    pub sources: Vec<StartedSource>,
    pub device_label: Option<String>,
    pub status: RecordingStatusDto,
}

pub struct FinishedRecording {
    pub session_id: String,
    pub note_id: String,
    pub source_mode: RecordingSourceMode,
    pub final_path: PathBuf,
    pub sources: Vec<FinishedSource>,
    pub elapsed_ms: i64,
    pub recording: RecordingSessionDto,
}

pub struct StartedSource {
    pub source: RecordingSource,
    pub partial_path: PathBuf,
    pub final_path: PathBuf,
}

pub struct FinishedSource {
    pub source: RecordingSource,
    pub final_path: PathBuf,
    pub elapsed_ms: i64,
    pub capture_issue: Option<MicrophoneStreamIssue>,
}

pub struct CaptureRecoverySnapshot {
    pub status: RecordingStatusDto,
    pub should_persist: bool,
}

struct ActiveRecording {
    session_id: String,
    note_id: String,
    partial_path: PathBuf,
    final_path: PathBuf,
    source_mode: RecordingSourceMode,
    system_final_path: Option<PathBuf>,
    system_capture: Option<SystemAudioCapture>,
    started: Instant,
    active_since: Option<Instant>,
    accumulated_active: Duration,
    paused: bool,
    paused_flag: Arc<AtomicBool>,
    /// While set, the mic callback writes silence instead of samples (see
    /// write_input_data) so the user's voice stays out of the note while the
    /// dictation helper owns it. Independent of pause: the recording keeps
    /// running and both tracks keep growing.
    mic_duck_flag: Arc<AtomicBool>,
    writer: Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>,
    stats: Arc<Mutex<CaptureStats>>,
    stream_error: Arc<Mutex<Option<MicrophoneStreamIssue>>>,
    last_callback_at: Arc<Mutex<Option<Instant>>>,
    last_recovery_snapshot_elapsed_ms: i64,
    live_preview: Option<LivePreviewController>,
    system_live_preview: Option<SystemLivePreviewController>,
    live_preview_enabled: bool,
    _stream: cpal::Stream,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MicrophoneStreamIssue {
    pub code: String,
    pub message: String,
    pub elapsed_ms: i64,
}

// The MVP permits only one active recording and guards it behind a process-wide
// mutex. CPAL's CoreAudio stream is intentionally conservative about Send across
// platforms; on macOS it is safe for this usage because commands only hold/drop
// the stream through this single recorder lifecycle.
unsafe impl Send for ActiveRecording {}

#[derive(Debug, Default)]
struct CaptureStats {
    peak: f32,
    sum_square: f64,
    samples: u64,
    recent_peaks: VecDeque<f32>,
    bytes_written: i64,
}

pub fn microphone_permission_state() -> (String, Option<String>) {
    let host = cpal::default_host();
    if host.default_input_device().is_some() {
        ("granted".to_string(), None)
    } else {
        ("denied".to_string(), Some(microphone_permission_hint()))
    }
}

fn microphone_permission_hint() -> String {
    #[cfg(target_os = "macos")]
    {
        "Enable microphone access in macOS Privacy & Security settings.".to_string()
    }
    #[cfg(target_os = "windows")]
    {
        "Enable microphone access in Windows privacy settings.".to_string()
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        "Enable microphone access in your system privacy settings.".to_string()
    }
}

pub fn start_capture(
    app: tauri::AppHandle,
    paths: &AppPaths,
    note_id: String,
    source_mode: RecordingSourceMode,
) -> Result<StartedRecording, AppError> {
    let mut active = ACTIVE_RECORDING
        .lock()
        .map_err(|_| AppError::new("recording_lock_failed", "Recording state is unavailable."))?;
    if active.is_some() {
        return Err(AppError::new(
            "recording_already_active",
            "A previous recording is still active. June attempted to save it locally; please try again.",
        ));
    }

    let host = cpal::default_host();
    let device = host.default_input_device().ok_or_else(|| {
        AppError::new(
            "microphone_unavailable",
            "No microphone input device is available.",
        )
    })?;
    let device_label = device.name().ok();
    let config = device
        .default_input_config()
        .map_err(|error| AppError::new("microphone_unavailable", error.to_string()))?;
    let sample_rate = config.sample_rate().0;
    let channels = config.channels();

    let session_id = Uuid::new_v4().to_string();
    let note_dir = paths
        .recording_session_dir(&note_id, &session_id)
        .map_err(|error| AppError::new("invalid_recording_path", error.to_string()))?;
    std::fs::create_dir_all(&note_dir)
        .map_err(|error| AppError::new("audio_writer_failed", error.to_string()))?;
    let partial_path = note_dir.join("microphone.partial.wav");
    let final_path = note_dir.join("microphone.wav");
    let system_partial_path = (source_mode == RecordingSourceMode::MicrophonePlusSystem)
        .then(|| note_dir.join("system.partial.wav"));
    let system_final_path = (source_mode == RecordingSourceMode::MicrophonePlusSystem)
        .then(|| note_dir.join("system.wav"));
    let writer = WavWriter::create(
        &partial_path,
        WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        },
    )
    .map_err(|error| AppError::new("audio_writer_failed", error.to_string()))?;

    let writer = Arc::new(Mutex::new(Some(writer)));
    let stats = Arc::new(Mutex::new(CaptureStats::default()));
    let stream_error = Arc::new(Mutex::new(None));
    let last_callback_at = Arc::new(Mutex::new(None));
    let paused_flag = Arc::new(AtomicBool::new(false));
    let mic_duck_flag = Arc::new(AtomicBool::new(false));
    let writer_for_callback = Arc::clone(&writer);
    let stats_for_callback = Arc::clone(&stats);
    let last_callback_for_callback = Arc::clone(&last_callback_at);
    let paused_for_callback = Arc::clone(&paused_flag);
    let mic_duck_for_callback = Arc::clone(&mic_duck_flag);
    let live_preview_available =
        crate::june_api::configured() && crate::os_accounts::cached_signed_in();
    let live_preview = if live_preview_available {
        Some(start_live_transcript_preview(
            app.clone(),
            note_id.clone(),
            session_id.clone(),
            source_mode,
            RecordingSource::Microphone,
            sample_rate,
            channels,
        ))
    } else {
        None
    };
    let preview_for_callback = live_preview.as_ref().map(LivePreviewController::sink);
    let started = Instant::now();
    let stream_error_for_callback = Arc::clone(&stream_error);
    let err_fn = move |error| {
        // Always leave a raw trace, then record the first structured issue.
        // A blocking lock is required: this is CPAL's error callback (not the
        // realtime data callback), and a try_lock could silently drop the one
        // error whenever a status poll holds the mutex at that instant.
        eprintln!("audio stream error: {error}");
        let mut issue = match stream_error_for_callback.lock() {
            Ok(issue) => issue,
            Err(poisoned) => poisoned.into_inner(),
        };
        if issue.is_none() {
            *issue = Some(MicrophoneStreamIssue {
                code: "microphone_stream_error".to_string(),
                message: format!("Microphone input stopped unexpectedly: {error}"),
                elapsed_ms: started.elapsed().as_millis().min(i64::MAX as u128) as i64,
            });
        }
    };

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.clone().into(),
            move |data: &[f32], _| {
                write_input_data(
                    data.iter().copied(),
                    &writer_for_callback,
                    &stats_for_callback,
                    &last_callback_for_callback,
                    &paused_for_callback,
                    &mic_duck_for_callback,
                    preview_for_callback.as_ref(),
                )
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.clone().into(),
            move |data: &[i16], _| {
                write_input_data(
                    data.iter().map(|sample| *sample as f32 / i16::MAX as f32),
                    &writer_for_callback,
                    &stats_for_callback,
                    &last_callback_for_callback,
                    &paused_for_callback,
                    &mic_duck_for_callback,
                    preview_for_callback.as_ref(),
                )
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config.clone().into(),
            move |data: &[u16], _| {
                write_input_data(
                    data.iter()
                        .map(|sample| (*sample as f32 - 32768.0) / 32768.0),
                    &writer_for_callback,
                    &stats_for_callback,
                    &last_callback_for_callback,
                    &paused_for_callback,
                    &mic_duck_for_callback,
                    preview_for_callback.as_ref(),
                )
            },
            err_fn,
            None,
        ),
        _ => {
            return Err(AppError::new(
                "microphone_unavailable",
                "Unsupported microphone sample format.",
            ))
        }
    }
    .map_err(|error| AppError::new("audio_writer_failed", error.to_string()))?;
    let mut system_live_preview = None;
    let system_capture = if let (Some(system_partial_path), Some(system_final_path)) =
        (system_partial_path.clone(), system_final_path.clone())
    {
        match SystemAudioCapture::start(
            system_partial_path.clone(),
            system_final_path.clone(),
            Duration::ZERO,
        ) {
            Ok(capture) => {
                if live_preview_available {
                    system_live_preview = Some(start_system_live_transcript_preview(
                        app.clone(),
                        note_id.clone(),
                        session_id.clone(),
                        source_mode,
                        system_partial_path,
                    ));
                }
                Some(capture)
            }
            Err(error) => {
                if let Ok(mut writer_guard) = writer.lock() {
                    let _ = writer_guard.take();
                }
                let _ = std::fs::remove_file(&partial_path);
                return Err(error);
            }
        }
    } else {
        None
    };
    let live_preview_enabled = live_preview.is_some() || system_live_preview.is_some();
    stream
        .play()
        .map_err(|error| AppError::new("audio_writer_failed", error.to_string()))?;
    let status = RecordingStatusDto {
        session_id: session_id.clone(),
        note_id: Some(note_id.clone()),
        source_mode,
        state: RecordingState::Recording,
        elapsed_ms: 0,
        level: AudioLevelDto {
            peak: 0.0,
            rms: 0.0,
            recent_peaks: Vec::new(),
        },
        silence_warning: false,
        bytes_written: 0,
        live_preview_enabled,
        sources: source_statuses(
            source_mode,
            RecordingState::Recording,
            0,
            AudioLevelDto::default(),
            0,
            system_capture.as_ref(),
            false,
            None,
        ),
        warnings: Vec::new(),
    };

    *active = Some(ActiveRecording {
        session_id: session_id.clone(),
        note_id: note_id.clone(),
        partial_path: partial_path.clone(),
        final_path: final_path.clone(),
        source_mode,
        system_final_path: system_final_path.clone(),
        system_capture,
        started,
        active_since: Some(started),
        accumulated_active: Duration::ZERO,
        paused: false,
        paused_flag,
        mic_duck_flag,
        writer,
        stats,
        stream_error,
        last_callback_at,
        last_recovery_snapshot_elapsed_ms: 0,
        live_preview,
        system_live_preview,
        live_preview_enabled,
        _stream: stream,
    });

    Ok(StartedRecording {
        session_id,
        note_id,
        source_mode,
        partial_path,
        final_path,
        sources: started_sources(source_mode, &note_dir),
        device_label,
        status,
    })
}

/// Ducks or restores the active recording's microphone channel. While ducked
/// the mic callback writes silence in place of samples, so the user's voice
/// never lands in the note but the mic track keeps growing in lockstep with
/// system audio. Dictation owns this: the helper's listening window ducks the
/// mic so dictating into June mid-meeting doesn't contaminate the meeting
/// note. Best-effort and idempotent — no active recording is a no-op, and the
/// flag dies with the session, so a stop mid-dictation can't leak a duck.
pub fn set_mic_ducked(ducked: bool) {
    let Ok(mut active) = lock_active() else {
        return;
    };
    if let Some(recording) = active.as_mut() {
        recording.mic_duck_flag.store(ducked, Ordering::Release);
    }
}

pub fn pause_capture(session_id: &str) -> Result<CaptureRecoverySnapshot, AppError> {
    let mut active = lock_active()?;
    let recording = active_for_session(active.as_mut(), session_id)?;
    if !recording.paused {
        if let Some(active_since) = recording.active_since.take() {
            recording.accumulated_active += active_since.elapsed();
        }
        recording.paused = true;
        recording.paused_flag.store(true, Ordering::Release);
        if let Some(system) = recording.system_capture.as_mut() {
            system.pause();
        }
    }
    Ok(recording.recovery_snapshot(RecoverySnapshotMode::Force))
}

pub fn resume_capture(session_id: &str) -> Result<CaptureRecoverySnapshot, AppError> {
    let mut active = lock_active()?;
    let recording = active_for_session(active.as_mut(), session_id)?;
    if recording.paused {
        recording.active_since = Some(Instant::now());
        recording.paused = false;
        recording.paused_flag.store(false, Ordering::Release);
        if let Some(system) = recording.system_capture.as_mut() {
            system.resume();
        }
    }
    Ok(recording.recovery_snapshot(RecoverySnapshotMode::Force))
}

pub fn capture_status(session_id: &str) -> Result<RecordingStatusDto, AppError> {
    let active = lock_active()?;
    let recording = active_for_session(active.as_ref(), session_id)?;
    Ok(recording.status())
}

pub fn capture_status_for_recovery(session_id: &str) -> Result<CaptureRecoverySnapshot, AppError> {
    let mut active = lock_active()?;
    let recording = active_for_session(active.as_mut(), session_id)?;
    Ok(recording.recovery_snapshot(RecoverySnapshotMode::Throttled))
}

pub fn is_capture_active() -> bool {
    ACTIVE_RECORDING
        .lock()
        .map(|active| active.is_some())
        .unwrap_or(false)
}

pub fn finish_active_capture() -> Result<Option<FinishedRecording>, AppError> {
    let mut active = lock_active()?;
    let Some(recording) = active.take() else {
        return Ok(None);
    };
    finalize_recording(recording).map(Some)
}

/// Snapshot of whatever recording is currently active, regardless of session
/// id. The meeting HUD supervisor mirrors the live recording without holding
/// the session id the way the React layer does, so it can't go through
/// [`capture_status`]. Returns `None` when nothing is recording.
pub fn current_status() -> Option<RecordingStatusDto> {
    let active = lock_active().ok()?;
    active.as_ref().map(|recording| recording.status())
}

pub fn finish_capture(session_id: &str) -> Result<FinishedRecording, AppError> {
    let mut active = lock_active()?;
    let Some(recording) = active.take() else {
        return Err(AppError::new(
            "recording_not_found",
            "Recording session was not found.",
        ));
    };
    if recording.session_id != session_id {
        let status = recording.status();
        *active = Some(recording);
        return Err(AppError::new(
            "recording_not_found",
            format!(
                "Active recording is {}, not {}",
                status.session_id, session_id
            ),
        ));
    }
    finalize_recording(recording)
}

fn finalize_recording(recording: ActiveRecording) -> Result<FinishedRecording, AppError> {
    let status = recording.status_with_state(RecordingState::Validating);
    let recording_dto = RecordingSessionDto {
        id: recording.session_id.clone(),
        note_id: recording.note_id.clone(),
        source_mode: recording.source_mode,
        state: status.state,
        started_at: crate::db::repositories::timestamp(),
        elapsed_ms: status.elapsed_ms,
        device_label: None,
        level: status.level,
        live_preview_enabled: recording.live_preview_enabled,
        sources: status.sources,
        warnings: status.warnings,
    };
    let ActiveRecording {
        session_id,
        note_id,
        partial_path,
        final_path,
        source_mode,
        system_capture,
        system_final_path,
        stream_error,
        last_callback_at,
        writer,
        paused_flag,
        live_preview,
        system_live_preview,
        _stream,
        ..
    } = recording;
    paused_flag.store(true, Ordering::Release);
    if let Some(live_preview) = live_preview {
        live_preview.cancel();
    }
    if let Some(system_live_preview) = system_live_preview {
        system_live_preview.cancel();
    }
    drop(_stream);
    let microphone_finalized = (|| -> Result<(), AppError> {
        if let Some(writer) = writer
            .lock()
            .map_err(|_| AppError::new("audio_finalization_failed", "Audio writer lock failed."))?
            .take()
        {
            writer
                .finalize()
                .map_err(|error| AppError::new("audio_finalization_failed", error.to_string()))?;
        }
        std::fs::rename(&partial_path, &final_path)
            .map_err(|error| AppError::new("audio_finalization_failed", error.to_string()))
    })();
    // Stop the system-audio helper even when microphone finalization failed:
    // dropping `SystemAudioCapture` without `stop()` would leave the helper
    // process recording in the background.
    let system_stopped = system_capture.map(SystemAudioCapture::stop);
    microphone_finalized?;
    let mut sources = vec![FinishedSource {
        source: RecordingSource::Microphone,
        final_path: final_path.clone(),
        elapsed_ms: recording_dto.elapsed_ms,
        capture_issue: microphone_stream_issue(
            recording_dto.elapsed_ms,
            RecordingState::Validating,
            &stream_error,
            &last_callback_at,
        ),
    }];
    if let Some(system_path) = system_stopped {
        let system_path = system_path?;
        sources.push(FinishedSource {
            source: RecordingSource::System,
            final_path: system_final_path.unwrap_or(system_path.clone()),
            elapsed_ms: recording_dto.elapsed_ms,
            capture_issue: None,
        });
    }
    Ok(FinishedRecording {
        session_id,
        note_id,
        source_mode,
        final_path,
        sources,
        elapsed_ms: recording_dto.elapsed_ms,
        recording: recording_dto,
    })
}

fn write_input_data<I>(
    data: I,
    writer: &Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>,
    stats: &Arc<Mutex<CaptureStats>>,
    last_callback_at: &Arc<Mutex<Option<Instant>>>,
    paused: &Arc<AtomicBool>,
    mic_ducked: &Arc<AtomicBool>,
    preview: Option<&LivePreviewSink>,
) where
    I: Iterator<Item = f32>,
{
    if let Ok(mut last_callback_at) = last_callback_at.try_lock() {
        *last_callback_at = Some(Instant::now());
    }
    if paused.load(Ordering::Acquire) {
        return;
    }
    // Ducked writes SILENCE, never drops frames: pause stops both tracks
    // together, but a duck runs while system audio keeps rolling, and a
    // shorter mic track would desync the two sources (turn attribution and
    // transcript merging align them by time). Zeroed samples keep the WAV
    // growing in lockstep and flatline the level meter honestly.
    let ducked = mic_ducked.load(Ordering::Acquire);
    let Ok(mut writer_guard) = writer.lock() else {
        return;
    };
    let Some(writer) = writer_guard.as_mut() else {
        return;
    };
    let Ok(mut stats) = stats.lock() else {
        return;
    };
    let mut preview_samples = preview.map(|_| Vec::new());
    {
        let mut callback_peak = 0.0_f32;
        let mut saw_sample = false;
        for sample in data {
            saw_sample = true;
            let clamped = if ducked { 0.0 } else { sample.clamp(-1.0, 1.0) };
            let pcm_sample = (clamped * i16::MAX as f32) as i16;
            let normalized = clamped.abs();
            callback_peak = callback_peak.max(normalized);
            stats.peak = stats.peak.max(normalized);
            stats.sum_square += (normalized as f64).powi(2);
            stats.samples += 1;
            stats.bytes_written += 2;
            let _ = writer.write_sample(pcm_sample);
            if let Some(samples) = preview_samples.as_mut() {
                samples.push(pcm_sample);
            }
        }
        if saw_sample {
            if stats.recent_peaks.len() == 24 {
                stats.recent_peaks.pop_front();
            }
            stats.recent_peaks.push_back(callback_peak);
        }
    }
    drop(stats);
    drop(writer_guard);
    if let (Some(preview), Some(samples)) = (preview, preview_samples) {
        preview.try_send(samples);
    }
}

fn lock_active() -> Result<std::sync::MutexGuard<'static, Option<ActiveRecording>>, AppError> {
    ACTIVE_RECORDING
        .lock()
        .map_err(|_| AppError::new("recording_lock_failed", "Recording state is unavailable."))
}

fn active_for_session<'a, T>(active: Option<T>, session_id: &str) -> Result<T, AppError>
where
    T: AsRecording<'a>,
{
    let Some(recording) = active else {
        return Err(AppError::new(
            "recording_not_found",
            "Recording session was not found.",
        ));
    };
    if recording.session_id() != session_id {
        return Err(AppError::new(
            "recording_not_found",
            "Recording session was not found.",
        ));
    }
    Ok(recording)
}

trait AsRecording<'a> {
    fn session_id(&self) -> &str;
}

impl<'a> AsRecording<'a> for &'a ActiveRecording {
    fn session_id(&self) -> &str {
        &self.session_id
    }
}

impl<'a> AsRecording<'a> for &'a mut ActiveRecording {
    fn session_id(&self) -> &str {
        &self.session_id
    }
}

impl ActiveRecording {
    fn elapsed(&self) -> Duration {
        if self.paused {
            self.accumulated_active
        } else {
            self.accumulated_active
                + self
                    .active_since
                    .map(|instant| instant.elapsed())
                    .unwrap_or_default()
        }
    }

    fn status(&self) -> RecordingStatusDto {
        self.status_with_state(if self.paused {
            RecordingState::Paused
        } else {
            RecordingState::Recording
        })
    }

    fn status_with_state(&self, state: RecordingState) -> RecordingStatusDto {
        let stats = self.stats.lock().ok();
        let (peak, rms, recent_peaks, bytes_written) = if let Some(stats) = stats.as_ref() {
            let rms = if stats.samples == 0 {
                0.0
            } else {
                (stats.sum_square / stats.samples as f64).sqrt() as f32
            };
            (
                stats.peak,
                rms,
                stats.recent_peaks.iter().copied().collect(),
                stats.bytes_written,
            )
        } else {
            (0.0, 0.0, Vec::new(), 0)
        };
        let elapsed_ms = self.elapsed().as_millis() as i64;
        let microphone_stream_issue = microphone_stream_issue(
            elapsed_ms,
            state,
            &self.stream_error,
            &self.last_callback_at,
        );
        let level = AudioLevelDto {
            peak,
            rms,
            recent_peaks: recent_peaks.clone(),
        };
        RecordingStatusDto {
            session_id: self.session_id.clone(),
            note_id: Some(self.note_id.clone()),
            source_mode: self.source_mode,
            state,
            elapsed_ms,
            level: level.clone(),
            silence_warning: self.started.elapsed() >= Duration::from_secs(10)
                && rms < DEFAULT_SILENCE_THRESHOLD,
            bytes_written,
            live_preview_enabled: self.live_preview_enabled,
            sources: source_statuses(
                self.source_mode,
                state,
                elapsed_ms,
                level,
                bytes_written,
                self.system_capture.as_ref(),
                self.started.elapsed() >= Duration::from_secs(10)
                    && rms < DEFAULT_SILENCE_THRESHOLD,
                microphone_stream_issue.clone(),
            ),
            warnings: source_warnings(microphone_stream_issue.as_ref()),
        }
    }

    fn recovery_snapshot(&mut self, mode: RecoverySnapshotMode) -> CaptureRecoverySnapshot {
        let status = self.status();
        let should_persist = match mode {
            RecoverySnapshotMode::Force => true,
            RecoverySnapshotMode::Throttled => {
                status.elapsed_ms - self.last_recovery_snapshot_elapsed_ms
                    >= RECOVERY_SNAPSHOT_INTERVAL_MS
            }
        };
        if should_persist {
            self.last_recovery_snapshot_elapsed_ms = status.elapsed_ms;
            flush_microphone_writer_for_recovery(&self.writer);
        }
        CaptureRecoverySnapshot {
            status,
            should_persist,
        }
    }
}

enum RecoverySnapshotMode {
    Throttled,
    Force,
}

fn flush_microphone_writer_for_recovery(writer: &Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>) {
    let Ok(mut writer_guard) = writer.lock() else {
        return;
    };
    if let Some(writer) = writer_guard.as_mut() {
        let _ = writer.flush();
    }
}

fn started_sources(
    source_mode: RecordingSourceMode,
    note_dir: &std::path::Path,
) -> Vec<StartedSource> {
    let mut sources = vec![StartedSource {
        source: RecordingSource::Microphone,
        partial_path: note_dir.join("microphone.partial.wav"),
        final_path: note_dir.join("microphone.wav"),
    }];
    if source_mode == RecordingSourceMode::MicrophonePlusSystem {
        sources.push(StartedSource {
            source: RecordingSource::System,
            partial_path: note_dir.join("system.partial.wav"),
            final_path: note_dir.join("system.wav"),
        });
    }
    sources
}

fn source_statuses(
    source_mode: RecordingSourceMode,
    state: RecordingState,
    elapsed_ms: i64,
    microphone_level: AudioLevelDto,
    microphone_bytes: i64,
    system_capture: Option<&SystemAudioCapture>,
    microphone_silence_warning: bool,
    microphone_stream_issue: Option<MicrophoneStreamIssue>,
) -> Vec<SourceStatusDto> {
    let source_state = match state {
        RecordingState::Paused => SourceState::Paused,
        RecordingState::Validating | RecordingState::Finalizing => SourceState::Finalizing,
        RecordingState::Invalid => SourceState::Invalid,
        RecordingState::Failed => SourceState::Failed,
        RecordingState::Recoverable => SourceState::Recoverable,
        _ => SourceState::Recording,
    };
    let mut sources = vec![SourceStatusDto {
        source: RecordingSource::Microphone,
        state: source_state,
        elapsed_ms,
        bytes_written: microphone_bytes,
        level: microphone_level,
        silence_warning: microphone_silence_warning || microphone_stream_issue.is_some(),
        path_finalized: false,
        last_error: microphone_stream_issue.map(|issue| issue.message),
    }];
    if source_mode == RecordingSourceMode::MicrophonePlusSystem {
        let (level, bytes_written, last_error) = system_capture
            .map(|capture| capture.status())
            .unwrap_or_default();
        let system_silence_warning = elapsed_ms >= 10_000 && level.peak < DEFAULT_SILENCE_THRESHOLD;
        sources.push(SourceStatusDto {
            source: RecordingSource::System,
            state: source_state,
            elapsed_ms,
            bytes_written,
            level,
            silence_warning: system_silence_warning,
            path_finalized: false,
            last_error,
        });
    }
    sources
}

fn microphone_stream_issue(
    elapsed_ms: i64,
    state: RecordingState,
    stream_error: &Arc<Mutex<Option<MicrophoneStreamIssue>>>,
    last_callback_at: &Arc<Mutex<Option<Instant>>>,
) -> Option<MicrophoneStreamIssue> {
    if let Ok(issue) = stream_error.lock() {
        if issue.is_some() {
            return issue.clone();
        }
    }
    if state == RecordingState::Paused {
        return None;
    }
    let last_callback_at = last_callback_at.lock().ok().and_then(|instant| *instant);
    let stalled = match last_callback_at {
        Some(at) => at.elapsed() > MICROPHONE_STALL_THRESHOLD,
        // No input callback ever fired: a stream that opened but never
        // delivers data is stalled too, measured from recording start.
        None => elapsed_ms > MICROPHONE_STALL_THRESHOLD.as_millis() as i64,
    };
    if !stalled {
        return None;
    }
    Some(MicrophoneStreamIssue {
        code: "microphone_stream_stalled".to_string(),
        message: MICROPHONE_STREAM_WARNING_MESSAGE.to_string(),
        elapsed_ms,
    })
}

fn source_warnings(
    microphone_stream_issue: Option<&MicrophoneStreamIssue>,
) -> Vec<SourceWarningDto> {
    let Some(issue) = microphone_stream_issue else {
        return Vec::new();
    };
    vec![SourceWarningDto {
        source: RecordingSource::Microphone,
        code: issue.code.clone(),
        message: MICROPHONE_STREAM_WARNING_MESSAGE.to_string(),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_writer(dir: &tempfile::TempDir) -> Arc<Mutex<Option<WavWriter<BufWriter<File>>>>> {
        let writer = WavWriter::create(
            dir.path().join("mic.wav"),
            WavSpec {
                channels: 1,
                sample_rate: 48_000,
                bits_per_sample: 16,
                sample_format: SampleFormat::Int,
            },
        )
        .expect("create wav writer");
        Arc::new(Mutex::new(Some(writer)))
    }

    /// A ducked mic writes SILENCE, never drops frames: the sample count must
    /// match the input exactly (the mic track has to stay time-aligned with a
    /// concurrently-rolling system track) while every written sample is zero.
    #[test]
    fn ducked_mic_writes_aligned_silence_not_dropped_frames() {
        let dir = tempfile::tempdir().expect("tempdir");
        let writer = test_writer(&dir);
        let stats = Arc::new(Mutex::new(CaptureStats::default()));
        let paused = Arc::new(AtomicBool::new(false));
        let ducked = Arc::new(AtomicBool::new(true));

        write_input_data(
            [0.5_f32, -0.25, 0.9].into_iter(),
            &writer,
            &stats,
            &Arc::new(Mutex::new(None)),
            &paused,
            &ducked,
            None,
        );

        let stats = stats.lock().expect("stats lock");
        assert_eq!(
            stats.samples, 3,
            "every input frame is written while ducked"
        );
        // The writer is 16-bit PCM (bits_per_sample: 16), so 2 bytes/sample.
        const BYTES_PER_SAMPLE: i64 = 2;
        assert_eq!(stats.bytes_written, 3 * BYTES_PER_SAMPLE);
        assert_eq!(stats.peak, 0.0, "ducked samples are pure silence");
    }

    #[test]
    fn unducked_mic_records_real_samples() {
        let dir = tempfile::tempdir().expect("tempdir");
        let writer = test_writer(&dir);
        let stats = Arc::new(Mutex::new(CaptureStats::default()));
        let paused = Arc::new(AtomicBool::new(false));
        let ducked = Arc::new(AtomicBool::new(false));

        write_input_data(
            [0.5_f32, -0.25].into_iter(),
            &writer,
            &stats,
            &Arc::new(Mutex::new(None)),
            &paused,
            &ducked,
            None,
        );

        let stats = stats.lock().expect("stats lock");
        assert_eq!(stats.samples, 2);
        assert!(stats.peak > 0.4, "real samples keep their level");
    }

    /// Pause drops frames outright (both tracks stop together) — the duck
    /// must not change that precedence.
    #[test]
    fn paused_mic_still_drops_frames_even_when_ducked() {
        let dir = tempfile::tempdir().expect("tempdir");
        let writer = test_writer(&dir);
        let stats = Arc::new(Mutex::new(CaptureStats::default()));
        let paused = Arc::new(AtomicBool::new(true));
        let ducked = Arc::new(AtomicBool::new(true));

        write_input_data(
            [0.5_f32].into_iter(),
            &writer,
            &stats,
            &Arc::new(Mutex::new(None)),
            &paused,
            &ducked,
            None,
        );

        assert_eq!(stats.lock().expect("stats lock").samples, 0);
    }

    fn issue_state_at(
        elapsed_ms: i64,
        issue: Option<MicrophoneStreamIssue>,
        last_callback_at: Option<Instant>,
        state: RecordingState,
    ) -> Option<MicrophoneStreamIssue> {
        microphone_stream_issue(
            elapsed_ms,
            state,
            &Arc::new(Mutex::new(issue)),
            &Arc::new(Mutex::new(last_callback_at)),
        )
    }

    fn issue_state(
        issue: Option<MicrophoneStreamIssue>,
        last_callback_at: Option<Instant>,
        state: RecordingState,
    ) -> Option<MicrophoneStreamIssue> {
        issue_state_at(12_345, issue, last_callback_at, state)
    }

    #[test]
    fn microphone_stream_error_appears_in_status_source_and_warnings() {
        let issue = MicrophoneStreamIssue {
            code: "microphone_stream_error".to_string(),
            message: "Microphone input stopped unexpectedly: device disconnected".to_string(),
            elapsed_ms: 2_000,
        };

        let sources = source_statuses(
            RecordingSourceMode::MicrophoneOnly,
            RecordingState::Recording,
            2_000,
            AudioLevelDto::default(),
            1_024,
            None,
            false,
            Some(issue.clone()),
        );
        let warnings = source_warnings(Some(&issue));

        let microphone = sources
            .iter()
            .find(|source| source.source == RecordingSource::Microphone)
            .expect("microphone source status exists");
        assert_eq!(microphone.last_error, Some(issue.message));
        assert!(microphone.silence_warning);
        assert_eq!(
            warnings,
            vec![SourceWarningDto {
                source: RecordingSource::Microphone,
                code: "microphone_stream_error".to_string(),
                message: MICROPHONE_STREAM_WARNING_MESSAGE.to_string(),
            }]
        );
    }

    #[test]
    fn microphone_stall_requires_unpaused_recording_past_threshold_after_callback() {
        let recent_callback = Instant::now() - (MICROPHONE_STALL_THRESHOLD / 2);
        let stale_callback = Instant::now() - (MICROPHONE_STALL_THRESHOLD + Duration::from_secs(1));

        // Never-delivered first callback: healthy only within the startup
        // window, stalled once the recording elapsed passes the threshold.
        assert_eq!(
            issue_state_at(1_000, None, None, RecordingState::Recording),
            None
        );
        let never_started = issue_state_at(12_345, None, None, RecordingState::Recording)
            .expect("zero-callback stream past the threshold should report a stall");
        assert_eq!(never_started.code, "microphone_stream_stalled");
        assert_eq!(
            issue_state_at(12_345, None, None, RecordingState::Paused),
            None
        );
        assert_eq!(
            issue_state(None, Some(recent_callback), RecordingState::Recording),
            None
        );

        let stalled = issue_state(None, Some(stale_callback), RecordingState::Recording)
            .expect("stale active stream should report a stall");
        assert_eq!(stalled.code, "microphone_stream_stalled");
        assert_eq!(stalled.message, MICROPHONE_STREAM_WARNING_MESSAGE);
        assert_eq!(stalled.elapsed_ms, 12_345);
    }

    #[test]
    fn paused_recording_suppresses_microphone_stall_warning() {
        let stale_callback = Instant::now() - (MICROPHONE_STALL_THRESHOLD + Duration::from_secs(1));

        assert_eq!(
            issue_state(None, Some(stale_callback), RecordingState::Paused),
            None
        );
    }
}
