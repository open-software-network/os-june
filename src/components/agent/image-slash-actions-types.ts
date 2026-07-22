import { type HermesSessionInfo } from "../../lib/tauri";
import { type HermesSessionDispatchReservation } from "../../lib/hermes-session-dispatch-mutex";
import { type AgentChatPart, type AgentChatTurn } from "../../lib/agent-chat-runtime";
import type { AgentAttachment } from "./agent-workspace-models";
import type { PendingIssueReport } from "./agent-session-continuity";
import type { ImageSafeModeConsentRequest } from "./agent-workspace-models";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import { type CapturedSessionModelTarget } from "./composer/follow-up-queue";
import type * as React from "react";

export type createImageSlashActionsDependencies = {
  captureSessionModelTarget: (explicitSession?: HermesSessionInfo) => CapturedSessionModelTarget;
  clearComposerCommandDraft: (commandText: string) => void;
  composerDispatchWasInvalidated: (
    reservation: HermesSessionDispatchReservation | undefined,
  ) => boolean;
  creditActionsDisabledReason: string | undefined;
  imageSafeModeConsentRequestRef: React.MutableRefObject<ImageSafeModeConsentRequest | null>;
  imageSlashBaseTurnId: (assistantTurnId: string) => string;
  loadFilesystemSnapshot: () => Promise<void>;
  newSessionModeRef: React.MutableRefObject<boolean>;
  pendingFastPathImagesRef: React.MutableRefObject<Record<string, AgentAttachment[]>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setGeneratingImage: React.Dispatch<React.SetStateAction<boolean>>;
  setHeroLeaving: React.Dispatch<React.SetStateAction<boolean>>;
  setImageSafeModeConsentRequest: React.Dispatch<
    React.SetStateAction<ImageSafeModeConsentRequest | null>
  >;
  setImageTurnsBySession: React.Dispatch<React.SetStateAction<Record<string, AgentChatTurn[]>>>;
  setImportingFiles: React.Dispatch<React.SetStateAction<boolean>>;
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
  updateImageSlashPart: (
    sessionId: string,
    assistantTurnId: string,
    patch: Partial<Extract<AgentChatPart, { type: "image" }>>,
  ) => void;
};
