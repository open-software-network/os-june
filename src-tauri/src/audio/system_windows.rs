//! Windows system-audio capture via WASAPI loopback.
//!
//! On Windows, building a cpal *input* stream on an *output* (render) device
//! captures a loopback of everything that device is playing. cpal 0.15.3's
//! WASAPI backend does this transparently: `Device::build_input_stream_raw`
//! sets `AUDCLNT_STREAMFLAGS_LOOPBACK` whenever the device's data flow is
//! `eRender` (see cpal `src/host/wasapi/device.rs`). No OS permission prompt is
//! involved, which is why `system_audio_readiness()` reports `granted`.
//!
//! The public API mirrors `system_macos::SystemAudioCapture` exactly so
//! `audio::capture` can consume either backend through the re-export in
//! `audio::mod`. The observable file behavior also mirrors the macOS Swift
//! helper:
//!   * a 16-bit signed-int interleaved WAV at the device's native rate/channels,
//!   * `timeline_offset` of leading silence so the system track lines up with a
//!     microphone track that started `timeline_offset` earlier,
//!   * wall-clock silence fill for gaps (mirroring `writeTimelineSilenceIfNeeded`),
//!   * paused wall-clock excluded from the timeline rather than filled (see the
//!     pause semantics note on `pause`).
//!
//! Design difference from macOS worth calling out: the macOS aggregate-device
//! IOProc fires on the output device's clock even during silence, so the helper
//! can fill gaps from inside its callback. WASAPI loopback delivers no packets
//! while the endpoint is idle, so a callback-only design would stop advancing
//! the timeline during silence. We therefore run a dedicated writer thread on a
//! fixed tick that owns the WAV file and the wall clock: the cpal callback only
//! buffers samples and updates the level meter, and the writer thread fills
//! silence and appends real audio, keeping the file wall-clock aligned whether
//! or not audio is currently playing.

