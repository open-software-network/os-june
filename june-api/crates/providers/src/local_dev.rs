use async_trait::async_trait;
use june_domain::{
    AuthError, Authorization, AuthorizeRequest, ChargeRequest, Credits, DomainError,
    OsAccountsClient, Receipt, TokenVerifier, UserId,
};

#[derive(Clone, Debug)]
pub struct LocalDevTokenVerifier {
    bearer_token: String,
    user_id: UserId,
    /// Optional second identity (JUN-308): lets recipient-side share flows
    /// run locally. Empty token disables it.
    viewer_bearer_token: String,
    viewer_user_id: UserId,
}

impl LocalDevTokenVerifier {
    pub fn new(bearer_token: impl Into<String>, user_id: impl Into<String>) -> Self {
        Self {
            bearer_token: bearer_token.into().trim().to_string(),
            user_id: UserId(user_id.into().trim().to_string()),
            viewer_bearer_token: String::new(),
            viewer_user_id: UserId(String::new()),
        }
    }

    #[must_use]
    pub fn with_viewer(
        mut self,
        viewer_bearer_token: impl Into<String>,
        viewer_user_id: impl Into<String>,
    ) -> Self {
        self.viewer_bearer_token = viewer_bearer_token.into().trim().to_string();
        self.viewer_user_id = UserId(viewer_user_id.into().trim().to_string());
        self
    }
}

#[async_trait]
impl TokenVerifier for LocalDevTokenVerifier {
    async fn verify(&self, access_jwt: &str) -> Result<UserId, AuthError> {
        let access_jwt = access_jwt.trim();
        if access_jwt.is_empty() {
            return Err(AuthError::MissingToken);
        }
        if access_jwt == self.bearer_token {
            return Ok(self.user_id.clone());
        }
        if !self.viewer_bearer_token.is_empty() && access_jwt == self.viewer_bearer_token {
            return Ok(self.viewer_user_id.clone());
        }
        Err(AuthError::InvalidToken)
    }

    async fn verify_scope(
        &self,
        access_jwt: &str,
        _required_scope: &str,
    ) -> Result<UserId, AuthError> {
        // Local-dev tokens are configured out of band and intentionally stand
        // in for the production desktop/viewer grants.
        self.verify(access_jwt).await
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
            cap_credits: Some(request.estimate),
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
    use june_domain::{
        ActionSlug, AuthError, AuthorizeRequest, ChargeRequest, Credits, OsAccountsClient,
        TokenVerifier, UserId,
    };
    use pretty_assertions::assert_eq;

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
        assert_eq!(authorization.cap_credits, Some(Credits(250)));

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

/// Local-dev `ViewerIdentity`: the second local token resolves to the
/// configured email so recipient share matching works without OS Accounts;
/// every other token has no verified emails.
#[derive(Clone, Debug)]
pub struct LocalDevViewerIdentity {
    viewer_bearer_token: String,
    viewer_email: String,
}

impl LocalDevViewerIdentity {
    pub fn new(viewer_bearer_token: impl Into<String>, viewer_email: impl Into<String>) -> Self {
        Self {
            viewer_bearer_token: viewer_bearer_token.into().trim().to_string(),
            viewer_email: viewer_email.into().trim().to_ascii_lowercase(),
        }
    }
}

#[async_trait]
impl june_domain::ViewerIdentity for LocalDevViewerIdentity {
    async fn verified_emails(&self, access_token: &str) -> Result<Vec<String>, DomainError> {
        if !self.viewer_bearer_token.is_empty() && access_token.trim() == self.viewer_bearer_token {
            return Ok(vec![self.viewer_email.clone()]);
        }
        Ok(Vec::new())
    }
}
