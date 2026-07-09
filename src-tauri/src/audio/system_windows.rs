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
    time::Duration,
};

pub const SYSTEM_AUDIO_PERMISSION_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const CAPTURE_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug, Clone, Default)]
struct WindowsSystemAudioStats {
    level: AudioLevelDto,
    max_level: f32,
    bytes_written: i64,
    last_error: Option<String>,
}

pub struct SystemAudioCapture {
    stop_requested: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    stats: Arc<Mutex<WindowsSystemAudioStats>>,
    partial_path: PathBuf,
    final_path: PathBuf,
    worker: Option<JoinHandle<Result<(), AppError>>>,
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

    pub fn stop(mut self) -> Result<PathBuf, AppError> {
        self.stop_requested.store(true, Ordering::Release);
        let worker_result = self
            .worker
            .take()
            .ok_or_else(|| {
                AppError::new(
                    "system_audio_unavailable",
                    "System audio worker is missing.",
                )
            })?
            .join()
            .map_err(|_| {
                AppError::new("system_audio_unavailable", "System audio worker panicked.")
            })?;
        worker_result?;
        if self.partial_path.exists() {
            std::fs::rename(&self.partial_path, &self.final_path)
                .map_err(|error| AppError::new("audio_finalization_failed", error.to_string()))?;
        }
        Ok(self.final_path)
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
    while !stop_requested.load(Ordering::Acquire) {
        if paused.load(Ordering::Acquire) {
            thread::sleep(CAPTURE_POLL_INTERVAL);
            continue;
        }
        let wrote_packet = backend.write_next_packet(&mut writer, &stats)?;
        if !wrote_packet {
            thread::sleep(CAPTURE_POLL_INTERVAL);
        }
    }
    writer
        .finalize()
        .map_err(|error| AppError::new("audio_finalization_failed", error.to_string()))
}

fn default_render_endpoint_available() -> Result<(), AppError> {
    WasapiLoopbackBackend::probe_default_endpoint()
}

#[cfg(target_os = "windows")]
struct WasapiLoopbackBackend {
    _com: ComApartment,
    audio_client: windows::Win32::Media::Audio::IAudioClient,
    capture_client: windows::Win32::Media::Audio::IAudioCaptureClient,
    channels: u16,
    sample_rate: u32,
    bytes_per_frame: usize,
}

#[cfg(target_os = "windows")]
impl WasapiLoopbackBackend {
    fn probe_default_endpoint() -> Result<(), AppError> {
        let _com = ComApartment::new()?;
        let _ = default_render_endpoint()?;
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
        let format = unsafe { *mix_format };
        let channels = format.nChannels;
        let sample_rate = format.nSamplesPerSec;
        let bytes_per_frame = format.nBlockAlign as usize;
        if channels == 0 || sample_rate == 0 || bytes_per_frame == 0 {
            unsafe { CoTaskMemFree(Some(mix_format.cast())) };
            return Err(AppError::new(
                "system_audio_unavailable",
                "Default output device reported an unusable audio format.",
            ));
        }
        let initialize_result = unsafe {
            audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                10_000_000,
                0,
                mix_format,
                None,
            )
        };
        unsafe { CoTaskMemFree(Some(mix_format.cast())) };
        initialize_result
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
        })
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
            write_pcm16_from_mix_format(writer, samples, self.channels, self.bytes_per_frame, stats)
        };
        let release_result = unsafe { self.capture_client.ReleaseBuffer(frames) }
            .map_err(|error| AppError::new("system_audio_capture_unavailable", error.to_string()));
        write_result?;
        release_result?;
        Ok(true)
    }
}

#[cfg(target_os = "windows")]
impl Drop for WasapiLoopbackBackend {
    fn drop(&mut self) {
        let _ = unsafe { self.audio_client.Stop() };
    }
}

#[cfg(target_os = "windows")]
struct ComApartment;

#[cfg(target_os = "windows")]
impl ComApartment {
    fn new() -> Result<Self, AppError> {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .map(|_| Self)
            .map_err(|error| AppError::new("system_audio_unavailable", error.to_string()))
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
            let normalized = sample_to_f32(sample);
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

fn sample_to_f32(sample: &[u8]) -> f32 {
    match sample.len() {
        4 => f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]),
        3 => {
            let sign = if sample[2] & 0x80 == 0 { 0x00 } else { 0xff };
            i32::from_le_bytes([sample[0], sample[1], sample[2], sign]) as f32 / 8_388_608.0
        }
        2 => i16::from_le_bytes([sample[0], sample[1]]) as f32 / i16::MAX as f32,
        1 => (sample[0] as f32 - 128.0) / 128.0,
        _ => 0.0,
    }
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
        assert!((sample_to_f32(&1.0_f32.to_le_bytes()) - 1.0).abs() < f32::EPSILON);
        assert_eq!(sample_to_f32(&0_i16.to_le_bytes()), 0.0);
        assert!((sample_to_f32(&i16::MAX.to_le_bytes()) - 1.0).abs() < 0.0001);
    }
}
