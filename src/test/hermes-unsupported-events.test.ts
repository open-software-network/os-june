import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyHermesEvent } from "../lib/hermes-control-plane";
import {
  UNSUPPORTED_EVENTS_PER_SESSION_CAP,
  createUnsupportedEventStore,
} from "../lib/hermes-unsupported-events";

// A raw gateway frame whose `type` the classifier doesn't model yet → it
// classifies as `{ kind: "unsupported" }`, which is the store's only input.
function unsupportedClassified(
  type: string,
  sessionId: string | undefined,
  payload?: unknown,
) {
  const event = classifyHermesEvent({
    type,
    session_id: sessionId,
    payload,
  });
  if (event.kind !== "unsupported") {
    throw new Error(`expected unsupported, got ${event.kind} for ${type}`);
  }
  return event;
}

describe("createUnsupportedEventStore", () => {
  let now: number;

  // Fake timers drive both Date.now() and `new Date().toISOString()` (which the
  // store uses for timestamps) deterministically, without re-entrant spying.
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

  it("records an unsupported event into the bounded buffer for its session", () => {
    const store = createUnsupportedEventStore();
    store.record(
      unsupportedClassified("future.kind", "s1", { hello: "world" }),
    );

    const records = store.recordsFor("s1");
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe("future.kind");
    expect(records[0].sessionId).toBe("s1");
    expect(records[0].observedAt).toBe(new Date(now).toISOString());
    expect(records[0].observedAt).toBe("2026-06-24T12:00:00.000Z");
  });

  it("drops the oldest distinct entry once the per-session cap is exceeded", () => {
    const store = createUnsupportedEventStore();
    // One more distinct type than the cap; each distinct type is its own entry.
    for (let i = 0; i < UNSUPPORTED_EVENTS_PER_SESSION_CAP + 1; i += 1) {
      store.record(unsupportedClassified(`future.kind.${i}`, "s1"));
    }
    const records = store.recordsFor("s1");
    expect(records).toHaveLength(UNSUPPORTED_EVENTS_PER_SESSION_CAP);
    const types = records.map((r) => r.type);
    // The very first type was evicted; the last one survives.
    expect(types).not.toContain("future.kind.0");
    expect(types).toContain(
      `future.kind.${UNSUPPORTED_EVENTS_PER_SESSION_CAP}`,
    );
  });

  it("keeps each session's buffer independent and bounded", () => {
    const store = createUnsupportedEventStore();
    store.record(unsupportedClassified("future.a", "s1"));
    store.record(unsupportedClassified("future.b", "s2"));
    expect(store.recordsFor("s1")).toHaveLength(1);
    expect(store.recordsFor("s2")).toHaveLength(1);
    expect(store.recordsFor("s1")[0].type).toBe("future.a");
  });

  it("aggregates repeated identical types instead of spamming new entries", () => {
    const store = createUnsupportedEventStore();
    store.record(unsupportedClassified("future.repeat", "s1"));
    advance(1000);
    store.record(unsupportedClassified("future.repeat", "s1"));
    advance(1000);
    store.record(unsupportedClassified("future.repeat", "s1"));

    const entries = store.entriesFor("s1");
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(3);
    expect(entries[0].type).toBe("future.repeat");
    // lastSeen tracks the most recent occurrence.
    expect(entries[0].lastSeen).toBe(new Date(now).toISOString());
  });

  it("surfaces an active-session notice only for the matching session", () => {
    const store = createUnsupportedEventStore();
    store.record(unsupportedClassified("future.kind", "s1"));

    expect(store.activeNotice("s1")?.sessionId).toBe("s1");
    expect(store.activeNotice("s2")).toBeUndefined();
    expect(store.activeNotice(undefined)).toBeUndefined();
  });

  it("notifies subscribers when a record is added", () => {
    const store = createUnsupportedEventStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.record(unsupportedClassified("future.kind", "s1"));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.record(unsupportedClassified("future.kind.2", "s1"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  describe("exported records are safe for issue reports", () => {
    it("redacts secret-like keys and never includes a raw payload preview", () => {
      const store = createUnsupportedEventStore();
      store.record(
        unsupportedClassified("future.secretful", "s1", {
          api_key: "sk-abcdef0123456789abcdef0123456789",
          authorization: "Bearer abcdef0123456789abcdef0123456789",
          note: "safe-text",
          nested: { password: "hunter2", ok: "fine" },
        }),
      );

      const record = store.recordsFor("s1")[0];
      // Keys are visible (useful triage signal) ...
      expect(record.payloadKeys).toEqual(
        expect.arrayContaining(["api_key", "authorization", "note", "nested"]),
      );
      // ... but no secret value survives anywhere in the export.
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain("sk-abcdef0123456789abcdef0123456789");
      expect(serialized).not.toContain("hunter2");
      expect(serialized).toContain("[redacted]");
      // Safe text is preserved in the preview.
      expect(record.payloadPreview).toContain("safe-text");
    });

    it("toRecords() flattens every session into one safe array", () => {
      const store = createUnsupportedEventStore();
      store.record(unsupportedClassified("future.a", "s1"));
      store.record(unsupportedClassified("future.b", "s2"));
      const all = store.toRecords();
      expect(all).toHaveLength(2);
      expect(all.map((r) => r.type).sort()).toEqual(["future.a", "future.b"]);
    });
  });

  it("does not throw on an unsupported event with no session or payload", () => {
    const store = createUnsupportedEventStore();
    expect(() =>
      store.record(unsupportedClassified("future.kind", undefined)),
    ).not.toThrow();
    // Session-less events are retained under a stable bucket and excluded from
    // any active-session notice.
    expect(store.toRecords()).toHaveLength(1);
    expect(store.activeNotice(undefined)).toBeUndefined();
  });
});
