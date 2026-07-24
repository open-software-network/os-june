use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use june_api::ShareRateLimiter;
use std::{
    hint::black_box,
    sync::{
        Arc, Barrier,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

const CAPACITY: usize = 100_000;
const CARDINALITIES: [usize; 4] = [1, 1_000, 10_000, 100_000];
const CONCURRENCY_LEVELS: [usize; 3] = [2, 8, 32];
const REQUESTS_PER_WORKER: usize = 256;

fn populated_limiter(cardinality: usize) -> (Arc<ShareRateLimiter>, Arc<Vec<String>>) {
    let limiter = Arc::new(ShareRateLimiter::with_capacity(CAPACITY));
    let keys = Arc::new(
        (0..cardinality)
            .map(|index| format!("ip:benchmark:{index}"))
            .collect::<Vec<_>>(),
    );
    for key in keys.iter() {
        assert!(limiter.allow(key), "benchmark setup exceeded the hard cap");
    }
    (limiter, keys)
}

fn lookup_latency(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("share_rate_limiter/lookup_latency");
    for cardinality in CARDINALITIES {
        let (limiter, keys) = populated_limiter(cardinality);
        let key = &keys[cardinality - 1];
        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(cardinality),
            &cardinality,
            |bencher, _| {
                bencher.iter(|| black_box(limiter.allow(black_box(key))));
            },
        );
    }
    group.finish();
}

struct ConcurrentHarness {
    start: Arc<Barrier>,
    finish: Arc<Barrier>,
    stop: Arc<AtomicBool>,
    workers: Vec<thread::JoinHandle<()>>,
}

impl ConcurrentHarness {
    fn new(limiter: &Arc<ShareRateLimiter>, keys: &Arc<Vec<String>>, worker_count: usize) -> Self {
        let start = Arc::new(Barrier::new(worker_count + 1));
        let finish = Arc::new(Barrier::new(worker_count + 1));
        let stop = Arc::new(AtomicBool::new(false));
        let workers = (0..worker_count)
            .map(|worker_index| {
                let limiter = limiter.clone();
                let keys = keys.clone();
                let start = start.clone();
                let finish = finish.clone();
                let stop = stop.clone();
                thread::spawn(move || {
                    loop {
                        start.wait();
                        if stop.load(Ordering::Acquire) {
                            return;
                        }
                        for request_index in 0..REQUESTS_PER_WORKER {
                            let key_index =
                                (worker_index * REQUESTS_PER_WORKER + request_index) % keys.len();
                            black_box(limiter.allow(black_box(&keys[key_index])));
                        }
                        finish.wait();
                    }
                })
            })
            .collect();
        Self {
            start,
            finish,
            stop,
            workers,
        }
    }

    fn run_round(&self) {
        self.start.wait();
        self.finish.wait();
    }
}

impl Drop for ConcurrentHarness {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.start.wait();
        for worker in self.workers.drain(..) {
            assert!(worker.join().is_ok(), "benchmark worker panicked");
        }
    }
}

fn concurrent_throughput(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("share_rate_limiter/concurrent_throughput");
    for cardinality in CARDINALITIES {
        for worker_count in CONCURRENCY_LEVELS {
            let (limiter, keys) = populated_limiter(cardinality);
            let harness = ConcurrentHarness::new(&limiter, &keys, worker_count);
            let requests_per_round = worker_count * REQUESTS_PER_WORKER;
            group.throughput(Throughput::Elements(
                u64::try_from(requests_per_round).unwrap_or(u64::MAX),
            ));
            group.bench_with_input(
                BenchmarkId::new(format!("{cardinality}_keys"), worker_count),
                &(cardinality, worker_count),
                |bencher, _| bencher.iter(|| harness.run_round()),
            );
        }
    }
    group.finish();
}

criterion_group! {
    name = benches;
    config = Criterion::default()
        .sample_size(20)
        .measurement_time(Duration::from_secs(2));
    targets = lookup_latency, concurrent_throughput
}
criterion_main!(benches);
