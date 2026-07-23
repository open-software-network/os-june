import { type AgentTaskDto, type HermesSessionInfo, type VeniceModelDto } from "../../lib/tauri";
import { type SessionUsage } from "../../lib/hermes-session-usage";
import { type CompressSessionResult } from "../../lib/hermes-session-compress";
import {
  // The store's record shape collides by name with this file's local
  // `AgentArtifact` (the file-viewer card), so alias it.
  type AgentArtifact as TimelineArtifact,
} from "../../lib/hermes-artifact-store";
import { type AgentChatTurn } from "../../lib/agent-chat-runtime";
import type { AgentProjectContext } from "../../lib/agent-project-context";
import type { AgentActivityRecord } from "../../lib/hermes-activity-store";
import type { ModelPrivacyBadge } from "../../lib/model-privacy";
import type { UsageDemoFixture } from "../../lib/usage-panel-demo";
import { type AgentPanel, type AgentShortcut } from "./agent-workspace-config";
import type { AgentWorkspaceOrigin } from "./agent-workspace-types";
import type {
  ImageSafeModeConsentChoice,
  ImageSafeModeConsentRequest,
} from "./agent-workspace-models";
import {
  type AgentWorkspaceError,
  type AgentWorkspaceErrorOptions,
} from "./agent-workspace-errors";
import { type AgentArtifact, type AgentArtifactPanelState } from "./chat-turns/AgentArtifactPanel";
import type * as React from "react";

export type RenderAgentWorkspaceLayoutDependencies = {
  ACTIVITY_DRAWER_ENABLED: false;
  activeAgentCount: number;
  activePanel: AgentPanel;
  activityDrawerOpen: boolean;
  activityRecords: AgentActivityRecord[];
  activityStatus: "loading" | "ready";
  agentScrollRef: React.MutableRefObject<HTMLDivElement | null>;
  artifactPanel: AgentArtifactPanelState | null;
  bridgeStarting: boolean;
  canShareAgentSession: (input: {
    selectedSessionId?: string;
    newSessionMode: boolean;
    provisional: boolean;
    historyLoaded: boolean;
    working: boolean;
  }) => boolean;
  compactSessionId: string | null;
  composer: JSX.Element | null;
  composerClearance: number;
  composerHasContent: boolean;
  compressSessionContext: (sessionId: string) => Promise<CompressSessionResult>;
  deleteSelectedHermesSession: (sessionId: string) => Promise<void>;
  detailContent: JSX.Element | null;
  downloadArtifact: (artifact: AgentArtifact) => void;
  fetchSessionUsage: (storedSessionId: string) => Promise<SessionUsage>;
  galleryErrors: boolean;
  generationModel: VeniceModelDto | undefined;
  generationPrivacyBadge: ModelPrivacyBadge | undefined;
  hermesTurns: AgentChatTurn[];
  heroChipPhase: "in" | "out";
  heroChipsHoverRef: React.MutableRefObject<boolean>;
  heroGreeting: string;
  heroLeaving: boolean;
  heroMode: boolean;
  heroShortcuts: AgentShortcut[];
  imageSafeModeConsentRequest: ImageSafeModeConsentRequest | null;
  modelForActivitySession: (sessionId: string) => { model: string } | undefined;
  newSessionMode: boolean;
  onMoveSessionToProject: ((sessionId: string) => void) | undefined;
  openArtifact: (artifact: AgentArtifact) => void;
  openSessionFromDrawer: (sessionId: string) => void;
  openTimelineArtifact: (artifact: TimelineArtifact) => void;
  origin: AgentWorkspaceOrigin | undefined;
  projectContext: AgentProjectContext | undefined;
  renameHermesSession: (sessionId: string, title: string) => void;
  resolveImageSafeModeConsent: (choice: ImageSafeModeConsentChoice) => void;
  resolveModel: (modelId: string) => VeniceModelDto | undefined;
  retryGatewayConnection: () => Promise<void>;
  runShortcut: (shortcut: AgentShortcut) => void;
  selectedHermesSession: HermesSessionInfo | undefined;
  selectedHermesSessionId: string | undefined;
  selectedHermesSessionIsProvisional: boolean;
  selectedHistoryLoaded: boolean;
  selectedTask: AgentTaskDto | undefined;
  sendErrorIssueReport: (error: AgentWorkspaceError) => Promise<void>;
  sessionInProject: boolean;
  sessionShareUrl: string | null;
  setActivityDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setArtifactPanel: React.Dispatch<React.SetStateAction<AgentArtifactPanelState | null>>;
  setCompactSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setSessionShareUrl: React.Dispatch<React.SetStateAction<string | null>>;
  setShareSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setUsagePanelSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  shareSessionId: string | null;
  startupSessionHydrationPending: boolean;
  steerSessionFromDrawer: (sessionId: string) => void;
  stopHermesSession: (sessionId: string) => Promise<void>;
  stopHermesSubagent: ({
    sessionId,
    subagentId,
  }: {
    sessionId: string;
    subagentId: string;
  }) => Promise<unknown>;
  submitting: boolean;
  submittingErrorIssueReport: boolean;
  surfacedArtifacts: AgentArtifact[];
  timelineArtifacts: TimelineArtifact[];
  titleForPendingSession: (sessionId: string) => string | undefined;
  usageDemo: UsageDemoFixture | null;
  usagePanelSessionId: string | null;
  visibleError: string | null;
  visibleErrorRetryable: boolean;
  visibleErrorState: AgentWorkspaceError | null;
  workingSessionIds: Set<string>;
};
