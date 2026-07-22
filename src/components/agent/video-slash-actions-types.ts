import { type HermesSessionInfo } from "../../lib/tauri";
import { type HermesSessionDispatchReservation } from "../../lib/hermes-session-dispatch-mutex";
import { type AgentChatPart, type AgentChatTurn } from "../../lib/agent-chat-runtime";
import type { SubmitHermesSession } from "./session-submission-types";
import type { ImageSafeModeConsentChoice } from "./agent-workspace-models";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import { type CapturedSessionModelTarget } from "./composer/follow-up-queue";
import type * as React from "react";

export type createVideoSlashActionsDependencies = {
  captureSessionModelTarget: (explicitSession?: HermesSessionInfo) => CapturedSessionModelTarget;
  clearComposerCommandDraft: (commandText: string) => void;
  composerDispatchWasInvalidated: (
    reservation: HermesSessionDispatchReservation | undefined,
  ) => boolean;
  creditActionsDisabledReason: string | undefined;
  loadFilesystemSnapshot: () => Promise<void>;
  newSessionModeRef: React.MutableRefObject<boolean>;
  requestImageSafeModeConsent: (
    variant: "slash" | "agent" | "video-slash",
    ownerDispatchReservation?: HermesSessionDispatchReservation,
  ) => Promise<ImageSafeModeConsentChoice>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setGeneratingVideo: React.Dispatch<React.SetStateAction<boolean>>;
  setHeroLeaving: React.Dispatch<React.SetStateAction<boolean>>;
  setImportingFiles: React.Dispatch<React.SetStateAction<boolean>>;
  setVideoTurnsBySession: React.Dispatch<React.SetStateAction<Record<string, AgentChatTurn[]>>>;
  submitHermesSession: SubmitHermesSession;
  updateVideoSlashPart: (
    sessionId: string,
    assistantTurnId: string,
    patch: Partial<Extract<AgentChatPart, { type: "video" }>>,
  ) => void;
  videoSlashBaseTurnId: (assistantTurnId: string) => string;
};
