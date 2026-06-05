import { describe, expect, it } from "vitest";
import { buildHermesSessionChatTurns } from "../lib/agent-chat-runtime";
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
});
