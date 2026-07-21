use clap::{Parser, Subcommand};
use june_api::{ApiLimits, ApiState, ApiStateParams, AttestationInfo, ShareViewerInfo};
use june_config::{
    AppConfig, ModelPriceConfig, ModelProvider, OPENAI_API_KEY_PLACEHOLDER,
    VENICE_API_KEY_PLACEHOLDER, image_client_timeout_secs,
};
use june_providers::{
    JwksTokenVerifier, LocalDevOsAccountsClient, LocalDevTokenVerifier, LogIssueReportSink,
    LogP3aSink, MultiFormatDurationProbe, OsAccountsHttpClient, OsAccountsP3aSink,
    OsPlatformIssueReportSink, RoutingTranscriber, VeniceAgentChat, VeniceAugment, VeniceCleaner,
    VeniceGenerator, VeniceImageEditor, VeniceImageGenerator, VeniceModelCatalog,
    VeniceVideoProvider, client_with_timeout, default_client, issue_report_client, jwks_client,
};
use june_services::{
    AgentChatService, AgentChatServiceDeps, DictateService, DictateServiceDeps, ImageModelPrice,
    ImageService, ImageServiceDeps, IssueReportService, IssueReportServiceDeps,
    NoteGenerateService, NoteGenerateServiceDeps, NoteTranscribeService, NoteTranscribeServiceDeps,
    P3aReportService, P3aReportServiceDeps, PricingTable, VideoModelPrice, VideoService,
    VideoServiceDeps, WebAugmentService, WebAugmentServiceDeps,
};
use std::{collections::BTreeMap, net::SocketAddr, sync::Arc, time::Duration};
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
    let config = june_config::load()?;
    let address: SocketAddr = format!("{}:{}", config.server.host, config.server.port).parse()?;
    let http = default_client();
    let upstream_http = client_with_timeout(Duration::from_secs(
        config.server.request_timeout_secs.max(1),
    ));
    // Shared bounded client for every long-running metered inference call
    // (image generate/edit, note generation, agent chat): route timeout minus
    // the authorize + settlement budgets, so settlement always lands inside
    // the hold TTL.
    let metered_inference_http = client_with_timeout(Duration::from_secs(
        image_client_timeout_secs(config.server.request_timeout_secs),
    ));
    // os-platform attachment uploads can carry the full 300 MiB file budget.
    // Give that dedicated client the route's configured window instead of the
    // shared client's 60 seconds. The client deliberately has no retry layer:
    // file and Issue creation POSTs are not idempotent.
    let issue_report_http =
        issue_report_client(Duration::from_secs(config.server.request_timeout_secs))?;
    let pricing = load_pricing(&config, upstream_http.clone()).await;
    let clients = HttpClients {
        default: &http,
        upstream: &upstream_http,
        metered_inference: &metered_inference_http,
        issue_reports: &issue_report_http,
    };
    // Private sharing (JUN-308): optional — the API runs share-less until a
    // database is configured, so this cannot regress existing deployments.
    let share_store: Option<Arc<dyn june_domain::ShareStore>> =
        match config.share.database_url.trim() {
            "" => {
                tracing::info!("share store not configured; sharing endpoints disabled");
                None
            }
            _ if !config.local_dev.enabled && config.share.viewer_client_id.trim().is_empty() => {
                // The browser viewer signs recipients in with this OAuth client
                // id; without it, links created here would be unusable (the
                // viewer would redirect with an empty client_id). Fail closed to
                // 501 rather than mint dead links. Local dev seeds the token
                // directly and needs no client id.
                tracing::warn!(
                    "share database configured but JUNE__SHARE__VIEWER_CLIENT_ID is unset; \
                     sharing endpoints disabled to avoid creating unusable links"
                );
                None
            }
            database_url => match june_persistence::PgShareStore::connect(database_url).await {
                Ok(store) => {
                    tracing::info!("share store connected");
                    Some(Arc::new(store))
                }
                Err(error) => {
                    tracing::error!(
                        %error,
                        "share store connection failed; sharing endpoints disabled"
                    );
                    None
                }
            },
        };
    let app = build_router(&config, clients, pricing, share_store);
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "june-api listening");
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
            apply_private_route_price_floors(&mut pricing);
            tracing::info!(count, "loaded Venice model catalog");
        }
        Err(error) => {
            tracing::warn!(%error, "failed to load Venice model catalog; using configured model pricing only");
        }
    }
    pricing
}

