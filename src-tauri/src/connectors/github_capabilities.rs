use super::random_b64url;
use crate::domain::types::AppError;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fmt,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const CAPABILITY_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_CAPABILITIES: usize = 1024;
const MAX_PULL_FILE_INDEX: u16 = 2999;

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(dead_code)] // The endpoint modules in later plan tasks consume this staged contract.
pub(crate) struct CursorScope {
    pub operation: &'static str,
    pub repository_id: Option<String>,
    pub filter_fingerprint: [u8; 32],
    pub provider_page: u32,
    pub raw_offset: u16,
    pub phase: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(dead_code)] // The endpoint modules in later plan tasks consume this staged contract.
pub(crate) struct PullFileScope {
    pub repository_id: String,
    pub pull_number: u64,
    pub head_sha: String,
    pub absolute_index: u16,
    pub expected_path: String,
}

impl PullFileScope {
    #[allow(dead_code)] // The endpoint modules in later plan tasks consume this staged contract.
    pub(crate) fn validate_expected_path(&self, observed_path: &str) -> Result<(), AppError> {
        if self.expected_path == observed_path {
            Ok(())
        } else {
            Err(file_ref_invalid())
        }
    }
}

enum CapabilityKind {
    Cursor(CursorScope),
    PullFile(PullFileScope),
}

struct CapabilityEntry {
    token: String,
    expires_at: Instant,
    kind: CapabilityKind,
}

type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

#[allow(dead_code)] // The endpoint modules in later plan tasks consume this staged contract.
pub(crate) struct CapabilityRegistry {
    entries: Mutex<VecDeque<CapabilityEntry>>,
    clock: Clock,
}

#[allow(dead_code)] // The endpoint modules in later plan tasks consume this staged contract.
impl CapabilityRegistry {
    pub(crate) fn new() -> Self {
        Self::with_clock_source(Arc::new(Instant::now))
    }

    #[cfg(test)]
    fn with_clock<F>(clock: F) -> Self
    where
        F: Fn() -> Instant + Send + Sync + 'static,
    {
        Self::with_clock_source(Arc::new(clock))
    }

    fn with_clock_source(clock: Clock) -> Self {
        Self {
            entries: Mutex::new(VecDeque::new()),
            clock,
        }
    }

    pub(crate) fn issue_cursor(&self, scope: CursorScope) -> Result<String, AppError> {
        self.issue(CapabilityKind::Cursor(scope), cursor_invalid)
    }

    pub(crate) fn resolve_cursor(
        &self,
        token: &str,
        operation: &str,
        repository_id: Option<&str>,
        filter_fingerprint: &[u8; 32],
    ) -> Result<CursorScope, AppError> {
        let mut entries = self.entries.lock().map_err(|_| cursor_invalid())?;
        let now = (self.clock)();
        purge_expired(&mut entries, now);

        entries
            .iter()
            .find_map(|entry| {
                if entry.token != token {
                    return None;
                }
                match &entry.kind {
                    CapabilityKind::Cursor(scope)
                        if scope.operation == operation
                            && scope.repository_id.as_deref() == repository_id
                            && &scope.filter_fingerprint == filter_fingerprint =>
                    {
                        Some(scope.clone())
                    }
                    CapabilityKind::Cursor(_) | CapabilityKind::PullFile(_) => None,
                }
            })
            .ok_or_else(cursor_invalid)
    }

    pub(crate) fn issue_pull_file(&self, scope: PullFileScope) -> Result<String, AppError> {
        if scope.absolute_index > MAX_PULL_FILE_INDEX {
            return Err(file_ref_invalid());
        }
        self.issue(CapabilityKind::PullFile(scope), file_ref_invalid)
    }

    pub(crate) fn resolve_pull_file(
        &self,
        token: &str,
        repository_id: &str,
        pull_number: u64,
        head_sha: &str,
    ) -> Result<PullFileScope, AppError> {
        let mut entries = self.entries.lock().map_err(|_| file_ref_invalid())?;
        let now = (self.clock)();
        purge_expired(&mut entries, now);

        entries
            .iter()
            .find_map(|entry| {
                if entry.token != token {
                    return None;
                }
                match &entry.kind {
                    CapabilityKind::PullFile(scope)
                        if scope.repository_id == repository_id
                            && scope.pull_number == pull_number
                            && scope.head_sha == head_sha =>
                    {
                        Some(scope.clone())
                    }
                    CapabilityKind::Cursor(_) | CapabilityKind::PullFile(_) => None,
                }
            })
            .ok_or_else(file_ref_invalid)
    }

