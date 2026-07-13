//! App side of Browser use extension pairing (JUN-287, ADR 0017).
//!
//! The June extension talks Chrome native messaging to a small shim binary
//! (`june-nm-shim`, see `shim` below); the shim relays every frame to the
//! authenticated loopback listener this module runs. Chrome spawns the shim,
//! so credentials cannot ride in its environment: the listener writes a
//! connection descriptor (port + per-run token) to a fixed file in the app
//! data dir, and the shim authenticates with it on its first frame.
//!
//! Wire format on both legs is Chrome's native messaging framing: a 4-byte
//! little-endian length prefix followed by UTF-8 JSON. Every message carries
//! `{"v": <protocol version>, "type": <string>, ...}`. The connect handshake
//! (`hello` -> `hello_ok` / `hello_incompatible`) is the version gate: the
//! store updates the extension independently of app releases, so a mismatch
//! must fail cleanly with an update prompt instead of misbehaving.

use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use rand::distributions::Alphanumeric;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::domain::types::AppError;

/// Bump when the message contract changes incompatibly. The extension pins
/// its own copy in `extension/src/protocol.ts`; `hello` negotiation compares
/// the two.
pub const PROTOCOL_VERSION: u32 = 1;

/// The extension id pinned by the `key` field in `extension/manifest.json`.
/// Regenerate both together with `node extension/scripts/generate-key.mjs`.
pub const EXTENSION_ID: &str = "adckhkfngpnenaapncoipkalcfpjbgcn";

/// Native messaging host name: the extension connects to this name, and the
/// host manifest file carries it (Chrome requires the file be named
/// `<host name>.json`).
pub const NATIVE_HOST_NAME: &str = "co.opensoftware.june.extension";

/// Must match the bundle identifier in `tauri.conf.json`; the shim has no
/// AppHandle, so it rebuilds the app data dir path from this constant.
const APP_BUNDLE_IDENTIFIER: &str = "co.opensoftware.june";

const DESCRIPTOR_FILE_NAME: &str = "extension-host.json";

/// Chrome caps extension -> host messages at 1 MiB; the contract keeps every
/// message small (large payloads become file references), so the same cap is
/// enforced on both legs and in both directions.
pub const MAX_FRAME_LEN: usize = 1024 * 1024;

const AUTH_TIMEOUT: Duration = Duration::from_secs(10);

pub const PAIRING_CHANGED_EVENT: &str = "june://extension-pairing-changed";

// --- framing ---------------------------------------------------------------

fn frame_len(header: [u8; 4]) -> std::io::Result<usize> {
    let len = u32::from_le_bytes(header) as usize;
    if len == 0 || len > MAX_FRAME_LEN {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("frame length {len} outside 1..={MAX_FRAME_LEN}"),
        ));
    }
    Ok(len)
}

pub fn encode_frame(value: &Value) -> std::io::Result<Vec<u8>> {
    let body = serde_json::to_vec(value)?;
    if body.len() > MAX_FRAME_LEN {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("frame body {} exceeds {MAX_FRAME_LEN} bytes", body.len()),
        ));
    }
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

pub fn write_frame(writer: &mut impl Write, value: &Value) -> std::io::Result<()> {
    writer.write_all(&encode_frame(value)?)?;
    writer.flush()
}

/// Reads one frame; `Ok(None)` is clean EOF at a frame boundary.
pub fn read_frame(reader: &mut impl Read) -> std::io::Result<Option<Value>> {
    let mut header = [0u8; 4];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let len = frame_len(header)?;
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    let value = serde_json::from_slice(&body)?;
    Ok(Some(value))
}

async fn read_frame_async(
    reader: &mut (impl tokio::io::AsyncRead + Unpin),
) -> std::io::Result<Option<Value>> {
    let mut header = [0u8; 4];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let len = frame_len(header)?;
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).await?;
    let value = serde_json::from_slice(&body)?;
    Ok(Some(value))
}

async fn write_frame_async(
    writer: &mut (impl tokio::io::AsyncWrite + Unpin),
    value: &Value,
) -> std::io::Result<()> {
    writer.write_all(&encode_frame(value)?).await?;
    writer.flush().await
}

// --- protocol --------------------------------------------------------------

fn message_type(value: &Value) -> Option<&str> {
    value.get("type").and_then(Value::as_str)
}

fn message_version(value: &Value) -> Option<u32> {
    value.get("v").and_then(Value::as_u64).map(|v| v as u32)
}

