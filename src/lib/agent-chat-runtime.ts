import type {
  AgentMessageDto,
  AgentToolEventDto,
  AgentToolEventStatus,
  HermesSessionMessage,
} from "./tauri";
import type { HermesGatewayEvent } from "./hermes-gateway";

export type LiveHermesEvent = HermesGatewayEvent & {
  receivedAt: string;
};

export type AgentChatTextPart = {
  type: "text";
  text: string;
  status?: "running" | "complete";
};

export type AgentChatReasoningPart = {
  type: "reasoning";
  text: string;
  status: "running" | "complete";
};

export type AgentChatToolPart = {
  type: "tool";
  id: string;
  name: string;
  text: string;
  status: "running" | "complete" | "failed";
};

export type AgentApprovalChoice = "once" | "session" | "always" | "deny";

export type AgentChatApprovalPart = {
  type: "approval";
  id: string;
  sessionId?: string;
  command: string;
  description: string;
  allowPermanent: boolean;
  choice?: AgentApprovalChoice;
  status: "pending" | "resolved";
};

export type AgentChatClarifyPart = {
  type: "clarify";
  id: string;
  sessionId?: string;
  question: string;
  choices: string[];
  answer?: string;
  status: "pending" | "resolved";
};

export type AgentChatPart =
  | AgentChatTextPart
  | AgentChatReasoningPart
  | AgentChatToolPart
  | AgentChatApprovalPart
  | AgentChatClarifyPart;

export type AgentChatTurn = {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  status: "running" | "complete";
  parts: AgentChatPart[];
};

