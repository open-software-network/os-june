import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRoutine,
  listRoutines,
  pauseRoutine,
  removeRoutine,
  resumeRoutine,
  routineCreationPrompt,
  triggerRoutine,
  updateRoutine,
  UNRESTRICTED_ROUTINE_TOOLSETS,
} from "../lib/hermes-routines";

const mocks = vi.hoisted(() => ({
  hermesBridgeStatus: vi.fn(),
  startHermesBridge: vi.fn(),
  ensureHermesBridgeGateway: vi.fn(),
  hermesBridgeCronJobs: vi.fn(),
  createHermesBridgeCronJob: vi.fn(),
  updateHermesBridgeCronJob: vi.fn(),
  deleteHermesBridgeCronJob: vi.fn(),
  hermesBridgeCronJobAction: vi.fn(),
  memorySettings: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  dictationCapabilities: vi.fn().mockResolvedValue({
    capabilities: {
      available: true,
      platform: "macos",
      shortcuts: true,
      paste: true,
      microphoneSelection: true,
      accessibilityPermission: true,
      systemAudio: true,
    },
  }),
  hermesBridgeStatus: mocks.hermesBridgeStatus,
  startHermesBridge: mocks.startHermesBridge,
  ensureHermesBridgeGateway: mocks.ensureHermesBridgeGateway,
  hermesBridgeCronJobs: mocks.hermesBridgeCronJobs,
  createHermesBridgeCronJob: mocks.createHermesBridgeCronJob,
  updateHermesBridgeCronJob: mocks.updateHermesBridgeCronJob,
  deleteHermesBridgeCronJob: mocks.deleteHermesBridgeCronJob,
  hermesBridgeCronJobAction: mocks.hermesBridgeCronJobAction,
  memorySettings: mocks.memorySettings,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hermesBridgeStatus.mockResolvedValue({ running: true });
  mocks.startHermesBridge.mockResolvedValue({ running: true });
  mocks.ensureHermesBridgeGateway.mockResolvedValue(undefined);
  mocks.hermesBridgeCronJobs.mockResolvedValue([]);
  mocks.memorySettings.mockResolvedValue({ enabled: true });
  mocks.createHermesBridgeCronJob.mockResolvedValue({
    id: "routine-1",
    name: "Morning brief",
    prompt: "Summarize today.",
    schedule_display: "0 9 * * *",
    enabled: true,
  });
  mocks.updateHermesBridgeCronJob.mockResolvedValue({
    id: "routine-1",
    name: "Morning brief",
    prompt: "Summarize today.",
    schedule_display: "0 10 * * *",
    enabled: true,
  });
  mocks.deleteHermesBridgeCronJob.mockResolvedValue({});
  mocks.hermesBridgeCronJobAction.mockResolvedValue({});
});

describe("Routines Hermes integration", () => {
  it("lists routine jobs without requiring the persistent gateway", async () => {
    mocks.ensureHermesBridgeGateway.mockRejectedValue(new Error("gateway unavailable"));

    await listRoutines();

    expect(mocks.ensureHermesBridgeGateway).not.toHaveBeenCalled();
    expect(mocks.hermesBridgeCronJobs).toHaveBeenCalledTimes(1);
  });

  it("allows cleanup actions when the persistent gateway cannot start", async () => {
    mocks.ensureHermesBridgeGateway.mockRejectedValue(new Error("gateway unavailable"));

    await pauseRoutine("routine-1");
    await removeRoutine("routine-1");

    expect(mocks.ensureHermesBridgeGateway).not.toHaveBeenCalled();
    expect(mocks.hermesBridgeCronJobAction).toHaveBeenCalledWith("routine-1", "pause");
    expect(mocks.deleteHermesBridgeCronJob).toHaveBeenCalledWith("routine-1");
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
    expect(mocks.startHermesBridge.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureHermesBridgeGateway.mock.invocationCallOrder[0],
    );
    expect(mocks.ensureHermesBridgeGateway.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createHermesBridgeCronJob.mock.invocationCallOrder[0],
    );
  });

  it("ensures the persistent gateway before resuming or rescheduling a routine", async () => {
    await resumeRoutine("routine-1");
    await updateRoutine("routine-1", { schedule: "0 10 * * *" });

    expect(mocks.ensureHermesBridgeGateway).toHaveBeenCalledTimes(2);
    expect(mocks.hermesBridgeCronJobAction).toHaveBeenCalledWith("routine-1", "resume");
    expect(mocks.updateHermesBridgeCronJob).toHaveBeenCalledWith("routine-1", {
      schedule: "0 10 * * *",
    });
  });

  it("updates non-scheduler fields without requiring the persistent gateway", async () => {
    mocks.ensureHermesBridgeGateway.mockRejectedValue(new Error("gateway unavailable"));

    await updateRoutine("routine-1", { name: "Renamed" });

    expect(mocks.ensureHermesBridgeGateway).not.toHaveBeenCalled();
    expect(mocks.updateHermesBridgeCronJob).toHaveBeenCalledWith("routine-1", {
      name: "Renamed",
    });
  });

  it("ensures the persistent gateway before a prompt-only routine edit", async () => {
    await updateRoutine("routine-1", { prompt: "Summarize this week." });
    expect(mocks.ensureHermesBridgeGateway).toHaveBeenCalledTimes(1);
    expect(mocks.updateHermesBridgeCronJob).toHaveBeenCalledWith("routine-1", {
      prompt: "Summarize this week.",
    });
  });

  it("ensures the persistent gateway before an unrestricted-only routine edit", async () => {
    await updateRoutine("routine-1", { unrestricted: true });
    expect(mocks.ensureHermesBridgeGateway).toHaveBeenCalledTimes(1);
    expect(mocks.updateHermesBridgeCronJob).toHaveBeenCalledWith("routine-1", {
      enabled_toolsets: UNRESTRICTED_ROUTINE_TOOLSETS,
    });
  });

  it("keeps image generation out of unrestricted routine toolsets", () => {
    expect(UNRESTRICTED_ROUTINE_TOOLSETS).not.toContain("image_gen");
  });

  it("strips the native memory toolset from an unrestricted routine when memory is off", async () => {
    mocks.memorySettings.mockResolvedValue({ enabled: false });

    await updateRoutine("routine-1", { unrestricted: true });

    const sent = mocks.updateHermesBridgeCronJob.mock.calls.at(-1)?.[1] as {
      enabled_toolsets: string[];
    };
    expect(sent.enabled_toolsets).not.toContain("memory");
    // Everything else the user opted into is preserved.
    expect(sent.enabled_toolsets).toContain("terminal");
  });

  it("keeps the native memory toolset when memory is on", async () => {
    await createRoutine({
      prompt: "Summarize today.",
      schedule: "0 9 * * *",
      unrestricted: true,
    });

    const sent = mocks.updateHermesBridgeCronJob.mock.calls.at(-1)?.[1] as {
      enabled_toolsets: string[];
    };
    expect(sent.enabled_toolsets).toContain("memory");
  });

  it("fails closed and drops native memory if the memory setting cannot be read", async () => {
    mocks.memorySettings.mockRejectedValue(new Error("unavailable"));

    await updateRoutine("routine-1", { unrestricted: true });

    const sent = mocks.updateHermesBridgeCronJob.mock.calls.at(-1)?.[1] as {
      enabled_toolsets: string[];
    };
    expect(sent.enabled_toolsets).not.toContain("memory");
  });

  it("strips native memory from the described unrestricted routine prompt when memory is off", async () => {
    mocks.memorySettings.mockResolvedValue({ enabled: false });

    const prompt = await routineCreationPrompt("Summarize my day", { unrestricted: true });

    // The unrestricted mode line is the only place the prompt names toolsets,
    // so an absent "memory" here means the described override can't grant it.
    expect(prompt).toContain("enabled_toolsets set to exactly:");
    expect(prompt).not.toContain("memory");
    expect(prompt).toContain("terminal");
  });

  it("keeps native memory in the described unrestricted routine prompt when memory is on", async () => {
    const prompt = await routineCreationPrompt("Summarize my day", { unrestricted: true });

    expect(prompt).toContain("memory");
  });

  it("fails closed: drops native memory from the described unrestricted prompt when the setting can't be read", async () => {
    mocks.memorySettings.mockRejectedValue(new Error("unavailable"));

    const prompt = await routineCreationPrompt("Summarize my day", { unrestricted: true });

    expect(prompt).not.toContain("memory");
  });

  it("does not set an explicit toolset override (or read the memory setting) for a sandboxed described routine", async () => {
    const prompt = await routineCreationPrompt("Summarize my day");

    // Sandboxed routines carry no explicit enabled_toolsets, so the Rust cron
    // gate covers them; nothing to strip and no setting to consult.
    expect(prompt).toContain("Do not set enabled_toolsets");
    expect(mocks.memorySettings).not.toHaveBeenCalled();
  });

  it("does not queue a manual run when the persistent gateway cannot start", async () => {
    mocks.ensureHermesBridgeGateway.mockRejectedValue(new Error("gateway unavailable"));

    await expect(triggerRoutine("routine-1")).rejects.toThrow("gateway unavailable");
    expect(mocks.hermesBridgeCronJobAction).not.toHaveBeenCalled();
  });
});
