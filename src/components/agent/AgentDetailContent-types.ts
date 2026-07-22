import { type AgentTaskDto } from "../../lib/tauri";
import { type HermesMode } from "../../lib/hermes-control-plane";
import {
  type AgentApprovalChoice,
  type AgentChatPart,
  type AgentChatTurn,
} from "../../lib/agent-chat-runtime";
import { type AgentChatGallerySection } from "../../lib/agent-chat-gallery";
import type { UnsupportedEventNoticeData } from "../../lib/hermes-unsupported-events";
import type { ModelPrivacyBadge } from "../../lib/model-privacy";
import type { FundingTier } from "../account/FundingNotice";
import { type AgentArtifact } from "./chat-turns/AgentArtifactPanel";
import type * as React from "react";

export type RenderAgentDetailContentDependencies = {
  activeThinkingKey: string | undefined;
  approvalSubmitting: Partial<Record<string, AgentApprovalChoice>>;
  branchFromMessage: (
    sessionId: string | undefined,
    fromMessageId: string,
    modeSessionId?: string,
  ) => Promise<void>;
  branchingMessageId: string | null;
  browserAccessEnabled: boolean | undefined;
  browserAccessSubmitting: boolean;
  browserApprovalCards: JSX.Element[];
  cancelTask: (taskId: string) => Promise<void>;
  clarifySubmitting: Record<string, string>;
  cliAccessEnabled: boolean | undefined;
  cliAccessSubmitting: boolean;
  creditActionsDisabledReason: string | undefined;
  downloadArtifact: (artifact: AgentArtifact) => void;
  downloadGeneratedImage: (part: Extract<AgentChatPart, { type: "image" }>) => void;
  downloadGeneratedVideo: (part: Extract<AgentChatPart, { type: "video" }>) => void;
  enableBrowserAccessFromChat: () => Promise<void>;
  enableCliAccessFromChat: () => Promise<void>;
  fundingTier: FundingTier | undefined;
  galleryErrors: boolean;
  gallerySections: AgentChatGallerySection[] | null;
  generationPrivacyBadge: ModelPrivacyBadge | undefined;
  handleTopUp: () => void;
  hermesTurns: AgentChatTurn[];
  listRef: React.MutableRefObject<HTMLDivElement | null>;
  newSessionMode: boolean;
  openArtifact: (artifact: AgentArtifact) => void;
  openGeneratedImage: (part: Extract<AgentChatPart, { type: "image" }>) => void;
  pinTranscriptAfterVisibleReveal: () => void;
  rawTraceSession: string | undefined;
  respondToApproval: (
    liveEventKey: string,
    sessionId: string,
    requestId: string,
    choice: AgentApprovalChoice,
    unrestricted?: boolean,
  ) => Promise<void>;
  respondToClarify: (
    liveEventKey: string,
    requestId: string,
    answer: string,
    unrestricted?: boolean,
  ) => Promise<void>;
  respondToSecret: (
    liveEventKey: string,
    sessionId: string,
    requestId: string,
    value: string,
    unrestricted?: boolean,
  ) => Promise<void>;
  respondToSudo: (
    liveEventKey: string,
    sessionId: string,
    requestId: string,
    approved: boolean,
    mode?: HermesMode,
    unrestricted?: boolean,
  ) => Promise<void>;
  retryImageSlashTurn: (
    sessionId: string,
    assistantTurnId: string,
    part: Extract<AgentChatPart, { type: "image" }>,
  ) => Promise<void>;
  retryTask: (taskId: string) => Promise<void>;
  retryUpstreamProviderFailure: (
    storedSessionId: string | undefined,
    recoveryId: string | undefined,
  ) => Promise<void>;
  retryVideoSlashTurn: (
    sessionId: string,
    assistantTurnId: string,
    part: Extract<AgentChatPart, { type: "video" }>,
  ) => Promise<void>;
  secretSubmitting: Record<string, true>;
  selectedHermesSessionId: string | undefined;
  selectedTask: AgentTaskDto | undefined;
  setRawTraceSession: React.Dispatch<React.SetStateAction<string | undefined>>;
  setThinkingOpen: (key: string, open: boolean) => void;
  stopHermesSession: (sessionId: string) => Promise<void>;
  sudoSubmitting: Record<string, "deny" | "approve">;
  taskTurns: AgentChatTurn[];
  thinkingOpen: (key: string) => boolean;
  topUpLabel: string;
  turnArtifacts: Map<string, AgentArtifact[]>;
  unsupportedNotice: UnsupportedEventNoticeData | undefined;
  upstreamFailureRecoveryIds: Map<string, string>;
  waitingSessionIds: Set<string>;
  workingSessionIds: Set<string>;
  workingTaskIds: Set<string>;
};
