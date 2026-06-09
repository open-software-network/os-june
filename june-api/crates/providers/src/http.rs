use reqwest::Client;
use std::time::Duration;

const DEFAULT_TIMEOUT: Duration = Duration::from_mins(1);
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
        .user_agent("june-api/0.1")
        .build()
        .unwrap_or_else(|_| Client::new())
}
