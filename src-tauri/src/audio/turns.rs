use crate::domain::types::AppError;
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use std::path::{Path, PathBuf};

const WINDOW_MS: i64 = 30;
const TRANSCRIPTION_COHERENCE_GAP_MS: i64 = 2_500;
const NORMALIZE_TARGET_PEAK: f32 = 0.75;
const NORMALIZE_MIN_GAIN: f32 = 1.25;
const NORMALIZE_MAX_GAIN: f32 = 32.0;
/// Loudest-window RMS below which a track carries no transcribable speech.
/// Deliberately conservative (≈ -38 dBFS) and matches the microphone lane's
/// activity `min_rms`, so we only ever skip clearly-silent audio.
const SILENCE_RMS_FLOOR: f32 = 0.012;

#[derive(Debug, Clone)]
pub struct DetectionSource {
    pub artifact_id: String,
    pub source: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioTurn {
    pub artifact_id: String,
    pub source: String,
    pub source_path: PathBuf,
    pub start_ms: i64,
    pub end_ms: i64,
    pub turn_index: i64,
}

#[derive(Debug, Clone, Copy)]
struct SourceDetectionConfig {
    start_active_ms: i64,
    end_silence_ms: i64,
    min_turn_ms: i64,
    merge_gap_ms: i64,
    min_rms: f32,
    noise_multiplier: f32,
}

pub fn detect_turns(sources: &[DetectionSource]) -> Result<Vec<AudioTurn>, AppError> {
    let mut turns = Vec::new();
    for source in sources {
        let config = config_for_source(&source.source);
        let mut source_turns = detect_source_turns(source, config)?;
        turns.append(&mut source_turns);
    }
    turns.sort_by(|left, right| {
        left.start_ms
            .cmp(&right.start_ms)
            .then_with(|| source_order(&left.source).cmp(&source_order(&right.source)))
            .then_with(|| left.end_ms.cmp(&right.end_ms))
    });
    for (index, turn) in turns.iter_mut().enumerate() {
        turn.turn_index = index as i64;
    }
    Ok(turns)
}

/// Whether a WAV's loudest RMS window never crosses the silence floor — i.e.
/// the track is effectively silent and not worth transcribing. If the file
/// can't be read we return `false` so the audio is still attempted rather than
/// silently dropped.
pub fn source_is_effectively_silent(path: &Path) -> bool {
    match read_rms_windows(path) {
        Ok(windows) => windows.iter().copied().fold(0.0_f32, f32::max) < SILENCE_RMS_FLOOR,
        Err(_) => false,
    }
}

pub fn coalesce_turns_for_transcription(mut turns: Vec<AudioTurn>) -> Vec<AudioTurn> {
    turns.sort_by(|left, right| {
        left.start_ms
            .cmp(&right.start_ms)
            .then_with(|| source_order(&left.source).cmp(&source_order(&right.source)))
            .then_with(|| left.end_ms.cmp(&right.end_ms))
    });
    let mut coalesced: Vec<AudioTurn> = Vec::new();
    for turn in turns {
        if let Some(last) = coalesced.last_mut() {
            let gap_ms = turn.start_ms - last.end_ms;
            if last.source == turn.source && gap_ms <= TRANSCRIPTION_COHERENCE_GAP_MS {
                last.end_ms = last.end_ms.max(turn.end_ms);
                continue;
            }
        }
        coalesced.push(turn);
    }
    for (index, turn) in coalesced.iter_mut().enumerate() {
        turn.turn_index = index as i64;
    }
    coalesced
}

pub fn write_turn_wav(turn: &AudioTurn, output_path: &Path) -> Result<(), AppError> {
    let mut reader = WavReader::open(&turn.source_path)
        .map_err(|error| AppError::new("audio_turn_failed", error.to_string()))?;
    let spec = reader.spec();
    if spec.sample_format != SampleFormat::Int || spec.bits_per_sample != 16 {
        return Err(AppError::new(
            "audio_turn_failed",
            "Only 16-bit PCM WAV turn extraction is supported.",
        ));
    }
    let channels = spec.channels.max(1) as usize;
    let sample_rate = spec.sample_rate.max(1) as i64;
    let start_frame = ((turn.start_ms.max(0) * sample_rate) / 1000) as usize;
    let end_frame = ((turn.end_ms.max(turn.start_ms) * sample_rate) / 1000) as usize;
    let start_sample = start_frame.saturating_mul(channels);
    let sample_count = end_frame
        .saturating_sub(start_frame)
        .saturating_mul(channels);
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| AppError::new("audio_turn_failed", error.to_string()))?;
    }
    let mut writer = WavWriter::create(output_path, spec)
        .map_err(|error| AppError::new("audio_turn_failed", error.to_string()))?;
    for sample in reader
        .samples::<i16>()
        .skip(start_sample)
        .take(sample_count)
    {
        writer
            .write_sample(sample.unwrap_or(0))
            .map_err(|error| AppError::new("audio_turn_failed", error.to_string()))?;
    }
    writer
        .finalize()
        .map_err(|error| AppError::new("audio_turn_failed", error.to_string()))?;
    Ok(())
}

