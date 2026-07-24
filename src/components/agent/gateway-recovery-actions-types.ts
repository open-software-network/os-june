import {
  type HermesBridgeStatus,
  type HermesSessionInfo,
  type HermesSessionMessage,
} from "../../lib/tauri";
import { type AgentSessionStatusKind } from "../../lib/agent-events";
import { HermesGatewayClient } from "../../lib/hermes-gateway";
import { type JuneHermesEvent } from "../../lib/hermes-control-plane";
import { type AgentApprovalChoice } from "../../lib/agent-chat-runtime";
import type { SubmitHermesSession } from "./session-submission-types";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import { type CapturedSessionModelTarget } from "./composer/follow-up-queue";
import type * as React from "react";

export type createGatewayRecoveryActionsDependencies = {
  approvalResponseKey: (sessionId: string, requestId: string) => string;
  approvalResponsesInFlightRef: React.MutableRefObject<Map<string, AgentApprovalChoice>>;
  attachHermesSessionEventListener: ({
    gateway,
    runtimeSessionId,
    sessionDisplayTitle,
    storedSessionId,
    computerUseRunLeaseId,
  }: {
    gateway: HermesGatewayClient;
    runtimeSessionId: string;
    sessionDisplayTitle: string;
    storedSessionId: string;
    computerUseRunLeaseId?: string;
  }) => () => void;
  captureSessionModelTarget: (explicitSession?: HermesSessionInfo) => CapturedSessionModelTarget;
  ensureHermesGateway: (fullMode?: boolean) => Promise<HermesGatewayClient>;
  gatewayRecoveringRef: React.MutableRefObject<Set<boolean>>;
  hermesSessionItemsRef: React.MutableRefObject<HermesSessionInfo[]>;
  liveEventsRef: React.MutableRefObject<Record<string, JuneHermesEvent[]>>;
  loadHermesSessions: (options?: {
    suppressStartupRequestError?: boolean;
    suppressSessionGoneError?: boolean;
  }) => Promise<"skipped" | "loaded" | "transient-startup-error" | "failed">;
  recordHermesActivityAndDeriveStatus: (
    event: JuneHermesEvent,
    storedSessionId: string,
  ) => AgentSessionStatusKind | undefined;
  refreshHermesSession: (sessionId: string) => Promise<HermesSessionMessage[] | undefined>;
  selectedHermesSessionIdRef: React.MutableRefObject<string | undefined>;
  sessionGatewayUnlistenRef: React.MutableRefObject<Map<string, () => void>>;
  setBridge: React.Dispatch<React.SetStateAction<HermesBridgeStatus>>;
  setBridgeStarting: React.Dispatch<React.SetStateAction<boolean>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setLiveEvents: React.Dispatch<React.SetStateAction<Record<string, JuneHermesEvent[]>>>;
  setRuntimeSessionIds: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  submitHermesSession: SubmitHermesSession;
  waitingSessionIdsRef: React.MutableRefObject<Set<string>>;
  workingSessionIdsRef: React.MutableRefObject<Set<string>>;
};
