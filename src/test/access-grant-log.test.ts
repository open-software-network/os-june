import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_GRANT_LOG_CAP,
  approvalPatternKeys,
  createAccessGrantLog,
  grantDuration,
  grantScope,
} from "../lib/access-grant-log";

beforeEach(() => {
  localStorage.clear();
});

describe("access grant log — scope/duration derivation", () => {
  it("maps the approval choice to the JUN-206 scope and duration", () => {
    expect(grantScope("once")).toBe("session");
    expect(grantScope("session")).toBe("session");
    expect(grantScope("always")).toBe("app-wide");
    expect(grantDuration("once")).toBe("one-time");
    expect(grantDuration("session")).toBe("ongoing");
    expect(grantDuration("always")).toBe("ongoing");
  });
});

describe("access grant log — pattern key extraction", () => {
  it("prefers the pattern_keys list and falls back to pattern_key", () => {
    expect(approvalPatternKeys({ pattern_keys: ["a", "b"] })).toEqual(["a", "b"]);
    expect(approvalPatternKeys({ pattern_key: "solo" })).toEqual(["solo"]);
    expect(approvalPatternKeys({ pattern_keys: [], pattern_key: "solo" })).toEqual(["solo"]);
  });

  it("is total on junk", () => {
    expect(approvalPatternKeys(undefined)).toEqual([]);
    expect(approvalPatternKeys("nope")).toEqual([]);
    expect(approvalPatternKeys({ pattern_keys: [1, null, ""] })).toEqual([]);
    expect(approvalPatternKeys([])).toEqual([]);
  });
});

describe("access grant log — record/list/remove/clear", () => {
  it("records a grant and lists it newest first", () => {
    const log = createAccessGrantLog();
    log.record({
      sessionId: "s1",
      requestId: "r1",
      choice: "session",
      command: "rm -rf build",
      description: "Recursive deletion (rm -rf)",
      patternKeys: ["Recursive deletion (rm -rf)"],
      grantedAt: 100,
    });
    log.record({
      sessionId: "s1",
      requestId: "r2",
      choice: "once",
      command: "git push --force",
      patternKeys: [],
      grantedAt: 200,
    });

    const entries = log.list();
    expect(entries.map((entry) => entry.requestId)).toEqual(["r2", "r1"]);
    expect(entries[1].command).toBe("rm -rf build");
  });

  it("persists to localStorage and reloads in a fresh instance", () => {
    const log = createAccessGrantLog();
    log.record({
      sessionId: "s1",
      requestId: "r1",
      choice: "always",
      patternKeys: ["Curl piped to shell"],
      grantedAt: 100,
    });

    const fresh = createAccessGrantLog();
    expect(fresh.list()).toHaveLength(1);
    expect(fresh.list()[0].choice).toBe("always");
  });

  it("replaces a re-record of the same session + request", () => {
    const log = createAccessGrantLog();
    log.record({ sessionId: "s1", requestId: "r1", choice: "once", patternKeys: [] });
    log.record({ sessionId: "s1", requestId: "r1", choice: "session", patternKeys: [] });
    expect(log.list()).toHaveLength(1);
    expect(log.list()[0].choice).toBe("session");
  });

  it("drops a grant without a session or request id", () => {
    const log = createAccessGrantLog();
    log.record({ sessionId: "  ", requestId: "r1", choice: "once", patternKeys: [] });
    log.record({ sessionId: "s1", requestId: "", choice: "once", patternKeys: [] });
    expect(log.list()).toHaveLength(0);
  });

  it("removes one entry and clears all, notifying subscribers", () => {
    const log = createAccessGrantLog();
    const listener = vi.fn();
    log.subscribe(listener);
    log.record({ sessionId: "s1", requestId: "r1", choice: "once", patternKeys: [] });
    log.record({ sessionId: "s1", requestId: "r2", choice: "once", patternKeys: [] });
    expect(listener).toHaveBeenCalledTimes(2);

    log.remove("s1:r1");
    expect(log.list().map((entry) => entry.id)).toEqual(["s1:r2"]);

    // Removing an unknown id is a no-op (no extra notification).
    const calls = listener.mock.calls.length;
    log.remove("s1:missing");
    expect(listener).toHaveBeenCalledTimes(calls);

    log.clear();
    expect(log.list()).toHaveLength(0);
    expect(localStorage.getItem("june.agent.accessGrants")).toBeNull();
  });

  it("keeps the snapshot identity stable between mutations", () => {
    const log = createAccessGrantLog();
    log.record({ sessionId: "s1", requestId: "r1", choice: "once", patternKeys: [] });
    expect(log.list()).toBe(log.list());
  });

  it("caps the stored history, evicting the oldest entries", () => {
    const log = createAccessGrantLog();
    for (let i = 0; i < ACCESS_GRANT_LOG_CAP + 5; i += 1) {
      log.record({
        sessionId: "s1",
        requestId: `r${i}`,
        choice: "once",
        patternKeys: [],
        grantedAt: i,
      });
    }
    const entries = log.list();
    expect(entries).toHaveLength(ACCESS_GRANT_LOG_CAP);
    // Newest kept, oldest evicted.
    expect(entries[0].requestId).toBe(`r${ACCESS_GRANT_LOG_CAP + 4}`);
    expect(entries.some((entry) => entry.requestId === "r0")).toBe(false);
  });

  it("tolerates malformed stored JSON", () => {
    localStorage.setItem("june.agent.accessGrants", "{not json");
    expect(createAccessGrantLog().list()).toEqual([]);
    localStorage.setItem("june.agent.accessGrants", JSON.stringify([{ id: 1 }, null]));
    expect(createAccessGrantLog().list()).toEqual([]);
  });
});