pub fn normalize_wav_for_transcription(
    input_path: &Path,
    output_path: &Path,
) -> Result<PathBuf, AppError> {
    let mut reader = WavReader::open(input_path)
        .map_err(|error| AppError::new("audio_normalize_failed", error.to_string()))?;
    let spec = reader.spec();
    ensure_normalizable_spec(spec)?;
    let samples = reader
        .samples::<i16>()
        .map(|sample| sample.unwrap_or(0))
        .collect::<Vec<_>>();
    let peak = samples
        .iter()
        .map(|sample| sample.unsigned_abs() as f32 / i16::MAX as f32)
        .fold(0.0_f32, f32::max);
    if peak <= f32::EPSILON {
        return Ok(input_path.to_path_buf());
    }
    let gain = (NORMALIZE_TARGET_PEAK / peak).min(NORMALIZE_MAX_GAIN);
    if gain < NORMALIZE_MIN_GAIN {
        return Ok(input_path.to_path_buf());
    }
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| AppError::new("audio_normalize_failed", error.to_string()))?;
    }
    let mut writer = WavWriter::create(output_path, spec)
        .map_err(|error| AppError::new("audio_normalize_failed", error.to_string()))?;
    for sample in samples {
        let amplified = (sample as f32 * gain).round();
        writer
            .write_sample(amplified.clamp(i16::MIN as f32, i16::MAX as f32) as i16)
            .map_err(|error| AppError::new("audio_normalize_failed", error.to_string()))?;
    }
    writer
        .finalize()
        .map_err(|error| AppError::new("audio_normalize_failed", error.to_string()))?;
    Ok(output_path.to_path_buf())
}

fn ensure_normalizable_spec(spec: WavSpec) -> Result<(), AppError> {
    if spec.sample_format == SampleFormat::Int && spec.bits_per_sample == 16 {
        return Ok(());
    }
    Err(AppError::new(
        "audio_normalize_failed",
        "Only 16-bit PCM WAV normalization is supported.",
    ))
}

fn detect_source_turns(
    source: &DetectionSource,
    config: SourceDetectionConfig,
) -> Result<Vec<AudioTurn>, AppError> {
    let windows = read_rms_windows(&source.path)?;
    if windows.is_empty() {
        return Ok(Vec::new());
    }
    let threshold = activity_threshold(&windows, config);
    let start_windows = windows_for_ms(config.start_active_ms);
    let silence_windows = windows_for_ms(config.end_silence_ms);
    let mut turns = Vec::new();
    let mut active_run = 0_i64;
    let mut silence_run = 0_i64;
    let mut current_start: Option<i64> = None;

    for (index, rms) in windows.iter().enumerate() {
        let window_start = index as i64 * WINDOW_MS;
        if *rms >= threshold {
            active_run += 1;
            silence_run = 0;
            if current_start.is_none() && active_run >= start_windows {
                current_start = Some(window_start - ((start_windows - 1) * WINDOW_MS));
            }
        } else {
            active_run = 0;
            if current_start.is_some() {
                silence_run += 1;
                if silence_run >= silence_windows {
                    let end_ms = window_start - ((silence_windows - 1) * WINDOW_MS);
                    push_turn_if_long_enough(
                        &mut turns,
                        source,
                        current_start.take().unwrap(),
                        end_ms,
                        config,
                    );
                    silence_run = 0;
                }
            }
        }
    }

    if let Some(start_ms) = current_start {
        push_turn_if_long_enough(
            &mut turns,
            source,
            start_ms,
            windows.len() as i64 * WINDOW_MS,
            config,
        );
    }
    Ok(merge_close_turns(turns, config.merge_gap_ms))
}

fn read_rms_windows(path: &Path) -> Result<Vec<f32>, AppError> {
    let mut reader = WavReader::open(path)
        .map_err(|error| AppError::new("audio_turn_failed", error.to_string()))?;
    let spec = reader.spec();
    if spec.sample_format != SampleFormat::Int || spec.bits_per_sample != 16 {
        return Err(AppError::new(
            "audio_turn_failed",
            "Only 16-bit PCM WAV turn detection is supported.",
        ));
    }
    let channels = spec.channels.max(1) as usize;
    let sample_rate = spec.sample_rate.max(1) as usize;
    let frames_per_window = ((sample_rate as i64 * WINDOW_MS) / 1000).max(1) as usize;
    let mut windows = Vec::new();
    let mut sum_square = 0.0_f64;
    let mut frames = 0_usize;
    let mut channel_index = 0_usize;
    for sample in reader.samples::<i16>() {
        let normalized = sample.unwrap_or(0) as f32 / i16::MAX as f32;
        sum_square += (normalized as f64).powi(2);
        channel_index += 1;
        if channel_index == channels {
            channel_index = 0;
            frames += 1;
            if frames == frames_per_window {
                windows.push((sum_square / (frames * channels) as f64).sqrt() as f32);
                sum_square = 0.0;
                frames = 0;
            }
        }
    }
    if frames > 0 {
        windows.push((sum_square / (frames * channels) as f64).sqrt() as f32);
    }
    Ok(windows)
}

