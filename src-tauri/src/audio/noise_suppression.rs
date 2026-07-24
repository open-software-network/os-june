//! Offline Microphone noise suppression for derived transcription input.
//!
//! The finalized source WAV is never modified. This module downmixes and
//! resamples it into a fingerprinted, atomically-written derived WAV that Turn
//! extraction can use instead. The frame-level [`Denoiser`] seam deliberately
//! keeps the interim dependency-free spectral implementation replaceable by a
//! stronger RNNoise implementation after its dependency is approved.

use crate::domain::types::AppError;
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{BufReader, Read},
    path::{Path, PathBuf},
    sync::Arc,
};

pub const SPECTRAL_DENOISER_ID: &str = "spectral-subtraction-v1";

const TARGET_SAMPLE_RATE: u32 = 16_000;
const SPECTRAL_FRAME_SAMPLES: usize = 512;
const SPECTRAL_HOP_SAMPLES: usize = SPECTRAL_FRAME_SAMPLES / 2;
const SPECTRAL_BINS: usize = (SPECTRAL_FRAME_SAMPLES / 2) + 1;
const RMS_HISTOGRAM_BINS: usize = 192;
const MIN_DBFS: f32 = -96.0;
const MAX_DBFS: f32 = 0.0;
const NOISE_PERCENTILE: f32 = 0.20;
const NOISE_PROFILE_MARGIN_DB: f32 = 3.0;
const CLEAN_NOISE_FLOOR_DBFS: f32 = -58.0;
const SPECTRAL_OVERSUBTRACTION: f32 = 1.5;
const MIN_POWER_RATIO: f32 = 0.035;
const MIN_SPECTRAL_GAIN: f32 = 0.18;
const HIGH_SNR_DB: f32 = 14.0;
const PCM_CHUNK_SAMPLE_BUDGET: usize = 16 * 1024;
const CACHE_DIRECTORY: &str = ".june-transcription-input";
const CACHE_FINGERPRINT_DOMAIN: &[u8] = b"june-microphone-noise-suppression-v1\0";

/// One replaceable frame processor. Implementations declare the PCM shape they
/// accept, then mutate a normalized `f32` frame in place.
///
/// When `hop_samples() < frame_samples()`, the implementation must apply the
/// shared sine analysis and synthesis window. The streaming seam overlap-adds
/// and normalizes those frames. A future RNNoise implementation can instead
/// declare 48 kHz, 480-sample, non-overlapping frames and process them directly.
pub trait Denoiser: Send {
    fn sample_rate(&self) -> u32;
    fn frame_samples(&self) -> usize;
    fn hop_samples(&self) -> usize;
    fn process(&mut self, frame: &mut [f32]) -> Result<(), AppError>;
}

#[derive(Debug)]
pub struct NoiseSuppressionOutput {
    pub path: PathBuf,
    pub cache_hit: bool,
    pub applied: bool,
    pub fingerprint: String,
    pub noise_floor_dbfs: Option<f32>,
    pub cleanup: Option<DerivedTranscriptionInputCleanup>,
}

/// Keeps one derived transcription input alive until every preparation and
/// provider task that can read it has drained.
///
/// The deterministic path remains reusable after a process crash, but normal
/// completion and cancellation remove it instead of retaining a second
/// recording-sized WAV indefinitely.
#[derive(Debug)]
pub struct DerivedTranscriptionInputCleanup {
    path: PathBuf,
}

impl DerivedTranscriptionInputCleanup {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for DerivedTranscriptionInputCleanup {
    fn drop(&mut self) {
        match std::fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(
                    path = %self.path.display(),
                    %error,
                    "failed to remove derived transcription input"
                );
                return;
            }
        }

        let Some(parent) = self.path.parent() else {
            return;
        };
        let directory_is_empty = std::fs::read_dir(parent)
            .ok()
            .is_some_and(|mut entries| entries.next().is_none());
        if directory_is_empty {
            let _ = std::fs::remove_dir(parent);
        }
    }
}

#[derive(Debug, Clone)]
struct NoiseProfile {
    power: Vec<f32>,
    noise_floor_dbfs: f32,
}

