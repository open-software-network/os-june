//! Per-note serial processing queue.
//!
//! Audio *capture* is globally single-instance (see `audio::capture`), but
//! *processing* (transcribe → generate) runs asynchronously after a recording
//! stops. Stopping frees the capture slot immediately, so a user can record
//! another message on the same note while the previous one is still being
//! transcribed or generated.
//!
//! Those follow-up recordings must still be processed **in order**: generation
//! is incremental and feeds the note's existing generated content back in as
//! context, so job N has to finish before job N+1 reads that context. This
//! queue serializes processing per note and tracks how many jobs are waiting so
//! the UI can surface a count.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc, LazyLock, Mutex,
    },
};
use tokio::sync::Mutex as AsyncMutex;

struct NoteQueue {
    /// Held for the duration of a single job; the next job awaits it.
    lock: Arc<AsyncMutex<()>>,
    /// Jobs queued or running for this note (1 = running, 2 = one waiting, …).
    pending: Arc<AtomicI64>,
}

static QUEUES: LazyLock<Mutex<HashMap<String, NoteQueue>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// A registered processing job. Acquire the lock before doing work; call
/// [`ProcessingTicket::finish`] when the job completes.
pub struct ProcessingTicket {
    note_id: String,
    lock: Arc<AsyncMutex<()>>,
    pending: Arc<AtomicI64>,
}

impl ProcessingTicket {
    /// Clone the per-note lock. Await `.lock()` on the returned handle to wait
    /// for any earlier job on the same note to finish before processing.
    pub fn lock(&self) -> Arc<AsyncMutex<()>> {
        self.lock.clone()
    }

    /// Mark this job done: drop it from the pending count and prune the note's
    /// queue entry once nothing else is waiting.
    pub fn finish(&self) {
        let mut map = QUEUES.lock().expect("processing queue mutex poisoned");
        let remaining = self.pending.fetch_sub(1, Ordering::SeqCst) - 1;
        if remaining <= 0 {
            // Only remove if the map still points at our queue (a concurrent
            // enqueue takes the same `QUEUES` lock, so this can't race).
            if let Some(queue) = map.get(&self.note_id) {
                if Arc::ptr_eq(&queue.pending, &self.pending)
                    && queue.pending.load(Ordering::SeqCst) <= 0
                {
                    map.remove(&self.note_id);
                }
            }
        }
    }
}

/// Register a processing job for `note_id`. Returns the ticket and the queue
/// depth *including* this job (1 = runs immediately, 2 = one job ahead, …).
pub fn enqueue(note_id: &str) -> (ProcessingTicket, i64) {
    let mut map = QUEUES.lock().expect("processing queue mutex poisoned");
    let queue = map.entry(note_id.to_string()).or_insert_with(|| NoteQueue {
        lock: Arc::new(AsyncMutex::new(())),
        pending: Arc::new(AtomicI64::new(0)),
    });
    let depth = queue.pending.fetch_add(1, Ordering::SeqCst) + 1;
    let ticket = ProcessingTicket {
        note_id: note_id.to_string(),
        lock: queue.lock.clone(),
        pending: queue.pending.clone(),
    };
    (ticket, depth)
}

/// Number of recordings queued *behind* the one currently processing for this
/// note (0 when nothing extra is waiting). Drives the UI count chip.
pub fn queued_behind(note_id: &str) -> i64 {
    let map = QUEUES.lock().expect("processing queue mutex poisoned");
    map.get(note_id)
        .map(|queue| (queue.pending.load(Ordering::SeqCst) - 1).max(0))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_job_runs_immediately_and_reports_nothing_queued() {
        let (ticket, depth) = enqueue("note-immediate");
        assert_eq!(depth, 1);
        assert_eq!(queued_behind("note-immediate"), 0);
        ticket.finish();
        assert_eq!(queued_behind("note-immediate"), 0);
    }

    #[test]
    fn stacked_jobs_increment_depth_and_queued_count() {
        let (first, first_depth) = enqueue("note-stacked");
        let (second, second_depth) = enqueue("note-stacked");
        let (third, third_depth) = enqueue("note-stacked");
        assert_eq!((first_depth, second_depth, third_depth), (1, 2, 3));
        // Two recordings wait behind the one currently processing.
        assert_eq!(queued_behind("note-stacked"), 2);

        first.finish();
        assert_eq!(queued_behind("note-stacked"), 1);
        second.finish();
        assert_eq!(queued_behind("note-stacked"), 0);
        third.finish();
        assert_eq!(queued_behind("note-stacked"), 0);
    }

    #[test]
    fn queues_are_isolated_per_note() {
        let (a, _) = enqueue("note-a");
        let (b1, _) = enqueue("note-b");
        let (b2, _) = enqueue("note-b");
        assert_eq!(queued_behind("note-a"), 0);
        assert_eq!(queued_behind("note-b"), 1);
        a.finish();
        b1.finish();
        b2.finish();
    }

    #[tokio::test]
    async fn lock_serializes_jobs_on_the_same_note() {
        let (first, _) = enqueue("note-serial");
        let (second, _) = enqueue("note-serial");
        let first_lock = first.lock();
        let second_lock = second.lock();

        let held = first_lock.lock().await;
        // The second job cannot acquire the lock while the first holds it.
        assert!(second_lock.try_lock().is_err());
        drop(held);
        assert!(second_lock.try_lock().is_ok());

        first.finish();
        second.finish();
    }
}
