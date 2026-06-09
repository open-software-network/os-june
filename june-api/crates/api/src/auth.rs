use crate::{error::ApiError, state::ApiState};
use axum::http::{HeaderMap, header};
use june_domain::UserId;

pub(crate) async fn authenticated_user(
    state: &ApiState,
    headers: &HeaderMap,
) -> Result<UserId, ApiError> {
    let token = bearer_token(headers)?;
    state
        .token_verifier()
        .verify(token)
        .await
        .map_err(|error| crate::error::from_auth_error(&error))
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, ApiError> {
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::unauthorized("missing_bearer_token"))?;
    value
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| ApiError::unauthorized("missing_bearer_token"))
}
