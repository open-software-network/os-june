import type * as React from "react";

export type SubmitHermesSession = (
  content: string,
  explicitSession?: HermesSessionInfo,
  options?: {
    issueReport?: PendingIssueReport;
    displayContent?: string;
    titleContent?: string;
    attachments?: AgentAttachment[];
    selectSession?: boolean;
    onAttachmentsUpdated?: (attachments: AgentAttachment[]) => void;
    modelTarget?: CapturedSessionModelTarget;
    dispatchReservation?: HermesSessionDispatchReservation;
    skipPrompt?: boolean;
  },
) => Promise<string | undefined>;
import type { AgentProjectContext } from "../../lib/agent-project-context";
import { ProjectContextSignatureStore } from "../../lib/agent-project-context";
import type { HermesRequestLike } from "../../lib/hermes-control-plane";
import type { HermesGatewayClient } from "../../lib/hermes-gateway";
import type { HermesSessionDispatchReservation } from "../../lib/hermes-session-dispatch-mutex";
import { type SessionModelSelectionMap } from "../../lib/hermes-session-model-selection";
import {
  type HermesSessionInfo,
  type HermesSessionMessage,
  type VeniceModelDto,
} from "../../lib/tauri";
import { type ThinkingLevel } from "../../lib/thinking-level";
import type { PendingIssueReport } from "./agent-session-continuity";
import type { AgentAttachment } from "./agent-workspace-models";
import { type CapturedSessionModelTarget } from "./composer/follow-up-queue";

import type { TurnDiagnosticsContext } from "../../lib/turn-diagnostics";

export type SubmitHermesSessionDependencies = {
  AGENT_TITLE_MAX_CHARS: 48;
  agentSessionTitleForPrompt: (
    prompt: string,
    response?: string,
  ) => Promise<{ title: string; fromModel: boolean; rejected: boolean }>;
  applyInitialSessionTitleSuggestion: (
    sessionId: string,
    suggestionPromise: Promise<{ title: string; fromModel: boolean; rejected: boolean }>,
  ) => Promise<void>;
  applyThinkingLevelToSession: (
    sessionId: string,
    level: ThinkingLevel,
    explicitRuntimeSessionId?: string,
    requestClient?: HermesRequestLike,
  ) => Promise<void>;
  attachHermesSessionEventListener: ({
    gateway,
    runtimeSessionId,
    sessionDisplayTitle,
    storedSessionId,
    computerUseRunLeaseId,
    turnDiagnostics,
  }: {
    gateway: HermesGatewayClient;
    runtimeSessionId: string;
    sessionDisplayTitle: string;
    storedSessionId: string;
    computerUseRunLeaseId?: string;
    turnDiagnostics?: TurnDiagnosticsContext;
  }) => () => void;
  attachPendingImages: (
    gateway: HermesRequestLike,
    runtimeSessionId: string,
    storedSessionId: string,
    turnAttachments: AgentAttachment[],
  ) => Promise<AgentAttachment[]>;
  captureSessionModelTarget: (explicitSession?: HermesSessionInfo) => CapturedSessionModelTarget;
  clearHeldFastPathImages: (sessionId: string, heldImages: AgentAttachment[]) => void;
  clearBackgroundSessionTitleGuard: (sessionId: string) => void;
  commitSessionModelSelections: (next: SessionModelSelectionMap) => void;
  creditActionsDisabledReason: string | undefined;
  defaultGenerationModelIdRef: React.MutableRefObject<string>;
  ensureHermesGateway: (fullMode?: boolean) => Promise<HermesGatewayClient>;
  fullModeDraftRef: React.MutableRefObject<boolean>;
  generationCostQualityRef: React.MutableRefObject<number | undefined>;
  generationModelsRef: React.MutableRefObject<VeniceModelDto[]>;
  generationSelectionIntentRevisionRef: React.MutableRefObject<number>;
  hermesSessionItemsRef: React.MutableRefObject<HermesSessionInfo[]>;
  hermesSessionsHydratedRef: React.MutableRefObject<boolean>;
  loadHermesSessions: (options?: {
    suppressStartupRequestError?: boolean;
    suppressSessionGoneError?: boolean;
  }) => Promise<"skipped" | "loaded" | "transient-startup-error" | "failed">;
  migrateOptimisticHermesSession: ({
    clearModel,
    createdAt,
    displayContent,
    fromSessionId,
    model,
    title,
    toSessionId,
  }: {
    clearModel?: boolean;
    createdAt: string;
    displayContent: string;
    fromSessionId: string;
    model?: string;
    title: string;
    toSessionId: string;
  }) => void;
  newSessionModeRef: React.MutableRefObject<boolean>;
  pendingFastPathImagesRef: React.MutableRefObject<Record<string, AgentAttachment[]>>;
  pendingHermesMessagesRef: React.MutableRefObject<Record<string, HermesSessionMessage[]>>;
  pendingIssueReportsRef: React.MutableRefObject<Map<string, PendingIssueReport>>;
  profileOwnedSessionIdsRef: React.MutableRefObject<Set<string>>;
  projectContext: AgentProjectContext | undefined;
  projectContextSignaturesBySessionId: ProjectContextSignatureStore;
  recordSessionErrorActivity: (sessionId: string, message: string) => void;
  recordSessionRunningActivity: (sessionId: string) => void;
  releaseComputerUseRun: (sessionId: string, runLeaseId: string) => Promise<void>;
  rememberComputerUseRun: (sessionId: string, runLeaseId: string) => void;
  removeOptimisticHermesSession: (optimisticSessionId: string, realSessionId?: string) => void;
  resolveSessionProjectContext:
    | ((storedSessionId: string) => AgentProjectContext | undefined)
    | undefined;
  runtimeSessionIdsRef: React.MutableRefObject<Record<string, string>>;
  selectedHermesSessionIdRef: React.MutableRefObject<string | undefined>;
  sessionGatewayUnlistenRef: React.MutableRefObject<Map<string, () => void>>;
  sessionModelSelectionsRef: React.MutableRefObject<SessionModelSelectionMap>;
  sessionThinkingAppliedRef: React.MutableRefObject<
    Record<string, { runtimeId: string; effort: string }>
  >;
  sessionThinkingEfforts: () => Record<string, ThinkingLevel>;
  sessionThinkingEffortsRef: React.MutableRefObject<Record<string, ThinkingLevel> | null>;
  setHermesSessionItems: React.Dispatch<React.SetStateAction<HermesSessionInfo[]>>;
  setNewSessionMode: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingHermesMessages: React.Dispatch<
    React.SetStateAction<Record<string, HermesSessionMessage[]>>
  >;
  setRuntimeSessionIds: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setSelectedHermesSessionId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setSelectedTaskId: React.Dispatch<React.SetStateAction<string | undefined>>;
  startOptimisticHermesSession: ({
    displayContent,
    model,
    title,
  }: {
    displayContent: string;
    model?: string;
    title: string;
  }) => { createdAt: string; id: string; userMessage: HermesSessionMessage };
  thinkingLevelRef: React.MutableRefObject<ThinkingLevel>;
  veniceApiKeyConfiguredRef: React.MutableRefObject<boolean>;
};
