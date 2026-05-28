use crate::pricing::PricingError;
use scribe_domain::DomainError;
use thiserror::Error;

#[derive(Debug, Error, Eq, PartialEq)]
pub enum ServiceError {
    #[error("model_not_priced")]
    ModelNotPriced,
    #[error("price_overflow")]
    PriceOverflow,
    #[error("insufficient_credits")]
    InsufficientCredits,
    #[error("authorization_denied")]
    AuthorizationDenied,
    #[error("upstream_provider_failed")]
    UpstreamProvider,
    #[error("invalid_input: {reason}")]
    InvalidInput { reason: String },
}

impl From<PricingError> for ServiceError {
    fn from(error: PricingError) -> Self {
        match error {
            PricingError::NotPriced | PricingError::WrongUnit | PricingError::MissingRate => {
                Self::ModelNotPriced
            }
            PricingError::Overflow => Self::PriceOverflow,
        }
    }
}

impl From<DomainError> for ServiceError {
    fn from(error: DomainError) -> Self {
        match error {
            DomainError::ModelNotPriced => Self::ModelNotPriced,
            DomainError::InsufficientCredits => Self::InsufficientCredits,
            DomainError::UpstreamProvider => Self::UpstreamProvider,
            DomainError::InvalidInput { reason } => Self::InvalidInput { reason },
        }
    }
}