/// Produces or reuses a deterministic derived transcription-input WAV.
///
/// Clean inputs are returned unchanged to avoid needlessly touching speech.
/// Errors are intentionally returned to the caller, which owns the
/// source-specific diagnostic and raw-WAV fallback policy.
pub fn suppress_microphone_wav_for_transcription(
    input_path: &Path,
) -> Result<NoiseSuppressionOutput, AppError> {
    let input_sha256 = sha256_file(input_path)?;
    let fingerprint = derived_fingerprint(&input_sha256);
    let cache_path = derived_cache_path(input_path, &fingerprint)?;
    let expected_samples = expected_resampled_samples(input_path, TARGET_SAMPLE_RATE)?;

    if valid_cached_wav(&cache_path, expected_samples) {
        return Ok(NoiseSuppressionOutput {
            cleanup: Some(DerivedTranscriptionInputCleanup::new(cache_path.clone())),
            path: cache_path,
            cache_hit: true,
            applied: true,
            fingerprint,
            noise_floor_dbfs: None,
        });
    }

    let profile = analyze_noise_profile(input_path)?;
    if profile.noise_floor_dbfs <= CLEAN_NOISE_FLOOR_DBFS {
        return Ok(NoiseSuppressionOutput {
            path: input_path.to_path_buf(),
            cache_hit: false,
            applied: false,
            fingerprint,
            noise_floor_dbfs: Some(profile.noise_floor_dbfs),
            cleanup: None,
        });
    }

    let parent = cache_path.parent().ok_or_else(|| {
        noise_error("Could not determine the derived transcription-input directory.")
    })?;
    std::fs::create_dir_all(parent).map_err(|error| noise_error(error.to_string()))?;
    let temporary_path = parent.join(format!(
        ".noise-suppression-{}.tmp.wav",
        uuid::Uuid::new_v4()
    ));
    let denoiser = SpectralSubtractionDenoiser::new(profile.clone());
    let write_result = write_denoised_wav(input_path, &temporary_path, Box::new(denoiser));
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(error);
    }
    if let Err(error) = crate::hermes_bridge::replace_file(&temporary_path, &cache_path) {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(noise_error(error.to_string()));
    }

    Ok(NoiseSuppressionOutput {
        cleanup: Some(DerivedTranscriptionInputCleanup::new(cache_path.clone())),
        path: cache_path,
        cache_hit: false,
        applied: true,
        fingerprint,
        noise_floor_dbfs: Some(profile.noise_floor_dbfs),
    })
}

struct SpectralSubtractionDenoiser {
    forward: Arc<dyn Fft<f32>>,
    inverse: Arc<dyn Fft<f32>>,
    spectrum: Vec<Complex<f32>>,
    noise_power: Vec<f32>,
    previous_gain: Vec<f32>,
    target_gain: Vec<f32>,
    smoothed_gain: Vec<f32>,
    window: Vec<f32>,
}

impl SpectralSubtractionDenoiser {
    fn new(profile: NoiseProfile) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        Self {
            forward: planner.plan_fft_forward(SPECTRAL_FRAME_SAMPLES),
            inverse: planner.plan_fft_inverse(SPECTRAL_FRAME_SAMPLES),
            spectrum: vec![Complex::new(0.0, 0.0); SPECTRAL_FRAME_SAMPLES],
            noise_power: profile.power,
            previous_gain: vec![1.0; SPECTRAL_BINS],
            target_gain: vec![1.0; SPECTRAL_BINS],
            smoothed_gain: vec![1.0; SPECTRAL_BINS],
            window: sine_window(SPECTRAL_FRAME_SAMPLES),
        }
    }
}

impl Denoiser for SpectralSubtractionDenoiser {
    fn sample_rate(&self) -> u32 {
        TARGET_SAMPLE_RATE
    }

    fn frame_samples(&self) -> usize {
        SPECTRAL_FRAME_SAMPLES
    }

    fn hop_samples(&self) -> usize {
        SPECTRAL_HOP_SAMPLES
    }

