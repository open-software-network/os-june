import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteHermesSession,
  isRunningScheduledRunSession,
  isReplaceableScheduledRunTitle,
  isScheduledRunPreamble,
  isScheduledRunSession,
  listHermesSessions,
  listScheduledRunSessions,
  normalizeHermesSessionMessagesResponse,
  normalizeHermesSessionsResponse,
  scheduledRunJobId,
  sessionTimestamp,
  stripScheduledRunPreamble,
  titleFromPrompt,
} from "../lib/hermes-adapter";
import type { HermesSessionInfo } from "../lib/tauri";

const SCHEDULED_PREAMBLE =
  "[IMPORTANT: You are running as a scheduled cron job. DELIVERY: produce " +
  "your report as your final response. SILENT: if there is nothing new, " +
  'respond with exactly "[SILENT]" (nothing else). Never combine [SILENT] ' +
  "with content — either report normally, or say [SILENT] and nothing more.]";

describe("scheduled-run helpers", () => {
  it("recognizes the cron delivery preamble, not arbitrary bracketed text", () => {
    expect(isScheduledRunPreamble(SCHEDULED_PREAMBLE)).toBe(true);
    expect(isScheduledRunPreamble("[IMPORTANT] read this carefully")).toBe(false);
    expect(isScheduledRunPreamble("Summarize today's standup")).toBe(false);
  });

  it("strips the preamble to the routine's own prompt, balancing brackets", () => {
    const prompt = `${SCHEDULED_PREAMBLE}\n\nYou are a daily standup reporter. Summarize GitHub activity.`;
    expect(stripScheduledRunPreamble(prompt)).toBe(
      "You are a daily standup reporter. Summarize GitHub activity.",
    );
    // The inner [SILENT] tokens must not end the preamble early.
    expect(stripScheduledRunPreamble(prompt)).not.toContain("SILENT");
    // A normal prompt is returned untouched (just trimmed).
    expect(stripScheduledRunPreamble("  hello there  ")).toBe("hello there");
  });

  it("gives cron sessions a readable title and clean preview", () => {
    const sessions = normalizeHermesSessionsResponse({
      sessions: [
        {
          id: "cron-1",
          source: "cron",
          title: "",
          preview: `${SCHEDULED_PREAMBLE}\n\nSummarize GitHub activity for the team.`,
          last_active: "2026-06-11T12:00:00Z",
        },
      ],
    });
    const session = sessions[0];
    expect(isScheduledRunSession(session as HermesSessionInfo)).toBe(true);
    expect(session?.title).toBe("Summarize GitHub activity for the team");
    expect(session?.title).not.toContain("IMPORTANT");
    expect(session?.preview?.startsWith("Summarize GitHub activity")).toBe(true);
  });

  it("derives the title from a cron title that is itself the raw preamble", () => {
    const sessions = normalizeHermesSessionsResponse({
      sessions: [
        {
          id: "cron-2",
          source: "cron",
          title: SCHEDULED_PREAMBLE.slice(0, 30),
          preview: `${SCHEDULED_PREAMBLE}\n\nPost the weekly metrics digest.`,
          last_active: "2026-06-11T12:00:00Z",
        },
      ],
    });
    expect(sessions[0]?.title).toBe("Post the weekly metrics digest");
  });

  it("derives the title when the cron session still has the placeholder title", () => {
    const sessions = normalizeHermesSessionsResponse({
      sessions: [
        {
          id: "cron-3",
          source: "cron",
          title: "Untitled session",
          preview: `${SCHEDULED_PREAMBLE}\n\nPrepare the morning brief for today.`,
          last_active: "2026-06-11T12:00:00Z",
        },
      ],
    });
    expect(sessions[0]?.title).toBe("Prepare the morning brief for today");
  });

  it("extracts the routine job id from a cron run session id", () => {
    // The scheduler mints run ids as cron_<job id>_<YYYYMMDD_HHMMSS>.
    expect(scheduledRunJobId("cron_a1b2c3d4e5f6_20260611_093045")).toBe("a1b2c3d4e5f6");
    // A job id containing underscores keeps the trailing timestamp out.
    expect(scheduledRunJobId("cron_my_job_20260611_093045")).toBe("my_job");
    expect(scheduledRunJobId("ordinary-session-id")).toBeUndefined();
    expect(scheduledRunJobId("cron_missing_timestamp")).toBeUndefined();
  });

  it("treats empty, placeholder, and cron-scaffolded titles as replaceable", () => {
    expect(isReplaceableScheduledRunTitle("")).toBe(true);
    expect(isReplaceableScheduledRunTitle("Untitled session")).toBe(true);
    expect(isReplaceableScheduledRunTitle("[IMPORTANT: You are running as")).toBe(true);
    expect(isReplaceableScheduledRunTitle("Morning brief")).toBe(false);
  });
});

