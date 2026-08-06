//! Chrome native messaging shim for the Clovy extension (JUN-287). Chrome
//! spawns this binary per `chrome.runtime.connectNative` port; all behavior
//! lives in `clovy_lib::extension_host::shim` so integration tests can
//! drive the same code.

fn main() {
    std::process::exit(clovy_lib::extension_host::shim::run());
}
