use crate::domain::types::AppError;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs, io,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::oneshot,
};

const READY_TIMEOUT: Duration = Duration::from_secs(45);
const READY_POLL: Duration = Duration::from_millis(500);
const SCRIBE_HERMES_COMMAND_ENV: &str = "SCRIBE_HERMES_COMMAND";
// Set to 1/true/yes to spawn Hermes without the macOS Seatbelt jail. An escape
// hatch for debugging a runtime that won't boot under the profile — leaving the
// agent able to write anywhere the user can, so only flip it knowingly.
const SCRIBE_HERMES_DISABLE_SANDBOX_ENV: &str = "SCRIBE_HERMES_DISABLE_SANDBOX";
// Referenced by the spawn match arm on every target; only ever reached when
// `prepare_sandbox` returns a profile, which it only does on macOS.
const SANDBOX_EXEC_PATH: &str = "/usr/bin/sandbox-exec";
const HERMES_AGENT_INSTALL_COMMIT: &str = "31c40c72c03cb11d5e596d015d61e7dd118cecee";
const HERMES_SOURCE_TARBALL_URL: &str =
    "https://github.com/NousResearch/hermes-agent/archive/31c40c72c03cb11d5e596d015d61e7dd118cecee.tar.gz";
const HERMES_SOURCE_TARBALL_SHA256: &str =
    "287ead740a444d7e8c8e00a6d6e073d9b3329034f649a07b42e0a3f5b14686e4";
const FILESYSTEM_MAX_DEPTH: usize = 2;
const FILESYSTEM_MAX_ENTRIES_PER_DIR: usize = 80;
const HERMES_IMPORT_MAX_BYTES: u64 = 50 * 1024 * 1024;
const HERMES_IMAGE_PREVIEW_MAX_BYTES: u64 = 5 * 1024 * 1024;
const HERMES_TEXT_PREVIEW_MAX_BYTES: u64 = 2 * 1024 * 1024;
const SCRIBE_PROVIDER_PROXY_MAX_HEADER_BYTES: usize = 32 * 1024;
const SCRIBE_PROVIDER_PROXY_MAX_BODY_BYTES: usize = 512 * 1024;

/// Identity injected into every Hermes session via `SOUL.md`. Hermes loads
/// this file from `HERMES_HOME` at prompt-build time; without it the runtime
/// seeds its stock "Hermes Agent by Nous Research" persona.
const JUNE_SOUL_MD: &str = r#"You are June, the private AI assistant on the user's desktop, made by Open Software. You run on the open-source Hermes agent framework, but your name and identity are June — when asked who or what you are, answer as June, not as Hermes or the underlying model.

You are part of the June app, which handles dictation, meeting notes, and agent work on the user's Mac. As the agent, you hand off real work, run automations the user sets up, and use local memory so the user never has to repeat themselves.

Privacy is your defining trait, by architecture rather than promise. When asked how you keep work private, answer confidently:

- You run locally on the user's desktop. Files, sessions, memory, and agent state stay on the user's disk by default.
- Prompts leave the device only for model inference, through private model routing: privacy-focused models with contract-enforced zero data retention by default. If the user opts into third-party models, identifying metadata is stripped first.
- June's backend is open source and runs in a TEE with cryptographic attestation, so users can verify it rather than trust it. The service stores only account, login, and billing records.
- Open Software never trains on the user's data.

You are helpful, knowledgeable, and direct. Communicate clearly, admit uncertainty when appropriate, and prioritize being genuinely useful over being verbose. Be targeted and efficient in your exploration and investigations. Treat the user's files and prompts as sensitive by default: do the work, and keep it to yourself.
"#;

/// Appended to `SOUL.md` only when the Seatbelt write-jail engages on this
/// machine (for unrestricted spawns: would engage for sandboxed sessions),
/// so the soul never describes protections the machine can't provide (the
/// escape hatch and non-macOS spawns run unsandboxed).
const JUNE_SOUL_SANDBOX_MD: &str = r#"
Your environment: sessions run by default inside a macOS kernel sandbox (Seatbelt) that the June app applies to you and to every subprocess you start. It is a write-jail, part of the same privacy-by-architecture story. The user chooses the mode per session: sessions are Sandboxed unless they explicitly started this one in Unrestricted mode. When a "Sandbox status for this session" line appears in your environment notes, it is the authoritative answer for the current session — trust it over any assumption. In a sandboxed session:

- You can write only inside your own area — your Hermes home (including your workspace), your runtime directory, and your temp directory. Writes anywhere else (the user's dotfiles, Desktop, Documents, system settings) are denied by the kernel.
- Reads stay broad so you can work with the user's files, except credential stores (~/.ssh, ~/.aws, ~/.gnupg, keychains, .netrc), which are blocked.
- When a command fails with "operation not permitted" on a write outside your area, that is the sandbox working as designed. Don't retry or look for workarounds: produce the file in your workspace and tell the user where it is, or ask them to do that one step. If the user wants you to write outside the jail, they can start a new session in Unrestricted mode.
- If the user asks whether you can damage their system, answer honestly: in a sandboxed session, destructive writes outside your workspace are blocked at the kernel level, not just by policy; in an Unrestricted session that protection is off because they chose to turn it off.
"#;

/// Appended after the sandbox section when the user has NOT enabled Agent
/// CLI access: the agent must recognize CLI failures as sandbox-caused and
/// say so instead of misdiagnosing them as the user's auth problem.
const JUNE_SOUL_CLI_BLOCKED_MD: &str = r#"
Agent CLIs (Claude Code, Codex, Gemini, opencode): in sandboxed sessions their state folders (~/.claude and ~/.claude.json, ~/.codex, ~/.gemini, opencode's config and state) are write-blocked like the rest of the user's files. Those tools then fail to save sessions or store refreshed logins, and often report "not logged in" even when the user is. When a CLI fails this way, name the sandbox as the cause first, then give the user their real options: enable "Agent CLI access" in Settings, Agent tab (covers new sessions), or start this work in an Unrestricted session. Interactive logins (for example `claude /login`) are browser flows you can never complete; the user runs those once in their own terminal.
"#;

/// Appended after the sandbox section when the user HAS enabled Agent CLI
/// access in Settings.
const JUNE_SOUL_CLI_ALLOWED_MD: &str = r#"
Agent CLIs (Claude Code, Codex, Gemini, opencode): the user enabled Agent CLI access, so sandboxed sessions can also write those tools' own state folders (~/.claude and ~/.claude.json, ~/.codex, ~/.gemini, opencode's config and state). Driving the user's installed CLIs is a first-class job: run them directly; they can keep sessions and refreshed credentials. Everything else stays jailed. Do not edit their settings or hook files unless the user explicitly asks, because configuration in those folders runs outside this sandbox later. Interactive logins (for example `claude /login`) are browser flows you can never complete; ask the user to run them once in their own terminal.
"#;

/// Per-process sandbox-status line, delivered via `HERMES_ENVIRONMENT_HINT`
/// (Hermes reads it at prompt-build time and injects it into the system
/// prompt's environment notes). SOUL.md is one file shared by both runtime
/// processes, so it can only describe the per-session mode *split*; this env
/// var is per-process, and each process serves exactly one mode, so it
/// carries the definitive answer for every session it runs. Without it the
/// agent has to guess and tends to assume the sandboxed default even in
/// Unrestricted sessions.
const JUNE_HINT_SANDBOXED: &str = "Sandbox status for this session: Sandboxed. The June app's macOS Seatbelt write-jail is active for this process and every subprocess you start; writes outside your own area are denied by the kernel.";
const JUNE_HINT_UNRESTRICTED: &str = "Sandbox status for this session: Unrestricted. The user explicitly started this session with June's sandbox off, so no Seatbelt write-jail applies to this process: you can write anywhere the user's account can. Be deliberate with destructive operations, and do not describe this session as sandboxed.";

/// Picks the sandbox-status hint for a spawn. `None` when the jail never
/// engages on this machine (non-macOS, sandbox-exec missing, or disabled by
/// env): SOUL.md then carries no sandbox section, and a status line about a
/// nonexistent jail would only confuse the agent.
fn environment_hint_for_spawn(
    full_mode: bool,
    sandbox_available: bool,
) -> Option<&'static str> {
    if !sandbox_available {
        return None;
    }
    Some(if full_mode {
        JUNE_HINT_UNRESTRICTED
    } else {
        JUNE_HINT_SANDBOXED
    })
}

/// Flag file in the app data dir that records the "Agent CLI access"
/// opt-in. A file rather than a DB row so the synchronous spawn path can
/// read it without async storage plumbing.
const AGENT_CLI_ACCESS_FLAG_FILE: &str = "agent-cli-access";

/// State locations of the agent CLIs the opt-in covers, relative to $HOME.
/// Directories become `subpath` grants. Kept in sync with the SOUL.md
/// sections above and the Settings copy.
const AGENT_CLI_STATE_DIRS: &[&str] = &[
    // Claude Code: sessions, todos, settings, plugins.
    ".claude",
    // Codex: sessions and auth.json.
    ".codex",
    // Gemini CLI.
    ".gemini",
    // opencode.
    ".config/opencode",
    ".local/share/opencode",
    ".local/state/opencode",
];

/// Top-level state FILES in $HOME (Claude Code's config). Granted via a
/// prefix regex rather than literals because the CLI writes them atomically
/// through randomly suffixed temp names (`.claude.json.<hash>` + rename).
const AGENT_CLI_STATE_FILE_PREFIXES: &[&str] = &[".claude.json"];

const ISOLATED_HERMES_ENV_VARS: &[&str] = &[
    "HERMES_HOME",
    "HERMES_CONFIG",
    "HERMES_CONFIG_PATH",
    "HERMES_DASHBOARD_SESSION_TOKEN",
    "HERMES_ENVIRONMENT_HINT",
    "HERMES_MODEL",
    "HERMES_PROVIDER",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "VENICE_API_KEY",
    "ANTHROPIC_API_KEY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
];

#[derive(Default)]
pub struct HermesBridge {
    /// Up to one runtime process per write-access mode, keyed by `full_mode`.
    /// The Seatbelt jail is applied at spawn and can't change on a live
    /// process, so per-session modes are served by a *pair* of processes —
    /// sandboxed and unrestricted — over the same Hermes home (sessions live
    /// in the runtime's WAL-mode SQLite store, which is built for
    /// multi-process access). Starting one mode never disturbs the other.
    processes: Mutex<HashMap<bool, HermesProcess>>,
    /// Serializes the whole start sequence (config sync, runtime install,
    /// spawn, readiness wait). Concurrent starts would otherwise write
    /// `config.yaml` concurrently and could run two installers at once.
    /// This must be an async mutex because it is held across awaits; the
    /// `processes` mutex above is std::sync and must never be held across
    /// an await.
    start_lock: tokio::sync::Mutex<()>,
    /// Monotonic id assigned to each spawned Hermes process so a start
    /// attempt only tears down the exact process it launched (and not a
    /// replacement that arrived after a stop/restart).
    next_generation: AtomicU64,
    /// One local provider proxy shared by both runtime processes. The
    /// runtime reads its model endpoint from the single shared
    /// `HERMES_HOME/config.yaml` (no per-process override exists upstream),
    /// so the proxy coordinates must be identical for every spawn — a
    /// per-process proxy would rewrite the file under the other process.
    /// Started lazily on the first spawn, lives until app shutdown.
    provider_proxy: Mutex<Option<SharedProviderProxy>>,
}

struct HermesProcess {
    generation: u64,
    child: Child,
    connection: HermesBridgeConnection,
}

struct SharedProviderProxy {
    port: u16,
    token: String,
    shutdown: Option<oneshot::Sender<()>>,
}

