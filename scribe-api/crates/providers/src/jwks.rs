use async_trait::async_trait;
use jsonwebtoken::{
    Algorithm, DecodingKey, Validation, decode, decode_header,
    jwk::{JwkSet, KeyAlgorithm},
};
use scribe_config::OsAccountsConfig;
use scribe_domain::{AuthError, TokenVerifier, UserId};
use serde::Deserialize;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::Mutex as AsyncMutex;

const JWT_LEEWAY_SECS: u64 = 30;

pub struct JwksTokenVerifierParams {
    pub http: reqwest::Client,
    pub jwks_url: String,
    pub issuer: String,
    pub audience: String,
    pub refresh_interval: Duration,
    pub miss_min_backoff: Duration,
}

pub struct JwksTokenVerifier {
    http: reqwest::Client,
    jwks_url: String,
    issuer: String,
    audience: String,
    refresh_interval: Duration,
    miss_min_backoff: Duration,
    cache: Mutex<CacheState>,
    refresh_lock: AsyncMutex<()>,
}

#[derive(Default)]
struct CacheState {
    jwks: Option<CachedJwks>,
    last_attempt: Option<Instant>,
}

struct CachedJwks {
    jwks: JwkSet,
    fetched_at: Instant,
}

impl JwksTokenVerifier {
    pub fn from_config(http: reqwest::Client, config: &OsAccountsConfig) -> Self {
        Self::new(JwksTokenVerifierParams {
            http,
            jwks_url: format!(
                "{}/.well-known/jwks.json",
                config.api_url.trim_end_matches('/')
            ),
            issuer: config.iss.clone(),
            audience: config.aud.clone(),
            refresh_interval: Duration::from_secs(config.jwks_refresh_secs),
            miss_min_backoff: Duration::from_secs(config.jwks_miss_min_backoff_secs),
        })
    }

    pub fn new(params: JwksTokenVerifierParams) -> Self {
        Self {
            http: params.http,
            jwks_url: params.jwks_url,
            issuer: params.issuer,
            audience: params.audience,
            refresh_interval: params.refresh_interval,
            miss_min_backoff: params.miss_min_backoff,
            cache: Mutex::new(CacheState::default()),
            refresh_lock: AsyncMutex::new(()),
        }
    }

    async fn key_for_kid(&self, kid: &str) -> Result<DecodingKey, AuthError> {
        if let Some(key) = self.cached_key(kid)? {
            if self.cache_is_fresh()? {
                return Ok(key);
            }
            return self.refresh_stale_hit(kid, key).await;
        }
        if !self.can_refresh()? {
            return Err(AuthError::InvalidToken);
        }
        let _refresh_guard = self.refresh_lock.lock().await;
        // Re-check after acquiring the lock: another caller may have refreshed
        // (and the backoff window may have started) while we were queued.
        if let Some(key) = self.cached_key(kid)? {
            return Ok(key);
        }
        if !self.can_refresh()? {
            return Err(AuthError::InvalidToken);
        }
        self.refresh_jwks().await?;
        self.cached_key(kid)?.ok_or(AuthError::InvalidToken)
    }

    /// The kid was found but the cached set is past its refresh interval:
    /// refetch (rate-limited) so keys rotated out upstream stop verifying,
    /// falling back to the stale key while the endpoint is unreachable.
    async fn refresh_stale_hit(
        &self,
        kid: &str,
        stale_key: DecodingKey,
    ) -> Result<DecodingKey, AuthError> {
        if !self.can_refresh()? {
            return Ok(stale_key);
        }
        let _refresh_guard = self.refresh_lock.lock().await;
        if self.cache_is_fresh()? || !self.can_refresh()? {
            // Another caller refreshed (or attempted and started the backoff
            // window) while we were queued; trust the current cache state.
            return self.cached_key(kid)?.ok_or(AuthError::InvalidToken);
        }
        if self.refresh_jwks().await.is_err() {
            return Ok(stale_key);
        }
        self.cached_key(kid)?.ok_or(AuthError::InvalidToken)
    }

    fn cached_key(&self, kid: &str) -> Result<Option<DecodingKey>, AuthError> {
        let cache = self.cache.lock().map_err(|_| AuthError::InvalidToken)?;
        let Some(cached) = cache.jwks.as_ref() else {
            return Ok(None);
        };
        let Some(jwk) = cached.jwks.find(kid) else {
            return Ok(None);
        };
        if jwk.common.key_algorithm != Some(KeyAlgorithm::ES256) {
            return Err(AuthError::InvalidToken);
        }
        DecodingKey::from_jwk(jwk)
            .map(Some)
            .map_err(|_| AuthError::InvalidToken)
    }

