use june_config::{ModelPriceConfig, ModelProvider, ModelType, PriceUnit};
use june_domain::{Credits, ModelKind, TokenUsage};
use std::collections::BTreeMap;
use thiserror::Error;

const RATE_SCALE: u64 = 1_000_000;

#[derive(Clone, Debug)]
pub struct PricingTable {
    models: BTreeMap<String, ModelPriceConfig>,
}

impl PricingTable {
    pub fn new(models: BTreeMap<String, ModelPriceConfig>) -> Self {
        Self { models }
    }

    pub fn price_audio_seconds(
        &self,
        model_id: &str,
        seconds: u64,
    ) -> Result<Credits, PricingError> {
        let model = self.models.get(model_id).ok_or(PricingError::NotPriced)?;
        if model.unit != PriceUnit::Seconds {
            return Err(PricingError::WrongUnit);
        }
        let rate = model
            .credits_per_million_seconds
            .ok_or(PricingError::MissingRate)?;
        Self::price_scaled([(seconds, rate)])
    }

    pub fn price_token_usage(
        &self,
        model_id: &str,
        usage: TokenUsage,
    ) -> Result<Credits, PricingError> {
        let model = self.models.get(model_id).ok_or(PricingError::NotPriced)?;
        if model.unit != PriceUnit::Tokens {
            return Err(PricingError::WrongUnit);
        }
        let input_rate = model
            .input_credits_per_million_tokens
            .ok_or(PricingError::MissingRate)?;
        let output_rate = model
            .output_credits_per_million_tokens
            .ok_or(PricingError::MissingRate)?;
        Self::price_scaled([
            (usage.prompt_tokens, input_rate),
            (usage.completion_tokens, output_rate),
        ])
    }

    pub fn has_model(&self, model_id: &str) -> bool {
        self.models.contains_key(model_id)
    }

    pub fn is_venice_model(&self, model_id: &str) -> bool {
        self.models
            .get(model_id)
            .is_some_and(|model| model.provider == ModelProvider::Venice)
    }

    pub fn ensure_model_kind(&self, model_id: &str, kind: ModelKind) -> Result<(), PricingError> {
        let model = self.models.get(model_id).ok_or(PricingError::NotPriced)?;
        if !model_type_matches_kind(model.model_type, kind) {
            return Err(PricingError::WrongUnit);
        }
        match kind {
            ModelKind::Asr => {
                if model.unit != PriceUnit::Seconds {
                    return Err(PricingError::WrongUnit);
                }
                model
                    .credits_per_million_seconds
                    .ok_or(PricingError::MissingRate)?;
            }
            ModelKind::Text => {
                if model.unit != PriceUnit::Tokens {
                    return Err(PricingError::WrongUnit);
                }
                model
                    .input_credits_per_million_tokens
                    .ok_or(PricingError::MissingRate)?;
                model
                    .output_credits_per_million_tokens
                    .ok_or(PricingError::MissingRate)?;
            }
        }
        Ok(())
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &ModelPriceConfig)> {
        self.models.iter()
    }

    pub fn priced_models(&self, kind: Option<ModelKind>) -> Vec<(&String, &ModelPriceConfig)> {
        self.models
            .iter()
            .filter(|(_, model)| {
                kind.is_none_or(|kind| model_type_matches_kind(model.model_type, kind))
            })
            .collect()
    }

    fn price_scaled<const N: usize>(components: [(u64, u64); N]) -> Result<Credits, PricingError> {
        let numerator = components
            .into_iter()
            .try_fold(0_u64, |sum, (units, rate)| {
                let subtotal = units.checked_mul(rate).ok_or(PricingError::Overflow)?;
                sum.checked_add(subtotal).ok_or(PricingError::Overflow)
            })?;
        let credits = if numerator == 0 {
            0
        } else {
            numerator
                .checked_add(RATE_SCALE - 1)
                .ok_or(PricingError::Overflow)?
                / RATE_SCALE
        };
        Ok(Credits(credits))
    }
}

