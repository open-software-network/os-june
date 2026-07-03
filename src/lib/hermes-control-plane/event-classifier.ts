import type { HermesGatewayEvent } from "../hermes-gateway";
import type {
  BackgroundHermesActivity,
  BackgroundHermesPhase,
  JuneHermesEvent,
  PendingHermesAction,
  PendingHermesActionResolution,
} from "./events";
import { parseHermesMode } from "./events";
import type { RawHermesPayload } from "./raw-types";
import { sanitizePayload } from "./sanitize";

/**
 * Turns one raw Hermes gateway frame into exactly one typed
 * {@link JuneHermesEvent}. EXHAUSTIVE and total: every known raw type maps to a
 * specific kind, and anything unrecognized maps to `unsupported` (carrying the
 * raw type and a sanitized payload) — it never returns `undefined` and never
 * silently drops an event. This is the only place raw payloads are read.
 *
 * Adding a new event family: give it a branch here that returns a typed kind,
 * and extend the relevant union in `events.ts`. Until then a new raw type flows
 * through as `unsupported`, which is visible and safe rather than dropped.
 */
export function classifyHermesEvent(raw: HermesGatewayEvent): JuneHermesEvent {
  const type = typeof raw?.type === "string" ? raw.type : "";
  const sessionId = stringValue(raw?.session_id);
  const payload = (raw?.payload ?? undefined) as RawHermesPayload | undefined;
  const receivedAt = receivedAtOf(raw);

  switch (type) {
    case "message.start":
    case "message.delta":
    case "message.complete":
      return classifyTranscript(type, sessionId, payload, receivedAt);

    case "thinking.delta":
    case "reasoning.delta":
      return {
        kind: "reasoning",
        sessionId: sessionId ?? "",
        delta: rawDeltaText(payload),
        receivedAt,
      };

    case "thinking.available":
    case "reasoning.available":
      // The one-shot "full reasoning text is ready" frame (whole-block
      // reasoning models emit it instead of, or after, streamed deltas).
      // `full` tells consumers to replace the thought text, not append it.
      return {
        kind: "reasoning",
        sessionId: sessionId ?? "",
        delta: rawDeltaText(payload),
        full: true,
        receivedAt,
      };

    case "clarify.request":
    case "approval.request":
    case "sudo.request":
    case "secret.request":
      return {
        kind: "pending_action",
        sessionId: sessionId ?? "",
        action: classifyPendingAction(type, payload, receivedAt),
        receivedAt,
      };

    case "clarify.response":
    case "approval.response":
    case "sudo.response":
    case "secret.response":
      return {
        // Transcript rendering already resolves these cards; the typed seam
        // follows that visible behavior instead of treating responses as gaps.
        kind: "pending_action_resolution",
        sessionId: sessionId ?? "",
        action: classifyPendingActionResolution(type, payload, receivedAt),
        receivedAt,
      };

    case "error":
      return classifyError(sessionId, payload, receivedAt);

    default:
      break;
  }

  if (type.startsWith("tool.")) {
    return classifyTool(type, sessionId, payload, receivedAt);
  }

  if (type.startsWith("subagent.")) {
    return classifyBackgroundActivity(type, sessionId, payload, receivedAt);
  }

  if (isLifecycleType(type)) {
    return {
      kind: "lifecycle",
      sessionId,
      flavor: lifecycleFlavor(type),
      status: lifecycleStatus(type, payload),
      text: eventText(payload),
      payload: payload ? sanitizePayload(payload) : undefined,
      receivedAt,
    };
  }

  return {
    kind: "unsupported",
    sessionId,
    rawType: type || undefined,
    sanitizedPayload: payload === undefined ? undefined : sanitizePayload(payload),
    receivedAt,
  };
}

