//! Scope registry for Google connectors: feature bundles map to the minimal
//! Google OAuth scopes they need, plus the incremental-auth helper that
//! decides whether a new consent round-trip is required.

/// Baseline identity scopes requested on every connect so the granted account
/// can be keyed by email (the id_token carries the email claim).
pub const OPENID: &str = "openid";
pub const EMAIL: &str = "email";

pub const GMAIL_READONLY: &str = "https://www.googleapis.com/auth/gmail.readonly";
pub const GMAIL_COMPOSE: &str = "https://www.googleapis.com/auth/gmail.compose";
pub const GMAIL_SEND: &str = "https://www.googleapis.com/auth/gmail.send";
/// Apply/remove labels and archive (users.messages.modify / threads.modify).
/// Google requires gmail.modify for these; readonly/compose/send cannot label.
pub const GMAIL_MODIFY: &str = "https://www.googleapis.com/auth/gmail.modify";
/// Read-only calendar for briefings and meeting prep. calendar.events grants
/// write ("view and edit events"), so read-only routines must not request it.
pub const CALENDAR_READONLY: &str = "https://www.googleapis.com/auth/calendar.readonly";
pub const CALENDAR_EVENTS: &str = "https://www.googleapis.com/auth/calendar.events";

pub const BASELINE_SCOPES: &[&str] = &[OPENID, EMAIL];

/// Feature bundle a connect (or scope escalation) request asks for. Wire
/// names ("gmail_read", ...) are what the frontend sends in
/// `connectors_connect.scopes`. Bundles stay minimal per Google's own scope
/// semantics: read-only capabilities never carry a write scope, so a briefing
/// routine cannot be granted send or calendar-write authority it never uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeBundle {
    GmailRead,
    GmailDraft,
    GmailModify,
    GmailSend,
    CalendarRead,
    CalendarEvents,
}

impl ScopeBundle {
    /// The Google scope URLs this bundle needs (baseline identity scopes are
    /// added separately by `requested_scopes`).
    pub fn scopes(&self) -> &'static [&'static str] {
        match self {
            ScopeBundle::GmailRead => &[GMAIL_READONLY],
            ScopeBundle::GmailDraft => &[GMAIL_COMPOSE],
            ScopeBundle::GmailModify => &[GMAIL_MODIFY],
            ScopeBundle::GmailSend => &[GMAIL_SEND],
            ScopeBundle::CalendarRead => &[CALENDAR_READONLY],
            ScopeBundle::CalendarEvents => &[CALENDAR_EVENTS],
        }
    }

    /// Wire name used by the `connectors_connect` command.
    pub fn name(&self) -> &'static str {
        match self {
            ScopeBundle::GmailRead => "gmail_read",
            ScopeBundle::GmailDraft => "gmail_draft",
            ScopeBundle::GmailModify => "gmail_modify",
            ScopeBundle::GmailSend => "gmail_send",
            ScopeBundle::CalendarRead => "calendar_read",
            ScopeBundle::CalendarEvents => "calendar_events",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "gmail_read" => Some(ScopeBundle::GmailRead),
            "gmail_draft" => Some(ScopeBundle::GmailDraft),
            "gmail_modify" => Some(ScopeBundle::GmailModify),
            "gmail_send" => Some(ScopeBundle::GmailSend),
            "calendar_read" => Some(ScopeBundle::CalendarRead),
            "calendar_events" => Some(ScopeBundle::CalendarEvents),
            _ => None,
        }
    }
}

/// Full scope set to request on the auth URL for a set of bundles: baseline
/// identity scopes plus each bundle's feature scopes, deduplicated, in a
/// stable order.
pub fn requested_scopes(bundles: &[ScopeBundle]) -> Vec<&'static str> {
    let mut scopes: Vec<&'static str> = Vec::new();
    for scope in BASELINE_SCOPES {
        if !scopes.contains(scope) {
            scopes.push(scope);
        }
    }
    for bundle in bundles {
        for scope in bundle.scopes() {
            if !scopes.contains(scope) {
                scopes.push(scope);
            }
        }
    }
    scopes
}

/// Incremental-auth helper: which scope URLs the wanted bundles need that the
/// account was not already granted. Empty means no new consent round-trip is
/// needed. Only feature scopes are compared; the baseline identity scopes are
/// granted on the first connect and never trigger an escalation by themselves.
pub fn missing_scopes(granted: &[String], wanted: &[ScopeBundle]) -> Vec<&'static str> {
    let mut missing: Vec<&'static str> = Vec::new();
    for bundle in wanted {
        for scope in bundle.scopes() {
            let already_granted = granted.iter().any(|granted| granted == scope);
            if !already_granted && !missing.contains(scope) {
                missing.push(scope);
            }
        }
    }
    missing
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(scopes: &[&str]) -> Vec<String> {
        scopes.iter().map(|scope| scope.to_string()).collect()
    }

    #[test]
    fn requested_scopes_include_baseline_and_dedupe() {
        let scopes = requested_scopes(&[ScopeBundle::GmailRead, ScopeBundle::GmailRead]);
        assert_eq!(scopes, vec![OPENID, EMAIL, GMAIL_READONLY]);
    }

    #[test]
    fn missing_scopes_empty_when_all_granted() {
        let granted = owned(&[OPENID, EMAIL, GMAIL_READONLY, CALENDAR_EVENTS]);
        assert!(missing_scopes(
            &granted,
            &[ScopeBundle::GmailRead, ScopeBundle::CalendarEvents]
        )
        .is_empty());
    }

    #[test]
    fn missing_scopes_reports_only_ungranted_feature_scopes() {
        let granted = owned(&[OPENID, EMAIL, GMAIL_READONLY]);
        let missing = missing_scopes(
            &granted,
            &[
                ScopeBundle::GmailRead,
                ScopeBundle::GmailDraft,
                ScopeBundle::GmailSend,
            ],
        );
        assert_eq!(missing, vec![GMAIL_COMPOSE, GMAIL_SEND]);
    }

    #[test]
    fn missing_scopes_ignores_baseline_scopes() {
        // An account granted only feature scopes (no openid/email in the
        // stored list) must not force an escalation round-trip.
        let granted = owned(&[GMAIL_READONLY]);
        assert!(missing_scopes(&granted, &[ScopeBundle::GmailRead]).is_empty());
    }

    #[test]
    fn bundle_names_round_trip() {
        for bundle in [
            ScopeBundle::GmailRead,
            ScopeBundle::GmailDraft,
            ScopeBundle::GmailModify,
            ScopeBundle::GmailSend,
            ScopeBundle::CalendarRead,
            ScopeBundle::CalendarEvents,
        ] {
            assert_eq!(ScopeBundle::from_name(bundle.name()), Some(bundle));
        }
        assert_eq!(ScopeBundle::from_name("gmail"), None);
    }

    #[test]
    fn label_and_archive_bundle_carries_the_modify_scope() {
        assert_eq!(ScopeBundle::GmailModify.scopes(), &[GMAIL_MODIFY]);
    }

    #[test]
    fn read_only_calendar_bundle_never_carries_write_scope() {
        assert_eq!(ScopeBundle::CalendarRead.scopes(), &[CALENDAR_READONLY]);
        assert!(!ScopeBundle::CalendarRead
            .scopes()
            .contains(&CALENDAR_EVENTS));
    }
}
