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
//! context, so recording session N has to finish before recording session N+1
//! reads that context. This queue serializes processing per note and tracks how
//! many recording sessions are waiting so the UI can surface a count.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc, LazyLock, Mutex,
    },
};
use tokio::sync::watch;

struct CompletionSignal {
    completed: watch::Sender<bool>,
}

impl CompletionSignal {
    fn new() -> Self {
        let (completed, _receiver) = watch::channel(false);
        Self { completed }
    }

    async fn wait(&self) {
        let mut completed = self.completed.subscribe();
        if *completed.borrow_and_update() {
            return;
        }
        while completed.changed().await.is_ok() {
            if *completed.borrow_and_update() {
                return;
            }
        }
    }

    fn complete(&self) {
        self.completed.send_replace(true);
    }
}

struct NoteQueue {
    /// Recording sessions queued or running for this note.
    pending: Arc<AtomicI64>,
    /// Recording sessions currently queued or running for this note.
    registered_recording_session_ids: HashSet<String>,
    /// Completion of the last registered session. A new ticket waits on it,
    /// preserving registration order even when spawned tasks are polled out of
    /// order by the runtime.
    tail: Option<Arc<CompletionSignal>>,
}

static QUEUES: LazyLock<Mutex<HashMap<String, NoteQueue>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// A registered recording-session processing run. Wait for its turn before
/// doing work; call [`ProcessingTicket::finish`] when processing completes.
pub struct ProcessingTicket {
    note_id: String,
    recording_session_id: String,
    predecessor: Option<Arc<CompletionSignal>>,
    completion: Arc<CompletionSignal>,
    pending: Arc<AtomicI64>,
    finished: AtomicBool,
}

impl ProcessingTicket {
    /// Wait until every recording session registered earlier on this note has
    /// finished processing.
    pub async fn wait_until_ready(&self) {
        if let Some(predecessor) = &self.predecessor {
            predecessor.wait().await;
        }
    }

    /// Mark this recording session done, release its identity, and wake the
    /// next registered session.
    pub fn finish(&self) {
        if self.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut map = QUEUES.lock().expect("processing queue mutex poisoned");
        let remaining = self.pending.fetch_sub(1, Ordering::SeqCst) - 1;
        if let Some(queue) = map.get_mut(&self.note_id) {
            if Arc::ptr_eq(&queue.pending, &self.pending) {
                queue
                    .registered_recording_session_ids
                    .remove(&self.recording_session_id);
            }
        }
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
        drop(map);
        self.completion.complete();
    }
}

impl Drop for ProcessingTicket {
    fn drop(&mut self) {
        self.finish();
    }
}

