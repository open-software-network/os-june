import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionModelIfApplied,
  forgetSessionModel,
  loadSessionModels,
  rememberSessionModel,
} from "../lib/agent-session-models";

describe("agent session model drafts", () => {
  beforeEach(() => window.localStorage.clear());

  it("retains staged choices independently by session", () => {
    rememberSessionModel("one", "open-software/auto");
    rememberSessionModel("two", "fast");
    expect(loadSessionModels()).toEqual({ one: "open-software/auto", two: "fast" });

    forgetSessionModel("one");
    expect(loadSessionModels()).toEqual({ two: "fast" });
  });

  it("ignores corrupt and empty values", () => {
    window.localStorage.setItem(
      "june.agent.sessionModels",
      JSON.stringify({ valid: "fast", empty: "", invalid: 42 }),
    );
    expect(loadSessionModels()).toEqual({ valid: "fast" });
  });

  it("does not let an older run acknowledgement erase a newer choice", () => {
    rememberSessionModel("one", "kimi");
    rememberSessionModel("one", "open-software/auto");
    clearSessionModelIfApplied("one", "kimi");
    expect(loadSessionModels()).toEqual({ one: "open-software/auto" });

    clearSessionModelIfApplied("one", "open-software/auto");
    expect(loadSessionModels()).toEqual({});
  });
});
