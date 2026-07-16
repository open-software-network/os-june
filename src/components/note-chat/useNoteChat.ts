import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildHermesSessionChatTurns,
  displayedComposerUserMessageText,
  textFromHermesContent,
  type AgentChatTurn,
} from "../../lib/agent-chat-runtime";
import { withTimeout } from "../../lib/async-timeout";
import { messageFromError } from "../../lib/errors";
import { listHermesSessions } from "../../lib/hermes-adapter";
import { hermesConnectionForMode } from "../../lib/hermes-connection";
import { classifyHermesEvent } from "../../lib/hermes-control-plane/event-classifier";
import { createHermesMethods } from "../../lib/hermes-control-plane/methods";
import { isTerminalHermesEvent, type JuneHermesEvent } from "../../lib/hermes-control-plane/events";
import { isHermesFeatureSupported } from "../../lib/hermes-control-plane/compatibility/support";
import { HermesGatewayClient, isSessionBusyError } from "../../lib/hermes-gateway";
import {
  appendHermesLiveEvent,
  createHermesLiveStream,
  hermesLiveEvents,
  reconcileHermesLiveStream,
  type HermesLiveStream,
} from "../../lib/hermes-live-stream";
import { applySessionModelWhenIdle } from "../../lib/hermes-next-prompt-model";
import {
  agentRunMonitorSnapshot,
  canAttributeUntaggedAgentRun,
  cancelAgentRunMonitoring,
  isAgentRunMonitorGenerationCurrent,
  markAgentRunSucceeded,
  preserveAgentRunTerminalEvidence,
  startAgentRunMonitoring,
  stopAgentRunMonitoring,
  type AgentRunTerminalEvidence,
} from "../../lib/agent-run-monitor";
import {
  AGENT_RUN_SETTLED_EVENT,
  AGENT_RUN_STARTED_EVENT,
  AGENT_SESSION_STATUS_EVENT,
  dispatchAgentSessionStatus,
  type AgentRunSettledDetail,
  type AgentRunStartedDetail,
  type AgentSessionStatusDetail,
} from "../../lib/agent-events";
import {
  holdHermesSessionDispatch,
  reserveHermesSessionDispatch,
  type HermesSessionDispatchReservation,
} from "../../lib/hermes-session-dispatch-mutex";
import {
  AUTO_MODEL_ID,
  decodeHermesModelSelection,
  hasPendingSessionModelSelection,
  hermesModelIdForSelection,
  markSessionModelSelectionApplied,
  readSessionModelSelections,
  rememberAppliedSessionModelSelection,
  stageSessionModelSelection,
  subscribeSessionModelSelections,
  type SessionModelSelection,
} from "../../lib/hermes-session-model-selection";
import { localGenerationOptionId } from "../../lib/local-generation";
import {
  attachImageToSession,
  pendingImageAttachments,
  type HermesAttachmentState,
} from "../../lib/hermes-image-attach";
import {
  hermesBridgeImageDataUrl,
  hermesBridgeSessionMessages,
  hermesBridgeStatus,
  providerModelSettings,
  startHermesBridge,
  type HermesSessionMessage,
  type ImportedHermesFile,
} from "../../lib/tauri";
import { noteReferenceToken, type NoteReferenceInput } from "../agent/composer/noteReference";
import { noteChatSessionIdFor, rememberNoteChatSession } from "./noteChatSessions";

type HermesRuntimeSessionResponse = {
  session_id?: string;
  stored_session_id?: string;
};

class NoteChatSubmissionCancelledError extends Error {}

/** A file imported into the June workspace for this chat, plus its structured
 * attach state — the panel-side shape of the workspace's AgentAttachment. */
export type NoteChatAttachment = ImportedHermesFile & {
  id: string;
  attach: HermesAttachmentState;
};

/** The same path block the workspace appends, so the agent gets real,
 * readable workspace paths and the transcript strippers recognize it. */
function withAttachmentPaths(message: string, attachments: NoteChatAttachment[]): string {
  if (!attachments.length) return message;
  return [
    message || "Use the attached file(s).",
    "",
    "Attached files copied into the June workspace:",
    ...attachments.map(
      (attachment) =>
        `- ${attachment.name} (${attachment.rootLabel}): ${attachmentPromptPath(attachment.path)}`,
    ),
    "",
    "Use these file paths when inspecting or operating on the files.",
  ].join("\n");
}

function attachmentPromptPath(path: string) {
  const workspaceMatch = path.match(/(?:^|[/\\])workspace[/\\](.+)$/);
  if (workspaceMatch?.[1]) return workspaceMatch[1];
  return path;
}

/* One gateway client for every note chat, module-scoped so panels across
 * note switches share the socket instead of re-handshaking. Note chats are
 * always sandboxed — the panel is a reading/asking surface; escalation to
 * the full agent view is where mode choices live. The client is a SEPARATE
 * connection from AgentWorkspace's on purpose: the gateway serves multiple
 * sockets, and sharing the workspace's client would couple the panel to the
 * monolith's ref-managed lifecycle. */
let sharedGateway: HermesGatewayClient | null = null;
let sharedGatewayConnecting: Promise<HermesGatewayClient> | null = null;
type NoteChatIdlessTranscriptOrigin = {
  pendingUserTurn: AgentChatTurn;
  visibleSegments: string[];
  activeSegmentIndex?: number;
};

type NoteChatContinuityRecord = {
  liveStream: HermesLiveStream;
  messages: HermesSessionMessage[];
  pendingUserTurns: AgentChatTurn[];
  pendingUserPersistenceBoundaries: Map<string, NoteChatPersistenceBoundary>;
  unpersistedIdlessTranscriptOrigins: Map<string, NoteChatIdlessTranscriptOrigin>;
  hasUnattributedIdlessTranscript: boolean;
  runtimeSessionId?: string;
  working: boolean;
  terminalHandled: boolean;
  stopped: boolean;
  stoppedRuntimeSessionId?: string;
  stoppedRunMonitorGeneration?: number;
  terminalEventIds: string[];
  terminalFingerprints: string[];
  runAccepted: boolean;
  deferredPreAcceptanceTerminals: JuneHermesEvent[];
  currentRunPendingUserTurn?: AgentChatTurn;
  lastAcceptedRunPendingUserTurn?: AgentChatTurn;
  terminalAuthorityRunGeneration?: number;
  terminalAuthorityCandidates: JuneHermesEvent[];
  terminalEffectsRunGeneration?: number;
  runGeneration: number;
  runMonitorGeneration?: number;
  latestRunMonitorGeneration?: number;
  runtimeIntentEpoch: number;
  nextRefreshSequence: number;
  appliedRefreshSequence: number;
  persistedThroughRevision: number;
  mountedViews: number;
  messagesHydrated: boolean;
};

type NoteChatPersistenceBoundary = {
  persistedUserIds: Set<string>;
  persistedUserCount: number;
  historyWasHydrated: boolean;
  submittedAtMs: number;
  promptDispatchedAtMs?: number;
};

type RoutedNoteChatEvent = {
  storedSessionId: string;
  record: NoteChatContinuityRecord;
  terminalAccepted: boolean;
  transcriptCompletionAccepted: boolean;
  stoppedByUser: boolean;
};

type NoteChatRefreshSnapshot = {
  sequence: number;
  runGeneration: number;
  throughRevision: number;
};

type NoteChatContinuityUpdate = {
  noteId: string;
  storedSessionId?: string;
  record: NoteChatContinuityRecord;
};

const MAX_NOTE_CHAT_CONTINUITY_RECORDS = 20;
const MAX_NOTE_CHAT_TERMINAL_EVENT_IDS = 64;
const MAX_NOTE_CHAT_PRE_ACCEPTANCE_TERMINALS = 16;
const MAX_NOTE_CHAT_TERMINAL_AUTHORITY_CANDIDATES = 16;
const NOTE_CHAT_DISPATCH_SNAPSHOT_TIMEOUT_MS = 250;
const noteChatContinuityByStoredSessionId = new Map<string, NoteChatContinuityRecord>();
const provisionalNoteChatContinuityByNoteId = new Map<string, NoteChatContinuityRecord>();
const noteChatStoredSessionIdByRuntimeSessionId = new Map<string, string>();
const noteChatStoredSessionContinuityOrder: string[] = [];
const eventSubscribers = new Set<
  (event: JuneHermesEvent, route: RoutedNoteChatEvent | undefined) => void
>();
const continuitySubscribers = new Set<(update: NoteChatContinuityUpdate) => void>();
const gatewayCloseSubscribers = new Set<() => void>();
type NoteChatRuntimeResumeAttempt = {
  intentEpoch: number;
  promise: Promise<string | undefined>;
};

const runtimeResumeByStoredSessionId = new Map<string, NoteChatRuntimeResumeAttempt>();
const activeSubmissionByNoteId = new Map<string, symbol>();
let gatewayRecovery: Promise<void> | null = null;
let gatewayRecoveryRetryRequested = false;
let gatewayEpoch = 0;

function createNoteChatContinuityRecord(): NoteChatContinuityRecord {
  return {
    liveStream: createHermesLiveStream(),
    messages: [],
    pendingUserTurns: [],
    pendingUserPersistenceBoundaries: new Map(),
    unpersistedIdlessTranscriptOrigins: new Map(),
    hasUnattributedIdlessTranscript: false,
    working: false,
    terminalHandled: true,
    stopped: false,
    terminalEventIds: [],
    terminalFingerprints: [],
    runAccepted: true,
    deferredPreAcceptanceTerminals: [],
    terminalAuthorityCandidates: [],
    runGeneration: 0,
    runtimeIntentEpoch: 0,
    nextRefreshSequence: 0,
    appliedRefreshSequence: 0,
    persistedThroughRevision: 0,
    mountedViews: 0,
    messagesHydrated: false,
  };
}

function touchNoteChatContinuity(storedSessionId: string) {
  const priorIndex = noteChatStoredSessionContinuityOrder.indexOf(storedSessionId);
  if (priorIndex >= 0) noteChatStoredSessionContinuityOrder.splice(priorIndex, 1);
  noteChatStoredSessionContinuityOrder.push(storedSessionId);

  while (noteChatContinuityByStoredSessionId.size > MAX_NOTE_CHAT_CONTINUITY_RECORDS) {
    const evictionIndex = noteChatStoredSessionContinuityOrder.findIndex((candidate) => {
      const record = noteChatContinuityByStoredSessionId.get(candidate);
      return record !== undefined && safelyCompactedNoteChatContinuity(record);
    });
    if (evictionIndex < 0) return;
    const [evictedStoredSessionId] = noteChatStoredSessionContinuityOrder.splice(evictionIndex, 1);
    const evicted = noteChatContinuityByStoredSessionId.get(evictedStoredSessionId);
    if (evicted?.runtimeSessionId) {
      noteChatStoredSessionIdByRuntimeSessionId.delete(evicted.runtimeSessionId);
    }
    noteChatContinuityByStoredSessionId.delete(evictedStoredSessionId);
  }
}

function safelyCompactedNoteChatContinuity(record: NoteChatContinuityRecord) {
  return (
    record.mountedViews === 0 &&
    !record.working &&
    !record.messagesHydrated &&
    record.messages.length === 0 &&
    record.liveStream.revision === 0 &&
    record.pendingUserTurns.length === 0 &&
    record.pendingUserPersistenceBoundaries.size === 0 &&
    record.unpersistedIdlessTranscriptOrigins.size === 0 &&
    !record.hasUnattributedIdlessTranscript &&
    record.deferredPreAcceptanceTerminals.length === 0 &&
    record.currentRunPendingUserTurn === undefined &&
    record.terminalAuthorityCandidates.length === 0 &&
    record.terminalAuthorityRunGeneration === undefined
  );
}

function noteChatContinuityFor(storedSessionId: string): NoteChatContinuityRecord {
  let record = noteChatContinuityByStoredSessionId.get(storedSessionId);
  if (!record) {
    record = createNoteChatContinuityRecord();
    const monitor = agentRunMonitorSnapshot(storedSessionId);
    if (monitor) {
      record.latestRunMonitorGeneration = monitor.generation;
      record.runGeneration = 1;
      record.runAccepted = true;
      record.working = monitor.phase === "active";
      record.terminalHandled = monitor.phase !== "active";
      record.stopped = monitor.phase === "stopping";
      record.stoppedRunMonitorGeneration =
        monitor.phase === "stopping" ? monitor.generation : undefined;
      record.runtimeSessionId = monitor.phase === "active" ? monitor.runtimeSessionId : undefined;
      record.stoppedRuntimeSessionId =
        monitor.phase === "stopping" ? monitor.runtimeSessionId : undefined;
      if (record.runtimeSessionId) {
        noteChatStoredSessionIdByRuntimeSessionId.set(record.runtimeSessionId, storedSessionId);
      }
    }
    noteChatContinuityByStoredSessionId.set(storedSessionId, record);
  }
  touchNoteChatContinuity(storedSessionId);
  return record;
}

function provisionalNoteChatContinuityFor(noteId: string): NoteChatContinuityRecord {
  let record = provisionalNoteChatContinuityByNoteId.get(noteId);
  if (!record) {
    record = createNoteChatContinuityRecord();
    record.messagesHydrated = true;
    provisionalNoteChatContinuityByNoteId.set(noteId, record);
  }
  return record;
}

function adoptProvisionalNoteChatContinuity(
  noteId: string,
  storedSessionId: string,
  record: NoteChatContinuityRecord,
) {
  if (provisionalNoteChatContinuityByNoteId.get(noteId) === record) {
    provisionalNoteChatContinuityByNoteId.delete(noteId);
  }
  noteChatContinuityByStoredSessionId.set(storedSessionId, record);
  touchNoteChatContinuity(storedSessionId);
}

function notifyNoteChatContinuity(update: NoteChatContinuityUpdate) {
  for (const subscriber of [...continuitySubscribers]) subscriber(update);
}

function subscribeToNoteChatContinuity(subscriber: (update: NoteChatContinuityUpdate) => void) {
  continuitySubscribers.add(subscriber);
  return () => {
    continuitySubscribers.delete(subscriber);
  };
}

