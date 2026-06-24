import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRoutine,
  listRoutines,
  triggerRoutine,
} from "../lib/hermes-routines";

const mocks = vi.hoisted(() => ({
  hermesBridgeStatus: vi.fn(),
  startHermesBridge: vi.fn(),
  ensureHermesBridgeGateway: vi.fn(),
  hermesBridgeCronJobs: vi.fn(),
  createHermesBridgeCronJob: vi.fn(),
  hermesBridgeCronJobAction: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  hermesBridgeStatus: mocks.hermesBridgeStatus,
  startHermesBridge: mocks.startHermesBridge,
  ensureHermesBridgeGateway: mocks.ensureHermesBridgeGateway,
  hermesBridgeCronJobs: mocks.hermesBridgeCronJobs,
  createHermesBridgeCronJob: mocks.createHermesBridgeCronJob,
  hermesBridgeCronJobAction: mocks.hermesBridgeCronJobAction,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hermesBridgeStatus.mockResolvedValue({ running: true });
  mocks.startHermesBridge.mockResolvedValue({ running: true });
  mocks.ensureHermesBridgeGateway.mockResolvedValue(undefined);
  mocks.hermesBridgeCronJobs.mockResolvedValue([]);
  mocks.createHermesBridgeCronJob.mockResolvedValue({
    id: "routine-1",
    name: "Morning brief",
    prompt: "Summarize today.",
    schedule_display: "0 9 * * *",
    enabled: true,
  });
  mocks.hermesBridgeCronJobAction.mockResolvedValue({});
});

describe("Routines Hermes integration", () => {
  it("ensures the persistent gateway before listing routine jobs", async () => {
    await listRoutines();

    expect(mocks.ensureHermesBridgeGateway).toHaveBeenCalledTimes(1);
    expect(mocks.hermesBridgeCronJobs).toHaveBeenCalledTimes(1);
    expect(
      mocks.ensureHermesBridgeGateway.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.hermesBridgeCronJobs.mock.invocationCallOrder[0]);
  });

  it("starts a stopped bridge and gateway before creating a routine job", async () => {
    mocks.hermesBridgeStatus.mockResolvedValue({ running: false });

    await createRoutine({
      prompt: "Summarize today.",
      schedule: "0 9 * * *",
      name: "Morning brief",
    });

    expect(mocks.startHermesBridge).toHaveBeenCalledTimes(1);
    expect(mocks.ensureHermesBridgeGateway).toHaveBeenCalledTimes(1);
    expect(mocks.createHermesBridgeCronJob).toHaveBeenCalledWith({
      prompt: "Summarize today.",
      schedule: "0 9 * * *",
      name: "Morning brief",
    });
    expect(
      mocks.startHermesBridge.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.ensureHermesBridgeGateway.mock.invocationCallOrder[0],
    );
    expect(
      mocks.ensureHermesBridgeGateway.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.createHermesBridgeCronJob.mock.invocationCallOrder[0],
    );
  });

  it("does not queue a manual run when the persistent gateway cannot start", async () => {
    mocks.ensureHermesBridgeGateway.mockRejectedValue(
      new Error("gateway unavailable"),
    );

    await expect(triggerRoutine("routine-1")).rejects.toThrow(
      "gateway unavailable",
    );
    expect(mocks.hermesBridgeCronJobAction).not.toHaveBeenCalled();
  });
});
