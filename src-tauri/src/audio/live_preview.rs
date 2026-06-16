use crate::{
    domain::types::{RecordingSource, RecordingSourceMode},
    scribe_api::{transcribe_saved_audio, TranscriptionRequest},
};
use hound::{SampleFormat, WavSpec, WavWriter};
use serde::Serialize;
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use uuid::Uuid;

pub const LIVE_TRANSCRIPT_EVENT: &str = "live-transcript-event";

const PREVIEW_BATCH_BUFFER: usize = 512;
const PREVIEW_CHUNK_MS: i64 = 8_000;
const PREVIEW_CONTEXT_TURNS: usize = 3;
const PREVIEW_SILENCE_RMS_FLOOR: f32 = 0.012;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTranscriptEventDto {
    pub note_id: String,
    pub session_id: String,
    pub source_mode: RecordingSourceMode,
    pub source: RecordingSource,
    pub segment_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub language: Option<String>,
    pub stability: &'static str,
}

#[derive(Debug)]
struct LivePreviewBatch {
    samples: Vec<i16>,
}

#[derive(Clone)]
pub struct LivePreviewSink {
    sender: mpsc::Sender<LivePreviewBatch>,
}

impl LivePreviewSink {
    pub fn try_send(&self, samples: Vec<i16>) -> bool {
        if samples.is_empty() {
            return false;
        }
        self.sender.try_send(LivePreviewBatch { samples }).is_ok()
    }
}

pub struct LivePreviewController {
    cancelled: Arc<AtomicBool>,
    sink: LivePreviewSink,
}

impl LivePreviewController {
    pub fn sink(&self) -> LivePreviewSink {
        self.sink.clone()
    }

    pub fn cancel(self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

impl Drop for LivePreviewController {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

pub fn start_live_transcript_preview(
    app: AppHandle,
    note_id: String,
    session_id: String,
    source_mode: RecordingSourceMode,
    sample_rate: u32,
    channels: u16,
) -> LivePreviewController {
    let (sender, receiver) = mpsc::channel(PREVIEW_BATCH_BUFFER);
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    tauri::async_runtime::spawn(async move {
        run_live_preview_worker(
            app,
            note_id,
            session_id,
            source_mode,
            sample_rate.max(1),
            channels.max(1),
            receiver,
            worker_cancelled,
        )
        .await;
    });
    LivePreviewController {
        cancelled,
        sink: LivePreviewSink { sender },
    }
}

async fn run_live_preview_worker(
    app: AppHandle,
    note_id: String,
    session_id: String,
    source_mode: RecordingSourceMode,
    sample_rate: u32,
    channels: u16,
    mut receiver: mpsc::Receiver<LivePreviewBatch>,
    cancelled: Arc<AtomicBool>,
) {
    let chunk_samples = samples_for_ms(sample_rate, channels, PREVIEW_CHUNK_MS);
    if chunk_samples == 0 {
        return;
    }
    let mut buffer: Vec<i16> = Vec::with_capacity(chunk_samples * 2);
    let mut recent_preview_text = VecDeque::with_capacity(PREVIEW_CONTEXT_TURNS);
    let mut next_start_ms = 0_i64;
    let mut segment_index = 0_i64;

    while let Some(batch) = receiver.recv().await {
        if cancelled.load(Ordering::Acquire) {
            return;
        }
        buffer.extend(batch.samples);
        while buffer.len() >= chunk_samples {
            let samples = buffer.drain(..chunk_samples).collect::<Vec<_>>();
            let start_ms = next_start_ms;
            let duration_ms = duration_ms(samples.len(), sample_rate, channels);
            let end_ms = start_ms + duration_ms;
            next_start_ms = end_ms;
            if is_effectively_silent(&samples) {
                segment_index += 1;
                continue;
            }
            let segment_id = format!("microphone-{segment_index}");
            let context = preview_context(&recent_preview_text);
            if let Some(event) = transcribe_preview_chunk(
                &note_id,
                &session_id,
                source_mode,
                &segment_id,
                start_ms,
                end_ms,
                sample_rate,
                channels,
                &samples,
                context,
            )
            .await
            {
                if cancelled.load(Ordering::Acquire) {
                    return;
                }
                remember_preview_text(&mut recent_preview_text, &event.text);
                let _ = app.emit(LIVE_TRANSCRIPT_EVENT, event);
            }
            segment_index += 1;
        }
    }
}

async fn transcribe_preview_chunk(
    note_id: &str,
    session_id: &str,
    source_mode: RecordingSourceMode,
    segment_id: &str,
    start_ms: i64,
    end_ms: i64,
    sample_rate: u32,
    channels: u16,
    samples: &[i16],
    context: Option<String>,
) -> Option<LiveTranscriptEventDto> {
    let temp_path = preview_chunk_path(session_id, segment_id);
    if let Err(error) = write_preview_wav(&temp_path, sample_rate, channels, samples) {
        let _ = std::fs::remove_file(&temp_path);
        eprintln!("live transcript preview failed to write chunk: {error}");
        return None;
    }

    let request = TranscriptionRequest {
        provider: crate::providers::configured_transcription_provider(),
        audio_path: temp_path.clone(),
        title: "Live transcript preview".to_string(),
        context,
        language: crate::dictation::configured_transcription_language(),
        operation_id: Some(format!("live-preview-{session_id}-{segment_id}")),
        preview: true,
    };
    let result = transcribe_saved_audio(request).await;
    let _ = std::fs::remove_file(&temp_path);
    match result {
        Ok(transcript) => {
            let text = transcript.text.trim().to_string();
            if text.is_empty() {
                return None;
            }
            Some(LiveTranscriptEventDto {
                note_id: note_id.to_string(),
                session_id: session_id.to_string(),
                source_mode,
                source: RecordingSource::Microphone,
                segment_id: segment_id.to_string(),
                start_ms,
                end_ms,
                text,
                language: transcript.language,
                stability: "final",
            })
        }
        Err(error) => {
            eprintln!(
                "live transcript preview transcription failed: {} ({})",
                error.message, error.code
            );
            None
        }
    }
}

fn preview_chunk_path(session_id: &str, segment_id: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "os-scribe-live-preview-{}-{}-{}.wav",
        session_id,
        segment_id,
        Uuid::new_v4()
    ))
}

fn write_preview_wav(
    path: &Path,
    sample_rate: u32,
    channels: u16,
    samples: &[i16],
) -> Result<(), hound::Error> {
    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(path, spec)?;
    for sample in samples {
        writer.write_sample(*sample)?;
    }
    writer.finalize()
}

fn samples_for_ms(sample_rate: u32, channels: u16, duration_ms: i64) -> usize {
    ((u64::from(sample_rate) * u64::from(channels) * duration_ms.max(0) as u64) / 1000) as usize
}

fn duration_ms(sample_count: usize, sample_rate: u32, channels: u16) -> i64 {
    let frames = sample_count as u64 / u64::from(channels.max(1));
    ((frames * 1000) / u64::from(sample_rate.max(1))) as i64
}

fn is_effectively_silent(samples: &[i16]) -> bool {
    if samples.is_empty() {
        return true;
    }
    let sum_square = samples
        .iter()
        .map(|sample| {
            let normalized = *sample as f64 / i16::MAX as f64;
            normalized * normalized
        })
        .sum::<f64>();
    let rms = (sum_square / samples.len() as f64).sqrt() as f32;
    rms < PREVIEW_SILENCE_RMS_FLOOR
}

fn preview_context(recent_preview_text: &VecDeque<String>) -> Option<String> {
    let text = recent_preview_text
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        None
    } else {
        Some(format!(
            "Previous live transcript preview segments:\n{text}\n\nUse this only as context. Do not repeat it."
        ))
    }
}