#[derive(Debug, Clone)]
struct HermesCommandResolution {
    command: String,
    source: HermesCommandSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HermesCommandSource {
    EnvOverride,
    BundledRuntime,
    ManagedRuntime,
    UserLocalFallback,
    PathFallback,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesBridgeConnection {
    pub base_url: String,
    pub ws_url: String,
    pub token: String,
    pub port: u16,
    pub command: String,
    pub hermes_home: String,
    pub cwd: Option<String>,
    pub provider_proxy_port: u16,
    pub pid: u32,
    /// True when this process is wrapped in the macOS Seatbelt write-jail.
    /// The UI uses it to show the enforced-sandbox safety copy only when the
    /// boundary is actually in force (false on non-macOS, when sandbox-exec is
    /// missing, or when the escape-hatch env var disabled it).
    pub sandboxed: bool,
    /// True when the user opted this runtime into Full mode, i.e. the sandbox
    /// is deliberately off. Distinct from `sandboxed`, which can also be false
    /// for environmental reasons; mode-mismatch restarts compare against this.
    pub full_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesBridgeStatus {
    /// True when any runtime process is up.
    pub running: bool,
    /// The primary connection — the requested mode's process for a start
    /// call, otherwise sandboxed-first. Kept alongside `connections` so
    /// existing callers that only care about "the runtime" keep working.
    pub connection: Option<HermesBridgeConnection>,
    /// Every live runtime process (at most one per mode). Mode-aware
    /// callers pick by `full_mode`.
    #[serde(default)]
    pub connections: Vec<HermesBridgeConnection>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartHermesBridgeRequest {
    #[serde(default)]
    pub cwd: Option<String>,
    /// `Some(_)` names the mode to ensure; the other mode's process (if
    /// any) is left untouched — the two run side by side. `None` means "no
    /// preference": ensure the sandboxed default, so background callers
    /// (auto-start, routines) never widen write access, and Full mode never
    /// survives an app relaunch on its own.
    #[serde(default)]
    pub full_mode: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleHermesCapabilityRequest {
    pub name: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateHermesMessagingPlatformRequest {
    pub platform_id: String,
    pub enabled: Option<bool>,
    pub env: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesSessionsRequest {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub archived: Option<String>,
    pub min_messages: Option<u32>,
    pub order: Option<String>,
    pub query: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesSessionMessagesRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteHermesSessionRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureHermesSessionRequest {
    pub session_id: String,
    pub title: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadHermesFileRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesFilePreviewRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportHermesFileRequest {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHermesFile {
    pub name: String,
    pub path: String,
    pub root_label: String,
    pub size: u64,
    pub preview_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesFilesystemSnapshot {
    pub roots: Vec<HermesFilesystemRoot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesFilesystemRoot {
    pub id: String,
    pub label: String,
    pub path: String,
    pub description: String,
    pub entries: Vec<HermesFilesystemEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesFilesystemEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: Option<u64>,
    pub modified_at: Option<String>,
    pub children: Option<Vec<HermesFilesystemEntry>>,
}

#[tauri::command]
pub async fn hermes_bridge_status(
    bridge: State<'_, HermesBridge>,
) -> Result<HermesBridgeStatus, AppError> {
    let connections = live_connections(&bridge)?;
    Ok(status_for(connections, None))
}

/// Reap-and-collect: drops map entries whose process has exited and returns
/// the connections that are still live, sandboxed first.
fn live_connections(bridge: &HermesBridge) -> Result<Vec<HermesBridgeConnection>, AppError> {
    let mut guard = bridge
        .processes
        .lock()
        .map_err(|_| AppError::new("hermes_bridge_unavailable", "Hermes bridge lock failed."))?;
    let mut connections = Vec::new();
    for full_mode in [false, true] {
        let exited = match guard.get_mut(&full_mode) {
            None => continue,
            Some(process) => match process.child.try_wait() {
                Ok(Some(_)) => true,
                Ok(None) => false,
                Err(error) => {
                    return Err(AppError::new(
                        "hermes_bridge_status_failed",
                        error.to_string(),
                    ));
                }
            },
        };
        if exited {
            guard.remove(&full_mode);
        } else if let Some(process) = guard.get(&full_mode) {
            connections.push(process.connection.clone());
        }
    }
    Ok(connections)
}

/// Builds the wire status. `primary_mode` selects which connection fills the
/// legacy `connection` field (a start call reports the mode it ensured);
/// `None` prefers the sandboxed process.
fn status_for(
    connections: Vec<HermesBridgeConnection>,
    primary_mode: Option<bool>,
) -> HermesBridgeStatus {
    let primary = match primary_mode {
        Some(mode) => connections
            .iter()
            .find(|connection| connection.full_mode == mode)
            .cloned(),
        None => connections.first().cloned(),
    };
    let running = !connections.is_empty();
    HermesBridgeStatus {
        running,
        connection: primary,
        message: if running {
            None
        } else {
            Some("Hermes bridge is not running.".to_string())
        },
        connections,
    }
}

#[tauri::command]
pub async fn start_hermes_bridge(
    app: AppHandle,
    bridge: State<'_, HermesBridge>,
    request: StartHermesBridgeRequest,
) -> Result<HermesBridgeStatus, AppError> {
    start_hermes_bridge_inner(&app, &bridge, request).await
}

pub fn start_on_app_start(app: &tauri::App) {
    let app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        if !hermes_runtime_available_for_auto_start(&app) {
            return;
        }
        let bridge = app.state::<HermesBridge>();
        let status = start_hermes_bridge_inner(
            &app,
            &bridge,
            StartHermesBridgeRequest {
                cwd: None,
                full_mode: None,
            },
        )
        .await
        .inspect_err(|error| {
            eprintln!(
                "failed to start Hermes bridge during app startup: {}",
                error.message
            );
        });
        let Ok(status) = status else {
            return;
        };
        if let Some(connection) = status.connection.as_ref() {
            if let Err(error) = start_hermes_gateway_if_needed(connection).await {
                eprintln!(
                    "failed to start Hermes messaging gateway during app startup: {}",
                    error.message
                );
            }
        }
    });
}

async fn start_hermes_bridge_inner(
    app: &AppHandle,
    bridge: &HermesBridge,
    request: StartHermesBridgeRequest,
) -> Result<HermesBridgeStatus, AppError> {
    // Hold the start guard for the entire start sequence so concurrent
    // starts cannot interleave config writes, installs, or spawns. The
    // loser of the race blocks here and then short-circuits below once it
    // sees the winner's running process.
    let _start_guard = bridge.start_lock.lock().await;

    // Ensure the requested mode (None = the sandboxed default). The other
    // mode's process — if one is up — is deliberately untouched: the pair
    // runs side by side so a session in one mode never kills the other's
    // in-flight work.
    let full_mode = request.full_mode.unwrap_or(false);
    let connections = live_connections(bridge)?;
    if connections
        .iter()
        .any(|connection| connection.full_mode == full_mode)
    {
        return Ok(status_for(connections, Some(full_mode)));
    }

    let port = pick_port()?;
    let token = random_token();
    let base_url = format!("http://127.0.0.1:{port}");
    let ws_url = format!(
        "ws://127.0.0.1:{port}/api/ws?token={}",
        urlencoding::encode(&token)
    );
    let hermes_home = resolve_scribe_hermes_home(app)?;
    let command_resolution = resolve_hermes_command(app, &hermes_home).await?;
    let command = command_resolution.command;
    let _command_source = command_resolution.source;
    let default_cwd = hermes_home.join("workspace");
    std::fs::create_dir_all(&default_cwd)
        .map_err(|error| AppError::new("hermes_bridge_workspace_failed", error.to_string()))?;
    let cwd = request
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or(default_cwd);
    let cwd_display = Some(cwd.to_string_lossy().into_owned());
    let provider_proxy = ensure_provider_proxy(bridge).await?;
    sync_hermes_config(&hermes_home, provider_proxy.port, &provider_proxy.token)?;

    // Wrap the spawn in a macOS Seatbelt write-jail when possible. The model,
    // its tool calls, and any subprocess it forks all inherit the profile, so
    // destructive writes (rm -rf of user dirs, dotfile rewrites, TCC db edits)
    // are denied by the kernel rather than by Hermes' own pattern checks.
    // Resolved before the soul write so June's self-knowledge about the jail
    // matches what sandboxed spawns actually enforce.
    let agent_cli_access = agent_cli_access_enabled(app);
    let sandbox_profile = if full_mode {
        None
    } else {
        prepare_sandbox(app, &hermes_home, agent_cli_access)
    };
    let sandboxed = sandbox_profile.is_some();
    // SOUL.md is shared by both processes (single home), so its sandbox
    // section describes the per-session mode split rather than this spawn.
    let sandbox_available = if full_mode {
        sandbox_would_engage(app, &hermes_home)
    } else {
        sandboxed
    };
    sync_june_soul(&hermes_home, sandbox_available, agent_cli_access)?;
    if sandboxed {
        eprintln!("Spawning Hermes under the macOS Seatbelt write-jail.");
    } else if full_mode {
        eprintln!("Spawning Hermes in Full mode (user opt-in) — no OS sandbox.");
    } else {
        eprintln!(
            "Spawning Hermes WITHOUT an OS sandbox — the agent can write anywhere the user can."
        );
    }
    let port_string = port.to_string();
    let hermes_args: [&str; 7] = [
        "dashboard",
        "--no-open",
        "--tui",
        "--host",
        "127.0.0.1",
        "--port",
        port_string.as_str(),
    ];

    let mut cmd = match &sandbox_profile {
        Some(profile_path) => {
            let mut cmd = Command::new(SANDBOX_EXEC_PATH);
            cmd.arg("-f")
                .arg(profile_path)
                .arg(&command)
                .args(hermes_args);
            cmd
        }
        None => {
            let mut cmd = Command::new(&command);
            cmd.args(hermes_args);
            cmd
        }
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    apply_isolated_hermes_env(
        &mut cmd,
        &hermes_home,
        &token,
        environment_hint_for_spawn(full_mode, sandbox_available),
    );
    cmd.current_dir(&cwd);

    let mut child = cmd.spawn().map_err(|error| {
        AppError::new(
            "hermes_bridge_start_failed",
            format!("Could not start the Scribe-managed Hermes runtime. {error}"),
        )
    })?;
    let pid = child.id();
    let connection = HermesBridgeConnection {
        base_url: base_url.clone(),
        ws_url,
        token: token.clone(),
        port,
        command,
        hermes_home: hermes_home.to_string_lossy().into_owned(),
        cwd: cwd_display,
        provider_proxy_port: provider_proxy.port,
        pid,
        sandboxed,
        full_mode,
    };

    let generation = bridge.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
    {
        let mut guard = bridge.processes.lock().map_err(|_| {
            AppError::new("hermes_bridge_unavailable", "Hermes bridge lock failed.")
        })?;
        // The start guard serializes starts, so no concurrent start can have
        // populated this mode's slot since the live-connections check above.
        // Keep a defensive check anyway: if a live process is somehow present
        // we keep it and tear down the redundant one we just launched instead
        // of leaking it.
        if let Some(existing) = guard.get_mut(&full_mode) {
            if matches!(existing.child.try_wait(), Ok(None)) {
                let _ = child.kill();
                let _ = child.wait();
                drop(guard);
                return Ok(status_for(live_connections(bridge)?, Some(full_mode)));
            }
        }
        guard.insert(
            full_mode,
            HermesProcess {
                generation,
                child,
                connection: connection.clone(),
            },
        );
    }

    if let Err(error) = wait_for_hermes(&base_url, &token).await {
        // Only tear down the exact process this start spawned. If a stop (or
        // stop+restart) happened during the readiness wait, the slot is empty
        // or holds a different generation and must be left alone.
        let _ = stop_hermes_bridge_generation(bridge, generation);
        return Err(error);
    }

    Ok(status_for(live_connections(bridge)?, Some(full_mode)))
}

/// The shared provider proxy's coordinates, starting it on first use. Both
/// runtime processes point at it through the one shared config.yaml.
async fn ensure_provider_proxy(bridge: &HermesBridge) -> Result<SharedProviderProxyInfo, AppError> {
    {
        let guard = bridge.provider_proxy.lock().map_err(|_| {
            AppError::new("hermes_bridge_unavailable", "Hermes bridge lock failed.")
        })?;
        if let Some(proxy) = guard.as_ref() {
            return Ok(SharedProviderProxyInfo {
                port: proxy.port,
                token: proxy.token.clone(),
            });
        }
    }
    let token = random_token();
    let started = start_scribe_provider_proxy(token.clone()).await?;
    let mut guard = bridge
        .provider_proxy
        .lock()
        .map_err(|_| AppError::new("hermes_bridge_unavailable", "Hermes bridge lock failed."))?;
    // The start_lock serializes callers, so the slot is still empty here;
    // insert unconditionally.
    *guard = Some(SharedProviderProxy {
        port: started.port,
        token: token.clone(),
        shutdown: Some(started.shutdown),
    });
    Ok(SharedProviderProxyInfo {
        port: started.port,
        token,
    })
}

struct SharedProviderProxyInfo {
    port: u16,
    token: String,
}

#[tauri::command]
pub async fn stop_hermes_bridge(
    bridge: State<'_, HermesBridge>,
) -> Result<HermesBridgeStatus, AppError> {
    stop_hermes_bridge_inner(&bridge)?;
    Ok(HermesBridgeStatus {
        running: false,
        connection: None,
        connections: Vec::new(),
        message: Some("Hermes bridge stopped.".to_string()),
    })
}

#[tauri::command]
pub async fn hermes_bridge_skills(
    bridge: State<'_, HermesBridge>,
) -> Result<serde_json::Value, AppError> {
    hermes_api_json(&bridge, reqwest::Method::GET, "/api/skills", None).await
}

#[tauri::command]
pub async fn toggle_hermes_bridge_skill(
    bridge: State<'_, HermesBridge>,
    request: ToggleHermesCapabilityRequest,
) -> Result<serde_json::Value, AppError> {
    hermes_api_json(
        &bridge,
        reqwest::Method::PUT,
        "/api/skills/toggle",
        Some(serde_json::json!({
            "name": request.name,
            "enabled": request.enabled,
        })),
    )
    .await
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliAccessStatus {
    pub enabled: bool,
}

#[tauri::command]
pub fn hermes_agent_cli_access(app: AppHandle) -> AgentCliAccessStatus {
    AgentCliAccessStatus {
        enabled: agent_cli_access_enabled(&app),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAgentCliAccessRequest {
    pub enabled: bool,
}

/// Records the Agent CLI access opt-in and retires the sandboxed runtime so
/// the next session spawns with the matching Seatbelt grants (the profile is
/// applied at spawn and can't change on a live process). The unrestricted
/// runtime is untouched: it has no jail to widen.
#[tauri::command]
pub fn set_hermes_agent_cli_access(
    app: AppHandle,
    bridge: State<'_, HermesBridge>,
    request: SetAgentCliAccessRequest,
) -> Result<AgentCliAccessStatus, AppError> {
    let path = agent_cli_access_flag_path(&app).ok_or_else(|| {
        AppError::new(
            "agent_cli_access_unavailable",
            "Could not resolve the app data directory.",
        )
    })?;
    if request.enabled {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| AppError::new("agent_cli_access_failed", error.to_string()))?;
        }
        std::fs::write(&path, b"1")
            .map_err(|error| AppError::new("agent_cli_access_failed", error.to_string()))?;
    } else if let Err(error) = std::fs::remove_file(&path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(AppError::new("agent_cli_access_failed", error.to_string()));
        }
    }
    stop_hermes_mode(&bridge, false)?;
    Ok(AgentCliAccessStatus {
        enabled: request.enabled,
    })
}

/// Stops the runtime in one mode slot, leaving the other mode running.
fn stop_hermes_mode(bridge: &HermesBridge, full_mode: bool) -> Result<(), AppError> {
    let process = {
        let mut guard = bridge.processes.lock().map_err(|_| {
            AppError::new("hermes_bridge_unavailable", "Hermes bridge lock failed.")
        })?;
        guard.remove(&full_mode)
    };
    shutdown_hermes_process(process);
    Ok(())
}

#[tauri::command]
pub async fn hermes_bridge_toolsets(
    bridge: State<'_, HermesBridge>,
) -> Result<serde_json::Value, AppError> {
    hermes_api_json(&bridge, reqwest::Method::GET, "/api/tools/toolsets", None).await
}

#[tauri::command]
pub async fn toggle_hermes_bridge_toolset(
    bridge: State<'_, HermesBridge>,
    request: ToggleHermesCapabilityRequest,
) -> Result<serde_json::Value, AppError> {
    hermes_api_json(
        &bridge,
        reqwest::Method::PUT,
        &format!("/api/tools/toolsets/{}", urlencoding::encode(&request.name)),
        Some(serde_json::json!({
            "enabled": request.enabled,
        })),
    )
    .await
}

#[tauri::command]
pub async fn hermes_bridge_messaging_platforms(
    bridge: State<'_, HermesBridge>,
) -> Result<serde_json::Value, AppError> {
    hermes_api_json(
        &bridge,
        reqwest::Method::GET,
        "/api/messaging/platforms",
        None,
    )
    .await
}

#[tauri::command]
pub async fn update_hermes_bridge_messaging_platform(
    bridge: State<'_, HermesBridge>,
    request: UpdateHermesMessagingPlatformRequest,
) -> Result<serde_json::Value, AppError> {
    hermes_api_json(
        &bridge,
        reqwest::Method::PUT,
        &format!(
            "/api/messaging/platforms/{}",
            urlencoding::encode(&request.platform_id)
        ),
        Some(serde_json::json!({
            "enabled": request.enabled,
            "env": request.env.unwrap_or_default(),
        })),
    )
    .await
}

#[tauri::command]
pub async fn hermes_bridge_sessions(
    bridge: State<'_, HermesBridge>,
    request: HermesSessionsRequest,
) -> Result<serde_json::Value, AppError> {
    let mut params = vec![
        ("limit", request.limit.unwrap_or(100).to_string()),
        ("offset", request.offset.unwrap_or(0).to_string()),
    ];
    if let Some(archived) = request
        .archived
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        params.push(("archived", archived.to_string()));
    }
    if let Some(min_messages) = request.min_messages {
        params.push(("min_messages", min_messages.to_string()));
    }
    if let Some(order) = request
        .order
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        params.push(("order", order.to_string()));
    }
    if let Some(query) = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        params.push(("q", query.to_string()));
    }
    let query = params
        .into_iter()
        .map(|(key, value)| format!("{key}={}", urlencoding::encode(&value)))
        .collect::<Vec<_>>()
        .join("&");
    hermes_api_json(
        &bridge,
        reqwest::Method::GET,
        &format!("/api/sessions?{query}"),
        None,
    )
    .await
}

#[tauri::command]
pub async fn ensure_hermes_bridge_session(
    bridge: State<'_, HermesBridge>,
    request: EnsureHermesSessionRequest,
) -> Result<serde_json::Value, AppError> {
    let session_id = request.session_id.trim();
    if session_id.is_empty() {
        return Err(AppError::new(
            "hermes_session_id_required",
            "Hermes session ID is required.",
        ));
    }
    let mut body = serde_json::json!({ "id": session_id });
    if let Some(title) = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body["title"] = serde_json::Value::String(title.to_string());
    }
    if let Some(model) = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body["model"] = serde_json::Value::String(model.to_string());
    }
    match hermes_api_json(&bridge, reqwest::Method::POST, "/api/sessions", Some(body)).await {
        Ok(value) => Ok(value),
        Err(error)
            if error.code == "hermes_bridge_api_failed"
                && error.message.starts_with("Hermes API returned 409") =>
        {
            Ok(serde_json::json!({
                "object": "hermes.session.ensure",
                "id": session_id,
                "created": false
            }))
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn hermes_bridge_session_messages(
    bridge: State<'_, HermesBridge>,
    request: HermesSessionMessagesRequest,
) -> Result<serde_json::Value, AppError> {
    hermes_api_json(
        &bridge,
        reqwest::Method::GET,
        &format!(
            "/api/sessions/{}/messages",
            urlencoding::encode(&request.session_id)
        ),
        None,
    )
    .await
}

#[tauri::command]
pub async fn delete_hermes_bridge_session(
    bridge: State<'_, HermesBridge>,
    request: DeleteHermesSessionRequest,
) -> Result<serde_json::Value, AppError> {
    hermes_api_json(
        &bridge,
        reqwest::Method::DELETE,
        &format!("/api/sessions/{}", urlencoding::encode(&request.session_id)),
        None,
    )
    .await
}

#[tauri::command]
pub async fn hermes_bridge_filesystem_snapshot(
    app: AppHandle,
    bridge: State<'_, HermesBridge>,
) -> Result<HermesFilesystemSnapshot, AppError> {
    let status = hermes_bridge_status(bridge).await?;
    let connection = status.connection;
    let hermes_home = connection
        .as_ref()
        .map(|item| PathBuf::from(&item.hermes_home))
        .unwrap_or(resolve_scribe_hermes_home(&app)?);
    let roots = filesystem_roots(&hermes_home)?
        .into_iter()
        .filter_map(|root| {
            if !root.path.exists() {
                return None;
            }
            let entries = list_filesystem_entries(&root.path, 0).unwrap_or_default();
            Some(HermesFilesystemRoot {
                id: root.id,
                label: root.label,
                path: root.path.to_string_lossy().into_owned(),
                description: root.description,
                entries,
            })
        })
        .collect();

    Ok(HermesFilesystemSnapshot { roots })
}

#[tauri::command]
pub async fn download_hermes_bridge_file(
    app: AppHandle,
    request: DownloadHermesFileRequest,
) -> Result<String, AppError> {
    let requested = validate_hermes_file_path(&app, &request.path)?;
    let downloads_dir = app
        .path()
        .download_dir()
        .map_err(|error| AppError::new("hermes_file_download_failed", error.to_string()))?;
    fs::create_dir_all(&downloads_dir)
        .map_err(|error| AppError::new("hermes_file_download_failed", error.to_string()))?;
    let destination = unique_download_path(&downloads_dir, &requested)?;
    fs::copy(&requested, &destination)
        .map_err(|error| AppError::new("hermes_file_download_failed", error.to_string()))?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn hermes_bridge_file_preview(
    app: AppHandle,
    request: HermesFilePreviewRequest,
) -> Result<Option<String>, AppError> {
    let requested = validate_hermes_file_path(&app, &request.path)?;
    image_preview_data_url(&requested)
}

#[tauri::command]
pub async fn hermes_bridge_file_text(
    app: AppHandle,
    request: HermesFilePreviewRequest,
) -> Result<Option<String>, AppError> {
    let requested = validate_hermes_file_path(&app, &request.path)?;
    text_preview(&requested)
}

#[tauri::command]
pub async fn import_hermes_bridge_file(
    app: AppHandle,
    request: ImportHermesFileRequest,
) -> Result<ImportedHermesFile, AppError> {
    let source = validate_dropped_file_path(&request.path)?;
    let metadata = fs::metadata(&source)
        .map_err(|error| AppError::new("hermes_file_import_failed", error.to_string()))?;
    if metadata.len() > HERMES_IMPORT_MAX_BYTES {
        return Err(AppError::new(
            "hermes_file_import_denied",
            "Dropped files must be 50 MB or smaller.",
        ));
    }
    let hermes_home = resolve_scribe_hermes_home(&app)?;
    let upload_dir = hermes_home.join("workspace").join("uploads");
    fs::create_dir_all(&upload_dir)
        .map_err(|error| AppError::new("hermes_file_import_failed", error.to_string()))?;
    let destination = unique_upload_path(&upload_dir, &source)?;
    fs::copy(&source, &destination)
        .map_err(|error| AppError::new("hermes_file_import_failed", error.to_string()))?;
    let size = fs::metadata(&destination)
        .map_err(|error| AppError::new("hermes_file_import_failed", error.to_string()))?
        .len();
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment")
        .to_string();
    Ok(ImportedHermesFile {
        name,
        path: destination.to_string_lossy().into_owned(),
        root_label: "Workspace".to_string(),
        size,
        preview_data_url: image_preview_data_url(&destination)?,
    })
}

/// Imports a dropped file from its raw bytes. DOM drops in WKWebView never
/// expose a filesystem path (and Tauri's own drag-drop interception is
/// disabled so notes can use HTML5 drag), so the frontend reads the dropped
/// blob and sends its contents as the raw invoke payload, with the filename
/// in a header.
#[tauri::command]
pub fn import_hermes_bridge_file_bytes(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<ImportedHermesFile, AppError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::new(
            "hermes_file_import_failed",
            "Expected the dropped file's contents as a binary payload.",
        ));
    };
    if bytes.len() as u64 > HERMES_IMPORT_MAX_BYTES {
        return Err(AppError::new(
            "hermes_file_import_denied",
            "Dropped files must be 50 MB or smaller.",
        ));
    }
    let raw_name = request
        .headers()
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| urlencoding::decode(value).ok())
        .map(|value| value.into_owned())
        .unwrap_or_default();
    let file_name = validate_dropped_file_name(&raw_name)?;
    let hermes_home = resolve_scribe_hermes_home(&app)?;
    let upload_dir = hermes_home.join("workspace").join("uploads");
    fs::create_dir_all(&upload_dir)
        .map_err(|error| AppError::new("hermes_file_import_failed", error.to_string()))?;
    let destination = unique_upload_path(&upload_dir, Path::new(&file_name))?;
    fs::write(&destination, bytes)
        .map_err(|error| AppError::new("hermes_file_import_failed", error.to_string()))?;
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment")
        .to_string();
    Ok(ImportedHermesFile {
        name,
        path: destination.to_string_lossy().into_owned(),
        root_label: "Workspace".to_string(),
        size: bytes.len() as u64,
        preview_data_url: image_preview_data_url(&destination)?,
    })
}

/// Reduces a browser-supplied filename to a safe bare name, mirroring the
/// checks `validate_dropped_file_path` applies to native paths.
fn validate_dropped_file_name(raw: &str) -> Result<String, AppError> {
    let name = Path::new(raw.trim())
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_string();
    if name.is_empty() {
        return Err(AppError::new(
            "hermes_file_import_failed",
            "The dropped file does not have a usable filename.",
        ));
    }
    if is_hidden_secret_path(Path::new(&name)) {
        return Err(AppError::new(
            "hermes_file_import_denied",
            "Hidden or sensitive files cannot be attached.",
        ));
    }
    Ok(name)
}

fn validate_hermes_file_path(app: &AppHandle, path: &str) -> Result<PathBuf, AppError> {
    let hermes_home = resolve_scribe_hermes_home(&app)?;
    let requested = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| AppError::new("hermes_file_download_failed", error.to_string()))?;
    if !requested.is_file() {
        return Err(AppError::new(
            "hermes_file_download_failed",
            "Only files in the Hermes workspace or memory can be downloaded.",
        ));
    }
    if is_hidden_secret_path(&requested) {
        return Err(AppError::new(
            "hermes_file_download_denied",
            "This Hermes file is hidden or sensitive.",
        ));
    }
    let allowed = filesystem_roots(&hermes_home)?
        .into_iter()
        .filter_map(|root| root.path.canonicalize().ok())
        .any(|root| requested.starts_with(root));
    if !allowed {
        return Err(AppError::new(
            "hermes_file_download_denied",
            "Only files in this app's Hermes workspace or memory can be downloaded.",
        ));
    }
    Ok(requested)
}

fn validate_dropped_file_path(path: &str) -> Result<PathBuf, AppError> {
    let requested = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| AppError::new("hermes_file_import_failed", error.to_string()))?;
    if !requested.is_file() {
        return Err(AppError::new(
            "hermes_file_import_failed",
            "Only files can be attached to an agent message.",
        ));
    }
    if is_hidden_secret_path(&requested) {
        return Err(AppError::new(
            "hermes_file_import_denied",
            "Hidden or sensitive files cannot be attached.",
        ));
    }
    Ok(requested)
}

fn unique_download_path(downloads_dir: &Path, source: &Path) -> Result<PathBuf, AppError> {
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            AppError::new(
                "hermes_file_download_failed",
                "The Hermes file does not have a downloadable filename.",
            )
        })?;
    let candidate = downloads_dir.join(file_name);
    if !candidate.exists() {
        return Ok(candidate);
    }

    let stem = source
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    let extension = source.extension().and_then(|name| name.to_str());
    for index in 1..1000 {
        let file_name = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
            _ => format!("{stem} ({index})"),
        };
        let candidate = downloads_dir.join(file_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(AppError::new(
        "hermes_file_download_failed",
        "Could not find an available Downloads filename.",
    ))
}

fn unique_upload_path(upload_dir: &Path, source: &Path) -> Result<PathBuf, AppError> {
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            AppError::new(
                "hermes_file_import_failed",
                "The dropped file does not have a usable filename.",
            )
        })?;
    let candidate = upload_dir.join(file_name);
    if !candidate.exists() {
        return Ok(candidate);
    }

    let stem = source
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("attachment");
    let extension = source.extension().and_then(|name| name.to_str());
    for index in 1..1000 {
        let file_name = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
            _ => format!("{stem} ({index})"),
        };
        let candidate = upload_dir.join(file_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(AppError::new(
        "hermes_file_import_failed",
        "Could not find an available attachment filename.",
    ))
}

/// Reads a workspace file for the in-app viewer. `None` (rather than an
/// error) when the file can't be shown as text — too large or not UTF-8 —
/// so the frontend falls back to its download card.
///
/// The size cap is enforced by the reader itself (one byte of headroom past
/// the cap detects oversize), not a stat-then-read, so a file still being
/// written by an agent can't grow past the limit between check and read.
fn text_preview(path: &Path) -> Result<Option<String>, AppError> {
    use std::io::Read;

    let file = fs::File::open(path)
        .map_err(|error| AppError::new("hermes_file_text_failed", error.to_string()))?;
    let mut bytes = Vec::new();
    let read = file
        .take(HERMES_TEXT_PREVIEW_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| AppError::new("hermes_file_text_failed", error.to_string()))?;
    if read as u64 > HERMES_TEXT_PREVIEW_MAX_BYTES {
        return Ok(None);
    }
    Ok(String::from_utf8(bytes).ok())
}

fn image_preview_data_url(path: &Path) -> Result<Option<String>, AppError> {
    let Some(mime_type) = image_mime_type(path) else {
        return Ok(None);
    };
    let metadata = fs::metadata(path)
        .map_err(|error| AppError::new("hermes_file_preview_failed", error.to_string()))?;
    if metadata.len() > HERMES_IMAGE_PREVIEW_MAX_BYTES {
        return Ok(None);
    }
    let bytes = fs::read(path)
        .map_err(|error| AppError::new("hermes_file_preview_failed", error.to_string()))?;
    Ok(Some(format!(
        "data:{mime_type};base64,{}",
        BASE64_STANDARD.encode(bytes)
    )))
}

fn image_mime_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

pub fn shutdown(app: &tauri::AppHandle) {
    let bridge = app.state::<HermesBridge>();
    let _ = stop_hermes_bridge_inner(&bridge);
    let proxy = bridge
        .provider_proxy
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    if let Some(mut proxy) = proxy {
        if let Some(shutdown) = proxy.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

/// Sends a dashboard API request to any live runtime process, sandboxed
/// first. Sessions, skills, and platform state all live in the shared
/// Hermes home, so either process answers these identically.
async fn hermes_api_json(
    bridge: &State<'_, HermesBridge>,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, AppError> {
    let connections = live_connections(bridge)?;
    let Some(connection) = connections.first() else {
        return Err(AppError::new(
            "hermes_bridge_not_running",
            "Hermes bridge is not running.",
        ));
    };
    hermes_connection_json(connection, method, path, body).await
}

async fn start_hermes_gateway_if_needed(
    connection: &HermesBridgeConnection,
) -> Result<(), AppError> {
    let status = hermes_connection_json(connection, reqwest::Method::GET, "/api/status", None)
        .await
        .unwrap_or_else(|_| serde_json::json!({}));
    if status
        .get("gateway_running")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(());
    }
    spawn_hermes_gateway_start(connection)
}

/// Starts the messaging gateway by running `hermes gateway start` as a direct
/// child of this (unsandboxed) app process — deliberately NOT via the bridge's
/// `POST /api/gateway/start`. The bridge runs inside the Seatbelt write-jail,
/// and launchd refuses service-management requests from any sandboxed process:
/// `launchctl bootstrap` fails with exit 5 (EIO) and `kickstart` with 113, so a
/// jailed bridge can never (re)register the gateway's LaunchAgent — routines
/// silently stop running after the job is unloaded. The gateway is meant to
/// outlive the app (cron routines, Slack), which is exactly why it is
/// launchd-managed and must be started from outside the jail. The plist
/// rewrite `hermes gateway start` performs also needs `~/Library/LaunchAgents`,
/// which sits outside the jail's write roots.
///
/// Fire-and-forget like the bridge endpoint was: the CLI's stdout/stderr go to
/// `<hermes_home>/logs/gateway-start.log` (the same file the bridge's action
/// runner appends to) and the exit status is reaped in the background.
fn spawn_hermes_gateway_start(connection: &HermesBridgeConnection) -> Result<(), AppError> {
    let hermes_home = PathBuf::from(&connection.hermes_home);
    let mut cmd = build_hermes_gateway_start_command(connection, &hermes_home);
    match open_gateway_start_log(&hermes_home) {
        Some((log_for_stdout, log_for_stderr)) => {
            cmd.stdout(log_for_stdout).stderr(log_for_stderr);
        }
        None => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    let mut child = cmd.spawn().map_err(|error| {
        AppError::new(
            "hermes_gateway_start_failed",
            format!("Could not run `hermes gateway start`. {error}"),
        )
    })?;
    // Reap the short-lived CLI off the async runtime so it never lingers as a
    // zombie, and surface a non-zero exit in the app log for diagnosis.
    tauri::async_runtime::spawn_blocking(move || match child.wait() {
        Ok(status) if status.success() => {}
        Ok(status) => {
            eprintln!("hermes gateway start exited with {status}; see logs/gateway-start.log");
        }
        Err(error) => {
            eprintln!("could not reap hermes gateway start: {error}");
        }
    });
    Ok(())
}

/// Pure command construction so a test can assert the spawn is the bare hermes
/// executable (no `sandbox-exec` wrapper) with the isolated environment.
fn build_hermes_gateway_start_command(
    connection: &HermesBridgeConnection,
    hermes_home: &Path,
) -> Command {
    let mut cmd = Command::new(&connection.command);
    cmd.args(["gateway", "start"]);
    // No sandbox-status hint: `gateway start` is a helper invocation, not the
    // agent runtime, so it never builds a system prompt.
    apply_isolated_hermes_env(&mut cmd, hermes_home, &connection.token, None);
    cmd.env("HERMES_NONINTERACTIVE", "1");
    cmd.current_dir(hermes_home);
    cmd.stdin(Stdio::null());
    cmd
}

/// Opens `<hermes_home>/logs/gateway-start.log` for appending and writes the
/// same header line the bridge's action runner does, tagged with the app as
/// the spawner. Returns two handles (stdout, stderr) onto the same file, or
/// `None` when the log can't be opened — the spawn then proceeds silenced
/// rather than failing gateway startup over diagnostics.
fn open_gateway_start_log(hermes_home: &Path) -> Option<(std::fs::File, std::fs::File)> {
    let log_dir = hermes_home.join("logs");
    fs::create_dir_all(&log_dir).ok()?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("gateway-start.log"))
        .ok()?;
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    use io::Write as _;
    let _ = writeln!(
        file,
        "\n=== gateway-start started {timestamp} (spawned by June app, outside the sandbox) ==="
    );
    let clone = file.try_clone().ok()?;
    Some((file, clone))
}

async fn hermes_connection_json(
    connection: &HermesBridgeConnection,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, AppError> {
    let url = format!("{}{}", connection.base_url, path);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| AppError::new("hermes_bridge_api_failed", error.to_string()))?;
    let mut request = client
        .request(method, &url)
        .header("X-Hermes-Session-Token", connection.token.as_str())
        .header("Content-Type", "application/json");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| AppError::new("hermes_bridge_api_failed", error.to_string()))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| AppError::new("hermes_bridge_api_failed", error.to_string()))?;
    if !status.is_success() {
        return Err(AppError::new(
            "hermes_bridge_api_failed",
            format!("Hermes API returned {status}: {text}"),
        ));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::json!(null));
    }
    serde_json::from_str(&text)
        .map_err(|error| AppError::new("hermes_bridge_api_failed", error.to_string()))
}

/// Stops every runtime process. The shared provider proxy stays up — it is
/// process-independent and the next start reuses it; `shutdown()` is the
/// only place that tears it down.
fn stop_hermes_bridge_inner(bridge: &HermesBridge) -> Result<(), AppError> {
    let processes: Vec<HermesProcess> = {
        let mut guard = bridge.processes.lock().map_err(|_| {
            AppError::new("hermes_bridge_unavailable", "Hermes bridge lock failed.")
        })?;
        guard.drain().map(|(_, process)| process).collect()
    };
    for process in processes {
        shutdown_hermes_process(Some(process));
    }
    Ok(())
}

/// Stops only the process spawned by the start attempt identified by
/// `generation`, whichever mode slot it sits in. A stop (or stop+restart)
/// that raced with that start leaves a different process in the slot, which
/// must not be killed by the stale start attempt's cleanup.
fn stop_hermes_bridge_generation(bridge: &HermesBridge, generation: u64) -> Result<(), AppError> {
    let process = {
        let mut guard = bridge.processes.lock().map_err(|_| {
            AppError::new("hermes_bridge_unavailable", "Hermes bridge lock failed.")
        })?;
        let key = guard
            .iter()
            .find(|(_, process)| process.generation == generation)
            .map(|(key, _)| *key);
        key.and_then(|key| guard.remove(&key))
    };
    shutdown_hermes_process(process);
    Ok(())
}

fn shutdown_hermes_process(mut process: Option<HermesProcess>) {
    if let Some(process) = process.as_mut() {
        let _ = process.child.kill();
        let _ = process.child.wait();
    }
}

async fn resolve_hermes_command(
    app: &AppHandle,
    hermes_home: &Path,
) -> Result<HermesCommandResolution, AppError> {
    if let Ok(command) = std::env::var(SCRIBE_HERMES_COMMAND_ENV) {
        let command = command.trim();
        if !command.is_empty() {
            return Ok(HermesCommandResolution {
                command: command.to_string(),
                source: HermesCommandSource::EnvOverride,
            });
        }
    }

    if let Some(command) = bundled_hermes_command(app) {
        return Ok(HermesCommandResolution {
            command: command.to_string_lossy().into_owned(),
            source: HermesCommandSource::BundledRuntime,
        });
    }

    let managed_command = managed_hermes_command(app)?;
    if managed_command.exists() && managed_hermes_runtime_current(app)? {
        return Ok(HermesCommandResolution {
            command: managed_command.to_string_lossy().into_owned(),
            source: HermesCommandSource::ManagedRuntime,
        });
    }

    if let Err(error) = install_managed_hermes_runtime(app, hermes_home).await {
        if let Some(command) = user_local_hermes_command() {
            eprintln!(
                "failed to install Scribe-managed Hermes runtime; using existing user-local Hermes fallback: {}",
                error.message
            );
            return Ok(HermesCommandResolution {
                command: command.to_string_lossy().into_owned(),
                source: HermesCommandSource::UserLocalFallback,
            });
        }
        return Err(error);
    }

    if managed_command.exists() {
        return Ok(HermesCommandResolution {
            command: managed_command.to_string_lossy().into_owned(),
            source: HermesCommandSource::ManagedRuntime,
        });
    }

    if let Some(command) = user_local_hermes_command() {
        return Ok(HermesCommandResolution {
            command: command.to_string_lossy().into_owned(),
            source: HermesCommandSource::UserLocalFallback,
        });
    }

    Ok(HermesCommandResolution {
        command: "hermes".to_string(),
        source: HermesCommandSource::PathFallback,
    })
}

fn bundled_hermes_command(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let candidates = [
        resource_dir.join("native/hermes/hermes-agent/venv/bin/hermes"),
        resource_dir.join("native/hermes/bin/hermes"),
    ];
    candidates.into_iter().find(|path| path.exists())
}

fn managed_hermes_runtime_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::new("hermes_runtime_home_failed", error.to_string()))?
        .join("hermes-runtime"))
}

