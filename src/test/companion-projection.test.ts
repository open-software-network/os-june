import { describe, expect, it } from "vitest";
import { boundedCompanionText, companionAgentMessagesFromItems } from "../lib/agent-chat-runtime";
import type { AgentItemDto } from "../lib/agent-runtime-contract";

describe("Companion agent message projection", () => {
  it("keeps completed message text while excluding reasoning, tools, and streaming items", () => {
    const items: AgentItemDto[] = [
      {
        id: "reasoning",
        sessionId: "session-1",
        sequence: 1,
        createdAt: "2026-07-16T10:00:00.000Z",
        kind: "reasoning",
        text: "Private chain of thought",
        status: "complete",
      },
      {
        id: "assistant",
        sessionId: "session-1",
        sequence: 2,
        createdAt: "2026-07-16T10:00:02.000Z",
        kind: "message",
        role: "assistant",
        text: "Here is the safe answer.",
        status: "complete",
      },
      {
        id: "tool-call",
        sessionId: "session-1",
        sequence: 3,
        createdAt: "2026-07-16T10:00:03.000Z",
        kind: "tool_call",
        callId: "call-1",
        name: "shell",
        arguments: { command: "secret command" },
        status: "complete",
      },
      {
        id: "streaming",
        sessionId: "session-1",
        sequence: 4,
        createdAt: "2026-07-16T10:00:04.000Z",
        kind: "message",
        role: "assistant",
        text: "Partial...",
        status: "streaming",
      },
    ];

    expect(companionAgentMessagesFromItems(items)).toEqual([
      {
        id: "assistant",
        role: "assistant",
        text: "Here is the safe answer.",
        createdAt: "2026-07-16T10:00:02.000Z",
        streaming: false,
      },
    ]);
  });

  it("bounds oversized message text below the companion frame budget", () => {
    const items: AgentItemDto[] = [
      {
        id: "assistant",
        sessionId: "session-1",
        sequence: 1,
        createdAt: "2026-07-16T10:00:00.000Z",
        kind: "message",
        role: "assistant",
        text: "x".repeat(64 * 1024),
        status: "complete",
      },
    ];

    const [message] = companionAgentMessagesFromItems(items);
    expect(message).toBeDefined();
    expect(new TextEncoder().encode(JSON.stringify(message)).byteLength).toBeLessThanOrEqual(
      34 * 1024,
    );
    expect(message?.text.endsWith("[Message truncated on companion]")).toBe(true);
  });

  it("bounds UTF-8 text without splitting a scalar", () => {
    const bounded = boundedCompanionText("🙂".repeat(20), 31, "...");

    expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(31);
    expect(bounded).toBe("🙂".repeat(7) + "...");
  });
});
