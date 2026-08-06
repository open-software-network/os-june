//! Rollback-safe credential migration from June-era Keychain services.
//!
//! The bridge deliberately keeps both services current. A released June build
//! may be installed again after Clovy rotates an OS Accounts or connector
//! token, so a one-time copy is not sufficient.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};

const SYNC_MARKER_SUFFIX: &str = ".compat-sync";

trait CredentialStore {
    type Error;

    fn get(&mut self, service: &str, user: &str) -> Result<Option<String>, Self::Error>;
    fn set(&mut self, service: &str, user: &str, value: &str) -> Result<(), Self::Error>;
    fn delete(&mut self, service: &str, user: &str) -> Result<(), Self::Error>;
}

struct KeyringStore;

impl CredentialStore for KeyringStore {
    type Error = keyring::Error;

    fn get(&mut self, service: &str, user: &str) -> Result<Option<String>, Self::Error> {
        match keyring::Entry::new(service, user).and_then(|entry| entry.get_password()) {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn set(&mut self, service: &str, user: &str, value: &str) -> Result<(), Self::Error> {
        keyring::Entry::new(service, user).and_then(|entry| entry.set_password(value))
    }

    fn delete(&mut self, service: &str, user: &str) -> Result<(), Self::Error> {
        match keyring::Entry::new(service, user).and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error),
        }
    }
}

pub(crate) fn get_password(
    canonical_service: &str,
    legacy_service: &str,
    user: &str,
) -> Result<Option<String>, keyring::Error> {
    get_password_with(&mut KeyringStore, canonical_service, legacy_service, user)
}

pub(crate) fn set_password(
    canonical_service: &str,
    legacy_service: &str,
    user: &str,
    value: &str,
) -> Result<(), keyring::Error> {
    set_password_with(
        &mut KeyringStore,
        canonical_service,
        legacy_service,
        user,
        value,
    )
}

pub(crate) fn delete_password(
    canonical_service: &str,
    legacy_service: &str,
    user: &str,
) -> Result<(), keyring::Error> {
    delete_password_with(&mut KeyringStore, canonical_service, legacy_service, user)
}

fn get_password_with<S: CredentialStore>(
    store: &mut S,
    canonical_service: &str,
    legacy_service: &str,
    user: &str,
) -> Result<Option<String>, S::Error> {
    let canonical = store.get(canonical_service, user);
    let legacy = store.get(legacy_service, user);
    match canonical {
        Ok(Some(canonical_value)) => match legacy {
            Ok(Some(legacy_value)) if canonical_value != legacy_value => {
                let marker_service = sync_marker_service(canonical_service);
                let prior_fingerprint = store.get(&marker_service, user).ok().flatten();
                let canonical_fingerprint = value_fingerprint(&canonical_value);
                let legacy_fingerprint = value_fingerprint(&legacy_value);

                // A rollback build can rotate only the legacy entry. The
                // marker records the last value known to be common to both
                // services, so divergence can be resolved without guessing.
                let legacy_changed_after_sync = prior_fingerprint.as_deref()
                    == Some(canonical_fingerprint.as_str())
                    && prior_fingerprint.as_deref() != Some(legacy_fingerprint.as_str());
                let value = if legacy_changed_after_sync {
                    legacy_value
                } else {
                    canonical_value
                };
                let repair_service = if legacy_changed_after_sync {
                    canonical_service
                } else {
                    legacy_service
                };
                repair_pair_and_marker(store, canonical_service, repair_service, user, &value);
                Ok(Some(value))
            }
            Ok(Some(_)) => {
                record_sync_marker(store, canonical_service, user, &canonical_value);
                Ok(Some(canonical_value))
            }
            Ok(None) | Err(_) => {
                // Repair a prior partial write without hiding a readable value
                // if the compatibility service is temporarily unavailable.
                repair_pair_and_marker(
                    store,
                    canonical_service,
                    legacy_service,
                    user,
                    &canonical_value,
                );
                Ok(Some(canonical_value))
            }
        },
        canonical_missing_or_error => match legacy {
            Ok(Some(value)) => {
                // Copy-on-read is repeatable. Never delete the source: an old
                // build still needs it after a rollback.
                repair_pair_and_marker(store, canonical_service, canonical_service, user, &value);
                Ok(Some(value))
            }
            Ok(None) => match canonical_missing_or_error {
                Ok(None) => Ok(None),
                Err(error) => Err(error),
                Ok(Some(_)) => unreachable!("handled above"),
            },
            Err(legacy_error) => match canonical_missing_or_error {
                Err(canonical_error) => Err(canonical_error),
                Ok(None) => Err(legacy_error),
                Ok(Some(_)) => unreachable!("handled above"),
            },
        },
    }
}

