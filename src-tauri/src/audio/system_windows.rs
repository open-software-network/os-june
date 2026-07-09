use crate::domain::types::{AppError, AudioLevelDto, RecordingSource, SourceReadinessDto};
use hound::{SampleFormat, WavSpec, WavWriter};
use std::{
    fs::File,
    io::BufWriter,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use windows::core::GUID;

pub const SYSTEM_AUDIO_PERMISSION_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const CAPTURE_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug, Clone, Default)]
struct WindowsSystemAudioStats {
    level: AudioLevelDto,
    max_level: f32,
    bytes_written: i64,
    last_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SystemAudioFailure {
    pub code: String,
    pub message: String,
}

pub struct SystemAudioCapture {
    stop_requested: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    stats: Arc<Mutex<WindowsSystemAudioStats>>,
    partial_path: PathBuf,
    final_path: PathBuf,
    worker: Option<JoinHandle<Result<(), AppError>>>,
}

pub enum SystemAudioStopResult {
    Failed(SystemAudioFailure),
    Stopped(PathBuf),
}

impl SystemAudioCapture {
    pub fn start(
        partial_path: PathBuf,
        final_path: PathBuf,
        _timeline_offset: Duration,
    ) -> Result<Self, AppError> {
        let stop_requested = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let stats = Arc::new(Mutex::new(WindowsSystemAudioStats::default()));
        let worker = {
            let stop_requested = Arc::clone(&stop_requested);
            let paused = Arc::clone(&paused);
            let stats = Arc::clone(&stats);
            let partial_path = partial_path.clone();
            thread::Builder::new()
                .name("june-windows-system-audio".to_string())
                .spawn(move || capture_loop(partial_path, stop_requested, paused, stats))
                .map_err(|error| AppError::new("system_audio_unavailable", error.to_string()))?
        };
        Ok(Self {
            stop_requested,
            paused,
            stats,
            partial_path,
            final_path,
            worker: Some(worker),
        })
    }

    pub fn pause(&mut self) {
        self.paused.store(true, Ordering::Release);
    }

    pub fn resume(&mut self) {
        self.paused.store(false, Ordering::Release);
    }

    pub fn status(&self) -> (AudioLevelDto, i64, Option<String>) {
        self.stats
            .lock()
            .map(|stats| {
                (
                    stats.level.clone(),
                    stats.bytes_written,
                    stats.last_error.clone(),
                )
            })
            .unwrap_or_default()
    }

