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
});
