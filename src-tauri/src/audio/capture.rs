use crate::{
    app_paths::AppPaths,
    domain::types::{
        AppError, AudioLevelDto, RecordingSessionDto, RecordingState, RecordingStatusDto,
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

static ACTIVE_RECORDING: LazyLock<Mutex<Option<ActiveRecording>>> =
    LazyLock::new(|| Mutex::new(None));

pub struct StartedRecording {
    pub session_id: String,
    pub note_id: String,
    pub partial_path: PathBuf,
    pub final_path: PathBuf,
    pub device_label: Option<String>,
    pub status: RecordingStatusDto,
}

pub struct FinishedRecording {
    pub session_id: String,
    pub note_id: String,
    pub final_path: PathBuf,
    pub elapsed_ms: i64,
    pub recording: RecordingSessionDto,
}

struct ActiveRecording {
    session_id: String,
    note_id: String,
    partial_path: PathBuf,
    final_path: PathBuf,
    started: Instant,
    active_since: Option<Instant>,
    accumulated_active: Duration,
    paused: bool,
    paused_flag: Arc<AtomicBool>,
    writer: Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>,
    stats: Arc<Mutex<CaptureStats>>,
    _stream: cpal::Stream,
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
        (
            "denied".to_string(),
            Some("Enable microphone access in macOS Privacy & Security settings.".to_string()),
        )
    }
}

pub fn start_capture(paths: &AppPaths, note_id: String) -> Result<StartedRecording, AppError> {
    let mut active = ACTIVE_RECORDING
        .lock()
        .map_err(|_| AppError::new("recording_lock_failed", "Recording state is unavailable."))?;
    if active.is_some() {
        return Err(AppError::new(
            "recording_already_active",
            "A recording is already active.",
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
    let note_dir = paths.recordings_dir.join(&note_id);
    std::fs::create_dir_all(&note_dir)
        .map_err(|error| AppError::new("audio_writer_failed", error.to_string()))?;
    let partial_path = note_dir.join(format!("{session_id}.partial.wav"));
    let final_path = note_dir.join(format!("{session_id}.wav"));
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
    let paused_flag = Arc::new(AtomicBool::new(false));
    let writer_for_callback = Arc::clone(&writer);
    let stats_for_callback = Arc::clone(&stats);
    let paused_for_callback = Arc::clone(&paused_flag);
    let err_fn = |error| eprintln!("audio stream error: {error}");

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.clone().into(),
            move |data: &[f32], _| {
                write_input_data(
                    data.iter().map(|sample| *sample),
                    &writer_for_callback,
                    &stats_for_callback,
                    &paused_for_callback,
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
                    &paused_for_callback,
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
                    &paused_for_callback,
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
    stream
        .play()
        .map_err(|error| AppError::new("audio_writer_failed", error.to_string()))?;

    let status = RecordingStatusDto {
        session_id: session_id.clone(),
        state: RecordingState::Recording,
        elapsed_ms: 0,
        level: AudioLevelDto {
            peak: 0.0,
            rms: 0.0,
            recent_peaks: Vec::new(),
        },
        silence_warning: false,
        bytes_written: 0,
    };

    *active = Some(ActiveRecording {
        session_id: session_id.clone(),
        note_id: note_id.clone(),
        partial_path: partial_path.clone(),
        final_path: final_path.clone(),
        started: Instant::now(),
        active_since: Some(Instant::now()),
        accumulated_active: Duration::ZERO,
        paused: false,
        paused_flag,
        writer,
        stats,
        _stream: stream,
    });

    Ok(StartedRecording {
        session_id,
        note_id,
        partial_path,
        final_path,
        device_label,
        status,
    })
}

pub fn pause_capture(session_id: &str) -> Result<RecordingStatusDto, AppError> {
    let mut active = lock_active()?;
    let recording = active_for_session(active.as_mut(), session_id)?;
    if !recording.paused {
        if let Some(active_since) = recording.active_since.take() {
            recording.accumulated_active += active_since.elapsed();
        }
        recording.paused = true;
        recording.paused_flag.store(true, Ordering::Release);
    }
    Ok(recording.status())
}

pub fn resume_capture(session_id: &str) -> Result<RecordingStatusDto, AppError> {
    let mut active = lock_active()?;
    let recording = active_for_session(active.as_mut(), session_id)?;
    if recording.paused {
        recording.active_since = Some(Instant::now());
        recording.paused = false;
        recording.paused_flag.store(false, Ordering::Release);
    }
    Ok(recording.status())
}

pub fn capture_status(session_id: &str) -> Result<RecordingStatusDto, AppError> {
    let active = lock_active()?;
    let recording = active_for_session(active.as_ref(), session_id)?;
    Ok(recording.status())
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
    let status = recording.status_with_state(RecordingState::Validating);
    let recording_dto = RecordingSessionDto {
        id: recording.session_id.clone(),
        note_id: recording.note_id.clone(),
        state: status.state,
        started_at: crate::db::repositories::timestamp(),
        elapsed_ms: status.elapsed_ms,
        device_label: None,
        level: status.level,
    };
    let ActiveRecording {
        session_id,
        note_id,
        partial_path,
        final_path,
        writer,
        paused_flag,
        _stream,
        ..
    } = recording;
    paused_flag.store(true, Ordering::Release);
    drop(_stream);
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
        .map_err(|error| AppError::new("audio_finalization_failed", error.to_string()))?;
    Ok(FinishedRecording {
        session_id,
        note_id,
        final_path,
        elapsed_ms: recording_dto.elapsed_ms,
        recording: recording_dto,
    })
}

fn write_input_data<I>(
    data: I,
    writer: &Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>,
    stats: &Arc<Mutex<CaptureStats>>,
    paused: &Arc<AtomicBool>,
) where
    I: Iterator<Item = f32>,
{
    if paused.load(Ordering::Acquire) {
        return;
    }
    let Ok(mut writer_guard) = writer.lock() else {
        return;
    };
    let Some(writer) = writer_guard.as_mut() else {
        return;
    };
    let Ok(mut stats) = stats.lock() else {
        return;
    };
    let mut callback_peak = 0.0_f32;
    for sample in data {
        let clamped = sample.clamp(-1.0, 1.0);
        let normalized = clamped.abs();
        callback_peak = callback_peak.max(normalized);
        stats.peak = stats.peak.max(normalized);
        stats.sum_square += (normalized as f64).powi(2);
        stats.samples += 1;
        stats.bytes_written += 2;
        let _ = writer.write_sample((clamped * i16::MAX as f32) as i16);
    }
    if callback_peak > 0.0 {
        if stats.recent_peaks.len() == 24 {
            stats.recent_peaks.pop_front();
        }
        stats.recent_peaks.push_back(callback_peak);
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
        RecordingStatusDto {
            session_id: self.session_id.clone(),
            state,
            elapsed_ms: self.elapsed().as_millis() as i64,
            level: AudioLevelDto {
                peak,
                rms,
                recent_peaks,
            },
            silence_warning: self.started.elapsed() >= Duration::from_secs(10)
                && rms < DEFAULT_SILENCE_THRESHOLD,
            bytes_written,
        }
    }
}