export function buildAgentChatTurns(
  messages: AgentMessageDto[],
  toolEvents: AgentToolEventDto[],
  liveEvents: LiveHermesEvent[] = [],
): AgentChatTurn[] {
  const turns = messages.map(messageToTurn);
  appendPersistedToolEvents(turns, toolEvents);
  appendLiveHermesEvents(turns, liveEvents);
  return turns
    .filter((turn) =>
      turn.parts.some((part) => part.type === "tool" || partText(part).trim()),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function buildHermesSessionChatTurns(
  messages: HermesSessionMessage[],
  liveEvents: LiveHermesEvent[] = [],
): AgentChatTurn[] {
  const turns: AgentChatTurn[] = [];
  const toolResults = new Map<string, HermesSessionMessage>();

  for (const message of messages) {
    if (message.role === "tool") {
      const id = message.tool_call_id ?? message.id;
      toolResults.set(id, message);
      const turn =
        lastAssistantTurn(turns) ??
        createAssistantTurn(turns, messageTimestamp(message));
      upsertToolPart(turn.parts, {
        id,
        name: message.tool_name ?? "Tool",
        text: textFromHermesContent(message.content) ?? "",
        status: "complete",
      });
      turn.status = "complete";
      continue;
    }

    const turn: AgentChatTurn = {
      id: message.id,
      role:
        message.role === "assistant"
          ? "assistant"
          : message.role === "system"
            ? "system"
            : "user",
      createdAt: messageTimestamp(message),
      status: "complete",
      parts: [],
    };

    const reasoning =
      stringValue(message.reasoning, true) ??
      stringValue(message.reasoning_content, true) ??
      textFromHermesContent(message.reasoning_details);
    if (reasoning) {
      turn.parts.push({
        type: "reasoning",
        text: reasoning,
        status: "complete",
      });
    }

    for (const call of parseToolCalls(message.tool_calls)) {
      const result = toolResults.get(call.id);
      turn.parts.push({
        type: "tool",
        id: call.id,
        name: humanizeToolName(call.name),
        text:
          textFromHermesContent(result?.content) ??
          stringifyObject(call.arguments) ??
          "",
        status: "complete",
      });
    }

    const content = displayContentForHermesMessage(message);
    if (content) {
      turn.parts.push({
        type: "text",
        text: collapseRepeatedMessageText(content),
        status: "complete",
      });
    }

    if (turn.parts.length) {
      turns.push(turn);
    }
  }

  appendLiveHermesEvents(turns, liveEvents);
  return turns
    .filter((turn) =>
      turn.parts.some((part) => part.type === "tool" || partText(part).trim()),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function completedHermesMessageText(events: LiveHermesEvent[]) {
  const turn = buildAgentChatTurns([], [], events)
    .filter((item) => item.role === "assistant")
    .at(-1);
  const text = turn?.parts
    .filter((part): part is AgentChatTextPart => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  return turn?.status === "complete"
    ? collapseRepeatedMessageText(text ?? "")
    : "";
}

function messageToTurn(message: AgentMessageDto): AgentChatTurn {
  return {
    id: message.id,
    role:
      message.role === "assistant"
        ? "assistant"
        : message.role === "system"
          ? "system"
          : "user",
    createdAt: message.createdAt,
    status: "complete",
    parts: [{ type: "text", text: message.content, status: "complete" }],
  };
}

function appendPersistedToolEvents(
  turns: AgentChatTurn[],
  toolEvents: AgentToolEventDto[],
) {
  for (const event of toolEvents) {
    const turn =
      lastAssistantTurn(turns) ?? createAssistantTurn(turns, event.createdAt);
    upsertToolPart(turn.parts, {
      id: event.id,
      name: event.toolName,
      text: event.summary,
      status: toolStatus(event.status),
    });
  }
}

function appendLiveHermesEvents(
  turns: AgentChatTurn[],
  events: LiveHermesEvent[],
) {
  let currentAssistant: AgentChatTurn | null = null;

  for (const event of events) {
    const text = eventText(event);
    if (event.type === "message.start") {
      currentAssistant = createAssistantTurn(turns, event.receivedAt);
      currentAssistant.status = "running";
      continue;
    }

    if (event.type === "message.delta") {
      currentAssistant ??= createAssistantTurn(turns, event.receivedAt);
      currentAssistant.status = "running";
      appendAssistantTextPart(currentAssistant.parts, text, "running");
      continue;
    }

    if (event.type === "message.complete") {
      currentAssistant ??= createAssistantTurn(turns, event.receivedAt);
      if (text) {
        completeAssistantTextPart(currentAssistant.parts, text);
      }
      currentAssistant.status = "complete";
      completeRunningParts(currentAssistant.parts);
      currentAssistant = null;
      continue;
    }

    if (event.type === "thinking.delta" || event.type === "reasoning.delta") {
      currentAssistant ??= createAssistantTurn(turns, event.receivedAt);
      currentAssistant.status = "running";
      appendReasoningPart(currentAssistant.parts, text);
      continue;
    }

    if (event.type.startsWith("tool.")) {
      if (isClarifyToolEvent(event)) {
        if (event.type.includes("complete") || event.type.includes("fail")) {
          completePendingClarifyParts(
            (currentAssistant ?? lastAssistantTurn(turns))?.parts ?? [],
          );
        }
        continue;
      }
      currentAssistant ??= createAssistantTurn(turns, event.receivedAt);
      currentAssistant.status =
        toolEventStatus(event) === "running"
          ? "running"
          : currentAssistant.status;
      const payload = event.payload as Record<string, unknown> | undefined;
      upsertToolPart(currentAssistant.parts, {
        id: toolEventKey(event),
        name: humanizeToolName(
          stringValue(payload?.name) ??
            stringValue(payload?.tool_name) ??
            stringValue(payload?.tool) ??
            "tool",
        ),
        text,
        status: toolEventStatus(event),
      });
      continue;
    }

    if (event.type === "clarify.request") {
      currentAssistant ??= createAssistantTurn(turns, event.receivedAt);
      currentAssistant.status = "running";
      const payload = event.payload as Record<string, unknown> | undefined;
      upsertClarifyPart(currentAssistant.parts, {
        id:
          stringValue(payload?.request_id) ??
          stringValue(payload?.id) ??
          `clarify:${event.receivedAt}`,
        sessionId: event.session_id,
        question:
          stringValue(payload?.question, true) ??
          "Hermes needs clarification before continuing.",
        choices: stringArrayValue(payload?.choices),
        status: "pending",
      });
      continue;
    }

    if (event.type === "clarify.response") {
      const payload = event.payload as Record<string, unknown> | undefined;
      upsertClarifyPart(
        (currentAssistant ?? lastAssistantTurn(turns))?.parts ?? [],
        {
          id:
            stringValue(payload?.request_id) ??
            stringValue(payload?.id) ??
            `clarify:${event.receivedAt}`,
          sessionId: event.session_id,
          question: stringValue(payload?.question, true) ?? "",
          choices: stringArrayValue(payload?.choices),
          answer: stringValue(payload?.answer, true) ?? "",
          status: "resolved",
        },
      );
      continue;
    }

    if (event.type === "approval.request") {
      currentAssistant ??= createAssistantTurn(turns, event.receivedAt);
      currentAssistant.status = "running";
      const payload = event.payload as Record<string, unknown> | undefined;
      upsertApprovalPart(currentAssistant.parts, {
        id:
          stringValue(payload?.request_id) ??
          stringValue(payload?.id) ??
          `approval:${event.receivedAt}`,
        command: stringValue(payload?.command, true) ?? "",
        description:
          stringValue(payload?.description, true) ??
          "Hermes needs approval before continuing.",
        sessionId: event.session_id,
        allowPermanent: payload?.allow_permanent !== false,
        status: "pending",
      });
      continue;
    }

    if (event.type === "approval.response") {
      const payload = event.payload as Record<string, unknown> | undefined;
      upsertApprovalPart(
        (currentAssistant ?? lastAssistantTurn(turns))?.parts ?? [],
        {
          id:
            stringValue(payload?.request_id) ??
            stringValue(payload?.id) ??
            `approval:${event.receivedAt}`,
          command: stringValue(payload?.command, true) ?? "",
          description: stringValue(payload?.description, true) ?? "",
          sessionId: event.session_id,
          allowPermanent: payload?.allow_permanent !== false,
          choice: approvalChoiceValue(payload?.choice),
          status: "resolved",
        },
      );
      continue;
    }

    if (event.type === "error" && text) {
      currentAssistant ??= createAssistantTurn(turns, event.receivedAt);
      upsertToolPart(currentAssistant.parts, {
        id: `error:${event.receivedAt}`,
        name: "Error",
        text,
        status: "failed",
      });
      currentAssistant.status = "complete";
      completeRunningParts(currentAssistant.parts);
      currentAssistant = null;
    }
  }
}

function createAssistantTurn(turns: AgentChatTurn[], createdAt: string) {
  const turn: AgentChatTurn = {
    id: `assistant:${createdAt}`,
    role: "assistant",
    createdAt,
    status: "running",
    parts: [],
  };
  turns.push(turn);
  return turn;
}

function lastAssistantTurn(turns: AgentChatTurn[]) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.role === "assistant") return turns[index];
  }
  return undefined;
}

function appendAssistantTextPart(
  parts: AgentChatPart[],
  delta: string,
  status: "running" | "complete",
) {
  if (!delta.trim()) return;
  const last = parts.at(-1);
  if (last?.type === "text") {
    last.text = appendMessageText(last.text, delta);
    last.status = status;
    return;
  }
  parts.push({ type: "text", text: delta, status });
}

function completeAssistantTextPart(parts: AgentChatPart[], text: string) {
  if (!text.trim()) return;
  const lastText = [...parts]
    .reverse()
    .find((part): part is AgentChatTextPart => part.type === "text");
  if (lastText) {
    lastText.text = collapseRepeatedMessageText(
      completeMessageText(lastText.text, text),
    );
    lastText.status = "complete";
  } else {
    parts.push({
      type: "text",
      text: collapseRepeatedMessageText(text),
      status: "complete",
    });
  }
}

function appendReasoningPart(parts: AgentChatPart[], delta: string) {
  if (
    !delta.trim() ||
    delta === "thinking.delta" ||
    delta === "reasoning.delta"
  )
    return;
  const last = parts.at(-1);
  if (last?.type === "reasoning") {
    last.text = appendMessageText(last.text, delta);
    last.status = "running";
    return;
  }
  parts.push({ type: "reasoning", text: delta, status: "running" });
}

function completeRunningParts(parts: AgentChatPart[]) {
  for (const part of parts) {
    if (part.type === "reasoning") part.status = "complete";
    if (part.type === "text") part.status = "complete";
    if (part.type === "tool" && part.status === "running")
      part.status = "complete";
    if (part.type === "approval" && part.status === "pending")
      part.status = "resolved";
    if (part.type === "clarify" && part.status === "pending")
      part.status = "resolved";
  }
}

function upsertToolPart(
  parts: AgentChatPart[],
  next: Pick<AgentChatToolPart, "id" | "name" | "text" | "status">,
) {
  const existing = parts.find(
    (part): part is AgentChatToolPart =>
      part.type === "tool" &&
      (part.id === next.id ||
        (!next.id && part.name === next.name && part.status === "running")),
  );
  if (existing) {
    existing.name = next.name || existing.name;
    existing.status = next.status;
    if (next.text && next.text !== existing.text) {
      existing.text = appendLogText(existing.text, next.text);
    }
    return;
  }
  parts.push({
    type: "tool",
    id: next.id,
    name: next.name,
    text: next.text,
    status: next.status,
  });
}

function upsertApprovalPart(
  parts: AgentChatPart[],
  next: Pick<
    AgentChatApprovalPart,
    "id" | "command" | "description" | "allowPermanent" | "status"
  > &
    Partial<Pick<AgentChatApprovalPart, "choice" | "sessionId">>,
) {
  const existing = parts.find(
    (part): part is AgentChatApprovalPart =>
      part.type === "approval" && part.id === next.id,
  );
  if (existing) {
    existing.command = next.command || existing.command;
    existing.description = next.description || existing.description;
    existing.sessionId = next.sessionId || existing.sessionId;
    existing.allowPermanent = next.allowPermanent;
    existing.choice = next.choice ?? existing.choice;
    existing.status = next.status;
    return;
  }
  parts.push({
    type: "approval",
    id: next.id,
    sessionId: next.sessionId,
    command: next.command,
    description: next.description,
    allowPermanent: next.allowPermanent,
    choice: next.choice,
    status: next.status,
  });
}

function upsertClarifyPart(
  parts: AgentChatPart[],
  next: Pick<AgentChatClarifyPart, "id" | "question" | "choices" | "status"> &
    Partial<Pick<AgentChatClarifyPart, "answer" | "sessionId">>,
) {
  const existing = parts.find(
    (part): part is AgentChatClarifyPart =>
      part.type === "clarify" && part.id === next.id,
  );
  if (existing) {
    existing.question = next.question || existing.question;
    existing.choices = next.choices.length ? next.choices : existing.choices;
    existing.answer = next.answer ?? existing.answer;
    existing.sessionId = next.sessionId || existing.sessionId;
    existing.status = next.status;
    return;
  }
  parts.push({
    type: "clarify",
    id: next.id,
    sessionId: next.sessionId,
    question: next.question,
    choices: next.choices,
    answer: next.answer,
    status: next.status,
  });
}

function eventText(event: HermesGatewayEvent) {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload) return "";
  for (const key of [
    "text",
    "delta",
    "message",
    "summary",
    "status",
    "content",
    "output",
    "result",
    "command",
  ]) {
    const value = stringValue(
      payload[key],
      key === "text" ||
        key === "delta" ||
        key === "message" ||
        key === "content",
    );
    if (value) return value;
  }
  return "";
}

function messageTimestamp(message: HermesSessionMessage) {
  return timestampString(message.timestamp ?? message.created_at);
}

function parseToolCalls(value: unknown) {
  const parsed = typeof value === "string" ? safeJsonParse(value) : value;
  const calls = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return calls.flatMap((call, index) => {
    if (!call || typeof call !== "object") return [];
    const record = call as Record<string, unknown>;
    const functionRecord =
      record.function && typeof record.function === "object"
        ? (record.function as Record<string, unknown>)
        : undefined;
    const id =
      stringValue(record.id) ??
      stringValue(record.call_id) ??
      stringValue(record.tool_call_id) ??
      `tool:${index}`;
    const name =
      stringValue(record.name) ??
      stringValue(functionRecord?.name) ??
      stringValue(record.tool_name) ??
      "Tool";
    const args = functionRecord?.arguments ?? record.arguments ?? record.args;
    return [{ id, name, arguments: args }];
  });
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function displayContentForHermesMessage(message: HermesSessionMessage) {
  const content =
    textFromHermesContent(message.content) ??
    textFromHermesContent(message.text) ??
    textFromHermesContent(message.context) ??
    stringValue(message.name, true) ??
    "";
  if (message.role !== "user") return content.trim();
  return stripHermesContextMarkers(content);
}

function textFromHermesContent(value: unknown, depth = 0): string | undefined {
  if (value === null || value === undefined || depth > 4) return undefined;
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    const parsed = parseLikelyJsonContent(value);
    if (parsed !== undefined) {
      const parsedText = textFromHermesContent(parsed, depth + 1);
      if (parsedText?.trim()) return parsedText;
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) {
    const text = value
      .map((item) => textFromHermesContent(item, depth + 1) ?? "")
      .join("");
    return text.trim() ? text : undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of [
      "text",
      "output_text",
      "content",
      "message",
      "delta",
      "summary",
    ]) {
      const text = textFromHermesContent(record[key], depth + 1);
      if (text?.trim()) return text;
    }
    return stringifyObject(value) || undefined;
  }
  return undefined;
}

function parseLikelyJsonContent(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  return safeJsonParse(trimmed);
}

function stripHermesContextMarkers(value: string) {
  const withoutWarnings = value.replace(
    /\n*--- Context Warnings ---[\s\S]*$/m,
    "",
  );
  const marker = withoutWarnings.search(/\n*--- Attached Context ---/m);
  const visible =
    marker >= 0 ? withoutWarnings.slice(0, marker) : withoutWarnings;
  return visible.trim();
}

function stringifyObject(value: unknown) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function toolEventKey(event: HermesGatewayEvent) {
  const payload = event.payload as Record<string, unknown> | undefined;
  return (
    stringValue(payload?.id) ??
    stringValue(payload?.call_id) ??
    stringValue(payload?.tool_call_id) ??
    stringValue(payload?.name) ??
    `tool:${event.type}:${(event as LiveHermesEvent).receivedAt}`
  );
}

function isClarifyToolEvent(event: HermesGatewayEvent) {
  const payload = event.payload as Record<string, unknown> | undefined;
  const name =
    stringValue(payload?.name) ??
    stringValue(payload?.tool_name) ??
    stringValue(payload?.tool);
  return name?.toLowerCase() === "clarify";
}

function completePendingClarifyParts(parts: AgentChatPart[]) {
  const pending = [...parts]
    .reverse()
    .find(
      (part): part is AgentChatClarifyPart =>
        part.type === "clarify" && part.status === "pending",
    );
  if (pending) pending.status = "resolved";
}

function toolEventStatus(
  event: HermesGatewayEvent,
): AgentChatToolPart["status"] {
  if (event.type.includes("complete")) return "complete";
  if (event.type.includes("error") || event.type.includes("fail"))
    return "failed";
  return "running";
}

function toolStatus(status: AgentToolEventStatus): AgentChatToolPart["status"] {
  if (status === "completed") return "complete";
  if (status === "failed" || status === "blocked") return "failed";
  return "running";
}

function partText(part: AgentChatPart) {
  if (part.type === "tool") return part.text;
  if (part.type === "approval") return part.command || part.description;
  if (part.type === "clarify")
    return [part.question, part.answer ?? ""].join(" ");
  return part.text;
}

function approvalChoiceValue(value: unknown): AgentApprovalChoice | undefined {
  if (
    value === "once" ||
    value === "session" ||
    value === "always" ||
    value === "deny"
  ) {
    return value;
  }
  return undefined;
}

function appendMessageText(current: string, next: string) {
  if (!next.trim()) return current;
  if (!current) return next;
  if (next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;
  return `${current}${next}`;
}

function completeMessageText(current: string, complete: string) {
  if (!complete.trim()) return current;
  if (!current.trim()) return complete;
  if (complete.trim() === current.trim()) return current;
  if (complete.includes(current.trim()) || complete.length >= current.length)
    return complete;
  return appendMessageText(current, complete);
}

function collapseRepeatedMessageText(value: string) {
  let text = value.trim();
  if (!text) return "";

  for (;;) {
    const match = text.match(/^([\s\S]+?)\s+\1$/);
    if (!match?.[1]) break;
    text = match[1].trim();
  }

  const paragraphs = text.split(/\n{2,}/);
  const dedupedParagraphs = paragraphs.filter((paragraph, index) => {
    if (index === 0) return true;
    return !sameMessageText(paragraph, paragraphs[index - 1] ?? "");
  });
  text = dedupedParagraphs.join("\n\n").trim();

  const lines = text.split("\n");
  const dedupedLines = lines.filter((line, index) => {
    if (index === 0) return true;
    return !sameMessageText(line, lines[index - 1] ?? "");
  });
  text = dedupedLines.join("\n").trim();

  const half = Math.floor(text.length / 2);
  const left = text.slice(0, half).trim();
  const right = text.slice(half).trim();
  if (left && sameMessageText(left, right)) return left;

  return text;
}

function sameMessageText(left: string, right: string) {
  return left.replace(/\s+/g, " ").trim() === right.replace(/\s+/g, " ").trim();
}

function appendLogText(current: string, next: string) {
  if (!next.trim()) return current;
  if (!current) return next;
  if (current.endsWith(next)) return current;
  const separator =
    /\n$/.test(current) || /^\s/.test(next) || /^[.,!?;:]/.test(next)
      ? ""
      : "\n";
  return `${current}${separator}${next}`;
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringValue(value: unknown, preserveWhitespace = false) {
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    return preserveWhitespace ? value : value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return undefined;
}

function timestampString(value: unknown) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds =
      value > 0 && value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return new Date().toISOString();
}

function humanizeToolName(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
