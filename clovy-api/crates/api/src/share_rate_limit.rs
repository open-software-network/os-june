use std::{
    collections::{HashMap, hash_map::RandomState},
    hash::BuildHasher,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

const SHARD_COUNT: usize = 64;
const MAX_TRACKED_KEYS: usize = 100_000;
const MAX_KEYS_PER_SHARD: usize = 4_096;
const WINDOW: Duration = Duration::from_mins(1);
const MAX_PER_WINDOW: u32 = 60;
const CLEANUP_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Copy)]
struct Counter {
    window_started_at: Instant,
    hits: u32,
}

struct ShareRateLimiterInner {
    shards: Box<[Mutex<HashMap<String, Counter>>]>,
    shard_hasher: RandomState,
    tracked_keys: AtomicUsize,
    capacity: usize,
    per_shard_capacity: usize,
}

/// Fixed-window limiter for public-share endpoints.
///
/// Keys retain the deployed 60 requests/minute semantics. A keyed request
/// locks only one of 64 shards, while a detached maintenance task expires one
/// shard at a time outside the request path. The table tracks at most 100,000
/// keys; once full, unknown keys fail closed instead of evicting an active
/// counter that an attacker could deliberately reset.
#[derive(Clone)]
pub struct ShareRateLimiter {
    inner: Arc<ShareRateLimiterInner>,
}

impl Default for ShareRateLimiter {
    fn default() -> Self {
        Self::with_capacity(MAX_TRACKED_KEYS)
    }
}

impl ShareRateLimiter {
    #[doc(hidden)]
    pub fn with_capacity(capacity: usize) -> Self {
        let shards = (0..SHARD_COUNT)
            .map(|_| Mutex::new(HashMap::new()))
            .collect();
        Self {
            inner: Arc::new(ShareRateLimiterInner {
                shards,
                shard_hasher: RandomState::new(),
                tracked_keys: AtomicUsize::new(0),
                capacity,
                per_shard_capacity: capacity.min(MAX_KEYS_PER_SHARD),
            }),
        }
    }

    /// Returns false when the caller is over budget or the bounded table
    /// cannot safely admit a new key.
    pub fn allow(&self, key: &str) -> bool {
        self.allow_at(key, Instant::now())
    }

    fn allow_at(&self, key: &str, now: Instant) -> bool {
        let shard_index = self.shard_index(key);
        // A poisoned lock must not fail OPEN on a security gate. HashMap
        // operations preserve structural validity across unwinding, so recover
        // the shard and keep enforcing its counters.
        let mut shard = self.inner.shards[shard_index]
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        if let Some(counter) = shard.get_mut(key) {
            if now.saturating_duration_since(counter.window_started_at) >= WINDOW {
                *counter = Counter {
                    window_started_at: now,
                    hits: 1,
                };
                return true;
            }
            counter.hits = counter.hits.saturating_add(1);
            return counter.hits <= MAX_PER_WINDOW;
        }

        // The global count bounds live key strings. The per-shard ceiling also
        // bounds retained HashMap bucket allocations across repeated expiry
        // generations, because HashMap does not automatically shrink.
        if shard.len() >= self.inner.per_shard_capacity || !self.try_reserve_key() {
            return false;
        }
        // The shard lock remains held and there is no fallible branch or early
        // return between a successful reservation and this insert, so every
        // reservation is paired with exactly one new map entry.
        shard.insert(
            key.to_string(),
            Counter {
                window_started_at: now,
                hits: 1,
            },
        );
        true
    }

    pub(crate) fn start_cleanup(&self) {
        let weak = Arc::downgrade(&self.inner);
        // Dropping a Tokio JoinHandle detaches the task. It holds only a Weak,
        // so it exits after the owning ApiState is dropped.
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => drop(runtime.spawn(cleanup_loop(weak))),
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    "share-rate-limiter cleanup task not started: no Tokio runtime"
                );
                debug_assert!(
                    tokio::runtime::Handle::try_current().is_ok(),
                    "share-rate-limiter cleanup task not started: no Tokio runtime"
                );
            }
        }
    }

    fn try_reserve_key(&self) -> bool {
        self.inner
            .tracked_keys
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < self.inner.capacity).then_some(current + 1)
            })
            .is_ok()
    }

    fn shard_index(&self, key: &str) -> usize {
        let shard_count = u64::try_from(self.inner.shards.len()).unwrap_or(1);
        usize::try_from(self.inner.shard_hasher.hash_one(key) % shard_count).unwrap_or_default()
    }

    fn cleanup_shard_at(&self, shard_index: usize, now: Instant) {
        let mut shard = self.inner.shards[shard_index]
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let before = shard.len();
        shard
            .retain(|_, counter| now.saturating_duration_since(counter.window_started_at) < WINDOW);
        self.release_keys(before - shard.len());
    }

    fn release_keys(&self, count: usize) {
        if count == 0 {
            return;
        }
        // Underflow is unreachable while the map/count invariant holds. If a
        // future bug violates it in release builds, wrapping high fails closed
        // instead of under-counting the table and admitting excess keys.
        let previous = self.inner.tracked_keys.fetch_sub(count, Ordering::AcqRel);
        debug_assert!(previous >= count, "tracked-key count underflow");
    }

    #[cfg(test)]
    fn cleanup_all_at(&self, now: Instant) {
        for shard_index in 0..self.inner.shards.len() {
            self.cleanup_shard_at(shard_index, now);
        }
    }

    #[cfg(test)]
    fn tracked_key_count(&self) -> usize {
        self.inner.tracked_keys.load(Ordering::Acquire)
    }
}

