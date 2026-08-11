import assert from "node:assert/strict";
import test from "node:test";
import { compactHistory } from "../src/compaction.ts";
import type { RuntimeHistoryItem } from "../src/types.ts";

test("does not compact history below the threshold", async () => {
  const history: RuntimeHistoryItem[] = [
    { id: "one", kind: "message", role: "user", text: "hello", estimatedTokens: 5 },
  ];
  const result = await compactHistory({ history, contextWindow: 10_000 });
  assert.equal(result.compacted, false);
  assert.equal(result.history, history);
});

test("keeps system instructions, recent turns, and complete tool groups", async () => {
  const history: RuntimeHistoryItem[] = [
    { id: "system", kind: "message", role: "system", text: "Clovy instructions", estimatedTokens: 100 },
  ];
  for (let index = 0; index < 10; index += 1) {
    history.push({
      id: `user-${index}`,
      kind: "message",
      role: "user",
      text: `request ${index}`,
      groupId: `turn-${index}`,
      estimatedTokens: 300,
    });
    history.push({
      id: `tool-call-${index}`,
      kind: "tool_call",
      callId: `call-${index}`,
      groupId: `turn-${index}`,
      estimatedTokens: 300,
    });
    history.push({
      id: `tool-result-${index}`,
      kind: "tool_result",
      callId: `call-${index}`,
      groupId: `turn-${index}`,
      estimatedTokens: 300,
    });
  }
  const result = await compactHistory({
    history,
    contextWindow: 7_000,
    maxOutputTokens: 1_024,
    summarize: async (items) => `Summary of ${items.length} items`,
  });
  assert.equal(result.compacted, true);
  assert.ok(result.history.some((item) => item.id === "system"));
  assert.equal(result.summary?.text, "Summary of 18 items");
  assert.equal(result.summary?.role, "user");
  assert.deepEqual(result.summary?.metadata, { fallback: false });
  assert.ok(result.history.some((item) => item.id === "tool-call-9"));
  assert.ok(result.history.some((item) => item.id === "tool-result-9"));
  for (let index = 0; index < 10; index += 1) {
    const hasCall = result.history.some((item) => item.id === `tool-call-${index}`);
    const hasResult = result.history.some((item) => item.id === `tool-result-${index}`);
    assert.equal(hasCall, hasResult, `tool group ${index} was split`);
  }
});

test("manual compaction can force eligible older groups below the automatic threshold", async () => {
  const history = Array.from({ length: 8 }, (_, index) => ({
    id: `message-${index}`,
    kind: "message" as const,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `Short message ${index}`,
  }));

  const result = await compactHistory({
    history,
    contextWindow: 128_000,
    force: true,
  });

  assert.equal(result.compacted, true);
  assert.deepEqual(result.removedItemIds, ["message-0", "message-1"]);
  assert.equal(result.summary?.kind, "context_summary");
});

test("replaces prior context summaries instead of accumulating system messages", async () => {
  const history: RuntimeHistoryItem[] = [
    { id: "system", kind: "message", role: "system", text: "Clovy instructions" },
    {
      id: "old-summary",
      kind: "context_summary",
      role: "system",
      text: "Earlier summary",
    },
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `recent-${index}`,
      kind: "message" as const,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `Recent message ${index}`,
    })),
  ];

  const result = await compactHistory({
    history,
    contextWindow: 128_000,
    force: true,
    summarize: async (items) => `Replacement for ${items.map((item) => item.id).join(",")}`,
  });

  assert.equal(result.compacted, true);
  assert.deepEqual(result.removedItemIds, ["old-summary"]);
  assert.equal(result.history.filter((item) => item.kind === "context_summary").length, 1);
  assert.ok(result.summary?.text?.includes("old-summary"));
  assert.ok(result.history.some((item) => item.id === "system"));
  assert.ok(!result.history.some((item) => item.id === "old-summary"));
});

test("compacts an oversized recent group instead of exempting it", async () => {
  const history: RuntimeHistoryItem[] = [
    { id: "system", kind: "message", role: "system", text: "Clovy instructions" },
    {
      id: "huge-tool-result",
      kind: "tool_result",
      callId: "call-1",
      groupId: "turn-1",
      text: "x".repeat(200_000),
      estimatedTokens: 50_000,
    },
  ];

  const result = await compactHistory({
    history,
    contextWindow: 16_000,
    maxOutputTokens: 2_000,
    summarize: async () => "The large tool result was summarized.",
  });

  assert.equal(result.compacted, true);
  assert.deepEqual(result.removedItemIds, ["huge-tool-result"]);
  assert.ok(result.estimatedTokens < 14_000);
});

test("deterministic summaries retain bounded tool calls and results", async () => {
  const history: RuntimeHistoryItem[] = [
    {
      id: "tool-call-old",
      kind: "tool_call",
      name: "search_files",
      callId: "call-old",
      groupId: "turn-old",
      payload: { query: "quarterly plan" },
    },
    {
      id: "tool-result-old",
      kind: "tool_result",
      name: "search_files",
      callId: "call-old",
      groupId: "turn-old",
      payload: { matches: ["roadmap.md: quarterly plan"] },
    },
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `recent-${index}`,
      kind: "message" as const,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `Recent message ${index}`,
    })),
  ];

  const result = await compactHistory({ history, contextWindow: 128_000, force: true });

  assert.equal(result.compacted, true);
  assert.ok(result.summary?.text?.includes("search_files call-old"));
  assert.ok(result.summary?.text?.includes("quarterly plan"));
  assert.ok(result.summary?.text?.includes("roadmap.md"));
});

test("falls back to deterministic context when model summarization times out", async () => {
  let fallbackError: unknown;
  const history = Array.from({ length: 8 }, (_, index) => ({
    id: `message-${index}`,
    kind: "message" as const,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `Message ${index} ${index < 2 ? "x".repeat(8_000) : ""}<end-${index}>`,
  }));

  const result = await compactHistory({
    history,
    contextWindow: 8_000,
    maxOutputTokens: 4_096,
    force: true,
    summarize: async () => {
      throw new Error("model request timed out");
    },
    onFallback: (error) => {
      fallbackError = error;
    },
  });

  assert.equal(result.compacted, true);
  assert.match(result.summary?.text ?? "", /^Earlier conversation context:/);
  assert.match(result.summary?.text ?? "", /\[earlier context truncated\]/);
  assert.equal(result.summary?.text?.includes("user: Message 0"), false);
  assert.equal(result.summary?.text?.includes("<end-0>"), false);
  assert.ok(result.summary?.text?.includes("<end-1>"));
  assert.deepEqual(result.summary?.metadata, { fallback: true });
  assert.match(String(fallbackError), /model request timed out/);
});