function registerNoteChatRuntimeSession(storedSessionId: string, runtimeSessionId: string) {
  const record = noteChatContinuityFor(storedSessionId);
  if (record.runtimeSessionId && record.runtimeSessionId !== runtimeSessionId) {
    noteChatStoredSessionIdByRuntimeSessionId.delete(record.runtimeSessionId);
  }
  record.runtimeSessionId = runtimeSessionId;
  noteChatStoredSessionIdByRuntimeSessionId.set(runtimeSessionId, storedSessionId);
}

function invalidateNoteChatRuntimeSessions() {
  noteChatStoredSessionIdByRuntimeSessionId.clear();
  for (const record of noteChatContinuityByStoredSessionId.values()) {
    record.runtimeSessionId = undefined;
  }
}

function storedSessionIdForEvent(event: JuneHermesEvent): string | undefined {
  const eventSessionId = "sessionId" in event ? event.sessionId : undefined;
  if (!eventSessionId) return undefined;
  const aliasedStoredSessionId = noteChatStoredSessionIdByRuntimeSessionId.get(eventSessionId);
  if (aliasedStoredSessionId) return aliasedStoredSessionId;
  return noteChatContinuityByStoredSessionId.has(eventSessionId) ? eventSessionId : undefined;
}

function soleWorkingNoteChatStoredSessionId(): string | undefined {
  let onlyWorkingStoredSessionId: string | undefined;
  for (const [storedSessionId, record] of noteChatContinuityByStoredSessionId) {
    if (!record.working || record.terminalHandled || record.stopped) continue;
    if (onlyWorkingStoredSessionId && onlyWorkingStoredSessionId !== storedSessionId) {
      return undefined;
    }
    onlyWorkingStoredSessionId = storedSessionId;
  }
  return onlyWorkingStoredSessionId;
}

function attributableUntaggedNoteChatStoredSessionId(): string | undefined {
  const soleWorkingStoredSessionId = soleWorkingNoteChatStoredSessionId();
  if (soleWorkingStoredSessionId) return soleWorkingStoredSessionId;

  let attributedStoredSessionId: string | undefined;
  for (const [storedSessionId, record] of noteChatContinuityByStoredSessionId) {
    if (!record.working || record.terminalHandled || record.stopped) continue;
    if (!canAttributeUntaggedAgentRun(storedSessionId, false)) continue;
    if (attributedStoredSessionId && attributedStoredSessionId !== storedSessionId)
      return undefined;
    attributedStoredSessionId = storedSessionId;
  }
  return attributedStoredSessionId;
}

function bufferPreAcceptanceTerminal(record: NoteChatContinuityRecord, event: JuneHermesEvent) {
  const eventId = event.delivery?.eventId;
  if (
    eventId &&
    (record.terminalEventIds.includes(eventId) ||
      record.deferredPreAcceptanceTerminals.some(
        (candidate) => candidate.delivery?.eventId === eventId,
      ))
  ) {
    return false;
  }
  record.deferredPreAcceptanceTerminals.push(event);
  if (record.deferredPreAcceptanceTerminals.length > MAX_NOTE_CHAT_PRE_ACCEPTANCE_TERMINALS) {
    record.deferredPreAcceptanceTerminals.splice(
      0,
      record.deferredPreAcceptanceTerminals.length - MAX_NOTE_CHAT_PRE_ACCEPTANCE_TERMINALS,
    );
  }
  return true;
}

function clearNoteChatTerminalAuthority(record: NoteChatContinuityRecord) {
  record.terminalAuthorityCandidates = [];
  record.terminalAuthorityRunGeneration = undefined;
}

function noteChatOwnsCurrentRunMonitor(storedSessionId: string, record: NoteChatContinuityRecord) {
  return (
    record.runMonitorGeneration === undefined ||
    isAgentRunMonitorGenerationCurrent(storedSessionId, record.runMonitorGeneration)
  );
}

function noteChatAcceptsRunMonitorGeneration(
  record: NoteChatContinuityRecord,
  runMonitorGeneration: number,
) {
  const knownGeneration = Math.max(
    record.runMonitorGeneration ?? Number.NEGATIVE_INFINITY,
    record.latestRunMonitorGeneration ?? Number.NEGATIVE_INFINITY,
  );
  if (Number.isFinite(knownGeneration) && runMonitorGeneration < knownGeneration) return false;
  record.latestRunMonitorGeneration = Math.max(
    record.latestRunMonitorGeneration ?? 0,
    runMonitorGeneration,
  );
  return true;
}

function noteChatAcceptsTerminalMonitorEvent(
  storedSessionId: string,
  record: NoteChatContinuityRecord,
  runMonitorGeneration: number,
) {
  if (record.stopped) {
    const stoppedGeneration =
      record.stoppedRunMonitorGeneration ?? record.latestRunMonitorGeneration;
    if (stoppedGeneration !== undefined && runMonitorGeneration <= stoppedGeneration) {
      return false;
    }
    // A later generation belongs to a run after this view's Stop. Retire only
    // the stale Stop state; the newer terminal remains authoritative even when
    // its queued run-start event has not arrived yet.
    record.stopped = false;
    record.stoppedRuntimeSessionId = undefined;
    record.stoppedRunMonitorGeneration = undefined;
  }
  // An in-flight local submit has not established its monitor generation yet.
  // A prior tagged terminal must not mutate freshness state while that prompt
  // is awaiting acknowledgement. A strictly newer app-lifetime terminal is
  // different: it invalidates this local attempt even when its queued start
  // notification has not run yet.
  if (record.working && !record.runAccepted) {
    const knownGeneration = Math.max(
      record.runMonitorGeneration ?? Number.NEGATIVE_INFINITY,
      record.latestRunMonitorGeneration ?? Number.NEGATIVE_INFINITY,
    );
    const monitor = agentRunMonitorSnapshot(storedSessionId);
    if (
      monitor?.generation !== runMonitorGeneration ||
      (monitor.phase !== "succeeded" && monitor.phase !== "terminal") ||
      (Number.isFinite(knownGeneration) && runMonitorGeneration <= knownGeneration)
    ) {
      return false;
    }
    record.runGeneration += 1;
    record.runAccepted = true;
  }

  if (!record.runAccepted) {
    const monitor = agentRunMonitorSnapshot(storedSessionId);
    if (
      monitor?.generation !== runMonitorGeneration ||
      (monitor.phase !== "succeeded" && monitor.phase !== "terminal")
    ) {
      return false;
    }
    record.runAccepted = true;
  }

  return noteChatAcceptsRunMonitorGeneration(record, runMonitorGeneration);
}

function noteChatLocalTerminalCanSettle(record: NoteChatContinuityRecord) {
  return (
    record.latestRunMonitorGeneration === undefined ||
    (record.runMonitorGeneration !== undefined &&
      record.runMonitorGeneration >= record.latestRunMonitorGeneration)
  );
}

function noteChatLocalGatewayOwnsLatest(record: NoteChatContinuityRecord) {
  if (record.working && !record.runAccepted) return true;
  return noteChatLocalTerminalCanSettle(record);
}

function noteChatActiveRunMonitorGeneration(record: NoteChatContinuityRecord) {
  const generation = Math.max(
    record.runMonitorGeneration ?? Number.NEGATIVE_INFINITY,
    record.latestRunMonitorGeneration ?? Number.NEGATIVE_INFINITY,
  );
  return Number.isFinite(generation) ? generation : undefined;
}

function noteChatTerminalEvidence(
  record: NoteChatContinuityRecord,
  pendingUserTurn: AgentChatTurn,
  event: JuneHermesEvent,
): AgentRunTerminalEvidence | undefined {
  const status = terminalAgentStatus(event);
  const promptDispatchedAtMs = record.pendingUserPersistenceBoundaries.get(
    pendingUserTurn.id,
  )?.promptDispatchedAtMs;
  if (
    status === undefined ||
    typeof promptDispatchedAtMs !== "number" ||
    !Number.isFinite(promptDispatchedAtMs)
  ) {
    return undefined;
  }
  return {
    status,
    summary: noteChatTerminalStatusSummary(event, status),
    notBeforeMs: promptDispatchedAtMs,
  };
}

function ambiguousNoteChatTerminalEvidence(
  record: NoteChatContinuityRecord,
  pendingUserTurn: AgentChatTurn,
  event: JuneHermesEvent,
): AgentRunTerminalEvidence | undefined {
  const fingerprint = noteChatTerminalFingerprint(event);
  if (
    event.delivery?.eventId !== undefined ||
    fingerprint === undefined ||
    !record.terminalFingerprints.includes(fingerprint)
  ) {
    return undefined;
  }
  return noteChatTerminalEvidence(record, pendingUserTurn, event);
}

function deferredNoteChatTerminalEvidence(
  record: NoteChatContinuityRecord,
  pendingUserTurn: AgentChatTurn,
) {
  for (let index = record.deferredPreAcceptanceTerminals.length - 1; index >= 0; index -= 1) {
    const event = record.deferredPreAcceptanceTerminals[index];
    const status = terminalAgentStatus(event);
    // A negative terminal must block assistant fallback even when it has a
    // unique delivery id. The one-shot persistence authority read can fail,
    // and losing this pre-ack signal would let partial prose become success.
    const evidence =
      status === "failed" || status === "cancelled"
        ? noteChatTerminalEvidence(record, pendingUserTurn, event)
        : ambiguousNoteChatTerminalEvidence(record, pendingUserTurn, event);
    if (evidence) return evidence;
  }
  return undefined;
}

function routeNoteChatControlPlaneEvent(
  event: JuneHermesEvent,
  terminalAuthorityResolved = false,
): RoutedNoteChatEvent | undefined {
  const storedSessionId = storedSessionIdForEvent(event);
  if (!storedSessionId) return undefined;
  const record = noteChatContinuityFor(storedSessionId);
  if (!noteChatLocalGatewayOwnsLatest(record)) {
    return {
      storedSessionId,
      record,
      terminalAccepted: false,
      transcriptCompletionAccepted: false,
      stoppedByUser: record.stopped,
    };
  }
  const terminal = isTerminalHermesEvent(event);
  const terminalEventId = terminal ? event.delivery?.eventId : undefined;
  if (terminal && record.terminalHandled) {
    return {
      storedSessionId,
      record,
      terminalAccepted: false,
      transcriptCompletionAccepted: false,
      stoppedByUser: record.stopped,
    };
  }
  if (terminalEventId && record.terminalEventIds.includes(terminalEventId)) {
    return {
      storedSessionId,
      record,
      terminalAccepted: false,
      transcriptCompletionAccepted: false,
      stoppedByUser: record.stopped,
    };
  }
  if (terminal && record.working && !record.runAccepted) {
    bufferPreAcceptanceTerminal(record, event);
    return {
      storedSessionId,
      record,
      terminalAccepted: false,
      transcriptCompletionAccepted: false,
      stoppedByUser: record.stopped,
    };
  }
  const transcriptWasComplete =
    event.kind === "transcript" &&
    event.complete === true &&
    event.messageId !== undefined &&
    record.liveStream.transcriptByMessageId[event.messageId]?.complete === true;
  const storedEvent = { ...event, sessionId: storedSessionId } as JuneHermesEvent;
  const nextLiveStream = appendHermesLiveEvent(record.liveStream, storedEvent);
  const deliveryAccepted = nextLiveStream !== record.liveStream;
  const terminalFingerprint = terminal ? noteChatTerminalFingerprint(event) : undefined;
  const ambiguousNoIdTerminal =
    terminal &&
    terminalFingerprint !== undefined &&
    event.delivery?.eventId === undefined &&
    record.terminalFingerprints.includes(terminalFingerprint);
  if (
    ambiguousNoIdTerminal &&
    !terminalAuthorityResolved &&
    sharedGateway &&
    record.runtimeSessionId
  ) {
    const pendingUserTurn = record.currentRunPendingUserTurn;
    if (pendingUserTurn) {
      const evidence = ambiguousNoteChatTerminalEvidence(record, pendingUserTurn, event);
      if (evidence && record.runMonitorGeneration !== undefined) {
        preserveAgentRunTerminalEvidence(storedSessionId, evidence, record.runMonitorGeneration);
      }
    }
    requestNoteChatTerminalAuthority({
      event,
      gateway: sharedGateway,
      record,
      runtimeSessionId: record.runtimeSessionId,
      storedSessionId,
    });
  }
  if (
    terminal &&
    ((!deliveryAccepted && !(ambiguousNoIdTerminal && terminalAuthorityResolved)) ||
      (ambiguousNoIdTerminal && !terminalAuthorityResolved))
  ) {
    return {
      storedSessionId,
      record,
      terminalAccepted: false,
      transcriptCompletionAccepted: false,
      stoppedByUser: record.stopped,
    };
  }
  record.liveStream = nextLiveStream;
  if (deliveryAccepted && event.kind === "transcript" && !event.messageId) {
    const origin = record.currentRunPendingUserTurn ?? record.lastAcceptedRunPendingUserTurn;
    if (origin) {
      const existing = record.unpersistedIdlessTranscriptOrigins.get(origin.id);
      record.unpersistedIdlessTranscriptOrigins.set(
        origin.id,
        appendIdlessTranscriptSegment(origin, existing, event),
      );
    } else {
      record.hasUnattributedIdlessTranscript = true;
    }
  }
  let stoppedByUser = false;
  if (terminal) {
    const eventSessionId = "sessionId" in event ? event.sessionId : undefined;
    stoppedByUser =
      record.stopped &&
      (!eventSessionId ||
        eventSessionId === record.stoppedRuntimeSessionId ||
        eventSessionId === storedSessionId);
    const settlesWorkingState = noteChatLocalTerminalCanSettle(record);
    if (settlesWorkingState) {
      record.terminalHandled = true;
      record.working = false;
    }
    if (terminalEventId) {
      record.terminalEventIds.push(terminalEventId);
      if (record.terminalEventIds.length > MAX_NOTE_CHAT_TERMINAL_EVENT_IDS) {
        record.terminalEventIds.splice(
          0,
          record.terminalEventIds.length - MAX_NOTE_CHAT_TERMINAL_EVENT_IDS,
        );
      }
    }
    if (
      !terminalEventId &&
      terminalFingerprint &&
      !record.terminalFingerprints.includes(terminalFingerprint)
    ) {
      record.terminalFingerprints.push(terminalFingerprint);
      if (record.terminalFingerprints.length > MAX_NOTE_CHAT_TERMINAL_EVENT_IDS) {
        record.terminalFingerprints.splice(
          0,
          record.terminalFingerprints.length - MAX_NOTE_CHAT_TERMINAL_EVENT_IDS,
        );
      }
    }
    const idlessOrigin = record.currentRunPendingUserTurn ?? record.lastAcceptedRunPendingUserTurn;
    if (idlessOrigin) {
      const proof = record.unpersistedIdlessTranscriptOrigins.get(idlessOrigin.id);
      if (proof) proof.activeSegmentIndex = undefined;
    }
    if (settlesWorkingState) {
      record.currentRunPendingUserTurn = undefined;
      clearNoteChatTerminalAuthority(record);
    }
  }
  return {
    storedSessionId,
    record,
    terminalAccepted: terminal,
    transcriptCompletionAccepted: !transcriptWasComplete,
    stoppedByUser,
  };
}