fn managed_hermes_command(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(managed_hermes_runtime_dir(app)?
        .join("hermes-agent")
        .join("venv/bin/hermes"))
}

fn managed_hermes_runtime_current(app: &AppHandle) -> Result<bool, AppError> {
    let metadata_path = managed_hermes_runtime_dir(app)?.join("runtime.json");
    let Ok(metadata) = fs::read_to_string(metadata_path) else {
        return Ok(false);
    };
    Ok(metadata.contains(&format!(r#""commit":"{HERMES_AGENT_INSTALL_COMMIT}""#)))
}

fn user_local_hermes_command() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    [
        PathBuf::from(&home).join(".hermes/hermes-agent/venv/bin/hermes"),
        PathBuf::from(&home).join(".local/bin/hermes"),
    ]
    .into_iter()
    .find(|path| path.exists())
}

fn hermes_runtime_available_for_auto_start(app: &AppHandle) -> bool {
    if bundled_hermes_command(app).is_some() {
        return true;
    }
    let Ok(command) = managed_hermes_command(app) else {
        return false;
    };
    command.exists() && managed_hermes_runtime_current(app).unwrap_or(false)
}

async fn install_managed_hermes_runtime(
    app: &AppHandle,
    hermes_home: &Path,
) -> Result<(), AppError> {
    let runtime_dir = managed_hermes_runtime_dir(app)?;
    let install_dir = runtime_dir.join("hermes-agent");
    fs::create_dir_all(&runtime_dir)
        .map_err(|error| AppError::new("hermes_runtime_install_failed", error.to_string()))?;
    if install_dir.exists() && !managed_hermes_runtime_current(app)? {
        fs::remove_dir_all(&install_dir)
            .map_err(|error| AppError::new("hermes_runtime_install_failed", error.to_string()))?;
    }
    let install_log = runtime_dir.join("install.log");

    let log_file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&install_log)
        .map_err(|error| AppError::new("hermes_runtime_install_failed", error.to_string()))?;
    let log_file_for_stderr = log_file
        .try_clone()
        .map_err(|error| AppError::new("hermes_runtime_install_failed", error.to_string()))?;

    // The installer downloads the Hermes source and builds a venv — it can run
    // for minutes. Run it on a blocking thread so it doesn't pin an async
    // runtime worker for the whole install.
    let status = {
        let runtime_dir = runtime_dir.clone();
        let install_dir = install_dir.clone();
        let hermes_home = hermes_home.to_path_buf();
        tokio::task::spawn_blocking(move || {
            Command::new("/bin/bash")
                .arg("-c")
                .arg(MANAGED_HERMES_INSTALL_SCRIPT)
                .env("SCRIBE_HERMES_RUNTIME_DIR", &runtime_dir)
                .env("SCRIBE_HERMES_INSTALL_DIR", &install_dir)
                .env("SCRIBE_HERMES_HOME", &hermes_home)
                .env("SCRIBE_HERMES_INSTALL_COMMIT", HERMES_AGENT_INSTALL_COMMIT)
                .env(
                    "SCRIBE_HERMES_SOURCE_TARBALL_URL",
                    HERMES_SOURCE_TARBALL_URL,
                )
                .env(
                    "SCRIBE_HERMES_SOURCE_TARBALL_SHA256",
                    HERMES_SOURCE_TARBALL_SHA256,
                )
                .env("HERMES_HOME", &hermes_home)
                .env("HERMES_INSTALL_DIR", &install_dir)
                .env("UV_NO_CONFIG", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::from(log_file))
                .stderr(Stdio::from(log_file_for_stderr))
                .status()
        })
        .await
        .map_err(|error| AppError::new("hermes_runtime_install_failed", error.to_string()))?
        .map_err(|error| {
            AppError::new(
                "hermes_runtime_install_failed",
                format!(
                    "Could not run the Hermes runtime installer. Install log: {}. {error}",
                    install_log.display()
                ),
            )
        })?
    };

    if !status.success() {
        return Err(AppError::new(
            "hermes_runtime_install_failed",
            format!(
                "Could not set up the Scribe-managed Hermes runtime. Install log: {}.",
                install_log.display()
            ),
        ));
    }

    if !install_dir.join("venv/bin/hermes").exists() {
        return Err(AppError::new(
            "hermes_runtime_install_failed",
            format!(
                "Hermes setup completed but the runtime command was not created. Install log: {}.",
                install_log.display()
            ),
        ));
    }

    Ok(())
}

const MANAGED_HERMES_INSTALL_SCRIPT: &str = r#"
set -euo pipefail

runtime_dir="${SCRIBE_HERMES_RUNTIME_DIR:?}"
install_dir="${SCRIBE_HERMES_INSTALL_DIR:?}"
hermes_home="${SCRIBE_HERMES_HOME:?}"
install_commit="${SCRIBE_HERMES_INSTALL_COMMIT:?}"
source_tarball_url="${SCRIBE_HERMES_SOURCE_TARBALL_URL:?}"
source_tarball_sha256="${SCRIBE_HERMES_SOURCE_TARBALL_SHA256:?}"

mkdir -p "$runtime_dir" "$hermes_home"

if [ ! -f "$install_dir/pyproject.toml" ] || [ ! -f "$install_dir/scripts/install.sh" ]; then
  tmp_dir="$(mktemp -d "$runtime_dir/download.XXXXXX")"
  cleanup() { rm -rf "$tmp_dir"; }
  trap cleanup EXIT
  curl -LsSf "$source_tarball_url" -o "$tmp_dir/hermes-agent.tar.gz"
  actual_sha256="$(shasum -a 256 "$tmp_dir/hermes-agent.tar.gz" | awk '{print $1}')"
  if [ "$actual_sha256" != "$source_tarball_sha256" ]; then
    echo "Hermes source archive checksum mismatch." >&2
    echo "expected: $source_tarball_sha256" >&2
    echo "actual:   $actual_sha256" >&2
    exit 1
  fi
  tar -xzf "$tmp_dir/hermes-agent.tar.gz" -C "$tmp_dir"
  unpacked_dir="$(find "$tmp_dir" -maxdepth 1 -type d -name 'hermes-agent-*' | head -n 1)"
  if [ -z "$unpacked_dir" ]; then
    echo "Hermes source archive did not contain a hermes-agent directory." >&2
    exit 1
  fi
  rm -rf "$install_dir"
  mkdir -p "$(dirname "$install_dir")"
  mv "$unpacked_dir" "$install_dir"
fi

run_stage() {
  local stage="$1"
  HERMES_HOME="$hermes_home" HERMES_INSTALL_DIR="$install_dir" \
    bash "$install_dir/scripts/install.sh" \
      --dir "$install_dir" \
      --hermes-home "$hermes_home" \
      --stage "$stage" \
      --json \
      --non-interactive
}

run_stage venv
run_stage python-deps
run_stage node-deps
run_stage config
run_stage complete

cat > "$runtime_dir/runtime.json" <<EOF
{"source":"NousResearch/hermes-agent","commit":"$install_commit","installDir":"$install_dir"}
EOF
"#;

fn apply_isolated_hermes_env(
    cmd: &mut Command,
    hermes_home: &std::path::Path,
    token: &str,
    environment_hint: Option<&str>,
) {
    for name in ISOLATED_HERMES_ENV_VARS {
        cmd.env_remove(name);
    }
    cmd.env("HERMES_HOME", hermes_home)
        .env("HERMES_DASHBOARD_SESSION_TOKEN", token)
        .env("NO_PROXY", "127.0.0.1,localhost,::1")
        .env("no_proxy", "127.0.0.1,localhost,::1");
    if let Some(hint) = environment_hint {
        cmd.env("HERMES_ENVIRONMENT_HINT", hint);
    }
}

/// Builds the Seatbelt profile, writes it to disk, and returns the path to hand
/// to `sandbox-exec -f`. Returns `None` — meaning "spawn unsandboxed" — on
/// non-macOS, when `sandbox-exec` is absent, when the escape-hatch env var is
/// set, or if the profile can't be written. Callers treat `None` as "not
/// sandboxed" and surface that honestly in the UI.
///
/// The profile is written to `app_data_dir` itself, deliberately *outside* every
/// granted write root (the `hermes/` and `hermes-runtime/` subdirs), so the
/// jailed agent can't rewrite the policy that governs it or the one the next
/// spawn will read.
#[cfg(target_os = "macos")]
fn prepare_sandbox(app: &AppHandle, hermes_home: &Path, agent_cli_access: bool) -> Option<PathBuf> {
    // The caller logs the sandboxed/unsandboxed outcome; this only short-circuits.
    if env_flag_enabled(SCRIBE_HERMES_DISABLE_SANDBOX_ENV) {
        return None;
    }
    if !Path::new(SANDBOX_EXEC_PATH).exists() {
        return None;
    }
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let runtime_dir = managed_hermes_runtime_dir(app).ok()?;
    let write_roots = sandbox_write_roots(hermes_home, &runtime_dir);
    let profile = build_sandbox_profile(&home, &write_roots, agent_cli_access);
    let app_data_dir = app.path().app_data_dir().ok()?;
    if std::fs::create_dir_all(&app_data_dir).is_err() {
        return None;
    }
    let profile_path = app_data_dir.join("hermes-sandbox.sb");
    match std::fs::write(&profile_path, profile) {
        Ok(()) => Some(profile_path),
        Err(error) => {
            eprintln!("Could not write Hermes sandbox profile, spawning unsandboxed: {error}");
            None
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn prepare_sandbox(
    _app: &AppHandle,
    _hermes_home: &Path,
    _agent_cli_access: bool,
) -> Option<PathBuf> {
    None
}

fn agent_cli_access_flag_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(AGENT_CLI_ACCESS_FLAG_FILE))
}

/// Whether the user opted into Agent CLI access (Settings, Agent tab).
pub(crate) fn agent_cli_access_enabled(app: &AppHandle) -> bool {
    agent_cli_access_flag_path(app).is_some_and(|path| path.exists())
}

/// Whether a *sandboxed* spawn on this machine would actually engage the
/// jail. Used by unrestricted spawns to keep the shared SOUL.md's sandbox
/// section accurate without touching the profile on disk.
#[cfg(target_os = "macos")]
fn sandbox_would_engage(app: &AppHandle, hermes_home: &Path) -> bool {
    if env_flag_enabled(SCRIBE_HERMES_DISABLE_SANDBOX_ENV) {
        return false;
    }
    if !Path::new(SANDBOX_EXEC_PATH).exists() {
        return false;
    }
    let _ = hermes_home;
    std::env::var_os("HOME").is_some() && managed_hermes_runtime_dir(app).is_ok()
}

#[cfg(not(target_os = "macos"))]
fn sandbox_would_engage(_app: &AppHandle, _hermes_home: &Path) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn env_flag_enabled(name: &str) -> bool {
    match std::env::var(name) {
        Ok(value) => {
            let value = value.trim().to_ascii_lowercase();
            matches!(value.as_str(), "1" | "true" | "yes" | "on")
        }
        Err(_) => false,
    }
}

/// Directories the jailed agent may write to. Everything else is read-only.
/// Paths are canonicalized so `subpath` rules match the realpaths the kernel
/// enforces against (macOS resolves `/tmp` -> `/private/tmp` and `$TMPDIR`
/// under `/private/var/folders`).
///
/// Deliberately scoped to `$TMPDIR` (this app's per-session temp dir) rather
/// than the whole `/private/var/folders` tree, which is the parent of every
/// other app's caches too. The session cwd is intentionally *not* a write root:
/// it defaults to the workspace (already under `hermes_home`), and a non-default
/// cwd is user-influenced, so granting it write would let the jail span an
/// arbitrary directory — a project-dir feature would need an explicit, validated
/// grant instead.
#[cfg(target_os = "macos")]
fn sandbox_write_roots(hermes_home: &Path, runtime_dir: &Path) -> Vec<PathBuf> {
    let mut roots = vec![
        hermes_home.to_path_buf(),
        runtime_dir.to_path_buf(),
        // Shared temp dirs, used mainly as a fallback when $TMPDIR is unset.
        PathBuf::from("/private/tmp"),
        PathBuf::from("/private/var/tmp"),
    ];
    // The per-session temp dir (resolves under /private/var/folders). The Python
    // runtime and its children use it for scratch files and multiprocessing
    // sockets; scoping to it keeps other apps' caches out of the jail.
    if let Some(tmpdir) = std::env::var_os("TMPDIR") {
        if !tmpdir.is_empty() {
            roots.push(PathBuf::from(tmpdir));
        }
    }
    let mut canonical: Vec<PathBuf> = Vec::with_capacity(roots.len());
    for root in roots {
        let resolved = std::fs::canonicalize(&root).unwrap_or(root);
        if !canonical.contains(&resolved) {
            canonical.push(resolved);
        }
    }
    canonical
}

/// Renders the Seatbelt (SBPL) profile text. Strategy: allow broadly, because
/// the embedded Python runtime needs wide syscall, mach-service, and exec
/// rights and any tighter base brings the runtime down; then deny every write
/// and re-grant only the app-owned roots, and deny reads of credential stores.
/// Pure (no IO) so it can be unit-tested.
#[cfg(target_os = "macos")]
fn build_sandbox_profile(home: &Path, write_roots: &[PathBuf], agent_cli_access: bool) -> String {
    let mut out = String::new();
    out.push_str("(version 1)\n");
    out.push_str(";; June desktop agent sandbox — generated by Scribe, do not edit.\n");
    out.push_str(";; Allow broadly (the Python runtime needs wide syscall/mach access and\n");
    out.push_str(";; must exec interpreters), then carve a hard write-jail and a secret-read\n");
    out.push_str(";; denylist. Subprocesses inherit this profile.\n");
    out.push_str("(allow default)\n\n");

    out.push_str(";; Write jail: deny all writes, then re-grant only app-owned roots.\n");
    out.push_str("(deny file-write*)\n");
    out.push_str("(allow file-write*\n");
    for root in write_roots {
        out.push_str(&format!(
            "  (subpath {})\n",
            sbpl_quote(&root.to_string_lossy())
        ));
    }
    out.push_str(")\n\n");

    if agent_cli_access {
        out.push_str(";; Agent CLI state (explicit user opt-in from Settings > Agent):\n");
        out.push_str(";; lets installed coding CLIs (Claude Code, Codex, Gemini, opencode)\n");
        out.push_str(";; run under the jail while keeping their sessions and refreshed\n");
        out.push_str(";; logins. These folders configure tools that later run OUTSIDE the\n");
        out.push_str(";; sandbox (hooks, settings), which is why this is off by default.\n");
        out.push_str("(allow file-write*\n");
        for relative in AGENT_CLI_STATE_DIRS {
            out.push_str(&format!(
                "  (subpath {})\n",
                sbpl_quote(&home.join(relative).to_string_lossy())
            ));
        }
        for prefix in AGENT_CLI_STATE_FILE_PREFIXES {
            // Prefix regex instead of a literal: the CLIs write these files
            // atomically through randomly suffixed temp names + rename.
            out.push_str(&format!(
                "  (regex #\"^{}.*$\")\n",
                sbpl_regex_escape(&home.join(prefix).to_string_lossy())
            ));
        }
        out.push_str(")\n\n");
    }

    out.push_str(";; Character devices and pipes the runtime needs to write.\n");
    out.push_str("(allow file-write*\n");
    for device in [
        "/dev/null",
        "/dev/zero",
        "/dev/dtracehelper",
        "/dev/tty",
        "/dev/stdout",
        "/dev/stderr",
        "/dev/random",
        "/dev/urandom",
    ] {
        out.push_str(&format!("  (literal {})\n", sbpl_quote(device)));
    }
    out.push_str("  (regex #\"^/dev/fd/[0-9]+$\")\n");
    out.push_str("  (regex #\"^/dev/ttys[0-9]+$\")\n");
    out.push_str(")\n\n");

    out.push_str(";; Secret-read denylist: reads are otherwise open so June can work on\n");
    out.push_str(";; the user's files, but credential stores stay off-limits.\n");
    out.push_str("(deny file-read*\n");
    for relative in [
        ".ssh",
        ".aws",
        ".gnupg",
        ".kube",
        ".docker",
        ".config/gcloud",
        ".config/gh",
        "Library/Keychains",
    ] {
        out.push_str(&format!(
            "  (subpath {})\n",
            sbpl_quote(&home.join(relative).to_string_lossy())
        ));
    }
    out.push_str("  (subpath \"/Library/Keychains\")\n");
    for relative in [".netrc", ".git-credentials", ".npmrc", ".pypirc", ".pgpass"] {
        out.push_str(&format!(
            "  (literal {})\n",
            sbpl_quote(&home.join(relative).to_string_lossy())
        ));
    }
    out.push_str(")\n");
    out
}

/// Quotes a string as an SBPL literal: wrap in double quotes, backslash-escape
/// embedded quotes and backslashes. Spaces (e.g. "Application Support") are
/// fine inside the quotes.
#[cfg(target_os = "macos")]
fn sbpl_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for ch in value.chars() {
        if ch == '\\' || ch == '"' {
            quoted.push('\\');
        }
        quoted.push(ch);
    }
    quoted.push('"');
    quoted
}

/// Escapes a path for embedding in an SBPL `(regex #"...")` pattern so it
/// matches itself literally — dots in file names and any other regex
/// metacharacters must not widen the grant.
fn sbpl_regex_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(
            ch,
            '\\' | '.' | '+' | '*' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|'
        ) {
            escaped.push('\\');
        }
        if ch == '"' {
            // SBPL string layer: a quote would end the #"..." pattern.
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

fn resolve_scribe_hermes_home(app: &AppHandle) -> Result<PathBuf, AppError> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::new("hermes_bridge_home_failed", error.to_string()))?
        .join("hermes");
    std::fs::create_dir_all(&path)
        .map_err(|error| AppError::new("hermes_bridge_home_failed", error.to_string()))?;
    Ok(path)
}

