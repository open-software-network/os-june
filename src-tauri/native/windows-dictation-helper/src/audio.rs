use crate::protocol::MicrophoneDevice;
use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use std::{
    fs::File,
    io::BufWriter,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

pub struct Recorder {
    stream: cpal::Stream,
    writer: Arc<Mutex<Option<hound::WavWriter<BufWriter<File>>>>>,
    started_at: Instant,
    path: PathBuf,
    observed_peak: Arc<Mutex<f32>>,
    latest_level: Arc<Mutex<f32>>,
    active: Arc<AtomicBool>,
}

#[derive(Clone, Debug)]
pub struct RecordingSummary {
    pub path: PathBuf,
    pub duration: Duration,
    pub observed_level: f32,
}

pub fn list_microphones() -> Result<(Vec<MicrophoneDevice>, Option<MicrophoneDevice>)> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|device| device.name().ok());
    let mut devices = Vec::new();
    for (index, device) in host.input_devices()?.enumerate() {
        let name = device
            .name()
            .unwrap_or_else(|_| format!("Microphone {}", index + 1));
        devices.push(MicrophoneDevice {
            id: name.clone(),
            name,
        });
    }
    let default = default_name.and_then(|name| {
        devices
            .iter()
            .find(|device| device.name == name)
            .cloned()
            .or_else(|| {
                Some(MicrophoneDevice {
                    id: name.clone(),
                    name,
                })
            })
    });
    Ok((devices, default))
}

pub fn microphone_permission_status() -> &'static str {
    let host = cpal::default_host();
    if host.default_input_device().is_some() {
        "granted"
    } else {
        "denied"
    }
}

impl Recorder {
    pub fn start(selected_id: Option<&str>) -> Result<Self> {
        let host = cpal::default_host();
        let device = select_input_device(&host, selected_id)?;
        let supported = device.default_input_config()?;
        let sample_format = supported.sample_format();
        let config: StreamConfig = supported.config();
        let spec = hound::WavSpec {
            channels: config.channels,
            sample_rate: config.sample_rate.0,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let path = tempfile::Builder::new()
            .prefix("os-june-dictation-")
            .suffix(".wav")
            .tempfile()?
            .into_temp_path()
            .keep()?;
        let writer = Arc::new(Mutex::new(Some(hound::WavWriter::create(&path, spec)?)));
        let observed_peak = Arc::new(Mutex::new(0.0));
        let latest_level = Arc::new(Mutex::new(0.0));
        let active = Arc::new(AtomicBool::new(true));
        let writer_for_stream = Arc::clone(&writer);
        let peak_for_stream = Arc::clone(&observed_peak);
        let latest_for_stream = Arc::clone(&latest_level);
        let err_fn = |error| eprintln!("dictation audio stream error: {error}");

        let stream = match sample_format {
            SampleFormat::F32 => device.build_input_stream(
                &config,
                move |data: &[f32], _| {
                    write_samples(
                        data,
                        &writer_for_stream,
                        &peak_for_stream,
                        &latest_for_stream,
                    )
                },
                err_fn,
                None,
            )?,
            SampleFormat::I16 => device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    write_samples(
                        data,
                        &writer_for_stream,
                        &peak_for_stream,
                        &latest_for_stream,
                    )
                },
                err_fn,
                None,
            )?,
            SampleFormat::U16 => device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    write_samples(
                        data,
                        &writer_for_stream,
                        &peak_for_stream,
                        &latest_for_stream,
                    )
                },
                err_fn,
                None,
            )?,
            _ => return Err(anyhow!("unsupported input sample format")),
        };
        stream.play()?;
        Ok(Self {
            stream,
            writer,
            started_at: Instant::now(),
            path,
            observed_peak,
            latest_level,
            active,
        })
    }

    pub fn latest_level_handle(&self) -> (Arc<Mutex<f32>>, Arc<AtomicBool>) {
        (Arc::clone(&self.latest_level), Arc::clone(&self.active))
    }

    pub fn stop(self) -> Result<RecordingSummary> {
        self.active.store(false, Ordering::SeqCst);
        drop(self.stream);
        if let Some(writer) = self.writer.lock().ok().and_then(|mut writer| writer.take()) {
            writer.finalize()?;
        }
        let observed_level = self
            .observed_peak
            .lock()
            .map(|level| *level)
            .unwrap_or_default();
        Ok(RecordingSummary {
            path: self.path,
            duration: self.started_at.elapsed(),
            observed_level,
        })
    }
}

fn select_input_device(host: &cpal::Host, selected_id: Option<&str>) -> Result<cpal::Device> {
    if let Some(selected_id) = selected_id.filter(|id| !id.trim().is_empty()) {
        for device in host.input_devices()? {
            if device.name().ok().as_deref() == Some(selected_id) {
                return Ok(device);
            }
        }
    }
    host.default_input_device()
        .context("no default input microphone is available")
}

trait ToI16Sample {
    fn to_i16_sample(self) -> i16;
    fn level(self) -> f32;
}

impl ToI16Sample for f32 {
    fn to_i16_sample(self) -> i16 {
        (self.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
    }

    fn level(self) -> f32 {
        self.abs().clamp(0.0, 1.0)
    }
}

impl ToI16Sample for i16 {
    fn to_i16_sample(self) -> i16 {
        self
    }

    fn level(self) -> f32 {
        (self as f32 / i16::MAX as f32).abs().clamp(0.0, 1.0)
    }
}

impl ToI16Sample for u16 {
    fn to_i16_sample(self) -> i16 {
        (self as i32 - i16::MAX as i32 - 1) as i16
    }

    fn level(self) -> f32 {
        let centered = self as f32 / u16::MAX as f32 * 2.0 - 1.0;
        centered.abs().clamp(0.0, 1.0)
    }
}

fn write_samples<T: Copy + ToI16Sample>(
    data: &[T],
    writer: &Arc<Mutex<Option<hound::WavWriter<BufWriter<File>>>>>,
    observed_peak: &Arc<Mutex<f32>>,
    latest_level: &Arc<Mutex<f32>>,
) {
    let mut peak = 0.0f32;
    if let Ok(mut guard) = writer.lock() {
        if let Some(writer) = guard.as_mut() {
            for sample in data {
                peak = peak.max(sample.level());
                let _ = writer.write_sample(sample.to_i16_sample());
            }
        }
    }
    if let Ok(mut latest) = latest_level.lock() {
        *latest = peak;
    }
    if let Ok(mut observed) = observed_peak.lock() {
        *observed = observed.max(peak);
    }
}
