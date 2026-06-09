use crate::error::ServiceError;
use std::time::Duration;

pub(crate) fn ceil_seconds(duration: Duration) -> Result<u64, ServiceError> {
    let millis = u64::try_from(duration.as_millis()).map_err(|_| ServiceError::PriceOverflow)?;
    millis
        .checked_add(999)
        .map(|value| value / 1000)
        .ok_or(ServiceError::PriceOverflow)
}