/// The version gate, pure so tests can drive it: a `hello` at any version
/// other than ours gets `hello_incompatible`, which the extension surfaces
/// as an update prompt.
pub fn hello_response(hello_version: Option<u32>, app_version: &str) -> Value {
    match hello_version {
        Some(v) if v == PROTOCOL_VERSION => json!({
            "v": PROTOCOL_VERSION,
            "type": "hello_ok",
            "appVersion": app_version,
        }),
        _ => json!({
            "v": PROTOCOL_VERSION,
            "type": "hello_incompatible",
            "expected": PROTOCOL_VERSION,
        }),
    }
}

// --- descriptor ------------------------------------------------------------

/// What the shim needs to reach and authenticate to the listener. Rewritten
/// on every listener start; the token is minted per run and never persisted
/// anywhere else.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDescriptor {
    pub v: u32,
    pub port: u16,
    pub token: String,
}

fn write_descriptor(
    data_dir: &std::path::Path,
    descriptor: &HostDescriptor,
) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(data_dir)?;
    let path = data_dir.join(DESCRIPTOR_FILE_NAME);
    let body = serde_json::to_vec_pretty(descriptor)?;
    std::fs::write(&path, body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(path)
}

/// The app data dir as the shim resolves it: Chrome spawns the shim, so no
/// AppHandle and no inherited June env. Mirrors `app_paths::app_data_dir` -
/// a debug shim reads the `-dev` dir a debug app writes, a release shim the
/// production dir.
pub fn shim_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        let base = PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(APP_BUNDLE_IDENTIFIER);
        Some(crate::app_paths::app_data_dir_for_build(
            base,
            cfg!(debug_assertions),
            std::env::var_os("OS_JUNE_USE_PROD_DATA_DIR").is_some(),
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

// --- pairing state ----------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatus {
    pub paired: bool,
    pub listener_running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<u32>,
}

#[derive(Default)]
struct HostShared {
    listener_running: bool,
    next_connection_id: u64,
    /// The connection whose `hello` currently backs `paired`. Pairing follows
    /// the newest successful hello; it clears only when that same connection
    /// closes, so a stray second connect cannot unpair the live one.
    paired_connection: Option<u64>,
    extension_version: Option<String>,
    protocol_version: Option<u32>,
}

#[derive(Default, Clone)]
pub struct ExtensionHost {
    shared: Arc<Mutex<HostShared>>,
}

impl ExtensionHost {
    pub fn status(&self) -> PairingStatus {
        let shared = self.shared.lock().expect("extension host state poisoned");
        PairingStatus {
            paired: shared.paired_connection.is_some(),
            listener_running: shared.listener_running,
            extension_version: shared.extension_version.clone(),
            protocol_version: shared.protocol_version,
        }
    }

    fn set_listener_running(&self, running: bool) {
        self.shared
            .lock()
            .expect("extension host state poisoned")
            .listener_running = running;
    }

    fn begin_connection(&self) -> u64 {
        let mut shared = self.shared.lock().expect("extension host state poisoned");
        shared.next_connection_id += 1;
        shared.next_connection_id
    }

    fn set_paired(&self, connection_id: u64, extension_version: Option<String>, protocol: u32) {
        let mut shared = self.shared.lock().expect("extension host state poisoned");
        shared.paired_connection = Some(connection_id);
        shared.extension_version = extension_version;
        shared.protocol_version = Some(protocol);
    }

    fn end_connection(&self, connection_id: u64) -> bool {
        let mut shared = self.shared.lock().expect("extension host state poisoned");
        if shared.paired_connection == Some(connection_id) {
            shared.paired_connection = None;
            shared.extension_version = None;
            shared.protocol_version = None;
            true
        } else {
            false
        }
    }
}

fn emit_pairing_changed(app: &AppHandle, host: &ExtensionHost) {
    let _ = app.emit(PAIRING_CHANGED_EVENT, host.status());
}

// --- listener ---------------------------------------------------------------

pub fn setup(app: &mut tauri::App) {
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = start_listener(handle).await {
            tracing::warn!(code = %error.code, message = %error.message, "extension host listener failed to start");
        }
    });
}

