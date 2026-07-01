use crate::pricing::PricingTable;
use june_domain::{ActionSlug, ProviderCredentials, UserId};

pub(crate) fn uses_user_venice_key_for_model(
    pricing: &PricingTable,
    model_id: &str,
    provider_credentials: &ProviderCredentials,
) -> bool {
    provider_credentials.has_venice_api_key() && pricing.is_venice_model(model_id)
}

pub(crate) fn uses_user_venice_key(provider_credentials: &ProviderCredentials) -> bool {
    provider_credentials.has_venice_api_key()
}

pub(crate) fn log_skipped_user_venice_key(action: ActionSlug, user_id: &UserId, model_id: &str) {
    tracing::info!(
        user_id = %user_id.0,
        action = action.as_str(),
        model = model_id,
        "skipped June credit metering for user-provided Venice API key"
    );
}