    pub fn stop(mut self) -> SystemAudioStopResult {
        self.stop_requested.store(true, Ordering::Release);
        let worker_result = match self.worker.take() {
            Some(worker) => worker.join().map_err(|_| {
                AppError::new("system_audio_unavailable", "System audio worker panicked.")
            }),
            None => Err(AppError::new(
                "system_audio_unavailable",
                "System audio worker is missing.",
            )),
        };
        if let Err(error) = worker_result.and_then(|result| result) {
            return SystemAudioStopResult::Failed(SystemAudioFailure {
                code: error.code,
                message: error.message,
            });
        }
        if self.partial_path.exists() {
            if let Err(error) = std::fs::rename(&self.partial_path, &self.final_path) {
                return SystemAudioStopResult::Failed(SystemAudioFailure {
                    code: "audio_finalization_failed".to_string(),
                    message: error.to_string(),
                });
            }
        }
        SystemAudioStopResult::Stopped(self.final_path)
    }
}

pub fn system_audio_readiness() -> SourceReadinessDto {
    match default_render_endpoint_available() {
        Ok(()) => SourceReadinessDto {
            source: RecordingSource::System,
            required: true,
            ready: true,
            permission_state: "granted".to_string(),
            device_available: true,
            capture_available: true,
            recovery_action: None,
            message: None,
        },
        Err(error) => SourceReadinessDto {
            source: RecordingSource::System,
            required: true,
            ready: false,
            permission_state: "unsupported".to_string(),
            device_available: false,
            capture_available: false,
            recovery_action: Some("openSoundSettings".to_string()),
            message: Some(error.message),
        },
    }
}

pub fn helper_permission_check() -> Result<(), AppError> {
    default_render_endpoint_available()
}

fn capture_loop(
    partial_path: PathBuf,
    stop_requested: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    stats: Arc<Mutex<WindowsSystemAudioStats>>,
) -> Result<(), AppError> {
    let mut backend = WasapiLoopbackBackend::new()?;
    let spec = WavSpec {
        channels: backend.channels,
        sample_rate: backend.sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(&partial_path, spec)
        .map_err(|error| AppError::new("audio_writer_failed", error.to_string()))?;
    let mut last_written_at = Instant::now();
    let mut pending_silence_frames = 0.0_f64;
    let mut was_paused = false;
    while !stop_requested.load(Ordering::Acquire) {
        if paused.load(Ordering::Acquire) {
            if !was_paused {
                backend.pause()?;
                was_paused = true;
            }
            thread::sleep(CAPTURE_POLL_INTERVAL);
            continue;
        }
        if was_paused {
            backend.resume()?;
            last_written_at = Instant::now();
            pending_silence_frames = 0.0;
            was_paused = false;
        }
        let wrote_packet = backend.write_next_packet(&mut writer, &stats)?;
        let now = Instant::now();
        if wrote_packet {
            last_written_at = now;
            pending_silence_frames = 0.0;
            continue;
        }
        let silent_frames = idle_frames_since(
            &mut pending_silence_frames,
            last_written_at,
            now,
            backend.sample_rate,
        );
        if silent_frames > 0 {
            write_silence(&mut writer, silent_frames, backend.channels, &stats)?;
            last_written_at +=
                Duration::from_secs_f64(silent_frames as f64 / backend.sample_rate as f64);
        }
        thread::sleep(CAPTURE_POLL_INTERVAL);
    }
    let trailing_silence_frames = idle_frames_since(
        &mut pending_silence_frames,
        last_written_at,
        Instant::now(),
        backend.sample_rate,
    );
    if trailing_silence_frames > 0 {
        write_silence(
            &mut writer,
            trailing_silence_frames,
            backend.channels,
            &stats,
        )?;
    }
    writer
        .finalize()
        .map_err(|error| AppError::new("audio_finalization_failed", error.to_string()))
}

fn default_render_endpoint_available() -> Result<(), AppError> {
    WasapiLoopbackBackend::probe_default_endpoint()
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MixSampleFormat {
    PcmUnsigned8,
    PcmSigned16,
    PcmSigned24,
    PcmSigned32,
    Float32,
}

#[cfg(target_os = "windows")]
struct WasapiLoopbackBackend {
    _com: ComApartment,
    audio_client: windows::Win32::Media::Audio::IAudioClient,
    capture_client: windows::Win32::Media::Audio::IAudioCaptureClient,
    channels: u16,
    sample_rate: u32,
    bytes_per_frame: usize,
    sample_format: MixSampleFormat,
    started: bool,
}

#[cfg(target_os = "windows")]
impl WasapiLoopbackBackend {
    fn probe_default_endpoint() -> Result<(), AppError> {
        let backend = Self::new()?;
        drop(backend);
        Ok(())
    }

    fn new() -> Result<Self, AppError> {
        use windows::Win32::Media::Audio::{
            IAudioCaptureClient, IAudioClient, AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
        };
        use windows::Win32::System::Com::{CoTaskMemFree, CLSCTX_ALL};

        let com = ComApartment::new()?;
        let device = default_render_endpoint()?;
        let audio_client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }
            .map_err(|error| AppError::new("system_audio_unavailable", error.to_string()))?;
        let mix_format = unsafe { audio_client.GetMixFormat() }
            .map_err(|error| AppError::new("system_audio_unavailable", error.to_string()))?;
        let result = (|| {
            let format = unsafe { *mix_format };
            let channels = format.nChannels;
            let sample_rate = format.nSamplesPerSec;
            let bytes_per_frame = format.nBlockAlign as usize;
            let sample_format = mix_sample_format(mix_format)?;
            if channels == 0 || sample_rate == 0 || bytes_per_frame == 0 {
                return Err(AppError::new(
                    "system_audio_unavailable",
                    "Default output device reported an unusable audio format.",
                ));
            }
            unsafe {
                audio_client.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK,
                    10_000_000,
                    0,
                    mix_format,
                    None,
                )
            }
            .map_err(|error| AppError::new("system_audio_unavailable", error.to_string()))?;
            let capture_client: IAudioCaptureClient = unsafe { audio_client.GetService() }
                .map_err(|error| AppError::new("system_audio_unavailable", error.to_string()))?;
            unsafe { audio_client.Start() }
                .map_err(|error| AppError::new("system_audio_unavailable", error.to_string()))?;
            Ok(Self {
                _com: com,
                audio_client,
                capture_client,
                channels,
                sample_rate,
                bytes_per_frame,
                sample_format,
                started: true,
            })
        })();
        unsafe { CoTaskMemFree(Some(mix_format.cast())) };
        result
    }

    fn write_next_packet(
        &mut self,
        writer: &mut WavWriter<BufWriter<File>>,
        stats: &Arc<Mutex<WindowsSystemAudioStats>>,
    ) -> Result<bool, AppError> {
        use windows::Win32::Media::Audio::AUDCLNT_BUFFERFLAGS_SILENT;
        let packet_frames =
            unsafe { self.capture_client.GetNextPacketSize() }.map_err(|error| {
                AppError::new("system_audio_capture_unavailable", error.to_string())
            })?;
        if packet_frames == 0 {
            return Ok(false);
        }
        let mut data = std::ptr::null_mut();
        let mut frames = 0;
        let mut flags = 0;
        unsafe {
            self.capture_client
                .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
        }
        .map_err(|error| AppError::new("system_audio_capture_unavailable", error.to_string()))?;
        let is_silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
        let write_result = if is_silent {
            write_silence(writer, frames, self.channels, stats)
        } else {
            let bytes = frames as usize * self.bytes_per_frame;
            let samples = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), bytes) };
            write_pcm16_from_mix_format(
                writer,
                samples,
                self.channels,
                self.bytes_per_frame,
                self.sample_format,
                stats,
            )
        };
        let release_result = unsafe { self.capture_client.ReleaseBuffer(frames) }
            .map_err(|error| AppError::new("system_audio_capture_unavailable", error.to_string()));
        write_result?;
        release_result?;
        Ok(true)
    }
    fn pause(&mut self) -> Result<(), AppError> {
        if self.started {
            unsafe { self.audio_client.Stop() }.map_err(|error| {
                AppError::new("system_audio_capture_unavailable", error.to_string())
            })?;
            unsafe { self.audio_client.Reset() }.map_err(|error| {
                AppError::new("system_audio_capture_unavailable", error.to_string())
            })?;
            self.started = false;
        }
        Ok(())
    }

    fn resume(&mut self) -> Result<(), AppError> {
        if !self.started {
            unsafe { self.audio_client.Start() }.map_err(|error| {
                AppError::new("system_audio_capture_unavailable", error.to_string())
            })?;
            self.started = true;
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
impl Drop for WasapiLoopbackBackend {
    fn drop(&mut self) {
        if self.started {
            let _ = unsafe { self.audio_client.Stop() };
        }
    }
}

#[cfg(target_os = "windows")]
struct ComApartment;

#[cfg(target_os = "windows")]
impl ComApartment {
    fn new() -> Result<Self, AppError> {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|error| AppError::new("system_audio_unavailable", error.to_string()))?;
        Ok(Self)
    }
}

#[cfg(target_os = "windows")]
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { windows::Win32::System::Com::CoUninitialize() };
    }
}

