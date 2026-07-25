import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheSnapshotFromRaw,
  clearTurnDiagnostics,
  computeTurnDiagnostics,
  formatTurnDiagnostics,
  getTurnDiagnostics,
  getTurnDiagnosticsVersion,
  publishTurnDiagnostics,
  snapshotFromRawUsage,
  subscribeTurnDiagnostics,
  type TurnDiagnostics,
  type TurnTimingState,
  type TurnUsageSnapshot,
} from "../lib/turn-diagnostics";

const finalizedAt = "2026-07-24T12:00:00.000Z";

function diagnostics(overrides: Partial<TurnDiagnostics> = {}): TurnDiagnostics {
  return {
    totalDurationMs: 6_500,
    ttftMs: 1_200,
    responseSpanMs: 4_800,
    tailMs: 500,
    finalizedAt,
    ...overrides,
  };
}

describe("computeTurnDiagnostics", () => {
  it("computes normal timing and token deltas", () => {
    const timing: TurnTimingState = {
      startAt: 1_000,
      firstTokenAt: 2_200,
      lastMessageCompleteAt: 7_000,
      terminalAt: 7_500,
    };
    const usageBefore: TurnUsageSnapshot = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    };
    const usageAfter: TurnUsageSnapshot = {
      promptTokens: 16_000,
      completionTokens: 61,
      totalTokens: 16_061,
      cacheReadTokens: 20,
      cacheWriteTokens: 8,
      model: "test-model",
      provider: "test-provider",
    };

    const result = computeTurnDiagnostics(timing, usageBefore, usageAfter);

    expect(result).toBeDefined();
    expect(result).toMatchObject({
      totalDurationMs: 6_500,
      ttftMs: 1_200,
      responseSpanMs: 4_800,
      tailMs: 500,
      outputTokens: 11,
      inputTokens: 15_900,
      totalTokens: 15_911,
      cacheReadTokens: 10,
      cacheWriteTokens: 3,
      model: "test-model",
      provider: "test-provider",
    });
    expect(result?.responseSpanTokensPerSecond).toBeCloseTo(11 / 4.8);
    expect(typeof result?.finalizedAt).toBe("string");
    expect(new Date(result?.finalizedAt ?? "").toISOString()).toBe(result?.finalizedAt);
  });

  it("returns undefined when terminalAt is missing", () => {
    expect(computeTurnDiagnostics({ startAt: 1_000 }, {}, {})).toBeUndefined();
  });

  it("returns undefined for zero duration", () => {
    expect(computeTurnDiagnostics({ startAt: 1_000, terminalAt: 1_000 }, {}, {})).toBeUndefined();
  });

  it("returns undefined for negative duration", () => {
    expect(computeTurnDiagnostics({ startAt: 1_000, terminalAt: 999 }, {}, {})).toBeUndefined();
  });

  it("falls back to terminal when first token and completion are missing", () => {
    expect(computeTurnDiagnostics({ startAt: 1_000, terminalAt: 2_500 }, {}, {})).toMatchObject({
      totalDurationMs: 1_500,
      ttftMs: 1_500,
      responseSpanMs: 0,
      tailMs: 0,
    });
  });

  it("clamps out-of-order boundaries to zero", () => {
    const result = computeTurnDiagnostics(
      {
        startAt: 1_000,
        firstTokenAt: 3_500,
        lastMessageCompleteAt: 3_000,
        terminalAt: 3_200,
      },
      {},
      {},
    );

    expect(result?.responseSpanMs).toBe(0);
    expect(result?.tailMs).toBe(200);

    const firstTokenAfterTerminal = computeTurnDiagnostics(
      { startAt: 1_000, firstTokenAt: 3_500, terminalAt: 3_200 },
      {},
      {},
    );
    expect(firstTokenAfterTerminal?.responseSpanMs).toBe(0);
    expect(firstTokenAfterTerminal?.tailMs).toBe(0);
  });

  it("leaves all token deltas undefined when the whole baseline is missing", () => {
    const result = computeTurnDiagnostics(
      { startAt: 1_000, firstTokenAt: 1_500, lastMessageCompleteAt: 2_000, terminalAt: 2_100 },
      undefined,
      {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      },
    );

    expect(result).toMatchObject({
      outputTokens: undefined,
      inputTokens: undefined,
      totalTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      responseSpanTokensPerSecond: undefined,
    });
  });

  it("computes only fields present in both partial snapshots", () => {
    const result = computeTurnDiagnostics(
      { startAt: 1_000, firstTokenAt: 1_500, lastMessageCompleteAt: 2_000, terminalAt: 2_100 },
      { completionTokens: 50 },
      { completionTokens: 61, promptTokens: 100 },
    );

    expect(result).toMatchObject({
      outputTokens: 11,
      inputTokens: undefined,
      totalTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    });
  });

  it("clamps negative token movement to zero", () => {
    const result = computeTurnDiagnostics(
      { startAt: 1_000, terminalAt: 2_000 },
      { completionTokens: 100 },
      { completionTokens: 50 },
    );
    expect(result?.outputTokens).toBe(0);
  });

  it("leaves throughput undefined for a zero response span", () => {
    const result = computeTurnDiagnostics(
      {
        startAt: 1_000,
        firstTokenAt: 1_500,
        lastMessageCompleteAt: 1_500,
        terminalAt: 2_000,
      },
      { completionTokens: 10 },
      { completionTokens: 20 },
    );
    expect(result?.responseSpanTokensPerSecond).toBeUndefined();
  });
});

