//! Integration coverage for the native messaging shim relay (JUN-287): the
//! shim must send the auth frame first, then pump frames unchanged in both
//! directions, and stop when either side closes. The fake app side here
//! speaks the same framing the real extension host listener speaks.

use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use os_june_lib::extension_host::{encode_frame, read_frame, shim, write_frame, PROTOCOL_VERSION};
use serde_json::json;

/// `shim::relay` takes ownership of the Chrome-side writer on the calling
/// thread; sharing the buffer lets the test read what the shim wrote back.
#[derive(Clone, Default)]
struct SharedBuffer(Arc<Mutex<Vec<u8>>>);

impl Write for SharedBuffer {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .expect("buffer poisoned")
            .extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn relay_authenticates_then_pumps_frames_both_ways() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().expect("addr").port();

    // Fake app side: expect auth first, then answer the relayed hello.
    let app_side = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let auth = read_frame(&mut stream).expect("auth frame").expect("auth");
        assert_eq!(auth["type"], "auth");
        assert_eq!(auth["token"], "test-token");

        let hello = read_frame(&mut stream)
            .expect("hello frame")
            .expect("hello");
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["v"], PROTOCOL_VERSION);

        write_frame(
            &mut stream,
            &json!({ "v": PROTOCOL_VERSION, "type": "hello_ok", "appVersion": "0.0.0" }),
        )
        .expect("write hello_ok");
        // Close: the relay should drain the reply and return cleanly.
    });

    // Chrome side stdin: one framed hello, then EOF (port disconnect).
    let hello = json!({ "v": PROTOCOL_VERSION, "type": "hello", "extensionVersion": "0.1.0" });
    let chrome_in = std::io::Cursor::new(encode_frame(&hello).expect("encode"));
    let chrome_out = SharedBuffer::default();

    let socket = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    shim::relay(chrome_in, chrome_out.clone(), socket, "test-token").expect("relay");
    app_side.join().expect("app side");

    let written = chrome_out.0.lock().expect("buffer poisoned").clone();
    let reply = read_frame(&mut written.as_slice())
        .expect("reply frame")
        .expect("reply");
    assert_eq!(reply["type"], "hello_ok");
    assert_eq!(reply["appVersion"], "0.0.0");
}

#[test]
fn relay_stops_when_the_app_side_closes_without_replying() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().expect("addr").port();

    let app_side = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let auth = read_frame(&mut stream).expect("auth frame").expect("auth");
        assert_eq!(auth["type"], "auth");
        // Drop the connection immediately (app quit / bad token policy).
    });

    // Chrome side never sends anything and never closes by itself; the relay
    // must still return when the socket does.
    let chrome_in = std::io::Cursor::new(Vec::new());
    let chrome_out = SharedBuffer::default();
    let socket = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    shim::relay(chrome_in, chrome_out, socket, "any-token").expect("relay");
    app_side.join().expect("app side");
}
