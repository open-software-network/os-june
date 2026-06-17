use clap::{Parser, Subcommand};
use scribe_api::{ApiLimits, ApiState, ApiStateParams, AttestationInfo};
use scribe_config::{
    AppConfig, ModelPriceConfig, ModelProvider, OPENAI_API_KEY_PLACEHOLDER,
    VENICE_API_KEY_PLACEHOLDER,
};
use scribe_providers::{
    JwksTokenVerifier, LocalDevOsAccountsClient, LocalDevTokenVerifier, LogIssueReportSink,
    MultiFormatDurationProbe, OsAccountsHttpClient, OsPlatformIssueReportSink, RoutingTranscriber,
    VeniceAgentChat, VeniceCleaner, VeniceGenerator, VeniceModelCatalog, WebhookIssueReportSink,
    default_client, jwks_client,
};
use scribe_services::{
    AgentChatService, AgentChatServiceDeps, DictateService, DictateServiceDeps,
    NoteGenerateService, NoteGenerateServiceDeps, NoteTranscribeService, NoteTranscribeServiceDeps,
    PricingTable,
};
use std::{collections::BTreeMap, net::SocketAddr, sync::Arc};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Debug, Parser)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    Serve,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    init_tracing();
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => serve().await,
    }
}

async fn serve() -> anyhow::Result<()> {
    let config = scribe_config::load()?;
    let address: SocketAddr = format!("{}:{}", config.server.host, config.server.port).parse()?;
    let http = default_client();
    let pricing = load_pricing(&config, http.clone()).await;
    let app = build_router(&config, &http, pricing);
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "scribe-api listening");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn load_pricing(
    config: &AppConfig,
    http: reqwest::Client,
) -> BTreeMap<String, ModelPriceConfig> {
    let mut pricing = config.pricing.clone();
    if !provider_is_configured(config, ModelProvider::Venice) {
        tracing::info!("Venice API key is not configured; skipping Venice model catalog");
        return pricing;
    }
    match VeniceModelCatalog::from_config(http, &config.upstreams.venice)
        .priced_models()
        .await
    {
        Ok(models) => {
            let count = models.len();
            pricing.extend(models);
            tracing::info!(count, "loaded Venice model catalog");
        }
        Err(error) => {
            tracing::warn!(%error, "failed to load Venice model catalog; using configured model pricing only");
        }
    }
    pricing
}

fn build_router(
    config: &AppConfig,
    http: &reqwest::Client,
    mut pricing_config: BTreeMap<String, ModelPriceConfig>,
) -> axum::Router {
    if config.local_dev.enabled {
        pricing_config = filter_unconfigured_provider_models(config, pricing_config);
    }

    let openai_model_ids = pricing_config
        .iter()
        .filter(|(_, model)| model.provider == ModelProvider::Openai)
        .map(|(model_id, _)| model_id.clone())
        .collect::<Vec<_>>();

    let pricing = Arc::new(PricingTable::new(pricing_config));
    let os_accounts = build_os_accounts_client(config, http);
    let transcriber: Arc<dyn scribe_domain::Transcriber> = Arc::new(
        RoutingTranscriber::from_config(http.clone(), &config.upstreams, openai_model_ids),
    );
    let generator: Arc<dyn scribe_domain::Generator> = Arc::new(VeniceGenerator::from_config(
        http.clone(),
        &config.upstreams.venice,
    ));
    let cleaner: Arc<dyn scribe_domain::Cleaner> = Arc::new(VeniceCleaner::from_config(
        http.clone(),
        &config.upstreams.venice,
    ));
    let agent_chat_completer: Arc<dyn scribe_domain::AgentChatCompleter> = Arc::new(
        VeniceAgentChat::from_config(http.clone(), &config.upstreams.venice),
    );
    let duration_probe: Arc<dyn scribe_domain::AudioDurationProbe> =
        Arc::new(MultiFormatDurationProbe);
    let token_verifier = build_token_verifier(config);
    let issue_reports = build_issue_report_sink(config, http);

    let flat_estimate_credits = config.os_accounts.flat_estimate_credits;

    let note_transcribe = Arc::new(NoteTranscribeService::new(NoteTranscribeServiceDeps {
        pricing: pricing.clone(),
        os_accounts: os_accounts.clone(),
        transcriber: transcriber.clone(),
        duration_probe: duration_probe.clone(),
        hold_ttl_seconds: config.os_accounts.authorize_hold_ttl_note_transcribe_secs,
        flat_estimate_credits,
        preview_max_audio_seconds: config.os_accounts.note_transcribe_preview_max_audio_secs,
    }));
    let note_generate = Arc::new(NoteGenerateService::new(NoteGenerateServiceDeps {
        pricing: pricing.clone(),
        os_accounts: os_accounts.clone(),
        generator,
        hold_ttl_seconds: config.os_accounts.authorize_hold_ttl_note_generate_secs,
        flat_estimate_credits,
    }));
    let agent_chat = Arc::new(AgentChatService::new(AgentChatServiceDeps {
        pricing: pricing.clone(),
        os_accounts: os_accounts.clone(),
        chat_completer: agent_chat_completer,
        hold_ttl_seconds: config.os_accounts.authorize_hold_ttl_note_generate_secs,
        flat_estimate_credits,
    }));
    let dictate = Arc::new(DictateService::new(DictateServiceDeps {
        pricing: pricing.clone(),
        os_accounts,
        transcriber,
        cleaner,
        duration_probe,
        transcribe_hold_ttl_seconds: config
            .os_accounts
            .authorize_hold_ttl_dictate_transcribe_secs,
        cleanup_hold_ttl_seconds: config.os_accounts.authorize_hold_ttl_dictate_cleanup_secs,
        flat_estimate_credits,
    }));

    let state = ApiState::new(ApiStateParams {
        pricing,
        token_verifier,
        note_transcribe,
        note_generate,
        agent_chat,
        dictate,
        issue_reports,
        limits: ApiLimits {
            max_audio_bytes: config.server.max_audio_bytes,
            max_json_bytes: config.server.max_json_bytes,
            request_timeout_secs: config.server.request_timeout_secs,
        },
        attestation: AttestationInfo {
            source_commit: config.attestation.source_commit.clone(),
            source_repo_url: config.attestation.source_repo_url.clone(),
            image_repo: config.attestation.image_repo.clone(),
            trust_center_url: config.attestation.trust_center_url.clone(),
        },
    });
    scribe_api::router(state)
}

