use crate::{
    charge_flow::{
        AuthorizeParams, ChargeParams, authorize_or_deny, charge, clamp_to_cap, log_settled,
        zero_receipt,
    },
    error::ServiceError,
    metering::{log_skipped_user_venice_key, uses_user_venice_key},
    util::sha256_hex,
};
use june_domain::{
    ActionSlug, Credits, OsAccountsClient, ProviderCredentials, Receipt, UserId, WebFetchRequest,
    WebFetchResult, WebFetcher, WebSearchProvider, WebSearchRequest, WebSearchResults, WebSearcher,
};
use std::sync::Arc;

/// Metered access to Venice's web search and single-URL scrape tools. Both
/// calls are flat-priced ($0.01/request upstream), so the authorize estimate
/// and the settled charge are the same configured credit amount rather than a
/// usage-derived figure. A failed or rejected upstream call returns the error
/// without charging; the wallet hold simply expires, matching the agent chat
/// path.
pub struct WebAugmentServiceDeps {
    pub os_accounts: Arc<dyn OsAccountsClient>,
    pub searcher: Arc<dyn WebSearcher>,
    pub fetcher: Arc<dyn WebFetcher>,
    pub search_credits: u64,
    pub fetch_credits: u64,
    pub hold_ttl_seconds: u64,
}

pub struct WebAugmentService {
    os_accounts: Arc<dyn OsAccountsClient>,
    searcher: Arc<dyn WebSearcher>,
    fetcher: Arc<dyn WebFetcher>,
    search_credits: u64,
    fetch_credits: u64,
    hold_ttl_seconds: u64,
}

impl WebAugmentService {
    pub fn new(deps: WebAugmentServiceDeps) -> Self {
        Self {
            os_accounts: deps.os_accounts,
            searcher: deps.searcher,
            fetcher: deps.fetcher,
            search_credits: deps.search_credits,
            fetch_credits: deps.fetch_credits,
            hold_ttl_seconds: deps.hold_ttl_seconds,
        }
    }

    pub async fn search(&self, params: WebSearchParams) -> Result<WebSearchOutput, ServiceError> {
        let estimate = Credits(self.search_credits);
        if uses_user_venice_key(&params.provider_credentials) {
            let results = self
                .searcher
                .search(WebSearchRequest {
                    query: params.query.clone(),
                    limit: params.limit,
                    provider: params.provider,
                    provider_credentials: params.provider_credentials.clone(),
                })
                .await?;
            log_skipped_user_venice_key(ActionSlug::WebSearch, &params.user_id, "web");
            return Ok(WebSearchOutput {
                results,
                receipt: zero_receipt(),
            });
        }
        let authorization = authorize_or_deny(AuthorizeParams {
            os_accounts: self.os_accounts.as_ref(),
            user_id: params.user_id.clone(),
            action: ActionSlug::WebSearch,
            estimate,
            hold_ttl_seconds: self.hold_ttl_seconds,
        })
        .await?;
        let results = self
            .searcher
            .search(WebSearchRequest {
                query: params.query.clone(),
                limit: params.limit,
                provider: params.provider,
                provider_credentials: params.provider_credentials.clone(),
            })
            .await?;
        let charge_credits = clamp_to_cap(estimate, authorization.cap_credits);
        let receipt = charge(ChargeParams {
            os_accounts: self.os_accounts.as_ref(),
            action_token: authorization.action_token,
            credits: charge_credits,
            // The client-supplied request_id scopes idempotency to one logical
            // call: a dropped-response retry reuses it (no double charge),
            // while a genuine repeat search uses a fresh id and is charged. The
            // full request shape (query + limit + provider) is hashed in too,
            // so reusing an id with a different shape still settles as a new
            // charge rather than replaying the prior one.
            idempotency_key: format!(
                "web_search:{}:{}:{}",
                params.user_id.0,
                params.request_id,
                sha256_hex(search_shape(&params).as_bytes())
            ),
        })
        .await?;
        log_settled(ActionSlug::WebSearch, &params.user_id, "web", &receipt);
        Ok(WebSearchOutput { results, receipt })
    }