const mocks = vi.hoisted(() => ({
  hermesBridgeSessions: vi.fn(),
  deleteHermesBridgeSession: vi.fn(),
  shareKeyGet: vi.fn(),
  shareDelete: vi.fn(),
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
  hermesBridgeSessions: mocks.hermesBridgeSessions,
  hermesBridgeSessionMessages: vi.fn(),
  deleteHermesBridgeSession: mocks.deleteHermesBridgeSession,
  shareKeyGet: mocks.shareKeyGet,
  shareDelete: mocks.shareDelete,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("deleteHermesSession", () => {
  it("revokes the session's share before deleting it", async () => {
    mocks.shareKeyGet.mockResolvedValue({ shareId: "shr_s", contentKeyB64: "AAA" });
    mocks.shareDelete.mockResolvedValue(undefined);
    mocks.deleteHermesBridgeSession.mockResolvedValue(undefined);

    await deleteHermesSession("session-1");

    expect(mocks.shareKeyGet).toHaveBeenCalledWith("session", "session-1");
    expect(mocks.shareDelete).toHaveBeenCalledWith("shr_s");
    expect(mocks.deleteHermesBridgeSession).toHaveBeenCalledWith("session-1");
  });

  it("deletes an unshared session without revoking anything", async () => {
    mocks.shareKeyGet.mockResolvedValue(null);
    mocks.deleteHermesBridgeSession.mockResolvedValue(undefined);

    await deleteHermesSession("session-2");

    expect(mocks.shareDelete).not.toHaveBeenCalled();
    expect(mocks.deleteHermesBridgeSession).toHaveBeenCalledWith("session-2");
  });

  it("keeps the session when the share revoke fails", async () => {
    mocks.shareKeyGet.mockResolvedValue({ shareId: "shr_s", contentKeyB64: "AAA" });
    mocks.shareDelete.mockRejectedValue(new Error("offline"));

    await expect(deleteHermesSession("session-3")).rejects.toThrow("offline");
    // Fail closed: the bridge session is not deleted if its share can't be revoked.
    expect(mocks.deleteHermesBridgeSession).not.toHaveBeenCalled();
  });
});

describe("Hermes adapter", () => {
  it("excludes message-less sessions from the default list query", async () => {
    // Sessions exist before their first message persists (routine runs,
    // failed submits) — listing them renders empty "Untitled session" rows
    // that vanish moments later.
    mocks.hermesBridgeSessions.mockResolvedValue({ sessions: [] });

    await listHermesSessions();
    expect(mocks.hermesBridgeSessions).toHaveBeenCalledWith(
      expect.objectContaining({ minMessages: 1 }),
    );

    await listHermesSessions({ minMessages: 0 });
    expect(mocks.hermesBridgeSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ minMessages: 0 }),
    );
  });

  it("hides delegated subagent sessions from the top-level session list", () => {
    const sessions = normalizeHermesSessionsResponse({
      sessions: [
        {
          id: "parent-session",
          title: "Research request",
          last_active: "2026-06-11T12:00:00Z",
        },
        {
          id: "child-worker",
          source: "tool",
          title: "Browse source 1",
          parent_session_id: "parent-session",
          last_active: "2026-06-11T12:01:00Z",
        },
        {
          id: "camel-child-worker",
          subagentId: "worker-2",
          title: "Browse source 2",
          parentSessionId: "parent-session",
          last_active: "2026-06-11T12:02:00Z",
        },
      ],
    });

    expect(sessions.map((session) => session.id)).toEqual(["parent-session"]);
  });

  it("preserves compressed continuation sessions from the top-level session list", () => {
    const sessions = normalizeHermesSessionsResponse({
      sessions: [
        {
          id: "continuation-session",
          source: "tui",
          title: "Long research request (2)",
          parent_session_id: "parent-session",
          last_active: "2026-06-11T12:02:00Z",
        },
        {
          id: "parent-session",
          source: "tui",
          title: "Long research request",
          end_reason: "compression",
          last_active: "2026-06-11T12:01:00Z",
        },
      ],
    });

    expect(sessions.map((session) => session.id)).toEqual([
      "continuation-session",
      "parent-session",
    ]);
  });

  it("lists only cron-sourced sessions as scheduled runs", async () => {
    mocks.hermesBridgeSessions.mockResolvedValue({
      sessions: [
        {
          id: "cron_a1b2c3d4e5f6_20260611_090000",
          source: "cron",
          preview: "Standup digest ready.",
          last_active: "2026-06-11T09:00:30Z",
        },
        {
          id: "ordinary-session",
          title: "Plan the offsite",
          last_active: "2026-06-11T10:00:00Z",
        },
      ],
    });

    const runs = await listScheduledRunSessions();
    expect(runs.map((run) => run.id)).toEqual(["cron_a1b2c3d4e5f6_20260611_090000"]);
  });

  it("includes active scheduled runs from the session store", async () => {
    mocks.hermesBridgeSessions.mockResolvedValue({
      sessions: [
        {
          id: "cron_a1b2c3d4e5f6_20260611_090000",
          source: "cron",
          is_active: true,
          preview: "Working on the morning digest.",
          last_active: "2026-06-11T09:00:05Z",
        },
        {
          id: "ordinary-session",
          is_active: true,
          preview: "A normal chat is still running.",
        },
      ],
    });

    const runs = await listScheduledRunSessions({ includeActive: true });

    expect(mocks.hermesBridgeSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 200,
        minMessages: 0,
      }),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: "cron_a1b2c3d4e5f6_20260611_090000",
      active: true,
      source: "cron",
      status: "running",
      last_active: "2026-06-11T09:00:05Z",
    });
    expect(isRunningScheduledRunSession(runs[0] as HermesSessionInfo)).toBe(true);
  });

  it("marks recent zero-message scheduled runs as pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T09:01:00Z"));
    mocks.hermesBridgeSessions.mockResolvedValue({
      sessions: [
        {
          id: "cron_a1b2c3d4e5f6_20260611_090000",
          source: "cron",
          title: "",
          preview: "",
          message_count: 0,
          last_active: "2026-06-11T09:00:00Z",
        },
        {
          id: "cron_finished_20260611_085500",
          source: "cron",
          message_count: 0,
          ended_at: "2026-06-11T08:55:05Z",
          last_active: "2026-06-11T08:55:00Z",
        },
      ],
    });

    const runs = await listScheduledRunSessions({ includeActive: true });
    const pending = runs.find((run) => run.id.includes("a1b2c3d4e5f6")) as
      | HermesSessionInfo
      | undefined;
    const finished = runs.find((run) => run.id.includes("finished"));

    expect(pending).toMatchObject({
      id: "cron_a1b2c3d4e5f6_20260611_090000",
      active: true,
      status: "running",
    });
    expect(pending?.title).toBeUndefined();
    expect(pending?.preview).toBeUndefined();
    expect(isRunningScheduledRunSession(pending as HermesSessionInfo)).toBe(true);
    expect(isRunningScheduledRunSession(finished as HermesSessionInfo)).toBe(false);
  });

  it("does not mark old zero-message scheduled runs as running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T09:10:00Z"));
    mocks.hermesBridgeSessions.mockResolvedValue({
      sessions: [
        {
          id: "cron_a1b2c3d4e5f6_20260611_090000",
          source: "cron",
          title: "",
          preview: "",
          message_count: 0,
          last_active: "2026-06-11T09:00:00Z",
        },
      ],
    });

    const runs = await listScheduledRunSessions({ includeActive: true });

    expect(runs).toHaveLength(1);
    expect(isRunningScheduledRunSession(runs[0] as HermesSessionInfo)).toBe(false);
  });

  it("normalizes raw gateway session lists and sorts by recent activity", () => {
    const sessions = normalizeHermesSessionsResponse({
      data: [
        {
          id: "old",
          title: "Old",
          last_active: "2026-06-04T12:00:00Z",
        },
        {
          id: "new",
          title: "New",
          last_active: "2026-06-04T13:00:00Z",
        },
        { title: "Missing id" } as unknown as HermesSessionInfo,
      ],
    });

    expect(sessions.map((session) => session.id)).toEqual(["new", "old"]);
  });

  it("normalizes Hermes Desktop-style session lists", () => {
    const sessions = normalizeHermesSessionsResponse({
      sessions: [{ id: "session-1", preview: "Hello" }],
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe("session-1");
  });

  it("normalizes raw gateway message lists", () => {
    const messages = normalizeHermesSessionMessagesResponse({
      data: [
        { id: 1, role: "user", content: "Hello" } as never,
        { id: "m2", role: "assistant", content: "Hi" },
        {
          id: "bad",
          role: "unknown",
          content: "Nope",
        } as unknown as { id: string; role: "user" },
      ],
    });

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages.map((message) => message.id)).toEqual(["1", "m2"]);
  });

  it("treats malformed gateway responses as empty lists", () => {
    expect(normalizeHermesSessionsResponse(null)).toEqual([]);
    expect(normalizeHermesSessionsResponse("not-json")).toEqual([]);
    expect(normalizeHermesSessionMessagesResponse(undefined)).toEqual([]);
    expect(normalizeHermesSessionMessagesResponse(42)).toEqual([]);
  });

  it("keeps session display helpers stable", () => {
    expect(
      sessionTimestamp({
        id: "session-1",
        started_at: "2026-06-04T11:00:00Z",
      }),
    ).toBe("2026-06-04T11:00:00Z");
    expect(
      sessionTimestamp({
        id: "session-2",
        lastActive: "2026-06-04T12:00:00Z",
      }),
    ).toBe("2026-06-04T12:00:00Z");
    expect(
      sessionTimestamp({
        id: "session-3",
        last_active: 0 as unknown as string,
      }),
    ).toBe("1970-01-01T00:00:00.000Z");
    expect(
      sessionTimestamp({
        id: "session-4",
        last_active: 1_780_603_200 as unknown as string,
      }),
    ).toBe("2026-06-04T20:00:00.000Z");
    expect(titleFromPrompt("  Write   a note  ")).toBe("Write a note");
    expect(titleFromPrompt("I want you to keep this running in my CLI")).toBe(
      "Keep this running in my CLI",
    );
    expect(titleFromPrompt("Help me to organize files")).toBe("Organize files");
    expect(
      titleFromPrompt(
        "please summarize the key points from today's standup\n\n--- Attached Context ---\n{}",
      ),
    ).toBe("Summarize the key points from today's");
    expect(titleFromPrompt("")).toBe("Untitled session");
  });
});