#[cfg(target_os = "windows")]
fn default_render_endpoint() -> Result<windows::Win32::Media::Audio::IMMDevice, AppError> {
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|error| AppError::new("system_audio_unavailable", error.to_string()))?;
    unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
        .map_err(|error| AppError::new("system_audio_unavailable", error.to_string()))
}

#[cfg(not(target_os = "windows"))]
struct WasapiLoopbackBackend {
    channels: u16,
    sample_rate: u32,
}

#[cfg(not(target_os = "windows"))]
impl WasapiLoopbackBackend {
    fn probe_default_endpoint() -> Result<(), AppError> {
        Err(AppError::new(
            "system_audio_unsupported",
            "System audio capture is only supported on Windows in this backend.",
        ))
    }

    fn new() -> Result<Self, AppError> {
        Self::probe_default_endpoint()?;
        Ok(Self {
            channels: 2,
            sample_rate: 48_000,
        })
    }

    fn write_next_packet(
        &mut self,
        _writer: &mut WavWriter<BufWriter<File>>,
        _stats: &Arc<Mutex<WindowsSystemAudioStats>>,
    ) -> Result<bool, AppError> {
        Ok(false)
    }
}

fn write_silence(
    writer: &mut WavWriter<BufWriter<File>>,
    frames: u32,
    channels: u16,
    stats: &Arc<Mutex<WindowsSystemAudioStats>>,
) -> Result<(), AppError> {
    let samples = frames as usize * channels as usize;
    for _ in 0..samples {
        writer
            .write_sample(0_i16)
            .map_err(|error| AppError::new("audio_writer_failed", error.to_string()))?;
    }
    update_stats(stats, 0.0, 0.0, samples as i64 * 2, None);
    Ok(())
}

