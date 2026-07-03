//! Best-effort language detection for transcripts.
//!
//! Venice ASR only ever returns `{"text"}` (no detected language), so the
//! `language` on a [`Transcript`] comes back `None` for every dictation. Rather
//! than leave the field empty, we detect the language from the transcribed text
//! server-side with `whatlang` — a small, offline, pure-Rust trigram detector
//! that needs no network or model downloads (safe inside the TEE).
//!
//! A missing badge is better than a wrong one, so detection only fills the field
//! when the text is long enough to be worth trusting AND `whatlang` reports the
//! guess as reliable. A language the provider itself supplied always wins over
//! detection.

use june_domain::Transcript;
use whatlang::Lang;

/// Below this many characters, trigram detection is too noisy to trust (short
/// dictations like "yes" or "on my way" would get a confident but wrong guess),
/// so we leave the language unset instead.
const MIN_CHARS_FOR_DETECTION: usize = 20;

/// Fill in `transcript.language` when the provider did not supply one, in
/// priority order:
///
/// 1. Provider-supplied language (authoritative — left as-is).
/// 2. `requested`: the language the user explicitly configured in the desktop
///    dictation picker (a validated two-letter code). Trusted ahead of
///    detection, since it is a deliberate user choice and covers short or
///    ambiguous utterances that detection would miss.
/// 3. Text detection.
pub(crate) fn fill_missing_language(
    mut transcript: Transcript,
    requested: Option<&str>,
) -> Transcript {
    if transcript.language.is_none() {
        transcript.language =
            normalize_requested(requested).or_else(|| detect_iso639_1(&transcript.text));
    }
    transcript
}

/// The desktop dictation-language picker sends a validated two-letter ISO 639-1
/// code, or an empty string for "Auto-detect". `/v1/dictate` only length-checks
/// the field, though, so accept it only when it has the two-letter ISO 639-1
/// shape — an empty string, a locale tag like `en-US`, or free text falls
/// through to detection rather than becoming a bogus badge.
fn normalize_requested(requested: Option<&str>) -> Option<String> {
    let code = requested?.trim();
    if code.len() == 2 && code.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        Some(code.to_ascii_lowercase())
    } else {
        None
    }
}

/// Detect the language of `text` and return its lowercase ISO 639-1 code
/// (`"en"`, `"pl"`, `"fr"`), or `None` when the text is too short, the guess is
/// unreliable, or the language has no ISO 639-1 code.
fn detect_iso639_1(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.chars().count() < MIN_CHARS_FOR_DETECTION {
        return None;
    }
    let info = whatlang::detect(trimmed)?;
    if !info.is_reliable() {
        return None;
    }
    Some(iso639_1(info.lang()).to_owned())
}

/// Map a `whatlang` language (ISO 639-3) to its ISO 639-1 two-letter code.
/// `whatlang::Lang::code()` only exposes 639-3, but the dictation-history badge
/// renders 639-1, so we translate here. The match is total over `whatlang`'s
/// fixed language set (pinned to 0.18.x, which cannot add variants).
fn iso639_1(lang: Lang) -> &'static str {
    match lang {
        Lang::Epo => "eo",
        Lang::Eng => "en",
        Lang::Rus => "ru",
        Lang::Cmn => "zh",
        Lang::Spa => "es",
        Lang::Por => "pt",
        Lang::Ita => "it",
        Lang::Ben => "bn",
        Lang::Fra => "fr",
        Lang::Deu => "de",
        Lang::Ukr => "uk",
        Lang::Kat => "ka",
        Lang::Ara => "ar",
        Lang::Hin => "hi",
        Lang::Jpn => "ja",
        Lang::Heb => "he",
        Lang::Yid => "yi",
        Lang::Pol => "pl",
        Lang::Amh => "am",
        Lang::Jav => "jv",
        Lang::Kor => "ko",
        Lang::Nob => "nb",
        Lang::Dan => "da",
        Lang::Swe => "sv",
        Lang::Fin => "fi",
        Lang::Tur => "tr",
        Lang::Nld => "nl",
        Lang::Hun => "hu",
        Lang::Ces => "cs",
        Lang::Ell => "el",
        Lang::Bul => "bg",
        Lang::Bel => "be",
        Lang::Mar => "mr",
        Lang::Kan => "kn",
        Lang::Ron => "ro",
        Lang::Slv => "sl",
        Lang::Hrv => "hr",
        Lang::Srp => "sr",
        Lang::Mkd => "mk",
        Lang::Lit => "lt",
        Lang::Lav => "lv",
        Lang::Est => "et",
        Lang::Tam => "ta",
        Lang::Vie => "vi",
        Lang::Urd => "ur",
        Lang::Tha => "th",
        Lang::Guj => "gu",
        Lang::Uzb => "uz",
        Lang::Pan => "pa",
        Lang::Aze => "az",
        Lang::Ind => "id",
        Lang::Tel => "te",
        Lang::Pes => "fa",
        Lang::Mal => "ml",
        Lang::Ori => "or",
        Lang::Mya => "my",
        Lang::Nep => "ne",
        Lang::Sin => "si",
        Lang::Khm => "km",
        Lang::Tuk => "tk",
        Lang::Aka => "ak",
        Lang::Zul => "zu",
        Lang::Sna => "sn",
        Lang::Afr => "af",
        Lang::Lat => "la",
        Lang::Slk => "sk",
        Lang::Cat => "ca",
        Lang::Tgl => "tl",
        Lang::Hye => "hy",
        Lang::Cym => "cy",
    }
}