    pub async fn fetch(&self, params: WebFetchParams) -> Result<WebFetchOutput, ServiceError> {
        let estimate = Credits(self.fetch_credits);
        if uses_user_venice_key(&params.provider_credentials) {
            let result = self
                .fetcher
                .fetch(WebFetchRequest {
                    url: params.url.clone(),
                    provider_credentials: params.provider_credentials.clone(),
                })
                .await?;
            log_skipped_user_venice_key(ActionSlug::WebFetch, &params.user_id, "web");
            return Ok(WebFetchOutput {
                result,
                receipt: zero_receipt(),
            });
        }
        let authorization = authorize_or_deny(AuthorizeParams {
            os_accounts: self.os_accounts.as_ref(),
            user_id: params.user_id.clone(),
            action: ActionSlug::WebFetch,
            estimate,
            hold_ttl_seconds: self.hold_ttl_seconds,
        })
        .await?;
        let result = self
            .fetcher
            .fetch(WebFetchRequest {
                url: params.url.clone(),
                provider_credentials: params.provider_credentials.clone(),
            })
            .await?;
        let charge_credits = clamp_to_cap(estimate, authorization.cap_credits);
        let receipt = charge(ChargeParams {
            os_accounts: self.os_accounts.as_ref(),
            action_token: authorization.action_token,
            credits: charge_credits,
            idempotency_key: format!(
                "web_fetch:{}:{}:{}",
                params.user_id.0,
                params.request_id,
                sha256_hex(params.url.as_bytes())
            ),
        })
        .await?;
        log_settled(ActionSlug::WebFetch, &params.user_id, "web", &receipt);
        Ok(WebFetchOutput { result, receipt })
    }
}

#[derive(Clone, Debug)]
pub struct WebSearchParams {
    pub user_id: UserId,
    /// Stable per-call id scoping the metering idempotency key.
    pub request_id: String,
    pub query: String,
    pub limit: Option<u32>,
    pub provider: WebSearchProvider,
    pub provider_credentials: ProviderCredentials,
}

#[derive(Clone, Debug)]
pub struct WebSearchOutput {
    pub results: WebSearchResults,
    pub receipt: Receipt,
}

/// A canonical string for everything that shapes a search result, hashed into
/// the idempotency key. `serde_json` sorts object keys, so the encoding is
/// deterministic across calls.
fn search_shape(params: &WebSearchParams) -> String {
    let provider = match params.provider {
        WebSearchProvider::Brave => "brave",
        WebSearchProvider::Google => "google",
    };
    serde_json::json!({
        "query": params.query,
        "limit": params.limit,
        "provider": provider,
    })
    .to_string()
}

#[derive(Clone, Debug)]
pub struct WebFetchParams {
    pub user_id: UserId,
    /// Stable per-call id scoping the metering idempotency key.
    pub request_id: String,
    pub url: String,
    pub provider_credentials: ProviderCredentials,
}

#[derive(Clone, Debug)]
pub struct WebFetchOutput {
    pub result: WebFetchResult,
    pub receipt: Receipt,
}

