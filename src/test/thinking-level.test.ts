import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_THINKING_LEVEL,
  forgetSessionThinkingLevel,
  isThinkingLevel,
  loadSessionThinkingLevels,
  loadThinkingLevel,
  rememberSessionThinkingLevel,
  saveThinkingLevel,
  thinkingEffortForLevel,
  thinkingLevelForEffort,
  thinkingOptionForLevel,
  THINKING_LEVELS,
} from "../lib/thinking-level";

const STORAGE_KEY = "june.agent.thinkingLevel";

describe("thinking levels", () => {
  it("exposes exactly three stops in track order", () => {
    expect(THINKING_LEVELS.map((option) => option.id)).toEqual([
      "instant",
      "medium",
      "hard",
    ]);
  });

  it("maps each level onto a Hermes reasoning effort", () => {
    // Instant barely deliberates (near-instant responses), Medium is Hermes'
    // own default, Hard reasons substantially more.
    expect(thinkingEffortForLevel("instant")).toBe("minimal");
    expect(thinkingEffortForLevel("medium")).toBe("medium");
    expect(thinkingEffortForLevel("hard")).toBe("high");
  });

  it("uses sentence-case labels and dash-free blurbs (project copy rule)", () => {
    for (const option of THINKING_LEVELS) {
      expect(option.label).toMatch(/^[A-Z][a-z]/);
      expect(option.blurb).not.toMatch(/[–—]/);
    }
  });

  it("resolves every level to an option, defaulting safely", () => {
    for (const option of THINKING_LEVELS) {
      expect(thinkingOptionForLevel(option.id)).toBe(option);
    }
  });

  it("maps Hermes effort strings back onto the nearest stop", () => {
    expect(thinkingLevelForEffort("minimal")).toBe("instant");
    expect(thinkingLevelForEffort("low")).toBe("instant");
    expect(thinkingLevelForEffort("medium")).toBe("medium");
    expect(thinkingLevelForEffort("high")).toBe("hard");
    expect(thinkingLevelForEffort("xhigh")).toBe("hard");
    expect(thinkingLevelForEffort("")).toBeUndefined();
    expect(thinkingLevelForEffort(undefined)).toBeUndefined();
    expect(thinkingLevelForEffort("turbo")).toBeUndefined();
  });
});

describe("thinking level persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("drafts Medium when nothing was stored", () => {
    expect(loadThinkingLevel()).toBe(DEFAULT_THINKING_LEVEL);
    expect(DEFAULT_THINKING_LEVEL).toBe("medium");
  });

  it("round-trips a saved level", () => {
    saveThinkingLevel("hard");
    expect(loadThinkingLevel()).toBe("hard");
    saveThinkingLevel("instant");
    expect(loadThinkingLevel()).toBe("instant");
  });

  it("falls back to the default for unreadable stored values", () => {
    window.localStorage.setItem(STORAGE_KEY, "ultra");
    expect(loadThinkingLevel()).toBe(DEFAULT_THINKING_LEVEL);
    window.localStorage.setItem(STORAGE_KEY, "");
    expect(loadThinkingLevel()).toBe(DEFAULT_THINKING_LEVEL);
  });

  it("guards the level union", () => {
    expect(isThinkingLevel("instant")).toBe(true);
    expect(isThinkingLevel("medium")).toBe(true);
    expect(isThinkingLevel("hard")).toBe(true);
    expect(isThinkingLevel("xhigh")).toBe(false);
    expect(isThinkingLevel(null)).toBe(false);
  });
});

describe("per-session thinking levels", () => {
  const SESSIONS_KEY = "june.agent.sessionThinkingLevels";

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("starts empty and round-trips per-session records", () => {
    expect(loadSessionThinkingLevels()).toEqual({});
    rememberSessionThinkingLevel("s1", "hard");
    rememberSessionThinkingLevel("s2", "instant");
    expect(loadSessionThinkingLevels()).toEqual({
      s1: "hard",
      s2: "instant",
    });
  });

  it("overwrites a session's level without touching others", () => {
    rememberSessionThinkingLevel("s1", "hard");
    rememberSessionThinkingLevel("s2", "medium");
    rememberSessionThinkingLevel("s1", "instant");
    expect(loadSessionThinkingLevels()).toEqual({
      s1: "instant",
      s2: "medium",
    });
  });

  it("forgets a deleted session and drops the key when the map empties", () => {
    rememberSessionThinkingLevel("s1", "hard");
    forgetSessionThinkingLevel("s1");
    expect(loadSessionThinkingLevels()).toEqual({});
    expect(window.localStorage.getItem(SESSIONS_KEY)).toBeNull();
    // Forgetting an unknown session is a no-op.
    rememberSessionThinkingLevel("s2", "medium");
    forgetSessionThinkingLevel("s3");
    expect(loadSessionThinkingLevels()).toEqual({ s2: "medium" });
  });

  it("ignores corrupt stored values", () => {
    window.localStorage.setItem(SESSIONS_KEY, "not json");
    expect(loadSessionThinkingLevels()).toEqual({});
    window.localStorage.setItem(
      SESSIONS_KEY,
      JSON.stringify({ s1: "ultra", s2: "hard" }),
    );
    expect(loadSessionThinkingLevels()).toEqual({ s2: "hard" });
  });
});