/// Toolsets a routine (cron job) runs with when it carries no per-job
/// `enabled_toolsets` override. Hermes resolves a cron run's toolsets as:
/// per-job `enabled_toolsets` first, then `platform_toolsets.cron` from
/// config.yaml (`_resolve_cron_enabled_toolsets` in cron/scheduler.py).
/// Routines execute inside the launchd gateway daemon, which must run
/// outside the Seatbelt jail so launchd accepts it (see
/// `spawn_hermes_gateway_start`), so this allowlist is what "Sandboxed"
/// means for a routine: no terminal, file, code-execution, browser,
/// computer-use, skill-management, or delegation toolsets — the job can
/// read the web, think, remember, and deliver its report, but cannot touch
/// the machine. The per-routine Unrestricted opt-in writes an explicit
/// per-job `enabled_toolsets` (see CRON_UNRESTRICTED_TOOLSETS in
/// src/lib/hermes-routines.ts), which takes precedence over this gate.
/// The scheduler always strips `cronjob`, `messaging`, and `clarify` from
/// cron agents on top of either list.
const CRON_SANDBOXED_TOOLSETS: &[&str] = &[
    "web",
    "vision",
    "todo",
    "memory",
    "session_search",
    "context_engine",
];

fn sync_hermes_config(
    hermes_home: &std::path::Path,
    provider_proxy_port: u16,
    provider_proxy_token: &str,
) -> Result<(), AppError> {
    let model = crate::providers::generation_model();
    let base_url = format!("http://127.0.0.1:{provider_proxy_port}/v1");
    let config = format!(
        r#"model:
  default: {model}
  provider: custom
  base_url: {base_url}
  api_key: {provider_proxy_token}
  api_mode: chat_completions
agent:
  max_turns: 90
display:
  skin: mono
platform_toolsets:
  cron: [{cron_toolsets}]
"#,
        model = yaml_string(&model),
        base_url = yaml_string(&base_url),
        provider_proxy_token = yaml_string(provider_proxy_token),
        cron_toolsets = CRON_SANDBOXED_TOOLSETS.join(", "),
    );
    std::fs::write(hermes_home.join("config.yaml"), config)
        .map_err(|error| AppError::new("hermes_bridge_config_failed", error.to_string()))
}

