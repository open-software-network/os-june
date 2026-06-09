import { describe, expect, it } from "vitest";
import {
  normalizeHermesSessionMessagesResponse,
  normalizeHermesSessionsResponse,
  sessionTimestamp,
  titleFromPrompt,
} from "../lib/hermes-adapter";
import type { HermesSessionInfo } from "../lib/tauri";

describe("Hermes adapter", () => {
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

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
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
    expect(titleFromPrompt("")).toBe("Untitled session");
  });
});
