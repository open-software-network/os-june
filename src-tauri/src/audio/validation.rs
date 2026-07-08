use crate::domain::types::{AudioValidationDto, RecordingSource};
use hound::WavReader;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

pub const MIN_RECORDING_MS: i64 = 1_000;
const MIN_POSITIVE_DURATION_DRIFT_MS: i64 = 60_000;
const MAX_POSITIVE_DURATION_DRIFT_MS: i64 = 10 * 60_000;
const POSITIVE_DURATION_DRIFT_RATIO_DENOMINATOR: i64 = 4;
const SILENT_PEAK_AMPLITUDE_MAX: f32 = f32::EPSILON;

#[derive(Debug, Clone, Copy)]
pub struct AudioValidationConfig {
    pub min_duration_ms: i64,
    pub duration_tolerance_ms: i64,
}

impl Default for AudioValidationConfig {
    fn default() -> Self {
        Self {
            min_duration_ms: MIN_RECORDING_MS,
            duration_tolerance_ms: 750,
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
        recorded_silence: false,
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

    if let Ok(Some(note)) = repair_stale_wav_header(path, size) {
        result.warnings.push(note);
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
    result.non_silent_signal = result.peak_amplitude > SILENT_PEAK_AMPLITUDE_MAX;
    result.recorded_silence = samples > 0 && !result.non_silent_signal;
    if result.recorded_silence {
        result
            .warnings
            .push("audio contains only silence".to_string());
    }

    Ok(result)
}

/// Repair a stale WAV header in place, reading the on-disk size first. Callers
/// that derive an expected duration from the header (recovery) must run this
/// before reading duration, or a stale header makes a repaired capture look
/// mismatched against itself.
pub fn repair_stale_wav_header_in_place(path: &Path) -> Result<Option<String>, std::io::Error> {
    let size = std::fs::metadata(path)?.len();
    repair_stale_wav_header(path, size)
}

/// The RIFF/data chunk sizes AVAudioFile writes are only finalized on a clean
/// close. When the system-audio helper is SIGKILLed mid-finalization the sizes
/// stay stale (usually far smaller than the bytes actually on disk), so a header
/// alone can make an hour-long capture look like minutes. A genuinely truncated
/// file leaves the opposite mismatch (a header claiming more than exists). In
/// either case the byte length on disk is the truth for a plain PCM stream, so
/// rewrite the size fields to match before duration is read.
fn repair_stale_wav_header(path: &Path, file_size: u64) -> Result<Option<String>, std::io::Error> {
    let Some(layout) = read_wav_layout(path)? else {
        return Ok(None);
    };
    if file_size < layout.data_payload_offset {
        return Ok(None);
    }
    let frame_bytes = layout.channels as u64 * (layout.bits_per_sample as u64 / 8);
    if frame_bytes == 0 {
        return Ok(None);
    }
    let available = file_size - layout.data_payload_offset;
    let repaired_data_size = available - (available % frame_bytes);
    if repaired_data_size == layout.declared_data_size as u64 {
        return Ok(None);
    }
    // A self-consistent declared size (declared audio end lands at EOF, or the
    // bytes there parse as a plausible trailing chunk header) is real, not
    // stale: expanding it would fold trailing metadata into the audio length.
    // Only the stale-small (declared end followed by non-chunk bytes) and
    // truncated (declared end beyond EOF) mismatches get rewritten.
    if declared_data_size_is_self_consistent(path, &layout, file_size)? {
        return Ok(None);
    }
    let Ok(repaired_data_size_u32) = u32::try_from(repaired_data_size) else {
        return Ok(None);
    };
    let Ok(riff_size_u32) = u32::try_from(file_size.saturating_sub(8)) else {
        return Ok(None);
    };

    let mut file = OpenOptions::new().write(true).open(path)?;
    file.seek(SeekFrom::Start(4))?;
    file.write_all(&riff_size_u32.to_le_bytes())?;
    file.seek(SeekFrom::Start(layout.data_size_field_offset))?;
    file.write_all(&repaired_data_size_u32.to_le_bytes())?;
    file.flush()?;

    Ok(Some(format!(
        "repaired stale WAV header: data size {} -> {} bytes",
        layout.declared_data_size, repaired_data_size
    )))
}

/// True when the declared `data` size is corroborated by the file layout: the
/// declared audio end (plus a word-align pad byte if the size is odd) either
/// lands exactly at EOF or is followed by bytes that parse as a plausible RIFF
/// chunk header. Such a header is authoritative and must not be expanded.
fn declared_data_size_is_self_consistent(
    path: &Path,
    layout: &WavLayout,
    file_size: u64,
) -> Result<bool, std::io::Error> {
    let declared = layout.declared_data_size as u64;
    let padded = declared + (declared & 1);
    let declared_end = layout.data_payload_offset + padded;
    if declared_end > file_size {
        // Declared end runs past EOF: truncated/stale, let the caller shrink.
        return Ok(false);
    }
    if declared_end == file_size {
        return Ok(true);
    }
    // A trailing chunk needs at least an 8-byte header to be plausible.
    if file_size - declared_end < 8 {
        return Ok(false);
    }
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(declared_end))?;
    let mut chunk_header = [0_u8; 8];
    if file.read_exact(&mut chunk_header).is_err() {
        return Ok(false);
    }
    let id_is_ascii = chunk_header[0..4]
        .iter()
        .all(|byte| byte.is_ascii_graphic() || *byte == b' ');
    let chunk_size = u32::from_le_bytes([
        chunk_header[4],
        chunk_header[5],
        chunk_header[6],
        chunk_header[7],
    ]) as u64;
    let remaining = file_size - declared_end - 8;
    Ok(id_is_ascii && chunk_size <= remaining)
}

struct WavLayout {
    channels: u16,
    bits_per_sample: u16,
    declared_data_size: u32,
    data_size_field_offset: u64,
    data_payload_offset: u64,
}

/// Walk the RIFF chunk list for a plain 16-bit PCM WAV (format tag 1). Returns
/// `None` for anything else so non-PCM or malformed files fall through to the
/// existing paths unchanged.
fn read_wav_layout(path: &Path) -> Result<Option<WavLayout>, std::io::Error> {
    let mut file = File::open(path)?;
    let mut header = [0_u8; 12];
    if file.read_exact(&mut header).is_err() {
        return Ok(None);
    }
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Ok(None);
    }

    let mut format_tag: Option<u16> = None;
    let mut channels: Option<u16> = None;
    let mut bits_per_sample: Option<u16> = None;
    let mut offset: u64 = 12;
    loop {
        let mut chunk_header = [0_u8; 8];
        if file.read_exact(&mut chunk_header).is_err() {
            return Ok(None);
        }
        let chunk_id = [
            chunk_header[0],
            chunk_header[1],
            chunk_header[2],
            chunk_header[3],
        ];
        let chunk_size = u32::from_le_bytes([
            chunk_header[4],
            chunk_header[5],
            chunk_header[6],
            chunk_header[7],
        ]);
        let chunk_body_offset = offset + 8;

        if &chunk_id == b"fmt " {
            let mut fmt = [0_u8; 16];
            if file.read_exact(&mut fmt).is_err() {
                return Ok(None);
            }
            format_tag = Some(u16::from_le_bytes([fmt[0], fmt[1]]));
            channels = Some(u16::from_le_bytes([fmt[2], fmt[3]]));
            bits_per_sample = Some(u16::from_le_bytes([fmt[14], fmt[15]]));
        } else if &chunk_id == b"data" {
            // AVAudioFile can emit WAVE_FORMAT_EXTENSIBLE (0xFFFE) for 16-bit
            // PCM; hound reads it as PCM, and the live-preview parser already
            // accepts it. The extended fmt chunk is larger, but chunk skipping
            // is size-based so the first 16 bytes still give channels/bits.
            if !matches!(format_tag, Some(1) | Some(0xFFFE)) || bits_per_sample != Some(16) {
                return Ok(None);
            }
            let (Some(channels), Some(bits_per_sample)) = (channels, bits_per_sample) else {
                return Ok(None);
            };
            return Ok(Some(WavLayout {
                channels,
                bits_per_sample,
                declared_data_size: chunk_size,
                data_size_field_offset: offset + 4,
                data_payload_offset: chunk_body_offset,
            }));
        }

        // Chunks are word-aligned: an odd size is followed by a pad byte.
        let advance = chunk_size as u64 + (chunk_size as u64 & 1);
        offset = chunk_body_offset + advance;
        if file.seek(SeekFrom::Start(offset)).is_err() {
            return Ok(None);
        }
    }
}

pub fn validation_config_for_source(_source: RecordingSource) -> AudioValidationConfig {
    AudioValidationConfig::default()
}

pub fn source_audio_passes_validation(
    source: RecordingSource,
    validation: &AudioValidationDto,
) -> bool {
    let has_usable_audio = validation.non_zero_size && validation.readable_audio;
    let config = validation_config_for_source(source);
    let expected_duration_ms = validation.expected_duration_ms.max(0);
    let positive_tolerance_ms =
        positive_duration_drift_tolerance_ms(expected_duration_ms, config.duration_tolerance_ms);
    // A slightly longer WAV can still be processed because long recordings can
    // drift from the app clock. Keep an upper bound so stale long files do not
    // get transcribed for short sessions.
    let is_not_truncated = validation
        .actual_duration_ms
        .saturating_add(config.duration_tolerance_ms)
        >= expected_duration_ms;
    let is_not_stale_long_audio =
        validation.actual_duration_ms <= expected_duration_ms.saturating_add(positive_tolerance_ms);
    match source {
        RecordingSource::Microphone => {
            has_usable_audio && is_not_truncated && is_not_stale_long_audio
        }
        RecordingSource::System => has_usable_audio && is_not_truncated && is_not_stale_long_audio,
    }
}

fn positive_duration_drift_tolerance_ms(expected_duration_ms: i64, base_tolerance_ms: i64) -> i64 {
    let proportional_tolerance_ms =
        expected_duration_ms / POSITIVE_DURATION_DRIFT_RATIO_DENOMINATOR;
    proportional_tolerance_ms
        .clamp(
            MIN_POSITIVE_DURATION_DRIFT_MS,
            MAX_POSITIVE_DURATION_DRIFT_MS,
        )
        .max(base_tolerance_ms)
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

#[cfg(test)]
mod tests {
    use super::*;
    use hound::{SampleFormat, WavSpec, WavWriter};

    fn write_wav(path: &Path, duration_ms: i64) {
        let spec = WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut writer = WavWriter::create(path, spec).unwrap();
        let samples = ((16_000 * duration_ms) / 1000) as usize;
        for index in 0..samples {
            let sample = if index % 2 == 0 { 6_000 } else { -6_000 };
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();
    }

    fn data_size_field_offset(path: &Path) -> u64 {
        read_wav_layout(path)
            .unwrap()
            .unwrap()
            .data_size_field_offset
    }

    fn patch_le_u32(path: &Path, offset: u64, value: u32) {
        let mut file = OpenOptions::new().write(true).open(path).unwrap();
        file.seek(SeekFrom::Start(offset)).unwrap();
        file.write_all(&value.to_le_bytes()).unwrap();
        file.flush().unwrap();
    }

    #[test]
    fn repairs_stale_small_header_and_reports_true_duration() {
        let dir = std::env::temp_dir().join(format!("os-june-repair-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("system.wav");
        write_wav(&path, 10_000);

        // Simulate SIGKILL mid-finalization: RIFF + data chunk sizes claim only
        // ~1s while 10s of samples sit on disk. Same code path as an hour-long
        // capture, negligible I/O.
        let data_offset = data_size_field_offset(&path);
        patch_le_u32(&path, 4, 32 + 16_000 * 2);
        patch_le_u32(&path, data_offset, 16_000 * 2);

        let result = validate_audio_artifact(&path, 10_000, AudioValidationConfig::default())
            .expect("validation should run");

        assert_eq!(result.actual_duration_ms, 10_000);
        assert!(source_audio_passes_validation(
            RecordingSource::System,
            &result
        ));
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("repaired stale WAV header")));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn repairs_oversized_header_to_on_disk_duration_and_still_fails_truncated() {
        let dir = std::env::temp_dir().join(format!("os-june-repair-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("system.wav");
        write_wav(&path, 2_000);

        // Header claims an hour of data the file does not contain.
        let data_offset = data_size_field_offset(&path);
        patch_le_u32(&path, 4, 32 + 3_600 * 16_000 * 2);
        patch_le_u32(&path, data_offset, 3_600 * 16_000 * 2);

        let result = validate_audio_artifact(&path, 3_600_000, AudioValidationConfig::default())
            .expect("validation should run");

        assert_eq!(result.actual_duration_ms, 2_000);
        assert!(!source_audio_passes_validation(
            RecordingSource::System,
            &result
        ));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn leaves_correct_header_with_trailing_chunk_unrepaired() {
        let dir = std::env::temp_dir().join(format!("os-june-repair-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("system.wav");
        write_wav(&path, 2_000);

        // Append a plausible trailing LIST chunk. The declared data size stays
        // correct, so the repair must not fold these metadata bytes into audio.
        let list_body = b"INFOISFT\x04\x00\x00\x00juna";
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"LIST").unwrap();
        file.write_all(&(list_body.len() as u32).to_le_bytes())
            .unwrap();
        file.write_all(list_body).unwrap();
        file.flush().unwrap();

        let result = validate_audio_artifact(&path, 2_000, AudioValidationConfig::default())
            .expect("validation should run");

        assert_eq!(result.actual_duration_ms, 2_000);
        assert!(
            !result
                .warnings
                .iter()
                .any(|warning| warning.contains("repaired stale WAV header")),
            "correct header followed by a trailing chunk must not be repaired"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn repairs_extensible_format_stale_header() {
        // Hand-built 16-bit PCM WAVE_FORMAT_EXTENSIBLE (0xFFFE) file: hound reads
        // it as PCM and the repair must recognize its layout. Header claims ~0.5s
        // while ~1s of samples are on disk.
        let dir = std::env::temp_dir().join(format!("os-june-repair-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("extensible.wav");

        let sample_rate: u32 = 16_000;
        let channels: u16 = 1;
        let bits: u16 = 16;
        let block_align: u16 = channels * bits / 8;
        let byte_rate: u32 = sample_rate * block_align as u32;
        let true_samples: u32 = sample_rate; // ~1s
        let true_data_size: u32 = true_samples * block_align as u32;

        let mut bytes: Vec<u8> = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&0_u32.to_le_bytes()); // riff size patched below
        bytes.extend_from_slice(b"WAVE");
        // fmt chunk, extensible = 40 bytes.
        bytes.extend_from_slice(b"fmt ");
        bytes.extend_from_slice(&40_u32.to_le_bytes());
        bytes.extend_from_slice(&0xFFFE_u16.to_le_bytes()); // WAVE_FORMAT_EXTENSIBLE
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&byte_rate.to_le_bytes());
        bytes.extend_from_slice(&block_align.to_le_bytes());
        bytes.extend_from_slice(&bits.to_le_bytes());
        bytes.extend_from_slice(&22_u16.to_le_bytes()); // cbSize
        bytes.extend_from_slice(&bits.to_le_bytes()); // valid bits per sample
        bytes.extend_from_slice(&0_u32.to_le_bytes()); // channel mask
                                                       // KSDATAFORMAT_SUBTYPE_PCM GUID.
        bytes.extend_from_slice(&[
            0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38,
            0x9B, 0x71,
        ]);
        // data chunk with a stale-small declared size.
        bytes.extend_from_slice(b"data");
        let stale_data_size: u32 = true_data_size / 2;
        bytes.extend_from_slice(&stale_data_size.to_le_bytes());
        bytes.extend_from_slice(&vec![0_u8; true_data_size as usize]);
        let riff_size = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
        std::fs::write(&path, &bytes).unwrap();

        let result = validate_audio_artifact(&path, 1_000, AudioValidationConfig::default())
            .expect("validation should run");

        assert!(result.readable_audio);
        assert_eq!(result.actual_duration_ms, 1_000);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("repaired stale WAV header")));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn leaves_garbage_file_as_not_readable() {
        let dir = std::env::temp_dir().join(format!("os-june-repair-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("garbage.bin");
        std::fs::write(&path, b"not a wav file at all, just some bytes").unwrap();

        let result = validate_audio_artifact(&path, 1_000, AudioValidationConfig::default())
            .expect("validation should run");

        assert!(!result.readable_audio);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("not readable WAV")));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn flags_structurally_valid_silent_wav_without_failing_validation() {
        let dir = std::env::temp_dir().join(format!("os-june-silent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("microphone.wav");
        let spec = WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut writer = WavWriter::create(&path, spec).unwrap();
        for _ in 0..16_000 {
            writer.write_sample(0_i16).unwrap();
        }
        writer.finalize().unwrap();

        let result = validate_audio_artifact(&path, 1_000, AudioValidationConfig::default())
            .expect("validation should run");

        assert!(result.readable_audio);
        assert!(result.non_zero_size);
        assert!(!result.non_silent_signal);
        assert!(result.recorded_silence);
        assert_eq!(result.peak_amplitude, 0.0);
        assert_eq!(result.rms_amplitude, 0.0);
        assert!(source_audio_passes_validation(
            RecordingSource::Microphone,
            &result
        ));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn does_not_flag_normal_wav_as_silent() {
        let dir = std::env::temp_dir().join(format!("os-june-silent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("microphone.wav");
        write_wav(&path, 1_000);

        let result = validate_audio_artifact(&path, 1_000, AudioValidationConfig::default())
            .expect("validation should run");

        assert!(result.non_silent_signal);
        assert!(!result.recorded_silence);
        assert!(result.peak_amplitude > 0.0);
        assert!(result.rms_amplitude > 0.0);

        let _ = std::fs::remove_dir_all(dir);
    }
}