fn activity_threshold(windows: &[f32], config: SourceDetectionConfig) -> f32 {
    let mut sorted = windows.to_vec();
    sorted.sort_by(|left, right| left.total_cmp(right));
    let percentile_index = ((sorted.len().saturating_sub(1)) as f32 * 0.2).round() as usize;
    let noise_floor = sorted.get(percentile_index).copied().unwrap_or(0.0);
    (noise_floor * config.noise_multiplier)
        .max(noise_floor + config.min_rms)
        .max(config.min_rms)
}

fn push_turn_if_long_enough(
    turns: &mut Vec<AudioTurn>,
    source: &DetectionSource,
    start_ms: i64,
    end_ms: i64,
    config: SourceDetectionConfig,
) {
    if end_ms - start_ms < config.min_turn_ms {
        return;
    }
    turns.push(AudioTurn {
        artifact_id: source.artifact_id.clone(),
        source: source.source.clone(),
        source_path: source.path.clone(),
        start_ms: start_ms.max(0),
        end_ms: end_ms.max(start_ms),
        turn_index: 0,
    });
}

fn merge_close_turns(turns: Vec<AudioTurn>, merge_gap_ms: i64) -> Vec<AudioTurn> {
    let mut merged: Vec<AudioTurn> = Vec::new();
    for turn in turns {
        if let Some(last) = merged.last_mut() {
            if turn.start_ms - last.end_ms <= merge_gap_ms {
                last.end_ms = last.end_ms.max(turn.end_ms);
                continue;
            }
        }
        merged.push(turn);
    }
    merged
}

fn windows_for_ms(duration_ms: i64) -> i64 {
    ((duration_ms + WINDOW_MS - 1) / WINDOW_MS).max(1)
}

fn config_for_source(source: &str) -> SourceDetectionConfig {
    if source == "system" {
        SourceDetectionConfig {
            start_active_ms: 180,
            end_silence_ms: 2_000,
            min_turn_ms: 600,
            merge_gap_ms: 1_200,
            min_rms: 0.006,
            noise_multiplier: 3.0,
        }
    } else {
        SourceDetectionConfig {
            start_active_ms: 300,
            end_silence_ms: 1_800,
            min_turn_ms: 700,
            merge_gap_ms: 900,
            min_rms: 0.012,
            noise_multiplier: 4.0,
        }
    }
}

fn source_order(source: &str) -> i32 {
    match source {
        "microphone" => 0,
        "system" => 1,
        _ => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::WavSpec;

    #[test]
    fn normalization_boosts_quiet_wav_without_touching_original() {
        let dir =
            std::env::temp_dir().join(format!("os-scribe-normalize-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("quiet.wav");
        let output = dir.join("normalized.wav");
        write_samples(&input, &[100, -120, 90, -80]);

        let prepared = normalize_wav_for_transcription(&input, &output).unwrap();

        assert_eq!(prepared, output);
        let original = read_samples(&input);
        let normalized = read_samples(&output);
        assert_eq!(original, vec![100, -120, 90, -80]);
        assert!(
            normalized.iter().map(|sample| sample.abs()).max().unwrap()
                > original.iter().map(|sample| sample.abs()).max().unwrap() * 10
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn normalization_reuses_loud_enough_wav() {
        let dir =
            std::env::temp_dir().join(format!("os-scribe-normalize-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("loud.wav");
        let output = dir.join("normalized.wav");
        write_samples(&input, &[20_000, -18_000]);

        let prepared = normalize_wav_for_transcription(&input, &output).unwrap();

        assert_eq!(prepared, input);
        assert!(!output.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn flags_silent_track_and_keeps_audible_one() {
        let dir =
            std::env::temp_dir().join(format!("os-scribe-silence-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let silent = dir.join("silent.wav");
        let audible = dir.join("audible.wav");
        write_samples(&silent, &[0, 0, 0, 0, 1, -1]);
        write_samples(&audible, &[20_000, -18_000, 19_000, -20_000]);

        assert!(source_is_effectively_silent(&silent));
        assert!(!source_is_effectively_silent(&audible));

        let _ = std::fs::remove_dir_all(dir);
    }

    fn write_samples(path: &Path, samples: &[i16]) {
        let spec = WavSpec {
            channels: 1,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut writer = WavWriter::create(path, spec).unwrap();
        for sample in samples {
            writer.write_sample(*sample).unwrap();
        }
        writer.finalize().unwrap();
    }

    fn read_samples(path: &Path) -> Vec<i16> {
        let mut reader = WavReader::open(path).unwrap();
        reader
            .samples::<i16>()
            .map(|sample| sample.unwrap())
            .collect()
    }
}