#[cfg(test)]
mod tests {
    use super::{WebAugmentService, WebAugmentServiceDeps, WebFetchParams, WebSearchParams};
    use async_trait::async_trait;
    use june_domain::{
        Authorization, AuthorizeRequest, ChargeRequest, DomainError, OsAccountsClient,
        ProviderCredentials, Receipt, UserId, WebFetchRequest, WebFetchResult, WebFetcher,
        WebSearchProvider, WebSearchRequest, WebSearchResults, WebSearcher,
    };
    use pretty_assertions::assert_eq;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Debug, Eq, PartialEq)]
    enum Call {
        Authorize {
            action: String,
            estimate: u64,
        },
        Charge {
            credits: u64,
            idempotency_key: String,
        },
    }

    struct RecordingOsAccounts {
        allow: bool,
        events: Mutex<Vec<Call>>,
    }

    impl RecordingOsAccounts {
        fn new(allow: bool) -> Self {
            Self {
                allow,
                events: Mutex::new(Vec::new()),
            }
        }

        fn events(&self) -> Vec<Call> {
            self.events.lock().map(|e| e.clone()).unwrap_or_default()
        }
    }

    #[async_trait]
    impl OsAccountsClient for RecordingOsAccounts {
        async fn authorize(&self, request: AuthorizeRequest) -> Result<Authorization, DomainError> {
            if let Ok(mut events) = self.events.lock() {
                events.push(Call::Authorize {
                    action: request.action.to_string(),
                    estimate: request.estimate.0,
                });
            }
            Ok(Authorization {
                allowed: self.allow,
                action_token: self.allow.then(|| "agt_test".to_string()),
                cap_credits: self.allow.then_some(request.estimate),
                reason: (!self.allow).then(|| "insufficient_available_balance".to_string()),
            })
        }

        async fn charge(&self, request: ChargeRequest) -> Result<Receipt, DomainError> {
            if let Ok(mut events) = self.events.lock() {
                events.push(Call::Charge {
                    credits: request.credits.0,
                    idempotency_key: request.idempotency_key,
                });
            }
            Ok(Receipt {
                credits_charged: request.credits,
                idempotent_replay: false,
            })
        }
    }

    struct FixedSearcher;

    #[async_trait]
    impl WebSearcher for FixedSearcher {
        async fn search(
            &self,
            _request: WebSearchRequest,
        ) -> Result<WebSearchResults, DomainError> {
            Ok(WebSearchResults {
                query: "q".to_string(),
                provider: "brave".to_string(),
                results: Vec::new(),
            })
        }
    }

    struct BlockedFetcher;

    #[async_trait]
    impl WebFetcher for BlockedFetcher {
        async fn fetch(&self, _request: WebFetchRequest) -> Result<WebFetchResult, DomainError> {
            Err(DomainError::InvalidInput {
                reason: "web_fetch_unsupported_url".to_string(),
            })
        }
    }

    struct FixedFetcher;

    #[async_trait]
    impl WebFetcher for FixedFetcher {
        async fn fetch(&self, _request: WebFetchRequest) -> Result<WebFetchResult, DomainError> {
            Ok(WebFetchResult {
                url: "https://example.com".to_string(),
                content: "# Page".to_string(),
                format: "markdown".to_string(),
                provider: "venice".to_string(),
            })
        }
    }

    fn service(
        os_accounts: Arc<RecordingOsAccounts>,
        fetcher: Arc<dyn WebFetcher>,
    ) -> WebAugmentService {
        WebAugmentService::new(WebAugmentServiceDeps {
            os_accounts,
            searcher: Arc::new(FixedSearcher),
            fetcher,
            search_credits: 20,
            fetch_credits: 25,
            hold_ttl_seconds: 30,
        })
    }

    #[tokio::test]
    async fn search_authorizes_then_charges_flat_credits_with_hashed_key() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let output = service(os_accounts.clone(), Arc::new(FixedFetcher))
            .search(WebSearchParams {
                user_id: UserId("usr_1".to_string()),
                request_id: "req_1".to_string(),
                query: "rust async".to_string(),
                limit: Some(5),
                provider: WebSearchProvider::Brave,
                provider_credentials: ProviderCredentials::default(),
            })
            .await
            .expect("search succeeds");

        assert_eq!(output.receipt.credits_charged.0, 20);
        let events = os_accounts.events();
        assert_eq!(
            events[0],
            Call::Authorize {
                action: "web_search".to_string(),
                estimate: 20,
            }
        );
        // The key is user + request_id + a 64-hex digest of the request shape.
        // (The digest's exact bytes depend on serde_json key ordering, so we
        // assert structure here and behavior in the distinctness tests below.)
        match &events[1] {
            Call::Charge {
                credits,
                idempotency_key,
            } => {
                assert_eq!(*credits, 20);
                let digest = idempotency_key
                    .strip_prefix("web_search:usr_1:req_1:")
                    .expect("key has the expected prefix");
                assert_eq!(digest.len(), 64);
                assert!(digest.chars().all(|ch| ch.is_ascii_hexdigit()));
            }
            Call::Authorize { .. } => panic!("expected a charge, got an authorize"),
        }
    }

    #[tokio::test]
    async fn search_user_venice_key_skips_wallet_metering() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let output = service(os_accounts.clone(), Arc::new(FixedFetcher))
            .search(WebSearchParams {
                user_id: UserId("usr_1".to_string()),
                request_id: "req_1".to_string(),
                query: "rust async".to_string(),
                limit: Some(5),
                provider: WebSearchProvider::Brave,
                provider_credentials: ProviderCredentials {
                    venice_api_key: Some("vc_user_key".to_string()),
                },
            })
            .await
            .expect("search succeeds with user Venice key");

        assert_eq!(output.receipt.credits_charged.0, 0);
        assert_eq!(os_accounts.events(), Vec::new());
    }

    #[tokio::test]
    async fn search_same_request_id_different_shape_uses_distinct_keys() {
        // Regression: the key must fold in limit/provider, not just query, so
        // reusing a request_id with a different search shape still settles as a
        // new charge instead of replaying the prior (differently shaped) one.
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let service = service(os_accounts.clone(), Arc::new(FixedFetcher));
        for provider in [WebSearchProvider::Brave, WebSearchProvider::Google] {
            service
                .search(WebSearchParams {
                    user_id: UserId("usr_1".to_string()),
                    request_id: "req_1".to_string(),
                    query: "rust async".to_string(),
                    limit: Some(5),
                    provider,
                    provider_credentials: ProviderCredentials::default(),
                })
                .await
                .expect("search succeeds");
        }

        let charge_keys = os_accounts
            .events()
            .into_iter()
            .filter_map(|call| match call {
                Call::Charge {
                    idempotency_key, ..
                } => Some(idempotency_key),
                Call::Authorize { .. } => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(charge_keys.len(), 2);
        assert_ne!(charge_keys[0], charge_keys[1]);
    }

    #[tokio::test]
    async fn repeat_search_with_fresh_request_id_uses_a_distinct_charge_key() {
        // Regression: keying on user+query alone made a genuine repeat search
        // collide with the prior settlement and replay as free. A fresh
        // request_id must produce a distinct key so each real call is charged.
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let service = service(os_accounts.clone(), Arc::new(FixedFetcher));
        for request_id in ["req_1", "req_2"] {
            service
                .search(WebSearchParams {
                    user_id: UserId("usr_1".to_string()),
                    request_id: request_id.to_string(),
                    query: "rust async".to_string(),
                    limit: Some(5),
                    provider: WebSearchProvider::Brave,
                    provider_credentials: ProviderCredentials::default(),
                })
                .await
                .expect("search succeeds");
        }

        let charge_keys = os_accounts
            .events()
            .into_iter()
            .filter_map(|call| match call {
                Call::Charge {
                    idempotency_key, ..
                } => Some(idempotency_key),
                Call::Authorize { .. } => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(charge_keys.len(), 2);
        assert_ne!(charge_keys[0], charge_keys[1]);
    }

    #[tokio::test]
    async fn blocked_fetch_returns_invalid_input_and_does_not_charge() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let result = service(os_accounts.clone(), Arc::new(BlockedFetcher))
            .fetch(WebFetchParams {
                user_id: UserId("usr_1".to_string()),
                request_id: "req_1".to_string(),
                url: "https://x.com/post".to_string(),
                provider_credentials: ProviderCredentials::default(),
            })
            .await;

        assert!(matches!(
            result,
            Err(crate::ServiceError::InvalidInput { .. })
        ));
        // Authorized (hold taken, expires via TTL) but never charged.
        assert_eq!(
            os_accounts.events(),
            vec![Call::Authorize {
                action: "web_fetch".to_string(),
                estimate: 25,
            }]
        );
    }

    #[tokio::test]
    async fn fetch_user_venice_key_skips_wallet_metering() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let output = service(os_accounts.clone(), Arc::new(FixedFetcher))
            .fetch(WebFetchParams {
                user_id: UserId("usr_1".to_string()),
                request_id: "req_1".to_string(),
                url: "https://example.com".to_string(),
                provider_credentials: ProviderCredentials {
                    venice_api_key: Some("vc_user_key".to_string()),
                },
            })
            .await
            .expect("fetch succeeds with user Venice key");

        assert_eq!(output.receipt.credits_charged.0, 0);
        assert_eq!(os_accounts.events(), Vec::new());
    }
}
