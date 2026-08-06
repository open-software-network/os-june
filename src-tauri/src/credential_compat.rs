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

pub(crate) fn take_password(
    canonical_service: &str,
    legacy_service: &str,
    user: &str,
) -> Result<Option<String>, keyring::Error> {
    take_password_with(&mut KeyringStore, canonical_service, legacy_service, user)
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
    // Absence and an unavailable keychain service have opposite meanings. Read
    // all three records successfully before repairing anything so a transient
    // failure can never overwrite a rollback rotation or sign-out.
    let canonical = store.get(canonical_service, user)?;
    let legacy = store.get(legacy_service, user)?;
    let marker_service = sync_marker_service(canonical_service);
    let prior_marker = store.get(&marker_service, user)?;

    if let Some(delete_marker) = prior_marker
        .as_deref()
        .filter(|marker| marker.starts_with(DELETE_MARKER_PREFIX))
    {
        // Only the rollback-readable service can prove a login happened after
        // a committed delete. Canonical-only data may be stale cleanup from a
        // partial delete and must never resurrect the account.
        if let Some(legacy_value) = legacy.as_ref() {
            if !deletion_marker_contains(delete_marker, legacy_value) {
                repair_pair_and_marker(
                    store,
                    canonical_service,
                    canonical_service,
                    user,
                    legacy_value,
                );
                return Ok(Some(legacy_value.clone()));
            }
        }

        let canonical_deleted = store.delete(canonical_service, user).is_ok();
        let legacy_deleted = store.delete(legacy_service, user).is_ok();
        if canonical_deleted && legacy_deleted {
            let _ = store.delete(&marker_service, user);
        }
        return Ok(None);
    }

    match (canonical, legacy) {
        (Some(canonical_value), Some(legacy_value)) if canonical_value == legacy_value => {
            let _ = record_sync_marker(store, canonical_service, user, &canonical_value);
            Ok(Some(canonical_value))
        }
        (Some(canonical_value), Some(legacy_value)) => {
            let canonical_fingerprint = value_fingerprint(&canonical_value);
            let legacy_fingerprint = value_fingerprint(&legacy_value);

            // A rollback build can rotate only the legacy entry. The marker
            // records the last common value; canonical wins only when that
            // marker proves canonical changed afterward. Unknown divergence
            // defaults to the rollback-readable side.
            let canonical_changed_after_sync = prior_marker.as_deref()
                == Some(legacy_fingerprint.as_str())
                && prior_marker.as_deref() != Some(canonical_fingerprint.as_str());
            let (value, repair_service) = if canonical_changed_after_sync {
                (canonical_value, legacy_service)
            } else {
                (legacy_value, canonical_service)
            };
            repair_pair_and_marker(store, canonical_service, repair_service, user, &value);
            Ok(Some(value))
        }
        (None, Some(legacy_value)) => {
            // The released app knows only this service, so preserve it and
            // make migration copy-on-read and retryable.
            repair_pair_and_marker(
                store,
                canonical_service,
                canonical_service,
                user,
                &legacy_value,
            );
            Ok(Some(legacy_value))
        }
        (Some(_), None) => {
            // Clovy writes legacy first. Therefore canonical-only state is not
            // an interrupted Clovy write; it is a rollback sign-out (including
            // the case where a prior marker write failed).
            if store.delete(canonical_service, user).is_ok() {
                let _ = store.delete(&marker_service, user);
            }
            Ok(None)
        }
        (None, None) => {
            let _ = store.delete(&marker_service, user);
            Ok(None)
        }
    }
}

fn sync_marker_service(canonical_service: &str) -> String {
    format!("{canonical_service}{SYNC_MARKER_SUFFIX}")
}

fn value_fingerprint(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}

fn deletion_marker_contains(marker: &str, value: &str) -> bool {
    let fingerprint = value_fingerprint(value);
    marker
        .strip_prefix(DELETE_MARKER_PREFIX)
        .is_some_and(|fingerprints| fingerprints.split(',').any(|item| item == fingerprint))
}

fn deletion_marker(
    prior_marker: Option<&str>,
    canonical: Option<&str>,
    legacy: Option<&str>,
) -> String {
    let mut fingerprints = prior_marker
        .and_then(|marker| marker.strip_prefix(DELETE_MARKER_PREFIX))
        .into_iter()
        .flat_map(|items| items.split(','))
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    fingerprints.extend(
        [canonical, legacy]
            .into_iter()
            .flatten()
            .map(value_fingerprint),
    );
    fingerprints.sort_unstable();
    fingerprints.dedup();
    format!("{DELETE_MARKER_PREFIX}{}", fingerprints.join(","))
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
) {
    if store.set(repair_service, user, value).is_ok() {
        // A failed marker write leaves an equal pair. Legacy absence remains
        // authoritative, and the next read retries publication.
        let _ = record_sync_marker(store, canonical_service, user, value);
    }
}

