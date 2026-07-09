//! Connector trigger daemon.
//!
//! A background tokio task that polls Google for the events routines subscribe
//! to and wakes the matching routine through the bridge cron `trigger` action.
//! The event is a wake-up only: the routine re-reads state through its tools.
//!
//! - `email_received`: Gmail `history.list` from a stored cursor (seeded from
//!   the profile's history id on the first run). New INBOX messages fire the
//!   routine; the cursor advances.
//! - `event_upcoming`: a Calendar window scan; an event with external attendees
//!   starting within the configured lead time fires the routine, tracked per
//!   event id in a per-job cursor so it never fires twice for the same event.
//!
//! Cadence adapts: ~90s for mail, ~5min for calendar, backing off to ~5min for
//! everything when the machine is on battery below 20% and discharging, or when
//! no triggers are configured. A single account's error never takes the daemon
//! down, and nothing here logs a token or any mail or event content.

use crate::connectors::google::{self, GoogleApiError, ListEventsParams};
use crate::db::repositories::{ConnectorTriggerRecord, Repositories};
use crate::domain::types::AppError;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const STARTUP_DELAY: Duration = Duration::from_secs(30);
const GMAIL_PERIOD: Duration = Duration::from_secs(90);
const CALENDAR_PERIOD: Duration = Duration::from_secs(300);
/// Cadence when the machine is on battery below the threshold and discharging,
/// or when there is nothing to poll.
const BACKOFF_PERIOD: Duration = Duration::from_secs(300);
const MIN_SLEEP: Duration = Duration::from_secs(5);
const BATTERY_LOW_PERCENT: u32 = 20;
const DEFAULT_LEAD_MINUTES: i64 = 15;
const EMAIL_KIND: &str = "email_received";
const EVENT_KIND: &str = "event_upcoming";

/// Spawn the trigger daemon. Called once from app setup after the bridge init.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        run(app).await;
    });
}

async fn run(app: AppHandle) {
    let mut next_gmail = Instant::now();
    let mut next_calendar = Instant::now();
    loop {
        let backoff = battery_low_and_discharging();
        let now = Instant::now();

        let mut had_triggers = false;
        if now >= next_gmail {
            had_triggers |= poll_kind(&app, EMAIL_KIND).await;
            let period = if backoff {
                BACKOFF_PERIOD
            } else {
                GMAIL_PERIOD
            };
            next_gmail = Instant::now() + period;
        }
        if now >= next_calendar {
            had_triggers |= poll_kind(&app, EVENT_KIND).await;
            next_calendar = Instant::now() + CALENDAR_PERIOD;
        }

        // Idle backoff: with nothing subscribed, wait a full backoff period
        // before looking again instead of spinning on the short mail cadence.
        let soonest = next_gmail.min(next_calendar);
        let mut sleep = soonest.saturating_duration_since(Instant::now());
        if !had_triggers {
            sleep = sleep.max(BACKOFF_PERIOD);
        }
        tokio::time::sleep(sleep.max(MIN_SLEEP)).await;
    }
}

/// Poll every trigger of one kind, grouped so each account is queried once.
/// Returns whether any triggers of this kind exist (for idle backoff).
async fn poll_kind(app: &AppHandle, kind: &str) -> bool {
    let Ok(repos) = crate::commands::repositories(app).await else {
        return false;
    };
    let triggers = match repos.list_connector_triggers(None).await {
        Ok(triggers) => triggers,
        Err(error) => {
            tracing::warn!(error_code = %AppError::from(error).code, kind, "connector triggers query failed");
            return false;
        }
    };
    let relevant: Vec<ConnectorTriggerRecord> =
        triggers.into_iter().filter(|t| t.kind == kind).collect();
    if relevant.is_empty() {
        return false;
    }

    if kind == EMAIL_KIND {
        // One history.list per account, firing every job subscribed to it.
        let mut by_account: HashMap<String, Vec<String>> = HashMap::new();
        for trigger in relevant {
            by_account
                .entry(trigger.account_id)
                .or_default()
                .push(trigger.job_id);
        }
        for (account_id, job_ids) in by_account {
            if let Err(error) = poll_email_account(app, &repos, &account_id, &job_ids).await {
                tracing::warn!(error_code = %error.code, kind, "connector email trigger poll failed");
            }
        }
    } else {
        // event_upcoming is per job: each carries its own lead time and fired
        // set, so poll each trigger independently.
        for trigger in relevant {
            if let Err(error) = poll_event_trigger(app, &repos, &trigger).await {
                tracing::warn!(error_code = %error.code, kind, "connector event trigger poll failed");
            }
        }
    }
    true
}