function appendIdlessTranscriptSegment(
  pendingUserTurn: AgentChatTurn,
  current: NoteChatIdlessTranscriptOrigin | undefined,
  event: Extract<JuneHermesEvent, { kind: "transcript" }>,
): NoteChatIdlessTranscriptOrigin {
  const visibleSegments = [...(current?.visibleSegments ?? [])];
  let activeSegmentIndex = current?.activeSegmentIndex;
  const text = event.delta ?? "";
  const startsSegment = !event.complete && event.delta === undefined;
  if (startsSegment || activeSegmentIndex === undefined) {
    visibleSegments.push("");
    activeSegmentIndex = visibleSegments.length - 1;
  }
  const visibleText = visibleSegments[activeSegmentIndex] ?? "";
  if (event.complete) {
    if (text.startsWith(visibleText)) visibleSegments[activeSegmentIndex] = text;
    activeSegmentIndex = undefined;
  } else if (text) {
    visibleSegments[activeSegmentIndex] = visibleText + text;
  }
  return {
    pendingUserTurn,
    visibleSegments,
    ...(activeSegmentIndex === undefined ? {} : { activeSegmentIndex }),
  };
}

function noteChatTerminalFingerprint(event: JuneHermesEvent): string | undefined {
  if (event.kind === "error") {
    return JSON.stringify(["error", event.code ?? null, event.message, event.recoverable ?? null]);
  }
  if (event.kind === "lifecycle" && event.flavor === "terminal") {
    return JSON.stringify(["lifecycle", event.status, event.text]);
  }
  return undefined;
}

function dispatchNoteChatControlPlaneEvent(
  event: JuneHermesEvent,
  terminalAuthorityResolved = false,
) {
  const eventSessionId = "sessionId" in event ? event.sessionId : undefined;
  const attributableStoredSessionId =
    !eventSessionId && isTerminalHermesEvent(event)
      ? attributableUntaggedNoteChatStoredSessionId()
      : undefined;
  const routedEvent = attributableStoredSessionId
    ? ({ ...event, sessionId: attributableStoredSessionId } as JuneHermesEvent)
    : event;
  const route = routeNoteChatControlPlaneEvent(routedEvent, terminalAuthorityResolved);
  for (const subscriber of [...eventSubscribers]) subscriber(routedEvent, route);
  if (
    route &&
    route.record.mountedViews === 0 &&
    ((routedEvent.kind === "transcript" &&
      routedEvent.complete &&
      route.transcriptCompletionAccepted !== false) ||
      route.terminalAccepted)
  ) {
    void refreshNoteChatContinuityRecord(route.storedSessionId, route.record);
  }
}

function requestNoteChatTerminalAuthority({
  event,
  gateway,
  record,
  runtimeSessionId,
  storedSessionId,
}: {
  event: JuneHermesEvent;
  gateway: HermesGatewayClient;
  record: NoteChatContinuityRecord;
  runtimeSessionId: string;
  storedSessionId: string;
}) {
  requestNoteChatTerminalCandidatesAuthority({
    events: [event],
    gateway,
    record,
    runtimeSessionId,
    storedSessionId,
  });
}

function queueNoteChatTerminalAuthorityCandidates(
  record: NoteChatContinuityRecord,
  events: JuneHermesEvent[],
) {
  for (const event of events) {
    const eventId = event.delivery?.eventId;
    const fingerprint = noteChatTerminalFingerprint(event);
    const duplicateIndex = record.terminalAuthorityCandidates.findIndex((candidate) => {
      const candidateEventId = candidate.delivery?.eventId;
      if (eventId || candidateEventId) return eventId !== undefined && eventId === candidateEventId;
      return fingerprint !== undefined && fingerprint === noteChatTerminalFingerprint(candidate);
    });
    if (duplicateIndex >= 0) record.terminalAuthorityCandidates.splice(duplicateIndex, 1);
    record.terminalAuthorityCandidates.push(event);
  }
  if (record.terminalAuthorityCandidates.length > MAX_NOTE_CHAT_TERMINAL_AUTHORITY_CANDIDATES) {
    record.terminalAuthorityCandidates.splice(
      0,
      record.terminalAuthorityCandidates.length - MAX_NOTE_CHAT_TERMINAL_AUTHORITY_CANDIDATES,
    );
  }
}

function requestNoteChatTerminalCandidatesAuthority({
  events,
  gateway,
  record,
  runtimeSessionId,
  storedSessionId,
}: {
  events: JuneHermesEvent[];
  gateway: HermesGatewayClient;
  record: NoteChatContinuityRecord;
  runtimeSessionId: string;
  storedSessionId: string;
}) {
  const pendingUserTurn = record.currentRunPendingUserTurn;
  const runGeneration = record.runGeneration;
  queueNoteChatTerminalAuthorityCandidates(record, events);
  if (
    record.terminalAuthorityCandidates.length === 0 ||
    !pendingUserTurn ||
    record.stopped ||
    record.terminalHandled ||
    record.terminalAuthorityRunGeneration === runGeneration
  ) {
    return;
  }
  record.terminalAuthorityRunGeneration = runGeneration;
  void (async () => {
    // Pre-ack terminals do not carry a prompt or Agent run id. Delivery order is the
    // only temporal evidence that distinguishes a current terminal from an
    // older replay, so test the newest candidate first. Persistence and idle
    // authority below still prevent an unproven newer frame from settling.
    while (record.terminalAuthorityCandidates.length > 0) {
      if (record.runGeneration !== runGeneration || record.stopped || record.terminalHandled) {
        break;
      }
      const deferredTerminal = record.terminalAuthorityCandidates.pop();
      if (!deferredTerminal) continue;
      await confirmDeferredNoteChatTerminalAuthority({
        deferredTerminal,
        gateway,
        pendingUserTurn,
        record,
        runGeneration,
        runtimeSessionId,
        storedSessionId,
      });
    }
  })().finally(() => {
    if (record.terminalAuthorityRunGeneration === runGeneration) {
      record.terminalAuthorityRunGeneration = undefined;
      if (
        record.terminalAuthorityCandidates.length > 0 &&
        record.runGeneration === runGeneration &&
        !record.stopped &&
        !record.terminalHandled
      ) {
        requestNoteChatTerminalCandidatesAuthority({
          events: [],
          gateway,
          record,
          runtimeSessionId,
          storedSessionId,
        });
      }
    }
  });
}

function confirmNoteChatRunAccepted({
  gateway,
  pendingUserTurn,
  record,
  runGeneration,
  runtimeSessionId,
  storedSessionId,
}: {
  gateway: HermesGatewayClient;
  pendingUserTurn: AgentChatTurn;
  record: NoteChatContinuityRecord;
  runGeneration: number;
  runtimeSessionId: string;
  storedSessionId: string;
}) {
  if (record.runGeneration !== runGeneration || record.stopped || record.terminalHandled) {
    record.deferredPreAcceptanceTerminals = [];
    return false;
  }
  record.runAccepted = true;
  record.currentRunPendingUserTurn = pendingUserTurn;
  record.lastAcceptedRunPendingUserTurn = pendingUserTurn;
  const deferredTerminals = record.deferredPreAcceptanceTerminals;
  record.deferredPreAcceptanceTerminals = [];
  if (deferredTerminals.length > 0) {
    requestNoteChatTerminalCandidatesAuthority({
      events: deferredTerminals,
      gateway,
      record,
      runtimeSessionId,
      storedSessionId,
    });
  }
  return !record.terminalHandled && !record.stopped;
}

async function confirmDeferredNoteChatTerminalAuthority({
  deferredTerminal,
  gateway,
  pendingUserTurn,
  record,
  runGeneration,
  runtimeSessionId,
  storedSessionId,
}: {
  deferredTerminal: JuneHermesEvent;
  gateway: HermesGatewayClient;
  pendingUserTurn: AgentChatTurn;
  record: NoteChatContinuityRecord;
  runGeneration: number;
  runtimeSessionId: string;
  storedSessionId: string;
}) {
  let persistedMessages: HermesSessionMessage[];
  try {
    persistedMessages = sessionMessagesFrom(await hermesBridgeSessionMessages(storedSessionId));
  } catch {
    return;
  }
  const terminalStatus = terminalAgentStatus(deferredTerminal);
  const persistedUserIndex = persistedPendingNoteChatUserIndex(
    record,
    pendingUserTurn,
    persistedMessages,
  );
  const hasCurrentRunAssistant =
    persistedUserIndex >= 0 &&
    persistedMessages.slice(persistedUserIndex + 1).some((message) => message.role === "assistant");
  const hasCurrentRunPersistence =
    terminalStatus === "completed" ? hasCurrentRunAssistant : persistedUserIndex >= 0;
  if (
    !hasCurrentRunPersistence ||
    record.runGeneration !== runGeneration ||
    record.stopped ||
    record.terminalHandled
  ) {
    return;
  }
  let active: {
    sessions?: Array<{ id?: string; session_key?: string; status?: string }>;
  };
  try {
    active = await gateway.request("session.active_list", {});
  } catch {
    return;
  }
  const matchingRows = (active.sessions ?? []).filter(
    (row) =>
      row.id === runtimeSessionId ||
      row.id === storedSessionId ||
      row.session_key === runtimeSessionId ||
      row.session_key === storedSessionId,
  );
  if (matchingRows.length === 0 || matchingRows.some((row) => row.status !== "idle")) return;
  const terminalEvidence = ambiguousNoteChatTerminalEvidence(
    record,
    pendingUserTurn,
    deferredTerminal,
  );
  if (terminalEvidence) {
    if (
      record.runGeneration === runGeneration &&
      record.runMonitorGeneration !== undefined &&
      !record.stopped &&
      !record.terminalHandled
    ) {
      preserveAgentRunTerminalEvidence(
        storedSessionId,
        terminalEvidence,
        record.runMonitorGeneration,
      );
    }
    return;
  }
  if (record.runGeneration === runGeneration && !record.stopped && !record.terminalHandled) {
    dispatchNoteChatControlPlaneEvent(deferredTerminal, true);
  }
}

function beginNoteChatTranscriptRefresh(record: NoteChatContinuityRecord): NoteChatRefreshSnapshot {
  return {
    sequence: ++record.nextRefreshSequence,
    runGeneration: record.runGeneration,
    throughRevision: record.liveStream.revision,
  };
}

