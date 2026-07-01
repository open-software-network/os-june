use crate::domain::types::AppError;
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use std::path::{Path, PathBuf};

const WINDOW_MS: i64 = 30;
const TRANSCRIPTION_COHERENCE_GAP_MS: i64 = 2_500;
const NORMALIZE_TARGET_PEAK: f32 = 0.75;
const NORMALIZE_MIN_GAIN: f32 = 1.25;
const NORMALIZE_MAX_GAIN: f32 = 32.0;
const TRANSCRIPTION_SAMPLE_RATE: u32 = 16_000;
const TRANSCRIPTION_CHANNELS: u16 = 1;
pub const MAX_TRANSCRIPTION_CHUNK_MS: i64 = 30 * 1000;
/// Loudest-window RMS below which a track carries no transcribable speech.
/// Deliberately conservative (≈ -38 dBFS) and matches the microphone lane's
/// activity `min_rms`, so we only ever skip clearly-silent audio.
const SILENCE_RMS_FLOOR: f32 = 0.012;
/// How much louder the system track must be than the microphone, both measured
/// over the same overlapping span, to treat that span of the microphone turn as
/// echo of system audio. Echo re-captured through the air is heavily attenuated,
/// so a clearly louder system track means the microphone only heard the speaker,
/// not the user. Kept conservative so genuine simultaneous mic speech (comparable
/// energy over the overlap) is kept.
const ECHO_DOMINANCE_RATIO: f32 = 3.0;

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

/// A source's detected turns paired with the per-window RMS energy they came
/// from, so cross-source attribution (echo rejection) can compare loudness
/// between the microphone and system tracks over the same wall-clock interval.
struct DetectedSource {
    source: String,
    windows: Vec<f32>,
    turns: Vec<AudioTurn>,
}

