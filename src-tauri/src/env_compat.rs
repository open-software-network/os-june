//! Clovy-first environment lookup with June-era compatibility aliases.

use std::ffi::OsString;

pub(crate) fn var(canonical: &str, legacy: &str) -> Option<String> {
    match std::env::var(canonical) {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => std::env::var(legacy).ok(),
        Err(std::env::VarError::NotUnicode(_)) => None,
    }
}

pub(crate) fn var_os(canonical: &str, legacy: &str) -> Option<OsString> {
    std::env::var_os(canonical).or_else(|| std::env::var_os(legacy))
}

pub(crate) fn trimmed(canonical: &str, legacy: &str) -> String {
    var(canonical, legacy)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

pub(crate) fn truthy(canonical: &str, legacy: &str) -> bool {
    matches!(
        trimmed(canonical, legacy).to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    const CANONICAL: &str = "CLOVY_ENV_COMPAT_TEST_VALUE";
    const LEGACY: &str = "JUNE_ENV_COMPAT_TEST_VALUE";
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn lock_env() -> MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn clear() {
        std::env::remove_var(CANONICAL);
        std::env::remove_var(LEGACY);
    }

    #[test]
    fn canonical_value_wins_even_when_it_is_explicitly_false() {
        let _guard = lock_env();
        clear();
        std::env::set_var(LEGACY, "true");
        std::env::set_var(CANONICAL, "false");

        assert_eq!(var(CANONICAL, LEGACY).as_deref(), Some("false"));
        assert!(!truthy(CANONICAL, LEGACY));
        clear();
    }

    #[test]
    fn legacy_value_remains_a_fallback() {
        let _guard = lock_env();
        clear();
        std::env::set_var(LEGACY, " yes ");

        assert_eq!(trimmed(CANONICAL, LEGACY), "yes");
        assert!(truthy(CANONICAL, LEGACY));
        clear();
    }
}
