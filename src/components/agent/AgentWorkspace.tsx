import type { Editor as TiptapEditor } from "@tiptap/react";
import { listen } from "@tauri-apps/api/event";
import { IconBubble3 } from "central-icons/IconBubble3";
import { IconBubbleWide } from "central-icons/IconBubbleWide";
import { IconToolbox } from "central-icons/IconToolbox";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "../ui/Toaster";
import {
  computerUseStop,
  getAgentTask,
  hermesBrowserAccess,
  primeGeneratedVideoDir,
  dictationHelperCommand,
  importHermesBridgeFileBytes,
  type AgentTaskStatus,
  type HermesSessionMessage,
  type ProviderModelSettingsDto,
} from "../../lib/tauri";
import { parseDictationHelperEvent } from "../../lib/dictation-events";
import { isWindowsPlatform } from "../../lib/platform";
import { listHermesSessionMessages } from "../../lib/hermes-adapter";
import { dispatchAgentSessionStatus } from "../../lib/agent-events";
import type { HermesGatewayClient } from "../../lib/hermes-gateway";
import { subscribeHermesActiveSessionSnapshots } from "../../lib/hermes-active-session-snapshots";
import {
  createHermesMethods,
  hermesModeFor,
  type JuneHermesEvent,
} from "../../lib/hermes-control-plane";
import { normalizeSteerText } from "../../lib/hermes-session-steer";
import { pendingActionStore } from "../../lib/hermes-pending-actions";
import { hermesActivityStore } from "../../lib/hermes-activity-store";
import { hermesArtifactStore } from "../../lib/hermes-artifact-store";
import { localGenerationOptionId } from "../../lib/local-generation";
import {
  rememberSessionThinkingLevel,
  saveThinkingLevel,
  thinkingEffortForLevel,
  type ThinkingLevel,
} from "../../lib/thinking-level";
import { messageFromError } from "../../lib/errors";
import {
  parseSlashFileArguments,
  resolveSlashModel,
  slashModelResolutionError,
} from "../../lib/agent-composer-slash-commands";
import { type ComposerEditorHandle, stripPlaceholder } from "./composer/ComposerEditor";
import { type NoteReferenceInput } from "./composer/noteReference";
import { sessionUnrestricted } from "../../lib/agent-session-modes";
import { type AgentChatPart, type AgentChatTurn } from "../../lib/agent-chat-runtime";
import { ProjectContextSignatureStore } from "../../lib/agent-project-context";
import { type AgentChatGallerySection } from "../../lib/agent-chat-gallery";
import { attachScrollThumbFade } from "../../lib/scroll-thumb-fade";
import type { AgentWorkspaceProps } from "./agent-workspace-types";
import { useAgentGalleryEvents } from "./use-agent-gallery-events";
import { useTaskHydration } from "./use-task-hydration";
import { useSessionListBroadcast } from "./use-session-list-broadcast";
import { createSessionRefreshAction } from "./session-refresh-action";
import { useAgentGatewayActions } from "./use-agent-gateway-actions";
import { useAgentViewState } from "./use-agent-view-state";
import { useAgentChatPresentation } from "./use-agent-chat-presentation";
import { useAgentModelSelection } from "./use-agent-model-selection";
import { createComposerDispatchActions } from "./composer-dispatch-actions";
import { createIssueReportStateActions } from "./issue-report-state-actions";
import { createAttachmentImportActions } from "./attachment-import-actions";
import { createQueuedFollowUpRenderers } from "./queued-follow-up-renderers";
import { useAgentSessionLoading } from "./use-agent-session-loading";
import { useAgentSelection } from "./use-agent-selection";
import { useAgentRuntimeState } from "./use-agent-runtime-state";
import { useAgentCoreState } from "./use-agent-core-state";
import { createPendingImageActions } from "./pending-image-actions";
import { createIssueReportActions } from "./issue-report-actions";
import { createComposerFileEvents } from "./composer/composer-file-events";
import { createComposerPreparation } from "./composer/composer-preparation";
import { renderAgentWorkspaceLayout } from "./AgentWorkspaceLayout";
import { AgentDetailContent } from "./AgentDetailContent";
import { renderAgentComposer } from "./composer/AgentComposer";
import { useAgentHeroHandoff } from "./use-agent-hero-handoff";
import { useAgentHeroRotation } from "./use-agent-hero-rotation";
import { useAgentTranscriptScroll } from "./use-agent-transcript-scroll";
import { useAgentDropEvents } from "./use-agent-drop-events";
import { useAgentProfileEvents } from "./use-agent-profile-events";
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
export type { AgentWorkspaceOrigin } from "./agent-workspace-types";
export { SkillsToolsPanel } from "./management/SkillsToolsPanel";
export {
  envFieldSet,
  meaningfulCapabilityStatus,
  messagingTrimEdits,
  stateLabel,
} from "./management/management-helpers";
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

