use crate::domain::types::AppError;
use std::process::Child;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Mutex, MutexGuard, TryLockError};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;

/// App teardown gets this long in total, regardless of which individual leaf
/// is slow or stuck. The supervisor is separate from the cleanup worker, so a
/// blocking syscall in one leaf cannot postpone the final exit/restart.
const SHUTDOWN_AGGREGATE_DEADLINE: Duration = Duration::from_secs(5);
const MUTEX_POLL_INTERVAL: Duration = Duration::from_millis(5);
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(10);

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
}

impl Default for ShutdownCoordinator {
    fn default() -> Self {
        Self {
            phase: Mutex::new(ShutdownPhase::Idle),
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
    }

    fn final_exit_is_allowed(&self) -> bool {
        matches!(*self.lock_phase(), ShutdownPhase::Finalizing(_))
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

pub(crate) fn request_restart(app: &tauri::AppHandle) -> Result<(), AppError> {
    request(app, ShutdownTarget::Restart)
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
    crate::dictation::stop_helper(app);
    crate::computer_use::shutdown(app).await;
    // This call preserves the load-bearing order inside the Hermes subsystem:
    // quiesce starts -> unload the Gateway -> reap runtimes -> stop the
    // provider proxy.
    crate::hermes_bridge::shutdown(app).await;
}

fn wait_for_cleanup(receiver: &Receiver<()>, timeout: Duration) -> bool {
    receiver.recv_timeout(timeout).is_ok()
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
/// and polls again. It never calls `Child::wait`, so even an uninterruptible or
/// stopped child cannot hold the shutdown worker indefinitely.
pub(crate) fn terminate_child(
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

        let mut child = Command::new("/bin/sleep")
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
            terminate_child(
                &mut child,
                Duration::from_millis(20),
                Duration::from_secs(1)
            ),
            ChildTermination::Killed
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