fn build_os_accounts_client(
    config: &AppConfig,
    http: &reqwest::Client,
) -> Arc<dyn scribe_domain::OsAccountsClient> {
    if config.local_dev.enabled {
        tracing::warn!("local dev mode enabled; OS Accounts metering is disabled");
        Arc::new(LocalDevOsAccountsClient)
    } else {
        Arc::new(OsAccountsHttpClient::from_config(
            http.clone(),
            &config.os_accounts,
        ))
    }
}

fn build_token_verifier(config: &AppConfig) -> Arc<dyn scribe_domain::TokenVerifier> {
    if config.local_dev.enabled {
        Arc::new(LocalDevTokenVerifier::new(
            config.local_dev.bearer_token.clone(),
            config.local_dev.user_id.clone(),
        ))
    } else {
        Arc::new(JwksTokenVerifier::from_config(
            jwks_client(),
            &config.os_accounts,
        ))
    }
}

fn filter_unconfigured_provider_models(
    config: &AppConfig,
    pricing_config: BTreeMap<String, ModelPriceConfig>,
) -> BTreeMap<String, ModelPriceConfig> {
    let original_len = pricing_config.len();
    let filtered = pricing_config
        .into_iter()
        .filter(|(_, model)| provider_is_configured(config, model.provider))
        .collect::<BTreeMap<_, _>>();
    let removed = original_len.saturating_sub(filtered.len());
    if removed > 0 {
        tracing::info!(
            removed,
            remaining = filtered.len(),
            "filtered models whose provider API keys are not configured"
        );
    }
    filtered
}

fn provider_is_configured(config: &AppConfig, provider: ModelProvider) -> bool {
    match provider {
        ModelProvider::Openai => {
            provider_key_is_configured(&config.upstreams.openai.api_key, OPENAI_API_KEY_PLACEHOLDER)
        }
        ModelProvider::Venice => {
            provider_key_is_configured(&config.upstreams.venice.api_key, VENICE_API_KEY_PLACEHOLDER)
        }
    }
}

fn provider_key_is_configured(api_key: &str, placeholder: &str) -> bool {
    let api_key = api_key.trim();
    !api_key.is_empty() && api_key != placeholder
}

fn build_issue_report_sink(
    config: &AppConfig,
    http: &reqwest::Client,
) -> Arc<dyn scribe_domain::IssueReportSink> {
    if let Some(sink) = OsPlatformIssueReportSink::from_config(http.clone(), &config.issue_reports)
    {
        tracing::info!("issue reports will be filed as os-platform issues");
        Arc::new(sink)
    } else if let Some(sink) =
        WebhookIssueReportSink::from_config(http.clone(), &config.issue_reports)
    {
        Arc::new(sink)
    } else {
        tracing::info!("no issue report sink configured; reports will be logged only");
        Arc::new(LogIssueReportSink)
    }
}

fn init_tracing() {
    let _ = tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                "scribe=info,scribe_api=info,scribe_services=info,scribe_providers=info,tower_http=info".into()
            }),
        )
        .with(tracing_subscriber::fmt::layer().json())
        .try_init();
}
