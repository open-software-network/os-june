import { describe, expect, it } from "vitest";
import {
  agentItemsToChatTurns,
  applyAgentRuntimeEvent,
  createAgentRuntimeProjection,
  mergeAgentRuntimeSnapshot,
} from "../lib/agent-runtime-adapter";
import {
  AGENT_RUNTIME_PROTOCOL_VERSION,
  type AgentRuntimeEvent,
} from "../lib/agent-runtime-contract";

const frame = {
  protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
  sessionId: "session-1",
  runId: "run-1",
};

describe("agent runtime adapter", () => {
  it("renders generated image and video tool results as media", () => {
    const items = [
      {
        id: "image-result",
        sessionId: "session-1",
        runId: "run-1",
        sequence: 1,
        createdAt: "2026-07-22T12:00:00Z",
        kind: "tool_result" as const,
        callId: "image-call",
        name: "generate_image",
        output: {
          mediaType: "image",
          dataUrl: "data:image/png;base64,AA==",
          path: "/tmp/image.png",
          prompt: "A fox",
        },
        isError: false,
      },
      {
        id: "video-result",
        sessionId: "session-1",
        runId: "run-1",
        sequence: 2,
        createdAt: "2026-07-22T12:00:01Z",
        kind: "tool_result" as const,
        callId: "video-call",
        name: "generate_video",
        output: {
          mediaType: "video",
          path: "/tmp/video.mp4",
          prompt: "A fox running",
        },
        isError: false,
      },
    ];

    expect(agentItemsToChatTurns(items).map((turn) => turn.parts.at(-1)?.type)).toEqual([
      "image",
      "video",
    ]);
  });

  it("builds a streaming transcript and ignores duplicate or stale events", () => {
    const started: AgentRuntimeEvent = {
      ...frame,
      eventId: "event-1",
      sequence: 1,
      method: "run.started",
      data: { startedAt: "2026-07-22T12:00:00Z", model: "auto" },
    };
    const firstDelta: AgentRuntimeEvent = {
      ...frame,
      eventId: "event-2",
      sequence: 2,
      method: "message.delta",
      data: {
        itemId: "message-1",
        role: "assistant",
        delta: "Hello",
        createdAt: "2026-07-22T12:00:01Z",
      },
    };
    const secondDelta: AgentRuntimeEvent = {
      ...frame,
      eventId: "event-3",
      sequence: 3,
      method: "message.delta",
      data: {
        itemId: "message-1",
        role: "assistant",
        delta: " there",
        createdAt: "2026-07-22T12:00:01Z",
      },
    };

    let projection = createAgentRuntimeProjection();
    projection = applyAgentRuntimeEvent(projection, started);
    projection = applyAgentRuntimeEvent(projection, firstDelta);
    projection = applyAgentRuntimeEvent(projection, secondDelta);

    const duplicate = applyAgentRuntimeEvent(projection, secondDelta);
    const stale = applyAgentRuntimeEvent(projection, { ...firstDelta, eventId: "stale" });

    expect(duplicate).toBe(projection);
    expect(stale).toBe(projection);
    expect(projection.run).toMatchObject({ id: "run-1", status: "running", model: "auto" });
    expect(projection.items).toMatchObject([
      { kind: "message", text: "Hello there", status: "streaming" },
    ]);
    expect(agentItemsToChatTurns(projection.items)).toMatchObject([
      {
        id: "message-1",
        role: "assistant",
        status: "running",
        parts: [{ type: "text", text: "Hello there", status: "running" }],
      },
    ]);
  });

  it("keeps deltas received while an active-session snapshot is loading", () => {
    const session = {
      id: "session-1",
      title: "Active session",
      status: "running" as const,
      model: "auto",
      safetyMode: "sandboxed" as const,
      workspacePath: "/tmp/session-1",
      source: "user" as const,
      createdAt: "2026-07-22T12:00:00Z",
      updatedAt: "2026-07-22T12:00:01Z",
    };
    const run = {
      id: "run-1",
      sessionId: session.id,
      status: "running" as const,
      model: "auto",
      startedAt: "2026-07-22T12:00:00Z",
    };
    let current = createAgentRuntimeProjection({ session, run });
    current = applyAgentRuntimeEvent(current, {
      ...frame,
      eventId: "event-after-snapshot",
      sequence: 4,
      method: "message.delta",
      data: {
        itemId: "assistant:run-1",
        role: "assistant",
        delta: " plus the newest words",
        createdAt: "2026-07-22T12:00:02Z",
      },
    });

    const hydrated = mergeAgentRuntimeSnapshot(current, {
      session,
      run,
      items: [
        {
          id: "assistant:run-1",
          sessionId: session.id,
          runId: run.id,
          sequence: 1,
          createdAt: "2026-07-22T12:00:01Z",
          kind: "message",
          role: "assistant",
          text: "Everything said before opening",
          status: "streaming",
        },
      ],
    });

    expect(hydrated.items).toMatchObject([
      {
        id: "assistant:run-1",
        text: "Everything said before opening plus the newest words",
        status: "streaming",
      },
    ]);
    expect(hydrated.lastSequenceByRun[run.id]).toBe(4);

    const continued = applyAgentRuntimeEvent(hydrated, {
      ...frame,
      eventId: "event-after-hydration",
      sequence: 5,
      method: "message.delta",
      data: {
        itemId: "assistant:run-1",
        role: "assistant",
        delta: " and the continuation",
        createdAt: "2026-07-22T12:00:03Z",
      },
    });
    expect(continued.items[0]).toMatchObject({
      text: "Everything said before opening plus the newest words and the continuation",
    });
  });

  it("replaces compacted transcript items with the visible context summary", () => {
    const projection = createAgentRuntimeProjection({
      items: [
        {
          id: "old-user",
          sessionId: "session-1",
          runId: "old-run",
          sequence: 0,
          createdAt: "2026-07-22T11:00:00Z",
          kind: "message",
          role: "user",
          text: "Old question",
          status: "complete",
        },
        {
          id: "recent-assistant",
          sessionId: "session-1",
          runId: "old-run",
          sequence: 1,
          createdAt: "2026-07-22T11:01:00Z",
          kind: "message",
          role: "assistant",
          text: "Recent answer",
          status: "complete",
        },
      ],
    });
    const started: AgentRuntimeEvent = {
      ...frame,
      eventId: "event-compacted",
      sequence: 1,
      method: "run.started",
      data: {
        startedAt: "2026-07-22T12:00:00Z",
        model: "auto",
        removedItemIds: ["old-user"],
        contextSummary: {
          id: "summary-1",
          sessionId: "session-1",
          runId: "run-1",
          sequence: 0,
          createdAt: "2026-07-22T12:00:00Z",
          kind: "context_summary",
          text: "Earlier conversation context: Old question",
        },
      },
    };

    const next = applyAgentRuntimeEvent(projection, started);

    expect(next.items.map((item) => item.id)).toEqual(["summary-1", "recent-assistant"]);
    expect(agentItemsToChatTurns(next.items)[0]).toMatchObject({
      role: "system",
      parts: [{ type: "context", text: "Earlier conversation context: Old question" }],
    });
  });

  it("renders a consumed live instruction as a durable steering notice", () => {
    const event: AgentRuntimeEvent = {
      ...frame,
      eventId: "event-steering",
      sequence: 2,
      method: "steering.consumed",
      data: {
        itemId: "steering-1",
        messageId: "message-1",
        text: "Use the launch plan",
        createdAt: "2026-07-22T12:00:01Z",
      },
    };

    const projection = applyAgentRuntimeEvent(createAgentRuntimeProjection(), event);

    expect(projection.items).toMatchObject([{ kind: "steering", text: "Use the launch plan" }]);
    expect(agentItemsToChatTurns(projection.items)).toMatchObject([
      {
        role: "system",
        parts: [{ type: "steering", text: "Steering: Use the launch plan" }],
      },
    ]);
  });

  it("maps approval, clarification, and secret interruptions to action cards", () => {
    const approval: AgentRuntimeEvent = {
      ...frame,
      eventId: "event-4",
      sequence: 4,
      method: "interruption.requested",
      data: {
        itemId: "item-approval",
        interruption: {
          id: "approval-1",
          kind: "approval",
          sessionId: "session-1",
          runId: "run-1",
          status: "pending",
          createdAt: "2026-07-22T12:00:02Z",
          toolName: "write_file",
          title: "File change requested",
          description: "June wants to update the project.",
          command: "write_file README.md",
          allowAlways: true,
        },
      },
    };
    const clarification: AgentRuntimeEvent = {
      ...frame,
      eventId: "event-5",
      sequence: 5,
      method: "interruption.requested",
      data: {
        itemId: "item-clarification",
        interruption: {
          id: "clarification-1",
          kind: "clarification",
          sessionId: "session-1",
          runId: "run-1",
          status: "pending",
          createdAt: "2026-07-22T12:00:03Z",
          question: "Which project should I update?",
          choices: ["June", "Platform"],
        },
      },
    };
    const secret: AgentRuntimeEvent = {
      ...frame,
      eventId: "event-6",
      sequence: 6,
      method: "interruption.requested",
      data: {
        itemId: "item-secret",
        interruption: {
          id: "secret-1",
          kind: "secret",
          sessionId: "session-1",
          runId: "run-1",
          status: "pending",
          createdAt: "2026-07-22T12:00:04Z",
          reason: "Authenticate a local command.",
        },
      },
    };

    let projection = createAgentRuntimeProjection();
    projection = applyAgentRuntimeEvent(projection, approval);
    projection = applyAgentRuntimeEvent(projection, clarification);
    projection = applyAgentRuntimeEvent(projection, secret);

    expect(agentItemsToChatTurns(projection.items)).toMatchObject([
      {
        parts: [
          {
            type: "approval",
            id: "approval-1",
            command: "write_file README.md",
            allowPermanent: true,
            status: "pending",
          },
        ],
      },
      {
        parts: [
          {
            type: "clarify",
            id: "clarification-1",
            question: "Which project should I update?",
            choices: ["June", "Platform"],
            status: "pending",
          },
        ],
      },
      {
        parts: [
          {
            type: "secret",
            id: "secret-1",
            reason: "Authenticate a local command.",
            status: "pending",
          },
        ],
      },
    ]);
  });

  it("replaces a replayed interruption by stable interruption id", () => {
    const interruption: AgentRuntimeEvent = {
      ...frame,
      eventId: "event-interruption-first",
      sequence: 1,
      method: "interruption.requested",
      data: {
        itemId: "item-interruption-first",
        interruption: {
          id: "approval-stable",
          kind: "approval",
          sessionId: "session-1",
          runId: "run-1",
          status: "pending",
          createdAt: "2026-07-22T12:00:02Z",
          toolName: "write_file",
          title: "File change requested",
          description: "June wants to update the project.",
          allowAlways: true,
        },
      },
    };

    let projection = applyAgentRuntimeEvent(createAgentRuntimeProjection(), interruption);
    projection = applyAgentRuntimeEvent(projection, {
      ...interruption,
      eventId: "event-interruption-replayed",
      sequence: 2,
      data: {
        ...interruption.data,
        itemId: "item-interruption-replayed",
      },
    });

    expect(projection.items).toHaveLength(1);
    expect(projection.items[0]).toMatchObject({
      id: "item-interruption-replayed",
      kind: "interruption",
      interruption: { id: "approval-stable" },
    });
  });

  it("replaces a running tool card with its persisted result", () => {
    const started: AgentRuntimeEvent = {
      ...frame,
      eventId: "event-tool-started",
      sequence: 1,
      method: "tool.started",
      data: {
        itemId: "tool-call-1",
        callId: "call-1",
        name: "list_files",
        arguments: { path: "." },
        createdAt: "2026-07-22T12:00:01Z",
      },
    };
    const completed: AgentRuntimeEvent = {
      ...frame,
      eventId: "event-tool-completed",
      sequence: 2,
      method: "tool.completed",
      data: {
        itemId: "tool-result-1",
        callId: "call-1",
        name: "list_files",
        output: [],
        createdAt: "2026-07-22T12:00:02Z",
      },
    };

    let projection = createAgentRuntimeProjection();
    projection = applyAgentRuntimeEvent(projection, started);
    expect(agentItemsToChatTurns(projection.items)).toHaveLength(1);

    projection = applyAgentRuntimeEvent(projection, completed);
    expect(agentItemsToChatTurns(projection.items)).toMatchObject([
      {
        id: "tool-result-1",
        status: "complete",
        parts: [{ type: "tool", id: "call-1", name: "list_files", status: "complete" }],
      },
    ]);
  });

  it("restores persisted message attachments into the transcript", () => {
    const projection = createAgentRuntimeProjection({
      items: [
        {
          id: "message-with-attachment",
          sessionId: "session-1",
          runId: "run-1",
          sequence: 1,
          createdAt: "2026-07-22T12:00:01Z",
          kind: "message",
          role: "user",
          text: "Summarize this.",
          status: "complete",
          attachments: [
            {
              id: "attachment-1",
              sessionId: "session-1",
              runId: "run-1",
              itemId: "message-with-attachment",
              name: "brief.md",
              path: "/session/attachments/brief.md",
              mimeType: "text/markdown",
              sizeBytes: 42,
              action: "imported",
              available: true,
              createdAt: "2026-07-22T12:00:01Z",
            },
          ],
        },
      ],
    });

    expect(agentItemsToChatTurns(projection.items)).toMatchObject([
      {
        role: "user",
        parts: [
          {
            type: "attachment",
            name: "brief.md",
            path: "/session/attachments/brief.md",
            kind: "file",
          },
          { type: "text", text: "Summarize this." },
        ],
      },
    ]);
  });

  it("rejects an incompatible protocol version", () => {
    const event = {
      ...frame,
      protocolVersion: 2,
      eventId: "future-event",
      sequence: 1,
      method: "run.started",
      data: { startedAt: "2026-07-22T12:00:00Z", model: "auto" },
    } as unknown as AgentRuntimeEvent;

    expect(() => applyAgentRuntimeEvent(createAgentRuntimeProjection(), event)).toThrow(
      "Unsupported agent runtime protocol version: 2",
    );
  });
});
