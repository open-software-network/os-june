import {
  displayedComposerUserMessageText,
  textFromHermesContent,
} from "../../lib/agent-chat-runtime";
import type { AgentSessionStatusKind } from "../../lib/agent-events";
import { hermesActivityStore, type AgentActivityRecord } from "../../lib/hermes-activity-store";
import { stripScheduledRunPreamble, sessionTimestamp } from "../../lib/hermes-adapter";
import type { JuneHermesEvent } from "../../lib/hermes-control-plane";
import { stripProjectContext } from "../../lib/agent-project-context";
import { toolActivitySentence } from "../../lib/agent-tool-labels";
import type { HermesSessionInfo, HermesSessionMessage } from "../../lib/tauri";

function sameVisibleMessageText(left: string, right: string) {
  return left.replace(/\s+/g, " ").trim() === right.replace(/\s+/g, " ").trim();
}

function stripHermesVisibleContext(value: string) {
  const withoutProjectContext = stripProjectContext(value);
  const withoutWarnings = withoutProjectContext.replace(/\n*--- Context Warnings ---[\s\S]*$/m, "");
  const marker = withoutWarnings.search(/\n*--- Attached Context ---/m);
  const visible = marker >= 0 ? withoutWarnings.slice(0, marker) : withoutWarnings;
  // Drop the scheduled-run delivery preamble so a routine's title and dedup
  // key come from its actual prompt, not the cron scaffolding.
  return stripScheduledRunPreamble(visible.trim());
}

export function mergeActiveHermesSessions(
  fresh: HermesSessionInfo[],
  current: HermesSessionInfo[],
  options: {
    selectedSessionId?: string;
    workingSessionIds: Set<string>;
    waitingSessionIds: Set<string>;
    pendingMessages: Record<string, HermesSessionMessage[]>;
    defaultModelId?: string;
  },
) {
  const currentById = new Map(current.map((session) => [session.id, session]));
  const defaultModelId = options.defaultModelId?.trim();
  const mergedFresh = fresh.map((session) => {
    if (session.model?.trim()) return session;
    const currentModel = currentById.get(session.id)?.model?.trim();
    if (currentModel) return { ...session, model: currentModel };
    return defaultModelId ? { ...session, model: defaultModelId } : session;
  });
  const seen = new Set(mergedFresh.map((session) => session.id));
  const retained = current.filter(
    (session) => !seen.has(session.id) && shouldRetainHermesSessionId(session.id, options),
  );
  return [...mergedFresh, ...retained].sort((a, b) =>
    sessionTimestamp(b).localeCompare(sessionTimestamp(a)),
  );
}

function shouldRetainHermesSessionId(
  sessionId: string,
  {
    pendingMessages,
    selectedSessionId,
    waitingSessionIds,
    workingSessionIds,
  }: {
    selectedSessionId?: string;
    workingSessionIds: Set<string>;
    waitingSessionIds: Set<string>;
    pendingMessages: Record<string, HermesSessionMessage[]>;
  },
) {
  return (
    sessionId === selectedSessionId ||
    workingSessionIds.has(sessionId) ||
    waitingSessionIds.has(sessionId) ||
    (pendingMessages[sessionId]?.length ?? 0) > 0
  );
}

// Hermes may persist timestamps with second precision while pending entries
// carry millisecond ISO strings, so allow a little backward skew when deciding
// whether a persisted message is the stored copy of a pending one.
const PENDING_MATCH_SKEW_MS = 1500;

export function retainUnpersistedPendingMessages(
  pending: HermesSessionMessage[],
  persisted: HermesSessionMessage[],
) {
  return pending.filter((pendingMessage) => {
    const pendingAt = hermesMessageTimestampMs(pendingMessage);
    return !persisted.some((message) => {
      if (message.role !== pendingMessage.role) return false;
      if (
        !sameVisibleMessageText(
          visibleHermesMessageText(message),
          visibleHermesMessageText(pendingMessage),
        )
      ) {
        return false;
      }
      if (pendingAt === undefined) return true;
      // Only a message persisted at/after the pending send can be its stored
      // copy — an older identical message (e.g. a re-sent "continue") must
      // not swallow the new pending entry and fake a completed turn.
      const persistedAt = hermesMessageTimestampMs(message);
      return persistedAt === undefined || persistedAt >= pendingAt - PENDING_MATCH_SKEW_MS;
    });
  });
}

export function hermesMessageTimestampMs(message: HermesSessionMessage) {
  const raw = message.timestamp ?? message.created_at;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number") {
    // Hermes sometimes reports epoch seconds rather than milliseconds.
    return raw > 1e12 ? raw : raw * 1000;
  }
  const parsed = Date.parse(String(raw));
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function sessionHasAssistantAfterLatestUser(messages: HermesSessionMessage[]) {
  let latestUserIndex = -1;
  let latestAssistantIndex = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") {
      latestUserIndex = index;
    } else if (message.role === "assistant") {
      latestAssistantIndex = index;
    }
  });
  if (latestAssistantIndex < 0) return false;
  if (latestUserIndex < 0) return true;
  return latestAssistantIndex > latestUserIndex;
}

