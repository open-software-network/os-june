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
