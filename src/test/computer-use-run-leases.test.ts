import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  computerUseBeginRun: vi.fn(),
  computerUseEndRun: vi.fn(),
  computerUseStop: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  computerUseBeginRun: tauriMocks.computerUseBeginRun,
  computerUseEndRun: tauriMocks.computerUseEndRun,
  computerUseStop: tauriMocks.computerUseStop,
}));

import {
  beginComputerUseRunLease,
  forgetComputerUseRunLeases,
  releaseComputerUseRunLease,
  releaseComputerUseRunsForSession,
  stopComputerUseRuns,
} from "../lib/computer-use-run-leases";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("computer-use run leases", () => {
  beforeEach(() => {
    forgetComputerUseRunLeases();
    tauriMocks.computerUseBeginRun.mockReset().mockResolvedValue(undefined);
    tauriMocks.computerUseEndRun.mockReset().mockResolvedValue(undefined);
    tauriMocks.computerUseStop.mockReset().mockResolvedValue({ stopped: true });
  });

  afterEach(() => {
    forgetComputerUseRunLeases();
  });

  it("awaits one in-flight release before reporting the session revoked", async () => {
    await beginComputerUseRunLease("session-1", "session-1:lease-1");
    const endRun = deferred<void>();
    tauriMocks.computerUseEndRun.mockReturnValueOnce(endRun.promise);

    const firstRelease = releaseComputerUseRunLease("session-1", "session-1:lease-1");
    const secondRelease = releaseComputerUseRunLease("session-1", "session-1:lease-1");
    let revokeSettled = false;
    const revoke = releaseComputerUseRunsForSession("session-1").then(() => {
      revokeSettled = true;
    });

    await Promise.resolve();
    expect(tauriMocks.computerUseEndRun).toHaveBeenCalledTimes(1);
    expect(revokeSettled).toBe(false);

    endRun.resolve(undefined);
    await expect(Promise.all([firstRelease, secondRelease, revoke])).resolves.toBeDefined();
    expect(revokeSettled).toBe(true);
  });

  it("runs native Stop after an in-flight native begin and then clears the registry", async () => {
    const nativeBegin = deferred<void>();
    tauriMocks.computerUseBeginRun.mockReturnValueOnce(nativeBegin.promise);

    const begin = beginComputerUseRunLease("session-1", "session-1:lease-1");
    const stop = stopComputerUseRuns();
    await Promise.resolve();
    const stopCallsWhileBeginPending = tauriMocks.computerUseStop.mock.calls.length;

    nativeBegin.resolve(undefined);
    await Promise.all([begin, stop]);
    await releaseComputerUseRunsForSession("session-1");

    expect(stopCallsWhileBeginPending).toBe(0);
    expect(tauriMocks.computerUseStop).toHaveBeenCalledOnce();
    expect(tauriMocks.computerUseEndRun).not.toHaveBeenCalled();
  });

  it("waits for a same-key release before beginning and tracking a fresh lease", async () => {
    const leaseId = "session-1:lease-1";
    await beginComputerUseRunLease("session-1", leaseId);
    const nativeEnd = deferred<void>();
    tauriMocks.computerUseEndRun.mockReturnValueOnce(nativeEnd.promise);

    const release = releaseComputerUseRunLease("session-1", leaseId);
    const rebegin = beginComputerUseRunLease("session-1", leaseId);
    await Promise.resolve();
    const beginCallsWhileEndPending = tauriMocks.computerUseBeginRun.mock.calls.length;
    const endCallsWhileEndPending = tauriMocks.computerUseEndRun.mock.calls.length;

    nativeEnd.resolve(undefined);
    await Promise.all([release, rebegin]);
    await releaseComputerUseRunsForSession("session-1");

    expect(beginCallsWhileEndPending).toBe(1);
    expect(endCallsWhileEndPending).toBe(1);
    expect(tauriMocks.computerUseBeginRun).toHaveBeenCalledTimes(2);
    expect(tauriMocks.computerUseEndRun).toHaveBeenCalledTimes(2);
    expect(tauriMocks.computerUseEndRun).toHaveBeenLastCalledWith(leaseId);
  });

  it("treats a same-key begin as idempotent while its lease is active", async () => {
    await beginComputerUseRunLease("session-1", "session-1:lease-1");
    await beginComputerUseRunLease("session-1", "session-1:lease-1");

    expect(tauriMocks.computerUseBeginRun).toHaveBeenCalledOnce();
    await releaseComputerUseRunsForSession("session-1");
    expect(tauriMocks.computerUseEndRun).toHaveBeenCalledOnce();
  });

  it("retains a failed lease so a later fail-closed revocation retries it", async () => {
    await beginComputerUseRunLease("session-1", "session-1:lease-1");
    tauriMocks.computerUseEndRun
      .mockRejectedValueOnce(new Error("native unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(releaseComputerUseRunsForSession("session-1")).rejects.toThrow(
      "native unavailable",
    );
    await expect(releaseComputerUseRunsForSession("session-1")).resolves.toBeUndefined();
    expect(tauriMocks.computerUseEndRun).toHaveBeenCalledTimes(2);
  });

  it("releases only the leases belonging to the requested stored session", async () => {
    await beginComputerUseRunLease("session-1", "session-1:lease-1");
    await beginComputerUseRunLease("session-2", "session-2:lease-1");

    await releaseComputerUseRunsForSession("session-1");
    expect(tauriMocks.computerUseEndRun).toHaveBeenCalledOnce();
    expect(tauriMocks.computerUseEndRun).toHaveBeenLastCalledWith("session-1:lease-1");

    await releaseComputerUseRunsForSession("session-2");
    expect(tauriMocks.computerUseEndRun).toHaveBeenCalledTimes(2);
    expect(tauriMocks.computerUseEndRun).toHaveBeenLastCalledWith("session-2:lease-1");
  });

  it("does not record a lease when the native begin fails", async () => {
    tauriMocks.computerUseBeginRun.mockRejectedValueOnce(new Error("begin failed"));

    await expect(beginComputerUseRunLease("session-1", "session-1:lease-1")).rejects.toThrow(
      "begin failed",
    );
    await expect(releaseComputerUseRunsForSession("session-1")).resolves.toBeUndefined();
    expect(tauriMocks.computerUseEndRun).not.toHaveBeenCalled();

    await expect(stopComputerUseRuns()).resolves.toBeUndefined();
    expect(tauriMocks.computerUseStop).toHaveBeenCalledOnce();
  });

  it("awaits native Stop and clears tracked leases after it succeeds", async () => {
    await beginComputerUseRunLease("session-1", "session-1:lease-1");
    const nativeStop = deferred<{ stopped: boolean }>();
    tauriMocks.computerUseStop.mockReturnValueOnce(nativeStop.promise);
    let stopSettled = false;

    const stop = stopComputerUseRuns().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    nativeStop.resolve({ stopped: true });
    await stop;
    await releaseComputerUseRunsForSession("session-1");
    expect(stopSettled).toBe(true);
    expect(tauriMocks.computerUseEndRun).not.toHaveBeenCalled();
  });

  it("starts native Stop synchronously when no lifecycle operation is active", async () => {
    const stop = stopComputerUseRuns();

    expect(tauriMocks.computerUseStop).toHaveBeenCalledOnce();
    await stop;
  });

  it("continues lifecycle operations after a native begin failure", async () => {
    tauriMocks.computerUseBeginRun.mockRejectedValueOnce(new Error("begin failed"));

    await expect(beginComputerUseRunLease("session-1", "session-1:failed")).rejects.toThrow(
      "begin failed",
    );
    await beginComputerUseRunLease("session-1", "session-1:lease-1");
    await stopComputerUseRuns();

    expect(tauriMocks.computerUseBeginRun).toHaveBeenCalledTimes(2);
    expect(tauriMocks.computerUseStop).toHaveBeenCalledOnce();
  });

  it("retains tracked leases when native Stop fails", async () => {
    await beginComputerUseRunLease("session-1", "session-1:lease-1");
    tauriMocks.computerUseStop.mockRejectedValueOnce(new Error("stop failed"));

    await expect(stopComputerUseRuns()).rejects.toThrow("stop failed");
    await releaseComputerUseRunsForSession("session-1");
    expect(tauriMocks.computerUseEndRun).toHaveBeenCalledWith("session-1:lease-1");
  });

  it("forgets only the JavaScript registry", async () => {
    await beginComputerUseRunLease("session-1", "session-1:lease-1");

    forgetComputerUseRunLeases();
    await releaseComputerUseRunsForSession("session-1");

    expect(tauriMocks.computerUseEndRun).not.toHaveBeenCalled();
    expect(tauriMocks.computerUseStop).not.toHaveBeenCalled();
  });
});
