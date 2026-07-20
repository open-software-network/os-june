//! Authenticated, narrow Computer use helper.
//!
//! This binary links the pinned upstream macOS implementation, but it does
//! not expose upstream's CLI or complete MCP registry. June starts it over a
//! private local socket and authenticates both June's peer process and a fresh
//! in-memory capability. LaunchServices owns the helper process so macOS TCC
//! grants belong to this bundle, while direct launches still provide no
//! desktop-control surface.

#[cfg(target_os = "macos")]
use cua_driver_core::{
    protocol::{initialize_result, Request, Response},
    tool::ToolRegistry,
};
#[cfg(target_os = "macos")]
use serde_json::{json, Value};
#[cfg(target_os = "macos")]
use std::{collections::HashSet, io, path::PathBuf, sync::Arc};
#[cfg(target_os = "macos")]
use tokio::{
    io::{
        AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt,
        BufReader,
    },
    net::UnixListener,
};

const UPSTREAM_VERSION: &str = "0.5.0";
const UPSTREAM_COMMIT: &str = "51582fd2ad8cffb68b2c6c81077d391132d7a0e1";
const MAX_REQUEST_BYTES: usize = 256 * 1024;

#[cfg(target_os = "macos")]
#[derive(Debug, PartialEq, Eq)]
enum BoundedLine {
    Eof,
    Line(String),
    TooLarge,
}

#[cfg(target_os = "macos")]
async fn read_bounded_line<R>(reader: &mut R, max_bytes: usize) -> io::Result<BoundedLine>
where
    R: AsyncBufRead + Unpin,
{
    let mut bytes = Vec::with_capacity(max_bytes.min(8 * 1024));
    let limit = u64::try_from(max_bytes)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let read = reader.take(limit).read_until(b'\n', &mut bytes).await?;
    if read == 0 {
        return Ok(BoundedLine::Eof);
    }
    if read > max_bytes {
        return Ok(BoundedLine::TooLarge);
    }
    String::from_utf8(bytes)
        .map(BoundedLine::Line)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

#[cfg(target_os = "macos")]
const ALLOWED_TOOLS: &[&str] = &[
    "check_permissions",
    "list_windows",
    "launch_app",
    "join_current_stage",
    "get_window_state",
    "click",
    "double_click",
    "right_click",
    "drag",
    "scroll",
    "type_text",
    "press_key",
    "hotkey",
    "set_value",
];

#[cfg(target_os = "macos")]
#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.as_slice() == ["--version"] {
        println!("june-computer-use-driver {UPSTREAM_VERSION} {UPSTREAM_COMMIT}");
        return;
    }
    let result = match args.as_slice() {
        [mode] if mode == "mcp" && parent_is_june() => serve_stdio().await,
        [mode] if mode == "mcp-daemon" => serve_daemon().await,
        [mode] if mode == "mcp" => Err(anyhow::anyhow!(
            "the helper must be launched directly by June"
        )),
        _ => Err(anyhow::anyhow!("This helper is private to June.")),
    };
    if let Err(error) = result {
        eprintln!("Computer use helper stopped: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("Computer use is available on macOS only.");
    std::process::exit(69);
}

#[cfg(target_os = "macos")]
async fn serve_stdio() -> anyhow::Result<()> {
    serve(tokio::io::stdin(), tokio::io::stdout()).await
}

#[cfg(target_os = "macos")]
async fn serve_daemon() -> anyhow::Result<()> {
    let socket_path = std::env::var("JUNE_COMPUTER_USE_SOCKET")
        .map(PathBuf::from)
        .map_err(|_| anyhow::anyhow!("the private June socket is missing"))?;
    if !socket_path.is_absolute() {
        anyhow::bail!("the private June socket must be absolute");
    }
    let listener = UnixListener::bind(&socket_path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))?;
    }
    request_startup_permission();
    let (stream, _) = tokio::time::timeout(std::time::Duration::from_secs(15), listener.accept())
        .await
        .map_err(|_| anyhow::anyhow!("June did not connect to the private helper"))??;
    let peer_pid = stream
        .peer_cred()?
        .pid()
        .ok_or_else(|| anyhow::anyhow!("the private June peer has no process identity"))?;
    if !process_is_june(peer_pid) {
        anyhow::bail!("the private helper accepts only June");
    }
    let (reader, writer) = stream.into_split();
    let result = serve(reader, writer).await;
    let _ = std::fs::remove_file(socket_path);
    result
}

