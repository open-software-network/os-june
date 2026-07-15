//! Scope registry for the private connectors: feature bundles map to the
//! minimal provider OAuth scopes they need, plus the incremental-auth helper
//! that decides whether a new consent round-trip is required. Google and
//! Linear bundles share one registry so a connect request is a flat list of
//! bundle names; each bundle knows which provider it belongs to.

use super::ConnectorProvider;

/// Baseline identity scopes requested on every Google connect so the granted
/// account can be keyed by email (the id_token carries the email claim).
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

/// Linear scopes are short names, not URLs. `read` is always granted (and
/// always requested: identity resolution and the teams listing need it);
/// `write` covers the v1 mutation set because Linear has no granular scope
/// for issue updates or project updates (see the spike doc).
pub const LINEAR_READ: &str = "read";
pub const LINEAR_WRITE: &str = "write";

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
    LinearRead,
    LinearWrite,
}

impl ScopeBundle {
    /// The provider scope strings this bundle needs (Google's baseline
    /// identity scopes are added separately by `requested_scopes`).
    pub fn scopes(&self) -> &'static [&'static str] {
        match self {
            ScopeBundle::GmailRead => &[GMAIL_READONLY],
            ScopeBundle::GmailDraft => &[GMAIL_COMPOSE],
            ScopeBundle::GmailModify => &[GMAIL_MODIFY],
            ScopeBundle::GmailSend => &[GMAIL_SEND],
            ScopeBundle::CalendarRead => &[CALENDAR_READONLY],
            ScopeBundle::CalendarEvents => &[CALENDAR_EVENTS],
            ScopeBundle::LinearRead => &[LINEAR_READ],
            ScopeBundle::LinearWrite => &[LINEAR_WRITE],
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
            ScopeBundle::LinearRead => "linear_read",
            ScopeBundle::LinearWrite => "linear_write",
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
            "linear_read" => Some(ScopeBundle::LinearRead),
            "linear_write" => Some(ScopeBundle::LinearWrite),
            _ => None,
        }
    }

    /// The provider whose consent flow grants this bundle. A connect request
    /// must not mix providers: the command layer rejects a bundle whose
    /// provider differs from the one being connected.
    pub fn provider(&self) -> ConnectorProvider {
        match self {
            ScopeBundle::GmailRead
            | ScopeBundle::GmailDraft
            | ScopeBundle::GmailModify
            | ScopeBundle::GmailSend
            | ScopeBundle::CalendarRead
            | ScopeBundle::CalendarEvents => ConnectorProvider::Google,
            ScopeBundle::LinearRead | ScopeBundle::LinearWrite => ConnectorProvider::Linear,
        }
    }
}

/// Full scope set to request on the Google auth URL for a set of bundles:
/// baseline identity scopes plus each bundle's feature scopes, deduplicated,
/// in a stable order.
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

/// Full scope set to request on the Linear auth URL for a set of bundles:
/// `read` always leads (Linear grants it unconditionally, and identity
/// resolution plus the teams listing need it), then each bundle's feature
/// scopes, deduplicated, in a stable order. Linear has no openid/email
/// baseline - identity comes from a GraphQL viewer query, not OIDC.
pub fn requested_linear_scopes(bundles: &[ScopeBundle]) -> Vec<&'static str> {
    let mut scopes: Vec<&'static str> = vec![LINEAR_READ];
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
        for &scope in bundle.scopes() {
            let already_granted = granted.iter().any(|held| scope_grants(held, scope));
            if !already_granted && !missing.contains(&scope) {
                missing.push(scope);
            }
        }
    }
    missing
}

/// The scopes to persist for a completed grant. With `include_granted_scopes`,
/// Google's `grant_scope` normally carries the full union of everything the
/// account has ever granted this app, so we take it verbatim. When Google omits
/// the field (it may on an incremental add-access grant), fall back to the
/// scopes we requested this round UNIONED with whatever the account already
/// held, so add-access never makes the DB forget earlier grants the token still
/// carries (which would make trigger scope gates and the reconnect UI wrongly
/// think routines lost access).
pub fn resolve_granted_scopes(
    grant_scope: Option<&str>,
    requested: &[&str],
    existing: Option<&[String]>,
) -> Vec<String> {
    if let Some(scopes) = grant_scope
        .map(|scope| {
            scope
                .split_whitespace()
                .map(str::to_string)
                .collect::<Vec<String>>()
        })
        .filter(|scopes| !scopes.is_empty())
    {
        return scopes;
    }
    let mut union: Vec<String> = requested.iter().map(|scope| scope.to_string()).collect();
    if let Some(existing) = existing {
        for scope in existing {
            if !union.contains(scope) {
                union.push(scope.clone());
            }
        }
    }
    union
}

