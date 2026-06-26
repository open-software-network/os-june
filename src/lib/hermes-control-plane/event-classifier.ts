import type { HermesGatewayEvent } from "../hermes-gateway";
import type {
  BackgroundHermesActivity,
  BackgroundHermesPhase,
  JuneHermesEvent,
  PendingHermesAction,
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
      return classifyTranscript(type, sessionId, payload);

    case "thinking.delta":
    case "reasoning.delta":
      return {
        kind: "reasoning",
        sessionId: sessionId ?? "",
        delta: rawDeltaText(payload),
      };

    case "tool.start":
    case "tool.progress":
    case "tool.complete":
      return classifyTool(type, sessionId, payload);

    case "clarify.request":
    case "approval.request":
    case "sudo.request":
    case "secret.request":
      return {
        kind: "pending_action",
        sessionId: sessionId ?? "",
        action: classifyPendingAction(type, payload, receivedAt),
      };

    case "error":
      return classifyError(sessionId, payload);

    default:
      break;
  }

  if (type.startsWith("subagent.")) {
    return classifyBackgroundActivity(type, sessionId, payload, receivedAt);
  }

  if (isLifecycleType(type)) {
    return {
      kind: "lifecycle",
      sessionId,
      status: lifecycleStatus(type, payload),
      payload: payload ? sanitizePayload(payload) : undefined,
    };
  }

  return {
    kind: "unsupported",
    sessionId,
    rawType: type || undefined,
    sanitizedPayload:
      payload === undefined ? undefined : sanitizePayload(payload),
  };
}

function classifyTranscript(
  type: string,
  sessionId: string | undefined,
  payload: RawHermesPayload | undefined,
): JuneHermesEvent {
  const complete = type === "message.complete";
  const delta =
    type === "message.delta"
      ? rawDeltaText(payload)
      : complete
        ? rawCompleteText(payload)
        : undefined;
  return {
    kind: "transcript",
    sessionId: sessionId ?? "",
    messageId:
      stringValue(payload?.message_id) ?? stringValue(payload?.messageId),
    delta,
    complete,
    role: messageRole(payload),
  };
}

function classifyTool(
  type: string,
  sessionId: string | undefined,
  payload: RawHermesPayload | undefined,
): JuneHermesEvent {
  const phase =
    type === "tool.start"
      ? "start"
      : type === "tool.progress"
        ? "progress"
        : "complete";
  return {
    kind: "tool",
    sessionId: sessionId ?? "",
    toolCallId:
      stringValue(payload?.tool_call_id) ??
      stringValue(payload?.toolCallId) ??
      stringValue(payload?.call_id) ??
      stringValue(payload?.id),
    phase,
    name:
      stringValue(payload?.name) ??
      stringValue(payload?.tool_name) ??
      stringValue(payload?.tool),
    // Tool cards render arguments/output, so keep the payload — sanitized, in
    // case a tool's args happen to embed a secret.
    payload: payload === undefined ? undefined : sanitizePayload(payload),
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
        description:
          stringValue(payload?.description, true) ??
          stringValue(payload?.command, true),
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
          stringValue(payload?.question, true) ??
          "Hermes needs clarification before continuing.",
        choices: optionalStringArray(payload?.choices),
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
      stringValue(payload?.parent_session_id) ??
      stringValue(payload?.parentSessionId) ??
      sessionId,
    phase: subagentPhase(type),
    goal: stringValue(payload?.goal, true),
    currentTool:
      stringValue(payload?.tool_name) ??
      stringValue(payload?.tool) ??
      stringValue(payload?.name),
    resultPreview:
      stringValue(payload?.summary, true) ??
      stringValue(payload?.tool_preview, true) ??
      stringValue(payload?.text, true),
    lastEventAt: receivedAt,
  };
  return {
    kind: "background_activity",
    sessionId: sessionId ?? subagentId,
    activity,
  };
}

function classifyError(
  sessionId: string | undefined,
  payload: RawHermesPayload | undefined,
): JuneHermesEvent {
  return {
    kind: "error",
    sessionId,
    // The human-readable message is safe to surface; everything else stays out
    // unless explicitly modeled, so a secret in some other field can't leak.
    message:
      stringValue(payload?.message, true) ??
      stringValue(payload?.text, true) ??
      "The agent reported an error.",
    code: numberValue(payload?.code),
    recoverable:
      typeof payload?.recoverable === "boolean"
        ? payload.recoverable
        : undefined,
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

function subagentPhase(type: string): BackgroundHermesPhase {
  const subtype = type.slice("subagent.".length).toLowerCase();
  if (subtype in SUBAGENT_PHASES) return SUBAGENT_PHASES[subtype];
  // Unknown subagent subtype: classify by failure-flavored keywords, else
  // treat as progress so the row still updates rather than vanishing.
  if (/fail|error|cancel|timeout|abort|interrupt/.test(subtype)) return "error";
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
]);

function isLifecycleType(type: string): boolean {
  return LIFECYCLE_TYPES.has(type) || type.startsWith("lifecycle.");
}

function lifecycleStatus(
  type: string,
  payload: RawHermesPayload | undefined,
): string {
  return stringValue(payload?.status, true) ?? type;
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

function rawCompleteText(
  payload: RawHermesPayload | undefined,
): string | undefined {
  for (const key of ["text", "message", "content", "delta"] as const) {
    const value = payload?.[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function receivedAtOf(raw: HermesGatewayEvent): string {
  const candidate = (raw as { receivedAt?: unknown }).receivedAt;
  if (typeof candidate === "string" && candidate) return candidate;
  return new Date().toISOString();
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string => typeof item === "string",
  );
  return items.length ? items : undefined;
}

function stringValue(
  value: unknown,
  preserveWhitespace = false,
): string | undefined {
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