#[cfg(target_os = "macos")]
fn request_startup_permission() {
    match std::env::var("JUNE_COMPUTER_USE_PERMISSION_PROMPT").as_deref() {
        Ok("accessibility") => {
            let _ = platform_macos::permissions::status::request_accessibility();
        }
        Ok("screen-recording") => {
            let _ = platform_macos::permissions::status::request_screen_recording();
        }
        _ => {}
    }
}

#[cfg(target_os = "macos")]
fn permission_result() -> Value {
    let status = platform_macos::permissions::current_status();
    let accessibility = status.accessibility;
    let screen_recording = status.screen_recording;
    let text = format!(
        "{} Accessibility: {}.\n{} Screen Recording: {}.",
        if accessibility { "✅" } else { "❌" },
        if accessibility {
            "granted"
        } else {
            "NOT granted"
        },
        if screen_recording { "✅" } else { "❌" },
        if screen_recording {
            "granted"
        } else {
            "NOT granted"
        },
    );
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": {
            "accessibility": accessibility,
            "screen_recording": screen_recording,
            // This fresh LaunchServices process owns both the preflight and
            // every later capture. Avoid upstream's blocking live probe here;
            // actual captures remain the authoritative runtime check.
            "screen_recording_capturable": screen_recording,
            "source": {
                "attribution": "driver-app",
                "pid": std::process::id(),
                "executable": std::env::current_exe()
                    .ok()
                    .and_then(|path| path.to_str().map(str::to_owned))
                    .unwrap_or_default(),
            },
        },
        "isError": false,
    })
}

