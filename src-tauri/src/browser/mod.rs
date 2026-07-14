//! June-managed browser engine for unattended routines.
//!
//! The canonical transport seam lives in `browser_broker`; this module owns
//! only the managed engine and its public-web-only connection policy.

pub mod cdp;
pub mod launcher;
pub mod managed;
pub mod policy;
pub mod proxy;

use std::future::Future;
#[cfg(test)]
use std::path::Path;
use std::pin::Pin;

/// Boxed future used by the injectable resolver seam.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Reaps profiles left by a crashed prior run before managed sessions can
/// start in this app process.
pub(crate) fn setup_on_app_start() {
    launcher::sweep_profiles_root();
}

#[cfg(test)]
fn setup_on_app_start_at(profiles_root: &Path) {
    launcher::sweep_profiles_root_at(profiles_root);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_start_setup_removes_stale_managed_profiles() {
        let root = tempfile::tempdir().expect("temporary root");
        let profiles = root.path().join("browser-profiles");
        let stale = profiles.join("stale-after-crash");
        std::fs::create_dir_all(&stale).expect("stale profile");

        setup_on_app_start_at(&profiles);

        assert!(!profiles.exists(), "startup must reap crashed-run profiles");
    }
}
