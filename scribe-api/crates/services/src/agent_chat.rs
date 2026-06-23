use crate::{
    charge_flow::{
        AsyncChargeParams, AuthorizeParams, ChargeParams, authorize_or_deny, charge, clamp_to_cap,
        log_settled, spawn_charge,
    },
    error::ServiceError,
    pricing::PricingTable,
    util::sha256_hex,
};
use scribe_domain::{
    ActionSlug, AgentChatCompleter, AgentChatCompletion, AgentChatRequest, Credits, ModelId,
    ModelKind, OsAccountsClient, Receipt, TokenUsage, UserId,
};
use std::sync::{Arc, Mutex};

pub struct AgentChatServiceDeps {
    pub pricing: Arc<PricingTable>,
    pub os_accounts: Arc<dyn OsAccountsClient>,
    pub guarded_chat_completer: Arc<dyn AgentChatCompleter>,
    pub direct_chat_completer: Arc<dyn AgentChatCompleter>,
    pub hold_ttl_seconds: u64,
    pub flat_estimate_credits: u64,
}

pub struct AgentChatService {
    pricing: Arc<PricingTable>,
    os_accounts: Arc<dyn OsAccountsClient>,
    guarded_chat_completer: Arc<dyn AgentChatCompleter>,
    direct_chat_completer: Arc<dyn AgentChatCompleter>,
    hold_ttl_seconds: u64,
    flat_estimate_credits: u64,
}

impl AgentChatService {
    pub fn new(deps: AgentChatServiceDeps) -> Self {
        Self {
            pricing: deps.pricing,
            os_accounts: deps.os_accounts,
            guarded_chat_completer: deps.guarded_chat_completer,
            direct_chat_completer: deps.direct_chat_completer,
            hold_ttl_seconds: deps.hold_ttl_seconds,
            flat_estimate_credits: deps.flat_estimate_credits,
        }
    }

    pub async fn complete(&self, params: AgentChatParams) -> Result<AgentChatOutput, ServiceError> {
        self.pricing
            .ensure_model_kind(&params.model_id.0, ModelKind::Text)?;
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
            .chat_completer(params.route)
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

    /// Streaming counterpart of `complete`: holds credits up front, forwards the
    /// provider response body to the caller as it arrives, and settles billing
    /// once the stream completes (from the usage frame captured at end of
    /// stream). A post-stream charge failure is logged and the hold expires by
    /// TTL — it can never double-charge because the idempotency key is stable.
    pub async fn complete_streaming(
        &self,
        params: AgentChatParams,
    ) -> Result<AgentChatStreamOutput, ServiceError> {
        self.pricing
            .ensure_model_kind(&params.model_id.0, ModelKind::Text)?;
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
            .chat_completer(params.route)
            .complete_streaming(AgentChatRequest {
                body: params.body,
                model: params.model_id.clone(),
            })
            .await?;

        // Settlement is owned by a guard that fires when the response body is
        // dropped — whether it streamed to completion or the client disconnected
        // after the final frame. The charge is spawned detached so it cannot be
        // cancelled by the connection closing (the provider captures usage when
        // its frame streams, before [DONE], so it is available at drop time).
        let billing = StreamBilling {
            os_accounts: self.os_accounts.clone(),
            pricing: self.pricing.clone(),
            user_id: params.user_id.clone(),
            model_id: params.model_id.clone(),
            cap_credits: authorization.cap_credits,
            idempotency_key: format!(
                "agent_chat:{}:{}:{}",
                params.user_id.0, params.model_id.0, body_digest
            ),
            usage: stream.usage.clone(),
            action_token: Some(authorization.action_token),
        };
        let content_type = stream.content_type.clone();
        let upstream = stream.body;

        let billed = async_stream::stream! {
            use futures_util::StreamExt;
            // Held for the lifetime of the body; its Drop settles billing.
            let _billing = billing;
            futures_util::pin_mut!(upstream);
            while let Some(item) = upstream.next().await {
                yield item;
            }
        };

        Ok(AgentChatStreamOutput {
            content_type,
            body: Box::pin(billed),
        })
    }

    fn chat_completer(&self, route: AgentChatRoute) -> &dyn AgentChatCompleter {
        match route {
            AgentChatRoute::Guarded => self.guarded_chat_completer.as_ref(),
            AgentChatRoute::Direct => self.direct_chat_completer.as_ref(),
        }
    }
}

/// Settles billing for a streamed agent chat when the response body is dropped.
/// Dropping happens whether the stream completed or the client disconnected, so
/// settlement is never lost to a connection close after the final frame. The
/// charge is spawned detached so the connection lifetime cannot cancel it.
struct StreamBilling {
    os_accounts: Arc<dyn OsAccountsClient>,
    pricing: Arc<PricingTable>,
    user_id: UserId,
    model_id: ModelId,
    cap_credits: Option<Credits>,
    idempotency_key: String,
    usage: Arc<Mutex<Option<TokenUsage>>>,
    action_token: Option<String>,
}

impl Drop for StreamBilling {
    fn drop(&mut self) {
        let Some(action_token) = self.action_token.take() else {
            return;
        };
        // Outside a Tokio runtime (e.g. dropped in a sync test) there is nothing
        // to spawn onto; skip rather than panic.
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let usage = self.usage.lock().ok().and_then(|mut guard| guard.take());
        let Some(usage) = usage else {
            tracing::warn!(
                user_id = %self.user_id.0,
                model = %self.model_id.0,
                "agent chat: stream ended without usage; not charging (hold expires)"
            );
            return;
        };
        let actual = match self.pricing.price_token_usage(&self.model_id.0, usage) {
            Ok(actual) => actual,
            Err(error) => {
                tracing::error!(
                    %error,
                    model = %self.model_id.0,
                    "agent chat: post-stream pricing failed; not charging"
                );
                return;
            }
        };
        spawn_charge(AsyncChargeParams {
            os_accounts: self.os_accounts.clone(),
            user_id: self.user_id.clone(),
            action: ActionSlug::AgentChat,
            model_id: Some(self.model_id.0.clone()),
            action_token,
            credits: clamp_to_cap(actual, self.cap_credits),
            idempotency_key: self.idempotency_key.clone(),
        });
    }
}

/// A streamed agent-chat response: the content type plus the body stream that
/// forwards the provider response and settles billing when it ends.
pub struct AgentChatStreamOutput {
    pub content_type: String,
    pub body: std::pin::Pin<
        Box<
            dyn futures_util::Stream<Item = Result<bytes::Bytes, scribe_domain::DomainError>>
                + Send,
        >,
    >,
}

#[derive(Clone, Debug)]
pub struct AgentChatParams {
    pub user_id: UserId,
    pub model_id: ModelId,
    pub body: serde_json::Value,
    pub route: AgentChatRoute,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentChatRoute {
    Guarded,
    Direct,
}

#[derive(Clone, Debug)]
pub struct AgentChatOutput {
    pub completion: AgentChatCompletion,
    pub receipt: Receipt,
}

fn body_digest(body: &serde_json::Value) -> String {
    sha256_hex(body.to_string().as_bytes())
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
