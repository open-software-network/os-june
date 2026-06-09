//! Post-validation FLAC compression for saved recording artifacts.
//!
//! Compression is archival only: capture always records WAV, and a FLAC copy
//! is produced after the WAV has been finalized and validated. FLAC is
//! lossless, so validation can require the decoded samples to match the WAV
//! source exactly before the original is ever eligible for deletion.

use crate::domain::types::AppError;
use flacenc::component::BitRepr;
use flacenc::error::Verify;
use flacenc::source::{Fill, Source};
use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use std::io::BufReader;
use std::path::{Path, PathBuf};

pub const FLAC_FORMAT: &str = "flac";

#[derive(Debug, Clone, PartialEq)]
pub struct CompressionOutcome {
    pub output_path: PathBuf,
    pub format: String,
    pub original_size_bytes: i64,
    pub compressed_size_bytes: i64,
    pub compressed_checksum: String,
    pub duration_ms: i64,
}

/// Streams 16-bit PCM WAV samples into the FLAC encoder without loading the
/// whole recording into memory (long meetings can be hundreds of MB).
struct WavSource {
    reader: WavReader<BufReader<std::fs::File>>,
    spec: WavSpec,
    buffer: Vec<i32>,
    failed: bool,
}

impl WavSource {
    fn open(path: &Path) -> Result<Self, AppError> {
        let reader = WavReader::open(path)
            .map_err(|error| AppError::new("audio_compression_failed", error.to_string()))?;
        let spec = reader.spec();
        ensure_compressible_spec(spec)?;
        Ok(Self {
            reader,
            spec,
            buffer: Vec::new(),
            failed: false,
        })
    }
}

impl Source for WavSource {
    fn channels(&self) -> usize {
        self.spec.channels.max(1) as usize
    }

    fn bits_per_sample(&self) -> usize {
        16
    }

    fn sample_rate(&self) -> usize {
        self.spec.sample_rate as usize
    }

    fn read_samples<F: Fill>(
        &mut self,
        block_size: usize,
        dest: &mut F,
    ) -> Result<usize, flacenc::error::SourceError> {
        let channels = self.channels();
        self.buffer.clear();
        for sample in self
            .reader
            .samples::<i16>()
            .take(block_size.saturating_mul(channels))
        {
            match sample {
                Ok(sample) => self.buffer.push(sample as i32),
                Err(_) => {
                    // A torn trailing frame in an otherwise-finalized WAV
                    // would corrupt the archive; surface it instead.
                    self.failed = true;
                    return Err(flacenc::error::SourceError::from_unknown());
                }
            }
        }
        // The encoder expects whole frames; drop a torn trailing frame.
        self.buffer
            .truncate((self.buffer.len() / channels) * channels);
        dest.fill_interleaved(&self.buffer)?;
        Ok(self.buffer.len() / channels)
    }
}

/// Encodes a finalized 16-bit PCM WAV into a FLAC archive copy.
pub fn compress_wav_to_flac(
    input_path: &Path,
    output_path: &Path,
) -> Result<CompressionOutcome, AppError> {
    let original_size_bytes = file_size(input_path)?;
    let mut source = WavSource::open(input_path)?;
    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|(_, error)| AppError::new("audio_compression_failed", error.to_string()))?;
    let stream = flacenc::encode_with_fixed_block_size(&config, &mut source, config.block_size)
        .map_err(|error| AppError::new("audio_compression_failed", error.to_string()))?;
    if source.failed {
        return Err(AppError::new(
            "audio_compression_failed",
            "Source WAV could not be fully read while encoding.",
        ));
    }
    let mut sink = flacenc::bitsink::ByteSink::new();
    stream
        .write(&mut sink)
        .map_err(|error| AppError::new("audio_compression_failed", error.to_string()))?;
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| AppError::new("audio_compression_failed", error.to_string()))?;
    }
    std::fs::write(output_path, sink.as_slice())
        .map_err(|error| AppError::new("audio_compression_failed", error.to_string()))?;
    let compressed_size_bytes = file_size(output_path)?;
    let compressed_checksum = crate::audio::validation::checksum_file(output_path)
        .map_err(|error| AppError::new("audio_compression_failed", error.to_string()))?;
    Ok(CompressionOutcome {
        output_path: output_path.to_path_buf(),
        format: FLAC_FORMAT.to_string(),
        original_size_bytes,
        compressed_size_bytes,
        compressed_checksum,
        duration_ms: flac_duration_ms(output_path)?,
    })
}