#[cfg(target_os = "macos")]
async fn serve<R, W>(reader: R, writer: W) -> anyhow::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let registry = Arc::new(platform_macos::register_tools());
    registry.init_self_weak();
    let allowed: HashSet<&'static str> = ALLOWED_TOOLS.iter().copied().collect();
    let mut authenticated = false;
    let mut reader = BufReader::new(reader);
    let mut stdout = tokio::io::BufWriter::new(writer);

    loop {
        let line = match read_bounded_line(&mut reader, MAX_REQUEST_BYTES).await? {
            BoundedLine::Eof => break,
            BoundedLine::TooLarge => {
                write_response(&mut stdout, Response::parse_error()).await?;
                break;
            }
            BoundedLine::Line(line) => line,
        };
        let request = match serde_json::from_str::<Request>(line.trim()) {
            Ok(request) => request,
            Err(_) => {
                write_response(&mut stdout, Response::parse_error()).await?;
                continue;
            }
        };
        if request.is_notification() {
            continue;
        }
        let id = request.id.clone().unwrap_or(Value::Null);
        let response = match request.method.as_str() {
            "initialize" if !authenticated => {
                if initialize_capability(request.params.as_ref()).is_some_and(valid_capability) {
                    authenticated = true;
                    let mut result = initialize_result();
                    result["serverInfo"] = json!({
                        "name": "June Computer Use Driver",
                        "version": UPSTREAM_VERSION,
                    });
                    result["instructions"] = Value::String(
                        "Private June helper. Desktop actions require June's Rust policy broker."
                            .to_string(),
                    );
                    Response::ok(id, result)
                } else {
                    let response = Response::error(id, -32001, "June capability required.");
                    write_response(&mut stdout, response).await?;
                    break;
                }
            }
            _ if !authenticated => Response::error(id, -32001, "June capability required."),
            "tools/list" => Response::ok(id, allowed_tool_list(&registry, &allowed)),
            "tools/call" => match request.tool_call() {
                Err(error) => Response::error(id, -32602, format!("Invalid params: {error}")),
                Ok(call) if !allowed.contains(call.name.as_str()) => {
                    Response::error(id, -32601, "That driver tool is not available to June.")
                }
                Ok(call) if !arguments_are_narrow(&call.name, &call.args) => Response::error(
                    id,
                    -32602,
                    "The driver request contains fields outside June's contract.",
                ),
                Ok(call) if call.name == "check_permissions" => {
                    Response::ok(id, permission_result())
                }
                Ok(call) if call.name == "join_current_stage" => {
                    Response::ok(id, join_current_stage_result(&call.args))
                }
                Ok(call) => {
                    let result = registry.invoke(&call.name, call.args).await;
                    match serde_json::to_value(result) {
                        Ok(result) => Response::ok(id, result),
                        Err(error) => {
                            Response::error(id, -32603, format!("Serialize error: {error}"))
                        }
                    }
                }
            },
            method => Response::method_not_found(id, method),
        };
        write_response(&mut stdout, response).await?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn parent_is_june() -> bool {
    process_is_june(unsafe { libc::getppid() })
}

#[cfg(target_os = "macos")]
fn process_is_june(pid: libc::pid_t) -> bool {
    let Some(process_path) = process_path(pid) else {
        return false;
    };
    let Ok(helper_path) = std::env::current_exe() else {
        return false;
    };

    // Packaged build: the helper is nested under the signed outer June.app.
    // Require its direct parent to be that exact outer bundle executable.
    let app_ancestors: Vec<PathBuf> = helper_path
        .ancestors()
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        })
        .map(PathBuf::from)
        .collect();
    if let (Some(helper_app), Some(outer_app)) = (app_ancestors.first(), app_ancestors.get(1)) {
        return same_file(
            &process_path,
            &outer_app.join("Contents").join("MacOS").join("June"),
        ) && packaged_signatures_match(outer_app, helper_app);
    }

    // Development builds are not nested yet. Accept only the Cargo binary or
    // the byte-identical `June` launcher materialized by the Tauri dev runner,
    // both inside this checkout's Cargo target tree.
    cfg!(debug_assertions)
        && development_process_path_is_june(
            &process_path,
            &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target"),
        )
}

#[cfg(target_os = "macos")]
fn development_process_path_is_june(
    process_path: &std::path::Path,
    target_root: &std::path::Path,
) -> bool {
    if !process_path.starts_with(target_root) {
        return false;
    }
    let Some(name) = process_path.file_name() else {
        return false;
    };
    if name == "os-june" {
        return true;
    }
    if !development_launcher_name_is_allowed(name) {
        return false;
    }

    // The dev runner creates its product-named launcher as a hard link to the
    // canonical Cargo binary. Requiring the same device and inode keeps the
    // human-readable suffix from widening this trust boundary to another
    // executable that merely copied an allowed name into target/.
    let Some(profile_dir) = process_path.parent() else {
        return false;
    };
    same_file(process_path, &profile_dir.join("os-june"))
}