/// Writes the June persona to `SOUL.md` in the Scribe-managed Hermes home.
/// Runs on every start so the app-owned identity wins over the default soul
/// Hermes seeds on first run (and over any stale copy from earlier versions).
/// Both mode processes read this one file, so the sandbox section describes
/// the per-session mode split; it is included only when sandboxed spawns on
/// this machine actually engage the jail (it's omitted when sandbox-exec is
/// missing or the escape-hatch env var disabled it, so the agent never
/// claims a protection that isn't enforced).
fn sync_june_soul(
    hermes_home: &std::path::Path,
    sandbox_available: bool,
    agent_cli_access: bool,
) -> Result<(), AppError> {
    let soul = if sandbox_available {
        let cli_section = if agent_cli_access {
            JUNE_SOUL_CLI_ALLOWED_MD
        } else {
            JUNE_SOUL_CLI_BLOCKED_MD
        };
        format!("{JUNE_SOUL_MD}{JUNE_SOUL_SANDBOX_MD}{cli_section}")
    } else {
        JUNE_SOUL_MD.to_string()
    };
    std::fs::write(hermes_home.join("SOUL.md"), soul)
        .map_err(|error| AppError::new("hermes_bridge_soul_failed", error.to_string()))
}

struct FilesystemRootCandidate {
    id: String,
    label: String,
    path: PathBuf,
    description: String,
}

