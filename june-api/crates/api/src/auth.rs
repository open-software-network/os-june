use crate::{error::ApiError, state::ApiState, validation};
use axum::http::{HeaderMap, header};
use june_domain::{ProviderCredentials, UserId};

const VENICE_API_KEY_HEADER: &str = "x-venice-api-key";
pub(crate) const CREDITS_SPEND_SCOPE: &str = "credits:spend";
pub(crate) const PROFILE_READ_SCOPE: &str = "profile:read";

pub(crate) async fn authenticated_user(
    state: &ApiState,
    headers: &HeaderMap,
) -> Result<UserId, ApiError> {
    authenticated_user_with_scope(state, headers, CREDITS_SPEND_SCOPE).await
}

pub(crate) async fn authenticated_user_with_scope(
    state: &ApiState,
    headers: &HeaderMap,
    required_scope: &str,
) -> Result<UserId, ApiError> {
    let token = bearer_token(headers)?;
    state
        .token_verifier()
        .verify_scope(token, required_scope)
        .await
        .map_err(|error| crate::error::from_auth_error(&error))
}

pub(crate) fn client_address(headers: &HeaderMap) -> String {
    // dstack-ingress appends the peer address as the final x-forwarded-for
    // entry. Everything before it arrived from the client and is spoofable.
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next_back())
        .map_or_else(|| "unknown".to_string(), |value| value.trim().to_string())
}

pub(crate) fn bearer_token(headers: &HeaderMap) -> Result<&str, ApiError> {
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
    if api_key.chars().any(char::is_control) {
        return Err(ApiError::bad_request("venice_api_key_invalid"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        VENICE_API_KEY_HEADER, client_address, provider_credentials, validate_venice_api_key,
    };
    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn provider_credentials_accepts_opaque_venice_key() {
        let mut headers = HeaderMap::new();
        headers.insert(
            VENICE_API_KEY_HEADER,
            HeaderValue::from_static("legacy-or-future-key-format"),
        );

        let credentials = provider_credentials(&headers).expect("key should parse");

        assert_eq!(
            credentials.venice_api_key.as_deref(),
            Some("legacy-or-future-key-format")
        );
    }

    #[test]
    fn provider_credentials_rejects_control_characters() {
        let error = validate_venice_api_key("invalid\tkey").expect_err("key should fail");

        assert!(matches!(
            error,
            crate::ApiError::BadRequest {
                message,
                ..
            } if message == "venice_api_key_invalid"
        ));
    }

    #[test]
    fn client_address_uses_the_ingress_appended_final_hop() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.9, 198.51.100.7"),
        );

        assert_eq!(client_address(&headers), "198.51.100.7");
    }
}