fn sync_marker_service(canonical_service: &str) -> String {
    format!("{canonical_service}{SYNC_MARKER_SUFFIX}")
}

fn value_fingerprint(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}

fn record_sync_marker<S: CredentialStore>(
    store: &mut S,
    canonical_service: &str,
    user: &str,
    value: &str,
) {
    let _ = store.set(
        &sync_marker_service(canonical_service),
        user,
        &value_fingerprint(value),
    );
}

fn repair_pair_and_marker<S: CredentialStore>(
    store: &mut S,
    canonical_service: &str,
    repair_service: &str,
    user: &str,
    value: &str,
) {
    if store.set(repair_service, user, value).is_ok() {
        record_sync_marker(store, canonical_service, user, value);
    }
}

fn set_password_with<S: CredentialStore>(
    store: &mut S,
    canonical_service: &str,
    legacy_service: &str,
    user: &str,
    value: &str,
) -> Result<(), S::Error> {
    // Canonical is the commit point because reads prefer it. If the process
    // stops before the compatibility write, the next canonical read repairs
    // the legacy service. Never publish a newer legacy value while canonical
    // still contains an older credential: that would let the read path
    // overwrite a rotated token with stale state.
    store.set(canonical_service, user, value)?;
    store.set(legacy_service, user, value)?;
    store.set(
        &sync_marker_service(canonical_service),
        user,
        &value_fingerprint(value),
    )
}