    fn cache_is_fresh(&self) -> Result<bool, AuthError> {
        let cache = self.cache.lock().map_err(|_| AuthError::InvalidToken)?;
        Ok(cache
            .jwks
            .as_ref()
            .is_some_and(|cached| cached.fetched_at.elapsed() < self.refresh_interval))
    }

    fn can_refresh(&self) -> Result<bool, AuthError> {
        let cache = self.cache.lock().map_err(|_| AuthError::InvalidToken)?;
        // Rate-limit fetches by the last attempt regardless of cache state:
        // we shouldn't refetch on every random kid an attacker forges, and
        // that holds just as much when the cache is empty or stale (e.g. the
        // JWKS endpoint is down) — otherwise every unauthenticated request
        // triggers an outbound fetch.
        match cache.last_attempt {
            Some(last) => Ok(last.elapsed() >= self.miss_min_backoff),
            None => Ok(true),
        }
    }

    async fn refresh_jwks(&self) -> Result<(), AuthError> {
        self.mark_attempt()?;
        let jwks = self
            .http
            .get(&self.jwks_url)
            .send()
            .await
            .map_err(|_| AuthError::InvalidToken)?
            .error_for_status()
            .map_err(|_| AuthError::InvalidToken)?
            .json::<JwkSet>()
            .await
            .map_err(|_| AuthError::InvalidToken)?;
        let mut cache = self.cache.lock().map_err(|_| AuthError::InvalidToken)?;
        cache.jwks = Some(CachedJwks {
            jwks,
            fetched_at: Instant::now(),
        });
        Ok(())
    }

    fn mark_attempt(&self) -> Result<(), AuthError> {
        let mut cache = self.cache.lock().map_err(|_| AuthError::InvalidToken)?;
        cache.last_attempt = Some(Instant::now());
        Ok(())
    }

    fn validation(&self) -> Validation {
        let mut validation = Validation::new(Algorithm::ES256);
        validation.set_issuer(&[self.issuer.as_str()]);
        validation.set_audience(&[self.audience.as_str()]);
        // OS Accounts tokens currently don't include `nbf` (staging confirmed
        // 2026-05-28). exp + iss + aud + sub are the load-bearing claims.
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        validation.leeway = JWT_LEEWAY_SECS;
        validation
    }
}

#[derive(Debug, Deserialize)]
struct AccessClaims {
    sub: String,
}

// Used only for diagnostic logging on a verification failure. Decoding the
// payload without signature verification is fine here because nothing trusts
// the result — we just want to see what iss/aud/exp the token claims.
#[derive(Debug, Deserialize)]
struct UnverifiedClaims {
    iss: Option<String>,
    aud: Option<serde_json::Value>,
    exp: Option<i64>,
    scope: Option<serde_json::Value>,
}

#[async_trait]
impl TokenVerifier for JwksTokenVerifier {
    async fn verify(&self, access_jwt: &str) -> Result<UserId, AuthError> {
        let access_jwt = access_jwt.trim();
        if access_jwt.is_empty() {
            return Err(AuthError::MissingToken);
        }
        // Read kid only — never trust the header's `alg`. The validator
        // below pins Algorithm::ES256 regardless.
        let header = decode_header(access_jwt).map_err(|_| AuthError::InvalidToken)?;
        if header.alg != Algorithm::ES256 {
            return Err(AuthError::InvalidToken);
        }
        let kid = header.kid.as_deref().ok_or(AuthError::InvalidToken)?;
        let key = self.key_for_kid(kid).await?;
        let token = match decode::<AccessClaims>(access_jwt, &key, &self.validation()) {
            Ok(token) => token,
            Err(error) => {
                let claims = unverified_claims(access_jwt);
                tracing::warn!(
                    error = %error,
                    expected_iss = %self.issuer,
                    expected_aud = %self.audience,
                    token_iss = ?claims.as_ref().and_then(|c| c.iss.as_deref()),
                    token_aud = ?claims.as_ref().and_then(|c| c.aud.clone()),
                    token_exp = ?claims.as_ref().and_then(|c| c.exp),
                    token_scope = ?claims.as_ref().and_then(|c| c.scope.clone()),
                    kid = %kid,
                    "JWT validation failed"
                );
                return Err(AuthError::InvalidToken);
            }
        };
        let user_id = token.claims.sub.trim();
        if !user_id.starts_with("usr_") {
            return Err(AuthError::InvalidToken);
        }
        Ok(UserId(user_id.to_string()))
    }
}