    fn process(&mut self, frame: &mut [f32]) -> Result<(), AppError> {
        if frame.len() != SPECTRAL_FRAME_SAMPLES {
            return Err(noise_error(format!(
                "Expected {} samples, received {}.",
                SPECTRAL_FRAME_SAMPLES,
                frame.len()
            )));
        }

        for (index, sample) in frame.iter().copied().enumerate() {
            self.spectrum[index] = Complex::new(sample * self.window[index], 0.0);
        }
        self.forward.process(&mut self.spectrum);

        for bin in 0..SPECTRAL_BINS {
            let power = self.spectrum[bin].norm_sqr();
            let noise = self.noise_power.get(bin).copied().unwrap_or(0.0);
            if noise <= f32::EPSILON || power <= f32::EPSILON {
                self.target_gain[bin] = 1.0;
                continue;
            }
            let snr_db = 10.0 * (power / noise).max(f32::EPSILON).log10();
            let residual_power =
                (power - (SPECTRAL_OVERSUBTRACTION * noise)).max(power * MIN_POWER_RATIO);
            let spectral_gain = (residual_power / power)
                .sqrt()
                .clamp(MIN_SPECTRAL_GAIN, 1.0);
            let speech_weight = (snr_db / HIGH_SNR_DB).clamp(0.0, 1.0);
            self.target_gain[bin] =
                spectral_gain + ((1.0 - spectral_gain) * speech_weight * speech_weight);
        }

        for bin in 0..SPECTRAL_BINS {
            let left = bin.saturating_sub(1);
            let right = (bin + 1).min(SPECTRAL_BINS - 1);
            let frequency_smoothed =
                (self.target_gain[left] + (2.0 * self.target_gain[bin]) + self.target_gain[right])
                    / 4.0;
            let previous = self.previous_gain[bin];
            // Reduce noise promptly, then release slowly to avoid audible
            // pumping at word endings and quiet syllables.
            let smoothing = if frequency_smoothed < previous {
                0.55
            } else {
                0.88
            };
            let gain = (smoothing * previous) + ((1.0 - smoothing) * frequency_smoothed);
            self.smoothed_gain[bin] = gain.clamp(MIN_SPECTRAL_GAIN, 1.0);
        }
        self.previous_gain.copy_from_slice(&self.smoothed_gain);

        for bin in 0..SPECTRAL_BINS {
            self.spectrum[bin] *= self.smoothed_gain[bin];
            if bin > 0 && bin < SPECTRAL_FRAME_SAMPLES / 2 {
                let mirror = SPECTRAL_FRAME_SAMPLES - bin;
                self.spectrum[mirror] *= self.smoothed_gain[bin];
            }
        }
        self.inverse.process(&mut self.spectrum);
        let inverse_scale = 1.0 / SPECTRAL_FRAME_SAMPLES as f32;
        for (index, sample) in frame.iter_mut().enumerate() {
            *sample = self.spectrum[index].re * inverse_scale * self.window[index];
        }
        Ok(())
    }
}