    fn issue(&self, kind: CapabilityKind, invalid: fn() -> AppError) -> Result<String, AppError> {
        let mut entries = self.entries.lock().map_err(|_| invalid())?;
        let now = (self.clock)();
        purge_expired(&mut entries, now);
        while entries.len() >= MAX_CAPABILITIES {
            entries.pop_front();
        }

        let token = loop {
            let candidate = random_b64url(24);
            if entries.iter().all(|entry| entry.token != candidate) {
                break candidate;
            }
        };
        entries.push_back(CapabilityEntry {
            token: token.clone(),
            expires_at: now + CAPABILITY_TTL,
            kind,
        });
        Ok(token)
    }
}

impl Default for CapabilityRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for CapabilityRegistry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let entry_count = self
            .entries
            .lock()
            .map(|entries| entries.len())
            .unwrap_or_default();
        formatter
            .debug_struct("CapabilityRegistry")
            .field("entry_count", &entry_count)
            .finish_non_exhaustive()
    }
}

#[allow(dead_code)] // The endpoint modules in later plan tasks consume this staged contract.
pub(crate) fn filter_fingerprint(filters: &serde_json::Value) -> [u8; 32] {
    let mut canonical = String::new();
    write_canonical_json(filters, &mut canonical);
    Sha256::digest(canonical.as_bytes()).into()
}

fn write_canonical_json(value: &serde_json::Value, output: &mut String) {
    match value {
        serde_json::Value::Null => output.push_str("null"),
        serde_json::Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        serde_json::Value::Number(value) => output.push_str(&value.to_string()),
        serde_json::Value::String(value) => {
            output.push_str(&serde_json::Value::String(value.clone()).to_string());
        }
        serde_json::Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical_json(value, output);
            }
            output.push(']');
        }
        serde_json::Value::Object(values) => {
            output.push('{');
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::Value::String(key.clone()).to_string());
                output.push(':');
                write_canonical_json(&values[key], output);
            }
            output.push('}');
        }
    }
}

fn purge_expired(entries: &mut VecDeque<CapabilityEntry>, now: Instant) {
    entries.retain(|entry| entry.expires_at > now);
}

fn cursor_invalid() -> AppError {
    AppError::new(
        "github_cursor_invalid",
        "The GitHub cursor is invalid or expired.",
    )
}

