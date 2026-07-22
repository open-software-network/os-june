import { type HermesSessionMessage } from "../../lib/tauri";
import { type AgentSessionStatusKind } from "../../lib/agent-events";
import { type JuneHermesEvent } from "../../lib/hermes-control-plane";
import { type ThinkingLevel } from "../../lib/thinking-level";
import { type PendingSteer } from "./composer/follow-up-queue";
import type * as React from "react";

export type createSessionEventListenerDependencies = {
  cancelAgentRunSettlement: (storedSessionId: string) => void;
  clearSessionActivity: (
    sessionId: string,
    status?: string,
  ) => { activeCount: number; needsUserCount: number };
  clearSubmittedSteers: (sessionId: string, options?: { preserveReservations?: boolean }) => void;
  continueAfterCompletedAgentRun: (storedSessionId: string, source?: symbol) => void;
  liveEventsRef: React.MutableRefObject<Record<string, JuneHermesEvent[]>>;
  pendingSteerBySessionIdRef: React.MutableRefObject<Record<string, PendingSteer[]>>;
  promotePendingIssueReportToReview: (
    sessionId: string,
    options: { queueDiagnosisRefresh: boolean },
  ) => boolean;
  recordHermesActivityAndDeriveStatus: (
    event: JuneHermesEvent,
    storedSessionId: string,
  ) => AgentSessionStatusKind | undefined;
  refreshHermesSession: (sessionId: string) => Promise<HermesSessionMessage[] | undefined>;
  releaseAllComputerUseRuns: (sessionId: string) => Promise<void>;
  releaseComputerUseRun: (sessionId: string, runLeaseId: string) => Promise<void>;
  sessionGatewayUnlistenRef: React.MutableRefObject<Map<string, () => void>>;
  sessionThinkingAppliedRef: React.MutableRefObject<
    Record<string, { runtimeId: string; effort: string }>
  >;
  sessionThinkingEfforts: () => Record<string, ThinkingLevel>;
  sessionThinkingEffortsRef: React.MutableRefObject<Record<string, ThinkingLevel> | null>;
  setLiveEvents: React.Dispatch<React.SetStateAction<Record<string, JuneHermesEvent[]>>>;
  withStoredHermesSessionId: (event: JuneHermesEvent, storedSessionId: string) => JuneHermesEvent;
};