fn set_password_with<S: CredentialStore>(
    store: &mut S,
    canonical_service: &str,
    legacy_service: &str,
    user: &str,
    value: &str,
) -> Result<(), S::Error> {
    // The rollback-readable service is the commit point. If canonical or the
    // marker fails, the next read promotes the already-published legacy value.
    store.set(legacy_service, user, value)?;
    store.set(canonical_service, user, value)?;
    store.set(
        &sync_marker_service(canonical_service),
        user,
        &value_fingerprint(value),
    )
}

#[derive(Debug, PartialEq, Eq)]
enum DeleteCommitOutcome<E> {
    Complete,
    CleanupPending(E),
}

fn delete_password_with<S: CredentialStore>(
    store: &mut S,
    canonical_service: &str,
    legacy_service: &str,
    user: &str,
) -> Result<(), S::Error> {
    match delete_password_state_with(store, canonical_service, legacy_service, user)? {
        DeleteCommitOutcome::Complete => Ok(()),
        DeleteCommitOutcome::CleanupPending(error) => Err(error),
    }
}

fn take_password_with<S: CredentialStore>(
    store: &mut S,
    canonical_service: &str,
    legacy_service: &str,
    user: &str,
) -> Result<Option<String>, S::Error> {
    let value = get_password_with(store, canonical_service, legacy_service, user)?;
    // Once the tombstone commits, retrying would hide this already-read
    // one-shot value. Deliver it even if physical keychain cleanup is pending.
    let _ = delete_password_state_with(store, canonical_service, legacy_service, user)?;
    Ok(value)
}

fn delete_password_state_with<S: CredentialStore>(
    store: &mut S,
    canonical_service: &str,
    legacy_service: &str,
    user: &str,
) -> Result<DeleteCommitOutcome<S::Error>, S::Error> {
    // Tombstone every value observed before deletion. A divergent stale side
    // can then never masquerade as a new login if only part of cleanup works.
    let canonical = store.get(canonical_service, user)?;
    let legacy = store.get(legacy_service, user)?;
    let marker_service = sync_marker_service(canonical_service);
    let prior_marker = store.get(&marker_service, user)?;
    let marker = deletion_marker(
        prior_marker.as_deref(),
        canonical.as_deref(),
        legacy.as_deref(),
    );
    store.set(&marker_service, user, &marker)?;

    let legacy = store.delete(legacy_service, user);
    let canonical = store.delete(canonical_service, user);
    match (legacy, canonical) {
        (Ok(()), Ok(())) => match store.delete(&marker_service, user) {
            Ok(()) => Ok(DeleteCommitOutcome::Complete),
            Err(error) => Ok(DeleteCommitOutcome::CleanupPending(error)),
        },
        (Err(error), _) | (Ok(()), Err(error)) => Ok(DeleteCommitOutcome::CleanupPending(error)),
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
    fn reads_promote_legacy_and_treat_canonical_only_as_rollback_sign_out() {
        let mut canonical_only = FakeStore::default();
        canonical_only
            .values
            .insert(("clovy".to_string(), "user".to_string()), "new".to_string());
        assert_eq!(
            get_password_with(&mut canonical_only, "clovy", "legacy", "user").unwrap(),
            None
        );
        assert!(canonical_only.values.is_empty());

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
    fn credential_read_failure_never_repairs_the_unreadable_service() {
        let mut store = FakeStore::default();
        set_password_with(&mut store, "clovy", "legacy", "user", "synced").unwrap();
        store.values.insert(
            ("legacy".to_string(), "user".to_string()),
            "rollback-rotation".to_string(),
        );
        store.failing_reads.insert("legacy".to_string());

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

        // Even without the marker, the legacy-first invariant makes a June
        // rollback sign-out authoritative on the next Clovy launch.
        store.failing_writes.clear();
        store.delete("legacy", "user").unwrap();
        assert_eq!(
            get_password_with(&mut store, "clovy", "legacy", "user").unwrap(),
            None
        );
        assert!(store.values.is_empty());
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
    fn divergent_values_are_all_tombstoned_before_partial_cleanup() {
        let mut store = FakeStore::default();
        set_password_with(&mut store, "clovy", "legacy", "user", "canonical-stale").unwrap();
        store.values.insert(
            ("legacy".to_string(), "user".to_string()),
            "rollback-rotation".to_string(),
        );
        store.failing_deletes.insert("clovy".to_string());

        assert_eq!(
            delete_password_with(&mut store, "clovy", "legacy", "user"),
            Err(FakeError::Unavailable)
        );
        assert_eq!(
            get_password_with(&mut store, "clovy", "legacy", "user").unwrap(),
            None
        );
        assert_eq!(
            store.values.get(&("clovy".to_string(), "user".to_string())),
            Some(&"canonical-stale".to_string())
        );
        assert!(!store
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
    fn one_shot_take_delivers_after_logical_delete_commits() {
        let mut store = FakeStore::default();
        set_password_with(&mut store, "clovy", "legacy", "user", "one-shot").unwrap();
        store.failing_deletes.insert("clovy".to_string());

        assert_eq!(
            take_password_with(&mut store, "clovy", "legacy", "user").unwrap(),
            Some("one-shot".to_string())
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
