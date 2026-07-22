import { type HermesSessionInfo } from "../../lib/tauri";
import { type JuneHermesEvent } from "../../lib/hermes-control-plane";
import { type HermesSessionDispatchReservation } from "../../lib/hermes-session-dispatch-mutex";
import { type ComposerEditorHandle } from "./composer/ComposerEditor";
import { type ReportCategory } from "./composer/reportCategory";
import type { SubmitHermesSession } from "./session-submission-types";
import type { AgentAttachment } from "./agent-workspace-models";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import {
  type PendingAttachmentPreparation,
  type PendingSteer,
  type QueuedAttachmentFollowUp,
} from "./composer/follow-up-queue";
import type * as React from "react";

export type createFollowUpQueueActionsDependencies = {
  attachmentsRef: React.MutableRefObject<AgentAttachment[]>;
  cancelAgentRunSettlement: (storedSessionId: string) => void;
  cancelComposerDispatch: (reservation: HermesSessionDispatchReservation | undefined) => void;
  categoryRef: React.MutableRefObject<ReportCategory | null>;
  clearSubmittedSteers: (sessionId: string, options?: { preserveReservations?: boolean }) => void;
  completedAgentRunAwaitingAttachmentPreparationRef: React.MutableRefObject<Set<string>>;
  composerDraftKeyRef: React.MutableRefObject<string | null>;
  composerEditorRef: React.MutableRefObject<ComposerEditorHandle | null>;
  continuingCompletedAgentRunSourcesRef: React.MutableRefObject<Map<string, symbol | undefined>>;
  draftRef: React.MutableRefObject<string>;
  hermesSessionItemsRef: React.MutableRefObject<HermesSessionInfo[]>;
  liveEventsRef: React.MutableRefObject<Record<string, JuneHermesEvent[]>>;
  newSessionModeRef: React.MutableRefObject<boolean>;
  pendingAttachmentPreparationsRef: React.MutableRefObject<
    Record<string, Map<number, PendingAttachmentPreparation>>
  >;
  pendingCompletedAgentRunSourcesRef: React.MutableRefObject<Map<string, symbol>>;
  pendingSteerBySessionIdRef: React.MutableRefObject<Record<string, PendingSteer[]>>;
  queuedAttachmentFollowUpSeqRef: React.MutableRefObject<number>;
  queuedAttachmentFollowUpsRef: React.MutableRefObject<Record<string, QueuedAttachmentFollowUp[]>>;
  selectedHermesSessionIdRef: React.MutableRefObject<string | undefined>;
  setAttachments: React.Dispatch<React.SetStateAction<AgentAttachment[]>>;
  setCategory: React.Dispatch<React.SetStateAction<ReportCategory | null>>;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setLiveEvents: React.Dispatch<React.SetStateAction<Record<string, JuneHermesEvent[]>>>;
  setQueuedAttachmentFollowUps: React.Dispatch<
    React.SetStateAction<Record<string, QueuedAttachmentFollowUp[]>>
  >;
  submitHermesSession: SubmitHermesSession;
  watchCompletedAgentRunSettle: (storedSessionId: string) => void;
  workingSessionIdsRef: React.MutableRefObject<Set<string>>;
};
