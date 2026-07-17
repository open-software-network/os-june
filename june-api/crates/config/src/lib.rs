use figment::{
    Figment,
    providers::{Env, Format, Serialized, Toml},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fmt::{self, Debug},
};
use thiserror::Error;
use url::Url;

const REDACTED: &str = "<redacted>";
pub const LOCAL_DEV_BEARER_TOKEN_PLACEHOLDER: &str = "local-dev-token";
pub const OPENAI_API_KEY_PLACEHOLDER: &str = "sk_REPLACE_ME";
pub const VENICE_API_KEY_PLACEHOLDER: &str = "VENICE_API_KEY_REPLACE_ME";
pub const IMAGE_EDIT_SOURCE_MAX_BYTES: usize = 50 * 1024 * 1024;
pub const DEFAULT_REQUEST_TIMEOUT_SECS: u64 = 600;
/// Matches os-platform's general attachment cap. June API is the authenticated
/// report boundary, so it must accept the same video size the downstream file
/// API accepts instead of silently imposing the platform's former 10 MiB cap.
pub const ISSUE_REPORT_ATTACHMENT_MAX_BYTES: usize = 300 * 1024 * 1024;
/// Multipart framing and the report's text fields need a small amount of room
/// beyond one maximum-sized attachment. This remains a total request cap, so
/// many attachments cannot multiply the per-file allowance into unbounded RAM.
pub const DEFAULT_MAX_ISSUE_REPORT_BYTES: usize = ISSUE_REPORT_ATTACHMENT_MAX_BYTES + (1024 * 1024);
/// OS Accounts rejects `/authorize` holds outside its deployed cap as
/// `invalid_ttl` (envelope code 4201). This mirrors `MAX_HOLD_TTL_SECONDS`
/// in the os-accounts repo (`api/crates/services/src/grants.rs`), which is
/// being raised to 900 in a coordinated deploy alongside June API. Keep the
/// two values in lockstep: a value above the deployed os-accounts cap is
/// rejected at runtime as `invalid_ttl` (4201).
pub const OS_ACCOUNTS_MAX_HOLD_TTL_SECS: u64 = 900;
/// Budget reserved between the image client call ending and the hold
/// expiring, sized to the WORST-CASE charge path, not a nominal grace:
/// settling can spend `CHARGE_RETRY_ATTEMPTS` HTTP calls at the 60-second
/// client timeout plus backoff (~121s) before giving up. Keep in sync with
/// `CHARGE_RETRY_ATTEMPTS` / `CHARGE_RETRY_BACKOFF` (`os_accounts.rs`) and the
/// default HTTP client timeout (`http.rs`) in june-providers — a contract test
/// there pins this margin above that budget.
pub const IMAGE_SETTLEMENT_TIMEOUT_MARGIN_SECS: u64 = 150;
/// Budget reserved before generation for the OS Accounts authorize call —
/// it runs on the same 60-second default HTTP client (pinned by the same
/// june-providers contract test as the settlement budget). The route's
/// `TimeoutLayer` bounds authorize + generate + settle together, so the
/// image client window must leave room for both metering legs.
pub const OS_ACCOUNTS_AUTHORIZE_TIMEOUT_BUDGET_SECS: u64 = 60;
pub const DEFAULT_IMAGE_CLIENT_TIMEOUT_SECS: u64 = DEFAULT_REQUEST_TIMEOUT_SECS
    - OS_ACCOUNTS_AUTHORIZE_TIMEOUT_BUDGET_SECS
    - IMAGE_SETTLEMENT_TIMEOUT_MARGIN_SECS;
// 10s, not 30: the diagnosis runs inline before delivery, so its timeout is
// user-facing "Sending" time. Typical completions land in 2-6s; anything
// slower delivers undiagnosed rather than holding the dialog hostage.
pub const DEFAULT_ISSUE_REPORT_DIAGNOSIS_TIMEOUT_SECS: u64 = 10;
/// Nobody files more than a handful of legitimate reports an hour; the cap
/// only bounds June-funded diagnosis calls, never report delivery.
pub const DEFAULT_ISSUE_REPORT_DIAGNOSIS_MAX_PER_USER_PER_HOUR: u64 = 6;
/// The hold is minted after authorize returns and must cover generation
/// plus settlement: 390 + 150 = 540, inside the platform cap. Anchoring on the
/// route timeout instead produced 630, past the former 600-second cap, and every
/// image authorize was rejected `invalid_ttl` (4201) in production.
pub const DEFAULT_IMAGE_HOLD_TTL_SECS: u64 =
    DEFAULT_IMAGE_CLIENT_TIMEOUT_SECS + IMAGE_SETTLEMENT_TIMEOUT_MARGIN_SECS;
// The full route budget must fit its three legs.
const _: () = assert!(
    OS_ACCOUNTS_AUTHORIZE_TIMEOUT_BUDGET_SECS
        + DEFAULT_IMAGE_CLIENT_TIMEOUT_SECS
        + IMAGE_SETTLEMENT_TIMEOUT_MARGIN_SECS
        <= DEFAULT_REQUEST_TIMEOUT_SECS
);
// Compile-time regression pin: a default past the cap fails every image
// authorize as invalid_ttl (4201) in production.
const _: () = assert!(DEFAULT_IMAGE_HOLD_TTL_SECS <= OS_ACCOUNTS_MAX_HOLD_TTL_SECS);
const IMAGE_EDIT_JSON_OVERHEAD_BYTES: usize = 16 * 1024;
pub const DEFAULT_MAX_IMAGE_EDIT_BYTES: usize =
    base64_encoded_len(IMAGE_EDIT_SOURCE_MAX_BYTES) + IMAGE_EDIT_JSON_OVERHEAD_BYTES;
/// Dedicated request-body cap for `/v1/chat/completions`. Sized to the
/// desktop provider proxy's chat body cap
/// (`JUNE_PROVIDER_PROXY_MAX_CHAT_BODY_BYTES`, 12 MiB, in
/// `src-tauri/src/hermes_bridge.rs`) so an in-window agent chat request the
/// proxy forwards is never rejected here by a stricter outer gate before
/// `validate_agent_chat_body` can size-check it (JUN-336). 12 MiB is the
/// byte-image of the 6M-char semantic cap (`MAX_AGENT_TOTAL_STRING_CHARS`) at
/// ~2 bytes/char, sized for a 1M-token context window. This is only an abuse
/// ceiling above every valid agent chat request; semantic size rejection stays
/// in `validate_agent_chat_body`. Keep this in sync with the proxy constant
/// across the src-tauri / june-api workspace boundary.
pub const DEFAULT_MAX_AGENT_CHAT_BYTES: usize = 12 * 1024 * 1024;
/// Global cap on the total in-flight request-body bytes buffered across the
/// large-body agent routes, so concurrent authenticated requests cannot exhaust
/// the shared TEE (JUN-336). Conservative default; tune against real traffic.
pub const DEFAULT_MAX_AGENT_INFLIGHT_BODY_BYTES: usize = 1024 * 1024 * 1024;
/// Max concurrent large-body agent requests a single user may have in flight
/// before June API load-sheds with 503 (JUN-336).
pub const DEFAULT_MAX_AGENT_CONCURRENT_REQUESTS_PER_USER: usize = 8;

// --- Video generation (ADR 0015) ---------------------------------------------
//
// Video is an async job billed at completion: the hold is minted at
// `/v1/video/generate` and must stay valid until the completing status poll
// charges. Unlike image (a single synchronous request), the hold has to cover
// the whole job lifetime — queue, the Venice run, then the settlement charge.
// The desktop polls for 900s, so video reserves 750s for the job and 150s for
// settlement, matching that full client poll window (ADR 0015 Decision 2).
/// Worst-case seconds a supported video job may take from queue to a completing
/// poll. The first-cut allowlist/durations are picked to finish within this.
pub const DEFAULT_VIDEO_JOB_MAX_SECS: u64 = 750;
/// Budget reserved after the job completes for the settlement charge path,
/// sized like the image settlement margin (worst-case OS Accounts charge
/// retries at the default HTTP timeout plus backoff).
pub const VIDEO_SETTLEMENT_TIMEOUT_MARGIN_SECS: u64 = IMAGE_SETTLEMENT_TIMEOUT_MARGIN_SECS;
/// Video hold TTL: the job budget plus the settlement margin. Pinned at the OS
/// Accounts platform cap; the job budget is what gets capped to keep it there.
pub const DEFAULT_VIDEO_HOLD_TTL_SECS: u64 =
    DEFAULT_VIDEO_JOB_MAX_SECS + VIDEO_SETTLEMENT_TIMEOUT_MARGIN_SECS;
/// Desktop `/video` polls for 360 attempts at 2.5s each.
const VIDEO_CLIENT_POLL_WINDOW_SECS: u64 = 900;
/// Defensive per-request credit ceiling: Venice caps a video at $10/request; at
/// the 2.0x default markup that is 20000 credits (`$1 = 1000 credits`). A quote
/// above this is rejected before authorize so a catalog change cannot authorize
/// an unbounded hold (ADR 0015 Decision 1).
pub const DEFAULT_VIDEO_MAX_CREDITS_PER_REQUEST: u64 = 20_000;
/// Maximum raw video body June API will buffer from Venice retrieve.
pub const DEFAULT_VIDEO_MAX_RESPONSE_BYTES: u64 = 100 * 1024 * 1024;
// The hold must fit the platform cap; the job must fit inside the hold.
const _: () = assert!(DEFAULT_VIDEO_HOLD_TTL_SECS <= OS_ACCOUNTS_MAX_HOLD_TTL_SECS);
const _: () = assert!(DEFAULT_VIDEO_HOLD_TTL_SECS >= VIDEO_CLIENT_POLL_WINDOW_SECS);
const _: () = assert!(
    DEFAULT_VIDEO_JOB_MAX_SECS + VIDEO_SETTLEMENT_TIMEOUT_MARGIN_SECS
        <= DEFAULT_VIDEO_HOLD_TTL_SECS
);

const fn base64_encoded_len(byte_count: usize) -> usize {
    byte_count.div_ceil(3) * 4
}