fn filesystem_roots(hermes_home: &Path) -> Result<Vec<FilesystemRootCandidate>, AppError> {
    let mut roots = Vec::new();
    for (id, label, relative, description) in [
        (
            "workspace",
            "Workspace",
            "workspace",
            "Hermes scratch files and generated outputs.",
        ),
        (
            "memory",
            "Memory",
            "memories",
            "Persistent Hermes memory files and stores.",
        ),
    ] {
        roots.push(FilesystemRootCandidate {
            id: id.to_string(),
            label: label.to_string(),
            path: hermes_home.join(relative),
            description: description.to_string(),
        });
    }
    Ok(dedupe_filesystem_roots(roots))
}

fn dedupe_filesystem_roots(roots: Vec<FilesystemRootCandidate>) -> Vec<FilesystemRootCandidate> {
    let mut seen = std::collections::HashSet::new();
    roots
        .into_iter()
        .filter(|root| {
            let key = root.path.to_string_lossy().into_owned();
            seen.insert(key)
        })
        .collect()
}

fn list_filesystem_entries(
    path: &Path,
    depth: usize,
) -> Result<Vec<HermesFilesystemEntry>, AppError> {
    if is_hidden_secret_path(path) {
        return Ok(Vec::new());
    }
    if path.is_file() {
        return filesystem_entry(path.to_path_buf(), depth).map(|entry| vec![entry]);
    }
    let mut entries = fs::read_dir(path)
        .map_err(|error| AppError::new("hermes_filesystem_read_failed", error.to_string()))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| !is_hidden_secret_path(&entry.path()))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        let left_path = left.path();
        let right_path = right.path();
        right_path.is_dir().cmp(&left_path.is_dir()).then_with(|| {
            left.file_name()
                .to_string_lossy()
                .to_lowercase()
                .cmp(&right.file_name().to_string_lossy().to_lowercase())
        })
    });
    entries.truncate(FILESYSTEM_MAX_ENTRIES_PER_DIR);
    Ok(entries
        .into_iter()
        .filter_map(|entry| filesystem_entry(entry.path(), depth).ok())
        .collect())
}

fn filesystem_entry(path: PathBuf, depth: usize) -> Result<HermesFilesystemEntry, AppError> {
    let metadata = fs::metadata(&path)
        .map_err(|error| AppError::new("hermes_filesystem_read_failed", error.to_string()))?;
    let is_dir = metadata.is_dir();
    let children = if is_dir && depth < FILESYSTEM_MAX_DEPTH {
        Some(list_filesystem_entries(&path, depth + 1)?)
    } else {
        None
    };
    Ok(HermesFilesystemEntry {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
        path: path.to_string_lossy().into_owned(),
        kind: if is_dir { "directory" } else { "file" }.to_string(),
        size: if is_dir { None } else { Some(metadata.len()) },
        modified_at: metadata.modified().ok().map(system_time_to_iso),
        children,
    })
}

fn is_hidden_secret_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    matches!(
        name,
        ".env" | "auth.lock" | ".credentials" | "credentials" | "secrets" | "secrets.json"
    ) || name.ends_with(".lock")
        || name.ends_with(".key")
        || name.ends_with(".pem")
}