/// The routed catalog currently reports the cheapest eligible endpoint, while
/// June settles by requested model ID. Floor routed text models at the most
/// expensive endpoint eligible for `preferred` so a Phala fallback cannot be
/// sold below cost. Remove this once settlement is authenticated per route.
fn apply_private_route_price_floors(pricing: &mut BTreeMap<String, ModelPriceConfig>) {
    for (model_id, input_floor, output_floor) in [
        ("openai/gpt-oss-120b", 150, 600),
        ("google/gemma-3-27b-it", 150, 460),
        ("z-ai/glm-5.2", 1_400, 4_400),
        ("qwen/qwen3.6-27b", 325, 3_250),
        ("moonshotai/kimi-k2.6", 1_090, 4_600),
    ] {
        let Some(model) = pricing.get_mut(model_id) else {
            continue;
        };
        model.input_credits_per_million_tokens = Some(
            model
                .input_credits_per_million_tokens
                .unwrap_or_default()
                .max(input_floor),
        );
        model.output_credits_per_million_tokens = Some(
            model
                .output_credits_per_million_tokens
                .unwrap_or_default()
                .max(output_floor),
        );
    }
}

// The dependency-injection composition root: it wires every provider and
// service into the router, so its length grows by a line or two with each new
// capability (image generation is the latest). Splitting it further would scatter
// the wiring without making it clearer.
#[allow(clippy::too_many_lines)]
fn build_router(
    config: &AppConfig,
    clients: HttpClients<'_>,
    mut pricing_config: BTreeMap<String, ModelPriceConfig>,
    share_store: Option<Arc<dyn june_domain::ShareStore>>,
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
    let os_accounts = build_os_accounts_client(config, clients.default);
    let transcriber: Arc<dyn june_domain::Transcriber> = Arc::new(RoutingTranscriber::from_config(
        clients.upstream.clone(),
        &config.upstreams,
        openai_model_ids,
    ));
    // Note generation and agent chat can now run long (streamed/kept-alive
    // responses), so their upstream window must leave the settlement budget
    // inside the authorization hold — the same route/client/hold math the
    // image path pins (see image_client_timeout_secs and
    // validate_long_inference_hold_ttl). The full-route `upstream` client
    // would let a 300-600s call reach `charge` after its hold expired.
    // Unmetered (user-Venice-key) requests have no hold to protect and keep
    // the full-route client — see AgentChatRequest::unmetered.
    let generator: Arc<dyn june_domain::Generator> = Arc::new(VeniceGenerator::from_config(
        clients.metered_inference.clone(),
        clients.upstream.clone(),
        &config.upstreams.venice,
    ));
    let cleaner: Arc<dyn june_domain::Cleaner> = Arc::new(VeniceCleaner::from_config(
        clients.upstream.clone(),
        &config.upstreams.venice,
    ));
    let agent_chat_completer: Arc<dyn june_domain::AgentChatCompleter> =
        Arc::new(VeniceAgentChat::from_config(
            clients.metered_inference.clone(),
            clients.upstream.clone(),
            &config.upstreams.venice,
        ));
    // One client backs both web traits (search + fetch) over the same Venice
    // credential and base URL.
    let web_augment = Arc::new(VeniceAugment::from_config(
        clients.upstream.clone(),
        &config.upstreams.venice,
    ));
    let duration_probe: Arc<dyn june_domain::AudioDurationProbe> =
        Arc::new(MultiFormatDurationProbe);
    let token_verifier = build_token_verifier(config);
    let issue_report_sink = build_issue_report_sink(config, clients.issue_reports);
    let p3a_sink = build_p3a_sink(config, clients.default);
    let issue_reports = Arc::new(IssueReportService::new(IssueReportServiceDeps {
        sink: issue_report_sink,
        chat_completer: agent_chat_completer.clone(),
        config: config.issue_reports.clone(),
    }));
    let p3a_reports = Arc::new(P3aReportService::new(P3aReportServiceDeps {
        sink: p3a_sink,
    }));

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
    let web = Arc::new(WebAugmentService::new(WebAugmentServiceDeps {
        os_accounts: os_accounts.clone(),
        searcher: web_augment.clone() as Arc<dyn june_domain::WebSearcher>,
        fetcher: web_augment as Arc<dyn june_domain::WebFetcher>,
        search_credits: config.os_accounts.web_search_credits,
        fetch_credits: config.os_accounts.web_fetch_credits,
        hold_ttl_seconds: config.os_accounts.authorize_hold_ttl_web_secs,
    }));
    let image = Arc::new(ImageService::new(ImageServiceDeps {
        os_accounts: os_accounts.clone(),
        generator: build_image_generator(
            clients.metered_inference,
            &config.upstreams.venice,
            Duration::from_secs(image_client_timeout_secs(
                config.server.request_timeout_secs,
            )),
        ),
        editor: build_image_editor(
            clients.metered_inference,
            &config.upstreams.venice,
            Duration::from_secs(image_client_timeout_secs(
                config.server.request_timeout_secs,
            )),
        ),
        pricing: config
            .image_pricing
            .iter()
            .map(|(model, credits)| (model.clone(), ImageModelPrice::venice(*credits)))
            .collect(),
        edit_pricing: config
            .image_edit_pricing
            .iter()
            .map(|(model, credits)| (model.clone(), ImageModelPrice::venice(*credits)))
            .collect(),
        default_edit_model: config.default_image_edit_model.clone(),
        // Edits are the same latency class as generation, so they reuse the
        // image hold TTL rather than adding a second knob.
        hold_ttl_seconds: config.os_accounts.authorize_hold_ttl_image_secs,
    }));
    let video = Arc::new(VideoService::new(VideoServiceDeps {
        os_accounts: os_accounts.clone(),
        provider: build_video_provider(
            clients.metered_inference,
            &config.upstreams.venice,
            Duration::from_secs(image_client_timeout_secs(
                config.server.request_timeout_secs,
            )),
            config.video_max_response_bytes,
        ),
        pricing: config
            .video_pricing
            .iter()
            .map(|(model, markup)| (model.clone(), VideoModelPrice::venice(*markup)))
            .collect(),
        animate_pricing: config
            .video_animate_pricing
            .iter()
            .map(|(model, markup)| (model.clone(), VideoModelPrice::venice(*markup)))
            .collect(),
        default_animate_model: config.default_video_animate_model.clone(),
        max_credits_per_request: config.video_max_credits_per_request,
        hold_ttl_seconds: config.os_accounts.authorize_hold_ttl_video_secs,
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

    let share = share_store.map(|store| {
        Arc::new(june_services::ShareService::new(
            june_services::ShareServiceDeps {
                store,
                identity: if config.local_dev.enabled {
                    Arc::new(june_providers::local_dev::LocalDevViewerIdentity::new(
                        config.local_dev.viewer_bearer_token.clone(),
                        config.local_dev.viewer_email.clone(),
                    )) as Arc<dyn june_domain::ViewerIdentity>
                } else {
                    Arc::new(
                        june_providers::viewer_identity::OsAccountsViewerIdentity::new(
                            clients.default.clone(),
                            &config.os_accounts.api_url,
                        ),
                    )
                },
                max_ciphertext_bytes: config.share.max_ciphertext_bytes,
            },
        ))
    });
    let share_viewer = ShareViewerInfo {
        accounts_url: if config.share.viewer_accounts_url.trim().is_empty() {
            config.os_accounts.iss.clone()
        } else {
            config.share.viewer_accounts_url.clone()
        },
        accounts_api_url: config.os_accounts.api_url.clone(),
        client_id: config.share.viewer_client_id.clone(),
    };

    let state = ApiState::new(ApiStateParams {
        pricing,
        computer_use: config.computer_use.clone(),
        local_dev_enabled: config.local_dev.enabled,
        token_verifier,
        note_transcribe,
        note_generate,
        agent_chat,
        dictate,
        web,
        image,
        video,
        issue_reports,
        p3a_reports,
        share,
        share_viewer,
        limits: ApiLimits {
            max_audio_bytes: config.server.max_audio_bytes,
            max_json_bytes: config.server.max_json_bytes,
            max_issue_report_bytes: config.server.max_issue_report_bytes,
            max_image_edit_bytes: config.server.max_image_edit_bytes,
            // Base64 inflates by 4/3; leave headroom for envelopes + JSON.
            max_share_body_bytes: config.share.max_ciphertext_bytes / 3 * 4 + 64 * 1024,
            max_agent_chat_bytes: config.server.max_agent_chat_bytes,
            max_agent_inflight_body_bytes: config.server.max_agent_inflight_body_bytes,
            max_agent_concurrent_requests_per_user: config
                .server
                .max_agent_concurrent_requests_per_user,
            request_timeout_secs: config.server.request_timeout_secs,
        },
        attestation: AttestationInfo {
            source_commit: config.attestation.source_commit.clone(),
            source_repo_url: config.attestation.source_repo_url.clone(),
            image_repo: config.attestation.image_repo.clone(),
            trust_center_url: config.attestation.trust_center_url.clone(),
        },
        browser_transports: config.browser_transports,
    });
    if config.share.viewer_only {
        june_api::viewer_router(state)
    } else {
        june_api::router(state)
    }
}

#[derive(Clone, Copy)]
struct HttpClients<'a> {
    default: &'a reqwest::Client,
    upstream: &'a reqwest::Client,
    metered_inference: &'a reqwest::Client,
    issue_reports: &'a reqwest::Client,
}

fn build_image_generator(
    upstream_http: &reqwest::Client,
    venice: &june_config::UpstreamConfig,
    leg_budget: Duration,
) -> Arc<dyn june_domain::ImageGenerator> {
    Arc::new(VeniceImageGenerator::from_config(
        upstream_http.clone(),
        venice,
        leg_budget,
    ))
}

fn build_image_editor(
    upstream_http: &reqwest::Client,
    venice: &june_config::UpstreamConfig,
    leg_budget: Duration,
) -> Arc<dyn june_domain::ImageEditor> {
    Arc::new(VeniceImageEditor::from_config(
        upstream_http.clone(),
        venice,
        leg_budget,
    ))
}

fn build_video_provider(
    upstream_http: &reqwest::Client,
    venice: &june_config::UpstreamConfig,
    call_timeout: Duration,
    max_response_bytes: u64,
) -> Arc<dyn june_domain::VideoProvider> {
    Arc::new(VeniceVideoProvider::from_config(
        upstream_http.clone(),
        venice,
        call_timeout,
        max_response_bytes,
    ))
}

fn build_os_accounts_client(
    config: &AppConfig,
    http: &reqwest::Client,
) -> Arc<dyn june_domain::OsAccountsClient> {
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

fn build_token_verifier(config: &AppConfig) -> Arc<dyn june_domain::TokenVerifier> {
    if config.local_dev.enabled {
        Arc::new(
            LocalDevTokenVerifier::new(
                config.local_dev.bearer_token.clone(),
                config.local_dev.user_id.clone(),
            )
            .with_viewer(
                config.local_dev.viewer_bearer_token.clone(),
                config.local_dev.viewer_user_id.clone(),
            ),
        )
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
) -> Arc<dyn june_domain::IssueReportSink> {
    if let Some(sink) = OsPlatformIssueReportSink::from_config(http.clone(), &config.issue_reports)
    {
        tracing::info!("issue reports will be filed as os-platform issues");
        Arc::new(sink)
    } else {
        tracing::info!("no issue report sink configured; reports will be logged only");
        Arc::new(LogIssueReportSink)
    }
}

fn build_p3a_sink(config: &AppConfig, http: &reqwest::Client) -> Arc<dyn june_domain::P3aSink> {
    if config.local_dev.enabled {
        tracing::info!("local dev mode enabled; P3A reports will be logged only");
        Arc::new(LogP3aSink)
    } else if let Some(sink) = OsAccountsP3aSink::from_config(http.clone(), &config.os_accounts) {
        tracing::info!("P3A reports will be forwarded to OS Accounts");
        Arc::new(sink)
    } else {
        tracing::warn!(
            "P3A ingest disabled: JUNE__OS_ACCOUNTS__P3A_INGEST_TOKEN not set; reports will be logged only"
        );
        Arc::new(LogP3aSink)
    }
}

fn init_tracing() {
    let _ = tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                "june=info,june_api=info,june_services=info,june_providers=info,tower_http=info"
                    .into()
            }),
        )
        .with(tracing_subscriber::fmt::layer().json())
        .try_init();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_catalog_prices_cover_every_preferred_fallback() {
        let mut pricing = AppConfig::default().pricing;
        let template = pricing["kimi-k2-6"].clone();
        for model_id in [
            "openai/gpt-oss-120b",
            "google/gemma-3-27b-it",
            "z-ai/glm-5.2",
            "qwen/qwen3.6-27b",
            "moonshotai/kimi-k2.6",
        ] {
            let mut canonical = template.clone();
            canonical.input_credits_per_million_tokens = Some(1);
            canonical.output_credits_per_million_tokens = Some(1);
            pricing.insert(model_id.to_string(), canonical);
        }

        apply_private_route_price_floors(&mut pricing);

        for (model_id, input, output) in [
            ("openai/gpt-oss-120b", 150, 600),
            ("google/gemma-3-27b-it", 150, 460),
            ("z-ai/glm-5.2", 1_400, 4_400),
            ("qwen/qwen3.6-27b", 325, 3_250),
            ("moonshotai/kimi-k2.6", 1_090, 4_600),
        ] {
            let canonical = &pricing[model_id];
            assert_eq!(
                canonical.input_credits_per_million_tokens,
                Some(input),
                "{model_id} input price"
            );
            assert_eq!(
                canonical.output_credits_per_million_tokens,
                Some(output),
                "{model_id} output price"
            );
        }
    }
}
