use reqwest::Client;
use std::time::Duration;

// Reasoning models on a large agent prompt (system + many tool definitions)
// can take well over a minute to produce a buffered completion; a 1-minute
// client timeout cuts those off and surfaces as upstream 502s with retries.
// Match the OS-Guard request deadline (180s) so a slow-but-valid reasoning
// turn completes instead of being killed mid-generation.
const DEFAULT_TIMEOUT: Duration = Duration::from_mins(3);
const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(90);

pub fn default_client() -> Client {
    build_client(DEFAULT_TIMEOUT)
}

pub fn jwks_client() -> Client {
    build_client(Duration::from_secs(5))
}

fn build_client(timeout: Duration) -> Client {
    Client::builder()
        .timeout(timeout)
        .pool_idle_timeout(DEFAULT_IDLE_TIMEOUT)
        .tcp_keepalive(Some(Duration::from_secs(30)))
        .user_agent("scribe-api/0.1")
        .build()
        .unwrap_or_else(|_| Client::new())
}