/// Verifies a FLAC archive decodes to exactly the samples of its WAV source.
/// FLAC is lossless, so anything short of an exact match (spec, length, every
/// sample) means the archive cannot replace the original.
pub fn validate_flac_matches_wav(flac_path: &Path, wav_path: &Path) -> Result<(), AppError> {
    let size = file_size(flac_path)?;
    if size == 0 {
        return Err(AppError::new(
            "audio_compression_invalid",
            "Compressed audio file is empty.",
        ));
    }
    let mut flac = claxon::FlacReader::open(flac_path)
        .map_err(|error| AppError::new("audio_compression_invalid", error.to_string()))?;
    let info = flac.streaminfo();
    let mut wav = WavReader::open(wav_path)
        .map_err(|error| AppError::new("audio_compression_invalid", error.to_string()))?;
    let spec = wav.spec();
    ensure_compressible_spec(spec)?;
    if info.sample_rate != spec.sample_rate
        || info.channels != spec.channels as u32
        || info.bits_per_sample != 16
    {
        return Err(AppError::new(
            "audio_compression_invalid",
            "Compressed audio format does not match the WAV source.",
        ));
    }
    let mut wav_samples = wav.samples::<i16>();
    let mut compared = 0_u64;
    let mut non_silent_preserved = false;
    for flac_sample in flac.samples() {
        let flac_sample = flac_sample
            .map_err(|error| AppError::new("audio_compression_invalid", error.to_string()))?;
        let Some(wav_sample) = wav_samples.next() else {
            return Err(AppError::new(
                "audio_compression_invalid",
                "Compressed audio is longer than the WAV source.",
            ));
        };
        let wav_sample = wav_sample
            .map_err(|error| AppError::new("audio_compression_invalid", error.to_string()))?;
        if flac_sample != wav_sample as i32 {
            return Err(AppError::new(
                "audio_compression_invalid",
                "Compressed audio does not match the WAV source signal.",
            ));
        }
        if wav_sample != 0 {
            non_silent_preserved = true;
        }
        compared += 1;
    }
    if wav_samples.next().is_some() {
        return Err(AppError::new(
            "audio_compression_invalid",
            "Compressed audio is shorter than the WAV source.",
        ));
    }
    if compared == 0 {
        return Err(AppError::new(
            "audio_compression_invalid",
            "Compressed audio contains no samples.",
        ));
    }
    // A WAV that carried signal must still carry it after compression. A
    // fully-silent source stays valid: silence compresses to silence.
    let _ = non_silent_preserved;
    Ok(())
}

/// Decodes a FLAC archive back into a 16-bit PCM WAV, used to restore the
/// processing source of truth when the original WAV was deleted by policy.
pub fn decode_flac_to_wav(flac_path: &Path, output_path: &Path) -> Result<PathBuf, AppError> {
    let mut flac = claxon::FlacReader::open(flac_path)
        .map_err(|error| AppError::new("audio_decompression_failed", error.to_string()))?;
    let info = flac.streaminfo();
    if info.bits_per_sample != 16 {
        return Err(AppError::new(
            "audio_decompression_failed",
            "Only 16-bit FLAC archives are supported.",
        ));
    }
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| AppError::new("audio_decompression_failed", error.to_string()))?;
    }
    let spec = WavSpec {
        channels: info.channels as u16,
        sample_rate: info.sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(output_path, spec)
        .map_err(|error| AppError::new("audio_decompression_failed", error.to_string()))?;
    for sample in flac.samples() {
        let sample = sample
            .map_err(|error| AppError::new("audio_decompression_failed", error.to_string()))?;
        writer
            .write_sample(sample.clamp(i16::MIN as i32, i16::MAX as i32) as i16)
            .map_err(|error| AppError::new("audio_decompression_failed", error.to_string()))?;
    }
    writer
        .finalize()
        .map_err(|error| AppError::new("audio_decompression_failed", error.to_string()))?;
    Ok(output_path.to_path_buf())
}

pub fn flac_duration_ms(flac_path: &Path) -> Result<i64, AppError> {
    let flac = claxon::FlacReader::open(flac_path)
        .map_err(|error| AppError::new("audio_compression_invalid", error.to_string()))?;
    let info = flac.streaminfo();
    let Some(samples) = info.samples else {
        return Err(AppError::new(
            "audio_compression_invalid",
            "Compressed audio does not declare its length.",
        ));
    };
    Ok(((samples as i128 * 1000) / info.sample_rate.max(1) as i128) as i64)
}

pub fn compression_ratio(original_bytes: i64, compressed_bytes: i64) -> Option<f64> {
    if original_bytes <= 0 || compressed_bytes <= 0 {
        return None;
    }
    Some(compressed_bytes as f64 / original_bytes as f64)
}

fn ensure_compressible_spec(spec: WavSpec) -> Result<(), AppError> {
    if spec.sample_format == SampleFormat::Int && spec.bits_per_sample == 16 {
        return Ok(());
    }
    Err(AppError::new(
        "audio_compression_failed",
        "Only 16-bit PCM WAV compression is supported.",
    ))
}

