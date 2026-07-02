use crate::audio::capture::FinishedSource;
use crate::domain::types::AppError;
use hound::{SampleFormat, WavReader, WavWriter};
use std::path::Path;

/// Downsampled amplitude envelope used to render the trim modal's waveform.
/// `peaks` are normalized 0.0..=1.0 maxima, one per equal-width time bucket
/// across `duration_ms`. Multi-source recordings (microphone + system) are
/// merged onto a single shared wall-clock timeline so the picture matches what
/// the user heard.
pub struct WaveformPreview {
    pub duration_ms: i64,
    pub peaks: Vec<f32>,
}

/// Build the preview envelope from the finalized source WAVs. Sources keep their
/// wall-clock alignment, so every source is bucketed against the longest one's
/// timeline and merged by taking the louder of the two at each bucket.
pub fn waveform_preview(
    sources: &[FinishedSource],
    buckets: usize,
) -> Result<WaveformPreview, AppError> {
    let buckets = buckets.max(1);
    let mut timeline_ms = 0_i64;
    for source in sources {
        timeline_ms = timeline_ms.max(wav_duration_ms(&source.final_path)?);
    }
    let mut peaks = vec![0.0_f32; buckets];
    if timeline_ms > 0 {
        for source in sources {
            accumulate_peaks(&source.final_path, timeline_ms, &mut peaks)?;
        }
    }
    Ok(WaveformPreview {
        duration_ms: timeline_ms,
        peaks,
    })
}

/// Rewrite a 16-bit PCM WAV in place so it only contains the `[start_ms, end_ms]`
/// window, returning the trimmed duration in milliseconds. The new audio is
/// written to a sibling temp file first and then renamed over the original so a
/// failure mid-write never corrupts the source artifact.
pub fn trim_source_wav(path: &Path, start_ms: i64, end_ms: i64) -> Result<i64, AppError> {
    let mut reader = WavReader::open(path)
        .map_err(|error| AppError::new("audio_trim_failed", error.to_string()))?;
    let spec = reader.spec();
    if spec.sample_format != SampleFormat::Int || spec.bits_per_sample != 16 {
        return Err(AppError::new(
            "audio_trim_failed",
            "Only 16-bit PCM WAV trimming is supported.",
        ));
    }
    let channels = spec.channels.max(1) as usize;
    let sample_rate = spec.sample_rate.max(1) as i64;
    let total_frames = reader.duration() as i64;
    // saturating_mul so a garbage-large ms value clamps to the clip instead of
    // overflowing i64 (which panics under debug overflow-checks).
    let start_frame = (start_ms.max(0).saturating_mul(sample_rate) / 1000).clamp(0, total_frames);
    let end_frame =
        (end_ms.max(0).saturating_mul(sample_rate) / 1000).clamp(start_frame, total_frames);
    let frame_count = (end_frame - start_frame) as usize;
    if frame_count == 0 {
        // Degenerate window (start == end, or a start past this source's end, as
        // can happen when one source is shorter than the shared timeline). Leave
        // the file untouched rather than writing an empty WAV over it.
        return Ok((total_frames * 1000) / sample_rate);
    }
    let sample_count = frame_count.saturating_mul(channels);

    let start_frame_u32 = u32::try_from(start_frame)
        .map_err(|error| AppError::new("audio_trim_failed", error.to_string()))?;
    reader
        .seek(start_frame_u32)
        .map_err(|error| AppError::new("audio_trim_failed", error.to_string()))?;

    let temp_path = path.with_extension("trim.wav");
    let mut writer = WavWriter::create(&temp_path, spec)
        .map_err(|error| AppError::new("audio_trim_failed", error.to_string()))?;
    for sample in reader.samples::<i16>().take(sample_count) {
        writer
            .write_sample(sample.unwrap_or(0))
            .map_err(|error| AppError::new("audio_trim_failed", error.to_string()))?;
    }
    writer
        .finalize()
        .map_err(|error| AppError::new("audio_trim_failed", error.to_string()))?;
    drop(reader);
    std::fs::rename(&temp_path, path)
        .map_err(|error| AppError::new("audio_trim_failed", error.to_string()))?;

    Ok((frame_count as i64 * 1000) / sample_rate)
}

