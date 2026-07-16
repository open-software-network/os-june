// DownloadEvent is owned by the IPC boundary (lib/updater.ts); re-exported here
// so existing importers keep working without app/ reaching back up into lib/.
import type { DownloadEvent } from "../lib/updater";
export type { DownloadEvent };

export type UpdatePromptPayload<TUpdate> = {
  update: TUpdate;
  version: string;
  notes?: string;
};

export type UpdateCheckMode = "launch" | "manual" | "periodic";

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

// The manual-check success status. Shared so the reporter and the auto-dismiss
// effect that matches on it (App), plus the dev demo, can't drift apart.
export const UP_TO_DATE_STATUS = "June is up to date.";

export type UpdateStatusDisplayState = {
  status: string | null;
  leaving: boolean;
};

export type UpdateStatusDisplayAction =
  | { type: "show"; status: string | null }
  | { type: "beginUpToDateExit" }
  | { type: "clearUpToDate" };

export const INITIAL_UPDATE_STATUS_DISPLAY: UpdateStatusDisplayState = {
  status: null,
  leaving: false,
};

// Status changes reset the exit phase synchronously. Timed exit actions are
// guarded by the current value, so a stale success timer cannot fade or clear
// a newer check/failure status if its effect cleanup is delayed.
export function updateStatusDisplayReducer(
  state: UpdateStatusDisplayState,
  action: UpdateStatusDisplayAction,
): UpdateStatusDisplayState {
  if (action.type === "show") {
    if (state.status === action.status && !state.leaving) return state;
    return { status: action.status, leaving: false };
  }
  if (state.status !== UP_TO_DATE_STATUS) return state;
  if (action.type === "beginUpToDateExit") {
    return { ...state, leaving: true };
  }
  return INITIAL_UPDATE_STATUS_DISPLAY;
}

// Launch and periodic checks are silent unless they discover an update. Only
// manual checks render the transient checking status and its spinner.
export function updateCheckShowsStatus(mode: UpdateCheckMode): boolean {
  return mode === "manual";
}

export type UpdaterUpdate = {
  version: string;
  body?: string;
  downloadAndInstall: (onEvent?: (event: DownloadEvent) => void) => Promise<void>;
};

export type UpdateCheckDeps<TUpdate extends UpdaterUpdate> = {
  check: () => Promise<TUpdate | null>;
  prompt: (payload: UpdatePromptPayload<TUpdate>) => void;
  reportNoUpdate: () => void;
  reportFailure: (message: string) => void;
};

export type InstallUpdateDeps<TUpdate extends UpdaterUpdate> = {
  update: TUpdate;
  relaunch: () => Promise<void>;
  reportProgress: (progress: UpdateInstallProgress) => void;
  reportFailure: (message: string) => void;
};

export type PrepareUpdateDeps<TUpdate extends UpdaterUpdate> = {
  update: TUpdate;
  reportProgress: (progress: UpdateInstallProgress) => void;
  reportReady: (payload: UpdatePromptPayload<TUpdate>) => void;
  reportFailure: (message: string) => void;
};

export type UpdateInstallProgress = {
  state: "downloading" | "installing";
  downloadedBytes?: number;
  contentLength?: number;
};

export async function checkForJuneUpdate<TUpdate extends UpdaterUpdate>(
  deps: UpdateCheckDeps<TUpdate>,
  mode: UpdateCheckMode,
) {
  try {
    const update = await deps.check();
    if (!update) {
      if (mode === "manual") deps.reportNoUpdate();
      return;
    }
    deps.prompt({
      update,
      version: update.version,
      notes: normalizeNotes(update.body),
    });
  } catch (error) {
    deps.reportFailure(messageFromUnknown(error));
  }
}

export function startPeriodicJuneUpdateChecks(
  runUpdateCheck: (mode: UpdateCheckMode) => void,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
) {
  const timer = window.setInterval(() => runUpdateCheck("periodic"), intervalMs);
  return () => window.clearInterval(timer);
}

export async function prepareJuneUpdate<TUpdate extends UpdaterUpdate>({
  update,
  reportProgress,
  reportReady,
  reportFailure,
}: PrepareUpdateDeps<TUpdate>) {
  try {
    await downloadAndInstallJuneUpdate(update, reportProgress);
    reportReady({
      update,
      version: update.version,
      notes: normalizeNotes(update.body),
    });
  } catch (error) {
    reportFailure(messageFromUnknown(error));
  }
}

export async function installJuneUpdate<TUpdate extends UpdaterUpdate>({
  update,
  relaunch,
  reportProgress,
  reportFailure,
}: InstallUpdateDeps<TUpdate>) {
  try {
    await downloadAndInstallJuneUpdate(update, reportProgress);
    await relaunch();
  } catch (error) {
    reportFailure(messageFromUnknown(error));
  }
}

async function downloadAndInstallJuneUpdate<TUpdate extends UpdaterUpdate>(
  update: TUpdate,
  reportProgress: (progress: UpdateInstallProgress) => void,
) {
  let downloadedBytes = 0;
  let contentLength: number | undefined;
  // A multi-MB DMG fires thousands of Progress events; surfacing each as a state
  // update would re-render the app on every network chunk. Throttle downloading
  // ticks to whole-percent changes (or ~1MB steps when the total size is
  // unknown). State transitions — Started and installing — always fire.
  let lastPercent: number | undefined;
  let lastReportedBytes = 0;
  const UNKNOWN_LENGTH_STEP = 1_000_000;

  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      downloadedBytes = 0;
      contentLength = event.data.contentLength;
      lastPercent = contentLength ? 0 : undefined;
      lastReportedBytes = 0;
      reportProgress({
        state: "downloading",
        downloadedBytes,
        contentLength,
      });
      return;
    }
    if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
      if (contentLength && contentLength > 0) {
        const percent = Math.round((downloadedBytes / contentLength) * 100);
        if (percent === lastPercent) return;
        lastPercent = percent;
      } else if (downloadedBytes - lastReportedBytes < UNKNOWN_LENGTH_STEP) {
        return;
      } else {
        lastReportedBytes = downloadedBytes;
      }
      reportProgress({
        state: "downloading",
        downloadedBytes,
        contentLength,
      });
      return;
    }
    reportProgress({ state: "installing", downloadedBytes, contentLength });
  });
}

function normalizeNotes(notes?: string) {
  const trimmed = notes?.trim();
  return trimmed ? trimmed : undefined;
}

function messageFromUnknown(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Update failed.";
}
