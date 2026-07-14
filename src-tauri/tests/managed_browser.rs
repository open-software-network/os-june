//! End-to-end harness for the managed browser (JUN-289): launches the real
//! detected Chromium-family browser headless and drives the full path -
//! navigate, snapshot, screenshot, policy refusals before navigation and after
//! a redirect, and profile teardown on close, kill, and drop.
//!
//! Every test is `#[ignore]`d because it spawns a real browser: the default
//! test run stays hermetic and a developer (or the acceptance run) opts in
//! explicitly:
//!
//! ```sh
//! cargo test --test managed_browser -- --ignored --test-threads=1
//! ```
//!
//! Fixture pages are served from loopback, which production policy blocks, so
//! the harness uses the test-only `PolicyConfig { allow_loopback: true }` with
//! a fixed resolver mapping fixture hostnames to the local servers. Private
//! (10.0.0.0/8) destinations stay blocked under that config, which is what the
//! refusal tests rely on.

use std::net::SocketAddr;
use std::sync::Arc;

use os_june_lib::browser::managed::{start_managed_session, ManagedSessionConfig};
use os_june_lib::browser::policy::{PolicyConfig, Resolver};
use os_june_lib::browser::BoxFuture;

/// Serialize real-browser tests even when the test runner uses its default
/// parallelism. Production caps managed sessions at two, and overlapping
/// browser startup/teardown made this security suite intermittently exhaust
/// that budget before the port isolated its test sessions.
static LIVE_BROWSER_SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Maps fixture hostnames to fixed addresses; everything else resolves empty
/// (a policy violation), so the harness never touches real DNS.
struct FixtureResolver {
    fixture_addr: SocketAddr,
}

impl Resolver for FixtureResolver {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        _port: u16,
    ) -> BoxFuture<'a, std::io::Result<Vec<SocketAddr>>> {
        let addr = match host {
            "fixture.test" => vec![self.fixture_addr],
            "blocked.internal" => vec!["10.0.0.1:80".parse().expect("fixed addr")],
            _ => Vec::new(),
        };
        Box::pin(async move { Ok(addr) })
    }
}

/// A minimal HTTP fixture server: `/` serves a page with a heading, a link,
/// and body text; `/redirect` 302s to the blocked internal host.
async fn spawn_fixture_server() -> SocketAddr {
    spawn_fixture_server_with_webrtc_probe(None).await
}

async fn spawn_fixture_server_with_webrtc_probe(webrtc_probe: Option<SocketAddr>) -> SocketAddr {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fixture server");
    let addr = listener.local_addr().expect("fixture addr");
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let Ok(n) = sock.read(&mut buf).await else {
                    return;
                };
                let head = String::from_utf8_lossy(&buf[..n]);
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let response = if path.starts_with("/redirect") {
                    "HTTP/1.1 302 Found\r\nLocation: http://blocked.internal/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
                } else if path.starts_with("/secrets") {
                    // A page whose sensitive fields are already filled: the
                    // browser masks the password, and the snapshot must not
                    // undo that.
                    let body = "<!doctype html><html><body><form>\
<input type=\"password\" name=\"password\" value=\"hunter2-should-never-leak\">\
<input type=\"text\" autocomplete=\"one-time-code\" name=\"otp\" value=\"483726-should-never-leak\">\
<input type=\"text\" name=\"cardNumber\" value=\"4111111111111111\">\
<label for=\"x\">One-time code</label>\
<input id=\"x\" value=\"label-only-otp-secret\">\
<input type=\"text\" name=\"city\" value=\"Warsaw\">\
<div contenteditable=\"true\">hunter2-contenteditable-never-leak</div>\
<div role=\"textbox\">4837-role-textbox-never-leak</div>\
<label id=\"custom-code-label\">One-time code</label>\
<div role=\"combobox\" aria-labelledby=\"custom-code-label\">custom-widget-code-never-leak</div>\
</form></body></html>";
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                } else if path.starts_with("/webrtc") {
                    let probe = webrtc_probe.expect("WebRTC fixture needs a UDP probe");
                    let body = format!(
                        "<!doctype html><html><body><script>\
const peer = new RTCPeerConnection({{iceServers: [{{urls: 'stun:{probe}'}}]}});\
peer.createDataChannel('probe');\
peer.createOffer().then(offer => peer.setLocalDescription(offer));\
</script></body></html>"
                    );
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                } else {
                    let body = "<!doctype html><html><head><title>Fixture page</title></head><body><h1>Managed browser fixture</h1><a href=\"/other\">A fixture link</a><p>The quick brown fox jumps over the lazy dog.</p></body></html>";
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                };
                let _ = sock.write_all(response.as_bytes()).await;
            });
        }
    });
    addr
}

