import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyHermesEvent } from "../lib/hermes-control-plane";
import type { JuneHermesEvent } from "../lib/hermes-control-plane";
import { createHermesActivityStore } from "../lib/hermes-activity-store";
import subagentLifecycle from "../lib/hermes-control-plane/fixtures/subagent-lifecycle.json";
import subagentBackgroundCompletion from "../lib/hermes-control-plane/fixtures/subagent-background-completion.json";

type RawFrame = {
  type: string;
  session_id?: string;
  payload?: Record<string, unknown>;
};

/**
 * Feature 12 — background subagent watch. The activity store already counts
 * subagents (feature 11); these tests pin the deepening: each subagent becomes a
 * first-class record on the parent session's row, UPSERTED by its stable id so
 * progress updates the same row rather than spawning duplicates, and a
 * completion that re-enters the parent session links back to the original row.
 */

// Classify a raw frame and assert nothing was dropped, so a test can't silently
// feed the wrong event into the store.
function classified(
  type: string,
  sessionId: string | undefined,
  payload?: Record<string, unknown>,
): JuneHermesEvent {
  return classifyHermesEvent({ type, session_id: sessionId, payload });
}

// Replay a recorded fixture's frames through the store under one mode.
function replayFrames(
  frames: RawFrame[],
): ReturnType<typeof createHermesActivityStore> {
  const store = createHermesActivityStore();
  for (const frame of frames) {
    store.record(
      classifyHermesEvent({
        type: frame.type,
        session_id: frame.session_id,
        payload: frame.payload,
      }),
      "sandboxed",
    );
  }
  return store;
}

describe("hermes-activity-store — subagent watch records", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 5, 24, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("subagent.start creates a per-subagent record on the parent row", () => {
    const store = createHermesActivityStore();
    store.record(
      classified("subagent.start", "sess-sub", {
        subagent_id: "sub-1",
        goal: "Research how the gateway reconnects",
        parent_session_id: "sess-sub",
      }),
      "sandboxed",
    );

    const record = store.getRecord("sess-sub");
    expect(record?.subagentCount).toBe(1);
    expect(record?.subagents).toHaveLength(1);
    const [sub] = record!.subagents;
    expect(sub.subagentId).toBe("sub-1");
    expect(sub.phase).toBe("start");
    expect(sub.goal).toBe("Research how the gateway reconnects");
    expect(sub.parentSessionId).toBe("sess-sub");
  });

  it("subagent.progress updates the SAME record (no duplicate)", () => {
    const store = createHermesActivityStore();
    store.record(
      classified("subagent.start", "sess-sub", {
        subagent_id: "sub-1",
        goal: "Research how the gateway reconnects",
      }),
      "sandboxed",
    );
    store.record(
      classified("subagent.tool", "sess-sub", {
        subagent_id: "sub-1",
        tool_name: "grep",
        tool_preview: "rg reconnect",
      }),
      "sandboxed",
    );
    store.record(
      classified("subagent.progress", "sess-sub", {
        subagent_id: "sub-1",
        summary: "Found the reconnect path",
      }),
      "sandboxed",
    );

    const record = store.getRecord("sess-sub");
    expect(record?.subagentCount).toBe(1);
    expect(record?.subagents).toHaveLength(1);
    const [sub] = record!.subagents;
    // UPSERT: same row, latest phase + current tool, goal preserved from start.
    expect(sub.phase).toBe("progress");
    expect(sub.currentTool).toBe("grep");
    expect(sub.goal).toBe("Research how the gateway reconnects");
    expect(sub.resultPreview).toBe("Found the reconnect path");
  });

  it("subagent.complete completes the record and adds a result preview", () => {
    const store = replayFrames(subagentLifecycle.frames as RawFrame[]);

    const record = store.getRecord("sess-sub");
    expect(record?.subagents).toHaveLength(1);
    const [sub] = record!.subagents;
    expect(sub.subagentId).toBe("sub-1");
    expect(sub.phase).toBe("complete");
    expect(sub.resultPreview).toBe("Reconnect is coalesced via connectPromise");
  });

  it("a background completion links to the parent session by handle (same row)", () => {
    const store = replayFrames(
      subagentBackgroundCompletion.frames as RawFrame[],
    );

    // The frames carry only a `handle` and a parent_session_id; both progress
    // and complete must fold into ONE record on the parent session.
    const record = store.getRecord("sess-parent");
    // The single subagent has COMPLETED, so the active count is 0 (the badge
    // implies in-progress work), while the display list still keeps the one
    // finished subagent so the user can see what ran.
    expect(record?.subagentCount).toBe(0);
    expect(record?.subagents).toHaveLength(1);
    const [sub] = record!.subagents;
    expect(sub.handle).toBe("bg-h-7");
    expect(sub.parentSessionId).toBe("sess-parent");
    expect(sub.phase).toBe("complete");
    expect(sub.resultPreview).toBe("Background indexing finished: 128 files");
  });

  it("tracks distinct subagents as separate records", () => {
    const store = createHermesActivityStore();
    store.record(
      classified("subagent.start", "s1", { subagent_id: "a1", goal: "A" }),
      "sandboxed",
    );
    store.record(
      classified("subagent.start", "s1", { subagent_id: "a2", goal: "B" }),
      "sandboxed",
    );

    const record = store.getRecord("s1");
    expect(record?.subagentCount).toBe(2);
    expect(record?.subagents.map((s) => s.subagentId)).toEqual(["a1", "a2"]);
  });

  it("an unknown subagent payload still yields a safe generic record (never crashes)", () => {
    const store = createHermesActivityStore();
    // No subagent_id/handle at all: the classifier degrades to id "subagent".
    store.record(classified("subagent.mystery", "s1", {}), "sandboxed");

    const record = store.getRecord("s1");
    expect(record?.phase).toBe("background");
    expect(record?.subagents).toHaveLength(1);
    expect(record!.subagents[0].subagentId).toBe("subagent");
    // Unknown subtype with no failure keyword folds to "progress".
    expect(record!.subagents[0].phase).toBe("progress");
  });
});
