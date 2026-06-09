use june_domain::{AudioDurationProbe, DomainError};
use std::{io::Cursor, time::Duration};
use thiserror::Error;

pub struct WavDurationProbe;

impl WavDurationProbe {
    pub fn probe(bytes: &[u8]) -> Result<Duration, ProbeError> {
        let reader = hound::WavReader::new(Cursor::new(bytes))?;
        let spec = reader.spec();
        let sample_rate = u64::from(spec.sample_rate);
        if sample_rate == 0 {
            return Err(ProbeError::InvalidWav);
        }
        let samples = u64::from(reader.duration());
        Ok(Duration::from_millis(
            samples.saturating_mul(1000) / sample_rate,
        ))
    }
}

impl AudioDurationProbe for WavDurationProbe {
    fn probe(&self, audio: &[u8]) -> Result<Duration, DomainError> {
        Self::probe(audio).map_err(DomainError::from)
    }
}

#[derive(Debug, Error)]
pub enum ProbeError {
    #[error("invalid wav")]
    InvalidWav,
    #[error(transparent)]
    Hound(#[from] hound::Error),
}

impl From<ProbeError> for DomainError {
    fn from(error: ProbeError) -> Self {
        Self::InvalidInput {
            reason: error.to_string(),
        }
    }
}
