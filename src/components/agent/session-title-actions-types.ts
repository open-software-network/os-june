import { type HermesSessionInfo, type HermesSessionMessage } from "../../lib/tauri";
import { type SessionModelSelectionMap } from "../../lib/hermes-session-model-selection";
import type { PendingIssueReport } from "./agent-session-continuity";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import { type AgentSessionTitleSource } from "./agent-session-continuity";
import type * as React from "react";

export type createSessionTitleActionsDependencies = {
  cancelAgentRunSettlement: (storedSessionId: string) => void;
  clearSubmittedSteers: (sessionId: string, options?: { preserveReservations?: boolean }) => void;
  commitSessionModelSelections: (next: SessionModelSelectionMap) => void;
  discardSessionAttachmentFollowUps: (storedSessionId: string) => void;
  hermesSessionItems: HermesSessionInfo[];
  hermesSessionItemsRef: React.MutableRefObject<HermesSessionInfo[]>;
  hermesSessionMessagesRef: React.MutableRefObject<Record<string, HermesSessionMessage[]>>;
  invalidateSessionComposerDispatches: (storedSessionId: string) => void;
  pendingIssueReportsRef: React.MutableRefObject<Map<string, PendingIssueReport>>;
  scrubHermesSessionState: (sessionId: string) => void;
  selectedHermesSessionIdRef: React.MutableRefObject<string | undefined>;
  sessionTitleOverridesRef: React.MutableRefObject<Record<string, string>>;
  sessionTitleSourceRef: React.MutableRefObject<Record<string, AgentSessionTitleSource>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setHermesSessionItems: React.Dispatch<React.SetStateAction<HermesSessionInfo[]>>;
  setReviewableIssueReport: (sessionId: string, report: PendingIssueReport | null) => void;
  setSelectedHermesSessionId: React.Dispatch<React.SetStateAction<string | undefined>>;
  titleSuggestionInFlightSessionIdsRef: React.MutableRefObject<Set<string>>;
  titleSuggestionSessionIdsRef: React.MutableRefObject<Set<string>>;
};
