import { listen } from "@tauri-apps/api/event";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconBolt } from "central-icons/IconBolt";
import { IconBubble3 } from "central-icons/IconBubble3";
import { IconBubbleWide } from "central-icons/IconBubbleWide";
import { IconCheckmark2Small } from "central-icons/IconCheckmark2Small";
import { IconExclamationTriangle } from "central-icons/IconExclamationTriangle";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconStopCircle } from "central-icons/IconStopCircle";
import { IconToolbox } from "central-icons/IconToolbox";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { createPortal } from "react-dom";
import { IconArrowCornerDownRight } from "central-icons/IconArrowCornerDownRight";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconFiles } from "central-icons/IconFiles";
import { IconFileText } from "central-icons/IconFileText";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconPencil } from "central-icons/IconPencil";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconShieldCrossed } from "central-icons/IconShieldCrossed";
import { IconStop } from "central-icons/IconStop";
import { DotSpinner } from "../DotSpinner";
import {
  type CSSProperties,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Dialog } from "../ui/Dialog";
import { toast } from "../ui/Toaster";
import { Spinner } from "../ui/Spinner";
import {
  assignSessionToProfile,
  listSessionProfiles,
  cancelAgentTask,
  computerUseBeginRun,
  computerUseEndRun,
  computerUseStop,
  dictationHelperCommand,
  finalizeHermesBridgeBranch,
  getAgentTask,
  getHermesBridgeSkill,
  ensureHermesBridgeSession,
  hermesBridgeFilesystemSnapshot,
  hermesBridgeImageDataUrl,
  hermesBridgeMessagingPlatforms,
  hermesAgentCliAccess,
  hermesBrowserAccess,
  hermesBridgeSkills,
  generateImage,
  primeGeneratedVideoDir,
  hermesBridgeStatus,
  hermesBridgeToolsets,
  importHermesBridgeFile,
  importHermesBridgeFileBytes,
  listVeniceModels,
  listAgentTasks,
  downloadHermesBridgeFile,
  openHermesTuiDebug,
  osAccountsUpgrade,
  providerModelSettings,
  registerBrowserExtensionHost,
  retryAgentTask,
  imagePromptMayBeExplicit,
  revealPath,
  setHermesAgentCliAccess,
  setHermesBrowserAccess,
  setImageSafeMode,
  setImageSafeModePromptDismissed,
  setLocalGenerationEnabled,
  setCostQuality,
  setVeniceModel,
  startHermesBridge,
  submitIssueReport,
  toggleHermesBridgeSkill,
  toggleHermesBridgeToolset,
  updateHermesBridgeMessagingPlatform,
  videoGenerate,
  videoStatus,
  type AgentTaskDto,
  type AgentTaskStatus,
  type HermesBridgeStatus,
  type HermesFilesystemSnapshot,
  type ImportedHermesFile,
  type HermesMessagingPlatformInfo,
  type HermesSessionInfo,
  type HermesSessionMessage,
  type HermesSkillInfo,
  type HermesToolsetInfo,
  type LocalGenerationSettingsDto,
  type ProviderModelSettingsDto,
  type VeniceModelDto,
  type PendingBrowserApproval,
  browserApprovalRespond,
  browserApprovalsPending,
} from "../../lib/tauri";
import {
  deleteHermesSession,
  listHermesSessionMessages,
  listHermesSessions,
  titleFromPrompt,
} from "../../lib/hermes-adapter";
import {
  getActiveHermesProfileName,
  refreshActiveHermesProfile,
  useActiveHermesProfile,
} from "../../lib/active-hermes-profile";
import {
  filterAgentSessionsForProfile,
  sessionMatchesProfile,
  sessionProfileMap,
} from "../../lib/session-profile-filter";
import {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_GALLERY_EVENT,
  AGENT_NEW_SESSION_EVENT,
  dispatchAgentSessionsChanged,
  dispatchAgentSessionStatus,
  type AgentGalleryDetail,
  type AgentSessionStatusKind,
} from "../../lib/agent-events";
import {
  cancelAgentRunMonitoring,
  markAgentRunSucceeded,
  releaseAgentRunSettlement,
  startAgentRunMonitoring,
} from "../../lib/agent-run-monitor";
import {
  HermesGatewayClient,
  isSessionBusyError,
  type HermesGatewayEvent,
} from "../../lib/hermes-gateway";
import {
  classifyHermesEvent,
  createHermesMethods,
  hermesModeFor,
  isTerminalHermesEvent,
  isHermesFeatureSupported,
  type HermesMode,
  type JuneHermesEvent,
} from "../../lib/hermes-control-plane";
import {
  attachImageToSession,
  attachmentStateFrom,
  pendingImageAttachments,
  type HermesAttachmentState,
} from "../../lib/hermes-image-attach";
import { parseSessionUsage, type SessionUsage } from "../../lib/hermes-session-usage";
import {
  rememberSessionExchangeTitled,
  rememberSessionManuallyTitled,
  rememberSessionTitleRejected,
  sessionSettledTitleKind,
} from "../../lib/agent-session-titles";
import {
  parseCompressSessionResult,
  type CompressSessionResult,
} from "../../lib/hermes-session-compress";
import {
  isBranchableMessageId,
  parseBranchSessionResult,
  type BranchSessionResult,
} from "../../lib/hermes-session-branch";
import { normalizeSteerText } from "../../lib/hermes-session-steer";
import { buildSessionPayload } from "../../lib/share-payload";
import { ShareDialog } from "../share/ShareDialog";
import { recordPositiveFeedbackSent } from "../../lib/referral-nudge";
import { useScrollFade } from "../../lib/use-scroll-fade";
import { unsupportedEventStore } from "../../lib/hermes-unsupported-events";
import { shouldBlockTextOnFunding, type TextFundingModelContext } from "../../lib/account-gate";
import { pendingActionStore } from "../../lib/hermes-pending-actions";
import { hermesActivityStore } from "../../lib/hermes-activity-store";
import {
  hermesArtifactStore,
  // The store's record shape collides by name with this file's local
  // `AgentArtifact` (the file-viewer card), so alias it.
  type AgentArtifact as TimelineArtifact,
} from "../../lib/hermes-artifact-store";
import { AgentThinking } from "./AgentThinking";
import { SessionUsagePanel } from "./SessionUsagePanel";
import { useUsagePanelDemo } from "../../lib/usage-panel-demo";
import { AgentActivityDrawer, AgentArtifactsSection } from "./AgentActivityDrawer";
import { hermesTraceBuffer } from "../../lib/hermes-trace-buffer";
import { UnsupportedEventNotice } from "./UnsupportedEventNotice";
import { HermesTracePanel } from "./HermesTracePanel";
import { ComposerModelPicker, PrivacyModeBadge, heroPrivacyFootnote } from "./composer/ModelPicker";
import {
  PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
  dispatchProviderModelSettingsChanged,
  modelPrivacyBadge,
  modelSupportsImageInput,
  modelSupportsTools,
  type ProviderModelSettingsChangedDetail,
} from "../../lib/model-privacy";
import {
  MODEL_SWITCH_NEXT_MESSAGE_NOTICE,
  MODEL_SWITCH_DEFAULT_ONLY_NOTICE,
} from "../../lib/hermes-model-switch";
import { applySessionModelWhenIdle } from "../../lib/hermes-next-prompt-model";
import {
  reserveHermesSessionDispatch,
  type HermesSessionDispatchReservation,
} from "../../lib/hermes-session-dispatch-mutex";
import {
  decodeHermesModelSelection,
  forgetSessionModelSelection,
  hasPendingSessionModelSelection,
  hermesModelIdForSelection,
  markSessionModelSelectionApplied,
  migrateSessionModelSelection,
  readSessionModelSelections,
  rememberAppliedSessionModelSelection,
  stageSessionModelSelection,
  subscribeSessionModelSelections,
  type SessionModelSelection,
  type SessionModelSelectionMap,
} from "../../lib/hermes-session-model-selection";
import {
  LOCAL_GENERATION_OPTION_ID_PREFIX,
  isLoopbackUrl,
  localGenerationOptionId,
  unavailableLocalGenerationOption,
  withLocalGenerationOption,
} from "../../lib/local-generation";
import { autoPillDesignation, preferredVisionFallbackModel } from "../../lib/suggested-models";
import {
  forgetSessionThinkingLevel,
  loadThinkingLevel,
  loadSessionThinkingLevels,
  rememberSessionThinkingLevel,
  saveThinkingLevel,
  thinkingEffortForLevel,
  thinkingLevelForEffort,
  type ThinkingLevel,
} from "../../lib/thinking-level";
import {
  AUTO_MODEL_ID,
  modelOptions,
  selectedModel as selectedModelOption,
} from "../settings/ModelPickerDialog";
import { ModelPickerPopover, type ModelPickerFlyout } from "../settings/ModelPickerPopover";
import {
  HERMES_SERVER_ERROR_MESSAGE,
  describeHermesError,
  isHermesSessionsStartupRequestError,
  isTopUpRequiresMaxError,
  messageFromError,
} from "../../lib/errors";
import { clipboardImageFiles } from "../../lib/clipboard-files";
import { withTimeout } from "../../lib/async-timeout";
import {
  MESSAGING_PLATFORMS_LOAD_TIMEOUT_MESSAGE,
  MESSAGING_PLATFORMS_LOAD_TIMEOUT_MS,
} from "../../lib/hermes-messaging";
import { categoryPrompt } from "../../lib/issue-report-prompt";
import {
  explicitSkillInvocationPrompt,
  isPathLikeSlashToken,
  parseSkillSlashCommands,
  parseSkillSlashCommandTokens,
  resolveSkillSlashCommands,
  skillDocumentLookupName,
  skillSlashResolutionError,
} from "../../lib/skill-slash-commands";
import {
  isBuiltinComposerSlashCommand,
  parseBuiltinComposerSlashCommand,
  parseSlashFileArguments,
  resolveSlashModel,
  slashModelResolutionError,
} from "../../lib/agent-composer-slash-commands";
import { generateChatImage, newImageRequestId } from "../../lib/chat-image-generation";
import {
  generateChatVideo,
  newVideoRequestId,
  pollChatVideo,
} from "../../lib/chat-video-generation";
import { IMAGE_GENERATION_ENABLED, VIDEO_GENERATION_ENABLED } from "../../lib/feature-flags";
import { ImageSafeModeConsentDialog } from "./ImageSafeModeConsentDialog";
import { VideoSafeModeConsentDialog } from "./VideoSafeModeConsentDialog";
import {
  ComposerEditor,
  type ComposerEditorHandle,
  stripPlaceholder,
} from "./composer/ComposerEditor";
import { noteReferenceToken, type NoteReferenceInput } from "./composer/noteReference";
import { CategoryIcon } from "./composer/CategoryIcon";
import {
  ISSUE_REPORT_ATTACHMENTS_ONLY_DESCRIPTION,
  REPORT_CATEGORIES,
  type ReportCategory,
} from "./composer/reportCategory";
import { ReportDialog, type ReportDialogAttachment } from "./ReportDialog";
import { hermesConnectionForMode } from "../../lib/hermes-connection";
import {
  forgetSessionMode,
  rememberSessionMode,
  sessionUnrestricted,
} from "../../lib/agent-session-modes";
import { hermesTuiDebugAvailable } from "../../lib/hermes-tui-debug";
import { AGENT_CLI_ACCESS_ENABLED_MESSAGE } from "../../lib/agent-cli-access";
import { BROWSER_ACCESS_ENABLED_MESSAGE } from "../../lib/browser-access";
import {
  appendHermesLiveEvent,
  buildAgentChatTurns,
  buildHermesSessionChatTurns,
  UPSTREAM_PROVIDER_FAILURE_RETRY_PROMPT,
  type AgentApprovalChoice,
  type AgentChatPart,
  type AgentChatTurn,
} from "../../lib/agent-chat-runtime";
import {
  COMPACTED_CONTEXT_SIGNATURE,
  prepareProjectPrompt,
  ProjectContextSignatureStore,
} from "../../lib/agent-project-context";
import {
  buildAgentChatGallery,
  buildAgentErrorGallery,
  type AgentChatGallerySection,
} from "../../lib/agent-chat-gallery";
import { attachScrollThumbFade } from "../../lib/scroll-thumb-fade";
import type { AgentWorkspaceProps } from "./agent-workspace-types";
import { createSubmitHermesSession } from "./session-submission";
import { createSubmitComposer } from "./composer/submit-composer";
import type { AgentAttachment } from "./agent-workspace-models";
export type { AgentWorkspaceOrigin } from "./agent-workspace-types";
import { AgentSessionBar } from "./chat-turns/AgentSessionBar";
export { SkillsToolsPanel } from "./management/SkillsToolsPanel";
export {
  envFieldSet,
  meaningfulCapabilityStatus,
  messagingTrimEdits,
  stateLabel,
} from "./management/management-helpers";
import {
  upstreamProviderRecoveryIds,
  upstreamProviderRecoveryStore,
} from "../../lib/upstream-provider-recovery";
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
  AGENT_STREAM_DEMO_EVENT,
  COMPOSER_STEER_DEMO_EVENT,
  SAMPLE_MARKDOWN,
  STREAM_DEMO_SECTION_LABEL,
  buildSampleArtifactFiles,
  composerSteerDemoDesired,
  galleryDesired,
  sampleImageDataUrl,
  setComposerSteerDemoDesired,
  setGalleryDesired,
  streamDemoDesired,
  type AgentStreamDemoDetail,
} from "./agent-dev-tools";
import {
  AGENT_SHORTCUTS,
  AGENT_SESSION_RENAMED_EVENT,
  HERO_CHIP_SWAP_MS,
  HERO_ROTATE_MS,
  HERO_SHORTCUT_COUNT,
  SANDBOX_OPTIONS,
  advanceHeroGreeting,
  isProvisionalHermesSessionId,
  makeProvisionalHermesSessionId,
  rememberUnrestrictedAcknowledged,
  shuffleAgentShortcuts,
  unrestrictedAcknowledged,
  type AgentPanel,
  type AgentSessionRenamedDetail,
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

import type {
  ImageSafeModeConsentChoice,
  ImageSafeModeConsentEventPayload,
  ImageSafeModeConsentRequest,
} from "./agent-workspace-models";

import {
  GATEWAY_CONNECTION_ERROR,
  SESSION_GONE_MESSAGE,
  SESSION_NOT_AVAILABLE_MESSAGE,
  agentWorkspaceErrorStateForMessage,
  isSessionGoneError,
  reportableAgentErrorOptions,
  type AgentWorkspaceError,
  type AgentWorkspaceErrorOptions,
} from "./agent-workspace-errors";
export { agentWorkspaceErrorStateForMessage } from "./agent-workspace-errors";

type AgentDeleteSessionDetail = {
  sessionId: string;
};

import {
  AttachBlockedError,
  filenameFromWorkspacePath,
  imageSlashTurnsBySessionFromStored,
  markStoredImageSlashTurnsAttached,
  markStoredVideoSlashContextsSent,
  promptSubmitContentWithFastPathImageContext,
  removeStoredImageSlashSession,
  removeStoredVideoSlashSession,
  removeStoredVideoSlashTurn,
  runningImageSlashTurns,
  runningVideoSlashTurns,
  storedPendingImageSlashAttachments,
  storedPendingVideoSlashContexts,
  storedVideoSlashTurns,
  uniqueAttachmentsByWorkspacePath,
  upsertStoredImageSlashTurn,
  upsertStoredVideoSlashTurn,
  videoSlashTurnsBySessionFromStored,
  withVideoFastPathContext,
  type PersistedVideoSlashTurn,
} from "./composer/media-slash-persistence";
import {
  buildUpNextDemoFollowUps,
  sameSessionModelSelection,
  type CapturedSessionModelTarget,
  type PendingAttachmentPreparation,
  type PendingSteer,
  type PreparedComposerSubmission,
  type QueuedAttachmentFollowUp,
} from "./composer/follow-up-queue";

import {
  appendIssueReportFollowUp,
  captureSessionContinuity,
  clearAgentSessionContinuity,
  dispatchIssueReportDeliverySettled,
  dispatchIssueReportFollowUpSubmitFailed,
  issueReportDescription,
  issueReportSentMessage,
  messageAfterIssueReportDiagnosisBoundary,
  moveComposerDraft,
  forgetComposerDraft,
  persistReviewableIssueReports,
  persistedReviewableIssueReports,
  readAgentSessionContinuity,
  readComposerDraft,
  rememberComposerDraft,
  sessionComposerDraftKey,
  shouldOpenNewSessionOnMount,
  writeAgentSessionContinuity,
  ISSUE_REPORT_DELIVERY_SETTLED_EVENT,
  ISSUE_REPORT_DIAGNOSIS_REFRESH_TIMEOUT_MS,
  ISSUE_REPORT_FOLLOW_UP_SUBMIT_FAILED_EVENT,
  NEW_SESSION_DRAFT_KEY,
  NEW_SESSION_RECOVERY_QUEUE_KEY,
  type AgentSessionTitleSource,
  type FileBytesImportOptions,
  type HermesRuntimeSessionResponse,
  type IssueReportDeliverySettledDetail,
  type IssueReportDeliveryResult,
  type IssueReportFollowUpSubmitFailedDetail,
  type TauriFileDropPayload,
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
  const initialSessionId = initialSession?.id ?? initialSessionIdProp;
  const activeHermesProfile = useActiveHermesProfile();
  // Read once per mount (lazy initializer): the continuity snapshot the
  // previous mount captured on unmount, if any session was still mid-run.
  const [continuity] = useState(readAgentSessionContinuity);
  const [tasks, setTasks] = useState<AgentTaskDto[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [activePanel, setActivePanel] = useState<AgentPanel>("chat");
  const [draft, setDraft] = useState("");
  // The message's single category tag, mirrored from a restored legacy chip.
  // New reports use the direct popover instead; the server creates the
  // team-facing diagnosis there because no model runs on the client.
  const [category, setCategory] = useState<ReportCategory | null>(null);
  // Live mirror of `draft` for closures (the hero-chip interval) that must read
  // the current value without re-subscribing.
  const draftRef = useRef("");
  const categoryRef = useRef<ReportCategory | null>(null);
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const attachmentsRef = useRef<AgentAttachment[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [importingFiles, setImportingFiles] = useState(false);
  // Reuses the importingFiles busy-gating (set alongside it); this flag only
  // tailors the composer placeholder copy while an image is generating.
  const [generatingImage, setGeneratingImage] = useState(false);
  const [generatingVideo, setGeneratingVideo] = useState(false);
  // Dev-only: window.__composerSteerDemo() parks the composer in the working
  // branch so the stop/steer-send interaction can be iterated without a turn.
  const [composerSteerDemo, setComposerSteerDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // `submitting` gates the whole composer, while this id scopes the immediate
  // Stop visual to the existing session that owns the in-flight send.
  const [submittingHermesSessionId, setSubmittingHermesSessionId] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<AgentWorkspaceError | null>(null);
  const [submittingErrorIssueReport, setSubmittingErrorIssueReport] = useState(false);
  const [composerSizeWarning, setComposerSizeWarning] = useState<ComposerInputSizeWarning | null>(
    null,
  );
  const [imageSafeModeConsentRequest, setImageSafeModeConsentRequest] =
    useState<ImageSafeModeConsentRequest | null>(null);
  const [browserApprovals, setBrowserApprovals] = useState<PendingBrowserApproval[]>([]);
  const [browserApprovalSubmitting, setBrowserApprovalSubmitting] = useState<string>();
  const imageSafeModeConsentRequestRef = useRef<ImageSafeModeConsentRequest | null>(null);
  const composerSizeProceedSignatureRef = useRef<string | null>(null);
  const composerSizeProceedInputSignatureRef = useRef<string | null>(null);
  // Feature 07: the fork lifecycle (creating → branched) is surfaced as a
  // toast — a loading toast while the branch is created, resolving into a
  // "Branched from …" confirmation. See branchFromMessage.
  // Which message a branch is currently in flight for, so its action shows a
  // disabled/working state and double-clicks can't fork twice.
  const [branchingMessageId, setBranchingMessageId] = useState<string | null>(null);
  const branchingMessageIdRef = useRef<string | null>(null);
  const [bridge, setBridge] = useState<HermesBridgeStatus>({
    running: false,
  });
  const [bridgeStarting, setBridgeStarting] = useState(false);
  // Opt-in for the session being composed in the hero: start the runtime
  // without the OS sandbox. Read through a ref inside the async submit path.
  const [fullModeDraft, setFullModeDraft] = useState(false);
  const fullModeDraftRef = useRef(false);
  const [sandboxMenuOpen, setSandboxMenuOpen] = useState(false);
  // Codex-style speed bump: picking Unrestricted from the menu confirms in a
  // dialog before arming, instead of a persistent warning line.
  const [confirmUnrestricted, setConfirmUnrestricted] = useState(false);
  const sandboxTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sandboxMenuRef = useRef<HTMLDivElement | null>(null);
  const sandboxFirstItemRef = useRef<HTMLButtonElement | null>(null);
  const sandboxMenuWasOpenRef = useRef(false);
  // The "+" popover: attach files, reference a note, or open the report form.
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const attachTriggerRef = useRef<HTMLButtonElement | null>(null);
  const attachMenuRef = useRef<HTMLDivElement | null>(null);
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [reportDialogCategory, setReportDialogCategory] = useState<ReportCategory>("bug");
  const [reportDialogDescription, setReportDialogDescription] = useState("");
  const [reportDialogAttachments, setReportDialogAttachments] = useState<ReportDialogAttachment[]>(
    [],
  );
  // Bumped when a report is sent; see reportDialogAppendForCurrentGeneration.
  const reportDialogGenerationRef = useRef(0);
  const [hermesSessionItems, setHermesSessionItems] = useState<HermesSessionInfo[]>(() => {
    const restored = continuity?.sessionItems ?? [];
    if (!initialSession) return restored;
    return [initialSession, ...restored.filter((session) => session.id !== initialSession.id)];
  });
  const hermesSessionItemsRef = useRef(hermesSessionItems);
  const profileOwnedSessionIdsRef = useRef<Set<string>>(
    new Set(
      initialSessionId && getActiveHermesProfileName() !== "default" ? [initialSessionId] : [],
    ),
  );
  // False until the first listHermesSessions fetch lands. Until then the
  // items above only hold the mount seed (the clicked session, or nothing),
  // and broadcasting that would wipe the sidebar's already-loaded list.
  const [hermesSessionsHydrated, setHermesSessionsHydrated] = useState(false);
  const hermesSessionsHydratedRef = useRef(false);
  // Mounting without an explicit target restores the last open conversation,
  // so app restarts and dev reloads land the user back in the session they
  // were working in instead of bouncing them to the newest one. A pending
  // new-session marker or saved new-session draft overrides the restore: the
  // marker path prevents a stale selected-session broadcast from dropping
  // pending project context, while the draft path keeps unsent hero text
  // visible after a view switch or reload.
  const [startInNewSessionMode] = useState(
    () => !initialSessionId && shouldOpenNewSessionOnMount(),
  );
  // A last-open id is only a restore candidate until the first profile-scoped
  // session load proves that it belongs to the active profile. Keeping it out
  // of selected state prevents the message loader from reading another
  // profile's conversation during that validation window.
  const restoredHermesSessionIdRef = useRef<string | undefined>(
    initialSessionId || startInNewSessionMode ? undefined : readLastOpenSessionId(),
  );
  const [selectedHermesSessionId, setSelectedHermesSessionId] = useState<string | undefined>(
    initialSessionId,
  );
  const selectedHermesSessionIdRef = useRef<string | undefined>(selectedHermesSessionId);
  const lastAutoSubmittedRef = useRef<{ prompt: string; at: number }>();
  const [newSessionMode, setNewSessionMode] = useState(startInNewSessionMode);
  const setError = useCallback(
    (message: string | null, options: AgentWorkspaceErrorOptions = {}) => {
      if (!message) {
        setErrorState(null);
        return;
      }
      const sessionId =
        options.sessionId === undefined
          ? (selectedHermesSessionIdRef.current ?? null)
          : options.sessionId;
      const nextError = agentWorkspaceErrorStateForMessage(message, sessionId, options.issueReport);
      if (!nextError) {
        return;
      }
      setErrorState(nextError);
    },
    [],
  );

  const refreshBrowserApprovals = useCallback(async () => {
    try {
      setBrowserApprovals(await browserApprovalsPending());
    } catch {
      // The broker may not be configured until a runtime starts. Its change
      // event will retry once an attended action parks.
    }
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void refreshBrowserApprovals();
    const interval = window.setInterval(() => void refreshBrowserApprovals(), 5_000);
    void listen(BROWSER_APPROVALS_CHANGED_EVENT, () => void refreshBrowserApprovals()).then(
      (cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      },
    );
    return () => {
      disposed = true;
      window.clearInterval(interval);
      unlisten?.();
    };
  }, [refreshBrowserApprovals]);

  const respondToBrowserApproval = useCallback(
    async (approvalId: string, approve: boolean, allowSite = false) => {
      setBrowserApprovalSubmitting(approvalId);
      try {
        await browserApprovalRespond({ approvalId, approve, allowSite });
      } catch (error) {
        setError(messageFromError(error));
      } finally {
        setBrowserApprovalSubmitting(undefined);
        void refreshBrowserApprovals();
      }
    },
    [refreshBrowserApprovals, setError],
  );
  const handleTopUp = useCallback(() => {
    const result = onTopUp ? onTopUp() : osAccountsUpgrade();
    void Promise.resolve(result).catch((err: unknown) => {
      // A top-up that the backend gates behind Max must never surface as a raw
      // error; point the user at the upgrade path instead.
      if (isTopUpRequiresMaxError(err)) {
        setError("Upgrade to Max to keep using credits.");
        return;
      }
      setError(messageFromError(err));
    });
  }, [onTopUp, setError]);
  const clearErrorForSession = useCallback((sessionId: string) => {
    setErrorState((current) => (current?.sessionId === sessionId ? null : current));
  }, []);
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
  const pendingFastPathImagesRef = useRef<Record<string, AgentAttachment[]>>({});
  // Per-session ordering for message fetches: the sequence handed out at
  // fetch start, and the highest sequence whose response was applied. See
  // listSessionMessagesOrdered.
  const sessionMessagesFetchSeqRef = useRef<Map<string, number>>(new Map());
  const sessionMessagesAppliedSeqRef = useRef<Map<string, number>>(new Map());
  const [hermesSessionsLoading, setHermesSessionsLoading] = useState(false);
  const [liveEvents, setLiveEvents] = useState<Record<string, JuneHermesEvent[]>>(
    () => continuity?.liveEvents ?? {},
  );
  const [thinkingOpenByKey, setThinkingOpenByKey] = useState<Record<string, boolean>>({});
  const [workingTaskIds, setWorkingTaskIds] = useState<Set<string>>(() => new Set());
  const activityStoreVersion = useSyncExternalStore(
    hermesActivityStore.subscribe,
    hermesActivityStore.getVersion,
    hermesActivityStore.getVersion,
  );
  const activityRecords = useMemo(
    () => hermesActivityStore.getRecords(),
    // `activityStoreVersion` is the change signal; the read returns live rows.
    [activityStoreVersion],
  );
  const previousActivityLevelsRef = useRef<AgentActivityLevelProjection | undefined>(undefined);
  const activityLevels = useMemo(() => {
    const next = projectAgentActivityLevels(activityRecords, previousActivityLevelsRef.current);
    previousActivityLevelsRef.current = next;
    return next;
  }, [activityRecords]);
  const { toolCallSessionIds, waitingSessionIds, workingSessionIds } = activityLevels;
  const workingSessionIdsRef = useRef<Set<string>>(workingSessionIds);
  const toolCallSessionIdsRef = useRef<Set<string>>(toolCallSessionIds);
  // Steers we've sent that Hermes may not have delivered yet. Hermes only
  // injects a steer into the next tool result, so a no-tool turn drops it; we
  // track the text and resend it as a follow-up on completion when no tool
  // consumed it (cleared on a tool.complete or a clean terminal).
  const pendingSteerBySessionIdRef = useRef<Record<string, PendingSteer[]>>({});
  // Reservations owned by composer work that has not yet transferred into a
  // durable follow-up row. Unmount cancels these so a suspended consent or
  // preparation promise cannot wedge the module-global session FIFO.
  const activeComposerDispatchReservationsRef = useRef(
    new Map<HermesSessionDispatchReservation, string>(),
  );
  const invalidatedComposerDispatchReservationsRef = useRef(
    new WeakSet<HermesSessionDispatchReservation>(),
  );
  // Steer cards: injected instructions tacked to the top of the composer while
  // June works. They are a read-only presentation of instructions already
  // submitted to Hermes, not a cancellable staging queue. The pending ref
  // retains delivery tracking until the turn ends or is stopped.
  const [steerCardsBySessionId, setSteerCardsBySessionId] = useState<
    Record<string, { id: string; text: string }[]>
  >({});
  const steerCardSeqRef = useRef(0);
  const [queuedAttachmentFollowUps, setQueuedAttachmentFollowUps] = useState<
    Record<string, QueuedAttachmentFollowUp[]>
  >(() =>
    Object.fromEntries(
      Object.entries(continuity?.queuedAttachmentFollowUps ?? {}).map(([sessionId, items]) => [
        sessionId,
        items.map((item) =>
          item.status === "sending"
            ? {
                ...item,
                dispatchReservation: undefined,
                status: "failed" as const,
                error: "Delivery was interrupted. Try again.",
              }
            : item,
        ),
      ]),
    ),
  );
  const queuedAttachmentFollowUpsRef = useRef(queuedAttachmentFollowUps);
  // Attachment preparation can finish out of Send order. A completed agent
  // run must not advance a materialized later row while an earlier accepted
  // Send is still preparing off-queue.
  const pendingAttachmentPreparationsRef = useRef<
    Record<string, Map<number, PendingAttachmentPreparation>>
  >({});
  const completedAgentRunAwaitingAttachmentPreparationRef = useRef(new Set<string>());
  const computerUseRunLeasesRef = useRef(new Map<string, Set<string>>());
  const [upNextDemoFollowUpsBySessionId, setUpNextDemoFollowUpsBySessionId] = useState<
    Record<string, QueuedAttachmentFollowUp[]>
  >({});
  const queuedAttachmentFollowUpSeqRef = useRef(
    Object.values(continuity?.queuedAttachmentFollowUps ?? {}).reduce(
      (highest, items) =>
        items.reduce((itemHighest, item) => {
          const sequence = Number(item.id.match(/^attachment-follow-up-(\d+)$/)?.[1] ?? 0);
          return Math.max(itemHighest, sequence);
        }, highest),
      0,
    ),
  );
  const composerDispatchOrderRef = useRef(
    Object.values(continuity?.queuedAttachmentFollowUps ?? {}).reduce(
      (highest, items) =>
        items.reduce(
          (itemHighest, item) => Math.max(itemHighest, item.dispatchOrder ?? 0),
          highest,
        ),
      0,
    ),
  );
  // Completion is observable through the live gateway and both message-refresh
  // paths. Only one of them may advance queued follow-ups for a finished agent
  // run. Gateway listeners carry a unique source token: duplicate terminal
  // frames from one listener are ignored, while a terminal frame from the
  // follow-up being submitted is remembered until the current queue mutation
  // finishes.
  const continuingCompletedAgentRunSourcesRef = useRef(new Map<string, symbol | undefined>());
  const pendingCompletedAgentRunSourcesRef = useRef(new Map<string, symbol>());
  // The steer queue shows all rows by default; the header collapses the list
  // to itself. Reset (back open) per session below.
  const [steerQueueOpen, setSteerQueueOpen] = useState(true);
  // Fade for the expanded stack's capped scroller (spec/scroll-fade.md).
  const steerCardsListRef = useRef<HTMLDivElement | null>(null);
  const steerCardsFade = useScrollFade(steerCardsListRef);
  const waitingSessionIdsRef = useRef<Set<string>>(waitingSessionIds);
  const [runtimeSessionIds, setRuntimeSessionIds] = useState<Record<string, string>>(
    () => continuity?.runtimeSessionIds ?? {},
  );
  const runtimeSessionIdsRef = useRef(runtimeSessionIds);
  // Consecutive runtime-reconcile polls in which a locally-working session was
  // absent from the gateway's live list. Cleared the moment it's seen live.
  const workingReconcileMissesRef = useRef(new Map<string, number>());
  const [stoppingSessionIds, setStoppingSessionIds] = useState<ReadonlySet<string>>(new Set());
  const [skills, setSkills] = useState<HermesSkillInfo[] | null>(null);
  const skillCommandsLoadRef = useRef<Promise<HermesSkillInfo[]> | null>(null);
  const [toolsets, setToolsets] = useState<HermesToolsetInfo[] | null>(null);
  const [messagingPlatforms, setMessagingPlatforms] = useState<
    HermesMessagingPlatformInfo[] | null
  >(null);
  // The text-model catalog backs both the global default for new chats and
  // each chat's stored model. A selection missing from the catalog still
  // shows as a name-only stub so the pill never goes blank while configured.
  const [defaultGenerationModelId, setDefaultGenerationModelId] = useState("");
  const [generationCostQuality, setGenerationCostQuality] = useState<number | undefined>();
  // Mirrors the saved Venice API key's presence so the model picker's Auto
  // section can show its billing note (Auto meters June credits, never the
  // key). Refreshed with every provider-settings read.
  const [veniceApiKeyConfigured, setVeniceApiKeyConfigured] = useState(false);
  const veniceApiKeyConfiguredRef = useRef(false);
  // Preference saves from the picker's drill-in: writes are chained so they
  // persist in click order, and versioned so only the newest call's outcome
  // touches the UI (mirrors Settings' saveCostQuality discipline). Rollback
  // targets the last CONFIRMED value (persisted read or successful save) —
  // never an optimistic value a still-in-flight click painted.
  const costQualitySaveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const latestCostQualitySaveRef = useRef(0);
  const confirmedCostQualityRef = useRef<number | undefined>(undefined);
  const defaultGenerationModelIdRef = useRef("");
  const generationCostQualityRef = useRef<number | undefined>();
  const generationSelectionIntentRevisionRef = useRef(0);
  const generationSelectionSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  // Existing sessions own a durable desired selection. A picker change writes
  // this map synchronously but never touches the live Hermes agent; submit
  // snapshots one revision and applies it only before the next prompt. Keeping
  // applied entries also preserves Auto's per-session designation across app
  // restarts, which the Hermes session row cannot represent on its own.
  const [sessionModelSelections, setSessionModelSelections] = useState<SessionModelSelectionMap>(
    readSessionModelSelections,
  );
  const sessionModelSelectionsRef = useRef(sessionModelSelections);
  useEffect(
    () =>
      subscribeSessionModelSelections((next) => {
        sessionModelSelectionsRef.current = next;
        setSessionModelSelections(next);
      }),
    [],
  );
  const [generationModels, setGenerationModels] = useState<VeniceModelDto[]>([]);
  const generationModelsRef = useRef<VeniceModelDto[]>([]);
  // Bring-your-own local text generation. When the global provider is "local"
  // the model catalog carries a synthetic "Local: <id>" option and the pill
  // resolves to it, so the composer never shows a raw local id or silently
  // reverts the app to metered remote generation. Kept as refs too because the
  // async provider-selection handler reads the latest values.
  const [localGeneration, setLocalGeneration] = useState<LocalGenerationSettingsDto>({
    baseUrl: "",
    modelId: "",
    apiKey: "",
  });
  const localGenerationRef = useRef(localGeneration);
  // Two-step confirm for enabling a NON-loopback local endpoint from the
  // composer (requests would leave the device, so no path may enable one
  // silently — Settings has the same invariant with its "Enable anyway"
  // affordance). Holds the exact base URL the warning was shown for: a second
  // selection only proceeds while the saved URL still matches, so editing the
  // endpoint in Settings re-arms the warning. Loopback endpoints never arm it.
  const localEnableConfirmArmedForRef = useRef<string | null>(null);
  const [composerModelOpen, setComposerModelOpen] = useState(false);
  // Whether the open picker was summoned by the /model slash command; it
  // drives search focus on open and Escape returning focus to the draft.
  const [composerModelFromSlash, setComposerModelFromSlash] = useState(false);
  const composerModelRootSearchRef = useRef<HTMLInputElement>(null);
  // The popover's root-layer query, independent of the All models flyout's
  // `modelSearch`: L2's box filters only its catalog list, and typing there
  // never flips the root layer into results mode.
  const [modelRootSearch, setModelRootSearch] = useState("");
  const [composerModelFlyout, setComposerModelFlyout] = useState<ModelPickerFlyout>(null);
  const [modelSearch, setModelSearch] = useState("");
  const composerModelTriggerRef = useRef<HTMLButtonElement>(null);
  const composerModelPopoverRef = useRef<HTMLDivElement>(null);
  const composerModelSearchRef = useRef<HTMLInputElement>(null);
  // Thinking level: how much June reasons before answering. The stored draft
  // seeds new sessions (session.create's reasoning_effort). The efforts map
  // records each session's OWN level — its creation pin, a pick made while
  // the session was open, or the effort its live runtime last reported via
  // session.info — persisted in localStorage so it survives relaunch; the
  // composer shows a session's own level, never the machine-wide draft of
  // whatever chat was retuned last. The applied map remembers which effort
  // the session's CURRENT runtime is known to be at (acked config.set, the
  // create pin, or a session.info report) so a turn only re-asserts when
  // the runtime or the level actually changed (config.set writes the profile
  // config each call, so it is not something to fire blindly on every send).
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() => loadThinkingLevel());
  const thinkingLevelRef = useRef(thinkingLevel);
  const sessionThinkingEffortsRef = useRef<Record<string, ThinkingLevel> | null>(null);
  // Lazy one-time load of the persisted per-session efforts (a ref, not
  // state: async send/pick closures must read the latest map, not a render
  // snapshot).
  function sessionThinkingEfforts(): Record<string, ThinkingLevel> {
    if (!sessionThinkingEffortsRef.current) {
      sessionThinkingEffortsRef.current = loadSessionThinkingLevels();
    }
    return sessionThinkingEffortsRef.current;
  }
  const sessionThinkingAppliedRef = useRef<Record<string, { runtimeId: string; effort: string }>>(
    {},
  );
  // Attestation walkthrough URL served by the backend (same page as Settings
  // → About → Verify server); the privacy badge links to it when known.
  const [capabilityQuery, setCapabilityQuery] = useState("");
  const [capabilityLoading, setCapabilityLoading] = useState(false);
  const [skillCommandLoading, setSkillCommandLoading] = useState(false);
  const [capabilitySaving, setCapabilitySaving] = useState<string | null>(null);
  const [selectedMessagingPlatformId, setSelectedMessagingPlatformId] = useState<string>();
  const [messagingEnvEdits, setMessagingEnvEdits] = useState<Record<string, string>>({});
  const [filesystemSnapshot, setFilesystemSnapshot] = useState<HermesFilesystemSnapshot | null>(
    null,
  );
  const [filesystemLoading, setFilesystemLoading] = useState(false);
  const [artifactPanel, setArtifactPanel] = useState<AgentArtifactPanelState | null>(null);
  // The session whose usage/cost panel is open, or null. Self-contained for
  // feature 09; feature 11's activity drawer will later host the same panel.
  const [usagePanelSessionId, setUsagePanelSessionId] = useState<string | null>(null);
  // Dev-only: __usageDemo("half") parks the usage overlay in a fixture state
  // regardless of the real session. Null in production because the command is
  // never registered. See lib/usage-panel-demo.ts.
  const usageDemo = useUsagePanelDemo();
  // The session whose context-compaction dialog is open, or null (feature 08).
  const [compactSessionId, setCompactSessionId] = useState<string | null>(null);
  // Session currently being shared through the private-sharing dialog
  // (JUN-308); only ever the selected session, set from the session bar menu.
  const [shareSessionId, setShareSessionId] = useState<string | null>(null);
  const [sessionShareUrl, setSessionShareUrl] = useState<string | null>(null);
  // The share payload snapshots the selected session's visible transcript,
  // so the dialog must never outlive its selection.
  useEffect(() => {
    setShareSessionId(null);
    setSessionShareUrl(null);
  }, [selectedHermesSessionId]);
  // Dev-only sample files seeded by window.__agentFiles — surfaced alongside
  // the conversation's own artifacts so the viewer can be exercised at will.
  const [devArtifacts, setDevArtifacts] = useState<AgentArtifact[]>([]);
  const [approvalSubmitting, setApprovalSubmitting] = useState<
    Partial<Record<string, AgentApprovalChoice>>
  >({});
  // Synchronous transport state for disconnect reconciliation. React state can
  // lag behind the socket close callback by one render, so it cannot tell us
  // reliably whether Hermes may already have accepted a response.
  const approvalResponsesInFlightRef = useRef(new Map<string, AgentApprovalChoice>());
  const [clarifySubmitting, setClarifySubmitting] = useState<Record<string, string>>({});
  // Shared across chat surfaces and component remounts for this app process.
  // reserve() closes the duplicate-click gap before React commits a render.
  useSyncExternalStore(
    upstreamProviderRecoveryStore.subscribe,
    upstreamProviderRecoveryStore.getVersion,
    upstreamProviderRecoveryStore.getVersion,
  );
  // Sudo records which choice (approve/deny) is in flight per request id;
  // secret records only that a submit is in flight (NEVER the value).
  const [sudoSubmitting, setSudoSubmitting] = useState<Record<string, "approve" | "deny">>({});
  const [secretSubmitting, setSecretSubmitting] = useState<Record<string, true>>({});
  // Whether "Agent CLI access" (Settings, Agent tab) is on — drives the
  // in-chat request card June can raise via its soul token. undefined until
  // the stored value loads, so a card never flashes the wrong state.
  const [cliAccessEnabled, setCliAccessEnabled] = useState<boolean>();
  const [cliAccessSubmitting, setCliAccessSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    hermesAgentCliAccess()
      .then((status) => {
        if (!cancelled) setCliAccessEnabled(status.enabled);
      })
      .catch(() => {
        // Unknown stays unknown; the card keeps its actionable default.
        if (!cancelled) setCliAccessEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // Whether "Browser use" (Settings, Agent tab) is on — the stored Browser
  // access grant behind June's in-chat request card. Same lifecycle as the
  // CLI access state above.
  const [browserAccessEnabled, setBrowserAccessEnabled] = useState<boolean>();
  const [browserAccessSubmitting, setBrowserAccessSubmitting] = useState(false);

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

  useEffect(() => {
    function onIssueReportDeliverySettled(event: Event) {
      const detail = (event as CustomEvent<IssueReportDeliverySettledDetail>).detail;
      if (!detail?.sessionId) return;
      setIssueReportSubmitting(detail.sessionId, false);
      if (detail.result.sent) {
        deferredFailedIssueReportDeliverySessionIdsRef.current.delete(detail.sessionId);
        if (reviewableIssueReportsRef.current[detail.sessionId] === detail.report) {
          setReviewableIssueReport(detail.sessionId, null);
        }
        return;
      }
      if (pendingIssueReportsRef.current.has(detail.sessionId)) {
        deferredFailedIssueReportDeliverySessionIdsRef.current.add(detail.sessionId);
      } else if (!reviewableIssueReportsRef.current[detail.sessionId]) {
        setReviewableIssueReport(detail.sessionId, detail.report);
      }
      setError(detail.result.errorMessage, { sessionId: detail.sessionId });
    }

    function onIssueReportFollowUpSubmitFailed(event: Event) {
      const detail = (event as CustomEvent<IssueReportFollowUpSubmitFailedDetail>).detail;
      if (!detail?.sessionId) return;
      if (pendingIssueReportsRef.current.get(detail.sessionId) === detail.queuedReport) {
        pendingIssueReportsRef.current.delete(detail.sessionId);
      }
      if (detail.restoreReport && !reviewableIssueReportsRef.current[detail.sessionId]) {
        setReviewableIssueReport(detail.sessionId, detail.restoreReport);
      }
    }

    window.addEventListener(ISSUE_REPORT_DELIVERY_SETTLED_EVENT, onIssueReportDeliverySettled);
    window.addEventListener(
      ISSUE_REPORT_FOLLOW_UP_SUBMIT_FAILED_EVENT,
      onIssueReportFollowUpSubmitFailed,
    );
    return () => {
      window.removeEventListener(ISSUE_REPORT_DELIVERY_SETTLED_EVENT, onIssueReportDeliverySettled);
      window.removeEventListener(
        ISSUE_REPORT_FOLLOW_UP_SUBMIT_FAILED_EVENT,
        onIssueReportFollowUpSubmitFailed,
      );
    };
  }, [setError]);

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

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId),
    [selectedTaskId, tasks],
  );
  const selectedHermesSession = useMemo(
    () => hermesSessionItems.find((session) => session.id === selectedHermesSessionId),
    [hermesSessionItems, selectedHermesSessionId],
  );
  useEffect(() => {
    if (selectedHermesSessionId && !selectedHermesSession) return;
    onSessionSelected?.(selectedHermesSession);
  }, [onSessionSelected, selectedHermesSession, selectedHermesSessionId]);
  const selectedHermesSessionIsProvisional = isProvisionalHermesSessionId(selectedHermesSessionId);
  const selectedSessionModelEntry =
    selectedHermesSessionId && !newSessionMode
      ? sessionModelSelections[selectedHermesSessionId]
      : undefined;
  const selectedSessionPersistedHermesModelId = selectedHermesSession?.model?.trim();
  const selectedSessionPersistedSelection = selectedSessionPersistedHermesModelId
    ? decodeHermesModelSelection(selectedSessionPersistedHermesModelId)
    : undefined;
  const selectedSessionModelSelection =
    selectedSessionModelEntry?.selection ?? selectedSessionPersistedSelection;
  // New session choices already carry explicit local/remote provenance. Only
  // an untagged legacy session needs the configured-model equality heuristic;
  // applying it to a tagged or durable remote choice would mislabel a remote
  // model as local when both catalogs expose the same raw id.
  const localOptionId =
    localGeneration.modelId.trim().length > 0
      ? localGenerationOptionId(localGeneration.modelId)
      : "";
  const sessionOrDefaultModelId =
    selectedHermesSessionId && !newSessionMode
      ? selectedSessionModelSelection?.modelId || defaultGenerationModelId
      : defaultGenerationModelId;
  const selectedLegacyRawLocalModel = Boolean(
    selectedHermesSessionId &&
      !newSessionMode &&
      !selectedSessionModelEntry &&
      selectedSessionPersistedHermesModelId &&
      !selectedSessionPersistedHermesModelId.startsWith("__june_") &&
      localOptionId &&
      selectedSessionPersistedHermesModelId === localGeneration.modelId.trim(),
  );
  const activeGenerationModelId = selectedLegacyRawLocalModel
    ? localOptionId
    : sessionOrDefaultModelId;
  const activeGenerationCostQuality =
    activeGenerationModelId === AUTO_MODEL_ID
      ? (selectedSessionModelSelection?.costQuality ?? generationCostQuality)
      : generationCostQuality;
  // Catalog surfaced in the composer picker: the remote models plus, when a
  // local endpoint is configured, the synthetic local option (even while
  // remote is active, so the user can switch to local from the composer).
  const generationModelOptions = useMemo(
    () => withLocalGenerationOption(generationModels, localGeneration),
    [generationModels, localGeneration],
  );
  const generationModel = useMemo(() => {
    if (!activeGenerationModelId) return undefined;
    const listed = generationModelOptions.some((model) => model.id === activeGenerationModelId);
    return listed
      ? selectedModelOption(generationModelOptions, activeGenerationModelId)
      : (unavailableLocalGenerationOption(activeGenerationModelId) ??
          selectedModelOption(generationModelOptions, activeGenerationModelId));
  }, [activeGenerationModelId, generationModelOptions]);
  const generationPrivacyBadge = generationModel ? modelPrivacyBadge(generationModel) : undefined;
  // The control shows the open session's OWN level (its creation pin, a pick
  // made while it was open, or what its runtime last reported) — never the
  // draft, which would label every chat with whatever level was picked last
  // anywhere. The draft only shows for a new session, where it applies.
  const composerThinkingLevel: ThinkingLevel =
    selectedHermesSessionId && !newSessionMode
      ? (sessionThinkingEfforts()[selectedHermesSessionId] ?? thinkingLevel)
      : thinkingLevel;
  // The model the image-attach banner offers to switch to: a vision + tool
  // capable model, preferring a known private vision pick (Kimi K2.6) over the
  // alphabetically-first vision model. See preferredVisionFallbackModel.
  const preferredVisionModel = useMemo(
    () => preferredVisionFallbackModel(generationModels),
    [generationModels],
  );
  // Maps a raw model id (as the usage payload reports it) to its catalog DTO for
  // the usage panel, so it can show both the display name and the privacy badge;
  // returns undefined when the id is unknown.
  const resolveModel = useCallback(
    (modelId: string) => generationModels.find((model) => model.id === modelId),
    [generationModels],
  );
  // Mirror the send-time fallback trigger (pendingImageAttachments +
  // !modelSupportsImageInput) so the banner appears exactly when a submit would
  // strip the image and downgrade to the text-only prompt. Resolve strictly via
  // find (not generationModel, which is a zero-capability stub for an unknown
  // id) so an unresolved/stale model stays silent rather than warning and being
  // treated as non-vision.
  const resolvedGenerationModel = activeGenerationModelId
    ? generationModels.find((model) => model.id === activeGenerationModelId)
    : undefined;
  const textFundingContext: TextFundingModelContext = {
    activeModelId: activeGenerationModelId || undefined,
    activeModel: resolvedGenerationModel,
    veniceApiKeyConfigured,
  };
  const textActionsDisabledReason = shouldBlockTextOnFunding(
    Boolean(creditActionsDisabledReason),
    textFundingContext,
  )
    ? creditActionsDisabledReason
    : undefined;
  const composerHasPendingImage =
    pendingImageAttachments(attachments.map((attachment) => attachment.attach)).length > 0;
  const parsedComposerSlashCommand = useMemo(
    () => parseBuiltinComposerSlashCommand(draft),
    [draft],
  );
  const imageSlashDraftActive =
    IMAGE_GENERATION_ENABLED && parsedComposerSlashCommand?.name === "image";
  const imageSlashBlockedByModel =
    imageSlashDraftActive &&
    !!resolvedGenerationModel &&
    !modelSupportsImageInput(resolvedGenerationModel);
  const showImageInputWarning =
    composerHasPendingImage &&
    !!resolvedGenerationModel &&
    !modelSupportsImageInput(resolvedGenerationModel);
  const showImageModelWarning = showImageInputWarning || imageSlashBlockedByModel;
  const imageModelWarningText = imageSlashBlockedByModel
    ? `${resolvedGenerationModel?.name ?? "This model"} can't read images. Switch to a vision model before using /image.`
    : `${resolvedGenerationModel?.name ?? "This model"} can't read images.`;
  const composerInputSignature = useMemo(
    () =>
      composerInputSignatureFor({
        message: draft.trim(),
        category,
        attachments,
        model: generationModel,
      }),
    [attachments, category, draft, generationModel],
  );
  const visibleComposerSizeWarning =
    composerSizeWarning?.inputSignature === composerInputSignature ? composerSizeWarning : null;
  const selectedHermesMessages = useMemo(() => {
    if (!selectedHermesSessionId) return [];
    return [
      ...(hermesSessionMessages[selectedHermesSessionId] ?? []),
      ...(pendingHermesMessages[selectedHermesSessionId] ?? []),
    ];
  }, [hermesSessionMessages, pendingHermesMessages, selectedHermesSessionId]);
  const composerDraftKey = selectedHermesSessionId
    ? sessionComposerDraftKey(selectedHermesSessionId)
    : selectedTask
      ? null
      : NEW_SESSION_DRAFT_KEY;
  const composerDraftKeyRef = useRef<string | null>(composerDraftKey);
  composerDraftKeyRef.current = composerDraftKey;
  const restoredComposerDraftKeyRef = useRef<string | null>();
  const chatArtifacts = useMemo(
    () => artifactsFromFilesystemSnapshot(filesystemSnapshot),
    [filesystemSnapshot],
  );

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

  useEffect(() => {
    if (!composerModelOpen) return;
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (composerModelPopoverRef.current?.contains(target)) return;
      if (composerModelTriggerRef.current?.contains(target)) return;
      // The hover detail cards are portaled to document.body, so a click inside
      // one (its "Show more" toggle) lands outside the popover — treat it as in.
      if (target instanceof Element && target.closest(".agent-composer-model-hovercard")) return;
      setComposerModelOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        // Escape peels one layer at a time: a nested model control or the
        // all-models panel first, then an active root query, then the popover.
        if (
          composerModelFlyout?.kind === "all" ||
          composerModelFlyout?.kind === "auto" ||
          composerModelFlyout?.kind === "effort"
        ) {
          setComposerModelFlyout(null);
          setModelSearch("");
        } else if (modelRootSearch) {
          setModelRootSearch("");
        } else {
          setComposerModelOpen(false);
          if (composerModelFromSlash) composerEditorRef.current?.focus();
        }
      }
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [composerModelFromSlash, composerModelOpen, composerModelFlyout, modelRootSearch]);

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

  function commitSessionModelSelections(next: SessionModelSelectionMap) {
    sessionModelSelectionsRef.current = next;
    setSessionModelSelections(next);
  }

  function storedSessionIdForComposerModelSelection() {
    const storedSessionId = selectedHermesSessionIdRef.current;
    return storedSessionId && !newSessionModeRef.current ? storedSessionId : undefined;
  }

  function queueComposerSessionModelSelection(
    storedSessionId: string,
    selection: SessionModelSelection,
  ) {
    commitSessionModelSelections(stageSessionModelSelection(storedSessionId, selection));
    setError(null);
    toast(MODEL_SWITCH_NEXT_MESSAGE_NOTICE, { id: MODEL_SWITCH_TOAST_ID });
  }

  function captureSessionModelTarget(
    explicitSession?: HermesSessionInfo,
  ): CapturedSessionModelTarget {
    const selectedStoredSessionId = selectedHermesSessionIdRef.current;
    const targetStoredSessionId = explicitSession?.id
      ? explicitSession.id
      : newSessionModeRef.current
        ? undefined
        : selectedStoredSessionId;
    const listedSession = targetStoredSessionId
      ? hermesSessionItemsRef.current.find((session) => session.id === targetStoredSessionId)
      : undefined;
    const existingHermesModelId =
      explicitSession?.model?.trim() || listedSession?.model?.trim() || undefined;
    const entry = targetStoredSessionId
      ? sessionModelSelectionsRef.current[targetStoredSessionId]
      : undefined;
    const inheritsProfileModel = Boolean(
      targetStoredSessionId &&
        profileOwnedSessionIdsRef.current.has(targetStoredSessionId) &&
        !entry,
    );
    let persistedSelection = existingHermesModelId
      ? decodeHermesModelSelection(existingHermesModelId)
      : undefined;
    const configuredLocalModelId = localGenerationRef.current.modelId.trim();
    if (
      existingHermesModelId &&
      !existingHermesModelId.startsWith("__june_") &&
      configuredLocalModelId &&
      existingHermesModelId === configuredLocalModelId
    ) {
      // Older June builds stored local sessions as an untagged raw id. Keep
      // treating an exact configured match as local while upgrading the
      // session to the collision-proof tagged form on its next Send.
      persistedSelection = { modelId: localGenerationOptionId(configuredLocalModelId) };
    }
    const fallbackModelId = targetStoredSessionId
      ? existingHermesModelId || (inheritsProfileModel ? "" : defaultGenerationModelIdRef.current)
      : defaultGenerationModelIdRef.current;
    const baseSelection: SessionModelSelection = entry?.selection ??
      persistedSelection ?? { modelId: fallbackModelId };
    const selection: SessionModelSelection =
      baseSelection.modelId === AUTO_MODEL_ID &&
      baseSelection.costQuality === undefined &&
      generationCostQualityRef.current !== undefined
        ? { ...baseSelection, costQuality: generationCostQualityRef.current }
        : baseSelection;
    const hermesModelId = selection.modelId ? hermesModelIdForSelection(selection) : "";
    return {
      targetStoredSessionId: targetStoredSessionId ?? null,
      existingHermesModelId,
      selection,
      hermesModelId,
      revision: entry?.revision,
      shouldApply: Boolean(
        targetStoredSessionId &&
          hermesModelId &&
          (hasPendingSessionModelSelection(entry) || existingHermesModelId !== hermesModelId),
      ),
      globalIntentRevision: generationSelectionIntentRevisionRef.current,
    };
  }

  // Stale catalog (the mount fetch can fail while the bridge is starting) is
  // refreshed in the background on every open, like Settings does.
  function openComposerModelPicker(fromSlash = false) {
    setModelSearch("");
    setModelRootSearch("");
    setComposerModelFlyout(null);
    setComposerModelFromSlash(fromSlash);
    setComposerModelOpen(true);
    setSandboxMenuOpen(false);
    void loadGenerationModel();
  }

  // Reflects the global generation selection into composer state directly (not
  // via the backend return value, which tests stub out): the remote flip and
  // the mount fetch already round-trip through commitGenerationSettings.
  function markRemoteGenerationSelected(modelId: string) {
    defaultGenerationModelIdRef.current = modelId;
    setDefaultGenerationModelId(modelId);
  }

  function saveGenerationSelection(write: () => Promise<unknown>): Promise<void> {
    const save = generationSelectionSaveChainRef.current.then(async () => {
      await write();
    });
    generationSelectionSaveChainRef.current = save.catch(() => undefined);
    return save;
  }

  async function selectLocalGeneration(options?: {
    keepOpen?: boolean;
    targetStoredSessionId?: string | null;
  }) {
    const localModelId = localGenerationRef.current.modelId.trim();
    const selectedModelId = localModelId ? localGenerationOptionId(localModelId) : "";
    // An off-device endpoint takes a deliberate second step, same invariant as
    // the Settings toggle: the first selection warns instead of enabling.
    // Loopback endpoints enable in one step.
    const baseUrl = localGenerationRef.current.baseUrl.trim();
    if (!isLoopbackUrl(baseUrl)) {
      if (localEnableConfirmArmedForRef.current !== baseUrl) {
        localEnableConfirmArmedForRef.current = baseUrl;
        toast.warning(
          "This endpoint is not on this machine. Requests will leave your device. Select the local model again to confirm.",
          { id: MODEL_SWITCH_TOAST_ID },
        );
        return false;
      }
      localEnableConfirmArmedForRef.current = null;
    }
    const storedSessionId =
      options && "targetStoredSessionId" in options
        ? (options.targetStoredSessionId ?? undefined)
        : storedSessionIdForComposerModelSelection();
    if (storedSessionId) {
      queueComposerSessionModelSelection(storedSessionId, { modelId: selectedModelId });
      return true;
    }
    const intentRevision = ++generationSelectionIntentRevisionRef.current;
    const previousModelId = defaultGenerationModelIdRef.current;
    generationModelRequestSequence.current += 1;
    defaultGenerationModelIdRef.current = selectedModelId;
    setDefaultGenerationModelId(selectedModelId);
    try {
      await saveGenerationSelection(() => setLocalGenerationEnabled(true));
      if (generationSelectionIntentRevisionRef.current === intentRevision) {
        dispatchProviderModelSettingsChanged({
          mode: "generation",
          modelId: selectedModelId,
        });
        setError(null);
      }
    } catch (err) {
      if (generationSelectionIntentRevisionRef.current === intentRevision) {
        defaultGenerationModelIdRef.current = previousModelId;
        setDefaultGenerationModelId(previousModelId);
        setError(messageFromError(err));
      }
      return false;
    }
    if (generationSelectionIntentRevisionRef.current === intentRevision) {
      toast(MODEL_SWITCH_DEFAULT_ONLY_NOTICE, { id: MODEL_SWITCH_TOAST_ID });
    }
    return true;
  }

  // The Auto section's Preference drill-in follows the same scope as model
  // selection: an existing session stages its next agent run, while the hero
  // updates the app-wide default for future sessions.
  function handleCostQualityChange(value: number) {
    const storedSessionId = storedSessionIdForComposerModelSelection();
    if (storedSessionId) {
      queueComposerSessionModelSelection(storedSessionId, {
        modelId: AUTO_MODEL_ID,
        costQuality: value,
      });
      return;
    }
    // Rapid preset clicks overlap: the chain keeps the writes ordered so the
    // last click is what persists, and the version gate makes sure only the
    // newest call's outcome (success or rollback) touches the UI — the same
    // discipline as Settings' saveCostQuality.
    const version = ++latestCostQualitySaveRef.current;
    generationCostQualityRef.current = value;
    setGenerationCostQuality(value);
    const save = costQualitySaveChainRef.current.then(() => setCostQuality(value));
    costQualitySaveChainRef.current = save.then(
      () => undefined,
      () => undefined,
    );
    void save.then(
      (next) => {
        confirmedCostQualityRef.current = next.costQuality;
        if (version !== latestCostQualitySaveRef.current) return;
        generationCostQualityRef.current = next.costQuality;
        setGenerationCostQuality(next.costQuality);
        dispatchProviderModelSettingsChanged({
          mode: "generation",
          modelId: defaultGenerationModelIdRef.current,
        });
        setError(null);
      },
      (err) => {
        if (version !== latestCostQualitySaveRef.current) return;
        generationCostQualityRef.current = confirmedCostQualityRef.current;
        setGenerationCostQuality(confirmedCostQualityRef.current);
        setError(messageFromError(err));
      },
    );
  }

  // A new-session choice updates the app-wide default. Once a session exists,
  // the same picker writes only that session's desired next-run selection;
  // Hermes is deliberately untouched until submit snapshots and applies it.
  async function handleSelectGenerationModel(
    modelId: string,
    costQuality?: number,
    options?: { keepOpen?: boolean; targetStoredSessionId?: string | null },
  ) {
    // The Auto toggle switches models mid-flow, so it asks to keep the picker
    // open; a row pick is a final choice and closes it.
    if (!options?.keepOpen) setComposerModelOpen(false);

    // Local is a synthetic catalog option (prefixed id), so it routes through
    // the provider switch rather than a remote model set.
    if (modelId.startsWith(LOCAL_GENERATION_OPTION_ID_PREFIX)) {
      return selectLocalGeneration(options);
    }
    // Picking anything else stands down a pending off-device confirm: the
    // next local selection warns afresh instead of enabling in one step.
    localEnableConfirmArmedForRef.current = null;

    const chosen = generationModelsRef.current.find((model) => model.id === modelId);
    // Defense in depth: the picker already hides tool-less models, but the
    // agent bricks without function calling, so refuse one rather than switch.
    if (chosen && !modelSupportsTools(chosen)) {
      setError(`${chosen.name} can't run June's tools, so it can't be used for the agent.`);
      return false;
    }
    const storedSessionId =
      options && "targetStoredSessionId" in options
        ? (options.targetStoredSessionId ?? undefined)
        : storedSessionIdForComposerModelSelection();
    if (storedSessionId) {
      const selectedCostQuality =
        modelId === AUTO_MODEL_ID
          ? (costQuality ?? activeGenerationCostQuality ?? generationCostQuality)
          : undefined;
      queueComposerSessionModelSelection(storedSessionId, {
        modelId,
        ...(selectedCostQuality !== undefined ? { costQuality: selectedCostQuality } : {}),
      });
      return true;
    }
    const selectedCostQuality =
      modelId === AUTO_MODEL_ID ? (costQuality ?? generationCostQualityRef.current) : undefined;
    const intentRevision = ++generationSelectionIntentRevisionRef.current;
    const previousModelId = defaultGenerationModelIdRef.current;
    const previousCostQuality = generationCostQualityRef.current;
    generationModelRequestSequence.current += 1;
    markRemoteGenerationSelected(modelId);
    if (selectedCostQuality !== undefined) {
      generationCostQualityRef.current = selectedCostQuality;
      setGenerationCostQuality(selectedCostQuality);
    }
    try {
      await saveGenerationSelection(async () => {
        if (selectedCostQuality !== undefined) {
          await setCostQuality(selectedCostQuality);
        }
        await setVeniceModel("generation", modelId);
      });
      if (generationSelectionIntentRevisionRef.current === intentRevision) {
        dispatchProviderModelSettingsChanged({ mode: "generation", modelId });
        setError(null);
      }
    } catch (err) {
      if (generationSelectionIntentRevisionRef.current === intentRevision) {
        defaultGenerationModelIdRef.current = previousModelId;
        setDefaultGenerationModelId(previousModelId);
        generationCostQualityRef.current = previousCostQuality;
        setGenerationCostQuality(previousCostQuality);
        setError(messageFromError(err));
      }
      return false;
    }
    if (generationSelectionIntentRevisionRef.current === intentRevision) {
      toast(MODEL_SWITCH_DEFAULT_ONLY_NOTICE, { id: MODEL_SWITCH_TOAST_ID });
    }
    return true;
  }

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

  useEffect(() => {
    function handleNewSession(event: Event) {
      const detail = (event as CustomEvent<AgentNewSessionDetail>).detail;
      void windowEventHandlersRef.current.startNewTask(detail);
    }

    function handleDeleteSession(event: Event) {
      const detail = (event as CustomEvent<AgentDeleteSessionDetail>).detail;
      if (!detail?.sessionId) return;
      windowEventHandlersRef.current.removeHermesSessionLocally(detail.sessionId);
    }

    function handleRenameSession(event: Event) {
      const detail = (event as CustomEvent<AgentSessionRenamedDetail>).detail;
      if (!detail?.sessionId) return;
      windowEventHandlersRef.current.applyManualHermesSessionTitleLocally(
        detail.sessionId,
        detail.title,
      );
    }

    const pending = pendingNewSessionRequest();
    if (pending) {
      void windowEventHandlersRef.current.startNewTask(pending, {
        deferSeed: true,
      });
    }

    window.addEventListener(AGENT_NEW_SESSION_EVENT, handleNewSession);
    window.addEventListener(AGENT_DELETE_SESSION_EVENT, handleDeleteSession);
    window.addEventListener(AGENT_SESSION_RENAMED_EVENT, handleRenameSession);
    return () => {
      window.removeEventListener(AGENT_NEW_SESSION_EVENT, handleNewSession);
      window.removeEventListener(AGENT_DELETE_SESSION_EVENT, handleDeleteSession);
      window.removeEventListener(AGENT_SESSION_RENAMED_EVENT, handleRenameSession);
    };
  }, []);

  useEffect(() => {
    if (!bridge.running || !hermesSessionsHydrated || !selectedHermesSessionId) return;
    if (isProvisionalHermesSessionId(selectedHermesSessionId)) return;
    let cancelled = false;
    listSessionMessagesOrdered(selectedHermesSessionId)
      .then((messages) => {
        if (cancelled || !messages) return;
        const retainedPending = retainUnpersistedPendingMessages(
          pendingHermesMessagesRef.current[selectedHermesSessionId] ?? [],
          messages,
        );
        setHermesSessionMessages((current) => {
          const next = {
            ...current,
            [selectedHermesSessionId]: messages,
          };
          hermesSessionMessagesRef.current = next;
          return next;
        });
        setPendingHermesMessages((current) => {
          const next = {
            ...current,
            [selectedHermesSessionId]: retainedPending,
          };
          pendingHermesMessagesRef.current = next;
          return next;
        });
        void suggestTitleForUntitledSession(selectedHermesSessionId, messages);
        const combined = [...messages, ...retainedPending];
        if (
          shouldResumeSessionActivity(combined) &&
          !waitingSessionIdsRef.current.has(selectedHermesSessionId)
        ) {
          // An in-flight run from before a remount or gateway drop: the
          // latest message is the user's, so re-arm working state — the
          // working-gated poll below picks the session back up and
          // reconciles it from persisted messages.
          recordSessionRunningActivity(selectedHermesSessionId);
        }
        if (sessionHasAssistantAfterLatestUser(combined)) {
          promotePendingIssueReportToReview(selectedHermesSessionId, {
            queueDiagnosisRefresh: false,
          });
          const wasActive = sessionHasActiveWork(
            selectedHermesSessionId,
            workingSessionIdsRef.current,
            waitingSessionIdsRef.current,
            liveEventsRef.current,
          );
          const activityCounts = clearSessionActivity(selectedHermesSessionId);
          if (wasActive) {
            dispatchAgentSessionStatus({
              sessionId: selectedHermesSessionId,
              title:
                hermesSessionItems.find((session) => session.id === selectedHermesSessionId)
                  ?.title ?? "Agent session",
              status: "completed",
              summary: "June finished.",
              ...activityCounts,
            });
            continueAfterCompletedAgentRun(selectedHermesSessionId);
          }
          liveEventsRef.current = {
            ...liveEventsRef.current,
            [selectedHermesSessionId]: [],
          };
          setLiveEvents(liveEventsRef.current);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = messageFromError(err);
        // A freshly created/migrated session can briefly 404 here before its
        // record is queryable over REST (the gateway creates it; visibility
        // lags a beat). That transient "Session not found" is benign — the
        // working-gated poll re-loads once it resolves — so don't flash it as
        // an error banner (JUN-116).
        if (isSessionGoneError(message)) return;
        setError(
          describeHermesError(err),
          reportableAgentErrorOptions(err, { sessionId: selectedHermesSessionId }),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [bridge.running, hermesSessionsHydrated, selectedHermesSessionId]);

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

  useEffect(() => {
    let cancelled = false;
    // This mount owns the snapshot now — consume it so it can't hydrate a
    // second mount (error-boundary remount, overlapping test renders) with
    // data this mount is about to mutate. Consumed here rather than in the
    // continuity initializer because StrictMode double-invokes lazy
    // initializers, which must stay pure; the unmount capture below writes
    // a fresh snapshot either way.
    clearAgentSessionContinuity();
    void (async () => {
      try {
        let status = await hermesBridgeStatus();
        if (cancelled) return;
        if (!status.running) {
          status = await startHermesBridge(undefined, false);
        }
        if (cancelled) return;
        setBridge(status);
        if (status.running) {
          void refreshActiveHermesProfile({ status });
        }
      } catch (err) {
        if (!cancelled) setError(describeHermesError(err), reportableAgentErrorOptions(err));
      }
    })();
    return () => {
      cancelled = true;
      for (const reservation of activeComposerDispatchReservationsRef.current.keys()) {
        reservation.cancel();
      }
      activeComposerDispatchReservationsRef.current.clear();
      for (const entries of Object.values(pendingSteerBySessionIdRef.current)) {
        for (const entry of entries) entry.dispatchReservation?.cancel();
      }
      pendingSteerBySessionIdRef.current = {};
      // Settlement monitoring belongs to the app lifetime, not this view.
      // Release runs with no queued local continuation before the workspace
      // gateway closes so they can still alert from Notes or Settings.
      for (const sessionId of workingSessionIdsRef.current) {
        if (!hasAutomaticContinuation(sessionId)) releaseAgentRunSettlement(sessionId);
      }
      const consentRequest = imageSafeModeConsentRequestRef.current;
      imageSafeModeConsentRequestRef.current = null;
      consentRequest?.resolve({ action: "dismiss" });
      // Keep any mid-run session alive for the next mount before the
      // gateways (and with them the live event streams) go away.
      writeAgentSessionContinuity(
        captureSessionContinuity({
          sessionItems: hermesSessionItemsRef.current,
          pendingMessages: pendingHermesMessagesRef.current,
          runtimeSessionIds: runtimeSessionIdsRef.current,
          liveEvents: liveEventsRef.current,
          titleOverrides: sessionTitleOverridesRef.current,
          titleSources: sessionTitleSourceRef.current,
          pendingIssueReports: Object.fromEntries(pendingIssueReportsRef.current),
          reviewableIssueReports: reviewableIssueReportsRef.current,
          diagnosisRefreshIssueReportSessionIds: diagnosisRefreshIssueReportSessionIdsRef.current,
          submittingIssueReportSessionIds: submittingIssueReportSessionIdsRef.current,
          queuedAttachmentFollowUps: queuedAttachmentFollowUpsRef.current,
        }),
      );
      for (const gateway of gatewaysRef.current.values()) {
        gateway.close();
      }
    };
  }, []);

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

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const installFileDropListener = async (eventName: string) => {
      const unlisten = await listen<TauriFileDropPayload>(eventName, (event) => {
        const paths = event.payload?.paths ?? [];
        if (paths.length) {
          void importDroppedFilePaths(paths);
        }
      });
      if (disposed) {
        unlisten();
        return;
      }
      unlisteners.push(unlisten);
    };
    const installImageSafeModeConsentListener = async () => {
      const unlisten = await listen<ImageSafeModeConsentEventPayload>(
        "image-safe-mode-consent",
        (event) => {
          void handleAgentImageSafeModeConsentEvent(event.payload);
        },
      );
      if (disposed) {
        unlisten();
        return;
      }
      unlisteners.push(unlisten);
    };
    void installFileDropListener("tauri://drag-drop");
    void installFileDropListener("tauri://file-drop");
    void installImageSafeModeConsentListener();
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);

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

  async function prepareComposerSubmission(
    message: string,
    messageAttachments: AgentAttachment[],
  ): Promise<PreparedComposerSubmission> {
    const parsed = parseSkillSlashCommands(message);
    const commandTokens = commandTokensForResolutions(
      parsed.commandNames,
      parseSkillSlashCommandTokens(message),
    );
    if (!parsed.commandNames.length) {
      const content = promptWithAttachments(message, messageAttachments);
      return {
        displayContent: content,
        runtimeContent: content,
        titleContent: message,
        typedMessage: message,
      };
    }

    const availableSkills = await loadSkillCommands();
    const resolutions = resolveSkillSlashCommands(parsed.commandNames, availableSkills);
    const pathLikePromptIndex = resolutions.findIndex(
      (resolution, index) =>
        resolution.status !== "resolved" && isPathLikeSlashToken(commandTokens[index]?.name ?? ""),
    );
    if (pathLikePromptIndex === 0) {
      const content = promptWithAttachments(message, messageAttachments);
      return {
        displayContent: content,
        runtimeContent: content,
        titleContent: message,
        typedMessage: message,
      };
    }

    const skillResolutions =
      pathLikePromptIndex === -1 ? resolutions : resolutions.slice(0, pathLikePromptIndex);
    const problem = skillResolutions.find((resolution) => resolution.status !== "resolved");
    if (problem) {
      throw new Error(skillSlashResolutionError(problem) ?? "Skill command failed.");
    }

    const typedMessage =
      pathLikePromptIndex === -1
        ? parsed.prompt.trim()
        : message.slice(commandTokens[pathLikePromptIndex].from).trimStart();
    if (!typedMessage && !messageAttachments.length) {
      throw new Error("Add a request after the skill command.");
    }

    const resolved = skillResolutions.filter(isResolvedSkillSlashResolution);
    const documents = await Promise.all(
      resolved.map(async (resolution) => ({
        ...(await getHermesBridgeSkill(skillDocumentLookupName(resolution.skill.name))),
        name: resolution.skill.name,
      })),
    );
    const displayContent = promptWithAttachments(typedMessage, messageAttachments);
    return {
      displayContent,
      runtimeContent: explicitSkillInvocationPrompt(documents, displayContent),
      titleContent: typedMessage,
      typedMessage,
    };
  }

  async function handleBuiltinComposerSlashCommand(
    commandText: string,
    modelTarget?: CapturedSessionModelTarget,
    dispatchReservation?: HermesSessionDispatchReservation,
  ) {
    if (categoryRef.current) return false;
    const parsed = parseBuiltinComposerSlashCommand(commandText);
    if (!parsed) return false;

    if (parsed.name === "model") {
      await runModelSlashCommand(parsed.argument, commandText, modelTarget);
      return true;
    }

    if (parsed.name === "image") {
      if (!IMAGE_GENERATION_ENABLED) {
        setError("Image generation is not available.");
        return true;
      }
      await runImageSlashCommand(parsed.argument, commandText, modelTarget, dispatchReservation);
      return true;
    }

    if (parsed.name === "video") {
      if (!VIDEO_GENERATION_ENABLED) {
        setError("Video generation is not available.");
        return true;
      }
      await runVideoSlashCommand(parsed.argument, commandText, modelTarget, dispatchReservation);
      return true;
    }

    await runFileSlashCommand(parsed.argument, commandText);
    return true;
  }

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

  async function finishImageSlashGeneration(input: {
    sessionId: string;
    turnId: string;
    prompt: string;
    requestId: string;
    createdAt: string;
    imageCreatedAt: string;
    model?: string;
    safeMode?: boolean;
  }) {
    const { sessionId, turnId, prompt, requestId, createdAt, imageCreatedAt } = input;
    const assistantTurnId = `${turnId}:assistant`;
    try {
      const result = await generateChatImage(
        prompt,
        {
          generate: (text, model, nextRequestId, safeMode) =>
            generateImage(text, model, nextRequestId, safeMode),
          importImageBytes: importHermesBridgeFileBytes,
        },
        input.model,
        requestId,
        input.safeMode,
      );
      if (result.status !== "ok") {
        updateImageSlashPart(sessionId, assistantTurnId, {
          status: "error",
          error: result.message,
        });
        return;
      }
      updateImageSlashPart(sessionId, assistantTurnId, {
        status: "complete",
        dataUrl: result.dataUrl,
        path: result.file.path,
        name: result.file.name,
      });
      upsertStoredImageSlashTurn({
        id: turnId,
        sessionId,
        prompt,
        path: result.file.path,
        name: result.file.name,
        createdAt,
        imageCreatedAt,
        contextPending: true,
      });
      // Mirror into the files drawer/timeline like any artifact the agent
      // touches, so the image is reachable after it scrolls away.
      hermesArtifactStore.recordArtifact(
        {
          sessionId,
          kind: "image",
          action: "attached",
          path: result.file.path,
          displayName: result.file.name,
          previewAvailable: true,
        },
        hermesModeFor(sessionId),
      );
      void loadFilesystemSnapshot();
      // JUN-171 (Phase A): hold the generated image so the user's next message
      // carries it into the model's context (lazy attach). No composer chip -
      // it already renders in-thread as the assistant image turn above. Reuses
      // attachmentStateFrom so it rides the exact structured-attach path a
      // pasted/dropped image would (kind:"image", status:"imported").
      const heldImage: AgentAttachment = {
        ...result.file,
        id: `held-image:${sessionId}:${Date.now()}`,
        sourcePrompt: prompt,
        attachDataUrl: result.dataUrl,
        attach: attachmentStateFrom(result.file, sessionId),
      };
      pendingFastPathImagesRef.current = {
        ...pendingFastPathImagesRef.current,
        [sessionId]: [...(pendingFastPathImagesRef.current[sessionId] ?? []), heldImage],
      };
    } catch (err) {
      updateImageSlashPart(sessionId, assistantTurnId, {
        status: "error",
        error: messageFromError(err),
      });
    } finally {
      setGeneratingImage(false);
      setImportingFiles(false);
    }
  }

  async function retryImageSlashTurn(
    sessionId: string,
    assistantTurnId: string,
    part: Extract<AgentChatPart, { type: "image" }>,
  ) {
    if (part.status !== "error" || !part.requestId) return;
    const now = new Date().toISOString();
    setError(null);
    setImportingFiles(true);
    setGeneratingImage(true);
    updateImageSlashPart(sessionId, assistantTurnId, {
      status: "running",
      error: undefined,
    });
    await finishImageSlashGeneration({
      sessionId,
      turnId: imageSlashBaseTurnId(assistantTurnId),
      prompt: part.prompt,
      requestId: part.requestId,
      createdAt: part.userCreatedAt ?? now,
      imageCreatedAt: part.imageCreatedAt ?? now,
      // Replay the shape pinned at turn creation - resolving the CURRENT
      // settings here would change the June API ledger key and turn a retry
      // into a second billable generation.
      model: part.model,
      safeMode: part.safeMode,
    });
  }

  function requestImageSafeModeConsent(
    variant: "slash" | "agent" | "video-slash",
    ownerDispatchReservation?: HermesSessionDispatchReservation,
  ): Promise<ImageSafeModeConsentChoice> {
    return new Promise((resolve) => {
      const request = { variant, ownerDispatchReservation, resolve };
      imageSafeModeConsentRequestRef.current = request;
      setImageSafeModeConsentRequest(request);
    });
  }

  function resolveImageSafeModeConsent(choice: ImageSafeModeConsentChoice) {
    const request = imageSafeModeConsentRequestRef.current;
    if (!request) return;
    imageSafeModeConsentRequestRef.current = null;
    setImageSafeModeConsentRequest(null);
    request.resolve(choice);
  }

  async function handleAgentImageSafeModeConsentEvent(payload?: ImageSafeModeConsentEventPayload) {
    if (payload?.source !== "agent") return;
    if (imageSafeModeConsentRequestRef.current) return;

    let settings: ProviderModelSettingsDto | undefined;
    try {
      settings = (await providerModelSettings()).settings;
    } catch {
      return;
    }
    if (!settings.imageSafeMode || settings.imageSafeModePromptDismissed) return;
    if (imageSafeModeConsentRequestRef.current) return;

    const choice = await requestImageSafeModeConsent("agent");
    if (choice.action === "dismiss") return;
    if (choice.action === "keep") {
      if (choice.dontAskAgain) void setImageSafeModePromptDismissed(true);
      return;
    }

    try {
      await setImageSafeMode(false);
    } catch (err) {
      setError(messageFromError(err));
      return;
    }
    if (choice.dontAskAgain) void setImageSafeModePromptDismissed(true);
  }

  // `/image <prompt>` renders the generated image inline in the chat as an
  // assistant turn (loader -> image, with view + download), NOT as a composer
  // attachment chip. It creates/uses a real session and the prompt becomes a
  // user turn, but the model is never invoked — the image endpoint IS the whole
  // response (see submitHermesSession's `skipPrompt`). The active text model
  // must already be vision-capable so the generated image can enter context on
  // the follow-up. The image generation model is still resolved server-side
  // from the saved image default.
  async function runImageSlashCommand(
    argument: string,
    commandText: string,
    modelTarget = captureSessionModelTarget(),
    dispatchReservation?: HermesSessionDispatchReservation,
  ) {
    if (creditActionsDisabledReason) {
      setError(creditActionsDisabledReason);
      return;
    }
    const prompt = argument.trim();
    if (!prompt) {
      setError("Type a description after /image to generate an image.");
      return;
    }

    // Busy-gate the consent + generation flow before any async IPC. This keeps
    // a second /image submission from starting while the prompt screen or
    // dialog is pending, but still lets dismiss leave the draft untouched.
    setImportingFiles(true);

    // Pin the image model and safe mode before the paid turn starts: June API's
    // replay ledger hashes them into the requestId's key, so a retry after a
    // settings change must send the values this turn started with or it becomes
    // a second charge. If the settings read fails, leave them unpinned (server
    // resolves live, matching the pre-pinning behavior) and skip consent.
    let settings: ProviderModelSettingsDto | undefined;
    let pinnedModel: string | undefined;
    let pinnedSafeMode: boolean | undefined;
    try {
      const settingsResponse = await providerModelSettings();
      settings = settingsResponse.settings;
      pinnedModel =
        settingsResponse.effectiveSettings?.imageModel || settings.imageModel || undefined;
      pinnedSafeMode = settings.imageSafeMode;
    } catch {
      // Non-fatal: generation proceeds with server-resolved settings.
    }

    if (settings?.imageSafeMode && !settings.imageSafeModePromptDismissed) {
      let mayBeExplicit = false;
      try {
        mayBeExplicit = await imagePromptMayBeExplicit(prompt);
      } catch {
        mayBeExplicit = false;
      }
      if (mayBeExplicit) {
        const choice = await requestImageSafeModeConsent("slash", dispatchReservation);
        if (choice.action === "dismiss") {
          setImportingFiles(false);
          return;
        }
        if (choice.action === "keep") {
          if (choice.dontAskAgain) void setImageSafeModePromptDismissed(true);
          pinnedSafeMode = true;
        } else {
          try {
            await setImageSafeMode(false);
          } catch (err) {
            setImportingFiles(false);
            setError(messageFromError(err));
            return;
          }
          if (choice.dontAskAgain) void setImageSafeModePromptDismissed(true);
          pinnedSafeMode = false;
        }
      }
    }

    if (composerDispatchWasInvalidated(dispatchReservation)) {
      setImportingFiles(false);
      return;
    }

    // The prompt is about to become a user turn — clear the draft up front and,
    // on a fresh session, play the hero teardown so the conversation view takes
    // over while the session is created.
    const heroMode = newSessionModeRef.current;
    if (heroMode) setHeroLeaving(true);
    clearComposerCommandDraft(commandText);
    setError(null);
    // importingFiles already busy-gates the WHOLE flow (consent + session
    // create + generation) via the same flag submit() and the send button check.
    // generatingImage only tailors the placeholder copy once generation starts.
    setGeneratingImage(true);

    let targetSessionId: string | undefined;
    try {
      targetSessionId = await submitHermesSession(prompt, undefined, {
        skipPrompt: true,
        displayContent: prompt,
        titleContent: prompt,
        modelTarget,
        dispatchReservation,
      });
    } catch (err) {
      if (heroMode) setHeroLeaving(false);
      setGeneratingImage(false);
      setImportingFiles(false);
      setError(messageFromError(err));
      return;
    }
    if (!targetSessionId) {
      if (heroMode) setHeroLeaving(false);
      setGeneratingImage(false);
      setImportingFiles(false);
      setError("Could not start an image session. Try again.");
      return;
    }
    const sessionId = targetSessionId;

    // Inject the synthetic user prompt plus running assistant image turn. The
    // slash flow does not call prompt.submit, so these are June-side turns.
    const turnStartedAt = Date.now();
    const turnId = `image:${sessionId}:${turnStartedAt}`;
    const createdAt = new Date(turnStartedAt).toISOString();
    const imageCreatedAt = new Date(turnStartedAt + 1).toISOString();
    const requestId = newImageRequestId();
    setImageTurnsBySession((current) => ({
      ...current,
      [sessionId]: [
        ...(current[sessionId] ?? []),
        ...runningImageSlashTurns({
          id: turnId,
          prompt,
          requestId,
          createdAt,
          imageCreatedAt,
          model: pinnedModel,
          safeMode: pinnedSafeMode,
        }),
      ],
    }));

    // Persist the replay shape BEFORE the paid request starts: if the app
    // exits mid-generation, the restored turn can retry the SAME request id
    // instead of minting a new one (a possibly-settled request would then be
    // billed twice). The success path below overwrites this with the
    // completed turn.
    upsertStoredImageSlashTurn({
      id: turnId,
      sessionId,
      prompt,
      path: "",
      name: "",
      createdAt,
      imageCreatedAt,
      contextPending: false,
      pending: true,
      requestId,
      model: pinnedModel,
      safeMode: pinnedSafeMode,
    });

    await finishImageSlashGeneration({
      sessionId,
      turnId,
      prompt,
      requestId,
      createdAt,
      imageCreatedAt,
      model: pinnedModel,
      safeMode: pinnedSafeMode,
    });
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

  async function finishVideoSlashGeneration(input: {
    sessionId: string;
    turnId: string;
    prompt: string;
    requestId: string;
    createdAt: string;
    videoCreatedAt: string;
    model?: string;
    jobId?: string;
  }) {
    const { sessionId, turnId, prompt, requestId, createdAt, videoCreatedAt } = input;
    const assistantTurnId = `${turnId}:assistant`;
    try {
      const result = input.jobId
        ? await pollExistingVideoSlashJob(input)
        : await generateChatVideo(
            prompt,
            {
              startGenerate: async (text, model, nextRequestId, options) => {
                const job = await videoGenerate({
                  prompt: text,
                  model,
                  requestId: nextRequestId,
                  ...options,
                });
                updateVideoSlashPart(sessionId, assistantTurnId, { jobId: job.jobId });
                upsertStoredVideoSlashTurn({
                  id: turnId,
                  sessionId,
                  prompt,
                  path: "",
                  name: "",
                  createdAt,
                  videoCreatedAt,
                  pending: true,
                  requestId,
                  model: input.model,
                  jobId: job.jobId,
                });
                return job;
              },
              pollStatus: videoStatus,
              onProgress: (progress) => {
                updateVideoSlashPart(sessionId, assistantTurnId, {
                  jobId: progress.jobId,
                });
                upsertStoredVideoSlashTurn({
                  id: turnId,
                  sessionId,
                  prompt,
                  path: "",
                  name: "",
                  createdAt,
                  videoCreatedAt,
                  pending: true,
                  requestId,
                  model: input.model,
                  jobId: progress.jobId,
                });
              },
            },
            input.model,
            requestId,
            {},
          );
      if (result.status !== "ok") {
        updateVideoSlashPart(sessionId, assistantTurnId, {
          status: "error",
          error: result.message,
          jobId: result.jobId,
        });
        if (!result.stillRunning) {
          removeStoredVideoSlashTurn(turnId);
        }
        return;
      }
      const name = filenameFromWorkspacePath(result.path, "generated-video.mp4");
      updateVideoSlashPart(sessionId, assistantTurnId, {
        status: "complete",
        path: result.path,
        name,
        model: result.model ?? input.model,
      });
      upsertStoredVideoSlashTurn({
        id: turnId,
        sessionId,
        prompt,
        path: result.path,
        name,
        createdAt,
        videoCreatedAt,
        requestId,
        model: result.model ?? input.model,
        jobId: result.jobId,
        // Hold this turn's context for the video fold: the next real prompt in
        // this session carries it to the model (storedPendingVideoSlashContexts).
        contextPending: true,
      });
      hermesArtifactStore.recordArtifact(
        {
          sessionId,
          kind: "file",
          action: "created",
          path: result.path,
          displayName: name,
          previewAvailable: false,
        },
        hermesModeFor(sessionId),
      );
      void loadFilesystemSnapshot();
    } catch (err) {
      updateVideoSlashPart(sessionId, assistantTurnId, {
        status: "error",
        error: messageFromError(err),
      });
    } finally {
      setGeneratingVideo(false);
      setImportingFiles(false);
    }
  }

  async function pollExistingVideoSlashJob(input: {
    sessionId: string;
    turnId: string;
    prompt: string;
    requestId: string;
    createdAt: string;
    videoCreatedAt: string;
    model?: string;
    jobId?: string;
  }) {
    if (!input.jobId) {
      return { status: "error" as const, message: "Generation was interrupted." };
    }
    // Poll the existing job with the full loop (not a single shot) so a retry
    // follows it to completion, re-attaching to the same server-side job.
    return pollChatVideo(input.jobId, {
      pollStatus: videoStatus,
      onProgress: (progress) => {
        updateVideoSlashPart(input.sessionId, `${input.turnId}:assistant`, {
          jobId: progress.jobId,
        });
        upsertStoredVideoSlashTurn({
          id: input.turnId,
          sessionId: input.sessionId,
          prompt: input.prompt,
          path: "",
          name: "",
          createdAt: input.createdAt,
          videoCreatedAt: input.videoCreatedAt,
          pending: true,
          requestId: input.requestId,
          model: input.model,
          jobId: input.jobId,
        });
      },
    });
  }

  // Resume a `/video` turn whose poll loop was lost (app crash, restart, or dev
  // hot-reload). The server job keeps running, so re-attach with the SAME poll
  // loop and follow it to completion instead of a single shot — the user gets
  // the video without a new billable generation, and never has to hit "Try
  // again" just because the app closed mid-render.
  async function resumePendingVideoSlashTurn(turn: PersistedVideoSlashTurn) {
    if (!turn.jobId) return;
    const jobId = turn.jobId;
    const assistantTurnId = `${turn.id}:assistant`;
    const result = await pollChatVideo(jobId, {
      pollStatus: videoStatus,
      onProgress: (progress) => {
        updateVideoSlashPart(turn.sessionId, assistantTurnId, {
          status: "running",
          jobId: progress.jobId,
        });
        upsertStoredVideoSlashTurn({
          ...turn,
          pending: true,
        });
      },
    });
    if (result.status === "ok") {
      const name = filenameFromWorkspacePath(result.path, "generated-video.mp4");
      updateVideoSlashPart(turn.sessionId, assistantTurnId, {
        status: "complete",
        path: result.path,
        name,
        model: result.model ?? turn.model,
      });
      upsertStoredVideoSlashTurn({
        ...turn,
        pending: false,
        path: result.path,
        name,
        model: result.model ?? turn.model,
        // Fold this turn's context into the next prompt, same as a live finish.
        contextPending: true,
      });
      hermesArtifactStore.recordArtifact(
        {
          sessionId: turn.sessionId,
          kind: "file",
          action: "created",
          path: result.path,
          displayName: name,
          previewAvailable: false,
        },
        hermesModeFor(turn.sessionId),
      );
      void loadFilesystemSnapshot();
      return;
    }
    // Budget exhausted while the job was still processing: it lives on the
    // server, so keep the turn pending (its stored jobId) and leave the loader
    // up — the next app launch resumes this exact loop. Only a real Venice
    // failure or a poll error is terminal and surfaces as retryable.
    if (result.stillRunning) {
      updateVideoSlashPart(turn.sessionId, assistantTurnId, {
        status: "running",
        jobId,
      });
      return;
    }
    updateVideoSlashPart(turn.sessionId, assistantTurnId, {
      status: "error",
      error: result.message,
      jobId,
    });
    removeStoredVideoSlashTurn(turn.id);
  }

  async function retryVideoSlashTurn(
    sessionId: string,
    assistantTurnId: string,
    part: Extract<AgentChatPart, { type: "video" }>,
  ) {
    if (creditActionsDisabledReason && !part.jobId) {
      setError(creditActionsDisabledReason);
      return;
    }
    if (part.status !== "error" || !part.requestId) return;
    const now = new Date().toISOString();
    setError(null);
    setImportingFiles(true);
    setGeneratingVideo(true);
    updateVideoSlashPart(sessionId, assistantTurnId, {
      status: "running",
      error: undefined,
    });
    await finishVideoSlashGeneration({
      sessionId,
      turnId: videoSlashBaseTurnId(assistantTurnId),
      prompt: part.prompt,
      requestId: part.requestId,
      createdAt: part.userCreatedAt ?? now,
      videoCreatedAt: part.videoCreatedAt ?? now,
      model: part.model,
      jobId: part.jobId,
    });
  }

  async function runVideoSlashCommand(
    argument: string,
    commandText: string,
    modelTarget = captureSessionModelTarget(),
    dispatchReservation?: HermesSessionDispatchReservation,
  ) {
    if (creditActionsDisabledReason) {
      setError(creditActionsDisabledReason);
      return;
    }
    const prompt = argument.trim();
    if (!prompt) {
      setError("Type a description after /video to generate a video.");
      return;
    }

    // Busy-gate the consent + generation flow before any async IPC, mirroring
    // /image: a second submission can't start while the prompt screen or
    // consent dialog is pending, and dismiss leaves the draft untouched.
    setImportingFiles(true);

    // Pin the video model before the paid turn starts (same replay-ledger
    // rationale as /image). Safe mode is read alongside but never pinned into
    // the request: video requests carry no safeMode field (Venice cannot blur
    // video), so the value only gates the consent dialog below.
    let settings: ProviderModelSettingsDto | undefined;
    let pinnedModel: string | undefined;
    try {
      const settingsResponse = await providerModelSettings();
      settings = settingsResponse.settings;
      pinnedModel =
        settingsResponse.effectiveSettings?.videoModel || settings.videoModel || undefined;
    } catch {
      // Non-fatal: generation proceeds with server-resolved settings.
    }

    // Unlike /image, the screen runs even after "don't ask again": for video
    // the dialog is the enforcement point (there is no blur to fall back to),
    // so an explicit prompt with safe mode on must never generate silently.
    if (settings?.imageSafeMode) {
      let mayBeExplicit = false;
      try {
        mayBeExplicit = await imagePromptMayBeExplicit(prompt);
      } catch {
        mayBeExplicit = false;
      }
      if (mayBeExplicit) {
        if (settings.imageSafeModePromptDismissed) {
          // The user opted out of the dialog, not out of safe mode: skip the
          // generation with a notice instead of asking again.
          setImportingFiles(false);
          setError(
            "Safe mode is on, so this video was skipped. Turn safe mode off in Settings to generate it.",
          );
          return;
        }
        const choice = await requestImageSafeModeConsent("video-slash", dispatchReservation);
        if (choice.action === "dismiss") {
          setImportingFiles(false);
          return;
        }
        if (choice.action === "keep") {
          // "Skip this video": no blurred fallback exists for video, so safe
          // mode on means the generation is skipped (the dialog says so).
          if (choice.dontAskAgain) void setImageSafeModePromptDismissed(true);
          setImportingFiles(false);
          return;
        }
        try {
          await setImageSafeMode(false);
        } catch (err) {
          setImportingFiles(false);
          setError(messageFromError(err));
          return;
        }
        if (choice.dontAskAgain) void setImageSafeModePromptDismissed(true);
      }
    }

    if (composerDispatchWasInvalidated(dispatchReservation)) {
      setImportingFiles(false);
      return;
    }

    const heroMode = newSessionModeRef.current;
    if (heroMode) setHeroLeaving(true);
    clearComposerCommandDraft(commandText);
    setError(null);
    setGeneratingVideo(true);

    let targetSessionId: string | undefined;
    try {
      targetSessionId = await submitHermesSession(prompt, undefined, {
        skipPrompt: true,
        displayContent: prompt,
        titleContent: prompt,
        modelTarget,
        dispatchReservation,
      });
    } catch (err) {
      if (heroMode) setHeroLeaving(false);
      setGeneratingVideo(false);
      setImportingFiles(false);
      setError(messageFromError(err));
      return;
    }
    if (!targetSessionId) {
      if (heroMode) setHeroLeaving(false);
      setGeneratingVideo(false);
      setImportingFiles(false);
      setError("Could not start a video session. Try again.");
      return;
    }
    const sessionId = targetSessionId;

    const turnStartedAt = Date.now();
    const turnId = `video:${sessionId}:${turnStartedAt}`;
    const createdAt = new Date(turnStartedAt).toISOString();
    const videoCreatedAt = new Date(turnStartedAt + 1).toISOString();
    const requestId = newVideoRequestId();

    setVideoTurnsBySession((current) => ({
      ...current,
      [sessionId]: [
        ...(current[sessionId] ?? []),
        ...runningVideoSlashTurns({
          id: turnId,
          prompt,
          requestId,
          createdAt,
          videoCreatedAt,
          model: pinnedModel,
        }),
      ],
    }));

    upsertStoredVideoSlashTurn({
      id: turnId,
      sessionId,
      prompt,
      path: "",
      name: "",
      createdAt,
      videoCreatedAt,
      pending: true,
      requestId,
      model: pinnedModel,
    });

    await finishVideoSlashGeneration({
      sessionId,
      turnId,
      prompt,
      requestId,
      createdAt,
      videoCreatedAt,
      model: pinnedModel,
    });
  }

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

  function handleComposerDragOver(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  }

  function handleComposerDrop(event: DragEvent<HTMLFormElement>) {
    // The report dialog's JSX lives inside this form, so its events React-
    // bubble here even though it renders in a portal; a report drop or paste
    // must never land in the chat composer.
    if (reportDialogOpen) return;
    event.preventDefault();
    setDropActive(false);
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) {
      setError("Drop files from Finder to attach them to the agent.");
      return;
    }
    void importDroppedFiles(files);
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLFormElement>) {
    if (reportDialogOpen) return;
    const files = clipboardImageFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    void importPastedImageFiles(files);
  }

  function agentAttachmentFromImportedFile(file: ImportedHermesFile): AgentAttachment {
    return {
      ...file,
      id: `${file.path}:${Date.now()}:${Math.random().toString(36)}`,
      // Seed the structured attach status (feature 19). Images become
      // `kind:"image"`, status `imported` — eligible for structured attach on
      // the next submit. No bytes are kept here.
      attach: attachmentStateFrom(file),
    };
  }

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
  async function deliverIssueReport(
    sessionId: string,
    report: PendingIssueReport,
  ): Promise<IssueReportDeliveryResult> {
    let agentDiagnosis: string | undefined;
    try {
      const messages = await listHermesSessionMessages(sessionId);
      agentDiagnosis = messages
        .slice()
        .reverse()
        .filter((message) => messageAfterIssueReportDiagnosisBoundary(message, report))
        .map((message) => (message.role === "assistant" ? visibleHermesMessageText(message) : ""))
        .find((text) => text.trim())
        ?.trim();
    } catch {
      // Best-effort; the report ships without the diagnosis.
    }
    try {
      const response = await submitIssueReport({
        category: report.category,
        description: issueReportDescription(report),
        agentDiagnosis,
        attachmentNames: report.attachmentNames,
        attachmentPaths: report.attachmentPaths,
        sessionId,
      });
      clearErrorForSession(sessionId);
      toast.success(issueReportSentMessage(response?.skippedAttachmentNames), {
        id: ISSUE_REPORT_SENT_TOAST_ID,
      });
      // T4 of the referral delight nudge: positive feedback only. The
      // error-report path deliberately doesn't record — a report sent from a
      // failure is not a delight moment, whatever its category.
      if (report.category === "feedback") recordPositiveFeedbackSent();
      return { sent: true };
    } catch (err) {
      const errorMessage = `The issue report could not be sent. ${messageFromError(err)}`;
      setError(errorMessage, { sessionId });
      return { sent: false, errorMessage };
    }
  }

  async function sendReviewableIssueReport(sessionId: string) {
    if (submittingIssueReportSessionIdsRef.current.has(sessionId)) return;
    const report = reviewableIssueReportsRef.current[sessionId];
    if (!report) return;
    setIssueReportSubmitting(sessionId, true);
    let result: IssueReportDeliveryResult | undefined;
    try {
      await withTimeout(
        waitForIssueReportDiagnosisRefresh(sessionId),
        ISSUE_REPORT_DIAGNOSIS_REFRESH_TIMEOUT_MS,
        "Issue report diagnosis refresh timed out.",
      ).catch(() => undefined);
      result = await deliverIssueReport(sessionId, report);
      if (result.sent && reviewableIssueReportsRef.current[sessionId] === report) {
        setReviewableIssueReport(sessionId, null);
      }
    } finally {
      setIssueReportSubmitting(sessionId, false);
      if (result) {
        dispatchIssueReportDeliverySettled({ sessionId, report, result });
      }
    }
  }

  async function sendErrorIssueReport(error: AgentWorkspaceError) {
    const report = error.issueReport;
    if (!report || submittingErrorIssueReport) return;
    const sessionId = error.sessionId ?? selectedHermesSessionIdRef.current;
    setSubmittingErrorIssueReport(true);
    try {
      const response = await submitIssueReport({
        category: report.category,
        description: issueReportDescription(report),
        agentDiagnosis: undefined,
        attachmentNames: report.attachmentNames,
        attachmentPaths: report.attachmentPaths,
        ...(sessionId ? { sessionId } : {}),
      });
      if (sessionId) {
        clearErrorForSession(sessionId);
      } else {
        setError(null);
      }
      toast.success(issueReportSentMessage(response?.skippedAttachmentNames), {
        id: ISSUE_REPORT_SENT_TOAST_ID,
      });
    } catch (err) {
      setError(`The issue report could not be sent. ${messageFromError(err)}`, {
        sessionId: sessionId ?? null,
        issueReport: report,
      });
    } finally {
      setSubmittingErrorIssueReport(false);
    }
  }

  /**
   * Attach this turn's pending images to the live session via image.attach_bytes
   * (feature 19), updating each chip's status and feeding the artifact timeline.
   * The base64 is read on demand from the workspace file, passed straight to
   * the typed attachImage, and discarded; it never lands on composer state and
   * the trace entry is redacted to a byte count. Throws a single blocking error
   * if any image failed so the prompt is not sent with a missing image.
   */
  async function attachPendingImages(
    gateway: HermesGatewayClient,
    runtimeSessionId: string,
    storedSessionId: string,
    turnAttachments: AgentAttachment[],
  ) {
    const pending = pendingImageAttachments(turnAttachments.map((attachment) => attachment.attach));
    if (!pending.length) return turnAttachments;
    const methods = createHermesMethods(gateway);
    const heldImageDataByPath = new Map(
      turnAttachments.flatMap((attachment) =>
        attachment.attachDataUrl && attachment.attach.workspacePath
          ? [[attachment.attach.workspacePath, attachment.attachDataUrl] as const]
          : [],
      ),
    );
    const deps = {
      attachImage: methods.attachImage,
      readImageData: async (path: string) =>
        heldImageDataByPath.get(path) ?? (await hermesBridgeImageDataUrl(path)),
      isSupported: () => isHermesFeatureSupported("image.attach_bytes"),
    };
    const mode = hermesModeFor(storedSessionId);
    const failures: string[] = [];
    // The submit() flow has already cleared the composer chips by the time this
    // runs; track the per-attachment status here so a blocking failure can
    // restore the chips WITH their failed status (not the stale imported one).
    const nextStates = new Map<string, HermesAttachmentState>();
    for (const attachment of pending) {
      const result = await attachImageToSession(attachment, runtimeSessionId, deps);
      // The RPC keys off the runtime (live process) session id, but the chip
      // state, artifact timeline, and trace all key off the STORED session id —
      // the identity the rest of the UI uses (event handler, drawer, trace
      // panel). Re-stamp the result's session id to the stored one.
      const state: HermesAttachmentState = {
        ...result.state,
        sessionId: storedSessionId,
      };
      nextStates.set(attachment.localId, state);
      // Reflect the new status on the matching chip if it is still mounted
      // (matched by localId, stable across the submit). Refs/ids only, no bytes.
      setComposerAttachments((current) =>
        current.map((item) =>
          item.attach.localId === attachment.localId ? { ...item, attach: state } : item,
        ),
      );
      if (result.artifact) {
        hermesArtifactStore.recordArtifact(
          { ...result.artifact, sessionId: storedSessionId },
          mode,
        );
      }
      if (result.trace) {
        hermesTraceBuffer.recordOutbound({
          ...result.trace,
          sessionId: storedSessionId,
        });
      }
      // A gated-off runtime returns an error notice but leaves status
      // `imported` (the path-in-prompt fallback still carries the image) — that
      // is not a blocking failure.
      if (result.state.status === "failed" && result.error) {
        failures.push(result.error);
      }
    }
    if (failures.length) {
      // Carry the failed-status chips so submit()'s catch restores them with
      // the failure visible and the user can retry or remove them.
      throw new AttachBlockedError(
        failures[0],
        turnAttachments.map((item) => {
          const next = nextStates.get(item.attach.localId);
          return next ? { ...item, attach: next } : item;
        }),
      );
    }
    return turnAttachments.map((item) => {
      const next = nextStates.get(item.attach.localId);
      return next ? { ...item, attach: next } : item;
    });
  }

  function clearHeldFastPathImages(sessionId: string, heldImages: AgentAttachment[]) {
    if (!heldImages.length) return;
    const heldIds = new Set(heldImages.map((attachment) => attachment.id));
    const heldPaths = heldImages
      .map((attachment) => attachment.attach.workspacePath)
      .filter((path): path is string => Boolean(path));
    const remaining = (pendingFastPathImagesRef.current[sessionId] ?? []).filter(
      (attachment) => !heldIds.has(attachment.id),
    );
    const next = { ...pendingFastPathImagesRef.current };
    if (remaining.length) {
      next[sessionId] = remaining;
    } else {
      delete next[sessionId];
    }
    pendingFastPathImagesRef.current = next;
    markStoredImageSlashTurnsAttached(sessionId, heldPaths);
  }

  function startOptimisticHermesSession({
    displayContent,
    model,
    title,
  }: {
    displayContent: string;
    model?: string;
    title: string;
  }) {
    const sessionId = makeProvisionalHermesSessionId();
    moveComposerDraft(NEW_SESSION_DRAFT_KEY, sessionComposerDraftKey(sessionId));
    const createdAt = new Date().toISOString();
    const userMessage: HermesSessionMessage = {
      id: `pending:user:${Date.now()}`,
      role: "user",
      content: displayContent,
      timestamp: createdAt,
    };
    heroExitViaThreadRef.current = true;
    newSessionModeRef.current = false;
    setNewSessionMode(false);
    selectedHermesSessionIdRef.current = sessionId;
    setSelectedHermesSessionId(sessionId);
    setSelectedTaskId(undefined);
    setHermesSessionItems((current) => [
      {
        id: sessionId,
        title,
        preview: displayContent,
        started_at: createdAt,
        last_active: createdAt,
        message_count: 1,
        ...(model ? { model } : {}),
      },
      ...current,
    ]);
    setPendingHermesMessages((current) => {
      const next = {
        ...current,
        [sessionId]: [...(current[sessionId] ?? []), userMessage],
      };
      pendingHermesMessagesRef.current = next;
      return next;
    });
    recordSessionRunningActivity(sessionId);
    dispatchAgentSessionStatus({
      title,
      prompt: displayContent,
      status: "starting",
      summary: "Starting June.",
    });
    return { createdAt, id: sessionId, userMessage };
  }

  function migrateOptimisticHermesSession({
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
  }) {
    if (fromSessionId === toSessionId) return;
    moveComposerDraft(sessionComposerDraftKey(fromSessionId), sessionComposerDraftKey(toSessionId));
    commitSessionModelSelections(migrateSessionModelSelection(fromSessionId, toSessionId));
    setHermesSessionItems((current) => {
      const replacement: HermesSessionInfo = {
        id: toSessionId,
        title,
        preview: displayContent,
        started_at: createdAt,
        last_active: createdAt,
        message_count: 1,
        ...(clearModel ? { model: undefined } : model ? { model } : {}),
      };
      let replaced = false;
      const next = current.flatMap((session) => {
        if (session.id === toSessionId) return [];
        if (session.id === fromSessionId) {
          replaced = true;
          return [{ ...session, ...replacement }];
        }
        return [session];
      });
      return replaced ? next : [replacement, ...next];
    });
    setHermesSessionMessages((current) => {
      const next = moveRecordKey(current, fromSessionId, toSessionId);
      hermesSessionMessagesRef.current = next;
      return next;
    });
    setPendingHermesMessages((current) => {
      const next = moveRecordKey(current, fromSessionId, toSessionId);
      pendingHermesMessagesRef.current = next;
      return next;
    });
    liveEventsRef.current = moveRecordKey(liveEventsRef.current, fromSessionId, toSessionId);
    setLiveEvents(liveEventsRef.current);
    hermesActivityStore.clearSession(fromSessionId);
    recordSessionRunningActivity(toSessionId);
    selectedHermesSessionIdRef.current = toSessionId;
    setSelectedHermesSessionId(toSessionId);
  }

  function removeOptimisticHermesSession(optimisticSessionId: string, realSessionId?: string) {
    const ids = new Set(
      [optimisticSessionId, realSessionId].filter((sessionId): sessionId is string =>
        Boolean(sessionId),
      ),
    );
    for (const id of ids) {
      moveComposerDraft(sessionComposerDraftKey(id), NEW_SESSION_DRAFT_KEY);
    }
    composerDraftKeyRef.current = NEW_SESSION_DRAFT_KEY;
    setHermesSessionItems((current) => current.filter((session) => !ids.has(session.id)));
    setHermesSessionMessages((current) => {
      let next = current;
      for (const id of ids) next = omitRecordKey(next, id);
      hermesSessionMessagesRef.current = next;
      return next;
    });
    setPendingHermesMessages((current) => {
      let next = current;
      for (const id of ids) next = omitRecordKey(next, id);
      pendingHermesMessagesRef.current = next;
      return next;
    });
    let nextLiveEvents = liveEventsRef.current;
    for (const id of ids) nextLiveEvents = omitRecordKey(nextLiveEvents, id);
    liveEventsRef.current = nextLiveEvents;
    setLiveEvents(nextLiveEvents);
    for (const id of ids) hermesActivityStore.clearSession(id);
    const retrySelection = [...ids]
      .map((id) => sessionModelSelectionsRef.current[id]?.selection)
      .find((selection): selection is SessionModelSelection => Boolean(selection));
    if (retrySelection) {
      // A picker change after Send was staged against the provisional session.
      // If creation rolls back, carry that intent into the restored new-session
      // composer instead of reverting to the model the failed run captured.
      const intentRevision = ++generationSelectionIntentRevisionRef.current;
      defaultGenerationModelIdRef.current = retrySelection.modelId;
      setDefaultGenerationModelId(retrySelection.modelId);
      if (retrySelection.modelId === AUTO_MODEL_ID) {
        generationCostQualityRef.current = retrySelection.costQuality;
        setGenerationCostQuality(retrySelection.costQuality);
      }
      // The provisional selection was session-local while creation was alive.
      // Rollback turns it into the next new-session default, so persist the same
      // transition instead of leaving the pill and Rust provider settings split.
      void saveGenerationSelection(async () => {
        if (retrySelection.modelId.startsWith(LOCAL_GENERATION_OPTION_ID_PREFIX)) {
          await setLocalGenerationEnabled(true);
        } else {
          if (
            retrySelection.modelId === AUTO_MODEL_ID &&
            retrySelection.costQuality !== undefined
          ) {
            await setCostQuality(retrySelection.costQuality);
          }
          await setVeniceModel("generation", retrySelection.modelId);
        }
      })
        .then(() => {
          if (generationSelectionIntentRevisionRef.current === intentRevision) {
            dispatchProviderModelSettingsChanged({
              mode: "generation",
              modelId: retrySelection.modelId,
            });
          }
        })
        .catch(() => undefined);
    }
    let nextSessionModelSelections = sessionModelSelectionsRef.current;
    for (const id of ids) {
      nextSessionModelSelections = forgetSessionModelSelection(id);
    }
    commitSessionModelSelections(nextSessionModelSelections);
    const selectedSessionId = selectedHermesSessionIdRef.current;
    if (selectedSessionId && ids.has(selectedSessionId)) {
      selectedHermesSessionIdRef.current = undefined;
      setSelectedHermesSessionId(undefined);
      newSessionModeRef.current = true;
      setNewSessionMode(true);
    }
  }

  function rememberComputerUseRun(sessionId: string, runLeaseId: string) {
    const leases = computerUseRunLeasesRef.current.get(sessionId) ?? new Set<string>();
    leases.add(runLeaseId);
    computerUseRunLeasesRef.current.set(sessionId, leases);
  }

  async function releaseComputerUseRun(sessionId: string, runLeaseId: string) {
    const leases = computerUseRunLeasesRef.current.get(sessionId);
    leases?.delete(runLeaseId);
    if (leases?.size === 0) computerUseRunLeasesRef.current.delete(sessionId);
    await computerUseEndRun(runLeaseId).catch(() => undefined);
  }

  async function releaseAllComputerUseRuns(sessionId: string) {
    const leases = [...(computerUseRunLeasesRef.current.get(sessionId) ?? [])];
    computerUseRunLeasesRef.current.delete(sessionId);
    await Promise.all(leases.map((lease) => computerUseEndRun(lease).catch(() => undefined)));
  }

  function attachHermesSessionEventListener({
    gateway,
    runtimeSessionId,
    sessionDisplayTitle,
    storedSessionId,
    computerUseRunLeaseId,
  }: {
    gateway: HermesGatewayClient;
    runtimeSessionId: string;
    sessionDisplayTitle: string;
    storedSessionId: string;
    computerUseRunLeaseId?: string;
  }) {
    sessionGatewayUnlistenRef.current.get(storedSessionId)?.();
    const agentRunCompletionSource = Symbol(storedSessionId);
    let unlisten = () => {};
    const removeListener = gateway.onEvent((event) => {
      if (event.session_id !== runtimeSessionId && event.session_id !== storedSessionId) return;
      const liveEvent = { ...event, receivedAt: new Date().toISOString() };
      // Classify the raw frame once at ingress. Stores and transcript rendering
      // consume the typed event; the raw frame remains only for trace capture
      // and the Stage B status helpers below.
      const classified = classifyHermesEvent(liveEvent);
      const storedClassified = withStoredHermesSessionId(classified, storedSessionId);
      // Feature 15: record every inbound frame (raw type + the kind it
      // classified to) into the bounded, sanitized trace buffer so the dev/debug
      // trace panel can reconstruct the session. recordInbound re-classifies and
      // sanitizes internally; nothing raw is retained.
      hermesTraceBuffer.recordInbound(liveEvent, { storedSessionId });
      // The runtime's session.info is the source of truth for the effort a
      // session ACTUALLY runs at (emitted after every build and on every
      // live retune): hydrate the per-session record from it so the composer
      // labels this chat with its own level after a relaunch or a change made
      // outside June, and mark the reporting runtime as known-at that effort
      // so the send flow never fires a redundant config.set against it.
      if (event.type === "session.info") {
        const reportedEffort = (event.payload as { reasoning_effort?: unknown } | undefined)
          ?.reasoning_effort;
        const reportedLevel = thinkingLevelForEffort(
          typeof reportedEffort === "string" ? reportedEffort : undefined,
        );
        if (reportedLevel) {
          sessionThinkingEffortsRef.current = {
            ...sessionThinkingEfforts(),
            [storedSessionId]: reportedLevel,
          };
          rememberSessionThinkingLevel(storedSessionId, reportedLevel);
          sessionThinkingAppliedRef.current = {
            ...sessionThinkingAppliedRef.current,
            [storedSessionId]: {
              runtimeId: runtimeSessionId,
              effort: thinkingEffortForLevel(reportedLevel),
            },
          };
        }
      }
      if (storedClassified.kind === "unsupported") {
        // Feed the bounded per-session store so the user gets a recoverable
        // notice (when this is the active session) and developers get a
        // sanitized, issue-report-safe export. The payload is already sanitized
        // by the classifier; nothing raw is retained or logged.
        unsupportedEventStore.record(storedClassified);
        if (import.meta.env.DEV) {
          // biome-ignore lint/suspicious/noConsole: dev-only unsupported-event diagnostic
          console.debug(
            "[hermes] unsupported event",
            storedClassified.rawType,
            storedClassified.sanitizedPayload,
          );
        }
      } else if (storedClassified.kind === "pending_action") {
        // Feature 04: aggregate this blocker into the pending-action store
        // keyed by mode + session + request. The session's mode comes from its
        // recorded opt-in (sudo carries its own; the rest derive it here). A
        // fresh event for a known request also re-confirms a row that went
        // stale across a reconnect (see the store's reconcile logic).
        pendingActionStore.record(storedClassified, hermesModeFor(storedSessionId));
      } else if (storedClassified.kind === "pending_action_resolution") {
        // Resolution events can arrive independently of this surface's local
        // response promise (for example after reconnect). Reconcile the exact
        // logical request before deriving the session status so another
        // distinct pending action keeps the session in "Needs you".
        pendingActionStore.resolveRequest(storedSessionId, storedClassified.action.requestId);
      } else if (storedClassified.kind === "pending_action_expiration") {
        pendingActionStore.expireRequest(
          storedSessionId,
          storedClassified.action.requestId,
          storedClassified.action.reason,
        );
      }
      // Feature 11: roll EVERY classified event into the global activity store
      // that backs the Agent activity drawer. The store is total and ignores
      // unattributable events, so one unconditional call covers all kinds; it
      // derives the session's phase (running/waiting/background/error/complete),
      // current tool, and subagent count from the normalized event — never from
      // the raw frame (raw JSON belongs to feature 15's trace panel).
      const status = recordHermesActivityAndDeriveStatus(storedClassified, storedSessionId);
      // Feature 14: extract any file/artifact reference this event carries into
      // the per-session artifact timeline behind the drawer's "Artifacts"
      // section. The store is total and only acts on `tool` completions that
      // name a known file/url field (conservative — never parses prose), so one
      // unconditional call is safe for every kind. Mode rides along so each
      // artifact can show its blast radius (sandboxed copy vs unrestricted path).
      hermesArtifactStore.record(storedClassified, hermesModeFor(storedSessionId));
      const nextSessionEvents = appendHermesLiveEvent(
        liveEventsRef.current[storedSessionId] ?? [],
        classified,
      );
      liveEventsRef.current = {
        ...liveEventsRef.current,
        [storedSessionId]: nextSessionEvents,
      };
      setLiveEvents(liveEventsRef.current);
      const toolEventPhase = classified.kind === "tool" ? classified.phase : undefined;
      if (toolEventPhase === "complete") {
        // The classifier treats any tool.*complete* subtype as complete, a
        // superset of the old exact tool.complete drain trigger.
        // Hermes drains every accepted steer into the tool result it just
        // produced (run_agent.steer). Mark the pending entries drained rather
        // than removing them here: whether a steer was ACCEPTED is settled
        // asynchronously (the steer RPC's .then), which can resolve AFTER this
        // event, so the consume-vs-resend decision is deferred to the terminal
        // handler where both flags are final. Removing on `registered` alone
        // here would resubmit a steer that was accepted + drained before its
        // .then ran (the duplicate-delivery race).
        const list = pendingSteerBySessionIdRef.current[storedSessionId];
        if (list) {
          for (const entry of list) entry.toolDrained = true;
        }
      }
      const activityCounts =
        status === "completed" || status === "failed" || status === "cancelled"
          ? agentActivityCountsFromStore()
          : undefined;
      if (activityCounts) {
        // Feature 04: the session reached a terminal state (completed, a
        // terminal error, or an interrupt) — the agent is no longer blocked, so
        // any of its outstanding "Needs you" rows are moot. Clear them so the
        // sidebar "Needs you" count never shows a dead blocker for a finished
        // session.
        pendingActionStore.resolveSession(storedSessionId);
      }
      if (status) {
        if (status === "completed") {
          markAgentRunSucceeded(storedSessionId);
        } else if (status === "failed" || status === "cancelled") {
          cancelAgentRunSettlement(storedSessionId);
        }
        dispatchAgentSessionStatus({
          sessionId: storedSessionId,
          title: sessionDisplayTitle,
          status,
          summary: agentStatusSummaryFromHermesEvent(classified, status),
          ...activityCounts,
        });
      }
      if (isTerminalHermesEvent(classified)) {
        if (computerUseRunLeaseId) {
          void releaseComputerUseRun(storedSessionId, computerUseRunLeaseId);
        } else {
          void releaseAllComputerUseRuns(storedSessionId);
        }
        unlisten();
        if (!activityCounts) {
          clearSessionActivity(storedSessionId);
        }
        if (status === "completed") {
          // Serialize any undrained text steer ahead of the first local
          // attachment follow-up. Each accepted follow-up installs its own
          // terminal listener, which advances the attachment FIFO one turn at
          // a time.
          continueAfterCompletedAgentRun(storedSessionId, agentRunCompletionSource);
        } else {
          // Submitted text steers cannot be recalled and are retired on a
          // failed/cancelled run. Local attachment follow-ups remain available
          // to edit, remove, or send once the session is idle.
          clearSubmittedSteers(storedSessionId);
        }
        // The diagnostic turn is over (even on error): let the user append
        // anything June's summary surfaced before sending the bundled report.
        const promotedIssueReport = promotePendingIssueReportToReview(storedSessionId, {
          queueDiagnosisRefresh: true,
        });
        if (!promotedIssueReport) {
          window.setTimeout(() => {
            void refreshHermesSession(storedSessionId);
          }, 300);
        }
      }
    });
    unlisten = () => {
      removeListener();
      if (sessionGatewayUnlistenRef.current.get(storedSessionId) === unlisten) {
        sessionGatewayUnlistenRef.current.delete(storedSessionId);
      }
    };
    sessionGatewayUnlistenRef.current.set(storedSessionId, unlisten);
    return unlisten;
  }

  const submitHermesSession = createSubmitHermesSession({
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

  async function retryUpstreamProviderFailure(
    storedSessionId: string | undefined,
    recoveryId: string | undefined,
  ) {
    if (!storedSessionId || isProvisionalHermesSessionId(storedSessionId)) return;
    if (
      workingSessionIdsRef.current.has(storedSessionId) ||
      waitingSessionIdsRef.current.has(storedSessionId)
    ) {
      return;
    }
    if (!recoveryId || !upstreamProviderRecoveryStore.reserve(storedSessionId, recoveryId)) return;
    const session = hermesSessionItemsRef.current.find((item) => item.id === storedSessionId);
    if (!session) {
      upstreamProviderRecoveryStore.release(storedSessionId, recoveryId);
      setError(SESSION_NOT_AVAILABLE_MESSAGE, { sessionId: storedSessionId });
      return;
    }

    try {
      // This starts a new agent run in the same stored session and reuses its
      // runtime session when it is still live. The prompt has an exact
      // persisted-display mapping to the "Try again" transcript label, so a
      // later refresh cannot expose the continuation instruction. This path
      // never reads or clears the composer and never replays clarify.respond.
      await submitHermesSession(UPSTREAM_PROVIDER_FAILURE_RETRY_PROMPT, session, {
        displayContent: "Try again",
        titleContent: "Try again",
        modelTarget: captureSessionModelTarget(session),
        selectSession: false,
      });
      setError(null);
    } catch (err) {
      // prompt.submit never accepted the recovery, so the same notice may try
      // again. Once accepted, the key remains spent; a second provider failure
      // creates a new turn id and its own one-shot action.
      upstreamProviderRecoveryStore.release(storedSessionId, recoveryId);
      setError(messageFromError(err), { sessionId: storedSessionId });
    }
  }

  // "Try again" on a connection-shaped error banner: rebuild the bridge +
  // gateway connection and reload sessions, surfacing whatever still fails.
  async function retryGatewayConnection() {
    setError(null);
    try {
      await ensureHermesGateway();
      await loadHermesSessions();
      // Re-run the selected session's transcript load too: a friendly Hermes
      // 5xx banner (JUN-167) can originate from that message fetch, and
      // reconnecting alone would clear the banner without reloading the
      // messages — the load effect is keyed on the session id, which does not
      // change on retry, so it would not re-fire. refreshHermesSession handles
      // its own errors (re-showing the friendly banner if the 5xx persists).
      const sessionId = selectedHermesSessionIdRef.current;
      if (sessionId && !isProvisionalHermesSessionId(sessionId)) {
        await refreshHermesSession(sessionId);
      }
    } catch (err) {
      setError(describeHermesError(err), reportableAgentErrorOptions(err));
    }
  }

  // prompt.submit is ack-style: once acked there are no pending RPCs, so a
  // socket drop mid-run rejects nothing and no event will ever arrive — the
  // session would otherwise stay "working" (and broadcast "June is working.")
  // forever. Try to reconnect and resubscribe the active runtime sessions;
  // either way, refresh them immediately so the working-gated poll reconciles
  // their true state from persisted messages. Only the dropped mode's
  // gateway is rebuilt — sessions of that mode are the ones it served.
  async function recoverFromGatewayClose(fullMode: boolean) {
    if (gatewayRecoveringRef.current.has(fullMode)) return;
    const activeSessionIds = new Set(
      [...workingSessionIdsRef.current, ...waitingSessionIdsRef.current].filter(
        (sessionId) => sessionUnrestricted(sessionId) === fullMode,
      ),
    );
    if (!activeSessionIds.size) return;
    gatewayRecoveringRef.current.add(fullMode);
    // The patched Hermes gateway denies and drains unresolved MCP approvals
    // when its notification socket disconnects. Mirror that fail-closed
    // boundary locally before reconnecting: an old card must never remain
    // actionable against a newly resumed runtime. Other pending-action kinds
    // keep their existing stale/reannounce reconciliation contract.
    let retiredApprovalEvents = liveEventsRef.current;
    let retiredApprovalChanged = false;
    const retiredApprovalStatuses = new Map<
      string,
      { event: JuneHermesEvent; status: AgentSessionStatusKind }
    >();
    const retiredAt = new Date().toISOString();
    for (const record of pendingActionStore.openRecords()) {
      if (!activeSessionIds.has(record.sessionId) || record.action.kind !== "approval") continue;
      // The socket rejects pending RPCs immediately before this close handler
      // runs. A response that was already processed upstream may therefore be
      // unacknowledged locally. Retire it so it cannot be sent twice, but do not
      // claim that nothing was approved when the outcome is unknowable.
      const reason = approvalResponsesInFlightRef.current.has(
        approvalResponseKey(record.sessionId, record.requestId),
      )
        ? "unconfirmed"
        : "disconnect";
      pendingActionStore.expireRequest(record.sessionId, record.requestId, reason);
      const expiration: JuneHermesEvent = {
        kind: "pending_action_expiration",
        sessionId: record.sessionId,
        action: {
          kind: "approval",
          requestId: record.requestId,
          reason,
        },
        receivedAt: retiredAt,
      };
      const status = recordHermesActivityAndDeriveStatus(expiration, record.sessionId);
      if (status) {
        retiredApprovalStatuses.set(record.sessionId, { event: expiration, status });
      }
      retiredApprovalEvents = {
        ...retiredApprovalEvents,
        [record.sessionId]: [...(retiredApprovalEvents[record.sessionId] ?? []), expiration].slice(
          -200,
        ),
      };
      retiredApprovalChanged = true;
    }
    if (retiredApprovalChanged) {
      liveEventsRef.current = retiredApprovalEvents;
      setLiveEvents(retiredApprovalEvents);
    }
    for (const [sessionId, { event, status }] of retiredApprovalStatuses) {
      dispatchAgentSessionStatus({
        sessionId,
        title:
          hermesSessionItemsRef.current.find((session) => session.id === sessionId)?.title ??
          "Agent session",
        status,
        summary: agentStatusSummaryFromHermesEvent(event, status),
      });
    }
    try {
      const gateway = await ensureHermesGateway(fullMode);
      await Promise.all(
        Array.from(activeSessionIds).map(async (sessionId) => {
          try {
            const resumed = await gateway.request<HermesRuntimeSessionResponse>("session.resume", {
              session_id: sessionId,
              cols: 96,
            });
            const runtimeSessionId = resumed.session_id;
            if (runtimeSessionId) {
              setRuntimeSessionIds((current) => ({
                ...current,
                [sessionId]: runtimeSessionId,
              }));
              attachHermesSessionEventListener({
                gateway,
                runtimeSessionId,
                sessionDisplayTitle:
                  hermesSessionItemsRef.current.find((session) => session.id === sessionId)
                    ?.title ?? "Agent session",
                storedSessionId: sessionId,
              });
            }
          } catch {
            // The runtime session may be gone; the poll reconciles it.
          }
        }),
      );
    } catch {
      // Reconnect failed — fall back to the persisted-message poll.
    } finally {
      gatewayRecoveringRef.current.delete(fullMode);
    }
    // Feature 04: the gateway is back. Any non-approval pending action not
    // re-announced by a fresh event is unverifiable across the drop, so mark it
    // stale rather than silently dropping a possible blocker. Approvals were
    // already retired above because the gateway drains them fail closed.
    pendingActionStore.reconcileAfterReconnect();
    for (const sessionId of activeSessionIds) {
      void refreshHermesSession(sessionId);
    }
  }

  async function startBridge(fullMode?: boolean) {
    setBridgeStarting(true);
    setError(null);
    try {
      const status = await startHermesBridge(undefined, fullMode);
      setBridge(status);
      await refreshActiveHermesProfile({ status, mode: fullMode ? "unrestricted" : "sandboxed" });
      return status;
    } catch (err) {
      const message = messageFromError(err);
      setError(message);
      throw err;
    } finally {
      setBridgeStarting(false);
    }
  }

  // Message-based reconciliation above can only END a run when an assistant
  // reply eventually persists. A run that died without one (provider failure,
  // gateway drop, app quit mid-turn) — or a session wrongly resumed as
  // working from a trailing user message — would otherwise stay "working"
  // forever, leaving the menu bar stuck on "Working…". The gateway's
  // session.active_list is ground truth for what is actually running, so any
  // locally-working session absent from it (or sitting idle) for two
  // consecutive polls gets its activity cleared. Two misses, not one: a
  // just-submitted prompt can race the runtime session registering.
  async function liveRuntimeSessionsForModes(modes: boolean[]) {
    let rows: Array<{ id?: string; session_key?: string; status?: string }> = [];
    const reachableModes = new Set<boolean>();
    for (const mode of modes) {
      try {
        const gateway = await ensureHermesGateway(mode);
        const response = await gateway.request<{
          sessions?: Array<{
            id?: string;
            session_key?: string;
            status?: string;
          }>;
        }>("session.active_list", {});
        rows = rows.concat(Array.isArray(response?.sessions) ? response.sessions : []);
        reachableModes.add(mode);
      } catch {
        // Can't reach this runtime — keep ITS sessions' current state rather
        // than guess, while the reachable mode still reconciles below.
      }
    }
    const live = new Set<string>();
    for (const row of rows) {
      // "idle" means the runtime session exists but isn't processing a turn.
      if (!row || row.status === "idle") continue;
      if (row.session_key) live.add(String(row.session_key));
      if (row.id) live.add(String(row.id));
    }
    return { live, reachableModes };
  }

  function runtimeSnapshotHasSession(snapshot: { live: Set<string> }, sessionId: string) {
    const runtimeSessionId = runtimeSessionIdsRef.current[sessionId];
    return (
      snapshot.live.has(sessionId) ||
      Boolean(runtimeSessionId && snapshot.live.has(runtimeSessionId))
    );
  }

  function cancelAgentRunSettlement(storedSessionId: string) {
    cancelAgentRunMonitoring(storedSessionId);
  }

  function hasAutomaticContinuation(storedSessionId: string) {
    if (pendingAttachmentPreparationsRef.current[storedSessionId]?.size) return true;
    if (pendingSteerBySessionIdRef.current[storedSessionId]?.length) return true;
    // A failed row is still unresolved continuation work: announcing "ready"
    // after its delivery error would contradict the needs-input alert and the
    // visible Retry action.
    return (queuedAttachmentFollowUpsRef.current[storedSessionId] ?? []).length > 0;
  }

  function watchCompletedAgentRunSettle(storedSessionId: string) {
    if (hasAutomaticContinuation(storedSessionId)) return;
    releaseAgentRunSettlement(storedSessionId);
  }

  async function reconcileWorkingSessionsAgainstRuntime() {
    const working = Array.from(workingSessionIdsRef.current);
    const misses = workingReconcileMissesRef.current;
    for (const sessionId of misses.keys()) {
      if (!working.includes(sessionId)) misses.delete(sessionId);
    }
    if (working.length === 0) return;
    // Working sessions may span both runtime processes; ask each mode that
    // has one and union the answers. A mode we can't reach keeps its
    // sessions' current state rather than guessing — so a one-gateway
    // failure must not mark the other mode's sessions dead either.
    const modes = Array.from(new Set(working.map((sessionId) => sessionUnrestricted(sessionId))));
    const snapshot = await liveRuntimeSessionsForModes(modes);
    if (snapshot.reachableModes.size === 0) return;
    for (const sessionId of working) {
      // Sessions of an unreachable mode were not in any answer we got;
      // counting them as misses would mark live work dead.
      if (!snapshot.reachableModes.has(sessionUnrestricted(sessionId))) continue;
      if (runtimeSnapshotHasSession(snapshot, sessionId)) {
        misses.delete(sessionId);
        continue;
      }
      const seen = (misses.get(sessionId) ?? 0) + 1;
      if (seen < 2) {
        misses.set(sessionId, seen);
        continue;
      }
      misses.delete(sessionId);
      const freshMessages = await refreshHermesSession(sessionId);
      if (!freshMessages) continue;
      if (sessionHasAssistantAfterLatestUser(freshMessages)) {
        // refreshHermesSession already saw the assistant reply while this
        // session still counted as active, so it dispatched the terminal
        // "June finished." status and cleared activity — dispatching a
        // second completed status here would overwrite that summary.
        continue;
      }
      const title =
        hermesSessionItems.find((session) => session.id === sessionId)?.title ?? "Agent session";
      const summary = "June stopped before replying.";
      recordSessionErrorActivity(sessionId, summary);
      setError(summary, { sessionId });
      dispatchAgentSessionStatus({
        sessionId,
        title,
        status: "failed",
        summary,
        ...agentActivityCountsFromStore(),
      });
    }
  }

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

  async function respondToApproval(
    liveEventKey: string,
    sessionId: string,
    requestId: string,
    choice: AgentApprovalChoice,
    unrestricted = false,
  ) {
    const responseKey = approvalResponseKey(liveEventKey, requestId);
    // The card disables on the next render; guard synchronously too so a rapid
    // second activation cannot target the same logical approval twice.
    if (approvalResponsesInFlightRef.current.has(responseKey)) return;
    approvalResponsesInFlightRef.current.set(responseKey, choice);
    setApprovalSubmitting((current) => ({ ...current, [requestId]: choice }));
    try {
      // The approval lives in the runtime process that asked, so the
      // response must go out on that mode's gateway.
      const gateway = await ensureHermesGateway(unrestricted);
      hermesTraceBuffer.recordOutbound({
        sessionId: liveEventKey,
        method: "approval.respond",
        params: { session_id: sessionId, request_id: requestId, choice },
      });
      const response = await gateway.request<unknown>("approval.respond", {
        session_id: sessionId,
        request_id: requestId,
        choice,
      });
      if (
        response === null ||
        typeof response !== "object" ||
        Array.isArray(response) ||
        !("resolved" in response) ||
        (response.resolved !== 0 && response.resolved !== 1)
      ) {
        setError("June could not confirm the approval outcome. Reconnect, then try again.", {
          sessionId: liveEventKey,
        });
        return;
      }
      if (response.resolved === 0) {
        const expiration = classifyOptimisticLiveEvent({
          type: "approval.expire",
          session_id: sessionId,
          payload: { request_id: requestId, reason: "stale" },
        });
        pushLiveEvent(liveEventKey, expiration);
        pendingActionStore.expireRequest(liveEventKey, requestId, "stale");
        recordOptimisticHermesActivityAndDispatchStatus(expiration, liveEventKey);
        setError("This approval is no longer pending. Nothing was approved.", { sessionId });
        return;
      }
      const resolution = classifyOptimisticLiveEvent({
        type: "approval.response",
        session_id: sessionId,
        payload: { request_id: requestId, choice },
      });
      pushLiveEvent(liveEventKey, resolution);
      // Feature 04: the user just answered this approval — clear its global
      // "Needs you" row immediately (the response itself is the resolution).
      pendingActionStore.resolveRequest(liveEventKey, requestId);
      recordOptimisticHermesActivityAndDispatchStatus(resolution, liveEventKey);
      setError(null);
    } catch (err) {
      const message = messageFromError(err);
      if (isSessionGoneError(message)) {
        // The runtime session is gone. Scrub only the affected session/task —
        // including its waiting flag, so the "Needs you" badge clears —
        // without clobbering other healthy sessions' working state or live
        // event streams.
        setWorkingTaskIds((current) => {
          if (!current.has(liveEventKey)) return current;
          const next = new Set(current);
          next.delete(liveEventKey);
          return next;
        });
        for (const key of new Set([liveEventKey, sessionId])) {
          sessionGatewayUnlistenRef.current.get(key)?.();
          clearSessionActivity(key);
        }
        liveEventsRef.current = omitRecordKey(liveEventsRef.current, liveEventKey);
        setLiveEvents(liveEventsRef.current);
        // The request can never be answered now — retire its card so neither the
        // sidebar count nor the inline prompt offers a dead-end "Respond".
        pendingActionStore.expireRequest(liveEventKey, requestId, "disconnect");
        void loadHermesSessions();
        setError(SESSION_GONE_MESSAGE, { sessionId });
      } else {
        setError(message, { sessionId });
      }
    } finally {
      approvalResponsesInFlightRef.current.delete(responseKey);
      setApprovalSubmitting((current) => {
        const next = { ...current };
        delete next[requestId];
        return next;
      });
    }
  }

  async function respondToClarify(
    liveEventKey: string,
    requestId: string,
    answer: string,
    unrestricted = false,
  ) {
    setClarifySubmitting((current) => ({ ...current, [requestId]: answer }));
    try {
      const gateway = await ensureHermesGateway(unrestricted);
      await gateway.request("clarify.respond", {
        request_id: requestId,
        answer,
      });
      const resolution = classifyOptimisticLiveEvent({
        type: "clarify.response",
        payload: { request_id: requestId, answer },
      });
      pushLiveEvent(liveEventKey, resolution);
      // Feature 04: the user answered the clarification — clear its pending record.
      pendingActionStore.resolveRequest(liveEventKey, requestId);
      recordOptimisticHermesActivityAndDispatchStatus(resolution, liveEventKey);
      setError(null);
    } catch (err) {
      const message = messageFromError(err);
      if (isSessionGoneError(message)) {
        // The runtime is gone, so this clarification can never be answered —
        // retire its card and say so plainly instead of leaking the raw 404.
        pendingActionStore.resolveRequest(liveEventKey, requestId);
        setError(SESSION_GONE_MESSAGE);
      } else {
        setError(message);
      }
    } finally {
      setClarifySubmitting((current) => {
        const next = { ...current };
        delete next[requestId];
        return next;
      });
    }
  }

  // Sudo (privilege escalation) is resolved through the typed control-plane
  // method (sudo.respond), not a hand-written request, so the wire shape stays
  // in one place. The optimistic sudo.response event flips the card to
  // resolved before the gateway round-trips.
  async function respondToSudo(
    liveEventKey: string,
    sessionId: string,
    requestId: string,
    approved: boolean,
    mode?: HermesMode,
    unrestricted = false,
  ) {
    setSudoSubmitting((current) => ({
      ...current,
      [requestId]: approved ? "approve" : "deny",
    }));
    try {
      const gateway = await ensureHermesGateway(unrestricted);
      await createHermesMethods(gateway).respondToSudo({
        sessionId,
        requestId,
        approved,
        mode,
      });
      const resolution = classifyOptimisticLiveEvent({
        type: "sudo.response",
        session_id: sessionId,
        payload: { request_id: requestId, granted: approved, mode },
      });
      pushLiveEvent(liveEventKey, resolution);
      // Feature 04: the user resolved the sudo prompt — clear its pending record.
      pendingActionStore.resolveRequest(liveEventKey, requestId);
      recordOptimisticHermesActivityAndDispatchStatus(resolution, liveEventKey);
      setError(null);
    } catch (err) {
      const message = messageFromError(err);
      if (isSessionGoneError(message)) {
        // The runtime is gone, so this prompt can never be answered — retire
        // its card and say so plainly instead of leaking the raw 404.
        pendingActionStore.resolveRequest(liveEventKey, requestId);
        setError(SESSION_GONE_MESSAGE, { sessionId });
      } else {
        setError(message, { sessionId });
      }
    } finally {
      setSudoSubmitting((current) => {
        const next = { ...current };
        delete next[requestId];
        return next;
      });
    }
  }

  // Secret entry: the value arrives here only to be handed to the gateway via
  // the typed secret.respond method, and is never stored, logged, or placed on
  // an event. The optimistic secret.response carries ONLY a `provided` flag.
  async function respondToSecret(
    liveEventKey: string,
    sessionId: string,
    requestId: string,
    value: string,
    unrestricted = false,
  ) {
    setSecretSubmitting((current) => ({ ...current, [requestId]: true }));
    try {
      const gateway = await ensureHermesGateway(unrestricted);
      await createHermesMethods(gateway).respondToSecret({
        sessionId,
        requestId,
        value,
      });
      const resolution = classifyOptimisticLiveEvent({
        type: "secret.response",
        session_id: sessionId,
        payload: { request_id: requestId, provided: true },
      });
      pushLiveEvent(liveEventKey, resolution);
      // Feature 04: the user provided the secret — clear its pending record.
      pendingActionStore.resolveRequest(liveEventKey, requestId);
      recordOptimisticHermesActivityAndDispatchStatus(resolution, liveEventKey);
      setError(null);
    } catch (err) {
      const message = messageFromError(err);
      if (isSessionGoneError(message)) {
        // The runtime is gone, so this secret prompt can never be answered —
        // retire its card and say so plainly instead of leaking the raw 404.
        pendingActionStore.resolveRequest(liveEventKey, requestId);
        setError(SESSION_GONE_MESSAGE, { sessionId });
      } else {
        setError(message, { sessionId });
      }
    } finally {
      setSecretSubmitting((current) => {
        const next = { ...current };
        delete next[requestId];
        return next;
      });
    }
  }

  // One-click approval of June's in-chat [REQUEST:AGENT_CLI_ACCESS] card.
  // The agent can never flip the setting itself (the flag lives outside the
  // sandbox's write roots), so the click is the trust boundary: it persists
  // the opt-in, which also retires the sandboxed runtime, and the follow-up
  // send respawns it with the CLI state folders writable and hands the
  // conversation back to June to retry.
  async function enableCliAccessFromChat() {
    const targetStoredSessionId = selectedHermesSessionIdRef.current;
    const targetSession = targetStoredSessionId
      ? hermesSessionItemsRef.current.find((session) => session.id === targetStoredSessionId)
      : undefined;
    const modelTarget = captureSessionModelTarget(targetSession);
    const dispatchReservation = targetStoredSessionId
      ? reserveComposerDispatch(targetStoredSessionId)
      : undefined;
    setCliAccessSubmitting(true);
    try {
      await setHermesAgentCliAccess(true);
      if (composerDispatchWasInvalidated(dispatchReservation)) return;
      setCliAccessEnabled(true);
      if (!targetSession) {
        throw new Error("This session is no longer available.");
      }
      await submitHermesSession(AGENT_CLI_ACCESS_ENABLED_MESSAGE, targetSession, {
        modelTarget,
        dispatchReservation,
        selectSession: false,
      });
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      cancelComposerDispatch(dispatchReservation);
      setCliAccessSubmitting(false);
    }
  }

  // One-click approval of June's in-chat [REQUEST:BROWSER_ACCESS] card. Same
  // trust boundary as the CLI access card above: the click persists the
  // Browser access grant (the setter also retires both runtime modes), and
  // the follow-up send retries the turn that asked — the request-card path is
  // the only retried shape, so no completed tool call is ever re-issued.
  async function enableBrowserAccessFromChat() {
    setBrowserAccessSubmitting(true);
    try {
      await setHermesBrowserAccess(true);
      await registerBrowserExtensionHost();
      setBrowserAccessEnabled(true);
      await submitHermesSession(BROWSER_ACCESS_ENABLED_MESSAGE);
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBrowserAccessSubmitting(false);
    }
  }

  // Feature 07: fork the conversation into a NEW session that starts from the
  // given message, through the typed control-plane method (session.branch).
  // The source session is never mutated. The returned session id is
  // AUTHORITATIVE — we open whatever the gateway minted, never a local guess —
  // and the new session inherits the source's write-access mode so a follow-up
  // routes to the right runtime. On failure the UI stays in the source session
  // with an actionable banner.
  async function branchFromMessage(
    sessionId: string | undefined,
    fromMessageId: string,
    modeSessionId = sessionId,
  ) {
    if (branchingMessageIdRef.current) return;
    if (!sessionId) {
      setError("Cannot branch from this message because its session is unavailable.", {
        sessionId: modeSessionId ?? null,
      });
      return;
    }
    branchingMessageIdRef.current = fromMessageId;
    setBranchingMessageId(fromMessageId);
    const sourceTitle =
      hermesSessionItems.find((session) => session.id === sessionId || session.id === modeSessionId)
        ?.title ?? "this session";
    // The fork lifecycle rides one self-replacing toast: a loading toast while
    // the branch is created, upgraded in place to the "Branched from …"
    // confirmation on success, or dismissed if the branch fails (the failure
    // surfaces on the error banner instead).
    const branchToastId = toast.loading(`Creating branch from ${sourceTitle}`, {
      id: BRANCH_TOAST_ID,
    });
    let branched = false;
    const unrestricted = sessionUnrestricted(modeSessionId);
    try {
      const gateway = await ensureHermesGateway(unrestricted);
      const methods = createHermesMethods(gateway);
      const sourceMessages = hermesSessionMessages[sessionId] ?? [];
      const sourcePendingMessages = pendingHermesMessagesRef.current[sessionId] ?? [];
      const clickedMessageIndex = sourceMessages.findIndex(
        (message) => message.id === fromMessageId,
      );
      const clickedPersistedMessage =
        clickedMessageIndex >= 0 ? sourceMessages[clickedMessageIndex] : undefined;
      const clickedPendingMessage = sourcePendingMessages.find(
        (message) => message.id === fromMessageId,
      );
      const clickedMessage = clickedPersistedMessage ?? clickedPendingMessage;
      let branchAfterMessageIndex = -1;
      let branchRequestMessageId: string | undefined;
      let branchComposerText = "";

      if (clickedMessage?.role === "user") {
        const beforeIndex = clickedPersistedMessage ? clickedMessageIndex : sourceMessages.length;
        branchAfterMessageIndex = previousBranchableMessageIndex(sourceMessages, beforeIndex);
        branchRequestMessageId =
          branchAfterMessageIndex >= 0 ? sourceMessages[branchAfterMessageIndex]?.id : undefined;
        branchComposerText = visibleHermesMessageText(clickedMessage).trim();
      } else if (clickedPersistedMessage) {
        branchAfterMessageIndex = clickedMessageIndex;
        branchRequestMessageId = sourceMessages[branchAfterMessageIndex]?.id;
      } else if (isLiveAssistantTurnId(fromMessageId)) {
        branchAfterMessageIndex = liveAssistantBranchPointIndex(
          sourceMessages,
          sourcePendingMessages,
        );
        if (branchAfterMessageIndex < 0) {
          setError("Branching is available once the response is saved.", {
            sessionId: modeSessionId ?? null,
          });
          return;
        }
        branchRequestMessageId =
          branchAfterMessageIndex >= 0 ? sourceMessages[branchAfterMessageIndex]?.id : undefined;
      } else if (isBranchableMessageId(fromMessageId)) {
        branchRequestMessageId = fromMessageId;
      } else {
        setError("Branching is available once the message is saved.", {
          sessionId: modeSessionId ?? null,
        });
        return;
      }

      const branchSeedMessages =
        branchAfterMessageIndex >= 0 ? sourceMessages.slice(0, branchAfterMessageIndex + 1) : [];
      const branchVia = (runtimeId: string) =>
        methods.branchSession({ sessionId: runtimeId, fromMessageId: branchRequestMessageId });
      // Historical branches must start from the STORED source id first. Using a
      // cached live runtime id can branch from the current in-memory tip and
      // persist later messages past from_message_id. If the stored id is not
      // accepted by this Hermes pin, fall back to the live runtime path.
      let raw: unknown;
      try {
        raw = await branchVia(sessionId);
      } catch (err) {
        if (!isSessionGoneError(messageFromError(err))) throw err;
        let runtimeSessionId: string | undefined = runtimeSessionIdsRef.current[sessionId];
        if (runtimeSessionId) {
          try {
            raw = await branchVia(runtimeSessionId);
          } catch (runtimeErr) {
            if (!isSessionGoneError(messageFromError(runtimeErr))) throw runtimeErr;
            runtimeSessionId = undefined;
          }
        }
        if (!runtimeSessionId) {
          const resumed = await gateway.request<HermesRuntimeSessionResponse>("session.resume", {
            session_id: sessionId,
            cols: 96,
          });
          runtimeSessionId = resumed.session_id;
          if (!runtimeSessionId) {
            throw new Error("Hermes did not resume the session.");
          }
          const resumedRuntimeSessionId = runtimeSessionId;
          setRuntimeSessionIds((current) => ({
            ...current,
            [sessionId]: resumedRuntimeSessionId,
          }));
          raw = await branchVia(resumedRuntimeSessionId);
        }
      }
      const result: BranchSessionResult | undefined = parseBranchSessionResult(raw, {
        sourceSessionId: sessionId,
        sourceMessageId: branchRequestMessageId,
      });
      if (!result) {
        throw new Error("Hermes did not return a branched session.");
      }
      let branchRuntimeSessionId = result.runtimeSessionId ?? result.sessionId;
      await finalizeHermesBridgeBranch({
        branchSessionId: result.sessionId,
        sourceSessionId: sessionId,
        keepMessageCount: branchSeedMessages.length,
        ...(branchRequestMessageId ? { throughMessageId: branchRequestMessageId } : {}),
      });
      // A branch belongs with its source conversation: copy the source's
      // profile mapping so the fork doesn't fall to default in the
      // profile-scoped chat list (ADR 0031). Best-effort — a missed stamp
      // surfaces the branch under default, it never loses the conversation.
      try {
        const assignments = await listSessionProfiles();
        const sourceProfile = assignments.find(
          (assignment) => assignment.sessionId === sessionId,
        )?.profile;
        if (sourceProfile && sourceProfile !== "default") {
          await assignSessionToProfile(result.sessionId, sourceProfile);
          profileOwnedSessionIdsRef.current.add(result.sessionId);
        }
      } catch {
        // Unmapped branches still appear under default; nothing is lost.
      }
      try {
        const resumedBranch = await gateway.request<HermesRuntimeSessionResponse>(
          "session.resume",
          {
            session_id: result.sessionId,
            cols: 96,
          },
        );
        if (resumedBranch.session_id) {
          branchRuntimeSessionId = resumedBranch.session_id;
        }
      } catch (err) {
        if (!isSessionGoneError(messageFromError(err))) throw err;
      }
      setRuntimeSessionIds((current) => {
        const next = {
          ...current,
          [result.sessionId]: branchRuntimeSessionId,
        };
        runtimeSessionIdsRef.current = next;
        return next;
      });
      // Carry the source session's write-access mode onto the fork so its
      // follow-ups route to the matching runtime (mirrors session.create).
      rememberSessionMode(result.sessionId, unrestricted);
      const branchDraftKey = sessionComposerDraftKey(result.sessionId);
      composerDraftKeyRef.current = branchDraftKey;
      restoredComposerDraftKeyRef.current = branchDraftKey;
      rememberComposerDraft(branchDraftKey, branchComposerText, null);
      draftRef.current = branchComposerText;
      categoryRef.current = null;
      attachmentsRef.current = [];
      setDraft(branchComposerText);
      setCategory(null);
      setAttachments([]);
      setHermesSessionMessages((current) => {
        const next = {
          ...current,
          [result.sessionId]: branchSeedMessages,
        };
        hermesSessionMessagesRef.current = next;
        return next;
      });
      setPendingHermesMessages((current) => {
        const next = {
          ...current,
          [result.sessionId]: [],
        };
        pendingHermesMessagesRef.current = next;
        return next;
      });
      liveEventsRef.current = {
        ...liveEventsRef.current,
        [result.sessionId]: [],
      };
      setLiveEvents(liveEventsRef.current);
      // Open the fork. Selecting it triggers the message-fetch effect, which
      // fills the forked transcript. The source session is left untouched.
      newSessionModeRef.current = false;
      setNewSessionMode(false);
      setSelectedTaskId(undefined);
      selectedHermesSessionIdRef.current = result.sessionId;
      setSelectedHermesSessionId(result.sessionId);
      setActivePanel("chat");
      branched = true;
      toast.success(`Branched from ${sourceTitle}`, { id: branchToastId });
      composerEditorRef.current?.setContent(branchComposerText, null);
      setError(null);
      await loadHermesSessions({ suppressSessionGoneError: true });
      window.requestAnimationFrame(() => composerEditorRef.current?.focus());
    } catch (err) {
      // Leave the UI in the source session; surface the failure there.
      const message = messageFromError(err);
      if (isSessionGoneError(message)) {
        void loadHermesSessions({ suppressSessionGoneError: true });
        setError(
          "Cannot branch from this message because the live session ended. Try again from the saved transcript.",
          { sessionId },
        );
      } else {
        setError(message, { sessionId });
      }
    } finally {
      branchingMessageIdRef.current = null;
      setBranchingMessageId(null);
      // A failed or aborted branch never resolves the loading toast; drop it so
      // the error banner is the only surface. Success already upgraded it.
      if (!branched) toast.dismiss(branchToastId);
    }
  }

  function classifyOptimisticLiveEvent(event: HermesGatewayEvent): JuneHermesEvent {
    return classifyHermesEvent({
      ...event,
      receivedAt: new Date().toISOString(),
    } as HermesGatewayEvent & { receivedAt: string });
  }

  function withStoredHermesSessionId(
    event: JuneHermesEvent,
    storedSessionId: string,
  ): JuneHermesEvent {
    return { ...event, sessionId: storedSessionId } as JuneHermesEvent;
  }

  function pushLiveEvent(key: string, event: JuneHermesEvent) {
    const nextEvents = appendHermesLiveEvent(liveEventsRef.current[key] ?? [], event);
    liveEventsRef.current = {
      ...liveEventsRef.current,
      [key]: nextEvents,
    };
    setLiveEvents(liveEventsRef.current);
  }

  function writeQueuedAttachmentFollowUps(next: Record<string, QueuedAttachmentFollowUp[]>) {
    queuedAttachmentFollowUpsRef.current = next;
    setQueuedAttachmentFollowUps(next);
  }

  function updateQueuedAttachmentFollowUps(
    queueKey: string,
    update: (items: QueuedAttachmentFollowUp[]) => QueuedAttachmentFollowUp[],
  ) {
    const nextItems = update(queuedAttachmentFollowUpsRef.current[queueKey] ?? []).sort(
      (left, right) =>
        (left.dispatchOrder ?? Number.MIN_SAFE_INTEGER) -
        (right.dispatchOrder ?? Number.MIN_SAFE_INTEGER),
    );
    const next = { ...queuedAttachmentFollowUpsRef.current };
    if (nextItems.length) {
      next[queueKey] = nextItems;
    } else {
      delete next[queueKey];
    }
    writeQueuedAttachmentFollowUps(next);
  }

  function discardSessionAttachmentFollowUps(storedSessionId: string) {
    for (const item of queuedAttachmentFollowUpsRef.current[storedSessionId] ?? []) {
      item.dispatchReservation?.cancel();
    }
    const pendingPreparations = pendingAttachmentPreparationsRef.current[storedSessionId];
    if (pendingPreparations) {
      for (const preparation of pendingPreparations.values()) {
        preparation.cancelled = true;
        cancelComposerDispatch(preparation.dispatchReservation);
      }
      delete pendingAttachmentPreparationsRef.current[storedSessionId];
    }
    completedAgentRunAwaitingAttachmentPreparationRef.current.delete(storedSessionId);
    updateQueuedAttachmentFollowUps(storedSessionId, () => []);
  }

  function enqueueAttachmentFollowUp(
    sessionId: string,
    prepared: PreparedComposerSubmission,
    queuedAttachments: AgentAttachment[],
    modelTarget: CapturedSessionModelTarget,
    dispatchReservation?: HermesSessionDispatchReservation,
    dispatchOrder?: number,
  ) {
    queuedAttachmentFollowUpSeqRef.current += 1;
    const item: QueuedAttachmentFollowUp = {
      id: `attachment-follow-up-${queuedAttachmentFollowUpSeqRef.current}`,
      prepared,
      attachments: queuedAttachments,
      modelTarget,
      dispatchReservation,
      dispatchOrder,
      status: "queued",
    };
    updateQueuedAttachmentFollowUps(sessionId, (items) => [...items, item]);
  }

  function enqueueFailedComposerFollowUp(
    queueKey: string,
    prepared: PreparedComposerSubmission,
    queuedAttachments: AgentAttachment[],
    modelTarget: CapturedSessionModelTarget,
    error: string,
    dispatchOrder?: number,
  ) {
    queuedAttachmentFollowUpSeqRef.current += 1;
    const item: QueuedAttachmentFollowUp = {
      id: `attachment-follow-up-${queuedAttachmentFollowUpSeqRef.current}`,
      prepared,
      attachments: queuedAttachments,
      modelTarget,
      dispatchOrder,
      status: "failed",
      error,
    };
    updateQueuedAttachmentFollowUps(queueKey, (items) => [...items, item]);
  }

  function removeQueuedAttachmentFollowUp(queueKey: string, itemId: string) {
    updateQueuedAttachmentFollowUps(queueKey, (items) => {
      const removed = items.find((item) => item.id === itemId && item.status !== "sending");
      removed?.dispatchReservation?.cancel();
      return items.filter((item) => item.id !== itemId || item.status === "sending");
    });
  }

  function editQueuedAttachmentFollowUp(queueKey: string, itemId: string) {
    const isNewSessionRecovery = queueKey === NEW_SESSION_RECOVERY_QUEUE_KEY;
    if (
      isNewSessionRecovery
        ? !newSessionModeRef.current
        : queueKey !== selectedHermesSessionIdRef.current
    ) {
      return;
    }
    if (draftRef.current.trim() || attachmentsRef.current.length) return;
    const item = queuedAttachmentFollowUpsRef.current[queueKey]?.find(
      (candidate) => candidate.id === itemId,
    );
    if (!item || item.status === "sending") return;
    removeQueuedAttachmentFollowUp(queueKey, itemId);
    draftRef.current = item.prepared.typedMessage;
    categoryRef.current = null;
    attachmentsRef.current = item.attachments;
    setDraft(item.prepared.typedMessage);
    setCategory(null);
    setAttachments(item.attachments);
    rememberComposerDraft(
      composerDraftKeyRef.current,
      item.prepared.typedMessage,
      null,
      item.attachments,
    );
    composerEditorRef.current?.setContent(item.prepared.typedMessage);
  }

  async function deliverQueuedAttachmentFollowUp(
    queueKey: string,
    itemId?: string,
    options: { afterCompletion?: boolean } = {},
  ) {
    const isNewSessionRecovery = queueKey === NEW_SESSION_RECOVERY_QUEUE_KEY;
    if (
      !isNewSessionRecovery &&
      !options.afterCompletion &&
      workingSessionIdsRef.current.has(queueKey)
    ) {
      return false;
    }
    const queued = queuedAttachmentFollowUpsRef.current[queueKey] ?? [];
    const item = itemId ? queued.find((candidate) => candidate.id === itemId) : queued[0];
    if (!item || item.status === "sending") return false;
    // Automatic advancement (no itemId) stops at a failed head rather than
    // resending it: the row's UI is an explicit Retry, and silently resending
    // a message the user watched fail - possibly with an image already
    // attached - is worse than holding the queue until they decide.
    if (!itemId && item.status === "failed") return false;
    const session = isNewSessionRecovery
      ? undefined
      : hermesSessionItemsRef.current.find((candidate) => candidate.id === queueKey);
    if (!isNewSessionRecovery && !session) {
      const summary = "This session is no longer available.";
      item.dispatchReservation?.cancel();
      updateQueuedAttachmentFollowUps(queueKey, (items) =>
        items.map((candidate) =>
          candidate.id === item.id
            ? {
                ...candidate,
                dispatchReservation: undefined,
                status: "failed",
                error: summary,
              }
            : candidate,
        ),
      );
      cancelAgentRunSettlement(queueKey);
      dispatchAgentSessionStatus({
        sessionId: queueKey,
        title: "Agent session",
        status: "failed",
        summary,
      });
      return false;
    }
    const dispatchReservation =
      item.dispatchReservation ??
      (!isNewSessionRecovery ? reserveHermesSessionDispatch(queueKey) : undefined);
    updateQueuedAttachmentFollowUps(queueKey, (items) =>
      items.map((candidate) =>
        candidate.id === item.id
          ? { ...candidate, dispatchReservation, status: "sending", error: undefined }
          : candidate,
      ),
    );
    try {
      await submitHermesSession(item.prepared.runtimeContent, session, {
        displayContent: item.prepared.displayContent,
        titleContent: item.prepared.titleContent,
        attachments: item.attachments,
        modelTarget: isNewSessionRecovery
          ? { ...item.modelTarget, targetStoredSessionId: null }
          : item.modelTarget,
        dispatchReservation,
        ...(isNewSessionRecovery ? {} : { selectSession: false }),
        onAttachmentsUpdated: (nextAttachments) => {
          updateQueuedAttachmentFollowUps(queueKey, (items) =>
            items.map((candidate) =>
              candidate.id === item.id ? { ...candidate, attachments: nextAttachments } : candidate,
            ),
          );
        },
      });
      updateQueuedAttachmentFollowUps(queueKey, (items) =>
        items.filter((candidate) => candidate.id !== item.id),
      );
      return true;
    } catch (err) {
      dispatchReservation?.cancel();
      const failedAttachments = err instanceof AttachBlockedError ? err.attachments : undefined;
      updateQueuedAttachmentFollowUps(queueKey, (items) =>
        items.map((candidate) =>
          candidate.id === item.id
            ? {
                ...candidate,
                ...(failedAttachments ? { attachments: failedAttachments } : {}),
                dispatchReservation: undefined,
                status: "failed",
                error: messageFromError(err),
              }
            : candidate,
        ),
      );
      return false;
    }
  }

  function continueAfterCompletedAgentRun(storedSessionId: string, source?: symbol) {
    const continuingSources = continuingCompletedAgentRunSourcesRef.current;
    if (continuingSources.has(storedSessionId)) {
      const continuingSource = continuingSources.get(storedSessionId);
      if (source && source !== continuingSource) {
        pendingCompletedAgentRunSourcesRef.current.set(storedSessionId, source);
      }
      return;
    }
    continuingSources.set(storedSessionId, source);
    const finishContinuation = (watchForSettlement: boolean) => {
      continuingSources.delete(storedSessionId);
      const pendingSource = pendingCompletedAgentRunSourcesRef.current.get(storedSessionId);
      if (pendingSource) {
        pendingCompletedAgentRunSourcesRef.current.delete(storedSessionId);
        continueAfterCompletedAgentRun(storedSessionId, pendingSource);
        return;
      }
      if (watchForSettlement) watchCompletedAgentRunSettle(storedSessionId);
    };
    const submittedSteers = pendingSteerBySessionIdRef.current[storedSessionId] ?? [];
    const unconsumedSteers = submittedSteers.filter(
      (entry) => !(entry.accepted && entry.toolDrained),
    );
    for (const entry of submittedSteers) {
      if (!unconsumedSteers.includes(entry)) entry.dispatchReservation?.cancel();
    }
    clearSubmittedSteers(storedSessionId, { preserveReservations: true });
    // Transfer undrained steers into the durable queue before yielding a tick.
    // An unmount can then preserve their FIFO reservations in continuity.
    const steerFollowUps = unconsumedSteers.map((entry) => {
      queuedAttachmentFollowUpSeqRef.current += 1;
      return {
        id: `attachment-follow-up-${queuedAttachmentFollowUpSeqRef.current}`,
        prepared: {
          displayContent: entry.text,
          runtimeContent: entry.text,
          titleContent: entry.text,
          typedMessage: entry.text,
        },
        attachments: [],
        modelTarget: entry.modelTarget,
        dispatchReservation: entry.dispatchReservation,
        dispatchOrder: entry.dispatchOrder,
        status: "queued" as const,
      };
    });
    if (steerFollowUps.length) {
      updateQueuedAttachmentFollowUps(storedSessionId, (items) => [...items, ...steerFollowUps]);
    }
    window.setTimeout(async () => {
      const pendingPreparations = pendingAttachmentPreparationsRef.current[storedSessionId];
      const queueHead = queuedAttachmentFollowUpsRef.current[storedSessionId]?.[0];
      const earliestPendingPreparationOrder = pendingPreparations?.size
        ? Math.min(...pendingPreparations.keys())
        : undefined;
      const queueHeadOrder = queueHead?.dispatchOrder ?? Number.MAX_SAFE_INTEGER;
      if (
        earliestPendingPreparationOrder !== undefined &&
        earliestPendingPreparationOrder < queueHeadOrder
      ) {
        completedAgentRunAwaitingAttachmentPreparationRef.current.add(storedSessionId);
        finishContinuation(false);
        return;
      }
      if (steerFollowUps.length) {
        const followUpSession = hermesSessionItemsRef.current.find(
          (session) => session.id === storedSessionId,
        );
        if (!followUpSession) {
          for (const followUp of steerFollowUps) {
            removeQueuedAttachmentFollowUp(storedSessionId, followUp.id);
          }
          finishContinuation(false);
          return;
        }
        // Each Send captured its own model and FIFO position. Dispatch the
        // merged queue head; later completions advance one agent run at a time.
        let followUpStarted = false;
        try {
          followUpStarted = await deliverQueuedAttachmentFollowUp(storedSessionId, undefined, {
            afterCompletion: true,
          });
        } catch (err) {
          setError(messageFromError(err), { sessionId: storedSessionId });
        } finally {
          finishContinuation(!followUpStarted);
        }
        return;
      }
      let followUpStarted = false;
      try {
        followUpStarted = await deliverQueuedAttachmentFollowUp(storedSessionId, undefined, {
          afterCompletion: true,
        });
      } finally {
        finishContinuation(!followUpStarted);
      }
    }, 0);
  }

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

  async function startNewTask(
    request?: AgentNewSessionDetail,
    options: { deferSeed?: boolean } = {},
  ) {
    clearPendingNewSessionRequest();
    const seedCategory = request?.category ?? null;
    const seedNoteRef = seedCategory ? null : (request?.noteRef ?? null);
    const seedPrompt = request?.prompt?.trim() ?? "";
    // A seeded report never auto-submits: the direct report dialog opens for
    // the user to describe the issue and submit it without a model turn.
    // A seeded note reference follows the same rule: the chip lands in the
    // composer and the user decides what to send.
    const initialPrompt = seedCategory || seedNoteRef ? "" : seedPrompt;
    // The pending-marker mount path and the AGENT_NEW_SESSION_EVENT dispatch
    // can deliver the same request twice (App marks the marker, then fires
    // the event in a setTimeout for already-mounted workspaces). Submitting
    // both would put two copies of the prompt in the transcript — drop the
    // echo instead.
    if (initialPrompt) {
      const last = lastAutoSubmittedRef.current;
      if (
        last &&
        last.prompt === initialPrompt &&
        Date.now() - last.at < AUTO_SUBMIT_ECHO_WINDOW_MS
      ) {
        return;
      }
      lastAutoSubmittedRef.current = { prompt: initialPrompt, at: Date.now() };
    }
    newSessionModeRef.current = true;
    setNewSessionMode(true);
    setActivePanel("chat");
    setSelectedTaskId(undefined);
    selectedHermesSessionIdRef.current = undefined;
    composerDraftKeyRef.current = NEW_SESSION_DRAFT_KEY;
    setSelectedHermesSessionId(undefined);
    // Seed the report dialog, a note chip, or the prompt. The editor may not
    // be mounted yet on a cold open, so stash note chips for ComposerEditor's
    // onReady to pick up and also try to apply now.
    pendingSeedNoteRefRef.current = seedNoteRef
      ? {
          noteRef: seedNoteRef,
          prompt: seedPrompt,
        }
      : null;
    if (seedCategory) {
      pendingSeedNoteRefRef.current = null;
      clearComposerDraft(NEW_SESSION_DRAFT_KEY);
      openReportDialog(seedCategory);
    } else if (seedNoteRef) {
      clearComposerDraft(NEW_SESSION_DRAFT_KEY);
      seedComposerNoteRef({ defer: options.deferSeed });
    } else if (initialPrompt) {
      rememberComposerDraft(NEW_SESSION_DRAFT_KEY, initialPrompt, null);
      composerEditorRef.current?.setContent(initialPrompt);
    } else {
      restoreComposerDraft(NEW_SESSION_DRAFT_KEY);
    }
    if (!initialPrompt) return;
    dispatchAgentSessionStatus({
      prompt: initialPrompt,
      title: titleFromPrompt(initialPrompt),
      status: "starting",
      summary: "Starting June.",
    });
    setSubmittingHermesSessionId(null);
    setSubmitting(true);
    // The seeded text is now the submitted message, not a composer draft. Clear
    // it before the optimistic session migrates draft storage to its durable id;
    // otherwise the same text reappears in the composer below its user bubble.
    clearComposerDraft(NEW_SESSION_DRAFT_KEY);
    try {
      await submitHermesSession(initialPrompt);
      setError(null);
    } catch (err) {
      composerEditorRef.current?.setContent(initialPrompt);
      rememberComposerDraft(NEW_SESSION_DRAFT_KEY, initialPrompt, null);
      setError(messageFromError(err));
      dispatchAgentSessionStatus({
        prompt: initialPrompt,
        title: titleFromPrompt(initialPrompt),
        status: "failed",
        summary: messageFromError(err),
      });
    } finally {
      setSubmitting(false);
      setSubmittingHermesSessionId(null);
    }
  }

  function clearComposerDraft(key = composerDraftKeyRef.current) {
    draftRef.current = "";
    categoryRef.current = null;
    attachmentsRef.current = [];
    setDraft("");
    setCategory(null);
    setAttachments([]);
    forgetComposerDraft(key);
    composerEditorRef.current?.clear();
  }

  function restoreComposerDraft(key: string | null) {
    const editor = composerEditorRef.current;
    if (!editor) return;
    restoredComposerDraftKeyRef.current = key;
    const snapshot = readComposerDraft(key);
    draftRef.current = snapshot?.text ?? "";
    categoryRef.current = snapshot?.category ?? null;
    attachmentsRef.current = snapshot?.attachments ?? [];
    setDraft(snapshot?.text ?? "");
    setCategory(snapshot?.category ?? null);
    setAttachments(snapshot?.attachments ?? []);
    editor.setContent(snapshot?.text ?? "", snapshot?.category ?? null, {
      focus: false,
    });
  }

  function setComposerAttachments(
    nextValue: AgentAttachment[] | ((current: AgentAttachment[]) => AgentAttachment[]),
  ) {
    setAttachments((current) => {
      const next = typeof nextValue === "function" ? nextValue(current) : nextValue;
      attachmentsRef.current = next;
      rememberComposerDraft(
        composerDraftKeyRef.current,
        draftRef.current,
        categoryRef.current,
        next,
      );
      return next;
    });
  }

  function openReportDialog(categoryToOpen: ReportCategory) {
    setAttachMenuOpen(false);
    // Every entry-point open is a fresh report intent, so start clean —
    // even when reopening the same category. An abandoned draft (closed
    // without sending) must not survive close, because its stale
    // attachments (screenshots, logs) could ride into a later report
    // unnoticed. Bumping the generation also invalidates any in-flight
    // attachment import from the abandoned draft (see
    // reportDialogAppendForCurrentGeneration). Switching categories INSIDE
    // the open dialog still keeps the in-progress form — that lives in the
    // dialog's own category selector and is unaffected.
    reportDialogGenerationRef.current += 1;
    setReportDialogDescription("");
    setReportDialogAttachments([]);
    setReportDialogCategory(categoryToOpen);
    setReportDialogOpen(true);
  }

  /** Drops appends from imports that were still in flight when the report
   * was sent or the dialog was reopened: without this a slow import
   * repopulates the cleared attachment state and haunts the next report.
   * Both send and the next open bump the generation, so a mid-flight import
   * from an abandoned draft is discarded rather than resurfaced. */
  function reportDialogAppendForCurrentGeneration() {
    const generation = reportDialogGenerationRef.current;
    return (attachments: ReportDialogAttachment[]) => {
      if (generation === reportDialogGenerationRef.current) {
        addReportDialogAttachments(attachments);
      }
    };
  }

  async function pickReportDialogAttachments() {
    const append = reportDialogAppendForCurrentGeneration();
    setImportingFiles(true);
    try {
      const selected = await openFileDialog({
        multiple: true,
        title: "Attach files",
      });
      if (!selected) return false;

      const selectedPaths = Array.isArray(selected) ? selected : [selected];
      const uniquePaths = Array.from(new Set(selectedPaths.filter((path) => path.trim())));
      append(
        uniquePaths.map((path) => ({
          id: `${path}:${Date.now()}:${Math.random().toString(36)}`,
          name: path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path,
          path,
        })),
      );
      setError(null);
      return true;
    } catch (err) {
      setError(messageFromError(err));
      return false;
    } finally {
      setImportingFiles(false);
    }
  }

  function importReportDialogDroppedFiles(files: File[]) {
    return importDroppedFiles(files, {
      onImported: reportDialogAppendForCurrentGeneration(),
      maxFiles: 20,
    });
  }

  function removeReportDialogAttachment(id: string) {
    setReportDialogAttachments((current) => current.filter((item) => item.id !== id));
  }

  // Clears the draft once a dialog report is delivered. The dialog stays
  // open showing its own confirmation (no chat notice for dialog sends —
  // the pill is legacy chip-flow only); closing it is the user's move.
  function handleReportDialogSent() {
    reportDialogGenerationRef.current += 1;
    setReportDialogDescription("");
    setReportDialogAttachments([]);
    setError(null);
  }

  /** Applies any pending note reference to the composer once the editor is
   * available for cold-open note entry points. */
  function seedComposerNoteRef(options: { defer?: boolean } = {}) {
    if (!pendingSeedNoteRefRef.current) return;
    const editor = composerEditorRef.current;
    const tiptapEditor = composerTiptapEditorRef.current;
    // Not mounted yet (cold open) — leave it pending for onReady to apply.
    if (!editor || !tiptapEditor || tiptapEditor.isDestroyed) return;
    const applySeed = () => {
      const seed = pendingSeedNoteRefRef.current;
      const currentEditor = composerEditorRef.current;
      const currentTiptapEditor = composerTiptapEditorRef.current;
      if (!seed || !currentEditor || !currentTiptapEditor || currentTiptapEditor.isDestroyed) {
        return;
      }
      pendingSeedNoteRefRef.current = null;
      draftRef.current = `${noteReferenceToken(seed.noteRef)} ${seed.prompt}`;
      categoryRef.current = null;
      setDraft(draftRef.current);
      setCategory(null);
      rememberComposerDraft(NEW_SESSION_DRAFT_KEY, draftRef.current, null);
      restoredComposerDraftKeyRef.current = NEW_SESSION_DRAFT_KEY;
      currentEditor.setContent("", null);
      currentEditor.insertNoteReference(seed.noteRef);
      if (seed.prompt) {
        // String insertContent parses HTML; a node insert keeps the prompt literal.
        currentTiptapEditor
          .chain()
          .focus()
          .insertContent({ type: "text", text: seed.prompt })
          .run();
      } else {
        currentEditor.focus();
      }
    };
    if (options.defer) {
      window.setTimeout(applySeed, 0);
    } else {
      applySeed();
    }
  }

  // Shortcuts never submit on click — they stage the prompt in the composer
  // so the person reads what will run and sends it themselves. The click is
  // free; only the explicit send spends tokens.
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

  async function cancelTask(taskId: string) {
    try {
      upsertTask(await cancelAgentTask(taskId));
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  // Stops a running June turn: interrupts the runtime session over the
  // gateway, then records a terminal activity-store level regardless — the
  // user asked for it to stop, so the UI must not stay "thinking" even when
  // the RPC fails (gateway drop, runtime session already gone).
  async function stopHermesSession(sessionId: string) {
    if (stoppingSessionIds.has(sessionId)) return;
    // Revoke the native broker before waiting for the Hermes interrupt. This
    // cancels pending approvals, kills the helper, clears captures, and makes
    // Stop sticky until a later visible chat turn opens a fresh lease.
    const computerUseStopRequest = computerUseStop().catch(() => undefined);
    computerUseRunLeasesRef.current.clear();
    cancelAgentRunSettlement(sessionId);
    setStoppingSessionIds((current) => new Set(current).add(sessionId));

    // Stop the UI FIRST, synchronously, before the interrupt RPC. Stopping
    // must feel instant: the moment the user clicks, the session reads as
    // stopped (the Stop control gives way to Send) rather than staying
    // "working" until the gateway round-trip acks. Tearing down the
    // per-session listener here also means a straggler "running" event
    // arriving while the interrupt is in flight can't flip the session back
    // to working (and on a gateway drop no terminal event ever comes to do
    // it). The interrupt then fires below to actually halt the runtime agent.
    sessionGatewayUnlistenRef.current.get(sessionId)?.();
    // Interrupting tears the listener down before any cancelled terminal event
    // reaches the terminal handler, so clear the delivery-guarantee steers here
    // too -- otherwise a steer typed-then-stopped lingers and could auto-submit
    // as a follow-up after a later run in the same session.
    clearSubmittedSteers(sessionId);
    const activityCounts = clearSessionActivity(sessionId, "cancelled");
    dispatchAgentSessionStatus({
      sessionId,
      title:
        hermesSessionItems.find((session) => session.id === sessionId)?.title ?? "Agent session",
      status: "cancelled",
      summary: "Stopped.",
      ...activityCounts,
    });

    try {
      await computerUseStopRequest;
      const runtimeSessionId = runtimeSessionIds[sessionId];
      if (runtimeSessionId) {
        const gateway = await ensureHermesGateway(sessionUnrestricted(sessionId));
        await gateway.request("session.interrupt", {
          session_id: runtimeSessionId,
        });
      }
    } catch {
      // The UI already reflects stopped; a failed interrupt (gateway down)
      // must not leave the session reading as working.
    } finally {
      setStoppingSessionIds((current) => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
      // Pull whatever the agent managed to persist before the interrupt so
      // the transcript reflects the partial turn.
      void refreshHermesSession(sessionId);
    }
  }

  // Feature 13: interrupt ONE background subagent from the activity drawer. The
  // drawer already vetted the target (active subagent, trustworthy id/handle,
  // confirmed when mid file/tool work) and owns the optimistic "stopping"
  // overlay, so this just routes the call to the gateway that owns the parent
  // session. `subagentId` is the trustworthy Hermes id/handle; the RPC's
  // session id is the runtime id (as the whole-session interrupt uses). The
  // promise is returned so the drawer can reconcile: a rejection (the subagent
  // already finished) drops the overlay and the row settles from the event
  // stream rather than showing a noisy failure.
  async function stopHermesSubagent({
    sessionId,
    subagentId,
  }: {
    sessionId: string;
    subagentId: string;
  }): Promise<unknown> {
    const runtimeSessionId = runtimeSessionIds[sessionId] ?? sessionId;
    const gateway = await ensureHermesGateway(sessionUnrestricted(sessionId));
    return createHermesMethods(gateway).interruptSubagent({
      sessionId: runtimeSessionId,
      subagentId,
    });
  }

  async function retryTask(taskId: string) {
    try {
      upsertTask(await retryAgentTask(taskId));
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function loadSkillCommands(options?: { silent?: boolean }) {
    if (skills) return skills;
    let loadPromise = skillCommandsLoadRef.current;
    if (!loadPromise) {
      setSkillCommandLoading(true);
      loadPromise = (async () => {
        await ensureHermesGateway();
        const nextSkills = await hermesBridgeSkills();
        setSkills(nextSkills);
        return nextSkills;
      })();
      skillCommandsLoadRef.current = loadPromise;
    }

    try {
      return await loadPromise;
    } catch (err) {
      if (!options?.silent) {
        throw new Error(`Skill commands are unavailable. ${messageFromError(err)}`);
      }
      return [];
    } finally {
      if (skillCommandsLoadRef.current === loadPromise) {
        skillCommandsLoadRef.current = null;
        setSkillCommandLoading(false);
      }
    }
  }

  async function loadCapabilities() {
    setCapabilityLoading(true);
    try {
      await ensureHermesGateway();
      const [nextSkills, nextToolsets] = await Promise.all([
        hermesBridgeSkills(),
        hermesBridgeToolsets(),
      ]);
      setSkills(nextSkills);
      setToolsets(nextToolsets);
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setCapabilityLoading(false);
    }
  }

  async function loadMessagingPlatforms() {
    setCapabilityLoading(true);
    try {
      await ensureHermesGateway();
      const response = await withTimeout(
        hermesBridgeMessagingPlatforms(),
        MESSAGING_PLATFORMS_LOAD_TIMEOUT_MS,
        MESSAGING_PLATFORMS_LOAD_TIMEOUT_MESSAGE,
      );
      setMessagingPlatforms(response.platforms);
      setSelectedMessagingPlatformId((current) => {
        if (current && response.platforms.some((item) => item.id === current)) {
          return current;
        }
        return response.platforms[0]?.id;
      });
      setError(null);
    } catch (err) {
      setMessagingPlatforms((current) => current ?? []);
      setError(messageFromError(err));
    } finally {
      setCapabilityLoading(false);
    }
  }

  async function loadFilesystemSnapshot() {
    const sessionId = selectedHermesSessionIdRef.current ?? null;
    setFilesystemLoading(true);
    try {
      await ensureHermesGateway();
      setFilesystemSnapshot(await hermesBridgeFilesystemSnapshot());
      // No setError(null): this refires in the background on message-count
      // changes, so a success would wipe an unrelated banner (e.g. a failed
      // send). The banner is dismissable instead.
    } catch (err) {
      const message = messageFromError(err);
      if (isSessionGoneError(message)) return;
      setError(message, { sessionId });
    } finally {
      setFilesystemLoading(false);
    }
  }

  // Manual rename. Records an override (same channel the auto-suggested titles
  // use) and marks the session so the suggester won't clobber the user's name.
  // The sessions-changed effect propagates it to the sidebar.
  function applyManualHermesSessionTitleLocally(sessionId: string, title: string) {
    const next = title.trim();
    if (!next) return null;
    rememberSessionManuallyTitled(sessionId);
    titleSuggestionSessionIdsRef.current.add(sessionId);
    sessionTitleOverridesRef.current = {
      ...sessionTitleOverridesRef.current,
      [sessionId]: next,
    };
    sessionTitleSourceRef.current = {
      ...sessionTitleSourceRef.current,
      [sessionId]: "manual",
    };
    const applyTitle = (sessions: HermesSessionInfo[]) =>
      sessions.map((item) => (item.id === sessionId ? { ...item, title: next } : item));
    hermesSessionItemsRef.current = applyTitle(hermesSessionItemsRef.current);
    setHermesSessionItems((current) => applyTitle(current));
    return next;
  }

  function renameHermesSession(sessionId: string, title: string) {
    const next = title.trim();
    const currentTitle =
      sessionTitleOverridesRef.current[sessionId] ??
      hermesSessionItems.find((item) => item.id === sessionId)?.title ??
      "";
    if (!next || next === currentTitle.trim()) return;
    const appliedTitle = applyManualHermesSessionTitleLocally(sessionId, next);
    if (!appliedTitle) return;
    void ensureHermesBridgeSession({ sessionId, title: appliedTitle }).catch(() => {
      setError("Could not save the session name. It may revert after a restart.", { sessionId });
    });
  }

  // Drops a deleted session from local state. Removing it from items fires
  // the sessions-changed effect, which syncs the sidebar; the shared scrub
  // clears messages, pending sends, activity-store state, and live events so a
  // running session doesn't linger as phantom "working" work.
  function removeHermesSessionLocally(sessionId: string, selectNext = true) {
    cancelAgentRunSettlement(sessionId);
    setHermesSessionItems((current) => {
      const next = current.filter((session) => session.id !== sessionId);
      setSelectedHermesSessionId((selected) => {
        const nextSelected =
          selected === sessionId ? (selectNext ? next[0]?.id : undefined) : selected;
        selectedHermesSessionIdRef.current = nextSelected;
        return nextSelected;
      });
      return next;
    });
    invalidateSessionComposerDispatches(sessionId);
    clearSubmittedSteers(sessionId);
    scrubHermesSessionState(sessionId);
    pendingIssueReportsRef.current.delete(sessionId);
    setReviewableIssueReport(sessionId, null);
    discardSessionAttachmentFollowUps(sessionId);
    forgetComposerDraft(sessionComposerDraftKey(sessionId));
    // Every deletion funnels through here (the in-workspace delete and the
    // sidebar/sessions-list AGENT_DELETE_SESSION_EVENT), so this is the one
    // place that drops the session's Unrestricted record — a stale entry
    // would hand full write access to any future session that recycled the
    // id.
    forgetSessionMode(sessionId);
    commitSessionModelSelections(forgetSessionModelSelection(sessionId));
    // Same for the session's thinking-level record.
    forgetSessionThinkingLevel(sessionId);
  }

  async function deleteSelectedHermesSession(sessionId: string) {
    try {
      await deleteHermesSession(sessionId);
      // Clearing the selection falls the workspace back to empty.
      removeHermesSessionLocally(sessionId, false);
    } catch (err) {
      setError(messageFromError(err), { sessionId });
    }
  }

  function applySessionTitleOverrides(sessions: HermesSessionInfo[]) {
    const overrides = sessionTitleOverridesRef.current;
    return sessions.map((session) => {
      const title = overrides[session.id];
      return title ? { ...session, title } : session;
    });
  }

  async function suggestTitleForUntitledSession(
    sessionId: string,
    messages: HermesSessionMessage[],
  ) {
    hermesSessionMessagesRef.current = {
      ...hermesSessionMessagesRef.current,
      [sessionId]: messages,
    };
    const source = sessionTitleSourceRef.current[sessionId];
    const settledTitleKind = sessionSettledTitleKind(sessionId);
    if (
      source === "manual" ||
      source === "exchange" ||
      source === "rejected-final" ||
      settledTitleKind === "manual" ||
      settledTitleKind === "exchange" ||
      settledTitleKind === "rejected-final"
    ) {
      return;
    }
    if (
      titleSuggestionSessionIdsRef.current.has(sessionId) ||
      titleSuggestionInFlightSessionIdsRef.current.has(sessionId)
    ) {
      return;
    }
    const firstUserMessageIndex = messages.findIndex((message) => message.role === "user");
    const firstUserMessage =
      firstUserMessageIndex >= 0 ? messages[firstUserMessageIndex] : undefined;
    const prompt = firstUserMessage ? visibleHermesMessageText(firstUserMessage).trim() : "";
    if (!prompt) return;
    let titlePrompt = prompt;
    const wasRejected = source === "rejected" || settledTitleKind === "rejected";
    const firstAssistantReplyIndex = messages.findIndex(
      (message, index) =>
        index > firstUserMessageIndex &&
        message.role === "assistant" &&
        Boolean(visibleHermesMessageText(message).trim()),
    );
    let assistantReply =
      firstAssistantReplyIndex >= 0 ? messages[firstAssistantReplyIndex] : undefined;
    if (wasRejected) {
      const laterUserMessageIndex = messages.findIndex(
        (message, index) =>
          index > firstAssistantReplyIndex &&
          message.role === "user" &&
          Boolean(visibleHermesMessageText(message).trim()),
      );
      const laterAssistantReplyIndex = messages.findIndex(
        (message, index) =>
          index > laterUserMessageIndex &&
          message.role === "assistant" &&
          Boolean(visibleHermesMessageText(message).trim()),
      );
      if (laterUserMessageIndex < 0 || laterAssistantReplyIndex < 0) return;
      titlePrompt = visibleHermesMessageText(messages[laterUserMessageIndex]).trim();
      assistantReply = messages[laterAssistantReplyIndex];
    }
    const reply = truncateAgentTitleResponseExcerpt(
      assistantReply ? visibleHermesMessageText(assistantReply).trim() : "",
    );
    const hasReply = Boolean(reply);
    if (source === "prompt" || wasRejected) {
      if (!hasReply) return;
    } else if (sessionTitleOverridesRef.current[sessionId]) {
      return;
    } else {
      const session = hermesSessionItems.find((item) => item.id === sessionId);
      if (!session || !isReplaceableAgentSessionTitle(session.title)) return;
    }
    const settleRejectedTitle = () => {
      if (sessionTitleSourceRef.current[sessionId] === "manual") return;
      const rejectionIsFinal = wasRejected;
      sessionTitleSourceRef.current = {
        ...sessionTitleSourceRef.current,
        [sessionId]: rejectionIsFinal ? "rejected-final" : "rejected",
      };
      rememberSessionTitleRejected(sessionId, rejectionIsFinal);
    };
    // A rejected title gets exactly one retry, and only after a later user and
    // assistant exchange. Consume that retry before the metered request so a
    // timeout, refresh, or concurrent poll cannot issue it again.
    if (wasRejected) settleRejectedTitle();
    titleSuggestionInFlightSessionIdsRef.current.add(sessionId);
    let shouldRecheckLatestMessages = false;
    try {
      const suggestion = await agentSessionTitleForPrompt(
        titlePrompt,
        hasReply ? reply : undefined,
      );
      if (titleSuggestionSessionIdsRef.current.has(sessionId)) return;
      if (!suggestion.fromModel && sessionTitleOverridesRef.current[sessionId]) {
        if (suggestion.rejected && hasReply) settleRejectedTitle();
        return;
      }
      const title = suggestion.title;
      const rejectedThisAttempt = suggestion.rejected && hasReply;
      if (rejectedThisAttempt) settleRejectedTitle();
      const nextSource: AgentSessionTitleSource =
        suggestion.fromModel && hasReply
          ? "exchange"
          : rejectedThisAttempt
            ? wasRejected
              ? "rejected-final"
              : "rejected"
            : "prompt";
      sessionTitleOverridesRef.current = {
        ...sessionTitleOverridesRef.current,
        [sessionId]: title,
      };
      sessionTitleSourceRef.current = {
        ...sessionTitleSourceRef.current,
        [sessionId]: nextSource,
      };
      if (suggestion.fromModel && nextSource === "prompt") {
        shouldRecheckLatestMessages = true;
      }
      // The durable exchange marker only lands once the title is known to be
      // stored: marking first and failing the PATCH would freeze a stale
      // stored title as settled on the next launch.
      const settleExchangeAfterPersist = suggestion.fromModel && nextSource === "exchange";
      setHermesSessionItems((current) =>
        current.map((item) => (item.id === sessionId ? { ...item, title } : item)),
      );
      void ensureHermesBridgeSession({ sessionId, title })
        .then(() => {
          // A manual rename can land while this auto-title PATCH is in
          // flight and finish first; the stored title must end at the
          // user's name, so re-assert it instead of settling the auto title.
          if (sessionTitleSourceRef.current[sessionId] === "manual") {
            const manualTitle = sessionTitleOverridesRef.current[sessionId];
            if (manualTitle && manualTitle !== title) {
              void ensureHermesBridgeSession({ sessionId, title: manualTitle }).catch(() => {});
            }
            return;
          }
          if (settleExchangeAfterPersist) rememberSessionExchangeTitled(sessionId);
        })
        .catch(() => {});
    } finally {
      titleSuggestionInFlightSessionIdsRef.current.delete(sessionId);
    }
    if (shouldRecheckLatestMessages) {
      const latestMessages = hermesSessionMessagesRef.current[sessionId];
      if (latestMessages) {
        void suggestTitleForUntitledSession(sessionId, latestMessages);
      }
    }
  }

  async function setSkillEnabled(skill: HermesSkillInfo, enabled: boolean) {
    setCapabilitySaving(`skill:${skill.name}`);
    try {
      await toggleHermesBridgeSkill({ name: skill.name, enabled });
      setSkills(
        (current) =>
          current?.map((item) => (item.name === skill.name ? { ...item, enabled } : item)) ??
          current,
      );
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setCapabilitySaving(null);
    }
  }

  async function setToolsetEnabled(toolset: HermesToolsetInfo, enabled: boolean) {
    setCapabilitySaving(`toolset:${toolset.name}`);
    try {
      await toggleHermesBridgeToolset({ name: toolset.name, enabled });
      setToolsets(
        (current) =>
          current?.map((item) => (item.name === toolset.name ? { ...item, enabled } : item)) ??
          current,
      );
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setCapabilitySaving(null);
    }
  }

  async function setMessagingPlatformEnabled(
    platform: HermesMessagingPlatformInfo,
    enabled: boolean,
  ) {
    setCapabilitySaving(`messaging:${platform.id}`);
    try {
      await updateHermesBridgeMessagingPlatform({
        platformId: platform.id,
        enabled,
      });
      setMessagingPlatforms(
        (current) =>
          current?.map((item) => (item.id === platform.id ? { ...item, enabled } : item)) ??
          current,
      );
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setCapabilitySaving(null);
    }
  }

  async function saveMessagingPlatformEnv(platform: HermesMessagingPlatformInfo) {
    const env = Object.fromEntries(
      Object.entries(messagingEnvEdits)
        .map(([key, value]) => [key, value.trim()])
        .filter(([, value]) => value.length > 0),
    );
    if (!Object.keys(env).length) {
      return;
    }
    setCapabilitySaving(`env:${platform.id}`);
    try {
      await updateHermesBridgeMessagingPlatform({
        platformId: platform.id,
        env,
      });
      setMessagingEnvEdits({});
      await loadMessagingPlatforms();
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setCapabilitySaving(null);
    }
  }

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
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const TICK_MS = 90;
    // Irregular-but-deterministic chunk scaling so the replay has the uneven
    // cadence of a real provider without churn between runs.
    const JITTER = [0.4, 1.7, 0.2, 2.3, 1, 0.6, 1.8];
    const apply = ({ show, charsPerSecond }: AgentStreamDemoDetail) => {
      stop();
      if (!show) {
        setGallerySections((prev) =>
          prev?.[0]?.label === STREAM_DEMO_SECTION_LABEL ? null : prev,
        );
        return;
      }
      const text = SAMPLE_MARKDOWN;
      let at = 0;
      let tick = 0;
      let restTicks = 0;
      const seed = (end: number, status: "running" | "complete") =>
        setGallerySections([
          {
            label: STREAM_DEMO_SECTION_LABEL,
            description: `Replaying ~${charsPerSecond} chars/s on loop. __streamDemo(false) stops.`,
            turns: [
              {
                id: "gallery:stream-demo",
                role: "assistant",
                createdAt: "2026-06-09T12:00:00.000Z",
                status,
                parts: [{ type: "text", text: text.slice(0, end), status }],
              },
            ],
          },
        ]);
      seed(0, "running");
      timer = window.setInterval(() => {
        if (restTicks > 0) {
          restTicks -= 1;
          if (restTicks === 0) {
            at = 0;
            seed(0, "running");
          }
          return;
        }
        tick += 1;
        const step = Math.round(((charsPerSecond * TICK_MS) / 1000) * JITTER[tick % JITTER.length]);
        at = Math.min(text.length, at + Math.max(1, step));
        const done = at >= text.length;
        seed(at, done ? "complete" : "running");
        if (done) restTicks = Math.round(2000 / TICK_MS);
      }, TICK_MS);
    };
    apply(streamDemoDesired);
    const onDemo = (event: Event) => apply((event as CustomEvent<AgentStreamDemoDetail>).detail);
    window.addEventListener(AGENT_STREAM_DEMO_EVENT, onDemo);
    return () => {
      window.removeEventListener(AGENT_STREAM_DEMO_EVENT, onDemo);
      stop();
    };
  }, []);

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
  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    const w = window as unknown as Record<string, unknown>;
    w.__steerSubmitDemo = (text = "Focus on the mobile layout first") => {
      if (!selectedHermesSessionId || selectedHermesSessionIsProvisional) {
        return "Open a real session first, then run __steerSubmitDemo().";
      }
      steerCardSeqRef.current += 1;
      const id = `steer-demo-${steerCardSeqRef.current}`;
      setSteerCardsBySessionId((prev) => ({
        ...prev,
        [selectedHermesSessionId]: [...(prev[selectedHermesSessionId] ?? []), { id, text }],
      }));
      return `Tacked a steer card "${text}" onto the composer.`;
    };
    w.__upNextDemo = (show: boolean = true) => {
      if (!selectedHermesSessionId || selectedHermesSessionIsProvisional) {
        return "Open a real session first, then run __upNextDemo().";
      }
      setComposerSteerDemoDesired(show);
      const demoSteers = [
        { id: "steer-up-next-demo", text: "Check the API boundary" },
        { id: "steer-up-next-demo-2", text: "Keep the migration additive" },
      ];
      const demoSteerIds = new Set(demoSteers.map((card) => card.id));
      setSteerCardsBySessionId((prev) => {
        const others = (prev[selectedHermesSessionId] ?? []).filter(
          (card) => !demoSteerIds.has(card.id),
        );
        return {
          ...prev,
          [selectedHermesSessionId]: show ? [...others, ...demoSteers] : others,
        };
      });
      setUpNextDemoFollowUpsBySessionId((current) => ({
        ...current,
        [selectedHermesSessionId]: show ? buildUpNextDemoFollowUps() : [],
      }));
      return show
        ? "Up next preview shown. Run __upNextDemo(false) to hide it."
        : "Up next preview hidden.";
    };
    // __imageGenDemo parks a generating-image turn (the dot-field placeholder)
    // in the selected session so the animation can be judged without paying for
    // a real generation; __imageGenDemo("complete") then flips the parked turn
    // in place (same ids, so the mounted part sees running -> complete) to
    // judge the develop-out-of-the-field reveal. Purely in-memory: never
    // persisted, never retried.
    w.__imageGenDemo = (
      show: boolean | "complete" = true,
      prompt = "Generate an image of a wide, zoomed-out view of people sunbathing along the Rio Grande in New Mexico, painted in the style of Claude Monet. The riverbank is as crowded and lively as a New Jersey beach, creating a striking contrast with the high-desert landscape.",
    ) => {
      if (!selectedHermesSessionId || selectedHermesSessionIsProvisional) {
        return "Open a real session first, then run __imageGenDemo().";
      }
      const turnId = `image-demo:${selectedHermesSessionId}`;
      const startedAt = Date.now();
      if (show === "complete") {
        const parked = (imageTurnsBySession[selectedHermesSessionId] ?? []).some(
          (turn) => turn.id === `${turnId}:assistant`,
        );
        if (!parked) return "Park a turn first with __imageGenDemo(), then complete it.";
        const dataUrl = sampleImageDataUrl("generated-image-demo.png", 480, 480);
        setImageTurnsBySession((current) => ({
          ...current,
          [selectedHermesSessionId]: (current[selectedHermesSessionId] ?? []).map((turn) =>
            turn.id === `${turnId}:assistant`
              ? {
                  ...turn,
                  status: "complete" as const,
                  parts: turn.parts.map((part) =>
                    part.type === "image"
                      ? {
                          ...part,
                          status: "complete" as const,
                          dataUrl,
                          name: "generated-image-demo.png",
                        }
                      : part,
                  ),
                }
              : turn,
          ),
        }));
        return "Completed the demo turn - watch the reveal. __imageGenDemo(false) clears it.";
      }
      setImageTurnsBySession((current) => {
        const others = (current[selectedHermesSessionId] ?? []).filter(
          (turn) => !turn.id.startsWith(turnId),
        );
        return {
          ...current,
          [selectedHermesSessionId]: show
            ? [
                ...others,
                {
                  id: `${turnId}:seed-user`,
                  role: "user" as const,
                  createdAt: new Date(startedAt - 120_000).toISOString(),
                  status: "complete" as const,
                  parts: [
                    {
                      type: "text" as const,
                      text: "I'm putting together a visual concept for a summer scene in New Mexico.",
                      status: "complete" as const,
                    },
                  ],
                },
                {
                  id: `${turnId}:seed-assistant`,
                  role: "assistant" as const,
                  createdAt: new Date(startedAt - 60_000).toISOString(),
                  status: "complete" as const,
                  parts: [
                    {
                      type: "text" as const,
                      text: "What kind of setting and atmosphere would you like the image to have?",
                      status: "complete" as const,
                    },
                  ],
                },
                ...runningImageSlashTurns({
                  id: turnId,
                  prompt,
                  requestId: "image-demo-request",
                  createdAt: new Date(startedAt).toISOString(),
                  imageCreatedAt: new Date(startedAt + 1).toISOString(),
                }),
              ]
            : others,
        };
      });
      return show
        ? 'Parked a generating-image turn. __imageGenDemo("complete") plays the reveal; __imageGenDemo(false) clears.'
        : "Cleared the generating-image demo turn.";
    };
    return () => {
      delete w.__steerSubmitDemo;
      delete w.__upNextDemo;
      delete w.__imageGenDemo;
    };
  }, [selectedHermesSessionId, selectedHermesSessionIsProvisional, imageTurnsBySession]);

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
  const settledScrollSelectionRef = useRef<string>();
  const transcriptShouldStickToBottomRef = useRef(true);
  const transcriptProgrammaticScrollRef = useRef(false);
  const transcriptProgrammaticScrollTimeoutRef = useRef<number | undefined>();
  const transcriptLastScrollTopRef = useRef(0);

  const pinTranscriptAfterVisibleReveal = useCallback(() => {
    if (!transcriptShouldStickToBottomRef.current) return;
    const scroller = agentScrollRef.current;
    if (!scroller || typeof scroller.scrollTo !== "function") return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
    transcriptLastScrollTopRef.current = scroller.scrollTop;
  }, []);

  // History for the selected conversation has landed: a session gets an entry
  // in hermesSessionMessages (even an empty one) once its fetch resolves;
  // tasks either arrive with their turns inline or get recorded when the lazy
  // hydration resolves. Settling keys off this rather than rendered turns so
  // a genuinely empty conversation still settles, and its first turn glides.
  const selectedHistoryLoaded = selectedHermesSessionId
    ? hermesSessionMessages[selectedHermesSessionId] !== undefined
    : selectedTask
      ? selectedTask.messages.length > 0 ||
        selectedTask.toolEvents.length > 0 ||
        taskHistoryLoadedIdsRef.current.has(selectedTask.id)
      : false;
  const startupSessionHydrationPending = hermesSessionsLoading && !hermesSessionsHydrated;

  useEffect(() => {
    if (heroMode) return;
    const scroller = agentScrollRef.current;
    if (!scroller) return;
    const clearProgrammaticScroll = () => {
      transcriptProgrammaticScrollRef.current = false;
      if (transcriptProgrammaticScrollTimeoutRef.current !== undefined) {
        window.clearTimeout(transcriptProgrammaticScrollTimeoutRef.current);
        transcriptProgrammaticScrollTimeoutRef.current = undefined;
      }
    };
    const updateStickiness = () => {
      const previousScrollTop = transcriptLastScrollTopRef.current;
      transcriptLastScrollTopRef.current = scroller.scrollTop;
      if (transcriptProgrammaticScrollRef.current) {
        if (scroller.scrollTop < previousScrollTop) {
          clearProgrammaticScroll();
          transcriptShouldStickToBottomRef.current = isAgentTranscriptNearBottom(scroller);
          return;
        }
        transcriptShouldStickToBottomRef.current = true;
        if (isAgentTranscriptNearBottom(scroller)) clearProgrammaticScroll();
        return;
      }
      transcriptShouldStickToBottomRef.current = isAgentTranscriptNearBottom(scroller);
    };
    const updateFromUserScroll = () => {
      clearProgrammaticScroll();
      window.requestAnimationFrame(updateStickiness);
    };
    updateStickiness();
    scroller.addEventListener("scroll", updateStickiness, { passive: true });
    scroller.addEventListener("wheel", updateFromUserScroll, {
      passive: true,
    });
    scroller.addEventListener("touchmove", updateFromUserScroll, {
      passive: true,
    });
    return () => {
      scroller.removeEventListener("scroll", updateStickiness);
      scroller.removeEventListener("wheel", updateFromUserScroll);
      scroller.removeEventListener("touchmove", updateFromUserScroll);
      clearProgrammaticScroll();
    };
  }, [heroMode, selectedHermesSessionId, selectedTaskId]);

  useEffect(() => {
    // The conversation scrolls in .agent-scroll, which sits below the sticky
    // breadcrumb so the scrollbar can't ride up over the bar — drive that
    // scroller to the bottom as turns arrive.
    const scroller = listRef.current?.closest(".agent-scroll");
    if (!(scroller instanceof HTMLElement)) return;
    const selectionKey = `${selectedHermesSessionId ?? ""}:${selectedTaskId ?? ""}`;
    const settled = settledScrollSelectionRef.current === selectionKey;
    if (!settled) {
      transcriptShouldStickToBottomRef.current = true;
    }
    if (selectedHistoryLoaded || renderedTurnsSignature > 0) {
      // The settling run itself still scrolls with the pre-write snapshot, so
      // the history fill after a switch lands instantly; everything after it
      // (including the first streamed turn of an empty conversation) glides.
      settledScrollSelectionRef.current = selectionKey;
    } else if (!settled) {
      // Mid-load switch: forget the previous conversation so flipping back
      // before this one settles re-lands instantly instead of gliding.
      settledScrollSelectionRef.current = undefined;
    }
    if (settled && !transcriptShouldStickToBottomRef.current) return;
    if (typeof scroller.scrollTo !== "function") return; // jsdom has no scrollTo
    if (settled) {
      transcriptLastScrollTopRef.current = scroller.scrollTop;
      transcriptProgrammaticScrollRef.current = true;
      if (transcriptProgrammaticScrollTimeoutRef.current !== undefined) {
        window.clearTimeout(transcriptProgrammaticScrollTimeoutRef.current);
      }
      transcriptProgrammaticScrollTimeoutRef.current = window.setTimeout(() => {
        transcriptProgrammaticScrollRef.current = false;
        transcriptShouldStickToBottomRef.current = isAgentTranscriptNearBottom(scroller);
        transcriptProgrammaticScrollTimeoutRef.current = undefined;
      }, 800);
    } else {
      transcriptProgrammaticScrollRef.current = false;
    }
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: settled ? "smooth" : "auto",
    });
    transcriptShouldStickToBottomRef.current = true;
  }, [
    composerClearance,
    renderedTurnsSignature,
    selectedHermesSessionId,
    selectedHistoryLoaded,
    selectedTaskId,
  ]);

  // Jump back to the live edge from the floating pill. Glide the same way the
  // auto-scroll effect does — arm the programmatic-scroll ref + timeout so the
  // scroll handler reads the glide as ours, not a user scroll that would
  // release follow mode.
  const scrollTranscriptToLatest = useCallback(() => {
    const scroller = agentScrollRef.current;
    if (!scroller) return;
    if (typeof scroller.scrollTo !== "function") return; // jsdom has no scrollTo
    transcriptShouldStickToBottomRef.current = true;
    transcriptLastScrollTopRef.current = scroller.scrollTop;
    transcriptProgrammaticScrollRef.current = true;
    if (transcriptProgrammaticScrollTimeoutRef.current !== undefined) {
      window.clearTimeout(transcriptProgrammaticScrollTimeoutRef.current);
    }
    transcriptProgrammaticScrollTimeoutRef.current = window.setTimeout(() => {
      transcriptProgrammaticScrollRef.current = false;
      transcriptShouldStickToBottomRef.current = isAgentTranscriptNearBottom(scroller);
      transcriptProgrammaticScrollTimeoutRef.current = undefined;
    }, 800);
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, []);

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
  useEffect(() => {
    if (!heroMode) return;
    // matchMedia is feature-checked for jsdom, which doesn't implement it.
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    let swapTimeout: number | undefined;
    const interval = window.setInterval(() => {
      if (document.hidden || heroChipsHoverRef.current) return;
      if (draftRef.current.trim()) return;
      setHeroChipPhase("out");
      swapTimeout = window.setTimeout(() => {
        setHeroDeckStart((start) => (start + HERO_SHORTCUT_COUNT) % AGENT_SHORTCUTS.length);
        // Two frames so the incoming chips paint hidden (phase still "out")
        // before the fade-in transition has a start state to run from.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => setHeroChipPhase("in"));
        });
      }, HERO_CHIP_SWAP_MS);
    }, HERO_ROTATE_MS);
    return () => {
      window.clearInterval(interval);
      if (swapTimeout !== undefined) window.clearTimeout(swapTimeout);
    };
  }, [heroMode]);

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
  useLayoutEffect(() => {
    const wasHero = prevHeroModeRef.current;
    prevHeroModeRef.current = heroMode;
    const box = composerBoxRef.current;
    if (!box) return;
    if (heroMode) {
      heroExitRectRef.current = box.getBoundingClientRect();
      // Clear any stale intent while the hero is up so a sidebar dismissal
      // can't inherit a glide armed by an earlier (failed) submit.
      heroExitViaThreadRef.current = false;
      return;
    }
    const prev = heroExitRectRef.current;
    heroExitRectRef.current = null;
    if (!wasHero || !prev) return;
    // Only glide when the hero handed over to a fresh thread. Leaving the hero
    // because the user opened an existing chat should swap in place.
    const viaThread = heroExitViaThreadRef.current;
    heroExitViaThreadRef.current = false;
    if (!viaThread) return;
    if (
      typeof box.animate !== "function" ||
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    ) {
      return;
    }
    // The timeline's rise-and-fade belongs to this same handoff, so it runs
    // here rather than as a CSS mount animation — as CSS it replayed on every
    // timeline mount, nudging the conversation upward when merely opening an
    // existing chat from the hero (or returning from another view).
    listRef.current?.animate(
      [
        { opacity: 0, transform: "translateY(10px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      // Backwards fill so a slow frame can't paint the timeline at rest
      // before the first animation frame applies (the CSS original filled
      // backwards for the same reason).
      {
        duration: 280,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)", // --ease-out
        fill: "backwards",
      },
    );
    const next = box.getBoundingClientRect();
    const dx = prev.left - next.left;
    const dy = prev.top - next.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    box.animate(
      [
        {
          transform: `translate(${dx}px, ${dy}px)`,
          width: `${prev.width}px`,
          height: `${prev.height}px`,
        },
        {
          transform: "translate(0, 0)",
          width: `${next.width}px`,
          height: `${next.height}px`,
        },
      ],
      { duration: 360, easing: "cubic-bezier(0.32, 0.72, 0, 1)" }, // --ease-spring
    );
  });

  const composer =
    activePanel === "chat" ? (
      <form
        ref={composerRef}
        className="agent-composer"
        data-hero={heroMode ? "true" : undefined}
        data-drop-active={dropActive ? "true" : undefined}
        onSubmit={(event) => void submit(event)}
        onDragOver={handleComposerDragOver}
        onDragEnter={() => setDropActive(true)}
        onDragLeave={() => setDropActive(false)}
        onDrop={handleComposerDrop}
        onPaste={handleComposerPaste}
      >
        {/* Anchored inside the fixed composer column so it rides the box's
            real height (multi-line drafts, stacked notices) instead of
            guessing a clearance from the card edge. */}
        {heroMode ? null : (
          <AgentScrollToLatestButton scrollRef={agentScrollRef} onJump={scrollTranscriptToLatest} />
        )}
        {textActionsDisabledReason
          ? (renderFundingNotice?.({
              ...textFundingContext,
              onSelectVeniceModel: () => openComposerModelPicker(),
            }) ?? (
              <p className="agent-composer-notice" role="status">
                {textActionsDisabledReason}
              </p>
            ))
          : null}
        <AnimatePresence>
          {galleryErrors ? (
            // Dev gallery only: the busy nudge is a toast in real use (see
            // SESSION_BUSY_TOAST_ID); this renders the old inline pill so
            // __agentErrors can still screenshot that surface.
            <motion.p
              key="busy-notice"
              className="agent-composer-notice"
              role="status"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
              <DotSpinner />
              {SESSION_BUSY_NOTICE}
            </motion.p>
          ) : visibleIssueReportReview ? (
            <motion.div
              key="issue-report-review"
              className="agent-composer-notice agent-composer-notice-action"
              role="status"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
              <span>
                {visibleIssueReportReview.report.followUps.length
                  ? "Follow-up added. Add more context in chat, or send it to the June team."
                  : "Report ready. Add more context in chat, or send it to the June team."}
              </span>
              <button
                type="button"
                className="agent-composer-notice-button"
                disabled={
                  visibleIssueReportReview.submitting ||
                  visibleIssueReportImportingFiles ||
                  visibleIssueReportHasUnsentContext
                }
                onClick={() => void sendReviewableIssueReport(visibleIssueReportReview.sessionId)}
              >
                {visibleIssueReportReview.submitting || visibleIssueReportImportingFiles ? (
                  <DotSpinner className="agent-composer-notice-button-spinner" />
                ) : null}
                {visibleIssueReportReview.submitting
                  ? "Sending"
                  : visibleIssueReportImportingFiles
                    ? "Attaching files"
                    : visibleIssueReportHasUnsentContext
                      ? "Send message first"
                      : "Send report"}
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>
        {visibleFollowUpQueueKey && selectedFollowUpCount ? (
          // One surface for the user's single intent: follow up while June is
          // working. Text may steer the current turn while attachments wait,
          // but that transport distinction belongs in row status, not in two
          // competing queue cards.
          <section className="agent-steer-queue" aria-label="Up next">
            <div className="agent-steer-queue-header">
              <button
                type="button"
                className="agent-steer-queue-trigger"
                aria-expanded={steerQueueOpen}
                onClick={() => setSteerQueueOpen((open) => !open)}
              >
                Up next
                {steerQueueOpen ? null : (
                  <span className="status-pill agent-steer-queue-count">
                    {selectedFollowUpCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="agent-steer-queue-chevron-button"
                aria-label={steerQueueOpen ? "Collapse up next" : "Expand up next"}
                aria-expanded={steerQueueOpen}
                onClick={() => setSteerQueueOpen((open) => !open)}
              >
                <IconChevronDownSmall
                  size={13}
                  className="agent-steer-queue-chevron"
                  data-expanded={steerQueueOpen}
                  aria-hidden
                />
              </button>
            </div>
            {steerQueueOpen ? (
              <div className="agent-steer-cards-scroll scroll-fade" {...steerCardsFade.props}>
                <div ref={steerCardsListRef} className="agent-steer-cards-list">
                  {selectedSteerCards.map((card) => renderSteerCard(card))}
                  {selectedQueuedAttachmentFollowUps.map((item) =>
                    renderQueuedAttachmentFollowUp(visibleFollowUpQueueKey, item),
                  )}
                  {selectedUpNextDemoFollowUps.map((item) =>
                    renderQueuedAttachmentFollowUp(visibleFollowUpQueueKey, item, { demo: true }),
                  )}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}
        <AnimatePresence>
          {showImageModelWarning ? (
            // Docked above the box in the FundingNotice family — same surface
            // recipe, so the pair reads as one floating unit. The warm triangle
            // carries the caution tone.
            <motion.section
              key="image-model-warning"
              className="agent-composer-image-warning"
              role="status"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
              <span className="agent-composer-image-warning-icon" aria-hidden>
                <IconExclamationTriangle size={14} />
              </span>
              <p className="agent-composer-image-warning-text">{imageModelWarningText}</p>
              {preferredVisionModel ? (
                <div className="agent-composer-image-warning-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() =>
                      // Switch straight to the preferred image-capable model. The
                      // label promises a one-tap fix, and the generic model picker
                      // isn't vision-scoped — opening it for the multi-candidate
                      // case would drop the user into an unfiltered list that
                      // doesn't surface the eligible models. preferredVisionModel
                      // is pre-filtered to image + tool support and prefers a
                      // suggested pick.
                      void handleSelectGenerationModel(preferredVisionModel.id)
                    }
                  >
                    Switch to {preferredVisionModel.name}
                  </button>
                </div>
              ) : null}
            </motion.section>
          ) : null}
        </AnimatePresence>
        <div ref={composerBoxRef} className="agent-composer-box">
          {attachments.length ? (
            <div className="agent-composer-attachments">
              {attachments.map((attachment) => (
                <AgentAttachmentTile
                  key={attachment.id}
                  attachment={attachment}
                  onRemove={() => removeAttachment(attachment.id)}
                />
              ))}
            </div>
          ) : null}
          {visibleComposerSizeWarning ? (
            <div className="agent-composer-size-warning" role="status">
              <IconExclamationTriangle
                size={14}
                aria-hidden
                className="agent-composer-size-warning-icon"
              />
              <span className="agent-composer-size-warning-text">
                This message is about{" "}
                {formatComposerTokenCount(visibleComposerSizeWarning.estimatedTokens)} tokens, over{" "}
                {visibleComposerSizeWarning.modelName}'s{" "}
                {formatComposerTokenCount(visibleComposerSizeWarning.contextLimit)} token context
                window.
              </span>
              <span className="agent-composer-size-warning-actions">
                <button
                  type="button"
                  className="agent-composer-notice-button"
                  onClick={proceedWithOversizeComposerInput}
                >
                  Proceed
                </button>
                <button
                  type="button"
                  className="agent-composer-notice-button"
                  onClick={editOversizeComposerInput}
                >
                  Edit message
                </button>
                {visibleComposerSizeWarning.switchModel ? (
                  <button
                    type="button"
                    className="agent-composer-notice-button"
                    onClick={switchOversizeComposerModel}
                  >
                    Switch to {visibleComposerSizeWarning.switchModel.name}
                  </button>
                ) : null}
              </span>
            </div>
          ) : null}
          <ComposerEditor
            ref={composerEditorRef}
            skills={skills}
            placeholder={
              generatingVideo
                ? "Generating video…"
                : generatingImage
                  ? "Generating image…"
                  : importingFiles
                    ? "Attaching file…"
                    : composerInSteerState
                      ? // June is mid-run: a typed message steers this turn
                        // immediately (it is not staged), so the copy names the
                        // outcome - a follow-up folded into the running work -
                        // rather than a queue that doesn't exist.
                        "Ask for follow-up changes"
                      : heroMode
                        ? "Ask June anything, run / commands"
                        : "Send a message"
            }
            onChange={(text, nextCategory) => {
              draftRef.current = text;
              categoryRef.current = nextCategory;
              setDraft(text);
              setCategory(nextCategory);
              if (
                !skills &&
                !skillCommandLoading &&
                text.trimStart().startsWith("/") &&
                !isBuiltinComposerSlashCommand(text)
              ) {
                void loadSkillCommands({ silent: true });
              }
              rememberComposerDraft(
                composerDraftKeyRef.current,
                text,
                nextCategory,
                attachmentsRef.current,
              );
            }}
            onSubmit={() => void submit()}
            onBuiltinSlashCommand={(name) => {
              if (name !== "model") return false;
              // The slash row commits on mousedown. Mounting the palette in
              // that same event lets its window-level outside-click listener
              // observe the now-removed row and close immediately. Queue the
              // palette for the next task, after that pointer or keyboard event.
              window.setTimeout(() => openComposerModelPicker(true), 0);
              return true;
            }}
            onReady={(editor) => {
              composerTiptapEditorRef.current = editor;
              restoreComposerDraft(composerDraftKeyRef.current);
              seedComposerNoteRef({ defer: true });
            }}
          />
          <div className="agent-composer-toolbar">
            <button
              type="button"
              ref={attachTriggerRef}
              className="agent-composer-attach"
              aria-label="Add files, notes, or reports"
              title="Add"
              aria-haspopup="menu"
              aria-expanded={attachMenuOpen}
              data-open={attachMenuOpen || undefined}
              onClick={() => {
                setReportDialogOpen(false);
                setAttachMenuOpen((open) => !open);
              }}
            >
              <IconPlusMedium size={18} />
            </button>
            {heroMode ? (
              // Unrestricted only applies to the session being created, so
              // the picker lives in the hero composer's toolbar and nowhere
              // else. The menu itself renders as a sibling of the box (below)
              // because the box clips its overflow for the FLIP glide.
              <button
                type="button"
                ref={sandboxTriggerRef}
                className="agent-sandbox-trigger"
                data-unrestricted={fullModeDraft ? "true" : undefined}
                aria-haspopup="menu"
                aria-expanded={sandboxMenuOpen}
                title="Change what June can touch"
                onClick={() => setSandboxMenuOpen((open) => !open)}
              >
                {fullModeDraft ? (
                  <IconShieldCrossed size={14} aria-hidden />
                ) : (
                  <IconShieldCheck size={14} aria-hidden />
                )}
                {fullModeDraft ? "Unrestricted" : "Sandboxed"}
                <IconChevronDownSmall size={12} aria-hidden />
              </button>
            ) : null}
            <div className="agent-composer-actions">
              <ComposerModelPicker
                open={composerModelOpen}
                model={generationModel}
                detail={
                  generationModel?.id === AUTO_MODEL_ID
                    ? autoPillDesignation(activeGenerationCostQuality)
                    : undefined
                }
                effort={composerThinkingLevel}
                triggerRef={composerModelTriggerRef}
                onToggleOpen={() => {
                  if (composerModelOpen) {
                    setComposerModelOpen(false);
                    return;
                  }
                  openComposerModelPicker();
                }}
              />
              <button
                type="button"
                className="agent-composer-mic"
                aria-label="Dictate"
                title={creditActionsDisabledReason ?? "Start dictation"}
                disabled={Boolean(creditActionsDisabledReason)}
                onClick={() => void startDictation()}
              >
                <IconMicrophone size={18} />
              </button>
              {selectedHermesSessionId && composerInSteerState ? (
                // June is working (or a follow-up is landing): the slot flips
                // to stop the instant a message fires — no spinner in between.
                // Typing a follow-up swaps stop for a steer-send in place (the
                // same one-slot scale trade every send/stop swap uses), which
                // redirects the run mid-flight (session.steer) without
                // interrupting it. Stop returns when the draft clears, and
                // Escape interrupts the turn at any time.
                draft.trim().length > 0 || attachments.length > 0 ? (
                  // Keyed so the swap remounts (button-for-button in one slot
                  // would be updated in place) and the scale-in trade plays.
                  <button
                    key="steer-send"
                    type="submit"
                    className="agent-composer-send"
                    disabled={imageSlashBlockedByModel}
                    title={
                      imageSlashBlockedByModel
                        ? "Switch to a vision model before using /image."
                        : attachments.length
                          ? "Queue next message"
                          : "Send to steer June"
                    }
                    aria-label={attachments.length ? "Queue next message" : "Send to steer June"}
                  >
                    <IconArrowUp size={18} />
                  </button>
                ) : (
                  <button
                    key="steer-stop"
                    type="button"
                    className="agent-composer-stop"
                    aria-label="Stop June"
                    title={
                      workingSessionIds.has(selectedHermesSessionId)
                        ? "Stop June"
                        : "June is starting"
                    }
                    disabled={
                      stoppingSessionIds.has(selectedHermesSessionId) ||
                      !workingSessionIds.has(selectedHermesSessionId)
                    }
                    onClick={() => void stopHermesSession(selectedHermesSessionId)}
                  >
                    <IconStop size={16} />
                  </button>
                )
              ) : (
                <button
                  type="submit"
                  className="agent-composer-send"
                  disabled={
                    submitting ||
                    importingFiles ||
                    Boolean(textActionsDisabledReason) ||
                    selectedHermesSessionIsProvisional ||
                    imageSlashBlockedByModel ||
                    (!draft.trim() && !attachments.length)
                  }
                  title={
                    imageSlashBlockedByModel
                      ? "Switch to a vision model before using /image."
                      : undefined
                  }
                  aria-label={
                    selectedHermesSessionId || selectedTask ? "Send message" : "Start session"
                  }
                >
                  {submitting ? <Spinner /> : <IconArrowUp size={18} />}
                </button>
              )}
            </div>
          </div>
        </div>
        {attachMenuOpen ? (
          // Sibling of the box (which clips its overflow for the grow glide),
          // anchored above the "+" trigger by CSS.
          <div
            ref={attachMenuRef}
            className="agent-attach-menu"
            role="menu"
            aria-label="Add files, notes, or reports"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setAttachMenuOpen(false);
                void pickAttachments();
              }}
            >
              <span className="agent-attach-menu-icon">
                <IconFileText size={16} aria-hidden />
              </span>
              <span className="agent-attach-menu-label">Attach files</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setAttachMenuOpen(false);
                const editor = composerTiptapEditorRef.current;
                if (editor && !editor.isDestroyed) {
                  // The suggestion plugin only matches a trigger preceded by
                  // whitespace or a line start, so pad the "@" when the caret
                  // sits right after text or an atom chip.
                  const nodeBefore = editor.state.selection.$from.nodeBefore;
                  const lastChar = nodeBefore?.isText ? (nodeBefore.text?.slice(-1) ?? "") : "";
                  const needsSpace = nodeBefore != null && !/\s/.test(lastChar || "x");
                  editor
                    .chain()
                    .focus()
                    .insertContent(needsSpace ? " @" : "@")
                    .run();
                } else {
                  composerEditorRef.current?.focus();
                }
              }}
            >
              <span className="agent-attach-menu-icon">
                <IconNoteText size={16} aria-hidden />
              </span>
              <span className="agent-attach-menu-label">Reference a note</span>
            </button>
            <div className="agent-attach-menu-divider" role="separator" />
            {REPORT_CATEGORIES.map((reportCategory) => (
              <button
                key={reportCategory.key}
                type="button"
                role="menuitem"
                onClick={() => {
                  openReportDialog(reportCategory.key);
                }}
              >
                <span className="agent-attach-menu-icon" data-category={reportCategory.key}>
                  <CategoryIcon category={reportCategory.key} size={16} />
                </span>
                <span className="agent-attach-menu-label">{reportCategory.label}</span>
              </button>
            ))}
          </div>
        ) : null}
        {reportDialogOpen ? (
          <ReportDialog
            category={reportDialogCategory}
            description={reportDialogDescription}
            attachments={reportDialogAttachments}
            importingFiles={importingFiles}
            onCategoryChange={setReportDialogCategory}
            onDescriptionChange={setReportDialogDescription}
            onAddFiles={pickReportDialogAttachments}
            onDropFiles={importReportDialogDroppedFiles}
            onRemoveAttachment={removeReportDialogAttachment}
            onClose={() => setReportDialogOpen(false)}
            onSent={handleReportDialogSent}
          />
        ) : null}
        {composerModelOpen ? (
          <ModelPickerPopover
            mode="generation"
            flyout={composerModelFlyout}
            model={generationModel}
            options={modelOptions(generationModelOptions, generationModel?.id ?? "")}
            costQuality={activeGenerationCostQuality}
            veniceApiKeyConfigured={veniceApiKeyConfigured}
            catalogLoaded={generationModelOptions.length > 0}
            search={modelSearch}
            popoverRef={composerModelPopoverRef}
            searchRef={composerModelSearchRef}
            rootSearchRef={composerModelRootSearchRef}
            rootSearch={modelRootSearch}
            onRootSearchChange={(value) => {
              setComposerModelFlyout(null);
              setModelRootSearch(value);
            }}
            onFlyoutChange={setComposerModelFlyout}
            onSearchChange={setModelSearch}
            onSelect={(modelId, costQuality, options) => {
              void handleSelectGenerationModel(modelId, costQuality, options);
              // A final pick closes the popover and hands focus back to the
              // draft; control adjustments (Auto, a keepOpen select) leave
              // the popover and its focus in place.
              if (!options?.keepOpen) composerEditorRef.current?.focus();
            }}
            onCostQualityChange={handleCostQualityChange}
            thinkingLevel={composerThinkingLevel}
            onSelectThinking={(level) => {
              setComposerModelFlyout(null);
              setComposerModelOpen(false);
              void handleSelectThinkingLevel(level);
            }}
          />
        ) : null}
        {heroMode && sandboxMenuOpen ? (
          <div
            ref={sandboxMenuRef}
            className="agent-sandbox-menu"
            role="menu"
            aria-label="What can June change?"
          >
            <p className="agent-sandbox-menu-title">What can June change?</p>
            {SANDBOX_OPTIONS.map((option, index) => (
              <button
                key={option.title}
                ref={index === 0 ? sandboxFirstItemRef : undefined}
                type="button"
                role="menuitemradio"
                aria-checked={fullModeDraft === option.unrestricted}
                onClick={() => {
                  setSandboxMenuOpen(false);
                  // First arm of the app session goes through the confirm
                  // dialog; once acknowledged it arms directly, and going
                  // back to sandboxed never asks.
                  if (option.unrestricted && !fullModeDraft && !unrestrictedAcknowledged()) {
                    setConfirmUnrestricted(true);
                    return;
                  }
                  fullModeDraftRef.current = option.unrestricted;
                  setFullModeDraft(option.unrestricted);
                }}
              >
                {option.icon}
                <span className="agent-sandbox-option">
                  <span className="agent-sandbox-option-title">{option.title}</span>
                  <span className="agent-sandbox-option-desc">{option.description}</span>
                </span>
                {fullModeDraft === option.unrestricted ? (
                  <IconCheckmark2Small
                    size={16}
                    aria-hidden
                    className="agent-sandbox-option-check"
                  />
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
        <Dialog
          open={confirmUnrestricted}
          onClose={() => setConfirmUnrestricted(false)}
          title="Turn on Unrestricted?"
          description="June will be able to change any file your account can, not just its own workspace. This comes with risks like data loss if something goes wrong."
          footer={
            <>
              <button
                type="button"
                className="primary-action"
                onClick={() => setConfirmUnrestricted(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-action primary-solid"
                onClick={() => {
                  rememberUnrestrictedAcknowledged();
                  fullModeDraftRef.current = true;
                  setFullModeDraft(true);
                  setConfirmUnrestricted(false);
                }}
              >
                Turn on Unrestricted
              </button>
            </>
          }
        >
          {null}
        </Dialog>
      </form>
    ) : null;

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

  const detailContent = gallerySections ? (
    <AgentResponseGallery
      sections={gallerySections}
      errors={galleryErrors}
      fundingTier={fundingTier}
      onClose={() => setGalleryDesired(false)}
    />
  ) : !newSessionMode && selectedHermesSessionId ? (
    <div ref={listRef} className="agent-timeline">
      <UnsupportedEventNotice
        notice={unsupportedNotice}
        // Dev/debug context gates the raw-trace affordance. Reuse the same DEV
        // signal feature 01 used; feature 15 can swap in a richer debug toggle.
        debugEnabled={import.meta.env.DEV}
        onOpenRawTrace={(sessionId) => {
          // Feature 15: open the dev/debug raw trace panel for this session.
          // The panel itself is dev-gated (renders null in production), so this
          // is inert in shipped builds even if the affordance were reached.
          setRawTraceSession(sessionId);
        }}
        onStopSession={() => void stopHermesSession(selectedHermesSessionId)}
        onReportIssue={() => {
          // The sanitized, secret-free trace bundle for this session is the
          // payload an issue report should attach (payload previews come from
          // `sanitizePayload`). This trace affordance is not wired into the
          // report dialog yet, so keep logging in dev.
          if (import.meta.env.DEV) {
            // biome-ignore lint/suspicious/noConsole: dev-only trace-bundle diagnostic
            console.debug(
              "[hermes] report issue trace bundle",
              hermesTraceBuffer.exportSanitizedTrace(selectedHermesSessionId),
            );
          }
        }}
      />
      <HermesTracePanel
        buffer={hermesTraceBuffer}
        open={rawTraceSession !== undefined}
        sessionId={rawTraceSession}
        onClose={() => setRawTraceSession(undefined)}
      />
      {hermesTurns.map((turn) => (
        <AgentChatTurnRow
          key={turn.id}
          turn={turn}
          activeThinkingKey={activeThinkingKey}
          artifacts={turnArtifacts.get(turn.id)}
          approvalSubmitting={approvalSubmitting}
          clarifySubmitting={clarifySubmitting}
          sudoSubmitting={sudoSubmitting}
          secretSubmitting={secretSubmitting}
          cliAccess={{
            enabled: cliAccessEnabled,
            submitting: cliAccessSubmitting,
            onEnable: () => void enableCliAccessFromChat(),
          }}
          browserAccess={{
            enabled: browserAccessEnabled,
            submitting: browserAccessSubmitting,
            onEnable: () => void enableBrowserAccessFromChat(),
          }}
          thinkingOpen={thinkingOpen}
          onThinkingOpenChange={setThinkingOpen}
          onDownloadArtifact={downloadArtifact}
          onOpenArtifact={openArtifact}
          onDownloadImage={downloadGeneratedImage}
          onOpenImage={openGeneratedImage}
          onRetryImage={(assistantTurnId, part) =>
            void retryImageSlashTurn(selectedHermesSessionId, assistantTurnId, part)
          }
          onDownloadVideo={downloadGeneratedVideo}
          onRetryVideo={(assistantTurnId, part) =>
            void retryVideoSlashTurn(selectedHermesSessionId, assistantTurnId, part)
          }
          onRetryUpstreamFailure={(turnId) =>
            void retryUpstreamProviderFailure(
              selectedHermesSessionId,
              upstreamFailureRecoveryIds.get(turnId),
            )
          }
          upstreamFailureRetryAttempted={upstreamProviderRecoveryStore.attempted(
            selectedHermesSessionId,
            upstreamFailureRecoveryIds.get(turn.id) ?? "",
          )}
          upstreamFailureRetryDisabled={
            workingSessionIds.has(selectedHermesSessionId) ||
            waitingSessionIds.has(selectedHermesSessionId)
          }
          creditActionsDisabledReason={creditActionsDisabledReason}
          onApproval={(part, choice) =>
            void respondToApproval(
              selectedHermesSessionId,
              part.sessionId ?? selectedHermesSessionId,
              part.id,
              choice,
              sessionUnrestricted(selectedHermesSessionId),
            )
          }
          onTopUp={handleTopUp}
          topUpLabel={topUpLabel}
          fundingTier={fundingTier}
          onClarify={(part, answer) =>
            void respondToClarify(
              selectedHermesSessionId,
              part.id,
              answer,
              sessionUnrestricted(selectedHermesSessionId),
            )
          }
          onSudo={(part, approved) =>
            void respondToSudo(
              selectedHermesSessionId,
              part.sessionId ?? selectedHermesSessionId,
              part.id,
              approved,
              part.mode,
              sessionUnrestricted(selectedHermesSessionId),
            )
          }
          onSecret={(part, value) =>
            void respondToSecret(
              selectedHermesSessionId,
              part.sessionId ?? selectedHermesSessionId,
              part.id,
              value,
              sessionUnrestricted(selectedHermesSessionId),
            )
          }
          onBranch={(messageId, sessionId) =>
            void branchFromMessage(
              sessionId ?? selectedHermesSessionId,
              messageId,
              selectedHermesSessionId,
            )
          }
          branchingMessageId={branchingMessageId}
          onVisibleMarkdownChange={pinTranscriptAfterVisibleReveal}
        />
      ))}
      {browserApprovalCards}
      <AgentThinking
        visible={
          workingSessionIds.has(selectedHermesSessionId) && hermesTurns.at(-1)?.role === "user"
        }
      />
    </div>
  ) : !newSessionMode && selectedTask ? (
    <>
      <header className="agent-detail-header">
        <div className="agent-detail-title">
          <ActivityIndicator active={workingTaskIds.has(selectedTask.id)} large />
          <div className="agent-detail-heading">
            <h2>{selectedTask.title}</h2>
            <PrivacyModeBadge badge={generationPrivacyBadge} />
          </div>
        </div>
        <div className="agent-actions">
          {selectedTask.status !== "cancelled" && selectedTask.status !== "completed" ? (
            <button
              type="button"
              className="agent-icon-button"
              aria-label="Cancel task"
              onClick={() => void cancelTask(selectedTask.id)}
            >
              <IconStopCircle size={15} />
            </button>
          ) : null}
          {selectedTask.status === "failed" || selectedTask.status === "paused" ? (
            <button
              type="button"
              className="agent-icon-button"
              aria-label="Retry task"
              onClick={() => void retryTask(selectedTask.id)}
            >
              <IconArrowRotateClockwise size={15} />
            </button>
          ) : null}
        </div>
      </header>
      <div ref={listRef} className="agent-timeline">
        {taskTurns.map((turn) => (
          <AgentChatTurnRow
            key={turn.id}
            turn={turn}
            activeThinkingKey={activeThinkingKey}
            artifacts={turnArtifacts.get(turn.id)}
            approvalSubmitting={approvalSubmitting}
            clarifySubmitting={clarifySubmitting}
            sudoSubmitting={sudoSubmitting}
            secretSubmitting={secretSubmitting}
            cliAccess={{
              enabled: cliAccessEnabled,
              submitting: cliAccessSubmitting,
              onEnable: () => void enableCliAccessFromChat(),
            }}
            browserAccess={{
              enabled: browserAccessEnabled,
              submitting: browserAccessSubmitting,
              onEnable: () => void enableBrowserAccessFromChat(),
            }}
            thinkingOpen={thinkingOpen}
            onThinkingOpenChange={setThinkingOpen}
            onDownloadArtifact={downloadArtifact}
            onOpenArtifact={openArtifact}
            creditActionsDisabledReason={creditActionsDisabledReason}
            onTopUp={handleTopUp}
            topUpLabel={topUpLabel}
            fundingTier={fundingTier}
            onVisibleMarkdownChange={pinTranscriptAfterVisibleReveal}
            onApproval={(part, choice) => {
              const sessionId = part.sessionId ?? selectedTask.hermesSessionId;
              if (!sessionId) return;
              void respondToApproval(
                selectedTask.id,
                sessionId,
                part.id,
                choice,
                sessionUnrestricted(selectedTask.hermesSessionId),
              );
            }}
            onClarify={(part, answer) =>
              void respondToClarify(
                selectedTask.id,
                part.id,
                answer,
                sessionUnrestricted(selectedTask.hermesSessionId),
              )
            }
            onSudo={(part, approved) => {
              const sessionId = part.sessionId ?? selectedTask.hermesSessionId;
              if (!sessionId) return;
              void respondToSudo(
                selectedTask.id,
                sessionId,
                part.id,
                approved,
                part.mode,
                sessionUnrestricted(selectedTask.hermesSessionId),
              );
            }}
            onSecret={(part, value) => {
              const sessionId = part.sessionId ?? selectedTask.hermesSessionId;
              if (!sessionId) return;
              void respondToSecret(
                selectedTask.id,
                sessionId,
                part.id,
                value,
                sessionUnrestricted(selectedTask.hermesSessionId),
              );
            }}
          />
        ))}
        {browserApprovalCards}
        <AgentThinking
          visible={workingTaskIds.has(selectedTask.id) && taskTurns.at(-1)?.role === "user"}
        />
      </div>
    </>
  ) : null;

  return (
    <section
      className="agent-workspace"
      aria-label="Session"
      data-artifact-panel={artifactPanel ? "open" : undefined}
      data-hero={heroMode ? "true" : undefined}
    >
      {/* Feature 11: the Agent activity drawer and its toggle. One top-level
          surface so it shows every session's live activity, not
          just the selected one. The toggle is hidden while the drawer is open
          (the drawer carries its own close control) and surfaces the count of
          sessions currently doing work.
          Gated by ACTIVITY_DRAWER_ENABLED (currently false): with no toggle the
          drawer is unreachable, since nothing else flips activityDrawerOpen to
          true. See the flag's note for the open-wrong-session bug it parks. */}
      {ACTIVITY_DRAWER_ENABLED && !activityDrawerOpen ? (
        <button
          type="button"
          className="agent-activity-toggle"
          onClick={() => setActivityDrawerOpen(true)}
          aria-label="Show agent activity"
        >
          <IconBolt size={15} ariaHidden />
          <span className="agent-activity-toggle-label">Activity</span>
          {activeAgentCount > 0 ? (
            <span className="agent-activity-toggle-count" aria-hidden>
              {activeAgentCount}
            </span>
          ) : null}
        </button>
      ) : null}
      <AgentActivityDrawer
        open={activityDrawerOpen}
        records={activityRecords}
        status={activityStatus}
        now={Date.now()}
        titleForSession={titleForPendingSession}
        modelForSession={modelForActivitySession}
        onOpenSession={openSessionFromDrawer}
        onSteerSession={steerSessionFromDrawer}
        canSteerSession={(sessionId) => workingSessionIds.has(sessionId)}
        onStopSession={(sessionId) => void stopHermesSession(sessionId)}
        onStopSubagent={stopHermesSubagent}
        onClose={() => setActivityDrawerOpen(false)}
        footer={
          <AgentArtifactsSection
            artifacts={timelineArtifacts}
            onOpenArtifact={openTimelineArtifact}
          />
        }
      />
      {!heroMode && !(!newSessionMode && !selectedHermesSessionId && selectedTask) ? (
        <AgentSessionBar
          origin={origin}
          artifactCount={!newSessionMode ? surfacedArtifacts.length : 0}
          artifactsOpen={artifactPanel !== null}
          onToggleArtifacts={() => setArtifactPanel((open) => (open ? null : { view: "list" }))}
          privacyBadge={generationPrivacyBadge}
          // The badge describes the selected session, not the live runtime:
          // every send re-enforces the session's recorded mode, so a
          // sandboxed session stays sandboxed even while an Unrestricted
          // runtime from another session is still up. The hero composer's
          // picker covers the new-session draft.
          fullMode={
            !newSessionMode &&
            !selectedHermesSessionIsProvisional &&
            sessionUnrestricted(selectedHermesSessionId)
          }
          title={
            !newSessionMode && selectedHermesSessionId
              ? (selectedHermesSession?.title ?? "")
              : undefined
          }
          shareUrl={
            !newSessionMode && selectedHermesSessionId && !selectedHermesSessionIsProvisional
              ? (sessionShareUrl ?? undefined)
              : undefined
          }
          onRename={
            !newSessionMode && selectedHermesSessionId && !selectedHermesSessionIsProvisional
              ? (title) => renameHermesSession(selectedHermesSessionId, title)
              : undefined
          }
          onShare={
            // Gate on loaded history: sharing snapshots the transcript, and
            // hermesTurns is empty until the selected session hydrates. Sharing
            // early or while a response is streaming would persist an
            // empty/partial session permanently.
            canShareAgentSession({
              selectedSessionId: selectedHermesSessionId,
              newSessionMode,
              provisional: selectedHermesSessionIsProvisional,
              historyLoaded: selectedHistoryLoaded,
              working: selectedHermesSessionId
                ? workingSessionIds.has(selectedHermesSessionId)
                : false,
            }) && selectedHermesSessionId
              ? () => setShareSessionId(selectedHermesSessionId)
              : undefined
          }
          inProject={sessionInProject}
          projectContext={sessionInProject ? projectContext : undefined}
          onMoveToProject={
            onMoveSessionToProject &&
            !newSessionMode &&
            selectedHermesSessionId &&
            !selectedHermesSessionIsProvisional
              ? () => onMoveSessionToProject(selectedHermesSessionId)
              : undefined
          }
          onDelete={
            !newSessionMode && selectedHermesSessionId && !selectedHermesSessionIsProvisional
              ? () => void deleteSelectedHermesSession(selectedHermesSessionId)
              : undefined
          }
          onShowUsage={
            !newSessionMode && selectedHermesSessionId && !selectedHermesSessionIsProvisional
              ? () => setUsagePanelSessionId(selectedHermesSessionId)
              : undefined
          }
          onCompactContext={
            !newSessionMode && selectedHermesSessionId && !selectedHermesSessionIsProvisional
              ? () => setCompactSessionId(selectedHermesSessionId)
              : undefined
          }
          // Dev builds only: open the raw Hermes TUI on this exact session,
          // under the same sandbox/unrestricted mode June used for it. Lets a
          // developer tell a June adapter/UI bug apart from a Hermes one.
          onOpenTuiDebug={
            hermesTuiDebugAvailable() &&
            !newSessionMode &&
            selectedHermesSessionId &&
            !selectedHermesSessionIsProvisional
              ? () => {
                  setError(null);
                  void openHermesTuiDebug({
                    sessionId: selectedHermesSessionId,
                    unrestricted: sessionUnrestricted(selectedHermesSessionId),
                  }).catch((err: unknown) => setError(messageFromError(err)));
                }
              : undefined
          }
        />
      ) : null}
      {heroMode ? (
        <section
          className="agent-main"
          aria-label="Agent task details"
          data-hero="true"
          data-hero-leaving={heroLeaving ? "true" : undefined}
        >
          {visibleError ? (
            <AgentErrorBanner
              message={visibleError}
              onRetry={visibleErrorRetryable ? () => void retryGatewayConnection() : undefined}
              onReportBug={
                visibleErrorState?.issueReport
                  ? () => void sendErrorIssueReport(visibleErrorState)
                  : undefined
              }
              reportBugSubmitting={submittingErrorIssueReport}
              onDismiss={() => setError(null)}
            />
          ) : null}
          <div className="agent-hero-heading">
            <h2 className="agent-hero-title">{heroGreeting}</h2>
          </div>
          {composer}
          {activePanel === "chat" ? (
            <div className="agent-hero-suggestions">
              {/* The chips bow out while the composer holds a draft: staging a
                  chip runs setContent, which replaces the whole composer
                  document, so a click here would clobber what the person
                  typed. Once they're typing, the suggestions have done their
                  job. They return when the field is cleared. */}
              <div
                className="agent-hero-chips"
                data-phase={heroChipPhase}
                data-hidden={draft.trim() ? "true" : undefined}
                onMouseEnter={() => {
                  heroChipsHoverRef.current = true;
                }}
                onMouseLeave={() => {
                  heroChipsHoverRef.current = false;
                }}
              >
                {heroShortcuts.map((shortcut, index) => (
                  <button
                    key={shortcut.key}
                    type="button"
                    className="agent-hero-chip"
                    style={{ "--chip-i": index } as CSSProperties}
                    title={shortcut.description}
                    disabled={submitting}
                    onClick={() => runShortcut(shortcut)}
                  >
                    <span className="agent-hero-chip-icon" aria-hidden>
                      {shortcut.icon}
                    </span>
                    {shortcut.title}
                  </button>
                ))}
              </div>
              <p className="agent-hero-footnote">
                {bridgeStarting || startupSessionHydrationPending
                  ? "Getting June ready…"
                  : heroPrivacyFootnote(generationModel, generationPrivacyBadge)}
              </p>
            </div>
          ) : null}
        </section>
      ) : (
        <>
          <div
            ref={agentScrollRef}
            className="agent-scroll"
            style={
              {
                "--agent-composer-clearance": `${composerClearance}px`,
              } as CSSProperties
            }
          >
            <section className="agent-main" aria-label="Agent task details">
              {galleryErrors ? (
                <AgentErrorBanner
                  message="Could not connect to Hermes gateway."
                  onRetry={galleryNoop}
                  onDismiss={galleryNoop}
                />
              ) : visibleError ? (
                <AgentErrorBanner
                  message={visibleError}
                  onRetry={visibleErrorRetryable ? () => void retryGatewayConnection() : undefined}
                  onReportBug={
                    visibleErrorState?.issueReport
                      ? () => void sendErrorIssueReport(visibleErrorState)
                      : undefined
                  }
                  reportBugSubmitting={submittingErrorIssueReport}
                  onDismiss={() => setError(null)}
                />
              ) : null}
              {detailContent}
              {composer}
            </section>
          </div>
          {/* Portaled out of .main-panel: WKWebView clips a composited fixed
              element to an overflow-hidden ancestor, and the panel sits
              entirely outside the card's box — so whenever the engine
              transiently promoted its layer (animation replays, drag-time
              renderer churn), the panel blinked out. As a direct child of
              .app-shell nothing excludes its box, and the shell still carries
              the CSS variables and data-attributes its rules read. */}
          {artifactPanel
            ? createPortal(
                <AgentArtifactPanel
                  artifacts={surfacedArtifacts}
                  state={artifactPanel}
                  onShowList={() => setArtifactPanel({ view: "list" })}
                  onOpen={openArtifact}
                  onDownload={downloadArtifact}
                  onClose={() => setArtifactPanel(null)}
                />,
                document.querySelector(".app-shell") ?? document.body,
              )
            : null}
          {usageDemo || usagePanelSessionId
            ? createPortal(
                <div
                  className="agent-usage-overlay"
                  role="presentation"
                  onClick={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (usageDemo) {
                      // Closing while demoing clears the demo state, matching
                      // __usageDemo("off"). Guard: the command is dev-only.
                      (window as unknown as { __usageDemo?: (v: "off") => void }).__usageDemo?.(
                        "off",
                      );
                    }
                    setUsagePanelSessionId(null);
                  }}
                >
                  <SessionUsagePanel
                    // A stable id so the panel refetches when the fixture swaps.
                    sessionId={usageDemo ? usageDemo.usage.sessionId : (usagePanelSessionId ?? "")}
                    fetchUsage={
                      usageDemo
                        ? // Small artificial delay so the skeleton and the eased
                          // dot-fill entrance are both visible on each swap.
                          () =>
                            new Promise((resolve) =>
                              setTimeout(() => resolve(usageDemo.usage), 250),
                            )
                        : fetchSessionUsage
                    }
                    onClose={() => {
                      if (usageDemo) {
                        (window as unknown as { __usageDemo?: (v: "off") => void }).__usageDemo?.(
                          "off",
                        );
                      }
                      setUsagePanelSessionId(null);
                    }}
                    resolveModel={
                      usageDemo
                        ? (id) => (id === usageDemo.model.id ? usageDemo.model : undefined)
                        : resolveModel
                    }
                  />
                </div>,
                document.querySelector(".app-shell") ?? document.body,
              )
            : null}
          {/* Dialog portals to document.body itself, so it is mounted directly
              rather than wrapped in an overlay like the usage panel. */}
          {compactSessionId ? (
            <SessionCompactDialog
              open
              sessionId={compactSessionId}
              compress={compressSessionContext}
              onClose={() => setCompactSessionId(null)}
            />
          ) : null}
          {!newSessionMode && selectedHermesSessionId && !selectedHermesSessionIsProvisional ? (
            <ShareDialog
              key={selectedHermesSessionId}
              open={shareSessionId === selectedHermesSessionId}
              onClose={() => setShareSessionId(null)}
              onLinkChange={setSessionShareUrl}
              item={{
                kind: "session",
                itemId: selectedHermesSessionId,
                title: selectedHermesSession?.title ?? "",
                // Sessions share the visible user/assistant transcript only:
                // tool events, reasoning, and hidden context never enter the
                // payload. Snapshot at share time.
                buildPayload: () =>
                  buildSessionPayload({
                    title: selectedHermesSession?.title ?? "",
                    messages: hermesTurns
                      .filter((turn) => turn.role === "user" || turn.role === "assistant")
                      .map((turn) => ({
                        role: turn.role as "user" | "assistant",
                        content: copyableTextForTurn(turn),
                      }))
                      .filter((message) => message.content.length > 0),
                  }),
              }}
            />
          ) : null}
        </>
      )}
      {imageSafeModeConsentRequest ? (
        imageSafeModeConsentRequest.variant === "video-slash" ? (
          <VideoSafeModeConsentDialog
            onSkipVideo={(dontAskAgain) =>
              resolveImageSafeModeConsent({ action: "keep", dontAskAgain })
            }
            onTurnOffSafeMode={(dontAskAgain) =>
              resolveImageSafeModeConsent({ action: "turnOff", dontAskAgain })
            }
            onDismiss={() => resolveImageSafeModeConsent({ action: "dismiss" })}
          />
        ) : (
          <ImageSafeModeConsentDialog
            variant={imageSafeModeConsentRequest.variant}
            onKeepSafeMode={(dontAskAgain) =>
              resolveImageSafeModeConsent({ action: "keep", dontAskAgain })
            }
            onTurnOffSafeMode={(dontAskAgain) =>
              resolveImageSafeModeConsent({ action: "turnOff", dontAskAgain })
            }
            onDismiss={() => resolveImageSafeModeConsent({ action: "dismiss" })}
          />
        )
      ) : null}
    </section>
  );
}
import {
  AGENT_TITLE_MAX_CHARS,
  agentSessionTitleForPrompt,
  isReplaceableAgentSessionTitle,
  truncateAgentTitleResponseExcerpt,
} from "./session-title";

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
  AgentResponseGallery,
  AgentScrollToLatestButton,
  agentComposerClearance,
  chatTurnsSignature,
  galleryNoop,
  isAgentTranscriptNearBottom,
  mergeThinkingTurns,
} from "./chat-turns/TranscriptViews";
export {
  AgentScrollToLatestButton,
  agentComposerClearance,
} from "./chat-turns/TranscriptViews";
import { AgentChatTurnRow, copyableTextForTurn } from "./chat-turns/AgentChatTurnRow";
/**
 * Confirmation + result dialog for session context compaction (feature 08).
 *
 * Decoupled from the gateway like {@link SessionUsagePanel}: it takes a
 * `compress(sessionId)` that already calls the typed `session.compress` wrapper
 * and returns a normalized {@link CompressSessionResult}. That keeps the dialog
 * trivially testable and lets AgentWorkspace own the gateway plumbing.
 *
 * The flow is three honest phases:
 * - `idle`: explain what compaction does. The copy never claims the original
 *   transcript is kept verbatim; it warns "Older messages may be summarized."
 * - `working`: the compress call is in flight; the action shows a busy label.
 * - `done` / `error`: on success, a "Context compacted" item (plus token
 *   savings when the result reports before/after). On failure, a clear message
 *   — and a busy-specific one when Hermes rejects mid-run with 4009 — with a
 *   "Try again". Nothing crashes and no savings are invented.
 */
import { AgentErrorBanner, SessionCompactDialog } from "./chat-turns/SessionNotices";
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
import {
  isLiveAssistantTurnId,
  liveAssistantBranchPointIndex,
  previousBranchableMessageIndex,
} from "./chat-turns/BranchAndSensitiveActions";
export {
  BranchFromHereAction,
  SecretPart,
  SudoPart,
  branchSourceSessionIdForTurn,
  turnIsConcreteResponse,
} from "./chat-turns/BranchAndSensitiveActions";
import {
  AgentArtifactPanel,
  type AgentArtifact,
  type AgentArtifactPanelState,
} from "./chat-turns/AgentArtifactPanel";
import {
  artifactsFromFilesystemSnapshot,
  assignArtifactsToTurns,
  composerInputSignatureFor,
  formatComposerTokenCount,
  oversizedComposerInputWarning,
  promptWithAttachments,
  surfacedArtifactsFromTurns,
  unsupportedImageInputPrompt,
  type ComposerInputSizeWarning,
} from "./composer/composer-input-helpers";
export { generatedImagePathAliases } from "./composer/composer-input-helpers";
import {
  agentActivityCountsFromStore,
  agentStatusFromHermesEvent,
  agentStatusSummaryFromHermesEvent,
  mergeActiveHermesSessions,
  projectAgentActivityLevels,
  retainUnpersistedPendingMessages,
  sessionHasAssistantAfterLatestUser,
  sessionHasActiveWork,
  shouldResumeSessionActivity,
  visibleHermesMessageText,
  type AgentActivityLevelProjection,
} from "./session-state-helpers";
export {
  projectAgentActivityLevels,
  type AgentActivityLevelProjection,
} from "./session-state-helpers";
import {
  ActivityIndicator,
  AgentAttachmentTile,
  DownloadToastMessage,
  commandTokensForResolutions,
  ensureDownloadFileExtension,
  isResolvedSkillSlashResolution,
  moveRecordKey,
  omitRecordKey,
  readFileBytes,
  sameAgentAttachments,
} from "./agent-workspace-support";
import {
  AUTO_SUBMIT_ECHO_WINDOW_MS,
  clearPendingNewSessionRequest,
  forgetLastOpenSessionId,
  pendingNewSessionRequest,
  readLastOpenSessionId,
  writeLastOpenSessionId,
  type AgentNewSessionDetail,
} from "./session-persistence";
export {
  markAgentNewSessionPending,
  pendingNewSessionRequest,
  type AgentNewSessionDetail,
} from "./session-persistence";
