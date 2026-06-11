use clap::{Parser, Subcommand};
use scribe_api::{ApiLimits, ApiState, ApiStateParams, AttestationInfo};
use scribe_config::{AppConfig, ModelPriceConfig, ModelProvider};
use scribe_providers::{
    JwksTokenVerifier, LogIssueReportSink, MultiFormatDurationProbe, OsAccountsHttpClient,
    OsPlatformIssueReportSink, RoutingTranscriber, VeniceAgentChat, VeniceCleaner, VeniceGenerator,
    VeniceModelCatalog, WebhookIssueReportSink, default_client, jwks_client,
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
    pricing_config: BTreeMap<String, ModelPriceConfig>,
) -> axum::Router {
    let openai_model_ids = pricing_config
        .iter()
        .filter(|(_, model)| model.provider == ModelProvider::Openai)
        .map(|(model_id, _)| model_id.clone())
        .collect::<Vec<_>>();

    let pricing = Arc::new(PricingTable::new(pricing_config));
    let os_accounts: Arc<dyn scribe_domain::OsAccountsClient> = Arc::new(
        OsAccountsHttpClient::from_config(http.clone(), &config.os_accounts),
    );
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
    let token_verifier: Arc<dyn scribe_domain::TokenVerifier> = Arc::new(
        JwksTokenVerifier::from_config(jwks_client(), &config.os_accounts),
    );
    let issue_reports: Arc<dyn scribe_domain::IssueReportSink> = if let Some(sink) =
        OsPlatformIssueReportSink::from_config(http.clone(), &config.issue_reports)
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
    };

    let flat_estimate_credits = config.os_accounts.flat_estimate_credits;

    let note_transcribe = Arc::new(NoteTranscribeService::new(NoteTranscribeServiceDeps {
        pricing: pricing.clone(),
        os_accounts: os_accounts.clone(),
        transcriber: transcriber.clone(),
        duration_probe: duration_probe.clone(),
        hold_ttl_seconds: config.os_accounts.authorize_hold_ttl_note_transcribe_secs,
        flat_estimate_credits,
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