async fn start_fixture_session(
    artifacts: &std::path::Path,
) -> Arc<os_june_lib::browser::managed::ManagedBrowserSession> {
    let fixture_addr = spawn_fixture_server().await;
    let config = ManagedSessionConfig {
        artifacts_root: artifacts.to_path_buf(),
        policy: PolicyConfig {
            allow_loopback: true,
        },
        resolver: Arc::new(FixtureResolver { fixture_addr }),
    };
    start_managed_session(config)
        .await
        .expect("start managed session (is a Chromium-family browser installed?)")
}

async fn start_webrtc_fixture_session(
    artifacts: &std::path::Path,
    udp_probe: SocketAddr,
) -> Arc<os_june_lib::browser::managed::ManagedBrowserSession> {
    let fixture_addr = spawn_fixture_server_with_webrtc_probe(Some(udp_probe)).await;
    let config = ManagedSessionConfig {
        artifacts_root: artifacts.to_path_buf(),
        policy: PolicyConfig {
            allow_loopback: true,
        },
        resolver: Arc::new(FixtureResolver { fixture_addr }),
    };
    start_managed_session(config)
        .await
        .expect("start managed session (is a Chromium-family browser installed?)")
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "launches the real detected browser; run with -- --ignored"]
async fn navigate_snapshot_screenshot_and_teardown_end_to_end() {
    let _serial = LIVE_BROWSER_SERIAL.lock().await;
    let artifacts = tempfile::tempdir().expect("artifacts dir");
    let session = start_fixture_session(artifacts.path()).await;
    let profile = session.profile_path();
    assert!(profile.exists(), "profile dir exists while session is live");

    // Navigate to the fixture page and read it back.
    let navigated = session
        .navigate("http://fixture.test/")
        .await
        .expect("navigate");
    let url = navigated["url"].as_str().expect("url");
    assert!(url.starts_with("http://fixture.test"), "url: {url}");
    assert_eq!(navigated["title"].as_str(), Some("Fixture page"));

    let snapshot = session.snapshot().await.expect("snapshot");
    assert!(snapshot.contains("Managed browser fixture"));
    assert!(snapshot.contains("quick brown fox"));
    assert!(snapshot.contains("[ref1]"), "interactive refs missing");

    let screenshot = session.screenshot().await.expect("screenshot");
    assert!(
        screenshot.bytes.starts_with(b"\x89PNG"),
        "screenshot must be a png"
    );
    assert!(screenshot.width > 0 && screenshot.height > 0);

    // Graceful close deletes the profile.
    session.close().await;
    assert!(!profile.exists(), "profile must be gone after close");
}

/// The snapshot is a read path over the live page, so it can resurface a value
/// the browser itself masks. No form-control value is trustworthy enough to
/// serialize to the model or to an artifact, including a value whose only
/// sensitive signal is its associated label.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "launches the real detected browser; run with -- --ignored"]
async fn snapshot_never_leaks_sensitive_field_values() {
    let _serial = LIVE_BROWSER_SERIAL.lock().await;
    let artifacts = tempfile::tempdir().expect("artifacts dir");
    let session = start_fixture_session(artifacts.path()).await;

    session
        .navigate("http://fixture.test/secrets")
        .await
        .expect("navigate");
    let text = session.snapshot().await.expect("snapshot");

    for secret in [
        "hunter2-should-never-leak",
        "483726-should-never-leak",
        "4111111111111111",
        "label-only-otp-secret",
        "Warsaw",
        "hunter2-contenteditable-never-leak",
        "4837-role-textbox-never-leak",
        "custom-widget-code-never-leak",
    ] {
        assert!(
            !text.contains(secret),
            "snapshot leaked a form-control value"
        );
    }
    // The fields are still described, so the agent can reason about the form.
    assert!(text.contains("value hidden"));
    assert!(text.contains("One-time code"));

    session.close().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "launches the real detected browser; run with -- --ignored"]