use crate::audio::system_timeline::{
    active_elapsed, expected_frames, max_silence_chunk_frames, silence_frames_to_fill,
    tolerance_frames, LevelAccumulator,
};
use crate::domain::types::{AppError, AudioLevelDto, RecordingSource, SourceReadinessDto};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{SampleFormat, WavSpec, WavWriter};
use std::{
    fs::File,
    io::BufWriter,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

/// How often the writer thread wakes to drain buffered audio and top up
/// silence. Comfortably below the 80 ms silence tolerance so the file stays
/// aligned without busy-waiting.
const WRITER_TICK: Duration = Duration::from_millis(40);

/// Shared between the cpal capture callback (producer) and the writer thread
/// (consumer) plus `status()` (reader). Kept lock-light: the callback never
/// touches the file, so it cannot block on disk I/O.
#[derive(Default)]
struct Shared {
    /// Interleaved i16 samples captured but not yet written to the WAV.
    pending: Vec<i16>,
    level: LevelAccumulator,
    /// WAV data bytes written so far (real audio + silence fill).
    bytes_written: i64,
    last_error: Option<String>,
}

/// Wall-clock pause bookkeeping, mirroring the Swift helper's
/// `accumulatedPausedDuration` / `pausedAt`. Read by the writer thread to
/// exclude paused time from the timeline.
#[derive(Default)]
struct PauseState {
    paused: bool,
    paused_at: Option<Instant>,
    accumulated_paused: Duration,
}

impl PauseState {
    /// Total paused time to subtract from elapsed wall clock right now,
    /// including an in-progress pause.
    fn paused_offset(&self) -> Duration {
        let active = if self.paused {
            self.paused_at.map(|at| at.elapsed()).unwrap_or_default()
        } else {
            Duration::ZERO
        };
        self.accumulated_paused + active
    }
}

pub struct SystemAudioCapture {
    // Dropping the stream stops the WASAPI loopback callback. `cpal::Stream` is
    // `!Send`; this struct is only ever held inside `ActiveRecording`, which is
    // force-`Send` (see `capture.rs`), exactly as the macOS backend relies on.
    stream: Option<cpal::Stream>,
    writer_handle: Option<JoinHandle<Result<(), String>>>,
    shared: Arc<Mutex<Shared>>,
    pause_state: Arc<Mutex<PauseState>>,
    pause_flag: Arc<AtomicBool>,
    stop_flag: Arc<AtomicBool>,
    partial_path: PathBuf,
    final_path: PathBuf,
}

impl SystemAudioCapture {
    pub fn start(
        partial_path: PathBuf,
        final_path: PathBuf,
        timeline_offset: Duration,
    ) -> Result<Self, AppError> {
        let host = cpal::default_host();
        let device = host.default_output_device().ok_or_else(|| {
            AppError::new(
                "system_audio_unavailable",
                "No audio output device is available to capture system audio.",
            )
        })?;
        // Loopback capture reads the render device's mix format; an output
        // device has no *input* config, so we derive the WAV spec and the
        // callback sample type from the output (mix) config.
        let supported = device.default_output_config().map_err(|error| {
            AppError::new("system_audio_capture_unavailable", error.to_string())
        })?;
        let sample_format = supported.sample_format();
        let sample_rate = supported.sample_rate().0;
        let channels = supported.channels();
        let stream_config: cpal::StreamConfig = supported.into();

        let writer = WavWriter::create(
            &partial_path,
            WavSpec {
                channels,
                sample_rate,
                bits_per_sample: 16,
                sample_format: SampleFormat::Int,
            },
        )
        .map_err(|error| AppError::new("system_audio_capture_unavailable", error.to_string()))?;

        let shared = Arc::new(Mutex::new(Shared::default()));
        let pause_state = Arc::new(Mutex::new(PauseState::default()));
        let pause_flag = Arc::new(AtomicBool::new(false));
        let stop_flag = Arc::new(AtomicBool::new(false));

        let stream = match build_loopback_stream(
            &device,
            &stream_config,
            sample_format,
            Arc::clone(&shared),
            Arc::clone(&pause_flag),
        ) {
            Ok(stream) => stream,
            Err(error) => {
                // Building the stream failed; drop the writer and remove the
                // half-created file so a failed start leaves nothing behind.
                drop(writer);
                let _ = std::fs::remove_file(&partial_path);
                return Err(error);
            }
        };

        // The writer thread owns the WAV file and the wall clock from here on.
        let writer_handle = spawn_writer_thread(
            writer,
            channels,
            sample_rate,
            timeline_offset,
            Arc::clone(&shared),
            Arc::clone(&pause_state),
            Arc::clone(&stop_flag),
        );

        if let Err(error) = stream.play() {
            stop_flag.store(true, Ordering::Release);
            let _ = writer_handle.join();
            let _ = std::fs::remove_file(&partial_path);
            return Err(AppError::new(
                "system_audio_capture_unavailable",
                error.to_string(),
            ));
        }

        Ok(Self {
            stream: Some(stream),
            writer_handle: Some(writer_handle),
            shared,
            pause_state,
            pause_flag,
            stop_flag,
            partial_path,
            final_path,
        })
    }

    pub fn pause(&mut self) {
        self.pause_flag.store(true, Ordering::Release);
        if let Ok(mut state) = self.pause_state.lock() {
            if !state.paused {
                state.paused_at = Some(Instant::now());
            }
            state.paused = true;
        }
    }

    pub fn resume(&mut self) {
        self.pause_flag.store(false, Ordering::Release);
        if let Ok(mut state) = self.pause_state.lock() {
            if let Some(paused_at) = state.paused_at.take() {
                state.accumulated_paused += paused_at.elapsed();
            }
            state.paused = false;
        }
    }

    pub fn status(&self) -> (AudioLevelDto, i64, Option<String>) {
        let Ok(shared) = self.shared.lock() else {
            return (AudioLevelDto::default(), 0, None);
        };
        (
            shared.level.level(),
            shared.bytes_written,
            shared.last_error.clone(),
        )
    }

    pub fn stop(mut self) -> Result<PathBuf, AppError> {
        // Stop the loopback callback first so no more samples arrive while the
        // writer thread performs its final drain and trailing-silence flush.
        drop(self.stream.take());
        self.stop_flag.store(true, Ordering::Release);
        if let Some(handle) = self.writer_handle.take() {
            match handle.join() {
                Ok(Ok(())) => {}
                Ok(Err(message)) => {
                    return Err(AppError::new("audio_finalization_failed", message));
                }
                Err(_) => {
                    return Err(AppError::new(
                        "audio_finalization_failed",
                        "System audio writer thread panicked.",
                    ));
                }
            }
        }
        if self.partial_path.exists() {
            std::fs::rename(&self.partial_path, &self.final_path)
                .map_err(|error| AppError::new("audio_finalization_failed", error.to_string()))?;
        }
        Ok(self.final_path.clone())
    }
}

impl Drop for SystemAudioCapture {
    fn drop(&mut self) {
        // `stop()` consumes `self` and clears these; this only runs if a capture
        // is dropped without `stop()` (e.g. a panic unwinds `start`). Make sure
        // the loopback callback and writer thread do not outlive the struct.
        drop(self.stream.take());
        self.stop_flag.store(true, Ordering::Release);
        if let Some(handle) = self.writer_handle.take() {
            let _ = handle.join();
        }
    }
}

/// Build the WASAPI loopback input stream on the render `device`, converting
/// whatever the mix format delivers into interleaved i16 for the writer thread
/// while feeding a normalized copy into the level meter.
fn build_loopback_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    shared: Arc<Mutex<Shared>>,
    pause_flag: Arc<AtomicBool>,
) -> Result<cpal::Stream, AppError> {
    let error_shared = Arc::clone(&shared);
    let err_fn = move |error: cpal::StreamError| {
        // Surface device invalidation / stream faults through status() rather
        // than panicking. The capture keeps its file; the writer thread keeps
        // filling silence so the timeline stays intact.
        if let Ok(mut shared) = error_shared.lock() {
            shared.last_error = Some(system_stream_error_message(&error));
        }
    };

    let build = |device: &cpal::Device| -> Result<cpal::Stream, cpal::BuildStreamError> {
        match sample_format {
            cpal::SampleFormat::F32 => device.build_input_stream(
                config,
                move |data: &[f32], _| {
                    ingest_samples(
                        data.iter().map(|sample| sample.clamp(-1.0, 1.0)),
                        &shared,
                        &pause_flag,
                    )
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                config,
                move |data: &[i16], _| {
                    ingest_samples(
                        data.iter().map(|sample| *sample as f32 / i16::MAX as f32),
                        &shared,
                        &pause_flag,
                    )
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                config,
                move |data: &[u16], _| {
                    ingest_samples(
                        data.iter()
                            .map(|sample| (*sample as f32 - 32768.0) / 32768.0),
                        &shared,
                        &pause_flag,
                    )
                },
                err_fn,
                None,
            ),
            // The WASAPI shared-mode mix engine is F32 in practice, but some
            // professional or HDMI render devices expose 32-bit int or 64-bit
            // float mix formats; capture those too instead of failing outright.
            cpal::SampleFormat::I32 => device.build_input_stream(
                config,
                move |data: &[i32], _| {
                    ingest_samples(
                        data.iter().map(|sample| *sample as f32 / i32::MAX as f32),
                        &shared,
                        &pause_flag,
                    )
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::F64 => device.build_input_stream(
                config,
                move |data: &[f64], _| {
                    ingest_samples(
                        data.iter().map(|sample| sample.clamp(-1.0, 1.0) as f32),
                        &shared,
                        &pause_flag,
                    )
                },
                err_fn,
                None,
            ),
            other => Err(cpal::BuildStreamError::BackendSpecific {
                err: cpal::BackendSpecificError {
                    description: format!(
                        "Unsupported system audio loopback sample format {other:?}."
                    ),
                },
            }),
        }
    };

    build(device)
        .map_err(|error| AppError::new("system_audio_capture_unavailable", error.to_string()))
}

/// Convert one callback's normalized samples to i16, buffer them for the writer
/// thread and fold them into the level meter. Skips everything while paused so
/// paused audio is dropped, matching the microphone path in `capture.rs`.
fn ingest_samples<I>(samples: I, shared: &Arc<Mutex<Shared>>, pause_flag: &AtomicBool)
where
    I: Iterator<Item = f32>,
{
    if pause_flag.load(Ordering::Acquire) {
        return;
    }
    let pcm: Vec<i16> = samples
        .map(|sample| (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
        .collect();
    if pcm.is_empty() {
        return;
    }
    let Ok(mut shared) = shared.lock() else {
        return;
    };
    shared
        .level
        .record_callback(pcm.iter().map(|sample| *sample as f32 / i16::MAX as f32));
    shared.pending.extend_from_slice(&pcm);
}

/// Spawn the thread that owns the WAV file and the wall clock. Returns a handle
/// whose value is the finalize result (`Err` maps to `audio_finalization_failed`).
fn spawn_writer_thread(
    mut writer: WavWriter<BufWriter<File>>,
    channels: u16,
    sample_rate: u32,
    timeline_offset: Duration,
    shared: Arc<Mutex<Shared>>,
    pause_state: Arc<Mutex<PauseState>>,
    stop_flag: Arc<AtomicBool>,
) -> JoinHandle<Result<(), String>> {
    std::thread::spawn(move || {
        let channels = channels.max(1) as i64;
        let tolerance = tolerance_frames(sample_rate);
        let chunk_cap = max_silence_chunk_frames(sample_rate);
        let started = Instant::now();
        // Per-channel frames written to the file (real audio + silence).
        let mut frames_written: i64 = 0;
        // First mid-capture write failure (disk full, I/O error). Recorded in
        // shared state for live status(), and returned from the thread so
        // stop() fails the recording instead of finalizing a file that
        // silently lost audio.
        let mut first_write_error: Option<String> = None;

        loop {
            let stopping = stop_flag.load(Ordering::Acquire);
            let pending = take_pending(&shared);
            let paused_offset = pause_state
                .lock()
                .map(|state| state.paused_offset())
                .unwrap_or_default();
            let elapsed = active_elapsed(started.elapsed(), timeline_offset, paused_offset);
            let expected = expected_frames(elapsed, sample_rate);

            if let Err(message) = write_tick(
                &mut writer,
                &pending,
                channels,
                expected,
                &mut frames_written,
                tolerance,
                chunk_cap,
                &shared,
            ) {
                record_error(&shared, message.clone());
                first_write_error.get_or_insert(message);
            }

            if stopping {
                // One trailing pass with no real audio flushes silence up to the
                // stop instant, mirroring the helper's flushTimelineSilenceToNow.
                let paused_offset = pause_state
                    .lock()
                    .map(|state| state.paused_offset())
                    .unwrap_or_default();
                let elapsed = active_elapsed(started.elapsed(), timeline_offset, paused_offset);
                let expected = expected_frames(elapsed, sample_rate);
                if let Err(message) = write_tick(
                    &mut writer,
                    &[],
                    channels,
                    expected,
                    &mut frames_written,
                    tolerance,
                    chunk_cap,
                    &shared,
                ) {
                    record_error(&shared, message.clone());
                    first_write_error.get_or_insert(message);
                }
                break;
            }

            std::thread::sleep(WRITER_TICK);
        }

        // Finalize regardless (a truncated-but-valid WAV beats a corrupt one),
        // then report the outcome with the first write failure taking
        // precedence over the finalize result.
        let finalize_result = writer.finalize().map_err(|error| error.to_string());
        writer_thread_outcome(first_write_error, finalize_result)
    })
}

/// The writer thread's exit value, which `stop()` maps onto
/// `audio_finalization_failed`: the first mid-capture write failure wins over
/// the finalize result, because audio has already been lost even when finalize
/// itself later succeeds. Factored out so the precedence is unit-testable.
fn writer_thread_outcome(
    first_write_error: Option<String>,
    finalize_result: Result<(), String>,
) -> Result<(), String> {
    match first_write_error {
        Some(message) => Err(message),
        None => finalize_result,
    }
}

/// Take the buffered samples out of the shared state without holding the lock
/// across the file write that follows.
fn take_pending(shared: &Arc<Mutex<Shared>>) -> Vec<i16> {
    match shared.lock() {
        Ok(mut shared) => std::mem::take(&mut shared.pending),
        Err(_) => Vec::new(),
    }
}

/// Fill any missing silence, then append the real buffer, keeping the file
/// aligned to `expected` per-channel frames. Updates `frames_written` and the
/// shared byte counter. Mirrors `writeTimelineSilenceIfNeeded` followed by the
/// real `audioFile.write`.
#[allow(clippy::too_many_arguments)]
fn write_tick(
    writer: &mut WavWriter<BufWriter<File>>,
    pending: &[i16],
    channels: i64,
    expected: i64,
    frames_written: &mut i64,
    tolerance: i64,
    chunk_cap: i64,
    shared: &Arc<Mutex<Shared>>,
) -> Result<(), String> {
    let incoming_frames = pending.len() as i64 / channels;
    let mut silence_frames =
        silence_frames_to_fill(expected, *frames_written, incoming_frames, tolerance);
    let mut written_samples: i64 = 0;

    while silence_frames > 0 {
        let chunk = silence_frames.min(chunk_cap);
        for _ in 0..(chunk * channels) {
            writer
                .write_sample(0i16)
                .map_err(|error| error.to_string())?;
        }
        *frames_written += chunk;
        written_samples += chunk * channels;
        silence_frames -= chunk;
    }

    for sample in pending {
        writer
            .write_sample(*sample)
            .map_err(|error| error.to_string())?;
    }
    *frames_written += incoming_frames;
    written_samples += pending.len() as i64;

    if written_samples > 0 {
        if let Ok(mut shared) = shared.lock() {
            shared.bytes_written += written_samples * 2;
        }
    }
    Ok(())
}

fn record_error(shared: &Arc<Mutex<Shared>>, message: String) {
    if let Ok(mut shared) = shared.lock() {
        shared.last_error = Some(message);
    }
}

fn system_stream_error_message(error: &cpal::StreamError) -> String {
    match error {
        cpal::StreamError::DeviceNotAvailable => {
            "System audio output device became unavailable. Reconnect the output device and restart the recording to resume system audio."
                .to_string()
        }
        cpal::StreamError::BackendSpecific { err } => {
            format!("System audio capture error: {}", err.description)
        }
    }
}

/// Sample formats `build_loopback_stream` has a conversion arm for. Keep in
/// sync with its `match`: a format missing here fails stream build with the
/// unsupported-format error, so readiness must not promise it.
fn is_supported_loopback_sample_format(format: cpal::SampleFormat) -> bool {
    matches!(
        format,
        cpal::SampleFormat::F32
            | cpal::SampleFormat::I16
            | cpal::SampleFormat::U16
            | cpal::SampleFormat::I32
            | cpal::SampleFormat::F64
    )
}

/// Outcome of the cheap capture-prerequisite probe behind
/// `system_audio_readiness`.
enum LoopbackSupport {
    Ready,
    NoDevice,
    /// The render device exists but reported no usable mix config (e.g. a
    /// stale endpoint). Carries the cpal error text for the readiness message.
    ConfigUnavailable(String),
    /// The mix config uses a sample format `build_loopback_stream` cannot
    /// convert. Carries the format's debug name for the readiness message.
    UnsupportedFormat(String),
}

/// Validate the same prerequisites `SystemAudioCapture::start` needs, short of
/// opening a stream: a default render device, a readable mix config, and a
/// sample format the loopback arms can convert.
///
/// Deliberately does NOT open a loopback stream. Readiness runs repeatedly
/// (mount, focus refreshes, the enable-toggle poll), and opening a WASAPI
/// stream on every probe is heavy and can perturb the endpoint. The residual
/// window where `start` can still fail (e.g. an exclusive-mode client grabs
/// the endpoint between probe and record) is handled by the existing
/// start_recording error path.
fn probe_loopback_support() -> LoopbackSupport {
    let host = cpal::default_host();
    let Some(device) = host.default_output_device() else {
        return LoopbackSupport::NoDevice;
    };
    match device.default_output_config() {
        Err(error) => LoopbackSupport::ConfigUnavailable(error.to_string()),
        Ok(config) if !is_supported_loopback_sample_format(config.sample_format()) => {
            LoopbackSupport::UnsupportedFormat(format!("{:?}", config.sample_format()))
        }
        Ok(_) => LoopbackSupport::Ready,
    }
}

/// Map a probe outcome onto the readiness DTO. Factored out of
/// `system_audio_readiness` so the decision logic is unit-testable without a
/// real audio endpoint.
fn readiness_from_loopback_support(support: LoopbackSupport) -> SourceReadinessDto {
    let (device_available, capture_available, message) = match support {
        LoopbackSupport::Ready => (true, true, None),
        LoopbackSupport::NoDevice => (
            false,
            false,
            Some(
                "No audio output device is available. Connect speakers or headphones to capture system audio."
                    .to_string(),
            ),
        ),
        LoopbackSupport::ConfigUnavailable(detail) => (
            true,
            false,
            Some(format!(
                "The audio output device did not report a usable format for system audio capture ({detail})."
            )),
        ),
        LoopbackSupport::UnsupportedFormat(format) => (
            true,
            false,
            Some(format!(
                "The audio output device uses a sample format that system audio capture does not support ({format})."
            )),
        ),
    };
    SourceReadinessDto {
        source: RecordingSource::System,
        required: true,
        ready: capture_available,
        // WASAPI loopback needs no OS permission, so the permission gate is
        // always "granted"; what can block capture is the absence of a render
        // device to loop back from, or a device whose mix config the loopback
        // stream cannot consume.
        permission_state: "granted".to_string(),
        device_available,
        capture_available,
        // No recovery_action: there is no system-audio privacy pane to send the
        // user to on Windows, so the frontend simply does not offer one.
        recovery_action: None,
        message,
    }
}

pub fn system_audio_readiness() -> SourceReadinessDto {
    readiness_from_loopback_support(probe_loopback_support())
}

pub fn helper_permission_check() -> Result<(), AppError> {
    // Loopback capture requires no permission grant on Windows.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_formats_match_the_loopback_stream_arms() {
        for format in [
            cpal::SampleFormat::F32,
            cpal::SampleFormat::I16,
            cpal::SampleFormat::U16,
            cpal::SampleFormat::I32,
            cpal::SampleFormat::F64,
        ] {
            assert!(
                is_supported_loopback_sample_format(format),
                "{format:?} should be supported"
            );
        }
        for format in [
            cpal::SampleFormat::I8,
            cpal::SampleFormat::U8,
            cpal::SampleFormat::I64,
            cpal::SampleFormat::U32,
            cpal::SampleFormat::U64,
        ] {
            assert!(
                !is_supported_loopback_sample_format(format),
                "{format:?} has no conversion arm"
            );
        }
    }

    #[test]
    fn readiness_ready_when_probe_passes() {
        let readiness = readiness_from_loopback_support(LoopbackSupport::Ready);
        assert!(readiness.ready);
        assert!(readiness.device_available);
        assert!(readiness.capture_available);
        assert_eq!(readiness.permission_state, "granted");
        assert!(readiness.message.is_none());
    }

    #[test]
    fn readiness_not_ready_without_device() {
        let readiness = readiness_from_loopback_support(LoopbackSupport::NoDevice);
        assert!(!readiness.ready);
        assert!(!readiness.device_available);
        assert!(!readiness.capture_available);
        assert_eq!(readiness.permission_state, "granted");
        assert!(readiness.message.is_some());
    }

    #[test]
    fn readiness_not_ready_when_mix_config_is_unavailable() {
        let readiness = readiness_from_loopback_support(LoopbackSupport::ConfigUnavailable(
            "device not available".to_string(),
        ));
        assert!(!readiness.ready);
        assert!(readiness.device_available);
        assert!(!readiness.capture_available);
        let message = readiness.message.expect("message");
        assert!(message.contains("device not available"));
    }

    #[test]
    fn writer_outcome_propagates_a_mid_capture_write_failure() {
        // A write failure must fail the recording even when finalize itself
        // succeeds, otherwise the file finalizes after silently losing audio.
        assert_eq!(
            writer_thread_outcome(Some("disk full".to_string()), Ok(())),
            Err("disk full".to_string())
        );
        // The first write failure also wins over a later finalize failure:
        // it is the root cause the user should see.
        assert_eq!(
            writer_thread_outcome(
                Some("disk full".to_string()),
                Err("finalize failed".to_string())
            ),
            Err("disk full".to_string())
        );
    }

    #[test]
    fn writer_outcome_reports_finalize_result_without_write_failures() {
        assert_eq!(writer_thread_outcome(None, Ok(())), Ok(()));
        assert_eq!(
            writer_thread_outcome(None, Err("finalize failed".to_string())),
            Err("finalize failed".to_string())
        );
    }

    #[test]
    fn readiness_not_ready_on_unsupported_sample_format() {
        let readiness =
            readiness_from_loopback_support(LoopbackSupport::UnsupportedFormat("U8".to_string()));
        assert!(!readiness.ready);
        assert!(readiness.device_available);
        assert!(!readiness.capture_available);
        assert_eq!(readiness.permission_state, "granted");
        let message = readiness.message.expect("message");
        assert!(message.contains("U8"));
    }
}
