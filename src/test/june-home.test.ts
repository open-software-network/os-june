import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetJuneHomeSessionId,
  isJuneHomeStartTaskTool,
  juneHomeDailyCheckIn,
  juneHomeDayKey,
  juneHomeDayLabel,
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

  it("labels day boundaries relative to now and keys them by local day", () => {
    const now = new Date(2026, 6, 22, 14, 45);

    expect(juneHomeDayLabel(new Date(2026, 6, 22, 9, 4).toISOString(), now)).toMatch(
      /^Today at 9:04/,
    );
    expect(juneHomeDayLabel(new Date(2026, 6, 21, 16, 12).toISOString(), now)).toMatch(
      /^Yesterday at /,
    );
    // Two to six days back reads as the weekday; older dates spell the date.
    expect(juneHomeDayLabel(new Date(2026, 6, 20, 8, 0).toISOString(), now)).toMatch(/^Monday at /);
    expect(juneHomeDayLabel(new Date(2026, 5, 12, 8, 0).toISOString(), now)).toMatch(
      /^June 12 at /,
    );
    expect(juneHomeDayLabel(new Date(2025, 11, 31, 8, 0).toISOString(), now)).toMatch(/2025/);
    expect(juneHomeDayLabel("not-a-date", now)).toBe("");

    expect(juneHomeDayKey(new Date(2026, 6, 22, 0, 5).toISOString())).toBe(
      juneHomeDayKey(new Date(2026, 6, 22, 23, 55).toISOString()),
    );
    expect(juneHomeDayKey(new Date(2026, 6, 22, 23, 55).toISOString())).not.toBe(
      juneHomeDayKey(new Date(2026, 6, 23, 0, 5).toISOString()),
    );
    expect(juneHomeDayKey("not-a-date")).toBe("");
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
