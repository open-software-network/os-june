import { describe, expect, it, vi } from "vitest";
import {
  INITIAL_UPDATE_STATUS_DISPLAY,
  UP_TO_DATE_STATUS,
  UPDATE_CHECK_INTERVAL_MS,
  checkForJuneUpdate,
  installJuneUpdate,
  prepareJuneUpdate,
  startPeriodicJuneUpdateChecks,
  updateCheckShowsStatus,
  updateStatusDisplayReducer,
  type UpdaterUpdate,
} from "../app/update-decision";

describe("update status display", () => {
  it("only exposes manual checks as visible busy statuses", () => {
    expect(updateCheckShowsStatus("manual")).toBe(true);
    expect(updateCheckShowsStatus("launch")).toBe(false);
    expect(updateCheckShowsStatus("periodic")).toBe(false);
  });

  it("does not let stale success timers fade or clear a newer status", () => {
    const success = updateStatusDisplayReducer(INITIAL_UPDATE_STATUS_DISPLAY, {
      type: "show",
      status: UP_TO_DATE_STATUS,
    });
    const leaving = updateStatusDisplayReducer(success, { type: "beginUpToDateExit" });
    expect(leaving.leaving).toBe(true);

    const checking = updateStatusDisplayReducer(leaving, {
      type: "show",
      status: "Checking for updates...",
    });
    expect(checking).toEqual({
      status: "Checking for updates...",
      leaving: false,
      failed: false,
    });
    expect(updateStatusDisplayReducer(checking, { type: "clearUpToDate" })).toBe(checking);
  });

  it("carries failure styling independently of message wording", () => {
    const failure = updateStatusDisplayReducer(INITIAL_UPDATE_STATUS_DISPLAY, {
      type: "show",
      status: "Could not check for updates.",
      failed: true,
    });

    expect(failure.failed).toBe(true);
  });
});

function update(body?: string): UpdaterUpdate {
  return {
    version: "0.2.0",
    body,
    downloadAndInstall: vi.fn(async (onEvent) => {
      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 40 } });
      onEvent?.({ event: "Finished" });
    }),
  };
}

describe("checkForJuneUpdate", () => {
  it("prompts with version and release notes when an update is available", async () => {
    const prompt = vi.fn();

    await checkForJuneUpdate(
      {
        check: async () => update(" Fixes transcription. "),
        prompt,
        reportNoUpdate: vi.fn(),
        reportFailure: vi.fn(),
      },
      "launch",
    );

    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        version: "0.2.0",
        notes: "Fixes transcription.",
      }),
    );
  });

  it("does not prompt when no update is available", async () => {
    const prompt = vi.fn();
    const reportNoUpdate = vi.fn();

    await checkForJuneUpdate(
      {
        check: async () => null,
        prompt,
        reportNoUpdate,
        reportFailure: vi.fn(),
      },
      "launch",
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(reportNoUpdate).not.toHaveBeenCalled();
  });

  it("keeps periodic no-update checks silent", async () => {
    const prompt = vi.fn();
    const reportNoUpdate = vi.fn();

    await checkForJuneUpdate(
      {
        check: async () => null,
        prompt,
        reportNoUpdate,
        reportFailure: vi.fn(),
      },
      "periodic",
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(reportNoUpdate).not.toHaveBeenCalled();
  });

  it("reports no update for a manual check", async () => {
    const reportNoUpdate = vi.fn();

    await checkForJuneUpdate(
      {
        check: async () => null,
        prompt: vi.fn(),
        reportNoUpdate,
        reportFailure: vi.fn(),
      },
      "manual",
    );

    expect(reportNoUpdate).toHaveBeenCalledTimes(1);
  });

  it("reports failures without claiming success", async () => {
    const prompt = vi.fn();
    const reportFailure = vi.fn();

    await checkForJuneUpdate(
      {
        check: async () => {
          throw new Error("signature mismatch");
        },
        prompt,
        reportNoUpdate: vi.fn(),
        reportFailure,
      },
      "manual",
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith("signature mismatch");
  });
});

describe("startPeriodicJuneUpdateChecks", () => {
  it("runs periodic checks until stopped", () => {
    vi.useFakeTimers();
    const runUpdateCheck = vi.fn();

    try {
      const stop = startPeriodicJuneUpdateChecks(runUpdateCheck);

      vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS - 1);
      expect(runUpdateCheck).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(runUpdateCheck).toHaveBeenCalledWith("periodic");
      expect(runUpdateCheck).toHaveBeenCalledTimes(1);

      stop();
      vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
      expect(runUpdateCheck).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("installJuneUpdate", () => {
  it("reports download progress, installs, and relaunches", async () => {
    const candidate = update("notes");
    const relaunch = vi.fn(async () => undefined);
    const reportProgress = vi.fn();

    await installJuneUpdate({
      update: candidate,
      relaunch,
      reportProgress,
      reportFailure: vi.fn(),
    });

    expect(candidate.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(reportProgress).toHaveBeenCalledWith({
      state: "downloading",
      downloadedBytes: 40,
      contentLength: 100,
    });
    expect(reportProgress).toHaveBeenCalledWith({
      state: "installing",
      downloadedBytes: 40,
      contentLength: 100,
    });
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});

describe("prepareJuneUpdate", () => {
  it("reports download progress and marks the update ready without relaunching", async () => {
    const candidate = update(" Ready after relaunch. ");
    const reportProgress = vi.fn();
    const reportReady = vi.fn();

    await prepareJuneUpdate({
      update: candidate,
      reportProgress,
      reportReady,
      reportFailure: vi.fn(),
    });

    expect(candidate.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(reportProgress).toHaveBeenCalledWith({
      state: "downloading",
      downloadedBytes: 40,
      contentLength: 100,
    });
    expect(reportProgress).toHaveBeenCalledWith({
      state: "installing",
      downloadedBytes: 40,
      contentLength: 100,
    });
    expect(reportReady).toHaveBeenCalledWith({
      update: candidate,
      version: "0.2.0",
      notes: "Ready after relaunch.",
    });
  });
});