pub const fn image_client_timeout_secs(route_timeout_secs: u64) -> u64 {
    // Saturating with a 1s floor: validated configs can never get here with a
    // route timeout at or below the budgets (validate_image_timeout_margin
    // rejects them), but directly-built states (tests) bypass validation and
    // a clamped window beats an underflow panic.
    let window = route_timeout_secs
        .saturating_sub(OS_ACCOUNTS_AUTHORIZE_TIMEOUT_BUDGET_SECS)
        .saturating_sub(IMAGE_SETTLEMENT_TIMEOUT_MARGIN_SECS);
    if window == 0 { 1 } else { window }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct AppConfig {
    pub server: ServerConfig,
    #[serde(default)]
    pub local_dev: LocalDevConfig,
    pub os_accounts: OsAccountsConfig,
    pub upstreams: UpstreamsConfig,
    pub attestation: AttestationConfig,
    #[serde(default)]
    pub issue_reports: IssueReportsConfig,
    /// Private sharing (JUN-308). Sharing endpoints return 501
    /// `sharing_unavailable` until `database_url` is configured, so the
    /// feature cannot regress deployments that predate it.
    #[serde(default)]
    pub share: ShareConfig,
    /// June companion relay persistence and optional opaque APNs wake hints.
    #[serde(default)]
    pub companion: CompanionConfig,
    pub pricing: BTreeMap<String, ModelPriceConfig>,
    /// Flat credits charged per generated image, keyed by image model id. Kept
    /// separate from `pricing` (the text/ASR catalog) so image models never leak
    /// into the served model pickers. A model absent here is rejected at the
    /// `/image/generate` boundary (`model_not_priced`), so the settings picker
    /// must only offer models listed here. `$1 = 1000 credits`; values are the
    /// Venice per-image cost with margin (e.g. SD3.5 costs about $0.01,
    /// charged 20).
    #[serde(default = "default_image_pricing")]
    pub image_pricing: BTreeMap<String, u64>,
    /// Flat credits charged per EDITED image, keyed by edit model id. Editing is
    /// a separate Venice model catalog from generation (default
    /// `firered-image-edit`), so it has its own price map. A model absent here is
    /// rejected at the `/image/edit` boundary (`model_not_priced`). Same units as
    /// `image_pricing`: Venice per-image cost with margin, `$1 = 1000 credits`.
    #[serde(default = "default_image_edit_pricing")]
    pub image_edit_pricing: BTreeMap<String, u64>,
    /// The edit model used when a request names none — the image MCP never sends
    /// one, so this on-server default governs every edit. Must be a key in
    /// `image_edit_pricing`, or edits fail `model_not_priced`.
    #[serde(default = "default_image_edit_model")]
    pub default_image_edit_model: String,
    /// Markup (fixed-point thousandths, `2000` = 2.0x) applied to the live Venice
    /// quote for each text-to-video model, keyed by model id. Video is
    /// quote-priced, not flat-priced: `credits = ceil(quote_usd * markup_millis)`
    /// (ADR 0015 Decision 1). A model absent here is rejected `model_not_priced`
    /// at the `/video/generate` boundary before the wallet or Venice is touched,
    /// so this doubles as the allowlist. `$1 = 1000 credits`.
    #[serde(default = "default_video_pricing")]
    pub video_pricing: BTreeMap<String, u32>,
    /// Markup per IMAGE-to-video (animate) model, keyed by model id. Image-to-video
    /// is a separate Venice catalog from text-to-video (mirroring
    /// `image_edit_pricing`), so it has its own allowlist. Same units as
    /// `video_pricing`.
    #[serde(default = "default_video_animate_pricing")]
    pub video_animate_pricing: BTreeMap<String, u32>,
    /// The image-to-video model used when an animate request names none. Must be
    /// a key in `video_animate_pricing`, or animate fails `model_not_priced`.
    #[serde(default = "default_video_animate_model")]
    pub default_video_animate_model: String,
    /// Defensive per-request credit ceiling for a quoted video. A computed price
    /// above this is rejected `price_overflow` before authorize, bounding a
    /// catalog change from authorizing an unbounded hold.
    #[serde(default = "default_video_max_credits_per_request")]
    pub video_max_credits_per_request: u64,
    /// Maximum raw `video/mp4` bytes June API will retrieve from Venice before
    /// rejecting the job. Keeps one oversized result from exhausting memory and
    /// is enforced before charge settlement.
    #[serde(default = "default_video_max_response_bytes")]
    pub video_max_response_bytes: u64,
}

impl Debug for AppConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AppConfig")
            .field("server", &self.server)
            .field("local_dev", &self.local_dev)
            .field("os_accounts", &self.os_accounts)
            .field("upstreams", &self.upstreams)
            .field("attestation", &self.attestation)
            .field("issue_reports", &self.issue_reports)
            .field("share", &RedactedShare(&self.share))
            .field("companion", &RedactedCompanion(&self.companion))
            .field("pricing", &self.pricing)
            .field("image_pricing", &self.image_pricing)
            .field("image_edit_pricing", &self.image_edit_pricing)
            .field("default_image_edit_model", &self.default_image_edit_model)
            .field("video_pricing", &self.video_pricing)
            .field("video_animate_pricing", &self.video_animate_pricing)
            .field(
                "default_video_animate_model",
                &self.default_video_animate_model,
            )
            .field(
                "video_max_credits_per_request",
                &self.video_max_credits_per_request,
            )
            .field("video_max_response_bytes", &self.video_max_response_bytes)
            .finish()
    }
}

/// Where user-submitted issue reports get forwarded. The destination defaults
/// to the June bug reports project in os-platform; only the bot API key is
/// environment specific. Without that key, reports land in structured logs only.
#[derive(Clone, Deserialize, Serialize)]
pub struct IssueReportsConfig {
    /// Base URL of the os-platform (fellow) API.
    #[serde(default = "default_issue_report_api_url")]
    pub os_platform_api_url: String,
    /// os-platform API key of the reporting bot user — that user
    /// must be a member of the target Org/Project. Redacted Debug.
    /// `JUNE__ISSUE_REPORTS__OS_PLATFORM_API_KEY`.
    #[serde(default)]
    pub os_platform_api_key: String,
    /// Target Org handle (or opaque `org_…` id).
    #[serde(default = "default_issue_report_org")]
    pub os_platform_org: String,
    /// Target Project handle (or opaque `prj_…` id).
    #[serde(default = "default_issue_report_project")]
    pub os_platform_project: String,
    /// Label slug attached to every report Issue.
    #[serde(default = "default_issue_report_label")]
    pub os_platform_label: String,
    /// Reward asset symbol for the zero-reward Issue (e.g. "POINTS").
    /// Issues are bounties under the hood, and creation fails when neither
    /// the Project nor the Org has a default reward asset — naming one here
    /// sidesteps that. Empty omits the field and relies on the defaults.
    #[serde(default = "default_issue_report_reward_asset")]
    pub os_platform_reward_asset: String,
    /// Optional model id used by June API to diagnose issue reports before
    /// delivery. `None` preserves direct delivery with no upstream model call.
    #[serde(default)]
    pub diagnosis_model: Option<String>,
    /// Wall-clock budget for the internal diagnosis call.
    #[serde(default = "default_issue_report_diagnosis_timeout_secs")]
    pub diagnosis_timeout_secs: u64,
    /// Per-user hourly cap on June-funded diagnosis calls. The cap only skips
    /// the diagnosis; report delivery itself is never limited.
    #[serde(default = "default_issue_report_diagnosis_max_per_user_per_hour")]
    pub diagnosis_max_per_user_per_hour: u64,
}

fn default_issue_report_api_url() -> String {
    "https://app.opensoftware.co/api".to_string()
}

fn default_issue_report_org() -> String {
    "june".to_string()
}

fn default_issue_report_project() -> String {
    "bug-reports".to_string()
}

fn default_issue_report_label() -> String {
    "bug".to_string()
}

fn default_issue_report_reward_asset() -> String {
    "POINTS".to_string()
}

fn default_issue_report_diagnosis_timeout_secs() -> u64 {
    DEFAULT_ISSUE_REPORT_DIAGNOSIS_TIMEOUT_SECS
}

fn default_issue_report_diagnosis_max_per_user_per_hour() -> u64 {
    DEFAULT_ISSUE_REPORT_DIAGNOSIS_MAX_PER_USER_PER_HOUR
}

impl Default for IssueReportsConfig {
    fn default() -> Self {
        Self {
            os_platform_api_url: default_issue_report_api_url(),
            os_platform_api_key: String::new(),
            os_platform_org: default_issue_report_org(),
            os_platform_project: default_issue_report_project(),
            os_platform_label: default_issue_report_label(),
            os_platform_reward_asset: default_issue_report_reward_asset(),
            diagnosis_model: None,
            diagnosis_timeout_secs: default_issue_report_diagnosis_timeout_secs(),
            diagnosis_max_per_user_per_hour: default_issue_report_diagnosis_max_per_user_per_hour(),
        }
    }
}

impl Debug for IssueReportsConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IssueReportsConfig")
            .field("os_platform_api_url", &self.os_platform_api_url)
            .field(
                "os_platform_api_key",
                if self.os_platform_api_key.is_empty() {
                    &"<unset>"
                } else {
                    &REDACTED
                },
            )
            .field("os_platform_org", &self.os_platform_org)
            .field("os_platform_project", &self.os_platform_project)
            .field("os_platform_label", &self.os_platform_label)
            .field("os_platform_reward_asset", &self.os_platform_reward_asset)
            .field("diagnosis_model", &self.diagnosis_model)
            .field("diagnosis_timeout_secs", &self.diagnosis_timeout_secs)
            .field(
                "diagnosis_max_per_user_per_hour",
                &self.diagnosis_max_per_user_per_hour,
            )
            .finish()
    }
}

/// Public facts the `/verify` attestation page reports. Nothing here is a
/// secret; all fields have working defaults so local builds need no setup.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AttestationConfig {
    /// Full git commit the running image was built from. Stamped into the
    /// image env by the Docker build (`ARG GIT_SHA`); empty for local builds.
    #[serde(default)]
    pub source_commit: String,
    pub source_repo_url: String,
    pub image_repo: String,
    pub trust_center_url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub request_timeout_secs: u64,
    pub max_audio_bytes: usize,
    pub max_json_bytes: usize,
    /// Total multipart body cap for `/v1/issue-reports`.
    pub max_issue_report_bytes: usize,
    /// JSON body cap for `/v1/image/edit`. It is sized for a 50 MiB source
    /// image after base64 expansion plus fixed request overhead.
    pub max_image_edit_bytes: usize,
    /// JSON body cap for `/v1/chat/completions`, sized to the desktop proxy's
    /// 12 MiB chat body cap so an in-window agent chat request is not rejected by
    /// a stricter outer gate before semantic validation (JUN-336).
    pub max_agent_chat_bytes: usize,
    /// Global in-flight request-body budget for the large-body agent routes.
    pub max_agent_inflight_body_bytes: usize,
    /// Per-user concurrent request cap for the large-body agent routes.
    pub max_agent_concurrent_requests_per_user: usize,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct LocalDevConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_local_dev_bearer_token")]
    pub bearer_token: String,
    #[serde(default = "default_local_dev_user_id")]
    pub user_id: String,
    /// Second local identity so recipient-side share flows (JUN-308) can be
    /// exercised without real OS Accounts. Empty disables the second token.
    #[serde(default)]
    pub viewer_bearer_token: String,
    #[serde(default = "default_local_dev_viewer_user_id")]
    pub viewer_user_id: String,
    #[serde(default = "default_local_dev_viewer_email")]
    pub viewer_email: String,
}

fn default_local_dev_viewer_user_id() -> String {
    "usr_local_dev_viewer".to_string()
}

fn default_local_dev_viewer_email() -> String {
    "viewer@localdev.june".to_string()
}

fn default_local_dev_bearer_token() -> String {
    LOCAL_DEV_BEARER_TOKEN_PLACEHOLDER.to_string()
}

fn default_local_dev_user_id() -> String {
    "usr_local_dev".to_string()
}

impl Default for LocalDevConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bearer_token: default_local_dev_bearer_token(),
            user_id: default_local_dev_user_id(),
            viewer_bearer_token: String::new(),
            viewer_user_id: default_local_dev_viewer_user_id(),
            viewer_email: default_local_dev_viewer_email(),
        }
    }
}

impl Debug for LocalDevConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalDevConfig")
            .field("enabled", &self.enabled)
            .field(
                "bearer_token",
                if self.bearer_token.is_empty() {
                    &"<unset>"
                } else {
                    &REDACTED
                },
            )
            .field("user_id", &self.user_id)
            .field(
                "viewer_bearer_token",
                if self.viewer_bearer_token.is_empty() {
                    &"<unset>"
                } else {
                    &REDACTED
                },
            )
            .field("viewer_user_id", &self.viewer_user_id)
            .field("viewer_email", &self.viewer_email)
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ShareConfig {
    /// Postgres URL for the share store. Empty disables sharing.
    #[serde(default)]
    pub database_url: String,
    /// OS Accounts site origin the viewer sends recipients to for sign-in
    /// (e.g. `https://accounts.opensoftware.co`). Empty falls back to the
    /// canonical issuer from `os_accounts.iss`.
    #[serde(default)]
    pub viewer_accounts_url: String,
    /// Public OAuth client id registered for the browser viewer.
    #[serde(default)]
    pub viewer_client_id: String,
    /// Restrict this process to the read-only browser viewer surface. This is
    /// used by the isolated june.link CVM so its ingress and certificate
    /// lifecycle cannot expose or disrupt the primary June API deployment.
    #[serde(default)]
    pub viewer_only: bool,
    /// Max accepted ciphertext, in bytes.
    #[serde(default = "default_share_max_ciphertext_bytes")]
    pub max_ciphertext_bytes: usize,
}

