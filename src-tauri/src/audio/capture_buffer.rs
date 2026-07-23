use crate::audio::live_preview::LivePreviewSink;
use hound::WavWriter;
use std::{
    cell::UnsafeCell,
    fs::File,
    io::BufWriter,
    mem::MaybeUninit,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const AUDIO_BLOCK_SAMPLES: usize = 2_048;
const AUDIO_BUFFER_SECONDS: usize = 30;
const MAX_AUDIO_BUFFER_BLOCKS: usize = 16_384;
const RECENT_PEAK_CAPACITY: usize = 24;
const WRITER_IDLE_POLL_INTERVAL: Duration = Duration::from_millis(1);
const RECOVERY_FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
struct AudioBlock {
    samples: [i16; AUDIO_BLOCK_SAMPLES],
    len: usize,
    ends_callback: bool,
}

impl AudioBlock {
    fn empty() -> Self {
        Self {
            samples: [0; AUDIO_BLOCK_SAMPLES],
            len: 0,
            ends_callback: false,
        }
    }
}

struct AudioSlot {
    sequence: AtomicU64,
    value: UnsafeCell<MaybeUninit<AudioBlock>>,
}

// A slot is accessed only after its sequence number transfers ownership
// between the producer and consumer.
unsafe impl Sync for AudioSlot {}

/// Preallocated, bounded audio handoff. The CPAL callback is the only producer
/// and the WAV task is the only ordinary consumer. When full, the producer may
/// claim and discard the oldest unread block before publishing the newest one.
struct AudioRing {
    slots: Box<[AudioSlot]>,
    capacity: u64,
    enqueue_position: AtomicU64,
    dequeue_position: AtomicU64,
    dropped_samples: AtomicU64,
}

impl AudioRing {
    fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "audio ring capacity must be non-zero");
        let slots = (0..capacity)
            .map(|sequence| AudioSlot {
                sequence: AtomicU64::new(sequence as u64),
                value: UnsafeCell::new(MaybeUninit::uninit()),
            })
            .collect::<Vec<_>>()
            .into_boxed_slice();
        Self {
            slots,
            capacity: capacity as u64,
            enqueue_position: AtomicU64::new(0),
            dequeue_position: AtomicU64::new(0),
            dropped_samples: AtomicU64::new(0),
        }
    }

    fn push_overwrite(&self, block: AudioBlock) {
        let enqueue_position = self.enqueue_position.load(Ordering::Relaxed);
        let mut block = Some(block);
        if self.try_push_at(enqueue_position, &mut block) {
            return;
        }

        // Prefer the oldest queued audio. If the writer has already claimed
        // that slot, do not spin or discard a second block: drop the incoming
        // block instead and leave the real-time callback bounded.
        if let Some(dropped) = self.try_discard_oldest_at(enqueue_position) {
            self.dropped_samples
                .fetch_add(dropped as u64, Ordering::Relaxed);
            if !self.try_push_at(enqueue_position, &mut block) {
                self.dropped_samples.fetch_add(
                    block.as_ref().map_or(0, |block| block.len as u64),
                    Ordering::Relaxed,
                );
            }
        } else {
            self.dropped_samples.fetch_add(
                block.as_ref().map_or(0, |block| block.len as u64),
                Ordering::Relaxed,
            );
        }
    }

    fn try_push_at(&self, position: u64, block: &mut Option<AudioBlock>) -> bool {
        let slot = &self.slots[(position % self.capacity) as usize];
        if slot.sequence.load(Ordering::Acquire) != position {
            return false;
        }
        // There is one producer, so publishing the next enqueue position does
        // not need a compare-exchange.
        self.enqueue_position
            .store(position.wrapping_add(1), Ordering::Relaxed);
        unsafe {
            (*slot.value.get()).write(block.take().expect("audio block is available"));
        }
        slot.sequence
            .store(position.wrapping_add(1), Ordering::Release);
        true
    }

    fn try_discard_oldest_at(&self, blocked_enqueue_position: u64) -> Option<usize> {
        let expected_dequeue = blocked_enqueue_position.wrapping_sub(self.capacity);
        if self.dequeue_position.load(Ordering::Acquire) != expected_dequeue {
            return None;
        }
        let slot = &self.slots[(expected_dequeue % self.capacity) as usize];
        if slot.sequence.load(Ordering::Acquire) != expected_dequeue.wrapping_add(1) {
            return None;
        }
        if self
            .dequeue_position
            .compare_exchange(
                expected_dequeue,
                expected_dequeue.wrapping_add(1),
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
        {
            return None;
        }
        let block = unsafe { (*slot.value.get()).assume_init_read() };
        slot.sequence.store(
            expected_dequeue.wrapping_add(self.capacity),
            Ordering::Release,
        );
        Some(block.len)
    }

    fn pop(&self) -> Option<AudioBlock> {
        loop {
            let position = self.dequeue_position.load(Ordering::Relaxed);
            let slot = &self.slots[(position % self.capacity) as usize];
            if slot.sequence.load(Ordering::Acquire) != position.wrapping_add(1) {
                return None;
            }
            if self
                .dequeue_position
                .compare_exchange(
                    position,
                    position.wrapping_add(1),
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_err()
            {
                continue;
            }
            let block = unsafe { (*slot.value.get()).assume_init_read() };
            slot.sequence
                .store(position.wrapping_add(self.capacity), Ordering::Release);
            return Some(block);
        }
    }

    fn write_position(&self) -> u64 {
        self.enqueue_position.load(Ordering::Acquire)
    }

    fn read_position(&self) -> u64 {
        self.dequeue_position.load(Ordering::Acquire)
    }

    fn dropped_samples(&self) -> u64 {
        self.dropped_samples.load(Ordering::Acquire)
    }
}

struct AtomicCaptureStats {
    peak_bits: AtomicU32,
    sum_square_bits: AtomicU64,
    samples: AtomicU64,
    callback_heartbeat: AtomicU64,
    completed_callback: AtomicU64,
    monitored_callback: AtomicU64,
    recent_peak_count: AtomicU64,
    recent_peaks: [AtomicU32; RECENT_PEAK_CAPACITY],
}

impl Default for AtomicCaptureStats {
    fn default() -> Self {
        Self {
            peak_bits: AtomicU32::new(0),
            sum_square_bits: AtomicU64::new(0.0_f64.to_bits()),
            samples: AtomicU64::new(0),
            callback_heartbeat: AtomicU64::new(0),
            completed_callback: AtomicU64::new(0),
            monitored_callback: AtomicU64::new(0),
            recent_peak_count: AtomicU64::new(0),
            recent_peaks: std::array::from_fn(|_| AtomicU32::new(0)),
        }
    }
}

impl AtomicCaptureStats {
    fn record_callback(&self, peak: f32, sum_square: f64, samples: u64) {
        self.peak_bits.fetch_max(peak.to_bits(), Ordering::Relaxed);
        let previous_sum = f64::from_bits(self.sum_square_bits.load(Ordering::Relaxed));
        self.sum_square_bits
            .store((previous_sum + sum_square).to_bits(), Ordering::Relaxed);
        self.samples.fetch_add(samples, Ordering::Relaxed);

        let callback_index = self.recent_peak_count.load(Ordering::Relaxed);
        self.recent_peaks[(callback_index % RECENT_PEAK_CAPACITY as u64) as usize]
            .store(peak.to_bits(), Ordering::Relaxed);
        self.recent_peak_count
            .store(callback_index.wrapping_add(1), Ordering::Release);
    }

    fn snapshot(&self, dropped_samples: u64) -> CaptureStatsSnapshot {
        let samples = self.samples.load(Ordering::Acquire);
        let sum_square = f64::from_bits(self.sum_square_bits.load(Ordering::Acquire));
        let recent_peak_count = self.recent_peak_count.load(Ordering::Acquire);
        let recent_len = recent_peak_count.min(RECENT_PEAK_CAPACITY as u64);
        let recent_start = recent_peak_count.wrapping_sub(recent_len);
        let recent_peaks = (recent_start..recent_peak_count)
            .map(|index| {
                f32::from_bits(
                    self.recent_peaks[(index % RECENT_PEAK_CAPACITY as u64) as usize]
                        .load(Ordering::Acquire),
                )
            })
            .collect();
        CaptureStatsSnapshot {
            peak: f32::from_bits(self.peak_bits.load(Ordering::Acquire)),
            rms: if samples == 0 {
                0.0
            } else {
                (sum_square / samples as f64).sqrt() as f32
            },
            samples,
            recent_peaks,
            dropped_samples,
        }
    }
}

#[derive(Debug)]
pub struct CaptureStatsSnapshot {
    pub peak: f32,
    pub rms: f32,
    pub samples: u64,
    pub recent_peaks: Vec<f32>,
    pub dropped_samples: u64,
}

#[derive(Clone)]
pub struct CaptureInput {
    ring: Arc<AudioRing>,
    stats: Arc<AtomicCaptureStats>,
}

impl CaptureInput {
    /// Converts and publishes one CPAL callback without allocation, locking, or
    /// I/O. The iterator itself must likewise be allocation-free.
    pub fn write<I>(&self, data: I, paused: &AtomicBool, mic_ducked: &AtomicBool)
    where
        I: Iterator<Item = f32>,
    {
        let callback = self
            .stats
            .callback_heartbeat
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
        if paused.load(Ordering::Acquire) {
            self.stats
                .completed_callback
                .store(callback, Ordering::Release);
            return;
        }

        let ducked = mic_ducked.load(Ordering::Acquire);
        let mut block = AudioBlock::empty();
        let mut callback_peak = 0.0_f32;
        let mut callback_sum_square = 0.0_f64;
        let mut callback_samples = 0_u64;
        for sample in data {
            if block.len == AUDIO_BLOCK_SAMPLES {
                self.ring.push_overwrite(block);
                block = AudioBlock::empty();
            }
            let clamped = if ducked { 0.0 } else { sample.clamp(-1.0, 1.0) };
            let pcm_sample = (clamped * i16::MAX as f32) as i16;
            let normalized = clamped.abs();
            callback_peak = callback_peak.max(normalized);
            callback_sum_square += (normalized as f64).powi(2);
            callback_samples = callback_samples.saturating_add(1);
            block.samples[block.len] = pcm_sample;
            block.len += 1;
        }
        if block.len == 0 {
            self.stats
                .completed_callback
                .store(callback, Ordering::Release);
            return;
        }
        block.ends_callback = true;
        self.ring.push_overwrite(block);
        self.stats
            .record_callback(callback_peak, callback_sum_square, callback_samples);
        self.stats
            .completed_callback
            .store(callback, Ordering::Release);
    }

    #[cfg(test)]
    pub fn stats(&self) -> CaptureStatsSnapshot {
        self.stats.snapshot(self.ring.dropped_samples())
    }
}

struct WriterControl {
    stop_requested: AtomicBool,
    flush_generation: AtomicU64,
    flush_target: AtomicU64,
    flushed_generation: AtomicU64,
    worker_finished: AtomicBool,
    flush_wait: Mutex<()>,
    flush_changed: Condvar,
}

impl Default for WriterControl {
    fn default() -> Self {
        Self {
            stop_requested: AtomicBool::new(false),
            flush_generation: AtomicU64::new(0),
            flush_target: AtomicU64::new(0),
            flushed_generation: AtomicU64::new(0),
            worker_finished: AtomicBool::new(false),
            flush_wait: Mutex::new(()),
            flush_changed: Condvar::new(),
        }
    }
}

pub struct MicrophoneWriter {
    ring: Arc<AudioRing>,
    stats: Arc<AtomicCaptureStats>,
    control: Arc<WriterControl>,
    worker: Option<JoinHandle<Result<(), String>>>,
}

impl MicrophoneWriter {
    pub fn start(
        writer: WavWriter<BufWriter<File>>,
        sample_rate: u32,
        channels: u16,
        preview: Option<LivePreviewSink>,
        last_callback_at: Arc<Mutex<Option<Instant>>>,
    ) -> Result<(CaptureInput, Self), String> {
        let samples_per_second = (sample_rate as usize).saturating_mul(channels as usize);
        let capacity = samples_per_second
            .saturating_mul(AUDIO_BUFFER_SECONDS)
            .div_ceil(AUDIO_BLOCK_SAMPLES)
            .clamp(8, MAX_AUDIO_BUFFER_BLOCKS);
        Self::start_with_capacity(writer, capacity, preview, last_callback_at)
    }

    fn start_with_capacity(
        writer: WavWriter<BufWriter<File>>,
        capacity: usize,
        preview: Option<LivePreviewSink>,
        last_callback_at: Arc<Mutex<Option<Instant>>>,
    ) -> Result<(CaptureInput, Self), String> {
        let ring = Arc::new(AudioRing::new(capacity));
        let stats = Arc::new(AtomicCaptureStats::default());
        let control = Arc::new(WriterControl::default());
        let worker_ring = Arc::clone(&ring);
        let worker_stats = Arc::clone(&stats);
        let worker_control = Arc::clone(&control);
        let worker = thread::Builder::new()
            .name("microphone-wav-writer".to_string())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    drain_audio(
                        writer,
                        &worker_ring,
                        &worker_stats,
                        &worker_control,
                        preview,
                        &last_callback_at,
                    )
                }))
                .unwrap_or_else(|_| Err("Microphone WAV writer task panicked.".to_string()));
                worker_control
                    .worker_finished
                    .store(true, Ordering::Release);
                worker_control.flush_changed.notify_all();
                result
            })
            .map_err(|error| error.to_string())?;
        let input = CaptureInput {
            ring: Arc::clone(&ring),
            stats: Arc::clone(&stats),
        };
        Ok((
            input,
            Self {
                ring,
                stats,
                control,
                worker: Some(worker),
            },
        ))
    }

    pub fn stats(&self) -> CaptureStatsSnapshot {
        self.stats.snapshot(self.ring.dropped_samples())
    }

    pub fn has_unobserved_callback(&self) -> bool {
        self.stats.callback_heartbeat.load(Ordering::Acquire)
            != self.stats.monitored_callback.load(Ordering::Acquire)
    }

    /// Flushes every block published before this call. The callback continues
    /// publishing newer audio while the non-real-time caller waits.
    pub fn flush_for_recovery(&self) {
        let callback = self.stats.callback_heartbeat.load(Ordering::Acquire);
        let wait_started = Instant::now();
        while self.stats.completed_callback.load(Ordering::Acquire) < callback
            && wait_started.elapsed() < RECOVERY_FLUSH_TIMEOUT
        {
            thread::sleep(WRITER_IDLE_POLL_INTERVAL);
        }
        let target = self.ring.write_position();
        self.control.flush_target.store(target, Ordering::Release);
        let generation = self
            .control
            .flush_generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
        let Ok(guard) = self.control.flush_wait.lock() else {
            return;
        };
        let _ =
            self.control
                .flush_changed
                .wait_timeout_while(guard, RECOVERY_FLUSH_TIMEOUT, |_| {
                    self.control.flushed_generation.load(Ordering::Acquire) < generation
                        && !self.control.worker_finished.load(Ordering::Acquire)
                });
    }

    pub fn finish(mut self) -> Result<(), String> {
        self.control.stop_requested.store(true, Ordering::Release);
        self.join_worker()
    }

    fn join_worker(&mut self) -> Result<(), String> {
        let Some(worker) = self.worker.take() else {
            return Ok(());
        };
        worker
            .join()
            .map_err(|_| "Microphone WAV writer task panicked.".to_string())?
    }
}