fn file_ref_invalid() -> AppError {
    AppError::new(
        "github_file_ref_invalid",
        "The GitHub file reference is invalid or expired.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::types::AppError;
    use serde_json::json;
    use std::{
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };

    #[derive(Clone)]
    struct ManualClock {
        now: Arc<Mutex<Instant>>,
    }

    impl ManualClock {
        fn new() -> Self {
            Self {
                now: Arc::new(Mutex::new(Instant::now())),
            }
        }

        fn now(&self) -> Instant {
            *self.now.lock().expect("manual clock")
        }

        fn advance(&self, duration: Duration) {
            let mut now = self.now.lock().expect("manual clock");
            *now += duration;
        }
    }

    fn cursor_scope() -> CursorScope {
        CursorScope {
            operation: "list_issues",
            repository_id: Some("123456".to_string()),
            filter_fingerprint: filter_fingerprint(&json!({
                "labels": ["bug", "security"],
                "query": "is:open",
                "state": "open",
            })),
            provider_page: 3,
            raw_offset: 17,
            phase: Some("issues".to_string()),
        }
    }

    fn pull_file_scope() -> PullFileScope {
        PullFileScope {
            repository_id: "123456".to_string(),
            pull_number: 42,
            head_sha: "0123456789abcdef".to_string(),
            absolute_index: 2999,
            expected_path: "src/connectors/github.rs".to_string(),
        }
    }

    fn assert_error_code<T: std::fmt::Debug>(result: Result<T, AppError>, expected: &str) {
        assert_eq!(result.expect_err("expected error").code, expected);
    }

    #[test]
    fn cursor_resolves_repeatedly_until_expiry() {
        let clock = ManualClock::new();
        let registry = CapabilityRegistry::with_clock({
            let clock = clock.clone();
            move || clock.now()
        });
        let scope = cursor_scope();
        let token = registry.issue_cursor(scope.clone()).expect("issue cursor");

        assert_eq!(
            registry
                .resolve_cursor(
                    &token,
                    scope.operation,
                    scope.repository_id.as_deref(),
                    &scope.filter_fingerprint,
                )
                .expect("first resolve"),
            scope
        );
        assert_eq!(
            registry
                .resolve_cursor(
                    &token,
                    scope.operation,
                    scope.repository_id.as_deref(),
                    &scope.filter_fingerprint,
                )
                .expect("repeated resolve"),
            scope
        );

        clock.advance(Duration::from_secs(15 * 60));
        assert_error_code(
            registry.resolve_cursor(
                &token,
                scope.operation,
                scope.repository_id.as_deref(),
                &scope.filter_fingerprint,
            ),
            "github_cursor_invalid",
        );
    }

    #[test]
    fn cursor_is_bound_to_kind_operation_repository_and_filters() {
        let registry = CapabilityRegistry::new();
        let scope = cursor_scope();
        let token = registry.issue_cursor(scope.clone()).expect("issue cursor");

        assert_error_code(
            registry.resolve_cursor(
                &token,
                "list_pull_requests",
                scope.repository_id.as_deref(),
                &scope.filter_fingerprint,
            ),
            "github_cursor_invalid",
        );
        assert_error_code(
            registry.resolve_cursor(
                &token,
                scope.operation,
                Some("654321"),
                &scope.filter_fingerprint,
            ),
            "github_cursor_invalid",
        );
        let wrong_filters = filter_fingerprint(&json!({"state": "closed"}));
        assert_error_code(
            registry.resolve_cursor(
                &token,
                scope.operation,
                scope.repository_id.as_deref(),
                &wrong_filters,
            ),
            "github_cursor_invalid",
        );
        assert_error_code(
            registry.resolve_pull_file(&token, "123456", 42, "0123456789abcdef"),
            "github_file_ref_invalid",
        );
    }

    #[test]
    fn pull_file_ref_is_bound_to_kind_repository_pull_head_and_path() {
        let registry = CapabilityRegistry::new();
        let scope = pull_file_scope();
        let token = registry
            .issue_pull_file(scope.clone())
            .expect("issue file ref");

        assert_eq!(
            registry
                .resolve_pull_file(
                    &token,
                    &scope.repository_id,
                    scope.pull_number,
                    &scope.head_sha,
                )
                .expect("resolve file ref"),
            scope
        );
        assert_error_code(
            registry.resolve_pull_file(&token, "654321", scope.pull_number, &scope.head_sha),
            "github_file_ref_invalid",
        );
        assert_error_code(
            registry.resolve_pull_file(&token, &scope.repository_id, 99, &scope.head_sha),
            "github_file_ref_invalid",
        );
        assert_error_code(
            registry.resolve_pull_file(
                &token,
                &scope.repository_id,
                scope.pull_number,
                "fedcba9876543210",
            ),
            "github_file_ref_invalid",
        );
        assert_error_code(
            scope.validate_expected_path("src/connectors/not-github.rs"),
            "github_file_ref_invalid",
        );

        let cursor_token = registry.issue_cursor(cursor_scope()).expect("issue cursor");
        assert_error_code(
            registry.resolve_pull_file(
                &cursor_token,
                &scope.repository_id,
                scope.pull_number,
                &scope.head_sha,
            ),
            "github_file_ref_invalid",
        );
    }

    #[test]
    fn expired_pull_file_ref_does_not_resolve() {
        let clock = ManualClock::new();
        let registry = CapabilityRegistry::with_clock({
            let clock = clock.clone();
            move || clock.now()
        });
        let scope = pull_file_scope();
        let token = registry
            .issue_pull_file(scope.clone())
            .expect("issue file ref");

        clock.advance(Duration::from_secs(15 * 60));
        assert_error_code(
            registry.resolve_pull_file(
                &token,
                &scope.repository_id,
                scope.pull_number,
                &scope.head_sha,
            ),
            "github_file_ref_invalid",
        );
    }

    #[test]
    fn one_thousand_twenty_fifth_insertion_evicts_the_oldest_entry() {
        let registry = CapabilityRegistry::new();
        let scope = cursor_scope();
        let mut tokens = Vec::with_capacity(1025);

        for raw_offset in 0..1025 {
            let mut inserted = scope.clone();
            inserted.raw_offset = u16::try_from(raw_offset).expect("offset fits");
            tokens.push(registry.issue_cursor(inserted).expect("issue cursor"));
        }

        assert_error_code(
            registry.resolve_cursor(
                &tokens[0],
                scope.operation,
                scope.repository_id.as_deref(),
                &scope.filter_fingerprint,
            ),
            "github_cursor_invalid",
        );
        assert_eq!(
            registry
                .resolve_cursor(
                    &tokens[1024],
                    scope.operation,
                    scope.repository_id.as_deref(),
                    &scope.filter_fingerprint,
                )
                .expect("newest cursor")
                .raw_offset,
            1024
        );
    }

    #[test]
    fn total_cap_is_shared_between_cursor_and_pull_file_capabilities() {
        let registry = CapabilityRegistry::new();
        let cursor = cursor_scope();
        let oldest = registry
            .issue_cursor(cursor.clone())
            .expect("issue oldest cursor");
        for raw_offset in 1..1024 {
            let mut inserted = cursor.clone();
            inserted.raw_offset = raw_offset;
            registry.issue_cursor(inserted).expect("fill registry");
        }

        let file = pull_file_scope();
        let file_ref = registry
            .issue_pull_file(file.clone())
            .expect("issue file ref");

        assert_error_code(
            registry.resolve_cursor(
                &oldest,
                cursor.operation,
                cursor.repository_id.as_deref(),
                &cursor.filter_fingerprint,
            ),
            "github_cursor_invalid",
        );
        assert_eq!(
            registry
                .resolve_pull_file(
                    &file_ref,
                    &file.repository_id,
                    file.pull_number,
                    &file.head_sha,
                )
                .expect("newest file ref"),
            file
        );
    }

    #[test]
    fn registries_do_not_share_capabilities() {
        let first = CapabilityRegistry::new();
        let second = CapabilityRegistry::new();
        let scope = cursor_scope();
        let token = first.issue_cursor(scope.clone()).expect("issue cursor");

        assert_error_code(
            second.resolve_cursor(
                &token,
                scope.operation,
                scope.repository_id.as_deref(),
                &scope.filter_fingerprint,
            ),
            "github_cursor_invalid",
        );
    }

    #[test]
    fn capability_debug_and_errors_do_not_expose_payloads() {
        let registry = CapabilityRegistry::new();
        let scope = CursorScope {
            repository_id: Some("secret-repository-name".to_string()),
            phase: Some("secret-provider-phase".to_string()),
            ..cursor_scope()
        };
        let token = registry.issue_cursor(scope.clone()).expect("issue cursor");

        let debug = format!("{registry:?}");
        assert!(!debug.contains(&token));
        assert!(!debug.contains("secret-repository-name"));
        assert!(!debug.contains("secret-provider-phase"));

        let error = registry
            .resolve_cursor(
                &token,
                "wrong-operation",
                scope.repository_id.as_deref(),
                &scope.filter_fingerprint,
            )
            .expect_err("wrong operation");
        let serialized = serde_json::to_string(&error).expect("serialize error");
        assert!(!serialized.contains(&token));
        assert!(!serialized.contains("secret-repository-name"));
        assert!(!serialized.contains("secret-provider-phase"));
    }

    #[test]
    fn tokens_are_random_opaque_base64url_values() {
        let registry = CapabilityRegistry::new();
        let cursor = cursor_scope();
        let first = registry
            .issue_cursor(cursor.clone())
            .expect("issue first cursor");
        let second = registry.issue_cursor(cursor).expect("issue second cursor");

        assert_ne!(first, second);
        for token in [&first, &second] {
            assert_eq!(token.len(), 32);
            assert!(token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')));
            assert!(!token.contains("123456"));
            assert!(!token.contains("list_issues"));
        }
    }

    #[test]
    fn pull_file_index_above_provider_limit_cannot_be_issued() {
        let registry = CapabilityRegistry::new();
        let scope = PullFileScope {
            absolute_index: 3000,
            ..pull_file_scope()
        };

        assert_error_code(registry.issue_pull_file(scope), "github_file_ref_invalid");
    }

    #[test]
    fn filter_fingerprint_uses_canonical_object_order() {
        let first = json!({"query": "bug", "state": "open"});
        let mut second = serde_json::Map::new();
        second.insert("state".to_string(), json!("open"));
        second.insert("query".to_string(), json!("bug"));

        assert_eq!(
            filter_fingerprint(&first),
            filter_fingerprint(&serde_json::Value::Object(second))
        );
        assert_ne!(
            filter_fingerprint(&first),
            filter_fingerprint(&json!({"query": "bug", "state": "closed"}))
        );
    }
}
