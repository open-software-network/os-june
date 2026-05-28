use crate::error::ServiceError;
use scribe_domain::{
    ActionSlug, Authorization, AuthorizeRequest, ChargeRequest, Credits, OsAccountsClient, Receipt,
    UserId,
};
use std::cmp::min;

pub(crate) struct AuthorizationOutcome {
    pub action_token: String,
    pub cap_credits: Option<Credits>,
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
        tracing::warn!(
            reason = ?authorization.reason,
            "authorization denied — mapping to insufficient_credits"
        );
        return Err(ServiceError::InsufficientCredits);
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
    Ok(AuthorizationOutcome {
        action_token: token,
        cap_credits: authorization.cap_credits,
    })
}

pub(crate) fn clamp_to_cap(actual: Credits, cap: Option<Credits>) -> Credits {
    match cap {
        Some(cap) => Credits(min(actual.0, cap.0)),
        None => actual,
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

pub(crate) struct AsyncAuthorizeAndChargeParams {
    pub os_accounts: std::sync::Arc<dyn OsAccountsClient>,
    pub user_id: UserId,
    pub action: ActionSlug,
    pub estimate: Credits,
    pub hold_ttl_seconds: u64,
    pub actual: Credits,
    pub idempotency_key_parts: Vec<String>,
}

pub(crate) fn spawn_authorize_and_charge(params: AsyncAuthorizeAndChargeParams) {
    tokio::spawn(async move {
        let outcome = match authorize_or_deny(AuthorizeParams {
            os_accounts: params.os_accounts.as_ref(),
            user_id: params.user_id.clone(),
            action: params.action,
            estimate: params.estimate,
            hold_ttl_seconds: params.hold_ttl_seconds,
        })
        .await
        {
            Ok(outcome) => outcome,
            Err(error) => {
                tracing::warn!(
                    user_id = %params.user_id.0,
                    action = params.action.as_str(),
                    error = %error,
                    "async metering authorize failed"
                );
                return;
            }
        };
        settle_charge(AsyncChargeParams {
            os_accounts: params.os_accounts,
            user_id: params.user_id,
            action: params.action,
            model_id: None,
            action_token: outcome.action_token.clone(),
            credits: clamp_to_cap(params.actual, outcome.cap_credits),
            idempotency_key: async_idempotency_key(
                params.idempotency_key_parts,
                &outcome.action_token,
            ),
        })
        .await;
    });
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

fn async_idempotency_key(mut parts: Vec<String>, action_token: &str) -> String {
    parts.push(action_token.to_string());
    parts.join(":")
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