// --- Email --------------------------------------------------------------------

async fn poll_email_account(
    app: &AppHandle,
    repos: &Repositories,
    account_id: &str,
    job_ids: &[String],
) -> Result<(), AppError> {
    let token = crate::connectors::google_access_token(app, account_id).await?;
    let cursor = repos.trigger_cursor(account_id, EMAIL_KIND).await?;

    let Some(cursor) = cursor else {
        // First run establishes the baseline; nothing fires until the next
        // poll sees mail that arrived after this point.
        let profile = call_gmail_profile(app, account_id, &token).await?;
        if let Some(history_id) = profile.history_id {
            repos
                .set_trigger_cursor(account_id, EMAIL_KIND, &history_id)
                .await?;
        }
        return Ok(());
    };

    let delta = call_gmail_history(app, account_id, &token, &cursor).await?;
    // Only INBOX messages count; history_list already filters to INBOX adds.
    if !delta.added.is_empty() {
        for job_id in job_ids {
            fire(app, job_id).await;
        }
    }
    if let Some(history_id) = delta.history_id {
        repos
            .set_trigger_cursor(account_id, EMAIL_KIND, &history_id)
            .await?;
    }
    Ok(())
}

async fn call_gmail_profile(
    app: &AppHandle,
    account_id: &str,
    token: &str,
) -> Result<google::GmailProfile, AppError> {
    match google::get_profile(token).await {
        Ok(profile) => Ok(profile),
        Err(GoogleApiError::Unauthorized) => {
            let token =
                crate::connectors::force_refresh_google_access_token(app, account_id).await?;
            google::get_profile(&token).await.map_err(Into::into)
        }
        Err(error) => Err(error.into()),
    }
}

async fn call_gmail_history(
    app: &AppHandle,
    account_id: &str,
    token: &str,
    cursor: &str,
) -> Result<google::HistoryDelta, AppError> {
    match google::history_list(token, cursor, None).await {
        Ok(delta) => Ok(delta),
        Err(GoogleApiError::Unauthorized) => {
            let token =
                crate::connectors::force_refresh_google_access_token(app, account_id).await?;
            google::history_list(&token, cursor, None)
                .await
                .map_err(Into::into)
        }
        Err(error) => Err(error.into()),
    }
}

// --- Calendar -----------------------------------------------------------------

async fn poll_event_trigger(
    app: &AppHandle,
    repos: &Repositories,
    trigger: &ConnectorTriggerRecord,
) -> Result<(), AppError> {
    let account_id = &trigger.account_id;
    let job_id = &trigger.job_id;
    let lead_minutes = lead_minutes_from_config(&trigger.config);
    let cursor_kind = format!("{EVENT_KIND}:{job_id}");

    let token = crate::connectors::google_access_token(app, account_id).await?;
    let now = Utc::now();
    // Scan a little past the lead window so an event is seen before it starts.
    let time_max = now + ChronoDuration::minutes(lead_minutes + 5);
    let params = ListEventsParams {
        time_min: Some(now.to_rfc3339()),
        time_max: Some(time_max.to_rfc3339()),
        max_results: Some(25),
        ..ListEventsParams::default()
    };
    let events = match call_list_events(app, account_id, &token, &params).await {
        Ok(events) => events,
        Err(error) if error.code == "connector_sync_token_expired" => {
            // Window mode never sends a sync token, but clear the cursor
            // defensively so a stale one can never wedge the poll.
            let _ = repos
                .set_trigger_cursor(account_id, &cursor_kind, "{}")
                .await;
            return Ok(());
        }
        Err(error) => return Err(error),
    };

    let mut fired = load_fired(repos, account_id, &cursor_kind).await;
    let lead_cutoff = now + ChronoDuration::minutes(lead_minutes);
    let mut should_fire = false;
    let mut changed = false;

    for event in &events.items {
        if fired.contains_key(&event.id) {
            continue;
        }
        let Some(start) = event.start.as_deref().and_then(parse_event_start) else {
            continue;
        };
        let starts_soon = start >= now && start <= lead_cutoff;
        let has_external = event
            .attendees
            .iter()
            .any(|attendee| !attendee.is_self && attendee.email.is_some());
        if starts_soon && has_external {
            fired.insert(event.id.clone(), start.timestamp());
            should_fire = true;
            changed = true;
        }
    }

    // Prune events whose start time is in the past so the cursor stays small.
    let before = fired.len();
    fired.retain(|_, start_ts| *start_ts >= now.timestamp());
    if fired.len() != before {
        changed = true;
    }

    if should_fire {
        fire(app, job_id).await;
    }
    if changed {
        let json = serde_json::to_string(&fired).unwrap_or_else(|_| "{}".to_string());
        repos
            .set_trigger_cursor(account_id, &cursor_kind, &json)
            .await?;
    }
    Ok(())
}

