use crate::{
    charge_flow::{
        AuthorizeParams, ChargeParams, authorize_or_deny, charge, clamp_to_cap, log_settled,
    },
    error::ServiceError,
    util::sha256_hex,
};
use scribe_domain::{
    ActionSlug, Credits, OsAccountsClient, Receipt, UserId, WebFetchRequest, WebFetchResult,
    WebFetcher, WebSearchProvider, WebSearchRequest, WebSearchResults, WebSearcher,
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
            })
            .await?;
        let charge_credits = clamp_to_cap(estimate, authorization.cap_credits);
        let receipt = charge(ChargeParams {
            os_accounts: self.os_accounts.as_ref(),
            action_token: authorization.action_token,
            credits: charge_credits,
            // Hash the query so a client retry of the same search settles
            // against the same hold instead of double-charging.
            idempotency_key: format!(
                "web_search:{}:{}",
                params.user_id.0,
                sha256_hex(params.query.as_bytes())
            ),
        })
        .await?;
        log_settled(ActionSlug::WebSearch, &params.user_id, "web", &receipt);
        Ok(WebSearchOutput { results, receipt })
    }

    pub async fn fetch(&self, params: WebFetchParams) -> Result<WebFetchOutput, ServiceError> {
        let estimate = Credits(self.fetch_credits);
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
            })
            .await?;
        let charge_credits = clamp_to_cap(estimate, authorization.cap_credits);
        let receipt = charge(ChargeParams {
            os_accounts: self.os_accounts.as_ref(),
            action_token: authorization.action_token,
            credits: charge_credits,
            idempotency_key: format!(
                "web_fetch:{}:{}",
                params.user_id.0,
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
    pub query: String,
    pub limit: Option<u32>,
    pub provider: WebSearchProvider,
}

#[derive(Clone, Debug)]
pub struct WebSearchOutput {
    pub results: WebSearchResults,
    pub receipt: Receipt,
}

#[derive(Clone, Debug)]
pub struct WebFetchParams {
    pub user_id: UserId,
    pub url: String,
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
    use pretty_assertions::assert_eq;
    use scribe_domain::{
        Authorization, AuthorizeRequest, ChargeRequest, DomainError, OsAccountsClient, Receipt,
        UserId, WebFetchRequest, WebFetchResult, WebFetcher, WebSearchProvider, WebSearchRequest,
        WebSearchResults, WebSearcher,
    };
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
                cap_credits: None,
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
                query: "rust async".to_string(),
                limit: Some(5),
                provider: WebSearchProvider::Brave,
            })
            .await
            .expect("search succeeds");

        assert_eq!(output.receipt.credits_charged.0, 20);
        assert_eq!(
            os_accounts.events(),
            vec![
                Call::Authorize {
                    action: "web_search".to_string(),
                    estimate: 20,
                },
                Call::Charge {
                    credits: 20,
                    idempotency_key: concat!(
                        "web_search:usr_1:",
                        // sha256("rust async")
                        "1b8fc221f0427ee9913341d4d6909e7fc1edb5a0e459ae0a79dad67c9aeba18a",
                    )
                    .to_string(),
                },
            ]
        );
    }

    #[tokio::test]
    async fn blocked_fetch_returns_invalid_input_and_does_not_charge() {
        let os_accounts = Arc::new(RecordingOsAccounts::new(true));
        let result = service(os_accounts.clone(), Arc::new(BlockedFetcher))
            .fetch(WebFetchParams {
                user_id: UserId("usr_1".to_string()),
                url: "https://x.com/post".to_string(),
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
}