fn wav_duration_ms(path: &Path) -> Result<i64, AppError> {
    let reader = WavReader::open(path)
        .map_err(|error| AppError::new("audio_waveform_failed", error.to_string()))?;
    let sample_rate = reader.spec().sample_rate.max(1) as i64;
    let frames = reader.duration() as i64;
    Ok((frames * 1000) / sample_rate)
}

fn accumulate_peaks(path: &Path, timeline_ms: i64, peaks: &mut [f32]) -> Result<(), AppError> {
    let buckets = peaks.len().max(1);
    let mut reader = WavReader::open(path)
        .map_err(|error| AppError::new("audio_waveform_failed", error.to_string()))?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    let sample_rate = spec.sample_rate.max(1) as i64;
    // Frames spanning the *shared* timeline, so bucket index maps to absolute
    // wall-clock time even when sources differ in sample rate or length.
    let timeline_frames = ((timeline_ms * sample_rate) / 1000).max(1);

    let mut frame_index: i64 = 0;
    let mut channel: usize = 0;
    let mut frame_peak = 0.0_f32;
    for sample in reader.samples::<i16>() {
        let sample = sample.unwrap_or(0);
        let normalized = crate::audio::waveform::normalize_peak(sample);
        frame_peak = frame_peak.max(normalized);
        channel += 1;
        if channel >= channels {
            let bucket = ((frame_index * buckets as i64) / timeline_frames) as usize;
            if let Some(slot) = peaks.get_mut(bucket.min(buckets - 1)) {
                *slot = slot.max(frame_peak);
            }
            channel = 0;
            frame_peak = 0.0;
            frame_index += 1;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::WavSpec;

    fn write_wav(path: &Path, sample_rate: u32, channels: u16, samples: &[i16]) {
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

    fn read_samples(path: &Path) -> Vec<i16> {
        WavReader::open(path)
            .unwrap()
            .samples::<i16>()
            .map(|sample| sample.unwrap())
            .collect()
    }

    #[test]
    fn trims_to_the_selected_window() {
        let dir = std::env::temp_dir().join(format!("june-trim-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("microphone.wav");
        // 1000 mono frames at 1kHz == 1000ms; ramp so we can spot the window.
        let samples: Vec<i16> = (0..1000).map(|i| i as i16).collect();
        write_wav(&path, 1000, 1, &samples);

        let duration = trim_source_wav(&path, 200, 700).unwrap();
        assert_eq!(duration, 500);
        let trimmed = read_samples(&path);
        assert_eq!(trimmed.len(), 500);
        assert_eq!(trimmed.first().copied(), Some(200));
        assert_eq!(trimmed.last().copied(), Some(699));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn degenerate_window_leaves_the_source_untouched() {
        let dir = std::env::temp_dir().join(format!("june-trim0-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("microphone.wav");
        let samples: Vec<i16> = (0..1000).map(|i| i as i16).collect();
        write_wav(&path, 1000, 1, &samples);

        // A start at/after the source end yields a zero-frame window: keep the
        // full clip rather than writing an empty WAV over it.
        let duration = trim_source_wav(&path, 1000, 1000).unwrap();
        assert_eq!(duration, 1000);
        assert_eq!(read_samples(&path).len(), 1000);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn waveform_preview_buckets_match_timeline() {
        let dir = std::env::temp_dir().join(format!("june-wave-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("microphone.wav");
        // First half loud, second half silent.
        let mut samples = vec![i16::MAX; 500];
        samples.resize(1000, 0);
        write_wav(&path, 1000, 1, &samples);

        let source = FinishedSource {
            source: crate::domain::types::RecordingSource::Microphone,
            final_path: path.clone(),
            elapsed_ms: 1000,
        };
        let preview = waveform_preview(std::slice::from_ref(&source), 10).unwrap();
        assert_eq!(preview.duration_ms, 1000);
        assert_eq!(preview.peaks.len(), 10);
        assert!(preview.peaks[0] > 0.9, "loud first half");
        assert!(preview.peaks[9] < 0.1, "silent second half");
        std::fs::remove_dir_all(&dir).ok();
    }
}
