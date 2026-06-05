use crate::{
    charge_flow::{
        AuthorizeParams, ChargeParams, authorize_or_deny, charge, clamp_to_cap, log_settled,
    },
    error::ServiceError,
    pricing::PricingTable,
};
use scribe_domain::{
    ActionSlug, AgentChatCompleter, AgentChatCompletion, AgentChatRequest, Credits, ModelId,
    OsAccountsClient, Receipt, UserId,
};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    sync::Arc,
};

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
        let estimate = Credits(self.flat_estimate_credits);
        let authorization = authorize_or_deny(AuthorizeParams {
            os_accounts: self.os_accounts.as_ref(),
            user_id: params.user_id.clone(),
            action: ActionSlug::AgentChat,
            estimate,
            hold_ttl_seconds: self.hold_ttl_seconds,
        })
        .await?;
        let body_hash = body_hash(&params.body);
        let completion = self
            .chat_completer
            .complete(AgentChatRequest {
                body: params.body,
                model: params.model_id.clone(),
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
                params.user_id.0, params.model_id.0, body_hash
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
}

#[derive(Clone, Debug)]
pub struct AgentChatParams {
    pub user_id: UserId,
    pub model_id: ModelId,
    pub body: serde_json::Value,
}

#[derive(Clone, Debug)]
pub struct AgentChatOutput {
    pub completion: AgentChatCompletion,
    pub receipt: Receipt,
}

fn body_hash(body: &serde_json::Value) -> u64 {
    let mut hasher = DefaultHasher::new();
    body.to_string().hash(&mut hasher);
    hasher.finish()
}
