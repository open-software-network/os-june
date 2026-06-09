import { describe, expect, it } from "vitest";
import {
  buildAgentChatTurns,
  buildHermesSessionChatTurns,
} from "../lib/agent-chat-runtime";
import type { HermesSessionMessage } from "../lib/tauri";

describe("Agent chat runtime", () => {
  it("renders persisted Hermes user and assistant messages", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content: "Hi",
        timestamp: 1_780_590_879,
      },
      {
        id: "2",
        role: "assistant",
        content: "Hi! How can I help?",
        timestamp: 1_780_590_880,
        reasoning: "The user greeted me.",
      },
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.role).toBe("user");
    expect(turns[0]?.parts).toEqual([
      { type: "text", text: "Hi", status: "complete" },
    ]);
    expect(turns[1]?.parts).toEqual([
      {
        type: "reasoning",
        text: "The user greeted me.",
        status: "complete",
      },
      { type: "text", text: "Hi! How can I help?", status: "complete" },
    ]);
  });

  it("extracts text from Hermes structured content payloads", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content:
          'Say hello\n\n--- Attached Context ---\n{"ignored":true}\n\n--- Context Warnings ---\nwarning',
        timestamp: "2026-06-04T10:00:00.000Z",
      },
      {
        id: "2",
        role: "assistant",
        content: JSON.stringify([{ type: "output_text", text: "Hello there" }]),
        timestamp: "2026-06-04T10:00:01.000Z",
      },
      {
        id: "3",
        role: "assistant",
        content: { message: { content: "Nested reply" } },
        timestamp: "2026-06-04T10:00:02.000Z",
      } as HermesSessionMessage,
    ]);

    const textParts = turns.map((turn) =>
      turn.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
    );

    expect(textParts).toEqual(["Say hello", "Hello there", "Nested reply"]);
  });

  it("classifies Hermes context compaction summaries as system context", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "compact-1",
        role: "assistant",
        content:
          "[CONTEXT COMPACTION - REFERENCE ONLY] Earlier turns were compacted.\n\n" +
          "## Active Task\nRecovered from a deterministic fallback.\n\n" +
          "--- END OF CONTEXT SUMMARY - respond to the message below, not the summary above ---",
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe("system");
    expect(turns[0]?.parts).toEqual([
      {
        type: "context",
        text:
          "[CONTEXT COMPACTION - REFERENCE ONLY] Earlier turns were compacted.\n\n" +
          "## Active Task\nRecovered from a deterministic fallback.",
        preview:
          "Earlier turns were compacted; fallback summary generated without the LLM summarizer.",
        status: "complete",
      },
    ]);
  });

  it("appends live reasoning deltas without inserting log line breaks", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "message.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: {},
        },
        {
          type: "thinking.delta",
          receivedAt: "2026-06-04T10:00:00.100Z",
          payload: { text: "I should prefer" },
        },
        {
          type: "thinking.delta",
          receivedAt: "2026-06-04T10:00:00.200Z",
          payload: { text: "ably use Homebrew." },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([
      {
        type: "reasoning",
        text: "I should preferably use Homebrew.",
        status: "running",
      },
    ]);
  });

  it("renders live clarify requests as answerable chat parts", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "tool.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { tool_id: "tool-1", name: "clarify" },
        },
        {
          type: "clarify.request",
          session_id: "runtime-session",
          receivedAt: "2026-06-04T10:00:00.100Z",
          payload: {
            request_id: "clarify-1",
            question: "Which email provider should I configure?",
            choices: ["Gmail", "Fastmail"],
          },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([
      {
        type: "clarify",
        id: "clarify-1",
        sessionId: "runtime-session",
        question: "Which email provider should I configure?",
        choices: ["Gmail", "Fastmail"],
        status: "pending",
      },
    ]);
  });

  it("marks clarify requests resolved after responses or tool completion", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "clarify.request",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: {
            request_id: "clarify-1",
            question: "Use Gmail?",
            choices: ["Yes", "No"],
          },
        },
        {
          type: "clarify.response",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { request_id: "clarify-1", answer: "Yes" },
        },
        {
          type: "tool.complete",
          receivedAt: "2026-06-04T10:00:02.000Z",
          payload: { tool_id: "tool-1", name: "clarify" },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([
      {
        type: "clarify",
        id: "clarify-1",
        question: "Use Gmail?",
        choices: ["Yes", "No"],
        answer: "Yes",
        status: "resolved",
      },
    ]);
  });

  it("marks approval requests resolved after responses", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "approval.request",
          session_id: "runtime-session",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: {
            request_id: "approval-1",
            command: "python script.py",
            description: "Run this command?",
            allow_permanent: true,
          },
        },
        {
          type: "approval.response",
          session_id: "runtime-session",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { request_id: "approval-1", choice: "session" },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([
      {
        type: "approval",
        id: "approval-1",
        sessionId: "runtime-session",
        command: "python script.py",
        description: "Run this command?",
        allowPermanent: true,
        choice: "session",
        status: "resolved",
      },
    ]);
  });
});
