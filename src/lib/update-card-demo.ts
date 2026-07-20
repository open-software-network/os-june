// Dev-only console driver for the sidebar update cards — both the "Relaunch to
// update" card and the update status card.
//
//   window.__updateCard("ready")          fresh update available (v0.0.25)
//   window.__updateCard("ready", "1.2.3") pick the version label shown
//   window.__updateCard("relaunching")    the mid-relaunch "Relaunching..." state
//   window.__updateCard("failed")         the destructive "Update failed" status
//   window.__updateCard("checking")       status card, busy "Checking for updates..."
//   window.__updateCard("uptodate")       status card, "June is up to date." (auto-hides)
//   window.__updateCard("downloading")    status card, busy + ticking progress bar
//   window.__updateCard("checkfailed")    status card, destructive failed check
//   window.__updateCard("clear")          dismiss the card
//
// The cards are React state in the main window (App's readyUpdate / updateStatus
// / relaunchingUpdate / preparingUpdate / checkingUpdate / updateProgress), so
// the driver pushes synthetic values straight into those setters rather than
// waiting on a real updater round-trip. In dev there is no live update to
// clobber it. Never bundled in production: App gates the dynamic import on
// import.meta.env.DEV.

import {
  UP_TO_DATE_STATUS,
  type UpdateInstallProgress,
  type UpdatePromptPayload,
} from "../app/update-decision";
import type { JuneUpdate } from "./updater";

export type UpdateCardDemoApi = {
  /** Remove the window hook. */
  dispose: () => void;
};

const DEFAULT_VERSION = "0.0.25";

// A synthetic in-flight download: starts around 40% so the progress bar and the
// percent readout both render, then ticks upward a few percent at a time so the
// digit pop-in animation is visible in the browser demo.
const DOWNLOAD_CONTENT_LENGTH = 100_000_000;
const DOWNLOAD_START_BYTES = 40_000_000;
const DOWNLOAD_TICK_BYTES = 3_000_000;
const DOWNLOAD_CAP_BYTES = 96_000_000;
const DOWNLOAD_TICK_MS = 800;

const HELP = [
  "Sidebar update card demo:",
  '  __updateCard("ready")          update available, ready to relaunch',
  '  __updateCard("ready", "1.2.3") same, with a chosen version label',
  '  __updateCard("relaunching")    the "Relaunching..." in-flight state',
  '  __updateCard("failed")         the destructive failed-update status',
  '  __updateCard("checking")       status card, busy "Checking for updates..."',
  '  __updateCard("uptodate")       status card, "June is up to date." (auto-hides after a few seconds)',
  '  __updateCard("downloading")    status card, busy + ticking progress bar',
  '  __updateCard("checkfailed")    status card, destructive failed check',
  '  __updateCard("clear")          dismiss the card',
  "",
  "Parks the card on any view, no real update needed. Dev only.",
].join("\n");

export function registerUpdateCardDemo({
  setReadyUpdate,
  setStatus,
  setRelaunching,
  setPreparing,
  setChecking,
  setProgress,
}: {
  setReadyUpdate: (payload: UpdatePromptPayload<JuneUpdate> | null) => void;
  setStatus: (status: string | null, failed?: boolean) => void;
  setRelaunching: (value: boolean) => void;
  setPreparing: (value: boolean) => void;
  setChecking: (value: boolean) => void;
  setProgress: (progress: UpdateInstallProgress | null) => void;
}): UpdateCardDemoApi {
  // The card only reads payload.version; a bare stub stands in for the real
  // tauri Update instance so the demo needs no live updater handle.
  function makePayload(version: string): UpdatePromptPayload<JuneUpdate> {
    return { update: {} as JuneUpdate, version };
  }

  let downloadTimer: number | undefined;

  function stopDownloadTicker() {
    if (downloadTimer === undefined) return;
    window.clearInterval(downloadTimer);
    downloadTimer = undefined;
  }

  // Reset every update-card flag before parking a fresh state so switching
  // between states never leaves a stale spinner, timer, or progress bar behind.
  function reset() {
    stopDownloadTicker();
    setRelaunching(false);
    setPreparing(false);
    setChecking(false);
    setProgress(null);
    setStatus(null);
    setReadyUpdate(null);
  }

  function ready(version = DEFAULT_VERSION) {
    reset();
    setReadyUpdate(makePayload(version));
  }

  function relaunching(version = DEFAULT_VERSION) {
    reset();
    setReadyUpdate(makePayload(version));
    setRelaunching(true);
  }

  function failed(version = DEFAULT_VERSION) {
    reset();
    setReadyUpdate(makePayload(version));
    setStatus("Update failed. Try again.", true);
  }

  function checking() {
    reset();
    setChecking(true);
    setStatus("Checking for updates...");
  }

  // Sets the real success status string, so App's auto-dismiss effect gives the
  // parked card the true linger-then-soft-exit behavior.
  function upToDate() {
    reset();
    setStatus(UP_TO_DATE_STATUS);
  }

  function downloading() {
    reset();
    setPreparing(true);
    setStatus("Downloading update...");
    let downloadedBytes = DOWNLOAD_START_BYTES;
    const report = () =>
      setProgress({
        state: "downloading",
        downloadedBytes,
        contentLength: DOWNLOAD_CONTENT_LENGTH,
      });
    report();
    downloadTimer = window.setInterval(() => {
      downloadedBytes = Math.min(DOWNLOAD_CAP_BYTES, downloadedBytes + DOWNLOAD_TICK_BYTES);
      report();
      if (downloadedBytes >= DOWNLOAD_CAP_BYTES) stopDownloadTicker();
    }, DOWNLOAD_TICK_MS);
  }

  function checkFailed() {
    reset();
    setStatus("Update check failed: network unreachable.", true);
  }

  const hook = (state?: string, version?: string) => {
    switch (state) {
      case "ready":
        ready(version || undefined);
        return 'Update card parked. __updateCard("clear") to dismiss.';
      case "relaunching":
        relaunching(version || undefined);
        return 'Relaunching state parked. __updateCard("ready") to reset.';
      case "failed":
        failed(version || undefined);
        return 'Failed status parked. __updateCard("ready") to reset.';
      case "checking":
        checking();
        return 'Checking state parked. __updateCard("clear") to dismiss.';
      case "uptodate":
        upToDate();
        return 'Up-to-date status parked. __updateCard("clear") to dismiss.';
      case "downloading":
        downloading();
        return 'Downloading state parked. __updateCard("clear") to dismiss.';
      case "checkfailed":
        checkFailed();
        return 'Check-failed status parked. __updateCard("clear") to dismiss.';
      case "clear":
      case "stop":
        reset();
        return "Update card dismissed.";
      default:
        return HELP;
    }
  };

  (window as unknown as Record<string, unknown>).__updateCard = hook;

  function dispose() {
    stopDownloadTicker();
    delete (window as unknown as Record<string, unknown>).__updateCard;
  }

  return { dispose };
}
