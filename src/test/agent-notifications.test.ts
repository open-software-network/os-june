import { afterEach, describe, expect, it, vi } from "vitest";

const notificationMocks = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
  playAgentSound: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-notification", () => notificationMocks);
vi.mock("../lib/agent-sounds", () => ({
  playAgentSound: notificationMocks.playAgentSound,
}));

import {
  agentAttentionDecision,
  agentNotificationCopy,
  notifyAgentRunSettled,
  notifyAgentSessionStatus,
  type AgentAttentionContext,
} from "../lib/agent-notifications";

const FOCUSED_ELSEWHERE: AgentAttentionContext = {
  away: false,
  viewingSession: false,
  captureActive: false,
  soundsEnabled: true,
};

describe("agent notifications", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete (
      globalThis as typeof globalThis & {
        __juneAgentNotificationTimes?: Map<string, number>;
      }
    ).__juneAgentNotificationTimes;
  });

  it("maps attention to sound and native delivery based on what the user can see", () => {
    expect(agentAttentionDecision("ready", FOCUSED_ELSEWHERE)).toEqual({
      cue: "ready",
      showNative: false,
    });
    expect(
      agentAttentionDecision("needsInput", {
        ...FOCUSED_ELSEWHERE,
        away: true,
      }),
    ).toEqual({ cue: "needsInput", showNative: true });
    expect(
      agentAttentionDecision("ready", {
        ...FOCUSED_ELSEWHERE,
        viewingSession: true,
      }),
    ).toEqual({ showNative: false });
  });

  it("strips sound during capture or after an opt-out without hiding away-app visuals", () => {
    expect(
      agentAttentionDecision("needsInput", {
        ...FOCUSED_ELSEWHERE,
        away: true,
        captureActive: true,
      }),
    ).toEqual({ showNative: true });
    expect(
      agentAttentionDecision("ready", {
        ...FOCUSED_ELSEWHERE,
        away: true,
        soundsEnabled: false,
      }),
    ).toEqual({ showNative: true });
    expect(agentAttentionDecision(undefined, FOCUSED_ELSEWHERE)).toEqual({ showNative: false });
  });

  it("formats attention-worthy status copy", () => {
    expect(
      agentNotificationCopy({
        status: "waitingForUser",
        title: "Approve a tool",
        summary: "June needs approval.",
      }),
    ).toEqual({
      title: "June needs your input",
      body: "June needs approval.",
    });
  });

  it.each([
    "received",
    "starting",
    "running",
    "completed",
    "cancelled",
  ] as const)("keeps %s status events silent", async (status) => {
    await expect(
      notifyAgentSessionStatus({ status, title: "Make a PDF" }, FOCUSED_ELSEWHERE),
    ).resolves.toBe(false);
    expect(notificationMocks.playAgentSound).not.toHaveBeenCalled();
    expect(notificationMocks.sendNotification).not.toHaveBeenCalled();
  });

  it("plays the needs-input cue locally when the app is focused elsewhere", async () => {
    await expect(
      notifyAgentSessionStatus(
        {
          sessionId: "session-1",
          status: "waitingForUser",
          title: "Make a PDF",
          summary: "Approve execute_code.",
        },
        FOCUSED_ELSEWHERE,
      ),
    ).resolves.toBe(true);

    expect(notificationMocks.playAgentSound).toHaveBeenCalledWith("needsInput");
    expect(notificationMocks.isPermissionGranted).not.toHaveBeenCalled();
    expect(notificationMocks.sendNotification).not.toHaveBeenCalled();
  });

  it("uses the ready cue only for the true-idle settled event", async () => {
    await expect(
      notifyAgentRunSettled(
        {
          sessionId: "session-2",
          title: "Make a PDF",
          summary: "June finished.",
        },
        FOCUSED_ELSEWHERE,
      ),
    ).resolves.toBe(true);

    expect(notificationMocks.playAgentSound).toHaveBeenCalledWith("ready");
  });

  it("posts a silent native notification when the app is away", async () => {
    notificationMocks.isPermissionGranted.mockResolvedValue(true);

    await expect(
      notifyAgentRunSettled(
        {
          sessionId: "session-3",
          title: "Make a PDF",
          summary: "June finished.",
        },
        { ...FOCUSED_ELSEWHERE, away: true },
      ),
    ).resolves.toBe(true);

    expect(notificationMocks.sendNotification).toHaveBeenCalledWith({
      title: "June is ready",
      body: "Make a PDF",
      group: "june-agent-session-3",
    });
    expect(notificationMocks.sendNotification.mock.calls[0]?.[0]).not.toHaveProperty("sound");
  });

  it("plays local audio even when native notification permission is denied", async () => {
    notificationMocks.isPermissionGranted.mockResolvedValue(false);
    notificationMocks.requestPermission.mockResolvedValue("denied");

    await expect(
      notifyAgentSessionStatus(
        {
          sessionId: "session-4",
          status: "failed",
          title: "Make a PDF",
        },
        { ...FOCUSED_ELSEWHERE, away: true },
      ),
    ).resolves.toBe(true);

    expect(notificationMocks.playAgentSound).toHaveBeenCalledWith("needsInput");
    expect(notificationMocks.sendNotification).not.toHaveBeenCalled();
  });

  it("keeps native visuals but suppresses their sound while capture is active", async () => {
    notificationMocks.isPermissionGranted.mockResolvedValue(true);

    await notifyAgentSessionStatus(
      {
        sessionId: "session-5",
        status: "waitingForUser",
        title: "Approve a tool",
      },
      { ...FOCUSED_ELSEWHERE, away: true, captureActive: true },
    );

    expect(notificationMocks.playAgentSound).not.toHaveBeenCalled();
    expect(notificationMocks.sendNotification).toHaveBeenCalledOnce();
    expect(notificationMocks.sendNotification.mock.calls[0]?.[0]).not.toHaveProperty("sound");
  });

  it("dedupes duplicate attention events", async () => {
    await notifyAgentRunSettled(
      { sessionId: "session-6", title: "Make a PDF", summary: "June finished." },
      FOCUSED_ELSEWHERE,
    );
    await notifyAgentRunSettled(
      { sessionId: "session-6", title: "Make a PDF", summary: "June finished." },
      FOCUSED_ELSEWHERE,
    );

    expect(notificationMocks.playAgentSound).toHaveBeenCalledOnce();
  });

  it("reserves dedupe before awaiting native permission", async () => {
    let resolvePermission: ((value: boolean) => void) | undefined;
    notificationMocks.isPermissionGranted.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePermission = resolve;
        }),
    );
    const detail = {
      sessionId: "session-concurrent",
      title: "Make a PDF",
      summary: "June finished.",
    };
    const context = { ...FOCUSED_ELSEWHERE, away: true, captureActive: true };

    const first = notifyAgentRunSettled(detail, context);
    const second = notifyAgentRunSettled(detail, context);
    resolvePermission?.(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
    expect(notificationMocks.sendNotification).toHaveBeenCalledOnce();
  });

  it("swallows native delivery errors after the local cue", async () => {
    notificationMocks.isPermissionGranted.mockResolvedValue(true);
    notificationMocks.sendNotification.mockImplementation(() => {
      throw new Error("notification center unavailable");
    });

    await expect(
      notifyAgentRunSettled(
        { sessionId: "session-7", title: "Make a PDF", summary: "June finished." },
        { ...FOCUSED_ELSEWHERE, away: true },
      ),
    ).resolves.toBe(true);
  });
});
