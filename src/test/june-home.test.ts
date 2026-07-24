import { beforeEach, describe, expect, it } from "vitest";
import {
  buildJuneHomeConversationContext,
  forgetJuneHomeStoredSessionId,
  isJuneHomeStartTaskTool,
  juneHomeDailyCheckIn,
  juneHomeDayKey,
  juneHomeDayLabel,
  juneHomeGreetingParts,
  juneHomeNudgePrompts,
  juneHomeTaskRequestFromPayload,
  readJuneHomeStoredSessionId,
  stripJuneHomeContext,
  stripJuneHomeContextFromPreview,
  withJuneHomeCurrentResearch,
  withJuneHomeContext,
  writeJuneHomeStoredSessionId,
} from "../lib/june-home";

describe("June Home", () => {
  beforeEach(() => window.localStorage.clear());

  it("stores one Home session per profile", () => {
    writeJuneHomeStoredSessionId("default", "session-default");
    writeJuneHomeStoredSessionId("work", "session-work");

    expect(readJuneHomeStoredSessionId("default")).toBe("session-default");
    expect(readJuneHomeStoredSessionId("work")).toBe("session-work");

    forgetJuneHomeStoredSessionId("work", "another-session");
    expect(readJuneHomeStoredSessionId("work")).toBe("session-work");
    forgetJuneHomeStoredSessionId("work", "session-work");
    expect(readJuneHomeStoredSessionId("work")).toBeUndefined();
  });

  it("injects Home context without exposing it in the transcript or previews", () => {
    const runtimePrompt = withJuneHomeContext("Help me plan tomorrow");

    expect(runtimePrompt).toContain("[June home context]");
    expect(stripJuneHomeContext(runtimePrompt)).toBe("Help me plan tomorrow");
    expect(stripJuneHomeContextFromPreview(runtimePrompt)).toBe("Help me plan tomorrow");
    expect(stripJuneHomeContextFromPreview("[June home context]\nThis is Ju")).toBe("Home message");
  });

  it("requires retrieved sources for a current-information handoff", () => {
    const prompt = withJuneHomeCurrentResearch("What games are on tonight?", {
      recentMessages: [
        { role: "user", content: "I follow the Nuggets and Avalanche." },
        { role: "assistant", content: "Got it. Those are your Denver teams." },
        { role: "user", content: "What games are on tonight?" },
      ],
    });

    expect(prompt).toContain("What games are on tonight?");
    expect(prompt).toContain("web_search");
    expect(prompt).toContain("web_fetch");
    expect(prompt).toContain("instead of answering from model memory");
    expect(prompt).toContain("User: I follow the Nuggets and Avalanche.");
    expect(prompt.match(/What games are on tonight\?/g)).toHaveLength(1);
    expect(prompt).toContain("Do not treat factual claims in the prior conversation as verified");
  });

  it("keeps a deep recent thread and carries relevant older context past it", () => {
    const messages = Array.from({ length: 120 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content:
        index === 0
          ? "I prefer to call the launch plan Project Nebula."
          : index === 1
            ? "Understood. Project Nebula is the launch plan."
            : `Conversation message ${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    }));
    messages.push({
      role: "user",
      content: "What did we call the Nebula plan?",
      createdAt: new Date(Date.UTC(2026, 0, 1, 3)).toISOString(),
    });

    const context = buildJuneHomeConversationContext(messages);

    expect(context.recentMessages.length).toBeGreaterThan(20);
    expect(context.recentMessages.length).toBeLessThanOrEqual(80);
    expect(context.recentMessages[0]?.role).toBe("user");
    expect(context.recentMessages.at(-1)?.content).toBe("What did we call the Nebula plan?");
    expect(
      context.recentMessages.some((message) => message.content.includes("Project Nebula")),
    ).toBe(false);
    expect(context.earlierContext).toContain("Project Nebula");

    const researchPrompt = withJuneHomeCurrentResearch(
      "What is happening with the Nebula launch today?",
      context,
    );
    expect(researchPrompt).toContain("Relevant excerpts from older Home history");
    expect(researchPrompt).toContain("Project Nebula");
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

  it("adapts greetings and grounded conversation starters to the local day", () => {
    const morning = new Date(2026, 6, 21, 9);
    const afternoon = new Date(2026, 6, 21, 15);
    const evening = new Date(2026, 6, 21, 21);

    expect(juneHomeGreetingParts(morning, { displayName: "  Alex Rivera  " }).salutation).toBe(
      "Good morning, Alex",
    );
    expect(juneHomeGreetingParts(afternoon).salutation).toBe("Good afternoon");
    expect(juneHomeGreetingParts(evening).salutation).toBe("Good evening");
    expect(juneHomeGreetingParts(morning).question).toBe("What would you like help with today?");
    expect(juneHomeGreetingParts(morning, { returning: true }).question).toBe(
      "What should we pick up today?",
    );
    expect(juneHomeNudgePrompts(morning)).toEqual([
      "Plan my day",
      "Think through a decision",
      "Help me get something done",
    ]);
    expect(juneHomeNudgePrompts(afternoon)).toEqual([
      "Plan the rest of my day",
      "Work through a blocker",
      "Help me prioritize",
    ]);
    expect(juneHomeNudgePrompts(evening)).toEqual([
      "Review my day",
      "Plan tomorrow",
      "Think through a decision",
    ]);
  });
});