fn analyze_noise_profile(input_path: &Path) -> Result<NoiseProfile, AppError> {
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(SPECTRAL_FRAME_SAMPLES);
    let window = sine_window(SPECTRAL_FRAME_SAMPLES);
    let mut spectrum = vec![Complex::new(0.0, 0.0); SPECTRAL_FRAME_SAMPLES];
    let mut counts = vec![0_u64; RMS_HISTOGRAM_BINS];
    let mut power_sums = vec![vec![0.0_f64; SPECTRAL_BINS]; RMS_HISTOGRAM_BINS];
    let mut frame_count = 0_u64;

    for_each_overlapping_frame(
        input_path,
        TARGET_SAMPLE_RATE,
        SPECTRAL_FRAME_SAMPLES,
        SPECTRAL_HOP_SAMPLES,
        |frame, valid_samples| {
            let valid_samples = valid_samples.max(1);
            let rms = (frame[..valid_samples]
                .iter()
                .map(|sample| (*sample as f64).powi(2))
                .sum::<f64>()
                / valid_samples as f64)
                .sqrt() as f32;
            let dbfs = amplitude_dbfs(rms);
            let histogram_bin = dbfs_histogram_bin(dbfs);
            counts[histogram_bin] += 1;
            frame_count += 1;

            for (index, sample) in frame.iter().copied().enumerate() {
                spectrum[index] = Complex::new(sample * window[index], 0.0);
            }
            fft.process(&mut spectrum);
            for bin in 0..SPECTRAL_BINS {
                power_sums[histogram_bin][bin] += spectrum[bin].norm_sqr() as f64;
            }
            Ok(())
        },
    )?;

    if frame_count == 0 {
        return Err(noise_error(
            "The Microphone source contains no PCM samples.",
        ));
    }
    let percentile_rank = ((frame_count as f32 * NOISE_PERCENTILE).ceil() as u64).max(1);
    let mut seen = 0_u64;
    let mut percentile_bin = 0_usize;
    for (bin, count) in counts.iter().copied().enumerate() {
        seen += count;
        if seen >= percentile_rank {
            percentile_bin = bin;
            break;
        }
    }
    let margin_bins = ((NOISE_PROFILE_MARGIN_DB / histogram_bin_width()).ceil() as usize).max(1);
    let profile_max_bin = (percentile_bin + margin_bins).min(RMS_HISTOGRAM_BINS - 1);
    let profile_frame_count = counts[..=profile_max_bin].iter().sum::<u64>().max(1);
    let mut power = vec![0.0_f32; SPECTRAL_BINS];
    for (bin, output) in power.iter_mut().enumerate() {
        let total = power_sums[..=profile_max_bin]
            .iter()
            .map(|values| values[bin])
            .sum::<f64>();
        *output = (total / profile_frame_count as f64) as f32;
    }

    Ok(NoiseProfile {
        power,
        noise_floor_dbfs: histogram_bin_upper_dbfs(percentile_bin),
    })
}

