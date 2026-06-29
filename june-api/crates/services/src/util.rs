use crate::error::ServiceError;
use sha2::{Digest, Sha256};
use std::time::Duration;

pub(crate) fn ceil_seconds(duration: Duration) -> Result<u64, ServiceError> {
    let millis = u64::try_from(duration.as_millis()).map_err(|_| ServiceError::PriceOverflow)?;
    millis
        .checked_add(999)
        .map(|value| value / 1000)
        .ok_or(ServiceError::PriceOverflow)
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex_lower(&digest)
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}
