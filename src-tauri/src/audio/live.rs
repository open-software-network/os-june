//! Reading in-progress (`.partial.wav`) recordings while capture is running.
//!
//! A live WAV's header still carries placeholder sizes (writers only patch
//! them on finalize), so these readers walk the RIFF chunks and size the data
//! section from the bytes actually on disk. Live turn detection and extraction
//! share the same window math as finalized-audio detection in
//! [`crate::audio::turns`], so both see the same boundaries.

use crate::audio::turns::{self, AudioTurn};
use crate::domain::types::AppError;
use hound::{SampleFormat, WavSpec, WavWriter};
use std::{
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PartialWavInfo {
    pub channels: u16,
    pub sample_rate: u32,
    pub data_offset: u64,
    /// Whole frames currently available on disk.
    pub frame_count: u64,
}

impl PartialWavInfo {
    pub fn duration_ms(&self) -> i64 {
        ((self.frame_count as i128 * 1000) / self.sample_rate.max(1) as i128) as i64
    }

    fn bytes_per_frame(&self) -> u64 {
        self.channels.max(1) as u64 * 2
    }
}

fn read_error(error: impl ToString) -> AppError {
    AppError::new("audio_live_read_failed", error.to_string())
}

/// Parses the RIFF layout of a possibly still-growing 16-bit PCM WAV. The
/// data section length is derived from the file size on disk, not from the
/// (placeholder) chunk size in the header.
pub fn read_partial_wav_info(path: &Path) -> Result<PartialWavInfo, AppError> {
    let file = File::open(path).map_err(read_error)?;
    let file_len = file.metadata().map_err(read_error)?.len();
    let mut reader = BufReader::new(file);
    let mut riff = [0_u8; 12];
    reader.read_exact(&mut riff).map_err(read_error)?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Err(read_error("Recording is not a RIFF WAVE file."));
    }

    let mut position = 12_u64;
    let mut format: Option<(u16, u32, u16)> = None;
    loop {
        let mut header = [0_u8; 8];
        if reader.read_exact(&mut header).is_err() {
            return Err(read_error("Recording has no audio data yet."));
        }
        position += 8;
        let chunk_id = &header[0..4];
        let stated_size = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as u64;
        if chunk_id == b"fmt " {
            let mut body = vec![0_u8; stated_size.min(64) as usize];
            reader.read_exact(&mut body).map_err(read_error)?;
            if body.len() < 16 {
                return Err(read_error("Recording fmt chunk is too short."));
            }
            let audio_format = u16::from_le_bytes([body[0], body[1]]);
            let channels = u16::from_le_bytes([body[2], body[3]]);
            let sample_rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
            let bits_per_sample = u16::from_le_bytes([body[14], body[15]]);
            if audio_format != 1 || bits_per_sample != 16 {
                return Err(read_error(
                    "Only 16-bit PCM recordings support live reading.",
                ));
            }
            format = Some((channels, sample_rate, bits_per_sample));
            let skip = stated_size.saturating_sub(body.len() as u64) + (stated_size & 1);
            if skip > 0 {
                reader
                    .seek(SeekFrom::Current(skip as i64))
                    .map_err(read_error)?;
            }
            position += stated_size + (stated_size & 1);
        } else if chunk_id == b"data" {
            let Some((channels, sample_rate, _bits)) = format else {
                return Err(read_error("Recording data chunk precedes fmt chunk."));
            };
            let data_offset = position;
            // The stated size is a placeholder until finalize; the bytes on
            // disk are the truth for a live file (data is the last chunk in
            // recordings we write).
            let available = file_len.saturating_sub(data_offset);
            let bytes_per_frame = channels.max(1) as u64 * 2;
            let frame_count = available / bytes_per_frame;
            return Ok(PartialWavInfo {
                channels,
                sample_rate,
                data_offset,
                frame_count,
            });
        } else {
            let skip = stated_size + (stated_size & 1);
            reader
                .seek(SeekFrom::Current(skip as i64))
                .map_err(read_error)?;
            position += skip;
        }
        if position >= file_len {
            return Err(read_error("Recording has no audio data yet."));
        }
    }
}