async fn start_listener(app: AppHandle) -> Result<(), AppError> {
    let data_dir = crate::app_paths::app_data_dir(&app)
        .map_err(|error| AppError::new("extension_host_start_failed", error.to_string()))?;
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| AppError::new("extension_host_start_failed", error.to_string()))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| AppError::new("extension_host_start_failed", error.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|error| AppError::new("extension_host_start_failed", error.to_string()))?
        .port();
    let listener = tokio::net::TcpListener::from_std(listener)
        .map_err(|error| AppError::new("extension_host_start_failed", error.to_string()))?;

    let token = random_token();
    write_descriptor(
        &data_dir,
        &HostDescriptor {
            v: PROTOCOL_VERSION,
            port,
            token: token.clone(),
        },
    )
    .map_err(|error| AppError::new("extension_host_descriptor_failed", error.to_string()))?;

    let host = app.state::<ExtensionHost>().inner().clone();
    host.set_listener_running(true);
    tracing::info!(port, "extension host listening");

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let app = app.clone();
                let host = host.clone();
                let token = token.clone();
                tauri::async_runtime::spawn(async move {
                    handle_connection(stream, app, host, token).await;
                });
            }
            Err(error) => {
                // Accept errors are usually transient; keep the listener
                // alive and back off so a persistent error can't hot-loop.
                tracing::warn!(%error, "extension host accept failed");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

async fn handle_connection(
    stream: tokio::net::TcpStream,
    app: AppHandle,
    host: ExtensionHost,
    token: String,
) {
    let (mut reader, mut writer) = stream.into_split();

    // First frame must authenticate; the descriptor file is 0600, so holding
    // the token proves same-user access. Anything else closes silently.
    let auth = match tokio::time::timeout(AUTH_TIMEOUT, read_frame_async(&mut reader)).await {
        Ok(Ok(Some(frame))) => frame,
        _ => return,
    };
    let authenticated = message_type(&auth) == Some("auth")
        && auth.get("token").and_then(Value::as_str) == Some(token.as_str());
    if !authenticated {
        return;
    }

    let connection_id = host.begin_connection();
    let app_version = app.package_info().version.to_string();

    loop {
        let frame = match read_frame_async(&mut reader).await {
            Ok(Some(frame)) => frame,
            Ok(None) | Err(_) => break,
        };
        let reply = match message_type(&frame) {
            Some("hello") => {
                let version = message_version(&frame);
                let reply = hello_response(version, &app_version);
                if message_type(&reply) == Some("hello_ok") {
                    let extension_version = frame
                        .get("extensionVersion")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    host.set_paired(
                        connection_id,
                        extension_version,
                        version.unwrap_or(PROTOCOL_VERSION),
                    );
                    emit_pairing_changed(&app, &host);
                }
                reply
            }
            Some("ping") => {
                let mut reply = json!({ "v": PROTOCOL_VERSION, "type": "pong" });
                if let Some(id) = frame.get("id") {
                    reply["id"] = id.clone();
                }
                reply
            }
            _ => json!({ "v": PROTOCOL_VERSION, "type": "error", "code": "unknown_message" }),
        };
        if write_frame_async(&mut writer, &reply).await.is_err() {
            break;
        }
    }

    if host.end_connection(connection_id) {
        emit_pairing_changed(&app, &host);
    }
}

fn random_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(43)
        .map(char::from)
        .collect()
}

// --- host manifest registration ----------------------------------------------

/// The Chrome native messaging host manifest: pins the shim path and the
/// extension id. `allowed_origins` is the boundary that keeps any other
/// extension from connecting - Chrome refuses `connectNative` from ids not
/// listed here.
pub fn host_manifest_json(shim_path: &std::path::Path) -> Value {
    json!({
        "name": NATIVE_HOST_NAME,
        "description": "June browser extension connector",
        "path": shim_path.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
    })
}

/// Where the running app expects the shim binary, dev paths first (the
/// dictation helper probing shape). Dev builds compile the shim next to the
/// app executable (`target/<profile>/june-nm-shim`); bundled builds carry it
/// under `Resources/native/bin/`.
fn shim_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            paths.push(exe_dir.join("june-nm-shim"));
            paths.push(exe_dir.join("../Resources/native/bin/june-nm-shim"));
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        paths.push(resource_dir.join("native").join("bin").join("june-nm-shim"));
    }
    paths
}

fn chrome_native_messaging_hosts_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("Google")
                .join("Chrome")
                .join("NativeMessagingHosts"),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterExtensionHostResult {
    pub manifest_path: String,
    pub shim_path: String,
}

// --- commands ----------------------------------------------------------------

#[tauri::command]
pub fn extension_pairing_status(state: tauri::State<'_, ExtensionHost>) -> PairingStatus {
    state.status()
}

