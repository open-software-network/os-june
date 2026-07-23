import { type HermesSessionInfo, type VeniceModelDto } from "../../../lib/tauri";
import { type HermesSessionDispatchReservation } from "../../../lib/hermes-session-dispatch-mutex";
import { type ComposerEditorHandle } from "./ComposerEditor";
import { type ReportCategory } from "./reportCategory";
import {
  type AgentProjectContext,
  ProjectContextSignatureStore,
} from "../../../lib/agent-project-context";
import type { AgentAttachment } from "../agent-workspace-models";
import type { PendingIssueReport } from "../agent-session-continuity";
import { type AgentWorkspaceErrorOptions } from "../agent-workspace-errors";
import {
  type CapturedSessionModelTarget,
  type PendingAttachmentPreparation,
  type PendingSteer,
  type PreparedComposerSubmission,
} from "./follow-up-queue";
import { type ComposerInputSizeWarning } from "./composer-input-helpers";
import type * as React from "react";

export type SubmitComposerDependencies = {
  SESSION_BUSY_NOTICE: "June is still working on the previous message.";
  SESSION_BUSY_TOAST_ID: "agent-session-busy";
  attachments: AgentAttachment[];
  attachmentsRef: React.MutableRefObject<AgentAttachment[]>;
  beginAttachmentPreparation: (
    storedSessionId: string,
    dispatchOrder: number,
    dispatchReservation?: HermesSessionDispatchReservation,
  ) => PendingAttachmentPreparation;
  cancelComposerDispatch: (reservation: HermesSessionDispatchReservation | undefined) => void;
  captureSessionModelTarget: (explicitSession?: HermesSessionInfo) => CapturedSessionModelTarget;
  categoryRef: React.MutableRefObject<ReportCategory | null>;
  clearComposerDraft: (key?: string) => void;
  composerDispatchOrderRef: React.MutableRefObject<number>;
  composerDispatchWasInvalidated: (
    reservation: HermesSessionDispatchReservation | undefined,
  ) => boolean;
  composerDraftKeyRef: React.MutableRefObject<string | null>;
  composerEditorRef: React.MutableRefObject<ComposerEditorHandle | null>;
  composerSizeProceedSignatureRef: React.MutableRefObject<string | null>;
  deferredFailedIssueReportDeliverySessionIdsRef: React.MutableRefObject<Set<string>>;
  draftRef: React.MutableRefObject<string>;
  enqueueAttachmentFollowUp: (
    sessionId: string,
    prepared: PreparedComposerSubmission,
    queuedAttachments: AgentAttachment[],
    modelTarget: CapturedSessionModelTarget,
    dispatchReservation?: HermesSessionDispatchReservation,
    dispatchOrder?: number,
  ) => void;
  enqueueFailedComposerFollowUp: (
    queueKey: string,
    prepared: PreparedComposerSubmission,
    queuedAttachments: AgentAttachment[],
    modelTarget: CapturedSessionModelTarget,
    error: string,
    dispatchOrder?: number,
  ) => void;
  finishAttachmentPreparation: (
    storedSessionId: string,
    preparation: PendingAttachmentPreparation,
  ) => void;
  forgetComposerDispatch: (reservation: HermesSessionDispatchReservation | undefined) => void;
  generationModel: VeniceModelDto | undefined;
  generationModels: VeniceModelDto[];
  handleBuiltinComposerSlashCommand: (
    commandText: string,
    modelTarget?: CapturedSessionModelTarget,
    dispatchReservation?: HermesSessionDispatchReservation,
  ) => Promise<boolean>;
  heroMode: boolean;
  importingFiles: boolean;
  newSessionModeRef: React.MutableRefObject<boolean>;
  pendingSteerBySessionIdRef: React.MutableRefObject<Record<string, PendingSteer[]>>;
  prepareComposerSubmission: (
    message: string,
    messageAttachments: AgentAttachment[],
  ) => Promise<PreparedComposerSubmission>;
  projectContext: AgentProjectContext | undefined;
  projectContextSignaturesBySessionId: ProjectContextSignatureStore;
  reserveComposerDispatch: (storedSessionId: string) => HermesSessionDispatchReservation;
  reviewableIssueReportsRef: React.MutableRefObject<Record<string, PendingIssueReport>>;
  selectedHermesSessionId: string | undefined;
  selectedHermesSessionIdRef: React.MutableRefObject<string | undefined>;
  selectedHermesSessionIsProvisional: boolean;
  setCategory: React.Dispatch<React.SetStateAction<ReportCategory | null>>;
  setComposerAttachments: (
    nextValue: AgentAttachment[] | ((current: AgentAttachment[]) => AgentAttachment[]),
  ) => void;
  setComposerSizeWarning: React.Dispatch<React.SetStateAction<ComposerInputSizeWarning | null>>;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setHeroLeaving: React.Dispatch<React.SetStateAction<boolean>>;
  setReviewableIssueReport: (sessionId: string, report: PendingIssueReport | null) => void;
  setSteerCardsBySessionId: React.Dispatch<
    React.SetStateAction<Record<string, { id: string; text: string }[]>>
  >;
  setSubmitting: React.Dispatch<React.SetStateAction<boolean>>;
  setSubmittingHermesSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  steerActiveSession: (sessionId: string, text: string) => Promise<void>;
  steerCardSeqRef: React.MutableRefObject<number>;
  submitHermesSession: (
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
  submitting: boolean;
  submittingIssueReportSessionIdsRef: React.MutableRefObject<Set<string>>;
  textActionsDisabledReason: string | undefined;
  workingSessionIdsRef: React.MutableRefObject<Set<string>>;
};