fn delete_password_with<S: CredentialStore>(
    store: &mut S,
    canonical_service: &str,
    legacy_service: &str,
    user: &str,
) -> Result<(), S::Error> {
    let canonical = store.delete(canonical_service, user);
    let legacy = store.delete(legacy_service, user);
    let marker = store.delete(&sync_marker_service(canonical_service), user);
    canonical.and(legacy).and(marker)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum FakeError {
        Unavailable,
    }

    #[derive(Default)]
    struct FakeStore {
        values: HashMap<(String, String), String>,
        failing_writes: HashSet<String>,
        writes: Vec<String>,
    }

    impl CredentialStore for FakeStore {
        type Error = FakeError;

        fn get(&mut self, service: &str, user: &str) -> Result<Option<String>, Self::Error> {
            Ok(self
                .values
                .get(&(service.to_string(), user.to_string()))
                .cloned())
        }

        fn set(&mut self, service: &str, user: &str, value: &str) -> Result<(), Self::Error> {
            self.writes.push(service.to_string());
            if self.failing_writes.contains(service) {
                return Err(FakeError::Unavailable);
            }
            self.values
                .insert((service.to_string(), user.to_string()), value.to_string());
            Ok(())
        }

        fn delete(&mut self, service: &str, user: &str) -> Result<(), Self::Error> {
            self.values.remove(&(service.to_string(), user.to_string()));
            Ok(())
        }
    }

    #[test]
    fn legacy_read_copies_to_clovy_without_deleting_rollback_value() {
        let mut store = FakeStore::default();
        store.values.insert(
            ("legacy".to_string(), "user".to_string()),
            "rotating-token".to_string(),
        );

        let value = get_password_with(&mut store, "clovy", "legacy", "user").unwrap();

        assert_eq!(value.as_deref(), Some("rotating-token"));
        assert_eq!(
            store.values.get(&("clovy".to_string(), "user".to_string())),
            Some(&"rotating-token".to_string())
        );
        assert!(store
            .values
            .contains_key(&("legacy".to_string(), "user".to_string())));
    }

    #[test]
    fn reads_repair_a_partial_dual_write_in_either_direction() {
        let mut canonical_only = FakeStore::default();
        canonical_only
            .values
            .insert(("clovy".to_string(), "user".to_string()), "new".to_string());
        assert_eq!(
            get_password_with(&mut canonical_only, "clovy", "legacy", "user").unwrap(),
            Some("new".to_string())
        );
        assert_eq!(
            canonical_only
                .values
                .get(&("legacy".to_string(), "user".to_string())),
            Some(&"new".to_string())
        );

        let mut legacy_only = FakeStore::default();
        legacy_only.values.insert(
            ("legacy".to_string(), "user".to_string()),
            "old".to_string(),
        );
        assert_eq!(
            get_password_with(&mut legacy_only, "clovy", "legacy", "user").unwrap(),
            Some("old".to_string())
        );
        assert_eq!(
            legacy_only
                .values
                .get(&("clovy".to_string(), "user".to_string())),
            Some(&"old".to_string())
        );
    }

    #[test]
    fn failed_copy_does_not_hide_a_readable_legacy_value() {
        let mut store = FakeStore::default();
        store.values.insert(
            ("legacy".to_string(), "user".to_string()),
            "still-readable".to_string(),
        );
        store.failing_writes.insert("clovy".to_string());

        assert_eq!(
            get_password_with(&mut store, "clovy", "legacy", "user").unwrap(),
            Some("still-readable".to_string())
        );
    }

    #[test]
    fn writes_and_deletes_cover_both_identity_sets() {
        let mut store = FakeStore::default();
        set_password_with(&mut store, "clovy", "legacy", "user", "new").unwrap();
        assert_eq!(
            store.values.get(&("clovy".to_string(), "user".to_string())),
            Some(&"new".to_string())
        );
        assert_eq!(
            store
                .values
                .get(&("legacy".to_string(), "user".to_string())),
            Some(&"new".to_string())
        );

        delete_password_with(&mut store, "clovy", "legacy", "user").unwrap();
        assert!(store.values.is_empty());
    }

    #[test]
    fn canonical_write_is_the_commit_point_for_partial_failures() {
        let mut legacy_failure = FakeStore::default();
        legacy_failure
            .values
            .insert(("clovy".to_string(), "user".to_string()), "old".to_string());
        legacy_failure.values.insert(
            ("legacy".to_string(), "user".to_string()),
            "old".to_string(),
        );
        legacy_failure.failing_writes.insert("legacy".to_string());

        assert_eq!(
            set_password_with(&mut legacy_failure, "clovy", "legacy", "user", "rotated"),
            Err(FakeError::Unavailable)
        );
        assert_eq!(legacy_failure.writes, ["clovy", "legacy"]);
        assert_eq!(
            legacy_failure
                .values
                .get(&("clovy".to_string(), "user".to_string())),
            Some(&"rotated".to_string())
        );
        assert_eq!(
            legacy_failure
                .values
                .get(&("legacy".to_string(), "user".to_string())),
            Some(&"old".to_string())
        );

        legacy_failure.failing_writes.clear();
        assert_eq!(
            get_password_with(&mut legacy_failure, "clovy", "legacy", "user").unwrap(),
            Some("rotated".to_string())
        );
        assert_eq!(
            legacy_failure
                .values
                .get(&("legacy".to_string(), "user".to_string())),
            Some(&"rotated".to_string())
        );

        let mut canonical_failure = FakeStore::default();
        canonical_failure.values.insert(
            ("legacy".to_string(), "user".to_string()),
            "rollback-readable".to_string(),
        );
        canonical_failure.failing_writes.insert("clovy".to_string());

        assert_eq!(
            set_password_with(
                &mut canonical_failure,
                "clovy",
                "legacy",
                "user",
                "uncommitted"
            ),
            Err(FakeError::Unavailable)
        );
        assert_eq!(canonical_failure.writes, ["clovy"]);
        assert_eq!(
            canonical_failure
                .values
                .get(&("legacy".to_string(), "user".to_string())),
            Some(&"rollback-readable".to_string())
        );
    }

    #[test]
    fn a_downgrade_rotation_wins_over_the_last_synchronized_value() {
        let mut store = FakeStore::default();
        set_password_with(&mut store, "clovy", "legacy", "user", "before-rollback").unwrap();

        // A released June build knows only the legacy service and can rotate a
        // refresh token while the bridge release is rolled back.
        store.values.insert(
            ("legacy".to_string(), "user".to_string()),
            "rotated-during-rollback".to_string(),
        );

        assert_eq!(
            get_password_with(&mut store, "clovy", "legacy", "user").unwrap(),
            Some("rotated-during-rollback".to_string())
        );
        assert_eq!(
            store.values.get(&("clovy".to_string(), "user".to_string())),
            Some(&"rotated-during-rollback".to_string())
        );
    }
}
