use crate::domain::types::AppError;
use std::process::Child;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Condvar, Mutex, MutexGuard, TryLockError};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;

/// App teardown gets this long in total, regardless of which individual leaf
/// is slow or stuck. The supervisor is separate from the cleanup worker, so a
/// blocking syscall in one leaf cannot postpone the final exit/restart.
///
/// The dictation (1.25 s) and Computer use (2.5 s) branches run concurrently
/// with Hermes, so neither can consume Hermes' ordered budget: start quiescence
/// (2 s) + Gateway unload (6 s) + process/browser/proxy finalization (2 s).
const SHUTDOWN_AGGREGATE_DEADLINE_MS: u64 = 10_000;
const SHUTDOWN_AGGREGATE_DEADLINE: Duration = Duration::from_millis(SHUTDOWN_AGGREGATE_DEADLINE_MS);
const HERMES_FINALIZATION_BUDGET_MS: u64 = 2_000;
const EXIT_FALLBACK_DEADLINE: Duration = Duration::from_secs(3);
const MUTEX_POLL_INTERVAL: Duration = Duration::from_millis(5);
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(10);

const _: () = assert!(
    SHUTDOWN_AGGREGATE_DEADLINE_MS
        >= crate::hermes_bridge::SHUTDOWN_START_QUIESCE_TIMEOUT_MS
            + crate::hermes_bridge::GATEWAY_SHUTDOWN_TOTAL_TIMEOUT_MS
            + HERMES_FINALIZATION_BUDGET_MS
);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShutdownTarget {
    Exit(i32),
    Restart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShutdownPhase {
    Idle,
    Running(ShutdownTarget),
    Finalizing(ShutdownTarget),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BeginShutdown {
    Started(ShutdownTarget),
    AlreadyRunning(ShutdownTarget),
}

pub(crate) struct ShutdownCoordinator {
    phase: Mutex<ShutdownPhase>,
    phase_changed: Condvar,
}

impl Default for ShutdownCoordinator {
    fn default() -> Self {
        Self {
            phase: Mutex::new(ShutdownPhase::Idle),
            phase_changed: Condvar::new(),
        }
    }
}

impl ShutdownCoordinator {
    fn lock_phase(&self) -> MutexGuard<'_, ShutdownPhase> {
        self.phase
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The first request decides whether this process exits or restarts. Later
    /// requests share the in-flight cleanup and cannot change its final action.
    fn begin(&self, requested: ShutdownTarget) -> BeginShutdown {
        let mut phase = self.lock_phase();
        match *phase {
            ShutdownPhase::Idle => {
                *phase = ShutdownPhase::Running(requested);
                BeginShutdown::Started(requested)
            }
            ShutdownPhase::Running(target) | ShutdownPhase::Finalizing(target) => {
                BeginShutdown::AlreadyRunning(target)
            }
        }
    }

    fn mark_finalizing(&self, target: ShutdownTarget) {
        *self.lock_phase() = ShutdownPhase::Finalizing(target);
        self.phase_changed.notify_all();
    }

    fn final_exit_is_allowed(&self) -> bool {
        matches!(*self.lock_phase(), ShutdownPhase::Finalizing(_))
    }

    fn is_idle(&self) -> bool {
        matches!(*self.lock_phase(), ShutdownPhase::Idle)
    }

    #[cfg(windows)]
    fn wait_until_finalizing(&self, timeout: Duration) -> bool {
        let phase = self.lock_phase();
        if matches!(*phase, ShutdownPhase::Finalizing(_)) {
            return true;
        }
        let (phase, _) = self
            .phase_changed
            .wait_timeout_while(phase, timeout, |phase| {
                !matches!(phase, ShutdownPhase::Finalizing(_))
            })
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        matches!(*phase, ShutdownPhase::Finalizing(_))
    }
}

/// Intercepts ordinary Tauri exit requests while the main event loop can still
/// be kept alive. `RunEvent::Exit` is too late: Tauri is already tearing down
/// the runtime and cannot reliably run asynchronous cleanup from there.
pub(crate) fn handle_exit_requested(
    app: &tauri::AppHandle,
    code: Option<i32>,
    api: &tauri::ExitRequestApi,
) {
    let coordinator = app.state::<ShutdownCoordinator>();
    if coordinator.final_exit_is_allowed() {
        return;
    }

    // Tauri ignores this for its built-in restart code, but ordinary exit must
    // remain alive while the coordinator owns teardown. June's updater avoids
    // the restart exception by latching Restart directly through its command.
    api.prevent_exit();
    if code == Some(tauri::RESTART_EXIT_CODE) && coordinator.is_idle() {
        // A direct `app.restart()`/`request_restart()` caller can bypass
        // `prevent_exit` (and a main-thread restart skips ExitRequested
        // entirely). All restart callers except this coordinator's finalizer
        // must use `shutdown::request_restart`, which latches Running first.
        tracing::error!("restart reached ExitRequested without the shutdown coordinator");
        debug_assert!(
            !coordinator.is_idle(),
            "restart callers must use shutdown::request_restart, not Tauri restart directly"
        );
    }
    let target = if code == Some(tauri::RESTART_EXIT_CODE) {
        ShutdownTarget::Restart
    } else {
        ShutdownTarget::Exit(code.unwrap_or(0))
    };

    if let Err(error) = request(app, target) {
        tracing::error!(
            code = %error.code,
            "could not start the shutdown coordinator; allowing a fail-safe exit"
        );
        coordinator.mark_finalizing(target);
        finalize(app.clone(), target);
    }
}

/// Last-chance cleanup for termination paths that Tao delivers only as
/// `RunEvent::Exit` (including macOS logout/application termination). Normal
/// quits and update relaunches have already latched Running or Finalizing and
/// remain no-ops here.
pub(crate) fn handle_exit(app: &tauri::AppHandle) {
    let coordinator = app.state::<ShutdownCoordinator>();
    let cleanup_app = app.clone();
    if matches!(
        run_bounded_cleanup_if_idle(
            &coordinator,
            ShutdownTarget::Exit(0),
            EXIT_FALLBACK_DEADLINE,
            move || tauri::async_runtime::block_on(run_cleanup(&cleanup_app)),
        ),
        Some(true)
    ) {
        tracing::info!("completed last-chance cleanup from RunEvent::Exit");
    }
}

pub(crate) fn request_restart(app: &tauri::AppHandle) -> Result<(), AppError> {
    request(app, ShutdownTarget::Restart)
}

/// Windows' updater exits the process from `Update::install_inner` after this
/// hook and never emits ExitRequested. Run the same idempotent cleanup
/// synchronously, then perform Tauri's own cleanup as the final API call before
/// the plugin invokes `std::process::exit`.
#[cfg(windows)]
pub(crate) fn cleanup_before_updater_exit(app: &tauri::AppHandle) {
    let coordinator = app.state::<ShutdownCoordinator>();
    let cleanup_app = app.clone();
    match coordinator.begin(ShutdownTarget::Restart) {
        BeginShutdown::Started(target) => {
            let completed = run_bounded_cleanup(SHUTDOWN_AGGREGATE_DEADLINE, move || {
                tauri::async_runtime::block_on(run_cleanup(&cleanup_app));
            });
            if !completed {
                tracing::warn!(
                    timeout_ms = SHUTDOWN_AGGREGATE_DEADLINE.as_millis(),
                    "Windows updater cleanup hit its aggregate deadline"
                );
            }
            coordinator.mark_finalizing(target);
        }
        BeginShutdown::AlreadyRunning(_) => {
            let _ = coordinator.wait_until_finalizing(SHUTDOWN_AGGREGATE_DEADLINE);
        }
    }
    app.cleanup_before_exit();
}

fn request(app: &tauri::AppHandle, requested: ShutdownTarget) -> Result<(), AppError> {
    let coordinator = app.state::<ShutdownCoordinator>();
    let BeginShutdown::Started(target) = coordinator.begin(requested) else {
        return Ok(());
    };

    let cleanup_app = app.clone();
    let final_app = app.clone();
    spawn_supervised_shutdown(
        SHUTDOWN_AGGREGATE_DEADLINE,
        move || tauri::async_runtime::block_on(run_cleanup(&cleanup_app)),
        move |completed| {
            if completed {
                tracing::info!(?target, "app shutdown cleanup completed");
            } else {
                tracing::warn!(
                    ?target,
                    timeout_ms = SHUTDOWN_AGGREGATE_DEADLINE.as_millis(),
                    "app shutdown cleanup hit its aggregate deadline"
                );
            }
            final_app
                .state::<ShutdownCoordinator>()
                .mark_finalizing(target);
            finalize(final_app, target);
        },
    )
    .map_err(|error| AppError::new("shutdown_start_failed", error.to_string()))
}

fn spawn_supervised_shutdown<C, F>(
    deadline: Duration,
    cleanup: C,
    finalize: F,
) -> std::io::Result<()>
where
    C: FnOnce() + Send + 'static,
    F: FnOnce(bool) + Send + 'static,
{
    thread::Builder::new()
        .name("june-shutdown-supervisor".to_string())
        .spawn(move || {
            let (done_tx, done_rx) = mpsc::sync_channel(1);
            let cleanup_spawn = thread::Builder::new()
                .name("june-shutdown-cleanup".to_string())
                .spawn(move || {
                    cleanup();
                    let _ = done_tx.send(());
                });
            let completed = cleanup_spawn.is_ok() && wait_for_cleanup(&done_rx, deadline);
            finalize(completed);
        })
        .map(|_| ())
}

async fn run_cleanup(app: &tauri::AppHandle) {
    let dictation_app = app.clone();
    let dictation =
        tauri::async_runtime::spawn_blocking(move || crate::dictation::stop_helper(&dictation_app));
    let computer_use = crate::computer_use::shutdown(app);
    // This call preserves the load-bearing order inside the Hermes subsystem:
    // quiesce starts -> unload the Gateway -> reap runtimes -> stop the
    // provider proxy.
    let hermes = crate::hermes_bridge::shutdown(app);
    let (dictation_result, (), ()) = tokio::join!(dictation, computer_use, hermes);
    if let Err(error) = dictation_result {
        tracing::warn!(%error, "dictation shutdown worker could not be joined");
    }
}

fn wait_for_cleanup(receiver: &Receiver<()>, timeout: Duration) -> bool {
    receiver.recv_timeout(timeout).is_ok()
}

fn run_bounded_cleanup<C>(deadline: Duration, cleanup: C) -> bool
where
    C: FnOnce() + Send + 'static,
{
    let (done_tx, done_rx) = mpsc::sync_channel(1);
    let spawned = thread::Builder::new()
        .name("june-shutdown-cleanup".to_string())
        .spawn(move || {
            cleanup();
            let _ = done_tx.send(());
        })
        .is_ok();
    spawned && wait_for_cleanup(&done_rx, deadline)
}

fn run_bounded_cleanup_if_idle<C>(
    coordinator: &ShutdownCoordinator,
    target: ShutdownTarget,
    deadline: Duration,
    cleanup: C,
) -> Option<bool>
where
    C: FnOnce() + Send + 'static,
{
    let BeginShutdown::Started(target) = coordinator.begin(target) else {
        return None;
    };
    let completed = run_bounded_cleanup(deadline, cleanup);
    if !completed {
        tracing::warn!(
            ?target,
            timeout_ms = deadline.as_millis(),
            "last-chance app cleanup hit its deadline"
        );
    }
    coordinator.mark_finalizing(target);
    Some(completed)
}

fn finalize(app: tauri::AppHandle, target: ShutdownTarget) {
    let final_app = app.clone();
    let scheduled = app.run_on_main_thread(move || match target {
        ShutdownTarget::Exit(code) => final_app.exit(code),
        ShutdownTarget::Restart => final_app.restart(),
    });
    if let Err(error) = scheduled {
        tracing::error!(%error, ?target, "could not schedule final shutdown action on the main thread");
        match target {
            ShutdownTarget::Exit(code) => app.exit(code),
            ShutdownTarget::Restart => app.request_restart(),
        }
    }
}

/// Acquires a synchronous mutex without allowing shutdown to wait forever on a
/// thread that may itself need the main event loop to make progress.
pub(crate) fn try_lock_for<T>(mutex: &Mutex<T>, timeout: Duration) -> Option<MutexGuard<'_, T>> {
    let deadline = Instant::now() + timeout;
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Some(guard),
            Err(TryLockError::Poisoned(error)) => return Some(error.into_inner()),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                thread::sleep(MUTEX_POLL_INTERVAL);
            }
            Err(TryLockError::WouldBlock) => return None,
        }
    }
}