import { type AgentWorkspaceError } from "./agent-workspace-errors";
export { agentWorkspaceErrorStateForMessage } from "./agent-workspace-errors";

import {
  imageSlashTurnsBySessionFromStored,
  removeStoredImageSlashSession,
  removeStoredVideoSlashSession,
  storedVideoSlashTurns,
  videoSlashTurnsBySessionFromStored,
} from "./composer/media-slash-persistence";
import { type CapturedSessionModelTarget } from "./composer/follow-up-queue";

import {
  persistedReviewableIssueReports,
  rememberComposerDraft,
  type AgentSessionTitleSource,
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
    workingReconcileStreaksRef,
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

  const {
    setReviewableIssueReport,
    setIssueReportDiagnosisRefreshing,
    queueIssueReportDiagnosisRefresh,
    waitForIssueReportDiagnosisRefresh,
    promotePendingIssueReportToReview,
    setIssueReportSubmitting,
  } = createIssueReportStateActions({
    deferredFailedIssueReportDeliverySessionIdsRef,
    diagnosisRefreshIssueReportSessionIdsRef,
    issueReportDiagnosisRefreshesRef,
    pendingIssueReportsRef,
    refreshHermesSession,
    reviewableIssueReportsRef,
    setDiagnosisRefreshIssueReportSessionIds,
    setReviewableIssueReports,
    setSubmittingIssueReportSessionIds,
    submittingIssueReportSessionIdsRef,
  });

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

  const composerDictationRequestRef = useRef<{
    id: string;
    draftKey: string | null;
    active: boolean;
  } | null>(null);
  const composerDeliveryIpcRef = useRef(Promise.resolve());
  const queueComposerDeliveryCommand = useCallback(
    (command: Parameters<typeof dictationHelperCommand>[0]) => {
      const pending = composerDeliveryIpcRef.current.then(() => dictationHelperCommand(command));
      composerDeliveryIpcRef.current = pending.catch(() => {});
      return pending;
    },
    [],
  );
  const registerComposerDelivery = useCallback(() => {
    if (
      !isWindowsPlatform() ||
      composerDictationRequestRef.current ||
      !composerEditorRef.current?.isFocused()
    ) {
      return;
    }
    const registration = {
      id: crypto.randomUUID(),
      draftKey: composerDraftKeyRef.current,
      active: false,
    };
    composerDictationRequestRef.current = registration;
    void queueComposerDeliveryCommand({
      type: "register_composer_delivery",
      composerRequestId: registration.id,
    }).catch(() => {
      if (composerDictationRequestRef.current === registration) {
        composerDictationRequestRef.current = null;
      }
    });
  }, [composerDraftKeyRef, composerEditorRef, queueComposerDeliveryCommand]);
  const releaseComposerDelivery = useCallback(
    (registration = composerDictationRequestRef.current) => {
      if (!registration) return;
      if (composerDictationRequestRef.current === registration) {
        composerDictationRequestRef.current = null;
      }
      if (!registration.active) {
        void queueComposerDeliveryCommand({
          type: "unregister_composer_delivery",
          composerRequestId: registration.id,
        }).catch(() => {});
      }
    },
    [queueComposerDeliveryCommand],
  );
  const handleComposerFocusChange = useCallback(
    (focused: boolean) => {
      if (focused) {
        registerComposerDelivery();
        return;
      }
      const registration = composerDictationRequestRef.current;
      if (registration && !registration.active) releaseComposerDelivery(registration);
    },
    [registerComposerDelivery, releaseComposerDelivery],
  );
  useEffect(() => {
    const registration = composerDictationRequestRef.current;
    if (!registration || registration.active || registration.draftKey === composerDraftKey) return;
    releaseComposerDelivery(registration);
    window.queueMicrotask(registerComposerDelivery);
  }, [composerDraftKey, registerComposerDelivery, releaseComposerDelivery]);

  useEffect(() => {
    if (!isWindowsPlatform()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<unknown>("dictation-event", (event) => {
      const helperEvent = parseDictationHelperEvent(event.payload);
      if (!helperEvent) return;
      const payload = helperEvent.payload;
      if (
        helperEvent.type === "listening_started" &&
        typeof payload?.composerRequestId === "string" &&
        composerDictationRequestRef.current?.id === payload.composerRequestId
      ) {
        composerDictationRequestRef.current.active = true;
      }
      if (
        helperEvent.type !== "final_transcript" ||
        payload?.delivery !== "agent_composer" ||
        typeof payload.composerRequestId !== "string"
      ) {
        if (helperEvent.type === "helper_unavailable") {
          releaseComposerDelivery();
          window.queueMicrotask(registerComposerDelivery);
        } else if (
          (helperEvent.type === "recording_discarded" ||
            helperEvent.type === "paste_completed" ||
            helperEvent.type === "error") &&
          payload?.delivery === "agent_composer" &&
          typeof payload.composerRequestId === "string" &&
          composerDictationRequestRef.current?.id === payload.composerRequestId
        ) {
          composerDictationRequestRef.current = null;
          window.queueMicrotask(registerComposerDelivery);
        }
        return;
      }
      const armed = composerDictationRequestRef.current;
      if (!armed || armed.id !== payload.composerRequestId) return;
      composerDictationRequestRef.current = null;
      const editor = composerEditorRef.current;
      const inserted =
        typeof payload.text === "string" &&
        composerDraftKeyRef.current === armed.draftKey &&
        !!editor &&
        editor.insertPlainText(payload.text);
      void dictationHelperCommand({
        type: "composer_delivery_result",
        composerRequestId: armed.id,
        inserted,
      })
        .catch(() => {})
        .finally(registerComposerDelivery);
    }).then((remove) => {
      if (disposed) remove();
      else unlisten = remove;
    });
    return () => {
      disposed = true;
      unlisten?.();
      releaseComposerDelivery();
    };
  }, [composerDraftKeyRef, composerEditorRef, registerComposerDelivery, releaseComposerDelivery]);

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
  useLayoutEffect(() => {
    const shell = document.querySelector(".app-shell");
    // Safe today because renderAppLayout's shell className is stable while the
    // agent view owns this workspace: switching views unmounts us, and note
    // chat cannot open here. If agent-local state ever changes that className,
    // lift this flag into renderAppLayout instead of keeping the side channel.
    shell?.classList.toggle("app-shell-artifact-panel-open", artifactPanelOpen);
    return () => shell?.classList.remove("app-shell-artifact-panel-open");
  }, [artifactPanelOpen]);

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

  let stopHermesSessionImplementation: ReturnType<
    typeof createTaskControlActions
  >["stopHermesSession"];
  function stopHermesSession(
    ...args: Parameters<ReturnType<typeof createTaskControlActions>["stopHermesSession"]>
  ) {
    return stopHermesSessionImplementation(...args);
  }

  // New-session hero: greeting + centered composer + suggestion chips, shown
  // whenever nothing is selected — the same condition as the conversation
  // fall-through in the render, minus the dev gallery. Computed up here
  // because the composer auto-grow effect below needs it as a dependency.
  const {
    heroMode,
    composerInSteerState,
    selectedSteerCards,
    visibleFollowUpQueueKey,
    selectedQueuedAttachmentFollowUps,
    selectedUpNextDemoFollowUps,
    selectedFollowUpCount,
    visibleErrorState,
    visibleError,
    visibleErrorRetryable,
    unsupportedNotice,
    titleForPendingSession,
    ACTIVITY_DRAWER_ENABLED,
    activityDrawerOpen,
    setActivityDrawerOpen,
    activityStatus,
    openSessionFromDrawer,
    steerSessionFromDrawer,
    activeAgentCount,
    modelForActivitySession,
    timelineArtifacts,
    rawTraceSession,
    setRawTraceSession,
    visibleIssueReportReview,
    visibleIssueReportHasUnsentContext,
    visibleIssueReportImportingFiles,
    prevHeroModeRef,
    hasFollowUps,
  } = useAgentViewState({
    activityStoreVersion,
    agentScrollRef,
    attachMenuOpen,
    attachMenuRef,
    attachTriggerRef,
    attachments,
    composerEditorRef,
    composerInSteerStateFor,
    composerModelFlyout,
    composerModelFromSlash,
    composerModelOpen,
    composerModelPopoverRef,
    composerModelRootSearchRef,
    composerModelSearchRef,
    composerModelTriggerRef,
    composerSteerDemo,
    draft,
    errorState,
    fullModeDraftRef,
    gallerySections,
    hermesSessionItems,
    heroGreetingConsumedRef,
    importingFiles,
    modelRootSearch,
    newSessionMode,
    newSessionModeRef,
    queuedAttachmentFollowUps,
    reviewableIssueReports,
    sandboxFirstItemRef,
    sandboxMenuOpen,
    sandboxMenuRef,
    sandboxMenuWasOpenRef,
    sandboxTriggerRef,
    selectedHermesSessionId,
    selectedHermesSessionIdRef,
    selectedHermesSessionIsProvisional,
    selectedTask,
    setActivePanel,
    setAttachMenuOpen,
    setConfirmUnrestricted,
    setComposerModelFlyout,
    setComposerModelOpen,
    setFullModeDraft,
    setHeroGreeting,
    setModelRootSearch,
    setModelSearch,
    setNewSessionMode,
    setSandboxMenuOpen,
    setSelectedHermesSessionId,
    setSelectedTaskId,
    steerCardsBySessionId,
    submitting,
    submittingHermesSessionId,
    submittingIssueReportSessionIds,
    upNextDemoFollowUpsBySessionId,
    visibleAgentWorkspaceError,
    workingSessionIds,
  });
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

  let applySessionTitleOverridesImplementation: ReturnType<
    typeof createSessionTitleActions
  >["applySessionTitleOverrides"];
  const applySessionTitleOverrides: ReturnType<
    typeof createSessionTitleActions
  >["applySessionTitleOverrides"] = (...args) => applySessionTitleOverridesImplementation(...args);
  let composerDispatchActionsImplementation: ReturnType<typeof createComposerDispatchActions>;
  function cancelComposerDispatch(
    ...args: Parameters<ReturnType<typeof createComposerDispatchActions>["cancelComposerDispatch"]>
  ) {
    return composerDispatchActionsImplementation.cancelComposerDispatch(...args);
  }
  function composerDispatchWasInvalidated(
    ...args: Parameters<
      ReturnType<typeof createComposerDispatchActions>["composerDispatchWasInvalidated"]
    >
  ) {
    return composerDispatchActionsImplementation.composerDispatchWasInvalidated(...args);
  }
  function invalidateSessionComposerDispatches(
    ...args: Parameters<
      ReturnType<typeof createComposerDispatchActions>["invalidateSessionComposerDispatches"]
    >
  ) {
    return composerDispatchActionsImplementation.invalidateSessionComposerDispatches(...args);
  }
  let startBridgeImplementation: ReturnType<typeof createGatewayRecoveryActions>["startBridge"];
  function startBridge(
    ...args: Parameters<ReturnType<typeof createGatewayRecoveryActions>["startBridge"]>
  ) {
    return startBridgeImplementation(...args);
  }
  let ensureHermesGatewayImplementation: ReturnType<
    typeof useAgentGatewayActions
  >["ensureHermesGateway"];
  function ensureHermesGateway(
    ...args: Parameters<ReturnType<typeof useAgentGatewayActions>["ensureHermesGateway"]>
  ) {
    return ensureHermesGatewayImplementation(...args);
  }
  const refreshHermesSessionImplementation = {} as {
    current: (sessionId: string) => Promise<HermesSessionMessage[] | undefined>;
  };
  async function refreshHermesSession(sessionId: string) {
    return refreshHermesSessionImplementation.current(sessionId);
  }

  // Updates the task list without touching the selection — a late poll
  // response must not re-select a task the user already navigated away from.
  // Selection changes only where user intent exists (load, explicit click).
  const { upsertTask, loadTasks, loadHermesSessions } = useAgentSessionLoading({
    activeHermesProfile,
    applySessionTitleOverrides,
    bridge,
    defaultGenerationModelIdRef,
    hermesSessionItemsRef,
    hermesSessionsHydratedRef,
    newSessionModeRef,
    pendingHermesMessagesRef,
    profileOwnedSessionIdsRef,
    restoredHermesSessionIdRef,
    selectedHermesSessionIdRef,
    selectedTask,
    setError,
    setHermesSessionItems,
    setHermesSessionsHydrated,
    setHermesSessionsLoading,
    setLoading,
    setSelectedHermesSessionId,
    setSelectedTaskId,
    setTasks,
    waitingSessionIdsRef,
    workingSessionIdsRef,
  });

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  // Reflects a provider/model settings change into the composer state: the
  // active provider, the saved local endpoint, and the pill selection (the
  // synthetic local option when local is active). Shared by the mount fetch
  // and the model-switch handler so both stay in lockstep with the backend.
  const {
    loadGenerationModel,
    commitSessionModelSelections,
    captureSessionModelTarget,
    openComposerModelPicker,
    saveGenerationSelection,
    handleCostQualityChange,
    handleSelectGenerationModel,
  } = useAgentModelSelection({
    MODEL_SWITCH_TOAST_ID,
    activeGenerationCostQuality,
    confirmedCostQualityRef,
    costQualitySaveChainRef,
    defaultGenerationModelId,
    defaultGenerationModelIdRef,
    generationCostQualityRef,
    generationCostQuality,
    generationModelsRef,
    generationSelectionId,
    generationSelectionIntentRevisionRef,
    generationSelectionSaveChainRef,
    hermesSessionItemsRef,
    latestCostQualitySaveRef,
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
    setGenerationCostQuality,
    setGenerationModels,
    setHermesSessionItems,
    setLocalGeneration,
    setError,
    setModelRootSearch,
    setModelSearch,
    setSandboxMenuOpen,
    setSessionModelSelections,
    setVeniceApiKeyConfigured,
    veniceApiKeyConfiguredRef,
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

  useSessionListBroadcast({
    hermesSessionItems,
    hermesSessionsHydrated,
    selectedHermesSessionId,
    waitingSessionIds,
    workingSessionIds,
  });

  // Message-based reconciliation above can only END a run when an assistant
  // reply eventually persists. A run that died without one (provider failure,
  // gateway drop, app quit mid-turn) — or a session wrongly resumed as
  // working from a trailing user message — would otherwise stay "working"
  // forever, leaving the menu bar stuck on "Working…". The gateway's
  // session.active_list is ground truth for what is actually running, so any
  // locally-working session absent from it (or sitting idle) for the original
  // five-second tolerance gets its activity cleared. The tolerance covers a
  // just-submitted prompt racing runtime-session registration.
  const {
    cancelAgentRunSettlement,
    hasAutomaticContinuation,
    watchCompletedAgentRunSettle,
    reconcileWorkingSessionsAgainstRuntime,
  } = createRuntimeReconciliation({
    hermesSessionItems,
    pendingAttachmentPreparationsRef,
    pendingSteerBySessionIdRef,
    queuedAttachmentFollowUpsRef,
    recordSessionErrorActivity,
    refreshHermesSession,
    runtimeSessionIdsRef,
    setError,
    workingReconcileStreaksRef,
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
  const sessionTitleActions = createSessionTitleActions({
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
  applySessionTitleOverridesImplementation = sessionTitleActions.applySessionTitleOverrides;
  const {
    applyManualHermesSessionTitleLocally,
    renameHermesSession,
    removeHermesSessionLocally,
    deleteSelectedHermesSession,
    applyInitialSessionTitleSuggestion,
    clearBackgroundSessionTitleGuard,
    suggestTitleForUntitledSession,
  } = sessionTitleActions;

  let attachmentImportActionsImplementation: ReturnType<typeof createAttachmentImportActions>;
  function addReportDialogAttachments(
    ...args: Parameters<
      ReturnType<typeof createAttachmentImportActions>["addReportDialogAttachments"]
    >
  ) {
    return attachmentImportActionsImplementation.addReportDialogAttachments(...args);
  }
  function importDroppedFilePaths(
    ...args: Parameters<ReturnType<typeof createAttachmentImportActions>["importDroppedFilePaths"]>
  ) {
    return attachmentImportActionsImplementation.importDroppedFilePaths(...args);
  }
  function importDroppedFiles(
    ...args: Parameters<ReturnType<typeof createAttachmentImportActions>["importDroppedFiles"]>
  ) {
    return attachmentImportActionsImplementation.importDroppedFiles(...args);
  }
  function importPastedImageFiles(
    ...args: Parameters<ReturnType<typeof createAttachmentImportActions>["importPastedImageFiles"]>
  ) {
    return attachmentImportActionsImplementation.importPastedImageFiles(...args);
  }

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

  useTaskHydration({
    hydratedTaskIdsRef,
    selectedTaskId,
    setError,
    setTasks,
    taskHistoryLoadedIdsRef,
    tasks,
  });

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

  // One process-wide active-list poll per mode is shared with run settlement.
  // Gateway events render live message deltas, while bounded missing-row and
  // unreachable-snapshot streaks trigger native persisted-history recovery.
  // biome-ignore lint/correctness/useExhaustiveDependencies: subscription ownership follows mode membership; the render-local reconciler reads current refs, and resubscribing every render would force extra immediate snapshots.
  useEffect(() => {
    for (const sessionId of workingReconcileStreaksRef.current.keys()) {
      if (!workingSessionIds.has(sessionId)) {
        workingReconcileStreaksRef.current.delete(sessionId);
      }
    }
    if (!bridge.running || workingSessionIds.size === 0) return;
    const modes = new Set(
      Array.from(workingSessionIds, (sessionId) => sessionUnrestricted(sessionId)),
    );
    const unsubscribe = [...modes].map((fullMode) =>
      subscribeHermesActiveSessionSnapshots(fullMode, (snapshot) => {
        void reconcileWorkingSessionsAgainstRuntime(snapshot);
      }),
    );
    return () => {
      for (const remove of unsubscribe) remove();
    };
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

  composerDispatchActionsImplementation = createComposerDispatchActions({
    activeComposerDispatchReservationsRef,
    completedAgentRunAwaitingAttachmentPreparationRef,
    continueAfterCompletedAgentRun,
    imageSafeModeConsentRequestRef,
    invalidatedComposerDispatchReservationsRef,
    pendingAttachmentPreparationsRef,
    resolveImageSafeModeConsent,
  });
  const {
    reserveComposerDispatch,
    forgetComposerDispatch,
    beginAttachmentPreparation,
    finishAttachmentPreparation,
  } = composerDispatchActionsImplementation;

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

  attachmentImportActionsImplementation = createAttachmentImportActions({
    agentAttachmentFromImportedFile,
    composerEditorRef,
    creditActionsDisabledReason,
    loadFilesystemSnapshot,
    setComposerAttachments,
    setError,
    setImportingFiles,
    setReportDialogAttachments,
  });
  const { removeAttachment, pickAttachments } = attachmentImportActionsImplementation;
  async function startDictation() {
    if (creditActionsDisabledReason) {
      setError(creditActionsDisabledReason);
      return;
    }
    composerEditorRef.current?.focus();
    const existingRequest = composerDictationRequestRef.current;
    const armedRequest =
      isWindowsPlatform() && existingRequest
        ? existingRequest
        : isWindowsPlatform()
          ? { id: crypto.randomUUID(), draftKey: composerDraftKeyRef.current, active: false }
          : null;
    if (armedRequest) composerDictationRequestRef.current = armedRequest;
    try {
      await queueComposerDeliveryCommand({
        type: "toggle_listening",
        shortcut: "Dictation",
        ...(armedRequest ? { composerRequestId: armedRequest.id } : {}),
      });
    } catch (err) {
      if (composerDictationRequestRef.current === armedRequest) {
        releaseComposerDelivery(armedRequest);
        window.queueMicrotask(registerComposerDelivery);
      }
      setError(messageFromError(err));
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
  const agentGatewayActions = useAgentGatewayActions({
    bridge,
    gatewayCloseHandlerRef,
    gatewaysRef,
    projectContextSignaturesBySessionId,
    runtimeSessionIdsRef,
    setRuntimeSessionIds,
    startBridge,
  });
  ensureHermesGatewayImplementation = agentGatewayActions.ensureHermesGateway;
  const { fetchSessionUsage, compressSessionContext } = agentGatewayActions;

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
    applyInitialSessionTitleSuggestion,
    applyThinkingLevelToSession,
    attachHermesSessionEventListener,
    attachPendingImages,
    captureSessionModelTarget,
    clearBackgroundSessionTitleGuard,
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

  const gatewayRecoveryActions = createGatewayRecoveryActions({
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
  startBridgeImplementation = gatewayRecoveryActions.startBridge;
  const { retryUpstreamProviderFailure, retryGatewayConnection, recoverFromGatewayClose } =
    gatewayRecoveryActions;

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

  const { refreshHermesSessionImplementationBody } = createSessionRefreshAction({
    clearSessionActivity,
    continueAfterCompletedAgentRun,
    hermesSessionItems,
    hermesSessionMessagesRef,
    listSessionMessagesOrdered,
    liveEventsRef,
    loadHermesSessions,
    pendingHermesMessagesRef,
    promotePendingIssueReportToReview,
    releaseAllComputerUseRuns,
    setError,
    setHermesSessionMessages,
    setLiveEvents,
    setPendingHermesMessages,
    suggestTitleForUntitledSession,
    waitingSessionIdsRef,
    workingSessionIdsRef,
  });
  refreshHermesSessionImplementation.current = refreshHermesSessionImplementationBody;

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
  const { renderSteerCard, renderQueuedAttachmentFollowUp } = createQueuedFollowUpRenderers({
    attachments,
    composerEditorRef,
    deliverQueuedAttachmentFollowUp,
    draft,
    draftRef,
    editQueuedAttachmentFollowUp,
    queuedAttachmentFollowUpsRef,
    removeQueuedAttachmentFollowUp,
    setDraft,
    setUpNextDemoFollowUpsBySessionId,
    workingSessionIds,
  });

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

  const taskControlActions = createTaskControlActions({
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
  });
  stopHermesSessionImplementation = taskControlActions.stopHermesSession;
  const { cancelTask, stopHermesSubagent, retryTask } = taskControlActions;

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
  useAgentGalleryEvents({
    setGalleryErrors,
    setGallerySections,
  });

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
  const {
    hermesTurns,
    upstreamFailureRecoveryIds,
    taskTurns,
    turnArtifacts,
    activeThinkingKey,
    thinkingOpen,
    setThinkingOpen,
    surfacedArtifacts,
    downloadArtifact,
    openArtifact,
    downloadGeneratedImage,
    openGeneratedImage,
    downloadGeneratedVideo,
    openTimelineArtifact,
  } = useAgentChatPresentation({
    DOWNLOAD_TOAST_ID,
    chatArtifacts,
    devArtifacts,
    imageTurnsBySession,
    liveEvents,
    selectedHermesMessages,
    selectedHermesSessionId,
    selectedHermesSessionIdRef,
    selectedTask,
    setArtifactPanel,
    setError,
    setThinkingOpenByKey,
    thinkingOpenByKey,
    videoTurnsBySession,
  });

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
    onComposerFocusChange: handleComposerFocusChange,
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

  const detailContent = (
    <AgentDetailContent
      {...{
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
      }}
    />
  );

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
import { agentComposerClearance, chatTurnsSignature } from "./chat-turns/TranscriptViews";
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
export { generatedImagePathAliases } from "./composer/composer-input-helpers";
import {
  agentActivityCountsFromStore,
  agentStatusFromHermesEvent,
  agentStatusSummaryFromHermesEvent,
} from "./session-state-helpers";
export {
  projectAgentActivityLevels,
  type AgentActivityLevelProjection,
} from "./session-state-helpers";
import { omitRecordKey } from "./agent-workspace-support";
import { forgetLastOpenSessionId, writeLastOpenSessionId } from "./session-persistence";
export {
  markAgentNewSessionPending,
  pendingNewSessionRequest,
  type AgentNewSessionDetail,
} from "./session-persistence";