// A session whose latest message is a recent user prompt with no assistant
// reply yet is treated as an in-flight run — e.g. the workspace was unmounted
// mid-run (navigation) or the gateway dropped — so working state and the poll
// are re-armed to catch the conversation up. The recency window keeps long-
// abandoned sessions (a trailing "thanks" from days ago) from spinning.
const RESUME_ACTIVITY_WINDOW_MS = 15 * 60 * 1000;

export function shouldResumeSessionActivity(messages: HermesSessionMessage[]) {
  if (sessionHasAssistantAfterLatestUser(messages)) return false;
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  if (!latestUser) return false;
  const sentAt = hermesMessageTimestampMs(latestUser);
  return sentAt !== undefined && Date.now() - sentAt < RESUME_ACTIVITY_WINDOW_MS;
}

export function sessionHasActiveWork(
  sessionId: string,
  workingSessionIds: Set<string>,
  waitingSessionIds: Set<string>,
  liveEvents: Record<string, JuneHermesEvent[]>,
) {
  return (
    workingSessionIds.has(sessionId) ||
    waitingSessionIds.has(sessionId) ||
    (liveEvents[sessionId]?.length ?? 0) > 0
  );
}

export type AgentActivityLevelProjection = {
  workingSessionIds: Set<string>;
  waitingSessionIds: Set<string>;
  toolCallSessionIds: Set<string>;
};

export function projectAgentActivityLevels(
  records: AgentActivityRecord[],
  previous?: AgentActivityLevelProjection,
): AgentActivityLevelProjection {
  const workingSessionIds = new Set<string>();
  const waitingSessionIds = new Set<string>();
  const toolCallSessionIds = new Set<string>();
  for (const record of records) {
    if (record.pendingActionCount > 0 || record.phase === "waiting") {
      waitingSessionIds.add(record.sessionId);
    } else if (record.phase === "running" || record.phase === "background") {
      workingSessionIds.add(record.sessionId);
    }
    if (record.currentTool) {
      toolCallSessionIds.add(record.sessionId);
    }
  }
  return {
    workingSessionIds: stableSet(workingSessionIds, previous?.workingSessionIds),
    waitingSessionIds: stableSet(waitingSessionIds, previous?.waitingSessionIds),
    toolCallSessionIds: stableSet(toolCallSessionIds, previous?.toolCallSessionIds),
  };
}

function stableSet(next: Set<string>, previous: Set<string> | undefined): Set<string> {
  if (!previous || previous.size !== next.size) return next;
  for (const value of next) {
    if (!previous.has(value)) return next;
  }
  return previous;
}

export function agentActivityCountsFromStore() {
  const projection = projectAgentActivityLevels(hermesActivityStore.getRecords());
  return {
    activeCount: projection.workingSessionIds.size + projection.waitingSessionIds.size,
    needsUserCount: projection.waitingSessionIds.size,
  };
}

function lifecycleStatusLooksRunning(event: Extract<JuneHermesEvent, { kind: "lifecycle" }>) {
  return event.flavor === "running";
}

export function agentStatusFromHermesEvent(
  event: JuneHermesEvent,
  hasOpenPendingAction = false,
): AgentSessionStatusKind | undefined {
  if (event.kind === "error") return "failed";
  if (event.kind === "pending_action") return "waitingForUser";
  if (event.kind === "pending_action_resolution" || event.kind === "pending_action_expiration") {
    return hasOpenPendingAction ? "waitingForUser" : "running";
  }
  if (event.kind === "transcript" && event.complete) {
    return event.failed ? "failed" : "completed";
  }
  if (event.kind === "lifecycle" && event.flavor === "terminal") {
    const status = event.status.toLowerCase();
    if (/(?:cancel|stop|interrupt|abort)/.test(status)) return "cancelled";
    if (/(?:fail|error|timeout)/.test(status)) return "failed";
    return "completed";
  }
  if (
    event.kind === "tool" ||
    event.kind === "reasoning" ||
    // Only a turn START flips status (delta === undefined). Text deltas never
    // re-dispatched status on the raw path either — per-chunk dispatch would
    // churn app state on every streamed token.
    (event.kind === "transcript" && !event.complete && event.delta === undefined) ||
    (event.kind === "lifecycle" && lifecycleStatusLooksRunning(event))
  ) {
    return "running";
  }
  return undefined;
}

export function agentStatusSummaryFromHermesEvent(
  event: JuneHermesEvent,
  status: AgentSessionStatusKind,
) {
  if (status === "waitingForUser") {
    if (event.kind !== "pending_action") return "June has a question.";
    // Sudo and secret deliberately keep the generic sentence for visible-copy parity with main.
    return event.action.kind === "approval" ? "June needs approval." : "June has a question.";
  }
  if (status === "completed") return "June finished.";
  if (status === "failed") {
    return event.kind === "error" ? event.message || "June hit a problem." : "June hit a problem.";
  }
  if (event.kind === "lifecycle") {
    return event.text || "June is working.";
  }
  if (event.kind === "tool") {
    return toolActivitySentence(event.name, event.sanitizedPayload);
  }
  if (event.kind === "reasoning") {
    return "Thinking.";
  }
  return "June is working.";
}

export function visibleHermesMessageText(message: HermesSessionMessage | undefined) {
  if (!message) return "";
  const text = textFromHermesContent(message.content) ?? textFromHermesContent(message.text) ?? "";
  return displayedComposerUserMessageText(stripHermesVisibleContext(text));
}
