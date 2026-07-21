import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetJuneHomeSessionId,
  isJuneHomeStartTaskTool,
  juneHomeDailyCheckIn,
  juneHomeTaskRequestFromPayload,
  readJuneHomeSessionId,
  stripJuneHomeContext,
  stripJuneHomeContextFromPreview,
  withJuneHomeContext,
  writeJuneHomeSessionId,
} from "../lib/june-home";

describe("June Home", () => {
  beforeEach(() => window.localStorage.clear());

  it("stores one Home session per profile", () => {
    writeJuneHomeSessionId("default", "session-default");
    writeJuneHomeSessionId("work", "session-work");

    expect(readJuneHomeSessionId("default")).toBe("session-default");
    expect(readJuneHomeSessionId("work")).toBe("session-work");

    forgetJuneHomeSessionId("work", "another-session");
    expect(readJuneHomeSessionId("work")).toBe("session-work");
    forgetJuneHomeSessionId("work", "session-work");
    expect(readJuneHomeSessionId("work")).toBeUndefined();
  });

  it("injects Home context without exposing it in the transcript or previews", () => {
    const runtimePrompt = withJuneHomeContext("Help me plan tomorrow");

    expect(runtimePrompt).toContain("[June home context]");
    expect(stripJuneHomeContext(runtimePrompt)).toBe("Help me plan tomorrow");
    expect(stripJuneHomeContextFromPreview(runtimePrompt)).toBe("Help me plan tomorrow");
    expect(stripJuneHomeContextFromPreview("[June home context]\nThis is Ju")).toBe("Home message");
  });

  it("recognizes Hermes MCP name variants and reads their task arguments", () => {
    expect(isJuneHomeStartTaskTool("start_task")).toBe(true);
    expect(isJuneHomeStartTaskTool("mcp_june_home_start_task")).toBe(true);
    expect(isJuneHomeStartTaskTool("june_home.start_task")).toBe(true);
    expect(isJuneHomeStartTaskTool("Mcp june home start task")).toBe(true);
    expect(isJuneHomeStartTaskTool("start_session")).toBe(false);

    expect(
      juneHomeTaskRequestFromPayload({
        arguments: JSON.stringify({
          title: "Plan Paris trip",
          prompt: "Build a five-day Paris itinerary for October.",
          summary: "I will work out the itinerary in a focused session.",
        }),
      }),
    ).toEqual({
      title: "Plan Paris trip",
      prompt: "Build a five-day Paris itinerary for October.",
      summary: "I will work out the itinerary in a focused session.",
    });
  });

  it("keeps one proactive check-in timestamp for the local day", () => {
    const morning = new Date(2026, 6, 21, 9, 30);
    const later = new Date(2026, 6, 21, 16, 0);
    const nextDay = new Date(2026, 6, 22, 9, 0);

    const first = juneHomeDailyCheckIn("default", morning);
    const sameDay = juneHomeDailyCheckIn("default", later);
    const following = juneHomeDailyCheckIn("default", nextDay);

    expect(first.text).toContain("Good morning");
    expect(sameDay.createdAt).toBe(first.createdAt);
    expect(following.createdAt).not.toBe(first.createdAt);
  });
});
