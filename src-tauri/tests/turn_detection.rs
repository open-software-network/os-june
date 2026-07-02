use hound::{SampleFormat, WavSpec, WavWriter};
use os_june_lib::audio::turns::{
    coalesce_turns_for_transcription, detect_turns, split_wav_for_transcription, AudioTurn,
    DetectionSource, MAX_TRANSCRIPTION_CHUNK_MS,
};
use std::path::{Path, PathBuf};
use tempfile::tempdir;

fn write_pattern_wav(path: &Path, pattern: &[(u32, i16)]) {
    let spec = WavSpec {
        channels: 1,
        sample_rate: 1_000,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(path, spec).expect("wav writer");
    for (duration_ms, amplitude) in pattern {
        for i in 0..*duration_ms {
            let sample = if *amplitude == 0 {
                0
            } else if i % 2 == 0 {
                *amplitude
            } else {
                -*amplitude
            };
            writer.write_sample(sample).expect("sample write");
        }
    }
    writer.finalize().expect("wav finalize");
}

#[test]
fn detects_turns_from_activity_separated_by_silence() {
    let dir = tempdir().expect("tempdir");
    let mic = dir.path().join("microphone.wav");
    let system = dir.path().join("system.wav");
    write_pattern_wav(&mic, &[(500, 0), (1_200, 8_000), (2_500, 0), (900, 7_000)]);
    write_pattern_wav(&system, &[(2_100, 0), (1_000, 9_000), (1_000, 0)]);

    let turns = detect_turns(&[
        DetectionSource {
            artifact_id: "mic-artifact".to_string(),
            source: "microphone".to_string(),
            path: mic,
        },
        DetectionSource {
            artifact_id: "system-artifact".to_string(),
            source: "system".to_string(),
            path: system,
        },
    ])
    .expect("turn detection should run");

    assert_eq!(
        turns
            .iter()
            .map(|turn| turn.source.as_str())
            .collect::<Vec<_>>(),
        vec!["microphone", "system", "microphone"]
    );
    assert!(turns[0].start_ms <= 600);
    assert!(turns[1].start_ms >= 2_000);
    assert!(turns[2].start_ms >= 4_000);
}

#[test]
fn keeps_short_phrase_gaps_in_one_system_turn() {
    let dir = tempdir().expect("tempdir");
    let system = dir.path().join("system.wav");
    write_pattern_wav(
        &system,
        &[
            (1_000, 0),
            (900, 9_000),
            (900, 0),
            (800, 8_000),
            (1_100, 0),
            (900, 9_000),
            (2_500, 0),
        ],
    );

    let turns = detect_turns(&[DetectionSource {
        artifact_id: "system-artifact".to_string(),
        source: "system".to_string(),
        path: system,
    }])
    .expect("turn detection should run");

    assert_eq!(turns.len(), 1);
    assert!(turns[0].start_ms <= 1_100);
    assert!(turns[0].end_ms >= 4_400);
}

#[test]
fn coalesces_adjacent_same_source_turns_before_transcription() {
    let turns = coalesce_turns_for_transcription(vec![
        turn("microphone", 1_000, 4_000, 0),
        turn("microphone", 5_000, 7_000, 1),
        turn("system", 10_000, 13_000, 2),
    ]);

    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0].source, "microphone");
    assert_eq!(turns[0].start_ms, 1_000);
    assert_eq!(turns[0].end_ms, 7_000);
    assert_eq!(turns[0].turn_index, 0);
    assert_eq!(turns[1].source, "system");
    assert_eq!(turns[1].turn_index, 1);
}

#[test]
fn does_not_coalesce_turns_past_transcription_chunk_cap() {
    let turns = coalesce_turns_for_transcription(vec![
        turn("microphone", 0, MAX_TRANSCRIPTION_CHUNK_MS - 1_000, 0),
        turn(
            "microphone",
            MAX_TRANSCRIPTION_CHUNK_MS,
            MAX_TRANSCRIPTION_CHUNK_MS + 5_000,
            1,
        ),
    ]);

    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0].start_ms, 0);
    assert_eq!(turns[0].end_ms, MAX_TRANSCRIPTION_CHUNK_MS - 1_000);
    assert_eq!(turns[1].start_ms, MAX_TRANSCRIPTION_CHUNK_MS);
    assert_eq!(turns[1].turn_index, 1);
}

#[test]
fn keeps_same_source_turns_separate_when_another_source_intervenes() {
    let turns = coalesce_turns_for_transcription(vec![
        turn("microphone", 1_000, 4_000, 0),
        turn("system", 4_500, 6_000, 1),
        turn("microphone", 6_500, 8_000, 2),
    ]);

    assert_eq!(
        turns
            .iter()
            .map(|turn| turn.source.as_str())
            .collect::<Vec<_>>(),
        vec!["microphone", "system", "microphone"]
    );
}

#[test]
fn splits_prepared_wav_into_provider_safe_chunks() {
    let dir = tempdir().expect("tempdir");
    let input = dir.path().join("long.wav");
    let chunks_dir = dir.path().join("chunks");
    write_pattern_wav(
        &input,
        &[
            (MAX_TRANSCRIPTION_CHUNK_MS as u32, 8_000),
            (MAX_TRANSCRIPTION_CHUNK_MS as u32, 7_000),
            (5_000, 6_000),
        ],
    );

    let chunks =
        split_wav_for_transcription(&input, &chunks_dir, "turn").expect("wav should split");

    assert_eq!(chunks.len(), 3);
    for chunk in chunks.iter().take(2) {
        let reader = hound::WavReader::open(chunk).expect("chunk reader");
        assert_eq!(reader.duration(), MAX_TRANSCRIPTION_CHUNK_MS as u32);
    }
    let tail = hound::WavReader::open(chunks.last().expect("tail chunk")).expect("tail reader");
    assert_eq!(tail.duration(), 5_000);
}

fn turn(source: &str, start_ms: i64, end_ms: i64, turn_index: i64) -> AudioTurn {
    AudioTurn {
        artifact_id: format!("{source}-artifact"),
        source: source.to_string(),
        source_path: PathBuf::from(format!("{source}.wav")),
        start_ms,
        end_ms,
        turn_index,
    }
}