async fn call_list_events(
    app: &AppHandle,
    account_id: &str,
    token: &str,
    params: &ListEventsParams,
) -> Result<google::EventsPage, AppError> {
    match google::list_events(token, params).await {
        Ok(page) => Ok(page),
        Err(GoogleApiError::Unauthorized) => {
            let token =
                crate::connectors::force_refresh_google_access_token(app, account_id).await?;
            google::list_events(&token, params)
                .await
                .map_err(Into::into)
        }
        Err(error) => Err(error.into()),
    }
}

async fn load_fired(
    repos: &Repositories,
    account_id: &str,
    cursor_kind: &str,
) -> HashMap<String, i64> {
    repos
        .trigger_cursor(account_id, cursor_kind)
        .await
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn lead_minutes_from_config(config: &str) -> i64 {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(config) else {
        return DEFAULT_LEAD_MINUTES;
    };
    value
        .get("leadMinutes")
        .or_else(|| value.get("lead_minutes"))
        .and_then(serde_json::Value::as_i64)
        .filter(|minutes| *minutes > 0)
        .unwrap_or(DEFAULT_LEAD_MINUTES)
}

fn parse_event_start(start: &str) -> Option<DateTime<Utc>> {
    // Timed events carry an RFC 3339 dateTime; all-day events are a bare date
    // with no meeting time, so they are skipped for lead-time firing.
    DateTime::parse_from_rfc3339(start)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

// --- Firing & battery ---------------------------------------------------------

async fn fire(app: &AppHandle, job_id: &str) {
    if let Err(error) = crate::hermes_bridge::trigger_cron_job(app, job_id).await {
        tracing::warn!(error_code = %error.code, "connector trigger fire failed");
    }
}

/// True when the machine is on battery below the low threshold and
/// discharging, read from `pmset -g batt`. Any parse or spawn failure (for
/// example a desktop with no battery, or a non-macOS host) reports false, so
/// the daemon keeps its normal cadence.
fn battery_low_and_discharging() -> bool {
    let Ok(output) = std::process::Command::new("pmset")
        .args(["-g", "batt"])
        .output()
    else {
        return false;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let discharging = text.contains("discharging");
    let low = parse_battery_percent(&text).is_some_and(|percent| percent < BATTERY_LOW_PERCENT);
    discharging && low
}

fn parse_battery_percent(text: &str) -> Option<u32> {
    let idx = text.find('%')?;
    let digits: String = text[..idx]
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_battery_percent_from_pmset_output() {
        let sample = "Now drawing from 'Battery Power'\n \
             -InternalBattery-0 (id=1234)\t18%; discharging; 1:42 remaining present: true";
        assert_eq!(parse_battery_percent(sample), Some(18));
    }

    #[test]
    fn missing_percent_is_none() {
        assert_eq!(parse_battery_percent("no battery here"), None);
    }

    #[test]
    fn lead_minutes_reads_camel_and_snake_case() {
        assert_eq!(lead_minutes_from_config(r#"{"leadMinutes": 30}"#), 30);
        assert_eq!(lead_minutes_from_config(r#"{"lead_minutes": 45}"#), 45);
        assert_eq!(lead_minutes_from_config("{}"), DEFAULT_LEAD_MINUTES);
        assert_eq!(lead_minutes_from_config("not json"), DEFAULT_LEAD_MINUTES);
        assert_eq!(
            lead_minutes_from_config(r#"{"leadMinutes": 0}"#),
            DEFAULT_LEAD_MINUTES
        );
    }

    #[test]
    fn parses_timed_event_start_but_not_all_day() {
        assert!(parse_event_start("2026-07-10T09:00:00-07:00").is_some());
        assert!(parse_event_start("2026-07-11").is_none());
    }
}
