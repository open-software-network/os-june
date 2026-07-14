// Popup: renders the pairing state the background worker holds. Copy follows
// the repo rules: sentence case, no em dashes, no all caps.

import type { PairingState } from "./pairing";

type PopupCopy = { title: string; detail: string; retry: boolean };
type ShareState = "available" | "pending" | "shared" | "unavailable";
type ShareResponse = {
  success: boolean;
  state?: ShareState;
  shareId?: string;
  message?: string;
};

let pairingState: PairingState | undefined;
let activeShareId: string | undefined;

const copy: Record<Exclude<PairingState["status"], "incompatible">, PopupCopy> = {
  disconnected: {
    title: "Not connected",
    detail: "June is not connected to this browser yet.",
    retry: true,
  },
  connecting: {
    title: "Connecting",
    detail: "Reaching the June app...",
    retry: false,
  },
  handshaking: {
    title: "Connecting",
    detail: "Confirming versions with the June app...",
    retry: false,
  },
  paired: {
    title: "Connected to June",
    detail: "June can open its own tabs in this browser when you ask it to.",
    retry: false,
  },
  unreachable: {
    title: "June is not running",
    detail: "Open the June app, then try again.",
    retry: true,
  },
};

function incompatibleCopy(state: Extract<PairingState, { status: "incompatible" }>): PopupCopy {
  const detail =
    state.remedy === "updateJune"
      ? "This extension is newer than the June app. Update June, then try again."
      : state.remedy === "updateExtension"
        ? "The June app is newer than this extension. Update the June extension, then try again."
        : "This extension and the June app speak different versions. Update both, then try again.";
  return { title: "Update required", detail, retry: true };
}

function render(state: PairingState) {
  const dot = document.getElementById("dot");
  const title = document.getElementById("title");
  const detail = document.getElementById("detail");
  const retry = document.getElementById("retry") as HTMLButtonElement | null;
  if (!dot || !title || !detail || !retry) return;
  const entry = state.status === "incompatible" ? incompatibleCopy(state) : copy[state.status];
  dot.dataset.status = state.status;
  title.textContent = entry.title;
  detail.textContent = entry.detail;
  retry.hidden = !entry.retry;
  pairingState = state;
  void refreshShare();
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function renderShare(state: ShareState, detail?: string) {
  const section = document.getElementById("tab-share");
  const shareDetail = document.getElementById("share-detail");
  const share = document.getElementById("share") as HTMLButtonElement | null;
  const revoke = document.getElementById("revoke-share") as HTMLButtonElement | null;
  if (!section || !shareDetail || !share || !revoke) return;
  section.hidden = pairingState?.status !== "paired";
  if (section.hidden) return;

  shareDetail.textContent =
    detail ??
    (state === "shared"
      ? "This tab is shared with the current June task."
      : state === "unavailable"
        ? "This tab already belongs to the current June task."
        : state === "pending"
          ? `Share code: ${activeShareId ?? "Preparing..."}. Paste it into your June chat.`
          : "Only the tab you choose becomes available to the current June task.");
  share.hidden = state === "shared" || state === "unavailable";
  share.textContent = state === "pending" ? "Copy share code" : "Share this tab";
  revoke.hidden = state === "available" || state === "unavailable";
  revoke.textContent = state === "pending" ? "Cancel share" : "Stop sharing";
}

async function refreshShare() {
  if (pairingState?.status !== "paired") {
    renderShare("available");
    return;
  }
  const tabId = await activeTabId();
  if (tabId === undefined) {
    renderShare("available", "Open a browser tab before sharing.");
    return;
  }
  const response = (await chrome.runtime.sendMessage({
    type: "getTabShareState",
    tabId,
  })) as ShareResponse | undefined;
  if (!response?.success || !response.state) {
    renderShare("available", response?.message ?? "This tab cannot be shared.");
    return;
  }
  activeShareId = response.shareId;
  renderShare(response.state);
}

async function copyShareCode(shareId: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(shareId);
    return true;
  } catch {
    return false;
  }
}

async function refresh(reconnect = false) {
  const state = (await chrome.runtime.sendMessage({
    type: reconnect ? "reconnect" : "getPairingState",
  })) as PairingState | undefined;
  if (state) render(state);
}

document.getElementById("retry")?.addEventListener("click", () => {
  void refresh(true);
  // The handshake settles in the background; poll briefly so the popup
  // reflects the outcome without a manual reopen.
  setTimeout(() => void refresh(), 500);
  setTimeout(() => void refresh(), 1500);
});

document.getElementById("share")?.addEventListener("click", async () => {
  const tabId = await activeTabId();
  if (tabId === undefined) {
    renderShare("available", "Open a browser tab before sharing.");
    return;
  }
  let shareId = activeShareId;
  if (!shareId) {
    const response = (await chrome.runtime.sendMessage({ type: "shareTab", tabId })) as
      | ShareResponse
      | undefined;
    if (!response?.success || !response.shareId) {
      renderShare("available", response?.message ?? "This tab could not be shared.");
      return;
    }
    shareId = response.shareId;
    activeShareId = shareId;
  }
  const copied = await copyShareCode(shareId);
  renderShare(
    "pending",
    copied
      ? "Share code copied. Paste it into your June chat."
      : `Share code: ${shareId}. Paste it into your June chat.`,
  );
});

document.getElementById("revoke-share")?.addEventListener("click", async () => {
  const tabId = await activeTabId();
  if (tabId === undefined) return;
  await chrome.runtime.sendMessage({ type: "revokeTabShare", tabId });
  activeShareId = undefined;
  await refreshShare();
});

void refresh();
