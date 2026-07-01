use crate::error::ServiceError;
use june_domain::{
    ActionSlug, Authorization, AuthorizeRequest, ChargeRequest, Credits, OsAccountsClient, Receipt,
    UserId,
};
use std::cmp::min;

pub(crate) struct AuthorizationOutcome {
    pub action_token: String,
    pub cap_credits: Credits,
}

pub(crate) struct AuthorizeParams<'a> {
    pub os_accounts: &'a dyn OsAccountsClient,
    pub user_id: UserId,
    pub action: ActionSlug,
    pub estimate: Credits,
    pub hold_ttl_seconds: u64,
}

pub(crate) async fn authorize_or_deny(
    params: AuthorizeParams<'_>,
) -> Result<AuthorizationOutcome, ServiceError> {
    let authorization = params
        .os_accounts
        .authorize(AuthorizeRequest {
            user_id: params.user_id,
            action: params.action,
            estimate: params.estimate,
            hold_ttl_seconds: params.hold_ttl_seconds,
        })
        .await?;
    action_token_or_error(authorization)
}

fn action_token_or_error(
    authorization: Authorization,
) -> Result<AuthorizationOutcome, ServiceError> {
    if !authorization.allowed {
        // Only a genuine balance shortfall should tell the user to add funds.
        // Other denials (e.g. concurrency_cap_exceeded) are transient and must
        // NOT surface as "insufficient credits" — that's how a user with a
        // healthy balance ends up staring at an "Add funds" banner.
        if is_insufficient_balance(authorization.reason.as_deref()) {
            tracing::warn!(
                reason = ?authorization.reason,
                "authorization denied — insufficient balance"
            );
            return Err(ServiceError::InsufficientCredits);
        }
        tracing::warn!(
            reason = ?authorization.reason,
            "authorization denied — transient/non-balance reason"
        );
        return Err(ServiceError::AuthorizationDenied);
    }
    let token = authorization
        .action_token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| {
            tracing::error!(
                cap_credits = ?authorization.cap_credits,
                reason = ?authorization.reason,
                "authorization allowed but action_token is missing or empty"
            );
            ServiceError::AuthorizationDenied
        })?;
    let cap_credits = authorization.cap_credits.ok_or_else(|| {
        tracing::error!(
            reason = ?authorization.reason,
            "authorization allowed but cap_credits is missing"
        );
        ServiceError::MeteringProvider
    })?;
    if cap_credits.0 == 0 {
        tracing::warn!(
            reason = ?authorization.reason,
            "authorization allowed with zero cap_credits"
        );
        return Err(ServiceError::InsufficientCredits);
    }
    Ok(AuthorizationOutcome {
        action_token: token,
        cap_credits,
    })
}

/// True only for denial reasons that mean the user is actually out of money.
/// The OS Accounts provider normalizes a 4301 to `insufficient_available_balance`;
/// we also accept the raw reasons in case they ever reach us unmapped. Anything
/// else (concurrency caps, rate limits, etc.) is treated as transient.
fn is_insufficient_balance(reason: Option<&str>) -> bool {
    reason.is_some_and(|reason| {
        let reason = reason.to_ascii_lowercase();
        reason.contains("insufficient_available_balance")
            || reason.contains("insufficient_credits")
            || reason.contains("insufficient_balance")
    })
}

pub(crate) fn clamp_to_cap(actual: Credits, cap: Credits) -> Credits {
    Credits(min(actual.0, cap.0))
}

pub(crate) fn zero_receipt() -> Receipt {
    Receipt {
        credits_charged: Credits(0),
        idempotent_replay: false,
    }
}

pub(crate) struct ChargeParams<'a> {
    pub os_accounts: &'a dyn OsAccountsClient,
    pub action_token: String,
    pub credits: Credits,
    pub idempotency_key: String,
}

pub(crate) async fn charge(params: ChargeParams<'_>) -> Result<Receipt, ServiceError> {
    params
        .os_accounts
        .charge(ChargeRequest {
            action_token: params.action_token,
            credits: params.credits,
            idempotency_key: params.idempotency_key,
        })
        .await
        .map_err(ServiceError::from)
}

