use async_trait::async_trait;
use scribe_domain::{
    AuthError, Authorization, AuthorizeRequest, ChargeRequest, Credits, DomainError,
    OsAccountsClient, Receipt, TokenVerifier, UserId,
};

#[derive(Clone, Debug)]
pub struct LocalDevTokenVerifier {
    bearer_token: String,
    user_id: UserId,
}

impl LocalDevTokenVerifier {
    pub fn new(bearer_token: impl Into<String>, user_id: impl Into<String>) -> Self {
        Self {
            bearer_token: bearer_token.into().trim().to_string(),
            user_id: UserId(user_id.into().trim().to_string()),
        }
    }
}

#[async_trait]
impl TokenVerifier for LocalDevTokenVerifier {
    async fn verify(&self, access_jwt: &str) -> Result<UserId, AuthError> {
        let access_jwt = access_jwt.trim();
        if access_jwt.is_empty() {
            return Err(AuthError::MissingToken);
        }
        if access_jwt != self.bearer_token {
            return Err(AuthError::InvalidToken);
        }
        Ok(self.user_id.clone())
    }
}

#[derive(Clone, Debug, Default)]
pub struct LocalDevOsAccountsClient;

#[async_trait]
impl OsAccountsClient for LocalDevOsAccountsClient {
    async fn authorize(&self, request: AuthorizeRequest) -> Result<Authorization, DomainError> {
        Ok(Authorization {
            allowed: true,
            action_token: Some(format!(
                "agt_local_dev_{}_{}_{}",
                request.user_id.0,
                request.action.as_str(),
                request.estimate.0
            )),
            cap_credits: None,
            reason: None,
        })
    }

    async fn charge(&self, _request: ChargeRequest) -> Result<Receipt, DomainError> {
        Ok(Receipt {
            credits_charged: Credits(0),
            idempotent_replay: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{LocalDevOsAccountsClient, LocalDevTokenVerifier};
    use pretty_assertions::assert_eq;
    use scribe_domain::{
        ActionSlug, AuthError, AuthorizeRequest, ChargeRequest, Credits, OsAccountsClient,
        TokenVerifier, UserId,
    };

    #[tokio::test]
    async fn token_verifier_accepts_configured_token() {
        let verifier = LocalDevTokenVerifier::new(" local-token ", "usr_local");

        let user_id = verifier.verify("local-token").await;

        assert_eq!(user_id, Ok(UserId("usr_local".to_string())));
    }

    #[tokio::test]
    async fn token_verifier_rejects_missing_or_wrong_token() {
        let verifier = LocalDevTokenVerifier::new("local-token", "usr_local");

        assert_eq!(verifier.verify("").await, Err(AuthError::MissingToken));
        assert_eq!(
            verifier.verify("other-token").await,
            Err(AuthError::InvalidToken)
        );
    }

    #[tokio::test]
    async fn os_accounts_client_authorizes_and_never_charges_credits() {
        let client = LocalDevOsAccountsClient;

        let authorization = client
            .authorize(AuthorizeRequest {
                user_id: UserId("usr_local".to_string()),
                action: ActionSlug::NoteGenerate,
                estimate: Credits(250),
                hold_ttl_seconds: 60,
            })
            .await
            .expect("authorization succeeds");

        assert_eq!(authorization.allowed, true);
        assert!(authorization.action_token.is_some());
        assert_eq!(authorization.cap_credits, None);

        let receipt = client
            .charge(ChargeRequest {
                action_token: authorization.action_token.expect("token is present"),
                credits: Credits(99),
                idempotency_key: "local".to_string(),
            })
            .await
            .expect("charge succeeds");

        assert_eq!(receipt.credits_charged, Credits(0));
        assert_eq!(receipt.idempotent_replay, false);
    }
}
