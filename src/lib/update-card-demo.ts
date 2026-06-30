// Dev-only console driver for the sidebar "Relaunch to update" card.
//
//   window.__updateCard("ready")          fresh update available (v0.0.25)
//   window.__updateCard("ready", "1.2.3") pick the version label shown
//   window.__updateCard("relaunching")    the mid-relaunch "Relaunching..." state
//   window.__updateCard("failed")         the destructive "Update failed" status
//   window.__updateCard("clear")          dismiss the card
//
// The card is React state in the main window (App's readyUpdate / updateStatus /
// relaunchingUpdate), so the driver pushes synthetic values straight into those
// setters rather than waiting on a real updater round-trip. In dev there is no
// live update to clobber it. Never bundled in production: App gates the dynamic
// import on import.meta.env.DEV.

import type { UpdatePromptPayload } from "../app/update-decision";
import type { JuneUpdate } from "./updater";

export type UpdateCardDemoApi = {
  /** Remove the window hook. */
  dispose: () => void;
};

const DEFAULT_VERSION = "0.0.25";

const HELP = [
  'Sidebar "Relaunch to update" card demo:',
  '  __updateCard("ready")          update available, ready to relaunch',
  '  __updateCard("ready", "1.2.3") same, with a chosen version label',
  '  __updateCard("relaunching")    the "Relaunching..." in-flight state',
  '  __updateCard("failed")         the destructive failed-update status',
  '  __updateCard("clear")          dismiss the card',
  "",
  "Parks the card on any view, no real update needed. Dev only.",
].join("\n");

export function registerUpdateCardDemo({
  setReadyUpdate,
  setStatus,
  setRelaunching,
}: {
  setReadyUpdate: (payload: UpdatePromptPayload<JuneUpdate> | null) => void;
  setStatus: (status: string | null) => void;
  setRelaunching: (value: boolean) => void;
}): UpdateCardDemoApi {
  // The card only reads payload.version; a bare stub stands in for the real
  // tauri Update instance so the demo needs no live updater handle.
  function makePayload(version: string): UpdatePromptPayload<JuneUpdate> {
    return { update: {} as JuneUpdate, version };
  }

  function ready(version = DEFAULT_VERSION) {
    setRelaunching(false);
    setStatus(null);
    setReadyUpdate(makePayload(version));
  }

  function relaunching(version = DEFAULT_VERSION) {
    setStatus(null);
    setReadyUpdate(makePayload(version));
    setRelaunching(true);
  }

  function failed(version = DEFAULT_VERSION) {
    setRelaunching(false);
    setReadyUpdate(makePayload(version));
    setStatus("Update failed. Try again.");
  }

  function clear() {
    setRelaunching(false);
    setStatus(null);
    setReadyUpdate(null);
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
      case "clear":
      case "stop":
        clear();
        return "Update card dismissed.";
      default:
        return HELP;
    }
  };

  (window as unknown as Record<string, unknown>).__updateCard = hook;

  function dispose() {
    delete (window as unknown as Record<string, unknown>).__updateCard;
  }

  return { dispose };
}
