//! Signal-level evidence for speaker-bleed (echo) rejection.
//!
//! Energy ratios alone cannot separate echo from genuine double-talk: a fixed
//! dominance threshold encodes an assumed echo-path attenuation that is in
//! reality unknown and time-varying (quiet speakers under-trim, loud genuine
//! double-talk over-trims). This module supplies content evidence instead:
//!
//! - [`gcc_phat_delay`] estimates the echo-path delay between the system
//!   source (the digital reference) and the microphone capture with the
//!   GCC-PHAT cross-correlation, whose phase whitening keeps the peak sharp
//!   under speaker coloration and room reverb.
//! - [`windowed_ncc_frames`] scores short frames of an aligned span pair by
//!   normalized cross-correlation: bleed correlates with the reference
//!   regardless of level, genuine microphone speech does not.
//!
//! Everything here is mechanism; the trim policy (thresholds, smoothing,
//! fallbacks) lives with the turn-attribution code in `turns.rs`.

use std::path::Path;

use hound::{SampleFormat, WavReader};
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;

/// Common analysis rate for similarity evidence; matches the transcription
/// rate so both sources land on one timebase regardless of capture specs.
pub const SIMILARITY_SAMPLE_RATE: u32 = 16_000;
/// Frame length for per-frame similarity scoring. Long enough for a stable
/// correlation estimate, short enough to resolve echo/speech boundaries.
pub const SIMILARITY_FRAME_MS: i64 = 30;
/// Frame hop (50% overlap) for per-frame similarity scoring.
pub const SIMILARITY_HOP_MS: i64 = 15;
/// Upper bound on the echo-path delay searched by GCC-PHAT: playback buffer +
/// DAC + air path + ADC + capture buffer. Real devices sit in 20-200 ms.
pub const ECHO_MAX_LAG_MS: i64 = 500;
/// Microphone frame RMS below which a frame carries nothing to attribute and
/// is skipped by similarity scoring. Well below the microphone detector's
/// activity floor (0.012) so quiet-but-real bleed still gets scored.
const SILENT_FRAME_RMS: f32 = 0.004;
/// Block FFT size for the offline adaptive canceller. With overlap-save the
/// modeled echo path is half this length: 2,048 taps, or 128 ms at 16 kHz,
/// enough to absorb the early room tail after the bulk lag is aligned out.
pub const AEC_FFT_SIZE: usize = 4_096;
/// NLMS adaptation rate for the offline canceller. We can afford two passes
/// over saved audio, so this stays conservative enough for stability while
/// still converging within short meeting-open echo bursts.
pub const AEC_STEP_SIZE: f32 = 0.5;
const AEC_BLOCK_SIZE: usize = AEC_FFT_SIZE / 2;
const AEC_PSD_SMOOTHING: f32 = 0.98;
const AEC_PSD_INJECTION: f32 = 1.0 - AEC_PSD_SMOOTHING;
const AEC_EPSILON: f32 = 1.0e-6;

/// One scored frame of an aligned microphone/system span pair.
pub struct SimilarityFrame {
    /// Frame start offset from the span start, in samples at
    /// [`SIMILARITY_SAMPLE_RATE`].
    pub start_sample: usize,
    /// |normalized cross-correlation| in [0, 1], or `None` when the
    /// microphone frame is effectively silent.
    pub ncc: Option<f32>,
    /// Microphone frame RMS (for level-based fallback decisions).
    pub capture_rms: f32,
    /// System-reference frame RMS (for level-based fallback decisions).
    pub reference_rms: f32,
}

/// A GCC-PHAT delay estimate with its peak sharpness.
pub struct DelayEstimate {
    /// Delay of the capture relative to the reference, in samples at
    /// [`SIMILARITY_SAMPLE_RATE`].
    pub delay_samples: usize,
    /// Peak magnitude over the mean magnitude across the search range. A
    /// sharp single peak (echo present, little competing speech) scores
    /// high; double-talk, periodic content, or absent echo scores low.
    pub confidence: f32,
}

/// Frequency-domain adaptive filter for offline speaker-bleed cancellation.
///
/// It models the post-lag echo path rather than a single delay, so reverb
/// energy smeared over tens of milliseconds can still collapse while
/// reference-orthogonal microphone speech remains in the residual.
pub struct FdafCanceller {
    reference_buffer: Vec<f32>,
    weights: Vec<Complex<f32>>,
    psd: Vec<f32>,
    forward: std::sync::Arc<dyn rustfft::Fft<f32>>,
    inverse: std::sync::Arc<dyn rustfft::Fft<f32>>,
}