/// Register a recording session for processing on `note_id`.
///
/// Returns `None` while the same `(note_id, recording_session_id)` pair is
/// already queued or running. Otherwise, returns the ticket and queue depth
/// including this recording session (1 = runs immediately, 2 = one session
/// ahead, …). Finishing or dropping the ticket releases the identity so an
/// explicit later Retry can enqueue it again.
pub fn enqueue(note_id: &str, recording_session_id: &str) -> Option<(ProcessingTicket, i64)> {
    let mut map = QUEUES.lock().expect("processing queue mutex poisoned");
    let queue = map.entry(note_id.to_string()).or_insert_with(|| NoteQueue {
        pending: Arc::new(AtomicI64::new(0)),
        registered_recording_session_ids: HashSet::new(),
        tail: None,
    });
    if !queue
        .registered_recording_session_ids
        .insert(recording_session_id.to_string())
    {
        return None;
    }
    let depth = queue.pending.fetch_add(1, Ordering::SeqCst) + 1;
    let completion = Arc::new(CompletionSignal::new());
    let ticket = ProcessingTicket {
        note_id: note_id.to_string(),
        recording_session_id: recording_session_id.to_string(),
        predecessor: queue.tail.replace(Arc::clone(&completion)),
        completion,
        pending: queue.pending.clone(),
        finished: AtomicBool::new(false),
    };
    Some((ticket, depth))
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
        let (ticket, depth) = enqueue("note-immediate", "session-1").unwrap();
        assert_eq!(depth, 1);
        assert_eq!(queued_behind("note-immediate"), 0);
        ticket.finish();
        assert_eq!(queued_behind("note-immediate"), 0);
    }

    #[test]
    fn stacked_jobs_increment_depth_and_queued_count() {
        let (first, first_depth) = enqueue("note-stacked", "session-1").unwrap();
        let (second, second_depth) = enqueue("note-stacked", "session-2").unwrap();
        let (third, third_depth) = enqueue("note-stacked", "session-3").unwrap();
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
        let (a, _) = enqueue("note-a", "session-shared").unwrap();
        let (b1, _) = enqueue("note-b", "session-shared").unwrap();
        let (b2, _) = enqueue("note-b", "session-b2").unwrap();
        assert_eq!(queued_behind("note-a"), 0);
        assert_eq!(queued_behind("note-b"), 1);
        a.finish();
        b1.finish();
        b2.finish();
    }

    #[test]
    fn dropped_ticket_releases_pending_job() {
        {
            let (_ticket, depth) = enqueue("note-drop", "session-drop").unwrap();
            assert_eq!(depth, 1);
        }

        let (next, depth) = enqueue("note-drop", "session-drop").unwrap();
        assert_eq!(depth, 1);
        next.finish();
    }

    #[test]
    fn finish_is_idempotent() {
        let (first, _) = enqueue("note-idempotent", "session-1").unwrap();
        let (second, _) = enqueue("note-idempotent", "session-2").unwrap();

        first.finish();
        first.finish();

        let (third, depth) = enqueue("note-idempotent", "session-1").unwrap();
        assert_eq!(depth, 2);
        second.finish();
        third.finish();
    }

    #[tokio::test]
    async fn registration_order_wins_when_later_session_is_polled_first() {
        let (first, _) = enqueue("note-serial", "session-1").unwrap();
        let (second, _) = enqueue("note-serial", "session-2").unwrap();
        let (second_attempted_tx, second_attempted_rx) = tokio::sync::oneshot::channel();
        let (second_started_tx, mut second_started_rx) = tokio::sync::mpsc::unbounded_channel();
        let second_task = tokio::spawn(async move {
            second_attempted_tx.send(()).unwrap();
            second.wait_until_ready().await;
            second_started_tx.send(()).unwrap();
            second.finish();
        });

        second_attempted_rx.await.unwrap();
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(20),
                second_started_rx.recv()
            )
            .await
            .is_err(),
            "second session bypassed the first registration"
        );

        first.wait_until_ready().await;
        first.finish();
        tokio::time::timeout(std::time::Duration::from_secs(1), second_started_rx.recv())
            .await
            .expect("second session remained blocked")
            .expect("second session task ended without starting");
        second_task.await.unwrap();
    }

    #[test]
    fn duplicate_session_on_the_same_note_is_suppressed() {
        let (ticket, depth) = enqueue("note-duplicate", "session-1").unwrap();
        assert_eq!(depth, 1);

        assert!(enqueue("note-duplicate", "session-1").is_none());
        assert_eq!(queued_behind("note-duplicate"), 0);

        ticket.finish();
    }

    #[test]
    fn distinct_sessions_on_the_same_note_remain_ordered() {
        let (first, first_depth) = enqueue("note-distinct", "session-1").unwrap();
        let (second, second_depth) = enqueue("note-distinct", "session-2").unwrap();

        assert_eq!((first_depth, second_depth), (1, 2));
        assert_eq!(queued_behind("note-distinct"), 1);

        first.finish();
        second.finish();
    }

    #[test]
    fn finished_session_can_be_enqueued_again() {
        let (first, _) = enqueue("note-retry", "session-retry").unwrap();
        let (next_session, _) = enqueue("note-retry", "session-next").unwrap();
        first.finish();

        let (retry, depth) = enqueue("note-retry", "session-retry").unwrap();
        assert_eq!(depth, 2);

        next_session.finish();
        retry.finish();
    }
}
