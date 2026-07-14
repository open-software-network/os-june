//! Chrome DevTools Protocol client over `--remote-debugging-pipe` (JUN-289).
//!
//! Framing: each message is one JSON object terminated by a single NUL byte
//! (`\0`), in both directions. Two dedicated std threads move bytes so the async
//! broker never blocks on the pipe: a writer drains outgoing values, a reader
//! splits incoming frames into call responses (matched by `id`) and events.
//!
//! Privacy (JUN-316): nothing here logs, prints, or traces CDP payloads, URLs,
//! or page content. Parse failures are dropped silently; errors name a stable
//! code and generic copy, never request params or page data. The one exception
//! the contract allows is a CDP error's own `message`, returned verbatim to the
//! caller so it can be surfaced, and even that is never written to a log.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{broadcast, oneshot, watch};

/// How long [`CdpClient::call`] waits for a response before giving up.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Broadcast capacity for the event channel.
const EVENT_CHANNEL_CAPACITY: usize = 256;

/// A typed CDP failure. `code` is a stable machine-readable class; `message` is
/// caller-facing copy. Never carries request params or page content.
#[derive(Debug, Clone)]
pub struct CdpError {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for CdpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for CdpError {}

impl CdpError {
    /// The client's pipe to the browser has ended (EOF or read/write error).
    fn browser_ended() -> CdpError {
        CdpError {
            code: "browser_closed",
            message: "The managed browser process ended.".to_string(),
        }
    }

    fn timed_out() -> CdpError {
        CdpError {
            code: "timeout",
            message: "The browser did not respond in time.".to_string(),
        }
    }
}

/// A CDP event: a frame with no `id`. `params` is the raw event payload; callers
/// that inspect it are responsible for the privacy rule.
#[derive(Debug, Clone)]
pub struct CdpEvent {
    pub method: String,
    pub session_id: Option<String>,
    pub params: Value,
}

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, CdpError>>>>>;

/// A running CDP client. Cheap to clone the handles it hands out; the client
/// itself lives in an `Arc` inside a broker session and is `Send + Sync`.
pub struct CdpClient {
    next_id: AtomicU64,
    pending: PendingMap,
    /// Wrapped in a `Mutex` so the client is `Sync` (std mpsc `Sender` is not).
    outgoing: Mutex<std::sync::mpsc::Sender<Value>>,
    event_tx: broadcast::Sender<CdpEvent>,
    closed_rx: watch::Receiver<bool>,
}

impl CdpClient {
    /// Starts the writer and reader threads over the two pipe ends. `read` is the
    /// browser-to-client pipe; `write` is the client-to-browser pipe.
    pub fn start(read: std::fs::File, write: std::fs::File) -> CdpClient {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (event_tx, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let (closed_tx, closed_rx) = watch::channel(false);
        let (out_tx, out_rx) = std::sync::mpsc::channel::<Value>();

        // Writer: drain outgoing values, frame each as `json + \0`, flush.
        std::thread::spawn(move || writer_loop(write, out_rx));

        // Reader: split incoming frames, resolve calls, publish events.
        {
            let pending = pending.clone();
            let event_tx = event_tx.clone();
            std::thread::spawn(move || reader_loop(read, pending, event_tx, closed_tx));
        }

        CdpClient {
            next_id: AtomicU64::new(1),
            pending,
            outgoing: Mutex::new(out_tx),
            event_tx,
            closed_rx,
        }
    }

    /// Sends a command and awaits its response (30 s timeout). A CDP
    /// `{"error": {...}}` becomes `Err`; a `{"result": ...}` becomes `Ok`.
    pub async fn call(
        &self,
        session_id: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, CdpError> {
        if *self.closed_rx.borrow() {
            return Err(CdpError::browser_ended());
        }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);

        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session_id) = session_id {
            message["sessionId"] = Value::String(session_id.to_string());
        }

        if self.outgoing.lock().unwrap().send(message).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(CdpError::browser_ended());
        }

        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(Ok(response))) => interpret_response(response),
            // The reader failed the pending call (browser ended).
            Ok(Ok(Err(err))) => Err(err),
            // The oneshot sender was dropped without a value.
            Ok(Err(_)) => Err(CdpError::browser_ended()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(CdpError::timed_out())
            }
        }
    }

    /// A fresh subscription to the event stream. Only events published after the
    /// subscription are delivered.
    pub fn events(&self) -> broadcast::Receiver<CdpEvent> {
        self.event_tx.subscribe()
    }

    /// Resolves `true` once the browser pipe has closed. Cloneable receiver so
    /// several tasks can watch teardown.
    pub fn closed(&self) -> watch::Receiver<bool> {
        self.closed_rx.clone()
    }

    /// Subscribe-then-filter helper: waits for the next event matching `method`
    /// (and `session_id`, when given). The subscription is taken before this
    /// awaits, so pairing it with the triggering command is race-free only if
    /// the caller subscribes via this helper BEFORE issuing that command;
    /// otherwise a small race remains and the caller accepts it.
    pub async fn wait_for_event(
        &self,
        session_id: Option<&str>,
        method: &str,
        timeout: Duration,
    ) -> Result<Value, CdpError> {
        let mut rx = self.event_tx.subscribe();
        let filter = async {
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        let session_matches =
                            session_id.is_none() || event.session_id.as_deref() == session_id;
                        if event.method == method && session_matches {
                            return Ok(event.params);
                        }
                    }
                    // A slow consumer missed events; keep waiting for the target.
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => {
                        return Err(CdpError::browser_ended());
                    }
                }
            }
        };
        match tokio::time::timeout(timeout, filter).await {
            Ok(result) => result,
            Err(_) => Err(CdpError::timed_out()),
        }
    }
}

