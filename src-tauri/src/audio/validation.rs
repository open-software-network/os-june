use crate::domain::types::{AudioValidationDto, RecordingSource};
use hound::WavReader;
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::Path};

pub const MIN_RECORDING_MS: i64 = 1_000;

#[derive(Debug, Clone, Copy)]
pub struct AudioValidationConfig {
    pub min_duration_ms: i64,
    pub duration_tolerance_ms: i64,
    pub silence_rms_threshold: f32,
}

impl Default for AudioValidationConfig {
    fn default() -> Self {
        Self {
            min_duration_ms: MIN_RECORDING_MS,
            duration_tolerance_ms: 750,
            silence_rms_threshold: 0.01,
        }
    }
}

pub fn validate_audio_artifact(
    path: &Path,
    expected_duration_ms: i64,
    config: AudioValidationConfig,
) -> Result<AudioValidationDto, std::io::Error> {
    let file_exists = path.exists();
    let size = if file_exists {
        std::fs::metadata(path)?.len()
    } else {
        0
    };
    let non_zero_size = size > 0;
    let mut result = AudioValidationDto {
        file_exists,
        non_zero_size,
        readable_audio: false,
        expected_duration_ms,
        actual_duration_ms: 0,
        duration_within_tolerance: false,
        non_silent_signal: false,
        peak_amplitude: 0.0,
        rms_amplitude: 0.0,
        warnings: Vec::new(),
    };

    if !file_exists {
        result
            .warnings
            .push("audio file does not exist".to_string());
        return Ok(result);
    }
    if !non_zero_size {
        result.warnings.push("audio file is empty".to_string());
        return Ok(result);
    }

    let Ok(mut reader) = WavReader::open(path) else {
        result
            .warnings
            .push("audio file is not readable WAV".to_string());
        return Ok(result);
    };

    result.readable_audio = true;
    let spec = reader.spec();
    let sample_rate = spec.sample_rate.max(1) as i64;
    let sample_count = reader.duration() as i64;
    result.actual_duration_ms = (sample_count * 1000) / sample_rate;
    result.duration_within_tolerance =
        (result.actual_duration_ms - expected_duration_ms).abs() <= config.duration_tolerance_ms;

    if result.actual_duration_ms < config.min_duration_ms {
        result.warnings.push(format!(
            "audio duration is below {}ms",
            config.min_duration_ms
        ));
    }
    if !result.duration_within_tolerance {
        result.warnings.push(format!(
            "audio duration mismatch: expected {}ms, actual {}ms",
            expected_duration_ms, result.actual_duration_ms
        ));
    }

    let mut sum_square = 0.0_f64;
    let mut samples = 0_u64;
    for sample in reader.samples::<i16>() {
        let sample = sample.unwrap_or(0);
        let normalized = (sample as f32 / i16::MAX as f32).abs();
        result.peak_amplitude = result.peak_amplitude.max(normalized);
        sum_square += (normalized as f64).powi(2);
        samples += 1;
    }
    if samples > 0 {
        result.rms_amplitude = (sum_square / samples as f64).sqrt() as f32;
    }
    result.non_silent_signal = result.rms_amplitude >= config.silence_rms_threshold
        && result.peak_amplitude >= config.silence_rms_threshold * 3.0;
    if !result.non_silent_signal {
        result.warnings.push("audio appears silent".to_string());
    }

    Ok(result)
}

pub fn source_audio_passes_validation(
    source: RecordingSource,
    validation: &AudioValidationDto,
) -> bool {
    let has_usable_audio =
        validation.non_zero_size && validation.readable_audio && validation.non_silent_signal;
    match source {
        RecordingSource::Microphone => has_usable_audio && validation.duration_within_tolerance,
        RecordingSource::System => has_usable_audio,
    }
}

pub fn checksum_file(path: &Path) -> Result<String, std::io::Error> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