impl FdafCanceller {
    pub fn new() -> Self {
        let mut planner = FftPlanner::<f32>::new();
        Self {
            reference_buffer: vec![0.0; AEC_FFT_SIZE],
            weights: vec![Complex::new(0.0, 0.0); AEC_FFT_SIZE],
            psd: vec![1.0; AEC_FFT_SIZE],
            forward: planner.plan_fft_forward(AEC_FFT_SIZE),
            inverse: planner.plan_fft_inverse(AEC_FFT_SIZE),
        }
    }

    /// Process one half-overlapped block and return the residual capture
    /// frame. Both inputs must be exactly `AEC_FFT_SIZE / 2` samples; callers
    /// that stream a file should zero-pad the final block.
    pub fn process(&mut self, reference_frame: &[f32], capture_frame: &[f32]) -> Vec<f32> {
        debug_assert_eq!(reference_frame.len(), AEC_BLOCK_SIZE);
        debug_assert_eq!(capture_frame.len(), AEC_BLOCK_SIZE);

        self.reference_buffer.copy_within(AEC_BLOCK_SIZE.., 0);
        self.reference_buffer[AEC_BLOCK_SIZE..].copy_from_slice(reference_frame);

        let mut x = to_complex(&self.reference_buffer, AEC_FFT_SIZE);
        self.forward.process(&mut x);

        let mut y_freq: Vec<Complex<f32>> = self
            .weights
            .iter()
            .zip(x.iter())
            .map(|(weight, bin)| weight * bin)
            .collect();
        self.inverse.process(&mut y_freq);
        let scale = AEC_FFT_SIZE as f32;
        let residual: Vec<f32> = capture_frame
            .iter()
            .zip(y_freq[AEC_BLOCK_SIZE..].iter())
            .map(|(capture, estimate)| capture - (estimate.re / scale))
            .collect();

        let mut error = vec![Complex::new(0.0, 0.0); AEC_BLOCK_SIZE];
        error.extend(residual.iter().map(|sample| Complex::new(*sample, 0.0)));
        self.forward.process(&mut error);

        for ((weight, psd), (x_bin, error_bin)) in self
            .weights
            .iter_mut()
            .zip(self.psd.iter_mut())
            .zip(x.iter().zip(error.iter()))
        {
            *psd = (AEC_PSD_SMOOTHING * *psd) + (AEC_PSD_INJECTION * x_bin.norm_sqr());
            *weight += (x_bin.conj() * *error_bin) * (AEC_STEP_SIZE / (*psd + AEC_EPSILON));
        }

        // Constrain the gradient to the causal half of the block. This keeps
        // circular convolution artifacts from becoming learned echo paths.
        let mut impulse = self.weights.clone();
        self.inverse.process(&mut impulse);
        for bin in &mut impulse {
            *bin /= scale;
        }
        impulse[AEC_BLOCK_SIZE..].fill(Complex::new(0.0, 0.0));
        self.forward.process(&mut impulse);
        self.weights = impulse;

        residual
    }

    fn reset_stream_history(&mut self) {
        self.reference_buffer.fill(0.0);
    }
}

impl Default for FdafCanceller {
    fn default() -> Self {
        Self::new()
    }
}

