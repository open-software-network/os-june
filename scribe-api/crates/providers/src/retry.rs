use reqwest::StatusCode;
use scribe_domain::DomainError;
use std::time::Duration;

/// Total attempts per upstream call: the original request plus one retry.
/// Mirrors the bounded charge retry in `os_accounts.rs` — enough to absorb a
/// connection reset or a momentary 429/5xx without blowing the desktop
/// client's request budget.
pub(crate) const UPSTREAM_ATTEMPTS: u32 = 2;
pub(crate) const UPSTREAM_RETRY_BACKOFF: Duration = Duration::from_millis(300);

/// A single failed upstream attempt, classified so the caller knows whether
/// another attempt is worth making.
pub(crate) struct UpstreamAttemptError {
    pub(crate) error: DomainError,
    pub(crate) retryable: bool,
}

impl UpstreamAttemptError {
    pub(crate) fn fatal(error: DomainError) -> Self {
        Self {
            error,
            retryable: false,
        }
    }
}

/// Transient HTTP statuses worth one more attempt: request timeout, rate
/// limit, and any 5xx. Everything else (4xx) is deterministic and must not
/// be replayed.
pub(crate) fn is_retryable_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

/// Transport errors worth retrying (connection refused/reset, broken pipe).
/// Timeouts are excluded on purpose: the per-attempt timeout already consumes
/// most of the caller's budget, so a second attempt would land after the
/// client has given up. Builder errors are deterministic and excluded too.
pub(crate) fn is_retryable_transport_error(error: &reqwest::Error) -> bool {
    !error.is_timeout() && !error.is_builder()
}

#[cfg(test)]
mod tests {
    use super::is_retryable_status;
    use reqwest::StatusCode;

    #[test]
    fn server_errors_and_rate_limits_are_retryable() {
        assert!(is_retryable_status(StatusCode::INTERNAL_SERVER_ERROR));
        assert!(is_retryable_status(StatusCode::BAD_GATEWAY));
        assert!(is_retryable_status(StatusCode::SERVICE_UNAVAILABLE));
        assert!(is_retryable_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(is_retryable_status(StatusCode::REQUEST_TIMEOUT));
    }

    #[test]
    fn deterministic_client_errors_are_not_retryable() {
        assert!(!is_retryable_status(StatusCode::BAD_REQUEST));
        assert!(!is_retryable_status(StatusCode::UNAUTHORIZED));
        assert!(!is_retryable_status(StatusCode::PAYLOAD_TOO_LARGE));
        assert!(!is_retryable_status(StatusCode::UNPROCESSABLE_ENTITY));
    }
}
