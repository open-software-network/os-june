import { describe, expect, it } from "vitest";
import {
  buildAgentChatTurns,
  buildHermesSessionChatTurns,
  completedHermesMessageText,
  toolEventKey,
} from "../lib/agent-chat-runtime";
import type { AgentMessageDto, HermesSessionMessage } from "../lib/tauri";

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

  it("preserves whitespace-only message deltas", () => {
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
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.100Z",
          payload: { text: "Hello" },
        },
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.200Z",
          payload: { text: "\n\n" },
        },
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.300Z",
          payload: { text: "World" },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([
      { type: "text", text: "Hello\n\nWorld", status: "running" },
    ]);
  });

  it("appends repeated deltas verbatim instead of dropping them", () => {
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
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.100Z",
          payload: { text: "no" },
        },
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.200Z",
          payload: { text: "no" },
        },
      ],
    );

    expect(turns[0]?.parts).toEqual([
      { type: "text", text: "nono", status: "running" },
    ]);
  });

  it("keeps legitimate repeated lines and paragraphs in persisted messages", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: "Run:\n\nfoo();\nfoo();\nbar();",
        timestamp: "2026-06-04T10:00:00.000Z",
      },
      {
        id: "2",
        role: "assistant",
        content: "Yes.\n\nYes.",
        timestamp: "2026-06-04T10:00:01.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([
      {
        type: "text",
        text: "Run:\n\nfoo();\nfoo();\nbar();",
        status: "complete",
      },
    ]);
    expect(turns[1]?.parts).toEqual([
      { type: "text", text: "Yes.\n\nYes.", status: "complete" },
    ]);
  });

  it("returns the raw completed message text for persistence", () => {
    const text = completedHermesMessageText([
      {
        type: "message.start",
        receivedAt: "2026-06-04T10:00:00.000Z",
        payload: {},
      },
      {
        type: "message.delta",
        receivedAt: "2026-06-04T10:00:00.100Z",
        payload: { text: "Yes.\n\nYes." },
      },
      {
        type: "message.complete",
        receivedAt: "2026-06-04T10:00:01.000Z",
        payload: { text: "Yes.\n\nYes." },
      },
    ]);

    expect(text).toBe("Yes.\n\nYes.");
  });

  it("does not duplicate the opening text on interleaved text/tool turns", () => {
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
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.100Z",
          payload: { text: "Let me check." },
        },
        {
          type: "tool.start",
          receivedAt: "2026-06-04T10:00:00.200Z",
          payload: { tool_id: "tool-1", name: "search" },
        },
        {
          type: "tool.complete",
          receivedAt: "2026-06-04T10:00:00.300Z",
          payload: { tool_id: "tool-1", name: "search" },
        },
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.400Z",
          payload: { text: "Here is the answer." },
        },
        {
          type: "message.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { text: "Let me check.Here is the answer." },
        },
      ],
    );

    expect(turns[0]?.status).toBe("complete");
    expect(
      turns[0]?.parts.map((part) =>
        part.type === "text" ? part.text : part.type,
      ),
    ).toEqual(["Let me check.", "tool", "Here is the answer."]);
  });

  it("replaces streamed text wholesale when the complete text disagrees", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { text: "Partial garble" },
        },
        {
          type: "tool.start",
          receivedAt: "2026-06-04T10:00:00.100Z",
          payload: { tool_id: "tool-1", name: "search" },
        },
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.200Z",
          payload: { text: "more" },
        },
        {
          type: "message.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { text: "The authoritative answer." },
        },
      ],
    );

    expect(
      turns[0]?.parts.map((part) =>
        part.type === "text" ? part.text : part.type,
      ),
    ).toEqual(["tool", "The authoritative answer."]);
  });

  it("keeps the verbatim stream when the complete text drops a boundary space", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { text: "Let me explore it." },
        },
        {
          type: "message.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { text: "Let me exploreit." },
        },
      ],
    );

    expect(
      turns[0]?.parts.map((part) =>
        part.type === "text" ? part.text : part.type,
      ),
    ).toEqual(["Let me explore it."]);
  });

  it("honors a complete payload that corrects streamed whitespace", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { text: "return\nvalue" },
        },
        {
          type: "message.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { text: "return value" },
        },
      ],
    );

    expect(
      turns[0]?.parts.map((part) =>
        part.type === "text" ? part.text : part.type,
      ),
    ).toEqual(["return value"]);
  });

  it("does not truncate streamed text when the complete payload lags behind", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { text: "Here is the full answer." },
        },
        {
          type: "message.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { text: "Here is the full" },
        },
      ],
    );

    expect(
      turns[0]?.parts.map((part) =>
        part.type === "text" ? part.text : part.type,
      ),
    ).toEqual(["Here is the full answer."]);
  });

  it("assigns unique turn ids to turns created in the same millisecond", () => {
    const receivedAt = "2026-06-04T10:00:00.000Z";
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        { type: "message.start", receivedAt, payload: {} },
        { type: "message.complete", receivedAt, payload: { text: "One" } },
        { type: "message.start", receivedAt, payload: {} },
        { type: "message.complete", receivedAt, payload: { text: "Two" } },
      ],
    );

    expect(turns).toHaveLength(2);
    expect(turns[0]?.id).not.toBe(turns[1]?.id);
  });

  it("keys tool events by tool_id so terminal events update the same part", () => {
    expect(
      toolEventKey({ type: "tool.start", payload: { tool_id: "tool-9" } }),
    ).toBe("tool-9");

    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "tool.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { tool_id: "tool-9", name: "search", text: "Searching" },
        },
        {
          type: "tool.complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { tool_id: "tool-9" },
        },
      ],
    );

    const toolParts = turns[0]?.parts.filter((part) => part.type === "tool");
    expect(toolParts).toHaveLength(1);
    expect(toolParts?.[0]?.status).toBe("complete");
  });

  it("does not merge same-name tool calls with distinct tool ids", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "tool.start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { tool_id: "tool-a", name: "search", text: "First" },
        },
        {
          type: "tool.start",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: { tool_id: "tool-b", name: "search", text: "Second" },
        },
      ],
    );

    const toolParts = turns[0]?.parts.filter((part) => part.type === "tool");
    expect(toolParts?.map((part) => part.id)).toEqual(["tool-a", "tool-b"]);
  });

  it("attributes persisted tool events to the assistant turn they belong to", () => {
    const messages: AgentMessageDto[] = [
      {
        id: "m1",
        taskId: "task-1",
        role: "user",
        content: "First question",
        createdAt: "2026-06-04T10:00:00.000Z",
      },
      {
        id: "m2",
        taskId: "task-1",
        role: "assistant",
        content: "First answer",
        createdAt: "2026-06-04T10:00:10.000Z",
      },
      {
        id: "m3",
        taskId: "task-1",
        role: "user",
        content: "Second question",
        createdAt: "2026-06-04T10:01:00.000Z",
      },
      {
        id: "m4",
        taskId: "task-1",
        role: "assistant",
        content: "Second answer",
        createdAt: "2026-06-04T10:01:10.000Z",
      },
    ];
    const turns = buildAgentChatTurns(messages, [
      {
        id: "evt-1",
        taskId: "task-1",
        toolName: "Search",
        status: "completed",
        summary: "Searched the web",
        redacted: false,
        createdAt: "2026-06-04T10:00:05.000Z",
      },
      {
        id: "evt-2",
        taskId: "task-1",
        toolName: "Fetch",
        status: "completed",
        summary: "Fetched a page",
        redacted: false,
        createdAt: "2026-06-04T10:01:05.000Z",
      },
    ]);

    const firstAssistant = turns.find((turn) => turn.id === "m2");
    const secondAssistant = turns.find((turn) => turn.id === "m4");
    expect(
      firstAssistant?.parts.filter((part) => part.type === "tool"),
    ).toEqual([
      {
        type: "tool",
        id: "evt-1",
        name: "Search",
        text: "Searched the web",
        status: "complete",
      },
    ]);
    expect(
      secondAssistant?.parts.filter((part) => part.type === "tool"),
    ).toEqual([
      {
        type: "tool",
        id: "evt-2",
        name: "Fetch",
        text: "Fetched a page",
        status: "complete",
      },
    ]);
  });

  it("groups trailing persisted tool events into one in-flight turn", () => {
    const messages: AgentMessageDto[] = [
      {
        id: "m1",
        taskId: "task-1",
        role: "assistant",
        content: "Earlier answer",
        createdAt: "2026-06-04T10:00:00.000Z",
      },
    ];
    const turns = buildAgentChatTurns(messages, [
      {
        id: "evt-1",
        taskId: "task-1",
        toolName: "Search",
        status: "completed",
        summary: "Searched the web",
        redacted: false,
        createdAt: "2026-06-04T10:01:00.000Z",
      },
      {
        id: "evt-2",
        taskId: "task-1",
        toolName: "Fetch",
        status: "completed",
        summary: "Fetched a page",
        redacted: false,
        createdAt: "2026-06-04T10:01:05.000Z",
      },
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.parts).toEqual([
      { type: "text", text: "Earlier answer", status: "complete" },
    ]);
    expect(turns[1]?.parts.filter((part) => part.type === "tool")).toHaveLength(
      2,
    );
    expect(turns[1]?.status).toBe("complete");
  });

  it("does not leave a turn created by a terminal tool event running", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        {
          type: "tool.complete",
          receivedAt: "2026-06-04T10:00:00.000Z",
          payload: { tool_id: "tool-1", name: "search", text: "Done" },
        },
      ],
    );

    expect(turns[0]?.status).toBe("complete");
  });

  it("marks the in-flight turn errored even when the error has no text", () => {
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
          type: "message.delta",
          receivedAt: "2026-06-04T10:00:00.100Z",
          payload: { text: "Working on it" },
        },
        {
          type: "error",
          receivedAt: "2026-06-04T10:00:01.000Z",
          payload: {},
        },
      ],
    );

    expect(turns[0]?.status).toBe("complete");
    expect(turns[0]?.parts).toContainEqual({
      type: "tool",
      id: "error:2026-06-04T10:00:01.000Z",
      name: "Error",
      text: "The agent reported an error.",
      status: "failed",
    });
  });
});