/// Estimate how many samples `capture` lags behind `reference` using the
/// generalized cross-correlation with phase transform (GCC-PHAT). Returns
/// `None` when either signal is too short or effectively silent.
pub fn gcc_phat_delay(
    reference: &[f32],
    capture: &[f32],
    max_delay_samples: usize,
) -> Option<DelayEstimate> {
    if reference.is_empty() || capture.len() < reference.len() || max_delay_samples == 0 {
        return None;
    }
    if rms(reference) < SILENT_FRAME_RMS || rms(capture) < SILENT_FRAME_RMS {
        return None;
    }
    let n = (capture.len() + reference.len()).next_power_of_two();
    let mut planner = FftPlanner::<f32>::new();
    let forward = planner.plan_fft_forward(n);
    let inverse = planner.plan_fft_inverse(n);

    let mut reference_bins = to_complex(reference, n);
    let mut capture_bins = to_complex(capture, n);
    forward.process(&mut reference_bins);
    forward.process(&mut capture_bins);

    // Cross-power spectrum of capture against reference, whitened to phase
    // only (PHAT): the correlation peak location survives speaker EQ and
    // level differences because magnitude is discarded.
    let mut cross: Vec<Complex<f32>> = capture_bins
        .iter()
        .zip(reference_bins.iter())
        .map(|(capture_bin, reference_bin)| {
            let bin = capture_bin * reference_bin.conj();
            let magnitude = bin.norm();
            if magnitude > f32::EPSILON {
                bin / magnitude
            } else {
                Complex::new(0.0, 0.0)
            }
        })
        .collect();
    inverse.process(&mut cross);

    let search = &cross[..max_delay_samples.min(n)];
    let (delay_samples, peak) = search
        .iter()
        .enumerate()
        .map(|(delay, bin)| (delay, bin.re.abs()))
        .max_by(|left, right| left.1.total_cmp(&right.1))?;
    let mean = search.iter().map(|bin| bin.re.abs()).sum::<f32>() / search.len() as f32;
    if mean <= f32::EPSILON {
        return None;
    }
    Some(DelayEstimate {
        delay_samples,
        confidence: peak / mean,
    })
}

/// Score an aligned microphone/system span pair frame by frame. `capture` and
/// `reference` must already be lag-aligned and equally long; scoring stops at
/// the shorter of the two.
pub fn windowed_ncc_frames(capture: &[f32], reference: &[f32]) -> Vec<SimilarityFrame> {
    let frame_len = (SIMILARITY_FRAME_MS * SIMILARITY_SAMPLE_RATE as i64 / 1000) as usize;
    let hop = (SIMILARITY_HOP_MS * SIMILARITY_SAMPLE_RATE as i64 / 1000) as usize;
    let usable = capture.len().min(reference.len());
    if usable < frame_len {
        return Vec::new();
    }
    let mut frames = Vec::new();
    let mut start = 0_usize;
    while start + frame_len <= usable {
        let capture_frame = &capture[start..start + frame_len];
        let reference_frame = &reference[start..start + frame_len];
        let capture_energy: f32 = capture_frame.iter().map(|sample| sample * sample).sum();
        let reference_energy: f32 = reference_frame.iter().map(|sample| sample * sample).sum();
        let capture_rms = (capture_energy / frame_len as f32).sqrt();
        let reference_rms = (reference_energy / frame_len as f32).sqrt();
        let ncc = if capture_rms < SILENT_FRAME_RMS {
            None
        } else if reference_energy <= f32::EPSILON {
            Some(0.0)
        } else {
            let dot: f32 = capture_frame
                .iter()
                .zip(reference_frame.iter())
                .map(|(capture_sample, reference_sample)| capture_sample * reference_sample)
                .sum();
            Some((dot.abs() / (capture_energy * reference_energy).sqrt()).min(1.0))
        };
        frames.push(SimilarityFrame {
            start_sample: start,
            ncc,
            capture_rms,
            reference_rms,
        });
        start += hop;
    }
    frames
}

/// Read `[start_ms, end_ms)` of a 16-bit PCM WAV as mono f32 at
/// [`SIMILARITY_SAMPLE_RATE`]. A negative `start_ms` or a range past the end
/// of the file is zero-padded so the result always covers the requested span
/// at the requested alignment. Returns `None` for unreadable or non-16-bit
/// files (the caller falls back to level-based evidence).
pub fn read_span_mono_16k(path: &Path, start_ms: i64, end_ms: i64) -> Option<Vec<f32>> {
    if end_ms <= start_ms {
        return None;
    }
    let mut reader = WavReader::open(path).ok()?;
    let spec = reader.spec();
    if spec.sample_format != SampleFormat::Int || spec.bits_per_sample != 16 {
        return None;
    }
    let channels = spec.channels.max(1) as usize;
    let sample_rate = spec.sample_rate.max(1) as i64;
    let read_start_ms = start_ms.max(0);
    let start_frame = (read_start_ms * sample_rate) / 1000;
    let want_frames = (((end_ms - read_start_ms) * sample_rate) / 1000).max(0) as usize;
    let total_frames = reader.duration() as i64;
    let mut mono = Vec::new();
    if start_frame < total_frames && want_frames > 0 {
        reader.seek(u32::try_from(start_frame).ok()?).ok()?;
        let mut frame_sum = 0.0_f32;
        let mut channel_index = 0_usize;
        for sample in reader.samples::<i16>().take(want_frames * channels) {
            frame_sum += sample.unwrap_or(0) as f32 / i16::MAX as f32;
            channel_index += 1;
            if channel_index == channels {
                mono.push(frame_sum / channels as f32);
                frame_sum = 0.0;
                channel_index = 0;
            }
        }
    }
    let mut resampled = resample_linear_f32(&mono, spec.sample_rate, SIMILARITY_SAMPLE_RATE);
    // Zero-pad a negative start (lag reaching before the recording) at the
    // front and a short read at the back so alignment with the caller's
    // wall-clock span is preserved.
    let lead_samples =
        ((read_start_ms - start_ms) * SIMILARITY_SAMPLE_RATE as i64 / 1000).max(0) as usize;
    let target_len = ((end_ms - start_ms) * SIMILARITY_SAMPLE_RATE as i64 / 1000).max(0) as usize;
    let mut span = Vec::with_capacity(target_len);
    span.resize(lead_samples.min(target_len), 0.0);
    span.extend(
        resampled
            .drain(..)
            .take(target_len - span.len().min(target_len)),
    );
    span.resize(target_len, 0.0);
    Some(span)
}

