import { describe, expect, it } from "vitest";
import {
  agentItemsToChatTurns,
  applyAgentRuntimeEvent,
  createAgentRuntimeProjection,
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

  it("maps approval and clarification interruptions to existing action cards", () => {
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

    let projection = createAgentRuntimeProjection();
    projection = applyAgentRuntimeEvent(projection, approval);
    projection = applyAgentRuntimeEvent(projection, clarification);

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
