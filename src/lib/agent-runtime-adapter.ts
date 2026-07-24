import type { AgentChatPart, AgentChatTurn } from "./agent-chat-runtime";
import {
  AGENT_RUNTIME_PROTOCOL_VERSION,
  type AgentItemDto,
  type AgentRunDto,
  type AgentRuntimeEvent,
  type AgentSessionDto,
} from "./agent-runtime-contract";

export type AgentRuntimeProjection = {
  session?: AgentSessionDto;
  run?: AgentRunDto;
  items: AgentItemDto[];
  lastSequenceByRun: Record<string, number>;
  processedEventIds: Set<string>;
};

export function createAgentRuntimeProjection(
  input: { session?: AgentSessionDto; run?: AgentRunDto; items?: AgentItemDto[] } = {},
): AgentRuntimeProjection {
  return {
    session: input.session,
    run: input.run,
    items: [...(input.items ?? [])].sort(compareAgentItems),
    lastSequenceByRun: {},
    processedEventIds: new Set(),
  };
}

export function applyAgentRuntimeEvent(
  projection: AgentRuntimeProjection,
  event: AgentRuntimeEvent,
): AgentRuntimeProjection {
  if (event.protocolVersion !== AGENT_RUNTIME_PROTOCOL_VERSION) {
    throw new Error(`Unsupported agent runtime protocol version: ${event.protocolVersion}`);
  }
  if (projection.processedEventIds.has(event.eventId)) return projection;
  if (event.sequence <= (projection.lastSequenceByRun[event.runId] ?? -1)) return projection;

  const next: AgentRuntimeProjection = {
    ...projection,
    items: [...projection.items],
    lastSequenceByRun: { ...projection.lastSequenceByRun, [event.runId]: event.sequence },
    processedEventIds: new Set(projection.processedEventIds).add(event.eventId),
  };

  switch (event.method) {
    case "run.started":
      next.run = {
        id: event.runId,
        sessionId: event.sessionId,
        status: "running",
        model: event.data.model,
        startedAt: event.data.startedAt,
      };
      if (event.data.contextSummary) {
        const removedIds = new Set(event.data.removedItemIds ?? []);
        next.items = upsertItem(
          next.items.filter((item) => !removedIds.has(item.id)),
          event.data.contextSummary,
        );
      }
      break;
    case "message.delta":
      next.items = appendTextDelta(next.items, event, "message");
      break;
    case "message.completed":
      next.items = upsertItem(next.items, {
        id: event.data.itemId,
        sessionId: event.sessionId,
        runId: event.runId,
        sequence: event.sequence,
        createdAt: event.data.createdAt,
        kind: "message",
        role: event.data.role,
        text: event.data.text,
        status: "complete",
      });
      break;
    case "reasoning.delta":
      next.items = appendTextDelta(next.items, event, "reasoning");
      break;
    case "tool.started":
      next.items = upsertItem(next.items, {
        id: event.data.itemId,
        sessionId: event.sessionId,
        runId: event.runId,
        sequence: event.sequence,
        createdAt: event.data.createdAt,
        kind: "tool_call",
        callId: event.data.callId,
        name: event.data.name,
        arguments: event.data.arguments,
        status: "running",
      });
      break;
    case "tool.completed":
    case "tool.failed": {
      const failed = event.method === "tool.failed";
      next.items = next.items.map((item) =>
        item.kind === "tool_call" && item.callId === event.data.callId
          ? { ...item, status: failed ? "failed" : "complete" }
          : item,
      );
      next.items = upsertItem(next.items, {
        id: event.data.itemId,
        sessionId: event.sessionId,
        runId: event.runId,
        sequence: event.sequence,
        createdAt: event.data.createdAt,
        kind: "tool_result",
        callId: event.data.callId,
        name: event.data.name,
        output: failed ? event.data.error : event.data.output,
        isError: failed,
      });
      break;
    }
    case "interruption.requested":
      next.items = upsertItem(
        next.items.filter(
          (item) =>
            item.kind !== "interruption" || item.interruption.id !== event.data.interruption.id,
        ),
        {
          id: event.data.itemId,
          sessionId: event.sessionId,
          runId: event.runId,
          sequence: event.sequence,
          createdAt: event.data.interruption.createdAt,
          kind: "interruption",
          interruption: event.data.interruption,
        },
      );
      if (next.run) next.run = { ...next.run, status: "waiting_for_user" };
      break;
    case "usage.updated":
      if (next.run) next.run = { ...next.run, usage: event.data };
      break;
    case "run.completed":
    case "run.cancelled":
      if (next.run) {
        next.run = {
          ...next.run,
          status: event.method === "run.completed" ? "completed" : "cancelled",
          completedAt: event.data.completedAt,
        };
      }
      break;
    case "run.failed":
      if (next.run) {
        next.run = {
          ...next.run,
          status: "failed",
          completedAt: event.data.completedAt,
          error: event.data.message,
        };
      }
      next.items = upsertItem(next.items, {
        id: `error:${event.eventId}`,
        sessionId: event.sessionId,
        runId: event.runId,
        sequence: event.sequence,
        createdAt: event.data.completedAt,
        kind: "error",
        message: event.data.message,
        retryable: event.data.retryable,
      });
      break;
  }

  return next;
}