fn remember_preview_text(recent_preview_text: &mut VecDeque<String>, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    recent_preview_text.push_back(text.to_string());
    while recent_preview_text.len() > PREVIEW_CONTEXT_TURNS {
        recent_preview_text.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        duration_ms, is_effectively_silent, preview_context, remember_preview_text, samples_for_ms,
        LivePreviewSink,
    };
    use std::collections::VecDeque;
    use tokio::sync::mpsc;

    #[test]
    fn computes_chunk_sample_counts_for_interleaved_audio() {
        assert_eq!(samples_for_ms(16_000, 1, 8_000), 128_000);
        assert_eq!(samples_for_ms(48_000, 2, 1_000), 96_000);
        assert_eq!(duration_ms(96_000, 48_000, 2), 1_000);
    }

    #[test]
    fn silence_gate_skips_quiet_preview_chunks() {
        assert!(is_effectively_silent(&[0; 128]));
        assert!(!is_effectively_silent(&[2_000; 128]));
    }

    #[test]
    fn preview_sink_drops_batches_when_buffer_is_full() {
        let (sender, _receiver) = mpsc::channel(1);
        let sink = LivePreviewSink { sender };

        assert!(sink.try_send(vec![1]));
        assert!(!sink.try_send(vec![2]));
    }

    #[test]
    fn preview_context_keeps_recent_nonempty_segments() {
        let mut recent = VecDeque::new();

        remember_preview_text(&mut recent, " first ");
        remember_preview_text(&mut recent, "");
        remember_preview_text(&mut recent, "second");
        remember_preview_text(&mut recent, "third");
        remember_preview_text(&mut recent, "fourth");

        let context = preview_context(&recent).expect("context");
        assert!(!context.contains("first"));
        assert!(context.contains("second\nthird\nfourth"));
        assert!(context.contains("Do not repeat it."));
    }
}