function classifyTranscript(
  type: string,
  sessionId: string | undefined,
  payload: RawHermesPayload | undefined,
  receivedAt: string,
): JuneHermesEvent {
  const complete = type === "message.complete";
  const delta =
    type === "message.delta" ? rawDeltaText(payload) : complete ? eventText(payload) : undefined;
  const failed = complete && stringValue(payload?.status)?.toLowerCase() === "error";
  return {
    kind: "transcript",
    sessionId: sessionId ?? "",
    messageId: stringValue(payload?.message_id) ?? stringValue(payload?.messageId),
    // Complete text follows the builder's nine-key visible-text chain, not the
    // old four-key classifier fallback, so summary/status-only turns survive.
    delta,
    complete,
    // The transcript builder gates failed-turn notices on message.complete
    // status=error; carry the same flag so the typed seam cannot drift.
    failed,
    role: messageRole(payload),
    receivedAt,
  };
}

function classifyTool(
  type: string,
  sessionId: string | undefined,
  payload: RawHermesPayload | undefined,
  receivedAt: string,
): JuneHermesEvent {
  const sanitizedPayload = payload === undefined ? undefined : sanitizePayload(payload);
  return {
    kind: "tool",
    sessionId: sessionId ?? "",
    toolCallId:
      stringValue(payload?.tool_call_id) ??
      stringValue(payload?.toolCallId) ??
      stringValue(payload?.call_id) ??
      stringValue(payload?.id),
    // The builder treats failure-flavored tool event names as terminal failed,
    // while unknown tool.* names still update the in-flight row as progress.
    phase: toolPhase(type),
    // Transcript dedupe keys prefer tool_id/id before tool_call_id; toolCallId
    // intentionally keeps the store-oriented precedence above.
    key: toolEventKey(type, payload, receivedAt),
    name:
      stringValue(payload?.name) ?? stringValue(payload?.tool_name) ?? stringValue(payload?.tool),
    // Tool output text uses the same broad visible-text chain as the transcript
    // builder so complete/status-only tool frames do not disappear.
    text: eventText(payload),
    // Clarify tool calls are action-card plumbing in the builder, not tool rows.
    isClarify: isClarifyTool(payload),
    // Tool cards render arguments/output, so keep the sanitized payload in case
    // a tool's args happen to embed a secret.
    sanitizedPayload,
    receivedAt,
  };
}

function classifyPendingAction(
  type: string,
  payload: RawHermesPayload | undefined,
  receivedAt: string,
): PendingHermesAction {
  const requestId = requestIdOf(payload, type, receivedAt);
  switch (type) {
    case "approval.request":
      return {
        kind: "approval",
        requestId,
        toolName:
          stringValue(payload?.tool_name) ??
          stringValue(payload?.tool) ??
          stringValue(payload?.name),
        command: stringValue(payload?.command, true),
        description: stringValue(payload?.description, true) ?? stringValue(payload?.command, true),
        // Approval cards already allow permanence unless Hermes explicitly says
        // false; expose the same default instead of burying it in raw details.
        allowPermanent: payload?.allow_permanent !== false,
        // Approval cards may show structured details; sanitize defensively.
        payload: payload === undefined ? undefined : sanitizePayload(payload),
      };
    case "sudo.request":
      return {
        kind: "sudo",
        requestId,
        command: stringValue(payload?.command, true),
        reason: stringValue(payload?.reason, true),
        mode: parseHermesMode(payload?.mode),
      };
    case "secret.request":
      // Only metadata about which secret is wanted ever leaves this function —
      // never the value, even if the gateway erroneously included it.
      return {
        kind: "secret",
        requestId,
        keyName:
          stringValue(payload?.key_name) ??
          stringValue(payload?.keyName) ??
          stringValue(payload?.key) ??
          stringValue(payload?.name),
        reason: stringValue(payload?.reason, true),
        redacted: true,
      };
    default:
      // "clarify.request" and any future *.request the dispatcher routes here.
      return {
        kind: "clarify",
        requestId,
        question:
          stringValue(payload?.question, true) ?? "Hermes needs clarification before continuing.",
        choices: optionalStringArray(payload?.choices),
      };
  }
}

