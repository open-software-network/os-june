import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_GRANT_LOG_CAP,
  approvalPatternKeys,
  createAccessGrantLog,
  redactGrantText,
} from "../lib/access-grant-log";

beforeEach(() => {
  localStorage.clear();
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

describe("access grant log — free-text redaction", () => {
  it("masks bearer tokens, credential key pairs, and secret-shaped runs", () => {
    expect(redactGrantText('curl -H "Authorization: Bearer sk-abc123"')).not.toContain("sk-abc123");
    expect(redactGrantText("OPENAI_API_KEY=sk-live-123 python train.py")).toBe(
      "OPENAI_API_KEY=[redacted] python train.py",
    );
    const longSecret = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
    expect(redactGrantText(`deploy --auth ${longSecret}`)).toBe("deploy --auth [redacted]");
  });

  it("masks the whole Authorization value for any scheme, not just Bearer", () => {
    // A short Basic credential misses the 32-char run heuristic; the header
    // rule must catch the scheme AND the credential.
    const basic = redactGrantText("curl -H 'Authorization: Basic dXNlcjpwYXNz' https://api.test");
    expect(basic).not.toContain("dXNlcjpwYXNz");
    expect(basic).toContain("https://api.test");
    const token = redactGrantText('curl -H "Authorization: Token shorttok" -o out.json');
    expect(token).not.toContain("shorttok");
    expect(token).toContain("-o out.json");
    // An unknown single-token value is redacted whole without eating the
    // following argument.
    const opaque = redactGrantText("curl -H 'Authorization: opaque123' -o out.json");
    expect(opaque).not.toContain("opaque123");
    expect(opaque).toContain("-o out.json");
  });

  it("leaves ordinary commands and paths intact", () => {
    expect(redactGrantText("rm -rf build")).toBe("rm -rf build");
    expect(
      redactGrantText("cp /Users/me/a-very-long-path-name-over-32-characters/file.txt ."),
    ).toContain("a-very-long-path-name-over-32-characters");
    expect(redactGrantText(undefined)).toBeUndefined();
  });

  it("scrubs at record time so secrets never reach storage", () => {
    const log = createAccessGrantLog();
    log.record({
      sessionId: "s1",
      requestId: "r1",
      command: "curl -H 'Authorization: Bearer sk-secret-token-value'",
      patternKeys: [],
    });
    expect(log.list()[0].command).not.toContain("sk-secret-token-value");
    expect(localStorage.getItem("june.agent.accessGrants")).not.toContain("sk-secret-token-value");
  });
});

describe("access grant log — record/list", () => {
  it("records a grant, lists newest first, and notifies subscribers", () => {
    const log = createAccessGrantLog();
    const listener = vi.fn();
    log.subscribe(listener);
    log.record({
      sessionId: "s1",
      requestId: "r1",
      command: "rm -rf build",
      description: "Recursive deletion (rm -rf)",
      patternKeys: ["Recursive deletion (rm -rf)"],
      grantedAt: 100,
    });
    log.record({
      sessionId: "s1",
      requestId: "r2",
      command: "git push --force",
      patternKeys: [],
      grantedAt: 200,
    });

    const entries = log.list();
    expect(entries.map((entry) => entry.requestId)).toEqual(["r2", "r1"]);
    expect(entries[1].command).toBe("rm -rf build");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("persists to localStorage and reloads in a fresh instance", () => {
    const log = createAccessGrantLog();
    log.record({
      sessionId: "s1",
      requestId: "r1",
      patternKeys: ["Curl piped to shell"],
      grantedAt: 100,
    });

    const fresh = createAccessGrantLog();
    expect(fresh.list()).toHaveLength(1);
    expect(fresh.list()[0].patternKeys).toEqual(["Curl piped to shell"]);
  });

  it("replaces a re-record of the same session + request", () => {
    const log = createAccessGrantLog();
    log.record({ sessionId: "s1", requestId: "r1", command: "sudo ls", patternKeys: [] });
    log.record({ sessionId: "s1", requestId: "r1", command: "sudo id", patternKeys: [] });
    expect(log.list()).toHaveLength(1);
    expect(log.list()[0].command).toBe("sudo id");
  });

  it("drops a grant without a session or request id", () => {
    const log = createAccessGrantLog();
    log.record({ sessionId: "  ", requestId: "r1", patternKeys: [] });
    log.record({ sessionId: "s1", requestId: "", patternKeys: [] });
    expect(log.list()).toHaveLength(0);
  });

  it("keeps the snapshot identity stable between mutations", () => {
    const log = createAccessGrantLog();
    log.record({ sessionId: "s1", requestId: "r1", patternKeys: [] });
    expect(log.list()).toBe(log.list());
  });

  it("caps the stored history, evicting the oldest entries", () => {
    const log = createAccessGrantLog();
    for (let i = 0; i < ACCESS_GRANT_LOG_CAP + 5; i += 1) {
      log.record({
        sessionId: "s1",
        requestId: `r${i}`,
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

  it("ignores legacy session-scoped entries left over from the older page", () => {
    // Before the page narrowed to persistent grants, "once" and "session"
    // approvals were logged too (with a `choice` field). They describe grants
    // that expired on their own; only "always" entries still mean anything.
    localStorage.setItem(
      "june.agent.accessGrants",
      JSON.stringify([
        {
          id: "s1:r1",
          sessionId: "s1",
          requestId: "r1",
          choice: "once",
          patternKeys: [],
          grantedAt: 1,
        },
        {
          id: "s1:r2",
          sessionId: "s1",
          requestId: "r2",
          choice: "session",
          patternKeys: [],
          grantedAt: 2,
        },
        {
          id: "s1:r3",
          sessionId: "s1",
          requestId: "r3",
          choice: "always",
          patternKeys: ["Sudo"],
          grantedAt: 3,
        },
      ]),
    );
    const entries = createAccessGrantLog().list();
    expect(entries.map((entry) => entry.requestId)).toEqual(["r3"]);
  });

  it("tolerates malformed stored JSON", () => {
    localStorage.setItem("june.agent.accessGrants", "{not json");
    expect(createAccessGrantLog().list()).toEqual([]);
    localStorage.setItem("june.agent.accessGrants", JSON.stringify([{ id: 1 }, null]));
    expect(createAccessGrantLog().list()).toEqual([]);
  });
});
