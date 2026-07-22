import { type HermesSessionInfo } from "../../lib/tauri";
import { HermesGatewayClient, type HermesGatewayEvent } from "../../lib/hermes-gateway";
import { type JuneHermesEvent } from "../../lib/hermes-control-plane";
import { type HermesSessionDispatchReservation } from "../../lib/hermes-session-dispatch-mutex";
import { type AgentApprovalChoice } from "../../lib/agent-chat-runtime";
import type { SubmitHermesSession } from "./session-submission-types";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import { type CapturedSessionModelTarget } from "./composer/follow-up-queue";
import type * as React from "react";

export type createSessionResponseActionsDependencies = {
  approvalResponseKey: (sessionId: string, requestId: string) => string;
  approvalResponsesInFlightRef: React.MutableRefObject<Map<string, AgentApprovalChoice>>;
  cancelComposerDispatch: (reservation: HermesSessionDispatchReservation | undefined) => void;
  captureSessionModelTarget: (explicitSession?: HermesSessionInfo) => CapturedSessionModelTarget;
  classifyOptimisticLiveEvent: (event: HermesGatewayEvent) => JuneHermesEvent;
  clearSessionActivity: (
    sessionId: string,
    status?: string,
  ) => { activeCount: number; needsUserCount: number };
  composerDispatchWasInvalidated: (
    reservation: HermesSessionDispatchReservation | undefined,
  ) => boolean;
  ensureHermesGateway: (fullMode?: boolean) => Promise<HermesGatewayClient>;
  hermesSessionItemsRef: React.MutableRefObject<HermesSessionInfo[]>;
  liveEventsRef: React.MutableRefObject<Record<string, JuneHermesEvent[]>>;
  loadHermesSessions: (options?: {
    suppressStartupRequestError?: boolean;
    suppressSessionGoneError?: boolean;
  }) => Promise<"skipped" | "loaded" | "transient-startup-error" | "failed">;
  pushLiveEvent: (key: string, event: JuneHermesEvent) => void;
  recordOptimisticHermesActivityAndDispatchStatus: (
    event: JuneHermesEvent,
    storedSessionId: string,
  ) => void;
  reserveComposerDispatch: (storedSessionId: string) => HermesSessionDispatchReservation;
  selectedHermesSessionIdRef: React.MutableRefObject<string | undefined>;
  sessionGatewayUnlistenRef: React.MutableRefObject<Map<string, () => void>>;
  setApprovalSubmitting: React.Dispatch<
    React.SetStateAction<Partial<Record<string, AgentApprovalChoice>>>
  >;
  setBrowserAccessEnabled: React.Dispatch<React.SetStateAction<boolean | undefined>>;
  setBrowserAccessSubmitting: React.Dispatch<React.SetStateAction<boolean>>;
  setClarifySubmitting: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setCliAccessEnabled: React.Dispatch<React.SetStateAction<boolean | undefined>>;
  setCliAccessSubmitting: React.Dispatch<React.SetStateAction<boolean>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setLiveEvents: React.Dispatch<React.SetStateAction<Record<string, JuneHermesEvent[]>>>;
  setSecretSubmitting: React.Dispatch<React.SetStateAction<Record<string, true>>>;
  setSudoSubmitting: React.Dispatch<React.SetStateAction<Record<string, "deny" | "approve">>>;
  setWorkingTaskIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  submitHermesSession: SubmitHermesSession;
};
