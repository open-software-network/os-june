use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use june_config::GatewayAttestationConfig;
use june_domain::DomainError;
use serde::Deserialize;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex as AsyncMutex;

static NONCE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct GatewayAttestationVerifier {
    inner: Arc<Inner>,
}

struct Inner {
    http: reqwest::Client,
    config: GatewayAttestationConfig,
    verified_at: Mutex<Option<Instant>>,
    verification_lock: AsyncMutex<()>,
}

impl GatewayAttestationVerifier {
    pub fn new(http: reqwest::Client, config: &GatewayAttestationConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                http,
                config: config.clone(),
                verified_at: Mutex::new(None),
                verification_lock: AsyncMutex::new(()),
            }),
        }
    }

    pub async fn verify(&self, api_key: &str) -> Result<(), DomainError> {
        if !self.inner.config.required || self.is_fresh()? {
            return Ok(());
        }
        let _guard = self.inner.verification_lock.lock().await;
        if self.is_fresh()? {
            return Ok(());
        }
        self.verify_fresh(api_key).await.map_err(|reason| {
            tracing::error!(%reason, "os-api gateway attestation failed closed");
            DomainError::UpstreamProvider
        })?;
        *self
            .inner
            .verified_at
            .lock()
            .map_err(|_| DomainError::UpstreamProvider)? = Some(Instant::now());
        Ok(())
    }

    fn is_fresh(&self) -> Result<bool, DomainError> {
        Ok(self
            .inner
            .verified_at
            .lock()
            .map_err(|_| DomainError::UpstreamProvider)?
            .is_some_and(|verified| {
                verified.elapsed() < Duration::from_secs(self.inner.config.cache_secs.max(1))
            }))
    }

    async fn verify_fresh(&self, api_key: &str) -> Result<(), &'static str> {
        let nonce = nonce();
        let response = self
            .inner
            .http
            .post(&self.inner.config.url)
            .bearer_auth(api_key)
            .json(&serde_json::json!({"nonce": nonce}))
            .send()
            .await
            .map_err(|_| "attestation request failed")?
            .error_for_status()
            .map_err(|_| "attestation endpoint rejected request")?;
        let envelope = response
            .json::<AttestationEnvelope>()
            .await
            .map_err(|_| "invalid attestation response")?;
        if envelope.format != "confidential-space.oidc"
            || envelope.audience != self.inner.config.audience
            || envelope.nonce != nonce
        {
            return Err("attestation response binding mismatch");
        }
        let header = decode_header(&envelope.token).map_err(|_| "invalid attestation token")?;
        if header.alg != Algorithm::RS256 {
            return Err("unsupported attestation signing algorithm");
        }
        let kid = header.kid.ok_or("attestation token has no key id")?;
        let jwks = self
            .inner
            .http
            .get(&self.inner.config.jwks_url)
            .send()
            .await
            .map_err(|_| "attestation JWKS request failed")?
            .error_for_status()
            .map_err(|_| "attestation JWKS endpoint rejected request")?
            .json::<JwkSet>()
            .await
            .map_err(|_| "invalid attestation JWKS")?;
        let key = jwks.find(&kid).ok_or("attestation signing key not found")?;
        let decoding_key = DecodingKey::from_jwk(key).map_err(|_| "invalid attestation key")?;
        let mut validation = Validation::new(header.alg);
        validation.set_issuer(&["https://confidentialcomputing.googleapis.com"]);
        validation.set_audience(&[self.inner.config.audience.as_str()]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "eat_nonce"]);
        let claims = decode::<Claims>(&envelope.token, &decoding_key, &validation)
            .map_err(|_| "attestation signature or registered claims are invalid")?
            .claims;
        if !workload_claims_match(&claims, &self.inner.config, &nonce) {
            return Err("attestation workload claims do not match policy");
        }
        Ok(())
    }
}

fn workload_claims_match(claims: &Claims, config: &GatewayAttestationConfig, nonce: &str) -> bool {
    claims.eat_nonce.contains(nonce)
        && claims.swname == "CONFIDENTIAL_SPACE"
        && claims.dbgstat == "disabled-since-boot"
        && claims.hwmodel == "GCP_INTEL_TDX"
        && claims
            .submods
            .confidential_space
            .support_attributes
            .iter()
            .any(|value| value == "STABLE")
        && claims
            .submods
            .container
            .image_digest
            .contains(&config.expected_image_digest)
}

fn nonce() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let counter = NONCE_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("june-{now:x}-{counter:x}")
}

#[derive(Deserialize)]
struct AttestationEnvelope {
    format: String,
    token: String,
    audience: String,
    nonce: String,
}

#[derive(Deserialize)]
struct Claims {
    eat_nonce: OneOrMany,
    swname: String,
    dbgstat: String,
    hwmodel: String,
    submods: Submods,
}

#[derive(Deserialize)]
struct Submods {
    container: ContainerClaims,
    confidential_space: ConfidentialSpaceClaims,
}

#[derive(Deserialize)]
struct ContainerClaims {
    image_digest: OneOrMany,
}

#[derive(Deserialize)]
struct ConfidentialSpaceClaims {
    support_attributes: Vec<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum OneOrMany {
    One(String),
    Many(Vec<String>),
}

impl OneOrMany {
    fn contains(&self, expected: &str) -> bool {
        match self {
            Self::One(value) => value == expected,
            Self::Many(values) => values.iter().any(|value| value == expected),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Claims, ConfidentialSpaceClaims, ContainerClaims, OneOrMany, Submods, workload_claims_match,
    };
    use june_config::GatewayAttestationConfig;

    fn config() -> GatewayAttestationConfig {
        GatewayAttestationConfig {
            required: true,
            expected_image_digest: format!("sha256:{}", "a".repeat(64)),
            ..GatewayAttestationConfig::default()
        }
    }

    fn claims() -> Claims {
        Claims {
            eat_nonce: OneOrMany::Many(vec!["fresh-nonce".to_string()]),
            swname: "CONFIDENTIAL_SPACE".to_string(),
            dbgstat: "disabled-since-boot".to_string(),
            hwmodel: "GCP_INTEL_TDX".to_string(),
            submods: Submods {
                container: ContainerClaims {
                    image_digest: OneOrMany::One(format!("sha256:{}", "a".repeat(64))),
                },
                confidential_space: ConfidentialSpaceClaims {
                    support_attributes: vec!["STABLE".to_string()],
                },
            },
        }
    }

    #[test]
    fn accepts_exact_nonce_hardware_stability_and_digest_policy() {
        assert!(workload_claims_match(&claims(), &config(), "fresh-nonce"));
    }

    #[test]
    fn rejects_replayed_nonce() {
        assert!(!workload_claims_match(&claims(), &config(), "other-nonce"));
    }

    #[test]
    fn rejects_debug_or_wrong_image_workload() {
        let mut debug = claims();
        debug.dbgstat = "enabled".to_string();
        assert!(!workload_claims_match(&debug, &config(), "fresh-nonce"));

        let mut wrong_image = claims();
        wrong_image.submods.container.image_digest =
            OneOrMany::One(format!("sha256:{}", "b".repeat(64)));
        assert!(!workload_claims_match(
            &wrong_image,
            &config(),
            "fresh-nonce"
        ));
    }
}
