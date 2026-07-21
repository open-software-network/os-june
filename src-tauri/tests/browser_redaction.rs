use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn native_messaging_shim_failure_writes_no_browser_content_to_stderr() {
    let home = tempfile::tempdir().expect("temporary home");
    let data_dir = home
        .path()
        .join("Library")
        .join("Application Support")
        .join("co.opensoftware.june");
    std::fs::create_dir_all(&data_dir).expect("shim data directory");
    let browser_content =
        r#"{"url":"https://private.example/secret","page":"page-text","field":"field-value-123""#;
    std::fs::write(data_dir.join("extension-host.json"), browser_content)
        .expect("malformed descriptor");

    let output = Command::new(env!("CARGO_BIN_EXE_june-nm-shim"))
        .env("HOME", home.path())
        .env("OS_JUNE_USE_PROD_DATA_DIR", "1")
        .stdin(Stdio::null())
        .output()
        .expect("run native messaging shim");

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stderr.is_empty(), "shim stderr must remain empty");
    let frame = os_june_lib::extension_host::read_frame(&mut output.stdout.as_slice())
        .expect("read shim error frame")
        .expect("shim error frame");
    assert_eq!(frame["code"], "app_unreachable");
    let rendered = frame.to_string();
    assert!(!rendered.contains("private.example"));
    assert!(!rendered.contains("page-text"));
    assert!(!rendered.contains("field-value-123"));
}

#[test]
fn python_mcp_failure_omits_proxy_and_argument_content() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("hermes")
        .join("june_browser_mcp.py");
    let program = r#"
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("june_browser_mcp", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result = {
    "success": False,
    "errorCode": "browser_navigation_failed",
    "message": "Page text at https://private.example/secret: field-value-123",
}
try:
    module.require_success(result)
except module.ToolError as error:
    print(module.browser_failure_text(
        "navigate",
        {"arguments": {
            "session_id": "02e9eb56-a4d2-4a26-b53d-5b975483d924",
            "tab_id": 42,
            "url": "https://private.example/secret",
            "text": "field-value-123",
        }},
        error.code,
    ))
"#;

    let output = Command::new("python3")
        .arg("-c")
        .arg(program)
        .arg(script)
        .output()
        .expect("run browser MCP redaction check");

    assert!(
        output.status.success(),
        "python stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "browser MCP stderr must remain empty"
    );
    let rendered = String::from_utf8(output.stdout).expect("browser MCP output");
    assert!(rendered.contains("navigate"));
    assert!(rendered.contains("02e9eb56-a4d2-4a26-b53d-5b975483d924"));
    assert!(rendered.contains("tab 42"));
    assert!(!rendered.contains("private.example"));
    assert!(!rendered.contains("Page text"));
    assert!(!rendered.contains("field-value-123"));
}

#[test]
fn python_mcp_selects_the_credential_bound_to_its_configured_call_context() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("hermes")
        .join("june_browser_mcp.py");
    let program = r#"
import importlib.util
import os
import sys

spec = importlib.util.spec_from_file_location("june_browser_mcp", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

os.environ[module.ATTENDED_TOKEN_ENV_VAR] = "attended-token"
os.environ[module.ROUTINE_TOKEN_ENV_VAR] = "routine-token"

os.environ[module.CALL_CONTEXT_ENV_VAR] = "attended"
assert module.browser_call_context() == "attended"
assert module.browser_proxy_token() == "attended-token"

os.environ[module.CALL_CONTEXT_ENV_VAR] = "routine"
assert module.browser_call_context() == "routine"
assert module.browser_proxy_token() == "routine-token"

os.environ[module.CALL_CONTEXT_ENV_VAR] = "unexpected"
assert module.browser_call_context() == "unknown"
assert module.browser_proxy_token() == ""
"#;

    let output = Command::new("python3")
        .arg("-c")
        .arg(program)
        .arg(script)
        .output()
        .expect("run browser MCP context check");

    assert!(
        output.status.success(),
        "python stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn python_mcp_parse_failure_writes_only_generic_stderr() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("hermes")
        .join("june_browser_mcp.py");
    let mut child = Command::new("python3")
        .arg(script)
        .arg("https://private.example/secret")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start browser MCP");
    child
        .stdin
        .take()
        .expect("browser MCP stdin")
        .write_all(b"Content-Length: field-value-123\r\n\r\npage-text")
        .expect("write malformed browser MCP request");

    let output = child.wait_with_output().expect("wait for browser MCP");

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let rendered = String::from_utf8(output.stderr).expect("browser MCP stderr");
    assert!(rendered.contains("June browser MCP failed."));
    assert!(!rendered.contains("private.example"));
    assert!(!rendered.contains("page-text"));
    assert!(!rendered.contains("field-value-123"));
}