/// Offline residual energy after learning the room echo path from the saved
/// sources. The first pass learns from the whole recording and the second pass
/// replays from t=0, so early bleed can be judged without an adaptive warm-up
/// blind spot.
pub fn residual_rms_windows(mic_path: &Path, system_path: &Path, lag_ms: i64) -> Option<Vec<f32>> {
    let mic_duration_ms = wav_duration_ms(mic_path)?;
    let mut canceller = FdafCanceller::new();
    stream_cancellation_pass(
        &mut canceller,
        mic_path,
        system_path,
        lag_ms,
        mic_duration_ms,
        None,
    )?;
    canceller.reset_stream_history();

    let mut collector = RmsWindowCollector::new();
    stream_cancellation_pass(
        &mut canceller,
        mic_path,
        system_path,
        lag_ms,
        mic_duration_ms,
        Some(&mut collector),
    )?;
    Some(collector.finish())
}

fn stream_cancellation_pass(
    canceller: &mut FdafCanceller,
    mic_path: &Path,
    system_path: &Path,
    lag_ms: i64,
    mic_duration_ms: i64,
    mut collector: Option<&mut RmsWindowCollector>,
) -> Option<()> {
    let block_ms = (AEC_BLOCK_SIZE as i64 * 1000) / SIMILARITY_SAMPLE_RATE as i64;
    let mut start_ms = 0_i64;
    while start_ms < mic_duration_ms {
        let end_ms = start_ms + block_ms;
        let mut capture = read_span_mono_16k(mic_path, start_ms, end_ms)?;
        let mut reference = read_span_mono_16k(system_path, start_ms - lag_ms, end_ms - lag_ms)?;
        capture.resize(AEC_BLOCK_SIZE, 0.0);
        reference.resize(AEC_BLOCK_SIZE, 0.0);
        let residual = canceller.process(&reference, &capture);
        if let Some(collector) = collector.as_deref_mut() {
            let valid_samples = (((mic_duration_ms - start_ms).min(block_ms))
                * SIMILARITY_SAMPLE_RATE as i64
                / 1000) as usize;
            collector.push(&residual[..valid_samples.min(residual.len())]);
        }
        start_ms += block_ms;
    }
    Some(())
}

fn wav_duration_ms(path: &Path) -> Option<i64> {
    let reader = WavReader::open(path).ok()?;
    let spec = reader.spec();
    if spec.sample_format != SampleFormat::Int || spec.bits_per_sample != 16 {
        return None;
    }
    let sample_rate = spec.sample_rate.max(1) as i64;
    Some((reader.duration() as i64 * 1000) / sample_rate)
}

struct RmsWindowCollector {
    frames_per_window: usize,
    sum_square: f64,
    frames: usize,
    windows: Vec<f32>,
}

impl RmsWindowCollector {
    fn new() -> Self {
        Self {
            frames_per_window: (SIMILARITY_SAMPLE_RATE as i64 * SIMILARITY_FRAME_MS / 1000)
                as usize,
            sum_square: 0.0,
            frames: 0,
            windows: Vec::new(),
        }
    }

