import {
  type HermesBridgeStatus,
  type HermesSessionInfo,
  type HermesSessionMessage,
} from "../../lib/tauri";
import { HermesGatewayClient } from "../../lib/hermes-gateway";
import { type JuneHermesEvent } from "../../lib/hermes-control-plane";
import { type HermesSessionDispatchReservation } from "../../lib/hermes-session-dispatch-mutex";
import type { PendingIssueReport } from "./agent-session-continuity";
import type { ImageSafeModeConsentRequest } from "./agent-workspace-models";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import { type PendingSteer, type QueuedAttachmentFollowUp } from "./composer/follow-up-queue";
import { type AgentSessionTitleSource } from "./agent-session-continuity";
import type * as React from "react";

export type useAgentSessionEventsDependencies = {
  activeComposerDispatchReservationsRef: React.MutableRefObject<
    Map<HermesSessionDispatchReservation, string>
  >;
  diagnosisRefreshIssueReportSessionIdsRef: React.MutableRefObject<Set<string>>;
  gatewaysRef: React.MutableRefObject<Map<boolean, HermesGatewayClient>>;
  hasAutomaticContinuation: (storedSessionId: string) => boolean;
  hermesSessionItemsRef: React.MutableRefObject<HermesSessionInfo[]>;
  imageSafeModeConsentRequestRef: React.MutableRefObject<ImageSafeModeConsentRequest | null>;
  liveEventsRef: React.MutableRefObject<Record<string, JuneHermesEvent[]>>;
  pendingHermesMessagesRef: React.MutableRefObject<Record<string, HermesSessionMessage[]>>;
  pendingIssueReportsRef: React.MutableRefObject<Map<string, PendingIssueReport>>;
  pendingSteerBySessionIdRef: React.MutableRefObject<Record<string, PendingSteer[]>>;
  queuedAttachmentFollowUpsRef: React.MutableRefObject<Record<string, QueuedAttachmentFollowUp[]>>;
  reviewableIssueReportsRef: React.MutableRefObject<Record<string, PendingIssueReport>>;
  runtimeSessionIdsRef: React.MutableRefObject<Record<string, string>>;
  sessionTitleOverridesRef: React.MutableRefObject<Record<string, string>>;
  sessionTitleSourceRef: React.MutableRefObject<Record<string, AgentSessionTitleSource>>;
  setBridge: React.Dispatch<React.SetStateAction<HermesBridgeStatus>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  submittingIssueReportSessionIdsRef: React.MutableRefObject<Set<string>>;
  workingSessionIdsRef: React.MutableRefObject<Set<string>>;
};