#[cfg(test)]
mod tests {
    use super::{detect_iso639_1, fill_missing_language};
    use june_domain::Transcript;
    use pretty_assertions::assert_eq;

    fn transcript(text: &str, language: Option<&str>) -> Transcript {
        Transcript {
            text: text.to_string(),
            language: language.map(str::to_string),
            provider: "test".to_string(),
        }
    }

    #[test]
    fn detects_english() {
        assert_eq!(
            detect_iso639_1(
                "Let us schedule a call for next week to discuss the project roadmap and the budget."
            ),
            Some("en".to_string())
        );
    }

    #[test]
    fn detects_polish() {
        assert_eq!(
            detect_iso639_1(
                "Dzień dobry, chciałbym umówić się na spotkanie w przyszłym tygodniu rano."
            ),
            Some("pl".to_string())
        );
    }

    #[test]
    fn detects_french() {
        assert_eq!(
            detect_iso639_1(
                "Bonjour, je voudrais organiser une réunion la semaine prochaine avec l'équipe."
            ),
            Some("fr".to_string())
        );
    }

    #[test]
    fn short_or_gibberish_text_is_not_detected() {
        // Below the length floor: a confident-but-wrong guess is worse than none.
        assert_eq!(detect_iso639_1("ok thanks"), None);
        assert_eq!(detect_iso639_1(""), None);
        assert_eq!(detect_iso639_1("   \n  "), None);
    }

    #[test]
    fn provider_supplied_language_wins_over_everything() {
        // The text is plainly English and a language is requested, but a
        // provider-supplied code is authoritative and must not be overwritten.
        let enriched = fill_missing_language(
            transcript(
                "Let us schedule a call for next week to discuss the project roadmap and the budget.",
                Some("ja"),
            ),
            Some("de"),
        );
        assert_eq!(enriched.language, Some("ja".to_string()));
    }

    #[test]
    fn requested_language_wins_over_detection() {
        // A deliberate user choice is trusted ahead of trigram detection.
        let enriched = fill_missing_language(
            transcript(
                "Let us schedule a call for next week to discuss the project roadmap and the budget.",
                None,
            ),
            Some("de"),
        );
        assert_eq!(enriched.language, Some("de".to_string()));
    }

    #[test]
    fn requested_language_fills_when_detection_would_fail() {
        // "sí" is too short to detect, but the user configured Spanish.
        let enriched = fill_missing_language(transcript("sí", None), Some("es"));
        assert_eq!(enriched.language, Some("es".to_string()));
    }

    #[test]
    fn empty_requested_language_is_auto_detect_and_falls_through() {
        // "" is the picker's "Auto-detect" sentinel: detection still runs.
        let enriched = fill_missing_language(
            transcript(
                "Let us schedule a call for next week to discuss the project roadmap and the budget.",
                None,
            ),
            Some(""),
        );
        assert_eq!(enriched.language, Some("en".to_string()));
    }

    #[test]
    fn malformed_requested_language_is_rejected_and_falls_through() {
        let english =
            "Let us schedule a call for next week to discuss the project roadmap and the budget.";
        // Locale tags and free text are not the two-letter shape: fall through
        // to detection rather than badge the raw string.
        assert_eq!(
            fill_missing_language(transcript(english, None), Some("en-US")).language,
            Some("en".to_string())
        );
        assert_eq!(
            fill_missing_language(transcript(english, None), Some("auto")).language,
            Some("en".to_string())
        );
        // Rejected requested value AND text too short to detect -> stays None.
        assert_eq!(
            fill_missing_language(transcript("sí", None), Some("english")).language,
            None
        );
        // A valid two-letter code is normalized to lowercase.
        assert_eq!(
            fill_missing_language(transcript("sí", None), Some("PL")).language,
            Some("pl".to_string())
        );
    }

    #[test]
    fn missing_language_is_filled_from_text() {
        let enriched = fill_missing_language(
            transcript(
                "Let us schedule a call for next week to discuss the project roadmap and the budget.",
                None,
            ),
            None,
        );
        assert_eq!(enriched.language, Some("en".to_string()));
    }

    #[test]
    fn missing_language_stays_none_for_trivial_text() {
        let enriched = fill_missing_language(transcript("ok", None), None);
        assert_eq!(enriched.language, None);
    }
}