    fn push(&mut self, samples: &[f32]) {
        for sample in samples {
            self.sum_square += (*sample as f64).powi(2);
            self.frames += 1;
            if self.frames == self.frames_per_window {
                self.windows
                    .push((self.sum_square / self.frames as f64).sqrt() as f32);
                self.sum_square = 0.0;
                self.frames = 0;
            }
        }
    }

    fn finish(mut self) -> Vec<f32> {
        if self.frames > 0 {
            self.windows
                .push((self.sum_square / self.frames as f64).sqrt() as f32);
        }
        self.windows
    }
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
}

fn to_complex(samples: &[f32], n: usize) -> Vec<Complex<f32>> {
    let mut bins = Vec::with_capacity(n);
    bins.extend(samples.iter().map(|sample| Complex::new(*sample, 0.0)));
    bins.resize(n, Complex::new(0.0, 0.0));
    bins
}

fn resample_linear_f32(samples: &[f32], input_rate: u32, output_rate: u32) -> Vec<f32> {
    if samples.is_empty() || input_rate == output_rate {
        return samples.to_vec();
    }
    let ratio = input_rate as f64 / output_rate as f64;
    let output_len = ((samples.len() as f64) / ratio).ceil().max(1.0) as usize;
    let mut output = Vec::with_capacity(output_len);
    for index in 0..output_len {
        let source_pos = index as f64 * ratio;
        let left_index = (source_pos.floor() as usize).min(samples.len() - 1);
        let right_index = (left_index + 1).min(samples.len() - 1);
        let fraction = (source_pos - left_index as f64) as f32;
        output.push(samples[left_index] + (samples[right_index] - samples[left_index]) * fraction);
    }
    output
}