#[cfg(target_os = "macos")]
fn development_launcher_name_is_allowed(name: &std::ffi::OsStr) -> bool {
    if name == "June" {
        return true;
    }
    let Some(name) = name.to_str() else {
        return false;
    };
    let mut parts = name.split(' ');
    let (Some(product), Some(issue), Some(harness), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let Some(issue_number) = issue.strip_prefix("JUN-") else {
        return false;
    };
    product == "June"
        && !issue_number.is_empty()
        && issue_number.bytes().all(|byte| byte.is_ascii_digit())
        && matches!(harness, "Codex" | "Claude")
}

#[cfg(target_os = "macos")]
fn packaged_signatures_match(outer_app: &std::path::Path, helper_app: &std::path::Path) -> bool {
    let Some(outer) = verified_signature(outer_app, "co.opensoftware.june") else {
        return false;
    };
    let Some(helper) = verified_signature(helper_app, "co.opensoftware.june.computer-use-driver")
    else {
        return false;
    };
    outer.team_identifier == helper.team_identifier
}

#[cfg(target_os = "macos")]
struct VerifiedSignature {
    team_identifier: String,
}

#[cfg(target_os = "macos")]
fn verified_signature(
    path: &std::path::Path,
    expected_identifier: &str,
) -> Option<VerifiedSignature> {
    let verified = std::process::Command::new("/usr/bin/codesign")
        .args(["--verify", "--strict"])
        .arg(path)
        .status()
        .ok()?
        .success();
    if !verified {
        return None;
    }
    let details = std::process::Command::new("/usr/bin/codesign")
        .args(["-dv", "--verbose=4"])
        .arg(path)
        .output()
        .ok()?;
    if !details.status.success() {
        return None;
    }
    let details = format!(
        "{}\n{}",
        String::from_utf8_lossy(&details.stdout),
        String::from_utf8_lossy(&details.stderr)
    );
    let identifier = signature_value(&details, "Identifier")?;
    let team_identifier = signature_value(&details, "TeamIdentifier")?;
    if identifier != expected_identifier || team_identifier == "not set" {
        return None;
    }
    Some(VerifiedSignature {
        team_identifier: team_identifier.to_string(),
    })
}

#[cfg(target_os = "macos")]
fn signature_value<'a>(details: &'a str, key: &str) -> Option<&'a str> {
    let prefix = format!("{key}=");
    details
        .lines()
        .find_map(|line| line.trim().strip_prefix(prefix.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

#[cfg(target_os = "macos")]
fn process_path(pid: libc::pid_t) -> Option<PathBuf> {
    const PROC_PIDPATHINFO_MAXSIZE: usize = 4096;
    let mut buffer = vec![0u8; PROC_PIDPATHINFO_MAXSIZE];
    let length = unsafe {
        proc_pidpath(
            pid,
            buffer.as_mut_ptr().cast(),
            u32::try_from(buffer.len()).ok()?,
        )
    };
    if length <= 0 {
        return None;
    }
    buffer.truncate(usize::try_from(length).ok()?);
    if buffer.last() == Some(&0) {
        buffer.pop();
    }
    String::from_utf8(buffer).ok().map(PathBuf::from)
}

#[cfg(target_os = "macos")]
fn same_file(left: &std::path::Path, right: &std::path::Path) -> bool {
    use std::os::unix::fs::MetadataExt;

    let (Ok(left), Ok(right)) = (std::fs::metadata(left), std::fs::metadata(right)) else {
        return false;
    };
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(target_os = "macos")]
#[link(name = "proc")]
extern "C" {
    fn proc_pidpath(pid: libc::pid_t, buffer: *mut libc::c_void, buffersize: u32) -> libc::c_int;
}

#[cfg(target_os = "macos")]
fn initialize_capability(params: Option<&Value>) -> Option<&str> {
    params?
        .get("capabilities")?
        .get("experimental")?
        .get("juneComputerUseCapability")?
        .as_str()
}

#[cfg(target_os = "macos")]
fn valid_capability(candidate: &str) -> bool {
    let expected = std::env::var("JUNE_COMPUTER_USE_HELPER_CAPABILITY").unwrap_or_default();
    if expected.len() < 32 || candidate.len() != expected.len() {
        return false;
    }
    candidate
        .as_bytes()
        .iter()
        .zip(expected.as_bytes())
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

#[cfg(target_os = "macos")]
fn allowed_tool_list(registry: &ToolRegistry, allowed: &HashSet<&str>) -> Value {
    let mut tools: Vec<Value> = registry
        .iter_defs()
        .filter(|(name, _)| allowed.contains(name))
        .map(|(name, definition)| {
            if name == "launch_app" {
                launch_app_tool_definition()
            } else {
                definition.to_list_entry()
            }
        })
        .collect();
    tools.push(join_current_stage_tool_definition());
    json!({ "tools": tools })
}

#[cfg(target_os = "macos")]
fn launch_app_tool_definition() -> Value {
    json!({
        "name": "launch_app",
        "description": "Open an installed macOS app by display name in the background.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": { "type": "string", "minLength": 1, "maxLength": 200 }
            },
            "required": ["name"],
            "additionalProperties": false
        }
    })
}

#[cfg(target_os = "macos")]
fn join_current_stage_tool_definition() -> Value {
    json!({
        "name": "join_current_stage",
        "description": "Raise one authorized app window inside June's current Stage Manager group without following it to another Space.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "pid": { "type": "integer", "minimum": 1 },
                "window_id": { "type": "integer", "minimum": 1 }
            },
            "required": ["pid", "window_id"],
            "additionalProperties": false
        }
    })
}

