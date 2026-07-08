use crate::{
    charge_flow::{
        AuthorizeParams, ChargeParams, authorize_or_deny, charge, clamp_to_cap, log_settled,
        zero_receipt,
    },
    error::ServiceError,
    metering::{log_skipped_user_venice_key, uses_user_venice_key_for_model},
    pricing::PricingTable,
    util::sha256_hex,
};
use june_domain::{
    ActionSlug, AgentChatCompleter, AgentChatCompletion, AgentChatRequest, Credits, DomainError,
    ModelId, ModelKind, OsAccountsClient, ProviderCredentials, Receipt, TokenUsage, UserId,
};
use std::sync::Arc;

pub struct AgentChatServiceDeps {
    pub pricing: Arc<PricingTable>,
    pub os_accounts: Arc<dyn OsAccountsClient>,
    pub chat_completer: Arc<dyn AgentChatCompleter>,
    pub hold_ttl_seconds: u64,
    pub flat_estimate_credits: u64,
}

pub struct AgentChatService {
    pricing: Arc<PricingTable>,
    os_accounts: Arc<dyn OsAccountsClient>,
    chat_completer: Arc<dyn AgentChatCompleter>,
    hold_ttl_seconds: u64,
    flat_estimate_credits: u64,
}

impl AgentChatService {
    pub fn new(deps: AgentChatServiceDeps) -> Self {
        Self {
            pricing: deps.pricing,
            os_accounts: deps.os_accounts,
            chat_completer: deps.chat_completer,
            hold_ttl_seconds: deps.hold_ttl_seconds,
            flat_estimate_credits: deps.flat_estimate_credits,
        }
    }

    pub async fn complete(&self, params: AgentChatParams) -> Result<AgentChatOutput, ServiceError> {
        self.pricing
            .ensure_model_kind(&params.model_id.0, ModelKind::Text)?;
        if uses_user_venice_key_for_model(
            &self.pricing,
            &params.model_id.0,
            &params.provider_credentials,
        ) {
            let completion = self
                .chat_completer
                .complete(AgentChatRequest {
                    body: params.body,
                    model: params.model_id.clone(),
                    provider_credentials: params.provider_credentials.clone(),
                })
                .await?;
            log_skipped_user_venice_key(ActionSlug::AgentChat, &params.user_id, &params.model_id.0);
            return Ok(AgentChatOutput {
                completion,
                receipt: zero_receipt(),
            });
        }
        let estimate = Credits(self.flat_estimate_credits);
        let authorization = authorize_or_deny(AuthorizeParams {
            os_accounts: self.os_accounts.as_ref(),
            user_id: params.user_id.clone(),
            action: ActionSlug::AgentChat,
            estimate,
            hold_ttl_seconds: self.hold_ttl_seconds,
        })
        .await?;
        let body_digest = body_digest(&params.body);
        let completion = self
            .chat_completer
            .complete(AgentChatRequest {
                body: params.body,
                model: params.model_id.clone(),
                provider_credentials: params.provider_credentials.clone(),
            })
            .await?;
        let actual = self
            .pricing
            .price_token_usage(&params.model_id.0, completion.usage)?;
        let charge_credits = clamp_to_cap(actual, authorization.cap_credits);
        let receipt = charge(ChargeParams {
            os_accounts: self.os_accounts.as_ref(),
            action_token: authorization.action_token,
            credits: charge_credits,
            idempotency_key: format!(
                "agent_chat:{}:{}:{}",
                params.user_id.0, params.model_id.0, body_digest
            ),
        })
        .await?;
        log_settled(
            ActionSlug::AgentChat,
            &params.user_id,
            &params.model_id.0,
            &receipt,
        );
        Ok(AgentChatOutput {
            completion,
            receipt,
        })
    }

    pub async fn complete_stream(
        &self,
        params: AgentChatParams,
    ) -> Result<AgentChatStreamOutput, ServiceError> {
        self.pricing
            .ensure_model_kind(&params.model_id.0, ModelKind::Text)?;
        if uses_user_venice_key_for_model(
            &self.pricing,
            &params.model_id.0,
            &params.provider_credentials,
        ) {
            let stream = self
                .chat_completer
                .complete_stream(AgentChatRequest {
                    body: params.body,
                    model: params.model_id.clone(),
                    provider_credentials: params.provider_credentials.clone(),
                })
                .await?;
            tokio::spawn(async move {
                let _ = stream.usage.await;
            });
            log_skipped_user_venice_key(ActionSlug::AgentChat, &params.user_id, &params.model_id.0);
            return Ok(AgentChatStreamOutput {
                content_type: stream.content_type,
                provider: stream.provider,
                chunks: stream.chunks,
            });
        }

        let estimate = Credits(self.flat_estimate_credits);
        let authorization = authorize_or_deny(AuthorizeParams {
            os_accounts: self.os_accounts.as_ref(),
            user_id: params.user_id.clone(),
            action: ActionSlug::AgentChat,
            estimate,
            hold_ttl_seconds: self.hold_ttl_seconds,
        })
        .await?;
        let body_digest = body_digest(&params.body);
        let stream = self
            .chat_completer
            .complete_stream(AgentChatRequest {
                body: params.body,
                model: params.model_id.clone(),
                provider_credentials: params.provider_credentials.clone(),
            })
            .await?;
        spawn_stream_settlement(StreamSettlement {
            pricing: self.pricing.clone(),
            os_accounts: self.os_accounts.clone(),
            user_id: params.user_id,
            model_id: params.model_id,
            action_token: authorization.action_token,
            cap_credits: authorization.cap_credits,
            flat_estimate_credits: self.flat_estimate_credits,
            body_digest,
            usage: stream.usage,
        });
        Ok(AgentChatStreamOutput {
            content_type: stream.content_type,
            provider: stream.provider,
            chunks: stream.chunks,
        })
    }
}

