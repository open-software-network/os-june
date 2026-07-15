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
import { NATIVE_HOST_NAME, parseBrowserRequest, PROTOCOL_VERSION } from "./protocol";
import { BrowserController, withRequestId } from "./browser";

let port: chrome.runtime.Port | null = null;
let state: PairingState = initialPairingState;
const browser = new BrowserController((tabId) => {
  if (state.status !== "paired" || !port) return;
  port.postMessage({ v: PROTOCOL_VERSION, type: "tab_share_revoked", tabId });
});

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
  port.onMessage.addListener((message) => {
    const request = parseBrowserRequest(message);
    if (request) {
      if (state.status !== "paired" || !port) return;
      const requestPort = port;
      void browser.execute(request).then((result) => {
        if (port !== requestPort || state.status !== "paired") return;
        const outgoing = withRequestId(request.id, result);
        for (const chunk of outgoing.chunks ?? []) requestPort.postMessage(chunk);
        requestPort.postMessage(outgoing.response);
      });
      return;
    }
    apply({ kind: "message", message });
  });
  port.onDisconnect.addListener(() => {
    port = null;
    apply({ kind: "disconnect" });
    void browser.disconnect();
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
    return;
  }
  if (message?.type === "getTabShareState") {
    const tabId = message.tabId;
    sendResponse(
      typeof tabId === "number"
        ? {
            success: true,
            state: browser.shareState(tabId),
            shareId: browser.pendingShareId(tabId),
          }
        : { success: false, message: "No active browser tab was found." },
    );
    return;
  }
  if (message?.type === "shareTab") {
    const tabId = message.tabId;
    if (state.status !== "paired") {
      sendResponse({ success: false, message: "Connect the June app before sharing a tab." });
      return;
    }
    try {
      if (typeof tabId !== "number") throw new Error("No active browser tab was found.");
      const shareId = browser.offerTab(tabId);
      sendResponse({ success: true, shareId });
    } catch (error) {
      sendResponse({
        success: false,
        message: error instanceof Error ? error.message : "The tab could not be shared.",
      });
    }
    return;
  }
  if (message?.type === "revokeTabShare") {
    const tabId = message.tabId;
    if (typeof tabId !== "number") {
      sendResponse({ success: false, message: "No active browser tab was found." });
      return;
    }
    void browser.revokeSharedTab(tabId).then((revoked) => {
      sendResponse({ success: revoked, state: browser.shareState(tabId) });
    });
    return true;
  }
});

connect();