fn write_denoised_wav(
    input_path: &Path,
    output_path: &Path,
    mut denoiser: Box<dyn Denoiser>,
) -> Result<(), AppError> {
    let frame_samples = denoiser.frame_samples();
    let hop_samples = denoiser.hop_samples();
    if frame_samples == 0 || hop_samples == 0 || hop_samples > frame_samples {
        return Err(noise_error("The denoiser declared an invalid frame shape."));
    }
    let output_spec = WavSpec {
        channels: 1,
        sample_rate: denoiser.sample_rate(),
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(output_path, output_spec)
        .map_err(|error| noise_error(error.to_string()))?;
    let expected_samples = expected_resampled_samples(input_path, denoiser.sample_rate())?;
    let mut overlap = vec![0.0_f32; frame_samples];
    let mut overlap_weight = vec![0.0_f32; frame_samples];
    let reconstruction_window = if hop_samples < frame_samples {
        sine_window(frame_samples)
    } else {
        vec![1.0; frame_samples]
    };
    let mut written_samples = 0_usize;

    let processing_result = for_each_overlapping_frame(
        input_path,
        denoiser.sample_rate(),
        frame_samples,
        hop_samples,
        |frame, _valid_samples| {
            denoiser.process(frame)?;
            for index in 0..frame_samples {
                overlap[index] += frame[index];
                overlap_weight[index] += reconstruction_window[index].powi(2);
            }
            let samples_to_write =
                hop_samples.min(expected_samples.saturating_sub(written_samples));
            for index in 0..samples_to_write {
                let normalized = if overlap_weight[index] > f32::EPSILON {
                    overlap[index] / overlap_weight[index]
                } else {
                    overlap[index]
                };
                writer
                    .write_sample(f32_to_i16(normalized))
                    .map_err(|error| noise_error(error.to_string()))?;
            }
            written_samples += samples_to_write;
            overlap.copy_within(hop_samples.., 0);
            overlap[(frame_samples - hop_samples)..].fill(0.0);
            overlap_weight.copy_within(hop_samples.., 0);
            overlap_weight[(frame_samples - hop_samples)..].fill(0.0);
            Ok(())
        },
    );
    if let Err(error) = processing_result {
        drop(writer);
        return Err(error);
    }
    if written_samples != expected_samples {
        drop(writer);
        return Err(noise_error(format!(
            "Noise suppression wrote {written_samples} samples; expected {expected_samples}."
        )));
    }
    writer
        .finalize()
        .map_err(|error| noise_error(error.to_string()))
}

fn for_each_overlapping_frame(
    input_path: &Path,
    output_rate: u32,
    frame_samples: usize,
    hop_samples: usize,
    mut on_frame: impl FnMut(&mut [f32], usize) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let expected_samples = expected_resampled_samples(input_path, output_rate)?;
    if expected_samples == 0 {
        return Ok(());
    }
    let mut buffer = vec![0.0_f32; frame_samples];
    let mut frame = vec![0.0_f32; frame_samples];
    let mut buffered = 0_usize;
    let mut frame_start = 0_usize;
    for_each_resampled_mono_sample(input_path, output_rate, |sample| {
        buffer[buffered] = sample;
        buffered += 1;
        if buffered == frame_samples {
            frame.copy_from_slice(&buffer);
            on_frame(&mut frame, frame_samples)?;
            buffer.copy_within(hop_samples.., 0);
            buffered = frame_samples - hop_samples;
            frame_start += hop_samples;
        }
        Ok(())
    })?;

    while frame_start < expected_samples {
        let valid_samples = expected_samples
            .saturating_sub(frame_start)
            .min(frame_samples);
        buffer[buffered..].fill(0.0);
        frame.copy_from_slice(&buffer);
        on_frame(&mut frame, valid_samples)?;
        buffer.copy_within(hop_samples.., 0);
        buffer[(frame_samples - hop_samples)..].fill(0.0);
        buffered = frame_samples - hop_samples;
        frame_start += hop_samples;
    }
    Ok(())
}

fn for_each_resampled_mono_sample(
    input_path: &Path,
    output_rate: u32,
    mut on_sample: impl FnMut(f32) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let mut reader = WavReader::open(input_path).map_err(|error| noise_error(error.to_string()))?;
    let spec = reader.spec();
    ensure_supported_pcm(spec)?;
    let channel_count = spec.channels.max(1) as usize;
    let mono_sample_count = reader.duration() as usize;
    let mut resampler = StreamingLinearResampler::new(
        mono_sample_count,
        spec.sample_rate.max(1),
        output_rate.max(1),
    );
    let mut chunk = Vec::with_capacity(PCM_CHUNK_SAMPLE_BUDGET);
    let mut frame_sum = 0_i32;
    let mut samples_in_frame = 0_usize;
    let mut samples = reader.samples::<i16>();

    loop {
        chunk.clear();
        for _ in 0..PCM_CHUNK_SAMPLE_BUDGET {
            let Some(sample) = samples.next() else {
                break;
            };
            chunk.push(sample.map_err(|error| noise_error(error.to_string()))?);
        }
        if chunk.is_empty() {
            break;
        }
        for sample in chunk.iter().copied() {
            frame_sum += sample as i32;
            samples_in_frame += 1;
            if samples_in_frame == channel_count {
                let mono = (frame_sum / samples_in_frame as i32)
                    .clamp(i16::MIN as i32, i16::MAX as i32) as i16;
                resampler.push(mono, |sample| on_sample(sample as f32 / i16::MAX as f32))?;
                frame_sum = 0;
                samples_in_frame = 0;
            }
        }
    }
    if samples_in_frame > 0 {
        let mono =
            (frame_sum / samples_in_frame as i32).clamp(i16::MIN as i32, i16::MAX as i32) as i16;
        resampler.push(mono, |sample| on_sample(sample as f32 / i16::MAX as f32))?;
    }
    resampler.ensure_complete()
}

struct StreamingLinearResampler {
    ratio: f64,
    total_input_samples: usize,
    output_len: usize,
    next_output_index: usize,
    next_input_index: usize,
    previous_sample: Option<i16>,
}

impl StreamingLinearResampler {
    fn new(total_input_samples: usize, input_rate: u32, output_rate: u32) -> Self {
        let ratio = input_rate as f64 / output_rate as f64;
        let output_len = if total_input_samples == 0 {
            0
        } else if input_rate == output_rate {
            total_input_samples
        } else {
            ((total_input_samples as f64) / ratio).ceil().max(1.0) as usize
        };
        Self {
            ratio,
            total_input_samples,
            output_len,
            next_output_index: 0,
            next_input_index: 0,
            previous_sample: None,
        }
    }

    fn push(
        &mut self,
        sample: i16,
        mut on_sample: impl FnMut(i16) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let current_input_index = self.next_input_index;
        while self.next_output_index < self.output_len {
            let source_pos = self.next_output_index as f64 * self.ratio;
            let left_index = source_pos.floor() as usize;
            let right_index = (left_index + 1).min(self.total_input_samples - 1);
            if right_index > current_input_index {
                break;
            }
            let left = self.sample_at(left_index, current_input_index, sample)? as f64;
            let right = self.sample_at(right_index, current_input_index, sample)? as f64;
            let fraction = source_pos - left_index as f64;
            let resampled = (left + ((right - left) * fraction))
                .round()
                .clamp(i16::MIN as f64, i16::MAX as f64) as i16;
            on_sample(resampled)?;
            self.next_output_index += 1;
        }
        self.previous_sample = Some(sample);
        self.next_input_index += 1;
        Ok(())
    }

    fn sample_at(
        &self,
        requested_index: usize,
        current_input_index: usize,
        current_sample: i16,
    ) -> Result<i16, AppError> {
        if requested_index == current_input_index {
            return Ok(current_sample);
        }
        if requested_index + 1 == current_input_index {
            return self
                .previous_sample
                .ok_or_else(|| noise_error("The resampler lost its previous sample."));
        }
        Err(noise_error(
            "The resampler advanced past a required sample.",
        ))
    }

    fn ensure_complete(&self) -> Result<(), AppError> {
        if self.next_input_index == self.total_input_samples
            && self.next_output_index == self.output_len
        {
            return Ok(());
        }
        Err(noise_error(
            "The resampler did not consume the expected sample counts.",
        ))
    }
}

fn expected_resampled_samples(input_path: &Path, output_rate: u32) -> Result<usize, AppError> {
    let reader = WavReader::open(input_path).map_err(|error| noise_error(error.to_string()))?;
    let spec = reader.spec();
    ensure_supported_pcm(spec)?;
    let input_samples = reader.duration() as usize;
    if input_samples == 0 {
        return Ok(0);
    }
    if spec.sample_rate == output_rate {
        return Ok(input_samples);
    }
    Ok(
        ((input_samples as f64 * output_rate as f64) / spec.sample_rate.max(1) as f64)
            .ceil()
            .max(1.0) as usize,
    )
}

fn ensure_supported_pcm(spec: WavSpec) -> Result<(), AppError> {
    if spec.sample_format == SampleFormat::Int
        && spec.bits_per_sample == 16
        && spec.channels > 0
        && spec.sample_rate > 0
    {
        return Ok(());
    }
    Err(noise_error(
        "Only 16-bit PCM WAV noise suppression is supported.",
    ))
}

fn valid_cached_wav(path: &Path, expected_samples: usize) -> bool {
    let Ok(reader) = WavReader::open(path) else {
        return false;
    };
    let spec = reader.spec();
    spec.sample_format == SampleFormat::Int
        && spec.bits_per_sample == 16
        && spec.channels == 1
        && spec.sample_rate == TARGET_SAMPLE_RATE
        && reader.duration() as usize == expected_samples
}

fn sha256_file(path: &Path) -> Result<String, AppError> {
    let file = File::open(path).map_err(|error| noise_error(error.to_string()))?;
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| noise_error(error.to_string()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn derived_fingerprint(input_sha256: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(CACHE_FINGERPRINT_DOMAIN);
    digest.update((SPECTRAL_DENOISER_ID.len() as u64).to_be_bytes());
    digest.update(SPECTRAL_DENOISER_ID.as_bytes());
    digest.update((input_sha256.len() as u64).to_be_bytes());
    digest.update(input_sha256.as_bytes());
    format!("{:x}", digest.finalize())
}

fn derived_cache_path(input_path: &Path, fingerprint: &str) -> Result<PathBuf, AppError> {
    let parent = input_path
        .parent()
        .ok_or_else(|| noise_error("Could not determine the Microphone source directory."))?;
    let stem = input_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("microphone");
    Ok(parent.join(CACHE_DIRECTORY).join(format!(
        "{stem}-{SPECTRAL_DENOISER_ID}-{}.wav",
        &fingerprint[..16]
    )))
}

fn sine_window(len: usize) -> Vec<f32> {
    (0..len)
        .map(|index| (std::f32::consts::PI * (index as f32 + 0.5) / len as f32).sin())
        .collect()
}

fn amplitude_dbfs(amplitude: f32) -> f32 {
    20.0 * amplitude.max(10.0_f32.powf(MIN_DBFS / 20.0)).log10()
}

fn histogram_bin_width() -> f32 {
    (MAX_DBFS - MIN_DBFS) / RMS_HISTOGRAM_BINS as f32
}

fn dbfs_histogram_bin(dbfs: f32) -> usize {
    (((dbfs.clamp(MIN_DBFS, MAX_DBFS) - MIN_DBFS) / histogram_bin_width()).floor() as usize)
        .min(RMS_HISTOGRAM_BINS - 1)
}

fn histogram_bin_upper_dbfs(bin: usize) -> f32 {
    (MIN_DBFS + ((bin + 1) as f32 * histogram_bin_width())).min(MAX_DBFS)
}

fn f32_to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32)
        .round()
        .clamp(i16::MIN as f32, i16::MAX as f32) as i16
}

fn noise_error(message: impl Into<String>) -> AppError {
    AppError::new("microphone_noise_suppression_failed", message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[test]
    fn spectral_suppression_preserves_archive_and_reuses_cached_derivative() {
        let dir = test_dir("cache");
        let input = dir.join("microphone.wav");
        write_stationary_noise_fixture(&input, 4.0, true);
        let original = std::fs::read(&input).unwrap();

        let first = suppress_microphone_wav_for_transcription(&input).unwrap();
        assert!(first.applied);
        assert!(!first.cache_hit);
        assert_ne!(first.path, input);
        assert_eq!(std::fs::read(&input).unwrap(), original);

        let second = suppress_microphone_wav_for_transcription(&input).unwrap();
        assert!(second.applied);
        assert!(second.cache_hit);
        assert_eq!(second.path, first.path);
        assert_eq!(
            std::fs::read(&second.path).unwrap(),
            std::fs::read(&first.path).unwrap()
        );
        assert_eq!(std::fs::read(&input).unwrap(), original);
        let derived = first.path.clone();
        drop(second);
        drop(first);
        assert!(!derived.exists());
        assert!(!dir.join(CACHE_DIRECTORY).exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn clean_digital_speech_bypasses_spectral_processing() {
        let dir = test_dir("clean");
        let input = dir.join("microphone.wav");
        write_clean_speech_fixture(&input, 3.0);

        let output = suppress_microphone_wav_for_transcription(&input).unwrap();

        assert!(!output.applied);
        assert!(!output.cache_hit);
        assert_eq!(output.path, input);
        assert!(output
            .noise_floor_dbfs
            .is_some_and(|floor| floor <= CLEAN_NOISE_FLOOR_DBFS));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn failing_denoiser_leaves_no_complete_derived_wav() {
        struct FailingDenoiser {
            calls: Arc<AtomicUsize>,
        }
        impl Denoiser for FailingDenoiser {
            fn sample_rate(&self) -> u32 {
                TARGET_SAMPLE_RATE
            }

            fn frame_samples(&self) -> usize {
                480
            }

            fn hop_samples(&self) -> usize {
                480
            }

            fn process(&mut self, _frame: &mut [f32]) -> Result<(), AppError> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                Err(noise_error("injected denoiser failure"))
            }
        }

        let dir = test_dir("failure");
        let input = dir.join("microphone.wav");
        let output = dir.join("derived.wav");
        write_stationary_noise_fixture(&input, 1.0, true);
        let original = std::fs::read(&input).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));

        let error = write_denoised_wav(
            &input,
            &output,
            Box::new(FailingDenoiser {
                calls: Arc::clone(&calls),
            }),
        )
        .unwrap_err();

        assert_eq!(error.code, "microphone_noise_suppression_failed");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(std::fs::read(input).unwrap(), original);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn spectral_fallback_improves_stationary_noise_snr() {
        let dir = test_dir("snr");
        let clean_path = dir.join("clean.wav");
        let noisy_path = dir.join("noisy.wav");
        write_clean_speech_fixture(&clean_path, 4.0);
        write_stationary_noise_fixture(&noisy_path, 4.0, true);

        let output = suppress_microphone_wav_for_transcription(&noisy_path).unwrap();
        assert!(output.applied);
        let clean = read_samples(&clean_path);
        let noisy = read_samples(&noisy_path);
        let denoised = read_samples(&output.path);
        let before = reference_snr_db(&clean, &noisy);
        let after = reference_snr_db(&clean, &denoised);

        assert!(
            after > before + 2.0,
            "expected a measurable stationary-noise improvement; before={before:.2} dB after={after:.2} dB"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn spectral_suppression_resamples_48khz_input_to_expected_length() {
        let dir = test_dir("resample-48khz");
        let input = dir.join("microphone.wav");
        let seconds = 2.25;
        write_fixture_at_sample_rate(&input, seconds, true, 48_000);
        let original = std::fs::read(&input).unwrap();

        let output = suppress_microphone_wav_for_transcription(&input).unwrap();

        assert!(output.applied);
        let reader = WavReader::open(&output.path).unwrap();
        assert_eq!(reader.spec().sample_rate, TARGET_SAMPLE_RATE);
        assert_eq!(
            reader.duration() as usize,
            (seconds * TARGET_SAMPLE_RATE as f32) as usize
        );
        assert_eq!(std::fs::read(&input).unwrap(), original);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn test_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "os-june-noise-suppression-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_clean_speech_fixture(path: &Path, seconds: f32) {
        write_fixture(path, seconds, false);
    }

    fn write_stationary_noise_fixture(path: &Path, seconds: f32, include_noise: bool) {
        write_fixture(path, seconds, include_noise);
    }

    fn write_fixture(path: &Path, seconds: f32, include_noise: bool) {
        write_fixture_at_sample_rate(path, seconds, include_noise, TARGET_SAMPLE_RATE);
    }

    fn write_fixture_at_sample_rate(
        path: &Path,
        seconds: f32,
        include_noise: bool,
        sample_rate: u32,
    ) {
        let spec = WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let sample_count = (seconds * sample_rate as f32) as usize;
        let mut writer = WavWriter::create(path, spec).unwrap();
        let mut random_state = 0x1234_5678_u32;
        for index in 0..sample_count {
            let time = index as f32 / sample_rate as f32;
            let speech_active = (time % 2.0) >= 0.55;
            let envelope = if speech_active {
                let phase = (time % 2.0) - 0.55;
                (phase / 0.08).clamp(0.0, 1.0) * ((1.45 - phase) / 0.12).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let clean = envelope
                * ((2.0 * std::f32::consts::PI * 180.0 * time).sin() * 0.18
                    + (2.0 * std::f32::consts::PI * 360.0 * time).sin() * 0.09
                    + (2.0 * std::f32::consts::PI * 720.0 * time).sin() * 0.04);
            random_state = random_state
                .wrapping_mul(1_664_525)
                .wrapping_add(1_013_904_223);
            let white = ((random_state >> 8) as f32 / 0x00ff_ffff as f32) * 2.0 - 1.0;
            let noise = if include_noise {
                (2.0 * std::f32::consts::PI * 95.0 * time).sin() * 0.035
                    + (2.0 * std::f32::consts::PI * 190.0 * time).sin() * 0.018
                    + white * 0.012
            } else {
                0.0
            };
            writer.write_sample(f32_to_i16(clean + noise)).unwrap();
        }
        writer.finalize().unwrap();
    }

    fn read_samples(path: &Path) -> Vec<f32> {
        WavReader::open(path)
            .unwrap()
            .samples::<i16>()
            .map(|sample| sample.unwrap() as f32 / i16::MAX as f32)
            .collect()
    }

    fn reference_snr_db(reference: &[f32], candidate: &[f32]) -> f32 {
        let len = reference.len().min(candidate.len());
        let signal = reference[..len]
            .iter()
            .map(|sample| (*sample as f64).powi(2))
            .sum::<f64>();
        let error = reference[..len]
            .iter()
            .zip(&candidate[..len])
            .map(|(reference, candidate)| (*candidate as f64 - *reference as f64).powi(2))
            .sum::<f64>()
            .max(f64::EPSILON);
        (10.0 * (signal / error).log10()) as f32
    }
}
