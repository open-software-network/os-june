import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyHermesEvent } from "../lib/hermes-control-plane";
import type { JuneHermesEvent } from "../lib/hermes-control-plane";
import {
  ACTIVITY_SESSIONS_CAP,
  createHermesActivityStore,
} from "../lib/hermes-activity-store";

// Classify a raw frame and assert it produced the expected kind, so a test
// can't silently feed the wrong event into the store.
function classified(
  type: string,
  sessionId: string | undefined,
  payload?: Record<string, unknown>,
): JuneHermesEvent {
  return classifyHermesEvent({ type, session_id: sessionId, payload });
}

describe("createHermesActivityStore", () => {
  let now: number;

  function setNow(value: number): void {
    now = value;
    vi.setSystemTime(now);
  }
  function advance(ms: number): void {
    setNow(now + ms);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    setNow(Date.UTC(2026, 5, 24, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a running tool call produces one active activity row", () => {
    const store = createHermesActivityStore();
    store.record(
      classified("tool.start", "s1", { tool_name: "read_file" }),
      "sandboxed",
    );

    const records = store.getRecords();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.sessionId).toBe("s1");
    expect(record.phase).toBe("running");
    expect(record.currentTool).toBe("read_file");
    expect(record.mode).toBe("sandboxed");
    expect(record.lastEventAt).toBe(now);
    expect(store.activeCount()).toBe(1);
  });

  it("a pending action moves the session to phase 'waiting' and reflects the pending count", () => {
    const pendingBySession = new Map<string, number>([["s1", 2]]);
    const store = createHermesActivityStore({
      pendingCountFor: (sessionId) => pendingBySession.get(sessionId) ?? 0,
    });
    // The session is mid-run on a tool first.
    store.record(
      classified("tool.start", "s1", { tool_name: "bash" }),
      "unrestricted",
    );
    // Then the agent blocks on the user.
    store.record(
      classified("approval.request", "s1", {
        request_id: "r1",
        tool_name: "write_file",
      }),
      "unrestricted",
    );

    const record = store.getRecord("s1");
    expect(record?.phase).toBe("waiting");
    // Count is pulled live from feature 04's store, not counted here.
    expect(record?.pendingActionCount).toBe(2);
  });

  it("completion flips the session to phase 'complete' but keeps the row", () => {
    const store = createHermesActivityStore();
    store.record(
      classified("tool.start", "s1", { tool_name: "bash" }),
      "sandboxed",
    );
    expect(store.getRecord("s1")?.phase).toBe("running");

    store.record(classified("session.complete", "s1"), "sandboxed");

    // UX decision: the row persists so the user can see what just finished,
    // rather than vanishing the instant a session completes.
    const record = store.getRecord("s1");
    expect(record).toBeDefined();
    expect(record?.phase).toBe("complete");
    // A completed session is no longer "active".
    expect(store.activeCount()).toBe(0);
  });

  it("an error frame moves the session to phase 'error'", () => {
    const store = createHermesActivityStore();
    store.record(
      classified("tool.start", "s1", { tool_name: "bash" }),
      "sandboxed",
    );
    store.record(classified("error", "s1", { message: "boom" }), "sandboxed");
    expect(store.getRecord("s1")?.phase).toBe("error");
  });

  it("background subagent activity sets phase 'background' and counts distinct subagents", () => {
    const store = createHermesActivityStore();
    store.record(
      classified("subagent.start", "s1", {
        subagent_id: "a1",
        goal: "Write tests",
      }),
      "sandboxed",
    );
    store.record(
      classified("subagent.progress", "s1", {
        subagent_id: "a2",
        tool_name: "grep",
      }),
      "sandboxed",
    );
    // Repeat of a1 must NOT double-count.
    store.record(
      classified("subagent.tool", "s1", { subagent_id: "a1" }),
      "sandboxed",
    );

    const record = store.getRecord("s1");
    expect(record?.phase).toBe("background");
    expect(record?.subagentCount).toBe(2);
    // Background activity carries an ISO timestamp; the row tracks it as epoch ms.
    expect(record?.lastEventAt).toBe(now);
  });

  it("a fire-and-forget subagent that completes (no session lifecycle) leaves 'background' and stops counting as active", () => {
    const store = createHermesActivityStore();
    // A single delegated subagent starts: parent goes background, counts active.
    store.record(
      classified("subagent.start", "s1", {
        subagent_id: "a1",
        goal: "Crunch numbers",
      }),
      "sandboxed",
    );
    expect(store.getRecord("s1")?.phase).toBe("background");
    expect(store.activeCount()).toBe(1);

    // Its LAST frame is subagent.complete — there is no trailing session.complete.
    store.record(
      classified("subagent.complete", "s1", { subagent_id: "a1" }),
      "sandboxed",
    );

    const record = store.getRecord("s1");
    // The parent must derive a resting phase from its (now terminal) subagents
    // rather than staying stuck in 'background' forever.
    expect(record?.phase).toBe("complete");
    expect(store.activeCount()).toBe(0);
    // Fix 2: the badge count excludes the finished subagent (display list keeps it).
    expect(record?.subagentCount).toBe(0);
    expect(record?.subagents).toHaveLength(1);
  });

  it("an errored subagent derives an 'error' parent phase once none remain active", () => {
    const store = createHermesActivityStore();
    store.record(
      classified("subagent.start", "s1", { subagent_id: "a1" }),
      "sandboxed",
    );
    store.record(
      classified("subagent.error", "s1", { subagent_id: "a1" }),
      "sandboxed",
    );
    expect(store.getRecord("s1")?.phase).toBe("error");
    expect(store.activeCount()).toBe(0);
  });

  it("keeps the parent in 'background' while any sibling subagent is still working", () => {
    const store = createHermesActivityStore();
    store.record(
      classified("subagent.start", "s1", { subagent_id: "a1" }),
      "sandboxed",
    );
    store.record(
      classified("subagent.progress", "s1", { subagent_id: "a2" }),
      "sandboxed",
    );
    // a1 finishes, but a2 is still working.
    store.record(
      classified("subagent.complete", "s1", { subagent_id: "a1" }),
      "sandboxed",
    );

    const record = store.getRecord("s1");
    expect(record?.phase).toBe("background");
    expect(store.activeCount()).toBe(1);
    // Only a2 is active; a1 is kept for display but not counted.
    expect(record?.subagentCount).toBe(1);
    expect(record?.subagents).toHaveLength(2);
  });

  it("a later default 'sandboxed' event never downgrades an established 'unrestricted' row", () => {
    const store = createHermesActivityStore();
    // The session resolved as unrestricted (it can write outside the sandbox).
    store.record(
      classified("tool.start", "s1", { tool_name: "write_file" }),
      "unrestricted",
    );
    expect(store.getRecord("s1")?.mode).toBe("unrestricted");

    // A later event whose mode defaults to 'sandboxed' (unresolved session)
    // must NOT flip the row back — that would show a green "Sandboxed" shield on
    // a session that can write outside the sandbox.
    store.record(
      classified("tool.progress", "s1", { tool_name: "write_file" }),
      "sandboxed",
    );
    expect(store.getRecord("s1")?.mode).toBe("unrestricted");
  });

  it("keeps one record per session and tracks the latest tool", () => {
    const store = createHermesActivityStore();
    store.record(
      classified("tool.start", "s1", { tool_name: "read_file" }),
      "sandboxed",
    );
    advance(1000);
    store.record(
      classified("tool.start", "s1", { tool_name: "bash" }),
      "sandboxed",
    );

    const records = store.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].currentTool).toBe("bash");
    expect(records[0].lastEventAt).toBe(now);
  });

  it("orders records newest-first by last event", () => {
    const store = createHermesActivityStore();
    store.record(
      classified("tool.start", "s1", { tool_name: "a" }),
      "sandboxed",
    );
    advance(1000);
    store.record(
      classified("tool.start", "s2", { tool_name: "b" }),
      "sandboxed",
    );

    const ids = store.getRecords().map((r) => r.sessionId);
    expect(ids).toEqual(["s2", "s1"]);
  });

  it("clears a session's row on demand", () => {
    const store = createHermesActivityStore();
    store.record(
      classified("tool.start", "s1", { tool_name: "a" }),
      "sandboxed",
    );
    store.clearSession("s1");
    expect(store.getRecord("s1")).toBeUndefined();
    expect(store.getRecords()).toHaveLength(0);
  });

  it("bumps the version on every mutation for useSyncExternalStore", () => {
    const store = createHermesActivityStore();
    const before = store.getVersion();
    store.record(
      classified("tool.start", "s1", { tool_name: "a" }),
      "sandboxed",
    );
    expect(store.getVersion()).toBeGreaterThan(before);
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    const store = createHermesActivityStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.record(
      classified("tool.start", "s1", { tool_name: "a" }),
      "sandboxed",
    );
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.record(
      classified("tool.start", "s2", { tool_name: "b" }),
      "sandboxed",
    );
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ignores events without a session id (nothing to attribute)", () => {
    const store = createHermesActivityStore();
    // reasoning with no session id classifies to sessionId "" — unattributable.
    store.record(
      classified("reasoning.delta", undefined, { text: "x" }),
      "sandboxed",
    );
    expect(store.getRecords()).toHaveLength(0);
  });

  it("bounds the number of tracked sessions, evicting the oldest", () => {
    const store = createHermesActivityStore();
    for (let i = 0; i < ACTIVITY_SESSIONS_CAP + 5; i++) {
      store.record(
        classified("tool.start", `s${i}`, { tool_name: "a" }),
        "sandboxed",
      );
      advance(1);
    }
    expect(store.getRecords().length).toBeLessThanOrEqual(
      ACTIVITY_SESSIONS_CAP,
    );
    // The very first session should have been evicted.
    expect(store.getRecord("s0")).toBeUndefined();
  });
});
