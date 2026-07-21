//! Best-effort Google Calendar context for newly started meeting recordings.
//!
//! This never blocks capture startup and never sends calendar data through the
//! June API. It reads each connected Google primary calendar directly, selects
//! the timed event closest to the recording start, and stores only the small
//! event identity shown on the local note.

use crate::{
    connectors::{
        self,
        google::{self, EventSummary, GoogleApiError, ListEventsParams},
        scopes::{CALENDAR_EVENTS, CALENDAR_READONLY},
    },
    db::repositories::Repositories,
    domain::types::{AppError, NoteCalendarEventDto},
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use tauri::AppHandle;

const EVENT_WINDOW_HOURS: i64 = 6;
const EVENT_GRACE_MINUTES: i64 = 10;
const MAX_EVENT_PAGES: usize = 10;

pub const NOTE_CALENDAR_CONTEXT_UPDATED_EVENT: &str = "june://note-calendar-context-updated";

#[derive(Debug)]
struct Candidate {
    event: NoteCalendarEventDto,
    distance_ms: i64,
    start_distance_ms: i64,
}

pub async fn enrich_note_for_recording(
    app: &AppHandle,
    repos: Repositories,
    note_id: String,
    expected_title: String,
    recording_started_at: DateTime<Utc>,
) -> Result<bool, AppError> {
    let accounts = repos.list_connector_accounts().await?;
    let mut best: Option<Candidate> = None;
    let params = ListEventsParams {
        time_min: Some(
            (recording_started_at - Duration::hours(EVENT_WINDOW_HOURS))
                .to_rfc3339_opts(SecondsFormat::Secs, true),
        ),
        time_max: Some(
            (recording_started_at + Duration::hours(EVENT_WINDOW_HOURS))
                .to_rfc3339_opts(SecondsFormat::Secs, true),
        ),
        max_results: Some(50),
        ..Default::default()
    };

    for account in accounts.into_iter().filter(|account| {
        account.provider == "google"
            && account.status == "connected"
            && account
                .scopes
                .iter()
                .any(|scope| scope == CALENDAR_READONLY || scope == CALENDAR_EVENTS)
    }) {
        let Ok(mut token) = connectors::google_access_token(app, &account.account_id).await else {
            continue;
        };
        let mut page_token = None;
        for _ in 0..MAX_EVENT_PAGES {
            let mut page_params = params.clone();
            page_params.page_token = page_token;
            let page = match google::list_events(&token, &page_params).await {
                Ok(page) => page,
                Err(GoogleApiError::Unauthorized) => {
                    let Ok(refreshed) =
                        connectors::force_refresh_google_access_token(app, &account.account_id)
                            .await
                    else {
                        break;
                    };
                    token = refreshed;
                    match google::list_events(&token, &page_params).await {
                        Ok(page) => page,
                        Err(_) => break,
                    }
                }
                Err(_) => break,
            };
            page_token = page.next_page_token;

            for event in page.items {
                let Some(candidate) =
                    candidate_for_event(event, &account.email, recording_started_at)
                else {
                    continue;
                };
                let is_better = best.as_ref().is_none_or(|current| {
                    (candidate.distance_ms, candidate.start_distance_ms)
                        < (current.distance_ms, current.start_distance_ms)
                });
                if is_better {
                    best = Some(candidate);
                }
            }
            if page_token.is_none() {
                break;
            }
        }
    }

    if let Some(candidate) = best {
        return Ok(repos
            .associate_note_with_calendar_event(&note_id, &expected_title, &candidate.event)
            .await?);
    }
    Ok(false)
}

fn candidate_for_event(
    event: EventSummary,
    account_email: &str,
    recording_started_at: DateTime<Utc>,
) -> Option<Candidate> {
    if event.status.as_deref() == Some("cancelled")
        || event.attendees.iter().any(|attendee| {
            attendee.is_self && attendee.response_status.as_deref() == Some("declined")
        })
    {
        return None;
    }
    let title = event.summary?.trim().to_string();
    if title.is_empty() {
        return None;
    }
    // Date-only values are all-day events. They are intentionally skipped:
    // they rarely identify the call being recorded and would create false
    // confidence in the note header.
    let start = DateTime::parse_from_rfc3339(event.start.as_deref()?)
        .ok()?
        .with_timezone(&Utc);
    let end = DateTime::parse_from_rfc3339(event.end.as_deref()?)
        .ok()?
        .with_timezone(&Utc);
    if end <= start
        || recording_started_at < start - Duration::minutes(EVENT_GRACE_MINUTES)
        || recording_started_at > end + Duration::minutes(EVENT_GRACE_MINUTES)
    {
        return None;
    }

    let distance_ms = if recording_started_at < start {
        (start - recording_started_at).num_milliseconds()
    } else if recording_started_at > end {
        (recording_started_at - end).num_milliseconds()
    } else {
        0
    };
    Some(Candidate {
        event: NoteCalendarEventDto {
            event_id: event.id,
            title,
            start_at: start.to_rfc3339_opts(SecondsFormat::Secs, true),
            end_at: end.to_rfc3339_opts(SecondsFormat::Secs, true),
            account_email: account_email.to_string(),
        },
        distance_ms,
        start_distance_ms: (recording_started_at - start).num_milliseconds().abs(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::google::EventAttendee;
    use chrono::TimeZone;

    fn event(title: &str, start: &str, end: &str) -> EventSummary {
        EventSummary {
            id: "event-1".to_string(),
            summary: Some(title.to_string()),
            start: Some(start.to_string()),
            end: Some(end.to_string()),
            attendees: Vec::new(),
            location: None,
            organizer: None,
            html_link: None,
            status: Some("confirmed".to_string()),
        }
    }

    #[test]
    fn matches_an_event_in_progress_and_keeps_provenance() {
        let started = Utc.with_ymd_and_hms(2026, 7, 20, 14, 15, 0).unwrap();
        let candidate = candidate_for_event(
            event(
                "Product review",
                "2026-07-20T14:00:00Z",
                "2026-07-20T14:30:00Z",
            ),
            "june@example.com",
            started,
        )
        .unwrap();

        assert_eq!(candidate.distance_ms, 0);
        assert_eq!(candidate.event.title, "Product review");
        assert_eq!(candidate.event.account_email, "june@example.com");
    }

    #[test]
    fn allows_joining_ten_minutes_early_but_not_unrelated_events() {
        let event = || {
            event(
                "Design sync",
                "2026-07-20T14:00:00Z",
                "2026-07-20T14:30:00Z",
            )
        };
        assert!(candidate_for_event(
            event(),
            "june@example.com",
            Utc.with_ymd_and_hms(2026, 7, 20, 13, 50, 0).unwrap(),
        )
        .is_some());
        assert!(candidate_for_event(
            event(),
            "june@example.com",
            Utc.with_ymd_and_hms(2026, 7, 20, 13, 49, 59).unwrap(),
        )
        .is_none());
    }

    #[test]
    fn rejects_all_day_cancelled_and_declined_events() {
        let started = Utc.with_ymd_and_hms(2026, 7, 20, 14, 0, 0).unwrap();
        let mut all_day = event("Conference", "2026-07-20", "2026-07-21");
        assert!(candidate_for_event(all_day, "june@example.com", started).is_none());

        let mut cancelled = event(
            "Cancelled sync",
            "2026-07-20T14:00:00Z",
            "2026-07-20T14:30:00Z",
        );
        cancelled.status = Some("cancelled".to_string());
        assert!(candidate_for_event(cancelled, "june@example.com", started).is_none());

        all_day = event(
            "Declined sync",
            "2026-07-20T14:00:00Z",
            "2026-07-20T14:30:00Z",
        );
        all_day.attendees = vec![EventAttendee {
            email: Some("june@example.com".to_string()),
            response_status: Some("declined".to_string()),
            is_self: true,
        }];
        assert!(candidate_for_event(all_day, "june@example.com", started).is_none());
    }
}
