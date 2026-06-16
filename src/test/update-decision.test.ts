import { describe, expect, it, vi } from "vitest";
import {
  UPDATE_CHECK_INTERVAL_MS,
  checkForScribeUpdate,
  installScribeUpdate,
  prepareScribeUpdate,
  startPeriodicScribeUpdateChecks,
  type UpdaterUpdate,
} from "../app/update-decision";

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

describe("checkForScribeUpdate", () => {
  it("prompts with version and release notes when an update is available", async () => {
    const prompt = vi.fn();

    await checkForScribeUpdate(
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

    await checkForScribeUpdate(
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

    await checkForScribeUpdate(
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

    await checkForScribeUpdate(
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

    await checkForScribeUpdate(
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

describe("startPeriodicScribeUpdateChecks", () => {
  it("runs periodic checks until stopped", () => {
    vi.useFakeTimers();
    const runUpdateCheck = vi.fn();

    try {
      const stop = startPeriodicScribeUpdateChecks(runUpdateCheck);

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

describe("installScribeUpdate", () => {
  it("reports download progress, installs, and relaunches", async () => {
    const candidate = update("notes");
    const relaunch = vi.fn(async () => undefined);
    const reportProgress = vi.fn();

    await installScribeUpdate({
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

describe("prepareScribeUpdate", () => {
  it("reports download progress and marks the update ready without relaunching", async () => {
    const candidate = update(" Ready after relaunch. ");
    const reportProgress = vi.fn();
    const reportReady = vi.fn();

    await prepareScribeUpdate({
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