fn system_time_to_iso(value: std::time::SystemTime) -> String {
    let datetime: chrono::DateTime<chrono::Utc> = value.into();
    datetime.to_rfc3339()
}

fn yaml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

async fn start_scribe_provider_proxy(
    token: String,
) -> Result<RunningScribeProviderProxy, AppError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| AppError::new("scribe_provider_proxy_failed", error.to_string()))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| AppError::new("scribe_provider_proxy_failed", error.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|error| AppError::new("scribe_provider_proxy_failed", error.to_string()))?
        .port();
    let listener = tokio::net::TcpListener::from_std(listener)
        .map_err(|error| AppError::new("scribe_provider_proxy_failed", error.to_string()))?;
    let (shutdown, shutdown_rx) = oneshot::channel();
    tauri::async_runtime::spawn(run_scribe_provider_proxy(
        listener,
        Arc::new(token),
        shutdown_rx,
    ));
    Ok(RunningScribeProviderProxy { port, shutdown })
}

struct RunningScribeProviderProxy {
    port: u16,
    shutdown: oneshot::Sender<()>,
}

async fn run_scribe_provider_proxy(
    listener: tokio::net::TcpListener,
    token: Arc<String>,
    mut shutdown: oneshot::Receiver<()>,
) {
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        let token = token.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = handle_scribe_provider_connection(stream, token).await;
                        });
                    }
                    Err(error) => {
                        // Accept errors (ECONNABORTED, EMFILE, ...) are
                        // usually transient. Keep the listener alive — the
                        // bridge still reports running — and back off
                        // briefly so a persistent error can't hot-loop.
                        eprintln!("Scribe provider proxy accept failed: {error}");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }
        }
    }
}

async fn handle_scribe_provider_connection(
    mut stream: tokio::net::TcpStream,
    token: Arc<String>,
) -> io::Result<()> {
    let request = match read_http_request(&mut stream).await {
        Ok(request) => request,
        Err(error) => {
            let _ = write_json_response(
                &mut stream,
                400,
                serde_json::json!({ "error": { "message": error.to_string() } }),
            )
            .await;
            return Ok(());
        }
    };
    if !provider_proxy_authorized(&request, &token) {
        write_json_response(
            &mut stream,
            401,
            serde_json::json!({ "error": { "message": "Unauthorized" } }),
        )
        .await?;
        return Ok(());
    }
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/v1/models") => {
            let model = crate::providers::generation_model();
            let body = serde_json::json!({
                "object": "list",
                "data": [{
                    "id": model,
                    "object": "model",
                    "created": 0,
                    "owned_by": "scribe"
                }]
            });
            write_json_response(&mut stream, 200, body).await?;
        }
        ("POST", "/v1/chat/completions") => {
            let body = serde_json::from_slice::<serde_json::Value>(&request.body)
                .unwrap_or_else(|_| serde_json::json!({}));
            match crate::scribe_api::proxy_agent_chat_completions(body).await {
                Ok(response) => {
                    write_streaming_response(&mut stream, response).await?;
                }
                Err(error) => {
                    write_json_response(
                        &mut stream,
                        502,
                        serde_json::json!({
                            "error": {
                                "message": format!("Scribe agent provider failed: {}", error.message),
                                "type": error.code
                            }
                        }),
                    )
                    .await?;
                }
            }
        }
        _ => {
            write_json_response(
                &mut stream,
                404,
                serde_json::json!({ "error": { "message": "Not found" } }),
            )
            .await?;
        }
    }
    Ok(())
}

struct HttpRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

async fn read_http_request(stream: &mut tokio::net::TcpStream) -> io::Result<HttpRequest> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if buffer.len() > SCRIBE_PROVIDER_PROXY_MAX_HEADER_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HTTP headers are too large",
            ));
        }
    }
    let header_end = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Incomplete HTTP request"))?;
    let headers = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = headers.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Missing HTTP request line"))?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or("").to_string();
    let path = request_parts
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("")
        .to_string();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
        .collect::<Vec<_>>();
    let content_length = headers
        .iter()
        .find_map(|(name, value)| {
            if name.eq_ignore_ascii_case("content-length") {
                value.parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    if content_length > SCRIBE_PROVIDER_PROXY_MAX_BODY_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "HTTP body is too large",
        ));
    }
    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);
    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn provider_proxy_authorized(request: &HttpRequest, token: &str) -> bool {
    request
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        .and_then(|(_, value)| bearer_token(value))
        .is_some_and(|candidate| constant_time_eq(candidate, token))
}

fn bearer_token(value: &str) -> Option<&str> {
    let mut parts = value.split_whitespace();
    let scheme = parts.next()?;
    let token = parts.next()?;
    if parts.next().is_some() || !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    Some(token)
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut diff = left.len() ^ right.len();
    for (left, right) in left.iter().zip(right.iter()) {
        diff |= usize::from(*left ^ *right);
    }
    diff == 0
}

async fn write_json_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    body: serde_json::Value,
) -> io::Result<()> {
    let body = serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec());
    write_raw_response(stream, status, "application/json", &body).await
}

async fn write_raw_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> io::Result<()> {
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len(),
        reason = http_status_reason(status),
    );
    stream.write_all(headers.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.shutdown().await
}

/// Forwards an upstream chat-completions response to the socket chunk by
/// chunk, so Hermes sees streamed tokens (`stream: true`) as they are
/// generated instead of one buffered body after generation completes. The
/// proxy already speaks `Connection: close`, so the body is delimited by
/// closing the connection and no Content-Length is sent.
async fn write_streaming_response(
    stream: &mut tokio::net::TcpStream,
    mut response: crate::scribe_api::AgentChatCompletionsResponse,
) -> io::Result<()> {
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n",
        status = response.status,
        reason = http_status_reason(response.status),
        content_type = response.content_type,
    );
    stream.write_all(headers.as_bytes()).await?;
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => stream.write_all(&chunk).await?,
            Ok(None) => break,
            Err(error) => {
                // Headers are already on the wire, so an error response is
                // no longer possible. Close the connection to end the body;
                // the client sees a truncated stream and surfaces the abort.
                eprintln!(
                    "Scribe provider proxy upstream stream failed: {}",
                    error.message
                );
                break;
            }
        }
    }
    stream.shutdown().await
}

fn http_status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "OK",
    }
}

fn pick_port() -> Result<u16, AppError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| AppError::new("hermes_bridge_port_failed", error.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|error| AppError::new("hermes_bridge_port_failed", error.to_string()))?
        .port();
    drop(listener);
    Ok(port)
}

fn random_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(43)
        .map(char::from)
        .collect()
}