#[cfg(target_os = "macos")]
fn join_current_stage_result(arguments: &Value) -> Value {
    let pid = arguments
        .get("pid")
        .and_then(Value::as_i64)
        .and_then(|pid| i32::try_from(pid).ok())
        .filter(|pid| *pid > 0);
    let Some(pid) = pid else {
        return json!({
            "content": [{ "type": "text", "text": "join_current_stage requires a positive pid." }],
            "isError": true
        });
    };
    let window_id = arguments
        .get("window_id")
        .and_then(Value::as_u64)
        .and_then(|window_id| u32::try_from(window_id).ok())
        .filter(|window_id| *window_id > 0);
    let Some(window_id) = window_id else {
        return json!({
            "content": [{ "type": "text", "text": "join_current_stage requires a positive window_id." }],
            "isError": true
        });
    };

    let activated_application = activate_application(pid);
    if activated_application {
        std::thread::sleep(std::time::Duration::from_millis(350));
    }
    let focused_without_space_follow =
        platform_macos::input::skylight::activate_without_raise(pid, window_id);
    let raised_with_accessibility = raise_ax_window(pid, window_id);
    if stage_join_was_dispatched(
        activated_application,
        focused_without_space_follow,
        raised_with_accessibility,
    ) {
        json!({
            "content": [{ "type": "text", "text": format!("Added app window {window_id} to the current stage.") }],
            "structuredContent": {
                "pid": pid,
                "window_id": window_id,
                "raised": true,
                "activated_application": activated_application,
                "focused_without_space_follow": focused_without_space_follow,
                "raised_with_accessibility": raised_with_accessibility
            },
            "isError": false
        })
    } else {
        json!({
            "content": [{ "type": "text", "text": "The selected app window could not be raised in the current stage." }],
            "structuredContent": {
                "pid": pid,
                "window_id": window_id,
                "raised": false,
                "activated_application": activated_application,
                "focused_without_space_follow": focused_without_space_follow,
                "raised_with_accessibility": raised_with_accessibility
            },
            "isError": true
        })
    }
}

#[cfg(target_os = "macos")]
fn stage_join_was_dispatched(
    activated_application: bool,
    focused_without_space_follow: bool,
    raised_with_accessibility: bool,
) -> bool {
    // The broker re-lists the exact window after a native path is dispatched.
    // AppKit activation is authoritative for the Stage Manager transition;
    // SkyLight focus and Accessibility raise are reported separately so the
    // broker can require both when AppKit activation is unavailable.
    activated_application || focused_without_space_follow || raised_with_accessibility
}

#[cfg(target_os = "macos")]
fn activate_application(pid: i32) -> bool {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

    NSRunningApplication::runningApplicationWithProcessIdentifier(pid).is_some_and(|application| {
        !application.isTerminated()
            && application.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows)
    })
}

