//! Wall-clock alignment and level math shared by the non-macOS system-audio
//! backends. The macOS backend (`system_macos`) offloads this to the Swift
//! helper's `writeTimelineSilenceIfNeeded` / `emitLevel`; the Windows backend
//! (`system_windows`, and a Linux backend that slots in alongside it) drive a
//! WASAPI/loopback stream from Rust and reproduce the same observable behavior
//! here. Keeping the pure math in one place lets the unit tests run on any host
//! (including the macOS CI host) instead of only on Windows.
//!
//! `allow(dead_code)` is scoped to this module because on a host whose backend
//! does not consume these helpers (e.g. macOS) they are only referenced by the
//! cross-platform tests below, which would otherwise trip `dead_code` in the
//! non-test library build.
#![allow(dead_code)]

use crate::domain::types::AudioLevelDto;
use std::{collections::VecDeque, time::Duration};

/// Matches the microphone level window in `capture.rs` (`recent_peaks` keeps the
/// most recent 24 per-callback peaks).
pub(crate) const RECENT_PEAKS_CAP: usize = 24;

/// Silence-fill tolerance in seconds. Mirrors the Swift helper's
/// `toleranceFrames = format.sampleRate * 0.08`: gaps smaller than 80 ms are
/// left for the next real buffer instead of being papered over with silence, so
/// ordinary device jitter does not fragment the file.
pub(crate) const SILENCE_TOLERANCE_SECS: f64 = 0.08;

/// Upper bound on a single silence write, mirroring the Swift helper's
/// `min(missingFrames, sampleRate / 2)` chunking so a long gap does not require
/// one huge allocation.
pub(crate) fn max_silence_chunk_frames(sample_rate: u32) -> i64 {
    (sample_rate / 2).max(1) as i64
}

/// Number of per-channel frames of tolerance before silence is inserted.
pub(crate) fn tolerance_frames(sample_rate: u32) -> i64 {
    (sample_rate as f64 * SILENCE_TOLERANCE_SECS) as i64
}

/// Active (unpaused) elapsed time the output file should represent.
///
/// Mirrors the Swift helper, where `activeStartedAt = start - timelineOffset`
/// and `activeElapsed = max(0, now - activeStartedAt - pausedOffset)`. Folding
/// `timeline_offset` in here reproduces the helper's leading-silence alignment:
/// at t=0 the expected timeline is already `timeline_offset` long, so the first
/// thing written to the file is `timeline_offset` of silence, lining the system
/// track up with a microphone track that began `timeline_offset` earlier.
pub(crate) fn active_elapsed(
    elapsed_since_start: Duration,
    timeline_offset: Duration,
    paused_offset: Duration,
) -> Duration {
    (elapsed_since_start + timeline_offset).saturating_sub(paused_offset)
}

/// Per-channel frame count the file should contain for a given active elapsed.
pub(crate) fn expected_frames(active_elapsed: Duration, sample_rate: u32) -> i64 {
    (active_elapsed.as_secs_f64() * sample_rate as f64) as i64
}

/// How many per-channel silence frames to insert before writing the next real
/// buffer. Mirrors the Swift helper: fill the whole gap once it exceeds the
/// tolerance, otherwise nothing. `incoming_frames` is the real buffer about to
/// be written (0 for a silence-only tick or the trailing stop() flush).
pub(crate) fn silence_frames_to_fill(
    expected_frames: i64,
    frames_written: i64,
    incoming_frames: i64,
    tolerance_frames: i64,
) -> i64 {
    let missing = expected_frames - frames_written - incoming_frames;
    if missing > tolerance_frames {
        missing
    } else {
        0
    }
}

/// Running audio level, computed exactly like the microphone path in
/// `capture.rs`: `peak` is the max absolute sample over the whole recording,
/// `rms` is the root-mean-square over the whole recording, and `recent_peaks`
/// is a sliding window of the most recent per-callback peaks.
#[derive(Debug, Default, Clone)]
pub(crate) struct LevelAccumulator {
    peak: f32,
    sum_square: f64,
    samples: u64,
    recent_peaks: VecDeque<f32>,
}

impl LevelAccumulator {
    /// Fold one capture callback's worth of samples into the running level.
    /// `samples` yields signed, normalized values in `[-1.0, 1.0]` (one item per
    /// interleaved sample, all channels), matching `write_input_data`.
    pub(crate) fn record_callback<I>(&mut self, samples: I)
    where
        I: IntoIterator<Item = f32>,
    {
        let mut callback_peak = 0.0_f32;
        let mut saw_sample = false;
        for sample in samples {
            saw_sample = true;
            let normalized = sample.abs();
            callback_peak = callback_peak.max(normalized);
            self.peak = self.peak.max(normalized);
            self.sum_square += (normalized as f64).powi(2);
            self.samples += 1;
        }
        if saw_sample {
            if self.recent_peaks.len() == RECENT_PEAKS_CAP {
                self.recent_peaks.pop_front();
            }
            self.recent_peaks.push_back(callback_peak);
        }
    }