async fn cleanup_loop(inner: Weak<ShareRateLimiterInner>) {
    let mut next_shard = 0;
    loop {
        tokio::time::sleep(CLEANUP_INTERVAL).await;
        let Some(inner) = inner.upgrade() else {
            return;
        };
        let limiter = ShareRateLimiter { inner };
        limiter.cleanup_shard_at(next_shard, Instant::now());
        next_shard = (next_shard + 1) % limiter.inner.shards.len();
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_KEYS_PER_SHARD, MAX_PER_WINDOW, ShareRateLimiter, WINDOW};
    use std::{
        collections::HashMap,
        sync::{
            Arc, Barrier,
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        thread,
        time::{Duration, Instant},
    };

    #[derive(Default)]
    struct ReferenceLimiter {
        hits: HashMap<String, (Instant, u32)>,
    }

    impl ReferenceLimiter {
        fn allow_at(&mut self, key: &str, now: Instant) -> bool {
            self.hits
                .retain(|_, (start, _)| now.saturating_duration_since(*start) < WINDOW);
            let entry = self.hits.entry(key.to_string()).or_insert((now, 0));
            if now.saturating_duration_since(entry.0) >= WINDOW {
                *entry = (now, 0);
            }
            entry.1 += 1;
            entry.1 <= MAX_PER_WINDOW
        }
    }

    #[test]
    fn fixed_window_semantics_match_the_previous_limiter() {
        let limiter = ShareRateLimiter::with_capacity(1_000);
        let mut reference = ReferenceLimiter::default();
        let start = Instant::now();
        let identities = ["user:usr_owner", "ip:198.51.100.7", "link-ip:198.51.100.7"];

        for second in [0, 1, 30, 59, 60, 61, 119, 120] {
            let now = start + Duration::from_secs(second);
            for identity in identities {
                for _ in 0..75 {
                    assert_eq!(
                        limiter.allow_at(identity, now),
                        reference.allow_at(identity, now),
                        "semantic drift for {identity} at second {second}"
                    );
                }
            }
        }
    }

    #[test]
    fn exact_window_rollover_resets_only_the_requested_key() {
        let limiter = ShareRateLimiter::with_capacity(2);
        let start = Instant::now();

        for _ in 0..MAX_PER_WINDOW {
            assert!(limiter.allow_at("ip:198.51.100.7", start));
        }
        assert!(!limiter.allow_at(
            "ip:198.51.100.7",
            start + WINDOW.saturating_sub(Duration::from_nanos(1))
        ));
        assert!(limiter.allow_at("user:usr_other", start));
        assert!(limiter.allow_at("ip:198.51.100.7", start + WINDOW));
        assert_eq!(limiter.tracked_key_count(), 2);
    }

    #[test]
    fn cap_exhaustion_is_fail_closed_and_cannot_reset_an_active_counter() {
        let limiter = ShareRateLimiter::with_capacity(4);
        let start = Instant::now();
        let attacker = "link-ip:203.0.113.9";

        for _ in 0..MAX_PER_WINDOW {
            assert!(limiter.allow_at(attacker, start));
        }
        assert!(!limiter.allow_at(attacker, start));
        for index in 0..3 {
            assert!(limiter.allow_at(&format!("ip:198.51.100.{index}"), start));
        }

        for index in 0..1_000 {
            assert!(
                !limiter.allow_at(&format!("link-ip:192.0.2.{index}"), start),
                "a churn key was admitted after the table reached its cap"
            );
        }

        assert_eq!(limiter.tracked_key_count(), 4);
        assert!(
            !limiter.allow_at(attacker, start),
            "key churn evicted and reset the attacker's blocked counter"
        );
    }

    #[test]
    fn expiry_cleanup_reclaims_capacity_without_evicting_live_keys() {
        let limiter = ShareRateLimiter::with_capacity(2);
        let start = Instant::now();
        assert!(limiter.allow_at("ip:expired", start));
        assert!(limiter.allow_at("ip:live", start + Duration::from_secs(30)));
        assert!(!limiter.allow_at("ip:new", start + Duration::from_secs(30)));

        limiter.cleanup_all_at(start + WINDOW);

        assert_eq!(limiter.tracked_key_count(), 1);
        assert!(limiter.allow_at("ip:new", start + WINDOW));
        assert_eq!(limiter.tracked_key_count(), 2);
    }

    #[test]
    fn a_blocked_shard_does_not_serialize_other_shards() {
        let limiter = ShareRateLimiter::with_capacity(10);
        let blocked_key = "ip:blocked-shard";
        let blocked_shard = limiter.shard_index(blocked_key);
        let free_key = (0..10_000)
            .map(|index| format!("ip:free-{index}"))
            .find(|key| limiter.shard_index(key) != blocked_shard)
            .expect("64 shards must yield a key in another shard");
        let shard_guard = limiter.inner.shards[blocked_shard]
            .lock()
            .expect("test shard lock");
        let (sender, receiver) = mpsc::channel();
        let worker_limiter = limiter.clone();
        let worker = thread::spawn(move || {
            let _sent = sender.send(worker_limiter.allow(&free_key));
        });

        let result = receiver.recv_timeout(Duration::from_secs(1));
        drop(shard_guard);
        assert!(worker.join().is_ok(), "worker thread panicked");
        assert!(
            result.expect("another shard should complete while one shard is held"),
            "another shard unexpectedly denied its first request"
        );
    }

    #[test]
    fn concurrent_requests_preserve_the_exact_per_key_threshold() {
        const WORKERS: usize = 8;
        const REQUESTS_PER_WORKER: usize = 32;
        let limiter = Arc::new(ShareRateLimiter::with_capacity(10));
        let barrier = Arc::new(Barrier::new(WORKERS));
        let allowed = Arc::new(AtomicUsize::new(0));
        let workers = (0..WORKERS)
            .map(|_| {
                let limiter = limiter.clone();
                let barrier = barrier.clone();
                let allowed = allowed.clone();
                thread::spawn(move || {
                    barrier.wait();
                    for _ in 0..REQUESTS_PER_WORKER {
                        if limiter.allow("user:usr_concurrent") {
                            allowed.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                })
            })
            .collect::<Vec<_>>();

        for worker in workers {
            assert!(worker.join().is_ok(), "worker thread panicked");
        }

        assert_eq!(allowed.load(Ordering::Relaxed), MAX_PER_WINDOW as usize);
    }

    #[test]
    fn concurrent_key_churn_never_exceeds_the_hard_cap() {
        const CAPACITY: usize = 1_000;
        const WORKERS: usize = 8;
        const KEYS_PER_WORKER: usize = 500;
        let limiter = Arc::new(ShareRateLimiter::with_capacity(CAPACITY));
        let barrier = Arc::new(Barrier::new(WORKERS));
        let allowed = Arc::new(AtomicUsize::new(0));
        let workers = (0..WORKERS)
            .map(|worker_index| {
                let limiter = limiter.clone();
                let barrier = barrier.clone();
                let allowed = allowed.clone();
                thread::spawn(move || {
                    barrier.wait();
                    for key_index in 0..KEYS_PER_WORKER {
                        let key = format!("ip:{worker_index}:{key_index}");
                        if limiter.allow(&key) {
                            allowed.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                })
            })
            .collect::<Vec<_>>();

        for worker in workers {
            assert!(worker.join().is_ok(), "worker thread panicked");
        }

        assert_eq!(allowed.load(Ordering::Relaxed), CAPACITY);
        assert_eq!(limiter.tracked_key_count(), CAPACITY);
    }

    #[test]
    fn one_shard_cannot_accumulate_unbounded_retained_capacity() {
        let limiter = ShareRateLimiter::with_capacity(MAX_KEYS_PER_SHARD * 2);
        let target_shard = 0;
        let colliding_keys = (0..)
            .map(|index| format!("ip:collision:{index}"))
            .filter(|key| limiter.shard_index(key) == target_shard)
            .take(MAX_KEYS_PER_SHARD + 1)
            .collect::<Vec<_>>();

        for key in &colliding_keys[..MAX_KEYS_PER_SHARD] {
            assert!(limiter.allow(key));
        }
        assert!(
            !limiter.allow(&colliding_keys[MAX_KEYS_PER_SHARD]),
            "one shard admitted more keys than its allocation ceiling"
        );
        assert_eq!(limiter.tracked_key_count(), MAX_KEYS_PER_SHARD);
    }

    #[cfg(debug_assertions)]
    #[test]
    #[should_panic(expected = "share-rate-limiter cleanup task not started: no Tokio runtime")]
    fn cleanup_start_without_a_runtime_is_loud_in_debug_builds() {
        ShareRateLimiter::default().start_cleanup();
    }
}