#[cfg(target_os = "macos")]
fn raise_ax_window(pid: i32, window_id: u32) -> bool {
    use platform_macos::ax::bindings::{
        ax_get_window_id, copy_ax_windows, kAXErrorSuccess, perform_action,
        AXUIElementCreateApplication,
    };

    unsafe extern "C" {
        fn CFRelease(value: *const libc::c_void);
    }

    unsafe {
        let application = AXUIElementCreateApplication(pid);
        if application.is_null() {
            return false;
        }
        let windows = copy_ax_windows(application);
        let mut raised = false;
        for window in windows {
            if ax_get_window_id(window) == Some(window_id)
                && perform_action(window, "AXRaise") == kAXErrorSuccess
            {
                raised = true;
            }
            CFRelease(window.cast());
        }
        CFRelease(application.cast());
        raised
    }
}

#[cfg(target_os = "macos")]
fn arguments_are_narrow(tool: &str, arguments: &Value) -> bool {
    let Some(arguments) = arguments.as_object() else {
        return false;
    };
    let allowed: &[&str] = match tool {
        "check_permissions" => &["prompt"],
        "list_windows" => &["pid", "on_screen_only"],
        "launch_app" => &["name"],
        "join_current_stage" => &["pid", "window_id"],
        "get_window_state" => &["pid", "window_id", "capture_mode"],
        "click" | "double_click" | "right_click" => &[
            "pid",
            "window_id",
            "element_index",
            "x",
            "y",
            "count",
            "modifier",
        ],
        "drag" => &[
            "pid",
            "window_id",
            "from_x",
            "from_y",
            "to_x",
            "to_y",
            "modifier",
        ],
        "scroll" => &["pid", "window_id", "element_index", "direction", "amount"],
        "type_text" => &["pid", "window_id", "element_index", "text"],
        "press_key" => &["pid", "window_id", "element_index", "key", "modifiers"],
        "hotkey" => &["pid", "window_id", "keys"],
        "set_value" => &["pid", "window_id", "element_index", "value"],
        _ => return false,
    };
    if !arguments.keys().all(|key| allowed.contains(&key.as_str())) {
        return false;
    }
    match tool {
        "launch_app" => {
            arguments.len() == 1
                && arguments
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| !name.trim().is_empty() && name.chars().count() <= 200)
        }
        "join_current_stage" => {
            arguments.len() == 2
                && arguments
                    .get("pid")
                    .and_then(Value::as_i64)
                    .is_some_and(|pid| pid > 0 && i32::try_from(pid).is_ok())
                && arguments
                    .get("window_id")
                    .and_then(Value::as_u64)
                    .is_some_and(|window_id| window_id > 0 && u32::try_from(window_id).is_ok())
        }
        _ => true,
    }
}

