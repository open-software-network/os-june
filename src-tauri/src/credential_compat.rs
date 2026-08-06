//! Rollback-safe credential migration from June-era Keychain services.
//!
//! The bridge deliberately keeps both services current. A released June build
//! may be installed again after Clovy rotates an OS Accounts or connector
//! token, so a one-time copy is not sufficient.

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
    match canonical {
        Ok(Some(value)) => {
            // Repair a prior partial write without hiding a readable value if
            // the compatibility service is temporarily unavailable.
            let _ = store.set(legacy_service, user, &value);
            Ok(Some(value))
        }
        canonical_missing_or_error => match store.get(legacy_service, user) {
            Ok(Some(value)) => {
                // Copy-on-read is repeatable. Never delete the source: an old
                // build still needs it after a rollback.
                let _ = store.set(canonical_service, user, &value);
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

fn set_password_with<S: CredentialStore>(
    store: &mut S,
    canonical_service: &str,
    legacy_service: &str,
    user: &str,
    value: &str,
) -> Result<(), S::Error> {
    // Attempt both writes even when one fails. Writing the legacy service
    // first keeps the newly rotated token readable by both Clovy and a
    // rollback build if the process stops between writes.
    let legacy = store.set(legacy_service, user, value);
    let canonical = store.set(canonical_service, user, value);
    canonical.and(legacy)
}

fn delete_password_with<S: CredentialStore>(
    store: &mut S,
    canonical_service: &str,
    legacy_service: &str,
    user: &str,
) -> Result<(), S::Error> {
    let canonical = store.delete(canonical_service, user);
    let legacy = store.delete(legacy_service, user);
    canonical.and(legacy)
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
        assert_eq!(store.values.len(), 2);

        delete_password_with(&mut store, "clovy", "legacy", "user").unwrap();
        assert!(store.values.is_empty());
    }
}