export function agentItemsToChatTurns(items: AgentItemDto[]): AgentChatTurn[] {
  const orderedItems = [...items].sort(compareAgentItems);
  const settledToolCalls = new Set(
    orderedItems
      .filter((item) => item.kind === "tool_result")
      .map((item) => toolCallKey(item.runId, item.callId)),
  );

  return orderedItems
    .filter(
      (item) =>
        item.kind !== "tool_call" || !settledToolCalls.has(toolCallKey(item.runId, item.callId)),
    )
    .map((item): AgentChatTurn => {
      const base = {
        id: item.id,
        createdAt: item.createdAt,
        status: itemIsRunning(item) ? ("running" as const) : ("complete" as const),
      };
      switch (item.kind) {
        case "message":
          return {
            ...base,
            role: item.role,
            parts: [
              ...((item.attachments ?? []).map(
                (artifact): AgentChatPart => ({
                  type: "attachment",
                  name: artifact.name,
                  path: artifact.path,
                  kind: artifact.mimeType?.startsWith("image/") ? "image" : "file",
                }),
              ) ?? []),
              { type: "text", text: item.text, status: base.status },
            ],
          };
        case "reasoning":
          return {
            ...base,
            role: "assistant",
            parts: [{ type: "reasoning", text: item.text, status: base.status }],
          };
        case "context_summary":
          return {
            ...base,
            role: "system",
            parts: [
              {
                type: "context",
                text: item.text,
                preview: item.text.slice(0, 160),
                status: "complete",
              },
            ],
          };
        case "tool_call":
          return {
            ...base,
            role: "assistant",
            parts: [
              {
                type: "tool",
                id: item.callId,
                name: item.name,
                text: readableValue(item.arguments),
                status: item.status,
              },
            ],
          };
        case "tool_result":
          return {
            ...base,
            role: "assistant",
            parts: [
              {
                type: "tool",
                id: item.callId,
                name: item.name,
                text: readableValue(item.output),
                status: item.isError ? "failed" : "complete",
              },
            ],
          };
        case "interruption":
          return {
            ...base,
            role: "assistant",
            parts: [interruptionToPart(item.interruption)],
          };
        case "error":
          return {
            ...base,
            role: "system",
            parts: [{ type: "text", text: item.message, status: "complete" }],
          };
        default:
          return assertNever(item);
      }
    });
}

function toolCallKey(runId: string | undefined, callId: string) {
  return `${runId ?? ""}:${callId}`;
}

function interruptionToPart(
  interruption: Extract<AgentItemDto, { kind: "interruption" }>["interruption"],
): AgentChatPart {
  if (interruption.kind === "clarification") {
    return {
      type: "clarify",
      id: interruption.id,
      sessionId: interruption.sessionId,
      question: interruption.question,
      choices: interruption.choices,
      answer: interruption.answer,
      status: interruption.status === "pending" ? "pending" : "resolved",
    };
  }
  return {
    type: "approval",
    id: interruption.id,
    sessionId: interruption.sessionId,
    command: interruption.command ?? interruption.toolName,
    description: interruption.description || interruption.title,
    allowPermanent: interruption.allowAlways,
    choice: interruption.resolution,
    status: interruption.status,
  };
}

function appendTextDelta(
  items: AgentItemDto[],
  event: Extract<AgentRuntimeEvent, { method: "message.delta" | "reasoning.delta" }>,
  kind: "message" | "reasoning",
) {
  const existing = items.find((item) => item.id === event.data.itemId);
  const text = existing && "text" in existing ? existing.text + event.data.delta : event.data.delta;
  return upsertItem(
    items,
    kind === "message"
      ? {
          id: event.data.itemId,
          sessionId: event.sessionId,
          runId: event.runId,
          sequence: event.sequence,
          createdAt: event.data.createdAt,
          kind,
          role: "assistant",
          text,
          status: "streaming",
        }
      : {
          id: event.data.itemId,
          sessionId: event.sessionId,
          runId: event.runId,
          sequence: event.sequence,
          createdAt: event.data.createdAt,
          kind,
          text,
          status: "streaming",
        },
  );
}

function upsertItem(items: AgentItemDto[], item: AgentItemDto) {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  const next = [...items];
  if (index >= 0) next[index] = item;
  else next.push(item);
  return next.sort(compareAgentItems);
}

function compareAgentItems(a: AgentItemDto, b: AgentItemDto) {
  return (
    a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );
}

function itemIsRunning(item: AgentItemDto) {
  return (
    ((item.kind === "message" || item.kind === "reasoning") && item.status === "streaming") ||
    (item.kind === "tool_call" && item.status === "running")
  );
}

function readableValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported agent item: ${JSON.stringify(value)}`);
}