fn model_type_matches_kind(model_type: ModelType, kind: ModelKind) -> bool {
    matches!(
        (model_type, kind),
        (ModelType::Asr, ModelKind::Asr) | (ModelType::Text, ModelKind::Text)
    )
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum PricingError {
    #[error("model_not_priced")]
    NotPriced,
    #[error("price_unit_mismatch")]
    WrongUnit,
    #[error("missing_price_rate")]
    MissingRate,
    #[error("price_overflow")]
    Overflow,
}

#[cfg(test)]
mod tests {
    use super::{PricingError, PricingTable};
    use june_config::{ModelPriceConfig, ModelProvider, ModelType, PriceUnit};
    use june_domain::{ModelKind, TokenUsage};
    use pretty_assertions::assert_eq;
    use std::collections::BTreeMap;

    fn models<const N: usize>(
        values: [(&str, PriceUnit, u64, u64, ModelType); N],
    ) -> BTreeMap<String, ModelPriceConfig> {
        values
            .into_iter()
            .map(|(id, unit, input_rate, output_rate, model_type)| {
                (
                    id.to_string(),
                    ModelPriceConfig {
                        unit,
                        credits_per_million_seconds: (unit == PriceUnit::Seconds)
                            .then_some(input_rate),
                        input_credits_per_million_tokens: (unit == PriceUnit::Tokens)
                            .then_some(input_rate),
                        output_credits_per_million_tokens: (unit == PriceUnit::Tokens)
                            .then_some(output_rate),
                        provider: ModelProvider::Openai,
                        model_type,
                        display_name: id.to_string(),
                        description: None,
                        privacy: None,
                        pricing: None,
                        context_tokens: None,
                        traits: Vec::new(),
                        capabilities: Vec::new(),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn prices_known_models() {
        let table = PricingTable::new(models([
            ("priced-asr", PriceUnit::Seconds, 250_000, 0, ModelType::Asr),
            ("priced-text", PriceUnit::Tokens, 70, 300, ModelType::Text),
        ]));

        assert_eq!(
            table
                .price_audio_seconds("priced-asr", 9)
                .map(|credits| credits.0),
            Ok(3)
        );
        assert_eq!(
            table
                .price_token_usage(
                    "priced-text",
                    TokenUsage {
                        prompt_tokens: 1_600,
                        completion_tokens: 50,
                    },
                )
                .map(|credits| credits.0),
            Ok(1)
        );
    }

    #[test]
    fn rejects_unknown_models() {
        let table = PricingTable::new(BTreeMap::new());
        assert_eq!(
            table.price_audio_seconds("missing", 1),
            Err(PricingError::NotPriced)
        );
    }

    #[test]
    fn catches_price_overflow() {
        let table = PricingTable::new(models([(
            "too-large",
            PriceUnit::Tokens,
            u64::MAX,
            u64::MAX,
            ModelType::Text,
        )]));
        assert_eq!(
            table.price_token_usage(
                "too-large",
                TokenUsage {
                    prompt_tokens: 2,
                    completion_tokens: 0,
                },
            ),
            Err(PricingError::Overflow)
        );
    }

    #[test]
    fn rejects_wrong_unit_for_audio_seconds() {
        let table = PricingTable::new(models([(
            "text-model",
            PriceUnit::Tokens,
            1,
            1,
            ModelType::Text,
        )]));
        assert_eq!(
            table.price_audio_seconds("text-model", 1),
            Err(PricingError::WrongUnit)
        );
    }

    #[test]
    fn rejects_wrong_unit_for_tokens() {
        let table = PricingTable::new(models([(
            "asr-model",
            PriceUnit::Seconds,
            1,
            0,
            ModelType::Asr,
        )]));
        assert_eq!(
            table.price_token_usage(
                "asr-model",
                TokenUsage {
                    prompt_tokens: 1,
                    completion_tokens: 0,
                },
            ),
            Err(PricingError::WrongUnit)
        );
    }

    #[test]
    fn ensures_model_kind_matches_pricing_metadata() {
        let table = PricingTable::new(models([
            ("asr-model", PriceUnit::Seconds, 1, 0, ModelType::Asr),
            ("text-model", PriceUnit::Tokens, 1, 1, ModelType::Text),
        ]));

        assert_eq!(table.ensure_model_kind("asr-model", ModelKind::Asr), Ok(()));
        assert_eq!(
            table.ensure_model_kind("text-model", ModelKind::Text),
            Ok(())
        );
        assert_eq!(
            table.ensure_model_kind("asr-model", ModelKind::Text),
            Err(PricingError::WrongUnit)
        );
        assert_eq!(
            table.ensure_model_kind("missing", ModelKind::Text),
            Err(PricingError::NotPriced)
        );
    }

    #[test]
    fn has_model_reports_known_ids() {
        let table = PricingTable::new(models([(
            "known",
            PriceUnit::Seconds,
            1,
            0,
            ModelType::Asr,
        )]));
        assert!(table.has_model("known"));
        assert!(!table.has_model("unknown"));
    }

    #[test]
    fn identifies_venice_models_from_pricing_metadata() {
        let mut models = models([
            ("openai-asr", PriceUnit::Seconds, 1, 0, ModelType::Asr),
            ("venice-text", PriceUnit::Tokens, 1, 1, ModelType::Text),
        ]);
        models
            .get_mut("venice-text")
            .expect("model exists")
            .provider = ModelProvider::Venice;
        let table = PricingTable::new(models);

        assert!(!table.is_venice_model("openai-asr"));
        assert!(table.is_venice_model("venice-text"));
        assert!(!table.is_venice_model("missing"));
    }
}