/// True when a granted scope satisfies a needed scope, directly or because it
/// is a broader scope that implies it: a write scope already grants the
/// matching read/draft. Mirrors the frontend `SCOPE_IMPLICATIONS` so the
/// incremental-auth short-circuit does not force a fresh consent round for a
/// scope a broader existing grant already authorizes.
fn scope_grants(held: &str, needed: &str) -> bool {
    held == needed
        || matches!(
            (held, needed),
            (GMAIL_MODIFY, GMAIL_READONLY)
                | (GMAIL_MODIFY, GMAIL_COMPOSE)
                | (CALENDAR_EVENTS, CALENDAR_READONLY)
        )
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
    fn missing_scopes_treats_broader_grants_as_covering_narrower_bundles() {
        // gmail.modify already grants read and draft, so neither re-prompts.
        let granted = owned(&[GMAIL_MODIFY]);
        assert!(missing_scopes(&granted, &[ScopeBundle::GmailRead]).is_empty());
        assert!(missing_scopes(&granted, &[ScopeBundle::GmailDraft]).is_empty());
        // calendar.events already grants calendar read.
        let granted = owned(&[CALENDAR_EVENTS]);
        assert!(missing_scopes(&granted, &[ScopeBundle::CalendarRead]).is_empty());
        // But a narrower grant never covers a broader need.
        let granted = owned(&[GMAIL_READONLY]);
        assert_eq!(
            missing_scopes(&granted, &[ScopeBundle::GmailModify]),
            vec![GMAIL_MODIFY]
        );
    }

    #[test]
    fn resolve_granted_scopes_prefers_the_response_union() {
        // Google returned the full union in the scope field: take it verbatim,
        // ignoring the requested/existing fallbacks.
        let requested = vec![GMAIL_READONLY];
        let existing = owned(&[CALENDAR_EVENTS]);
        let resolved = resolve_granted_scopes(
            Some("openid email https://www.googleapis.com/auth/gmail.readonly"),
            &requested,
            Some(&existing),
        );
        assert_eq!(resolved, vec![OPENID, EMAIL, GMAIL_READONLY]);
    }

    #[test]
    fn resolve_granted_scopes_unions_requested_with_existing_when_response_omits_scope() {
        // Incremental add-access grant with no scope field: the persisted scopes
        // must keep the account's earlier calendar grant, not shrink to only the
        // gmail scope requested this round.
        let requested = vec![OPENID, EMAIL, GMAIL_READONLY];
        let existing = owned(&[OPENID, EMAIL, CALENDAR_EVENTS]);
        let resolved = resolve_granted_scopes(None, &requested, Some(&existing));
        assert_eq!(
            resolved,
            vec![OPENID, EMAIL, GMAIL_READONLY, CALENDAR_EVENTS]
        );
    }

    #[test]
    fn resolve_granted_scopes_falls_back_to_requested_for_a_first_connect() {
        // No response scope and no existing account (first connect): just the
        // requested scopes.
        let requested = vec![OPENID, EMAIL, GMAIL_READONLY];
        let resolved = resolve_granted_scopes(Some("   "), &requested, None);
        assert_eq!(resolved, vec![OPENID, EMAIL, GMAIL_READONLY]);
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
            ScopeBundle::LinearRead,
            ScopeBundle::LinearWrite,
        ] {
            assert_eq!(ScopeBundle::from_name(bundle.name()), Some(bundle));
        }
        assert_eq!(ScopeBundle::from_name("gmail"), None);
        assert_eq!(ScopeBundle::from_name("linear"), None);
    }

    #[test]
    fn bundles_map_to_their_provider() {
        for bundle in [
            ScopeBundle::GmailRead,
            ScopeBundle::GmailDraft,
            ScopeBundle::GmailModify,
            ScopeBundle::GmailSend,
            ScopeBundle::CalendarRead,
            ScopeBundle::CalendarEvents,
        ] {
            assert_eq!(bundle.provider(), ConnectorProvider::Google);
        }
        for bundle in [ScopeBundle::LinearRead, ScopeBundle::LinearWrite] {
            assert_eq!(bundle.provider(), ConnectorProvider::Linear);
        }
    }

    #[test]
    fn requested_linear_scopes_always_lead_with_read() {
        // Even a write-only request carries read: identity + teams need it,
        // and Linear grants it unconditionally anyway.
        assert_eq!(
            requested_linear_scopes(&[ScopeBundle::LinearWrite]),
            vec![LINEAR_READ, LINEAR_WRITE]
        );
        // Read-only request stays read-only, deduped.
        assert_eq!(
            requested_linear_scopes(&[ScopeBundle::LinearRead, ScopeBundle::LinearRead]),
            vec![LINEAR_READ]
        );
        assert_eq!(requested_linear_scopes(&[]), vec![LINEAR_READ]);
    }

    #[test]
    fn google_requested_scopes_keep_the_oidc_baseline() {
        // The Linear registry addition must not disturb Google's baseline.
        assert_eq!(
            requested_scopes(&[ScopeBundle::GmailRead]),
            vec![OPENID, EMAIL, GMAIL_READONLY]
        );
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
