pub mod questions;

use crate::{
    db::repositories::{P3aPendingReport, Repositories},
    domain::types::AppError,
    june_api::{submit_p3a_report, P3aReportRequest as JuneP3aReportRequest},
    p3a::questions::{Question, ALL_QUESTIONS},
};
use chrono::{Datelike, Utc};
use serde::{Deserialize, Serialize};
use std::{fs, future::Future, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, RwLock};

const CONSENT_VERSION: u32 = 1;
const P3A_SCHEMA_VERSION: u32 = 1;
const REPORTER_SIGNAL_CAPACITY: usize = 1;
const REPORT_RETRY_BASE_DELAY: Duration = Duration::from_secs(1);
const REPORT_RETRY_MAX_DELAY: Duration = Duration::from_secs(60);

pub struct P3aSettingsState {
    path: PathBuf,
    settings: Mutex<P3aSettings>,
    transition_gate: RwLock<()>,
}

#[derive(Clone)]
pub struct P3aReporterState {
    signal_tx: mpsc::Sender<()>,
}

impl P3aReporterState {
    fn signal(&self) {
        match self.signal_tx.try_send(()) {
            Ok(()) | Err(mpsc::error::TrySendError::Full(())) => {}
            Err(mpsc::error::TrySendError::Closed(())) => {
                tracing::warn!("P3A reporter is unavailable");
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingEventReport {
    question: Question,
    epoch: String,
    bucket: u8,
}

enum SubmitOutcome {
    Accepted,
    Paused,
    Retry(AppError),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FlushOutcome {
    Complete,
    Paused,
    Retry,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct P3aSettings {
    pub enabled: bool,
    pub consent_version: u32,
    pub consented_at_week: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct P3aSettingsResponse {
    pub settings: P3aSettings,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetP3aEnabledRequest {
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct P3aRecordRequest {
    pub question_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct P3aQuestionDto {
    pub id: &'static str,
    pub prompt: &'static str,
    pub buckets: &'static [&'static str],
    pub decision: &'static str,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct P3aQuestionCatalogResponse {
    pub questions: Vec<P3aQuestionDto>,
}

pub fn setup(app: &mut tauri::App) {
    let path = settings_path(app.handle()).unwrap_or_else(|| PathBuf::from("p3a-settings.json"));
    let settings = load_settings_from_disk(app.handle());
    let reporting_enabled = settings.enabled;
    let (signal_tx, signal_rx) = mpsc::channel(REPORTER_SIGNAL_CAPACITY);
    app.manage(P3aSettingsState {
        path,
        settings: Mutex::new(settings),
        transition_gate: RwLock::new(()),
    });
    app.manage(P3aReporterState { signal_tx });

    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(run_app_reporter(app_handle, signal_rx));
    if reporting_enabled {
        signal_reporter(app.handle());
    }
}

#[tauri::command]
pub fn p3a_settings(state: State<'_, P3aSettingsState>) -> Result<P3aSettingsResponse, AppError> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| AppError::new("p3a_settings_unavailable", "Settings lock failed."))?
        .clone();
    Ok(P3aSettingsResponse { settings })
}

#[tauri::command]
pub fn p3a_question_catalog() -> P3aQuestionCatalogResponse {
    let questions = ALL_QUESTIONS
        .iter()
        .map(|definition| P3aQuestionDto {
            id: definition.id,
            prompt: definition.prompt,
            buckets: definition.buckets,
            decision: definition.decision,
        })
        .collect();
    P3aQuestionCatalogResponse { questions }
}

#[tauri::command]
pub async fn set_p3a_enabled(
    app: AppHandle,
    state: State<'_, P3aSettingsState>,
    request: SetP3aEnabledRequest,
) -> Result<P3aSettingsResponse, AppError> {
    let _transition = state.transition_gate.write().await;
    if !request.enabled {
        clear_local_counters(&app).await?;
    }

    let updated = {
        let mut settings = state
            .settings
            .lock()
            .map_err(|_| AppError::new("p3a_settings_unavailable", "Settings lock failed."))?;
        let updated = P3aSettings {
            enabled: request.enabled,
            consent_version: CONSENT_VERSION,
            consented_at_week: request.enabled.then(current_iso_week),
        };
        save_settings(&state, &updated)?;
        *settings = updated.clone();
        updated
    };

    if request.enabled {
        signal_reporter(&app);
    }

    Ok(P3aSettingsResponse { settings: updated })
}

#[tauri::command]
pub async fn p3a_record(app: AppHandle, request: P3aRecordRequest) -> Result<(), AppError> {
    let question = Question::from_id(request.question_id.trim())
        .ok_or_else(|| AppError::new("p3a_unknown_question", "Unknown telemetry question."))?;
    record_question(&app, question).await
}

pub fn record_question_best_effort(app: AppHandle, question: Question) {
    tokio::spawn(async move {
        if let Err(error) = record_question(&app, question).await {
            tracing::warn!(
                question_id = question.id(),
                error_code = %error.code,
                error_message = %error.message,
                "P3A event record failed"
            );
        }
    });
}

pub async fn record_question(app: &AppHandle, question: Question) -> Result<(), AppError> {
    let state = app.state::<P3aSettingsState>();
    let _transition = state.transition_gate.read().await;
    if !reporting_enabled(app)? {
        return Ok(());
    }
    let repos = crate::commands::repositories(app).await?;
    let epoch = current_iso_week();
    persist_event_and_signal(&repos, &app.state::<P3aReporterState>(), question, &epoch)
        .await
        .map_err(|error| AppError::new("p3a_counter_failed", error.to_string()))?;
    Ok(())
}

async fn persist_event_and_signal(
    repos: &Repositories,
    reporter: &P3aReporterState,
    question: Question,
    epoch: &str,
) -> Result<(), sqlx::error::Error> {
    repos.increment_p3a_counter(question.id(), epoch, 1).await?;
    reporter.signal();
    Ok(())
}

fn signal_reporter(app: &AppHandle) {
    app.state::<P3aReporterState>().signal();
}

fn reporting_enabled(app: &AppHandle) -> Result<bool, AppError> {
    app.state::<P3aSettingsState>()
        .settings
        .lock()
        .map(|settings| settings.enabled)
        .map_err(|_| AppError::new("p3a_settings_unavailable", "Settings lock failed."))
}

async fn run_app_reporter(app: AppHandle, signal_rx: mpsc::Receiver<()>) {
    let repos = match crate::commands::repositories(&app).await {
        Ok(repos) => repos,
        Err(error) => {
            tracing::warn!(
                error_code = %error.code,
                error_message = %error.message,
                "P3A reporter could not open local counters"
            );
            return;
        }
    };
    let submit_app = app.clone();
    run_reporter(
        repos,
        signal_rx,
        move |report| {
            let app = submit_app.clone();
            async move { submit_event_report(&app, report).await }
        },
        tokio::time::sleep,
    )
    .await;
}

async fn run_reporter<Submit, SubmitFuture, Wait, WaitFuture>(
    repos: Repositories,
    mut signal_rx: mpsc::Receiver<()>,
    submit: Submit,
    wait: Wait,
) where
    Submit: Fn(PendingEventReport) -> SubmitFuture,
    SubmitFuture: Future<Output = SubmitOutcome>,
    Wait: Fn(Duration) -> WaitFuture,
    WaitFuture: Future<Output = ()>,
{
    while signal_rx.recv().await.is_some() {
        let mut retry_delay = REPORT_RETRY_BASE_DELAY;
        loop {
            drain_coalesced_signals(&mut signal_rx);
            match flush_pending_event_reports(&repos, &submit).await {
                FlushOutcome::Complete | FlushOutcome::Paused => break,
                FlushOutcome::Retry => {
                    wait(retry_delay).await;
                    if signal_rx.is_closed() {
                        return;
                    }
                    retry_delay = next_retry_delay(retry_delay);
                }
            }
        }
    }
}

fn drain_coalesced_signals(signal_rx: &mut mpsc::Receiver<()>) {
    while signal_rx.try_recv().is_ok() {}
}

fn next_retry_delay(current: Duration) -> Duration {
    current
        .checked_mul(2)
        .unwrap_or(REPORT_RETRY_MAX_DELAY)
        .min(REPORT_RETRY_MAX_DELAY)
}

async fn flush_pending_event_reports<Submit, SubmitFuture>(
    repos: &Repositories,
    submit: &Submit,
) -> FlushOutcome
where
    Submit: Fn(PendingEventReport) -> SubmitFuture,
    SubmitFuture: Future<Output = SubmitOutcome>,
{
    let pending = match repos.unreported_p3a_counters().await {
        Ok(pending) => pending,
        Err(error) => {
            tracing::warn!(%error, "P3A pending event query failed");
            return FlushOutcome::Retry;
        }
    };
    for report in pending {
        match submit_pending_event_report(repos, report, submit).await {
            FlushOutcome::Complete => {}
            outcome => return outcome,
        }
    }
    FlushOutcome::Complete
}

async fn submit_pending_event_report<Submit, SubmitFuture>(
    repos: &Repositories,
    report: P3aPendingReport,
    submit: &Submit,
) -> FlushOutcome
where
    Submit: Fn(PendingEventReport) -> SubmitFuture,
    SubmitFuture: Future<Output = SubmitOutcome>,
{
    let Some(question) = Question::from_id(&report.question_id) else {
        tracing::warn!(question_id = %report.question_id, "Skipping unknown P3A counter");
        return FlushOutcome::Complete;
    };

    let pending_events = report.raw_value.saturating_sub(report.reported_value);
    if pending_events == 0 {
        return FlushOutcome::Complete;
    }

    let mut reported_value = report.reported_value;
    let bucket = question.event_bucket();
    for _ in 0..pending_events {
        let event = PendingEventReport {
            question,
            epoch: report.epoch.clone(),
            bucket,
        };
        match submit(event).await {
            SubmitOutcome::Accepted => {}
            SubmitOutcome::Paused => return FlushOutcome::Paused,
            SubmitOutcome::Retry(error) => {
                tracing::warn!(
                    question_id = question.id(),
                    epoch = %report.epoch,
                    bucket,
                    error_code = %error.code,
                    error_message = %error.message,
                    "P3A event upload failed"
                );
                return FlushOutcome::Retry;
            }
        }
        reported_value = reported_value.saturating_add(1);
        if let Err(error) = repos
            .mark_p3a_events_reported(question.id(), &report.epoch, reported_value)
            .await
        {
            tracing::warn!(
                question_id = question.id(),
                epoch = %report.epoch,
                reported_value,
                %error,
                "P3A reported event cursor update failed"
            );
            return FlushOutcome::Retry;
        }
    }
    FlushOutcome::Complete
}

async fn submit_event_report(app: &AppHandle, report: PendingEventReport) -> SubmitOutcome {
    let state = app.state::<P3aSettingsState>();
    let _transition = state.transition_gate.read().await;
    match reporting_enabled(app) {
        Ok(true) => {}
        Ok(false) => return SubmitOutcome::Paused,
        Err(error) => return SubmitOutcome::Retry(error),
    }

    match submit_p3a_report(JuneP3aReportRequest {
        schema: P3A_SCHEMA_VERSION,
        question_id: report.question.id().to_string(),
        epoch: report.epoch,
        platform: current_platform().to_string(),
        version_series: current_version_series(),
        bucket: report.bucket,
    })
    .await
    {
        Ok(()) => SubmitOutcome::Accepted,
        Err(error) => SubmitOutcome::Retry(error),
    }
}

async fn clear_local_counters(app: &AppHandle) -> Result<(), AppError> {
    let repos = crate::commands::repositories(app).await?;
    repos
        .clear_p3a_counters()
        .await
        .map_err(|error| AppError::new("p3a_clear_failed", error.to_string()))
}

fn default_settings() -> P3aSettings {
    P3aSettings {
        enabled: false,
        consent_version: CONSENT_VERSION,
        consented_at_week: None,
    }
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("p3a-settings.json"))
}

fn load_settings_from_disk(app: &AppHandle) -> P3aSettings {
    let defaults = default_settings();
    let Some(path) = settings_path(app) else {
        return defaults;
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|settings| serde_json::from_str::<P3aSettings>(&settings).ok())
        .map(sanitize_settings)
        .unwrap_or(defaults)
}

fn sanitize_settings(settings: P3aSettings) -> P3aSettings {
    if settings.enabled {
        P3aSettings {
            enabled: true,
            consent_version: settings.consent_version.max(1),
            consented_at_week: settings
                .consented_at_week
                .filter(|week| is_valid_iso_week(week)),
        }
    } else {
        default_settings()
    }
}

fn save_settings(state: &P3aSettingsState, settings: &P3aSettings) -> Result<(), AppError> {
    if let Some(parent) = state.path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::new("p3a_settings_save_failed", error.to_string()))?;
    }
    let serialized = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::new("p3a_settings_save_failed", error.to_string()))?;
    fs::write(&state.path, serialized)
        .map_err(|error| AppError::new("p3a_settings_save_failed", error.to_string()))
}

fn current_iso_week() -> String {
    iso_week_for(Utc::now())
}

fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

fn current_version_series() -> String {
    version_series(env!("CARGO_PKG_VERSION"))
}

fn version_series(version: &str) -> String {
    let mut parts = version.split('.');
    let major = parts.next().and_then(version_number_prefix);
    let minor = parts.next().and_then(version_number_prefix);
    match (major, minor) {
        (Some(major), Some(minor)) => format!("{major}.{minor}.x"),
        _ => version
            .chars()
            .filter(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '+' | '-')
            })
            .take(32)
            .collect::<String>(),
    }
}

fn version_number_prefix(part: &str) -> Option<&str> {
    let len = part
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .map(char::len_utf8)
        .sum();
    (len > 0).then_some(&part[..len])
}

fn iso_week_for(time: chrono::DateTime<Utc>) -> String {
    let week = time.iso_week();
    format!("{}-W{:02}", week.year(), week.week())
}

fn is_valid_iso_week(value: &str) -> bool {
    let Some((year, week)) = value.split_once("-W") else {
        return false;
    };
    year.len() == 4
        && year.chars().all(|character| character.is_ascii_digit())
        && week.len() == 2
        && week
            .parse::<u32>()
            .is_ok_and(|week| (1..=53).contains(&week))
}

#[cfg(test)]
mod tests {
    use super::{
        is_valid_iso_week, iso_week_for, next_retry_delay, persist_event_and_signal, run_reporter,
        sanitize_settings, version_series, P3aReporterState, P3aSettings, SubmitOutcome,
        REPORTER_SIGNAL_CAPACITY, REPORT_RETRY_BASE_DELAY, REPORT_RETRY_MAX_DELAY,
    };
    use crate::{
        db::{migrations::run_migrations, repositories::Repositories},
        domain::types::AppError,
        p3a::questions::Question,
    };
    use chrono::{TimeZone, Utc};
    use sqlx_sqlite::SqlitePoolOptions;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
        time::Duration,
    };
    use tokio::{
        sync::{mpsc, Barrier, Notify},
        time::{timeout, Instant},
    };

    const TEST_EPOCH: &str = "2026-W28";

    async fn test_repositories() -> Repositories {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory sqlite should open");
        run_migrations(&pool).await.expect("migrations should run");
        Repositories::new(pool)
    }

    fn reporter_channel() -> (P3aReporterState, mpsc::Receiver<()>) {
        let (signal_tx, signal_rx) = mpsc::channel(REPORTER_SIGNAL_CAPACITY);
        (P3aReporterState { signal_tx }, signal_rx)
    }

    async fn wait_for_reported(repos: &Repositories, question: Question, expected: u64) {
        timeout(Duration::from_secs(2), async {
            loop {
                let reported = repos
                    .p3a_counter_state(question.id(), TEST_EPOCH)
                    .await
                    .expect("counter state should load")
                    .map(|state| state.reported_value)
                    .unwrap_or_default();
                if reported == expected {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("reporter should advance the cursor");
    }

    #[derive(Default)]
    struct DelayedSink {
        calls: AtomicUsize,
        accepted: AtomicUsize,
        active: AtomicUsize,
        max_active: AtomicUsize,
        first_started: Notify,
        release_first: Notify,
    }

    impl DelayedSink {
        async fn submit(&self) -> SubmitOutcome {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);
            if call == 0 {
                self.first_started.notify_one();
                self.release_first.notified().await;
            }
            self.accepted.fetch_add(1, Ordering::SeqCst);
            self.active.fetch_sub(1, Ordering::SeqCst);
            SubmitOutcome::Accepted
        }
    }

    struct FailThenAcceptSink {
        failures: usize,
        calls: AtomicUsize,
        accepted: AtomicUsize,
        active: AtomicUsize,
        max_active: AtomicUsize,
    }

    impl FailThenAcceptSink {
        fn new(failures: usize) -> Self {
            Self {
                failures,
                calls: AtomicUsize::new(0),
                accepted: AtomicUsize::new(0),
                active: AtomicUsize::new(0),
                max_active: AtomicUsize::new(0),
            }
        }

        async fn submit(&self) -> SubmitOutcome {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);
            let outcome = if call < self.failures {
                SubmitOutcome::Retry(AppError::new("test_failure", "Fake sink failed."))
            } else {
                self.accepted.fetch_add(1, Ordering::SeqCst);
                SubmitOutcome::Accepted
            };
            self.active.fetch_sub(1, Ordering::SeqCst);
            outcome
        }
    }

    struct StopAfterAcceptedSink {
        accepted_before_failure: usize,
        calls: AtomicUsize,
        accepted: AtomicUsize,
        failed: Notify,
    }

    impl StopAfterAcceptedSink {
        fn new(accepted_before_failure: usize) -> Self {
            Self {
                accepted_before_failure,
                calls: AtomicUsize::new(0),
                accepted: AtomicUsize::new(0),
                failed: Notify::new(),
            }
        }

        async fn submit(&self) -> SubmitOutcome {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call < self.accepted_before_failure {
                self.accepted.fetch_add(1, Ordering::SeqCst);
                SubmitOutcome::Accepted
            } else {
                self.failed.notify_one();
                SubmitOutcome::Retry(AppError::new("test_failure", "Fake sink failed."))
            }
        }
    }

    #[test]
    fn formats_iso_week() {
        assert_eq!(
            iso_week_for(Utc.with_ymd_and_hms(2026, 7, 7, 12, 0, 0).unwrap()),
            "2026-W28"
        );
    }

    #[test]
    fn formats_version_series() {
        assert_eq!(version_series("0.0.30"), "0.0.x");
        assert_eq!(version_series("1.2.3-beta.1"), "1.2.x");
    }

    #[test]
    fn disabled_settings_drop_consent_week() {
        let settings = sanitize_settings(P3aSettings {
            enabled: false,
            consent_version: 9,
            consented_at_week: Some("2026-W28".to_string()),
        });
        assert!(!settings.enabled);
        assert_eq!(settings.consented_at_week, None);
    }

    #[test]
    fn invalid_consent_week_is_removed() {
        let settings = sanitize_settings(P3aSettings {
            enabled: true,
            consent_version: 1,
            consented_at_week: Some("2026-07-07".to_string()),
        });
        assert!(settings.enabled);
        assert_eq!(settings.consented_at_week, None);
    }

    #[test]
    fn validates_iso_week_shape() {
        assert!(is_valid_iso_week("2026-W28"));
        assert!(!is_valid_iso_week("2026-W00"));
        assert!(!is_valid_iso_week("2026-W54"));
        assert!(!is_valid_iso_week("2026-28"));
    }

    #[tokio::test]
    async fn serializes_and_coalesces_concurrent_event_delivery() {
        let repos = test_repositories().await;
        let (reporter, signal_rx) = reporter_channel();
        let reporter = Arc::new(reporter);
        let sink = Arc::new(DelayedSink::default());
        let worker_sink = sink.clone();
        let worker = tokio::spawn(run_reporter(
            repos.clone(),
            signal_rx,
            move |_| {
                let sink = worker_sink.clone();
                async move { sink.submit().await }
            },
            |_| async {},
        ));

        let barrier = Arc::new(Barrier::new(21));
        let mut producers = Vec::new();
        for _ in 0..20 {
            let repos = repos.clone();
            let reporter = reporter.clone();
            let barrier = barrier.clone();
            producers.push(tokio::spawn(async move {
                barrier.wait().await;
                persist_event_and_signal(
                    &repos,
                    &reporter,
                    Question::DictationSessions,
                    TEST_EPOCH,
                )
                .await
                .expect("event should persist");
            }));
        }
        barrier.wait().await;
        for producer in producers {
            producer.await.expect("producer should finish");
        }

        sink.first_started.notified().await;
        sink.release_first.notify_one();
        wait_for_reported(&repos, Question::DictationSessions, 20).await;

        assert_eq!(sink.calls.load(Ordering::SeqCst), 20);
        assert_eq!(sink.accepted.load(Ordering::SeqCst), 20);
        assert_eq!(sink.max_active.load(Ordering::SeqCst), 1);

        drop(reporter);
        worker.await.expect("reporter should stop");
    }

    #[tokio::test]
    async fn producer_does_not_wait_for_a_large_backlog() {
        let repos = test_repositories().await;
        repos
            .increment_p3a_counter(Question::DictationSessions.id(), TEST_EPOCH, 10_000)
            .await
            .expect("backlog should persist");
        let (reporter, signal_rx) = reporter_channel();
        let sink = Arc::new(DelayedSink::default());
        let worker_sink = sink.clone();
        let worker = tokio::spawn(run_reporter(
            repos.clone(),
            signal_rx,
            move |_| {
                let sink = worker_sink.clone();
                async move { sink.submit().await }
            },
            |_| async {},
        ));

        reporter.signal();
        sink.first_started.notified().await;
        let started = Instant::now();
        timeout(
            Duration::from_secs(1),
            persist_event_and_signal(&repos, &reporter, Question::DictationSessions, TEST_EPOCH),
        )
        .await
        .expect("producer should not wait for the blocked reporter")
        .expect("event should persist");
        assert!(started.elapsed() < Duration::from_secs(1));

        worker.abort();
        let _ = worker.await;
    }

    #[tokio::test]
    async fn retries_on_one_worker_with_bounded_backoff() {
        let repos = test_repositories().await;
        let (reporter, signal_rx) = reporter_channel();
        let sink = Arc::new(FailThenAcceptSink::new(2));
        let worker_sink = sink.clone();
        let delays = Arc::new(Mutex::new(Vec::new()));
        let worker_delays = delays.clone();
        let worker = tokio::spawn(run_reporter(
            repos.clone(),
            signal_rx,
            move |_| {
                let sink = worker_sink.clone();
                async move { sink.submit().await }
            },
            move |delay| {
                worker_delays.lock().expect("delay lock").push(delay);
                async {}
            },
        ));

        persist_event_and_signal(&repos, &reporter, Question::AgentSessions, TEST_EPOCH)
            .await
            .expect("event should persist");
        wait_for_reported(&repos, Question::AgentSessions, 1).await;

        assert_eq!(sink.calls.load(Ordering::SeqCst), 3);
        assert_eq!(sink.accepted.load(Ordering::SeqCst), 1);
        assert_eq!(sink.max_active.load(Ordering::SeqCst), 1);
        assert_eq!(
            *delays.lock().expect("delay lock"),
            vec![
                REPORT_RETRY_BASE_DELAY,
                REPORT_RETRY_BASE_DELAY.checked_mul(2).unwrap()
            ]
        );
        assert_eq!(
            next_retry_delay(REPORT_RETRY_MAX_DELAY),
            REPORT_RETRY_MAX_DELAY
        );

        drop(reporter);
        worker.await.expect("reporter should stop");
    }

    #[tokio::test]
    async fn restart_resumes_from_each_durable_accepted_cursor() {
        let repos = test_repositories().await;
        repos
            .increment_p3a_counter(Question::NotesMeetingsRecorded.id(), TEST_EPOCH, 5)
            .await
            .expect("backlog should persist");

        let (first_reporter, first_signal_rx) = reporter_channel();
        let first_sink = Arc::new(StopAfterAcceptedSink::new(2));
        let worker_sink = first_sink.clone();
        let retry_release = Arc::new(Notify::new());
        let worker_retry_release = retry_release.clone();
        let first_worker = tokio::spawn(run_reporter(
            repos.clone(),
            first_signal_rx,
            move |_| {
                let sink = worker_sink.clone();
                async move { sink.submit().await }
            },
            move |_| {
                let retry_release = worker_retry_release.clone();
                async move { retry_release.notified().await }
            },
        ));
        first_reporter.signal();
        first_sink.failed.notified().await;
        wait_for_reported(&repos, Question::NotesMeetingsRecorded, 2).await;
        drop(first_reporter);
        retry_release.notify_one();
        first_worker.await.expect("first reporter should stop");

        let (second_reporter, second_signal_rx) = reporter_channel();
        let second_sink = Arc::new(FailThenAcceptSink::new(0));
        let worker_sink = second_sink.clone();
        let second_worker = tokio::spawn(run_reporter(
            repos.clone(),
            second_signal_rx,
            move |_| {
                let sink = worker_sink.clone();
                async move { sink.submit().await }
            },
            |_| async {},
        ));
        second_reporter.signal();
        wait_for_reported(&repos, Question::NotesMeetingsRecorded, 5).await;

        assert_eq!(first_sink.accepted.load(Ordering::SeqCst), 2);
        assert_eq!(second_sink.accepted.load(Ordering::SeqCst), 3);
        assert_eq!(
            first_sink.accepted.load(Ordering::SeqCst)
                + second_sink.accepted.load(Ordering::SeqCst),
            5
        );

        drop(second_reporter);
        second_worker.await.expect("second reporter should stop");
    }
}
