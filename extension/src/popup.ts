// Popup: renders the pairing state the background worker holds. Copy follows
// the repo rules: sentence case, no em dashes, no all caps.

import type { PairingState } from "./pairing";

const copy: Record<PairingState["status"], { title: string; detail: string; retry: boolean }> = {
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
  incompatible: {
    title: "Update required",
    detail:
      "This extension and the June app speak different versions. Update the June extension, then try again.",
    retry: true,
  },
  unreachable: {
    title: "June is not running",
    detail: "Open the June app, then try again.",
    retry: true,
  },
};

function render(state: PairingState) {
  const dot = document.getElementById("dot");
  const title = document.getElementById("title");
  const detail = document.getElementById("detail");
  const retry = document.getElementById("retry") as HTMLButtonElement | null;
  if (!dot || !title || !detail || !retry) return;
  const entry = copy[state.status];
  dot.dataset.status = state.status;
  title.textContent = entry.title;
  detail.textContent = entry.detail;
  retry.hidden = !entry.retry;
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

void refresh();
