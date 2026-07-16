//! Authenticated, narrow Computer use helper.
//!
//! This binary links the pinned upstream macOS implementation, but it does
//! not expose upstream's CLI or complete MCP registry. June starts it over a
//! private stdio pipe and authenticates the connection with a fresh in-memory
//! capability. Launching the bundled executable directly therefore provides
//! no desktop-control surface.

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
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

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
    if args.as_slice() != ["mcp"] {
        eprintln!("This helper is private to June.");
        std::process::exit(64);
    }
    if let Err(error) = serve().await {
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
async fn serve() -> anyhow::Result<()> {
    if !parent_is_june() {
        anyhow::bail!("the helper must be launched directly by June");
    }
    let registry = Arc::new(platform_macos::register_tools());
    registry.init_self_weak();
    let allowed: HashSet<&'static str> = ALLOWED_TOOLS.iter().copied().collect();
    let mut authenticated = false;
    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin);
    let mut stdout = tokio::io::BufWriter::new(tokio::io::stdout());

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
    let parent_pid = unsafe { libc::getppid() };
    let Some(parent_path) = process_path(parent_pid) else {
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
            &parent_path,
            &outer_app.join("Contents").join("MacOS").join("June"),
        ) && packaged_signatures_match(outer_app, helper_app);
    }

    // Development builds are not nested yet. The only accepted parent is the
    // os-june executable produced inside this checkout's Cargo target tree.
    cfg!(debug_assertions)
        && parent_path.starts_with(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target"))
        && parent_path
            .file_name()
            .is_some_and(|name| name == "os-june")
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
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    left == right
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
    let tools: Vec<Value> = registry
        .iter_defs()
        .filter(|(name, _)| allowed.contains(name))
        .map(|(_, definition)| definition.to_list_entry())
        .collect();
    json!({ "tools": tools })
}

#[cfg(target_os = "macos")]
fn arguments_are_narrow(tool: &str, arguments: &Value) -> bool {
    let Some(arguments) = arguments.as_object() else {
        return false;
    };
    let allowed: &[&str] = match tool {
        "check_permissions" => &["prompt"],
        "list_windows" => &["pid", "on_screen_only"],
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
    arguments.keys().all(|key| allowed.contains(&key.as_str()))
}

#[cfg(target_os = "macos")]
async fn write_response(
    stdout: &mut tokio::io::BufWriter<tokio::io::Stdout>,
    response: Response,
) -> anyhow::Result<()> {
    let mut bytes = serde_json::to_vec(&response)?;
    bytes.push(b'\n');
    stdout.write_all(&bytes).await?;
    stdout.flush().await?;
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

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
    fn narrow_contract_excludes_upstream_process_and_update_tools() {
        for denied in [
            "launch_app",
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