/// Acquires an async mutex with a shutdown-only deadline.
pub(crate) async fn lock_async_for<T>(
    mutex: &tokio::sync::Mutex<T>,
    timeout: Duration,
) -> Option<tokio::sync::MutexGuard<'_, T>> {
    tokio::time::timeout(timeout, mutex.lock()).await.ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChildTermination {
    Exited,
    Killed,
    TimedOut,
    WaitFailed,
}

/// Polls a child with `try_wait`, then escalates to the platform kill primitive
/// and polls again. If the bounded poll expires after SIGKILL, ownership moves
/// to a detached reaper so a late exit is still waited and cannot become a
/// zombie without holding shutdown open.
pub(crate) fn terminate_child(
    child: Child,
    graceful_timeout: Duration,
    kill_timeout: Duration,
) -> ChildTermination {
    terminate_child_with(child, graceful_timeout, kill_timeout, |child| {
        let _ = child.kill();
    })
}

pub(crate) fn terminate_child_with(
    mut child: Child,
    graceful_timeout: Duration,
    kill_timeout: Duration,
    escalate: impl FnOnce(&mut Child),
) -> ChildTermination {
    match poll_child_exit(&mut child, graceful_timeout) {
        Ok(true) => return ChildTermination::Exited,
        Err(()) => return ChildTermination::WaitFailed,
        Ok(false) => {}
    }

    escalate(&mut child);
    match poll_child_exit(&mut child, kill_timeout) {
        Ok(true) => ChildTermination::Killed,
        Ok(false) => {
            spawn_detached_child_reaper(child);
            ChildTermination::TimedOut
        }
        Err(()) => ChildTermination::WaitFailed,
    }
}

