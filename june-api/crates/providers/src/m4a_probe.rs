use june_domain::{AudioDurationProbe, DomainError};
use std::{io::Cursor, time::Duration};
use thiserror::Error;

pub struct M4aDurationProbe;

impl M4aDurationProbe {
    pub fn probe(bytes: &[u8]) -> Result<Duration, M4aProbeError> {
        // mp4::Mp4Reader requires a Seek + Read source and the total size in
        // bytes — Cursor satisfies the trait bounds and the slice's length is
        // already known.
        let size = bytes.len() as u64;
        let reader = mp4::Mp4Reader::read_header(Cursor::new(bytes), size)?;
        // Compute the wall-clock duration from the mvhd box ourselves instead
        // of calling `Mp4Reader::duration()`: the crate divides by the
        // attacker-controlled `mvhd.timescale` without a zero check (and
        // multiplies without overflow checks), which would panic — and with
        // `panic = "abort"` in release, take down the whole process — on a
        // crafted upload.
        let timescale = u64::from(reader.moov.mvhd.timescale);
        if timescale == 0 {
            return Err(M4aProbeError::InvalidDuration);
        }
        let millis = reader
            .moov
            .mvhd
            .duration
            .checked_mul(1000)
            .map(|value| value / timescale)
            .ok_or(M4aProbeError::InvalidDuration)?;
        Ok(Duration::from_millis(millis))
    }
}

impl AudioDurationProbe for M4aDurationProbe {
    fn probe(&self, audio: &[u8]) -> Result<Duration, DomainError> {
        Self::probe(audio).map_err(DomainError::from)
    }
}

#[derive(Debug, Error)]
pub enum M4aProbeError {
    #[error(transparent)]
    Mp4(#[from] mp4::Error),
    #[error("invalid m4a duration")]
    InvalidDuration,
}

impl From<M4aProbeError> for DomainError {
    fn from(error: M4aProbeError) -> Self {
        Self::InvalidInput {
            reason: error.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{M4aDurationProbe, M4aProbeError};
    use mp4::{FourCC, FtypBox, MoovBox, WriteBox};
    use pretty_assertions::assert_eq;
    use std::time::Duration;

    // `MvhdBox` itself is crate-private in `mp4`; reach it through MoovBox's
    // public `mvhd` field instead.
    fn m4a_bytes(timescale: u32, duration: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        FtypBox {
            major_brand: FourCC::from(*b"M4A "),
            minor_version: 0,
            compatible_brands: vec![FourCC::from(*b"isom")],
        }
        .write_box(&mut bytes)
        .expect("write ftyp");
        let mut moov = MoovBox::default();
        moov.mvhd.timescale = timescale;
        moov.mvhd.duration = duration;
        moov.write_box(&mut bytes).expect("write moov");
        bytes
    }

    #[test]
    fn probes_duration_from_mvhd() {
        let bytes = m4a_bytes(1000, 1500);

        let duration = M4aDurationProbe::probe(&bytes).expect("probe succeeds");

        assert_eq!(duration, Duration::from_millis(1500));
    }

    #[test]
    fn zero_timescale_is_an_error_not_a_panic() {
        // Regression: `Mp4Reader::duration()` divides by the attacker-
        // controlled mvhd timescale; with `panic = "abort"` in release a
        // crafted upload would take down the process.
        let bytes = m4a_bytes(0, 1500);

        let result = M4aDurationProbe::probe(&bytes);

        assert!(matches!(result, Err(M4aProbeError::InvalidDuration)));
    }
}