async fn blocked_destinations_refuse_before_navigation_and_after_a_redirect() {
    let _serial = LIVE_BROWSER_SERIAL.lock().await;
    let artifacts = tempfile::tempdir().expect("artifacts dir");
    let session = start_fixture_session(artifacts.path()).await;

    // Before navigation: a destination resolving to a private address is
    // refused without the browser being asked to do anything.
    let refused = session
        .navigate("http://blocked.internal/")
        .await
        .expect_err("private destination must refuse before navigation");
    assert_eq!(refused.code, "browser_policy_blocked");
    assert!(
        !refused.message.contains("blocked.internal"),
        "policy errors must not name the destination: {}",
        refused.message
    );

    // After a redirect: an allowed page 302s to the blocked host; the proxy
    // refuses the hop at connection time and the navigation fails as policy.
    let redirected = session
        .navigate("http://fixture.test/redirect")
        .await
        .expect_err("redirect to a private destination must refuse");
    assert_eq!(redirected.code, "browser_policy_blocked");

    session.close().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "launches the real detected browser; run with -- --ignored"]
async fn managed_page_cannot_send_webrtc_udp_to_a_private_listener() {
    let _serial = LIVE_BROWSER_SERIAL.lock().await;
    let udp = tokio::net::UdpSocket::bind("127.0.0.1:0")
        .await
        .expect("bind private UDP probe");
    let udp_addr = udp.local_addr().expect("UDP probe address");
    let artifacts = tempfile::tempdir().expect("artifacts dir");
    let session = start_webrtc_fixture_session(artifacts.path(), udp_addr).await;

    session
        .navigate("http://fixture.test/webrtc")
        .await
        .expect("navigate to WebRTC fixture");

    let mut packet = [0u8; 2048];
    let received = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        udp.recv_from(&mut packet),
    )
    .await;
    assert!(
        received.is_err(),
        "managed Chromium sent non-proxied WebRTC UDP to a private listener"
    );

    session.close().await;
}

/// The one test that leaves the machine: production policy (SystemResolver,
/// loopback blocked) against a real public page. Needs network; ignored like
/// the rest and additionally tolerant of an offline environment only by
/// failing, so a green run is real evidence.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "launches the real detected browser and reaches the public web; run with -- --ignored"]
async fn public_page_end_to_end_with_production_policy() {
    let _serial = LIVE_BROWSER_SERIAL.lock().await;
    let artifacts = tempfile::tempdir().expect("artifacts dir");
    let session = start_managed_session(ManagedSessionConfig::production(
        artifacts.path().to_path_buf(),
    ))
    .await
    .expect("start managed session");

    let navigated = session
        .navigate("https://example.com/")
        .await
        .expect("navigate to a public page");
    let url = navigated["url"].as_str().expect("url");
    assert!(url.starts_with("https://example.com"), "url: {url}");

    let snapshot = session.snapshot().await.expect("snapshot");
    assert!(snapshot.to_lowercase().contains("example"));

    // Production policy still blocks loopback and private destinations.
    let refused = session
        .navigate("http://127.0.0.1/")
        .await
        .expect_err("loopback must be refused under production policy");
    assert_eq!(refused.code, "browser_policy_blocked");

    session.close().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "launches the real detected browser; run with -- --ignored"]
async fn profile_is_deleted_after_a_browser_kill_and_after_drop() {
    let _serial = LIVE_BROWSER_SERIAL.lock().await;
    let artifacts = tempfile::tempdir().expect("artifacts dir");

    // Kill path: SIGKILL the browser out from under the session; the crash
    // watcher notices the pipe close and deletes the profile.
    let session = start_fixture_session(artifacts.path()).await;
    let profile = session.profile_path();
    let pid = session.browser_pid().expect("browser pid");
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while profile.exists() && std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(!profile.exists(), "profile must be gone after a kill");
    drop(session);

    // Drop path: releasing the last reference tears everything down.
    let session = start_fixture_session(artifacts.path()).await;
    let profile = session.profile_path();
    drop(session);
    assert!(!profile.exists(), "profile must be gone after drop");
}