/// Writes (or rewrites) the Chrome host manifest so Chrome can spawn the shim.
/// Resolved at registration time, never hardcoded: dev registration points at
/// the dev shim, a bundled app at its own Resources copy.
#[tauri::command]
pub fn register_browser_extension_host(
    app: AppHandle,
) -> Result<RegisterExtensionHostResult, AppError> {
    let shim_path = shim_candidates(&app)
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| {
            AppError::new(
                "extension_shim_missing",
                "Could not find the june-nm-shim binary. Run a full build first.",
            )
        })?;
    let shim_path = shim_path
        .canonicalize()
        .map_err(|error| AppError::new("extension_host_register_failed", error.to_string()))?;
    let hosts_dir = chrome_native_messaging_hosts_dir().ok_or_else(|| {
        AppError::new(
            "extension_host_unsupported",
            "Browser extension pairing is only supported on macOS for now.",
        )
    })?;
    std::fs::create_dir_all(&hosts_dir)
        .map_err(|error| AppError::new("extension_host_register_failed", error.to_string()))?;
    let manifest_path = hosts_dir.join(format!("{NATIVE_HOST_NAME}.json"));
    let manifest = host_manifest_json(&shim_path);
    let body = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| AppError::new("extension_host_register_failed", error.to_string()))?;
    std::fs::write(&manifest_path, body)
        .map_err(|error| AppError::new("extension_host_register_failed", error.to_string()))?;
    Ok(RegisterExtensionHostResult {
        manifest_path: manifest_path.to_string_lossy().into_owned(),
        shim_path: shim_path.to_string_lossy().into_owned(),
    })
}

// --- shim --------------------------------------------------------------------

/// The native messaging shim: a dumb relay with no policy. Chrome speaks
/// framed JSON over the shim's stdio; the shim opens the loopback socket the
/// descriptor names, authenticates with the descriptor token as its first
/// frame, and then pumps frames in both directions unchanged.
pub mod shim {
    use super::{
        json, read_frame, shim_data_dir, write_frame, HostDescriptor, Value, DESCRIPTOR_FILE_NAME,
        PROTOCOL_VERSION,
    };
    use std::io::{Read, Write};
    use std::net::TcpStream;

    pub fn descriptor_path() -> Option<std::path::PathBuf> {
        shim_data_dir().map(|dir| dir.join(DESCRIPTOR_FILE_NAME))
    }

    fn read_descriptor() -> Result<HostDescriptor, String> {
        let path = descriptor_path().ok_or("unsupported platform")?;
        let raw = std::fs::read(&path).map_err(|error| error.to_string())?;
        serde_json::from_slice(&raw).map_err(|error| error.to_string())
    }

    fn error_frame(code: &str) -> Value {
        json!({ "v": PROTOCOL_VERSION, "type": "error", "code": code })
    }

    /// Entry point for the `june-nm-shim` binary: wires real stdio and exits
    /// nonzero when the app side is unreachable (after telling the extension
    /// why, so the popup can say "June is not running").
    pub fn run() -> i32 {
        // `Stdin`/`Stdout` (not their locks): the Chrome-side reader moves to
        // the pump thread, and `StdinLock` is not `Send`.
        let mut stdout = std::io::stdout();
        let descriptor = match read_descriptor() {
            Ok(descriptor) => descriptor,
            Err(_) => {
                let _ = write_frame(&mut stdout, &error_frame("app_unreachable"));
                return 1;
            }
        };
        let socket = match TcpStream::connect(("127.0.0.1", descriptor.port)) {
            Ok(socket) => socket,
            Err(_) => {
                let _ = write_frame(&mut stdout, &error_frame("app_unreachable"));
                return 1;
            }
        };
        match relay(std::io::stdin(), stdout, socket, &descriptor.token) {
            Ok(()) => 0,
            Err(_) => 1,
        }
    }