fn unverified_claims(jwt: &str) -> Option<UnverifiedClaims> {
    use base64::Engine as _;
    let payload = jwt.split('.').nth(1)?;
    let padded = match payload.len() % 4 {
        2 => format!("{payload}=="),
        3 => format!("{payload}="),
        _ => payload.to_string(),
    };
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(&padded))
        .ok()?;
    serde_json::from_slice(&decoded).ok()
}

#[cfg(test)]
mod tests {
    use super::{JwksTokenVerifier, JwksTokenVerifierParams};
    use crate::http;
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode, get_current_timestamp};
    use pretty_assertions::assert_eq;
    use scribe_domain::{AuthError, TokenVerifier, UserId};
    use serde::Serialize;
    use serde_json::json;
    use std::{error::Error, time::Duration};
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{method, path},
    };

    #[tokio::test]
    async fn accepts_valid_es256_token() -> Result<(), Box<dyn Error>> {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/.well-known/jwks.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(jwks_body()))
            .mount(&server)
            .await;
        let verifier = build_verifier(&server.uri(), "issuer", "scribe-api");
        let token = test_token("ec01", "usr_123", "issuer", "scribe-api")?;

        let user_id = verifier.verify(&token).await?;

        assert_eq!(user_id, UserId("usr_123".to_string()));
        Ok(())
    }

    #[tokio::test]
    async fn reuses_cached_key_for_same_kid() -> Result<(), Box<dyn Error>> {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/.well-known/jwks.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(jwks_body()))
            .mount(&server)
            .await;
        let verifier = build_verifier(&server.uri(), "issuer", "scribe-api");
        let token = test_token("ec01", "usr_123", "issuer", "scribe-api")?;

        verifier.verify(&token).await?;
        verifier.verify(&token).await?;

        let request_count = server
            .received_requests()
            .await
            .map(|requests| requests.len())
            .unwrap_or_default();
        assert_eq!(request_count, 1);
        Ok(())
    }

    #[tokio::test]
    async fn unknown_kid_does_not_amplify_jwks_refreshes() -> Result<(), Box<dyn Error>> {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/.well-known/jwks.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(jwks_body()))
            .mount(&server)
            .await;
        let verifier = build_verifier(&server.uri(), "issuer", "scribe-api");
        let bad_token = test_token("kid_unknown", "usr_123", "issuer", "scribe-api")?;

        for _ in 0..5 {
            let _ = verifier.verify(&bad_token).await;
        }

        let request_count = server
            .received_requests()
            .await
            .map(|requests| requests.len())
            .unwrap_or_default();
        assert!(
            request_count <= 1,
            "unexpected refresh count: {request_count}"
        );
        Ok(())
    }

    #[tokio::test]
    async fn empty_cache_misses_do_not_amplify_jwks_refreshes() -> Result<(), Box<dyn Error>> {
        // Regression: with no cached JWKS (startup, or the endpoint erroring)
        // every request used to trigger an outbound fetch — an unauthenticated
        // request-amplification vector. The miss backoff must apply here too.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/.well-known/jwks.json"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let verifier = build_verifier(&server.uri(), "issuer", "scribe-api");
        let token = test_token("ec01", "usr_123", "issuer", "scribe-api")?;

        for _ in 0..5 {
            let _ = verifier.verify(&token).await;
        }

        let request_count = server
            .received_requests()
            .await
            .map(|requests| requests.len())
            .unwrap_or_default();
        assert!(
            request_count <= 1,
            "unexpected refresh count: {request_count}"
        );
        Ok(())
    }

    #[tokio::test]
    async fn stale_cache_refresh_drops_rotated_keys() -> Result<(), Box<dyn Error>> {
        // A key removed from the upstream JWKS must stop verifying once the
        // cached set goes stale — refresh is no longer purely miss-driven.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/.well-known/jwks.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(jwks_body()))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/.well-known/jwks.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "keys": [] })))
            .mount(&server)
            .await;
        let verifier = JwksTokenVerifier::new(JwksTokenVerifierParams {
            http: http::jwks_client(),
            jwks_url: format!("{}/.well-known/jwks.json", server.uri()),
            issuer: "issuer".to_string(),
            audience: "scribe-api".to_string(),
            refresh_interval: Duration::ZERO,
            miss_min_backoff: Duration::ZERO,
        });
        let token = test_token("ec01", "usr_123", "issuer", "scribe-api")?;

        verifier.verify(&token).await?;
        let second = verifier.verify(&token).await;

        assert_eq!(second, Err(AuthError::InvalidToken));
        Ok(())
    }

    #[tokio::test]
    async fn stale_cache_falls_back_to_cached_key_within_backoff() -> Result<(), Box<dyn Error>> {
        // A stale hit inside the backoff window must keep serving the cached
        // key (availability during JWKS endpoint outages) without refetching.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/.well-known/jwks.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(jwks_body()))
            .mount(&server)
            .await;
        let verifier = JwksTokenVerifier::new(JwksTokenVerifierParams {
            http: http::jwks_client(),
            jwks_url: format!("{}/.well-known/jwks.json", server.uri()),
            issuer: "issuer".to_string(),
            audience: "scribe-api".to_string(),
            refresh_interval: Duration::ZERO,
            miss_min_backoff: Duration::from_mins(1),
        });
        let token = test_token("ec01", "usr_123", "issuer", "scribe-api")?;

        verifier.verify(&token).await?;
        verifier.verify(&token).await?;

        let request_count = server
            .received_requests()
            .await
            .map(|requests| requests.len())
            .unwrap_or_default();
        assert_eq!(request_count, 1);
        Ok(())
    }

    #[tokio::test]
    async fn rejects_wrong_issuer() -> Result<(), Box<dyn Error>> {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/.well-known/jwks.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(jwks_body()))
            .mount(&server)
            .await;
        let verifier = build_verifier(&server.uri(), "issuer", "scribe-api");
        let token = test_token("ec01", "usr_123", "other-issuer", "scribe-api")?;

        let result = verifier.verify(&token).await;

        assert_eq!(result, Err(AuthError::InvalidToken));
        Ok(())
    }

    fn build_verifier(base_url: &str, issuer: &str, audience: &str) -> JwksTokenVerifier {
        JwksTokenVerifier::new(JwksTokenVerifierParams {
            http: http::jwks_client(),
            jwks_url: format!("{base_url}/.well-known/jwks.json"),
            issuer: issuer.to_string(),
            audience: audience.to_string(),
            refresh_interval: Duration::from_mins(5),
            miss_min_backoff: Duration::from_mins(1),
        })
    }

    #[derive(Serialize)]
    struct TestClaims {
        sub: String,
        iss: String,
        aud: String,
        exp: u64,
        nbf: u64,
    }

    fn test_token(
        kid: &str,
        sub: &str,
        issuer: &str,
        audience: &str,
    ) -> Result<String, jsonwebtoken::errors::Error> {
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(kid.to_string());
        let now = get_current_timestamp();
        encode(
            &header,
            &TestClaims {
                sub: sub.to_string(),
                iss: issuer.to_string(),
                aud: audience.to_string(),
                exp: now + 600,
                nbf: now - 60,
            },
            &EncodingKey::from_ec_der(TEST_EC_PRIVATE_KEY_DER),
        )
    }

    fn jwks_body() -> serde_json::Value {
        json!({
            "keys": [
                {
                    "kty": "EC",
                    "crv": "P-256",
                    "x": "w7JAoU_gJbZJvV-zCOvU9yFJq0FNC_edCMRM78P8eQQ",
                    "y": "wQg1EytcsEmGrM70Gb53oluoDbVhCZ3Uq3hHMslHVb4",
                    "kid": "ec01",
                    "alg": "ES256",
                    "use": "sig"
                }
            ]
        })
    }

    const TEST_EC_PRIVATE_KEY_DER: &[u8] = &[
        48, 129, 135, 2, 1, 0, 48, 19, 6, 7, 42, 134, 72, 206, 61, 2, 1, 6, 8, 42, 134, 72, 206,
        61, 3, 1, 7, 4, 109, 48, 107, 2, 1, 1, 4, 32, 89, 49, 95, 8, 105, 99, 99, 166, 176, 220,
        122, 237, 144, 121, 143, 70, 38, 179, 186, 76, 79, 45, 190, 162, 150, 148, 64, 123, 8, 214,
        242, 120, 161, 68, 3, 66, 0, 4, 195, 178, 64, 161, 79, 224, 37, 182, 73, 189, 95, 179, 8,
        235, 212, 247, 33, 73, 171, 65, 77, 11, 247, 157, 8, 196, 76, 239, 195, 252, 121, 4, 193,
        8, 53, 19, 43, 92, 176, 73, 134, 172, 206, 244, 25, 190, 119, 162, 91, 168, 13, 181, 97, 9,
        157, 212, 171, 120, 71, 50, 201, 71, 85, 190,
    ];
}
