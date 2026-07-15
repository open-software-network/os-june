use crate::{
    charge_flow::{
        AuthorizeParams, ChargeParams, ReleaseHoldParams, authorize_or_deny, charge, clamp_to_cap,
        log_settled, new_charge_operation_id, release_hold, zero_receipt,
    },
    error::ServiceError,
    metering::{log_skipped_user_venice_key, uses_user_venice_key_for_model},
    pricing::PricingTable,
    util::sha256_hex,
};
use june_domain::{
    ActionSlug, AgentChatCompleter, AgentChatCompletion, AgentChatRequest, AgentChatStreamOutcome,
    Credits, DomainError, ModelId, ModelKind, OsAccountsClient, ProviderCredentials, Receipt,
    UpstreamRouteMetadata, UserId,
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
                    unmetered: true,
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
        let idempotency_key = idempotency_key(&params.user_id, &params.body);
        let completion = match self
            .chat_completer
            .complete(AgentChatRequest {
                body: params.body,
                model: params.model_id.clone(),
                provider_credentials: params.provider_credentials.clone(),
                unmetered: false,
            })
            .await
        {
            Ok(completion) => completion,
            Err(error) => {
                release_hold(ReleaseHoldParams {
                    os_accounts: self.os_accounts.as_ref(),
                    action: ActionSlug::AgentChat,
                    action_token: authorization.action_token,
                })
                .await;
                return Err(error.into());
            }
        };
        let actual = self
            .pricing
            .price_token_usage(&params.model_id.0, completion.usage)?;
        let charge_credits = clamp_to_cap(actual, authorization.cap_credits);
        let receipt = charge(ChargeParams {
            os_accounts: self.os_accounts.as_ref(),
            action_token: authorization.action_token,
            credits: charge_credits,
            idempotency_key,
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
                    unmetered: true,
                })
                .await?;
            tokio::spawn(async move {
                let _ = stream.outcome.await;
            });
            log_skipped_user_venice_key(ActionSlug::AgentChat, &params.user_id, &params.model_id.0);
            return Ok(AgentChatStreamOutput {
                content_type: stream.content_type,
                provider: stream.provider,
                route: stream.route,
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
        let idempotency_key = idempotency_key(&params.user_id, &params.body);
        let stream = match self
            .chat_completer
            .complete_stream(AgentChatRequest {
                body: params.body,
                model: params.model_id.clone(),
                provider_credentials: params.provider_credentials.clone(),
                unmetered: false,
            })
            .await
        {
            Ok(stream) => stream,
            Err(error) => {
                release_hold(ReleaseHoldParams {
                    os_accounts: self.os_accounts.as_ref(),
                    action: ActionSlug::AgentChat,
                    action_token: authorization.action_token,
                })
                .await;
                return Err(error.into());
            }
        };
        spawn_stream_settlement(StreamSettlement {
            pricing: self.pricing.clone(),
            os_accounts: self.os_accounts.clone(),
            user_id: params.user_id,
            model_id: params.model_id,
            action_token: authorization.action_token,
            cap_credits: authorization.cap_credits,
            flat_estimate_credits: self.flat_estimate_credits,
            idempotency_key,
            outcome: stream.outcome,
        });
        Ok(AgentChatStreamOutput {
            content_type: stream.content_type,
            provider: stream.provider,
            route: stream.route,
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
    pub route: UpstreamRouteMetadata,
    pub chunks: tokio::sync::mpsc::UnboundedReceiver<Result<bytes::Bytes, DomainError>>,
}

fn body_digest(body: &serde_json::Value) -> String {
    sha256_hex(body.to_string().as_bytes())
}

/// Each paid chat attempt gets a globally unique settlement scope, minted
/// before the upstream call (same rule as the image keys). A retried
/// identical body runs a fresh upstream completion that delivers its own
/// content, so it settles its own charge — under the old digest-only key the
/// second attempt's settlement replayed as a no-op, delivering content
/// without a wallet movement. Unlike images there is no retry ledger in
/// front: chat has no client-supplied request id, and any retry that reaches
/// the upstream does real billable work. The digest stays for debuggability.
fn idempotency_key(user_id: &UserId, body: &serde_json::Value) -> String {
    format!(
        "agent_chat:{}:attempt:{}:{}",
        user_id.0,
        new_charge_operation_id(),
        body_digest(body)
    )
}

struct StreamSettlement {
    pricing: Arc<PricingTable>,
    os_accounts: Arc<dyn OsAccountsClient>,
    user_id: UserId,
    model_id: ModelId,
    action_token: String,
    cap_credits: Credits,
    flat_estimate_credits: u64,
    idempotency_key: String,
    outcome: tokio::sync::oneshot::Receiver<AgentChatStreamOutcome>,
}

fn spawn_stream_settlement(params: StreamSettlement) {
    tokio::spawn(async move {
        settle_stream_charge(params).await;
    });
}

async fn settle_stream_charge(params: StreamSettlement) {
    // Failed (or a dead pump) charges nothing — the buffered path errors
    // before its charge line on the same transport failure, and the hold
    // expires on its own. Only a DELIVERED body may bill: at metered usage
    // when the frame arrived, at the flat estimate when it did not.
    let credits = match params.outcome.await {
        Ok(AgentChatStreamOutcome::Usage(usage)) => {
            match params.pricing.price_token_usage(&params.model_id.0, usage) {
                Ok(actual) => clamp_to_cap(actual, params.cap_credits),
                Err(error) => {
                    tracing::error!(
                        %error,
                        user_id = %params.user_id.0,
                        action = ActionSlug::AgentChat.as_str(),
                        model = %params.model_id.0,
                        "agent chat stream usage failed to price; settling at flat estimate"
                    );
                    clamp_to_cap(Credits(params.flat_estimate_credits), params.cap_credits)
                }
            }
        }
        Ok(AgentChatStreamOutcome::CompletedWithoutUsage) => {
            tracing::error!(
                user_id = %params.user_id.0,
                action = ActionSlug::AgentChat.as_str(),
                model = %params.model_id.0,
                "agent chat stream completed without usage; settling at flat estimate"
            );
            clamp_to_cap(Credits(params.flat_estimate_credits), params.cap_credits)
        }
        Ok(AgentChatStreamOutcome::Failed) | Err(_) => {
            tracing::error!(
                user_id = %params.user_id.0,
                action = ActionSlug::AgentChat.as_str(),
                model = %params.model_id.0,
                "agent chat stream failed mid-transport; releasing hold"
            );
            release_hold(ReleaseHoldParams {
                os_accounts: params.os_accounts.as_ref(),
                action: ActionSlug::AgentChat,
                action_token: params.action_token,
            })
            .await;
            return;
        }
    };
    let receipt = match charge(ChargeParams {
        os_accounts: params.os_accounts.as_ref(),
        action_token: params.action_token,
        credits,
        idempotency_key: params.idempotency_key,
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
