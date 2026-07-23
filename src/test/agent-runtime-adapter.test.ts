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