function classifyPendingActionResolution(
  type: string,
  payload: RawHermesPayload | undefined,
  receivedAt: string,
): PendingHermesActionResolution {
  const requestId = requestIdOf(payload, type, receivedAt);
  switch (type) {
    case "approval.response":
      return {
        kind: "approval",
        requestId,
        command: stringValue(payload?.command, true) ?? "",
        description: stringValue(payload?.description, true) ?? "",
        // The builder treats only explicit false as disallowing permanence.
        allowPermanent: payload?.allow_permanent !== false,
        choice: approvalChoiceValue(payload?.choice),
      };
    case "sudo.response":
      return {
        kind: "sudo",
        requestId,
        mode: parseHermesMode(payload?.mode),
        // Hermes spells this `granted`; `approved` is accepted because the
        // transcript builder already resolves cards from either gateway shape.
        granted: booleanValue(payload?.granted) ?? booleanValue(payload?.approved),
      };
    case "secret.response":
      // Metadata only: never read `value`/`api_key`, even if a gateway echoes
      // them, so the secret cannot cross the normalized event boundary.
      return {
        kind: "secret",
        requestId,
        keyName:
          stringValue(payload?.key_name) ??
          stringValue(payload?.keyName) ??
          stringValue(payload?.key) ??
          stringValue(payload?.name),
        reason: stringValue(payload?.reason, true),
        redacted: true,
      };
    default:
      return {
        kind: "clarify",
        requestId,
        question: stringValue(payload?.question, true) ?? "",
        choices: stringArrayValue(payload?.choices),
        answer: stringValue(payload?.answer, true) ?? "",
      };
  }
}

function classifyBackgroundActivity(
  type: string,
  sessionId: string | undefined,
  payload: RawHermesPayload | undefined,
  receivedAt: string,
): JuneHermesEvent {
  const subagentId =
    stringValue(payload?.subagent_id) ??
    stringValue(payload?.subagentId) ??
    stringValue(payload?.handle) ??
    stringValue(payload?.id) ??
    "subagent";
  const activity: BackgroundHermesActivity = {
    subagentId,
    handle: stringValue(payload?.handle),
    parentSessionId:
      stringValue(payload?.parent_session_id) ?? stringValue(payload?.parentSessionId) ?? sessionId,
    // The transcript builder treats payload.status failure words as terminal
    // even when the subtype is only progress; keep the control plane aligned.
    phase: subagentPhase(type, payload),
    goal: stringValue(payload?.goal, true),
    currentTool:
      stringValue(payload?.tool_name) ?? stringValue(payload?.tool) ?? stringValue(payload?.name),
    resultPreview:
      stringValue(payload?.summary, true) ??
      stringValue(payload?.tool_preview, true) ??
      stringValue(payload?.text, true),
    taskIndex: numberField(payload?.task_index),
    taskCount: numberField(payload?.task_count),
    lastEventAt: receivedAt,
  };
  return {
    kind: "background_activity",
    sessionId: sessionId ?? subagentId,
    activity,
    receivedAt,
  };
}

function classifyError(
  sessionId: string | undefined,
  payload: RawHermesPayload | undefined,
  receivedAt: string,
): JuneHermesEvent {
  return {
    kind: "error",
    sessionId,
    // Main already rendered the broad visible-text chain for error frames; keep
    // that user-facing text while leaving every unmodeled field out.
    message: eventText(payload) || "The agent reported an error.",
    code: numberValue(payload?.code),
    recoverable: typeof payload?.recoverable === "boolean" ? payload.recoverable : undefined,
    receivedAt,
  };
}

const SUBAGENT_PHASES: Record<string, BackgroundHermesPhase> = {
  start: "start",
  progress: "progress",
  tool: "tool",
  thinking: "thinking",
  complete: "complete",
  error: "error",
  blocked: "blocked",
};

const FAILURE_WORD = /fail|error|cancel|timeout|abort|interrupt/;

function subagentPhase(type: string, payload: RawHermesPayload | undefined): BackgroundHermesPhase {
  const subtype = type.slice("subagent.".length).toLowerCase();
  const reportedStatus = stringValue(payload?.status)?.toLowerCase() ?? "";
  if (FAILURE_WORD.test(subtype)) return "error";
  if (FAILURE_WORD.test(reportedStatus)) return "error";
  if (subtype in SUBAGENT_PHASES) return SUBAGENT_PHASES[subtype];
  // Unknown subagent subtype: classify by failure-flavored keywords, else
  // treat as progress so the row still updates rather than vanishing.
  if (subtype === "done") return "complete";
  return "progress";
}