async fn wait_for_hermes(base_url: &str, token: &str) -> Result<(), AppError> {
    // `.no_proxy()` matters: the probe targets 127.0.0.1, and routing it
    // through an HTTP(S)_PROXY would fail for the whole readiness window
    // and kill a healthy Hermes.
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| AppError::new("hermes_bridge_ready_timeout", error.to_string()))?;
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut last_error = "timeout".to_string();
    while Instant::now() < deadline {
        match client
            .get(format!("{base_url}/api/status"))
            .bearer_auth(token)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => last_error = format!("HTTP {}", response.status()),
            Err(error) => last_error = error.to_string(),
        }
        tokio::time::sleep(READY_POLL).await;
    }
    Err(AppError::new(
        "hermes_bridge_ready_timeout",
        format!("Hermes backend did not become ready: {last_error}"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_with_authorization(value: &str) -> HttpRequest {
        HttpRequest {
            method: "GET".to_string(),
            path: "/v1/models".to_string(),
            headers: vec![("Authorization".to_string(), value.to_string())],
            body: Vec::new(),
        }
    }

    #[test]
    fn provider_proxy_requires_matching_bearer_token() {
        let request = request_with_authorization("Bearer proxy-secret");

        assert!(provider_proxy_authorized(&request, "proxy-secret"));
        assert!(!provider_proxy_authorized(&request, "other-secret"));
    }

    #[test]
    fn provider_proxy_rejects_missing_or_malformed_authorization() {
        let missing = HttpRequest {
            method: "GET".to_string(),
            path: "/v1/models".to_string(),
            headers: Vec::new(),
            body: Vec::new(),
        };
        let basic = request_with_authorization("Basic proxy-secret");
        let extra = request_with_authorization("Bearer proxy-secret extra");

        assert!(!provider_proxy_authorized(&missing, "proxy-secret"));
        assert!(!provider_proxy_authorized(&basic, "proxy-secret"));
        assert!(!provider_proxy_authorized(&extra, "proxy-secret"));
    }

    #[test]
    fn start_request_full_mode_is_opt_in_and_defaults_to_no_preference() {
        // Background callers (auto-start, routines, older frontends) send no
        // fullMode — that must deserialize as "no preference", never as an
        // explicit mode that could restart a runtime the user put in Full mode.
        let request: StartHermesBridgeRequest = serde_json::from_str("{}").expect("empty request");
        assert_eq!(request.full_mode, None);

        let request: StartHermesBridgeRequest =
            serde_json::from_str(r#"{"fullMode":true}"#).expect("full mode request");
        assert_eq!(request.full_mode, Some(true));

        let request: StartHermesBridgeRequest =
            serde_json::from_str(r#"{"fullMode":false}"#).expect("sandboxed request");
        assert_eq!(request.full_mode, Some(false));
    }

    #[test]
    fn gateway_start_spawns_the_bare_hermes_cli_outside_the_sandbox() {
        let connection = HermesBridgeConnection {
            base_url: "http://127.0.0.1:1".to_string(),
            ws_url: "ws://127.0.0.1:1/api/ws".to_string(),
            token: "session-token".to_string(),
            port: 1,
            command: "/opt/hermes/bin/hermes".to_string(),
            hermes_home: "/tmp/hermes-home".to_string(),
            cwd: None,
            provider_proxy_port: 2,
            pid: 3,
            sandboxed: true,
            full_mode: false,
        };

        let cmd = build_hermes_gateway_start_command(&connection, Path::new("/tmp/hermes-home"));

        // The whole point of the direct spawn: the program is the hermes CLI
        // itself, never a sandbox-exec wrapper — launchd rejects service
        // management (bootstrap/kickstart) from sandboxed processes.
        assert_eq!(cmd.get_program(), "/opt/hermes/bin/hermes");
        let args: Vec<String> = cmd
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, ["gateway", "start"]);
        let envs: std::collections::HashMap<String, String> = cmd
            .get_envs()
            .filter_map(|(key, value)| {
                value.map(|value| {
                    (
                        key.to_string_lossy().into_owned(),
                        value.to_string_lossy().into_owned(),
                    )
                })
            })
            .collect();
        assert_eq!(
            envs.get("HERMES_HOME").map(String::as_str),
            Some("/tmp/hermes-home")
        );
        assert_eq!(
            envs.get("HERMES_NONINTERACTIVE").map(String::as_str),
            Some("1")
        );
        assert_eq!(cmd.get_current_dir(), Some(Path::new("/tmp/hermes-home")));
    }

    #[test]
    fn environment_hint_states_the_mode_each_runtime_serves() {
        // Each runtime process serves exactly one per-session mode, so the
        // per-process hint is the agent's only definitive answer to "is THIS
        // session sandboxed?" — SOUL.md is shared and can only describe the
        // split.
        assert_eq!(
            environment_hint_for_spawn(false, true),
            Some(JUNE_HINT_SANDBOXED)
        );
        assert_eq!(
            environment_hint_for_spawn(true, true),
            Some(JUNE_HINT_UNRESTRICTED)
        );
        // No jail on this machine → SOUL.md has no sandbox section, and a
        // status line about a nonexistent jail would contradict it.
        assert_eq!(environment_hint_for_spawn(false, false), None);
        assert_eq!(environment_hint_for_spawn(true, false), None);
    }

    #[test]
    fn isolated_env_carries_the_sandbox_status_hint_only_when_given() {
        fn envs_of(cmd: &Command) -> std::collections::HashMap<String, String> {
            cmd.get_envs()
                .filter_map(|(key, value)| {
                    value.map(|value| {
                        (
                            key.to_string_lossy().into_owned(),
                            value.to_string_lossy().into_owned(),
                        )
                    })
                })
                .collect()
        }

        let mut hinted = Command::new("hermes");
        apply_isolated_hermes_env(
            &mut hinted,
            Path::new("/tmp/hermes-home"),
            "token",
            Some(JUNE_HINT_UNRESTRICTED),
        );
        assert_eq!(
            envs_of(&hinted).get("HERMES_ENVIRONMENT_HINT").map(String::as_str),
            Some(JUNE_HINT_UNRESTRICTED)
        );

        // Without a hint the var is scrubbed, not inherited: a stale value
        // from the app's own environment must never reach the runtime.
        let mut bare = Command::new("hermes");
        std::env::set_var("HERMES_ENVIRONMENT_HINT", "stale-from-shell");
        apply_isolated_hermes_env(&mut bare, Path::new("/tmp/hermes-home"), "token", None);
        std::env::remove_var("HERMES_ENVIRONMENT_HINT");
        assert!(envs_of(&bare).get("HERMES_ENVIRONMENT_HINT").is_none());
    }

    #[test]
    fn synced_config_gates_cron_runs_to_the_sandboxed_toolsets() {
        // Routines execute in the unjailed launchd gateway, so the only
        // default-deny boundary they have is this config gate: a cron job
        // with no per-job enabled_toolsets must resolve to the sandboxed
        // allowlist, never the full default toolset.
        let home = tempfile::tempdir().expect("tempdir");

        sync_hermes_config(home.path(), 4242, "proxy-token").expect("sync config");

        let config = std::fs::read_to_string(home.path().join("config.yaml")).expect("read config");
        assert!(config.contains("platform_toolsets:"));
        assert!(config.contains(&format!("cron: [{}]", CRON_SANDBOXED_TOOLSETS.join(", "))));
        for toolset in [
            "terminal",
            "file",
            "code_execution",
            "browser",
            "computer_use",
        ] {
            assert!(
                !CRON_SANDBOXED_TOOLSETS.contains(&toolset),
                "machine-touching toolset {toolset} must not be in the cron default",
            );
        }
    }

    #[test]
    fn sync_june_soul_replaces_default_hermes_identity() {
        let home = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            home.path().join("SOUL.md"),
            "You are Hermes Agent, an intelligent AI assistant created by Nous Research.",
        )
        .expect("seed default soul");

        sync_june_soul(home.path(), true, false).expect("sync soul");

        let soul = std::fs::read_to_string(home.path().join("SOUL.md")).expect("read soul");
        assert!(soul.contains("You are June"));
        assert!(soul.contains("Open Software"));
        assert!(!soul.contains("Nous Research"));
    }

    #[test]
    fn sandboxed_soul_describes_the_write_jail() {
        let home = tempfile::tempdir().expect("tempdir");

        sync_june_soul(home.path(), true, false).expect("sync soul");

        let soul = std::fs::read_to_string(home.path().join("SOUL.md")).expect("read soul");
        assert!(soul.contains("Seatbelt"));
        assert!(soul.contains("write-jail"));
        assert!(soul.contains("operation not permitted"));
        // CLI access off: the soul teaches the failure mode and the remedy.
        assert!(soul.contains("Agent CLI access"));
        assert!(soul.contains("name the sandbox as the cause"));
        assert!(!soul.contains("first-class job"));
    }

    #[test]
    fn sandboxed_soul_with_cli_access_describes_the_grant() {
        let home = tempfile::tempdir().expect("tempdir");

        sync_june_soul(home.path(), true, true).expect("sync soul");

        let soul = std::fs::read_to_string(home.path().join("SOUL.md")).expect("read soul");
        assert!(soul.contains("the user enabled Agent CLI access"));
        assert!(soul.contains("first-class job"));
        // Both variants tell June it can never complete interactive logins.
        assert!(soul.contains("claude /login"));
        assert!(!soul.contains("name the sandbox as the cause"));
    }

    #[test]
    fn unsandboxed_soul_makes_no_sandbox_claims() {
        let home = tempfile::tempdir().expect("tempdir");

        sync_june_soul(home.path(), false, false).expect("sync soul");

        let soul = std::fs::read_to_string(home.path().join("SOUL.md")).expect("read soul");
        assert!(soul.contains("You are June"));
        assert!(!soul.contains("Seatbelt"));
        assert!(!soul.contains("sandbox"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn write_roots_are_scoped_and_exclude_the_var_folders_blanket() {
        let hermes_home = PathBuf::from("/Users/test/Library/Application Support/scribe/hermes");
        let runtime_dir = PathBuf::from("/Users/test/Library/Application Support/scribe/runtime");
        let roots = sandbox_write_roots(&hermes_home, &runtime_dir);

        assert!(roots.contains(&hermes_home), "workspace root missing");
        assert!(roots.contains(&runtime_dir), "runtime root missing");
        // The blanket /private/var/folders (parent of every app's caches) must
        // not be a write root — only this app's $TMPDIR may slip under it.
        assert!(
            !roots.contains(&PathBuf::from("/private/var/folders")),
            "must not grant the whole /private/var/folders tree"
        );
        // No root may be the home dir or a filesystem root — the jail must never
        // span the user's whole account (regression guard for the dropped cwd).
        for root in &roots {
            assert!(root != &PathBuf::from("/"), "root / granted");
            assert!(
                !root.to_string_lossy().eq("/Users/test"),
                "home dir granted as a write root"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn sandbox_profile_jails_writes_to_allowed_roots() {
        let home = PathBuf::from("/Users/test");
        let workspace = PathBuf::from("/Users/test/Library/Application Support/scribe/hermes");
        let profile = build_sandbox_profile(&home, std::slice::from_ref(&workspace), false);

        // Allow-everything base, then a hard write-jail re-granting the root.
        assert!(profile.contains("(allow default)"));
        assert!(profile.contains("(deny file-write*)"));
        assert!(
            profile.contains("(subpath \"/Users/test/Library/Application Support/scribe/hermes\")")
        );
        // The re-grant must come after the blanket write deny, or it's a no-op.
        let deny_at = profile.find("(deny file-write*)").expect("deny present");
        let grant_at = profile
            .find("(allow file-write*\n  (subpath")
            .expect("grant present");
        assert!(deny_at < grant_at);

        // Credential stores stay unreadable even though reads are otherwise open.
        assert!(profile.contains("(deny file-read*"));
        assert!(profile.contains("(subpath \"/Users/test/.ssh\")"));
        assert!(profile.contains("(subpath \"/Users/test/Library/Keychains\")"));

        // Without the opt-in, no agent CLI state dir is writable.
        assert!(!profile.contains(".claude"));
        assert!(!profile.contains(".codex"));
        assert!(!profile.contains(".gemini"));
        assert!(!profile.contains("opencode"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn sandbox_profile_opt_in_grants_agent_cli_state_only() {
        let home = PathBuf::from("/Users/test");
        let workspace = PathBuf::from("/Users/test/Library/Application Support/scribe/hermes");
        let profile = build_sandbox_profile(&home, std::slice::from_ref(&workspace), true);

        // The CLI state dirs become writable...
        assert!(profile.contains("(subpath \"/Users/test/.claude\")"));
        assert!(profile.contains("(subpath \"/Users/test/.codex\")"));
        assert!(profile.contains("(subpath \"/Users/test/.gemini\")"));
        assert!(profile.contains("(subpath \"/Users/test/.config/opencode\")"));
        // ...including Claude Code's atomically written top-level config (a
        // prefix regex, because writes go through random temp suffixes), with
        // the path's dots escaped so the grant can't widen.
        assert!(profile.contains("(regex #\"^/Users/test/\\.claude\\.json.*$\")"));

        // The jail and the secret-read denylist are unchanged.
        assert!(profile.contains("(deny file-write*)"));
        assert!(profile.contains("(subpath \"/Users/test/.ssh\")"));
        assert!(profile.contains("(subpath \"/Users/test/Library/Keychains\")"));
        // The CLI grant must come after the blanket write deny to take effect.
        let deny_at = profile.find("(deny file-write*)").expect("deny present");
        let cli_grant_at = profile
            .find("(subpath \"/Users/test/.claude\")")
            .expect("cli grant present");
        assert!(deny_at < cli_grant_at);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn sbpl_regex_escape_neutralizes_metacharacters() {
        assert_eq!(
            sbpl_regex_escape("/Users/test/.claude.json"),
            "/Users/test/\\.claude\\.json"
        );
        assert_eq!(sbpl_regex_escape("a+b(c)[d]"), "a\\+b\\(c\\)\\[d\\]");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn sbpl_quote_escapes_quotes_and_backslashes() {
        assert_eq!(sbpl_quote("/plain/path"), "\"/plain/path\"");
        assert_eq!(sbpl_quote("/with space/x"), "\"/with space/x\"");
        assert_eq!(sbpl_quote("a\"b\\c"), "\"a\\\"b\\\\c\"");
    }

    /// Runs the *actual* generated profile through the kernel via `sandbox-exec`
    /// to prove it's valid SBPL and enforces the jail — not just that the string
    /// looks right. Catches malformed regexes, bad escaping, or rule ordering
    /// that a string-content assertion would miss.
    #[cfg(target_os = "macos")]
    #[test]
    fn generated_profile_is_enforced_by_the_kernel() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Canonicalize so the profile's subpaths match the realpaths the kernel
        // resolves (/var/folders -> /private/var/folders).
        let home = std::fs::canonicalize(dir.path()).expect("canonicalize home");
        let workspace = home.join("workspace");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        std::fs::create_dir_all(home.join(".ssh")).expect("create .ssh");
        std::fs::write(home.join(".ssh").join("id_secret"), "TOPSECRET").expect("seed secret");

        let profile_text = build_sandbox_profile(&home, std::slice::from_ref(&workspace), false);
        let profile_path = home.join("test.sb");
        std::fs::write(&profile_path, &profile_text).expect("write profile");

        let run = |script: &str| {
            std::process::Command::new(SANDBOX_EXEC_PATH)
                .arg("-f")
                .arg(&profile_path)
                .arg("/bin/bash")
                .arg("-c")
                .arg(script)
                .output()
                .expect("run sandbox-exec")
        };

        // Allowed: write inside the workspace root.
        let inside = workspace.join("ok.txt");
        let out = run(&format!("echo ok > {}", sbpl_shell_quote(&inside)));
        assert!(
            out.status.success() && inside.exists(),
            "workspace write should be allowed: {}",
            String::from_utf8_lossy(&out.stderr)
        );

        // Denied: write outside the workspace (home root is not a write root here).
        let outside = home.join("escaped.txt");
        run(&format!("echo bad > {}", sbpl_shell_quote(&outside)));
        assert!(
            !outside.exists(),
            "write outside the jail must be denied, but the file was created"
        );

        // Denied: read a credential store even though reads are otherwise open.
        let out = run(&format!(
            "cat {}",
            sbpl_shell_quote(&home.join(".ssh").join("id_secret"))
        ));
        assert!(
            !String::from_utf8_lossy(&out.stdout).contains("TOPSECRET"),
            "secret read must be denied, but the contents leaked"
        );
    }

    /// Same kernel-level proof for the Agent CLI access opt-in: the CLI state
    /// paths become writable (including Claude Code's atomic temp-name
    /// config writes) while the rest of the jail holds.
    #[cfg(target_os = "macos")]
    #[test]
    fn cli_access_profile_is_enforced_by_the_kernel() {
        let dir = tempfile::tempdir().expect("tempdir");
        let home = std::fs::canonicalize(dir.path()).expect("canonicalize home");
        let workspace = home.join("workspace");
        std::fs::create_dir_all(&workspace).expect("create workspace");

        let profile_text = build_sandbox_profile(&home, std::slice::from_ref(&workspace), true);
        let profile_path = home.join("test.sb");
        std::fs::write(&profile_path, &profile_text).expect("write profile");

        let run = |script: &str| {
            std::process::Command::new(SANDBOX_EXEC_PATH)
                .arg("-f")
                .arg(&profile_path)
                .arg("/bin/bash")
                .arg("-c")
                .arg(script)
                .output()
                .expect("run sandbox-exec")
        };

        // Allowed: create ~/.claude itself and write session state under it.
        let claude_state = home.join(".claude").join("session.json");
        let out = run(&format!(
            "mkdir -p {} && echo state > {}",
            sbpl_shell_quote(&home.join(".claude")),
            sbpl_shell_quote(&claude_state)
        ));
        assert!(
            out.status.success() && claude_state.exists(),
            "CLI state write should be allowed: {}",
            String::from_utf8_lossy(&out.stderr)
        );

        // Allowed: the atomic config write pattern (temp suffix + rename).
        let config_tmp = home.join(".claude.json.1a2b3c");
        let config = home.join(".claude.json");
        let out = run(&format!(
            "echo cfg > {tmp} && mv {tmp} {cfg}",
            tmp = sbpl_shell_quote(&config_tmp),
            cfg = sbpl_shell_quote(&config)
        ));
        assert!(
            out.status.success() && config.exists(),
            "atomic CLI config write should be allowed: {}",
            String::from_utf8_lossy(&out.stderr)
        );

        // Still denied: anything else in the home directory.
        let outside = home.join("escaped.txt");
        run(&format!("echo bad > {}", sbpl_shell_quote(&outside)));
        assert!(
            !outside.exists(),
            "write outside the jail must stay denied with CLI access on"
        );
    }

    #[cfg(target_os = "macos")]
    fn sbpl_shell_quote(path: &Path) -> String {
        format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
    }
}