function canonicalNoteChatUserText(value: string): string {
  return displayedComposerUserMessageText(value)
    .replace(/^@note:\S+(?:\s+\("[^"]*"\))?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalPendingUserText(turn: AgentChatTurn): string {
  return canonicalNoteChatUserText(
    turn.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  );
}

function canonicalPersistedUserText(message: HermesSessionMessage): string {
  return canonicalNoteChatUserText(
    textFromHermesContent(message.content) ??
      textFromHermesContent(message.text) ??
      textFromHermesContent(message.context) ??
      "",
  );
}

function noteChatPersistenceBoundary(
  persistedMessages: HermesSessionMessage[],
  historyWasHydrated: boolean,
  submittedAtMs: number,
): NoteChatPersistenceBoundary {
  const persistedUsers = persistedMessages.filter((message) => message.role === "user");
  return {
    persistedUserIds: new Set(
      persistedUsers.flatMap((message) => (message.id ? [message.id] : [])),
    ),
    persistedUserCount: persistedUsers.length,
    historyWasHydrated,
    submittedAtMs,
  };
}

function persistedMessageTimestampMs(message: HermesSessionMessage): number | undefined {
  const value = message.timestamp ?? message.created_at;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 10_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function persistedUserIsAfterBoundary(
  persistedMessage: HermesSessionMessage,
  persistedUserIndex: number,
  boundary: NoteChatPersistenceBoundary | undefined,
) {
  if (!boundary) return true;
  if (persistedMessage.id && boundary.persistedUserIds.has(persistedMessage.id)) return false;
  if (boundary.historyWasHydrated) {
    return persistedUserIndex >= boundary.persistedUserCount;
  }
  const persistedAtMs = persistedMessageTimestampMs(persistedMessage);
  return persistedAtMs !== undefined && persistedAtMs >= boundary.submittedAtMs;
}

function persistedAssistantText(message: HermesSessionMessage): string {
  return (
    textFromHermesContent(message.content) ??
    textFromHermesContent(message.text) ??
    textFromHermesContent(message.context) ??
    ""
  );
}

function persistedAssistantCoversIdlessTranscript(
  origin: NoteChatIdlessTranscriptOrigin,
  persistedMessages: HermesSessionMessage[],
  persistedUserIndex: number,
) {
  if (persistedUserIndex < 0) return false;
  const followingRunMessages = persistedMessages.slice(persistedUserIndex + 1);
  const nextUserIndex = followingRunMessages.findIndex((message) => message.role === "user");
  const runMessages =
    nextUserIndex >= 0 ? followingRunMessages.slice(0, nextUserIndex) : followingRunMessages;
  const persistedAssistantTexts = runMessages.flatMap((message) =>
    message.role === "assistant" ? [persistedAssistantText(message)] : [],
  );
  return (
    persistedAssistantTexts.length >= origin.visibleSegments.length &&
    origin.visibleSegments.every((segment, index) =>
      persistedAssistantTexts[index]?.startsWith(segment),
    )
  );
}

function persistedPendingNoteChatUserIndex(
  record: NoteChatContinuityRecord,
  pendingUserTurn: AgentChatTurn,
  persistedMessages: HermesSessionMessage[],
) {
  const boundary = record.pendingUserPersistenceBoundaries.get(pendingUserTurn.id);
  return persistedPendingNoteChatUserIndexAtBoundary(pendingUserTurn, boundary, persistedMessages);
}

function persistedPendingNoteChatUserIndexAtBoundary(
  pendingUserTurn: AgentChatTurn,
  boundary: NoteChatPersistenceBoundary | undefined,
  persistedMessages: readonly HermesSessionMessage[],
) {
  const candidateText = canonicalPendingUserText(pendingUserTurn);
  let userOrdinal = 0;
  for (let index = 0; index < persistedMessages.length; index += 1) {
    const message = persistedMessages[index];
    if (message.role !== "user") continue;
    if (
      canonicalPersistedUserText(message) === candidateText &&
      persistedUserIsAfterBoundary(message, userOrdinal, boundary)
    ) {
      return index;
    }
    userOrdinal += 1;
  }
  return -1;
}

function persistedIdlessOriginUserIndices(
  record: NoteChatContinuityRecord,
  origins: Array<[string, NoteChatIdlessTranscriptOrigin]>,
  persistedMessages: HermesSessionMessage[],
) {
  const matchedPersistedUsers = new Set<number>();
  const matches = new Map<string, number>();
  for (const [turnId, origin] of origins) {
    const candidateText = canonicalPendingUserText(origin.pendingUserTurn);
    const boundary = record.pendingUserPersistenceBoundaries.get(turnId);
    let userOrdinal = 0;
    for (let index = 0; index < persistedMessages.length; index += 1) {
      const message = persistedMessages[index];
      if (message.role !== "user") continue;
      if (
        !matchedPersistedUsers.has(index) &&
        canonicalPersistedUserText(message) === candidateText &&
        persistedUserIsAfterBoundary(message, userOrdinal, boundary)
      ) {
        matchedPersistedUsers.add(index);
        matches.set(turnId, index);
        break;
      }
      userOrdinal += 1;
    }
  }
  return matches;
}

function hasUnpersistedStructuredNoteChatEntries(record: NoteChatContinuityRecord) {
  const persistedToolResultIds = new Set(
    record.messages.flatMap((message) =>
      message.role === "tool" ? [message.tool_call_id ?? message.id] : [],
    ),
  );
  return record.liveStream.entries.some(({ event }) => {
    switch (event.kind) {
      case "transcript":
      case "lifecycle":
      case "unsupported":
        return false;
      case "tool":
        return !event.toolCallId || !persistedToolResultIds.has(event.toolCallId);
      case "reasoning":
      case "pending_action":
      case "pending_action_resolution":
      case "background_activity":
      case "steering":
      case "error":
        return true;
      default:
        // New event kinds are unresolved until they gain an explicit proof.
        return true;
    }
  });
}

function compactSettledOffscreenNoteChatContinuity(record: NoteChatContinuityRecord) {
  if (
    record.mountedViews > 0 ||
    record.working ||
    record.pendingUserTurns.length > 0 ||
    record.persistedThroughRevision < record.liveStream.revision
  ) {
    return;
  }
  if (hasUnpersistedStructuredNoteChatEntries(record)) return;
  const hasIdlessTranscript = record.liveStream.entries.some(
    ({ event }) => event.kind === "transcript" && !event.messageId,
  );
  if (
    hasIdlessTranscript &&
    (record.hasUnattributedIdlessTranscript || record.unpersistedIdlessTranscriptOrigins.size > 0)
  ) {
    return;
  }
  const transcriptEntries = Object.entries(record.liveStream.transcriptByMessageId);
  if (
    transcriptEntries.some(
      ([messageId, state]) => !state.complete || !record.liveStream.persistedMessageIds[messageId],
    )
  ) {
    return;
  }
  // Fresh persisted history covers the entire settled Agent run stream. Offscreen
  // records do not need to retain a second copy of history or unbounded event
  // and delivery-key indexes; the next mount hydrates from bridge persistence.
  record.messages = [];
  record.messagesHydrated = false;
  record.liveStream = createHermesLiveStream();
  record.pendingUserPersistenceBoundaries.clear();
  record.unpersistedIdlessTranscriptOrigins.clear();
  record.hasUnattributedIdlessTranscript = false;
  record.currentRunPendingUserTurn = undefined;
  record.lastAcceptedRunPendingUserTurn = undefined;
  clearNoteChatTerminalAuthority(record);
  record.persistedThroughRevision = 0;
}

function unmatchedPendingUserTurns(
  record: NoteChatContinuityRecord,
  persistedMessages: HermesSessionMessage[],
): AgentChatTurn[] {
  const persistedUsers = persistedMessages.filter((message) => message.role === "user");
  const matched = new Set<number>();
  const unmatched = record.pendingUserTurns.filter((candidate) => {
    const candidateText = canonicalPendingUserText(candidate);
    const boundary = record.pendingUserPersistenceBoundaries.get(candidate.id);
    const matchIndex = persistedUsers.findIndex((persistedMessage, index) => {
      if (matched.has(index)) return false;
      if (canonicalPersistedUserText(persistedMessage) !== candidateText) return false;
      return persistedUserIsAfterBoundary(persistedMessage, index, boundary);
    });
    if (matchIndex < 0) return true;
    matched.add(matchIndex);
    if (!record.unpersistedIdlessTranscriptOrigins.has(candidate.id)) {
      record.pendingUserPersistenceBoundaries.delete(candidate.id);
    }
    return false;
  });
  const retainedIds = new Set([
    ...unmatched.map((turn) => turn.id),
    ...record.unpersistedIdlessTranscriptOrigins.keys(),
  ]);
  for (const turnId of record.pendingUserPersistenceBoundaries.keys()) {
    if (!retainedIds.has(turnId)) record.pendingUserPersistenceBoundaries.delete(turnId);
  }
  return unmatched;
}

function applyNoteChatTranscriptResponse(
  record: NoteChatContinuityRecord,
  snapshot: NoteChatRefreshSnapshot,
  persistedMessages: HermesSessionMessage[],
): boolean {
  if (
    record.runGeneration !== snapshot.runGeneration ||
    snapshot.sequence < record.appliedRefreshSequence
  ) {
    return false;
  }
  record.appliedRefreshSequence = snapshot.sequence;
  record.messages = persistedMessages;
  record.messagesHydrated = true;
  const idlessOrigins = [...record.unpersistedIdlessTranscriptOrigins];
  const persistedOriginUserIndices = persistedIdlessOriginUserIndices(
    record,
    idlessOrigins,
    persistedMessages,
  );
  for (const [turnId, origin] of idlessOrigins) {
    if (
      persistedAssistantCoversIdlessTranscript(
        origin,
        persistedMessages,
        persistedOriginUserIndices.get(turnId) ?? -1,
      )
    ) {
      record.unpersistedIdlessTranscriptOrigins.delete(turnId);
      record.pendingUserPersistenceBoundaries.delete(turnId);
    }
  }
  record.liveStream = reconcileHermesLiveStream(record.liveStream, {
    throughRevision: snapshot.throughRevision,
    persistedMessages: persistedAssistantMessagesById(persistedMessages),
  });
  record.pendingUserTurns = unmatchedPendingUserTurns(record, persistedMessages);
  record.persistedThroughRevision = Math.max(
    record.persistedThroughRevision,
    snapshot.throughRevision,
  );
  compactSettledOffscreenNoteChatContinuity(record);
  return true;
}

async function refreshNoteChatContinuityRecord(
  storedSessionId: string,
  record: NoteChatContinuityRecord,
) {
  const snapshot = beginNoteChatTranscriptRefresh(record);
  try {
    const response = await hermesBridgeSessionMessages(storedSessionId);
    return applyNoteChatTranscriptResponse(record, snapshot, sessionMessagesFrom(response));
  } catch {
    return false;
  }
}

function observeNoteChatRunStarted(event: Event) {
  const detail = (event as CustomEvent<AgentRunStartedDetail>).detail;
  if (!detail?.storedSessionId || detail.runMonitorGeneration === undefined) return;
  const record = noteChatContinuityByStoredSessionId.get(detail.storedSessionId);
  if (!record) return;
  const latestGeneration = record.latestRunMonitorGeneration;
  if (latestGeneration !== undefined && latestGeneration >= detail.runMonitorGeneration) return;
  record.latestRunMonitorGeneration = detail.runMonitorGeneration;
  if (
    record.runMonitorGeneration !== undefined &&
    record.runMonitorGeneration < detail.runMonitorGeneration
  ) {
    // Another surface now owns the session monitor. Keep the session working
    // until that newer generation terminates, but retire asynchronous authority
    // work from this older local run. A delayed gateway terminal from this
    // NoteChat socket can still settle its own transcript without mutating the
    // newer monitor generation.
    clearNoteChatTerminalAuthority(record);
  }
  if (detail.runtimeSessionId) {
    if (record.runtimeSessionId && record.runtimeSessionId !== detail.runtimeSessionId) {
      noteChatStoredSessionIdByRuntimeSessionId.delete(record.runtimeSessionId);
    }
    record.runtimeSessionId = detail.runtimeSessionId;
    noteChatStoredSessionIdByRuntimeSessionId.set(detail.runtimeSessionId, detail.storedSessionId);
  }
  record.runGeneration += 1;
  record.working = true;
  record.terminalHandled = false;
  record.stopped = false;
  record.stoppedRuntimeSessionId = undefined;
  record.stoppedRunMonitorGeneration = undefined;
  record.runAccepted = true;
  record.currentRunPendingUserTurn = undefined;
  record.deferredPreAcceptanceTerminals = [];
  touchNoteChatContinuity(detail.storedSessionId);
}

function settleNoteChatContinuity(event: Event) {
  const detail = (event as CustomEvent<AgentRunSettledDetail>).detail;
  if (!detail?.sessionId || detail.runMonitorGeneration === undefined) return;
  const storedSessionId = detail.sessionId;
  const record = noteChatContinuityByStoredSessionId.get(storedSessionId);
  if (
    !record ||
    !noteChatAcceptsTerminalMonitorEvent(storedSessionId, record, detail.runMonitorGeneration)
  ) {
    return;
  }
  record.working = false;
  record.terminalHandled = true;
  record.currentRunPendingUserTurn = undefined;
  clearNoteChatTerminalAuthority(record);
  touchNoteChatContinuity(storedSessionId);
  compactSettledOffscreenNoteChatContinuity(record);
  if (record.mountedViews === 0) {
    void refreshNoteChatContinuityRecord(storedSessionId, record);
  }
}

function settleNoteChatContinuityFromStatus(event: Event) {
  const detail = (event as CustomEvent<AgentSessionStatusDetail>).detail;
  if (
    !detail?.sessionId ||
    detail.runMonitorGeneration === undefined ||
    (detail.status !== "failed" && detail.status !== "cancelled")
  ) {
    return;
  }
  const record = noteChatContinuityByStoredSessionId.get(detail.sessionId);
  if (
    !record ||
    !noteChatAcceptsTerminalMonitorEvent(detail.sessionId, record, detail.runMonitorGeneration)
  ) {
    return;
  }
  record.working = false;
  record.terminalHandled = true;
  record.currentRunPendingUserTurn = undefined;
  clearNoteChatTerminalAuthority(record);
  touchNoteChatContinuity(detail.sessionId);
  compactSettledOffscreenNoteChatContinuity(record);
  if (record.mountedViews === 0) {
    void refreshNoteChatContinuityRecord(detail.sessionId, record);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener(AGENT_RUN_STARTED_EVENT, observeNoteChatRunStarted);
  window.addEventListener(AGENT_RUN_SETTLED_EVENT, settleNoteChatContinuity);
  window.addEventListener(AGENT_SESSION_STATUS_EVENT, settleNoteChatContinuityFromStatus);
}

export function resetNoteChatContinuityForTest() {
  gatewayEpoch += 1;
  noteChatContinuityByStoredSessionId.clear();
  provisionalNoteChatContinuityByNoteId.clear();
  noteChatStoredSessionIdByRuntimeSessionId.clear();
  noteChatStoredSessionContinuityOrder.length = 0;
  runtimeResumeByStoredSessionId.clear();
  activeSubmissionByNoteId.clear();
  gatewayRecovery = null;
  gatewayRecoveryRetryRequested = false;
}

function terminalAgentStatus(
  event: JuneHermesEvent,
): "completed" | "failed" | "cancelled" | undefined {
  if (!isTerminalHermesEvent(event)) return undefined;
  if (event.kind === "error") return "failed";
  if (event.kind !== "lifecycle") return undefined;
  if (/(?:cancel|stop|interrupt|abort)/i.test(event.status)) return "cancelled";
  if (/(?:fail|error|timeout)/i.test(event.status)) return "failed";
  return "completed";
}

function noteChatTerminalStatusSummary(
  event: JuneHermesEvent,
  status: "completed" | "failed" | "cancelled",
) {
  if (status === "completed") return "June finished.";
  if (status === "cancelled") return "Stopped.";
  return event.kind === "error" ? event.message : "June stopped before replying.";
}

async function connectGateway(startIfNeeded: boolean): Promise<HermesGatewayClient | null> {
  if (sharedGatewayConnecting) return sharedGatewayConnecting;
  const attempt = (async () => {
    let status = await hermesBridgeStatus();
    let connection = hermesConnectionForMode(status.running ? status : undefined, false);
    if (!connection) {
      if (!startIfNeeded) return null;
      status = await startHermesBridge(undefined, false);
      connection = hermesConnectionForMode(status, false);
    }
    const wsUrl = connection?.wsUrl;
    if (!wsUrl) throw new Error("Hermes bridge did not return a gateway URL.");
    if (!sharedGateway) {
      const gateway = new HermesGatewayClient();
      gateway.onEvent((raw) => {
        if (sharedGateway !== gateway) return;
        dispatchNoteChatControlPlaneEvent(classifyHermesEvent(raw));
      });
      // Unexpected drop: forget the client so the next submit reconnects
      // fresh. Subscribers persist — they are keyed to the module set, not
      // the socket.
      gateway.onClose(() => {
        if (sharedGateway !== gateway) return;
        sharedGateway = null;
        gatewayEpoch += 1;
        runtimeResumeByStoredSessionId.clear();
        invalidateNoteChatRuntimeSessions();
        void recoverWorkingNoteChatRuntimeSessions();
        for (const subscriber of [...gatewayCloseSubscribers]) subscriber();
      });
      sharedGateway = gateway;
    }
    await sharedGateway.connect(wsUrl);
    return sharedGateway;
  })().finally(() => {
    sharedGatewayConnecting = null;
  });
  // Only coalesce concurrent callers onto attempts that resolve to a live
  // gateway; a "bridge not running" null must not stick for a later caller
  // that wants to start it.
  if (startIfNeeded) {
    sharedGatewayConnecting = attempt.then((gateway) => {
      if (!gateway) throw new Error("Hermes gateway is not connected.");
      return gateway;
    });
    return sharedGatewayConnecting;
  }
  return attempt;
}

function resumeNoteChatRuntimeSession(
  gateway: HermesGatewayClient,
  storedSessionId: string,
): Promise<string | undefined> {
  const record = noteChatContinuityFor(storedSessionId);
  if (record.runtimeSessionId) return Promise.resolve(record.runtimeSessionId);
  const existing = runtimeResumeByStoredSessionId.get(storedSessionId);
  const intentEpoch = record.runtimeIntentEpoch;
  if (existing?.intentEpoch === intentEpoch) return existing.promise;

  const predecessor = existing?.promise.catch(() => undefined);
  const resume = () => {
    if (record.runtimeIntentEpoch !== intentEpoch || !record.working || record.stopped) {
      return Promise.resolve(undefined);
    }
    if (record.runtimeSessionId) return Promise.resolve(record.runtimeSessionId);
    const resumeEpoch = gatewayEpoch;
    if (sharedGateway !== gateway) return Promise.resolve(undefined);
    return gateway
      .request<HermesRuntimeSessionResponse>("session.resume", {
        session_id: storedSessionId,
        cols: 96,
      })
      .then(async (resumed) => {
        const runtimeSessionId = resumed.session_id;
        if (!runtimeSessionId) throw new Error("Hermes did not resume the session.");
        // A response from a socket that closed while session.resume was in flight
        // cannot own the runtime alias used by the replacement gateway.
        if (sharedGateway !== gateway || gatewayEpoch !== resumeEpoch) return undefined;
        if (record.runtimeIntentEpoch !== intentEpoch || !record.working || record.stopped) {
          try {
            await gateway.request("session.interrupt", { session_id: runtimeSessionId });
          } catch {
            // A superseding Submit or Stop remains authoritative even when the
            // best-effort interrupt fails.
          }
          return undefined;
        }
        registerNoteChatRuntimeSession(storedSessionId, runtimeSessionId);
        return runtimeSessionId;
      });
  };
  const attempt = (predecessor ? predecessor.then(resume) : resume()).finally(() => {
    if (runtimeResumeByStoredSessionId.get(storedSessionId)?.promise === attempt) {
      runtimeResumeByStoredSessionId.delete(storedSessionId);
    }
  });
  runtimeResumeByStoredSessionId.set(storedSessionId, { intentEpoch, promise: attempt });
  return attempt;
}

function recoverWorkingNoteChatRuntimeSessions(): Promise<void> {
  if (gatewayRecovery) {
    gatewayRecoveryRetryRequested = true;
    return gatewayRecovery;
  }
  const storedSessionIds = [...noteChatContinuityByStoredSessionId.entries()]
    .filter(([, record]) => record.working && !record.stopped)
    .map(([storedSessionId]) => storedSessionId);
  if (storedSessionIds.length === 0) return Promise.resolve();

  const recovery = (async () => {
    try {
      const gateway = await connectGateway(true);
      if (!gateway) return;
      await Promise.allSettled(
        storedSessionIds.map(async (storedSessionId) => {
          const record = noteChatContinuityByStoredSessionId.get(storedSessionId);
          if (!record?.working || record.stopped) return;
          await resumeNoteChatRuntimeSession(gateway, storedSessionId);
        }),
      );
    } catch {
      // App-lifetime monitoring and persisted transcript reconciliation remain
      // authoritative if reconnecting the live socket is not possible yet.
    }
  })().finally(() => {
    if (gatewayRecovery !== recovery) return;
    gatewayRecovery = null;
    if (gatewayRecoveryRetryRequested) {
      gatewayRecoveryRetryRequested = false;
      void recoverWorkingNoteChatRuntimeSessions();
    }
  });
  gatewayRecovery = recovery;
  return recovery;
}

function subscribeToGatewayEvents(
  subscriber: (event: JuneHermesEvent, route: RoutedNoteChatEvent | undefined) => void,
) {
  eventSubscribers.add(subscriber);
  return () => {
    eventSubscribers.delete(subscriber);
  };
}

function subscribeToGatewayClose(subscriber: () => void) {
  gatewayCloseSubscribers.add(subscriber);
  return () => {
    gatewayCloseSubscribers.delete(subscriber);
  };
}

function sessionMessagesFrom(response: {
  messages?: HermesSessionMessage[];
  items?: HermesSessionMessage[];
  data?: HermesSessionMessage[];
}): HermesSessionMessage[] {
  return response.messages ?? response.items ?? response.data ?? [];
}

function persistedAssistantMessagesById(messages: HermesSessionMessage[]) {
  const persisted = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.id) continue;
    const text =
      textFromHermesContent(message.content) ??
      textFromHermesContent(message.text) ??
      textFromHermesContent(message.context) ??
      "";
    persisted.set(message.id, text);
  }
  return persisted;
}

function sameSessionModelSelection(
  left: SessionModelSelection,
  right: SessionModelSelection,
): boolean {
  return left.modelId === right.modelId && left.costQuality === right.costQuality;
}

function selectionFromStoredHermesModel(
  hermesModelId: string,
  settings: Awaited<ReturnType<typeof providerModelSettings>>["settings"] | undefined,
): SessionModelSelection {
  const configuredLocalModelId = settings?.localGeneration.modelId.trim();
  if (
    !hermesModelId.startsWith("__june_") &&
    configuredLocalModelId &&
    hermesModelId === configuredLocalModelId
  ) {
    return { modelId: localGenerationOptionId(configuredLocalModelId) };
  }
  const selection = decodeHermesModelSelection(hermesModelId);
  return selection.modelId === AUTO_MODEL_ID &&
    selection.costQuality === undefined &&
    settings?.costQuality !== undefined
    ? { ...selection, costQuality: settings.costQuality }
    : selection;
}

function defaultSessionModelSelection(
  settings: Awaited<ReturnType<typeof providerModelSettings>>["settings"],
): SessionModelSelection {
  const localModelId = settings.localGeneration.modelId.trim();
  const modelId =
    settings.generationProvider === "local" && localModelId
      ? localGenerationOptionId(localModelId)
      : settings.generationModel;
  return {
    modelId,
    ...(modelId === AUTO_MODEL_ID && settings.costQuality !== undefined
      ? { costQuality: settings.costQuality }
      : {}),
  };
}

async function reconcileStoredSessionModelMetadata(storedSessionId: string): Promise<
  | {
      appliedHermesModelId: string;
      selection: SessionModelSelection;
    }
  | undefined
> {
  const [sessions, settingsResponse] = await Promise.all([
    listHermesSessions({ archived: "include", minMessages: 0 }).catch(() => []),
    providerModelSettings().catch(() => undefined),
  ]);
  const appliedHermesModelId =
    sessions.find((session) => session.id === storedSessionId)?.model?.trim() || undefined;
  if (!appliedHermesModelId) return undefined;

  const selection = selectionFromStoredHermesModel(
    appliedHermesModelId,
    settingsResponse?.settings,
  );
  let store = rememberAppliedSessionModelSelection(storedSessionId, selection);
  // Raw ids from older June builds do not carry provider provenance. Retain
  // the metadata model as the live baseline, but force one session-scoped
  // config.set before the next prompt to upgrade Hermes to the tagged alias.
  if (
    hermesModelIdForSelection(selection) !== appliedHermesModelId &&
    !hasPendingSessionModelSelection(store[storedSessionId])
  ) {
    store = stageSessionModelSelection(storedSessionId, store[storedSessionId].selection);
  }
  return { appliedHermesModelId, selection };
}

export type NoteChat = {
  /** The rendered conversation: persisted turns + the live streaming tail. */
  turns: AgentChatTurn[];
  /** True from an accepted submit until the turn's terminal event. */
  working: boolean;
  /** A Send is still resolving creation/resume/dispatch, even if Stop hid the busy state. */
  submissionPending: boolean;
  /** True while the persisted transcript for an existing session loads. */
  loading: boolean;
  error: string | null;
  /** The stored Hermes session id backing this note's chat, once one exists.
   * This is the id the agent view resolves the conversation by. */
  storedSessionId: string | undefined;
  /** Sends a question about the note, with any imported attachments (images
   * ride the structured attach flow before the prompt; every file's workspace
   * path rides in the prompt block). Resolves true when the prompt was
   * accepted (the caller can clear its composer), false on failure (the
   * caller keeps the draft and chips so the user can retry). */
  submit: (text: string, attachments?: NoteChatAttachment[]) => Promise<boolean>;
  /** Interrupts the running agent run. The UI reads stopped immediately; the
   * interrupt RPC follows best-effort, like the workspace's stop. */
  stop: () => void;
  /** Chooses the model for this chat: applied at session.create for a fresh
   * chat, or as a session-scoped switch ahead of the next message on a live
   * one. A change made while working remains queued for the following run. */
  modelSelection: SessionModelSelection | undefined;
  /** The model Hermes last acknowledged for this session. Legacy chats load
   * this from Hermes session metadata until they have a durable selection
   * entry of their own. */
  appliedHermesModelId: string | undefined;
  setSessionModel: (selection: SessionModelSelection) => void;
};

/** A note-scoped chat with June, powered by the same Hermes runtime as the
 * agent view but owned by the panel: its own gateway socket, its own live
 * event tail, one session per note (see noteChatSessions). The first message
 * of a session carries the note reference token, so Hermes resolves the note
 * through June's note context tool exactly like a composer note chip. */
export function useNoteChat(note: NoteReferenceInput | null): NoteChat {
  const noteId = note?.id;
  const noteTitle = note?.title ?? "";
  const [storedSessionId, setStoredSessionId] = useState<string>();
  const [messages, setMessages] = useState<HermesSessionMessage[]>([]);
  const [liveEvents, setLiveEvents] = useState<HermesLiveStream>(createHermesLiveStream);
  const [pendingUserTurns, setPendingUserTurns] = useState<AgentChatTurn[]>([]);
  const [working, setWorking] = useState(false);
  const workingRef = useRef(false);
  const [submissionPending, setSubmissionPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelSelection, setModelSelection] = useState<SessionModelSelection | undefined>(() => {
    const noteStoredSessionId = noteId ? noteChatSessionIdFor(noteId) : undefined;
    return noteStoredSessionId
      ? readSessionModelSelections()[noteStoredSessionId]?.selection
      : undefined;
  });
  const [appliedHermesModelId, setAppliedHermesModelId] = useState<string | undefined>(() => {
    const noteStoredSessionId = noteId ? noteChatSessionIdFor(noteId) : undefined;
    const appliedSelection = noteStoredSessionId
      ? readSessionModelSelections()[noteStoredSessionId]?.appliedSelection
      : undefined;
    return appliedSelection ? hermesModelIdForSelection(appliedSelection) : undefined;
  });

  const storedSessionIdRef = useRef<string>();
  const runtimeSessionIdRef = useRef<string>();
  const continuityRecordRef = useRef<NoteChatContinuityRecord>();
  const mountedContinuityRecordRef = useRef<NoteChatContinuityRecord>();
  const recoveringGatewayRef = useRef(false);
  // The model the user picked in the panel vs the one the live session runs.
  // They converge at session.create (fresh chat) or via a session-scoped
  // config update right before the next prompt (existing chat) — never
  // during an agent run.
  const pendingModelSelectionRef = useRef<SessionModelSelection>();
  const appliedHermesModelIdRef = useRef<string>();
  const storedSessionMetadataHydratedRef = useRef(false);
  const noteGenerationRef = useRef(0);
  // Synchronous in-flight guard: React batches setWorking(true), so a rapid
  // double send (double-click, or Enter racing the send button) could both
  // pass the state-based check and each create a session / append a turn.
  const activeSubmissionRef = useRef<symbol>();
  const cancelledSubmissionTokensRef = useRef(new Set<symbol>());
  const stoppedRuntimeSessionIdRef = useRef<string>();
  const stoppedRunRef = useRef(false);
  const terminalHandledRef = useRef(true);
  const liveEventsRef = useRef<HermesLiveStream>(liveEvents);
  const messagesRef = useRef<HermesSessionMessage[]>(messages);
  const pendingUserTurnsRef = useRef<AgentChatTurn[]>([]);
  const runGenerationRef = useRef(0);
  liveEventsRef.current = liveEvents;
  messagesRef.current = messages;
  pendingUserTurnsRef.current = pendingUserTurns;

  const bindMountedContinuityRecord = useCallback((record?: NoteChatContinuityRecord) => {
    const previous = mountedContinuityRecordRef.current;
    if (previous === record) return;
    if (previous) {
      previous.mountedViews = Math.max(0, previous.mountedViews - 1);
      compactSettledOffscreenNoteChatContinuity(previous);
    }
    mountedContinuityRecordRef.current = record;
    if (record) record.mountedViews += 1;
  }, []);

  const applyContinuityRecordToView = useCallback((record: NoteChatContinuityRecord) => {
    continuityRecordRef.current = record;
    runtimeSessionIdRef.current = record.runtimeSessionId;
    messagesRef.current = record.messages;
    setMessages(record.messages);
    liveEventsRef.current = record.liveStream;
    setLiveEvents(record.liveStream);
    pendingUserTurnsRef.current = record.pendingUserTurns;
    setPendingUserTurns(record.pendingUserTurns);
    workingRef.current = record.working;
    setWorking(record.working);
    terminalHandledRef.current = record.terminalHandled;
    stoppedRunRef.current = record.stopped;
    stoppedRuntimeSessionIdRef.current = record.stoppedRuntimeSessionId;
    runGenerationRef.current = record.runGeneration;
  }, []);

  useEffect(
    () =>
      subscribeToNoteChatContinuity((update) => {
        if (update.noteId !== noteId) return;
        storedSessionIdRef.current = update.storedSessionId;
        setStoredSessionId(update.storedSessionId);
        bindMountedContinuityRecord(update.record);
        applyContinuityRecordToView(update.record);
      }),
    [applyContinuityRecordToView, bindMountedContinuityRecord, noteId],
  );

  // Rebind to the note's session whenever the panel switches notes.
  useEffect(() => {
    const noteGeneration = ++noteGenerationRef.current;
    const noteStoredSessionId = noteId ? noteChatSessionIdFor(noteId) : undefined;
    const continuityRecord = noteStoredSessionId
      ? noteChatContinuityFor(noteStoredSessionId)
      : noteId
        ? provisionalNoteChatContinuityByNoteId.get(noteId)
        : undefined;
    storedSessionIdRef.current = noteStoredSessionId;
    continuityRecordRef.current = continuityRecord;
    runtimeSessionIdRef.current = continuityRecord?.runtimeSessionId;
    const rememberedEntry = noteStoredSessionId
      ? readSessionModelSelections()[noteStoredSessionId]
      : undefined;
    const rememberedSelection = rememberedEntry?.selection;
    const rememberedAppliedHermesModelId = rememberedEntry?.appliedSelection
      ? hermesModelIdForSelection(rememberedEntry.appliedSelection)
      : undefined;
    pendingModelSelectionRef.current = rememberedSelection;
    // A crash can leave appliedSelection newer than Hermes' persisted session
    // metadata. Until that metadata loads, keep the dispatch baseline unknown
    // so an early Send performs one safe repairing config.set.
    appliedHermesModelIdRef.current = undefined;
    storedSessionMetadataHydratedRef.current = !noteStoredSessionId;
    activeSubmissionRef.current = undefined;
    setSubmissionPending(false);
    setStoredSessionId(noteStoredSessionId);
    if (continuityRecord) {
      applyContinuityRecordToView(continuityRecord);
    } else {
      const emptyLiveStream = createHermesLiveStream();
      messagesRef.current = [];
      setMessages([]);
      liveEventsRef.current = emptyLiveStream;
      setLiveEvents(emptyLiveStream);
      pendingUserTurnsRef.current = [];
      setPendingUserTurns([]);
      workingRef.current = false;
      setWorking(false);
      terminalHandledRef.current = true;
      stoppedRunRef.current = false;
      stoppedRuntimeSessionIdRef.current = undefined;
      runGenerationRef.current = 0;
    }
    setError(null);
    setModelSelection(rememberedSelection);
    setAppliedHermesModelId(rememberedAppliedHermesModelId);
    if (!noteStoredSessionId) {
      bindMountedContinuityRecord(continuityRecord);
      setLoading(false);
      return () => bindMountedContinuityRecord(undefined);
    }
    const activeContinuityRecord = continuityRecord ?? noteChatContinuityFor(noteStoredSessionId);
    bindMountedContinuityRecord(activeContinuityRecord);
    let stale = false;
    setLoading(true);
    (async () => {
      // History lives behind the bridge; when it isn't running, skip the load
      // instead of spawning a runtime just to render an empty panel — the
      // first submit starts it and the post-turn refresh backfills history.
      const status = await hermesBridgeStatus();
      if (stale) return;
      if (!status.running) {
        setLoading(false);
        return;
      }
      const refreshSnapshot = beginNoteChatTranscriptRefresh(activeContinuityRecord);
      const [response, metadata] = await Promise.all([
        hermesBridgeSessionMessages(noteStoredSessionId).catch(() => undefined),
        reconcileStoredSessionModelMetadata(noteStoredSessionId),
      ]);
      if (response) {
        const nextMessages = sessionMessagesFrom(response);
        const applied = applyNoteChatTranscriptResponse(
          activeContinuityRecord,
          refreshSnapshot,
          nextMessages,
        );
        if (applied && noteId) {
          notifyNoteChatContinuity({
            noteId,
            storedSessionId: noteStoredSessionId,
            record: activeContinuityRecord,
          });
        }
        if (
          applied &&
          !stale &&
          noteGenerationRef.current === noteGeneration &&
          storedSessionIdRef.current === noteStoredSessionId
        ) {
          applyContinuityRecordToView(activeContinuityRecord);
        }
      }
      if (stale || noteGenerationRef.current !== noteGeneration) return;
      const currentEntry = readSessionModelSelections()[noteStoredSessionId];
      // Hermes session metadata is the conservative live baseline even when
      // an entry exists: config.set can succeed just before June crashes while
      // persisting its acknowledgement. Reapplying the desired model once is
      // safe; trusting a stale appliedSelection as newer than Hermes is not.
      const currentAppliedHermesModelId =
        metadata?.appliedHermesModelId ??
        (currentEntry?.appliedSelection
          ? hermesModelIdForSelection(currentEntry.appliedSelection)
          : undefined);
      storedSessionMetadataHydratedRef.current = true;
      appliedHermesModelIdRef.current = currentAppliedHermesModelId;
      setAppliedHermesModelId(currentAppliedHermesModelId);
      setLoading(false);
    })().catch(() => {
      // A missing/unreadable transcript degrades to an empty panel; the
      // pairing is kept so a submit still continues the same session.
      if (!stale) setLoading(false);
    });
    return () => {
      stale = true;
      bindMountedContinuityRecord(undefined);
    };
  }, [applyContinuityRecordToView, bindMountedContinuityRecord, noteId]);

  useEffect(
    () =>
      subscribeSessionModelSelections((store) => {
        const currentStoredSessionId = storedSessionIdRef.current;
        if (!currentStoredSessionId) return;
        const nextEntry = store[currentStoredSessionId];
        const nextSelection = nextEntry?.selection;
        pendingModelSelectionRef.current = nextSelection;
        setModelSelection(nextSelection);
        if (nextEntry && storedSessionMetadataHydratedRef.current) {
          const nextAppliedHermesModelId = nextEntry.appliedSelection
            ? hermesModelIdForSelection(nextEntry.appliedSelection)
            : undefined;
          appliedHermesModelIdRef.current = nextAppliedHermesModelId;
          setAppliedHermesModelId(nextAppliedHermesModelId);
        }
      }),
    [],
  );

  const refreshTranscript = useCallback(
    async (
      refreshNoteId: string,
      refreshStoredSessionId: string,
      record: NoteChatContinuityRecord,
    ) => {
      // Reconciliation is both request-ordered and revision-watermarked. An
      // older response cannot replace a newer one, while events arriving during
      // the fetch remain canonical in the live stream.
      const snapshot = beginNoteChatTranscriptRefresh(record);
      try {
        const response = await hermesBridgeSessionMessages(refreshStoredSessionId);
        const nextMessages = sessionMessagesFrom(response);
        if (!applyNoteChatTranscriptResponse(record, snapshot, nextMessages)) return;
        notifyNoteChatContinuity({
          noteId: refreshNoteId,
          storedSessionId: refreshStoredSessionId,
          record,
        });
        if (storedSessionIdRef.current !== refreshStoredSessionId) return;
        applyContinuityRecordToView(record);
      } catch {
        // Keep rendering from the live tail; the next terminal event retries.
      }
    },
    [applyContinuityRecordToView],
  );

  useEffect(
    () =>
      subscribeToGatewayClose(() => {
        // Never let a later send reuse a runtime id owned by the dead socket.
        runtimeSessionIdRef.current = undefined;
        const currentStoredSessionId = storedSessionIdRef.current;
        const recoveryRecord = continuityRecordRef.current;
        if (
          !workingRef.current ||
          !noteId ||
          !currentStoredSessionId ||
          !recoveryRecord ||
          recoveringGatewayRef.current
        ) {
          return;
        }

        const noteGeneration = noteGenerationRef.current;
        recoveringGatewayRef.current = true;
        void (async () => {
          try {
            const gateway = await connectGateway(true);
            if (!gateway) return;
            const runtimeSessionId = await resumeNoteChatRuntimeSession(
              gateway,
              currentStoredSessionId,
            );
            if (
              runtimeSessionId &&
              noteGenerationRef.current === noteGeneration &&
              storedSessionIdRef.current === currentStoredSessionId
            ) {
              runtimeSessionIdRef.current = runtimeSessionId;
            }
          } catch {
            // The live semantic stream stays mounted. Persistence reconciliation
            // below is the fallback until a later send or reconnect succeeds.
          } finally {
            recoveringGatewayRef.current = false;
            void refreshTranscript(noteId, currentStoredSessionId, recoveryRecord);
          }
        })();
      }),
    [noteId, refreshTranscript],
  );

  // The live tail: classified gateway events for THIS note's session only.
  useEffect(() => {
    return subscribeToGatewayEvents((event, route) => {
      const currentStoredSessionId = storedSessionIdRef.current;
      const eventRuntimeOrStoredSessionId = "sessionId" in event ? event.sessionId : undefined;
      const matchesSession =
        route?.storedSessionId === currentStoredSessionId ||
        eventRuntimeOrStoredSessionId === runtimeSessionIdRef.current ||
        eventRuntimeOrStoredSessionId === currentStoredSessionId;
      const terminal = isTerminalHermesEvent(event);
      // A tagged event for a different runtime or stored session isn't ours. A
      // terminal frame can arrive without either session id (error / lifecycle),
      // though. Attribute it only when this is the shared gateway's sole working
      // Note Chat (which also covers the pre-monitor acknowledgement window) or
      // the app-lifetime monitor can identify the Agent run. Untagged non-terminal
      // events stay dropped because they cannot be attributed to one transcript.
      if (eventRuntimeOrStoredSessionId && !matchesSession) return;
      if (!eventRuntimeOrStoredSessionId && !terminal) return;
      if (
        !eventRuntimeOrStoredSessionId &&
        terminal &&
        (!workingRef.current ||
          !storedSessionIdRef.current ||
          (soleWorkingNoteChatStoredSessionId() !== storedSessionIdRef.current &&
            !canAttributeUntaggedAgentRun(storedSessionIdRef.current, false)))
      ) {
        return;
      }
      if (terminal && currentStoredSessionId) {
        const record = noteChatContinuityFor(currentStoredSessionId);
        if (!route && record.working && !record.runAccepted) {
          bufferPreAcceptanceTerminal(record, {
            ...event,
            sessionId: currentStoredSessionId,
          } as JuneHermesEvent);
          return;
        }
      }
      if (terminal && route && !route.terminalAccepted) return;
      if (terminal && !route && terminalHandledRef.current) return;
      if (matchesSession) {
        const record =
          route?.record ??
          (currentStoredSessionId ? noteChatContinuityFor(currentStoredSessionId) : undefined);
        let next = route?.record.liveStream;
        if (!next && record && currentStoredSessionId) {
          const storedEvent = { ...event, sessionId: currentStoredSessionId } as JuneHermesEvent;
          next = appendHermesLiveEvent(record.liveStream, storedEvent);
          record.liveStream = next;
        }
        if (record) continuityRecordRef.current = record;
        if (next) {
          liveEventsRef.current = next;
          setLiveEvents(next);
        }
        if (
          event.kind === "transcript" &&
          event.complete &&
          route?.transcriptCompletionAccepted !== false
        ) {
          if (noteId && currentStoredSessionId && record) {
            void refreshTranscript(noteId, currentStoredSessionId, record);
          }
        }
      }
      if (terminal) {
        const record = currentStoredSessionId
          ? (route?.record ?? noteChatContinuityFor(currentStoredSessionId))
          : undefined;
        if (record && !noteChatLocalTerminalCanSettle(record)) {
          if (matchesSession && noteId && currentStoredSessionId) {
            void refreshTranscript(noteId, currentStoredSessionId, record);
          }
          return;
        }
        terminalHandledRef.current = true;
        workingRef.current = false;
        setWorking(false);
        const ownsTerminalEffects =
          !record || record.terminalEffectsRunGeneration !== record.runGeneration;
        if (record) {
          record.terminalHandled = true;
          record.working = false;
          record.currentRunPendingUserTurn = undefined;
          clearNoteChatTerminalAuthority(record);
          if (ownsTerminalEffects) {
            record.terminalEffectsRunGeneration = record.runGeneration;
          }
        }
        const stoppedByUser =
          route?.stoppedByUser ??
          (stoppedRunRef.current &&
            (!eventRuntimeOrStoredSessionId ||
              eventRuntimeOrStoredSessionId === stoppedRuntimeSessionIdRef.current));
        if (event.kind === "error") {
          setError(event.message);
        } else if (matchesSession) {
          if (noteId && currentStoredSessionId && record) {
            void refreshTranscript(noteId, currentStoredSessionId, record);
          }
        }
        if (!currentStoredSessionId || stoppedByUser || !ownsTerminalEffects) return;
        const terminalStatus = terminalAgentStatus(event);
        const ownsCurrentMonitor =
          !record || noteChatOwnsCurrentRunMonitor(currentStoredSessionId, record);
        if (terminalStatus === "completed") {
          if (ownsCurrentMonitor && record?.runMonitorGeneration !== undefined) {
            markAgentRunSucceeded(currentStoredSessionId, record.runMonitorGeneration);
          }
        } else if (terminalStatus) {
          const summary = noteChatTerminalStatusSummary(event, terminalStatus);
          if (terminalStatus === "failed") setError(summary);
          if (ownsCurrentMonitor && record?.runMonitorGeneration !== undefined) {
            cancelAgentRunMonitoring(currentStoredSessionId, record.runMonitorGeneration);
          }
          if (ownsCurrentMonitor) {
            dispatchAgentSessionStatus({
              sessionId: currentStoredSessionId,
              title: noteTitle.trim() || "Note chat",
              status: terminalStatus,
              summary,
              ...(record?.runMonitorGeneration === undefined
                ? {}
                : { runMonitorGeneration: record.runMonitorGeneration }),
            });
          }
        }
      }
    });
  }, [noteId, noteTitle, refreshTranscript]);

  useEffect(() => {
    const handleRunStarted = (rawEvent: Event) => {
      const detail = (rawEvent as CustomEvent<AgentRunStartedDetail>).detail;
      const currentStoredSessionId = storedSessionIdRef.current;
      if (!detail || detail.storedSessionId !== currentStoredSessionId) return;
      const record = noteChatContinuityFor(currentStoredSessionId);
      if (record.latestRunMonitorGeneration !== detail.runMonitorGeneration) return;
      if (!record.working || record.terminalHandled) return;
      setError(null);
      applyContinuityRecordToView(record);
    };
    const handleRunSettled = (rawEvent: Event) => {
      const detail = (rawEvent as CustomEvent<AgentRunSettledDetail>).detail;
      const currentStoredSessionId = storedSessionIdRef.current;
      const record = currentStoredSessionId
        ? noteChatContinuityFor(currentStoredSessionId)
        : undefined;
      if (
        !detail ||
        !currentStoredSessionId ||
        detail.sessionId !== currentStoredSessionId ||
        detail.runMonitorGeneration === undefined ||
        !record ||
        !noteChatAcceptsTerminalMonitorEvent(
          currentStoredSessionId,
          record,
          detail.runMonitorGeneration,
        )
      ) {
        return;
      }
      record.working = false;
      record.terminalHandled = true;
      record.currentRunPendingUserTurn = undefined;
      clearNoteChatTerminalAuthority(record);
      stoppedRunRef.current = false;
      stoppedRuntimeSessionIdRef.current = undefined;
      terminalHandledRef.current = true;
      workingRef.current = false;
      setWorking(false);
      if (noteId && currentStoredSessionId) {
        void refreshTranscript(noteId, currentStoredSessionId, record);
      }
    };
    const handleRunStatus = (rawEvent: Event) => {
      const detail = (rawEvent as CustomEvent<AgentSessionStatusDetail>).detail;
      const currentStoredSessionId = storedSessionIdRef.current;
      const record = currentStoredSessionId
        ? noteChatContinuityFor(currentStoredSessionId)
        : undefined;
      if (
        !detail ||
        !currentStoredSessionId ||
        detail.sessionId !== currentStoredSessionId ||
        detail.runMonitorGeneration === undefined ||
        (detail.status !== "failed" && detail.status !== "cancelled") ||
        !record ||
        !noteChatAcceptsTerminalMonitorEvent(
          currentStoredSessionId,
          record,
          detail.runMonitorGeneration,
        )
      ) {
        return;
      }
      record.working = false;
      record.terminalHandled = true;
      record.currentRunPendingUserTurn = undefined;
      clearNoteChatTerminalAuthority(record);
      stoppedRunRef.current = false;
      stoppedRuntimeSessionIdRef.current = undefined;
      terminalHandledRef.current = true;
      workingRef.current = false;
      setWorking(false);
      if (detail.status === "failed") {
        setError(detail.summary?.trim() || "June hit a problem.");
      }
      if (noteId && currentStoredSessionId) {
        void refreshTranscript(noteId, currentStoredSessionId, record);
      }
    };
    window.addEventListener(AGENT_RUN_STARTED_EVENT, handleRunStarted);
    window.addEventListener(AGENT_RUN_SETTLED_EVENT, handleRunSettled);
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleRunStatus);
    return () => {
      window.removeEventListener(AGENT_RUN_STARTED_EVENT, handleRunStarted);
      window.removeEventListener(AGENT_RUN_SETTLED_EVENT, handleRunSettled);
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleRunStatus);
    };
  }, [applyContinuityRecordToView, noteId, refreshTranscript]);

  const submit = useCallback(
    async (rawText: string, attachments: NoteChatAttachment[] = []): Promise<boolean> => {
      const question = rawText.trim();
      if ((!question && !attachments.length) || !noteId) return false;
      // Reject a second send that races the first before setWorking(true)
      // commits — otherwise both could create a session and submit the prompt.
      if (
        activeSubmissionRef.current ||
        activeSubmissionByNoteId.has(noteId) ||
        workingRef.current
      ) {
        return false;
      }
      const submissionToken = Symbol("note-chat-submit");
      activeSubmissionRef.current = submissionToken;
      activeSubmissionByNoteId.set(noteId, submissionToken);
      let runRecord: NoteChatContinuityRecord | undefined;
      let submissionRunGeneration: number | undefined;
      terminalHandledRef.current = false;
      setSubmissionPending(true);
      const noteGeneration = noteGenerationRef.current;
      const submissionIsCurrent = () =>
        noteGenerationRef.current === noteGeneration &&
        activeSubmissionRef.current === submissionToken;
      const submissionOwnsRunRecord = () =>
        submissionRunGeneration !== undefined &&
        runRecord?.runGeneration === submissionRunGeneration;
      const submissionWasCancelled = () =>
        cancelledSubmissionTokensRef.current.has(submissionToken) ||
        runRecord?.stopped === true ||
        (submissionRunGeneration !== undefined &&
          runRecord !== undefined &&
          !submissionOwnsRunRecord());
      const throwIfSubmissionCancelled = () => {
        if (submissionWasCancelled() || !submissionIsCurrent()) {
          throw new NoteChatSubmissionCancelledError();
        }
      };
      setError(null);
      const startingStoredSessionId = storedSessionIdRef.current;
      const startingRuntimeSessionId = runtimeSessionIdRef.current;
      runRecord = startingStoredSessionId
        ? noteChatContinuityFor(startingStoredSessionId)
        : provisionalNoteChatContinuityFor(noteId);
      let runStoredSessionId = startingStoredSessionId;
      submissionRunGeneration = (runRecord?.runGeneration ?? runGenerationRef.current) + 1;
      runGenerationRef.current = submissionRunGeneration;
      const isFirstMessage = !startingStoredSessionId;
      // Capture before the first await. A picker change after this point is for
      // the following run, even if session creation/resume is still pending.
      let capturedModelSelection = pendingModelSelectionRef.current;
      const defaultModelSelectionSnapshot =
        !capturedModelSelection && !startingStoredSessionId
          ? providerModelSettings().then(({ settings }) => defaultSessionModelSelection(settings))
          : undefined;
      const capturedModelEntry = startingStoredSessionId
        ? readSessionModelSelections()[startingStoredSessionId]
        : undefined;
      let capturedHermesModelId = capturedModelSelection
        ? hermesModelIdForSelection(capturedModelSelection)
        : undefined;
      let capturedAppliedHermesModelId = appliedHermesModelIdRef.current;
      let dispatchReservation: HermesSessionDispatchReservation | undefined =
        startingStoredSessionId ? reserveHermesSessionDispatch(startingStoredSessionId) : undefined;
      const visibleQuestion = question || "Use the attached file(s).";
      const base = isFirstMessage
        ? `${noteReferenceToken({ id: noteId, title: noteTitle })} ${visibleQuestion}`
        : visibleQuestion;
      const content = withAttachmentPaths(base, attachments);
      const optimistic: AgentChatTurn = {
        id: `note-chat-pending:${Date.now()}`,
        role: "user",
        createdAt: new Date().toISOString(),
        status: "complete",
        parts: [{ type: "text", text: visibleQuestion, status: "complete" }],
      };
      const optimisticPersistenceBoundary = noteChatPersistenceBoundary(
        runRecord?.messages ?? messagesRef.current,
        runRecord?.messagesHydrated ?? !startingStoredSessionId,
        Date.parse(optimistic.createdAt),
      );
      const nextPendingUserTurns = [
        ...(runRecord?.pendingUserTurns ?? pendingUserTurnsRef.current),
        optimistic,
      ];
      pendingUserTurnsRef.current = nextPendingUserTurns;
      setPendingUserTurns(nextPendingUserTurns);
      workingRef.current = true;
      setWorking(true);
      if (runRecord) {
        runRecord.pendingUserTurns = nextPendingUserTurns;
        runRecord.pendingUserPersistenceBoundaries.set(
          optimistic.id,
          optimisticPersistenceBoundary,
        );
        runRecord.working = true;
        runRecord.terminalHandled = false;
        runRecord.runAccepted = false;
        runRecord.runMonitorGeneration = undefined;
        runRecord.deferredPreAcceptanceTerminals = [];
        runRecord.currentRunPendingUserTurn = optimistic;
        clearNoteChatTerminalAuthority(runRecord);
        runRecord.stopped = false;
        runRecord.stoppedRuntimeSessionId = undefined;
        runRecord.stoppedRunMonitorGeneration = undefined;
        runRecord.runGeneration = submissionRunGeneration;
        runRecord.runtimeIntentEpoch += 1;
        continuityRecordRef.current = runRecord;
        bindMountedContinuityRecord(runRecord);
        notifyNoteChatContinuity({
          noteId,
          storedSessionId: startingStoredSessionId,
          record: runRecord,
        });
      }
      stoppedRunRef.current = false;
      stoppedRuntimeSessionIdRef.current = undefined;
      try {
        const gateway = await connectGateway(true);
        throwIfSubmissionCancelled();
        if (!gateway) throw new Error("Hermes gateway is not connected.");
        if (!capturedModelSelection && defaultModelSelectionSnapshot) {
          capturedModelSelection = await defaultModelSelectionSnapshot;
          throwIfSubmissionCancelled();
          capturedHermesModelId = hermesModelIdForSelection(capturedModelSelection);
        }
        let activeStoredSessionId = startingStoredSessionId;
        let runtimeSessionId = startingRuntimeSessionId;
        if (activeStoredSessionId && !capturedModelSelection) {
          const metadata = await reconcileStoredSessionModelMetadata(activeStoredSessionId);
          throwIfSubmissionCancelled();
          if (metadata) {
            capturedModelSelection = metadata.selection;
            capturedHermesModelId = hermesModelIdForSelection(metadata.selection);
            capturedAppliedHermesModelId = metadata.appliedHermesModelId;
            if (submissionIsCurrent()) {
              appliedHermesModelIdRef.current = metadata.appliedHermesModelId;
              storedSessionMetadataHydratedRef.current = true;
              setAppliedHermesModelId(metadata.appliedHermesModelId);
            }
          }
        }
        if (!activeStoredSessionId) {
          const created = await gateway.request<HermesRuntimeSessionResponse>("session.create", {
            title: noteTitle.trim() || "Note chat",
            cols: 96,
            ...(capturedHermesModelId ? { model: capturedHermesModelId } : {}),
          });
          throwIfSubmissionCancelled();
          activeStoredSessionId = created.stored_session_id ?? created.session_id;
          if (!activeStoredSessionId) throw new Error("Hermes did not create a session.");
          runStoredSessionId = activeStoredSessionId;
          dispatchReservation = reserveHermesSessionDispatch(activeStoredSessionId);
          runtimeSessionId = created.session_id;
          runRecord ??= provisionalNoteChatContinuityFor(noteId);
          adoptProvisionalNoteChatContinuity(noteId, activeStoredSessionId, runRecord);
          bindMountedContinuityRecord(runRecord);
          runRecord.messagesHydrated = true;
          runRecord.pendingUserTurns = nextPendingUserTurns;
          runRecord.pendingUserPersistenceBoundaries.set(
            optimistic.id,
            optimisticPersistenceBoundary,
          );
          runRecord.working = true;
          runRecord.terminalHandled = false;
          runRecord.runAccepted = false;
          runRecord.runMonitorGeneration = undefined;
          runRecord.deferredPreAcceptanceTerminals = [];
          runRecord.currentRunPendingUserTurn = optimistic;
          clearNoteChatTerminalAuthority(runRecord);
          runRecord.stopped = false;
          runRecord.stoppedRuntimeSessionId = undefined;
          runRecord.stoppedRunMonitorGeneration = undefined;
          runRecord.runGeneration = submissionRunGeneration;
          capturedAppliedHermesModelId = capturedHermesModelId;
          if (submissionIsCurrent()) {
            continuityRecordRef.current = runRecord;
            appliedHermesModelIdRef.current = capturedHermesModelId;
            storedSessionMetadataHydratedRef.current = true;
            setAppliedHermesModelId(capturedHermesModelId);
            storedSessionIdRef.current = activeStoredSessionId;
            setStoredSessionId(activeStoredSessionId);
          }
          rememberNoteChatSession(noteId, activeStoredSessionId);
          notifyNoteChatContinuity({
            noteId,
            storedSessionId: activeStoredSessionId,
            record: runRecord,
          });
          const latestSelection = submissionIsCurrent()
            ? pendingModelSelectionRef.current
            : capturedModelSelection;
          if (capturedModelSelection) {
            rememberAppliedSessionModelSelection(activeStoredSessionId, capturedModelSelection);
          }
          if (
            latestSelection &&
            (!capturedModelSelection ||
              !sameSessionModelSelection(latestSelection, capturedModelSelection))
          ) {
            stageSessionModelSelection(activeStoredSessionId, latestSelection);
          }
        }
        if (!runtimeSessionId) {
          runtimeSessionId = await resumeNoteChatRuntimeSession(gateway, activeStoredSessionId);
          throwIfSubmissionCancelled();
          if (!runtimeSessionId) throw new Error("Hermes did not resume the session.");
        }
        registerNoteChatRuntimeSession(activeStoredSessionId, runtimeSessionId);
        const activeRecord = runRecord ?? noteChatContinuityFor(activeStoredSessionId);
        notifyNoteChatContinuity({
          noteId,
          storedSessionId: activeStoredSessionId,
          record: activeRecord,
        });
        if (submissionIsCurrent()) {
          runtimeSessionIdRef.current = runtimeSessionId;
          continuityRecordRef.current = activeRecord;
        }
        const activeDispatchReservation =
          dispatchReservation ?? reserveHermesSessionDispatch(activeStoredSessionId);
        dispatchReservation = activeDispatchReservation;
        await activeDispatchReservation.run(async () => {
          throwIfSubmissionCancelled();
          // Re-read under the shared lock. AgentWorkspace can dispatch the same
          // session from its still-mounted surface, so its accepted send may
          // have changed the live model after this NoteChat send was captured.
          const currentModelEntry = readSessionModelSelections()[activeStoredSessionId];
          const currentStoredModelId = currentModelEntry?.appliedSelection
            ? hermesModelIdForSelection(currentModelEntry.appliedSelection)
            : currentModelEntry
              ? undefined
              : capturedAppliedHermesModelId;
          const modelToApply = capturedHermesModelId;
          if (
            modelToApply &&
            (hasPendingSessionModelSelection(capturedModelEntry) ||
              activeDispatchReservation.queuedBehindPrior ||
              modelToApply !== capturedAppliedHermesModelId ||
              (currentStoredModelId !== undefined && currentStoredModelId !== modelToApply))
          ) {
            // Apply only after the session is idle/resumed and immediately ahead
            // of the prompt. Failure blocks the send; silently using the prior
            // model would betray the picker.
            await applySessionModelWhenIdle(() =>
              createHermesMethods(gateway).switchActiveSessionModel({
                mode: "sandboxed",
                sessionId: runtimeSessionId,
                model: modelToApply,
              }),
            );
            throwIfSubmissionCancelled();
            capturedAppliedHermesModelId = modelToApply;
            if (submissionIsCurrent()) {
              appliedHermesModelIdRef.current = modelToApply;
              storedSessionMetadataHydratedRef.current = true;
              setAppliedHermesModelId(modelToApply);
            }
            if (capturedModelEntry && capturedModelSelection) {
              markSessionModelSelectionApplied(
                activeStoredSessionId,
                capturedModelEntry.revision,
                capturedModelSelection,
              );
            } else if (capturedModelSelection) {
              rememberAppliedSessionModelSelection(activeStoredSessionId, capturedModelSelection);
            }
          }
          // Images go to the model as first-class inputs before the prompt,
          // like the workspace's feature-19 flow. A failed attach throws so the
          // prompt is never sent with a silently-missing image; an unsupported
          // runtime keeps the image imported and the path block still carries it.
          const pendingImages = pendingImageAttachments(
            attachments.map((attachment) => attachment.attach),
          );
          if (pendingImages.length) {
            const methods = createHermesMethods(gateway);
            const deps = {
              attachImage: methods.attachImage,
              readImageData: (path: string) => hermesBridgeImageDataUrl(path),
              isSupported: () => isHermesFeatureSupported("image.attach_bytes"),
            };
            for (const image of pendingImages) {
              throwIfSubmissionCancelled();
              const result = await attachImageToSession(image, runtimeSessionId, deps);
              throwIfSubmissionCancelled();
              if (result.state.status === "failed") {
                throw new Error(result.error ?? `Could not attach ${image.displayName}.`);
              }
            }
          }
          throwIfSubmissionCancelled();
          const persistenceBoundary = activeRecord.pendingUserPersistenceBoundaries.get(
            optimistic.id,
          );
          if (!persistenceBoundary) throw new Error("Note chat prompt boundary is missing.");
          let dispatchPersistenceBoundary: NoteChatPersistenceBoundary;
          try {
            // This runs under the shared session dispatch lock, after every
            // earlier surface's prompt.submit has returned. Refresh the user
            // baseline here so an identical turn persisted during the lock
            // wait cannot authorize this run's assistant fallback.
            const persistedBeforeDispatch = sessionMessagesFrom(
              await withTimeout(
                hermesBridgeSessionMessages(activeStoredSessionId),
                NOTE_CHAT_DISPATCH_SNAPSHOT_TIMEOUT_MS,
                "Note chat dispatch snapshot timed out.",
              ),
            );
            throwIfSubmissionCancelled();
            dispatchPersistenceBoundary = noteChatPersistenceBoundary(
              persistedBeforeDispatch,
              true,
              persistenceBoundary.submittedAtMs,
            );
          } catch {
            throwIfSubmissionCancelled();
            // Without a fresh ordinal baseline, require a timestamp at or
            // after the actual dispatch boundary. This can stay unresolved
            // for coarse or missing timestamps, but cannot bless stale prose.
            dispatchPersistenceBoundary = {
              persistedUserIds: new Set(persistenceBoundary.persistedUserIds),
              persistedUserCount: persistenceBoundary.persistedUserCount,
              historyWasHydrated: false,
              submittedAtMs: Date.now(),
            };
          }
          // This is the earliest instant at which a terminal can belong to
          // this prompt. Keep the optimistic creation time separate: it is
          // intentionally earlier and remains the boundary for matching the
          // persisted user row after preflight and lock waits.
          const promptDispatchedAtMs = Date.now();
          dispatchPersistenceBoundary.promptDispatchedAtMs = promptDispatchedAtMs;
          if (!dispatchPersistenceBoundary.historyWasHydrated) {
            dispatchPersistenceBoundary.submittedAtMs = promptDispatchedAtMs;
          }
          activeRecord.pendingUserPersistenceBoundaries.set(
            optimistic.id,
            dispatchPersistenceBoundary,
          );
          const acceptedPromptBoundary: NoteChatPersistenceBoundary = {
            ...dispatchPersistenceBoundary,
            persistedUserIds: new Set(dispatchPersistenceBoundary.persistedUserIds),
          };
          await gateway.request("prompt.submit", {
            session_id: runtimeSessionId,
            text: content,
          });
          // A different surface can install a newer run while this RPC is in
          // flight. Once the request was dispatched, a note/view switch alone
          // must not discard its acknowledgement: finish the originating
          // continuity record without writing into the newly selected note.
          // Stop and generation replacement still revoke this run's authority.
          if (submissionWasCancelled()) {
            throw new NoteChatSubmissionCancelledError();
          }
          const acceptedRecord = runRecord ?? noteChatContinuityFor(activeStoredSessionId);
          const initialTerminalEvidence = deferredNoteChatTerminalEvidence(
            acceptedRecord,
            optimistic,
          );
          if (
            confirmNoteChatRunAccepted({
              gateway,
              pendingUserTurn: optimistic,
              record: acceptedRecord,
              runGeneration: submissionRunGeneration,
              runtimeSessionId,
              storedSessionId: activeStoredSessionId,
            })
          ) {
            const runMonitorGeneration = startAgentRunMonitoring({
              storedSessionId: activeStoredSessionId,
              runtimeSessionId,
              title: noteTitle.trim() || "Note chat",
              fullMode: false,
              settlementHeld: false,
              acceptedPrompt: {
                dispatchedAtMs: promptDispatchedAtMs,
                findPersistedUserIndex: (messages) =>
                  persistedPendingNoteChatUserIndexAtBoundary(
                    optimistic,
                    acceptedPromptBoundary,
                    messages,
                  ),
              },
              terminalEvidence: initialTerminalEvidence,
            });
            acceptedRecord.runMonitorGeneration = runMonitorGeneration;
            acceptedRecord.latestRunMonitorGeneration = Math.max(
              acceptedRecord.latestRunMonitorGeneration ?? 0,
              runMonitorGeneration,
            );
          }
          if (!acceptedRecord.stopped) {
            if (submissionIsCurrent()) {
              stoppedRuntimeSessionIdRef.current = undefined;
              stoppedRunRef.current = false;
            }
            acceptedRecord.stoppedRuntimeSessionId = undefined;
            acceptedRecord.stoppedRunMonitorGeneration = undefined;
          }
        });
        return submissionIsCurrent() && submissionOwnsRunRecord();
      } catch (err) {
        const cancelled = err instanceof NoteChatSubmissionCancelledError;
        const ownsRunLifecycle = submissionOwnsRunRecord();
        dispatchReservation?.cancel();
        if (runRecord) {
          runRecord.pendingUserTurns = runRecord.pendingUserTurns.filter(
            (turn) => turn !== optimistic,
          );
          runRecord.pendingUserPersistenceBoundaries.delete(optimistic.id);
          if (ownsRunLifecycle) {
            runRecord.working = false;
            runRecord.terminalHandled = true;
            runRecord.runAccepted = false;
            runRecord.deferredPreAcceptanceTerminals = [];
            runRecord.currentRunPendingUserTurn = undefined;
            clearNoteChatTerminalAuthority(runRecord);
          }
          notifyNoteChatContinuity({
            noteId,
            storedSessionId: runStoredSessionId,
            record: runRecord,
          });
          if (
            !runStoredSessionId &&
            provisionalNoteChatContinuityByNoteId.get(noteId) === runRecord
          ) {
            provisionalNoteChatContinuityByNoteId.delete(noteId);
          }
        }
        if (submissionIsCurrent() || (cancelled && noteGenerationRef.current === noteGeneration)) {
          const remainingPending = pendingUserTurnsRef.current.filter(
            (turn) => turn !== optimistic,
          );
          pendingUserTurnsRef.current = remainingPending;
          setPendingUserTurns(remainingPending);
          if (ownsRunLifecycle) {
            workingRef.current = false;
            terminalHandledRef.current = true;
            setWorking(false);
          }
          if (!cancelled && ownsRunLifecycle) {
            setError(
              isSessionBusyError(err)
                ? "June is still working on the previous message."
                : messageFromError(err),
            );
          }
          if (!cancelled && ownsRunLifecycle && !isSessionBusyError(err)) {
            const currentStoredSessionId = storedSessionIdRef.current;
            if (currentStoredSessionId && runRecord?.runMonitorGeneration !== undefined) {
              cancelAgentRunMonitoring(currentStoredSessionId, runRecord.runMonitorGeneration);
            }
            if (currentStoredSessionId) {
              dispatchAgentSessionStatus({
                sessionId: currentStoredSessionId,
                title: noteTitle.trim() || "Note chat",
                status: "failed",
                summary: messageFromError(err),
                ...(runRecord?.runMonitorGeneration === undefined
                  ? {}
                  : { runMonitorGeneration: runRecord.runMonitorGeneration }),
              });
            }
          }
        }
        return false;
      } finally {
        cancelledSubmissionTokensRef.current.delete(submissionToken);
        if (activeSubmissionByNoteId.get(noteId) === submissionToken) {
          activeSubmissionByNoteId.delete(noteId);
        }
        if (activeSubmissionRef.current === submissionToken) {
          activeSubmissionRef.current = undefined;
          setSubmissionPending(false);
        }
      }
    },
    [bindMountedContinuityRecord, noteId, noteTitle],
  );

  const stop = useCallback(() => {
    // Stopped is a UI-first state, mirroring the workspace: the moment the
    // user clicks, the turn reads as over; the interrupt follows best-effort.
    workingRef.current = false;
    setWorking(false);
    const activeSubmission = activeSubmissionRef.current;
    if (activeSubmission) {
      cancelledSubmissionTokensRef.current.add(activeSubmission);
    }
    stoppedRunRef.current = true;
    terminalHandledRef.current = true;
    const storedSessionId = storedSessionIdRef.current;
    const stopDispatchHold = storedSessionId
      ? holdHermesSessionDispatch(storedSessionId)
      : undefined;
    const record = storedSessionId
      ? noteChatContinuityFor(storedSessionId)
      : noteId
        ? provisionalNoteChatContinuityByNoteId.get(noteId)
        : undefined;
    const runtimeSessionId = record?.runtimeSessionId ?? runtimeSessionIdRef.current;
    let monitorStopAccepted = false;
    if (runtimeSessionId) {
      noteChatStoredSessionIdByRuntimeSessionId.delete(runtimeSessionId);
      runtimeSessionIdRef.current = undefined;
    }
    if (record) {
      const activeRunMonitorGeneration = noteChatActiveRunMonitorGeneration(record);
      record.working = false;
      record.stopped = true;
      record.stoppedRunMonitorGeneration = activeRunMonitorGeneration;
      record.runtimeIntentEpoch += 1;
      record.runtimeSessionId = undefined;
      record.terminalHandled = true;
      record.currentRunPendingUserTurn = undefined;
      clearNoteChatTerminalAuthority(record);
      record.stoppedRuntimeSessionId = runtimeSessionId;
      if (noteId) notifyNoteChatContinuity({ noteId, storedSessionId, record });
      if (storedSessionId && activeRunMonitorGeneration !== undefined) {
        monitorStopAccepted = stopAgentRunMonitoring(
          storedSessionId,
          activeRunMonitorGeneration,
          () => {
            if (noteId) void refreshTranscript(noteId, storedSessionId, record);
            stopDispatchHold?.release();
          },
        );
      }
      if (storedSessionId) {
        dispatchAgentSessionStatus({
          sessionId: storedSessionId,
          title: noteTitle.trim() || "Note chat",
          status: "cancelled",
          summary: "Stopped.",
          ...(activeRunMonitorGeneration === undefined
            ? {}
            : { runMonitorGeneration: activeRunMonitorGeneration }),
        });
      }
    }
    if (monitorStopAccepted) {
      if (noteId && storedSessionId && record) {
        void refreshTranscript(noteId, storedSessionId, record);
      }
      return;
    }
    if (!runtimeSessionId) {
      stopDispatchHold?.release();
      return;
    }
    stoppedRuntimeSessionIdRef.current = runtimeSessionId;
    const intentEpoch = record?.runtimeIntentEpoch ?? 0;
    const predecessor = storedSessionId
      ? runtimeResumeByStoredSessionId.get(storedSessionId)?.promise.catch(() => undefined)
      : undefined;
    let stopExpired = false;
    const interrupt = async (): Promise<string | undefined> => {
      try {
        await predecessor;
        if (stopExpired) return undefined;
        const gateway = await connectGateway(false);
        if (stopExpired) return undefined;
        await gateway?.request("session.interrupt", { session_id: runtimeSessionId });
      } catch {
        // The UI already reflects stopped; a failed interrupt (gateway down)
        // must not resurrect the working state.
      } finally {
        stopExpired = true;
        stopDispatchHold?.release();
        // Pull whatever the agent persisted before the interrupt landed.
        if (noteId && storedSessionId && record) {
          void refreshTranscript(noteId, storedSessionId, record);
        }
      }
      return undefined;
    };
    if (!storedSessionId || !record) {
      void interrupt();
      return;
    }
    const stopWork = interrupt();
    const stopTimeout = new Promise<string | undefined>((resolve) => {
      window.setTimeout(() => {
        stopExpired = true;
        resolve(undefined);
      }, 2000);
    });
    const attempt = Promise.race([stopWork, stopTimeout]).finally(() => {
      stopExpired = true;
      stopDispatchHold?.release();
      if (noteId) void refreshTranscript(noteId, storedSessionId, record);
      if (runtimeResumeByStoredSessionId.get(storedSessionId)?.promise === attempt) {
        runtimeResumeByStoredSessionId.delete(storedSessionId);
      }
    });
    runtimeResumeByStoredSessionId.set(storedSessionId, { intentEpoch, promise: attempt });
  }, [noteId, noteTitle, refreshTranscript]);

  const setSessionModel = useCallback((selection: SessionModelSelection) => {
    pendingModelSelectionRef.current = selection;
    setModelSelection(selection);
    const currentStoredSessionId = storedSessionIdRef.current;
    if (currentStoredSessionId) {
      stageSessionModelSelection(currentStoredSessionId, selection);
    }
  }, []);

  const turns = useMemo(() => {
    return buildHermesSessionChatTurns(messages, hermesLiveEvents(liveEvents), pendingUserTurns);
  }, [messages, liveEvents, pendingUserTurns]);

  return {
    turns,
    working,
    submissionPending,
    loading,
    error,
    storedSessionId,
    modelSelection,
    appliedHermesModelId,
    submit,
    stop,
    setSessionModel,
  };
}