const LIFECYCLE_TYPES = new Set([
  "gateway.ready",
  "session.info",
  "status.update",
  "session.start",
  "session.complete",
  "session.completed",
  "message.completed",
  // Workspace terminal detection predates the union; these raw frames are
  // lifecycle-flavored terminals even though they are not session.* names.
  "turn.complete",
  "turn.completed",
  "background.complete",
  "background.completed",
]);

function isLifecycleType(type: string): boolean {
  return LIFECYCLE_TYPES.has(type) || type.startsWith("lifecycle.");
}

function lifecycleStatus(type: string, payload: RawHermesPayload | undefined): string {
  return stringValue(payload?.status, true) ?? type;
}

function lifecycleFlavor(type: string): Extract<JuneHermesEvent, { kind: "lifecycle" }>["flavor"] {
  switch (type.toLowerCase()) {
    // Intentional extension beyond main's terminal type list: main never tore
    // down on lifecycle.complete, but June's typed lifecycle union does.
    case "lifecycle.complete":
    case "lifecycle.completed":
    case "message.completed":
    case "turn.complete":
    case "turn.completed":
    case "session.complete":
    case "session.completed":
    case "background.complete":
    case "background.completed":
      return "terminal";
    case "status.update":
      return "running";
    default:
      return "info";
  }
}

function requestIdOf(
  payload: RawHermesPayload | undefined,
  type: string,
  receivedAt: string,
): string {
  return (
    stringValue(payload?.request_id) ??
    stringValue(payload?.requestId) ??
    stringValue(payload?.id) ??
    `${type}:${receivedAt}`
  );
}

function messageRole(
  payload: RawHermesPayload | undefined,
): "assistant" | "user" | "system" | undefined {
  const role = stringValue(payload?.role);
  if (role === "assistant" || role === "user" || role === "system") return role;
  return undefined;
}

// Streaming deltas (and the authoritative complete text) must be appended
// verbatim, including whitespace-only chunks, so this preserves whitespace —
// mirroring `deltaEventText` in agent-chat-runtime.
function rawDeltaText(payload: RawHermesPayload | undefined): string {
  for (const key of ["text", "delta", "message", "content"] as const) {
    const value = payload?.[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function eventText(payload: RawHermesPayload | undefined): string {
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
  ] as const) {
    const value = stringValue(
      payload[key],
      key === "text" || key === "delta" || key === "message" || key === "content",
    );
    if (value) return value;
  }
  return "";
}

function toolPhase(type: string): Extract<JuneHermesEvent, { kind: "tool" }>["phase"] {
  const normalized = type.toLowerCase();
  if (normalized.includes("complete")) return "complete";
  if (normalized.includes("error") || normalized.includes("fail")) return "failed";
  return normalized === "tool.start" ? "start" : "progress";
}

function toolEventKey(
  type: string,
  payload: RawHermesPayload | undefined,
  receivedAt: string,
): string {
  return (
    stringValue(payload?.tool_id) ??
    stringValue(payload?.id) ??
    stringValue(payload?.call_id) ??
    stringValue(payload?.tool_call_id) ??
    stringValue(payload?.name) ??
    `tool:${type}:${receivedAt}`
  );
}

function isClarifyTool(payload: RawHermesPayload | undefined): boolean {
  const name =
    stringValue(payload?.name) ?? stringValue(payload?.tool_name) ?? stringValue(payload?.tool);
  return name?.toLowerCase() === "clarify";
}

function receivedAtOf(raw: HermesGatewayEvent): string {
  const candidate = (raw as { receivedAt?: unknown }).receivedAt;
  if (typeof candidate === "string" && candidate) return candidate;
  return new Date().toISOString();
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length ? items : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringValue(value: unknown, preserveWhitespace = false): string | undefined {
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    return preserveWhitespace ? value : value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

type ApprovalChoice = Extract<PendingHermesActionResolution, { kind: "approval" }>["choice"];

function approvalChoiceValue(value: unknown): ApprovalChoice {
  if (value === "once" || value === "session" || value === "always" || value === "deny") {
    return value;
  }
  return undefined;
}
