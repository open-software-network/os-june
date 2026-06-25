import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRACE_ENTRIES_PER_SESSION_CAP,
  createHermesTraceBuffer,
} from "../lib/hermes-trace-buffer";

// A raw gateway frame the buffer ingests. The buffer classifies it itself (it
// owns the raw->normalized pairing), so tests pass raw frames, not classified
// events.
function rawFrame(
  type: string,
  sessionId: string | undefined,
  payload?: unknown,
) {
  return { type, session_id: sessionId, payload };
}

describe("createHermesTraceBuffer", () => {
  let now: number;

  // Fake timers drive `new Date().toISOString()` deterministically, matching
  // the unsupported-events store's test approach.
  function setNow(value: number): void {
    now = value;
    vi.setSystemTime(now);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    setNow(Date.UTC(2026, 5, 24, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records an inbound frame with its raw type and normalized kind", () => {
    const buffer = createHermesTraceBuffer();
    buffer.recordInbound(rawFrame("message.delta", "s1", { delta: "hi" }));

    const entries = buffer.entriesFor("s1");
    expect(entries).toHaveLength(1);
    expect(entries[0].direction).toBe("inbound");
    expect(entries[0].rawType).toBe("message.delta");
    expect(entries[0].normalizedKind).toBe("transcript");
    expect(entries[0].sessionId).toBe("s1");
    expect(entries[0].observedAt).toBe("2026-06-24T12:00:00.000Z");
  });

  it("records an outbound method call with its method name and sanitized params", () => {
    const buffer = createHermesTraceBuffer();
    buffer.recordOutbound({
      sessionId: "s1",
      method: "session.steer",
      params: { session_id: "s1", text: "focus on tests" },
    });

    const entries = buffer.entriesFor("s1");
    expect(entries).toHaveLength(1);
    expect(entries[0].direction).toBe("outbound");
    expect(entries[0].method).toBe("session.steer");
    expect(entries[0].payloadKeys).toEqual(
      expect.arrayContaining(["session_id", "text"]),
    );
  });

  it("records an error/rejection entry", () => {
    const buffer = createHermesTraceBuffer();
    buffer.recordError({
      sessionId: "s1",
      method: "session.steer",
      message: "Hermes request timed out: session.steer",
    });

    const entries = buffer.entriesFor("s1");
    expect(entries).toHaveLength(1);
    expect(entries[0].direction).toBe("error");
    expect(entries[0].message).toBe("Hermes request timed out: session.steer");
  });

  it("drops the oldest entry once the per-session cap is exceeded", () => {
    const buffer = createHermesTraceBuffer();
    for (let i = 0; i < TRACE_ENTRIES_PER_SESSION_CAP + 5; i += 1) {
      buffer.recordInbound(rawFrame("message.delta", "s1", { n: i }));
    }
    const entries = buffer.entriesFor("s1");
    expect(entries).toHaveLength(TRACE_ENTRIES_PER_SESSION_CAP);
    // Oldest (n: 0..4) dropped; newest survives. The buffer keeps full payloads
    // sanitized, so we can read the marker back out of the preview.
    expect(entries[0].payloadPreview).not.toContain('"n": 0');
    expect(entries[entries.length - 1].payloadPreview).toContain(
      `"n": ${TRACE_ENTRIES_PER_SESSION_CAP + 4}`,
    );
  });

  it("keeps each session's buffer independent and bounded", () => {
    const buffer = createHermesTraceBuffer();
    buffer.recordInbound(rawFrame("message.delta", "s1"));
    buffer.recordInbound(rawFrame("tool.start", "s2"));
    expect(buffer.entriesFor("s1")).toHaveLength(1);
    expect(buffer.entriesFor("s2")).toHaveLength(1);
    expect(buffer.entriesFor("s1")[0].rawType).toBe("message.delta");
  });

  it("notifies subscribers and bumps the version on every mutation", () => {
    const buffer = createHermesTraceBuffer();
    const listener = vi.fn();
    const startVersion = buffer.getVersion();
    const unsubscribe = buffer.subscribe(listener);

    buffer.recordInbound(rawFrame("message.delta", "s1"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(buffer.getVersion()).toBe(startVersion + 1);

    unsubscribe();
    buffer.recordInbound(rawFrame("message.delta", "s1"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("lists session ids that have entries, for the panel's session filter", () => {
    const buffer = createHermesTraceBuffer();
    buffer.recordInbound(rawFrame("message.delta", "s1"));
    buffer.recordOutbound({ sessionId: "s2", method: "session.steer" });
    expect(buffer.sessionIds().sort()).toEqual(["s1", "s2"]);
  });

  describe("redaction", () => {
    it("redacts secret request VALUES in outbound params but keeps keys", () => {
      const buffer = createHermesTraceBuffer();
      buffer.recordOutbound({
        sessionId: "s1",
        method: "secret.respond",
        params: {
          session_id: "s1",
          request_id: "r1",
          value: "sk-abcdef0123456789abcdef0123456789",
        },
      });

      const entry = buffer.entriesFor("s1")[0];
      // The param key is a useful triage signal ...
      expect(entry.payloadKeys).toContain("value");
      // ... but the secret value never survives anywhere in the entry.
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain("sk-abcdef0123456789abcdef0123456789");
    });

    it("redacts a SHORT secret/OTP value under `value` (key-based, not value-shape)", () => {
      const buffer = createHermesTraceBuffer();
      buffer.recordOutbound({
        sessionId: "s1",
        method: "secret.respond",
        params: {
          session_id: "s1",
          request_id: "r1",
          // A 4-digit code is too short for the value heuristic; only key-based
          // redaction catches it. It must not leak in cleartext.
          value: "1234",
        },
      });

      const entry = buffer.entriesFor("s1")[0];
      expect(entry.payloadKeys).toContain("value");
      const serialized = JSON.stringify(entry);
      // The literal short secret must not survive; the key is replaced with the
      // redaction marker instead.
      expect(serialized).toContain("[redacted]");
      expect(serialized).not.toContain('"value":"1234"');
    });

    it("redacts authorization headers and api keys in inbound payloads", () => {
      const buffer = createHermesTraceBuffer();
      buffer.recordInbound(
        rawFrame("future.unknown", "s1", {
          headers: {
            authorization: "Bearer abcdef0123456789abcdef0123456789",
          },
          api_key: "sk-abcdef0123456789abcdef0123456789",
          note: "safe-text",
        }),
      );

      const entry = buffer.entriesFor("s1")[0];
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(
        "Bearer abcdef0123456789abcdef0123456789",
      );
      expect(serialized).not.toContain("sk-abcdef0123456789abcdef0123456789");
      expect(serialized).toContain("[redacted]");
      // Safe text is preserved.
      expect(entry.payloadPreview).toContain("safe-text");
    });
  });

  describe("exportSanitizedTrace", () => {
    it("includes raw type AND normalized kind but NO secret values", () => {
      const buffer = createHermesTraceBuffer();
      buffer.recordInbound(
        rawFrame("future.unknown", "s1", {
          api_key: "sk-abcdef0123456789abcdef0123456789",
          note: "safe-text",
        }),
      );
      buffer.recordOutbound({
        sessionId: "s1",
        method: "secret.respond",
        params: { value: "sk-supersecretsupersecretsupersecret" },
      });

      const bundle = buffer.exportSanitizedTrace("s1");
      expect(bundle.sessionId).toBe("s1");
      expect(bundle.entries).toHaveLength(2);
      // The export carries both the raw wire type and the normalized kind for
      // the inbound frame — that's the whole point of the trace.
      const inbound = bundle.entries.find((e) => e.direction === "inbound");
      expect(inbound?.rawType).toBe("future.unknown");
      expect(inbound?.normalizedKind).toBe("unsupported");

      const serialized = JSON.stringify(bundle);
      expect(serialized).not.toContain("sk-abcdef0123456789abcdef0123456789");
      expect(serialized).not.toContain("sk-supersecretsupersecretsupersecret");
      expect(serialized).toContain("safe-text");
    });

    it("scopes the export to one session and is JSON-serializable", () => {
      const buffer = createHermesTraceBuffer();
      buffer.recordInbound(rawFrame("message.delta", "s1"));
      buffer.recordInbound(rawFrame("tool.start", "s2"));

      const bundle = buffer.exportSanitizedTrace("s1");
      expect(bundle.entries).toHaveLength(1);
      expect(bundle.entries[0].sessionId).toBe("s1");
      // Round-trips cleanly (no functions, no circular refs).
      expect(() => JSON.parse(JSON.stringify(bundle))).not.toThrow();
    });
  });
});
