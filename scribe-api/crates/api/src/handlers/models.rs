use crate::{envelope::ApiResponse, error::ApiError, state::ApiState};
use axum::{
    Json,
    extract::{Query, State},
};
use scribe_config::ModelPriceConfig;
use scribe_domain::ModelKind;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub(crate) struct ModelsQuery {
    #[serde(rename = "type")]
    model_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDto {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub model_type: String,
    pub description: Option<String>,
    pub privacy: Option<String>,
    pub pricing: Option<serde_json::Value>,
    pub context_tokens: Option<i64>,
    pub traits: Vec<String>,
    pub capabilities: Vec<String>,
    pub price_unit: String,
    pub price_description: String,
    pub credits_per_million_seconds: Option<u64>,
    pub input_credits_per_million_tokens: Option<u64>,
    pub output_credits_per_million_tokens: Option<u64>,
}

pub(crate) async fn list_models(
    State(state): State<ApiState>,
    Query(query): Query<ModelsQuery>,
) -> Result<Json<ApiResponse<Vec<ModelDto>>>, ApiError> {
    let kind = query
        .model_type
        .as_deref()
        .map(parse_model_kind)
        .transpose()?;
    let models = state
        .pricing()
        .priced_models(kind)
        .into_iter()
        .map(|(id, model)| to_dto(id, model))
        .collect();
    Ok(Json(ApiResponse::ok(models)))
}

fn parse_model_kind(value: &str) -> Result<ModelKind, ApiError> {
    match value {
        "asr" => Ok(ModelKind::Asr),
        "text" => Ok(ModelKind::Text),
        _ => Err(ApiError::unprocessable("model_type_invalid")),
    }
}

fn to_dto(id: &str, model: &ModelPriceConfig) -> ModelDto {
    ModelDto {
        provider: model.provider.as_str().to_string(),
        id: id.to_string(),
        name: model.display_name.clone(),
        model_type: model.model_type.as_str().to_string(),
        description: model.description.clone(),
        privacy: model.privacy.clone(),
        pricing: model.pricing.clone(),
        context_tokens: model.context_tokens,
        traits: model.traits.clone(),
        capabilities: model.capabilities.clone(),
        price_unit: model.unit.as_str().to_string(),
        price_description: price_description(model),
        credits_per_million_seconds: model.credits_per_million_seconds,
        input_credits_per_million_tokens: model.input_credits_per_million_tokens,
        output_credits_per_million_tokens: model.output_credits_per_million_tokens,
    }
}

fn price_description(model: &ModelPriceConfig) -> String {
    if let Some(display) = model
        .pricing
        .as_ref()
        .and_then(|pricing| pricing.get("display"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return display.to_string();
    }
    match model.unit {
        scribe_config::PriceUnit::Seconds => format!(
            "{} per second audio",
            model.credits_per_million_seconds.map_or_else(
                || "$0.00".to_string(),
                |credits| format_credits_as_usd_per_unit(credits, 1_000_000)
            )
        ),
        scribe_config::PriceUnit::Tokens => format!(
            "{} input / {} output per 1M tokens",
            format_credits_as_usd(model.input_credits_per_million_tokens.unwrap_or_default()),
            format_credits_as_usd(model.output_credits_per_million_tokens.unwrap_or_default())
        ),
    }
}

fn format_credits_as_usd(credits: u64) -> String {
    let cents = (u128::from(credits) + 5) / 10;
    format!("${}.{:02}", cents / 100, cents % 100)
}

fn format_credits_as_usd_per_unit(credits: u64, units: u64) -> String {
    if units == 0 {
        return "$0.00".to_string();
    }
    let micro_usd = (u128::from(credits) * 1_000 + (u128::from(units) / 2)) / u128::from(units);
    if micro_usd >= 1_000_000 {
        let cents = (micro_usd + 5_000) / 10_000;
        format!("${}.{:02}", cents / 100, cents % 100)
    } else {
        let decimals = format!("{micro_usd:06}");
        format!("$0.{}", decimals.trim_end_matches('0'))
    }
}
