use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use std::{future::Future, time::Duration};
use tokio::time::timeout;

// Deliberately conservative (ADR 0008 addendum, JUN-209): this list only
// gates the safe-mode consent dialog, never what gets generated - Venice
// `safe_mode` is the enforcement. Keep terms unambiguous; euphemisms are an
// accepted miss, and broadening the list mostly buys false-positive dialogs.
const EXPLICIT_TERMS: &[&str] = &[
    "bdsm",
    "bottomless",
    "erotic",
    "erotica",
    "explicit",
    "fetish",
    "genitals",
    "hentai",
    "naked",
    "nipples",
    "nsfw",
    "nude",
    "nudes",
    "porn",
    "porno",
    "pornographic",
    "sex",
    "sexual",
    "sexy",
    "stripping",
    "striptease",
    "topless",
    "undressed",
    "undressing",
    "xxx",
];

const EXPLICIT_PHRASES: &[&[&str]] = &[
    &["no", "clothes"],
    &["take", "off", "her", "clothes"],
    &["take", "off", "his", "clothes"],
    &["take", "off", "their", "clothes"],
    &["without", "clothes"],
];

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImagePromptScreenRequest {
    pub prompt: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImagePromptScreenResponse {
    pub may_be_explicit: bool,
}

/// True when an image prompt plausibly requests explicit (adult) content, so
/// callers can offer the safe-mode consent dialog before generating.
pub fn may_request_explicit_content(prompt: &str) -> bool {
    let normalized = prompt.to_lowercase();
    let tokens: Vec<&str> = normalized
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect();

    tokens
        .iter()
        .any(|token| EXPLICIT_TERMS.binary_search(token).is_ok())
        || EXPLICIT_PHRASES
            .iter()
            .any(|phrase| contains_token_sequence(&tokens, phrase))
}

#[tauri::command]
pub async fn image_prompt_may_be_explicit(
    request: ImagePromptScreenRequest,
) -> ImagePromptScreenResponse {
    screen_image_prompt(&request.prompt, |prompt| async move {
        crate::june_api::classify_image_prompt_explicit(&prompt).await
    })
    .await
}

async fn screen_image_prompt<F, Fut>(prompt: &str, classify: F) -> ImagePromptScreenResponse
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<bool, AppError>>,
{
    if may_request_explicit_content(prompt) {
        return ImagePromptScreenResponse {
            may_be_explicit: true,
        };
    }

    let may_be_explicit = match timeout(Duration::from_secs(8), classify(prompt.to_string())).await
    {
        Ok(Ok(verdict)) => verdict,
        Ok(Err(_)) | Err(_) => false,
    };

    ImagePromptScreenResponse { may_be_explicit }
}

fn contains_token_sequence(tokens: &[&str], sequence: &[&str]) -> bool {
    !sequence.is_empty()
        && tokens
            .windows(sequence.len())
            .any(|window| window == sequence)
}

#[cfg(test)]
mod tests {
    use super::{may_request_explicit_content, screen_image_prompt};
    use crate::domain::types::AppError;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    #[test]
    fn detects_plain_term() {
        assert!(may_request_explicit_content("portrait of a nude figure"));
    }

    #[test]
    fn detects_uppercase_term() {
        assert!(may_request_explicit_content("NSFW illustration"));
    }

    #[test]
    fn detects_term_with_punctuation() {
        assert!(may_request_explicit_content("nude!"));
    }

    #[test]
    fn detects_phrase() {
        assert!(may_request_explicit_content("portrait without clothes"));
    }

    #[test]
    fn ignores_sussex_substring_trap() {
        assert!(!may_request_explicit_content("sunset over Sussex"));
    }

    #[test]
    fn ignores_sextant_substring_trap() {
        assert!(!may_request_explicit_content("sextant on a ship's deck"));
    }

    #[test]
    fn ignores_sexagenarian_substring_trap() {
        assert!(!may_request_explicit_content("a sexagenarian chess player"));
    }

    #[test]
    fn ignores_empty_string() {
        assert!(!may_request_explicit_content(""));
    }

    #[tokio::test]
    async fn wordlist_hit_skips_classifier() {
        let called = Arc::new(AtomicBool::new(false));
        let called_for_classifier = Arc::clone(&called);

        let response = screen_image_prompt("portrait of a nude figure", move |_| async move {
            called_for_classifier.store(true, Ordering::SeqCst);
            Ok(false)
        })
        .await;

        assert!(response.may_be_explicit);
        assert!(!called.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn classifier_true_propagates() {
        let response = screen_image_prompt("portret bez ubrania", |_| async { Ok(true) }).await;

        assert!(response.may_be_explicit);
    }

    #[tokio::test]
    async fn classifier_false_propagates() {
        let response = screen_image_prompt("a red bicycle", |_| async { Ok(false) }).await;

        assert!(!response.may_be_explicit);
    }

    #[tokio::test]
    async fn classifier_error_falls_back_to_false() {
        let response = screen_image_prompt("portret bez ubrania", |_| async {
            Err(AppError::new("classifier_failed", "classifier failed"))
        })
        .await;

        assert!(!response.may_be_explicit);
    }
}
