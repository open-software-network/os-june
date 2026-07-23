import { type HermesSessionInfo, type HermesSessionMessage } from "../../lib/tauri";
import { type JuneHermesEvent } from "../../lib/hermes-control-plane";
import type * as React from "react";
import type { AgentWorkspaceErrorOptions } from "./agent-workspace-errors";

export type createSessionRefreshActionDependencies = {
  clearSessionActivity: (
    sessionId: string,
    status?: string,
  ) => { activeCount: number; needsUserCount: number };
  continueAfterCompletedAgentRun: (storedSessionId: string, source?: symbol) => void;
  hermesSessionItems: HermesSessionInfo[];
  hermesSessionMessagesRef: React.MutableRefObject<Record<string, HermesSessionMessage[]>>;
  listSessionMessagesOrdered: (sessionId: string) => Promise<HermesSessionMessage[] | undefined>;
  liveEventsRef: React.MutableRefObject<Record<string, JuneHermesEvent[]>>;
  loadHermesSessions: (options?: {
    suppressStartupRequestError?: boolean;
    suppressSessionGoneError?: boolean;
  }) => Promise<"failed" | "skipped" | "loaded" | "transient-startup-error">;
  pendingHermesMessagesRef: React.MutableRefObject<Record<string, HermesSessionMessage[]>>;
  promotePendingIssueReportToReview: (
    sessionId: string,
    options: { queueDiagnosisRefresh: boolean },
  ) => boolean;
  releaseAllComputerUseRuns: (sessionId: string) => Promise<void>;
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
