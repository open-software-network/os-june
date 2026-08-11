import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_SESSION_MODEL_CHANGED_EVENT,
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

  it("publishes each changed staged selection once", () => {
    const changes: unknown[] = [];
    window.addEventListener(AGENT_SESSION_MODEL_CHANGED_EVENT, (event) => {
      changes.push((event as CustomEvent).detail);
    });

    rememberSessionModel("one", "kimi-k2-6");
    rememberSessionModel("one", "kimi-k2-6");
    rememberSessionModel("one", "open-software/auto");

    expect(changes).toEqual([
      { sessionId: "one", storedModel: "kimi-k2-6" },
      { sessionId: "one", storedModel: "open-software/auto" },
    ]);
  });

  it("ignores corrupt and empty values", () => {
    window.localStorage.setItem(
      "clovy.agent.sessionModels",
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