/// Splits a CDP response into `Ok(result)` or `Err(cdp error message)`.
fn interpret_response(response: Value) -> Result<Value, CdpError> {
    if let Some(error) = response.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("The browser reported a protocol error.")
            .to_string();
        return Err(CdpError {
            code: "cdp_error",
            message,
        });
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

fn writer_loop(mut write: std::fs::File, out_rx: std::sync::mpsc::Receiver<Value>) {
    while let Ok(value) = out_rx.recv() {
        // A frame that will not serialize is dropped rather than logged.
        let Ok(mut bytes) = serde_json::to_vec(&value) else {
            continue;
        };
        bytes.push(0);
        if write.write_all(&bytes).is_err() {
            break;
        }
        if write.flush().is_err() {
            break;
        }
    }
}

fn reader_loop(
    mut read: std::fs::File,
    pending: PendingMap,
    event_tx: broadcast::Sender<CdpEvent>,
    closed_tx: watch::Sender<bool>,
) {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match read.read(&mut chunk) {
            Ok(0) => break, // EOF: the browser closed the pipe.
            Ok(n) => {
                buffer.extend_from_slice(&chunk[..n]);
                while let Some(pos) = buffer.iter().position(|&b| b == 0) {
                    let frame: Vec<u8> = buffer.drain(..=pos).collect();
                    let frame = &frame[..frame.len() - 1]; // strip the NUL
                    if frame.is_empty() {
                        continue;
                    }
                    // Parse failures are dropped silently (never log payloads).
                    if let Ok(value) = serde_json::from_slice::<Value>(frame) {
                        dispatch_frame(value, &pending, &event_tx);
                    }
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }

    // Mark closed and fail every in-flight call so no caller waits forever.
    let _ = closed_tx.send(true);
    let mut pending = pending.lock().unwrap();
    for (_id, tx) in pending.drain() {
        let _ = tx.send(Err(CdpError::browser_ended()));
    }
}

fn dispatch_frame(value: Value, pending: &PendingMap, event_tx: &broadcast::Sender<CdpEvent>) {
    if let Some(id) = value.get("id").and_then(Value::as_u64) {
        if let Some(tx) = pending.lock().unwrap().remove(&id) {
            let _ = tx.send(Ok(value));
        }
        return;
    }
    if let Some(method) = value.get("method").and_then(Value::as_str) {
        let event = CdpEvent {
            method: method.to_string(),
            session_id: value
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
            params: value.get("params").cloned().unwrap_or(Value::Null),
        };
        // No subscribers is fine; the event is simply dropped.
        let _ = event_tx.send(event);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::unix::io::FromRawFd;

    /// A raw pipe wrapped as (read end, write end).
    fn make_pipe() -> (File, File) {
        let mut fds = [0 as libc::c_int; 2];
        // SAFETY: fds is a valid two-element array for libc::pipe to fill.
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        // SAFETY: the fds were just created and are owned solely by these Files.
        let read = unsafe { File::from_raw_fd(fds[0]) };
        let write = unsafe { File::from_raw_fd(fds[1]) };
        (read, write)
    }

    /// Wires a client to a fake browser peer. Returns the client plus the peer's
    /// (read command frames, write reply/event frames) ends.
    fn client_with_peer() -> (CdpClient, File, File) {
        let (client_read, peer_write) = make_pipe(); // browser -> client
        let (peer_read, client_write) = make_pipe(); // client -> browser
        let client = CdpClient::start(client_read, client_write);
        (client, peer_read, peer_write)
    }

    fn read_frame(file: &mut File) -> Option<Value> {
        let mut bytes = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            match file.read(&mut byte) {
                Ok(0) => return None,
                Ok(_) => {
                    if byte[0] == 0 {
                        break;
                    }
                    bytes.push(byte[0]);
                }
                Err(_) => return None,
            }
        }
        serde_json::from_slice(&bytes).ok()
    }

    fn write_frame(file: &mut File, value: &Value) {
        let mut bytes = serde_json::to_vec(value).unwrap();
        bytes.push(0);
        file.write_all(&bytes).unwrap();
        file.flush().unwrap();
    }

    #[tokio::test]
    async fn call_resolves_with_result() {
        let (client, mut peer_read, mut peer_write) = client_with_peer();
        let peer = std::thread::spawn(move || {
            let frame = read_frame(&mut peer_read).unwrap();
            assert_eq!(frame["method"], "Target.getTargets");
            let id = frame["id"].as_u64().unwrap();
            write_frame(
                &mut peer_write,
                &json!({ "id": id, "result": { "ok": true } }),
            );
            // Keep the write end open until the call resolves.
            peer_write
        });

        let result = client
            .call(None, "Target.getTargets", json!({}))
            .await
            .unwrap();
        assert_eq!(result["ok"], true);
        drop(peer.join().unwrap());
    }

    #[tokio::test]
    async fn call_error_frame_becomes_err() {
        let (client, mut peer_read, mut peer_write) = client_with_peer();
        let peer = std::thread::spawn(move || {
            let frame = read_frame(&mut peer_read).unwrap();
            let id = frame["id"].as_u64().unwrap();
            write_frame(
                &mut peer_write,
                &json!({ "id": id, "error": { "code": -32000, "message": "Something failed" } }),
            );
            peer_write
        });

        let err = client
            .call(None, "Page.navigate", json!({}))
            .await
            .unwrap_err();
        assert_eq!(err.code, "cdp_error");
        assert_eq!(err.message, "Something failed");
        drop(peer.join().unwrap());
    }

    #[tokio::test]
    async fn events_reach_subscribers() {
        let (client, peer_read, mut peer_write) = client_with_peer();
        // Subscribe before the peer emits so the event is not missed.
        let mut events = client.events();
        let peer = std::thread::spawn(move || {
            write_frame(
                &mut peer_write,
                &json!({
                    "method": "Page.frameNavigated",
                    "sessionId": "S1",
                    "params": { "frameId": "f1" }
                }),
            );
            (peer_read, peer_write)
        });

        let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.method, "Page.frameNavigated");
        assert_eq!(event.session_id.as_deref(), Some("S1"));
        drop(peer.join().unwrap());
    }

    #[tokio::test]
    async fn frames_split_across_reads_parse() {
        let (client, mut peer_read, mut peer_write) = client_with_peer();
        let peer = std::thread::spawn(move || {
            let frame = read_frame(&mut peer_read).unwrap();
            let id = frame["id"].as_u64().unwrap();
            let mut bytes =
                serde_json::to_vec(&json!({ "id": id, "result": { "ok": true } })).unwrap();
            bytes.push(0);
            let mid = bytes.len() / 2;
            // Deliver the frame in two chunks straddling a flush.
            peer_write.write_all(&bytes[..mid]).unwrap();
            peer_write.flush().unwrap();
            std::thread::sleep(Duration::from_millis(50));
            peer_write.write_all(&bytes[mid..]).unwrap();
            peer_write.flush().unwrap();
            (peer_read, peer_write)
        });

        let result = client
            .call(None, "Target.getTargets", json!({}))
            .await
            .unwrap();
        assert_eq!(result["ok"], true);
        drop(peer.join().unwrap());
    }

    #[tokio::test]
    async fn peer_close_fails_pending_and_flips_closed() {
        let (client, peer_read, peer_write) = client_with_peer();
        let mut closed = client.closed();
        let peer = std::thread::spawn(move || {
            let mut peer_read = peer_read;
            // Read the command, then drop both ends without replying.
            let _ = read_frame(&mut peer_read);
            drop(peer_read);
            drop(peer_write);
        });

        let err = client
            .call(None, "Page.navigate", json!({}))
            .await
            .unwrap_err();
        assert_eq!(err.code, "browser_closed");

        closed.changed().await.unwrap();
        assert!(*closed.borrow());
        peer.join().unwrap();
    }
}