pub fn detect_turns(sources: &[DetectionSource]) -> Result<Vec<AudioTurn>, AppError> {
    let mut detected = Vec::with_capacity(sources.len());
    for source in sources {
        let config = config_for_source(&source.source);
        let (windows, source_turns) = detect_source_turns(source, config)?;
        detected.push(DetectedSource {
            source: source.source.clone(),
            windows,
            turns: source_turns,
        });
    }
    let mut turns = reject_speaker_echo_turns(detected);
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
            let merged_end_ms = last.end_ms.max(turn.end_ms);
            let merged_duration_ms = merged_end_ms - last.start_ms;
            if last.source == turn.source
                && gap_ms <= TRANSCRIPTION_COHERENCE_GAP_MS
                && merged_duration_ms <= MAX_TRANSCRIPTION_CHUNK_MS
            {
                last.end_ms = merged_end_ms;
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
    let sample_count = end_frame
        .saturating_sub(start_frame)
        .saturating_mul(channels);
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| AppError::new("audio_turn_failed", error.to_string()))?;
    }
    let mut writer = WavWriter::create(output_path, spec)
        .map_err(|error| AppError::new("audio_turn_failed", error.to_string()))?;
    // seek() repositions by byte offset. The previous .skip() pulled every
    // sample before the turn through the decoder, so extracting turn N
    // re-decoded the recording from its start each time — across a meeting's
    // worth of turns that is quadratic in the recording length.
    let start_frame = u32::try_from(start_frame)
        .map_err(|error| AppError::new("audio_turn_failed", error.to_string()))?;
    reader
        .seek(start_frame)
        .map_err(|error| AppError::new("audio_turn_failed", error.to_string()))?;
    for sample in reader.samples::<i16>().take(sample_count) {
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
    let input_samples = reader
        .samples::<i16>()
        .map(|sample| sample.unwrap_or(0))
        .collect::<Vec<_>>();
    let mono_samples = downmix_to_mono(&input_samples, spec.channels.max(1));
    let peak = mono_samples
        .iter()
        .map(|sample| sample.unsigned_abs() as f32 / i16::MAX as f32)
        .fold(0.0_f32, f32::max);
    let output_spec = WavSpec {
        channels: TRANSCRIPTION_CHANNELS,
        sample_rate: TRANSCRIPTION_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let already_transcription_ready =
        spec.channels == TRANSCRIPTION_CHANNELS && spec.sample_rate == TRANSCRIPTION_SAMPLE_RATE;
    if peak <= f32::EPSILON && already_transcription_ready {
        return Ok(input_path.to_path_buf());
    }
    let gain = if peak <= f32::EPSILON {
        1.0
    } else {
        (NORMALIZE_TARGET_PEAK / peak).min(NORMALIZE_MAX_GAIN)
    };
    if gain < NORMALIZE_MIN_GAIN && already_transcription_ready {
        return Ok(input_path.to_path_buf());
    }
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| AppError::new("audio_normalize_failed", error.to_string()))?;
    }
    let prepared_samples =
        resample_linear(&mono_samples, spec.sample_rate, TRANSCRIPTION_SAMPLE_RATE);
    let mut writer = WavWriter::create(output_path, output_spec)
        .map_err(|error| AppError::new("audio_normalize_failed", error.to_string()))?;
    for sample in prepared_samples {
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

pub fn split_wav_for_transcription(
    input_path: &Path,
    output_dir: &Path,
    stem: &str,
) -> Result<Vec<PathBuf>, AppError> {
    let mut reader = WavReader::open(input_path)
        .map_err(|error| AppError::new("audio_chunk_failed", error.to_string()))?;
    let spec = reader.spec();
    ensure_normalizable_spec(spec)?;
    let channels = spec.channels.max(1) as usize;
    let sample_rate = spec.sample_rate.max(1) as i64;
    let total_frames = reader.duration() as i64;
    let duration_ms = (total_frames * 1000) / sample_rate;
    if duration_ms <= MAX_TRANSCRIPTION_CHUNK_MS {
        return Ok(vec![input_path.to_path_buf()]);
    }

    std::fs::create_dir_all(output_dir)
        .map_err(|error| AppError::new("audio_chunk_failed", error.to_string()))?;
    let frames_per_chunk = ((sample_rate * MAX_TRANSCRIPTION_CHUNK_MS) / 1000).max(1) as usize;
    let mut chunks = Vec::new();
    let mut writer: Option<WavWriter<std::io::BufWriter<std::fs::File>>> = None;
    let mut chunk_index = 0_usize;
    let mut frames_in_chunk = 0_usize;
    let mut channel_index = 0_usize;

    for sample in reader.samples::<i16>() {
        if writer.is_none() || frames_in_chunk == frames_per_chunk {
            if let Some(writer) = writer.take() {
                writer
                    .finalize()
                    .map_err(|error| AppError::new("audio_chunk_failed", error.to_string()))?;
            }
            let path = output_dir.join(format!("{stem}-chunk-{chunk_index:03}.wav"));
            writer = Some(
                WavWriter::create(&path, spec)
                    .map_err(|error| AppError::new("audio_chunk_failed", error.to_string()))?,
            );
            chunks.push(path);
            chunk_index += 1;
            frames_in_chunk = 0;
            channel_index = 0;
        }
        if let Some(writer) = writer.as_mut() {
            writer
                .write_sample(sample.unwrap_or(0))
                .map_err(|error| AppError::new("audio_chunk_failed", error.to_string()))?;
        }
        channel_index += 1;
        if channel_index == channels {
            channel_index = 0;
            frames_in_chunk += 1;
        }
    }

    if let Some(writer) = writer.take() {
        writer
            .finalize()
            .map_err(|error| AppError::new("audio_chunk_failed", error.to_string()))?;
    }

    debug_assert!(
        !chunks.is_empty(),
        "split_wav_for_transcription: no chunks produced for audio longer than MAX_TRANSCRIPTION_CHUNK_MS"
    );
    Ok(chunks)
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

fn downmix_to_mono(samples: &[i16], channels: u16) -> Vec<i16> {
    let channel_count = channels.max(1) as usize;
    if channel_count == 1 {
        return samples.to_vec();
    }
    samples
        .chunks(channel_count)
        .map(|frame| {
            let sum = frame.iter().map(|sample| *sample as i32).sum::<i32>();
            (sum / frame.len().max(1) as i32).clamp(i16::MIN as i32, i16::MAX as i32) as i16
        })
        .collect()
}

fn resample_linear(samples: &[i16], input_rate: u32, output_rate: u32) -> Vec<i16> {
    if samples.is_empty() || input_rate == output_rate {
        return samples.to_vec();
    }
    let ratio = input_rate as f64 / output_rate as f64;
    let output_len = ((samples.len() as f64) / ratio).ceil().max(1.0) as usize;
    let mut output = Vec::with_capacity(output_len);
    for index in 0..output_len {
        let source_pos = index as f64 * ratio;
        let left_index = source_pos.floor() as usize;
        let right_index = (left_index + 1).min(samples.len() - 1);
        let fraction = source_pos - left_index as f64;
        let left = samples[left_index.min(samples.len() - 1)] as f64;
        let right = samples[right_index] as f64;
        let sample = left + ((right - left) * fraction);
        output.push(sample.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16);
    }
    output
}

fn detect_source_turns(
    source: &DetectionSource,
    config: SourceDetectionConfig,
) -> Result<(Vec<f32>, Vec<AudioTurn>), AppError> {
    let windows = read_rms_windows(&source.path)?;
    if windows.is_empty() {
        return Ok((windows, Vec::new()));
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
    let turns = merge_close_turns(turns, config.merge_gap_ms);
    Ok((windows, turns))
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

/// Each source is detected independently, so the microphone track's detector
/// happily emits a turn whenever it crosses its threshold — including when the
/// only thing it heard was a remote participant's voice played through the
/// speakers and bled back into the mic. That misattributes system audio to the
/// microphone. Trim the speaker-bleed spans (where a concurrent system turn is
/// clearly louder) out of each microphone turn, keeping the genuine, system-free
/// remainder; the bled-over speech stays attributed to the system source. A mic
/// turn entirely covered by louder system audio is trimmed away to nothing.
fn reject_speaker_echo_turns(detected: Vec<DetectedSource>) -> Vec<AudioTurn> {
    let system_sources: Vec<&DetectedSource> = detected
        .iter()
        .filter(|candidate| candidate.source == "system")
        .collect();
    let mut turns = Vec::new();
    for source in &detected {
        if source.source == "microphone" && !system_sources.is_empty() {
            let min_turn_ms = config_for_source(&source.source).min_turn_ms;
            for turn in &source.turns {
                let echo_spans: Vec<(i64, i64)> = system_sources
                    .iter()
                    .flat_map(|system| {
                        system_echo_spans(turn, &source.windows, &system.turns, &system.windows)
                    })
                    .collect();
                turns.extend(trim_echo_from_microphone_turn(turn, &echo_spans, min_turn_ms));
            }
        } else {
            turns.extend(source.turns.iter().cloned());
        }
    }
    turns
}

/// Sub-intervals of `mic_turn` that are speaker bleed (echo): each is covered by
/// a system turn that is clearly louder than the microphone over that overlap.
/// Subtracting these from the mic turn leaves the genuine microphone speech.
fn system_echo_spans(
    mic_turn: &AudioTurn,
    mic_windows: &[f32],
    system_turns: &[AudioTurn],
    system_windows: &[f32],
) -> Vec<(i64, i64)> {
    let mut spans = Vec::new();
    for system_turn in system_turns {
        let start = mic_turn.start_ms.max(system_turn.start_ms);
        let end = mic_turn.end_ms.min(system_turn.end_ms);
        if end <= start {
            continue;
        }
        // Compare both tracks over the same overlapping span: the question is
        // whether, where they coincide, the microphone only heard the speaker.
        let mic_energy = mean_rms(mic_windows, start, end);
        let system_energy = mean_rms(system_windows, start, end);
        if system_energy >= mic_energy * ECHO_DOMINANCE_RATIO {
            spans.push((start, end));
        }
    }
    spans
}

/// Cut the echo spans out of `mic_turn` and return the remaining genuine
/// stretches that are still long enough to stand as their own turns. An empty
/// span list returns the turn unchanged; spans covering the whole turn return
/// nothing (pure echo, fully dropped).
fn trim_echo_from_microphone_turn(
    mic_turn: &AudioTurn,
    echo_spans: &[(i64, i64)],
    min_turn_ms: i64,
) -> Vec<AudioTurn> {
    if echo_spans.is_empty() {
        return vec![mic_turn.clone()];
    }
    let mut spans = echo_spans.to_vec();
    spans.sort_by_key(|(start, _)| *start);
    let mut kept = Vec::new();
    let mut cursor = mic_turn.start_ms;
    for (start, end) in spans {
        if start > cursor {
            push_microphone_segment(&mut kept, mic_turn, cursor, start, min_turn_ms);
        }
        cursor = cursor.max(end);
    }
    if cursor < mic_turn.end_ms {
        push_microphone_segment(&mut kept, mic_turn, cursor, mic_turn.end_ms, min_turn_ms);
    }
    kept
}

/// Push `[start_ms, end_ms)` of `mic_turn` as a microphone turn when it is at
/// least `min_turn_ms` long, matching the detector's own minimum turn length so
/// trimming never emits slivers the detector would not have produced.
fn push_microphone_segment(
    turns: &mut Vec<AudioTurn>,
    mic_turn: &AudioTurn,
    start_ms: i64,
    end_ms: i64,
    min_turn_ms: i64,
) {
    if end_ms - start_ms < min_turn_ms {
        return;
    }
    turns.push(AudioTurn {
        artifact_id: mic_turn.artifact_id.clone(),
        source: mic_turn.source.clone(),
        source_path: mic_turn.source_path.clone(),
        start_ms,
        end_ms,
        turn_index: 0,
    });
}

/// Mean RMS of the windows spanning `[start_ms, end_ms)`. Returns 0 when the
/// range is empty or falls outside the captured windows.
fn mean_rms(windows: &[f32], start_ms: i64, end_ms: i64) -> f32 {
    if windows.is_empty() || end_ms <= start_ms {
        return 0.0;
    }
    let start = (start_ms.max(0) / WINDOW_MS) as usize;
    let end = (windows_for_ms(end_ms.max(0)) as usize).min(windows.len());
    if end <= start || start >= windows.len() {
        return 0.0;
    }
    let slice = &windows[start..end];
    slice.iter().copied().sum::<f32>() / slice.len() as f32
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
            std::env::temp_dir().join(format!("os-june-normalize-test-{}", uuid::Uuid::new_v4()));
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
            std::env::temp_dir().join(format!("os-june-normalize-test-{}", uuid::Uuid::new_v4()));
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
    fn normalization_downmixes_and_downsamples_for_transcription() {
        let dir =
            std::env::temp_dir().join(format!("os-june-normalize-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("stereo.wav");
        let output = dir.join("prepared.wav");
        write_stereo_48k_samples(&input, &[8_000, 8_000, -8_000, -8_000, 4_000, 4_000]);

        let prepared = normalize_wav_for_transcription(&input, &output).unwrap();

        assert_eq!(prepared, output);
        let reader = WavReader::open(&output).unwrap();
        let spec = reader.spec();
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.sample_rate, 16_000);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn turn_extraction_cuts_the_exact_segment() {
        // Pins the seek-based extraction: the segment must start at the
        // turn's first frame and contain exactly the turn's samples, byte
        // offsets and decoder state agreeing with the old skip-based path.
        let dir = std::env::temp_dir().join(format!("os-june-turn-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("source.wav");
        let output = dir.join("turn.wav");
        // 16 kHz mono: 1 ms = 16 frames. A ramp makes every frame unique.
        let samples = (0..480).map(|value| value as i16).collect::<Vec<_>>();
        write_samples(&input, &samples);

        let turn = AudioTurn {
            artifact_id: "artifact".to_string(),
            source: "microphone".to_string(),
            source_path: input.clone(),
            start_ms: 10,
            end_ms: 20,
            turn_index: 0,
        };
        write_turn_wav(&turn, &output).unwrap();

        let extracted = read_samples(&output);
        assert_eq!(extracted, (160..320).map(|v| v as i16).collect::<Vec<_>>());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn flags_silent_track_and_keeps_audible_one() {
        let dir =
            std::env::temp_dir().join(format!("os-june-silence-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let silent = dir.join("silent.wav");
        let audible = dir.join("audible.wav");
        write_samples(&silent, &[0, 0, 0, 0, 1, -1]);
        write_samples(&audible, &[20_000, -18_000, 19_000, -20_000]);

        assert!(source_is_effectively_silent(&silent));
        assert!(!source_is_effectively_silent(&audible));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn microphone_echo_of_system_audio_is_not_attributed_to_microphone() {
        // Hands-free meeting: a remote participant speaks, captured loud and
        // clean on the system track and bled quietly into the microphone.
        // Without echo rejection the mic detector emits a "microphone" turn for
        // that bleed, misattributing system audio to the user. A later,
        // system-free mic turn (the user actually speaking) must still survive.
        let dir = std::env::temp_dir().join(format!("os-june-echo-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mic_path = dir.join("microphone.wav");
        let system_path = dir.join("system.wav");

        // Mic: 1.5s quiet echo, 2.1s silence, 1.5s genuine loud speech.
        let mut mic = square_wave_ms(1_600, 1_500);
        mic.extend(square_wave_ms(0, 2_100));
        mic.extend(square_wave_ms(16_000, 1_500));
        write_samples(&mic_path, &mic);

        // System: 1.5s loud speech overlapping the mic echo, then silence.
        let mut system = square_wave_ms(16_000, 1_500);
        system.extend(square_wave_ms(0, 2_100));
        write_samples(&system_path, &system);

        let turns = detect_turns(&[
            DetectionSource {
                artifact_id: "mic".to_string(),
                source: "microphone".to_string(),
                path: mic_path,
            },
            DetectionSource {
                artifact_id: "sys".to_string(),
                source: "system".to_string(),
                path: system_path,
            },
        ])
        .unwrap();

        // The remote participant's speech is retained on the system source...
        assert!(turns
            .iter()
            .any(|turn| turn.source == "system" && turn.start_ms < 1_000));
        // ...the genuine, system-free microphone speech survives...
        assert!(turns
            .iter()
            .any(|turn| turn.source == "microphone" && turn.start_ms > 2_500));
        // ...and no microphone turn is attributed to the echoed system speech.
        assert!(turns
            .iter()
            .filter(|turn| turn.source == "microphone")
            .all(|turn| turn.start_ms > 2_500));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn echo_decision_trims_quiet_overlap_but_keeps_loud_or_isolated_mic() {
        // 30ms windows: window index == ms / 30. 200 windows == 6s.
        let mut mic_windows = vec![0.0_f32; 200];
        let mut system_windows = vec![0.0_f32; 200];
        for window in 0..50 {
            mic_windows[window] = 0.05; // quiet echo
            system_windows[window] = 0.5; // loud system speech
        }
        for window in 120..170 {
            mic_windows[window] = 0.5; // genuine mic speech, no system
        }
        let system_turns = vec![make_turn("system", 0, 1_500)];
        let min_turn_ms = config_for_source("microphone").min_turn_ms;

        // Quiet mic fully covered by louder system audio is all echo, trimmed away.
        let echo = make_turn("microphone", 0, 1_500);
        let echo_spans = system_echo_spans(&echo, &mic_windows, &system_turns, &system_windows);
        assert_eq!(echo_spans, vec![(0, 1_500)]);
        assert!(trim_echo_from_microphone_turn(&echo, &echo_spans, min_turn_ms).is_empty());

        // A mic turn with no overlapping system audio is genuine speech, kept whole.
        let genuine = make_turn("microphone", 3_600, 5_100);
        let genuine_spans =
            system_echo_spans(&genuine, &mic_windows, &system_turns, &system_windows);
        assert!(genuine_spans.is_empty());
        assert_eq!(
            trim_echo_from_microphone_turn(&genuine, &genuine_spans, min_turn_ms),
            vec![genuine]
        );

        // Simultaneous speech with comparable mic energy is not echo, kept whole.
        let mut loud_mic = vec![0.0_f32; 200];
        for window in 0..50 {
            loud_mic[window] = 0.45;
        }
        assert!(system_echo_spans(&echo, &loud_mic, &system_turns, &system_windows).is_empty());
    }

    #[test]
    fn echo_trim_preserves_user_reply_merged_into_one_microphone_turn() {
        // A remote participant speaks, then the user replies shortly after. The
        // echo of the remote speech and the user's reply land in ONE mic turn
        // (the gap is shorter than the detector's silence/merge windows). The
        // echo must be trimmed off while the user's reply survives, instead of
        // dropping the whole turn.
        let min_turn_ms = config_for_source("microphone").min_turn_ms;
        let mic_turn = make_turn("microphone", 0, 3_300);
        let system_turns = vec![make_turn("system", 0, 2_000)];

        // 30ms windows: 0..2000ms quiet echo, 2000..3300ms loud genuine reply.
        let mut mic_windows = vec![0.0_f32; 110];
        let mut system_windows = vec![0.0_f32; 110];
        for window in 0..67 {
            mic_windows[window] = 0.05; // echo of the remote participant
            system_windows[window] = 0.5; // remote participant, loud and clean
        }
        for window in 67..110 {
            mic_windows[window] = 0.5; // the user's own reply, no system audio
        }

        let echo_spans =
            system_echo_spans(&mic_turn, &mic_windows, &system_turns, &system_windows);
        let kept = trim_echo_from_microphone_turn(&mic_turn, &echo_spans, min_turn_ms);

        // The echoed front is removed; the user's reply remains a mic turn.
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].source, "microphone");
        assert!(kept[0].start_ms >= 2_000);
        assert_eq!(kept[0].end_ms, 3_300);
    }

    fn make_turn(source: &str, start_ms: i64, end_ms: i64) -> AudioTurn {
        AudioTurn {
            artifact_id: "artifact".to_string(),
            source: source.to_string(),
            source_path: PathBuf::new(),
            start_ms,
            end_ms,
            turn_index: 0,
        }
    }

    fn square_wave_ms(magnitude: i16, duration_ms: i64) -> Vec<i16> {
        let frames = (16_000 * duration_ms / 1_000) as usize;
        (0..frames)
            .map(|index| if index % 2 == 0 { magnitude } else { -magnitude })
            .collect()
    }

    fn write_samples(path: &Path, samples: &[i16]) {
        let spec = WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut writer = WavWriter::create(path, spec).unwrap();
        for sample in samples {
            writer.write_sample(*sample).unwrap();
        }
        writer.finalize().unwrap();
    }

    fn write_stereo_48k_samples(path: &Path, samples: &[i16]) {
        let spec = WavSpec {
            channels: 2,
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
