import {
  type HermesBridgeStatus,
  type HermesSessionInfo,
  type HermesSessionMessage,
} from "../../lib/tauri";
import { type JuneHermesEvent } from "../../lib/hermes-control-plane";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import type * as React from "react";

export type useAgentWindowEventsDependencies = {
  bridge: HermesBridgeStatus;
  clearSessionActivity: (
    sessionId: string,
    status?: string,
  ) => { activeCount: number; needsUserCount: number };
  continueAfterCompletedAgentRun: (storedSessionId: string, source?: symbol) => void;
  hermesSessionItems: HermesSessionInfo[];
  hermesSessionMessagesRef: React.MutableRefObject<Record<string, HermesSessionMessage[]>>;
  hermesSessionsHydrated: boolean;
  listSessionMessagesOrdered: (sessionId: string) => Promise<HermesSessionMessage[] | undefined>;
  liveEventsRef: React.MutableRefObject<Record<string, JuneHermesEvent[]>>;
  pendingHermesMessagesRef: React.MutableRefObject<Record<string, HermesSessionMessage[]>>;
  promotePendingIssueReportToReview: (
    sessionId: string,
    options: { queueDiagnosisRefresh: boolean },
  ) => boolean;
  recordSessionRunningActivity: (sessionId: string) => void;
  selectedHermesSessionId: string | undefined;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setHermesSessionMessages: React.Dispatch<
    React.SetStateAction<Record<string, HermesSessionMessage[]>>
  >;
  setLiveEvents: React.Dispatch<React.SetStateAction<Record<string, JuneHermesEvent[]>>>;
  setPendingHermesMessages: React.Dispatch<
    React.SetStateAction<Record<string, HermesSessionMessage[]>>
  >;
  suggestTitleForUntitledSession: (
    sessionId: string,
    messages: HermesSessionMessage[],
  ) => Promise<void>;
  waitingSessionIdsRef: React.MutableRefObject<Set<string>>;
  workingSessionIdsRef: React.MutableRefObject<Set<string>>;
};