pub(crate) struct AsyncChargeParams {
    pub os_accounts: std::sync::Arc<dyn OsAccountsClient>,
    pub user_id: UserId,
    pub action: ActionSlug,
    pub model_id: Option<String>,
    pub action_token: String,
    pub credits: Credits,
    pub idempotency_key: String,
}

pub(crate) fn spawn_charge(params: AsyncChargeParams) {
    tokio::spawn(async move {
        settle_charge(params).await;
    });
}

async fn settle_charge(params: AsyncChargeParams) {
    let receipt = match charge(ChargeParams {
        os_accounts: params.os_accounts.as_ref(),
        action_token: params.action_token,
        credits: params.credits,
        idempotency_key: params.idempotency_key,
    })
    .await
    {
        Ok(receipt) => receipt,
        Err(error) => {
            tracing::warn!(
                user_id = %params.user_id.0,
                action = params.action.as_str(),
                model = params.model_id.as_deref().unwrap_or("unknown"),
                error = %error,
                "async metering charge failed"
            );
            return;
        }
    };
    tracing::info!(
        user_id = %params.user_id.0,
        action = params.action.as_str(),
        model = params.model_id.as_deref().unwrap_or("unknown"),
        credits_charged = receipt.credits_charged.0,
        idempotent_replay = receipt.idempotent_replay,
        "settled async metered request"
    );
}

pub(crate) fn log_settled(action: ActionSlug, user_id: &UserId, model_id: &str, receipt: &Receipt) {
    tracing::info!(
        user_id = %user_id.0,
        action = action.as_str(),
        model = model_id,
        credits_charged = receipt.credits_charged.0,
        idempotent_replay = receipt.idempotent_replay,
        "settled metered request",
    );
}

#[cfg(test)]
mod tests {
    use super::{action_token_or_error, is_insufficient_balance};
    use crate::error::ServiceError;
    use june_domain::{Authorization, Credits};

    fn denied(reason: Option<&str>) -> Authorization {
        Authorization {
            allowed: false,
            action_token: None,
            cap_credits: None,
            reason: reason.map(str::to_string),
        }
    }

    fn allowed(cap_credits: Option<Credits>) -> Authorization {
        Authorization {
            allowed: true,
            action_token: Some("agts_test".to_string()),
            cap_credits,
            reason: None,
        }
    }

    #[test]
    fn insufficient_balance_denial_maps_to_insufficient_credits() {
        let result = action_token_or_error(denied(Some("insufficient_available_balance")));
        assert!(matches!(result, Err(ServiceError::InsufficientCredits)));
    }

    #[test]
    fn concurrency_cap_denial_is_not_a_balance_problem() {
        // Regression: a user with funds hit concurrency_cap_exceeded and was
        // shown an "Add funds" banner. Transient denials must stay transient.
        let result = action_token_or_error(denied(Some("concurrency_cap_exceeded")));
        assert!(matches!(result, Err(ServiceError::AuthorizationDenied)));
    }

    #[test]
    fn unknown_denial_reason_is_treated_as_transient() {
        let result = action_token_or_error(denied(None));
        assert!(matches!(result, Err(ServiceError::AuthorizationDenied)));
    }

    #[test]
    fn allowed_authorization_requires_a_cap() {
        let result = action_token_or_error(allowed(None));
        assert!(matches!(result, Err(ServiceError::MeteringProvider)));
    }

    #[test]
    fn allowed_authorization_with_zero_cap_is_out_of_credits() {
        let result = action_token_or_error(allowed(Some(Credits(0))));
        assert!(matches!(result, Err(ServiceError::InsufficientCredits)));
    }

    #[test]
    fn allowed_authorization_keeps_positive_cap() {
        let result = action_token_or_error(allowed(Some(Credits(17))));
        assert_eq!(result.map(|outcome| outcome.cap_credits), Ok(Credits(17)));
    }

    #[test]
    fn balance_reason_matcher_is_case_insensitive_and_specific() {
        assert!(is_insufficient_balance(Some(
            "Insufficient_Available_Balance"
        )));
        assert!(is_insufficient_balance(Some("insufficient_credits")));
        assert!(!is_insufficient_balance(Some("concurrency_cap_exceeded")));
        assert!(!is_insufficient_balance(None));
    }
}