#[derive(Clone, Deserialize, Serialize, Default)]
#[serde(deny_unknown_fields)]
pub struct CompanionConfig {
    /// Dedicated Postgres store for linked-device trust metadata. Empty
    /// disables companion endpoints outside local development.
    #[serde(default)]
    pub database_url: String,
    #[serde(default)]
    pub apns_team_id: String,
    #[serde(default)]
    pub apns_key_id: String,
    /// Apple .p8 signing key, injected as a secret environment value.
    #[serde(default)]
    pub apns_private_key_pem: String,
    #[serde(default)]
    pub apns_bundle_id: String,
    /// False targets Apple's sandbox endpoint; true targets production APNs.
    #[serde(default)]
    pub apns_production: bool,
}

struct RedactedCompanion<'a>(&'a CompanionConfig);

impl Debug for RedactedCompanion<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CompanionConfig")
            .field(
                "database_url",
                &if self.0.database_url.is_empty() {
                    "<unset>"
                } else {
                    REDACTED
                },
            )
            .field("apns_team_id", &self.0.apns_team_id)
            .field("apns_key_id", &self.0.apns_key_id)
            .field(
                "apns_private_key_pem",
                &if self.0.apns_private_key_pem.is_empty() {
                    "<unset>"
                } else {
                    REDACTED
                },
            )
            .field("apns_bundle_id", &self.0.apns_bundle_id)
            .field("apns_production", &self.0.apns_production)
            .finish()
    }
}

impl Default for ShareConfig {
    // Hand-written so the derived Default can't diverge from the serde field
    // defaults. `load()` seeds `AppConfig::default()` as the figment base, so a
    // `usize::default()` zero here would be *present* in the merged config and
    // shadow `default_share_max_ciphertext_bytes` (which only applies when the
    // field is absent), capping every share at 0 bytes on a deployment that
    // sets only the share envs.
    fn default() -> Self {
        Self {
            database_url: String::new(),
            viewer_accounts_url: String::new(),
            viewer_client_id: String::new(),
            viewer_only: false,
            max_ciphertext_bytes: default_share_max_ciphertext_bytes(),
        }
    }
}

fn default_share_max_ciphertext_bytes() -> usize {
    10 * 1024 * 1024
}

/// Debug view of `ShareConfig` that never prints the database URL (it embeds
/// credentials); everything else in the section is public.
struct RedactedShare<'a>(&'a ShareConfig);

impl Debug for RedactedShare<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ShareConfig")
            .field(
                "database_url",
                &if self.0.database_url.is_empty() {
                    "<unset>"
                } else {
                    "<redacted>"
                },
            )
            .field("viewer_accounts_url", &self.0.viewer_accounts_url)
            .field("viewer_client_id", &self.0.viewer_client_id)
            .field("viewer_only", &self.0.viewer_only)
            .field("max_ciphertext_bytes", &self.0.max_ciphertext_bytes)
            .finish()
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct OsAccountsConfig {
    pub api_url: String,
    pub app_api_key: String,
    /// Optional service token for anonymous P3A aggregate ingestion into OS
    /// Accounts. When unset (empty), P3A ingest is disabled: reports fall back
    /// to the log-only sink while startup and all other ingest proceed
    /// normally.
    #[serde(default)]
    pub p3a_ingest_token: String,
    pub iss: String,
    pub aud: String,
    pub jwks_refresh_secs: u64,
    pub jwks_miss_min_backoff_secs: u64,
    pub authorize_hold_ttl_note_transcribe_secs: u64,
    pub authorize_hold_ttl_note_generate_secs: u64,
    pub authorize_hold_ttl_dictate_transcribe_secs: u64,
    pub authorize_hold_ttl_dictate_cleanup_secs: u64,
    /// Maximum audio duration accepted by no-charge live preview requests.
    /// Desktop chunks are shorter; this server cap prevents arbitrary-length
    /// preview transcription if a client replays the public endpoint.
    pub note_transcribe_preview_max_audio_secs: u64,
    /// Skip per-request estimation entirely and authorize this many credits
    /// for every metered action. Trades a bigger Hold (and thus a tighter
    /// max concurrency per user) for not needing to probe audio duration or
    /// pre-count tokens. Set via `JUNE__OS_ACCOUNTS__FLAT_ESTIMATE_CREDITS`.
    pub flat_estimate_credits: u64,
    /// Flat credits charged per Venice web search (`/v1/web/search`). Venice
    /// bills roughly $0.01 (about 10 credits) per request; the surplus covers
    /// overhead. The authorize estimate and the settled charge are both this
    /// amount, since the upstream call is flat priced.
    pub web_search_credits: u64,
    /// Flat credits charged per Venice web fetch (`/v1/web/fetch`). Same ~$0.01
    /// upstream cost as search.
    pub web_fetch_credits: u64,
    /// Hold TTL for the metered web search and web fetch actions.
    pub authorize_hold_ttl_web_secs: u64,
    /// Hold TTL for the metered image generation action.
    pub authorize_hold_ttl_image_secs: u64,
    /// Hold TTL for the metered video generation/animation actions. Video is an
    /// async job billed at completion, so the hold must cover the whole job
    /// lifetime (queue -> completing poll -> charge), not a single request. Sized
    /// to the job budget plus the settlement margin and capped at the platform
    /// max (ADR 0015 Decision 2).
    #[serde(default = "default_video_hold_ttl_secs")]
    pub authorize_hold_ttl_video_secs: u64,
}

impl Debug for OsAccountsConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OsAccountsConfig")
            .field("api_url", &self.api_url)
            .field("app_api_key", &REDACTED)
            .field(
                "p3a_ingest_token",
                if self.p3a_ingest_token.trim().is_empty() {
                    &"<unset>"
                } else {
                    &REDACTED
                },
            )
            .field("iss", &self.iss)
            .field("aud", &self.aud)
            .field("jwks_refresh_secs", &self.jwks_refresh_secs)
            .field(
                "jwks_miss_min_backoff_secs",
                &self.jwks_miss_min_backoff_secs,
            )
            .field(
                "authorize_hold_ttl_note_transcribe_secs",
                &self.authorize_hold_ttl_note_transcribe_secs,
            )
            .field(
                "authorize_hold_ttl_note_generate_secs",
                &self.authorize_hold_ttl_note_generate_secs,
            )
            .field(
                "authorize_hold_ttl_dictate_transcribe_secs",
                &self.authorize_hold_ttl_dictate_transcribe_secs,
            )
            .field(
                "authorize_hold_ttl_dictate_cleanup_secs",
                &self.authorize_hold_ttl_dictate_cleanup_secs,
            )
            .field(
                "note_transcribe_preview_max_audio_secs",
                &self.note_transcribe_preview_max_audio_secs,
            )
            .field("flat_estimate_credits", &self.flat_estimate_credits)
            .field("web_search_credits", &self.web_search_credits)
            .field("web_fetch_credits", &self.web_fetch_credits)
            .field(
                "authorize_hold_ttl_web_secs",
                &self.authorize_hold_ttl_web_secs,
            )
            .field(
                "authorize_hold_ttl_image_secs",
                &self.authorize_hold_ttl_image_secs,
            )
            .field(
                "authorize_hold_ttl_video_secs",
                &self.authorize_hold_ttl_video_secs,
            )
            .finish()
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct UpstreamsConfig {
    pub openai: UpstreamConfig,
    pub venice: UpstreamConfig,
}

impl Debug for UpstreamsConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UpstreamsConfig")
            .field("openai", &self.openai)
            .field("venice", &self.venice)
            .finish()
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct UpstreamConfig {
    #[serde(default)]
    pub api_key: String,
    pub base_url: String,
    /// Base URL for requests authenticated with a user-supplied (BYOK) key.
    /// `base_url` may point at a June-managed gateway that only accepts
    /// June's own service key; a user's key must be presented to the provider
    /// that issued it. `None` falls back to the provider's public API URL.
    #[serde(default)]
    pub byok_base_url: Option<String>,
}

impl Debug for UpstreamConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UpstreamConfig")
            .field("api_key", &REDACTED)
            .field("base_url", &self.base_url)
            .field("byok_base_url", &self.byok_base_url)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelProvider {
    Openai,
    Venice,
}

impl ModelProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Venice => "venice",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelType {
    Asr,
    Text,
}

impl ModelType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Asr => "asr",
            Self::Text => "text",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PriceUnit {
    Seconds,
    Tokens,
}

impl PriceUnit {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Seconds => "seconds",
            Self::Tokens => "tokens",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ModelPriceConfig {
    pub unit: PriceUnit,
    #[serde(default)]
    pub credits_per_million_seconds: Option<u64>,
    #[serde(default)]
    pub input_credits_per_million_tokens: Option<u64>,
    #[serde(default)]
    pub output_credits_per_million_tokens: Option<u64>,
    pub provider: ModelProvider,
    pub model_type: ModelType,
    pub display_name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub privacy: Option<String>,
    #[serde(default)]
    pub pricing: Option<serde_json::Value>,
    #[serde(default)]
    pub context_tokens: Option<i64>,
    #[serde(default)]
    pub traits: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Clone, Copy)]
struct TextModelFallback {
    id: &'static str,
    display_name: &'static str,
    input_credits_per_million_tokens: u64,
    output_credits_per_million_tokens: u64,
    context_tokens: i64,
    capabilities: &'static [&'static str],
}

/// Built-in pricing fallback, used only when the live Venice catalog can't be
/// reached at startup so metered charges still settle. The catalog carries the
/// authoritative numbers and extends over this on every boot. Split out of
/// `AppConfig::default` to keep that constructor under the line limit.
///
/// Usage credit prices pass through upstream cost without a June markup.
/// `$1 = 1000 credits`.
fn default_pricing() -> BTreeMap<String, ModelPriceConfig> {
    let mut pricing = BTreeMap::new();
    pricing.insert(
        "gpt-4o-mini-transcribe".to_string(),
        ModelPriceConfig {
            unit: PriceUnit::Seconds,
            // OpenAI lists ASR prices per MINUTE ($0.003/min for mini);
            // converted per second at upstream cost.
            credits_per_million_seconds: Some(50_000),
            input_credits_per_million_tokens: None,
            output_credits_per_million_tokens: None,
            provider: ModelProvider::Openai,
            model_type: ModelType::Asr,
            display_name: "GPT-4o mini transcribe".to_string(),
            description: Some("Fast OpenAI speech-to-text model.".to_string()),
            privacy: Some("anonymized".to_string()),
            // Matches what `models.rs::price_description` derives from the
            // credit price above (raw metadata only — the API recomputes it).
            pricing: Some(serde_json::json!({ "display": "$0.00005 per second audio" })),
            context_tokens: Some(16_000),
            traits: vec!["prompt".to_string()],
            capabilities: Vec::new(),
        },
    );
    pricing.insert(
        "nvidia/parakeet-tdt-0.6b-v3".to_string(),
        ModelPriceConfig {
            unit: PriceUnit::Seconds,
            credits_per_million_seconds: Some(100_000),
            input_credits_per_million_tokens: None,
            output_credits_per_million_tokens: None,
            provider: ModelProvider::Venice,
            model_type: ModelType::Asr,
            display_name: "Parakeet TDT 0.6B v3".to_string(),
            description: None,
            privacy: Some("private".to_string()),
            pricing: None,
            context_tokens: None,
            traits: Vec::new(),
            capabilities: Vec::new(),
        },
    );
    // Credit prices for June's legacy text-model ids. os-api's live catalog
    // uses canonical ids, so those entries extend rather than replace these
    // aliases. Price each alias for the most expensive enabled private route
    // so a Phala fallback cannot cost more than June charges. Keep GLM 5.2 in
    // sync with DEFAULT_GENERATION_MODEL in the Tauri providers module.
    for model in [
        TextModelFallback {
            id: "zai-org-glm-5-2",
            display_name: "GLM 5.2",
            input_credits_per_million_tokens: 1_400,
            output_credits_per_million_tokens: 4_400,
            context_tokens: 200_000,
            capabilities: &[
                "supportsFunctionCalling",
                "supportsReasoning",
                "supportsReasoningEffort",
                "supportsResponseSchema",
                "supportsWebSearch",
            ],
        },
        TextModelFallback {
            id: "kimi-k2-6",
            display_name: "Kimi K2.6",
            input_credits_per_million_tokens: 1_090,
            output_credits_per_million_tokens: 4_600,
            context_tokens: 256_000,
            // Kimi K2.6 is natively multimodal (Venice `supportsVision`), so it
            // is the image-input fallback the frontend switches to when an image
            // is attached to a non-vision model. Declare vision here too so that
            // fallback still resolves when the live Venice catalog can't be
            // reached at boot and only these built-in defaults are available.
            capabilities: &[
                "supportsFunctionCalling",
                "supportsVision",
                "supportsMultipleImages",
            ],
        },
        TextModelFallback {
            id: "zai-org-glm-5-1",
            display_name: "GLM 5.1",
            input_credits_per_million_tokens: 1_400,
            output_credits_per_million_tokens: 4_400,
            context_tokens: 200_000,
            capabilities: &[
                "supportsFunctionCalling",
                "supportsReasoning",
                "supportsReasoningEffort",
                "supportsResponseSchema",
                "supportsWebSearch",
            ],
        },
        TextModelFallback {
            id: "zai-org-glm-5",
            display_name: "GLM 5",
            input_credits_per_million_tokens: 1_400,
            output_credits_per_million_tokens: 4_400,
            context_tokens: 198_000,
            capabilities: &["supportsFunctionCalling"],
        },
    ] {
        pricing.insert(model.id.to_string(), text_model_config(model));
    }
    pricing
}

