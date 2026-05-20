use hound::{SampleFormat, WavSpec, WavWriter};
use os_notetaker_lib::{
    audio::validation::{
        source_audio_passes_validation, validate_audio_artifact, AudioValidationConfig,
    },
    domain::types::RecordingSource,
};
use std::path::Path;
use tempfile::tempdir;

fn write_wav(path: &Path, amplitude: i16, duration_ms: u32) {
    let spec = WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(path, spec).expect("wav writer");
    let samples = (spec.sample_rate as f32 * (duration_ms as f32 / 1000.0)) as usize;
    for i in 0..samples {
        let sample = if amplitude == 0 {
            0
        } else if i % 2 == 0 {
            amplitude
        } else {
            -amplitude
        };
        writer.write_sample(sample).expect("sample write");
    }
    writer.finalize().expect("wav finalize");
}

fn write_stereo_wav(path: &Path, amplitude: i16, duration_ms: u32) {
    let spec = WavSpec {
        channels: 2,
        sample_rate: 48_000,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(path, spec).expect("wav writer");
    let frames = (spec.sample_rate as f32 * (duration_ms as f32 / 1000.0)) as usize;
    for i in 0..frames {
        let sample = if i % 2 == 0 { amplitude } else { -amplitude };
        writer.write_sample(sample).expect("left sample write");
        writer.write_sample(sample).expect("right sample write");
    }
    writer.finalize().expect("wav finalize");
}

fn write_impulse_wav(path: &Path, impulse_amplitude: i16, duration_ms: u32) {
    let spec = WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(path, spec).expect("wav writer");
    let samples = (spec.sample_rate as f32 * (duration_ms as f32 / 1000.0)) as usize;
    for i in 0..samples {
        let sample = if i == 20 { impulse_amplitude } else { 0 };
        writer.write_sample(sample).expect("sample write");
    }
    writer.finalize().expect("wav finalize");
}

#[test]
fn accepts_readable_non_silent_wav_with_expected_duration() {
    let dir = tempdir().expect("tempdir");
    let path = dir.path().join("speech.wav");
    write_wav(&path, 6_000, 1_500);

    let result = validate_audio_artifact(&path, 1_500, AudioValidationConfig::default())
        .expect("validation should run");

    assert!(result.file_exists);
    assert!(result.non_zero_size);
    assert!(result.readable_audio);
    assert!(result.duration_within_tolerance);
    assert!(result.non_silent_signal);
    assert!(result.peak_amplitude > 0.1);
}

#[test]
fn accepts_stereo_wav_with_expected_duration() {
    let dir = tempdir().expect("tempdir");
    let path = dir.path().join("stereo-system.wav");
    write_stereo_wav(&path, 6_000, 2_000);

    let result = validate_audio_artifact(&path, 2_000, AudioValidationConfig::default())
        .expect("validation should run");

    assert_eq!(result.actual_duration_ms, 2_000);
    assert!(result.duration_within_tolerance);
    assert!(result.non_silent_signal);
}

#[test]
fn accepts_shorter_non_silent_system_audio() {
    let dir = tempdir().expect("tempdir");
    let path = dir.path().join("short-system.wav");
    write_stereo_wav(&path, 6_000, 2_000);

    let result = validate_audio_artifact(&path, 4_000, AudioValidationConfig::default())
        .expect("validation should run");

    assert!(!result.duration_within_tolerance);
    assert!(result.non_silent_signal);
    assert!(source_audio_passes_validation(
        RecordingSource::System,
        &result
    ));
    assert!(!source_audio_passes_validation(
        RecordingSource::Microphone,
        &result
    ));
}

#[test]
fn rejects_zero_byte_file() {
    let dir = tempdir().expect("tempdir");
    let path = dir.path().join("empty.wav");
    std::fs::write(&path, []).expect("write empty");

    let result = validate_audio_artifact(&path, 1_000, AudioValidationConfig::default())
        .expect("validation should return structured result");

    assert!(result.file_exists);
    assert!(!result.non_zero_size);
    assert!(!result.readable_audio);
    assert!(!result.non_silent_signal);
}

#[test]
fn flags_duration_mismatch() {
    let dir = tempdir().expect("tempdir");
    let path = dir.path().join("short.wav");
    write_wav(&path, 6_000, 400);

    let result = validate_audio_artifact(&path, 2_000, AudioValidationConfig::default())
        .expect("validation should run");

    assert!(result.readable_audio);
    assert!(!result.duration_within_tolerance);
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("duration")));
}

#[test]
fn rejects_silent_audio() {
    let dir = tempdir().expect("tempdir");
    let path = dir.path().join("silent.wav");
    write_wav(&path, 0, 1_500);

    let result = validate_audio_artifact(&path, 1_500, AudioValidationConfig::default())
        .expect("validation should run");

    assert!(result.readable_audio);
    assert!(!result.non_silent_signal);
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("silent")));
}

#[test]
fn rejects_isolated_peak_without_sustained_signal() {
    let dir = tempdir().expect("tempdir");
    let path = dir.path().join("single-click.wav");
    write_impulse_wav(&path, i16::MAX, 1_500);

    let result = validate_audio_artifact(&path, 1_500, AudioValidationConfig::default())
        .expect("validation should run");

    assert!(result.readable_audio);
    assert!(result.peak_amplitude > 0.9);
    assert!(result.rms_amplitude < AudioValidationConfig::default().silence_rms_threshold);
    assert!(!result.non_silent_signal);
    assert!(result
        .warnings
        .iter()
        .any(|warning| warning.contains("silent")));
}
