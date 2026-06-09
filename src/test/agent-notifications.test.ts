import { afterEach, describe, expect, it, vi } from "vitest";

const notificationMocks = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-notification", () => notificationMocks);

import {
  agentNotificationCopy,
  notifyAgentSessionStatus,
} from "../lib/agent-notifications";

describe("agent notifications", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete (
      globalThis as typeof globalThis & {
        __scribeAgentNotificationTimes?: Map<string, number>;
      }
    ).__scribeAgentNotificationTimes;
  });

  it("formats attention-worthy agent statuses", () => {
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

    expect(
      agentNotificationCopy({
        status: "completed",
        title: "Make a PDF",
      }),
    ).toEqual({
      title: "June finished",
      body: "Make a PDF",
    });
  });

  it("does not notify for routine running statuses", async () => {
    await expect(
      notifyAgentSessionStatus({
        status: "running",
        title: "Make a PDF",
      }),
    ).resolves.toBe(false);
    expect(notificationMocks.sendNotification).not.toHaveBeenCalled();
  });

  it("sends notifications for user attention and completion", async () => {
    notificationMocks.isPermissionGranted.mockResolvedValue(true);

    await expect(
      notifyAgentSessionStatus({
        sessionId: "session-1",
        status: "waitingForUser",
        title: "Make a PDF",
        summary: "Approve execute_code.",
      }),
    ).resolves.toBe(true);

    expect(notificationMocks.sendNotification).toHaveBeenCalledWith({
      title: "June needs your input",
      body: "Approve execute_code.",
      group: "scribe-agent-session-1",
      sound: "Ping",
    });
  });

  it("requests native notification permission when needed", async () => {
    notificationMocks.isPermissionGranted.mockResolvedValue(false);
    notificationMocks.requestPermission.mockResolvedValue("granted");

    await expect(
      notifyAgentSessionStatus({
        sessionId: "session-2",
        status: "completed",
        title: "Make a PDF",
      }),
    ).resolves.toBe(true);

    expect(notificationMocks.requestPermission).toHaveBeenCalledOnce();
    expect(notificationMocks.sendNotification).toHaveBeenCalledWith({
      title: "June finished",
      body: "Make a PDF",
      group: "scribe-agent-session-2",
      sound: "Ping",
    });
  });

  it("dedupes duplicate status notifications", async () => {
    notificationMocks.isPermissionGranted.mockResolvedValue(true);

    await notifyAgentSessionStatus({
      sessionId: "session-3",
      status: "completed",
      title: "Make a PDF",
    });
    await notifyAgentSessionStatus({
      sessionId: "session-3",
      status: "completed",
      title: "Make a PDF",
    });

    expect(notificationMocks.sendNotification).toHaveBeenCalledOnce();
  });

  it("does not consume the dedupe slot when permission is not granted", async () => {
    notificationMocks.isPermissionGranted.mockResolvedValue(false);
    notificationMocks.requestPermission.mockResolvedValue("denied");

    await expect(
      notifyAgentSessionStatus({
        sessionId: "session-4",
        status: "completed",
        title: "Make a PDF",
      }),
    ).resolves.toBe(false);
    expect(notificationMocks.sendNotification).not.toHaveBeenCalled();

    notificationMocks.isPermissionGranted.mockResolvedValue(true);

    await expect(
      notifyAgentSessionStatus({
        sessionId: "session-4",
        status: "completed",
        title: "Make a PDF",
      }),
    ).resolves.toBe(true);
    expect(notificationMocks.sendNotification).toHaveBeenCalledOnce();
  });

  it("prunes dedupe entries older than the window", async () => {
    vi.useFakeTimers();
    try {
      notificationMocks.isPermissionGranted.mockResolvedValue(true);

      await notifyAgentSessionStatus({
        sessionId: "session-5",
        status: "completed",
        title: "First",
      });
      vi.advanceTimersByTime(20_000);
      await notifyAgentSessionStatus({
        sessionId: "session-6",
        status: "completed",
        title: "Second",
      });

      expect(notificationMocks.sendNotification).toHaveBeenCalledTimes(2);
      const recent = (
        globalThis as typeof globalThis & {
          __scribeAgentNotificationTimes?: Map<string, number>;
        }
      ).__scribeAgentNotificationTimes;
      expect(recent?.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes suspended audio contexts and closes them exactly once", async () => {
    vi.useFakeTimers();
    const contexts: FakeAudioContext[] = [];
    const endedListeners: Array<() => void> = [];

    class FakeAudioContext {
      state = "suspended";
      currentTime = 0;
      destination = {};
      resume = vi.fn().mockResolvedValue(undefined);
      close = vi.fn().mockResolvedValue(undefined);
      constructor() {
        contexts.push(this);
      }
      createOscillator() {
        return {
          type: "",
          frequency: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          addEventListener: (_name: string, listener: () => void) => {
            endedListeners.push(listener);
          },
        };
      }
      createGain() {
        return {
          gain: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
        };
      }
    }

    const target = window as unknown as { AudioContext?: unknown };
    const originalAudioContext = target.AudioContext;
    target.AudioContext = FakeAudioContext;
    try {
      notificationMocks.isPermissionGranted.mockResolvedValue(true);

      await notifyAgentSessionStatus({
        sessionId: "session-7",
        status: "completed",
        title: "Tone",
      });

      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.resume).toHaveBeenCalledOnce();

      // "ended" fires, then the fallback timer fires; close runs only once.
      for (const listener of endedListeners) listener();
      vi.advanceTimersByTime(5_000);
      expect(contexts[0]?.close).toHaveBeenCalledOnce();
    } finally {
      target.AudioContext = originalAudioContext;
      vi.useRealTimers();
    }
  });
});
