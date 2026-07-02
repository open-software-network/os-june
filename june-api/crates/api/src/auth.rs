use crate::{error::ApiError, state::ApiState, validation};
use axum::http::{HeaderMap, header};
use june_domain::{ProviderCredentials, UserId};

const VENICE_API_KEY_HEADER: &str = "x-venice-api-key";

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

pub(crate) fn provider_credentials(headers: &HeaderMap) -> Result<ProviderCredentials, ApiError> {
    let venice_api_key = headers
        .get(VENICE_API_KEY_HEADER)
        .map(|value| {
            value
                .to_str()
                .map_err(|_| ApiError::bad_request("venice_api_key_invalid"))
        })
        .transpose()?
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    validation::validate_optional_text_len(
        "venice_api_key",
        venice_api_key.as_deref(),
        validation::MAX_PROVIDER_API_KEY_CHARS,
    )?;
    Ok(ProviderCredentials { venice_api_key })
}
