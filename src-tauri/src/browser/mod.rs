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
use std::pin::Pin;

/// Boxed future used by the injectable resolver seam.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