describe("cacheSnapshotFromRaw", () => {
  it("reads nested usage snake_case fields", () => {
    expect(
      cacheSnapshotFromRaw({
        usage: { cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
      }),
    ).toEqual({ cacheReadTokens: 100, cacheWriteTokens: 50 });
  });

  it("reads nested tokens camelCase fields", () => {
    expect(
      cacheSnapshotFromRaw({ tokens: { cacheReadTokens: 200, cacheWriteTokens: 75 } }),
    ).toEqual({ cacheReadTokens: 200, cacheWriteTokens: 75 });
  });

  it("reads root-level aliases", () => {
    expect(cacheSnapshotFromRaw({ cache_read_tokens: 300, cache_write_tokens: 90 })).toEqual({
      cacheReadTokens: 300,
      cacheWriteTokens: 90,
    });
  });

  it("leaves the absent cache side undefined", () => {
    expect(cacheSnapshotFromRaw({ usage: { cache_read_input_tokens: 100 } })).toEqual({
      cacheReadTokens: 100,
      cacheWriteTokens: undefined,
    });
  });

  it.each([
    ["null input", null],
    ["array input", [1, 2, 3]],
    ["string input", "hello"],
    ["malformed nested object", { usage: "not-an-object" }],
  ])("returns empty values for %s", (_label, raw) => {
    expect(cacheSnapshotFromRaw(raw)).toEqual({});
  });

  it("ignores NaN and infinities", () => {
    expect(cacheSnapshotFromRaw({ cache_read_tokens: Number.NaN })).toEqual({
      cacheReadTokens: undefined,
    });
    expect(cacheSnapshotFromRaw({ cache_read_tokens: Number.POSITIVE_INFINITY })).toEqual({
      cacheReadTokens: undefined,
    });
  });
});

describe("snapshotFromRawUsage", () => {
  it("parses a full payload", () => {
    expect(
      snapshotFromRawUsage("test-full", {
        model: "test-model",
        provider: "test-provider",
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      }),
    ).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      model: "test-model",
      provider: "test-provider",
    });
  });

  it("returns an empty snapshot for an empty object", () => {
    expect(snapshotFromRawUsage("test-empty", {})).toEqual({});
  });

  it("returns an empty snapshot for null", () => {
    expect(snapshotFromRawUsage("test-null", null)).toEqual({});
  });
});

