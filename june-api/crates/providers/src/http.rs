use reqwest::{Client, ClientBuilder};
use std::time::Duration;

pub(crate) const DEFAULT_TIMEOUT_SECS: u64 = 60;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(DEFAULT_TIMEOUT_SECS);
const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(90);

pub fn default_client() -> Client {
    build_client(DEFAULT_TIMEOUT)
}

pub fn client_with_timeout(timeout: Duration) -> Client {
    build_client(timeout)
}

/// Dedicated os-platform issue-report client. Uploading a 300 MiB attachment
/// can legitimately exceed the shared client's 60-second budget, so this
/// client follows the configured June API request timeout instead.
///
/// This only extends the per-request timeout and explicitly disables reqwest's
/// default protocol-NACK retries: os-platform file and Issue creation POSTs are
/// not idempotent, so replaying a timed-out request can create duplicates.
pub fn issue_report_client(request_timeout: Duration) -> Result<Client, reqwest::Error> {
    client_builder(request_timeout)
        .retry(reqwest::retry::never())
        .build()
}

pub fn jwks_client() -> Client {
    build_client(Duration::from_secs(5))
}

fn build_client(timeout: Duration) -> Client {
    client_builder(timeout)
        .build()
        .unwrap_or_else(|_| Client::new())
}

fn client_builder(timeout: Duration) -> ClientBuilder {
    Client::builder()
        .timeout(timeout)
        .pool_idle_timeout(DEFAULT_IDLE_TIMEOUT)
        .tcp_keepalive(Some(Duration::from_secs(30)))
        .user_agent("june-api/0.1")
}
