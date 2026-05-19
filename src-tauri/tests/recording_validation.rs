use hound::{SampleFormat, WavSpec, WavWriter};
use os_notetaker_lib::audio::validation::{validate_audio_artifact, AudioValidationConfig};
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