#[cfg(target_os = "macos")]
async fn write_response<W>(
    stdout: &mut tokio::io::BufWriter<W>,
    response: Response,
) -> anyhow::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let mut bytes = serde_json::to_vec(&response)?;
    bytes.push(b'\n');
    stdout.write_all(&bytes).await?;
    stdout.flush().await?;
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn stage_join_continues_when_any_native_path_dispatched() {
        assert!(stage_join_was_dispatched(true, false, false));
        assert!(stage_join_was_dispatched(false, true, false));
        assert!(stage_join_was_dispatched(false, false, true));
        assert!(stage_join_was_dispatched(true, true, true));
        assert!(!stage_join_was_dispatched(false, false, false));
    }

    #[test]
    fn development_peer_accepts_cargo_and_tauri_runner_names_only() {
        let target = std::path::Path::new("/repo/src-tauri/target");

        assert!(development_process_path_is_june(
            std::path::Path::new("/repo/src-tauri/target/debug/os-june"),
            target,
        ));
        assert!(!development_process_path_is_june(
            std::path::Path::new("/repo/src-tauri/target/debug/june-lookalike"),
            target,
        ));
        assert!(!development_process_path_is_june(
            std::path::Path::new("/tmp/target/debug/June"),
            target,
        ));

        assert!(development_launcher_name_is_allowed(std::ffi::OsStr::new(
            "June"
        )));
        assert!(development_launcher_name_is_allowed(std::ffi::OsStr::new(
            "June JUN-278 Codex"
        )));
        assert!(development_launcher_name_is_allowed(std::ffi::OsStr::new(
            "June JUN-00278 Claude"
        )));
        assert!(!development_launcher_name_is_allowed(std::ffi::OsStr::new(
            "June JUN-278 Unknown"
        )));
        assert!(!development_launcher_name_is_allowed(std::ffi::OsStr::new(
            "June JUN-two Codex"
        )));
    }

    #[test]
    fn development_peer_accepts_the_issue_suffixed_tauri_launcher() {
        let workspace = tempfile::tempdir().expect("temporary workspace");
        let target = workspace.path().join("target");
        let profile = target.join("debug");
        std::fs::create_dir_all(&profile).expect("debug profile");
        let cargo_binary = profile.join("os-june");
        std::fs::write(&cargo_binary, b"june development binary").expect("cargo binary");
        let launcher = profile.join("June JUN-278 Codex");
        std::fs::hard_link(&cargo_binary, &launcher).expect("Tauri launcher");

        assert!(development_process_path_is_june(&launcher, &target));

        let copied_lookalike = profile.join("June JUN-279 Codex");
        std::fs::copy(&cargo_binary, &copied_lookalike).expect("copied lookalike");
        assert!(!development_process_path_is_june(
            &copied_lookalike,
            &target
        ));
    }

    #[tokio::test]
    async fn request_reader_enforces_the_limit_while_reading() {
        let mut reader = BufReader::new(&b"{}\n"[..]);
        assert_eq!(
            read_bounded_line(&mut reader, 3).await.expect("valid line"),
            BoundedLine::Line("{}\n".to_string())
        );

        let mut oversized = BufReader::new(&b"12345"[..]);
        assert_eq!(
            read_bounded_line(&mut oversized, 4)
                .await
                .expect("bounded read"),
            BoundedLine::TooLarge
        );
    }

    #[test]
    fn narrow_contract_allows_only_policy_brokered_lifecycle_tools() {
        assert!(ALLOWED_TOOLS.contains(&"launch_app"));
        assert!(ALLOWED_TOOLS.contains(&"join_current_stage"));
        for denied in [
            "kill_app",
            "move_cursor",
            "set_config",
            "start_recording",
            "replay_trajectory",
            "update",
        ] {
            assert!(!ALLOWED_TOOLS.contains(&denied));
        }
    }

    #[test]
    fn app_lifecycle_arguments_cannot_smuggle_paths_urls_or_process_options() {
        assert!(arguments_are_narrow(
            "launch_app",
            &json!({ "name": "TextEdit" }),
        ));
        assert!(arguments_are_narrow(
            "join_current_stage",
            &json!({ "pid": 42, "window_id": 84 }),
        ));
        for arguments in [
            json!({ "name": "TextEdit", "urls": ["file:///tmp/private"] }),
            json!({ "name": "TextEdit", "additional_arguments": ["--unsafe"] }),
            json!({ "name": "TextEdit", "electron_debugging_port": 9222 }),
            json!({ "name": "TextEdit", "webkit_inspector_port": 9223 }),
            json!({ "name": "TextEdit", "creates_new_application_instance": true }),
        ] {
            assert!(!arguments_are_narrow("launch_app", &arguments));
        }
        assert!(!arguments_are_narrow(
            "join_current_stage",
            &json!({ "pid": 42, "window_id": 84, "bundle_id": "com.apple.TextEdit" }),
        ));
        assert!(!arguments_are_narrow(
            "join_current_stage",
            &json!({ "pid": 42 }),
        ));
    }

    #[test]
    fn file_output_and_session_injection_are_rejected() {
        assert!(!arguments_are_narrow(
            "get_window_state",
            &json!({ "pid": 1, "window_id": 2, "screenshot_out_file": "/tmp/leak" }),
        ));
        assert!(!arguments_are_narrow(
            "click",
            &json!({ "pid": 1, "window_id": 2, "x": 3, "y": 4, "session": "bypass" }),
        ));
    }
}
