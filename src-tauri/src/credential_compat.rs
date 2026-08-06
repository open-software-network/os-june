//! Rollback-safe credential migration from June-era Keychain services.
//!
//! The bridge deliberately keeps both services current. A released June build
//! may be installed again after Clovy rotates an OS Accounts or connector
//! token, so a one-time copy is not sufficient.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};

const SYNC_MARKER_SUFFIX: &str = ".compat-sync";
const DELETE_MARKER_PREFIX: &str = "deleted:";

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
    let marker_service = sync_marker_service(canonical_service);
    // A marker read failure is different from a missing marker. Continuing
    // without that distinction could overwrite the side changed by a rollback
    // build, so leave both credentials untouched and let the caller retry.
    let prior_marker = store.get(&marker_service, user)?;

    if let Some(deleted_fingerprint) = prior_marker
        .as_deref()
        .and_then(|marker| marker.strip_prefix(DELETE_MARKER_PREFIX))
    {
        // Prefer the rollback-readable side when both changed after a pending
        // delete. Released June builds can only publish to the legacy service.
        let changed_after_delete = legacy
            .as_ref()
            .ok()
            .and_then(Option::as_ref)
            .filter(|value| value_fingerprint(value) != deleted_fingerprint)
            .or_else(|| {
                canonical
                    .as_ref()
                    .ok()
                    .and_then(Option::as_ref)
                    .filter(|value| value_fingerprint(value) != deleted_fingerprint)
            })
            .cloned();
        if let Some(value) = changed_after_delete {
            store.set(legacy_service, user, &value)?;
            store.set(canonical_service, user, &value)?;
            record_sync_marker(store, canonical_service, user, &value)?;
            return Ok(Some(value));
        }

        let canonical_deleted = store.delete(canonical_service, user).is_ok();
        let legacy_deleted = store.delete(legacy_service, user).is_ok();
        if canonical_deleted && legacy_deleted {
            store.delete(&marker_service, user)?;
        }
        return Ok(None);
    }

    match canonical {
        Ok(Some(canonical_value)) => match legacy {
            Ok(Some(legacy_value)) if canonical_value != legacy_value => {
                let canonical_fingerprint = value_fingerprint(&canonical_value);
                let legacy_fingerprint = value_fingerprint(&legacy_value);

                // A rollback build can rotate only the legacy entry. The
                // marker records the last value known to be common to both
                // services, so divergence can be resolved without guessing.
                let canonical_changed_after_sync = prior_marker.as_deref()
                    == Some(legacy_fingerprint.as_str())
                    && prior_marker.as_deref() != Some(canonical_fingerprint.as_str());
                let (value, repair_service) = if canonical_changed_after_sync {
                    (canonical_value, legacy_service)
                } else {
                    // This covers a known legacy-side change, a missing marker,
                    // and both sides changing since the marker. The legacy
                    // value is the only one a released rollback build can see.
                    (legacy_value, canonical_service)
                };
                repair_pair_and_marker(store, canonical_service, repair_service, user, &value)?;
                Ok(Some(value))
            }
            Ok(Some(_)) => {
                record_sync_marker(store, canonical_service, user, &canonical_value)?;
                Ok(Some(canonical_value))
            }
            Ok(None) => {
                if propagate_synced_deletion(
                    store,
                    canonical_service,
                    canonical_service,
                    user,
                    &canonical_value,
                    prior_marker.as_deref(),
                )? {
                    return Ok(None);
                }
                repair_pair_and_marker(
                    store,
                    canonical_service,
                    legacy_service,
                    user,
                    &canonical_value,
                )?;
                Ok(Some(canonical_value))
            }
            Err(_) => {
                // Repair a prior partial write without hiding a readable value
                // if the compatibility service is temporarily unavailable.
                repair_pair_and_marker(
                    store,
                    canonical_service,
                    legacy_service,
                    user,
                    &canonical_value,
                )?;
                Ok(Some(canonical_value))
            }
        },
        canonical_missing_or_error => match legacy {
            Ok(Some(value)) => {
                // Copy-on-read is repeatable. Never delete the source: an old
                // build still needs it after a rollback. Only a rollback can
                // remove the legacy side without going through this bridge, so
                // a missing canonical side is never interpreted as sign-out.
                repair_pair_and_marker(store, canonical_service, canonical_service, user, &value)?;
                Ok(Some(value))
            }
            Ok(None) => match canonical_missing_or_error {
                Ok(None) => {
                    let _ = store.delete(&sync_marker_service(canonical_service), user);
                    Ok(None)
                }
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
) -> Result<(), S::Error> {
    store.set(
        &sync_marker_service(canonical_service),
        user,
        &value_fingerprint(value),
    )
}

fn repair_pair_and_marker<S: CredentialStore>(
    store: &mut S,
    canonical_service: &str,
    repair_service: &str,
    user: &str,
    value: &str,
) -> Result<(), S::Error> {
    if store.set(repair_service, user, value).is_err() {
        // Preserve availability when the value we just read remains usable;
        // copy-on-read will retry the failed repair later.
        return Ok(());
    }
    record_sync_marker(store, canonical_service, user, value)
}

fn propagate_synced_deletion<S: CredentialStore>(
    store: &mut S,
    canonical_service: &str,
    remaining_service: &str,
    user: &str,
    remaining_value: &str,
    prior_marker: Option<&str>,
) -> Result<bool, S::Error> {
    let remaining_fingerprint = value_fingerprint(remaining_value);
    if prior_marker != Some(remaining_fingerprint.as_str()) {
        return Ok(false);
    }
    store.delete(remaining_service, user)?;
    store.delete(&sync_marker_service(canonical_service), user)?;
    Ok(true)
}

fn set_password_with<S: CredentialStore>(
    store: &mut S,
    canonical_service: &str,
    legacy_service: &str,
    user: &str,
    value: &str,
) -> Result<(), S::Error> {
    // Converge and mark the current pair before publishing a rotation. The
    // rollback-readable service is written first: if the process stops before
    // canonical catches up, a released June build still receives the rotated
    // credential, while the marker tells Clovy that legacy is the newer side.
    let _ = get_password_with(store, canonical_service, legacy_service, user)?;
    store.set(legacy_service, user, value)?;
    store.set(canonical_service, user, value)?;
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
    let prior_value = get_password_with(store, canonical_service, legacy_service, user)?;
    let deleted_fingerprint = prior_value
        .as_deref()
        .map(value_fingerprint)
        .unwrap_or_default();
    let marker_service = sync_marker_service(canonical_service);
    store.set(
        &marker_service,
        user,
        &format!("{DELETE_MARKER_PREFIX}{deleted_fingerprint}"),
    )?;

    let legacy = store.delete(legacy_service, user);
    let canonical = store.delete(canonical_service, user);
    match (legacy, canonical) {
        (Ok(()), Ok(())) => store.delete(&marker_service, user),
        (Err(error), _) | (Ok(()), Err(error)) => Err(error),
    }
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
        failing_deletes: HashSet<String>,
        failing_reads: HashSet<String>,
        failing_writes: HashSet<String>,
    }

    impl CredentialStore for FakeStore {
        type Error = FakeError;

        fn get(&mut self, service: &str, user: &str) -> Result<Option<String>, Self::Error> {
            if self.failing_reads.contains(service) {
                return Err(FakeError::Unavailable);
            }
            Ok(self
                .values
                .get(&(service.to_string(), user.to_string()))
                .cloned())
        }

        fn set(&mut self, service: &str, user: &str, value: &str) -> Result<(), Self::Error> {
            if self.failing_writes.contains(service) {
                return Err(FakeError::Unavailable);
            }
            self.values
                .insert((service.to_string(), user.to_string()), value.to_string());
            Ok(())
        }

        fn delete(&mut self, service: &str, user: &str) -> Result<(), Self::Error> {
            if self.failing_deletes.contains(service) {
                return Err(FakeError::Unavailable);
            }
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
    fn rollback_write_is_the_commit_point_for_partial_failures() {
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
        assert_eq!(
            legacy_failure
                .values
                .get(&("clovy".to_string(), "user".to_string())),
            Some(&"old".to_string())
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
            Some("old".to_string())
        );

        let mut canonical_failure = FakeStore::default();
        canonical_failure
            .values
            .insert(("clovy".to_string(), "user".to_string()), "old".to_string());
        canonical_failure.values.insert(
            ("legacy".to_string(), "user".to_string()),
            "old".to_string(),
        );
        canonical_failure.failing_writes.insert("clovy".to_string());

        assert_eq!(
            set_password_with(&mut canonical_failure, "clovy", "legacy", "user", "rotated"),
            Err(FakeError::Unavailable)
        );
        assert_eq!(
            canonical_failure
                .values
                .get(&("legacy".to_string(), "user".to_string())),
            Some(&"rotated".to_string())
        );
        assert_eq!(
            canonical_failure
                .values
                .get(&("clovy".to_string(), "user".to_string())),
            Some(&"old".to_string())
        );

        // A rollback build can rotate the already-published legacy token
        // again before Clovy repairs the interrupted write.
        canonical_failure.values.insert(
            ("legacy".to_string(), "user".to_string()),
            "rollback-rotation".to_string(),
        );
        canonical_failure.failing_writes.clear();
        assert_eq!(
            get_password_with(&mut canonical_failure, "clovy", "legacy", "user").unwrap(),
            Some("rollback-rotation".to_string())
        );
        assert_eq!(
            canonical_failure
                .values
                .get(&("clovy".to_string(), "user".to_string())),
            Some(&"rollback-rotation".to_string())
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

    #[test]
    fn marker_read_failure_never_repairs_a_divergent_pair() {
        let mut store = FakeStore::default();
        set_password_with(&mut store, "clovy", "legacy", "user", "synced").unwrap();
        store.values.insert(
            ("legacy".to_string(), "user".to_string()),
            "rollback-rotation".to_string(),
        );
        store.failing_reads.insert("clovy.compat-sync".to_string());

        assert_eq!(
            get_password_with(&mut store, "clovy", "legacy", "user"),
            Err(FakeError::Unavailable)
        );
        assert_eq!(
            store.values.get(&("clovy".to_string(), "user".to_string())),
            Some(&"synced".to_string())
        );
        assert_eq!(
            store
                .values
                .get(&("legacy".to_string(), "user".to_string())),
            Some(&"rollback-rotation".to_string())
        );
    }

    #[test]
    fn marker_write_failure_is_reported_after_the_pair_is_safe() {
        let mut store = FakeStore::default();
        store.failing_writes.insert("clovy.compat-sync".to_string());

        assert_eq!(
            set_password_with(&mut store, "clovy", "legacy", "user", "new"),
            Err(FakeError::Unavailable)
        );
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
    }

    #[test]
    fn a_partial_delete_cannot_resurrect_the_remaining_credential() {
        let mut store = FakeStore::default();
        set_password_with(&mut store, "clovy", "legacy", "user", "signed-in").unwrap();
        store.failing_deletes.insert("legacy".to_string());

        assert_eq!(
            delete_password_with(&mut store, "clovy", "legacy", "user"),
            Err(FakeError::Unavailable)
        );
        assert!(!store
            .values
            .contains_key(&("clovy".to_string(), "user".to_string())));
        assert!(store
            .values
            .contains_key(&("legacy".to_string(), "user".to_string())));

        store.failing_deletes.clear();
        assert_eq!(
            get_password_with(&mut store, "clovy", "legacy", "user").unwrap(),
            None
        );
        assert!(store.values.is_empty());
    }

    #[test]
    fn a_committed_delete_stays_signed_out_until_keychain_cleanup_recovers() {
        let mut store = FakeStore::default();
        set_password_with(&mut store, "clovy", "legacy", "user", "signed-in").unwrap();
        store
            .failing_deletes
            .extend(["clovy".to_string(), "legacy".to_string()]);

        assert_eq!(
            delete_password_with(&mut store, "clovy", "legacy", "user"),
            Err(FakeError::Unavailable)
        );
        assert_eq!(
            get_password_with(&mut store, "clovy", "legacy", "user").unwrap(),
            None
        );

        store.failing_deletes.clear();
        assert_eq!(
            get_password_with(&mut store, "clovy", "legacy", "user").unwrap(),
            None
        );
        assert!(store.values.is_empty());
    }

    #[test]
    fn a_rollback_login_after_a_pending_delete_is_preserved() {
        let mut store = FakeStore::default();
        set_password_with(&mut store, "clovy", "legacy", "user", "before-delete").unwrap();
        store
            .failing_deletes
            .extend(["clovy".to_string(), "legacy".to_string()]);
        assert_eq!(
            delete_password_with(&mut store, "clovy", "legacy", "user"),
            Err(FakeError::Unavailable)
        );

        // A rollback build can sign in again using only the June-era service.
        store.values.insert(
            ("legacy".to_string(), "user".to_string()),
            "rollback-login".to_string(),
        );
        store.failing_deletes.clear();

        assert_eq!(
            get_password_with(&mut store, "clovy", "legacy", "user").unwrap(),
            Some("rollback-login".to_string())
        );
        assert_eq!(
            store.values.get(&("clovy".to_string(), "user".to_string())),
            Some(&"rollback-login".to_string())
        );
    }

    #[test]
    fn a_rollback_sign_out_removes_the_canonical_credential_on_reupgrade() {
        let mut store = FakeStore::default();
        set_password_with(&mut store, "clovy", "legacy", "user", "signed-in").unwrap();

        // A released June build only knows the legacy service.
        store
            .delete("legacy", "user")
            .expect("rollback credential delete");

        assert_eq!(
            get_password_with(&mut store, "clovy", "legacy", "user").unwrap(),
            None
        );
        assert!(store.values.is_empty());
    }

    #[test]
    fn a_missing_canonical_entry_never_erases_the_rollback_credential() {
        let mut store = FakeStore::default();
        set_password_with(&mut store, "clovy", "legacy", "user", "signed-in").unwrap();
        store
            .delete("clovy", "user")
            .expect("simulate missing canonical credential");

        assert_eq!(
            get_password_with(&mut store, "clovy", "legacy", "user").unwrap(),
            Some("signed-in".to_string())
        );
        assert_eq!(
            store.values.get(&("clovy".to_string(), "user".to_string())),
            Some(&"signed-in".to_string())
        );
    }
}
