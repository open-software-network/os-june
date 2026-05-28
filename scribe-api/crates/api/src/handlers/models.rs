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
        price_unit: model.unit.as_str().to_string(),
        price_description: price_description(model),
        credits_per_million_seconds: model.credits_per_million_seconds,
        input_credits_per_million_tokens: model.input_credits_per_million_tokens,
        output_credits_per_million_tokens: model.output_credits_per_million_tokens,
    }
}

fn price_description(model: &ModelPriceConfig) -> String {
    match model.unit {
        scribe_config::PriceUnit::Seconds => format!(
            "{} per 1M seconds",
            format_credits_as_usd(model.credits_per_million_seconds.unwrap_or_default())
        ),
        scribe_config::PriceUnit::Tokens => format!(
            "{} input / {} output per 1M tokens",
            format_credits_as_usd(model.input_credits_per_million_tokens.unwrap_or_default()),
            format_credits_as_usd(model.output_credits_per_million_tokens.unwrap_or_default())
        ),
    }
}

fn format_credits_as_usd(credits: u64) -> String {
    format!("${:.2}", credits as f64 / 1_000.0)
}
