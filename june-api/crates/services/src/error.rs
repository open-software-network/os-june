use crate::pricing::PricingError;
use june_domain::DomainError;
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
    #[error("metering_provider_failed")]
    MeteringProvider,
    #[error("invalid_input: {reason}")]
    InvalidInput { reason: String },
    /// A video job id that is unknown, evicted, or whose Venice media expired.
    #[error("job_not_found")]
    JobNotFound,
    /// Venice refused the video on content policy (`content_violation`, from a
    /// 422) or consent grounds (`needs_consent`, from a 409), or the model is
    /// region-blocked (`model_region_blocked`, from a 403). No charge is taken.
    #[error("content_rejected: {reason}")]
    ContentRejected { reason: String },
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
            DomainError::MeteringProvider => Self::MeteringProvider,
            DomainError::InvalidInput { reason } => Self::InvalidInput { reason },
        }
    }
}
