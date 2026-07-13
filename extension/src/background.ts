// MV3 background service worker: owns the native messaging port to the June
// shim and the pairing state. An active native messaging port keeps the
// worker alive; when Chrome still suspends it (nothing connected), the next
// startup/install event reconnects.

import {
  initialPairingState,
  reducePairing,
  type PairingEvent,
  type PairingState,
} from "./pairing";
import { NATIVE_HOST_NAME } from "./protocol";

let port: chrome.runtime.Port | null = null;
let state: PairingState = initialPairingState;

function extensionVersion(): string {
  return chrome.runtime.getManifest().version;
}

function apply(event: PairingEvent) {
  const transition = reducePairing(state, event, extensionVersion());
  state = transition.state;
  if (transition.send && port) {
    port.postMessage(transition.send);
  }
  void updateBadge();
}

async function updateBadge() {
  const paired = state.status === "paired";
  await chrome.action.setBadgeText({ text: paired ? "on" : "" });
  if (paired) {
    await chrome.action.setBadgeBackgroundColor({ color: "#4c8050" });
  }
}

function connect() {
  if (port) return;
  state = { status: "connecting" };
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch {
    // No host manifest registered yet (June has not set up the extension).
    port = null;
    state = { status: "unreachable" };
    void updateBadge();
    return;
  }
  port.onMessage.addListener((message) => apply({ kind: "message", message }));
  port.onDisconnect.addListener(() => {
    port = null;
    apply({ kind: "disconnect" });
  });
  apply({ kind: "connect" });
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);

// The popup asks for the current state, and can ask for a reconnect attempt.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "getPairingState") {
    sendResponse(state);
    return;
  }
  if (message?.type === "reconnect") {
    connect();
    sendResponse(state);
  }
});

connect();