/// Per-image credit price for the curated Venice image models June offers. Keep
/// the ids in sync with `IMAGE_MODELS` in the frontend (`src/lib/image-models.ts`)
/// and `DEFAULT_IMAGE_MODEL` in the Tauri providers module — every id here must
/// be a current Venice image model (verified against the models list), or
/// generation fails `image_generation_rejected`. Values are the Venice per-image
/// cost with a ~2x margin (mirroring the flat web-tool pricing). Models that
/// price by resolution use their default 1K tier because June does not expose a
/// higher-resolution image request control yet. `$1 = 1000 credits`.
fn default_image_pricing() -> BTreeMap<String, u64> {
    BTreeMap::from([
        ("venice-sd35".to_string(), 20),
        ("grok-imagine-image-quality".to_string(), 160),
        ("krea-2-turbo".to_string(), 80),
        ("flux-2-pro".to_string(), 60),
        ("flux-2-max".to_string(), 180),
        ("gpt-image-2".to_string(), 540),
        ("gpt-image-1-5".to_string(), 520),
        ("hunyuan-image-v3".to_string(), 180),
        ("ideogram-v4".to_string(), 120),
        ("imagineart-1.5-pro".to_string(), 120),
        ("krea-v2-large".to_string(), 140),
        ("krea-v2-medium".to_string(), 80),
        ("luma-uni-1".to_string(), 100),
        ("luma-uni-1-max".to_string(), 240),
        ("nano-banana-2".to_string(), 200),
        ("nano-banana-pro".to_string(), 360),
        ("nano-banana-2-lite".to_string(), 120),
        ("recraft-v4".to_string(), 100),
        ("recraft-v4-pro".to_string(), 580),
        ("seedream-v4".to_string(), 100),
        ("seedream-v5-lite".to_string(), 100),
        ("qwen-image-2".to_string(), 100),
        ("qwen-image-2-pro".to_string(), 200),
        ("wan-2-7-text-to-image".to_string(), 75),
        ("wan-2-7-pro-text-to-image".to_string(), 188),
        ("grok-imagine-image".to_string(), 80),
        ("lustify-sdxl".to_string(), 20),
        ("lustify-v7".to_string(), 20),
        ("lustify-v8".to_string(), 20),
        ("qwen-image".to_string(), 60),
        ("wai-Illustrious".to_string(), 20),
        ("z-image-turbo".to_string(), 20),
        ("chroma".to_string(), 20),
        ("bria-bg-remover".to_string(), 60),
    ])
}

/// Flat per-edit prices, keyed by Venice edit model id. Edit models are a
/// separate catalog from generation. `firered-image-edit` costs ~$0.04 -> 80 at
/// the same ~2x margin as generation (`$1 = 1000 credits`). Additional edit
/// models get added here (with their own verified price) when offered.
fn default_image_edit_pricing() -> BTreeMap<String, u64> {
    BTreeMap::from([("firered-image-edit".to_string(), 80)])
}

/// The default Venice edit model — cheapest of the edit catalog, and the one
/// every MCP-driven edit uses (the tool never names a model).
fn default_image_edit_model() -> String {
    "firered-image-edit".to_string()
}

/// Curated text-to-video allowlist with per-model markups (`2000` = 2.0x, the
/// image margin). Every id must be a current Venice text-to-video model, and its
/// worst-case run at the supported durations must fit `DEFAULT_VIDEO_JOB_MAX_SECS`
/// so the hold covers the whole job (ADR 0015). `credits = ceil(quote_usd * markup)`.
///
/// First-cut curation: every model here must accept the desktop fast-path's fixed
/// default duration/resolution (5s / 720p) that the proxy injects when the client
/// names none, so a `/video` shot or an MCP `generate_video` call never queues an
/// invalid Venice combination. `ltx-2-fast` is deliberately excluded — it only
/// accepts >=6s and >=1080p, so no global default serves it; per-model
/// duration/resolution selection (which re-admits it) is a follow-up.
fn default_video_pricing() -> BTreeMap<String, u32> {
    // The curated text-to-video allowlist: every id June's picker offers must be
    // here or it is rejected `model_not_priced` at `/video/generate`. Markup is a
    // uniform 2.0x on the live Venice quote (ADR 0015 Decision 1) — the per-clip
    // credit price still comes from the quote, so pricier models cost more
    // without a per-model markup table. Mirrors `VIDEO_MODELS` in
    // src/lib/video-models.ts and `KNOWN_VIDEO_MODELS` in the desktop providers
    // module; keep the three in sync. Kept to three curated `private`-tier models
    // (fast default / photorealistic / higher-detail). The original Seedance 2.0
    // default was delisted from Venice's live catalog (quote tolerated it, queue
    // rejected it with a 400), so it is deliberately absent.
    BTreeMap::from([
        ("wan-2.2-a14b-text-to-video".to_string(), 2000),
        ("grok-imagine-text-to-video-private".to_string(), 2000),
        ("ltx-2-19b-full-text-to-video".to_string(), 2000),
    ])
}

/// Curated image-to-video (animate) allowlist — a separate Venice catalog from
/// text-to-video, keyed by model id with the same markup units.
fn default_video_animate_pricing() -> BTreeMap<String, u32> {
    BTreeMap::from([("wan-2.6-image-to-video".to_string(), 2000)])
}

/// The default image-to-video model — the one every MCP-driven animate uses
/// (the tool never names a model). Must be a key in `video_animate_pricing`.
fn default_video_animate_model() -> String {
    "wan-2.6-image-to-video".to_string()
}

fn default_video_max_credits_per_request() -> u64 {
    DEFAULT_VIDEO_MAX_CREDITS_PER_REQUEST
}

fn default_video_max_response_bytes() -> u64 {
    DEFAULT_VIDEO_MAX_RESPONSE_BYTES
}

fn default_video_hold_ttl_secs() -> u64 {
    DEFAULT_VIDEO_HOLD_TTL_SECS
}