impl Drop for MicrophoneWriter {
    fn drop(&mut self) {
        self.control.stop_requested.store(true, Ordering::Release);
        let _ = self.join_worker();
    }
}

fn drain_audio(
    mut writer: WavWriter<BufWriter<File>>,
    ring: &AudioRing,
    stats: &AtomicCaptureStats,
    control: &WriterControl,
    preview: Option<LivePreviewSink>,
    last_callback_at: &Mutex<Option<Instant>>,
) -> Result<(), String> {
    let mut preview_samples = Vec::new();
    let mut last_heartbeat = 0;
    let mut first_error = None;
    loop {
        let heartbeat = stats.callback_heartbeat.load(Ordering::Acquire);
        if heartbeat != last_heartbeat {
            last_heartbeat = heartbeat;
            if let Ok(mut last_callback_at) = last_callback_at.lock() {
                *last_callback_at = Some(Instant::now());
            }
            stats.monitored_callback.store(heartbeat, Ordering::Release);
        }

        let mut drained_any = false;
        while let Some(block) = ring.pop() {
            drained_any = true;
            for sample in &block.samples[..block.len] {
                if let Err(error) = writer.write_sample(*sample) {
                    first_error.get_or_insert_with(|| error.to_string());
                }
            }
            if let Some(preview) = preview.as_ref() {
                preview_samples.extend_from_slice(&block.samples[..block.len]);
                if block.ends_callback {
                    preview.try_send(std::mem::take(&mut preview_samples));
                }
            }
        }

        let flush_generation = control.flush_generation.load(Ordering::Acquire);
        if flush_generation > control.flushed_generation.load(Ordering::Acquire)
            && ring.read_position() >= control.flush_target.load(Ordering::Acquire)
        {
            if let Err(error) = writer.flush() {
                first_error.get_or_insert_with(|| error.to_string());
            }
            control
                .flushed_generation
                .store(flush_generation, Ordering::Release);
            control.flush_changed.notify_all();
        }

        if control.stop_requested.load(Ordering::Acquire)
            && ring.read_position() >= ring.write_position()
        {
            break;
        }
        if !drained_any {
            thread::sleep(WRITER_IDLE_POLL_INTERVAL);
        }
    }

    if let Some(preview) = preview {
        if !preview_samples.is_empty() {
            preview.try_send(preview_samples);
        }
    }
    if let Err(error) = writer.finalize() {
        first_error.get_or_insert_with(|| error.to_string());
    }
    first_error.map_or(Ok(()), Err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::{SampleFormat, WavReader, WavSpec};
    use std::path::Path;

    fn block(samples: &[i16]) -> AudioBlock {
        let mut block = AudioBlock::empty();
        block.samples[..samples.len()].copy_from_slice(samples);
        block.len = samples.len();
        block.ends_callback = true;
        block
    }

    fn wav_writer(path: &Path) -> WavWriter<BufWriter<File>> {
        WavWriter::create(
            path,
            WavSpec {
                channels: 1,
                sample_rate: 48_000,
                bits_per_sample: 16,
                sample_format: SampleFormat::Int,
            },
        )
        .expect("create WAV writer")
    }

    #[test]
    fn ring_preserves_fifo_order_until_capacity() {
        let ring = AudioRing::new(3);
        ring.push_overwrite(block(&[1, 2]));
        ring.push_overwrite(block(&[3]));
        ring.push_overwrite(block(&[4, 5]));

        assert_eq!(ring.pop().unwrap().samples[..2], [1, 2]);
        assert_eq!(ring.pop().unwrap().samples[..1], [3]);
        assert_eq!(ring.pop().unwrap().samples[..2], [4, 5]);
        assert!(ring.pop().is_none());
        assert_eq!(ring.dropped_samples(), 0);
    }

    #[test]
    fn ring_overflow_drops_oldest_and_counts_exact_samples() {
        let ring = AudioRing::new(2);
        ring.push_overwrite(block(&[1, 2, 3]));
        ring.push_overwrite(block(&[4]));
        ring.push_overwrite(block(&[5, 6]));

        assert_eq!(ring.pop().unwrap().samples[..1], [4]);
        assert_eq!(ring.pop().unwrap().samples[..2], [5, 6]);
        assert!(ring.pop().is_none());
        assert_eq!(ring.dropped_samples(), 3);
    }

    #[test]
    fn ring_preserves_every_block_across_concurrent_wraparound() {
        const BLOCKS: u64 = 10_000;
        const CAPACITY: u64 = 8;
        let ring = Arc::new(AudioRing::new(CAPACITY as usize));
        let consumed = Arc::new(AtomicU64::new(0));
        let producer_ring = Arc::clone(&ring);
        let producer_consumed = Arc::clone(&consumed);
        let producer = thread::spawn(move || {
            for value in 0..BLOCKS {
                while value.saturating_sub(producer_consumed.load(Ordering::Acquire))
                    >= CAPACITY - 1
                {
                    thread::yield_now();
                }
                producer_ring.push_overwrite(block(&[(value % i16::MAX as u64) as i16]));
            }
        });

        for expected in 0..BLOCKS {
            let next = loop {
                if let Some(next) = ring.pop() {
                    break next;
                }
                thread::yield_now();
            };
            assert_eq!(next.samples[0], (expected % i16::MAX as u64) as i16);
            consumed.store(expected + 1, Ordering::Release);
        }

        producer.join().expect("producer completes");
        assert!(ring.pop().is_none());
        assert_eq!(ring.dropped_samples(), 0);
    }

    #[test]
    fn callback_stats_publish_peak_rms_and_recent_peaks_through_atomics() {
        let input = CaptureInput {
            ring: Arc::new(AudioRing::new(2)),
            stats: Arc::new(AtomicCaptureStats::default()),
        };
        input.write(
            [0.5_f32, -0.25].into_iter(),
            &AtomicBool::new(false),
            &AtomicBool::new(false),
        );

        let stats = input.stats();
        let expected_rms = ((0.5_f64.powi(2) + 0.25_f64.powi(2)) / 2.0).sqrt() as f32;
        assert_eq!(stats.peak, 0.5);
        assert!((stats.rms - expected_rms).abs() < f32::EPSILON);
        assert_eq!(stats.recent_peaks, vec![0.5]);
    }

    #[test]
    fn writer_drain_matches_direct_wav_bytes_and_recovery_flushes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let buffered_path = dir.path().join("buffered.wav");
        let direct_path = dir.path().join("direct.wav");
        let samples = (0..(AUDIO_BLOCK_SAMPLES * 2 + 17))
            .map(|index| match index % 5 {
                0 => 0.5_f32,
                1 => -0.25,
                2 => 1.5,
                3 => -2.0,
                _ => 0.0,
            })
            .collect::<Vec<_>>();
        let expected_samples = samples
            .iter()
            .map(|sample| (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
            .collect::<Vec<_>>();

        let (input, writer) = MicrophoneWriter::start_with_capacity(
            wav_writer(&buffered_path),
            8,
            None,
            Arc::new(Mutex::new(None)),
        )
        .expect("start buffered writer");
        input.write(
            samples.iter().copied(),
            &AtomicBool::new(false),
            &AtomicBool::new(false),
        );
        writer.flush_for_recovery();
        assert_eq!(
            input.stats().dropped_samples,
            0,
            "the writer must drain every sample without overflow"
        );
        let flushed_samples = WavReader::open(&buffered_path)
            .expect("recovery-flushed WAV is readable")
            .samples::<i16>()
            .collect::<Result<Vec<_>, _>>()
            .expect("read recovery-flushed samples");
        assert_eq!(flushed_samples, expected_samples);
        writer.finish().expect("finish buffered writer");

        let mut direct = wav_writer(&direct_path);
        for sample in &expected_samples {
            direct.write_sample(*sample).expect("write direct sample");
        }
        direct.finalize().expect("finalize direct WAV");

        assert_eq!(
            std::fs::read(buffered_path).expect("read buffered WAV"),
            std::fs::read(direct_path).expect("read direct WAV"),
            "buffering must not change the finalized WAV bytes"
        );
    }
}