#[derive(Clone, Debug)]
pub struct AgentChatParams {
    pub user_id: UserId,
    pub model_id: ModelId,
    pub body: serde_json::Value,
    pub provider_credentials: ProviderCredentials,
}

#[derive(Clone, Debug)]
pub struct AgentChatOutput {
    pub completion: AgentChatCompletion,
    pub receipt: Receipt,
}

pub struct AgentChatStreamOutput {
    pub content_type: String,
    pub provider: String,
    pub chunks: tokio::sync::mpsc::UnboundedReceiver<Result<bytes::Bytes, DomainError>>,
}

fn body_digest(body: &serde_json::Value) -> String {
    sha256_hex(body.to_string().as_bytes())
}

struct StreamSettlement {
    pricing: Arc<PricingTable>,
    os_accounts: Arc<dyn OsAccountsClient>,
    user_id: UserId,
    model_id: ModelId,
    action_token: String,
    cap_credits: Credits,
    flat_estimate_credits: u64,
    body_digest: String,
    usage: tokio::sync::oneshot::Receiver<Result<TokenUsage, DomainError>>,
}

fn spawn_stream_settlement(params: StreamSettlement) {
    tokio::spawn(async move {
        settle_stream_charge(params).await;
    });
}

async fn settle_stream_charge(params: StreamSettlement) {
    let usage_result = params.usage.await;
    let credits = match usage_result {
        Ok(Ok(usage)) => match params.pricing.price_token_usage(&params.model_id.0, usage) {
            Ok(actual) => clamp_to_cap(actual, params.cap_credits),
            Err(error) => {
                tracing::error!(
                    %error,
                    user_id = %params.user_id.0,
                    action = ActionSlug::AgentChat.as_str(),
                    model = %params.model_id.0,
                    "agent chat stream ended without usage; settling at flat estimate"
                );
                clamp_to_cap(Credits(params.flat_estimate_credits), params.cap_credits)
            }
        },
        Ok(Err(error)) => {
            tracing::error!(
                %error,
                user_id = %params.user_id.0,
                action = ActionSlug::AgentChat.as_str(),
                model = %params.model_id.0,
                "agent chat stream ended without usage; settling at flat estimate"
            );
            clamp_to_cap(Credits(params.flat_estimate_credits), params.cap_credits)
        }
        Err(error) => {
            tracing::error!(
                %error,
                user_id = %params.user_id.0,
                action = ActionSlug::AgentChat.as_str(),
                model = %params.model_id.0,
                "agent chat stream ended without usage; settling at flat estimate"
            );
            clamp_to_cap(Credits(params.flat_estimate_credits), params.cap_credits)
        }
    };
    let receipt = match charge(ChargeParams {
        os_accounts: params.os_accounts.as_ref(),
        action_token: params.action_token,
        credits,
        idempotency_key: format!(
            "agent_chat:{}:{}:{}",
            params.user_id.0, params.model_id.0, params.body_digest
        ),
    })
    .await
    {
        Ok(receipt) => receipt,
        Err(error) => {
            tracing::error!(
                %error,
                user_id = %params.user_id.0,
                action = ActionSlug::AgentChat.as_str(),
                model = %params.model_id.0,
                credits = credits.0,
                "agent chat stream charge failed"
            );
            return;
        }
    };
    log_settled(
        ActionSlug::AgentChat,
        &params.user_id,
        &params.model_id.0,
        &receipt,
    );
}

#[cfg(test)]
mod tests {
    use super::body_digest;
    use pretty_assertions::assert_eq;
    use serde_json::json;

    #[test]
    fn body_digest_is_stable_full_sha256_hex() {
        let body = json!({
            "model": "text-model",
            "messages": [{ "role": "user", "content": "hello" }],
        });

        let digest = body_digest(&body);

        assert_eq!(
            digest,
            "8791c5ca4cef8d9ea68549494f84e20e5f8224958d7b7aebc484dedb7b48e4ce"
        );
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|ch| ch.is_ascii_hexdigit()));
    }
}