fn write_pcm16_from_mix_format(
    writer: &mut WavWriter<BufWriter<File>>,
    bytes: &[u8],
    channels: u16,
    bytes_per_frame: usize,
    sample_format: MixSampleFormat,
    stats: &Arc<Mutex<WindowsSystemAudioStats>>,
) -> Result<(), AppError> {
    let channels = channels as usize;
    if channels == 0 {
        return Err(AppError::new(
            "system_audio_unavailable",
            "Default output device reported an unusable audio format.",
        ));
    }
    let bytes_per_sample = bytes_per_frame / channels;
    if bytes_per_sample == 0 {
        return Err(AppError::new(
            "system_audio_unavailable",
            "Default output device reported an unusable audio format.",
        ));
    }
    let mut peak = 0.0_f32;
    let mut sum_square = 0.0_f64;
    let mut samples_written = 0_i64;
    for frame in bytes.chunks_exact(bytes_per_frame) {
        for sample in frame.chunks_exact(bytes_per_sample).take(channels) {
            let normalized = sample_to_f32(sample, sample_format);
            let pcm_sample = (normalized.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            let magnitude = normalized.abs();
            peak = peak.max(magnitude);
            sum_square += (magnitude as f64).powi(2);
            samples_written += 1;
            writer
                .write_sample(pcm_sample)
                .map_err(|error| AppError::new("audio_writer_failed", error.to_string()))?;
        }
    }
    let rms = if samples_written == 0 {
        0.0
    } else {
        (sum_square / samples_written as f64).sqrt() as f32
    };
    update_stats(stats, peak, rms, samples_written * 2, None);
    Ok(())
}

fn sample_to_f32(sample: &[u8], sample_format: MixSampleFormat) -> f32 {
    match sample_format {
        MixSampleFormat::Float32 => {
            f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]])
        }
        MixSampleFormat::PcmSigned32 => {
            i32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]) as f32
                / i32::MAX as f32
        }
        MixSampleFormat::PcmSigned24 => {
            let sign = if sample[2] & 0x80 == 0 { 0x00 } else { 0xff };
            i32::from_le_bytes([sample[0], sample[1], sample[2], sign]) as f32 / 8_388_608.0
        }
        MixSampleFormat::PcmSigned16 => {
            i16::from_le_bytes([sample[0], sample[1]]) as f32 / i16::MAX as f32
        }
        MixSampleFormat::PcmUnsigned8 => (sample[0] as f32 - 128.0) / 128.0,
    }
}

#[cfg(target_os = "windows")]
fn mix_sample_format(
    format_ptr: *mut windows::Win32::Media::Audio::WAVEFORMATEX,
) -> Result<MixSampleFormat, AppError> {
    const WAVE_FORMAT_PCM: u16 = 0x0001;
    const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;
    const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

    let format = unsafe { &*format_ptr };
    match format.wFormatTag {
        WAVE_FORMAT_PCM => pcm_sample_format(format.wBitsPerSample),
        WAVE_FORMAT_IEEE_FLOAT => {
            if format.wBitsPerSample == 32 {
                Ok(MixSampleFormat::Float32)
            } else {
                Err(unusable_format_error())
            }
        }
        WAVE_FORMAT_EXTENSIBLE => mix_sample_format_extensible(format_ptr),
        _ => Err(unusable_format_error()),
    }
}