struct I16LeSamples<R: Read> {
    reader: R,
    remaining_bytes: u64,
}

impl<R: Read> Iterator for I16LeSamples<R> {
    type Item = i16;

    fn next(&mut self) -> Option<i16> {
        if self.remaining_bytes < 2 {
            return None;
        }
        let mut buffer = [0_u8; 2];
        self.reader.read_exact(&mut buffer).ok()?;
        self.remaining_bytes -= 2;
        Some(i16::from_le_bytes(buffer))
    }
}

fn open_samples(
    path: &Path,
    info: &PartialWavInfo,
    start_frame: u64,
    frame_count: u64,
) -> Result<I16LeSamples<BufReader<File>>, AppError> {
    let mut file = File::open(path).map_err(read_error)?;
    file.seek(SeekFrom::Start(
        info.data_offset + start_frame * info.bytes_per_frame(),
    ))
    .map_err(read_error)?;
    Ok(I16LeSamples {
        reader: BufReader::new(file),
        remaining_bytes: frame_count * info.bytes_per_frame(),
    })
}

/// RMS windows over the audio currently on disk, identical to the windows
/// finalized-audio detection computes for the same samples.
pub fn rms_windows_from_partial(path: &Path) -> Result<(PartialWavInfo, Vec<f32>), AppError> {
    let info = read_partial_wav_info(path)?;
    let samples = open_samples(path, &info, 0, info.frame_count)?;
    let windows = turns::rms_windows_from_samples(
        samples,
        info.channels.max(1) as usize,
        info.sample_rate.max(1) as usize,
    );
    Ok((info, windows))
}

/// RMS windows accumulated across live ticks so each tick only reads the
/// audio appended since the previous one, instead of re-reading the whole
/// in-progress file (which grows without bound during long meetings).
#[derive(Debug, Default)]
pub struct RmsWindowCache {
    windows: Vec<f32>,
    frames_consumed: u64,
}

/// Extends the cache with complete RMS windows from frames appended since the
/// last tick. Only whole windows are cached: the trailing partial window
/// changes as the file grows, and the live-edge padding keeps anything that
/// close to the edge out of transcription anyway.
fn extend_window_cache(
    path: &Path,
    info: &PartialWavInfo,
    cache: &mut RmsWindowCache,
) -> Result<(), AppError> {
    let channels = info.channels.max(1) as u64;
    let frames_per_window =
        ((info.sample_rate.max(1) as i64 * turns::WINDOW_MS) / 1000).max(1) as u64;
    if info.frame_count < cache.frames_consumed {
        // The file shrank (recreated source); start over from scratch.
        cache.windows.clear();
        cache.frames_consumed = 0;
    }
    let new_windows = (info.frame_count - cache.frames_consumed) / frames_per_window;
    if new_windows == 0 {
        return Ok(());
    }
    let new_frames = new_windows * frames_per_window;
    let samples = open_samples(path, info, cache.frames_consumed, new_frames)?;
    let mut windows = turns::rms_windows_from_samples(
        samples,
        channels as usize,
        info.sample_rate.max(1) as usize,
    );
    // A short read (torn tail) would yield a partial final window that the
    // next tick must recompute; keep only the complete ones.
    windows.truncate(new_windows as usize);
    cache.frames_consumed += windows.len() as u64 * frames_per_window;
    cache.windows.append(&mut windows);
    Ok(())
}

/// Detects speech turns in an in-progress source recording using the same
/// per-source thresholds as finalized detection, reading only the audio
/// appended since the previous call with the same cache. Returned turns carry
/// the partial file as their source path; `turn_index` is left at 0.
pub fn detect_partial_turns(
    artifact_id: &str,
    source: &str,
    path: &Path,
    cache: &mut RmsWindowCache,
) -> Result<(PartialWavInfo, Vec<AudioTurn>), AppError> {
    let info = read_partial_wav_info(path)?;
    extend_window_cache(path, &info, cache)?;
    let intervals =
        turns::active_intervals_from_windows(&cache.windows, turns::config_for_source(source));
    let turns = intervals
        .into_iter()
        .map(|(start_ms, end_ms)| AudioTurn {
            artifact_id: artifact_id.to_string(),
            source: source.to_string(),
            source_path: path.to_path_buf(),
            start_ms,
            end_ms,
            turn_index: 0,
        })
        .collect();
    Ok((info, turns))
}

