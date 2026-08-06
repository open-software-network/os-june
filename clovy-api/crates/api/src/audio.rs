use crate::error::ApiError;

const RIFF_HEADER: &[u8; 4] = b"RIFF";
const WAVE_HEADER: &[u8; 4] = b"WAVE";
const FTYP_HEADER: &[u8; 4] = b"ftyp";

/// Accept either WAV (RIFF/WAVE) or MPEG-4 (M4A — `ftyp` box at offset 4).
/// Note transcription uses WAV from the system-audio helpers; dictation uses
/// M4A from the macOS dictation helper (`AVAssetWriter` MPEG-4 AAC).
pub(crate) fn validate_audio(bytes: &[u8]) -> Result<(), ApiError> {
    if bytes.len() < 12 {
        return Err(ApiError::bad_request("unsupported_audio_format"));
    }
    let is_wav = &bytes[0..4] == RIFF_HEADER && &bytes[8..12] == WAVE_HEADER;
    let is_m4a = &bytes[4..8] == FTYP_HEADER;
    if !is_wav && !is_m4a {
        return Err(ApiError::bad_request("unsupported_audio_format"));
    }
    Ok(())
}