    pub(crate) fn level(&self) -> AudioLevelDto {
        let rms = if self.samples == 0 {
            0.0
        } else {
            (self.sum_square / self.samples as f64).sqrt() as f32
        };
        AudioLevelDto {
            peak: self.peak,
            rms,
            recent_peaks: self.recent_peaks.iter().copied().collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_silence_when_gap_within_tolerance() {
        // 48 kHz, tolerance is 0.08 s = 3840 frames. A 1000-frame gap is left
        // for the next real buffer.
        let tol = tolerance_frames(48_000);
        assert_eq!(tol, 3840);
        assert_eq!(silence_frames_to_fill(1_000, 0, 0, tol), 0);
        assert_eq!(silence_frames_to_fill(4_840, 1_000, 0, tol), 0);
    }

    #[test]
    fn fills_whole_gap_once_past_tolerance() {
        let tol = tolerance_frames(48_000);
        // expected 48000, written 0, no incoming -> 48000 > 3840 -> fill 48000.
        assert_eq!(silence_frames_to_fill(48_000, 0, 0, tol), 48_000);
        // Incoming real frames count against the gap.
        assert_eq!(silence_frames_to_fill(48_000, 0, 5_000, tol), 43_000);
    }

    #[test]
    fn never_fills_when_already_ahead() {
        let tol = tolerance_frames(48_000);
        assert_eq!(silence_frames_to_fill(1_000, 5_000, 0, tol), 0);
        assert_eq!(silence_frames_to_fill(1_000, 0, 5_000, tol), 0);
    }

    #[test]
    fn timeline_offset_produces_leading_silence() {
        // Half a second of offset, no elapsed time yet, no pause: the file
        // should already owe ~0.5 s of silence.
        let elapsed = active_elapsed(Duration::ZERO, Duration::from_millis(500), Duration::ZERO);
        assert_eq!(elapsed, Duration::from_millis(500));
        assert_eq!(expected_frames(elapsed, 48_000), 24_000);
    }

    #[test]
    fn paused_time_is_excluded_not_filled() {
        // 10 s of wall clock, 4 s of it paused: the file should represent 6 s,
        // matching the microphone track which also drops paused audio. Paused
        // time is therefore never written as silence.
        let elapsed = active_elapsed(
            Duration::from_secs(10),
            Duration::ZERO,
            Duration::from_secs(4),
        );
        assert_eq!(elapsed, Duration::from_secs(6));
        assert_eq!(expected_frames(elapsed, 16_000), 96_000);
    }

    #[test]
    fn paused_offset_larger_than_elapsed_clamps_to_zero() {
        let elapsed = active_elapsed(
            Duration::from_secs(1),
            Duration::ZERO,
            Duration::from_secs(5),
        );
        assert_eq!(elapsed, Duration::ZERO);
        assert_eq!(expected_frames(elapsed, 48_000), 0);
    }

    #[test]
    fn max_silence_chunk_is_half_a_second() {
        assert_eq!(max_silence_chunk_frames(48_000), 24_000);
        assert_eq!(max_silence_chunk_frames(0), 1);
    }

    #[test]
    fn level_matches_microphone_windowing() {
        let mut level = LevelAccumulator::default();
        // Two callbacks; peaks 0.5 and 0.25.
        level.record_callback([0.5_f32, -0.5, 0.1]);
        level.record_callback([0.25_f32, -0.2]);
        let dto = level.level();
        assert_eq!(dto.peak, 0.5);
        assert_eq!(dto.recent_peaks, vec![0.5, 0.25]);
        // rms = sqrt((0.25+0.25+0.01+0.0625+0.04)/5)
        let expected_rms = ((0.25_f64 + 0.25 + 0.01 + 0.0625 + 0.04) / 5.0).sqrt() as f32;
        assert!((dto.rms - expected_rms).abs() < 1e-6);
    }

    #[test]
    fn level_recent_peaks_window_caps_at_24() {
        let mut level = LevelAccumulator::default();
        for index in 0..30 {
            level.record_callback([index as f32 / 100.0]);
        }
        let dto = level.level();
        assert_eq!(dto.recent_peaks.len(), RECENT_PEAKS_CAP);
        // Oldest six callbacks (0..6) have been evicted; window starts at 0.06.
        assert!((dto.recent_peaks[0] - 0.06).abs() < 1e-6);
        assert!((dto.recent_peaks[RECENT_PEAKS_CAP - 1] - 0.29).abs() < 1e-6);
    }

    #[test]
    fn empty_callback_does_not_push_a_peak() {
        let mut level = LevelAccumulator::default();
        level.record_callback(std::iter::empty::<f32>());
        let dto = level.level();
        assert_eq!(dto.peak, 0.0);
        assert_eq!(dto.rms, 0.0);
        assert!(dto.recent_peaks.is_empty());
    }
}