fn text_model_config(model: TextModelFallback) -> ModelPriceConfig {
    ModelPriceConfig {
        unit: PriceUnit::Tokens,
        credits_per_million_seconds: None,
        input_credits_per_million_tokens: Some(model.input_credits_per_million_tokens),
        output_credits_per_million_tokens: Some(model.output_credits_per_million_tokens),
        provider: ModelProvider::Venice,
        model_type: ModelType::Text,
        display_name: model.display_name.to_string(),
        description: None,
        privacy: Some("private".to_string()),
        pricing: None,
        context_tokens: Some(model.context_tokens),
        traits: Vec::new(),
        capabilities: model
            .capabilities
            .iter()
            .map(|capability| (*capability).to_string())
            .collect(),
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            server: ServerConfig {
                host: "127.0.0.1".to_string(),
                port: 8080,
                request_timeout_secs: DEFAULT_REQUEST_TIMEOUT_SECS,
                max_audio_bytes: 26_214_400,
                max_json_bytes: 524_288,
                max_issue_report_bytes: DEFAULT_MAX_ISSUE_REPORT_BYTES,
                max_image_edit_bytes: DEFAULT_MAX_IMAGE_EDIT_BYTES,
                max_agent_chat_bytes: DEFAULT_MAX_AGENT_CHAT_BYTES,
                max_agent_inflight_body_bytes: DEFAULT_MAX_AGENT_INFLIGHT_BODY_BYTES,
                max_agent_concurrent_requests_per_user:
                    DEFAULT_MAX_AGENT_CONCURRENT_REQUESTS_PER_USER,
            },
            local_dev: LocalDevConfig::default(),
            os_accounts: OsAccountsConfig {
                api_url: String::new(),
                app_api_key: String::new(),
                p3a_ingest_token: String::new(),
                iss: "os-accounts-dev".to_string(),
                aud: "june-api-dev".to_string(),
                jwks_refresh_secs: 300,
                jwks_miss_min_backoff_secs: 5,
                authorize_hold_ttl_note_transcribe_secs: 60,
                authorize_hold_ttl_note_generate_secs: DEFAULT_IMAGE_HOLD_TTL_SECS,
                authorize_hold_ttl_dictate_transcribe_secs: 30,
                authorize_hold_ttl_dictate_cleanup_secs: 30,
                note_transcribe_preview_max_audio_secs: 30,
                flat_estimate_credits: 250,
                web_search_credits: 20,
                web_fetch_credits: 20,
                authorize_hold_ttl_web_secs: 30,
                authorize_hold_ttl_image_secs: DEFAULT_IMAGE_HOLD_TTL_SECS,
                authorize_hold_ttl_video_secs: DEFAULT_VIDEO_HOLD_TTL_SECS,
            },
            upstreams: UpstreamsConfig {
                openai: UpstreamConfig {
                    api_key: String::new(),
                    base_url: "https://api.openai.com/v1".to_string(),
                    byok_base_url: None,
                },
                venice: UpstreamConfig {
                    api_key: String::new(),
                    base_url: "https://api.venice.ai/api/v1".to_string(),
                    byok_base_url: None,
                },
            },
            attestation: AttestationConfig {
                source_commit: String::new(),
                source_repo_url: "https://github.com/open-software-network/os-june".to_string(),
                image_repo: "ghcr.io/open-software-network/june-api".to_string(),
                trust_center_url:
                    "https://trust.phala.com/app/6514acb0e08dc4825e2b6e22a46f0ed0ff455b54"
                        .to_string(),
            },
            issue_reports: IssueReportsConfig::default(),
            share: ShareConfig::default(),
            companion: CompanionConfig::default(),
            pricing: default_pricing(),
            image_pricing: default_image_pricing(),
            image_edit_pricing: default_image_edit_pricing(),
            default_image_edit_model: default_image_edit_model(),
            video_pricing: default_video_pricing(),
            video_animate_pricing: default_video_animate_pricing(),
            default_video_animate_model: default_video_animate_model(),
            video_max_credits_per_request: default_video_max_credits_per_request(),
            video_max_response_bytes: default_video_max_response_bytes(),
        }
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error(transparent)]
    Figment(#[from] Box<figment::Error>),
    #[error("missing required config `{field}`")]
    MissingRequired { field: &'static str },
    #[error("invalid required config `{field}`: {reason}")]
    InvalidRequired {
        field: &'static str,
        reason: &'static str,
    },
    #[error("invalid pricing for model `{model}`: {reason}")]
    InvalidPricing { model: String, reason: String },
}

pub fn load() -> Result<AppConfig, ConfigError> {
    let config: AppConfig = Figment::new()
        .merge(Serialized::defaults(AppConfig::default()))
        .merge(Toml::file("config.toml"))
        .merge(Env::prefixed("JUNE__").split("__"))
        .extract()
        .map_err(Box::new)
        .map_err(ConfigError::from)?;
    validate(&config)?;
    Ok(config)
}

const LEGACY_OS_ACCOUNTS_APP_API_KEY_PLACEHOLDER: &str = concat!("osk", "_REPLACE_ME");
const LEGACY_OPENAI_API_KEY_PLACEHOLDER: &str = concat!("sk", "_REPLACE_ME");
const OS_ACCOUNTS_APP_API_KEY_PLACEHOLDERS: &[&str] = &[
    "REPLACE_WITH_OS_ACCOUNTS_APP_API_KEY",
    LEGACY_OS_ACCOUNTS_APP_API_KEY_PLACEHOLDER,
];
const OPENAI_API_KEY_PLACEHOLDERS: &[&str] = &[
    "REPLACE_WITH_OPENAI_API_KEY",
    LEGACY_OPENAI_API_KEY_PLACEHOLDER,
];
const VENICE_API_KEY_PLACEHOLDERS: &[&str] = &["VENICE_API_KEY_REPLACE_ME"];
const LOCAL_DEV_BEARER_TOKEN_PLACEHOLDERS: &[&str] = &[LOCAL_DEV_BEARER_TOKEN_PLACEHOLDER];

fn validate(config: &AppConfig) -> Result<(), ConfigError> {
    if config.share.viewer_only {
        return validate_viewer_only(config);
    }

    if config.local_dev.enabled {
        validate_local_dev_bearer_token(config)?;
        validate_required_text("local_dev.user_id", &config.local_dev.user_id)?;
        if !config.local_dev.user_id.starts_with("usr_") {
            return Err(ConfigError::InvalidRequired {
                field: "local_dev.user_id",
                reason: "must start with usr_",
            });
        }
    } else {
        validate_absolute_http_url("os_accounts.api_url", &config.os_accounts.api_url)?;
        validate_required_secret(
            "os_accounts.app_api_key",
            &config.os_accounts.app_api_key,
            OS_ACCOUNTS_APP_API_KEY_PLACEHOLDERS,
        )?;
        // os_accounts.p3a_ingest_token is deliberately not validated here:
        // the token is optional, and when unset the P3A sink degrades to
        // log-only instead of failing startup (JUN-231).
    }
    validate_request_limits(config)?;
    validate_issue_report_diagnosis(config)?;

    let uses_openai = config
        .pricing
        .values()
        .any(|pricing| pricing.provider == ModelProvider::Openai);
    let uses_venice = config
        .pricing
        .values()
        .any(|pricing| pricing.provider == ModelProvider::Venice);
    if uses_openai {
        validate_required_text(
            "upstreams.openai.base_url",
            &config.upstreams.openai.base_url,
        )?;
        if !config.local_dev.enabled {
            validate_required_secret(
                "upstreams.openai.api_key",
                &config.upstreams.openai.api_key,
                OPENAI_API_KEY_PLACEHOLDERS,
            )?;
        }
    }
    if uses_venice {
        validate_required_text(
            "upstreams.venice.base_url",
            &config.upstreams.venice.base_url,
        )?;
        if !config.local_dev.enabled {
            validate_required_secret(
                "upstreams.venice.api_key",
                &config.upstreams.venice.api_key,
                VENICE_API_KEY_PLACEHOLDERS,
            )?;
        }
    }

    for (model_id, pricing) in &config.pricing {
        let expected_unit = match pricing.model_type {
            ModelType::Asr => PriceUnit::Seconds,
            ModelType::Text => PriceUnit::Tokens,
        };
        if pricing.unit != expected_unit {
            return Err(ConfigError::InvalidPricing {
                model: model_id.clone(),
                reason: format!(
                    "model_type `{}` requires unit `{}`, got `{}`",
                    pricing.model_type.as_str(),
                    expected_unit.as_str(),
                    pricing.unit.as_str()
                ),
            });
        }
        match pricing.model_type {
            ModelType::Asr => {
                validate_positive_rate(
                    model_id,
                    pricing.credits_per_million_seconds,
                    "credits_per_million_seconds",
                )?;
            }
            ModelType::Text => {
                validate_positive_rate(
                    model_id,
                    pricing.input_credits_per_million_tokens,
                    "input_credits_per_million_tokens",
                )?;
                validate_positive_rate(
                    model_id,
                    pricing.output_credits_per_million_tokens,
                    "output_credits_per_million_tokens",
                )?;
            }
        }
    }
    validate_image_pricing(config)?;
    validate_video_pricing(config)?;
    Ok(())
}

/// The isolated short-link process does not expose product routes and must not
/// need their billing/provider credentials. Validate only the network origins
/// and limits its viewer routes actually use. Sharing itself still fails closed
/// at runtime (501) when the database or public client id is absent; the deploy
/// contract probes the shell and a missing link so a partially sealed CVM
/// cannot pass activation.
fn validate_viewer_only(config: &AppConfig) -> Result<(), ConfigError> {
    validate_absolute_http_url("os_accounts.api_url", &config.os_accounts.api_url)?;
    let (viewer_accounts_field, viewer_accounts_url) =
        if config.share.viewer_accounts_url.trim().is_empty() {
            ("os_accounts.iss", &config.os_accounts.iss)
        } else {
            (
                "share.viewer_accounts_url",
                &config.share.viewer_accounts_url,
            )
        };
    validate_absolute_http_url(viewer_accounts_field, viewer_accounts_url)?;
    validate_request_limits(config)?;
    if config.share.max_ciphertext_bytes == 0 {
        return Err(ConfigError::InvalidRequired {
            field: "share.max_ciphertext_bytes",
            reason: "must be > 0",
        });
    }
    Ok(())
}

/// Video markups (thousandths) must be > 0 — a zero markup would charge nothing
/// on a paid quote — and the ceiling must be > 0. The default animate model must
/// be priced, since every MCP-driven animate uses it. Mirrors
/// `validate_image_pricing`, adapted for quote-derived pricing.
fn validate_video_pricing(config: &AppConfig) -> Result<(), ConfigError> {
    for (model_id, markup) in config
        .video_pricing
        .iter()
        .chain(config.video_animate_pricing.iter())
    {
        if *markup == 0 {
            return Err(ConfigError::InvalidPricing {
                model: model_id.clone(),
                reason: "video markup_millis must be > 0".to_string(),
            });
        }
    }
    if config.video_max_credits_per_request == 0 {
        return Err(ConfigError::InvalidRequired {
            field: "video_max_credits_per_request",
            reason: "must be > 0",
        });
    }
    if config.video_max_response_bytes == 0 {
        return Err(ConfigError::InvalidRequired {
            field: "video_max_response_bytes",
            reason: "must be > 0",
        });
    }
    if !config
        .video_animate_pricing
        .contains_key(&config.default_video_animate_model)
    {
        return Err(ConfigError::InvalidPricing {
            model: config.default_video_animate_model.clone(),
            reason: "default_video_animate_model must be present in video_animate_pricing"
                .to_string(),
        });
    }
    Ok(())
}

fn validate_issue_report_diagnosis(config: &AppConfig) -> Result<(), ConfigError> {
    if config
        .issue_reports
        .diagnosis_model
        .as_deref()
        .map(str::trim)
        .is_some_and(|model| !model.is_empty())
    {
        validate_positive_config(
            "issue_reports.diagnosis_timeout_secs",
            config.issue_reports.diagnosis_timeout_secs,
        )?;
        validate_positive_config(
            "issue_reports.diagnosis_max_per_user_per_hour",
            config.issue_reports.diagnosis_max_per_user_per_hour,
        )?;
    }
    Ok(())
}

fn validate_request_limits(config: &AppConfig) -> Result<(), ConfigError> {
    validate_positive_config(
        "os_accounts.note_transcribe_preview_max_audio_secs",
        config.os_accounts.note_transcribe_preview_max_audio_secs,
    )?;
    validate_image_timeout_margin(config)?;
    validate_positive_usize_config(
        "server.max_image_edit_bytes",
        config.server.max_image_edit_bytes,
    )?;
    validate_positive_usize_config(
        "server.max_agent_chat_bytes",
        config.server.max_agent_chat_bytes,
    )?;
    validate_positive_usize_config(
        "server.max_agent_inflight_body_bytes",
        config.server.max_agent_inflight_body_bytes,
    )?;
    validate_positive_usize_config(
        "server.max_agent_concurrent_requests_per_user",
        config.server.max_agent_concurrent_requests_per_user,
    )?;
    // The global in-flight body budget must be at least the largest single
    // large-body route cap (image edit, ~66 MiB), or the admission control would
    // load-shed EVERY request on that route — and, worse, an operator could tune
    // the budget below a route cap and defeat the memory-safety guarantee it
    // exists to provide (JUN-336 review). max_image_edit_bytes is the largest of
    // the agent route caps (image/video 66 MiB > audio 25 MiB > chat 12 MiB).
    if config.server.max_agent_inflight_body_bytes < config.server.max_image_edit_bytes {
        return Err(ConfigError::InvalidRequired {
            field: "server.max_agent_inflight_body_bytes",
            reason: "must be >= the largest agent route body cap (server.max_image_edit_bytes)",
        });
    }
    // The extractor cap must never sit BELOW the desktop provider proxy's fixed
    // 12 MiB chat body cap (mirrored here as `DEFAULT_MAX_AGENT_CHAT_BYTES`), or a
    // configured override silently reintroduces the JUN-336 regression: the proxy
    // still forwards a 1-12 MiB agent chat request, but this route 413s it before
    // `validate_agent_chat_body` runs. `max_json_bytes` is NOT the right floor —
    // an override of e.g. 1 MiB clears it yet is still stricter than the proxy.
    // The compile-time asserts only pin the default; this guards overrides.
    if config.server.max_agent_chat_bytes < DEFAULT_MAX_AGENT_CHAT_BYTES {
        return Err(ConfigError::InvalidRequired {
            field: "server.max_agent_chat_bytes",
            reason: "must be >= the 12 MiB desktop proxy chat body cap",
        });
    }
    validate_positive_usize_config(
        "server.max_issue_report_bytes",
        config.server.max_issue_report_bytes,
    )?;
    validate_image_hold_ttl(config)?;
    validate_video_hold_ttl(config)?;
    validate_long_inference_hold_ttl(config)?;
    validate_hold_ttl_bounds(config)?;
    Ok(())
}

/// The video hold has to cover the whole async job: the per-job budget plus the
/// settlement margin for the completing poll's charge. A hold below that would
/// expire mid-job and strand the charge (ADR 0015 Decision 2).
fn validate_video_hold_ttl(config: &AppConfig) -> Result<(), ConfigError> {
    let minimum = DEFAULT_VIDEO_JOB_MAX_SECS.saturating_add(VIDEO_SETTLEMENT_TIMEOUT_MARGIN_SECS);
    if config.os_accounts.authorize_hold_ttl_video_secs < minimum {
        return Err(ConfigError::InvalidRequired {
            field: "os_accounts.authorize_hold_ttl_video_secs",
            reason: "must cover the video job budget plus the settlement margin",
        });
    }
    Ok(())
}

fn validate_image_hold_ttl(config: &AppConfig) -> Result<(), ConfigError> {
    // The hold has to cover the image *client* timeout (route timeout minus
    // the settlement budget) plus that same settlement budget for the charge
    // path. Anchoring on the route timeout plus a margin demanded 630s, which
    // OS Accounts rejects (see OS_ACCOUNTS_MAX_HOLD_TTL_SECS). Saturating
    // math keeps this safe even when the route timeout is itself invalid
    // (rejected by the margin check).
    let minimum = config
        .server
        .request_timeout_secs
        .saturating_sub(OS_ACCOUNTS_AUTHORIZE_TIMEOUT_BUDGET_SECS)
        .saturating_sub(IMAGE_SETTLEMENT_TIMEOUT_MARGIN_SECS)
        .saturating_add(IMAGE_SETTLEMENT_TIMEOUT_MARGIN_SECS);
    if config.os_accounts.authorize_hold_ttl_image_secs < minimum {
        return Err(ConfigError::InvalidRequired {
            field: "os_accounts.authorize_hold_ttl_image_secs",
            reason: "must cover the image client timeout plus the settlement budget",
        });
    }
    Ok(())
}

/// Note generation and agent chat run on the bounded metered-inference client
/// (same window as images) and settle AFTER the upstream call — streamed chat
/// settles after the body drains, streamed generate keeps the connection
/// alive for the whole window. Their shared hold must therefore cover that
/// client window plus the settlement budget, exactly like the image hold;
/// a shorter hold silently expires before `charge` on every long call.
fn validate_long_inference_hold_ttl(config: &AppConfig) -> Result<(), ConfigError> {
    let minimum = config
        .server
        .request_timeout_secs
        .saturating_sub(OS_ACCOUNTS_AUTHORIZE_TIMEOUT_BUDGET_SECS)
        .saturating_sub(IMAGE_SETTLEMENT_TIMEOUT_MARGIN_SECS)
        .saturating_add(IMAGE_SETTLEMENT_TIMEOUT_MARGIN_SECS);
    if config.os_accounts.authorize_hold_ttl_note_generate_secs < minimum {
        return Err(ConfigError::InvalidRequired {
            field: "os_accounts.authorize_hold_ttl_note_generate_secs",
            reason: "must cover the metered-inference client timeout plus the settlement budget",
        });
    }
    Ok(())
}

/// Every authorize hold TTL must fit the OS Accounts platform bounds; a value
/// past the cap is rejected `invalid_ttl` on every request, which surfaces to
/// users as `metering_provider_failed` and disables the whole action.
fn validate_hold_ttl_bounds(config: &AppConfig) -> Result<(), ConfigError> {
    let ttls: [(&'static str, u64); 7] = [
        (
            "os_accounts.authorize_hold_ttl_note_transcribe_secs",
            config.os_accounts.authorize_hold_ttl_note_transcribe_secs,
        ),
        (
            "os_accounts.authorize_hold_ttl_note_generate_secs",
            config.os_accounts.authorize_hold_ttl_note_generate_secs,
        ),
        (
            "os_accounts.authorize_hold_ttl_dictate_transcribe_secs",
            config
                .os_accounts
                .authorize_hold_ttl_dictate_transcribe_secs,
        ),
        (
            "os_accounts.authorize_hold_ttl_dictate_cleanup_secs",
            config.os_accounts.authorize_hold_ttl_dictate_cleanup_secs,
        ),
        (
            "os_accounts.authorize_hold_ttl_web_secs",
            config.os_accounts.authorize_hold_ttl_web_secs,
        ),
        (
            "os_accounts.authorize_hold_ttl_image_secs",
            config.os_accounts.authorize_hold_ttl_image_secs,
        ),
        (
            "os_accounts.authorize_hold_ttl_video_secs",
            config.os_accounts.authorize_hold_ttl_video_secs,
        ),
    ];
    for (field, value) in ttls {
        if !(1..=OS_ACCOUNTS_MAX_HOLD_TTL_SECS).contains(&value) {
            return Err(ConfigError::InvalidRequired {
                field,
                reason: "must be within the OS Accounts hold TTL bounds (1..=900 seconds)",
            });
        }
    }
    Ok(())
}

fn validate_image_timeout_margin(config: &AppConfig) -> Result<(), ConfigError> {
    if config.server.request_timeout_secs
        <= OS_ACCOUNTS_AUTHORIZE_TIMEOUT_BUDGET_SECS + IMAGE_SETTLEMENT_TIMEOUT_MARGIN_SECS
    {
        return Err(ConfigError::InvalidRequired {
            field: "server.request_timeout_secs",
            reason: "must exceed the authorize budget plus the image settlement margin",
        });
    }
    Ok(())
}

/// A zero per-image price would silently generate/edit for free — reject it like
/// the per-model rate validation so a misconfigured price fails fast. Also
/// guards that the default edit model is actually priced, since every MCP-driven
/// edit uses it and an unpriced model would fail every edit at runtime.
fn validate_image_pricing(config: &AppConfig) -> Result<(), ConfigError> {
    for (model_id, credits) in config
        .image_pricing
        .iter()
        .chain(config.image_edit_pricing.iter())
    {
        if *credits == 0 {
            return Err(ConfigError::InvalidPricing {
                model: model_id.clone(),
                reason: "credits_per_image must be > 0".to_string(),
            });
        }
    }
    if !config
        .image_edit_pricing
        .contains_key(&config.default_image_edit_model)
    {
        return Err(ConfigError::InvalidPricing {
            model: config.default_image_edit_model.clone(),
            reason: "default_image_edit_model must be present in image_edit_pricing".to_string(),
        });
    }
    Ok(())
}

fn validate_local_dev_bearer_token(config: &AppConfig) -> Result<(), ConfigError> {
    if is_loopback_host(&config.server.host) {
        validate_required_text("local_dev.bearer_token", &config.local_dev.bearer_token)
    } else {
        validate_required_secret(
            "local_dev.bearer_token",
            &config.local_dev.bearer_token,
            LOCAL_DEV_BEARER_TOKEN_PLACEHOLDERS,
        )
    }
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host.trim(), "127.0.0.1" | "localhost" | "::1")
}

fn validate_required_text(field: &'static str, value: &str) -> Result<(), ConfigError> {
    if value.trim().is_empty() {
        return Err(ConfigError::MissingRequired { field });
    }
    Ok(())
}

fn validate_required_secret(
    field: &'static str,
    value: &str,
    placeholders: &[&str],
) -> Result<(), ConfigError> {
    validate_required_text(field, value)?;
    if placeholders
        .iter()
        .any(|placeholder| value.trim() == *placeholder)
    {
        return Err(ConfigError::InvalidRequired {
            field,
            reason: "placeholder value must be replaced",
        });
    }
    Ok(())
}

fn validate_absolute_http_url(field: &'static str, value: &str) -> Result<(), ConfigError> {
    validate_required_text(field, value)?;
    let parsed = Url::parse(value.trim()).map_err(|_| ConfigError::InvalidRequired {
        field,
        reason: "must be an absolute http or https URL",
    })?;
    if matches!(parsed.scheme(), "http" | "https") && parsed.has_host() {
        return Ok(());
    }
    Err(ConfigError::InvalidRequired {
        field,
        reason: "must be an absolute http or https URL",
    })
}

fn validate_positive_config(field: &'static str, value: u64) -> Result<(), ConfigError> {
    if value == 0 {
        return Err(ConfigError::InvalidRequired {
            field,
            reason: "must be > 0",
        });
    }
    Ok(())
}

fn validate_positive_usize_config(field: &'static str, value: usize) -> Result<(), ConfigError> {
    if value == 0 {
        return Err(ConfigError::InvalidRequired {
            field,
            reason: "must be > 0",
        });
    }
    Ok(())
}

fn validate_positive_rate(
    model_id: &str,
    value: Option<u64>,
    field: &str,
) -> Result<(), ConfigError> {
    match value {
        Some(value) if value > 0 => Ok(()),
        _ => Err(ConfigError::InvalidPricing {
            model: model_id.to_string(),
            reason: format!("{field} must be > 0"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AppConfig, ConfigError, DEFAULT_IMAGE_CLIENT_TIMEOUT_SECS, DEFAULT_IMAGE_HOLD_TTL_SECS,
        DEFAULT_MAX_AGENT_CHAT_BYTES, DEFAULT_MAX_AGENT_CONCURRENT_REQUESTS_PER_USER,
        DEFAULT_MAX_AGENT_INFLIGHT_BODY_BYTES, DEFAULT_MAX_IMAGE_EDIT_BYTES,
        DEFAULT_MAX_ISSUE_REPORT_BYTES, DEFAULT_REQUEST_TIMEOUT_SECS, DEFAULT_VIDEO_HOLD_TTL_SECS,
        DEFAULT_VIDEO_JOB_MAX_SECS, DEFAULT_VIDEO_MAX_RESPONSE_BYTES, IMAGE_EDIT_SOURCE_MAX_BYTES,
        IMAGE_SETTLEMENT_TIMEOUT_MARGIN_SECS, ISSUE_REPORT_ATTACHMENT_MAX_BYTES, ModelPriceConfig,
        ModelProvider, ModelType, OPENAI_API_KEY_PLACEHOLDERS,
        OS_ACCOUNTS_APP_API_KEY_PLACEHOLDERS, OS_ACCOUNTS_AUTHORIZE_TIMEOUT_BUDGET_SECS,
        OS_ACCOUNTS_MAX_HOLD_TTL_SECS, PriceUnit, VENICE_API_KEY_PLACEHOLDERS,
        VIDEO_CLIENT_POLL_WINDOW_SECS, VIDEO_SETTLEMENT_TIMEOUT_MARGIN_SECS,
        image_client_timeout_secs, validate, validate_request_limits,
    };
    use pretty_assertions::assert_eq;
    use std::collections::BTreeMap;

    fn valid_config() -> AppConfig {
        let mut config = AppConfig::default();
        config.os_accounts.api_url = "http://127.0.0.1:3000".to_string();
        config.os_accounts.app_api_key = "osk_test".to_string();
        config.os_accounts.p3a_ingest_token = "p3a-test-token".to_string();
        config.upstreams.openai.api_key = "sk-test".to_string();
        config.upstreams.venice.api_key = "venice-test".to_string();
        config
    }

    fn packaged_config_toml() -> AppConfig {
        use figment::{
            Figment,
            providers::{Format, Serialized, Toml},
        };
        let toml_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../config.toml");
        Figment::new()
            .merge(Serialized::defaults(AppConfig::default()))
            .merge(Toml::file(toml_path))
            .extract::<AppConfig>()
            .unwrap_or_default()
    }

    #[test]
    fn share_max_ciphertext_survives_default_seeding() -> Result<(), Box<dyn std::error::Error>> {
        // load() seeds AppConfig::default() as the figment base via
        // Serialized::defaults, then layers config.toml/env on top. If
        // ShareConfig::default left max_ciphertext_bytes at usize::default()
        // (0), that 0 is present in the base and shadows the serde field
        // default, so a deployment that sets only the share envs would build a
        // 0-byte cap and reject every share. Mirror that merge with no overlay
        // and assert the real cap survives.
        use figment::{Figment, providers::Serialized};
        let config: AppConfig = Figment::new()
            .merge(Serialized::defaults(AppConfig::default()))
            .extract()?;
        assert_eq!(config.share.max_ciphertext_bytes, 10 * 1024 * 1024);
        Ok(())
    }

    #[test]
    fn viewer_only_config_does_not_require_product_secrets() {
        let mut config = AppConfig::default();
        config.share.viewer_only = true;
        config.os_accounts.api_url = "https://accounts-api.example".to_string();
        config.os_accounts.iss = "https://accounts.example".to_string();

        assert!(validate(&config).is_ok());
    }

    #[test]
    fn viewer_only_config_still_validates_its_accounts_origin() {
        let mut config = AppConfig::default();
        config.share.viewer_only = true;
        config.os_accounts.api_url = "not-a-url".to_string();
        config.os_accounts.iss = "https://accounts.example".to_string();

        assert!(validate(&config).is_err());
    }

    #[test]
    fn viewer_only_config_names_the_invalid_fallback_accounts_origin() {
        let mut config = AppConfig::default();
        config.share.viewer_only = true;
        config.os_accounts.api_url = "https://accounts-api.example".to_string();
        config.os_accounts.iss = "not-a-url".to_string();

        assert!(matches!(
            validate(&config),
            Err(ConfigError::InvalidRequired {
                field: "os_accounts.iss",
                ..
            })
        ));
    }

    #[test]
    fn viewer_only_config_names_an_invalid_explicit_accounts_origin() {
        let mut config = AppConfig::default();
        config.share.viewer_only = true;
        config.os_accounts.api_url = "https://accounts-api.example".to_string();
        config.os_accounts.iss = "https://accounts.example".to_string();
        config.share.viewer_accounts_url = "not-a-url".to_string();

        assert!(matches!(
            validate(&config),
            Err(ConfigError::InvalidRequired {
                field: "share.viewer_accounts_url",
                ..
            })
        ));
    }

    #[test]
    fn default_kimi_declares_vision_but_glm_does_not() {
        // Kimi K2.6 is the image-input fallback the app switches to, so it must
        // read as vision-capable even from these built-in defaults, before the
        // live Venice catalog loads (JUN-165). The non-vision GLM defaults must
        // not claim vision, or the fallback could land on one of them.
        let config = AppConfig::default();
        let declares_vision = |id: &str| {
            config
                .pricing
                .get(id)
                .is_some_and(|model| model.capabilities.iter().any(|c| c == "supportsVision"))
        };
        assert!(
            declares_vision("kimi-k2-6"),
            "kimi-k2-6 default capabilities should declare supportsVision"
        );
        assert!(
            config.pricing.contains_key("zai-org-glm-5-2"),
            "zai-org-glm-5-2 should be present in default pricing"
        );
        assert!(
            !declares_vision("zai-org-glm-5-2"),
            "GLM 5.2 default must not claim vision"
        );
    }

    #[test]
    fn packaged_config_toml_keeps_kimi_vision_in_sync() {
        // config.toml overrides default_pricing() via Figment and ships in the
        // Docker image, so it is what `/models` serves when the live Venice
        // catalog is unreachable. It must agree that Kimi is a vision model, or
        // the image-attach fallback breaks in the packaged build (JUN-165).
        let config = packaged_config_toml();
        // A TOML-only model proves config.toml actually merged, so a failed
        // load can't make the vision assertion below pass on the default alone.
        assert!(
            config
                .pricing
                .contains_key("nvidia-nemotron-3-nano-30b-a3b"),
            "packaged config.toml did not merge"
        );
        let kimi_declares_vision = config
            .pricing
            .get("kimi-k2-6")
            .is_some_and(|model| model.capabilities.iter().any(|c| c == "supportsVision"));
        assert!(
            kimi_declares_vision,
            "packaged config.toml must declare supportsVision for kimi-k2-6"
        );
    }

    #[test]
    fn packaged_config_toml_passes_through_upstream_cost() {
        let config = packaged_config_toml();

        // Per-second conversions of OpenAI's per-MINUTE ASR list prices
        // ($0.003/min mini, $0.006/min 4o) at upstream cost.
        assert_eq!(
            config
                .pricing
                .get("gpt-4o-mini-transcribe")
                .and_then(|model| model.credits_per_million_seconds),
            Some(50_000)
        );
        assert_eq!(
            config
                .pricing
                .get("gpt-4o-transcribe")
                .and_then(|model| model.credits_per_million_seconds),
            Some(100_000)
        );
        assert_eq!(
            config
                .pricing
                .get("zai-org-glm-5-2")
                .and_then(|model| model.input_credits_per_million_tokens),
            Some(1_400)
        );
        assert_eq!(
            config
                .pricing
                .get("zai-org-glm-5-2")
                .and_then(|model| model.output_credits_per_million_tokens),
            Some(4_400)
        );
        for model_id in ["zai-org-glm-5-1", "zai-org-glm-5"] {
            let model = config.pricing.get(model_id);
            assert_eq!(
                model.and_then(|model| model.input_credits_per_million_tokens),
                Some(1_400),
                "{model_id} must use the routed GLM 5.2 input price"
            );
            assert_eq!(
                model.and_then(|model| model.output_credits_per_million_tokens),
                Some(4_400),
                "{model_id} must use the routed GLM 5.2 output price"
            );
        }
        let kimi = config.pricing.get("kimi-k2-6");
        assert_eq!(
            kimi.and_then(|model| model.input_credits_per_million_tokens),
            Some(1_090)
        );
        assert_eq!(
            kimi.and_then(|model| model.output_credits_per_million_tokens),
            Some(4_600)
        );
        assert_eq!(
            config
                .pricing
                .get("nvidia-nemotron-3-nano-30b-a3b")
                .and_then(|model| model.input_credits_per_million_tokens),
            Some(70)
        );
    }

    #[test]
    fn config_debug_redacts_secrets() {
        let mut config = AppConfig::default();
        config.os_accounts.app_api_key = "app_api_key_secret_value".to_string();
        config.local_dev.bearer_token = "local-secret-token".to_string();
        config.upstreams.openai.api_key = "sk-secret".to_string();
        config.upstreams.venice.api_key = "vc-secret".to_string();
        let dump = format!("{config:?}");
        assert!(
            !dump.contains("app_api_key_secret_value"),
            "app_api_key leaked in Debug: {dump}"
        );
        assert!(!dump.contains("local-secret-token"));
        assert!(!dump.contains("sk-secret"));
        assert!(!dump.contains("vc-secret"));
        assert!(dump.contains("<redacted>"));
    }

    #[test]
    fn validate_rejects_asr_model_with_token_unit() {
        let mut pricing = BTreeMap::new();
        pricing.insert(
            "bad-asr".to_string(),
            ModelPriceConfig {
                unit: PriceUnit::Tokens,
                credits_per_million_seconds: None,
                input_credits_per_million_tokens: Some(1),
                output_credits_per_million_tokens: Some(1),
                provider: ModelProvider::Venice,
                model_type: ModelType::Asr,
                display_name: "bad".to_string(),
                description: None,
                privacy: None,
                pricing: None,
                context_tokens: None,
                traits: Vec::new(),
                capabilities: Vec::new(),
            },
        );
        let config = AppConfig {
            pricing,
            ..valid_config()
        };

        let result = validate(&config);

        assert!(result.is_err(), "expected validation error");
    }

    #[test]
    fn validate_rejects_zero_rate() {
        let mut pricing = BTreeMap::new();
        pricing.insert(
            "free-asr".to_string(),
            ModelPriceConfig {
                unit: PriceUnit::Seconds,
                credits_per_million_seconds: Some(0),
                input_credits_per_million_tokens: None,
                output_credits_per_million_tokens: None,
                provider: ModelProvider::Openai,
                model_type: ModelType::Asr,
                display_name: "free".to_string(),
                description: None,
                privacy: None,
                pricing: None,
                context_tokens: None,
                traits: Vec::new(),
                capabilities: Vec::new(),
            },
        );
        let config = AppConfig {
            pricing,
            ..valid_config()
        };

        let result = validate(&config);

        assert!(result.is_err());
    }

    #[test]
    fn validate_rejects_zero_preview_audio_cap() {
        let mut config = valid_config();
        config.os_accounts.note_transcribe_preview_max_audio_secs = 0;

        let result = validate(&config);

        assert!(result.is_err());
    }

    #[test]
    fn validate_rejects_zero_image_price() {
        // A zero per-image price would silently generate for free; reject it.
        let mut config = valid_config();
        config.image_pricing.insert("free-image".to_string(), 0);

        let result = validate(&config);

        assert!(result.is_err());
    }

    #[test]
    fn validate_rejects_zero_issue_report_diagnosis_timeout_when_model_is_set() {
        let mut config = valid_config();
        config.issue_reports.diagnosis_model = Some("text-model".to_string());
        config.issue_reports.diagnosis_timeout_secs = 0;

        let result = validate(&config);

        assert!(matches!(
            result,
            Err(ConfigError::InvalidRequired {
                field: "issue_reports.diagnosis_timeout_secs",
                reason: "must be > 0"
            })
        ));
    }

    #[test]
    fn default_config_prices_the_curated_image_models() {
        let config = valid_config();
        for model in [
            "venice-sd35",
            "grok-imagine-image-quality",
            "krea-2-turbo",
            "flux-2-pro",
            "flux-2-max",
            "gpt-image-2",
            "gpt-image-1-5",
            "hunyuan-image-v3",
            "ideogram-v4",
            "imagineart-1.5-pro",
            "krea-v2-large",
            "krea-v2-medium",
            "luma-uni-1",
            "luma-uni-1-max",
            "nano-banana-2",
            "nano-banana-pro",
            "nano-banana-2-lite",
            "recraft-v4",
            "recraft-v4-pro",
            "seedream-v4",
            "seedream-v5-lite",
            "qwen-image-2",
            "qwen-image-2-pro",
            "wan-2-7-text-to-image",
            "wan-2-7-pro-text-to-image",
            "grok-imagine-image",
            "lustify-sdxl",
            "lustify-v7",
            "lustify-v8",
            "qwen-image",
            "wai-Illustrious",
            "z-image-turbo",
            "chroma",
            "bria-bg-remover",
        ] {
            assert!(
                config.image_pricing.get(model).is_some_and(|c| *c > 0),
                "missing image price for {model}"
            );
        }
    }

    #[test]
    fn default_image_edit_body_limit_matches_source_image_cap() {
        let expected_base64_len = IMAGE_EDIT_SOURCE_MAX_BYTES.div_ceil(3) * 4;
        assert_eq!(
            DEFAULT_MAX_IMAGE_EDIT_BYTES,
            expected_base64_len + (16 * 1024)
        );
        assert_eq!(
            AppConfig::default().server.max_image_edit_bytes,
            DEFAULT_MAX_IMAGE_EDIT_BYTES
        );
    }

    #[test]
    fn default_agent_chat_body_limit_is_the_dedicated_12_mib_cap() {
        assert_eq!(DEFAULT_MAX_AGENT_CHAT_BYTES, 12 * 1024 * 1024);
        assert_eq!(
            AppConfig::default().server.max_agent_chat_bytes,
            DEFAULT_MAX_AGENT_CHAT_BYTES
        );
        // The dedicated agent chat cap must never be stricter than the shared
        // small-JSON cap, or JUN-336 reopens.
        assert!(
            AppConfig::default().server.max_agent_chat_bytes
                >= AppConfig::default().server.max_json_bytes
        );
    }

    #[test]
    fn default_agent_admission_limits_match_their_constants() {
        let server = AppConfig::default().server;

        assert_eq!(
            server.max_agent_inflight_body_bytes,
            DEFAULT_MAX_AGENT_INFLIGHT_BODY_BYTES
        );
        assert_eq!(
            server.max_agent_concurrent_requests_per_user,
            DEFAULT_MAX_AGENT_CONCURRENT_REQUESTS_PER_USER
        );
        // The default budget must clear the largest route cap so admission never
        // load-sheds every request on a route.
        assert!(server.max_agent_inflight_body_bytes >= server.max_image_edit_bytes);
    }

    #[test]
    fn agent_inflight_budget_below_largest_route_cap_is_rejected() {
        // An operator override that drops the global budget below a single route
        // cap must fail loudly at load, not silently defeat the memory guarantee.
        let mut config = AppConfig::default();
        config.server.max_agent_inflight_body_bytes = config.server.max_image_edit_bytes - 1;
        assert!(matches!(
            validate_request_limits(&config),
            Err(ConfigError::InvalidRequired {
                field: "server.max_agent_inflight_body_bytes",
                ..
            })
        ));
    }

    #[test]
    fn agent_chat_body_limit_below_proxy_cap_is_rejected() {
        // An override BELOW the 12 MiB desktop proxy cap must fail loudly at load,
        // even when it clears the shared small-JSON cap — otherwise the proxy
        // forwards a 1-3 MiB agent chat request that this route then 413s,
        // reopening JUN-336 (Codex review on PR #776).
        let mut config = AppConfig::default();
        config.server.max_agent_chat_bytes = DEFAULT_MAX_AGENT_CHAT_BYTES - 1;
        assert!(config.server.max_agent_chat_bytes > config.server.max_json_bytes);
        assert!(matches!(
            validate_request_limits(&config),
            Err(ConfigError::InvalidRequired {
                field: "server.max_agent_chat_bytes",
                ..
            })
        ));
    }

    #[test]
    fn default_issue_report_body_limit_matches_platform_attachment_cap() {
        assert_eq!(ISSUE_REPORT_ATTACHMENT_MAX_BYTES, 300 * 1024 * 1024);
        assert_eq!(
            AppConfig::default().server.max_issue_report_bytes,
            ISSUE_REPORT_ATTACHMENT_MAX_BYTES + (1024 * 1024)
        );
    }

    #[test]
    fn production_ingress_accepts_the_issue_report_body_budget() -> Result<(), String> {
        let compose = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../deploy/docker-compose.production.yml"
        ));
        let configured_limits = compose
            .lines()
            .filter_map(|line| {
                line.trim()
                    .strip_prefix("- CLIENT_MAX_BODY_SIZE=")
                    .map(str::trim)
            })
            .collect::<Vec<_>>();
        assert_eq!(
            configured_limits.len(),
            1,
            "production compose must declare one ingress body limit"
        );
        let configured_limit = configured_limits
            .first()
            .copied()
            .ok_or_else(|| "production ingress body limit is missing".to_string())?;
        let configured_mib = configured_limit
            .strip_suffix('m')
            .ok_or_else(|| "ingress limit should use nginx MiB units".to_string())?
            .parse::<usize>()
            .map_err(|error| format!("ingress limit should be numeric: {error}"))?;
        let configured_bytes = configured_mib
            .checked_mul(1024 * 1024)
            .ok_or_else(|| "ingress body limit should fit usize".to_string())?;

        assert!(
            configured_bytes >= DEFAULT_MAX_ISSUE_REPORT_BYTES,
            "production ingress body limit ({configured_bytes}) is below June API's issue-report limit ({DEFAULT_MAX_ISSUE_REPORT_BYTES})"
        );
        Ok(())
    }

    #[test]
    fn default_image_hold_ttl_covers_client_timeout_within_platform_cap() {
        let config = AppConfig::default();
        assert_eq!(
            config.os_accounts.authorize_hold_ttl_image_secs,
            image_client_timeout_secs(config.server.request_timeout_secs)
                + IMAGE_SETTLEMENT_TIMEOUT_MARGIN_SECS
        );
        assert_eq!(
            config.os_accounts.authorize_hold_ttl_image_secs,
            DEFAULT_IMAGE_HOLD_TTL_SECS
        );
        // The <= OS_ACCOUNTS_MAX_HOLD_TTL_SECS regression pin lives as a
        // compile-time const assertion next to the constant itself.
    }

    #[test]
    fn validate_rejects_image_hold_ttl_above_os_accounts_cap() {
        let mut config = valid_config();
        config.os_accounts.authorize_hold_ttl_image_secs = OS_ACCOUNTS_MAX_HOLD_TTL_SECS + 30;

        let result = validate(&config);

        assert!(matches!(
            result,
            Err(ConfigError::InvalidRequired {
                field: "os_accounts.authorize_hold_ttl_image_secs",
                ..
            })
        ));
    }

    #[test]
    fn validate_rejects_any_hold_ttl_outside_platform_bounds() {
        let mut config = valid_config();
        config.os_accounts.authorize_hold_ttl_web_secs = OS_ACCOUNTS_MAX_HOLD_TTL_SECS + 1;
        assert!(matches!(
            validate(&config),
            Err(ConfigError::InvalidRequired {
                field: "os_accounts.authorize_hold_ttl_web_secs",
                ..
            })
        ));

        let mut config = valid_config();
        config.os_accounts.authorize_hold_ttl_dictate_cleanup_secs = 0;
        assert!(matches!(
            validate(&config),
            Err(ConfigError::InvalidRequired {
                field: "os_accounts.authorize_hold_ttl_dictate_cleanup_secs",
                ..
            })
        ));
    }

    #[test]
    fn default_image_client_timeout_leaves_settlement_margin_before_route_timeout() {
        let config = AppConfig::default();
        let image_client_timeout = image_client_timeout_secs(config.server.request_timeout_secs);

        assert_eq!(image_client_timeout, DEFAULT_IMAGE_CLIENT_TIMEOUT_SECS);
        assert!(image_client_timeout < config.server.request_timeout_secs);
        assert!(
            image_client_timeout + IMAGE_SETTLEMENT_TIMEOUT_MARGIN_SECS
                <= config.server.request_timeout_secs
        );
    }

    #[test]
    fn validate_rejects_image_route_timeout_without_settlement_margin() {
        let mut config = valid_config();
        config.server.request_timeout_secs =
            OS_ACCOUNTS_AUTHORIZE_TIMEOUT_BUDGET_SECS + IMAGE_SETTLEMENT_TIMEOUT_MARGIN_SECS;
        config.os_accounts.authorize_hold_ttl_image_secs = DEFAULT_IMAGE_HOLD_TTL_SECS;

        let result = validate(&config);

        assert!(matches!(
            result,
            Err(ConfigError::InvalidRequired {
                field: "server.request_timeout_secs",
                ..
            })
        ));
    }

    #[test]
    fn validate_rejects_image_hold_ttl_below_client_timeout_margin() {
        let mut config = valid_config();
        config.server.request_timeout_secs = DEFAULT_REQUEST_TIMEOUT_SECS;
        config.os_accounts.authorize_hold_ttl_image_secs = 60;

        let result = validate(&config);

        assert!(matches!(
            result,
            Err(ConfigError::InvalidRequired {
                field: "os_accounts.authorize_hold_ttl_image_secs",
                ..
            })
        ));
    }

    #[test]
    fn default_config_prices_the_curated_video_models() {
        let config = valid_config();
        assert!(
            config
                .video_pricing
                .get("wan-2.2-a14b-text-to-video")
                .is_some_and(|markup| *markup > 0),
            "the curated wan-2.2-a14b video model must have a positive markup"
        );
        // The default animate model must be in its own allowlist, or every
        // MCP-driven animate fails model_not_priced.
        assert!(
            config
                .video_animate_pricing
                .contains_key(&config.default_video_animate_model)
        );
    }

    #[test]
    fn validate_rejects_zero_video_markup() {
        // A zero markup would charge nothing on a paid quote; reject it.
        let mut config = valid_config();
        config.video_pricing.insert("free-video".to_string(), 0);

        assert!(validate(&config).is_err());
    }

    #[test]
    fn validate_rejects_zero_video_ceiling() {
        let mut config = valid_config();
        config.video_max_credits_per_request = 0;

        assert!(matches!(
            validate(&config),
            Err(ConfigError::InvalidRequired {
                field: "video_max_credits_per_request",
                ..
            })
        ));
    }

    #[test]
    fn validate_rejects_zero_video_response_cap() {
        let mut config = valid_config();
        config.video_max_response_bytes = 0;

        assert!(matches!(
            validate(&config),
            Err(ConfigError::InvalidRequired {
                field: "video_max_response_bytes",
                ..
            })
        ));
    }

    #[test]
    fn validate_rejects_unpriced_default_video_animate_model() {
        let mut config = valid_config();
        config.default_video_animate_model = "not-in-the-allowlist".to_string();

        assert!(validate(&config).is_err());
    }

    #[test]
    fn default_video_hold_ttl_covers_job_budget_within_platform_cap() {
        let config = AppConfig::default();
        assert_eq!(
            config.os_accounts.authorize_hold_ttl_video_secs,
            DEFAULT_VIDEO_HOLD_TTL_SECS
        );
        // The hold covers the whole job (budget + settlement margin) ...
        assert!(
            config.os_accounts.authorize_hold_ttl_video_secs
                >= DEFAULT_VIDEO_JOB_MAX_SECS + VIDEO_SETTLEMENT_TIMEOUT_MARGIN_SECS
        );
        // ... and covers the full desktop polling window (360 x 2.5s).
        assert!(config.os_accounts.authorize_hold_ttl_video_secs >= VIDEO_CLIENT_POLL_WINDOW_SECS);
        // ... and still fits inside the OS Accounts platform cap.
        assert!(config.os_accounts.authorize_hold_ttl_video_secs <= OS_ACCOUNTS_MAX_HOLD_TTL_SECS);
        // The default ceiling is positive (a zero ceiling would reject every quote).
        assert_eq!(config.video_max_credits_per_request, 20_000);
        assert_eq!(
            config.video_max_response_bytes,
            DEFAULT_VIDEO_MAX_RESPONSE_BYTES
        );
    }

    #[test]
    fn validate_rejects_video_hold_ttl_below_job_budget() {
        let mut config = valid_config();
        config.os_accounts.authorize_hold_ttl_video_secs = DEFAULT_VIDEO_JOB_MAX_SECS;

        assert!(matches!(
            validate(&config),
            Err(ConfigError::InvalidRequired {
                field: "os_accounts.authorize_hold_ttl_video_secs",
                ..
            })
        ));
    }

    #[test]
    fn validate_rejects_video_hold_ttl_above_os_accounts_cap() {
        let mut config = valid_config();
        config.os_accounts.authorize_hold_ttl_video_secs = OS_ACCOUNTS_MAX_HOLD_TTL_SECS + 30;

        assert!(matches!(
            validate(&config),
            Err(ConfigError::InvalidRequired {
                field: "os_accounts.authorize_hold_ttl_video_secs",
                ..
            })
        ));
    }

    #[test]
    fn validate_passes_for_complete_config() {
        assert_eq!(validate(&valid_config()).is_ok(), true);
    }

    #[test]
    fn validate_rejects_missing_os_accounts_key() {
        let mut config = valid_config();
        config.os_accounts.app_api_key = String::new();

        let result = validate(&config);

        assert!(result.is_err());
    }

    #[test]
    fn validate_accepts_missing_p3a_ingest_token() {
        let mut config = valid_config();
        config.os_accounts.p3a_ingest_token = String::new();

        let result = validate(&config);

        assert!(
            result.is_ok(),
            "missing P3A ingest token must not fail validation: {result:?}"
        );
    }

    #[test]
    fn validate_rejects_schemeless_os_accounts_api_url() {
        let mut config = valid_config();
        config.os_accounts.api_url = "accounts.opensoftware.co/api".to_string();

        let result = validate(&config);

        assert!(matches!(
            result,
            Err(ConfigError::InvalidRequired {
                field: "os_accounts.api_url",
                reason: "must be an absolute http or https URL"
            })
        ));
    }

    #[test]
    fn validate_rejects_os_accounts_placeholder_keys() {
        for placeholder in OS_ACCOUNTS_APP_API_KEY_PLACEHOLDERS {
            let mut config = valid_config();
            config.os_accounts.app_api_key = (*placeholder).to_string();

            let result = validate(&config);

            assert!(result.is_err(), "accepted placeholder: {placeholder}");
        }
    }

    #[test]
    fn validate_rejects_provider_placeholder_keys() {
        for placeholder in OPENAI_API_KEY_PLACEHOLDERS {
            let mut config = valid_config();
            config.upstreams.openai.api_key = (*placeholder).to_string();

            let result = validate(&config);

            assert!(result.is_err(), "accepted placeholder: {placeholder}");
        }
        for placeholder in VENICE_API_KEY_PLACEHOLDERS {
            let mut config = valid_config();
            config.upstreams.venice.api_key = (*placeholder).to_string();

            let result = validate(&config);

            assert!(result.is_err(), "accepted placeholder: {placeholder}");
        }
    }

    #[test]
    fn validate_local_dev_skips_os_accounts_requirements() {
        let mut config = AppConfig::default();
        config.local_dev.enabled = true;
        config.upstreams.venice.api_key = "venice-test".to_string();

        let result = validate(&config);

        assert!(result.is_ok());
    }

    #[test]
    fn validate_local_dev_allows_missing_provider_keys() {
        let mut config = AppConfig::default();
        config.local_dev.enabled = true;
        config.upstreams.openai.api_key = String::new();
        config.upstreams.venice.api_key = "VENICE_API_KEY_REPLACE_ME".to_string();

        let result = validate(&config);

        assert!(result.is_ok());
    }

    #[test]
    fn validate_local_dev_rejects_blank_bearer_token() {
        let mut config = AppConfig::default();
        config.local_dev.enabled = true;
        config.local_dev.bearer_token = "  ".to_string();

        let result = validate(&config);

        assert!(result.is_err());
    }

    #[test]
    fn validate_local_dev_rejects_default_bearer_token_on_non_loopback_host() {
        let mut config = AppConfig::default();
        config.local_dev.enabled = true;
        config.server.host = "0.0.0.0".to_string();

        let result = validate(&config);

        assert!(result.is_err());
    }

    #[test]
    fn validate_local_dev_rejects_non_user_id() {
        let mut config = AppConfig::default();
        config.local_dev.enabled = true;
        config.local_dev.user_id = "local_dev".to_string();

        let result = validate(&config);

        assert!(result.is_err());
    }
}