/// Compatibility helper for pre-registration error paths that still need to
/// retain the `Child` on success. App-shutdown ownership paths use
/// [`terminate_child`] so a timed-out child is handed to a detached reaper.
pub(crate) fn terminate_child_in_place(
    child: &mut Child,
    graceful_timeout: Duration,
    kill_timeout: Duration,
) -> ChildTermination {
    match poll_child_exit(child, graceful_timeout) {
        Ok(true) => return ChildTermination::Exited,
        Err(()) => return ChildTermination::WaitFailed,
        Ok(false) => {}
    }
    let _ = child.kill();
    match poll_child_exit(child, kill_timeout) {
        Ok(true) => ChildTermination::Killed,
        Ok(false) => ChildTermination::TimedOut,
        Err(()) => ChildTermination::WaitFailed,
    }
}

fn spawn_detached_child_reaper(mut child: Child) {
    if let Err(error) = thread::Builder::new()
        .name("june-child-reaper".to_string())
        .spawn(move || {
            let _ = child.wait();
        })
    {
        tracing::warn!(%error, "could not start detached child reaper");
    }
}

fn poll_child_exit(child: &mut Child, timeout: Duration) -> Result<bool, ()> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(true),
            Ok(None) if Instant::now() < deadline => thread::sleep(CHILD_POLL_INTERVAL),
            Ok(None) => return Ok(false),
            Err(_) => return Err(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn deadline_covers_ordered_leaves(aggregate_ms: u64, leaves_ms: &[u64]) -> bool {
        aggregate_ms >= leaves_ms.iter().sum()
    }

    #[test]
    fn duplicate_requests_share_one_shutdown() {
        let coordinator = ShutdownCoordinator::default();
        assert_eq!(
            coordinator.begin(ShutdownTarget::Exit(0)),
            BeginShutdown::Started(ShutdownTarget::Exit(0))
        );
        assert_eq!(
            coordinator.begin(ShutdownTarget::Exit(0)),
            BeginShutdown::AlreadyRunning(ShutdownTarget::Exit(0))
        );
    }

    #[test]
    fn first_request_latches_exit_vs_restart() {
        let restart_first = ShutdownCoordinator::default();
        assert_eq!(
            restart_first.begin(ShutdownTarget::Restart),
            BeginShutdown::Started(ShutdownTarget::Restart)
        );
        assert_eq!(
            restart_first.begin(ShutdownTarget::Exit(7)),
            BeginShutdown::AlreadyRunning(ShutdownTarget::Restart)
        );

        let exit_first = ShutdownCoordinator::default();
        assert_eq!(
            exit_first.begin(ShutdownTarget::Exit(7)),
            BeginShutdown::Started(ShutdownTarget::Exit(7))
        );
        assert_eq!(
            exit_first.begin(ShutdownTarget::Restart),
            BeginShutdown::AlreadyRunning(ShutdownTarget::Exit(7))
        );
    }

    #[test]
    fn cleanup_wait_obeys_the_aggregate_deadline() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let started = Instant::now();
        assert!(!wait_for_cleanup(&receiver, Duration::from_millis(20)));
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(sender);
    }

    #[test]
    fn aggregate_deadline_covers_the_ordered_hermes_leaf_budgets() {
        assert!(deadline_covers_ordered_leaves(
            SHUTDOWN_AGGREGATE_DEADLINE_MS,
            &[
                crate::hermes_bridge::SHUTDOWN_START_QUIESCE_TIMEOUT_MS,
                crate::hermes_bridge::GATEWAY_SHUTDOWN_TOTAL_TIMEOUT_MS,
                HERMES_FINALIZATION_BUDGET_MS,
            ],
        ));
    }

    #[test]
    fn exit_fallback_runs_only_while_the_coordinator_is_idle() {
        let coordinator = ShutdownCoordinator::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let first_calls = Arc::clone(&calls);
        assert_eq!(
            run_bounded_cleanup_if_idle(
                &coordinator,
                ShutdownTarget::Exit(0),
                Duration::from_secs(1),
                move || {
                    first_calls.fetch_add(1, Ordering::SeqCst);
                },
            ),
            Some(true)
        );
        assert!(matches!(
            *coordinator.lock_phase(),
            ShutdownPhase::Finalizing(ShutdownTarget::Exit(0))
        ));

        let duplicate_calls = Arc::clone(&calls);
        assert_eq!(
            run_bounded_cleanup_if_idle(
                &coordinator,
                ShutdownTarget::Restart,
                Duration::from_secs(1),
                move || {
                    duplicate_calls.fetch_add(1, Ordering::SeqCst);
                },
            ),
            None
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let running = ShutdownCoordinator::default();
        assert_eq!(
            running.begin(ShutdownTarget::Restart),
            BeginShutdown::Started(ShutdownTarget::Restart)
        );
        assert_eq!(
            run_bounded_cleanup_if_idle(
                &running,
                ShutdownTarget::Exit(0),
                Duration::from_secs(1),
                || panic!("running cleanup must remain owned by its first caller"),
            ),
            None
        );
    }

    #[test]
    fn supervised_request_returns_before_blocked_cleanup() {
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let (final_tx, final_rx) = mpsc::sync_channel(1);
        let started = Instant::now();
        spawn_supervised_shutdown(
            Duration::from_millis(20),
            move || {
                let _ = release_rx.recv();
            },
            move |completed| {
                let _ = final_tx.send(completed);
            },
        )
        .expect("spawn supervisor");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "request path must return control to the main event loop"
        );
        assert!(
            !final_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("deadline finalizer"),
            "deadline must finalize while cleanup remains blocked"
        );
        let _ = release_tx.send(());
    }

    #[test]
    fn mutex_acquisition_obeys_its_deadline() {
        let mutex = Mutex::new(());
        let _guard = mutex.lock().expect("test lock");
        let started = Instant::now();
        assert!(try_lock_for(&mutex, Duration::from_millis(20)).is_none());
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[cfg(unix)]
    #[test]
    fn stopped_child_is_killed_and_reaped_without_blocking_wait() {
        use std::process::{Command, Stdio};

        let child = Command::new("/bin/sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn stuck child");
        let result = unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGSTOP) };
        assert_eq!(result, 0, "stop child");

        let started = Instant::now();
        assert_eq!(
            terminate_child(child, Duration::from_millis(20), Duration::from_secs(1)),
            ChildTermination::Killed
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn timed_out_kill_is_eventually_reaped_by_a_detached_thread() {
        use std::process::{Command, Stdio};

        let child = Command::new("/bin/sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn child");
        let pid = child.id() as libc::pid_t;
        assert_eq!(
            terminate_child(child, Duration::ZERO, Duration::ZERO),
            ChildTermination::TimedOut
        );

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let result = unsafe { libc::kill(pid, 0) };
            if result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "detached reaper left the killed child as a zombie"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}