/// Deterministic test signals shared by the echo and turn-attribution suites.
#[cfg(test)]
pub(crate) mod test_signals {
    /// Deterministic uniform noise in [-1, 1]. SplitMix64 rather than a bare
    /// LCG: different seeds of one LCG share an orbit and correlate strongly
    /// over short frames, which would fake echo where none exists.
    pub(crate) fn splitmix_noise(seed: u64, len: usize) -> Vec<f32> {
        let mut state = seed;
        (0..len)
            .map(|_| {
                state = state.wrapping_add(0x9E3779B97F4A7C15);
                let mut mixed = state;
                mixed = (mixed ^ (mixed >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
                mixed = (mixed ^ (mixed >> 27)).wrapping_mul(0x94D049BB133111EB);
                mixed ^= mixed >> 31;
                ((mixed >> 11) as f64 / (1u64 << 52) as f64 - 1.0) as f32
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::test_signals::splitmix_noise;
    use super::*;

    fn delayed_scaled(signal: &[f32], delay: usize, gain: f32) -> Vec<f32> {
        let mut out = vec![0.0; delay];
        out.extend(signal.iter().map(|sample| sample * gain));
        out
    }

    fn two_pass_residual(reference: &[f32], capture: &[f32]) -> Vec<f32> {
        let len = reference.len().max(capture.len());
        let mut canceller = FdafCanceller::new();
        for start in (0..len).step_by(AEC_BLOCK_SIZE) {
            let reference_frame = padded_frame(reference, start);
            let capture_frame = padded_frame(capture, start);
            let _ = canceller.process(&reference_frame, &capture_frame);
        }
        canceller.reset_stream_history();

        let mut residual = Vec::with_capacity(len);
        for start in (0..len).step_by(AEC_BLOCK_SIZE) {
            let reference_frame = padded_frame(reference, start);
            let capture_frame = padded_frame(capture, start);
            residual.extend(canceller.process(&reference_frame, &capture_frame));
        }
        residual.truncate(len);
        residual
    }

    fn padded_frame(samples: &[f32], start: usize) -> Vec<f32> {
        let mut frame = vec![0.0; AEC_BLOCK_SIZE];
        if start < samples.len() {
            let available = (samples.len() - start).min(AEC_BLOCK_SIZE);
            frame[..available].copy_from_slice(&samples[start..start + available]);
        }
        frame
    }

    fn tapped_echo(reference: &[f32], taps: &[(usize, f32)]) -> Vec<f32> {
        let mut capture = vec![0.0; reference.len()];
        for (delay, gain) in taps {
            for (index, sample) in reference.iter().enumerate() {
                if let Some(output) = capture.get_mut(index + delay) {
                    *output += sample * gain;
                }
            }
        }
        capture
    }

    fn energy_loss_db(capture: &[f32], residual: &[f32], start: usize) -> f32 {
        20.0 * (rms(&capture[start..]) / rms(&residual[start..]).max(1.0e-9)).log10()
    }

    fn rms_delta_db(left: &[f32], right: &[f32], start: usize) -> f32 {
        (20.0 * (rms(&left[start..]) / rms(&right[start..]).max(1.0e-9)).log10()).abs()
    }

    #[test]
    fn gcc_phat_recovers_known_echo_delay() {
        let reference = splitmix_noise(7, 16_000); // 1s at 16 kHz
        let delay = 1_280; // 80 ms
        let capture = delayed_scaled(&reference, delay, 0.1);

        let estimate = gcc_phat_delay(&reference, &capture, 8_000).unwrap();
        assert_eq!(estimate.delay_samples, delay);
        assert!(
            estimate.confidence > 10.0,
            "clean echo should give a sharp peak, got {}",
            estimate.confidence
        );
    }

    #[test]
    fn gcc_phat_rejects_unrelated_signals() {
        let reference = splitmix_noise(7, 16_000);
        let mut capture = splitmix_noise(1_234, 16_000);
        capture.extend(std::iter::repeat(0.0).take(8_000));

        // Independent noise has no true delay: whatever peak wins must be
        // far less dominant than a genuine echo's.
        let estimate = gcc_phat_delay(&reference, &capture, 8_000).unwrap();
        assert!(
            estimate.confidence < 8.0,
            "unrelated signals should not produce a sharp peak, got {}",
            estimate.confidence
        );
    }

    #[test]
    fn windowed_ncc_separates_echo_from_independent_speech() {
        let reference = splitmix_noise(7, 16_000);
        let echo: Vec<f32> = reference.iter().map(|sample| sample * 0.05).collect();
        let independent = splitmix_noise(99, 16_000);

        let echo_frames = windowed_ncc_frames(&echo, &reference);
        assert!(!echo_frames.is_empty());
        assert!(echo_frames
            .iter()
            .all(|frame| frame.ncc.unwrap_or(0.0) > 0.9));

        let genuine_frames = windowed_ncc_frames(&independent, &reference);
        assert!(genuine_frames
            .iter()
            .all(|frame| frame.ncc.unwrap_or(1.0) < 0.3));
    }

    #[test]
    fn windowed_ncc_skips_silent_capture_frames() {
        let reference = splitmix_noise(7, 16_000);
        let silent = vec![0.0_f32; 16_000];
        let frames = windowed_ncc_frames(&silent, &reference);
        assert!(frames.iter().all(|frame| frame.ncc.is_none()));
    }

    #[test]
    fn fdaf_cancels_scaled_delayed_copy() {
        let reference = splitmix_noise(7, 8 * SIMILARITY_SAMPLE_RATE as usize);
        let capture = tapped_echo(&reference, &[(640, 0.45)]);

        let residual = two_pass_residual(&reference, &capture);
        let tail_start = capture.len() / 2;
        let loss_db = energy_loss_db(&capture, &residual, tail_start);

        assert!(
            loss_db >= 15.0,
            "expected at least 15 dB cancellation, got {loss_db:.2} dB"
        );
    }

    #[test]
    fn fdaf_preserves_independent_noise() {
        let reference = splitmix_noise(7, 8 * SIMILARITY_SAMPLE_RATE as usize);
        let capture = splitmix_noise(99, reference.len());

        let residual = two_pass_residual(&reference, &capture);
        let tail_start = capture.len() / 2;
        let delta_db = rms_delta_db(&capture, &residual, tail_start);

        assert!(
            delta_db <= 1.0,
            "independent speech should survive cancellation, got {delta_db:.2} dB change"
        );
    }

    #[test]
    fn fdaf_cancels_multi_tap_reverberant_echo() {
        let reference = splitmix_noise(7, 8 * SIMILARITY_SAMPLE_RATE as usize);
        let capture = tapped_echo(
            &reference,
            &[(0, 0.22), (480, 0.20), (960, 0.18), (1_440, 0.16)],
        );

        let residual = two_pass_residual(&reference, &capture);
        let tail_start = capture.len() / 2;
        let loss_db = energy_loss_db(&capture, &residual, tail_start);

        assert!(
            loss_db >= 10.0,
            "expected at least 10 dB cancellation, got {loss_db:.2} dB"
        );
    }
}
