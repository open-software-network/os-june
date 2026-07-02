//! Linux system-audio capture.
//!
//! June records what the meeting participants hear by capturing the default
//! sink's *monitor* source through the PulseAudio client API. libpulse is the
//! pragmatic universal choice: it links `libpulse.so.0` / `libpulse-simple.so.0`
//! which every desktop ships, and it works natively on PipeWire desktops via
//! the `pipewire-pulse` compatibility server as well as on legacy PulseAudio.
//! Capturing a monitor source requires no OS-level permission, unlike the macOS
//! process-tap path.
//!
//! The observable behavior mirrors the macOS helper
//! (`native/mac-system-audio-recorder/main.swift`): the system track is
//! wall-clock aligned with the separately recorded microphone track. A
//! `timeline_offset` of silence is written at the start, and alignment is kept
//! across pause/resume by filling any drift with silence (paused spans are
//! excluded from the timeline, exactly like `writeTimelineSilenceIfNeeded`).
//!
//! The public surface matches `system_macos`:
//! `SystemAudioCapture::{start, pause, resume, status, stop}`,
//! `system_audio_readiness`, and `helper_permission_check`.

use crate::audio::system_timeline::{
    active_elapsed, expected_frames, max_silence_chunk_frames, silence_frames_to_fill,
    tolerance_frames, LevelAccumulator,
};
use crate::domain::types::{AppError, AudioLevelDto, RecordingSource, SourceReadinessDto};
use hound::{SampleFormat, WavSpec, WavWriter};
use libpulse_binding::{
    callbacks::ListResult,
    context::{Context, FlagSet, State as ContextState},
    mainloop::standard::{IterateResult, Mainloop},
    operation::{Operation, State as OperationState},
    sample::{Format, Spec},
    stream::Direction,
};
use libpulse_simple_binding::Simple;
use std::{
    cell::RefCell,
    fs::File,
    io::BufWriter,
    path::PathBuf,
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

/// We request a fixed, universally supported capture spec and let PulseAudio /
/// PipeWire resample from the sink's native format. Transcription resamples
/// again downstream, and it only requires signed 16-bit PCM.
const CAPTURE_SAMPLE_RATE: u32 = 48_000;
const CAPTURE_CHANNELS: u8 = 2;
/// 10 ms read granularity: small enough to keep `stop()` latency and the live
/// meter responsive, large enough to avoid excessive syscalls.
const READ_CHUNK_FRAMES: usize = (CAPTURE_SAMPLE_RATE as usize) / 100;
const CONNECT_BUDGET: Duration = Duration::from_secs(5);
const OPERATION_BUDGET: Duration = Duration::from_secs(5);
const START_TIMEOUT: Duration = Duration::from_secs(10);
/// How often the WAV header is refreshed so the partial file stays readable.
const FLUSH_INTERVAL: Duration = Duration::from_millis(500);
/// Optional override to pin a specific PulseAudio source (e.g. a particular
/// sink monitor). Handy when the default sink changes (Bluetooth switching) or
/// for deterministic testing. When unset, the default sink monitor is used.
const SOURCE_OVERRIDE_ENV: &str = "JUNE_SYSTEM_AUDIO_SOURCE";

type WavFileWriter = WavWriter<BufWriter<File>>;

#[derive(Debug, Clone)]
struct MonitorSource {
    name: String,
}

#[derive(Default)]
struct CaptureStats {
    /// Cumulative peak/rms plus the rolling per-chunk peak window, computed
    /// exactly like the microphone path and the Windows backend.
    level: LevelAccumulator,
    bytes_written: i64,
    last_error: Option<String>,
}

struct Shared {
    paused: AtomicBool,
    stop: AtomicBool,
    stats: Mutex<CaptureStats>,
}

pub struct SystemAudioCapture {
    partial_path: PathBuf,
    final_path: PathBuf,
    shared: Arc<Shared>,
    handle: Option<JoinHandle<()>>,
}

impl SystemAudioCapture {
    pub fn start(
        partial_path: PathBuf,
        final_path: PathBuf,
        timeline_offset: Duration,
    ) -> Result<Self, AppError> {
        let monitor = probe_monitor_source()
            .map_err(|message| AppError::new("system_audio_capture_unavailable", message))?;

        if let Some(parent) = partial_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppError::new("system_audio_capture_unavailable", error.to_string())
            })?;
        }
        let spec = WavSpec {
            channels: CAPTURE_CHANNELS as u16,
            sample_rate: CAPTURE_SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let writer = WavWriter::create(&partial_path, spec).map_err(|error| {
            AppError::new("system_audio_capture_unavailable", error.to_string())
        })?;

        let shared = Arc::new(Shared {
            paused: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            stats: Mutex::new(CaptureStats::default()),
        });
        let thread_shared = Arc::clone(&shared);
        let source_name = monitor.name.clone();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), AppError>>();

        let handle = std::thread::Builder::new()
            .name("june-system-audio".to_string())
            .spawn(move || {
                capture_loop(
                    source_name,
                    writer,
                    thread_shared,
                    timeline_offset,
                    ready_tx,
                );
            })
            .map_err(|error| {
                AppError::new("system_audio_capture_unavailable", error.to_string())
            })?;

        // The capture thread opens the PulseAudio stream, then reports the
        // outcome so `start()` can return the real error synchronously.
        match ready_rx.recv_timeout(START_TIMEOUT) {
            Ok(Ok(())) => Ok(Self {
                partial_path,
                final_path,
                shared,
                handle: Some(handle),
            }),
            Ok(Err(error)) => {
                shared.stop.store(true, Ordering::Release);
                let _ = handle.join();
                let _ = std::fs::remove_file(&partial_path);
                Err(error)
            }
            Err(_) => {
                shared.stop.store(true, Ordering::Release);
                let _ = handle.join();
                let _ = std::fs::remove_file(&partial_path);
                Err(AppError::new(
                    "system_audio_capture_unavailable",
                    format!(
                        "Timed out opening the PulseAudio monitor source '{}'.",
                        monitor.name
                    ),
                ))
            }
        }
    }

    pub fn pause(&mut self) {
        self.shared.paused.store(true, Ordering::Release);
    }

    pub fn resume(&mut self) {
        self.shared.paused.store(false, Ordering::Release);
    }

    pub fn status(&self) -> (AudioLevelDto, i64, Option<String>) {
        let Ok(stats) = self.shared.stats.lock() else {
            return (AudioLevelDto::default(), 0, None);
        };
        (
            stats.level.level(),
            stats.bytes_written,
            stats.last_error.clone(),
        )
    }

    pub fn stop(mut self) -> Result<PathBuf, AppError> {
        self.shared.stop.store(true, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            // The thread finalizes the WAV (writes the real header sizes) before
            // it exits, so the file is complete once the join returns.
            let _ = handle.join();
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
        // Guard against a capture being dropped without `stop()`: never leave the
        // recording thread (and its PulseAudio stream) running in the background.
        self.shared.stop.store(true, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Records the monitor source to `writer`, keeping the file wall-clock aligned.
///
/// Runs on a dedicated thread. It reports the outcome of opening the PulseAudio
/// stream through `ready_tx`, then loops reading fixed-size chunks. It finalizes
/// the WAV before returning so `stop()` only has to rename the file.
fn capture_loop(
    source_name: String,
    mut writer: WavFileWriter,
    shared: Arc<Shared>,
    timeline_offset: Duration,
    ready_tx: mpsc::Sender<Result<(), AppError>>,
) {
    let spec = Spec {
        format: Format::S16le,
        rate: CAPTURE_SAMPLE_RATE,
        channels: CAPTURE_CHANNELS,
    };
    if !spec.is_valid() {
        let _ = ready_tx.send(Err(AppError::new(
            "system_audio_capture_unavailable",
            "Invalid PulseAudio capture specification.",
        )));
        return;
    }

    let simple = match Simple::new(
        None,
        "June",
        Direction::Record,
        Some(source_name.as_str()),
        "System audio",
        &spec,
        None,
        None,
    ) {
        Ok(simple) => simple,
        Err(error) => {
            let _ = ready_tx.send(Err(AppError::new(
                "system_audio_capture_unavailable",
                format!("Could not open PulseAudio monitor source '{source_name}': {error}"),
            )));
            return;
        }
    };
    let _ = ready_tx.send(Ok(()));
    drop(ready_tx);

    let channels = CAPTURE_CHANNELS as usize;
    let bytes_per_frame = 2 * channels;
    let mut buffer = vec![0u8; READ_CHUNK_FRAMES * bytes_per_frame];

    // Discard whatever the server buffered between connecting the stream and the
    // first read. Without this the loop would drain that pre-roll faster than
    // real time and the track would run ahead of the wall clock (unlike the
    // real-time macOS tap). After the flush, monitor delivery is real-time paced,
    // so `origin` marks a clean timeline start.
    let _ = simple.flush();

    // Wall-clock alignment bookkeeping, mirroring the macOS helper:
    // `active_elapsed = timeline_offset + since(origin) - paused_time`.
    let origin = Instant::now();
    let mut accumulated_paused = Duration::ZERO;
    let mut pause_started: Option<Instant> = None;
    let mut frames_written: u64 = 0;
    // Periodically flush the WAV header so the partial file stays readable while
    // recording: `audio::capture` streams the live transcript preview off
    // `system.partial.wav`, and recovery snapshots read it too.
    let mut last_flush = Instant::now();

    loop {
        if shared.stop.load(Ordering::Acquire) {
            break;
        }

        let is_paused = shared.paused.load(Ordering::Acquire);
        match (is_paused, pause_started) {
            (true, None) => pause_started = Some(Instant::now()),
            (false, Some(started)) => {
                accumulated_paused += started.elapsed();
                pause_started = None;
            }
            _ => {}
        }

        // Always drain the monitor source so the server-side buffer never
        // overruns. Monitor sources deliver silence frames continuously, so this
        // read returns roughly every chunk period even when nothing is playing.
        if let Err(error) = simple.read(&mut buffer) {
            record_error(&shared, format!("PulseAudio read failed: {error}"));
            break;
        }

        if is_paused {
            // Skip writing while paused. `accumulated_paused` grows so the paused
            // span is excluded from the timeline, keeping alignment on resume.
            continue;
        }

        let frames_in = READ_CHUNK_FRAMES as u64;
        // Not paused here (the loop `continue`s above while paused), so there is
        // no in-progress pause to fold in: the paused offset is exactly the
        // accumulated paused span.
        let elapsed = active_elapsed(origin.elapsed(), timeline_offset, accumulated_paused);
        match fill_alignment_silence(
            &mut writer,
            &shared,
            elapsed,
            frames_written,
            frames_in,
            channels,
        ) {
            Ok(filled) => frames_written += filled,
            Err(error) => {
                record_error(
                    &shared,
                    format!("Failed to write system audio silence: {error}"),
                );
                break;
            }
        }
        if let Err(error) = write_chunk(&mut writer, &shared, &buffer) {
            record_error(
                &shared,
                format!("Failed to write system audio samples: {error}"),
            );
            break;
        }
        frames_written += frames_in;

        if last_flush.elapsed() >= FLUSH_INTERVAL {
            let _ = writer.flush();
            last_flush = Instant::now();
        }
    }

    // Pad to the current active wall-clock like the macOS helper's
    // `flushTimelineSilenceToNow()` on stop, so the track length reflects the
    // full recording window. Fold in any in-progress pause so a recording
    // stopped while paused pads only up to the last active instant.
    let active_pause = pause_started
        .map(|started| started.elapsed())
        .unwrap_or_default();
    let elapsed = active_elapsed(
        origin.elapsed(),
        timeline_offset,
        accumulated_paused + active_pause,
    );
    let _ = fill_alignment_silence(&mut writer, &shared, elapsed, frames_written, 0, channels);

    if let Err(error) = writer.finalize() {
        record_error(
            &shared,
            format!("Failed to finalize system audio WAV: {error}"),
        );
    }
}

/// Writes leading/drift silence so the file tracks wall-clock time, returning the
/// number of silence frames written. Mirrors `writeTimelineSilenceIfNeeded`:
/// only fills once the gap exceeds the tolerance, then closes the whole gap.
fn fill_alignment_silence(
    writer: &mut WavFileWriter,
    shared: &Arc<Shared>,
    elapsed: Duration,
    frames_written: u64,
    incoming_frames: u64,
    channels: usize,
) -> Result<u64, String> {
    let expected = expected_frames(elapsed, CAPTURE_SAMPLE_RATE);
    let tolerance = tolerance_frames(CAPTURE_SAMPLE_RATE);
    // Returns the whole gap once it exceeds the 80 ms tolerance, else 0 (so the
    // loop below never runs and no silence is written).
    let mut missing = silence_frames_to_fill(
        expected,
        frames_written as i64,
        incoming_frames as i64,
        tolerance,
    );
    let chunk_cap = max_silence_chunk_frames(CAPTURE_SAMPLE_RATE);
    let mut filled: u64 = 0;
    while missing > 0 {
        let chunk = missing.min(chunk_cap);
        for _ in 0..(chunk as usize * channels) {
            writer
                .write_sample(0i16)
                .map_err(|error| error.to_string())?;
        }
        add_bytes(shared, chunk * (2 * channels) as i64);
        filled += chunk as u64;
        missing -= chunk;
    }
    Ok(filled)
}

/// Writes one chunk of interleaved S16LE samples and updates the live meter the
/// same way the microphone path does (cumulative peak/rms plus a rolling window
/// of recent per-chunk peaks).
fn write_chunk(
    writer: &mut WavFileWriter,
    shared: &Arc<Shared>,
    buffer: &[u8],
) -> Result<(), String> {
    for pair in buffer.chunks_exact(2) {
        let sample = i16::from_le_bytes([pair[0], pair[1]]);
        writer
            .write_sample(sample)
            .map_err(|error| error.to_string())?;
    }
    let sample_count = (buffer.len() / 2) as i64;
    if let Ok(mut stats) = shared.stats.lock() {
        // Fold this chunk into the shared level exactly like the microphone path
        // and the Windows backend: `record_callback` takes signed normalized
        // samples and applies `.abs()` internally.
        stats.level.record_callback(
            buffer
                .chunks_exact(2)
                .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / i16::MAX as f32),
        );
        stats.bytes_written += sample_count * 2;
    }
    Ok(())
}

fn add_bytes(shared: &Arc<Shared>, bytes: i64) {
    if let Ok(mut stats) = shared.stats.lock() {
        stats.bytes_written += bytes;
    }
}

fn record_error(shared: &Arc<Shared>, message: String) {
    if let Ok(mut stats) = shared.stats.lock() {
        stats.last_error = Some(message);
    }
}

pub fn system_audio_readiness() -> SourceReadinessDto {
    match probe_monitor_source() {
        Ok(_) => SourceReadinessDto {
            source: RecordingSource::System,
            required: true,
            ready: true,
            // Capturing a sink monitor needs no OS-level permission on Linux.
            permission_state: "granted".to_string(),
            device_available: true,
            capture_available: true,
            recovery_action: None,
            message: None,
        },
        Err(message) => SourceReadinessDto {
            source: RecordingSource::System,
            required: true,
            ready: false,
            device_available: false,
            capture_available: false,
            // There is still no OS permission to grant; the source is simply
            // unavailable (no server, or no default sink monitor).
            permission_state: "granted".to_string(),
            recovery_action: None,
            message: Some(message),
        },
    }
}

pub fn helper_permission_check() -> Result<(), AppError> {
    probe_monitor_source()
        .map(|_| ())
        .map_err(|message| AppError::new("system_audio_capture_unavailable", message))
}

/// Resolves the monitor source to record: the `JUNE_SYSTEM_AUDIO_SOURCE`
/// override when set, otherwise the default sink's monitor via introspection.
fn probe_monitor_source() -> Result<MonitorSource, String> {
    if let Ok(name) = std::env::var(SOURCE_OVERRIDE_ENV) {
        let name = name.trim().to_string();
        if !name.is_empty() {
            return Ok(MonitorSource { name });
        }
    }
    resolve_default_monitor_source()
}

/// Connects to the audio server and resolves the default sink's monitor source
/// name. Doubles as the readiness / permission probe: a clean success means a
/// server is reachable and a default sink monitor exists.
fn resolve_default_monitor_source() -> Result<MonitorSource, String> {
    let mut mainloop =
        Mainloop::new().ok_or_else(|| "Could not create a PulseAudio mainloop.".to_string())?;
    let mut context = Context::new(&mainloop, "June system audio probe")
        .ok_or_else(|| "Could not create a PulseAudio context.".to_string())?;
    context
        .connect(None, FlagSet::NOFLAGS, None)
        .map_err(|error| format!("No PulseAudio or PipeWire audio server reachable: {error}"))?;

    iterate_until(&mut mainloop, CONNECT_BUDGET, || {
        match context.get_state() {
            ContextState::Ready => Some(Ok(())),
            ContextState::Failed | ContextState::Terminated => Some(Err(
                "No PulseAudio or PipeWire audio server reachable.".to_string(),
            )),
            _ => None,
        }
    })?;

    let default_sink: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
    {
        let sink = Rc::clone(&default_sink);
        let op = context.introspect().get_server_info(move |info| {
            if let Some(name) = info.default_sink_name.as_ref() {
                *sink.borrow_mut() = Some(name.to_string());
            }
        });
        wait_for_operation(&mut mainloop, &op, "read the default audio sink")?;
    }
    let sink_name = default_sink
        .borrow_mut()
        .take()
        .ok_or_else(|| "No default audio output (sink) is configured.".to_string())?;

    let monitor: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
    {
        let monitor = Rc::clone(&monitor);
        let op = context
            .introspect()
            .get_sink_info_by_name(&sink_name, move |result| {
                if let ListResult::Item(info) = result {
                    if let Some(name) = info.monitor_source_name.as_ref() {
                        *monitor.borrow_mut() = Some(name.to_string());
                    }
                }
            });
        wait_for_operation(&mut mainloop, &op, "read the sink monitor source")?;
    }
    // Every sink exposes a monitor source; fall back to the conventional name if
    // the server did not report one explicitly.
    let source_name = monitor
        .borrow_mut()
        .take()
        .unwrap_or_else(|| format!("{sink_name}.monitor"));

    context.disconnect();
    Ok(MonitorSource { name: source_name })
}

/// Drives the mainloop non-blocking until `done` yields a result or the budget
/// elapses. The short sleep keeps the probe from busy-spinning a CPU while it
/// waits for the server.
fn iterate_until<F>(mainloop: &mut Mainloop, budget: Duration, mut done: F) -> Result<(), String>
where
    F: FnMut() -> Option<Result<(), String>>,
{
    let started = Instant::now();
    loop {
        match mainloop.iterate(false) {
            IterateResult::Quit(_) => {
                return Err("The PulseAudio mainloop quit unexpectedly.".to_string())
            }
            IterateResult::Err(error) => return Err(format!("PulseAudio mainloop error: {error}")),
            IterateResult::Success(_) => {}
        }
        if let Some(result) = done() {
            return result;
        }
        if started.elapsed() >= budget {
            return Err(
                "Timed out talking to the PulseAudio or PipeWire audio server.".to_string(),
            );
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn wait_for_operation<T: ?Sized>(
    mainloop: &mut Mainloop,
    op: &Operation<T>,
    what: &str,
) -> Result<(), String> {
    iterate_until(mainloop, OPERATION_BUDGET, || match op.get_state() {
        OperationState::Done => Some(Ok(())),
        OperationState::Cancelled => Some(Err(format!(
            "The audio server cancelled the request to {what}."
        ))),
        OperationState::Running => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::WavReader;

    // Functional capture test. Requires a running PulseAudio/PipeWire server with
    // an audible default-sink monitor; the Docker harness sets that up and runs
    // this with `cargo test -- --ignored`.
    #[test]
    #[ignore = "requires a running audio server with an audible monitor source"]
    fn records_non_silent_int16_from_monitor() {
        let dir = std::env::temp_dir().join(format!("june-sysaudio-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let partial = dir.join("system.partial.wav");
        let final_path = dir.join("system.wav");
        let _ = std::fs::remove_file(&partial);
        let _ = std::fs::remove_file(&final_path);

        let capture =
            SystemAudioCapture::start(partial.clone(), final_path.clone(), Duration::ZERO)
                .expect("system audio capture should start");
        std::thread::sleep(Duration::from_secs(2));
        let (level, bytes, last_error) = capture.status();
        assert!(
            last_error.is_none(),
            "capture reported error: {last_error:?}"
        );
        assert!(bytes > 0, "expected bytes to be written during capture");

        let out = capture.stop().expect("stop should finalize the WAV");
        assert_eq!(out, final_path);

        let mut reader = WavReader::open(&out).expect("output WAV should be readable");
        let spec = reader.spec();
        assert_eq!(spec.bits_per_sample, 16, "must be 16-bit PCM");
        assert_eq!(
            spec.sample_format,
            SampleFormat::Int,
            "must be signed int PCM"
        );

        let mut peak: i32 = 0;
        let mut count: u64 = 0;
        for sample in reader.samples::<i16>() {
            let sample = sample.unwrap_or(0);
            peak = peak.max((sample as i32).abs());
            count += 1;
        }
        assert!(count > 0, "expected samples in the recording");
        assert!(
            peak > 200,
            "expected non-silent int16 samples: peak={peak} count={count} bytes={bytes} meter_peak={}",
            level.peak
        );
    }
}