#[cfg(target_os = "windows")]
fn mix_sample_format_extensible(
    format_ptr: *mut windows::Win32::Media::Audio::WAVEFORMATEX,
) -> Result<MixSampleFormat, AppError> {
    use windows::Win32::Media::Audio::WAVEFORMATEXTENSIBLE;

    let format = unsafe { &*(format_ptr as *const WAVEFORMATEXTENSIBLE) };
    let sub_format = unsafe { std::ptr::addr_of!(format.SubFormat).read_unaligned() };
    let bits_per_sample = format.Format.wBitsPerSample;
    let valid_bits_per_sample = unsafe { format.Samples.wValidBitsPerSample };
    if bits_per_sample == 32 && sub_format == ksdataformat_subtype_ieee_float() {
        return Ok(MixSampleFormat::Float32);
    }
    if sub_format == ksdataformat_subtype_pcm() {
        return pcm_sample_format(valid_bits_per_sample.max(bits_per_sample));
    }
    Err(unusable_format_error())
}

#[cfg(target_os = "windows")]
fn pcm_sample_format(bits_per_sample: u16) -> Result<MixSampleFormat, AppError> {
    match bits_per_sample {
        8 => Ok(MixSampleFormat::PcmUnsigned8),
        16 => Ok(MixSampleFormat::PcmSigned16),
        24 => Ok(MixSampleFormat::PcmSigned24),
        32 => Ok(MixSampleFormat::PcmSigned32),
        _ => Err(unusable_format_error()),
    }
}

#[cfg(target_os = "windows")]
fn ksdataformat_subtype_pcm() -> GUID {
    GUID::from_values(
        0x00000001,
        0x0000,
        0x0010,
        [0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71],
    )
}

#[cfg(target_os = "windows")]
fn ksdataformat_subtype_ieee_float() -> GUID {
    GUID::from_values(
        0x00000003,
        0x0000,
        0x0010,
        [0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71],
    )
}

fn unusable_format_error() -> AppError {
    AppError::new(
        "system_audio_unavailable",
        "Default output device reported an unusable audio format.",
    )
}

fn idle_frames_since(
    pending_silence_frames: &mut f64,
    last_written_at: Instant,
    now: Instant,
    sample_rate: u32,
) -> u32 {
    let elapsed = now.saturating_duration_since(last_written_at);
    *pending_silence_frames += elapsed.as_secs_f64() * sample_rate as f64;
    let whole_frames = pending_silence_frames.floor();
    *pending_silence_frames -= whole_frames;
    whole_frames.clamp(0.0, u32::MAX as f64) as u32
}

fn update_stats(
    stats: &Arc<Mutex<WindowsSystemAudioStats>>,
    peak: f32,
    rms: f32,
    bytes_written_delta: i64,
    last_error: Option<String>,
) {
    let Ok(mut stats) = stats.lock() else {
        return;
    };
    stats.max_level = stats.max_level.max(peak);
    stats.bytes_written += bytes_written_delta;
    stats.level = AudioLevelDto {
        peak,
        rms,
        recent_peaks: vec![peak],
    };
    stats.last_error = last_error;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_conversion_handles_float_and_integer_mix_formats() {
        assert!(
            (sample_to_f32(&1.0_f32.to_le_bytes(), MixSampleFormat::Float32) - 1.0).abs()
                < f32::EPSILON
        );
        assert_eq!(
            sample_to_f32(&0_i16.to_le_bytes(), MixSampleFormat::PcmSigned16),
            0.0
        );
        assert!(
            (sample_to_f32(&i16::MAX.to_le_bytes(), MixSampleFormat::PcmSigned16) - 1.0).abs()
                < 0.0001
        );
        assert!(
            (sample_to_f32(&i32::MAX.to_le_bytes(), MixSampleFormat::PcmSigned32) - 1.0).abs()
                < 0.0001
        );
    }

    #[test]
    fn idle_frames_since_converts_elapsed_time_to_frames() {
        let start = Instant::now();
        let later = start + Duration::from_millis(250);
        let mut pending = 0.0;
        assert_eq!(
            idle_frames_since(&mut pending, start, later, 48_000),
            12_000
        );
        assert_eq!(pending, 0.0);
    }

    #[test]
    fn idle_frames_since_preserves_fractional_remainder() {
        let start = Instant::now();
        let mut pending = 0.0;
        let first = start + Duration::from_micros(10_500);
        let second = start + Duration::from_micros(21_000);
        assert_eq!(idle_frames_since(&mut pending, start, first, 48_000), 504);
        assert!(pending > 0.0 && pending < 1.0);
        assert_eq!(idle_frames_since(&mut pending, first, second, 48_000), 504);
        assert!(pending > 0.0 && pending < 1.0);
    }
}
