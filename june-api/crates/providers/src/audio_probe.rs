use crate::{M4aDurationProbe, WavDurationProbe};
use june_domain::{AudioDurationProbe, DomainError};
use std::time::Duration;

/// Dispatches duration probing based on header sniffing — WAV (RIFF/WAVE) or
/// M4A (`ftyp` at offset 4). Same format check the API audio validator runs;
/// keeping the two in sync is what stops the dictate path from charging on
/// audio it can't actually price.
pub struct MultiFormatDurationProbe;

impl AudioDurationProbe for MultiFormatDurationProbe {
    fn probe(&self, audio: &[u8]) -> Result<Duration, DomainError> {
        if audio.len() < 12 {
            return Err(DomainError::InvalidInput {
                reason: "audio_too_short".to_string(),
            });
        }
        if &audio[0..4] == b"RIFF" && &audio[8..12] == b"WAVE" {
            WavDurationProbe.probe(audio)
        } else if &audio[4..8] == b"ftyp" {
            M4aDurationProbe.probe(audio)
        } else {
            Err(DomainError::InvalidInput {
                reason: "unsupported_audio_format".to_string(),
            })
        }
    }
}