/// Writes a finalized, valid-header WAV for a turn of an in-progress
/// recording, so the segment can be uploaded to a provider while capture is
/// still running.
pub fn extract_partial_turn_wav(
    source_path: &Path,
    start_ms: i64,
    end_ms: i64,
    output_path: &Path,
) -> Result<PathBuf, AppError> {
    let info = read_partial_wav_info(source_path)?;
    let sample_rate = info.sample_rate.max(1) as i64;
    let start_frame = ((start_ms.max(0) * sample_rate) / 1000) as u64;
    let end_frame = ((end_ms.max(start_ms) * sample_rate) / 1000) as u64;
    let start_frame = start_frame.min(info.frame_count);
    let end_frame = end_frame.min(info.frame_count);
    let samples = open_samples(source_path, &info, start_frame, end_frame - start_frame)?;
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(read_error)?;
    }
    let mut writer = WavWriter::create(
        output_path,
        WavSpec {
            channels: info.channels.max(1),
            sample_rate: info.sample_rate,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        },
    )
    .map_err(read_error)?;
    for sample in samples {
        writer.write_sample(sample).map_err(read_error)?;
    }
    writer.finalize().map_err(read_error)?;
    Ok(output_path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::WavReader;

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

    /// Simulates an in-progress recording: a valid data section but the RIFF
    /// and data chunk sizes still hold the writer's placeholder zeros.
    fn zero_header_sizes(path: &Path) {
        let mut bytes = std::fs::read(path).unwrap();
        bytes[4..8].fill(0);
        let data_pos = bytes
            .windows(4)
            .position(|window| window == b"data")
            .expect("data chunk");
        bytes[data_pos + 4..data_pos + 8].fill(0);
        std::fs::write(path, bytes).unwrap();
    }

    fn tone(frames: usize, amplitude: f32) -> Vec<i16> {
        (0..frames)
            .map(|index| {
                let phase = index as f32 / 32.0;
                ((phase * 2.0 * std::f32::consts::PI).sin() * amplitude) as i16
            })
            .collect()
    }

    #[test]
    fn reads_partial_wav_with_placeholder_sizes() {
        let dir = temp_dir("live-info");
        let path = dir.join("microphone.partial.wav");
        write_wav(&path, 2, 48_000, &tone(9_600, 9_000.0));
        zero_header_sizes(&path);

        let info = read_partial_wav_info(&path).expect("partial info");
        assert_eq!(info.channels, 2);
        assert_eq!(info.sample_rate, 48_000);
        assert_eq!(info.frame_count, 4_800);
        assert_eq!(info.duration_ms(), 100);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn partial_windows_match_finalized_windows() {
        let dir = temp_dir("live-windows");
        let finalized = dir.join("final.wav");
        let partial = dir.join("partial.wav");
        let samples = tone(48_000, 9_000.0)
            .into_iter()
            .chain(std::iter::repeat(0).take(24_000))
            .collect::<Vec<_>>();
        write_wav(&finalized, 1, 16_000, &samples);
        write_wav(&partial, 1, 16_000, &samples);
        zero_header_sizes(&partial);

        let (_, partial_windows) = rms_windows_from_partial(&partial).expect("partial windows");
        let finalized_windows = turns::rms_windows_from_samples(
            WavReader::open(&finalized)
                .unwrap()
                .samples::<i16>()
                .map(|sample| sample.unwrap()),
            1,
            16_000,
        );
        assert_eq!(partial_windows, finalized_windows);
        assert!(!partial_windows.is_empty());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn extracts_turn_segment_with_valid_header() {
        let dir = temp_dir("live-extract");
        let partial = dir.join("partial.wav");
        let samples = (0..32_000)
            .map(|index| (index % 1_000) as i16)
            .collect::<Vec<_>>();
        write_wav(&partial, 1, 16_000, &samples);
        zero_header_sizes(&partial);

        let output = dir.join("turn.wav");
        extract_partial_turn_wav(&partial, 500, 1_000, &output).expect("extract turn");

        let mut reader = WavReader::open(&output).expect("turn must have a valid header");
        assert_eq!(reader.spec().sample_rate, 16_000);
        let extracted = reader
            .samples::<i16>()
            .map(|sample| sample.unwrap())
            .collect::<Vec<_>>();
        assert_eq!(extracted.len(), 8_000);
        assert_eq!(extracted[..10], samples[8_000..8_010]);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn extraction_clamps_to_available_audio() {
        let dir = temp_dir("live-clamp");
        let partial = dir.join("partial.wav");
        write_wav(&partial, 1, 16_000, &tone(8_000, 9_000.0));
        zero_header_sizes(&partial);

        let output = dir.join("turn.wav");
        extract_partial_turn_wav(&partial, 0, 10_000, &output).expect("extract clamps");
        let reader = WavReader::open(&output).unwrap();
        assert_eq!(reader.duration(), 8_000);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn detects_turns_in_partial_audio() {
        let dir = temp_dir("live-detect");
        let partial = dir.join("partial.wav");
        // 1.5s speech, 3s silence, 1.5s speech at 16kHz.
        let mut samples = tone(24_000, 12_000.0);
        samples.extend(std::iter::repeat(0).take(48_000));
        samples.extend(tone(24_000, 12_000.0));
        write_wav(&partial, 1, 16_000, &samples);
        zero_header_sizes(&partial);

        let (info, turns) = detect_partial_turns(
            "artifact",
            "microphone",
            &partial,
            &mut RmsWindowCache::default(),
        )
        .expect("detection");
        assert_eq!(info.duration_ms(), 6_000);
        assert_eq!(turns.len(), 2, "expected two distinct turns: {turns:?}");
        assert!(turns[0].start_ms < 500);
        assert!((1_000..=2_500).contains(&turns[0].end_ms));
        assert!((4_000..=5_100).contains(&turns[1].start_ms));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cached_detection_across_ticks_matches_detection_from_scratch() {
        let dir = temp_dir("live-cache");
        let partial = dir.join("partial.wav");
        // First tick sees speech then silence; the file then grows by another
        // silence + speech stretch before the second tick.
        let first = tone(24_000, 12_000.0)
            .into_iter()
            .chain(std::iter::repeat(0).take(48_000))
            .collect::<Vec<_>>();
        let mut full = first.clone();
        full.extend(std::iter::repeat(0).take(8_000));
        full.extend(tone(24_000, 12_000.0));

        write_wav(&partial, 1, 16_000, &first);
        zero_header_sizes(&partial);
        let mut cache = RmsWindowCache::default();
        let (_, first_turns) = detect_partial_turns("artifact", "microphone", &partial, &mut cache)
            .expect("first tick");
        assert_eq!(first_turns.len(), 1);

        write_wav(&partial, 1, 16_000, &full);
        zero_header_sizes(&partial);
        let (_, cached_turns) =
            detect_partial_turns("artifact", "microphone", &partial, &mut cache)
                .expect("second tick");
        let (_, fresh_turns) = detect_partial_turns(
            "artifact",
            "microphone",
            &partial,
            &mut RmsWindowCache::default(),
        )
        .expect("from scratch");

        let ranges = |turns: &[AudioTurn]| {
            turns
                .iter()
                .map(|turn| (turn.start_ms, turn.end_ms))
                .collect::<Vec<_>>()
        };
        assert_eq!(ranges(&cached_turns), ranges(&fresh_turns));
        assert_eq!(cached_turns.len(), 2);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_non_wav_files() {
        let dir = temp_dir("live-reject");
        let path = dir.join("not-audio.partial.wav");
        std::fs::write(&path, b"definitely not a riff file").unwrap();

        assert!(read_partial_wav_info(&path).is_err());

        let _ = std::fs::remove_dir_all(dir);
    }
}