fn file_size(path: &Path) -> Result<i64, AppError> {
    std::fs::metadata(path)
        .map(|metadata| metadata.len() as i64)
        .map_err(|error| AppError::new("audio_compression_failed", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("os-scribe-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_wav(path: &Path, channels: u16, sample_rate: u32, samples: &[i16]) {
        let spec = WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut writer = WavWriter::create(path, spec).unwrap();
        for sample in samples {
            writer.write_sample(*sample).unwrap();
        }
        writer.finalize().unwrap();
    }

    fn speech_like_samples(frames: usize) -> Vec<i16> {
        (0..frames)
            .map(|index| {
                let phase = index as f32 / 48.0;
                ((phase * 2.0 * std::f32::consts::PI).sin() * 9_000.0) as i16
            })
            .collect()
    }

    #[test]
    fn round_trips_wav_through_flac_losslessly() {
        let dir = temp_dir("flac-roundtrip");
        let wav = dir.join("source.wav");
        let flac = dir.join("source.flac");
        let restored = dir.join("restored.wav");
        let samples = speech_like_samples(48_000);
        write_wav(&wav, 1, 48_000, &samples);

        let outcome = compress_wav_to_flac(&wav, &flac).expect("compression succeeds");
        assert_eq!(outcome.format, FLAC_FORMAT);
        assert!(outcome.compressed_size_bytes > 0);
        assert!(
            outcome.compressed_size_bytes < outcome.original_size_bytes,
            "FLAC ({}) should be smaller than WAV ({})",
            outcome.compressed_size_bytes,
            outcome.original_size_bytes
        );
        assert_eq!(outcome.duration_ms, 1_000);
        assert!(!outcome.compressed_checksum.is_empty());

        validate_flac_matches_wav(&flac, &wav).expect("lossless validation succeeds");

        decode_flac_to_wav(&flac, &restored).expect("decode succeeds");
        let mut reader = WavReader::open(&restored).unwrap();
        assert_eq!(reader.spec().sample_rate, 48_000);
        assert_eq!(reader.spec().channels, 1);
        let restored_samples = reader
            .samples::<i16>()
            .map(|sample| sample.unwrap())
            .collect::<Vec<_>>();
        assert_eq!(restored_samples, samples);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn round_trips_stereo_wav() {
        let dir = temp_dir("flac-stereo");
        let wav = dir.join("source.wav");
        let flac = dir.join("source.flac");
        let frames = speech_like_samples(8_000);
        let samples = frames
            .iter()
            .flat_map(|sample| [*sample, sample / 2])
            .collect::<Vec<_>>();
        write_wav(&wav, 2, 16_000, &samples);

        compress_wav_to_flac(&wav, &flac).expect("stereo compression succeeds");
        validate_flac_matches_wav(&flac, &wav).expect("stereo validation succeeds");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn validation_rejects_mismatched_audio() {
        let dir = temp_dir("flac-mismatch");
        let wav = dir.join("source.wav");
        let other_wav = dir.join("other.wav");
        let flac = dir.join("source.flac");
        write_wav(&wav, 1, 16_000, &speech_like_samples(4_000));
        write_wav(&other_wav, 1, 16_000, &speech_like_samples(3_000));
        compress_wav_to_flac(&wav, &flac).unwrap();

        let error = validate_flac_matches_wav(&flac, &other_wav).expect_err("must not validate");
        assert_eq!(error.code, "audio_compression_invalid");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn validation_rejects_corrupt_flac() {
        let dir = temp_dir("flac-corrupt");
        let wav = dir.join("source.wav");
        let flac = dir.join("source.flac");
        write_wav(&wav, 1, 16_000, &speech_like_samples(4_000));
        compress_wav_to_flac(&wav, &flac).unwrap();
        let mut bytes = std::fs::read(&flac).unwrap();
        let truncated = bytes.len() / 2;
        bytes.truncate(truncated);
        std::fs::write(&flac, bytes).unwrap();

        assert!(validate_flac_matches_wav(&flac, &wav).is_err());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn validation_rejects_empty_file() {
        let dir = temp_dir("flac-empty");
        let wav = dir.join("source.wav");
        let flac = dir.join("empty.flac");
        write_wav(&wav, 1, 16_000, &speech_like_samples(1_000));
        std::fs::write(&flac, []).unwrap();

        let error = validate_flac_matches_wav(&flac, &wav).expect_err("must not validate");
        assert_eq!(error.code, "audio_compression_invalid");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_non_16_bit_wav() {
        let dir = temp_dir("flac-spec");
        let wav = dir.join("source.wav");
        let spec = WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 32,
            sample_format: SampleFormat::Float,
        };
        let mut writer = WavWriter::create(&wav, spec).unwrap();
        writer.write_sample(0.25_f32).unwrap();
        writer.finalize().unwrap();

        let error =
            compress_wav_to_flac(&wav, &dir.join("out.flac")).expect_err("must reject spec");
        assert_eq!(error.code, "audio_compression_failed");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn compression_ratio_is_fraction_of_original() {
        assert_eq!(compression_ratio(1_000, 400), Some(0.4));
        assert_eq!(compression_ratio(0, 400), None);
        assert_eq!(compression_ratio(1_000, 0), None);
    }
}