    /// Frame-level pump: authenticates, then copies frames both ways until
    /// either side closes. Frame-level (not byte-level) so the 1 MiB cap is
    /// enforced on every message in both directions.
    pub fn relay(
        chrome_in: impl Read + Send + 'static,
        mut chrome_out: impl Write,
        socket: TcpStream,
        token: &str,
    ) -> std::io::Result<()> {
        let mut socket_writer = socket.try_clone()?;
        let mut socket_reader = socket;
        write_frame(
            &mut socket_writer,
            &json!({ "v": PROTOCOL_VERSION, "type": "auth", "token": token }),
        )?;

        let to_socket = std::thread::spawn(move || -> std::io::Result<()> {
            let mut chrome_in = chrome_in;
            while let Some(frame) = read_frame(&mut chrome_in)? {
                write_frame(&mut socket_writer, &frame)?;
            }
            // Chrome closed our stdin (port disconnected); closing the socket
            // write half unblocks the app side.
            let _ = socket_writer.shutdown(std::net::Shutdown::Write);
            Ok(())
        });

        let mut result = Ok(());
        loop {
            match read_frame(&mut socket_reader) {
                Ok(Some(frame)) => {
                    if let Err(error) = write_frame(&mut chrome_out, &frame) {
                        result = Err(error);
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    result = Err(error);
                    break;
                }
            }
        }
        let _ = socket_reader.shutdown(std::net::Shutdown::Both);
        let _ = to_socket.join();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrip_preserves_json() {
        let value = json!({ "v": 1, "type": "hello", "extensionVersion": "0.1.0" });
        let mut buffer = Vec::new();
        write_frame(&mut buffer, &value).expect("write");
        let decoded = read_frame(&mut buffer.as_slice()).expect("read");
        assert_eq!(decoded, Some(value));
    }

    #[test]
    fn read_frame_returns_none_on_clean_eof() {
        let decoded = read_frame(&mut [].as_slice()).expect("read");
        assert_eq!(decoded, None);
    }

    #[test]
    fn read_frame_rejects_oversize_length_prefix() {
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&((MAX_FRAME_LEN as u32) + 1).to_le_bytes());
        buffer.extend_from_slice(b"ignored");
        assert!(read_frame(&mut buffer.as_slice()).is_err());
    }

    #[test]
    fn read_frame_rejects_truncated_body() {
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&16u32.to_le_bytes());
        buffer.extend_from_slice(b"{}");
        assert!(read_frame(&mut buffer.as_slice()).is_err());
    }

    #[test]
    fn encode_frame_rejects_oversize_body() {
        let value = Value::String("x".repeat(MAX_FRAME_LEN));
        assert!(encode_frame(&value).is_err());
    }

    #[test]
    fn hello_at_current_version_is_accepted() {
        let reply = hello_response(Some(PROTOCOL_VERSION), "0.0.32");
        assert_eq!(reply["type"], "hello_ok");
        assert_eq!(reply["v"], PROTOCOL_VERSION);
        assert_eq!(reply["appVersion"], "0.0.32");
    }

    #[test]
    fn hello_at_other_versions_is_rejected_with_expected_version() {
        for version in [None, Some(0), Some(2), Some(999)] {
            let reply = hello_response(version, "0.0.32");
            assert_eq!(reply["type"], "hello_incompatible", "version {version:?}");
            assert_eq!(reply["expected"], PROTOCOL_VERSION);
        }
    }

    #[test]
    fn host_manifest_pins_the_extension_id_and_shim_path() {
        let manifest = host_manifest_json(std::path::Path::new("/tmp/june-nm-shim"));
        assert_eq!(manifest["name"], NATIVE_HOST_NAME);
        assert_eq!(manifest["type"], "stdio");
        assert_eq!(manifest["path"], "/tmp/june-nm-shim");
        let origins = manifest["allowed_origins"].as_array().expect("origins");
        assert_eq!(
            origins,
            &[Value::String(format!("chrome-extension://{EXTENSION_ID}/"))]
        );
    }

    #[test]
    fn pairing_follows_the_connection_that_said_hello() {
        let host = ExtensionHost::default();
        let first = host.begin_connection();
        let second = host.begin_connection();
        host.set_paired(second, Some("0.1.0".into()), PROTOCOL_VERSION);
        assert!(host.status().paired);

        // A stale connection closing must not unpair the live one.
        assert!(!host.end_connection(first));
        assert!(host.status().paired);

        assert!(host.end_connection(second));
        let status = host.status();
        assert!(!status.paired);
        assert_eq!(status.extension_version, None);
    }

    #[test]
    fn descriptor_roundtrips_and_is_owner_only() {
        let temp = tempfile::tempdir().expect("tempdir");
        let descriptor = HostDescriptor {
            v: PROTOCOL_VERSION,
            port: 4321,
            token: "secret".into(),
        };
        let path = write_descriptor(temp.path(), &descriptor).expect("write");
        let raw = std::fs::read(&path).expect("read");
        let decoded: HostDescriptor = serde_json::from_slice(&raw).expect("parse");
        assert_eq!(decoded.port, 4321);
        assert_eq!(decoded.token, "secret");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).expect("meta").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