describe("formatTurnDiagnostics", () => {
  it("produces timing-only output when all token fields are undefined", () => {
    const output = formatTurnDiagnostics(diagnostics());

    expect(output).toContain("turn");
    expect(output).toContain("TTFT");
    expect(output).toContain("stream");
    expect(output).toContain("tail");
    expect(output).not.toContain("response avg");
    expect(output).not.toContain("out ");
    expect(output).not.toContain("in ");
    expect(output).not.toContain("cache");
    expect(output).not.toContain("total");
    expect(output).not.toMatch(/ · $/);
  });

  it("formats full data", () => {
    const output = formatTurnDiagnostics(
      diagnostics({
        outputTokens: 11,
        inputTokens: 15_900,
        totalTokens: 15_911,
        cacheReadTokens: 10,
        cacheWriteTokens: 3,
        responseSpanTokensPerSecond: 2.3,
        model: "test-model",
        provider: "test-provider",
      }),
    );

    expect(output).toContain("response avg");
    expect(output).toContain("out 11");
    expect(output).toContain("in 15,900");
    expect(output).toContain("cache r/w 10/3");
    expect(output).toContain("total 15,911");
    expect(output).toContain("test-model");
  });

  it("formats a missing cache side as a question mark", () => {
    expect(formatTurnDiagnostics(diagnostics({ cacheWriteTokens: 5 }))).toContain("cache r/w ?/5");
  });

  it("uses the response avg label", () => {
    expect(formatTurnDiagnostics(diagnostics({ responseSpanTokensPerSecond: 2.3 }))).toContain(
      "response avg 2.3 tok/s",
    );
  });

  it("omits the model when absent", () => {
    const output = formatTurnDiagnostics(diagnostics({ model: undefined }));
    expect(output).toBe("turn 6.5s · TTFT 1.2s · stream 4.8s · tail 0.5s");
  });

  it("formats milliseconds and seconds", () => {
    expect(formatTurnDiagnostics(diagnostics({ ttftMs: 50 }))).toContain("TTFT 50ms");
    expect(formatTurnDiagnostics(diagnostics({ ttftMs: 1_500 }))).toContain("TTFT 1.5s");
  });
});

describe("turn diagnostics store lifecycle", () => {
  const sessionIds = [
    "test-session-initial",
    "test-session-publish",
    "test-session-overwrite",
    "session-a",
    "session-b",
    "test-session-clear",
    "test-session-absent",
    "test-session-unsubscribe",
  ];

  beforeEach(() => {
    for (const sessionId of sessionIds) clearTurnDiagnostics(sessionId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initial get returns undefined", () => {
    expect(getTurnDiagnostics("test-session-initial")).toBeUndefined();
  });

  it("publish stores data and increments version", () => {
    const value = diagnostics();
    const before = getTurnDiagnosticsVersion();

    publishTurnDiagnostics("test-session-publish", value);

    expect(getTurnDiagnosticsVersion()).toBeGreaterThan(before);
    expect(getTurnDiagnostics("test-session-publish")).toBe(value);
  });

  it("publishing again overwrites the same session", () => {
    const first = diagnostics({ outputTokens: 1 });
    const second = diagnostics({ outputTokens: 2 });
    publishTurnDiagnostics("test-session-overwrite", first);
    publishTurnDiagnostics("test-session-overwrite", second);
    expect(getTurnDiagnostics("test-session-overwrite")).toBe(second);
  });

  it("keeps sessions isolated", () => {
    const first = diagnostics({ model: "model-a" });
    const second = diagnostics({ model: "model-b" });
    publishTurnDiagnostics("session-a", first);
    publishTurnDiagnostics("session-b", second);
    expect(getTurnDiagnostics("session-a")).toBe(first);
    expect(getTurnDiagnostics("session-b")).toBe(second);
  });

  it("clear removes data and notifies listeners", () => {
    publishTurnDiagnostics("test-session-clear", diagnostics());
    const listener = vi.fn();
    const unsubscribe = subscribeTurnDiagnostics(listener);

    clearTurnDiagnostics("test-session-clear");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getTurnDiagnostics("test-session-clear")).toBeUndefined();
    unsubscribe();
  });

  it("clearing an absent session does not notify", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTurnDiagnostics(listener);
    const before = getTurnDiagnosticsVersion();

    clearTurnDiagnostics("test-session-absent");

    expect(getTurnDiagnosticsVersion()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("does not call unsubscribed listeners", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTurnDiagnostics(listener);
    unsubscribe();

    publishTurnDiagnostics("test-session-unsubscribe", diagnostics());

    expect(listener).not.toHaveBeenCalled();
  });

  it("returns undefined for an undefined session", () => {
    expect(getTurnDiagnostics(undefined)).toBeUndefined();
  });
});
