import type { Editor as TiptapEditor } from "@tiptap/react";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconBubble3 } from "central-icons/IconBubble3";
import { IconBubbleWide } from "central-icons/IconBubbleWide";
import { IconToolbox } from "central-icons/IconToolbox";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IconArrowCornerDownRight } from "central-icons/IconArrowCornerDownRight";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconFiles } from "central-icons/IconFiles";
import { IconPencil } from "central-icons/IconPencil";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "../ui/Toaster";
import {
  listSessionProfiles,
  computerUseStop,
  dictationHelperCommand,
  getAgentTask,
  hermesBrowserAccess,
  primeGeneratedVideoDir,
  importHermesBridgeFile,
  importHermesBridgeFileBytes,
  listVeniceModels,
  listAgentTasks,
  downloadHermesBridgeFile,
  providerModelSettings,
  revealPath,
  type AgentTaskDto,
  type AgentTaskStatus,
  type ImportedHermesFile,
  type HermesSessionMessage,
  type ProviderModelSettingsDto,
} from "../../lib/tauri";
import { listHermesSessionMessages, listHermesSessions } from "../../lib/hermes-adapter";
import {
  filterAgentSessionsForProfile,
  sessionMatchesProfile,
  sessionProfileMap,
} from "../../lib/session-profile-filter";
import {
  AGENT_GALLERY_EVENT,
  dispatchAgentSessionsChanged,
  dispatchAgentSessionStatus,
  type AgentGalleryDetail,
} from "../../lib/agent-events";
import { markAgentRunSucceeded } from "../../lib/agent-run-monitor";
import { HermesGatewayClient } from "../../lib/hermes-gateway";
import {
  createHermesMethods,
  hermesModeFor,
  type JuneHermesEvent,
} from "../../lib/hermes-control-plane";
import { parseSessionUsage, type SessionUsage } from "../../lib/hermes-session-usage";
import {
  parseCompressSessionResult,
  type CompressSessionResult,
} from "../../lib/hermes-session-compress";
import { normalizeSteerText } from "../../lib/hermes-session-steer";
import { unsupportedEventStore } from "../../lib/hermes-unsupported-events";
import { pendingActionStore } from "../../lib/hermes-pending-actions";
import { hermesActivityStore } from "../../lib/hermes-activity-store";
import {
  hermesArtifactStore,
  // The store's record shape collides by name with this file's local
  // `AgentArtifact` (the file-viewer card), so alias it.
  type AgentArtifact as TimelineArtifact,
} from "../../lib/hermes-artifact-store";
import {
  PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
  type ProviderModelSettingsChangedDetail,
} from "../../lib/model-privacy";
import {
  reserveHermesSessionDispatch,
  type HermesSessionDispatchReservation,
} from "../../lib/hermes-session-dispatch-mutex";
import { localGenerationOptionId } from "../../lib/local-generation";
import {
  rememberSessionThinkingLevel,
  saveThinkingLevel,
  thinkingEffortForLevel,
  type ThinkingLevel,
} from "../../lib/thinking-level";
import {
  HERMES_SERVER_ERROR_MESSAGE,
  describeHermesError,
  isHermesSessionsStartupRequestError,
  messageFromError,
} from "../../lib/errors";
import {
  parseSlashFileArguments,
  resolveSlashModel,
  slashModelResolutionError,
} from "../../lib/agent-composer-slash-commands";
import { type ComposerEditorHandle, stripPlaceholder } from "./composer/ComposerEditor";
import { type NoteReferenceInput } from "./composer/noteReference";
import { type ReportDialogAttachment } from "./ReportDialog";
import { hermesConnectionForMode } from "../../lib/hermes-connection";
import { sessionUnrestricted } from "../../lib/agent-session-modes";
import {
  buildAgentChatTurns,
  buildHermesSessionChatTurns,
  type AgentChatPart,
  type AgentChatTurn,
} from "../../lib/agent-chat-runtime";
import {
  COMPACTED_CONTEXT_SIGNATURE,
  ProjectContextSignatureStore,
} from "../../lib/agent-project-context";
import {
  buildAgentChatGallery,
  buildAgentErrorGallery,
  type AgentChatGallerySection,
} from "../../lib/agent-chat-gallery";
import { attachScrollThumbFade } from "../../lib/scroll-thumb-fade";
import type { AgentWorkspaceProps } from "./agent-workspace-types";
import { useAgentSelection } from "./use-agent-selection";
import { useAgentRuntimeState } from "./use-agent-runtime-state";
import { useAgentCoreState } from "./use-agent-core-state";
import { createModelSelectionActions } from "./model-selection-actions";
import { createPendingImageActions } from "./pending-image-actions";
import { createIssueReportActions } from "./issue-report-actions";
import { createComposerFileEvents } from "./composer/composer-file-events";
import { createComposerPreparation } from "./composer/composer-preparation";
import { renderAgentWorkspaceLayout } from "./AgentWorkspaceLayout";
import { renderAgentDetailContent } from "./AgentDetailContent";
import { renderAgentComposer } from "./composer/AgentComposer";
import { useAgentHeroHandoff } from "./use-agent-hero-handoff";
import { useAgentHeroRotation } from "./use-agent-hero-rotation";
import { useAgentTranscriptScroll } from "./use-agent-transcript-scroll";
import { useAgentDropEvents } from "./use-agent-drop-events";
import { useAgentProfileEvents } from "./use-agent-profile-events";
import { useComposerMenuDismiss } from "./use-composer-menu-dismiss";
import { useIssueReportEvents } from "./use-issue-report-events";
import { useAgentSessionEvents } from "./use-agent-session-events";
import { useAgentWindowEvents } from "./use-agent-window-events";
import { useAgentStreamDemo } from "./hooks/use-agent-stream-demo";
import { useAgentSteerDemo } from "./hooks/use-agent-steer-demo";
import { createCapabilityActions } from "./capability-actions";
import { createSessionTitleActions } from "./session-title-actions";
import { createManagementLoaders } from "./management-loaders";
import { createTaskControlActions } from "./task-control-actions";
import { createComposerDraftActions } from "./composer-draft-actions";
import { createTaskSubmissionAction } from "./task-submission-action";
import { createFollowUpQueueActions } from "./follow-up-queue-actions";
import { createBranchSessionAction } from "./branch-session-action";
import { createSessionResponseActions } from "./session-response-actions";
import { createRuntimeReconciliation } from "./runtime-reconciliation";
import { createGatewayRecoveryActions } from "./gateway-recovery-actions";
import { createSessionEventListener } from "./session-event-listener";
import { createOptimisticSessionActions } from "./optimistic-session-actions";
import { createVideoSlashActions } from "./video-slash-actions";
import { createImageSlashActions } from "./image-slash-actions";
import { createSubmitHermesSession } from "./session-submission";
import type { SubmitHermesSession } from "./session-submission-types";
import { createSubmitComposer } from "./composer/submit-composer";
import type { AgentAttachment } from "./agent-workspace-models";
export type { AgentWorkspaceOrigin } from "./agent-workspace-types";
export { SkillsToolsPanel } from "./management/SkillsToolsPanel";
export {
  envFieldSet,
  meaningfulCapabilityStatus,
  messagingTrimEdits,
  stateLabel,
} from "./management/management-helpers";
import { upstreamProviderRecoveryIds } from "../../lib/upstream-provider-recovery";
const BROWSER_APPROVALS_CHANGED_EVENT = "june://browser-approvals-changed";
const POLLED_STATUSES = new Set<AgentTaskStatus>(["queued", "running", "waitingForUser"]);
const AGENT_WORKSPACE_SESSION_RETRY_DELAYS_MS = [250, 500, 1000, 2000];
const AGENT_WORKSPACE_MAX_SESSION_RETRY_DELAY_MS =
  AGENT_WORKSPACE_SESSION_RETRY_DELAYS_MS[AGENT_WORKSPACE_SESSION_RETRY_DELAYS_MS.length - 1] ??
  2000;
const projectContextSignaturesBySessionId = new ProjectContextSignatureStore();
const QUEUED_STEER_RETRY_DELAY_MS = 300;
const RESTORED_QUEUED_STEER_RECONCILE_DELAY_MS = 1000;
const RESTORED_QUEUED_STEER_BUSY_RECONCILE_DELAY_MS = 3000;

// What the user reads instead of the gateway's "session busy" rejection. No
// action in the pill — the composer's send slot already shows stop while
// June works.
const SESSION_BUSY_NOTICE = "June is still working on the previous message.";

function approvalResponseKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`;
}

// A stable id for the "June is still working" nudge (fired when a send is
// rejected mid-turn), so repeated send attempts refresh one toast instead of
// stacking.
const SESSION_BUSY_TOAST_ID = "agent-session-busy";

// A stable id for the model control's notices (default-model changed,
// model-locked on an existing session, off-device confirm), so they replace one
// another in a single toast rather than stacking.
const MODEL_SWITCH_TOAST_ID = "agent-model-switch";

// Stable ids so the fork lifecycle (creating → branched) rides one
// self-replacing toast, and repeat report deliveries reuse a single "sent"
// confirmation rather than stacking.
const BRANCH_TOAST_ID = "agent-branch";
const ISSUE_REPORT_SENT_TOAST_ID = "agent-issue-report-sent";
const DOWNLOAD_TOAST_ID = "agent-download";

import {
  AGENT_DEV_FILES_EVENT,
  COMPOSER_STEER_DEMO_EVENT,
  buildSampleArtifactFiles,
  composerSteerDemoDesired,
  galleryDesired,
} from "./agent-dev-tools";
import {
  HERO_SHORTCUT_COUNT,
  advanceHeroGreeting,
  isProvisionalHermesSessionId,
  shuffleAgentShortcuts,
  type AgentPanel,
  type AgentShortcut,
} from "./agent-workspace-config";
export {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_NEW_SESSION_EVENT,
  AGENT_NEW_SESSION_PENDING_KEY,
  AGENT_SESSIONS_CHANGED_EVENT,
  AGENT_SESSION_RENAMED_EVENT,
  HERO_GREETINGS,
  type AgentSessionRenamedDetail,
  type AgentSessionsChangedDetail,
} from "./agent-workspace-config";
/** Frames the user's bug report for June: investigate and write a diagnosis
 * for the team instead of treating it as a normal request for help. */
import type { PendingIssueReport } from "./agent-session-continuity";

import {
  GATEWAY_CONNECTION_ERROR,
  isSessionGoneError,
  reportableAgentErrorOptions,
  type AgentWorkspaceError,
} from "./agent-workspace-errors";
export { agentWorkspaceErrorStateForMessage } from "./agent-workspace-errors";

import {
  imageSlashTurnsBySessionFromStored,
  removeStoredImageSlashSession,
  removeStoredVideoSlashSession,
  storedVideoSlashTurns,
  videoSlashTurnsBySessionFromStored,
} from "./composer/media-slash-persistence";
import {
  type CapturedSessionModelTarget,
  type PendingAttachmentPreparation,
  type QueuedAttachmentFollowUp,
} from "./composer/follow-up-queue";

import {
  persistReviewableIssueReports,
  persistedReviewableIssueReports,
  rememberComposerDraft,
  NEW_SESSION_RECOVERY_QUEUE_KEY,
  type AgentSessionTitleSource,
  type FileBytesImportOptions,
  type HermesRuntimeSessionResponse,
} from "./agent-session-continuity";
export {
  recordManualAgentSessionTitle,
  resetAgentSessionContinuity,
  seedAgentComposerDraftForTest,
} from "./agent-session-continuity";
/** The catalog id that represents the current global generation selection:
 * the synthetic "Local: <id>" option when local generation is the active
 * provider, otherwise the configured remote model id. Pure so it can back both
 * the mount fetch and the model-switch handler. */
function generationSelectionId(settings: ProviderModelSettingsDto, fallbackModelId = ""): string {
  const localModelId = settings.localGeneration?.modelId?.trim();
  if (settings.generationProvider === "local" && localModelId) {
    return localGenerationOptionId(localModelId);
  }
  return settings.generationModel || fallbackModelId;
}

export function composerInSteerStateFor(input: {
  selectedSessionId?: string;
  provisional: boolean;
  working: boolean;
  submitting: boolean;
  submittingSessionId: string | null;
  demo: boolean;
}): boolean {
  return Boolean(
    input.selectedSessionId &&
      !input.provisional &&
      (input.working ||
        (input.submitting && input.submittingSessionId === input.selectedSessionId) ||
        input.demo),
  );
}

export function canShareAgentSession(input: {
  selectedSessionId?: string;
  newSessionMode: boolean;
  provisional: boolean;
  historyLoaded: boolean;
  working: boolean;
}): boolean {
  return Boolean(
    input.selectedSessionId &&
      !input.newSessionMode &&
      !input.provisional &&
      input.historyLoaded &&
      !input.working,
  );
}

export function AgentWorkspace({
  initialSession,
  initialSessionId: initialSessionIdProp,
  origin,
  onSessionSelected,
  onTopUp,
  topUpLabel = "Upgrade",
  sessionInProject = false,
  projectContext,
  resolveSessionProjectContext,
  onMoveSessionToProject,
  creditActionsDisabledReason,
  renderFundingNotice,
  fundingTier,
  testOnlySlashCommandEntriesRef,
}: AgentWorkspaceProps = {}) {
  let submitHermesSessionImplementation: SubmitHermesSession;
  const submitHermesSession: SubmitHermesSession = (...args) =>
    submitHermesSessionImplementation(...args);
  const {
    initialSessionId,
    activeHermesProfile,
    continuity,
    tasks,
    setTasks,
    selectedTaskId,
    setSelectedTaskId,
    activePanel,
    setActivePanel,
    draft,
    setDraft,
    category,
    setCategory,
    draftRef,
    categoryRef,
    attachments,
    setAttachments,
    attachmentsRef,
    dropActive,
    setDropActive,
    importingFiles,
    setImportingFiles,
    generatingImage,
    setGeneratingImage,
    generatingVideo,
    setGeneratingVideo,
    composerSteerDemo,
    setComposerSteerDemo,
    loading,
    setLoading,
    submitting,
    setSubmitting,
    submittingHermesSessionId,
    setSubmittingHermesSessionId,
    errorState,
    submittingErrorIssueReport,
    setSubmittingErrorIssueReport,
    composerSizeWarning,
    setComposerSizeWarning,
    imageSafeModeConsentRequest,
    setImageSafeModeConsentRequest,
    browserApprovals,
    browserApprovalSubmitting,
    imageSafeModeConsentRequestRef,
    composerSizeProceedSignatureRef,
    composerSizeProceedInputSignatureRef,
    branchingMessageId,
    setBranchingMessageId,
    branchingMessageIdRef,
    bridge,
    setBridge,
    bridgeStarting,
    setBridgeStarting,
    fullModeDraft,
    setFullModeDraft,
    fullModeDraftRef,
    sandboxMenuOpen,
    setSandboxMenuOpen,
    confirmUnrestricted,
    setConfirmUnrestricted,
    sandboxTriggerRef,
    sandboxMenuRef,
    sandboxFirstItemRef,
    sandboxMenuWasOpenRef,
    attachMenuOpen,
    setAttachMenuOpen,
    attachTriggerRef,
    attachMenuRef,
    reportDialogOpen,
    setReportDialogOpen,
    reportDialogCategory,
    setReportDialogCategory,
    reportDialogDescription,
    setReportDialogDescription,
    reportDialogAttachments,
    setReportDialogAttachments,
    reportDialogGenerationRef,
    hermesSessionItems,
    setHermesSessionItems,
    hermesSessionItemsRef,
    profileOwnedSessionIdsRef,
    hermesSessionsHydrated,
    setHermesSessionsHydrated,
    hermesSessionsHydratedRef,
    restoredHermesSessionIdRef,
    selectedHermesSessionId,
    setSelectedHermesSessionId,
    selectedHermesSessionIdRef,
    lastAutoSubmittedRef,
    newSessionMode,
    setNewSessionMode,
    setError,
    respondToBrowserApproval,
    handleTopUp,
    clearErrorForSession,
  } = useAgentCoreState({
    BROWSER_APPROVALS_CHANGED_EVENT,
    initialSession,
    initialSessionIdProp,
    onTopUp,
  });
  const [heroGreeting, setHeroGreeting] = useState(advanceHeroGreeting);
  const heroGreetingConsumedRef = useRef(false);
  const [heroDeck, setHeroDeck] = useState(shuffleAgentShortcuts);
  const [heroDeckStart, setHeroDeckStart] = useState(0);
  const [heroChipPhase, setHeroChipPhase] = useState<"in" | "out">("in");
  const heroChipsHoverRef = useRef(false);
  // True while a shortcut/submit is tearing the hero down — drives the exit
  // transition (greeting drifts up, chips drift down) during session-create
  // latency, before the conversation view takes over.
  const [heroLeaving, setHeroLeaving] = useState(false);
  const [hermesSessionMessages, setHermesSessionMessages] = useState<
    Record<string, HermesSessionMessage[]>
  >({});
  const hermesSessionMessagesRef = useRef<Record<string, HermesSessionMessage[]>>({});
  const [pendingHermesMessages, setPendingHermesMessages] = useState<
    Record<string, HermesSessionMessage[]>
  >(() => continuity?.pendingMessages ?? {});
  const pendingHermesMessagesRef =
    useRef<Record<string, HermesSessionMessage[]>>(pendingHermesMessages);
  // Per-session, client-synthesized turns for the `/image` slash command. The
  // generated image never comes off the gateway message stream, so it can't ride
  // in `pendingHermesMessages` (those are HermesSessionMessages); these turns
  // carry the user prompt plus generated image and are hydrated from a small
  // localStorage metadata snapshot so reopening a session still shows the image.
  const [imageTurnsBySession, setImageTurnsBySession] = useState<Record<string, AgentChatTurn[]>>(
    imageSlashTurnsBySessionFromStored,
  );
  const [videoTurnsBySession, setVideoTurnsBySession] = useState<Record<string, AgentChatTurn[]>>(
    videoSlashTurnsBySessionFromStored,
  );

  useEffect(() => {
    // Cache the generated-videos dir so a video the agent names by bare
    // filename (MEDIA:generated-video-*.mp4) resolves to a playable src.
    void primeGeneratedVideoDir();
    const pending = Object.values(storedVideoSlashTurns())
      .flat()
      .filter((turn) => turn.pending && turn.jobId && turn.requestId);
    for (const turn of pending) {
      void resumePendingVideoSlashTurn(turn);
    }
  }, []);
  // JUN-171 (Phase A): the `/image` fast path renders in-thread but never enters
  // the model's session history, so a follow-up ("do you think it's nice?")
  // reaches an empty context. Hold each generated image here, keyed by session,
  // and lazily attach it to the user's NEXT prompt via the same
  // `image.attach_bytes` path composer attachments use — so the image lands in
  // context exactly when the model first needs it. A ref (not state) on purpose:
  // it must NOT render a composer chip (the image already shows in-thread; ADR
  // 0003 decision 2). Cleared once attached.
  const {
    pendingFastPathImagesRef,
    sessionMessagesFetchSeqRef,
    sessionMessagesAppliedSeqRef,
    hermesSessionsLoading,
    setHermesSessionsLoading,
    liveEvents,
    setLiveEvents,
    thinkingOpenByKey,
    setThinkingOpenByKey,
    workingTaskIds,
    setWorkingTaskIds,
    activityStoreVersion,
    activityRecords,
    toolCallSessionIds,
    waitingSessionIds,
    workingSessionIds,
    workingSessionIdsRef,
    toolCallSessionIdsRef,
    pendingSteerBySessionIdRef,
    activeComposerDispatchReservationsRef,
    invalidatedComposerDispatchReservationsRef,
    steerCardsBySessionId,
    setSteerCardsBySessionId,
    steerCardSeqRef,
    queuedAttachmentFollowUps,
    setQueuedAttachmentFollowUps,
    queuedAttachmentFollowUpsRef,
    pendingAttachmentPreparationsRef,
    completedAgentRunAwaitingAttachmentPreparationRef,
    computerUseRunLeasesRef,
    upNextDemoFollowUpsBySessionId,
    setUpNextDemoFollowUpsBySessionId,
    queuedAttachmentFollowUpSeqRef,
    composerDispatchOrderRef,
    continuingCompletedAgentRunSourcesRef,
    pendingCompletedAgentRunSourcesRef,
    steerQueueOpen,
    setSteerQueueOpen,
    steerCardsListRef,
    steerCardsFade,
    waitingSessionIdsRef,
    runtimeSessionIds,
    setRuntimeSessionIds,
    runtimeSessionIdsRef,
    workingReconcileMissesRef,
    stoppingSessionIds,
    setStoppingSessionIds,
    skills,
    setSkills,
    skillCommandsLoadRef,
    toolsets,
    setToolsets,
    messagingPlatforms,
    setMessagingPlatforms,
    defaultGenerationModelId,
    setDefaultGenerationModelId,
    generationCostQuality,
    setGenerationCostQuality,
    veniceApiKeyConfigured,
    setVeniceApiKeyConfigured,
    veniceApiKeyConfiguredRef,
    costQualitySaveChainRef,
    latestCostQualitySaveRef,
    confirmedCostQualityRef,
    defaultGenerationModelIdRef,
    generationCostQualityRef,
    generationSelectionIntentRevisionRef,
    generationSelectionSaveChainRef,
    sessionModelSelections,
    setSessionModelSelections,
    sessionModelSelectionsRef,
    generationModels,
    setGenerationModels,
    generationModelsRef,
    localGeneration,
    setLocalGeneration,
    localGenerationRef,
    localEnableConfirmArmedForRef,
    composerModelOpen,
    setComposerModelOpen,
    composerModelFromSlash,
    setComposerModelFromSlash,
    composerModelRootSearchRef,
    modelRootSearch,
    setModelRootSearch,
    composerModelFlyout,
    setComposerModelFlyout,
    modelSearch,
    setModelSearch,
    composerModelTriggerRef,
    composerModelPopoverRef,
    composerModelSearchRef,
    thinkingLevel,
    setThinkingLevel,
    thinkingLevelRef,
    sessionThinkingEffortsRef,
    sessionThinkingEfforts,
    sessionThinkingAppliedRef,
    setCapabilityLoading,
    skillCommandLoading,
    setSkillCommandLoading,
    setCapabilitySaving,
    setSelectedMessagingPlatformId,
    messagingEnvEdits,
    setMessagingEnvEdits,
    filesystemSnapshot,
    setFilesystemSnapshot,
    setFilesystemLoading,
    artifactPanel,
    setArtifactPanel,
    usagePanelSessionId,
    setUsagePanelSessionId,
    usageDemo,
    compactSessionId,
    setCompactSessionId,
    shareSessionId,
    setShareSessionId,
    sessionShareUrl,
    setSessionShareUrl,
    devArtifacts,
    setDevArtifacts,
    approvalSubmitting,
    setApprovalSubmitting,
    approvalResponsesInFlightRef,
    clarifySubmitting,
    setClarifySubmitting,
    sudoSubmitting,
    setSudoSubmitting,
    secretSubmitting,
    setSecretSubmitting,
    cliAccessEnabled,
    setCliAccessEnabled,
    cliAccessSubmitting,
    setCliAccessSubmitting,
    browserAccessEnabled,
    setBrowserAccessEnabled,
    browserAccessSubmitting,
    setBrowserAccessSubmitting,
  } = useAgentRuntimeState({
    continuity,
    selectedHermesSessionId,
  });

  useEffect(() => {
    let cancelled = false;
    hermesBrowserAccess()
      .then((status) => {
        if (!cancelled) setBrowserAccessEnabled(status.enabled);
      })
      .catch(() => {
        if (!cancelled) setBrowserAccessEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // Dev-tools response gallery: when set, the timeline is replaced by a labeled
  // catalog of every agent response part type. Toggled from the console via
  // window.__agentGallery() — see the effect below. The errors flag marks the
  // __agentErrors() variant, which additionally forces the chrome-level error
  // surfaces (error banner, composer busy notice) for styling.
  const [gallerySections, setGallerySections] = useState<AgentChatGallerySection[] | null>(null);
  const [galleryErrors, setGalleryErrors] = useState(false);
  // One gateway client per write-access mode: the sandboxed and unrestricted
  // runtime processes run side by side, each with its own socket. Sessions
  // route to the gateway matching their recorded mode.
  const gatewaysRef = useRef<Map<boolean, HermesGatewayClient>>(new Map());
  // The gateway's close listener is registered once per client instance, so
  // it routes through this ref to always run the latest render's recovery
  // closure (see recoverFromGatewayClose).
  const gatewayCloseHandlerRef = useRef((_fullMode: boolean) => {});
  // Per-mode: both gateways can drop together (network reconnect), and one
  // mode's in-flight recovery must not swallow the other's only onClose.
  const gatewayRecoveringRef = useRef<Set<boolean>>(new Set());
  // One live gateway subscription per Hermes session. A follow-up send while
  // the previous turn is still streaming must replace the old handler, not
  // stack a second one — otherwise every event lands twice in liveEvents.
  const sessionGatewayUnlistenRef = useRef<Map<string, () => void>>(new Map());
  const liveEventsRef = useRef<Record<string, JuneHermesEvent[]>>(liveEvents);
  const hydratedTaskIdsRef = useRef<Set<string>>(new Set());
  // Tasks whose hydration fetch has resolved (hydratedTaskIdsRef only says
  // the fetch *started*) — the scroll-settling logic needs the landing.
  const taskHistoryLoadedIdsRef = useRef<Set<string>>(new Set());
  const newSessionModeRef = useRef(newSessionMode);
  // sessionId -> the report captured for the active report turn. Once June's
  // diagnostic turn finishes, it moves to reviewableIssueReports so the user
  // can add context or send it.
  const pendingIssueReportsRef = useRef<Map<string, PendingIssueReport>>(
    new Map(Object.entries(continuity?.pendingIssueReports ?? {})),
  );
  const [reviewableIssueReports, setReviewableIssueReports] = useState<
    Record<string, PendingIssueReport>
  >(() => ({
    ...persistedReviewableIssueReports(),
    ...(continuity?.reviewableIssueReports ?? {}),
  }));
  const reviewableIssueReportsRef =
    useRef<Record<string, PendingIssueReport>>(reviewableIssueReports);
  const [diagnosisRefreshIssueReportSessionIds, setDiagnosisRefreshIssueReportSessionIds] =
    useState<Set<string>>(() => new Set(continuity?.diagnosisRefreshIssueReportSessionIds ?? []));
  const diagnosisRefreshIssueReportSessionIdsRef = useRef<Set<string>>(
    diagnosisRefreshIssueReportSessionIds,
  );
  const issueReportDiagnosisRefreshesRef = useRef<Map<string, Promise<void>>>(new Map());
  const deferredFailedIssueReportDeliverySessionIdsRef = useRef<Set<string>>(new Set());
  const [submittingIssueReportSessionIds, setSubmittingIssueReportSessionIds] = useState<
    Set<string>
  >(() => new Set(continuity?.submittingIssueReportSessionIds ?? []));
  const submittingIssueReportSessionIdsRef = useRef<Set<string>>(submittingIssueReportSessionIds);
  // True only while a brand-new thread is being started from the hero. The
  // hero→dock composer FLIP keys off this so it glides *only* when the empty
  // chat hands over to a fresh thread — not when the hero is dismissed by
  // selecting an existing chat from the sidebar (that should swap instantly).
  const heroExitViaThreadRef = useRef(false);
  const sessionTitleOverridesRef = useRef<Record<string, string>>(continuity?.titleOverrides ?? {});
  const sessionTitleSourceRef = useRef<Record<string, AgentSessionTitleSource>>(
    continuity?.titleSources ?? {},
  );
  const titleSuggestionSessionIdsRef = useRef<Set<string>>(new Set());
  const titleSuggestionInFlightSessionIdsRef = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement | null>(null);
  const agentScrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const composerEditorRef = useRef<ComposerEditorHandle | null>(null);
  const composerTiptapEditorRef = useRef<TiptapEditor | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  const [composerClearance, setComposerClearance] = useState(0);
  // A note reference to seed once the editor is ready, set by startNewTask for
  // note-level "Ask June" entry points.
  const pendingSeedNoteRefRef = useRef<{
    noteRef: NoteReferenceInput;
    prompt: string;
  } | null>(null);

  function setReviewableIssueReport(sessionId: string, report: PendingIssueReport | null) {
    const next = { ...reviewableIssueReportsRef.current };
    if (report) {
      next[sessionId] = report;
    } else {
      delete next[sessionId];
    }
    reviewableIssueReportsRef.current = next;
    persistReviewableIssueReports(next);
    setReviewableIssueReports(next);
  }

  function setIssueReportDiagnosisRefreshing(sessionId: string, refreshing: boolean) {
    const next = new Set(diagnosisRefreshIssueReportSessionIdsRef.current);
    if (refreshing) {
      next.add(sessionId);
    } else {
      next.delete(sessionId);
    }
    diagnosisRefreshIssueReportSessionIdsRef.current = next;
    setDiagnosisRefreshIssueReportSessionIds(next);
  }

  function queueIssueReportDiagnosisRefresh(sessionId: string, delayMs = 300) {
    setIssueReportDiagnosisRefreshing(sessionId, true);
    let refresh: Promise<void>;
    refresh = new Promise<void>((resolve) => {
      window.setTimeout(() => {
        void refreshHermesSession(sessionId).finally(resolve);
      }, delayMs);
    }).finally(() => {
      if (issueReportDiagnosisRefreshesRef.current.get(sessionId) === refresh) {
        issueReportDiagnosisRefreshesRef.current.delete(sessionId);
        setIssueReportDiagnosisRefreshing(sessionId, false);
      }
    });
    issueReportDiagnosisRefreshesRef.current.set(sessionId, refresh);
    return refresh;
  }

  function waitForIssueReportDiagnosisRefresh(sessionId: string) {
    if (!diagnosisRefreshIssueReportSessionIdsRef.current.has(sessionId)) {
      return Promise.resolve();
    }
    return (
      issueReportDiagnosisRefreshesRef.current.get(sessionId) ??
      queueIssueReportDiagnosisRefresh(sessionId)
    );
  }

  function promotePendingIssueReportToReview(
    sessionId: string,
    options: { queueDiagnosisRefresh: boolean },
  ) {
    const issueReport = pendingIssueReportsRef.current.get(sessionId);
    if (!issueReport) return false;
    pendingIssueReportsRef.current.delete(sessionId);
    deferredFailedIssueReportDeliverySessionIdsRef.current.delete(sessionId);
    setReviewableIssueReport(sessionId, issueReport);
    if (options.queueDiagnosisRefresh) {
      queueIssueReportDiagnosisRefresh(sessionId);
    } else {
      setIssueReportDiagnosisRefreshing(sessionId, false);
    }
    return true;
  }

  function setIssueReportSubmitting(sessionId: string, submitting: boolean) {
    const next = new Set(submittingIssueReportSessionIdsRef.current);
    if (submitting) {
      next.add(sessionId);
    } else {
      next.delete(sessionId);
    }
    submittingIssueReportSessionIdsRef.current = next;
    setSubmittingIssueReportSessionIds(next);
  }

  useIssueReportEvents({
    deferredFailedIssueReportDeliverySessionIdsRef,
    pendingIssueReportsRef,
    reviewableIssueReportsRef,
    setError,
    setIssueReportSubmitting,
    setReviewableIssueReport,
  });

  useEffect(() => {
    for (const sessionId of diagnosisRefreshIssueReportSessionIdsRef.current) {
      queueIssueReportDiagnosisRefresh(sessionId);
    }
  }, []);

  useEffect(() => {
    runtimeSessionIdsRef.current = runtimeSessionIds;
  }, [runtimeSessionIds]);

  useEffect(
    () => () => {
      computerUseRunLeasesRef.current.clear();
      void computerUseStop().catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    const restoredSessionIds = Array.from(workingSessionIdsRef.current);
    if (!restoredSessionIds.length) return;
    let cancelled = false;

    void (async () => {
      for (const sessionId of restoredSessionIds) {
        const runtimeSessionId = runtimeSessionIdsRef.current[sessionId];
        if (!runtimeSessionId) continue;
        try {
          const gateway = await ensureHermesGateway(sessionUnrestricted(sessionId));
          if (cancelled || !workingSessionIdsRef.current.has(sessionId)) {
            continue;
          }
          // Reconnect only to observe the existing run. A process restored
          // after an app relaunch did not cross this mount's visible Send
          // boundary, so it must not receive a fresh Computer use lease.
          attachHermesSessionEventListener({
            gateway,
            runtimeSessionId,
            sessionDisplayTitle:
              hermesSessionItemsRef.current.find((session) => session.id === sessionId)?.title ??
              "Agent session",
            storedSessionId: sessionId,
          });
        } catch {
          // The working-session poll still reconciles if reconnecting fails.
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    selectedHermesSessionIdRef.current = selectedHermesSessionId;
    workingSessionIdsRef.current = workingSessionIds;
    toolCallSessionIdsRef.current = toolCallSessionIds;
    waitingSessionIdsRef.current = waitingSessionIds;
    hermesSessionMessagesRef.current = hermesSessionMessages;
    pendingHermesMessagesRef.current = pendingHermesMessages;
    hermesSessionItemsRef.current = hermesSessionItems;
  }, [
    hermesSessionMessages,
    hermesSessionItems,
    pendingHermesMessages,
    selectedHermesSessionId,
    toolCallSessionIds,
    waitingSessionIds,
    workingSessionIds,
  ]);

  function recordSessionRunningActivity(sessionId: string) {
    hermesActivityStore.record(
      {
        kind: "lifecycle",
        sessionId,
        flavor: "running",
        status: "running",
        text: "",
        receivedAt: new Date().toISOString(),
      },
      hermesModeFor(sessionId),
    );
  }

  function recordHermesActivityAndDeriveStatus(event: JuneHermesEvent, storedSessionId: string) {
    hermesActivityStore.record(event, hermesModeFor(storedSessionId));
    const hasOpenPendingAction = pendingActionStore
      .openRecords()
      .some((record) => record.sessionId === storedSessionId);
    return agentStatusFromHermesEvent(event, hasOpenPendingAction);
  }

  function recordOptimisticHermesActivityAndDispatchStatus(
    event: JuneHermesEvent,
    storedSessionId: string,
  ) {
    const storedEvent = withStoredHermesSessionId(event, storedSessionId);
    const status = recordHermesActivityAndDeriveStatus(storedEvent, storedSessionId);
    if (!status) return;
    dispatchAgentSessionStatus({
      sessionId: storedSessionId,
      title:
        hermesSessionItemsRef.current.find((session) => session.id === storedSessionId)?.title ??
        "Agent session",
      status,
      summary: agentStatusSummaryFromHermesEvent(storedEvent, status),
    });
  }

  function recordSessionErrorActivity(sessionId: string, message: string) {
    cancelAgentRunSettlement(sessionId);
    hermesActivityStore.record(
      { kind: "error", sessionId, message, receivedAt: new Date().toISOString() },
      hermesModeFor(sessionId),
    );
  }

  const clearSessionActivity = useCallback((sessionId: string, status = "completed") => {
    hermesActivityStore.record(
      {
        kind: "lifecycle",
        sessionId,
        flavor: "terminal",
        status,
        text: "",
        receivedAt: new Date().toISOString(),
      },
      hermesModeFor(sessionId),
    );
    return agentActivityCountsFromStore();
  }, []);

  // Shared teardown for a session that is going away: its messages, pending
  // sends, activity-store row, live gateway listener, and buffered live events.
  // Both delete paths (sidebar event and session-bar menu) run this so neither
  // leaves a phantom "working" session with a leaked listener behind.
  const scrubHermesSessionState = useCallback((sessionId: string) => {
    setHermesSessionMessages((current) => {
      const next = omitRecordKey(current, sessionId);
      hermesSessionMessagesRef.current = next;
      return next;
    });
    setPendingHermesMessages((current) => {
      const next = omitRecordKey(current, sessionId);
      pendingHermesMessagesRef.current = next;
      return next;
    });
    setImageTurnsBySession((current) => omitRecordKey(current, sessionId));
    setVideoTurnsBySession((current) => omitRecordKey(current, sessionId));
    removeStoredImageSlashSession(sessionId);
    removeStoredVideoSlashSession(sessionId);
    // Feature 11: a deleted session has no activity to show, so drop its row
    // from the activity drawer's store as well.
    hermesActivityStore.clearSession(sessionId);
    // Feature 14: likewise drop its artifact timeline.
    hermesArtifactStore.clearSession(sessionId);
    sessionGatewayUnlistenRef.current.get(sessionId)?.();
    liveEventsRef.current = omitRecordKey(liveEventsRef.current, sessionId);
    setLiveEvents(liveEventsRef.current);
    // A deleted session must not be the restore target on the next mount.
    forgetLastOpenSessionId(sessionId);
  }, []);

  const {
    selectedTask,
    selectedHermesSession,
    selectedHermesSessionIsProvisional,
    activeGenerationCostQuality,
    generationModelOptions,
    generationModel,
    generationPrivacyBadge,
    composerThinkingLevel,
    preferredVisionModel,
    resolveModel,
    textFundingContext,
    textActionsDisabledReason,
    imageSlashBlockedByModel,
    showImageModelWarning,
    imageModelWarningText,
    composerInputSignature,
    visibleComposerSizeWarning,
    selectedHermesMessages,
    composerDraftKey,
    composerDraftKeyRef,
    restoredComposerDraftKeyRef,
    chatArtifacts,
  } = useAgentSelection({
    attachments,
    category,
    composerSizeWarning,
    creditActionsDisabledReason,
    defaultGenerationModelId,
    draft,
    filesystemSnapshot,
    generationCostQuality,
    generationModels,
    hermesSessionItems,
    hermesSessionMessages,
    localGeneration,
    newSessionMode,
    onSessionSelected,
    pendingHermesMessages,
    selectedHermesSessionId,
    selectedTaskId,
    sessionModelSelections,
    sessionThinkingEfforts,
    tasks,
    thinkingLevel,
    veniceApiKeyConfigured,
  });

  // The file viewer is scoped to one conversation — files from the previous
  // session must not linger open after a switch.
  useEffect(() => {
    setArtifactPanel(null);
    setDevArtifacts([]);
  }, [selectedHermesSessionId, selectedTaskId]);

  // Esc dismisses the file viewer. The card slides away from the toggle pill
  // when the panel opens, so the keyboard is the close affordance that never
  // moves; the panel's filter input claims the first Esc to clear itself.
  const artifactPanelOpen = artifactPanel !== null;
  useEffect(() => {
    if (!artifactPanelOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setArtifactPanel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [artifactPanelOpen]);

  // While June is mid-run, Escape interrupts the agent (mirrors the Stop
  // button) so the keyboard alone both adds context (Enter -> steer) and halts
  // the run. Cooperates with other Escape owners via defaultPrevented.
  useEffect(() => {
    if (!selectedHermesSessionId || !workingSessionIds.has(selectedHermesSessionId)) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        void stopHermesSession(selectedHermesSessionId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedHermesSessionId, workingSessionIds]);

  // Dev-tools sample file seeder (window.__agentFiles, registered at module
  // scope above): imports one file per preview path into the real workspace
  // and opens the viewer's list on them.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onDevFiles = (event: Event) => {
      const show = (event as CustomEvent<{ show: boolean }>).detail?.show;
      if (!show) {
        setDevArtifacts([]);
        setArtifactPanel(null);
        return;
      }
      void (async () => {
        const imported: AgentArtifact[] = [];
        for (const sample of buildSampleArtifactFiles()) {
          imported.push(await importHermesBridgeFileBytes(sample.name, sample.bytes));
        }
        setDevArtifacts(imported);
        setArtifactPanel({ view: "list" });
      })().catch((err: unknown) => setError(messageFromError(err)));
    };
    window.addEventListener(AGENT_DEV_FILES_EVENT, onDevFiles);
    return () => window.removeEventListener(AGENT_DEV_FILES_EVENT, onDevFiles);
  }, []);

  // New-session hero: greeting + centered composer + suggestion chips, shown
  // whenever nothing is selected — the same condition as the conversation
  // fall-through in the render, minus the dev gallery. Computed up here
  // because the composer auto-grow effect below needs it as a dependency.
  const heroMode =
    !gallerySections && (newSessionMode || (!selectedHermesSessionId && !selectedTask));
  // Composer steer state: the open session is mid-run (or a send is landing), so
  // the send slot holds Stop and a typed message steers the running turn rather
  // than starting a new one. Drives the steer-send button, the queue-style
  // placeholder, and whether the steer-card stack renders.
  const composerInSteerState = composerInSteerStateFor({
    selectedSessionId: selectedHermesSessionId,
    provisional: selectedHermesSessionIsProvisional,
    working: selectedHermesSessionId ? workingSessionIds.has(selectedHermesSessionId) : false,
    submitting,
    submittingSessionId: submittingHermesSessionId,
    demo: composerSteerDemo,
  });
  const selectedSteerCards = selectedHermesSessionId
    ? (steerCardsBySessionId[selectedHermesSessionId] ?? [])
    : [];
  const visibleFollowUpQueueKey = selectedHermesSessionId
    ? selectedHermesSessionId
    : heroMode
      ? NEW_SESSION_RECOVERY_QUEUE_KEY
      : undefined;
  const selectedQueuedAttachmentFollowUps = visibleFollowUpQueueKey
    ? (queuedAttachmentFollowUps[visibleFollowUpQueueKey] ?? [])
    : [];
  const selectedUpNextDemoFollowUps = selectedHermesSessionId
    ? (upNextDemoFollowUpsBySessionId[selectedHermesSessionId] ?? [])
    : [];
  const selectedFollowUpCount =
    selectedSteerCards.length +
    selectedQueuedAttachmentFollowUps.length +
    selectedUpNextDemoFollowUps.length;
  const visibleErrorState = visibleAgentWorkspaceError(errorState, selectedHermesSessionId);
  const visibleError = visibleErrorState?.message ?? null;
  // The banner offers "Try again" for failures a reconnect-and-reload can clear:
  // our own gateway/bridge connection errors, and a transient Hermes 5xx
  // (HERMES_SERVER_ERROR_MESSAGE, JUN-167). retryGatewayConnection re-runs the
  // session-management loads that produced either.
  const visibleErrorRetryable =
    visibleError != null &&
    (GATEWAY_CONNECTION_ERROR.test(visibleError) || visibleError === HERMES_SERVER_ERROR_MESSAGE);
  // Unsupported Hermes events for the selected session surface a generic,
  // recoverable notice (and sanitized dev details). Subscribing to the store's
  // version re-derives the notice whenever a new unsupported frame lands.
  const unsupportedStoreVersion = useSyncExternalStore(
    unsupportedEventStore.subscribe,
    unsupportedEventStore.getVersion,
    unsupportedEventStore.getVersion,
  );
  const unsupportedNotice = useMemo(
    () => unsupportedEventStore.activeNotice(selectedHermesSessionId),
    // `unsupportedStoreVersion` is the change signal; the lookup reads live state.
    [unsupportedStoreVersion, selectedHermesSessionId],
  );
  // Resolve a session id to its display title for an activity-drawer row,
  // falling back to the raw id when the session isn't in the loaded list
  // (unknown title must never crash or blank the row).
  const titleForPendingSession = useCallback(
    (sessionId: string) => hermesSessionItems.find((session) => session.id === sessionId)?.title,
    [hermesSessionItems],
  );

  // Feature 11: the Agent activity drawer. Subscribing to the activity store's
  // version re-derives the rows whenever any session's activity changes; the
  // drawer is one toggled, top-level surface that shows every session at once.
  //
  // TEMPORARILY HIDDEN: the drawer's "open session" routes by the row's id,
  // which is the ephemeral runtime session id, not the durable stored id, so it
  // opens the wrong session (or none). Until that runtime->stored resolution is
  // fixed, the entry-point toggle is gated off below. The whole feature (drawer,
  // subagent watch, stop, artifacts timeline) stays mounted and tested; flip
  // this flag back to true to restore it.
  const ACTIVITY_DRAWER_ENABLED = false;
  const [activityDrawerOpen, setActivityDrawerOpen] = useState(false);
  // The store only knows the count once a session has reported activity; treat a
  // never-touched store as "loading" so the very first paint shows a spinner
  // copy rather than the empty state flashing before any event lands.
  const activityStatus: "loading" | "ready" = activityStoreVersion === 0 ? "loading" : "ready";
  // Open a session from a drawer row: clear new-session mode, switch panel +
  // selection.
  const openSessionFromDrawer = useCallback((sessionId: string) => {
    newSessionModeRef.current = false;
    setNewSessionMode(false);
    setActivePanel("chat");
    selectedHermesSessionIdRef.current = sessionId;
    setSelectedHermesSessionId(sessionId);
    setSelectedTaskId(undefined);
  }, []);
  // Drawer Steer routes into the live steer flow: open the session and focus
  // the main composer, where typing while June works steers the running turn
  // via `steerActiveSession`. The drawer only offers Steer for sessions that
  // are actually steerable (see `canSteerSession` below, aligned with
  // `workingSessionIds`).
  const steerSessionFromDrawer = useCallback(
    (sessionId: string) => {
      openSessionFromDrawer(sessionId);
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focus();
      });
    },
    [openSessionFromDrawer],
  );
  // Count of sessions currently doing work — the toggle badge. Re-derived from
  // the same version signal as the rows.
  const activeAgentCount = useMemo(() => hermesActivityStore.activeCount(), [activityStoreVersion]);
  // Resolve a session's model from the loaded session list for the drawer (no
  // provider is tracked on the session record, so only `model` is supplied;
  // feature 09's usage panel remains the authority for full cost/provider).
  const modelForActivitySession = useCallback(
    (sessionId: string) => {
      const model = hermesSessionItems.find((session) => session.id === sessionId)?.model;
      return model ? { model } : undefined;
    },
    [hermesSessionItems],
  );

  // Feature 14: the per-session artifact timeline behind the drawer's
  // "Artifacts" section. Mirrors the activity-store wiring above: subscribe to
  // the singleton's version, and read the SELECTED session's artifacts (the one
  // the user is viewing) so the section tracks the conversation in front of
  // them. A click adapts the record onto the existing artifact-panel preview
  // flow (see `openTimelineArtifact`).
  const artifactStoreVersion = useSyncExternalStore(
    hermesArtifactStore.subscribe,
    hermesArtifactStore.getVersion,
    hermesArtifactStore.getVersion,
  );
  const timelineArtifacts = useMemo(
    () =>
      selectedHermesSessionId
        ? hermesArtifactStore.getRecordsForSession(selectedHermesSessionId)
        : [],
    // `artifactStoreVersion` is the change signal; the read returns live rows.
    [selectedHermesSessionId, artifactStoreVersion],
  );

  // Feature 15: the dev/debug raw-trace panel. Holds the session it was opened
  // for; `undefined` means closed. Dev-gated where it renders (HermesTracePanel
  // returns null in production), so this state is inert in shipped builds.
  const [rawTraceSession, setRawTraceSession] = useState<string | undefined>(undefined);
  const selectedIssueReportReview = selectedHermesSessionId
    ? reviewableIssueReports[selectedHermesSessionId]
    : undefined;
  const visibleIssueReportReview =
    selectedHermesSessionId && selectedIssueReportReview
      ? {
          report: selectedIssueReportReview,
          sessionId: selectedHermesSessionId,
          submitting: submittingIssueReportSessionIds.has(selectedHermesSessionId),
        }
      : undefined;
  const visibleIssueReportHasUnsentContext = Boolean(
    visibleIssueReportReview && (draft.trim() || attachments.length),
  );
  const visibleIssueReportImportingFiles = Boolean(visibleIssueReportReview && importingFiles);
  // Holds the prior render's heroMode. Read by both the composer auto-grow
  // effect (to skip its glide across a hero transition) and the hero→dock FLIP
  // below (to detect the hero handoff); the FLIP effect, which runs last, is
  // what advances it each render.
  const prevHeroModeRef = useRef(heroMode);

  // A fresh greeting each time the hero is landed on. The state initializer
  // already consumed one for the mount, so the first hero entry (which may be
  // the mount itself) keeps it; later entries advance the cycle. Pre-paint so
  // a re-entry never flashes the previous greeting.
  useLayoutEffect(() => {
    if (!heroMode) return;
    if (!heroGreetingConsumedRef.current) {
      heroGreetingConsumedRef.current = true;
      return;
    }
    setHeroGreeting(advanceHeroGreeting());
  }, [heroMode]);

  // Unrestricted is an opt-in made per new session, so the picker re-arms to
  // sandboxed every time the hero is entered — it never carries over from the
  // last one.
  useEffect(() => {
    if (!heroMode) return;
    fullModeDraftRef.current = false;
    setFullModeDraft(false);
    setSandboxMenuOpen(false);
    setConfirmUnrestricted(false);
  }, [heroMode]);

  // The sandbox picker closes on a click anywhere outside it or Esc, same as
  // the session-bar overflow menu.
  useEffect(() => {
    if (!sandboxMenuOpen) return;
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (sandboxMenuRef.current?.contains(target)) return;
      if (sandboxTriggerRef.current?.contains(target)) return;
      setSandboxMenuOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setSandboxMenuOpen(false);
      }
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [sandboxMenuOpen]);

  // The "+" popover closes on a click outside it or Esc, same as the sandbox
  // picker above.
  useEffect(() => {
    if (!attachMenuOpen) return;
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (attachMenuRef.current?.contains(target)) return;
      if (attachTriggerRef.current?.contains(target)) return;
      setAttachMenuOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setAttachMenuOpen(false);
      }
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [attachMenuOpen]);

  useComposerMenuDismiss({
    composerEditorRef,
    composerModelFlyout,
    composerModelFromSlash,
    composerModelOpen,
    composerModelPopoverRef,
    composerModelTriggerRef,
    modelRootSearch,
    setComposerModelFlyout,
    setComposerModelOpen,
    setModelRootSearch,
    setModelSearch,
  });

  useLayoutEffect(() => {
    if (!composerModelOpen) return;
    if (composerModelFlyout?.kind === "all") {
      composerModelSearchRef.current?.focus();
      return;
    }
    if (composerModelFromSlash) {
      composerModelRootSearchRef.current?.focus();
    }
  }, [composerModelFromSlash, composerModelFlyout, composerModelOpen]);

  // The popover lives outside the composer box (whose overflow:hidden would
  // clip it), so CSS alone can only anchor it to the box, leaving the whole
  // composer height between menu and trigger. Measure the trigger pill on
  // open and pin the menu right above it instead.
  useLayoutEffect(() => {
    if (!composerModelOpen) return;
    function positionPopover() {
      const trigger = composerModelTriggerRef.current;
      const popover = composerModelPopoverRef.current;
      const form = popover?.parentElement;
      if (!trigger || !popover || !form) return;
      const triggerRect = trigger.getBoundingClientRect();
      const formRect = form.getBoundingClientRect();
      popover.style.right = `${formRect.right - triggerRect.right}px`;
      popover.style.bottom = `${formRect.bottom - triggerRect.top + 4}px`;
      // The popover grows upward, so its tall states (Auto on revealing
      // Preference) can reach the titlebar strip. Cap it to the room above
      // the trigger with breathing space; the suggested list is the flex
      // child that shrinks and scrolls (the popover itself must never clip:
      // the drill-in flyouts hang outside its box).
      const titlebarHeight =
        Number.parseFloat(window.getComputedStyle(popover).getPropertyValue("--titlebar-h")) || 0;
      popover.style.maxHeight = `${Math.max(160, triggerRect.top - 4 - titlebarHeight - 12)}px`;
    }
    positionPopover();
    window.addEventListener("resize", positionPopover);
    return () => window.removeEventListener("resize", positionPopover);
  }, [composerModelOpen]);

  useLayoutEffect(() => {
    if (sandboxMenuOpen) {
      sandboxMenuWasOpenRef.current = true;
      sandboxFirstItemRef.current?.focus();
      return;
    }
    if (!sandboxMenuWasOpenRef.current) return;
    sandboxMenuWasOpenRef.current = false;
    sandboxTriggerRef.current?.focus();
  }, [sandboxMenuOpen]);

  // The conversation scroller's thumb fades in with scroll activity and back
  // out when idle (native-overlay feel; see scroll-thumb-fade.ts). The hero
  // intentionally does not mount .agent-scroll, so attach after hero handoff.
  useEffect(() => {
    if (heroMode) return;
    const el = agentScrollRef.current;
    if (!el) return;
    return attachScrollThumbFade(el);
  }, [heroMode]);

  // Same scroll-driven thumb for the steer-queue list — but attached ONLY
  // when the list actually scrolls. The helper also shows on pointer activity,
  // so on a short (non-scrollable) queue merely hovering toggled
  // scrollbar-part paints, flashing an artifact in the card's corner.
  const hasFollowUps = selectedFollowUpCount > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-evaluate when the list mounts, opens, or grows
  useEffect(() => {
    const el = steerCardsListRef.current;
    if (!el || el.scrollHeight <= el.clientHeight + 1) return;
    return attachScrollThumbFade(el);
  }, [hasFollowUps, steerQueueOpen, selectedFollowUpCount]);

  // The composer is fixed over the conversation, so it contributes no layout
  // height of its own. Reserve its live overlap in the scroller instead. A
  // ResizeObserver catches queue rows draining, collapse/expand, wrapped copy,
  // draft growth, and viewport changes without coupling the chat to any one
  // queue-row height.
  useLayoutEffect(() => {
    const scroller = agentScrollRef.current;
    const composer = composerRef.current;
    if (heroMode || activePanel !== "chat" || !scroller || !composer) {
      setComposerClearance(0);
      return;
    }
    const measure = () => {
      const next = agentComposerClearance(
        scroller.getBoundingClientRect().bottom,
        composer.getBoundingClientRect().top,
      );
      setComposerClearance((current) => (current === next ? current : next));
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined;
    observer?.observe(scroller);
    observer?.observe(composer);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [activePanel, heroMode, selectedFollowUpCount, steerQueueOpen]);

  // Updates the task list without touching the selection — a late poll
  // response must not re-select a task the user already navigated away from.
  // Selection changes only where user intent exists (load, explicit click).
  const upsertTask = useCallback((task: AgentTaskDto) => {
    setTasks((prev) => {
      const rest = prev.filter((item) => item.id !== task.id);
      return [task, ...rest].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const response = await listAgentTasks();
      setTasks(response.items);
      setSelectedTaskId((current) =>
        newSessionModeRef.current ? undefined : (current ?? response.items[0]?.id),
      );
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHermesSessions = useCallback(
    async (
      options: { suppressStartupRequestError?: boolean; suppressSessionGoneError?: boolean } = {},
    ) => {
      if (!bridge.running || !activeHermesProfile.confirmed) return "skipped";
      let keepLoading = false;
      setHermesSessionsLoading(true);
      try {
        const [listedSessions, assignments] = await Promise.all([
          listHermesSessions(),
          listSessionProfiles(),
        ]);
        const profiles = sessionProfileMap(assignments);
        const activeProfile = activeHermesProfile.name;
        const sessions = applySessionTitleOverrides(
          filterAgentSessionsForProfile(listedSessions, profiles, activeProfile),
        );
        profileOwnedSessionIdsRef.current = new Set(
          activeProfile === "default"
            ? []
            : assignments
                .filter((assignment) => assignment.profile === activeProfile)
                .map((assignment) => assignment.sessionId),
        );
        hermesSessionsHydratedRef.current = true;
        setHermesSessionsHydrated(true);
        const pendingMessages = pendingHermesMessagesRef.current;
        const selectedSessionId = selectedHermesSessionIdRef.current;
        const selectedProfileSessionId =
          selectedSessionId &&
          sessionMatchesProfile({ id: selectedSessionId }, profiles, activeProfile)
            ? selectedSessionId
            : undefined;
        const workingSessions = workingSessionIdsRef.current;
        const waitingSessions = waitingSessionIdsRef.current;
        const currentProfileSessionIds = new Set(
          hermesSessionItemsRef.current
            .filter((session) => sessionMatchesProfile(session, profiles, activeProfile))
            .map((session) => session.id),
        );
        setHermesSessionItems((current) =>
          mergeActiveHermesSessions(
            sessions,
            current.filter((session) => sessionMatchesProfile(session, profiles, activeProfile)),
            {
              selectedSessionId: selectedProfileSessionId,
              workingSessionIds: workingSessions,
              waitingSessionIds: waitingSessions,
              pendingMessages,
              defaultModelId: defaultGenerationModelIdRef.current,
            },
          ),
        );
        const restoredSessionId = restoredHermesSessionIdRef.current;
        restoredHermesSessionIdRef.current = undefined;
        setSelectedHermesSessionId((current) => {
          if (newSessionModeRef.current) {
            selectedHermesSessionIdRef.current = undefined;
            return undefined;
          }
          let candidate = current ?? restoredSessionId;
          const candidateIsCurrent = candidate !== undefined && candidate === current;
          if (candidate && !sessionMatchesProfile({ id: candidate }, profiles, activeProfile)) {
            forgetLastOpenSessionId(candidate);
            candidate = undefined;
          }
          if (
            candidate &&
            (sessions.some((session) => session.id === candidate) ||
              candidateIsCurrent ||
              currentProfileSessionIds.has(candidate))
          ) {
            selectedHermesSessionIdRef.current = candidate;
            return candidate;
          }
          if (restoredSessionId && candidate === restoredSessionId) {
            forgetLastOpenSessionId(restoredSessionId);
          }
          const taskSession = selectedTask?.hermesSessionId;
          if (taskSession && sessions.some((session) => session.id === taskSession)) {
            selectedHermesSessionIdRef.current = taskSession;
            return taskSession;
          }
          const nextSessionId = sessions[0]?.id;
          selectedHermesSessionIdRef.current = nextSessionId;
          return nextSessionId;
        });
        // Deliberately no setError(null) here: this runs from background polls,
        // so a success would wipe an unrelated banner (e.g. a failed send)
        // moments after it appeared. The banner is dismissable instead.
        return "loaded";
      } catch (err) {
        const message = messageFromError(err);
        if (
          options.suppressStartupRequestError &&
          !hermesSessionsHydratedRef.current &&
          isHermesSessionsStartupRequestError(err)
        ) {
          keepLoading = true;
          return "transient-startup-error";
        }
        if (options.suppressSessionGoneError && isSessionGoneError(message)) {
          return "failed";
        }
        setError(describeHermesError(err), reportableAgentErrorOptions(err));
        return "failed";
      } finally {
        if (!keepLoading) {
          setHermesSessionsLoading(false);
        }
      }
    },
    [
      activeHermesProfile.confirmed,
      activeHermesProfile.name,
      bridge.running,
      selectedTask?.hermesSessionId,
    ],
  );

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  // Reflects a provider/model settings change into the composer state: the
  // active provider, the saved local endpoint, and the pill selection (the
  // synthetic local option when local is active). Shared by the mount fetch
  // and the model-switch handler so both stay in lockstep with the backend.
  const commitGenerationSettings = useCallback(
    (settings: ProviderModelSettingsDto, fallbackModelId = "") => {
      const local = settings.localGeneration ?? {
        baseUrl: "",
        modelId: "",
        apiKey: "",
      };
      const selectedModelId = generationSelectionId(settings, fallbackModelId);
      localGenerationRef.current = local;
      setLocalGeneration(local);
      defaultGenerationModelIdRef.current = selectedModelId;
      setDefaultGenerationModelId(selectedModelId);
      confirmedCostQualityRef.current = settings.costQuality;
      generationCostQualityRef.current = settings.costQuality;
      setGenerationCostQuality(settings.costQuality);
      veniceApiKeyConfiguredRef.current = settings.veniceApiKeyConfigured;
      setVeniceApiKeyConfigured(settings.veniceApiKeyConfigured);
      return selectedModelId;
    },
    [],
  );

  // Out-of-order responses (a slow mount fetch landing after a settings
  // change refresh) must not clobber the newer result.
  const generationModelRequestSequence = useRef(0);
  const loadGenerationModel = useCallback(async () => {
    const requestId = ++generationModelRequestSequence.current;
    try {
      const settingsPromise = providerModelSettings();
      const modelsPromise = listVeniceModels("generation");
      // Surfaced before the catalog await: the settings read is local IPC, so
      // key-presence state (the Auto billing note) refreshes even when the
      // remote catalog fetch fails.
      modelsPromise.catch(() => {});
      const settingsResponse = await settingsPromise;
      if (requestId === generationModelRequestSequence.current) {
        veniceApiKeyConfiguredRef.current = settingsResponse.settings.veniceApiKeyConfigured;
        setVeniceApiKeyConfigured(settingsResponse.settings.veniceApiKeyConfigured);
      }
      const modelsResponse = await modelsPromise;
      const selectedModelId = generationSelectionId(
        settingsResponse.settings,
        modelsResponse.selectedModel,
      );
      if (requestId === generationModelRequestSequence.current) {
        generationModelsRef.current = modelsResponse.models;
        setGenerationModels(modelsResponse.models);
        commitGenerationSettings(settingsResponse.settings, modelsResponse.selectedModel);
      }
      return { models: modelsResponse.models, selectedModelId };
    } catch {
      if (requestId === generationModelRequestSequence.current) {
        defaultGenerationModelIdRef.current = "";
        generationModelsRef.current = [];
        setDefaultGenerationModelId("");
      }
      return null;
    }
  }, [commitGenerationSettings]);

  useEffect(() => {
    defaultGenerationModelIdRef.current = defaultGenerationModelId;
    const defaultModelId = defaultGenerationModelId.trim();
    if (!defaultModelId) return;
    setHermesSessionItems((current) => {
      let changed = false;
      const next = current.map((session) => {
        if (session.model?.trim()) return session;
        changed = true;
        return { ...session, model: defaultModelId };
      });
      return changed ? next : current;
    });
  }, [defaultGenerationModelId]);

  useEffect(() => {
    function handleProviderModelSettingsChanged(event: Event) {
      const { mode } = (event as CustomEvent<ProviderModelSettingsChangedDetail>).detail;
      if (mode === "generation") {
        void loadGenerationModel();
      }
    }

    void loadGenerationModel();
    window.addEventListener(
      PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
      handleProviderModelSettingsChanged,
    );
    return () => {
      window.removeEventListener(
        PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
        handleProviderModelSettingsChanged,
      );
    };
  }, [loadGenerationModel]);

  const {
    commitSessionModelSelections,
    storedSessionIdForComposerModelSelection,
    queueComposerSessionModelSelection,
    captureSessionModelTarget,
    openComposerModelPicker,
    markRemoteGenerationSelected,
    saveGenerationSelection,
    selectLocalGeneration,
    handleCostQualityChange,
    handleSelectGenerationModel,
  } = createModelSelectionActions({
    MODEL_SWITCH_TOAST_ID,
    activeGenerationCostQuality,
    confirmedCostQualityRef,
    costQualitySaveChainRef,
    defaultGenerationModelIdRef,
    generationCostQuality,
    generationCostQualityRef,
    generationModelRequestSequence,
    generationModelsRef,
    generationSelectionIntentRevisionRef,
    generationSelectionSaveChainRef,
    hermesSessionItemsRef,
    latestCostQualitySaveRef,
    loadGenerationModel,
    localEnableConfirmArmedForRef,
    localGenerationRef,
    newSessionModeRef,
    profileOwnedSessionIdsRef,
    selectedHermesSessionIdRef,
    sessionModelSelectionsRef,
    setComposerModelFlyout,
    setComposerModelFromSlash,
    setComposerModelOpen,
    setDefaultGenerationModelId,
    setError,
    setGenerationCostQuality,
    setModelRootSearch,
    setModelSearch,
    setSandboxMenuOpen,
    setSessionModelSelections,
  });

  useEffect(() => {
    if (!bridge.running) return;
    let cancelled = false;
    let retryTimeout: number | undefined;

    function load(attempt: number) {
      void loadHermesSessions({ suppressStartupRequestError: true }).then((result) => {
        if (cancelled || result !== "transient-startup-error") return;
        const retryDelay =
          AGENT_WORKSPACE_SESSION_RETRY_DELAYS_MS[attempt] ??
          AGENT_WORKSPACE_MAX_SESSION_RETRY_DELAY_MS;
        retryTimeout = window.setTimeout(() => load(attempt + 1), retryDelay);
      });
    }

    load(0);
    return () => {
      cancelled = true;
      if (retryTimeout != null) {
        window.clearTimeout(retryTimeout);
      }
      setHermesSessionsLoading(false);
    };
  }, [bridge.running, loadHermesSessions]);

  useEffect(() => {
    if (!initialSessionId) return;
    newSessionModeRef.current = false;
    setNewSessionMode(false);
    setActivePanel("chat");
    selectedHermesSessionIdRef.current = initialSessionId;
    setSelectedHermesSessionId(initialSessionId);
    setSelectedTaskId(undefined);
  }, [initialSessionId]);

  useEffect(() => {
    if (!initialSession || initialSession.id !== initialSessionId) return;
    setHermesSessionItems((current) =>
      current.some((session) => session.id === initialSession.id)
        ? current
        : [initialSession, ...current],
    );
  }, [initialSession, initialSessionId]);

  // Remember the open conversation for the restore-on-mount above. Entering
  // new-session mode leaves the last real session in place — if the new
  // session never materializes (crash, reload), restoring the previous one
  // beats landing on the hero screen.
  useEffect(() => {
    if (selectedHermesSessionId) {
      if (isProvisionalHermesSessionId(selectedHermesSessionId)) return;
      writeLastOpenSessionId(selectedHermesSessionId);
    }
  }, [selectedHermesSessionId]);

  useEffect(() => {
    // The sidebar and App replace their session lists wholesale with this
    // payload, so an unhydrated broadcast (mount seed only) would collapse
    // the list they already fetched themselves and flicker it back once the
    // real fetch lands.
    if (!hermesSessionsHydrated) return;
    dispatchAgentSessionsChanged({
      sessions: hermesSessionItems.filter((session) => !isProvisionalHermesSessionId(session.id)),
      selectedSessionId: isProvisionalHermesSessionId(selectedHermesSessionId)
        ? undefined
        : selectedHermesSessionId,
      workingSessionIds: Array.from(workingSessionIds).filter(
        (sessionId) => !isProvisionalHermesSessionId(sessionId),
      ),
      waitingSessionIds: Array.from(waitingSessionIds).filter(
        (sessionId) => !isProvisionalHermesSessionId(sessionId),
      ),
    });
  }, [
    hermesSessionsHydrated,
    hermesSessionItems,
    selectedHermesSessionId,
    waitingSessionIds,
    workingSessionIds,
  ]);

  // Message-based reconciliation above can only END a run when an assistant
  // reply eventually persists. A run that died without one (provider failure,
  // gateway drop, app quit mid-turn) — or a session wrongly resumed as
  // working from a trailing user message — would otherwise stay "working"
  // forever, leaving the menu bar stuck on "Working…". The gateway's
  // session.active_list is ground truth for what is actually running, so any
  // locally-working session absent from it (or sitting idle) for two
  // consecutive polls gets its activity cleared. Two misses, not one: a
  // just-submitted prompt can race the runtime session registering.
  const {
    liveRuntimeSessionsForModes,
    runtimeSnapshotHasSession,
    cancelAgentRunSettlement,
    hasAutomaticContinuation,
    watchCompletedAgentRunSettle,
    reconcileWorkingSessionsAgainstRuntime,
  } = createRuntimeReconciliation({
    ensureHermesGateway,
    hermesSessionItems,
    pendingAttachmentPreparationsRef,
    pendingSteerBySessionIdRef,
    queuedAttachmentFollowUpsRef,
    recordSessionErrorActivity,
    refreshHermesSession,
    runtimeSessionIdsRef,
    setError,
    workingReconcileMissesRef,
    workingSessionIdsRef,
  });

  const {
    classifyOptimisticLiveEvent,
    withStoredHermesSessionId,
    pushLiveEvent,
    writeQueuedAttachmentFollowUps,
    updateQueuedAttachmentFollowUps,
    discardSessionAttachmentFollowUps,
    enqueueAttachmentFollowUp,
    enqueueFailedComposerFollowUp,
    removeQueuedAttachmentFollowUp,
    editQueuedAttachmentFollowUp,
    deliverQueuedAttachmentFollowUp,
    continueAfterCompletedAgentRun,
  } = createFollowUpQueueActions({
    attachmentsRef,
    cancelAgentRunSettlement,
    cancelComposerDispatch,
    categoryRef,
    clearSubmittedSteers,
    completedAgentRunAwaitingAttachmentPreparationRef,
    composerDraftKeyRef,
    composerEditorRef,
    continuingCompletedAgentRunSourcesRef,
    draftRef,
    hermesSessionItemsRef,
    liveEventsRef,
    newSessionModeRef,
    pendingAttachmentPreparationsRef,
    pendingCompletedAgentRunSourcesRef,
    pendingSteerBySessionIdRef,
    queuedAttachmentFollowUpSeqRef,
    queuedAttachmentFollowUpsRef,
    selectedHermesSessionIdRef,
    setAttachments,
    setCategory,
    setDraft,
    setError,
    setLiveEvents,
    setQueuedAttachmentFollowUps,
    submitHermesSession,
    watchCompletedAgentRunSettle,
    workingSessionIdsRef,
  });

  // Manual rename. Records an override (same channel the auto-suggested titles
  // use) and marks the session so the suggester won't clobber the user's name.
  // The sessions-changed effect propagates it to the sidebar.
  const {
    applyManualHermesSessionTitleLocally,
    renameHermesSession,
    removeHermesSessionLocally,
    deleteSelectedHermesSession,
    applySessionTitleOverrides,
    suggestTitleForUntitledSession,
  } = createSessionTitleActions({
    cancelAgentRunSettlement,
    clearSubmittedSteers,
    commitSessionModelSelections,
    discardSessionAttachmentFollowUps,
    hermesSessionItems,
    hermesSessionItemsRef,
    hermesSessionMessagesRef,
    invalidateSessionComposerDispatches,
    pendingIssueReportsRef,
    scrubHermesSessionState,
    selectedHermesSessionIdRef,
    sessionTitleOverridesRef,
    sessionTitleSourceRef,
    setError,
    setHermesSessionItems,
    setReviewableIssueReport,
    setSelectedHermesSessionId,
    titleSuggestionInFlightSessionIdsRef,
    titleSuggestionSessionIdsRef,
  });

  const {
    clearComposerDraft,
    restoreComposerDraft,
    setComposerAttachments,
    openReportDialog,
    reportDialogAppendForCurrentGeneration,
    pickReportDialogAttachments,
    importReportDialogDroppedFiles,
    removeReportDialogAttachment,
    handleReportDialogSent,
    seedComposerNoteRef,
  } = createComposerDraftActions({
    addReportDialogAttachments,
    attachmentsRef,
    categoryRef,
    composerDraftKeyRef,
    composerEditorRef,
    composerTiptapEditorRef,
    draftRef,
    importDroppedFiles,
    pendingSeedNoteRefRef,
    reportDialogGenerationRef,
    restoredComposerDraftKeyRef,
    setAttachMenuOpen,
    setAttachments,
    setCategory,
    setDraft,
    setError,
    setImportingFiles,
    setReportDialogAttachments,
    setReportDialogCategory,
    setReportDialogDescription,
    setReportDialogOpen,
  });

  // Shortcuts never submit on click — they stage the prompt in the composer
  // so the person reads what will run and sends it themselves. The click is
  // free; only the explicit send spends tokens.
  const { startNewTask } = createTaskSubmissionAction({
    clearComposerDraft,
    composerDraftKeyRef,
    composerEditorRef,
    lastAutoSubmittedRef,
    newSessionModeRef,
    openReportDialog,
    pendingSeedNoteRefRef,
    restoreComposerDraft,
    seedComposerNoteRef,
    selectedHermesSessionIdRef,
    setActivePanel,
    setError,
    setNewSessionMode,
    setSelectedHermesSessionId,
    setSelectedTaskId,
    setSubmitting,
    setSubmittingHermesSessionId,
    submitHermesSession,
  });

  // Latest-instance handlers for the mount-scoped window listeners below. The
  // empty-deps effect would otherwise freeze first-render closures — where
  // bridge is still { running: false }, so a post-submit loadHermesSessions
  // silently no-ops and the sidebar never refreshes after event-driven runs.
  const windowEventHandlersRef = useRef({
    applyManualHermesSessionTitleLocally,
    startNewTask,
    removeHermesSessionLocally,
  });
  useEffect(() => {
    windowEventHandlersRef.current = {
      applyManualHermesSessionTitleLocally,
      startNewTask,
      removeHermesSessionLocally,
    };
    gatewayCloseHandlerRef.current = (fullMode: boolean) => {
      // Feature 04: mark the transport drop, then let recovery retire approvals
      // fail closed while preserving the existing stale/reannounce contract for
      // clarify, sudo, and secret actions.
      pendingActionStore.markDisconnected();
      void recoverFromGatewayClose(fullMode);
    };
  });

  useAgentProfileEvents({
    windowEventHandlersRef,
  });

  useAgentWindowEvents({
    bridge,
    clearSessionActivity,
    continueAfterCompletedAgentRun,
    hermesSessionItems,
    hermesSessionMessagesRef,
    hermesSessionsHydrated,
    listSessionMessagesOrdered,
    liveEventsRef,
    pendingHermesMessagesRef,
    promotePendingIssueReportToReview,
    recordSessionRunningActivity,
    selectedHermesSessionId,
    setError,
    setHermesSessionMessages,
    setLiveEvents,
    setPendingHermesMessages,
    suggestTitleForUntitledSession,
    waitingSessionIdsRef,
    workingSessionIdsRef,
  });

  useEffect(() => {
    if (!bridge.running || !hermesSessionsHydrated || !selectedHermesSessionId) return;
    if (isProvisionalHermesSessionId(selectedHermesSessionId)) return;
    void loadFilesystemSnapshot();
  }, [
    bridge.running,
    hermesSessionsHydrated,
    selectedHermesSessionId,
    selectedHermesMessages.length,
  ]);

  useEffect(() => {
    if (!selectedTaskId) return;
    const task = tasks.find((item) => item.id === selectedTaskId);
    if (!task || task.messages.length || task.toolEvents.length) return;
    if (hydratedTaskIdsRef.current.has(selectedTaskId)) return;
    hydratedTaskIdsRef.current.add(selectedTaskId);
    let cancelled = false;
    getAgentTask(selectedTaskId)
      .then((fullTask) => {
        if (!cancelled) {
          taskHistoryLoadedIdsRef.current.add(fullTask.id);
          setTasks((current) => current.map((item) => (item.id === fullTask.id ? fullTask : item)));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeHermesError(err), reportableAgentErrorOptions(err));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTaskId, tasks]);

  useAgentSessionEvents({
    activeComposerDispatchReservationsRef,
    diagnosisRefreshIssueReportSessionIdsRef,
    gatewaysRef,
    hasAutomaticContinuation,
    hermesSessionItemsRef,
    imageSafeModeConsentRequestRef,
    liveEventsRef,
    pendingHermesMessagesRef,
    pendingIssueReportsRef,
    pendingSteerBySessionIdRef,
    queuedAttachmentFollowUpsRef,
    reviewableIssueReportsRef,
    runtimeSessionIdsRef,
    sessionTitleOverridesRef,
    sessionTitleSourceRef,
    setBridge,
    setError,
    submittingIssueReportSessionIdsRef,
    workingSessionIdsRef,
  });

  useEffect(() => {
    if (!selectedTask || !POLLED_STATUSES.has(selectedTask.status)) return;
    const taskId = selectedTask.id;
    const interval = window.setInterval(() => {
      getAgentTask(taskId)
        .then(upsertTask)
        .catch((err: unknown) => setError(messageFromError(err)));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [selectedTask?.id, selectedTask?.status, upsertTask]);

  // Poll every working session — not just the selected one — so a run whose
  // live gateway stream died (disconnect, navigation) still reconciles from
  // persisted messages instead of staying "working" forever.
  useEffect(() => {
    if (!bridge.running || workingSessionIds.size === 0) return;
    const sessionIds = Array.from(workingSessionIds);
    const interval = window.setInterval(() => {
      for (const sessionId of sessionIds) {
        void refreshHermesSession(sessionId);
      }
      void reconcileWorkingSessionsAgainstRuntime();
    }, 2500);
    return () => window.clearInterval(interval);
  }, [bridge.running, workingSessionIds]);

  useEffect(() => {
    categoryRef.current = category;
  }, [category]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    if (composerSizeWarning && composerSizeWarning.inputSignature !== composerInputSignature) {
      setComposerSizeWarning(null);
    }
    if (
      composerSizeProceedSignatureRef.current &&
      composerSizeProceedInputSignatureRef.current !== composerInputSignature
    ) {
      composerSizeProceedSignatureRef.current = null;
      composerSizeProceedInputSignatureRef.current = null;
    }
  }, [composerInputSignature, composerSizeWarning]);

  const { loadSkillCommands, loadCapabilities, loadMessagingPlatforms, loadFilesystemSnapshot } =
    createManagementLoaders({
      ensureHermesGateway,
      selectedHermesSessionIdRef,
      setCapabilityLoading,
      setError,
      setFilesystemLoading,
      setFilesystemSnapshot,
      setMessagingPlatforms,
      setSelectedMessagingPlatformId,
      setSkillCommandLoading,
      setSkills,
      setToolsets,
      skillCommandsLoadRef,
      skills,
    });

  const {
    finishImageSlashGeneration,
    retryImageSlashTurn,
    requestImageSafeModeConsent,
    resolveImageSafeModeConsent,
    handleAgentImageSafeModeConsentEvent,
    runImageSlashCommand,
  } = createImageSlashActions({
    captureSessionModelTarget,
    clearComposerCommandDraft,
    composerDispatchWasInvalidated,
    creditActionsDisabledReason,
    imageSafeModeConsentRequestRef,
    imageSlashBaseTurnId,
    loadFilesystemSnapshot,
    newSessionModeRef,
    pendingFastPathImagesRef,
    setError,
    setGeneratingImage,
    setHeroLeaving,
    setImageSafeModeConsentRequest,
    setImageTurnsBySession,
    setImportingFiles,
    submitHermesSession,
    updateImageSlashPart,
  });

  useAgentDropEvents({
    handleAgentImageSafeModeConsentEvent,
    importDroppedFilePaths,
  });

  useEffect(() => {
    if (activePanel === "skills" && (!skills || !toolsets)) {
      void loadCapabilities();
    }
    if (activePanel === "messaging" && !messagingPlatforms) {
      void loadMessagingPlatforms();
    }
  }, [activePanel]);

  // Starting a new session should land on the composer the way a new note
  // lands on the empty page — just start typing, no detour to the sidebar.
  useEffect(() => {
    if (newSessionMode && activePanel === "chat") {
      composerEditorRef.current?.focus();
    }
  }, [newSessionMode, activePanel]);

  useEffect(() => {
    if (activePanel !== "chat") return;
    if (restoredComposerDraftKeyRef.current === composerDraftKey) return;
    restoreComposerDraft(composerDraftKey);
  }, [activePanel, composerDraftKey]);

  // The busy toast's advice ("wait for the reply") goes stale the moment the
  // selected session stops working — including when the user switches to an
  // idle session — so dismiss it then rather than leaving it up for the full
  // toast duration. Dismissing an absent toast is a no-op.
  useEffect(() => {
    if (selectedHermesSessionId && workingSessionIds.has(selectedHermesSessionId)) return;
    toast.dismiss(SESSION_BUSY_TOAST_ID);
  }, [selectedHermesSessionId, workingSessionIds]);

  function updateImageSlashPart(
    sessionId: string,
    assistantTurnId: string,
    patch: Partial<Extract<AgentChatPart, { type: "image" }>>,
  ) {
    setImageTurnsBySession((current) => {
      const turns = current[sessionId] ?? [];
      return {
        ...current,
        [sessionId]: turns.map((turn) => {
          if (turn.id !== assistantTurnId) return turn;
          const parts = turn.parts.map((part) =>
            part.type === "image" ? { ...part, ...patch } : part,
          );
          const running = parts.some((part) => part.type === "image" && part.status === "running");
          return { ...turn, parts, status: running ? "running" : "complete" };
        }),
      };
    });
  }

  function imageSlashBaseTurnId(assistantTurnId: string) {
    return assistantTurnId.endsWith(":assistant")
      ? assistantTurnId.slice(0, -":assistant".length)
      : assistantTurnId;
  }

  // Picking a thinking level always updates the stored draft (the next new
  // session opens with it). With a session open it ALSO retunes that session:
  // the level is recorded per chat (persisted, so a relaunch still shows the
  // session's own level), applied to the live runtime through config.set
  // (setSessionReasoningEffort), and re-asserted on the next turn if the
  // runtime is not up right now — see submitHermesSession, which only
  // re-sends when the current runtime is not already known to be at it.
  async function handleSelectThinkingLevel(level: ThinkingLevel) {
    thinkingLevelRef.current = level;
    setThinkingLevel(level);
    saveThinkingLevel(level);
    const sessionId = newSessionModeRef.current ? undefined : selectedHermesSessionIdRef.current;
    if (!sessionId || isProvisionalHermesSessionId(sessionId)) return;
    sessionThinkingEffortsRef.current = {
      ...sessionThinkingEfforts(),
      [sessionId]: level,
    };
    rememberSessionThinkingLevel(sessionId, level);
    await applyThinkingLevelToSession(sessionId, level);
  }

  // Best-effort live retune of one session's reasoning effort. Skips the RPC
  // entirely when the session's CURRENT runtime is already known to be at
  // this effort — known via an acked config.set, the creation pin, or the
  // runtime's own session.info report. Keying the skip on the runtime id (not
  // just the session) keeps a replacement runtime honest: a resumed session
  // gets re-asserted on its new runtime instead of trusting the old one's ack.
  async function applyThinkingLevelToSession(
    sessionId: string,
    level: ThinkingLevel,
    explicitRuntimeSessionId?: string,
  ) {
    const effort = thinkingEffortForLevel(level);
    const runtimeSessionId = explicitRuntimeSessionId ?? runtimeSessionIdsRef.current[sessionId];
    if (!runtimeSessionId) return;
    const applied = sessionThinkingAppliedRef.current[sessionId];
    if (applied?.runtimeId === runtimeSessionId && applied.effort === effort) {
      return;
    }
    try {
      const gateway = await ensureHermesGateway(sessionUnrestricted(sessionId));
      await createHermesMethods(gateway).setSessionReasoningEffort({
        sessionId: runtimeSessionId,
        effort,
      });
      sessionThinkingAppliedRef.current = {
        ...sessionThinkingAppliedRef.current,
        [sessionId]: { runtimeId: runtimeSessionId, effort },
      };
      setError(null);
    } catch {
      // The level is still recorded, so the next turn re-asserts it once
      // the runtime is reachable; no banner for something the send flow
      // quietly heals.
    }
  }

  function updateVideoSlashPart(
    sessionId: string,
    assistantTurnId: string,
    patch: Partial<Extract<AgentChatPart, { type: "video" }>>,
  ) {
    setVideoTurnsBySession((current) => {
      const turns = current[sessionId] ?? [];
      return {
        ...current,
        [sessionId]: turns.map((turn) => {
          if (turn.id !== assistantTurnId) return turn;
          const parts = turn.parts.map((part) =>
            part.type === "video" ? { ...part, ...patch } : part,
          );
          const running = parts.some((part) => part.type === "video" && part.status === "running");
          return { ...turn, parts, status: running ? "running" : "complete" };
        }),
      };
    });
  }

  function videoSlashBaseTurnId(assistantTurnId: string) {
    return assistantTurnId.endsWith(":assistant")
      ? assistantTurnId.slice(0, -":assistant".length)
      : assistantTurnId;
  }

  const {
    finishVideoSlashGeneration,
    pollExistingVideoSlashJob,
    resumePendingVideoSlashTurn,
    retryVideoSlashTurn,
    runVideoSlashCommand,
  } = createVideoSlashActions({
    captureSessionModelTarget,
    clearComposerCommandDraft,
    composerDispatchWasInvalidated,
    creditActionsDisabledReason,
    loadFilesystemSnapshot,
    newSessionModeRef,
    requestImageSafeModeConsent,
    setError,
    setGeneratingVideo,
    setHeroLeaving,
    setImportingFiles,
    setVideoTurnsBySession,
    submitHermesSession,
    updateVideoSlashPart,
    videoSlashBaseTurnId,
  });

  const { prepareComposerSubmission, handleBuiltinComposerSlashCommand } =
    createComposerPreparation({
      categoryRef,
      loadSkillCommands,
      runFileSlashCommand,
      runImageSlashCommand,
      runModelSlashCommand,
      runVideoSlashCommand,
      setError,
    });

  if (testOnlySlashCommandEntriesRef) {
    testOnlySlashCommandEntriesRef.current = {
      runImageSlashCommand,
      runVideoSlashCommand,
    };
  }

  async function runModelSlashCommand(
    argument: string,
    commandText: string,
    modelTarget?: CapturedSessionModelTarget,
  ) {
    const query = argument.trim();
    if (!query) {
      clearComposerCommandDraft(commandText);
      openComposerModelPicker(true);
      return;
    }

    const models = await generationModelsForSlashCommand();
    if (!models.length) {
      setError("Could not load models. Try again in a moment.");
      return;
    }

    const resolution = resolveSlashModel(query, models);
    if (resolution.status !== "resolved") {
      setError(slashModelResolutionError(resolution));
      return;
    }

    const selected = await handleSelectGenerationModel(
      resolution.model.id,
      undefined,
      modelTarget ? { targetStoredSessionId: modelTarget.targetStoredSessionId } : undefined,
    );
    if (selected) clearComposerCommandDraft(commandText);
  }

  async function generationModelsForSlashCommand() {
    if (generationModelsRef.current.length) return generationModelsRef.current;
    const loaded = await loadGenerationModel();
    return loaded?.models ?? generationModelsRef.current;
  }

  async function runFileSlashCommand(argument: string, commandText: string) {
    if (!argument.trim()) {
      clearComposerCommandDraft(commandText);
      await pickAttachments();
      return;
    }

    const parsed = parseSlashFileArguments(argument);
    if (parsed.status === "error") {
      setError(parsed.message);
      return;
    }
    if (!parsed.paths.length) {
      clearComposerCommandDraft(commandText);
      await pickAttachments();
      return;
    }

    const imported = await importDroppedFilePaths(parsed.paths);
    if (imported) clearComposerCommandDraft(commandText);
  }

  function clearComposerCommandDraft(commandText: string) {
    if (draftRef.current.trim() !== commandText.trim()) return;
    if (categoryRef.current) return;
    composerEditorRef.current?.clear();
    draftRef.current = "";
    categoryRef.current = null;
    setDraft("");
    setCategory(null);
    rememberComposerDraft(composerDraftKeyRef.current, "", null, attachmentsRef.current);
  }

  function reserveComposerDispatch(storedSessionId: string) {
    const reservation = reserveHermesSessionDispatch(storedSessionId);
    activeComposerDispatchReservationsRef.current.set(reservation, storedSessionId);
    return reservation;
  }

  function forgetComposerDispatch(reservation: HermesSessionDispatchReservation | undefined) {
    if (reservation) activeComposerDispatchReservationsRef.current.delete(reservation);
  }

  function cancelComposerDispatch(reservation: HermesSessionDispatchReservation | undefined) {
    reservation?.cancel();
    forgetComposerDispatch(reservation);
  }

  function composerDispatchWasInvalidated(
    reservation: HermesSessionDispatchReservation | undefined,
  ) {
    return Boolean(
      reservation && invalidatedComposerDispatchReservationsRef.current.has(reservation),
    );
  }

  function invalidateSessionComposerDispatches(storedSessionId: string) {
    for (const [
      reservation,
      ownerStoredSessionId,
    ] of activeComposerDispatchReservationsRef.current) {
      if (ownerStoredSessionId !== storedSessionId) continue;
      invalidatedComposerDispatchReservationsRef.current.add(reservation);
      reservation.cancel();
      activeComposerDispatchReservationsRef.current.delete(reservation);
      const consentRequest = imageSafeModeConsentRequestRef.current;
      if (consentRequest?.ownerDispatchReservation === reservation) {
        resolveImageSafeModeConsent({ action: "dismiss" });
      }
    }
  }

  function beginAttachmentPreparation(
    storedSessionId: string,
    dispatchOrder: number,
    dispatchReservation?: HermesSessionDispatchReservation,
  ) {
    const preparation: PendingAttachmentPreparation = {
      dispatchOrder,
      dispatchReservation,
      cancelled: false,
    };
    const pendingPreparations =
      pendingAttachmentPreparationsRef.current[storedSessionId] ??
      new Map<number, PendingAttachmentPreparation>();
    pendingPreparations.set(dispatchOrder, preparation);
    pendingAttachmentPreparationsRef.current[storedSessionId] = pendingPreparations;
    return preparation;
  }

  function finishAttachmentPreparation(
    storedSessionId: string,
    preparation: PendingAttachmentPreparation,
  ) {
    const pendingPreparations = pendingAttachmentPreparationsRef.current[storedSessionId];
    if (pendingPreparations?.get(preparation.dispatchOrder) === preparation) {
      pendingPreparations.delete(preparation.dispatchOrder);
    }
    if (pendingPreparations?.size === 0) {
      delete pendingAttachmentPreparationsRef.current[storedSessionId];
    }
    if (preparation.cancelled) return;
    if (completedAgentRunAwaitingAttachmentPreparationRef.current.delete(storedSessionId)) {
      continueAfterCompletedAgentRun(storedSessionId, Symbol("prepared follow-up"));
    }
  }

  let submitImplementation: (event?: FormEvent) => Promise<void>;
  async function submit(event?: FormEvent) {
    return submitImplementation(event);
  }

  function proceedWithOversizeComposerInput() {
    if (!visibleComposerSizeWarning) return;
    composerSizeProceedSignatureRef.current = visibleComposerSizeWarning.signature;
    composerSizeProceedInputSignatureRef.current = visibleComposerSizeWarning.inputSignature;
    setComposerSizeWarning(null);
    void submit();
  }

  function editOversizeComposerInput() {
    setComposerSizeWarning(null);
    composerSizeProceedSignatureRef.current = null;
    composerSizeProceedInputSignatureRef.current = null;
    composerEditorRef.current?.focus();
  }

  function switchOversizeComposerModel() {
    const switchModel = visibleComposerSizeWarning?.switchModel;
    if (!switchModel) return;
    setComposerSizeWarning(null);
    composerSizeProceedSignatureRef.current = null;
    composerSizeProceedInputSignatureRef.current = null;
    void handleSelectGenerationModel(switchModel.id);
  }

  const {
    handleComposerDragOver,
    handleComposerDrop,
    handleComposerPaste,
    agentAttachmentFromImportedFile,
  } = createComposerFileEvents({
    importDroppedFiles,
    importPastedImageFiles,
    reportDialogOpen,
    setDropActive,
    setError,
  });

  function addReportDialogAttachments(nextAttachments: ReportDialogAttachment[]) {
    setReportDialogAttachments((current) => {
      const paths = new Set(current.map((attachment) => attachment.path));
      const uniqueAttachments = nextAttachments.filter((attachment) => {
        if (paths.has(attachment.path)) return false;
        paths.add(attachment.path);
        return true;
      });
      return [...current, ...uniqueAttachments];
    });
  }

  async function importAttachments<T>(
    items: T[],
    importItem: (item: T) => Promise<ImportedHermesFile>,
    options: { onImported?: (attachments: AgentAttachment[]) => void } = {},
  ) {
    if (!items.length) return true;
    setImportingFiles(true);
    try {
      // One at a time on purpose: a dropped file's bytes can be 50 MB, so
      // interleave read and upload to keep at most one buffer alive instead
      // of staging the whole batch (up to ~400 MB) in memory at once.
      const imported: ImportedHermesFile[] = [];
      for (const item of items) {
        imported.push(await importItem(item));
      }
      const nextAttachments = imported.map(agentAttachmentFromImportedFile);
      if (options.onImported) {
        options.onImported(nextAttachments);
      } else {
        setComposerAttachments((current) => [...current, ...nextAttachments]);
      }
      setError(null);
      void loadFilesystemSnapshot();
      return true;
    } catch (err) {
      setError(messageFromError(err));
      return false;
    } finally {
      setImportingFiles(false);
    }
  }

  // Native paths come from the file picker and Tauri drag-drop events.
  async function importDroppedFilePaths(
    paths: string[],
    options: { onImported?: (attachments: AgentAttachment[]) => void } = {},
  ) {
    const uniquePaths = Array.from(new Set(paths.map((path) => path.trim())))
      .filter(Boolean)
      .slice(0, 8);
    return importAttachments(uniquePaths, importHermesBridgeFile, options);
  }

  // DOM drops are how Finder files actually arrive: Tauri's drag-drop
  // interception is disabled (it has to be, so notes can use HTML5 drag into
  // folders) and WKWebView never exposes filesystem paths on dropped Files —
  // so read each blob and import its bytes.
  async function importDroppedFiles(
    files: File[],
    options: { onImported?: (attachments: AgentAttachment[]) => void; maxFiles?: number } = {},
  ) {
    const { maxFiles, ...importOptions } = options;
    return importFileBytes(
      files,
      {
        tooLargeMessage: "Dropped files must be 50 MB or smaller.",
        readErrorMessage: (file) =>
          // Reading fails for directories, which Finder happily lets you drop.
          `Could not read "${file.name}". Folders can't be attached.`,
        maxFiles,
      },
      importOptions,
    );
  }

  async function importPastedImageFiles(files: File[]) {
    await importFileBytes(files, {
      tooLargeMessage: "Pasted images must be 50 MB or smaller.",
      readErrorMessage: () => "Could not read the pasted image.",
    });
  }

  async function importFileBytes(
    files: File[],
    options: FileBytesImportOptions,
    importOptions: { onImported?: (attachments: AgentAttachment[]) => void } = {},
  ) {
    if (options.maxFiles !== undefined && files.length > options.maxFiles) {
      setError(`You can attach up to ${options.maxFiles} files at a time.`);
      return false;
    }
    const filesToImport = options.maxFiles === undefined ? files.slice(0, 8) : files;
    return importAttachments(
      filesToImport,
      async (file) => {
        if (file.size > 50 * 1024 * 1024) {
          throw new Error(options.tooLargeMessage);
        }
        const bytes = await readFileBytes(file).catch(() => {
          throw new Error(options.readErrorMessage(file));
        });
        return importHermesBridgeFileBytes(file.name, bytes);
      },
      importOptions,
    );
  }

  function removeAttachment(id: string) {
    setComposerAttachments((current) => current.filter((item) => item.id !== id));
  }

  // Focus the composer, then toggle the dictation helper's listening state —
  // the same command the hotkey path sends. The helper records, shows the HUD,
  // and pastes the transcription into the focused field (the composer).
  async function startDictation() {
    if (creditActionsDisabledReason) {
      setError(creditActionsDisabledReason);
      return;
    }
    composerEditorRef.current?.focus();
    try {
      await dictationHelperCommand({
        type: "toggle_listening",
        shortcut: "Dictation",
      });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  // The "+" picker routes through the same bridge import as drag-drop so the
  // agent always gets a real, readable path.
  async function pickAttachments(onImported?: (attachments: AgentAttachment[]) => void) {
    try {
      const selected = await openFileDialog({
        multiple: true,
        title: "Attach files",
      });
      if (!selected) return false;
      const paths = Array.isArray(selected) ? selected : [selected];
      return await importDroppedFilePaths(paths, { onImported });
    } catch (err) {
      setError(messageFromError(err));
      return false;
    }
  }

  /** Sends the captured report plus June's diagnostic reply (the last
   * assistant message of the turn) to the June team. The diagnosis fetch is
   * best-effort: a report without June's assessment still beats no report. */
  const { deliverIssueReport, sendReviewableIssueReport, sendErrorIssueReport } =
    createIssueReportActions({
      ISSUE_REPORT_SENT_TOAST_ID,
      clearErrorForSession,
      reviewableIssueReportsRef,
      selectedHermesSessionIdRef,
      setError,
      setIssueReportSubmitting,
      setReviewableIssueReport,
      setSubmittingErrorIssueReport,
      submittingErrorIssueReport,
      submittingIssueReportSessionIdsRef,
      waitForIssueReportDiagnosisRefresh,
    });

  /**
   * Attach this turn's pending images to the live session via image.attach_bytes
   * (feature 19), updating each chip's status and feeding the artifact timeline.
   * The base64 is read on demand from the workspace file, passed straight to
   * the typed attachImage, and discarded; it never lands on composer state and
   * the trace entry is redacted to a byte count. Throws a single blocking error
   * if any image failed so the prompt is not sent with a missing image.
   */
  const { attachPendingImages, clearHeldFastPathImages } = createPendingImageActions({
    pendingFastPathImagesRef,
    setComposerAttachments,
  });

  const {
    startOptimisticHermesSession,
    migrateOptimisticHermesSession,
    removeOptimisticHermesSession,
    rememberComputerUseRun,
    releaseComputerUseRun,
    releaseAllComputerUseRuns,
  } = createOptimisticSessionActions({
    commitSessionModelSelections,
    composerDraftKeyRef,
    computerUseRunLeasesRef,
    defaultGenerationModelIdRef,
    generationCostQualityRef,
    generationSelectionIntentRevisionRef,
    hermesSessionMessagesRef,
    heroExitViaThreadRef,
    liveEventsRef,
    newSessionModeRef,
    pendingHermesMessagesRef,
    recordSessionRunningActivity,
    saveGenerationSelection,
    selectedHermesSessionIdRef,
    sessionModelSelectionsRef,
    setDefaultGenerationModelId,
    setGenerationCostQuality,
    setHermesSessionItems,
    setHermesSessionMessages,
    setLiveEvents,
    setNewSessionMode,
    setPendingHermesMessages,
    setSelectedHermesSessionId,
    setSelectedTaskId,
  });

  // Returns the gateway for the given write-access mode, starting that
  // mode's runtime process if it isn't up. The two modes run side by side
  // (the sandbox is applied at spawn and can't change on a live process, so
  // per-session modes mean a process per mode) — ensuring one never touches
  // the other's process or in-flight work.
  async function ensureHermesGateway(fullMode = false) {
    let connection = hermesConnectionForMode(bridge.running ? bridge : undefined, fullMode);
    if (!connection) {
      const next = await startBridge(fullMode);
      connection = hermesConnectionForMode(next, fullMode);
    }
    const wsUrl = connection?.wsUrl;
    if (!wsUrl) throw new Error("Hermes bridge did not return a gateway URL.");
    let gateway = gatewaysRef.current.get(fullMode);
    if (!gateway) {
      gateway = new HermesGatewayClient();
      gatewaysRef.current.set(fullMode, gateway);
      // Fires only on unexpected drops — the unmount close() detaches the
      // socket first, and a superseded socket never notifies.
      gateway.onClose(() => gatewayCloseHandlerRef.current(fullMode));
    }
    await gateway.connect(wsUrl);
    return gateway;
  }

  // Fetches normalized usage/cost for one session (feature 09). Routes through
  // the gateway matching the session's recorded write-access mode, calls the
  // typed session.usage wrapper, and parses the raw result defensively. The
  // panel injects this so it stays decoupled from the gateway and reusable by
  // feature 11's activity drawer.
  const fetchSessionUsage = useCallback(
    async (storedSessionId: string): Promise<SessionUsage> => {
      const gateway = await ensureHermesGateway(sessionUnrestricted(storedSessionId));
      const methods = createHermesMethods(gateway);
      const usageFor = async (runtimeId: string) =>
        parseSessionUsage(storedSessionId, await methods.getSessionUsage({ sessionId: runtimeId }));
      // session.usage reads the LIVE runtime, keyed by the runtime id — not the
      // stored id the panel passes. Use the cached runtime if it is still alive;
      // if it has been torn down between turns ("session not found"), resume the
      // session to spin up a fresh runtime and retry once. Mirrors the send
      // flow's cached-or-resume resolution (see submit()).
      const cached = runtimeSessionIdsRef.current[storedSessionId];
      if (cached) {
        try {
          return await usageFor(cached);
        } catch (err) {
          if (!isSessionGoneError(messageFromError(err))) throw err;
        }
      }
      const resumed = await gateway.request<HermesRuntimeSessionResponse>("session.resume", {
        session_id: storedSessionId,
        cols: 96,
      });
      const runtimeSessionId = resumed.session_id;
      if (!runtimeSessionId) {
        throw new Error("Hermes did not resume the session.");
      }
      setRuntimeSessionIds((current) => ({
        ...current,
        [storedSessionId]: runtimeSessionId,
      }));
      return usageFor(runtimeSessionId);
    },
    // Stable closure over refs and imported helpers; deps intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Compacts one session's context (feature 08). Routes through the gateway
  // matching the session's recorded write-access mode, calls the typed
  // session.compress wrapper, and parses the raw result defensively so the
  // dialog can show token savings when reported. The dialog injects this so it
  // stays decoupled from the gateway, mirroring fetchSessionUsage.
  const compressSessionContext = useCallback(
    async (sessionId: string): Promise<CompressSessionResult> => {
      const gateway = await ensureHermesGateway(sessionUnrestricted(sessionId));
      const raw = await createHermesMethods(gateway).compressSession({
        sessionId,
      });
      const result = parseCompressSessionResult(sessionId, raw);
      // Compaction replaces the working context with a summary that may still
      // contain the old project block. Mark the session compacted rather than
      // deleting the entry: the sentinel differs from every real project
      // signature (so a still-filed session reinjects on its next prompt) yet
      // is not "no block ever" (so if the user then removes the session from
      // its project, prepareProjectPrompt still emits the clearing block
      // instead of silently leaving stale instructions in the summary).
      projectContextSignaturesBySessionId.set(sessionId, COMPACTED_CONTEXT_SIGNATURE);
      return result;
    },
    // Same stable-closure rationale as fetchSessionUsage above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const { attachHermesSessionEventListener } = createSessionEventListener({
    cancelAgentRunSettlement,
    clearSessionActivity,
    clearSubmittedSteers,
    continueAfterCompletedAgentRun,
    liveEventsRef,
    pendingSteerBySessionIdRef,
    promotePendingIssueReportToReview,
    recordHermesActivityAndDeriveStatus,
    refreshHermesSession,
    releaseAllComputerUseRuns,
    releaseComputerUseRun,
    sessionGatewayUnlistenRef,
    sessionThinkingAppliedRef,
    sessionThinkingEfforts,
    sessionThinkingEffortsRef,
    setLiveEvents,
    withStoredHermesSessionId,
  });

  submitHermesSessionImplementation = createSubmitHermesSession({
    AGENT_TITLE_MAX_CHARS,
    agentSessionTitleForPrompt,
    applySessionTitleOverrides,
    applyThinkingLevelToSession,
    attachHermesSessionEventListener,
    attachPendingImages,
    captureSessionModelTarget,
    clearHeldFastPathImages,
    commitSessionModelSelections,
    creditActionsDisabledReason,
    defaultGenerationModelIdRef,
    ensureHermesGateway,
    fullModeDraftRef,
    generationCostQualityRef,
    generationModelsRef,
    generationSelectionIntentRevisionRef,
    hermesSessionItemsRef,
    hermesSessionsHydratedRef,
    loadHermesSessions,
    migrateOptimisticHermesSession,
    newSessionModeRef,
    pendingFastPathImagesRef,
    pendingHermesMessagesRef,
    pendingIssueReportsRef,
    profileOwnedSessionIdsRef,
    projectContext,
    projectContextSignaturesBySessionId,
    recordSessionErrorActivity,
    recordSessionRunningActivity,
    releaseComputerUseRun,
    rememberComputerUseRun,
    removeOptimisticHermesSession,
    resolveSessionProjectContext,
    runtimeSessionIdsRef,
    selectedHermesSessionIdRef,
    sessionGatewayUnlistenRef,
    sessionModelSelectionsRef,
    sessionThinkingAppliedRef,
    sessionThinkingEfforts,
    sessionThinkingEffortsRef,
    sessionTitleOverridesRef,
    sessionTitleSourceRef,
    setHermesSessionItems,
    setNewSessionMode,
    setPendingHermesMessages,
    setRuntimeSessionIds,
    setSelectedHermesSessionId,
    setSelectedTaskId,
    startOptimisticHermesSession,
    thinkingLevelRef,
    veniceApiKeyConfiguredRef,
  });

  const {
    retryUpstreamProviderFailure,
    retryGatewayConnection,
    recoverFromGatewayClose,
    startBridge,
  } = createGatewayRecoveryActions({
    approvalResponseKey,
    approvalResponsesInFlightRef,
    attachHermesSessionEventListener,
    captureSessionModelTarget,
    ensureHermesGateway,
    gatewayRecoveringRef,
    hermesSessionItemsRef,
    liveEventsRef,
    loadHermesSessions,
    recordHermesActivityAndDeriveStatus,
    refreshHermesSession,
    selectedHermesSessionIdRef,
    setBridge,
    setBridgeStarting,
    setError,
    setLiveEvents,
    setRuntimeSessionIds,
    submitHermesSession,
    waitingSessionIdsRef,
    workingSessionIdsRef,
  });

  // Message fetches for one session can overlap: the selection effect, the
  // 2.5s working poll, and the terminal-event refresh all call
  // listHermesSessionMessages without awaiting each other, and each applies
  // its response as a whole-list overwrite. Responses can land out of order
  // (a slow fetch started before a fast one resolves after it), so without
  // ordering a stale list clobbers a newer one — the classic symptom is a
  // just-sent user message vanishing (its pending bubble was dropped when the
  // newer fetch persisted it) until a later refresh restores it. Fetches are
  // stamped with a per-session sequence at start; a response only applies if
  // no later-started fetch has applied first.
  async function listSessionMessagesOrdered(sessionId: string) {
    const seq = (sessionMessagesFetchSeqRef.current.get(sessionId) ?? 0) + 1;
    sessionMessagesFetchSeqRef.current.set(sessionId, seq);
    const messages = await listHermesSessionMessages(sessionId);
    const applied = sessionMessagesAppliedSeqRef.current.get(sessionId) ?? 0;
    if (seq < applied) return undefined;
    sessionMessagesAppliedSeqRef.current.set(sessionId, seq);
    return messages;
  }

  async function refreshHermesSession(sessionId: string) {
    try {
      const messages = await listSessionMessagesOrdered(sessionId);
      if (!messages) return undefined;
      const retainedPending = retainUnpersistedPendingMessages(
        pendingHermesMessagesRef.current[sessionId] ?? [],
        messages,
      );
      const combined = [...messages, ...retainedPending];
      setHermesSessionMessages((current) => {
        const next = {
          ...current,
          [sessionId]: messages,
        };
        hermesSessionMessagesRef.current = next;
        return next;
      });
      setPendingHermesMessages((current) => {
        const next = {
          ...current,
          [sessionId]: retainedPending,
        };
        pendingHermesMessagesRef.current = next;
        return next;
      });
      void suggestTitleForUntitledSession(sessionId, messages);
      if (sessionHasAssistantAfterLatestUser(combined)) {
        promotePendingIssueReportToReview(sessionId, {
          queueDiagnosisRefresh: false,
        });
        const wasActive = sessionHasActiveWork(
          sessionId,
          workingSessionIdsRef.current,
          waitingSessionIdsRef.current,
          liveEventsRef.current,
        );
        const activityCounts = clearSessionActivity(sessionId);
        if (wasActive) {
          void releaseAllComputerUseRuns(sessionId);
          markAgentRunSucceeded(sessionId);
          dispatchAgentSessionStatus({
            sessionId,
            title:
              hermesSessionItems.find((session) => session.id === sessionId)?.title ??
              "Agent session",
            status: "completed",
            summary: "June finished.",
            ...activityCounts,
          });
          continueAfterCompletedAgentRun(sessionId);
        }
        liveEventsRef.current = { ...liveEventsRef.current, [sessionId]: [] };
        setLiveEvents(liveEventsRef.current);
      }
      await loadHermesSessions();
      return combined;
    } catch (err) {
      const message = messageFromError(err);
      // Background refresh racing a just-created session: a transient
      // "Session not found" 404 resolves on the next poll, so don't surface
      // it as an error banner (JUN-116).
      if (isSessionGoneError(message)) return undefined;
      setError(describeHermesError(err), reportableAgentErrorOptions(err, { sessionId }));
      return undefined;
    }
  }

  const {
    respondToApproval,
    respondToClarify,
    respondToSudo,
    respondToSecret,
    enableCliAccessFromChat,
    enableBrowserAccessFromChat,
  } = createSessionResponseActions({
    approvalResponseKey,
    approvalResponsesInFlightRef,
    cancelComposerDispatch,
    captureSessionModelTarget,
    classifyOptimisticLiveEvent,
    clearSessionActivity,
    composerDispatchWasInvalidated,
    ensureHermesGateway,
    hermesSessionItemsRef,
    liveEventsRef,
    loadHermesSessions,
    pushLiveEvent,
    recordOptimisticHermesActivityAndDispatchStatus,
    reserveComposerDispatch,
    selectedHermesSessionIdRef,
    sessionGatewayUnlistenRef,
    setApprovalSubmitting,
    setBrowserAccessEnabled,
    setBrowserAccessSubmitting,
    setClarifySubmitting,
    setCliAccessEnabled,
    setCliAccessSubmitting,
    setError,
    setLiveEvents,
    setSecretSubmitting,
    setSudoSubmitting,
    setWorkingTaskIds,
    submitHermesSession,
  });

  // Feature 07: fork the conversation into a NEW session that starts from the
  // given message, through the typed control-plane method (session.branch).
  // The source session is never mutated. The returned session id is
  // AUTHORITATIVE — we open whatever the gateway minted, never a local guess —
  // and the new session inherits the source's write-access mode so a follow-up
  // routes to the right runtime. On failure the UI stays in the source session
  // with an actionable banner.
  const { branchFromMessage } = createBranchSessionAction({
    BRANCH_TOAST_ID,
    attachmentsRef,
    branchingMessageIdRef,
    categoryRef,
    composerDraftKeyRef,
    composerEditorRef,
    draftRef,
    ensureHermesGateway,
    hermesSessionItems,
    hermesSessionMessages,
    hermesSessionMessagesRef,
    liveEventsRef,
    loadHermesSessions,
    newSessionModeRef,
    pendingHermesMessagesRef,
    profileOwnedSessionIdsRef,
    restoredComposerDraftKeyRef,
    runtimeSessionIdsRef,
    selectedHermesSessionIdRef,
    setActivePanel,
    setAttachments,
    setBranchingMessageId,
    setCategory,
    setDraft,
    setError,
    setHermesSessionMessages,
    setLiveEvents,
    setNewSessionMode,
    setPendingHermesMessages,
    setRuntimeSessionIds,
    setSelectedHermesSessionId,
    setSelectedTaskId,
  });

  function clearSubmittedSteers(
    sessionId: string,
    options: { preserveReservations?: boolean } = {},
  ) {
    if (!options.preserveReservations) {
      for (const entry of pendingSteerBySessionIdRef.current[sessionId] ?? []) {
        entry.dispatchReservation?.cancel();
      }
    }
    delete pendingSteerBySessionIdRef.current[sessionId];
    clearSteerCards(sessionId);
  }

  // Feature 06: steer a STILL-WORKING session with a mid-run instruction,
  // through the dedicated typed control-plane method (session.steer) — never
  // prompt.submit, which the gateway rejects with 4009 while a turn runs. On a
  // gateway ack we record the user's instruction as a local "Steering" system
  // item in the transcript (pushed onto the same live-event channel Hermes
  // frames use, so it orders and survives re-renders for free). Rejections
  // bubble to the caller (the composer input) so it can keep the unsent text
  // and show recoverable copy; the typed wrapper stays the only seam that knows
  // the wire shape.
  async function steerActiveSession(sessionId: string, text: string) {
    const instruction = normalizeSteerText(text);
    if (!instruction) return;
    // The instruction is shown as a read-only steer card tacked to the composer
    // (see the submit path) rather than a transcript line.
    const gateway = await ensureHermesGateway(sessionUnrestricted(sessionId));
    await createHermesMethods(gateway).steerSession({
      sessionId,
      text: instruction,
    });
  }

  // Drop every steer card for a session - the turn ended (delivered or resent as
  // a follow-up) or was stopped, so the submitted-steer history retires.
  function clearSteerCards(sessionId: string) {
    setSteerCardsBySessionId((prev) => {
      if (!prev[sessionId]) return prev;
      const copy = { ...prev };
      delete copy[sessionId];
      return copy;
    });
  }

  // Submitted text and locally waiting attachment messages share one compact
  // follow-up system. session.steer has no recall primitive, so submitted text
  // remains read-only; transport state stays out of the visual scan line.
  function renderSteerCard(card: { id: string; text: string }) {
    return (
      <div key={card.id} className="agent-follow-up-row" data-kind="steer">
        <span className="agent-follow-up-icon" aria-hidden>
          <IconArrowCornerDownRight size={13} />
        </span>
        <span className="agent-follow-up-copy">
          <span className="agent-follow-up-text" title={card.text}>
            {card.text}
          </span>
        </span>
      </div>
    );
  }

  function renderQueuedAttachmentFollowUp(
    queueKey: string,
    item: QueuedAttachmentFollowUp,
    options: { demo?: boolean } = {},
  ) {
    const sessionWorking =
      options.demo ||
      (queueKey !== NEW_SESSION_RECOVERY_QUEUE_KEY && workingSessionIds.has(queueKey));
    const firstInQueue = queuedAttachmentFollowUpsRef.current[queueKey]?.[0]?.id === item.id;
    const hasAttachedImage = item.attachments.some(
      (attachment) => attachment.attach.kind === "image" && attachment.attach.status === "attached",
    );
    const locallyEditable = item.status !== "sending" && !hasAttachedImage;
    const editable = locallyEditable && !draft.trim() && attachments.length === 0;
    const statusLabel =
      item.status === "sending"
        ? "Sending"
        : item.status === "failed"
          ? hasAttachedImage
            ? "Image attached; message not sent"
            : "Couldn't send"
          : sessionWorking
            ? "Waiting for June to finish"
            : "Ready to send";
    return (
      <div
        key={item.id}
        className="agent-follow-up-row"
        data-kind="attachment"
        data-status={item.status}
        title={item.error ?? undefined}
      >
        {item.attachments.length ? (
          <div className="agent-follow-up-attachments">
            {item.attachments.length > 1 ? (
              <span className="agent-attachment-chip" data-kind="file" aria-hidden>
                <span className="agent-attachment-file-icon">
                  <IconFiles size={14} />
                </span>
              </span>
            ) : (
              item.attachments
                .slice(0, 1)
                .map((attachment) => (
                  <AgentAttachmentTile key={attachment.id} attachment={attachment} />
                ))
            )}
          </div>
        ) : (
          <span className="agent-follow-up-icon" aria-hidden>
            <IconArrowCornerDownRight size={13} />
          </span>
        )}
        <div className="agent-follow-up-copy">
          <span className="agent-follow-up-text">{item.prepared.typedMessage || "Attachment"}</span>
          <span className="agent-follow-up-announcement" aria-live="polite">
            {statusLabel}
          </span>
          {item.error ? <span className="agent-follow-up-announcement">{item.error}</span> : null}
        </div>
        {item.status === "sending" ? null : (
          <div className="agent-follow-up-actions">
            {item.status === "failed" && firstInQueue ? (
              <button
                type="button"
                aria-label="Retry queued message"
                title="Retry"
                disabled={sessionWorking}
                onClick={() => void deliverQueuedAttachmentFollowUp(queueKey, item.id)}
              >
                <IconArrowRotateClockwise size={14} />
              </button>
            ) : !sessionWorking && firstInQueue ? (
              <button
                type="button"
                aria-label="Send queued message"
                title="Send now"
                onClick={() => void deliverQueuedAttachmentFollowUp(queueKey, item.id)}
              >
                <IconArrowUp size={14} />
              </button>
            ) : null}
            {locallyEditable ? (
              <>
                <button
                  type="button"
                  aria-label="Edit queued message"
                  title={editable ? "Edit" : "Clear the composer before editing"}
                  disabled={!editable}
                  onClick={() => {
                    if (options.demo) {
                      setUpNextDemoFollowUpsBySessionId((current) => ({
                        ...current,
                        [queueKey]: (current[queueKey] ?? []).filter(
                          (followUp) => followUp.id !== item.id,
                        ),
                      }));
                      draftRef.current = item.prepared.typedMessage;
                      setDraft(item.prepared.typedMessage);
                      composerEditorRef.current?.setContent(item.prepared.typedMessage);
                      return;
                    }
                    editQueuedAttachmentFollowUp(queueKey, item.id);
                  }}
                >
                  <IconPencil size={14} />
                </button>
                <button
                  type="button"
                  aria-label="Remove queued message"
                  title="Remove"
                  onClick={() =>
                    options.demo
                      ? setUpNextDemoFollowUpsBySessionId((current) => ({
                          ...current,
                          [queueKey]: (current[queueKey] ?? []).filter(
                            (followUp) => followUp.id !== item.id,
                          ),
                        }))
                      : removeQueuedAttachmentFollowUp(queueKey, item.id)
                  }
                >
                  <IconTrashCan size={14} />
                </button>
              </>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  function runShortcut(shortcut: AgentShortcut) {
    if (shortcut.action === "attach") {
      rememberComposerDraft(composerDraftKeyRef.current, shortcut.prompt, null);
      composerEditorRef.current?.setContent(shortcut.prompt);
      void pickAttachments();
      return;
    }
    // Prefill and select the "<placeholder>" token so typing replaces it in
    // place (setContent focuses the editor as part of selecting the range).
    composerEditorRef.current?.setContent(shortcut.prompt, null, {
      selectPlaceholder: true,
    });
    rememberComposerDraft(
      composerDraftKeyRef.current,
      stripPlaceholder(shortcut.prompt)?.text ?? shortcut.prompt,
      null,
    );
  }

  const { cancelTask, stopHermesSession, stopHermesSubagent, retryTask } = createTaskControlActions(
    {
      cancelAgentRunSettlement,
      clearSessionActivity,
      clearSubmittedSteers,
      computerUseRunLeasesRef,
      ensureHermesGateway,
      hermesSessionItems,
      refreshHermesSession,
      runtimeSessionIds,
      sessionGatewayUnlistenRef,
      setError,
      setStoppingSessionIds,
      stoppingSessionIds,
      upsertTask,
    },
  );

  const {
    setSkillEnabled,
    setToolsetEnabled,
    setMessagingPlatformEnabled,
    saveMessagingPlatformEnv,
  } = createCapabilityActions({
    loadMessagingPlatforms,
    messagingEnvEdits,
    setCapabilitySaving,
    setError,
    setMessagingEnvEdits,
    setMessagingPlatforms,
    setSkills,
    setToolsets,
  });

  // Apply the dev-tools gallery toggle (window.__agentGallery, registered at
  // module scope above): pick up the desired state on mount — the command may
  // have been issued from another view before this workspace existed — and
  // follow live toggles via the window event.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const apply = (show: boolean, errors: boolean) => {
      setGallerySections(
        show ? (errors ? buildAgentErrorGallery() : buildAgentChatGallery()) : null,
      );
      setGalleryErrors(show && errors);
    };
    apply(Boolean(galleryDesired), galleryDesired === "errors");
    const onGallery = (event: Event) => {
      const detail = (event as CustomEvent<AgentGalleryDetail>).detail;
      apply(Boolean(detail?.show), Boolean(detail?.errors));
    };
    window.addEventListener(AGENT_GALLERY_EVENT, onGallery);
    return () => window.removeEventListener(AGENT_GALLERY_EVENT, onGallery);
  }, []);

  // Dev-only streaming replay (window.__streamDemo, registered at module
  // scope): pick up the desired state on mount and follow live toggles via the
  // window event. Feeds the gallery timeline an append-only running text part
  // in irregular chunks, like a real provider stream.
  useAgentStreamDemo({
    setGallerySections,
  });

  // Reopen the steer queue whenever the open session changes — collapsing it
  // is a per-session, per-glance affordance, not a sticky mode.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on session switch only
  useEffect(() => {
    setSteerQueueOpen(true);
  }, [selectedHermesSessionId]);

  // Re-measure the follow-up-list fade when the queue opens or the count changes —
  // data-driven size changes the hook's scroll/resize listeners can miss.
  useEffect(() => {
    steerCardsFade.update();
  }, [steerQueueOpen, selectedFollowUpCount, steerCardsFade.update]);

  // Dev-only composer steer-state driver (window.__composerSteerDemo): pick up
  // the desired state on mount and follow live toggles via the window event.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    setComposerSteerDemo(composerSteerDemoDesired);
    const onDemo = (event: Event) => {
      setComposerSteerDemo(Boolean((event as CustomEvent<{ show: boolean }>).detail?.show));
    };
    window.addEventListener(COMPOSER_STEER_DEMO_EVENT, onDemo);
    return () => window.removeEventListener(COMPOSER_STEER_DEMO_EVENT, onDemo);
  }, []);

  // Dev-only: preview the working-composer follow-up system without starting a
  // real turn. __steerSubmitDemo shows one submitted text steer; __upNextDemo
  // shows every queue shape at once (two steers, a single-attachment message,
  // a multi-attachment message) and parks the composer in steer state.
  useAgentSteerDemo({
    imageTurnsBySession,
    selectedHermesSessionId,
    selectedHermesSessionIsProvisional,
    setImageTurnsBySession,
    setSteerCardsBySessionId,
    setUpNextDemoFollowUpsBySessionId,
    steerCardSeqRef,
  });

  // Hoisted so the trailing "Thinking…" indicator only shows in the gap after a
  // send (last turn is the user's) — once an assistant turn exists it carries
  // its own thinking/streaming state, so we don't double up.
  const hermesTurns = selectedHermesSessionId
    ? // Merge client-synthesized slash overlays with gateway-derived turns,
      // ordered by createdAt. Array.sort is stable, and media turn timestamps
      // are minted strictly after their user prompts, so results render below
      // the prompts that produced them.
      [
        ...mergeThinkingTurns(
          buildHermesSessionChatTurns(
            selectedHermesMessages,
            liveEvents[selectedHermesSessionId] ?? [],
          ),
        ),
        ...(imageTurnsBySession[selectedHermesSessionId] ?? []),
        ...(videoTurnsBySession[selectedHermesSessionId] ?? []),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : [];
  const upstreamFailureRecoveryIds = upstreamProviderRecoveryIds(hermesTurns);
  const taskTurns = selectedTask
    ? mergeThinkingTurns(
        buildAgentChatTurns(
          selectedTask.messages,
          selectedTask.toolEvents,
          liveEvents[selectedTask.id] ?? [],
        ),
      )
    : [];
  const turnArtifacts = assignArtifactsToTurns(
    selectedHermesSessionId ? hermesTurns : taskTurns,
    chatArtifacts,
  );
  const surfacedConversationArtifacts = surfacedArtifactsFromTurns(
    selectedHermesSessionId ? hermesTurns : taskTurns,
    turnArtifacts,
    chatArtifacts,
  );
  const activeThinkingKey = selectedHermesSessionId
    ? `session:${selectedHermesSessionId}:active`
    : selectedTask
      ? `task:${selectedTask.id}:active`
      : undefined;
  const thinkingOpen = useCallback(
    (key: string) => thinkingOpenByKey[key] ?? false,
    [thinkingOpenByKey],
  );
  const setThinkingOpen = useCallback((key: string, open: boolean) => {
    setThinkingOpenByKey((current) =>
      current[key] === open ? current : { ...current, [key]: open },
    );
  }, []);
  // Every file the conversation has surfaced, in turn order — the session
  // bar's files button keeps them reachable after their cards scroll away.
  const surfacedArtifacts = surfacedConversationArtifacts.concat(devArtifacts);
  const downloadPathBackedArtifact = (path: string, displayName: string) => {
    const requestSessionId = selectedHermesSessionIdRef.current;
    void downloadHermesBridgeFile(path)
      .then((destination) => {
        if (selectedHermesSessionIdRef.current === requestSessionId) {
          toast.success(<DownloadToastMessage action="Downloaded" fileName={displayName} />, {
            id: DOWNLOAD_TOAST_ID,
            action: {
              label: "Show file",
              onClick: () => void revealPath(destination),
            },
          });
        }
      })
      .catch((err: unknown) => {
        setError(messageFromError(err), { sessionId: requestSessionId ?? null });
      });
  };
  const downloadArtifact = (artifact: AgentArtifact) => {
    downloadPathBackedArtifact(artifact.path, artifact.name);
  };
  const openArtifact = (artifact: AgentArtifact) => setArtifactPanel({ view: "file", artifact });

  // A `/image` result reuses the artifact view/download flow: download saves the
  // imported workspace file; "open" enlarges it in the same file viewer any
  // generated file uses. The image part carries its bytes inline for the
  // thumbnail, but the affordances key off the imported path on disk.
  const downloadGeneratedImage = (part: Extract<AgentChatPart, { type: "image" }>) => {
    // A `/image` result has an imported workspace file; save it through the
    // bridge (native save dialog). A tool-produced image (june_image MCP) has
    // no June-workspace path — its bytes live only in the inline data url, so
    // save those directly via an anchor download.
    if (part.path) {
      downloadPathBackedArtifact(part.path, part.name?.trim() || "Generated image");
      return;
    }
    if (part.dataUrl) {
      const requestSessionId = selectedHermesSessionIdRef.current;
      const fileName = ensureDownloadFileExtension(
        part.name?.trim() || "generated-image.png",
        "png",
      );
      const link = document.createElement("a");
      link.href = part.dataUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      if (selectedHermesSessionIdRef.current === requestSessionId) {
        toast(<DownloadToastMessage action="Download started" fileName={fileName} />, {
          id: DOWNLOAD_TOAST_ID,
        });
      }
    }
  };
  const openGeneratedImage = (part: Extract<AgentChatPart, { type: "image" }>) => {
    if (!part.path) return;
    openArtifact({
      name: part.name?.trim() || "Generated image",
      path: part.path,
      rootLabel: "Workspace",
    });
  };
  const downloadGeneratedVideo = (part: Extract<AgentChatPart, { type: "video" }>) => {
    if (!part.path) return;
    downloadPathBackedArtifact(part.path, part.name?.trim() || "Generated video");
  };

  // Feature 14: open an artifact from the drawer's timeline. The timeline's
  // record (hermes-artifact-store's AgentArtifact) is a different, richer shape
  // than the file-viewer's local AgentArtifact, so adapt it onto the EXISTING
  // preview flow rather than building a second viewer: a filesystem-backed
  // artifact opens in the same `AgentArtifactPanel` (which fetches via
  // hermes_bridge_file_preview / _file_text), and a remote url opens in the
  // browser. A failed access has nothing to preview, so it stays inert.
  const openTimelineArtifact = useCallback((artifact: TimelineArtifact) => {
    if (artifact.action === "failed") return;
    if (artifact.kind === "url") {
      if (artifact.path) window.open(artifact.path, "_blank", "noopener");
      return;
    }
    if (!artifact.path) return;
    setArtifactPanel({
      view: "file",
      artifact: {
        name: artifact.displayName ?? artifact.path,
        path: artifact.path,
        rootLabel: artifact.mode === "unrestricted" ? "Local" : "Workspace",
        size: null,
      },
    });
  }, []);

  // Aggregate size of the rendered conversation so streaming deltas — which
  // grow text inside an existing turn without changing any count — still keep
  // the scroller pinned to the bottom.
  const renderedTurnsSignature = chatTurnsSignature(
    selectedHermesSessionId ? hermesTurns : taskTurns,
  );

  // Which conversation the scroller is already settled in. A switch (and the
  // history fetch that fills the new conversation in) must land at the bottom
  // instantly; only turns arriving while the user is already reading glide.
  const {
    pinTranscriptAfterVisibleReveal,
    selectedHistoryLoaded,
    startupSessionHydrationPending,
    scrollTranscriptToLatest,
  } = useAgentTranscriptScroll({
    agentScrollRef,
    composerClearance,
    hermesSessionMessages,
    hermesSessionsHydrated,
    hermesSessionsLoading,
    heroMode,
    listRef,
    renderedTurnsSignature,
    selectedHermesSessionId,
    selectedTask,
    selectedTaskId,
    taskHistoryLoadedIdsRef,
  });

  // Reshuffle the deck each time the hero comes back, so repeat visits start
  // from a fresh hand instead of wherever the last rotation left off.
  useEffect(() => {
    if (!heroMode) return;
    setHeroDeck(shuffleAgentShortcuts());
    setHeroDeckStart(0);
    setHeroChipPhase("in");
  }, [heroMode]);

  // While the hero idles, cascade the hand through the deck: fade the chips
  // out left-to-right, advance the window, fade the next hand in with the
  // same wave. Skips a beat instead of yanking targets while the user is
  // hovering the chips, has started typing, or has the window backgrounded;
  // never cycles under reduced motion.
  useAgentHeroRotation({
    draftRef,
    heroChipsHoverRef,
    heroMode,
    setHeroChipPhase,
    setHeroDeckStart,
  });

  const heroShortcuts = useMemo(
    () =>
      Array.from(
        { length: HERO_SHORTCUT_COUNT },
        (_, index) => heroDeck[(heroDeckStart + index) % heroDeck.length],
      ),
    [heroDeck, heroDeckStart],
  );

  // FLIP the composer from its hero spot (centered, big) down to the bottom
  // dock when the hero hands over to a conversation — this glide is what
  // sells the transition instead of a teleport. The form is recreated across
  // the handoff (the conversation branch wraps it in .agent-scroll), which is
  // why the glide works off snapshotted rects rather than DOM identity.
  // While the hero is up, every render snapshots the box; the first render
  // after leaving measures the docked position and animates the delta.
  const heroExitRectRef = useRef<DOMRect | null>(null);
  useAgentHeroHandoff({
    composerBoxRef,
    heroExitRectRef,
    heroExitViaThreadRef,
    heroMode,
    listRef,
    prevHeroModeRef,
  });

  submitImplementation = createSubmitComposer({
    SESSION_BUSY_NOTICE,
    SESSION_BUSY_TOAST_ID,
    attachments,
    attachmentsRef,
    beginAttachmentPreparation,
    cancelComposerDispatch,
    captureSessionModelTarget,
    category,
    categoryRef,
    clearComposerDraft,
    composerDispatchOrderRef,
    composerDispatchWasInvalidated,
    composerDraftKeyRef,
    composerEditorRef,
    composerInputSignature,
    composerSizeProceedSignatureRef,
    deferredFailedIssueReportDeliverySessionIdsRef,
    draft,
    draftRef,
    enqueueAttachmentFollowUp,
    enqueueFailedComposerFollowUp,
    finishAttachmentPreparation,
    forgetComposerDispatch,
    generationModel,
    generationModels,
    handleBuiltinComposerSlashCommand,
    heroMode,
    imageSlashBlockedByModel,
    importingFiles,
    newSessionModeRef,
    pendingSteerBySessionIdRef,
    prepareComposerSubmission,
    projectContext,
    projectContextSignaturesBySessionId,
    reserveComposerDispatch,
    reviewableIssueReportsRef,
    selectedHermesSessionId,
    selectedHermesSessionIdRef,
    selectedHermesSessionIsProvisional,
    setCategory,
    setComposerAttachments,
    setComposerSizeWarning,
    setDraft,
    setError,
    setHeroLeaving,
    setReviewableIssueReport,
    setSteerCardsBySessionId,
    setSubmitting,
    setSubmittingHermesSessionId,
    steerActiveSession,
    steerCardSeqRef,
    submitHermesSession,
    submitting,
    submittingIssueReportSessionIdsRef,
    textActionsDisabledReason,
    workingSessionIdsRef,
  });

  const composer = renderAgentComposer({
    SESSION_BUSY_NOTICE,
    activeGenerationCostQuality,
    activePanel,
    agentScrollRef,
    attachMenuOpen,
    attachMenuRef,
    attachTriggerRef,
    attachments,
    attachmentsRef,
    categoryRef,
    composerBoxRef,
    composerDraftKeyRef,
    composerEditorRef,
    composerInSteerState,
    composerModelFlyout,
    composerModelOpen,
    composerModelPopoverRef,
    composerModelRootSearchRef,
    composerModelSearchRef,
    composerModelTriggerRef,
    composerRef,
    composerThinkingLevel,
    composerTiptapEditorRef,
    confirmUnrestricted,
    creditActionsDisabledReason,
    draft,
    draftRef,
    dropActive,
    editOversizeComposerInput,
    fullModeDraft,
    fullModeDraftRef,
    galleryErrors,
    generatingImage,
    generatingVideo,
    generationModel,
    generationModelOptions,
    handleComposerDragOver,
    handleComposerDrop,
    handleComposerPaste,
    handleCostQualityChange,
    handleReportDialogSent,
    handleSelectGenerationModel,
    handleSelectThinkingLevel,
    heroMode,
    imageModelWarningText,
    imageSlashBlockedByModel,
    importReportDialogDroppedFiles,
    importingFiles,
    loadSkillCommands,
    modelRootSearch,
    modelSearch,
    openComposerModelPicker,
    openReportDialog,
    pickAttachments,
    pickReportDialogAttachments,
    preferredVisionModel,
    proceedWithOversizeComposerInput,
    removeAttachment,
    removeReportDialogAttachment,
    renderFundingNotice,
    renderQueuedAttachmentFollowUp,
    renderSteerCard,
    reportDialogAttachments,
    reportDialogCategory,
    reportDialogDescription,
    reportDialogOpen,
    restoreComposerDraft,
    sandboxFirstItemRef,
    sandboxMenuOpen,
    sandboxMenuRef,
    sandboxTriggerRef,
    scrollTranscriptToLatest,
    seedComposerNoteRef,
    selectedFollowUpCount,
    selectedHermesSessionId,
    selectedHermesSessionIsProvisional,
    selectedQueuedAttachmentFollowUps,
    selectedSteerCards,
    selectedTask,
    selectedUpNextDemoFollowUps,
    sendReviewableIssueReport,
    setAttachMenuOpen,
    setCategory,
    setComposerModelFlyout,
    setComposerModelOpen,
    setConfirmUnrestricted,
    setDraft,
    setDropActive,
    setFullModeDraft,
    setModelRootSearch,
    setModelSearch,
    setReportDialogCategory,
    setReportDialogDescription,
    setReportDialogOpen,
    setSandboxMenuOpen,
    setSteerQueueOpen,
    showImageModelWarning,
    skillCommandLoading,
    skills,
    startDictation,
    steerCardsFade,
    steerCardsListRef,
    steerQueueOpen,
    stopHermesSession,
    stoppingSessionIds,
    submit,
    submitting,
    switchOversizeComposerModel,
    textActionsDisabledReason,
    textFundingContext,
    veniceApiKeyConfigured,
    visibleComposerSizeWarning,
    visibleFollowUpQueueKey,
    visibleIssueReportHasUnsentContext,
    visibleIssueReportImportingFiles,
    visibleIssueReportReview,
    workingSessionIds,
  });

  const browserApprovalCards = browserApprovals.map((approval) => (
    <BrowserApprovalCard
      key={approval.approvalId}
      approval={approval}
      submitting={browserApprovalSubmitting === approval.approvalId}
      onRespond={(approve, allowSite) =>
        void respondToBrowserApproval(approval.approvalId, approve, allowSite)
      }
    />
  ));

  const detailContent = renderAgentDetailContent({
    activeThinkingKey,
    approvalSubmitting,
    branchFromMessage,
    branchingMessageId,
    browserAccessEnabled,
    browserAccessSubmitting,
    browserApprovalCards,
    cancelTask,
    clarifySubmitting,
    cliAccessEnabled,
    cliAccessSubmitting,
    creditActionsDisabledReason,
    downloadArtifact,
    downloadGeneratedImage,
    downloadGeneratedVideo,
    enableBrowserAccessFromChat,
    enableCliAccessFromChat,
    fundingTier,
    galleryErrors,
    gallerySections,
    generationPrivacyBadge,
    handleTopUp,
    hermesTurns,
    listRef,
    newSessionMode,
    openArtifact,
    openGeneratedImage,
    pinTranscriptAfterVisibleReveal,
    rawTraceSession,
    respondToApproval,
    respondToClarify,
    respondToSecret,
    respondToSudo,
    retryImageSlashTurn,
    retryTask,
    retryUpstreamProviderFailure,
    retryVideoSlashTurn,
    secretSubmitting,
    selectedHermesSessionId,
    selectedTask,
    setRawTraceSession,
    setThinkingOpen,
    stopHermesSession,
    sudoSubmitting,
    taskTurns,
    thinkingOpen,
    topUpLabel,
    turnArtifacts,
    unsupportedNotice,
    upstreamFailureRecoveryIds,
    waitingSessionIds,
    workingSessionIds,
    workingTaskIds,
  });

  return renderAgentWorkspaceLayout({
    ACTIVITY_DRAWER_ENABLED,
    activeAgentCount,
    activePanel,
    activityDrawerOpen,
    activityRecords,
    activityStatus,
    agentScrollRef,
    artifactPanel,
    bridgeStarting,
    canShareAgentSession,
    compactSessionId,
    composer,
    composerClearance,
    compressSessionContext,
    deleteSelectedHermesSession,
    detailContent,
    downloadArtifact,
    draft,
    fetchSessionUsage,
    galleryErrors,
    generationModel,
    generationPrivacyBadge,
    hermesTurns,
    heroChipPhase,
    heroChipsHoverRef,
    heroGreeting,
    heroLeaving,
    heroMode,
    heroShortcuts,
    imageSafeModeConsentRequest,
    modelForActivitySession,
    newSessionMode,
    onMoveSessionToProject,
    openArtifact,
    openSessionFromDrawer,
    openTimelineArtifact,
    origin,
    projectContext,
    renameHermesSession,
    resolveImageSafeModeConsent,
    resolveModel,
    retryGatewayConnection,
    runShortcut,
    selectedHermesSession,
    selectedHermesSessionId,
    selectedHermesSessionIsProvisional,
    selectedHistoryLoaded,
    selectedTask,
    sendErrorIssueReport,
    sessionInProject,
    sessionShareUrl,
    setActivityDrawerOpen,
    setArtifactPanel,
    setCompactSessionId,
    setError,
    setSessionShareUrl,
    setShareSessionId,
    setUsagePanelSessionId,
    shareSessionId,
    startupSessionHydrationPending,
    steerSessionFromDrawer,
    stopHermesSession,
    stopHermesSubagent,
    submitting,
    submittingErrorIssueReport,
    surfacedArtifacts,
    timelineArtifacts,
    titleForPendingSession,
    usageDemo,
    usagePanelSessionId,
    visibleError,
    visibleErrorRetryable,
    visibleErrorState,
    workingSessionIds,
  });
}
import { AGENT_TITLE_MAX_CHARS, agentSessionTitleForPrompt } from "./session-title";

function PanelTabs({
  activePanel,
  onChange,
}: {
  activePanel: AgentPanel;
  onChange: (panel: AgentPanel) => void;
}) {
  return (
    <div className="agent-panel-tabs" role="tablist" aria-label="Agent panels">
      <button type="button" aria-selected={activePanel === "chat"} onClick={() => onChange("chat")}>
        <IconBubble3 size={14} />
        Chat
      </button>
      <button
        type="button"
        aria-selected={activePanel === "skills"}
        onClick={() => onChange("skills")}
      >
        <IconToolbox size={14} />
        Skills
      </button>
      <button
        type="button"
        aria-selected={activePanel === "messaging"}
        onClick={() => onChange("messaging")}
      >
        <IconBubbleWide size={14} />
        Messaging
      </button>
    </div>
  );
}

export {
  FilesystemPanel,
  MessagingFieldGroup,
  MessagingPanel,
  MessagingPlatformDetail,
} from "./management/MessagingFilesystemPanels";
import {
  agentComposerClearance,
  chatTurnsSignature,
  mergeThinkingTurns,
} from "./chat-turns/TranscriptViews";
export {
  AgentScrollToLatestButton,
  agentComposerClearance,
} from "./chat-turns/TranscriptViews";
export { SessionCompactDialog } from "./chat-turns/SessionNotices";
function visibleAgentWorkspaceError(
  error: AgentWorkspaceError | null,
  selectedSessionId: string | undefined,
) {
  if (!error) return null;
  if (!error.sessionId) return selectedSessionId ? null : error;
  return error.sessionId === selectedSessionId ? error : null;
}

// The raw billing failure ("Error: Error code: 402 - …") never reaches the
// transcript — the chat runtime folds it into a notice part, and this card is
// how the user learns the turn stopped and what to do about it. No title —
// the user's own (depleted) tier card + one sentence + the action, matching
// the FundingNotice family; the warning triangle is the fallback when the
// caller has no account snapshot.
export { resetGeneratedVideoPosterCacheForTest } from "./chat-turns/GeneratedMedia";
export {
  AgentBrowserAccessCard,
  AgentCliAccessCard,
  ApprovalPart,
  BrowserApprovalCard,
  ClarifyPart,
} from "./chat-turns/AgentActionCards";
import { BrowserApprovalCard } from "./chat-turns/AgentActionCards";
export {
  BranchFromHereAction,
  SecretPart,
  SudoPart,
  branchSourceSessionIdForTurn,
  turnIsConcreteResponse,
} from "./chat-turns/BranchAndSensitiveActions";
import { type AgentArtifact } from "./chat-turns/AgentArtifactPanel";
import {
  assignArtifactsToTurns,
  surfacedArtifactsFromTurns,
} from "./composer/composer-input-helpers";
export { generatedImagePathAliases } from "./composer/composer-input-helpers";
import {
  agentActivityCountsFromStore,
  agentStatusFromHermesEvent,
  agentStatusSummaryFromHermesEvent,
  mergeActiveHermesSessions,
  retainUnpersistedPendingMessages,
  sessionHasAssistantAfterLatestUser,
  sessionHasActiveWork,
} from "./session-state-helpers";
export {
  projectAgentActivityLevels,
  type AgentActivityLevelProjection,
} from "./session-state-helpers";
import {
  AgentAttachmentTile,
  DownloadToastMessage,
  ensureDownloadFileExtension,
  omitRecordKey,
  readFileBytes,
} from "./agent-workspace-support";
import { forgetLastOpenSessionId, writeLastOpenSessionId } from "./session-persistence";
export {
  markAgentNewSessionPending,
  pendingNewSessionRequest,
  type AgentNewSessionDetail,
} from "./session-persistence";
