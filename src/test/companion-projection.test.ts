import { describe, expect, it } from "vitest";
import { boundedCompanionText, companionAgentMessagesFromItems } from "../lib/agent-chat-runtime";
import { prepareProjectPrompt } from "../lib/agent-project-context";
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

  it("removes injected project context from companion history", () => {
    const prompt = prepareProjectPrompt(
      "What changed?",
      {
        id: "project-1",
        name: "Private launch",
        instructions: "Never expose these local instructions.",
      },
      undefined,
    ).text;
    const items: AgentItemDto[] = [
      {
        id: "user",
        sessionId: "session-1",
        sequence: 1,
        createdAt: "2026-07-16T10:00:00.000Z",
        kind: "message",
        role: "user",
        text: prompt,
        status: "complete",
      },
    ];

    expect(companionAgentMessagesFromItems(items)).toEqual([
      expect.objectContaining({
        id: "user",
        text: "What changed?",
      }),
    ]);
  });

  it("bounds UTF-8 text without splitting a scalar", () => {
    const bounded = boundedCompanionText("🙂".repeat(20), 31, "...");

    expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(31);
    expect(bounded).toBe("🙂".repeat(7) + "...");
  });

  it("attaches run-owned media references to the final assistant message", () => {
    const items: AgentItemDto[] = [
      {
        id: "assistant",
        sessionId: "session-1",
        runId: "run-1",
        sequence: 1,
        createdAt: "2026-07-28T10:00:00.000Z",
        kind: "message",
        role: "assistant",
        text: "Here is the generated image.",
        status: "complete",
      },
    ];

    expect(
      companionAgentMessagesFromItems(items, [
        {
          runId: "run-1",
          createdAt: "2026-07-28T09:59:59.000Z",
          reference: {
            artifactId: "artifact-1",
            kind: "image",
            mediaType: "image/png",
            widthPx: 1024,
            heightPx: 1024,
            sizeBytes: 4096,
          },
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "assistant",
        media: [
          {
            artifactId: "artifact-1",
            kind: "image",
            mediaType: "image/png",
            widthPx: 1024,
            heightPx: 1024,
            sizeBytes: 4096,
          },
        ],
      }),
    ]);
  });

  it("keeps generated media visible when a run has no completed assistant text", () => {
    expect(
      companionAgentMessagesFromItems(
        [],
        [
          {
            runId: "run-1",
            createdAt: "2026-07-28T10:00:00.000Z",
            reference: {
              artifactId: "artifact-video",
              kind: "video",
              mediaType: "video/mp4",
              durationMs: 5000,
              sizeBytes: 8192,
            },
          },
        ],
      ),
    ).toEqual([
      {
        id: "media:artifact-video",
        role: "assistant",
        text: "",
        createdAt: "2026-07-28T10:00:00.000Z",
        streaming: false,
        media: [
          {
            artifactId: "artifact-video",
            kind: "video",
            mediaType: "video/mp4",
            durationMs: 5000,
            sizeBytes: 8192,
          },
        ],
      },
    ]);
  });
});
