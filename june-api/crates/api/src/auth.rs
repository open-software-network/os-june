use crate::{error::ApiError, state::ApiState, validation};
use axum::http::{HeaderMap, header};
use june_domain::{ProviderCredentials, UserId};

const VENICE_API_KEY_HEADER: &str = "x-venice-api-key";
const VENICE_API_KEY_PREFIX: &str = "VENICE_INFERENCE_KEY_";

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
    if let Some(api_key) = venice_api_key.as_deref() {
        validate_venice_api_key(api_key)?;
    }
    Ok(ProviderCredentials { venice_api_key })
}

fn validate_venice_api_key(api_key: &str) -> Result<(), ApiError> {
    if !api_key.starts_with(VENICE_API_KEY_PREFIX) || api_key.chars().any(char::is_control) {
        return Err(ApiError::bad_request("venice_api_key_invalid"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{VENICE_API_KEY_HEADER, provider_credentials};
    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn provider_credentials_accepts_prefixed_venice_key() {
        let mut headers = HeaderMap::new();
        headers.insert(
            VENICE_API_KEY_HEADER,
            HeaderValue::from_static("VENICE_INFERENCE_KEY_valid"),
        );

        let credentials = provider_credentials(&headers).expect("key should parse");

        assert_eq!(
            credentials.venice_api_key.as_deref(),
            Some("VENICE_INFERENCE_KEY_valid")
        );
    }

    #[test]
    fn provider_credentials_rejects_wrong_venice_key_prefix() {
        let mut headers = HeaderMap::new();
        headers.insert(VENICE_API_KEY_HEADER, HeaderValue::from_static("sk_wrong"));

        let error = provider_credentials(&headers).expect_err("key should fail");

        assert!(matches!(
            error,
            crate::ApiError::BadRequest {
                message,
                ..
            } if message == "venice_api_key_invalid"
        ));
    }
}
