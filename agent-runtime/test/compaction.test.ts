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
    { id: "system", kind: "message", role: "system", text: "June instructions", estimatedTokens: 100 },
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
  assert.equal(result.summary?.text, "Summary of 12 items");
  assert.ok(result.history.some((item) => item.id === "tool-call-9"));
  assert.ok(result.history.some((item) => item.id === "tool-result-9"));
  for (let index = 0; index < 10; index += 1) {
    const hasCall = result.history.some((item) => item.id === `tool-call-${index}`);
    const hasResult = result.history.some((item) => item.id === `tool-result-${index}`);
    assert.equal(hasCall, hasResult, `tool group ${index} was split`);
  }
});
